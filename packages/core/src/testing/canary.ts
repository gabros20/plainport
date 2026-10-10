// The leak test (AGENTS.md rule 9). A test plants unique values where a secret would go (a child's stdout, its
// environment, a store's master key) and then fails if any of them, whole or in part, shows up where a secret must
// never be: files under the sandbox, plainport's own stdout and stderr, event lines, findings, the argv of any process
// the runner started, or a thrown error. Every task that touches a secret or the master key runs it on every path.

import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import type { Spawner } from "../runner/types.ts";

/** One spelling of a planted value to look for, named for the report (which never quotes the value). */
export interface CanaryForm {
  name: string;
  text: string;
}

export interface Canary {
  /** What the test plants: printed by a fake child, put in an environment variable, written as a key. */
  value: string;
  /** Every spelling that counts as a leak: the value, its halves (a partial print, a cut message) and, for a
   * structured secret, each component in base64 and hex. Each is long enough not to match by chance. */
  forms: readonly CanaryForm[];
}

/** Where a test looks. Each is optional; a test passes what it collected. */
export interface CanaryPlaces {
  /** Folders searched recursively, without following symlinks; a symlink's target text is searched too. */
  dirs?: readonly string[];
  /** plainport's own stdout and stderr, as text or bytes. */
  output?: readonly (string | Uint8Array)[];
  /** Event lines, as parsed objects or as the JSON text written. */
  events?: readonly unknown[];
  findings?: readonly unknown[];
  /** The argv of every process started, as recordArgv collects it. */
  argv?: readonly (readonly string[])[];
  /** Thrown errors: message, stack, cause and own fields. */
  errors?: readonly unknown[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const random = (size: number): Uint8Array => crypto.getRandomValues(new Uint8Array(size));

/** The whole text and its two halves, each half long enough to be unique. */
const withHalves = (name: string, text: string): CanaryForm[] => {
  const middle = Math.ceil(text.length / 2);
  return [
    { name, text },
    { name: `${name}, first half`, text: text.slice(0, middle) },
    { name: `${name}, second half`, text: text.slice(middle) },
  ];
};

/**
 * A unique value: one identifier token (`canary_<label>_<32 hex>`), so a parser that quotes the token it stopped at
 * (JSON.parse's "Unexpected identifier") quotes all of it. Its base64 is looked for too.
 */
export const makeCanary = (label = "secret"): Canary => {
  if (!/^[A-Za-z0-9]+$/.test(label))
    throw new Error(`makeCanary: the label must be letters and digits, got ${label}`);
  const value = `canary_${label}_${hex(random(16))}`;
  return {
    value,
    forms: [
      ...withHalves(label, value),
      ...withHalves(`${label} (base64)`, base64(new TextEncoder().encode(value))),
    ],
  };
};

/**
 * A restic master key as `restic cat masterkey` prints it: `{"mac":{"k":…,"r":…},"encrypt":…}`, base64 components of
 * 16, 16 and 32 random bytes. The value is that JSON; each component is looked for in base64 and hex, whole and halved.
 */
export const makeMasterKeyCanary = (): Canary => {
  const parts = { "mac.k": random(16), "mac.r": random(16), encrypt: random(32) };
  const value = JSON.stringify({
    mac: { k: base64(parts["mac.k"]), r: base64(parts["mac.r"]) },
    encrypt: base64(parts.encrypt),
  });
  return {
    value,
    forms: Object.entries(parts).flatMap(([name, bytes]) => [
      ...withHalves(`${name} (base64)`, base64(bytes)),
      ...withHalves(`${name} (hex)`, hex(bytes)),
    ]),
  };
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
  const haystacks: [string, string[]][] = [];
  for (const dir of places.dirs ?? []) {
    for (const [path, content] of files(dir)) haystacks.push([`file ${path} under ${dir}`, [path, content]]);
  }
  const listed = (name: string, items: readonly unknown[] | undefined): void => {
    (items ?? []).forEach((item, index) => {
      haystacks.push([`${name}[${index}]`, texts(item)]);
    });
  };
  listed("output", places.output);
  listed("events", places.events);
  listed("findings", places.findings);
  listed("argv", places.argv);
  listed("errors", places.errors);
  const hits: string[] = [];
  for (const [place, found] of haystacks) {
    for (const canary of canaries) {
      for (const form of canary.forms) {
        if (found.some((text) => text.includes(form.text))) hits.push(`${place}: ${form.name}`);
      }
    }
  }
  return hits;
};

/** Throws, naming each place and form, when any canary shows up in any place. */
export const expectNoCanary = (canaries: readonly Canary[], places: CanaryPlaces): void => {
  const hits = findCanaries(canaries, places);
  if (hits.length > 0) throw new Error(`canary found:\n${hits.map((hit) => `  ${hit}`).join("\n")}`);
};
