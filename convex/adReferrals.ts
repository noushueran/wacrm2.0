import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { bumpConversationStartedStat } from "./messages";

// Referral sub-object, in main's camelCase `AdReferral` shape (see
// `webhookParse.ts`'s `AdReferral` + `ingest.ts`'s `inboundMessageValidator`).
// Exported so `ingest.ts` imports one source of truth. Display-only fields
// (imageUrl/videoUrl/thumbnailUrl) are accepted but not persisted here — the
// image lives on the `conversation.adReferral` denorm, not this raw log.
export const adReferralInputValidator = v.object({
  sourceType: v.optional(v.union(v.literal("ad"), v.literal("post"))),
  sourceId: v.optional(v.string()),
  sourceUrl: v.optional(v.string()),
  headline: v.optional(v.string()),
  body: v.optional(v.string()),
  mediaType: v.optional(v.union(v.literal("image"), v.literal("video"))),
  imageUrl: v.optional(v.string()),
  videoUrl: v.optional(v.string()),
  thumbnailUrl: v.optional(v.string()),
});

/**
 * Records one inbound ad-referral (raw event log) and, for a genuine ad
 * (`sourceType === "ad"` with a `sourceId`), ensures a single `pending`
 * `campaignAds` cache row for later name resolution.
 * `isFirstTouch` = this contact has no prior `adReferrals`. Message-level
 * idempotency is the caller's concern (`processInbound` skips webhook
 * retries); this mutation additionally no-ops a duplicate `campaignAds`
 * insert. Phase 0 does NOT fire any conversion event — Phase 1 owns that.
 *
 * Also feeds the reports rollup's `conversationsStartedAd` counter
 * (docs/superpowers/specs/2026-08-05-reports-section-design.md): the first
 * referral recorded on a given CONVERSATION bumps it, and ONLY for a
 * genuine ad (`sourceType === "ad"`) — the same gate the `campaignAds`
 * resolution block below uses, and the one `adReferrals.sourceType`'s own
 * schema.ts comment calls out ("ad" — resolution guards on this"). A
 * `"post"` (an organic Facebook/Instagram post tap) or a ctwaClid-only
 * referral (`sourceType` absent) still gets its `adReferrals` row below
 * exactly as before — other features read that row — it just isn't
 * AD-sourced, so it must not inflate a counter named for ads. The dedup is
 * written per-CONVERSATION rather than reusing the per-CONTACT
 * `isFirstTouch` above; in this repo today those two are behaviourally
 * IDENTICAL (a contact has exactly one conversation, forever) — see that
 * guard's own comment below for why it is still written the longer way.
 */
export const recordAdReferral = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    waMessageId: v.string(),
    ctwaClid: v.optional(v.string()),
    referral: adReferralInputValidator,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    adReferralId: Id<"adReferrals">;
    isFirstTouch: boolean;
    adId?: string;
    ctwaClid?: string;
    needsResolve: boolean;
  }> => {
    const { accountId, contactId, conversationId, waMessageId, ctwaClid, referral } =
      args;
    const adId = referral.sourceId;

    // `.collect()`, not `.first()`: the ad-sourced rollup guard below needs
    // every prior referral on THIS contact, to check whether any of them
    // already landed on THIS conversation. Collecting once and deriving
    // both `isFirstTouch` and that guard from the same result avoids a
    // second, identical `by_contact` read.
    const priorReferrals = await ctx.db
      .query("adReferrals")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect();
    const isFirstTouch = priorReferrals.length === 0;

    let needsResolve = false;
    if (referral.sourceType === "ad" && adId) {
      const existing = await ctx.db
        .query("campaignAds")
        .withIndex("by_account_ad", (q) =>
          q.eq("accountId", accountId).eq("adId", adId),
        )
        .first();
      if (!existing) {
        const campaignAdId = await ctx.db.insert("campaignAds", {
          accountId,
          adId,
          resolveStatus: "pending",
          attempts: 0,
        });
        // Without META_ADS_ACCESS_TOKEN, resolveAd retires the row to
        // "dormant" rather than leaving it "pending" — so a CTWA lead
        // arriving while the token is unset costs one scheduled run, not a
        // reschedule on every cron tick from now on. The retry cron revives
        // it once a token exists.
        await ctx.scheduler.runAfter(0, internal.campaignAds.resolveAd, {
          campaignAdId,
        });
        needsResolve = true;
      }
    }

    // Count this conversation as ad-sourced the first time a referral
    // lands on it — but ONLY for a genuine ad (`sourceType === "ad"`),
    // matching the `campaignAds` resolution gate just above and
    // `adReferrals.sourceType`'s own schema.ts comment ("ad" — resolution
    // guards on this"). A `"post"` (organic Facebook/Instagram tap) or an
    // absent `sourceType` (the ctwaClid-only shape `ingest.ts` sends when
    // there's no previewable creative) must NOT bump a counter named for
    // ads — this is an intentional exclusion, not an oversight. The row
    // below is still written for either case; only this rollup counter is
    // gated.
    if (referral.sourceType === "ad") {
      // The guard is per-CONVERSATION, deliberately not the per-CONTACT
      // `isFirstTouch` computed above — even though, in THIS repo as it
      // stands, the two are behaviourally identical.
      //
      // Every path that creates a conversation is find-or-create BY
      // CONTACT, with no status and no archived filter: `ingest.ts`'s
      // `by_contact` lookup before `insertConversation`,
      // `conversations.findOrCreateForContact` and its server-only twin,
      // and `qualificationEngine.ts`. So a contact has exactly ONE
      // conversation, forever. A returning customer who clicks a second ad
      // lands back in that same conversation, trips
      // `alreadyCountedThisConversation` below, and is not counted again —
      // precisely what `isFirstTouch` (false for that row) would also have
      // done. Stated plainly because a report will be built on this:
      // `conversationsStartedAd` is therefore capped at one per CONTACT
      // ever, and a retargeting campaign that re-engages known contacts
      // contributes ZERO to it.
      //
      // It is written per-conversation anyway, on purpose: that is the
      // semantics the counter's name claims, it matches what
      // `messages.backfillConversationStartedStats` computes over history,
      // and it keeps the counter correct with no migration if
      // one-conversation-per-contact ever stops holding (a "reopen as a new
      // thread" flow, an archive-then-restart). Future-proofing — not a
      // difference between the two guards that exists today.
      const alreadyCountedThisConversation = priorReferrals.some(
        (r) => r.conversationId === conversationId,
      );
      if (!alreadyCountedThisConversation) {
        const conversation = await ctx.db.get(conversationId);
        if (conversation) {
          await bumpConversationStartedStat(
            ctx,
            accountId,
            conversation._creationTime,
            "conversationsStartedAd",
          );
        }
      }
    }

    const adReferralId = await ctx.db.insert("adReferrals", {
      accountId,
      contactId,
      conversationId,
      waMessageId,
      ctwaClid,
      adId,
      sourceType: referral.sourceType,
      sourceUrl: referral.sourceUrl,
      headline: referral.headline,
      body: referral.body,
      mediaType: referral.mediaType,
      isFirstTouch,
    });

    return { adReferralId, isFirstTouch, adId, ctwaClid, needsResolve };
  },
});
