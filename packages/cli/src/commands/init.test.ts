import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { nodeLocalIo } from "@plainport/core";
import { makeSandbox, type Sandbox } from "../../../core/src/testing/sandbox.ts";
import type { Prompter } from "../prompt.ts";
import { capture, fakeRepositoryAt, sandboxPorts } from "../testing.ts";
import { REGISTRY } from "./index.ts";

let box: Sandbox;

beforeEach(() => {
  box = makeSandbox("plainport-init-");
});
afterEach(() => box.cleanup());

type Call = { kind: "multiselect" | "text"; message: string; options?: string[] };

/** A prompter that records every prompt and answers from a script; it fails the test when it runs out. */
const scripted = (answers: (string[] | string | undefined)[]): { prompt: Prompter; calls: Call[] } => {
  const calls: Call[] = [];
  const next = () => {
    if (answers.length === 0) throw new Error(`unexpected prompt after ${JSON.stringify(calls)}`);
    return answers.shift();
  };
  return {
    calls,
    prompt: {
      multiselect: async (req) => {
        calls.push({ kind: "multiselect", message: req.message, options: req.options.map((o) => o.value) });
        return next() as string[] | undefined;
      },
      text: async (req) => {
        calls.push({ kind: "text", message: req.message });
        const answer = next() as string | undefined;
        const problem = answer === undefined ? undefined : req.validate?.(answer);
        if (problem !== undefined) throw new Error(`answer ${answer} refused: ${problem}`);
        return answer;
      },
    },
  };
};

const init = (argv: string[], options: { isTTY?: boolean; prompt?: Prompter } = {}) =>
  capture(["init", ...argv], REGISTRY, {
    isTTY: options.isTTY ?? false,
    ports: sandboxPorts(box.home, options.prompt === undefined ? {} : { prompt: options.prompt }),
  });

const managed = (): Record<string, unknown> =>
  Bun.TOML.parse(readFileSync(box.paths.managedFile, "utf8")) as Record<string, unknown>;
const device = (): Record<string, unknown> => JSON.parse(readFileSync(box.paths.deviceFile, "utf8"));
const envelope = (out: string) => JSON.parse(out.trim().split("\n").at(-1) as string);

describe("init: from flags", () => {
  test("is confirm-class: without --yes it exits 3 and writes nothing", async () => {
    box.dir("work");
    const run = await init(["--root", "work=~/work", "--store-path", "~/Archive"]);
    expect(run.code).toBe(3);
    expect(run.err).toContain("re-run: plainport init --root 'work=~/work' --store-path '~/Archive' --yes");
    expect(existsSync(box.paths.deviceFile)).toBe(false);
    expect(existsSync(box.paths.managedFile)).toBe(false);
  });

  test("--root, --store-path and --device do the whole setup without a prompt", async () => {
    box.repo("work/clients/acme/web");
    box.dir("personal");
    const { prompt, calls } = scripted([]);
    const run = await init(
      [
        "--root",
        "work=~/work",
        "--root",
        `personal=${join(box.home, "personal")}`,
        "--store-path",
        "/Volumes/Archive/plainport",
        "--device",
        "mbp",
        "--yes",
        "--json",
      ],
      { prompt },
    );
    expect(run.err).toBe("");
    expect(run.code).toBe(0);
    expect(calls).toEqual([]);
    const data = envelope(run.out).data;
    expect(data).toMatchObject({
      device: { name: "mbp", role: "owner", created: true },
      roots: [
        { key: "work", path: join(box.home, "work") },
        { key: "personal", path: join(box.home, "personal") },
      ],
      store: { name: "local", path: "/Volumes/Archive/plainport" },
    });
    expect(device()).toMatchObject({ v: 1, name: "mbp", role: "owner" });
    expect(managed()).toEqual({
      defaultStore: "local",
      stores: { local: { kind: "local", path: "/Volumes/Archive/plainport" } },
      roots: {
        work: { store: "local", on: { mbp: "~/work" } },
        personal: { store: "local", on: { mbp: "~/personal" } },
      },
    });
  });

  test("the global --store names the store; the device name defaults to the host name", async () => {
    box.dir("work");
    const run = await init([
      "--root",
      "work=~/work",
      "--store-path",
      "~/Archive",
      "--store",
      "ssd",
      "--yes",
      "--json",
    ]);
    expect(run.code).toBe(0);
    expect(managed()).toMatchObject({
      defaultStore: "ssd",
      stores: { ssd: { kind: "local", path: "~/Archive" } },
    });
    expect(device().name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  test("an overlapping --root is refused with root.overlap; nothing is written", async () => {
    box.dir("work/personal");
    const run = await init([
      "--root",
      "work=~/work",
      "--root",
      "personal=~/work/personal",
      "--store-path",
      "~/A",
      "--yes",
      "--json",
    ]);
    expect(run.code).toBe(6);
    expect(envelope(run.out).error.finding.code).toBe("root.overlap");
    expect(existsSync(box.paths.managedFile)).toBe(false);
    expect(existsSync(box.paths.deviceFile)).toBe(false);
  });

  test("a malformed --root is a usage error naming the form", async () => {
    const run = await init(["--root", "work", "--store-path", "~/A", "--yes"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("usage.invalid");
    expect(run.err).toContain("<key>=<path>");
  });

  test("a second init keeps the device and needs no flags once roots and a store exist", async () => {
    box.dir("work");
    expect(
      (await init(["--root", "work=~/work", "--store-path", "~/A", "--device", "mbp", "--yes"])).code,
    ).toBe(0);
    const id = device().id;
    const again = await init(["--yes", "--json"]);
    expect(again.code).toBe(0);
    expect(envelope(again.out).data.device).toMatchObject({ id, name: "mbp", created: false });
    const human = await init(["--yes"]);
    expect(human.code).toBe(0);
    expect(human.out).toContain("nothing changed");
    expect(human.out).not.toContain("settings written");
  });

  test("a device.json that cannot be created leaves no bindings behind", async () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    box.dir("work");
    const state = box.dir(".local/state/plainport");
    chmodSync(state, 0o555);
    const argv = ["--root", "work=~/work", "--store-path", "~/A", "--device", "mbp", "--yes", "--json"];
    let run: Awaited<ReturnType<typeof init>>;
    try {
      run = await init(argv);
    } finally {
      chmodSync(state, 0o755);
    }
    expect(run.code).toBe(1);
    expect(envelope(run.out).error.finding.code).toBe("config.write-failed");
    expect(existsSync(box.paths.managedFile)).toBe(false);
  });

  test("--device cannot rename an existing device", async () => {
    box.dir("work");
    expect(
      (await init(["--root", "work=~/work", "--store-path", "~/A", "--device", "mbp", "--yes"])).code,
    ).toBe(0);
    const run = await init(["--device", "other", "--yes"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("mbp");
    expect(device().name).toBe("mbp");
  });
});

describe("init: device names from awkward host names", () => {
  for (const [host, expected] of [
    ["b315d8b14", "b315d8b14"],
    ["223b315d8b14", "host-223b315d8b14"],
    ["12345", "host-12345"],
    ["dev-box.lan.example.com", "dev-box"],
    ["___", "this-device"],
  ] as const) {
    test(`host name ${host} gives device ${expected} and a managed.toml every TOML reader accepts`, async () => {
      box.dir("work");
      const io = { ...nodeLocalIo, proc: { ...nodeLocalIo.proc, hostname: () => host } };
      const run = await capture(["init", "--root", "work=~/work", "--store-path", "~/A", "--yes"], REGISTRY, {
        ports: sandboxPorts(box.home, { io }),
      });
      expect(run.err).toBe("");
      expect(run.code).toBe(0);
      expect(device().name).toBe(expected);
      const text = readFileSync(box.paths.managedFile, "utf8");
      expect(Bun.TOML.parse(text)).toMatchObject({ roots: { work: { on: { [expected]: "~/work" } } } });
    });
  }

  test("a --device that is not a valid name is refused with the --device <name> fix", async () => {
    box.dir("work");
    const run = await init(["--root", "work=~/work", "--store-path", "~/A", "--device", "1mac", "--yes"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("--device <name>");
    expect(existsSync(box.paths.managedFile)).toBe(false);
  });
});

describe("init: no TTY", () => {
  test("never prompts: missing roots and store exit 2 with the exact flags, built from the scan", async () => {
    box.repo("work/web");
    box.repo("Projects/x");
    const { prompt, calls } = scripted([]);
    const run = await init(["--yes", "--json"], { prompt });
    expect(calls).toEqual([]);
    expect(run.code).toBe(2);
    const error = envelope(run.out).error;
    expect(error.finding.code).toBe("usage.invalid");
    expect(error.hint).toBe(
      "plainport init --root work=~/work --root projects=~/Projects --store-path <path> --yes",
    );
    expect(existsSync(box.paths.managedFile)).toBe(false);
  });

  test("a likely folder that is a file or a symlink loop is noted, not a crash", async () => {
    box.file("code", "not a folder");
    symlinkSync(join(box.home, "work"), join(box.home, "work"));
    const run = await init(["--yes"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("usage.invalid");
    expect(run.err).toContain(`skipped ${join(box.home, "code")}`);
  });

  test("with nothing to suggest, the fix shows the flag forms", async () => {
    const run = await init(["--yes"]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("fix: plainport init --root <key>=<path> --store-path <path> --yes");
  });

  test("--no-input on a TTY never prompts either", async () => {
    box.repo("work/web");
    const { prompt, calls } = scripted([]);
    const run = await init(["--yes", "--no-input"], { isTTY: true, prompt });
    expect(calls).toEqual([]);
    expect(run.code).toBe(2);
  });
});

describe("init: interactive scan (TTY, injected prompter)", () => {
  test("offers the likely folders that hold projects; the picks become named roots", async () => {
    box.repo("work/a");
    box.repo("work/b");
    box.repo("code/c");
    box.dir("Developer"); // no projects: not offered
    const { prompt, calls } = scripted([
      [join(box.home, "work"), join(box.home, "code")],
      "work",
      "hack",
      "~/Archive",
      "mbp",
    ]);
    const run = await init(["--yes"], { isTTY: true, prompt });
    expect(run.err).not.toContain("plainport: ");
    expect(run.code).toBe(0);
    expect(calls[0]).toMatchObject({
      kind: "multiselect",
      options: [join(box.home, "work"), join(box.home, "code")],
    });
    expect(calls.slice(1).map((c) => c.kind)).toEqual(["text", "text", "text", "text"]);
    expect(managed()).toMatchObject({
      defaultStore: "local",
      roots: { work: { on: { mbp: "~/work" } }, hack: { on: { mbp: "~/code" } } },
    });
    expect(device().name).toBe("mbp");
  });

  test("--root on a TTY skips the scan; only missing answers are asked", async () => {
    box.dir("work");
    const { prompt, calls } = scripted(["~/Archive"]);
    const run = await init(["--root", "work=~/work", "--device", "mbp", "--yes"], { isTTY: true, prompt });
    expect(run.code).toBe(0);
    expect(calls).toEqual([expect.objectContaining({ kind: "text" })]);
  });

  test("picking no folder is refused with the flags to pass instead; nothing is written", async () => {
    box.repo("work/a");
    const { prompt } = scripted([[]]);
    const run = await init(["--yes", "--json"], { isTTY: true, prompt });
    expect(run.code).toBe(2);
    const error = envelope(run.out).error;
    expect(error.finding.code).toBe("usage.invalid");
    expect(error.hint).toContain("--root <key>=<path>");
    expect(existsSync(box.paths.managedFile)).toBe(false);
    expect(existsSync(box.paths.deviceFile)).toBe(false);
  });

  test("cancelling a prompt exits 130 and writes nothing", async () => {
    box.repo("work/a");
    const { prompt } = scripted([undefined]);
    const run = await init(["--yes"], { isTTY: true, prompt });
    expect(run.code).toBe(130);
    expect(run.err).toContain("command.cancelled");
    expect(existsSync(box.paths.managedFile)).toBe(false);
    expect(existsSync(box.paths.deviceFile)).toBe(false);
  });
});

describe("init: setting the store up (D45)", () => {
  const storeJson = (path: string) => JSON.parse(readFileSync(join(path, "meta/v1/store.json"), "utf8"));
  const registry = () => JSON.parse(readFileSync(box.paths.registryFile, "utf8"));

  test("creates the store's identity and repository and records its id; a second run changes nothing", async () => {
    box.dir("work");
    const run = await init([
      "--root",
      "work=~/work",
      "--store-path",
      "~/ssd",
      "--device",
      "mbp",
      "--yes",
      "--json",
    ]);
    expect(run.code).toBe(0);
    const ssd = join(box.home, "ssd");
    const { id } = storeJson(ssd);
    expect(envelope(run.out).data).toMatchObject({ store: { name: "local", path: ssd, id }, changed: true });
    expect(registry().stores).toEqual({ local: id });
    expect(fakeRepositoryAt(ssd).initialized).toBe(true);

    const again = await init(["--yes", "--json"]);
    expect(again.code).toBe(0);
    expect(envelope(again.out).data).toMatchObject({ store: { name: "local", id }, changed: false });
    expect(storeJson(ssd).id).toBe(id);
  });

  test("a store whose disk is not mounted stays recorded, with store.setup-pending; nothing is created there", async () => {
    box.dir("work");
    const missing = join(box.home, "Volumes/Archive/plainport");
    const run = await init([
      "--root",
      "work=~/work",
      "--store-path",
      missing,
      "--device",
      "mbp",
      "--yes",
      "--json",
    ]);
    expect(run.code).toBe(0);
    const data = envelope(run.out).data;
    expect(data.findings).toEqual([
      expect.objectContaining({ code: "store.setup-pending", severity: "warn" }),
    ]);
    expect(data.findings[0].fix).toBe("plainport init --yes once the store is reachable");
    expect(existsSync(join(box.home, "Volumes"))).toBe(false);
    expect(managed()).toMatchObject({ stores: { local: { kind: "local" } } });

    box.dir("Volumes/Archive");
    const later = await init(["--yes", "--json"]);
    expect(later.code).toBe(0);
    expect(envelope(later.out).data).toMatchObject({ store: { name: "local", path: missing }, findings: [] });
    expect(registry().stores.local).toBe(storeJson(missing).id);
  });

  test("--store-secret names where the password is (file:), and is written as that reference", async () => {
    box.dir("work");
    box.file("secrets/ssd.key", "from-a-file\n");
    const run = await init([
      "--root",
      "work=~/work",
      "--store-path",
      "~/ssd",
      "--store-secret",
      "file:~/secrets/ssd.key",
      "--device",
      "mbp",
      "--yes",
    ]);
    expect(run.code).toBe(0);
    expect(managed()).toMatchObject({ stores: { local: { secret: "file:~/secrets/ssd.key" } } });
    expect(readFileSync(box.paths.managedFile, "utf8")).not.toContain("from-a-file");
  });

  test("a password that is not there refuses with store.secret-missing (exit 6), naming the variable", async () => {
    box.dir("work");
    const run = await capture(
      ["init", "--root", "work=~/work", "--store-path", "~/ssd", "--device", "mbp", "--yes", "--json"],
      REGISTRY,
      {
        ports: sandboxPorts(box.home, { env: { HOME: box.home, PATH: process.env.PATH ?? "/usr/bin:/bin" } }),
      },
    );
    expect(run.code).toBe(6);
    expect(envelope(run.out).error).toMatchObject({
      finding: { code: "store.secret-missing" },
      message: expect.stringContaining("PLAINPORT_STORE_PASSWORD is not set"),
    });
  });

  test("--store-secret must be a reference, never the password itself", async () => {
    box.dir("work");
    const run = await init([
      "--root",
      "work=~/work",
      "--store-path",
      "~/ssd",
      "--store-secret",
      "hunter2",
      "--yes",
    ]);
    expect(run.code).toBe(2);
    expect(run.err).toContain("usage.invalid");
    expect(existsSync(box.paths.managedFile)).toBe(false);
  });
});
