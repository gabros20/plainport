import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isUlid, PLAN_TTL_MS, PlanSchema } from "@plainport/core";
import { makeSandbox, type Sandbox } from "../../../core/src/testing/sandbox.ts";
import { gate } from "../gate.ts";
import { preloadPlans } from "../plans.ts";
import type { Ports } from "../registry.ts";
import { capture, sandboxPorts } from "../testing.ts";
import { REGISTRY } from "./index.ts";

let box: Sandbox;
const NOW = new Date("2026-10-03T12:00:00Z");

beforeEach(async () => {
  box = makeSandbox("plainport-offload-");
  box.dir("work");
  const run = await cli([
    "init",
    "--root",
    "work=~/work",
    "--store-path",
    "~/ssd",
    "--device",
    "mbp",
    "--yes",
  ]);
  if (run.code !== 0) throw new Error(run.err);
  // A Node project with no repository: its totals are the files written here, nothing more.
  box.file("work/web/package.json", `${JSON.stringify({ name: "web", scripts: { build: "vite build" } })}\n`);
  box.file("work/web/package-lock.json", `${JSON.stringify({ lockfileVersion: 3 })}\n`);
  box.file("work/web/src/main.ts", "x".repeat(1500));
  box.file("work/web/node_modules/vite/index.js", "x".repeat(612_000));
  box.file("work/web/dist/index.js", "x".repeat(2400));
});
afterEach(() => box.cleanup());

const ports = (over: Partial<Ports> = {}): Ports =>
  sandboxPorts(box.home, { clock: { now: () => NOW }, ...over });
async function cli(argv: string[], over: Partial<Ports> = {}) {
  return capture(argv, REGISTRY, { ports: ports(over) });
}
const envelope = (out: string) => JSON.parse(out.trim().split("\n").at(-1) as string);

describe("offload: dry run", () => {
  test("offload is confirm-class, and --dry-run runs it as read", () => {
    const verdict = gate(["offload", "work:web", "--dry-run"], REGISTRY, { approved: () => false });
    expect(verdict.ok && [verdict.command.risk, verdict.risk]).toEqual(["confirm", "read"]);
  });

  test("--dry-run prints the plan as DESIGN.md shows it", async () => {
    const run = await cli(["offload", "work:web", "--dry-run"]);
    expect(run.code).toBe(0);
    const id = /plan {6}([0-9A-Z]{26}) /.exec(run.out)?.[1] ?? "";
    expect(isUlid(id)).toBe(true);
    expect(run.out).toBe(
      [
        "work:web → local",
        "  include   3 files · 1.57 KB",
        "  strip     node_modules 612 KB · dist 2.4 KB",
        "  largest   src/main.ts 1.5 KB · package.json 48 B · package-lock.json 22 B",
        `  plan      ${id} (valid 1h) → plainport offload work:web --plan ${id}`,
        "",
      ].join("\n"),
    );
  });

  test("--dry-run --json returns the plan as data, valid against the plan schema", async () => {
    const run = await cli(["offload", "work:web", "--dry-run", "--json"]);
    expect(run.code).toBe(0);
    const data = envelope(run.out).data;
    expect(PlanSchema.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({
      kind: "offload",
      project: {
        address: "work:web",
        root: "work",
        path: "web",
        dir: join(box.home, "work/web"),
        store: "local",
      },
      strip: [
        { path: "node_modules", bytes: 612_000, plugin: "node" },
        { path: "dist", bytes: 2400, plugin: "node" },
      ],
      arrival: [{ part: "deps", outcome: "hydrate", detail: "npm ci" }],
      expiresAt: new Date(NOW.getTime() + PLAN_TTL_MS).toISOString(),
    });
  });

  test("the dry run changes nothing in the project and saves its plan under plans/", async () => {
    const run = await cli(["offload", "work:web", "--dry-run", "--json"]);
    const { id } = envelope(run.out).data;
    expect(existsSync(join(box.paths.plansDir, `${id}.json`))).toBe(true);
    expect(existsSync(join(box.home, "work/web/node_modules/vite/index.js"))).toBe(true);
    expect(existsSync(join(box.home, "work/web.plainport"))).toBe(false);
  });

  test("blockers show in the plan with their fix, and the plan line says to fix them first", async () => {
    const git = Bun.spawnSync(["git", "init", "-q", join(box.home, "work/web")], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: box.home, GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(git.exitCode).toBe(0);
    box.file("work/web/.git/index.lock");
    const run = await cli(["offload", "work:web", "--dry-run"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("  block     git.locked  ");
    expect(run.out).toContain("            fix: wait for the git command to finish");
    expect(run.out).toMatch(
      / {2}plan {6}[0-9A-Z]{26} is blocked: fix the findings above, then plan again\n$/,
    );
  });

  test("an unknown project exits 4 before anything is planned", async () => {
    const run = await cli(["offload", "work:nope", "--dry-run", "--json"]);
    expect(run.code).toBe(4);
    expect(envelope(run.out).error.finding.code).toBe("project.not-found");
  });
});

describe("offload: a real run (the saga arrives in M1 Task 12)", () => {
  test("without --yes or a plan it exits 3 with the exact re-run", async () => {
    const run = await cli(["offload", "work:web"]);
    expect(run.code).toBe(3);
    expect(run.err).toContain("re-run: plainport offload work:web --yes");
  });

  test("with --yes it refuses cleanly with command.unavailable and points at --dry-run", async () => {
    const run = await cli(["offload", "work:web", "--yes", "--json"]);
    expect(run.code).toBe(1);
    expect(envelope(run.out).error).toMatchObject({
      code: 1,
      hint: "plainport offload work:web --dry-run",
      finding: { code: "command.unavailable" },
    });
    expect(existsSync(join(box.home, "work/web/node_modules"))).toBe(true);
  });

  test("a fresh plan id stands in for --yes; once the hour is over it no longer does", async () => {
    const planned = await cli(["offload", "work:web", "--dry-run", "--json"]);
    const { id } = envelope(planned.out).data;
    const fresh = await preloadPlans(ports().io, ports().env, NOW);
    const withPlan = await cli(["offload", "work:web", "--plan", id, "--json"], { plans: fresh });
    expect(envelope(withPlan.out).error.finding.code).toBe("command.unavailable");

    const later = new Date(NOW.getTime() + PLAN_TTL_MS);
    const stale = await preloadPlans(ports().io, ports().env, later);
    const expired = await cli(["offload", "work:web", "--plan", id, "--json"], { plans: stale });
    expect(expired.code).toBe(3);
    expect(envelope(expired.out).error.finding.code).toBe("risk.needs-yes");
  });

  test("a plan approves only the command it was made for", async () => {
    const planned = await cli(["offload", "work:web", "--dry-run", "--json"]);
    const { id } = envelope(planned.out).data;
    const store = await preloadPlans(ports().io, ports().env, NOW);
    expect(store.approved("offload", id)).toBe(true);
    expect(store.approved("onload", id)).toBe(false);
    expect(store.approved("offload", "01J9Z6KB")).toBe(false);
  });
});
