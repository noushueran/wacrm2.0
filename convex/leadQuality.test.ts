import { convexTest, type TestConvex } from "convex-test";
import { expect, test, describe, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import {
  nextQuestion,
  stageImplies,
  latestFor,
  NO_COOLDOWN_MS,
  DISMISS_COOLDOWN_MS,
  type AnswerRecord,
} from "./leadQuality";

const modules = import.meta.glob("/convex/**/*.ts");

const T0 = 1_700_000_000_000;

// ============================================================
// The pure state machine. No database, no clock — the whole decision
// table is exercised directly.
// ============================================================

describe("nextQuestion", () => {
  it("opens with the genuine question on a fresh attributed lead", () => {
    expect(
      nextQuestion({ answers: [], currentStage: null, now: T0 }),
    ).toBe("genuine");
    expect(
      nextQuestion({ answers: [], currentStage: "new_lead", now: T0 }),
    ).toBe("genuine");
  });

  it("walks genuine → intent → payment as each is answered yes", () => {
    const answers: AnswerRecord[] = [
      { step: "genuine", answer: "yes", at: T0 },
    ];
    expect(nextQuestion({ answers, currentStage: "qualified", now: T0 })).toBe(
      "intent",
    );

    answers.push({ step: "intent", answer: "yes", at: T0 });
    expect(
      nextQuestion({ answers, currentStage: "price_quoted", now: T0 }),
    ).toBe("payment");

    answers.push({ step: "payment", answer: "yes", at: T0 });
    expect(
      nextQuestion({ answers, currentStage: "purchased", now: T0 }),
    ).toBeNull();
  });

  it("retires permanently on genuine:no — a non-customer does not improve with time", () => {
    const answers: AnswerRecord[] = [{ step: "genuine", answer: "no", at: T0 }];
    expect(nextQuestion({ answers, currentStage: null, now: T0 })).toBeNull();
    // Still silent a year later. This is the bad-lead branch: logged, never
    // asked again, and nothing was sent to Meta.
    expect(
      nextQuestion({ answers, currentStage: null, now: T0 + 365 * 86_400_000 }),
    ).toBeNull();
  });

  it("re-asks intent and payment after the no-cooldown, but not before", () => {
    for (const step of ["intent", "payment"] as const) {
      const answers: AnswerRecord[] = [
        { step: "genuine", answer: "yes", at: T0 },
        ...(step === "payment"
          ? [{ step: "intent" as const, answer: "yes" as const, at: T0 }]
          : []),
        { step, answer: "no" as const, at: T0 },
      ];
      const stage = step === "payment" ? "price_quoted" : "qualified";
      expect(nextQuestion({ answers, currentStage: stage, now: T0 })).toBeNull();
      expect(
        nextQuestion({
          answers,
          currentStage: stage,
          now: T0 + NO_COOLDOWN_MS - 1,
        }),
      ).toBeNull();
      expect(
        nextQuestion({ answers, currentStage: stage, now: T0 + NO_COOLDOWN_MS }),
      ).toBe(step);
    }
  });

  it("re-asks a dismissed question after the shorter dismiss-cooldown", () => {
    const answers: AnswerRecord[] = [
      { step: "genuine", answer: "dismissed", at: T0 },
    ];
    expect(nextQuestion({ answers, currentStage: null, now: T0 })).toBeNull();
    expect(
      nextQuestion({
        answers,
        currentStage: null,
        now: T0 + DISMISS_COOLDOWN_MS - 1,
      }),
    ).toBeNull();
    expect(
      nextQuestion({
        answers,
        currentStage: null,
        now: T0 + DISMISS_COOLDOWN_MS,
      }),
    ).toBe("genuine");
    // A dismissal is a shorter snooze than a "no" — that ordering is the
    // point, so pin it rather than trusting two independent constants.
    expect(DISMISS_COOLDOWN_MS).toBeLessThan(NO_COOLDOWN_MS);
  });

  it("skips questions the CRM stage already implies", () => {
    // An agent moved this to price_quoted by hand. Asking "is this a real
    // customer?" would be insulting; only payment is still unknown.
    expect(
      nextQuestion({ answers: [], currentStage: "price_quoted", now: T0 }),
    ).toBe("payment");
    expect(
      nextQuestion({ answers: [], currentStage: "invoice_sent", now: T0 }),
    ).toBe("payment");
    expect(
      nextQuestion({ answers: [], currentStage: "purchased", now: T0 }),
    ).toBeNull();
  });

  it("treats `lost` as terminal, NOT as past every milestone", () => {
    // `lost` is appended last in FUNNEL_STAGES so the engine cannot pull a
    // lost deal forward; a naive index compare would read it as "past
    // purchased" and imply all three answers were yes. It must retire the
    // card instead.
    expect(
      nextQuestion({ answers: [], currentStage: "lost", now: T0 }),
    ).toBeNull();
    expect(stageImplies("lost", "genuine")).toBe(false);
    expect(stageImplies("lost", "payment")).toBe(false);
  });

  it("does not jump the funnel while an earlier step is snoozed", () => {
    // intent is snoozed; payment must NOT be asked in its place, or Meta
    // would get a Converted with no SQL before it.
    const answers: AnswerRecord[] = [
      { step: "genuine", answer: "yes", at: T0 },
      { step: "intent", answer: "no", at: T0 },
    ];
    expect(
      nextQuestion({ answers, currentStage: "qualified", now: T0 + 1000 }),
    ).toBeNull();
  });

  it("acts on the LATEST answer per step, the log being append-only", () => {
    const answers: AnswerRecord[] = [
      { step: "genuine", answer: "dismissed", at: T0 },
      { step: "genuine", answer: "yes", at: T0 + 5000 },
    ];
    expect(latestFor(answers, "genuine")?.answer).toBe("yes");
    expect(
      nextQuestion({ answers, currentStage: "qualified", now: T0 + 6000 }),
    ).toBe("intent");
  });
});

// ============================================================
// The mutation: which answers reach Meta, and which never can.
// ============================================================

async function seedMember(
  t: ReturnType<typeof convexTest>,
  role: AccountRole = "agent",
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Ann", email: "ann@example.com" }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "Acme",
      defaultCurrency: "AED",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role,
      fullName: "Ann",
      email: "ann@example.com",
    });
    return id;
  });
  return {
    userId,
    accountId,
    asUser: t.withIdentity({ subject: `${userId}|s` }),
  };
}

async function seedLead(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  assignedToUserId: Id<"users">,
  opts: { attributed?: boolean } = {},
) {
  const attributed = opts.attributed ?? true;
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+971585824488",
      phoneNormalized: "971585824488",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      assignedToUserId,
      ...(attributed
        ? {
            attribution: {
              lane: "ctwa" as const,
              ctwaClid: "clid-q",
              firstSeenAt: 1_000_000,
            },
          }
        : {}),
    });
    if (attributed) {
      await ctx.db.insert("conversionEvents", {
        accountId,
        conversationId,
        contactId,
        stage: "new_lead",
        lane: "ctwa",
        backend: "capi",
        eventName: "LeadSubmitted",
        identifier: "clid-q",
        phone: "971585824488",
        waMessageId: "wamid.1",
        firstMessageAt: 1_000_000,
        eventId: `${conversationId}:new_lead`,
        status: "pending",
        attempts: 0,
      });
    }
    return { contactId, conversationId };
  });
}

async function eventStages(
  t: TestConvex<typeof schema>,
  conversationId: Id<"conversations">,
) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("conversionEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  return rows.map((r) => r.stage).sort();
}

test("yes on each step seeds exactly one Meta event of the right stage", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  let res = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "genuine",
    answer: "yes",
  });
  expect(res.sentToMeta).toBe(true);
  expect(await eventStages(t, conversationId)).toEqual(["new_lead", "qualified"]);

  res = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "intent",
    answer: "yes",
  });
  expect(res.sentToMeta).toBe(true);

  res = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "payment",
    answer: "yes",
    value: 2499,
  });
  expect(res.sentToMeta).toBe(true);

  expect(await eventStages(t, conversationId)).toEqual([
    "new_lead",
    "price_quoted",
    "purchased",
    "qualified",
  ]);
  const purchase = await t.run((ctx) =>
    ctx.db
      .query("conversionEvents")
      .withIndex("by_event_id", (q) =>
        q.eq("eventId", `${conversationId}:purchased`),
      )
      .first(),
  );
  expect(purchase?.eventName).toBe("Purchase");
  expect(purchase?.value).toBe(2499);
  expect(purchase?.currency).toBe("AED"); // account default backfills
});

test("a bad lead is RECORDED but never reaches Meta", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  const res = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "genuine",
    answer: "no",
    reason: "supplier_vendor",
  });
  expect(res.sentToMeta).toBe(false);

  // Only the automatic first-touch event exists. No qualified row.
  expect(await eventStages(t, conversationId)).toEqual(["new_lead"]);

  // But the verdict IS captured — that is the feedback loop.
  const rows = await t.run((ctx) =>
    ctx.db
      .query("leadQualityAnswers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].answer).toBe("no");
  expect(rows[0].reason).toBe("supplier_vendor");
  expect(rows[0].conversionEventId).toBeUndefined();

  // And the CRM stage is untouched — a junk lead was never a deal.
  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.funnel).toBeUndefined();

  // The card stops asking.
  const state = await asUser.query(api.leadQuality.getCardState, {
    conversationId,
  });
  expect(state.step).toBeNull();
});

test("dismissing records the dodge, sends nothing, and asks again tomorrow", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  const res = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "genuine",
    answer: "dismissed",
  });
  expect(res.sentToMeta).toBe(false);
  expect(await eventStages(t, conversationId)).toEqual(["new_lead"]);
  const state = await asUser.query(api.leadQuality.getCardState, {
    conversationId,
  });
  expect(state.step).toBeNull(); // snoozed right now
});

test("re-answering yes does not double-send", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  for (let i = 0; i < 3; i++) {
    await asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step: "genuine",
      answer: "yes",
    });
  }
  expect(await eventStages(t, conversationId)).toEqual(["new_lead", "qualified"]);
  // Three answers logged (append-only trail), one event.
  const rows = await t.run((ctx) =>
    ctx.db
      .query("leadQualityAnswers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(rows).toHaveLength(3);
});

test("payment yes without an amount is refused", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step: "payment",
      answer: "yes",
    }),
  ).rejects.toThrow();
  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step: "payment",
      answer: "yes",
      value: 0,
    }),
  ).rejects.toThrow();
  expect(await eventStages(t, conversationId)).toEqual(["new_lead"]);
});

test("payment bypasses the sales-checklist gate that blocks setStage", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId, contactId } = await seedLead(t, accountId, userId);

  // An INCOMPLETE checklist — exactly what makes `funnel.setStage` throw
  // `checklist_incomplete`. The card must still record the sale.
  await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("qualificationSessions", {
      accountId,
      conversationId,
      contactId,
      status: "qualified",
      origin: "inbound",
      fields: [],
      expectedCount: 0,
      answeredCount: 0,
      followUpsSent: 0,
      phrasingCursor: 0,
      sendAttemptErrors: 0,
    });
    await ctx.db.insert("salesChecklists", {
      accountId,
      sessionId,
      conversationId,
      contactId,
      source: "default",
      items: [{ key: "docs", title: "Documents", done: false }],
      generatedAt: Date.now(),
    });
  });

  await expect(
    asUser.mutation(api.funnel.setStage, {
      conversationId,
      stage: "purchased",
      saleValue: 1000,
    }),
  ).rejects.toThrow(); // the gate the card is designed to skip

  const res = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "payment",
    answer: "yes",
    value: 1000,
  });
  expect(res.sentToMeta).toBe(true);
});

test("an organic chat logs feedback but can never seed an event, and shows no card", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId, {
    attributed: false,
  });

  const state = await asUser.query(api.leadQuality.getCardState, {
    conversationId,
  });
  expect(state.attributed).toBe(false);
  expect(state.step).toBeNull();

  const res = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "genuine",
    answer: "yes",
  });
  expect(res.sentToMeta).toBe(false);
  expect(await eventStages(t, conversationId)).toEqual([]);
});

test("viewers cannot answer; supervisors can act on someone else's thread", async () => {
  const t = convexTest(schema, modules);
  const viewer = await seedMember(t, "viewer");
  const { conversationId } = await seedLead(t, viewer.accountId, viewer.userId);
  await expect(
    viewer.asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step: "genuine",
      answer: "yes",
    }),
  ).rejects.toThrow();

  const sup = await seedMember(t, "supervisor");
  const other = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Bob", email: "bob@example.com" }),
  );
  const lead = await seedLead(t, sup.accountId, other);
  const res = await sup.asUser.mutation(api.leadQuality.answer, {
    conversationId: lead.conversationId,
    step: "genuine",
    answer: "yes",
  });
  expect(res.sentToMeta).toBe(true);
});
