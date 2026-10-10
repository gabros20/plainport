// A store probe the deadline gave up on (D32) must not keep plainport alive: the abandoned call stays in Bun's pool
// until its mount answers, so the process exits explicitly once its output is flushed (exit.ts), with its own code.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeSync, constants, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishProcess } from "./exit.ts";

let dir: string;
let fifo: string;
const children: Bun.Subprocess[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "plainport-exit-")));
  fifo = join(dir, "hung");
  const made = Bun.spawnSync(["/usr/bin/mkfifo", fifo], { env: { PATH: "/usr/bin:/bin" } });
  if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  // Open the FIFO for writing without blocking only if a reader is still waiting on it; then nothing hangs in rm.
  try {
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch {}
  rmSync(dir, { recursive: true, force: true });
});

/** A process that reads the FIFO (no writer: the read never returns) under a 200 ms deadline, then finishes. */
const startProbe = (finish: string) => {
  const script = join(dir, "probe.ts");
  writeFileSync(
    script,
    `import { readFile } from "node:fs/promises";\n` +
      `import { withinDeadline } from ${JSON.stringify(join(import.meta.dir, "../../core/src/deadline.ts"))};\n` +
      `import { finishProcess } from ${JSON.stringify(join(import.meta.dir, "exit.ts"))};\n` +
      `const probed = await withinDeadline(readFile(${JSON.stringify(fifo)}), 200);\n` +
      `process.stdout.write(JSON.stringify(probed) + "\\n");\n` +
      `${finish}\n`,
  );
  const child = Bun.spawn([process.execPath, script], {
    cwd: dir,
    env: { PATH: "/usr/bin:/bin", HOME: dir },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
};

/** The child's exit code, or "still running" when it has not exited within `ms`. */
const exitWithin = async (child: Bun.Subprocess, ms: number): Promise<number | "still running"> =>
  Promise.race([child.exited, Bun.sleep(ms).then(() => "still running" as const)]);

describe("the process ends after an abandoned probe (D32)", () => {
  test("a FIFO read raced through withinDeadline: the process prints its result and exits with its code within seconds", async () => {
    const child = startProbe("await finishProcess(probed.timedOut ? 4 : 0);");
    expect(await exitWithin(child, 5_000)).toBe(4);
    expect(await new Response(child.stdout as ReadableStream).text()).toBe(
      '{"timedOut":true,"seconds":0.2}\n',
    );
  });

  test("without it, the abandoned read keeps the process alive past its output (why finishProcess exists)", async () => {
    const child = startProbe("process.exitCode = probed.timedOut ? 4 : 0;");
    expect(await exitWithin(child, 2_000)).toBe("still running");
  });

  test("with no abandoned call it only sets the exit code and lets the loop drain", async () => {
    const calls: string[] = [];
    await finishProcess(3, {
      abandoned: () => 0,
      streams: [],
      setCode: (code) => calls.push(`code ${code}`),
      exit: (code) => calls.push(`exit ${code}`),
    });
    expect(calls).toEqual(["code 3"]);
  });

  test("with one, it flushes every stream, then exits with the code", async () => {
    const order: string[] = [];
    const stream = {
      write: (_chunk: string, done: () => void) => {
        order.push("flush");
        done();
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    await finishProcess(4, {
      abandoned: () => 1,
      streams: [stream, stream],
      setCode: (code) => order.push(`code ${code}`),
      exit: (code) => order.push(`exit ${code}`),
    });
    expect(order).toEqual(["code 4", "flush", "flush", "exit 4"]);
  });
});
