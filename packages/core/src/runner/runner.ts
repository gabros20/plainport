// The one process runner (AGENTS.md rule 6). Every child plainport starts (restic, rclone, git, ssh, package
// managers, hooks) goes through runProcess:
// - it leads a process group of its own, so stopping it stops everything it started;
// - its output goes to a bounded ring buffer per stream, and streams line by line to onLine and as log events;
// - an idle deadline (no output for too long) and an overall deadline stop it, as does its AbortSignal;
// - stopping means TERM to the whole group, then KILL after a grace period, then waiting until the group is empty;
// - when the child exits on its own but leaves processes in its group, those are stopped the same way.
// Expected failures (cannot start, deadlines, cancelled) come back as Results with a finding. Exceptions mean bugs:
// an onLine or log callback that throws stops the group first, then propagates.
//
// Known limits: a grandchild that calls setsid() leaves the group and is out of reach; a group whose last member
// exits between our liveness check and our KILL could, in theory, have its id reused by a new group in that
// instant; and if plainport itself is SIGKILLed, its children keep running (macOS has no parent-death signal), which
// the journal and `recover` exist for.

import { basename } from "node:path";
import { type Failure, fail, finding, ok, type Result } from "@plainport/contract";
import { errorCode } from "../io.ts";
import { RingBuffer } from "./ring-buffer.ts";
import type { ChildProcess, OutputStream, OutputTail, RunOutcome, RunSpec, Spawner } from "./types.ts";

/** Defaults for the per-call settings in RunSpec; each is overridable per call. Reasons are in the report and
 * in RunSpec's comments. */
export const RUN_DEFAULTS = Object.freeze({
  idleTimeoutMs: 10 * 60_000,
  timeoutMs: 24 * 60 * 60_000,
  killGraceMs: 10_000,
  outputLimitBytes: 1024 * 1024,
  maxLineBytes: 64 * 1024,
});

/** How often the runner checks whether a stopped group is empty. */
const POLL_MS = 10;
/** After KILL, how long to wait for the group to be gone; KILL cannot be ignored, so this only bounds a process
 * stuck in the kernel. */
const REAP_MS = 5_000;
/** After the group is gone, how long its pipes may stay open (held by a process that left the group). */
const DRAIN_MS = 1_000;
const LOG_MESSAGE_MAX = 2_000;
const TAIL_LINES_IN_MESSAGE = 5;
const TAIL_CHARS_IN_MESSAGE = 600;

type Settings = Record<keyof typeof RUN_DEFAULTS, number>;
type Stop = "idle" | "timeout" | "cancelled" | "error";

const settingsOf = (spec: RunSpec): Settings => {
  const settings: Settings = { ...RUN_DEFAULTS };
  for (const key of Object.keys(RUN_DEFAULTS) as (keyof Settings)[]) {
    const value = spec[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError(`runProcess: ${key} must be positive, got ${value}`);
    settings[key] = value;
  }
  return settings;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the condition holds or the time is up; true if it held. */
const until = async (condition: () => boolean, ms: number): Promise<boolean> => {
  const deadline = performance.now() + ms;
  for (;;) {
    if (condition()) return true;
    if (performance.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
};

const duration = (ms: number): string => {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
};

/** Splits a byte stream into lines, cutting each at maxLineBytes. */
class LineSplitter {
  private parts: Uint8Array[] = [];
  private size = 0;
  private truncated = false;

  constructor(
    private readonly maxLineBytes: number,
    private readonly emit: (bytes: Uint8Array, truncated: boolean) => void,
  ) {}

  push(chunk: Uint8Array): void {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(10, start);
      this.append(chunk.subarray(start, newline === -1 ? chunk.length : newline));
      if (newline === -1) return;
      this.flush();
      start = newline + 1;
    }
  }

  /** The last line, if the stream did not end with a newline. */
  end(): void {
    if (this.size > 0 || this.truncated) this.flush();
  }

  private append(bytes: Uint8Array): void {
    const room = this.maxLineBytes - this.size;
    if (bytes.length > room) this.truncated = true;
    const kept = bytes.length > room ? bytes.subarray(0, room) : bytes;
    if (kept.length === 0) return;
    this.parts.push(kept);
    this.size += kept.length;
  }

  private flush(): void {
    let line = new Uint8Array(this.size);
    let at = 0;
    for (const part of this.parts) {
      line.set(part, at);
      at += part.length;
    }
    if (!this.truncated && line.at(-1) === 13) line = line.subarray(0, -1);
    const truncated = this.truncated;
    this.parts = [];
    this.size = 0;
    this.truncated = false;
    this.emit(line, truncated);
  }
}

/** One stream's bounded tail and its lines. A callback that throws is reported once, then lines stop. */
class Collector {
  private readonly ring: RingBuffer;
  private readonly lines: LineSplitter;
  private readonly decoder = new TextDecoder();
  private failed = false;

  constructor(
    readonly stream: OutputStream,
    settings: Settings,
    label: string,
    spec: RunSpec,
    onError: (error: unknown) => void,
  ) {
    this.ring = new RingBuffer(settings.outputLimitBytes);
    const log = spec.log;
    const logged = log !== undefined && (log.streams ?? ["stdout", "stderr"]).includes(stream);
    this.lines = new LineSplitter(settings.maxLineBytes, (bytes, truncated) => {
      if (this.failed) return;
      try {
        const text = this.decoder.decode(bytes);
        spec.onLine?.({ stream, text, truncated });
        if (logged && text.length > 0) {
          const message = `${label}: ${text}`;
          log.emit({
            type: "log",
            op: log.op,
            level: stream === "stdout" ? "debug" : "info",
            message: message.length > LOG_MESSAGE_MAX ? `${message.slice(0, LOG_MESSAGE_MAX)}…` : message,
          });
        }
      } catch (error) {
        this.failed = true;
        onError(error);
      }
    });
  }

  push(chunk: Uint8Array): void {
    this.ring.push(chunk);
    this.lines.push(chunk);
  }

  end(): void {
    this.lines.end();
  }

  tail(): OutputTail {
    return { text: this.decoder.decode(this.ring.bytes()), droppedBytes: this.ring.droppedBytes };
  }
}

/** Reads a stream to its end (or until cancelled) into the collector. */
const pump = async (
  stream: ReadableStream<Uint8Array>,
  collector: Collector,
  onChunk: () => void,
  readers: { cancel(): Promise<void> }[],
): Promise<void> => {
  const reader = stream.getReader();
  readers.push(reader);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk();
      collector.push(value);
    }
  } catch {
    // A cancelled or broken pipe: what was read is kept.
  } finally {
    collector.end();
  }
};

/** The last few lines of output, for a failure message: stderr if it said anything, else stdout. */
const lastOutput = (stdout: OutputTail, stderr: OutputTail): string => {
  const source = stderr.text.trim().length > 0 ? stderr.text : stdout.text;
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-TAIL_LINES_IN_MESSAGE);
  if (lines.length === 0) return "";
  const text = lines.join(" / ");
  return `; its last output: ${text.length > TAIL_CHARS_IN_MESSAGE ? `…${text.slice(-TAIL_CHARS_IN_MESSAGE)}` : text}`;
};

const spawnFailed = (spec: RunSpec, error: unknown): Failure => {
  const reason = error instanceof Error ? error.message : String(error);
  const code = errorCode(error);
  return fail(
    finding("process.spawn-failed", {
      message: `could not start ${spec.command} in ${spec.cwd}: ${reason}${code === undefined || reason.includes(code) ? "" : ` (${code})`}`,
      fix: `check that ${spec.command} exists and is executable, and that ${spec.cwd} is a folder`,
      paths: [spec.command, spec.cwd],
    }),
  );
};

const stoppedFailure = (
  stop: Exclude<Stop, "error">,
  label: string,
  settings: Settings,
  stdout: OutputTail,
  stderr: OutputTail,
): Failure => {
  const said = lastOutput(stdout, stderr);
  switch (stop) {
    case "idle":
      return fail(
        finding("process.idle-timeout", {
          message: `${label} printed nothing for ${duration(settings.idleTimeoutMs)} and was stopped${said}`,
          fix: "check what it was waiting for (a network connection, a lock, a prompt), then run the command again",
        }),
      );
    case "timeout":
      return fail(
        finding("process.timeout", {
          message: `${label} ran longer than ${duration(settings.timeoutMs)} and was stopped${said}`,
          fix: "run the command again; if it keeps running this long, check what slows it (network, disk)",
        }),
      );
    case "cancelled":
      return fail(finding("process.cancelled", { message: `${label} was cancelled and stopped${said}` }));
  }
};

/** Runs one child to completion through the spawner. See the file comment for what it guarantees. */
export const runProcess = async (spawner: Spawner, spec: RunSpec): Promise<Result<RunOutcome>> => {
  const settings = settingsOf(spec);
  const label = basename(spec.command);
  const empty: OutputTail = { text: "", droppedBytes: 0 };
  if (spec.signal?.aborted) return stoppedFailure("cancelled", label, settings, empty, empty);

  const started = performance.now();
  let child: ChildProcess;
  try {
    child = spawner.spawn({
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd,
      env: spec.env,
      stdin: typeof spec.stdin === "string" ? new TextEncoder().encode(spec.stdin) : spec.stdin,
    });
  } catch (error) {
    return spawnFailed(spec, error);
  }
  const pgid = child.pid;
  if (!Number.isInteger(pgid) || pgid <= 1) {
    throw new Error(
      `runProcess: the spawner returned process group ${pgid}; signalling it could reach every process`,
    );
  }

  let stop: Stop | undefined;
  let stopError: unknown;
  let wake!: () => void;
  const stopped = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const requestStop = (why: Stop, error?: unknown): void => {
    if (why === "error" && stopError === undefined) stopError = error;
    if (stop !== undefined) return;
    stop = why;
    wake();
  };

  // The idle timer re-arms itself from the last output, so a flood costs no timer churn.
  let lastActivity = performance.now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (delay: number): void => {
    idleTimer = setTimeout(() => {
      const quiet = performance.now() - lastActivity;
      if (quiet >= settings.idleTimeoutMs) requestStop("idle");
      else armIdle(settings.idleTimeoutMs - quiet);
    }, delay);
  };
  armIdle(settings.idleTimeoutMs);
  const overallTimer = setTimeout(() => requestStop("timeout"), settings.timeoutMs);
  const onAbort = (): void => requestStop("cancelled");
  spec.signal?.addEventListener("abort", onAbort, { once: true });

  const onError = (error: unknown): void => requestStop("error", error);
  const stdout = new Collector("stdout", settings, label, spec, onError);
  const stderr = new Collector("stderr", settings, label, spec, onError);
  const readers: { cancel(): Promise<void> }[] = [];
  const touch = (): void => {
    lastActivity = performance.now();
  };
  const pumps = Promise.all([
    pump(child.stdout, stdout, touch, readers),
    pump(child.stderr, stderr, touch, readers),
  ]);

  let exit: { code: number | null; signal: string | null } | undefined;
  const exited = child.exited.then((status) => {
    exit = status;
  });
  const groupGone = (): boolean => exit !== undefined && !spawner.signalGroup(pgid, 0);
  let groupStopped = false;
  const stopGroup = async (): Promise<void> => {
    groupStopped = true;
    spawner.signalGroup(pgid, "SIGTERM");
    if (await until(groupGone, settings.killGraceMs)) return;
    spawner.signalGroup(pgid, "SIGKILL");
    await until(groupGone, REAP_MS);
  };

  let reason: Stop | undefined;
  let leftoversStopped = false;
  let finished = false;
  try {
    await Promise.race([exited, stopped]);
    reason = stop;
    if (reason !== undefined) {
      await stopGroup();
    } else if (spawner.signalGroup(pgid, 0)) {
      leftoversStopped = true;
      await stopGroup();
    }
    await Promise.race([exited, sleep(REAP_MS)]);

    // Once the group is gone its pipes close; a process that left the group may hold them, so bound the wait.
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      pumps.then(() => true),
      new Promise<false>((resolve) => {
        drainTimer = setTimeout(() => resolve(false), DRAIN_MS);
      }),
    ]);
    clearTimeout(drainTimer);
    if (!drained) {
      for (const reader of readers) reader.cancel().catch(() => {});
      await pumps;
    }
    finished = true;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    spec.signal?.removeEventListener("abort", onAbort);
    // Only when something above threw: never leave the group running.
    if (!finished && !groupStopped) await stopGroup();
  }

  // A callback that threw is a bug, also when it threw while the last lines drained.
  if (stopError !== undefined) throw stopError;
  if (reason !== undefined && reason !== "error") {
    return stoppedFailure(reason, label, settings, stdout.tail(), stderr.tail());
  }
  return ok({
    exitCode: exit?.code ?? null,
    signal: exit?.signal ?? null,
    stdout: stdout.tail(),
    stderr: stderr.tail(),
    leftoversStopped,
    durationMs: Math.round(performance.now() - started),
  });
};
