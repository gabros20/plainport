import { z } from "zod";
import { EnvelopeSchema, StreamLineSchema } from "../../packages/contract/src/index.ts";

export const CallSchema = z.object({
  argv: z.array(z.string()),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  issues: z.array(z.string()).default([]),
});
export const ObservedStateSchema = z.enum([
  "unregistered",
  "local",
  "shelved",
  "offloading",
  "onloading",
  "conflicted",
  "restored-unhydrated",
  "unavailable",
]);
export const ObservationSchema = z.object({
  afterCall: z.number().int().nonnegative(),
  project: z.string(),
  state: ObservedStateSchema,
});
export const TranscriptSchema = z.object({
  version: z.literal(1),
  project: z.string(),
  agentExitCode: z.number().int().nullable(),
  fixtureIntact: z.boolean(),
  agentIssues: z.array(z.string()),
  calls: z.array(CallSchema),
  observations: z.array(ObservationSchema),
  finalObservation: ObservationSchema.omit({ afterCall: true }).optional(),
  observationIssues: z.array(z.string()).default([]),
});
export type Call = z.infer<typeof CallSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
export interface ContractIssue {
  code: string;
  message: string;
  call?: number;
}

/** The human renderer emits a finding followed by its actionable fix or re-run line. */
export function humanFinding(stderr: string) {
  const match = stderr.match(/^plainport: ([a-z][a-z0-9.-]*): ([^\n]+)\n(?:fix: |re-run: )([^\n]+)$/m);
  return match?.[3]?.trim() ? { code: match[1], message: match[2], fix: match[3].trim() } : undefined;
}

export function lastEnvelope(stdout: string) {
  try {
    return EnvelopeSchema.safeParse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
  } catch {
    return EnvelopeSchema.safeParse(undefined);
  }
}

export function scoreTranscript(input: unknown) {
  const transcript = TranscriptSchema.parse(input);
  const contractIssues: ContractIssue[] = [];
  const refusalsMissingFix: number[] = [];
  const issue = (code: string, message: string, call?: number) =>
    contractIssues.push({ code, message, ...(call === undefined ? {} : { call }) });
  for (const [index, call] of transcript.calls.entries()) {
    const number = index + 1;
    const parsed = lastEnvelope(call.stdout);
    const failed = call.exitCode !== 0;
    for (const message of call.issues) issue("call.evidence-incomplete", message, number);
    const isHelp = call.argv[0] === "help" || call.argv.includes("--help");
    if (!isHelp && !call.argv.includes("--json"))
      issue("output.json-required", "Non-help call did not request --json.", number);
    if (call.argv.includes("--json")) {
      for (const line of call.stdout.trim().split("\n").slice(0, -1)) {
        try {
          if (StreamLineSchema.safeParse(JSON.parse(line)).success) continue;
        } catch {
          /* Invalid JSON is a contract issue too. */
        }
        issue("output.invalid-event", "A stdout line before the envelope is not a valid event.", number);
      }
    }
    const human = isHelp && !call.argv.includes("--json") ? humanFinding(call.stderr) : undefined;
    if (failed && (!parsed.success || !parsed.data.error?.finding?.fix?.trim()) && !human?.fix) {
      refusalsMissingFix.push(number);
      issue("refusal.missing-fix", "Refusal has no finding with a non-empty fix.", number);
    }
    if (failed && (!parsed.success || !parsed.data.error?.hint?.trim()) && !human?.fix)
      issue("refusal.missing-hint", "Refusal has no next-step hint.", number);
    if (call.argv.includes("--json") && !parsed.success)
      issue("output.invalid-json", "The final stdout line is not an envelope.", number);
    if (parsed.success) {
      const { ok, error } = parsed.data;
      if (ok !== !failed || (failed && error?.code !== call.exitCode))
        issue("output.exit-mismatch", "Envelope and process exit code disagree.", number);
      if (failed && !error?.message.trim()) issue("message.confusing", "Refusal has no explanation.", number);
    }
    if (call.exitCode === null) issue("call.interrupted", "Call did not produce an exit code.", number);
  }
  for (const message of transcript.observationIssues) issue("observation.invalid", message);
  if (!transcript.finalObservation)
    issue("observation.final-missing", "Final independent status is missing.");
  for (const message of transcript.agentIssues) issue("agent.confusing", message);
  let shelvedAt: number | undefined;
  for (const observation of transcript.observations) {
    if (observation.project !== transcript.project || observation.afterCall > transcript.calls.length)
      continue;
    if (observation.state === "shelved" && shelvedAt === undefined) shelvedAt = observation.afterCall;
  }
  const returnedLocal =
    shelvedAt !== undefined &&
    transcript.finalObservation?.project === transcript.project &&
    transcript.finalObservation.state === "local";
  const reachedShelved = shelvedAt !== undefined;
  if (!reachedShelved) issue("lifecycle.not-shelved", "No observation shows the fixture shelved.");
  if (!returnedLocal) issue("lifecycle.not-local", "No later observation shows the fixture local.");
  if (!transcript.fixtureIntact) issue("fixture.changed", "Restored fixture bytes or modes differ.");
  if (transcript.agentExitCode !== 0) issue("agent.failed", "Agent did not exit successfully.");
  return {
    passed: reachedShelved && returnedLocal && contractIssues.length === 0,
    reachedShelved,
    returnedLocal,
    calls: transcript.calls.length,
    nonZeroExits: transcript.calls.filter((call) => call.exitCode !== 0).length,
    refusalsMissingFix,
    contractIssues,
  };
}
