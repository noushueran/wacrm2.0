// ============================================================
// Which service did this ad advertise? A pure, database-free decision
// over the signals `ingest.processInbound` already captures for a
// click-to-WhatsApp referral (spec: docs/superpowers/specs/
// 2026-07-30-ad-referral-service-tagging-design.md §1).
//
// Deliberately silent rather than wrong: when two different services
// both match at the deciding level the answer is `ambiguous`, not a
// coin flip. The tag vocabulary this writes into is the same one lead
// routing keys on (`lib/qualification/routing.ts` matches a tag by
// service name), so a confident wrong answer costs more than no answer.
// ============================================================

/** Every ad-derived text we can match against, weakest field optional. */
export type MatchSignals = {
  headline?: string;
  body?: string;
  sourceUrl?: string;
  adName?: string;
  adSetName?: string;
  campaignName?: string;
  landingTitle?: string;
  landingDescription?: string;
  /** The customer's own words — supplied on the retry pass only. */
  customerText?: string;
};

export type SignalKey = keyof MatchSignals;

/** One `kbServices` row, reduced to what matching needs. */
export type ServiceCandidate = {
  key: string;
  name: string;
  aliases: string[];
  status: "active" | "paused";
};

export type MatchResult =
  | {
      status: "matched";
      serviceKey: string;
      serviceName: string;
      matchedOn: SignalKey;
    }
  /** Two or more distinct services tied at the deciding level. */
  | { status: "ambiguous" }
  /** No service term appeared in any signal. */
  | { status: "none" };

/**
 * Signals grouped by strength, strongest first. The FIRST group that
 * yields any hit decides the result — a hit in a later group never
 * overrides an earlier one. Ad/campaign names lead because a human
 * chose them to describe the ad; the customer's own text trails
 * because it arrives last and is the least controlled.
 */
const PRECEDENCE: SignalKey[][] = [
  ["adName", "adSetName", "campaignName"],
  ["headline"],
  ["landingTitle"],
  ["body", "landingDescription"],
  ["sourceUrl"],
  ["customerText"],
];

/**
 * Lowercase, strip diacritics, reduce every non-alphanumeric run to a
 * single space. Applied identically to haystack and needle so both sides
 * agree on what a "word" is.
 */
function normalize(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,()]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * A URL's own words: path + query only. The host is dropped — every ad
 * of every service shares it, so it can only produce false matches.
 */
function urlWords(raw: string): string {
  try {
    const url = new URL(raw);
    return normalize(`${url.pathname} ${url.search}`);
  } catch {
    return normalize(raw);
  }
}

export function matchService(
  signals: MatchSignals,
  services: ServiceCandidate[],
): MatchResult {
  const candidates = services
    .filter((s) => s.status === "active")
    .map((s) => ({
      key: s.key,
      name: s.name,
      // A service's name is itself a term, so a catalogue with no
      // aliases still matches ads that spell the service out.
      terms: [s.name, ...s.aliases].map(normalize).filter((t) => t.length > 0),
    }))
    .filter((c) => c.terms.length > 0);
  if (candidates.length === 0) return { status: "none" };

  for (const level of PRECEDENCE) {
    // Keyed by service so several terms of ONE service count once —
    // that is a stronger hit, not a tie.
    const hits = new Map<string, { name: string; matchedOn: SignalKey }>();

    for (const signal of level) {
      const raw = signals[signal];
      if (!raw) continue;
      const words = signal === "sourceUrl" ? urlWords(raw) : normalize(raw);
      if (!words) continue;
      // Space-padding both sides turns `includes` into a word-boundary
      // test without a per-term regex: " visa " cannot match inside
      // "revisage".
      const haystack = ` ${words} `;
      for (const candidate of candidates) {
        if (hits.has(candidate.key)) continue;
        if (candidate.terms.some((term) => haystack.includes(` ${term} `))) {
          hits.set(candidate.key, { name: candidate.name, matchedOn: signal });
        }
      }
    }

    if (hits.size === 1) {
      const [serviceKey, hit] = [...hits.entries()][0];
      return {
        status: "matched",
        serviceKey,
        serviceName: hit.name,
        matchedOn: hit.matchedOn,
      };
    }
    if (hits.size > 1) return { status: "ambiguous" };
  }

  return { status: "none" };
}
