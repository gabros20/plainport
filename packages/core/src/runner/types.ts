// The one process runner's types (AGENTS.md rule 6, DESIGN.md "Core API → Design rules"). The runner's logic lives
// in core (runner.ts) and starts children through a Spawner, the host port's process-group primitive, so tests can
// drive the logic with a fake and the host decides how a group is really started and signalled.

import type { PlainportEvent } from "@plainport/contract";

export type OutputStream = "stdout" | "stderr";

/** One line of a child's output, without its line ending. */
export interface OutputLine {
  stream: OutputStream;
  text: string;
  /** The line was longer than maxLineBytes; `text` is its first maxLineBytes bytes. */
  truncated: boolean;
}

export type LogEvent = Extract<PlainportEvent, { type: "log" }>;

export interface RunSpec {
  /** The program: an absolute path (toolPath's) or a name looked up on the env's PATH. */
  command: string;
  args?: readonly string[];
  cwd: string;
  /** The child's whole environment. Required: nothing is inherited from this process (Bun ignores later changes
   * to process.env anyway). */
  env: Readonly<Record<string, string>>;
  /** Written to the child's stdin, which is then closed; stdin is /dev/null without it. */
  stdin?: string | Uint8Array;
  /** Aborting it stops the whole process group (TERM, then KILL) and the run ends as process.cancelled. */
  signal?: AbortSignal;
  /** No output on either stream for this long stops the group: process.idle-timeout. Default 10 minutes. */
  idleTimeoutMs?: number;
  /** The whole run may take this long, output or not: process.timeout. Default 24 hours. */
  timeoutMs?: number;
  /** How long the group has to exit after TERM before it gets KILL. Default 10 seconds. */
  killGraceMs?: number;
  /** How much of each stream's newest output the outcome keeps. Default 1 MiB per stream. */
  outputLimitBytes?: number;
  /** Lines longer than this reach onLine and log events cut, marked truncated. Default 64 KiB. */
  maxLineBytes?: number;
  /** Every complete line as it arrives (parsers, progress). A throw is a bug: the group is stopped, then it
   * propagates. */
  onLine?: (line: OutputLine) => void;
  /** Streams lines as log events: stdout at debug, stderr at info, prefixed with the program's name. */
  log?: {
    op: string;
    emit(event: LogEvent): void;
    /** Default: both. */
    streams?: readonly OutputStream[];
  };
}

/** The newest bytes of one stream, decoded as UTF-8, and how many older bytes were dropped to keep it bounded. */
export interface OutputTail {
  text: string;
  droppedBytes: number;
}

export interface RunOutcome {
  /** The exit code, or null when a signal ended the child. Any code is an ok outcome; callers map codes. */
  exitCode: number | null;
  /** The signal that ended the child (SIGUSR1, …), or null. */
  signal: string | null;
  stdout: OutputTail;
  stderr: OutputTail;
  /** The child exited but left processes in its group; the runner stopped them (TERM, then KILL). */
  leftoversStopped: boolean;
  durationMs: number;
}

export interface SpawnRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: Uint8Array | undefined;
}

export interface ChildProcess {
  /** The child's pid, which is also its process group id: it leads a group of its own. */
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Settles once the leader has exited and been reaped; other group members may still run. */
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

/** 0 only asks whether the group still has a member. */
export type GroupSignal = "SIGTERM" | "SIGKILL" | 0;

/** The host's primitive for children: start one as the leader of a new process group, signal its group. */
export interface Spawner {
  /** Starts the child in a new process group. Throws a Node error (ENOENT, EACCES, …) when it cannot start. */
  spawn(request: SpawnRequest): ChildProcess;
  /** Sends the signal to every process in the group; false when no process is left in it. */
  signalGroup(pgid: number, signal: GroupSignal): boolean;
}
