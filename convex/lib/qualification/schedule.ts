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
  pendingQuestion?: { key: string; text: string; alternates: string[] };
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
 * The varied re-ask (spec §8): rotate through the analysis pass's
 * pre-written question + alternates; before any analysis has run (or if
 * it never produced one) fall back to the first unanswered required
 * basic field's phrasings. Deterministic — the cron never calls an LLM.
 */
export function pickFollowUpText(
  session: PickInput,
  config: Pick<Doc<"qualificationConfigs">, "basicFields">,
): { text: string; nextCursor: number } {
  let candidates: string[] = [];
  if (session.pendingQuestion) {
    candidates = [session.pendingQuestion.text, ...session.pendingQuestion.alternates];
  } else {
    const answered = new Set(
      session.fields.filter((f) => f.confidence !== "low").map((f) => f.key),
    );
    const missing = config.basicFields.find((f) => f.required && !answered.has(f.key));
    candidates = missing?.phrasings ?? [];
  }
  if (candidates.length === 0) {
    // Nothing configured to ask — a gentle generic nudge (still a question).
    candidates = ["Just checking in — could you share a few more details so we can prepare your options?"];
  }
  const index = ((session.phrasingCursor % candidates.length) + candidates.length) % candidates.length;
  return { text: candidates[index], nextCursor: session.phrasingCursor + 1 };
}
