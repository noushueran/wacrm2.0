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

/**
 * Whether a referral-supplied URL is safe/sane to fetch server-side:
 * http(s) only, and never a loopback/intranet-looking host. The Convex
 * backend runs on the production VPS — a crafted `source_url` must not
 * become a probe of localhost or the VPS's private network (IP-literal
 * hosts are rejected outright; that's what ad links never legitimately
 * are).
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

export type LandingExtract = {
  title: string | null;
  description: string | null;
  content: string | null;
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
  };
}
