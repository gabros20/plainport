import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { resolvePaths } from "../../packages/core/src/paths.ts";
import { lastEnvelope } from "./scorer.ts";

interface PollOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  exists?: (path: string) => boolean;
  now?: () => number;
  nextPoll?: () => Promise<void>;
}

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** Poll actual deletion effects; elapsed time alone never establishes completion. */
export async function waitForDeletion(paths: string[], options: PollOptions = {}): Promise<string[]> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 30_000);
  const present = options.exists ?? exists;
  const nextPoll = options.nextPoll ?? (() => new Promise<void>((done) => setTimeout(done, 10)));
  for (;;) {
    if (options.signal?.aborted) return ["Detached trash deletion observation was cancelled."];
    let remaining: string[];
    try {
      remaining = paths.filter(present);
    } catch (error) {
      return [`Detached trash deletion could not be observed: ${String(error)}`];
    }
    if (remaining.length === 0) return [];
    if (now() >= deadline)
      return [`Detached trash deletion did not finish before the deadline: ${remaining.join(", ")}`];
    await nextPoll();
  }
}

/** Called before the recorder returns a successful offload to the agent, so its next onload cannot reuse trash. */
export async function observeOffloadDeletion(
  area: string,
  env: Record<string, string>,
  argv: string[],
  exitCode: number | null,
  stdout: string,
  options: PollOptions = {},
): Promise<string[]> {
  if (argv[0] !== "offload" || exitCode !== 0 || argv.includes("--dry-run")) return [];
  const envelope = lastEnvelope(stdout);
  const output = z.object({
    op: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    project: z.literal("work:fixture"),
    trash: z.string(),
  });
  const data =
    envelope.success && envelope.data.ok && envelope.data.verb === "offload"
      ? output.safeParse(envelope.data.data)
      : undefined;
  if (!data?.success) return ["Offload deletion evidence has no valid fixture operation and trash path."];
  const trash = join(area, "work/.plainport-trash", data.data.op);
  if (data.data.trash !== trash)
    return ["Offload deletion evidence names a trash path outside the fixture sandbox."];
  const paths = resolvePaths(env, { cwd: area });
  if (!paths.ok) return [paths.finding.message];
  return waitForDeletion(
    [trash, `${trash}.claim`, join(paths.value.journalDir, `${data.data.op}.json`)],
    options,
  );
}
