import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";
import { CRON_REGISTRY } from "./lib/cronSummary";

const modules = import.meta.glob("/convex/**/*.ts");

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedMember(t: ReturnType<typeof convexTest>, role: AccountRole) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: role, email: `${role}@example.com` }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "A", defaultCurrency: "AED", ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId, accountId: id, role, fullName: role, email: `${role}@example.com`,
    });
    return id;
  });
  return { userId, accountId, as: t.withIdentity({ subject: `${userId}|s` }) };
}

test("registry covers the five interval crons registered in crons.ts", () => {
  expect(CRON_REGISTRY.map((c) => c.name).sort()).toEqual([
    "qualification-follow-ups",
    "qualification-lead-offers",
    "qualification-staff-loops",
    "retry-ad-resolution",
    "retry-conversion-events",
  ]);
  for (const entry of CRON_REGISTRY) {
    expect(entry.intervalMinutes).toBeGreaterThan(0);
  }
});

test("recordStart inserts a running row; recordResult finalizes success and failure", async () => {
  const t = convexTest(schema, modules);

  const runId = await t.mutation(internal.cronSchedules.recordStart, {
    name: "retry-conversion-events",
  });
  let row = await t.run((ctx) => ctx.db.get(runId));
  expect(row).toMatchObject({ name: "retry-conversion-events", status: "running" });
  expect(row!.startedAt).toBeGreaterThan(0);
  expect(row!.finishedAt).toBeUndefined();

  await t.mutation(internal.cronSchedules.recordResult, { runId, ok: true });
  row = await t.run((ctx) => ctx.db.get(runId));
  expect(row!.status).toBe("success");
  expect(row!.finishedAt).toBeGreaterThanOrEqual(row!.startedAt);

  const failId = await t.mutation(internal.cronSchedules.recordStart, {
    name: "retry-conversion-events",
  });
  await t.mutation(internal.cronSchedules.recordResult, {
    runId: failId, ok: false, error: "network blew up",
  });
  const failRow = await t.run((ctx) => ctx.db.get(failId));
  expect(failRow).toMatchObject({ status: "failed", error: "network blew up" });
});

test("recordStart prunes runs of the same cron older than 7 days", async () => {
  const t = convexTest(schema, modules);
  const old = Date.now() - 8 * DAY_MS;
  await t.run(async (ctx) => {
    for (let i = 0; i < 5; i++) {
      await ctx.db.insert("cronRuns", {
        name: "qualification-follow-ups",
        startedAt: old + i, finishedAt: old + i + 10, status: "success",
      });
    }
    // A different cron's old row must survive this cron's prune.
    await ctx.db.insert("cronRuns", {
      name: "retry-ad-resolution",
      startedAt: old, finishedAt: old + 10, status: "success",
    });
  });

  await t.mutation(internal.cronSchedules.recordStart, {
    name: "qualification-follow-ups",
  });

  const rows = await t.run((ctx) => ctx.db.query("cronRuns").collect());
  const mine = rows.filter((r) => r.name === "qualification-follow-ups");
  expect(mine).toHaveLength(1); // just the fresh running row
  expect(mine[0].status).toBe("running");
  expect(rows.filter((r) => r.name === "retry-ad-resolution")).toHaveLength(1);
});

test("wrapped cron records a success run end-to-end (dormant sweep no-op)", async () => {
  const t = convexTest(schema, modules);

  await t.action(internal.cronSchedules.runSweepFollowUps, {});

  const rows = await t.run((ctx) => ctx.db.query("cronRuns").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    name: "qualification-follow-ups", status: "success",
  });
  expect(rows[0].finishedAt).toBeGreaterThanOrEqual(rows[0].startedAt);
});

test("overview requires the admin role", async () => {
  const t = convexTest(schema, modules);
  const supervisor = await seedMember(t, "supervisor");
  await expect(supervisor.as.query(api.cronSchedules.overview, {})).rejects.toThrow();
});

test("overview returns registry crons with last run, next-run estimate and recent runs", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");

  const startedAt = Date.now() - 60_000;
  await t.run(async (ctx) => {
    await ctx.db.insert("cronRuns", {
      name: "qualification-follow-ups",
      startedAt, finishedAt: startedAt + 800, status: "success",
    });
  });

  const out = await admin.as.query(api.cronSchedules.overview, {});
  expect(out.crons).toHaveLength(CRON_REGISTRY.length);

  const followUps = out.crons.find((c) => c.name === "qualification-follow-ups")!;
  expect(followUps.intervalMinutes).toBe(5);
  expect(followUps.lastRun).toMatchObject({ status: "success" });
  expect(followUps.nextRunAt).toBe(startedAt + 5 * 60_000);

  const never = out.crons.find((c) => c.name === "retry-ad-resolution")!;
  expect(never.lastRun).toBeNull();
  expect(never.nextRunAt).toBeNull();

  expect(out.recentRuns.length).toBeGreaterThanOrEqual(1);
  expect(out.recentRuns[0].name).toBe("qualification-follow-ups");
});

test("overview lists upcoming follow-up nudges and pending lead offers for this account only", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  const outsider = await seedMember(t, "admin");

  const due = Date.now() + 45 * 60_000;
  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId: admin.accountId, phone: "+971500000001",
      phoneNormalized: "971500000001", name: "Ramesh",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId: admin.accountId, contactId, status: "open", unreadCount: 0,
    });
    const sessionId = await ctx.db.insert("qualificationSessions", {
      accountId: admin.accountId, conversationId, contactId,
      status: "collecting", origin: "inbound", serviceName: "Bali package",
      fields: [], expectedCount: 4, answeredCount: 2,
      followUpsSent: 1, phrasingCursor: 0, sendAttemptErrors: 0,
      nextFollowUpAt: due,
    });
    await ctx.db.insert("leadOffers", {
      accountId: admin.accountId, sessionId, conversationId, contactId,
      agentUserId: admin.userId, agentPhone: "+971551234567",
      status: "offered", offeredAt: Date.now() - 2 * 60_000,
    });

    // Foreign-account noise: must never show up in admin's overview.
    const otherContact = await ctx.db.insert("contacts", {
      accountId: outsider.accountId, phone: "+971500000009",
      phoneNormalized: "971500000009",
    });
    const otherConversation = await ctx.db.insert("conversations", {
      accountId: outsider.accountId, contactId: otherContact,
      status: "open", unreadCount: 0,
    });
    await ctx.db.insert("qualificationSessions", {
      accountId: outsider.accountId, conversationId: otherConversation,
      contactId: otherContact, status: "collecting", origin: "inbound",
      fields: [], expectedCount: 0, answeredCount: 0,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
      nextFollowUpAt: due,
    });
  });

  const out = await admin.as.query(api.cronSchedules.overview, {});

  expect(out.followUps).toHaveLength(1);
  expect(out.followUps[0]).toMatchObject({
    contactName: "Ramesh", serviceName: "Bali package",
    nextFollowUpAt: due, followUpsSent: 1,
  });

  expect(out.offers).toHaveLength(1);
  expect(out.offers[0].agentName).toBe("admin");
  // Default consent window is 10 minutes from offeredAt.
  expect(out.offers[0].expiresAt).toBe(out.offers[0].offeredAt + 10 * 60_000);
});

test("overview skips sessions without a due follow-up", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId: admin.accountId, phone: "+971500000002",
      phoneNormalized: "971500000002",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId: admin.accountId, contactId, status: "open", unreadCount: 0,
    });
    await ctx.db.insert("qualificationSessions", {
      accountId: admin.accountId, conversationId, contactId,
      status: "collecting", origin: "inbound",
      fields: [], expectedCount: 0, answeredCount: 0,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
      // nextFollowUpAt deliberately unset
    });
  });
  const out = await admin.as.query(api.cronSchedules.overview, {});
  expect(out.followUps).toHaveLength(0);
});
