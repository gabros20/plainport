// The `op://<vault>/<item>[/<section>]/<field>` provider (Q14): the 1Password CLI's `op read`, sensitive, within Q14's
// deadline. `op` is looked up on the user's PATH and gets the user's OP_* variables (a service account token, the
// account, a session), so it signs in as it would in the user's shell. What op says on stderr is never decoded: a
// classifier picks signed out, dismissed or not found from its bytes (D92).

import { ok } from "@plainport/contract";
import {
  bytesInclude,
  parseSecretRef,
  SECRET_DEADLINE_MS,
  type SecretProvider,
  stderrClasses,
} from "@plainport/core";
import {
  childEnv,
  type ProviderOptions,
  secretMissing,
  sensitiveSpec,
  takeText,
  unanswered,
} from "./child.ts";

/** The program, found on the child's PATH. */
export const OP = "op";

const SIGNED_OUT = [
  "not currently signed in",
  "not signed in",
  "No accounts configured",
  "session expired",
  "account is not signed in",
];
const DENIED = ["authorization prompt dismissed", "authorization timeout", "dismissed"];
const NOT_FOUND = ["isn't an item", "isn't a vault", "isn't a field", "could not find", "no item found"];

const opStderr = stderrClasses(["signed-out", "denied", "not-found", "other"], (stderr) => {
  const any = (needles: readonly string[]) => needles.some((needle) => bytesInclude(stderr, needle));
  if (any(SIGNED_OUT)) return "signed-out";
  if (any(DENIED)) return "denied";
  if (any(NOT_FOUND)) return "not-found";
  return "other";
});

export const opProvider = (options: ProviderOptions): SecretProvider => {
  const env = childEnv(options.env, ["PATH", "XDG_CONFIG_HOME"], ["OP_"]);
  return {
    get: async (ref, ctx) => {
      const parsed = parseSecretRef(ref);
      if (parsed?.scheme !== "op")
        return secretMissing(
          `"${ref}" is not an op://<vault>/<item>/<field> reference`,
          'write it as op://<vault>/<item>/<field>, e.g. "op://Private/plainport-nas/password"',
        );
      const ran = await options.run({
        ...sensitiveSpec(OP, ["read", "--no-newline", parsed.reference], env, ctx),
        classifyStderr: opStderr,
      });
      if (!ran.ok)
        return unanswered(
          ran,
          `1Password (op read ${parsed.reference})`,
          {
            seconds: (ctx?.deadlineMs ?? SECRET_DEADLINE_MS) / 1000,
            fix: "op may be waiting for a sign-in or an approval: run op whoami (or approve the 1Password prompt), then re-run",
          },
          {
            message: "the 1Password CLI (op) is not installed or not on PATH",
            fix: "install the 1Password CLI (brew install 1password-cli) and sign in with op signin, then re-run",
          },
        );
      if (ran.value.exitCode === 0) {
        const value = takeText(ran.value.captured);
        if (value !== "") return ok(value);
        return secretMissing(
          `1Password's ${parsed.reference} is empty`,
          "put the secret in that field, then re-run",
        );
      }
      const exit = ran.value.exitCode ?? ran.value.signal;
      switch (opStderr.codeOf(ran.value)) {
        case "signed-out":
          return secretMissing(
            `the 1Password CLI is signed out, so ${parsed.reference} could not be read`,
            "run op signin (or set OP_SERVICE_ACCOUNT_TOKEN for an unattended device), then re-run",
          );
        case "denied":
          return secretMissing(
            `1Password's approval prompt for ${parsed.reference} was dismissed or not answered`,
            "re-run and approve the prompt in 1Password",
          );
        case "not-found":
          return secretMissing(
            `1Password has no vault, item or field at ${parsed.reference}`,
            "check the reference: in 1Password, Copy Secret Reference on the field gives it",
          );
        default:
          return secretMissing(
            `op read ${parsed.reference} failed (exit ${exit})`,
            "run op whoami to check the CLI is signed in to the right account, then re-run",
          );
      }
    },
  };
};
