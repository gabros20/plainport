// `bun scripts/fetch-tools.ts`: downloads the restic and rclone that tools.lock.json pins (ADR-0006) into
// .tools/<os>-<arch>/, where packages/core's toolPath finds them for development and tests. Flags: --target
// <os>-<arch> or --target all (default: this machine), --dest <dir> (default: .tools in the checkout).
// `--restic <version>` fetches only that restic, from the lock's `matrix` section or the pin, into
// .tools/matrix/restic-<version>/<os>-<arch>/ (default --dest), for CI's restic version matrix (ADR-0021); the
// suites find it through PLAINPORT_RESTIC_MATRIX (test/tiers.ts). A version the lock does not list is refused.
//
// Every archive for every requested target is hashed in memory and checked against the lock before anything is
// written, so a checksum mismatch or failed download anywhere leaves no file behind. Archives are then unpacked
// with the system's bunzip2 (restic ships .bz2) and unzip (rclone ships .zip) into one temp folder beside the
// destination; if any fails to unpack, nothing is installed. Finally the binaries are renamed into place one by
// one, each followed by its `.<name>.pin` file. That last pass has no rollback: if it fails partway, the binaries
// already moved stay, and the next run re-fetches any tool whose pin is missing or stale. A second run skips tools
// that are still intact and executable. Scripts may spawn directly and validate their own dev-only files by hand
// (run decisions D8 and D10).

import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { hostTarget, TARGETS, type Target, TOOL_NAMES, type ToolName } from "../packages/core/src/tools.ts";

export type LockTarget = { url: string; sha256: string; member?: string };
export type LockTool = {
  version: string;
  /** The official release checksum file the sums were taken from. */
  checksums: string;
  format: "bz2" | "zip";
  targets: Record<Target, LockTarget>;
};
/** `matrix.restic`: the other restic versions CI tests the engine with; never bundled or used by plainport. */
export type Lock = { tools: Record<ToolName, LockTool>; matrix: { restic: LockTool[] } };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isHttps = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("https://");

const parseTool = (
  where: string,
  tool: unknown,
): { ok: true; tool: LockTool } | { ok: false; message: string } => {
  const fail = (message: string) => ({ ok: false as const, message: `tools.lock.json: ${message}` });
  if (!isRecord(tool)) return fail(`${where} is missing`);
  const { version, checksums, format, targets } = tool;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
    return fail(`${where}.version must be X.Y.Z`);
  if (!isHttps(checksums)) return fail(`${where}.checksums must be an https:// url`);
  if (format !== "bz2" && format !== "zip") return fail(`${where}.format must be bz2 or zip`);
  if (!isRecord(targets)) return fail(`${where}.targets is missing`);
  const parsed = {} as Record<Target, LockTarget>;
  for (const target of TARGETS) {
    const entry = targets[target];
    const at = `${where}.targets.${target}`;
    if (!isRecord(entry)) return fail(`${at} is missing`);
    if (!isHttps(entry.url)) return fail(`${at}.url must be an https:// url`);
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      return fail(`${at}.sha256 must be 64 lowercase hex digits`);
    }
    if (format === "zip" && typeof entry.member !== "string")
      return fail(`${at}.member names the binary in the zip`);
    parsed[target] = { url: entry.url, sha256: entry.sha256 };
    if (typeof entry.member === "string") parsed[target].member = entry.member;
  }
  return { ok: true, tool: { version, checksums, format, targets: parsed } };
};

export const parseLock = (raw: unknown): { ok: true; lock: Lock } | { ok: false; message: string } => {
  const fail = (message: string) => ({ ok: false as const, message: `tools.lock.json: ${message}` });
  if (!isRecord(raw) || !isRecord(raw.tools)) return fail("expected an object with a `tools` object");
  const tools = {} as Record<ToolName, LockTool>;
  for (const name of TOOL_NAMES) {
    const parsed = parseTool(name, raw.tools[name]);
    if (!parsed.ok) return parsed;
    tools[name] = parsed.tool;
  }
  const matrix: Lock["matrix"] = { restic: [] };
  if (raw.matrix !== undefined) {
    if (!isRecord(raw.matrix) || !Array.isArray(raw.matrix.restic)) {
      return fail("matrix must be an object with a `restic` list");
    }
    for (const [index, entry] of raw.matrix.restic.entries()) {
      const parsed = parseTool(`matrix.restic[${index}]`, entry);
      if (!parsed.ok) return parsed;
      matrix.restic.push(parsed.tool);
    }
  }
  return { ok: true, lock: { tools, matrix } };
};

/** The restic of one version for the restic matrix: a `matrix` entry, or the pinned restic itself. */
export const resticForMatrix = (lock: Lock, version: string): LockTool | undefined =>
  lock.tools.restic.version === version
    ? lock.tools.restic
    : lock.matrix.restic.find((entry) => entry.version === version);

export type Fetcher = (url: string) => Promise<Uint8Array>;

export const httpsFetcher: Fetcher = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
};

export type FetchedTool = {
  name: ToolName;
  target: Target;
  version: string;
  path: string;
  status: "installed" | "current";
};
export type FetchResult =
  | { ok: true; tools: FetchedTool[] }
  | {
      ok: false;
      code: "tool.checksum_mismatch" | "tool.download_failed" | "tool.extract_failed";
      message: string;
    };

type Pin = { version: string; archiveSha256: string; binarySha256: string };

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const readPin = (path: string): Pin | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Pin;
  } catch {
    return undefined;
  }
};

const isCurrent = (binary: string, pin: Pin | undefined, version: string, archiveSha256: string): boolean => {
  if (pin?.version !== version || pin.archiveSha256 !== archiveSha256) return false;
  try {
    if (!statSync(binary).isFile()) return false;
    accessSync(binary, constants.X_OK);
    return sha256(readFileSync(binary)) === pin.binarySha256;
  } catch {
    return false;
  }
};

/**
 * Whether the tools in one target folder (`.tools/<os>-<arch>/`) are the ones the lock pins: each pin names the
 * lock's version and archive, and the binary still hashes to the pin. One line per tool that is not; scripts/install
 * checks this before it bundles them.
 */
export const pinnedProblems = (folder: string, lock: Lock, target: Target): string[] =>
  TOOL_NAMES.flatMap((name) => {
    const tool = lock.tools[name];
    const pin = readPin(join(folder, `.${name}.pin`));
    return isCurrent(join(folder, name), pin, tool.version, tool.targets[target].sha256)
      ? []
      : [`${name} in ${folder} is not the ${tool.version} tools.lock.json pins`];
  });

// Unpacks the binary from a verified archive into `out`. Returns an error message, or undefined on success.
const unpack = (
  format: LockTool["format"],
  archive: string,
  out: string,
  member?: string,
): string | undefined => {
  const command = format === "bz2" ? ["bunzip2", "-c", archive] : ["unzip", "-p", archive, member ?? ""];
  try {
    const child = Bun.spawnSync(command, { stdout: Bun.file(out), stderr: "pipe" });
    if (child.exitCode !== 0) {
      return `${command[0]} exited ${child.exitCode}: ${child.stderr.toString().trim()}`;
    }
  } catch (error) {
    return `${command[0]} could not run: ${(error as Error).message}`;
  }
  if (statSync(out).size === 0) return `${command[0]} produced an empty file`;
  return undefined;
};

type Pending = FetchedTool & { tool: LockTool; entry: LockTarget; bytes: Uint8Array; pinPath: string };

/**
 * Installs the pinned tools for the given targets in three passes. 1: download every archive that isn't already
 * installed and check it against the lock in memory; a mismatch or download failure returns before anything is
 * written. 2: unpack them all into one temp folder; an unpack failure returns with nothing installed. 3: rename
 * each binary into place and write its pin; this pass is not rolled back if it throws partway.
 */
export const fetchTools = async (options: {
  lock: Lock;
  targets: Target[];
  destRoot: string;
  fetcher?: Fetcher;
  /** Fetch only these tools, at these versions (the restic matrix), instead of every tool the lock pins. */
  only?: Partial<Record<ToolName, LockTool | undefined>>;
}): Promise<FetchResult> => {
  const { lock, targets, destRoot, fetcher = httpsFetcher, only } = options;
  const tools: FetchedTool[] = [];
  const pending: Pending[] = [];
  const selected = TOOL_NAMES.flatMap((name): [ToolName, LockTool][] => {
    if (only === undefined) return [[name, lock.tools[name]]];
    const tool = only[name];
    return tool === undefined ? [] : [[name, tool]];
  });

  for (const target of targets) {
    for (const [name, tool] of selected) {
      const entry = tool.targets[target];
      const path = join(destRoot, target, name);
      const pinPath = join(destRoot, target, `.${name}.pin`);
      if (isCurrent(path, readPin(pinPath), tool.version, entry.sha256)) {
        tools.push({ name, target, version: tool.version, path, status: "current" });
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await fetcher(entry.url);
      } catch (error) {
        return {
          ok: false,
          code: "tool.download_failed",
          message: `${name} ${target}: ${entry.url}: ${(error as Error).message}. Nothing was written.`,
        };
      }
      const actual = sha256(bytes);
      if (actual !== entry.sha256) {
        return {
          ok: false,
          code: "tool.checksum_mismatch",
          message:
            `${name} ${target}: ${entry.url} has SHA-256 ${actual}, but tools.lock.json pins ${entry.sha256}. ` +
            "Nothing was written. Check the url and the sum against the project's official SHA256SUMS.",
        };
      }
      const fetched: FetchedTool = { name, target, version: tool.version, path, status: "installed" };
      tools.push(fetched);
      pending.push({ ...fetched, tool, entry, bytes, pinPath });
    }
  }
  if (pending.length === 0) return { ok: true, tools };

  const created = mkdirSync(destRoot, { recursive: true });
  const work = mkdtempSync(join(destRoot, ".fetch-"));
  try {
    for (const [index, item] of pending.entries()) {
      const archive = join(work, `${index}.archive`);
      const out = join(work, `${index}.bin`);
      writeFileSync(archive, item.bytes);
      const failure = unpack(item.tool.format, archive, out, item.entry.member);
      if (failure !== undefined) {
        if (created !== undefined) rmSync(created, { recursive: true, force: true });
        return {
          ok: false,
          code: "tool.extract_failed",
          message: `${item.name} ${item.target}: ${failure}. Nothing was installed.`,
        };
      }
      chmodSync(out, 0o755);
    }
    for (const [index, item] of pending.entries()) {
      const out = join(work, `${index}.bin`);
      const pin: Pin = {
        version: item.version,
        archiveSha256: item.entry.sha256,
        binarySha256: sha256(readFileSync(out)),
      };
      mkdirSync(join(destRoot, item.target), { recursive: true });
      renameSync(out, item.path);
      writeFileSync(item.pinPath, `${JSON.stringify(pin)}\n`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { ok: true, tools };
};

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { target: { type: "string" }, dest: { type: "string" }, restic: { type: "string" } },
  });
  function usage(message: string): never {
    console.error(`fetch-tools: ${message}`);
    process.exit(2);
  }

  const parsed = parseLock(JSON.parse(readFileSync(join(root, "tools.lock.json"), "utf8")));
  if (!parsed.ok) usage(parsed.message);
  const { lock } = parsed;

  let targets: Target[];
  if (values.target === "all") targets = [...TARGETS];
  else if (values.target !== undefined) {
    if (!(TARGETS as readonly string[]).includes(values.target)) {
      usage(`unknown --target ${values.target}; use one of ${TARGETS.join(", ")} or all`);
    }
    targets = [values.target as Target];
  } else {
    const host = hostTarget();
    if (host === undefined) usage(`no pinned tools for ${process.platform}-${process.arch}`);
    targets = [host];
  }
  let only: Partial<Record<ToolName, LockTool>> | undefined;
  if (values.restic !== undefined) {
    const restic = resticForMatrix(lock, values.restic);
    if (restic === undefined) {
      const listed = [...lock.matrix.restic.map((entry) => entry.version), lock.tools.restic.version];
      usage(`restic ${values.restic} is not in tools.lock.json; the matrix has ${listed.join(", ")}`);
    }
    only = { restic };
  }
  const destRoot = resolve(
    values.dest ??
      (values.restic === undefined
        ? join(root, ".tools")
        : join(root, ".tools", "matrix", `restic-${values.restic}`)),
  );

  const result = await fetchTools({ lock, targets, destRoot, ...(only === undefined ? {} : { only }) });
  if (!result.ok) {
    console.error(`fetch-tools: ${result.code}: ${result.message}`);
    process.exit(1);
  }
  for (const tool of result.tools) {
    const status = tool.status === "installed" ? "installed, SHA-256 matches the lock" : "already installed";
    console.log(`${tool.name} ${tool.version} ${tool.target}: ${status}: ${tool.path}`);
  }
}
