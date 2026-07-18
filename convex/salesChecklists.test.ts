import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import { DEFAULT_SALES_CHECKLIST } from "./lib/salesChecklist";

const modules = import.meta.glob("/convex/**/*.ts");

// Same DRY-RUN convention as aiReply.test.ts — the generation action
// swaps the real LLM for a deterministic synthetic checklist.
beforeEach(() => {
  process.env.CONVEX_AI_DRY_RUN = "1";
});
afterEach(() => {
  delete process.env.CONVEX_AI_DRY_RUN;
});

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
      defaultCurrency: "AED",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId, accountId: id, role: opts.role, fullName: opts.name, email: opts.email,
    });
    return id;
  });
  return { userId, accountId, asUser: t.withIdentity({ subject: `${userId}|session-${opts.name}` }) };
}

async function seedTeammate(
  t: TestConvex<typeof schema>,
  opts: { accountId: Id<"accounts">; name: string; email: string; role: AccountRole },
) {
  const userId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", { name: opts.name, email: opts.email });
    await ctx.db.insert("memberships", {
      userId: id, accountId: opts.accountId, role: opts.role, fullName: opts.name, email: opts.email,
    });
    return id;
  });
  return { userId, asUser: t.withIdentity({ subject: `${userId}|session-${opts.name}` }) };
}

/** Contact + conversation + qualified session (+ optional checklist). */
async function seedLead(
  t: TestConvex<typeof schema>,
  args: {
    accountId: Id<"accounts">;
    assignedToUserId?: Id<"users">;
    status?: "collecting" | "qualified";
    withChecklist?: boolean;
  },
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId: args.accountId, phone: "+971501112233", phoneNormalized: "971501112233",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId: args.accountId, contactId, status: "open", unreadCount: 0,
      assignedToUserId: args.assignedToUserId,
    });
    const sessionId = await ctx.db.insert("qualificationSessions", {
      accountId: args.accountId, conversationId, contactId,
      status: args.status ?? "qualified", origin: "inbound", fields: [],
      expectedCount: 5, answeredCount: 5, followUpsSent: 0, phrasingCursor: 0,
      sendAttemptErrors: 0, serviceName: "Bali Packages",
    });
    let checklistId: Id<"salesChecklists"> | null = null;
    if (args.withChecklist) {
      checklistId = await ctx.db.insert("salesChecklists", {
        accountId: args.accountId, sessionId, conversationId, contactId,
        source: "default",
        items: [
          { key: "call", title: "Call the lead", done: false },
          { key: "pitch", title: "Give a proper pitch", done: true, doneAt: 1, note: "done earlier" },
        ],
        generatedAt: Date.now(),
      });
    }
    return { contactId, conversationId, sessionId, checklistId };
  });
}

async function notesFor(t: TestConvex<typeof schema>, contactId: Id<"contacts">) {
  return await t.run((ctx) =>
    ctx.db.query("contactNotes").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect());
}

async function checklistForSession(t: TestConvex<typeof schema>, sessionId: Id<"qualificationSessions">) {
  return await t.run((ctx) =>
    ctx.db.query("salesChecklists").withIndex("by_session", (q) => q.eq("sessionId", sessionId)).unique());
}

// ---------------------------------------------------------------- items

test("setItemDone marks the item with note/author/time and writes the contact-note trail", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Ann", email: "ann@x.com", role: "agent" });
  const { contactId, checklistId } = await seedLead(t, { accountId, assignedToUserId: userId, withChecklist: true });

  await asUser.mutation(api.salesChecklists.setItemDone, {
    checklistId: checklistId!, itemKey: "call", note: "Okay, I have done this — spoke 12 min, wants March",
  });

  const row = await t.run((ctx) => ctx.db.get(checklistId!));
  const item = row!.items.find((i) => i.key === "call")!;
  expect(item.done).toBe(true);
  expect(item.doneByUserId).toBe(userId);
  expect(item.doneAt).toBeGreaterThan(0);
  expect(item.note).toContain("spoke 12 min");

  const notes = await notesFor(t, contactId);
  expect(notes.some((n) => n.noteText.includes("Call the lead") && n.noteText.includes("spoke 12 min"))).toBe(true);
});

test("setItemDone rejects a missing/short note and an already-done item", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Ben", email: "ben@x.com", role: "agent" });
  const { checklistId } = await seedLead(t, { accountId, assignedToUserId: userId, withChecklist: true });

  await expect(
    asUser.mutation(api.salesChecklists.setItemDone, { checklistId: checklistId!, itemKey: "call", note: "  ok " }),
  ).rejects.toThrow(/note_required/);
  await expect(
    asUser.mutation(api.salesChecklists.setItemDone, { checklistId: checklistId!, itemKey: "pitch", note: "trying to redo it" }),
  ).rejects.toThrow(/item_already_done/);
  await expect(
    asUser.mutation(api.salesChecklists.setItemDone, { checklistId: checklistId!, itemKey: "nope", note: "valid note here" }),
  ).rejects.toThrow(/item_not_found/);
});

test("RBAC: unassigned agent forbidden, supervisor allowed, viewer forbidden", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "Own", email: "own@x.com", role: "owner" });
  const { checklistId } = await seedLead(t, { accountId, withChecklist: true }); // unassigned

  const { asUser: asAgent } = await seedTeammate(t, { accountId, name: "Agt", email: "agt@x.com", role: "agent" });
  await expect(
    asAgent.mutation(api.salesChecklists.setItemDone, { checklistId: checklistId!, itemKey: "call", note: "valid note here" }),
  ).rejects.toThrow();

  const { asUser: asViewer } = await seedTeammate(t, { accountId, name: "Vic", email: "vic@x.com", role: "viewer" });
  await expect(
    asViewer.mutation(api.salesChecklists.setItemDone, { checklistId: checklistId!, itemKey: "call", note: "valid note here" }),
  ).rejects.toThrow();

  const { asUser: asSup } = await seedTeammate(t, { accountId, name: "Sup", email: "sup@x.com", role: "supervisor" });
  await asSup.mutation(api.salesChecklists.setItemDone, { checklistId: checklistId!, itemKey: "call", note: "valid note here" });
  const row = await t.run((ctx) => ctx.db.get(checklistId!));
  expect(row!.items.find((i) => i.key === "call")!.done).toBe(true);
});

test("reopenItem clears the completion and notes the reopen", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Cyd", email: "cyd@x.com", role: "agent" });
  const { contactId, checklistId } = await seedLead(t, { accountId, assignedToUserId: userId, withChecklist: true });

  await asUser.mutation(api.salesChecklists.reopenItem, { checklistId: checklistId!, itemKey: "pitch" });

  const row = await t.run((ctx) => ctx.db.get(checklistId!));
  const item = row!.items.find((i) => i.key === "pitch")!;
  expect(item.done).toBe(false);
  expect(item.doneAt).toBeUndefined();
  expect(item.note).toBeUndefined();

  const notes = await notesFor(t, contactId);
  expect(notes.some((n) => n.noteText.includes("reopened") && n.noteText.includes("Give a proper pitch"))).toBe(true);

  await expect(
    asUser.mutation(api.salesChecklists.reopenItem, { checklistId: checklistId!, itemKey: "pitch" }),
  ).rejects.toThrow(/item_not_done/);
});

// ----------------------------------------------------------- generation

test("insertChecklist is idempotent per session", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "Dee", email: "dee@x.com", role: "owner" });
  const { sessionId } = await seedLead(t, { accountId });

  const first = await t.mutation(internal.salesChecklists.insertChecklist, {
    sessionId, source: "default", items: [{ key: "call", title: "Call the lead" }],
  });
  const second = await t.mutation(internal.salesChecklists.insertChecklist, {
    sessionId, source: "kb", items: [{ key: "other", title: "Something else" }],
  });
  expect(second).toBe(first);
  const row = await checklistForSession(t, sessionId);
  expect(row!.source).toBe("default");
  expect(row!.items).toHaveLength(1);
  expect(row!.items[0].done).toBe(false);
});

test("generateForSession without an active AI config posts the default 6-step checklist", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "Eve", email: "eve@x.com", role: "owner" });
  const { sessionId } = await seedLead(t, { accountId });

  await t.action(internal.salesChecklists.generateForSession, { accountId, sessionId });

  const row = await checklistForSession(t, sessionId);
  expect(row).not.toBeNull();
  expect(row!.source).toBe("default");
  expect(row!.items.map((i) => i.key)).toEqual(DEFAULT_SALES_CHECKLIST.map((i) => i.key));
  expect(row!.items.every((i) => !i.done)).toBe(true);
});

test("generateForSession with an active AI config (dry-run) posts the KB-generated checklist once", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, { name: "Fay", email: "fay@x.com", role: "admin" });
  await asUser.mutation(api.aiConfig.upsert, {
    provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test-key",
    isActive: true, autoReplyEnabled: false, autoReplyMaxPerConversation: 3,
  });
  const { sessionId } = await seedLead(t, { accountId });

  await t.action(internal.salesChecklists.generateForSession, { accountId, sessionId });
  // Second run is a no-op (checklist already posted).
  await t.action(internal.salesChecklists.generateForSession, { accountId, sessionId });

  const row = await checklistForSession(t, sessionId);
  expect(row).not.toBeNull();
  expect(row!.source).toBe("kb");
  expect(row!.items.length).toBeGreaterThanOrEqual(2);
  expect(row!.items.every((i) => !i.done)).toBe(true);
});

// ------------------------------------------------------------- backfill

test("backfill creates default checklists only for qualified sessions missing one", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "Gus", email: "gus@x.com", role: "owner" });
  const a = await seedLead(t, { accountId }); // qualified, no checklist
  const b = await seedLead(t, { accountId, withChecklist: true }); // already has one
  const c = await seedLead(t, { accountId, status: "collecting" }); // not qualified

  const result = await t.mutation(internal.salesChecklists.backfill, {});
  expect(result.created).toBe(1);

  expect(await checklistForSession(t, a.sessionId)).not.toBeNull();
  const existing = await checklistForSession(t, b.sessionId);
  expect(existing!.items).toHaveLength(2); // untouched
  expect(await checklistForSession(t, c.sessionId)).toBeNull();
});
