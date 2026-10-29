// The `keychain:<service>/<account>` provider (Q14, DESIGN.md "Security and encryption → Keychain prompts"). plainport
// never reads the Keychain itself: it asks Apple's signed `/usr/bin/security`, so an item's access list names that tool
// and an updated plainport binary changes nothing.
//
// - get: `security find-generic-password -s <service> -a <account> -w`, sensitive, within Q14's deadline. An item that
//   is not there is store.secret-missing, whose fix is the interactive `security add-generic-password … -w` (which
//   prompts for the value, so it never sits in a shell's history); a Keychain prompt not answered in time is too.
// - set: `security -i`, the command on stdin (security-line.ts), the value as `-X <hex>`, so the value is in no argv.
//
// Known limit: `find-generic-password -w` prints a value holding any byte outside printable ASCII as hex, which cannot
// be told from a value that is hex. set refuses such a value; an item written by hand with one reads back as its hex.

import { fail, finding, ok, type Result } from "@plainport/contract";
import { parseSecretRef, SECRET_DEADLINE_MS, type SecretContext, type SecretProvider } from "@plainport/core";
import {
  childEnv,
  type ProviderOptions,
  secretMissing,
  sensitiveSpec,
  takeText,
  unanswered,
} from "./child.ts";
import { encodeSecurityLine, hexOf } from "./security-line.ts";

declare global {
  /** Folded by `--define globalThis.PLAINPORT_TEST_HOOKS=…`: false in every release build (scripts/build.ts, D67). */
  var PLAINPORT_TEST_HOOKS: boolean | undefined;
}

export const SECURITY = "/usr/bin/security";

/** security's exit status is its OSStatus's low byte: errSecItemNotFound (-25300). */
const NOT_FOUND = 44;
/** errSecUserCanceled (-128), errSecAuthFailed (-25293), errSecInteractionNotAllowed (-25308). */
const DENIED = new Set([128, 51, 36]);

export interface KeychainOptions extends ProviderOptions {
  /**
   * Test hook: search and write this keychain file only, never the user's search list. Release builds define
   * PLAINPORT_TEST_HOOKS false, which folds it away; the composition root never passes it.
   */
  testKeychain?: string;
}

/** A word for a shell, in single quotes: for a fix the user copies. */
const shellWord = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

const garbled = (ref: string) =>
  secretMissing(
    `"${ref}" is not a keychain:<service>/<account> reference`,
    'write it as keychain:<service>/<account>, e.g. "keychain:plainport/nas"',
  );

/** Printable ASCII only: what find-generic-password -w gives back as it is (isprint in the C locale). */
const PRINTABLE = /^[\x20-\x7e]+$/;

export const keychainProvider = (options: KeychainOptions): SecretProvider => {
  const keychain = globalThis.PLAINPORT_TEST_HOOKS === false ? undefined : options.testKeychain;
  const env = childEnv(options.env);
  const seconds = (ctx: SecretContext | undefined) => (ctx?.deadlineMs ?? SECRET_DEADLINE_MS) / 1000;
  const notStarted = {
    message: `${SECURITY} could not be started: keychain: references are read on macOS only`,
    fix: "use an op:, env: or file: reference on this system",
  };

  return {
    get: async (ref, ctx) => {
      const parsed = parseSecretRef(ref);
      if (parsed?.scheme !== "keychain") return garbled(ref);
      const { service, account } = parsed;
      const item = `the Keychain item for service "${service}", account "${account}"`;
      const args = ["find-generic-password", "-s", service, "-a", account, "-w"];
      const ran = await options.run(
        sensitiveSpec(SECURITY, keychain === undefined ? args : [...args, keychain], env, ctx),
      );
      if (!ran.ok)
        return unanswered(
          ran,
          `reading ${item}`,
          {
            seconds: seconds(ctx),
            fix: "answer the Keychain prompt (or unlock the keychain) within 30 seconds, then re-run",
          },
          notStarted,
        );
      const { exitCode } = ran.value;
      if (exitCode === 0) {
        const value = takeText(ran.value.captured).replace(/\n$/, "");
        if (value !== "") return ok(value);
        return secretMissing(
          `${item} is empty`,
          `security add-generic-password -U -s ${shellWord(service)} -a ${shellWord(account)} -w`,
        );
      }
      if (exitCode === NOT_FOUND)
        return secretMissing(
          `the Keychain has no item for service "${service}", account "${account}"`,
          `security add-generic-password -s ${shellWord(service)} -a ${shellWord(account)} -w (it prompts for the value)`,
        );
      if (exitCode !== null && DENIED.has(exitCode))
        return secretMissing(
          `the Keychain refused to give ${item} (security exit ${exitCode}: the prompt was denied, or the keychain is locked)`,
          "unlock the keychain and choose Allow when macOS asks for /usr/bin/security, then re-run",
        );
      return secretMissing(
        `${SECURITY} could not read ${item} (exit ${exitCode ?? ran.value.signal})`,
        `security find-generic-password -s ${shellWord(service)} -a ${shellWord(account)} shows what is wrong`,
      );
    },

    set: async (ref, value, ctx): Promise<Result<void>> => {
      const parsed = parseSecretRef(ref);
      const invalid = (message: string, fix: string) => fail(finding("usage.invalid", { message, fix }));
      if (parsed?.scheme !== "keychain")
        return invalid(
          `"${ref}" is not a keychain:<service>/<account> reference`,
          "write it as keychain:<service>/<account>",
        );
      if (!PRINTABLE.test(value))
        return invalid(
          "the secret is empty or holds a character outside printable ASCII (a newline, a control character, a non-ASCII letter), which the Keychain would give back hex-encoded",
          "store this secret in 1Password (op:) or a file (file:) instead",
        );
      const { service, account } = parsed;
      const line = encodeSecurityLine([
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        account,
        "-X",
        hexOf(new TextEncoder().encode(value)),
        ...(keychain === undefined ? [] : [keychain]),
      ]);
      if (!line.ok)
        return invalid(
          `the Keychain item for service "${service}", account "${account}" cannot be written through security -i (${line.why})`,
          "use a shorter secret, or a service and account without newlines",
        );
      const stdin = new TextEncoder().encode(`${line.line}\n`);
      const ran = await options
        .run(sensitiveSpec(SECURITY, ["-i"], env, ctx, stdin))
        .finally(() => stdin.fill(0));
      const item = `the Keychain item for service "${service}", account "${account}"`;
      if (!ran.ok) {
        const why = unanswered(
          ran,
          `writing ${item}`,
          { seconds: seconds(ctx), fix: "answer the Keychain prompt, then re-run" },
          notStarted,
        );
        return why.finding.code === "store.secret-missing"
          ? fail(finding("store.failed", { message: why.finding.message, fix: why.finding.fix }))
          : why;
      }
      if (ran.value.exitCode === 0) return ok(undefined);
      return fail(
        finding("store.failed", {
          message: `${SECURITY} could not write ${item} (exit ${ran.value.exitCode ?? ran.value.signal})`,
          fix: `security add-generic-password -U -s ${shellWord(service)} -a ${shellWord(account)} -w writes it by hand (it prompts for the value)`,
        }),
      );
    },
  };
};
