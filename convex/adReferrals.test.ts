import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

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
