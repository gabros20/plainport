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
  /**
   * Keep ALL of stdout, as bytes, in RunOutcome.captured: for output parsed as data (`git ls-files -z`, `restic
   * snapshots --json`), where a tail would silently lose entries. Past maxBytes the group is stopped and the run
   * fails as process.output-too-large, also when the cap is crossed by the last bytes read after the child exited.
   * When the capture cannot be shown to be whole, the run fails as process.output-incomplete: a process outside
   * the group held stdout open past the drain, reading stdout failed before its end, or the leader left processes
   * in its group (leftoversStopped) that may have been writing. It is never cut short and reported ok. The exit
   * code still tells whether the child itself succeeded: check it before parsing. The bounded tails and onLine
   * work as without it. splitRecords splits the bytes at a separator.
   */
  capture?: { maxBytes: number };
  /**
   * stdout is data read as line records through onLine, without keeping it: for listings too big to capture
   * (`restic ls --json`). It is held to capture's promise without its memory: every stdout line reaches onLine
   * whole, or the run fails. A stdout line longer than maxLineBytes stops the group and fails as
   * process.output-too-large as soon as it crosses the limit (it never reaches onLine cut), and stdout that cannot
   * be shown to have been read to its end fails as process.output-incomplete, as with capture. Needs onLine;
   * excludes capture. What onLine saw counts only when the run is ok and the exit code is 0.
   * A stdout line reaches onLine as text: split at "\n" only, with a trailing "\r" kept (it may be part of a file
   * name), and decoded as UTF-8 with invalid bytes replaced by U+FFFD. For byte-exact records, use capture.
   */
  wholeStdout?: boolean;
  /**
   * The output may hold a secret (`security … -w`, `op read`, `restic cat masterkey`; AGENTS.md rule 9). stdout is
   * captured privately, bounded by capture.maxBytes (default outputLimitBytes), and returned only as `captured` in an
   * ok outcome whose exit code is 0. Neither stream's text is returned otherwise: both tails stay empty, and
   * RunOutcome.sensitive holds the byte counts and, with classifyStderr, the code it chose. Nothing either stream says
   * reaches log events, a finding's message, error data or a thrown error, on any path: a failure names the program,
   * why it stopped, a plain error code and byte counts only. Every buffer the runner held, read chunks and a string
   * stdin included, is overwritten when the run ends. Excludes onLine and wholeStdout, which would hand the lines to a
   * callback. Parse `captured` with parseSensitiveJson.
   */
  sensitive?: boolean;
  /**
   * Sensitive runs only: how a caller learns what stderr said without seeing it (op's "not signed in" against "no
   * such item"). Once an ok run ends, classify gets stderr's newest outputLimitBytes and returns one of `codes`, which
   * becomes RunOutcome.sensitive.stderrCode; the bytes are then overwritten. Build it with stderrClasses, which types
   * the codes as a closed union. A classify that throws, or returns a code not in `codes`, is a bug: the run throws an
   * error that quotes neither.
   */
  classifyStderr?: StderrClasses;
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

/** A sensitive run's stderr classifier: a closed set of codes and the function that picks one. */
export interface StderrClasses<C extends string = string> {
  codes: readonly C[];
  classify(stderr: Uint8Array): C;
}

/**
 * The newest bytes of one stream, decoded as UTF-8, and how many older bytes were dropped to keep it bounded. It is
 * for messages and logs: when droppedBytes > 0 the start is missing, so never parse it as data (use capture).
 */
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
  /** All of stdout when RunSpec.capture was given; absent otherwise. With sensitive, present only when the exit code
   * is 0. */
  captured?: Uint8Array;
  /** Sensitive runs only: how much each stream printed, and the code classifyStderr chose, if one was given. */
  sensitive?: { stdoutBytes: number; stderrBytes: number; stderrCode?: string };
  /** The child exited but left processes in its group; the runner stopped them (TERM, then KILL). With capture,
   * this is a process.output-incomplete failure instead, since a stopped process may have been writing. */
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
