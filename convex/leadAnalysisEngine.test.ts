import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import {
  armOnOutbound,
  SEQUENCE_RESCHEDULE_DEFER_MS,
  SEQUENCE_SWEEP_LIMIT,
} from "./leadAnalysisEngine";
import { firstTouchAt } from "./lib/leadAnalysis/sequenceSchedule";
import { defaultLeadAnalysisConfig } from "./lib/leadAnalysis/defaults";
import { dayStartFor } from "./lib/leadAnalysis/sendRate";

const modules = import.meta.glob("/convex/**/*.ts");

// Matches `seedConversation`'s seeded contact below — a normal customer
// number, never an admin-alert number, for every `onInbound` call that
// isn't specifically exercising the Fix 6 admin-channel guard.
const CUSTOMER_PHONE = "971500000001";

async function seedAccount(t: ReturnType<typeof convexTest>) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Owner", email: "o@x.com" }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "Acct", defaultCurrency: "AED", ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId, accountId: id, role: "owner", fullName: "Owner", email: "o@x.com",
    });
    return id;
  });
  return { userId, accountId };
}

async function seedConversation(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000001", phoneNormalized: "971500000001", name: "Asha",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0, lastMessageAt: Date.now(),
    });
    return { contactId, conversationId };
  });
}

async function enable(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  const { defaultLeadAnalysisConfig } = await import("./lib/leadAnalysis/defaults");
  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(), accountId, enabled: true,
    }),
  );
}

test("onInbound no-ops while the feature is disabled", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: CUSTOMER_PHONE,
  });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(0);
});

test("onInbound creates a pending row with a debounced due time", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  const before = Date.now();
  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: CUSTOMER_PHONE,
  });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].scoreStatus).toBe("pending");
  expect(rows[0].sequenceStatus).toBe("idle");
  expect(rows[0].attempts).toBe(0);
  expect(rows[0].followUpsSent).toBe(0);
  // Default debounce is 10 minutes.
  expect(rows[0].rescoreDueAt!).toBeGreaterThanOrEqual(before + 10 * 60_000);
});

test("a burst of inbounds pushes the same row's timer — never a second row", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: CUSTOMER_PHONE,
  });
  const first = (await t.run((ctx) => ctx.db.query("leadAnalyses").collect()))[0];

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: CUSTOMER_PHONE,
  });
  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());

  expect(rows).toHaveLength(1);
  expect(rows[0]._id).toBe(first._id);
  expect(rows[0].rescoreDueAt!).toBeGreaterThanOrEqual(first.rescoreDueAt!);
});

test("onInbound re-arms an already-scored row", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: CUSTOMER_PHONE,
  });
  const id = (await t.run((ctx) => ctx.db.query("leadAnalyses").collect()))[0]._id;
  await t.run((ctx) =>
    ctx.db.patch(id, {
      scoreStatus: "scored", score: 6, rescoreDueAt: undefined, scoredThroughMs: 3,
    }),
  );

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: CUSTOMER_PHONE,
  });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row!.scoreStatus).toBe("pending");
  expect(row!.rescoreDueAt).toBeDefined();
  // The previous score stays visible on the board until the re-score lands.
  expect(row!.score).toBe(6);
});

test("onInbound re-arms a failed row and resets its attempt budget", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: CUSTOMER_PHONE,
  });
  const id = (await t.run((ctx) => ctx.db.query("leadAnalyses").collect()))[0]._id;
  await t.run((ctx) =>
    ctx.db.patch(id, { scoreStatus: "failed", attempts: 5, rescoreDueAt: undefined }),
  );

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: CUSTOMER_PHONE,
  });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row!.scoreStatus).toBe("pending");
  expect(row!.attempts).toBe(0);
});

// ------------------------------------------------------------------
// Fix 6 (final whole-branch review): the spec says the admin alert
// channel never enters the section, but admin inbound messages arrive
// as `senderType: "customer"` like any other inbound, so without this
// guard the admin thread gets a `leadAnalyses` row, gets scored, and
// shows up at the top of the board as a non-lead. Reuses
// `isAdminAlertNumber` from `lib/qualification/track.ts` — the same
// definition `qualificationEngine.ts`'s own loop guard uses — rather
// than inventing a second one.
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// Mirror invariant (P2 review, "Lead Analysis P2"): `leadAnalyses.archived`
// must reflect `conversations.archivedAt` on every insert path. `onInbound`
// is partly self-correcting because an inbound also triggers un-archive
// elsewhere, but that is a separate best-effort call — this insert path
// must not depend on it. See the SYNC INVARIANT comment on
// `leadAnalyses.archived` in schema.ts.
// ------------------------------------------------------------------
test("onInbound's create-path mirrors archived: true for an archived conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(conversationId, { archivedAt: Date.now() }));

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: CUSTOMER_PHONE,
  });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].archived).toBe(true);
});

test("onInbound never creates a row for a configured admin alert phone", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const adminPhone = "+971559998888";
  const { defaultQualificationConfig } = await import("./lib/qualification/defaults");
  await t.run((ctx) =>
    ctx.db.insert("qualificationConfigs", {
      accountId,
      ...defaultQualificationConfig(),
      adminAlertPhones: [adminPhone],
    }),
  );

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: "971559998888",
  });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(0);
});

test("onInbound still creates a row for a non-admin phone even when admin numbers are configured", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const { defaultQualificationConfig } = await import("./lib/qualification/defaults");
  await t.run((ctx) =>
    ctx.db.insert("qualificationConfigs", {
      accountId,
      ...defaultQualificationConfig(),
      adminAlertPhones: ["+971559998888"],
    }),
  );

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: CUSTOMER_PHONE,
  });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(1);
});

// ------------------------------------------------------------------
// Fix A (final whole-branch review): the loop guard must key off the
// FULL staff set (`loadStaffPhoneSet` + `isStaffNumber` from
// `lib/qualification/track.ts`) — admin alert phones PLUS every
// membership's own phone — not just `isAdminAlertNumber`, which only
// covers the admin alert phones. `qualificationEngine.onInbound` uses
// the full staff set for exactly this reason (`track.ts`: "a staff
// chat must never become a lead"). Without this, a team member who
// messages the business number from their own WhatsApp gets a
// `leadAnalyses` row scored on every debounce window.
// ------------------------------------------------------------------
test("onInbound never creates a row for a team member's own membership phone", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const memberPhone = "+971544445555";
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Agent P", email: "ap@example.com" });
    await ctx.db.insert("memberships", {
      userId, accountId, role: "agent", fullName: "Agent P", email: "ap@example.com",
      phone: memberPhone,
    });
  });

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: "971544445555",
  });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(0);
});

async function seedPendingRow(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  dueAt: number,
) {
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await t.run((ctx) =>
    ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "pending" as const, rescoreDueAt: dueAt, attempts: 0,
      sequenceStatus: "idle" as const, followUpsSent: 0,
    }),
  );
  return { analysisId, conversationId, contactId };
}

test("claimDueForScoring returns only rows already due", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const due = await seedPendingRow(t, accountId, Date.now() - 1000);
  await seedPendingRow(t, accountId, Date.now() + 3_600_000);

  const claimed = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 10,
  });

  expect(claimed.map((c) => c.analysisId)).toEqual([due.analysisId]);
});

test("claimDueForScoring honours its limit", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  for (let i = 0; i < 5; i++) await seedPendingRow(t, accountId, Date.now() - 1000);

  const claimed = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 2,
  });

  expect(claimed).toHaveLength(2);
});

test("claiming leases a row so an overlapping sweep cannot double-score it", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await seedPendingRow(t, accountId, Date.now() - 1000);

  const first = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 10,
  });
  const second = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 10,
  });

  expect(first).toHaveLength(1);
  expect(second).toHaveLength(0);
});

test("applyScore writes the score, band, and dedup timestamp", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);

  await t.mutation(internal.leadAnalysisEngine.applyScore, {
    analysisId,
    score: 9,
    reason: "Gave dates and budget",
    signals: ["dates_given"],
    model: "gpt-test",
    throughMs: 12,
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.scoreStatus).toBe("scored");
  expect(row!.score).toBe(9);
  expect(row!.band).toBe("hot");
  expect(row!.reason).toBe("Gave dates and budget");
  expect(row!.signals).toEqual(["dates_given"]);
  expect(row!.scoredThroughMs).toBe(12);
  expect(row!.model).toBe("gpt-test");
  expect(row!.scoredAt).toBeDefined();
  // Leaves the sweep partition.
  expect(row!.rescoreDueAt).toBeUndefined();
  expect(row!.attempts).toBe(0);
});

test("applyScore bands a mid score as warm and a low score as cold", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const warm = await seedPendingRow(t, accountId, Date.now() - 1000);
  const cold = await seedPendingRow(t, accountId, Date.now() - 1000);

  await t.mutation(internal.leadAnalysisEngine.applyScore, {
    analysisId: warm.analysisId, score: 5, reason: "x", signals: [],
    model: "m", throughMs: 1,
  });
  await t.mutation(internal.leadAnalysisEngine.applyScore, {
    analysisId: cold.analysisId, score: 2, reason: "x", signals: [],
    model: "m", throughMs: 1,
  });

  expect((await t.run((ctx) => ctx.db.get(warm.analysisId)))!.band).toBe("warm");
  expect((await t.run((ctx) => ctx.db.get(cold.analysisId)))!.band).toBe("cold");
});

test("markUnchanged scores the row without touching the previous verdict", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  await t.run((ctx) => ctx.db.patch(analysisId, { score: 7, band: "warm" as const }));

  await t.mutation(internal.leadAnalysisEngine.markUnchanged, {
    analysisId, throughMs: 4,
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.scoreStatus).toBe("scored");
  expect(row!.score).toBe(7);
  expect(row!.scoredThroughMs).toBe(4);
  expect(row!.rescoreDueAt).toBeUndefined();
});

// Fix 4 (final whole-branch review): a row that failed twice, re-armed,
// then dedup-short-circuited here must not keep the stale error string
// forever on a now-"scored" row — `lastError` is the field the owner
// reads when debugging cost.
test("markUnchanged clears a stale lastError from an earlier failure", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  await t.run((ctx) =>
    ctx.db.patch(analysisId, { lastError: "provider 429", attempts: 2 }),
  );

  await t.mutation(internal.leadAnalysisEngine.markUnchanged, {
    analysisId, throughMs: 4,
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.lastError).toBeUndefined();
});

test("recordScoreFailure retries with backoff below the attempt cap", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);

  await t.mutation(internal.leadAnalysisEngine.recordScoreFailure, {
    analysisId, error: "provider 429",
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.scoreStatus).toBe("pending");
  expect(row!.attempts).toBe(1);
  expect(row!.lastError).toBe("provider 429");
  expect(row!.rescoreDueAt!).toBeGreaterThan(Date.now());
});

test("recordScoreFailure retires the row at the attempt cap", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  await t.run((ctx) => ctx.db.patch(analysisId, { attempts: 2 }));

  await t.mutation(internal.leadAnalysisEngine.recordScoreFailure, {
    analysisId, error: "provider down",
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.scoreStatus).toBe("failed");
  // A retired row LEAVES the sweep partition so it can never be re-read.
  expect(row!.rescoreDueAt).toBeUndefined();
});

test("a retired row is invisible to the next claim", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  await t.run((ctx) => ctx.db.patch(analysisId, { attempts: 2 }));
  await t.mutation(internal.leadAnalysisEngine.recordScoreFailure, {
    analysisId, error: "gone",
  });

  const claimed = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 10,
  });
  expect(claimed).toHaveLength(0);
});

// Task 9 (P3): `loadScoreInput` feeds the contact's own notes into
// scoring as real text (never a closed-vocabulary summary — this is the
// one AI job whose output only an agent reads). These exercise the
// query directly rather than through `sweepScoring`, since the sweep's
// existing tests all run under `CONVEX_AI_DRY_RUN` and never inspect the
// assembled system prompt.
test("loadScoreInput surfaces the contact's own notes, newest first", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId, contactId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  await t.run(async (ctx) => {
    await ctx.db.insert("contactNotes", {
      accountId, contactId, kind: "meeting" as const,
      noteText: "met him at the office, ready to book",
    });
    await ctx.db.insert("contactNotes", {
      accountId, contactId, kind: "call" as const,
      noteText: "waiting on his passport copy",
    });
  });

  const input = await t.query(internal.leadAnalysisEngine.loadScoreInput, { analysisId });

  expect(input!.agentNotes.some((n) => n.includes("ready to book"))).toBe(true);
  // Inserted second, so it has the later `_creationTime` — newest first.
  expect(input!.agentNotes[0]).toContain("waiting on his passport copy");
});

test("loadScoreInput's agentNotes is empty when the contact has no notes", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);

  const input = await t.query(internal.leadAnalysisEngine.loadScoreInput, { analysisId });

  expect(input!.agentNotes).toEqual([]);
});

test("loadScoreInput caps agentNotes so a chatty thread can't inflate token spend", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId, contactId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  await t.run(async (ctx) => {
    for (let i = 0; i < 15; i++) {
      await ctx.db.insert("contactNotes", {
        accountId, contactId, kind: "general" as const, noteText: `note ${i}`,
      });
    }
  });

  const input = await t.query(internal.leadAnalysisEngine.loadScoreInput, { analysisId });

  expect(input!.agentNotes.length).toBeLessThanOrEqual(10);
});

async function seedAiConfig(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  await t.run((ctx) =>
    ctx.db.insert("aiConfigs", {
      accountId, provider: "openai" as const, model: "gpt-test",
      apiKey: "unused-under-dry-run", isActive: true, autoReplyEnabled: false,
    }),
  );
}

async function seedCustomerMessage(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  text: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId, conversationId, senderType: "customer" as const,
      contentType: "text" as const, contentText: text, status: "delivered" as const,
    }),
  );
}

test("sweepScoring scores a due row end to end under dry run", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccount(t);
    await enable(t, accountId);
    await seedAiConfig(t, accountId);
    const { analysisId, conversationId } = await seedPendingRow(
      t, accountId, Date.now() - 1000,
    );
    await seedCustomerMessage(t, accountId, conversationId, "Goa in December, 2 adults");
    const newestMessage = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .order("desc")
        .first(),
    );

    await t.action(internal.leadAnalysisEngine.sweepScoring, {});

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.scoreStatus).toBe("scored");
    expect(row!.score).toBeGreaterThanOrEqual(1);
    expect(row!.score).toBeLessThanOrEqual(10);
    expect(row!.band).toBeDefined();
    expect(row!.scoredThroughMs).toBe(newestMessage!._creationTime);
  } finally {
    delete process.env.CONVEX_AI_DRY_RUN;
  }
});

test("sweepScoring skips the LLM when the newest message hasn't moved", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccount(t);
    await enable(t, accountId);
    await seedAiConfig(t, accountId);
    const { analysisId, conversationId } = await seedPendingRow(
      t, accountId, Date.now() - 1000,
    );
    await seedCustomerMessage(t, accountId, conversationId, "hello");
    const newestMessage = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .order("desc")
        .first(),
    );
    await t.run((ctx) =>
      ctx.db.patch(analysisId, {
        scoredThroughMs: newestMessage!._creationTime, score: 4, band: "warm" as const,
      }),
    );

    await t.action(internal.leadAnalysisEngine.sweepScoring, {});

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.scoreStatus).toBe("scored");
    expect(row!.score).toBe(4); // untouched — no call was made
    const usage = await t.run((ctx) => ctx.db.query("aiUsageLog").collect());
    expect(usage).toHaveLength(0);
  } finally {
    delete process.env.CONVEX_AI_DRY_RUN;
  }
});

test("sweepScoring skips a conversation with no customer message", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccount(t);
    await enable(t, accountId);
    await seedAiConfig(t, accountId);
    const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);

    await t.action(internal.leadAnalysisEngine.sweepScoring, {});

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.scoreStatus).toBe("skipped");
    expect(row!.rescoreDueAt).toBeUndefined();
  } finally {
    delete process.env.CONVEX_AI_DRY_RUN;
  }
});

test("sweepScoring retires a row whose account has no AI config", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccount(t);
    await enable(t, accountId);
    const { analysisId, conversationId } = await seedPendingRow(
      t, accountId, Date.now() - 1000,
    );
    await seedCustomerMessage(t, accountId, conversationId, "hi");

    await t.action(internal.leadAnalysisEngine.sweepScoring, {});

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.attempts).toBeGreaterThan(0);
    expect(row!.lastError).toContain("ai_config");
  } finally {
    delete process.env.CONVEX_AI_DRY_RUN;
  }
});

test("sweepScoring is a no-op when nothing is due", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccount(t);
    await enable(t, accountId);
    await seedAiConfig(t, accountId);
    await seedPendingRow(t, accountId, Date.now() + 3_600_000);

    // A Convex action's implicit `undefined` return always comes back
    // as `null` through convex-test's wire serialization (confirmed by
    // running this against the real handler) — `.resolves.toBeNull()`
    // is the correct way to assert "resolved without throwing, no work
    // done" here, not `.toBeUndefined()`.
    await expect(
      t.action(internal.leadAnalysisEngine.sweepScoring, {}),
    ).resolves.toBeNull();
  } finally {
    delete process.env.CONVEX_AI_DRY_RUN;
  }
});

// ------------------------------------------------------------------
// Fix 2 (final whole-branch review): `enabled: false` must be a REAL
// kill switch even for rows already claimed by a sweep in flight — no
// LLM call spent, and the row must not be retired or lose attempt
// budget, since a disabled account may be re-enabled at any time.
// ------------------------------------------------------------------
test("sweepScoring spends no LLM call on a claimed row whose account is currently disabled", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { defaultLeadAnalysisConfig } = await import("./lib/leadAnalysis/defaults");
  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(), accountId, enabled: false,
    }),
  );
  const { analysisId, conversationId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  await seedCustomerMessage(t, accountId, conversationId, "hi");

  await t.action(internal.leadAnalysisEngine.sweepScoring, {});

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  // Not retired, not touched — a disabled account's claimed rows must
  // come out of the sweep exactly as they went in.
  expect(row!.scoreStatus).toBe("pending");
  expect(row!.attempts).toBe(0);
  expect(row!.lastError).toBeUndefined();
  const usage = await t.run((ctx) => ctx.db.query("aiUsageLog").collect());
  expect(usage).toHaveLength(0);
});

// ------------------------------------------------------------------
// Fix B (final whole-branch review): the previous behaviour set
// `rescoreDueAt: Date.now()` on release — immediately due again. An
// account disabled AFTER accumulating a backlog therefore had its rows
// claimed and released on EVERY 5-minute sweep forever (`crons.ts`'s
// `lead-scoring` interval), spending ~300 writes/hour on an account
// that isn't going anywhere and starving enabled accounts of claim
// slots. This test used to assert the OLD (buggy) "claimable again
// immediately" behaviour; it now asserts the intended backoff instead —
// the row is released (not retired, not stuck behind the sweep's own
// 20-minute claim lease forever) but is NOT immediately claimable, and
// its `rescoreDueAt` lands at a concrete future time.
// ------------------------------------------------------------------
test("a row released because its account is disabled backs off instead of being immediately due again", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { defaultLeadAnalysisConfig } = await import("./lib/leadAnalysis/defaults");
  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(), accountId, enabled: false,
    }),
  );
  const { analysisId, conversationId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  await seedCustomerMessage(t, accountId, conversationId, "hi");

  const before = Date.now();
  await t.action(internal.leadAnalysisEngine.sweepScoring, {});

  const released = await t.run((ctx) => ctx.db.get(analysisId));
  // Never invisible/leased indefinitely: still a concrete, future due
  // time in the pending partition — never `<= now`.
  expect(released!.scoreStatus).toBe("pending");
  expect(released!.rescoreDueAt).toBeDefined();
  expect(released!.rescoreDueAt!).toBeGreaterThan(before);

  // Re-enable immediately: the row must NOT be claimable yet — it is
  // backing off, not stuck at zero.
  await t.run((ctx) =>
    ctx.db
      .query("leadAnalysisConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique()
      .then((row) => ctx.db.patch(row!._id, { enabled: true })),
  );
  const claimedTooSoon = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 10,
  });
  expect(claimedTooSoon.map((c) => c.analysisId)).not.toContain(analysisId);

  // Once the backoff has elapsed, the row is claimable again — released
  // rows are never leased indefinitely.
  await t.run((ctx) => ctx.db.patch(analysisId, { rescoreDueAt: Date.now() - 1000 }));
  const claimedAfterBackoff = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 10,
  });
  expect(claimedAfterBackoff.map((c) => c.analysisId)).toContain(analysisId);
});

test("releaseClaim sets a future rescoreDueAt for a disabled-account release, not immediately due", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);

  const before = Date.now();
  await t.mutation(internal.leadAnalysisEngine.releaseClaim, {
    analysisId, reason: "disabled",
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.rescoreDueAt).toBeDefined();
  expect(row!.rescoreDueAt!).toBeGreaterThan(before);
  expect(row!.scoreStatus).toBe("pending"); // never retired
});

test("releaseClaim backs off a disabled-account release longer than an over-cap release", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId: disabledId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  const { analysisId: overCapId } = await seedPendingRow(t, accountId, Date.now() - 1000);

  await t.mutation(internal.leadAnalysisEngine.releaseClaim, {
    analysisId: disabledId, reason: "disabled",
  });
  await t.mutation(internal.leadAnalysisEngine.releaseClaim, {
    analysisId: overCapId, reason: "overCap",
  });

  const disabledRow = await t.run((ctx) => ctx.db.get(disabledId));
  const overCapRow = await t.run((ctx) => ctx.db.get(overCapId));
  // An over-cap row belongs to an ENABLED account merely over its own
  // per-run cap for this sweep — it is legitimately due again soon (the
  // very next sweep), unlike a disabled account that isn't going
  // anywhere for a while.
  expect(overCapRow!.rescoreDueAt!).toBeLessThan(disabledRow!.rescoreDueAt!);
});

// ------------------------------------------------------------------
// Fix 3 (final whole-branch review): per-account config knobs must
// actually govern the sweep — an admin lowering `backfillPerRun` (the
// lever someone reaches for when a bill spikes) previously changed
// nothing because the sweep always read the platform DEFAULT instead of
// the account's own stored row.
// ------------------------------------------------------------------
test("sweepScoring's backfill honours the account's own backfillPerRun, not the platform default", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { defaultLeadAnalysisConfig } = await import("./lib/leadAnalysis/defaults");
  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(), accountId, enabled: true, backfillPerRun: 2,
    }),
  );
  // More conversations than the account's configured cap (2) but fewer
  // than the platform default (10) — only the per-account value can
  // explain the result below.
  for (let i = 0; i < 5; i++) {
    await seedConversationAt(t, accountId, 1000 + i);
  }

  await t.action(internal.leadAnalysisEngine.sweepScoring, {});

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(2);
});

// ------------------------------------------------------------------
// Regression test for the count-based dedup saturation bug (owner
// decision 2026-07-26, docs/superpowers/plans/2026-07-26-lead-analysis-p1.md
// line 22): a `messageCount` derived from the bounded
// `.take(TRANSCRIPT_LIMIT)` slice pins at 40 forever once a conversation
// passes that length, so the old dedup (`scoredMessageCount ===
// messageCount`) would short-circuit every future re-score. This test
// seeds 45 messages (over TRANSCRIPT_LIMIT=40), scores once, appends a
// 46th, and proves the second sweep performs a genuine re-score by
// asserting `scoredThroughMs` — the newest message's `_creationTime` —
// advances. Confirmed to fail against the old count-based logic (see
// task-7-fix-report.md for the TDD red-phase run).
// ------------------------------------------------------------------
test("a conversation past TRANSCRIPT_LIMIT is still re-scored after a new message arrives", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccount(t);
    await enable(t, accountId);
    await seedAiConfig(t, accountId);
    const { analysisId, conversationId } = await seedPendingRow(
      t, accountId, Date.now() - 1000,
    );

    // Seed MORE than TRANSCRIPT_LIMIT (40) messages — each insert gets a
    // distinct, strictly increasing `_creationTime` from convex-test, so
    // the newest message is always unambiguous.
    for (let i = 0; i < 45; i++) {
      await seedCustomerMessage(t, accountId, conversationId, `msg ${i}`);
    }

    await t.action(internal.leadAnalysisEngine.sweepScoring, {});
    const firstScored = await t.run((ctx) => ctx.db.get(analysisId));
    expect(firstScored!.scoreStatus).toBe("scored");
    const firstThroughMs = firstScored!.scoredThroughMs;
    expect(firstThroughMs).toBeDefined();

    // A brand-new (46th) customer message arrives, and the row is
    // re-armed for scoring exactly as `onInbound` would do it.
    await seedCustomerMessage(t, accountId, conversationId, "the 46th message, brand new");
    const newestMessage = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .order("desc")
        .first(),
    );
    await t.run((ctx) =>
      ctx.db.patch(analysisId, { scoreStatus: "pending", rescoreDueAt: Date.now() - 1000 }),
    );

    await t.action(internal.leadAnalysisEngine.sweepScoring, {});
    const resweep = await t.run((ctx) => ctx.db.get(analysisId));

    // Proof of a genuine re-score, not a dedup short-circuit: the
    // score-through timestamp must have ADVANCED to the new newest
    // message. Under the old count-based key this could never happen
    // once the transcript slice saturated at TRANSCRIPT_LIMIT.
    expect(resweep!.scoredThroughMs).not.toBe(firstThroughMs);
    expect(resweep!.scoredThroughMs).toBe(newestMessage!._creationTime);
  } finally {
    delete process.env.CONVEX_AI_DRY_RUN;
  }
});

async function seedConversationAt(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  lastMessageAt: number,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: `+9715${lastMessageAt}`,
      phoneNormalized: `9715${lastMessageAt}`,
    });
    return await ctx.db.insert("conversations", {
      accountId, contactId, status: "open" as const, unreadCount: 0, lastMessageAt,
    });
  });
}

test("backfill enqueues historical conversations newest-first", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const oldest = await seedConversationAt(t, accountId, 1_000);
  const newest = await seedConversationAt(t, accountId, 3_000);
  await seedConversationAt(t, accountId, 2_000);

  const result = await t.mutation(internal.leadAnalysisEngine.backfillAccount, {
    accountId, limit: 1,
  });

  expect(result.enqueued).toBe(1);
  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].conversationId).toBe(newest);
  expect(rows[0].conversationId).not.toBe(oldest);
});

test("backfill resumes below the cursor instead of rescanning", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedConversationAt(t, accountId, 1_000);
  await seedConversationAt(t, accountId, 2_000);
  await seedConversationAt(t, accountId, 3_000);

  await t.mutation(internal.leadAnalysisEngine.backfillAccount, { accountId, limit: 1 });
  await t.mutation(internal.leadAnalysisEngine.backfillAccount, { accountId, limit: 1 });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(2);
  const stamps = await t.run(async (ctx) => {
    const out: number[] = [];
    for (const r of rows) {
      const c = await ctx.db.get(r.conversationId);
      out.push(c!.lastMessageAt!);
    }
    return out.sort((a, b) => a - b);
  });
  expect(stamps).toEqual([2_000, 3_000]);
});

test("backfill reports done once the account is exhausted", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedConversationAt(t, accountId, 1_000);

  await t.mutation(internal.leadAnalysisEngine.backfillAccount, { accountId, limit: 10 });
  const second = await t.mutation(internal.leadAnalysisEngine.backfillAccount, {
    accountId, limit: 10,
  });

  expect(second.enqueued).toBe(0);
  expect(second.done).toBe(true);
});

test("backfill never double-enqueues a conversation that already has a row", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const conversationId = await seedConversationAt(t, accountId, 5_000);
  const contactId = await t.run(async (ctx) =>
    (await ctx.db.get(conversationId))!.contactId,
  );
  await t.run((ctx) =>
    ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored" as const, attempts: 0,
      sequenceStatus: "idle" as const, followUpsSent: 0,
    }),
  );

  await t.mutation(internal.leadAnalysisEngine.backfillAccount, { accountId, limit: 10 });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(1);
});

// ------------------------------------------------------------------
// Fix 5 (final whole-branch review): the original cursor resumed with
// `.lt("lastMessageAt", cursor)` — strictly less-than. Any conversation
// sharing the EXACT `lastMessageAt` of the previous batch's boundary,
// but not itself included in that batch (routine after a bulk import
// stamps a whole batch with one timestamp), was skipped PERMANENTLY:
// the next call's cursor excluded that timestamp entirely. This forces
// the boundary with `limit: 1` so a tied pair is guaranteed to straddle
// two separate calls no matter how ties are broken internally.
// ------------------------------------------------------------------
test("backfill enqueues both conversations sharing an identical lastMessageAt across a batch boundary", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);

  async function seedAt(lastMessageAt: number, tag: string) {
    return await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId, phone: `+9715${lastMessageAt}${tag}`,
        phoneNormalized: `9715${lastMessageAt}${tag}`,
      });
      return await ctx.db.insert("conversations", {
        accountId, contactId, status: "open" as const, unreadCount: 0, lastMessageAt,
      });
    });
  }

  const newest = await seedAt(3_000, "a");
  // B and C tie exactly at 2_000 — the batch boundary this test forces
  // (via `limit: 1`) must land between them.
  const tiedB = await seedAt(2_000, "b");
  const tiedC = await seedAt(2_000, "c");
  const oldest = await seedAt(1_000, "d");

  // Drain the account with a limit small enough (1) that the tie at
  // 2_000 cannot possibly fit in a single batch alongside anything else
  // — repeat until backfill reports done, with a generous cap so a
  // regression that loops forever fails the test instead of hanging.
  for (let i = 0; i < 20; i++) {
    const result = await t.mutation(internal.leadAnalysisEngine.backfillAccount, {
      accountId, limit: 1,
    });
    if (result.done) break;
  }

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  const conversationIds = rows.map((r) => r.conversationId);
  expect(conversationIds).toContain(newest);
  expect(conversationIds).toContain(tiedB);
  expect(conversationIds).toContain(tiedC);
  expect(conversationIds).toContain(oldest);
  expect(rows).toHaveLength(4);
});

// ------------------------------------------------------------------
// Mirror invariant (P2 review, "Lead Analysis P2"): the backfill is the
// HIGHEST-RISK insert path — it walks the account's whole history, and
// once archiving is in use a large share of those conversations will be
// archived. `leadAnalyses.archived` must reflect `conversations.archivedAt`
// at enqueue time. See the SYNC INVARIANT comment on `leadAnalyses.archived`
// in schema.ts.
// ------------------------------------------------------------------
test("backfill mirrors archived: true when enqueueing an archived conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const conversationId = await seedConversationAt(t, accountId, 1_000);
  await t.run((ctx) => ctx.db.patch(conversationId, { archivedAt: Date.now() }));

  await t.mutation(internal.leadAnalysisEngine.backfillAccount, { accountId, limit: 10 });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].archived).toBe(true);
});

test("backfill no-ops while the feature is disabled", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await seedConversationAt(t, accountId, 1_000);

  const result = await t.mutation(internal.leadAnalysisEngine.backfillAccount, {
    accountId, limit: 10,
  });

  expect(result.enqueued).toBe(0);
  expect(await t.run((ctx) => ctx.db.query("leadAnalyses").collect())).toHaveLength(0);
});

// ------------------------------------------------------------------
// Fix C (final whole-branch review): the per-account backfill loop in
// `sweepScoring` was not wrapped in try/catch. If `backfillAccount`
// throws for one account (the known case: an oversized tie-group at a
// single `lastMessageAt` exceeding Convex's per-transaction limits —
// NOT reproduced here, deferred separately), the throw propagates out
// of `sweepScoring` and every account after the poisoned one is skipped
// THAT SWEEP TOO, indefinitely. This forces a genuine throw inside
// `backfillAccount` via an invalid `backfillPerRun: -1` (Convex's
// `.take()` rejects negative limits — confirmed empirically), seeded on
// the FIRST account so it is poisoned before the second, healthy
// account is ever reached in the same sweep.
// ------------------------------------------------------------------
test("sweepScoring's backfill isolates one account's throw so a later account in the same sweep still gets processed", async () => {
  const t = convexTest(schema, modules);
  const { defaultLeadAnalysisConfig } = await import("./lib/leadAnalysis/defaults");

  const { accountId: poisonedAccountId } = await seedAccount(t);
  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(), accountId: poisonedAccountId, enabled: true,
      backfillPerRun: -1,
    }),
  );
  await seedConversationAt(t, poisonedAccountId, 1_000);

  const { accountId: healthyAccountId } = await seedAccount(t);
  await enable(t, healthyAccountId);
  const healthyConversationId = await seedConversationAt(t, healthyAccountId, 1_000);

  // The poisoned account's own backfill call must not stop the sweep —
  // this must resolve, not throw (an unhandled throw here fails the
  // test on its own, since the `await` would reject).
  await t.action(internal.leadAnalysisEngine.sweepScoring, {});

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  // Proof the healthy account, listed AFTER the poisoned one, still got
  // its backfill run in the SAME sweep.
  expect(rows.map((r) => r.conversationId)).toContain(healthyConversationId);
});

// ============================================================
// armOnOutbound / stopOnInbound (P3 Task 6 — arm on outbound, stop on
// inbound). `armOnOutbound` is a plain function (not an
// `internalMutation`) because it runs INSIDE the same transaction as
// `messages.ts`'s `insertMessageAndUpdateConversation` — see that
// file's own wiring for the real choke-point integration. Exercised
// directly here so every skip condition gets its own focused test
// without needing a full message insert per case.
// ============================================================

/** 24/7 hours so `firstTouchAt`'s clamp is always a no-op — the tests
 *  below are about arming's OWN gates, not the working-hours math
 *  `sequenceSchedule.test.ts` already covers in isolation. */
async function seedQualificationConfig(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  overrides: Record<string, unknown> = {},
) {
  const { defaultQualificationConfig } = await import("./lib/qualification/defaults");
  await t.run((ctx) =>
    ctx.db.insert("qualificationConfigs", {
      accountId,
      ...defaultQualificationConfig(),
      enabled: true,
      utcOffsetMinutes: 0,
      workStartMinute: 0,
      workEndMinute: 1440,
      workDays: [0, 1, 2, 3, 4, 5, 6],
      ...overrides,
    }),
  );
}

/** A scored `leadAnalyses` row ready to be armed: `hot` band (steps[0]
 *  `delayDays: 2`), `sequenceStatus: "idle"`. */
async function seedArmableAnalysis(
  t: ReturnType<typeof convexTest>,
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    contactId: Id<"contacts">;
    sequenceStatus?: "idle" | "running" | "exhausted" | "stopped";
    followUpsSent?: number;
    // No default: every call site says explicitly whether the row is
    // scored into the "hot" band or (the "no band yet" test) has none.
    band: "hot" | "warm" | "cold" | undefined;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("leadAnalyses", {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      score: 9,
      band: args.band,
      scoreStatus: "scored",
      attempts: 0,
      sequenceStatus: args.sequenceStatus ?? "idle",
      followUpsSent: args.followUpsSent ?? 0,
    }),
  );
}

const DAY_MS = 24 * 60 * 60_000;
const LAST_CUSTOMER_MSG = Date.UTC(2026, 6, 20, 12, 0); // arbitrary fixed instant

test("armOnOutbound arms an idle, scored row with nextFollowUpAt = firstTouchAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedQualificationConfig(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, { accountId, conversationId, contactId, band: "hot" });

  await t.run((ctx) =>
    armOnOutbound(ctx, {
      accountId,
      conversationId,
      conversationArchivedAt: undefined,
      lastCustomerMessageAt: LAST_CUSTOMER_MSG,
    }),
  );

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  const expectedNextFollowUpAt = firstTouchAt({
    lastCustomerMessageAt: LAST_CUSTOMER_MSG,
    idleDaysBeforeSequence: 3, // default
    step0DelayDays: 2, // hot band's steps[0]
    config: { utcOffsetMinutes: 0, workStartMinute: 0, workEndMinute: 1440, workDays: [0, 1, 2, 3, 4, 5, 6] },
  });
  expect(row!.sequenceStatus).toBe("running");
  expect(row!.followUpsSent).toBe(0);
  expect(row!.nextFollowUpAt).toBe(expectedNextFollowUpAt);
  // max(idleDaysBeforeSequence=3, step0DelayDays=2) = 3 days, no clamp under 24/7 hours.
  expect(row!.nextFollowUpAt).toBe(LAST_CUSTOMER_MSG + 3 * DAY_MS);
});

test("armOnOutbound does not arm an outbound to an archived conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedQualificationConfig(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, { accountId, conversationId, contactId, band: "hot" });

  await t.run((ctx) =>
    armOnOutbound(ctx, {
      accountId,
      conversationId,
      conversationArchivedAt: Date.now(),
      lastCustomerMessageAt: LAST_CUSTOMER_MSG,
    }),
  );

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("idle");
  expect(row!.nextFollowUpAt).toBeUndefined();
});

test("armOnOutbound does not arm while the feature is disabled", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  // Deliberately NOT `enable(t, accountId)` — no config row at all.
  await seedQualificationConfig(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, { accountId, conversationId, contactId, band: "hot" });

  await t.run((ctx) =>
    armOnOutbound(ctx, {
      accountId,
      conversationId,
      conversationArchivedAt: undefined,
      lastCustomerMessageAt: LAST_CUSTOMER_MSG,
    }),
  );

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("idle");
  expect(row!.nextFollowUpAt).toBeUndefined();
});

test("armOnOutbound is a no-op when no leadAnalyses row exists", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedQualificationConfig(t, accountId);
  const { conversationId } = await seedConversation(t, accountId);

  await t.run((ctx) =>
    armOnOutbound(ctx, {
      accountId,
      conversationId,
      conversationArchivedAt: undefined,
      lastCustomerMessageAt: LAST_CUSTOMER_MSG,
    }),
  );

  expect(await t.run((ctx) => ctx.db.query("leadAnalyses").collect())).toHaveLength(0);
});

test("armOnOutbound skips a row with no resolved band yet", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedQualificationConfig(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, {
    accountId, conversationId, contactId, band: undefined,
  });

  await t.run((ctx) =>
    armOnOutbound(ctx, {
      accountId,
      conversationId,
      conversationArchivedAt: undefined,
      lastCustomerMessageAt: LAST_CUSTOMER_MSG,
    }),
  );

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("idle");
});

test("armOnOutbound skips when the conversation has no customer message on record", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedQualificationConfig(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, { accountId, conversationId, contactId, band: "hot" });

  await t.run((ctx) =>
    armOnOutbound(ctx, {
      accountId,
      conversationId,
      conversationArchivedAt: undefined,
      lastCustomerMessageAt: undefined,
    }),
  );

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("idle");
});

test("armOnOutbound skips when working hours are unset (no qualificationConfigs row)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  // Deliberately no `seedQualificationConfig` call.
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, { accountId, conversationId, contactId, band: "hot" });

  await t.run((ctx) =>
    armOnOutbound(ctx, {
      accountId,
      conversationId,
      conversationArchivedAt: undefined,
      lastCustomerMessageAt: LAST_CUSTOMER_MSG,
    }),
  );

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("idle");
});

test("arming twice does not double-advance the clock — a running sequence is left untouched", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedQualificationConfig(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, { accountId, conversationId, contactId, band: "hot" });

  const armArgs = {
    accountId,
    conversationId,
    conversationArchivedAt: undefined,
    lastCustomerMessageAt: LAST_CUSTOMER_MSG,
  };
  await t.run((ctx) => armOnOutbound(ctx, armArgs));
  const first = await t.run((ctx) => ctx.db.get(analysisId));
  expect(first!.sequenceStatus).toBe("running");

  // A second outbound goes out (e.g. the follow-up sweep's own send would
  // land here too) — nothing about `nextFollowUpAt` may move, and
  // `followUpsSent` must not be reset out from under an in-progress run.
  await t.run((ctx) =>
    ctx.db.patch(analysisId, { followUpsSent: 1 }), // simulate one step already sent
  );
  await t.run((ctx) => armOnOutbound(ctx, armArgs));

  const second = await t.run((ctx) => ctx.db.get(analysisId));
  expect(second!.sequenceStatus).toBe("running");
  expect(second!.nextFollowUpAt).toBe(first!.nextFollowUpAt);
  // Proof the guard, not just coincidence: a naive re-arm would have
  // reset this back to 0.
  expect(second!.followUpsSent).toBe(1);
});

test("armOnOutbound re-arms a stopped sequence with a fresh cadence", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedQualificationConfig(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, {
    accountId, conversationId, contactId, sequenceStatus: "stopped", band: "hot",
  });
  await t.run((ctx) => ctx.db.patch(analysisId, { stoppedReason: "replied" }));

  const newAnchor = LAST_CUSTOMER_MSG + 10 * DAY_MS;
  await t.run((ctx) =>
    armOnOutbound(ctx, {
      accountId,
      conversationId,
      conversationArchivedAt: undefined,
      lastCustomerMessageAt: newAnchor,
    }),
  );

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("running");
  expect(row!.followUpsSent).toBe(0);
  expect(row!.nextFollowUpAt).toBe(newAnchor + 3 * DAY_MS);
});

test("armOnOutbound does not re-arm an exhausted sequence", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedQualificationConfig(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, {
    accountId, conversationId, contactId, sequenceStatus: "exhausted", followUpsSent: 3, band: "hot",
  });

  await t.run((ctx) =>
    armOnOutbound(ctx, {
      accountId,
      conversationId,
      conversationArchivedAt: undefined,
      lastCustomerMessageAt: LAST_CUSTOMER_MSG,
    }),
  );

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("exhausted");
  expect(row!.followUpsSent).toBe(3);
});

// ------------------------------------------------------------------
// Fix 2 (whole-branch review, "a manual stop is silently reverted"):
// `armOnOutbound` excludes `"exhausted"` from re-arming (a human call,
// per that gate's own comment) but, before this fix, re-armed ANY
// `"stopped"` row without reading `stoppedReason` — including one a
// human pulled out via `stopSequence` (`leadAnalysis.ts`). Every OTHER
// stop reason is safe because it is re-derived at send time
// (`opted_out` re-stops at gate 7, `archived` at gate 2, `disabled` at
// gate 1); `"manual"` is the only one with no corresponding gate, so a
// re-arm here is the only way to silently undo it.
// ------------------------------------------------------------------

test("armOnOutbound does not re-arm a manually-stopped sequence", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedQualificationConfig(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, {
    accountId, conversationId, contactId, sequenceStatus: "stopped", followUpsSent: 2, band: "hot",
  });
  await t.run((ctx) => ctx.db.patch(analysisId, { stoppedReason: "manual" }));

  await t.run((ctx) =>
    armOnOutbound(ctx, {
      accountId,
      conversationId,
      conversationArchivedAt: undefined,
      lastCustomerMessageAt: LAST_CUSTOMER_MSG,
    }),
  );

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  // Untouched: still stopped, still carrying the human's reason, and
  // the cadence's progress is not reset out from under the decision.
  expect(row!.sequenceStatus).toBe("stopped");
  expect(row!.stoppedReason).toBe("manual");
  expect(row!.followUpsSent).toBe(2);
});

// ------------------------------------------------------------------
// stopOnInbound
// ------------------------------------------------------------------

test("stopOnInbound preserves a manual stop reason instead of overwriting it with 'replied'", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, {
    accountId, conversationId, contactId, sequenceStatus: "stopped", followUpsSent: 2, band: "hot",
  });
  await t.run((ctx) => ctx.db.patch(analysisId, { stoppedReason: "manual" }));

  // The customer replies on the manually-stopped thread — `ingest.ts`
  // calls this exact mutation for every inbound, unconditional of the
  // row's current `sequenceStatus` (see this mutation's own comment).
  await t.mutation(internal.leadAnalysisEngine.stopOnInbound, { accountId, conversationId });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("stopped");
  // Once `stoppedReason` is load-bearing for `armOnOutbound`'s manual
  // guard above, silently relabeling it "replied" here would erase the
  // ONE signal that keeps a later outbound from re-arming this lead —
  // undoing the manual stop by a different route.
  expect(row!.stoppedReason).toBe("manual");
});

test("stopOnInbound stops a running sequence and resets the counter", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, {
    accountId, conversationId, contactId, sequenceStatus: "running", followUpsSent: 2, band: "hot",
  });
  await t.run((ctx) => ctx.db.patch(analysisId, { nextFollowUpAt: Date.now() + DAY_MS }));

  await t.mutation(internal.leadAnalysisEngine.stopOnInbound, { accountId, conversationId });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("stopped");
  expect(row!.stoppedReason).toBe("replied");
  expect(row!.followUpsSent).toBe(0);
  expect(row!.nextFollowUpAt).toBeUndefined();
});

test("stopOnInbound on a lead with no sequence row is a cheap no-op", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.leadAnalysisEngine.stopOnInbound, { accountId, conversationId });

  expect(await t.run((ctx) => ctx.db.query("leadAnalyses").collect())).toHaveLength(0);
});

test("stopOnInbound no-ops when the row belongs to a different account", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { accountId: otherAccountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await seedArmableAnalysis(t, {
    accountId, conversationId, contactId, sequenceStatus: "running", band: "hot",
  });

  await t.mutation(internal.leadAnalysisEngine.stopOnInbound, {
    accountId: otherAccountId,
    conversationId,
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.sequenceStatus).toBe("running");
});

// ============================================================
// sequenceContext (P3 Task 7 — the send-time verdict query). Every gate
// is re-checked fresh against real fixtures — the sweep's own carried
// state is never trusted (see the module header on `armOnOutbound`).
// This query contains NO policy: it only assembles `EligibilityInput`
// and hands it to `evaluateSequence` (`lib/leadAnalysis/eligibility.ts`,
// already exhaustively gate-tested in isolation). These tests exist to
// pin that the WIRING is correct — the right DB value lands in the
// right input field — not to re-litigate the gate chain's own ordering.
// ============================================================

const SEQ_DAY = 24 * 60 * 60_000;
const SEQ_NOW = Date.UTC(2026, 6, 20, 12, 0); // noon UTC, arbitrary fixed instant

const SEQ_HOT_BAND = {
  key: "hot" as const,
  minScore: 8,
  maxScore: 10,
  autoArchive: false,
  steps: [{ delayDays: 2, templateName: "hot_nudge_1", templateLanguage: "en" }],
};
const SEQ_WARM_BAND = {
  key: "warm" as const,
  minScore: 4,
  maxScore: 7,
  autoArchive: true,
  steps: [
    { delayDays: 3, templateName: "warm_nudge_1", templateLanguage: "en" },
    { delayDays: 7, templateName: "warm_nudge_2", templateLanguage: "en" },
  ],
};
const SEQ_COLD_BAND = {
  key: "cold" as const,
  minScore: 1,
  maxScore: 3,
  autoArchive: true,
  steps: [{ delayDays: 5, templateName: "cold_nudge_1", templateLanguage: "en" }],
};

async function seedSequenceAccount(
  t: ReturnType<typeof convexTest>,
  opts: {
    skipQualConfig?: boolean;
    configOverrides?: Record<string, unknown>;
    qualConfigOverrides?: Record<string, unknown>;
  } = {},
) {
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(),
      accountId,
      enabled: true,
      idleDaysBeforeSequence: 3,
      humanQuietHours: 24,
      dailySendCap: 100,
      bands: [SEQ_HOT_BAND, SEQ_WARM_BAND, SEQ_COLD_BAND],
      ...opts.configOverrides,
    }),
  );

  if (!opts.skipQualConfig) {
    const { defaultQualificationConfig } = await import("./lib/qualification/defaults");
    await t.run((ctx) =>
      ctx.db.insert("qualificationConfigs", {
        accountId,
        ...defaultQualificationConfig(),
        enabled: true,
        utcOffsetMinutes: 0,
        workStartMinute: 0,
        workEndMinute: 1440,
        workDays: [0, 1, 2, 3, 4, 5, 6],
        maxFollowUps: 4,
        ...opts.qualConfigOverrides,
      }),
    );
  }

  return { accountId, contactId, conversationId };
}

async function seedTemplate(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  args: {
    name: string;
    language?: string;
    status?: "APPROVED" | "PENDING";
    bodyText?: string;
  },
) {
  await t.run((ctx) =>
    ctx.db.insert("messageTemplates", {
      accountId,
      name: args.name,
      language: args.language,
      category: "Marketing" as const,
      bodyText: args.bodyText ?? "Hi! Checking in about your travel plans.",
      status: args.status ?? "APPROVED",
    }),
  );
}

async function seedSequenceRow(
  t: ReturnType<typeof convexTest>,
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    contactId: Id<"contacts">;
    band: "hot" | "warm" | "cold" | undefined;
    followUpsSent?: number;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("leadAnalyses", {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      score: 5,
      band: args.band,
      scoreStatus: "scored" as const,
      attempts: 0,
      sequenceStatus: "running" as const,
      followUpsSent: args.followUpsSent ?? 0,
    }),
  );
}

async function seedSequenceMessage(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  senderType: "customer" | "agent" | "bot",
  text: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType,
      contentType: "text" as const,
      contentText: text,
      status: "delivered" as const,
    }),
  );
}

async function seedQualificationSession(
  t: ReturnType<typeof convexTest>,
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    contactId: Id<"contacts">;
    status: "collecting" | "qualified" | "expired" | "opted_out" | "disqualified";
    followUpsSent?: number;
  },
) {
  await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      status: args.status,
      origin: "inbound" as const,
      fields: [],
      expectedCount: 0,
      answeredCount: 0,
      followUpsSent: args.followUpsSent ?? 0,
      phrasingCursor: 0,
      sendAttemptErrors: 0,
    }),
  );
}

/** Account + conversation + contact + leadAnalysisConfigs (bands with
 *  REAL template names) + qualificationConfigs (24/7 by default) +
 *  matching `messageTemplates` rows + the `leadAnalyses` row itself.
 *  Deliberately does NOT seed any `messages` — every test wires its own
 *  timeline via `seedSequenceMessage` under `vi.setSystemTime`, since
 *  `_creationTime` (what `sequenceContext` reads for "last customer
 *  message" etc.) is fixed at insert time, not passed as an argument. */
async function setupSequenceAccountAndRow(
  t: ReturnType<typeof convexTest>,
  opts: {
    band: "hot" | "warm" | "cold" | undefined;
    followUpsSent?: number;
    step0TemplateStatus?: "APPROVED" | "PENDING" | "omit";
    skipQualConfig?: boolean;
    configOverrides?: Record<string, unknown>;
    qualConfigOverrides?: Record<string, unknown>;
  },
) {
  // convex-test's `_creationTime` is MONOTONIC per test instance (see
  // `insert()` in convex-test's source: `now <= this._lastCreationTime
  // ? this._lastCreationTime + 0.001 : now`) — it never goes backwards
  // even under `vi.setSystemTime`. `vi.useFakeTimers()` alone defaults
  // to the REAL current wall clock, so without this, every row this
  // helper inserts (config/template/leadAnalyses) would set that
  // monotonic floor to "real now" — LATER than every deliberately
  // past-dated message a test seeds afterwards — and those messages
  // would silently collapse to "real now + epsilon" instead of their
  // intended timestamp. Parking the clock comfortably before every
  // fixed offset this suite uses (furthest back: 40 days, the "long
  // thread" test) keeps the floor low enough that every later
  // `vi.setSystemTime` call in a test is a genuine forward move.
  vi.setSystemTime(SEQ_NOW - 60 * SEQ_DAY);

  const { accountId, contactId, conversationId } = await seedSequenceAccount(t, {
    skipQualConfig: opts.skipQualConfig,
    configOverrides: opts.configOverrides,
    qualConfigOverrides: opts.qualConfigOverrides,
  });

  const step0Status = opts.step0TemplateStatus ?? "APPROVED";
  if (step0Status !== "omit") {
    await seedTemplate(t, accountId, { name: "warm_nudge_1", language: "en", status: step0Status });
  }
  await seedTemplate(t, accountId, { name: "warm_nudge_2", language: "en" });
  await seedTemplate(t, accountId, { name: "hot_nudge_1", language: "en" });
  await seedTemplate(t, accountId, { name: "cold_nudge_1", language: "en" });

  const analysisId = await seedSequenceRow(t, {
    accountId, conversationId, contactId, band: opts.band, followUpsSent: opts.followUpsSent ?? 0,
  });

  return { accountId, contactId, conversationId, analysisId };
}

/** The common "clear lead" message timeline: a customer message 5 days
 *  ago, then our own outbound (the arm point) 4 days ago — idle long
 *  enough past the suite's `idleDaysBeforeSequence: 3`, and the last
 *  message overall is NOT the customer (gate 4 stays clear). */
async function seedClearTimeline(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
) {
  vi.setSystemTime(SEQ_NOW - 5 * SEQ_DAY);
  await seedSequenceMessage(t, accountId, conversationId, "customer", "Hi, interested in Bali");
  vi.setSystemTime(SEQ_NOW - 4 * SEQ_DAY);
  await seedSequenceMessage(t, accountId, conversationId, "bot", "Here are some options for you");
}

test("sequenceContext sends step 0 with the recipient phone, resolved template, and rendered body", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toMatchObject({ kind: "send", stepIndex: 0 });
    expect(verdict.send).toEqual({
      to: "+971500000001",
      templateName: "warm_nudge_1",
      templateLanguage: "en",
      contentText: "Hi! Checking in about your travel plans.",
    });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext resolves the CURRENT step's template, not always step 0", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
      followUpsSent: 1,
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toMatchObject({ kind: "send", stepIndex: 1 });
    expect(verdict.send?.templateName).toBe("warm_nudge_2");
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext stops when the feature is disabled", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
      configOverrides: { enabled: false },
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "stop", reason: "disabled" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext stops when the conversation is archived", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);
    await t.run((ctx) => ctx.db.patch(conversationId, { archivedAt: Date.now() }));

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "stop", reason: "archived" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext stops when the conversation is closed", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);
    await t.run((ctx) => ctx.db.patch(conversationId, { status: "closed" as const }));

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "stop", reason: "conversation_closed" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext stops when the customer replied since arming", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);
    // The customer wrote back an hour ago — the most recent message on
    // the thread is now theirs.
    vi.setSystemTime(SEQ_NOW - 1 * 3_600_000);
    await seedSequenceMessage(t, accountId, conversationId, "customer", "actually, never mind");

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "stop", reason: "replied" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext stops with no_customer_message when the conversation has no customer message on record", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { analysisId } = await setupSequenceAccountAndRow(t, { band: "warm" });
    // Deliberately NO messages seeded at all.

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "stop", reason: "no_customer_message" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext reschedules (not_idle_yet) when the customer hasn't been quiet long enough", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    // Only 1 day idle — under the suite's idleDaysBeforeSequence: 3.
    vi.setSystemTime(SEQ_NOW - 1 * SEQ_DAY);
    await seedSequenceMessage(t, accountId, conversationId, "customer", "hi");
    vi.setSystemTime(SEQ_NOW - 12 * 3_600_000);
    await seedSequenceMessage(t, accountId, conversationId, "bot", "here's what we offer");

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "reschedule", reason: "not_idle_yet" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext reschedules (qualification_owns) while a collecting session still has follow-up budget", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);
    const { contactId } = await t.run(async (ctx) => {
      const c = await ctx.db.get(conversationId);
      return { contactId: c!.contactId };
    });
    await seedQualificationSession(t, {
      accountId, conversationId, contactId, status: "collecting", followUpsSent: 1,
    });

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "reschedule", reason: "qualification_owns" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext sends once a collecting session has spent its own follow-up budget", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);
    const { contactId } = await t.run(async (ctx) => {
      const c = await ctx.db.get(conversationId);
      return { contactId: c!.contactId };
    });
    // maxFollowUps is 4 (seedSequenceAccount's default) — 4 already sent
    // releases the clock even though the session is still "collecting".
    await seedQualificationSession(t, {
      accountId, conversationId, contactId, status: "collecting", followUpsSent: 4,
    });

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict.kind).toBe("send");
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext stops when the customer opted out", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);
    const { contactId } = await t.run(async (ctx) => {
      const c = await ctx.db.get(conversationId);
      return { contactId: c!.contactId };
    });
    await seedQualificationSession(t, { accountId, conversationId, contactId, status: "opted_out" });

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "stop", reason: "opted_out" });
  } finally {
    vi.useRealTimers();
  }
});

// Task 6 (P3): gate 7's `optedOut` input now has TWO sources — the
// qualification session's own status (Task 5, above) AND a direct read
// of `contacts.doNotContact` via `blockedReason`. The two tests below
// exercise the two situations the session-status check alone misses:
// no qualification session exists at all, and one exists but its own
// sweep hasn't yet flipped it to `opted_out`. Both must resolve to
// `stop`/`opted_out`, never `send` — see `sequenceContext`'s own
// `optedOut` comment in `leadAnalysisEngine.ts` for why both sources
// are needed side by side.

test("sequenceContext stops a do-not-contact contact that has no qualification session at all", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, contactId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);
    // Deliberately NOT `seedQualificationSession` — this contact never
    // went through qualification at all, so Task 5's session-status
    // check has nothing to read. Only the direct `doNotContact` read
    // can catch this.
    const noteId = await t.run((ctx) =>
      ctx.db.insert("contactNotes", {
        accountId,
        contactId,
        noteText: "Asked us to stop",
        kind: "call",
        outcome: "do_not_contact",
      }),
    );
    await t.run((ctx) => ctx.db.patch(contactId, { doNotContact: { at: Date.now(), noteId } }));

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict.kind).not.toBe("send");
    expect(verdict).toEqual({ kind: "stop", reason: "opted_out" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext stops a do-not-contact contact whose qualification session hasn't been swept to opted_out yet", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, contactId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);
    // A qualification session exists but is still "collecting" — the
    // follow-up sweep that would eventually flip it to "opted_out"
    // (Task 5) has not run yet. Session-status alone would say
    // `optedOut: false` here; the direct flag read must still catch it.
    await seedQualificationSession(t, {
      accountId,
      conversationId,
      contactId,
      status: "collecting",
    });
    const noteId = await t.run((ctx) =>
      ctx.db.insert("contactNotes", {
        accountId,
        contactId,
        noteText: "Asked us to stop",
        kind: "call",
        outcome: "do_not_contact",
      }),
    );
    await t.run((ctx) => ctx.db.patch(contactId, { doNotContact: { at: Date.now(), noteId } }));

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict.kind).not.toBe("send");
    expect(verdict).toEqual({ kind: "stop", reason: "opted_out" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext still sends when the contact has no do-not-contact flag (regression guard)", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict.kind).toBe("send");
  } finally {
    vi.useRealTimers();
  }
});

test("a blocked sequence row is removed from the due set after sendSequenceStep runs, instead of rescheduling forever", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, contactId, analysisId } = await seedDueSequenceLead(t, { band: "warm" });
    const noteId = await t.run((ctx) =>
      ctx.db.insert("contactNotes", {
        accountId,
        contactId,
        noteText: "Asked us to stop",
        kind: "call",
        outcome: "do_not_contact",
      }),
    );
    await t.run((ctx) => ctx.db.patch(contactId, { doNotContact: { at: Date.now(), noteId } }));
    vi.setSystemTime(SEQ_NOW);

    await t.action(internal.leadAnalysisEngine.sendSequenceStep, { analysisId });

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.sequenceStatus).toBe("stopped");
    expect(row!.stoppedReason).toBe("opted_out");
    expect(row!.nextFollowUpAt).toBeUndefined();

    // The whole point of a terminal `stop` (not a `reschedule`): the row
    // must leave `by_sequence_due`'s range, or every future sweep tick
    // re-reads and re-evaluates it forever — the exact livelock Task 5
    // hit and fixed for the qualification-sweep side of this same gate.
    const dueAfter = await t.query(internal.leadAnalysisEngine.getDueSequenceRows, {});
    expect(dueAfter.map((r) => r._id)).not.toContain(analysisId);
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext reschedules (agent_active) when an agent messaged recently", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);
    // Within the suite's humanQuietHours: 24.
    vi.setSystemTime(SEQ_NOW - 1 * 3_600_000);
    await seedSequenceMessage(t, accountId, conversationId, "agent", "I've got this one");

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "reschedule", reason: "agent_active" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext stops with no_band when the row has no resolved band", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: undefined,
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "stop", reason: "no_band" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext archives an auto-archive band once its steps are exhausted", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // "warm" has 2 steps and autoArchive: true.
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
      followUpsSent: 2,
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "archive" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext exhausts a non-auto-archive band once its steps are exhausted, without archiving", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // "hot" has 1 step and autoArchive: false.
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "hot",
      followUpsSent: 1,
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "exhaust" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext stops with working_hours_unset when qualificationConfigs is absent", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
      skipQualConfig: true,
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "stop", reason: "working_hours_unset" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext reschedules (outside_hours) when now falls outside the configured working window", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
      // Only midnight–1am UTC is open; SEQ_NOW is noon.
      qualConfigOverrides: { workStartMinute: 0, workEndMinute: 60 },
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "reschedule", reason: "outside_hours" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext reschedules (daily_cap) when today's send budget is already spent", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
      configOverrides: { dailySendCap: 1 },
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const dayStart = dayStartFor(SEQ_NOW, 0); // utcOffsetMinutes: 0 (suite default)
    await t.run((ctx) =>
      ctx.db.insert("leadSequenceSendRate", { accountId, dayStartMs: dayStart, count: 1 }),
    );

    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });
    expect(verdict).toEqual({ kind: "reschedule", reason: "daily_cap" });

    // Read-only: evaluating the verdict must never itself spend budget —
    // Task 8's `claimSequenceSlot` is the only writer of this table.
    const rateRow = await t.run((ctx) =>
      ctx.db
        .query("leadSequenceSendRate")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .unique(),
    );
    expect(rateRow!.count).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext never creates or mutates leadSequenceSendRate merely by evaluating a send", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });
    expect(verdict.kind).toBe("send");

    const rows = await t.run((ctx) => ctx.db.query("leadSequenceSendRate").collect());
    expect(rows).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext stops with template_unavailable when the step's template is not APPROVED", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
      step0TemplateStatus: "PENDING",
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "stop", reason: "template_unavailable" });
  } finally {
    vi.useRealTimers();
  }
});

test("sequenceContext stops with template_unavailable when no matching template row exists at all", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
      step0TemplateStatus: "omit",
    });
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict).toEqual({ kind: "stop", reason: "template_unavailable" });
  } finally {
    vi.useRealTimers();
  }
});

// Index-shape sanity: proves "last customer message" / "last message"
// are keyed off the genuinely NEWEST row of each partition
// (`by_conversation_sender`'s `.order("desc").first()`), not thread
// length or insertion order — a long history of alternating messages
// must not change the answer.
test("sequenceContext keys off the newest customer/agent messages even in a long thread", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { accountId, conversationId, analysisId } = await setupSequenceAccountAndRow(t, {
      band: "warm",
    });

    // All noise stays strictly OLDER than `seedClearTimeline`'s real
    // messages (5/4 days ago) below — `_creationTime` is monotonic per
    // test instance (see `setupSequenceAccountAndRow`'s own comment), so
    // any noise timestamp landing AFTER -5 days would silently drag the
    // "real" messages forward instead of leaving them where intended.
    for (let i = 0; i < 20; i++) {
      vi.setSystemTime(SEQ_NOW - (40 - i) * SEQ_DAY);
      await seedSequenceMessage(
        t, accountId, conversationId, i % 2 === 0 ? "customer" : "bot", `history msg ${i}`,
      );
    }
    await seedClearTimeline(t, accountId, conversationId);

    vi.setSystemTime(SEQ_NOW);
    const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, { analysisId });

    expect(verdict.kind).toBe("send");
  } finally {
    vi.useRealTimers();
  }
});

// ============================================================
// P3 Task 8 — claim, send, sweep. THIS IS THE SUITE THAT PROVES NO TEST
// EVER REACHES A REAL META CALL: every send-path test below sets
// `CONVEX_META_DRY_RUN`, mirroring `qualificationEngine.test.ts` /
// `automationsEngine.test.ts`'s own convention (`metaSend.ts`'s
// `isDryRun()` skips the network POST and persists a synthetic
// `dry-run-<random>` wamid instead — see that file's own comment).
// The one deliberate EXCEPTION is the "provider failure" test, which
// stays off dry-run on purpose but never reaches Meta either: with no
// `whatsappConfig` row seeded for the account, `metaSend.sendTemplate`
// throws "WhatsApp not configured for this account" (from
// `loadDecryptedConfig`) BEFORE any `fetch` — a deterministic,
// synthetic failure, not a real network call.
// ============================================================

/** `setupSequenceAccountAndRow` + `seedClearTimeline`, then marks the
 *  row due right now — the shape every claim/send test in this suite
 *  starts from. `setupSequenceAccountAndRow`'s own fixtures (24/7
 *  working hours, `dailySendCap: 100`, no active qualification
 *  session) already resolve to `sequenceContext`'s `"send"` verdict;
 *  this adds the two pieces those tests don't need:
 *
 *   - a `nextFollowUpAt` in the past, since `claimSequenceSlot` (unlike
 *     `evaluateSequence` itself) checks it as its own concurrency guard;
 *   - `conversations.lastInboundAt`, WITHOUT which `armOnOutbound`
 *     (Task 6) bails at its very first line (`lastCustomerMessageAt ===
 *     undefined`) before ever reading `sequenceStatus` — `seedClearTimeline`
 *     writes the customer's message straight into `messages` (bypassing
 *     `insertMessageAndUpdateConversation`, the only place that field is
 *     normally maintained), so without this patch every test below that
 *     completes a real send would exercise NONE of the runaway guard
 *     (property 2) it's meant to pin — the assertions on `sequenceStatus`/
 *     `followUpsSent` after a send would pass whether or not
 *     `claimSequenceSlot` ever touched `sequenceStatus` at all. See the
 *     deliberate-break evidence in the P3 Task 8 report for proof this
 *     now has teeth. */
async function seedDueSequenceLead(
  t: ReturnType<typeof convexTest>,
  opts: {
    band: "hot" | "warm" | "cold" | undefined;
    followUpsSent?: number;
    configOverrides?: Record<string, unknown>;
    qualConfigOverrides?: Record<string, unknown>;
  },
) {
  const built = await setupSequenceAccountAndRow(t, opts);
  await seedClearTimeline(t, built.accountId, built.conversationId);
  await t.run((ctx) =>
    ctx.db.patch(built.conversationId, { lastInboundAt: SEQ_NOW - 5 * SEQ_DAY }),
  );
  await t.run((ctx) => ctx.db.patch(built.analysisId, { nextFollowUpAt: SEQ_NOW }));
  return built;
}

/** Save/restore `CONVEX_META_DRY_RUN` around a test — `delete`ing it
 *  outright (this suite's earlier style) would clear a CI-wide flag for
 *  every later test in the same worker if one happened to depend on it
 *  already being set; this restores whatever value (or absence)
 *  preceded the test instead. Call the returned function in a
 *  `finally`. */
function setMetaDryRun(value: string | undefined): () => void {
  const prior = process.env.CONVEX_META_DRY_RUN;
  if (value === undefined) delete process.env.CONVEX_META_DRY_RUN;
  else process.env.CONVEX_META_DRY_RUN = value;
  return () => {
    if (prior === undefined) delete process.env.CONVEX_META_DRY_RUN;
    else process.env.CONVEX_META_DRY_RUN = prior;
  };
}

// Scans (not `.withIndex`) — a helper function parameter typed as the
// bare `ReturnType<typeof convexTest>` loses this suite's concrete
// index names, so a `.withIndex(...)` call inside a helper can't
// resolve; `.filter()` needs no declared index name and is plenty fast
// at this suite's tiny scale. Mirrors `flowsEngine.test.ts`'s /
// `automationsEngine.test.ts`'s own documented workaround for the
// identical gotcha.
async function templateMessages(t: ReturnType<typeof convexTest>, conversationId: Id<"conversations">) {
  const rows = await t.run((ctx) =>
    ctx.db.query("messages").filter((q) => q.eq(q.field("conversationId"), conversationId)).collect(),
  );
  return rows.filter((r) => r.contentType === "template");
}

test("sendSequenceStep sends exactly one template for a due lead and advances followUpsSent to 1", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  const restoreDryRun = setMetaDryRun("1");
  try {
    const { conversationId, analysisId } = await seedDueSequenceLead(t, { band: "warm" });

    vi.setSystemTime(SEQ_NOW);
    await t.action(internal.leadAnalysisEngine.sendSequenceStep, { analysisId });

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    // The runaway guard (property 2): `claimSequenceSlot` never touches
    // `sequenceStatus`, so it is still `"running"` — never re-armed by
    // `armOnOutbound` — at the moment this send's message is written.
    // `seedDueSequenceLead`'s `lastInboundAt` patch is what makes this
    // assertion genuinely exercise that guard rather than vacuously
    // pass because `armOnOutbound` bailed before ever reading the row
    // (see the deliberate-break evidence in the P3 Task 8 report).
    expect(row!.sequenceStatus).toBe("running");
    expect(row!.followUpsSent).toBe(1);
    expect(row!.lastFollowUpAt).toBe(SEQ_NOW);
    // warm band's steps[1].delayDays === 7, measured from THIS send
    // (`lastFollowUpAt`), not from the customer's last message.
    expect(row!.nextFollowUpAt).toBe(SEQ_NOW + 7 * SEQ_DAY);

    const templates = await templateMessages(t, conversationId);
    expect(templates).toHaveLength(1);
    expect(templates[0].templateName).toBe("warm_nudge_1");
    expect(templates[0].senderType).toBe("bot");
  } finally {
    restoreDryRun();
    vi.useRealTimers();
  }
});

test("claimSequenceSlot: a second concurrent claim on the same row returns false and sends nothing", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const { analysisId } = await seedDueSequenceLead(t, { band: "warm" });
    vi.setSystemTime(SEQ_NOW);

    const first = await t.mutation(internal.leadAnalysisEngine.claimSequenceSlot, { analysisId });
    const second = await t.mutation(internal.leadAnalysisEngine.claimSequenceSlot, { analysisId });

    expect(first).toBe(true);
    expect(second).toBe(false);

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    // The slot was spent exactly once — the losing claim advanced
    // nothing.
    expect(row!.followUpsSent).toBe(1);

    const rateRow = await t.run((ctx) =>
      ctx.db
        .query("leadSequenceSendRate")
        .withIndex("by_account", (q) => q.eq("accountId", row!.accountId))
        .unique(),
    );
    expect(rateRow!.count).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("a provider failure after a successful claim stops the lead instead of leaving it to fail again next step", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  const restoreDryRun = setMetaDryRun(undefined); // deliberately off — see suite header
  try {
    const { conversationId, analysisId } = await seedDueSequenceLead(t, { band: "warm" });
    vi.setSystemTime(SEQ_NOW);

    // No `whatsappConfig` row for this account — `metaSend.sendTemplate`
    // throws before any network call (see suite header). Caught inside
    // `sendSequenceStep`'s own try/catch.
    await t.action(internal.leadAnalysisEngine.sendSequenceStep, { analysisId });

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    // The claim happened (before the send) and was NOT rolled back —
    // `followUpsSent` still advanced, exactly as `claimSequenceSlot`'s
    // own at-most-once contract requires.
    expect(row!.followUpsSent).toBe(1);
    // Fix 3 (whole-branch review, "a parameterised template silently
    // burns the cadence"): before this fix, the already-booked rung
    // (`SEQ_NOW + 7 * SEQ_DAY`) was left standing, so a send that fails
    // for a durable reason (an unparameterised-body template, a
    // permanently-invalid number) would silently repeat the identical
    // failure at every future step, forever, with nothing surfaced
    // anywhere. This send now STOPS the lead outright instead of
    // leaving the next rung standing — the setup here is unchanged
    // (still a real, deterministic throw with no `whatsappConfig` row);
    // only the reaction to that throw changed, so the assertions below
    // are updated to match the new, intended behavior rather than
    // relaxed.
    expect(row!.sequenceStatus).toBe("stopped");
    expect(row!.stoppedReason).toBe("send_failed");
    expect(row!.nextFollowUpAt).toBeUndefined();
    expect(await templateMessages(t, conversationId)).toHaveLength(0);

    // Simulate the sweep reaching this row again right away: it is no
    // longer `"running"` at all, so the claim refuses on that basis —
    // not merely because a future rung happens to still be booked.
    const secondClaim = await t.mutation(internal.leadAnalysisEngine.claimSequenceSlot, {
      analysisId,
    });
    expect(secondClaim).toBe(false);

    const rowAfter = await t.run((ctx) => ctx.db.get(analysisId));
    expect(rowAfter!.followUpsSent).toBe(1);
    expect(await templateMessages(t, conversationId)).toHaveLength(0);
  } finally {
    restoreDryRun();
    vi.useRealTimers();
  }
});

test("the daily cap refuses and reschedules rather than sending", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  const restoreDryRun = setMetaDryRun("1");
  try {
    const { accountId, conversationId, analysisId } = await seedDueSequenceLead(t, {
      band: "warm",
      configOverrides: { dailySendCap: 1 },
    });
    vi.setSystemTime(SEQ_NOW);
    const dayStart = dayStartFor(SEQ_NOW, 0);
    await t.run((ctx) =>
      ctx.db.insert("leadSequenceSendRate", { accountId, dayStartMs: dayStart, count: 1 }),
    );

    await t.action(internal.leadAnalysisEngine.sendSequenceStep, { analysisId });

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.sequenceStatus).toBe("running");
    expect(row!.followUpsSent).toBe(0);
    // Fix 4 (whole-branch review, "the sweep re-runs its whole slice
    // every tick"): before this fix, a reschedule re-stamped
    // `nextFollowUpAt` to exactly `now`, so a deferred row was fully
    // re-evaluated on literally every future sweep tick forever, even
    // for a reason (like this one, `daily_cap`) that provably cannot
    // resolve before tomorrow. The setup here is unchanged (still a
    // cap-exhausted account); only the stamped revisit time changed, so
    // this assertion is updated to match rather than relaxed.
    expect(row!.nextFollowUpAt).toBe(SEQ_NOW + SEQUENCE_RESCHEDULE_DEFER_MS);
    expect(await templateMessages(t, conversationId)).toHaveLength(0);
  } finally {
    restoreDryRun();
    vi.useRealTimers();
  }
});

// ------------------------------------------------------------------
// Fix 4 (whole-branch review, "the sweep re-runs its whole slice every
// tick"): `SEQUENCE_SWEEP_LIMIT` is bounded lower (100 -> 25 — the
// cron runs every 15 minutes, so 100/tick is 9,600/day against a
// 100/day send cap) and a reschedule now stamps a real FUTURE revisit
// time instead of `now`. The anti-starvation property the original
// "stamp to now" trick provided (a deferred backlog can't crowd out
// genuinely-due rows — see `rescheduleSequenceRow`'s call site comment)
// must still hold: this test pins that a row deferred by
// `SEQUENCE_RESCHEDULE_DEFER_MS` is not merely sorted behind a
// genuinely-due row within the SAME bounded slice — with a real future
// timestamp it is excluded from `by_sequence_due`'s range ENTIRELY
// until the deferral elapses, which is strictly stronger.
// ------------------------------------------------------------------

test("a deferred (rescheduled) row does not reappear in the due slice before its new revisit time", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  const restoreDryRun = setMetaDryRun("1");
  try {
    const { accountId, conversationId, analysisId } = await seedDueSequenceLead(t, {
      band: "warm",
      configOverrides: { dailySendCap: 1 },
    });
    vi.setSystemTime(SEQ_NOW);
    const dayStart = dayStartFor(SEQ_NOW, 0);
    await t.run((ctx) =>
      ctx.db.insert("leadSequenceSendRate", { accountId, dayStartMs: dayStart, count: 1 }),
    );

    // Tick 1: daily cap refuses, the row is deferred into the future.
    await t.action(internal.leadAnalysisEngine.sendSequenceStep, { analysisId });

    // Tick 2, moments later — still well before the deferral elapses.
    // A genuinely-due row must still be found; the deferred one must
    // NOT reappear yet (it is excluded from the index range entirely,
    // not merely sorted behind).
    vi.setSystemTime(SEQ_NOW + 60_000);
    const dueSoonAfter = await t.run((ctx) =>
      ctx.db
        .query("leadAnalyses")
        .withIndex("by_sequence_due", (q) =>
          q.eq("sequenceStatus", "running").lte("nextFollowUpAt", SEQ_NOW + 60_000),
        )
        .collect(),
    );
    expect(dueSoonAfter.map((r) => r._id)).not.toContain(analysisId);

    // Tick past the deferral: now it is due again, exactly once its
    // stamped revisit time has passed.
    const afterDeferral = SEQ_NOW + SEQUENCE_RESCHEDULE_DEFER_MS;
    const dueAtRevisit = await t.run((ctx) =>
      ctx.db
        .query("leadAnalyses")
        .withIndex("by_sequence_due", (q) =>
          q.eq("sequenceStatus", "running").lte("nextFollowUpAt", afterDeferral),
        )
        .collect(),
    );
    expect(dueAtRevisit.map((r) => r._id)).toContain(analysisId);
    void conversationId;
  } finally {
    restoreDryRun();
    vi.useRealTimers();
  }
});

test("a deferred row still sorts behind a genuinely-due (historically overdue) row within the bounded slice", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  const restoreDryRun = setMetaDryRun("1");
  try {
    // The daily-cap-deferred lead.
    const { accountId, analysisId: deferredId } = await seedDueSequenceLead(t, {
      band: "warm",
      configOverrides: { dailySendCap: 1 },
    });
    vi.setSystemTime(SEQ_NOW);
    const dayStart = dayStartFor(SEQ_NOW, 0);
    await t.run((ctx) =>
      ctx.db.insert("leadSequenceSendRate", { accountId, dayStartMs: dayStart, count: 1 }),
    );
    await t.action(internal.leadAnalysisEngine.sendSequenceStep, { analysisId: deferredId });
    const deferredRow = await t.run((ctx) => ctx.db.get(deferredId));
    expect(deferredRow!.nextFollowUpAt).toBe(SEQ_NOW + SEQUENCE_RESCHEDULE_DEFER_MS);

    // A second lead that's been genuinely overdue since long before
    // either tick above — its `nextFollowUpAt` is far in the past.
    const genuinelyDue = await seedDueSequenceLead(t, { band: "warm" });
    await t.run((ctx) =>
      ctx.db.patch(genuinelyDue.analysisId, { nextFollowUpAt: SEQ_NOW - 30 * SEQ_DAY }),
    );

    // Once the deferral elapses, both rows are technically "due" (their
    // `nextFollowUpAt` is <= now) — `by_sequence_due`'s ascending order
    // must still put the OLDER, genuinely-overdue row first.
    const due = await t.run((ctx) =>
      ctx.db
        .query("leadAnalyses")
        .withIndex("by_sequence_due", (q) =>
          q
            .eq("sequenceStatus", "running")
            .lte("nextFollowUpAt", SEQ_NOW + SEQUENCE_RESCHEDULE_DEFER_MS + 1),
        )
        .collect(),
    );
    const ids = due.map((r) => r._id);
    expect(ids.indexOf(genuinelyDue.analysisId)).toBeLessThan(ids.indexOf(deferredId));
  } finally {
    restoreDryRun();
    vi.useRealTimers();
  }
});

test("a warm lead past its last step archives (auto-archive band)", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  const restoreDryRun = setMetaDryRun("1");
  try {
    // "warm" has 2 steps and autoArchive: true.
    const { accountId, conversationId, analysisId } = await seedDueSequenceLead(t, {
      band: "warm",
      followUpsSent: 2,
    });
    vi.setSystemTime(SEQ_NOW);

    await t.action(internal.leadAnalysisEngine.sendSequenceStep, { analysisId });

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.sequenceStatus).toBe("stopped");
    expect(row!.stoppedReason).toBe("archived");
    expect(row!.nextFollowUpAt).toBeUndefined();
    expect(row!.archived).toBe(true);

    const conversation = await t.run((ctx) => ctx.db.get(conversationId));
    expect(conversation!.archivedAt).toBeDefined();
    expect(conversation!.archivedReason).toBe("no_response");
    expect(await templateMessages(t, conversationId)).toHaveLength(0);
    void accountId;
  } finally {
    restoreDryRun();
    vi.useRealTimers();
  }
});

test("a hot lead past its last step exhausts and is NOT archived", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  const restoreDryRun = setMetaDryRun("1");
  try {
    // "hot" has 1 step and autoArchive: false.
    const { conversationId, analysisId } = await seedDueSequenceLead(t, {
      band: "hot",
      followUpsSent: 1,
    });
    vi.setSystemTime(SEQ_NOW);

    await t.action(internal.leadAnalysisEngine.sendSequenceStep, { analysisId });

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.sequenceStatus).toBe("exhausted");
    expect(row!.nextFollowUpAt).toBeUndefined();
    expect(row!.archived).not.toBe(true);

    const conversation = await t.run((ctx) => ctx.db.get(conversationId));
    expect(conversation!.archivedAt).toBeUndefined();
    expect(await templateMessages(t, conversationId)).toHaveLength(0);
  } finally {
    restoreDryRun();
    vi.useRealTimers();
  }
});

test("a disabled config stops rather than sending, even with a due row already queued", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  const restoreDryRun = setMetaDryRun("1");
  try {
    const { conversationId, analysisId } = await seedDueSequenceLead(t, {
      band: "warm",
      configOverrides: { enabled: false },
    });
    vi.setSystemTime(SEQ_NOW);

    await t.action(internal.leadAnalysisEngine.sendSequenceStep, { analysisId });

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.sequenceStatus).toBe("stopped");
    expect(row!.stoppedReason).toBe("disabled");
    expect(row!.followUpsSent).toBe(0);
    expect(await templateMessages(t, conversationId)).toHaveLength(0);
  } finally {
    restoreDryRun();
    vi.useRealTimers();
  }
});

test("sweepLeadSequence processes at most SEQUENCE_SWEEP_LIMIT rows in one tick", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  const restoreDryRun = setMetaDryRun("1");
  try {
    // One MORE than the bound — proves the `.take(SEQUENCE_SWEEP_LIMIT)`
    // in `getDueSequenceRows` is a real cap, not just a coincidence of
    // how many rows a test happens to seed.
    const rows: Array<{ analysisId: Id<"leadAnalyses"> }> = [];
    for (let i = 0; i < SEQUENCE_SWEEP_LIMIT + 1; i++) {
      rows.push(await seedDueSequenceLead(t, { band: "warm" }));
    }
    vi.setSystemTime(SEQ_NOW);

    await t.action(internal.leadAnalysisEngine.sweepLeadSequence, {});

    let processed = 0;
    for (const row of rows) {
      const after = await t.run((ctx) => ctx.db.get(row.analysisId));
      if (after!.followUpsSent === 1) processed++;
    }
    // Fix 4 (whole-branch review): dropped from 100 to 25 — the cron
    // runs every 15 minutes, so 100/tick was 9,600/day against a
    // 100/day send cap, buying nothing.
    expect(SEQUENCE_SWEEP_LIMIT).toBe(25);
    expect(processed).toBe(SEQUENCE_SWEEP_LIMIT);
  } finally {
    restoreDryRun();
    vi.useRealTimers();
  }
});

test("sweepLeadSequence is bounded and one throwing row does not strand the rest of the slice", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  const restoreDryRun = setMetaDryRun("1");
  try {
    // The bad row's `nextFollowUpAt` sorts strictly BEFORE the good
    // row's within the same `("running", <= now)` range, so
    // `by_sequence_due`'s ascending order guarantees the sweep visits
    // the bad row FIRST — a naive loop with no per-row isolation would
    // throw here and never reach the good row at all.
    const bad = await seedDueSequenceLead(t, { band: "warm" });
    await t.run((ctx) => ctx.db.patch(bad.analysisId, { nextFollowUpAt: SEQ_NOW - 1000 }));
    // Deleting the conversation makes `sequenceContext` throw
    // ("conversation missing or tenancy mismatch") for this row.
    await t.run((ctx) => ctx.db.delete(bad.conversationId));

    const good = await seedDueSequenceLead(t, { band: "warm" });

    vi.setSystemTime(SEQ_NOW);
    await t.action(internal.leadAnalysisEngine.sweepLeadSequence, {});

    const goodRow = await t.run((ctx) => ctx.db.get(good.analysisId));
    expect(goodRow!.followUpsSent).toBe(1);
    expect(await templateMessages(t, good.conversationId)).toHaveLength(1);

    // The bad row itself is untouched (its own action call failed before
    // any write) — proving the isolation, not just that the good row
    // survived by luck of ordering.
    const badRow = await t.run((ctx) => ctx.db.get(bad.analysisId));
    expect(badRow!.followUpsSent).toBe(0);
  } finally {
    restoreDryRun();
    vi.useRealTimers();
  }
});

test("clearing nextFollowUpAt on the last real send still surfaces the row to the next sweep tick for archive", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  const restoreDryRun = setMetaDryRun("1");
  try {
    // "warm" has 2 steps and autoArchive: true. `followUpsSent: 1` means
    // step index 1 — the LAST step — is due right now.
    //
    // `qualConfigOverrides: { enabled: false }` is deliberate and
    // load-bearing here, NOT copy-pasted boilerplate: this is the first
    // test in the suite where a real send goes through
    // `insertMessageAndUpdateConversation` and THEN the row is
    // re-evaluated a second time. `messages.ts`'s own outbound-tracking
    // hook (`lib/qualification/track.ts`'s `recordOutboundSend`, gated
    // on `qualificationConfigs.enabled` — a genuinely separate feature
    // from Lead Analysis) auto-creates a fresh `"collecting"`
    // `qualificationSessions` row for a conversation with none yet on
    // its first tracked outbound. Left enabled, that new session would
    // correctly (per `evaluateSequence`'s own tier-2 gate 6) defer this
    // test's second-tick archive with `qualification_owns` — real
    // cross-feature behavior, just not what THIS test is pinning.
    // Disabling qualification's own config keeps `workingHoursKnown`
    // true (that gate only checks the row EXISTS, not `.enabled` — see
    // `sequenceContext`'s own comment) while skipping that unrelated
    // hook entirely, isolating this test to the one property it exists
    // to prove.
    const { conversationId, analysisId } = await seedDueSequenceLead(t, {
      band: "warm",
      followUpsSent: 1,
      qualConfigOverrides: { enabled: false },
    });
    vi.setSystemTime(SEQ_NOW);

    // First tick: sends the last real step. `claimSequenceSlot` clears
    // `nextFollowUpAt` (there is no `steps[2]`) rather than the row
    // simply stopping being due — see `claimSequenceSlot`'s own comment
    // on why an undefined `nextFollowUpAt` still sorts inside
    // `by_sequence_due`'s "<= now" range.
    await t.action(internal.leadAnalysisEngine.sendSequenceStep, { analysisId });

    const afterSend = await t.run((ctx) => ctx.db.get(analysisId));
    expect(afterSend!.sequenceStatus).toBe("running");
    expect(afterSend!.followUpsSent).toBe(2);
    expect(afterSend!.nextFollowUpAt).toBeUndefined();
    expect(await templateMessages(t, conversationId)).toHaveLength(1);

    // Second tick, via the SWEEP itself (not a direct `sendSequenceStep`
    // call) — proves `getDueSequenceRows`' index range genuinely
    // re-surfaces a row whose `nextFollowUpAt` was cleared, not merely
    // that `sequenceContext` WOULD resolve it to `archive` if asked
    // directly. If the index behaviour this relies on ever changed,
    // this row would simply never be found again and would stay
    // `running` forever — this test is the regression guard for that.
    await t.action(internal.leadAnalysisEngine.sweepLeadSequence, {});

    const afterSweep = await t.run((ctx) => ctx.db.get(analysisId));
    expect(afterSweep!.sequenceStatus).toBe("stopped");
    expect(afterSweep!.stoppedReason).toBe("archived");
    expect(afterSweep!.archived).toBe(true);

    const conversation = await t.run((ctx) => ctx.db.get(conversationId));
    expect(conversation!.archivedAt).toBeDefined();
    expect(conversation!.archivedReason).toBe("no_response");

    // The sweep's second tick sent nothing new — still exactly the one
    // template from the first tick.
    expect(await templateMessages(t, conversationId)).toHaveLength(1);
  } finally {
    restoreDryRun();
    vi.useRealTimers();
  }
});

test("applyScore caches the conversation's service name", async () => {
  const t = convexTest(schema, modules);

  const analysisId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Owner", email: "o6@x.com" });
    const accountId = await ctx.db.insert("accounts", {
      name: "Acct", defaultCurrency: "AED", ownerUserId: userId,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000006", phoneNormalized: "971500000006",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    await ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId,
      status: "collecting", origin: "inbound", fields: [],
      expectedCount: 0, answeredCount: 0, followUpsSent: 0,
      phrasingCursor: 0, sendAttemptErrors: 0,
      serviceName: "UAE Tourist Visa",
    });
    return await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "pending", attempts: 0,
      sequenceStatus: "idle", followUpsSent: 0,
    });
  });

  await t.mutation(internal.leadAnalysisEngine.applyScore, {
    analysisId, score: 7, reason: "Gave dates", signals: [],
    model: "test", throughMs: Date.now(),
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row?.serviceName).toBe("UAE Tourist Visa");
});
