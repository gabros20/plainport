// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell code, where ${…} is shell syntax.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractJsonSchemas, parseJsonLines, RISK_CLASSES } from "@plainport/contract";
import { REGISTRY } from "./commands/index.ts";
import { generateFiles, staleFiles } from "./generate.ts";
import { capture, FAKE_REGISTRY } from "./testing.ts";
import { VERSION } from "./version.ts";

const repoRoot = join(import.meta.dir, "../../..");

describe("contract round trip: every registered command's --json output matches its declared schema", () => {
  test("M1 task 4 registers exactly help and version", () => {
    expect(REGISTRY.map((c) => c.name)).toEqual(["help", "version"]);
  });

  for (const command of REGISTRY) {
    test(`${command.name}: every example validates against its output schema`, async () => {
      expect(command.examples.length).toBeGreaterThan(0);
      expect(RISK_CLASSES).toContain(command.risk);
      for (const example of command.examples) {
        const run = await capture([...example.argv, "--json"], REGISTRY);
        expect(run.code).toBe(0);
        const parsed = parseJsonLines(run.out, command.output);
        if (!parsed.ok) throw new Error(`${example.argv.join(" ")}: ${parsed.finding.message}`);
        expect(parsed.value.envelope).toMatchObject({ ok: true, verb: command.name });
      }
    });
  }
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
        "examples",
      ]);
      expect(command.arguments.additionalProperties).toBe(false);
    }
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
        expect(complete(REGISTRY, "plainport ")).toEqual(["help", "version"]);
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
