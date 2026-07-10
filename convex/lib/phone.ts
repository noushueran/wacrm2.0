// ============================================================
// Digits-only phone normalization — ported (not re-exported) from
// `src/lib/whatsapp/phone-utils.ts`'s `normalizePhone`. Convex bundles
// the `convex/` directory separately from `src/` at deploy time, so a
// cross-directory import isn't available there; this is a deliberate,
// behavior-identical copy, kept in lockstep with the original by the
// unit test in `./phone.test.ts` mirroring its cases.
// ============================================================

/**
 * Normalize a phone number by removing all non-digit characters. Used
 * for exact-match dedup lookups against `contacts.by_account_phone`.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "");
}

/**
 * Validate a (digits-only, post-`normalizePhone`) phone as E.164-like:
 * 7-15 digits, no leading zero. Ported (not re-exported — see this
 * file's header on why) from `src/lib/whatsapp/phone-utils.ts`'s
 * `isValidE164`, for `convex/apiV1.ts`'s public-API contact/message/
 * broadcast recipient validation, which needs the exact same "is this a
 * plausible phone number" check the REST layer always ran before this
 * migration.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone);
}
