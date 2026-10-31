// The race schedules the M2 gate needs (M2 Task 14; DESIGN.md "Testing and fault injection", Q16, Q17): devices on
// one store interleaved at the sagas' pause seams, each schedule stating, device by device, what every device must
// observe. After a schedule, the invariants are checked on every device (1–3) and on the store (4–6).
//
// A schedule whose feature is not built yet has no `run`: schedules.test.ts registers it as a test.todo naming its
// owner, the task that turns it on, and the gate test fails while any remains. A task turning one on writes its run
// here and removes its owner. A schedule a binary on a local store cannot stage (a store whose listings lag, S6) runs
// in process instead (`runInProcess`), its devices on the semantic fake (test/support/fake-devices.ts).

import { expect } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeEventKey } from "../../packages/core/src/catalog/codec.ts";
import { foldCatalog } from "../../packages/core/src/catalog/fold.ts";
import { capabilitiesOf, type StoreSemantics } from "../../packages/core/src/ports/blob-store.ts";
import {
  type CatalogInvariantSubject,
  catalogInvariantViolations,
  invariantViolations,
} from "../../packages/core/src/testing/invariants.ts";
import { MEMORY_SEMANTICS } from "../../packages/core/src/testing/memory-blob-store.ts";
import {
  type SemanticBlobStore,
  semanticBlobStore,
} from "../../packages/core/src/testing/semantic-blob-store.ts";
import { allEvents, type FakeDevice, fakeDevices } from "./fake-devices.ts";
import { type Device, type Devices, envelope, expectCode, type Ran } from "./two-devices.ts";

export interface Schedule {
  id: string;
  title: string;
  /** The task that turns the schedule on; absent once it runs. */
  owner?: number;
  /** The devices it needs. */
  devices: readonly string[];
  /** What each device must observe, by device. */
  outcomes: Readonly<Record<string, string>>;
  /** The schedule itself, asserting each outcome; absent while it is a todo. */
  run?: (world: Devices) => Promise<void>;
  /** The schedule in process, on the semantic fake, when a binary on a local store cannot stage it. */
  runInProcess?: () => Promise<void>;
}

const OFFLOAD = (path = "web") => ["offload", `work:${path}`, "--yes", "--json"];
const ONLOAD = (path = "web") => ["onload", `work:${path}`, "--no-hydrate", "--json"];

/** The one project's ULID, from the first offload in the store. */
const projectId = async (world: Devices): Promise<string> => {
  const event = (await world.events()).find((e) => e.type === "offloaded");
  if (event?.type !== "offloaded") throw new Error("no offloaded event in the store");
  return event.project;
};

/**
 * Invariants 1–3 on every device and 4–6 on the store, given what the store held before the race began. Invariant 1's
 * `unseen` (the events a device's release read could not have seen, Q16's residual) is derived from each device's
 * trace, never written by hand; `strict` names the onloads run under onload.leases = "strict", for invariant 5.
 */
export const expectInvariants = async (
  world: Devices,
  before: { events: Awaited<ReturnType<Devices["events"]>>; snapshots: readonly string[] },
  { strict = [] }: { strict?: CatalogInvariantSubject["strictOnloads"] } = {},
): Promise<void> => {
  const id = await projectId(world);
  for (const d of world.devices) {
    await d.settled();
    const subject = { ...(await d.subject(id)), unseen: await d.unseen() };
    expect({ device: d.name, problems: await invariantViolations(subject) }).toEqual({
      device: d.name,
      problems: [],
    });
  }
  // The recorder is live: it saw the binaries' uploads.
  expect(world.recorded().some((c) => c.tool === "restic" && c.args.includes("backup"))).toBe(true);
  expect(
    catalogInvariantViolations({
      events: await world.events(),
      eventsBefore: before.events,
      snapshotsBefore: before.snapshots,
      snapshotsNow: await world.snapshots(),
      recorded: world.recorded(),
      strictOnloads: strict,
    }),
  ).toEqual([]);
};

/** A shelved project both devices have onloaded from one head: the start of every offload race. */
const bothOnloaded = async (world: Devices, a: Device, b: Device): Promise<void> => {
  world.project(a);
  expectCode(await a.run(OFFLOAD()), 0, `${a.name}: the first offload`);
  await a.settled();
  expectCode(await b.run(ONLOAD()), 0, `${b.name}: onload`);
  // The default leases ("warn") let the second working copy happen, with lease.held.
  expectCode(await a.run(ONLOAD()), 0, `${a.name}: onload`);
};

/** A device's registry entry for the web project: its base is the snapshot its copy is on. */
const baseOf = (d: Device): string | undefined => {
  const registry = JSON.parse(readFileSync(d.paths.registryFile, "utf8")) as {
    projects: Record<string, { path: string; base?: string }>;
  };
  return Object.values(registry.projects).find((e) => e.path === "web")?.base;
};

/** The offload journals open on a device's disk. */
const openJournals = (journalDir: string): { kind: string; step: string }[] =>
  existsSync(journalDir)
    ? readdirSync(journalDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(journalDir, f), "utf8")) as { kind: string; step: string })
    : [];

/** Turns a device's leases to "strict" from its next command on (its config.toml gains an [onload] table). */
export const strictLeases = (d: Device): void =>
  appendFileSync(d.paths.configFile, '\n[onload]\nleases = "strict"\n');

/** The codes of the findings a --json run streamed before its envelope. */
export const streamedCodes = (ran: Ran): string[] =>
  ran.out
    .trim()
    .split("\n")
    .slice(0, -1)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as { type?: string; finding?: { code?: string } };
        return event.type === "finding" && event.finding?.code !== undefined ? [event.finding.code] : [];
      } catch {
        return [];
      }
    });

/**
 * Two strict onloads stand at onload.lease-checked together, each having observed no holder at its fresh read, and
 * both onload (Q17: a lease is advisory). The fold names one holder; each device's status says whose it is. Returns
 * the holder, the other, the store before the race and the onloads for invariant 5.
 */
const strictRace = async (world: Devices) => {
  const a = world.device("dev-a");
  const b = world.device("dev-b");
  world.project(a);
  expectCode(await a.run(OFFLOAD()), 0, `${a.name}: the first offload`);
  await a.settled();
  strictLeases(a);
  strictLeases(b);
  const before = { events: await world.events(), snapshots: await world.snapshots() };

  // Both read the catalog fresh and pass the lease check before either appends its onloaded event.
  const onloadA = a.start(ONLOAD(), { pauseAt: "onload.lease-checked" });
  await onloadA.paused();
  const onloadB = b.start(ONLOAD(), { pauseAt: "onload.lease-checked" });
  await onloadB.paused();
  onloadA.resume();
  onloadB.resume();
  const [byA, byB] = await Promise.all([onloadA.done, onloadB.done]);
  // Each device, by its own report: it observed no holder, and onloaded.
  for (const [d, ran] of [
    [a, byA],
    [b, byB],
  ] as const) {
    expectCode(ran, 0, `${d.name}: strict onload`);
    expect({ device: d.name, findings: streamedCodes(ran).filter((c) => c === "lease.held") }).toEqual({
      device: d.name,
      findings: [],
    });
    expect(await Bun.file(`${d.dir()}/src/main.ts`).exists()).toBe(true);
  }
  const strict = [
    { device: a.id, op: envelope(byA)?.data?.op as string, before: before.events.map((e) => e.id) },
    { device: b.id, op: envelope(byB)?.data?.op as string, before: before.events.map((e) => e.id) },
  ];

  // The fold names one holder; each device's status says whose it is.
  const id = await projectId(world);
  const lease = foldCatalog(await world.events()).projects[id]?.lease;
  const holder = lease?.device === a.id ? a : b;
  const other = holder === a ? b : a;
  expect([a.id, b.id]).toContain(lease?.device as string);
  const statusOf = async (d: Device) => {
    const ran = await d.run(["status", "work:web", "--json"]);
    expectCode(ran, 0, `${d.name}: status`);
    return envelope(ran)?.data as { lease?: { device: string; here: boolean }; conditions: string[] };
  };
  const seenByHolder = await statusOf(holder);
  expect([seenByHolder.lease?.here, seenByHolder.conditions.includes("leased-elsewhere")]).toEqual([
    true,
    false,
  ]);
  const seenByOther = await statusOf(other);
  expect([seenByOther.lease?.device, seenByOther.lease?.here]).toEqual([holder.id, false]);
  expect(seenByOther.conditions).toContain("leased-elsewhere");
  const human = await other.run(["status", "work:web"]);
  expect(human.out).toContain(`device ${holder.id.slice(0, 10)} since`);

  await Bun.write(`${holder.dir()}/src/held.ts`, "export const held = 1;\n");
  await Bun.write(`${other.dir()}/src/other.ts`, "export const other = 1;\n");
  return { id, holder, other, before, strict };
};

/** The restic backups the binaries ran so far. */
const backups = (world: Devices) =>
  world.recorded().filter((c) => c.tool === "restic" && c.args.includes("backup")).length;

/**
 * S4: after the strict race, strict governs onload only (D114): the non-holder's dry run previews lease.held, and its
 * offload warns lease.held and goes on, first, while the holder's offload, verified, stands at its commit. The
 * holder's then forks: both snapshots are kept, the project is conflicted, nothing is lost.
 */
const strictOnloads = async (world: Devices): Promise<void> => {
  const { id, holder, other, before, strict } = await strictRace(world);
  const previewed = await other.run(["offload", "work:web", "--dry-run", "--json"]);
  expectCode(previewed, 0, `${other.name}: offload --dry-run`);
  expect(streamedCodes(previewed)).toContain("lease.held");

  const offloadHolder = holder.start(OFFLOAD(), { pauseAt: "offload.verified" });
  await offloadHolder.paused();
  const first = await other.run(OFFLOAD());
  expectCode(first, 0, `${other.name}: strict offload of the non-holding copy`);
  expect(streamedCodes(first)).toContain("lease.held");
  const committed = envelope(first)?.data;
  offloadHolder.resume();
  const second = await offloadHolder.done;
  expectCode(second, 8, `${holder.name}: offload after the other's commit`);
  expect(envelope(second)?.error?.finding?.code).toBe("catalog.head-moved");
  const forked = envelope(second)?.data;
  expect([forked?.kind, forked?.project]).toEqual(["fork", "work:web"]);
  // The holder keeps its folder with its edit; the store keeps both snapshots, the project conflicted between them.
  expect(await Bun.file(`${holder.dir()}/src/held.ts`).text()).toBe("export const held = 1;\n");
  const project = foldCatalog(await world.events()).projects[id];
  expect(project?.status).toBe("conflicted");
  expect(project?.conflicts.flat().sort()).toEqual(
    [committed?.snapshot as string, forked?.snapshot as string].sort(),
  );
  // The holder's event came after the other's release read the catalog: Q16's residual, read from the traces.
  await expectInvariants(world, before, { strict });
};

/**
 * S4b: after the strict race, the holder offloads first. The non-holder's offload is behind the head: refused with
 * catalog.head-moved before anything is uploaded, its fix the exact command; offload --fork --yes then uploads it and
 * keeps it as a fork (F1), so the project is conflicted with both snapshots kept and compare reaches the other copy.
 */
const holderFirst = async (world: Devices): Promise<void> => {
  const { id, holder, other, before, strict } = await strictRace(world);
  const first = await holder.run(OFFLOAD());
  expectCode(first, 0, `${holder.name}: the holder's offload`);
  const committed = envelope(first)?.data?.snapshot as string;
  await holder.settled();

  const uploaded = backups(world);
  const refused = await other.run(OFFLOAD());
  expectCode(refused, 8, `${other.name}: offload behind the head`);
  expect(envelope(refused)?.error?.finding?.code).toBe("catalog.head-moved");
  expect(envelope(refused)?.error?.finding?.fix).toContain("plainport offload work:web --fork --yes");
  expect(backups(world)).toBe(uploaded);
  expect((await other.run(["status", "work:web", "--json"])).out).toContain(
    '"command":"plainport offload work:web --fork --yes"',
  );

  const kept = await other.run(["offload", "work:web", "--fork", "--yes", "--json"]);
  expectCode(kept, 8, `${other.name}: offload --fork`);
  const forked = envelope(kept)?.data;
  expect([forked?.kind, forked?.detail, forked?.project]).toEqual(["fork", undefined, "work:web"]);
  expect(await Bun.file(`${other.dir()}/src/other.ts`).text()).toBe("export const other = 1;\n");
  expect(await Bun.file(`${other.dir()}.plainport`).exists()).toBe(false);
  expect(baseOf(other)).toBe(forked?.snapshot as string);
  const project = foldCatalog(await world.events()).projects[id];
  expect(project?.status).toBe("conflicted");
  expect(project?.conflicts.flat().sort()).toEqual([committed, forked?.snapshot as string].sort());
  // The conflict is reachable: compare writes the holder's copy beside this one.
  const compared = await other.run(["compare", "work:web", "--json"]);
  expectCode(compared, 0, `${other.name}: compare`);
  const sets = envelope(compared)?.data?.sets as { snapshot: string }[];
  expect(sets.map((s) => s.snapshot)).toEqual([committed]);
  expectCode(
    await other.run(["compare", "work:web", "--clean", "--json"]),
    0,
    `${other.name}: compare --clean`,
  );
  await expectInvariants(world, before, { strict });
};

/**
 * A profile without list-after-write whose acknowledged writes may not be synced (SFTP's, measured, Task 17), so it
 * does not admit release: listings lag, and a conditional create still elects (a root claim needs one).
 */
const UNSEEN: StoreSemantics = {
  ...MEMORY_SEMANTICS,
  listAfterWrite: { value: false, evidence: "asserted" },
  durability: { value: "acked-unsynced", evidence: "asserted" },
};

const okOf = <T>(
  r: { ok: true; value: T } | { ok: false; finding: { code: string; message: string } },
): T => {
  if (!r.ok) throw new Error(`${r.finding.code}: ${r.finding.message}`);
  return r.value;
};

/**
 * S6: dev-a commits while the store's listings leave its event out, then dev-b offloads. With `seen` "at-commit" the
 * event is listed while B verifies, so B's fresh read at its commit finds the fork. With "never" it stays unlisted
 * through B's commit, and both commit: release waits on the store's profile, never on visibility. On UNSEEN
 * (acked-unsynced) neither profile admits release, so both keep their folders with their journals open; on a durable
 * store (`durable`) both release. Either way both snapshots stay, and the fold shows the fork once A's event lists.
 */
const delayedVisibility = async (seen: "at-commit" | "never", durable = false): Promise<void> => {
  // Listings leave out what was written since the last settle(): A's event is invisible to B until then.
  const fake = semanticBlobStore({ listOmitsRecent: true });
  let profile: StoreSemantics | undefined;
  const store: SemanticBlobStore = {
    ...fake,
    semantics: () => profile ?? fake.semantics(),
    capabilities: () => (profile === undefined ? fake.capabilities() : capabilitiesOf(profile)),
  };
  const [a, b] = (await fakeDevices(store, ["dev-a", "dev-b"])) as [FakeDevice, FakeDevice];
  try {
    a.box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
    a.box.file("work/web/src/main.ts", "export const main = 0;\n");
    okOf(await a.offload());
    store.settle();
    okOf(await b.onload());
    okOf(await a.onload());
    store.settle();
    writeFileSync(join(a.dir(), "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(b.dir(), "src/b.ts"), "export const b = 1;\n");
    const before = {
      events: await allEvents(store),
      snapshots: a.engine.repository.snapshots.map((s) => s.info.id),
    };
    if (seen === "never")
      profile = durable ? { ...UNSEEN, durability: { value: "durable", evidence: "asserted" } } : UNSEEN;
    const releases = seen === "never" && durable;

    // dev-a commits; its event is in the store, and no listing names it yet.
    const byA = await a.offload();
    const eventA = (await allEvents(store)).find(
      (e) => e.type === "offloaded" && e.device === a.device.id && !before.events.some((x) => x.id === e.id),
    );
    if (eventA?.type !== "offloaded")
      throw new Error(`dev-a committed no offloaded event: ${JSON.stringify(byA)}`);
    const listed = await store.list("meta/v1/events/");
    expect(listed.ok && listed.value.some((e) => e.key === storeEventKey(eventA.id))).toBe(false);
    if (seen === "at-commit") {
      // dev-a, on its disk: released, its stub names its snapshot.
      expect(okOf(byA).snapshot).toBe(eventA.snapshot);
      expect(JSON.parse(readFileSync(`${a.dir()}.plainport`, "utf8")).snapshot).toBe(eventA.snapshot);
      // dev-b: the event is listed while it verifies, after its head check before the upload.
      b.engine.hooks.duringListing = () => {
        b.engine.hooks.duringListing = undefined;
        store.settle();
      };
    } else if (releases) {
      // dev-a: released on a durable store, though no listing names its event yet.
      expect(okOf(byA).snapshot).toBe(eventA.snapshot);
      expect(JSON.parse(readFileSync(`${a.dir()}.plainport`, "utf8")).snapshot).toBe(eventA.snapshot);
    } else {
      // dev-a: committed, and its folder stays: the profile does not admit release.
      expect(byA.ok ? "released" : [byA.exitCode, byA.finding.code]).toEqual([6, "store.semantics-unknown"]);
      expect(readFileSync(join(a.dir(), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
      expect(existsSync(`${a.dir()}.plainport`)).toBe(false);
    }
    const byB = await b.offload();
    expect(b.engine.calls).toHaveLength(1); // it uploaded: the head check before the upload passed
    expect(byB.ok ? "released" : [byB.exitCode, byB.finding.code]).toEqual(
      seen === "at-commit"
        ? [8, "catalog.head-moved"]
        : releases
          ? "released"
          : [6, "store.semantics-unknown"],
    );
    if (releases) {
      // dev-b: released too: its commit could not see A's event, and release does not wait for it.
      expect(existsSync(`${b.dir()}.plainport`)).toBe(true);
    } else {
      expect(readFileSync(join(b.dir(), "src/b.ts"), "utf8")).toBe("export const b = 1;\n");
      expect(existsSync(`${b.dir()}.plainport`)).toBe(false);
    }
    if (seen === "never" && !releases) {
      // Each device keeps its offload journal at the commit, for recover to finish the release once admitted.
      for (const d of [a, b]) {
        const open = readdirSync(d.box.paths.journalDir)
          .filter((f) => f.endsWith(".json"))
          .map(
            (f) =>
              JSON.parse(readFileSync(join(d.box.paths.journalDir, f), "utf8")) as {
                kind: string;
                step: string;
              },
          );
        expect({ device: d.name, open: open.map((j) => j.kind) }).toEqual({
          device: d.name,
          open: ["offload"],
        });
      }
    }

    // Once the event is seen: both snapshots kept, the project conflicted between them.
    store.settle();
    const events = await allEvents(store);
    // dev-b never offloaded before: its one offloaded event is its own.
    const ofB = events.find((e) => e.type === "offloaded" && e.device === b.device.id);
    const id = eventA.project;
    const project = foldCatalog(events).projects[id];
    expect(project?.status).toBe("conflicted");
    expect(project?.conflicts.flat().sort()).toEqual(
      [eventA.snapshot, ofB?.type === "offloaded" ? ofB.snapshot : ""].sort(),
    );

    // Invariants 1–3 on each device, 4–6 on the store.
    for (const d of [a, b]) {
      for (let i = 0; i < 400 && existsSync(join(d.box.home, "work/.plainport-trash")); i++)
        await Bun.sleep(25);
      expect({
        device: d.name,
        problems: await invariantViolations({
          now: new Date(),
          paths: d.box.paths,
          device: d.device.id,
          project: { id, dir: d.dir() },
          roots: [join(d.box.home, "work")],
          store: { name: "ssd", blob: store, engine: d.engine },
          ...(d.released === undefined ? {} : { released: d.released }),
          stripped: ["node_modules"],
          // What each release read could not see (Q16): B's event came after A's release, and A's was not listed yet
          // when B's release read the catalog; derived from what each re-read listed.
          unseen: await d.unseen(),
        }),
      }).toEqual({ device: d.name, problems: [] });
    }
    expect(
      catalogInvariantViolations({
        events,
        eventsBefore: before.events,
        snapshotsBefore: before.snapshots,
        snapshotsNow: a.engine.repository.snapshots.map((s) => s.info.id),
      }),
    ).toEqual([]);
  } finally {
    for (const d of [a, b]) await d.box.cleanupSettled();
  }
};

/**
 * S5: dev-a's offloaded event lands and its acknowledgement is lost, while dev-b uploads. dev-a never heard: its
 * journal stays at commit.start with its folder untouched. dev-b's commit sees dev-a's event like any other and keeps
 * its snapshot as a fork (F1). dev-a's recover finds its own event on the store, so it committed, and its re-read sees
 * dev-b's fork: its folder stays on its own snapshot (F2).
 */
const lostAcknowledgement = async (): Promise<void> => {
  const store = semanticBlobStore();
  const [a, b] = (await fakeDevices(store, ["dev-a", "dev-b"])) as [FakeDevice, FakeDevice];
  try {
    a.box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
    a.box.file("work/web/src/main.ts", "export const main = 0;\n");
    okOf(await a.offload());
    for (let i = 0; i < 400 && existsSync(join(a.box.home, "work/.plainport-trash")); i++)
      await Bun.sleep(25);
    okOf(await b.onload());
    okOf(await a.onload());
    writeFileSync(join(a.dir(), "src/a.ts"), "export const a = 1;\n");
    writeFileSync(join(b.dir(), "src/b.ts"), "export const b = 1;\n");
    const before = {
      events: await allEvents(store),
      snapshots: a.engine.repository.snapshots.map((s) => s.info.id),
    };

    // dev-b uploads; meanwhile dev-a's append lands and its acknowledgement is lost.
    let byA: Awaited<ReturnType<FakeDevice["offload"]>> | undefined;
    b.engine.hooks.duringSnapshot = async () => {
      b.engine.hooks.duringSnapshot = undefined;
      store.loseAckNext();
      byA = await a.offload();
    };
    const byB = await b.offload();
    // dev-a: never heard; its journal stays at commit.start, its folder as it was, no stub.
    expect(byA === undefined || byA.ok ? "heard" : [byA.exitCode, byA.finding.code]).toEqual([
      9,
      "store.unreachable",
    ]);
    expect(openJournals(a.box.paths.journalDir).map((j) => j.step)).toEqual(["offload.commit.start"]);
    expect(readFileSync(join(a.dir(), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(`${a.dir()}.plainport`)).toBe(false);
    const eventA = (await allEvents(store)).find(
      (e) => e.type === "offloaded" && e.device === a.device.id && !before.events.some((x) => x.id === e.id),
    );
    if (eventA?.type !== "offloaded") throw new Error("dev-a's event did not land");
    // dev-b: sees dev-a's event at its commit like any other: a fork (F1), its folder kept on its own snapshot.
    expect(byB.ok ? "released" : [byB.exitCode, byB.finding.code]).toEqual([8, "catalog.head-moved"]);
    const forkB = byB.ok ? undefined : (byB.data as { kind: string; detail?: string; snapshot: string });
    expect([forkB?.kind, forkB?.detail]).toEqual(["fork", undefined]);
    expect(readFileSync(join(b.dir(), "src/b.ts"), "utf8")).toBe("export const b = 1;\n");
    expect((await b.entry())?.base).toBe(forkB?.snapshot);

    // dev-a's recover finds its event, so the offload committed; its re-read sees dev-b's fork (F2).
    const recovered = await a.recover();
    const report = (recovered.ok ? recovered.value : recovered.data) as {
      operations: { step: string; outcome: string; state: string; snapshot: string }[];
    };
    expect(report.operations.map((o) => [o.step, o.outcome, o.state])).toEqual([
      ["offload.commit.start", "forked", "conflicted"],
    ]);
    expect(readFileSync(join(a.dir(), "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(`${a.dir()}.plainport`)).toBe(false);
    expect((await a.entry())?.base).toBe(eventA.snapshot);
    expect(openJournals(a.box.paths.journalDir)).toEqual([]);
    const project = foldCatalog(await allEvents(store)).projects[eventA.project];
    expect(project?.conflicts.flat().sort()).toEqual([eventA.snapshot, forkB?.snapshot as string].sort());

    for (const d of [a, b])
      expect({
        device: d.name,
        problems: await invariantViolations({
          now: new Date(),
          paths: d.box.paths,
          device: d.device.id,
          project: { id: eventA.project, dir: d.dir() },
          roots: [join(d.box.home, "work")],
          store: { name: "ssd", blob: store, engine: d.engine },
          stripped: ["node_modules"],
        }),
      }).toEqual({ device: d.name, problems: [] });
    expect(
      catalogInvariantViolations({
        events: await allEvents(store),
        eventsBefore: before.events,
        snapshotsBefore: before.snapshots,
        snapshotsNow: a.engine.repository.snapshots.map((s) => s.info.id),
      }),
    ).toEqual([]);
  } finally {
    for (const d of [a, b]) await d.box.cleanupSettled();
  }
};

/** Both devices' offloads, each with an edit of its own, about to race. */
const editBoth = async (a: Device, b: Device) => {
  await Bun.write(`${a.dir()}/src/a.ts`, "export const a = 1;\n");
  await Bun.write(`${b.dir()}/src/b.ts`, "export const b = 1;\n");
};

/** exit 8's data, kind fork after the commit (F2): the folder kept with its edit, no stub, its base its snapshot. */
const expectKeptAfterCommit = async (d: Device, ran: Ran, edit: string) => {
  expectCode(ran, 8, `${d.name}: offload`);
  expect(envelope(ran)?.error?.finding?.code).toBe("catalog.head-moved");
  const data = envelope(ran)?.data;
  expect([data?.exitCode, data?.kind, data?.detail, data?.project]).toEqual([
    8,
    "fork",
    "after-commit",
    "work:web",
  ]);
  expect(await Bun.file(`${d.dir()}/src/${edit}.ts`).text()).toBe(`export const ${edit} = 1;\n`);
  expect(await Bun.file(`${d.dir()}.plainport`).exists()).toBe(false);
  expect(baseOf(d)).toBe(data?.snapshot as string);
  expect(openJournals(d.paths.journalDir)).toEqual([]);
  return data?.snapshot as string;
};

export const SCHEDULES: readonly Schedule[] = [
  {
    id: "S1",
    title: "sequential: B checks after A commits, so B forks before its commit",
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a":
        "offload exits 0: its snapshot is the head, its folder is released and its stub names that snapshot",
      "dev-b":
        "passes its early head check and verifies, then A commits; at its commit the head has moved, so offload exits 8 with kind fork: its snapshot is kept as a fork, its folder stays with its edit and gets no stub; the project is conflicted",
    },
    run: async (world) => {
      const a = world.device("dev-a");
      const b = world.device("dev-b");
      await bothOnloaded(world, a, b);
      const before = { events: await world.events(), snapshots: await world.snapshots() };
      await Bun.write(`${a.dir()}/src/a.ts`, "export const a = 1;\n");
      await Bun.write(`${b.dir()}/src/b.ts`, "export const b = 1;\n");

      // B uploads and verifies first (its early head check passes), and stands there while A commits.
      const offloadB = b.start(OFFLOAD(), { pauseAt: "offload.verified" });
      await offloadB.paused();
      const byA = await a.run(OFFLOAD());
      expectCode(byA, 0, "dev-a: offload");
      const committed = envelope(byA)?.data;
      offloadB.resume();
      const byB = await offloadB.done;
      expectCode(byB, 8, "dev-b: offload");
      const forked = envelope(byB)?.data;

      // dev-a, by its own report and on its disk.
      expect(committed?.stub).toBe(`${a.dir()}.plainport`);
      await a.settled();
      expect(await Bun.file(a.dir()).exists()).toBe(false);
      expect((await Bun.file(`${a.dir()}.plainport`).json()).snapshot).toBe(committed?.snapshot);
      // dev-b, by its own report and on its disk.
      expect(envelope(byB)?.error?.finding?.code).toBe("catalog.head-moved");
      // (bun's toMatchObject writes an asymmetric matcher into the object it checks: plain fields only.)
      expect([forked?.exitCode, forked?.kind, forked?.project]).toEqual([8, "fork", "work:web"]);
      expect(await Bun.file(`${b.dir()}/src/b.ts`).text()).toBe("export const b = 1;\n");
      expect(await Bun.file(`${b.dir()}.plainport`).exists()).toBe(false);
      // The store: both snapshots kept, the project conflicted between them.
      const state = foldCatalog(await world.events());
      const project = state.projects[await projectId(world)];
      expect(project?.status).toBe("conflicted");
      expect(project?.conflicts.flat().sort()).toEqual(
        [committed?.snapshot as string, forked?.snapshot as string].sort(),
      );
      // dev-b's fork was appended after dev-a's release read the catalog: Q16's residual, read from the traces.
      await expectInvariants(world, before);
    },
  },
  {
    id: "S2",
    title: "both checked: both pass the head check, then both append",
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a":
        "the first to append commits; it keeps its folder if it sees the fork at its re-read (here: dev-b appends before it), else releases it. Kept: exit 8, kind fork, detail after-commit, no stub, its base its own snapshot, its journal closed",
      "dev-b":
        "the second appends too, having passed its head check, and sees the fork at its re-read: exit 8, kind fork, detail after-commit; it keeps its folder on its own snapshot. Both snapshots are kept and the project is conflicted",
    },
    run: async (world) => {
      const a = world.device("dev-a");
      const b = world.device("dev-b");
      await bothOnloaded(world, a, b);
      const before = { events: await world.events(), snapshots: await world.snapshots() };
      await editBoth(a, b);

      // dev-b passes its commit's head check and stands there; dev-a passes its own, appends, and stands committed.
      const offloadB = b.start(OFFLOAD(), { pauseAt: "offload.head-checked" });
      await offloadB.paused();
      const offloadA = a.start(OFFLOAD(), { pauseAt: "offload.committed" });
      await offloadA.paused();
      // dev-b appends now; its re-read sees dev-a's commit. Then dev-a's re-read sees dev-b's.
      offloadB.resume();
      const byB = await offloadB.done;
      offloadA.resume();
      const byA = await offloadA.done;

      const snapA = await expectKeptAfterCommit(a, byA, "a");
      const snapB = await expectKeptAfterCommit(b, byB, "b");
      const project = foldCatalog(await world.events()).projects[await projectId(world)];
      expect(project?.status).toBe("conflicted");
      expect(project?.conflicts.flat().sort()).toEqual([snapA, snapB].sort());
      await expectInvariants(world, before);
    },
  },
  {
    id: "S3",
    title: "asymmetric: A appends and releases before B appends (Q16's residual)",
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a":
        "reaches F3: its re-read sees no fork, so it releases its folder and its stub names its snapshot; on a remote store the trash is held for the conflict grace and kept as conflict-retained once B's fork names it (Task 24)",
      "dev-b":
        "passed its head check before A appended, so it appends too and sees the fork at its re-read (F2): exit 8, kind fork, detail after-commit; it keeps its folder on its own snapshot. Both snapshots stay in the store and the catalog",
    },
    run: async (world) => {
      const a = world.device("dev-a");
      const b = world.device("dev-b");
      await bothOnloaded(world, a, b);
      const before = { events: await world.events(), snapshots: await world.snapshots() };
      await editBoth(a, b);

      // dev-b passes its commit's head check and stands there while dev-a offloads to its end.
      const offloadB = b.start(OFFLOAD(), { pauseAt: "offload.head-checked" });
      await offloadB.paused();
      const byA = await a.run(OFFLOAD());
      expectCode(byA, 0, "dev-a: offload");
      const released = envelope(byA)?.data;
      await a.settled();
      offloadB.resume();
      const byB = await offloadB.done;

      // dev-a: F3, released.
      expect(await Bun.file(a.dir()).exists()).toBe(false);
      expect((await Bun.file(`${a.dir()}.plainport`).json()).snapshot).toBe(released?.snapshot);
      expect(baseOf(a)).toBe(released?.snapshot as string);
      // dev-b: F2, kept.
      const snapB = await expectKeptAfterCommit(b, byB, "b");
      const project = foldCatalog(await world.events()).projects[await projectId(world)];
      expect(project?.status).toBe("conflicted");
      expect(project?.conflicts.flat().sort()).toEqual([released?.snapshot as string, snapB].sort());
      // dev-b's event came after dev-a's release read the catalog: Q16's residual for dev-a.
      await expectInvariants(world, before);
    },
  },
  {
    id: "S4",
    title: "strict onloads: two simultaneous strict onloads (Q17)",
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a": "may onload: it observed no holder at its fresh read",
      "dev-b":
        "may onload too when it observed none; the fold names one holder. The non-holder's offload warns lease.held (also in its dry run) and goes on, since strict governs onload only (D114), and the race ends at offload in a fork, never a lost update",
    },
    run: strictOnloads,
  },
  {
    id: "S4b",
    title: "strict onloads, the holder offloads first: the other copy forks with --fork (D114)",
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a":
        "whichever device holds the lease offloads first, and its snapshot is the head; its folder is released",
      "dev-b":
        "the other copy's offload is refused with catalog.head-moved before anything is uploaded, its fix naming offload --fork --yes; with --fork it is uploaded and kept as a fork, its folder on its own snapshot, the project conflicted with both snapshots kept, and compare reaches the other copy",
    },
    run: holderFirst,
  },
  {
    id: "S5",
    title: "lost acknowledgement at the event append",
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a":
        "its append landed but it never heard so: the journal stays at commit.start with the folder as it was, and recover finds the event and goes on; here its re-read sees dev-b's fork, so the folder stays on its own snapshot (F2)",
      "dev-b":
        "sees A's event like any other and forks or keeps going as the head says; here its commit's head check finds it, so its snapshot is kept as a fork and its folder stays (F1)",
    },
    runInProcess: lostAcknowledgement,
  },
  {
    id: "S6",
    title: "delayed visibility of the other's event (fake store)",
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a": "commits; its event is invisible to B's listings for a while",
      "dev-b":
        "passes its head check before the upload, since A's event is not listed yet. Its commit reads the store fresh (never its mirror): once A's event is listed it keeps its folder as a fork. While it is not, B commits too, since release waits on the store's profile and never on visibility: on a store whose profile does not admit release (writes acknowledged before they are synced) each device keeps its folder with its journal open (store.semantics-unknown) until recover finds the profile admits release; on a durable store both release. Both snapshots stay, and the fold shows the fork once A's event is listed",
    },
    runInProcess: async () => {
      await delayedVisibility("at-commit");
      await delayedVisibility("never");
      await delayedVisibility("never", true);
    },
  },
  {
    id: "S7",
    title:
      "resolution races: competing resolutions, and a resolution while the other device's journal is pending",
    owner: 25,
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a": "its resolution and B's fold to one result on every device (D103), whatever the order",
      "dev-b": "its pending operation settles by the resolved head and loses no snapshot",
    },
  },
  {
    id: "S8",
    title:
      "D87 aliases: a remote store reachable through a local mount or alias placed under a stripped folder",
    owner: 24,
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a": "the delete guard refuses at trash.delete.checked; the trash and the store stay",
      "dev-b": "sees every event and snapshot it saw before",
    },
  },
];

/** The schedules still waiting for their owner. */
export const todoSchedules = (): Schedule[] =>
  SCHEDULES.filter((s) => s.run === undefined && s.runInProcess === undefined);
