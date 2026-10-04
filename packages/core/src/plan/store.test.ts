import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeLocalIo } from "../node-io.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { ulid } from "../ulid.ts";
import { PLAN_TTL_MS, type Plan } from "./schema.ts";
import { listPlans, prunePlans, readPlan, savePlan } from "./store.ts";

const NOW = new Date("2026-10-03T12:00:00.000Z");
let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox("plainport-plans-");
});
afterEach(() => sb.cleanup());

const aPlan = (at: Date = NOW, over: Partial<Plan> = {}): Plan => ({
  id: ulid(at.getTime()),
  kind: "offload",
  project: { address: "work:web", root: "work", path: "web" },
  fingerprint: "sha256:00",
  include: { files: 1, bytes: 2, largest: [{ path: "a", bytes: 2 }] },
  strip: [],
  findings: [],
  phases: ["resolve", "preflight"],
  estimate: { uploadBytes: 2 },
  expiresAt: new Date(at.getTime() + PLAN_TTL_MS).toISOString(),
  ...over,
});

describe("plan store: approved plans live under plans/ and expire after one hour", () => {
  test("a saved plan reads back while it is fresh", async () => {
    const plan = aPlan();
    await savePlan(nodeLocalIo, sb.paths, plan);
    const file = join(sb.paths.plansDir, `${plan.id}.json`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, plan });
    expect(await readPlan(nodeLocalIo, sb.paths, plan.id, new Date(NOW.getTime() + 59 * 60 * 1000))).toEqual({
      ok: true,
      value: plan,
    });
  });

  test("a plan read after its hour is plan.expired (exit 6), with the fix to plan again", async () => {
    const plan = aPlan();
    await savePlan(nodeLocalIo, sb.paths, plan);
    const read = await readPlan(nodeLocalIo, sb.paths, plan.id, new Date(NOW.getTime() + PLAN_TTL_MS));
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.exitCode).toBe(6);
      expect(read.finding.code).toBe("plan.expired");
      expect(read.finding.fix).toBe("plainport offload work:web --dry-run");
    }
  });

  test("an unknown id, or one that is not a ULID, is plan.not-found (exit 4)", async () => {
    for (const id of [ulid(NOW.getTime()), "../../etc/passwd", "01J9Z6KB"]) {
      const read = await readPlan(nodeLocalIo, sb.paths, id, NOW);
      expect(!read.ok && [read.finding.code, read.exitCode]).toEqual(["plan.not-found", 4]);
    }
  });

  test("a plan file that does not match the schema is contract.invalid", async () => {
    const id = ulid(NOW.getTime());
    await savePlan(nodeLocalIo, sb.paths, aPlan());
    writeFileSync(join(sb.paths.plansDir, `${id}.json`), '{"v":1,"plan":{"id":"x"}}');
    const read = await readPlan(nodeLocalIo, sb.paths, id, NOW);
    expect(!read.ok && read.finding.code).toBe("contract.invalid");
  });

  test("listPlans returns the fresh plans only; prunePlans removes plans long expired, saving removes nothing (N5)", async () => {
    const old = aPlan(new Date(NOW.getTime() - 3 * PLAN_TTL_MS));
    const stale = aPlan(new Date(NOW.getTime() - PLAN_TTL_MS - 1));
    const fresh = aPlan(new Date(NOW.getTime() - 1000));
    await savePlan(nodeLocalIo, sb.paths, old);
    await savePlan(nodeLocalIo, sb.paths, stale);
    writeFileSync(join(sb.paths.plansDir, "notes.txt"), "not a plan");
    await savePlan(nodeLocalIo, sb.paths, fresh);
    expect(await listPlans(nodeLocalIo, sb.paths, NOW)).toEqual([{ id: fresh.id, kind: "offload" }]);
    // A dry run saves its plan and writes nothing else.
    expect(existsSync(join(sb.paths.plansDir, `${old.id}.json`))).toBe(true);
    // Plans expired for more than another hour are deleted by a real run; others stay to explain plan.expired.
    await prunePlans(nodeLocalIo, sb.paths, NOW);
    expect(existsSync(join(sb.paths.plansDir, `${old.id}.json`))).toBe(false);
    expect(readdirSync(sb.paths.plansDir).sort()).toEqual(
      [`${fresh.id}.json`, `${stale.id}.json`, "notes.txt"].sort(),
    );
  });

  test("listPlans on a device with no plans folder is empty", async () => {
    expect(await listPlans(nodeLocalIo, sb.paths, NOW)).toEqual([]);
  });

  test("a plan with a block finding is never approvable (D38)", async () => {
    const blocked = aPlan(NOW, {
      findings: [{ code: "git.locked", severity: "block", message: "locked", allowable: true }],
    });
    const warned = aPlan(new Date(NOW.getTime() + 1), {
      findings: [{ code: "git.unpushed", severity: "warn", message: "unpushed", allowable: true }],
    });
    await savePlan(nodeLocalIo, sb.paths, blocked);
    await savePlan(nodeLocalIo, sb.paths, warned);
    expect(await listPlans(nodeLocalIo, sb.paths, NOW)).toEqual([{ id: warned.id, kind: "offload" }]);
  });
});
