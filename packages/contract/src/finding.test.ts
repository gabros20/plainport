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
      "catalog.event-skipped": {
        severity: "warn",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "command.cancelled": {
        severity: "block",
        allowable: false,
        exitCode: 130,
        summary: expect.any(String),
      },
      "config.owned": { severity: "block", allowable: false, exitCode: 5, summary: expect.any(String) },
      "device.none": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "process.cancelled": {
        severity: "block",
        allowable: false,
        exitCode: 130,
        summary: expect.any(String),
      },
      "process.idle-timeout": {
        severity: "block",
        allowable: false,
        exitCode: 1,
        summary: expect.any(String),
      },
      "process.output-incomplete": {
        severity: "block",
        allowable: false,
        exitCode: 1,
        summary: expect.any(String),
      },
      "process.output-too-large": {
        severity: "block",
        allowable: false,
        exitCode: 1,
        summary: expect.any(String),
      },
      "process.spawn-failed": {
        severity: "block",
        allowable: false,
        exitCode: 1,
        summary: expect.any(String),
      },
      "process.timeout": { severity: "block", allowable: false, exitCode: 1, summary: expect.any(String) },
      "project.ambiguous": { severity: "block", allowable: false, exitCode: 2, summary: expect.any(String) },
      "project.not-found": { severity: "block", allowable: false, exitCode: 4, summary: expect.any(String) },
      "project.unregistered": {
        severity: "block",
        allowable: false,
        exitCode: 4,
        summary: expect.any(String),
      },
      "registry.invalid": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "registry.locked": { severity: "block", allowable: false, exitCode: 11, summary: expect.any(String) },
      "registry.unreadable": {
        severity: "block",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "root.defined-twice": { severity: "warn", allowable: false, exitCode: 6, summary: expect.any(String) },
      "root.exists": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "root.none": { severity: "block", allowable: false, exitCode: 2, summary: expect.any(String) },
      "root.not-found": { severity: "block", allowable: false, exitCode: 4, summary: expect.any(String) },
      "root.not-writable": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "root.overlap": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "root.path-missing": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "root.synced-folder": { severity: "warn", allowable: true, exitCode: 6, summary: expect.any(String) },
      "root.unbound": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "store.failed": { severity: "block", allowable: false, exitCode: 1, summary: expect.any(String) },
      "store.identity-changed": {
        severity: "block",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "store.inside-project": {
        severity: "block",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "store.key-exists": { severity: "block", allowable: false, exitCode: 1, summary: expect.any(String) },
      "store.unreachable": { severity: "block", allowable: false, exitCode: 9, summary: expect.any(String) },
      "stub.invalid": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "command.unknown": { severity: "block", allowable: false, exitCode: 4, summary: expect.any(String) },
      "config.invalid": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "config.kept-last-good": {
        severity: "warn",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "config.locked": { severity: "block", allowable: false, exitCode: 11, summary: expect.any(String) },
      "config.no-home": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "config.not-found": { severity: "block", allowable: false, exitCode: 4, summary: expect.any(String) },
      "config.read-only": { severity: "block", allowable: false, exitCode: 5, summary: expect.any(String) },
      "config.write-failed": {
        severity: "block",
        allowable: false,
        exitCode: 1,
        summary: expect.any(String),
      },
      "contract.invalid": { severity: "block", allowable: false, exitCode: 1, summary: expect.any(String) },
      "device.invalid": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "internal.unexpected": {
        severity: "block",
        allowable: false,
        exitCode: 1,
        summary: expect.any(String),
      },
      "env.docker-mount": { severity: "block", allowable: true, exitCode: 6, summary: expect.any(String) },
      "fs.dataless": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "fs.link-outside": { severity: "warn", allowable: true, exitCode: 6, summary: expect.any(String) },
      "fs.unreadable": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "git.failed": { severity: "block", allowable: false, exitCode: 1, summary: expect.any(String) },
      "git.in-progress": { severity: "warn", allowable: true, exitCode: 6, summary: expect.any(String) },
      "git.is-worktree": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "git.locked": { severity: "block", allowable: true, exitCode: 6, summary: expect.any(String) },
      "git.unpushed": { severity: "warn", allowable: true, exitCode: 6, summary: expect.any(String) },
      "git.unpushed-required": {
        severity: "block",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "git.worktrees": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "git.nested-repos": { severity: "info", allowable: false, exitCode: 6, summary: expect.any(String) },
      "deps.ambiguous": { severity: "warn", allowable: true, exitCode: 6, summary: expect.any(String) },
      "deps.no-lockfile": { severity: "warn", allowable: true, exitCode: 6, summary: expect.any(String) },
      "plan.expired": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "plan.not-found": { severity: "block", allowable: false, exitCode: 4, summary: expect.any(String) },
      "catalog.head-moved": { severity: "block", allowable: false, exitCode: 8, summary: expect.any(String) },
      "catalog.incomplete": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "catalog.head-uncertain": {
        severity: "block",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "fs.cross-volume": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "fs.write-failed": { severity: "block", allowable: false, exitCode: 1, summary: expect.any(String) },
      "path.reserved": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "path.stub-occupied": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "journal.pending": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "offload.diverged-after-commit": {
        severity: "block",
        allowable: false,
        exitCode: 8,
        summary: expect.any(String),
      },
      "operation.cancelled": {
        severity: "block",
        allowable: false,
        exitCode: 130,
        summary: expect.any(String),
      },
      "plan.stale": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "project.locked": { severity: "block", allowable: false, exitCode: 11, summary: expect.any(String) },
      "store.not-set-up": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "store.root-mismatch": {
        severity: "block",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "store.secret-missing": {
        severity: "block",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "store.setup-pending": { severity: "warn", allowable: false, exitCode: 6, summary: expect.any(String) },
      "store.unsupported": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "verify.changed": { severity: "block", allowable: false, exitCode: 7, summary: expect.any(String) },
      "verify.mismatch": { severity: "block", allowable: false, exitCode: 7, summary: expect.any(String) },
      "strip.kept": { severity: "info", allowable: false, exitCode: 6, summary: expect.any(String) },
      "fs.case-collision": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "fs.no-space": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "hydrate.failed": { severity: "block", allowable: false, exitCode: 10, summary: expect.any(String) },
      "lease.held": { severity: "warn", allowable: false, exitCode: 8, summary: expect.any(String) },
      "path.occupied": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "project.nested": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "project.already-local": {
        severity: "block",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "snapshot.not-found": { severity: "block", allowable: false, exitCode: 4, summary: expect.any(String) },
      "toolchain.mismatch": { severity: "warn", allowable: false, exitCode: 6, summary: expect.any(String) },
      "proc.cwd": { severity: "block", allowable: true, exitCode: 6, summary: expect.any(String) },
      "proc.cwd-shell": { severity: "warn", allowable: true, exitCode: 6, summary: expect.any(String) },
      "proc.open-files": { severity: "block", allowable: true, exitCode: 6, summary: expect.any(String) },
      "restic.failed": { severity: "block", allowable: false, exitCode: 1, summary: expect.any(String) },
      "restic.interrupted": {
        severity: "block",
        allowable: false,
        exitCode: 130,
        summary: expect.any(String),
      },
      "restic.locked": { severity: "block", allowable: false, exitCode: 11, summary: expect.any(String) },
      "restic.output-invalid": {
        severity: "block",
        allowable: false,
        exitCode: 1,
        summary: expect.any(String),
      },
      "restic.repo-exists": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "restic.repo-missing": {
        severity: "block",
        allowable: false,
        exitCode: 4,
        summary: expect.any(String),
      },
      "restic.snapshot-not-found": {
        severity: "block",
        allowable: false,
        exitCode: 4,
        summary: expect.any(String),
      },
      "restic.symlinks-unclear": {
        severity: "block",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "restic.unreadable-files": {
        severity: "block",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "restic.version-mismatch": {
        severity: "block",
        allowable: false,
        exitCode: 6,
        summary: expect.any(String),
      },
      "restic.wrong-password": {
        severity: "block",
        allowable: false,
        exitCode: 5,
        summary: expect.any(String),
      },
      "risk.needs-yes": { severity: "block", allowable: false, exitCode: 3, summary: expect.any(String) },
      "tool.missing": { severity: "block", allowable: false, exitCode: 6, summary: expect.any(String) },
      "usage.dry-run-unsupported": {
        severity: "block",
        allowable: false,
        exitCode: 2,
        summary: expect.any(String),
      },
      "usage.invalid": { severity: "block", allowable: false, exitCode: 2, summary: expect.any(String) },
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
