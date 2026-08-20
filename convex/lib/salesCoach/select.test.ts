import { expect, test } from "vitest";
import {
  DEFAULT_SALES_COACH_CONFIG,
  coachSkipReason,
  firstHumanResponseMinutes,
  type CoachCandidate,
} from "./select";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const cfg = DEFAULT_SALES_COACH_CONFIG;

function candidate(over: Partial<CoachCandidate> = {}): CoachCandidate {
  return {
    assignedToUserId: "user1",
    messageCount: 8,
    lastMessageAt: NOW - 60 * MIN,
    reviewedThroughMs: null,
    hasHumanTurn: true,
    ...over,
  };
}

test("a handled thread with enough substance is worth reviewing", () => {
  expect(coachSkipReason(candidate(), cfg, NOW)).toBeNull();
});

test("an unassigned thread has nobody to coach", () => {
  expect(coachSkipReason(candidate({ assignedToUserId: null }), cfg, NOW)).toBe("not_assigned");
});

test("a thread the bot handled alone is never blamed on its assignee", () => {
  // Assignment does not mean a person typed. Coaching someone for work
  // they never did is the fastest way to make this tool resented.
  expect(coachSkipReason(candidate({ hasHumanTurn: false }), cfg, NOW)).toBe("no_human_turn");
});

test("a thread too short to coach on is skipped", () => {
  expect(coachSkipReason(candidate({ messageCount: 2 }), cfg, NOW)).toBe("too_few_messages");
});

test("an old thread is out of scope", () => {
  expect(coachSkipReason(candidate({ lastMessageAt: NOW - 90 * 86_400_000 }), cfg, NOW)).toBe("too_old");
});

test("a thread is re-reviewed only once it has moved on", () => {
  const last = NOW - 60 * MIN;
  expect(coachSkipReason(candidate({ lastMessageAt: last, reviewedThroughMs: last }), cfg, NOW))
    .toBe("already_reviewed");
  // A newer message makes it eligible again.
  expect(coachSkipReason(candidate({ lastMessageAt: last, reviewedThroughMs: last - MIN }), cfg, NOW))
    .toBeNull();
});

test("response time measures the human, not the bot", () => {
  // The auto-reply answers instantly; counting it would make every
  // response time look perfect.
  const mins = firstHumanResponseMinutes([
    { senderType: "customer", at: NOW },
    { senderType: "bot", at: NOW + MIN },
    { senderType: "agent", at: NOW + 30 * MIN },
  ]);
  expect(mins).toBe(30);
});

test("the clock starts at the customer's FIRST unanswered message", () => {
  const mins = firstHumanResponseMinutes([
    { senderType: "customer", at: NOW },
    { senderType: "customer", at: NOW + 10 * MIN },
    { senderType: "agent", at: NOW + 20 * MIN },
  ]);
  expect(mins).toBe(20);
});

test("a thread no human ever answered reports null, not zero", () => {
  // Zero would read as instant. Null is the honest answer.
  expect(
    firstHumanResponseMinutes([
      { senderType: "customer", at: NOW },
      { senderType: "bot", at: NOW + MIN },
    ]),
  ).toBeNull();
  expect(firstHumanResponseMinutes([])).toBeNull();
});

test("out-of-order rows still measure correctly", () => {
  const mins = firstHumanResponseMinutes([
    { senderType: "agent", at: NOW + 15 * MIN },
    { senderType: "customer", at: NOW },
  ]);
  expect(mins).toBe(15);
});
