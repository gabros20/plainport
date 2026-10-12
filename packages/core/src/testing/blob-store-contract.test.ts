// The contract suite's own options, checked by running it under `bun test` in a child: a timeout can only be seen from
// outside the test it bounds.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("blob-store contract: the semantic probe's time", () => {
  const scratch = mkdtempSync(join(tmpdir(), "plainport-contract-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  // A slow volume (exFAT on a CI runner) needs more than bun's 5 s default for the probe's hundreds of synced writes:
  // the fixture says how long, and the probe test is given exactly that. Here a store whose puts take 20 ms is given
  // 1 ms, so the probe must time out at 1 ms; ignoring the option would give it 5 s, and it would pass.
  test("probeTimeout bounds the probe test", () => {
    const file = join(scratch, "slow.test.ts");
    writeFileSync(
      file,
      [
        `import { ALL_ELIGIBLE, blobStoreContract } from ${JSON.stringify(join(import.meta.dir, "blob-store-contract.ts"))};`,
        `import { semanticBlobStore } from ${JSON.stringify(join(import.meta.dir, "semantic-blob-store.ts"))};`,
        "blobStoreContract(",
        `  "slow",`,
        "  () => {",
        "    const store = semanticBlobStore();",
        "    const put = store.put.bind(store);",
        "    store.put = async (...args) => { await Bun.sleep(20); return put(...args); };",
        "    return { store, cleanup: () => {} };",
        "  },",
        "  { eligibility: ALL_ELIGIBLE, listProbeKeys: 10, probeTimeout: 1 },",
        ");",
        "",
      ].join("\n"),
    );
    const child = Bun.spawnSync(["bun", "test", file, "-t", "when probed"], {
      cwd: scratch,
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = child.stdout.toString() + child.stderr.toString();
    expect(child.exitCode, output).toBe(1);
    expect(output).toContain("timed out after 1ms");
  });
});
