// ============================================================
// Lead-quality feedback loop (spec docs/superpowers/specs/2026-09-01-
// lead-quality-feedback-loop-design.md).
//
// The problem this exists for: the Meta CAPI lifecycle can only report
// `QualifiedLead`/`InitiateCheckout`/`Purchase` when someone advances the
// CRM funnel, and an audit found staff do not know the stage control in the
// thread header exists. So Meta received raw lead volume and nothing about
// lead QUALITY — the entire point of the integration.
//
// This module is the discoverable front door: an inline card in the message
// thread asks ONE plain question at a time ("Is this a real customer?"), and
// a positive answer is converted into the funnel transition that already
// produces the Meta event. It deliberately does NOT emit conversion events
// itself — `applyStageTransition` remains the single path to the outbox, so
// the dedup, retry, rollup and reporting guarantees in `conversionEvents.ts`
// all still apply exactly once.
//
// The "only good leads reach Meta" rule is STRUCTURAL rather than a check:
// a `no` or `dismissed` answer writes its row and returns, and there is no
// code path from there to `applyStageTransition`. Negative answers are still
// recorded — the bad-lead signal is wanted for internal reporting; it just
// never leaves the building.
// ============================================================

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { accountMutation, accountQuery } from "./lib/auth";
import { requireConversationAccess } from "./lib/conversationAccess";
import { applyStageTransition, seedStageConversionEvent } from "./funnel";
import { FUNNEL_STAGE_KEYS, type FunnelStageKey } from "./lib/funnel";

/**
 * The milestones an agent attests to, in the order the SALES CONVERSATION
 * establishes them — which is not the order `FUNNEL_STAGES` indexes them
 * in, and deliberately so. Eligibility ("can we even serve this person?")
 * is settled before intent ("do they want to book?"), because a traveller
 * can badly want a visa they are not entitled to; asking about intent
 * first wastes the answer.
 *
 * That mismatch is why `answer` seeds the conversion event directly rather
 * than relying on `applyStageTransition` to do it — see there.
 */
export const QUALITY_STEPS = [
  "genuine",
  "service",
  "intent",
  "payment",
] as const;
export type QualityStep = (typeof QUALITY_STEPS)[number];

export type QualityAnswer = "yes" | "no" | "dismissed";

/**
 * Which funnel stage a positive answer advances to. The question and the
 * stage are deliberately different vocabularies — "Is this a real customer?"
 * is answerable mid-chat, "Qualified lead" is not — and this map is the only
 * place the two are joined.
 */
export const STEP_STAGE: Record<QualityStep, FunnelStageKey> = {
  genuine: "qualified", // QualifiedLead — a real person worth selling to
  service: "itinerary_sent", // AddToCart — the service is a fit for them
  intent: "price_quoted", // InitiateCheckout — they mean to book
  payment: "purchased", // Purchase — money received
};

export type AnswerRecord = {
  step: QualityStep;
  answer: QualityAnswer;
  at: number;
  value?: number;
  currency?: string;
};

/**
 * Whether the CRM's own stage already implies this step was answered yes.
 *
 * Seeds the panel from reality as well as from its own log, so a lead an
 * agent moved manually to `price_quoted` is not asked "is this a real
 * customer?" — that milestone is already recorded and already reported.
 *
 * `lost` is excluded deliberately. It is appended LAST in `FUNNEL_STAGES`
 * (so the engine can never pull a lost deal back into the working stages),
 * which means a naive index comparison would read it as "past every
 * milestone" and imply all three steps were answered yes. It is a terminal
 * exit, not progression.
 */
export function stageImplies(
  currentStage: FunnelStageKey | null | undefined,
  step: QualityStep,
): boolean {
  if (!currentStage || currentStage === "lost") return false;
  return (
    FUNNEL_STAGE_KEYS.indexOf(currentStage) >=
    FUNNEL_STAGE_KEYS.indexOf(STEP_STAGE[step])
  );
}

/** The latest answer logged for `step`, or null. */
export function latestFor(
  answers: AnswerRecord[],
  step: QualityStep,
): AnswerRecord | null {
  let latest: AnswerRecord | null = null;
  for (const a of answers) {
    if (a.step === step && (!latest || a.at > latest.at)) latest = a;
  }
  return latest;
}

/**
 * One step's state for the panel.
 *
 * `locked` — already answered here, or already implied by the CRM stage.
 * An answered question is answered for good: the Meta event it produced can
 * only fire once (the outbox dedups on `${conversationId}:${stage}`), so
 * offering the buttons again would invite a click that silently does
 * nothing. The single exception is `revisable`, below.
 *
 * `revisable` — locked with a `no`, but still changeable to `yes`. TRUE
 * ONLY for `payment`, and only in that one direction. Money is the one
 * milestone here whose answer legitimately changes with time: a deal marked
 * unpaid on Tuesday is paid on Friday, and before this the panel had no way
 * to say so — the lead stayed "no" forever and its `Purchase` never
 * reached Meta, which is the single most valuable event this card exists to
 * send. The reverse is refused: a `yes` already put a `Purchase` on the
 * wire and Meta has no retraction, so un-saying it would only make the log
 * disagree with what was reported.
 *
 * `available` — answerable RIGHT NOW. Only one step is ever available: the
 * questions are a sequence, and each opens only once the one before it was
 * answered YES.
 *
 * `blocked` — unreachable, because an earlier step was answered `no`. There
 * is no point asking whether someone is serious about booking once they
 * have been marked "not a real customer", and a panel that offered the
 * question anyway would invite a contradictory record.
 *
 * `viaStage` distinguishes "an agent answered this here" from "the CRM
 * stage already passed this milestone". Both lock the step; only the first
 * has an author and a timestamp to show.
 */
export type StepState = {
  step: QualityStep;
  locked: boolean;
  available: boolean;
  blocked: boolean;
  /** A recorded `no` here may still be replaced by a `yes`. Payment only. */
  revisable: boolean;
  answer: "yes" | "no" | null;
  viaStage: boolean;
  value?: number;
  currency?: string;
  answeredAt?: number;
};

/**
 * Every step's state, as a strict sequence.
 *
 * A first build showed all questions at once and let an agent answer any of
 * them in any order. That produced records that could not be true together
 * — a lead marked "payment received" while "is this a real customer?" sat
 * unanswered — and it let the most valuable event fire without the cheaper
 * signals that give Meta the funnel shape. One question at a time, each
 * unlocked by a YES on the one before, is what keeps the reported funnel
 * monotonic.
 *
 * A `no` ENDS the sequence rather than skipping a step: every later
 * question presupposes the earlier answer was yes.
 *
 * Pure and total — no clock, no database — so the table is unit-testable.
 */
export function stepStates(input: {
  answers: AnswerRecord[];
  currentStage: FunnelStageKey | null | undefined;
}): StepState[] {
  // Stage implication seeds the sequence from CRM state that predates the
  // panel — so a lead an agent had already walked to `price_quoted` by hand
  // is not asked whether it is a real customer.
  //
  // It applies ONLY while the panel is untouched. Once any answer exists,
  // the log owns the sequence outright, because the panel MOVES the stage
  // as it goes and the question order is not the funnel's index order:
  // answering `service` advances the conversation to `itinerary_sent`,
  // which sits deeper than the `price_quoted` that `intent` maps to, so
  // implication would then lock the very next question and its
  // `InitiateCheckout` would never fire.
  const untouched = !input.answers.some(
    (a) => a.answer === "yes" || a.answer === "no",
  );

  let gateOpen = true;
  return QUALITY_STEPS.map((step) => {
    const implied = untouched && stageImplies(input.currentStage, step);
    const latest = latestFor(input.answers, step);
    // A dismissal is not an answer; it never locks a step.
    const explicit =
      latest && (latest.answer === "yes" || latest.answer === "no")
        ? latest
        : null;

    const locked = Boolean(explicit) || implied;
    const answer = explicit
      ? (explicit.answer as "yes" | "no")
      : implied
        ? ("yes" as const)
        : null;

    // Payment, and payment alone, can be un-said in one direction. An
    // implied lock is never revisable: implication only ever yields a
    // `yes`, and a `yes` is final.
    const revisable = step === "payment" && explicit?.answer === "no";

    const state: StepState = {
      step,
      locked,
      available: !locked && gateOpen,
      blocked: !locked && !gateOpen,
      revisable,
      answer,
      viaStage: !explicit && implied,
      ...(explicit?.value !== undefined
        ? { value: explicit.value, currency: explicit.currency }
        : {}),
      ...(explicit ? { answeredAt: explicit.at } : {}),
    };

    // The gate for the NEXT step: open only behind a recorded yes. An
    // unanswered step closes it (nothing past the current question is
    // reachable), and so does a `no`.
    if (!locked || answer !== "yes") gateOpen = false;

    return state;
  });
}

// Mirrors `leadQualityAnswers.step` in schema.ts — the two are separate
// declarations and must be changed together; a step added to only one is
// accepted by the mutation and then rejected by the insert (or vice versa).
const stepValidator = v.union(
  v.literal("genuine"),
  v.literal("service"),
  v.literal("intent"),
  v.literal("payment"),
);

const answerValidator = v.union(
  v.literal("yes"),
  v.literal("no"),
  v.literal("dismissed"),
);

function toRecords(rows: Doc<"leadQualityAnswers">[]): AnswerRecord[] {
  return rows.map((r) => ({
    step: r.step,
    answer: r.answer,
    at: r._creationTime,
    ...(r.value !== undefined ? { value: r.value } : {}),
    ...(r.currency !== undefined ? { currency: r.currency } : {}),
  }));
}

/**
 * Everything the lead-quality panel renders for one conversation.
 *
 * `"view"` access, not `"own"`: a supervisor reading someone else's thread
 * should see the same state the assigned agent sees. Answering is gated
 * separately and more tightly (see `answer`), so a reader who cannot act
 * gets `canAnswer: false` and the panel renders read-only rather than
 * offering buttons that would throw.
 */
export const getCardState = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    attributed: boolean;
    canAnswer: boolean;
    steps: StepState[];
    /** How many steps are still open — the trigger's badge. */
    pendingCount: number;
  }> => {
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );

    // Only attributed leads can produce a Meta event, so only they are worth
    // an agent's attention here. Checked before the answer read so an
    // organic thread costs one document, not two.
    if (conversation.attribution === undefined) {
      return { attributed: false, canAnswer: false, steps: [], pendingCount: 0 };
    }

    const rows = await ctx.db
      .query("leadQualityAnswers")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();

    const steps = stepStates({
      answers: toRecords(rows),
      currentStage: conversation.funnel?.stage ?? null,
    });

    // Mirrors `answer`'s own gate, so the panel never offers a button that
    // would throw: agents act on their own threads, supervisors+ on any.
    const canAnswer =
      ctx.role === "owner" ||
      ctx.role === "admin" ||
      ctx.role === "supervisor" ||
      (ctx.role === "agent" &&
        conversation.assignedToUserId === ctx.userId);

    return {
      attributed: true,
      canAnswer,
      steps,
      pendingCount: steps.filter((s) => !s.locked).length,
    };
  },
});

/**
 * Records one answer and, for a `yes`, advances the funnel — which is what
 * seeds the Meta event.
 *
 * Access mirrors `funnel.setStage` exactly (`requireRole("agent")` +
 * `requireConversationAccess(..., "own")`), because this reaches the same
 * outbox by a different door and must not be the weaker one.
 *
 * A payment `no` may later be revised to `yes` — the ONLY answer this card
 * lets an agent change, and only in that direction. See
 * `StepState.revisable`. The revision writes a second row rather than
 * editing the first: `leadQualityAnswers` is an append-only log and
 * `latestFor` reads the newest per step, so both the original verdict and
 * the correction survive for reporting.
 *
 * The sales-checklist gate that `setStage` applies to `purchased` is
 * deliberately NOT applied here (approved 2026-09-01). The card records that
 * money arrived — a fact — rather than certifying deal hygiene, and putting
 * a checklist in front of the single most valuable question is how this data
 * goes uncollected. The amount is still mandatory: `seedStageConversionEvent`
 * refuses a valueless `purchased` from any caller, so the guard below fails
 * loudly here rather than silently producing a stage change with no event.
 */
export const answer = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    step: stepValidator,
    answer: answerValidator,
    reason: v.optional(v.string()),
    value: v.optional(v.number()),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ sentToMeta: boolean }> => {
    ctx.requireRole("agent");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "own",
    );

    const step = args.step as QualityStep;
    const hasValue = args.value !== undefined && args.value > 0;
    if (step === "payment" && args.answer === "yes" && !hasValue) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "value_required" });
    }

    // Answer once, with one exception. The Meta event a `yes` produces can
    // only fire once (the outbox dedups on `${conversationId}:${stage}`),
    // so re-answering could never reach Meta and would only make the log
    // disagree with what was actually reported. Enforced server-side rather
    // than by hiding the buttons, because the panel is a live view that
    // another agent may have answered from a second later.
    //
    // The exception is `revising` below: a payment `no` that becomes a
    // `yes` has no event to contradict — none was ever sent — so it seeds
    // the `Purchase` for the first time rather than duplicating one.
    const existing = await ctx.db
      .query("leadQualityAnswers")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
    const priorStates = stepStates({
      answers: toRecords(existing),
      currentStage: conversation.funnel?.stage ?? null,
    });
    const prior = priorStates.find((st) => st.step === step);

    // The one reversal this card permits: a recorded `no` on PAYMENT,
    // replaced by a `yes`. Deals close late — a lead marked unpaid pays a
    // week later — and without this the `no` was permanent and its
    // `Purchase` could never be reported, which is exactly the event the
    // integration exists to send. `revisable` is computed in `stepStates`
    // so the panel and this guard can never disagree about what may be
    // changed; it is false for every other step and for a `yes`, which
    // Meta has already been told and cannot be un-told.
    const revising = args.answer === "yes" && prior?.revisable === true;

    if (args.answer !== "dismissed" && !revising) {
      if (prior?.locked) {
        throw new ConvexError({
          code: "BAD_REQUEST",
          reason: "already_answered",
        });
      }
      // The sequence is enforced HERE, not just by the panel hiding
      // buttons. Answering out of order would report a deep milestone with
      // no shallower ones behind it — Meta would see a Purchase on a lead
      // it was never told was qualified — and would leave a record that
      // cannot be true (payment received on a lead nobody confirmed was a
      // real customer).
      if (!prior?.available) {
        throw new ConvexError({
          code: "BAD_REQUEST",
          reason: "out_of_sequence",
        });
      }
    }

    const account = await ctx.db.get(ctx.accountId);
    const currency = args.currency ?? account?.defaultCurrency ?? "USD";

    let conversionEventId: Id<"conversionEvents"> | undefined;
    if (args.answer === "yes") {
      const stage = STEP_STAGE[step];
      const valueArgs =
        step === "payment"
          ? { value: args.value, currency }
          : {};

      // Seed the Meta event FIRST and unconditionally.
      //
      // The questions run in sales order, which is not `FUNNEL_STAGES`
      // index order: `service` maps to `itinerary_sent` and the `intent`
      // that follows it maps to the EARLIER `price_quoted`. Left to
      // `applyStageTransition`, whose `neverDowngrade` guard returns before
      // seeding, that step's event would silently never fire. Seeding here
      // makes the event answer to the question asked rather than to the
      // funnel's ordering. Idempotent: the `${conversationId}:${stage}`
      // dedup means a second call returns the existing row.
      const seeded = await seedStageConversionEvent(ctx, {
        accountId: ctx.accountId,
        conversation,
        stage,
        ...valueArgs,
      });
      conversionEventId = seeded.conversionEventId;

      // Then advance the operational funnel — forward only. A backward
      // stage is refused here (and only here), so the CRM's own record of
      // where a deal stands never regresses because of question ordering.
      await applyStageTransition(ctx, {
        accountId: ctx.accountId,
        conversation,
        stage,
        byUserId: ctx.userId,
        auto: false,
        neverDowngrade: true,
        ...(step === "payment"
          ? { saleValue: args.value, saleCurrency: currency }
          : {}),
        defaultCurrency: account?.defaultCurrency ?? "USD",
      });
    }

    const trimmedReason = args.reason?.trim();
    await ctx.db.insert("leadQualityAnswers", {
      accountId: ctx.accountId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      step,
      answer: args.answer,
      ...(trimmedReason ? { reason: trimmedReason } : {}),
      ...(step === "payment" && hasValue
        ? { value: args.value, currency }
        : {}),
      byUserId: ctx.userId,
      ...(conversionEventId ? { conversionEventId } : {}),
    });

    return { sentToMeta: conversionEventId !== undefined };
  },
});
