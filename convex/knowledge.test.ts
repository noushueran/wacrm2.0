/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches every
// other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported — see
 * `convex/aiConfig.test.ts`'s own comment on this pattern.
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
// knowledge.studioOverview — read model for the Knowledge Studio landing
// view. Groups kbEntries/kbOpsBlocks per service, computes a readiness
// verdict per service, and separates company-scoped entries out.
// ============================================================

test("groups content per service and computes verdicts", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });

  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia", aliases: [] });
  await asUser.mutation(api.kbServices.upsert, { key: "uae-visas", name: "UAE visas", aliases: [] });

  // Georgia: overview published + qualification at 100 published + purchase published = ready
  const overview = await asUser.mutation(api.kbEntries.save, {
    scope: "service", serviceKey: "georgia", type: "overview",
    title: "Georgia overview", body: "4N/5D packages.", audience: "customer",
  });
  await asUser.mutation(api.kbEntries.publish, { entryId: overview });
  await asUser.mutation(api.kbOps.save, {
    serviceKey: "georgia", kind: "qualification",
    criteria: [{ key: "dates", label: "Travel dates", marks: 60 },
               { key: "email", label: "Email", marks: 40 }],
  });
  await asUser.mutation(api.kbOps.publish, { serviceKey: "georgia", kind: "qualification" });
  await asUser.mutation(api.kbOps.save, {
    serviceKey: "georgia", kind: "purchase",
    conditions: [{ key: "budget", label: "Budget confirmed" }],
  });
  await asUser.mutation(api.kbOps.publish, { serviceKey: "georgia", kind: "purchase" });

  // UAE visas: only a draft entry = draft
  await asUser.mutation(api.kbEntries.save, {
    scope: "service", serviceKey: "uae-visas", type: "faq",
    title: "Visa FAQ", body: "Processing takes 3 days.", audience: "customer",
  });

  const result = await asUser.query(api.knowledge.studioOverview, {});
  const georgia = result.services.find((s) => s.key === "georgia");
  const uae = result.services.find((s) => s.key === "uae-visas");

  expect(georgia?.verdict).toBe("ready");
  expect(georgia?.entries.overview).toEqual({ published: 1, draft: 0 });
  expect(georgia?.ops.qualification).toEqual({ state: "published", marksTotal: 100 });
  expect(georgia?.ops.sales).toEqual({ state: "absent", marksTotal: null });
  expect(uae?.verdict).toBe("draft");
  expect(uae?.entries.faq).toEqual({ published: 0, draft: 1 });
});

test("editing a published qualification checklist's marks demotes it to draft and blocks readiness", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia", aliases: [] });
  const overview = await asUser.mutation(api.kbEntries.save, {
    scope: "service", serviceKey: "georgia", type: "overview",
    title: "o", body: "b", audience: "customer",
  });
  await asUser.mutation(api.kbEntries.publish, { entryId: overview });
  await asUser.mutation(api.kbOps.save, {
    serviceKey: "georgia", kind: "qualification",
    criteria: [{ key: "a", label: "A", marks: 100 }],
  });
  await asUser.mutation(api.kbOps.publish, { serviceKey: "georgia", kind: "qualification" });
  // `kbOps.save` on an EXISTING block always writes `status: "draft"`
  // (see convex/kbOps.ts's `save` handler — the `fields` object it patches
  // with is unconditionally `status: "draft"`), regardless of the row's
  // prior state. So editing a published checklist's marks demotes it back
  // to draft in the same call rather than leaving it published with a
  // drifted total — both the demoted state and the new 90 total
  // independently block readiness.
  await asUser.mutation(api.kbOps.save, {
    serviceKey: "georgia", kind: "qualification",
    criteria: [{ key: "a", label: "A", marks: 90 }],
  });
  const result = await asUser.query(api.knowledge.studioOverview, {});
  const georgia = result.services.find((s) => s.key === "georgia");
  expect(georgia?.ops.qualification).toEqual({ state: "draft", marksTotal: 90 });
  expect(georgia?.verdict).toBe("blocked");
});

test("company entries are counted separately, not attributed to a service", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia", aliases: [] });
  const id = await asUser.mutation(api.kbEntries.save, {
    scope: "company", type: "policy", title: "Hours", body: "Daily 10-21.", audience: "customer",
  });
  await asUser.mutation(api.kbEntries.publish, { entryId: id });
  await asUser.mutation(api.kbEntries.save, {
    scope: "company", type: "note", title: "Internal", body: "x", audience: "internal",
  });
  const result = await asUser.query(api.knowledge.studioOverview, {});
  const georgia = result.services.find((s) => s.key === "georgia");
  expect(result.companyEntryCount).toEqual({ published: 1, draft: 1 });
  expect(result.services).toHaveLength(1);
  expect(georgia?.entries).toEqual({
    overview: { published: 0, draft: 0 },
    faq: { published: 0, draft: 0 },
    itinerary: { published: 0, draft: 0 },
    requirements: { published: 0, draft: 0 },
    policy: { published: 0, draft: 0 },
    process: { published: 0, draft: 0 },
    note: { published: 0, draft: 0 },
  });
});

test("non-admin is rejected and accounts are isolated", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia", aliases: [] });
  const { asUser: asAgent } = await seedAccountMember(t, { name: "B", email: "b@x.co", role: "agent" });
  await expect(asAgent.query(api.knowledge.studioOverview, {})).rejects.toThrow();
  const { asUser: asOtherAdmin } = await seedAccountMember(t, { name: "C", email: "c@x.co", role: "admin" });
  const other = await asOtherAdmin.query(api.knowledge.studioOverview, {});
  expect(other.services).toEqual([]);
});
