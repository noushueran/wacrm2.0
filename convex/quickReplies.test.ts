/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches
// `convex/contacts.test.ts`/`convex/reactions.test.ts` — see those
// files' comments for why this must be absolute rather than a relative
// "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated from `convex/contacts.test.ts` rather than
 * imported — each `convex/*.test.ts` suite owns its own copy of this
 * helper (see that file's own comment on `seedAccountMember`).
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
// create
// ============================================================

test("create inserts a text quick reply scoped to the caller's own account, from ctx — not from any client-supplied arg", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });

  const quickReplyId = await asUser.mutation(api.quickReplies.create, {
    title: "Greeting",
    kind: "text",
    contentText: "Hi, thanks for reaching out!",
  });

  const row = await t.run((ctx) => ctx.db.get(quickReplyId));
  expect(row).not.toBeNull();
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.title).toBe("Greeting");
  expect(row!.kind).toBe("text");
  expect(row!.contentText).toBe("Hi, thanks for reaching out!");
});

test("create round-trips an interactive quick reply's payload", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const payload = { type: "button", buttons: [{ id: "yes", title: "Yes" }] };

  const quickReplyId = await asUser.mutation(api.quickReplies.create, {
    title: "Confirm",
    kind: "interactive",
    interactivePayload: payload,
  });

  const row = await t.run((ctx) => ctx.db.get(quickReplyId));
  expect(row!.kind).toBe("interactive");
  expect(row!.interactivePayload).toEqual(payload);
});

test("create throws FORBIDDEN for a caller below the supervisor role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asUser.mutation(api.quickReplies.create, {
      title: "Greeting",
      kind: "text",
      contentText: "Hi!",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("supervisor can create a quick reply; agent cannot", async () => {
  const t = convexTest(schema, modules);
  const s = await seedAccountMember(t, {
    name: "Sup",
    email: "s@x.com",
    role: "supervisor",
  });
  await expect(
    s.asUser.mutation(api.quickReplies.create, {
      title: "Greeting",
      kind: "text",
      contentText: "Hi!",
    }),
  ).resolves.not.toBeNull();

  const ag = await seedAccountMember(t, {
    name: "Ag",
    email: "ag@x.com",
    role: "agent",
  });
  await expect(
    ag.asUser.mutation(api.quickReplies.create, {
      title: "Nope",
      kind: "text",
      contentText: "Nope!",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

// ============================================================
// list — account scoping + ordering
// ============================================================

test("list returns only the caller's own account's quick replies, newest-first", async () => {
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

  const first = await asAlice.mutation(api.quickReplies.create, {
    title: "First",
    kind: "text",
    contentText: "One",
  });
  const second = await asAlice.mutation(api.quickReplies.create, {
    title: "Second",
    kind: "text",
    contentText: "Two",
  });
  await asBob.mutation(api.quickReplies.create, {
    title: "Bob's",
    kind: "text",
    contentText: "Three",
  });

  const aliceList = await asAlice.query(api.quickReplies.list, {});
  expect(aliceList.map((row) => row._id)).toEqual([second, first]);

  const bobList = await asBob.query(api.quickReplies.list, {});
  expect(bobList).toHaveLength(1);
});

// ============================================================
// update — patch-only-provided-fields, ownership
// ============================================================

test("update patches only the supplied fields, leaving the rest untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const quickReplyId = await asUser.mutation(api.quickReplies.create, {
    title: "Greeting",
    kind: "text",
    contentText: "Hi!",
  });

  await asUser.mutation(api.quickReplies.update, {
    quickReplyId,
    contentText: "Hello there!",
  });

  const row = await t.run((ctx) => ctx.db.get(quickReplyId));
  expect(row!.title).toBe("Greeting"); // unchanged
  expect(row!.contentText).toBe("Hello there!");
});

test("update throws NOT_FOUND (not a silent no-op) for a different account's quick reply, and leaves it in place — the owning account can still update it", async () => {
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
  const quickReplyId = await asAlice.mutation(api.quickReplies.create, {
    title: "Greeting",
    kind: "text",
    contentText: "Hi!",
  });

  await expect(
    asBob.mutation(api.quickReplies.update, {
      quickReplyId,
      title: "Pwned",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "quickReply" } });
  const untouched = await t.run((ctx) => ctx.db.get(quickReplyId));
  expect(untouched!.title).toBe("Greeting");

  // Positive control — proves the throw above is really about
  // cross-account isolation, not a broken mutation.
  await asAlice.mutation(api.quickReplies.update, {
    quickReplyId,
    title: "Updated Greeting",
  });
  const updated = await t.run((ctx) => ctx.db.get(quickReplyId));
  expect(updated!.title).toBe("Updated Greeting");
});

// ============================================================
// remove
// ============================================================

test("remove throws NOT_FOUND (not a silent no-op) for a different account's quick reply, and leaves it in place — the owning account can still remove it", async () => {
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
  const quickReplyId = await asAlice.mutation(api.quickReplies.create, {
    title: "Greeting",
    kind: "text",
    contentText: "Hi!",
  });

  await expect(
    asBob.mutation(api.quickReplies.remove, { quickReplyId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "quickReply" } });
  expect(await t.run((ctx) => ctx.db.get(quickReplyId))).not.toBeNull();

  // Positive control.
  await asAlice.mutation(api.quickReplies.remove, { quickReplyId });
  expect(await t.run((ctx) => ctx.db.get(quickReplyId))).toBeNull();
});
