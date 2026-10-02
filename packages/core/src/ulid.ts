// ULIDs (ADR-0005): 48 bits of milliseconds, then 80 random bits, as 26 Crockford base32 characters, so ids sort
// by creation time. A small dependency-free implementation of https://github.com/ulid/spec; ids made in the same
// millisecond are not ordered among themselves (no monotonic mode), which nothing in plainport relies on.

import { z } from "zod";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;

/** Canonical form only: upper case, and a first character of at most 7 so the time fits in 48 bits. */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const UlidSchema = z
  .string()
  .regex(ULID_PATTERN)
  .meta({ title: "Ulid", description: "A ULID: 26 upper-case Crockford base32 characters" });

export const isUlid = (value: string): boolean => ULID_PATTERN.test(value);

const fillRandom = (bytes: Uint8Array): Uint8Array => crypto.getRandomValues(bytes);

/** A new ULID. `now` and `random` are for tests; `random` fills the 10 bytes it is given. */
export const ulid = (
  now: number = Date.now(),
  random: (bytes: Uint8Array) => Uint8Array = fillRandom,
): string => {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new RangeError(`ulid: time ${now} is not a whole number of milliseconds within 48 bits`);
  }
  let time = "";
  for (let rest = now, i = 0; i < 10; i++, rest = Math.floor(rest / 32)) {
    time = (ALPHABET[rest % 32] as string) + time;
  }
  // 80 random bits are exactly 16 characters of 5 bits.
  const bytes = random(new Uint8Array(10));
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let randomPart = "";
  for (let i = 0; i < 16; i++, bits >>= 5n)
    randomPart = (ALPHABET[Number(bits & 31n)] as string) + randomPart;
  return time + randomPart;
};
