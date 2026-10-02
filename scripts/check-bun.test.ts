import { expect, test } from "bun:test";
import { checkBunVersion } from "./check-bun.ts";

test("accepts Bun 1.2.21 and later", () => {
  for (const version of ["1.2.21", "1.2.22", "1.3.0", "1.3.14", "2.0.0"]) {
    expect({ version, ok: checkBunVersion(version).ok }).toEqual({ version, ok: true });
  }
});

test("refuses Bun older than 1.2.21 and says why", () => {
  for (const version of ["1.2.20", "1.2.0", "1.1.45", "0.9.9"]) {
    const verdict = checkBunVersion(version);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) continue;
    expect(verdict.message).toContain(`found ${version}`);
    expect(verdict.message).toContain("needs bun >= 1.2.21");
    expect(verdict.message).toContain("empty-string");
    expect(verdict.message).toContain("bun upgrade");
  }
});
