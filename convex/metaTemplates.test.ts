/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches
// `convex/metaSend.test.ts`/`convex/templates.test.ts` — see those
// files' comments for why this must be absolute rather than a relative
// "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported — see
 * `convex/metaSend.test.ts`'s own comment on this pattern.
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
  const asUser = t.withIdentity({ subject: `${userId}|session-${opts.name}` });
  return { userId, accountId, asUser };
}

const baseTemplateArgs = {
  name: "welcome",
  language: "en_US",
  category: "Marketing" as const,
  bodyText: "Hello {{1}}",
};

// ============================================================
// submitToMeta — DRY-RUN
// ============================================================

test("submitToMeta in DRY-RUN returns a synthetic id + PENDING status without a whatsappConfig row or a network call", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const result = await t.action(internal.metaTemplates.submitToMeta, {
    accountId,
    ...baseTemplateArgs,
  });

  expect(result.metaTemplateId).toMatch(/^dry-run-[0-9a-f]{16}$/);
  expect(result.status).toBe("PENDING");
  expect(result.dryRun).toBe(true);

  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// submitToMeta — config gating (non-DRY-RUN)
// ============================================================

test("submitToMeta throws 'WhatsApp not configured' when DRY-RUN is off and no whatsappConfig row exists", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    t.action(internal.metaTemplates.submitToMeta, { accountId, ...baseTemplateArgs }),
  ).rejects.toThrow(/WhatsApp not configured/);
});

test("submitToMeta throws a WABA-id-missing error when the config has no wabaId", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  await asUser.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "1000000000",
    accessToken: "plaintext-token",
    status: "connected",
  });

  await expect(
    t.action(internal.metaTemplates.submitToMeta, { accountId, ...baseTemplateArgs }),
  ).rejects.toThrow(/WABA/);
});

// ============================================================
// submitToMeta — real Meta call (fetch mocked)
// ============================================================

test("submitToMeta POSTs the built components payload to Meta and returns the assigned id + status", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
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

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe("https://graph.facebook.com/v21.0/waba-1/message_templates");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer plaintext-token" });
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({
      name: "welcome",
      category: "MARKETING",
      language: "en_US",
      components: [{ type: "BODY", text: "Hello {{1}}" }],
    });
    return new Response(
      JSON.stringify({ id: "meta-tmpl-123", status: "PENDING" }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await t.action(internal.metaTemplates.submitToMeta, {
    accountId,
    ...baseTemplateArgs,
  });

  expect(result).toEqual({
    metaTemplateId: "meta-tmpl-123",
    status: "PENDING",
    dryRun: false,
  });
  expect(fetchMock).toHaveBeenCalledOnce();

  vi.unstubAllGlobals();
});

test("submitToMeta surfaces Meta's own error message when the create call fails", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
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
    t.action(internal.metaTemplates.submitToMeta, { accountId, ...baseTemplateArgs }),
  ).rejects.toThrow(/Invalid parameter/);

  vi.unstubAllGlobals();
});

// ============================================================
// syncFromMeta — DRY-RUN
// ============================================================

test("syncFromMeta in DRY-RUN returns an empty list without a whatsappConfig row or a network call", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const result = await t.action(internal.metaTemplates.syncFromMeta, { accountId });
  expect(result).toEqual({ templates: [], truncated: false, dryRun: true });

  delete process.env.CONVEX_META_DRY_RUN;
});

test("syncFromMeta throws 'WhatsApp not configured' when DRY-RUN is off and no whatsappConfig row exists", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    t.action(internal.metaTemplates.syncFromMeta, { accountId }),
  ).rejects.toThrow(/WhatsApp not configured/);
});

// ============================================================
// syncFromMeta — real Meta call (fetch mocked), full parse
// ============================================================

test("syncFromMeta parses Meta's template list into upsertInternal-ready rows", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
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
    vi.fn(async (url: string) => {
      expect(url).toContain("waba-1/message_templates");
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "meta-1",
              name: "order_confirmation",
              language: "en_US",
              status: "APPROVED",
              category: "UTILITY",
              quality_score: { score: "GREEN" },
              components: [
                {
                  type: "BODY",
                  text: "Your order {{1}} shipped.",
                  example: { body_text: [["ORD-1"]] },
                },
                { type: "FOOTER", text: "Thanks" },
                {
                  type: "BUTTONS",
                  buttons: [{ type: "QUICK_REPLY", text: "Track" }],
                },
              ],
            },
          ],
          paging: {},
        }),
        { status: 200 },
      );
    }),
  );

  const result = await t.action(internal.metaTemplates.syncFromMeta, { accountId });

  expect(result.truncated).toBe(false);
  expect(result.dryRun).toBe(false);
  expect(result.templates).toEqual([
    {
      name: "order_confirmation",
      language: "en_US",
      category: "Utility",
      bodyText: "Your order {{1}} shipped.",
      footerText: "Thanks",
      buttons: [{ type: "QUICK_REPLY", text: "Track" }],
      sampleValues: { body: ["ORD-1"] },
      status: "APPROVED",
      metaTemplateId: "meta-1",
      qualityScore: "GREEN",
    },
  ]);

  vi.unstubAllGlobals();
});

test("syncFromMeta follows paging.next across multiple pages", async () => {
  delete process.env.CONVEX_META_DRY_RUN;
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
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

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "meta-1",
              name: "tpl_one",
              language: "en_US",
              status: "PENDING",
              category: "UTILITY",
              components: [{ type: "BODY", text: "One" }],
            },
          ],
          paging: { next: "https://graph.facebook.com/v21.0/next-page" },
        }),
        { status: 200 },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "meta-2",
              name: "tpl_two",
              language: "en_US",
              status: "APPROVED",
              category: "MARKETING",
              components: [{ type: "BODY", text: "Two" }],
            },
          ],
          paging: {},
        }),
        { status: 200 },
      ),
    );
  vi.stubGlobal("fetch", fetchMock);

  const result = await t.action(internal.metaTemplates.syncFromMeta, { accountId });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.truncated).toBe(false);
  expect(result.templates.map((tpl) => tpl.metaTemplateId)).toEqual([
    "meta-1",
    "meta-2",
  ]);

  vi.unstubAllGlobals();
});
