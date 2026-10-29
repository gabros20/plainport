// The secret provider port (DESIGN.md "Plugin interfaces → SecretProvider", "Configuration", ADR-0013, Q14). A store's
// secrets are references in config (AGENTS.md rule 9): `env:NAME`, `file:PATH`, `keychain:<service>/<account>`,
// `op://<vault>/<item>[/<section>]/<field>`. Core reads `env:` and `file:` itself (store.ts); `keychain:` and `op:` run
// a child (/usr/bin/security, the 1Password CLI) through the runner's sensitive mode, so they are providers the
// composition root injects (@plainport/secrets). `se:` and `bw:` are refused until their milestones.
//
// A provider never puts a value anywhere but its ok result: not in a finding, an event, an argv, a file or an error.

import type { Result } from "@plainport/contract";

/** How long any provider call may take (Q14): an unanswered Keychain prompt or a hung `op` is store.secret-missing. */
export const SECRET_DEADLINE_MS = 30_000;

export interface SecretContext {
  /** Aborting it stops the provider's child: process.cancelled. */
  signal?: AbortSignal;
  /** SECRET_DEADLINE_MS unless a test says otherwise. */
  deadlineMs?: number;
}

export interface SecretProvider {
  /**
   * The secret a reference names. Expected failures are values: store.secret-missing (not found, empty, a garbled
   * reference, denied, signed out, no answer within the deadline), process.cancelled when ctx.signal stops it.
   */
  get(ref: string, ctx?: SecretContext): Promise<Result<string>>;
  /** Stores a secret under the reference, where the provider can write (Keychain). */
  set?(ref: string, value: string, ctx?: SecretContext): Promise<Result<void>>;
}

/** The providers that run a child, by scheme; core reads `env:` and `file:` itself. */
export interface SecretProviders {
  keychain?: SecretProvider;
  op?: SecretProvider;
}

/** A reference taken apart; undefined from parseSecretRef when it is garbled. */
export type SecretRef =
  | { scheme: "env"; name: string }
  | { scheme: "file"; path: string }
  | { scheme: "keychain"; service: string; account: string }
  /** The whole `op://…` reference, as `op read` takes it. */
  | { scheme: "op"; reference: string }
  | { scheme: "se" | "bw"; target: string };

/** The schemes a reference may name (config's SecretRefSchema): the first word before the colon. */
export const SECRET_SCHEMES = ["env", "file", "keychain", "op", "se", "bw"] as const;

/** What each scheme's reference looks like, for a garbled reference's fix. */
export const SECRET_REF_FORMS: Readonly<Record<SecretRef["scheme"], string>> = {
  env: "env:<VARIABLE>",
  file: "file:<path>",
  keychain: "keychain:<service>/<account>",
  op: "op://<vault>/<item>/<field>",
  se: "se:<identity>",
  bw: "bw:<item>",
};

/** A control character (a newline, a NUL, DEL): never part of a reference, and a way to break a child's input. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The scheme a reference names, garbled or not; undefined when it names none plainport knows. */
export const secretSchemeOf = (ref: string): SecretRef["scheme"] | undefined => {
  const scheme = ref.slice(0, Math.max(0, ref.indexOf(":")));
  return (SECRET_SCHEMES as readonly string[]).includes(scheme) ? (scheme as SecretRef["scheme"]) : undefined;
};

/**
 * A reference taken apart, or undefined when it is garbled: an unknown scheme, an empty target, a control character,
 * `keychain:` without both a service and an account (split at the first `/`), `op:` that is not
 * `op://<vault>/<item>[/<section>]/<field>` (an optional `?query` after the field, as `op read` allows).
 */
export const parseSecretRef = (ref: string): SecretRef | undefined => {
  const scheme = secretSchemeOf(ref);
  if (scheme === undefined || CONTROL.test(ref)) return undefined;
  const target = ref.slice(scheme.length + 1);
  if (target === "") return undefined;
  switch (scheme) {
    case "env":
      return VARIABLE.test(target) ? { scheme, name: target } : undefined;
    case "file":
      return { scheme, path: target };
    case "keychain": {
      const at = target.indexOf("/");
      if (at <= 0 || at === target.length - 1) return undefined;
      return { scheme, service: target.slice(0, at), account: target.slice(at + 1) };
    }
    case "op": {
      if (!target.startsWith("//")) return undefined;
      const path = target.slice(2).split("?")[0] as string;
      const segments = path.split("/");
      if (segments.length < 3 || segments.length > 4 || segments.some((segment) => segment.trim() === ""))
        return undefined;
      return { scheme, reference: ref };
    }
    default:
      return { scheme, target };
  }
};
