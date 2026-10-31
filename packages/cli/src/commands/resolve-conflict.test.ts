// plainport resolve through the CLI (M2 Task 25): the confirm gate, the --json output against the declared schema,
// status's per-head detail for a conflicted project, and the help text. A sandboxed home set up by init (a format-2
// store) offloads a project with the fake engine; a stranger device's first offload of the same project makes the fork.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { fsBlobStore } from "@plainport/blob-fs";
import { parseJsonLines } from "@plainport/contract";
import { appendEvent, foldCatalog, nodeLocalIo, readEvents, storeEventLog, ulid } from "@plainport/core";
import { makeSandbox, type Sandbox } from "../../../core/src/testing/sandbox.ts";
import { capture, STORE_PASSWORD, sandboxPorts } from "../testing.ts";
import { REGISTRY } from "./index.ts";

let box: Sandbox;
const PATH = process.env.PATH ?? "/usr/bin:/bin";
const ports = () =>
  sandboxPorts(box.home, { env: { HOME: box.home, PATH, PLAINPORT_STORE_PASSWORD: STORE_PASSWORD } });
const cli = (argv: string[]) => capture(argv, REGISTRY, { ports: ports() });
const envelope = (out: string) => JSON.parse(out.trim().split("\n").at(-1) as string);
const store = () => fsBlobStore(nodeLocalIo, join(box.home, "ssd"));
const dataOf = (name: string, out: string) => {
  const schema = REGISTRY.find((c) => c.name === name)?.output;
  if (schema === undefined) throw new Error(`no command ${name}`);
  const parsed = parseJsonLines(out, schema);
  if (!parsed.ok) throw new Error(parsed.finding.message);
  return envelope(out).data;
};
const events = async () => {
  const read = await readEvents(storeEventLog(store()));
  if (!read.ok) throw new Error(read.finding.message);
  return read.value.events;
};

/** The project offloaded here, then a stranger's first offload of it: two first offloads, a fork. */
const conflicted = async () => {
  const run = await cli(["offload", "work:web", "--yes", "--json"]);
  if (run.code !== 0) throw new Error(run.err);
  const ours = envelope(run.out).data.snapshot as string;
  const first = (await events()).find((e) => e.type === "offloaded");
  if (first?.type !== "offloaded") throw new Error("no offload");
  const id = ulid();
  const theirs = {
    v: 1 as const,
    id,
    op: id,
    type: "offloaded" as const,
    device: ulid(),
    at: new Date().toISOString(),
    project: first.project,
    root: first.root,
    path: "web",
    snapshot: id,
    stored: { [Object.keys(first.stored)[0] as string]: "c".repeat(64) },
    stats: { files: 3, bytes: 300, strippedBytes: 0, ecosystems: [] },
  };
  const appended = await appendEvent(storeEventLog(store()), theirs);
  if (!appended.ok) throw new Error(appended.finding.message);
  return { ours, theirs: id, project: first.project };
};

beforeEach(async () => {
  box = makeSandbox("plainport-resolve-cli-");
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
  box.file("work/web/package.json", `${JSON.stringify({ name: "web" })}\n`);
  box.file("work/web/src/main.ts", "export const main = 1;\n");
});
afterEach(async () => {
  await box.cleanupSettled();
});

describe("plainport resolve (CLI)", () => {
  test("confirm: without --yes it exits 3, writes nothing and names the exact re-run", async () => {
    const { ours } = await conflicted();
    const before = (await events()).length;
    const run = await cli(["resolve", "work:web", "--keep", ours]);
    expect(run.code).toBe(3);
    expect(run.err).toContain(`re-run: plainport resolve work:web --keep ${ours} --yes`);
    expect((await events()).length).toBe(before);
  });

  test("status lists each live tip; resolve --keep --json validates and settles it; a re-run is nothing to resolve", async () => {
    const { ours, theirs, project } = await conflicted();
    const status = await cli(["status", "work:web", "--json"]);
    expect(status.code).toBe(0);
    const view = dataOf("status", status.out);
    expect(view.state).toBe("conflicted");
    expect(view.heads.map((h: { snapshot: string }) => h.snapshot)).toEqual([ours, theirs].sort());
    expect(view.heads.find((h: { snapshot: string }) => h.snapshot === theirs)).toMatchObject({
      kind: "offloaded",
      bytes: 300,
      files: 3,
      here: false,
    });
    expect(view.next.command).toBe("plainport resolve work:web --keep <snapshot>");
    const human = await cli(["status", "work:web"]);
    expect(human.out).toContain(`tip      ${theirs} · device `);

    const run = await cli(["resolve", "work:web", "--keep", theirs, "--yes", "--json"]);
    expect([run.code, run.err]).toEqual([0, ""]);
    const done = dataOf("resolve", run.out);
    expect(done).toMatchObject({
      outcome: "resolved",
      keep: theirs,
      over: [ours],
      supersedes: [],
      head: theirs,
    });
    expect(foldCatalog(await events()).projects[project]?.head).toBe(theirs);

    const again = await cli(["resolve", "work:web", "--keep", theirs, "--yes"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain(`nothing to resolve: work:web is not conflicted; its head is ${theirs}`);
    expect((await events()).filter((e) => e.type === "resolved")).toHaveLength(1);
  });

  test("help resolve names its risk class and how to choose --keep", async () => {
    const run = await cli(["help", "resolve", "--json"]);
    expect(run.code).toBe(0);
    const help = envelope(run.out).data.commands.find((c: { name: string }) => c.name === "resolve");
    expect(help.risk).toBe("confirm");
    const text = await cli(["help", "resolve"]);
    expect(text.out).toContain("plainport status lists");
  });
});
