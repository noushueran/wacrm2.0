// ============================================================
// The follow-up sequence's gate chain. Pure — no I/O, no Date.now(),
// no Convex imports, no Doc<> types. Every input is a plain value the
// caller (the verdict query) assembles from the database; this module
// never touches it directly, which is what makes a twelve-gate chain
// unit-testable without fixtures.
//
// `evaluateSequence` is called at SEND time — the instant we are about
// to hand a lead's conversation a real WhatsApp marketing template.
// P1/P2 only scored and archived; this is the first module in the
// codebase whose wrong answer costs the owner money and their Meta
// account's quality rating. That is why the gates are one function
// with one test per gate, instead of policy spread across the verdict
// query and the send action.
//
// ----------------------------------------------------------------
// THE FIVE-TIER MODEL
// ----------------------------------------------------------------
// The gates are not evaluated in their numbered order (the numbers
// are for traceability against the table further down only). They
// are evaluated in five tiers, each tier fully resolved before the
// next is even looked at:
//
//   1. Lead-level absolute stops — disabled, archived, snoozed,
//      conversation_closed, replied, no_customer_message, opted_out,
//      no_band. Each is a fact about the LEAD ITSELF: a relationship
//      that is over/paused by design, or (no_band) a lead-
//      classification question — "what score band does this lead even
//      fall into" — not a send-capability one. None of these care what
//      else is true about the lead — they win unconditionally. (snoozed
//      is a deliberate human park until a set time — the same kind of
//      fact as archived, not a question of our ability to send right
//      now, which is why it lives here and not in tier 4.)
//
//   2. Activity defers — not_idle_yet, qualification_owns,
//      agent_active. Something or someone is actively engaged with
//      this lead right now. This tier existing at all, ahead of tier
//      3, is a load-bearing part of this file: activity means the
//      lead is ALIVE, and "alive" must defer every later tier,
//      INCLUDING the decision in tier 3 to file the lead away as dead.
//
//   3. Band exhaustion — archive (auto-archive bands) or exhaust
//      (bands that don't auto-archive). Reached only once tier 1 and
//      tier 2 are both clear: the lead is not stopped, and it is
//      genuinely quiet — no idle-timer, qualification, or agent
//      activity holding it open.
//
//   4. Send-capability gates — working_hours_unset, template_unavailable
//      (both `stop`), then outside_hours, daily_cap (both
//      `reschedule`). None of these are facts about the lead; they are
//      facts about OUR ability to send something right now. That is
//      exactly why they run AFTER tier 3: an exhausted band has no
//      current step to send, so "can we send right now" (hours, cap)
//      and "is that step's template approved" are both meaningless for
//      it — there is no step to check working hours or a template
//      against — and must never block archiving/exhausting it.
//
//      WITHIN this tier, the two `stop`-kind gates are checked before
//      the two `reschedule`-kind ones. That ordering is NOT free: tier
//      1 vs. tier 2/3/4 gives "stop beats reschedule" for free by
//      whole-tier separation, but `working_hours_unset` and
//      `template_unavailable` living in the SAME tier as
//      `outside_hours`/`daily_cap` means that guarantee does not carry
//      over automatically — it has to be re-enforced by hand inside
//      this one tier. See the sub-ordering test guarding exactly this.
//
//   5. send.
//
// TIER 2 vs TIER 4 IS THE NON-OBVIOUS SPLIT — a future editor would
// otherwise be tempted to merge "things that aren't a clean go-ahead"
// into one bucket. Don't: not_idle_yet and agent_active are evidence
// about the LEAD (someone is engaged, so don't file it away);
// outside_hours and daily_cap (and now working_hours_unset and
// template_unavailable, alongside them) are evidence about US (we
// can't send this instant, or can't tell if we can, but that has no
// bearing on whether the lead is worth keeping). Losing the tier
// 2/tier 3 split is exactly how a lead the qualification engine is
// actively working gets silently auto-archived because its band
// happens to be exhausted — see the regression tests guarding this
// file's tier-3-vs-tier-2 boundary.
//
// WHY tier 4 (not tier 1) IS WHERE working_hours_unset AND
// template_unavailable LIVE — this is the second correction this file
// has been through, so it is worth spelling out for whoever is tempted
// to move them back:
//
//   An earlier version of this file put both gates in tier 1, ahead of
//   band exhaustion. That made a lead with an exhausted band, but
//   unknown working hours, PERMANENTLY un-archivable: every sweep
//   re-evaluated to `stop: working_hours_unset`, and nothing in this
//   module (or, as far as this module can see, anywhere) ever flips
//   `workingHoursKnown` — so tier 3, whose entire purpose is "this
//   lead is dead, file it," was never reached, forever. A fully dead
//   lead stayed permanently reported as still running.
//
//   `template_unavailable` had the identical bug, and is additionally
//   INCOHERENT for an exhausted band on its own terms: an exhausted
//   band has no current step, so asking "is the non-existent step's
//   template approved" has no real answer — whatever a caller invents
//   (`false` being the natural default) just reproduces the same
//   permanent-stop bug under a different reason string.
//
//   Putting both in tier 4, strictly after tier 3, fixes both: with
//   the band exhausted, tier 3 returns before either send-capability
//   gate is even reached, so this module never has to answer "is the
//   non-existent step's template approved" at all — the question
//   simply never comes up. That is also why the ordering here isn't
//   just a nicety: a future editor who moves these two gates back
//   ahead of tier 3 reintroduces the permanent-stop bug even though
//   every test in isolation would still look reasonable.
//
// (Earlier versions of this file evaluated the twelve gates in raw
// numeric order as one flat sequence of `if`s, then — after a review
// caught that "stop beats reschedule" only held for pairs where the
// stop gate's number happened to be smaller — grouped all `stop`s
// (including working_hours_unset/template_unavailable) and
// archive/exhaust ahead of all `reschedule`s in one pass. That second
// version fixed stop-vs-reschedule but put archiving AHEAD of the
// activity checks. A third version introduced the current tier
// 2/tier 3 split to fix that, but kept working_hours_unset and
// template_unavailable in tier 1 — which is the permanent-un-
// archivable-lead bug described above. This version is the fix for
// that: those two gates moved to tier 4, after band exhaustion.)
//
// Two rules the tests pin hardest, both still true under this model:
//
// 1. `stop` beats `reschedule` when both apply — true across tiers by
//    construction (tier 1 precedes everything; tier 3's archive/
//    exhaust precede tier 4's reschedules), AND, where two `stop`s and
//    two `reschedule`s now share tier 4, true by the explicit
//    stop-before-reschedule sub-ordering inside that tier (see above).
//
// 2. Fail closed on missing information, always as a `stop`, never a
//    silent default:
//      - Unknown working hours (gate 10a, tier 4) — if we don't know
//        the business's hours we do not message their customers.
//      - No customer message on record at all (gate 5a, tier 1,
//        `lastCustomerMessageAt === null`) — if we don't know whether
//        the customer has ever written in, we do not send them a
//        marketing template. (A `null` timestamp used to be treated as
//        "infinitely idle" and sail straight through the old idle
//        check — the exact opposite of fail-closed.)
//      - An unresolvable band (gate 9a, tier 1) and an unapproved
//        template (gate 12, tier 4) are the same shape of decision:
//        missing/broken configuration we refuse to guess our way
//        around — WHEN there is an actual step being considered.
//        (That "when" is exactly why `template_unavailable` sits in
//        tier 4, after exhaustion: an exhausted band has no step to
//        hold this question open for.)
//    Each of these is an explicit owner decision, not an
//    implementation detail, so each gets its own reason string rather
//    than collapsing into a nearby one.
//
//    By contrast, `lastAgentMessageAt === null` (gate 8, tier 2) is a
//    DELIBERATE fail-OPEN: `null` there means "no human agent has ever
//    replied on this conversation", which is the ordinary state for a
//    bot-only thread and must not block the sequence. This is the
//    opposite call from gate 5a's null handling on purpose — see the
//    comment at gate 8 below for why the two nulls mean different
//    things.
//
// Gate-number reference (the table these numbers trace back to is in
// the task brief and the report, not evaluation order — see above):
//   tier 1 — disabled(1) / archived(2) / snoozed (manual override,
//            Task 5) / conversation_closed(3) / replied(4) /
//            no_customer_message(5a) / opted_out(7) / no_band(9a)
//   tier 2 — not_idle_yet(5b) / qualification_owns(6) / agent_active(8)
//   tier 3 — archive/exhaust(9b/9c)
//   tier 4 — working_hours_unset(10a) / template_unavailable(12) /
//            outside_hours(10b) / daily_cap(11)
// ============================================================

import type { BandRule } from "./bands";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const STOP_REASONS = [
  "disabled", // gate 1 — the feature was switched off
  "archived", // gate 2, or the sequence's own auto-archive
  "snoozed", // a human parked this thread until a set time
  "conversation_closed", // gate 3
  "replied", // gate 4 — the customer came back
  "no_customer_message", // gate 5a — fail-closed, owner decision
  "opted_out", // gate 7
  "no_band", // gate 9a — score outside every configured band
  "working_hours_unset", // gate 10a — fail-closed, owner decision
  "template_unavailable", // gate 12 — Meta rejected or paused it
  "manual", // a human pulled the lead out (Task 9)
  // Fix 3 (whole-branch review, "a parameterised template silently
  // burns the cadence"): `sendSequenceStep` (`leadAnalysisEngine.ts`)
  // sets this when `metaSend.sendTemplate` throws AFTER a successful
  // claim — e.g. a template whose body needs `params` the sequence's
  // fixed-body send never supplies (Meta error 132000). Never produced
  // by `evaluateSequence` itself (this gate chain has no send-failure
  // input to react to) — it exists so the lead stops loudly instead of
  // silently re-attempting, and failing, the identical send at every
  // future step.
  "send_failed",
] as const;

export const RESCHEDULE_REASONS = [
  "not_idle_yet", // gate 5b
  "qualification_owns", // gate 6
  "agent_active", // gate 8
  "outside_hours", // gate 10b
  "daily_cap", // gate 11
] as const;

export type StopReason = (typeof STOP_REASONS)[number];
export type RescheduleReason = (typeof RESCHEDULE_REASONS)[number];

export type SequenceVerdict =
  | { kind: "send"; stepIndex: number }
  | { kind: "reschedule"; reason: RescheduleReason }
  | { kind: "stop"; reason: StopReason }
  | { kind: "exhaust" }
  | { kind: "archive" };

/**
 * The qualification flow's own follow-up budget. While it is still
 * "collecting" answers and hasn't spent its own follow-ups, it owns
 * the clock — the marketing sequence must not talk over it. Once that
 * budget is spent (or the session isn't "collecting" at all), the
 * clock releases and the sequence's own gates decide.
 */
export interface QualificationState {
  status: string;
  followUpsSent: number;
  maxFollowUps: number;
}

/**
 * Plain data the verdict query assembles for one conversation. No
 * `Doc<>`, no lazy getters — every gate reads a value that's already
 * been resolved by the caller (e.g. `band` is the rule already picked
 * for this lead's score, not the score itself).
 */
export interface EligibilityInput {
  now: number;
  enabled: boolean;
  archived: boolean;
  snoozed: boolean;
  conversationStatus: string;
  lastMessageSenderType: string;
  lastCustomerMessageAt: number | null;
  lastAgentMessageAt: number | null;
  idleDaysBeforeSequence: number;
  humanQuietHours: number;
  qualification: QualificationState | null;
  optedOut: boolean;
  band: BandRule | null;
  followUpsSent: number;
  lastFollowUpAt: number | null;
  workingHoursKnown: boolean;
  withinWorkingHours: boolean;
  dailyCapReached: boolean;
  templateApproved: boolean;
}

/**
 * The twelve-gate chain, evaluated in five tiers (lead-level absolute
 * stops → activity defers → band exhaustion → send-capability gates →
 * send), each tier fully resolved before the next is examined. See the
 * header comment for the full model, why tier 2 must sit between tier
 * 1 and tier 3, and why working_hours_unset/template_unavailable live
 * in tier 4 rather than tier 1.
 */
export function evaluateSequence(input: EligibilityInput): SequenceVerdict {
  // ---------------------------------------------------------------
  // Tier 1 — lead-level absolute stops. Win unconditionally; nothing
  // later in this function is even inspected once one of these fires.
  // ---------------------------------------------------------------

  // Gate 1 — the feature is off for this account.
  if (!input.enabled) return { kind: "stop", reason: "disabled" };

  // Gate 2 — the conversation itself is archived.
  if (input.archived) return { kind: "stop", reason: "archived" };

  // A human parked this thread until a set time. Same shape of fact as
  // archived — a lead-level state, not a question of our ability to
  // send right now — so it sits here in tier 1, not with the
  // send-capability gates in tier 4.
  if (input.snoozed) return { kind: "stop", reason: "snoozed" };

  // Gate 3 — the conversation is closed.
  if (input.conversationStatus === "closed") {
    return { kind: "stop", reason: "conversation_closed" };
  }

  // Gate 4 — the customer, not the agent, sent the most recent message.
  if (input.lastMessageSenderType === "customer") {
    return { kind: "stop", reason: "replied" };
  }

  // Gate 5a — we have no record of the customer ever messaging in.
  // Fail closed exactly like gate 10a's unknown-hours case: sending
  // here means a marketing template to someone who never contacted
  // the business. Must be checked here, before tier 2's idle-duration
  // math, because "idle for how long" is meaningless (and must not
  // silently resolve to "forever idle") when there is no timestamp to
  // measure from.
  if (input.lastCustomerMessageAt === null) {
    return { kind: "stop", reason: "no_customer_message" };
  }

  // Gate 7 — the customer opted out of marketing messages.
  if (input.optedOut) return { kind: "stop", reason: "opted_out" };

  // Gate 9a — no band at all is a stop: we refuse to guess a cadence.
  // This is a lead-classification fact ("what band does this score map
  // to at all"), not a send-capability one, which is why it stays in
  // tier 1 rather than moving to tier 4 with the other two former
  // tier-1 gates. (Whether a *resolved* band's steps are exhausted is
  // tier 3's job, not this gate's — this only rules out the band
  // being unresolvable in the first place.)
  if (input.band === null) return { kind: "stop", reason: "no_band" };

  // ---------------------------------------------------------------
  // Tier 2 — activity defers. Someone/something is actively engaged
  // with this lead. This must defer EVERYTHING after it, including
  // tier 3's decision to archive — an active lead is not a dead one.
  // ---------------------------------------------------------------

  // Gate 5b — not idle long enough since the customer's last message.
  // `lastCustomerMessageAt` is guaranteed non-null here: gate 5a above
  // already returned for the null case.
  const idleMs = input.now - input.lastCustomerMessageAt;
  if (idleMs < input.idleDaysBeforeSequence * DAY) {
    return { kind: "reschedule", reason: "not_idle_yet" };
  }

  // Gate 6 — the qualification flow still owns the clock: it's
  // actively collecting and hasn't spent its own follow-up budget.
  if (
    input.qualification !== null &&
    input.qualification.status === "collecting" &&
    input.qualification.followUpsSent < input.qualification.maxFollowUps
  ) {
    return { kind: "reschedule", reason: "qualification_owns" };
  }

  // Gate 8 — a human agent is actively handling this conversation.
  // DELIBERATE fail-OPEN on `null`: unlike gate 5a's customer
  // timestamp, a `null` `lastAgentMessageAt` means "no agent has ever
  // replied on this thread" — the normal, expected state for a
  // bot-handled conversation, not a data gap. Treating it as "agent
  // recently active" would block every bot-only lead's sequence
  // forever, so `null` here resolves to "not recently active"
  // (`Infinity` ms since), the opposite choice from gate 5a on purpose.
  const sinceAgentMs =
    input.lastAgentMessageAt === null
      ? Infinity
      : input.now - input.lastAgentMessageAt;
  if (sinceAgentMs < input.humanQuietHours * HOUR) {
    return { kind: "reschedule", reason: "agent_active" };
  }

  // ---------------------------------------------------------------
  // Tier 3 — band exhaustion. Reached only once the lead is stopped
  // nowhere in tier 1 and genuinely quiet on every tier-2 activity
  // signal. Ends the sequence (archive or exhaust) exactly like a
  // tier-1 stop would, just as its own verdict kind rather than
  // `stop`. Deliberately checked BEFORE tier 4: an exhausted band has
  // no current step, so neither send-capability gate below has
  // anything meaningful to say about it.
  // ---------------------------------------------------------------

  // Gate 9b/9c — a resolved band whose steps are exhausted either
  // auto-archives the lead, or — for a band that doesn't auto-archive
  // — exhausts without archiving.
  if (input.followUpsSent >= input.band.steps.length) {
    return input.band.autoArchive ? { kind: "archive" } : { kind: "exhaust" };
  }

  // ---------------------------------------------------------------
  // Tier 4 — send-capability gates. Facts about OUR ability to send
  // right now, not about the lead — reached only once tier 3 has
  // confirmed there IS a current step to send. The two `stop`-kind
  // gates are checked first, then the two `reschedule`-kind ones:
  // that ordering is not automatic here (unlike the whole-tier
  // separation everywhere else in this function) because all four
  // gates share this one tier, so it is enforced explicitly by
  // listing them in this order.
  // ---------------------------------------------------------------

  // Gate 10a — unknown working hours fail closed: stop, never a
  // default, never a reschedule guess.
  if (!input.workingHoursKnown) {
    return { kind: "stop", reason: "working_hours_unset" };
  }

  // Gate 12 — the template this step would send isn't approved.
  if (!input.templateApproved) {
    return { kind: "stop", reason: "template_unavailable" };
  }

  // Gate 10b — known hours, but outside them right now.
  if (!input.withinWorkingHours) {
    return { kind: "reschedule", reason: "outside_hours" };
  }

  // Gate 11 — the account's daily send cap is already reached today.
  if (input.dailyCapReached) return { kind: "reschedule", reason: "daily_cap" };

  // ---------------------------------------------------------------
  // Tier 5 — send.
  // ---------------------------------------------------------------
  return { kind: "send", stepIndex: input.followUpsSent };
}
