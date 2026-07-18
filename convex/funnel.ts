import { accountMutation, accountQuery } from "./lib/auth";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireConversationAccess } from "./lib/conversationAccess";
import { normalizePhone } from "./lib/phone";
import {
  resolveEventName,
  backendForLane,
  getStage,
  FUNNEL_STAGE_KEYS,
  type FunnelStageKey,
} from "./lib/funnel";
import { allItemsDone, isLossCategory } from "./lib/salesChecklist";

const STAGE_VALIDATOR = v.union(
  v.literal("new_lead"),
  v.literal("qualified"),
  v.literal("price_quoted"),
  v.literal("itinerary_created"),
  v.literal("itinerary_sent"),
  v.literal("invoice_sent"),
  v.literal("purchased"),
  v.literal("lost"),
);

/**
 * Advances one conversation's funnel stage (agent-driven). Records the
 * denormalized current stage on the conversation, appends a
 * `funnelTransitions` audit row, and — for an ATTRIBUTED conversation whose
 * stage maps to a Meta event on its lane — seeds a deduped `conversionEvents`
 * row and schedules Phase 1's dispatcher (dormant without env). Organic
 * conversations and internal-only stages (`itinerary_created`) record CRM
 * state only. `purchased` requires a positive `saleValue`.
 *
 * Access mirrors `conversations.setStatus`: `requireRole("agent")` (viewers
 * excluded) + `requireConversationAccess(..., "own")` (agents may only act on
 * a conversation assigned to them; supervisor+ act on any).
 */
/**
 * The stage-advance core, shared by the authed `setStage` below and the
 * qualification engine's `completeQualification` (spec §9 — the
 * "internal stage-advance" the design calls for). Byte-identical
 * behavior for the authed path; two engine-only additions:
 *   - `auto` + optional `byUserId` (an engine transition has no user);
 *   - `neverDowngrade`: skip entirely when the conversation already sits
 *     at or past `stage` (a human may have advanced it to price_quoted
 *     while the bot was still collecting — the engine must never pull it
 *     back). Returns whether a transition was applied.
 */
export async function applyStageTransition(
  ctx: { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] },
  args: {
    accountId: Id<"accounts">;
    conversation: Doc<"conversations">;
    stage: FunnelStageKey;
    byUserId?: Id<"users">;
    auto: boolean;
    saleValue?: number;
    saleCurrency?: string;
    defaultCurrency: string;
    neverDowngrade?: boolean;
    // Set only on `lost` transitions — persisted onto the audit row.
    lossCategory?: string;
    lossDetail?: string;
  },
): Promise<{ applied: boolean }> {
  const { conversation, stage } = args;
  const conversationId = conversation._id;

  if (args.neverDowngrade && conversation.funnel?.stage) {
    const currentIdx = FUNNEL_STAGE_KEYS.indexOf(conversation.funnel.stage);
    const nextIdx = FUNNEL_STAGE_KEYS.indexOf(stage);
    if (currentIdx >= nextIdx) return { applied: false };
  }

  const hasValue = args.saleValue !== undefined && args.saleValue > 0;
  const now = Date.now();
  const currency = args.saleCurrency ?? args.defaultCurrency;

  await ctx.db.patch(conversationId, {
    funnel: {
      stage,
      stageUpdatedAt: now,
      ...(args.byUserId ? { stageUpdatedByUserId: args.byUserId } : {}),
      ...(hasValue ? { saleValue: args.saleValue, saleCurrency: currency } : {}),
    },
    updatedAt: now,
  });

  // Seed the mapped Meta conversion event when the conversation is
  // attributed AND the stage maps to an event on its lane. Reuses the
  // first-touch (new_lead) row as the anchor for the Platform A contract
  // fields (phone/waMessageId/firstMessageAt).
  let conversionEventId: Id<"conversionEvents"> | undefined;
  const attribution = conversation.attribution;
  if (attribution) {
    const eventName = resolveEventName(attribution.lane, stage);
    const identifier =
      attribution.lane === "code" ? attribution.code : attribution.ctwaClid;
    if (eventName && identifier) {
      const eventId = `${conversationId}:${stage}`;
      const existing = await ctx.db
        .query("conversionEvents")
        .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
        .first();
      if (existing) {
        conversionEventId = existing._id;
      } else {
        const anchor = await ctx.db
          .query("conversionEvents")
          .withIndex("by_event_id", (q) =>
            q.eq("eventId", `${conversationId}:new_lead`),
          )
          .first();
        const contact = await ctx.db.get(conversation.contactId);
        conversionEventId = await ctx.db.insert("conversionEvents", {
          accountId: args.accountId,
          conversationId,
          contactId: conversation.contactId,
          stage,
          lane: attribution.lane,
          backend: backendForLane(attribution.lane),
          eventName,
          identifier,
          ...(hasValue ? { value: args.saleValue, currency } : {}),
          phone: anchor?.phone ?? (contact ? normalizePhone(contact.phone) : ""),
          waMessageId: anchor?.waMessageId ?? "",
          firstMessageAt: anchor?.firstMessageAt ?? attribution.firstSeenAt,
          eventId,
          status: "pending",
          attempts: 0,
        });
        await ctx.scheduler.runAfter(
          0,
          internal.conversionEvents.deliverConversionEvent,
          { conversionEventId },
        );
      }
    }
  }

  await ctx.db.insert("funnelTransitions", {
    accountId: args.accountId,
    conversationId,
    contactId: conversation.contactId,
    stage,
    ...(args.byUserId ? { byUserId: args.byUserId } : {}),
    auto: args.auto,
    ...(conversionEventId ? { conversionEventId } : {}),
    ...(args.lossCategory ? { lossCategory: args.lossCategory } : {}),
    ...(args.lossDetail ? { lossDetail: args.lossDetail } : {}),
  });

  return { applied: true };
}

export const setStage = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    stage: STAGE_VALIDATOR,
    saleValue: v.optional(v.number()),
    saleCurrency: v.optional(v.string()),
    // Required (validated below) when stage === "lost".
    lossCategory: v.optional(v.string()),
    lossDetail: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    ctx.requireRole("agent");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "own",
    );

    const stage = args.stage as FunnelStageKey;
    const stageDef = getStage(stage);
    const hasValue = args.saleValue !== undefined && args.saleValue > 0;
    if (stageDef.needsValue && !hasValue) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "value_required" });
    }

    // Losing a deal demands the exact why: a fixed category + free text.
    const lossDetail = args.lossDetail?.trim() ?? "";
    if (
      stage === "lost" &&
      (!args.lossCategory ||
        !isLossCategory(args.lossCategory) ||
        lossDetail.length < 5)
    ) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: "loss_reason_required",
      });
    }

    // The deal-discipline gates work off the conversation's latest
    // qualification session's sales checklist (absent for organic /
    // pre-feature conversations → no gate).
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .first();
    const checklist =
      session && session.accountId === ctx.accountId
        ? await ctx.db
            .query("salesChecklists")
            .withIndex("by_session", (q) => q.eq("sessionId", session._id))
            .unique()
        : null;

    if (
      stage === "purchased" &&
      checklist &&
      !allItemsDone(checklist.items)
    ) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: "checklist_incomplete",
      });
    }

    const previousStage = conversation.funnel?.stage ?? null;
    const account = await ctx.db.get(ctx.accountId);
    const currency = args.saleCurrency ?? account?.defaultCurrency ?? "USD";
    await applyStageTransition(ctx, {
      accountId: ctx.accountId,
      conversation,
      stage,
      byUserId: ctx.userId,
      auto: false,
      saleValue: args.saleValue,
      saleCurrency: args.saleCurrency,
      defaultCurrency: account?.defaultCurrency ?? "USD",
      ...(stage === "lost"
        ? { lossCategory: args.lossCategory, lossDetail }
        : {}),
    });

    // Deal outcome bookkeeping + the AI-processable contact-note trail
    // (same trail agent WhatsApp feedback lands on). Authed path only —
    // the engine's auto transitions never touch won/lost.
    if (checklist) {
      if (stage === "purchased") {
        await ctx.db.patch(checklist._id, {
          outcome: { result: "won", at: Date.now(), byUserId: ctx.userId },
        });
      } else if (stage === "lost") {
        await ctx.db.patch(checklist._id, {
          outcome: {
            result: "lost",
            lossCategory: args.lossCategory,
            lossDetail,
            at: Date.now(),
            byUserId: ctx.userId,
          },
        });
      } else if (checklist.outcome) {
        await ctx.db.patch(checklist._id, { outcome: undefined });
      }
    }

    if (stage === "purchased") {
      await ctx.db.insert("contactNotes", {
        accountId: ctx.accountId,
        contactId: conversation.contactId,
        createdByUserId: ctx.userId,
        noteText: `🏆 Deal won — ${args.saleValue} ${currency}`,
      });
    } else if (stage === "lost") {
      await ctx.db.insert("contactNotes", {
        accountId: ctx.accountId,
        contactId: conversation.contactId,
        createdByUserId: ctx.userId,
        noteText: `❌ Deal lost (${args.lossCategory}): ${lossDetail}`,
      });
    } else if (previousStage === "purchased" || previousStage === "lost") {
      await ctx.db.insert("contactNotes", {
        accountId: ctx.accountId,
        contactId: conversation.contactId,
        createdByUserId: ctx.userId,
        noteText: `↩️ Deal reopened → ${stageDef.label}`,
      });
    }

    return args.conversationId;
  },
});

export const getState = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );

    const transitions = await ctx.db
      .query("funnelTransitions")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
    const reachedAt: Record<string, number> = {};
    for (const tr of transitions) {
      const at = tr._creationTime;
      if (reachedAt[tr.stage] === undefined || at < reachedAt[tr.stage]) {
        reachedAt[tr.stage] = at;
      }
    }

    const events = await ctx.db
      .query("conversionEvents")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
    const metaStatus: Record<string, string> = {};
    for (const ev of events) {
      metaStatus[ev.stage] = ev.status;
    }

    return {
      attributed: conversation.attribution !== undefined,
      lane: conversation.attribution?.lane ?? null,
      currentStage: conversation.funnel?.stage ?? null,
      saleValue: conversation.funnel?.saleValue,
      saleCurrency: conversation.funnel?.saleCurrency,
      reachedAt,
      metaStatus,
    };
  },
});
