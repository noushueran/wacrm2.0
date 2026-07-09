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
