/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches
// `convex/contacts.test.ts` — see that file's comment for why this must
// be absolute rather than a relative "./**").
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

// ============================================================
// listForContact
// ============================================================

test("listForContact merges notes and stage moves, newest first", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );

  await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Called him",
    kind: "call",
  });
  await t.run((ctx) =>
    ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "qualified",
      byUserId: userId,
      auto: false,
    }),
  );

  const feed = await asUser.query(api.contactActivity.listForContact, { contactId });

  expect(feed.map((e) => e.kind)).toEqual(["stage", "note"]);
  expect(feed[0].at).toBeGreaterThanOrEqual(feed[1].at);
});

// The double-count decision, pinned as a test so nobody "helpfully"
// adds deals/checklists back into the merge later. This one covers only
// the terminal case (`stage === "purchased"`) — see the three sibling
// tests below ("a reopened deal...", "a plain non-terminal move...",
// "a predecessor lookup is scoped...") for the reopen branch, which this
// test alone does NOT exercise and which shipped with a real bug: a
// reopen's non-terminal `stage` row was not being recognized as
// note-mirrored (see `isNoteMirroredTransition` in `contactActivity.ts`).
test("a deal outcome appears ONCE — as the note funnel.ts already writes", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );

  // Exactly what `funnel.ts` writes on a won deal: a terminal transition
  // AND its mirrored note.
  await t.run(async (ctx) => {
    await ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "purchased",
      byUserId: userId,
      auto: false,
    });
    await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      createdByUserId: userId,
      noteText: "🏆 Deal won — 5000 AED",
    });
  });

  const feed = await asUser.query(api.contactActivity.listForContact, { contactId });
  // The note renders it; the terminal transition must NOT also render it.
  expect(feed.filter((e) => e.kind === "stage")).toHaveLength(0);
  expect(feed.filter((e) => e.kind === "note")).toHaveLength(1);
});

// `funnel.ts` mirrors a THIRD branch into a note, not just won/lost: moving
// a deal OFF a terminal stage back onto a live one ("↩️ Deal reopened").
// The reopening transition's own `stage` is non-terminal (e.g.
// "price_quoted"), so a filter that only checks the transition's own
// `stage` against `{purchased, lost}` misses it entirely and the feed
// double-renders the reopen. This test must fail before the fix in
// `isNoteMirroredTransition` (predecessor-aware exclusion) and pass after.
test("a reopened deal renders once — as the note, with no stage entry for the reopening move", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );

  // The deal first reaches a terminal stage...
  await t.run((ctx) =>
    ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "purchased",
      byUserId: userId,
      auto: false,
    }),
  );

  // ...then gets moved back onto a live, non-terminal stage. Exactly what
  // `funnel.ts` writes for this: a transition whose OWN `stage` is
  // non-terminal, plus the "↩️ Deal reopened" note (its `previousStage`
  // was terminal, which is not stored on the transition row itself).
  await t.run(async (ctx) => {
    await ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "price_quoted",
      byUserId: userId,
      auto: false,
    });
    await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      createdByUserId: userId,
      noteText: "↩️ Deal reopened → Price quoted",
    });
  });

  const feed = await asUser.query(api.contactActivity.listForContact, { contactId });
  // Neither the terminal "purchased" transition nor the reopening
  // "price_quoted" transition should render as a `stage` entry — both are
  // note-mirrored (the second, terminal one directly; the reopen, via its
  // predecessor).
  expect(feed.filter((e) => e.kind === "stage")).toHaveLength(0);
  expect(feed.filter((e) => e.kind === "note")).toHaveLength(1);
});

// Regression guard for the fix above: an over-eager exclusion (e.g.
// dropping every non-terminal move, or matching on the wrong direction of
// "predecessor") would make the feed's one unique contribution — a plain
// stage move — vanish entirely.
test("a plain non-terminal move with no terminal predecessor still renders its stage entry", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );

  await t.run((ctx) =>
    ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "new_lead",
      byUserId: userId,
      auto: false,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "qualified",
      byUserId: userId,
      auto: false,
    }),
  );

  const feed = await asUser.query(api.contactActivity.listForContact, { contactId });
  const stages = feed
    .filter((e) => e.kind === "stage")
    .map((e) => (e as Extract<typeof e, { kind: "stage" }>).stage);
  expect(stages).toContain("new_lead");
  expect(stages).toContain("qualified");
});

// Proves the predecessor lookup is scoped by `conversationId`, not by
// time across a contact's whole history. A contact can hold several
// threads; if the lookup interleaved them by `_creationTime` instead of
// grouping first, conversation B's unrelated move — written after
// conversation A's terminal transition — would be misread as a reopen of
// A's deal and wrongly dropped.
test("a predecessor lookup is scoped per conversation, not interleaved across a contact's threads", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const conversationA = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );
  const conversationB = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );

  // Conversation A reaches a terminal stage first...
  await t.run((ctx) =>
    ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId: conversationA,
      contactId,
      stage: "purchased",
      byUserId: userId,
      auto: false,
    }),
  );
  // ...then conversation B gets an unrelated non-terminal move, written
  // LATER in time. Time-interleaved (wrong) logic would treat A's
  // "purchased" as B's predecessor and drop this entry.
  await t.run((ctx) =>
    ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId: conversationB,
      contactId,
      stage: "qualified",
      byUserId: userId,
      auto: false,
    }),
  );

  const feed = await asUser.query(api.contactActivity.listForContact, { contactId });
  const stages = feed
    .filter((e) => e.kind === "stage")
    .map((e) => (e as Extract<typeof e, { kind: "stage" }>).stage);
  expect(stages).toContain("qualified");
});

test("listForContact rejects another account's contact as NOT_FOUND", async () => {
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
  const bobContact = await bob.asUser.mutation(api.contacts.create, { phone: "2" });

  await expect(
    alice.asUser.query(api.contactActivity.listForContact, { contactId: bobContact }),
  ).rejects.toThrow(/NOT_FOUND/);
});

test("a viewer can read the feed — reads have no role floor", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const contactId = await owner.asUser.mutation(api.contacts.create, { phone: "1" });

  const viewerId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Vic", email: "vic@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: viewerId,
      accountId: owner.accountId,
      role: "viewer",
      fullName: "Vic",
      email: "vic@example.com",
    }),
  );
  const asViewer = t.withIdentity({ subject: `${viewerId}|session-vic` });

  await expect(
    asViewer.query(api.contactActivity.listForContact, { contactId }),
  ).resolves.toBeDefined();
});
