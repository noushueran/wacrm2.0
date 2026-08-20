/**
 * Contact avatar appearance — the fallback shown when a contact has no
 * uploaded photo, which is the overwhelming majority of them.
 *
 * WhatsApp is why this module exists. The Cloud API never gives us a
 * customer's profile picture: an inbound webhook carries `profile.name`
 * and `wa_id` and nothing else (see `convex/lib/whatsapp/webhookParse.ts`),
 * and Meta exposes no endpoint to fetch one — the only profile-picture
 * endpoint on the Graph API is `whatsapp_business_profile`, which is OUR
 * OWN business avatar. So a real photo only ever arrives when a teammate
 * uploads one by hand, and every other contact needs a fallback that looks
 * deliberate rather than broken.
 *
 * Pure and framework-free on purpose: colour and initials are derived, not
 * stored, so they need no migration, no backfill and no per-contact write.
 */

/** Tailwind class pairs for the fallback disc. Tinted backgrounds with a
 *  matching text colour, so one entry reads correctly in both themes
 *  without a `dark:` background variant (the /15 tint sits on whatever the
 *  surface is). Red is deliberately absent: this app already spends red on
 *  expired windows and destructive actions, and a contact whose avatar
 *  happens to hash red reads as an alert. */
const PALETTE = [
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
  "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300",
  "bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300",
] as const;

/** FNV-1a (32-bit). Chosen over `hashCode`-style `h*31+c` for its much
 *  better avalanche on short, highly-similar inputs — which is exactly
 *  what phone numbers are: an account's contacts often share a country
 *  and carrier prefix and differ only in the last few digits. `>>> 0`
 *  keeps every step unsigned so the result never depends on JS's signed
 *  32-bit coercion in `|`. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Canonicalise a colour seed so the same contact hashes identically no
 * matter which phone field a call site had to hand.
 *
 * This matters because the call sites genuinely differ: the conversation
 * list holds `contact.phone_normalized` ("971501234567") while the chat
 * header only has the display `phone` ("+971 50 123 4567"). Those are
 * different strings and would hash to different colours, so one contact
 * would change colour when you opened their thread — which reads as a
 * rendering bug. Digits-only collapses both onto one seed.
 *
 * Falls back to the raw string when there are no digits at all, so a
 * non-phone seed still gets a stable colour rather than all of them
 * sharing the empty string's.
 */
export function avatarSeed(seed: string): string {
  return seed.replace(/\D/g, "") || seed;
}

/**
 * Stable Tailwind class pair for a contact's fallback disc.
 *
 * Seed with something that does NOT change as the record is edited — the
 * phone, not the name. A contact who arrives as a bare number and is
 * named later should keep the same colour: the colour is a recognition
 * cue in a scrolling list, and one that reshuffles on an edit is worse
 * than no colour at all.
 */
export function avatarClasses(seed: string): string {
  return PALETTE[fnv1a(avatarSeed(seed)) % PALETTE.length];
}

/**
 * Up to two initials, or `""` when the name carries no letters at all.
 *
 * The empty case is the common one, not an edge case: `displayName` falls
 * back to the phone number for every contact WhatsApp gave us no profile
 * name for, and the first character of "+971 50 …" is "+" or "9" —
 * meaningless as an initial. Callers render a person glyph for `""`.
 *
 * Matches on `\p{L}` rather than `[A-Za-z]` because this account's
 * contacts are largely Arabic- and Malayalam-script names; `toUpperCase()`
 * is a no-op in both scripts, which is the correct behaviour there.
 */
export function contactInitials(displayName: string): string {
  const words = displayName
    .split(/[\s.,_-]+/)
    .filter((w) => /^\p{L}/u.test(w));
  if (words.length === 0) return "";
  const first = [...words[0]][0] ?? "";
  // Two initials only from two distinct words — "Priya" is "P", never
  // "PR". A trailing initial pulled out of the same word reads as a
  // typo rather than a monogram.
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}
