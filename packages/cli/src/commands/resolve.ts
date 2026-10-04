// The one resolver for commands that name a project the catalog may know better than this device (status, restore):
// DESIGN "CLI design" → Project arguments. A plain name is matched as a suffix across every project this device knows,
// registered and catalog-only alike, so a name two projects share is ambiguous (exit 2, both listed). Anything else
// goes to core's resolver (an address, a path, `.`, a stub); a path it cannot resolve because its folder is gone
// (offloaded with no stub, say) is matched against the projects' folders and stubs.

import { openEventMirror } from "@plainport/blob-fs";
import { fail, finding, ok, type Result, shellWord } from "@plainport/contract";
import {
  ConfigLoader,
  type Device,
  expandHome,
  type KnownProject,
  loadProjects,
  type PlainportPaths,
  type ProjectRef,
  type ProjectSet,
  resolveProject,
  type ViewDeps,
} from "@plainport/core";
import type { CommandContext } from "../registry.ts";
import { thisDevice } from "./local.ts";

const EXPLICIT_PATH = /^(\.{1,2}(\/|$)|\/|~(\/|$))/;

/** What core's views read, for this command. */
export const viewDeps = (ctx: CommandContext, paths: PlainportPaths, device: Device): ViewDeps => ({
  io: ctx.io,
  paths,
  env: ctx.env,
  device,
  loader: new ConfigLoader(ctx.io, paths),
  opener: ctx.stores,
  openMirror: (storeId) => openEventMirror(ctx.io, paths, storeId),
  now: () => ctx.clock.now(),
  plugins: ctx.plugins,
  planning: { host: ctx.system, checks: ctx.checks, plugins: ctx.plugins },
});

/** This device, and every project it knows (core's loadProjects); each one's view is built only when asked for. */
export const knownProjects = async (
  ctx: CommandContext,
): Promise<Result<{ paths: PlainportPaths; device: Device; set: ProjectSet }>> => {
  const local = await thisDevice(ctx);
  if (!local.ok) return local;
  const { paths, device } = local.value;
  const read = await loadProjects(viewDeps(ctx, paths, device));
  if (!read.ok) return read;
  return ok({ paths, device, set: read.value });
};

/**
 * project.not-found for a project neither this device nor any catalog knows. A project folder found under a root
 * (not registered yet) is named as such: offload takes it as it is, so the fix does not make registering look needed.
 */
export const notKnown = (ref: ProjectRef) =>
  fail(
    finding(
      "project.not-found",
      ref.match === "boundary" && ref.dir !== undefined
        ? {
            message: `${ref.dir} is a project folder under root ${ref.root} that this device has not registered or offloaded yet, so it has no status`,
            fix: `plainport offload ${shellWord(ref.address)} --dry-run plans offloading it as it is (offload needs no registration); plainport root scan ${shellWord(ref.root)} registers the root's projects so ls and status show them`,
            paths: [ref.dir],
          }
        : {
            message: `neither this device nor the catalog of any store it set up knows ${ref.address}`,
            fix: "plainport ls lists the projects; plainport root scan <root> registers a root's projects",
          },
    ),
  );

/** A project the views know, as core's operations take it. */
const refOf = (known: KnownProject): ProjectRef => ({
  address: known.address,
  root: known.root,
  path: known.path,
  id: known.id,
  ...(known.dir === undefined ? {} : { dir: known.dir }),
  ...(known.stub === undefined ? {} : { stub: known.stub }),
  match: "address",
});

const ambiguous = (input: string, matches: readonly KnownProject[], command: string) =>
  fail(
    finding("project.ambiguous", {
      message: `${input} names more than one project: ${matches.map((p) => p.address).join(", ")}`,
      fix: `name it by its address, e.g. plainport ${command} ${shellWord(matches[0]?.address ?? input)}`,
    }),
  );

/** The project `input` names (see the file comment), and the known project when one matches. */
export const resolveKnown = async (
  ctx: CommandContext,
  known: { paths: PlainportPaths; device: Device; set: ProjectSet },
  input: string,
  command: string,
): Promise<Result<{ ref: ProjectRef; known?: KnownProject }>> => {
  const { paths, device, set } = known;
  if (!EXPLICIT_PATH.test(input) && !input.includes(":")) {
    const suffix = input.replace(/^\/+|\/+$/g, "");
    const matches = set.known.filter((p) => p.path === suffix || p.path.endsWith(`/${suffix}`));
    if (matches.length > 1) return ambiguous(input, matches, command);
    const [only] = matches;
    if (only !== undefined) return ok({ ref: refOf(only), known: only });
  }
  const resolved = await resolveProject(ctx.io, paths, input, {
    cwd: ctx.cwd,
    env: ctx.env,
    device: device.name,
  });
  if (resolved.ok) {
    const ref = resolved.value;
    const match =
      (ref.id === undefined ? undefined : set.known.find((p) => p.id === ref.id)) ??
      set.known.find((p) => p.address === ref.address);
    return ok({ ref, ...(match === undefined ? {} : { known: match }) });
  }
  if (
    EXPLICIT_PATH.test(input) &&
    (resolved.finding.code === "project.not-found" || resolved.finding.code === "root.none")
  ) {
    const at = expandHome(input, paths.home, ctx.cwd).replace(/\/+$/, "");
    const found = set.known.find((p) => p.dir === at || `${p.dir}.plainport` === at);
    if (found !== undefined) return ok({ ref: refOf(found), known: found });
  }
  return resolved;
};
