// Project arguments (DESIGN.md "CLI design" → Project arguments): an address (`work:clients/acme/web`), a unique
// suffix (`web`, `acme/web`), a path, `.`, or a `.plainport` stub all name one project. A suffix that matches more
// than one registered project exits 2 with every candidate; a folder outside every root exits 2 with root.none.
// Paths are compared by their real paths, so a symlink into a root resolves like the folder itself.
//
// Only a project resolves (DESIGN.md "Roots" → Project boundaries): a registered project, or the outermost folder
// with `.git` or a project marker. A path or address inside a project names that project, as git finds its
// repository from a subfolder. A grouping folder (`clients/acme`) is never a project: naming one lists the
// projects inside it (exit 2), and a folder holding none is project.not-found.

import { join } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import type { LocalIo } from "../io.ts";
import { type Env, expandHome, type PlainportPaths } from "../paths.ts";
import { type ProjectRegistry, RelativePathSchema, readRegistry } from "../registry.ts";
import { readStub, STUB_SUFFIX } from "../stub.ts";
import { findProjects, projectAt } from "./boundary.ts";
import { canonicalPath, overlapOf, probeKind } from "./canonical.ts";
import { listRoots, type RootView } from "./roots.ts";

/**
 * How the project was found: in this device's registry; by its boundary on disk (not registered yet); from a stub;
 * or only as an address whose folder is not on this device (an offloaded project, say), which nothing here checked.
 */
export type ProjectMatch = "registered" | "boundary" | "stub" | "address";

export interface ProjectRef {
  /** `root:path`. */
  address: string;
  root: string;
  path: string;
  /** The project's ULID, when this device's registry or a stub knows it. */
  id?: string;
  /** Its folder on this device, when the root is bound here (or the registry holds an override). */
  dir?: string;
  /** The root's place for it on this device (the binding plus the path), whatever an override says. */
  place?: string;
  /** The stub the project was named by. */
  stub?: string;
  match: ProjectMatch;
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

const within = (path: string, outer: string): boolean => path === outer || path.startsWith(`${outer}/`);

interface Known {
  roots: RootView[];
  registry: ProjectRegistry;
}

const refOf = (known: Known, root: string, path: string, match: ProjectMatch): ProjectRef => {
  const entry = Object.entries(known.registry.projects).find(([, e]) => e.root === root && e.path === path);
  const rootView = known.roots.find((r) => r.key === root);
  const place = rootView?.path === undefined ? undefined : join(rootView.path, ...path.split("/"));
  const dir = entry?.[1].override ?? place;
  return {
    address: `${root}:${path}`,
    root,
    path,
    ...(entry !== undefined && { id: entry[0] }),
    ...(dir !== undefined && { dir }),
    ...(place !== undefined && { place }),
    match,
  };
};

/** The outermost registered project at or above `relative` in the root. */
const registeredHolding = (known: Known, root: string, relative: string): string | undefined =>
  Object.values(known.registry.projects)
    .filter((e) => e.root === root && within(relative, e.path))
    .map((e) => e.path)
    .sort((a, b) => a.length - b.length)[0];

/**
 * The project a folder inside a root belongs to. `folder` is the root's folder on this device; `exists` says
 * whether `relative` exists in it (an address may name a folder that is not here).
 */
const projectIn = async (
  io: LocalIo,
  input: string,
  known: Known,
  root: string,
  folder: string,
  relative: string,
  exists: boolean,
): Promise<Result<ProjectRef>> => {
  const registered = registeredHolding(known, root, relative);
  if (registered !== undefined) return ok(refOf(known, root, registered, "registered"));
  if (!exists) return ok(refOf(known, root, relative, "address"));
  const found = await projectAt(io, folder, relative);
  if (found !== undefined) return ok(refOf(known, root, found.path, "boundary"));

  const dir = join(folder, ...relative.split("/"));
  const inside = new Set(
    Object.values(known.registry.projects)
      .filter((e) => e.root === root && e.path.startsWith(`${relative}/`))
      .map((e) => `${root}:${e.path}`),
  );
  for (const project of await findProjects(io, dir)) inside.add(`${root}:${relative}/${project.path}`);
  const candidates = [...inside].sort();
  if (candidates.length === 0) return notFound(input, `${dir} holds no project (no .git or project marker)`);
  return fail(
    finding("project.ambiguous", {
      message: `${input} is a grouping folder, not a project; it holds ${candidates.length} project${candidates.length === 1 ? "" : "s"}: ${candidates.join(", ")}`,
      fix: `name one project, e.g. ${candidates[0]}`,
    }),
  );
};

/** A folder on this device: the project of the root (or the onload override) that holds it. */
const byPath = async (
  io: LocalIo,
  input: string,
  path: string,
  known: Known,
  home: string,
): Promise<Result<ProjectRef>> => {
  if ((await kindAt(io, path)) === undefined)
    return notFound(input, `${path} does not exist or cannot be read`);
  const resolved = await canonicalPath(io, path, home);
  if (!resolved.ok) return notFound(input, resolved.finding.message);
  const canon = resolved.value;

  // A project onloaded to a one-off folder (`onload --to`) lives at its override, which may be outside every root.
  for (const entry of Object.values(known.registry.projects)) {
    if (entry.override === undefined) continue;
    const override = await canonicalPath(io, entry.override, home);
    if (!override.ok) continue;
    const relation = overlapOf(canon, override.value);
    if (relation === "same" || relation === "inside")
      return ok(refOf(known, entry.root, entry.path, "registered"));
  }

  for (const root of known.roots) {
    if (root.path === undefined) continue;
    const rootResolved = await canonicalPath(io, root.path, home);
    if (!rootResolved.ok) continue; // a root whose folder cannot be resolved holds nothing reachable here
    const rootCanon = rootResolved.value;
    const relation = overlapOf(canon, rootCanon);
    if (relation === "same") return notFound(input, `${path} is the folder of root ${root.key} itself`);
    if (relation !== "inside") continue;
    const depth = rootCanon.real.split("/").filter((s) => s !== "").length;
    const relative = canon.real
      .split("/")
      .filter((s) => s !== "")
      .slice(depth)
      .join("/");
    return projectIn(io, input, known, root.key, rootCanon.real, relative, true);
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
  const registered = await readRegistry(io, paths);
  if (!registered.ok) return registered;
  const known: Known = { roots: listed.value.roots, registry: registered.value };
  const absolute = (text: string) => expandHome(text, paths.home, options.cwd);

  if (input.endsWith(STUB_SUFFIX) && (await kindAt(io, absolute(input))) === "file") {
    const file = absolute(input);
    const stub = await readStub(io, file);
    if (!stub.ok) return stub;
    if (!known.roots.some((r) => r.key === stub.value.root)) {
      return fail(
        finding("root.not-found", {
          message: `the stub ${file} names root ${stub.value.root}, which this device does not know`,
          fix: `plainport root add ${stub.value.root} <path>`,
          paths: [file],
        }),
      );
    }
    const ref = refOf(known, stub.value.root, stub.value.path, "stub");
    return ok({ ...ref, id: stub.value.project, stub: file });
  }

  const address = ADDRESS.exec(input);
  if (address !== null) {
    const [, key, path] = address as unknown as [string, string, string];
    const root = known.roots.find((r) => r.key === key);
    if (root === undefined) {
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
    const folder = root.state === "ok" ? root.path : undefined;
    const exists = folder !== undefined && (await kindAt(io, join(folder, ...path.split("/")))) === "dir";
    return projectIn(io, input, known, key, folder ?? "", path, exists);
  }

  if (EXPLICIT_PATH.test(input)) return byPath(io, input, absolute(input), known, paths.home);

  const matches = Object.values(known.registry.projects)
    .filter((e) => e.path === input || e.path.endsWith(`/${input}`))
    .map((e) => ({ root: e.root, path: e.path }))
    .sort((a, b) => `${a.root}:${a.path}`.localeCompare(`${b.root}:${b.path}`));
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return ok(refOf(known, only.root, only.path, "registered"));
  if (matches.length > 1) {
    const addresses = matches.map((m) => `${m.root}:${m.path}`);
    return fail(
      finding("project.ambiguous", {
        message: `${input} matches ${matches.length} projects: ${addresses.join(", ")}`,
        fix: `name one by its address, e.g. ${addresses[0]}`,
      }),
    );
  }
  if ((await kindAt(io, absolute(input))) !== undefined)
    return byPath(io, input, absolute(input), known, paths.home);
  return notFound(input);
};
