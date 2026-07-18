import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  extractLandingContent,
  isFetchableLandingUrl,
  landingUrlKey,
  LANDING_HTML_MAX,
} from "./lib/ai/adContext";

// ============================================================
// Ad landing-page cache (ad-aware AI replies) — fetches the page behind
// a CTWA referral's `source_url` and stores a prompt-ready extraction in
// `adLandingPages`, one row per (account, normalized URL). Warmed from
// `ingest.processInbound` on every referral-carrying inbound; read (and
// lazily re-warmed) by `aiReply`'s `loadAdContext` so the assistant's
// first reply can name the actual package the customer clicked.
//
// Everything here is best-effort by contract: `ensureFresh` never
// throws, and a failed fetch stores an `error` row (retried after a
// shorter TTL) while KEEPING the last good extraction — a temporarily
// down landing page must never blank context the assistant already had,
// and must never cost a reply.
// ============================================================

/** A good extraction is trusted this long before a refresh. */
const FRESH_OK_MS = 24 * 3_600_000;
/** A failed fetch is retried no sooner than this. */
const RETRY_ERROR_MS = 3_600_000;
/** A `pending` claim older than this is presumed dead (action crashed /
 *  timed out before `storeResult`) and may be taken over. */
const PENDING_TAKEOVER_MS = 120_000;
const FETCH_TIMEOUT_MS = 8_000;
/** Reject up front on Content-Length; pages this size are never landing
 *  pages. (The body read is additionally capped at `LANDING_HTML_MAX`.) */
const MAX_CONTENT_LENGTH_BYTES = 5_000_000;
/** Some hosts (fb.me permalinks included) serve bots a bare shell; a
 *  browsery UA with an honest product token gets the real page + og:
 *  metadata in practice. */
const FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; HolidayysCRM-AdContext/1.0; +https://wa.holidayys.co)";

/** The cache row for a normalized landing URL, or `null`. Callers use
 *  whatever content fields are present regardless of `status` — see the
 *  header on why an `error` row may still carry last-good content. */
export const get = internalQuery({
  args: { accountId: v.id("accounts"), urlKey: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("adLandingPages")
      .withIndex("by_account_url", (q) =>
        q.eq("accountId", args.accountId).eq("urlKey", args.urlKey),
      )
      .first();
  },
});

/**
 * Atomically decides whether the caller should fetch: claims (row
 * missing / ok-stale / error-stale / pending-stuck → flips to `pending`
 * under this mutation's transaction) or defers (`claimed: false` — a
 * fresh row exists or another fetch is already in flight). Two ingests
 * racing on the same ad URL do one fetch, not two.
 */
export const claimFetch = internalMutation({
  args: { accountId: v.id("accounts"), urlKey: v.string(), url: v.string() },
  handler: async (ctx, args): Promise<{ claimed: boolean }> => {
    const now = Date.now();
    const row = await ctx.db
      .query("adLandingPages")
      .withIndex("by_account_url", (q) =>
        q.eq("accountId", args.accountId).eq("urlKey", args.urlKey),
      )
      .first();
    if (!row) {
      await ctx.db.insert("adLandingPages", {
        accountId: args.accountId,
        urlKey: args.urlKey,
        url: args.url,
        status: "pending",
        fetchStartedAt: now,
      });
      return { claimed: true };
    }
    const fresh =
      row.status === "pending"
        ? now - row.fetchStartedAt < PENDING_TAKEOVER_MS
        : now - (row.fetchedAt ?? 0) <
          (row.status === "ok" ? FRESH_OK_MS : RETRY_ERROR_MS);
    if (fresh) return { claimed: false };
    await ctx.db.patch(row._id, {
      status: "pending",
      url: args.url,
      fetchStartedAt: now,
    });
    return { claimed: true };
  },
});

/**
 * Lands a fetch outcome on the claimed row. Success overwrites the whole
 * extraction (absent fields are removed); failure records `error` +
 * flips `status` but leaves the previous extraction fields untouched.
 */
export const storeResult = internalMutation({
  args: {
    accountId: v.id("accounts"),
    urlKey: v.string(),
    ok: v.boolean(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    content: v.optional(v.string()),
    finalUrl: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db
      .query("adLandingPages")
      .withIndex("by_account_url", (q) =>
        q.eq("accountId", args.accountId).eq("urlKey", args.urlKey),
      )
      .first();
    if (!row) return; // claim row vanished — nothing to land on
    if (args.ok) {
      await ctx.db.patch(row._id, {
        status: "ok",
        title: args.title,
        description: args.description,
        content: args.content,
        finalUrl: args.finalUrl,
        error: undefined,
        fetchedAt: Date.now(),
      });
    } else {
      await ctx.db.patch(row._id, {
        status: "error",
        error: args.error,
        fetchedAt: Date.now(),
      });
    }
  },
});

type FetchOutcome = {
  ok: boolean;
  title?: string;
  description?: string;
  content?: string;
  finalUrl?: string;
  error?: string;
};

/**
 * Ensure the cache holds a reasonably-fresh extraction for `url`,
 * fetching if (and only if) `claimFetch` says so. Safe to call
 * opportunistically — a fresh row costs one query + one no-op mutation.
 * Never throws (see the file header); under `CONVEX_AI_DRY_RUN` it
 * stores a synthetic extraction without touching the network, the same
 * offline-test convention as `aiReply.ts`'s `syntheticGeneration`.
 */
export const ensureFresh = internalAction({
  args: { accountId: v.id("accounts"), url: v.string() },
  handler: async (ctx, args): Promise<void> => {
    try {
      const urlKey = landingUrlKey(args.url);
      if (!urlKey || !isFetchableLandingUrl(args.url)) return;
      const { claimed } = await ctx.runMutation(internal.adLanding.claimFetch, {
        accountId: args.accountId,
        urlKey,
        url: args.url,
      });
      if (!claimed) return;

      let outcome: FetchOutcome;
      if (process.env.CONVEX_AI_DRY_RUN) {
        outcome = {
          ok: true,
          title: "[dry-run] landing page",
          content: `[dry-run] extracted content for ${args.url}`,
        };
      } else {
        outcome = await fetchAndExtract(args.url);
      }

      await ctx.runMutation(internal.adLanding.storeResult, {
        accountId: args.accountId,
        urlKey,
        ...outcome,
      });
    } catch (err) {
      console.warn("[adLanding] ensureFresh failed:", err);
    }
  },
});

/** The network half of `ensureFresh` — always resolves to an outcome. */
async function fetchAndExtract(url: string): Promise<FetchOutcome> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": FETCH_USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
      return { ok: false, error: `unsupported content-type: ${contentType}` };
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_CONTENT_LENGTH_BYTES) {
      return { ok: false, error: "response too large" };
    }
    const html = (await response.text()).slice(0, LANDING_HTML_MAX);
    const { title, description, content } = extractLandingContent(html);
    if (!title && !description && !content) {
      return { ok: false, error: "no extractable content" };
    }
    return {
      ok: true,
      title: title ?? undefined,
      description: description ?? undefined,
      content: content ?? undefined,
      finalUrl: response.url && response.url !== url ? response.url : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
