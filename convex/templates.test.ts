/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";
import { normalizeTemplateStatus } from "./templates";

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

const baseTemplate = {
  name: "welcome",
  language: "en_US",
  category: "Marketing" as const,
  bodyText: "Hello {{1}}",
};

// ============================================================
// upsert — find-or-create keyed by (accountId, name, language)
// ============================================================

test("upsert inserts a template scoped to the caller's own account, from ctx — not from any client-supplied arg", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });

  const templateId = await asUser.mutation(api.templates.upsert, baseTemplate);

  const row = await t.run((ctx) => ctx.db.get(templateId));
  expect(row).not.toBeNull();
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.name).toBe("welcome");
  expect(row!.language).toBe("en_US");
  expect(row!.category).toBe("Marketing");
  expect(row!.bodyText).toBe("Hello {{1}}");
});

test("upsert throws FORBIDDEN for a caller below the supervisor role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asUser.mutation(api.templates.upsert, baseTemplate),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("supervisor can upsert a template; agent cannot", async () => {
  const t = convexTest(schema, modules);
  const s = await seedAccountMember(t, {
    name: "Sup",
    email: "s@x.com",
    role: "supervisor",
  });
  await expect(
    s.asUser.mutation(api.templates.upsert, baseTemplate),
  ).resolves.not.toBeNull();

  const ag = await seedAccountMember(t, {
    name: "Ag",
    email: "ag@x.com",
    role: "agent",
  });
  await expect(
    ag.asUser.mutation(api.templates.upsert, { ...baseTemplate, name: "other" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("upsert with the same (name, language) patches the existing row instead of creating a duplicate", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });

  const firstId = await asUser.mutation(api.templates.upsert, baseTemplate);
  const secondId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    bodyText: "Hi {{1}}, welcome aboard!",
    status: "PENDING",
    metaTemplateId: "wamid-abc",
  });

  expect(secondId).toBe(firstId);

  const all = await t.run((ctx) => ctx.db.query("messageTemplates").collect());
  expect(all).toHaveLength(1);
  expect(all[0]!.bodyText).toBe("Hi {{1}}, welcome aboard!");
  expect(all[0]!.status).toBe("PENDING");
  expect(all[0]!.metaTemplateId).toBe("wamid-abc");
});

test("upsert treats a different language as a distinct template within the same account", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });

  const enId = await asUser.mutation(api.templates.upsert, baseTemplate);
  const ltId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    language: "lt",
    bodyText: "Sveiki {{1}}",
  });

  expect(ltId).not.toBe(enId);
  const all = await t.run((ctx) => ctx.db.query("messageTemplates").collect());
  expect(all).toHaveLength(2);
});

test("upsert creates a separate row per account for the same (name, language)", async () => {
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

  const aliceId = await asAlice.mutation(api.templates.upsert, baseTemplate);
  const bobId = await asBob.mutation(api.templates.upsert, baseTemplate);

  expect(aliceId).not.toBe(bobId);
  const all = await t.run((ctx) => ctx.db.query("messageTemplates").collect());
  expect(all).toHaveLength(2);
});

// ============================================================
// get / list — ownership and account scoping
// ============================================================

test("get returns the caller's own template and throws NOT_FOUND for a different account's", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  // `get` is a plain read with no role floor of its own (unlike
  // `upsert`), so Bob stays "agent" here — only Alice's `upsert` call
  // below needs the new supervisor floor.
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const templateId = await asAlice.mutation(api.templates.upsert, baseTemplate);

  const row = await asAlice.query(api.templates.get, { templateId });
  expect(row._id).toBe(templateId);

  await expect(
    asBob.query(api.templates.get, { templateId }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "messageTemplate" },
  });
});

test("list returns only the caller's own account's templates, newest-first", async () => {
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

  const first = await asAlice.mutation(api.templates.upsert, {
    ...baseTemplate,
    name: "first",
  });
  const second = await asAlice.mutation(api.templates.upsert, {
    ...baseTemplate,
    name: "second",
  });
  await asBob.mutation(api.templates.upsert, baseTemplate);

  const aliceList = await asAlice.query(api.templates.list, {});
  expect(aliceList.map((row) => row._id)).toEqual([second, first]);

  const bobList = await asBob.query(api.templates.list, {});
  expect(bobList).toHaveLength(1);
});

// ============================================================
// remove
// ============================================================

test("remove throws NOT_FOUND (not a silent no-op) for a different account's template, and leaves it in place — the owning account can still remove it", async () => {
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
  const templateId = await asAlice.mutation(api.templates.upsert, baseTemplate);

  await expect(
    asBob.mutation(api.templates.remove, { templateId }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "messageTemplate" },
  });
  expect(await t.run((ctx) => ctx.db.get(templateId))).not.toBeNull();

  // Positive control — proves the throw above is really about
  // cross-account isolation, not a broken mutation.
  await asAlice.mutation(api.templates.remove, { templateId });
  expect(await t.run((ctx) => ctx.db.get(templateId))).toBeNull();
});

// ============================================================
// updateStatusByMetaId
// ============================================================

test("updateStatusByMetaId patches only the caller's own account's row when two accounts share the same metaTemplateId", async () => {
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

  // Contrived: Meta template ids are globally unique per WABA in
  // practice, but nothing in this schema enforces that across two
  // unrelated accounts — this is exactly the scenario the isolation
  // guarantee must hold for.
  const aliceTemplateId = await asAlice.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "PENDING",
    metaTemplateId: "shared-meta-id",
    submissionError: "earlier transient failure",
  });
  const bobTemplateId = await asBob.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "PENDING",
    metaTemplateId: "shared-meta-id",
  });

  const returnedId = await asAlice.mutation(api.templates.updateStatusByMetaId, {
    metaTemplateId: "shared-meta-id",
    status: "APPROVED",
    qualityScore: "GREEN",
  });
  expect(returnedId).toBe(aliceTemplateId);

  const aliceRow = await t.run((ctx) => ctx.db.get(aliceTemplateId));
  expect(aliceRow!.status).toBe("APPROVED");
  expect(aliceRow!.qualityScore).toBe("GREEN");
  expect(aliceRow!.rejectionReason).toBeUndefined();
  expect(aliceRow!.submissionError).toBeUndefined(); // cleared

  const bobRow = await t.run((ctx) => ctx.db.get(bobTemplateId));
  expect(bobRow!.status).toBe("PENDING"); // untouched
  expect(bobRow!.qualityScore).toBeUndefined();
});

test("updateStatusByMetaId sets rejectionReason on REJECTED and preserves a previously recorded qualityScore when a later call omits it", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const templateId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    metaTemplateId: "meta-1",
  });

  await asUser.mutation(api.templates.updateStatusByMetaId, {
    metaTemplateId: "meta-1",
    status: "APPROVED",
    qualityScore: "GREEN",
  });
  await asUser.mutation(api.templates.updateStatusByMetaId, {
    metaTemplateId: "meta-1",
    status: "REJECTED",
    rejectionReason: "Sample content violates policy",
  });

  const row = await t.run((ctx) => ctx.db.get(templateId));
  expect(row!.status).toBe("REJECTED");
  expect(row!.rejectionReason).toBe("Sample content violates policy");
  expect(row!.qualityScore).toBe("GREEN"); // preserved, not cleared by the omission
});

test("updateStatusByMetaId throws NOT_FOUND when no template in the caller's own account has that metaTemplateId", async () => {
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
  await asBob.mutation(api.templates.upsert, {
    ...baseTemplate,
    metaTemplateId: "bobs-only-id",
  });

  await expect(
    asAlice.mutation(api.templates.updateStatusByMetaId, {
      metaTemplateId: "bobs-only-id",
      status: "APPROVED",
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "messageTemplate" },
  });

  // Positive control — Alice succeeds against her own row, proving the
  // throw above is really about isolation, not a broken mutation.
  const aliceTemplateId = await asAlice.mutation(api.templates.upsert, {
    ...baseTemplate,
    metaTemplateId: "alices-id",
  });
  await asAlice.mutation(api.templates.updateStatusByMetaId, {
    metaTemplateId: "alices-id",
    status: "APPROVED",
  });
  const row = await t.run((ctx) => ctx.db.get(aliceTemplateId));
  expect(row!.status).toBe("APPROVED");
});

// ============================================================
// normalizeTemplateStatus — pure function, direct unit test (ported
// from src/lib/whatsapp/template-status-normalize.ts's own dedicated
// test file), mirrors updateStatusByMetaId's own statusValidator enum
// ============================================================

test("normalizeTemplateStatus passes through known Meta statuses verbatim, uppercasing lowercase input", () => {
  expect(normalizeTemplateStatus("APPROVED")).toBe("APPROVED");
  expect(normalizeTemplateStatus("PAUSED")).toBe("PAUSED");
  expect(normalizeTemplateStatus("IN_APPEAL")).toBe("IN_APPEAL");
  expect(normalizeTemplateStatus("approved")).toBe("APPROVED");
});

test("normalizeTemplateStatus maps PENDING_REVIEW to PENDING and falls back to PENDING for anything unrecognised", () => {
  expect(normalizeTemplateStatus("PENDING_REVIEW")).toBe("PENDING");
  expect(normalizeTemplateStatus("SOMETHING_NEW")).toBe("PENDING");
  expect(normalizeTemplateStatus("")).toBe("PENDING");
});

// ============================================================
// applyMetaStatusWebhook — Meta template-lifecycle webhook handler
// (Phase 8, Task 4), ported from src/lib/whatsapp/template-webhook.ts's
// handleStatusUpdate
// ============================================================

test("applyMetaStatusWebhook flips status to APPROVED and clears any rejectionReason/submissionError", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const templateId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "REJECTED",
    metaTemplateId: "12345",
    submissionError: "earlier transient failure",
  });
  await t.run((ctx) => ctx.db.patch(templateId, { rejectionReason: "stale reason" }));

  await t.mutation(internal.templates.applyMetaStatusWebhook, {
    metaTemplateId: "12345",
    event: "APPROVED",
  });

  const row = await t.run((ctx) => ctx.db.get(templateId));
  expect(row!.status).toBe("APPROVED");
  expect(row!.rejectionReason).toBeUndefined();
  expect(row!.submissionError).toBeUndefined();
});

test("applyMetaStatusWebhook persists the reason field on REJECTED, falling back to a generic message when Meta sends none", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const templateId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    metaTemplateId: "TMPL_99",
  });

  await t.mutation(internal.templates.applyMetaStatusWebhook, {
    metaTemplateId: "TMPL_99",
    event: "REJECTED",
    reason: "Template uses non-compliant language.",
  });
  let row = await t.run((ctx) => ctx.db.get(templateId));
  expect(row!.status).toBe("REJECTED");
  expect(row!.rejectionReason).toBe("Template uses non-compliant language.");

  // A later REJECTED with no `reason` at all falls back to the generic
  // message rather than leaving the previous reason stale.
  await t.mutation(internal.templates.applyMetaStatusWebhook, {
    metaTemplateId: "TMPL_99",
    event: "REJECTED",
  });
  row = await t.run((ctx) => ctx.db.get(templateId));
  expect(row!.rejectionReason).toBe("Rejected by Meta");
});

test("applyMetaStatusWebhook normalises PENDING_REVIEW to PENDING via normalizeTemplateStatus", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const templateId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    metaTemplateId: "meta-pr-1",
  });

  await t.mutation(internal.templates.applyMetaStatusWebhook, {
    metaTemplateId: "meta-pr-1",
    event: "PENDING_REVIEW",
  });

  const row = await t.run((ctx) => ctx.db.get(templateId));
  expect(row!.status).toBe("PENDING");
});

test("applyMetaStatusWebhook logs a warning and issues no patch when the metaTemplateId is unknown locally", async () => {
  const t = convexTest(schema, modules);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  await t.mutation(internal.templates.applyMetaStatusWebhook, {
    metaTemplateId: "NEVER_SEEN",
    event: "APPROVED",
  });

  expect(warnSpy).toHaveBeenCalled();
  expect(await t.run((ctx) => ctx.db.query("messageTemplates").collect())).toHaveLength(0);
  warnSpy.mockRestore();
});

test("applyMetaStatusWebhook has no session/account to filter by: it patches EVERY row sharing metaTemplateId across different accounts, and warns when more than one matched", async () => {
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
  const aliceTemplateId = await asAlice.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "PENDING",
    metaTemplateId: "shared-webhook-id",
  });
  const bobTemplateId = await asBob.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "PENDING",
    metaTemplateId: "shared-webhook-id",
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  await t.mutation(internal.templates.applyMetaStatusWebhook, {
    metaTemplateId: "shared-webhook-id",
    event: "APPROVED",
  });

  expect(warnSpy).toHaveBeenCalledWith(
    expect.stringContaining("matched 2 rows"),
  );
  expect((await t.run((ctx) => ctx.db.get(aliceTemplateId)))!.status).toBe("APPROVED");
  expect((await t.run((ctx) => ctx.db.get(bobTemplateId)))!.status).toBe("APPROVED");
  warnSpy.mockRestore();
});

// ============================================================
// upsertInternal — server-only counterpart to `upsert` (Phase 8, Task
// 4), for `metaTemplates.ts`'s submit/sync flow. No identity/role
// check (the calling action already derived + checked the account) —
// called directly with an explicit accountId/userId, mirroring
// `metaSend.test.ts`'s own no-identity internalAction calls.
// ============================================================

test("upsertInternal inserts a new row scoped to the given accountId and reports created: true", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const result = await t.mutation(internal.templates.upsertInternal, {
    accountId,
    userId,
    ...baseTemplate,
    status: "PENDING",
    metaTemplateId: "meta-1",
    qualityScore: "GREEN",
  });

  expect(result.created).toBe(true);
  const row = await t.run((ctx) => ctx.db.get(result.templateId));
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.status).toBe("PENDING");
  expect(row!.metaTemplateId).toBe("meta-1");
  expect(row!.qualityScore).toBe("GREEN");
});

test("upsertInternal patches the existing (accountId, name, language) row and reports created: false", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const first = await t.mutation(internal.templates.upsertInternal, {
    accountId,
    userId,
    ...baseTemplate,
    status: "PENDING",
  });
  expect(first.created).toBe(true);

  const second = await t.mutation(internal.templates.upsertInternal, {
    accountId,
    userId,
    ...baseTemplate,
    status: "APPROVED",
    qualityScore: "YELLOW",
  });

  expect(second.created).toBe(false);
  expect(second.templateId).toBe(first.templateId);
  const row = await t.run((ctx) => ctx.db.get(first.templateId));
  expect(row!.status).toBe("APPROVED");
  expect(row!.qualityScore).toBe("YELLOW");
  expect(await t.run((ctx) => ctx.db.query("messageTemplates").collect())).toHaveLength(1);
});

// ============================================================
// submit — authed PUBLIC action (Phase 8, Task 4). Auth/role gating
// mirrors `send.test.ts`'s own conventions for `send.ts`'s `send`.
// ============================================================

test("submit throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);

  await expect(
    t.action(api.templates.submit, { ...baseTemplate }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("submit throws FORBIDDEN for a viewer (below the supervisor floor)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Viewer",
    email: "viewer@example.com",
    role: "viewer",
  });

  await expect(
    asUser.action(api.templates.submit, { ...baseTemplate }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("submit throws FORBIDDEN for an agent — this floor was raised from agent to supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Agent",
    email: "agent@example.com",
    role: "agent",
  });

  await expect(
    asUser.action(api.templates.submit, { ...baseTemplate }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("submit rejects category: Authentication with the same guidance message as the source route", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });

  await expect(
    asUser.action(api.templates.submit, {
      ...baseTemplate,
      category: "Authentication",
    }),
  ).rejects.toThrow(/AUTHENTICATION templates are not yet supported/);
});

test("submit in DRY-RUN persists a PENDING row with a synthetic metaTemplateId and returns dryRun: true", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });

  const result = await asUser.action(api.templates.submit, { ...baseTemplate });

  expect(result.metaTemplateId).toMatch(/^dry-run-[0-9a-f]{16}$/);
  expect(result.status).toBe("PENDING");
  expect(result.dryRun).toBe(true);

  const row = await t.run((ctx) => ctx.db.get(result.templateId));
  expect(row!.accountId).toBe(accountId);
  expect(row!.name).toBe(baseTemplate.name);
  expect(row!.status).toBe("PENDING");
  expect(row!.metaTemplateId).toBe(result.metaTemplateId);
  expect(row!.submissionError).toBeUndefined();

  delete process.env.CONVEX_META_DRY_RUN;
});

test("submit persists a DRAFT row with submissionError and rethrows when Meta rejects the create call", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token",
    status: "connected",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "Invalid parameter" } }),
          { status: 400 },
        ),
    ),
  );

  await expect(
    asUser.action(api.templates.submit, { ...baseTemplate }),
  ).rejects.toThrow(/Invalid parameter/);

  const row = await t.run((ctx) =>
    ctx.db
      .query("messageTemplates")
      .withIndex("by_account_name_lang", (q) =>
        q
          .eq("accountId", accountId)
          .eq("name", baseTemplate.name)
          .eq("language", baseTemplate.language),
      )
      .first(),
  );
  expect(row!.status).toBe("DRAFT");
  expect(row!.submissionError).toBe("Invalid parameter");
  expect(row!.metaTemplateId).toBeUndefined();

  vi.unstubAllGlobals();
});

// ============================================================
// editSubmit — authed PUBLIC action (template-EDIT task, edit-by-hsm_id)
// ============================================================

test("editSubmit throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const templateId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "APPROVED",
    metaTemplateId: "meta-1",
  });

  await expect(
    t.action(api.templates.editSubmit, { templateId, ...baseTemplate }),
  ).rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("editSubmit throws FORBIDDEN for an agent (below the supervisor floor — submit and editSubmit now share the same floor)", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  // An agent can't `upsert` a template either (both are now
  // supervisor-gated), so the fixture row is seeded directly, bypassing
  // `templates.upsert` — mirrors `pipelines.test.ts`'s own
  // "seed directly, bypassing `create`" pattern for its analogous
  // below-the-floor test.
  const templateId = await t.run((ctx) =>
    ctx.db.insert("messageTemplates", {
      accountId,
      ...baseTemplate,
      status: "APPROVED",
      metaTemplateId: "meta-1",
      updatedAt: Date.now(),
    }),
  );

  await expect(
    asUser.action(api.templates.editSubmit, { templateId, ...baseTemplate }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("editSubmit throws NOT_FOUND when the template belongs to a different account", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });
  const aliceTemplateId = await asAlice.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "APPROVED",
    metaTemplateId: "meta-1",
  });

  await expect(
    asBob.action(api.templates.editSubmit, {
      templateId: aliceTemplateId,
      ...baseTemplate,
    }),
  ).rejects.toMatchObject({
    data: { code: "NOT_FOUND", entity: "messageTemplate" },
  });

  delete process.env.CONVEX_META_DRY_RUN;
});

test("editSubmit rejects a template that was never submitted to Meta (no metaTemplateId)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const templateId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "DRAFT",
  });

  await expect(
    asUser.action(api.templates.editSubmit, { templateId, ...baseTemplate }),
  ).rejects.toThrow(/never submitted to Meta/);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("editSubmit rejects a template whose status isn't APPROVED/REJECTED/PAUSED", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const templateId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "PENDING",
    metaTemplateId: "meta-1",
  });

  await expect(
    asUser.action(api.templates.editSubmit, { templateId, ...baseTemplate }),
  ).rejects.toThrow(/cannot be edited/);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("editSubmit rejects category: Authentication with the same guidance message as the source route", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const templateId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "APPROVED",
    metaTemplateId: "meta-1",
  });

  await expect(
    asUser.action(api.templates.editSubmit, {
      templateId,
      ...baseTemplate,
      category: "Authentication",
    }),
  ).rejects.toThrow(/AUTHENTICATION templates are not editable here/);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("editSubmit in DRY-RUN patches the local row with the edited content, flips status to PENDING, and returns dryRun: true", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const templateId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "REJECTED",
    metaTemplateId: "meta-1",
  });
  await t.run((ctx) =>
    ctx.db.patch(templateId, { rejectionReason: "Sample content violates policy" }),
  );

  const result = await asUser.action(api.templates.editSubmit, {
    templateId,
    ...baseTemplate,
    bodyText: "Hi {{1}}, thanks for shopping with us!",
  });

  expect(result).toEqual({ templateId, status: "PENDING", dryRun: true });

  const row = await t.run((ctx) => ctx.db.get(templateId));
  expect(row!.accountId).toBe(accountId);
  expect(row!.bodyText).toBe("Hi {{1}}, thanks for shopping with us!");
  expect(row!.status).toBe("PENDING");
  expect(row!.rejectionReason).toBeUndefined();
  expect(row!.submissionError).toBeUndefined();
  // name/language/metaTemplateId are immutable on edit — untouched.
  expect(row!.name).toBe(baseTemplate.name);
  expect(row!.metaTemplateId).toBe("meta-1");

  delete process.env.CONVEX_META_DRY_RUN;
});

test("editSubmit persists only submissionError + lastSubmittedAt (leaving the live content untouched) and rethrows when Meta rejects the edit call", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token",
    status: "connected",
  });
  const templateId = await asUser.mutation(api.templates.upsert, {
    ...baseTemplate,
    status: "APPROVED",
    metaTemplateId: "meta-1",
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "Edit limit reached" } }),
          { status: 400 },
        ),
    ),
  );

  await expect(
    asUser.action(api.templates.editSubmit, {
      templateId,
      ...baseTemplate,
      bodyText: "This edit should not be persisted",
    }),
  ).rejects.toThrow(/Edit limit reached/);

  const row = await t.run((ctx) => ctx.db.get(templateId));
  expect(row!.submissionError).toBe("Edit limit reached");
  // Original content survives the failed edit attempt untouched.
  expect(row!.bodyText).toBe(baseTemplate.bodyText);
  expect(row!.status).toBe("APPROVED");

  vi.unstubAllGlobals();
});

// ============================================================
// syncFromMeta — authed PUBLIC action (Phase 8, Task 4)
// ============================================================

test("syncFromMeta throws UNAUTHENTICATED when there is no identity", async () => {
  const t = convexTest(schema, modules);

  await expect(t.action(api.templates.syncFromMeta, {})).rejects.toMatchObject({
    data: { code: "UNAUTHENTICATED" },
  });
});

test("syncFromMeta throws FORBIDDEN for a viewer (below the supervisor floor)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Viewer",
    email: "viewer@example.com",
    role: "viewer",
  });

  await expect(
    asUser.action(api.templates.syncFromMeta, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("syncFromMeta throws FORBIDDEN for an agent — this floor was raised from agent to supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Agent",
    email: "agent@example.com",
    role: "agent",
  });

  await expect(
    asUser.action(api.templates.syncFromMeta, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("syncFromMeta in DRY-RUN returns all-zero counts and does not touch the local catalog", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor",
  });

  const result = await asUser.action(api.templates.syncFromMeta, {});

  expect(result).toEqual({
    total: 0,
    inserted: 0,
    updated: 0,
    errors: [],
    truncated: false,
    dryRun: true,
  });
  expect(await t.run((ctx) => ctx.db.query("messageTemplates").collect())).toHaveLength(0);

  delete process.env.CONVEX_META_DRY_RUN;
});

test("syncFromMeta inserts a new template on first run and updates the same row on a second run", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    wabaId: "waba-1",
    accessToken: "plaintext-token",
    status: "connected",
  });
  const metaListResponse = (status: string) =>
    new Response(
      JSON.stringify({
        data: [
          {
            id: "meta-sync-1",
            name: "order_confirmation",
            language: "en_US",
            status,
            category: "UTILITY",
            components: [{ type: "BODY", text: "Order shipped." }],
          },
        ],
        paging: {},
      }),
      { status: 200 },
    );

  vi.stubGlobal("fetch", vi.fn(async () => metaListResponse("PENDING")));
  const first = await asUser.action(api.templates.syncFromMeta, {});
  expect(first).toMatchObject({ total: 1, inserted: 1, updated: 0, errors: [] });

  vi.stubGlobal("fetch", vi.fn(async () => metaListResponse("APPROVED")));
  const second = await asUser.action(api.templates.syncFromMeta, {});
  expect(second).toMatchObject({ total: 1, inserted: 0, updated: 1, errors: [] });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("messageTemplates")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("APPROVED");
  expect(rows[0]!.metaTemplateId).toBe("meta-sync-1");

  vi.unstubAllGlobals();
});
