// ============================================================
// Pure snooze arithmetic (spec 2026-07-28-inbox-manual-overrides
// §Durations). No I/O and no `Date.now()` — the caller passes `nowMs`,
// so every preset is deterministic under test.
//
// Working-hours resolution uses a FIXED utc offset, the same assumption
// `lib/qualification/schedule.ts` documents: the accounts this serves
// are Gulf/India, which have no DST, so a preset is plain millisecond
// shifting rather than a timezone library.
// ============================================================

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Custom snoozes are floored to this, so a stored wake time is never
 *  more precise than the UI that produced it. */
const SNOOZE_GRANULARITY_MS = 5 * MINUTE;

/**
 * Ceiling on a custom snooze. A thread you want gone for longer than a
 * month is being archived, not parked, and should say so — archive is
 * reversible, discoverable, and does not silently expire.
 */
export const MAX_SNOOZE_DAYS = 30;

export const SNOOZE_PRESETS = ["three_hours", "tomorrow", "next_week"] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];
export type SnoozeChoice = SnoozePreset | { customMs: number };

export interface SnoozeHoursConfig {
  utcOffsetMinutes: number;
  workStartMinute: number;
  workDays: number[]; // 0=Sun … 6=Sat
}

/** The next working day's opening, strictly after `fromMs`. */
function nextWorkingOpen(fromMs: number, config: SnoozeHoursConfig): number {
  const offsetMs = config.utcOffsetMinutes * MINUTE;
  const local = fromMs + offsetMs;
  const dayStartLocal = Math.floor(local / DAY) * DAY;
  // Start at tomorrow; a preset never resolves to earlier today.
  for (let d = 1; d <= 8; d++) {
    const candidate = dayStartLocal + d * DAY;
    if (config.workDays.includes(new Date(candidate).getUTCDay())) {
      return candidate + config.workStartMinute * MINUTE - offsetMs;
    }
  }
  return fromMs + DAY; // unreachable with a non-empty workDays (validated on save)
}

/** The Monday-or-later opening at least 3 days out — "next week". */
function nextWeekOpen(fromMs: number, config: SnoozeHoursConfig): number {
  const offsetMs = config.utcOffsetMinutes * MINUTE;
  const local = fromMs + offsetMs;
  const dayStartLocal = Math.floor(local / DAY) * DAY;
  for (let d = 1; d <= 14; d++) {
    const candidate = dayStartLocal + d * DAY;
    const dow = new Date(candidate).getUTCDay();
    if (dow === 1 && d >= 3) {
      return candidate + config.workStartMinute * MINUTE - offsetMs;
    }
  }
  return fromMs + 7 * DAY;
}

/**
 * Resolve a snooze choice to an absolute wake time.
 *
 * Presets land on the START of a working day rather than an arbitrary
 * clock offset, so "tomorrow" means "when I next sit down", not 3am.
 * `three_hours` is deliberately exempt: it is a within-the-day park and
 * rounding it to an opening time would make it useless.
 *
 * Throws on a custom time in the past or beyond `MAX_SNOOZE_DAYS` — the
 * caller is a mutation and should surface the error, not silently clamp
 * a value the agent explicitly chose.
 */
export function resolveSnoozeUntilMs(
  choice: SnoozeChoice,
  nowMs: number,
  config: SnoozeHoursConfig,
): number {
  if (choice === "three_hours") return nowMs + 3 * HOUR;
  if (choice === "tomorrow") return nextWorkingOpen(nowMs, config);
  if (choice === "next_week") return nextWeekOpen(nowMs, config);

  const floored = Math.floor(choice.customMs / SNOOZE_GRANULARITY_MS) * SNOOZE_GRANULARITY_MS;
  if (floored <= nowMs) throw new Error("snooze_in_the_past");
  if (floored > nowMs + MAX_SNOOZE_DAYS * DAY) throw new Error("snooze_too_far");
  return floored;
}
