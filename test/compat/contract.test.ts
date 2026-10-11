// The contract against v0.1.1 (T0): everything v0.1.1 published still holds, read from the tag with `git show`.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { released, releasedNames, tagAvailable } from "./binaries.ts";
import { CHANGED_SCHEMAS, NEW_SCHEMAS } from "./matrix.ts";
import { notAssignable } from "./schema-diff.ts";

const checkout = resolve(import.meta.dir, "../..");
/** v0.1.1's published files, vendored from the tag so this T0 test needs neither the tag nor the history (CI's checkout is shallow). */
const vendored = join(checkout, "test/fixtures/compat-v0.1.1");
const releasedFile = (path: string): string => readFileSync(join(vendored, path), "utf8");
const now = (path: string): string => readFileSync(join(checkout, path), "utf8");
const names = (dir: string): string[] => readdirSync(join(checkout, dir)).filter((f) => f.endsWith(".json"));

describe("compat contract: schema-diff", () => {
  test("accepts an added optional key and rejects the breaking changes", () => {
    const old = { type: "object", properties: { a: { type: "string", enum: ["x", "y"] } }, required: ["a"] };
    expect(notAssignable({ ...old, properties: { ...old.properties, b: { type: "string" } } }, old)).toEqual(
      [],
    );
    expect(notAssignable({ ...old, required: [] }, old)).not.toEqual([]);
    expect(
      notAssignable({ ...old, properties: { a: { type: "string", enum: ["x", "y", "z"] } } }, old),
    ).not.toEqual([]);
    expect(notAssignable({ ...old, properties: { a: { type: "number" } } }, old)).not.toEqual([]);
    expect(notAssignable({ type: "object", properties: {}, required: [] }, old)).not.toEqual([]);
  });

  test("catches what the generator's other keywords change", () => {
    const record = (v: string) => ({ type: "object", additionalProperties: { type: v } });
    expect(notAssignable(record("number"), record("string"))).not.toEqual([]);
    expect(notAssignable(record("string"), record("string"))).toEqual([]);
    expect(notAssignable({ type: "string" }, { type: "string", format: "date-time" })).not.toEqual([]);
    expect(notAssignable({ type: "object" }, { type: "object", additionalProperties: false })).not.toEqual(
      [],
    );
    expect(
      notAssignable({ type: "array", items: {} }, { type: "array", items: {}, minItems: 1 }),
    ).not.toEqual([]);
    expect(
      notAssignable({ type: "array", items: {}, minItems: 2 }, { type: "array", items: {}, minItems: 1 }),
    ).toEqual([]);
    expect(
      notAssignable({ type: "object" }, { type: "object", propertyNames: { pattern: "^a" } }),
    ).not.toEqual([]);
    expect(notAssignable({ oneOf: [] }, { oneOf: [{ type: "string" }] })).not.toEqual([]);
    expect(
      notAssignable(
        { type: "string", description: "new words" },
        { type: "string", description: "old words" },
      ),
    ).toEqual([]);
  });
});

describe("compat contract: v0.1.1's published files", () => {
  const tagged = JSON.parse(releasedFile("plainport.json"));
  const current = JSON.parse(now("plainport.json"));

  test.skipIf(!tagAvailable())("the vendored copies are the tag's files", () => {
    expect(releasedFile("plainport.json")).toBe(released("plainport.json"));
    expect(names("test/fixtures/compat-v0.1.1/schemas").sort()).toEqual(releasedNames("schemas").sort());
    for (const f of releasedNames("schemas"))
      expect(releasedFile(`schemas/${f}`), f).toBe(released(`schemas/${f}`));
  });

  test("[output.additive][claim.boot] every schema file is unchanged, or listed with its matrix row; new ones are listed too", () => {
    const old = names("test/fixtures/compat-v0.1.1/schemas");
    const changed = old.filter((f) => releasedFile(`schemas/${f}`) !== now(`schemas/${f}`));
    expect(changed.map((f) => f.replace(".json", "")).sort()).toEqual(Object.keys(CHANGED_SCHEMAS).sort());
    const added = names("schemas").filter((f) => !old.includes(f));
    expect(added.map((f) => f.replace(".json", "")).sort()).toEqual(Object.keys(NEW_SCHEMAS).sort());
  });

  test("[value.exit-codes] exit codes keep their meaning", () => {
    for (const code of tagged.exitCodes) expect(current.exitCodes).toContainEqual(code);
  });

  test("[output.additive][value.exit-codes] finding codes keep their severity, exit code and allowability", () => {
    for (const f of tagged.findings) {
      const now = current.findings.find((g: { code: string }) => g.code === f.code);
      expect(now, `${f.code} was retired`).toBeDefined();
      expect([now.severity, now.exitCode, now.allowable]).toEqual([f.severity, f.exitCode, f.allowable]);
    }
  });

  test("[output.additive][plan][output.plan-git][output.plan-nested][output.onload-plan][output.git-unpushed-tags][output.untrusted-known][output.hydrate-via] commands keep their risk class, options and positionals; outputs stay assignable to the released schema", () => {
    for (const c of tagged.commands) {
      const now = current.commands.find((x: { name: string }) => x.name === c.name);
      expect(now, `${c.name} was removed`).toBeDefined();
      expect(now.risk, `${c.name}: risk`).toBe(c.risk);
      if (c.dryRun) expect(now.dryRun, `${c.name}: dry-run`).toBe(true);
      for (const o of c.options) {
        const n = now.options.find((x: { name: string }) => x.name === o.name);
        expect(n, `${c.name} --${o.name} was removed`).toBeDefined();
        expect([n.type, n.multiple]).toEqual([o.type, o.multiple]);
      }
      expect(now.positionals.slice(0, c.positionals.length)).toEqual(c.positionals);
      expect(notAssignable(now.output, c.output), `${c.name}: output`).toEqual([]);
    }
  });

  test("[finding.case-unknown] the new finding is a warn with exit 6, and added to the catalogue", () => {
    const found = current.findings.find((f: { code: string }) => f.code === "fs.case-unknown");
    expect([found?.severity, found?.exitCode]).toEqual(["warn", 6]);
    expect(tagged.findings.some((f: { code: string }) => f.code === "fs.case-unknown")).toBe(false);
  });

  test("[value.project-state][value.phases] the closed sets (ProjectState, Phase, RiskClass, ExitCode) are the same sets", () => {
    for (const f of ["project-state", "phase", "risk-class", "exit-code"]) {
      expect(JSON.parse(now(`schemas/${f}.json`)), f).toEqual(JSON.parse(releasedFile(`schemas/${f}.json`)));
    }
  });
});
