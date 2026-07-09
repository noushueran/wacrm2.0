import { expect, test } from "vitest";
import { decrypt, isLegacyFormat } from "./whatsappEncryption";

// Fixtures generated with the ORIGINAL Node-side `encrypt()`
// (src/lib/whatsapp/encryption.ts's `aes-256-gcm`/`aes-256-cbc` via
// node:crypto) against the same dummy `ENCRYPTION_KEY` vitest.config.ts
// sets for every test project (all-zero 32-byte key). Using a
// Node-generated fixture — rather than round-tripping encrypt+decrypt
// entirely within Web Crypto — is the point: it proves real
// cross-runtime compatibility (Node encrypts in the Next.js app today,
// Convex/Web-Crypto decrypts here), which is the actual contract
// `metaSend.ts` depends on. Mirrors the fixture pattern in
// `convex/lib/apiKey.test.ts`'s "matches Node's SHA-256 implementation"
// test.
const PLAINTEXT = "test-meta-access-token-EAAG1234567890";
const GCM_FIXTURE =
  "4bb00dcbcb7206b90667ad0f:138fa319ef7c8fa511a22ffbf763cf8d30b2827e8932f1b4d64db3cb1fefa2cbd1a92dadf7:726f59a36d34ddf511007cbc89c27c53";
const CBC_FIXTURE =
  "c4a31ab448ccda9eed906b966f3410c0:48041fabea4cb7af3f62452f104e9f122ede6c98b1c576be6017e31bc19f0b0dcb9be6da6db4ac7bc8b3610507f597f8";

test("decrypt: decrypts a GCM ciphertext produced by the Node-side encrypt()", async () => {
  await expect(decrypt(GCM_FIXTURE)).resolves.toBe(PLAINTEXT);
});

test("decrypt: decrypts a legacy CBC ciphertext (2-part, no auth tag)", async () => {
  await expect(decrypt(CBC_FIXTURE)).resolves.toBe(PLAINTEXT);
});

test("decrypt: throws when a tampered GCM ciphertext fails the auth-tag check", async () => {
  const [iv, ct, tag] = GCM_FIXTURE.split(":") as [string, string, string];
  // Flip the last hex nibble of the ciphertext body — GCM must reject it
  // rather than silently returning garbled plaintext (the whole point
  // of using GCM over unauthenticated CBC — see the original file's
  // header comment on this).
  const flipped = ct.at(-1) === "0" ? "1" : "0";
  const tampered = `${iv}:${ct.slice(0, -1)}${flipped}:${tag}`;
  await expect(decrypt(tampered)).rejects.toThrow();
});

test("decrypt: throws on an unrecognised format (wrong number of colon-separated parts)", async () => {
  await expect(decrypt("only-one-part")).rejects.toThrow(/unrecognised format/);
  await expect(decrypt("a:b:c:d")).rejects.toThrow(/unrecognised format/);
});

test("decrypt: throws on a malformed GCM IV length", async () => {
  const [, ct, tag] = GCM_FIXTURE.split(":") as [string, string, string];
  await expect(decrypt(`aabb:${ct}:${tag}`)).rejects.toThrow(/IV length/);
});

test("decrypt: throws on a malformed GCM auth-tag length", async () => {
  const [iv, ct] = GCM_FIXTURE.split(":") as [string, string];
  await expect(decrypt(`${iv}:${ct}:aabb`)).rejects.toThrow(/auth-tag length/);
});

test("decrypt: throws on a malformed CBC IV length", async () => {
  const [, ct] = CBC_FIXTURE.split(":") as [string, string];
  await expect(decrypt(`aabb:${ct}`)).rejects.toThrow(/IV length/);
});

test("isLegacyFormat: true for a 2-part (CBC) ciphertext, false for a 3-part (GCM) one", () => {
  expect(isLegacyFormat(CBC_FIXTURE)).toBe(true);
  expect(isLegacyFormat(GCM_FIXTURE)).toBe(false);
});
