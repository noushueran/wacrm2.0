import { convexTest, type TestConvex } from "convex-test";
import { expect, test, describe, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import {
  stepStates,
  stageImplies,
  latestFor,
  type AnswerRecord,
} from "./leadQuality";

const modules = import.meta.glob("/convex/**/*.ts");

const T0 = 1_700_000_000_000;

// ============================================================
// The pure state machine. No database, no clock — the whole decision
// table is exercised directly.
// ============================================================

/** Convenience: the map of step -> locked/answer for assertions. */
function statesOf(
  answers: AnswerRecord[],
  currentStage: Parameters<typeof stepStates>[0]["currentStage"] = null,
) {
  return Object.fromEntries(
    stepStates({ answers, currentStage }).map((s) => [
      s.step,
      { locked: s.locked, answer: s.answer, viaStage: s.viaStage },
    ]),
  );
}

describe("stepStates", () => {
  it("opens with all three questions unanswered", () => {
    const st = statesOf([]);
    for (const step of ["genuine", "intent", "payment"] as const) {
      expect(st[step]).toEqual({ locked: false, answer: null, viaStage: false });
    }
  });

  it("locks each step INDEPENDENTLY — answering one never gates another", () => {
    // The whole point of the redesign: a salesperson who learns "serious"
    // and "paid" in one conversation can record both, and skipping the
    // middle question does not block the one that matters most.
    const st = statesOf([
      { step: "payment", answer: "yes", at: T0, value: 2500, currency: "AED" },
    ]);
    expect(st.payment.locked).toBe(true);
    expect(st.genuine.locked).toBe(false);
    expect(st.intent.locked).toBe(false);
  });

  it("carries the recorded amount through for display", () => {
    const [, , payment] = stepStates({
      answers: [
        { step: "payment", answer: "yes", at: T0, value: 2500, currency: "AED" },
      ],
      currentStage: null,
    });
    expect(payment).toMatchObject({ value: 2500, currency: "AED", answer: "yes" });
  });

  it("locks a `no` too — an answer is an answer", () => {
    const st = statesOf([{ step: "genuine", answer: "no", at: T0 }]);
    expect(st.genuine).toEqual({ locked: true, answer: "no", viaStage: false });
  });

  it("does NOT lock on a dismissal", () => {
    const st = statesOf([{ step: "genuine", answer: "dismissed", at: T0 }]);
    expect(st.genuine.locked).toBe(false);
  });

  it("acts on the LATEST answer per step, the log being append-only", () => {
    const answers: AnswerRecord[] = [
      { step: "genuine", answer: "dismissed", at: T0 },
      { step: "genuine", answer: "yes", at: T0 + 5000 },
    ];
    expect(latestFor(answers, "genuine")?.answer).toBe("yes");
    expect(statesOf(answers).genuine).toEqual({
      locked: true,
      answer: "yes",
      viaStage: false,
    });
  });

  it("treats a CRM stage past a milestone as an implied yes, marked as such", () => {
    const st = statesOf([], "price_quoted");
    expect(st.genuine).toEqual({ locked: true, answer: "yes", viaStage: true });
    expect(st.intent).toEqual({ locked: true, answer: "yes", viaStage: true });
    expect(st.payment.locked).toBe(false);
  });

  it("treats `lost` as terminal, NOT as past every milestone", () => {
    // `lost` is appended last in FUNNEL_STAGES so the engine cannot pull a
    // lost deal forward; a naive index compare would read it as "past
    // purchased" and imply all three were answered yes.
    const st = statesOf([], "lost");
    expect(st.genuine.locked).toBe(false);
    expect(stageImplies("lost", "payment")).toBe(false);
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

  // The question is now locked — answered, and never askable again.
  const state = await asUser.query(api.leadQuality.getCardState, {
    conversationId,
  });
  const genuine = state.steps.find((s) => s.step === "genuine")!;
  expect(genuine.locked).toBe(true);
  expect(genuine.answer).toBe("no");
  // The other two remain open: rejecting the lead does not pre-answer them.
  expect(state.pendingCount).toBe(2);
});

test("dismissing records the dodge, sends nothing, and leaves the question open", async () => {
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
  // A dismissal is not an answer, so the question stays answerable.
  expect(state.steps.find((s) => s.step === "genuine")!.locked).toBe(false);
  expect(state.pendingCount).toBe(3);
});

test("a step can only be answered once — the second attempt is refused", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "genuine",
    answer: "yes",
  });
  // Answered once, locked for good: the Meta event it produced can only
  // fire once, so a second answer could never be reported and would only
  // make the log disagree with what Meta was actually told.
  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step: "genuine",
      answer: "no",
    }),
  ).rejects.toThrow();

  expect(await eventStages(t, conversationId)).toEqual(["new_lead", "qualified"]);
  const rows = await t.run((ctx) =>
    ctx.db
      .query("leadQualityAnswers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
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
  expect(state.steps).toEqual([]);
  expect(state.pendingCount).toBe(0);

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
