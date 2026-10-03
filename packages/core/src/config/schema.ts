// The shape of plainport's configuration (DESIGN.md "Configuration", "Roots"). Config is input, so every table is
// strict: a misspelt key is an error, not silently ignored (run decision D16).
//
// Two levels of checking, because tables merge key by key: a file may set part of a table (config.toml giving a
// store only a new `path`), so each file is checked against the *layer* schemas, where every key is optional; the
// merged result is then checked against ResolvedConfigSchema, where a store must have its kind and the sections
// with built-in defaults are complete.

import { z } from "zod";

/** "0", or a whole number with a unit: 30s, 15m, 24h, 7d, 2w. */
export const DurationSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*[smhdw])$/, 'a duration such as "0", "24h" or "7d"');

/** Secrets stay references (AGENTS.md rule 9): a provider prefix, never the value itself. */
export const SecretRefSchema = z
  .string()
  .regex(
    /^(keychain|se|op|bw|file|env):.+$/,
    "a secret reference (keychain:, se:, op:, bw:, file: or env:), never the secret itself",
  );

const Name = z.string().min(1);
const Patterns = z.array(z.string());

export const RoleSchema = z.enum(["owner", "worker", "storage"]);
export type Role = z.infer<typeof RoleSchema>;
const SecretsMode = z.enum(["include", "envelope", "exclude"]);
const Access = z.enum(["full", "append-only", "read-only"]);

const offload = {
  verify: z.enum(["manifest", "full"]),
  keepLocalFor: DurationSchema,
  requirePushed: z.boolean(),
  stub: z.boolean(),
};
const onload = { hydrate: z.boolean(), leases: z.enum(["warn", "strict"]) };
const deps = { mode: z.enum(["strip", "keep"]) };
const retention = { keepLast: z.number().int().positive() };
const strip = { extra: Patterns, never: Patterns, keep: Patterns };
const deletion = { delay: DurationSchema, pruneKey: SecretRefSchema.optional() };
const move = { keepSource: DurationSchema };

/** Each section as a file may write it: any subset of its keys. */
const partial = <S extends z.core.$ZodLooseShape>(shape: S) => z.strictObject(shape).partial();

const RootSchema = z.strictObject({
  label: z.string().optional(),
  store: Name.optional(),
  devices: z.array(Name).optional(),
  secrets: SecretsMode.optional(),
  /** Device name → this root's folder on that device. */
  on: z.record(Name, z.string().min(1)).optional(),
  scan: partial({ depth: z.number().int().positive(), ignore: Patterns }).optional(),
  deps: partial(deps).optional(),
  strip: partial(strip).optional(),
  retention: partial(retention).optional(),
});

const storeShared = {
  access: Access.optional(),
  replicateTo: z.array(Name).optional(),
};
/** Where a local store whose config names no secret reads its restic repository password from. */
export const DEFAULT_LOCAL_SECRET = "env:PLAINPORT_STORE_PASSWORD";
const LocalStore = z.strictObject({
  kind: z.literal("local"),
  path: z.string().min(1),
  /** The restic repository's password; DEFAULT_LOCAL_SECRET when absent. */
  secret: SecretRefSchema.optional(),
  ...storeShared,
});
const SftpStore = z.strictObject({
  kind: z.literal("sftp"),
  host: Name,
  path: z.string().min(1),
  secret: SecretRefSchema,
  ...storeShared,
});
const S3Store = z.strictObject({
  kind: z.literal("s3"),
  endpoint: z.url(),
  bucket: Name,
  secret: SecretRefSchema,
  ...storeShared,
});
const PeerStore = z.strictObject({
  kind: z.literal("peer"),
  device: Name,
  path: z.string().min(1),
  ...storeShared,
});
export const StoreSchema = z.discriminatedUnion("kind", [LocalStore, SftpStore, S3Store, PeerStore]);
export type Store = z.infer<typeof StoreSchema>;

/** A store as one file may write it: any of the keys of any kind, checked as a whole after merging. */
const StoreLayerSchema = z
  .strictObject({
    kind: z.enum(["local", "sftp", "s3", "peer"]),
    path: z.string().min(1),
    host: Name,
    endpoint: z.url(),
    bucket: Name,
    secret: SecretRefSchema,
    device: Name,
    ...storeShared,
  })
  .partial();

const DeviceEntrySchema = partial({ role: RoleSchema, ssh: Name });

const secrets = {
  mode: SecretsMode,
  patterns: Patterns,
  grant: z.partialRecord(RoleSchema, z.boolean()),
  recovery: SecretRefSchema,
};

const hydrate = { command: z.string().min(1) };
/** Hook name (pre-offload, post-onload, …) → shell commands, run only after `plainport trust`. */
const HooksSchema = z.record(z.string().regex(/^(pre|post)-[a-z]+$/), z.array(z.string().min(1)));

/** The global config as config.toml or managed.toml holds it, or the flags and environment set it. */
export const ConfigLayerSchema = z.strictObject({
  version: z.literal(1).optional(),
  defaultStore: Name.optional(),
  roots: z.record(Name, RootSchema).optional(),
  stores: z.record(Name, StoreLayerSchema).optional(),
  devices: z.record(Name, DeviceEntrySchema).optional(),
  offload: partial(offload).optional(),
  onload: partial(onload).optional(),
  deps: partial(deps).optional(),
  retention: partial(retention).optional(),
  strip: partial(strip).optional(),
  secrets: partial(secrets).optional(),
  deletion: partial(deletion).optional(),
  move: partial(move).optional(),
});
export type ConfigLayer = z.infer<typeof ConfigLayerSchema>;

/** A project's own .plainport.toml: only what may differ per project (DESIGN.md "Per project"). */
export const ProjectConfigSchema = z.strictObject({
  strip: partial(strip).optional(),
  deps: partial(deps).optional(),
  hydrate: partial(hydrate).optional(),
  hooks: HooksSchema.optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** The configuration a command runs with: every layer merged over the built-in defaults. */
export const ResolvedConfigSchema = z.strictObject({
  version: z.literal(1),
  defaultStore: Name.optional(),
  roots: z.record(Name, RootSchema),
  stores: z.record(Name, StoreSchema),
  devices: z.record(Name, z.strictObject({ role: RoleSchema, ssh: Name.optional() })),
  offload: z.strictObject(offload),
  onload: z.strictObject(onload),
  deps: z.strictObject(deps),
  retention: z.strictObject(retention),
  strip: z.strictObject(strip),
  secrets: partial(secrets).optional(),
  deletion: z.strictObject(deletion),
  move: z.strictObject(move),
  hydrate: partial(hydrate).optional(),
  hooks: HooksSchema.optional(),
});
export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

/**
 * Built-in defaults, the lowest layer. Values from DESIGN.md: its config examples, and its Decisions (local copy
 * deleted once verified, forget honoured after seven days, parked copies kept seven days).
 */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  version: 1,
  roots: {},
  stores: {},
  devices: {},
  offload: { verify: "manifest", keepLocalFor: "0", requirePushed: false, stub: true },
  onload: { hydrate: true, leases: "warn" },
  deps: { mode: "strip" },
  retention: { keepLast: 5 },
  strip: { extra: [], never: [], keep: [] },
  deletion: { delay: "7d" },
  move: { keepSource: "7d" },
});
