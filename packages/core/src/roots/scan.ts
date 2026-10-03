// `plainport root scan` (DESIGN.md "Roots" → Project boundaries): finds every project under a root's folder on this
// device and registers the new ones in registry.json with a fresh ULID. A project already registered under the same
// root and path keeps its ULID; registered projects the scan no longer finds stay, since they may be offloaded.

import { join } from "node:path";
import { fail, finding, ok, type Result } from "@plainport/contract";
import type { LocalIo } from "../io.ts";
import type { Env, PlainportPaths } from "../paths.ts";
import { updateRegistry } from "../registry.ts";
import { ulid } from "../ulid.ts";
import { findProjects, type ProjectMarker } from "./boundary.ts";
import { listRoots, type RootView } from "./roots.ts";

export type ScannedProject = {
  id: string;
  /** `root:path`, e.g. work:clients/acme/web. */
  address: string;
  path: string;
  /** The project's folder on this device. */
  dir: string;
  marker: ProjectMarker;
  /** Registered by this scan. */
  new: boolean;
};

export interface ScanOptions {
  key: string;
  /** This device's name. */
  device: string;
  env: Env;
  now?: () => Date;
}

/** The root as this device sees it, or the finding that stops a command needing its folder. */
export const boundRoot = async (
  io: LocalIo,
  paths: PlainportPaths,
  options: { key: string; device: string; env: Env },
): Promise<Result<RootView & { path: string }>> => {
  const listed = await listRoots(io, paths, { env: options.env, device: options.device });
  if (!listed.ok) return listed;
  const { key } = options;
  const root = listed.value.roots.find((r) => r.key === key);
  if (root === undefined) {
    return fail(
      finding("root.not-found", {
        message: `there is no root ${key}`,
        fix: "plainport root list shows every root; plainport root add <key> <path> creates one",
      }),
    );
  }
  if (root.path === undefined) {
    return fail(
      finding("root.unbound", {
        message: `root ${key} has no folder on this device (${options.device})`,
        fix: `plainport root bind ${key} <path>`,
      }),
    );
  }
  if (root.state !== "ok") {
    return fail(
      finding("root.path-missing", {
        message:
          root.state === "unavailable"
            ? `root ${key}'s folder ${root.path} is on a volume that is not mounted`
            : `root ${key}'s folder ${root.path} does not exist`,
        fix:
          root.state === "unavailable"
            ? "mount the volume and re-run"
            : `create ${root.path}, or point the root at its new folder: plainport root bind ${key} <path>`,
        paths: [root.path],
      }),
    );
  }
  return ok({ ...root, path: root.path });
};

export const scanRoot = async (
  io: LocalIo,
  paths: PlainportPaths,
  options: ScanOptions,
): Promise<Result<{ root: RootView & { path: string }; projects: ScannedProject[] }>> => {
  const bound = await boundRoot(io, paths, options);
  if (!bound.ok) return bound;
  const root = bound.value;
  const found = (
    await findProjects(io, root.path, {
      ...(root.scan?.depth !== undefined && { depth: root.scan.depth }),
      ...(root.scan?.ignore !== undefined && { ignore: root.scan.ignore }),
    })
  ).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const now = (options.now ?? (() => new Date()))();
  const projects: ScannedProject[] = [];
  const updated = await updateRegistry(io, paths, (registry) => {
    projects.length = 0;
    const known = new Map(
      Object.entries(registry.projects)
        .filter(([, entry]) => entry.root === root.key)
        .map(([id, entry]) => [entry.path, id]),
    );
    for (const project of found) {
      let id = known.get(project.path);
      const isNew = id === undefined;
      if (id === undefined) {
        id = ulid(now.getTime());
        registry.projects[id] = { root: root.key, path: project.path, registeredAt: now.toISOString() };
      }
      projects.push({
        id,
        address: `${root.key}:${project.path}`,
        path: project.path,
        dir: join(root.path, ...project.path.split("/")),
        marker: project.marker,
        new: isNew,
      });
    }
    return ok(registry);
  });
  if (!updated.ok) return updated;
  return ok({ root, projects });
};
