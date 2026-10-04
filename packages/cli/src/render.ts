// Renderers (ADR-0007, DESIGN.md "CLI design"). Human mode: results to stdout, events and logs to stderr.
// --json: NDJSON on stdout, event lines then exactly one final envelope; logs still go to stderr. Output holds the
// one-envelope rule: once a result is printed, any further write is a bug and throws.

import {
  errorEnvelope,
  type Failure,
  type Finding,
  finding,
  type PlainportEvent,
  type StreamEvent,
  successEnvelope,
} from "@plainport/contract";

export interface IO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Whether stdin is a terminal; without one, --no-input is implied. */
  isTTY: boolean;
}

export interface RenderMode {
  json: boolean;
  quiet: boolean;
  verbose: boolean;
}

/** The hint a refusal carries: risk.needs-yes says `re-run: <command>` (machine-contract §1, §4), others their fix. */
export const hintOf = (finding: Finding): string | undefined => {
  if (finding.fix === undefined) return undefined;
  return finding.code === "risk.needs-yes" ? `re-run: ${finding.fix}` : finding.fix;
};

const findingLine = (finding: Finding): string => `${finding.severity}  ${finding.code}  ${finding.message}`;

export class Output {
  #finished = false;

  /** Whether the final result has been printed (or printing it was attempted). */
  get finished(): boolean {
    return this.#finished;
  }

  constructor(
    private readonly io: IO,
    private readonly mode: RenderMode,
    readonly verb: string,
  ) {}

  /** Whether the output is NDJSON (--json). */
  get json(): boolean {
    return this.mode.json;
  }

  #open(): void {
    if (this.#finished)
      throw new Error(`output for ${this.verb} already finished: the envelope must be last`);
  }

  event(event: StreamEvent): void {
    this.#open();
    if (this.mode.json) {
      this.io.stdout(`${JSON.stringify(event)}\n`);
      return;
    }
    if (event.type === "finding") {
      if (!this.mode.quiet || event.finding.severity !== "info")
        this.io.stderr(`${findingLine(event.finding)}\n`);
      return;
    }
    if (this.mode.quiet) return;
    if (event.type === "phase") this.io.stderr(`${event.phase}: ${event.status}\n`);
    else this.io.stderr(`${event.phase}: ${event.bytesDone} of ${event.bytesTotal} bytes\n`);
  }

  log(level: Extract<PlainportEvent, { type: "log" }>["level"], message: string): void {
    this.#open();
    if (level === "debug" && !this.mode.verbose) return;
    if (level === "info" && this.mode.quiet) return;
    this.io.stderr(`${level}: ${message}\n`);
  }

  /** Prints the result and closes the output. Returns exit code 0, or 1 when the result cannot be printed as JSON. */
  success(data: unknown, human: string): 0 | 1 {
    this.#open();
    if (this.mode.json) {
      const line = this.#line(() => successEnvelope(this.verb, data));
      if (line === undefined) return this.#unprintable();
      this.#finished = true;
      this.io.stdout(line);
      return 0;
    }
    this.#finished = true;
    if (human !== "") this.io.stdout(human.endsWith("\n") ? human : `${human}\n`);
    return 0;
  }

  /** The envelope as one stdout line, or undefined when it cannot be serialized (a bug in the command's data). */
  #line(build: () => unknown): string | undefined {
    try {
      return `${JSON.stringify(build())}\n`;
    } catch {
      return undefined;
    }
  }

  /** The result could not be printed: an internal.unexpected envelope, with no data, takes its place (C1). */
  #unprintable(): 1 {
    const failure = finding("internal.unexpected", {
      message: `${this.verb}'s result could not be printed as JSON`,
    });
    this.#finished = true;
    this.io.stdout(`${JSON.stringify(errorEnvelope(this.verb, 1, failure.message, { finding: failure }))}\n`);
    return 1;
  }

  /**
   * Prints the refusal or failure and closes the output. Returns its exit code. A failure carrying data (D14) prints
   * it in the envelope, or as `human` on stdout before the refusal.
   */
  failure(failure: Failure, human?: string): Failure["exitCode"] {
    this.#open();
    const hint = hintOf(failure.finding);
    if (this.mode.json) {
      // Built before the output is closed, so a failure that cannot be printed still ends in an envelope.
      const line = this.#line(() =>
        errorEnvelope(this.verb, failure.exitCode, failure.finding.message, {
          ...(hint === undefined ? {} : { hint }),
          finding: failure.finding,
          ...(failure.data === undefined ? {} : { data: failure.data }),
        }),
      );
      if (line === undefined) return this.#unprintable();
      this.#finished = true;
      this.io.stdout(line);
    } else {
      this.#finished = true;
      if (failure.data !== undefined && human !== undefined && human !== "")
        this.io.stdout(human.endsWith("\n") ? human : `${human}\n`);
      this.io.stderr(`plainport: ${failure.finding.code}: ${failure.finding.message}\n`);
      if (hint !== undefined) this.io.stderr(hint.startsWith("re-run: ") ? `${hint}\n` : `fix: ${hint}\n`);
    }
    return failure.exitCode;
  }
}
