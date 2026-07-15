import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { resolveEventName, backendForLane } from "./lib/funnel";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
export const MAX_DELIVER_ATTEMPTS = 5;

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
    return { conversionEventId };
  },
});

/**
 * Advances a conversionEvents row after a delivery attempt. Conditional
 * spread (a field is only patched when supplied). `attempts` bumps only on
 * an explicit `bumpAttempts === true`. An `"error"` bump that reaches
 * `MAX_DELIVER_ATTEMPTS` is retired to the terminal `"abandoned"` state — the
 * single give-up point — so dead rows leave the retry cron's partitions
 * (mirrors `attribution.patchResult`).
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
 * Delivers one conversion event to its backend. Never throws. Idempotent:
 * an already-`sent` row is skipped. Dormant (relevant env unset, or capi with
 * no wabaId) → leave the row `pending`, no bump, so the retry cron resends
 * once configured. We dedupe ourselves (one row per conversation×stage) —
 * Meta does not dedupe business-messaging events.
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
      if (!datasetId || !token) return; // dormant
      const wabaId = await ctx.runQuery(internal.conversionEvents.getWabaId, {
        accountId: row.accountId,
      });
      if (!wabaId) return; // dormant — no WABA configured
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
          throw new Error(`CAPI ${res.status}: ${text.slice(0, 200)}`);
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
          status: "error",
          lastError: err instanceof Error ? err.message : String(err),
          bumpAttempts: true,
        });
      }
      return;
    }

    // backend === "platformA" — website/code lane → Platform A web Pixel.
    const url = process.env.LANDING_CONVERSION_URL;
    const secret = process.env.WA_CONVERSION_SHARED_SECRET;
    if (!url || !secret) return; // dormant
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
      if (!res.ok) throw new Error(`Platform A responded ${res.status}`);
      const data = (await res.json().catch(() => ({}))) as {
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
        status: "error",
        lastError: err instanceof Error ? err.message : String(err),
        bumpAttempts: true,
      });
    }
  },
});

/**
 * Retry candidates: `error` OR `pending` with `attempts < MAX`, capped at
 * 100 total. `pending` covers dormant rows (env not yet set) so they send
 * once configured. Queried through `by_status` (never a full scan), each
 * `.take(100)`, combined and re-capped. Mirrors `attribution.getPendingToRetry`.
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

export const retryConversionEvents = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const rows = await ctx.runQuery(
      internal.conversionEvents.getPendingToRetry,
      {},
    );
    for (const row of rows) {
      await ctx.scheduler.runAfter(
        0,
        internal.conversionEvents.deliverConversionEvent,
        { conversionEventId: row._id },
      );
    }
  },
});
