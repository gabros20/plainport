import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fail, finding, type Result } from "@plainport/contract";
import {
  type HostPorts,
  type RunOutcome,
  type RunSpec,
  type StoreSemantics,
  UNKNOWN_SEMANTICS,
  ulid,
} from "@plainport/core";
import { expectNoCanary, makeCanary } from "../../core/src/testing/canary.ts";
import { testHost } from "../../core/src/testing/host.ts";
import { makeSandbox, type Sandbox } from "../../core/src/testing/sandbox.ts";
import recorded from "./fixtures/stderr.json" with { type: "json" };
import {
  CONDITIONAL_MAX_BYTES,
  classifyExit,
  RCLONE_REMOTE,
  type RcloneBlobStoreOptions,
  rcloneBlobStore,
  SWEEP_SKEW_MS,
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
const scripted = (script: Script, options: Partial<RcloneBlobStoreOptions> = {}, now?: () => Date) => {
  const specs: RunSpec[] = [];
  const base = testHost();
  const host: HostPorts = {
    ...base,
    ...(now === undefined ? {} : { clock: { ...base.clock, now } }),
    run: async (spec) => {
      specs.push(spec);
      const result = script(spec);
      return "ok" in result ? result : { ok: true, value: result };
    },
  };
  const store = rcloneBlobStore({
    host,
    rclone: "/opt/plainport/rclone",
    remote: {
      type: "sftp",
      root: "plainport",
      options: { host: "nas.local", user: "me", known_hosts_file: "/home/me/.ssh/known_hosts" },
    },
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

/** Whether a run is the adapter's look at the store's root (lsjson --stat of the remote's root). */
const isRootStat = (spec: RunSpec): boolean =>
  (spec.args ?? []).includes("--stat") && (spec.args ?? []).at(-1) === `${RCLONE_REMOTE}:plainport`;
const ROOT_THERE = outcome(0, { stdout: JSON.stringify({ Path: "", Size: -1, IsDir: true }) });

const S3_REMOTE = {
  type: "s3",
  root: "bucket/store",
  options: { provider: "Other", endpoint: "http://127.0.0.1:9" },
} as const;

/** A profile that claims conditional create, as SeaweedFS's measured one does. */
const CONDITIONAL: StoreSemantics = {
  ...UNKNOWN_SEMANTICS,
  conditionalCreate: { value: true, evidence: "measured" },
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
const VALUED = new Set([
  "--contimeout",
  "--timeout",
  "--retries",
  "--low-level-retries",
  "--cache-dir",
  "--size",
  "--bwlimit",
  "--header-upload",
  "--s3-upload-cutoff",
  "--log-level",
]);

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
      const { store } = scripted((spec) =>
        isRootStat(spec) ? ROOT_THERE : outcome(code, { stderr: "ERROR : object not found\n" }),
      );
      expect(value(await store.get("meta/v1/events/a.json"))).toBeNull();
      expect(value(await store.stat("meta/v1/events/a.json"))).toBeNull();
    }
  });

  test("a listing of a folder that is not there is empty; deleting a missing key is fine", async () => {
    const { store } = scripted((spec) =>
      isRootStat(spec) ? ROOT_THERE : outcome(3, { stderr: "ERROR : error listing: directory not found\n" }),
    );
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
    // At NOTICE rclone also says, every run, that the missing rclone.conf is missing: never part of the finding.
    const missingConf = `2026/10/29 17:30:53 NOTICE: Config file "${sandbox.paths.cacheDir}/rclone/absent/rclone.conf" not found - using defaults\n`;
    const { store } = scripted(() => outcome(1, { stderr: `${missingConf}${denied?.stderr ?? ""}` }));
    const put = await store.put("meta/v1/events/a.json", new Uint8Array([1]));
    expect(put).toMatchObject({ ok: false, finding: { code: "store.failed" } });
    if (put.ok) throw new Error("unreachable");
    expect(put.finding.message).toContain("meta/v1/events/a.json");
    expect(put.finding.message).toContain("permission denied");
    expect(put.finding.message).not.toContain("2026/10/29");
    expect(put.finding.message).not.toContain("Config file");
  });

  test("a run the runner itself failed keeps its finding", async () => {
    const { store } = scripted(() =>
      fail(finding("process.timeout", { message: "rclone did not finish within 300 seconds" })),
    );
    expect(await store.get("k")).toMatchObject({ ok: false, finding: { code: "process.timeout" } });
  });
});

describe("SFTP through the system's ssh (rclone's ssh option)", () => {
  const SSH = "/usr/bin/ssh -F /sandbox/ssh/config -o BatchMode=yes nas";
  /** rclone runs whose ssh "wrote" `log` to the file its -E names, as OpenSSH does. */
  const withSshLog = (log: string, exitCode = 1) => {
    const logs: string[] = [];
    const run = scripted(
      (spec) => {
        const ssh = spec.env[`RCLONE_CONFIG_${RCLONE_REMOTE}_SSH`] ?? "";
        const path = /^(.*) -E (\S+)$/.exec(ssh)?.[2];
        if (path === undefined) throw new Error(`no -E in ${ssh}`);
        logs.push(path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, log);
        return outcome(exitCode, { stderr: EXTERNAL_EOF });
      },
      { remote: { type: "sftp", root: "/data", options: { ssh: SSH, shell_type: "none" } } },
    );
    return { ...run, logs };
  };
  const EXTERNAL_EOF = (recorded.fixtures.find((f) => f.name === "sftp external ssh closed")?.stderr ??
    "") as string;

  test("every run logs ssh to its own file under plainport's cache, read and removed after the run", async () => {
    const { store, specs, logs } = withSshLog("Connection closed by 127.0.0.1 port 22\r\n");
    await store.list("");
    await store.get("k");
    expect(logs).toHaveLength(specs.length);
    expect(new Set(logs).size).toBe(logs.length);
    for (const log of logs) {
      expect(log).toStartWith(join(sandbox.paths.cacheDir, "rclone", "ssh"));
      expect(existsSync(log)).toBe(false);
    }
    expect(specs[0]?.env[`RCLONE_CONFIG_${RCLONE_REMOTE}_SSH`]).toStartWith(`${SSH} -E `);
  });

  test("a link ssh lost is store.unreachable; a refused host key or login is store.failed", async () => {
    for (const [log, code] of [
      ["Connection closed by 127.0.0.1 port 30423\r\n", "store.unreachable"],
      ["kex_exchange_identification: read: Connection reset by peer\r\n", "store.unreachable"],
      ["ssh: connect to host nas port 22: Operation timed out\r\n", "store.unreachable"],
      [
        "Host key for [127.0.0.1]:30422 has changed and you have requested strict checking.\r\nHost key verification failed.\r\n",
        "store.failed",
      ],
      ["plainport@127.0.0.1: Permission denied (publickey).\r\n", "store.failed"],
      // rclone alone cannot tell which: without ssh's word it is a failure to look at, not a retry.
      ["", "store.failed"],
    ] as const) {
      const { store } = withSshLog(log);
      const listed = await store.list("");
      expect({ log, listed }).toMatchObject({ log, listed: { ok: false, finding: { code } } });
      if (!listed.ok && log !== "")
        expect(listed.finding.message).toContain(log.split("\r\n").at(-2) as string);
    }
  });

  test("an ssh option is used as given when the remote is not SFTP", async () => {
    const { store, specs } = scripted(() => outcome(0, { stdout: "[]" }), {
      remote: { type: "local", root: "/data", options: { ssh: SSH } },
    });
    value(await store.list(""));
    expect(specs[0]?.env[`RCLONE_CONFIG_${RCLONE_REMOTE}_SSH`]).toBe(SSH);
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

  test("listings read no per-object metadata, and rclone says why it failed (NOTICE, not -q)", async () => {
    // Found on T2 (Task 17): lsjson on S3 sends one HeadObject per key for its ModTime and MimeType, and lsjson's own
    // failure is a NOTICE, which -q drops.
    const { store, specs } = scripted((spec) =>
      commandOf(spec) === "lsjson"
        ? outcome(0, { stdout: (spec.args ?? []).includes("--stat") ? "{}" : "[]" })
        : outcome(0),
    );
    value(await store.list(""));
    await store.stat("k");
    for (const spec of specs) {
      expect(spec.args).toEqual(expect.arrayContaining(["--no-modtime", "--no-mimetype"]));
      expect(spec.args).not.toContain("-q");
      expect(spec.args?.[(spec.args ?? []).indexOf("--log-level") + 1]).toBe("NOTICE");
    }
  });

  test("network calls are bounded on top of the runner's deadlines", async () => {
    const { store, specs } = scripted(() => outcome(0, { stdout: "[]" }));
    value(await store.list(""));
    const spec = specs[0] as RunSpec;
    const args = spec.args ?? [];
    for (const flag of ["--contimeout", "--timeout", "--retries"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--retries") + 1]).toBe("1");
    // rclone's default of 10 low-level retries, each with the S3 SDK's backoff, keeps a cut link busy for many
    // minutes (Task 17, on T2): three give up within a minute.
    expect(args[args.indexOf("--low-level-retries") + 1]).toBe("3");
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

  test("a folder another writer made at the same moment is no failure: the write is tried once more", async () => {
    // Found on T2 (Task 17): two devices' first writes under one new folder; rclone's mkdir of the parent lost the
    // race and the SFTP server answered a bare SSH_FX_FAILURE.
    const race = recorded.fixtures.find((f) => f.name === "sftp mkdir race on move")?.stderr ?? "";
    for (const failing of ["rcat", "moveto"]) {
      let failed = false;
      const { store, specs } = scripted((spec) => {
        if (commandOf(spec) === failing && !failed) {
          failed = true;
          return outcome(1, { stderr: race });
        }
        return outcome(0);
      });
      value(await store.put("elect/002/candidates/a.json", new Uint8Array([1])));
      expect(specs.map(commandOf)).toEqual(
        failing === "rcat" ? ["rcat", "rcat", "moveto"] : ["rcat", "moveto", "moveto"],
      );
    }
    // Only once: a folder that cannot be made is the failure it is.
    const { store, specs } = scripted((spec) =>
      commandOf(spec) === "moveto" ? outcome(1, { stderr: race }) : outcome(0),
    );
    expect(await store.put("k/a", new Uint8Array([1]))).toMatchObject({
      ok: false,
      finding: { code: "store.failed" },
    });
    expect(specs.map(commandOf)).toEqual(["rcat", "moveto", "moveto", "deletefile"]);
  });

  test("through the system's ssh, rclone's notice that it validates no host key is left out: ssh does", async () => {
    const race = recorded.fixtures.find((f) => f.name === "sftp mkdir race on move")?.stderr ?? "";
    const { store } = scripted(() => outcome(1, { stderr: race }), {
      remote: { type: "sftp", root: "/data", options: { ssh: "/usr/bin/ssh nas", shell_type: "none" } },
    });
    const put = await store.put("k/a", new Uint8Array([1]));
    if (put.ok) throw new Error("the put should fail");
    expect(put.finding.message).not.toContain("No host key validation");
    expect(put.finding.message).toContain("SSH_FX_FAILURE");
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
      const { store, specs } = scripted(() => outcome(0), {
        remote: { type, root: "r", options: { known_hosts_file: "/k" } },
      });
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
    const claims =
      (patch: Partial<StoreSemantics>, options: Partial<RcloneBlobStoreOptions> = {}) =>
      () =>
        scripted(() => outcome(0), { semantics: { ...UNKNOWN_SEMANTICS, ...patch }, ...options });
    expect(claims({ conditionalCreate: { value: true, evidence: "measured" } })).toThrow(RangeError);
    expect(claims({ publication: { value: "atomic-put", evidence: "measured" } })).toThrow(RangeError);
    expect(claims({ publication: { value: "temp-then-rename", evidence: "measured" } })).not.toThrow();
    // Only the S3 route's direct put can carry If-None-Match (Task 17): a temp-then-rename put cannot.
    expect(
      claims({ conditionalCreate: { value: true, evidence: "measured" } }, { remote: S3_REMOTE }),
    ).not.toThrow();
    expect(
      claims(
        { conditionalCreate: { value: true, evidence: "measured" } },
        { remote: S3_REMOTE, publication: "temp-then-rename" },
      ),
    ).toThrow(RangeError);
  });

  test("create-only writes are not offered unless the profile claims them: asking for one is a bug", () => {
    const { store } = scripted(() => outcome(0));
    expect(() => store.put("k", new Uint8Array(), { ifNotExists: true })).toThrow();
    const s3 = scripted(() => outcome(0), { remote: S3_REMOTE });
    expect(() => s3.store.put("k", new Uint8Array(), { ifNotExists: true })).toThrow();
    const claimed = scripted(() => outcome(0), { remote: S3_REMOTE, semantics: CONDITIONAL });
    expect(() => claimed.store.put("k", new Uint8Array(), { ifMatch: "etag" })).toThrow();
  });
});

describe("conditional create on S3 (If-None-Match, Task 17)", () => {
  test("a create-only put sends If-None-Match: * on the direct upload; a plain put does not", async () => {
    const { store, specs } = scripted(() => outcome(0), { remote: S3_REMOTE, semantics: CONDITIONAL });
    expect(store.capabilities().createIfAbsent).toBe(true);
    value(await store.put("meta/v1/store.json", new TextEncoder().encode("x"), { ifNotExists: true }));
    value(await store.put("meta/v1/state.json", new TextEncoder().encode("y")));
    value(await store.put("meta/v1/empty", new Uint8Array(), { ifNotExists: true }));
    expect(specs.map(commandOf)).toEqual(["rcat", "rcat", "copyto"]);
    const header = ["--header-upload", "If-None-Match: *"];
    expect(specs[0]?.args).toEqual(expect.arrayContaining(header));
    expect((specs[0]?.args ?? []).at(-1)).toBe(`${RCLONE_REMOTE}:bucket/store/meta/v1/store.json`);
    expect(specs[1]?.args).not.toContain("--header-upload");
    expect(specs[2]?.args).toEqual(expect.arrayContaining(header));
  });

  test("a refused precondition (412) is store.key-exists; another failure stays what it is", async () => {
    const { store } = scripted(
      () =>
        outcome(1, {
          stderr: recorded.fixtures.find((f) => f.name === "s3 precondition failed")?.stderr ?? "",
        }),
      { remote: S3_REMOTE, semantics: CONDITIONAL },
    );
    const refused = await store.put("meta/v1/store.json", new Uint8Array([1]), { ifNotExists: true });
    expect(refused).toMatchObject({ ok: false, finding: { code: "store.key-exists" } });
    // Without the condition a 412 is not a refusal of create-only: it is the store failing.
    const plain = await store.put("meta/v1/store.json", new Uint8Array([1]));
    expect(plain).toMatchObject({ ok: false, finding: { code: "store.failed" } });
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

  test("a key that appears between the empty read and the stat is read again, never taken for empty", async () => {
    // Found on T2 (Task 17): an observer's cat ran before a slow upload landed and printed nothing, its stat ran after.
    let cats = 0;
    const { store } = scripted((spec) => {
      if (commandOf(spec) === "cat") return outcome(0, { stdout: cats++ === 0 ? "" : "whole" });
      return outcome(0, { stdout: JSON.stringify({ Path: "k", Name: "k", Size: 5, IsDir: false }) });
    });
    expect(new TextDecoder().decode(value(await store.get("k")) ?? new Uint8Array())).toBe("whole");
    expect(cats).toBe(2);
  });

  test("a key that keeps changing under the read is store.failed, never a wrong value", async () => {
    const { store } = scripted((spec) =>
      commandOf(spec) === "cat"
        ? outcome(0, { stdout: "" })
        : outcome(0, { stdout: JSON.stringify({ Path: "k", Name: "k", Size: 5, IsDir: false }) }),
    );
    expect(await store.get("k")).toMatchObject({ ok: false, finding: { code: "store.failed" } });
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

describe("review phase 4 (I2, I3, M1, M2, M6)", () => {
  test("an SFTP remote that checks no host key is refused before anything runs (I3)", async () => {
    const { store, specs } = scripted(() => outcome(0, { stdout: "[]" }), {
      remote: { type: "sftp", root: "plainport", options: { host: "nas.local", user: "me" } },
    });
    for (const result of [
      await store.get("a"),
      await store.list(""),
      await store.put("meta/v1/a.json", new Uint8Array([1])),
      await store.delete("a"),
    ]) {
      expect(result).toMatchObject({ ok: false, finding: { code: "store.failed" } });
      if (!result.ok) expect(result.finding.fix).toContain("known_hosts_file");
    }
    expect(specs).toEqual([]);
    // Either check is enough: the system's ssh, or rclone's own SSH with a known_hosts file.
    const checks: Record<string, string>[] = [
      { ssh: "/usr/bin/ssh nas" },
      { host: "nas.local", known_hosts_file: "/k" },
    ];
    for (const options of checks) {
      const checked = scripted(() => outcome(0, { stdout: "[]" }), {
        remote: { type: "sftp", root: "plainport", options },
      });
      value(await checked.store.list(""));
      expect(checked.specs).toHaveLength(1);
    }
  });

  test("what rclone says is redacted before it is cut down, so no slice of a secret survives the cut (M1)", async () => {
    const secret = crypto.randomUUID().replaceAll("-", "");
    // The 600-character cut keeps the secret's first 11 characters: a slice too short to be recognised afterwards.
    const line = `${"a".repeat(589)}${secret}`;
    const { store } = scripted(() => outcome(7, { stderr: `2026/10/29 17:30:53 ERROR : ${line}\n` }), {
      remote: {
        type: "s3",
        root: "bucket",
        options: { provider: "Other" },
        secrets: { secret_access_key: secret },
      },
    });
    const failed = await store.get("a");
    if (failed.ok) throw new Error("expected a failure");
    expect(failed.finding.message).not.toContain(secret.slice(0, 11));
    expect(failed.finding.message).toContain("[redacted]");
  });

  test("a create-only put is single-part: it pins the upload cutoff and refuses a value that would go multipart (M2)", async () => {
    const { store, specs } = scripted(() => outcome(0), { remote: S3_REMOTE, semantics: CONDITIONAL });
    value(
      await store.put("meta/v1/store.json", new Uint8Array(CONDITIONAL_MAX_BYTES - 1), { ifNotExists: true }),
    );
    const args = specs[0]?.args ?? [];
    expect(args[args.indexOf("--s3-upload-cutoff") + 1]).toBe("16Mi");
    expect(() =>
      store.put("meta/v1/store.json", new Uint8Array(CONDITIONAL_MAX_BYTES), { ifNotExists: true }),
    ).toThrow(RangeError);
    // A plain put of any size is not limited.
    value(await store.put("meta/v1/big", new Uint8Array(CONDITIONAL_MAX_BYTES)));
    expect(specs).toHaveLength(2);
  });

  test("one call's runs share one overall deadline, and a cancelled call starts nothing more (M6)", async () => {
    let clock = 1_000_000;
    const { store, specs } = scripted(
      () => {
        clock += 60;
        return outcome(0);
      },
      { callTimeoutMs: 100 },
      () => new Date(clock),
    );
    // An SFTP put: the upload takes 60 ms of the 100, the move gets the rest, the clean-up nothing.
    const put = await store.put("meta/v1/a.json", new Uint8Array([1]));
    expect(put.ok).toBe(true);
    expect(specs.map((spec) => spec.timeoutMs)).toEqual([100, 40]);
    clock += 1;
    specs.length = 0;
    const slow = scripted(
      () => {
        clock += 120;
        return outcome(0);
      },
      { callTimeoutMs: 100 },
      () => new Date(clock),
    );
    const late = await slow.store.put("meta/v1/b.json", new Uint8Array([1]));
    expect(late).toMatchObject({ ok: false, finding: { code: "process.timeout" } });
    expect(slow.specs.map(commandOf)).toEqual(["rcat"]);

    const controller = new AbortController();
    const cancellable = scripted(() => outcome(0, { stdout: "[]" }), { signal: controller.signal });
    value(await cancellable.store.list(""));
    expect(cancellable.specs[0]?.signal).toBe(controller.signal);
    controller.abort();
    expect(await cancellable.store.list("")).toMatchObject({
      ok: false,
      finding: { code: "process.cancelled" },
    });
    expect(cancellable.specs).toHaveLength(1);
  });

  test("a call's own signal reaches its run, beside the store's, so a caller's deadline stops the process group (review phase 5 M1)", async () => {
    const store_ = new AbortController();
    const { store, specs } = scripted(() => outcome(0, { stdout: "[]" }), { signal: store_.signal });
    const call = new AbortController();
    value(await store.list("", { signal: call.signal }));
    const given = specs[0]?.signal as AbortSignal;
    expect(given.aborted).toBe(false);
    call.abort();
    expect(given.aborted).toBe(true);
    // The store's own signal still counts for a call that brings one.
    const other = new AbortController();
    value(await store.getMany(["meta/v1/a.json"], { signal: other.signal }));
    const batch = specs.at(-1)?.signal as AbortSignal;
    store_.abort();
    expect(batch.aborted).toBe(true);
    // An aborted call starts nothing.
    const before = specs.length;
    expect(await store.list("", { signal: call.signal })).toMatchObject({
      ok: false,
      finding: { code: "process.cancelled" },
    });
    expect(specs).toHaveLength(before);
  });

  test("a store whose root folder is not there is store.unreachable, never an empty store (M3)", async () => {
    const missing = () => outcome(3, { stderr: "ERROR : error listing: directory not found\n" });
    const { store } = scripted(missing);
    for (const result of [
      await store.get("meta/v1/store.json"),
      await store.stat("meta/v1/store.json"),
      await store.list("meta/v1/events/"),
      await store.list(""),
      await store.getMany(["meta/v1/store.json"]),
    ]) {
      expect(result).toMatchObject({ ok: false, finding: { code: "store.unreachable" } });
      if (!result.ok) expect(result.finding.message).toContain("is not there");
    }
    // A file not found (4) is a missing key with no look at the root; on S3 a prefix is no folder to look at.
    const file = scripted(() => outcome(4, { stderr: "ERROR : object not found\n" }));
    expect(value(await file.store.get("meta/v1/store.json"))).toBeNull();
    expect(file.specs.some(isRootStat)).toBe(false);
    const s3 = scripted(missing, { remote: S3_REMOTE });
    expect(value(await s3.store.list("meta/v1/events/"))).toEqual([]);
    expect(s3.specs).toHaveLength(1);
  });

  test("the sweep never deletes a temporary younger than one call's deadline plus clock skew (I2)", async () => {
    const written = Date.now();
    const temp = `put-${ulid(written)}`;
    const listing = () => outcome(0, { stdout: JSON.stringify([{ Path: temp, Size: 1, IsDir: false }]) });
    // The sweeping device's clock runs two hours ahead of the writer's.
    const ahead = scripted(listing, {}, () => new Date(written + 2 * 60 * 60 * 1000));
    expect(ahead.store.minSweepAgeMs).toBe(30 * 60 * 1000 + SWEEP_SKEW_MS);
    expect(() => ahead.store.sweepTemporaries(60 * 60 * 1000)).toThrow(RangeError);
    expect(() => ahead.store.sweepTemporaries(0)).toThrow(RangeError);
    expect(value(await ahead.store.sweepTemporaries(ahead.store.minSweepAgeMs)).swept).toEqual([]);
    expect(ahead.specs.map(commandOf)).toEqual(["lsjson"]);
    // Older than the floor by the writer's own clock: swept.
    const old = scripted(listing, {}, () => new Date(written + SWEEP_SKEW_MS + 31 * 60 * 1000));
    expect(value(await old.store.sweepTemporaries(old.store.minSweepAgeMs)).swept).toEqual([
      `${TEMP_PREFIX}${temp}`,
    ]);
  });
});
