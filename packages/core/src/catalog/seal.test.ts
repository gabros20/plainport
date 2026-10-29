import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import vectors from "../../../../fixtures/seal/v1.json" with { type: "json" };
import { deriveSealKey, keyId, looksSealed, masterKeyMaterial, open, seal } from "./seal.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const unhex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (value: string) => new TextEncoder().encode(value);

const material = masterKeyMaterial(vectors.master);
if (!material.ok) throw new Error("fixture master key");
const key = unhex(vectors.keyHex);
const nonce = unhex(vectors.nonceHex);
const { storeId, eventKey, plaintext, sealed } = vectors;
const input = { key, storeId, eventKey, sealed };
const code = (result: { ok: boolean; finding?: { code: string } }) =>
  result.ok ? "ok" : result.finding?.code;

describe("seal: the catalog seal v1 test vectors", () => {
  test("the master key becomes encrypt ‖ mac.k ‖ mac.r", () => {
    expect(hex(material.value)).toBe(vectors.materialHex);
  });

  test("HKDF-SHA256 with the store id as salt gives the fixed key and key id", () => {
    const derived = deriveSealKey(material.value, storeId);
    expect(derived.ok && hex(derived.value)).toBe(vectors.keyHex);
    expect(keyId(key)).toBe(vectors.kid);
  });

  test("a fixed key, store id, event key and nonce give fixed bytes", () => {
    const result = seal({ key, storeId, eventKey, plaintext: bytes(plaintext), nonce });
    expect(result).toEqual({ ok: true, value: sealed });
  });

  test("the fixed bytes open to the event", () => {
    const opened = open(input);
    expect(opened.ok && text(opened.value)).toBe(plaintext);
  });

  test("a different store id derives a different key and key id", () => {
    const other = deriveSealKey(material.value, "another-store");
    expect(other.ok && hex(other.value)).not.toBe(vectors.keyHex);
    expect(other.ok && keyId(other.value)).not.toBe(vectors.kid);
  });
});

describe("seal: input keying material", () => {
  test("a master key of the wrong shape or length is refused", () => {
    const short = Buffer.alloc(31).toString("base64");
    expect(code(masterKeyMaterial({ encrypt: short, mac: vectors.master.mac }))).toBe("catalog.seal-failed");
    expect(code(masterKeyMaterial({ encrypt: vectors.master.encrypt }))).toBe("catalog.seal-failed");
    expect(code(masterKeyMaterial("not json"))).toBe("catalog.seal-failed");
    expect(
      code(masterKeyMaterial({ encrypt: vectors.master.encrypt, mac: { k: vectors.master.mac.r, r: "!!" } })),
    ).toBe("catalog.seal-failed");
  });

  test("material of any length but 64 bytes derives nothing", () => {
    expect(code(deriveSealKey(new Uint8Array(63), storeId))).toBe("catalog.seal-failed");
    expect(code(deriveSealKey(material.value, ""))).toBe("catalog.seal-failed");
  });

  test("the JSON text restic prints is read like the parsed object", () => {
    expect(masterKeyMaterial(JSON.stringify(vectors.master))).toEqual(material);
  });
});

describe("seal: every change fails closed", () => {
  const envelope = JSON.parse(sealed) as Record<string, string | number>;
  const reseal = (changes: Record<string, string | number>) => JSON.stringify({ ...envelope, ...changes });
  const flip = (field: "ct" | "nonce") => {
    const raw = new Uint8Array(Buffer.from(envelope[field] as string, "base64url"));
    raw[0] = (raw[0] ?? 0) ^ 1;
    return reseal({ [field]: Buffer.from(raw).toString("base64url") });
  };

  test("a flipped bit in the ciphertext or the nonce", () => {
    expect(code(open({ ...input, sealed: flip("ct") }))).toBe("catalog.seal-failed");
    expect(code(open({ ...input, sealed: flip("nonce") }))).toBe("catalog.seal-failed");
  });

  test("a changed kid", () => {
    expect(code(open({ ...input, sealed: reseal({ kid: "0000000000000000" }) }))).toBe("catalog.seal-failed");
  });

  test("a changed associated data: another event key or another store id", () => {
    expect(code(open({ ...input, eventKey: "meta/v1/events/01J8ZQ5A0B1C2D3E4F5G6H7J8M.json" }))).toBe(
      "catalog.seal-failed",
    );
    expect(code(open({ ...input, storeId: "another-store" }))).toBe("catalog.seal-failed");
  });

  test("a flipped bit in the associated data's inputs, byte by byte", () => {
    const flipped = new TextEncoder().encode(eventKey);
    flipped[flipped.length - 6] = (flipped[flipped.length - 6] ?? 0) ^ 1;
    expect(code(open({ ...input, eventKey: text(flipped) }))).toBe("catalog.seal-failed");
  });

  test("an unknown pp_seal, kdf or alg", () => {
    expect(code(open({ ...input, sealed: reseal({ pp_seal: 2 }) }))).toBe("catalog.seal-failed");
    expect(code(open({ ...input, sealed: reseal({ kdf: "hkdf-sha256-restic-master-v2" }) }))).toBe(
      "catalog.seal-failed",
    );
    expect(code(open({ ...input, sealed: reseal({ alg: "aes256gcm" }) }))).toBe("catalog.seal-failed");
  });

  test("an envelope with extra fields, a non-envelope, or a truncated line", () => {
    expect(code(open({ ...input, sealed: reseal({ extra: "x" }) }))).toBe("catalog.seal-failed");
    expect(code(open({ ...input, sealed: '{"v":1}' }))).toBe("catalog.seal-failed");
    expect(code(open({ ...input, sealed: sealed.slice(0, -10) }))).toBe("catalog.seal-failed");
  });

  test("another key never opens it, and no fallback key is tried", () => {
    const other = deriveSealKey(material.value, "another-store");
    if (!other.ok) throw new Error("derive");
    expect(code(open({ ...input, key: other.value }))).toBe("catalog.seal-failed");
  });

  test("looksSealed tells an envelope from a plain event", () => {
    expect(looksSealed(sealed)).toBe(true);
    expect(looksSealed(bytes(plaintext))).toBe(false);
    expect(looksSealed("not json")).toBe(false);
  });
});

describe("seal: round trips", () => {
  test("any plaintext, store id and event key opens to itself; a fresh nonce each time", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 512 }),
        fc.string({ minLength: 1 }),
        fc.string(),
        (data, store, event) => {
          const k = deriveSealKey(material.value, store);
          if (!k.ok) return false;
          const a = seal({ key: k.value, storeId: store, eventKey: event, plaintext: data });
          const b = seal({ key: k.value, storeId: store, eventKey: event, plaintext: data });
          if (!a.ok || !b.ok || a.value === b.value) return false;
          const opened = open({ key: k.value, storeId: store, eventKey: event, sealed: a.value });
          return opened.ok && hex(opened.value) === hex(data);
        },
      ),
      { numRuns: 1000 },
    );
  });

  test("any single flipped ciphertext bit fails", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), fc.nat(), (data, at) => {
        const s = seal({ key, storeId, eventKey, plaintext: data });
        if (!s.ok) return false;
        const env = JSON.parse(s.value) as { ct: string };
        const ct = new Uint8Array(Buffer.from(env.ct, "base64url"));
        const i = at % (ct.length * 8);
        ct[i >> 3] = (ct[i >> 3] ?? 0) ^ (1 << (i & 7));
        const changed = JSON.stringify({ ...env, ct: Buffer.from(ct).toString("base64url") });
        return !open({ key, storeId, eventKey, sealed: changed }).ok;
      }),
      { numRuns: 1000 },
    );
  });
});
