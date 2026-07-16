/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against — same absolute, from-project-root glob every other
// `convex/*.test.ts` suite uses (see `convex/aiReply.test.ts`).
const modules = import.meta.glob("/convex/**/*.ts");

// `suggest` skips the real LLM call under `CONVEX_AI_DRY_RUN` (see
// `aiTagging.ts`'s own `syntheticClassifyRaw`) — same convention as
// `aiReply.test.ts`'s file-level DRY-RUN flag.
beforeEach(() => {
  process.env.CONVEX_AI_DRY_RUN = "1";
});
afterEach(() => {
  delete process.env.CONVEX_AI_DRY_RUN;
});

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Copied verbatim from `convex/aiReply.test.ts` (duplicated
 * per-suite rather than imported — see that file's own comment, which
 * points at `convex/aiKnowledge.test.ts` for the precedent). Role is
 * always "admin" here, which comfortably clears `suggest`'s agent floor.
 */
async function seedAccountMember(
  t: TestConvex<typeof schema>,
  opts: { name: string; email: string },
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
      role: "admin" as AccountRole,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  const asUser = t.withIdentity({ subject: `${userId}|session-${opts.name}` });
  return { userId, accountId, asUser };
}

const BASE_AI_CONFIG_ARGS = {
  provider: "openai" as const,
  model: "gpt-4o-mini",
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
};

/**
 * Admin+ upsert of the caller's AI config — active + a key, so
 * `aiConfig.loadDecrypted` returns a usable (non-null, `isActive`) row for
 * `suggest` to classify with. Copied verbatim from `convex/aiReply.test.ts`.
 */
async function configureAi(
  asUser: Awaited<ReturnType<typeof seedAccountMember>>["asUser"],
  overrides: Partial<typeof BASE_AI_CONFIG_ARGS> = {},
) {
  await asUser.mutation(api.aiConfig.upsert, {
    ...BASE_AI_CONFIG_ARGS,
    apiKey: "sk-test-key",
    ...overrides,
  });
}

test("suggest records a pending suggestion from a dry-run classification", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);

  const { conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15550009",
      phoneNormalized: "15550009",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    });
    await ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer" as const,
      contentType: "text" as const,
      contentText: "UAE Visa please",
      status: "delivered" as const,
    });
    const gid = await ctx.db.insert("tagGroups", {
      accountId,
      name: "Product",
      selectionMode: "single" as const,
      position: 0,
    });
    await ctx.db.insert("tags", {
      accountId,
      name: "UAE Visa",
      color: "#3b82f6",
      groupId: gid,
    });
    return { conversationId };
  });

  const res = await asUser.action(api.aiTagging.suggest, { conversationId });
  if ("error" in res) throw new Error(`expected success, got ${res.code}: ${res.error}`);
  expect(res.suggestionId).toBeDefined();

  const rows = await t.run((ctx) =>
    ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("pending");
  expect(rows[0]!.confidence).toBeDefined();
});

test("suggest returns a forbidden error for a viewer (below the agent role floor)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);
  const { conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15550011",
      phoneNormalized: "15550011",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    });
    return { conversationId };
  });
  const viewerUserId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Vic", email: "vic@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: viewerUserId,
      accountId,
      role: "viewer" as AccountRole,
      fullName: "Vic",
      email: "vic@example.com",
    }),
  );
  const asVic = t.withIdentity({ subject: `${viewerUserId}|session-Vic` });

  const res = await asVic.action(api.aiTagging.suggest, { conversationId });

  expect(res).toEqual({ error: "Forbidden", code: "forbidden" });
});
