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
const startProbe = (finish: string, laterReader = false) => {
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
  // laterReader: stdout goes through a pipe that `sleep 1; wc -c` reads; the line printed is the byte count and the
  // probe's own exit code.
  const command = laterReader
    ? [
        "/bin/sh",
        "-c",
        `{ "$0" "$1"; echo $? > "$2"; } | { sleep 1; wc -c | tr -d ' '; }; cat "$2"`,
        process.execPath,
        script,
        join(dir, "code"),
      ]
    : [process.execPath, script];
  const child = Bun.spawn(command, {
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

  test("a megabyte of output into a pipe read only later arrives whole before the exit, with its code", async () => {
    // Sixteen 64 KiB writes: far more than a pipe holds, so they are still queued in the child when it finishes. The
    // reader is a shell pipeline that starts reading a second later, as an agent's pipe may.
    const child = startProbe(
      'for (let i = 0; i < 16; i++) process.stdout.write("x".repeat(65_536));\n' +
        "await finishProcess(probed.timedOut ? 4 : 0);",
      true,
    );
    expect(await exitWithin(child, 10_000)).toBe(0);
    const [count, code] = (await new Response(child.stdout as ReadableStream).text()).trim().split(/\s+/);
    expect([Number(count), Number(code)]).toEqual([
      '{"timedOut":true,"seconds":0.2}\n'.length + 16 * 65_536,
      4,
    ]);
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

  test("with one, it ends every stream, then exits with the code", async () => {
    const order: string[] = [];
    const stream = {
      end: (done: () => void) => {
        order.push("end");
        done();
      },
    } as unknown as NodeJS.WritableStream;
    await finishProcess(4, {
      abandoned: () => 1,
      streams: [stream, stream],
      setCode: (code) => order.push(`code ${code}`),
      exit: (code) => order.push(`exit ${code}`),
    });
    expect(order).toEqual(["code 4", "end", "end", "exit 4"]);
  });

  test("a stream that never finishes ending (its reader gone) holds the exit only until the limit", async () => {
    const order: string[] = [];
    const stuck = { end: () => order.push("end") } as unknown as NodeJS.WritableStream;
    await finishProcess(4, {
      abandoned: () => 1,
      streams: [stuck],
      flushLimitMs: 50,
      setCode: () => {},
      exit: (code) => order.push(`exit ${code}`),
    });
    expect(order).toEqual(["end", "exit 4"]);
  });
});
