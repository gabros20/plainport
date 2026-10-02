// Adapted from plainkeep cli/package.json "check:bun" (gabros20/plainkeep@d7eb27e), ADR-0003.
// Refuses a Bun older than 1.2.21, which drops empty-string arguments when spawning a child process.

const MINIMUM = [1, 2, 21] as const;

export type BunVerdict = { ok: true } | { ok: false; message: string };

export const checkBunVersion = (version: string): BunVerdict => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  const ok =
    major > MINIMUM[0] ||
    (major === MINIMUM[0] && (minor > MINIMUM[1] || (minor === MINIMUM[1] && patch >= MINIMUM[2])));
  if (ok) return { ok: true };
  return {
    ok: false,
    message:
      `plainport needs bun >= ${MINIMUM.join(".")}, found ${version}. Older bun DROPS empty-string entries ` +
      "when spawning a child, so the process runner would silently eat an empty argument (verified broken on " +
      "1.1.45 and 1.2.0, fixed on 1.2.21 and 1.3.14). Fix: bun upgrade",
  };
};

if (import.meta.main) {
  const verdict = checkBunVersion(Bun.version);
  if (!verdict.ok) {
    console.error(verdict.message);
    process.exit(1);
  }
}
