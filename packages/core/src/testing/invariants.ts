// The invariants DESIGN.md "Testing and fault injection" asserts after every saga test, 1 to 3 here (4 and 5 are the
// fold's, tested there; 6 is prune's). The saga tests call it after each run, and the crash matrix (Task 15) after
// each recover:
//
// 1. A project folder is deleted only if its snapshot was verified and committed: a folder that is gone (deleted,
//    or renamed into the trash) has an offloaded event from this device whose snapshot the store's repository holds.
// 2. A stub exists if and only if the project is shelved on that machine: the catalog's status is shelved and the
//    folder is gone. A stub there must read back as a stub of the head.
// 3. No staging or trash folder remains from a finished operation: everything in <root>/.plainport-trash/ and
//    <root>/.plainport-staging/ is named for an operation whose journal is still open. The trash is deleted by a
//    detached process after the command returns, so this one waits up to `settleMs` for it.
//
// Used only by tests.

import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { foldCatalog } from "../catalog/fold.ts";
import { readEvents, storeEventLog } from "../catalog/log.ts";
import { journalFile } from "../journal/index.ts";
import type { PlainportPaths } from "../paths.ts";
import type { BlobStore } from "../ports/blob-store.ts";
import type { Engine } from "../ports/engine.ts";
import { StubSchema } from "../stub.ts";

export interface InvariantSubject {
  paths: PlainportPaths;
  /** This device's ULID. */
  device: string;
  /** The project: its ULID (undefined when the run failed before it had one) and its folder. */
  project: { id: string | undefined; dir: string };
  /** The folders whose .plainport-trash and .plainport-staging are checked: the project's root. */
  roots: readonly string[];
  store: { name: string; blob: BlobStore; engine: Engine };
  /** How long invariant 3 waits for a detached deletion. Default 5 seconds. */
  settleMs?: number;
}

const present = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const leftovers = (subject: InvariantSubject): string[] => {
  const found: string[] = [];
  for (const root of subject.roots) {
    for (const holder of [".plainport-trash", ".plainport-staging"]) {
      const dir = join(root, holder);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!existsSync(journalFile(subject.paths, name))) found.push(join(dir, name));
      }
    }
  }
  return found;
};

/** Every invariant 1–3 violation, as sentences; none means all hold. */
export const invariantViolations = async (subject: InvariantSubject): Promise<string[]> => {
  const problems: string[] = [];
  const { dir, id } = subject.project;
  const gone = !present(dir);
  const read = await readEvents(storeEventLog(subject.store.blob));
  if (!read.ok) return [`the store's events could not be read: ${read.finding.message}`];
  const state = foldCatalog(read.value.events);
  const project = id === undefined ? undefined : state.projects[id];

  // 1
  if (gone) {
    const offloads = read.value.events.filter(
      (e) => e.type === "offloaded" && e.project === id && e.device === subject.device,
    );
    const listed = await subject.store.engine.list({ tags: ["plainport"] });
    const held = new Set(listed.ok ? listed.value.map((s) => s.id) : []);
    const committed = offloads.some(
      (e) =>
        e.type === "offloaded" &&
        !(project?.discarded ?? []).includes(e.snapshot) &&
        held.has(e.stored[subject.store.name] ?? ""),
    );
    if (!committed)
      problems.push(`invariant 1: ${dir} is gone, but no committed offload of it is in the store`);
  }

  // 2
  const stub = `${dir}.plainport`;
  const shelved = project?.status === "shelved" && gone;
  if (present(stub) !== shelved) {
    problems.push(
      `invariant 2: the stub ${present(stub) ? "exists" : "is missing"}, but the project is ${
        shelved
          ? "shelved"
          : `${project?.status ?? "not in the catalog"} with its folder ${gone ? "gone" : "present"}`
      }`,
    );
  } else if (shelved) {
    const parsed = StubSchema.safeParse(JSON.parse(readFileSync(stub, "utf8")));
    if (!parsed.success) problems.push("invariant 2: the stub does not match the stub schema");
    else if (parsed.data.snapshot !== project?.head)
      problems.push(`invariant 2: the stub names ${parsed.data.snapshot}, the head is ${project?.head}`);
  }

  // 3
  const deadline = Date.now() + (subject.settleMs ?? 5_000);
  let left = leftovers(subject);
  while (left.length > 0 && Date.now() < deadline) {
    await Bun.sleep(25);
    left = leftovers(subject);
  }
  for (const path of left) problems.push(`invariant 3: ${path} remains from a finished operation`);
  return problems;
};
