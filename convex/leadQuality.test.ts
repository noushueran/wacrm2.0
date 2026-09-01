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
      {
        locked: s.locked,
        available: s.available,
        blocked: s.blocked,
        answer: s.answer,
        viaStage: s.viaStage,
        revisable: s.revisable,
      },
    ]),
  );
}

/** Which step the panel would show as answerable. */
function openStep(
  answers: AnswerRecord[],
  currentStage: Parameters<typeof stepStates>[0]["currentStage"] = null,
) {
  return stepStates({ answers, currentStage }).find((s) => s.available)?.step ?? null;
}

describe("stepStates", () => {
  it("opens ONLY the first question — nothing else is answerable yet", () => {
    const st = statesOf([]);
    expect(st.genuine).toMatchObject({ available: true, blocked: false });
    for (const step of ["service", "intent", "payment"] as const) {
      expect(st[step]).toMatchObject({ locked: false, available: false });
    }
    expect(openStep([])).toBe("genuine");
  });

  it("unlocks the next question only after a YES, one at a time", () => {
    const answers: AnswerRecord[] = [];
    expect(openStep(answers)).toBe("genuine");

    answers.push({ step: "genuine", answer: "yes", at: T0 });
    expect(openStep(answers)).toBe("service");
    // And still exactly one is open.
    expect(stepStates({ answers, currentStage: null }).filter((s) => s.available))
      .toHaveLength(1);

    answers.push({ step: "service", answer: "yes", at: T0 + 1 });
    expect(openStep(answers)).toBe("intent");

    answers.push({ step: "intent", answer: "yes", at: T0 + 2 });
    expect(openStep(answers)).toBe("payment");

    answers.push({
      step: "payment", answer: "yes", at: T0 + 3, value: 2500, currency: "AED",
    });
    expect(openStep(answers)).toBeNull(); // sequence complete
  });

  it("a NO ends the sequence — later questions are blocked, not merely closed", () => {
    // Every later question presupposes the earlier answer was yes. Asking
    // "serious about booking?" of a lead marked "not a real customer"
    // would invite a record that cannot be true.
    const st = statesOf([{ step: "genuine", answer: "no", at: T0 }]);
    expect(st.genuine).toMatchObject({ locked: true, answer: "no" });
    for (const step of ["service", "intent", "payment"] as const) {
      expect(st[step]).toMatchObject({ available: false, blocked: true });
    }
    expect(openStep([{ step: "genuine", answer: "no", at: T0 }])).toBeNull();
  });

  it("a NO midway blocks only what comes after it", () => {
    const answers: AnswerRecord[] = [
      { step: "genuine", answer: "yes", at: T0 },
      { step: "service", answer: "no", at: T0 + 1 },
    ];
    const st = statesOf(answers);
    expect(st.genuine.locked).toBe(true);
    expect(st.service).toMatchObject({ locked: true, answer: "no" });
    expect(st.intent.blocked).toBe(true);
    expect(st.payment.blocked).toBe(true);
  });

  it("carries the recorded amount through for display", () => {
    const [, , , payment] = stepStates({
      answers: [
        { step: "payment", answer: "yes", at: T0, value: 2500, currency: "AED" },
      ],
      currentStage: null,
    });
    expect(payment).toMatchObject({ value: 2500, currency: "AED", answer: "yes" });
  });

  it("locks a `no` too — an answer is an answer", () => {
    const st = statesOf([{ step: "genuine", answer: "no", at: T0 }]);
    expect(st.genuine).toMatchObject({ locked: true, answer: "no", viaStage: false });
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
    expect(statesOf(answers).genuine).toMatchObject({
      locked: true,
      answer: "yes",
      viaStage: false,
    });
  });

  it("treats a CRM stage past a milestone as an implied yes, marked as such", () => {
    const st = statesOf([], "price_quoted");
    expect(st.genuine).toMatchObject({ locked: true, answer: "yes", viaStage: true });
    expect(st.intent).toMatchObject({ locked: true, answer: "yes", viaStage: true });
    expect(st.payment.locked).toBe(false);
  });

  it("marks ANY recorded NO revisable — every judgement here is provisional", () => {
    // The chat dismissed as junk replies three days later; the service
    // turns out to be available; the unpaid deal pays. A `no` sent nothing,
    // so correcting it contradicts nothing Meta was told.
    for (const step of ["genuine", "service", "intent", "payment"] as const) {
      // Walk far enough that `step` is the one being answered `no`.
      const answers: AnswerRecord[] = [];
      let at = T0;
      for (const earlier of ["genuine", "service", "intent", "payment"] as const) {
        if (earlier === step) break;
        answers.push({ step: earlier, answer: "yes", at: at++ });
      }
      answers.push({ step, answer: "no", at: at++ });
      const st = statesOf(answers);
      expect(st[step]).toMatchObject({ locked: true, answer: "no", revisable: true });
    }
  });

  it("re-opens the next question when a NO is corrected to YES", () => {
    // The correction must not leave the sequence half-open. Nothing
    // special-cases this — the whole table is derived from the log, so the
    // gate simply computes differently on the next read.
    const rejected = statesOf([{ step: "genuine", answer: "no", at: T0 }]);
    expect(rejected.service).toMatchObject({ blocked: true, available: false });

    const corrected = statesOf([
      { step: "genuine", answer: "no", at: T0 },
      { step: "genuine", answer: "yes", at: T0 + 60_000 },
    ]);
    expect(corrected.genuine).toMatchObject({ answer: "yes", revisable: false });
    expect(corrected.service).toMatchObject({ available: true, blocked: false });
  });

  it("never marks a YES revisable, at any step — those events are already sent", () => {
    const st = statesOf([
      { step: "genuine", answer: "yes", at: T0 },
      { step: "service", answer: "yes", at: T0 + 1 },
    ]);
    expect(st.genuine.revisable).toBe(false);
    expect(st.service.revisable).toBe(false);
  });

  it("does not mark a BLOCKED step revisable — revision is not a way to skip", () => {
    // `service` was never answered; an earlier `no` merely closed the gate
    // in front of it. There is no answer there to correct.
    const st = statesOf([{ step: "genuine", answer: "no", at: T0 }]);
    expect(st.service).toMatchObject({ blocked: true, revisable: false });
    expect(st.payment).toMatchObject({ blocked: true, revisable: false });
  });

  it("never marks a payment YES revisable — that Purchase is already sent", () => {
    const st = statesOf([
      { step: "genuine", answer: "yes", at: T0 },
      { step: "service", answer: "yes", at: T0 + 1 },
      { step: "intent", answer: "yes", at: T0 + 2 },
      { step: "payment", answer: "yes", at: T0 + 3, value: 900, currency: "AED" },
    ]);
    expect(st.payment).toMatchObject({ locked: true, answer: "yes", revisable: false });
  });

  it("does not mark an UNANSWERED or stage-implied payment revisable", () => {
    // Nothing to revise while the question is still open...
    expect(statesOf([]).payment.revisable).toBe(false);
    // ...and implication only ever yields a `yes`, which is final.
    const implied = statesOf([], "purchased");
    expect(implied.payment).toMatchObject({ locked: true, viaStage: true, revisable: false });
  });

  it("treats `lost` as terminal, NOT as past every milestone", () => {
    // `lost` is appended last in FUNNEL_STAGES so the engine cannot pull a
    // lost deal forward; a naive index compare would read it as "past
    // purchased" and imply all three were answered yes.
    const st = statesOf([], "lost");
    expect(st.genuine.locked).toBe(false);
    expect(st.genuine.available).toBe(true);
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

test("answering the sequence reports all four milestones, in order", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  for (const step of ["genuine", "service", "intent"] as const) {
    const res = await asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step,
      answer: "yes",
    });
    expect(res.sentToMeta).toBe(true);
  }
  const paid = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "payment",
    answer: "yes",
    value: 2499,
  });
  expect(paid.sentToMeta).toBe(true);

  // Lead (automatic) + the four the agent attested to.
  expect(await eventStages(t, conversationId)).toEqual([
    "itinerary_sent",
    "new_lead",
    "price_quoted",
    "purchased",
    "qualified",
  ]);

  const rows = await t.run((ctx) =>
    ctx.db
      .query("conversionEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  const byStage = Object.fromEntries(rows.map((r) => [r.stage, r]));
  expect(byStage.qualified.eventName).toBe("QualifiedLead");
  expect(byStage.itinerary_sent.eventName).toBe("AddToCart");
  expect(byStage.price_quoted.eventName).toBe("InitiateCheckout");
  expect(byStage.purchased.eventName).toBe("Purchase");
  expect(byStage.purchased.value).toBe(2499);
  expect(byStage.purchased.currency).toBe("AED");
});

test("the sequence is enforced server-side, not just by hiding buttons", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  // Jumping straight to payment would report a Purchase on a lead Meta was
  // never told was qualified, and record money against a customer nobody
  // confirmed was real.
  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId, step: "payment", answer: "yes", value: 5000,
    }),
  ).rejects.toThrow();
  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId, step: "intent", answer: "yes",
    }),
  ).rejects.toThrow();
  expect(await eventStages(t, conversationId)).toEqual(["new_lead"]);
});

test("a NO stops the sequence — the next question cannot be answered at all", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  await asUser.mutation(api.leadQuality.answer, {
    conversationId, step: "genuine", answer: "no", reason: "spam",
  });
  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId, step: "service", answer: "yes",
    }),
  ).rejects.toThrow();
  expect(await eventStages(t, conversationId)).toEqual(["new_lead"]);
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
  // Nothing further is reachable: a rejected lead ends the sequence.
  expect(state.steps.filter((s) => s.available)).toHaveLength(0);
  expect(state.steps.filter((s) => s.blocked)).toHaveLength(3);
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
  expect(state.steps.find((s) => s.step === "genuine")!.available).toBe(true);
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

  for (const step of ["genuine", "service", "intent"] as const) {
    await asUser.mutation(api.leadQuality.answer, {
      conversationId, step, answer: "yes",
    });
  }
  const res = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "payment",
    answer: "yes",
    value: 1000,
  });
  expect(res.sentToMeta).toBe(true);
});

test("an organic chat SHOWS the card, logs feedback, and can never seed an event", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId, {
    attributed: false,
  });

  const state = await asUser.query(api.leadQuality.getCardState, {
    conversationId,
  });
  // The card renders for organic leads too — the answers are worth having
  // internally — but `attributed: false` tells the panel to say outright
  // that nothing here reaches Meta.
  expect(state.attributed).toBe(false);
  expect(state.steps).toHaveLength(4);
  expect(state.steps.find((s) => s.step === "genuine")).toMatchObject({
    available: true,
  });
  expect(state.pendingCount).toBe(4);

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

test("stage implication seeds an untouched lead, then yields to the answer log", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  // Untouched by the panel, but an agent already walked it to price_quoted
  // by hand: don't ask whether it is a real customer.
  await t.run((ctx) =>
    ctx.db.patch(conversationId, {
      funnel: { stage: "price_quoted", stageUpdatedAt: Date.now() },
    }),
  );
  let state = await asUser.query(api.leadQuality.getCardState, { conversationId });
  expect(state.steps.find((s) => s.step === "genuine")!.viaStage).toBe(true);

  // Now reset and drive it from the panel instead. Answering `service`
  // advances the stage to `itinerary_sent`, which sits DEEPER than the
  // `price_quoted` that `intent` maps to — if implication still applied,
  // `intent` would lock and its InitiateCheckout would never fire.
  const fresh = await seedLead(t, accountId, userId);
  await asUser.mutation(api.leadQuality.answer, {
    conversationId: fresh.conversationId, step: "genuine", answer: "yes",
  });
  await asUser.mutation(api.leadQuality.answer, {
    conversationId: fresh.conversationId, step: "service", answer: "yes",
  });
  state = await asUser.query(api.leadQuality.getCardState, {
    conversationId: fresh.conversationId,
  });
  const intent = state.steps.find((s) => s.step === "intent")!;
  expect(intent.locked).toBe(false);
  expect(intent.available).toBe(true);

  // And it genuinely fires.
  const res = await asUser.mutation(api.leadQuality.answer, {
    conversationId: fresh.conversationId, step: "intent", answer: "yes",
  });
  expect(res.sentToMeta).toBe(true);
  expect(await eventStages(t, fresh.conversationId)).toContain("price_quoted");
});

// ============================================================
// The late payment. The one answer this card lets an agent change.
// ============================================================

/** Walk the first three questions so `payment` is the open one. */
async function answerUpToPayment(
  asUser: ReturnType<TestConvex<typeof schema>["withIdentity"]>,
  conversationId: Id<"conversations">,
) {
  for (const step of ["genuine", "service", "intent"] as const) {
    await asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step,
      answer: "yes",
    });
  }
}

test("a payment NO can later become a YES, and only then sends the Purchase", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);
  await answerUpToPayment(asUser, conversationId);

  // Not paid yet — recorded, and deliberately never reported.
  const unpaid = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "payment",
    answer: "no",
  });
  expect(unpaid.sentToMeta).toBe(false);
  expect(await eventStages(t, conversationId)).not.toContain("purchased");

  // The panel offers the correction rather than closing the question for
  // good, which is what used to strand the Purchase forever.
  let state = await asUser.query(api.leadQuality.getCardState, {
    conversationId,
  });
  expect(state.steps.find((s) => s.step === "payment")).toMatchObject({
    locked: true,
    answer: "no",
    revisable: true,
  });

  // The customer pays a week later.
  const paid = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "payment",
    answer: "yes",
    value: 3200,
  });
  expect(paid.sentToMeta).toBe(true);
  expect(await eventStages(t, conversationId)).toContain("purchased");

  const purchase = await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("conversionEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect();
    return rows.find((r) => r.stage === "purchased");
  });
  expect(purchase?.eventName).toBe("Purchase");
  expect(purchase?.value).toBe(3200);
  expect(purchase?.currency).toBe("AED");

  // Append-only: BOTH the original verdict and the correction survive, so
  // the log still shows the deal was once marked unpaid.
  const rows = await t.run((ctx) =>
    ctx.db
      .query("leadQualityAnswers")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  const payments = rows.filter((r) => r.step === "payment");
  expect(payments.map((r) => r.answer).sort()).toEqual(["no", "yes"]);

  // And now it is final in both directions.
  state = await asUser.query(api.leadQuality.getCardState, { conversationId });
  expect(state.steps.find((s) => s.step === "payment")).toMatchObject({
    answer: "yes",
    revisable: false,
  });
});

test("a payment YES can never be taken back — Meta has no retraction", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);
  await answerUpToPayment(asUser, conversationId);

  await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "payment",
    answer: "yes",
    value: 1500,
  });

  // The Purchase is already on the wire. Un-saying it would only make the
  // log disagree with what Meta was told.
  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step: "payment",
      answer: "no",
    }),
  ).rejects.toThrow();
});

test("the revision still demands an amount, and still refuses out of sequence", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);
  await answerUpToPayment(asUser, conversationId);
  await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "payment",
    answer: "no",
  });

  // `seedStageConversionEvent` refuses a valueless `purchased`, so the
  // revision must collect money like any other Purchase.
  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step: "payment",
      answer: "yes",
    }),
  ).rejects.toThrow();
  expect(await eventStages(t, conversationId)).not.toContain("purchased");

  // Revisability is not a general re-opening: the earlier milestones stay
  // shut.
  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step: "genuine",
      answer: "no",
    }),
  ).rejects.toThrow();
});

test("a payment NO reached without the sequence stays unrevisable", async () => {
  // A lead rejected at the first question never reaches payment at all, so
  // there is no `no` to revise and the correction must not become a side
  // door into the sequence.
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "genuine",
    answer: "no",
    reason: "spam",
  });

  const state = await asUser.query(api.leadQuality.getCardState, {
    conversationId,
  });
  expect(state.steps.find((s) => s.step === "payment")).toMatchObject({
    blocked: true,
    revisable: false,
  });
  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step: "payment",
      answer: "yes",
      value: 4000,
    }),
  ).rejects.toThrow();
  expect(await eventStages(t, conversationId)).toEqual(["new_lead"]);
});

test("a LOST deal that later pays still reports the Purchase (stage stays lost)", async () => {
  // The recovery case the revision exists for, at its most extreme: the
  // deal was written off, then the customer paid.
  //
  // The Meta event — the whole point — fires. The CRM stage does NOT move
  // back, because `applyStageTransition` is called with `neverDowngrade`
  // and `lost` is appended LAST in FUNNEL_STAGES, so `purchased` reads as
  // backwards from it. That is a KNOWN limitation, asserted here so it is
  // a decision on the record rather than a surprise: the lead-quality
  // report counts conversion EVENTS and so counts this sale, while "Funnel
  // by stage" reads stages and still files it under Lost. Recovering a lost
  // deal properly means clearing its loss reason and detail too, which is
  // a larger change than this correction.
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);
  await answerUpToPayment(asUser, conversationId);
  await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "payment",
    answer: "no",
  });
  await asUser.mutation(api.funnel.setStage, {
    conversationId,
    stage: "lost",
    lossCategory: "price",
    lossDetail: "went quiet for weeks",
  });

  const res = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "payment",
    answer: "yes",
    value: 777,
  });
  expect(res.sentToMeta).toBe(true);
  expect(await eventStages(t, conversationId)).toContain("purchased");

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.funnel?.stage).toBe("lost");
});

test("a rejected lead can be reinstated, and the sequence continues from there", async () => {
  // The case that prompted this: an agent marks a chat "not a real
  // customer", and days later the customer replies asking to book.
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  const rejected = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "genuine",
    answer: "no",
    reason: "no_intent",
  });
  expect(rejected.sentToMeta).toBe(false);
  expect(await eventStages(t, conversationId)).toEqual(["new_lead"]);

  // Everything after it is shut, and stays shut while the `no` stands.
  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step: "service",
      answer: "yes",
    }),
  ).rejects.toThrow();

  // The customer comes back.
  const reinstated = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "genuine",
    answer: "yes",
  });
  expect(reinstated.sentToMeta).toBe(true);
  expect(await eventStages(t, conversationId)).toContain("qualified");

  // And the rest of the sequence is open again — the correction did not
  // leave the lead stranded one question in.
  const state = await asUser.query(api.leadQuality.getCardState, {
    conversationId,
  });
  expect(state.steps.find((s) => s.step === "service")).toMatchObject({
    available: true,
  });
  await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "service",
    answer: "yes",
  });
  expect(await eventStages(t, conversationId)).toContain("itinerary_sent");
});

test("every step's NO can be corrected, and every YES stays final", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  // Answer `no` at each step in turn, correct it, and carry on. This walks
  // the whole sequence through a correction at every position.
  for (const step of ["genuine", "service", "intent"] as const) {
    await asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step,
      answer: "no",
    });
    await asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step,
      answer: "yes",
    });
    // Now final: the event is on the wire and cannot be un-sent.
    await expect(
      asUser.mutation(api.leadQuality.answer, {
        conversationId,
        step,
        answer: "no",
      }),
    ).rejects.toThrow();
  }

  expect(await eventStages(t, conversationId)).toEqual([
    "itinerary_sent",
    "new_lead",
    "price_quoted",
    "qualified",
  ]);

  // Each milestone was reported exactly ONCE despite being answered twice —
  // the outbox dedups on `${conversationId}:${stage}`.
  const rows = await t.run((ctx) =>
    ctx.db
      .query("conversionEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(rows).toHaveLength(4);
});

test("correcting a NO cannot be used to skip the sequence", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId);

  await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "genuine",
    answer: "no",
  });

  // `intent` was never answered — an earlier `no` merely closed the gate in
  // front of it — so there is nothing there to correct, and the revision
  // path must not open it.
  await expect(
    asUser.mutation(api.leadQuality.answer, {
      conversationId,
      step: "intent",
      answer: "yes",
    }),
  ).rejects.toThrow();
  expect(await eventStages(t, conversationId)).toEqual(["new_lead"]);
});

test("an organic lead can be answered and corrected, and still sends nothing", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedMember(t);
  const { conversationId } = await seedLead(t, accountId, userId, {
    attributed: false,
  });

  await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "genuine",
    answer: "no",
  });
  const corrected = await asUser.mutation(api.leadQuality.answer, {
    conversationId,
    step: "genuine",
    answer: "yes",
  });
  // Recorded for internal reporting; nothing on the wire, because
  // `seedStageConversionEvent` seeds only for an attributed conversation.
  expect(corrected.sentToMeta).toBe(false);
  expect(await eventStages(t, conversationId)).toEqual([]);

  // The sequence still advances internally, so the panel keeps working.
  const state = await asUser.query(api.leadQuality.getCardState, {
    conversationId,
  });
  expect(state.attributed).toBe(false);
  expect(state.steps.find((s) => s.step === "service")).toMatchObject({
    available: true,
  });
});
