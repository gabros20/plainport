// The leak test (AGENTS.md rule 9). A test plants unique values where a secret would go (a child's stdout, its
// environment, a store's master key) and then fails if any of them, whole or in part, shows up where a secret must
// never be: files under the sandbox, plainport's own stdout and stderr, event lines, findings, the argv of any process
// the runner started, or a thrown error. Every task that touches a secret or the master key runs it on every path.

import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { formatWithOptions } from "node:util";
import type { Result } from "@plainport/contract";
import type { LogEvent, RunOutcome, RunSpec, Spawner } from "../runner/types.ts";

/** One spelling of a planted value to look for, named for the report (which never quotes the value). */
export interface CanaryForm {
  name: string;
  text: string;
}

export interface Canary {
  /** What the test plants: printed by a fake child, put in an environment variable, written as a key. */
  value: string;
  /** Every spelling that counts as a leak, whole: the value and its halves, its hex, and its base64 at each of the
   * three alignments a larger envelope can give it, plain and base64url; for a structured secret, each component the
   * same way. Each is long enough not to match by chance. */
  forms: readonly CanaryForm[];
  /** Every PIECE-character slice of the forms (a cut message keeps any slice, interior ones included), named by its
   * form, less the slices every canary of the kind shares (`canary_secret_`). Forms added later have no pieces. */
  pieces: readonly CanaryForm[];
}

/** How long a slice of a planted value must be to count: 48 bits of hex, 72 of base64, never a chance match. */
export const PIECE = 12;

/**
 * Where a test looks. Each is optional; a test passes what it collected. Each item is searched on its own, and each
 * list as a whole too (its items concatenated, and for objects the same field across items), so a value split across
 * chunks, lines or events is found.
 */
export interface CanaryPlaces {
  /** Folders searched recursively, without following symlinks; a symlink's target text is searched too. */
  dirs?: readonly string[];
  /** plainport's own stdout and stderr (recordOwnOutput collects them), as text or bytes, in the order written. */
  stdout?: readonly (string | Uint8Array)[];
  stderr?: readonly (string | Uint8Array)[];
  /** Any other output, as text or bytes. */
  output?: readonly (string | Uint8Array)[];
  /** Event lines, as parsed objects or as the JSON text written. */
  events?: readonly unknown[];
  findings?: readonly unknown[];
  /** The argv of every process started, as recordArgv collects it. */
  argv?: readonly (readonly string[])[];
  /** Thrown errors: message, stack, cause and own fields. */
  errors?: readonly unknown[];
  /** What a call returned for diagnostics (a run's outcome, its tails), less the one field allowed to hold it. */
  returned?: readonly unknown[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const random = (size: number): Uint8Array => crypto.getRandomValues(new Uint8Array(size));

const base64url = (text: string): string => text.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/**
 * The bytes' base64 when an envelope puts them at offset 1 or 2 of a 3-byte group: the encoding of the bytes behind
 * `shift` zeros, less its first group (which holds the zeros) and its last (which depends on what follows).
 */
const shiftedBase64 = (bytes: Uint8Array, shift: number): string =>
  Buffer.concat([new Uint8Array(shift), bytes])
    .toString("base64")
    .slice(4, -4);

/** The whole text and its two halves, each half long enough to be unique. */
const withHalves = (name: string, text: string): CanaryForm[] => {
  const middle = Math.ceil(text.length / 2);
  return [
    { name, text },
    { name: `${name}, first half`, text: text.slice(0, middle) },
    { name: `${name}, second half`, text: text.slice(middle) },
  ];
};

/** The spellings of some bytes: hex and base64 whole and halved, base64 shifted, each base64 also as base64url. */
const encodings = (name: string, bytes: Uint8Array): CanaryForm[] => {
  const aligned = base64(bytes);
  const shifted = [1, 2].map(
    (shift): CanaryForm => ({
      name: `${name} (base64, shifted ${shift})`,
      text: shiftedBase64(bytes, shift),
    }),
  );
  return [
    ...withHalves(`${name} (hex)`, hex(bytes)),
    ...withHalves(`${name} (base64)`, aligned),
    ...shifted,
    { name: `${name} (base64url)`, text: base64url(aligned) },
    ...shifted.map((form) => ({
      name: form.name.replace("base64", "base64url"),
      text: base64url(form.text),
    })),
  ];
};

/** Every PIECE-character slice of the forms, less those of `shared` (the same kind of value with other random bytes). */
const piecesOf = (forms: readonly CanaryForm[], shared: readonly CanaryForm[]): CanaryForm[] => {
  const slices = (text: string): string[] =>
    Array.from({ length: Math.max(0, text.length - PIECE + 1) }, (_, at) => text.slice(at, at + PIECE));
  const common = new Set(shared.flatMap((form) => slices(form.text)));
  const pieces = new Map<string, string>();
  for (const form of forms) {
    for (const slice of slices(form.text)) {
      if (!common.has(slice) && !pieces.has(slice)) pieces.set(slice, `${form.name}, a piece`);
    }
  }
  return [...pieces].map(([text, name]) => ({ name, text }));
};

/**
 * A unique value: one identifier token (`canary_<label>_<32 hex>`), so a parser that quotes the token it stopped at
 * (JSON.parse's "Unexpected identifier") quotes all of it. Its hex and base64 are looked for too.
 */
export const makeCanary = (label = "secret"): Canary => {
  if (!/^[A-Za-z0-9]+$/.test(label))
    throw new Error(`makeCanary: the label must be letters and digits, got ${label}`);
  const formsOf = (value: string): CanaryForm[] => [
    ...withHalves(label, value),
    ...encodings(label, new TextEncoder().encode(value)),
  ];
  const value = `canary_${label}_${hex(random(16))}`;
  const forms = formsOf(value);
  // A canary with other random bytes shares only what every canary of the label shares: those slices are no leak.
  return { value, forms, pieces: piecesOf(forms, formsOf(`canary_${label}_${hex(random(16))}`)) };
};

/**
 * A restic master key as `restic cat masterkey` prints it: `{"mac":{"k":…,"r":…},"encrypt":…}`, base64 components of
 * 16, 16 and 32 random bytes. The value is that JSON; each component is looked for in hex and base64 (every alignment,
 * plain and url), whole, halved and in pieces.
 */
export const makeMasterKeyCanary = (): Canary => {
  const parts = { "mac.k": random(16), "mac.r": random(16), encrypt: random(32) };
  const value = JSON.stringify({
    mac: { k: base64(parts["mac.k"]), r: base64(parts["mac.r"]) },
    encrypt: base64(parts.encrypt),
  });
  const forms = Object.entries(parts).flatMap(([name, bytes]) => encodings(name, bytes));
  return { value, forms, pieces: piecesOf(forms, []) };
};

/** Wraps a spawner so every argv it is asked to start is recorded, for CanaryPlaces.argv. */
export const recordArgv = (spawner: Spawner): { spawner: Spawner; argv: string[][] } => {
  const argv: string[][] = [];
  return {
    argv,
    spawner: {
      spawn: (request) => {
        argv.push([request.command, ...request.args]);
        return spawner.spawn(request);
      },
      signalGroup: (pgid, signal) => spawner.signalGroup(pgid, signal),
    },
  };
};

/**
 * Runs `run` while recording what this process itself writes to its stdout and stderr, console included, so a test
 * can search plainport's own output (CanaryPlaces.stdout and .stderr). Nothing recorded reaches the terminal.
 */
export const recordOwnOutput = async <T>(
  run: () => Promise<T>,
): Promise<{ value: T; stdout: (string | Uint8Array)[]; stderr: (string | Uint8Array)[] }> => {
  const stdout: (string | Uint8Array)[] = [];
  const stderr: (string | Uint8Array)[] = [];
  const saved = { out: process.stdout.write, err: process.stderr.write, console: { ...console } };
  const into =
    (sink: (string | Uint8Array)[]) =>
    (chunk: string | Uint8Array): boolean => {
      sink.push(chunk);
      return true;
    };
  process.stdout.write = into(stdout) as typeof process.stdout.write;
  process.stderr.write = into(stderr) as typeof process.stderr.write;
  for (const [name, sink] of [
    ["log", stdout],
    ["info", stdout],
    ["debug", stdout],
    ["warn", stderr],
    ["error", stderr],
    ["trace", stderr],
  ] as const) {
    // As the console would print them: objects with their fields, at any depth.
    console[name] = (...args: unknown[]) => {
      sink.push(formatWithOptions({ depth: Number.POSITIVE_INFINITY }, ...args));
    };
  }
  try {
    return { value: await run(), stdout, stderr };
  } finally {
    process.stdout.write = saved.out;
    process.stderr.write = saved.err;
    Object.assign(console, saved.console);
  }
};

/** Bytes as latin1: every byte one character, so an ASCII form is found byte for byte in any file. */
const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

/** Everything a value says, as text: strings, bytes, errors (with stack, cause and fields), arrays and objects. */
const texts = (value: unknown, seen = new Set<unknown>()): string[] => {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [value];
  if (value instanceof Uint8Array) return [latin1(value), new TextDecoder().decode(value)];
  if (typeof value !== "object") return [String(value)];
  if (seen.has(value)) return [];
  seen.add(value);
  const out: string[] = [];
  if (value instanceof Error) {
    out.push(String(value), value.stack ?? "");
    out.push(...texts(value.cause, seen));
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    out.push(key, ...texts((value as Record<string, unknown>)[key], seen));
  }
  return out;
};

/** Every text a value holds, each with the name of the field it sits in ("" at the top), in order. */
const leaves = (value: unknown, key = "", seen = new Set<unknown>()): [string, string][] => {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return [[key, value]];
  if (value instanceof Uint8Array) return [[key, latin1(value)]];
  if (typeof value !== "object") return [[key, String(value)]];
  if (seen.has(value)) return [];
  seen.add(value);
  const out: [string, string][] = [];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...leaves(item, key, seen));
    return out;
  }
  if (value instanceof Error) out.push([key, String(value)]);
  for (const name of Object.getOwnPropertyNames(value)) {
    out.push(...leaves((value as Record<string, unknown>)[name], name, seen));
  }
  return out;
};

/** A list as a whole: all its texts concatenated, and each field's texts across the items concatenated. */
const wholes = (name: string, items: readonly unknown[]): [string, string[]][] => {
  const all = leaves(items as unknown[]);
  const byField = new Map<string, string[]>();
  for (const [field, text] of all) byField.set(field, [...(byField.get(field) ?? []), text]);
  return [
    [`${name} (all of it)`, [all.map(([, text]) => text).join("")]],
    ...[...byField]
      .filter(([field]) => field !== "")
      .map(([field, texts]): [string, string[]] => [
        `${name} (all of its "${field}" fields)`,
        [texts.join("")],
      ]),
  ];
};

/** Every file and symlink under dir, as [path relative to dir, its content]. */
const files = (dir: string): [string, string][] => {
  const out: [string, string][] = [];
  const walk = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) out.push([relative(dir, path), readlinkSync(path)]);
    else if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
    else if (stat.isFile()) out.push([relative(dir, path), latin1(readFileSync(path))]);
  };
  walk(dir);
  return out;
};

/**
 * Where any canary shows up, as "<place>: <form name>" lines, empty when nowhere. The lines never quote a value, so
 * a failing test does not spread it into logs either.
 */
export const findCanaries = (canaries: readonly Canary[], places: CanaryPlaces): string[] => {
  const forms = canaries.flatMap((canary) => canary.forms);
  const pieces = new Map<string, string>();
  for (const canary of canaries) for (const piece of canary.pieces ?? []) pieces.set(piece.text, piece.name);
  /** The names of the forms and pieces a text holds: whole forms by includes, pieces by one sliding pass. */
  const held = (text: string): string[] => {
    const names = new Set<string>();
    for (const form of forms) if (text.includes(form.text)) names.add(form.name);
    for (let at = 0; at + PIECE <= text.length; at++) {
      const name = pieces.get(text.slice(at, at + PIECE));
      if (name !== undefined) names.add(name);
    }
    return [...names];
  };
  const haystacks: [string, string[]][] = [];
  for (const dir of places.dirs ?? []) {
    for (const [path, content] of files(dir)) {
      const place = `file ${path} under ${dir}`;
      // A name that holds a canary is itself a hit: reported, but never repeated.
      const named = held(place).length > 0;
      haystacks.push([
        named ? "a file under a folder searched (name withheld: it holds a canary)" : place,
        [place, content],
      ]);
    }
  }
  const listed = (name: string, items: readonly unknown[] | undefined): void => {
    if (items === undefined || items.length === 0) return;
    items.forEach((item, index) => {
      haystacks.push([`${name}[${index}]`, texts(item)]);
    });
    haystacks.push(...wholes(name, items));
  };
  listed("stdout", places.stdout);
  listed("stderr", places.stderr);
  listed("output", places.output);
  listed("events", places.events);
  listed("findings", places.findings);
  listed("argv", places.argv);
  listed("errors", places.errors);
  listed("returned", places.returned);
  const hits = new Set<string>();
  for (const [place, found] of haystacks) {
    for (const text of found) for (const name of held(text)) hits.add(`${place}: ${name}`);
  }
  return [...hits];
};

/** Throws, naming each place and form, when any canary shows up in any place. */
export const expectNoCanary = (canaries: readonly Canary[], places: CanaryPlaces): void => {
  const hits = findCanaries(canaries, places);
  if (hits.length > 0) throw new Error(`canary found:\n${hits.map((hit) => `  ${hit}`).join("\n")}`);
};

/** Everything one run left where a secret must not be, as CanaryPlaces, with the run's result, errors and events. */
export interface CollectedRun {
  result: Result<RunOutcome> | undefined;
  errors: unknown[];
  events: LogEvent[];
  places: CanaryPlaces;
}

/**
 * Runs `run`, handing it a log sink, and collects every place its secret could reach: the events logged, the finding
 * of a failure, a thrown error, this process's own stdout and stderr (recordOwnOutput), the returned outcome less
 * `captured` (the one field allowed to hold stdout), and the dirs and recorded argv the caller adds.
 */
export const collectRun = async (
  run: (log: NonNullable<RunSpec["log"]>) => Promise<Result<RunOutcome>>,
  extra: { dirs?: readonly string[]; argv?: readonly (readonly string[])[] } = {},
): Promise<CollectedRun> => {
  const events: LogEvent[] = [];
  const errors: unknown[] = [];
  const own = await recordOwnOutput(() =>
    run({ op: "canary", emit: (event) => events.push(event) }).catch((error: unknown) => {
      errors.push(error);
      return undefined;
    }),
  );
  const result = own.value;
  return {
    result,
    errors,
    events,
    places: {
      dirs: extra.dirs,
      argv: extra.argv,
      events,
      errors,
      findings: result === undefined || result.ok ? [] : [result.finding],
      returned: result?.ok ? [{ ...result.value, captured: undefined }] : [],
      stdout: own.stdout,
      stderr: own.stderr,
    },
  };
};

/**
 * The leak gate for a sensitive run (Tasks 5, 15, 19, 28): collectRun, then fail if any canary shows up in any place,
 * if anything was logged (unless `events`), or if the run threw when it should not have, or did not when `throws`.
 */
export const expectRunLeaksNothing = async (
  canaries: readonly Canary[],
  run: (log: NonNullable<RunSpec["log"]>) => Promise<Result<RunOutcome>>,
  extra: {
    dirs?: readonly string[];
    argv?: readonly (readonly string[])[];
    events?: boolean;
    throws?: boolean;
  } = {},
): Promise<CollectedRun> => {
  const collected = await collectRun(run, extra);
  expectNoCanary(canaries, collected.places);
  if (!extra.events && collected.events.length > 0)
    throw new Error(`the run logged ${collected.events.length} events; a sensitive run logs none`);
  const thrown = collected.errors.length;
  if (thrown !== (extra.throws ? 1 : 0))
    throw new Error(`the run threw ${thrown} errors, ${extra.throws ? "expected one" : "expected none"}`);
  return collected;
};
