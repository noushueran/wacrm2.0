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
// kbImport.{preview,apply} — parses the legacy `aiKnowledgeDocuments`
// corpus into v2 draft proposals. `preview` writes nothing; `apply`
// re-parses server-side (never trusts a client payload), lands every
// row as a DRAFT, and is idempotent — services match on key, entries on
// (serviceKey, title), ops on (serviceKey, kind). Legacy documents are
// never modified or deleted.
// ============================================================

const LEGACY_DOC = [
  "Dubai city breaks for families.",
  "",
  "QUALIFICATION CHECKLIST — Dubai Holiday Packages",
  "- Travel dates (40 marks)",
  "- Email address (60 marks)",
  "",
  "PURCHASE CRITERIA — Dubai Holiday Packages",
  "- Budget confirmed",
  "Report value: 6000 AED",
].join("\n");

test("preview reports without writing; apply creates drafts idempotently", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await t.run(async (ctx) => {
    await ctx.db.insert("aiKnowledgeDocuments", {
      accountId, title: "KB 2 — Dubai packages", content: LEGACY_DOC,
    });
  });
  const preview = await asUser.query(api.kbImport.preview, {});
  expect(preview.services).toEqual([
    { key: "dubai-holiday-packages", name: "Dubai Holiday Packages", exists: false },
  ]);
  expect(preview.opsBlocks).toHaveLength(2);
  expect(await asUser.query(api.kbServices.list, {})).toEqual([]);

  const first = await asUser.mutation(api.kbImport.apply, {});
  expect(first).toMatchObject({ servicesCreated: 1, entriesCreated: 1, opsCreated: 2 });
  const ops = await asUser.query(api.kbOps.get, {
    serviceKey: "dubai-holiday-packages", kind: "qualification",
  });
  expect(ops?.status).toBe("draft");
  expect(ops?.criteria).toEqual([
    { key: "travel-dates", label: "Travel dates", marks: 40 },
    { key: "email-address", label: "Email address", marks: 60 },
  ]);
  const purchase = await asUser.query(api.kbOps.get, {
    serviceKey: "dubai-holiday-packages", kind: "purchase",
  });
  expect(purchase?.reportValue).toBe(6000);

  const second = await asUser.mutation(api.kbImport.apply, {});
  expect(second).toMatchObject({ servicesCreated: 0, entriesCreated: 0, opsCreated: 0 });
});

test("company-wide sales checklist becomes an internal process entry", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await t.run(async (ctx) => {
    await ctx.db.insert("aiKnowledgeDocuments", {
      accountId, title: "KB 12 — Sales process",
      content: "Mandatory sales process.\n\nSALES CHECKLIST — All Services\n- Call the lead",
    });
  });
  await asUser.mutation(api.kbImport.apply, {});
  const entries = await asUser.query(api.kbEntries.list, {});
  const salesEntry = entries.find((e) => e.title === "SALES CHECKLIST — All Services");
  expect(salesEntry).toMatchObject({ scope: "company", type: "process", audience: "internal" });
  const overview = entries.find((e) => e.title === "KB 12 — Sales process");
  expect(overview?.audience).toBe("internal");
});
