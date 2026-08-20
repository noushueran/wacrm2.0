import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { BOARD_LIMITS } from "./leadAnalysis";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";
import type { Id } from "./_generated/dataModel";
import { defaultLeadAnalysisConfig } from "./lib/leadAnalysis/defaults";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccountMember(
  t: ReturnType<typeof convexTest>,
  opts: { name: string; email: string; role: AccountRole; accountId?: Id<"accounts"> },
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: opts.name, email: opts.email }),
  );
  const accountId = await t.run(async (ctx) => {
    // An existing `accountId` joins that account instead of minting a new
    // one, so two members (e.g. an agent and a viewer) can share a tenant.
    const id =
      opts.accountId ??
      (await ctx.db.insert("accounts", {
        name: `${opts.name}'s account`,
        defaultCurrency: "AED",
        ownerUserId: userId,
      }));
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  return {
    userId,
    accountId,
    asUser: t.withIdentity({ subject: `${userId}|session-${opts.name}` }),
  };
}

async function seedConversation(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  const phone = `+9715${Math.floor(Math.random() * 1e8)}`;
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone.replace(/\D/g, ""),
      name: "Test Contact",
    }),
  );
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
    }),
  );
  return conversationId;
}

test("getConfig returns unpersisted defaults before any save", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  const config = await asUser.query(api.leadAnalysis.getConfig, {});
  expect(config.isPersisted).toBe(false);
  expect(config.enabled).toBe(false);
  expect(config.scorePerRun).toBe(25);
  expect(config.bands).toHaveLength(3);
});

/**
 * The seeded defaults ship every band step with `templateName: ""`
 * (`defaults.ts`'s own doc comment: "an empty name is the 'not
 * configured yet' marker, never a send") — deliberately so that
 * `enabled: true` cannot round-trip a fresh account into a live send.
 * Tests that need `enabled: true` to actually succeed must fill every
 * step's template first, exactly like a real admin would have to via
 * the settings UI.
 */
function bandsWithTemplates() {
  return defaultLeadAnalysisConfig().bands.map((band) => ({
    ...band,
    steps: band.steps.map((step) => ({ ...step, templateName: "welcome_back" })),
  }));
}

test("updateConfig persists a partial patch onto the defaults", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  await asUser.mutation(api.leadAnalysis.updateConfig, {
    patch: { enabled: true, bands: bandsWithTemplates() },
  });
  const config = await asUser.query(api.leadAnalysis.getConfig, {});
  expect(config.isPersisted).toBe(true);
  expect(config.enabled).toBe(true);
  // Untouched keys still carry their defaults.
  expect(config.scorePerRun).toBe(25);
});

test("updateConfig is idempotent — a second patch updates, never inserts twice", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  await asUser.mutation(api.leadAnalysis.updateConfig, {
    patch: { enabled: true, bands: bandsWithTemplates() },
  });
  await asUser.mutation(api.leadAnalysis.updateConfig, { patch: { scorePerRun: 5 } });
  const rows = await t.run((ctx) =>
    ctx.db
      .query("leadAnalysisConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].enabled).toBe(true);
  expect(rows[0].scorePerRun).toBe(5);
});

test("updateConfig ignores unknown keys instead of failing validation", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  await asUser.mutation(api.leadAnalysis.updateConfig, {
    patch: { enabled: true, bands: bandsWithTemplates(), nonsenseKey: "boom" },
  });
  const config = await asUser.query(api.leadAnalysis.getConfig, {});
  expect(config.enabled).toBe(true);
});

test("updateConfig rejects enabled: true while any band step has no template", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  // The seeded defaults' bands all carry `templateName: ""` — the
  // exact "not configured yet" state gate 1 must block.
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { enabled: true } }),
  ).rejects.toThrow();
  const config = await asUser.query(api.leadAnalysis.getConfig, {});
  expect(config.enabled).toBe(false);
});

test("updateConfig rejects enabled: true when only ONE band's ONE step lacks a template", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  const bands = bandsWithTemplates();
  // Leave a single step (cold band, its only step) unconfigured —
  // everything else is fully templated.
  bands[2].steps[0] = { ...bands[2].steps[0], templateName: "" };
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { enabled: true, bands } }),
  ).rejects.toThrow();
});

test("updateConfig allows enabled: true once every band step has a template", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  await asUser.mutation(api.leadAnalysis.updateConfig, {
    patch: { enabled: true, bands: bandsWithTemplates() },
  });
  const config = await asUser.query(api.leadAnalysis.getConfig, {});
  expect(config.enabled).toBe(true);
});

test("updateConfig still allows enabled: false even while templates are missing", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  // Turning the feature OFF (or leaving it off) must never be blocked
  // by an incomplete cadence — only turning it ON is gated.
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { enabled: false } }),
  ).resolves.toBeDefined();
});

test("updateConfig's template guard checks the FINAL merged bands, not just the patch's own bands key", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  // Persist fully-templated bands first, WITHOUT enabling.
  await asUser.mutation(api.leadAnalysis.updateConfig, {
    patch: { bands: bandsWithTemplates() },
  });
  // Enabling now, with a patch that doesn't touch `bands` at all, must
  // succeed because the stored bands (merged in) are already complete.
  await asUser.mutation(api.leadAnalysis.updateConfig, { patch: { enabled: true } });
  const config = await asUser.query(api.leadAnalysis.getConfig, {});
  expect(config.enabled).toBe(true);
});

test("updateConfig rejects a scorePerRun outside 1..100", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { scorePerRun: 0 } }),
  ).rejects.toThrow();
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { scorePerRun: 101 } }),
  ).rejects.toThrow();
});

// ------------------------------------------------------------------
// Fix 1 (whole-branch review, "a duplicate-send path"): `delayDays: 0`
// collapses `nextStepAt`'s `clampToWorkingHours(now + 0)` to exactly
// `now`, and `claimSequenceSlot`'s own concurrency guard
// (`row.nextFollowUpAt > now`) is FALSE the instant `nextFollowUpAt
// === now` — two overlapping sweep ticks can then both pass the guard
// and both send, a duplicate marketing message on a real customer's
// real WhatsApp thread. The UI's `min={1}` is a courtesy; this
// server-side check is the actual correctness boundary, same relationship
// as gate 1's template-completeness check above.
// ------------------------------------------------------------------

test("updateConfig rejects a band step with delayDays: 0", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  const bands = bandsWithTemplates();
  bands[0].steps[0] = { ...bands[0].steps[0], delayDays: 0 };
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { bands } }),
  ).rejects.toThrow();
});

test("updateConfig rejects a negative delayDays", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  const bands = bandsWithTemplates();
  bands[0].steps[0] = { ...bands[0].steps[0], delayDays: -3 };
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { bands } }),
  ).rejects.toThrow();
});

test("updateConfig rejects a non-integer delayDays", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  const bands = bandsWithTemplates();
  bands[0].steps[0] = { ...bands[0].steps[0], delayDays: 2.5 };
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { bands } }),
  ).rejects.toThrow();
});

test("updateConfig rejects a delayDays above 90", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  const bands = bandsWithTemplates();
  bands[0].steps[0] = { ...bands[0].steps[0], delayDays: 91 };
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { bands } }),
  ).rejects.toThrow();
});

test("updateConfig accepts delayDays at the boundaries 1 and 90", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  const bands = bandsWithTemplates();
  bands[0].steps[0] = { ...bands[0].steps[0], delayDays: 1 };
  bands[0].steps[1] = { ...bands[0].steps[1], delayDays: 90 };
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { bands } }),
  ).resolves.toBeDefined();
});

test("config is admin-gated on both read and write", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Agent", email: "ag@x.com", role: "agent",
  });
  await expect(asUser.query(api.leadAnalysis.getConfig, {})).rejects.toThrow();
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { enabled: true } }),
  ).rejects.toThrow();
});

async function seedScoredLead(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: {
    score?: number;
    band?: "hot" | "warm" | "cold";
    lastSender?: "customer" | "agent";
    assignedToUserId?: Id<"users">;
    phone?: string;
    name?: string;
  } = {},
) {
  return await t.run(async (ctx) => {
    const phone = opts.phone ?? `+9715${Math.floor(Math.random() * 1e8)}`;
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone, phoneNormalized: phone.replace(/\D/g, ""), name: opts.name ?? "Asha",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open" as const, unreadCount: 0,
      lastMessageAt: Date.now() - 86_400_000,
      ...(opts.assignedToUserId ? { assignedToUserId: opts.assignedToUserId } : {}),
    });
    await ctx.db.insert("messages", {
      accountId, conversationId,
      senderType: (opts.lastSender ?? "customer") as "customer" | "agent",
      contentType: "text" as const, contentText: "hi", status: "delivered" as const,
    });
    const analysisId = await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored" as const, attempts: 0,
      sequenceStatus: "idle" as const, followUpsSent: 0,
      ...(opts.score !== undefined ? { score: opts.score } : {}),
      ...(opts.band ? { band: opts.band } : {}),
      reason: "test reason", signals: ["dates_given"], scoredAt: Date.now(),
    });
    return { analysisId, conversationId, contactId };
  });
}

test("board returns scored leads sorted by priority", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedScoredLead(t, accountId, { score: 3, band: "cold" });
  await seedScoredLead(t, accountId, { score: 9, band: "hot" });

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads.map((l) => l.score)).toEqual([9, 3]);
});

test("board derives the lane from the last message sender", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedScoredLead(t, accountId, { score: 5, lastSender: "customer" });

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads[0].lane).toBe("awaiting_us");
});

test("board summary counts bands and lanes", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedScoredLead(t, accountId, { score: 9, band: "hot", lastSender: "customer" });
  await seedScoredLead(t, accountId, { score: 5, band: "warm", lastSender: "agent" });

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.summary.hot).toBe(1);
  expect(board.summary.warm).toBe(1);
  expect(board.summary.cold).toBe(0);
  expect(board.summary.awaitingUs).toBe(1);
  expect(board.summary.total).toBe(2);
});

test("board reports unscored leads separately from scored ones", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4, band: "warm" });
  await t.run((ctx) =>
    ctx.db.patch(lead.analysisId, {
      scoreStatus: "pending" as const, score: undefined, band: undefined,
    }),
  );

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.summary.unscored).toBe(1);
  expect(board.leads[0].score).toBeNull();
});

test("board never returns skipped rows", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });
  await t.run((ctx) => ctx.db.patch(lead.analysisId, { scoreStatus: "skipped" as const }));

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads).toHaveLength(0);
});

test("an agent sees only leads assigned to them", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Agent", email: "ag@x.com", role: "agent",
  });
  await seedScoredLead(t, accountId, { score: 9, assignedToUserId: userId });
  await seedScoredLead(t, accountId, { score: 8 }); // unassigned

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads).toHaveLength(1);
  expect(board.leads[0].score).toBe(9);
});

test("an agent's assigned lead below the cap still appears — the cap must not gate by score before the assignee filter", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Agent", email: "ag@x.com", role: "agent",
  });

  const originalCap = BOARD_LIMITS.cap;
  BOARD_LIMITS.cap = 3;
  try {
    // Three colleague leads outrank the cap; the agent's own lead is the
    // lowest-scored row in the account, so a "take top-cap by score, then
    // filter by assignee" implementation drops it before the filter ever
    // runs.
    await seedScoredLead(t, accountId, { score: 10 });
    await seedScoredLead(t, accountId, { score: 9 });
    await seedScoredLead(t, accountId, { score: 8 });
    const own = await seedScoredLead(t, accountId, {
      score: 1,
      assignedToUserId: userId,
    });

    const board = await asUser.query(api.leadAnalysis.board, {});

    expect(board.leads).toHaveLength(1);
    expect(board.leads[0].conversationId).toBe(own.conversationId);
    expect(board.leads[0].score).toBe(1);
  } finally {
    BOARD_LIMITS.cap = originalCap;
  }
});

test("a viewer is denied the board entirely", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Viewer", email: "v@x.com", role: "viewer",
  });
  await expect(asUser.query(api.leadAnalysis.board, {})).rejects.toThrow();
});

test("the board never leaks another account's leads", async () => {
  const t = convexTest(schema, modules);
  const a = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "owner" });
  const b = await seedAccountMember(t, { name: "B", email: "b@x.com", role: "owner" });
  await seedScoredLead(t, b.accountId, { score: 10 });

  const board = await a.asUser.query(api.leadAnalysis.board, {});

  expect(board.leads).toHaveLength(0);
});

test("reanalyze re-arms the row immediately", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });
  await t.run((ctx) => ctx.db.patch(lead.analysisId, { scoredThroughMs: 9_000 }));

  await asUser.mutation(api.leadAnalysis.reanalyze, {
    conversationId: lead.conversationId,
  });

  const row = await t.run((ctx) => ctx.db.get(lead.analysisId));
  expect(row!.scoreStatus).toBe("pending");
  expect(row!.rescoreDueAt!).toBeLessThanOrEqual(Date.now());
  // Cleared so the dedup short-circuit cannot swallow the manual request.
  expect(row!.scoredThroughMs).toBeUndefined();
  expect(row!.attempts).toBe(0);
});

test("reanalyze denies an agent who is not the conversation's assignee", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, { name: "Owner", email: "o@x.com", role: "owner" });
  const agentAId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "AgentA", email: "a1@x.com" }),
  );
  const agentBId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "AgentB", email: "a2@x.com" }),
  );
  await t.run(async (ctx) => {
    await ctx.db.insert("memberships", {
      userId: agentAId, accountId: owner.accountId, role: "agent",
      fullName: "AgentA", email: "a1@x.com",
    });
    await ctx.db.insert("memberships", {
      userId: agentBId, accountId: owner.accountId, role: "agent",
      fullName: "AgentB", email: "a2@x.com",
    });
  });
  const asAgentB = t.withIdentity({ subject: `${agentBId}|session-AgentB` });

  // Assigned to A, not B.
  const lead = await seedScoredLead(t, owner.accountId, {
    score: 4, assignedToUserId: agentAId,
  });

  await expect(
    asAgentB.mutation(api.leadAnalysis.reanalyze, { conversationId: lead.conversationId }),
  ).rejects.toThrow();
});

test("reanalyze allows an agent to reanalyze their own assigned conversation", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, { name: "Owner", email: "o@x.com", role: "owner" });
  const agentId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Agent", email: "ag2@x.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: agentId, accountId: owner.accountId, role: "agent",
      fullName: "Agent", email: "ag2@x.com",
    }),
  );
  const asAgent = t.withIdentity({ subject: `${agentId}|session-Agent` });

  const lead = await seedScoredLead(t, owner.accountId, {
    score: 4, assignedToUserId: agentId,
  });

  const result = await asAgent.mutation(api.leadAnalysis.reanalyze, {
    conversationId: lead.conversationId,
  });
  expect(result).toBe(lead.analysisId);

  const row = await t.run((ctx) => ctx.db.get(lead.analysisId));
  expect(row!.scoreStatus).toBe("pending");
});

// ------------------------------------------------------------------
// Mirror invariant (P2 review, "Lead Analysis P2"): `leadAnalyses.archived`
// must reflect `conversations.archivedAt` on EVERY insert path, including
// `reanalyze`'s create-path below — an agent can reanalyze an archived
// conversation that has no row yet, and the inserted row must not claim to
// be active. See the SYNC INVARIANT comment on `leadAnalyses.archived` in
// schema.ts.
// ------------------------------------------------------------------
test("reanalyze's create-path mirrors archived: true for an archived conversation with no existing row", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });
  await t.run((ctx) => ctx.db.delete(lead.analysisId));
  await t.run((ctx) => ctx.db.patch(lead.conversationId, { archivedAt: Date.now() }));

  const analysisId = await asUser.mutation(api.leadAnalysis.reanalyze, {
    conversationId: lead.conversationId,
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.archived).toBe(true);
});

// Control: the same create-path on an ACTIVE conversation must leave
// `archived` as `undefined` — never `false`, since `false` would break the
// `eq("archived", undefined)` exact index range the board relies on.
test("reanalyze's create-path leaves archived undefined (not false) for an active conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });
  await t.run((ctx) => ctx.db.delete(lead.analysisId));

  const analysisId = await asUser.mutation(api.leadAnalysis.reanalyze, {
    conversationId: lead.conversationId,
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.archived).toBeUndefined();
});

test("reanalyze is denied to a viewer", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, { name: "O", email: "o@x.com", role: "owner" });
  const viewer = await seedAccountMember(t, {
    name: "V", email: "v@x.com", role: "viewer",
  });
  const lead = await seedScoredLead(t, owner.accountId, { score: 4 });

  await expect(
    viewer.asUser.mutation(api.leadAnalysis.reanalyze, {
      conversationId: lead.conversationId,
    }),
  ).rejects.toThrow();
});

test("archive stamps the conversation and mirrors onto the analysis row", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });

  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
    note: "  went quiet  ",
  });

  const conversation = await t.run((ctx) => ctx.db.get(lead.conversationId));
  expect(conversation!.archivedAt).toBeDefined();
  expect(conversation!.archivedReason).toBe("manual");
  expect(conversation!.archivedNote).toBe("went quiet");
  expect(conversation!.archivedByUserId).toBe(userId);
  // Archiving declares the thread dealt with, so the unread badge clears.
  expect(conversation!.unreadCount).toBe(0);

  const analysis = await t.run((ctx) => ctx.db.get(lead.analysisId));
  expect(analysis!.archived).toBe(true);
});

test("archive rejects a reason outside the vocabulary", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });

  await expect(
    asUser.mutation(api.leadAnalysis.archive, {
      conversationId: lead.conversationId,
      reason: "because_i_said_so",
    }),
  ).rejects.toThrow();
});

test("archive works on a conversation with no analysis row", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });
  await t.run((ctx) => ctx.db.delete(lead.analysisId));

  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });

  const conversation = await t.run((ctx) => ctx.db.get(lead.conversationId));
  expect(conversation!.archivedAt).toBeDefined();
});

test("archive is idempotent — re-archiving does not move the timestamp", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });

  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });
  const first = (await t.run((ctx) => ctx.db.get(lead.conversationId)))!.archivedAt;
  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });
  const second = (await t.run((ctx) => ctx.db.get(lead.conversationId)))!.archivedAt;

  expect(second).toBe(first);
});

test("restore clears both rows", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });
  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });

  await asUser.mutation(api.leadAnalysis.restore, {
    conversationId: lead.conversationId,
  });

  const conversation = await t.run((ctx) => ctx.db.get(lead.conversationId));
  expect(conversation!.archivedAt).toBeUndefined();
  expect(conversation!.archivedReason).toBeUndefined();
  expect(conversation!.archivedNote).toBeUndefined();
  expect(conversation!.archivedByUserId).toBeUndefined();

  // Cleared, not `false` — the active board view ranges on `undefined`.
  const analysis = await t.run((ctx) => ctx.db.get(lead.analysisId));
  expect(analysis!.archived).toBeUndefined();
});

// Amended P3 Task 5 (spec docs/superpowers/specs/2026-07-27-inbox-lanes-design.md
// §RBAC): this test used to assert "an agent cannot archive", encoding P2's
// shipped supervisor+ gate. That gate is deliberately lowered to agent+ here,
// so the assertion moves to the role that remains excluded — viewer.
test("a viewer cannot archive", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "O", email: "o@x.com", role: "owner",
  });
  const viewer = await seedAccountMember(t, {
    name: "V", email: "v@x.com", role: "viewer", accountId: owner.accountId,
  });
  const lead = await seedScoredLead(t, owner.accountId, { score: 4 });

  await expect(
    viewer.asUser.mutation(api.leadAnalysis.archive, {
      conversationId: lead.conversationId,
    }),
  ).rejects.toThrow();
});

test("an agent can archive and restore; a viewer cannot", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asAgent } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "agent",
  });
  const { asUser: asViewer } = await seedAccountMember(t, {
    name: "Vic", email: "vic@example.com", role: "viewer", accountId,
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });

  await asAgent.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });
  expect((await t.run((ctx) => ctx.db.get(lead.conversationId)))!.archivedAt)
    .toBeGreaterThan(0);

  await asAgent.mutation(api.leadAnalysis.restore, {
    conversationId: lead.conversationId,
  });
  expect((await t.run((ctx) => ctx.db.get(lead.conversationId)))!.archivedAt)
    .toBeUndefined();

  await expect(
    asViewer.mutation(api.leadAnalysis.archive, {
      conversationId: lead.conversationId,
    }),
  ).rejects.toThrow();
});

test("archive cannot reach another account's conversation", async () => {
  const t = convexTest(schema, modules);
  const a = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "owner" });
  const b = await seedAccountMember(t, { name: "B", email: "b@x.com", role: "owner" });
  const lead = await seedScoredLead(t, b.accountId, { score: 4 });

  await expect(
    a.asUser.mutation(api.leadAnalysis.archive, {
      conversationId: lead.conversationId,
    }),
  ).rejects.toThrow();
});

// P3 Task 5: the follow-up sequence's auto-archive runs from a cron with
// no acting user, so it cannot call the supervisor-gated `archive`
// mutation. It calls the shared `archiveConversationCore` through this
// internal wrapper instead — same invariant, same idempotence guard, same
// unread reset, just no `archivedByUserId`.
test("archiveAutomated performs an unattended archive: sets fields, mirrors, leaves archivedByUserId unset", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });
  // Non-zero so the reset below is actually pinning something.
  await t.run((ctx) => ctx.db.patch(lead.conversationId, { unreadCount: 3 }));

  await t.mutation(internal.leadAnalysis.archiveAutomated, {
    accountId,
    conversationId: lead.conversationId,
    reason: "no_response",
  });

  const conversation = await t.run((ctx) => ctx.db.get(lead.conversationId));
  expect(conversation!.archivedAt).toBeDefined();
  expect(conversation!.archivedReason).toBe("no_response");
  // Absent = archived by automation (schema.ts convention) — no user ran this.
  expect(conversation!.archivedByUserId).toBeUndefined();
  expect(conversation!.unreadCount).toBe(0);

  const analysis = await t.run((ctx) => ctx.db.get(lead.analysisId));
  expect(analysis!.archived).toBe(true);
});

test("archiveAutomated is idempotent — a second call does not move archivedAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });

  await t.mutation(internal.leadAnalysis.archiveAutomated, {
    accountId,
    conversationId: lead.conversationId,
    reason: "no_response",
  });
  const first = (await t.run((ctx) => ctx.db.get(lead.conversationId)))!.archivedAt;

  await t.mutation(internal.leadAnalysis.archiveAutomated, {
    accountId,
    conversationId: lead.conversationId,
    reason: "no_response",
  });
  const second = (await t.run((ctx) => ctx.db.get(lead.conversationId)))!.archivedAt;

  expect(second).toBe(first);
});

// Every sibling internal function that touches a `conversationId`
// verifies tenancy (`getForAccountInternal`, `resolveSendTarget`,
// `unarchiveOnInbound`), because "internal" only means unreachable from
// a client — it says nothing about immunity to a caller bug or a bad
// join in the sweep. Archiving is a customer-visible write (it pulls a
// thread out of every agent's Inbox), so a cross-tenant one must be
// silently rejected, mirroring `unarchiveOnInbound`'s "return early, do
// not throw" shape so one bad row can't crash the whole sweep.
test("archiveAutomated does nothing when the conversation belongs to a different account", async () => {
  const t = convexTest(schema, modules);
  const a = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "owner" });
  const b = await seedAccountMember(t, { name: "B", email: "b@x.com", role: "owner" });
  const lead = await seedScoredLead(t, b.accountId, { score: 4 });

  await t.mutation(internal.leadAnalysis.archiveAutomated, {
    accountId: a.accountId,
    conversationId: lead.conversationId,
    reason: "no_response",
  });

  const conversation = await t.run((ctx) => ctx.db.get(lead.conversationId));
  expect(conversation!.archivedAt).toBeUndefined();

  const analysis = await t.run((ctx) => ctx.db.get(lead.analysisId));
  expect(analysis!.archived).toBeUndefined();
});

test("board defaults to the active view and hides archived leads", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const active = await seedScoredLead(t, accountId, { score: 5 });
  const archived = await seedScoredLead(t, accountId, { score: 9 });
  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: archived.conversationId,
  });

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads.map((l) => l.conversationId)).toEqual([active.conversationId]);
});

test("board with view archived returns only archived leads", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedScoredLead(t, accountId, { score: 5 });
  const archived = await seedScoredLead(t, accountId, { score: 9 });
  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: archived.conversationId,
  });

  const board = await asUser.query(api.leadAnalysis.board, { view: "archived" });

  expect(board.leads.map((l) => l.conversationId)).toEqual([archived.conversationId]);
  expect(board.leads[0].archived).toBe(true);
});

test("a restored lead returns to the active view", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 6 });
  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });
  await asUser.mutation(api.leadAnalysis.restore, {
    conversationId: lead.conversationId,
  });

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads.map((l) => l.conversationId)).toEqual([lead.conversationId]);
});

test("a pre-archive row with no `archived` field counts as active", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 6 });
  await t.run((ctx) => ctx.db.patch(lead.analysisId, { archived: undefined }));

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads.map((l) => l.conversationId)).toEqual([lead.conversationId]);
});

// ============================================================
// sequencePreview (P3 Task 9). Reuses `evaluateSequence` (the same gate
// chain `sequenceContext` calls at real send time) with `enabled` forced
// to `true` — the whole point of this query is to be run BEFORE the
// owner ever flips `leadAnalysisConfigs.enabled`, so it must never gate
// on that flag itself. These tests pin: it works with the feature off,
// and it surfaces (never silently hides) the two fail-closed
// configurations the spec calls out as the most confusing failure mode —
// unset working hours and a missing/unapproved template.
// ============================================================

const PREVIEW_DAY = 24 * 60 * 60_000;
const PREVIEW_NOW = Date.UTC(2026, 6, 25, 12, 0); // noon UTC, arbitrary fixed instant

async function seedPreviewConfig(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  overrides: Record<string, unknown> = {},
) {
  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(),
      accountId,
      enabled: false, // the preview's entire purpose: inspect before enabling
      idleDaysBeforeSequence: 3,
      humanQuietHours: 24,
      dailySendCap: 100,
      bands: [
        {
          key: "hot" as const,
          minScore: 8,
          maxScore: 10,
          autoArchive: false,
          steps: [{ delayDays: 2, templateName: "hot_nudge_1", templateLanguage: "en" }],
        },
      ],
      ...overrides,
    }),
  );
}

async function seedPreviewWorkingHours(
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
      maxFollowUps: 4,
      ...overrides,
    }),
  );
}

async function seedPreviewTemplate(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  args: { name: string; language?: string; status?: "APPROVED" | "PENDING" },
) {
  await t.run((ctx) =>
    ctx.db.insert("messageTemplates", {
      accountId,
      name: args.name,
      language: args.language,
      category: "Marketing" as const,
      bodyText: "Hi! Checking in about your travel plans.",
      status: args.status ?? "APPROVED",
    }),
  );
}

async function seedPreviewLeadRow(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: { band?: "hot" | "warm" | "cold"; followUpsSent?: number } = {},
) {
  const phone = `+9715${Math.floor(Math.random() * 1e8)}`;
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone, phoneNormalized: phone.replace(/\D/g, ""), name: "Asha",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open" as const, unreadCount: 0,
    });
    const analysisId = await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      score: 9, band: opts.band ?? "hot",
      scoreStatus: "scored" as const, attempts: 0,
      sequenceStatus: "idle" as const,
      followUpsSent: opts.followUpsSent ?? 0,
      reason: "test", signals: [], scoredAt: Date.now(),
    });
    return { analysisId, conversationId, contactId, phone };
  });
}

async function seedPreviewMessage(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  senderType: "customer" | "agent" | "bot",
) {
  await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId, conversationId, senderType,
      contentType: "text" as const, contentText: "hi", status: "delivered" as const,
    }),
  );
}

/** A clear, idle-enough timeline: customer message 5 days ago, then our
 *  own outbound 4 days ago — past the suite's `idleDaysBeforeSequence: 3`
 *  and clear of gate 4 (`replied`), same shape as
 *  `leadAnalysisEngine.test.ts`'s `seedClearTimeline`. */
async function seedPreviewClearTimeline(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
) {
  vi.setSystemTime(PREVIEW_NOW - 5 * PREVIEW_DAY);
  await seedPreviewMessage(t, accountId, conversationId, "customer");
  vi.setSystemTime(PREVIEW_NOW - 4 * PREVIEW_DAY);
  await seedPreviewMessage(t, accountId, conversationId, "bot");
}

test("sequencePreview returns a projected send even while the feature is disabled", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    // Parked well before every timestamp this test seeds — convex-test's
    // `_creationTime` is monotonic per instance and never moves backwards.
    vi.setSystemTime(PREVIEW_NOW - 30 * PREVIEW_DAY);
    const { accountId, asUser } = await seedAccountMember(t, {
      name: "Sup", email: "s@x.com", role: "supervisor",
    });
    await seedPreviewConfig(t, accountId); // enabled: false
    await seedPreviewWorkingHours(t, accountId);
    await seedPreviewTemplate(t, accountId, { name: "hot_nudge_1", language: "en" });
    const lead = await seedPreviewLeadRow(t, accountId, { band: "hot" });
    await seedPreviewClearTimeline(t, accountId, lead.conversationId);

    // Confirm the account's config is genuinely disabled — the point of
    // this test is that the preview ignores that and evaluates anyway.
    const config = await t.run((ctx) =>
      ctx.db
        .query("leadAnalysisConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .unique(),
    );
    expect(config!.enabled).toBe(false);

    vi.setSystemTime(PREVIEW_NOW);
    const preview = await asUser.query(api.leadAnalysis.sequencePreview, {});

    expect(preview.leads).toHaveLength(1);
    expect(preview.leads[0]).toMatchObject({
      analysisId: lead.analysisId,
      band: "hot",
      stepIndex: 0,
      templateName: "hot_nudge_1",
      templateApproved: true,
      verdict: "send",
    });
    expect(preview.leads[0].projectedSendAt).toBeLessThanOrEqual(PREVIEW_NOW);
    expect(preview.workingHoursKnown).toBe(true);
    expect(preview.warnings).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("sequencePreview flags unset working hours loudly instead of showing a send that will never happen", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(PREVIEW_NOW - 30 * PREVIEW_DAY);
    const { accountId, asUser } = await seedAccountMember(t, {
      name: "Sup", email: "s@x.com", role: "supervisor",
    });
    await seedPreviewConfig(t, accountId);
    // Deliberately no qualificationConfigs row — working hours unset.
    await seedPreviewTemplate(t, accountId, { name: "hot_nudge_1", language: "en" });
    const lead = await seedPreviewLeadRow(t, accountId, { band: "hot" });
    await seedPreviewClearTimeline(t, accountId, lead.conversationId);

    vi.setSystemTime(PREVIEW_NOW);
    const preview = await asUser.query(api.leadAnalysis.sequencePreview, {});

    expect(preview.workingHoursKnown).toBe(false);
    expect(preview.warnings.some((w) => /working hours/i.test(w))).toBe(true);
    expect(preview.leads).toHaveLength(1);
    expect(preview.leads[0]).toMatchObject({
      verdict: "stop", reason: "working_hours_unset", projectedSendAt: null,
    });
  } finally {
    vi.useRealTimers();
  }
});

test("sequencePreview flags a missing/unapproved template instead of showing a send that will never happen", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(PREVIEW_NOW - 30 * PREVIEW_DAY);
    const { accountId, asUser } = await seedAccountMember(t, {
      name: "Sup", email: "s@x.com", role: "supervisor",
    });
    await seedPreviewConfig(t, accountId);
    await seedPreviewWorkingHours(t, accountId);
    // Template exists but is still PENDING Meta approval — never APPROVED.
    await seedPreviewTemplate(t, accountId, {
      name: "hot_nudge_1", language: "en", status: "PENDING",
    });
    const lead = await seedPreviewLeadRow(t, accountId, { band: "hot" });
    await seedPreviewClearTimeline(t, accountId, lead.conversationId);

    vi.setSystemTime(PREVIEW_NOW);
    const preview = await asUser.query(api.leadAnalysis.sequencePreview, {});

    expect(preview.warnings.some((w) => /template/i.test(w) && /hot_nudge_1/.test(w))).toBe(true);
    expect(preview.leads).toHaveLength(1);
    expect(preview.leads[0]).toMatchObject({
      verdict: "stop", reason: "template_unavailable",
      templateApproved: false, projectedSendAt: null,
    });
  } finally {
    vi.useRealTimers();
  }
});

test("sequencePreview is bounded by an explicit limit", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(PREVIEW_NOW - 30 * PREVIEW_DAY);
    const { accountId, asUser } = await seedAccountMember(t, {
      name: "Sup", email: "s@x.com", role: "supervisor",
    });
    await seedPreviewConfig(t, accountId);
    await seedPreviewWorkingHours(t, accountId);
    await seedPreviewTemplate(t, accountId, { name: "hot_nudge_1", language: "en" });
    for (let i = 0; i < 3; i++) {
      const lead = await seedPreviewLeadRow(t, accountId, { band: "hot" });
      await seedPreviewClearTimeline(t, accountId, lead.conversationId);
    }

    vi.setSystemTime(PREVIEW_NOW);
    const preview = await asUser.query(api.leadAnalysis.sequencePreview, { limit: 2 });

    expect(preview.leads.length).toBeLessThanOrEqual(2);
  } finally {
    vi.useRealTimers();
  }
});

test("sequencePreview is denied to an agent", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Agent", email: "ag@x.com", role: "agent",
  });
  await expect(asUser.query(api.leadAnalysis.sequencePreview, {})).rejects.toThrow();
});

// ============================================================
// stopSequence (P3 Task 9). A human pulling a lead out of the follow-up
// sequence: `sequenceStatus: "stopped"`, `stoppedReason: "manual"`, and
// `nextFollowUpAt` cleared so a concurrent sweep can never find it due.
// ============================================================

test("stopSequence stops a running lead and clears its schedule", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 9, band: "hot" });
  await t.run((ctx) =>
    ctx.db.patch(lead.analysisId, {
      sequenceStatus: "running" as const,
      followUpsSent: 1,
      nextFollowUpAt: Date.now() + 60_000,
    }),
  );

  await asUser.mutation(api.leadAnalysis.stopSequence, {
    conversationId: lead.conversationId,
  });

  const row = await t.run((ctx) => ctx.db.get(lead.analysisId));
  expect(row!.sequenceStatus).toBe("stopped");
  expect(row!.stoppedReason).toBe("manual");
  expect(row!.nextFollowUpAt).toBeUndefined();
});

// Amended P3 Task 5 (spec docs/superpowers/specs/2026-07-27-inbox-lanes-design.md
// §RBAC): this test used to assert "stopSequence is denied to an agent",
// encoding P2's shipped supervisor+ gate. That gate is deliberately lowered
// to agent+ here, so the assertion moves to the role that remains
// excluded — viewer.
test("stopSequence is denied to a viewer", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, { name: "O", email: "o@x.com", role: "owner" });
  const viewer = await seedAccountMember(t, {
    name: "V", email: "v@x.com", role: "viewer", accountId: owner.accountId,
  });
  const lead = await seedScoredLead(t, owner.accountId, { score: 9, band: "hot" });

  await expect(
    viewer.asUser.mutation(api.leadAnalysis.stopSequence, {
      conversationId: lead.conversationId,
    }),
  ).rejects.toThrow();
});

test("stopSequence cannot reach another account's conversation", async () => {
  const t = convexTest(schema, modules);
  const a = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "owner" });
  const b = await seedAccountMember(t, { name: "B", email: "b@x.com", role: "owner" });
  const lead = await seedScoredLead(t, b.accountId, { score: 9, band: "hot" });

  await expect(
    a.asUser.mutation(api.leadAnalysis.stopSequence, {
      conversationId: lead.conversationId,
    }),
  ).rejects.toThrow();
});

test("board uses the denormalised sender type when present", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });

  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000002", phoneNormalized: "971500000002", name: "Asha",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      lastMessageAt: Date.now(),
      // Field says "bot" and there is NO messages row at all. Today's
      // code passes `null` to `leadLane`, which yields "awaiting_us", so
      // this fails until the field is actually read — the assertion is
      // deliberately the value the fallback could never produce.
      lastMessageSenderType: "bot",
    });
    await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored", score: 8, band: "hot",
      attempts: 0, sequenceStatus: "idle", followUpsSent: 0,
    });
  });

  const board = await asUser.query(api.leadAnalysis.board, { view: "active" });
  expect(board.leads).toHaveLength(1);
  expect(board.leads[0]!.lane).toBe("awaiting_them");
});

test("board falls back to the messages query when the field is absent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });

  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000003", phoneNormalized: "971500000003", name: "Budi",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      lastMessageAt: Date.now(),
      // Field deliberately absent — the pre-backfill state.
    });
    await ctx.db.insert("messages", {
      accountId, conversationId, senderType: "customer",
      contentType: "text", contentText: "still waiting", status: "sent",
    });
    await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored", score: 5, band: "warm",
      attempts: 0, sequenceStatus: "idle", followUpsSent: 0,
    });
  });

  const board = await asUser.query(api.leadAnalysis.board, { view: "active" });
  expect(board.leads).toHaveLength(1);
  // Absent must never be coerced to a sender type: the real row says
  // "customer", so the lane is the one automation may not act on.
  expect(board.leads[0]!.lane).toBe("awaiting_us");
});

test("board leaves an empty thread in the conservative lane", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });

  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000004", phoneNormalized: "971500000004",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored", score: 3, band: "cold",
      attempts: 0, sequenceStatus: "idle", followUpsSent: 0,
    });
  });

  const board = await asUser.query(api.leadAnalysis.board, { view: "active" });
  expect(board.leads[0]!.lane).toBe("awaiting_us");
});

test("board falls back to the session for a row with no cached service name", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });

  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000007", phoneNormalized: "971500000007",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      lastMessageSenderType: "bot", lastMessageAt: Date.now(),
    });
    await ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId,
      status: "collecting", origin: "inbound", fields: [],
      expectedCount: 0, answeredCount: 0, followUpsSent: 0,
      phrasingCursor: 0, sendAttemptErrors: 0,
      serviceName: "Freelance Visa",
    });
    await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored", score: 6, band: "warm",
      attempts: 0, sequenceStatus: "idle", followUpsSent: 0,
      // serviceName deliberately absent
    });
  });

  const board = await asUser.query(api.leadAnalysis.board, { view: "active" });
  expect(board.leads[0]!.serviceName).toBe("Freelance Visa");
});

test("archiving clears a snooze and a forced-chasing mark", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "agent",
  });
  const conversationId = await seedConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(conversationId, {
    snoozedUntil: Date.now() + 86_400_000, chasingForcedAt: Date.now(),
  }));

  await asUser.mutation(api.leadAnalysis.archive, { conversationId });

  const c = await t.run((ctx) => ctx.db.get(conversationId));
  expect(c!.archivedAt).toBeGreaterThan(0);
  expect(c!.snoozedUntil).toBeUndefined();
  expect(c!.chasingForcedAt).toBeUndefined();
});

// ── Server-side filtering + paging ──────────────────────────────────
// The board used to hand the client its whole (capped) list and let the
// browser filter and render all of it. Both jobs moved here so only one
// page crosses the wire; these cover the parts that are easy to get
// subtly wrong — that the totals describe the FILTERED set, that the
// summary does NOT, and that filtering spans the whole board rather than
// the page that happens to be returned.

/** Five scored leads, descending 9..5, so page boundaries are readable. */
async function seedFive(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  for (const score of [9, 8, 7, 6, 5]) {
    await seedScoredLead(t, accountId, { score, band: "hot" });
  }
}

test("board returns a single page and reports the full total", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedFive(t, accountId);

  const first = await asUser.query(api.leadAnalysis.board, { page: 0, pageSize: 2 });

  expect(first.leads.map((l) => l.score)).toEqual([9, 8]);
  // `total`/`pageCount` describe the whole set, not the page — this is
  // what lets the client render "Page 1 of 3" without a second query.
  expect(first.total).toBe(5);
  expect(first.pageCount).toBe(3);
  expect(first.page).toBe(0);
});

test("board pages stay in priority order and do not overlap", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedFive(t, accountId);

  const p1 = await asUser.query(api.leadAnalysis.board, { page: 1, pageSize: 2 });
  const p2 = await asUser.query(api.leadAnalysis.board, { page: 2, pageSize: 2 });

  expect(p1.leads.map((l) => l.score)).toEqual([7, 6]);
  expect(p2.leads.map((l) => l.score)).toEqual([5]);
});

test("board returns the whole list when pageSize is omitted", async () => {
  // Backward compatibility is load-bearing: /leads' Pipeline kanban and
  // the dashboard's pipeline card both group EVERY lead by stage, and
  // both still call this with no paging args.
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedFive(t, accountId);

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads).toHaveLength(5);
  expect(board.pageCount).toBe(1);
});

test("board clamps a page past the end back onto the last page", async () => {
  // The board is a live subscription, so rows can be archived out from
  // under a client already sitting on the final page. Clamping is what
  // stops that from rendering as an empty list.
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedFive(t, accountId);

  const board = await asUser.query(api.leadAnalysis.board, { page: 99, pageSize: 2 });

  expect(board.page).toBe(2);
  expect(board.leads.map((l) => l.score)).toEqual([5]);
});

test("board filters by band across the whole board, not just the page", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  // The cold lead sorts LAST, so it would fall off page 1 entirely. A
  // filter applied client-side to one page could never have found it.
  await seedScoredLead(t, accountId, { score: 9, band: "hot" });
  await seedScoredLead(t, accountId, { score: 8, band: "hot" });
  await seedScoredLead(t, accountId, { score: 1, band: "cold" });

  const board = await asUser.query(api.leadAnalysis.board, {
    band: "cold", page: 0, pageSize: 2,
  });

  expect(board.leads.map((l) => l.score)).toEqual([1]);
  expect(board.total).toBe(1);
});

test("board filters by lane server-side", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedScoredLead(t, accountId, { score: 9, lastSender: "customer" });
  await seedScoredLead(t, accountId, { score: 8, lastSender: "agent" });

  const board = await asUser.query(api.leadAnalysis.board, { lane: "awaiting_them" });

  expect(board.leads).toHaveLength(1);
  expect(board.leads[0].lane).toBe("awaiting_them");
});

test("board searches name and phone server-side, ignoring phone punctuation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedScoredLead(t, accountId, { score: 9, name: "Priya", phone: "+971500000001" });
  await seedScoredLead(t, accountId, { score: 8, name: "Rahul", phone: "+971500000002" });

  const byName = await asUser.query(api.leadAnalysis.board, { search: "priya" });
  expect(byName.leads.map((l) => l.contactName)).toEqual(["Priya"]);

  // Digits only — an agent reading a number off a screen rarely types
  // the "+971" or the spacing.
  const byPhone = await asUser.query(api.leadAnalysis.board, { search: "500000002" });
  expect(byPhone.leads.map((l) => l.contactName)).toEqual(["Rahul"]);
});

test("board keeps the summary whole-board while the list is filtered", async () => {
  // The tiles are how you decide which filter to apply. Deriving them
  // from the filtered set would make the active tile echo your own
  // selection and every other tile read 0.
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedScoredLead(t, accountId, { score: 9, band: "hot" });
  await seedScoredLead(t, accountId, { score: 5, band: "warm" });
  await seedScoredLead(t, accountId, { score: 1, band: "cold" });

  const board = await asUser.query(api.leadAnalysis.board, { band: "hot" });

  expect(board.leads).toHaveLength(1);
  expect(board.total).toBe(1);
  expect(board.summary.hot).toBe(1);
  expect(board.summary.warm).toBe(1);
  expect(board.summary.cold).toBe(1);
  expect(board.summary.total).toBe(3);
});
