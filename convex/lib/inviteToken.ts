// ============================================================
// Invitation token utilities for Convex — the `convex/invitations.ts`
// counterpart to `src/lib/auth/invitations.ts`'s `generateInviteToken`/
// `hashInviteToken`. Same shape (32 CSPRNG bytes -> base64url token;
// SHA-256 hex digest of the token persisted, never the plaintext), but
// reimplemented against the Web Crypto API instead of Node's
// `node:crypto`.
//
// Why not just import from src/lib/auth/invitations.ts
// ------------------------------------------------------
// `invitations.create` is built on `accountMutation`, which wraps the
// plain `mutation` from `./_generated/server` — that runs in Convex's
// default (V8-isolate) function runtime, not Node. Node built-ins
// (`node:crypto`'s `createHash`/`randomBytes`, `Buffer`, ...) are only
// reachable from a file carrying a top-of-file `"use node"` directive,
// and `"use node"` files may only export `action`s — never a
// `mutation`/`query` — so that door is closed for a function that needs
// to be an `accountMutation`.
//
// `crypto.getRandomValues` (CSPRNG) and `crypto.subtle.digest`
// (SHA-256) are both part of the standard Web Crypto API, which IS
// available in Convex's default runtime without `"use node"` — this is
// the documented escape hatch for exactly this kind of "hash/generate a
// secret inside a regular mutation" need. `bytesToHex`/
// `bytesToBase64Url` below are hand-rolled for the same reason: `Buffer`
// isn't available either, only plain `Uint8Array`/`ArrayBuffer`.
// ============================================================

const HEX_CHARS = "0123456789abcdef";

// RFC 4648 §5 ("base64url") alphabet — same character set Node's
// `Buffer.from(bytes).toString("base64url")` produces (used on the
// Supabase side, src/lib/auth/invitations.ts), so a 32-byte token has
// the same 43-character shape regardless of which side minted it.
const BASE64URL_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += HEX_CHARS[byte >> 4] + HEX_CHARS[byte & 0x0f];
  }
  return out;
}

// Standard base64url encoding, no padding. Manual 3-bytes-in/4-chars-out
// loop (with a 1- or 2-byte tail) since `btoa`/`Buffer` aren't assumed
// available here.
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
 * Deterministic SHA-256 of a plaintext token, as a lowercase hex
 * digest — byte-for-byte identical output to
 * `src/lib/auth/invitations.ts`'s `hashInviteToken` (Node's
 * `createHash("sha256").update(token).digest("hex")`) for the same
 * input, since both are correct SHA-256 implementations. Used both to
 * hash a freshly-generated token in `invitations.create` and (by
 * callers, e.g. a future `/join/<token>` route) to turn a plaintext
 * token from a URL into the `tokenHash` that `invitations.peek`/
 * `invitations.redeem` key their lookup on.
 */
export async function hashInviteToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}

export interface GeneratedInviteToken {
  /** Plaintext token — return to the creator ONCE, never persist. */
  token: string;
  /** SHA-256 hex digest of the token. Persist this in the DB. */
  tokenHash: string;
}

/**
 * Generate a fresh invite token + its hash. 32 bytes of CSPRNG entropy
 * (same size as the Node-side generator), base64url-encoded to a
 * 43-character string. Call once per invite creation — the plaintext is
 * returned to the caller exactly once, the hash is what gets stored in
 * `accountInvitations.tokenHash`.
 */
export async function generateInviteToken(): Promise<GeneratedInviteToken> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = bytesToBase64Url(bytes);
  return { token, tokenHash: await hashInviteToken(token) };
}
