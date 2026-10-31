// Sealing on stores through the CLI (M2 Task 20, T0: blob-fs on disk, the fake engine): a store set up with --seal
// publishes a sealed catalog, every event its offload writes is a seal envelope holding no project id, path or root
// key, the views read it by resolving the store's secret (D108: a sealed store is known as sealed before the key is
// needed), and an onload round-trips through it. The pins: a store whose seal policy flips is refused either way, an
// M1 store is never sealed in place (Q10), and store list shows each store's seal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { looksSealed } from "../../../core/src/catalog/seal.ts";
import { makeSandbox, type Sandbox } from "../../../core/src/testing/sandbox.ts";
import { capture, sandboxPorts } from "../testing.ts";
import { REGISTRY } from "./index.ts";

let box: Sandbox;
const cli = (argv: string[]) => capture(argv, REGISTRY, { ports: sandboxPorts(box.home) });
const envelope = (out: string) => JSON.parse(out.trim().split("\n").at(-1) as string);
const codeOf = (out: string) => envelope(out).error?.finding?.code as string | undefined;
const vault = () => join(box.home, "vault");
const identityAt = (store: string) => JSON.parse(readFileSync(join(store, "meta/v1/store.json"), "utf8"));
const eventFiles = (store: string): Buffer[] =>
  readdirSync(join(store, "meta/v1/events")).map((name) => readFileSync(join(store, "meta/v1/events", name)));
const sidecar = (id: string) =>
  JSON.parse(readFileSync(join(box.paths.stateDir, "stores", `${id}.json`), "utf8"));
const ok = async (argv: string[]) => {
  const ran = await cli(argv);
  if (ran.code !== 0) throw new Error(`${argv.join(" ")} exited ${ran.code}: ${ran.err}${ran.out}`);
  return ran;
};

const PROJECT = "webshop-frontend";
const ROOT = "client-projects";

beforeEach(() => {
  box = makeSandbox("plainport-seal-cli-");
  box.file(`${ROOT}/${PROJECT}/package.json`, `${JSON.stringify({ name: PROJECT })}\n`);
  box.file(`${ROOT}/${PROJECT}/src/main.ts`, "export const answer = 42;\n");
});
afterEach(() => box.cleanupSettled());

/** A sealed store set up by store add, the default store, and a root sending its snapshots there. */
const sealedHome = async () => {
  const added = envelope((await ok(["store", "add", "vault", "--path", "~/vault", "--seal", "--json"])).out);
  await ok(["init", "--root", `${ROOT}=~/${ROOT}`, "--device", "mbp", "--yes"]);
  return added.data as { id: string; sealed: boolean; outcome: string };
};

describe("sealing on stores (Task 20)", () => {
  test("a --seal store publishes a sealed catalog; its events are envelopes naming no project, path or root key; views and onload read them", async () => {
    const added = await sealedHome();
    expect(added).toMatchObject({ outcome: "published", sealed: true });
    expect(identityAt(vault()).catalog).toEqual({ seal: "v1" });
    expect(sidecar(added.id).seal.policy).toBe("v1");

    await ok(["offload", `${ROOT}:${PROJECT}`, "--yes", "--json"]);
    const registry = JSON.parse(readFileSync(box.paths.registryFile, "utf8"));
    const projectId = Object.keys(registry.projects)[0] as string;
    const rootId = registry.roots[ROOT] as string;
    const files = eventFiles(vault());
    expect(files.length).toBeGreaterThan(0);
    for (const bytes of files) {
      expect(looksSealed(bytes)).toBe(true);
      const text = bytes.toString("utf8");
      for (const secret of [projectId, rootId, ROOT, PROJECT, box.home]) expect(text).not.toContain(secret);
    }
    // The first key derived is pinned by its id.
    expect(sidecar(added.id).seal.kid).toMatch(/^[0-9a-f]{16}$/);

    // ls opens the store without the secret, sees from its identity that the catalog is sealed, then resolves the
    // secret and reads the store live (D105, D108).
    const ls = envelope((await ok(["ls", "--json"])).out).data;
    const project = ls.projects.find((p: { address: string }) => p.address === `${ROOT}:${PROJECT}`);
    expect([project?.state, project?.stale]).toEqual(["shelved", false]);
    await ok(["onload", `${ROOT}:${PROJECT}`, "--yes", "--json"]);
    expect(readFileSync(join(box.home, ROOT, PROJECT, "src/main.ts"), "utf8")).toBe(
      "export const answer = 42;\n",
    );

    const listed = envelope((await ok(["store", "list", "--json"])).out).data.stores;
    expect(listed.map((s: { name: string; sealed?: boolean }) => [s.name, s.sealed])).toEqual([
      ["vault", true],
    ]);
  });

  test("a store pinned sealed that now says plain is refused (store.identity-changed): views and write commands", async () => {
    const added = await sealedHome();
    await ok(["offload", `${ROOT}:${PROJECT}`, "--yes", "--json"]);
    writeFileSync(
      join(vault(), "meta/v1/store.json"),
      `${JSON.stringify({ ...identityAt(vault()), catalog: { seal: "none" } })}\n`,
    );
    const events = eventFiles(vault()).map((b) => b.toString("hex"));
    const onload = await cli(["onload", `${ROOT}:${PROJECT}`, "--yes", "--json"]);
    expect(codeOf(onload.out)).toBe("store.identity-changed");
    const ls = envelope((await cli(["ls", "--json"])).out);
    const store = ls.data.stores.find((s: { name: string }) => s.name === "vault");
    expect(store?.finding?.code).toBe("store.identity-changed");
    expect(eventFiles(vault()).map((b) => b.toString("hex"))).toEqual(events);
    expect(sidecar(added.id).seal.policy).toBe("v1");
  });

  test("a store pinned plain that now says sealed is refused (store.identity-changed)", async () => {
    await ok(["store", "add", "vault", "--path", "~/vault", "--no-seal", "--json"]);
    await ok(["init", "--root", `${ROOT}=~/${ROOT}`, "--device", "mbp", "--yes"]);
    await ok(["offload", `${ROOT}:${PROJECT}`, "--yes", "--json"]);
    expect(eventFiles(vault()).every((bytes) => !looksSealed(bytes))).toBe(true);
    writeFileSync(
      join(vault(), "meta/v1/store.json"),
      `${JSON.stringify({ ...identityAt(vault()), catalog: { seal: "v1" } })}\n`,
    );
    const onload = await cli(["onload", `${ROOT}:${PROJECT}`, "--yes", "--json"]);
    expect(codeOf(onload.out)).toBe("store.identity-changed");
    // Setting it up again (adopting it) is refused the same way, and records nothing new.
    const again = await cli(["store", "add", "vault", "--path", "~/vault", "--json"]);
    expect(codeOf(again.out)).toBe("store.identity-changed");
  });

  test("an M1 store is never sealed in place (Q10): store add --seal refuses before it writes anything", async () => {
    await ok(["init", "--root", `${ROOT}=~/${ROOT}`, "--store-path", "~/ssd", "--device", "mbp", "--yes"]);
    const ssd = join(box.home, "ssd");
    writeFileSync(join(ssd, "meta/v1/store.json"), `${JSON.stringify({ v: 1, id: identityAt(ssd).id })}\n`);
    const managed = readFileSync(box.paths.managedFile, "utf8");
    const registry = readFileSync(box.paths.registryFile, "utf8");
    const refused = await cli(["store", "add", "other", "--path", "~/ssd", "--seal", "--json"]);
    expect(refused.code).toBe(2);
    expect(codeOf(refused.out)).toBe("usage.invalid");
    expect(envelope(refused.out).error.finding.message).toContain("an M1 store is never sealed in place");
    expect(readFileSync(box.paths.managedFile, "utf8")).toBe(managed);
    expect(readFileSync(box.paths.registryFile, "utf8")).toBe(registry);
    expect(identityAt(ssd)).toEqual({ v: 1, id: identityAt(ssd).id });
  });

  test("--seal and --no-seal together are refused; a local store is plain by default", async () => {
    const both = await cli(["store", "add", "vault", "--path", "~/vault", "--seal", "--no-seal", "--json"]);
    expect(codeOf(both.out)).toBe("usage.invalid");
    const plain = envelope((await ok(["store", "add", "vault", "--path", "~/vault", "--json"])).out).data;
    expect(plain.sealed).toBe(false);
    expect(identityAt(vault()).catalog).toEqual({ seal: "none" });
  });
});
