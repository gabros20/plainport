import { describe, expect, test } from "bun:test";
import { FINDINGS, type FindingCode, FindingCodeSchema, FindingSchema, finding } from "./index.ts";

describe("findings", () => {
  test("codes are stable dotted lower-case strings", () => {
    for (const code of ["git.unpushed", "git.in-progress", "fs.case-collision", "tool.missing", "a.b.c"]) {
      expect(FindingCodeSchema.safeParse(code).success).toBe(true);
    }
    for (const code of [
      "unpushed",
      "Git.unpushed",
      "git.",
      ".git",
      "git..x",
      "git.un pushed",
      "git.-x",
      "git_x.y",
    ]) {
      expect(FindingCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  test("a finding must carry a code, severity, message and allowable flag", () => {
    const valid = { code: "git.unpushed", severity: "warn", message: "2 commits", allowable: true };
    expect(FindingSchema.safeParse(valid).success).toBe(true);
    const { allowable: _, ...withoutAllowable } = valid;
    expect(FindingSchema.safeParse(withoutAllowable).success).toBe(false);
    expect(FindingSchema.safeParse({ ...valid, code: "unpushed" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...valid, severity: "error" }).success).toBe(false);
    // D16: findings are output, so a field added later must not break an older reader.
    expect(FindingSchema.safeParse({ ...valid, extra: 1 }).success).toBe(true);
    expect(FindingSchema.safeParse({ ...valid, fix: "git push", paths: ["a"] }).success).toBe(true);
  });

  test("every catalogued finding has a dotted code, an allowable flag and a failure exit code", () => {
    const codes = Object.keys(FINDINGS);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const entry = FINDINGS[code as FindingCode];
      expect(FindingCodeSchema.safeParse(code).success).toBe(true);
      expect(typeof entry.allowable).toBe("boolean");
      expect(entry.exitCode).not.toBe(0);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
  });

  test("the catalogue is frozen", () => {
    expect(FINDINGS as unknown).toEqual({
      "contract.invalid": { severity: "block", allowable: false, exitCode: 1, summary: expect.any(String) },
      "risk.needs-yes": { severity: "block", allowable: false, exitCode: 3, summary: expect.any(String) },
      "tool.missing": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "usage.dry-run-unsupported": {
        severity: "block",
        allowable: false,
        exitCode: 2,
        summary: expect.any(String),
      },
    });
    expect(Object.isFrozen(FINDINGS)).toBe(true);
  });

  test("finding() takes severity from the catalogue; a caller cannot override it", () => {
    // @ts-expect-error severity is not a detail field
    const f = finding("tool.missing", { message: "m", severity: "info" });
    expect(f.severity).toBe("block");
  });

  test("finding() fills severity and allowable from the catalogue, and the result validates", () => {
    const f = finding("tool.missing", { message: "restic not found", fix: "run fetch-tools", paths: ["/x"] });
    expect(f).toEqual({
      code: "tool.missing",
      severity: "block",
      message: "restic not found",
      fix: "run fetch-tools",
      paths: ["/x"],
      allowable: false,
    });
    expect(FindingSchema.parse(f)).toEqual(f);
  });
});
