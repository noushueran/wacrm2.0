/**
 * WhatsApp access-token / AI-provider-key encryption — Convex port of
 * the AES-256-GCM (+ legacy AES-256-CBC, decrypt-only) cipher in
 * `src/lib/whatsapp/encryption.ts`, reimplemented against the Web
 * Crypto API (`crypto.subtle`) instead of Node's `node:crypto`, for the
 * same reason `convex/lib/inviteToken.ts` and `convex/lib/apiKey.ts` do
 * this: Convex functions built on `accountQuery`/`accountMutation`/
 * `internalQuery`/`internalMutation` (like `convex/metaSend.ts`'s
 * actions, and `convex/aiConfig.ts`'s mutation/query below) run in
 * Convex's default (V8-isolate) function runtime, and reaching for
 * `"use node"` should be a last resort — Web Crypto's AES-GCM/AES-CBC
 * support (`crypto.subtle.encrypt`/`.decrypt`) covers this cleanly, no
 * `"use node"` needed (and `"use node"` files may only export
 * `action`s, never a `query`/`mutation`, which `aiConfig.upsert` must
 * be). Wire format both directions use (see the original file's header
 * for the full rationale):
 *
 *   GCM (current):  `<iv-hex>:<ciphertext-hex>:<authTag-hex>` (3 parts)
 *   CBC (legacy):    `<iv-hex>:<ciphertext-hex>`               (2 parts,
 *                     decrypt-only — `encrypt` below never produces this)
 *
 * `decrypt` (+ the `isLegacyFormat` structural check) was the original
 * Phase 6 port, from back when `convex/whatsappConfig.ts`'s `upsert`
 * only ever needed to read a token back out (in `metaSend.ts`) —
 * encrypting `accessToken` at rest was, at the time, an
 * application-layer (Next.js API route) concern that happened BEFORE
 * `upsert` was ever called. `encrypt` was ported in Phase 7 for
 * `convex/aiConfig.ts`: its `upsert` mutation receives a caller's
 * PLAINTEXT BYO provider key directly over the wire and must encrypt
 * it itself before the row is ever written — there is no app-layer
 * route in front of it. Phase 8 Task 3 then moved `convex/
 * whatsappConfig.ts`'s `upsert` onto this exact same `encrypt` call
 * for `accessToken` too (its settings form now talks to Convex
 * directly, so the old app-layer encryption step no longer exists
 * upstream of it) — both mutations now share this one `encrypt`/
 * `decrypt` pair rather than each owning their own.
 *
 * The one real wire-format difference from Node's `crypto` module:
 * Node's GCM cipher/decipher take the auth tag separately
 * (`cipher.getAuthTag()` / `decipher.setAuthTag()`), while Web Crypto's
 * `subtle.encrypt`/`.decrypt` always treat it as appended to the END of
 * the ciphertext bytes — `ciphertext || tag`. `encrypt` below SPLITS
 * that combined output back into separate ciphertext/tag hex segments
 * (so the stored string matches what Node's `cipher.getAuthTag()` would
 * have produced separately); `decrypt` does the reverse, concatenating
 * the two before calling `subtle.decrypt` — so a ciphertext produced by
 * the ORIGINAL Node-side `encrypt()` decrypts identically here, AND a
 * ciphertext produced by THIS file's `encrypt()` decrypts identically
 * under the ORIGINAL Node-side `decrypt()` — verified in
 * `whatsappEncryption.test.ts` against fixtures generated with the real
 * `node:crypto` module (proving actual cross-runtime compatibility),
 * not just a Web-Crypto round-trip of itself.
 *
 * `ENCRYPTION_KEY` is the same 64-hex-char (32-byte) shared secret the
 * Next.js app reads via `process.env.ENCRYPTION_KEY` (see
 * `vitest.config.ts`'s dummy value, shared by every test project). The
 * deployed Convex project must have the IDENTICAL value configured
 * (`npx convex env set ENCRYPTION_KEY ...`) or encrypting/decrypting
 * real `whatsappConfig`/`aiConfigs` rows will fail — see this task's
 * report for this cross-deployment-config caveat.
 */

const GCM_IV_LENGTH = 12;
const CBC_IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// Explicit `Uint8Array<ArrayBuffer>` (not bare `Uint8Array`, which
// defaults its generic to `ArrayBufferLike` — a union that also
// includes `SharedArrayBuffer`) on every function below that produces
// or consumes key/IV/ciphertext bytes. Web Crypto's `crypto.subtle.*`
// methods take `BufferSource`, which requires the concrete `ArrayBuffer`
// variant; a bare `Uint8Array` return-type annotation would silently
// widen back to the incompatible `ArrayBufferLike` default and fail to
// typecheck at every `crypto.subtle.decrypt`/`importKey` call site.

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid hex string (odd length ${hex.length})`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`Invalid hex string (bad byte at offset ${i * 2})`);
    }
    bytes[i] = byte;
  }
  return bytes;
}

function concatBytes(
  a: Uint8Array,
  b: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function encryptionKeyBytes(): Uint8Array<ArrayBuffer> {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY environment variable is not set.");
  }
  return hexToBytes(key);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function importAesKey(
  bytes: Uint8Array<ArrayBuffer>,
  algorithm: "AES-GCM" | "AES-CBC",
  keyUsages: KeyUsage[],
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bytes,
    { name: algorithm },
    false,
    keyUsages,
  );
}

/**
 * Encrypt a plaintext string into the GCM wire format `decrypt` below
 * (and the Node-side `src/lib/whatsapp/encryption.ts`) both understand —
 * `<iv-hex>:<ciphertext-hex>:<authTag-hex>`. Used by
 * `convex/aiConfig.ts`'s `upsert` to encrypt a caller-supplied BYO
 * provider key (`apiKey`/`embeddingsApiKey`) before it's ever written to
 * `aiConfigs`. Always produces GCM, never legacy CBC — mirrors the
 * Node `encrypt()`'s own "New `encrypt()` output is always GCM" comment.
 * A fresh random IV is drawn every call (`crypto.getRandomValues`), so
 * encrypting the same plaintext twice never produces the same
 * ciphertext — see this file's header for how the auth tag is split
 * back out of Web Crypto's combined `ciphertext || tag` output.
 */
export async function encrypt(text: string): Promise<string> {
  const iv = randomBytes(GCM_IV_LENGTH);
  const key = await importAesKey(encryptionKeyBytes(), "AES-GCM", [
    "encrypt",
  ]);
  const combined = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: AUTH_TAG_LENGTH * 8 },
      key,
      new TextEncoder().encode(text),
    ),
  );
  const ciphertext = combined.slice(0, combined.length - AUTH_TAG_LENGTH);
  const tag = combined.slice(combined.length - AUTH_TAG_LENGTH);
  return `${bytesToHex(iv)}:${bytesToHex(ciphertext)}:${bytesToHex(tag)}`;
}

/**
 * Decrypt a ciphertext produced by `encrypt` above — used for both
 * `whatsappConfig.accessToken` (Phase 6) and `aiConfigs.apiKey`/
 * `embeddingsApiKey` (Phase 7). Auto-detects GCM (current, 3
 * colon-separated parts) vs legacy CBC (2 parts) by counting parts,
 * exactly like the original `decrypt()` — so a pre-GCM-migration row
 * (if one is ever carried over) still decrypts.
 */
export async function decrypt(encryptedText: string): Promise<string> {
  const parts = encryptedText.split(":");

  if (parts.length === 3) {
    const [ivHex, ctHex, tagHex] = parts as [string, string, string];
    const iv = hexToBytes(ivHex);
    if (iv.length !== GCM_IV_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected GCM IV length ${iv.length}`,
      );
    }
    const tag = hexToBytes(tagHex);
    if (tag.length !== AUTH_TAG_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected GCM auth-tag length ${tag.length}`,
      );
    }
    const ciphertext = hexToBytes(ctHex);
    // Web Crypto expects the auth tag appended to the ciphertext,
    // unlike Node's separate `setAuthTag()` — see this file's header.
    const combined = concatBytes(ciphertext, tag);
    const key = await importAesKey(encryptionKeyBytes(), "AES-GCM", [
      "decrypt",
    ]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: AUTH_TAG_LENGTH * 8 },
      key,
      combined,
    );
    return new TextDecoder().decode(plaintext);
  }

  if (parts.length === 2) {
    const [ivHex, ctHex] = parts as [string, string];
    const iv = hexToBytes(ivHex);
    if (iv.length !== CBC_IV_LENGTH) {
      throw new Error(
        `Encrypted token has unexpected CBC IV length ${iv.length}`,
      );
    }
    const ciphertext = hexToBytes(ctHex);
    const key = await importAesKey(encryptionKeyBytes(), "AES-CBC", [
      "decrypt",
    ]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  }

  throw new Error(
    `Encrypted token has unrecognised format (expected 1 or 2 colons, got ${
      parts.length - 1
    })`,
  );
}

/**
 * Cheap format detector — ported alongside `decrypt` since a future
 * token-refresh path may want to flag a legacy row for re-encryption
 * upstream. Does not attempt decryption; purely a structural check.
 */
export function isLegacyFormat(encryptedText: string): boolean {
  return encryptedText.split(":").length === 2;
}
