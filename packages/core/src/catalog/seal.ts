// The catalog seal, version 1 (DESIGN.md "Security and encryption → Catalog seal v1"; ADR-0013). Pure: bytes in, bytes
// out, no I/O. An event on a bucket or VPS store is sealed with XChaCha20-Poly1305 under a key derived from the
// repository's restic master key, so the catalog needs no key of its own. `pp_seal` versions the envelope and the KDF
// apart from the event's `v`; anything unknown or failing authentication is catalog.seal-failed, never a guess and
// never a substitute key (Q10).

import { createHmac, hkdfSync } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { fail, finding, ok, type Result } from "@plainport/contract";
import { z } from "zod";

export const SEAL_VERSION = 1;
export const SEAL_ALG = "xchacha20poly1305";
export const SEAL_KDF = "hkdf-sha256-restic-master-v1";
export const SEAL_INFO = "plainport catalog seal v1";
export const SEAL_KID_LABEL = "plainport kid v1";
export const SEAL_NONCE_BYTES = 24;
export const MASTER_KEY_BYTES = 64;

/** The envelope: one JSON line, base64url fields. */
export const SealEnvelopeSchema = z
  .strictObject({
    pp_seal: z.number().int(),
    alg: z.string(),
    kdf: z.string(),
    kid: z.string(),
    nonce: z.string(),
    ct: z.string(),
  })
  .meta({ title: "SealEnvelope", description: "A sealed catalog event: one JSON line (Catalog seal v1)" });
export type SealEnvelope = z.infer<typeof SealEnvelopeSchema>;

const sealFailed = (
  message: string,
  fix = "Check that the store and its repository password are the ones the event was sealed for",
) => fail(finding("catalog.seal-failed", { message, fix }));

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const CANON = /^[A-Za-z0-9_-]*$/;
const fromB64u = (text: string): Uint8Array | undefined => {
  if (!CANON.test(text)) return undefined;
  const bytes = new Uint8Array(Buffer.from(text, "base64url"));
  return b64u(bytes) === text ? bytes : undefined;
};

const enc = new TextEncoder();

/** The associated data: `pp_seal\0v1\0<store id>\0<event key>`. */
export const sealAad = (storeId: string, eventKey: string): Uint8Array =>
  enc.encode(`pp_seal\0v1\0${storeId}\0${eventKey}`);

const ResticMasterKeySchema = z.object({
  encrypt: z.string(),
  mac: z.object({ k: z.string(), r: z.string() }),
});

const fromStd64 = (text: string): Uint8Array | undefined => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return undefined;
  return new Uint8Array(Buffer.from(text, "base64"));
};

/**
 * The input keying material from `restic cat masterkey`'s JSON: encrypt (32) ‖ mac.k (16) ‖ mac.r (16), base64-decoded,
 * in that order. A key of any other shape is refused.
 */
export const masterKeyMaterial = (json: string | unknown): Result<Uint8Array> => {
  let value: unknown = json;
  if (typeof json === "string") {
    try {
      value = JSON.parse(json);
    } catch {
      return sealFailed("the restic master key is not JSON");
    }
  }
  const parsed = ResticMasterKeySchema.safeParse(value);
  if (!parsed.success)
    return sealFailed("the restic master key does not have encrypt and mac.k/mac.r fields");
  const encrypt = fromStd64(parsed.data.encrypt);
  const k = fromStd64(parsed.data.mac.k);
  const r = fromStd64(parsed.data.mac.r);
  if (encrypt?.length !== 32 || k?.length !== 16 || r?.length !== 16)
    return sealFailed("the restic master key's encrypt, mac.k and mac.r are not 32, 16 and 16 bytes");
  const material = new Uint8Array(MASTER_KEY_BYTES);
  material.set(encrypt, 0);
  material.set(k, 32);
  material.set(r, 48);
  return ok(material);
};

/** HKDF-SHA256, salt = the UTF-8 store id, info = `plainport catalog seal v1`, 32 bytes. */
export const deriveSealKey = (material: Uint8Array, storeId: string): Result<Uint8Array> => {
  if (material.length !== MASTER_KEY_BYTES)
    return sealFailed(`the input keying material is ${material.length} bytes, not ${MASTER_KEY_BYTES}`);
  if (storeId === "") return sealFailed("the store id is empty");
  return ok(new Uint8Array(hkdfSync("sha256", material, enc.encode(storeId), enc.encode(SEAL_INFO), 32)));
};

/** The first 8 bytes of HMAC-SHA256(key, `plainport kid v1`), in hex. */
export const keyId = (key: Uint8Array): string =>
  createHmac("sha256", key).update(SEAL_KID_LABEL).digest().subarray(0, 8).toString("hex");

export interface SealInput {
  key: Uint8Array;
  storeId: string;
  eventKey: string;
  plaintext: Uint8Array;
  /** 24 bytes; random unless a test fixes it. */
  nonce?: Uint8Array;
}

/** Seals `plaintext` for one event key of one store: one JSON line, no trailing newline. */
export const seal = (input: SealInput): Result<string> => {
  if (input.key.length !== 32) return sealFailed("the catalog key is not 32 bytes");
  const nonce = input.nonce ?? crypto.getRandomValues(new Uint8Array(SEAL_NONCE_BYTES));
  if (nonce.length !== SEAL_NONCE_BYTES) return sealFailed(`the nonce is not ${SEAL_NONCE_BYTES} bytes`);
  const ct = xchacha20poly1305(input.key, nonce, sealAad(input.storeId, input.eventKey)).encrypt(
    input.plaintext,
  );
  const envelope: SealEnvelope = {
    pp_seal: SEAL_VERSION,
    alg: SEAL_ALG,
    kdf: SEAL_KDF,
    kid: keyId(input.key),
    nonce: b64u(nonce),
    ct: b64u(ct),
  };
  return ok(JSON.stringify(envelope));
};

export interface OpenInput {
  key: Uint8Array;
  storeId: string;
  eventKey: string;
  /** The envelope line, as bytes or text. */
  sealed: Uint8Array | string;
}

/** True when the bytes are a seal envelope's first claim (JSON with a `pp_seal` field), whether or not it opens. */
export const looksSealed = (sealed: Uint8Array | string): boolean => {
  try {
    const value: unknown = JSON.parse(typeof sealed === "string" ? sealed : new TextDecoder().decode(sealed));
    return typeof value === "object" && value !== null && Object.hasOwn(value, "pp_seal");
  } catch {
    return false;
  }
};

/** Opens a sealed event; every failure is catalog.seal-failed and nothing is guessed. */
export const open = (input: OpenInput): Result<Uint8Array> => {
  if (input.key.length !== 32) return sealFailed("the catalog key is not 32 bytes");
  let value: unknown;
  try {
    const text =
      typeof input.sealed === "string"
        ? input.sealed
        : new TextDecoder("utf-8", { fatal: true }).decode(input.sealed);
    value = JSON.parse(text);
  } catch {
    return sealFailed("the sealed event is not a JSON line");
  }
  const parsed = SealEnvelopeSchema.safeParse(value);
  if (!parsed.success) return sealFailed("the sealed event is not a seal envelope");
  const e = parsed.data;
  if (e.pp_seal !== SEAL_VERSION)
    return sealFailed(`the seal version ${e.pp_seal} is not known to this build`, "Update plainport");
  if (e.kdf !== SEAL_KDF)
    return sealFailed(`the key derivation "${e.kdf}" is not known to this build`, "Update plainport");
  if (e.alg !== SEAL_ALG)
    return sealFailed(`the cipher "${e.alg}" is not known to this build`, "Update plainport");
  if (e.kid !== keyId(input.key))
    return sealFailed("the event was sealed under another key (key id mismatch)");
  const nonce = fromB64u(e.nonce);
  const ct = fromB64u(e.ct);
  if (nonce?.length !== SEAL_NONCE_BYTES || ct === undefined)
    return sealFailed("the sealed event's nonce or ciphertext is malformed");
  try {
    return ok(xchacha20poly1305(input.key, nonce, sealAad(input.storeId, input.eventKey)).decrypt(ct));
  } catch {
    return sealFailed(
      "the sealed event failed authentication: it was changed, or belongs to another event or store",
    );
  }
};
