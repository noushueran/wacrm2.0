import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  extractLandingContent,
  isFetchableLandingUrl,
  isLoginWallLanding,
  isLoginWallUrl,
  landingUrlKey,
  LANDING_HTML_MAX,
  LANDING_LOGIN_WALL_ERROR,
  looksLikeSerializedJunk,
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
//
// "Failed" includes landing on a login/consent wall (`fetchAndExtract`,
// `LANDING_LOGIN_WALL_ERROR`): Meta hands an unauthenticated fetcher its
// login page for the very `fb.me`/Instagram permalinks CTWA ads point at,
// and that page must never be cached as if it were the ad's own copy.
// ============================================================

/** A good extraction is trusted this long before a refresh. */
const FRESH_OK_MS = 24 * 3_600_000;
/** A failed fetch is retried no sooner than this. */
const RETRY_ERROR_MS = 3_600_000;
/** A `pending` claim older than this is presumed dead (action crashed /
 *  timed out before `storeResult`) and may be taken over. */
const PENDING_TAKEOVER_MS = 120_000;
/** Generous on purpose (2026-07-18 live test): a Cloudflare-fronted
 *  origin that's slow — or erroring, a 522 takes ~15-30s to surface —
 *  blew an 8s budget and cached only "AbortError" instead of the real
 *  story. The ingest-time prefetch is async (scheduled), so this costs
 *  nothing in the common path; the dispatch-side inline ensure is rare
 *  (cache misses only) and retry-gated by `RETRY_ERROR_MS` after that. */
const FETCH_TIMEOUT_MS = 20_000;
/** Reject up front on Content-Length; pages this size are never landing
 *  pages. (The body read is additionally capped at `LANDING_HTML_MAX`.) */
const MAX_CONTENT_LENGTH_BYTES = 5_000_000;
import { brandName, brandSiteUrl } from "./lib/brand";
/** Some hosts (fb.me permalinks included) serve bots a bare shell; a
 *  browsery UA with an honest product token gets the real page + og:
 *  metadata in practice. */
function fetchUserAgent(): string {
  // A FUNCTION, not a module-level const: `brandName()` throws when the
  // deployment has no BRAND_NAME, and at module scope that throw would
  // break every Convex function importing this file rather than the one
  // fetch that needs the header.
  return `Mozilla/5.0 (compatible; ${brandName()}CRM-AdContext/1.0; +${brandSiteUrl()})`;
}

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

/** Rows per `clearJunkLandingContent` transaction. Small table, no
 *  secondary reads — the default is the same 200 the other backfills use. */
const DEFAULT_CLEANUP_BATCH = 200;

/**
 * One-shot cleanup for the two kinds of junk written before this module
 * learned to reject them. Measured over production's 439 rows on
 * 2026-08-25 — and worth stating plainly, because it is the whole reason
 * this exists: NOT ONE row held real page text.
 *
 *   - 253 login walls (`isLoginWallLanding`) — everything about the row is
 *     the wall, so all three text fields go and the row takes the same
 *     `error: "login wall"` a fetch would record today.
 *   - 179 truncated-`<script>` JSON blobs (`looksLikeSerializedJunk`) —
 *     only `content` is junk. `title`/`description` are the ad's own offer
 *     copy and the best grounding in the cache, so the row stays `ok` and
 *     keeps them; just the blob is dropped.
 *   - 7 rows with no content at all, left alone.
 *
 * Neither kind heals on its own. A wall row is `status: "ok"`, so it sits
 * trusted for the full 24h TTL, and the keep-last-good rule means even the
 * failure that eventually replaces it leaves the text in place forever. A
 * junk-content row does re-fetch clean once its TTL lapses, but only if
 * that ad is clicked again — and until then any FUTURE reader of
 * `adLandingPages.content` would have to re-derive both guards to avoid
 * what is already stored. `loadAdContext` does exactly that today; this
 * mutation is what lets the next reader not have to.
 *
 * Deliberately does NOT touch `fetchedAt`. On a cleared wall row the old
 * timestamp is now read against the 1h error TTL rather than the 24h ok
 * TTL, so the row is re-claimable at the next ad click and refills itself
 * with the real post instead of staying blank. `finalUrl` is kept as the
 * ops breadcrumb for why a row was cleared; rows are patched, not deleted,
 * so nothing a later good fetch would not overwrite anyway is destroyed.
 *
 * Internal, paginated, and idempotent — an already-cleared row matches
 * neither branch's "has something to clear" test, so `walls: 0,
 * junkContent: 0` on a second pass is the signal the cleanup is complete.
 * It reads no other table and patches each row in place from that row's
 * own `_id`, so the table-wide scan carries no cross-tenant hazard and two
 * overlapping runs cannot double-count anything. Pass `dryRun` for the
 * counts without writing.
 *
 * Lives here rather than in its own `*Backfill.ts` module (the convention
 * `inboxBackfill.ts`/`adServiceBackfill.ts` set) for one practical reason:
 * a new `convex/` module is not in the committed `_generated/api.d.ts`
 * until the owner runs codegen, and `generatedApi.test.ts` fails on that
 * drift. It shares both detectors with the guards it cleans up after,
 * which is the next-best home.
 *
 * DELETE THIS MUTATION once a pass reports nothing left to clear.
 */
export const clearJunkLandingContent = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    cursor: string;
    isDone: boolean;
    scanned: number;
    walls: number;
    junkContent: number;
  }> => {
    const page = await ctx.db.query("adLandingPages").paginate({
      cursor: args.cursor ?? null,
      numItems: args.batchSize ?? DEFAULT_CLEANUP_BATCH,
    });

    let walls = 0;
    let junkContent = 0;
    for (const row of page.page) {
      if (isLoginWallLanding(row)) {
        // Already cleared by an earlier pass — `isLoginWallLanding` still
        // says yes on the `finalUrl` alone, which is exactly why the
        // idempotence check reads the text fields instead of it.
        if (row.title === undefined && row.description === undefined && row.content === undefined) {
          continue;
        }
        walls++;
        if (args.dryRun) continue;
        await ctx.db.patch(row._id, {
          status: "error",
          title: undefined,
          description: undefined,
          content: undefined,
          error: LANDING_LOGIN_WALL_ERROR,
        });
        continue;
      }
      if (looksLikeSerializedJunk(row.content)) {
        junkContent++;
        if (args.dryRun) continue;
        // `content` only: this row's title/description are real ad copy,
        // and its `status: "ok"` is honest — the fetch DID reach the page.
        await ctx.db.patch(row._id, { content: undefined });
      }
    }

    return {
      cursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
      walls,
      junkContent,
    };
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
          "User-Agent": fetchUserAgent(),
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
    // A wall is a FAILURE, not an extraction. Storing it as `ok` is what
    // put "Log into Facebook / Email or mobile number / Forgot password?"
    // into the reply agent's system prompt for 53% of production's ad
    // leads — first contact from a paid click, the one moment the
    // grounding matters most. Failing instead keeps the last good
    // extraction (see `storeResult`) and retries after `RETRY_ERROR_MS`,
    // which is the right shape here: Meta's wall is transient, and the
    // very `fb.me` links cached as walls serve the real post on a later
    // fetch.
    if (isLoginWallUrl(response.url)) {
      return { ok: false, error: LANDING_LOGIN_WALL_ERROR };
    }
    const html = (await response.text()).slice(0, LANDING_HTML_MAX);
    const { title, description, content, loginWall } = extractLandingContent(html);
    if (loginWall) return { ok: false, error: LANDING_LOGIN_WALL_ERROR };
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
