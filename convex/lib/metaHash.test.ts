import { expect, test } from "vitest";
import {
  hashedEmail,
  hashedPhone,
  normalizeEmailForMeta,
  normalizePhoneForMeta,
  sha256Hex,
} from "./metaHash";

// The four spellings the CAPI spec calls out as the ones that MUST NOT
// produce different digests. This is the whole point of normalizing
// before hashing, so it is pinned as one assertion over the set rather
// than four independent cases that could drift apart.
test("every spelling of one UAE number normalizes to the same digits", async () => {
  const variants = [
    "+971585824488",
    "971 58 582 4488",
    "+971-58-582-4488",
    "971585824488",
  ];
  for (const v of variants) {
    expect(normalizePhoneForMeta(v)).toBe("971585824488");
  }
  const digests = await Promise.all(variants.map(hashedPhone));
  expect(new Set(digests).size).toBe(1);
});

// Meta strips leading zeros before hashing its copy; we must too, or a
// number entered in local trunk form matches nobody.
test("leading zeros are stripped", () => {
  expect(normalizePhoneForMeta("0585824488")).toBe("585824488");
  expect(normalizePhoneForMeta("00971585824488")).toBe("971585824488");
});

// Distinct from convex/lib/phone.ts's normalizePhone, which deliberately
// KEEPS the trunk zero for our own dedup lookups. If someone ever
// "unifies" the two, this is the test that fails.
test("differs from the CRM's own normalizePhone on the trunk zero", async () => {
  const { normalizePhone } = await import("./phone");
  expect(normalizePhone("0585824488")).toBe("0585824488");
  expect(normalizePhoneForMeta("0585824488")).toBe("585824488");
});

test("a phone with no digits yields no match key", async () => {
  expect(normalizePhoneForMeta("")).toBe("");
  expect(normalizePhoneForMeta("n/a")).toBe("");
  expect(normalizePhoneForMeta(undefined)).toBe("");
  // undefined, NOT a hash of "" — an empty-string digest is a valid-looking
  // match key that matches nobody.
  await expect(hashedPhone("n/a")).resolves.toBeUndefined();
  await expect(hashedPhone(null)).resolves.toBeUndefined();
});

// The floor is a REJECTION, not a formatting rule: a digest of "12345"
// is a perfectly valid-looking match key that matches nobody, and Meta
// reads a supplied-but-unmatchable key as evidence AGAINST match quality
// rather than as a neutral absence. Normalization still reports the
// digits it found — the gate is `hashedPhone`'s alone.
test("a number too short to carry a country code yields no match key", async () => {
  expect(normalizePhoneForMeta("12345")).toBe("12345");
  await expect(hashedPhone("12345")).resolves.toBeUndefined();
  // Exactly at the floor still hashes — the bound is inclusive.
  await expect(hashedPhone("1234567")).resolves.toBe(await sha256Hex("1234567"));
});

// The floor is applied AFTER the leading-zero strip, so the trunk zero
// cannot pad a 6-digit number over a 7-digit bound and smuggle in the
// very digest the floor exists to reject.
test("a trunk zero does not pad a short number over the floor", async () => {
  expect(normalizePhoneForMeta("0123456")).toBe("123456");
  await expect(hashedPhone("0123456")).resolves.toBeUndefined();
});

test("email is trimmed and lowercased, and nothing more", () => {
  expect(normalizeEmailForMeta("  John_Smith@Gmail.com ")).toBe(
    "john_smith@gmail.com",
  );
  // Meta does NOT canonicalize gmail dots or +tags — hashing a stripped
  // variant would digest an address Meta never computes.
  expect(normalizeEmailForMeta("john.smith+ads@gmail.com")).toBe(
    "john.smith+ads@gmail.com",
  );
});

test("a non-address yields no match key", async () => {
  expect(normalizeEmailForMeta("not-an-email")).toBe("");
  expect(normalizeEmailForMeta("a@b@c")).toBe("");
  expect(normalizeEmailForMeta(undefined)).toBe("");
  await expect(hashedEmail("not-an-email")).resolves.toBeUndefined();
});

// Pinned against the digests Meta's own parameter reference publishes for
// its worked examples. These are the only assertions here that prove we
// produce the encoding Meta compares against (SHA-256, lowercase hex)
// rather than merely a self-consistent one.
//
// Note the "1" in the phone input. Meta's worked example writes the
// number as (650)555-1212 and hashes 16505551212 — it prepends the US
// country code as part of "phone numbers must include a country code",
// which is a statement about the INPUT, not a normalization step. This
// function deliberately does not invent one: it cannot know a bare
// 10-digit number is American, and guessing would mint a digest for a
// person in the wrong country. Callers must supply an
// already-country-coded number, which every WhatsApp `wa_id` is.
test("matches Meta's published example digests", async () => {
  await expect(hashedPhone("1 (650) 555-1212")).resolves.toBe(
    "e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176",
  );
  await expect(hashedEmail("John_Smith@gmail.com")).resolves.toBe(
    "62a14e44f765419d10fea99367361a727c12365e2520f32218d505ed9aa0f62f",
  );
});

// The country code is NOT invented. A bare national number hashes to
// itself, and that digest is not the country-coded one — the guard
// against a future "helpfully" defaulting to +1 or +971.
test("no country code is inferred for a bare national number", async () => {
  expect(normalizePhoneForMeta("(650)555-1212")).toBe("6505551212");
  await expect(hashedPhone("(650)555-1212")).resolves.not.toBe(
    "e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176",
  );
});

test("sha256Hex is lowercase hex of the expected length", async () => {
  const digest = await sha256Hex("abc");
  expect(digest).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
});
