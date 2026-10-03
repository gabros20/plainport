// Test helpers: the recorded restic fixtures (fixtures/restic/<version>/, written by
// scripts/record-restic-fixtures.ts) and a host whose run() replays them in order, so the engine's argument building,
// JSON-lines parsing and exit-code mapping are tested without a restic binary. Only tests import it.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type Failure, ok } from "@plainport/contract";
import type { HostPorts, RunSpec } from "@plainport/core";
import lock from "../../../tools.lock.json" with { type: "json" };

export const PINNED_VERSION = lock.tools.restic.version;
export const FIXTURES = resolve(import.meta.dir, "../../../fixtures/restic");
/** What scripts/record-restic-fixtures.ts put in place of its temp folder, and its password and project. */
export const FIXTURE_ROOT = "/tmp/restic-fixture";
export const FIXTURE_PASSWORD = "fixture-password";
export const FIXTURE_PROJECT = "01K6ZB7Q3M8XWJ5N2T4R6Y8VCD";

export interface Fixture {
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export const fixture = (name: string, version = PINNED_VERSION): Fixture =>
  JSON.parse(readFileSync(join(FIXTURES, version, `${name}.json`), "utf8")) as Fixture;

export const fixtureNames = (version = PINNED_VERSION): string[] =>
  readdirSync(join(FIXTURES, version))
    .filter((name) => name.endsWith(".json"))
    .map((name) => basename(name, ".json"));

const lines = (text: string): string[] => {
  const all = text.split("\n");
  if (all.at(-1) === "") all.pop();
  return all;
};

/**
 * A host whose run() answers each call with the next queued fixture (or runner failure), feeding its lines to
 * onLine and stderr lines to the log sink as the runner would. Every spec it saw is in `calls`.
 */
export const replayHost = (
  queue: (Fixture | Failure)[],
): Pick<HostPorts, "run"> & { calls: RunSpec[]; remaining(): number } => {
  const calls: RunSpec[] = [];
  return {
    calls,
    remaining: () => queue.length,
    run: async (spec) => {
      calls.push(spec);
      const next = queue.shift();
      if (next === undefined) throw new Error(`replayHost: no fixture left for ${spec.args?.join(" ")}`);
      if ("ok" in next) return next;
      const label = basename(spec.command);
      for (const [stream, text] of [
        ["stdout", next.stdout],
        ["stderr", next.stderr],
      ] as const) {
        for (const line of lines(text)) {
          spec.onLine?.({ stream, text: line, truncated: false });
          if (spec.log !== undefined && (spec.log.streams ?? ["stdout", "stderr"]).includes(stream) && line)
            spec.log.emit({
              type: "log",
              op: spec.log.op,
              level: stream === "stdout" ? "debug" : "info",
              message: `${label}: ${line}`,
            });
        }
      }
      return ok({
        exitCode: next.exitCode,
        signal: null,
        stdout: { text: next.stdout, droppedBytes: 0 },
        stderr: { text: next.stderr, droppedBytes: 0 },
        ...(spec.capture === undefined ? {} : { captured: new TextEncoder().encode(next.stdout) }),
        leftoversStopped: false,
        durationMs: 1,
      });
    },
  };
};

/** A fixture with some of its fields replaced. */
export const edited = (base: Fixture, change: Partial<Fixture>): Fixture => ({ ...base, ...change });

/** The JSON lines of a fixture's stdout. */
export const stdoutLines = (recorded: Fixture): Record<string, unknown>[] =>
  lines(recorded.stdout)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

type SummaryCounter =
  | "files_new"
  | "files_changed"
  | "files_unmodified"
  | "dirs_new"
  | "dirs_changed"
  | "dirs_unmodified"
  | "data_added"
  | "total_files_processed"
  | "total_bytes_processed"
  | "total_files"
  | "files_restored"
  | "files_skipped"
  | "files_deleted"
  | "total_bytes"
  | "bytes_restored"
  | "bytes_skipped";

/** The counters of the summary line of a recorded backup or restore (snapshot_id: use snapshotIdOf). restic
 * leaves out a counter that is 0 in some summaries, so a counter read here may be undefined at run time. */
export const summaryOf = (name: string): Record<SummaryCounter, number> => {
  const summary = stdoutLines(fixture(name)).find((line) => line.message_type === "summary");
  if (summary === undefined) throw new Error(`fixture ${name} has no summary line`);
  return summary as Record<SummaryCounter, number>;
};

/** The snapshot id a recorded backup printed in its summary. */
export const snapshotIdOf = (name: string): string =>
  String(stdoutLines(fixture(name)).find((line) => line.message_type === "summary")?.snapshot_id);
