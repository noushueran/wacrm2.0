import { expect, test } from "vitest";
import {
  DEFAULT_REVIVAL_CONFIG,
  WINDOW_MS,
  candidateSkipReason,
  configPatchError,
  sendBlockReason,
  type CandidateInput,
} from "./select";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function candidate(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    lastMessageAt: NOW - 240 * MIN,
    lastMessageInbound: false,
    snoozedUntil: null,
    doNotContact: false,
    optedOut: false,
    archived: false,
    qualificationWillNudge: false,
    lastDraftAt: null,
    leadScore: 70,
    ...over,
  };
}

test("a lead quiet inside the window with nothing against it is a candidate", () => {
  expect(candidateSkipReason(candidate(), DEFAULT_REVIVAL_CONFIG, NOW)).toBeNull();
});

test("a lead waiting on OUR reply is not chased — that is an unanswered message", () => {
  expect(
    candidateSkipReason(
      candidate({ lastMessageInbound: true }),
      DEFAULT_REVIVAL_CONFIG,
      NOW,
    ),
  ).toBe("awaiting_our_reply");
});

test("a lead where WE spoke last and they went quiet IS the case to chase", () => {
  // The whole point. With auto-reply on the bot always has the last
  // word, so this is what every stalled lead actually looks like —
  // requiring the customer to have spoken last matched 0 of 77 in
  // production.
  expect(
    candidateSkipReason(
      candidate({ lastMessageInbound: false }),
      DEFAULT_REVIVAL_CONFIG,
      NOW,
    ),
  ).toBeNull();
});

test("a lead who has only just gone quiet is left alone", () => {
  expect(
    candidateSkipReason(
      candidate({ lastMessageAt: NOW - 10 * MIN }),
      DEFAULT_REVIVAL_CONFIG,
      NOW,
    ),
  ).toBe("too_recent");
});

test("the window-safety margin excludes a lead too close to the 24h edge", () => {
  // 23h30m quiet: still technically in-window, but under the 60m of
  // headroom a queued draft needs to survive until a human taps send.
  const almostShut = NOW - (WINDOW_MS - 30 * MIN);
  expect(
    candidateSkipReason(
      candidate({ lastMessageAt: almostShut }),
      DEFAULT_REVIVAL_CONFIG,
      NOW,
    ),
  ).toBe("window_closing");
});

test("a lead past the 24h window is out of reach without a template", () => {
  expect(
    candidateSkipReason(
      candidate({ lastMessageAt: NOW - 30 * 60 * MIN }),
      DEFAULT_REVIVAL_CONFIG,
      NOW,
    ),
  ).toBe("window_closing");
});

test("snoozed, do-not-contact, and archived leads are all skipped", () => {
  const c = DEFAULT_REVIVAL_CONFIG;
  expect(candidateSkipReason(candidate({ snoozedUntil: NOW + MIN }), c, NOW)).toBe(
    "snoozed",
  );
  expect(candidateSkipReason(candidate({ doNotContact: true }), c, NOW)).toBe(
    "do_not_contact",
  );
  expect(candidateSkipReason(candidate({ archived: true }), c, NOW)).toBe("archived");
});

test("a lead who told us to stop is never chased, at selection or at send", () => {
  const c = DEFAULT_REVIVAL_CONFIG;
  expect(candidateSkipReason(candidate({ optedOut: true }), c, NOW)).toBe("opted_out");
  // And again at send time — someone can opt out while a draft waits in
  // the queue, which is exactly when it matters most.
  expect(
    sendBlockReason(
      { ...candidate({ optedOut: true }), status: "pending", expiresAt: NOW + MIN },
      NOW,
    ),
  ).toBe("opted_out");
});

test("an expired snooze does not skip", () => {
  expect(
    candidateSkipReason(
      candidate({ snoozedUntil: NOW - MIN }),
      DEFAULT_REVIVAL_CONFIG,
      NOW,
    ),
  ).toBeNull();
});

test("we defer only to a qualification engine that will actually nudge", () => {
  // `qualificationWillNudge` folds in `outboundNudgesEnabled`. Deferring
  // on "collecting" alone left 280 production leads owned by a switched-
  // off engine and skipped by this one.
  expect(
    candidateSkipReason(
      candidate({ qualificationWillNudge: true }),
      DEFAULT_REVIVAL_CONFIG,
      NOW,
    ),
  ).toBe("qualification_active");
  expect(
    candidateSkipReason(
      candidate({ qualificationWillNudge: false }),
      DEFAULT_REVIVAL_CONFIG,
      NOW,
    ),
  ).toBeNull();
});

test("cooldown suppresses a second draft, and lapses afterwards", () => {
  const c = DEFAULT_REVIVAL_CONFIG;
  expect(candidateSkipReason(candidate({ lastDraftAt: NOW - 60 * MIN }), c, NOW)).toBe(
    "cooldown",
  );
  const past = NOW - (c.cooldownHours * 60 + 1) * MIN;
  expect(candidateSkipReason(candidate({ lastDraftAt: past }), c, NOW)).toBeNull();
});

test("a lead below the score floor is not worth a nudge", () => {
  const c = { ...DEFAULT_REVIVAL_CONFIG, minLeadScore: 50 };
  expect(candidateSkipReason(candidate({ leadScore: 20 }), c, NOW)).toBe(
    "score_too_low",
  );
  // An unscored lead is not a low-scored one — excluding it would make
  // the whole feature silently depend on Lead Analysis being enabled.
  expect(candidateSkipReason(candidate({ leadScore: null }), c, NOW)).toBeNull();
});

test("sendBlockReason lets a still-valid draft through", () => {
  expect(
    sendBlockReason(
      { ...candidate(), status: "pending", expiresAt: NOW + MIN },
      NOW,
    ),
  ).toBeNull();
});

test("a customer reply since drafting blocks the send", () => {
  // Drafted 4h ago; they replied 2m ago. Sending now talks over them.
  expect(
    sendBlockReason(
      {
        ...candidate({ lastMessageAt: NOW - 2 * MIN }),
        status: "pending",
        expiresAt: NOW + MIN,
        draftedAt: NOW - 240 * MIN,
      },
      NOW,
    ),
  ).toBe("customer_replied");
});

test("an expired or already-actioned draft can never be sent", () => {
  expect(
    sendBlockReason({ ...candidate(), status: "pending", expiresAt: NOW - MIN }, NOW),
  ).toBe("expired");
  expect(
    sendBlockReason({ ...candidate(), status: "sent", expiresAt: NOW + MIN }, NOW),
  ).toBe("already_actioned");
  expect(
    sendBlockReason({ ...candidate(), status: "dismissed", expiresAt: NOW + MIN }, NOW),
  ).toBe("already_actioned");
});

test("a thread snoozed or marked do-not-contact after drafting blocks the send", () => {
  // The queue is not a snapshot — circumstances change while a draft waits.
  expect(
    sendBlockReason(
      {
        ...candidate({ snoozedUntil: NOW + 10 * MIN }),
        status: "pending",
        expiresAt: NOW + MIN,
      },
      NOW,
    ),
  ).toBe("snoozed");
  expect(
    sendBlockReason(
      { ...candidate({ doNotContact: true }), status: "pending", expiresAt: NOW + MIN },
      NOW,
    ),
  ).toBe("do_not_contact");
});

test("the window shutting blocks a send even when expiresAt was set generously", () => {
  // Belt and braces: expiresAt is derived data, the 24h rule is the law.
  expect(
    sendBlockReason(
      {
        ...candidate({ lastMessageAt: NOW - WINDOW_MS - MIN }),
        status: "pending",
        expiresAt: NOW + 10 * MIN,
      },
      NOW,
    ),
  ).toBe("expired");
});

test("a clean config patch has no bounds error", () => {
  expect(
    configPatchError({ minQuietMinutes: 180, cooldownHours: 72, minLeadScore: 5 }),
  ).toBeNull();
  // An absent key is not a violation — patches are partial.
  expect(configPatchError({})).toBeNull();
});

test("minQuietMinutes cannot be set low enough to chase a live conversation", () => {
  expect(configPatchError({ minQuietMinutes: 5 })?.key).toBe("minQuietMinutes");
});

test("the safety margin cannot be removed entirely", () => {
  expect(configPatchError({ windowSafetyMinutes: 0 })?.key).toBe(
    "windowSafetyMinutes",
  );
});

test("cooldown cannot be zeroed into nudging the same lead every sweep", () => {
  expect(configPatchError({ cooldownHours: 0 })?.key).toBe("cooldownHours");
});

test("minLeadScore is bounded to the real 1-10 scale, with 0 meaning no floor", () => {
  expect(configPatchError({ minLeadScore: 0 })).toBeNull();
  expect(configPatchError({ minLeadScore: 10 })).toBeNull();
  expect(configPatchError({ minLeadScore: 85 })?.key).toBe("minLeadScore");
});

test("junk values are rejected, not coerced", () => {
  expect(configPatchError({ draftsPerRun: "20" })?.key).toBe("draftsPerRun");
  expect(configPatchError({ draftsPerRun: NaN })?.key).toBe("draftsPerRun");
  expect(configPatchError({ dailyDraftCap: Infinity })?.key).toBe("dailyDraftCap");
});
