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

// The state machine itself lives in `lib/leadQuality.ts` — pure, and
// therefore importable by `conversations.list` without dragging this
// module's auth and funnel dependencies into the inbox list query.
// Re-exported here so every existing `from "./leadQuality"` import, and
// the tests, keep working against one definition.
export {
  QUALITY_STEPS,
  STEP_STAGE,
  stageImplies,
  latestFor,
  stepStates,
  summarizeSteps,
  QUALITY_STEP_COUNT,
} from "./lib/leadQuality";
export type {
  QualityStep,
  QualityAnswer,
  AnswerRecord,
  StepState,
  LeadQualitySummary,
} from "./lib/leadQuality";

// A local binding for everything this module USES. `export ... from`
// above re-exports the names for importers but binds nothing here — the
// mutation's own `STEP_STAGE` lookup was a ReferenceError at runtime while
// still typechecking clean, which the tests caught.
import {
  STEP_STAGE,
  stepStates,
  type QualityStep,
  type AnswerRecord,
  type StepState,
} from "./lib/leadQuality";

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

    // Organic threads get the SAME card. They used to return early with no
    // steps, on the reasoning that only an attributed lead can produce a
    // Meta event — true, but it made the panel appear and disappear between
    // chats for a reason invisible to the agent, and it threw away the
    // internal quality signal on roughly one lead in six.
    //
    // Nothing can leak to Meta as a result: `seedStageConversionEvent`
    // creates an event only `if (attribution)`, so a `yes` here records the
    // answer and seeds nothing. `attributed` is returned so the panel can
    // say so plainly rather than implying these answers shape ad delivery.
    //
    // The cost is one extra indexed read on organic threads, which is what
    // the old early return was saving.
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
      // Was hardcoded `true` while the early return above owned the false
      // case. It drives the panel's "nothing is reported for this lead"
      // copy, so a stuck `true` would tell an agent their answers were
      // tuning ad delivery when nothing was being sent at all.
      attributed: conversation.attribution !== undefined,
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
 * ANY `no` may later be revised to `yes`, and never the reverse — see
 * `StepState.revisable` for why the asymmetry is the honest one. The
 * revision writes a second row rather than editing the first:
 * `leadQualityAnswers` is an append-only log and `latestFor` reads the
 * newest per step, so both the original verdict and the correction survive
 * for reporting.
 *
 * On an ORGANIC conversation this records the answer and sends nothing.
 * That is structural, not a check here: `seedStageConversionEvent` seeds an
 * event only when the conversation carries an `attribution`.
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
    // The exception is `revising` below: a `no` that becomes a `yes` has no
    // event to contradict — none was ever sent — so it seeds that
    // milestone's event for the FIRST time rather than duplicating one.
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

    // The one reversal this card permits, on any step: a recorded `no`
    // replaced by a `yes`. Every judgement here is provisional in a way a
    // `yes` is not — the chat dismissed as junk replies days later, the
    // service turns out to be available, the unpaid deal pays — and a `no`
    // sent nothing, so correcting it contradicts nothing Meta was told.
    //
    // `revisable` is computed in `stepStates`, so the panel and this guard
    // can never disagree about what may be changed. It is false for a
    // `yes`, which Meta has already been told and cannot be un-told, and
    // false for a step with no answer of its own, so this cannot become a
    // way to skip the sequence.
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
