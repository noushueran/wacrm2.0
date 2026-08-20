/**
 * Revival agent — who is worth chasing, and whether a queued draft is
 * still safe to send.
 *
 * Pure (no ctx, no `_generated` imports) so both decisions carry unit
 * tests, the same reason `cronSummary.ts` and `agentRegistry.ts` are.
 *
 * These two functions are the whole safety story of this feature: one
 * decides who we may write to, the other is re-run at send time so a
 * draft that sat in a queue can never go out into circumstances that
 * changed while it waited.
 */

/**
 * Meta's customer-service window.
 *
 * NOT `qualificationConfigs.sessionWindowHours` (72), which is an
 * internal lane setting. Confusing the two would push free text into a
 * shut window and have the Cloud API reject it — so the 24h rule lives
 * here, once, and every caller reads it from this constant.
 */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RevivalConfig {
  enabled: boolean;
  minQuietMinutes: number;
  windowSafetyMinutes: number;
  cooldownHours: number;
  draftsPerRun: number;
  dailyDraftCap: number;
  minLeadScore: number;
}

/** `enabled: false` is the load-bearing default — an account that has
 *  never configured the agent gets no drafts and no provider calls. */
export const DEFAULT_REVIVAL_CONFIG: RevivalConfig = {
  enabled: false,
  minQuietMinutes: 180,
  windowSafetyMinutes: 60,
  cooldownHours: 72,
  draftsPerRun: 20,
  dailyDraftCap: 50,
  minLeadScore: 0,
};

/**
 * Bounds on every configurable number, enforced server-side.
 *
 * These are not cosmetic. `minQuietMinutes` below ~30 would chase
 * someone who paused mid-conversation; `windowSafetyMinutes` at 0 lets a
 * draft be approved into a window that shuts mid-flight; a
 * `cooldownHours` of 0 would let the same lead be nudged every sweep.
 */
export const REVIVAL_BOUNDS: Record<string, { min: number; max: number }> = {
  // 30 minutes is the floor for "they have actually stopped replying",
  // and the ceiling is the window itself — beyond it nothing qualifies.
  minQuietMinutes: { min: 30, max: 23 * 60 },
  windowSafetyMinutes: { min: 15, max: 12 * 60 },
  cooldownHours: { min: 1, max: 24 * 30 },
  draftsPerRun: { min: 1, max: 100 },
  dailyDraftCap: { min: 1, max: 500 },
  // `leadAnalyses.score` is 1–10. 0 means "no floor".
  minLeadScore: { min: 0, max: 10 },
};

/**
 * The first bounds violation in a config patch, or null when it is safe
 * to persist. Pure so it is tested without a ctx, and shared by the
 * mutation rather than duplicated there.
 */
export function configPatchError(
  patch: Record<string, unknown>,
): { key: string; min: number; max: number } | null {
  for (const [key, bounds] of Object.entries(REVIVAL_BOUNDS)) {
    const value = patch[key];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < bounds.min ||
      value > bounds.max
    ) {
      return { key, ...bounds };
    }
  }
  return null;
}

export type SkipReason =
  | "awaiting_our_reply"
  | "too_recent"
  | "window_closing"
  | "snoozed"
  | "do_not_contact"
  | "archived"
  | "opted_out"
  | "qualification_active"
  | "cooldown"
  | "score_too_low"
  | "customer_replied"
  | "expired"
  | "already_actioned";

export interface CandidateInput {
  lastMessageAt: number;
  /**
   * True when the CUSTOMER spoke last — which disqualifies the lead.
   *
   * This reads backwards until you picture the thread. A stalled lead is
   * one where WE spoke last and they never came back; if they spoke
   * last, they are waiting on US, and "still thinking about it?" is an
   * absurd thing to send someone whose question is unanswered.
   *
   * The original spec had this inverted, and with auto-reply on — where
   * the bot answers every inbound message and therefore always has the
   * last word — it matched 0 of 77 otherwise-eligible conversations in
   * production. The agent would have drafted nothing, forever.
   */
  lastMessageInbound: boolean;
  snoozedUntil: number | null;
  doNotContact: boolean;
  archived: boolean;
  /**
   * They told us to stop.
   *
   * SEPARATE from `doNotContact`, and both must be checked. An opt-out
   * detected by the qualification engine sets the session to `opted_out`
   * and `conversation.aiAutoreplyDisabled`, but it does NOT write
   * `contacts.doNotContact` — that field is only set from a human
   * writing a note. Checking only one of the two would chase the exact
   * people who asked us not to.
   */
  optedOut: boolean;
  /**
   * The qualification engine has this lead AND will actually nudge it.
   *
   * BOTH halves matter. Deferring on `status === "collecting"` alone is
   * what put 280 production leads in limbo: they each had a follow-up
   * armed, but `qualificationConfigs.outboundNudgesEnabled` was false,
   * so that engine's sweep found them and sent nothing — while this one
   * stepped politely aside. Defer only to an engine that will act.
   */
  qualificationWillNudge: boolean;
  /** `createdAt` of the most recent draft for this conversation, ANY status. */
  lastDraftAt: number | null;
  /** Null when the lead has never been scored — not the same as zero. */
  leadScore: number | null;
}

/**
 * Why this conversation is not worth a draft right now, or null when it
 * is. Order affects only which reason gets reported; the checks are
 * independent.
 *
 * `leadScore: null` deliberately passes the score floor. An unscored
 * lead is not a low-scoring one, and excluding it would quietly make the
 * whole feature depend on Lead Analysis being switched on.
 */
export function candidateSkipReason(
  input: CandidateInput,
  config: RevivalConfig,
  now: number,
): SkipReason | null {
  // They spoke last, so the ball is in OUR court — that is an unanswered
  // message for the inbox, not a lead to chase.
  if (input.lastMessageInbound) return "awaiting_our_reply";
  if (input.doNotContact) return "do_not_contact";
  if (input.optedOut) return "opted_out";
  if (input.archived) return "archived";
  if (input.snoozedUntil !== null && input.snoozedUntil > now) return "snoozed";
  if (input.qualificationWillNudge) return "qualification_active";

  const quietMs = now - input.lastMessageAt;
  if (quietMs < config.minQuietMinutes * 60_000) return "too_recent";

  // The margin is what makes a QUEUED draft safe: a human may not tap
  // send for a while, and a message landing after the window shuts is
  // rejected outright.
  const latestUsable = WINDOW_MS - config.windowSafetyMinutes * 60_000;
  if (quietMs >= latestUsable) return "window_closing";

  if (
    input.lastDraftAt !== null &&
    now - input.lastDraftAt < config.cooldownHours * 3_600_000
  ) {
    return "cooldown";
  }

  if (input.leadScore !== null && input.leadScore < config.minLeadScore) {
    return "score_too_low";
  }

  return null;
}

export interface SendCheckInput extends CandidateInput {
  status: "pending" | "sent" | "dismissed" | "expired";
  expiresAt: number;
  /** When the draft was created; anything newer from the customer wins. */
  draftedAt?: number;
}

/**
 * Re-run at send time, never trusted from draft time. A draft can sit in
 * the queue for hours, and in that time the customer may reply, the
 * thread may be snoozed or marked do-not-contact, or the window may shut.
 *
 * Extends `CandidateInput` on purpose: sharing the shape is what stops
 * the send path and the selection path drifting apart.
 */
export function sendBlockReason(
  input: SendCheckInput,
  now: number,
): SkipReason | null {
  if (input.status !== "pending") return "already_actioned";
  if (input.expiresAt <= now) return "expired";
  if (input.doNotContact) return "do_not_contact";
  // Checked here too, not only at selection: someone can opt out in the
  // hours between a draft being queued and a human tapping send, and
  // that is precisely when it matters most.
  if (input.optedOut) return "opted_out";
  if (input.archived) return "archived";
  if (input.snoozedUntil !== null && input.snoozedUntil > now) return "snoozed";

  // They answered while the draft waited — sending now talks over them.
  if (input.draftedAt !== undefined && input.lastMessageAt > input.draftedAt) {
    return "customer_replied";
  }

  // Belt and braces against a bad `expiresAt`: that column is derived
  // data, the 24h rule is the law.
  if (now - input.lastMessageAt >= WINDOW_MS) return "expired";

  return null;
}
