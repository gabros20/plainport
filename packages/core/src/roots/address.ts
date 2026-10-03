// Project arguments (DESIGN.md "CLI design" → Project arguments): an address (`work:clients/acme/web`), a unique
// suffix (`web`, `acme/web`), a path, `.`, or a `.plainport` stub all name one project. A suffix that matches more
// than one registered project exits 2 with every candidate; a folder outside every root exits 2 with root.none.
// Paths are compared by their real paths, so a symlink into a root resolves like the folder itself.

import { join } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import type { LocalIo } from "../io.ts";
import { type Env, expandHome, type PlainportPaths } from "../paths.ts";
import { type ProjectRegistry, RelativePathSchema, readRegistry } from "../registry.ts";
import { readStub, STUB_SUFFIX } from "../stub.ts";
import { projectAt } from "./boundary.ts";
import { canonicalPath, overlapOf, probeKind } from "./canonical.ts";
import { listRoots, type RootView } from "./roots.ts";

export interface ProjectRef {
  /** `root:path`. */
  address: string;
  root: string;
  path: string;
  /** The project's ULID, when this device's registry or a stub knows it. */
  id?: string;
  /** Its folder on this device, when the root is bound here (or the registry holds an override). */
  dir?: string;
  /** The stub the project was named by. */
  stub?: string;
}

export interface ResolveOptions {
  /** What `.` and relative paths mean. */
  cwd: string;
  env: Env;
  /** This device's name; without it no root is bound here, so paths cannot resolve. */
  device?: string;
}

const ADDRESS = /^([a-z][a-z0-9-]*):(.*)$/;
const EXPLICIT_PATH = /^(\.{1,2}(\/|$)|\/|~(\/|$))/;

const notFound = (input: string, detail?: string) =>
  fail(
    finding("project.not-found", {
      message: `no project matches ${input}${detail === undefined ? "" : `: ${detail}`}`,
      fix: "name it by its address (root:path), or run plainport root scan <root> to register a root's projects",
    }),
  );

/** What is at the path; a path the file system refuses (a symlink loop, no permission) names no project. */
const kindAt = async (io: LocalIo, path: string) => {
  const probed = await probeKind(io, path);
  return probed.ok ? probed.value : undefined;
};

const dirOf = (root: RootView | undefined, path: string, override?: string): string | undefined =>
  override ?? (root?.path === undefined ? undefined : join(root.path, ...path.split("/")));

const idOf = (registry: ProjectRegistry, root: string, path: string) =>
  Object.entries(registry.projects).find(([, e]) => e.root === root && e.path === path);

const refOf = (registry: ProjectRegistry, roots: RootView[], root: string, path: string): ProjectRef => {
  const entry = idOf(registry, root, path);
  const dir = dirOf(
    roots.find((r) => r.key === root),
    path,
    entry?.[1].override,
  );
  return {
    address: `${root}:${path}`,
    root,
    path,
    ...(entry !== undefined && { id: entry[0] }),
    ...(dir !== undefined && { dir }),
  };
};

/** A folder on this device: the project of the root that holds it. */
const byPath = async (
  io: LocalIo,
  input: string,
  path: string,
  roots: RootView[],
  registry: ProjectRegistry,
): Promise<Result<ProjectRef>> => {
  if ((await kindAt(io, path)) === undefined)
    return notFound(input, `${path} does not exist or cannot be read`);
  const resolved = await canonicalPath(io, path);
  if (!resolved.ok) return notFound(input, resolved.finding.message);
  const canon = resolved.value;
  for (const root of roots) {
    if (root.path === undefined) continue;
    const rootResolved = await canonicalPath(io, root.path);
    if (!rootResolved.ok) continue; // a root whose folder cannot be resolved holds nothing reachable here
    const rootCanon = rootResolved.value;
    const relation = overlapOf(canon, rootCanon);
    if (relation === "same") return notFound(input, `${path} is the folder of root ${root.key} itself`);
    if (relation !== "inside") continue;
    const depth = rootCanon.real.split("/").filter((s) => s !== "").length;
    const segments = canon.real.split("/").filter((s) => s !== "");
    const relative = segments.slice(depth).join("/");
    const registered = Object.values(registry.projects)
      .filter((e) => e.root === root.key && (relative === e.path || relative.startsWith(`${e.path}/`)))
      .sort((a, b) => a.path.length - b.path.length)[0];
    if (registered !== undefined) return ok(refOf(registry, roots, root.key, registered.path));
    const found = await projectAt(io, rootCanon.real, relative);
    return ok(refOf(registry, roots, root.key, found?.path ?? relative));
  }
  return fail(
    finding("root.none", {
      message: `${path} is outside every root on this device`,
      fix: "file it under a root with --root <key> --as <relative path>, or add a root that holds it: plainport root add <key> <path>",
      paths: [path],
    }),
  );
};

export const resolveProject = async (
  io: LocalIo,
  paths: PlainportPaths,
  input: string,
  options: ResolveOptions,
): Promise<Result<ProjectRef>> => {
  const listed = await listRoots(io, paths, {
    env: options.env,
    ...(options.device !== undefined && { device: options.device }),
  });
  if (!listed.ok) return listed;
  const { roots } = listed.value;
  const registered = await readRegistry(io, paths);
  if (!registered.ok) return registered;
  const registry = registered.value;
  const absolute = (text: string) => expandHome(text, paths.home, options.cwd);

  if (input.endsWith(STUB_SUFFIX) && (await kindAt(io, absolute(input))) === "file") {
    const file = absolute(input);
    const stub = await readStub(io, file);
    if (!stub.ok) return stub;
    const root = roots.find((r) => r.key === stub.value.root);
    if (root === undefined) {
      return fail(
        finding("root.not-found", {
          message: `the stub ${file} names root ${stub.value.root}, which this device does not know`,
          fix: `plainport root add ${stub.value.root} <path>`,
          paths: [file],
        }),
      );
    }
    const dir = dirOf(root, stub.value.path);
    return ok({
      address: `${root.key}:${stub.value.path}`,
      root: root.key,
      path: stub.value.path,
      id: stub.value.project,
      ...(dir !== undefined && { dir }),
      stub: file,
    });
  }

  const address = ADDRESS.exec(input);
  if (address !== null) {
    const [, key, path] = address as unknown as [string, string, string];
    if (!roots.some((r) => r.key === key)) {
      return fail(
        finding("root.not-found", {
          message: `${input} names root ${key}, which does not exist`,
          fix: "plainport root list shows every root",
        }),
      );
    }
    if (!RelativePathSchema.safeParse(path).success) {
      return fail(
        finding("usage.invalid", {
          message: `${input} is not an address: the part after ${key}: must be a relative path such as clients/acme/web`,
          fix: `name the project as ${key}:<relative path>`,
        }),
      );
    }
    return ok(refOf(registry, roots, key, path));
  }

  if (EXPLICIT_PATH.test(input)) return byPath(io, input, absolute(input), roots, registry);

  const matches = Object.values(registry.projects)
    .filter((e) => e.path === input || e.path.endsWith(`/${input}`))
    .map((e) => `${e.root}:${e.path}`)
    .sort();
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) {
    const [root, path] = only.split(/:(.*)/s) as [string, string];
    return ok(refOf(registry, roots, root, path));
  }
  if (matches.length > 1) {
    return fail(
      finding("project.ambiguous", {
        message: `${input} matches ${matches.length} projects: ${matches.join(", ")}`,
        fix: `name one by its address, e.g. ${matches[0]}`,
      }),
    );
  }
  if ((await kindAt(io, absolute(input))) !== undefined)
    return byPath(io, input, absolute(input), roots, registry);
  return notFound(input);
};
