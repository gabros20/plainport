import { beforeEach, describe, expect, test } from "bun:test";
import { parseJsonLines } from "@plainport/contract";
import { capture, seen } from "./testing.ts";

beforeEach(() => {
  seen.length = 0;
});

const envelopeOf = (out: string) => {
  const parsed = parseJsonLines(out);
  if (!parsed.ok) throw new Error(parsed.finding.message);
  return parsed.value.envelope;
};

describe("risk gate (ADR-0007, D15)", () => {
  test("confirm without --yes exits 3, runs nothing and prints the exact re-run", async () => {
    const run = await capture(["ship", "my project", "web"]);
    expect(run.code).toBe(3);
    expect(run.out).toBe("");
    expect(run.err).toBe(
      "plainport: ship is confirm-class: it sends data off this machine or deletes it, so it needs --yes\n" +
        "re-run: plainport ship 'my project' web --yes\n",
    );
    expect(seen).toEqual([]);
  });

  test("under --json the refusal is one envelope whose hint is the re-run line", async () => {
    const run = await capture(["ship", "web", "--json"]);
    expect(run.code).toBe(3);
    expect(run.err).toBe("");
    expect(JSON.parse(run.out)).toEqual({
      plainport_json: 1,
      ok: false,
      verb: "ship",
      error: {
        code: 3,
        message: "ship is confirm-class: it sends data off this machine or deletes it, so it needs --yes",
        hint: "re-run: plainport ship web --json --yes",
      },
    });
  });

  test("the re-run puts --yes before --", async () => {
    const run = await capture(["ship", "--", "-odd"]);
    expect(run.code).toBe(3);
    expect(run.err).toContain("re-run: plainport ship --yes -- -odd\n");
  });

  test("confirm with --yes runs", async () => {
    const run = await capture(["ship", "web", "--yes"]);
    expect(run.code).toBe(0);
    expect(run.out).toBe("done: ship web\n");
    expect(seen[0]?.ctx.risk).toBe("confirm");
  });

  test("confirm with an approved --plan runs without --yes", async () => {
    const run = await capture(["ship", "web", "--plan", "01J9Z6KB"]);
    expect(run.code).toBe(0);
  });

  test("--dry-run runs as read and needs no --yes", async () => {
    const run = await capture(["ship", "web", "--dry-run"]);
    expect(run.code).toBe(0);
    expect(run.out).toBe("done: ship web (dry run)\n");
    expect(seen[0]?.ctx.risk).toBe("read");
    expect(seen[0]?.ctx.dryRun).toBe(true);
  });

  test("--dry-run on a command without a preview exits 2 before running (D18)", async () => {
    const run = await capture(["write", "web", "--dry-run"]);
    expect(run.code).toBe(2);
    expect(seen).toEqual([]);
    expect(run.err).toBe(
      "plainport: write has no --dry-run preview\n" +
        "fix: without --dry-run it changes files straight away; see what it does first: plainport help write\n",
    );
  });

  test("an option can raise the risk class: write --adopt is confirm", async () => {
    expect((await capture(["write", "web"])).code).toBe(0);
    const run = await capture(["write", "web", "--adopt"]);
    expect(run.code).toBe(3);
    expect(run.err).toContain("re-run: plainport write web --adopt --yes\n");
    expect((await capture(["write", "web", "--adopt", "--yes"])).code).toBe(0);
  });

  test("read and safe_write run freely", async () => {
    expect((await capture(["show"])).code).toBe(0);
    expect((await capture(["root", "add", "work"])).out).toBe("done: root add work\n");
  });
});

describe("unknown commands and usage errors", () => {
  test("an unregistered command exits 4 with a did-you-mean", async () => {
    const run = await capture(["shp", "web", "--yes"]);
    expect(run.code).toBe(4);
    expect(run.err).toBe(
      "plainport: unknown command: shp (did you mean ship?)\nfix: plainport ship web --yes\n",
    );
  });

  test("a misspelled second word of a multi-word command is suggested too", async () => {
    const run = await capture(["root", "ad", "work", "--json"]);
    expect(run.code).toBe(4);
    const envelope = envelopeOf(run.out);
    expect(envelope).toMatchObject({
      ok: false,
      verb: "root ad",
      error: { code: 4, hint: "plainport root add work --json" },
    });
  });

  test("an unregistered command with nothing close points at help", async () => {
    const run = await capture(["zzzzzz"]);
    expect(run.code).toBe(4);
    expect(run.err).toBe("plainport: unknown command: zzzzzz\nfix: plainport help\n");
  });

  test("help for an unknown command exits 4 too", async () => {
    const run = await capture(["help", "shp"]);
    expect(run.code).toBe(4);
    expect(run.err).toContain("fix: plainport help ship\n");
  });

  test("an unknown option exits 2 and points at the command's help", async () => {
    const run = await capture(["show", "--frobnicate"]);
    expect(run.code).toBe(2);
    expect(run.err).toStartWith("plainport: ");
    expect(run.err).toContain("--frobnicate");
    expect(run.err).toEndWith("fix: plainport help show\n");
  });

  test("a missing required argument exits 2", async () => {
    const run = await capture(["write", "--json"]);
    expect(run.code).toBe(2);
    expect(envelopeOf(run.out)).toMatchObject({ ok: false, verb: "write", error: { code: 2 } });
  });

  test("too many positionals exit 2", async () => {
    expect((await capture(["show", "a", "b"])).code).toBe(2);
  });

  test("--quiet with --verbose is a usage error", async () => {
    expect((await capture(["show", "--quiet", "--verbose"])).code).toBe(2);
  });

  test("a usage error is checked before the risk gate", async () => {
    expect((await capture(["ship"])).code).toBe(2);
  });
});

describe("global flags", () => {
  test("global flags may come before the command", async () => {
    const run = await capture(["--store", "mini", "--config", "/x/c.toml", "show", "web"]);
    expect(run.code).toBe(0);
    expect(seen[0]?.ctx.store).toBe("mini");
    expect(seen[0]?.ctx.config).toBe("/x/c.toml");
    expect(seen[0]?.args).toEqual({ project: "web" });
  });

  test("without a TTY --no-input is implied; with one, input is allowed unless --no-input", async () => {
    await capture(["show"], undefined, { isTTY: false });
    await capture(["show"], undefined, { isTTY: true });
    await capture(["show", "--no-input"], undefined, { isTTY: true });
    expect(seen.map((s) => s.ctx.input)).toEqual([false, true, false]);
  });

  test("a string option keeps its value; boolean options are flags", async () => {
    await capture(["write", "web", "--to", "/tmp/x"]);
    expect(seen[0]?.args).toEqual({ project: "web", to: "/tmp/x" });
  });
});
