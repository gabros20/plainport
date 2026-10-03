// Rewrites the golden plans in fixtures/node/<name>.plan.json from the current planner and Node plugin. Run it only
// after a deliberate change, and review the diff like code: `bun packages/eco-node/scripts/golden.ts`.

import { writeFileSync } from "node:fs";
import { GOLDEN_CASES, goldenFile, normalize, planCase, shown } from "../src/testing.ts";

for (const c of GOLDEN_CASES) {
  const run = await planCase(c);
  try {
    writeFileSync(goldenFile(c.name), `${JSON.stringify(normalize(run), null, 2)}\n`);
    console.log(`wrote ${shown(goldenFile(c.name))}`);
  } finally {
    run.fx.cleanup();
  }
}
