// A folder as bytes: every entry below it with its mode and a hash of its content or link target. Tests compare two of
// these to prove a command wrote nothing (onload --dry-run, D71); no times, so reading is not a difference.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export const bytesOf = (
  root: string,
  skip: (path: string) => boolean = () => false,
): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const name of readdirSync(relative === "" ? root : join(root, relative)).sort()) {
      const path = relative === "" ? name : `${relative}/${name}`;
      if (skip(path)) continue;
      const full = join(root, path);
      const stat = lstatSync(full);
      const mode = (stat.mode & 0o7777).toString(8);
      if (stat.isSymbolicLink()) out[path] = `link ${mode} ${readlinkSync(full)}`;
      else if (stat.isDirectory()) {
        out[path] = `dir ${mode}`;
        walk(path);
      } else out[path] = `file ${mode} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`;
    }
  };
  walk("");
  return out;
};
