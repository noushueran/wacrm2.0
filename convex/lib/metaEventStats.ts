// ============================================================
// Pure helpers behind the Reports → Events tab
// (docs/superpowers/specs/2026-09-03-reports-events-tab-design.md).
//
// Total functions over plain data: no database, no clock, no Convex ctx —
// the same rule `lib/reportStats.ts` states for itself, and for the same
// reason. A reconciliation fold is exactly the kind of code that produces
// confidently WRONG numbers rather than failing, so it has to be testable
// without a harness.
// ============================================================

import { FUNNEL_STAGES, type FunnelStageKey } from "./funnel";
import {
  DAY_MS,
  EVENT_STATUS_KEYS,
  emptyEventStatusCounts,
  type EventStatusKey,
} from "./reportStats";
import { localDayKeyFromMs } from "./dashboardDate";

/** One line of the Events table, before any counting. */
export interface MetaEventCatalogueEntry {
  stage: FunnelStageKey;
  label: string;
  /** Meta's business-messaging wire name, or null when this milestone is
   *  internal-only and is deliberately never reported. */
  eventName: string | null;
}

/**
 * Derived from `FUNNEL_STAGES`, never hand-listed. A stage added there
 * appears here automatically — the alternative is a second list that
 * silently stops matching the funnel, which is the drift `funnel.test.ts`
 * exists to catch elsewhere.
 *
 * Internal-only stages (`itinerary_created`, `lost`) are KEPT, with a null
 * `eventName`. Dropping them would render a six-stage funnel on a page
 * about an eight-stage one.
 */
export const META_EVENT_CATALOGUE: readonly MetaEventCatalogueEntry[] =
  FUNNEL_STAGES.map((stage) => ({
    stage: stage.key,
    label: stage.label,
    eventName: stage.metaCapi,
  }));

/**
 * Every local day key the half-open window [sinceMs, untilMs) covers, at
 * the given offset, ascending.
 *
 * `tzOffsetMinutes` follows this codebase's existing convention
 * (`localDayKeyFromMs`): local = ms - tzOffsetMinutes * 60_000, so UTC+4 is
 * -240.
 *
 * Walks from the local midnight containing `sinceMs` and stops STRICTLY
 * before `untilMs`, so the exclusive upper bound never contributes its own
 * day. `reportWindow` always hands a local midnight as `untilMs`; without
 * the strict stop that midnight would drag in a whole extra day.
 */
export function datasetDayKeys(
  sinceMs: number,
  untilMs: number,
  tzOffsetMinutes: number,
): string[] {
  const keys: string[] = [];
  for (
    let ms = datasetDayStartMs(sinceMs, tzOffsetMinutes);
    ms < untilMs;
    ms += DAY_MS
  ) {
    keys.push(localDayKeyFromMs(ms, tzOffsetMinutes));
  }
  return keys;
}

/** The instant at which the local day containing `ms` begins, at the
 *  given offset. The sync aligns its requested window to this so it asks
 *  Meta for whole days rather than for a time-of-day — see
 *  `syncDatasetStats`. */
export function datasetDayStartMs(ms: number, tzOffsetMinutes: number): number {
  const shift = tzOffsetMinutes * 60_000;
  return Math.floor((ms - shift) / DAY_MS) * DAY_MS + shift;
}

/** The instant of a day key's own local midnight — the exact inverse of
 *  `localDayKeyFromMs` at the same offset. */
export function dayKeyStartMs(dayKey: string, tzOffsetMinutes: number): number {
  const [y, m, d] = dayKey.split("-").map(Number);
  return Date.UTC(y, m - 1, d) + tzOffsetMinutes * 60_000;
}

/**
 * Does the recorded sync coverage span EVERY day of the requested window?
 *
 * The one guard between "we never synced that day" and a rendered zero.
 * `available: true` only says the last read succeeded; it says nothing
 * about how far back the reads reach, so a 30-day window against three
 * days of coverage must come back UNKNOWN rather than as a partial sum
 * (see `metaEventReconciliation`). Partial is the dangerous answer: it
 * looks like a number.
 *
 * Compared as STRINGS, deliberately. `YYYY-MM-DD` is fixed-width,
 * zero-padded and most-significant-first, so lexicographic order IS
 * chronological order — do not "fix" this into Date parsing, which only
 * adds a parse that can fail.
 */
export function coversWindow(
  coveredSinceDayKey: string | undefined | null,
  coveredUntilDayKey: string | undefined | null,
  dayKeys: readonly string[],
): boolean {
  if (!coveredSinceDayKey || !coveredUntilDayKey) return false;
  if (dayKeys.length === 0) return false;
  return (
    dayKeys[0] >= coveredSinceDayKey &&
    dayKeys[dayKeys.length - 1] <= coveredUntilDayKey
  );
}

export interface MetaStatRow {
  dayKey: string;
  eventName: string;
  count: number;
}

/**
 * Meta's counts per event name over the requested days.
 *
 * An event with no rows is ABSENT from the result rather than present as
 * 0. `buildReconciliation` needs that distinction: absent-because-Meta-was
 * -never-asked and absent-because-Meta-holds-none are different claims,
 * and only the caller knows which one applies.
 */
export function sumMetaCounts(
  rows: readonly MetaStatRow[],
  dayKeys: readonly string[],
): Map<string, number> {
  const wanted = new Set(dayKeys);
  const out = new Map<string, number>();
  for (const row of rows) {
    if (!wanted.has(row.dayKey)) continue;
    out.set(row.eventName, (out.get(row.eventName) ?? 0) + row.count);
  }
  return out;
}

/** The subset of a `conversionEvents` document this fold reads.
 *
 *  No `eventName`: the fold matches Meta's counts on the CATALOGUE's
 *  `metaCapi` name keyed by `stage`, never on the wire name stored on the
 *  row. Carrying the row's own `eventName` here would invite exactly the
 *  wrong join — the same `stage` has a different wire name per lane. */
export interface ConversionEventFact {
  conversationId: string;
  stage: string;
  status: string;
}

export interface ReconciliationInput {
  events: readonly ConversionEventFact[];
  /** Meta's counts, or `null` when the dataset could not be read at all.
   *  `null` is what makes every `recorded` unknown rather than zero. */
  metaCounts: Map<string, number> | null;
}

export interface MetaEventRow extends MetaEventCatalogueEntry {
  /** Distinct conversations that reached this milestone in the window. */
  reached: number;
  /** Distinct conversations whose event for this milestone was accepted. */
  delivered: number;
  /** Distinct conversations per delivery status — the breakdown that
   *  explains `reached - delivered`. */
  byStatus: Record<EventStatusKey, number>;
  /** Meta's own count, or null when unknown (unavailable, or the stage is
   *  internal-only and is never sent). */
  recorded: number | null;
  /** `recorded - delivered`, or null whenever `recorded` is null. */
  delta: number | null;
}

/**
 * The Events table.
 *
 * DISTINCT CONVERSATIONS everywhere, never row counts. A milestone can
 * legitimately produce more than one outbox row for one lead (a requeue,
 * a lane change), and counting rows would report more qualified leads than
 * there are leads — the same trap `funnelOverview` documents for
 * `stageFirstReached`.
 */
export function buildReconciliation(
  input: ReconciliationInput,
): MetaEventRow[] {
  const reachedBy = new Map<string, Set<string>>();
  const deliveredBy = new Map<string, Set<string>>();
  const statusBy = new Map<string, Map<string, Set<string>>>();

  for (const event of input.events) {
    let reached = reachedBy.get(event.stage);
    if (!reached) reachedBy.set(event.stage, (reached = new Set()));
    reached.add(event.conversationId);

    if (event.status === "sent") {
      let delivered = deliveredBy.get(event.stage);
      if (!delivered) deliveredBy.set(event.stage, (delivered = new Set()));
      delivered.add(event.conversationId);
    }

    let statuses = statusBy.get(event.stage);
    if (!statuses) statusBy.set(event.stage, (statuses = new Map()));
    let convos = statuses.get(event.status);
    if (!convos) statuses.set(event.status, (convos = new Set()));
    convos.add(event.conversationId);
  }

  return META_EVENT_CATALOGUE.map((entry) => {
    const byStatus = emptyEventStatusCounts();
    const statuses = statusBy.get(entry.stage);
    if (statuses) {
      for (const key of EVENT_STATUS_KEYS) {
        byStatus[key] = statuses.get(key)?.size ?? 0;
      }
    }
    const delivered = deliveredBy.get(entry.stage)?.size ?? 0;

    // Unknown when Meta could not be read, and unknown for a stage we
    // never send — in that second case Meta holding none of them is not a
    // discrepancy, and showing 0 with a delta would invent one.
    const recorded =
      input.metaCounts === null || entry.eventName === null
        ? null
        : (input.metaCounts.get(entry.eventName) ?? 0);

    return {
      ...entry,
      reached: reachedBy.get(entry.stage)?.size ?? 0,
      delivered,
      byStatus,
      recorded,
      delta: recorded === null ? null : recorded - delivered,
    };
  });
}
