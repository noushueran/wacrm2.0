// ============================================================
// The lead-quality state machine, as pure data.
//
// Split out of `convex/leadQuality.ts` so `conversations.list` can compute
// each row's progress badge without importing that module — which pulls in
// `lib/auth`, `lib/conversationAccess` and `funnel`, and would make the
// inbox list query depend on the whole answering path just to render a
// chip. Same reason `lib/reportStats.ts` sits beside `reports.ts`.
//
// Nothing here touches `ctx`, the database or the clock, so the whole
// decision table stays unit-testable with object literals.
// ============================================================

import { FUNNEL_STAGE_KEYS, type FunnelStageKey } from "./funnel";

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
 * for ANY step answered `no`, and only in that one direction.
 *
 * The asymmetry is the whole rule, and it comes straight from what each
 * answer did. A `no` sent NOTHING — there is no code path from it to the
 * outbox — so changing it later contradicts nothing Meta was ever told; it
 * simply reports a milestone for the first time. A `yes` already put an
 * event on the wire, and Meta has no retraction, so un-saying it could only
 * make this log disagree with what was actually reported.
 *
 * Every one of these judgements is provisional in the way a `yes` is not.
 * An agent marks a chat "not a real customer" and the customer replies
 * three days later; a service looks unavailable until someone checks; a
 * lead reads as browsing until they ask to book; a deal is unpaid until it
 * is paid. Before this, each of those `no`s was permanent and its event was
 * stranded forever — which is precisely the lead quality Meta is supposed
 * to be learning from.
 *
 * Revising re-opens what the `no` had closed: `stepStates` derives the
 * whole sequence from the log, so flipping a `no` to `yes` makes the next
 * question available again with no special handling.
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
  /** A recorded `no` here may still be replaced by a `yes`. Never a `yes`. */
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
 * It ends it PROVISIONALLY. Because the whole table is derived from the
 * log, correcting a `no` to a `yes` re-opens the question after it by
 * itself — the gate simply computes differently on the next read. Nothing
 * here special-cases a revision, which is why the sequence cannot be left
 * half-open by one.
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

    // Any `no` can be un-said, in one direction only. An implied lock is
    // never revisable: implication only ever yields a `yes`, and a `yes` is
    // final. `explicit` is required, so a step that is merely BLOCKED (an
    // earlier `no` closed the gate before it) has nothing to revise —
    // revision corrects an answer, it does not skip the sequence.
    const revisable = explicit?.answer === "no";

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

/** How many questions the panel asks. Exported so the list badge's
 *  denominator and the panel's own "n/total" cannot drift apart. */
export const QUALITY_STEP_COUNT = QUALITY_STEPS.length;

/**
 * One conversation's lead-quality progress, small enough to sit on every
 * row of the inbox list.
 *
 * `pending` is what the thread panel badges, so the two agree by
 * construction rather than by two similar-looking expressions.
 *
 * `ended` means a recorded `no` stands with nothing open behind it. It is
 * NOT "finished": the `no` is correctable, so an ended row is still
 * actionable — it just is not waiting on an unanswered question. The list
 * needs the distinction to avoid nagging with a count of questions that
 * cannot currently be answered.
 */
export type LeadQualitySummary = {
  answered: number;
  pending: number;
  total: number;
  ended: boolean;
};

export function summarizeSteps(steps: StepState[]): LeadQualitySummary {
  const answered = steps.filter((s) => s.locked).length;

  // A recorded `no` ENDS the sequence, so the questions behind it are not
  // merely unanswered — they will never be asked. Every one of them
  // presupposes the `no` was a yes: there is no sense in asking whether a
  // lead is serious about booking once it is not a real customer.
  //
  // This is the whole reason `pending` is not `steps.filter(s => !s.locked)`.
  // That count was the first thing shipped and it was wrong in the one case
  // that matters most: a lead rejected at question one reported THREE
  // outstanding answers that nobody could give, on both the thread badge
  // and the list row. It also silently defeated the "stopped" styling,
  // which keys on `pending === 0` and so could never fire.
  //
  // Steps not yet REACHED still count. On an untouched lead all four are
  // outstanding even though only the first is answerable right now — they
  // are ahead on the path, not cut off from it.
  const stopped = steps.some((s) => s.locked && s.answer === "no");

  return {
    answered,
    pending: stopped ? 0 : steps.filter((s) => !s.locked).length,
    total: steps.length,
    // Stopped BEFORE the end. A `no` on the last question leaves nothing
    // outstanding and nothing cut off, so it is an ordinary finished lead.
    ended: stopped && answered < steps.length,
  };
}
