// The detached trash delete's own process (D47, D64, D67, D87): `plainport __delete-trash <payload>`, started by
// HostPorts.deleteTrashDetached and never waited for. It claims the trash as its own first (trash-claim.ts, so no other
// deleter takes it while it runs: its `.claim.boot`, then the claim), then runs the delete guard right before it
// deletes (delete-guard.ts: no mount, no store, no registered project, a clean configuration), and only then removes
// the trash, its claim and `.claim.boot`, the offload's journal and the holder when that leaves it empty. A refusal
// removes only the claim files: the trash and the journal stay, and the next gc, housekeeping or recover runs the
// guard again and reports delete.guard-refused.
//
// The internal word is dispatched by the CLI's entry point before the registry, so it is in no help, completion or
// plainport.json: it is not a command a person or an agent runs.

import { dirname } from "node:path";
import { z } from "zod";
import { writeAtomic } from "./atomic.ts";
import { deleteGuard } from "./delete-guard.ts";
import { removeEmptyHolder } from "./holder.ts";
import { errorCode, type LocalIo } from "./io.ts";
import { JournalSchema } from "./journal/index.ts";
import type { Env, PlainportPaths } from "./paths.ts";
import type { HostPorts } from "./ports/host.ts";
import { noteRefusal, trashClaimBootFile, trashClaimFile, trashRefusedFile } from "./trash-claim.ts";

/** The argv word the detached child runs under. */
export const TRASH_DELETE_WORD = "__delete-trash";

/** The child's exit codes: the parent tells a guard refusal from a failure to claim. */
export const TRASH_DELETE_EXIT = { done: 0, failed: 1, refused: 3 } as const;

const TRASH = /\/\.plainport-trash\/[0-9A-HJKMNP-TV-Z]{26}$/;
const JOURNAL = /\/journal\/[0-9A-HJKMNP-TV-Z]{26}\.json$/;

const Abs = z.string().startsWith("/");
export const TrashDeletePayloadSchema = z.strictObject({
  trash: Abs.regex(TRASH),
  journal: Abs.regex(JOURNAL),
  device: z.string().min(1),
  /** The parent's paths, so the child reads the same registry and configuration whatever --config said. */
  paths: z.looseObject({ home: Abs, configFile: Abs, stateDir: Abs }),
  /** What the guard's configuration read and root listing need: HOME at least. */
  env: z.record(z.string(), z.string()),
  /**
   * The deadline housekeeping took off the journal before starting this delete: put back on a refusal, so the trash
   * is renamed back by an onload again, as it was before (r3 #5).
   */
  keepUntil: z.iso.datetime().optional(),
});
export type TrashDeletePayload = z.infer<typeof TrashDeletePayloadSchema>;

export const trashDeletePayload = (
  trash: string,
  journal: string,
  device: string,
  paths: PlainportPaths,
  env: Env,
  keepUntil?: string,
): string => {
  const kept: Record<string, string> = {};
  for (const name of ["HOME", "PLAINPORT_STORE"])
    if (env[name] !== undefined) kept[name] = env[name] as string;
  return JSON.stringify({
    trash,
    journal,
    device,
    paths,
    env: kept,
    ...(keepUntil === undefined ? {} : { keepUntil }),
  });
};

/** Puts the deadline back on the released journal (r3 #5); the claim still stands, so nobody else writes it now. */
const restoreDeadline = async (io: LocalIo, journalPath: string, keepUntil: string): Promise<void> => {
  try {
    const parsed = JournalSchema.safeParse(JSON.parse(await io.fs.readText(journalPath)));
    if (!parsed.success || parsed.data.kind !== "offload" || parsed.data.keepUntil !== undefined) return;
    await writeAtomic(io, journalPath, `${JSON.stringify({ ...parsed.data, keepUntil }, null, 2)}\n`);
  } catch {
    // Without its deadline the trash waits for gc, which runs the guard again: nothing is lost.
  }
};

const unlinkIfThere = async (io: LocalIo, path: string): Promise<boolean> => {
  try {
    await io.fs.unlink(path);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
};

/** Runs the detached delete in this process and returns its exit code (TRASH_DELETE_EXIT); never throws for I/O. */
export const runTrashDelete = async (
  io: LocalIo & Pick<HostPorts, "bootSession">,
  payloadText: string | undefined,
): Promise<number> => {
  let payload: TrashDeletePayload;
  try {
    const parsed = TrashDeletePayloadSchema.safeParse(JSON.parse(payloadText ?? ""));
    if (!parsed.success) return TRASH_DELETE_EXIT.failed;
    payload = parsed.data;
  } catch {
    return TRASH_DELETE_EXIT.failed;
  }
  const { trash, journal, device } = payload;
  const paths = payload.paths as unknown as PlainportPaths;
  const claim = trashClaimFile(trash);
  const boot = trashClaimBootFile(trash);
  const pid = io.proc.pid;
  const startedAt = new Date().toISOString();
  // The boot session first (Q5 i), naming the claim it belongs to, so the claim is never there without it. Without a
  // session, or when it cannot be written, readers judge the claim by M1's boot-time rule: nothing more is lost.
  const session = await io.bootSession();
  if (session !== undefined) {
    try {
      await io.fs.writeTextDurable(boot, `${JSON.stringify({ v: 1, pid, startedAt, session })}\n`);
    } catch {
      await unlinkIfThere(io, boot);
    }
  }
  // The claim, written by this process with its own pid: until it is there nothing tells another deleter.
  const text = `${JSON.stringify({ v: 1, device, pid, bootedAt: io.proc.bootedAtMs(), startedAt })}\n`;
  try {
    await io.fs.writeTextDurable(`${claim}.tmp`, text);
    await io.fs.rename(`${claim}.tmp`, claim);
  } catch {
    return TRASH_DELETE_EXIT.failed;
  }
  const guarded = await deleteGuard({ io, paths, env: payload.env }, trash);
  if (!guarded.ok) {
    // Nobody waits for this process: the note tells housekeeping, gc and status why the trash stays (r3 #4), and the
    // journal gets back the deadline housekeeping took off (r3 #5), both before the claim goes.
    await noteRefusal(io, trash, guarded.finding);
    if (payload.keepUntil !== undefined) await restoreDeadline(io, journal, payload.keepUntil);
    await unlinkIfThere(io, claim);
    await unlinkIfThere(io, boot);
    return TRASH_DELETE_EXIT.refused;
  }
  try {
    await io.fs.removeTree(trash);
  } catch {
    return TRASH_DELETE_EXIT.failed;
  }
  // Trash, then claim, then journal (D67): a crash between them never leaves a claim no journal leads to.
  if (!(await unlinkIfThere(io, claim))) return TRASH_DELETE_EXIT.failed;
  await unlinkIfThere(io, boot);
  await unlinkIfThere(io, trashRefusedFile(trash));
  if (!(await unlinkIfThere(io, journal))) return TRASH_DELETE_EXIT.failed;
  await removeEmptyHolder(io, dirname(trash), ".plainport-trash");
  return TRASH_DELETE_EXIT.done;
};
