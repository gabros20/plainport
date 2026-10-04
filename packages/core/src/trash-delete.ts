// The detached trash delete's own process (D47, D64, D67, D87): `plainport __delete-trash <payload>`, started by
// HostPorts.deleteTrashDetached and never waited for. It claims the trash as its own first (trash-claim.ts, so no other
// deleter takes it while it runs), then runs the delete guard right before it deletes (delete-guard.ts: no mount, no
// store, no registered project, a clean configuration), and only then removes the trash, its claim, the offload's
// journal and the holder when that leaves it empty. A refusal removes only the claim: the trash and the journal stay,
// and the next gc, housekeeping or recover runs the guard again and reports delete.guard-refused.
//
// The internal word is dispatched by the CLI's entry point before the registry, so it is in no help, completion or
// plainport.json: it is not a command a person or an agent runs.

import { dirname } from "node:path";
import { z } from "zod";
import { deleteGuard } from "./delete-guard.ts";
import { removeEmptyHolder } from "./holder.ts";
import { errorCode, type LocalIo } from "./io.ts";
import type { Env, PlainportPaths } from "./paths.ts";
import { trashClaimFile } from "./trash-claim.ts";

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
});
export type TrashDeletePayload = z.infer<typeof TrashDeletePayloadSchema>;

export const trashDeletePayload = (
  trash: string,
  journal: string,
  device: string,
  paths: PlainportPaths,
  env: Env,
): string => {
  const kept: Record<string, string> = {};
  for (const name of ["HOME", "PLAINPORT_STORE"])
    if (env[name] !== undefined) kept[name] = env[name] as string;
  return JSON.stringify({ trash, journal, device, paths, env: kept });
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
export const runTrashDelete = async (io: LocalIo, payloadText: string | undefined): Promise<number> => {
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
  // The claim first, written by this process with its own pid: until it is there nothing tells another deleter.
  const text = `${JSON.stringify({
    v: 1,
    device,
    pid: io.proc.pid,
    bootedAt: io.proc.bootedAtMs(),
    startedAt: new Date().toISOString(),
  })}\n`;
  try {
    await io.fs.writeTextDurable(`${claim}.tmp`, text);
    await io.fs.rename(`${claim}.tmp`, claim);
  } catch {
    return TRASH_DELETE_EXIT.failed;
  }
  const guarded = await deleteGuard({ io, paths, env: payload.env }, trash);
  if (!guarded.ok) {
    await unlinkIfThere(io, claim);
    return TRASH_DELETE_EXIT.refused;
  }
  try {
    await io.fs.removeTree(trash);
  } catch {
    return TRASH_DELETE_EXIT.failed;
  }
  // Trash, then claim, then journal (D67): a crash between them never leaves a claim no journal leads to.
  if (!(await unlinkIfThere(io, claim))) return TRASH_DELETE_EXIT.failed;
  if (!(await unlinkIfThere(io, journal))) return TRASH_DELETE_EXIT.failed;
  await removeEmptyHolder(io, dirname(trash), ".plainport-trash");
  return TRASH_DELETE_EXIT.done;
};
