// @plainport/secrets — The secret providers that run a child: keychain: (/usr/bin/security) and op: (the 1Password
// CLI). Core reads env: and file: itself; se: and bw: arrive later (ports/secrets.ts).

import type { SecretProviders } from "@plainport/core";
import type { ProviderOptions } from "./child.ts";
import { keychainProvider } from "./keychain.ts";
import { opProvider } from "./op.ts";

export const packageName = "@plainport/secrets";
export { childEnv, type ProviderOptions, type Run, SECRET_MAX_BYTES } from "./child.ts";
export { type KeychainOptions, keychainProvider, SECURITY } from "./keychain.ts";
export { OP, opProvider } from "./op.ts";
export {
  encodeSecurityLine,
  hexOf,
  type LineRefusal,
  SECURITY_LINE_MAX_ARGS,
  SECURITY_LINE_MAX_BYTES,
} from "./security-line.ts";

/** The providers a store opener carries (StoreOpener.secrets), over the one runner. */
export const secretProviders = (options: ProviderOptions): SecretProviders => ({
  keychain: keychainProvider(options),
  op: opProvider(options),
});
