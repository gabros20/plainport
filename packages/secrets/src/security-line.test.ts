// The `security -i` encoder against a port of how `security -i` reads its input (Apple's Security: readline.c's
// readline and security.c's split_line, byte for byte): every argument that can be written round trips as one
// argument of one command, and an argument that would end the line or start another command is refused. The T1 suite
// (keychain.t1.test.ts) runs the real `security -i`.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { encodeSecurityLine, hexOf, SECURITY_LINE_MAX_BYTES } from "./security-line.ts";

/** isspace() in the C locale. */
const isspace = (byte: number) => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);

/** split_line: one line's bytes (up to a NUL, as C sees a string) cut into at most 32 arguments. */
const splitLine = (line: Uint8Array): Uint8Array[] => {
  const args: number[][] = [];
  let current: number[] = [];
  let state: "skip" | "read" | "read-esc" | "quoted" | "quoted-esc" = "skip";
  let quote = 0;
  for (const byte of line) {
    if (byte === 0) break;
    if (state === "skip") {
      if (isspace(byte)) continue;
      if (byte === 0x22 || byte === 0x27) {
        quote = byte;
        state = "quoted";
        current = [];
        continue;
      }
      state = "read";
      current = [];
    }
    if (state === "read") {
      if (byte === 0x5c) {
        state = "read-esc";
        continue;
      }
      if (isspace(byte)) {
        args.push(current);
        state = "skip";
        if (args.length >= 32) break;
      } else current.push(byte);
      continue;
    }
    if (state === "quoted") {
      if (byte === 0x5c) {
        state = "quoted-esc";
        continue;
      }
      if (byte === quote) {
        args.push(current);
        state = "skip";
        if (args.length >= 32) break;
      } else current.push(byte);
      continue;
    }
    current.push(byte);
    state = state === "read-esc" ? "read" : "quoted";
  }
  if (state !== "skip" && args.length < 32) args.push(current);
  return args.map((arg) => Uint8Array.from(arg));
};

/** readline then split_line, until EOF: the commands `security -i` runs for this stdin. */
const commandsOf = (stdin: Uint8Array): string[][] => {
  const commands: string[][] = [];
  let at = 0;
  for (;;) {
    const line: number[] = [];
    for (let ix = 0; ; ix++) {
      if (ix === SECURITY_LINE_MAX_BYTES) break;
      if (at >= stdin.length) return commands; // EOF: readline returns NULL, the partial line is dropped
      const byte = stdin[at++] as number;
      if (byte === 0x0a) break;
      line.push(byte);
    }
    commands.push(splitLine(Uint8Array.from(line)).map((arg) => new TextDecoder().decode(arg)));
  }
};

const stdinOf = (line: string) => new TextEncoder().encode(`${line}\n`);

describe("encodeSecurityLine", () => {
  test("spaces, both quotes, backslashes, tabs, carriage returns and non-ASCII round trip as one argument each", () => {
    const argv = [
      "add-generic-password",
      "-s",
      "plain port",
      "-a",
      `it's "quoted" \\ back\\slash\\`,
      "tab\there",
      "cr\rhere",
      "árvíztűrő tükörfúrógép",
      "",
      "\\",
      '"',
      "'",
    ];
    const encoded = encodeSecurityLine(argv);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(commandsOf(stdinOf(encoded.line))).toEqual([argv]);
  });

  test("any text without a newline or a NUL round trips (property)", () => {
    const arg = fc
      .string({ unit: "binary", maxLength: 40 })
      .filter((s) => s.isWellFormed() && !s.includes("\n") && !s.includes("\0"));
    fc.assert(
      fc.property(fc.array(arg, { minLength: 1, maxLength: 31 }), (argv) => {
        const encoded = encodeSecurityLine(argv);
        if (!encoded.ok) return encoded.why === "too-long";
        const commands = commandsOf(stdinOf(encoded.line));
        expect(commands).toEqual([argv]);
        return true;
      }),
      { numRuns: 500 },
    );
  });

  test("a value with newlines round trips as the -X hex it is written as", () => {
    const value = 'line one\nline "two"\n\\three\n';
    const encoded = encodeSecurityLine([
      "add-generic-password",
      "-X",
      hexOf(new TextEncoder().encode(value)),
    ]);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const [command] = commandsOf(stdinOf(encoded.line));
    expect(Buffer.from(command?.[2] ?? "", "hex").toString()).toBe(value);
  });

  test("an argument that would inject a second command is refused", () => {
    const injection = 'nas" \n"delete-keychain" "login.keychain-db';
    expect(encodeSecurityLine(["find-generic-password", "-s", injection])).toEqual({
      ok: false,
      why: "newline",
    });
    // What the refusal prevents: written raw, the same text is two commands.
    expect(commandsOf(stdinOf(`"find-generic-password" "-s" "${injection}"`))).toHaveLength(2);
    expect(encodeSecurityLine(["x", "a\0b"])).toEqual({ ok: false, why: "nul" });
  });

  test("a line readline would cut (the rest read as another command) is refused, one byte short of it is not", () => {
    // Each argument costs its quotes and a separating space.
    const fits = "a".repeat(SECURITY_LINE_MAX_BYTES - 1 - 2);
    expect(encodeSecurityLine([fits]).ok).toBe(true);
    expect(encodeSecurityLine([`${fits}a`])).toEqual({ ok: false, why: "too-long" });
    const long = encodeSecurityLine([fits]);
    if (long.ok) expect(commandsOf(stdinOf(long.line))).toEqual([[fits]]);
  });

  test("more arguments than split_line keeps are refused", () => {
    expect(encodeSecurityLine(Array.from({ length: 32 }, () => "a")).ok).toBe(true);
    expect(encodeSecurityLine(Array.from({ length: 33 }, () => "a"))).toEqual({ ok: false, why: "too-many" });
  });
});
