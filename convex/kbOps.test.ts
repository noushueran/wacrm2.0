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
// kbOps.{get,listForAccount,save,publish,unpublish} — split lint gate:
// save blocks only on shape errors (label_required, key_duplicate) so a
// half-finished checklist can be saved as a draft; publish blocks on
// ALL error-level issues (including items_required/marks_sum), and both
// publish/unpublish schedule `internal.kbCompile.compileOps`.
// ============================================================

test("save upserts a draft; publish enforces marks_sum; unpublish demotes", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia", aliases: [] });
  await asUser.mutation(api.kbOps.save, {
    serviceKey: "georgia", kind: "qualification",
    criteria: [{ key: "dates", label: "Travel dates", marks: 50 }],
  });
  await expect(asUser.mutation(api.kbOps.publish, {
    serviceKey: "georgia", kind: "qualification",
  })).rejects.toThrow(/BAD_REQUEST/);
  await asUser.mutation(api.kbOps.save, {
    serviceKey: "georgia", kind: "qualification",
    criteria: [
      { key: "dates", label: "Travel dates", marks: 50 },
      { key: "email", label: "Email", marks: 50 },
    ],
  });
  await asUser.mutation(api.kbOps.publish, { serviceKey: "georgia", kind: "qualification" });
  let row = await asUser.query(api.kbOps.get, { serviceKey: "georgia", kind: "qualification" });
  expect(row?.status).toBe("published");
  expect(row?.version).toBe(2);
  await asUser.mutation(api.kbOps.unpublish, { serviceKey: "georgia", kind: "qualification" });
  row = await asUser.query(api.kbOps.get, { serviceKey: "georgia", kind: "qualification" });
  expect(row?.status).toBe("draft");
});

test("save against a missing service is NOT_FOUND; agent role rejected", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await expect(asUser.mutation(api.kbOps.save, {
    serviceKey: "ghost", kind: "sales", steps: [{ key: "s", label: "Step" }],
  })).rejects.toThrow(/NOT_FOUND/);
  const { asUser: asAgent } = await seedAccountMember(t, { name: "B", email: "b@x.co", role: "agent" });
  await expect(asAgent.mutation(api.kbOps.save, {
    serviceKey: "x", kind: "sales", steps: [],
  })).rejects.toThrow();
});

test("get and listForAccount are admin-gated — a viewer cannot read purchase criteria", async () => {
  const t = convexTest(schema, modules);
  // Ops blocks carry purchase criteria and `reportValue` — internal
  // commercial thresholds, same class of content `aiKnowledge.list`
  // gates on admin.
  const { asUser: asViewer } = await seedAccountMember(t, { name: "V", email: "v@x.co", role: "viewer" });
  await expect(asViewer.query(api.kbOps.get, {
    serviceKey: "georgia", kind: "purchase",
  })).rejects.toThrow(/FORBIDDEN/);
  await expect(asViewer.query(api.kbOps.listForAccount, {})).rejects.toThrow(/FORBIDDEN/);
});
