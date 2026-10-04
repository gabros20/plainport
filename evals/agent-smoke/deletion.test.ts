import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { observeOffloadDeletion, waitForDeletion } from "./deletion.ts";
import { sandboxEnv } from "./sandbox.ts";
import { scoreTranscript } from "./scorer.ts";

const paths = ["/sandbox/trash", "/sandbox/trash.claim", "/sandbox/journal/op.json"];

test("deletion polling observes trash, claim and journal until all are gone", async () => {
  let poll = 0;
  const seen: string[] = [];
  expect(
    await waitForDeletion(paths, {
      exists: (path) => {
        seen.push(path);
        return paths.indexOf(path) >= poll;
      },
      now: () => poll,
      nextPoll: async () => {
        poll++;
      },
      timeoutMs: 10,
    }),
  ).toEqual([]);
  expect(poll).toBe(3);
  expect(seen).toEqual([...paths, ...paths, ...paths, ...paths]);
});

test("deletion polling fails at its deadline and on cancellation", async () => {
  let time = 0;
  const stalled = await waitForDeletion(paths, {
    exists: (path) => path === paths[2],
    now: () => time,
    nextPoll: async () => {
      time++;
    },
    timeoutMs: 2,
  });
  expect(time).toBe(2);
  expect(stalled.join(" ")).toContain(paths[2] as string);
  const abort = new AbortController();
  abort.abort();
  expect((await waitForDeletion(paths, { signal: abort.signal })).join(" ")).toContain("cancelled");
});

test("deletion polling reads the filesystem and completes immediately when already gone", async () => {
  const area = mkdtempSync(join(tmpdir(), "plainport-eval-delete-"));
  const files = paths.map((path) => join(area, path));
  try {
    for (const path of files) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "kept");
    }
    let poll = 0;
    expect(
      await waitForDeletion(files, {
        nextPoll: async () => {
          rmSync(files[poll++] as string);
        },
      }),
    ).toEqual([]);
    expect(poll).toBe(3);
    expect(
      await waitForDeletion(files, {
        nextPoll: async () => {
          throw new Error("No wait needed");
        },
      }),
    ).toEqual([]);
  } finally {
    rmSync(area, { recursive: true, force: true });
  }
});

test("recorder waits on the exact sandbox offload trash, claim and journal", async () => {
  const area = "/tmp/plainport-eval";
  const env = sandboxEnv(area, "/usr/bin", "/tmp/tools");
  const op = "01JZZZZZZZZZZZZZZZZZZZZZZZ";
  const trash = join(area, "work/.plainport-trash", op);
  const expected = [trash, `${trash}.claim`, join(area, "home/.local/state/plainport/journal", `${op}.json`)];
  const stdout = JSON.stringify({
    plainport_json: 1,
    ok: true,
    verb: "offload",
    data: { op, trash, project: "work:fixture" },
  });
  const argv = ["offload", "work:fixture", "--json", "--yes"];
  let poll = 0;
  const seen: string[] = [];
  expect(
    await observeOffloadDeletion(area, env, argv, 0, stdout, {
      exists: (path) => {
        seen.push(path);
        return poll === 0;
      },
      nextPoll: async () => {
        poll++;
      },
    }),
  ).toEqual([]);
  expect(seen).toEqual([...expected, ...expected]);
  expect(poll).toBe(1);
  for (const args of [
    [...argv, "--dry-run"],
    ["onload", "work:fixture", "--json"],
  ]) {
    expect(
      await observeOffloadDeletion(area, env, args, 0, stdout, {
        exists: () => {
          throw new Error("Must not inspect a non-release call");
        },
      }),
    ).toEqual([]);
  }
  expect(await observeOffloadDeletion(area, env, argv, 3, stdout)).toEqual([]);
  for (const data of [{}, { op, trash: "/outside", project: "work:fixture" }]) {
    expect(
      (
        await observeOffloadDeletion(
          area,
          env,
          argv,
          0,
          JSON.stringify({ plainport_json: 1, ok: true, verb: "offload", data }),
        )
      ).length,
    ).toBeGreaterThan(0);
  }
});

test("a deletion observation failure is recorded and prevents a round trip passing", async () => {
  const issues = await waitForDeletion(paths, {
    exists: () => {
      throw new Error("permission denied");
    },
  });
  expect(issues[0]).toContain("could not be observed");
  const transcript = JSON.parse(readFileSync(new URL("transcripts/pass.json", import.meta.url), "utf8"));
  transcript.calls[2].issues = issues;
  expect(scoreTranscript(transcript).passed).toBe(false);
  expect(scoreTranscript(transcript).contractIssues[0]?.code).toBe("call.evidence-incomplete");
});

test("recorder observes offload after leading global flags", async () => {
  const area = "/tmp/plainport-eval";
  const env = sandboxEnv(area, "/usr/bin", "/tmp/tools");
  const op = "01JZZZZZZZZZZZZZZZZZZZZZZZ";
  const trash = join(area, "work/.plainport-trash", op);
  const seen: string[] = [];
  expect(
    await observeOffloadDeletion(
      area,
      env,
      ["--config", "onload", "--json", "offload", "work:fixture", "--yes"],
      0,
      JSON.stringify({
        plainport_json: 1,
        ok: true,
        verb: "offload",
        data: { op, trash, project: "work:fixture" },
      }),
      {
        exists: (path) => {
          seen.push(path);
          return false;
        },
      },
    ),
  ).toEqual([]);
  expect(seen).toEqual([
    trash,
    `${trash}.claim`,
    join(area, "home/.local/state/plainport/journal", `${op}.json`),
  ]);
});
