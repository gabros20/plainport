// restic's JSON output, as Zod schemas (DESIGN.md "Schemas at the edges"): the JSON lines of `--json` commands
// (restic scripting docs, https://restic.readthedocs.io/en/stable/075_scripting.html), the array `snapshots --json`
// prints, and the tree object `cat tree` prints. Unknown fields are dropped, so a newer restic that adds some still
// parses; a missing or mistyped field we rely on is restic.output-invalid. Recorded fixtures per restic version
// (fixtures/restic/<version>/) pin what each version prints.

import { fail, finding, ok, type Result } from "@plainport/contract";
import type { EntryMeta, EntryType, SnapshotInfo } from "@plainport/core";
import { z } from "zod";

const count = z.number().int().nonnegative();
const fileMode = z.number().int().nonnegative();

export const VersionLine = z.object({ message_type: z.literal("version"), version: z.string() });
export const InitializedLine = z.object({ message_type: z.literal("initialized"), id: z.string() });
/** backup and restore both print status lines; each fills its own counters. */
export const StatusLine = z.object({
  message_type: z.literal("status"),
  seconds_remaining: count.optional(),
  total_bytes: count.optional(),
  bytes_done: count.optional(),
  bytes_restored: count.optional(),
});
/** backup, restore and check each print one summary line with their own fields. */
export const SummaryLine = z.object({
  message_type: z.literal("summary"),
  // backup
  snapshot_id: z.string().optional(),
  files_new: count.optional(),
  files_changed: count.optional(),
  files_unmodified: count.optional(),
  dirs_new: count.optional(),
  dirs_changed: count.optional(),
  dirs_unmodified: count.optional(),
  data_added: count.optional(),
  total_files_processed: count.optional(),
  total_bytes_processed: count.optional(),
  // restore
  total_files: count.optional(),
  files_restored: count.optional(),
  files_skipped: count.optional(),
  files_deleted: count.optional(),
  total_bytes: count.optional(),
  bytes_restored: count.optional(),
  bytes_skipped: count.optional(),
  // check
  num_errors: count.optional(),
});
/** backup and restore name the item and nest the message; check prints the message alone. */
export const ErrorLine = z.object({
  message_type: z.literal("error"),
  message: z.string().optional(),
  error: z.object({ message: z.string() }).optional(),
  during: z.string().optional(),
  item: z.string().optional(),
});
export const ExitErrorLine = z.object({
  message_type: z.literal("exit_error"),
  code: z.number().int(),
  message: z.string(),
});
export const VerboseStatusLine = z.object({ message_type: z.literal("verbose_status") });

const ENTRY_TYPES = ["file", "dir", "symlink", "dev", "chardev", "fifo", "socket", "irregular"] as const;
export const NodeLine = z.object({
  message_type: z.literal("node"),
  type: z.enum(ENTRY_TYPES),
  path: z.string().startsWith("/"),
  size: count.optional(),
  mode: fileMode,
  mtime: z.string(),
});

export const SnapshotObject = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  time: z.string(),
  hostname: z.string(),
  paths: z.array(z.string()),
  tags: z.array(z.string()).nullish(),
  parent: z.string().nullish(),
});
/** The first line of `ls --json`: the snapshot being listed. */
export const SnapshotLine = SnapshotObject.extend({ message_type: z.literal("snapshot") });

export const ResticLine = z.discriminatedUnion("message_type", [
  VersionLine,
  InitializedLine,
  StatusLine,
  SummaryLine,
  ErrorLine,
  ExitErrorLine,
  VerboseStatusLine,
  NodeLine,
  SnapshotLine,
]);
export type ResticLine = z.infer<typeof ResticLine>;

export const TreeObject = z.object({
  nodes: z.array(z.object({ name: z.string(), type: z.string(), linktarget: z.string().optional() })),
});

const invalid = (what: string, detail: string) =>
  fail(
    finding("restic.output-invalid", {
      message: `restic's ${what} is not what restic prints: ${detail}`,
      fix: "re-run the command; if it fails again, report it with the output of `restic version`",
    }),
  );

const parseJson = <S extends z.ZodType>(schema: S, text: string, what: string): Result<z.output<S>> => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return invalid(what, `not JSON: ${text.slice(0, 200)}`);
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? ok(parsed.data) : invalid(what, z.prettifyError(parsed.error).slice(0, 500));
};

/** One JSON line of a `--json` command. */
export const parseLine = (text: string): Result<ResticLine> => parseJson(ResticLine, text, "JSON line");

/** Bits of Go's os.FileMode, which restic stores. */
const GO_SETUID = 1 << 23;
const GO_SETGID = 1 << 22;
const GO_STICKY = 1 << 20;

/** Go's FileMode as POSIX permission bits, setuid, setgid and sticky included. */
export const posixMode = (goMode: number): number =>
  (goMode & 0o777) |
  (goMode & GO_SETUID ? 0o4000 : 0) |
  (goMode & GO_SETGID ? 0o2000 : 0) |
  (goMode & GO_STICKY ? 0o1000 : 0);

export const snapshotInfo = (snapshot: z.infer<typeof SnapshotObject>): SnapshotInfo => ({
  id: snapshot.id,
  time: snapshot.time,
  hostname: snapshot.hostname,
  paths: snapshot.paths,
  tags: snapshot.tags ?? [],
  ...(snapshot.parent ? { parent: snapshot.parent } : {}),
});

/** `snapshots --json`: one JSON array. */
export const parseSnapshots = (text: string): Result<SnapshotInfo[]> => {
  const parsed = parseJson(z.array(SnapshotObject), text, "snapshot list");
  return parsed.ok ? ok(parsed.value.map(snapshotInfo)) : parsed;
};

/** `ls --json <id>`: the snapshot line, then one node line per entry. */
export const parseListing = (text: string): Result<{ snapshot: SnapshotInfo; entries: EntryMeta[] }> => {
  let snapshot: SnapshotInfo | undefined;
  const entries: EntryMeta[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "") continue;
    const line = parseLine(raw);
    if (!line.ok) return line;
    const value = line.value;
    if (value.message_type === "snapshot" && snapshot === undefined) snapshot = snapshotInfo(value);
    else if (value.message_type === "node" && snapshot !== undefined) {
      entries.push({
        path: value.path.slice(1),
        type: value.type satisfies EntryType,
        ...(value.type === "file" ? { size: value.size ?? 0 } : {}),
        mode: posixMode(value.mode),
        mtime: value.mtime,
      });
    } else return invalid("listing", `unexpected ${value.message_type} line`);
  }
  return snapshot === undefined ? invalid("listing", "no snapshot line") : ok({ snapshot, entries });
};

/** `cat tree <id>:<dir>`: the folder's entries; here only names and symlink targets are needed. */
export const parseTree = (text: string): Result<z.infer<typeof TreeObject>> =>
  parseJson(TreeObject, text, "tree");
