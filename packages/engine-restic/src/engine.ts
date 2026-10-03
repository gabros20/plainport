// The Engine port over the pinned restic binary (ADR-0006; DESIGN.md "Plugin interfaces → Engine", "Offload
// process" step 6). Every restic run goes through the host's one process runner (AGENTS.md rule 6): commands whose
// stdout is data (version, init, snapshots, ls, cat) run in capture mode, so a listing is parsed whole or not at
// all; backup, restore and check stream their JSON lines through onLine, which turns status lines into progress
// events. restic's exit codes map to catalogued findings: 3 (unreadable files) fails the snapshot outright, never a
// partial success.
//
// The password reaches restic only as RESTIC_PASSWORD in the child's environment, never as an argument; it is cut
// out of every message, log line and report the engine passes on. Before its first command, the engine checks that
// the restic it was given is the version tools.lock.json pins.

import { isAbsolute, normalize } from "node:path";
import { decode, type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import {
  type CheckReport,
  capturedOutput,
  type Engine,
  type EntryMeta,
  type HostPorts,
  type RestoreStats,
  type RunContext,
  type RunOutcome,
  type RunSpec,
  type SnapshotStats,
} from "@plainport/core";
import { z } from "zod";
import lock from "../../../tools.lock.json" with { type: "json" };
import {
  encodeTag,
  ListingReader,
  LongListingReader,
  parseLine,
  parseSnapshots,
  parseTree,
  type ResticLine,
} from "./parse.ts";

/** The restic version this plainport bundles and is tested with. */
export const PINNED_RESTIC = lock.tools.restic.version;

export interface ResticEngineOptions {
  host: Pick<HostPorts, "run">;
  /** The restic binary: toolPath(io, "restic") in the composition root. */
  restic: string;
  /** The repository: a path, or a restic backend URL (rclone:…, s3:…). */
  repository: string;
  /** The repository password. M1 takes the value; the Keychain provider arrives in M2. */
  password: string;
  /** The child's environment (HOME, PATH, TMPDIR, …). RESTIC_ variables in it are dropped, so an inherited
   * RESTIC_PASSWORD_FILE or RESTIC_REPOSITORY can never point restic elsewhere. */
  env: Readonly<Record<string, string>>;
  /** restic's cache folder; restic's default (under HOME) when absent. */
  cacheDir?: string;
  /** How long restic retries a locked repository before exiting 11 (DESIGN.md "Edge cases"). Default 1m; null
   * fails at once. */
  retryLock?: string | null;
  /** Default: PINNED_RESTIC. */
  expectedVersion?: string;
  /** Status lines per second while backup and restore run. Default 1. */
  progressFps?: number;
  /** The most stdout a listing may print before it fails as process.output-too-large. Default 1 GiB. */
  captureLimitBytes?: number;
  /** No output for this long stops restic (process.idle-timeout). Default: the runner's. */
  idleTimeoutMs?: number;
}

const SNAPSHOT_ID = z.string().regex(/^[0-9a-f]{64}$/, "a full 64-character restic snapshot id");
const ABSOLUTE = z
  .string()
  .refine((path) => isAbsolute(path) && normalize(path) === path && (path === "/" || !path.endsWith("/")), {
    message: "an absolute, normalized path",
  });
const RELATIVE = z
  .string()
  .refine(
    (path) =>
      path !== "" &&
      !isAbsolute(path) &&
      normalize(path) === path &&
      !path.endsWith("/") &&
      !path.split("/").includes(".."),
    { message: "a normalized path inside the folder" },
  );
// Any non-empty tag: commas and percent signs are encoded on the way to restic (encodeTag, run decision D26).
const TAG = z.string().min(1, "a non-empty tag");

const SnapshotInputSchema = z.object({
  dir: ABSOLUTE,
  excludes: z.array(RELATIVE),
  parent: SNAPSHOT_ID.optional(),
  tags: z.array(TAG),
});
const RestoreSchema = z.object({
  snapshot: SNAPSHOT_ID,
  target: ABSOLUTE,
  overwrite: z.enum(["always", "if-changed", "if-newer", "never"]).optional(),
  delete: z.boolean().optional(),
  excludes: z.array(RELATIVE).optional(),
});

/** A restic pattern that matches exactly this path: its glob characters and backslashes are escaped. */
export const exactPattern = (path: string): string => path.replace(/[\\*?[\]]/g, (char) => `\\${char}`);

const REDACTED = "[redacted]";

/** Cuts the secret out of a text, also a start of it left at the end of a message the runner cut short. */
export const redactor =
  (secret: string) =>
  (text: string): string => {
    if (secret === "") return text;
    const out = text.replaceAll(secret, REDACTED);
    if (!out.endsWith("…")) return out;
    const body = out.slice(0, -1);
    for (let length = Math.min(secret.length - 1, body.length); length > 0; length--) {
      if (body.endsWith(secret.slice(0, length))) return `${body.slice(0, -length)}${REDACTED}…`;
    }
    return out;
  };

const MAX_MESSAGES = 100;
/** At most this many folders are read with cat tree for symlinks that ls -l could not place. */
const TREE_LOOKUPS = 16;

/** The JSON lines of one stream of a finished run that parse; others are skipped. */
const jsonLines = (text: string): ResticLine[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => {
      const parsed = parseLine(line);
      return parsed.ok ? [parsed.value] : [];
    });

/** What restic said about its failure: its exit_error line, else the last lines of stderr. */
const resticSaid = (outcome: RunOutcome): string => {
  const exitError = jsonLines(outcome.stderr.text).findLast((line) => line.message_type === "exit_error");
  if (exitError?.message_type === "exit_error") return exitError.message.replace(/^(Fatal: )+/, "");
  return outcome.stderr.text.trim().split("\n").slice(-5).join("\n");
};

type SummaryLine = Extract<ResticLine, { message_type: "summary" }>;

const progressOf = (
  op: string,
  phase: "snapshot" | "restore",
  line: Extract<ResticLine, { message_type: "status" }>,
) =>
  ({
    type: "progress",
    op,
    phase,
    bytesDone: (phase === "snapshot" ? line.bytes_done : line.bytes_restored) ?? 0,
    bytesTotal: line.total_bytes ?? 0,
    ...(line.seconds_remaining === undefined ? {} : { etaSeconds: line.seconds_remaining }),
  }) as const;

export const resticEngine = (options: ResticEngineOptions): Engine => {
  const { host, repository, password } = options;
  const redact = redactor(password);
  const expected = options.expectedVersion ?? PINNED_RESTIC;
  const retryLock = options.retryLock === undefined ? "1m" : options.retryLock;
  const global = [
    "--repo",
    repository,
    ...(options.cacheDir === undefined ? [] : ["--cache-dir", options.cacheDir]),
    ...(retryLock === null ? [] : [`--retry-lock=${retryLock}`]),
  ];

  const childEnv = (extra: Record<string, string>): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.env))
      if (!name.startsWith("RESTIC_")) env[name] = value;
    return { ...env, RESTIC_PROGRESS_FPS: String(options.progressFps ?? 1), ...extra };
  };

  const redactFailure = (failure: Failure): Failure => ({
    ...failure,
    finding: {
      ...failure.finding,
      message: redact(failure.finding.message),
      ...(failure.finding.fix === undefined ? {} : { fix: redact(failure.finding.fix) }),
      ...(failure.finding.paths === undefined ? {} : { paths: failure.finding.paths.map(redact) }),
    },
  });

  /** The finding for a restic run that ended with anything but 0. */
  const exitFailure = (outcome: RunOutcome, command: string): Failure => {
    const said = redact(resticSaid(outcome));
    const saying = said === "" ? "" : `: ${said}`;
    if (outcome.exitCode === null) {
      return fail(
        finding("restic.failed", {
          message: `restic ${command} was ended by ${outcome.signal}${saying}`,
          fix: "re-run the command; if it fails again, check the store with `restic check`",
        }),
      );
    }
    switch (outcome.exitCode) {
      case 3:
        return fail(
          finding("restic.unreadable-files", {
            message: `restic ${command} could not read some files${saying}`,
            fix: "make the files readable, or move them out of the project, then re-run",
          }),
        );
      case 10:
        return fail(
          finding("restic.repo-missing", {
            message: `no restic repository at ${repository}${saying}`,
            fix: "connect or mount the store's disk, and check the store's path in config.toml",
          }),
        );
      case 11:
        return fail(
          finding("restic.locked", {
            message: `the restic repository at ${repository} is locked by another process${saying}`,
            fix: `wait for the other restic or plainport run on this store to finish; if none is running, remove the stale lock with: restic --repo ${repository} unlock`,
          }),
        );
      case 12:
        return fail(
          finding("restic.wrong-password", {
            message: `the password does not open the restic repository at ${repository}${saying}`,
            fix: "check that the store's secret in config.toml is this repository's password",
          }),
        );
      case 130:
        return fail(
          finding("restic.interrupted", {
            message: `restic ${command} was interrupted${saying}`,
            fix: "re-run the command",
          }),
        );
      default:
        return fail(
          finding("restic.failed", {
            message: `restic ${command} failed with exit code ${outcome.exitCode}${saying}`,
            fix: "fix the cause restic names, then re-run the command",
          }),
        );
    }
  };

  const run = async (
    command: string,
    args: readonly string[],
    ctx: RunContext | undefined,
    how: {
      cwd?: string;
      capture?: boolean;
      wholeStdout?: boolean;
      onLine?: RunSpec["onLine"];
      repo?: boolean;
    } = {},
  ): Promise<Result<RunOutcome>> => {
    const emit = ctx?.emit;
    const result = await host.run({
      command: options.restic,
      args: [...(how.repo === false ? [] : global), command, ...args],
      cwd: how.cwd ?? "/",
      // restic records the absolute path of "." from PWD when PWD names it, else from getcwd, which resolves
      // symlinks (/var is /private/var on macOS): with PWD, the snapshot path and the excludes stay the given dir.
      env: childEnv(
        how.repo === false
          ? {}
          : { RESTIC_PASSWORD: password, ...(how.cwd === undefined ? {} : { PWD: how.cwd }) },
      ),
      ...(ctx?.signal === undefined ? {} : { signal: ctx.signal }),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(how.capture ? { capture: { maxBytes: options.captureLimitBytes ?? 1024 ** 3 } } : {}),
      ...(how.wholeStdout ? { wholeStdout: true } : {}),
      ...(how.onLine === undefined ? {} : { onLine: how.onLine }),
      ...(emit === undefined || ctx === undefined
        ? {}
        : {
            log: {
              op: ctx.op,
              streams: ["stderr"] as const,
              emit: (event) => emit({ ...event, message: redact(event.message) }),
            },
          }),
    });
    return result.ok ? result : redactFailure(result);
  };

  /** Runs a data command in capture mode; its stdout, only when restic exited 0. */
  const capture = async (
    command: string,
    args: readonly string[],
    ctx: RunContext | undefined,
    repo = true,
  ): Promise<Result<string>> => {
    const ran = await run(command, args, ctx, { capture: true, repo });
    if (!ran.ok) return ran;
    const bytes = capturedOutput(ran.value, (outcome) => exitFailure(outcome, command));
    return bytes.ok ? ok(new TextDecoder().decode(bytes.value)) : bytes;
  };

  let verified: Promise<Result<void>> | undefined;
  const checkVersion = async (ctx: RunContext | undefined): Promise<Result<void>> => {
    const ran = await capture("version", ["--json"], ctx, false);
    if (!ran.ok) return ran;
    const line = parseLine(ran.value.trim());
    if (!line.ok) return line;
    if (line.value.message_type !== "version")
      return fail(
        finding("restic.output-invalid", {
          message: "`restic version --json` printed no version line",
          fix: "check that the restic binary is restic",
        }),
      );
    if (line.value.version === expected) return ok(undefined);
    return fail(
      finding("restic.version-mismatch", {
        message: `restic at ${options.restic} is version ${line.value.version}; this plainport pins restic ${expected} and is tested only with it`,
        fix: `reinstall plainport so its bundled restic ${expected} is used; in a plainport checkout, run \`bun scripts/fetch-tools.ts\``,
      }),
    );
  };
  /** Checked once per engine; a failed check is tried again by the next call. */
  const ensureVersion = (ctx: RunContext | undefined): Promise<Result<void>> => {
    verified ??= checkVersion(ctx).then((result) => {
      if (!result.ok) verified = undefined;
      return result;
    });
    return verified;
  };

  /** A failed ls or restore may mean the snapshot does not exist; restic says so only in prose, so ask. */
  const missingOr = async (
    snapshot: string,
    failure: Failure,
    ctx: RunContext | undefined,
  ): Promise<Failure> => {
    if (failure.finding.code !== "restic.failed") return failure;
    const found = await capture("snapshots", ["--json", snapshot], ctx);
    if (!found.ok) return failure;
    const snapshots = parseSnapshots(found.value);
    if (!snapshots.ok || snapshots.value.length > 0) return failure;
    return fail(
      finding("restic.snapshot-not-found", {
        message: `the restic repository at ${repository} has no snapshot ${snapshot}`,
        fix: "list the project's snapshots with `plainport ls`",
      }),
    );
  };

  /** Streams a command's JSON lines to `onJson`; a stdout line that is not restic's JSON is remembered. */
  const streamed = (onJson: (line: ResticLine, stream: "stdout" | "stderr") => void) => {
    let invalid: Failure | undefined;
    const onLine: RunSpec["onLine"] = (line) => {
      if (line.truncated || !line.text.startsWith("{")) return;
      const parsed = parseLine(line.text);
      if (parsed.ok) onJson(parsed.value, line.stream);
      else if (line.stream === "stdout") invalid ??= redactFailure(parsed);
    };
    return { onLine, invalid: () => invalid };
  };

  /** Runs a data command whose stdout is read as whole line records (the runner's wholeStdout): every stdout line
   * reaches onRecord, and the Result is ok only when all of them did and restic exited 0. */
  const lines = async (
    command: string,
    args: readonly string[],
    ctx: RunContext | undefined,
    onRecord: (line: string) => void,
  ): Promise<Result<void>> => {
    const ran = await run(command, args, ctx, {
      wholeStdout: true,
      onLine: (line) => {
        if (line.stream === "stdout") onRecord(line.text);
      },
    });
    if (!ran.ok) return ran;
    if (ran.value.exitCode !== 0 || ran.value.signal !== null) return exitFailure(ran.value, command);
    return ok(undefined);
  };

  /**
   * Symlink targets, keyed by entry path. One `ls -l` run places them all, however many folders hold symlinks
   * (fix r1 I2); a symlink whose name or target makes its line ambiguous is read with `cat tree` of its folder,
   * for at most TREE_LOOKUPS folders.
   */
  const linkTargets = async (
    snapshot: string,
    links: readonly EntryMeta[],
    entries: number,
    ctx: RunContext | undefined,
  ): Promise<Result<Map<string, string>>> => {
    const reader = new LongListingReader(new Set(links.map((link) => `/${link.path}`)));
    const listed = await lines("ls", ["-l", snapshot], ctx, (line) => reader.line(line));
    if (!listed.ok) return listed;
    const long = reader.end();
    // ls -l prints names and targets raw; its records are trusted only when there are exactly as many as
    // ls --json listed entries (fix r2 N1). Otherwise every symlink is read with cat tree.
    const trusted = long.reliable && long.records === entries;
    const targets = new Map<string, string>();
    if (trusted) for (const [path, target] of long.targets) targets.set(path.slice(1), target);

    const folders = new Map<string, EntryMeta[]>();
    for (const link of links) {
      if (targets.has(link.path)) continue;
      const slash = link.path.lastIndexOf("/");
      const folder = slash === -1 ? "" : link.path.slice(0, slash);
      folders.set(folder, [...(folders.get(folder) ?? []), link]);
    }
    if (folders.size > TREE_LOOKUPS) {
      const unclear = [...folders.values()].flat().map((link) => link.path);
      const why = trusted
        ? "their names or targets hold line breaks or ' -> ', which restic's ls -l prints as they are"
        : "some name or link target in the snapshot holds a line break that restic's ls -l prints as it is, so its listing cannot be matched line by line";
      return fail(
        finding("restic.symlinks-unclear", {
          message: `the targets of ${unclear.length} symlinks in ${folders.size} folders cannot be read in one pass: ${why}; plainport reads at most ${TREE_LOOKUPS} folders one by one`,
          fix: "rename the symlinks (or their targets) that hold line breaks or ' -> ' in their names (the first are listed), then offload again",
          paths: unclear.slice(0, 10),
        }),
      );
    }
    for (const [folder, inFolder] of folders) {
      const read = await capture("cat", ["tree", `${snapshot}:/${folder}`], ctx);
      if (!read.ok) return read;
      const tree = parseTree(read.value);
      if (!tree.ok) return tree;
      const byName = new Map(tree.value.nodes.map((node) => [node.name, node.linktarget]));
      for (const link of inFolder) {
        const target = byName.get(link.path.slice(link.path.lastIndexOf("/") + 1));
        if (target !== undefined) targets.set(link.path, target);
      }
    }
    return ok(targets);
  };

  const outputInvalid = (message: string): Failure =>
    fail(
      finding("restic.output-invalid", {
        message,
        fix: "re-run the command; if it fails again, report it with the output of `restic version`",
      }),
    );

  return {
    id: "restic",

    init: async (ctx) => {
      const version = await ensureVersion(ctx);
      if (!version.ok) return version;
      const ran = await run("init", ["--json"], ctx, { capture: true });
      if (!ran.ok) return ran;
      if (ran.value.exitCode === 1 && resticSaid(ran.value).includes("config file already exists")) {
        return fail(
          finding("restic.repo-exists", {
            message: `a restic repository already exists at ${repository}`,
            fix: "use the existing repository with its password, or choose an empty location",
          }),
        );
      }
      const bytes = capturedOutput(ran.value, (outcome) => exitFailure(outcome, "init"));
      if (!bytes.ok) return bytes;
      const initialized = jsonLines(new TextDecoder().decode(bytes.value)).find(
        (line) => line.message_type === "initialized",
      );
      return initialized?.message_type === "initialized"
        ? ok({ id: initialized.id })
        : outputInvalid("`restic init --json` printed no initialized line");
    },

    snapshot: async (input, ctx) => {
      const checked = decode(SnapshotInputSchema, input, "snapshot input");
      if (!checked.ok) return checked;
      const { dir, excludes, parent, tags } = checked.value;
      const version = await ensureVersion(ctx);
      if (!version.ok) return version;

      const seen: { summary?: SummaryLine; unreadable: string[]; unreadableCount: number } = {
        unreadable: [],
        unreadableCount: 0,
      };
      const stream = streamed((line, from) => {
        if (line.message_type === "status" && from === "stdout")
          ctx.emit?.(progressOf(ctx.op, "snapshot", line));
        else if (line.message_type === "summary" && from === "stdout") seen.summary = line;
        else if (line.message_type === "error" && line.item !== undefined) {
          seen.unreadableCount++;
          if (seen.unreadable.length < MAX_MESSAGES) {
            const item = line.item.startsWith(`${dir}/`) ? line.item.slice(dir.length + 1) : line.item;
            seen.unreadable.push(redact(item));
          }
        }
      });
      const args = [
        "--json",
        ...tags.flatMap((tag) => ["--tag", encodeTag(tag)]),
        ...(parent === undefined ? [] : [`--parent=${parent}`]),
        ...excludes.map((path) => `--exclude=${exactPattern(`${dir === "/" ? "" : dir}/${path}`)}`),
        ".",
      ];
      const ran = await run("backup", args, ctx, { cwd: dir, onLine: stream.onLine });
      if (!ran.ok) return ran;
      if (ran.value.exitCode === 3) {
        const { summary, unreadable, unreadableCount } = seen;
        // restic wrote the snapshot anyway: its id is data, for the saga to journal as discarded (D28).
        const written =
          summary?.snapshot_id !== undefined && SNAPSHOT_ID.safeParse(summary.snapshot_id).success;
        const more =
          unreadableCount > unreadable.length ? ` (the first ${unreadable.length} are listed)` : "";
        const failed = fail(
          finding("restic.unreadable-files", {
            message: `restic could not read ${unreadableCount || "some"} file(s) in ${dir}${more}${written ? `; snapshot ${summary?.snapshot_id} is incomplete and is not used` : ""}`,
            fix: "make the listed files readable (chmod u+r), or move them out of the project, then re-run",
            paths: unreadable,
          }),
        );
        return written && summary?.snapshot_id !== undefined
          ? { ...failed, incomplete: { snapshot: summary.snapshot_id } }
          : failed;
      }
      if (ran.value.exitCode !== 0 || ran.value.signal !== null) return exitFailure(ran.value, "backup");
      const invalid = stream.invalid();
      if (invalid !== undefined) return invalid;
      const done = seen.summary;
      if (done?.snapshot_id === undefined || !/^[0-9a-f]{64}$/.test(done.snapshot_id))
        return outputInvalid("`restic backup --json` printed no summary with a snapshot id");
      const stats: SnapshotStats = {
        filesNew: done.files_new ?? 0,
        filesChanged: done.files_changed ?? 0,
        filesUnmodified: done.files_unmodified ?? 0,
        dirsNew: done.dirs_new ?? 0,
        dirsChanged: done.dirs_changed ?? 0,
        dirsUnmodified: done.dirs_unmodified ?? 0,
        dataAdded: done.data_added ?? 0,
        totalFilesProcessed: done.total_files_processed ?? 0,
        totalBytesProcessed: done.total_bytes_processed ?? 0,
      };
      return ok({ id: done.snapshot_id, stats });
    },

    list: async (filter, ctx) => {
      const tags = decode(z.array(TAG), filter.tags ?? [], "tag filter");
      if (!tags.ok) return tags;
      const version = await ensureVersion(ctx);
      if (!version.ok) return version;
      const args = [
        "--json",
        ...(tags.value.length === 0 ? [] : ["--tag", tags.value.map(encodeTag).join(",")]),
      ];
      const listed = await capture("snapshots", args, ctx);
      if (!listed.ok) return listed;
      return parseSnapshots(listed.value);
    },

    entries: async (snapshot, onEntry, ctx) => {
      const id = decode(SNAPSHOT_ID, snapshot, "snapshot id");
      if (!id.ok) return id;
      const version = await ensureVersion(ctx);
      if (!version.ok) return version;

      // The listing streams: entries go to onEntry as restic prints them, except symlinks, whose targets
      // ls --json leaves out; those wait (memory grows with the symlinks, not with the project).
      const links: EntryMeta[] = [];
      let count = 0;
      const reader = new ListingReader((entry) => {
        if (entry.type === "symlink") links.push(entry);
        else {
          count++;
          onEntry(entry);
        }
      });
      const listed = await lines("ls", ["--json", id.value], ctx, (line) => reader.line(line));
      if (!listed.ok) return missingOr(id.value, listed, ctx);
      const header = reader.end();
      if (!header.ok) return header;

      if (links.length > 0) {
        const targets = await linkTargets(id.value, links, count + links.length, ctx);
        if (!targets.ok) return targets;
        for (const link of links) {
          const target = targets.value.get(link.path);
          if (target === undefined)
            return outputInvalid(`restic gave no target for the symlink ${link.path}`);
          count++;
          onEntry({ ...link, linkTarget: target });
        }
      }
      return ok({ snapshot: header.value, count });
    },

    restore: async (snapshot, target, ctx, restoreOptions = {}) => {
      const checked = decode(RestoreSchema, { snapshot, target, ...restoreOptions }, "restore input");
      if (!checked.ok) return checked;
      const input = checked.value;
      const version = await ensureVersion(ctx);
      if (!version.ok) return version;

      const seen: { summary?: SummaryLine } = {};
      const stream = streamed((line, from) => {
        if (from !== "stdout") return;
        if (line.message_type === "status") ctx.emit?.(progressOf(ctx.op, "restore", line));
        else if (line.message_type === "summary") seen.summary = line;
      });
      const args = [
        input.snapshot,
        `--target=${input.target}`,
        "--json",
        ...(input.overwrite === undefined ? [] : [`--overwrite=${input.overwrite}`]),
        ...(input.delete ? ["--delete"] : []),
        ...(input.excludes ?? []).map((path) => `--exclude=${exactPattern(`/${path}`)}`),
      ];
      const ran = await run("restore", args, ctx, { onLine: stream.onLine });
      if (!ran.ok) return ran;
      if (ran.value.exitCode !== 0 || ran.value.signal !== null)
        return missingOr(input.snapshot, exitFailure(ran.value, "restore"), ctx);
      const invalid = stream.invalid();
      if (invalid !== undefined) return invalid;
      const done = seen.summary;
      if (done === undefined) return outputInvalid("`restic restore --json` printed no summary");
      const stats: RestoreStats = {
        totalFiles: done.total_files ?? 0,
        filesRestored: done.files_restored ?? 0,
        filesSkipped: done.files_skipped ?? 0,
        filesDeleted: done.files_deleted ?? 0,
        totalBytes: done.total_bytes ?? 0,
        bytesRestored: done.bytes_restored ?? 0,
        bytesSkipped: done.bytes_skipped ?? 0,
      };
      return ok(stats);
    },

    check: async (checkOptions = {}, ctx) => {
      const subset = decode(z.string().min(1).optional(), checkOptions.readDataSubset, "read-data subset");
      if (!subset.ok) return subset;
      const version = await ensureVersion(ctx);
      if (!version.ok) return version;
      const seen: { errors?: number } = {};
      const messages: string[] = [];
      const stream = streamed((line) => {
        if (line.message_type === "summary") seen.errors = line.num_errors;
        else if (line.message_type === "error" && messages.length < MAX_MESSAGES) {
          const message = (line.error?.message ?? line.message ?? "").trim();
          if (message !== "") messages.push(redact(message));
        }
      });
      const args = ["--json", ...(subset.value === undefined ? [] : [`--read-data-subset=${subset.value}`])];
      const ran = await run("check", args, ctx, { onLine: stream.onLine });
      if (!ran.ok) return ran;
      const found = seen.errors;
      if (ran.value.exitCode === 0 && found === 0)
        return ok({ ok: true, errors: 0, messages: [] } satisfies CheckReport);
      // A damaged repository: restic exits 1 after its summary counted the errors.
      if (ran.value.exitCode === 1 && found !== undefined && found > 0)
        return ok({ ok: false, errors: found, messages } satisfies CheckReport);
      if (ran.value.exitCode !== 0 || ran.value.signal !== null) return exitFailure(ran.value, "check");
      return stream.invalid() ?? outputInvalid("`restic check --json` printed no summary");
    },
  };
};
