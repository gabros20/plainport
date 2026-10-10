// The contract against v0.1.1 (T0): everything v0.1.1 published still holds, read from the tag with `git show`.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CHANGED_SCHEMAS, NEW_SCHEMAS } from "./matrix.ts";
import { notAssignable } from "./schema-diff.ts";

const checkout = resolve(import.meta.dir, "../..");
const released = (path: string): string => {
  const ran = Bun.spawnSync(["git", "show", `v0.1.1:${path}`], {
    cwd: checkout,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (ran.exitCode !== 0)
    throw new Error(`git show v0.1.1:${path}: ${ran.stderr.toString()} (are tags fetched?)`);
  return ran.stdout.toString();
};
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
});

describe("compat contract: v0.1.1's published files", () => {
  const tagged = JSON.parse(released("plainport.json"));
  const current = JSON.parse(now("plainport.json"));

  test("[output.additive][claim.boot] every schema file is unchanged, or listed with its matrix row; new ones are listed too", () => {
    const old = readdirSync(join(checkout, "schemas")).length > 0 ? released_names() : [];
    const changed = old.filter((f) => released(`schemas/${f}`) !== now(`schemas/${f}`));
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

  test("[output.additive][plan] commands keep their risk class, options and positionals; outputs stay assignable to the released schema", () => {
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

  test("[value.project-state][value.phases][value.plan-fp] the closed sets (ProjectState, Phase, RiskClass, ExitCode) are the same sets", () => {
    for (const f of ["project-state", "phase", "risk-class", "exit-code"]) {
      expect(JSON.parse(now(`schemas/${f}.json`)), f).toEqual(JSON.parse(released(`schemas/${f}.json`)));
    }
  });
});

function released_names(): string[] {
  const ran = Bun.spawnSync(["git", "ls-tree", "--name-only", "v0.1.1", "schemas/"], {
    cwd: checkout,
    stdout: "pipe",
  });
  return ran.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((p) => p.replace("schemas/", ""));
}
