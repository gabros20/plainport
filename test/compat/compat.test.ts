// The compatibility matrix against the real v0.1.1 binary (T1; Task 7, DESIGN.md "Formats and compatibility").
//
// Both binaries are compiled with the crash matrix's test hook (test/compat/binaries.ts), run against one sandboxed
// home in turn, and the restic is the pinned one. A test title starts with the ids of the matrix rows it proves,
// "[store.json.v1] ...", which matrix.test.ts checks against DESIGN; a `test.todo` is a row a later task owns.

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { fsBlobStore } from "../../packages/blob-fs/src/index.ts";
import { appendEvent, storeEventLog } from "../../packages/core/src/catalog/index.ts";
import { TrashClaimBootSchema, TrashClaimSchema } from "../../packages/core/src/trash-claim.ts";
import { ulid } from "../../packages/core/src/ulid.ts";
import { testHost } from "../../packages/host-macos/src/testing.ts";
import { settleJournals } from "../crash-matrix/checks.ts";
import { hashTree, makeProjectTemplate, type TreeHash, treeDiff } from "../crash-matrix/fixture.ts";
import { onMac } from "../platform.ts";
import { describeT1 } from "../tiers.ts";
import { currentBinary, releasedBinary, toolsCopy } from "./binaries.ts";
import { type Binaries, envelope, expectOk, type Ran, treeDigest, World } from "./world.ts";

const offloadArgs = ["offload", "work:web", "--yes", "--json"];
const onloadArgs = ["onload", "work:web", "--no-hydrate", "--json"];
const SKIPPED = "catalog.event-skipped";

let scratch: string;
let bins: Binaries;

/** One scenario in its own world, cleaned up afterwards. */
const scenario = async (body: (w: World) => Promise<void>): Promise<void> => {
  const w = new World(bins);
  try {
    await body(w);
  } finally {
    w.cleanup();
  }
};

const without = (tree: TreeHash, skip: string): TreeHash =>
  new Map([...tree].filter(([p]) => p !== skip && !p.startsWith(`${skip}/`)));
/** The project's tree against the reference; node_modules is the strip set, absent after an unhydrated restore. */
const sameAsReference = (w: World): string[] =>
  treeDiff(without(hashTree(w.dir), "node_modules"), without(w.reference, "node_modules"));

const eventTypes = (w: World): string[] =>
  readdirSync(join(w.store, "meta/v1/events"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(w.store, "meta/v1/events", f), "utf8")).type);

const projectOf = (ran: Ran): { state: string; snapshots: number } | undefined =>
  (envelope(ran)?.data as { projects?: { state: string; snapshots: number }[] } | undefined)?.projects?.[0];

const journals = (w: World): string[] =>
  existsSync(w.box.paths.journalDir)
    ? readdirSync(w.box.paths.journalDir).filter((f) => f.endsWith(".json"))
    : [];
const trashDir = (w: World): string => join(w.root, ".plainport-trash");
const trashes = (w: World): string[] =>
  existsSync(trashDir(w)) ? readdirSync(trashDir(w)).filter((f) => /^[0-9A-Z]{26}$/.test(f)) : [];

const registryOf = (w: World) => JSON.parse(readFileSync(w.box.paths.registryFile, "utf8"));

/** A kept trash: current offloads with keepLocalFor, leaving the trash and a journal at offload.release.delete. */
const keptTrash = async (w: World): Promise<{ op: string; trash: string; journal: string }> => {
  expectOk(await w.old(w.initArgs), "old init");
  appendFileSync(w.box.paths.configFile, '\n[offload]\nkeepLocalFor = "1h"\n');
  expectOk(await w.current(offloadArgs), "current offload");
  const [trashOp] = trashes(w);
  const [journal] = journals(w);
  if (trashOp === undefined || journal === undefined) throw new Error("no kept trash");
  return { op: trashOp, trash: join(trashDir(w), trashOp), journal: join(w.box.paths.journalDir, journal) };
};

const settledFor = (ms: number) => Bun.sleep(ms);

describeT1("compat: v0.2 and the released v0.1.1", () => {
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "plainport-compat-"));
    bins = {
      old: releasedBinary(),
      current: currentBinary(scratch),
      tools: toolsCopy(scratch),
      template: makeProjectTemplate(),
    };
  }, 600_000);
  afterAll(() => {
    bins?.template.cleanup();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  test("[store.json.v1][root.json][registry.json][device.json][config.keys][managed.toml][mirror][stub][journal][restic.tags][event.registered][event.root-created][event.offloaded][event.onloaded] v0.2 onloads and offloads on an M1 store and v0.1.1 reads everything it wrote", async () => {
    await scenario(async (w) => {
      expectOk(await w.old(w.initArgs), "old init");
      expectOk(await w.old(offloadArgs), "old offload");
      await settleJournals(w.box.paths);
      const identity = readFileSync(join(w.store, "meta/v1/store.json"), "utf8");
      const claim = readFileSync(join(w.store, "meta/v1/root.json"), "utf8");

      const ls = await w.current(["ls", "--json"]);
      expectOk(ls, "current ls");
      expect(projectOf(ls)?.state).toBe("shelved");
      expect(ls.err).not.toContain(SKIPPED);
      expectOk(await w.current(onloadArgs), "current onload");
      expect(sameAsReference(w)).toEqual([]);
      expectOk(await w.current(offloadArgs), "current offload");
      await settleJournals(w.box.paths);

      const oldLs = await w.old(["ls", "--json"]);
      expectOk(oldLs, "old ls");
      const project = projectOf(oldLs);
      expect([project?.state, project?.snapshots]).toEqual(["shelved", 2]);
      expect(oldLs.err).not.toContain(SKIPPED);
      expectOk(await w.old(["status", "work:web", "--json"]), "old status");
      expectOk(await w.old(onloadArgs), "old onload");
      expect(sameAsReference(w)).toEqual([]);
      expectOk(await w.old(offloadArgs), "old offload again");
      await settleJournals(w.box.paths);
      expectOk(await w.current(onloadArgs), "current onload again");
      expect(sameAsReference(w)).toEqual([]);

      const types = eventTypes(w);
      expect(types.filter((t) => t === "root-created")).toHaveLength(1);
      expect(types.filter((t) => t === "offloaded")).toHaveLength(3);
      expect(types.filter((t) => t === "onloaded")).toHaveLength(3);
      // Format 1 stays format 1: v0.2 writes nothing to the identity or the claim.
      expect(readFileSync(join(w.store, "meta/v1/store.json"), "utf8")).toBe(identity);
      expect(readFileSync(join(w.store, "meta/v1/root.json"), "utf8")).toBe(claim);
      expect(registryOf(w).v).toBe(1);
    });
  }, 300_000);

  test("[event.registered][event.offloaded][event.onloaded][event.checkpointed][event.snapshot-discarded][event.root-created][event.root-bound] every v1 event type v0.2 writes is read by v0.1.1", async () => {
    await scenario(async (w) => {
      expectOk(await w.old(w.initArgs), "old init");
      const log = storeEventLog(fsBlobStore(testHost(), w.store));
      const [device, root, project, snapshot] = [ulid(), ulid(), ulid(), ulid()];
      const common = (type: string) => {
        const id = ulid();
        return { v: 1, id, op: id, type, device, at: "2026-10-10T00:00:00.000Z" };
      };
      const where = { project, root, path: "web" };
      const stats = { files: 1, bytes: 1, strippedBytes: 0, stripped: 0, ecosystems: [] };
      const stored = { local: "c".repeat(64) };
      const events = [
        { ...common("root-created"), root, key: "work" },
        { ...common("root-bound"), root, path: "~/work" },
        { ...common("registered"), ...where },
        { ...common("offloaded"), ...where, snapshot, stored, stats, rootMode: 0o755 },
        { ...common("onloaded"), ...where, base: snapshot, over: snapshot },
        { ...common("checkpointed"), ...where, snapshot: ulid(), base: snapshot, stored, stats },
        { ...common("snapshot-discarded"), ...where, snapshot: ulid(), stored },
      ];
      for (const event of events) {
        const appended = await appendEvent(log, event as never);
        if (!appended.ok) throw new Error(appended.finding.message);
      }
      const ls = await w.old(["ls", "--json"]);
      expectOk(ls, "old ls");
      expect(ls.err).not.toContain(SKIPPED);
    });
  }, 120_000);

  test("[event.unknown][event.resolved] v0.1.1 skips an event with a field or a type it does not know, with catalog.event-skipped (Q1)", async () => {
    await scenario(async (w) => {
      expectOk(await w.old(w.initArgs), "old init");
      const dir = join(w.store, "meta/v1/events");
      mkdirSync(dir, { recursive: true });
      const [device, root] = [ulid(), ulid()];
      const base = { v: 1, device, at: "2026-10-10T00:00:00.000Z" };
      const field = ulid();
      const type = ulid();
      writeFileSync(
        join(dir, `${field}.json`),
        JSON.stringify({ ...base, id: field, op: field, type: "root-created", root, key: "x", added: 1 }),
      );
      writeFileSync(
        join(dir, `${type}.json`),
        JSON.stringify({
          ...base,
          id: type,
          op: type,
          type: "resolved",
          project: ulid(),
          root,
          path: "web",
          keep: ulid(),
          over: [],
          supersedes: [],
        }),
      );
      const ls = await w.old(["ls", "--json"]);
      expectOk(ls, "old ls");
      expect(ls.err).toContain(`${SKIPPED}: the catalog event meta/v1/events/${field}.json`);
      expect(ls.err).toContain(`${SKIPPED}: the catalog event meta/v1/events/${type}.json`);
    });
  }, 120_000);

  test("[store.json.v2] v0.1.1 refuses a format-2 store.json before it writes anything", async () => {
    await scenario(async (w) => {
      expectOk(await w.old(w.initArgs), "old init");
      expectOk(await w.old(offloadArgs), "old offload");
      await settleJournals(w.box.paths);
      expectOk(await w.current(onloadArgs), "current onload");
      const file = join(w.store, "meta/v1/store.json");
      const id = JSON.parse(readFileSync(file, "utf8")).id;
      // A stand-in for format 2: any v other than 1, and keys format 1 lacks (the real shape arrives with Task 9).
      writeFileSync(
        file,
        `${JSON.stringify({ v: 2, id, repository: "repos/01ARZ3NDEKTSV4RRFFQ69G5FAV", seal: "none" })}\n`,
      );
      const storeBefore = treeDigest(w.store);
      const projectBefore = hashTree(w.dir);
      for (const args of [
        ["ls", "--json"],
        ["status", "work:web", "--json"],
        offloadArgs,
        w.initArgs,
        ["recover", "--json"],
        ["gc", "--json"],
      ]) {
        const ran = await w.old(args);
        // The writers refuse; the readers show the project with its catalog unreadable (head null), never a guess.
        if (args[0] === "offload" || args[0] === "init") expect(ran.code, `old ${args[0]}`).toBe(1);
        if (["ls", "status", "offload", "init"].includes(args[0] as string))
          expect(`${ran.out}${ran.err}`, `old ${args[0]}`).toContain("store.failed");
        if (args[0] === "ls" || args[0] === "status")
          expect(`${ran.out}`, `old ${args[0]}`).toContain("catalog-unreadable");
        expect(treeDigest(w.store), `old ${args[0]} wrote to the store`).toBe(storeBefore);
        expect(treeDiff(hashTree(w.dir), projectBefore), `old ${args[0]} touched the project`).toEqual([]);
        expect(journals(w), `old ${args[0]} left a journal`).toEqual([]);
        expect(existsSync(trashDir(w)), `old ${args[0]} made a trash`).toBe(false);
      }
    });
  }, 300_000);

  test("[event.offloaded][store.json.v1] a v0.1.1 offload paused before its event append, or before its release, ends as M1's, and v0.2 reads it (Q11)", async () => {
    for (const at of ["offload.commit.start", "offload.committed"]) {
      await scenario(async (w) => {
        expectOk(await w.old(w.initArgs), "old init");
        const ran = await w.old(offloadArgs, { PLAINPORT_TEST_PAUSE_AT: at }, async () => {
          const ls = await w.current(["ls", "--json"]);
          expectOk(ls, `current ls while v0.1.1 is at ${at}`);
          const second = await w.current(offloadArgs);
          expect(second.code, "a second offload while one runs").not.toBe(0);
        });
        expectOk(ran, `old offload resumed from ${at}`);
        await settleJournals(w.box.paths);
        const ls = await w.current(["ls", "--json"]);
        expect(projectOf(ls)?.state).toBe("shelved");
        expect(ls.err).not.toContain(SKIPPED);
        expect(existsSync(w.dir)).toBe(false);
        expectOk(await w.current(onloadArgs), "current onload");
        expect(sameAsReference(w)).toEqual([]);
      });
    }
  }, 300_000);

  test("[journal] v0.1.1 recovers a journal v0.2 left open on a format-1 store", async () => {
    const cases: { name: string; point: string; setup: "offload" | "onload" }[] = [
      { name: "before the commit", point: "offload.snapshot.done", setup: "offload" },
      { name: "after the commit", point: "offload.release.trash", setup: "offload" },
      { name: "an onload before its swap", point: "onload.restored", setup: "onload" },
      { name: "an onload after its swap", point: "onload.swapped", setup: "onload" },
    ];
    for (const c of cases) {
      await scenario(async (w) => {
        expectOk(await w.old(w.initArgs), "old init");
        if (c.setup === "onload") {
          expectOk(await w.old(offloadArgs), "old offload");
          await settleJournals(w.box.paths);
        }
        const args = c.setup === "offload" ? offloadArgs : onloadArgs;
        const killed = await w.current(args, { PLAINPORT_TEST_FAULT_AT: c.point });
        expect(killed.signal, `${c.name}: killed at ${c.point}`).toBe("SIGKILL");
        expect(journals(w).length, `${c.name}: an open journal`).toBe(1);
        const recovered = await w.old(["recover", "--json"]);
        expect(recovered.signal).toBeNull();
        await settleJournals(w.box.paths);
        expect(journals(w), `${c.name}: recover closed it`).toEqual([]);
        // Whatever recover decided, the work is whole: a folder as it was, or the snapshot restores it.
        if (!existsSync(w.dir)) expectOk(await w.old(onloadArgs), `${c.name}: old onload`);
        expect(sameAsReference(w), c.name).toEqual([]);
      });
    }
  }, 600_000);

  test("[claim][claim.boot] v0.1.1 parses a claim written beside a .claim.boot, and a live one keeps the trash", async () => {
    for (const live of [true, false]) {
      await scenario(async (w) => {
        const { op, trash } = await keptTrash(w);
        const device = JSON.parse(readFileSync(w.box.paths.deviceFile, "utf8")).id;
        let pid = process.pid;
        if (!live) {
          const dead = Bun.spawn(["/usr/bin/true"]);
          await dead.exited;
          pid = dead.pid;
        }
        const startedAt = new Date().toISOString();
        const claim = TrashClaimSchema.parse({
          v: 1,
          device,
          pid,
          bootedAt: testHost().proc.bootedAtMs(),
          startedAt,
        });
        const boot = TrashClaimBootSchema.parse({ v: 1, pid, startedAt, session: "compat-session" });
        writeFileSync(`${trash}.claim.boot`, `${JSON.stringify(boot)}\n`);
        writeFileSync(`${trash}.claim`, `${JSON.stringify(claim)}\n`);
        const gc = await w.old(["gc", "--now", "--yes", "--json"]);
        await settledFor(500);
        expect(existsSync(trash), `${live ? "live" : "dead"} claim, ${op}: ${gc.out}${gc.err}`).toBe(live);
      });
    }
  }, 300_000);

  test("[journal.held][journal] a trash held at a step v0.1.1 does not know stays through its recover, gc, gc --now, housekeeping and detached delete", async () => {
    for (const keepUntil of ["2999-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", undefined]) {
      await scenario(async (w) => {
        const { trash, journal } = await keptTrash(w);
        const data = JSON.parse(readFileSync(journal, "utf8"));
        data.step = "offload.release.held";
        data.history.push({ step: "offload.release.held", at: new Date().toISOString() });
        if (keepUntil === undefined) delete data.keepUntil;
        else data.keepUntil = keepUntil;
        writeFileSync(journal, `${JSON.stringify(data, null, 2)}\n`);
        const held = () => [existsSync(join(trash, "web")), existsSync(journal)];
        for (const args of [
          ["recover", "--json"],
          ["gc", "--json"],
          ["gc", "--now", "--yes", "--json"],
          // a write command: its housekeeping hands a due trash to a detached delete
          ["root", "scan", "work", "--json"],
        ]) {
          await w.old(args);
          await settledFor(700);
          expect(held(), `after old ${args.slice(0, 2).join(" ")} (keepUntil ${keepUntil})`).toEqual([
            true,
            true,
          ]);
        }
      });
    }
  }, 300_000);

  test("[config.keys][managed.toml] v0.1.1 refuses configuration keys it does not know, so a rollback means removing them", async () => {
    await scenario(async (w) => {
      expectOk(await w.old(w.initArgs), "old init");
      for (const extra of [
        '[offload]\nconflictGrace = "15m"\n',
        '[stores.cloud]\nkind = "s3"\nendpoint = "https://s3.example.com"\nbucket = "b"\nsecret = "env:S"\naccessKeyId = "env:K"\nsecretAccessKey = "env:A"\nregion = "x"\n',
      ]) {
        for (const file of [
          w.box.paths.configFile,
          w.box.paths.configFile.replace("config.toml", "managed.toml"),
        ]) {
          const before = existsSync(file) ? readFileSync(file, "utf8") : "";
          appendFileSync(file, `\n${extra}`);
          const ran = await w.old(["ls", "--json"]);
          expect(ran.code, `${file}: ${extra.split("\n")[0]}`).toBe(6);
          expect(`${ran.out}${ran.err}`).toContain("config.invalid");
          writeFileSync(file, before);
        }
      }
      expectOk(await w.old(["ls", "--json"]), "old ls after removing the lines");
    });
  }, 120_000);

  test("[plan][value.plan-fp] v0.1.1 reads and runs a plan v0.2 saved", async () => {
    await scenario(async (w) => {
      expectOk(await w.old(w.initArgs), "old init");
      const dry = await w.current(["offload", "work:web", "--dry-run", "--json"]);
      expectOk(dry, "current dry-run");
      const plan = envelope(dry)?.data as { id: string; fp?: number; git?: boolean };
      expect(plan.git).toBe(true);
      expect(plan.fp).toBe(2);
      // v0.1.1 takes the plan v0.2 saved: the file loads (plans are open objects) and the approval is judged on the
      // fingerprint, not on the fields v0.2 added. (The other way needs no test: v0.2 reads absent optional fields.)
      const byOld = await w.old(["offload", "work:web", "--plan", plan.id, "--json"]);
      expectOk(byOld, "old offload --plan from v0.2");
      await settleJournals(w.box.paths);
      expect(`${byOld.out}${byOld.err}`).not.toContain("contract.invalid");
    });
  }, 300_000);

  test("[output.additive][value.offload-kind][value.exit-codes] v0.2's output validates against the schemas published at v0.1.1", async () => {
    const released = (path: string) => {
      const ran = Bun.spawnSync(["git", "show", `v0.1.1:${path}`], {
        cwd: join(import.meta.dir, "../.."),
        stdout: "pipe",
      });
      return ran.stdout.toString();
    };
    const manifest = JSON.parse(released("plainport.json"));
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const checkEnvelope = ajv.compile(JSON.parse(released("schemas/envelope.json")));
    const dataOf = (name: string) => manifest.commands.find((c: { name: string }) => c.name === name);
    const seen: string[] = [];
    const validate = (name: string, ran: Ran, dry = false) => {
      const env = envelope(ran) as { ok: boolean; data?: unknown } | undefined;
      expect(env, `${name}: an envelope`).toBeDefined();
      expect(checkEnvelope(env), `${name}: envelope ${JSON.stringify(checkEnvelope.errors)}`).toBe(true);
      const command = dataOf(
        name
          .split(" ")
          .slice(0, name.startsWith("root ") ? 2 : 1)
          .join(" "),
      );
      if (env?.ok && env.data !== undefined && !dry) {
        const check = ajv.compile(command.output);
        expect(check(env.data), `${name}: data ${JSON.stringify(check.errors)}`).toBe(true);
        seen.push(name);
      }
    };
    await scenario(async (w) => {
      validate("init", await w.current(w.initArgs));
      validate("ls", await w.current(["ls", "--json"]));
      validate("root list", await w.current(["root", "list", "--json"]));
      validate("offload", await w.current(["offload", "work:web", "--dry-run", "--json"]), true);
      const off = await w.current(offloadArgs);
      validate("offload", { ...off, out: off.out.trim().split("\n").slice(-1).join("\n") });
      await settleJournals(w.box.paths);
      validate("status", await w.current(["status", "work:web", "--json"]));
      validate("recover", await w.current(["recover", "--json"]));
      validate("gc", await w.current(["gc", "--json"]));
      const on = await w.current(onloadArgs);
      validate("onload", { ...on, out: on.out.trim().split("\n").slice(-1).join("\n") });
      validate("version", await w.current(["version", "--json"]));
    });
    expect(seen).toEqual(
      expect.arrayContaining(["init", "ls", "offload", "status", "recover", "gc", "onload", "version"]),
    );
  }, 300_000);

  test("[store.election] v0.1.1 ignores and never deletes election records and repos/<attempt>/ folders beside an M1 store", async () => {
    await scenario(async (w) => {
      expectOk(await w.old(w.initArgs), "old init");
      const [a, b] = [ulid(), ulid()];
      const records = join(w.store, "meta/v1/candidates");
      mkdirSync(records, { recursive: true });
      const files: Record<string, unknown> = {
        [`${a}.json`]: { v: 1, id: a, decision: "candidate" },
        [`${a}.publishing`]: { v: 1, id: a, decision: "publishing" },
        [`${b}.json`]: { v: 1, id: b, decision: "candidate" },
        [`${b}.refused`]: { v: 1, id: b, decision: "refused" },
      };
      for (const [name, record] of Object.entries(files))
        writeFileSync(join(records, name), `${JSON.stringify(record)}\n`);
      mkdirSync(join(w.store, "repos", b), { recursive: true });
      writeFileSync(join(w.store, "repos", b, "config"), "not a repository\n");
      const before = treeDigest(join(w.store, "repos")) + treeDigest(records);
      for (const args of [
        ["ls", "--json"],
        offloadArgs,
        ["gc", "--now", "--yes", "--json"],
        ["recover", "--json"],
      ]) {
        const ran = await w.old(args);
        expect(ran.err, `old ${args[0]}`).not.toContain(SKIPPED);
        await settleJournals(w.box.paths);
      }
      expect(treeDigest(join(w.store, "repos")) + treeDigest(records)).toBe(before);
      expectOk(await w.old(onloadArgs), "old onload");
      expect(sameAsReference(w)).toEqual([]);
    });
  }, 120_000);

  // Rows a later task owns. Each task turns its todo into a test and the guard (PLAINPORT_COMPAT_GATE=1) fails the M2
  // gate while any remains.
  test.todo("[store.json.v2] Task 9: a store v0.2 creates is format 2 and v0.1.1 refuses it (the real shape)", () => {});
  test.todo("[store.election] Task 8: bootstrap's own repos/<attempt>/ layout and candidate prefix, with v0.1.1 ignoring them (stand-in layout tested now)", () => {});
  test.todo("[store.sidecar] Task 9: v0.1.1 ignores stores/<store id>.json and `scripts/install --rollback` still works with one present", () => {});
  test.todo("[store.upgrade-intent] Task 19: the upgrade-intent marker blocks a v0.2 offload and bootstrap, and v0.1.1 ignores it", () => {});
  test.todo("[store.json.v2][store.upgrade-intent] Task 19: store upgrade refuses (store.not-quiescent) while a paused v0.1.1 holds a lease", () => {});
  test.todo("[store.json.v2][store.upgrade-intent] Task 19: store upgrade with --others-stopped proceeds past a paused lease-less first offload, whose resumed event v0.2 reads", () => {});
  test.todo("[event.resolved] Task 12: v0.2 writes resolved only to format-2 stores, and v0.1.1 skips it", () => {});
  test.todo("[event.sealed] Tasks 10, 20: a sealed event on a format-2 store is not read by v0.1.1, which refuses the store first", () => {});
  test.todo("[journal.held] Task 24: real held trash, in grace and conflict-retained, survives v0.1.1's recover, gc, gc --now, housekeeping and detached delete", () => {});
  test.todo("[config.keys] Tasks 15, 18, 24: v0.2 accepts the S3 credential keys, secret providers and offload.conflictGrace that v0.1.1 refuses", () => {});
  test.todo("[value.offload-kind] Task 23: a fork after the commit keeps kind fork and adds detail after-commit", () => {});
});

void onMac;
