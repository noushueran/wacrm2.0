import { expect, test } from "vitest";
import {
  evaluateSequence,
  STOP_REASONS,
  RESCHEDULE_REASONS,
  type EligibilityInput,
} from "./eligibility";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 6, 20, 8, 0); // Mon 12:00 Gulf

/** A lead that SHOULD send: quiet 5 days, warm band, everything clear. */
function ok(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    now: NOW,
    enabled: true,
    archived: false,
    snoozed: false,
    conversationStatus: "open",
    lastMessageSenderType: "agent",
    lastCustomerMessageAt: NOW - 5 * DAY,
    lastAgentMessageAt: NOW - 5 * DAY,
    idleDaysBeforeSequence: 3,
    humanQuietHours: 24,
    qualification: null,
    optedOut: false,
    band: {
      key: "warm",
      minScore: 4,
      maxScore: 7,
      autoArchive: true,
      steps: [
        { delayDays: 3, templateName: "nudge_1" },
        { delayDays: 7, templateName: "nudge_2" },
      ],
    },
    followUpsSent: 0,
    lastFollowUpAt: null,
    workingHoursKnown: true,
    withinWorkingHours: true,
    dailyCapReached: false,
    templateApproved: true,
    ...over,
  };
}

test("a clear lead sends step 0", () => {
  expect(evaluateSequence(ok())).toEqual({ kind: "send", stepIndex: 0 });
});

test("gate 1 — disabled stops", () => {
  expect(evaluateSequence(ok({ enabled: false })).kind).toBe("stop");
});

test("gate 2 — archived stops", () => {
  expect(evaluateSequence(ok({ archived: true })).kind).toBe("stop");
});

test("a snoozed conversation stops (tier 1, beside archived)", () => {
  expect(evaluateSequence(ok({ snoozed: true })).kind).toBe("stop");
  expect(evaluateSequence(ok({ snoozed: true }))).toEqual({
    kind: "stop",
    reason: "snoozed",
  });
});

test("stop beats reschedule: snoozed over outside hours (gate 10) — a tier-1 fact about the lead wins over a tier-4 fact about our ability to send", () => {
  expect(
    evaluateSequence(ok({ snoozed: true, withinWorkingHours: false })),
  ).toEqual({ kind: "stop", reason: "snoozed" });
});

test("tier ordering — snoozed (tier 1) beats an exhausted band's archive (tier 3)", () => {
  expect(
    evaluateSequence(ok({ snoozed: true, followUpsSent: 2 })),
  ).toEqual({ kind: "stop", reason: "snoozed" });
});

test("gate 3 — a closed conversation stops", () => {
  expect(evaluateSequence(ok({ conversationStatus: "closed" })).kind).toBe("stop");
});

test("gate 4 — the customer having replied last stops, never reschedules", () => {
  const v = evaluateSequence(ok({ lastMessageSenderType: "customer" }));
  expect(v.kind).toBe("stop");
});

test("gate 5 — not idle long enough reschedules rather than stopping", () => {
  const v = evaluateSequence(ok({ lastCustomerMessageAt: NOW - 1 * DAY }));
  expect(v.kind).toBe("reschedule");
});

test("gate 6 — a collecting session with follow-ups left reschedules", () => {
  const v = evaluateSequence(
    ok({ qualification: { status: "collecting", followUpsSent: 1, maxFollowUps: 4 } }),
  );
  expect(v.kind).toBe("reschedule");
});

test("gate 6 — a collecting session that spent its budget RELEASES the clock", () => {
  const v = evaluateSequence(
    ok({ qualification: { status: "collecting", followUpsSent: 4, maxFollowUps: 4 } }),
  );
  expect(v).toEqual({ kind: "send", stepIndex: 0 });
});

test("gate 6 — a non-collecting session never blocks", () => {
  const v = evaluateSequence(
    ok({ qualification: { status: "qualified", followUpsSent: 0, maxFollowUps: 4 } }),
  );
  expect(v).toEqual({ kind: "send", stepIndex: 0 });
});

test("gate 7 — opted out stops", () => {
  expect(evaluateSequence(ok({ optedOut: true })).kind).toBe("stop");
});

test("gate 8 — a recent agent message reschedules", () => {
  const v = evaluateSequence(ok({ lastAgentMessageAt: NOW - 2 * HOUR }));
  expect(v.kind).toBe("reschedule");
});

test("gate 9 — steps exhausted on an auto-archive band archives", () => {
  expect(evaluateSequence(ok({ followUpsSent: 2 })).kind).toBe("archive");
});

test("gate 9 — steps exhausted on a NON-auto-archive band exhausts, never archives", () => {
  const hot = ok({
    followUpsSent: 3,
    band: {
      key: "hot", minScore: 8, maxScore: 10, autoArchive: false,
      steps: [
        { delayDays: 2, templateName: "a" },
        { delayDays: 5, templateName: "b" },
        { delayDays: 10, templateName: "c" },
      ],
    },
  });
  expect(evaluateSequence(hot)).toEqual({ kind: "exhaust" });
});

test("gate 9 — an unresolvable band stops rather than guessing a cadence", () => {
  expect(evaluateSequence(ok({ band: null })).kind).toBe("stop");
});

test("gate 10 — unknown working hours STOP, they do not reschedule", () => {
  const v = evaluateSequence(ok({ workingHoursKnown: false }));
  expect(v.kind).toBe("stop");
});

test("gate 10 — outside working hours reschedules", () => {
  const v = evaluateSequence(ok({ withinWorkingHours: false }));
  expect(v.kind).toBe("reschedule");
});

test("gate 11 — the daily cap reschedules, it never drops a lead", () => {
  const v = evaluateSequence(ok({ dailyCapReached: true }));
  expect(v.kind).toBe("reschedule");
});

test("gate 12 — an unapproved template stops with a reviewable reason", () => {
  const v = evaluateSequence(ok({ templateApproved: false }));
  expect(v).toEqual({ kind: "stop", reason: "template_unavailable" });
});

test("every reason a verdict can carry is in its declared vocabulary", () => {
  // Guards the four tasks downstream that persist and render these.
  const cases: EligibilityInput[] = [
    ok({ enabled: false }), ok({ archived: true }), ok({ snoozed: true }),
    ok({ conversationStatus: "closed" }), ok({ lastMessageSenderType: "customer" }),
    ok({ optedOut: true }), ok({ band: null }),
    ok({ workingHoursKnown: false }), ok({ templateApproved: false }),
    ok({ lastCustomerMessageAt: NOW - 1 * DAY }),
    ok({ qualification: { status: "collecting", followUpsSent: 1, maxFollowUps: 4 } }),
    ok({ lastAgentMessageAt: NOW - 2 * HOUR }),
    ok({ withinWorkingHours: false }), ok({ dailyCapReached: true }),
  ];
  for (const input of cases) {
    const v = evaluateSequence(input);
    if (v.kind === "stop") expect(STOP_REASONS).toContain(v.reason);
    if (v.kind === "reschedule") expect(RESCHEDULE_REASONS).toContain(v.reason);
  }
});

// A stop always beats a reschedule when both apply. Each test below
// combines a terminal (stop) condition with a transient (reschedule)
// condition that, on its own, would reschedule. The stop must win
// regardless of which gate number each one carries in the table above
// — this is a structural property of the chain (every terminal gate
// runs before any transient gate), not an artifact of which gate
// happens to be checked first in the numbered listing.

test("stop beats reschedule: archived (gate 2) over outside hours (gate 10)", () => {
  expect(
    evaluateSequence(ok({ archived: true, withinWorkingHours: false })),
  ).toEqual({ kind: "stop", reason: "archived" });
});

test("stop beats reschedule: opted_out (gate 7) over not_idle_yet (gate 5) — a terminal gate numbered AFTER the transient one must still win", () => {
  expect(
    evaluateSequence(
      ok({ optedOut: true, lastCustomerMessageAt: NOW - 1 * DAY }),
    ),
  ).toEqual({ kind: "stop", reason: "opted_out" });
});

test("stop beats reschedule: no_band (gate 9) over agent_active (gate 8)", () => {
  expect(
    evaluateSequence(ok({ band: null, lastAgentMessageAt: NOW - 2 * HOUR })),
  ).toEqual({ kind: "stop", reason: "no_band" });
});

test("stop beats reschedule: template_unavailable (gate 12) over daily_cap (gate 11)", () => {
  expect(
    evaluateSequence(ok({ templateApproved: false, dailyCapReached: true })),
  ).toEqual({ kind: "stop", reason: "template_unavailable" });
});

test("stop beats reschedule: template_unavailable (gate 12) over outside_hours (gate 10)", () => {
  expect(
    evaluateSequence(
      ok({ templateApproved: false, withinWorkingHours: false }),
    ),
  ).toEqual({ kind: "stop", reason: "template_unavailable" });
});

test("gate 5 — an unknown last-customer-message fails closed: stop, not send", () => {
  // We don't know whether the customer has ever written in at all —
  // same fail-closed reasoning as gate 10's unknown-hours case, and
  // for higher stakes: sending here means a marketing template to
  // someone who never contacted the business.
  expect(evaluateSequence(ok({ lastCustomerMessageAt: null }))).toEqual({
    kind: "stop",
    reason: "no_customer_message",
  });
});

test("gate 5 — the null-customer-message stop holds even though every other gate is clear", () => {
  // `ok()`'s baseline already clears every other gate (it's the "send"
  // fixture). This is the exact input that used to leak through as
  // `send`, because a null timestamp was treated as `idleMs = Infinity`
  // — which always satisfies the idle gate instead of being refused.
  const v = evaluateSequence(ok({ lastCustomerMessageAt: null }));
  expect(v.kind).toBe("stop");
});

test("every send verdict names a step index inside the band", () => {
  const v = evaluateSequence(ok({ followUpsSent: 1 }));
  expect(v).toEqual({ kind: "send", stepIndex: 1 });
});

// Archiving an exhausted band is an ACTION ("this lead is dead, file
// it"), not a stop. Any sign of recent activity — the customer isn't
// idle yet, qualification still owns the clock, or an agent is
// active — means the lead is alive, so it must defer archiving rather
// than filing it away. Pure send-timing constraints (outside hours,
// the daily cap) say nothing about whether the LEAD is alive, only
// about whether we can send right now, and an exhausted band has
// nothing left to send anyway — so those must NOT block archiving.

test("tier ordering — an exhausted band defers to qualification_owns (activity), not archive", () => {
  const v = evaluateSequence(
    ok({
      followUpsSent: 2,
      qualification: { status: "collecting", followUpsSent: 1, maxFollowUps: 4 },
    }),
  );
  expect(v).toEqual({ kind: "reschedule", reason: "qualification_owns" });
});

test("tier ordering — an exhausted band defers to agent_active (activity), not archive", () => {
  const v = evaluateSequence(
    ok({ followUpsSent: 2, lastAgentMessageAt: NOW - 2 * HOUR }),
  );
  expect(v).toEqual({ kind: "reschedule", reason: "agent_active" });
});

test("tier ordering — an exhausted band defers to not_idle_yet (activity), not archive", () => {
  const v = evaluateSequence(
    ok({ followUpsSent: 2, lastCustomerMessageAt: NOW - 1 * DAY }),
  );
  expect(v).toEqual({ kind: "reschedule", reason: "not_idle_yet" });
});

test("tier ordering — outside working hours does not block archiving an exhausted band", () => {
  const v = evaluateSequence(
    ok({ followUpsSent: 2, withinWorkingHours: false }),
  );
  expect(v).toEqual({ kind: "archive" });
});

test("tier ordering — the daily cap does not block archiving an exhausted band", () => {
  const v = evaluateSequence(
    ok({ followUpsSent: 2, dailyCapReached: true }),
  );
  expect(v).toEqual({ kind: "archive" });
});

test("tier ordering — the same activity rule governs a hot band's exhaust, not just archive", () => {
  const hot = ok({
    followUpsSent: 3,
    lastAgentMessageAt: NOW - 2 * HOUR,
    band: {
      key: "hot", minScore: 8, maxScore: 10, autoArchive: false,
      steps: [
        { delayDays: 2, templateName: "a" },
        { delayDays: 5, templateName: "b" },
        { delayDays: 10, templateName: "c" },
      ],
    },
  });
  expect(evaluateSequence(hot)).toEqual({ kind: "reschedule", reason: "agent_active" });
});

// `working_hours_unset` and `template_unavailable` are SEND-CAPABILITY
// gates, not lead-level stops: they say we can't send right now (or
// can't approve what we'd send), not that the lead itself is dead. An
// exhausted band has nothing to send in the first place, so neither
// gate has anything to say about it — band exhaustion (tier 3) must
// win over both. (An earlier version of this file put both gates in
// tier 1, ahead of band exhaustion. That made a lead with an exhausted
// band, but unknown working hours, permanently un-archivable: it
// re-evaluated to `stop: working_hours_unset` on every sweep forever,
// since nothing in this module ever flips `workingHoursKnown`, and
// tier 3 — whose whole purpose is "file this dead lead away" — was
// never reached. `template_unavailable` had the same problem, and is
// additionally incoherent for an exhausted band: there is no current
// step, so "is the non-existent step's template approved" has no real
// answer to give.)

test("tier ordering — an exhausted band archives despite unknown working hours", () => {
  const v = evaluateSequence(ok({ followUpsSent: 2, workingHoursKnown: false }));
  expect(v).toEqual({ kind: "archive" });
});

test("tier ordering — an exhausted band archives despite an unapproved template", () => {
  const v = evaluateSequence(ok({ followUpsSent: 2, templateApproved: false }));
  expect(v).toEqual({ kind: "archive" });
});

// Moving `working_hours_unset` and `template_unavailable` into tier 4
// means the whole-tier ordering no longer guarantees "stop beats
// reschedule" for this quartet — all four (`working_hours_unset`,
// `template_unavailable`, `outside_hours`, `daily_cap`) now live in the
// SAME tier. That sub-ordering has to be enforced explicitly inside
// tier 4's own code, and is pinned here rather than left to the
// whole-tier rule (which no longer covers it).

test("tier 4 sub-ordering — the stop-kind gates still beat the reschedule-kind gates within the same tier", () => {
  expect(
    evaluateSequence(ok({ workingHoursKnown: false, withinWorkingHours: false })),
  ).toEqual({ kind: "stop", reason: "working_hours_unset" });

  expect(
    evaluateSequence(ok({ templateApproved: false, dailyCapReached: true })),
  ).toEqual({ kind: "stop", reason: "template_unavailable" });
});
