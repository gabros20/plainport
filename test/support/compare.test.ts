// plainport compare end to end (M2 Task 26, T1 on macOS): two devices fork on one local store, and the device that
// kept its folder writes the other head into its repository as the theirs refs, through the checkout's binary and
// the pinned restic. Its own index, HEAD, branches, stash, config and status stay byte for byte; the other copy's
// .env never reaches an object; status reports a set left incomplete; --clean removes the refs.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QUIET_GIT_ENV } from "../../packages/core/src/testing/git-fixture.ts";
import { makeProjectTemplate } from "../crash-matrix/fixture.ts";
import { describeT1Mac, t1MacEnabled } from "../tiers.ts";
import {
  type Device,
  Devices,
  envelope,
  expectCode,
  type Harness,
  makeHarness,
  removeHarness,
} from "./two-devices.ts";

const CANARY = "CANARY-5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const OFFLOAD = ["offload", "work:web", "--yes", "--json"];
const ONLOAD = ["onload", "work:web", "--no-hydrate", "--json"];

const git = (d: Device, ...args: string[]): string => {
  const ran = Bun.spawnSync(["git", ...args], {
    cwd: d.dir(),
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: d.home,
      GIT_CONFIG_NOSYSTEM: "1",
      ...QUIET_GIT_ENV,
    },
  });
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
  return ran.stdout.toString();
};

/** What compare must leave as it was in the repository it writes into. */
const repoState = (d: Device) => ({
  index: readFileSync(join(d.dir(), ".git/index")).toString("base64"),
  head: readFileSync(join(d.dir(), ".git/HEAD"), "utf8"),
  refs: git(
    d,
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/heads",
    "refs/stash",
    "refs/remotes",
  ),
  stash: git(d, "stash", "list"),
  config: readFileSync(join(d.dir(), ".git/config"), "utf8"),
  status: git(d, "--no-optional-locks", "status", "--porcelain=v2", "--branch"),
});

describeT1Mac("compare: the theirs refs after a fork, through the binary", () => {
  let harness: Harness | undefined;
  let world: Devices | undefined;

  beforeAll(() => {
    if (t1MacEnabled()) harness = makeHarness(makeProjectTemplate());
  }, 180_000);
  afterEach(async () => {
    await world?.cleanup();
    world = undefined;
  });
  afterAll(async () => {
    if (harness !== undefined) await removeHarness(harness);
  });

  test("compare writes the other head; status reports a set left incomplete; a rerun replaces it; --clean removes it", async () => {
    world = await Devices.create(harness as Harness);
    const a = world.device("dev-a");
    const b = world.device("dev-b");
    world.project(a);
    expectCode(await a.run(OFFLOAD), 0, "dev-a: the first offload");
    await a.settled();
    expectCode(await b.run(ONLOAD), 0, "dev-b: onload");
    expectCode(await a.run(ONLOAD), 0, "dev-a: onload");
    await Bun.write(join(a.dir(), "src/a.ts"), "export const a = 1;\n");
    await Bun.write(join(a.dir(), ".env"), `TOKEN=${CANARY}\n`);
    await Bun.write(join(b.dir(), "src/b.ts"), "export const b = 1;\n");

    // B verifies first and waits while A commits: B forks and keeps its folder.
    const offloadB = b.start(OFFLOAD, { pauseAt: "offload.verified" });
    await offloadB.paused();
    const byA = await a.run(OFFLOAD);
    expectCode(byA, 0, "dev-a: offload");
    const theirs = envelope(byA)?.data?.snapshot as string;
    offloadB.resume();
    expectCode(await offloadB.done, 8, "dev-b: offload");
    await a.settled();

    const before = repoState(b);
    const compared = await b.run(["compare", "work:web", "--json"]);
    expectCode(compared, 0, "dev-b: compare");
    const sets = envelope(compared)?.data?.sets as { snapshot: string; refs: string[] }[];
    expect(sets.map((s) => s.snapshot)).toContain(theirs);
    const at = `refs/plainport/theirs/${theirs}`;
    const refs = git(b, "for-each-ref", "--format=%(refname)", `${at}/`).split("\n").filter(Boolean);
    expect(refs).toEqual(
      expect.arrayContaining([`${at}/HEAD`, `${at}/heads/main`, `${at}/index`, `${at}/worktree`]),
    );
    // Their edit is there to read; ours is not in theirs.
    const diff = git(b, "diff", "--name-status", "HEAD", `${at}/worktree`);
    expect(diff).toContain("A\tsrc/a.ts");
    expect(git(b, "show", `${at}/worktree:src/a.ts`)).toBe("export const a = 1;\n");
    // Their .env is ignored: never an object here.
    const objects = Bun.spawnSync(["git", "cat-file", "--batch-all-objects", "--batch"], {
      cwd: b.dir(),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: b.home, GIT_CONFIG_NOSYSTEM: "1" },
    });
    expect(objects.stdout.toString()).not.toContain(CANARY);
    expect(repoState(b)).toEqual(before);
    expect(existsSync(join(b.root, ".plainport-staging"))).toBe(false);
    expect(
      Bun.spawnSync(["git", "fsck", "--connectivity-only", "--no-dangling"], { cwd: b.dir() }).exitCode,
    ).toBe(0);

    // A death inside git's ref transaction can leave a set partly written: status says so.
    git(b, "update-ref", "-d", `${at}/heads/main`);
    const status = await b.run(["status", "work:web", "--json"]);
    const listed = envelope(status)?.data?.theirs as {
      snapshot: string;
      complete: boolean;
      missing: string[];
    }[];
    expect(listed.find((s) => s.snapshot === theirs)).toMatchObject({
      complete: false,
      missing: ["heads/main"],
    });
    expectCode(await b.run(["compare", "work:web", "--json"]), 0, "dev-b: compare again");
    const again = envelope(await b.run(["status", "work:web", "--json"]))?.data?.theirs as {
      complete: boolean;
    }[];
    expect(again.every((s) => s.complete)).toBe(true);

    const cleaned = await b.run(["compare", "work:web", "--clean", "--json"]);
    expectCode(cleaned, 0, "dev-b: compare --clean");
    expect(git(b, "for-each-ref", "refs/plainport")).toBe("");
    expect(repoState(b)).toEqual(before);
  }, 240_000);
});
