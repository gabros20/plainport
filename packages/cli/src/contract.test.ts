// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell code, where ${…} is shell syntax.
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contractJsonSchemas,
  type FailureExitCode,
  FINDINGS,
  finding,
  parseJsonLines,
  RISK_CLASSES,
} from "@plainport/contract";
import { acquireLock, resolvePaths } from "@plainport/core";
import Ajv2020 from "ajv/dist/2020";
import { testHost } from "../../core/src/testing/host.ts";
import { REGISTRY } from "./commands/index.ts";
import { generateFiles, staleFiles, writeFiles } from "./generate.ts";
import type { AnyCommand, Ports, Registry } from "./registry.ts";
import { type Captured, capture, exampleHome, FAKE_REGISTRY } from "./testing.ts";

type ExampleHome = Awaited<ReturnType<typeof exampleHome>>;

import { VERSION } from "./version.ts";

const repoRoot = join(import.meta.dir, "../../..");

const ajv = new Ajv2020({ strict: false, allErrors: true });

/** Runs every example of `registry` with --json and checks the result three ways: the stream rule (parseJsonLines),
 * the declared Zod schema, and the JSON Schemas published in plainport.json and schemas/. With `sandboxed`, each
 * example runs in a fresh example home (exampleHome); otherwise against the fake ports. */
const roundTrip = (label: string, registry: Registry, sandboxed = false) => {
  const manifest = JSON.parse(generateFiles(registry).get("plainport.json") ?? "");
  const checkEnvelope = ajv.compile(contractJsonSchemas().envelope);
  for (const command of registry) {
    if (command.examples.length === 0) continue;
    test(`${label} ${command.name}: every example validates against its declared and its published schema`, async () => {
      expect(RISK_CLASSES).toContain(command.risk);
      const published = manifest.commands.find((c: { name: string }) => c.name === command.name);
      for (const example of command.examples) {
        const dry = example.argv.includes("--dry-run");
        const home = sandboxed ? await exampleHome() : undefined;
        let run: Awaited<ReturnType<typeof capture>>;
        try {
          run = await capture([...example.argv, "--json"], registry, home && { ports: home.ports });
        } finally {
          home?.cleanup();
        }
        expect({ argv: example.argv, code: run.code, out: run.code === 0 ? "" : run.out }).toEqual({
          argv: example.argv,
          code: 0,
          out: "",
        });
        const schema = dry && command.dryRun !== false ? command.dryRun.plan : command.output;
        const parsed = parseJsonLines(run.out, schema);
        if (!parsed.ok) throw new Error(`${example.argv.join(" ")}: ${parsed.finding.message}`);
        expect(parsed.value.envelope).toMatchObject({ ok: true, verb: command.name });
        const envelope = JSON.parse(run.out.trimEnd().split("\n").at(-1) ?? "");
        expect(checkEnvelope(envelope) ? [] : checkEnvelope.errors).toEqual([]);
        const checkData = ajv.compile(dry ? published.plan : published.output);
        expect(checkData(envelope.data) ? [] : checkData.errors).toEqual([]);
      }
    });
  }
};

describe("contract round trip: every command's --json output matches its declared and published schemas", () => {
  test("every registered command has an example", () => {
    for (const command of REGISTRY) expect(command.examples.length).toBeGreaterThan(0);
  });
  roundTrip("registry", REGISTRY, true);
  // help's examples name version, which the fake registry does not have; the real registry covers help.
  roundTrip(
    "fake",
    FAKE_REGISTRY.filter((c) => c.name !== "help"),
  );
});

/** One way to make a command fail: what it is run with, the exit code and finding code it must end with, and whether
 * the envelope carries data (D14). `setup` prepares the example home and may return ports to run with and the
 * arguments, when they depend on what it made (a plan id). */
interface FailureCase {
  argv: string[];
  exit: FailureExitCode;
  code: string;
  data: boolean;
  setup?: (home: ExampleHome) => Promise<{ ports?: Partial<Ports>; argv?: string[] } | undefined>;
}

const pathsOf = (home: ExampleHome) => {
  const paths = resolvePaths(home.ports.env, { cwd: home.home });
  if (!paths.ok) throw new Error(paths.finding.message);
  return paths.value;
};

/** Offloads work:clients/acme/web with a crash planned at `step` (an in-process fault: the run throws). */
const crashOffloadAt = async (home: ExampleHome, step: string): Promise<void> => {
  const run = await capture(["offload", "work:clients/acme/web", "--yes"], REGISTRY, {
    ports: { ...home.ports, system: testHost({ faults: { at: step } }) },
  });
  if (run.code !== 1) throw new Error(`the crash at ${step} did not happen: exit ${run.code}, ${run.err}`);
};

const keepLocalFor = (home: ExampleHome, value: string): void =>
  writeFileSync(pathsOf(home).configFile, `version = 1\n[offload]\nkeepLocalFor = "${value}"\n`);

/** Every registered command's failures, at least one each, run through the same checks as the examples. */
const FAILURES: Record<string, FailureCase[]> = {
  help: [{ argv: ["help", "nosuch"], exit: 4, code: "command.unknown", data: false }],
  init: [{ argv: ["init", "--nosuch"], exit: 2, code: "usage.invalid", data: false }],
  ls: [
    { argv: ["ls", "--dry-run"], exit: 2, code: "usage.dry-run-unsupported", data: false },
    {
      argv: ["ls"],
      exit: 6,
      code: "config.invalid",
      data: false,
      setup: async (home) => {
        writeFileSync(pathsOf(home).configFile, "version = [\n");
        return undefined;
      },
    },
  ],
  status: [
    { argv: ["status", "work:nosuch"], exit: 4, code: "project.not-found", data: false },
    { argv: ["status", "work:clients/acme/web"], exit: 4, code: "project.unregistered", data: false },
  ],
  offload: [
    { argv: ["offload", "work:clients/acme/web"], exit: 3, code: "risk.needs-yes", data: false },
    {
      argv: ["offload", "work:clients/acme/web", "--dry-run"],
      exit: 6,
      code: "git.locked",
      data: true,
      setup: async (home) => {
        writeFileSync(join(home.home, "work/clients/acme/web/.git/index.lock"), "");
        return undefined;
      },
    },
    { argv: ["offload", "work:nosuch", "--yes"], exit: 4, code: "project.not-found", data: false },
    {
      // A real run's data is the fresh plan (D14): the union branch a dry run never reaches.
      argv: ["offload", "work:clients/acme/web", "--plan", "<id>"],
      exit: 6,
      code: "plan.stale",
      data: true,
      setup: async (home) => {
        const dry = await capture(["offload", "work:clients/acme/web", "--dry-run", "--json"], REGISTRY, {
          ports: home.ports,
        });
        const id: string = JSON.parse(dry.out.trimEnd().split("\n").at(-1) ?? "").data.id;
        writeFileSync(join(home.home, "work/clients/acme/web/changed.txt"), "since the plan\n");
        return {
          ports: { plans: { approved: () => true } },
          argv: ["offload", "work:clients/acme/web", "--plan", id],
        };
      },
    },
    {
      // Committed, then changed before the rename: exit 8 with offload's conflict data (D51, D52).
      argv: ["offload", "work:clients/acme/web", "--yes"],
      exit: 8,
      code: "offload.diverged-after-commit",
      data: true,
      setup: async (home) => {
        const web = join(home.home, "work/clients/acme/web");
        writeFileSync(join(web, "main.ts"), "export const main = 1;\n");
        return {
          ports: {
            system: testHost({
              faults: {
                onStep: (step) => {
                  if (step === "offload.committed")
                    writeFileSync(join(web, "main.ts"), "export const main = 2;\n");
                },
              },
            }),
          },
        };
      },
    },
  ],
  onload: [
    { argv: ["onload", "work:nosuch"], exit: 4, code: "project.not-found", data: false },
    {
      argv: ["onload", "work:clients/acme/api", "--to", "~/personal"],
      exit: 6,
      code: "path.occupied",
      data: false,
    },
    {
      // Restored, but the install fails: exit 10 with onload's output as data (D14).
      argv: ["onload", "work:clients/acme/app"],
      exit: 10,
      code: "hydrate.failed",
      data: true,
      setup: async (home) => {
        const app = join(home.home, "work/clients/acme/app");
        mkdirSync(join(app, "node_modules/left-pad"), { recursive: true });
        writeFileSync(join(app, "package.json"), `${JSON.stringify({ name: "app", version: "1.0.0" })}\n`);
        writeFileSync(
          join(app, "package-lock.json"),
          `${JSON.stringify({ name: "app", version: "1.0.0", lockfileVersion: 3, packages: {} })}\n`,
        );
        writeFileSync(join(app, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
        const offloaded = await capture(["offload", "work:clients/acme/app", "--yes"], REGISTRY, {
          ports: home.ports,
        });
        if (offloaded.code !== 0) throw new Error(offloaded.err);
        // An npm that always fails, first on PATH.
        const bin = join(home.home, "bin");
        mkdirSync(bin);
        writeFileSync(join(bin, "npm"), "#!/bin/sh\necho 'npm: no network' >&2\nexit 1\n", { mode: 0o755 });
        return { ports: { env: { ...home.ports.env, PATH: `${bin}:${home.ports.env.PATH}` } } };
      },
    },
  ],
  hydrate: [{ argv: ["hydrate", "work:nosuch"], exit: 4, code: "project.not-found", data: false }],
  dehydrate: [{ argv: ["dehydrate", "work:nosuch"], exit: 4, code: "project.not-found", data: false }],
  restore: [
    {
      argv: ["restore", "work:clients/acme/api", "--to", "~/personal"],
      exit: 6,
      code: "path.occupied",
      data: false,
    },
    {
      argv: ["restore", "work:clients/acme/api", "--snapshot", "nosuch", "--to", "~/copy"],
      exit: 4,
      code: "snapshot.not-found",
      data: false,
    },
  ],
  recover: [
    {
      argv: ["recover"],
      exit: 8,
      code: "offload.diverged-after-commit",
      data: true,
      setup: async (home) => {
        await crashOffloadAt(home, "offload.committed");
        writeFileSync(join(home.home, "work/clients/acme/web/edited.txt"), "after the crash\n");
        return undefined;
      },
    },
    {
      // C1: the SSD is unplugged; the report still arrives as data.
      argv: ["recover"],
      exit: 9,
      code: "store.unreachable",
      data: true,
      setup: async (home) => {
        await crashOffloadAt(home, "offload.commit.appended");
        renameSync(join(home.home, "store"), join(home.home, "store-unplugged"));
        return undefined;
      },
    },
    {
      // C1: another process holds the project's lock.
      argv: ["recover"],
      exit: 11,
      code: "project.locked",
      data: true,
      setup: async (home) => {
        await crashOffloadAt(home, "offload.committed");
        const paths = pathsOf(home);
        for (const name of readdirSync(paths.journalDir)) {
          const journal = JSON.parse(readFileSync(join(paths.journalDir, name), "utf8"));
          const held = await acquireLock(testHost(), join(paths.locksDir, `${journal.project.id}.lock`), {
            timeoutMs: 0,
            held: () => finding("project.locked", { message: "held" }),
          });
          if (!held.ok) throw new Error(held.finding.message);
        }
        return undefined;
      },
    },
    {
      // C1: Ctrl-C before recover settled anything.
      argv: ["recover"],
      exit: 130,
      code: "operation.cancelled",
      data: true,
      setup: async (home) => {
        await crashOffloadAt(home, "offload.committed");
        const controller = new AbortController();
        controller.abort();
        return { ports: { cancellation: { signal: controller.signal, hold: () => () => {} } } };
      },
    },
    {
      argv: ["recover"],
      exit: 6,
      code: "journal.pending",
      data: true,
      setup: async (home) => {
        const paths = pathsOf(home);
        mkdirSync(paths.journalDir, { recursive: true });
        writeFileSync(join(paths.journalDir, "01J9Z6K2ZZZZZZZZZZZZZZZZZZ.json"), "{not json");
        return undefined;
      },
    },
  ],
  gc: [
    { argv: ["gc", "--now"], exit: 3, code: "risk.needs-yes", data: false },
    {
      // C1: a kept trash that cannot be deleted (its holder is read-only).
      argv: ["gc", "--now", "--yes"],
      exit: 1,
      code: "fs.write-failed",
      data: true,
      setup: async (home) => {
        keepLocalFor(home, "1h");
        const offloaded = await capture(["offload", "work:clients/acme/web", "--yes"], REGISTRY, {
          ports: home.ports,
        });
        if (offloaded.code !== 0) throw new Error(offloaded.err);
        const holder = join(home.home, "work/.plainport-trash");
        chmodSync(holder, 0o500);
        readOnly.push(holder);
        return undefined;
      },
    },
  ],
  "root add": [{ argv: ["root", "add", "work", "~/personal"], exit: 6, code: "root.exists", data: false }],
  "root bind": [
    { argv: ["root", "bind", "nosuch", "~/personal"], exit: 4, code: "root.not-found", data: false },
  ],
  "root list": [
    { argv: ["root", "list", "--dry-run"], exit: 2, code: "usage.dry-run-unsupported", data: false },
  ],
  "root scan": [{ argv: ["root", "scan", "nosuch"], exit: 4, code: "root.not-found", data: false }],
  version: [{ argv: ["version", "extra"], exit: 2, code: "usage.invalid", data: false }],
};

/** Folders a setup made read-only, made writable again after the test so its home can be removed. */
const readOnly: string[] = [];
const unlock = (): void => {
  for (const dir of readOnly.splice(0)) if (existsSync(dir)) chmodSync(dir, 0o755);
};

/**
 * Checks a failed --json run the way roundTrip checks a success: the stream rule (parseJsonLines with the command's
 * declared schema), the published envelope schema, the published output or plan schema for any data, the exit code
 * equal to error.code, and the finding's severity and allowable as its catalogue entry says.
 */
const checkFailure = (
  command: AnyCommand | undefined,
  argv: readonly string[],
  run: Captured,
  expected: { exit: number; code: string; data: boolean },
): void => {
  const manifest = JSON.parse(generateFiles(REGISTRY).get("plainport.json") ?? "");
  const checkEnvelope = ajv.compile(contractJsonSchemas().envelope);
  const dry = argv.includes("--dry-run");
  const schema =
    command === undefined
      ? undefined
      : dry && command.dryRun !== false
        ? command.dryRun.plan
        : command.output;
  const parsed = parseJsonLines(run.out, schema);
  if (!parsed.ok)
    throw new Error(`${argv.join(" ")}: ${parsed.finding.message}\nstdout: ${run.out}\nstderr: ${run.err}`);
  const envelope = JSON.parse(run.out.trimEnd().split("\n").at(-1) ?? "");
  expect(checkEnvelope(envelope) ? [] : checkEnvelope.errors).toEqual([]);
  expect({
    argv,
    exit: run.code,
    ok: envelope.ok,
    errorCode: envelope.error?.code,
    finding: envelope.error?.finding?.code,
    data: envelope.data !== undefined,
  }).toEqual({
    argv,
    exit: expected.exit,
    ok: false,
    errorCode: expected.exit,
    finding: expected.code,
    data: expected.data,
  });
  const spec = FINDINGS[expected.code as keyof typeof FINDINGS];
  expect({ severity: envelope.error.finding.severity, allowable: envelope.error.finding.allowable }).toEqual({
    severity: spec.severity,
    allowable: spec.allowable,
  });
  if (envelope.data !== undefined && command !== undefined) {
    const published = manifest.commands.find((c: { name: string }) => c.name === command.name);
    const checkData = ajv.compile(dry ? published.plan : published.output);
    expect(checkData(envelope.data) ? [] : checkData.errors).toEqual([]);
  }
};

describe("contract round trip: every command's --json failures match the published envelope (I10, C1)", () => {
  test("every registered command has at least one failure case", () => {
    expect(REGISTRY.map((c) => c.name).filter((name) => (FAILURES[name] ?? []).length === 0)).toEqual([]);
  });
  for (const command of REGISTRY) {
    for (const failure of FAILURES[command.name] ?? []) {
      test(`${command.name}: ${failure.argv.join(" ")} --json exits ${failure.exit} (${failure.code}) with a valid envelope`, async () => {
        const home = await exampleHome();
        try {
          const prepared = await failure.setup?.(home);
          const ports = { ...home.ports, ...prepared?.ports };
          const argv = prepared?.argv ?? failure.argv;
          const run = await capture([...argv, "--json"], REGISTRY, { ports });
          checkFailure(command, argv, run, failure);
          // Human mode exits the same.
          if (failure.setup === undefined)
            expect((await capture(failure.argv, REGISTRY, { ports })).code).toBe(failure.exit);
        } finally {
          unlock();
          home.cleanup();
        }
      }, 30_000);
    }
  }

  test("an unknown command and a handler's bug end in a valid failure envelope", async () => {
    checkFailure(undefined, ["nosuch"], await capture(["nosuch", "--json"], REGISTRY), {
      exit: 4,
      code: "command.unknown",
      data: false,
    });
    const boom = FAKE_REGISTRY.find((c) => c.name === "boom");
    const run = await capture(["boom", "--json"]);
    checkFailure(boom, ["boom"], run, { exit: 1, code: "internal.unexpected", data: false });
  });
});

/** The non-test TypeScript sources under packages/, comment lines left out. */
const sources = (): { file: string; text: string }[] => {
  const out: { file: string; text: string }[] = [];
  const packages = join(repoRoot, "packages");
  for (const pkg of readdirSync(packages)) {
    const src = join(packages, pkg, "src");
    if (!existsSync(src)) continue;
    for (const entry of readdirSync(src, { withFileTypes: true, recursive: true })) {
      const file = join(entry.parentPath, entry.name);
      if (!entry.isFile() || !file.endsWith(".ts") || file.endsWith(".test.ts") || file.includes("/testing"))
        continue;
      const text = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join("\n");
      out.push({ file: file.slice(repoRoot.length + 1), text });
    }
  }
  return out;
};

describe("what plainport tells people to run exists (I1)", () => {
  test("no fix, next step or catalogue summary names a command DESIGN plans but this build does not have", () => {
    const registered = new Set(REGISTRY.map((c) => c.name.split(" ")[0] as string));
    const groupWords = new Set(REGISTRY.filter((c) => c.name.includes(" ")).map((c) => c.name.split(" ")[0]));
    // Every command DESIGN.md names in code: those this build lacks must not be offered as a step to take.
    const design = readFileSync(join(repoRoot, "docs/DESIGN.md"), "utf8");
    const planned = new Set(
      [...design.matchAll(/`plainport ([a-z][a-z-]*)/g)]
        .map((m) => m[1] as string)
        .filter((word) => !registered.has(word)),
    );
    expect(planned.has("doctor") && planned.has("resolve")).toBe(true);
    const named: string[] = [];
    for (const { file, text } of sources()) {
      for (const m of text.matchAll(/\bplainport ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?/g)) {
        const [, first = "", second] = m;
        if (planned.has(first)) named.push(`${file}: plainport ${first}`);
        else if (
          groupWords.has(first) &&
          second !== undefined &&
          !REGISTRY.some((c) => c.name === `${first} ${second}`)
        )
          named.push(`${file}: plainport ${first} ${second}`);
      }
    }
    expect(named).toEqual([]);
  });
});

describe("version and help", () => {
  test("plainport version and --version print the baked-in version", async () => {
    expect((await capture(["version"], REGISTRY)).out).toBe(`plainport ${VERSION}\n`);
    expect((await capture(["--version"], REGISTRY)).out).toBe(`plainport ${VERSION}\n`);
    const json = await capture(["--version", "--json"], REGISTRY);
    expect(JSON.parse(json.out)).toEqual({
      plainport_json: 1,
      ok: true,
      verb: "version",
      data: { version: VERSION },
    });
  });

  test("bare plainport, --help and help print the command list and exit 0", async () => {
    const help = await capture(["help"], REGISTRY);
    expect(help.code).toBe(0);
    expect(help.out).toContain("Usage: plainport <command> [options]");
    expect(help.out).toContain("  version");
    expect(help.out).toContain("--dry-run");
    expect((await capture([], REGISTRY)).out).toBe(help.out);
    expect((await capture(["--help"], REGISTRY)).out).toBe(help.out);
  });

  test("help is a short overview: commands grouped with their risk class, and where the machine contract is (agent smoke)", async () => {
    const help = await capture(["help"], REGISTRY);
    expect(help.out.length).toBeLessThan(4096);
    for (const heading of ["Projects:", "Recovery and cleanup:", "Roots:", "Setup and info:"])
      expect(help.out).toContain(`\n${heading}\n`);
    // Every command is listed once, under one group.
    for (const c of REGISTRY) expect(help.out.split(`\n  ${c.name.padEnd(9)}  ${c.risk}`)).toHaveLength(2);
    expect(help.out).toContain("plainport help <command>");
    expect(help.out).toContain("plainport help --json");
    expect(help.out).toContain("plainport.json");
  });

  test("help's summaries: offload names the kept copy, and ls, root list and root scan say offload needs no registering (agent smoke)", async () => {
    const help = await capture(["help"], REGISTRY);
    expect(help.out).not.toContain("free its folder");
    expect(help.out).toMatch(
      /offload +confirm +Snapshot a project, verify it, then remove its folder: deleted at once, or kept for keepLocalFor until gc frees it\n/,
    );
    expect(help.out).toMatch(
      /root scan +safe_write +List and register the project folders under a root; offload takes an unregistered one as it is\n/,
    );
    const manifest = JSON.parse(generateFiles(REGISTRY).get("plainport.json") ?? "");
    const rootList = manifest.commands.find((c: { name: string }) => c.name === "root list");
    expect(JSON.stringify(rootList.output)).toContain("offload also takes an unregistered project folder");
  });

  test("help onload says when it reuses the kept copy, how to restore from the store, and how --snapshot, --to and --no-hydrate interact (agent smoke)", async () => {
    const help = (await capture(["help", "onload"], REGISTRY)).out;
    expect(help).toMatch(
      /--to <value> +Land it in this folder instead of its root's place; always restored from the store\n/,
    );
    expect(help).toMatch(
      /--snapshot <value> +Restore this snapshot from the store instead of the head; naming the head itself still reuses a kept local copy\n/,
    );
    expect(help).toContain("a reused kept copy has its dependencies either way\n");
    expect(help).toContain(
      "plainport gc --now --yes deletes the kept copy first, so onload restores from the store; plainport restore --to <path> checks the stored snapshot side by side",
    );
  });

  test("help onload says the install usually needs the network, what a failed install leaves, and that --no-hydrate keeps the tree as stored (C3)", async () => {
    const help = (await capture(["help", "onload"], REGISTRY)).out;
    expect(help).toMatch(
      /--no-hydrate +Restore the files without installing dependencies: the restored tree stays exactly as stored, and no network is needed; a reused kept copy has its dependencies either way\n/,
    );
    expect(help).toContain(
      "the install (e.g. npm ci) usually needs the network; if it fails the files stay restored, the project is restored-unhydrated, onload exits 10 (hydrate.failed) and plainport hydrate <project> retries",
    );
  });

  test("the footer names exactly the commands whose registry entry accepts a plan (quality r1 minor 6)", async () => {
    const fake = await capture(["help"], FAKE_REGISTRY);
    expect(fake.out.replaceAll("\n", " ")).toContain(
      "ship also takes --plan <id> from its --dry-run instead.",
    );
    expect(fake.out).not.toMatch(/(show|write|root add|stream|boom|fragile) also takes --plan/);
    for (const c of REGISTRY) {
      const info = JSON.parse((await capture(["help", ...c.name.split(" "), "--json"], REGISTRY)).out).data
        .commands[0];
      expect(info.acceptsPlan).toBe(c.acceptsPlan);
    }
  });

  test("help groups come from each registry entry's group, and the real registry leaves no command under Other (quality r1 minor 7)", async () => {
    const help = await capture(["help"], REGISTRY);
    expect(help.out).not.toContain("\nOther:\n");
    const fake = await capture(["help"], FAKE_REGISTRY);
    expect(fake.out).toMatch(/\nRoots:\n {2}root add /);
    for (const c of REGISTRY) {
      const info = JSON.parse((await capture(["help", ...c.name.split(" "), "--json"], REGISTRY)).out).data
        .commands[0];
      expect(["projects", "recovery", "roots", "setup"]).toContain(c.group);
      expect(info.group).toBe(c.group);
    }
  });

  test("help says that --plan <id> stands in for --yes, in the listing, the global option and the command (agent smoke)", async () => {
    const help = await capture(["help"], REGISTRY);
    expect(help.out.replaceAll("\n", " ")).toContain(
      "read and safe_write commands run freely; confirm commands need --yes. offload also takes --plan <id> from its --dry-run instead.",
    );
    expect(help.out).toMatch(/--yes +Allow a confirm-class command to run; --plan <id> stands in for it/);
    const offload = await capture(["help", "offload"], REGISTRY);
    expect(offload.out).toContain("Risk: confirm (needs --yes, or --plan <id> from a --dry-run)");
    expect(offload.out).toMatch(
      /--plan <value> +Run the plan a --dry-run saved, by its id, instead of --yes/,
    );
    expect(offload.out).toMatch(
      /plainport offload work:clients\/acme\/web --dry-run +Plan offloading a project; --plan <id> then runs that plan, instead of --yes/,
    );
    const manifest = JSON.parse(generateFiles(REGISTRY).get("plainport.json") ?? "");
    expect(manifest.globalOptions.find((o: { name: string }) => o.name === "yes").summary).toContain(
      "--plan <id> stands in for it",
    );
  });

  test("help <command> and <command> --help show the command, its risk class and dry-run support", async () => {
    const one = await capture(["help", "version"], REGISTRY);
    expect(one.code).toBe(0);
    expect(one.out).toContain("Usage: plainport version");
    expect(one.out).toContain("Risk: read");
    expect((await capture(["version", "--help"], REGISTRY)).out).toBe(one.out);
  });

  test("help --json returns the registry entries", async () => {
    const run = await capture(["help", "help", "--json"], REGISTRY);
    const envelope = JSON.parse(run.out);
    expect(envelope.data.commands).toHaveLength(1);
    expect(envelope.data.commands[0]).toMatchObject({ name: "help", risk: "read", dryRun: false });
  });
});

describe("generated contract files", () => {
  test("generation is deterministic", () => {
    expect(generateFiles(REGISTRY)).toEqual(generateFiles(REGISTRY));
  });

  test("plainport.json describes every command's arguments, output, risk class and dry-run support", () => {
    const manifest = JSON.parse(generateFiles(REGISTRY).get("plainport.json") ?? "");
    expect(manifest.schema).toBe("plainport.json/1");
    expect(manifest.plainport_json).toBe(1);
    for (const option of manifest.globalOptions)
      expect(Object.keys(option)).toEqual(["name", "type", "summary"]);
    expect(manifest.globalOptions.map((o: { name: string }) => o.name)).toEqual([
      "json",
      "yes",
      "no-input",
      "dry-run",
      "store",
      "config",
      "quiet",
      "verbose",
    ]);
    for (const command of manifest.commands) {
      expect(Object.keys(command)).toEqual([
        "name",
        "summary",
        "usage",
        "risk",
        "dryRun",
        "acceptsPlan",
        "group",
        "positionals",
        "options",
        "arguments",
        "output",
        "plan",
        "examples",
      ]);
      expect(command.arguments.additionalProperties).toBe(false);
      expect(command.plan === null).toBe(command.dryRun === false);
    }
    const fake = JSON.parse(generateFiles(FAKE_REGISTRY).get("plainport.json") ?? "");
    const ship = fake.commands.find((c: { name: string }) => c.name === "ship");
    expect(ship.dryRun).toBe(true);
    expect(ship.plan.properties.plan.type).toBe("string");
    expect(ship.options).toEqual([
      { name: "plan", type: "string", multiple: false, summary: "An approved plan id" },
      { name: "allow", type: "string", multiple: true, summary: "Allow a finding" },
      { name: "lie", type: "boolean", multiple: false, summary: "Return the other mode's shape" },
    ]);
  });

  test("schemas/ holds every contract schema", () => {
    const files = [...generateFiles(REGISTRY).keys()];
    for (const name of Object.keys(contractJsonSchemas())) expect(files).toContain(`schemas/${name}.json`);
  });

  test("the committed plainport.json, schemas/ and completions/ are fresh (run bun run contract)", () => {
    expect(staleFiles(repoRoot, REGISTRY)).toEqual([]);
  });

  test("staleFiles reports changed, missing and unexpected files", () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-contract-"));
    try {
      const files = generateFiles(REGISTRY);
      expect(staleFiles(root, REGISTRY).sort()).toEqual([...files.keys()].sort());
      for (const [path, text] of files) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      expect(staleFiles(root, REGISTRY)).toEqual([]);
      writeFileSync(join(root, "plainport.json"), "{}\n");
      writeFileSync(join(root, "schemas/old.json"), "{}\n");
      expect(staleFiles(root, REGISTRY).sort()).toEqual(["plainport.json", "schemas/old.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("writeFiles", () => {
  test("writes every generated file, rewrites stale ones and deletes extras only inside the generated folders", () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-write-"));
    try {
      const files = generateFiles(REGISTRY);
      expect(writeFiles(root, REGISTRY).sort()).toEqual([...files.keys()].sort());
      expect(writeFiles(root, REGISTRY)).toEqual([]);
      writeFileSync(join(root, "plainport.json"), "{}\n");
      writeFileSync(join(root, "schemas/old.json"), "{}\n");
      writeFileSync(join(root, "completions/old.fish"), "\n");
      mkdirSync(join(root, "other"));
      writeFileSync(join(root, "other/keep.json"), "{}\n");
      writeFileSync(join(root, "keep.json"), "{}\n");
      expect(writeFiles(root, REGISTRY).sort()).toEqual([
        "completions/old.fish",
        "plainport.json",
        "schemas/old.json",
      ]);
      expect(staleFiles(root, REGISTRY)).toEqual([]);
      expect(existsSync(join(root, "schemas/old.json"))).toBe(false);
      expect(existsSync(join(root, "completions/old.fish"))).toBe(false);
      expect(readFileSync(join(root, "plainport.json"), "utf8")).toBe(files.get("plainport.json") ?? "");
      expect(existsSync(join(root, "other/keep.json"))).toBe(true);
      expect(existsSync(join(root, "keep.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("completions", () => {
  const files = generateFiles(REGISTRY);

  test("zsh completion is registered for plainport and names every command and global option", () => {
    const zsh = files.get("completions/_plainport") ?? "";
    expect(zsh.startsWith("#compdef plainport\n")).toBe(true);
    for (const command of REGISTRY) expect(zsh).toContain(command.name);
    expect(zsh).toContain("--dry-run");
  });

  const shellSkip = (shell: string) => Bun.which(shell) === null && process.env.CI === undefined;

  test.skipIf(shellSkip("zsh"))(
    "the zsh completion parses, for the real registry and one with a command group",
    () => {
      const root = mkdtempSync(join(tmpdir(), "plainport-zsh-"));
      try {
        for (const [name, registry] of [
          ["real", REGISTRY],
          ["fake", FAKE_REGISTRY],
        ] as const) {
          const script = join(root, `_${name}`);
          writeFileSync(script, generateFiles(registry).get("completions/_plainport") ?? "");
          const run = Bun.spawnSync(["zsh", "-f", "-n", script], { stdout: "pipe", stderr: "pipe" });
          expect(run.stderr.toString()).toBe("");
          expect(run.exitCode).toBe(0);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(shellSkip("zsh"))("zsh completion finds the command after a global option's value (N7)", () => {
    const root = mkdtempSync(join(tmpdir(), "plainport-zsh-"));
    try {
      const script = join(root, "_plainport");
      writeFileSync(
        script,
        (generateFiles(REGISTRY).get("completions/_plainport") ?? "").replace(/_plainport "\$@"\n$/, ""),
      );
      const complete = (line: string) => {
        const words = line.split(" ");
        const probe = [
          // Stand-ins for the completion system: print what would be offered.
          "compadd() { [[ $1 == -- ]] && shift; print -l -- $@ }",
          "_describe() { local name=$4; print -l -- ${${(P)name}%%:*} }",
          "_files() { print FILES }",
          `source ${script}`,
          `words=(${words.map((w) => `'${w}'`).join(" ")})`,
          `CURRENT=${words.length}`,
          "_plainport",
        ].join("\n");
        const run = Bun.spawnSync(["zsh", "-f", "-c", probe], { stdout: "pipe", stderr: "pipe" });
        expect(run.stderr.toString()).toBe("");
        return run.stdout.toString().split("\n").filter(Boolean);
      };
      expect(complete("plainport --store mini gc --no")).toContain("--now");
      expect(complete("plainport --store mini gc ")).toEqual(["FILES"]);
      expect(complete("plainport --config ~/c.toml he")).toContain("help");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(shellSkip("bash"))(
    "bash completion completes commands, command groups, help's argument and options",
    () => {
      const root = mkdtempSync(join(tmpdir(), "plainport-bash-"));
      try {
        const complete = (registry: typeof REGISTRY, line: string) => {
          const script = join(root, "plainport.bash");
          writeFileSync(script, generateFiles(registry).get("completions/plainport.bash") ?? "");
          const words = line.split(" ");
          const probe = [
            `source ${script}`,
            `COMP_WORDS=(${words.map((w) => `'${w}'`).join(" ")})`,
            `COMP_CWORD=${words.length - 1}`,
            "_plainport",
            'printf "%s\\n" "${COMPREPLY[@]}"',
          ].join("\n");
          const run = Bun.spawnSync(["bash", "--noprofile", "--norc", "-c", probe], {
            stdout: "pipe",
            stderr: "pipe",
          });
          expect(run.stderr.toString()).toBe("");
          return run.stdout.toString().split("\n").filter(Boolean);
        };
        expect(complete(REGISTRY, "plainport ")).toEqual([
          "help",
          "init",
          "ls",
          "status",
          "offload",
          "onload",
          "hydrate",
          "dehydrate",
          "restore",
          "recover",
          "gc",
          "root",
          "version",
        ]);
        expect(complete(REGISTRY, "plainport gc --no")).toEqual(["--now", "--no-input"]);
        expect(complete(REGISTRY, "plainport he")).toEqual(["help"]);
        expect(complete(REGISTRY, "plainport help v")).toEqual(["version"]);
        expect(complete(REGISTRY, "plainport version --j")).toEqual(["--json"]);
        expect(complete(REGISTRY, "plainport --vers")).toEqual(["--version"]);
        expect(complete(FAKE_REGISTRY, "plainport root ")).toEqual(["add"]);
        expect(complete(FAKE_REGISTRY, "plainport help root a")).toEqual(["add"]);
        expect(complete(FAKE_REGISTRY, "plainport write web --ad")).toEqual(["--adopt"]);
        // N7: the value of a global option that takes one is not the command.
        expect(complete(REGISTRY, "plainport --store mini gc --no")).toEqual(["--now", "--no-input"]);
        expect(complete(REGISTRY, "plainport --config ~/c.toml --store mini he")).toEqual(["help"]);
        expect(complete(REGISTRY, "plainport --store=mini gc --no")).toEqual(["--now", "--no-input"]);
        expect(complete(FAKE_REGISTRY, "plainport --store mini root ")).toEqual(["add"]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
