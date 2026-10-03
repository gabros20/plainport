import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fsBlobStore } from "@plainport/blob-fs";
import { isUlid, nodeLocalIo, PLAN_TTL_MS, PlanSchema, StubSchema } from "@plainport/core";
import { testHost as macosTestHost } from "@plainport/host-macos/testing";
import { describeT1 } from "../../../../test/tiers.ts";
import { fakeEngine } from "../../../core/src/testing/fake-engine.ts";
import { type InvariantSubject, invariantViolations } from "../../../core/src/testing/invariants.ts";
import { makeSandbox, type Sandbox } from "../../../core/src/testing/sandbox.ts";
import { gate } from "../gate.ts";
import { Cancellation } from "../interrupt.ts";
import { preloadPlans } from "../plans.ts";
import { type Ports, positionalsOf } from "../registry.ts";
import { localStores } from "../stores.ts";
import { capture, fakeEngineHooks, fakeRepositoryAt, sandboxPorts } from "../testing.ts";
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

  const lockedRepo = () => {
    const git = Bun.spawnSync(["git", "init", "-q", join(box.home, "work/web")], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: box.home, GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(git.exitCode).toBe(0);
    box.file("work/web/.git/index.lock");
  };

  test("a plan with blockers exits 6 (D38): the plan on stdout with each fix, the refusal on stderr", async () => {
    lockedRepo();
    const run = await cli(["offload", "work:web", "--dry-run"]);
    expect(run.code).toBe(6);
    expect(run.out).toContain("  block     git.locked  ");
    expect(run.out).toContain("            fix: wait for the git command to finish");
    expect(run.out).toMatch(
      / {2}plan {6}[0-9A-Z]{26} is blocked: fix the findings above, then plan again\n$/,
    );
    expect(run.err).toStartWith("plainport: git.locked: ");
  });

  test("under --json a blocked plan is the error envelope's data (D14), valid against the plan schema", async () => {
    lockedRepo();
    const run = await cli(["offload", "work:web", "--dry-run", "--json"]);
    expect(run.code).toBe(6);
    const env = envelope(run.out);
    expect(env).toMatchObject({
      ok: false,
      verb: "offload",
      error: { code: 6, finding: { code: "git.locked" } },
    });
    expect(PlanSchema.safeParse(env.data).success).toBe(true);
    expect(env.data.findings.map((f: { code: string }) => f.code)).toContain("git.locked");
  });

  test("a blocked plan's id never stands in for --yes (D38)", async () => {
    lockedRepo();
    const planned = await cli(["offload", "work:web", "--dry-run", "--json"]);
    const { id } = envelope(planned.out).data;
    const store = await preloadPlans(ports().io, ports().env, NOW);
    const run = await cli(["offload", "work:web", "--plan", id, "--json"], { plans: store });
    expect(run.code).toBe(3);
    expect(envelope(run.out).error.finding.code).toBe("risk.needs-yes");
  });

  test("offload's argument is variadic in the contract, but M1 offloads one project (D38)", async () => {
    const offload = REGISTRY.find((c) => c.name === "offload");
    expect(offload === undefined ? undefined : positionalsOf(offload)).toEqual([
      expect.objectContaining({ name: "project", variadic: true, required: true }),
    ]);
    const run = await cli(["offload", "work:web", "work:api", "--dry-run", "--json"]);
    expect(run.code).toBe(2);
    expect(envelope(run.out).error).toMatchObject({
      finding: { code: "usage.invalid" },
      message: expect.stringContaining("one project per offload until bulk offload lands"),
    });
    // Arguments are checked before the risk: no --yes, still a usage error.
    expect((await cli(["offload", "work:web", "work:api"])).code).toBe(2);
  });

  test("an unknown project exits 4 before anything is planned", async () => {
    const run = await cli(["offload", "work:nope", "--dry-run", "--json"]);
    expect(run.code).toBe(4);
    expect(envelope(run.out).error.finding.code).toBe("project.not-found");
  });
});

describe("offload: a real run", () => {
  const ssd = () => join(box.home, "ssd");
  const dir = () => join(box.home, "work/web");
  const subject = async (): Promise<InvariantSubject> => {
    const registry = JSON.parse(readFileSync(box.paths.registryFile, "utf8"));
    const id = Object.entries(registry.projects as Record<string, { path: string }>).find(
      ([, e]) => e.path === "web",
    )?.[0];
    const device = JSON.parse(readFileSync(box.paths.deviceFile, "utf8")).id;
    return {
      paths: box.paths,
      device,
      project: { id, dir: dir() },
      roots: [join(box.home, "work")],
      store: {
        name: "local",
        blob: fsBlobStore(nodeLocalIo, ssd()),
        engine: fakeEngine(fakeRepositoryAt(ssd())),
      },
    };
  };
  const expectInvariants = async () => expect(await invariantViolations(await subject())).toEqual([]);
  afterEach(() => fakeEngineHooks.delete(ssd()));

  test("without --yes or a plan it exits 3 with the exact re-run", async () => {
    const run = await cli(["offload", "work:web"]);
    expect(run.code).toBe(3);
    expect(run.err).toContain("re-run: plainport offload work:web --yes");
    await expectInvariants();
  });

  test("with --yes it runs the saga: the folder leaves a stub, the store holds the snapshot and its event", async () => {
    const run = await cli(["offload", "work:web", "--yes", "--json"]);
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    const lines = run.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const env = lines.at(-1);
    expect(env).toMatchObject({
      ok: true,
      verb: "offload",
      data: {
        exitCode: 0,
        project: "work:web",
        store: "local",
        stub: `${dir()}.plainport`,
        trash: join(box.home, "work/.plainport-trash", env.data.op),
      },
    });
    expect(env.data.snapshot).toBe(env.data.op);
    expect(lines.filter((l) => l.type === "phase" && l.status === "start").map((l) => l.phase)).toEqual([
      "resolve",
      "preflight",
      "scan",
      "plan",
      "snapshot",
      "verify",
      "commit",
      "release",
    ]);
    expect(existsSync(dir())).toBe(false);
    const stub = StubSchema.parse(JSON.parse(readFileSync(`${dir()}.plainport`, "utf8")));
    expect(stub).toMatchObject({ root: "work", path: "web", store: "local", snapshot: env.data.op });
    const events = readdirSync(join(ssd(), "meta/v1/events")).map((name) =>
      JSON.parse(readFileSync(join(ssd(), "meta/v1/events", name), "utf8")),
    );
    expect(events.map((e) => e.type).sort()).toEqual(["offloaded", "root-created"]);
    await expectInvariants();
  });

  test("human output names the snapshot, what was freed and the stub", async () => {
    const run = await cli(["offload", "work:web", "--yes"]);
    expect(run.code).toBe(0);
    expect(run.out).toMatch(/^offloaded work:web to local as snapshot [0-9A-Z]{26}; freed [0-9.]+ KB\n/);
    expect(run.out).toContain(`stub      ${dir()}.plainport`);
    await expectInvariants();
  });

  test("a fresh plan id stands in for --yes; once the hour is over it no longer does", async () => {
    const planned = await cli(["offload", "work:web", "--dry-run", "--json"]);
    const { id } = envelope(planned.out).data;
    const later = new Date(NOW.getTime() + PLAN_TTL_MS);
    const stale = await preloadPlans(ports().io, ports().env, later);
    const expired = await cli(["offload", "work:web", "--plan", id, "--json"], { plans: stale });
    expect(expired.code).toBe(3);
    expect(envelope(expired.out).error.finding.code).toBe("risk.needs-yes");

    const fresh = await preloadPlans(ports().io, ports().env, NOW);
    const withPlan = await cli(["offload", "work:web", "--plan", id, "--json"], { plans: fresh });
    expect(withPlan.code).toBe(0);
    expect(existsSync(dir())).toBe(false);
    await expectInvariants();
  });

  test("a folder changed since its plan exits 6 with plan.stale, naming a fresh plan; nothing is uploaded", async () => {
    const planned = await cli(["offload", "work:web", "--dry-run", "--json"]);
    const { id } = envelope(planned.out).data;
    box.file("work/web/src/main.ts", "changed");
    const fresh = await preloadPlans(ports().io, ports().env, NOW);
    const run = await cli(["offload", "work:web", "--plan", id, "--json"], { plans: fresh });
    expect(run.code).toBe(6);
    expect(envelope(run.out).error).toMatchObject({ finding: { code: "plan.stale" } });
    expect(envelope(run.out).error.hint).toMatch(/--plan [0-9A-Z]{26}$/);
    expect(existsSync(join(dir(), "src/main.ts"))).toBe(true);
    expect(fakeRepositoryAt(ssd()).snapshots).toEqual([]);
    await expectInvariants();
  });

  test("a blocker exits 6; --allow <code> overrides an allowable one", async () => {
    const git = Bun.spawnSync(["git", "init", "-q", dir()], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: box.home, GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(git.exitCode).toBe(0);
    box.file("work/web/.git/index.lock");
    const blocked = await cli(["offload", "work:web", "--yes", "--json"]);
    expect(blocked.code).toBe(6);
    expect(envelope(blocked.out).error.finding.code).toBe("git.locked");
    expect(existsSync(join(dir(), "src/main.ts"))).toBe(true);
    await expectInvariants();
    const allowed = await cli(["offload", "work:web", "--yes", "--allow", "git.locked", "--json"]);
    expect(allowed.code).toBe(0);
    await expectInvariants();
  });

  test("Ctrl-C during the upload stops at a safe point: exit 130, nothing deleted", async () => {
    const cancellation = new Cancellation();
    fakeEngineHooks.set(ssd(), { duringSnapshot: () => cancellation.abort() });
    const run = await cli(["offload", "work:web", "--yes", "--json"], { cancellation });
    expect(run.code).toBe(130);
    expect(envelope(run.out).error.finding.code).toBe("operation.cancelled");
    expect(cancellation.busy()).toBe(false);
    expect(existsSync(join(dir(), "src/main.ts"))).toBe(true);
    await expectInvariants();
  });

  test("a store init never set up refuses with store.not-set-up", async () => {
    const registry = JSON.parse(readFileSync(box.paths.registryFile, "utf8"));
    delete registry.stores;
    writeFileSync(box.paths.registryFile, JSON.stringify(registry));
    const run = await cli(["offload", "work:web", "--yes", "--json"]);
    expect(run.code).toBe(6);
    expect(envelope(run.out).error).toMatchObject({
      finding: { code: "store.not-set-up" },
      hint: "plainport init --yes sets up the stores already configured",
    });
  });
});

describeT1("offload with the real restic on a temp external-disk store", () => {
  test("init creates the repository; offload snapshots, verifies and releases; restic lists what the catalog names", async () => {
    const host = macosTestHost();
    const env = {
      HOME: box.home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PLAINPORT_STORE_PASSWORD: "t1-pw",
    };
    const real = (over: Partial<Ports> = {}) =>
      ports({ env, system: host, io: host, stores: localStores(host, env), ...over });
    const ssd = join(box.home, "t1-ssd");
    const setup = await cli(["init", "--store-path", "~/t1-ssd", "--store", "t1", "--yes", "--json"], real());
    expect(setup.code).toBe(0);
    expect(existsSync(join(ssd, "repo/config"))).toBe(true);
    box.file("work/web/.env", "TOKEN=op://vault/item\n");
    symlinkSync("src/main.ts", join(box.home, "work/web/link"));
    const run = await cli(["offload", "work:web", "--store", "t1", "--yes", "--json"], real());
    expect(run.code).toBe(0);
    const data = envelope(run.out).data;
    expect(existsSync(join(box.home, "work/web"))).toBe(false);
    const store = fsBlobStore(host, ssd);
    const opened = await localStores(host, env).open("t1", { kind: "local", path: ssd }, "t1-pw");
    if (!opened.ok) throw new Error(opened.finding.message);
    const listed = await opened.value.engine.list({ tags: [`plainport:op=${data.op}`] });
    expect(listed.ok && listed.value.length).toBe(1);
    const registry = JSON.parse(readFileSync(box.paths.registryFile, "utf8"));
    const id = Object.entries(registry.projects as Record<string, { path: string }>).find(
      ([, e]) => e.path === "web",
    )?.[0];
    const violations = await invariantViolations({
      paths: box.paths,
      device: JSON.parse(readFileSync(box.paths.deviceFile, "utf8")).id,
      project: { id, dir: join(box.home, "work/web") },
      roots: [join(box.home, "work")],
      store: { name: "t1", blob: store, engine: opened.value.engine },
    });
    expect(violations).toEqual([]);
  }, 120_000);
});
