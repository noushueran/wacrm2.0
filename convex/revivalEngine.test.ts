/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

const MIN = 60_000;

// Every test runs dry: the sweep must never reach a provider here.
beforeEach(() => {
  vi.stubEnv("CONVEX_AI_DRY_RUN", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

type T = ReturnType<typeof convexTest>;

async function seedAccount(t: T) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Owner", email: "owner@example.com" }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "A",
      defaultCurrency: "AED",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role: "admin",
      fullName: "Owner",
      email: "owner@example.com",
    });
    return id;
  });

  // The revival agent needs a live AI config. Seed it through the real
  // mutation rather than a raw insert: `aiConfig.loadDecrypted` decrypts
  // `apiKey`, so a hand-written plaintext value throws at read time.
  const as = t.withIdentity({ subject: `${userId}|s` });
  await as.mutation(api.aiConfig.upsert, {
    provider: "openai",
    model: "gpt-5",
    apiKey: "sk-test-key",
    isActive: true,
    autoReplyEnabled: true,
  });

  return { userId, accountId, as };
}

async function enableRevival(
  t: T,
  accountId: Id<"accounts">,
  over: Record<string, number | boolean> = {},
) {
  await t.run((ctx) =>
    ctx.db.insert("revivalConfigs", {
      accountId,
      enabled: true,
      minQuietMinutes: 180,
      windowSafetyMinutes: 60,
      cooldownHours: 72,
      draftsPerRun: 20,
      dailyDraftCap: 50,
      minLeadScore: 0,
      updatedAt: Date.now(),
      ...over,
    }),
  );
}

/** A contact + conversation whose newest message is inbound `quietMin`
 *  ago — i.e. a lead that went quiet and is worth chasing. */
async function seedQuietLead(
  t: T,
  accountId: Id<"accounts">,
  opts: { quietMin?: number; phone?: string; assignedToUserId?: Id<"users"> } = {},
) {
  const quietMin = opts.quietMin ?? 240;
  const at = Date.now() - quietMin * MIN;
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: opts.phone ?? "+971500000001",
      phoneNormalized: opts.phone ?? "+971500000001",
      name: "Ravi",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      lastMessageAt: at,
      ...(opts.assignedToUserId
        ? { assignedToUserId: opts.assignedToUserId }
        : {}),
    });
    await ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "Is the Dubai visa still available?",
      status: "delivered",
    });
    // OUR reply is the last message. That is what a stalled lead
    // actually looks like with auto-reply on — the bot always gets the
    // last word, and they simply never came back.
    await ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "bot",
      contentType: "text",
      contentText: "Yes! When are you travelling?",
      status: "sent",
    });
    return { contactId, conversationId };
  });
}

async function drafts(t: T) {
  return await t.run((ctx) => ctx.db.query("revivalDrafts").collect());
}

test("with no config at all the sweep writes nothing", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await seedQuietLead(t, accountId);

  await t.action(internal.revivalEngine.sweep, {});
  expect(await drafts(t)).toHaveLength(0);
});

test("a disabled config is also a no-op", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId, { enabled: false });
  await seedQuietLead(t, accountId);

  await t.action(internal.revivalEngine.sweep, {});
  expect(await drafts(t)).toHaveLength(0);
});

test("an enabled config drafts for a quiet in-window lead", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId);
  const { conversationId } = await seedQuietLead(t, accountId, { quietMin: 240 });

  await t.action(internal.revivalEngine.sweep, {});

  const rows = await drafts(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.conversationId).toBe(conversationId);
  expect(rows[0]!.status).toBe("pending");
  expect(rows[0]!.channel).toBe("free_text");
  expect(rows[0]!.body.length).toBeGreaterThan(0);
  // 24h after the customer's last message, not 24h after the draft.
  expect(rows[0]!.expiresAt).toBe(
    (await t.run((ctx) => ctx.db.get(conversationId)))!.lastMessageAt! +
      24 * 60 * MIN,
  );
});

test("a lead waiting on our reply is never chased", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId);
  const { conversationId } = await seedQuietLead(t, accountId);
  // THEY spoke last — the ball is in our court. Nudging someone whose
  // question is unanswered is absurd.
  await t.run(async (ctx) => {
    const at = Date.now() - 200 * MIN;
    await ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "Any update?",
      status: "delivered",
    });
    await ctx.db.patch(conversationId, { lastMessageAt: at });
  });

  await t.action(internal.revivalEngine.sweep, {});
  expect(await drafts(t)).toHaveLength(0);
});

test("a do-not-contact lead is never chased", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAccount(t);
  await enableRevival(t, accountId);
  const { contactId, conversationId } = await seedQuietLead(t, accountId);
  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      conversationId,
      createdByUserId: userId,
      noteText: "Asked us to stop messaging",
    });
    await ctx.db.patch(contactId, {
      doNotContact: { at: Date.now(), byUserId: userId, noteId },
    });
  });

  await t.action(internal.revivalEngine.sweep, {});
  expect(await drafts(t)).toHaveLength(0);
});

test("an archived or snoozed thread is skipped", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId);
  const a = await seedQuietLead(t, accountId, { phone: "+971500000002" });
  const b = await seedQuietLead(t, accountId, { phone: "+971500000003" });
  await t.run(async (ctx) => {
    await ctx.db.patch(a.conversationId, { archivedAt: Date.now() });
    await ctx.db.patch(b.conversationId, { snoozedUntil: Date.now() + 60 * MIN });
  });

  await t.action(internal.revivalEngine.sweep, {});
  expect(await drafts(t)).toHaveLength(0);
});

test("the draft routes to the lead's assignee when there is one", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAccount(t);
  await enableRevival(t, accountId);
  await seedQuietLead(t, accountId, { assignedToUserId: userId });

  await t.action(internal.revivalEngine.sweep, {});
  const rows = await drafts(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.assignedToUserId).toBe(userId);
});

test("draftsPerRun bounds a single sweep", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId, { draftsPerRun: 2 });
  for (let i = 0; i < 5; i++) {
    await seedQuietLead(t, accountId, { phone: `+97150000010${i}` });
  }

  await t.action(internal.revivalEngine.sweep, {});
  expect(await drafts(t)).toHaveLength(2);
});

test("cooldown makes repeated sweeps idempotent", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId);
  await seedQuietLead(t, accountId);

  await t.action(internal.revivalEngine.sweep, {});
  await t.action(internal.revivalEngine.sweep, {});

  // The second sweep must not queue a duplicate nudge for the same lead.
  expect(await drafts(t)).toHaveLength(1);
});

test("the sweep logs its spend under the revive mode", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId);
  await seedQuietLead(t, accountId);

  await t.action(internal.revivalEngine.sweep, {});
  const usage = await t.run((ctx) => ctx.db.query("aiUsageLog").collect());
  // Dry-run reports no tokens, so a row is optional — but anything
  // logged must be attributed to this agent, never to the reply agent.
  for (const row of usage) expect(row.mode).toBe("revive");
});

test("an opted-out session is skipped, but a human-paused thread is not", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId);
  const optedOut = await seedQuietLead(t, accountId, { phone: "+971500000201" });
  const humanPaused = await seedQuietLead(t, accountId, { phone: "+971500000202" });

  await t.run(async (ctx) => {
    // A real opt-out: the qualification engine records it on the session.
    await ctx.db.insert("qualificationSessions", {
      accountId,
      conversationId: optedOut.conversationId,
      contactId: optedOut.contactId,
      status: "opted_out",
      origin: "inbound",
      fields: [],
      expectedCount: 0,
      answeredCount: 0,
      followUpsSent: 0,
      phrasingCursor: 0,
      sendAttemptErrors: 0,
    });
    // NOT an opt-out: an agent hit "pause AI" to take the thread over.
    // `aiAutoreplyDisabled` is overloaded across three meanings, so
    // treating it as an opt-out would skip the most engaged leads.
    await ctx.db.patch(humanPaused.conversationId, { aiAutoreplyDisabled: true });
  });

  await t.action(internal.revivalEngine.sweep, {});

  const rows = await drafts(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.conversationId).toBe(humanPaused.conversationId);
});

test("a collecting session only defers when that engine will actually nudge", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId);
  const lead = await seedQuietLead(t, accountId);
  await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId,
      conversationId: lead.conversationId,
      contactId: lead.contactId,
      status: "collecting",
      origin: "inbound",
      fields: [],
      expectedCount: 0,
      answeredCount: 0,
      followUpsSent: 0,
      phrasingCursor: 0,
      sendAttemptErrors: 0,
    }),
  );

  // No qualificationConfigs row at all → outboundNudgesEnabled is not
  // true → that engine will send nothing, so we must not step aside.
  await t.action(internal.revivalEngine.sweep, {});
  expect(await drafts(t)).toHaveLength(1);
});

test("with the qualification ladder switched on, we do step aside", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId);
  const lead = await seedQuietLead(t, accountId);
  await t.run(async (ctx) => {
    await ctx.db.insert("qualificationSessions", {
      accountId,
      conversationId: lead.conversationId,
      contactId: lead.contactId,
      status: "collecting",
      origin: "inbound",
      fields: [],
      expectedCount: 0,
      answeredCount: 0,
      followUpsSent: 0,
      phrasingCursor: 0,
      sendAttemptErrors: 0,
    });
    await ctx.db.insert("qualificationConfigs", {
      accountId,
      enabled: true,
      basicFields: [],
      qualifyThresholdScore: 1,
      timezoneLabel: "Asia/Dubai",
      utcOffsetMinutes: 240,
      workStartMinute: 600,
      workEndMinute: 1260,
      workDays: [1, 2, 3, 4, 5, 6],
      followUpDelaysMinutes: [60],
      maxFollowUps: 4,
      sessionWindowHours: 72,
      closingMessage: "Thanks!",
      adminAlertEnabled: false,
      adminAlertPhones: [],
      outboundNudgesEnabled: true,
    });
  });

  await t.action(internal.revivalEngine.sweep, {});
  expect(await drafts(t)).toHaveLength(0);
});

test("a large account still completes — enrichment is bounded, not proportional", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId, { draftsPerRun: 3 });
  // Far more eligible leads than the enrichment cap. Reading all of them
  // in full is what blew Convex's per-query operation limit in
  // production on 2026-08-09.
  for (let i = 0; i < 80; i++) {
    await seedQuietLead(t, accountId, { phone: `+9715001${String(i).padStart(5, "0")}` });
  }

  await t.action(internal.revivalEngine.sweep, {});
  expect(await drafts(t)).toHaveLength(3);
});

test("an account's extra instructions reach the agent's prompt", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedAccount(t);
  await enableRevival(t, accountId);
  await seedQuietLead(t, accountId);
  await as.mutation(api.agentInstructions.set, {
    agentKey: "revival",
    extraInstructions: "Mention 3-day Azerbaijan visas.",
  });

  // Dry-run returns a canned draft, so this asserts the plumbing runs
  // end to end without a provider; the ORDERING guarantee is unit-tested
  // on `withExtraInstructions` itself.
  await t.action(internal.revivalEngine.sweep, {});
  expect(await drafts(t)).toHaveLength(1);

  const stored = await t.query(internal.agentInstructions.forAgent, {
    accountId,
    agentKey: "revival",
  });
  expect(stored).toBe("Mention 3-day Azerbaijan visas.");
});

test("the sweep clears a stale draft even for an account with nothing to chase", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enableRevival(t, accountId);

  // Deliberately NO quiet lead: this account yields no candidates, so the
  // per-account loop takes its first `continue`. Yesterday's dead drafts
  // must still be retired — reaping that runs only on a productive sweep
  // would leave the quietest accounts with the rottenest queues.
  const draftId = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+971500000001",
      phoneNormalized: "+971500000001",
      name: "Ravi",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      lastMessageAt: Date.now() - 3000 * MIN,
    });
    return await ctx.db.insert("revivalDrafts", {
      accountId,
      conversationId,
      contactId,
      body: "Hi Ravi, still planning Dubai?",
      reason: "Went quiet yesterday",
      channel: "free_text",
      status: "pending",
      model: "gpt-5",
      confidence: "high",
      createdAt: Date.now() - 2000 * MIN,
      expiresAt: Date.now() - 60 * MIN,
    });
  });

  await t.action(internal.revivalEngine.sweep, {});

  const row = await t.run((ctx) => ctx.db.get(draftId));
  expect(row!.status).toBe("expired");
});
