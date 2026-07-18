/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
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
 * points at `convex/aiKnowledge.test.ts` for the precedent). Defaults to
 * "admin" (comfortably clears `suggest`'s agent floor) when `opts.role`
 * is omitted; pass an explicit `role` to seed a different rank — matches
 * `convex/aiConfig.test.ts`'s own parametrized `seedAccountMember`.
 */
async function seedAccountMember(
  t: TestConvex<typeof schema>,
  opts: { name: string; email: string; role?: AccountRole },
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
      role: opts.role ?? "admin",
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

test("suggest is idempotent: calling it twice on the same conversation returns the same suggestionId and inserts only one row", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);

  const { conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15550015",
      phoneNormalized: "15550015",
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

  const first = await asUser.action(api.aiTagging.suggest, { conversationId });
  if ("error" in first) throw new Error(`expected success, got ${first.code}: ${first.error}`);

  const second = await asUser.action(api.aiTagging.suggest, { conversationId });
  if ("error" in second) throw new Error(`expected success, got ${second.code}: ${second.error}`);

  expect(second.suggestionId).toBe(first.suggestionId);

  const rows = await t.run((ctx) =>
    ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
});

test("suggest on an account with an empty tag catalogue returns a no_tags error and records nothing", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  await configureAi(asUser);

  // No tagGroups/tags seeded at all — the dry-run synthetic classifier
  // (see `syntheticClassifyRaw` in `convex/aiTagging.ts`) then has no
  // catalogue to pick a tag from and no note either.
  const { conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15550016",
      phoneNormalized: "15550016",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    });
    return { conversationId };
  });

  const res = await asUser.action(api.aiTagging.suggest, { conversationId });

  expect(res).toEqual({
    error: "The AI didn't find any matching tags for this conversation.",
    code: "no_tags",
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(rows).toHaveLength(0);
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

/**
 * Adds a second membership row to an *existing* account — for role-floor
 * tests where the account's primary member must stay admin (e.g. to
 * configure AI via the admin-gated `aiConfig.upsert`). Matches
 * `convex/aiReply.test.ts`'s own `seedTeammate`.
 */
async function seedTeammate(
  t: TestConvex<typeof schema>,
  opts: { accountId: Id<"accounts">; name: string; email: string; role: AccountRole },
) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { name: opts.name, email: opts.email });
    await ctx.db.insert("memberships", {
      userId: id,
      accountId: opts.accountId,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  const asUser = t.withIdentity({ subject: `${userId}|session-${opts.name}` });
  return { userId, asUser };
}

/**
 * Seeds a fresh account with AI configured, for use in accept/dismiss tests.
 * Returns an authenticated user client that genuinely holds `opts.role`
 * (default "admin"). AI config is always upserted by a SEPARATE admin
 * teammate first — `aiConfig.upsert` is admin+-gated (see `aiConfig.ts`),
 * so a caller seeded at a lower role couldn't configure it themselves. That
 * bootstrap admin identity is then discarded (unless "admin" was actually
 * requested); only the teammate genuinely seeded at `opts.role` is
 * returned, so a mutation test using it truly exercises that role's
 * `ctx.requireRole(...)` floor instead of silently running as admin.
 */
async function seedAccountMemberWithAi(
  t: TestConvex<typeof schema>,
  opts: { role?: AccountRole } = {},
) {
  const admin = await seedAccountMember(t, {
    name: "TestAdmin",
    email: "TestAdmin@example.com",
  });
  await configureAi(admin.asUser);

  const role = opts.role ?? "admin";
  if (role === "admin") return admin;

  const { userId, asUser } = await seedTeammate(t, {
    accountId: admin.accountId,
    name: "TestAgent",
    email: "TestAgent@example.com",
    role,
  });
  return { userId, accountId: admin.accountId, asUser };
}

test("acceptSuggestion applies tags with source ai + adds the note", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMemberWithAi(t, { role: "agent" });
  const { contactId, tagId, suggestionId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+15550010", phoneNormalized: "15550010" });
    const conversationId = await ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 });
    const tagId = await ctx.db.insert("tags", { accountId, name: "UAE Visa", color: "#3b82f6" });
    const suggestionId = await ctx.db.insert("tagSuggestions", {
      accountId, conversationId, contactId, suggestedTagIds: [tagId],
      note: "Wants UAE visa", confidence: "high", status: "pending", model: "m",
    });
    return { contactId, tagId, suggestionId };
  });

  await asUser.mutation(api.aiTagging.acceptSuggestion, { suggestionId });

  const links = await t.run((ctx) =>
    ctx.db.query("contactTags").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect());
  expect(links.map((l) => l.tagId)).toEqual([tagId]);
  expect(links[0].source).toBe("ai");
  const notes = await t.run((ctx) =>
    ctx.db.query("contactNotes").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect());
  expect(notes.some((n) => n.noteText.includes("UAE visa"))).toBe(true);
  const sug = await t.run((ctx) => ctx.db.get(suggestionId));
  expect(sug!.status).toBe("accepted");
});

test("acceptSuggestion is idempotent: re-invoking on an already-accepted suggestion does not duplicate the note", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMemberWithAi(t, { role: "agent" });
  const { contactId, tagId, suggestionId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+15550012", phoneNormalized: "15550012" });
    const conversationId = await ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 });
    const tagId = await ctx.db.insert("tags", { accountId, name: "Repeat Visa", color: "#22c55e" });
    const suggestionId = await ctx.db.insert("tagSuggestions", {
      accountId, conversationId, contactId, suggestedTagIds: [tagId],
      note: "Wants repeat visa", confidence: "high", status: "pending", model: "m",
    });
    return { contactId, tagId, suggestionId };
  });

  await asUser.mutation(api.aiTagging.acceptSuggestion, { suggestionId });
  await asUser.mutation(api.aiTagging.acceptSuggestion, { suggestionId }); // re-invoke on the now-accepted suggestion

  const links = await t.run((ctx) =>
    ctx.db.query("contactTags").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect());
  expect(links.map((l) => l.tagId)).toEqual([tagId]); // tag link count unchanged, not duplicated
  const notes = await t.run((ctx) =>
    ctx.db.query("contactNotes").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect());
  expect(notes).toHaveLength(1); // exactly one note, not duplicated by the second accept
  const sug = await t.run((ctx) => ctx.db.get(suggestionId));
  expect(sug!.status).toBe("accepted");
});

test("dismissSuggestion marks dismissed with no tag applied", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMemberWithAi(t, { role: "agent" });
  const { contactId, suggestionId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+15550011", phoneNormalized: "15550011" });
    const conversationId = await ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 });
    const tagId = await ctx.db.insert("tags", { accountId, name: "Packages", color: "#f59e0b" });
    const suggestionId = await ctx.db.insert("tagSuggestions", {
      accountId, conversationId, contactId, suggestedTagIds: [tagId], confidence: "low", status: "pending", model: "m" });
    return { contactId, suggestionId };
  });

  await asUser.mutation(api.aiTagging.dismissSuggestion, { suggestionId });

  const links = await t.run((ctx) =>
    ctx.db.query("contactTags").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect());
  expect(links).toHaveLength(0);
  const sug = await t.run((ctx) => ctx.db.get(suggestionId));
  expect(sug!.status).toBe("dismissed");
});

test("pendingForConversation returns the pending row, then null once it's reviewed", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
  });
  const { conversationId, suggestionId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15550014",
      phoneNormalized: "15550014",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    });
    const tagId = await ctx.db.insert("tags", { accountId, name: "Flights", color: "#0ea5e9" });
    const suggestionId = await ctx.db.insert("tagSuggestions", {
      accountId,
      conversationId,
      contactId,
      suggestedTagIds: [tagId],
      confidence: "medium",
      status: "pending",
      model: "m",
    });
    return { conversationId, suggestionId };
  });

  const pending = await asUser.query(api.aiTagging.pendingForConversation, { conversationId });
  expect(pending?._id).toBe(suggestionId);
  expect(pending?.status).toBe("pending");

  await t.run((ctx) => ctx.db.patch(suggestionId, { status: "dismissed" }));

  const afterDismiss = await asUser.query(api.aiTagging.pendingForConversation, { conversationId });
  expect(afterDismiss).toBeNull();
});
