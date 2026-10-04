import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export function projectSlug(cwd: string): string {
  return realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

/** Canonicalize existing ancestors even when the override directory has not been created yet. */
function configPath(path: string): string {
  if (existsSync(path) || isSymlink(path)) return realpathSync(path);
  return join(configPath(dirname(path)), basename(path));
}

export function prepareSessionCleanup(home: string, cwd: string, claudeConfigDir?: string) {
  const canonical = realpathSync(cwd);
  const prefix = basename(canonical);
  if (!/^plainport-agent-smoke-[a-zA-Z0-9]+$/.test(prefix))
    throw new Error("Session cleanup requires the unique eval temporary directory prefix.");
  const root = claudeConfigDir
    ? join(configPath(resolve(canonical, claudeConfigDir)), "projects")
    : resolve(realpathSync(home), ".claude/projects");
  const path = join(root, projectSlug(canonical));
  return { root, path, prefix, existed: existsSync(path) || isSymlink(path) };
}

function isSymlink(path: string) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function cleanupSession(plan: ReturnType<typeof prepareSessionCleanup>): string[] {
  const { root, path, prefix, existed } = plan;
  const child = relative(root, path);
  if (
    !/^plainport-agent-smoke-[a-zA-Z0-9]+$/.test(prefix) ||
    !basename(path).includes(prefix) ||
    dirname(path) !== root ||
    child.startsWith(`..${sep}`) ||
    child === ".." ||
    resolve(root, child) !== path
  )
    throw new Error("Session cleanup path failed the projects containment guard.");
  if (existed) return [];
  // Reject symlinks in every existing ancestor, including a substituted projects root.
  for (let ancestor = path; ancestor !== dirname(ancestor); ancestor = dirname(ancestor))
    if (isSymlink(ancestor)) throw new Error("Session cleanup refuses symlink paths.");
  if (!existsSync(path)) return [];
  if (dirname(realpathSync(path)) !== realpathSync(root))
    throw new Error("Session cleanup realpath escaped projects.");
  rmSync(path, { recursive: true });
  return [path];
}
