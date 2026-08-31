import { expect, test } from "vitest";
import {
  clampToWorkingHours,
  computeNextFollowUpAt,
  isSessionExpired,
  withinServiceWindow,
  pickFollowUpText,
  type WorkingHoursConfig,
} from "./schedule";
import { defaultQualificationConfig } from "./defaults";

// Dubai (+240): Mon 2026-07-20 12:00 GST == 08:00 UTC.
const DUBAI: WorkingHoursConfig = {
  utcOffsetMinutes: 240,
  workStartMinute: 10 * 60,
  workEndMinute: 21 * 60,
  workDays: [1, 2, 3, 4, 5, 6], // closed Sunday
};
const MON_NOON_GST = Date.UTC(2026, 6, 20, 8, 0); // Mon 12:00 local

test("clampToWorkingHours: inside the window is returned unchanged", () => {
  expect(clampToWorkingHours(MON_NOON_GST, DUBAI)).toBe(MON_NOON_GST);
});

test("clampToWorkingHours: before opening rolls to the same day's start", () => {
  const monEarly = Date.UTC(2026, 6, 20, 3, 0); // Mon 07:00 local
  const clamped = clampToWorkingHours(monEarly, DUBAI);
  expect(clamped).toBe(Date.UTC(2026, 6, 20, 6, 0)); // Mon 10:00 local
});

test("clampToWorkingHours: after closing rolls to the next working day's start", () => {
  const monLate = Date.UTC(2026, 6, 20, 18, 30); // Mon 22:30 local
  const clamped = clampToWorkingHours(monLate, DUBAI);
  expect(clamped).toBe(Date.UTC(2026, 6, 21, 6, 0)); // Tue 10:00 local
});

test("clampToWorkingHours: Sunday (closed) rolls to Monday opening", () => {
  const sunNoon = Date.UTC(2026, 6, 19, 8, 0); // Sun 12:00 local
  const clamped = clampToWorkingHours(sunNoon, DUBAI);
  expect(clamped).toBe(Date.UTC(2026, 6, 20, 6, 0)); // Mon 10:00 local
});

test("clampToWorkingHours: Saturday after close skips Sunday to Monday", () => {
  const satLate = Date.UTC(2026, 6, 18, 18, 0); // Sat 22:00 local
  const clamped = clampToWorkingHours(satLate, DUBAI);
  expect(clamped).toBe(Date.UTC(2026, 6, 20, 6, 0)); // Mon 10:00 local
});

test("computeNextFollowUpAt walks the ladder, clamps, and returns null past the cap", () => {
  const config = { ...defaultQualificationConfig(), ...DUBAI };
  // attempt 0 → +60min from Mon noon → still in window
  expect(computeNextFollowUpAt(config, 0, MON_NOON_GST)).toBe(MON_NOON_GST + 60 * 60_000);
  // ladder shorter than attempts → last delay reused (attempt 10 < maxFollowUps? no —)
  expect(computeNextFollowUpAt(config, config.maxFollowUps, MON_NOON_GST)).toBeNull();
  // +720min from Mon noon = Tue 00:00 local → clamped to Tue 10:00
  const third = computeNextFollowUpAt(config, 2, MON_NOON_GST);
  expect(third).toBe(Date.UTC(2026, 6, 21, 6, 0));
});

test("isSessionExpired honours the 72h window; withinServiceWindow the 24h one", () => {
  const base = MON_NOON_GST;
  expect(isSessionExpired(base, base + 71 * 3_600_000, 72)).toBe(false);
  expect(isSessionExpired(base, base + 72 * 3_600_000, 72)).toBe(true);
  expect(withinServiceWindow(base, base + 23 * 3_600_000)).toBe(true);
  expect(withinServiceWindow(base, base + 24 * 3_600_000)).toBe(false);
});

test("pickFollowUpText rotates pendingQuestion + alternates, falling back to basic-field phrasings", () => {
  const config = defaultQualificationConfig();
  const session = {
    phrasingCursor: 0,
    pendingQuestion: {
      key: "travel_dates",
      text: "When are you planning to travel?",
      alternates: ["Rough month works too — when?"],
      // Proposed AFTER the customer's last message — the only state in
      // which a stored question may be replayed at them.
      askedAt: MON_NOON_GST + 1_000,
    },
    lastCustomerMessageAt: MON_NOON_GST,
    fields: [],
  };
  const first = pickFollowUpText(session, config);
  expect(first.text).toBe("When are you planning to travel?");
  const second = pickFollowUpText({ ...session, phrasingCursor: first.nextCursor }, config);
  expect(second.text).toBe("Rough month works too — when?");
  // Past the last phrasing the cursor CLAMPS into the generic check-ins
  // rather than wrapping back onto rung 1's sentence: this text is sent
  // verbatim to a real customer, and the same question word for word a
  // day later is what reads as a broken robot.
  const third = pickFollowUpText({ ...session, phrasingCursor: second.nextCursor }, config);
  expect(third.text).not.toBe("When are you planning to travel?");
  expect(third.text).not.toBe("Rough month works too — when?");

  // no pendingQuestion → first unanswered required basic field's phrasings rotate
  const fallback = pickFollowUpText(
    {
      phrasingCursor: 1,
      pendingQuestion: undefined,
      fields: [{ key: "looking_for", value: "Bali", confidence: "high" as const, updatedAt: 1 }],
    },
    config,
  );
  expect(config.basicFields[1].phrasings).toContain(fallback.text); // travel_dates variant
});

test("pickFollowUpText refuses a pendingQuestion the customer has already spoken past", () => {
  const config = defaultQualificationConfig();
  const stale = {
    phrasingCursor: 0,
    pendingQuestion: {
      key: "applicant_location",
      text: "Is the applicant currently inside or outside the UAE?",
      alternates: ["Are they in the UAE right now?"],
      askedAt: MON_NOON_GST,
    },
    // The customer replied two minutes after the question was proposed —
    // replaying it verbatim four hours later is the production defect
    // this guard exists for (conversation nn7afrjd…).
    lastCustomerMessageAt: MON_NOON_GST + 2 * 60_000,
    fields: [],
  };
  const picked = pickFollowUpText(stale, config);
  expect(picked.text).not.toBe(stale.pendingQuestion.text);
  expect(picked.text).not.toBe(stale.pendingQuestion.alternates[0]);
  // Falls through to the field-driven phrasings, which are computed from
  // what is genuinely still unanswered.
  expect(config.basicFields[0].phrasings).toContain(picked.text);
});

test("pickFollowUpText treats an unstamped pendingQuestion (pre-askedAt row) as stale", () => {
  const config = defaultQualificationConfig();
  const picked = pickFollowUpText(
    {
      phrasingCursor: 0,
      pendingQuestion: {
        key: "travel_dates",
        text: "When are you planning to travel?",
        alternates: [],
      },
      lastCustomerMessageAt: MON_NOON_GST,
      fields: [],
    },
    config,
  );
  expect(picked.text).not.toBe("When are you planning to travel?");
});

test("pickFollowUpText never asks the off-topic basic fields once a service is known", () => {
  const config = defaultQualificationConfig();
  // The production shape (reported 2026-07-30, two separate threads): the
  // analyst identified the service on the first message and extracted
  // under the CHECKLIST key namespace, so NO basicFields key is ever
  // present in `fields` — and `looking_for` in particular never can be,
  // since the service itself is its answer. The old fallback therefore
  // pinned every rung of the ladder to basic field #0 and re-asked "What
  // are you looking for — a holiday package, a visa, or flights &
  // hotels?" at a customer who had said "I need family visa 2 year's".
  const session = {
    phrasingCursor: 0,
    pendingQuestion: undefined,
    lastCustomerMessageAt: MON_NOON_GST,
    serviceName: "UAE visa",
    fields: [
      { key: "visa_duration", value: "2 months", confidence: "high" as const, updatedAt: 1 },
      { key: "pax", value: "3", confidence: "high" as const, updatedAt: 1 },
    ],
  };
  const everyBasicPhrasing = config.basicFields.flatMap((f) => f.phrasings);
  for (let cursor = 0; cursor < config.maxFollowUps; cursor++) {
    const picked = pickFollowUpText({ ...session, phrasingCursor: cursor }, config);
    expect(everyBasicPhrasing).not.toContain(picked.text);
  }
});

test("pickFollowUpText still walks the basic fields while no service is identified", () => {
  const config = defaultQualificationConfig();
  // The case the basic fields actually exist for: nothing identified, so
  // their own namespace IS the session's namespace and the ladder is
  // meaningful. `looking_for` answered → the next required field.
  const picked = pickFollowUpText(
    {
      phrasingCursor: 0,
      pendingQuestion: undefined,
      serviceName: undefined,
      fields: [{ key: "looking_for", value: "Bali", confidence: "high" as const, updatedAt: 1 }],
    },
    config,
  );
  expect(config.basicFields[1].phrasings).toContain(picked.text); // travel_dates
});

test("pickFollowUpText never sends the same sentence twice across the default ladder", () => {
  const config = defaultQualificationConfig();
  // A customer who goes silent keeps one fresh pendingQuestion for the
  // whole ladder, and the cursor used to wrap modulo the candidate list —
  // so rung 4 replayed rung 1 word for word. Repeating an identical
  // sentence is the part customers read as a broken robot.
  const base = {
    pendingQuestion: {
      key: "travel_dates",
      text: "When are you planning to travel?",
      alternates: ["Rough month works too — when?"],
      askedAt: MON_NOON_GST + 1_000,
    },
    lastCustomerMessageAt: MON_NOON_GST,
    fields: [],
  };
  const sent: string[] = [];
  let cursor = 0;
  for (let rung = 0; rung < config.maxFollowUps; rung++) {
    const picked = pickFollowUpText({ ...base, phrasingCursor: cursor }, config);
    sent.push(picked.text);
    cursor = picked.nextCursor;
  }
  expect(new Set(sent).size).toBe(sent.length);
});

// ---- P6: staff reply parsing ----
import { parseStaffReply } from "./staffReply";

test("parseStaffReply: conservative accept/decline detection", () => {
  expect(parseStaffReply("YES")).toBe("accept");
  expect(parseStaffReply("ok")).toBe("accept");
  expect(parseStaffReply("Yes, taking it")).toBe("accept");
  expect(parseStaffReply("👍")).toBe("accept");
  expect(parseStaffReply("no")).toBe("decline");
  expect(parseStaffReply("busy")).toBe("decline");
  expect(parseStaffReply("No, offer it to Sara")).toBe("decline");
  expect(parseStaffReply("yes we spoke yesterday about the other customer and it went well")).toBe("other");
  expect(parseStaffReply("The customer confirmed the August dates")).toBe("other");
  expect(parseStaffReply("")).toBe("other");
});
