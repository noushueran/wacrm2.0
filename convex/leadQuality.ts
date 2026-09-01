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

/**
 * How long the card waits before re-asking. A `no` on intent/payment means
 * "not yet", not "never" — the lead may well come good — so it returns after
 * a few days rather than never. A dismissal is a shorter snooze because it
 * carries no judgement about the lead at all, only about the moment.
 *
 * `genuine: no` is the exception and is handled in `nextQuestion`: it means
 * "this is not a customer", which does not change with time.
 */
export const NO_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;
export const DISMISS_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export type AnswerRecord = {
  step: QualityStep;
  answer: QualityAnswer;
  at: number;
};

/**
 * Whether the CRM's own stage already implies this step was answered yes.
 *
 * Seeds the machine from reality as well as from its own log, so a lead an
 * agent moved manually to `price_quoted` is never asked "is this a real
 * customer?". Because the card only ever asks about steps that are NOT
 * implied, every transition it applies is forward — which is what makes
 * `neverDowngrade` a second line of defence rather than the only one.
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

/** The latest answer logged for `step`, or null. Rows are append-only, so
 *  "latest" is what the card acts on and the older rows are the trail. */
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
 * The question the card should ask right now, or null for "ask nothing".
 *
 * Pure and total — no clock, no database — so the whole decision table is
 * unit-testable. `now` is passed in for the same reason.
 *
 * Walks the three steps in funnel order and stops at the first one that is
 * neither implied by the CRM stage nor already settled. A step that is
 * awaiting its cooldown stops the walk rather than being skipped: asking
 * "did they pay?" while "are they serious?" is still snoozed would jump the
 * funnel and produce an SQL-less Converted.
 */
export function nextQuestion(input: {
  answers: AnswerRecord[];
  currentStage: FunnelStageKey | null | undefined;
  now: number;
}): QualityStep | null {
  const { answers, currentStage, now } = input;
  // A lost deal is finished. Nothing to ask, nothing to report.
  if (currentStage === "lost") return null;

  for (const step of QUALITY_STEPS) {
    if (stageImplies(currentStage, step)) continue;

    const latest = latestFor(answers, step);
    if (!latest) return step;

    if (latest.answer === "yes") continue;

    if (latest.answer === "no") {
      // "Not a real customer" is not a state that improves with time.
      if (step === "genuine") return null;
      return now >= latest.at + NO_COOLDOWN_MS ? step : null;
    }

    // dismissed
    return now >= latest.at + DISMISS_COOLDOWN_MS ? step : null;
  }

  return null;
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
  }));
}

/**
 * What the inline card should render for one conversation.
 *
 * `"view"` access, not `"own"`: a supervisor reading someone else's thread
 * should see the same state the assigned agent sees. Answering is gated
 * separately and more tightly (see `answer`), so a reader who cannot act
 * gets `canAnswer: false` and the card renders read-only rather than
 * offering buttons that would throw.
 *
 * `step: null` covers every "ask nothing" case — settled, snoozed, lost, or
 * an organic chat — and the card renders nothing at all for it.
 */
export const getCardState = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    step: QualityStep | null;
    canAnswer: boolean;
    /** False for organic chats: the card still would not show, but this
     *  says WHY, so the UI can explain rather than silently vanish. */
    attributed: boolean;
  }> => {
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );

    // Only attributed leads can produce a Meta event, so only they are worth
    // an agent's attention here. Checked before the answer read so an
    // organic thread costs one document, not two.
    const attributed = conversation.attribution !== undefined;
    if (!attributed) {
      return { step: null, canAnswer: false, attributed: false };
    }

    const rows = await ctx.db
      .query("leadQualityAnswers")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();

    const step = nextQuestion({
      answers: toRecords(rows),
      currentStage: conversation.funnel?.stage ?? null,
      now: Date.now(),
    });

    // Mirrors `answer`'s own gate, so the card never offers a button that
    // would throw: agents act on their own threads, supervisors+ on any.
    const canAnswer =
      ctx.role !== "viewer" &&
      (ctx.role === "owner" ||
        ctx.role === "admin" ||
        ctx.role === "supervisor" ||
        conversation.assignedToUserId === ctx.userId);

    return { step, canAnswer, attributed: true };
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
