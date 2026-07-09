// ============================================================
// API key generation + hashing for Convex — the `convex/apiKeys.ts`
// counterpart to `src/lib/api-keys/keys.ts`'s `generateApiKey`/
// `hashApiKey`. Same shape (`wacrm_live_` + 32 CSPRNG bytes, base64url-
// encoded; SHA-256 hex digest of the FULL plaintext persisted, never
// the plaintext itself; a short non-secret display prefix), but
// reimplemented against the Web Crypto API instead of Node's
// `node:crypto`, for exactly the reason `convex/lib/inviteToken.ts` is
// — see that file's header comment for the full explanation in one
// place: `apiKeys.create` is built on `accountMutation`, which wraps the
// plain `mutation` from `./_generated/server` and therefore runs in
// Convex's default (V8-isolate) function runtime, not Node. Node
// built-ins (`node:crypto`'s `createHash`/`randomBytes`, `Buffer`, ...)
// are only reachable from a file carrying a top-of-file `"use node"`
// directive, and `"use node"` files may only export `action`s — never a
// `mutation`/`query` — so that door is closed here too.
//
// `crypto.getRandomValues` (CSPRNG) and `crypto.subtle.digest`
// (SHA-256) are both part of the standard Web Crypto API, available in
// Convex's default runtime without `"use node"`. `bytesToHex`/
// `bytesToBase64Url` below are duplicated from `inviteToken.ts` rather
// than imported (matching this codebase's one-helper-per-file
// convention for small, self-contained crypto utilities) since `Buffer`
// isn't available here either, only plain `Uint8Array`/`ArrayBuffer`.
// ============================================================

const HEX_CHARS = "0123456789abcdef";

// RFC 4648 §5 ("base64url") alphabet — same character set Node's
// `Buffer.from(bytes).toString("base64url")` produces (used on the
// Supabase side, `src/lib/api-keys/keys.ts`), so a key minted by either
// side has the same 43-character body shape.
const BASE64URL_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Secret prefix on every key. Part of the plaintext, not a secret.
 * Mirrors `src/lib/api-keys/keys.ts`'s `API_KEY_PREFIX`.
 */
export const API_KEY_PREFIX = "wacrm_live_";

/**
 * Length of the non-secret display-prefix body shown in the dashboard —
 * mirrors `src/lib/api-keys/keys.ts`'s `DISPLAY_BODY_CHARS`. Enough to
 * tell two keys apart at a glance, far too little to brute-force the
 * remaining entropy.
 */
const DISPLAY_BODY_CHARS = 8;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX_CHARS[byte >> 4] + HEX_CHARS[byte & 0x0f];
  }
  return out;
}

// Standard base64url encoding, no padding. Manual 3-bytes-in/4-chars-out
// loop (with a 1- or 2-byte tail) since `btoa`/`Buffer` aren't assumed
// available here — byte-for-byte identical logic to
// `inviteToken.ts`'s `bytesToBase64Url`.
function bytesToBase64Url(bytes: Uint8Array): string {
  let result = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    result += BASE64URL_CHARS[(chunk >> 18) & 0x3f];
    result += BASE64URL_CHARS[(chunk >> 12) & 0x3f];
    result += BASE64URL_CHARS[(chunk >> 6) & 0x3f];
    result += BASE64URL_CHARS[chunk & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i]! << 16;
    result += BASE64URL_CHARS[(chunk >> 18) & 0x3f];
    result += BASE64URL_CHARS[(chunk >> 12) & 0x3f];
  } else if (remaining === 2) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    result += BASE64URL_CHARS[(chunk >> 18) & 0x3f];
    result += BASE64URL_CHARS[(chunk >> 12) & 0x3f];
    result += BASE64URL_CHARS[(chunk >> 6) & 0x3f];
  }
  return result;
}

/**
 * Deterministic SHA-256 hex digest of a plaintext key — byte-for-byte
 * identical output to `src/lib/api-keys/keys.ts`'s `hashApiKey` (Node's
 * `createHash("sha256").update(plaintext).digest("hex")`) for the same
 * input, since both are correct SHA-256 implementations. Used both to
 * hash a freshly-minted key in `generateApiKey` and (by a future
 * public-API auth path) to turn a caller-presented `Authorization`
 * header value into the `keyHash` that `apiKeys.lookupByHash` keys its
 * lookup on.
 */
export async function hashApiKey(plaintext: string): Promise<string> {
  const data = new TextEncoder().encode(plaintext);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

export interface GeneratedApiKey {
  /** Plaintext key — return to the creator ONCE, never persist. */
  plaintext: string;
  /** SHA-256 hex digest. Persist this in `apiKeys.keyHash`. */
  hash: string;
  /** Non-secret display string. Persist this in `apiKeys.keyPrefix`. */
  prefix: string;
}

/**
 * Generate a fresh API key + its hash + its display prefix. Call once
 * per key creation — the plaintext is returned to the creator exactly
 * once (in `apiKeys.create`'s response), the hash is what gets stored in
 * `apiKeys.keyHash`.
 */
export async function generateApiKey(): Promise<GeneratedApiKey> {
  // 32 bytes of CSPRNG entropy. base64url keeps it URL/header-safe and
  // shorter than hex (43 vs 64 chars) — same size as `inviteToken.ts`'s
  // token and as the Node-side `generateApiKey`'s `randomBytes(32)`.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const body = bytesToBase64Url(bytes);
  const plaintext = `${API_KEY_PREFIX}${body}`;
  return {
    plaintext,
    hash: await hashApiKey(plaintext),
    prefix: `${API_KEY_PREFIX}${body.slice(0, DISPLAY_BODY_CHARS)}`,
  };
}
