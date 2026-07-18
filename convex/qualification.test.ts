import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

const modules = import.meta.glob("/convex/**/*.ts");

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

test("schema accepts qualificationConfigs, qualificationSessions and lead_qualified notifications", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "U", email: "u@example.com" });
    const accountId = await ctx.db.insert("accounts", {
      name: "A", defaultCurrency: "AED", ownerUserId: userId,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000001", phoneNormalized: "971500000001",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    const configId = await ctx.db.insert("qualificationConfigs", {
      accountId, enabled: false,
      basicFields: [{ key: "destination", label: "Destination", required: true, phrasings: ["Where would you like to go?"] }],
      qualifyThresholdScore: 60,
      timezoneLabel: "Asia/Dubai", utcOffsetMinutes: 240,
      workStartMinute: 600, workEndMinute: 1260, workDays: [1, 2, 3, 4, 5, 6],
      followUpDelaysMinutes: [60, 180, 720, 1440], maxFollowUps: 4, sessionWindowHours: 72,
      closingMessage: "Thank you! Our travel expert will contact you shortly.",
      adminAlertEnabled: false, adminAlertPhones: [], outboundNudgesEnabled: false,
    });
    await ctx.db.insert("memberTags", {
      accountId, userId,
      tagId: await ctx.db.insert("tags", { accountId, name: "UAE visa", color: "#0ea5e9" }),
    });
    await ctx.db.insert("staffCheckins", {
      accountId, phoneNormalized: "971551234567", lastCheckinSentAt: 1,
    });
    const sessionId = await ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId,
      status: "collecting", origin: "inbound",
      fields: [], expectedCount: 0, answeredCount: 0,
      checklistSatisfiedAt: 123,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    });
    await ctx.db.insert("leadOffers", {
      accountId, sessionId, conversationId, contactId,
      agentUserId: userId, agentPhone: "+971551234567",
      status: "offered", offeredAt: 1,
    });
    await ctx.db.insert("notifications", {
      accountId, userId, type: "lead_qualified", title: "New qualified lead",
    });
    await ctx.db.insert("aiUsageLog", {
      accountId, mode: "qualify", provider: "openai", model: "gpt-test",
      promptTokens: 1, completionTokens: 1, totalTokens: 2,
    });
    expect(configId).toBeDefined();
    const bySession = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .unique();
    expect(bySession?._id).toBe(sessionId);
  });
});

test("getConfig returns seeded defaults when no row exists, and the row after updateConfig", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  const before = await admin.as.query(api.qualification.getConfig, {});
  expect(before.isPersisted).toBe(false);
  expect(before.enabled).toBe(false);
  expect(before.workStartMinute).toBe(600);

  await admin.as.mutation(api.qualification.updateConfig, { patch: { enabled: true } });
  const after = await admin.as.query(api.qualification.getConfig, {});
  expect(after.isPersisted).toBe(true);
  expect(after.enabled).toBe(true);
  expect(after.basicFields.length).toBe(4); // defaults seeded alongside the patch
});

test("updateConfig rejects invalid values and non-admin callers", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await expect(
    admin.as.mutation(api.qualification.updateConfig, {
      patch: { qualifyThresholdScore: 150 },
    }),
  ).rejects.toThrow();
  await expect(
    admin.as.mutation(api.qualification.updateConfig, {
      patch: { workStartMinute: 1300, workEndMinute: 600 },
    }),
  ).rejects.toThrow();

  const supervisor = await seedMember(t, "supervisor");
  await expect(
    supervisor.as.mutation(api.qualification.updateConfig, { patch: { enabled: true } }),
  ).rejects.toThrow(); // FORBIDDEN — admin-gated (spec §12)
});

test("getSessionForConversation returns progress for accessible conversations, null without a session, NOT_FOUND out of scope", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  const { contactId, conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId: admin.accountId, phone: "+971500000009", phoneNormalized: "971500000009",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId: admin.accountId, contactId, status: "open", unreadCount: 0,
    });
    return { contactId, conversationId };
  });

  // no session yet → null
  expect(
    await admin.as.query(api.qualification.getSessionForConversation, { conversationId }),
  ).toBeNull();

  await t.run(async (ctx) => {
    await ctx.db.insert("qualificationSessions", {
      accountId: admin.accountId, conversationId, contactId,
      status: "collecting", origin: "inbound",
      fields: [{ key: "destination", label: "Destination", value: "Bali", confidence: "high", updatedAt: 1 }],
      expectedCount: 4, answeredCount: 1, score: 40,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    });
  });
  const progress = await admin.as.query(api.qualification.getSessionForConversation, { conversationId });
  expect(progress).toMatchObject({
    status: "collecting", answeredCount: 1, expectedCount: 4, score: 40, ready: false,
  });
  expect(progress?.missingHint).toBeTruthy();

  // an agent teammate must NOT see a colleague-assigned conversation's session
  const agentUserId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", { name: "Ag", email: "ag@example.com" });
    await ctx.db.insert("memberships", {
      userId: uid, accountId: admin.accountId, role: "agent", fullName: "Ag", email: "ag@example.com",
    });
    await ctx.db.patch(conversationId, { assignedToUserId: admin.userId });
    return uid;
  });
  const asAgent = t.withIdentity({ subject: `${agentUserId}|s2` });
  await expect(
    asAgent.query(api.qualification.getSessionForConversation, { conversationId }),
  ).rejects.toThrow();
});

test("leadsBoard: supervisor+ gets summary + score-sorted leads; agents are denied", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await t.run(async (ctx) => {
    const mk = async (phone: string, status: "collecting" | "qualified", score: number) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId: admin.accountId, phone, phoneNormalized: phone.replace(/\D/g, ""), name: `C${score}`,
      });
      const conversationId = await ctx.db.insert("conversations", {
        accountId: admin.accountId, contactId, status: "open", unreadCount: 0,
      });
      await ctx.db.insert("qualificationSessions", {
        accountId: admin.accountId, conversationId, contactId,
        status, origin: "inbound",
        fields: [{ key: "destination", label: "Destination", value: "Bali", confidence: "high", updatedAt: 1 }],
        expectedCount: 4, answeredCount: 1, score, serviceName: "Packages",
        followUpsSent: 1, phrasingCursor: 1, sendAttemptErrors: 0,
        ...(status === "qualified" ? { qualifiedAt: 5 } : {}),
      });
    };
    await mk("+971500000010", "qualified", 60);
    await mk("+971500000011", "qualified", 90);
    await mk("+971500000012", "collecting", 40);
  });

  const board = await admin.as.query(api.qualification.leadsBoard, {});
  expect(board.summary.qualified).toBe(2);
  expect(board.summary.collecting).toBe(1);
  const qualifiedScores = board.leads
    .filter((l) => l.status === "qualified")
    .map((l) => l.score);
  expect(qualifiedScores).toEqual([90, 60]); // highest first — the sales queue
  expect(board.leads[0].contactName).toBe("C90");
  expect(board.leads[0].fields[0].value).toBe("Bali");

  // v4: agents are ALLOWED but see only their own assigned leads —
  // this agent has none, so the board is empty (viewers still rejected).
  const agent = await seedMember(t, "agent");
  const agentBoard = await agent.as.query(api.qualification.leadsBoard, {});
  expect(agentBoard.leads).toHaveLength(0);
  const viewer = await seedMember(t, "viewer");
  await expect(viewer.as.query(api.qualification.leadsBoard, {})).rejects.toThrow();
});

test("V4 RBAC: agents see ONLY their own assigned leads; supervisors see all with assignee", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  const agentUserId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", { name: "Agent A", email: "aa@example.com" });
    await ctx.db.insert("memberships", {
      userId: uid, accountId: admin.accountId, role: "agent", fullName: "Agent A", email: "aa@example.com",
    });
    return uid;
  });
  const mk = async (phone: string, assigned: boolean) =>
    t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId: admin.accountId, phone, phoneNormalized: phone.replace(/\D/g, ""),
      });
      const conversationId = await ctx.db.insert("conversations", {
        accountId: admin.accountId, contactId, status: "open", unreadCount: 0,
        ...(assigned ? { assignedToUserId: agentUserId } : {}),
      });
      await ctx.db.insert("qualificationSessions", {
        accountId: admin.accountId, conversationId, contactId,
        status: "qualified", origin: "inbound", serviceName: "UAE visa",
        fields: [], expectedCount: 4, answeredCount: 4, score: 70, qualifiedAt: 1,
        followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
      });
    });
  await mk("+971500000021", true);   // agent's own
  await mk("+971500000022", false);  // unassigned

  const asAgent = t.withIdentity({ subject: `${agentUserId}|s3` });
  const agentBoard = await asAgent.query(api.qualification.leadsBoard, {});
  expect(agentBoard.leads).toHaveLength(1);
  expect(agentBoard.summary.qualified).toBe(1);

  const adminBoard = await admin.as.query(api.qualification.leadsBoard, {});
  expect(adminBoard.leads).toHaveLength(2);
  expect(adminBoard.leads.some((l) => l.assigneeName === "Agent A")).toBe(true);
});

test("P6: memberTags.setForTag replaces routing links, admin-gated", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  const { tagId, u1, u2 } = await t.run(async (ctx) => {
    const tagId = await ctx.db.insert("tags", {
      accountId: admin.accountId, name: "UAE visa", color: "#0ea5e9",
    });
    const mk = async (name: string) => {
      const uid = await ctx.db.insert("users", { name, email: `${name}@example.com` });
      await ctx.db.insert("memberships", {
        userId: uid, accountId: admin.accountId, role: "agent", fullName: name, email: `${name}@example.com`,
      });
      return uid;
    };
    return { tagId, u1: await mk("R1"), u2: await mk("R2") };
  });
  await admin.as.mutation(api.memberTags.setForTag, { tagId, userIds: [u1, u2] });
  let links = await admin.as.query(api.memberTags.list, {});
  expect(links).toHaveLength(2);
  await admin.as.mutation(api.memberTags.setForTag, { tagId, userIds: [u2] });
  links = await admin.as.query(api.memberTags.list, {});
  expect(links).toHaveLength(1);
  expect(links[0].userId).toBe(u2);

  const agent = await seedMember(t, "agent");
  await expect(
    agent.as.mutation(api.memberTags.setForTag, { tagId, userIds: [] }),
  ).rejects.toThrow();
});
