// Scripted children for the providers' T0 tests: a fake Spawner whose every child answers as the test scripts it
// (prints, exits, or hangs until it is signalled), driven through the real runner, so the sensitive mode under test is
// the one plainport runs. Only tests import it.

import type { ChildProcess, GroupSignal, Spawner, SpawnRequest } from "@plainport/core";
import { runProcess } from "@plainport/core";
import type { Run } from "./child.ts";

export interface Answer {
  stdout?: string;
  stderr?: string;
  /** The exit code, or "hang": no exit until the group is signalled. Default 0. */
  exit?: number | "hang";
  /** Instead of answering, fail to start with this errno code (ENOENT: no such program). */
  spawnError?: string;
}

class ScriptedChild implements ChildProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  alive = true;
  private controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  private finish!: (value: { code: number | null; signal: string | null }) => void;

  constructor(
    readonly pid: number,
    answer: Answer,
  ) {
    const stream = (text: string | undefined) =>
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.controllers.push(controller);
          if (text !== undefined && text !== "") controller.enqueue(new TextEncoder().encode(text));
        },
      });
    this.stdout = stream(answer.stdout);
    this.stderr = stream(answer.stderr);
    this.exited = new Promise((resolve) => {
      this.finish = resolve;
    });
    const { exit } = answer;
    if (exit !== "hang") queueMicrotask(() => this.end(exit ?? 0, null));
  }

  end(code: number | null, signal: string | null): void {
    if (!this.alive) return;
    this.alive = false;
    for (const controller of this.controllers) controller.close();
    this.finish({ code, signal });
  }
}

/** A run port whose children answer as `script` says; `requests` records every spawn, stdin included. */
export const scriptedRun = (
  script: (request: SpawnRequest) => Answer,
): { run: Run; requests: SpawnRequest[]; spawner: Spawner } => {
  const requests: SpawnRequest[] = [];
  const children = new Map<number, ScriptedChild>();
  let next = 40_000;
  const spawner: Spawner = {
    spawn: (request) => {
      requests.push(request);
      const answer = script(request);
      if (answer.spawnError !== undefined)
        throw Object.assign(new Error(`spawn ${request.command} ${answer.spawnError}`), {
          code: answer.spawnError,
        });
      const child = new ScriptedChild(next++, answer);
      children.set(child.pid, child);
      return child;
    },
    signalGroup: (pgid: number, signal: GroupSignal) => {
      const child = children.get(pgid);
      if (child === undefined || !child.alive) return false;
      if (signal !== 0) child.end(null, signal);
      return true;
    },
  };
  return { run: (spec) => runProcess(spawner, spec), requests, spawner };
};
