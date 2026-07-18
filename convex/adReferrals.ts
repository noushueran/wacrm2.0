import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

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

    const prior = await ctx.db
      .query("adReferrals")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .first();
    const isFirstTouch = prior === null;

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
