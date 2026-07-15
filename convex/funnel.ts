import { accountMutation } from "./lib/auth";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireConversationAccess } from "./lib/conversationAccess";
import { normalizePhone } from "./lib/phone";
import {
  resolveEventName,
  backendForLane,
  getStage,
  type FunnelStageKey,
} from "./lib/funnel";

const STAGE_VALIDATOR = v.union(
  v.literal("new_lead"),
  v.literal("qualified"),
  v.literal("price_quoted"),
  v.literal("itinerary_created"),
  v.literal("itinerary_sent"),
  v.literal("invoice_sent"),
  v.literal("purchased"),
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
export const setStage = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    stage: STAGE_VALIDATOR,
    saleValue: v.optional(v.number()),
    saleCurrency: v.optional(v.string()),
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

    const now = Date.now();
    const account = await ctx.db.get(ctx.accountId);
    const currency = args.saleCurrency ?? account?.defaultCurrency ?? "USD";

    await ctx.db.patch(args.conversationId, {
      funnel: {
        stage,
        stageUpdatedAt: now,
        stageUpdatedByUserId: ctx.userId,
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
        const eventId = `${args.conversationId}:${stage}`;
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
              q.eq("eventId", `${args.conversationId}:new_lead`),
            )
            .first();
          const contact = await ctx.db.get(conversation.contactId);
          conversionEventId = await ctx.db.insert("conversionEvents", {
            accountId: ctx.accountId,
            conversationId: args.conversationId,
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
      accountId: ctx.accountId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      stage,
      byUserId: ctx.userId,
      auto: false,
      ...(conversionEventId ? { conversionEventId } : {}),
    });

    return args.conversationId;
  },
});
