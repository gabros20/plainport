// The macOS answers to core's preflight checks (core's ports/checks.ts; DESIGN.md "Edge cases → macOS and the
// environment"). Every child runs through the one runner with an explicit env, in capture mode: a listing that
// cannot be read whole fails the check, never passes it.
//
// - Processes: one `lsof -F` listing of every process this user may see (a few MB, under a second), filtered to
//   paths under the folder's real path, since lsof names files by their real path (/private/var, not /var).
//   lsof escapes bytes in names (\xNN, \t, ^A, \\), so the folder is escaped the same way and matched as lsof
//   prints it. Only exit 0 counts as a whole listing: lsof exits 1 for any error, also one -w keeps quiet.
//   plainport itself and its own lsof are left out; its ancestors (the shell or agent that started it) are marked.
// - Placeholders: `find -flags +dataless`. The flag is SF_DATALESS (0x40000000 in st_flags), which iCloud Drive and
//   other File Provider clients set on files and folders whose data is not on this disk; find reads it with
//   lstat, which does not download anything. Checked on real APFS against evicted iCloud Drive files (they list,
//   and `ls -lO` shows "dataless"); a test cannot make one, since chflags will not set the flag, so the tests run
//   find on an ordinary folder and feed it recorded output. -prune keeps find out of a dataless folder: listing one
//   would download it. find is given the folder's real path, so a symlinked folder is searched where the walk goes.
// - Docker: `docker ps` then `docker inspect` for bind mounts of the folder, of something inside it, or of a folder
//   holding it. Only two answers are not findings, since nothing can mount the folder then: no docker CLI on PATH
//   or in the folders the engines install it in (~/.docker/bin, ~/.orbstack/bin, /usr/local/bin,
//   /opt/homebrew/bin) and no daemon socket at any known place (DOCKER_HOST, /var/run/docker.sock,
//   ~/.docker/run/docker.sock, ~/.orbstack/run/docker.sock); and a daemon that is clearly not there (its socket
//   missing or refusing connections). Any other failure blocks under env.docker-mount, as lsof's and find's do
//   under their own codes: an unchecked folder is not safe. That includes a PATH entry that cannot be searched, a
//   docker that is there but not executable, and a socket with no CLI to ask, since containers may be running with
//   mounts either way. Docker Desktop reports a bind mount's source as the path inside its VM, /host_mnt/<host
//   path>; OrbStack and colima report the host path. Both spellings are compared.
//
// Each check first resolves the folder's real path, since lsof, find and docker name files by it; a folder whose
// real path cannot be found is not checked, and blocks under the check's own code.

import { isAbsolute, join, relative, resolve } from "node:path";
import { decode, type Failure, fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import {
  type CheckContext,
  capturedOutput,
  type DockerMounts,
  errorCode,
  type HostChecks,
  type HostPorts,
  type ProcessUse,
  type RunOutcome,
  splitRecords,
} from "@plainport/core";
import { z } from "zod";
import { PATH_REFUSED } from "./guard.ts";

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const LSOF = "/usr/sbin/lsof";
// BSD find: GNU find, which a PATH may put first, has no -flags.
const FIND = "/usr/bin/find";
const CAPTURE_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 50;
const DOCKER_ENV = [
  "PATH",
  "HOME",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
];
/** Where the engines install the CLI without touching PATH (Docker Desktop, OrbStack) or Homebrew puts it. */
const DOCKER_CLI_FOLDERS = (home: string | undefined): string[] => [
  ...(home === undefined ? [] : [join(home, ".docker", "bin"), join(home, ".orbstack", "bin")]),
  "/usr/local/bin",
  "/opt/homebrew/bin",
];
/** Where a daemon's socket shows up, besides DOCKER_HOST. */
const DOCKER_SOCKETS = (home: string | undefined): string[] => [
  "/var/run/docker.sock",
  ...(home === undefined
    ? []
    : [join(home, ".docker", "run", "docker.sock"), join(home, ".orbstack", "run", "docker.sock")]),
];
/** Docker Desktop's VM mounts the host's file system here, and names bind sources below it. */
const HOST_MNT = "/host_mnt";

/** A bind source's spellings on the host: as reported, and with an engine's VM prefix removed. */
const hostSpellings = (source: string): string[] =>
  source.startsWith(`${HOST_MNT}/`)
    ? [resolve(source), resolve(source.slice(HOST_MNT.length))]
    : [resolve(source)];

const lastLines = (outcome: RunOutcome): string =>
  (outcome.stderr.text.trim() || outcome.stdout.text.trim()).split("\n").slice(-3).join(" / ");

const under = (roots: readonly string[], path: string): boolean =>
  roots.some((root) => path === root || path.startsWith(root === "/" ? root : `${root}/`));

type CheckCode = "proc.open-files" | "fs.dataless" | "env.docker-mount";

/**
 * The folder as given and with symlinks resolved, the real one last: tools report one spelling or the other. A
 * folder whose real path cannot be found cannot be matched against what they report, so the check fails.
 */
const spellings = async (host: HostPorts, dir: string, code: CheckCode): Promise<Result<string[]>> => {
  const given = resolve(dir);
  try {
    const real = await host.fs.realpath(given);
    return ok(real === given ? [given] : [given, real]);
  } catch (error) {
    if (errorCode(error) === PATH_REFUSED) throw error;
    return fail(
      finding(code, {
        message: `could not find the real path of ${dir}, so it was not checked: ${error instanceof Error ? error.message : String(error)}`,
        paths: [dir],
        fix: `make every folder on the way to it searchable (chmod u+x), or give the path as the file system spells it; then re-run`,
      }),
    );
  }
};

const LSOF_NAMED: Readonly<Record<number, string>> = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };

/** A path as lsof prints it in the C locale: printable ASCII as is, a backslash doubled, \b \t \n \f \r, other
 * control bytes as ^X, and DEL and every byte above it as \xNN. */
export const lsofName = (path: string): string => {
  let out = "";
  for (const byte of new TextEncoder().encode(path)) {
    if (byte === 0x5c) out += "\\\\";
    else if (LSOF_NAMED[byte] !== undefined) out += LSOF_NAMED[byte];
    else if (byte < 0x20) out += `^${String.fromCharCode(byte + 0x40)}`;
    else if (byte >= 0x7f) out += `\\x${byte.toString(16).padStart(2, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return out;
};

/** Undoes lsofName for the part of a name below a known folder. lsof prints a caret as itself, so ^X (X from @ to
 * _) is read as the control character it encodes: a name holding a literal caret before one of those characters
 * comes back wrong, and only for messages, since matching is done on lsof's own spelling. */
const fromLsofName = (name: string): string => {
  const bytes: number[] = [];
  const named: Readonly<Record<string, number>> = { b: 8, t: 9, n: 10, f: 12, r: 13, "\\": 0x5c };
  for (let i = 0; i < name.length; i++) {
    const char = name[i] as string;
    const next = name[i + 1];
    if (char === "\\" && next === "x" && /^[0-9a-f]{2}$/.test(name.slice(i + 2, i + 4))) {
      bytes.push(Number.parseInt(name.slice(i + 2, i + 4), 16));
      i += 3;
    } else if (char === "\\" && next !== undefined && named[next] !== undefined) {
      bytes.push(named[next] as number);
      i += 1;
    } else if (char === "^" && next !== undefined && next >= "@" && next <= "_") {
      bytes.push(next.charCodeAt(0) - 0x40);
      i += 1;
    } else bytes.push(...new TextEncoder().encode(char));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};

/**
 * Reads `lsof -F pcRfn` output: the processes with their working directory or an open file under one of the roots,
 * except `self` and the lsof it started. A process is an ancestor when it is on self's parent chain.
 */
export const parseLsof = (text: string, roots: readonly string[], self: number): ProcessUse[] => {
  interface Seen {
    pid: number;
    ppid: number;
    command: string;
    cwd: boolean;
    files: string[];
    fileCount: number;
  }
  // Each root as lsof prints it, with the root itself to rebuild a file's real path.
  const printed = roots.map((root) => ({ root, name: lsofName(root) }));
  const placed = (name: string): string | undefined => {
    for (const { root, name: prefix } of printed) {
      if (name === prefix) return root;
      if (name.startsWith(prefix === "/" ? prefix : `${prefix}/`))
        return root + fromLsofName(name.slice(prefix.length));
    }
    return undefined;
  };
  const all: Seen[] = [];
  let current: Seen | undefined;
  let fd = "";
  for (const line of text.split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      current = { pid: Number(value), ppid: 0, command: "", cwd: false, files: [], fileCount: 0 };
      all.push(current);
    } else if (current === undefined) continue;
    else if (field === "R") current.ppid = Number(value);
    else if (field === "c") current.command = value;
    else if (field === "f") fd = value;
    else if (field === "n") {
      const path = placed(value);
      if (path === undefined) continue;
      if (fd === "cwd") current.cwd = true;
      else {
        current.fileCount++;
        if (current.files.length < MAX_FILES) current.files.push(path);
      }
    }
  }
  const parent = new Map(all.map((p) => [p.pid, p.ppid]));
  const ancestors = new Set<number>();
  for (let pid = parent.get(self); pid !== undefined && pid > 1 && !ancestors.has(pid); pid = parent.get(pid))
    ancestors.add(pid);
  return all
    .filter((p) => p.pid !== self && !(p.ppid === self && p.command === "lsof"))
    .filter((p) => p.cwd || p.fileCount > 0)
    .map(({ pid, ppid, command, cwd, files, fileCount }) => ({
      pid,
      ppid,
      command,
      ancestor: ancestors.has(pid),
      cwd,
      files,
      fileCount,
    }));
};

const InspectSchema = z.array(
  z.looseObject({
    Id: z.string(),
    Name: z.string(),
    Mounts: z.array(z.looseObject({ Type: z.string(), Source: z.string() })).nullable(),
  }),
);

/** Docker's CLI could not reach a daemon because none is there: the socket is missing or refuses connections. */
export const daemonDown = (stderr: string): boolean =>
  /cannot connect to the docker daemon|failed to connect to the docker api/i.test(stderr) &&
  !/permission denied/i.test(stderr) &&
  /connect: no such file or directory|connect: connection refused/i.test(stderr);

export const createMacosChecks = (host: HostPorts): HostChecks => {
  const capture = (command: string, args: string[], env: Record<string, string>, ctx: CheckContext) =>
    host.run({
      command,
      args,
      cwd: "/",
      env,
      capture: { maxBytes: CAPTURE_BYTES },
      idleTimeoutMs: 60_000,
      timeoutMs: 300_000,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
  const decoder = new TextDecoder();
  /** A runner failure (timeout, spawn, unreadable output) as the check's own blocker; a cancellation stays one. */
  const asCheck =
    (code: CheckCode, what: string, dir: string) =>
    (failure: Failure): Failure =>
      failure.exitCode === 130
        ? failure
        : fail(
            finding(code, {
              message: `could not ${what}: ${failure.finding.message}`,
              paths: [dir],
              fix: failure.finding.fix ?? "re-run; if it keeps failing, fix the cause the message names",
            }),
          );

  return {
    processesUsing: async (dir, ctx) => {
      const spelled = await spellings(host, dir, "proc.open-files");
      if (!spelled.ok) return spelled;
      const roots = spelled.value;
      const ran = await capture(
        LSOF,
        ["-n", "-P", "-w", "-F", "pcRfn"],
        { PATH: SYSTEM_PATH, LC_ALL: "C" },
        ctx,
      );
      if (!ran.ok) return asCheck("proc.open-files", `list the processes using ${dir}`, dir)(ran);
      const bytes = capturedOutput(ran.value, (outcome) =>
        fail(
          finding("proc.open-files", {
            message: `could not list the processes using ${dir}: lsof failed with exit code ${outcome.exitCode}: ${lastLines(outcome)}`,
            paths: [dir],
            fix: "re-run; if lsof keeps failing, check that /usr/sbin/lsof runs",
          }),
        ),
      );
      if (!bytes.ok) return bytes;
      const uses = parseLsof(decoder.decode(bytes.value), roots, host.proc.pid);
      // git's fsmonitor daemon is exempt from the blockers, and lsof names only its command (git): read the
      // command line of each git using the folder, so preflight can tell the daemon from any other git. (lsof
      // shows the daemon holding the folder it watches; its socket appears under a relative name.)
      const candidates = uses.filter((p) => p.command === "git");
      if (candidates.length > 0) {
        const ps = await capture(
          "/bin/ps",
          ["-ww", "-o", "pid=,args=", "-p", candidates.map((p) => p.pid).join(",")],
          { PATH: SYSTEM_PATH, LC_ALL: "C" },
          ctx,
        );
        if (!ps.ok && ps.exitCode === 130) return ps;
        // ps exits 1 when one of them has gone: it still lists the rest. Without a command line, a git process
        // is not taken for the daemon, so a failure here can only block, never exempt.
        if (ps.ok && ps.value.captured !== undefined) {
          for (const line of decoder.decode(ps.value.captured).split("\n")) {
            const match = /^\s*(\d+)\s+(.*)$/.exec(line);
            const use = match && candidates.find((p) => p.pid === Number(match[1]));
            if (use && match) use.args = match[2] as string;
          }
        }
      }
      return ok(uses);
    },

    dataless: async (dir, ctx) => {
      const spelled = await spellings(host, dir, "fs.dataless");
      if (!spelled.ok) return spelled;
      const top = spelled.value.at(-1) as string;
      const ran = await capture(
        FIND,
        [top, "-flags", "+dataless", "-print0", "-prune"],
        { PATH: SYSTEM_PATH, LC_ALL: "C" },
        ctx,
      );
      if (!ran.ok) return asCheck("fs.dataless", `check ${dir} for placeholder files`, dir)(ran);
      const outcome = ran.value;
      const below = (path: string): string => {
        const rel = relative(top, path);
        return rel === "" ? "." : rel;
      };
      // Folders find may not enter are named, so preflight blocks on them itself (fs.unreadable): what they hold
      // is unknown. Only such lines are tolerated, and only when stderr was read whole; anything else means the
      // folder was not checked.
      const denied = outcome.stderr.text
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => /^find: (.+): Permission denied$/.exec(line)?.[1]);
      const deniedOnly =
        outcome.exitCode === 1 &&
        outcome.signal === null &&
        outcome.stderr.droppedBytes === 0 &&
        denied.length > 0 &&
        denied.every((path) => path !== undefined);
      const bytes = deniedOnly
        ? ok(outcome.captured ?? new Uint8Array())
        : capturedOutput(outcome, (failed) =>
            fail(
              finding("fs.dataless", {
                message: `could not check ${dir} for placeholder files: find failed with exit code ${failed.exitCode}: ${lastLines(failed)}`,
                paths: [dir],
                fix: "re-run; if find keeps failing, check that /usr/bin/find runs",
              }),
            ),
          );
      if (!bytes.ok) return bytes;
      return ok({
        placeholders: splitRecords(bytes.value, 0)
          .map((record) => decoder.decode(record))
          .filter((path) => path !== "")
          .map(below),
        unsearchable: deniedOnly ? denied.map((path) => below(path as string)) : [],
      });
    },

    dockerMounts: async (dir, ctx) => {
      const env: Record<string, string> = { LC_ALL: "C" };
      for (const name of DOCKER_ENV) {
        const value = ctx.env[name];
        if (value !== undefined) env[name] = value;
      }
      const unavailable = (reason: string): Result<DockerMounts> => ok({ available: false, reason });
      const notChecked = (what: string, outcome: RunOutcome): Failure =>
        fail(
          finding("env.docker-mount", {
            message: `could not check which containers mount ${dir}: ${what} failed with exit code ${outcome.exitCode}: ${lastLines(outcome)}`,
            paths: [dir],
            fix: "check that docker works (docker ps), or stop docker, then re-run",
          }),
        );

      const spelled = await spellings(host, dir, "env.docker-mount");
      if (!spelled.ok) return spelled;
      const roots = spelled.value;
      const notKnown = (message: string, fix: string): Failure =>
        fail(finding("env.docker-mount", { message, paths: [dir], fix }));

      // Docker is "not installed" only when every PATH entry and every folder an engine installs the CLI in was
      // looked in, none holds a docker, and no daemon socket is there. An entry that cannot be searched, or a
      // docker that cannot be run, leaves the question open, and a daemon may be running. An empty or relative
      // PATH entry means the working directory, which is / for every child here.
      let docker: string | undefined;
      const folders = [...new Set([...(env.PATH ?? "").split(":"), ...DOCKER_CLI_FOLDERS(env.HOME)])];
      for (const entry of folders) {
        const folder = resolve("/", entry);
        const candidate = join(folder, "docker");
        let kind: string;
        try {
          kind = (await host.fs.stat(candidate)).kind;
        } catch (error) {
          const code = errorCode(error);
          if (code === "ENOENT" || code === "ENOTDIR") continue;
          if (code === PATH_REFUSED) throw error;
          return notKnown(
            `could not tell whether docker is installed: ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
            `make ${shellWord(folder)} searchable (chmod u+x ${shellWord(folder)}) or take it off PATH, then re-run`,
          );
        }
        // A folder or a special file named docker is not the CLI; a shell would skip it too.
        if (kind !== "file") continue;
        if (!(await host.fs.executable(candidate))) {
          return notKnown(
            `docker is installed at ${candidate} but cannot be run by this user, so its containers were not checked`,
            `chmod u+x ${shellWord(candidate)}, or take ${shellWord(folder)} off PATH; then re-run`,
          );
        }
        docker = candidate;
        break;
      }
      if (docker === undefined) {
        // No CLI anywhere known: a daemon socket would still mean containers may be running, unchecked.
        const fromHost = /^unix:\/\/(\/.+)$/.exec(env.DOCKER_HOST ?? "")?.[1];
        for (const socket of [...(fromHost === undefined ? [] : [fromHost]), ...DOCKER_SOCKETS(env.HOME)]) {
          try {
            await host.fs.stat(socket);
          } catch (error) {
            const code = errorCode(error);
            if (code === "ENOENT" || code === "ENOTDIR") continue;
            if (code === PATH_REFUSED) throw error;
            return notKnown(
              `could not tell whether a docker daemon is running: ${socket}: ${error instanceof Error ? error.message : String(error)}`,
              "make the socket's folder searchable, or stop docker; then re-run",
            );
          }
          return notKnown(
            `a docker daemon socket exists at ${socket}, but no docker command was found on PATH or in ${DOCKER_CLI_FOLDERS(env.HOME).join(", ")}, so its containers were not checked`,
            "add the docker CLI's folder to PATH (Docker Desktop: ~/.docker/bin; OrbStack: ~/.orbstack/bin; Homebrew: /opt/homebrew/bin), or stop the docker daemon; then re-run",
          );
        }
        return unavailable("docker is not installed");
      }
      const checkFailed = asCheck("env.docker-mount", `check which containers mount ${dir}`, dir);

      const listed = await capture(docker, ["ps", "--quiet", "--no-trunc"], env, ctx);
      if (!listed.ok) return checkFailed(listed);
      if (listed.value.exitCode !== 0 && daemonDown(listed.value.stderr.text))
        return unavailable("docker is not running");
      const ids = capturedOutput(listed.value, (outcome) => notChecked("docker ps", outcome));
      if (!ids.ok) return ids;
      const containers = decoder
        .decode(ids.value)
        .split("\n")
        .map((id) => id.trim())
        .filter((id) => id !== "");
      if (containers.length === 0) return ok({ available: true, mounts: [] });

      const inspected = await capture(docker, ["inspect", ...containers], env, ctx);
      if (!inspected.ok) return checkFailed(inspected);
      const outcome = inspected.value;
      // A container that stopped since `docker ps` is "No such object"; the rest are still described.
      const vanishedOnly =
        outcome.exitCode === 1 &&
        outcome.signal === null &&
        outcome.stderr.droppedBytes === 0 &&
        outcome.stderr.text
          .trim()
          .split("\n")
          .every((line) => /no such object/i.test(line));
      const bytes = vanishedOnly
        ? ok(outcome.captured ?? new Uint8Array())
        : capturedOutput(outcome, (o) => notChecked("docker inspect", o));
      if (!bytes.ok) return bytes;
      let json: unknown;
      try {
        json = JSON.parse(decoder.decode(bytes.value) || "[]");
      } catch (error) {
        return fail(
          finding("env.docker-mount", {
            message: `could not read docker inspect's output for ${dir}: ${error instanceof Error ? error.message : String(error)}`,
            paths: [dir],
            fix: "check that docker works (docker inspect), then re-run",
          }),
        );
      }
      const described = decode(InspectSchema, json, "docker inspect's output");
      if (!described.ok) {
        return fail(
          finding("env.docker-mount", {
            message: `could not check which containers mount ${dir}: ${described.finding.message}`,
            paths: [dir],
            fix: "check that this docker CLI works (docker inspect on a running container), then re-run",
          }),
        );
      }

      const mounts: { container: string; name: string; source: string }[] = [];
      for (const container of described.value) {
        for (const mount of container.Mounts ?? []) {
          if (mount.Type !== "bind" || !isAbsolute(mount.Source)) continue;
          // As the engine spells it, as the host would, and each with symlinks resolved.
          const sources = hostSpellings(mount.Source);
          for (const spelled of [...sources]) {
            try {
              sources.push(await host.fs.realpath(spelled));
            } catch {
              // Gone, or not on this disk: its spelling is all there is.
            }
          }
          // The folder itself, something inside it, or a folder that holds it: each reaches the project's files.
          if (
            sources.some(
              (source) =>
                under(roots, source) ||
                under([source], roots[0] as string) ||
                under([source], roots.at(-1) as string),
            )
          ) {
            mounts.push({
              container: container.Id,
              name: container.Name.replace(/^\//, ""),
              source: mount.Source,
            });
          }
        }
      }
      return ok({ available: true, mounts });
    },
  };
};
