// ============================================================
// Ad-aware assistant context (CTWA) — pure helpers shared by the
// landing-page fetcher (`convex/adLanding.ts`) and the system-prompt
// builder (`lib/ai/defaults.ts`). No Convex imports, unit-tested
// offline like `lib/whatsapp/webhookParse.ts`.
//
// A Click-to-WhatsApp lead's first message is usually just "Hi" — the
// intent lives in the ad referral (headline / ad text / `source_url`).
// These helpers turn that referral's link into safe, bounded text the
// assistant can ground its FIRST reply in.
// ============================================================

/** What the prompt builder renders as the "Lead source" section:
 *  the stored `conversation.adReferral` fields plus (when the fetch
 *  succeeded) the extracted landing page behind `sourceUrl`. */
export type AdContext = {
  headline?: string;
  body?: string;
  sourceUrl?: string;
  landingTitle?: string;
  landingDescription?: string;
  landingContent?: string;
};

export const LANDING_TITLE_MAX = 300;
export const LANDING_DESCRIPTION_MAX = 600;
/** Cap on the STORED extraction (`adLandingPages.content`). */
export const LANDING_CONTENT_MAX = 4000;
/** Cap on what the prompt INJECTS from that stored content — tighter
 *  than storage so one landing page can't crowd out the rest of the
 *  system prompt. */
export const AD_LANDING_PROMPT_CONTENT_MAX = 2500;
/** Cap on the raw HTML parsed — anything beyond is dropped unread. */
export const LANDING_HTML_MAX = 500_000;
/** Body text shorter than this after stripping is a shell (login wall,
 *  JS-only page) — stored as absent rather than as junk "content". */
const LANDING_CONTENT_MIN = 80;
/** Stored as the `error` of an `adLandingPages` row whose fetch landed on
 *  a login/consent wall instead of the page the ad points at. A wall is a
 *  FAILURE, not an extraction: recording it through the error path is what
 *  keeps the last good extraction (see `adLanding.ts`'s `storeResult`) and
 *  what gets it retried after the shorter error TTL — which matters
 *  because Meta's wall is transient (the same `fb.me` link that walled us
 *  serves the real post minutes later). */
export const LANDING_LOGIN_WALL_ERROR = "login wall";

/**
 * Whether a referral-supplied URL is safe/sane to fetch server-side:
 * http(s) only, and never a loopback/intranet-looking host. The Convex
 * backend runs on the production VPS — a crafted `source_url` must not
 * become a probe of localhost or the VPS's private network (IP-literal
 * hosts are rejected outright; that's what ad links never legitimately
 * are).
 *
 * `fb.me` is deliberately NOT on a deny-list here, though half of what it
 * served production was a login wall. Measured 2026-08-25 over all 339
 * `fb.me` rows: every one resolves (Meta's own redirect) to
 * `www.facebook.com` — 230 to `/login/?next=<the post>`, 109 straight to
 * the post, whose og: metadata is the best ad grounding in the whole
 * cache ("2-Year Freelance Visa Service · from AED 5,980"). The split is
 * not per-link but per-attempt: re-fetching a link cached as a wall
 * returned the real post. So the wall is transient and belongs in the
 * retry path (`LANDING_LOGIN_WALL_ERROR`), not in a permanent refusal
 * that would forfeit the 32% that works. Following the wall's own `next`
 * param would not help either — it points back at the URL that just
 * redirected to the wall.
 */
export function isFetchableLandingUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname; // URL lowercases + strips brackets' content into `[…]` form
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // IPv4 literal
  if (host.includes(":") || host.startsWith("[")) return false; // IPv6 literal
  return true;
}

/** Query params that vary per click but never change the page — stripped
 *  so every click on one ad shares one cache row. */
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "msclkid", "igshid"]);

/**
 * Cache key for a landing URL: fragment dropped, tracking params
 * (`utm_*` + the click-id family) stripped, host case-normalized by
 * `URL` itself. Returns `null` when the input doesn't parse — callers
 * treat that as "no landing page".
 */
export function landingUrlKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  url.hash = "";
  for (const param of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(param) || TRACKING_PARAMS.has(param.toLowerCase())) {
      url.searchParams.delete(param);
    }
  }
  return url.toString();
}

/** Numeric first, named after, `&amp;` LAST — so "&amp;#39;" degrades to
 *  a literal "&#39;" being decoded once, never a double-decode surprise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => {
      const code = parseInt(n, 16);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/** Runs of blanks → one space, 3+ newlines → a blank line, trimmed. */
function collapseWhitespace(s: string): string {
  return s
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `content` of the first `<meta {attr}="{value}" …>` tag, entity-decoded
 *  and collapsed — attribute order (`content` before or after the name)
 *  doesn't matter. */
function metaContent(html: string, attr: "property" | "name", value: string): string | null {
  const tagRe = new RegExp(`<meta\\b[^>]*\\b${attr}\\s*=\\s*["']${value}["'][^>]*>`, "i");
  const tag = html.match(tagRe)?.[0];
  if (!tag) return null;
  const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1];
  if (!content) return null;
  const text = collapseWhitespace(decodeEntities(content));
  return text || null;
}

/** URL paths that ARE the wall rather than the page behind it. Matched on
 *  the URL a fetch actually LANDED on (`Response.url`), which is where
 *  Meta's redirect shows its hand: every walled `fb.me` row in production
 *  finished on `www.facebook.com/login/?next=<the real post>`. */
const LOGIN_WALL_PATHS = [
  "/login",
  "/log-in",
  "/signin",
  "/sign-in",
  "/accounts/login",
  "/accounts/signup",
  "/checkpoint",
  "/consent",
  "/privacy/consent",
];

/** Phrases that identify a wall on their own — full sentences no travel
 *  landing page writes by accident. */
const LOGIN_WALL_PHRASES = [
  /\blog\s?in(?:to)?\s+(?:to\s+)?(?:facebook|instagram)\b/i,
  /\byou must log in to continue\b/i,
  // Apostrophe class, not a literal: Meta serves the typographic ’ and
  // `decodeEntities` passes it straight through.
  /\bthis content isn['’]t available right now\b/i,
  /\bsorry, this page isn['’]t available\b/i,
];

/** Login-FORM furniture. Any one of these can appear on a real page (a
 *  site with a customer portal has a "Forgot password?" link), so two are
 *  required — which is what separates Meta's wall (four of them) from an
 *  ad post whose body merely starts with a "Log In" button. */
const LOGIN_FORM_PHRASES = [
  /\bemail or (?:mobile|phone) number\b/i,
  /\bphone number, username,? or email\b/i,
  /\bforgot(?:ten)? (?:your )?password\b/i,
  /\bcreate (?:a )?new account\b/i,
  /\bsign up for (?:facebook|instagram)\b/i,
  /\blog in to continue\b/i,
];

/** A password field, language-independently. Meta localizes its wall to
 *  the fetcher's region — the same URL that returns "Log into Facebook"
 *  from the VPS returns "تسجيل الدخول إلى فيسبوك" from Dubai — so the
 *  phrase lists above cannot be the only signal. This one holds in every
 *  locale. */
const PASSWORD_INPUT_RE = /<input\b[^>]*\btype\s*=\s*["']?password\b/i;

/** Above this much body text, a password field is a login box ON a page
 *  (a portal, a members' area) rather than a page that IS a login box.
 *  Meta's wall lands around 520-580 chars in the locales seen. */
const LOGIN_WALL_BODY_MAX = 1500;

/**
 * Whether `text` reads as a login/consent wall rather than page content.
 * Fed the title, description and body together: Facebook's wall gives
 * itself away in the og: metadata ("Log into Facebook to start sharing…")
 * as readily as in its body.
 *
 * English phrases only, deliberately — this is the check that still works
 * on a STORED row, where the HTML is long gone. The localization-proof
 * signals (`PASSWORD_INPUT_RE`, and the landed-on URL) run at fetch time,
 * where they have more to work with.
 */
export function looksLikeLoginWall(text: string | null | undefined): boolean {
  if (!text) return false;
  if (LOGIN_WALL_PHRASES.some((re) => re.test(text))) return true;
  return LOGIN_FORM_PHRASES.filter((re) => re.test(text)).length >= 2;
}

/** Whether a URL IS a login/consent wall (see `LOGIN_WALL_PATHS`). */
export function isLoginWallUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  return LOGIN_WALL_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Whether a STORED `adLandingPages` row is a wall rather than the ad's
 * page — the read-side twin of the write-side rejection in
 * `adLanding.ts`. Both exist because rows written before the rejection
 * landed (230 of them in production) still hold wall text, and the
 * keep-last-good rule means nothing ever overwrites it; the reply path
 * has to recognize the junk it is handed, not just stop creating more.
 */
export function isLoginWallLanding(landing: {
  title?: string | null;
  description?: string | null;
  content?: string | null;
  finalUrl?: string | null;
}): boolean {
  if (landing.finalUrl && isLoginWallUrl(landing.finalUrl)) return true;
  return looksLikeLoginWall(
    [landing.title, landing.description, landing.content].filter(Boolean).join("\n"),
  );
}

/**
 * Whether stored `content` carries a serialized data blob rather than page
 * text — the residue of a truncated inline `<script>`, which
 * `extractLandingContent` now strips but which 179 rows written before it
 * still hold (measured 2026-08-25: every surviving row WITH content was
 * this, and none held real prose).
 *
 * The blob is not always at the start: Facebook post pages prefix it with
 * their own chrome ("Log In\n\nAmani Travel & Tourism UAE's Post"), so this
 * looks for the blob's opening ANYWHERE and then tests density. Prose is
 * not one-fifth structural punctuation; Meta's bundle head
 * (`{"require":[["ScheduledServerJS","handle",null,[{"__bbox"…`) is roughly
 * a third.
 *
 * Callers clear the whole `content` field on a hit rather than truncating
 * at the blob. That is not a shortcut — it is what the fixed extractor
 * produces for these very pages today: strip the unterminated script and
 * the surviving prefix is ~40 chars of button text, below
 * `LANDING_CONTENT_MIN`, so `content` comes out `null` either way.
 *
 * Kept deliberately narrow: this decides whether to DISCARD an account's
 * landing copy, so a heuristic that could misread real text is worse than
 * one that misses a novel variant.
 */
export function looksLikeSerializedJunk(text: string | null | undefined): boolean {
  if (!text) return false;
  // A structural opener — `{"`, `[[`, `[{`, `{{` — not a lone brace, which
  // ordinary copy ("{Special offer} …") does use.
  const start = text.search(/[[{]["[{]/);
  if (start < 0) return false;
  const head = text.slice(start, start + 200);
  if (head.length < 40) return false; // a brace pair near the end is not a bundle
  const structural = head.match(/["{}[\]:,]/g)?.length ?? 0;
  return structural / head.length > 0.2;
}

export type LandingExtract = {
  title: string | null;
  description: string | null;
  content: string | null;
  /** The page is a login/consent wall — callers must store this as a
   *  failure, never as an extraction. */
  loginWall: boolean;
};

/**
 * Regex-level HTML → prompt-safe text. Deliberately dependency-free: the
 * goal is "what does this page say the offer is", not a faithful DOM —
 * og: metadata first (server-rendered even on script-heavy pages, and on
 * fb.me ad permalinks), then a stripped-and-collapsed body text capped at
 * `LANDING_CONTENT_MAX`. Everything returned is already decoded,
 * collapsed, and length-capped; empty results are `null`, and a body
 * under `LANDING_CONTENT_MIN` chars (a login wall / JS shell) is treated
 * as no content at all.
 *
 * `loginWall` reports the page Meta serves an unauthenticated fetcher in
 * place of the ad's own post. It is a property of the PAGE, so it is
 * detected here; what to do about it (never store it) belongs to
 * `adLanding.ts`.
 */
export function extractLandingContent(htmlRaw: string): LandingExtract {
  const html = htmlRaw.slice(0, LANDING_HTML_MAX);

  const title =
    metaContent(html, "property", "og:title") ??
    (() => {
      const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
      if (!t) return null;
      const text = collapseWhitespace(decodeEntities(t));
      return text || null;
    })();

  const description =
    metaContent(html, "property", "og:description") ??
    metaContent(html, "name", "description") ??
    metaContent(html, "name", "twitter:description");

  const body = collapseWhitespace(
    decodeEntities(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<template[\s\S]*?<\/template>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        // An opener still standing after the paired strips above has no
        // closer left in `html` — almost always because the page is
        // bigger than `LANDING_HTML_MAX` and the slice landed mid-tag.
        // Everything from it to the end is unterminated markup, and
        // without this the tag-stripper turns the tail of Meta's inline
        // JSON bundle into 4000 chars of `{"require":[["ScheduledServerJS"…`
        // "content" — which is what every Instagram and Facebook post row
        // in production actually held.
        .replace(/<(?:script|style|noscript|template|svg)\b[^>]*>[\s\S]*$/i, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<head[\s\S]*?<\/head>/i, " ")
        // Block-level closers become line breaks so headings/paragraphs
        // stay readable after tag-stripping.
        .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    ),
  );

  return {
    title: title ? title.slice(0, LANDING_TITLE_MAX) : null,
    description: description ? description.slice(0, LANDING_DESCRIPTION_MAX) : null,
    content: body.length >= LANDING_CONTENT_MIN ? body.slice(0, LANDING_CONTENT_MAX) : null,
    loginWall:
      looksLikeLoginWall([title, description, body].filter(Boolean).join("\n")) ||
      (PASSWORD_INPUT_RE.test(html) && body.length <= LOGIN_WALL_BODY_MAX),
  };
}
