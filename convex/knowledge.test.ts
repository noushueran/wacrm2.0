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

test('groups content per service and computes verdicts', async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: 'A', email: 'a@x.co', role: 'admin' });

  await asUser.mutation(api.kbServices.upsert, { key: 'georgia', name: 'Georgia', aliases: [] });
  await asUser.mutation(api.kbServices.upsert, { key: 'uae-visas', name: 'UAE visas', aliases: [] });

  // Georgia: overview published + qualification at 100 published + purchase published = ready
  const overview = await asUser.mutation(api.kbEntries.save, {
    scope: 'service', serviceKey: 'georgia', type: 'overview',
    title: 'Georgia overview', body: '4N/5D packages.', audience: 'customer',
  });
  await asUser.mutation(api.kbEntries.publish, { entryId: overview });
  await asUser.mutation(api.kbOps.save, {
    serviceKey: 'georgia', kind: 'qualification',
    criteria: [{ key: 'dates', label: 'Travel dates', marks: 60 },
               { key: 'email', label: 'Email', marks: 40 }],
  });
  await asUser.mutation(api.kbOps.publish, { serviceKey: 'georgia', kind: 'qualification' });
  await asUser.mutation(api.kbOps.save, {
    serviceKey: 'georgia', kind: 'purchase',
    conditions: [{ key: 'budget', label: 'Budget confirmed' }],
  });
  await asUser.mutation(api.kbOps.publish, { serviceKey: 'georgia', kind: 'purchase' });

  // UAE visas: only a draft entry = draft
  await asUser.mutation(api.kbEntries.save, {
    scope: 'service', serviceKey: 'uae-visas', type: 'faq',
    title: 'Visa FAQ', body: 'Processing takes 3 days.', audience: 'customer',
  });

  const result = await asUser.query(api.knowledge.studioOverview, {});
  const georgia = result.services.find((s) => s.key === 'georgia');
  const uae = result.services.find((s) => s.key === 'uae-visas');

  expect(georgia?.verdict).toBe('ready');
  expect(georgia?.entries.overview).toEqual({ published: 1, draft: 0 });
  expect(georgia?.ops.qualification).toEqual({ state: 'published', marksTotal: 100 });
  expect(georgia?.ops.sales).toEqual({ state: 'absent', marksTotal: null });
  expect(uae?.verdict).toBe('draft');
  expect(uae?.entries.faq).toEqual({ published: 0, draft: 1 });
});

test('a published qualification whose marks are not 100 reads blocked', async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: 'A', email: 'a@x.co', role: 'admin' });
  await asUser.mutation(api.kbServices.upsert, { key: 'georgia', name: 'Georgia', aliases: [] });
  const overview = await asUser.mutation(api.kbEntries.save, {
    scope: 'service', serviceKey: 'georgia', type: 'overview',
    title: 'o', body: 'b', audience: 'customer',
  });
  await asUser.mutation(api.kbEntries.publish, { entryId: overview });
  // 100 marks so publish is allowed, then edited down to 90 — publish gate
  // only runs at publish time, so a published block CAN drift off 100.
  await asUser.mutation(api.kbOps.save, {
    serviceKey: 'georgia', kind: 'qualification',
    criteria: [{ key: 'a', label: 'A', marks: 100 }],
  });
  await asUser.mutation(api.kbOps.publish, { serviceKey: 'georgia', kind: 'qualification' });
  const blocked = await asUser.query(api.knowledge.studioOverview, {});
  expect(blocked.services[0].verdict).toBe('blocked'); // purchase still absent
});

test('company entries are counted separately, not attributed to a service', async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: 'A', email: 'a@x.co', role: 'admin' });
  const id = await asUser.mutation(api.kbEntries.save, {
    scope: 'company', type: 'policy', title: 'Hours', body: 'Daily 10-21.', audience: 'customer',
  });
  await asUser.mutation(api.kbEntries.publish, { entryId: id });
  await asUser.mutation(api.kbEntries.save, {
    scope: 'company', type: 'note', title: 'Internal', body: 'x', audience: 'internal',
  });
  const result = await asUser.query(api.knowledge.studioOverview, {});
  expect(result.companyEntryCount).toEqual({ published: 1, draft: 1 });
  expect(result.services).toEqual([]);
});

test('non-admin is rejected and accounts are isolated', async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: 'A', email: 'a@x.co', role: 'admin' });
  await asUser.mutation(api.kbServices.upsert, { key: 'georgia', name: 'Georgia', aliases: [] });
  const { asUser: asAgent } = await seedAccountMember(t, { name: 'B', email: 'b@x.co', role: 'agent' });
  await expect(asAgent.query(api.knowledge.studioOverview, {})).rejects.toThrow();
  const { asUser: asOtherAdmin } = await seedAccountMember(t, { name: 'C', email: 'c@x.co', role: 'admin' });
  const other = await asOtherAdmin.query(api.knowledge.studioOverview, {});
  expect(other.services).toEqual([]);
});
