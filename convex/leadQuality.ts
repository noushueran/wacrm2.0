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
import { applyStageTransition } from "./funnel";
import { FUNNEL_STAGE_KEYS, type FunnelStageKey } from "./lib/funnel";

/** The three milestones an agent can attest to, in funnel order. */
export const QUALITY_STEPS = ["genuine", "intent", "payment"] as const;
export type QualityStep = (typeof QUALITY_STEPS)[number];

export type QualityAnswer = "yes" | "no" | "dismissed";

/**
 * Which funnel stage a positive answer advances to. The question and the
 * stage are deliberately different vocabularies — "Is this a real customer?"
 * is answerable mid-chat, "Qualified lead" is not — and this map is the only
 * place the two are joined.
 */
export const STEP_STAGE: Record<QualityStep, FunnelStageKey> = {
  genuine: "qualified",
  intent: "price_quoted",
  payment: "purchased",
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
 * `locked` is the whole point of the redesign: an answered question is
 * answered for good. The Meta event it produced can only fire once (the
 * outbox dedups on `${conversationId}:${stage}`), so offering the buttons
 * again would invite a click that silently does nothing — the panel says
 * "recorded" instead.
 *
 * `viaStage` distinguishes "an agent answered this here" from "the CRM
 * stage already passed this milestone". Both lock the step; only the first
 * has an author and a timestamp to show.
 */
export type StepState = {
  step: QualityStep;
  locked: boolean;
  answer: "yes" | "no" | null;
  viaStage: boolean;
  value?: number;
  currency?: string;
  answeredAt?: number;
};

/**
 * Every step's state at once — the panel shows all three and lets an agent
 * answer whichever they can, whenever they can.
 *
 * This replaced a strictly progressive one-question-at-a-time machine. The
 * pacing was wrong in practice: a salesperson often learns "they're serious"
 * and "they paid" in the same conversation, and forcing the second answer to
 * wait on a cooldown after the first meant the information was known and
 * unrecordable. Independent steps also mean a skipped middle question never
 * blocks the one that matters most.
 *
 * Pure and total — no clock, no database — so the table is unit-testable.
 */
export function stepStates(input: {
  answers: AnswerRecord[];
  currentStage: FunnelStageKey | null | undefined;
}): StepState[] {
  return QUALITY_STEPS.map((step) => {
    const implied = stageImplies(input.currentStage, step);
    const latest = latestFor(input.answers, step);
    // A dismissal is not an answer; it never locks a step.
    const explicit =
      latest && (latest.answer === "yes" || latest.answer === "no")
        ? latest
        : null;

    if (explicit) {
      return {
        step,
        locked: true,
        answer: explicit.answer as "yes" | "no",
        viaStage: false,
        ...(explicit.value !== undefined
          ? { value: explicit.value, currency: explicit.currency }
          : {}),
        answeredAt: explicit.at,
      };
    }
    if (implied) {
      return { step, locked: true, answer: "yes" as const, viaStage: true };
    }
    return { step, locked: false, answer: null, viaStage: false };
  });
}

const stepValidator = v.union(
  v.literal("genuine"),
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

    // Answer once. The Meta event a `yes` produces can only fire once (the
    // outbox dedups on `${conversationId}:${stage}`), so a second answer
    // could never reach Meta and would only make the log disagree with what
    // was actually reported. Enforced server-side rather than by hiding the
    // buttons, because the panel is a live view that another agent may have
    // answered from a second later.
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
    if (
      args.answer !== "dismissed" &&
      priorStates.find((st) => st.step === step)?.locked
    ) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: "already_answered",
      });
    }

    const account = await ctx.db.get(ctx.accountId);
    const currency = args.currency ?? account?.defaultCurrency ?? "USD";

    let conversionEventId: Id<"conversionEvents"> | undefined;
    if (args.answer === "yes") {
      const stage = STEP_STAGE[step];
      await applyStageTransition(ctx, {
        accountId: ctx.accountId,
        conversation,
        stage,
        byUserId: ctx.userId,
        auto: false,
        // The card only asks about steps the stage does not already imply,
        // so this is always forward. Passed anyway: a future caller reaching
        // this mutation out of order must not walk a lead backwards.
        neverDowngrade: true,
        ...(step === "payment"
          ? { saleValue: args.value, saleCurrency: currency }
          : {}),
        defaultCurrency: account?.defaultCurrency ?? "USD",
      });
      // Looked up rather than returned by `applyStageTransition`, which
      // reports only whether it applied. An existing row is the right answer
      // too: it means this milestone was already reported, and linking it
      // records that this answer did not double-send.
      const seeded = await ctx.db
        .query("conversionEvents")
        .withIndex("by_event_id", (q) =>
          q.eq("eventId", `${args.conversationId}:${stage}`),
        )
        .first();
      conversionEventId = seeded?._id;
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
