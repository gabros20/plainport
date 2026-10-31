// Advisory leases across devices (M2 Task 22, Q17; DESIGN "Fold rules → Lease", "Onload process" step 2, "Offload
// process" step 2): two sandboxed homes on one store, each with its own device id, config, registry and mirror. A
// lease is the fold's one holder; "warn" lets a second working copy happen, "strict" refuses an observed holder.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allEvents, type FakeDevice, fakeDevices } from "../../../../test/support/fake-devices.ts";
import { foldCatalog } from "../catalog/fold.ts";
import { semanticBlobStore } from "../testing/semantic-blob-store.ts";

const STRICT = '[onload]\nleases = "strict"';

let devices: FakeDevice[] = [];
afterEach(async () => {
  for (const d of devices) await d.box.cleanupSettled();
  devices = [];
});

/** dev-a and dev-b on one store; dev-a has offloaded `web`, so the project is shelved with no lease. */
const world = async (config: Record<string, string> = {}) => {
  const store = semanticBlobStore();
  devices = await fakeDevices(store, ["dev-a", "dev-b"], { config });
  const [a, b] = devices as [FakeDevice, FakeDevice];
  a.box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  a.box.file("work/web/src/main.ts", "export const main = 0;\n");
  const first = await a.offload();
  if (!first.ok) throw new Error(`${first.finding.code}: ${first.finding.message}`);
  for (let i = 0; i < 400 && existsSync(join(a.box.home, "work/.plainport-trash")); i++) await Bun.sleep(25);
  return { store, a, b, head: first.value.snapshot };
};

/** Turns a device's leases to "strict" from its next command on. */
const strict = (d: FakeDevice) =>
  writeFileSync(d.box.paths.configFile, `${readFileSync(d.box.paths.configFile, "utf8")}\n${STRICT}\n`);

const codes = (d: FakeDevice) => d.findings.map((f) => f.code);
const leaseOf = async (store: ReturnType<typeof semanticBlobStore>) => {
  const events = await allEvents(store);
  const id = events.find((e) => e.type === "offloaded")?.project as string;
  return foldCatalog(events).projects[id]?.lease ?? null;
};

describe("leases across two devices (Q17)", () => {
  test("warn: B onloads a project A holds with lease.held naming A, and both working copies exist", async () => {
    const { store, a, b } = await world();
    expect((await a.onload()).ok).toBe(true);
    expect(codes(a)).not.toContain("lease.held");
    const byB = await b.onload();
    expect(byB.ok).toBe(true);
    const warned = b.findings.filter((f) => f.code === "lease.held");
    expect(warned.map((f) => f.severity)).toEqual(["warn"]);
    expect(warned[0]?.message).toContain(`device ${a.device.id}`);
    expect(existsSync(a.dir())).toBe(true);
    expect(existsSync(b.dir())).toBe(true);
    // The fold names one holder: A, whose onload came first over the same head.
    expect((await leaseOf(store))?.device).toBe(a.device.id);
  });

  test("strict: B refuses with exit 8 an onload of a project A holds, read fresh past its own mirror", async () => {
    const { a, b } = await world({ "dev-b": STRICT });
    // B's mirror is brought up to the store while nobody holds the project.
    expect((await b.view())?.lease).toBeUndefined();
    expect((await a.onload()).ok).toBe(true);
    const byB = await b.onload();
    expect(!byB.ok && [byB.exitCode, byB.finding.code]).toEqual([8, "lease.held"]);
    expect(!byB.ok && byB.finding.message).toContain(`device ${a.device.id}`);
    expect(!byB.ok && byB.finding.fix).toContain('onload.leases = "warn"');
    // Nothing landed on B; A's copy stands.
    expect(existsSync(b.dir())).toBe(false);
    expect(b.engine.calls).toHaveLength(0);
    expect(existsSync(a.dir())).toBe(true);
  });

  test("strict observes only what it reads: with no holder, a strict onload goes on", async () => {
    const { store, b } = await world({ "dev-b": STRICT });
    const byB = await b.onload();
    expect(byB.ok).toBe(true);
    expect(codes(b)).not.toContain("lease.held");
    expect((await leaseOf(store))?.device).toBe(b.device.id);
  });

  test("B's status names A's device as the lease holder, since when, with leased-elsewhere; A's says this device", async () => {
    const { store, a, b } = await world();
    expect((await a.onload()).ok).toBe(true);
    const lease = await leaseOf(store);
    const fromB = await b.view();
    expect(fromB?.lease).toEqual({
      device: a.device.id,
      at: lease?.at as string,
      base: lease?.base as string,
      here: false,
    });
    expect(fromB?.conditions).toContain("leased-elsewhere");
    expect(fromB?.conditionDetails.find((c) => c.condition === "leased-elsewhere")?.message).toContain(
      `device ${a.device.id.slice(0, 10)}`,
    );
    const fromA = await a.view();
    expect(fromA?.lease?.here).toBe(true);
    expect(fromA?.conditions).not.toContain("leased-elsewhere");
  });

  test("an offload from the non-holding copy warns lease.held and goes on; the holder's own offload does not warn", async () => {
    const { store, a, b } = await world();
    expect((await a.onload()).ok).toBe(true);
    expect((await b.onload()).ok).toBe(true);
    expect((await leaseOf(store))?.device).toBe(a.device.id);
    writeFileSync(join(b.dir(), "src/b.ts"), "export const b = 1;\n");
    b.findings.length = 0;
    const byB = await b.offload();
    expect(byB.ok).toBe(true);
    const warned = b.findings.filter((f) => f.code === "lease.held");
    expect(warned.map((f) => f.severity)).toEqual(["warn"]);
    expect(warned[0]?.message).toContain(`device ${a.device.id}`);
    // A still holds the lease: its copy becomes a fork when it is offloaded.
    expect((await leaseOf(store))?.device).toBe(a.device.id);
    a.findings.length = 0;
    writeFileSync(join(a.dir(), "src/a.ts"), "export const a = 1;\n");
    const byA = await a.offload();
    expect(!byA.ok && [byA.exitCode, byA.finding.code]).toEqual([8, "catalog.head-moved"]);
    expect(codes(a)).not.toContain("lease.held");
    expect(readFileSync(join(a.dir(), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
  });

  test("strict governs onload only (D114): an offload from the non-holding copy under strict warns lease.held and goes on", async () => {
    const { store, a, b } = await world();
    expect((await a.onload()).ok).toBe(true);
    expect((await b.onload()).ok).toBe(true);
    expect((await leaseOf(store))?.device).toBe(a.device.id);
    strict(b);
    writeFileSync(join(b.dir(), "src/b.ts"), "export const b = 1;\n");
    b.findings.length = 0;
    const byB = await b.offload();
    expect(byB.ok).toBe(true);
    const warned = b.findings.filter((f) => f.code === "lease.held");
    expect(warned.map((f) => f.severity)).toEqual(["warn"]);
    expect(warned[0]?.message).toContain(`device ${a.device.id}`);
    expect(warned[0]?.fix).not.toContain("strict");
    expect((await allEvents(store)).filter((e) => e.type === "offloaded")).toHaveLength(2);
  });

  test("the dry run reports the lease.held the run would warn of; the holder's previews nothing (D114)", async () => {
    const { a, b } = await world();
    expect((await a.onload()).ok).toBe(true);
    expect((await b.onload()).ok).toBe(true);
    strict(b);
    const previewed = await b.previewLease();
    expect([previewed?.code, previewed?.severity]).toEqual(["lease.held", "warn"]);
    expect(previewed?.message).toContain(`device ${a.device.id}`);
    expect(await a.previewLease()).toBeUndefined();
  });

  test("the holder offloads first; the other copy's offload refuses head-moved naming --fork, and --fork keeps it as a fork (D114)", async () => {
    const { store, a, b } = await world();
    expect((await a.onload()).ok).toBe(true);
    expect((await b.onload()).ok).toBe(true);
    strict(a);
    strict(b);
    writeFileSync(join(a.dir(), "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(b.dir(), "src/b.ts"), "export const b = 1;\n");
    const byA = await a.offload();
    if (!byA.ok) throw new Error(byA.finding.message);
    // Without --fork: refused before anything is uploaded, its fix the exact command.
    const calls = b.engine.calls.length;
    const refused = await b.offload();
    expect(!refused.ok && [refused.exitCode, refused.finding.code]).toEqual([8, "catalog.head-moved"]);
    expect(!refused.ok && refused.finding.fix).toContain("plainport offload work:web --fork --yes");
    expect(!refused.ok && refused.data).toBeUndefined();
    expect(b.engine.calls).toHaveLength(calls);
    // With it: uploaded, kept as a fork at the commit (F1), the folder on its own snapshot, the project conflicted.
    const forked = await b.offload("web", undefined, { fork: true });
    expect(!forked.ok && [forked.exitCode, forked.finding.code]).toEqual([8, "catalog.head-moved"]);
    const data = (!forked.ok ? forked.data : undefined) as {
      kind: string;
      snapshot: string;
      detail?: string;
    };
    expect([data.kind, data.detail]).toEqual(["fork", undefined]);
    expect(!forked.ok && forked.finding.fix).toContain("plainport compare work:web");
    expect(readFileSync(join(b.dir(), "src/b.ts"), "utf8")).toBe("export const b = 1;\n");
    expect(existsSync(`${b.dir()}.plainport`)).toBe(false);
    expect((await b.entry())?.base).toBe(data.snapshot);
    const events = await allEvents(store);
    const project =
      foldCatalog(events).projects[events.find((e) => e.type === "offloaded")?.project as string];
    expect(project?.status).toBe("conflicted");
    expect(project?.conflicts.flat().sort()).toEqual([byA.value.snapshot, data.snapshot].sort());
  });

  test("a copy behind the head says so in its view, and its next step is offload --fork --yes", async () => {
    const { a, b } = await world();
    expect((await a.onload()).ok).toBe(true);
    expect((await b.onload()).ok).toBe(true);
    writeFileSync(join(a.dir(), "src/a.ts"), "export const a = 1;\n");
    expect((await a.offload()).ok).toBe(true);
    const view = await b.view();
    expect(view?.conditions).toContain("head-moved");
    expect(view?.next?.command).toBe("plainport offload work:web --fork --yes");
  });
});
