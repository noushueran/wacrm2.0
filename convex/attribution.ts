import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { accountQuery } from "./lib/auth";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";

// Compact invisible reference code — a shared wire format with the landing site
// (go-holidayys `src/lib/tracking/hidden-code.ts`, which keeps an IDENTICAL codec).
// The code is 6 Crockford base32 chars, encoded DIRECTLY as 30 bits — 5 bits per
// char, MSB first — into ZWSP (U+200B) = 0 / ZWNJ (U+200C) = 1, anchored right after
// the first word of the message. 30 hidden chars carry the whole code (down from 72
// for the old "HY-XXXXXX" ASCII form), so there's far less to lose on an edit.
// Survival through WhatsApp → Meta Cloud API → this CRM verified live 2026-07-13.
// Only ZWSP/ZWNJ are used (the two most universally preserved).
const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTVWXYZ".replace(/[ILOU]/g, "");
const CODE_LEN = 6;
const BITS = CODE_LEN * 5; // 30
const ZW_ZERO = "​"; // ZWSP → 0
const ZW_ONE = "‌"; // ZWNJ → 1

/** Decode the invisible reference code out of a message body: read the FIRST 30
 *  zero-width bits (5 bits/char) into the 6-char base32 code. Null when fewer than a
 *  full code of hidden bits are present. Only ZWSP/ZWNJ are read. */
export function decodeHidden(text: string): string | null {
  const bits = Array.from(text)
    .filter((c) => c === ZW_ZERO || c === ZW_ONE)
    .map((c) => (c === ZW_ZERO ? "0" : "1"))
    .join("");
  if (bits.length < BITS) {
    return null;
  }
  let code = "";
  for (let i = 0; i < BITS; i += 5) {
    code += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return code;
}

/**
 * The reference code carried by an inbound message — decoded from the invisible
 * zero-width block ONLY (invisible-only; no visible fallback). Null when no full
 * hidden code is present.
 */
export function extractRefCode(text: string | undefined | null): string | null {
  if (!text) {
    return null;
  }
  return decodeHidden(text);
}

export function extractCtwaClid(msg: { ctwaClid?: string }): string | null {
  return msg.ctwaClid ?? null;
}

/**
 * How many times a signal may attempt to reach Platform A before it is
 * retired to the terminal `"abandoned"` state. `patchResult` flips an
 * `"error"` row to `"abandoned"` on the failed bump that makes `attempts`
 * reach this value, so the `"error"`/`"pending"` rows `getPendingToRetry`
 * scans are always still live (`attempts < MAX_ATTEMPTS`) — a permanently
 * dead row no longer sits at the front of the `by_result` "error"
 * partition for every 15-min cron sweep to read past. `getPendingToRetry`
 * additionally keeps an `attempts < MAX_ATTEMPTS` filter as a cheap
 * backstop for that same invariant.
 */
export const MAX_ATTEMPTS = 5;

// ============================================================
// recordSignal (Task B3) — idempotent, account-scoped write side of
// `attributionSignals` (`convex/schema.ts`). Plain `internalMutation`
// with an explicit caller-supplied `accountId`, not an `accountMutation`:
// the caller is `ingest.processInbound` (Task B4), which — like
// `ingestInbound` itself — runs session-less off a webhook, not a user
// request (same shape as `aiUsage.log`).
// ============================================================

/**
 * First-occurrence-only insert keyed on `(accountId, identifier)`, via
 * the `by_account_identifier` index. An existing row for that pair means
 * this identifier has already been signalled for this account — returns
 * `null` and inserts nothing. Only a fresh insert returns the new id.
 *
 * DESIGN NOTE: returning `null` on a duplicate (rather than the existing
 * row) is deliberate — it lets the caller (B4) schedule the outbound
 * partner-signal action ONLY on a fresh insert, i.e. "fire once per
 * (accountId, identifier)". `landingResult`/`attempts` are not caller
 * args: every fresh row starts `"pending"`/`0`, advanced later by the
 * outbound signal action, not by this mutation.
 */
export const recordSignal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    identifier: v.string(),
    lane: v.union(v.literal("code"), v.literal("ctwa")),
    phone: v.string(),
    waMessageId: v.string(),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    firstMessageAt: v.number(),
  },
  handler: async (ctx, args): Promise<Id<"attributionSignals"> | null> => {
    const existing = await ctx.db
      .query("attributionSignals")
      .withIndex("by_account_identifier", (q) =>
        q.eq("accountId", args.accountId).eq("identifier", args.identifier),
      )
      .first();
    if (existing) {
      return null;
    }

    return await ctx.db.insert("attributionSignals", {
      ...args,
      landingResult: "pending",
      attempts: 0,
    });
  },
});

// ============================================================
// getSignal / patchResult / sendSignal (Task B5) — the outbound side:
// POST a recorded signal to Platform A's `/whatsapp-conversion`
// endpoint so IT fires the Meta/Google conversion, then record how it
// landed. `sendSignal` is an `internalAction` — actions have no
// `ctx.db` — so it reads/writes the row through `getSignal`/
// `patchResult`, the same "query/mutation primitives an action drives
// via ctx.runQuery/ctx.runMutation" shape as `webhookEndpoints.ts`'s
// `listActiveForEvent`/`recordDeliverySuccess`/`recordDeliveryFailure`
// backing `webhookDelivery.ts`'s `dispatch`. Self-referencing
// `internal.attribution.*` from within this same file mirrors
// `flowsEngine.ts`'s own established convention of an engine action
// calling its sibling queries/mutations this way.
//
// The caller (Task B4's ingest hook) schedules this ONLY on a fresh
// `recordSignal` insert, i.e. once per (accountId, identifier) — but
// `sendSignal` re-checks `landingResult` itself so a future retry path
// (Task B6's cron) can safely call it again for a `"pending"`/
// `"error"`/`"unmatched"` row without ever re-firing an already-
// `"matched"` one.
// ============================================================

/** Plain row lookup — see this section's header for why `sendSignal`
 *  (an action) needs this rather than reading `ctx.db` directly. */
export const getSignal = internalQuery({
  args: { signalId: v.id("attributionSignals") },
  handler: async (ctx, args): Promise<Doc<"attributionSignals"> | null> => {
    return await ctx.db.get(args.signalId);
  },
});

/**
 * Advances a signal row's outcome after a `sendSignal` attempt (or a
 * test/future caller driving the same transition directly). A missing
 * row is a silent no-op — mirrors `webhookEndpoints.ts`'s
 * `recordDeliveryFailure` guard, since the row could in principle be
 * gone by the time a scheduled/retried action runs.
 *
 * `offerSlug`/`firedAt` are only patched when the caller actually
 * supplied them (`!== undefined`), so an omitted field is left
 * untouched rather than cleared — same "build the patch object with an
 * explicit conditional spread" convention as `whatsappConfig.ts`'s
 * `upsert` (see that function's own comment on why `ctx.db.patch`
 * otherwise treats a present-but-`undefined` key as "unset this
 * field"). `attempts` only increments when `bumpAttempts === true`
 * (strict check, not just truthy) — `sendSignal`'s "landed OK" branches
 * (matched/unmatched) never pass it, only its error branches do.
 *
 * When an `"error"` bump is the one that makes `attempts` reach
 * `MAX_ATTEMPTS`, the row is written `"abandoned"` (the terminal
 * give-up state) instead of `"error"` — the single point where a signal
 * is permanently retired. That keeps `"error"`/`"pending"` (the retry
 * cron's partitions) free of dead rows. Callers still only ever pass the
 * four live outcomes; `"abandoned"` is derived here, never a caller arg.
 */
export const patchResult = internalMutation({
  args: {
    signalId: v.id("attributionSignals"),
    landingResult: v.union(
      v.literal("pending"),
      v.literal("matched"),
      v.literal("unmatched"),
      v.literal("error"),
    ),
    offerSlug: v.optional(v.string()),
    firedAt: v.optional(v.number()),
    bumpAttempts: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.signalId);
    if (!row) return;

    const bumping = args.bumpAttempts === true;
    const nextAttempts = row.attempts + 1;

    // A failed attempt (`"error"` + a bump) that reaches `MAX_ATTEMPTS`
    // is retired to the terminal `"abandoned"` state instead of being
    // left as another retryable `"error"`. This is the single place
    // give-up is decided, so a maxed-out row leaves the `"error"`
    // partition `getPendingToRetry` scans rather than accumulating at its
    // front forever. Gated on `landingResult === "error"` (the only
    // outcome its callers ever pair with `bumpAttempts`) so a
    // matched/unmatched result is never overridden.
    const landingResult =
      bumping && args.landingResult === "error" && nextAttempts >= MAX_ATTEMPTS
        ? ("abandoned" as const)
        : args.landingResult;

    const maybeOfferSlug =
      args.offerSlug !== undefined ? { offerSlug: args.offerSlug } : {};
    const maybeFiredAt =
      args.firedAt !== undefined ? { firedAt: args.firedAt } : {};
    const maybeAttempts = bumping ? { attempts: nextAttempts } : {};

    await ctx.db.patch(args.signalId, {
      landingResult,
      ...maybeOfferSlug,
      ...maybeFiredAt,
      ...maybeAttempts,
    });
  },
});

/**
 * POSTs `signalId`'s row to Platform A (`process.env
 * .LANDING_CONVERSION_URL`, `Authorization: Bearer
 * process.env.WA_CONVERSION_SHARED_SECRET`) and records how it landed.
 * Never throws — mirrors `webhookDelivery.ts`'s `deliverOne` try/catch
 * shape (fetch, throw on `!res.ok` so both the network-error and
 * bad-status paths collapse into one `catch`, which records `"error"`
 * + bumps `attempts`).
 *
 * Two early-out guards before any network call:
 *   - `!row` — the row is gone (shouldn't happen in practice; a
 *     schedule/retry racing a deletion is the only way).
 *   - `row.landingResult === "matched"` — idempotent: a signal that
 *     already landed is never re-POSTed, so a duplicate schedule (or a
 *     future retry cron re-sweeping "not yet matched" rows) can't
 *     double-fire Platform A's own conversion side effect.
 *
 * The env-var guard makes this DORMANT until `LANDING_CONVERSION_URL`/
 * `WA_CONVERSION_SHARED_SECRET` are configured on the deployment
 * (intentionally deferred past this task) — every row instead records
 * `"error"` + an attempts bump, which Task B6's retry cron will keep
 * nudging until the env is set or `attempts` hits `MAX_ATTEMPTS`, at
 * which point `patchResult` retires the row to `"abandoned"` and the
 * cron stops picking it up.
 */
export const sendSignal = internalAction({
  args: { signalId: v.id("attributionSignals") },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.runQuery(internal.attribution.getSignal, {
      signalId: args.signalId,
    });
    if (!row) return;
    if (row.landingResult === "matched") return;

    const url = process.env.LANDING_CONVERSION_URL;
    const secret = process.env.WA_CONVERSION_SHARED_SECRET;
    if (!url || !secret) {
      console.warn(
        "[attribution] sendSignal skipped: LANDING_CONVERSION_URL/WA_CONVERSION_SHARED_SECRET not configured",
      );
      await ctx.runMutation(internal.attribution.patchResult, {
        signalId: args.signalId,
        landingResult: "error",
        bumpAttempts: true,
      });
      return;
    }

    // Exactly one identifier key, chosen by lane — never both, and
    // never `text` (the row doesn't store it; the contract only ever
    // makes it optional).
    const identifierField =
      row.lane === "code" ? { code: row.identifier } : { ctwaClid: row.identifier };
    const body = {
      ...identifierField,
      phone: row.phone,
      waMessageId: row.waMessageId,
      firstMessageAt: row.firstMessageAt,
    };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`Platform A responded ${res.status}`);
      }

      const data: {
        matched?: boolean;
        alreadyFired?: boolean;
        firedAt?: number;
        offerSlug?: string;
        reason?: string;
      } = await res.json();

      if (data.matched) {
        await ctx.runMutation(internal.attribution.patchResult, {
          signalId: args.signalId,
          landingResult: "matched",
          offerSlug: data.offerSlug,
          firedAt: data.firedAt,
        });
      } else {
        await ctx.runMutation(internal.attribution.patchResult, {
          signalId: args.signalId,
          landingResult: "unmatched",
        });
      }
    } catch (err) {
      console.warn(
        "[attribution] sendSignal failed:",
        err instanceof Error ? err.message : err,
      );
      await ctx.runMutation(internal.attribution.patchResult, {
        signalId: args.signalId,
        landingResult: "error",
        bumpAttempts: true,
      });
    }
  },
});

// ============================================================
// getPendingToRetry / retryPending (Task B6) — the retry safety net.
// A `sendSignal` attempt can leave a row `"error"` (non-2xx, network
// failure, or a missing env var — see that function's own comment),
// or a row can be stuck `"pending"` if its originally-scheduled
// `sendSignal` never ran at all. `convex/crons.ts` runs `retryPending`
// on an interval to sweep both cases back through `sendSignal`, which
// is safe to call again for either status — see `sendSignal`'s own
// "already matched" early-out.
//
// `getPendingToRetry` is global (no `accountId` arg): the cron has no
// account context to scope by, so it reads the `by_result` index
// (`landingResult` only) rather than `by_account_result` — finding
// candidates across every account without a full table scan.
// ============================================================

/**
 * Retry candidates: `landingResult` is `"error"` OR `"pending"`, capped
 * at 100 rows total. A row that exhausts its retries is retired to
 * `"abandoned"` by `patchResult` (see `MAX_ATTEMPTS`), so it leaves these
 * two partitions entirely — the point being that this global, every-15-
 * minute sweep never has to read past an ever-growing wall of
 * permanently-dead rows (they sort oldest-first, at the front) to reach
 * the live ones. The `attempts < MAX_ATTEMPTS` filter below is a cheap
 * backstop for that same invariant — a still-`"error"`/`"pending"` row
 * should never have reached the cap — not the primary mechanism.
 *
 * Queries the two statuses separately through the `by_result` index —
 * never a full scan — each independently bounded to `.take(100)`
 * before combining and re-capping at 100, so a large backlog in one
 * status can never crowd the other out of consideration entirely.
 */
export const getPendingToRetry = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"attributionSignals">[]> => {
    const errorRows = await ctx.db
      .query("attributionSignals")
      .withIndex("by_result", (q) => q.eq("landingResult", "error"))
      .filter((q) => q.lt(q.field("attempts"), MAX_ATTEMPTS))
      .take(100);
    const pendingRows = await ctx.db
      .query("attributionSignals")
      .withIndex("by_result", (q) => q.eq("landingResult", "pending"))
      .filter((q) => q.lt(q.field("attempts"), MAX_ATTEMPTS))
      .take(100);

    return [...errorRows, ...pendingRows].slice(0, 100);
  },
});

/**
 * Cron-facing entry point (`convex/crons.ts`, every 15 minutes): pulls
 * this batch of retry candidates and re-schedules `sendSignal` for
 * each — the same "action does `runQuery` then fans out via the
 * scheduler" shape as `broadcasts.ts`'s `send`. An `internalAction`
 * rather than a mutation specifically because it needs `ctx.runQuery`
 * to call the sibling `getPendingToRetry` query — only actions have
 * `ctx.runQuery`/`ctx.runMutation`. Kept deliberately tiny: all the
 * actual retry logic (idempotency, error handling) already lives in
 * `sendSignal` itself.
 */
export const retryPending = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const rows = await ctx.runQuery(
      internal.attribution.getPendingToRetry,
      {},
    );
    for (const row of rows) {
      await ctx.scheduler.runAfter(0, internal.attribution.sendSignal, {
        signalId: row._id,
      });
    }
  },
});

// ============================================================
// listConversions (Task B7a) — the read side for the attribution
// "conversions" admin view (Task B7b's UI calls this directly as
// `api.attribution.listConversions`). Unlike every function above,
// this is a PUBLIC `accountQuery` (`./lib/auth`), not an
// `internalQuery`/`internalMutation`/`internalAction` — it's driven by
// an admin's own browser session, not a webhook/cron/engine caller, so
// it needs `accountQuery`'s real caller identity: `ctx.accountId`
// derived from the caller's own `memberships` row (never a
// client-supplied arg) and `ctx.requireRole` for the gate below.
// ============================================================

/**
 * Admin+ only (`ctx.requireRole("admin")`) — this view exposes lead
 * phone numbers (`row.phone`) unmasked, the same "only a trusted-enough
 * role sees a raw phone" principle `canSeeContactPhone`
 * (`convex/lib/roles.ts`) applies elsewhere in the app.
 *
 * Reads THIS account's entire signal history in one shot via the
 * `by_account_result` index bound only on `accountId` (leaving
 * `landingResult` unbound) — an account-scoped full scan. Acceptable
 * at current scale, the same trade-off `dashboard.ts`'s own several
 * UNBOUNDED account-scoped scans make (see that file's header
 * comment): there's no time-bounded index this view could narrow by
 * instead, and per-account attribution-signal volume is low today.
 *
 * `counts` tallies every row's `landingResult` across that full set.
 * `conversions` narrows to `matched` rows only, newest-`firedAt`-first
 * (a row missing `firedAt` sorts as if it were `0`, i.e. last — should
 * only ever happen for a hand-inserted/edge-case row, since a real
 * `matched` transition always comes from `patchResult` with `firedAt`
 * supplied), capped to the 200 most recent — this is an admin
 * dashboard list, not a paginated export.
 */
export const listConversions = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");

    const rows = await ctx.db
      .query("attributionSignals")
      .withIndex("by_account_result", (q) => q.eq("accountId", ctx.accountId))
      .collect();

    const counts = {
      total: 0,
      matched: 0,
      pending: 0,
      unmatched: 0,
      error: 0,
      abandoned: 0,
    };
    for (const row of rows) {
      counts.total += 1;
      counts[row.landingResult] += 1;
    }

    const conversions = rows
      .filter((row) => row.landingResult === "matched")
      .sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0))
      .slice(0, 200)
      .map((row) => ({
        id: row._id,
        phone: row.phone,
        identifier: row.identifier,
        lane: row.lane,
        offerSlug: row.offerSlug,
        firedAt: row.firedAt,
        firstMessageAt: row.firstMessageAt,
      }));

    return { conversions, counts };
  },
});
