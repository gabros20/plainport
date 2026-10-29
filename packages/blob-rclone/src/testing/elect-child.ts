// Test-only child process: one device holding Task 6's election on a T2 store, round after round, for the
// two-process election test in semantics.t2.test.ts. `bun elect-child.ts <config.json>`; it prints one JSON line per
// round ({ round, id, outcome, winner? }) and nothing else on stdout. Every round waits at a start barrier the parent
// releases once both devices are ready, so the two really race.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { elect, type StoreSemantics, ulid } from "@plainport/core";
import { awaitGo } from "../../../core/src/testing/barrier.ts";
import { type Backend, t2World } from "./t2.ts";

export interface ElectChildConfig {
  backend: Backend;
  /** The store's root under the T2 store, shared by both devices. */
  root: string;
  /** This device's profile of the store (devices may differ: one with conditional create, one without). */
  semantics: StoreSemantics;
  rounds: number;
  /** The barrier folder; round r uses `<barrier>/<r>`. */
  barrier: string;
  name: string;
}

export interface RoundResult {
  round: number;
  id: string;
  outcome: "won" | "lost" | "contested" | "error";
  winner?: string;
  error?: string;
}

const config = JSON.parse(readFileSync(process.argv[2] as string, "utf8")) as ElectChildConfig;
const world = await t2World();
try {
  const store = world.store(world.remote(config.backend, config.root), { semantics: config.semantics });
  for (let round = 0; round < config.rounds; round++) {
    const id = ulid(Date.now());
    const prefix = `elect/${String(round).padStart(3, "0")}/`;
    await awaitGo(join(config.barrier, String(round)), config.name);
    const result = await elect(store, {
      key: `${prefix}store.json`,
      candidates: `${prefix}candidates/`,
      id,
      value: new TextEncoder().encode(`${JSON.stringify({ id })}\n`),
      winnerOf: (bytes) => {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { id?: unknown };
          return typeof parsed.id === "string" ? parsed.id : undefined;
        } catch {
          return undefined;
        }
      },
      store: config.backend,
      wait: (ms) => Bun.sleep(ms),
    });
    const line: RoundResult = result.ok
      ? {
          round,
          id,
          outcome: result.value.outcome,
          ...(result.value.outcome === "lost" ? { winner: result.value.winner } : {}),
        }
      : { round, id, outcome: "error", error: `${result.finding.code}: ${result.finding.message}` };
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
} finally {
  world.cleanup();
}
