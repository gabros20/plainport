// The manifest (DESIGN.md "Offload process" step 3): every entry the scan found below the project folder, with the
// fields verify compares against the snapshot's listing (step 7): path, type, size, mode, mtime and link target. Its
// fields match the Engine port's EntryMeta, so the verifier compares like with like.
//
// A project can hold hundreds of thousands of entries, so the manifest is kept packed: one string per path and
// typed arrays for the numbers, about 40 bytes per entry beyond the path itself, instead of an object per entry.
// Entries come back as objects one at a time, from get() and iteration.

import { z } from "zod";

export const ManifestEntrySchema = z
  .strictObject({
    /** Relative to the project folder, "/"-separated, without a leading slash. */
    path: z.string().min(1),
    type: z.enum(["file", "dir", "symlink"]),
    /** Files only. */
    size: z.number().int().nonnegative().optional(),
    /** Permission bits, setuid, setgid and sticky included (mode & 0o7777). */
    mode: z.number().int().min(0).max(0o7777),
    /** RFC 3339 in UTC with nanoseconds: 2026-10-03T01:36:47.319437918Z. */
    mtime: z.string(),
    /** Symlinks only: the target as stored. */
    linkTarget: z.string().optional(),
  })
  .meta({ title: "ManifestEntry" });
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;
export type ManifestType = ManifestEntry["type"];

const TYPES: readonly ManifestType[] = ["file", "dir", "symlink"];
const NS = 1_000_000_000n;

/** Nanoseconds since the epoch as RFC 3339 in UTC, all nine fraction digits kept. */
export const formatNs = (ns: bigint): string => {
  let seconds = ns / NS;
  let fraction = ns % NS;
  if (fraction < 0n) {
    fraction += NS;
    seconds -= 1n;
  }
  const whole = new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "");
  return `${whole}.${fraction.toString().padStart(9, "0")}Z`;
};

/** Grows a typed array by doubling. */
const grow = <T extends Float64Array | Uint32Array | Uint16Array | Uint8Array>(
  array: T,
  needed: number,
  make: (length: number) => T,
): T => {
  if (needed <= array.length) return array;
  const bigger = make(Math.max(needed, array.length * 2));
  bigger.set(array);
  return bigger;
};

/** Collects entries in scan order; finish() seals them into a Manifest. */
export class ManifestBuilder {
  private count = 0;
  private readonly paths: string[] = [];
  private types = new Uint8Array(1024);
  private sizes = new Float64Array(1024);
  private modes = new Uint16Array(1024);
  private seconds = new Float64Array(1024);
  private nanos = new Uint32Array(1024);
  private readonly targets = new Map<number, string>();

  add(entry: {
    path: string;
    type: ManifestType;
    size: number;
    mode: number;
    mtimeNs: bigint;
    linkTarget?: string;
  }) {
    const i = this.count++;
    this.types = grow(this.types, this.count, (n) => new Uint8Array(n));
    this.sizes = grow(this.sizes, this.count, (n) => new Float64Array(n));
    this.modes = grow(this.modes, this.count, (n) => new Uint16Array(n));
    this.seconds = grow(this.seconds, this.count, (n) => new Float64Array(n));
    this.nanos = grow(this.nanos, this.count, (n) => new Uint32Array(n));
    this.paths.push(entry.path);
    this.types[i] = TYPES.indexOf(entry.type);
    this.sizes[i] = entry.size;
    this.modes[i] = entry.mode;
    let seconds = entry.mtimeNs / NS;
    let fraction = entry.mtimeNs % NS;
    if (fraction < 0n) {
      fraction += NS;
      seconds -= 1n;
    }
    this.seconds[i] = Number(seconds);
    this.nanos[i] = Number(fraction);
    if (entry.linkTarget !== undefined) this.targets.set(i, entry.linkTarget);
  }

  finish(): Manifest {
    const n = this.count;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const paths = this.paths;
    order.sort((a, b) => {
      const x = paths[a] as string;
      const y = paths[b] as string;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return new Manifest(
      paths,
      this.types.slice(0, n),
      this.sizes.slice(0, n),
      this.modes.slice(0, n),
      this.seconds.slice(0, n),
      this.nanos.slice(0, n),
      this.targets,
      order,
    );
  }
}

export class Manifest {
  /** @internal ManifestBuilder.finish() makes it. */
  constructor(
    private readonly paths: readonly string[],
    private readonly types: Uint8Array,
    private readonly sizes: Float64Array,
    private readonly modes: Uint16Array,
    private readonly seconds: Float64Array,
    private readonly nanos: Uint32Array,
    private readonly targets: ReadonlyMap<number, string>,
    /** Entry indexes sorted by path, for get(). */
    private readonly order: Uint32Array,
  ) {}

  /** How many entries it holds. */
  get size(): number {
    return this.paths.length;
  }

  /** The entry at this relative path, if the scan found one. */
  get(path: string): ManifestEntry | undefined {
    let low = 0;
    let high = this.order.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const index = this.order[mid] as number;
      const here = this.paths[index] as string;
      if (here === path) return this.at(index);
      if (here < path) low = mid + 1;
      else high = mid - 1;
    }
    return undefined;
  }

  /** Every entry, in scan order. */
  *[Symbol.iterator](): IterableIterator<ManifestEntry> {
    for (let i = 0; i < this.paths.length; i++) yield this.at(i);
  }

  /**
   * An estimate of the memory it holds: each path at two bytes a character (the worst case, UTF-16) plus a string
   * header, the typed arrays, and each link target.
   */
  get approxBytes(): number {
    let bytes = 0;
    for (const path of this.paths) bytes += 16 + 2 * path.length;
    bytes += 8 * this.paths.length; // the array's slots
    bytes +=
      this.types.byteLength +
      this.sizes.byteLength +
      this.modes.byteLength +
      this.seconds.byteLength +
      this.nanos.byteLength +
      this.order.byteLength;
    for (const target of this.targets.values()) bytes += 48 + 2 * target.length;
    return bytes;
  }

  private at(i: number): ManifestEntry {
    const type = TYPES[this.types[i] as number] as ManifestType;
    const ns = BigInt(this.seconds[i] as number) * NS + BigInt(this.nanos[i] as number);
    const entry: ManifestEntry = {
      path: this.paths[i] as string,
      type,
      mode: this.modes[i] as number,
      mtime: formatNs(ns),
    };
    if (type === "file") entry.size = this.sizes[i] as number;
    const target = this.targets.get(i);
    if (target !== undefined) entry.linkTarget = target;
    return entry;
  }
}
