import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { nodeLocalIo } from "../node-io.ts";
import { makeSandbox, type Sandbox } from "../testing/sandbox.ts";
import { resolveProject } from "./address.ts";
import { scanRoot } from "./scan.ts";

const io = nodeLocalIo;
let box: Sandbox;
let ids: Record<string, string>;

beforeEach(async () => {
  box = makeSandbox();
  box.file(
    ".config/plainport/config.toml",
    '[roots.work]\non = { mbp = "~/work" }\n[roots.personal]\non = { mbp = "~/personal" }\n',
  );
  box.repo("work/clients/acme/web");
  box.repo("work/clients/globex/web");
  box.repo("work/api");
  box.dir("work/api/src/deep");
  box.repo("personal/blog");
  ids = {};
  for (const key of ["work", "personal"]) {
    const scanned = await scanRoot(io, box.paths, { key, device: "mbp", env: {} });
    if (!scanned.ok) throw new Error(scanned.finding.message);
    for (const p of scanned.value.projects) ids[p.address] = p.id;
  }
});
afterEach(() => box.cleanup());

const resolve = (input: string, cwd = box.home) =>
  resolveProject(io, box.paths, input, { cwd, env: {}, device: "mbp" });

const address = async (input: string, cwd?: string) => {
  const result = await resolve(input, cwd);
  if (!result.ok) throw new Error(`${input}: ${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

describe("roots: project addresses", () => {
  test("a full address resolves to its root, path, id and local folder", async () => {
    expect(await address("work:clients/acme/web")).toEqual({
      address: "work:clients/acme/web",
      root: "work",
      path: "clients/acme/web",
      id: ids["work:clients/acme/web"] as string,
      dir: join(box.home, "work/clients/acme/web"),
    });
  });

  test("a unique suffix resolves, by last segment or by several", async () => {
    expect((await address("api")).address).toBe("work:api");
    expect((await address("blog")).address).toBe("personal:blog");
    expect((await address("acme/web")).address).toBe("work:clients/acme/web");
  });

  test("an ambiguous suffix exits 2 with project.ambiguous listing every candidate", async () => {
    const result = await resolve("web");
    expect(result).toMatchObject({ ok: false, exitCode: 2, finding: { code: "project.ambiguous" } });
    if (result.ok) return;
    expect(result.finding.message).toContain("work:clients/acme/web");
    expect(result.finding.message).toContain("work:clients/globex/web");
  });

  test("a path, relative or absolute, resolves to the project that holds it", async () => {
    expect((await address("work/api", box.home)).address).toBe("work:api");
    expect((await address(join(box.home, "work/api/src/deep"))).address).toBe("work:api");
    expect((await address("~/personal/blog")).address).toBe("personal:blog");
  });

  test(". resolves from inside a project's subfolder", async () => {
    expect((await address(".", join(box.home, "work/api/src/deep"))).address).toBe("work:api");
    expect((await address(".", join(box.home, "work/clients/acme/web"))).id).toBe(
      ids["work:clients/acme/web"] as string,
    );
  });

  test("a path through a symlink resolves by its real path", async () => {
    symlinkSync(join(box.home, "work"), join(box.home, "w"));
    expect((await address("~/w/api")).address).toBe("work:api");
  });

  test("an unregistered project folder inside a root still resolves, by its boundary", async () => {
    box.repo("work/fresh");
    box.dir("work/fresh/src");
    expect(await address("~/work/fresh/src")).toMatchObject({ address: "work:fresh", root: "work" });
    expect((await address("~/work/fresh/src")).id).toBeUndefined();
  });

  test("a .plainport stub resolves to the project it stands for", async () => {
    const stub = box.file(
      "work/clients/old.plainport",
      JSON.stringify({
        plainport: 1,
        project: "01J8A2C4E6G8J0K2M4P6R8T0VW",
        root: "work",
        rootId: "01J6RT7W2K9M4N6P8Q0S2V4X6Z",
        path: "clients/old",
        store: "mini",
        snapshot: "01J9Z6K2B8D4F6H8K0M2P4R6T8",
        offloadedAt: "2026-09-29T14:02:11Z",
        bytes: 1934000000,
        restore: "plainport onload work:clients/old",
      }),
    );
    expect(await address(stub)).toEqual({
      address: "work:clients/old",
      root: "work",
      path: "clients/old",
      id: "01J8A2C4E6G8J0K2M4P6R8T0VW",
      dir: join(box.home, "work/clients/old"),
      stub,
    });
    expect((await address("clients/old.plainport", join(box.home, "work"))).address).toBe("work:clients/old");
  });

  test("a damaged stub is stub.invalid", async () => {
    const stub = box.file("work/bad.plainport", "{}");
    expect(await resolve(stub)).toMatchObject({ ok: false, finding: { code: "stub.invalid" } });
  });

  test("a folder outside every root exits 2 with root.none", async () => {
    box.repo("loose/thing");
    expect(await resolve("~/loose/thing")).toMatchObject({
      ok: false,
      exitCode: 2,
      finding: { code: "root.none" },
    });
  });

  test("nothing by that name is project.not-found (4); a root's own folder is not a project", async () => {
    expect(await resolve("nothing-here")).toMatchObject({
      ok: false,
      exitCode: 4,
      finding: { code: "project.not-found" },
    });
    expect(await resolve("~/work")).toMatchObject({ ok: false, finding: { code: "project.not-found" } });
    expect(await resolve("~/work/missing")).toMatchObject({
      ok: false,
      finding: { code: "project.not-found" },
    });
  });

  test("an address must name a known root and a clean relative path", async () => {
    expect(await resolve("nope:web")).toMatchObject({
      ok: false,
      exitCode: 4,
      finding: { code: "root.not-found" },
    });
    expect(await resolve("work:../escape")).toMatchObject({
      ok: false,
      exitCode: 2,
      finding: { code: "usage.invalid" },
    });
    expect(await resolve("work:")).toMatchObject({ ok: false, exitCode: 2 });
  });
});
