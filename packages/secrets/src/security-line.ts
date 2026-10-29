// One command line for `/usr/bin/security -i` (Q14): plainport writes a Keychain item by handing `security` its command
// on stdin, never in argv, where every process on the machine could read it (`ps`).
//
// How `security -i` reads its input (Apple's Security, SecurityTool/macOS/security.c and sharedTool/readline.c): a
// line ends at the first "\n", whatever quoting surrounds it, or after 4095 bytes, when the rest becomes the next line;
// split_line then cuts it into at most 32 arguments at whitespace, where a `"` or `'` opens a quoted argument that the
// same quote closes, and a backslash takes the next byte literally, inside quotes or out. A NUL ends the line early.
//
// So every argument is put in double quotes with `\` and `"` escaped, and an argument that would end the line early
// or start another (a newline, a NUL), or a line that would be cut, is refused: a value can never inject a second
// command. The secret itself never needs quoting: it goes as `-X <hex>`.

/** readline's buffer: a longer line is cut at 4095 bytes and the rest read as another command. */
export const SECURITY_LINE_MAX_BYTES = 4095;
/** split_line keeps at most 32 arguments, the command included. */
export const SECURITY_LINE_MAX_ARGS = 32;

export type LineRefusal = "newline" | "nul" | "too-long" | "too-many";

/** The quoted line, without its "\n", or why it cannot be one. */
export const encodeSecurityLine = (
  argv: readonly string[],
): { ok: true; line: string } | { ok: false; why: LineRefusal } => {
  if (argv.length > SECURITY_LINE_MAX_ARGS) return { ok: false, why: "too-many" };
  for (const arg of argv) {
    if (arg.includes("\n")) return { ok: false, why: "newline" };
    if (arg.includes("\0")) return { ok: false, why: "nul" };
  }
  const line = argv.map((arg) => `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(" ");
  if (new TextEncoder().encode(line).length > SECURITY_LINE_MAX_BYTES - 1)
    return { ok: false, why: "too-long" };
  return { ok: true, line };
};

/** The bytes as lower-case hex, for `-X`: no character that needs quoting. */
export const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
