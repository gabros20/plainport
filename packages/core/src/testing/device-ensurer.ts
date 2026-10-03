// A child process for the device tests: `bun device-ensurer.ts <name>`. It waits at the barrier in
// $BARRIER_DIR, then calls ensureDevice and prints "<id> <created>".

import { ensureDevice } from "../device.ts";
import { nodeLocalIo } from "../node-io.ts";
import { resolvePaths } from "../paths.ts";
import { awaitGo } from "./barrier.ts";

const [name] = Bun.argv.slice(2);
const paths = resolvePaths(process.env);
const barrier = process.env.BARRIER_DIR;
if (!paths.ok || name === undefined || barrier === undefined) {
  console.error("usage: BARRIER_DIR=<dir> device-ensurer.ts <name>");
  process.exit(2);
}
await awaitGo(barrier, name);
const result = await ensureDevice(nodeLocalIo, paths.value, { role: "owner", name: "mbp" });
if (!result.ok) {
  console.error(`${result.finding.code}: ${result.finding.message}`);
  process.exit(result.exitCode);
}
console.log(`${result.value.device.id} ${result.value.created}`);
