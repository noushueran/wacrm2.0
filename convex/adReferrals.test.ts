import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { insertConversation } from "./conversations";
import { hourStartMs } from "./lib/messageStats";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Acme",
      email: "acme@example.com",
    });
    return await ctx.db.insert("accounts", {
      name: "Acme's account",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
  });
}

async function seedContactAndConversation(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15551230000",
      phoneNormalized: "15551230000",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
    });
    return { contactId, conversationId };
  });
}

test("recordAdReferral logs the referral, marks first-touch, and seeds a pending campaignAds row", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedContactAndConversation(
    t,
    accountId,
  );

  const res = await t.mutation(internal.adReferrals.recordAdReferral, {
    accountId,
    contactId,
    conversationId,
    waMessageId: "wamid.AD1",
    ctwaClid: "clid-1",
    referral: { sourceType: "ad", sourceId: "AD1", headline: "Maldives" },
  });

  expect(res.isFirstTouch).toBe(true);
  expect(res.adId).toBe("AD1");
  expect(res.ctwaClid).toBe("clid-1");
  expect(res.needsResolve).toBe(true);

  const rows = await t.run((ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].isFirstTouch).toBe(true);
  expect(rows[0].ctwaClid).toBe("clid-1");
  expect(rows[0].headline).toBe("Maldives");

  const ads = await t.run((ctx) =>
    ctx.db
      .query("campaignAds")
      .withIndex("by_account_ad", (q) =>
        q.eq("accountId", accountId).eq("adId", "AD1"),
      )
      .collect(),
  );
  expect(ads).toHaveLength(1);
  expect(ads[0].resolveStatus).toBe("pending");
});

test("recordAdReferral marks isFirstTouch=false for a contact's second referral and does not re-seed the ad", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedContactAndConversation(
    t,
    accountId,
  );

  const first = await t.mutation(internal.adReferrals.recordAdReferral, {
    accountId,
    contactId,
    conversationId,
    waMessageId: "wamid.AD1",
    ctwaClid: "clid-1",
    referral: { sourceType: "ad", sourceId: "AD1" },
  });
  expect(first.isFirstTouch).toBe(true);

  const second = await t.mutation(internal.adReferrals.recordAdReferral, {
    accountId,
    contactId,
    conversationId,
    waMessageId: "wamid.AD2",
    ctwaClid: "clid-2",
    referral: { sourceType: "ad", sourceId: "AD1" },
  });
  expect(second.isFirstTouch).toBe(false);
  expect(second.needsResolve).toBe(false); // AD1 already cached

  const ads = await t.run((ctx) =>
    ctx.db
      .query("campaignAds")
      .withIndex("by_account_ad", (q) =>
        q.eq("accountId", accountId).eq("adId", "AD1"),
      )
      .collect(),
  );
  expect(ads).toHaveLength(1);
});

// ============================================================
// conversationsStartedAd (reports rollup, Task 2:
// docs/superpowers/specs/2026-08-05-reports-section-design.md). The dedup
// guard is per-CONVERSATION rather than `recordAdReferral`'s existing
// per-CONTACT `isFirstTouch`, but the two are behaviourally IDENTICAL in
// this repo as it stands: every conversation-creating path is
// find-or-create by contact (see `recordAdReferral`'s own comment), so a
// contact has exactly one conversation and a repeat ad click always lands
// back in it. The per-conversation form is future-proofing — the tests
// below pin it as the intended CONTRACT, not as a difference observable
// through any production path today.
// ============================================================

/**
 * Seeds an account/contact/conversation via `insertConversation` (not a
 * raw `ctx.db.insert("conversations", ...)`, unlike
 * `seedContactAndConversation` above) so the conversation carries its own
 * `conversationsStarted` write and so `conversationHourMs` reflects the
 * real hour-bucketing key `bumpConversationStartedStat` uses.
 */
async function seedAdScenario(t: ReturnType<typeof convexTest>) {
  const accountId = await seedAccount(t);
  const contactId = await t.run(async (ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "+971500000009",
      phoneNormalized: "971500000009",
    }),
  );
  const conversationId = await t.run(async (ctx) =>
    insertConversation(ctx, { accountId, contactId }),
  );
  const conversationHourMs = await t.run(async (ctx) => {
    const c = await ctx.db.get(conversationId);
    return hourStartMs(c!._creationTime);
  });
  return { accountId, contactId, conversationId, conversationHourMs };
}

test("the first ad referral on a conversation counts it as ad-sourced, in the CONVERSATION's hour", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, conversationHourMs } =
    await seedAdScenario(t);

  await t.mutation(internal.adReferrals.recordAdReferral, {
    accountId,
    contactId,
    conversationId,
    waMessageId: "wamid.1",
    referral: { sourceType: "ad", sourceId: "120200000000000001" },
  });

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", accountId).eq("hourStartMs", conversationHourMs),
      )
      .unique(),
  );
  expect(row?.conversationsStartedAd).toBe(1);
});

test("a second referral on the SAME conversation does not double-count it", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, conversationHourMs } =
    await seedAdScenario(t);

  for (const wamid of ["wamid.1", "wamid.2"]) {
    await t.mutation(internal.adReferrals.recordAdReferral, {
      accountId,
      contactId,
      conversationId,
      waMessageId: wamid,
      referral: { sourceType: "ad", sourceId: "120200000000000001" },
    });
  }

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", accountId).eq("hourStartMs", conversationHourMs),
      )
      .unique(),
  );
  expect(row?.conversationsStartedAd).toBe(1);
});

// Calls `insertConversation` DIRECTLY for the second conversation, which
// is the only way to produce two conversations for one contact — no
// production path does (they all find-or-create by contact). So this pins
// the guard's per-conversation CONTRACT against the day that changes; it
// is not a scenario a returning customer can reach today, where the second
// click reuses the first conversation and is deliberately not re-counted
// (the test above).
test("a contact's SECOND conversation is counted again (contract, not a reachable path today)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seedAdScenario(t);

  await t.mutation(internal.adReferrals.recordAdReferral, {
    accountId,
    contactId,
    conversationId,
    waMessageId: "wamid.1",
    referral: { sourceType: "ad", sourceId: "ad-1" },
  });

  const secondConversationId = await t.run(async (ctx) =>
    insertConversation(ctx, { accountId, contactId }),
  );
  await t.mutation(internal.adReferrals.recordAdReferral, {
    accountId,
    contactId,
    conversationId: secondConversationId,
    waMessageId: "wamid.2",
    referral: { sourceType: "ad", sourceId: "ad-2" },
  });

  const total = await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
      .collect();
    return rows.reduce((sum, r) => sum + (r.conversationsStartedAd ?? 0), 0);
  });
  expect(total).toBe(2);
});

// ------------------------------------------------------------
// `conversationsStartedAd` is gated on `sourceType === "ad"` (fix round
// 1): an organic post tap or a ctwaClid-only referral must still be
// LOGGED (the `adReferrals` row, `isFirstTouch`, the per-conversation
// dedup state) exactly as before — only the ad-attribution counter is
// excluded, since it isn't an ad.
// ------------------------------------------------------------

test("a \"post\" referral records the adReferrals row but does not count as ad-sourced", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, conversationHourMs } =
    await seedAdScenario(t);

  await t.mutation(internal.adReferrals.recordAdReferral, {
    accountId,
    contactId,
    conversationId,
    waMessageId: "wamid.post1",
    referral: { sourceType: "post", sourceId: "post-1" },
  });

  // The row is still written — other features read it — untouched by the
  // counter gate.
  const referralRows = await t.run((ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(referralRows).toHaveLength(1);
  expect(referralRows[0]!.sourceType).toBe("post");
  expect(referralRows[0]!.isFirstTouch).toBe(true);

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", accountId).eq("hourStartMs", conversationHourMs),
      )
      .unique(),
  );
  // `conversationsStarted` (from `insertConversation` inside
  // `seedAdScenario`) is untouched by this test and still 1 — proving the
  // row exists and only the ad-sourced counter was skipped, not the write
  // entirely.
  expect(row?.conversationsStarted).toBe(1);
  expect(row?.conversationsStartedAd ?? 0).toBe(0);
});

test("a ctwaClid-only referral (no sourceType) does not count as ad-sourced either", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId, conversationHourMs } =
    await seedAdScenario(t);

  // The shape `ingest.ts` actually sends for a message with only a
  // `ctwa_clid` and no previewable creative: `referral: message.referral ??
  // {}`, so `sourceType` is `undefined`, not `"ad"`.
  await t.mutation(internal.adReferrals.recordAdReferral, {
    accountId,
    contactId,
    conversationId,
    waMessageId: "wamid.ctwa1",
    ctwaClid: "clid-only",
    referral: {},
  });

  const referralRows = await t.run((ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(referralRows).toHaveLength(1);
  expect(referralRows[0]!.sourceType).toBeUndefined();
  expect(referralRows[0]!.ctwaClid).toBe("clid-only");

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", accountId).eq("hourStartMs", conversationHourMs),
      )
      .unique(),
  );
  expect(row?.conversationsStarted).toBe(1);
  expect(row?.conversationsStartedAd ?? 0).toBe(0);
});
