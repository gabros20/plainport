// restic's JSON output, as Zod schemas (DESIGN.md "Schemas at the edges"): the JSON lines of `--json` commands
// (restic scripting docs, https://restic.readthedocs.io/en/stable/075_scripting.html), the array `snapshots --json`
// prints, and the tree object `cat tree` prints. Unknown fields are dropped, so a newer restic that adds some still
// parses; a missing or mistyped field we rely on is restic.output-invalid. Recorded fixtures per restic version
// (fixtures/restic/<version>/) pin what each version prints.

import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
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

/**
 * Tag values as stored in restic (run decision D26, extended in fix r1): restic changes a tag in two ways, so the
 * codec percent-encodes (as UTF-8 bytes, upper-case hex) exactly what it would change:
 * - it splits a --tag value at commas: "," is %2C anywhere, and "%" is %25 to keep that reversible;
 * - it trims whitespace (Go's unicode.IsSpace) from both ends: whitespace at the start or end is encoded;
 * - control characters are encoded anywhere, so no tag carries a newline or a tab into restic's output.
 * Whitespace inside a tag is kept as it is. Reading decodes a percent sequence only when it stands for a character
 * the codec encodes (a comma, a percent sign, whitespace or a control character), so a tag another tool wrote keeps
 * any other percent sequence as it is.
 */
// JavaScript's \s plus U+0085, which Go's unicode.IsSpace also counts.
const SPACE = /[\s\u0085]/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ENCODED_BY_CODEC = (char: string): boolean =>
  char === "%" || char === "," || SPACE.test(char) || CONTROL.test(char);

const percent = (char: string): string =>
  [...new TextEncoder().encode(char)]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");

export const encodeTag = (tag: string): string => {
  const chars = [...tag];
  let start = 0;
  while (start < chars.length && SPACE.test(chars[start] as string)) start++;
  let end = chars.length;
  while (end > start && SPACE.test(chars[end - 1] as string)) end--;
  return chars
    .map((char, at) =>
      char === "%" || char === "," || CONTROL.test(char) || at < start || at >= end ? percent(char) : char,
    )
    .join("");
};

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export const decodeTag = (tag: string): string =>
  tag.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let at = 0; at < bytes.length; at++)
      bytes[at] = Number.parseInt(run.slice(at * 3 + 1, at * 3 + 3), 16);
    let text: string;
    try {
      text = strictUtf8.decode(bytes);
    } catch {
      return run;
    }
    // Each character comes back only if the codec would have encoded it; any other keeps its own sequence.
    let out = "";
    let at = 0;
    for (const char of text) {
      const length = new TextEncoder().encode(char).length * 3;
      out += ENCODED_BY_CODEC(char) ? char : run.slice(at, at + length);
      at += length;
    }
    return out;
  });

export const snapshotInfo = (snapshot: z.infer<typeof SnapshotObject>): SnapshotInfo => ({
  id: snapshot.id,
  time: snapshot.time,
  hostname: snapshot.hostname,
  paths: snapshot.paths,
  tags: (snapshot.tags ?? []).map(decodeTag),
  ...(snapshot.parent ? { parent: snapshot.parent } : {}),
});

/** `snapshots --json`: one JSON array. */
export const parseSnapshots = (text: string): Result<SnapshotInfo[]> => {
  const parsed = parseJson(z.array(SnapshotObject), text, "snapshot list");
  return parsed.ok ? ok(parsed.value.map(snapshotInfo)) : parsed;
};

/**
 * `ls --json <id>`, read line by line: the snapshot line, then one node line per entry. Each call takes one line;
 * entries go to onEntry as they come. The first problem is kept and every later line is ignored.
 */
export class ListingReader {
  snapshot: SnapshotInfo | undefined;
  problem: Failure | undefined;

  constructor(private readonly onEntry: (entry: EntryMeta) => void) {}

  line(raw: string): void {
    if (this.problem !== undefined || raw === "") return;
    const line = parseLine(raw);
    if (!line.ok) {
      this.problem = line;
      return;
    }
    const value = line.value;
    if (value.message_type === "snapshot" && this.snapshot === undefined) this.snapshot = snapshotInfo(value);
    else if (value.message_type === "node" && this.snapshot !== undefined)
      this.onEntry({
        path: value.path.slice(1),
        type: value.type satisfies EntryType,
        ...(value.type === "file" ? { size: value.size ?? 0 } : {}),
        mode: posixMode(value.mode),
        mtime: value.mtime,
      });
    else this.problem = invalid("listing", `unexpected ${value.message_type} line`);
  }

  /** The snapshot, once the listing ended; a failure if a line was wrong or the snapshot line never came. */
  end(): Result<SnapshotInfo> {
    if (this.problem !== undefined) return this.problem;
    return this.snapshot === undefined ? invalid("listing", "no snapshot line") : ok(this.snapshot);
  }
}

/**
 * One entry line of `ls -l <id>` (restic's formatNode): Go's FileMode string, uid, gid, size, local time, then the
 * path, and for a symlink " -> " and its target. Path and target are printed as they are, so either may hold
 * " -> " or a newline: a record runs until the next line that starts like an entry line. Go writes "-" for the
 * type when no type bit is set (a plain file).
 */
const LONG_ENTRY =
  /^([dalTLDpSugct?]+|-)[-r][-w][-x][-r][-w][-x][-r][-w][-x] +\d+ +\d+ +\d+ \d{4}-\d\d-\d\d \d\d:\d\d:\d\d (\/.*)$/s;

/**
 * Reads `ls -l <id>` line by line and finds the targets of the wanted symlinks (paths with their leading "/").
 * Every way a symlink record can split at " -> " that names a wanted path is a candidate; a path given two
 * different targets is ambiguous, and ambiguous or missing paths are left for another way (cat tree).
 */
export class LongListingReader {
  private record: string | undefined;
  private readonly found = new Map<string, string | null>();

  constructor(private readonly wanted: ReadonlySet<string>) {}

  line(raw: string): void {
    if (LONG_ENTRY.test(raw)) {
      this.flush();
      this.record = raw;
    } else if (this.record !== undefined) this.record += `\n${raw}`;
  }

  /** The target of each wanted symlink that one record placed without doubt. */
  end(): Map<string, string> {
    this.flush();
    const targets = new Map<string, string>();
    for (const [path, target] of this.found) if (target !== null) targets.set(path, target);
    return targets;
  }

  private flush(): void {
    const record = this.record;
    this.record = undefined;
    const match = record === undefined ? null : LONG_ENTRY.exec(record);
    if (match === null || !(match[1] ?? "").includes("L")) return;
    const rest = match[2] ?? "";
    for (let at = rest.indexOf(" -> "); at !== -1; at = rest.indexOf(" -> ", at + 1)) {
      const path = rest.slice(0, at);
      if (!this.wanted.has(path)) continue;
      const target = rest.slice(at + 4);
      const known = this.found.get(path);
      this.found.set(path, known === undefined || known === target ? target : null);
    }
  }
}

/** `cat tree <id>:<dir>`: the folder's entries; here only names and symlink targets are needed. */
export const parseTree = (text: string): Result<z.infer<typeof TreeObject>> =>
  parseJson(TreeObject, text, "tree");
