import { expect, test } from "vitest";
import { BOUNDARY_BUCKET_MS, chasingCutoffMs, graceCutoffMs } from "./lanes";

const DAY = 24 * 3_600_000;
const NOW = 1_800_000_000_000; // fixed; never Date.now() in a unit test

test("absent chasingAfterDays falls back to the qualification window", () => {
  // 72h = 3 days: Chasing must begin exactly where the qualification
  // engine gives up, with no gap and no overlap.
  expect(chasingCutoffMs(NOW, { sessionWindowHours: 72 })).toBe(NOW - 3 * DAY);
});

test("an explicit chasingAfterDays wins over the fallback", () => {
  expect(chasingCutoffMs(NOW, { chasingAfterDays: 5, sessionWindowHours: 72 }))
    .toBe(NOW - 5 * DAY);
});

test("a widened qualification window (>= 24h) still derives the matching cutoff", () => {
  expect(chasingCutoffMs(NOW, { sessionWindowHours: 48 })).toBe(NOW - 2 * DAY);
  expect(chasingCutoffMs(NOW, { sessionWindowHours: 336 })).toBe(NOW - 14 * DAY);
});

test("a sub-24h qualification window does NOT align: the one-day floor wins", () => {
  // The honest limitation, asserted rather than claimed away (final
  // review, Finding 4). `validate.ts` allows sessionWindowHours down to
  // 1, and MIN_DAYS clamps below 24h — so at a 12h window the engine
  // gives up at 12h while Chasing does not start until 24h. The gap is
  // accepted: its direction is safe (never Chasing while the session
  // could still be `collecting`), and a cutoff shorter than a working
  // day would put just-answered threads in front of the auto-assign
  // sweep. See lanes.ts's own note.
  expect(chasingCutoffMs(NOW, { sessionWindowHours: 12 })).toBe(NOW - DAY);
  expect(chasingCutoffMs(NOW, { sessionWindowHours: 1 })).toBe(NOW - DAY);
});

// ── Cursor stability (owner report 2026-07-30) ──────────────────────
// These are the load-bearing tests for the Waiting/Chasing lanes'
// pagination, not stylistic ones. Both boundaries are bound as INDEX
// RANGE keys by `conversations.list`, and Convex fingerprints an index
// range into the pagination cursor it mints. A boundary that moves by a
// millisecond between two executions is therefore a DIFFERENT query, and
// every cursor from the previous execution comes back `InvalidCursor` —
// which `usePaginatedQuery` absorbs by throwing away all pagination
// state. Observed on production as: "Load more" on Waiting/Chasing never
// appended a page (47 rows -> 47 rows) and the whole list flashed back
// to its skeleton, on every click and on every mutation that touched the
// list (archive, etc.). Active and Snoozed, whose ranges bind no
// time-derived key, paginated correctly throughout — that contrast is
// what identified the cause.
//
// Quantizing both boundaries to a shared bucket is what makes repeated
// executions produce a byte-identical range, so the cursor stays valid.

test("the cutoff is STABLE across executions inside one bucket", () => {
  // The real failure: two runs of the same query milliseconds apart.
  const config = { sessionWindowHours: 72 };
  const base = chasingCutoffMs(NOW, config);
  expect(chasingCutoffMs(NOW + 1, config)).toBe(base);
  expect(chasingCutoffMs(NOW + 1_000, config)).toBe(base);
  expect(chasingCutoffMs(NOW + BOUNDARY_BUCKET_MS - 1, config)).toBe(base);
});

test("the grace boundary is STABLE across executions inside one bucket", () => {
  const base = graceCutoffMs(NOW);
  expect(graceCutoffMs(NOW + 1)).toBe(base);
  expect(graceCutoffMs(NOW + 1_000)).toBe(base);
  expect(graceCutoffMs(NOW + BOUNDARY_BUCKET_MS - 1)).toBe(base);
});

test("an unaligned clock still yields a stable, bucket-aligned boundary", () => {
  // `Date.now()` is never bucket-aligned in production, so the flooring
  // has to happen inside the helpers rather than relying on the caller.
  const unaligned = NOW + 7 * 60_000 + 123; // 7m 0.123s into the bucket
  const config = { sessionWindowHours: 72 };
  expect(chasingCutoffMs(unaligned, config)).toBe(NOW - 3 * DAY);
  expect(graceCutoffMs(unaligned)).toBe(graceCutoffMs(NOW));
});

test("boundaries advance once the bucket rolls over", () => {
  // Stability must not become staleness: the lanes still have to track
  // real time, just in steps the cursor can survive.
  const config = { sessionWindowHours: 72 };
  expect(chasingCutoffMs(NOW + BOUNDARY_BUCKET_MS, config)).toBe(
    chasingCutoffMs(NOW, config) + BOUNDARY_BUCKET_MS,
  );
  expect(graceCutoffMs(NOW + BOUNDARY_BUCKET_MS)).toBe(
    graceCutoffMs(NOW) + BOUNDARY_BUCKET_MS,
  );
});

test("Waiting stays a non-empty band: grace is always newer than the cutoff", () => {
  // The two boundaries are the Waiting lane's upper and lower bounds
  // (`gt(cutoff).lte(grace)`). If quantization ever pushed them past
  // each other the lane would silently return nothing.
  for (const offset of [0, 1, 60_000, BOUNDARY_BUCKET_MS - 1]) {
    const now = NOW + offset;
    expect(graceCutoffMs(now)).toBeGreaterThan(
      chasingCutoffMs(now, { sessionWindowHours: 72 }),
    );
  }
});

test("zero and negative values are clamped to a minimum of one day", () => {
  // A cutoff of `now` would put every just-answered thread in Chasing.
  // `validate.ts` now rejects these through `updateConfig`, so this is
  // the belt-and-braces path for a value already in the database.
  expect(chasingCutoffMs(NOW, { chasingAfterDays: 0, sessionWindowHours: 72 }))
    .toBe(NOW - DAY);
  expect(chasingCutoffMs(NOW, { chasingAfterDays: -3, sessionWindowHours: 72 }))
    .toBe(NOW - DAY);
});
