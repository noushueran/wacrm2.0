// ============================================================
// Meta CAPI customer-information normalization + hashing.
//
// Meta matches a server event back to a person through `user_data`. The
// identifier-style keys (`ctwa_clid`, `whatsapp_business_account_id`) go
// over the wire in the clear — Meta's parameter reference says of
// `ctwa_clid` exactly "Do not hash". Everything derived from PII
// (`ph`, `em`) must be normalized FIRST and then SHA-256'd, because Meta
// hashes its own copy the same way and compares the digests: a variant
// that differs by one space, one dash or one leading zero produces a
// completely different digest and simply fails to match. Normalizing
// after hashing is not a thing you can do, which is why these two steps
// live in one module and are applied in one place.
//
// Rules are Meta's, not ours (Conversions API → Parameters → Customer
// Information Parameters):
//   ph — "Remove symbols, letters, and any leading zeros. Phone numbers
//        must include a country code." (650)555-1212 → 16505551212
//   em — "Trim any leading and trailing spaces. Convert all characters
//        to lowercase." John_Smith@gmail.com → john_smith@gmail.com
//   both — SHA-256, lowercase hex.
//
// Pure + dependency-free apart from Web Crypto, which the default Convex
// runtime provides (`crypto`/`SubtleCrypto` are on its supported-web-APIs
// list), so this needs no `"use node"` and stays usable from the same V8
// action that does the delivery fetch.
// ============================================================

/**
 * A phone number in the shape Meta hashes: digits only, no leading zeros.
 *
 * The leading-zero strip is the part that is easy to get wrong and is
 * NOT what `convex/lib/phone.ts`'s `normalizePhone` does — that one is
 * for our own `by_account_phone` dedup lookups, where the trunk zero is
 * data we deliberately keep (see `phonesMatch`, which compensates for it
 * at compare time). Meta has no such compensation: it strips leading
 * zeros before hashing its copy, so we must strip them before hashing
 * ours or every UAE number written `0585824488` silently fails to match
 * the `971585824488` Meta holds.
 *
 * Returns "" for anything with no digits, which the caller treats as
 * "no match key available" rather than hashing the empty string — a
 * SHA-256 of "" is a perfectly valid-looking digest that matches nobody
 * and would quietly drag Event Match Quality down.
 */
export function normalizePhoneForMeta(phone: string | undefined | null): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "").replace(/^0+/, "");
}

/**
 * An email in the shape Meta hashes: trimmed and lowercased. No further
 * canonicalization — Meta does NOT strip Gmail dots or `+tags`, and doing
 * it here would produce a digest of an address Meta never computes.
 *
 * Returns "" when there is nothing that looks like an address, for the
 * same reason as above. The test is deliberately shallow (one `@` with
 * something either side): this is a "do we have a plausible match key"
 * gate, not address validation, and rejecting a deliverable oddity would
 * cost a match for no benefit.
 */
export function normalizeEmailForMeta(email: string | undefined | null): string {
  if (!email) return "";
  const trimmed = email.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(trimmed) ? trimmed : "";
}

/** SHA-256 as lowercase hex — the encoding Meta's examples show. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The hashed `ph` value for a raw phone, or `undefined` when the number
 * carries no usable digits. `undefined` rather than "" so the caller can
 * spread it away and omit the key entirely — Meta reads an empty-string
 * match key as a present-but-unmatchable one.
 */
export async function hashedPhone(
  phone: string | undefined | null,
): Promise<string | undefined> {
  const normalized = normalizePhoneForMeta(phone);
  return normalized ? await sha256Hex(normalized) : undefined;
}

/** The hashed `em` value for a raw email, or `undefined`. See `hashedPhone`. */
export async function hashedEmail(
  email: string | undefined | null,
): Promise<string | undefined> {
  const normalized = normalizeEmailForMeta(email);
  return normalized ? await sha256Hex(normalized) : undefined;
}
