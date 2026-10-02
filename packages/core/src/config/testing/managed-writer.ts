// A child process for the managed.toml tests: `bun managed-writer.ts <name> <count> [crash-before-rename]`.
// It resolves paths from its own HOME, then adds roots <name>-0 … <name>-<count-1> to managed.toml, one locked
// update each. With crash-before-rename it SIGKILLs itself after writing the temp file, before the rename.
// If $MANAGED_WRITER_LOG is set, every update appends "+<name>" on entering and "-<name>" on leaving its critical
// section, so a test can see whether two writers were ever inside at once, plus "start <name>" and "done <name>"
// around the whole run. If $MANAGED_WRITER_START is set (epoch ms), the writer waits until then to begin, so two
// writers start together and really contend for the lock.

import { appendFileSync } from "node:fs";
import { resolvePaths } from "../../paths.ts";
import { nodeConfigIo } from "../io.ts";
import { updateManaged } from "../managed.ts";

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
        ...nodeConfigIo,
        rename: (): void => {
          process.kill(process.pid, "SIGKILL");
        },
      }
    : nodeConfigIo;

const start = Number(process.env.MANAGED_WRITER_START ?? 0);
if (start > Date.now()) await Bun.sleep(start - Date.now());
if (log !== undefined) appendFileSync(log, `start ${name}\n`);

for (let i = 0; i < Number(countText ?? "1"); i++) {
  const result = await updateManaged(
    paths.value,
    (managed) => {
      if (log !== undefined) appendFileSync(log, `+${name}\n`);
      Bun.sleepSync(2);
      if (log !== undefined) appendFileSync(log, `-${name}\n`);
      return { ...managed, roots: { ...managed.roots, [`${name}-${i}`]: { label: `${name} ${i}` } } };
    },
    { io, timeoutMs: 30_000 },
  );
  if (!result.ok) {
    console.error(`${result.finding.code}: ${result.finding.message}`);
    process.exit(result.exitCode);
  }
}
if (log !== undefined) appendFileSync(log, `done ${name}\n`);
