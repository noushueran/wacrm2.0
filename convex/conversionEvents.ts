import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { resolveEventName, backendForLane } from "./lib/funnel";
import { applyStageTransition } from "./funnel";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
export const MAX_DELIVER_ATTEMPTS = 5;

/** Rows per pass of `migrateDormantOutOfAbandoned`'s cursor walk. */
const MIGRATE_BATCH = 512;

/**
 * Delay between each `deliverConversionEvent` the retry cron schedules. The
 * cron pulls up to 100 rows every 15 minutes and every one of them is an
 * external Graph POST; firing them all at `runAfter(0)` is a 100-call burst
 * that draws 429s from the very backend we're delivering to. Mirrors
 * `broadcasts.ts`'s `DELIVER_STAGGER_MS` — same reasoning, same ~10/s steady
 * state: Convex's scheduler already IS the queue, so a flat per-row interval
 * is all it takes.
 */
const DELIVER_STAGGER_MS = 100;

/**
 * A 429 or 5xx is the backend telling us to come back later — it says nothing
 * about the row itself, so spending an attempt on it is what let a burst of
 * our own making walk a live conversion to the terminal `"abandoned"` state.
 * Carried as its own Error subclass rather than parsed back out of the message
 * text, so the classification can't drift from the status that set it.
 */
class TransientDeliveryError extends Error {}

/**
 * Everything that isn't a 429/5xx (4xx, a malformed body, a network failure)
 * is treated as the row's own fault: it bumps `attempts` and can legitimately
 * exhaust the budget and give up.
 */
function deliveryError(status: number, message: string): Error {
  return status === 429 || status >= 500
    ? new TransientDeliveryError(message)
    : new Error(message);
}

/**
 * The `patchStatus` args a failed delivery attempt should write. Transient
 * failures re-queue as `"error"` WITHOUT a bump, so they stay selectable by
 * `getPendingToRetry` indefinitely and can never reach `MAX_DELIVER_ATTEMPTS`.
 */
function errorPatchFor(err: unknown): {
  status: "error";
  lastError: string;
  bumpAttempts: boolean;
} {
  return {
    status: "error",
    lastError: err instanceof Error ? err.message : String(err),
    bumpAttempts: !(err instanceof TransientDeliveryError),
  };
}

export const getById = internalQuery({
  args: { conversionEventId: v.id("conversionEvents") },
  handler: async (ctx, args): Promise<Doc<"conversionEvents"> | null> =>
    await ctx.db.get(args.conversionEventId),
});

export const getWabaId = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<string | null> => {
    const cfg = await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    return cfg?.wabaId ?? null;
  },
});

/**
 * Classifies a conversation's lead source from the identifiers seen on an
 * inbound message and seeds the ONE `new_lead` conversion event for its
 * lane. `code` (website HY-code) wins over `ctwa` (ad click) if both are
 * present; both identifiers are retained on `conversation.attribution`
 * (set once, never overwritten). Fire-once per conversation via the
 * deterministic `eventId = ${conversationId}:new_lead` + the `by_event_id`
 * guard. Returns `{ conversionEventId }` on a fresh insert (so the caller
 * schedules delivery), or `null` for an organic message (no identifier) or a
 * conversation whose `new_lead` was already seeded. Replaces the old
 * `attribution.recordSignal` first-touch write.
 *
 * Also advances `conversation.funnel`/`funnelTransitions` to `new_lead`
 * (Task B3) via `funnel.ts`'s engine-path helper — same `auto` +
 * `neverDowngrade` calling convention as `qualificationEngine.ts`'s
 * `completeQualification` — so a fresh attributed lead is immediately
 * visible in the stepper instead of showing "no stage yet" until an agent
 * acts. `neverDowngrade` makes this a no-op when the conversation already
 * sits at or past `new_lead` (its lowest stage), so it can never pull an
 * already-progressed conversation backward.
 */
export const seedNewLead = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    waMessageId: v.string(),
    phone: v.string(),
    firstMessageAt: v.number(),
    code: v.optional(v.string()),
    ctwaClid: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ conversionEventId: Id<"conversionEvents"> } | null> => {
    const { accountId, contactId, conversationId, waMessageId, phone, firstMessageAt, code, ctwaClid } =
      args;
    if (!code && !ctwaClid) return null; // organic — nothing to attribute

    const lane: "code" | "ctwa" = code ? "code" : "ctwa";
    const identifier = code ?? ctwaClid!;

    // Classify once — set conversation.attribution if unset (retain both ids).
    const conversation = await ctx.db.get(conversationId);
    if (conversation && !conversation.attribution) {
      await ctx.db.patch(conversationId, {
        attribution: { lane, code, ctwaClid, firstSeenAt: firstMessageAt },
      });
    }

    // Fire-once per conversation.
    const eventId = `${conversationId}:new_lead`;
    const existing = await ctx.db
      .query("conversionEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
      .first();
    if (existing) return null;

    const eventName = resolveEventName(lane, "new_lead")!; // new_lead is never internal-only
    const conversionEventId = await ctx.db.insert("conversionEvents", {
      accountId,
      conversationId,
      contactId,
      stage: "new_lead",
      lane,
      backend: backendForLane(lane),
      eventName,
      identifier,
      phone,
      waMessageId,
      firstMessageAt,
      eventId,
      status: "pending",
      attempts: 0,
    });

    // Funnel visibility (Task B3). Re-read so `applyStageTransition` sees
    // the attribution patch just above (if this call is what set it); its
    // own `by_event_id` lookup for this same `eventId` finds the row just
    // inserted, so it links `conversionEventId` onto the transition rather
    // than creating a second event or re-scheduling delivery.
    const withAttribution = await ctx.db.get(conversationId);
    if (withAttribution) {
      const account = await ctx.db.get(accountId);
      await applyStageTransition(ctx, {
        accountId,
        conversation: withAttribution,
        stage: "new_lead",
        auto: true,
        neverDowngrade: true,
        defaultCurrency: account?.defaultCurrency ?? "USD",
      });
    }

    return { conversionEventId };
  },
});

/**
 * Advances a conversionEvents row after a delivery attempt. Conditional
 * spread (a field is only patched when supplied). `attempts` bumps only on
 * an explicit `bumpAttempts === true` — a transient failure passes `false`
 * (see `errorPatchFor`) so it re-queues without spending budget. An
 * `"error"` bump that reaches `MAX_DELIVER_ATTEMPTS` is retired to the
 * terminal `"abandoned"` state — the single give-up point for a row that
 * keeps failing on its own merits (mirrors `attribution.patchResult`).
 * A row that can't be attempted at all is retired by `retireDormant` instead.
 */
export const patchStatus = internalMutation({
  args: {
    conversionEventId: v.id("conversionEvents"),
    status: v.union(
      v.literal("sent"),
      v.literal("unmatched"),
      v.literal("error"),
    ),
    fbTraceId: v.optional(v.string()),
    matchResult: v.optional(v.string()),
    lastError: v.optional(v.string()),
    bumpAttempts: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.conversionEventId);
    if (!row) return;
    const bumping = args.bumpAttempts === true;
    const nextAttempts = row.attempts + 1;
    const status =
      bumping && args.status === "error" && nextAttempts >= MAX_DELIVER_ATTEMPTS
        ? ("abandoned" as const)
        : args.status;
    const patch: Record<string, unknown> = { status };
    if (args.fbTraceId !== undefined) patch.fbTraceId = args.fbTraceId;
    if (args.matchResult !== undefined) patch.matchResult = args.matchResult;
    if (args.lastError !== undefined) patch.lastError = args.lastError;
    if (args.status === "sent") patch.sentAt = Date.now();
    if (bumping) patch.attempts = nextAttempts;
    await ctx.db.patch(args.conversionEventId, patch);
  },
});

/**
 * Retires a row whose backend cannot be attempted at all (relevant env unset,
 * or capi with no wabaId) to `"abandoned"` WITHOUT bumping `attempts`.
 *
 * Such rows used to be left `"pending"` with `attempts: 0`, which matches
 * `getPendingToRetry`'s predicate forever: since that window is oldest-first
 * and capped at 100, a dormant backlog permanently starved every newer row
 * behind it (in prod the CAPI env is unset, so every CTWA ad lead seeds
 * exactly such a row). Retiring to a status the window doesn't read is what
 * keeps it reachable.
 *
 * `attempts < MAX_DELIVER_ATTEMPTS` is what marks a row dormant-retired
 * rather than genuinely given-up — `patchStatus`'s give-up path can only
 * land on `attempts >= MAX_DELIVER_ATTEMPTS` — and is exactly what
 * `getDormantToSweep` re-reads once the backend is finally configured.
 */
export const retireDormant = internalMutation({
  args: {
    conversionEventId: v.id("conversionEvents"),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.conversionEventId);
    if (!row) return;
    await ctx.db.patch(args.conversionEventId, {
      status: "dormant",
      lastError: `dormant: ${args.reason}`,
    });
  },
});

/**
 * One-off: reclassifies rows the PREVIOUS release retired as `"abandoned"`
 * with `attempts < MAX_DELIVER_ATTEMPTS` into the `"dormant"` partition the
 * sweep now reads. Without it those rows are stranded — `getDormantToSweep`
 * no longer looks at `"abandoned"`, so they would never deliver once their
 * backend is configured, silently. Production carried 19 of them, all real
 * undelivered CTWA conversions.
 *
 * `attempts` is what identifies them, and it is exact rather than heuristic:
 * `patchStatus`'s give-up path can only ever land on `attempts >= MAX`, so a
 * sub-MAX `"abandoned"` row can only have come from `retireDormant`.
 *
 * Walks the `"abandoned"` partition on a `_creationTime` cursor (the implicit
 * trailing key of `by_status`) rather than filtering it, so each pass reads a
 * bounded window and never re-reads a row it has already stepped over. Safe to
 * re-run: a second pass finds nothing left below MAX.
 */
export const migrateDormantOutOfAbandoned = internalMutation({
  args: { cursorMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const cursorMs = args.cursorMs ?? 0;
    const page = await ctx.db
      .query("conversionEvents")
      .withIndex("by_status", (q) =>
        q.eq("status", "abandoned").gt("_creationTime", cursorMs),
      )
      .take(MIGRATE_BATCH);
    if (page.length === 0) return;

    for (const row of page) {
      if (row.attempts < MAX_DELIVER_ATTEMPTS) {
        await ctx.db.patch(row._id, { status: "dormant" });
      }
    }

    if (page.length === MIGRATE_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.conversionEvents.migrateDormantOutOfAbandoned,
        { cursorMs: page[page.length - 1]!._creationTime },
      );
    }
  },
});

/**
 * Delivers one conversion event to its backend. Never throws. Idempotent:
 * an already-`sent` row is skipped. Dormant (relevant env unset, or capi with
 * no wabaId) → `retireDormant`, which the cron re-sweeps once the backend is
 * configured. We dedupe ourselves (one row per conversation×stage) — Meta does
 * not dedupe business-messaging events.
 */
export const deliverConversionEvent = internalAction({
  args: { conversionEventId: v.id("conversionEvents") },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.runQuery(internal.conversionEvents.getById, {
      conversionEventId: args.conversionEventId,
    });
    if (!row) return;
    if (row.status === "sent") return;

    if (row.backend === "capi") {
      const datasetId = process.env.META_CAPI_DATASET_ID;
      const token = process.env.META_CAPI_ACCESS_TOKEN;
      if (!datasetId || !token) {
        await ctx.runMutation(internal.conversionEvents.retireDormant, {
          conversionEventId: args.conversionEventId,
          reason: "META_CAPI_DATASET_ID/META_CAPI_ACCESS_TOKEN unset",
        });
        return;
      }
      const wabaId = await ctx.runQuery(internal.conversionEvents.getWabaId, {
        accountId: row.accountId,
      });
      if (!wabaId) {
        // Re-swept on every tick while the CAPI env is set (the sweep keys on
        // env, which is configured here) — a no-op round-trip per row until
        // the account connects a WABA, which is the price of not dropping the
        // conversion the moment it does.
        await ctx.runMutation(internal.conversionEvents.retireDormant, {
          conversionEventId: args.conversionEventId,
          reason: "no wabaId configured for account",
        });
        return;
      }
      try {
        const event: Record<string, unknown> = {
          event_name: row.eventName,
          event_time: Math.floor(row._creationTime / 1000),
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          event_id: row.eventId,
          user_data: {
            whatsapp_business_account_id: wabaId,
            ctwa_clid: row.identifier,
          },
        };
        if (row.value !== undefined) {
          event.custom_data = { value: row.value, currency: row.currency };
        }
        const body: Record<string, unknown> = { data: [event] };
        const partnerAgent = process.env.META_CAPI_PARTNER_AGENT;
        if (partnerAgent) body.partner_agent = partnerAgent;
        const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
          datasetId,
        )}/events?access_token=${encodeURIComponent(token)}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text();
          throw deliveryError(
            res.status,
            `CAPI ${res.status}: ${text.slice(0, 200)}`,
          );
        }
        const data = (await res.json().catch(() => ({}))) as {
          fbtrace_id?: string;
        };
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          status: "sent",
          fbTraceId: data.fbtrace_id,
        });
      } catch (err) {
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          ...errorPatchFor(err),
        });
      }
      return;
    }

    // backend === "platformA" — website/code lane → Platform A web Pixel.
    const url = process.env.LANDING_CONVERSION_URL;
    const secret = process.env.WA_CONVERSION_SHARED_SECRET;
    if (!url || !secret) {
      await ctx.runMutation(internal.conversionEvents.retireDormant, {
        conversionEventId: args.conversionEventId,
        reason: "LANDING_CONVERSION_URL/WA_CONVERSION_SHARED_SECRET unset",
      });
      return;
    }
    try {
      const body: Record<string, unknown> = {
        code: row.identifier,
        phone: row.phone,
        waMessageId: row.waMessageId,
        firstMessageAt: row.firstMessageAt,
        stage: row.stage,
        event: row.eventName,
      };
      if (row.value !== undefined) body.value = row.value;
      if (row.currency !== undefined) body.currency = row.currency;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw deliveryError(res.status, `Platform A responded ${res.status}`);
      }
      const data = (await res.json()) as {
        matched?: boolean;
        firedAt?: number;
        offerSlug?: string;
        reason?: string;
      };
      if (data.matched) {
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          status: "sent",
          matchResult: data.offerSlug,
        });
      } else {
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          status: "unmatched",
        });
      }
    } catch (err) {
      await ctx.runMutation(internal.conversionEvents.patchStatus, {
        conversionEventId: args.conversionEventId,
        ...errorPatchFor(err),
      });
    }
  },
});

/**
 * Live retry candidates: `error` OR `pending` with `attempts < MAX`, capped at
 * 100 total. Queried through `by_status` (never a full scan), each `.take(100)`,
 * combined and re-capped. Mirrors `attribution.getPendingToRetry`.
 *
 * Both partitions drain: an `error` row either succeeds or bumps its way to
 * `"abandoned"`, and a `pending` row is delivered the moment it's seeded. A row
 * whose backend isn't configured never got either treatment and so used to sit
 * in `pending` permanently — since this window is oldest-first, that backlog
 * starved every newer row behind it. Those rows are now retired by
 * `retireDormant` to a status neither partition reads, and come back through
 * `getDormantToSweep` instead.
 */
export const getPendingToRetry = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"conversionEvents">[]> => {
    const errored = await ctx.db
      .query("conversionEvents")
      .withIndex("by_status", (q) => q.eq("status", "error"))
      .filter((q) => q.lt(q.field("attempts"), MAX_DELIVER_ATTEMPTS))
      .take(100);
    const pending = await ctx.db
      .query("conversionEvents")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .filter((q) => q.lt(q.field("attempts"), MAX_DELIVER_ATTEMPTS))
      .take(100);
    return [...errored, ...pending].slice(0, 100);
  },
});

/**
 * Dormant-retired rows (see `retireDormant`) for the backends whose env is NOW
 * configured — the path that gets a conversion delivered after its backend is
 * finally wired up, rather than losing it for having arrived too early.
 *
 * The `backends` arg is why this is separate from `getPendingToRetry`: only an
 * action can read `process.env`, so the caller decides what's configured and
 * asks for nothing while nothing is — otherwise an undeliverable backlog would
 * churn the scheduler every 15 minutes for as long as the env stayed unset.
 * `attempts < MAX_DELIVER_ATTEMPTS` excludes rows that reached `"abandoned"`
 * the honest way, through `patchStatus`'s give-up.
 *
 * Dormant now has its own status, so this carries NO `.filter()`: one
 * `by_status_backend` range per configured backend, each bounded by its own
 * `.take()`. It previously ranged `"abandoned"` and filtered on both
 * `attempts < MAX` and the backend list — a scan across a partition that
 * genuinely-given-up rows never leave, so it walked further every time one
 * accumulated. That comment argued the two "only mix when an account both
 * fails deliveries permanently AND has undeliverable rows"; the real
 * production state is simpler and worse, since capi-dormant rows pile up
 * indefinitely while only platformA is configured.
 *
 * Per-backend rather than one range over `"dormant"` with a backend filter,
 * for the same reason: a filter over the whole dormant set would scan past
 * every capi row to find platformA's.
 */
export const getDormantToSweep = internalQuery({
  args: {
    backends: v.array(v.union(v.literal("platformA"), v.literal("capi"))),
  },
  handler: async (ctx, args): Promise<Doc<"conversionEvents">[]> => {
    if (args.backends.length === 0) return [];
    const perBackend = await Promise.all(
      args.backends.map((backend) =>
        ctx.db
          .query("conversionEvents")
          .withIndex("by_status_backend", (q) =>
            q.eq("status", "dormant").eq("backend", backend),
          )
          .take(100),
      ),
    );
    return perBackend.flat().slice(0, 100);
  },
});

/**
 * Cron entry point (`convex/crons.ts`, every 15 minutes): pulls the live retry
 * batch plus any dormant rows whose backend has since been configured, and
 * re-schedules `deliverConversionEvent` for each, `DELIVER_STAGGER_MS` apart.
 * Tiny by design — every delivery decision (dormant, idempotent,
 * transient-vs-permanent) lives in `deliverConversionEvent` itself.
 */
export const retryConversionEvents = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const backends: Array<"platformA" | "capi"> = [];
    if (process.env.META_CAPI_DATASET_ID && process.env.META_CAPI_ACCESS_TOKEN) {
      backends.push("capi");
    }
    if (
      process.env.LANDING_CONVERSION_URL &&
      process.env.WA_CONVERSION_SHARED_SECRET
    ) {
      backends.push("platformA");
    }

    const [live, dormant] = await Promise.all([
      ctx.runQuery(internal.conversionEvents.getPendingToRetry, {}),
      ctx.runQuery(internal.conversionEvents.getDormantToSweep, { backends }),
    ]);

    // Live rows first: a dormant backlog must never crowd them out of the
    // 100-row budget — the same ordering rule `getPendingToRetry` applies
    // between its own two partitions.
    const batch = [...live, ...dormant].slice(0, 100);
    for (const [i, row] of batch.entries()) {
      await ctx.scheduler.runAfter(
        i * DELIVER_STAGGER_MS,
        internal.conversionEvents.deliverConversionEvent,
        { conversionEventId: row._id },
      );
    }
  },
});
