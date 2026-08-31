import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  matchService,
  type MatchSignals,
  type ServiceCandidate,
} from "./lib/ads/serviceMatch";
import { landingUrlKey } from "./lib/ai/adContext";
import { generateReply } from "./lib/ai/generate";
import { aiJudgeModel, aiJudgeReasoningEffort, promptCacheKey } from "./lib/ai/defaults";
import { AiError, type AiUsage, type ChatMessage } from "./lib/ai/types";
import { tagContactForService } from "./qualificationEngine";
import { withExtraInstructions } from "./lib/agentRegistry";

// ============================================================
// Ad→service tagging (spec: docs/superpowers/specs/
// 2026-07-30-ad-referral-service-tagging-design.md).
//
// A click-to-WhatsApp lead already tells us which service it wants, but
// `tagContactForService` was only ever called from
// `qualificationEngine`'s completion path — so the contact stayed
// untagged until an AI qualification session finished. This module
// closes that gap using only signals ingest ALREADY captured.
//
// Budget is hard: at most two rule passes per AD REFERRAL (on the click,
// then on the next customer message), then at most one AI call. Scoped
// to the referral, not the conversation, on purpose — a second ad click
// into the same chat is genuinely new information (someone who clicked a
// UAE-visa ad and later a flights ad may want both), so each ad earns
// its own evaluation and its own budget. The whole state machine lives
// in four optional fields on the `adReferrals` row itself — no new
// table, and no way to loop.
// ============================================================

/** How many rule passes a single ad referral ever gets. */
const MAX_ATTEMPTS = 2;

/**
 * Customer messages in `conversationId` written at or after `sinceTime`,
 * oldest first, capped at `limit`. The lower bound rides the index's own
 * implicit trailing `_creationTime` field — Convex appends it to EVERY
 * index — so it narrows what is read rather than what is returned. The
 * same shape is used by `messages.ts`'s cursor pagination
 * (`.gte("_creationTime", args.cursorMs)`), `conversionEvents.ts`'s
 * `.gt("_creationTime", cursorMs)`, and `aiUsage.ts`'s spend window.
 *
 * It deliberately is NOT a `.filter()`: a Convex `.filter()` does not
 * narrow the index scan, so `.filter(gte)` + `.take(2)` would walk and
 * discard every customer message PREDATING the bound before it could
 * return — which is exactly the months-old returning-customer thread this
 * bound exists to handle, scanned in full on every scheduled pass.
 *
 * `sinceTime` should be `referralAnchorTime`'s result, NOT
 * `referral._creationTime` directly — see that function's own comment for
 * why the two differ. Fix (review pass, 2026-07-30): a returning
 * customer's ad click lands in their existing, possibly months-old
 * conversation, and the conversation's FIRST customer messages ever say
 * nothing about what THIS ad was for. Only messages from the click
 * onward are "the customer's own words" for this referral.
 *
 * Exported (2026-07-31) so `convex/adServiceBackfill.ts` can reuse this
 * exact anchor logic on the historical backlog instead of growing a
 * second copy that could drift from the live answer — reader-typed
 * already (`{ db: QueryCtx["db"] }`), so a mutation ctx satisfies it with
 * no cast. No behaviour change.
 */
export async function customerMessagesSince(
  ctx: { db: QueryCtx["db"] },
  conversationId: Id<"conversations">,
  sinceTime: number,
  limit: number,
) {
  return await ctx.db
    .query("messages")
    .withIndex("by_conversation_sender", (q) =>
      q
        .eq("conversationId", conversationId)
        .eq("senderType", "customer")
        .gte("_creationTime", sinceTime),
    )
    .order("asc")
    .take(limit);
}

/**
 * The `_creationTime` `customerMessagesSince` should bound at: the click
 * message's own timestamp when it can be found, else the referral row's.
 *
 * `recordAdReferral` (`ingest.ts:1031`) always runs strictly AFTER the
 * message insert (`ingest.ts:295`) that carries the referral it records,
 * so the click message is always timestamped BEFORE the referral row it
 * produced. Anchoring on `referral._creationTime` therefore always
 * excluded that click message — including its text, which is often the
 * single most informative message in the whole exchange ("hi, I need a
 * dubai visa" typed as the customer clicks). The first rule pass
 * (`trigger: "referral"`) never reads `customerText` at all, so there is
 * no double-counting risk in including it here.
 *
 * Looked up via `messages.by_message_id` on `referral.waMessageId` (===
 * `messages.messageId`, set at insert — `ingest.ts:295`), scoped to
 * `conversationId` with a `.filter()` the same way `ingest.ts`'s own
 * reply-linkage lookup is: wamids are not guaranteed globally unique (see
 * that lookup's comment), and the index has already narrowed the read to
 * the handful of rows sharing this exact wamid before the filter runs, so
 * this stays a single narrow indexed read rather than a scan.
 *
 * Falls back to `referral._creationTime` when the message can't be found
 * (e.g. purged) — NEVER to the conversation's start. A missing anchor
 * must narrow no less than the old bound, never turn it off.
 *
 * Exported (2026-07-31) for the same reason as `customerMessagesSince`
 * above — `convex/adServiceBackfill.ts` reuses it verbatim.
 */
export async function referralAnchorTime(
  ctx: { db: QueryCtx["db"] },
  referral: {
    waMessageId: string;
    conversationId: Id<"conversations">;
    _creationTime: number;
  },
): Promise<number> {
  const clickMessage = await ctx.db
    .query("messages")
    .withIndex("by_message_id", (q) => q.eq("messageId", referral.waMessageId))
    .filter((q) => q.eq(q.field("conversationId"), referral.conversationId))
    .first();
  return clickMessage?._creationTime ?? referral._creationTime;
}

/**
 * The conversation's own ad referral — most recent first. `adReferrals`
 * is indexed `by_contact`, not by conversation, so this filters in
 * memory; a contact has a handful of referrals at most, and adding an
 * index for a set that small would cost more than it saves.
 */
async function referralFor(
  ctx: { db: QueryCtx["db"] },
  args: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    conversationId: Id<"conversations">;
  },
) {
  const rows = await ctx.db
    .query("adReferrals")
    .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
    .collect();
  return (
    rows
      .filter(
        (r) =>
          r.accountId === args.accountId &&
          r.conversationId === args.conversationId,
      )
      .sort((a, b) => b._creationTime - a._creationTime)[0] ?? null
  );
}

/**
 * Applies the ad's service tag to the contact when the referral's own
 * signals name a service unambiguously.
 *
 * `trigger: "referral"` is the pass booked by the click itself, and
 * runs on ad text alone — the landing-page fetch and the Meta ad-name
 * resolution are both still in flight at that moment.
 * `trigger: "followup"` is the pass booked by the customer's next
 * message, and is materially better armed: both of those caches have
 * usually landed by then, and the customer's own words are available
 * too.
 *
 * Idempotent and self-limiting: a `matched` or `suggested` referral
 * returns immediately, and the attempt counter caps the rest. Callers
 * may therefore schedule this as often as they like.
 */
export const tagFromAd = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    trigger: v.union(v.literal("referral"), v.literal("followup")),
  },
  handler: async (ctx, args): Promise<void> => {
    // Defense-in-depth tenant guard (design.md's error-handling section
    // lists `conversation` among the documents guarded on `accountId`
    // equality). Transitively safe today without it too — `referralFor`
    // below already requires a referral matching both `accountId` and
    // `conversationId` — but `messages.by_conversation_sender`, queried
    // further down for the follow-up pass, is not itself account-scoped.
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;

    const referral = await referralFor(ctx, args);
    if (!referral) return;
    if (
      referral.serviceMatchStatus === "matched" ||
      referral.serviceMatchStatus === "suggested"
    ) {
      return;
    }
    const attempts = referral.serviceMatchAttempts ?? 0;
    if (attempts >= MAX_ATTEMPTS) return;

    const signals: MatchSignals = {
      headline: referral.headline,
      body: referral.body,
      sourceUrl: referral.sourceUrl,
    };

    // The advertiser's own naming — strongest signal there is, but only
    // once Meta resolution has actually landed.
    if (referral.adId) {
      const adId = referral.adId;
      const ad = await ctx.db
        .query("campaignAds")
        .withIndex("by_account_ad", (q) =>
          q.eq("accountId", args.accountId).eq("adId", adId),
        )
        .first();
      if (ad && ad.resolveStatus === "resolved") {
        signals.adName = ad.adName;
        signals.adSetName = ad.adSetName;
        signals.campaignName = ad.campaignName;
      }
    }

    // Whatever the landing-page cache has, `status` regardless — an
    // `error` row keeps its last good extraction on purpose.
    if (referral.sourceUrl) {
      const urlKey = landingUrlKey(referral.sourceUrl);
      if (urlKey) {
        const page = await ctx.db
          .query("adLandingPages")
          .withIndex("by_account_url", (q) =>
            q.eq("accountId", args.accountId).eq("urlKey", urlKey),
          )
          .first();
        if (page) {
          signals.landingTitle = page.title;
          signals.landingDescription = page.description;
        }
      }
    }

    if (args.trigger === "followup") {
      const anchorTime = await referralAnchorTime(ctx, referral);
      const inbound = await customerMessagesSince(
        ctx,
        args.conversationId,
        anchorTime,
        2,
      );
      const text = inbound
        .map((m) => m.contentText ?? "")
        .filter((s) => s.trim().length > 0)
        .join(" ");
      if (text) signals.customerText = text;
    }

    const services: ServiceCandidate[] = (
      await ctx.db
        .query("kbServices")
        .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
        .collect()
    ).map((s) => ({
      key: s.key,
      name: s.name,
      aliases: s.aliases,
      status: s.status,
    }));

    const result = matchService(signals, services);
    const nextAttempts = attempts + 1;

    if (result.status === "matched") {
      await tagContactForService(ctx, {
        accountId: args.accountId,
        contactId: args.contactId,
        serviceName: result.serviceName,
        source: "ad",
      });
      await ctx.db.patch(referral._id, {
        serviceMatchStatus: "matched",
        serviceMatchKey: result.serviceKey,
        serviceMatchedOn: result.matchedOn,
        serviceMatchAttempts: nextAttempts,
      });
      return;
    }

    await ctx.db.patch(referral._id, {
      serviceMatchStatus: result.status === "ambiguous" ? "ambiguous" : "unmatched",
      serviceMatchAttempts: nextAttempts,
    });

    // Both rule passes spent and still nothing. One AI guess, into the
    // existing suggestion banner for a human to accept. `referral._id` is
    // threaded through explicitly — THIS row, the one that just spent its
    // budget, not "whichever referral this conversation has when the
    // action gets around to running" (a later ad click could land in the
    // gap between scheduling and execution and produce a fresh, newer
    // row that `referralFor` would resolve to instead).
    if (nextAttempts >= MAX_ATTEMPTS) {
      await ctx.scheduler.runAfter(0, internal.adServiceTagging.classifyAdService, {
        accountId: args.accountId,
        contactId: args.contactId,
        conversationId: args.conversationId,
        referralId: referral._id,
      });
    }
  },
});

// ------------------------------------------------------------
// AI fallback — reached only after BOTH rule passes missed.
// ------------------------------------------------------------

/**
 * Everything `classifyAdService` needs in one read: the ad's own text,
 * the customer's opening messages, and the account's active service
 * names. Loads the ONE referral the caller already resolved (`referralId`
 * — the row that actually spent its budget), never re-resolving "the
 * conversation's latest referral": a second ad click landing in the gap
 * between scheduling and this query running would otherwise describe the
 * wrong ad to the model. Returns `null` when there is nothing to
 * classify — the referral is missing/cross-tenant, or the account has no
 * active service catalogue.
 */
export const classifyContext = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    referralId: v.id("adReferrals"),
  },
  handler: async (ctx, args) => {
    const referral = await ctx.db.get(args.referralId);
    if (
      !referral ||
      referral.accountId !== args.accountId ||
      referral.conversationId !== args.conversationId
    ) {
      return null;
    }

    // Defense-in-depth tenant guard — same as `tagFromAd`'s (see its own
    // comment): `messages.by_conversation_sender`, queried below, is not
    // itself account-scoped.
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return null;

    const services = (
      await ctx.db
        .query("kbServices")
        .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
        .collect()
    )
      .filter((s) => s.status === "active")
      .map((s) => ({ name: s.name, aliases: s.aliases }));
    if (services.length === 0) return null;

    const anchorTime = await referralAnchorTime(ctx, referral);
    const inbound = await customerMessagesSince(
      ctx,
      args.conversationId,
      anchorTime,
      2,
    );

    return {
      services,
      ad: {
        headline: referral.headline ?? "",
        body: referral.body ?? "",
        sourceUrl: referral.sourceUrl ?? "",
      },
      customerText: inbound
        .map((m) => m.contentText ?? "")
        .filter((s) => s.trim().length > 0)
        .join("\n"),
    };
  },
});

/**
 * Marks ONE specific referral `suggested` — the terminal state for that
 * referral's ad-tagging. Takes `referralId` directly rather than
 * re-resolving "the conversation's latest referral": that row is exactly
 * the one whose budget `tagFromAd` just spent scheduling this call, and
 * stamping a DIFFERENT (e.g. newer) row instead would burn that other
 * ad's two rule passes without ever evaluating it, while leaving the row
 * that actually paid for this call stuck `unmatched` forever. The
 * `accountId` equality check is the tenant guard — this never patches a
 * row before confirming it belongs to the caller's own account. Called
 * whether or not a suggestion is actually recorded afterward: the AI
 * pass is spent either way, and leaving the row `unmatched` would let a
 * later `tagFromAd` book a second call on it.
 */
export const markSuggested = internalMutation({
  args: {
    accountId: v.id("accounts"),
    referralId: v.id("adReferrals"),
  },
  handler: async (ctx, args): Promise<void> => {
    const referral = await ctx.db.get(args.referralId);
    if (!referral || referral.accountId !== args.accountId) return;
    await ctx.db.patch(referral._id, { serviceMatchStatus: "suggested" });
  },
});

/** The account's tag whose name equals `serviceName`, case-insensitively. */
export const tagIdByName = internalQuery({
  args: { accountId: v.id("accounts"), serviceName: v.string() },
  handler: async (ctx, args): Promise<Id<"tags"> | null> => {
    const wanted = args.serviceName.trim().toLowerCase();
    const tags = await ctx.db
      .query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    return tags.find((t) => t.name.trim().toLowerCase() === wanted)?._id ?? null;
  },
});

/**
 * Renders the closed option set. The model may only answer with one of
 * these names or the literal `NONE` — same "fixed options" discipline
 * as `lib/ai/classify.ts`'s `buildClassifyPrompt`, narrowed to services.
 */
function buildAdServicePrompt(
  services: { name: string; aliases: string[] }[],
  extraInstructions?: string | null,
): string {
  const options = services
    .map((s) =>
      s.aliases.length > 0 ? `- ${s.name} (also called: ${s.aliases.join(", ")})` : `- ${s.name}`,
    )
    .join("\n");
  return withExtraInstructions(
    [
      "You identify which service a customer is interested in, based on the",
      "Facebook/Instagram ad they clicked and their first messages.",
      "",
      "Choose EXACTLY ONE of these services, or answer NONE:",
      options,
    ].join("\n"),
    [
      "Customers may write in any language, including Malayalam written in",
      "Latin script (Manglish). Answer with the service name exactly as",
      "written above, or the single word NONE. No explanation, no other text.",
    ].join("\n"),
    extraInstructions,
  );
}

/**
 * The last resort: one judge-tier call, recorded as a PENDING
 * suggestion for an agent to accept — never auto-applied. A rule match
 * is evidence; this is a guess, and a guess gets a human gate.
 *
 * `referralId` identifies the ONE referral this call is spending its
 * budget on — threaded through from `tagFromAd`'s own `referral._id`
 * rather than re-resolved here, so a second ad click landing in the gap
 * between scheduling and execution can never hijack this call's budget
 * (see `markSuggested`'s own comment for the failure mode this closes).
 *
 * Guards against `internal.aiTagging.existingPending` before spending a
 * provider call (see the inline comment at that check for why there,
 * not after) — an agent may already have a pending suggestion on this
 * conversation (a manual "Suggest tags" click, or a different ad's
 * fallback landing first), and `recordSuggestion` has no uniqueness
 * constraint of its own to fall back on.
 *
 * Every failure path is swallowed. The referral row is marked
 * `suggested` first thing — even when the pending-guard above causes an
 * early return, or a crash happens mid-call — so the referral is never
 * left eligible for a second (paid) attempt.
 */
export const classifyAdService = internalAction({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    referralId: v.id("adReferrals"),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      // Marks the referral `suggested` FIRST, unconditionally — the
      // budget (two rule passes) is spent either way, whether or not a
      // suggestion ends up recorded below. Leaving the row `unmatched`
      // here would make it eligible for a retry, which could only ever
      // repeat this exact same outcome (or duplicate a pending row).
      await ctx.runMutation(internal.adServiceTagging.markSuggested, {
        accountId: args.accountId,
        referralId: args.referralId,
      });

      // Idempotency guard — BEFORE any config load or the classify call
      // itself, so a redundant fallback never burns a provider call on a
      // conversation that already has a pending suggestion sitting in
      // the banner. Reuses `aiTagging.existingPending` rather than a new
      // query: same shape, same account scoping, same accepted "narrows
      // rather than eliminates" race as `aiTagging.suggest`'s own use of
      // it (see that query's comment).
      const existing = await ctx.runQuery(internal.aiTagging.existingPending, {
        accountId: args.accountId,
        conversationId: args.conversationId,
      });
      if (existing) return;

      const context = await ctx.runQuery(internal.adServiceTagging.classifyContext, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        referralId: args.referralId,
      });
      if (!context) return;

      let config;
      try {
        config = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
          accountId: args.accountId,
        });
      } catch {
        return; // undecryptable key — nothing to do, and nothing to say
      }
      if (!config || !config.isActive || !config.apiKey) return;

      const extraInstructions = await ctx.runQuery(
        internal.agentInstructions.forAgent,
        { accountId: args.accountId, agentKey: "admatch" },
      );
      const systemPrompt = buildAdServicePrompt(context.services, extraInstructions);
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            `Ad headline: ${context.ad.headline || "(none)"}`,
            `Ad body: ${context.ad.body || "(none)"}`,
            `Ad link: ${context.ad.sourceUrl || "(none)"}`,
            `Customer's first messages: ${context.customerText || "(none)"}`,
          ].join("\n"),
        },
      ];
      const judgeModelId = aiJudgeModel(config.provider, config.model);

      let raw: string;
      let usage: AiUsage | null = null;
      if (process.env.CONVEX_AI_DRY_RUN) {
        // Deterministic stand-in, mirroring `aiTagging.ts`'s
        // `syntheticClassifyRaw`: always the first option, so a dry-run
        // test exercises the full record path without a network call.
        raw = context.services[0]?.name ?? "NONE";
      } else {
        try {
          const gen = await generateReply({
            provider: config.provider,
            model: judgeModelId,
            apiKey: config.apiKey,
            systemPrompt,
            messages,
            reasoningEffort: aiJudgeReasoningEffort(),
            promptCacheKey: promptCacheKey(args.accountId, "classify"),
          });
          raw = gen.text;
          usage = gen.usage;
        } catch (err) {
          if (err instanceof AiError) return;
          throw err;
        }
      }

      const answer = raw.trim();
      if (answer && answer.toUpperCase() !== "NONE") {
        const tagId = await ctx.runQuery(internal.adServiceTagging.tagIdByName, {
          accountId: args.accountId,
          serviceName: answer,
        });
        if (tagId) {
          await ctx.runMutation(internal.aiTagging.recordSuggestion, {
            accountId: args.accountId,
            conversationId: args.conversationId,
            contactId: args.contactId,
            suggestedTagIds: [tagId],
            confidence: "low",
            model: judgeModelId,
          });
        }
      }

      if (usage) {
        try {
          await ctx.runMutation(internal.aiUsage.log, {
            accountId: args.accountId,
            conversationId: args.conversationId,
            // NOT "classify" — that is the tag suggester's mode. Sharing
            // it made both agents' usage uncountable; see `schema.ts`'s
            // `aiUsageLog.mode` comment.
            mode: "match_service",
            provider: config.provider,
            model: judgeModelId,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            cachedPromptTokens: usage.cachedPromptTokens,
            reasoningTokens: usage.reasoningTokens,
          });
        } catch (err) {
          console.warn("[ad service tagging] usage log failed:", err);
        }
      }
    } catch (err) {
      console.error("[ad service tagging] classify failed:", err);
    }
  },
});
