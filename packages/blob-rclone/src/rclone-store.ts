// The BlobStore port over the pinned rclone CLI (ADR-0006; DESIGN.md "Plugin interfaces → BlobStore", "Remote stores:
// consistency and publication"): S3-compatible buckets and SFTP, and rclone's `local` backend in tests. Every call is
// one rclone run through the host's one process runner (AGENTS.md rule 6): `get` is `cat`, `list` is
// `lsjson -R --files-only`, `stat` is `lsjson --stat`, `delete` is `deletefile`, `getMany` is one `copy`.
//
// Publication (D98). The port's put is whole. On S3 a put is `rcat` straight to the key: a bucket shows an object only
// once it is complete. Elsewhere (SFTP, local) rclone's rcat can write in place, so a put uploads to its own
// temporary, `meta/v1/tmp/<op>-<ulid>`, and `moveto`s it onto the key: a reader of the key sees nothing or every
// byte. A put that dies between the two leaves that temporary, which sweepTemporaries removes once it is old enough
// (gc's job); nothing else ever writes, lists or deletes under that prefix. Whether the move is atomic on a given
// server, and whether it replaces a key that is there, is what Task 17 measures: until then semantics() reports every
// property unknown, so only reading is eligible, and a profile passed in may never claim more than this adapter does
// (no conditional create, and only the publication its route gives).
//
// The remote is defined by environment variables only (RCLONE_CONFIG_PLAINPORT_<OPTION>), with RCLONE_CONFIG naming
// a file under plainport's cache that must not exist, so no rclone.conf and none of this process's own rclone settings
// are ever read. Network calls are bounded by rclone's own timeouts and one retry, on top of the runner's deadlines.
// Secret options (a secret access key, an SFTP password) reach rclone only in its environment, never in argv, and are
// cut out of everything rclone says before it reaches a finding.
//
// Exit codes: on get, stat, list and delete, 3 (directory not found) and 4 (file not found) mean the key is not
// there. 5 (a temporary error) and connection failures are store.unreachable; anything else is store.failed.

import { join } from "node:path";
import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import {
  assertBlobKey,
  assertBlobPrefix,
  type BlobEntry,
  type BlobStore,
  capabilitiesOf,
  deleteGuard,
  type Env,
  errorCode,
  type HostPorts,
  isBlobKey,
  type PlainportPaths,
  type PutOptions,
  type RunOutcome,
  type RunSpec,
  type StoreSemantics,
  semanticValue,
  systemErrorCode,
  UNKNOWN_SEMANTICS,
  ulid,
} from "@plainport/core";
import { z } from "zod";

/** The one remote every run defines: RCLONE_CONFIG_PLAINPORT_* in the child's environment, PLAINPORT: in paths. */
export const RCLONE_REMOTE = "PLAINPORT";

/** Where a temp-then-rename put uploads before it moves onto its key (D98); the adapter's own, hidden from callers. */
export const TEMP_PREFIX = "meta/v1/tmp/";

export interface RcloneRemote {
  /** The rclone backend: "s3", "sftp", or "local" (tests). */
  type: string;
  /** Backend options, given to rclone as RCLONE_CONFIG_PLAINPORT_<OPTION>: provider, endpoint, host, user, … */
  options?: Readonly<Record<string, string>>;
  /**
   * Options whose values are secrets (secret_access_key; an SFTP pass, obscured as rclone wants it), resolved from
   * their references by the caller. Given the same way, and cut out of everything rclone says.
   */
  secrets?: Readonly<Record<string, string>>;
  /** The store's root on the remote: "<bucket>/<prefix>" on S3, a folder on SFTP or local. */
  root: string;
}

export type RclonePublication = "atomic-put" | "temp-then-rename";

export interface RcloneBlobStoreOptions {
  host: Pick<HostPorts, "fs" | "proc" | "run" | "faultAt" | "clock">;
  /** The rclone binary: toolPath(io, "rclone") in the composition root. */
  rclone: string;
  remote: RcloneRemote;
  /** plainport's folders: rclone's cache and the missing rclone.conf live under cacheDir, as getMany's temp folders. */
  paths: PlainportPaths;
  /**
   * This process's environment. The child gets only HOME, PATH, TMPDIR, the locale, the proxy settings and
   * SSH_AUTH_SOCK from it, never an RCLONE_ variable; the delete guard reads the configuration with it.
   */
  env: Env;
  /** How a put publishes. Default: atomic-put on S3, temp-then-rename elsewhere. */
  publication?: RclonePublication;
  /** The store's profile, as measured (Task 17). Default: every property unknown. */
  semantics?: StoreSemantics;
  /** Names this command's temporaries (`<op>-<ulid>`). Default "put". */
  op?: string;
  /** rclone's --contimeout and --timeout. Defaults: 15s and 60s. */
  connectTimeout?: string;
  ioTimeout?: string;
  /** The runner's deadlines for one rclone run. Defaults: 2 minutes without output, 10 minutes in all. */
  idleTimeoutMs?: number;
  timeoutMs?: number;
  /** rclone's --bwlimit, for slow links (and tests that watch an upload). */
  bwlimit?: string;
}

export interface RcloneBlobStore extends BlobStore {
  getMany(keys: readonly string[]): Promise<Result<Map<string, Uint8Array>>>;
  /** Deletes this adapter's temporaries older than `olderThanMs` (by the time in their name); gc's sweep (D98). */
  sweepTemporaries(olderThanMs: number): Promise<Result<{ swept: string[] }>>;
}

/** How an rclone exit reads: ok, the key or folder is not there, the store could not be reached, or another failure. */
export type RcloneExit = "ok" | "missing" | "unreachable" | "failed";

/**
 * What rclone and Go print when a connection cannot be made or breaks. Not rclone's "couldn't connect SSH" alone: it
 * also prefixes a refused host key or login, which are failures to fix, not an unreachable store.
 */
const CONNECTION =
  /dial tcp|connection refused|no such host|i\/o timeout|network is unreachable|no route to host|host is down|connection reset by peer|TLS handshake timeout/i;
/** An SSH handshake that failed on the host key or the login: never unreachable, whatever else the line says. */
const REFUSED_HANDSHAKE = /ssh: handshake failed: (knownhosts|ssh: unable to authenticate|host key)/i;

export const classifyExit = (exitCode: number | null, stderr: string): RcloneExit => {
  if (exitCode === 0) return "ok";
  if (REFUSED_HANDSHAKE.test(stderr)) return "failed";
  if (exitCode === 5 || CONNECTION.test(stderr)) return "unreachable";
  if (exitCode === 3 || exitCode === 4) return "missing";
  return "failed";
};

/** What the child may see of this process's environment (nothing of rclone's, nothing of a cloud SDK's). */
const PASSED_ENV = [
  "HOME",
  "PATH",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

const OPTION_NAME = /^[A-Za-z0-9_]+$/;
const OP_NAME = /^[A-Za-z0-9_-]+$/;
const TEMP_NAME = /^.+-([0-7][0-9A-HJKMNP-TV-Z]{25})(?:\..*)?$/;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The milliseconds a ULID's first ten characters hold. */
const ulidTime = (id: string): number => {
  let time = 0;
  for (const char of id.slice(0, 10)) time = time * 32 + CROCKFORD.indexOf(char);
  return time;
};

const REDACTED = "[redacted]";
/** A run of at least this many characters of a secret counts as the secret (a message may cut it anywhere). */
const SECRET_SLICE = 12;

/** Cuts every secret, and every slice of one at least SECRET_SLICE long, out of a text. */
const redactor =
  (secrets: readonly string[]) =>
  (text: string): string => {
    let out = text;
    for (const secret of secrets) {
      if (secret === "") continue;
      const min = Math.min(SECRET_SLICE, secret.length);
      let result = "";
      for (let i = 0; i < out.length; ) {
        let best = 0;
        for (let j = 0; j < secret.length; j++) {
          let length = 0;
          while (
            i + length < out.length &&
            j + length < secret.length &&
            out[i + length] === secret[j + length]
          )
            length++;
          if (length > best) best = length;
        }
        if (best >= min) {
          result += REDACTED;
          i += best;
        } else {
          result += out[i];
          i++;
        }
      }
      out = result;
    }
    return out;
  };

/** The last few things rclone said, without its timestamps and levels. */
const rcloneSaid = (stderr: string): string => {
  const said = stderr
    .split("\n")
    .map((line) =>
      line
        .replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d /, "")
        .replace(/^(ERROR|CRITICAL|NOTICE|INFO|DEBUG) ?: ?/, "")
        .trim(),
    )
    .filter((line) => line !== "")
    .slice(-3)
    .join("; ");
  return said.length > 600 ? `${said.slice(0, 600)}…` : said;
};

const EntrySchema = z.object({ Path: z.string(), Size: z.number(), IsDir: z.boolean() });
const ListingSchema = z.array(EntrySchema);

/** A key's parent folder ("" at the root) and its last segment. */
const splitKey = (key: string): { dir: string; name: string } => {
  const slash = key.lastIndexOf("/");
  return slash < 0 ? { dir: "", name: key } : { dir: key.slice(0, slash), name: key.slice(slash + 1) };
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const rcloneBlobStore = (options: RcloneBlobStoreOptions): RcloneBlobStore => {
  const { host, remote, paths } = options;
  const publication: RclonePublication =
    options.publication ?? (remote.type === "s3" ? "atomic-put" : "temp-then-rename");
  const semantics = options.semantics ?? UNKNOWN_SEMANTICS;
  if (semanticValue(semantics.conditionalCreate) === true)
    throw new RangeError("rclone cannot create a key only if it is absent: its profile may not claim it");
  const claimed = semanticValue(semantics.publication);
  if (claimed !== "unknown" && claimed !== publication)
    throw new RangeError(`this rclone store publishes ${publication}: its profile may not claim ${claimed}`);
  const op = options.op ?? "put";
  if (!OP_NAME.test(op)) throw new RangeError(`not a valid op for a temporary's name: ${JSON.stringify(op)}`);

  const secrets = Object.values(remote.secrets ?? {});
  const redact = redactor(secrets);
  const where = `${remote.type}:${remote.root}`;
  const cacheDir = join(paths.cacheDir, "rclone");
  const absentConfig = join(cacheDir, "absent", "rclone.conf");

  const childEnv: Record<string, string> = {};
  for (const name of PASSED_ENV) {
    const value = options.env[name];
    if (value !== undefined) childEnv[name] = value;
  }
  childEnv.RCLONE_CONFIG = absentConfig;
  childEnv[`RCLONE_CONFIG_${RCLONE_REMOTE}_TYPE`] = remote.type;
  for (const [name, value] of [
    ...Object.entries(remote.options ?? {}),
    ...Object.entries(remote.secrets ?? {}),
  ]) {
    if (!OPTION_NAME.test(name) || name.toUpperCase() === "TYPE")
      throw new RangeError(`not a valid rclone option name: ${JSON.stringify(name)}`);
    childEnv[`RCLONE_CONFIG_${RCLONE_REMOTE}_${name.toUpperCase()}`] = value;
  }

  const global = [
    "-q",
    "--ask-password=false",
    "--contimeout",
    options.connectTimeout ?? "15s",
    "--timeout",
    options.ioTimeout ?? "60s",
    "--retries",
    "1",
    "--cache-dir",
    cacheDir,
    ...(options.bwlimit === undefined ? [] : ["--bwlimit", options.bwlimit]),
  ];

  const base = remote.root === "/" ? "/" : remote.root.replace(/\/+$/, "");
  /** The rclone path of a key or folder under the store's root ("" is the root). */
  const remotePath = (relative: string): string => {
    const path =
      relative === "" ? base : base === "" ? relative : base === "/" ? `/${relative}` : `${base}/${relative}`;
    return `${RCLONE_REMOTE}:${path}`;
  };

  const unreachable = (command: string, said: string): Failure =>
    fail(
      finding("store.unreachable", {
        message: `the store ${where} could not be reached (rclone ${command})${said === "" ? "" : `: ${said}`}`,
        fix: "check the network connection and the store's endpoint and credentials, then re-run",
      }),
    );
  const failed = (what: string, said: string, fix?: string): Failure =>
    fail(
      finding("store.failed", {
        message: `${what} in the store ${where}${said === "" ? "" : `: ${said}`}`,
        fix: fix ?? "fix the cause rclone names (permissions, credentials, a full disk), then re-run",
      }),
    );
  const redactFailure = (failure: Failure): Failure => ({
    ...failure,
    finding: {
      ...failure.finding,
      message: redact(failure.finding.message),
      ...(failure.finding.fix === undefined ? {} : { fix: redact(failure.finding.fix) }),
    },
  });

  /** The failure for an rclone exit that was not ok (or not missing, where that is fine). */
  const exitFailure = (outcome: RunOutcome, command: string, what: string): Failure => {
    const said = redact(rcloneSaid(outcome.stderr.text));
    if (outcome.exitCode === null)
      return failed(`${what}: rclone ${command} was ended by ${outcome.signal}`, said);
    if (classifyExit(outcome.exitCode, outcome.stderr.text) === "unreachable")
      return unreachable(command, said);
    return failed(`${what}: rclone ${command} exited ${outcome.exitCode}`, said);
  };

  /** Refuses when anything is where the missing rclone.conf must be, so rclone can never read one. */
  const checkNoConfig = async (): Promise<Failure | undefined> => {
    try {
      await host.fs.lstat(absentConfig);
    } catch (error) {
      const code = systemErrorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      return failed(`${absentConfig} could not be checked`, describeError(error));
    }
    return failed(
      `rclone could not be run: ${absentConfig} exists, where plainport points rclone at a file that must not`,
      "",
      `remove ${absentConfig}; plainport reads no rclone.conf, only the store's settings`,
    );
  };

  const run = async (
    command: string,
    args: readonly string[],
    how: { stdin?: string | Uint8Array; capture?: boolean } = {},
  ): Promise<Result<RunOutcome>> => {
    const refused = await checkNoConfig();
    if (refused !== undefined) return refused;
    const spec: RunSpec = {
      command: options.rclone,
      args: [...global, command, ...args],
      cwd: "/",
      env: childEnv,
      idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
      timeoutMs: options.timeoutMs ?? 600_000,
      ...(how.stdin === undefined ? {} : { stdin: how.stdin }),
      ...(how.capture ? { capture: { maxBytes: 1024 ** 3 } } : {}),
    };
    const ran = await host.run(spec);
    return ran.ok ? ran : redactFailure(ran);
  };

  const stat = async (key: string): Promise<Result<{ size: number } | null>> => {
    const ran = await run("lsjson", ["--stat", remotePath(key)], { capture: true });
    if (!ran.ok) return ran;
    const exit = classifyExit(ran.value.exitCode, ran.value.stderr.text);
    if (exit === "missing") return ok(null);
    if (exit !== "ok") return exitFailure(ran.value, "lsjson", `${key} could not be looked up`);
    const parsed = EntrySchema.safeParse(parseJson(ran.value.captured));
    if (!parsed.success) return failed(`${key} could not be looked up`, "rclone lsjson printed no entry");
    return ok(parsed.data.IsDir ? null : { size: parsed.data.Size });
  };

  const get = async (key: string): Promise<Result<Uint8Array | null>> => {
    const { dir, name } = splitKey(key);
    // A name rclone's raw file list cannot hold is read by its path; elsewhere the list makes cat read that one file,
    // never a folder of the same name (whose files cat would join).
    const ran = /[\r\n]/.test(name)
      ? await run("cat", [remotePath(key)], { capture: true })
      : await run("cat", ["--files-from-raw", "-", remotePath(dir)], { capture: true, stdin: `${name}\n` });
    if (!ran.ok) return ran;
    const exit = classifyExit(ran.value.exitCode, ran.value.stderr.text);
    if (exit === "missing") return ok(null);
    if (exit !== "ok") return exitFailure(ran.value, "cat", `${key} could not be read`);
    const bytes = ran.value.captured ?? new Uint8Array();
    if (bytes.length > 0) return ok(bytes);
    // Nothing printed: an empty file, or no such file. stat tells which.
    const found = await stat(key);
    if (!found.ok) return found;
    return ok(found.value === null ? null : new Uint8Array());
  };

  /** Every file under a folder ("" is the root), as keys; a folder that is not there is empty. */
  const listUnder = async (dir: string): Promise<Result<BlobEntry[]>> => {
    const ran = await run("lsjson", ["-R", "--files-only", remotePath(dir)], { capture: true });
    if (!ran.ok) return ran;
    const exit = classifyExit(ran.value.exitCode, ran.value.stderr.text);
    if (exit === "missing") return ok([]);
    const what = `${dir === "" ? "the root" : `${dir}/`} could not be listed`;
    if (exit !== "ok") return exitFailure(ran.value, "lsjson", what);
    const parsed = ListingSchema.safeParse(parseJson(ran.value.captured));
    if (!parsed.success) return failed(what, "rclone lsjson printed a listing that does not parse");
    const prefix = dir === "" ? "" : `${dir}/`;
    return ok(
      parsed.data
        .filter((entry) => !entry.IsDir)
        .map((entry) => ({ key: `${prefix}${entry.Path}`, size: entry.Size }))
        .filter((entry) => isBlobKey(entry.key)),
    );
  };

  const list = async (prefix: string): Promise<Result<BlobEntry[]>> => {
    const slash = prefix.lastIndexOf("/");
    const listed = await listUnder(slash < 0 ? "" : prefix.slice(0, slash));
    if (!listed.ok) return listed;
    return ok(
      listed.value
        .filter((entry) => entry.key.startsWith(prefix) && !entry.key.startsWith(TEMP_PREFIX))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    );
  };

  const remove = async (key: string): Promise<Result<void>> => {
    const ran = await run("deletefile", [remotePath(key)]);
    if (!ran.ok) return ran;
    const exit = classifyExit(ran.value.exitCode, ran.value.stderr.text);
    if (exit === "ok" || exit === "missing") return ok(undefined);
    return exitFailure(ran.value, "deletefile", `${key} could not be deleted`);
  };

  /**
   * One upload, ok only when rclone exited 0: rcat from stdin, or for an empty value (rcat refuses an empty stdin)
   * copyto from an empty file under rclone's cache folder.
   */
  const upload = async (target: string, key: string, data: Uint8Array): Promise<Result<void>> => {
    let command = "rcat";
    let ran: Result<RunOutcome>;
    if (data.length > 0) {
      ran = await run(command, ["--size", String(data.length), remotePath(target)], { stdin: data });
    } else {
      command = "copyto";
      const empty = join(cacheDir, "empty");
      try {
        await host.fs.mkdirp(cacheDir);
        await host.fs.writeBytesDurable(empty, new Uint8Array());
      } catch (error) {
        return failed(`${key} could not be written: ${empty} could not be made`, systemErrorCode(error));
      }
      ran = await run(command, ["--ignore-times", empty, remotePath(target)]);
    }
    if (!ran.ok) return ran;
    if (ran.value.exitCode === 0) return ok(undefined);
    return exitFailure(ran.value, command, `${key} could not be written`);
  };

  const put = async (key: string, data: Uint8Array): Promise<Result<{ etag?: string }>> => {
    if (publication === "atomic-put") {
      const written = await upload(key, key, data);
      return written.ok ? ok({}) : written;
    }
    const temp = `${TEMP_PREFIX}${op}-${ulid(host.clock.now().getTime())}`;
    const uploaded = await upload(temp, key, data);
    if (!uploaded.ok) {
      await remove(temp); // as far as it can: what is left is swept by age
      return uploaded;
    }
    host.faultAt("rclone.put.uploaded");
    // --no-check-dest: the move is the backend's rename onto the key, with no look at the key first (which would
    // delete a key that is there before moving, leaving a moment with no key at all).
    const moved = await run("moveto", ["--no-check-dest", remotePath(temp), remotePath(key)]);
    const failure = !moved.ok
      ? moved
      : moved.value.exitCode === 0
        ? undefined
        : exitFailure(moved.value, "moveto", `${key} could not be written`);
    if (failure !== undefined) {
      await remove(temp);
      return failure;
    }
    host.faultAt("rclone.put.moved");
    return ok({});
  };

  const getMany = async (keys: readonly string[]): Promise<Result<Map<string, Uint8Array>>> => {
    const got = new Map<string, Uint8Array>();
    const batch = [...new Set(keys)].filter((key) => !/[\r\n]/.test(key));
    for (const key of new Set(keys)) {
      if (!/[\r\n]/.test(key)) continue;
      const one = await get(key);
      if (!one.ok) return one;
      if (one.value !== null) got.set(key, one.value);
    }
    if (batch.length === 0) return ok(got);
    const folder = join(cacheDir, "get", ulid(host.clock.now().getTime()));
    try {
      await host.fs.mkdirp(join(cacheDir, "get"));
      await host.fs.mkdir(folder);
    } catch (error) {
      return failed(`a temporary folder could not be made at ${folder}`, `${systemErrorCode(error)}`);
    }
    const ran = await run("copy", ["--files-from-raw", "-", "--no-traverse", remotePath(""), folder], {
      stdin: `${batch.join("\n")}\n`,
    });
    let result: Result<Map<string, Uint8Array>> | undefined;
    if (!ran.ok) result = ran;
    else {
      const exit = classifyExit(ran.value.exitCode, ran.value.stderr.text);
      if (exit !== "ok" && exit !== "missing")
        result = exitFailure(ran.value, "copy", `${batch.length} keys could not be read`);
    }
    // Every copy is read, then unlinked by name, so the folder the guarded delete then removes holds no store files.
    for (const key of batch) {
      const file = join(folder, ...key.split("/"));
      try {
        const bytes = await host.fs.readBytes(file);
        if (result === undefined) got.set(key, bytes);
        await host.fs.unlink(file);
      } catch (error) {
        const code = systemErrorCode(error);
        if (code !== "ENOENT" && result === undefined)
          result = failed(`${key} could not be read from its copy at ${file}`, code);
      }
    }
    const guarded = await deleteGuard({ io: host, paths, env: options.env }, folder);
    if (!guarded.ok) return result ?? guarded;
    try {
      await host.fs.removeTree(folder);
    } catch (error) {
      if (result === undefined)
        result = failed(`its temporary folder ${folder} could not be removed`, errorCode(error) ?? "");
    }
    return result ?? ok(got);
  };

  const sweepTemporaries = async (olderThanMs: number): Promise<Result<{ swept: string[] }>> => {
    const listed = await listUnder(TEMP_PREFIX.slice(0, -1));
    if (!listed.ok) return listed;
    const now = host.clock.now().getTime();
    const swept: string[] = [];
    for (const { key } of listed.value.sort((a, b) => (a.key < b.key ? -1 : 1))) {
      const name = /^[^/]+$/.test(key.slice(TEMP_PREFIX.length))
        ? TEMP_NAME.exec(key.slice(TEMP_PREFIX.length))
        : null;
      if (name === null) continue; // not one of this adapter's temporaries
      if (now - ulidTime(name[1] as string) < olderThanMs) continue;
      const removed = await remove(key);
      if (!removed.ok) return removed;
      swept.push(key);
    }
    return ok({ swept });
  };

  /** Callers never write or delete under the temporaries' prefix: only put and the sweep do. */
  const assertCallerKey = (key: string): void => {
    assertBlobKey(key);
    if (key.startsWith(TEMP_PREFIX))
      throw new RangeError(`${key} is under ${TEMP_PREFIX}, the rclone store's own`);
  };

  // Keys are checked before anything is awaited, so a bad key throws at the call (a bug), not as a rejection.
  return {
    semantics: () => semantics,
    capabilities: () => capabilitiesOf(semantics),
    get: (key) => {
      assertBlobKey(key);
      return get(key);
    },
    put: (key, data, opts: PutOptions = {}) => {
      assertCallerKey(key);
      if (opts.ifNotExists || opts.ifMatch !== undefined)
        throw new Error("blob-rclone offers no conditional writes; check capabilities() first");
      return put(key, data);
    },
    list: (prefix) => {
      assertBlobPrefix(prefix);
      return list(prefix);
    },
    stat: (key) => {
      assertBlobKey(key);
      return stat(key);
    },
    delete: (key) => {
      assertCallerKey(key);
      return remove(key);
    },
    getMany: (keys) => {
      for (const key of keys) assertBlobKey(key);
      return getMany(keys);
    },
    sweepTemporaries: (olderThanMs) => sweepTemporaries(olderThanMs),
  };
};

/** rclone's JSON output, or undefined when it is not JSON. */
const parseJson = (bytes: Uint8Array | undefined): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(bytes ?? new Uint8Array()));
  } catch {
    return undefined;
  }
};
