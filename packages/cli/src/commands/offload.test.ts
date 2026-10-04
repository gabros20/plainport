import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fsBlobStore } from "@plainport/blob-fs";
import { isUlid, nodeLocalIo, PLAN_TTL_MS, PlanSchema, StubSchema, ulid } from "@plainport/core";
import { testHost as macosTestHost } from "@plainport/host-macos/testing";
import { describeT1 } from "../../../../test/tiers.ts";
import { fakeEngine } from "../../../core/src/testing/fake-engine.ts";
import { testHost } from "../../../core/src/testing/host.ts";
import {
  captureTree,
  type InvariantSubject,
  invariantViolations,
  type TreeCapture,
} from "../../../core/src/testing/invariants.ts";
import { makeSandbox, type Sandbox } from "../../../core/src/testing/sandbox.ts";
import { gate } from "../gate.ts";
import { Cancellation } from "../interrupt.ts";
import { preloadPlans } from "../plans.ts";
import { type Ports, positionalsOf } from "../registry.ts";
import { localStores } from "../stores.ts";
import { capture, fakeEngineHooks, fakeRepositoryAt, sandboxPorts } from "../testing.ts";
import { REGISTRY } from "./index.ts";
import { renderPlan } from "./offload.ts";

let box: Sandbox;
const NOW = new Date("2026-10-03T12:00:00Z");

beforeEach(async () => {
  released = undefined;
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

/** The project folder as it stood when release began: invariant 1 checks the committed snapshot against it. */
let released: TreeCapture | undefined;
const ports = (over: Partial<Ports> = {}): Ports =>
  sandboxPorts(box.home, {
    clock: { now: () => NOW },
    system: testHost({
      faults: {
        onStep: (step) => {
          if (step === "offload.release.trash") released = captureTree(join(box.home, "work/web"));
        },
      },
    }),
    ...over,
  });
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

  test("--dry-run --json carries next: the exact command that runs the plan, as the human plan prints it (agent smoke)", async () => {
    const data = envelope((await cli(["offload", "work:web", "--dry-run", "--json"])).out).data;
    expect(data.next).toEqual({
      command: `plainport offload work:web --plan ${data.id}`,
      reason: `runs this plan instead of --yes, until ${data.expiresAt}, while the folder still matches it`,
    });
    const human = await cli(["offload", "work:web", "--dry-run"]);
    const id = /plan {6}([0-9A-Z]{26}) /.exec(human.out)?.[1] ?? "";
    expect(human.out).toContain(`→ plainport offload work:web --plan ${id}\n`);
  });

  test("the dry run changes nothing in the project and saves its plan under plans/", async () => {
    const run = await cli(["offload", "work:web", "--dry-run", "--json"]);
    const { id } = envelope(run.out).data;
    expect(existsSync(join(box.paths.plansDir, `${id}.json`))).toBe(true);
    expect(existsSync(join(box.home, "work/web/node_modules/vite/index.js"))).toBe(true);
    expect(existsSync(join(box.home, "work/web.plainport"))).toBe(false);
  });

  /** The project as a git repository, with git's own environment kept inside the sandbox. */
  const gitRepo = () => {
    const git = Bun.spawnSync(["git", "init", "-q", join(box.home, "work/web")], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: box.home, GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(git.exitCode).toBe(0);
  };

  test("gitignored files travel: git says which, .git/info/exclude included; the plan names them in --json and the human plan (agent smoke, AGENTS rule 2)", async () => {
    gitRepo();
    box.file("work/web/.git/info/exclude", ".env\n");
    box.file("work/web/.gitignore", "node_modules/\ndist/\n*.sqlite\n");
    box.file("work/web/.env", "TOKEN=op://vault/item\n");
    box.file("work/web/data/dev.sqlite", "db");
    box.file("work/web/data/.gitignore", "!keep.sqlite\n");
    box.file("work/web/data/keep.sqlite", "kept by a negation");
    const json = await cli(["offload", "work:web", "--dry-run", "--json"]);
    const data = envelope(json.out).data;
    expect(PlanSchema.safeParse(data).success).toBe(true);
    expect(data.include.gitignored).toEqual({ files: 2, paths: [".env", "data/dev.sqlite"] });
    const human = await cli(["offload", "work:web", "--dry-run"]);
    expect(human.out).toContain(
      "  ignored   .env · data/dev.sqlite: gitignored, and they travel; only what a plugin declares regenerable is stripped\n",
    );
  });

  test("a folder that is not a git repository has no gitignored list, whatever its .gitignore says", async () => {
    box.file("work/web/.gitignore", ".env\n");
    box.file("work/web/.env", "TOKEN=op://vault/item\n");
    const data = envelope((await cli(["offload", "work:web", "--dry-run", "--json"])).out).data;
    expect(data.include.gitignored).toBeUndefined();
  });

  test("a gitignored list git could not complete says so, in the human plan too (quality r1 minor 5)", () => {
    const plan = PlanSchema.parse({
      id: ulid(NOW.getTime()),
      kind: "offload",
      project: { address: "work:web", root: "work", path: "web", dir: "/w/web", store: "local" },
      fingerprint: "sha256:x",
      include: {
        files: 1,
        bytes: 1,
        largest: [],
        gitignored: { files: 1, paths: [".env"], incomplete: true },
      },
      strip: [],
      findings: [],
      phases: [],
      estimate: { uploadBytes: 1 },
      expiresAt: NOW.toISOString(),
    });
    expect(renderPlan(plan)).toContain(
      "  ignored   .env: gitignored, and they travel; only what a plugin declares regenerable is stripped (incomplete: git could not be asked in every repository, so more may travel)\n",
    );
  });

  test("a plan without gitignored files says nothing about them", async () => {
    const data = envelope((await cli(["offload", "work:web", "--dry-run", "--json"])).out).data;
    expect(data.include.gitignored).toBeUndefined();
  });

  test("help offload says gitignored files such as .env travel (agent smoke)", async () => {
    const run = await cli(["help", "offload"]);
    expect(run.out).toContain(
      "gitignored files such as .env and local databases always travel; only what a plugin declares regenerable (node_modules, build output) is stripped",
    );
  });

  test("with keepLocalFor, the arrival step says the install is skipped when onload renames the kept copy back (D71)", async () => {
    writeFileSync(box.paths.configFile, 'version = 1\n[offload]\nkeepLocalFor = "24h"\n');
    const data = envelope((await cli(["offload", "work:web", "--dry-run", "--json"])).out).data;
    expect(data.arrival).toEqual([
      {
        part: "deps",
        outcome: "hydrate",
        detail: "npm ci",
        note: "skipped when onload renames back the local copy kept for 24h (keepLocalFor), which still has its dependencies",
      },
    ]);
    const human = await cli(["offload", "work:web", "--dry-run"]);
    expect(human.out).toContain(
      "  arrival   npm ci at onload; skipped when onload renames back the local copy kept for 24h (keepLocalFor), which still has its dependencies\n",
    );
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
    // A blocked plan has nothing to run: no next.
    expect(env.data.next).toBeUndefined();
  });

  test("--allow applies to a dry run (D50): an allowed blocker leaves an approvable plan the same --allow runs", async () => {
    lockedRepo();
    const human = await cli(["offload", "work:web", "--dry-run", "--allow", "git.locked"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("  allowed   git.locked  ");
    expect(human.out).toMatch(/--plan [0-9A-Z]{26} --allow git\.locked\n$/);
    const planned = await cli(["offload", "work:web", "--dry-run", "--allow", "git.locked", "--json"]);
    expect(planned.code).toBe(0);
    const plan = envelope(planned.out).data;
    expect(plan.options).toMatchObject({ allow: ["git.locked"] });
    const fresh = await preloadPlans(ports().io, ports().env, NOW);
    const without = await cli(["offload", "work:web", "--plan", plan.id, "--json"], { plans: fresh });
    expect(without.code).toBe(6);
    expect(envelope(without.out).error.finding.code).toBe("plan.stale");
    const run = await cli(["offload", "work:web", "--plan", plan.id, "--allow", "git.locked", "--json"], {
      plans: fresh,
    });
    expect(run.code).toBe(0);
  });

  test("offload.verify = full is refused with usage.invalid until M5 (D50)", async () => {
    box.file(box.paths.configFile.slice(box.home.length + 1), 'version = 1\n[offload]\nverify = "full"\n');
    const run = await cli(["offload", "work:web", "--dry-run", "--json"]);
    expect(run.code).toBe(2);
    expect(envelope(run.out).error.finding.code).toBe("usage.invalid");
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
      now: NOW,
      paths: box.paths,
      device,
      project: { id, dir: dir() },
      roots: [join(box.home, "work")],
      store: {
        name: "local",
        blob: fsBlobStore(nodeLocalIo, ssd()),
        engine: fakeEngine(fakeRepositoryAt(ssd())),
      },
      ...(released === undefined ? {} : { released }),
      stripped: ["node_modules", "dist"],
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
        localCopy: "deleted",
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
    expect(run.out).toMatch(/^offloaded work:web to local as snapshot [0-9A-Z]{26}; freeing [0-9.]+ KB\n/);
    expect(run.out).toContain(`stub      ${dir()}.plainport`);
    await expectInvariants();
  });

  test("with keepLocalFor nothing is freed yet: the result names the bytes kept, until when, and that gc frees them (agent smoke)", async () => {
    writeFileSync(box.paths.configFile, 'version = 1\n[offload]\nkeepLocalFor = "24h"\n');
    const run = await cli(["offload", "work:web", "--yes", "--json"]);
    expect(run.code).toBe(0);
    const data = envelope(run.out).data;
    const until = new Date(NOW.getTime() + 24 * 3_600_000).toISOString();
    expect(data).toMatchObject({
      freedBytes: 0,
      keptBytes: 615_970,
      keepUntil: until,
      freedBy: "plainport gc",
    });
    const schema = REGISTRY.find((c) => c.name === "offload")?.output;
    expect(schema?.safeParse(data).success).toBe(true);
    await expectInvariants();
  });

  test("the human result of a kept copy says what stays on disk and when gc frees it (agent smoke)", async () => {
    writeFileSync(box.paths.configFile, 'version = 1\n[offload]\nkeepLocalFor = "24h"\n');
    const run = await cli(["offload", "work:web", "--yes"]);
    expect(run.code).toBe(0);
    const until = new Date(NOW.getTime() + 24 * 3_600_000).toISOString();
    expect(run.out).toMatch(/^offloaded work:web to local as snapshot [0-9A-Z]{26}; nothing freed yet\n/);
    expect(run.out).toMatch(
      new RegExp(
        `\nkept {6}${box.home}/work/\\.plainport-trash/[0-9A-Z]{26} \\(616 KB\\) until ${until}; plainport gc frees it then \\(plainport gc --now --yes frees it early\\)\n`,
      ),
    );
  });

  test("without keepLocalFor the folder is freed now: keptBytes is 0 and no freedBy", async () => {
    const run = await cli(["offload", "work:web", "--yes", "--json"]);
    const data = envelope(run.out).data;
    expect(data.freedBytes).toBe(615_970);
    expect(data.keptBytes).toBe(0);
    expect(data.freedBy).toBeUndefined();
    // The trash path is marked as already being deleted, not kept (C1), and is not named: it is soon gone (D77).
    expect(data.localCopy).toBe("deleted");
    expect(data).not.toHaveProperty("trash");
    // Honest about what is known when it returns: the delete started, and its guard may still refuse (r3 #4).
    expect(data.deleteStarted).toBe(true);
  });

  test("the human result without keepLocalFor says the local copy is being deleted, checked first (C1, r3 #4)", async () => {
    const run = await cli(["offload", "work:web", "--yes"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain(
      "\ndeleting  the local copy in the background (keepLocalFor is 0); it is checked first, and plainport status says if it was kept\n",
    );
    expect(run.out).not.toContain(".plainport-trash");
  });

  test("with keepLocalFor the local copy is kept (C1)", async () => {
    writeFileSync(box.paths.configFile, 'version = 1\n[offload]\nkeepLocalFor = "24h"\n');
    const data = envelope((await cli(["offload", "work:web", "--yes", "--json"])).out).data;
    expect(data.localCopy).toBe("kept");
    expect(data.trash).toBe(join(box.home, "work/.plainport-trash", data.op));
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
    // The fresh plan is the error's data (D14, D38), valid against the plan schema.
    const fresh2 = envelope(run.out).data;
    expect(PlanSchema.safeParse(fresh2).success).toBe(true);
    expect(envelope(run.out).error.hint).toContain(fresh2.id);
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

  /** Ports whose host edits the folder once the offload is committed: the D52 guard keeps it. */
  const editAfterCommit = () =>
    ports({
      system: testHost({
        faults: {
          onStep: (step) => {
            if (step === "offload.committed") writeFileSync(join(dir(), "src/late.ts"), "late\n");
          },
        },
      }),
    });

  test("a folder edited after the commit exits 8 told apart from a fork: kind diverged-after-commit (D52)", async () => {
    const run = await cli(["offload", "work:web", "--yes", "--json"], editAfterCommit());
    expect(run.code).toBe(8);
    const env = envelope(run.out);
    expect(env).toMatchObject({
      error: { code: 8, finding: { code: "offload.diverged-after-commit" } },
      data: { exitCode: 8, kind: "diverged-after-commit", project: "work:web", store: "local" },
    });
    expect(env.data.snapshot).toBe(env.data.op);
    expect(existsSync(join(dir(), "src/late.ts"))).toBe(true);
    await expectInvariants();
  });

  test("the human line for a folder edited after the commit says the snapshot is the head and the edits stay", async () => {
    const run = await cli(["offload", "work:web", "--yes"], editAfterCommit());
    expect(run.code).toBe(8);
    expect(run.out).toMatch(
      /^offloaded work:web to local as snapshot [0-9A-Z]{26}, now its head; the folder changed after the commit, so it stays here with its edits, and the next offload builds on that snapshot\n$/,
    );
    expect(run.out).not.toContain("fork");
    await expectInvariants();
  });

  test("a head that moves during the upload exits 8 with the kept snapshot as data (D14)", async () => {
    const first = await cli(["offload", "work:web", "--yes", "--json"]);
    expect(first.code).toBe(0);
    const { op } = envelope(first.out).data;
    // The project back at its place (as an onload would leave it), and another device's offload since.
    const registry = JSON.parse(readFileSync(box.paths.registryFile, "utf8"));
    const id = Object.entries(registry.projects as Record<string, { path: string }>).find(
      ([, e]) => e.path === "web",
    )?.[0] as string;
    box.file("work/web/package.json", "{}\n");
    rmSync(`${dir()}.plainport`);
    const other = ulid();
    const event = {
      v: 1,
      id: other,
      op: other,
      type: "offloaded",
      device: ulid(),
      at: "2026-10-03T12:30:00.000Z",
      project: id,
      root: registry.roots.work,
      path: "web",
      base: op,
      snapshot: other,
      stored: { local: "d".repeat(64) },
      stats: { files: 1, bytes: 1, strippedBytes: 0, ecosystems: [] },
    };
    fakeEngineHooks.set(ssd(), {
      duringSnapshot: () =>
        writeFileSync(join(ssd(), "meta/v1/events", `${other}.json`), `${JSON.stringify(event)}\n`),
    });
    const run = await cli(["offload", "work:web", "--yes", "--json"]);
    expect(run.code).toBe(8);
    expect(envelope(run.out)).toMatchObject({
      ok: false,
      error: { code: 8, finding: { code: "catalog.head-moved" } },
      data: {
        exitCode: 8,
        kind: "fork",
        project: "work:web",
        store: "local",
        stored: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(existsSync(join(dir(), "package.json"))).toBe(true);
  });

  test("a dry run records --allow, so the same --allow runs its plan (and the plan line names it)", async () => {
    const planned = await cli(["offload", "work:web", "--dry-run", "--allow", "git.locked", "--json"]);
    expect(planned.code).toBe(0);
    const plan = envelope(planned.out).data;
    expect(plan.options).toMatchObject({ allow: ["git.locked"] });
    const human = await cli(["offload", "work:web", "--dry-run", "--allow", "git.locked", "--keep-deps"]);
    expect(human.out).toMatch(/--plan [0-9A-Z]{26} --keep-deps --allow git\.locked\n$/);
    const fresh = await preloadPlans(ports().io, ports().env, NOW);
    const run = await cli(["offload", "work:web", "--plan", plan.id, "--allow", "git.locked", "--json"], {
      plans: fresh,
    });
    expect(run.code).toBe(0);
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
  test("a real SIGKILL right after the rename (D52): the folder waits in the trash, the journal at release.trash, invariants hold", async () => {
    const host = macosTestHost();
    const env = {
      HOME: box.home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      PLAINPORT_STORE_PASSWORD: "t1-pw",
    };
    const real = () => ports({ env, system: host, io: host, stores: localStores(host, env) });
    const ssd = join(box.home, "t1-ssd");
    const setup = await cli(["init", "--store-path", "~/t1-ssd", "--store", "t1", "--yes", "--json"], real());
    expect(setup.code).toBe(0);
    const before = captureTree(join(box.home, "work/web"));
    const child = join(box.home, "crash.ts");
    const src = join(import.meta.dir, "..");
    writeFileSync(
      child,
      [
        `import { REGISTRY } from ${JSON.stringify(join(src, "commands/index.ts"))};`,
        `import { capture, sandboxPorts } from ${JSON.stringify(join(src, "testing.ts"))};`,
        `import { localStores } from ${JSON.stringify(join(src, "stores.ts"))};`,
        `import { testHost } from ${JSON.stringify(join(src, "../../host-macos/src/testing.ts"))};`,
        `const env = ${JSON.stringify(env)};`,
        'const host = testHost({ faults: { at: "offload.release.renamed", action: "kill" } });',
        `const ports = sandboxPorts(env.HOME, { env, system: host, io: host, stores: localStores(host, env) });`,
        'const ran = await capture(["offload", "work:web", "--store", "t1", "--yes", "--json"], REGISTRY, { ports });',
        "console.log(ran.out);",
        "process.exit(0);",
      ].join("\n"),
    );
    // The child runs with this test process's own environment (its guard protects the real home); the sandbox is
    // what its ports are given.
    const run = Bun.spawn([process.execPath, child], {
      cwd: box.home,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    await run.exited;
    const killed = run.signalCode === "SIGKILL";
    expect({
      signal: run.signalCode,
      out: killed ? "" : `${await new Response(run.stdout).text()}${await new Response(run.stderr).text()}`,
    }).toEqual({ signal: "SIGKILL", out: "" });
    const journals = readdirSync(box.paths.journalDir).filter((n) => n.endsWith(".json"));
    expect(journals).toHaveLength(1);
    const journal = JSON.parse(readFileSync(join(box.paths.journalDir, journals[0] as string), "utf8"));
    expect(journal.step).toBe("offload.release.trash");
    expect(existsSync(join(box.home, "work/web"))).toBe(false);
    expect(existsSync(join(journal.trash, "web/src/main.ts"))).toBe(true);
    expect(readdirSync(box.paths.locksDir)).toEqual([`${journal.project.id}.lock`]);
    const opened = await localStores(host, env).open("t1", { kind: "local", path: ssd }, "t1-pw");
    if (!opened.ok) throw new Error(opened.finding.message);
    const violations = await invariantViolations({
      now: NOW,
      paths: box.paths,
      device: JSON.parse(readFileSync(box.paths.deviceFile, "utf8")).id,
      project: { id: journal.project.id, dir: join(box.home, "work/web") },
      roots: [join(box.home, "work")],
      store: { name: "t1", blob: fsBlobStore(host, ssd), engine: opened.value.engine },
      released: before,
      stripped: ["node_modules", "dist"],
    });
    // Invariant 2 (a stub exactly when shelved) holds only once recover finishes release (Task 14); 1 and 3 hold now.
    expect(violations.filter((v) => !v.startsWith("invariant 2"))).toEqual([]);
    expect(violations).toEqual(["invariant 2: the stub is missing, but the project is shelved"]);
  }, 120_000);

  test("init creates the repository; offload snapshots, verifies and releases; restic lists what the catalog names", async () => {
    const host = macosTestHost({
      faults: {
        onStep: (step) => {
          if (step === "offload.release.trash") released = captureTree(join(box.home, "work/web"));
        },
      },
    });
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
      now: NOW,
      paths: box.paths,
      device: JSON.parse(readFileSync(box.paths.deviceFile, "utf8")).id,
      project: { id, dir: join(box.home, "work/web") },
      roots: [join(box.home, "work")],
      store: { name: "t1", blob: store, engine: opened.value.engine },
      ...(released === undefined ? {} : { released }),
      stripped: ["node_modules", "dist"],
    });
    expect(violations).toEqual([]);
  }, 120_000);
});
