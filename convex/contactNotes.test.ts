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
