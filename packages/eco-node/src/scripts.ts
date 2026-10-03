// Whether a package script writes dist/ or build/ (DESIGN.md "Node plugin": those folders are proposed only when a
// package script writes them; a hand-made dist/ is the user's to keep). A script writes the folder when one of its
// commands
//
// - names it with an output flag: a long one (--outDir dist, --outdir=dist, --outfile=dist/index.js), or a short one
//   only for a tool known to mean output by it (ncc -o, tsup -d, babel -d),
// - copies into it, as the destination of a copy tool (cp -r public dist/, cpx 'src/**' dist), or
// - runs a tool whose default output it is (vite build → dist, react-scripts build → build), with no output flag
//   saying otherwise.
//
// Anything else is not a write, so when unsure the folder is kept: a path read (node dist/index.js, serve -s build,
// aws s3 sync build/ s3://…), a short flag of an unknown tool (gh-pages -d build publishes it), a deletion (rm,
// rimraf), and a bare word: `npm run build` and `next build` name a script and a subcommand, not the folder.

export type OutputFolder = "dist" | "build";

/** Long flags whose value is where a build writes. */
const OUTPUT_FLAGS = new Set([
  "--outDir",
  "--outdir",
  "--out-dir",
  "--outfile",
  "--out-file",
  "--dist-dir",
  "--output-path",
  "--output",
  "--out",
]);

/** Short flags that mean "output here" only for these tools; elsewhere -o and -d mean other things. */
const SHORT_OUTPUT_FLAGS: ReadonlyMap<string, readonly string[]> = new Map([
  ["ncc", ["-o"]],
  ["tsup", ["-d"]],
  ["babel", ["-d", "-o"]],
  ["swc", ["-d", "-o"]],
  ["webpack", ["-o"]],
  ["rollup", ["-o", "-d"]],
  ["microbundle", ["-o"]],
]);

/** Copy tools: their last argument is the destination they write. */
const COPIERS = new Set(["cp", "cpx", "cpy", "copyfiles", "ncp", "rsync", "ditto"]);

/** Commands that delete; what they name is not written. */
const DELETERS = new Set(["rm", "rimraf", "del", "del-cli", "trash", "shx"]);

/** Runners that start the command after them. */
const RUNNERS = new Set(["npx", "bunx", "cross-env", "dotenv", "env"]);
const TWO_WORD_RUNNERS = new Set(["pnpm exec", "pnpm dlx", "yarn exec", "yarn dlx", "npm exec"]);

/** Tools and the folder they write by default; `sub` is the subcommand that builds, when there is one. */
const DEFAULTS: readonly { tool: string; sub?: string; folder: OutputFolder }[] = [
  { tool: "vite", sub: "build", folder: "dist" },
  { tool: "tsup", folder: "dist" },
  { tool: "parcel", sub: "build", folder: "dist" },
  { tool: "webpack", folder: "dist" },
  { tool: "ng", sub: "build", folder: "dist" },
  { tool: "vue-cli-service", sub: "build", folder: "dist" },
  { tool: "astro", sub: "build", folder: "dist" },
  { tool: "unbuild", folder: "dist" },
  { tool: "microbundle", folder: "dist" },
  { tool: "react-scripts", sub: "build", folder: "build" },
  { tool: "docusaurus", sub: "build", folder: "build" },
  { tool: "remix", sub: "build", folder: "build" },
];

const unquote = (word: string): string => word.replace(/^['"]|['"]$/g, "");

/** The first folder of a path: ./dist/a.js → dist. */
const firstFolder = (path: string): string =>
  unquote(path)
    .replace(/^(\.\/)+/, "")
    .split("/")[0] ?? "";

/** Whether one command (no && or ;) writes the folder. */
const commandWrites = (command: string, folder: OutputFolder): boolean => {
  const words = command
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  let at = 0;
  for (;;) {
    const word = words[at];
    if (word === undefined) return false;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) at++;
    else if (RUNNERS.has(word)) at++;
    else if (TWO_WORD_RUNNERS.has(`${word} ${words[at + 1] ?? ""}`)) at += 2;
    else break;
  }
  const program = (words[at] ?? "").split("/").at(-1) ?? "";
  const args = words.slice(at + 1);
  if (DELETERS.has(program)) return false;

  const short = SHORT_OUTPUT_FLAGS.get(program) ?? [];
  const outputs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (!OUTPUT_FLAGS.has(flag) && !short.includes(flag)) continue;
    const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
    if (value !== undefined) outputs.push(value);
  }
  if (outputs.length > 0) return outputs.some((value) => firstFolder(value) === folder);
  if (COPIERS.has(program)) {
    const destination = args.filter((arg) => !arg.startsWith("-")).at(-1);
    return destination !== undefined && firstFolder(destination) === folder;
  }
  return DEFAULTS.some(
    (d) => d.folder === folder && d.tool === program && (d.sub === undefined || args[0] === d.sub),
  );
};

/** The name of the first script that writes the folder, or undefined when none does. */
export const scriptWriting = (
  scripts: Readonly<Record<string, unknown>>,
  folder: OutputFolder,
): string | undefined => {
  for (const [name, script] of Object.entries(scripts)) {
    if (typeof script !== "string") continue;
    if (script.split(/&&|\|\||;|\|/).some((command) => commandWrites(command, folder))) return name;
  }
  return undefined;
};
