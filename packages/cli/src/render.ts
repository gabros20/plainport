// Renderers (ADR-0007, DESIGN.md "CLI design"). Human mode: results to stdout, events and logs to stderr.
// --json: NDJSON on stdout, event lines then exactly one final envelope; logs still go to stderr. Output holds the
// one-envelope rule: once a result is printed, any further write is a bug and throws.

import {
  errorEnvelope,
  type Failure,
  type Finding,
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

  constructor(
    private readonly io: IO,
    private readonly mode: RenderMode,
    private readonly verb: string,
  ) {}

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

  /** Prints the result and closes the output. Returns exit code 0. */
  success(data: unknown, human: string): 0 {
    this.#open();
    this.#finished = true;
    if (this.mode.json) this.io.stdout(`${JSON.stringify(successEnvelope(this.verb, data))}\n`);
    else if (human !== "") this.io.stdout(human.endsWith("\n") ? human : `${human}\n`);
    return 0;
  }

  /** Prints the refusal or failure and closes the output. Returns its exit code. */
  failure(failure: Failure): Failure["exitCode"] {
    this.#open();
    this.#finished = true;
    const hint = hintOf(failure.finding);
    if (this.mode.json) {
      const envelope = errorEnvelope(
        this.verb,
        failure.exitCode,
        failure.finding.message,
        hint === undefined ? {} : { hint },
      );
      this.io.stdout(`${JSON.stringify(envelope)}\n`);
    } else {
      this.io.stderr(`plainport: ${failure.finding.message}\n`);
      if (hint !== undefined) this.io.stderr(hint.startsWith("re-run: ") ? `${hint}\n` : `fix: ${hint}\n`);
    }
    return failure.exitCode;
  }
}
