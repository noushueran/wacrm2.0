import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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

test("leadsBoard never leaks a member's email as their assignee name (no fullName falls back to 'Member', not the email)", async () => {
  // `members.list` nulls `email` below admin (staff PII); the leads board,
  // served to agents/supervisors, must not smuggle it back in as the
  // assignee label.
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  const agentUserId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", {
      name: "NoName",
      email: "secret@example.com",
    });
    // Membership deliberately has NO fullName — only an email.
    await ctx.db.insert("memberships", {
      userId: uid,
      accountId: admin.accountId,
      role: "agent",
      email: "secret@example.com",
    });
    return uid;
  });
  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId: admin.accountId,
      phone: "+971500000099",
      phoneNormalized: "971500000099",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId: admin.accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      assignedToUserId: agentUserId,
    });
    await ctx.db.insert("qualificationSessions", {
      accountId: admin.accountId,
      conversationId,
      contactId,
      status: "qualified",
      origin: "inbound",
      serviceName: "UAE visa",
      fields: [],
      expectedCount: 4,
      answeredCount: 4,
      score: 70,
      qualifiedAt: 1,
      followUpsSent: 0,
      phrasingCursor: 0,
      sendAttemptErrors: 0,
    });
  });

  const board = await admin.as.query(api.qualification.leadsBoard, {});
  const assigned = board.leads.find((l) => l.assigneeName !== null);
  expect(assigned?.assigneeName).toBe("Member");
  expect(
    board.leads.every((l) => l.assigneeName !== "secret@example.com"),
  ).toBe(true);
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

test("leadsBoard carries funnel stage + checklist payload per lead (null when absent)", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  const { withId, withoutId } = await t.run(async (ctx) => {
    const mk = async (phone: string) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId: admin.accountId, phone, phoneNormalized: phone.replace(/\D/g, ""), name: `N${phone.slice(-2)}`,
      });
      const conversationId = await ctx.db.insert("conversations", {
        accountId: admin.accountId, contactId, status: "open", unreadCount: 0,
      });
      const sessionId = await ctx.db.insert("qualificationSessions", {
        accountId: admin.accountId, conversationId, contactId, status: "qualified", origin: "inbound",
        fields: [], expectedCount: 4, answeredCount: 4, score: 80, qualifiedAt: 5,
        followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0, serviceName: "Packages",
      });
      return { contactId, conversationId, sessionId };
    };
    const a = await mk("+971500000021");
    await ctx.db.patch(a.conversationId, {
      funnel: { stage: "price_quoted", stageUpdatedAt: 7, saleValue: 1234, saleCurrency: "AED" },
    });
    await ctx.db.insert("salesChecklists", {
      accountId: admin.accountId, sessionId: a.sessionId, conversationId: a.conversationId,
      contactId: a.contactId, source: "default",
      items: [
        { key: "call", title: "Call the lead", done: true, doneAt: 9, doneByUserId: admin.userId, note: "Spoke, wants March" },
        { key: "pitch", title: "Give a proper pitch", description: "Right package", done: false },
      ],
      generatedAt: 1,
    });
    const b = await mk("+971500000022");
    return { withId: a.sessionId, withoutId: b.sessionId };
  });

  const board = await admin.as.query(api.qualification.leadsBoard, {});
  const withChecklist = board.leads.find((l) => l.sessionId === withId)!;
  expect(withChecklist.funnelStage).toBe("price_quoted");
  expect(withChecklist.saleValue).toBe(1234);
  expect(withChecklist.saleCurrency).toBe("AED");
  expect(withChecklist.checklist).not.toBeNull();
  expect(withChecklist.checklist!.doneCount).toBe(1);
  expect(withChecklist.checklist!.total).toBe(2);
  expect(withChecklist.checklist!.source).toBe("default");
  expect(withChecklist.checklist!.outcome).toBeNull();
  expect(withChecklist.checklist!.items[0]).toMatchObject({
    key: "call", done: true, doneByName: "admin", note: "Spoke, wants March",
  });
  expect(withChecklist.checklist!.items[1]).toMatchObject({
    key: "pitch", done: false, description: "Right package", doneByName: null, note: null,
  });

  const bare = board.leads.find((l) => l.sessionId === withoutId)!;
  expect(bare.funnelStage).toBeNull();
  expect(bare.checklist).toBeNull();
});

test("updateConfig contactCard: valid card persists (and round-trips via getConfig); bad phone/email/unknown field rejected", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await admin.as.mutation(api.qualification.updateConfig, {
    patch: {
      contactCard: {
        companyName: "Amani Tours LLC",
        website: "https://amaniworld.com",
        email: "hello@amaniworld.com",
        phone: "+971 4 000 0000",
        city: "Dubai",
        countryCode: "AE",
      },
    },
  });
  const after = await admin.as.query(api.qualification.getConfig, {});
  expect(after.contactCard).toMatchObject({
    companyName: "Amani Tours LLC",
    website: "https://amaniworld.com",
    email: "hello@amaniworld.com",
    phone: "+971 4 000 0000",
    city: "Dubai",
    countryCode: "AE",
  });

  await expect(
    admin.as.mutation(api.qualification.updateConfig, {
      patch: { contactCard: { phone: "not-a-phone" } },
    }),
  ).rejects.toThrow();
  await expect(
    admin.as.mutation(api.qualification.updateConfig, {
      patch: { contactCard: { email: "not-an-email" } },
    }),
  ).rejects.toThrow();
  await expect(
    admin.as.mutation(api.qualification.updateConfig, {
      patch: { contactCard: { logoUrl: "https://x.example/logo.png" } },
    }),
  ).rejects.toThrow(); // unknown field — whitelist, not silently dropped
});

test("updateConfig round-trips purchaseSignalsEnabled and rejects non-boolean", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  const before = await admin.as.query(api.qualification.getConfig, {});
  expect(before.purchaseSignalsEnabled ?? false).toBe(false); // ships dormant

  await admin.as.mutation(api.qualification.updateConfig, {
    patch: { purchaseSignalsEnabled: true },
  });
  const after = await admin.as.query(api.qualification.getConfig, {});
  expect(after.purchaseSignalsEnabled).toBe(true);

  await expect(
    admin.as.mutation(api.qualification.updateConfig, {
      patch: { purchaseSignalsEnabled: "yes" },
    }),
  ).rejects.toThrow(); // BAD_REQUEST — boolean only
});

test("updateConfig round-trips chasingAfterDays and rejects out-of-range values", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  const before = await admin.as.query(api.qualification.getConfig, {});
  // Absent = "exactly where the qualification engine gives up"
  // (`sessionWindowHours / 24`); the Inbox's lane cutoff derives it, so
  // there is nothing to seed (spec 2026-07-27-inbox-lanes §Data model).
  expect(before.chasingAfterDays).toBeUndefined();

  await admin.as.mutation(api.qualification.updateConfig, {
    patch: { chasingAfterDays: 7 },
  });
  const after = await admin.as.query(api.qualification.getConfig, {});
  // Was silently stripped before this fix: the key was missing from
  // CONFIG_PATCH_KEYS, so the spec's "set it explicitly" was only
  // reachable by a direct database write.
  expect(after.chasingAfterDays).toBe(7);

  for (const bad of [0, -1, 91, "7"]) {
    await expect(
      admin.as.mutation(api.qualification.updateConfig, {
        patch: { chasingAfterDays: bad },
      }),
    ).rejects.toThrow(); // BAD_REQUEST — 1–90, number only
  }
  // The rejected patches left the stored value alone.
  expect((await admin.as.query(api.qualification.getConfig, {})).chasingAfterDays)
    .toBe(7);
});

// ── leadsBoard: server-side filtering + paging ──────────────────────
// /leads used to receive its whole (capped) list and filter/render it in
// the browser. Both moved here. What these cover is the part that breaks
// quietly: filters must span the WHOLE board rather than the returned
// page, `summary` must stay whole-board because it labels the filter
// pills themselves, and callers that pass no paging args (the Pipeline
// kanban, the dashboard card) must still get everything.

/** Seed `n` qualified sessions with descending scores under one account. */
async function seedLeadsBoardRows(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  rows: { score: number; status?: "collecting" | "qualified" | "expired"; service?: string; name?: string }[],
) {
  await t.run(async (ctx) => {
    for (const [i, row] of rows.entries()) {
      const phone = `+9715000${String(i).padStart(5, "0")}`;
      const contactId = await ctx.db.insert("contacts", {
        accountId, phone, phoneNormalized: phone.replace(/\D/g, ""),
        name: row.name ?? `C${row.score}`,
      });
      const conversationId = await ctx.db.insert("conversations", {
        accountId, contactId, status: "open" as const, unreadCount: 0,
      });
      const status = row.status ?? "qualified";
      await ctx.db.insert("qualificationSessions", {
        accountId, conversationId, contactId,
        status, origin: "inbound",
        fields: [], expectedCount: 4, answeredCount: 1,
        score: row.score, serviceName: row.service ?? "Packages",
        followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
        ...(status === "qualified" ? { qualifiedAt: 5 } : {}),
      });
    }
  });
}

test("leadsBoard returns one page and reports the filtered total", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await seedLeadsBoardRows(t, admin.accountId, [
    { score: 90 }, { score: 80 }, { score: 70 }, { score: 60 }, { score: 50 },
  ]);

  const first = await admin.as.query(api.qualification.leadsBoard, { page: 0, pageSize: 2 });

  expect(first.leads.map((l) => l.score)).toEqual([90, 80]);
  expect(first.total).toBe(5);
  expect(first.pageCount).toBe(3);
});

test("leadsBoard returns everything when pageSize is omitted", async () => {
  // The Pipeline kanban groups EVERY lead by stage and still calls this
  // with `{}`. The pipeline CARD used to as well, and no longer does —
  // `pipelineSummary` returns it the dozen numbers it actually renders,
  // instead of 459 hydrated leads and ~2.4 MB.
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await seedLeadsBoardRows(t, admin.accountId, [{ score: 90 }, { score: 80 }, { score: 70 }]);

  const board = await admin.as.query(api.qualification.leadsBoard, {});

  expect(board.leads).toHaveLength(3);
  expect(board.pageCount).toBe(1);
});

test("leadsBoard clamps a page past the end onto the last page", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await seedLeadsBoardRows(t, admin.accountId, [{ score: 90 }, { score: 80 }, { score: 70 }]);

  const board = await admin.as.query(api.qualification.leadsBoard, { page: 99, pageSize: 2 });

  expect(board.page).toBe(1);
  expect(board.leads.map((l) => l.score)).toEqual([70]);
});

test("leadsBoard filters by status across the whole board, not just the page", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  // `collecting` sorts after every `qualified` row, so it falls off page
  // 1 — a client-side filter over one page could never have found it.
  await seedLeadsBoardRows(t, admin.accountId, [
    { score: 90 }, { score: 80 }, { score: 40, status: "collecting" },
  ]);

  const board = await admin.as.query(api.qualification.leadsBoard, {
    status: "collecting", page: 0, pageSize: 2,
  });

  expect(board.leads.map((l) => l.score)).toEqual([40]);
  expect(board.total).toBe(1);
});

test("leadsBoard groups the terminal statuses behind the Closed filter", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await seedLeadsBoardRows(t, admin.accountId, [
    { score: 90 }, { score: 20, status: "expired" },
  ]);

  const board = await admin.as.query(api.qualification.leadsBoard, { status: "closed" });

  expect(board.leads.map((l) => l.status)).toEqual(["expired"]);
});

test("leadsBoard filters by service and lists every service on the whole board", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await seedLeadsBoardRows(t, admin.accountId, [
    { score: 90, service: "Visa" }, { score: 80, service: "Packages" },
  ]);

  const board = await admin.as.query(api.qualification.leadsBoard, {
    service: "Visa", page: 0, pageSize: 1,
  });

  expect(board.leads.map((l) => l.serviceName)).toEqual(["Visa"]);
  // The dropdown's options come from here now. Derived from the returned
  // page instead, it would offer only "Visa" — the option you already
  // picked — and the others would vanish as you paged.
  expect(board.services).toEqual(["Packages", "Visa"]);
});

test("leadsBoard searches contact name server-side", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await seedLeadsBoardRows(t, admin.accountId, [
    { score: 90, name: "Priya" }, { score: 80, name: "Rahul" },
  ]);

  const board = await admin.as.query(api.qualification.leadsBoard, { search: "rahul" });

  expect(board.leads.map((l) => l.contactName)).toEqual(["Rahul"]);
});

test("leadsBoard keeps the summary whole-board while the list is filtered", async () => {
  // summary.* are the filter pills' own counts — deriving them from the
  // filtered set would make each pill report its own selection.
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await seedLeadsBoardRows(t, admin.accountId, [
    { score: 90 }, { score: 40, status: "collecting" },
  ]);

  const board = await admin.as.query(api.qualification.leadsBoard, { status: "qualified" });

  expect(board.leads).toHaveLength(1);
  expect(board.total).toBe(1);
  expect(board.summary.qualified).toBe(1);
  expect(board.summary.collecting).toBe(1);
  expect(board.summary.total).toBe(2);
});

// ============================================================
// pipelineSummary — the cheap aggregate behind the pipeline card.
//
// It exists because that card used to render from `leadsBoard({})`, which
// measured in production at 1,668 document reads and a ~2.4 MB payload to
// produce the dozen numbers asserted below. These tests pin the numbers,
// not the cost; the cost is guarded by the shape of the handler (one
// status range, one parallel wave of conversation lookups, no offers or
// checklist reads at all).
// ============================================================

/** One qualified deal: contact → conversation (optionally staged, with a
 *  recorded sale) → qualification session. Returns the conversation id so a
 *  test can hang a SECOND session off the same thread and check the
 *  one-card-per-conversation collapse. */
async function seedDeal(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: {
    phone: string;
    stage?:
      | "new_lead"
      | "qualified"
      | "price_quoted"
      | "itinerary_created"
      | "itinerary_sent"
      | "invoice_sent"
      | "purchased"
      | "lost";
    saleValue?: number;
    saleCurrency?: string;
    status?: "collecting" | "qualified";
    assignedToUserId?: Id<"users">;
    conversationId?: Id<"conversations">;
  },
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: opts.phone,
      phoneNormalized: opts.phone.replace(/\D/g, ""),
    });
    const conversationId =
      opts.conversationId ??
      (await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open" as const,
        unreadCount: 0,
        ...(opts.assignedToUserId
          ? { assignedToUserId: opts.assignedToUserId }
          : {}),
        ...(opts.stage
          ? {
              funnel: {
                stage: opts.stage,
                stageUpdatedAt: 1,
                ...(opts.saleValue !== undefined
                  ? { saleValue: opts.saleValue }
                  : {}),
                ...(opts.saleCurrency ? { saleCurrency: opts.saleCurrency } : {}),
              },
            }
          : {}),
      }));
    const status = opts.status ?? "qualified";
    await ctx.db.insert("qualificationSessions", {
      accountId,
      conversationId,
      contactId,
      status,
      origin: "inbound",
      fields: [],
      expectedCount: 4,
      answeredCount: 4,
      score: 80,
      followUpsSent: 0,
      phrasingCursor: 0,
      sendAttemptErrors: 0,
      ...(status === "qualified" ? { qualifiedAt: 5 } : {}),
    });
    return conversationId;
  });
}

test("pipelineSummary counts deals by their CURRENT funnel stage", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await seedDeal(t, admin.accountId, { phone: "+971500001001", stage: "price_quoted" });
  await seedDeal(t, admin.accountId, { phone: "+971500001002", stage: "price_quoted" });
  await seedDeal(t, admin.accountId, { phone: "+971500001003", stage: "itinerary_sent" });
  // No funnel stage yet, and one still parked at the pre-deal `new_lead`:
  // both belong in the first column, not off-board.
  await seedDeal(t, admin.accountId, { phone: "+971500001004" });
  await seedDeal(t, admin.accountId, { phone: "+971500001005", stage: "new_lead" });

  const res = await admin.as.query(api.qualification.pipelineSummary, {});

  const byStage = Object.fromEntries(res.stages.map((s) => [s.key, s.count]));
  expect(byStage.qualified).toBe(2);
  expect(byStage.price_quoted).toBe(2);
  expect(byStage.itinerary_sent).toBe(1);
  expect(res.total).toBe(5);
  expect(res.capped).toBe(false);
});

test("pipelineSummary counts one deal per conversation, not per session", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  // A re-qualified conversation: two qualified sessions, one thread. The
  // stage lives on the CONVERSATION, so both sessions would otherwise be
  // counted in the same column and move together — two cards for one deal.
  const conversationId = await seedDeal(t, admin.accountId, {
    phone: "+971500002001",
    stage: "invoice_sent",
  });
  await seedDeal(t, admin.accountId, {
    phone: "+971500002002",
    conversationId,
  });

  const res = await admin.as.query(api.qualification.pipelineSummary, {});

  expect(res.total).toBe(1);
  const byStage = Object.fromEntries(res.stages.map((s) => [s.key, s.count]));
  expect(byStage.invoice_sent).toBe(1);
});

test("pipelineSummary reports win rate, won value per currency, and leads still qualifying", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await seedDeal(t, admin.accountId, {
    phone: "+971500003001", stage: "purchased", saleValue: 1_200, saleCurrency: "AED",
  });
  await seedDeal(t, admin.accountId, {
    phone: "+971500003002", stage: "purchased", saleValue: 800, saleCurrency: "AED",
  });
  await seedDeal(t, admin.accountId, {
    phone: "+971500003003", stage: "purchased", saleValue: 500, saleCurrency: "USD",
  });
  await seedDeal(t, admin.accountId, { phone: "+971500003004", stage: "lost" });
  // Not a deal — it is still being qualified, so it must not enter the win
  // rate, but it is what `inQualification` reports.
  await seedDeal(t, admin.accountId, { phone: "+971500003005", status: "collecting" });

  const res = await admin.as.query(api.qualification.pipelineSummary, {});

  expect(res.winRate).toBe(75); // 3 purchased of 4 closed
  expect(
    [...res.wonByCurrency].sort((a, b) => a.currency.localeCompare(b.currency)),
  ).toEqual([
    { currency: "AED", value: 2_000 },
    { currency: "USD", value: 500 },
  ]);
  expect(res.inQualification).toBe(1);
  expect(res.total).toBe(4); // the collecting lead is not on the pipeline
});

test("pipelineSummary reports a null win rate when nothing has closed", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await seedDeal(t, admin.accountId, { phone: "+971500004001", stage: "price_quoted" });

  const res = await admin.as.query(api.qualification.pipelineSummary, {});

  // `null`, not 0 — "nothing has closed yet" is a different claim from
  // "nothing that closed was won", and 0% would read as the latter.
  expect(res.winRate).toBeNull();
});

test("pipelineSummary: agents see only their own deals; viewers are denied", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  const agent = await seedMember(t, "agent");
  const agentUserId = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", { name: "Agent P", email: "ap@example.com" });
    await ctx.db.insert("memberships", {
      userId: uid, accountId: admin.accountId, role: "agent",
      fullName: "Agent P", email: "ap@example.com",
    });
    return uid;
  });
  const asAgent = t.withIdentity({ subject: `${agentUserId}|sp` });

  await seedDeal(t, admin.accountId, {
    phone: "+971500005001", stage: "price_quoted", assignedToUserId: agentUserId,
  });
  await seedDeal(t, admin.accountId, { phone: "+971500005002", stage: "price_quoted" });

  // Same floor as `leadsBoard`: supervisor+ see everything…
  expect((await admin.as.query(api.qualification.pipelineSummary, {})).total).toBe(2);
  // …an agent only their own…
  expect((await asAgent.query(api.qualification.pipelineSummary, {})).total).toBe(1);
  // …an unrelated agent on their OWN account sees nothing of this one…
  expect((await agent.as.query(api.qualification.pipelineSummary, {})).total).toBe(0);
  // …and a viewer has no lead queue at all.
  const viewer = await seedMember(t, "viewer");
  await expect(
    viewer.as.query(api.qualification.pipelineSummary, {}),
  ).rejects.toThrow();
});
