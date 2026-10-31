// The bootstrap protocol (DESIGN.md "Bootstrap", Q9, D99): every attempt initialises its own repository at
// repos/<attempt>/, stands in the elected publication of meta/v1/store.json v2, and only the winner publishes. These
// tests run several devices (sandboxed homes, different passwords) against one semantic fake store.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Failure, Result } from "@plainport/contract";
import fc from "fast-check";
import { STORE_CLAIMS_PREFIX, STORE_IDENTITY_KEY } from "../catalog/identity.ts";
import { journalJsonSchemas, readJournals, writeBootstrapJournal } from "../journal/index.ts";
import { acquireLock } from "../lock.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import { InjectedFault } from "../ports/host.ts";
import { updateRegistry } from "../registry.ts";
import {
  type BootstrapWorld,
  bootstrapWorld,
  keysUnder,
  publishedStore,
  STORE_NAME,
} from "../testing/bootstrap-world.ts";
import { ulid } from "../ulid.ts";
import { BOOTSTRAP_STEPS, type BootstrapDone } from "./bootstrap.ts";

const RUNS = Number(process.env.PLAINPORT_FC_RUNS ?? 40);
const NO_CREATE = { conditionalCreate: false } as const;
const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

let worlds: BootstrapWorld[] = [];
const world = (...args: Parameters<typeof bootstrapWorld>): BootstrapWorld => {
  const w = bootstrapWorld(...args);
  worlds.push(w);
  return w;
};
afterEach(() => {
  for (const w of worlds) w.cleanup();
  worlds = [];
});

const done = (result: Result<BootstrapDone>): BootstrapDone => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};
const failed = (result: Result<unknown>): Failure => {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  return result;
};

describe("bootstrap: a single initialiser", () => {
  test("publishes store.json v2 naming its own repository, initialised with its password, and records the id", async () => {
    const w = world();
    const a = w.device("pw-a");
    const result = done(await a.run());
    expect(result.outcome).toBe("published");
    const attempt = result.id;
    expect(result.repo).toBe(`repos/${attempt}`);
    expect(publishedStore(w.store)).toEqual({
      v: 2,
      id: attempt,
      repo: `repos/${attempt}`,
      catalog: { seal: "none" },
      format: 2,
    });
    expect(w.repos.get(`repos/${attempt}`)).toMatchObject({ initialized: true, password: "pw-a" });
    expect(await a.recorded()).toBe(attempt);
    expect(await a.journals()).toEqual([]);
    expect(keysUnder(w.store, STORE_CLAIMS_PREFIX)).toEqual([
      `${STORE_CLAIMS_PREFIX}${attempt}.json`,
      `${STORE_CLAIMS_PREFIX}${attempt}.publishing`,
    ]);
  });

  test("the seal policy is published once, with the identity", async () => {
    const w = world();
    const result = done(await w.device("pw").run({ seal: "v1" }));
    expect(publishedStore(w.store)).toMatchObject({ id: result.id, catalog: { seal: "v1" } });
  });

  test("the bootstrap journal is published as JSON Schema, with every step", () => {
    const schema = journalJsonSchemas()["bootstrap-journal"] as { title?: string };
    expect(schema.title).toBe("BootstrapJournal");
    expect(BOOTSTRAP_STEPS).toContain("bootstrap.begin");
  });
});

describe("bootstrap: simultaneous initialisers (Q9, R2-7)", () => {
  /** A store whose every call runs when the fast-check scheduler says. */
  const scheduled = (inner: BlobStore, s: fc.Scheduler): BlobStore => ({
    ...inner,
    get: s.scheduleFunction(inner.get.bind(inner)),
    put: s.scheduleFunction(inner.put.bind(inner)),
    list: s.scheduleFunction(inner.list.bind(inner)),
    stat: s.scheduleFunction(inner.stat.bind(inner)),
    delete: s.scheduleFunction(inner.delete.bind(inner)),
  });

  const ALLOWED = [
    "published",
    "store.bootstrap-lost",
    "store.bootstrap-contested",
    "store.bootstrap-undecided",
  ];
  const reached: Record<string, Set<string>> = {
    "conditional create": new Set(),
    "sole candidate": new Set(),
  };
  // Not vacuous: across the runs, the race both elects a winner and has a losing attempt on each route.
  afterAll(() => {
    if (RUNS < 20) return;
    for (const [route, outcomes] of Object.entries(reached)) {
      expect([route, outcomes.has("published")]).toEqual([route, true]);
      expect([route, outcomes.has("store.bootstrap-lost")]).toEqual([route, true]);
    }
  });

  for (const [route, options] of [
    ["conditional create", {}],
    ["sole candidate", NO_CREATE],
  ] as const) {
    test(`${route}: two initialisers with different passwords, delayed inits and lost acknowledgements publish at most one repository`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.scheduler(),
          fc.nat(6),
          fc.boolean(),
          fc.boolean(),
          async (s, lossAt, delayed, together) => {
            const w = world(options);
            // restic init at each attempt's own location, delayed by the scheduler (its config written late).
            if (delayed) w.hooks.duringInit = s.scheduleFunction(async () => {});
            // Each device does local work (its journal) between store calls, which the scheduler does not order; with
            // `together`, each election's first read waits for the other's, so the elections overlap call by call.
            let arrived = 0;
            let meet: () => void = () => {};
            const met = new Promise<void>((resolve) => {
              meet = resolve;
            });
            let puts = 0;
            const lossy: BlobStore = {
              ...w.store,
              put: async (key, data, opts) => {
                if (puts++ === lossAt) w.store.loseAckNext();
                return w.store.put(key, data, opts);
              },
            };
            // The meeting is outside the scheduled calls: the scheduler waits for each call it releases to finish. A
            // device reads store.json once before its attempt begins, and again as its election's first read.
            const inner = scheduled(lossy, s);
            const meeting = (): BlobStore => {
              let reads = 0;
              return {
                ...inner,
                get: async (key) => {
                  if (together && key === STORE_IDENTITY_KEY && ++reads === 2) {
                    if (++arrived === 2) meet();
                    await met;
                  }
                  return inner.get(key);
                },
              };
            };
            const devices = ["pw-a", "pw-b"].map((pw) => w.device(pw));
            for (const d of devices) d.target.blob = meeting();
            const results = await s.waitFor(Promise.all(devices.map((d) => d.run())));
            // Every schedule ends in an outcome the protocol allows, never an unexpected failure.
            for (const r of results) {
              const seen = r.ok ? r.value.outcome : r.finding.code;
              expect(ALLOWED).toContain(seen);
              reached[route]?.add(seen);
            }
            // Whatever was left open is settled by each device's recovery (same attempt id), then nothing more runs.
            for (const d of devices) d.target.blob = w.store;
            for (let round = 0; round < 2; round++) for (const d of devices) await d.recover();
            // Settled: nothing injects a fault after the race, so every attempt is decided by now.
            for (const d of devices) expect(await d.journals()).toEqual([]);

            const published = publishedStore(w.store);
            const won = results.flatMap((r) => (r.ok && r.value.outcome === "published" ? [r.value.id] : []));
            expect(won.length).toBeLessThanOrEqual(1);
            const recorded = await Promise.all(devices.map((d) => d.recorded()));
            const recorders = recorded.filter((id) => id !== undefined);
            expect(recorders.length).toBeLessThanOrEqual(1);
            if (published === undefined) {
              expect(recorders).toEqual([]);
              // Liveness (D109): with every attempt that stood refused, a re-run of the setup is a new attempt and wins.
              const fresh = done(await w.device("pw-c").run());
              expect(fresh.outcome).toBe("published");
              return;
            }
            // One repository is published, and only the device that initialised it ever reached it.
            const winner = published.id as string;
            expect(published.repo).toBe(`repos/${winner}`);
            if (won.length === 1) expect(won[0]).toBe(winner);
            for (const id of recorders) expect(id).toBe(winner);
            const repo = w.repos.get(`repos/${winner}`);
            expect(repo?.initialized).toBe(true);
            const owner = repo?.password;
            expect(new Set(repo?.access.map((a) => a.password))).toEqual(new Set([owner]));
            for (const r of results)
              if (!r.ok && r.finding.code === "store.bootstrap-lost")
                expect(r.finding.message).toContain(winner);
          },
        ),
        { numRuns: RUNS },
      );
    }, 60_000);
  }

  /** Lists wait until both candidacies are written: every candidate is seen by both. */
  const bothVisible = (w: BootstrapWorld) => {
    let candidacies = 0;
    let listed: () => void = () => {};
    const allCandidates = new Promise<void>((resolve) => {
      listed = resolve;
    });
    const gated: BlobStore = {
      ...w.store,
      put: async (key, data, opts) => {
        const put = await w.store.put(key, data, opts);
        if (key.startsWith(STORE_CLAIMS_PREFIX) && key.endsWith(".json") && ++candidacies === 2) listed();
        return put;
      },
      list: async (prefix) => {
        await allCandidates;
        return w.store.list(prefix);
      },
    };
    return { gated, wait: () => new Promise<void>((done) => setTimeout(done, 1)) };
  };

  for (const [route, options] of [
    ["conditional create", {}],
    ["sole candidate", NO_CREATE],
  ] as const) {
    test(`${route}: when both candidates are visible before either lists, the lower id publishes and the other loses (D109)`, async () => {
      const w = world(options);
      const { gated, wait } = bothVisible(w);
      const devices = ["pw-a", "pw-b"].map((pw) => w.device(pw, { wait }));
      for (const d of devices) d.target.blob = gated;
      const results = await Promise.all(devices.map((d) => d.run()));
      const winners = results.flatMap((r) => (r.ok ? [r.value.id] : []));
      const attempts = keysUnder(w.store, STORE_CLAIMS_PREFIX)
        .filter((k) => k.endsWith(".json"))
        .map((k) => k.slice(STORE_CLAIMS_PREFIX.length, -".json".length))
        .sort();
      expect(winners).toEqual([attempts[0] as string]);
      const loser = results.find((r) => !r.ok);
      expect(loser === undefined ? "" : failed(loser).finding.code).toBe("store.bootstrap-lost");
      expect(publishedStore(w.store)?.id).toBe(attempts[0]);
      for (const d of devices) expect(await d.journals()).toEqual([]);
      // Both repositories stay: plainport never deletes one.
      expect([...w.repos.keys()].filter((k) => k.startsWith("repos/"))).toHaveLength(2);
    });

    test(`${route}: a refusing attempt writes nothing after its candidate but its own refusal`, async () => {
      const w = world(options);
      const { gated, wait } = bothVisible(w);
      const devices = ["pw-a", "pw-b"].map((pw) => w.device(pw, { wait }));
      for (const d of devices) d.target.blob = gated;
      await Promise.all(devices.map((d) => d.run()));
      const [low, high] = keysUnder(w.store, STORE_CLAIMS_PREFIX)
        .filter((k) => k.endsWith(".json"))
        .map((k) => k.slice(STORE_CLAIMS_PREFIX.length, -".json".length))
        .sort() as [string, string];
      expect(keysUnder(w.store, STORE_CLAIMS_PREFIX)).toEqual(
        [
          `${STORE_CLAIMS_PREFIX}${low}.json`,
          `${STORE_CLAIMS_PREFIX}${low}.publishing`,
          `${STORE_CLAIMS_PREFIX}${high}.json`,
          `${STORE_CLAIMS_PREFIX}${high}.refused`,
        ].sort(),
      );
    });

    test(`${route}: after a final contested, a re-run of the setup stands as a new attempt and wins (D109)`, async () => {
      const w = world(options);
      // A lower attempt that stands and never decides (its device gone): this attempt refuses, undecided.
      const gone = "00000000000000000000000000";
      await w.store.put(`${STORE_CLAIMS_PREFIX}${gone}.json`, new TextEncoder().encode("{}"));
      const a = w.device("pw-a");
      const undecided = failed(await a.run());
      expect(undecided.finding.code).toBe("store.bootstrap-undecided");
      const [attempt] = await a.journals();
      // The operator withdraws the gone attempt; this attempt's re-run sees every attempt refused: final.
      await w.store.put(
        `${STORE_CLAIMS_PREFIX}${gone}.refused`,
        new TextEncoder().encode(`{"v":1,"id":"${gone}","decision":"refused"}\n`),
      );
      const contested = failed(await a.run());
      expect(contested.finding.code).toBe("store.bootstrap-contested");
      expect(contested.finding.fix).toContain("re-run the setup");
      expect(contested.finding.fix).toContain("every device");
      expect(await a.journals()).toEqual([]);
      // The re-run is a new attempt: the refused ones no longer stand, so it publishes.
      const retry = done(await a.run());
      expect(retry.outcome).toBe("published");
      expect(retry.id).not.toBe(attempt);
      expect(publishedStore(w.store)?.id).toBe(retry.id);
      expect(await a.recorded()).toBe(retry.id);
    });
  }

  test("the loser reports store.bootstrap-lost naming the winner, records nothing and never touches the winner's repository", async () => {
    const w = world(NO_CREATE);
    const a = w.device("pw-a");
    const b = w.device("pw-b");
    // B starts first and pauses inside its restic init; A sets the store up meanwhile.
    let resume: () => void = () => {};
    let paused: () => void = () => {};
    const bPaused = new Promise<void>((r) => {
      paused = r;
    });
    let inits = 0;
    w.hooks.duringInit = async () => {
      if (++inits !== 1) return;
      paused();
      await new Promise<void>((r) => {
        resume = r;
      });
    };
    const running = b.run();
    await bPaused;
    const winner = done(await a.run());
    resume();
    const lost = failed(await running);
    expect(lost.finding.code).toBe("store.bootstrap-lost");
    expect(lost.finding.message).toContain(winner.id);
    expect(lost.data).toMatchObject({ outcome: "lost", winner: winner.id });
    expect(await b.recorded()).toBeUndefined();
    expect(await b.journals()).toEqual([]);
    const theirs = w.repos.get(`repos/${winner.id}`);
    expect(theirs?.access.every((x) => x.password === "pw-a")).toBe(true);
    // The loser's own repository is left as it is, for store test to list.
    expect([...w.repos.entries()].filter(([, r]) => r.password === "pw-b")).toHaveLength(1);
  });
});

describe("bootstrap: adopting a published store", () => {
  test("a third device adopts the winner, authenticating its repository with its own password first", async () => {
    const w = world();
    const winner = done(await w.device("shared").run());
    const third = w.device("shared");
    const puts = w.store.calls.put;
    const adopted = done(await third.run());
    expect(adopted).toMatchObject({
      outcome: "adopted",
      id: winner.id,
      repo: `repos/${winner.id}`,
      format: 2,
    });
    expect(await third.recorded()).toBe(winner.id);
    expect(w.store.calls.put).toBe(puts);
  });

  test("a device whose password does not open the published repository records nothing", async () => {
    const w = world();
    done(await w.device("right").run());
    const other = w.device("wrong");
    const refused = failed(await other.run());
    expect(refused.finding.code).toBe("restic.wrong-password");
    expect(refused.finding.fix).toContain(STORE_NAME);
    expect(await other.recorded()).toBeUndefined();
  });

  test("a format-1 local store is adopted without rewriting it", async () => {
    const w = world();
    const id = ulid();
    const v1 = new TextEncoder().encode(`${JSON.stringify({ v: 1, id })}\n`);
    w.store.data.set(STORE_IDENTITY_KEY, v1);
    const repo = w.device("m1").target.engineAt("repo");
    expect((await repo.init()).ok).toBe(true);
    const device = w.device("m1");
    const puts = w.store.calls.put;
    const adopted = done(await device.run());
    expect(adopted).toEqual({ outcome: "adopted", id, repo: "repo", format: 1, seal: "none" });
    expect(w.store.calls.put).toBe(puts);
    expect(w.store.data.get(STORE_IDENTITY_KEY)).toEqual(v1);
    expect(keysUnder(w.store, STORE_CLAIMS_PREFIX)).toEqual([]);
    expect(await device.recorded()).toBe(id);
  });

  test("a name pinned to another store is refused before anything is written (D85)", async () => {
    const w = world();
    done(await w.device("pw").run());
    const device = w.device("pw");
    await updateRegistry(device.ports.io, device.box.paths, (r) => ({
      ok: true,
      value: { ...r, stores: { [STORE_NAME]: ulid() } },
    }));
    const puts = w.store.calls.put;
    expect(failed(await device.run()).finding.code).toBe("store.identity-changed");
    expect(w.store.calls.put).toBe(puts);

    // A pinned name whose store has no identity at all is not set up again under it.
    const empty = world();
    const pinned = empty.device("pw");
    await updateRegistry(pinned.ports.io, pinned.box.paths, (r) => ({
      ok: true,
      value: { ...r, stores: { [STORE_NAME]: ulid() } },
    }));
    expect(failed(await pinned.run()).finding.code).toBe("store.identity-changed");
    expect(empty.store.calls.put).toBe(0);
    expect(empty.repos.size).toBe(0);
  });
});

describe("bootstrap: interrupted attempts", () => {
  const crash = async (w: BootstrapWorld, at: string, password = "pw-a") => {
    const d = w.device(password, { faults: { at } });
    await expect(d.run()).rejects.toBeInstanceOf(InjectedFault);
    const [attempt] = await d.journals();
    if (attempt === undefined) throw new Error(`no journal after a crash at ${at}`);
    return { d, attempt };
  };

  test("a re-run resumes the open attempt with its journaled id instead of starting another", async () => {
    const w = world();
    const { d, attempt } = await crash(w, "bootstrap.candidacy.written");
    d.ports.faultAt = () => {};
    const result = done(await d.run());
    expect(result).toMatchObject({ outcome: "published", id: attempt });
    expect(keysUnder(w.store, STORE_CLAIMS_PREFIX).filter((k) => k.endsWith(".json"))).toEqual([
      `${STORE_CLAIMS_PREFIX}${attempt}.json`,
    ]);
  });

  test("a store changed under a pending attempt is refused (store.identity-changed), and nothing is written to it", async () => {
    const w = world();
    const { d, attempt } = await crash(w, "bootstrap.elect.start");
    d.ports.faultAt = () => {};
    // The name now points at another store: a different disk or bucket, where repos/<attempt> was never made.
    const other = world();
    const original = { blob: d.target.blob, location: d.target.location };
    d.target.blob = other.store;
    d.target.location = other.location;
    const refused = failed(await d.run());
    expect(refused.finding.code).toBe("store.identity-changed");
    expect(refused.finding.message).toContain(w.location);
    expect(other.store.calls.put).toBe(0);
    expect(await d.journals()).toEqual([attempt]);
    const pending = await d.recover();
    expect(pending.ok && pending.value.operations).toMatchObject([
      { attempt, outcome: "pending", finding: { code: "store.identity-changed" } },
    ]);
    expect(other.store.calls.put).toBe(0);
    // Pointed back at the store it began on, the attempt finishes.
    d.target.blob = original.blob;
    d.target.location = original.location;
    const settled = await d.recover();
    expect(settled.ok && settled.value.operations).toMatchObject([{ attempt, outcome: "published" }]);
  });

  test("killed after the candidacy on a conditional-create store: another attempt is undecided until the recoveries re-run with the journaled ids, and one publishes", async () => {
    const w = world();
    const { d: a, attempt } = await crash(w, "bootstrap.candidacy.written");
    const b = w.device("pw-b");
    const undecided = failed(await b.run());
    expect(undecided.finding.code).toBe("store.bootstrap-undecided");
    // B refused (A's id is lower) or holds the tie-break and waited for A (B's is): either way A stands, undecided.
    expect(undecided.data).toMatchObject({ undecided: [attempt] });
    expect(undecided.finding.fix).not.toContain("remove");
    // B keeps its journal to re-run later.
    expect((await b.journals()).length).toBe(1);

    // The recoveries, with the journaled ids, settle it: exactly one publishes and the other loses (D109).
    a.ports.faultAt = () => {};
    const outcomes: string[] = [];
    for (let round = 0; round < 2; round++) {
      for (const d of [a, b]) {
        const settled = await d.recover();
        if (settled.ok) for (const op of settled.value.operations) outcomes.push(op.outcome);
      }
    }
    expect(outcomes.filter((o) => o === "published")).toHaveLength(1);
    expect(outcomes).toContain("lost");
    expect(await a.journals()).toEqual([]);
    expect(await b.journals()).toEqual([]);
    expect(w.store.data.has(STORE_IDENTITY_KEY)).toBe(true);
  });

  test("a publication torn in place by a crash is completed by its own attempt's recovery", async () => {
    const w = world();
    const d = w.device("pw", { faults: { at: "bootstrap.publishing.written" } });
    await expect(d.run()).rejects.toBeInstanceOf(InjectedFault);
    const [attempt] = await d.journals();
    // The publication stopped part way, past the attempt's id: only this attempt writes its own id.
    const whole = `${JSON.stringify({ v: 2, id: attempt, repo: `repos/${attempt}`, catalog: { seal: "none" }, format: 2 })}\n`;
    w.store.data.set(STORE_IDENTITY_KEY, new TextEncoder().encode(whole.slice(0, whole.length - 20)));
    d.ports.faultAt = () => {};
    const settled = await d.recover();
    expect(settled.ok && settled.value.operations).toMatchObject([{ attempt, outcome: "published" }]);
    expect(text(w.store.data.get(STORE_IDENTITY_KEY))).toBe(whole);
    expect(await d.recorded()).toBe(attempt);
  });

  test("a torn publication too short to name its attempt is left as it is, pending, with the quiesced fix", async () => {
    const w = world();
    const d = w.device("pw", { faults: { at: "bootstrap.publishing.written" } });
    await expect(d.run()).rejects.toBeInstanceOf(InjectedFault);
    w.store.data.set(STORE_IDENTITY_KEY, new TextEncoder().encode('{"v":2,"id":"01'));
    d.ports.faultAt = () => {};
    const settled = await d.recover();
    expect(settled.ok && settled.value.operations).toMatchObject([{ outcome: "pending" }]);
    const op = settled.ok ? settled.value.operations[0] : undefined;
    expect(op?.finding?.code).toBe("store.failed");
    expect(op?.finding?.fix).toContain("every device");
    expect(text(w.store.data.get(STORE_IDENTITY_KEY))).toBe('{"v":2,"id":"01');
    expect(await d.journals()).toHaveLength(1);
  });
});

describe("bootstrap: one attempt per store at a time, apart from the projects' journals", () => {
  test("a store being set up by another process on this device is store.locked, and nothing is written", async () => {
    const w = world();
    const d = w.device("pw");
    await d.ports.io.fs.mkdirp(d.box.paths.locksDir);
    const hash = createHash("sha256").update(STORE_NAME, "utf8").digest("hex").slice(0, 32);
    const lock = `${d.box.paths.locksDir}/bootstrap-${hash}.lock`;
    const held = await acquireLock(d.ports.io, lock, {
      timeoutMs: 0,
      held: () => {
        throw new Error("unexpected");
      },
    });
    if (!held.ok) throw new Error(held.finding.message);
    try {
      expect(failed(await d.run()).finding.code).toBe("store.locked");
      expect(w.store.calls.put).toBe(0);
      expect(w.repos.size).toBe(0);
    } finally {
      await held.value.release();
    }
  });

  test("an open bootstrap journal is invisible to the projects' journals, which v0.1.x reads", async () => {
    const w = world();
    const d = w.device("pw", { faults: { at: "bootstrap.candidacy.written" } });
    await expect(d.run()).rejects.toBeInstanceOf(InjectedFault);
    expect(await d.journals()).toHaveLength(1);
    expect(await readJournals(d.ports.io, d.box.paths)).toEqual({ journals: [], unreadable: [], owners: {} });
  });

  test("a step this version does not know stays pending, never routed by default", async () => {
    const w = world();
    const d = w.device("pw");
    const op = ulid();
    const at = new Date().toISOString();
    await writeBootstrapJournal(d.ports.io, d.box.paths, {
      v: 1,
      op,
      kind: "bootstrap",
      step: "bootstrap.later.step",
      startedAt: at,
      updatedAt: at,
      pid: 1,
      host: "h",
      store: { name: STORE_NAME, location: w.location },
      repo: `repos/${op}`,
      seal: "none",
      history: [],
    });
    const settled = await d.recover();
    expect(settled.ok && settled.value.operations).toMatchObject([{ attempt: op, outcome: "pending" }]);
    expect(settled.ok && settled.value.operations[0]?.finding?.code).toBe("journal.pending");
    expect(await d.journals()).toEqual([op]);
    expect(w.store.calls.put).toBe(0);
  });
});
