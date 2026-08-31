import { convexTest, type TestConvex } from "convex-test";
import { expect, test } from "vitest";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import { applyAssignment } from "./assignment";

const modules = import.meta.glob("/convex/**/*.ts");

/** Account + two members + a contact + a conversation owned by nobody. */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const alice = await ctx.db.insert("users", { name: "Alice", email: "a@x.co" });
    const bob = await ctx.db.insert("users", { name: "Bob", email: "b@x.co" });
    const accountId = await ctx.db.insert("accounts", {
      name: "Acme", defaultCurrency: "AED", ownerUserId: alice,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000000", phoneNormalized: "971500000000",
      name: "Customer",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0, updatedAt: 1000,
    });
    return { alice, bob, accountId, contactId, conversationId };
  });
}

const eventsOf = (t: TestConvex<typeof schema>, conversationId: Id<"conversations">) =>
  t.run((ctx) =>
    ctx.db
      .query("conversationEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );

test("assigning an unowned conversation writes one 'assigned' event", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);

  const changed = await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    return await applyAssignment(ctx, {
      conversation,
      nextAssignee: s.bob,
      actorUserId: s.alice,
      source: "manual",
    });
  });

  expect(changed).toBe(true);
  const events = await eventsOf(t, s.conversationId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    accountId: s.accountId,
    contactId: s.contactId,
    kind: "assigned",
    actorUserId: s.alice,
    targetUserId: s.bob,
    source: "manual",
  });
  expect(events[0].previousUserId).toBeUndefined();

  const after = await t.run((ctx) => ctx.db.get(s.conversationId));
  expect(after!.assignedToUserId).toBe(s.bob);
});

test("re-saving the same assignee writes nothing and returns false", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await t.run((ctx) => ctx.db.patch(s.conversationId, { assignedToUserId: s.bob }));

  const changed = await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    return await applyAssignment(ctx, {
      conversation, nextAssignee: s.bob, actorUserId: s.alice, source: "manual",
    });
  });

  expect(changed).toBe(false);
  expect(await eventsOf(t, s.conversationId)).toHaveLength(0);
});

test("a reassignment records who held it before", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await t.run((ctx) => ctx.db.patch(s.conversationId, { assignedToUserId: s.alice }));

  await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    await applyAssignment(ctx, {
      conversation, nextAssignee: s.bob, actorUserId: s.alice, source: "manual",
    });
  });

  const events = await eventsOf(t, s.conversationId);
  expect(events[0]).toMatchObject({
    kind: "assigned", previousUserId: s.alice, targetUserId: s.bob,
  });
});

test("releasing writes 'unassigned' with no target and clears the field", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await t.run((ctx) => ctx.db.patch(s.conversationId, { assignedToUserId: s.bob }));

  const changed = await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    return await applyAssignment(ctx, {
      conversation, nextAssignee: undefined, source: "release",
    });
  });

  expect(changed).toBe(true);
  const events = await eventsOf(t, s.conversationId);
  expect(events[0]).toMatchObject({
    kind: "unassigned", previousUserId: s.bob, source: "release",
  });
  expect(events[0].targetUserId).toBeUndefined();
  expect(events[0].actorUserId).toBeUndefined();

  const after = await t.run((ctx) => ctx.db.get(s.conversationId));
  expect(after!.assignedToUserId).toBeUndefined();
});

test("unassigning an already-unowned conversation is a no-op", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);

  const changed = await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    return await applyAssignment(ctx, {
      conversation, nextAssignee: undefined, source: "manual",
    });
  });

  expect(changed).toBe(false);
  expect(await eventsOf(t, s.conversationId)).toHaveLength(0);
});

test("bumpUpdatedAt false leaves updatedAt alone", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);

  await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    await applyAssignment(ctx, {
      conversation, nextAssignee: s.bob, source: "automation", bumpUpdatedAt: false,
    });
  });

  const after = await t.run((ctx) => ctx.db.get(s.conversationId));
  expect(after!.updatedAt).toBe(1000);
  expect(after!.assignedToUserId).toBe(s.bob);
});

test("the helper never touches status", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);

  await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    await applyAssignment(ctx, {
      conversation, nextAssignee: s.bob, actorUserId: s.alice, source: "manual",
    });
  });

  const after = await t.run((ctx) => ctx.db.get(s.conversationId));
  expect(after!.status).toBe("open");
});
