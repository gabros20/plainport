// The macOS answers to core's preflight checks (core's ports/checks.ts; DESIGN.md "Edge cases → macOS and the
// environment"). Every child runs through the one runner with an explicit env, in capture mode: a listing that
// cannot be read whole fails the check, never passes it.
//
// - Processes: one `lsof -F` listing of every process this user may see (a few MB, under a second), filtered to
//   paths under the folder's real path, since lsof names files by their real path (/private/var, not /var).
//   plainport itself and its own lsof are left out; its ancestors (the shell or agent that started it) are marked.
// - Placeholders: `find -flags +dataless`. The flag is SF_DATALESS (0x40000000 in st_flags), which iCloud Drive and
//   other File Provider clients set on files and folders whose data is not on this disk; find reads it with
//   lstat, which does not download anything. Checked on real APFS against evicted iCloud Drive files (they list,
//   and `ls -lO` shows "dataless"); a test cannot make one, since chflags will not set the flag, so the tests run
//   find on an ordinary folder and feed it recorded output. -prune keeps find out of a dataless folder: listing one
//   would download it.
// - Docker: `docker ps` then `docker inspect` for bind mounts. Docker missing or its daemon not running is not a
//   finding (nothing can mount the folder then); it is reported as unavailable.

import { isAbsolute, relative, resolve } from "node:path";
import { decode, type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import {
  type CheckContext,
  capturedOutput,
  type DockerMounts,
  type HostChecks,
  type HostPorts,
  type ProcessUse,
  type RunOutcome,
  splitRecords,
} from "@plainport/core";
import { z } from "zod";

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

const lastLines = (outcome: RunOutcome): string =>
  (outcome.stderr.text.trim() || outcome.stdout.text.trim()).split("\n").slice(-3).join(" / ");

const under = (roots: readonly string[], path: string): boolean =>
  roots.some((root) => path === root || path.startsWith(root === "/" ? root : `${root}/`));

/** The folder as given and with symlinks resolved: tools report one spelling or the other. */
const spellings = async (host: HostPorts, dir: string): Promise<string[]> => {
  const given = resolve(dir);
  try {
    const real = await host.fs.realpath(given);
    return real === given ? [given] : [given, real];
  } catch {
    return [given];
  }
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
    else if (field === "n" && under(roots, value)) {
      if (fd === "cwd") current.cwd = true;
      else {
        current.fileCount++;
        if (current.files.length < MAX_FILES) current.files.push(value);
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

const DAEMON_DOWN =
  /cannot connect to the docker daemon|is the docker daemon running|failed to connect to the docker api|error during connect/i;

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

  return {
    processesUsing: async (dir, ctx) => {
      const roots = await spellings(host, dir);
      const ran = await capture(
        LSOF,
        ["-n", "-P", "-w", "-F", "pcRfn"],
        { PATH: SYSTEM_PATH, LC_ALL: "C" },
        ctx,
      );
      if (!ran.ok) return ran;
      // lsof exits 1 when it found nothing to list or met an error it was told to keep quiet about (-w); only
      // stderr tells them apart.
      const quietOne =
        ran.value.exitCode === 1 && ran.value.stderr.text.trim() === "" && ran.value.signal === null;
      const bytes = quietOne
        ? ok(ran.value.captured ?? new Uint8Array())
        : capturedOutput(ran.value, (outcome) =>
            fail(
              finding("proc.open-files", {
                message: `could not list the processes using ${dir}: lsof failed with exit code ${outcome.exitCode}: ${lastLines(outcome)}`,
                paths: [dir],
                fix: "re-run; if lsof keeps failing, check that /usr/sbin/lsof runs",
              }),
            ),
          );
      if (!bytes.ok) return bytes;
      return ok(parseLsof(decoder.decode(bytes.value), roots, host.proc.pid));
    },

    dataless: async (dir, ctx) => {
      const [given] = await spellings(host, dir);
      const top = given as string;
      const ran = await capture(
        FIND,
        [top, "-flags", "+dataless", "-print0", "-prune"],
        { PATH: SYSTEM_PATH, LC_ALL: "C" },
        ctx,
      );
      if (!ran.ok) return ran;
      const outcome = ran.value;
      // Folders find may not enter are reported by the scan as fs.unreadable; anything else means not checked.
      const deniedOnly =
        outcome.exitCode === 1 &&
        outcome.signal === null &&
        outcome.stderr.droppedBytes === 0 &&
        outcome.stderr.text
          .trim()
          .split("\n")
          .every((line) => line.endsWith(": Permission denied"));
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
      return ok(
        splitRecords(bytes.value, 0)
          .map((record) => decoder.decode(record))
          .filter((path) => path !== "")
          .map((path) => {
            const rel = relative(top, path);
            return rel === "" ? "." : rel;
          }),
      );
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

      const listed = await capture("docker", ["ps", "--quiet", "--no-trunc"], env, ctx);
      if (!listed.ok) {
        return listed.finding.code === "process.spawn-failed"
          ? unavailable("docker is not installed")
          : listed;
      }
      if (listed.value.exitCode !== 0 && DAEMON_DOWN.test(listed.value.stderr.text))
        return unavailable("docker is not running");
      const ids = capturedOutput(listed.value, (outcome) => notChecked("docker ps", outcome));
      if (!ids.ok) return ids;
      const containers = decoder
        .decode(ids.value)
        .split("\n")
        .map((id) => id.trim())
        .filter((id) => id !== "");
      if (containers.length === 0) return ok({ available: true, mounts: [] });

      const inspected = await capture("docker", ["inspect", ...containers], env, ctx);
      if (!inspected.ok) return inspected;
      const outcome = inspected.value;
      // A container that stopped since `docker ps` is "No such object"; the rest are still described.
      const vanishedOnly =
        outcome.exitCode === 1 &&
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
      if (!described.ok) return described;

      const roots = await spellings(host, dir);
      const mounts: { container: string; name: string; source: string }[] = [];
      for (const container of described.value) {
        for (const mount of container.Mounts ?? []) {
          if (mount.Type !== "bind" || !isAbsolute(mount.Source)) continue;
          const sources = [resolve(mount.Source)];
          try {
            sources.push(await host.fs.realpath(mount.Source));
          } catch {
            // Gone, or not on this disk: its spelling is all there is.
          }
          if (sources.some((source) => under(roots, source))) {
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
