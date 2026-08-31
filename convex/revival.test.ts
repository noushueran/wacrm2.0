/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import { REAP_CAP } from "./revivalEngine";

const modules = import.meta.glob("/convex/**/*.ts");

const MIN = 60_000;
const HOUR = 60 * MIN;

type T = ReturnType<typeof convexTest>;

async function seedMember(t: T, role: AccountRole, accountId?: Id<"accounts">) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: role, email: `${role}-${Math.random()}@x.com` }),
  );
  const id =
    accountId ??
    (await t.run((ctx) =>
      ctx.db.insert("accounts", {
        name: "A",
        defaultCurrency: "AED",
        ownerUserId: userId,
      }),
    ));
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role,
      fullName: role,
      email: `${role}@x.com`,
    }),
  );
  return { userId, accountId: id, as: t.withIdentity({ subject: `${userId}|s` }) };
}

/** A quiet lead plus a pending draft for it — the state the queue shows. */
async function seedDraft(
  t: T,
  accountId: Id<"accounts">,
  opts: { quietMin?: number; expiresInMin?: number } = {},
) {
  const quietMin = opts.quietMin ?? 240;
  const lastAt = Date.now() - quietMin * MIN;
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: `+9715${Math.floor(Math.random() * 100000000)}`,
      phoneNormalized: `+9715${Math.floor(Math.random() * 100000000)}`,
      name: "Ravi",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      lastMessageAt: lastAt,
    });
    await ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "Is the Dubai visa still available?",
      status: "delivered",
    });
    const draftId = await ctx.db.insert("revivalDrafts", {
      accountId,
      conversationId,
      contactId,
      body: "Hi Ravi, still planning Dubai?",
      reason: "Asked about the visa, quiet 4h",
      channel: "free_text",
      status: "pending",
      model: "gpt-5",
      confidence: "high",
      createdAt: Date.now() - 30 * MIN,
      expiresAt: Date.now() + (opts.expiresInMin ?? 120) * MIN,
    });
    return { contactId, conversationId, draftId };
  });
}

async function claim(
  t: T,
  draftId: Id<"revivalDrafts">,
  accountId: Id<"accounts">,
  userId: Id<"users">,
  bodyOverride?: string,
) {
  return await t.mutation(internal.revival.claimForSend, {
    draftId,
    accountId,
    userId,
    ...(bodyOverride !== undefined ? { bodyOverride } : {}),
  });
}

test("the queue lists an account's pending drafts", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "admin");
  await seedDraft(t, accountId);

  const result = await as.query(api.revival.queue, {});
  expect(result.drafts).toHaveLength(1);
  expect(result.drafts[0]!.contactName).toBe("Ravi");
  expect(result.drafts[0]!.reason).toContain("visa");
  expect(result.overflow).toBe(false);
});

test("one account's queue never shows another's drafts", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedMember(t, "admin");
  const theirs = await seedMember(t, "admin");
  await seedDraft(t, theirs.accountId);

  const result = await mine.as.query(api.revival.queue, {});
  expect(result.drafts).toHaveLength(0);
});

test("the queue carries no keys, prompts, or token counts", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "viewer");
  await seedDraft(t, accountId);

  const serialized = JSON.stringify(await as.query(api.revival.queue, {}));
  expect(serialized).not.toContain("apiKey");
  expect(serialized).not.toContain("systemPrompt");
  expect(serialized).not.toContain("promptTokens");
});

test("a viewer may not send", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "viewer");
  const { draftId } = await seedDraft(t, accountId);

  await expect(as.action(api.revival.send, { draftId })).rejects.toMatchObject({
    data: { code: "FORBIDDEN", min: "agent" },
  });
  // And the draft is untouched.
  const row = await t.run((ctx) => ctx.db.get(draftId));
  expect(row!.status).toBe("pending");
});

test("a draft belonging to another account is not found", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedMember(t, "admin");
  const theirs = await seedMember(t, "admin");
  const { draftId } = await seedDraft(t, theirs.accountId);

  await expect(
    mine.as.action(api.revival.send, { draftId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
});

test("claiming a valid draft flips it to sent and records the reviewer", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedMember(t, "agent");
  const { draftId, conversationId } = await seedDraft(t, accountId);

  const result = await claim(t, draftId, accountId, userId);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.conversationId).toBe(conversationId);

  const row = await t.run((ctx) => ctx.db.get(draftId));
  expect(row!.status).toBe("sent");
  expect(row!.reviewedByUserId).toBe(userId);
  expect(row!.reviewedAt).toBeGreaterThan(0);
});

test("a second claim is blocked — a double tap cannot send twice", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedMember(t, "agent");
  const { draftId } = await seedDraft(t, accountId);

  expect((await claim(t, draftId, accountId, userId)).ok).toBe(true);
  const second = await claim(t, draftId, accountId, userId);
  expect(second).toEqual({ ok: false, blocked: "already_actioned" });
});

test("an expired draft is blocked and stays pending", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedMember(t, "agent");
  const { draftId } = await seedDraft(t, accountId, { expiresInMin: -1 });

  expect(await claim(t, draftId, accountId, userId)).toEqual({
    ok: false,
    blocked: "expired",
  });
  const row = await t.run((ctx) => ctx.db.get(draftId));
  expect(row!.status).toBe("pending");
});

test("a customer reply since drafting blocks the send", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedMember(t, "agent");
  const { draftId, conversationId } = await seedDraft(t, accountId);
  // They answered a minute ago; the draft was written 30 minutes ago.
  await t.run((ctx) => ctx.db.patch(conversationId, { lastMessageAt: Date.now() - MIN }));

  expect(await claim(t, draftId, accountId, userId)).toEqual({
    ok: false,
    blocked: "customer_replied",
  });
});

test("do-not-contact set after drafting blocks the send", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedMember(t, "agent");
  const { draftId, contactId, conversationId } = await seedDraft(t, accountId);
  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      conversationId,
      noteText: "Asked us to stop",
    });
    await ctx.db.patch(contactId, { doNotContact: { at: Date.now(), noteId } });
  });

  expect(await claim(t, draftId, accountId, userId)).toEqual({
    ok: false,
    blocked: "do_not_contact",
  });
});

test("opting out after drafting blocks the send", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedMember(t, "agent");
  const { draftId, conversationId, contactId } = await seedDraft(t, accountId);
  // The qualification engine's opt-out path records it on the SESSION —
  // it never writes `contacts.doNotContact`, which is why the send gate
  // has to look here too.
  await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId,
      conversationId,
      contactId,
      status: "opted_out",
      origin: "inbound",
      fields: [],
      expectedCount: 0,
      answeredCount: 0,
      followUpsSent: 0,
      phrasingCursor: 0,
      sendAttemptErrors: 0,
    }),
  );

  expect(await claim(t, draftId, accountId, userId)).toEqual({
    ok: false,
    blocked: "opted_out",
  });
  expect((await t.run((ctx) => ctx.db.get(draftId)))!.status).toBe("pending");
});

test("a human pausing AI does not block the send — that is not an opt-out", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedMember(t, "agent");
  const { draftId, conversationId } = await seedDraft(t, accountId);
  await t.run((ctx) =>
    ctx.db.patch(conversationId, { aiAutoreplyDisabled: true }),
  );

  expect((await claim(t, draftId, accountId, userId)).ok).toBe(true);
});

test("snoozing or archiving after drafting blocks the send", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedMember(t, "agent");
  const a = await seedDraft(t, accountId);
  const b = await seedDraft(t, accountId);
  await t.run(async (ctx) => {
    await ctx.db.patch(a.conversationId, { snoozedUntil: Date.now() + HOUR });
    await ctx.db.patch(b.conversationId, { archivedAt: Date.now() });
  });

  expect((await claim(t, a.draftId, accountId, userId)).ok).toBe(false);
  expect((await claim(t, b.draftId, accountId, userId)).ok).toBe(false);
});

test("an edited body is what gets recorded as sent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedMember(t, "agent");
  const { draftId } = await seedDraft(t, accountId);

  const result = await claim(t, draftId, accountId, userId, "Rewritten by a human");
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.body).toBe("Rewritten by a human");

  // The row must show what actually went out, not what the agent wrote.
  const row = await t.run((ctx) => ctx.db.get(draftId));
  expect(row!.body).toBe("Rewritten by a human");
});

test("a blank edit falls back to the drafted body rather than sending nothing", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedMember(t, "agent");
  const { draftId } = await seedDraft(t, accountId);

  const result = await claim(t, draftId, accountId, userId, "   ");
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.body).toBe("Hi Ravi, still planning Dubai?");
});

test("releaseClaim puts a failed dispatch back in the queue", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedMember(t, "agent");
  const { draftId } = await seedDraft(t, accountId);

  await claim(t, draftId, accountId, userId);
  await t.mutation(internal.revival.releaseClaim, { draftId });

  const row = await t.run((ctx) => ctx.db.get(draftId));
  expect(row!.status).toBe("pending");
  expect(row!.reviewedByUserId).toBeUndefined();
});

test("dismiss records who declined, and cannot be repeated", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "agent");
  const { draftId } = await seedDraft(t, accountId);

  await as.mutation(api.revival.dismiss, { draftId });
  const row = await t.run((ctx) => ctx.db.get(draftId));
  expect(row!.status).toBe("dismissed");
  expect(row!.reviewedByUserId).toBe(userId);

  await expect(as.mutation(api.revival.dismiss, { draftId })).rejects.toMatchObject({
    data: { code: "ALREADY_ACTIONED" },
  });
});

test("a viewer may not dismiss", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "viewer");
  const { draftId } = await seedDraft(t, accountId);

  await expect(
    as.mutation(api.revival.dismiss, { draftId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});

// ============================================================
// Expiry. The queue is capped at 100 and the index reads oldest-first,
// so a table full of dead drafts does not merely look untidy — it pushes
// every sendable draft past the cap. Prod reached 361 pending, 311 of
// them past their window, and the 50 live ones were unreachable.
// ============================================================

test("the queue hides a draft whose 24h window has already closed", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "admin");
  await seedDraft(t, accountId, { expiresInMin: -60 });

  const result = await as.query(api.revival.queue, {});
  expect(result.drafts).toEqual([]);
});

test("the queue puts the newest draft first, so a fresh one is never buried", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "admin");
  const older = await seedDraft(t, accountId, { expiresInMin: 30 });
  const newer = await seedDraft(t, accountId, { expiresInMin: 600 });

  const result = await as.query(api.revival.queue, {});
  expect(result.drafts.map((d) => d.id)).toEqual([newer.draftId, older.draftId]);
});

test("reaping flips a draft past its window to expired", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedMember(t, "admin");
  const { draftId } = await seedDraft(t, accountId, { expiresInMin: -60 });

  await t.mutation(internal.revivalEngine.reapExpired, { accountId });

  const row = await t.run((ctx) => ctx.db.get(draftId));
  expect(row!.status).toBe("expired");
});

test("reaping leaves a draft still inside its window pending", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedMember(t, "admin");
  const { draftId } = await seedDraft(t, accountId, { expiresInMin: 120 });

  await t.mutation(internal.revivalEngine.reapExpired, { accountId });

  const row = await t.run((ctx) => ctx.db.get(draftId));
  expect(row!.status).toBe("pending");
});

test("reaping never touches another account's backlog", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedMember(t, "admin");
  const other = await seedMember(t, "admin");
  const { draftId } = await seedDraft(t, other.accountId, { expiresInMin: -60 });

  await t.mutation(internal.revivalEngine.reapExpired, { accountId });

  const row = await t.run((ctx) => ctx.db.get(draftId));
  expect(row!.status).toBe("pending");
});

test("reaping is bounded, and says so when it hits the cap", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedMember(t, "admin");
  for (let i = 0; i < REAP_CAP + 1; i++) {
    await seedDraft(t, accountId, { expiresInMin: -60 });
  }

  const first = await t.mutation(internal.revivalEngine.reapExpired, { accountId });
  expect(first).toEqual({ reaped: REAP_CAP, more: true });

  const second = await t.mutation(internal.revivalEngine.reapExpired, { accountId });
  expect(second).toEqual({ reaped: 1, more: false });
});
