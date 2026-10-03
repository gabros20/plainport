// Package manager detection (DESIGN.md "Plugin interfaces → Node plugin: package manager detection"). The lockfile
// names the package manager and its frozen install; the `packageManager` field in package.json overrides it. Two
// lockfiles with no field to decide are deps.ambiguous, and a missing lockfile is deps.no-lockfile: the install
// then resolves fresh versions.

export type PackageManager = "pnpm" | "npm" | "yarn-berry" | "yarn-classic" | "bun";

export interface PackageManagerChoice {
  manager: PackageManager;
  /** The lockfile the frozen install reads; absent when there is none. */
  lockfile?: string;
  /** The install command: frozen when there is a lockfile. */
  argv: string[];
  problem?: { kind: "ambiguous"; lockfiles: string[] } | { kind: "no-lockfile" };
}

export interface PackageManagerInput {
  /** package.json's packageManager field, e.g. "pnpm@9.12.0". */
  packageManager?: string;
  /** The lockfile names present in the package folder. */
  lockfiles: ReadonlySet<string>;
  /** Whether .yarnrc.yml is present: yarn.lock with it is Yarn Berry. */
  yarnrc: boolean;
}

/** The detection table, in DESIGN.md's order; the first row wins when lockfiles disagree. */
const TABLE: readonly {
  lockfiles: readonly string[];
  manager: (input: PackageManagerInput) => PackageManager;
}[] = [
  { lockfiles: ["pnpm-lock.yaml"], manager: () => "pnpm" },
  { lockfiles: ["package-lock.json", "npm-shrinkwrap.json"], manager: () => "npm" },
  { lockfiles: ["yarn.lock"], manager: (input) => (input.yarnrc ? "yarn-berry" : "yarn-classic") },
  { lockfiles: ["bun.lock", "bun.lockb"], manager: () => "bun" },
];

const FROZEN: Record<PackageManager, string[]> = {
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  npm: ["npm", "ci"],
  "yarn-berry": ["yarn", "install", "--immutable"],
  "yarn-classic": ["yarn", "install", "--frozen-lockfile"],
  bun: ["bun", "install", "--frozen-lockfile"],
};

const FRESH: Record<PackageManager, string[]> = {
  pnpm: ["pnpm", "install"],
  npm: ["npm", "install"],
  "yarn-berry": ["yarn", "install"],
  "yarn-classic": ["yarn", "install"],
  bun: ["bun", "install"],
};

/** Every lockfile name the table knows. */
export const LOCKFILES: readonly string[] = TABLE.flatMap((row) => row.lockfiles);

/** The manager a packageManager field names ("<name>@<version>", as Corepack reads it), if it is one this knows. */
const fromField = (field: string | undefined): PackageManager | undefined => {
  const match = /^(npm|pnpm|yarn|bun)@(\d+)[^\s]*$/.exec(field?.trim() ?? "");
  if (match === null) return undefined;
  const [, name, major] = match as unknown as [string, string, string];
  if (name === "yarn") return Number(major) >= 2 ? "yarn-berry" : "yarn-classic";
  return name as PackageManager;
};

const LOCKFILES_OF: Record<PackageManager, readonly string[]> = {
  pnpm: ["pnpm-lock.yaml"],
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  "yarn-berry": ["yarn.lock"],
  "yarn-classic": ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
};

export const choosePackageManager = (input: PackageManagerInput): PackageManagerChoice => {
  const declared = fromField(input.packageManager);
  if (declared !== undefined) {
    const lockfile = LOCKFILES_OF[declared].find((name) => input.lockfiles.has(name));
    return lockfile === undefined
      ? { manager: declared, argv: FRESH[declared], problem: { kind: "no-lockfile" } }
      : { manager: declared, lockfile, argv: FROZEN[declared] };
  }
  const present = TABLE.flatMap((row) => {
    const lockfile = row.lockfiles.find((name) => input.lockfiles.has(name));
    return lockfile === undefined ? [] : [{ lockfile, manager: row.manager(input) }];
  });
  const [first] = present;
  if (first === undefined) return { manager: "npm", argv: FRESH.npm, problem: { kind: "no-lockfile" } };
  const choice: PackageManagerChoice = {
    manager: first.manager,
    lockfile: first.lockfile,
    argv: FROZEN[first.manager],
  };
  if (present.length > 1)
    choice.problem = { kind: "ambiguous", lockfiles: present.map((p) => p.lockfile).sort() };
  return choice;
};

/** How a manager is named to people. */
export const MANAGER_NAMES: Record<PackageManager, string> = {
  pnpm: "pnpm",
  npm: "npm",
  "yarn-berry": "Yarn Berry",
  "yarn-classic": "Yarn Classic",
  bun: "Bun",
};
