import { expect, test } from "vitest";
import { API_KEY_PREFIX, generateApiKey, hashApiKey } from "./apiKey";

test("generateApiKey returns a prefixed plaintext, a 64-char hex hash, and a matching display prefix", async () => {
  const { plaintext, hash, prefix } = await generateApiKey();
  expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(prefix.startsWith(API_KEY_PREFIX)).toBe(true);
  expect(prefix.length).toBe(API_KEY_PREFIX.length + 8);
  // The display prefix is a true prefix of the plaintext.
  expect(plaintext.startsWith(prefix)).toBe(true);
});

test("generateApiKey never repeats a key (entropy sanity check)", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 50; i++) seen.add((await generateApiKey()).plaintext);
  expect(seen.size).toBe(50);
});

test("generateApiKey's hash matches an independent hashApiKey of the plaintext", async () => {
  const { plaintext, hash } = await generateApiKey();
  expect(await hashApiKey(plaintext)).toBe(hash);
});

test("hashApiKey is deterministic for the same input", async () => {
  expect(await hashApiKey("wacrm_live_abc")).toBe(
    await hashApiKey("wacrm_live_abc"),
  );
});

test("hashApiKey differs for different inputs", async () => {
  expect(await hashApiKey("wacrm_live_abc")).not.toBe(
    await hashApiKey("wacrm_live_abd"),
  );
});

test("hashApiKey matches Node's SHA-256 implementation on a known fixture", async () => {
  // Known fixture — `sha256("wacrm_live_abc")` hex digest, copied
  // verbatim from `src/lib/api-keys/keys.test.ts`'s own `hashApiKey`
  // "is deterministic" fixture input (Node's `createHash("sha256")`).
  // Both sides must produce byte-identical digests for the same input:
  // the Next.js dashboard mints/hashes a key with the Node
  // implementation, and a public-API request hashes the presented key
  // with THIS implementation to look it up via `apiKeys.lookupByHash` —
  // they only ever find the same row if the two hashes agree.
  expect(await hashApiKey("wacrm_live_abc")).toBe(
    "1eb8bbcf7fdffbecf02e2d1e22b022045ae7ba2fdd684293975d060cfebf8b91",
  );
});
