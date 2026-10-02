import { describe, expect, test } from "bun:test";
import { FindingSchema, type GateRequest, gate, RISK_CLASSES, refuseDryRun, rerunWithYes } from "./index.ts";

const req = (over: Partial<GateRequest> = {}): GateRequest => ({
  command: "offload",
  argv: ["offload", "web"],
  risk: "confirm",
  yes: false,
  plan: false,
  dryRun: false,
  ...over,
});

describe("risk gate (D15)", () => {
  test("read and safe_write run freely", () => {
    expect(gate(req({ risk: "read" }))).toEqual({ verdict: "allow", riskClass: "read" });
    expect(gate(req({ risk: "safe_write" }))).toEqual({ verdict: "allow", riskClass: "safe_write" });
  });

  test("confirm without --yes is refused with exit 3 and the exact re-run", () => {
    const verdict = gate(req());
    expect(verdict).toEqual({
      verdict: "confirm",
      riskClass: "confirm",
      exitCode: 3,
      rerun: "plainport offload web --yes",
      hint: "re-run: plainport offload web --yes",
      finding: {
        code: "risk.needs-yes",
        severity: "block",
        message: "offload is confirm-class: it sends data off this machine or deletes it, so it needs --yes",
        fix: "plainport offload web --yes",
        allowable: false,
      },
    });
    if (verdict.verdict === "confirm") expect(FindingSchema.parse(verdict.finding)).toEqual(verdict.finding);
  });

  test("confirm with --yes, or with an approved --plan, is allowed", () => {
    expect(gate(req({ yes: true }))).toEqual({ verdict: "allow", riskClass: "confirm" });
    expect(gate(req({ plan: true }))).toEqual({ verdict: "allow", riskClass: "confirm" });
  });

  test("a command that declares no risk class is confirm", () => {
    expect(gate(req({ risk: undefined })).verdict).toBe("confirm");
    expect(gate(req({ risk: undefined, yes: true }))).toEqual({ verdict: "allow", riskClass: "confirm" });
  });

  test("D18: --dry-run is always read", () => {
    for (const risk of [...RISK_CLASSES, undefined]) {
      expect(gate(req({ risk, dryRun: true }))).toEqual({ verdict: "allow", riskClass: "read" });
    }
  });

  test("D18: a command without dry-run support refuses --dry-run as a usage error before it runs", () => {
    const refusal = refuseDryRun({
      command: "gc",
      argv: ["gc", "--dry-run", "--now"],
      supportsDryRun: false,
      dryRun: true,
    });
    expect(refusal).toEqual({
      ok: false,
      exitCode: 2,
      finding: {
        code: "usage.dry-run-unsupported",
        severity: "block",
        message: "gc has no --dry-run preview",
        fix: "plainport gc --now",
        allowable: false,
      },
    });
    if (refusal.ok === false) expect(FindingSchema.parse(refusal.finding)).toEqual(refusal.finding);
    expect(
      refuseDryRun({ command: "gc", argv: ["gc", "--now"], supportsDryRun: false, dryRun: false }),
    ).toEqual({
      ok: true,
      value: null,
    });
    expect(
      refuseDryRun({
        command: "offload",
        argv: ["offload", "web", "--dry-run"],
        supportsDryRun: true,
        dryRun: true,
      }),
    ).toEqual({
      ok: true,
      value: null,
    });
  });

  test("the re-run is shell-exact: odd arguments are quoted and --yes goes before --", () => {
    expect(rerunWithYes(["offload", "my project", "it's", ""])).toBe(
      "plainport offload 'my project' 'it'\\''s' '' --yes",
    );
    expect(rerunWithYes(["offload", "work:clients/acme/web", "--store", "mini-work"])).toBe(
      "plainport offload work:clients/acme/web --store mini-work --yes",
    );
    expect(rerunWithYes(["offload", "--", "--odd-name"])).toBe("plainport offload --yes -- --odd-name");
    expect(rerunWithYes(["offload", "$HOME", "a;b"])).toBe("plainport offload '$HOME' 'a;b' --yes");
  });

  test("the gate is total: every combination returns a verdict without throwing", () => {
    const bools = [false, true];
    for (const risk of [...RISK_CLASSES, undefined])
      for (const yes of bools)
        for (const plan of bools)
          for (const dryRun of bools) {
            const verdict = gate(req({ risk, yes, plan, dryRun }));
            expect(["allow", "confirm"]).toContain(verdict.verdict);
            const refused = (risk ?? "confirm") === "confirm" && !yes && !plan && !dryRun;
            expect(verdict.verdict === "confirm").toBe(refused);
          }
  });
});

// Runs the re-run line in a real shell, with `plainport` defined as a function that prints its arguments, and
// checks the shell hands back exactly the arguments given (plus --yes).
describe("re-run line in real shells", () => {
  const awkward = [
    "offload",
    "=foo",
    "=",
    "%1",
    "~",
    "~root",
    "a b",
    "it's",
    "",
    "$HOME",
    "`id`",
    "$(id)",
    "a;b",
    "*",
    "[a]",
    "{a,b}",
    "#x",
    "!x",
    "^x",
    "a\nb",
    "é",
    "--store=mini-work",
    "work:clients/acme/web",
    "-",
  ];
  const parse = (shell: string, line: string): string[] => {
    const script = `plainport() { for a in "$@"; do printf '%s\\0' "$a"; done; }; ${line}`;
    const args =
      shell === "zsh" ? ["zsh", "-f", "-c", script] : ["bash", "--noprofile", "--norc", "-c", script];
    const run = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`${shell} exited ${run.exitCode}: ${run.stderr.toString()}`);
    return run.stdout.toString().split("\0").slice(0, -1);
  };

  for (const shell of ["zsh", "bash"]) {
    test(`${shell} reads the re-run back as the same arguments`, () => {
      expect(parse(shell, rerunWithYes(awkward))).toEqual([...awkward, "--yes"]);
      expect(parse(shell, rerunWithYes(["offload", "--", "=odd"]))).toEqual([
        "offload",
        "--yes",
        "--",
        "=odd",
      ]);
    });
  }
});
