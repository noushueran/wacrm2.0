import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";

export const CODE_REGEX = /HY-[0-9A-HJKMNP-TV-Z]{6}/i;

export function extractRefCode(text: string | undefined | null): string | null {
  if (!text) {
    return null;
  }
  const match = text.match(CODE_REGEX);
  return match ? match[0].toUpperCase() : null;
}

export function extractCtwaClid(msg: { ctwaClid?: string }): string | null {
  return msg.ctwaClid ?? null;
}

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

    const maybeOfferSlug =
      args.offerSlug !== undefined ? { offerSlug: args.offerSlug } : {};
    const maybeFiredAt =
      args.firedAt !== undefined ? { firedAt: args.firedAt } : {};
    const maybeAttempts =
      args.bumpAttempts === true ? { attempts: row.attempts + 1 } : {};

    await ctx.db.patch(args.signalId, {
      landingResult: args.landingResult,
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
 * nudging (up to its own attempts bound) until the env is set.
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
