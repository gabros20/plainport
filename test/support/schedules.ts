// The race schedules the M2 gate needs (M2 Task 14; DESIGN.md "Testing and fault injection", Q16, Q17): devices on
// one store interleaved at the sagas' pause seams, each schedule stating, device by device, what every device must
// observe. After a schedule, the invariants are checked on every device (1–3) and on the store (4–6).
//
// A schedule whose feature is not built yet has no `run`: schedules.test.ts registers it as a test.todo naming its
// owner, the task that turns it on, and the gate test fails while any remains. A task turning one on writes its run
// here and removes its owner.

import { expect } from "bun:test";
import { foldCatalog } from "../../packages/core/src/catalog/fold.ts";
import {
  catalogInvariantViolations,
  invariantViolations,
} from "../../packages/core/src/testing/invariants.ts";
import { type Device, type Devices, envelope, expectCode } from "./two-devices.ts";

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
}

const OFFLOAD = (path = "web") => ["offload", `work:${path}`, "--yes", "--json"];
const ONLOAD = (path = "web") => ["onload", `work:${path}`, "--no-hydrate", "--json"];

/** The one project's ULID, from the first offload in the store. */
const projectId = async (world: Devices): Promise<string> => {
  const event = (await world.events()).find((e) => e.type === "offloaded");
  if (event?.type !== "offloaded") throw new Error("no offloaded event in the store");
  return event.project;
};

/** Invariants 1–3 on every device and 4–6 on the store, given what the store held before the race began. */
export const expectInvariants = async (
  world: Devices,
  before: { events: Awaited<ReturnType<Devices["events"]>>; snapshots: readonly string[] },
): Promise<void> => {
  const id = await projectId(world);
  for (const d of world.devices) {
    await d.settled();
    expect({ device: d.name, problems: await invariantViolations(await d.subject(id)) }).toEqual({
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
      await expectInvariants(world, before);
    },
  },
  {
    id: "S2",
    title: "both checked: both pass the head check, then both append",
    owner: 23,
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a":
        "the first to append commits; it keeps its folder if it sees the fork at its re-read, else releases it",
      "dev-b":
        "the second sees the fork at its commit or re-read and keeps its folder; both snapshots are kept",
    },
  },
  {
    id: "S3",
    title: "asymmetric: A appends and releases before B appends (Q16's residual)",
    owner: 23,
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a":
        "releases its folder; on a remote store the trash is held for the conflict grace and kept as conflict-retained once B's fork names it",
      "dev-b": "forks and keeps its folder; both snapshots stay in the store and the catalog",
    },
  },
  {
    id: "S4",
    title: "strict onloads: two simultaneous strict onloads (Q17)",
    owner: 22,
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a": "may onload: it observed no holder at its fresh read",
      "dev-b":
        "may onload too when it observed none; the fold names one holder, and the race ends at offload in a fork, never a lost update",
    },
  },
  {
    id: "S5",
    title: "lost acknowledgement at the event append",
    owner: 23,
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a":
        "its append landed but it never heard so: the journal stays, and recover finds the event and goes on",
      "dev-b": "sees A's event like any other and forks or keeps going as the head says",
    },
  },
  {
    id: "S6",
    title: "delayed visibility of the other's event (fake store)",
    owner: 21,
    devices: ["dev-a", "dev-b"],
    outcomes: {
      "dev-a": "commits; its event is invisible to B for a while",
      "dev-b":
        "on a store whose profile does not admit release without visibility, keeps its folder until the event is seen",
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
export const todoSchedules = (): Schedule[] => SCHEDULES.filter((s) => s.run === undefined);
