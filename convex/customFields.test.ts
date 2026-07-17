/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { ConvexError } from "convex/values";
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
// list — account isolation + fieldName ordering
// ============================================================

test("list returns the account's custom fields ordered by fieldName, and never returns another account's fields", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  // Inserted out of alphabetical order, so a passing test actually
  // proves sorting rather than coincidental insertion order.
  await asAlice.mutation(api.customFields.create, {
    fieldName: "Zip Code",
    fieldType: "text",
  });
  await asAlice.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });
  await asBob.mutation(api.customFields.create, {
    fieldName: "Only Bob's",
    fieldType: "text",
  });

  const alicesView = await asAlice.query(api.customFields.list, {});
  expect(alicesView.map((f) => f.fieldName)).toEqual(["Birthday", "Zip Code"]);

  const bobsView = await asBob.query(api.customFields.list, {});
  expect(bobsView).toHaveLength(1);
  expect(bobsView[0]!.fieldName).toBe("Only Bob's");
});

// ============================================================
// create
// ============================================================

test("create inserts a custom field scoped to the caller's own account, from ctx", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const fieldId = await asUser.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });

  const row = await t.run((ctx) => ctx.db.get(fieldId));
  expect(row).not.toBeNull();
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.fieldName).toBe("Birthday");
  expect(row!.fieldType).toBe("text");
});

test("create throws FORBIDDEN for a caller below the supervisor role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    asUser.mutation(api.customFields.create, {
      fieldName: "Birthday",
      fieldType: "text",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("supervisor can create a custom field; agent cannot", async () => {
  const t = convexTest(schema, modules);
  const s = await seedAccountMember(t, {
    name: "Sup",
    email: "s@x.com",
    role: "supervisor",
  });
  await expect(
    s.asUser.mutation(api.customFields.create, {
      fieldName: "Birthday",
      fieldType: "text",
    }),
  ).resolves.not.toBeNull();

  const ag = await seedAccountMember(t, {
    name: "Ag",
    email: "ag@x.com",
    role: "agent",
  });
  await expect(
    ag.asUser.mutation(api.customFields.create, {
      fieldName: "Nope",
      fieldType: "text",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("create throws DUPLICATE_FIELD for a case-insensitive name clash in the same account", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const firstId = await asUser.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });

  const error: unknown = await asUser
    .mutation(api.customFields.create, {
      fieldName: "BIRTHDAY", // same name, different case
      fieldType: "text",
    })
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: unknown }).data).toEqual({
    code: "DUPLICATE_FIELD",
    fieldId: firstId,
  });

  const all = await t.run((ctx) => ctx.db.query("customFields").collect());
  expect(all).toHaveLength(1);
});

test("create allows the same field name across two different accounts", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const aliceFieldId = await asAlice.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });
  const bobFieldId = await asBob.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });

  expect(aliceFieldId).not.toBe(bobFieldId);
});

// ============================================================
// rename
// ============================================================

test("rename changes fieldName, rejects a case-insensitive clash with another field (leaving it unmodified), then succeeds with a free name", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const birthdayId = await asUser.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });
  await asUser.mutation(api.customFields.create, {
    fieldName: "Zip Code",
    fieldType: "text",
  });

  const error: unknown = await asUser
    .mutation(api.customFields.rename, {
      fieldId: birthdayId,
      fieldName: "ZIP CODE", // clashes with "Zip Code" case-insensitively
    })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: unknown }).data).toMatchObject({
    code: "DUPLICATE_FIELD",
  });

  const untouched = await t.run((ctx) => ctx.db.get(birthdayId));
  expect(untouched!.fieldName).toBe("Birthday");

  await asUser.mutation(api.customFields.rename, {
    fieldId: birthdayId,
    fieldName: "DOB",
  });
  const renamed = await t.run((ctx) => ctx.db.get(birthdayId));
  expect(renamed!.fieldName).toBe("DOB");
});

test("rename throws NOT_FOUND for a field belonging to a different account, and leaves it unmodified", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const aliceFieldId = await asAlice.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });

  await expect(
    asBob.mutation(api.customFields.rename, {
      fieldId: aliceFieldId,
      fieldName: "Hijacked",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "customField" } });

  const untouched = await t.run((ctx) => ctx.db.get(aliceFieldId));
  expect(untouched!.fieldName).toBe("Birthday");

  // Positive control.
  await asAlice.mutation(api.customFields.rename, {
    fieldId: aliceFieldId,
    fieldName: "DOB",
  });
  const renamed = await t.run((ctx) => ctx.db.get(aliceFieldId));
  expect(renamed!.fieldName).toBe("DOB");
});

// ============================================================
// remove — cascades contactCustomValues
// ============================================================

test("remove deletes the field and cascades: deletes every contactCustomValues row referencing it, across contacts", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const fieldId = await asUser.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });
  const otherFieldId = await asUser.mutation(api.customFields.create, {
    fieldName: "Zip Code",
    fieldType: "text",
  });
  const contact1 = await asUser.mutation(api.contacts.create, { phone: "1" });
  const contact2 = await asUser.mutation(api.contacts.create, { phone: "2" });

  await asUser.mutation(api.customFields.setForContact, {
    contactId: contact1,
    values: [
      { customFieldId: fieldId, value: "1990-01-01" },
      { customFieldId: otherFieldId, value: "11111" },
    ],
  });
  await asUser.mutation(api.customFields.setForContact, {
    contactId: contact2,
    values: [{ customFieldId: fieldId, value: "1991-02-02" }],
  });

  await asUser.mutation(api.customFields.remove, { fieldId });

  expect(await t.run((ctx) => ctx.db.get(fieldId))).toBeNull();

  const remainingValues = await t.run((ctx) =>
    ctx.db.query("contactCustomValues").collect(),
  );
  // Only the untouched `otherFieldId` value on contact1 survives.
  expect(remainingValues).toHaveLength(1);
  expect(remainingValues[0]!.customFieldId).toBe(otherFieldId);
  expect(remainingValues[0]!.contactId).toBe(contact1);

  // The other field itself (not the one removed) is untouched.
  expect(await t.run((ctx) => ctx.db.get(otherFieldId))).not.toBeNull();
});

test("remove throws NOT_FOUND for a field belonging to a different account, and leaves it (and its values) in place", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const aliceFieldId = await asAlice.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "1",
  });
  await asAlice.mutation(api.customFields.setForContact, {
    contactId: aliceContactId,
    values: [{ customFieldId: aliceFieldId, value: "1990-01-01" }],
  });

  await expect(
    asBob.mutation(api.customFields.remove, { fieldId: aliceFieldId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "customField" } });

  expect(await t.run((ctx) => ctx.db.get(aliceFieldId))).not.toBeNull();
  const stillThere = await t.run((ctx) =>
    ctx.db.query("contactCustomValues").collect(),
  );
  expect(stillThere).toHaveLength(1);

  // Positive control.
  await asAlice.mutation(api.customFields.remove, { fieldId: aliceFieldId });
  expect(await t.run((ctx) => ctx.db.get(aliceFieldId))).toBeNull();
});

// ============================================================
// getForContact
// ============================================================

test("getForContact returns only this contact's custom values", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const fieldId = await asUser.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });
  const contact1 = await asUser.mutation(api.contacts.create, { phone: "1" });
  const contact2 = await asUser.mutation(api.contacts.create, { phone: "2" });

  await asUser.mutation(api.customFields.setForContact, {
    contactId: contact1,
    values: [{ customFieldId: fieldId, value: "1990-01-01" }],
  });

  const contact1Values = await asUser.query(api.customFields.getForContact, {
    contactId: contact1,
  });
  expect(contact1Values).toHaveLength(1);
  expect(contact1Values[0]!.value).toBe("1990-01-01");

  const contact2Values = await asUser.query(api.customFields.getForContact, {
    contactId: contact2,
  });
  expect(contact2Values).toEqual([]);
});

test("getForContact throws NOT_FOUND when the contact belongs to a different account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "1",
  });

  await expect(
    asBob.query(api.customFields.getForContact, {
      contactId: aliceContactId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  // Positive control.
  await expect(
    asAlice.query(api.customFields.getForContact, {
      contactId: aliceContactId,
    }),
  ).resolves.toEqual([]);
});

// ============================================================
// setForContact — replace-all + cross-account denial
// ============================================================

test("setForContact replace-all: setting {A:x, B:y} then {A:z} leaves only A=z (B removed)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const fieldA = await asUser.mutation(api.customFields.create, {
    fieldName: "A",
    fieldType: "text",
  });
  const fieldB = await asUser.mutation(api.customFields.create, {
    fieldName: "B",
    fieldType: "text",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  await asUser.mutation(api.customFields.setForContact, {
    contactId,
    values: [
      { customFieldId: fieldA, value: "x" },
      { customFieldId: fieldB, value: "y" },
    ],
  });
  const afterFirstSet = await asUser.query(api.customFields.getForContact, {
    contactId,
  });
  expect(afterFirstSet).toHaveLength(2);

  await asUser.mutation(api.customFields.setForContact, {
    contactId,
    values: [{ customFieldId: fieldA, value: "z" }],
  });
  const afterSecondSet = await asUser.query(api.customFields.getForContact, {
    contactId,
  });

  expect(afterSecondSet).toHaveLength(1);
  expect(afterSecondSet[0]!.customFieldId).toBe(fieldA);
  expect(afterSecondSet[0]!.value).toBe("z");
});

test("setForContact omits empty-string (and whitespace-only) values", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const fieldA = await asUser.mutation(api.customFields.create, {
    fieldName: "A",
    fieldType: "text",
  });
  const fieldB = await asUser.mutation(api.customFields.create, {
    fieldName: "B",
    fieldType: "text",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  await asUser.mutation(api.customFields.setForContact, {
    contactId,
    values: [
      { customFieldId: fieldA, value: "   " },
      { customFieldId: fieldB, value: "kept" },
    ],
  });

  const values = await asUser.query(api.customFields.getForContact, {
    contactId,
  });
  expect(values).toHaveLength(1);
  expect(values[0]!.customFieldId).toBe(fieldB);
  expect(values[0]!.value).toBe("kept");
});

test("setForContact throws FORBIDDEN for a caller below the agent role (role check runs before any ownership check)", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAdmin } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asViewer } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });
  const contactId = await asAdmin.mutation(api.contacts.create, {
    phone: "1",
  });

  await expect(
    asViewer.mutation(api.customFields.setForContact, {
      contactId,
      values: [],
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("setForContact throws NOT_FOUND when contactId belongs to a different account, and leaves existing values unmodified", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const aliceFieldId = await asAlice.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "1",
  });
  await asAlice.mutation(api.customFields.setForContact, {
    contactId: aliceContactId,
    values: [{ customFieldId: aliceFieldId, value: "1990-01-01" }],
  });

  const bobFieldId = await asBob.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });

  await expect(
    asBob.mutation(api.customFields.setForContact, {
      contactId: aliceContactId,
      values: [{ customFieldId: bobFieldId, value: "pwned" }],
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  const untouched = await asAlice.query(api.customFields.getForContact, {
    contactId: aliceContactId,
  });
  expect(untouched).toHaveLength(1);
  expect(untouched[0]!.value).toBe("1990-01-01");
});

test("setForContact rejects a customFieldId belonging to a different account, and leaves existing values unmodified", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });

  const aliceFieldId = await asAlice.mutation(api.customFields.create, {
    fieldName: "Birthday",
    fieldType: "text",
  });
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "1",
  });
  await asAlice.mutation(api.customFields.setForContact, {
    contactId: aliceContactId,
    values: [{ customFieldId: aliceFieldId, value: "1990-01-01" }],
  });

  const bobFieldId = await asBob.mutation(api.customFields.create, {
    fieldName: "Nickname",
    fieldType: "text",
  });

  // Alice's own contact, but Bob's real customFieldId smuggled in.
  await expect(
    asAlice.mutation(api.customFields.setForContact, {
      contactId: aliceContactId,
      values: [{ customFieldId: bobFieldId, value: "pwned" }],
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "customField" } });

  // Untouched — every customFieldId is validated before the replace-all
  // delete runs, so a foreign id partway through must leave the
  // contact's existing values exactly as they were.
  const untouched = await asAlice.query(api.customFields.getForContact, {
    contactId: aliceContactId,
  });
  expect(untouched).toHaveLength(1);
  expect(untouched[0]!.value).toBe("1990-01-01");
});

test("setForContact last-value-wins when the same customFieldId appears twice in one call", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const fieldA = await asUser.mutation(api.customFields.create, {
    fieldName: "A",
    fieldType: "text",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  await asUser.mutation(api.customFields.setForContact, {
    contactId,
    values: [
      { customFieldId: fieldA, value: "first" },
      { customFieldId: fieldA, value: "second" },
    ],
  });

  const values = await asUser.query(api.customFields.getForContact, {
    contactId,
  });
  expect(values).toHaveLength(1);
  expect(values[0]!.value).toBe("second");
});

// ============================================================
// Task 5: Typed fields — options + validation
// ============================================================

test("create stores options for a select field", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Sup", email: "cf1@x.com", role: "supervisor" });
  const fid = await asUser.mutation(api.customFields.create, {
    fieldName: "Product Category",
    fieldType: "select",
    fieldOptions: { options: ["UAE Visa", "Global Visa", "Packages"] },
  });
  const row = await t.run((ctx) => ctx.db.get(fid));
  expect(row!.fieldType).toBe("select");
  expect(row!.fieldOptions).toEqual({ options: ["UAE Visa", "Global Visa", "Packages"] });
});

test("setForContact accepts a valid select value and rejects an off-list one", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Sup", email: "cf2@x.com", role: "supervisor" });
  const fid = await asUser.mutation(api.customFields.create, {
    fieldName: "Product Category", fieldType: "select",
    fieldOptions: { options: ["UAE Visa", "Packages"] },
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+15550003", phoneNormalized: "15550003" }),
  );

  await asUser.mutation(api.customFields.setForContact, {
    contactId, values: [{ customFieldId: fid, value: "Packages" }],
  });
  const stored = await asUser.query(api.customFields.getForContact, { contactId });
  expect(stored.map((s) => s.value)).toEqual(["Packages"]);

  await expect(
    asUser.mutation(api.customFields.setForContact, {
      contactId, values: [{ customFieldId: fid, value: "Cruise" }],
    }),
  ).rejects.toMatchObject({ data: { code: "INVALID_VALUE" } });
});

test("update switches a field to a new type + options", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Sup", email: "cf3@x.com", role: "supervisor" });
  const fid = await asUser.mutation(api.customFields.create, { fieldName: "Budget", fieldType: "text" });
  await asUser.mutation(api.customFields.update, { fieldId: fid, fieldType: "select", fieldOptions: { options: ["A", "B"] } });
  const row = await t.run((ctx) => ctx.db.get(fid));
  expect(row!.fieldType).toBe("select");
  expect(row!.fieldOptions).toEqual({ options: ["A", "B"] });
});
