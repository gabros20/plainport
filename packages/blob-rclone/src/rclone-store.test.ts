import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail, finding, type Result } from "@plainport/contract";
import {
  type HostPorts,
  type RunOutcome,
  type RunSpec,
  type StoreSemantics,
  UNKNOWN_SEMANTICS,
} from "@plainport/core";
import { expectNoCanary, makeCanary } from "../../core/src/testing/canary.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { makeSandbox, type Sandbox } from "../../core/src/testing/sandbox.ts";
import recorded from "./fixtures/stderr.json" with { type: "json" };
import {
  classifyExit,
  RCLONE_REMOTE,
  type RcloneBlobStoreOptions,
  rcloneBlobStore,
  TEMP_PREFIX,
} from "./rclone-store.ts";

const outcome = (exitCode: number | null, out: { stdout?: string; stderr?: string } = {}): RunOutcome => ({
  exitCode,
  signal: exitCode === null ? "SIGKILL" : null,
  stdout: { text: out.stdout ?? "", droppedBytes: 0 },
  stderr: { text: out.stderr ?? "", droppedBytes: 0 },
  captured: new TextEncoder().encode(out.stdout ?? ""),
  leftoversStopped: false,
  durationMs: 1,
});

type Script = (spec: RunSpec) => Result<RunOutcome> | RunOutcome;

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.finding.code}: ${result.finding.message}`);
  return result.value;
};

let sandbox: Sandbox;
beforeEach(() => {
  sandbox = makeSandbox("plainport-rclone-t0-");
});
afterEach(() => sandbox.cleanup());

/** A store whose rclone runs are scripted; every spec it ran is kept. */
const scripted = (script: Script, options: Partial<RcloneBlobStoreOptions> = {}) => {
  const specs: RunSpec[] = [];
  const base = testHost();
  const host: HostPorts = {
    ...base,
    run: async (spec) => {
      specs.push(spec);
      const result = script(spec);
      return "ok" in result ? result : { ok: true, value: result };
    },
  };
  const store = rcloneBlobStore({
    host,
    rclone: "/opt/plainport/rclone",
    remote: { type: "sftp", root: "plainport", options: { host: "nas.local", user: "me" } },
    paths: sandbox.paths,
    env: {
      HOME: sandbox.home,
      PATH: "/usr/bin:/bin",
      TMPDIR: "/tmp",
      RCLONE_CONFIG: "/poison/rclone.conf",
      RCLONE_CONFIG_PLAINPORT_TYPE: "alias",
      RCLONE_LOCAL_COPY_LINKS: "true",
      AWS_SECRET_ACCESS_KEY: "inherited",
    },
    ...options,
  });
  return { store, specs };
};

/** The rclone command of a spec (the first argument that is not a flag or a flag's value). */
const commandOf = (spec: RunSpec): string => {
  const args = spec.args ?? [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("-")) return arg;
    if (!arg.includes("=") && VALUED.has(arg)) i++;
  }
  throw new Error("no command");
};
const VALUED = new Set(["--contimeout", "--timeout", "--retries", "--cache-dir", "--size", "--bwlimit"]);

describe("exit codes, on recorded stderr", () => {
  for (const fixture of recorded.fixtures) {
    test(`${fixture.name}: ${fixture.expect}`, () => {
      expect(classifyExit(fixture.exitCode, fixture.stderr)).toBe(fixture.expect as never);
    });
  }

  test("0 is ok, 5 is unreachable whatever stderr says, anything else unexplained is failed", () => {
    expect(classifyExit(0, "")).toBe("ok");
    expect(classifyExit(5, "")).toBe("unreachable");
    expect(classifyExit(7, "Fatal error: something")).toBe("failed");
    expect(classifyExit(null, "")).toBe("failed");
  });

  test("on get and stat, 3 and 4 mean null", async () => {
    for (const code of [3, 4]) {
      const { store } = scripted(() => outcome(code, { stderr: "ERROR : object not found\n" }));
      expect(value(await store.get("meta/v1/events/a.json"))).toBeNull();
      expect(value(await store.stat("meta/v1/events/a.json"))).toBeNull();
    }
  });

  test("a listing of a folder that is not there is empty; deleting a missing key is fine", async () => {
    const { store } = scripted(() => outcome(3, { stderr: "ERROR : error listing: directory not found\n" }));
    expect(value(await store.list("meta/v1/events/"))).toEqual([]);
    expect(value(await store.delete("meta/v1/events/a.json"))).toBeUndefined();
  });

  test("a connection failure is store.unreachable on every call", async () => {
    const refused = recorded.fixtures.find((f) => f.name === "sftp connection refused");
    const { store } = scripted(() => outcome(1, { stderr: refused?.stderr ?? "" }));
    for (const result of [
      await store.get("k"),
      await store.stat("k"),
      await store.list(""),
      await store.put("k", new Uint8Array([1])),
      await store.delete("k"),
    ]) {
      expect(result).toMatchObject({ ok: false, finding: { code: "store.unreachable" } });
    }
  });

  test("anything else is store.failed, naming the key and what rclone said", async () => {
    const denied = recorded.fixtures.find((f) => f.name === "permission denied");
    const { store } = scripted(() => outcome(1, { stderr: denied?.stderr ?? "" }));
    const put = await store.put("meta/v1/events/a.json", new Uint8Array([1]));
    expect(put).toMatchObject({ ok: false, finding: { code: "store.failed" } });
    if (put.ok) throw new Error("unreachable");
    expect(put.finding.message).toContain("meta/v1/events/a.json");
    expect(put.finding.message).toContain("permission denied");
    expect(put.finding.message).not.toContain("2026/10/29");
  });

  test("a run the runner itself failed keeps its finding", async () => {
    const { store } = scripted(() =>
      fail(finding("process.timeout", { message: "rclone did not finish within 300 seconds" })),
    );
    expect(await store.get("k")).toMatchObject({ ok: false, finding: { code: "process.timeout" } });
  });
});

describe("the child's environment and flags", () => {
  test("remotes come from the environment only; rclone.conf is a missing file under plainport's cache", async () => {
    const { store, specs } = scripted(() => outcome(0, { stdout: "[]" }), {
      remote: {
        type: "s3",
        root: "bucket/store",
        options: { provider: "Other", endpoint: "http://127.0.0.1:9000" },
        secrets: { secret_access_key: "s3cr3t-value", access_key_id: "AKID" },
      },
    });
    value(await store.list(""));
    const spec = specs[0] as RunSpec;
    expect(spec.command).toBe("/opt/plainport/rclone");
    expect(spec.env.RCLONE_CONFIG).toStartWith(join(sandbox.paths.cacheDir, "rclone"));
    expect(spec.env.RCLONE_CONFIG).not.toBe("/poison/rclone.conf");
    expect(spec.env[`RCLONE_CONFIG_${RCLONE_REMOTE}_TYPE`]).toBe("s3");
    expect(spec.env[`RCLONE_CONFIG_${RCLONE_REMOTE}_ENDPOINT`]).toBe("http://127.0.0.1:9000");
    expect(spec.env[`RCLONE_CONFIG_${RCLONE_REMOTE}_SECRET_ACCESS_KEY`]).toBe("s3cr3t-value");
    // Nothing of this process's own rclone or cloud settings is inherited.
    expect(spec.env.RCLONE_LOCAL_COPY_LINKS).toBeUndefined();
    expect(spec.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(spec.env.HOME).toBe(sandbox.home);
    const rcloneVars = Object.keys(spec.env).filter((name) => name.startsWith("RCLONE_"));
    for (const name of rcloneVars)
      expect(name === "RCLONE_CONFIG" || name.startsWith(`RCLONE_CONFIG_${RCLONE_REMOTE}_`)).toBe(true);
  });

  test("network calls are bounded on top of the runner's deadlines", async () => {
    const { store, specs } = scripted(() => outcome(0, { stdout: "[]" }));
    value(await store.list(""));
    const spec = specs[0] as RunSpec;
    const args = spec.args ?? [];
    for (const flag of ["--contimeout", "--timeout", "--retries"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--retries") + 1]).toBe("1");
    expect(args[args.indexOf("--cache-dir") + 1]).toStartWith(sandbox.paths.cacheDir);
    expect(spec.idleTimeoutMs).toBeGreaterThan(0);
    expect(spec.timeoutMs).toBeGreaterThan(0);
  });

  test("a file where the missing rclone.conf should be refuses before rclone runs", async () => {
    const { store, specs } = scripted(() => outcome(0, { stdout: "[]" }));
    value(await store.list(""));
    const config = (specs[0] as RunSpec).env.RCLONE_CONFIG as string;
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, "[PLAINPORT]\ntype = local\n");
    const listed = await store.list("");
    expect(listed).toMatchObject({ ok: false, finding: { code: "store.failed" } });
    if (listed.ok) throw new Error("unreachable");
    expect(listed.finding.message).toContain(config);
    expect(specs).toHaveLength(1);
  });
});

describe("the canary: a secret never reaches argv or an error", () => {
  test("over every call, success and failure", async () => {
    const canary = makeCanary("rclone");
    const findings: unknown[] = [];
    for (const exit of [0, 1, 5, 7]) {
      const { store, specs } = scripted(
        (spec) =>
          outcome(exit, {
            stdout: commandOf(spec) === "lsjson" ? "[]" : "",
            // rclone quoting its own configuration back, as a backend error may.
            stderr: `2026/10/29 17:30:53 ERROR : auth failed for key ${canary.value} (${canary.value.slice(0, 40)}…)\n`,
          }),
        {
          remote: {
            type: "s3",
            root: "bucket",
            options: { provider: "Other" },
            secrets: { secret_access_key: canary.value },
          },
        },
      );
      for (const result of [
        await store.get("a"),
        await store.stat("a"),
        await store.list(""),
        await store.put("meta/v1/events/a.json", new Uint8Array([1])),
        await store.delete("a"),
        await store.getMany(["a", "b"]),
      ]) {
        if (!result.ok) findings.push(result.finding);
      }
      expectNoCanary([canary], {
        argv: specs.map((spec) => [spec.command, ...(spec.args ?? [])]),
        findings,
      });
      // It reaches rclone only as its remote's option, in the child's environment.
      for (const spec of specs) {
        const holders = Object.entries(spec.env).filter(([, v]) => v === canary.value);
        expect(holders.map(([name]) => name)).toEqual([`RCLONE_CONFIG_${RCLONE_REMOTE}_SECRET_ACCESS_KEY`]);
      }
    }
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe("publication", () => {
  test("on SFTP a put uploads to its own temporary under the reserved prefix, then moves it onto the key", async () => {
    const { store, specs } = scripted(() => outcome(0));
    value(await store.put("meta/v1/events/01.json", new TextEncoder().encode("{}\n")));
    expect(specs.map(commandOf)).toEqual(["rcat", "moveto"]);
    const [rcat, moveto] = specs as [RunSpec, RunSpec];
    const temp = (rcat.args ?? []).at(-1) as string;
    expect(temp).toMatch(
      new RegExp(`^${RCLONE_REMOTE}:plainport/${TEMP_PREFIX}put-[0-7][0-9A-HJKMNP-TV-Z]{25}$`),
    );
    expect((moveto.args ?? []).slice(-2)).toEqual([
      temp,
      `${RCLONE_REMOTE}:plainport/meta/v1/events/01.json`,
    ]);
    expect(new TextDecoder().decode(rcat.stdin as Uint8Array)).toBe("{}\n");
  });

  test("a failed move deletes its temporary, as far as it can, and fails", async () => {
    const { store, specs } = scripted((spec) =>
      commandOf(spec) === "moveto" ? outcome(1, { stderr: "ERROR : rename failed\n" }) : outcome(0),
    );
    const put = await store.put("meta/v1/events/01.json", new Uint8Array([1]));
    expect(put).toMatchObject({ ok: false, finding: { code: "store.failed" } });
    expect(specs.map(commandOf)).toEqual(["rcat", "moveto", "deletefile"]);
    expect((specs[2]?.args ?? []).at(-1)).toBe((specs[0]?.args ?? []).at(-1) as string);
  });

  test("on S3 a put is rcat straight to the key", async () => {
    const { store, specs } = scripted(() => outcome(0), {
      remote: { type: "s3", root: "bucket/store", options: { provider: "Other" } },
    });
    value(await store.put("meta/v1/events/01.json", new Uint8Array([1])));
    expect(specs.map(commandOf)).toEqual(["rcat"]);
    expect((specs[0]?.args ?? []).at(-1)).toBe(`${RCLONE_REMOTE}:bucket/store/meta/v1/events/01.json`);
  });

  test("an empty value is copied from an empty local file: rclone's rcat refuses an empty stdin", async () => {
    for (const type of ["s3", "sftp"]) {
      const { store, specs } = scripted(() => outcome(0), { remote: { type, root: "r" } });
      value(await store.put("meta/v1/empty", new Uint8Array()));
      expect(specs.map(commandOf)).toEqual(type === "s3" ? ["copyto"] : ["copyto", "moveto"]);
      const source = (specs[0]?.args ?? []).at(-2) as string;
      expect(source).toStartWith(sandbox.paths.cacheDir);
      expect(Bun.file(source).size).toBe(0);
      expect(specs[0]?.args).toContain("--ignore-times");
    }
  });

  test("the temporaries' prefix is the adapter's own: never listed, never written or deleted by a caller", async () => {
    const { store } = scripted(() =>
      outcome(0, {
        stdout: JSON.stringify([
          { Path: "events/01.json", Name: "01.json", Size: 3, IsDir: false },
          { Path: "tmp/put-01J0000000000000000000000A", Name: "x", Size: 3, IsDir: false },
        ]),
      }),
    );
    expect(value(await store.list("meta/v1/")).map((e) => e.key)).toEqual(["meta/v1/events/01.json"]);
    expect(() => store.put(`${TEMP_PREFIX}x`, new Uint8Array())).toThrow(RangeError);
    expect(() => store.delete(`${TEMP_PREFIX}x`)).toThrow(RangeError);
  });
});

describe("semantics", () => {
  test("every property is unknown until it is measured (Task 17), so only read is eligible", () => {
    const { store } = scripted(() => outcome(0));
    expect(store.semantics()).toEqual(UNKNOWN_SEMANTICS);
    expect(store.capabilities()).toEqual({ createIfAbsent: false, replaceIfMatch: false });
  });

  test("a profile claiming more than the adapter does is a bug", () => {
    const claims = (patch: Partial<StoreSemantics>) => () =>
      scripted(() => outcome(0), { semantics: { ...UNKNOWN_SEMANTICS, ...patch } });
    expect(claims({ conditionalCreate: { value: true, evidence: "measured" } })).toThrow(RangeError);
    expect(claims({ publication: { value: "atomic-put", evidence: "measured" } })).toThrow(RangeError);
    expect(claims({ publication: { value: "temp-then-rename", evidence: "measured" } })).not.toThrow();
  });

  test("create-only writes are not offered: asking for one is a bug", () => {
    const { store } = scripted(() => outcome(0));
    expect(() => store.put("k", new Uint8Array(), { ifNotExists: true })).toThrow();
  });
});

describe("reads", () => {
  test("get reads exactly the key, never a folder of that name", async () => {
    const { store, specs } = scripted((spec) =>
      commandOf(spec) === "cat"
        ? outcome(0, { stdout: "" })
        : outcome(0, { stdout: JSON.stringify({ Path: "", Name: "", Size: -1, IsDir: true }) }),
    );
    expect(value(await store.get("meta/v1"))).toBeNull();
    const cat = specs[0] as RunSpec;
    expect(cat.args).toContain("--files-from-raw");
    expect((cat.args ?? []).at(-1)).toBe(`${RCLONE_REMOTE}:plainport/meta`);
    expect(cat.stdin).toBe("v1\n");
  });

  test("an empty result is an empty value only when stat finds the file", async () => {
    const { store } = scripted((spec) =>
      commandOf(spec) === "cat"
        ? outcome(0, { stdout: "" })
        : outcome(0, { stdout: JSON.stringify({ Path: "e", Name: "e", Size: 0, IsDir: false }) }),
    );
    expect(value(await store.get("e"))).toEqual(new Uint8Array());
  });

  test("list maps paths under the listed folder to keys, filters by the prefix and sorts", async () => {
    const { store, specs } = scripted(() =>
      outcome(0, {
        stdout: JSON.stringify([
          { Path: "events/02.json", Name: "02.json", Size: 2, IsDir: false },
          { Path: "events/01.json", Name: "01.json", Size: 1, IsDir: false },
          { Path: "state.json", Name: "state.json", Size: 9, IsDir: false },
        ]),
      }),
    );
    expect(value(await store.list("meta/v1/ev"))).toEqual([
      { key: "meta/v1/events/01.json", size: 1 },
      { key: "meta/v1/events/02.json", size: 2 },
    ]);
    expect((specs[0]?.args ?? []).slice(-1)).toEqual([`${RCLONE_REMOTE}:plainport/meta/v1`]);
    expect(specs[0]?.args).toEqual(expect.arrayContaining(["lsjson", "-R", "--files-only"]));
  });

  test("a listing rclone printed that does not parse is store.failed", async () => {
    const { store } = scripted(() => outcome(0, { stdout: "[{not json" }));
    expect(await store.list("")).toMatchObject({ ok: false, finding: { code: "store.failed" } });
  });
});
