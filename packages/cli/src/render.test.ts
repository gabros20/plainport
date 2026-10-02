import { describe, expect, test } from "bun:test";
import { parseJsonLines } from "@plainport/contract";
import { Output } from "./render.ts";
import { capture } from "./testing.ts";

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

describe("--json: NDJSON event lines, then exactly one final envelope", () => {
  test("events stream before the envelope; logs go to stderr, never stdout", async () => {
    const run = await capture(["stream", "--json"]);
    expect(run.code).toBe(0);
    const parsed = parseJsonLines(run.out);
    if (!parsed.ok) throw new Error(parsed.finding.message);
    expect(parsed.value.events.map((e) => e.type)).toEqual(["phase", "finding", "phase"]);
    expect(parsed.value.envelope).toEqual({
      plainport_json: 1,
      ok: true,
      verb: "stream",
      data: { done: "stream" },
    });
    expect(lines(run.out)).toHaveLength(4);
    expect(run.err).toBe("info: scanning\n");
  });

  test("a handler that throws still ends with exactly one envelope, exit 1", async () => {
    const run = await capture(["boom", "--json"]);
    expect(run.code).toBe(1);
    const parsed = parseJsonLines(run.out);
    if (!parsed.ok) throw new Error(parsed.finding.message);
    expect(parsed.value.events).toHaveLength(1);
    expect(parsed.value.envelope).toMatchObject({ ok: false, verb: "boom", error: { code: 1 } });
    expect(parsed.value.envelope.ok === false && parsed.value.envelope.error.message).toContain("kaboom");
  });

  test("nothing can be written after the envelope", () => {
    let out = "";
    const output = new Output(
      { stdout: (t) => (out += t), stderr: () => {}, isTTY: false },
      { json: true, quiet: false, verbose: false },
      "x",
    );
    output.success({ a: 1 }, "a");
    expect(() => output.event({ type: "phase", op: "o", phase: "scan", status: "end" })).toThrow();
    expect(() => output.success({ a: 2 }, "a")).toThrow();
    expect(lines(out)).toHaveLength(1);
  });

  test("an output that does not match the command's declared schema is a bug: exit 1, not a bad envelope", async () => {
    const { FAKE_REGISTRY } = await import("./testing.ts");
    const { defineCommand } = await import("./registry.ts");
    const { ok } = await import("@plainport/contract");
    const { z } = await import("zod");
    const liar = defineCommand({
      name: "liar",
      summary: "Returns the wrong shape",
      risk: "read",
      dryRun: false,
      acceptsPlan: false,
      positionals: [],
      args: z.strictObject({}),
      output: z.looseObject({ n: z.number() }),
      examples: [],
      human: () => "",
      handler: () => ok({ n: "not a number" } as unknown as { n: number }),
    });
    const run = await capture(["liar", "--json"], [...FAKE_REGISTRY, liar]);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.out)).toMatchObject({ ok: false, error: { code: 1 } });
  });
});

describe("the plan is the dry run's data (I1)", () => {
  test("a dry run's data is checked against the plan schema, a real run's against the output schema", async () => {
    const plan = await capture(["ship", "web", "--dry-run", "--json"]);
    expect(JSON.parse(plan.out)).toMatchObject({ ok: true, data: { plan: "ship web" } });
    const wrongPlan = await capture(["ship", "web", "--dry-run", "--lie", "--json"]);
    expect(wrongPlan.code).toBe(1);
    expect(JSON.parse(wrongPlan.out)).toMatchObject({
      ok: false,
      error: { code: 1, finding: { code: "contract.invalid" } },
    });
    const wrongOutput = await capture(["ship", "web", "--yes", "--lie", "--json"]);
    expect(wrongOutput.code).toBe(1);
  });
});

describe("every throw ends in exactly one envelope (I6)", () => {
  test("a throw while checking the arguments is internal.unexpected, exit 1, one envelope", async () => {
    const run = await capture(["fragile", "w", "--json"]);
    expect(run.code).toBe(1);
    expect(lines(run.out)).toHaveLength(1);
    expect(JSON.parse(run.out)).toMatchObject({
      ok: false,
      verb: "fragile",
      error: { code: 1, finding: { code: "internal.unexpected" } },
    });
    expect(JSON.parse(run.out).error.message).toContain("transform bug");
  });

  test("a throw while checking the arguments in human mode prints one line and exits 1", async () => {
    const run = await capture(["fragile", "w"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("plainport: internal.unexpected: ");
  });

  test("a stdout that fails while printing the envelope makes run() return 1, never reject", async () => {
    let calls = 0;
    const run = await capture(["show", "--json"], undefined, {
      stdout: () => {
        calls += 1;
        throw new Error("EPIPE");
      },
    });
    expect(run.code).toBe(1);
    expect(calls).toBe(1);
    expect(run.err).toContain("EPIPE");
  });
});

describe("human output", () => {
  test("results go to stdout; events and logs to stderr", async () => {
    const run = await capture(["stream"]);
    expect(run.code).toBe(0);
    expect(run.out).toBe("done: stream\n");
    expect(run.err).toBe(
      "scan: start\nwarn  git.unpushed  2 commits are not on origin\ninfo: scanning\nscan: end\n",
    );
  });

  test("--quiet drops progress and logs but keeps warnings; --verbose adds debug", async () => {
    expect((await capture(["stream", "--quiet"])).err).toBe(
      "warn  git.unpushed  2 commits are not on origin\n",
    );
    expect((await capture(["stream", "--verbose"])).err).toContain("debug: deep detail\n");
  });

  test("a bug prints one plain line to stderr and exits 1", async () => {
    const run = await capture(["boom"]);
    expect(run.code).toBe(1);
    expect(run.out).toBe("");
    expect(run.err).toContain("plainport: internal.unexpected: unexpected failure in boom: kaboom\n");
  });
});
