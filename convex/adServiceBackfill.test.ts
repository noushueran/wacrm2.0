import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

// Seed helpers copied from `convex/adServiceTagging.test.ts` — same
// fixture traps apply here (no `timestamp` on `messages`, `adReferrals`
// requires `waMessageId`/`isFirstTouch`, `conversations` requires
// `unreadCount`).
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
    adId?: string;
    waMessageId?: string;
    serviceMatchStatus?: "matched" | "unmatched" | "ambiguous" | "suggested";
    serviceMatchAttempts?: number;
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

test("dryRun defaults to true when the flag is omitted — no writes, but the same counts", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });

  const result = await t.mutation(internal.adServiceBackfill.backfillAdTags, {});

  expect(result.tagged).toBe(1);
  expect(result.byService).toEqual({ "UAE Visa": 1 });
  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
  // Not just "no link" — the `tags` table itself must be untouched too.
  // A regression that created the tag row but skipped the `contactTags`
  // link would pass a `contactTags`-only assertion.
  const allTags = await t.run((ctx) =>
    ctx.db
      .query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", ids.accountId))
      .collect(),
  );
  expect(allTags).toHaveLength(0);
  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBeUndefined();
});

test("dryRun: false actually tags the contact with source 'ad'", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });

  const result = await t.mutation(internal.adServiceBackfill.backfillAdTags, {
    dryRun: false,
  });

  expect(result.tagged).toBe(1);
  expect(result.byService).toEqual({ "UAE Visa": 1 });
  expect(await tagsOf(t, ids.contactId)).toEqual([{ source: "ad", name: "UAE Visa" }]);
  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("matched");
  expect(row?.serviceMatchKey).toBe("uae-visa");
});

test("a dry run reports the same counts a real run would produce", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });

  const dry = await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: true });
  const real = await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });

  expect(dry.scanned).toBe(real.scanned);
  expect(dry.tagged).toBe(real.tagged);
  expect(dry.unmatched).toBe(real.unmatched);
  expect(dry.ambiguous).toBe(real.ambiguous);
  expect(dry.skipped).toBe(real.skipped);
  expect(dry.byService).toEqual(real.byService);
});

test("re-running is additive: an already-matched referral is skipped, no duplicate contactTags", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });

  await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });
  const second = await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });

  expect(second.tagged).toBe(0);
  expect(second.skipped).toBe(1);
  expect(second.byService).toEqual({});
  expect(await tagsOf(t, ids.contactId)).toHaveLength(1);
});

test("a miss records unmatched and leaves serviceMatchAttempts untouched", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Talk to our team" });

  const result = await t.mutation(internal.adServiceBackfill.backfillAdTags, {
    dryRun: false,
  });

  expect(result.unmatched).toBe(1);
  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("unmatched");
  expect(row?.serviceMatchAttempts).toBeUndefined();
});

test("two services matching records ambiguous and tags nothing", async () => {
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

  const result = await t.mutation(internal.adServiceBackfill.backfillAdTags, {
    dryRun: false,
  });

  expect(result.ambiguous).toBe(1);
  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("ambiguous");
  expect(row?.serviceMatchAttempts).toBeUndefined();
});

test("a contact already tagged for that service by qualification keeps source 'ai'", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });
  // Qualification already tagged this contact for the same service,
  // source "ai", before the backfill ever ran.
  await t.run(async (ctx) => {
    const tagId = await ctx.db.insert("tags", {
      accountId: ids.accountId,
      name: "UAE Visa",
      color: "#0ea5e9",
    });
    await ctx.db.insert("contactTags", {
      accountId: ids.accountId,
      contactId: ids.contactId,
      tagId,
      source: "ai",
    });
  });

  await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });

  expect(await tagsOf(t, ids.contactId)).toEqual([{ source: "ai", name: "UAE Visa" }]);
});

test("customer messages after the click contribute; messages before it do not", async () => {
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

  // Stale history, well before the click: names UAE Visa.
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

  // The click message itself, with a real messageId the referral's
  // waMessageId points at — this is what makes `referralAnchorTime`
  // resolve to the click message's own `_creationTime` rather than
  // silently falling back to `referral._creationTime` (see the module
  // docstring's fixture warning).
  const clickMessageId = "wamid.click-backfill-test";
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

  const referralId = await seedReferral(t, ids, {
    headline: "Talk to our team",
    waMessageId: clickMessageId,
  });

  // The real follow-up to this ad: names Flight Booking.
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

  await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });

  const tags = await tagsOf(t, ids.contactId);
  expect(tags.map((tg) => tg.name)).not.toContain("UAE Visa");
  expect(tags).toEqual([{ source: "ad", name: "Flight Booking" }]);
  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("matched");
});

test("two accounts never cross: A's referral cannot match a service only B has", async () => {
  // NOTE (review pass, 2026-07-31): an earlier version of this test gave
  // both accounts a service with the SAME key/name ("UAE Visa" /
  // "uae-visa" from `seed()`). That is vacuous — `matchService`'s `hits`
  // map is keyed by candidate KEY, so even a catalogue read that ignored
  // `accountId` entirely and merged both accounts' rows would still see
  // only ONE candidate keyed "uae-visa" and produce the exact same
  // `hits.size === 1` match. Every assertion in that version would still
  // pass under a table-wide (unscoped) read. This version gives account B
  // a service account A does NOT have at all, so a leak is the only way
  // account A's referral could match it.
  const t = convexTest(schema, modules);
  const mine = await seed(t); // has "UAE Visa" only
  const theirs = await seed(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("kbServices", {
      accountId: theirs.accountId,
      key: "yacht-charter",
      name: "Yacht Charter",
      aliases: [],
      status: "active",
      sortOrder: 0,
      updatedAt: Date.now(),
    });
  });
  // MY referral names THEIR service by its exact name — the only way this
  // could match is if the `kbServices` lookup for MY account read across
  // account boundaries.
  const referralId = await seedReferral(t, mine, { headline: "Book your Yacht Charter today" });

  await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });

  expect(await tagsOf(t, mine.contactId)).toHaveLength(0);
  const myTags = await t.run((ctx) =>
    ctx.db
      .query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", mine.accountId))
      .collect(),
  );
  expect(myTags).toHaveLength(0);
  const row = await t.run((ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("unmatched");
});

test("byService counts what was actually matched", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });
  await seedReferral(t, ids, { headline: "Talk to our team" }); // unmatched
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
  await seedReferral(t, ids, { headline: "UAE Visa and Flight Booking combo" }); // ambiguous

  const result = await t.mutation(internal.adServiceBackfill.backfillAdTags, {
    dryRun: false,
  });

  expect(result.scanned).toBe(3);
  expect(result.tagged).toBe(1);
  expect(result.unmatched).toBe(1);
  expect(result.ambiguous).toBe(1);
  expect(result.byService).toEqual({ "UAE Visa": 1 });
});

test("a resolved campaignAds name is used as a signal when present", async () => {
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
  });
  const referralId = await seedReferral(t, ids, {
    adId: "ad-1",
    body: "nothing useful here",
  });

  await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });

  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchedOn).toBe("adName");
});

test("removeBackfilledTags deletes only source 'ad' rows, and honours dryRun", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const tagId = await t.run(async (ctx) =>
    ctx.db.insert("tags", { accountId: ids.accountId, name: "UAE Visa", color: "#0ea5e9" }),
  );
  const adTagId = await t.run(async (ctx) =>
    ctx.db.insert("contactTags", {
      accountId: ids.accountId,
      contactId: ids.contactId,
      tagId,
      source: "ad",
    }),
  );
  const otherContactId = await t.run(async (ctx) =>
    ctx.db.insert("contacts", {
      accountId: ids.accountId,
      phone: "+15551239999",
      phoneNormalized: "15551239999",
    }),
  );
  const manualTagId = await t.run(async (ctx) =>
    ctx.db.insert("contactTags", {
      accountId: ids.accountId,
      contactId: otherContactId,
      tagId,
      source: "manual",
    }),
  );

  const dry = await t.mutation(internal.adServiceBackfill.removeBackfilledTags, {
    dryRun: true,
  });
  expect(dry.deleted).toBe(1);
  expect(await t.run((ctx) => ctx.db.get(adTagId))).not.toBeNull();
  expect(await t.run((ctx) => ctx.db.get(manualTagId))).not.toBeNull();

  const real = await t.mutation(internal.adServiceBackfill.removeBackfilledTags, {
    dryRun: false,
  });
  expect(real.deleted).toBe(1);
  expect(await t.run((ctx) => ctx.db.get(adTagId))).toBeNull();
  expect(await t.run((ctx) => ctx.db.get(manualTagId))).not.toBeNull();
});

test("a suggested referral (pending human review) is never re-evaluated", async () => {
  // Review pass, 2026-07-31: the live path's OTHER terminal state
  // (`markSuggested`'s own docstring calls it terminal) — a referral that
  // exhausted both rule passes, went to AI, and has a pending suggestion
  // sitting in an agent's banner. The backfill must not silently overwrite
  // that pending-for-a-human marker.
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, {
    headline: "Apply for your UAE Visa today",
    serviceMatchStatus: "suggested",
  });

  const result = await t.mutation(internal.adServiceBackfill.backfillAdTags, {
    dryRun: false,
  });

  expect(result.tagged).toBe(0);
  expect(result.skipped).toBe(1);
  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
  const row = await t.run((ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("suggested");
});

test("run -> undo -> re-run is a full cycle: the undo clears serviceMatchStatus so the referral is eligible again", async () => {
  // Review pass, 2026-07-31 (spec defect, not an implementation bug — see
  // the report): without this reset, `removeBackfilledTags` deletes the
  // tag but leaves the referral `serviceMatchStatus: "matched"`, so a
  // re-run's `matched`-skip (:167) would permanently strand that contact
  // with no tag and no way for the repo to fix it. This test is the
  // regression guard for that cycle.
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });

  await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });
  expect(await tagsOf(t, ids.contactId)).toEqual([{ source: "ad", name: "UAE Visa" }]);
  const afterRun = await t.run((ctx) => ctx.db.get(referralId));
  expect(afterRun?.serviceMatchStatus).toBe("matched");

  await t.mutation(internal.adServiceBackfill.removeBackfilledTags, { dryRun: false });
  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
  const afterUndo = await t.run((ctx) => ctx.db.get(referralId));
  expect(afterUndo?.serviceMatchStatus).toBeUndefined();
  expect(afterUndo?.serviceMatchKey).toBeUndefined();
  expect(afterUndo?.serviceMatchedOn).toBeUndefined();

  const rerun = await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });
  expect(rerun.tagged).toBe(1);
  expect(await tagsOf(t, ids.contactId)).toEqual([{ source: "ad", name: "UAE Visa" }]);
});

test("documented gap: renaming the service between run and undo leaves the referral matched with its tag already gone (fail-safe, not silently wrong)", async () => {
  // Re-review, 2026-07-31 (Minor 1): `clearMatchedReferrals` bridges
  // `tags.name` back to `kbServices.name`/`key` by NAME, because
  // `contactTags` carries no id-level link to the referral or service that
  // produced it. If the `kbServices` row is renamed after the backfill
  // ran, that bridge can no longer find it, `keys` comes back empty, and
  // the function clears nothing for this referral — even though the
  // `contactTags` row is deleted regardless. This is the accepted,
  // documented gap (see the function's own "KNOWN GAP" comment): the
  // failure direction is fail-safe (no wrong write), but the referral is
  // left stranded `matched` with no tag. This test pins that exact,
  // disclosed behaviour so a future change can't silently make it worse
  // (e.g. start throwing) without the test noticing.
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });

  await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });
  expect(await tagsOf(t, ids.contactId)).toEqual([{ source: "ad", name: "UAE Visa" }]);

  // The service is renamed after the run — the tag it produced still says
  // "UAE Visa" (tags are a snapshot at creation time), but `kbServices`
  // no longer has a row by that name.
  await t.run(async (ctx) => {
    const service = await ctx.db
      .query("kbServices")
      .withIndex("by_account_key", (q) => q.eq("accountId", ids.accountId).eq("key", "uae-visa"))
      .first();
    await ctx.db.patch(service!._id, { name: "UAE Visa Services Renamed" });
  });

  await t.mutation(internal.adServiceBackfill.removeBackfilledTags, { dryRun: false });

  // The tag itself is still removed — deletion does not depend on the
  // name bridge resolving.
  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
  // But the referral is stranded `matched`, exactly as documented.
  const row = await t.run((ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("matched");
  expect(row?.serviceMatchKey).toBe("uae-visa");
});

test("removeBackfilledTags does not reset a referral whose deletion did not happen (dryRun)", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });
  await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });

  await t.mutation(internal.adServiceBackfill.removeBackfilledTags, { dryRun: true });

  const row = await t.run((ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("matched"); // untouched — nothing was actually deleted
  expect(await tagsOf(t, ids.contactId)).toHaveLength(1);
});

test("removeBackfilledTags can be scoped to one account's rows via accountId", async () => {
  const t = convexTest(schema, modules);
  const mine = await seed(t);
  const theirs = await seed(t);
  await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false }); // no referrals yet, no-op
  await seedReferral(t, mine, { headline: "Apply for your UAE Visa today" });
  await seedReferral(t, theirs, { headline: "Apply for your UAE Visa today" });
  await t.mutation(internal.adServiceBackfill.backfillAdTags, { dryRun: false });
  expect(await tagsOf(t, mine.contactId)).toHaveLength(1);
  expect(await tagsOf(t, theirs.contactId)).toHaveLength(1);

  const result = await t.mutation(internal.adServiceBackfill.removeBackfilledTags, {
    dryRun: false,
    accountId: mine.accountId,
  });

  expect(result.deleted).toBe(1);
  expect(await tagsOf(t, mine.contactId)).toHaveLength(0);
  expect(await tagsOf(t, theirs.contactId)).toHaveLength(1); // untouched
});

test("a referral whose conversationId belongs to another account is skipped, not read for customerText (defense-in-depth)", async () => {
  const t = convexTest(schema, modules);
  const mine = await seed(t);
  const theirs = await seed(t);
  // A data-integrity anomaly, not a normal path: a referral stamped with
  // MY accountId but pointing at THEIR conversationId. If the guard were
  // missing, `customerMessagesSince`/`referralAnchorTime` would read
  // messages under an account this referral does not belong to — those
  // indexes are not themselves account-scoped.
  const referralId = await t.run((ctx) =>
    ctx.db.insert("adReferrals", {
      accountId: mine.accountId,
      contactId: mine.contactId,
      conversationId: theirs.conversationId,
      waMessageId: "wamid.cross-tenant-conversation",
      sourceType: "ad",
      headline: "Talk to our team", // vague on purpose: only a leaked
      // customerText signal from THEIR conversation could produce a match
      isFirstTouch: true,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId: theirs.accountId,
      conversationId: theirs.conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "I need a UAE visa",
      status: "delivered",
    }),
  );

  const result = await t.mutation(internal.adServiceBackfill.backfillAdTags, {
    dryRun: false,
  });

  expect(result.skipped).toBe(1);
  expect(result.tagged).toBe(0);
  expect(await tagsOf(t, mine.contactId)).toHaveLength(0);
  const row = await t.run((ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBeUndefined(); // never evaluated, not even marked unmatched
});
