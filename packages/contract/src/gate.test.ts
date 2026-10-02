import { describe, expect, test } from "bun:test";
import * as contract from "./index.ts";
import {
  checkInvocation,
  commandLine,
  FindingSchema,
  type Invocation,
  RISK_CLASSES,
  rerunWithYes,
} from "./index.ts";

const inv = (over: Partial<Invocation> = {}): Invocation => ({
  command: "offload",
  argv: ["offload", "web"],
  risk: "confirm",
  supportsDryRun: true,
  yes: false,
  plan: false,
  dryRun: false,
  ...over,
});

describe("checkInvocation: the one gate the CLI calls (D15, D18)", () => {
  test("read and safe_write run freely", () => {
    expect(checkInvocation(inv({ risk: "read" }))).toEqual({ ok: true, value: { riskClass: "read" } });
    expect(checkInvocation(inv({ risk: "safe_write" }))).toEqual({
      ok: true,
      value: { riskClass: "safe_write" },
    });
  });

  test("confirm without --yes is refused with exit 3, and the finding's fix is the exact re-run", () => {
    const result = checkInvocation(inv());
    expect(result).toEqual({
      ok: false,
      exitCode: 3,
      finding: {
        code: "risk.needs-yes",
        severity: "block",
        message: "offload is confirm-class: it sends data off this machine or deletes it, so it needs --yes",
        fix: "plainport offload web --yes",
        allowable: false,
      },
    });
    if (!result.ok) expect(FindingSchema.parse(result.finding)).toEqual(result.finding);
  });

  test("confirm with --yes, or with an approved --plan, is allowed", () => {
    expect(checkInvocation(inv({ yes: true }))).toEqual({ ok: true, value: { riskClass: "confirm" } });
    expect(checkInvocation(inv({ plan: true }))).toEqual({ ok: true, value: { riskClass: "confirm" } });
  });

  test("a command that declares no risk class is confirm", () => {
    expect(checkInvocation(inv({ risk: undefined })).ok).toBe(false);
    expect(checkInvocation(inv({ risk: undefined, yes: true }))).toEqual({
      ok: true,
      value: { riskClass: "confirm" },
    });
  });

  test("D18: --dry-run on a command that supports it is always read", () => {
    for (const risk of [...RISK_CLASSES, undefined]) {
      expect(checkInvocation(inv({ risk, dryRun: true }))).toEqual({
        ok: true,
        value: { riskClass: "read" },
      });
    }
  });

  test("D18: --dry-run on a command without a preview is a usage error, whatever else is given", () => {
    for (const risk of [...RISK_CLASSES, undefined])
      for (const yes of [false, true]) {
        const result = checkInvocation(inv({ risk, yes, supportsDryRun: false, dryRun: true }));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.exitCode).toBe(2);
          expect(result.finding.code).toBe("usage.dry-run-unsupported");
          expect(FindingSchema.parse(result.finding)).toEqual(result.finding);
        }
      }
  });

  test("the dry-run refusal never invites running the command blind", () => {
    const at = (risk: "read" | "safe_write" | "confirm") => {
      const result = checkInvocation(
        inv({ command: "gc", argv: ["gc", "--dry-run", "--now"], risk, supportsDryRun: false, dryRun: true }),
      );
      if (result.ok) throw new Error("expected a refusal");
      return result.finding;
    };
    for (const risk of ["read", "safe_write", "confirm"] as const) {
      expect(at(risk).message).toBe("gc has no --dry-run preview");
    }
    expect(at("read").fix).toBe("it only reads, so run it without --dry-run: plainport gc --now");
    expect(at("safe_write").fix).toBe(
      "without --dry-run it changes files straight away; see what it does first: plainport help gc",
    );
    expect(at("confirm").fix).toBe(
      "without --dry-run it still asks for --yes before changing anything: plainport gc --now",
    );
  });

  test("the separate steps are not public: the CLI can only call the combined check", () => {
    expect("gate" in contract).toBe(false);
    expect("refuseDryRun" in contract).toBe(false);
  });

  test("checkInvocation is total: every combination is a verdict, and only a refused one fails", () => {
    const bools = [false, true];
    for (const risk of [...RISK_CLASSES, undefined])
      for (const yes of bools)
        for (const plan of bools)
          for (const dryRun of bools)
            for (const supportsDryRun of bools) {
              const result = checkInvocation(inv({ risk, yes, plan, dryRun, supportsDryRun }));
              const expected =
                dryRun && !supportsDryRun
                  ? 2
                  : !dryRun && (risk ?? "confirm") === "confirm" && !yes && !plan
                    ? 3
                    : 0;
              expect(result.ok ? 0 : result.exitCode).toBe(expected);
            }
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

  test("commandLine quotes the same way without adding --yes (the CLI's did-you-mean uses it)", () => {
    expect(commandLine(["offload", "my project"])).toBe("plainport offload 'my project'");
    expect(commandLine([])).toBe("plainport");
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

  // CI installs both shells and must never skip this (scripts/ci-workflow.test.ts pins the install); a laptop
  // without one of them skips it.
  for (const shell of ["zsh", "bash"]) {
    test.skipIf(!Bun.which(shell) && !process.env.CI)(
      `${shell} reads the re-run back as the same arguments`,
      () => {
        expect(Bun.which(shell)).not.toBeNull();
        expect(parse(shell, rerunWithYes(awkward))).toEqual([...awkward, "--yes"]);
        expect(parse(shell, rerunWithYes(["offload", "--", "=odd"]))).toEqual([
          "offload",
          "--yes",
          "--",
          "=odd",
        ]);
      },
    );
  }
});
