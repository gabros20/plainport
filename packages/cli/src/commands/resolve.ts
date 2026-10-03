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
  findView,
  type PlainportPaths,
  type ProjectRef,
  type ProjectStatus,
  projectViews,
  resolveProject,
  type Views,
} from "@plainport/core";
import type { CommandContext } from "../registry.ts";
import { thisDevice } from "./local.ts";

const EXPLICIT_PATH = /^(\.{1,2}(\/|$)|\/|~(\/|$))/;

/** This device, and every project it knows with its state (core's projectViews). */
export const knownProjects = async (
  ctx: CommandContext,
): Promise<Result<{ paths: PlainportPaths; device: Device; views: Views }>> => {
  const local = await thisDevice(ctx);
  if (!local.ok) return local;
  const { paths, device } = local.value;
  const read = await projectViews({
    io: ctx.io,
    paths,
    env: ctx.env,
    device,
    loader: new ConfigLoader(ctx.io, paths),
    opener: ctx.stores,
    openMirror: (storeId) => openEventMirror(ctx.io, paths, storeId),
    now: () => ctx.clock.now(),
  });
  if (!read.ok) return read;
  return ok({ paths, device, views: read.value });
};

/** A project the views know, as core's operations take it. */
const refOf = (view: ProjectStatus): ProjectRef => ({
  address: view.address,
  root: view.root,
  path: view.path,
  id: view.id,
  ...(view.dir === undefined ? {} : { dir: view.dir }),
  ...(view.stub === undefined ? {} : { stub: view.stub }),
  match: "address",
});

const ambiguous = (input: string, matches: readonly ProjectStatus[], command: string) =>
  fail(
    finding("project.ambiguous", {
      message: `${input} names more than one project: ${matches.map((p) => p.address).join(", ")}`,
      fix: `name it by its address, e.g. plainport ${command} ${shellWord(matches[0]?.address ?? input)}`,
    }),
  );

/** The project `input` names (see the file comment), and its view when the views hold it. */
export const resolveKnown = async (
  ctx: CommandContext,
  known: { paths: PlainportPaths; device: Device; views: Views },
  input: string,
  command: string,
): Promise<Result<{ ref: ProjectRef; view?: ProjectStatus }>> => {
  const { paths, device, views } = known;
  if (!EXPLICIT_PATH.test(input) && !input.includes(":")) {
    const suffix = input.replace(/^\/+|\/+$/g, "");
    const matches = views.projects.filter((p) => p.path === suffix || p.path.endsWith(`/${suffix}`));
    if (matches.length > 1) return ambiguous(input, matches, command);
    const [only] = matches;
    if (only !== undefined) return ok({ ref: refOf(only), view: only });
  }
  const resolved = await resolveProject(ctx.io, paths, input, {
    cwd: ctx.cwd,
    env: ctx.env,
    device: device.name,
  });
  if (resolved.ok) {
    const view = findView(views, resolved.value);
    return ok({ ref: resolved.value, ...(view.ok ? { view: view.value } : {}) });
  }
  if (
    EXPLICIT_PATH.test(input) &&
    (resolved.finding.code === "project.not-found" || resolved.finding.code === "root.none")
  ) {
    const at = expandHome(input, paths.home, ctx.cwd).replace(/\/+$/, "");
    const found = views.projects.find((p) => p.dir === at || `${p.dir}.plainport` === at);
    if (found !== undefined) return ok({ ref: refOf(found), view: found });
  }
  return resolved;
};
