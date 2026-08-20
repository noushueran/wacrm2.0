import type { Doc } from "../../_generated/dataModel";

// ============================================================
// Pure follow-up scheduling math (spec §8) — no I/O, no Date.now();
// every function takes explicit timestamps so the whole cadence is
// deterministic under test. Working hours use ACCOUNT-LOCAL
// minutes-of-day against a FIXED UTC offset (Gulf/India have no DST —
// the deliberate design tradeoff recorded in the spec §5), so the tz
// arithmetic is plain millisecond shifting, no Intl/library needed.
// ============================================================

export interface WorkingHoursConfig {
  utcOffsetMinutes: number;
  workStartMinute: number;
  workEndMinute: number;
  workDays: number[]; // 0=Sun … 6=Sat
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * Returns `ts` unchanged when it falls inside working hours, else the
 * next window opening (same day when before opening, otherwise the next
 * working day's `workStartMinute`). Iterates at most 8 days, so even a
 * degenerate single-workday config terminates.
 */
export function clampToWorkingHours(ts: number, config: WorkingHoursConfig): number {
  const offsetMs = config.utcOffsetMinutes * MINUTE;
  const local = ts + offsetMs;
  const dayStartLocal = Math.floor(local / DAY) * DAY;
  const minuteOfDay = Math.floor((local - dayStartLocal) / MINUTE);
  const dow = new Date(local).getUTCDay();

  const openToday = config.workDays.includes(dow);
  if (openToday && minuteOfDay >= config.workStartMinute && minuteOfDay < config.workEndMinute) {
    return ts;
  }
  // Same-day opening still ahead?
  if (openToday && minuteOfDay < config.workStartMinute) {
    return dayStartLocal + config.workStartMinute * MINUTE - offsetMs;
  }
  // Roll forward day by day to the next working day's opening.
  for (let d = 1; d <= 8; d++) {
    const candidateDayStart = dayStartLocal + d * DAY;
    const candidateDow = new Date(candidateDayStart).getUTCDay();
    if (config.workDays.includes(candidateDow)) {
      return candidateDayStart + config.workStartMinute * MINUTE - offsetMs;
    }
  }
  return ts; // unreachable with a non-empty workDays (validated on save)
}

/**
 * The cadence ladder: delay for attempt N (= `followUpsSent`) after the
 * last activity, clamped into working hours. Null once the cap is
 * reached — the session then just waits out the 72h expiry clock.
 * A ladder shorter than the cap reuses its last rung.
 */
export function computeNextFollowUpAt(
  config: WorkingHoursConfig & {
    followUpDelaysMinutes: number[];
    maxFollowUps: number;
  },
  followUpsSent: number,
  fromMs: number,
): number | null {
  if (followUpsSent >= config.maxFollowUps) return null;
  if (config.followUpDelaysMinutes.length === 0) return null;
  const idx = Math.min(followUpsSent, config.followUpDelaysMinutes.length - 1);
  const due = fromMs + config.followUpDelaysMinutes[idx] * MINUTE;
  return clampToWorkingHours(due, config);
}

/** The 3-day rule: no customer reply for `windowHours` → session expires. */
export function isSessionExpired(
  lastCustomerMessageAt: number,
  nowMs: number,
  windowHours: number,
): boolean {
  return nowMs - lastCustomerMessageAt >= windowHours * 3_600_000;
}

/** WhatsApp's 24h customer-service window: free-form sends are allowed
 *  only within 24h of the customer's last message. */
export function withinServiceWindow(lastCustomerMessageAt: number, nowMs: number): boolean {
  return nowMs - lastCustomerMessageAt < 24 * 3_600_000;
}

type PickInput = {
  phrasingCursor: number;
  pendingQuestion?: {
    key: string;
    text: string;
    alternates: string[];
    askedAt?: number;
  };
  /** The customer's last inbound. A `pendingQuestion` stamped before it
   *  is ignored — see `pickFollowUpText`. */
  lastCustomerMessageAt?: number;
  /** Set once the analyst has identified what the customer wants. Its
   *  presence retires the basic-field ladder — see `pickFollowUpText`. */
  serviceName?: string;
  // Structurally compatible with the session's stored field rows —
  // extra props (value, updatedAt, label) are welcome and ignored.
  fields: {
    key: string;
    confidence: "high" | "medium" | "low";
    value?: string;
    label?: string;
    updatedAt?: number;
  }[];
};

/**
 * Content-free check-ins, used once (or instead of) the specific
 * phrasings are spent. They ask for nothing in particular, which is
 * precisely their value: this function runs hours later with no model in
 * the loop, so whenever it cannot prove a question is still open, the
 * only text that CANNOT be wrong is one that re-asks nothing. Safe both
 * on a thread where the whole checklist is already collected and on one
 * where nothing at all is known.
 */
const GENERIC_NUDGES = [
  "Just checking in — still keen to plan this? Happy to pick it up whenever you are.",
  "No rush at all — whenever you're ready, send us a message and we'll carry on from here.",
];

/**
 * The varied re-ask (spec §8): rotate through the analysis pass's
 * pre-written question + alternates; before any analysis has run (or if
 * it never produced one) fall back to the first unanswered required
 * basic field's phrasings. Deterministic — the cron never calls an LLM.
 *
 * The stored question is only used while it post-dates the customer's
 * last message. This function is the ONLY thing that decides what a
 * nudge says, hours after the fact and with no model in the loop, so a
 * question the customer has already spoken past would be replayed at
 * them verbatim — the exact defect that guard exists for.
 *
 * The basic fields are then only reachable while `serviceName` is unset,
 * and that gate is the fix for the 2026-07-30 report (two threads, one
 * customer answering with 😡😡). They are the OFF-TOPIC fallback set:
 * the analysis prompt tells the model to use their keys ONLY when no
 * service checklist matched, so on a normal thread every extracted key
 * belongs to the CHECKLIST namespace instead and no basic-field key is
 * ever present in `fields`. `looking_for` cannot be, even in principle —
 * it names the service, which lands on `serviceName` (the same reasoning
 * `contactFields.ts` records for leaving it out of its alias map). So
 * `find(required && !answered)` returned basic field #0 on every rung of
 * every service thread, and the cron asked "What are you looking for — a
 * holiday package, a visa, or flights & hotels?" of a customer who had
 * opened with "I need family visa 2 year's". Once a service is
 * identified, that whole question set is the wrong namespace to read
 * "still missing" from — the same conclusion `getObjectives` reached for
 * the reply path ("pushing 'how many travellers?' at a visa applicant is
 * worse than saying nothing"). It also retires the aliasing hazard for
 * free: no basicFields `travelers` re-ask on a thread that recorded
 * `pax: 3`.
 *
 * Finally the cursor CLAMPS instead of wrapping. It used to index modulo
 * the candidate list, so a 4-rung ladder over 2 phrasings sent each
 * sentence twice, word for word — visible in the report as the same
 * question 24 hours apart. Walking off the end into the generic
 * check-ins keeps every rung of a default ladder distinct.
 */
export function pickFollowUpText(
  session: PickInput,
  config: Pick<Doc<"qualificationConfigs">, "basicFields">,
): { text: string; nextCursor: number } {
  let specific: string[] = [];
  const pending = session.pendingQuestion;
  const fresh =
    pending !== undefined &&
    pending.askedAt !== undefined &&
    pending.askedAt >= (session.lastCustomerMessageAt ?? 0);
  if (pending && fresh) {
    specific = [pending.text, ...pending.alternates];
  } else if (!(session.serviceName ?? "").trim()) {
    const answered = new Set(
      session.fields.filter((f) => f.confidence !== "low").map((f) => f.key),
    );
    const missing = config.basicFields.find((f) => f.required && !answered.has(f.key));
    specific = missing?.phrasings ?? [];
  }
  const candidates = [...specific, ...GENERIC_NUDGES];
  const cursor = Math.max(0, session.phrasingCursor);
  const index = Math.min(cursor, candidates.length - 1);
  return { text: candidates[index], nextCursor: session.phrasingCursor + 1 };
}
