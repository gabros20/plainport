import { describe, expect, test } from "bun:test";
import { FindingSchema, type GateRequest, gate, RISK_CLASSES, rerunWithYes } from "./index.ts";

const req = (over: Partial<GateRequest> = {}): GateRequest => ({
  command: "offload",
  argv: ["offload", "web"],
  risk: "confirm",
  supportsDryRun: true,
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

  test("--dry-run runs as read, but only for a command that supports it", () => {
    for (const risk of RISK_CLASSES) {
      expect(gate(req({ risk, dryRun: true }))).toEqual({ verdict: "allow", riskClass: "read" });
    }
    expect(gate(req({ dryRun: true, supportsDryRun: false })).verdict).toBe("confirm");
    expect(gate(req({ risk: "safe_write", dryRun: true, supportsDryRun: false }))).toEqual({
      verdict: "allow",
      riskClass: "safe_write",
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
          for (const dryRun of bools)
            for (const supportsDryRun of bools) {
              const verdict = gate(req({ risk, yes, plan, dryRun, supportsDryRun }));
              expect(["allow", "confirm"]).toContain(verdict.verdict);
              const refused =
                (risk ?? "confirm") === "confirm" && !yes && !plan && !(dryRun && supportsDryRun);
              expect(verdict.verdict === "confirm").toBe(refused);
            }
  });
});
