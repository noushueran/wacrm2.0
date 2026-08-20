import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { encrypt } from "./lib/whatsappEncryption";

const modules = import.meta.glob("/convex/**/*.ts");

// The three AI-fallback tests below schedule `classifyAdService` via
// `ctx.scheduler.runAfter` and drain it with `finishAllScheduledFunctions`,
// which requires fake timers to advance the real `setTimeout` the
// convex-test scheduler runs on internally (same pattern as
// `aiReply.test.ts`'s retry tests) — restored after every test so the
// other (non-scheduling) tests in this file keep seeing a real clock.
afterEach(() => {
  // Belt-and-suspenders, matching `ingest.test.ts`'s own DRY-RUN afterEach:
  // a thrown assertion could skip a test's own inline cleanup otherwise,
  // leaking the env var into later tests in this file.
  delete process.env.CONVEX_AI_DRY_RUN;
  vi.useRealTimers();
});

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Acme",
      email: "acme@example.com",
    });
    const accountId = await ctx.db.insert("accounts", {
      name: "Acme's account",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
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
      updatedAt: Date.now(),
    });
    await ctx.db.insert("kbServices", {
      accountId,
      key: "uae-visa",
      name: "UAE Visa",
      aliases: ["dubai visa"],
      status: "active",
      sortOrder: 0,
      updatedAt: Date.now(),
    });
    return { accountId, contactId, conversationId };
  });
}

async function seedReferral(
  t: ReturnType<typeof convexTest>,
  ids: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    conversationId: Id<"conversations">;
  },
  referral: {
    headline?: string;
    body?: string;
    sourceUrl?: string;
    // Optional: pins the referral to a specific click message (see
    // `referralAnchorTime` in `adServiceTagging.ts`) instead of the default
    // random wamid that matches no message. Every other call site leaves
    // this unset, so the random default — and with it, coverage of the
    // fallback branch (`referral._creationTime`) — stays exercised.
    waMessageId?: string;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("adReferrals", {
      accountId: ids.accountId,
      contactId: ids.contactId,
      conversationId: ids.conversationId,
      waMessageId: `wamid.${Math.random()}`,
      sourceType: "ad",
      isFirstTouch: true,
      ...referral,
    }),
  );
}

/** Active AI config, seeded directly (bypassing `aiConfig.upsert`'s own
 *  admin-role gate — this suite has no membership/identity) with a
 *  genuinely encrypted `apiKey` (`aiConfig.loadDecrypted` always
 *  decrypts it, dry run or not). Copied from `convex/ingest.test.ts`'s
 *  own `seedAiConfig` — the brief's inline insert used invented field
 *  names (`apiKeyCiphertext`) and the wrong table name (`aiConfig`
 *  instead of the real `aiConfigs`); this is the real shape.
 */
async function seedAiConfig(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  const apiKey = await encrypt("sk-test-key");
  return await t.run((ctx) =>
    ctx.db.insert("aiConfigs", {
      accountId,
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey,
      isActive: true,
      autoReplyEnabled: true,
    }),
  );
}

// `ReturnType<typeof convexTest>` loses this suite's concrete index
// names (see `convex/ingest.test.ts`'s own `tagLink` for the identical,
// already-documented gotcha), so this filters rather than `.withIndex`.
async function tagsOf(t: ReturnType<typeof convexTest>, contactId: Id<"contacts">) {
  return await t.run(async (ctx) => {
    const links = await ctx.db
      .query("contactTags")
      .filter((q) => q.eq(q.field("contactId"), contactId))
      .collect();
    return await Promise.all(
      links.map(async (l) => ({
        source: l.source,
        name: (await ctx.db.get(l.tagId))?.name,
      })),
    );
  });
}

test("a confident referral match tags the contact with source 'ad'", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });

  await t.mutation(internal.adServiceTagging.tagFromAd, {
    ...ids,
    trigger: "referral",
  });

  expect(await tagsOf(t, ids.contactId)).toEqual([
    { source: "ad", name: "UAE Visa" },
  ]);
});

test("re-running on a matched referral is a no-op", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });

  expect(await tagsOf(t, ids.contactId)).toHaveLength(1);
});

test("a miss on the referral pass records unmatched and does not tag", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Talk to our team" });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });

  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("unmatched");
  expect(row?.serviceMatchAttempts).toBe(1);
});

test("a tie records ambiguous rather than guessing", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("kbServices", {
      accountId: ids.accountId,
      key: "flight-booking",
      name: "Flight Booking",
      aliases: [],
      status: "active",
      sortOrder: 1,
      updatedAt: Date.now(),
    });
  });
  const referralId = await seedReferral(t, ids, {
    headline: "UAE Visa and Flight Booking combo",
  });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });

  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("ambiguous");
});

test("the follow-up pass matches on the customer's own words", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Talk to our team" });
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", {
      accountId: ids.accountId,
      conversationId: ids.conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "hi, I need a dubai visa",
      status: "delivered",
    });
  });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });

  expect(await tagsOf(t, ids.contactId)).toEqual([
    { source: "ad", name: "UAE Visa" },
  ]);
});

test("the follow-up pass ignores customer text from BEFORE the referral — a returning customer's stale history must not steal a new ad's tag (Fix 1, review pass 2026-07-30)", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("kbServices", {
      accountId: ids.accountId,
      key: "flight-booking",
      name: "Flight Booking",
      aliases: ["flights"],
      status: "active",
      sortOrder: 1,
      updatedAt: Date.now(),
    });
  });

  // March: an old message in this SAME conversation, from a completely
  // unrelated earlier visit, naming service A (UAE Visa).
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", {
      accountId: ids.accountId,
      conversationId: ids.conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "hi, need a dubai visa",
      status: "delivered",
    });
  });

  // July: the ad click itself. Seeded as a real `messages` row with a
  // `messageId`, and the referral below carries that same id as its
  // `waMessageId` — this is what makes `referralAnchorTime` resolve to
  // the click message's own `_creationTime` instead of falling back to
  // `referral._creationTime`, so this test actually exercises the anchor
  // path (the one production always takes — `ingest.ts:295` writes
  // `messageId: message.wamid`, matching `adReferrals.waMessageId`) and
  // not just the fallback. The text is deliberately the generic
  // pre-filled greeting a WhatsApp click-to-WhatsApp ad sends — inert,
  // naming no service — so this test keeps isolating exclusion-of-stale-
  // history, not click-message-text-inclusion (that's the next test's job).
  const clickMessageId = "wamid.click-stale-history-test";
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", {
      accountId: ids.accountId,
      conversationId: ids.conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "Hi, interested in your offer",
      status: "delivered",
      messageId: clickMessageId,
    });
  });

  // The same contact clicks a vague "Talk to our team" ad — the referral
  // row is created strictly after the click message above (and the March
  // message before that), and is pinned to the click message via
  // `waMessageId` so the anchor resolves to it.
  await seedReferral(t, ids, {
    headline: "Talk to our team",
    waMessageId: clickMessageId,
  });

  // Their next message — the real follow-up to THIS ad — names service B
  // (Flight Booking) instead.
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", {
      accountId: ids.accountId,
      conversationId: ids.conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "actually I want flights please",
      status: "delivered",
    });
  });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });

  // Must be tagged Flight Booking (from the July follow-up) or nothing —
  // NEVER UAE Visa, which is what the March message would produce if the
  // follow-up pass read the conversation's first-ever customer messages
  // instead of bounding to messages since this referral's own click.
  const tags = await tagsOf(t, ids.contactId);
  expect(tags.map((tg) => tg.name)).not.toContain("UAE Visa");
  expect(tags).toEqual([{ source: "ad", name: "Flight Booking" }]);
});

test("the click message's own text is used on the follow-up pass, not just later messages (Fix, review pass 2026-07-31)", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);

  // The click message must be seeded BEFORE the referral row — convex-test
  // assigns strictly increasing `_creationTime`, and that ordering is also
  // what actually happens in production: `ingest.ts` inserts the inbound
  // message (line 295) before `recordAdReferral` (line 1031) creates the
  // referral row that references it by `waMessageId`.
  const clickMessageId = "wamid.click-1";
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", {
      accountId: ids.accountId,
      conversationId: ids.conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "hi, I need a dubai visa",
      status: "delivered",
      messageId: clickMessageId,
    });
  });
  await t.run(async (ctx) =>
    ctx.db.insert("adReferrals", {
      accountId: ids.accountId,
      contactId: ids.contactId,
      conversationId: ids.conversationId,
      waMessageId: clickMessageId,
      // Vague ad text on purpose: the referral pass must NOT match off the
      // ad itself. If this test passes, it can only be because the
      // follow-up pass's `customerMessagesSince` bound included the click
      // message above.
      headline: "Talk to our team",
      sourceType: "ad",
      isFirstTouch: true,
    }),
  );

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  expect(await tagsOf(t, ids.contactId)).toHaveLength(0); // referral pass: no match yet

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });

  expect(await tagsOf(t, ids.contactId)).toEqual([
    { source: "ad", name: "UAE Visa" },
  ]);
});

test("attempts are capped at two", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Talk to our team" });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });

  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchAttempts).toBe(2);
});

test("a resolved campaign ad name outranks the referral body", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("campaignAds", {
      accountId: ids.accountId,
      adId: "ad-1",
      adName: "UAE Visa — retarget",
      resolveStatus: "resolved",
      attempts: 1,
    });
    await ctx.db.insert("adReferrals", {
      accountId: ids.accountId,
      contactId: ids.contactId,
      conversationId: ids.conversationId,
      waMessageId: "wamid.ad1",
      adId: "ad-1",
      sourceType: "ad",
      body: "nothing useful here",
      isFirstTouch: true,
    });
  });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_contact", (q) => q.eq("contactId", ids.contactId))
      .first(),
  );
  expect(row?.serviceMatchedOn).toBe("adName");
});

test("a referral row stamped with another account's id is never matched, even for the same contact", async () => {
  const t = convexTest(schema, modules);
  const mine = await seed(t);
  const theirs = await seed(t);
  // Keyed to MY contact/conversation but stamped with THEIR accountId —
  // the shape a cross-tenant bug would produce. The `by_contact` index
  // lookup in `referralFor` is scoped only to `contactId`, so it WOULD
  // return this row regardless of account; only the accountId equality
  // filter that runs after the index lookup keeps it from being read as
  // mine. Without that filter this row has everything needed to match
  // "UAE Visa" and get tagged.
  await t.run(async (ctx) => {
    await ctx.db.insert("adReferrals", {
      accountId: theirs.accountId,
      contactId: mine.contactId,
      conversationId: mine.conversationId,
      waMessageId: "wamid.cross-tenant",
      sourceType: "ad",
      headline: "Apply for your UAE Visa today",
      isFirstTouch: true,
    });
  });

  await t.mutation(internal.adServiceTagging.tagFromAd, {
    accountId: mine.accountId,
    contactId: mine.contactId,
    conversationId: mine.conversationId,
    trigger: "referral",
  });

  expect(await tagsOf(t, mine.contactId)).toHaveLength(0);
});

test("a conversationId belonging to another account is rejected before the referral lookup (Fix 2, defense-in-depth)", async () => {
  const t = convexTest(schema, modules);
  const mine = await seed(t);
  const theirs = await seed(t);
  // A legitimate referral for MY conversation — would match if the call
  // below were allowed through.
  await seedReferral(t, mine, { headline: "Apply for your UAE Visa today" });

  // Called with THEIR accountId but MY conversationId/contactId — the
  // explicit `conversation.accountId === args.accountId` guard must
  // reject this before `referralFor` (or the messages index) is ever
  // touched.
  await t.mutation(internal.adServiceTagging.tagFromAd, {
    accountId: theirs.accountId,
    contactId: mine.contactId,
    conversationId: mine.conversationId,
    trigger: "referral",
  });

  expect(await tagsOf(t, mine.contactId)).toHaveLength(0);
});

test("no referral row at all is a quiet no-op", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });

  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
});

test("two failed rule passes hand off to the AI fallback", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Talk to our team" });
  await t.run((ctx) =>
    ctx.db.insert("tags", { accountId: ids.accountId, name: "UAE Visa", color: "#0ea5e9" }),
  );
  await seedAiConfig(t, ids.accountId);

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const suggestion = await t.run(async (ctx) =>
    ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", ids.conversationId))
      .first(),
  );
  expect(suggestion?.status).toBe("pending");
  // The core invariant the spec cares about most: a "suggested" state is
  // a PENDING recommendation for a human to accept, never an applied tag.
  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);

  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("suggested");
});

test("the AI fallback stays quiet when AI is not configured", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Talk to our team" });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const suggestion = await t.run(async (ctx) =>
    ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", ids.conversationId))
      .first(),
  );
  expect(suggestion).toBeNull();
});

test("a suggested referral is never re-classified", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Talk to our team" });
  await t.run((ctx) =>
    ctx.db.insert("tags", { accountId: ids.accountId, name: "UAE Visa", color: "#0ea5e9" }),
  );
  await seedAiConfig(t, ids.accountId);

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const suggestions = await t.run(async (ctx) =>
    ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", ids.conversationId))
      .collect(),
  );
  expect(suggestions).toHaveLength(1);
});

test("a second ad click landing before the fallback runs does not steal referral A's budget", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralAId = await seedReferral(t, ids, { headline: "Talk to our team" });
  await t.run((ctx) =>
    ctx.db.insert("tags", { accountId: ids.accountId, name: "UAE Visa", color: "#0ea5e9" }),
  );
  await seedAiConfig(t, ids.accountId);

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  // Referral A's fallback is now scheduled but hasn't executed yet — a
  // second ad click lands in the SAME conversation before it does. If
  // `markSuggested`/`classifyContext` re-resolved "the conversation's
  // latest referral" instead of using the `referralId` `tagFromAd`
  // threaded through at schedule time, this newer row (B) would be the
  // one stamped `suggested`, burning its own two rule passes without
  // ever being evaluated, while A — the row that actually paid for the
  // call — would stay stuck `unmatched` forever.
  const referralBId = await seedReferral(t, ids, { headline: "Check out our flights" });

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const rowA = await t.run(async (ctx) => ctx.db.get(referralAId));
  const rowB = await t.run(async (ctx) => ctx.db.get(referralBId));
  expect(rowA?.serviceMatchStatus).toBe("suggested");
  expect(rowB?.serviceMatchStatus).toBeUndefined();
});

test("a pre-existing pending suggestion stops the fallback from recording a second one", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Talk to our team" });
  const tagId = await t.run((ctx) =>
    ctx.db.insert("tags", { accountId: ids.accountId, name: "UAE Visa", color: "#0ea5e9" }),
  );
  await seedAiConfig(t, ids.accountId);
  // An agent already clicked "Suggest tags" on this conversation (or a
  // different ad's fallback landed first) before this referral's own two
  // rule passes finish failing. Without the `existingPending` guard,
  // `classifyAdService` would insert a SECOND pending row here — orphaning
  // one of the two, since `pendingForConversation`/`existingPending` both
  // return only a single row.
  await t.run((ctx) =>
    ctx.db.insert("tagSuggestions", {
      accountId: ids.accountId,
      conversationId: ids.conversationId,
      contactId: ids.contactId,
      suggestedTagIds: [tagId],
      confidence: "high",
      status: "pending",
      model: "m",
    }),
  );

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const suggestions = await t.run(async (ctx) =>
    ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", ids.conversationId))
      .collect(),
  );
  expect(suggestions).toHaveLength(1);

  // The budget is still spent even though the insert was skipped — the
  // referral must not be left in a state that invites a retry.
  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("suggested");
});
