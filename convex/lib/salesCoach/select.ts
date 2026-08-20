/**
 * Sales coach — which threads are worth reviewing, and the one metric
 * that must never be left to the model.
 *
 * Pure, so both carry unit tests without a ctx.
 */

export interface SalesCoachConfig {
  enabled: boolean;
  threadsPerRun: number;
  minMessages: number;
  lookbackDays: number;
}

/** Off by default, like every agent here. */
export const DEFAULT_SALES_COACH_CONFIG: SalesCoachConfig = {
  enabled: false,
  threadsPerRun: 15,
  minMessages: 4,
  lookbackDays: 30,
};

export type CoachSkipReason =
  | "not_assigned"
  | "too_few_messages"
  | "too_old"
  | "already_reviewed"
  | "no_human_turn";

export interface CoachCandidate {
  /** Null when nobody owns the thread — there is no one to coach. */
  assignedToUserId: string | null;
  messageCount: number;
  /** `_creationTime` of the newest message in the thread. */
  lastMessageAt: number;
  /** `reviewedThroughMs` of the newest existing review, if any. */
  reviewedThroughMs: number | null;
  /** False when only the bot and the customer ever spoke. */
  hasHumanTurn: boolean;
}

/**
 * Why this thread is not worth reviewing, or null when it is.
 *
 * `hasHumanTurn` matters more than it looks: 1,198 of this account's
 * conversations are assigned to someone, but assignment alone does not
 * mean a person ever typed. Coaching someone on a thread the bot handled
 * end to end would be blaming them for work they never did.
 */
export function coachSkipReason(
  input: CoachCandidate,
  config: SalesCoachConfig,
  now: number,
): CoachSkipReason | null {
  if (!input.assignedToUserId) return "not_assigned";
  if (!input.hasHumanTurn) return "no_human_turn";
  if (input.messageCount < config.minMessages) return "too_few_messages";
  if (now - input.lastMessageAt > config.lookbackDays * 86_400_000) return "too_old";
  // Re-review only once the thread has actually moved on, so a sweep
  // does not re-judge the same conversation every night.
  if (
    input.reviewedThroughMs !== null &&
    input.reviewedThroughMs >= input.lastMessageAt
  ) {
    return "already_reviewed";
  }
  return null;
}

export interface TurnLike {
  /** "customer" | "agent" | "bot" */
  senderType: string;
  at: number;
}

/**
 * Minutes between the customer's last unanswered message and the first
 * HUMAN reply after it. Null when no human ever replied.
 *
 * Computed here, never asked of the model. It is a plain arithmetic fact
 * about timestamps, and a model asked to estimate it would produce a
 * number that looks authoritative and is not — which matters especially
 * for a metric attached to a named person's name.
 *
 * Bot replies are ignored on purpose: the auto-reply answers instantly,
 * so counting it would make every response time look perfect.
 */
export function firstHumanResponseMinutes(turns: TurnLike[]): number | null {
  const ordered = [...turns].sort((a, b) => a.at - b.at);
  let awaitingSince: number | null = null;

  for (const turn of ordered) {
    if (turn.senderType === "customer") {
      // Only the FIRST unanswered customer message starts the clock.
      if (awaitingSince === null) awaitingSince = turn.at;
      continue;
    }
    if (turn.senderType === "agent" && awaitingSince !== null) {
      return Math.max(0, Math.round((turn.at - awaitingSince) / 60_000));
    }
    // A bot reply neither answers for the human nor resets the clock.
  }
  return null;
}
