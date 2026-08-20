/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";
import type { AiUsageMode } from "./lib/aiUsageStats";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedMember(t: ReturnType<typeof convexTest>, role: AccountRole) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: role, email: `${role}@example.com` }),
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
      role,
      fullName: role,
      email: `${role}@example.com`,
    });
    return id;
  });
  return { userId, accountId, as: t.withIdentity({ subject: `${userId}|s` }) };
}

interface RosterShape {
  agents: Array<{
    key: string;
    status: string;
    workToday: number;
    blockedReason: string | null;
  }>;
}

function find(result: RosterShape, key: string) {
  const agent = result.agents.find((a) => a.key === key);
  expect(agent, `no agent with key ${key}`).toBeDefined();
  return agent!;
}

async function seedAiConfig(
  t: ReturnType<typeof convexTest>,
  accountId: string,
  userId: string,
  over: { isActive?: boolean; autoReplyEnabled?: boolean } = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("aiConfigs", {
      accountId: accountId as never,
      createdByUserId: userId as never,
      provider: "openai",
      model: "gpt-5",
      apiKey: "cipher",
      isActive: over.isActive ?? true,
      autoReplyEnabled: over.autoReplyEnabled ?? true,
      updatedAt: Date.now(),
    }),
  );
}

const HOUR_MS = 60 * 60 * 1000;

/** Matches `agentRoster.ts`'s own `startOfTodayMs`: midnight UTC. */
function startOfTodayMs(): number {
  return new Date(new Date().toISOString().slice(0, 10)).getTime();
}

/**
 * One `aiUsageHourlyStats` bucket. Token counters are deliberately
 * NON-ZERO so the viewer-access test below genuinely proves the roster
 * does not leak them — seeding zeroes would make that assertion pass for
 * the wrong reason.
 *
 * The caller gives `{ mode, calls }`; the schema's `modes` entries also
 * require `tokens`, which the roster never reads, so it is filled in
 * here rather than at every call site.
 */
async function seedUsageHour(
  t: ReturnType<typeof convexTest>,
  accountId: string,
  hourStartMs: number,
  modes: Array<{ mode: AiUsageMode; calls: number }>,
) {
  return await t.run((ctx) =>
    ctx.db.insert("aiUsageHourlyStats", {
      accountId: accountId as never,
      hourStartMs,
      calls: modes.reduce((n, m) => n + m.calls, 0),
      promptTokens: 900,
      completionTokens: 300,
      totalTokens: 1200,
      cachedPromptTokens: 100,
      cacheablePromptTokens: 900,
      reasoningTokens: 50,
      modes: modes.map((m) => ({ ...m, tokens: m.calls * 10 })),
      models: [
        { provider: "openai" as const, model: "gpt-5", calls: 1, tokens: 1200 },
      ],
    }),
  );
}

test("with nothing configured, every built agent is not hired", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(result.agents).toHaveLength(10);
  expect(find(result, "reply").status).toBe("not_hired");
  expect(find(result, "qualify").status).toBe("not_hired");
  expect(find(result, "revival").status).toBe("not_hired");
});

test("an enabled reply agent is on duty; disabling auto-reply puts it off duty", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");

  const configId = await seedAiConfig(t, accountId, userId);
  expect(
    find((await as.query(api.agentRoster.roster, {})) as RosterShape, "reply").status,
  ).toBe("on_duty");

  await t.run((ctx) => ctx.db.patch(configId, { autoReplyEnabled: false }));
  expect(
    find((await as.query(api.agentRoster.roster, {})) as RosterShape, "reply").status,
  ).toBe("off_duty");
});

test("the tag suggester is on call whenever AI is active, even with auto-reply off", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");
  await seedAiConfig(t, accountId, userId, { autoReplyEnabled: false });

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(find(result, "tags").status).toBe("on_call");
  expect(find(result, "reply").status).toBe("off_duty");
});

test("a failed cron run puts the lead scorer in attention", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "admin");

  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      accountId,
      enabled: true,
      rescoreDebounceMinutes: 10,
      scorePerRun: 5,
      backfillEnabled: false,
      backfillPerRun: 5,
      idleDaysBeforeSequence: 3,
      humanQuietHours: 24,
      dailySendCap: 50,
      bands: [],
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("cronRuns", {
      name: "lead-scoring",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      status: "failed",
      error: "provider timeout",
    }),
  );

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(find(result, "score").status).toBe("attention");
});

test("today's rollup counts to the owning agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");
  await seedAiConfig(t, accountId, userId);

  await seedUsageHour(t, accountId, startOfTodayMs(), [
    { mode: "auto_reply", calls: 2 },
    { mode: "draft", calls: 1 },
    { mode: "classify", calls: 1 },
  ]);

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(find(result, "reply").workToday).toBe(3);
  expect(find(result, "tags").workToday).toBe(1);
});

test("a mode's calls sum across every hour bucket of the day", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");
  await seedAiConfig(t, accountId, userId);

  // The case the old 1024-row cap could not report: a day's real volume,
  // spread across the hours it actually happened in.
  const midnight = startOfTodayMs();
  await seedUsageHour(t, accountId, midnight, [{ mode: "qualify", calls: 40 }]);
  await seedUsageHour(t, accountId, midnight + 5 * HOUR_MS, [
    { mode: "qualify", calls: 55 },
  ]);
  await seedUsageHour(t, accountId, midnight + 9 * HOUR_MS, [
    { mode: "qualify", calls: 12 },
  ]);

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(find(result, "qualify").workToday).toBe(107);
});

test("every hour bucket of the day counts, including the last", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "admin");

  // HOURS_PER_DAY is 24, and nothing above pins that at its boundary.
  // Seed all 24 UTC hour buckets (00:00 through 23:00) with a DISTINCT
  // call count per hour (hour index + 1), so the total also proves WHICH
  // hours were read, not just how many: 1 + 2 + ... + 24 = 300. Buckets
  // come back in ascending hourStartMs order, so if the bound were 23
  // the LAST bucket (23:00 UTC, calls: 24) would be dropped and the
  // total would read 276 instead.
  const midnight = startOfTodayMs();
  for (let hour = 0; hour < 24; hour++) {
    await seedUsageHour(t, accountId, midnight + hour * HOUR_MS, [
      { mode: "qualify", calls: hour + 1 },
    ]);
  }

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(find(result, "qualify").workToday).toBe(300);
});

test("a bucket from before midnight UTC is not today's work", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");
  await seedAiConfig(t, accountId, userId);

  const midnight = startOfTodayMs();
  await seedUsageHour(t, accountId, midnight - HOUR_MS, [
    { mode: "auto_reply", calls: 99 },
  ]);
  await seedUsageHour(t, accountId, midnight, [
    { mode: "auto_reply", calls: 4 },
  ]);

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(find(result, "reply").workToday).toBe(4);
});

test("one account's usage never counts toward another's roster", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedMember(t, "admin");
  const theirAccountId = await t.run(async (ctx) => {
    const otherOwner = await ctx.db.insert("users", {
      name: "Other",
      email: "other@example.com",
    });
    return await ctx.db.insert("accounts", {
      name: "B",
      defaultCurrency: "AED",
      ownerUserId: otherOwner,
    });
  });
  await seedUsageHour(t, theirAccountId, startOfTodayMs(), [
    { mode: "auto_reply", calls: 7 },
  ]);

  const result = (await mine.as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(find(result, "reply").workToday).toBe(0);
});

test("a viewer may read the roster — it carries no keys, prompts, or tokens", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "viewer");
  // Seed real token counters: the roster now reads documents that CARRY
  // tokens, so this assertion only means something if there are some to
  // leak.
  await seedUsageHour(t, accountId, startOfTodayMs(), [
    { mode: "auto_reply", calls: 3 },
  ]);

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(result.agents).toHaveLength(10);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("apiKey");
  expect(serialized).not.toContain("systemPrompt");
  expect(serialized).not.toContain("promptTokens");
  expect(serialized).not.toContain("1200");
});

test("an enabled revival config puts the agent on duty, not not-hired", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "admin");

  // Built but unconfigured: still not hired.
  expect(find((await as.query(api.agentRoster.roster, {})) as RosterShape, "revival").status)
    .toBe("not_hired");

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
    }),
  );

  expect(find((await as.query(api.agentRoster.roster, {})) as RosterShape, "revival").status)
    .toBe("on_duty");
});

interface DetailShape {
  key: string;
  name: string;
  status: string;
  instructions: string | null;
  trigger: string | null;
  reads: string | null;
  writes: string | null;
  enabled: boolean | null;
  dependsOn: { label: string; note: string; agentKey?: string } | null;
  workToday: number;
  lastRun: { status: string; startedAt: number } | null;
  supportsExtraInstructions: boolean;
}

test("detail describes an agent that owns its switch", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");
  await seedAiConfig(t, accountId, userId);

  const d = (await as.query(api.agentRoster.detail, { agentKey: "reply" })) as DetailShape;
  expect(d.name).toBe("Reply agent");
  expect(d.status).toBe("on_duty");
  expect(d.enabled).toBe(true);
  expect(d.instructions).toContain("knowledge base");
  expect(d.trigger).toBeTruthy();
  expect(d.reads).toBeTruthy();
  expect(d.writes).toBeTruthy();
  // It owns a switch, so it must not also claim a dependency.
  expect(d.dependsOn).toBeNull();
});

test("detail names what controls an agent with no switch of its own", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  const d = (await as.query(api.agentRoster.detail, { agentKey: "checklist" })) as DetailShape;
  // No toggle to render — the window states the truth instead.
  expect(d.enabled).toBeNull();
  expect(d.dependsOn?.label).toBe("Lead qualification");
  expect(d.dependsOn?.agentKey).toBe("qualify");
  expect(d.dependsOn?.note).toContain("no switch of its own");
});

test("detail reports an unbuilt agent as such, with nothing invented", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  const d = (await as.query(api.agentRoster.detail, { agentKey: "quote" })) as DetailShape;
  expect(d.status).toBe("not_hired");
  expect(d.instructions).toBeNull();
  expect(d.enabled).toBeNull();
  expect(d.dependsOn).toBeNull();
});

test("detail carries the live figures the roster shows", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");
  await seedAiConfig(t, accountId, userId);
  // Seeded as rollup buckets, not raw log rows: `detail` counts the same
  // way `roster` does, and a raw row that never reached a bucket is a row
  // nothing on this page can see.
  await seedUsageHour(t, accountId, startOfTodayMs(), [
    { mode: "auto_reply", calls: 2 },
  ]);

  const d = (await as.query(api.agentRoster.detail, { agentKey: "reply" })) as DetailShape;
  expect(d.workToday).toBe(2);
});

// `detail` shipped after `roster` and inherited the 1024-row raw-log cap
// that `roster` has since shed, so the same agent could be understated in
// two places at once. Pins that its count is exact past that old bound.
test("detail counts past the row cap the raw-log scan used to impose", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");
  await seedAiConfig(t, accountId, userId);
  const midnight = startOfTodayMs();
  await seedUsageHour(t, accountId, midnight, [{ mode: "auto_reply", calls: 900 }]);
  await seedUsageHour(t, accountId, midnight + HOUR_MS, [
    { mode: "auto_reply", calls: 900 },
  ]);

  const d = (await as.query(api.agentRoster.detail, { agentKey: "reply" })) as DetailShape;
  expect(d.workToday).toBe(1800);
});

test("detail leaks no keys, prompts, or token counts", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "viewer");
  await seedAiConfig(t, accountId, userId);

  const serialized = JSON.stringify(
    await as.query(api.agentRoster.detail, { agentKey: "reply" }),
  );
  expect(serialized).not.toContain("apiKey");
  expect(serialized).not.toContain("systemPrompt");
  expect(serialized).not.toContain("promptTokens");
});

test("detail says whether this agent actually reads extra instructions", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  const revival = (await as.query(api.agentRoster.detail, { agentKey: "revival" })) as DetailShape;
  expect(revival.supportsExtraInstructions).toBe(true);

  // Every built agent is plumbed now; an UNBUILT one must still not
  // offer a box that does nothing.
  const admatch = (await as.query(api.agentRoster.detail, { agentKey: "admatch" })) as DetailShape;
  expect(admatch.supportsExtraInstructions).toBe(true);
  const quote = (await as.query(api.agentRoster.detail, { agentKey: "quote" })) as DetailShape;
  expect(quote.supportsExtraInstructions).toBe(false);
});
