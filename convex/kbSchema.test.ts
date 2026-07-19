/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("/convex/**/*.ts");

test("kb tables accept a minimal row each", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "o", email: "o@x.co" });
    const accountId = await ctx.db.insert("accounts", {
      name: "acct", defaultCurrency: "USD", ownerUserId: userId,
    });
    const now = Date.now();
    await ctx.db.insert("kbServices", {
      accountId, key: "georgia-tours", name: "Georgia Holiday Packages",
      aliases: ["georgia", "tbilisi"], status: "active", sortOrder: 0, updatedAt: now,
    });
    const entryId = await ctx.db.insert("kbEntries", {
      accountId, scope: "service", serviceKey: "georgia-tours", type: "overview",
      title: "Georgia overview", body: "4N/5D packages.", audience: "customer",
      status: "draft", version: 1, updatedAt: now,
    });
    const opsId = await ctx.db.insert("kbOpsBlocks", {
      accountId, serviceKey: "georgia-tours", kind: "qualification",
      criteria: [{ key: "dates", label: "Travel dates", marks: 20 }],
      status: "draft", version: 1, updatedAt: now,
    });
    await ctx.db.insert("kbChunks", {
      accountId, sourceKind: "entry", entryId, serviceKey: "georgia-tours",
      entryType: "overview", audience: "customer", chunkIndex: 0,
      content: "[Georgia Holiday Packages — Georgia overview]\n4N/5D packages.",
    });
    const byKey = await ctx.db.query("kbServices")
      .withIndex("by_account_key", (q) => q.eq("accountId", accountId).eq("key", "georgia-tours"))
      .unique();
    expect(byKey?.name).toBe("Georgia Holiday Packages");
    const ops = await ctx.db.query("kbOpsBlocks")
      .withIndex("by_account_service_kind", (q) =>
        q.eq("accountId", accountId).eq("serviceKey", "georgia-tours").eq("kind", "qualification"))
      .unique();
    expect(ops?._id).toBe(opsId);
  });
});
