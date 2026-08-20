/**
 * Splits message text into plain and link segments so the inbox can
 * render URLs as anchors instead of inert text.
 *
 * Why a pure splitter rather than a regex replace into
 * `dangerouslySetInnerHTML`: a large share of the text run through this
 * is INBOUND — written by whoever is on the other end of the WhatsApp
 * thread, i.e. fully attacker-controlled. Returning data for React to
 * render keeps its escaping intact, so no amount of markup in a customer
 * message can become live HTML. `buildHref` below is the second half of
 * that: it never echoes the matched text into `href`, it re-derives the
 * scheme, so a `javascript:` or `data:` URL cannot survive the trip.
 */

/**
 * Deliberately anchored to `http://`, `https://` and `www.` only.
 *
 * WhatsApp itself also linkifies bare domains (`example.com`), but
 * doing that here needs a TLD list to avoid turning "Booking confirmed.
 * Thanks" into a link on ".Thanks", and a wrong guess is worse than a
 * missed link: the text still reads fine unlinked, whereas a bogus
 * anchor in a customer thread looks broken. These three prefixes cover
 * how links are actually pasted into this CRM.
 */
const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<]+/gi;

/**
 * Sentence punctuation that follows a URL far more often than it belongs
 * to one — "see https://example.com/visa." must not link the period.
 * Closing brackets are handled separately (see `trimTrailing`) because
 * they legitimately appear inside URLs when balanced.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

export interface LinkSegment {
  type: "link";
  /** The URL as the sender typed it — what the anchor shows. */
  text: string;
  /** Always absolute and always http(s) — safe to put in `href`. */
  href: string;
}

export interface TextSegment {
  type: "text";
  text: string;
}

export type MessageSegment = TextSegment | LinkSegment;

/**
 * Strips punctuation the sender's sentence owns rather than the URL.
 * Unbalanced closing brackets go too, so "(see https://a.com/x)" links
 * `https://a.com/x`; balanced ones stay, so a URL that genuinely
 * contains `(...)` survives intact.
 */
function trimTrailing(url: string): string {
  let out = url;
  for (;;) {
    const before = out;
    out = out.replace(TRAILING_PUNCTUATION, "");
    const last = out.at(-1);
    if (last && ")]}".includes(last)) {
      const open = last === ")" ? "(" : last === "]" ? "[" : "{";
      const opens = out.split(open).length - 1;
      const closes = out.split(last).length - 1;
      if (closes > opens) out = out.slice(0, -1);
    }
    if (out === before) return out;
  }
}

/**
 * Re-derives the scheme instead of trusting the matched text, so the
 * value handed to `href` is always one this function chose. `www.`
 * matches are upgraded to https rather than http — every host worth
 * linking serves TLS, and downgrading would trip mixed-content warnings.
 */
function buildHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Returns `text` split into consecutive segments. Plain text always
 * round-trips exactly: joining every segment's `text` reproduces the
 * input, so nothing can be silently dropped from a message bubble.
 */
export function linkifyMessage(text: string): MessageSegment[] {
  if (!text) return [];

  const segments: MessageSegment[] = [];
  let cursor = 0;

  // `matchAll` over a fresh regex each call — URL_PATTERN is /g/, and
  // sharing `lastIndex` across calls would make results depend on which
  // bubble rendered first.
  for (const match of text.matchAll(new RegExp(URL_PATTERN))) {
    const raw = match[0];
    const start = match.index;
    const url = trimTrailing(raw);

    // Trimming can empty the match (a bare "www." with nothing after);
    // leave it as plain text rather than emitting a link to nowhere.
    if (!url) continue;

    if (start > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, start) });
    }
    segments.push({ type: "link", text: url, href: buildHref(url) });
    cursor = start + url.length;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }
  return segments;
}
