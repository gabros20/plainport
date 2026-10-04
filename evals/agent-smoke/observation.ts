import { z } from "zod";
import type { runProcess } from "../../packages/core/src/index.ts";
import { lastEnvelope, type Observation, ObservedStateSchema } from "./scorer.ts";

export function statusEvidence(result: Awaited<ReturnType<typeof runProcess>>): {
  observation?: Omit<Observation, "afterCall">;
  issues: string[];
} {
  if (!result.ok) return { issues: [`Status observation failed: ${result.finding.message}`] };
  const envelope = lastEnvelope(new TextDecoder().decode(result.value.captured));
  if (
    result.value.exitCode === 4 &&
    envelope.success &&
    envelope.data.verb === "status" &&
    !envelope.data.ok &&
    envelope.data.error.code === 4 &&
    envelope.data.error.finding?.code === "project.not-found"
  )
    return { observation: { project: "work:fixture", state: "unregistered" }, issues: [] };
  if (result.value.exitCode !== 0)
    return { issues: [`Status observation exited ${result.value.exitCode}. ${result.value.stderr.text}`] };
  if (!envelope.success || !envelope.data.ok || envelope.data.verb !== "status")
    return { issues: ["Status observation did not return a valid successful status envelope."] };
  const data = z
    .object({
      address: z.literal("work:fixture"),
      state: ObservedStateSchema.exclude(["unregistered"]),
    })
    .safeParse(envelope.data.data);
  if (!data.success)
    return { issues: ["Status observation did not name the fixture and a valid project state."] };
  return { observation: { project: data.data.address, state: data.data.state }, issues: [] };
}
