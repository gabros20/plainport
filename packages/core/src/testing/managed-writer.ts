// A child process for the managed.toml tests: `bun managed-writer.ts <name> <count> [crash-before-rename]`.
// It resolves paths from its own HOME, then adds roots <name>-0 … <name>-<count-1> to managed.toml, one locked
// update each. With crash-before-rename it SIGKILLs itself after writing the temp file, before the rename.
// If $BARRIER_DIR is set, it waits there (barrier.ts) before its first update, so two writers really contend.
// If $MANAGED_WRITER_LOG is set, every update appends "+<name>" on entering and "-<name>" on leaving the update
// callback, which runs under the lock, plus "start <name>" and "done <name>" around the whole run.

import { appendFileSync } from "node:fs";
import { ok } from "@plainport/contract";
import { updateManaged } from "../config/managed.ts";
import { nodeLocalIo } from "../node-io.ts";
import { resolvePaths } from "../paths.ts";
import { awaitGo } from "./barrier.ts";

const [name, countText, mode] = Bun.argv.slice(2);
const paths = resolvePaths(process.env);
if (!paths.ok || name === undefined) {
  console.error("usage: managed-writer.ts <name> <count> [crash-before-rename]");
  process.exit(2);
}

const log = process.env.MANAGED_WRITER_LOG;
const io =
  mode === "crash-before-rename"
    ? {
        ...nodeLocalIo,
        fs: {
          ...nodeLocalIo.fs,
          rename: async (): Promise<void> => {
            process.kill(process.pid, "SIGKILL");
          },
        },
      }
    : nodeLocalIo;

if (process.env.BARRIER_DIR !== undefined) await awaitGo(process.env.BARRIER_DIR, name);
if (log !== undefined) appendFileSync(log, `start ${name}\n`);

for (let i = 0; i < Number(countText ?? "1"); i++) {
  const result = await updateManaged(
    io,
    paths.value,
    (managed) => {
      if (log !== undefined) appendFileSync(log, `+${name}\n`);
      Bun.sleepSync(2);
      if (log !== undefined) appendFileSync(log, `-${name}\n`);
      return ok({ ...managed, roots: { ...managed.roots, [`${name}-${i}`]: { label: `${name} ${i}` } } });
    },
    { timeoutMs: 60_000 },
  );
  if (!result.ok) {
    console.error(`${result.finding.code}: ${result.finding.message}`);
    process.exit(result.exitCode);
  }
}
if (log !== undefined) appendFileSync(log, `done ${name}\n`);
