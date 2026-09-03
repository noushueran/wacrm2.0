// When to offer "Install this app", and when to stop.
//
// The previous rule was: show it on the very first paint of the very
// first visit, and if the user taps the X once, never offer again on
// that device — a permanent boolean in localStorage. Both halves are
// wrong in the same direction. Someone who has not yet seen the product
// has no reason to install it, and someone dismissing a card while busy
// is saying "not now", not "never".

/** Visits before the card is offered at all. Two full sessions is enough
 *  to have read a chat and sent a reply — i.e. to know what is being
 *  installed — without nagging a first-time visitor. */
export const MIN_VISITS_BEFORE_OFFER = 3;

/** How long a dismissal lasts. Long enough that "not now" is respected,
 *  short enough that someone who has since made this their daily tool
 *  gets asked once more. */
export const DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const VISITS_KEY = "wacrm:pwa:visits";
export const DISMISSED_AT_KEY = "wacrm:pwa:install-dismissed-at";
/** The old permanent flag. Still read, never written — see `parseDismissedAt`. */
export const LEGACY_DISMISS_KEY = "wacrm:pwa:install-dismissed";

/**
 * Read the stored dismissal instant.
 *
 * Handles the legacy `"true"` boolean written by the previous version:
 * that value carries no timestamp, so there is no way to know whether it
 * is a day or a year old. Treating it as a dismissal that has just
 * expired is the honest reading — the user did say "not now" once, and
 * the whole point of this change is that "not now" stops meaning
 * "never". Anyone carrying the old flag is offered once more, then falls
 * under the normal TTL.
 */
export function parseDismissedAt(
  stored: string | null,
  legacy: string | null,
): number | null {
  if (stored !== null) {
    const at = Number(stored);
    return Number.isFinite(at) ? at : null;
  }
  if (legacy === "true") return null;
  return null;
}

export function parseVisits(stored: string | null): number {
  const n = Number(stored);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Should the install card be shown right now?
 *
 * `installed` short-circuits everything: an app already on the home
 * screen must never ask to be installed again.
 */
export function shouldOfferInstall(input: {
  installed: boolean;
  visits: number;
  dismissedAt: number | null;
  now: number;
}): boolean {
  if (input.installed) return false;
  if (input.visits < MIN_VISITS_BEFORE_OFFER) return false;
  if (input.dismissedAt === null) return true;
  return input.now - input.dismissedAt >= DISMISS_TTL_MS;
}
