// Reading one TOML config file into a checked layer. A file that does not parse, or parses into something its
// schema refuses, is an expected failure: a message naming the line or the key, never an exception.

import { parse, TomlError } from "smol-toml";
import type { z } from "zod";
import { type ConfigIo, errorCode } from "./io.ts";

export type FileRead<T> =
  | { kind: "ok"; value: T }
  | { kind: "missing" }
  | { kind: "invalid"; message: string; line?: number };

/** One line per problem: `onload.leases: Invalid option: expected one of "warn"|"strict"`. */
export const describeIssues = (error: z.ZodError): string =>
  error.issues
    .map((issue) => (issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`))
    .join("; ");

export const readTomlFile = <S extends z.ZodType>(
  io: ConfigIo,
  path: string,
  schema: S,
): FileRead<z.output<S>> => {
  let text: string;
  try {
    text = io.readText(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "missing" };
    return {
      kind: "invalid",
      message: `could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    if (error instanceof TomlError) {
      const reason = error.message.split("\n")[0]?.replace(/^Invalid TOML document: /, "") ?? "invalid TOML";
      return {
        kind: "invalid",
        message: `line ${error.line}, column ${error.column}: ${reason}`,
        line: error.line,
      };
    }
    throw error;
  }
  const checked = schema.safeParse(data);
  if (!checked.success) return { kind: "invalid", message: describeIssues(checked.error) };
  return { kind: "ok", value: checked.data };
};
