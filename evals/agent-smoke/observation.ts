import { z } from "zod";
import type { runProcess } from "../../packages/core/src/index.ts";
import { lastEnvelope, type Observation } from "./scorer.ts";

export function statusEvidence(result: Awaited<ReturnType<typeof runProcess>>): {
  observation?: Omit<Observation, "afterCall">;
  issues: string[];
} {
  if (!result.ok) return { issues: [`Status observation failed: ${result.finding.message}`] };
  if (result.value.exitCode !== 0)
    return { issues: [`Status observation exited ${result.value.exitCode}. ${result.value.stderr.text}`] };
  const envelope = lastEnvelope(new TextDecoder().decode(result.value.captured));
  if (!envelope.success || !envelope.data.ok || envelope.data.verb !== "status")
    return { issues: ["Status observation did not return a valid successful status envelope."] };
  const data = z
    .object({
      address: z.literal("work:fixture"),
      state: z.enum([
        "local",
        "shelved",
        "offloading",
        "onloading",
        "conflicted",
        "restored-unhydrated",
        "unavailable",
      ]),
    })
    .safeParse(envelope.data.data);
  if (!data.success)
    return { issues: ["Status observation did not name the fixture and a valid project state."] };
  return { observation: { project: data.data.address, state: data.data.state }, issues: [] };
}
