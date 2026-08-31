import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import type { Id } from "../../_generated/dataModel";
import { resolveRouting } from "./routing";

const modules = import.meta.glob("/convex/**/*.ts");

// `accounts.ownerUserId` and `tags.color` are required by the schema, so
// they are supplied here even though routing never reads either. The
// owner user deliberately gets NO membership, so it can't be mistaken
// for an eligible team member.
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", { name: "Owner", email: "o@x.com" });
    const accountId = await ctx.db.insert("accounts", {
      name: "acct", defaultCurrency: "AED", ownerUserId: ownerId,
    });
    const agentId = await ctx.db.insert("users", { name: "Ann", email: "a@x.com" });
    await ctx.db.insert("memberships", {
      userId: agentId, accountId, role: "agent",
      fullName: "Ann", email: "a@x.com", phone: "+971500000001",
    });
    return { accountId, agentId };
  });
}

// `t.run` serializes whatever the callback returns as a Convex value, and
// a `Map` is not one — so the result is flattened to plain data INSIDE the
// run. Not a constraint on the helper itself: both real callers use
// `eligibleById` in-process (offerContext ranks against it and returns
// only the winning candidate), so the Map never crosses a Convex boundary.
function route(
  t: ReturnType<typeof convexTest>,
  args: { accountId: Id<"accounts">; serviceName: string | null },
) {
  return t.run(async (ctx) => {
    const r = await resolveRouting(ctx, args);
    return {
      poolIds: r.poolIds,
      fallback: r.fallback,
      eligibleIds: [...r.eligibleById.keys()],
    };
  });
}

test("no service name widens to the whole team", async () => {
  const t = convexTest(schema, modules);
  const { accountId, agentId } = await seed(t);
  const r = await route(t, { accountId, serviceName: null });
  expect(r.fallback).toBe("no_service_name");
  expect(r.poolIds).toEqual([agentId]);
});

test("an unknown service name reports tag_missing", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seed(t);
  const r = await route(t, { accountId, serviceName: "Nonexistent" });
  expect(r.fallback).toBe("tag_missing");
});

test("a tag with no memberTags links reports tag_unlinked", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seed(t);
  await t.run((ctx) =>
    ctx.db.insert("tags", { accountId, name: "UAE Visa", color: "#000000" }),
  );
  // Case-insensitive, trimmed match — the rule offerContext already used.
  const r = await route(t, { accountId, serviceName: "  uae visa  " });
  expect(r.fallback).toBe("tag_unlinked");
});

test("a linked, eligible agent routes with no fallback", async () => {
  const t = convexTest(schema, modules);
  const { accountId, agentId } = await seed(t);
  await t.run(async (ctx) => {
    const tagId = await ctx.db.insert("tags", {
      accountId, name: "UAE Visa", color: "#000000",
    });
    await ctx.db.insert("memberTags", { accountId, userId: agentId, tagId });
  });
  const r = await route(t, { accountId, serviceName: "UAE Visa" });
  expect(r.fallback).toBeNull();
  expect(r.poolIds).toEqual([agentId]);
});

test("a linked member with no phone reports links_ineligible", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seed(t);
  await t.run(async (ctx) => {
    const phoneless = await ctx.db.insert("users", { name: "Bob", email: "b@x.com" });
    await ctx.db.insert("memberships", {
      userId: phoneless, accountId, role: "agent", fullName: "Bob", email: "b@x.com",
    });
    const tagId = await ctx.db.insert("tags", {
      accountId, name: "Tours", color: "#000000",
    });
    await ctx.db.insert("memberTags", { accountId, userId: phoneless, tagId });
  });
  const r = await route(t, { accountId, serviceName: "Tours" });
  expect(r.fallback).toBe("links_ineligible");
});

// The role filter is load-bearing for `links_ineligible`'s documented
// remedy ("a role change, NOT another link"), so it is pinned here: a
// reachable admin is linked to the tag and still must not be routed to.
test("a linked admin with a phone is ineligible on role alone", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seed(t);
  await t.run(async (ctx) => {
    const adminId = await ctx.db.insert("users", { name: "Cat", email: "c@x.com" });
    await ctx.db.insert("memberships", {
      userId: adminId, accountId, role: "admin", fullName: "Cat", email: "c@x.com",
      phone: "+971500000002",
    });
    const tagId = await ctx.db.insert("tags", {
      accountId, name: "Tours", color: "#000000",
    });
    await ctx.db.insert("memberTags", { accountId, userId: adminId, tagId });
  });
  const r = await route(t, { accountId, serviceName: "Tours" });
  expect(r.fallback).toBe("links_ineligible");
  expect(r.eligibleIds).toHaveLength(1); // only the agent
});
