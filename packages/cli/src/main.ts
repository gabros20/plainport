// The plainport entry point. Until the command registry lands (M1 task 4) it only answers --version.
import { VERSION } from "./version.ts";

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  console.log(`plainport ${VERSION}`);
  process.exit(0);
}

console.error("plainport: only --version works yet; commands arrive with the command registry (M1 task 4)");
process.exit(2);
