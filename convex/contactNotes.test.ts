/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

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

/**
 * Parks a real `automationRuns` row on a `wait` step for `contactId` —
 * needed only by Task 5's cancellation tests below. Direct inserts (no
 * membership/identity needed) plus `internal.automationsEngine.
 * runForTrigger`, matching `automationsEngine.test.ts`'s own
 * `seedAutomation`/`seedStep` helpers, duplicated here per this
 * codebase's per-suite-owns-its-own-helpers convention.
 *
 * The automation is `[wait, send_message]`, not a bare `wait` — a run
 * parked on a dead-end wait has no observable customer-facing effect to
 * assert zero of, so a "cancellation" test built on one can only ever
 * check the row's own `status`/`errorMessage`, never that nothing
 * actually reached the customer (the guarantee this task exists for;
 * post-review fix). Also seeds `contactId`'s own conversation with the
 * 24h window held open (`lastInboundAt: Date.now()`), so the
 * `send_message` step CAN resolve a send target and actually send if a
 * caller's cancellation wiring is broken or missing — required for a
 * `messages`-collection assertion to be load-bearing rather than
 * vacuously true because there was nowhere for a message to land.
 */
async function seedWaitingAutomationRun(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  contactId: Id<"contacts">,
): Promise<Doc<"automationRuns"> | null> {
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      lastInboundAt: Date.now(),
    }),
  );
  const automationId = await t.run((ctx) =>
    ctx.db.insert("automations", {
      accountId,
      name: "Nudge",
      triggerType: "new_message_received",
      triggerConfig: {},
      isActive: true,
      executionCount: 0,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("automationSteps", {
      accountId,
      automationId,
      stepType: "wait",
      stepConfig: { amount: 1, unit: "hours" },
      position: 0,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("automationSteps", {
      accountId,
      automationId,
      stepType: "send_message",
      stepConfig: { text: "Following up on your request!" },
      position: 1,
    }),
  );
  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "new_message_received",
    contactId,
    context: { conversationId },
  });
  return await t.run((ctx: QueryCtx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
}

// ============================================================
// add
// ============================================================

test("add inserts a note scoped to the caller's own account, storing `body` under the schema's real `noteText` field", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "1",
  });

  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Called about renewal",
  });

  const row = await t.run((ctx) => ctx.db.get(noteId));
  expect(row).not.toBeNull();
  expect(row!.accountId).toBe(accountId);
  expect(row!.contactId).toBe(contactId);
  expect(row!.createdByUserId).toBe(userId);
  // The public arg is named `body`; the schema's real field is
  // `noteText` (Postgres: `contact_notes.note_text`).
  expect(row!.noteText).toBe("Called about renewal");
});

test("add throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAgent } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asViewer } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });
  const contactId = await asAgent.mutation(api.contacts.create, {
    phone: "1",
  });

  await expect(
    asViewer.mutation(api.contactNotes.add, { contactId, body: "Sneaky" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("add throws NOT_FOUND when the contact belongs to a different account, and leaves note count at 0", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "1",
  });

  await expect(
    asBob.mutation(api.contactNotes.add, {
      contactId: aliceContactId,
      body: "Pwned",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  const afterDenial = await t.run((ctx) =>
    ctx.db.query("contactNotes").collect(),
  );
  expect(afterDenial).toHaveLength(0);

  // Positive control.
  await asAlice.mutation(api.contactNotes.add, {
    contactId: aliceContactId,
    body: "Legit",
  });
  const afterLegit = await t.run((ctx) =>
    ctx.db.query("contactNotes").collect(),
  );
  expect(afterLegit).toHaveLength(1);
});

// ============================================================
// listForContact — newest-first + account isolation
// ============================================================

test("listForContact returns the contact's notes newest-first", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "1",
  });

  const firstId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "First",
  });
  const secondId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Second",
  });
  const thirdId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Third",
  });

  const notes = await asUser.query(api.contactNotes.listForContact, {
    contactId,
  });

  expect(notes.map((n) => n._id)).toEqual([thirdId, secondId, firstId]);
  expect(notes.map((n) => n.noteText)).toEqual(["Third", "Second", "First"]);
});

test("listForContact never returns another contact's notes, even within the same account", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contact1 = await asUser.mutation(api.contacts.create, { phone: "1" });
  const contact2 = await asUser.mutation(api.contacts.create, { phone: "2" });
  await asUser.mutation(api.contactNotes.add, {
    contactId: contact1,
    body: "For contact 1",
  });

  const contact2Notes = await asUser.query(api.contactNotes.listForContact, {
    contactId: contact2,
  });
  expect(contact2Notes).toEqual([]);
});

test("listForContact throws NOT_FOUND when the contact belongs to a different account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "1",
  });
  await asAlice.mutation(api.contactNotes.add, {
    contactId: aliceContactId,
    body: "Private",
  });

  await expect(
    asBob.query(api.contactNotes.listForContact, {
      contactId: aliceContactId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  // Positive control.
  const notes = await asAlice.query(api.contactNotes.listForContact, {
    contactId: aliceContactId,
  });
  expect(notes).toHaveLength(1);
});

// ============================================================
// remove
// ============================================================

test("remove deletes a note", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "1",
  });
  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Delete me",
  });

  await asUser.mutation(api.contactNotes.remove, { noteId });

  expect(await t.run((ctx) => ctx.db.get(noteId))).toBeNull();
});

test("remove throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAgent } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asViewer } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });
  const contactId = await asAgent.mutation(api.contacts.create, {
    phone: "1",
  });
  const noteId = await asAgent.mutation(api.contactNotes.add, {
    contactId,
    body: "Note",
  });

  await expect(
    asViewer.mutation(api.contactNotes.remove, { noteId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("remove throws NOT_FOUND for a note belonging to a different account, and leaves it in place", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "1",
  });
  const aliceNoteId = await asAlice.mutation(api.contactNotes.add, {
    contactId: aliceContactId,
    body: "Mine",
  });

  await expect(
    asBob.mutation(api.contactNotes.remove, { noteId: aliceNoteId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contactNote" } });

  expect(await t.run((ctx) => ctx.db.get(aliceNoteId))).not.toBeNull();

  // Positive control.
  await asAlice.mutation(api.contactNotes.remove, { noteId: aliceNoteId });
  expect(await t.run((ctx) => ctx.db.get(aliceNoteId))).toBeNull();
});

// ============================================================
// schema — the Phase 1 optional fields
// ============================================================

test("contactNotes accepts the extended fields and indexes them by conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const noteId = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "971500000001",
      phoneNormalized: "971500000001",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    });
    return await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      conversationId,
      createdByUserId: userId,
      noteText: "Called, wants March",
      kind: "call",
      outcome: "follow_up",
      attachments: [
        {
          key: `${accountId}/note/abc.pdf`,
          filename: "quote.pdf",
          contentType: "application/pdf",
          size: 1234,
        },
      ],
      editedAt: Date.now(),
    });
  });

  const row = await t.run((ctx) => ctx.db.get(noteId));
  expect(row!.kind).toBe("call");
  expect(row!.outcome).toBe("follow_up");
  expect(row!.attachments).toHaveLength(1);

  // The index the thread's inline query ranges on.
  const byConversation = await t.run((ctx) =>
    ctx.db
      .query("contactNotes")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", row!.conversationId!),
      )
      .collect(),
  );
  expect(byConversation).toHaveLength(1);
});

test("contacts accepts the doNotContact flag", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const contactId = await t.run(async (ctx) => {
    const cId = await ctx.db.insert("contacts", {
      accountId,
      phone: "971500000002",
      phoneNormalized: "971500000002",
    });
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId: cId,
      noteText: "Asked never to be contacted",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(cId, {
      doNotContact: { at: Date.now(), byUserId: userId, noteId },
    });
    return cId;
  });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeDefined();
  expect(contact!.doNotContact!.byUserId).toBe(userId);
});

// ============================================================
// add — channel, outcome, conversation link, attachments (Task 3)
// ============================================================

test("add stores the channel, outcome and conversation link", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
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

  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    conversationId,
    body: "Rang him, no answer",
    kind: "call",
    outcome: "no_answer",
  });

  const row = await t.run((ctx) => ctx.db.get(noteId));
  expect(row!.kind).toBe("call");
  expect(row!.outcome).toBe("no_answer");
  expect(row!.conversationId).toBe(conversationId);
});

test("add sets contacts.doNotContact when the outcome is do_not_contact", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Said never contact again",
    kind: "call",
    outcome: "do_not_contact",
  });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeDefined();
  expect(contact!.doNotContact!.noteId).toBe(noteId);
  expect(contact!.doNotContact!.byUserId).toBe(userId);
});

test("add leaves doNotContact untouched for every other outcome", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Will call back Tuesday",
    kind: "call",
    outcome: "follow_up",
  });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeUndefined();
});

test("add rejects more than 5 attachments", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  const attachment = (n: number) => ({
    key: `${accountId}/note/file${n}.pdf`,
    filename: `f${n}.pdf`,
    contentType: "application/pdf",
    size: 10,
  });

  await expect(
    asUser.mutation(api.contactNotes.add, {
      contactId,
      body: "Too many",
      attachments: [1, 2, 3, 4, 5, 6].map(attachment),
    }),
  ).rejects.toThrow(/TOO_MANY_ATTACHMENTS/);
});

test("add rejects an attachment key belonging to another account as NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  await expect(
    asUser.mutation(api.contactNotes.add, {
      contactId,
      body: "Someone else's file",
      attachments: [
        {
          key: "some-other-account/note/stolen.pdf",
          filename: "stolen.pdf",
          contentType: "application/pdf",
          size: 10,
        },
      ],
    }),
  ).rejects.toThrow(/NOT_FOUND/);
});

test("add rejects a conversationId belonging to another account as NOT_FOUND", async () => {
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
  const aliceContact = await alice.asUser.mutation(api.contacts.create, {
    phone: "1",
  });
  const bobContact = await bob.asUser.mutation(api.contacts.create, {
    phone: "2",
  });
  const bobConversation = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: bob.accountId,
      contactId: bobContact,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );

  await expect(
    alice.asUser.mutation(api.contactNotes.add, {
      contactId: aliceContact,
      conversationId: bobConversation,
      body: "Cross-tenant probe",
    }),
  ).rejects.toThrow(/NOT_FOUND/);
});

test("add rejects a conversation that belongs to a DIFFERENT contact in the same account as NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactA = await asUser.mutation(api.contacts.create, { phone: "1" });
  const contactB = await asUser.mutation(api.contacts.create, { phone: "2" });
  // A real, same-account conversation — just not contactA's.
  const conversationForB = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId: contactB,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );

  await expect(
    asUser.mutation(api.contactNotes.add, {
      contactId: contactA,
      conversationId: conversationForB,
      body: "Mismatched pair",
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "conversation" },
  });

  const notes = await t.run((ctx) => ctx.db.query("contactNotes").collect());
  expect(notes).toHaveLength(0);
});

test("add rejects an unparseable attachment key as NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  await expect(
    asUser.mutation(api.contactNotes.add, {
      contactId,
      body: "Malformed key",
      attachments: [
        {
          key: "not-a-key",
          filename: "mystery.pdf",
          contentType: "application/pdf",
          size: 10,
        },
      ],
    }),
  ).rejects.toThrow(/NOT_FOUND/);
});

// ============================================================
// update, tightened remove, clearDoNotContact (Task 4)
// ============================================================

test("update edits an author's own note and stamps editedAt", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Typo",
    kind: "call",
  });

  await asUser.mutation(api.contactNotes.update, {
    noteId,
    body: "Fixed",
    kind: "meeting",
  });

  const row = await t.run((ctx) => ctx.db.get(noteId));
  expect(row!.noteText).toBe("Fixed");
  expect(row!.kind).toBe("meeting");
  expect(row!.editedAt).toBeGreaterThan(0);
});

test("update refuses to change an outcome that is already do_not_contact", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Never contact",
    outcome: "do_not_contact",
  });

  await expect(
    asUser.mutation(api.contactNotes.update, { noteId, outcome: "follow_up" }),
  ).rejects.toThrow(/DO_NOT_CONTACT_LOCKED/);

  // Editing the TEXT of that same note is still allowed.
  await asUser.mutation(api.contactNotes.update, {
    noteId,
    body: "Never contact — he was firm about it",
  });
  const row = await t.run((ctx) => ctx.db.get(noteId));
  expect(row!.outcome).toBe("do_not_contact");
});

test("update arms contacts.doNotContact when the outcome is edited to do_not_contact", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Will call back",
    outcome: "follow_up",
  });

  await asUser.mutation(api.contactNotes.update, {
    noteId,
    outcome: "do_not_contact",
  });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeDefined();
  expect(contact!.doNotContact!.noteId).toBe(noteId);
  expect(contact!.doNotContact!.byUserId).toBe(userId);
});

test("update leaves contacts.doNotContact untouched when the outcome is edited to a non-do_not_contact value", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Will call back",
    outcome: "follow_up",
  });

  await asUser.mutation(api.contactNotes.update, {
    noteId,
    outcome: "no_answer",
  });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeUndefined();
});

test("update throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAgent } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asViewer } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });
  const contactId = await asAgent.mutation(api.contacts.create, {
    phone: "1",
  });
  const noteId = await asAgent.mutation(api.contactNotes.add, {
    contactId,
    body: "Note",
  });

  await expect(
    asViewer.mutation(api.contactNotes.update, { noteId, body: "Sneaky" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("update rejects an attachment key belonging to another account as NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Original",
  });

  await expect(
    asUser.mutation(api.contactNotes.update, {
      noteId,
      attachments: [
        {
          key: "some-other-account/note/stolen.pdf",
          filename: "stolen.pdf",
          contentType: "application/pdf",
          size: 10,
        },
      ],
    }),
  ).rejects.toThrow(/NOT_FOUND/);

  const row = await t.run((ctx) => ctx.db.get(noteId));
  expect(row!.attachments).toBeUndefined();
});

test("update and remove reject an agent who is not the author", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await alice.asUser.mutation(api.contacts.create, {
    phone: "1",
  });
  const noteId = await alice.asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Alice's note",
  });

  // A second agent in the SAME account — membership is fine, authorship
  // is not.
  const bobUserId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Bob", email: "bob@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: bobUserId,
      accountId: alice.accountId,
      role: "agent",
      fullName: "Bob",
      email: "bob@example.com",
    }),
  );
  const asBob = t.withIdentity({ subject: `${bobUserId}|session-bob` });

  await expect(
    asBob.mutation(api.contactNotes.update, { noteId, body: "hijack" }),
  ).rejects.toThrow(/FORBIDDEN/);
  await expect(
    asBob.mutation(api.contactNotes.remove, { noteId }),
  ).rejects.toThrow(/FORBIDDEN/);
});

test("an admin may remove a note they did not author", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await alice.asUser.mutation(api.contacts.create, {
    phone: "1",
  });
  const noteId = await alice.asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Alice's note",
  });

  const adminUserId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Ada", email: "ada@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: adminUserId,
      accountId: alice.accountId,
      role: "admin",
      fullName: "Ada",
      email: "ada@example.com",
    }),
  );
  const asAdmin = t.withIdentity({ subject: `${adminUserId}|session-ada` });

  await asAdmin.mutation(api.contactNotes.remove, { noteId });
  expect(await t.run((ctx) => ctx.db.get(noteId))).toBeNull();
});

test("deleting the note that set doNotContact leaves the flag standing", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Never contact",
    outcome: "do_not_contact",
  });

  await asUser.mutation(api.contactNotes.remove, { noteId });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeDefined();
});

test("clearDoNotContact requires supervisor and writes an audit note", async () => {
  const t = convexTest(schema, modules);
  const agent = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await agent.asUser.mutation(api.contacts.create, {
    phone: "1",
  });
  await agent.asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Never contact",
    outcome: "do_not_contact",
  });

  // An agent may not overrule a customer's stated wish.
  await expect(
    agent.asUser.mutation(api.contactNotes.clearDoNotContact, { contactId }),
  ).rejects.toThrow(/FORBIDDEN/);

  const supUserId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: supUserId,
      accountId: agent.accountId,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    }),
  );
  const asSup = t.withIdentity({ subject: `${supUserId}|session-sam` });

  await asSup.mutation(api.contactNotes.clearDoNotContact, { contactId });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeUndefined();

  // Clearing is itself auditable.
  const notes = await t.run((ctx) =>
    ctx.db
      .query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect(),
  );
  const audit = notes.find((n) => n.createdByUserId === supUserId);
  expect(audit).toBeDefined();
  expect(audit!.kind).toBe("general");
});

// ============================================================
// listForContact author embedding, listForConversation (Task 5)
// ============================================================

test("listForContact embeds the author's name and returns newest first", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  await asUser.mutation(api.contactNotes.add, { contactId, body: "First" });
  await asUser.mutation(api.contactNotes.add, { contactId, body: "Second" });

  const notes = await asUser.query(api.contactNotes.listForContact, {
    contactId,
  });

  expect(notes.map((n) => n.noteText)).toEqual(["Second", "First"]);
  expect(notes[0].author).toEqual({
    userId,
    fullName: "Alice",
    avatarUrl: undefined,
  });
});

test("listForContact returns a null author for an engine-written note", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  await t.run((ctx) =>
    ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: "Stage moved to qualified",
    }),
  );

  const notes = await asUser.query(api.contactNotes.listForContact, {
    contactId,
  });
  expect(notes[0].author).toBeNull();
});

test("listForConversation returns only that conversation's notes", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const [convA, convB] = await t.run(async (ctx) => [
    await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
    await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  ]);
  // Two notes in A, in a known creation order, so the ordering
  // assertion below is meaningful — a single note can't distinguish
  // `.order("asc")` from `.order("desc")`.
  await asUser.mutation(api.contactNotes.add, {
    contactId,
    conversationId: convA,
    body: "First in A",
  });
  await asUser.mutation(api.contactNotes.add, {
    contactId,
    conversationId: convA,
    body: "Second in A",
  });
  await asUser.mutation(api.contactNotes.add, {
    contactId,
    conversationId: convB,
    body: "In B",
  });
  // A contact-level note with no conversation must appear in NEITHER.
  await asUser.mutation(api.contactNotes.add, { contactId, body: "Unlinked" });

  const inA = await asUser.query(api.contactNotes.listForConversation, {
    conversationId: convA,
  });
  // Oldest first — the opposite of `listForContact`'s newest-first, and
  // the thing that would break if `.order("asc")` became `.order("desc")`.
  expect(inA.map((n) => n.noteText)).toEqual(["First in A", "Second in A"]);
});

test("listForConversation rejects another account's conversation as NOT_FOUND", async () => {
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
  const bobContact = await bob.asUser.mutation(api.contacts.create, {
    phone: "2",
  });
  const bobConversation = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: bob.accountId,
      contactId: bobContact,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );

  await expect(
    alice.asUser.query(api.contactNotes.listForConversation, {
      conversationId: bobConversation,
    }),
  ).rejects.toThrow(/NOT_FOUND/);
});

test("listForContact resolves the author's SAME-account membership even when they belong to a second account (regression: by_user_account, not by_user)", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: realAccountId } = await seedAccountMember(
    t,
    { name: "Alice", email: "alice@example.com", role: "agent" },
  );
  const contactId = await asAlice.mutation(api.contacts.create, { phone: "1" });

  // Carol belongs to TWO accounts, and her membership in the DECOY
  // account is inserted FIRST. A `by_user`-only lookup (no account in
  // the index, so `.first()` falls back to creation order) would
  // surface the decoy row before the real one; a JS filter on that
  // result correctly rejects it as a different account but then
  // misresolves a genuine same-account author to `null` instead of
  // finding her real-account row.
  const carolUserId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Carol", email: "carol@example.com" }),
  );
  const decoyAccountId = await t.run((ctx) =>
    ctx.db.insert("accounts", {
      name: "Decoy account",
      defaultCurrency: "USD",
      ownerUserId: carolUserId,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: carolUserId,
      accountId: decoyAccountId,
      role: "agent",
      fullName: "Decoy Carol",
      email: "carol@example.com",
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: carolUserId,
      accountId: realAccountId,
      role: "agent",
      fullName: "Carol",
      email: "carol@example.com",
    }),
  );

  // Inserted directly (not via `add` as Carol) so this exercises only
  // `withAuthors`'s lookup, not the separate, pre-existing `by_user`
  // account-resolution in `lib/auth.ts`'s `withAccount`, which is out
  // of scope for this fix.
  await t.run((ctx) =>
    ctx.db.insert("contactNotes", {
      accountId: realAccountId,
      contactId,
      createdByUserId: carolUserId,
      noteText: "Carol's note",
    }),
  );

  const notes = await asAlice.query(api.contactNotes.listForContact, {
    contactId,
  });

  expect(notes[0].author).not.toBeNull();
  expect(notes[0].author?.fullName).toBe("Carol");
});

// ============================================================
// clearDoNotContact stamps the originating note (Task 7)
// ============================================================

test("clearDoNotContact stamps the originating note as cleared", async () => {
  const t = convexTest(schema, modules);
  const agent = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await agent.asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await agent.asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Never contact",
    outcome: "do_not_contact",
  });

  const supId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: supId,
      accountId: agent.accountId,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    }),
  );
  const asSup = t.withIdentity({ subject: `${supId}|session-sam` });

  await asSup.mutation(api.contactNotes.clearDoNotContact, { contactId });

  const row = await t.run((ctx) => ctx.db.get(noteId));
  // The outcome SURVIVES — it records what the customer actually said.
  expect(row!.outcome).toBe("do_not_contact");
  // …and the note now also records that it was overridden.
  expect(row!.outcomeClearedAt).toBeGreaterThan(0);
});

test("clearing is safe when the originating note was already deleted", async () => {
  const t = convexTest(schema, modules);
  const agent = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await agent.asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await agent.asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Never contact",
    outcome: "do_not_contact",
  });
  await agent.asUser.mutation(api.contactNotes.remove, { noteId });

  const supId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: supId,
      accountId: agent.accountId,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    }),
  );
  const asSup = t.withIdentity({ subject: `${supId}|session-sam` });

  // The flag deliberately outlives its note (Phase 1) — clearing must
  // still work rather than throwing on the dangling id.
  await asSup.mutation(api.contactNotes.clearDoNotContact, { contactId });
  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeUndefined();
});

// ============================================================
// Task 5 — cancellation path 4: do-not-contact cancels the contact's
// waiting automation runs. The brief's own Step 4 names
// `convex/contacts.ts` as the file to modify, but no mutation there
// ever sets `doNotContact` — `add` and `update` here are the two real
// call sites (confirmed by grep), so that's where the cancellation
// hook lives.
// ============================================================

test("add's do_not_contact outcome cancels the contact's waiting automation runs", async () => {
  vi.useFakeTimers();
  try {
    process.env.CONVEX_META_DRY_RUN = "1";
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "agent",
    });
    const contactId = await asUser.mutation(api.contacts.create, { phone: "15550005001" });

    const parked = await seedWaitingAutomationRun(t, accountId, contactId);
    expect(parked?.status).toBe("waiting");

    await asUser.mutation(api.contactNotes.add, {
      contactId,
      body: "Asked never to be contacted",
      outcome: "do_not_contact",
    });
    // `add` only SCHEDULES `cancelRunsForContact` (a mutation can't call
    // another mutation inline — only `ctx.scheduler` reaches one), so at
    // this point two scheduled functions are both pending: the
    // freshly-scheduled cancellation (delay 0) and the original wait's
    // own far-future resume. Draining the delay-0 cancellation to full
    // completion FIRST — before the resume's timer is ever considered
    // due — avoids a convex-test simulator race where a single
    // `vi.runAllTimers()` pass can interleave both jobs' async chains and
    // let `ctx.scheduler.cancel` land on an already-`"inProgress"` resume
    // (see `automations.test.ts`'s identical `setActive` tests for the
    // full mechanics). This never happens in real Convex, where the
    // delay-0 job settles in milliseconds — long before a wait's
    // real-time delay elapses.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const run = await t.run((ctx) => ctx.db.get(parked!._id));
    expect(run?.status).toBe("cancelled");
    expect(run?.errorMessage).toMatch(/opted out/);

    // The actual guarantee this task exists for: not merely that the row
    // says cancelled, but that nothing reached the customer. Without
    // `seedWaitingAutomationRun`'s `send_message` step (post-review fix)
    // this would be vacuously true — there'd be nowhere for a message to
    // land even if cancellation were completely broken.
    const conversation = await t.run((ctx) =>
      ctx.db
        .query("conversations")
        .withIndex("by_contact", (q) => q.eq("contactId", contactId))
        .unique(),
    );
    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversation!._id))
        .collect(),
    );
    expect(messages).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("add with a non-do_not_contact outcome leaves the contact's waiting runs alone", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "agent",
    });
    const contactId = await asUser.mutation(api.contacts.create, { phone: "15550005002" });

    const parked = await seedWaitingAutomationRun(t, accountId, contactId);

    await asUser.mutation(api.contactNotes.add, {
      contactId,
      body: "Will call back Tuesday",
      outcome: "follow_up",
    });

    // Deliberately no `finishAllScheduledFunctions` here: this test is
    // about whether `add` itself reaches for cancellation (it must not),
    // not about what happens when the run's own 1-hour wait eventually
    // elapses on its own (it would legitimately run to completion and
    // send — an unrelated outcome this test isn't checking).
    const run = await t.run((ctx) => ctx.db.get(parked!._id));
    expect(run?.status).toBe("waiting");
  } finally {
    vi.useRealTimers();
  }
});

test("update's edit-into-do_not_contact cancels the contact's waiting automation runs", async () => {
  vi.useFakeTimers();
  try {
    process.env.CONVEX_META_DRY_RUN = "1";
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "agent",
    });
    const contactId = await asUser.mutation(api.contacts.create, { phone: "15550005003" });
    const noteId = await asUser.mutation(api.contactNotes.add, {
      contactId,
      body: "Rang, no answer",
      outcome: "no_answer",
    });

    const parked = await seedWaitingAutomationRun(t, accountId, contactId);
    expect(parked?.status).toBe("waiting");

    await asUser.mutation(api.contactNotes.update, { noteId, outcome: "do_not_contact" });
    // Same race, same fix as `add`'s own test above.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const run = await t.run((ctx) => ctx.db.get(parked!._id));
    expect(run?.status).toBe("cancelled");
    expect(run?.errorMessage).toMatch(/opted out/);

    // Same "did it actually reach the customer" guarantee as `add`'s own
    // test above.
    const conversation = await t.run((ctx) =>
      ctx.db
        .query("conversations")
        .withIndex("by_contact", (q) => q.eq("contactId", contactId))
        .unique(),
    );
    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversation!._id))
        .collect(),
    );
    expect(messages).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});
