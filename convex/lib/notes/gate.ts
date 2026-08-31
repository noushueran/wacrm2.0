// ============================================================
// The one predicate every outbound-to-customer path consults, so they
// cannot drift from each other. As of this writing the real call sites
// are:
//
//   - `aiReply.ts`'s `loadDispatchContext` — feeds `dispatchInbound`,
//     `ackInbound`, AND `deliverReply` (the last one re-checks it at
//     send time to close the generation-delay race, not just at dispatch)
//   - `apiV1.ts`'s `sendMessage` — the public REST single-message send;
//     rejects outright rather than silently no-op'ing (a bulk send can
//     drop-and-report, a single send has to say so)
//   - `automationsEngine.ts`'s `runForTrigger` AND `resume` (the second
//     re-checks independently — a `wait` step can suspend for days)
//   - `broadcasts.ts`'s `create`, `createInternal`, AND `deliverOne`
//     (all three ALSO consult `optedOutReason` below — see it for why
//     the contact field alone is not the whole gate)
//   - `flowsEngine.ts`'s step-start and per-step send
//   - `inboxChaseAssign.ts`'s auto-assignment sweep
//   - `leadAnalysisEngine.ts` — folds it into a session's `optedOut`
//     read so archiving/scoring treats a blocked contact as opted out
//   - `qualificationEngine.ts`'s `followUpContext`, `closingContext`,
//     `answerContext`, AND `announceContext` (the last one gates ONLY
//     the customer-facing half of the assignment announcement — the
//     agent still has to be told the lead is theirs)
//
// Staff-facing sends (admin alerts, staff relays, lead-offer pings,
// staff reminder loops) are DELIBERATELY excluded — this predicate
// governs messages TO THE CUSTOMER who set the flag, not messages to
// the team about them. A comment that undercounts these call sites is
// how the next person concludes a path is already covered when it
// isn't — keep this list honest as call sites are added or moved.
// ============================================================

export type OutboundBlockReason = "do_not_contact" | "opted_out";

/**
 * Whether this contact told the BOT to stop.
 *
 * A second, separate wish from `contacts.doNotContact`, recorded by a
 * different path and never denormalised onto the contact: when the
 * qualification engine classifies an inbound message as `opt_out`, it
 * sets `qualificationSessions.status = "opted_out"`. Nothing writes
 * `doNotContact`, which is only ever set by a human writing a note. A
 * gate that checks one and not the other messages the exact people who
 * asked it not to.
 *
 * `conversations.aiAutoreplyDisabled` is deliberately NOT consulted.
 * That flag is overloaded across three unrelated meanings — an agent
 * pausing AI to take a thread over (`conversations.setAiPaused`), a
 * staff-initiated outbound thread, and a genuine opt-out — so treating
 * it as consent withdrawal would silently drop every human-handled lead
 * from broadcasts, which are the most engaged leads there are.
 */
export function optedOutReason(
  session: { status?: string } | null | undefined,
): OutboundBlockReason | null {
  return session?.status === "opted_out" ? "opted_out" : null;
}

/**
 * Whether an automated message may be sent to this contact.
 *
 * FAILS CLOSED: a null/undefined contact is treated as blocked. Every
 * caller resolves the contact from an id that can race a delete, and
 * "the row wasn't there so we sent anyway" is the one failure mode this
 * feature cannot have. Silence is recoverable; a message to someone who
 * asked you to stop is not.
 *
 * Humans are NOT gated by this — an agent who opens the thread and types
 * has seen the banner and made a decision. Machines are stopped; people
 * are informed.
 */
export function blockedReason(
  contact: { doNotContact?: unknown } | null | undefined,
): OutboundBlockReason | null {
  if (!contact) return "do_not_contact";
  return contact.doNotContact ? "do_not_contact" : null;
}
