"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import webpush from "web-push";

// Sends Web Push for one inbound message. Thin by design: all recipient /
// preference / payload logic lives in `push.assembleDelivery` (default
// runtime, unit-tested); this only signs + POSTs and prunes dead
// subscriptions. Never throws to its caller (best-effort in ingest).
export const deliverForMessage = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contentType: v.string(),
    text: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;
    if (!publicKey || !privateKey || !subject) {
      console.error("[push] VAPID env not configured; skipping send");
      return null;
    }
    webpush.setVapidDetails(subject, publicKey, privateKey);

    const { jobs } = await ctx.runQuery(internal.push.assembleDelivery, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contentType: args.contentType,
      text: args.text,
    });

    await Promise.all(
      jobs.map(async (job) => {
        try {
          await webpush.sendNotification(
            { endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } },
            JSON.stringify(job.payload),
          );
        } catch (err: unknown) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            // Gone — prune the dead subscription.
            await ctx.runMutation(internal.push.deleteByEndpoint, { endpoint: job.endpoint });
          } else {
            console.error("[push] send failed, status:", status ?? "unknown");
          }
        }
      }),
    );
    return null;
  },
});
