// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell code, where ${…} is shell syntax.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractJsonSchemas, parseJsonLines, RISK_CLASSES } from "@plainport/contract";
import Ajv2020 from "ajv/dist/2020";
import { REGISTRY } from "./commands/index.ts";
import { generateFiles, staleFiles, writeFiles } from "./generate.ts";
import type { Registry } from "./registry.ts";
import { capture, exampleHome, FAKE_REGISTRY } from "./testing.ts";
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
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
