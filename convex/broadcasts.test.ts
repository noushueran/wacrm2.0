/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import {
  colsForStatus,
  isValidStatusTransition,
  needsCustomValues,
  resolveBroadcastParams,
} from "./broadcasts";

// Belt-and-suspenders cleanup for the delivery (`send`/`deliverOne`)
// tests further below, which opt into `vi.useFakeTimers()` +
// `CONVEX_META_DRY_RUN` — mirrors `automationsEngine.test.ts`'s own
// file-level `afterEach`, so a thrown assertion mid-test can never leak
// either into a later test in this file.
afterEach(() => {
  vi.useRealTimers();
  delete process.env.CONVEX_META_DRY_RUN;
});

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches
// `convex/contacts.test.ts`/`convex/deals.test.ts` — see that file's
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated from `convex/contacts.test.ts` rather than
 * imported — each `convex/*.test.ts` suite owns its own copy of this
 * helper (see that file's own comment on why).
 */
async function seedAccountMember(
  t: ReturnType<typeof convexTest>,
  opts: { name: string; email: string; role: AccountRole },
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: opts.name, email: opts.email }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: `${opts.name}'s account`,
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  const asUser = t.withIdentity({
    subject: `${userId}|session-${opts.name}`,
  });
  return { userId, accountId, asUser };
}

// Guarantees a fresh, never-repeated phone across the whole test file
// (module-level counter), so `seedContacts` can be called any number of
// times — even more than once for the same account — without ever
// tripping `contacts.create`'s per-account `DUPLICATE_PHONE` dedup.
let phoneCounter = 0;

/** Creates `count` contacts owned by `asUser`'s account and returns their ids. */
async function seedContacts(
  asUser: Awaited<ReturnType<typeof seedAccountMember>>["asUser"],
  count: number,
): Promise<Id<"contacts">[]> {
  const ids: Id<"contacts">[] = [];
  for (let i = 0; i < count; i++) {
    phoneCounter += 1;
    const id = await asUser.mutation(api.contacts.create, {
      phone: `+1555${String(phoneCounter).padStart(7, "0")}`,
      name: `Contact ${phoneCounter}`,
    });
    ids.push(id);
  }
  return ids;
}

/**
 * Reads back a broadcast's recipients through the real `listRecipients`
 * query — not a raw `t.run` index query. A helper parameter typed as
 * the bare `t: ReturnType<typeof convexTest>` (no schema type argument)
 * can't resolve custom index names inside a `ctx.db.query(...)
 * .withIndex(...)` call (only the built-in `by_creation_time`/`by_id`),
 * the exact gotcha `convex/deals.test.ts`'s own `seedPipelineWithStages`
 * comment documents — going through `api.broadcasts.listRecipients`
 * sidesteps it entirely, the same fix that file uses. Requires the
 * broadcast to still exist (ownership-gated); a post-`remove` check
 * needs a raw index query written inline in the test body instead (see
 * the "remove cascades" test).
 */
async function recipientsOf(
  asUser: Awaited<ReturnType<typeof seedAccountMember>>["asUser"],
  broadcastId: Id<"broadcasts">,
) {
  const result = await asUser.query(api.broadcasts.listRecipients, {
    broadcastId,
    paginationOpts: { numItems: 100, cursor: null },
  });
  return result.page;
}

const baseBroadcast = {
  name: "Spring Sale",
  templateName: "spring_sale",
  templateLanguage: "en_US",
};

const onePage = { paginationOpts: { numItems: 50, cursor: null } };

// ============================================================
// colsForStatus — pure function, direct unit test (mirrors
// convex/lib/roles.test.ts's treatment of roleRank/hasMinRole)
// ============================================================

test("colsForStatus implements the migration-005 count model", () => {
  expect(colsForStatus("pending")).toEqual([]);
  expect(colsForStatus("sent")).toEqual(["sentCount"]);
  expect(colsForStatus("delivered")).toEqual(["sentCount", "deliveredCount"]);
  expect(colsForStatus("read")).toEqual([
    "sentCount",
    "deliveredCount",
    "readCount",
  ]);
  expect(colsForStatus("replied")).toEqual([
    "sentCount",
    "deliveredCount",
    "readCount",
    "repliedCount",
  ]);
  expect(colsForStatus("failed")).toEqual(["failedCount"]);
});

// ============================================================
// create
// ============================================================

test("create seeds one broadcastRecipients row per contact, all counts zeroed, status defaulting to 'sending'", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 3);

  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast).not.toBeNull();
  expect(broadcast!.accountId).toBe(accountId);
  expect(broadcast!.createdByUserId).toBe(userId);
  expect(broadcast!.name).toBe("Spring Sale");
  expect(broadcast!.templateName).toBe("spring_sale");
  expect(broadcast!.templateLanguage).toBe("en_US");
  expect(broadcast!.status).toBe("sending");
  expect(broadcast!.totalRecipients).toBe(3);
  expect(broadcast!.sentCount).toBe(0);
  expect(broadcast!.deliveredCount).toBe(0);
  expect(broadcast!.readCount).toBe(0);
  expect(broadcast!.repliedCount).toBe(0);
  expect(broadcast!.failedCount).toBe(0);

  const recipients = await recipientsOf(asUser, broadcastId);
  expect(recipients).toHaveLength(3);
  for (const recipient of recipients) {
    expect(recipient.status).toBe("pending");
    expect(recipient.accountId).toBe(accountId);
    expect(contactIds).toContain(recipient.contactId);
  }
});

test("create accepts an explicit status, templateVariables, and audienceFilter", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 1);

  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
    status: "draft",
    templateVariables: { "1": "Alice" },
    audienceFilter: { tagIds: [] },
  });

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.status).toBe("draft");
  expect(broadcast!.templateVariables).toEqual({ "1": "Alice" });
  expect(broadcast!.audienceFilter).toEqual({ tagIds: [] });
});

test("create throws NOT_FOUND when Bob supplies Alice's contactId, and creates nothing — Bob can still create with his own contacts", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const aliceContactIds = await seedContacts(asAlice, 1);
  const bobContactIds = await seedContacts(asBob, 1);

  await expect(
    asBob.mutation(api.broadcasts.create, {
      ...baseBroadcast,
      contactIds: [...bobContactIds, ...aliceContactIds],
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  expect(
    await t.run((ctx) => ctx.db.query("broadcasts").collect()),
  ).toHaveLength(0);
  expect(
    await t.run((ctx) => ctx.db.query("broadcastRecipients").collect()),
  ).toHaveLength(0);

  // Positive control — Bob's own contacts work fine.
  const { broadcastId } = await asBob.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds: bobContactIds,
  });
  expect(await t.run((ctx) => ctx.db.get(broadcastId))).not.toBeNull();
});

test("create throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asUser.mutation(api.broadcasts.create, {
      ...baseBroadcast,
      contactIds: [],
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });

  expect(
    await t.run((ctx) => ctx.db.query("broadcasts").collect()),
  ).toHaveLength(0);
});

// ============================================================
// create — Gate 4: drop do-not-contact recipients, don't reject
// ============================================================

test("create drops do-not-contact contacts and reports how many", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const keep = await asUser.mutation(api.contacts.create, { phone: "1" });
  const drop = await asUser.mutation(api.contacts.create, { phone: "2" });

  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId: drop,
      noteText: "Asked us to stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(drop, { doNotContact: { at: Date.now(), noteId } });
  });

  const result = await asUser.mutation(api.broadcasts.create, {
    name: "August offer",
    templateName: "promo",
    templateLanguage: "en",
    contactIds: [keep, drop],
  });

  expect(result.skipped).toBe(1);

  const recipients = await t.run((ctx) =>
    ctx.db
      .query("broadcastRecipients")
      .withIndex("by_broadcast", (q) => q.eq("broadcastId", result.broadcastId))
      .collect(),
  );
  expect(recipients.map((r) => r.contactId)).toEqual([keep]);

  const broadcast = await t.run((ctx) => ctx.db.get(result.broadcastId));
  // The count must reflect who will ACTUALLY be messaged, or every
  // progress percentage downstream is wrong.
  expect(broadcast!.totalRecipients).toBe(1);
});

test("create still rejects a foreign contactId outright", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const bob = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const mine = await alice.asUser.mutation(api.contacts.create, { phone: "1" });
  const theirs = await bob.asUser.mutation(api.contacts.create, { phone: "2" });

  // Dropping is for a customer who opted out. A cross-tenant id is an
  // error, and must stay one.
  await expect(
    alice.asUser.mutation(api.broadcasts.create, {
      name: "x",
      templateName: "promo",
      templateLanguage: "en",
      contactIds: [mine, theirs],
    }),
  ).rejects.toThrow(/NOT_FOUND/);
});

test("a broadcast to only do-not-contact contacts creates nothing sendable", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const drop = await asUser.mutation(api.contacts.create, { phone: "1" });
  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId: drop,
      noteText: "Stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(drop, { doNotContact: { at: Date.now(), noteId } });
  });

  const result = await asUser.mutation(api.broadcasts.create, {
    name: "x",
    templateName: "promo",
    templateLanguage: "en",
    contactIds: [drop],
  });
  expect(result.skipped).toBe(1);
  const broadcast = await t.run((ctx) => ctx.db.get(result.broadcastId));
  expect(broadcast!.totalRecipients).toBe(0);
});

test("createInternal's sendable/skipped partition accounts for every contactId, and its returned totalRecipients matches sendable.length exactly", async () => {
  // Guards the invariant `apiV1.ts`'s `createBroadcast` now relies on:
  // it reports `createInternal`'s `totalRecipients` back to the public
  // API caller VERBATIM rather than re-deriving it. That's only safe
  // because this loop is a strict partition — every id lands in exactly
  // one of `sendable`/`skipped`. If a future second filter here (a
  // suppression list, a per-broadcast dedupe, a rate cap) shrinks
  // `sendable` without incrementing `skipped`, this test fails loudly
  // at the source instead of the two counts silently drifting apart at
  // the public API edge.
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const keep1 = await asUser.mutation(api.contacts.create, { phone: "1" });
  const drop = await asUser.mutation(api.contacts.create, { phone: "2" });
  const keep2 = await asUser.mutation(api.contacts.create, { phone: "3" });
  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId: drop,
      noteText: "Stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(drop, { doNotContact: { at: Date.now(), noteId } });
  });

  const contactIds = [keep1, drop, keep2];
  const result = await t.mutation(internal.broadcasts.createInternal, {
    accountId,
    name: "x",
    templateName: "promo",
    templateLanguage: "en",
    contactIds,
  });

  // The partition itself: every id is accounted for exactly once.
  expect(result.totalRecipients + result.skipped).toBe(contactIds.length);

  // The returned count matches what was actually persisted — not just
  // arithmetically, but the SAME value read back from the row.
  const broadcast = await t.run((ctx) => ctx.db.get(result.broadcastId));
  expect(broadcast!.totalRecipients).toBe(result.totalRecipients);
  expect(result.totalRecipients).toBe(2);
  expect(result.skipped).toBe(1);
});

// ============================================================
// setRecipientStatus — count aggregation (the payoff of this task)
// ============================================================

test("setRecipientStatus advances counts one column at a time through pending -> sent -> delivered -> read -> replied", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 1);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });
  const [recipient] = await recipientsOf(asUser, broadcastId);

  const before = Date.now();

  // pending -> sent: only sentCount moves.
  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipient!._id,
    status: "sent",
    whatsappMessageId: "wamid.100",
  });
  let broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.sentCount).toBe(1);
  expect(broadcast!.deliveredCount).toBe(0);
  expect(broadcast!.readCount).toBe(0);
  expect(broadcast!.repliedCount).toBe(0);
  let recipientRow = await t.run((ctx) => ctx.db.get(recipient!._id));
  expect(recipientRow!.status).toBe("sent");
  expect(recipientRow!.whatsappMessageId).toBe("wamid.100");
  expect(recipientRow!.sentAt).toBeGreaterThanOrEqual(before);

  // sent -> delivered: sentCount stays, deliveredCount moves.
  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipient!._id,
    status: "delivered",
  });
  broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.sentCount).toBe(1);
  expect(broadcast!.deliveredCount).toBe(1);
  expect(broadcast!.readCount).toBe(0);
  recipientRow = await t.run((ctx) => ctx.db.get(recipient!._id));
  expect(recipientRow!.deliveredAt).toBeGreaterThanOrEqual(before);

  // delivered -> read.
  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipient!._id,
    status: "read",
  });
  broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.sentCount).toBe(1);
  expect(broadcast!.deliveredCount).toBe(1);
  expect(broadcast!.readCount).toBe(1);
  expect(broadcast!.repliedCount).toBe(0);

  // read -> replied: full sequence yields sent=delivered=read=replied=1.
  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipient!._id,
    status: "replied",
  });
  broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.sentCount).toBe(1);
  expect(broadcast!.deliveredCount).toBe(1);
  expect(broadcast!.readCount).toBe(1);
  expect(broadcast!.repliedCount).toBe(1);
  expect(broadcast!.failedCount).toBe(0);
  recipientRow = await t.run((ctx) => ctx.db.get(recipient!._id));
  expect(recipientRow!.status).toBe("replied");
  expect(recipientRow!.repliedAt).toBeGreaterThanOrEqual(before);
});

test("setRecipientStatus on a separate recipient -> failed bumps only failedCount and stores errorMessage", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 2);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });
  const recipients = await recipientsOf(asUser, broadcastId);

  // First recipient progresses normally...
  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipients[0]!._id,
    status: "sent",
  });
  // ...second recipient fails outright, never having been "sent".
  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipients[1]!._id,
    status: "failed",
    errorMessage: "Recipient not allowed",
  });

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.sentCount).toBe(1);
  expect(broadcast!.deliveredCount).toBe(0);
  expect(broadcast!.readCount).toBe(0);
  expect(broadcast!.repliedCount).toBe(0);
  expect(broadcast!.failedCount).toBe(1);

  const failedRow = await t.run((ctx) => ctx.db.get(recipients[1]!._id));
  expect(failedRow!.status).toBe("failed");
  expect(failedRow!.errorMessage).toBe("Recipient not allowed");
});

test("setRecipientStatus is a total no-op when the status is unchanged — counts and the row's other fields stay untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 1);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });
  const [recipient] = await recipientsOf(asUser, broadcastId);

  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipient!._id,
    status: "sent",
    whatsappMessageId: "wamid.1",
  });
  const before = await t.run((ctx) => ctx.db.get(recipient!._id));

  // Same status again, with a DIFFERENT whatsappMessageId — the brief's
  // "if status === recipient.status, no-op" must skip the whole
  // operation, not just the count math, so this must not even update
  // whatsappMessageId.
  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipient!._id,
    status: "sent",
    whatsappMessageId: "wamid.DIFFERENT",
  });

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.sentCount).toBe(1); // unchanged, not double-counted

  const after = await t.run((ctx) => ctx.db.get(recipient!._id));
  expect(after).toEqual(before); // fully untouched, incl. whatsappMessageId
});

test("setRecipientStatus throws NOT_FOUND for a recipient belonging to a different account, and leaves it + the broadcast's counts untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const aliceContactIds = await seedContacts(asAlice, 1);
  const { broadcastId } = await asAlice.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds: aliceContactIds,
  });
  const [recipient] = await recipientsOf(asAlice, broadcastId);

  await expect(
    asBob.mutation(api.broadcasts.setRecipientStatus, {
      recipientId: recipient!._id,
      status: "sent",
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "broadcastRecipient" },
  });

  const row = await t.run((ctx) => ctx.db.get(recipient!._id));
  expect(row!.status).toBe("pending");
  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.sentCount).toBe(0);

  // Positive control.
  await asAlice.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipient!._id,
    status: "sent",
  });
  const rowAfter = await t.run((ctx) => ctx.db.get(recipient!._id));
  expect(rowAfter!.status).toBe("sent");
});

// ============================================================
// list / get / listRecipients — reads, ownership + scoping
// ============================================================

test("list never returns another account's broadcasts, newest first", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asAlice, 1);
  const { broadcastId: first } = await asAlice.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    name: "First",
    contactIds,
  });
  const { broadcastId: second } = await asAlice.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    name: "Second",
    contactIds,
  });

  expect(await asBob.query(api.broadcasts.list, {})).toHaveLength(0);

  const alicesView = await asAlice.query(api.broadcasts.list, {});
  expect(alicesView.map((b) => b._id)).toEqual([second, first]);
});

test("get throws NOT_FOUND for a broadcast belonging to a different account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asAlice, 1);
  const { broadcastId } = await asAlice.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });

  await expect(
    asBob.query(api.broadcasts.get, { broadcastId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "broadcast" } });

  // Positive control.
  const own = await asAlice.query(api.broadcasts.get, { broadcastId });
  expect(own._id).toBe(broadcastId);
});

test("listRecipients returns the broadcast's recipients, scoped to the caller's account", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 2);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });

  const result = await asUser.query(api.broadcasts.listRecipients, {
    broadcastId,
    ...onePage,
  });

  expect(result.page).toHaveLength(2);
  expect(new Set(result.page.map((r) => r.contactId))).toEqual(
    new Set(contactIds),
  );
});

test("listRecipients throws NOT_FOUND for a broadcast belonging to a different account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asAlice, 1);
  const { broadcastId } = await asAlice.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });

  await expect(
    asBob.query(api.broadcasts.listRecipients, { broadcastId, ...onePage }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "broadcast" } });

  // Positive control.
  const own = await asAlice.query(api.broadcasts.listRecipients, {
    broadcastId,
    ...onePage,
  });
  expect(own.page).toHaveLength(1);
});

// ============================================================
// setStatus
// ============================================================

test("setStatus patches status and bumps updatedAt", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 1);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });

  const before = Date.now();
  await asUser.mutation(api.broadcasts.setStatus, {
    broadcastId,
    status: "sent",
  });

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.status).toBe("sent");
  expect(broadcast!.updatedAt).toBeGreaterThanOrEqual(before);
});

test("setStatus throws NOT_FOUND for a broadcast belonging to a different account, and leaves it untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asAlice, 1);
  const { broadcastId } = await asAlice.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });

  await expect(
    asBob.mutation(api.broadcasts.setStatus, { broadcastId, status: "sent" }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "broadcast" } });

  const row = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(row!.status).toBe("sending"); // unchanged (create's default)

  // Positive control.
  await asAlice.mutation(api.broadcasts.setStatus, {
    broadcastId,
    status: "sent",
  });
  const after = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(after!.status).toBe("sent");
});

// ============================================================
// remove — cascade + cross-account denial
// ============================================================

test("remove cascades: deletes the broadcast's recipients along with it", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 2);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });

  await asUser.mutation(api.broadcasts.remove, { broadcastId });

  expect(await t.run((ctx) => ctx.db.get(broadcastId))).toBeNull();
  // The broadcast itself is gone, so the ownership-gated
  // `listRecipients` query would now (correctly) throw NOT_FOUND —
  // check the underlying table directly instead, inline (see
  // `recipientsOf`'s own comment on why raw `.withIndex` queries must
  // stay inline rather than threaded through a separately-typed helper
  // parameter).
  const remainingRecipients = await t.run((ctx) =>
    ctx.db
      .query("broadcastRecipients")
      .withIndex("by_broadcast", (q) => q.eq("broadcastId", broadcastId))
      .collect(),
  );
  expect(remainingRecipients).toHaveLength(0);
});

test("remove throws NOT_FOUND for a broadcast belonging to a different account, and leaves it + its recipients in place", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asAlice, 2);
  const { broadcastId } = await asAlice.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });

  await expect(
    asBob.mutation(api.broadcasts.remove, { broadcastId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "broadcast" } });

  expect(await t.run((ctx) => ctx.db.get(broadcastId))).not.toBeNull();
  expect(await recipientsOf(asAlice, broadcastId)).toHaveLength(2);

  // Positive control.
  await asAlice.mutation(api.broadcasts.remove, { broadcastId });
  expect(await t.run((ctx) => ctx.db.get(broadcastId))).toBeNull();
});

// ============================================================
// isValidStatusTransition — pure function, direct unit test (ported
// verbatim from route.ts's own RECIPIENT_STATUS_LADDER/
// isValidStatusTransition), mirrors colsForStatus's own treatment above
// ============================================================

test("isValidStatusTransition allows only forward moves along the pending -> sent -> delivered -> read -> replied ladder", () => {
  expect(isValidStatusTransition("pending", "sent")).toBe(true);
  expect(isValidStatusTransition("sent", "delivered")).toBe(true);
  expect(isValidStatusTransition("delivered", "read")).toBe(true);
  expect(isValidStatusTransition("read", "replied")).toBe(true);
  expect(isValidStatusTransition("pending", "replied")).toBe(true); // skipping ahead is fine

  // Regressions (an out-of-order webhook redelivery) are refused.
  expect(isValidStatusTransition("read", "sent")).toBe(false);
  expect(isValidStatusTransition("delivered", "pending")).toBe(false);
  expect(isValidStatusTransition("replied", "delivered")).toBe(false);
});

test("isValidStatusTransition: failed is accepted only from pending/sent, and is terminal once reached", () => {
  expect(isValidStatusTransition("pending", "failed")).toBe(true);
  expect(isValidStatusTransition("sent", "failed")).toBe(true);
  expect(isValidStatusTransition("delivered", "failed")).toBe(false);
  expect(isValidStatusTransition("read", "failed")).toBe(false);
  expect(isValidStatusTransition("replied", "failed")).toBe(false);

  // Once failed, nothing can move it anywhere else.
  expect(isValidStatusTransition("failed", "sent")).toBe(false);
  expect(isValidStatusTransition("failed", "delivered")).toBe(false);
});

// ============================================================
// recordRecipientStatusByWamid — Meta delivery-status webhook handler
// (Phase 8, Task 4), ported from route.ts's `handleStatusUpdate` step 2
// ============================================================

test("recordRecipientStatusByWamid finds the recipient by wamid, advances its status, and updates the parent broadcast's counts", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 1);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });
  const [recipient] = await recipientsOf(asUser, broadcastId);
  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipient!._id,
    status: "sent",
    whatsappMessageId: "wamid.WEBHOOK1",
  });

  const result = await t.mutation(internal.broadcasts.recordRecipientStatusByWamid, {
    wamid: "wamid.WEBHOOK1",
    status: "delivered",
  });
  expect(result).toBe(recipient!._id);

  const recipientRow = await t.run((ctx) => ctx.db.get(recipient!._id));
  expect(recipientRow!.status).toBe("delivered");
  expect(recipientRow!.deliveredAt).toBeDefined();

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.sentCount).toBe(1);
  expect(broadcast!.deliveredCount).toBe(1);
});

test("recordRecipientStatusByWamid is a safe no-op (returns null) when no recipient matches the wamid", async () => {
  const t = convexTest(schema, modules);

  const result = await t.mutation(internal.broadcasts.recordRecipientStatusByWamid, {
    wamid: "wamid.NEVER_SEEN",
    status: "delivered",
  });
  expect(result).toBeNull();
});

test("recordRecipientStatusByWamid refuses an out-of-order regression: 'sent' arriving after 'read' already landed leaves the recipient and counts untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 1);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });
  const [recipient] = await recipientsOf(asUser, broadcastId);
  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipient!._id,
    status: "sent",
    whatsappMessageId: "wamid.OUTOFORDER",
  });
  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipient!._id,
    status: "read",
  });

  // A stale/out-of-order "sent" webhook redelivery arrives after "read"
  // already landed — must be ignored entirely (no regression, no count
  // churn).
  const result = await t.mutation(internal.broadcasts.recordRecipientStatusByWamid, {
    wamid: "wamid.OUTOFORDER",
    status: "sent",
  });
  expect(result).toBe(recipient!._id);

  const recipientRow = await t.run((ctx) => ctx.db.get(recipient!._id));
  expect(recipientRow!.status).toBe("read");

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.sentCount).toBe(1);
  expect(broadcast!.deliveredCount).toBe(1);
  expect(broadcast!.readCount).toBe(1);
});

test("recordRecipientStatusByWamid records an errorMessage on 'failed' and bumps only failedCount", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 1);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });
  const [recipient] = await recipientsOf(asUser, broadcastId);
  await asUser.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: recipient!._id,
    status: "sent",
    whatsappMessageId: "wamid.FAILME",
  });

  await t.mutation(internal.broadcasts.recordRecipientStatusByWamid, {
    wamid: "wamid.FAILME",
    status: "failed",
    errorMessage: "Recipient number invalid",
  });

  const recipientRow = await t.run((ctx) => ctx.db.get(recipient!._id));
  expect(recipientRow!.status).toBe("failed");
  expect(recipientRow!.errorMessage).toBe("Recipient number invalid");

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.sentCount).toBe(0);
  expect(broadcast!.failedCount).toBe(1);
});

test("recordRecipientStatusByWamid targets exactly the matching recipient: a different broadcast's recipient with a distinct wamid is never touched", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const aliceContactIds = await seedContacts(asAlice, 1);
  const { broadcastId: aliceBroadcastId } = await asAlice.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds: aliceContactIds,
  });
  const [aliceRecipient] = await recipientsOf(asAlice, aliceBroadcastId);
  await asAlice.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: aliceRecipient!._id,
    status: "sent",
    whatsappMessageId: "wamid.ALICE1",
  });

  const bobContactIds = await seedContacts(asBob, 1);
  const { broadcastId: bobBroadcastId } = await asBob.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds: bobContactIds,
  });
  const [bobRecipient] = await recipientsOf(asBob, bobBroadcastId);
  await asBob.mutation(api.broadcasts.setRecipientStatus, {
    recipientId: bobRecipient!._id,
    status: "sent",
    whatsappMessageId: "wamid.BOB1",
  });

  await t.mutation(internal.broadcasts.recordRecipientStatusByWamid, {
    wamid: "wamid.ALICE1",
    status: "delivered",
  });

  const aliceRow = await t.run((ctx) => ctx.db.get(aliceRecipient!._id));
  expect(aliceRow!.status).toBe("delivered");
  const bobRow = await t.run((ctx) => ctx.db.get(bobRecipient!._id));
  expect(bobRow!.status).toBe("sent"); // untouched

  const aliceBroadcast = await t.run((ctx) => ctx.db.get(aliceBroadcastId));
  expect(aliceBroadcast!.deliveredCount).toBe(1);
  const bobBroadcast = await t.run((ctx) => ctx.db.get(bobBroadcastId));
  expect(bobBroadcast!.deliveredCount).toBe(0);
});

// ============================================================
// send / deliverOne — the delivery path (Phase 8, Task 4). Every test
// that reaches `metaSend` sets `CONVEX_META_DRY_RUN`, mirroring
// `convex/metaSend.test.ts`'s/`convex/send.test.ts`'s own convention.
// Scheduled `deliverOne` calls never run inline — draining them needs
// `vi.useFakeTimers()` + `t.finishAllScheduledFunctions(vi.runAllTimers)`,
// the exact pattern `automationsEngine.test.ts`'s own wait-step test
// uses for the same reason.
// ============================================================

test("send schedules one deliverOne per pending recipient and flips the broadcast to 'sending' — nothing has actually delivered until the schedule drains", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 3);
  // Created as "draft" so the assertion below actually demonstrates
  // `send` performing the flip, rather than merely leaving `create`'s
  // own default ("sending") untouched.
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
    status: "draft",
  });

  const result = await asUser.action(api.broadcasts.send, { broadcastId });
  expect(result).toEqual({ scheduled: 3 });

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.accountId).toBe(accountId);
  expect(broadcast!.status).toBe("sending");
  const recipientsBefore = await recipientsOf(asUser, broadcastId);
  expect(recipientsBefore.every((r) => r.status === "pending")).toBe(true);

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const recipientsAfter = await recipientsOf(asUser, broadcastId);
  expect(recipientsAfter.every((r) => r.status === "sent")).toBe(true);
  expect(
    recipientsAfter.every((r) =>
      /^dry-run-[0-9a-f]{16}$/.test(r.whatsappMessageId ?? ""),
    ),
  ).toBe(true);

  const finalBroadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(finalBroadcast!.status).toBe("sent");
});

test("deliverOne in DRY-RUN sends the template, stamps the recipient 'sent', records the wamid, and bumps sentCount via the count model", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const [contactId] = await seedContacts(asUser, 1);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds: [contactId!],
  });

  // No conversation exists yet — deliverOne must find-or-create one.
  const before = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId!))
      .first(),
  );
  expect(before).toBeNull();

  await asUser.action(api.broadcasts.send, { broadcastId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const [recipient] = await recipientsOf(asUser, broadcastId);
  expect(recipient!.status).toBe("sent");
  expect(recipient!.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);
  expect(recipient!.sentAt).toBeDefined();

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.status).toBe("sent");
  expect(broadcast!.sentCount).toBe(1); // count model — bumped, not seeded

  // The template landed in the Inbox as a bot-sent message on a
  // freshly find-or-created conversation.
  const conversation = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId!))
      .first(),
  );
  expect(conversation).not.toBeNull();
  expect(conversation!.accountId).toBe(accountId);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversation!._id),
      )
      .collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.senderType).toBe("bot"); // broadcasts are bot-sent
  expect(messages[0]!.contentType).toBe("template");
  expect(messages[0]!.templateName).toBe(baseBroadcast.templateName);
  expect(messages[0]!.messageId).toBe(recipient!.whatsappMessageId);
});

test("a per-recipient failure (its contact deleted before delivery) stamps 'failed' without affecting the other recipient, and the broadcast finalizes 'sent'", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const [okContactId, goneContactId] = await seedContacts(asUser, 2);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds: [okContactId!, goneContactId!],
  });
  // Simulate the contact having been deleted sometime between broadcast
  // creation and delivery — `broadcastRecipients.contactId` has no
  // cascade (schema.ts's own comment), so the recipient row survives,
  // now pointing at a missing contact.
  await t.run((ctx) => ctx.db.delete(goneContactId!));

  await asUser.action(api.broadcasts.send, { broadcastId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const recipients = await recipientsOf(asUser, broadcastId);
  const ok = recipients.find((r) => r.contactId === okContactId);
  const gone = recipients.find((r) => r.contactId === goneContactId);
  expect(ok!.status).toBe("sent");
  expect(ok!.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);
  expect(gone!.status).toBe("failed");
  expect(gone!.errorMessage).toBe("Contact no longer exists");

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  // A partial send (one succeeded) is still "sent" — matches
  // deliverBroadcast's own terminal-status rule.
  expect(broadcast!.status).toBe("sent");
  expect(broadcast!.sentCount).toBe(1);
  expect(broadcast!.failedCount).toBe(1);
});

test("finalizes 'failed' when every recipient fails", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 2);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });
  for (const contactId of contactIds) {
    await t.run((ctx) => ctx.db.delete(contactId));
  }

  await asUser.action(api.broadcasts.send, { broadcastId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const recipients = await recipientsOf(asUser, broadcastId);
  expect(recipients.every((r) => r.status === "failed")).toBe(true);

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.status).toBe("failed");
  expect(broadcast!.sentCount).toBe(0);
  expect(broadcast!.failedCount).toBe(2);
});

// ============================================================
// do-not-contact gate at SEND time (final review, CRITICAL 2) — `create`
// only snapshots do-not-contact ONCE, at broadcast-creation time
// (`blockedReason` check further up this file). A broadcast fans out
// over minutes via `DELIVER_STAGGER_MS`, so a recipient flagged AFTER
// `create` but BEFORE its own `deliverOne` fires must still never be
// messaged — this is the live, per-send re-check `deliverOne` itself
// must perform.
// ============================================================

test("a recipient flagged do-not-contact AFTER create but BEFORE deliverOne runs is never messaged, and the broadcast still finalizes", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const [okContactId, laterBlockedContactId] = await seedContacts(asUser, 2);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds: [okContactId!, laterBlockedContactId!],
  });

  // Both recipients are still "pending" — `deliverOne` hasn't scheduled/
  // run yet. An agent flags the second contact do-not-contact right now,
  // exactly the mid-run window `create`'s own one-time snapshot check
  // can't see.
  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId: (await ctx.db.get(laterBlockedContactId!))!.accountId,
      contactId: laterBlockedContactId!,
      noteText: "Asked us to stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(laterBlockedContactId!, { doNotContact: { at: Date.now(), noteId } });
  });

  await asUser.action(api.broadcasts.send, { broadcastId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const recipients = await recipientsOf(asUser, broadcastId);
  const ok = recipients.find((r) => r.contactId === okContactId);
  const blocked = recipients.find((r) => r.contactId === laterBlockedContactId);
  expect(ok!.status).toBe("sent");
  expect(ok!.whatsappMessageId).toMatch(/^dry-run-[0-9a-f]{16}$/);
  // Reuses the SAME terminal status an undeliverable recipient already
  // gets (never a new one) — see this function's own comment.
  expect(blocked!.status).toBe("failed");
  expect(blocked!.errorMessage).toMatch(/do_not_contact/);

  // No message was ever written for the blocked contact.
  const blockedConversation = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", laterBlockedContactId!))
      .first(),
  );
  expect(blockedConversation).toBeNull();

  // The broadcast still reaches a terminal state — a partial send (one
  // succeeded) is "sent", not stuck "sending" forever.
  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.status).toBe("sent");
  expect(broadcast!.sentCount).toBe(1);
  expect(broadcast!.failedCount).toBe(1);
});

test("send with zero pending recipients finalizes immediately rather than staying stuck at 'sending'", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const broadcastId = await t.run((ctx) =>
    ctx.db.insert("broadcasts", {
      accountId,
      name: "Empty broadcast",
      templateName: "spring_sale",
      templateLanguage: "en_US",
      status: "draft",
      totalRecipients: 0,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
    }),
  );

  const result = await asUser.action(api.broadcasts.send, { broadcastId });
  expect(result).toEqual({ scheduled: 0 });

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  // Nothing ever sent, so the sentCount>0 rule resolves this straight
  // to "failed" instead of leaving it stuck "sending" forever.
  expect(broadcast!.status).toBe("failed");
});

test("send throws NOT_FOUND for a broadcast belonging to a different account, and schedules nothing", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "supervisor",
  });
  const aliceContactIds = await seedContacts(asAlice, 1);
  const { broadcastId } = await asAlice.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds: aliceContactIds,
  });

  await expect(
    asBob.action(api.broadcasts.send, { broadcastId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "broadcast" } });

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.status).toBe("sending"); // create's default, untouched
  const recipients = await recipientsOf(asAlice, broadcastId);
  expect(recipients.every((r) => r.status === "pending")).toBe(true);
});

test("send throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 1);
  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });

  await expect(
    t.action(api.broadcasts.send, { broadcastId }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("send throws FORBIDDEN for a viewer (below the agent floor)", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });
  // A viewer can't call the agent-gated `create` mutation itself — seed
  // a broadcast directly, mirroring `send.test.ts`'s own FORBIDDEN test.
  const broadcastId = await t.run((ctx) =>
    ctx.db.insert("broadcasts", {
      accountId,
      name: "Spring Sale",
      templateName: "spring_sale",
      templateLanguage: "en_US",
      status: "draft",
      totalRecipients: 0,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
    }),
  );

  await expect(
    asUser.action(api.broadcasts.send, { broadcastId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

// ============================================================
// Read-side role floor
//
// `require-section.tsx` states in comment that "server queries already
// reject; this is UX." It was not true here — these reads carried no role
// check at all, so a viewer (conversation scope: "unassigned only") could
// call them directly and read data the nav hides. The floor below matches
// `SUPERVISOR_NAV` in src/lib/auth/roles.ts, which is what already gates
// the pages these queries back.
// ============================================================

async function seedRole(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  role: "viewer" | "agent" | "supervisor",
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: role, email: `${role}@floor.test` }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId,
      accountId,
      role,
      fullName: role,
      email: `${role}@floor.test`,
    }),
  );
  return t.withIdentity({ subject: `${userId}|s-${role}` });
}

test("broadcasts.list throws FORBIDDEN below supervisor and succeeds for a supervisor", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Olive",
    email: "olive@example.com",
    role: "owner",
  });

  const asAgent = await seedRole(t, accountId, "agent");
  await expect(asAgent.query(api.broadcasts.list, {})).rejects.toMatchObject({
    data: { code: "FORBIDDEN", min: "supervisor" },
  });

  const asSupervisor = await seedRole(t, accountId, "supervisor");
  await expect(asSupervisor.query(api.broadcasts.list, {})).resolves.toBeDefined();
});

test("broadcasts.get and listRecipients throw FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner, accountId } = await seedAccountMember(t, {
    name: "Olive",
    email: "olive@example.com",
    role: "owner",
  });
  const contactIds = await seedContacts(asOwner, 1);
  const { broadcastId } = await asOwner.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });

  const asAgent = await seedRole(t, accountId, "agent");
  await expect(
    asAgent.query(api.broadcasts.get, { broadcastId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
  await expect(
    asAgent.query(api.broadcasts.listRecipients, { broadcastId, ...onePage }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

// ============================================================
// Opt-out told to the BOT (spec 2026-08-09). `contacts.doNotContact` is
// only ever set by a human note; when a customer tells the assistant to
// stop, the qualification engine records it on the SESSION instead. A
// gate that checks one and not the other messages exactly the people who
// asked it not to.
// ============================================================

async function optOutOfBot(
  t: ReturnType<typeof convexTest>,
  accountId: string,
  contactId: string,
) {
  await t.run(async (ctx) => {
    const conversationId = await ctx.db.insert("conversations", {
      accountId: accountId as never,
      contactId: contactId as never,
      status: "open",
      unreadCount: 0,
    });
    await ctx.db.insert("qualificationSessions", {
      accountId: accountId as never,
      conversationId,
      contactId: contactId as never,
      status: "opted_out",
      origin: "inbound",
      fields: [],
      expectedCount: 0,
      answeredCount: 0,
      followUpsSent: 0,
      phrasingCursor: 0,
      sendAttemptErrors: 0,
    });
  });
}

test("create drops a contact who told the bot to stop, and reports it as skipped", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 3);
  await optOutOfBot(t, accountId, contactIds[0]!);

  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });

  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.totalRecipients).toBe(2);

  const recipients = await recipientsOf(asUser, broadcastId);
  expect(recipients).toHaveLength(2);
  // No row at all for the opted-out contact — not a failed one.
  expect(recipients.map((r) => r.contactId)).not.toContain(contactIds[0]);
});

test("an opt-out that lands after create still stops the send", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const contactIds = await seedContacts(asUser, 1);

  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds,
  });
  // A broadcast fans out over minutes; the wish can arrive mid-run.
  await optOutOfBot(t, accountId, contactIds[0]!);

  const recipients = await recipientsOf(asUser, broadcastId);
  await t.action(internal.broadcasts.deliverOne, {
    accountId: accountId as never,
    recipientId: recipients[0]!._id as never,
  });

  const after = await recipientsOf(asUser, broadcastId);
  expect(after[0]!.status).toBe("failed");
  expect(after[0]!.errorMessage).toContain("opted_out");
});

// ============================================================
// resolveBroadcastParams / needsCustomValues — pure functions, direct
// unit tests (same treatment as colsForStatus above). These cover the
// bug that made every parameterised broadcast undeliverable: the
// composer stores ONE mapping per placeholder keyed "1"/"2"/…, and
// `deliverOne` used to forward `templateVariables` only when it was
// already a plain `string[]`, so the mapping object resolved to no
// params at all and Meta rejected the send for every recipient.
// ============================================================

const CONTACT = {
  name: "Alice",
  phone: "+15550000001",
  email: "alice@example.com",
  company: "Acme",
};

test("resolveBroadcastParams resolves the composer's mapping object against the recipient", () => {
  const params = resolveBroadcastParams(
    {
      "1": { type: "field", value: "name" },
      "2": { type: "static", value: "20% off" },
      "3": { type: "custom_field", value: "fld_city" },
    },
    CONTACT,
    { fld_city: "Dubai" },
  );
  expect(params).toEqual(["Alice", "20% off", "Dubai"]);
});

test("resolveBroadcastParams orders by placeholder number, not object key order, and fills a gap rather than shifting later values", () => {
  // "2" deliberately unmapped — collapsing it would slide "Alice" into
  // {{2}}, which is worse than one blank.
  const params = resolveBroadcastParams(
    { "3": { type: "field", value: "name" }, "1": { type: "static", value: "Hi" } },
    CONTACT,
    {},
  );
  expect(params).toEqual(["Hi", "", "Alice"]);
});

test("resolveBroadcastParams yields an empty string for data the contact doesn't have, never a dropped slot", () => {
  const params = resolveBroadcastParams(
    {
      "1": { type: "field", value: "company" },
      "2": { type: "custom_field", value: "fld_missing" },
      "3": { type: "field", value: "not_a_column" },
    },
    { name: "Bob", phone: "+15550000002" }, // no company
    {},
  );
  expect(params).toEqual(["", "", ""]);
});

test("resolveBroadcastParams passes a positional string[] straight through (the REST-API / legacy shape)", () => {
  expect(resolveBroadcastParams(["a", "b"], CONTACT, {})).toEqual(["a", "b"]);
  // A bare literal per key, without the {type,value} wrapper.
  expect(resolveBroadcastParams({ "1": "Alice" }, CONTACT, {})).toEqual(["Alice"]);
});

test("resolveBroadcastParams returns undefined when there is nothing to send, so sendTemplate omits the body component", () => {
  expect(resolveBroadcastParams(undefined, CONTACT, {})).toBeUndefined();
  expect(resolveBroadcastParams({}, CONTACT, {})).toBeUndefined();
  expect(resolveBroadcastParams({ notANumber: "x" }, CONTACT, {})).toBeUndefined();
  // A non-string array is not a usable positional param list.
  expect(resolveBroadcastParams([1, 2], CONTACT, {})).toBeUndefined();
});

test("needsCustomValues is true only when a mapping actually names a custom field", () => {
  expect(needsCustomValues({ "1": { type: "custom_field", value: "f" } })).toBe(true);
  expect(needsCustomValues({ "1": { type: "field", value: "name" } })).toBe(false);
  expect(needsCustomValues({ "1": { type: "static", value: "hi" } })).toBe(false);
  expect(needsCustomValues(["a"])).toBe(false);
  expect(needsCustomValues(undefined)).toBe(false);
});

// Asserts the two halves the delivery path newly depends on: the loader
// hands `deliverOne` THIS recipient's own custom values, and the header
// columns survive `create`. The Meta request body itself is not
// observable here — DRY-RUN short-circuits before the fetch, and
// broadcasts pass no `contentText` for the message row to echo — so the
// resolution itself is asserted directly by the unit tests above.
test("the delivery loader supplies each recipient's OWN custom-field value, and the media header columns survive create", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const [c1, c2] = await seedContacts(asUser, 2);

  const fieldId = await asUser.mutation(api.customFields.create, {
    fieldName: "City",
    fieldType: "text",
  });
  await asUser.mutation(api.customFields.setForContact, {
    contactId: c1!,
    values: [{ customFieldId: fieldId, value: "Dubai" }],
  });
  await asUser.mutation(api.customFields.setForContact, {
    contactId: c2!,
    values: [{ customFieldId: fieldId, value: "Kochi" }],
  });

  const { broadcastId } = await asUser.mutation(api.broadcasts.create, {
    ...baseBroadcast,
    contactIds: [c1!, c2!],
    templateVariables: {
      "1": { type: "field", value: "name" },
      "2": { type: "custom_field", value: fieldId },
    },
    headerMediaUrl: "https://cdn.example.com/spring.jpg",
    headerMediaType: "image",
  });

  // The header columns survive `create` — without them every delivery
  // of a media-header template is rejected by Meta.
  const broadcast = await t.run((ctx) => ctx.db.get(broadcastId));
  expect(broadcast!.headerMediaUrl).toBe("https://cdn.example.com/spring.jpg");
  expect(broadcast!.headerMediaType).toBe("image");

  await asUser.action(api.broadcasts.send, { broadcastId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const recipients = await recipientsOf(asUser, broadcastId);
  expect(recipients.map((r) => r.status)).toEqual(["sent", "sent"]);

  // Each recipient's delivery payload is built from ITS OWN contact:
  // same broadcast, different resolved params.
  const resolved = await Promise.all(
    recipients.map(async (recipient) => {
      const loaded = await t.query(
        internal.broadcasts.getRecipientForDeliveryInternal,
        { accountId: broadcast!.accountId, recipientId: recipient._id },
      );
      return resolveBroadcastParams(
        loaded!.broadcast.templateVariables,
        loaded!.contact!,
        loaded!.customValues,
      );
    }),
  );
  const cities = resolved.map((params) => params![1]).sort();
  expect(cities).toEqual(["Dubai", "Kochi"]);
  // …and the name slot tracked the same contact, never a shared value.
  expect(new Set(resolved.map((params) => params![0])).size).toBe(2);
});
