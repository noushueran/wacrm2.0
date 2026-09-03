# Reports → Events Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a seventh `/reports` tab that puts three counts side by side per Meta event — how many leads reached the milestone, how many we delivered to Meta, and how many Meta's dataset actually recorded — so any disagreement names its own cause.

**Architecture:** Our two columns come from one index range over `conversionEvents` (the same read `reports.funnelOverview` already performs), grouped by `eventName`. Meta's column comes from a new `metaEventDailyStats` table filled by a daily cron that calls the Graph API with the credentials the delivery path already uses. All three columns are pinned to the **dataset's** timezone, not the viewer's, because Meta returns counts pre-bucketed into its own days.

**Tech Stack:** Convex (queries/mutations/actions/crons), Next.js App Router + React, `next-intl`, Tailwind, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-reports-events-tab-design.md`

## Global Constraints

- **Never run `convex deploy`, `convex dev`, or `convex codegen`.** New files under `convex/` will fail the codegen drift guard until the repo owner runs codegen. That failure is expected — do not try to fix it by running codegen.
- **Never run `prettier`.** Scope `eslint` to the files you changed.
- Backend reads are `accountQuery` from `./lib/auth` (never the raw `query` from `_generated/server`) and open with `ctx.requireRole("supervisor")`, matching every sibling in `convex/reports.ts`.
- The frontend must **never** import from `convex/reports.ts`. Shared constants live in `convex/lib/reportStats.ts` or `convex/lib/metaEventStats.ts` — modules with no `ctx`, no `db`, no `_generated/server`. Importing one constant from `convex/reports.ts` ships `accountQuery` and the whole role-check machinery to the browser (see the comment at the top of `src/components/reports/ads-panel.tsx`).
- `GRAPH_VERSION` is `process.env.META_GRAPH_VERSION || "v25.0"` — declare it locally, as `conversionEvents.ts:19` and `campaignAds.ts:10` both do.
- **A zero and an unknown are different claims.** Anywhere Meta's count is unavailable it is `null`, and it renders as `—` with a reason. Never `0`.
- Copy goes in `messages/en.json` under `Reports.events.*`. `en` is the only locale.
- Test runner is `npx vitest run <path>`. Typecheck is `npx tsc --noEmit`.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility |
|---|---|
| `convex/lib/metaEventStats.ts` (create) | Pure folds: the event catalogue, day-key derivation, the reconciliation builder. No ctx, no clock. |
| `convex/lib/metaEventStats.test.ts` (create) | Unit tests for the above. |
| `convex/schema.ts` (modify) | `metaEventDailyStats` + `metaDatasetSyncState` tables. |
| `convex/metaEventStats.ts` (create) | Convex surface: upsert mutation, sync-state reads/writes, the Graph sync action, `capiStatsProbe`. |
| `convex/metaEventStats.test.ts` (create) | Sync action tests against a stubbed `globalThis.fetch`. |
| `convex/crons.ts` (modify) | Register `meta-dataset-stats` daily. |
| `convex/cronSchedules.ts` (modify) | Wrapper action so the run stamps a `cronRuns` row. |
| `convex/lib/cronSummary.ts` (modify) | `CRON_REGISTRY` entry — `cronSchedules.test.ts` asserts this stays in sync with `crons.ts`. |
| `convex/reports.ts` (modify) | `metaEventReconciliation` query. |
| `src/lib/reports/types.ts` (modify) | Add `events` to `REPORT_TABS`. |
| `src/components/reports/events-panel.tsx` (create) | The panel. |
| `src/app/(dashboard)/reports/page.tsx` (modify) | Render the panel for `tab === 'events'`. |
| `messages/en.json` (modify) | `Reports.events.*` copy. |

---

### Task 1: Pure reconciliation helpers

**Files:**
- Create: `convex/lib/metaEventStats.ts`
- Test: `convex/lib/metaEventStats.test.ts`

**Interfaces:**
- Consumes: `FUNNEL_STAGES`, `FunnelStageKey` from `./funnel`; `EVENT_STATUS_KEYS`, `type EventStatusKey` from `./reportStats`; `localDayKeyFromMs` from `./dashboardDate`.
- Produces: `META_EVENT_CATALOGUE`, `datasetDayKeys(sinceMs, untilMs, tzOffsetMinutes)`, `sumMetaCounts(rows, dayKeys)`, `buildReconciliation(input)`, `type MetaEventRow`, `type ReconciliationInput`.

`EVENT_STATUS_KEYS` is already exported from `convex/lib/reportStats.ts` — confirm with `grep -n "EVENT_STATUS_KEYS" convex/lib/reportStats.ts` before writing, and import it rather than re-listing the statuses.

- [ ] **Step 1: Write the failing test**

```ts
// convex/lib/metaEventStats.test.ts
import { describe, it, expect } from "vitest";
import {
  META_EVENT_CATALOGUE,
  datasetDayKeys,
  sumMetaCounts,
  buildReconciliation,
} from "./metaEventStats";

describe("META_EVENT_CATALOGUE", () => {
  it("lists every funnel stage in funnel order, internal-only ones included", () => {
    expect(META_EVENT_CATALOGUE.map((r) => r.stage)).toEqual([
      "new_lead",
      "qualified",
      "price_quoted",
      "itinerary_created",
      "itinerary_sent",
      "invoice_sent",
      "purchased",
      "lost",
    ]);
  });

  it("carries the ctwa wire name, or null for an internal-only stage", () => {
    const byStage = new Map(META_EVENT_CATALOGUE.map((r) => [r.stage, r]));
    expect(byStage.get("new_lead")!.eventName).toBe("LeadSubmitted");
    expect(byStage.get("qualified")!.eventName).toBe("QualifiedLead");
    expect(byStage.get("purchased")!.eventName).toBe("Purchase");
    expect(byStage.get("itinerary_created")!.eventName).toBeNull();
    expect(byStage.get("lost")!.eventName).toBeNull();
  });

  it("carries the human label from FUNNEL_STAGES", () => {
    const byStage = new Map(META_EVENT_CATALOGUE.map((r) => [r.stage, r]));
    expect(byStage.get("qualified")!.label).toBe("Qualified lead");
  });
});

describe("datasetDayKeys", () => {
  it("returns one key per local day the window covers, ascending", () => {
    // UTC+4 (Asia/Dubai) is -240 in the tzOffsetMinutes convention used by
    // localDayKeyFromMs: local = ms - tzOffsetMinutes * 60_000.
    const tz = -240;
    const since = Date.UTC(2026, 8, 1, 20, 0, 0); // 2026-09-02 00:00 local
    const until = Date.UTC(2026, 8, 4, 20, 0, 0); // 2026-09-05 00:00 local
    expect(datasetDayKeys(since, until, tz)).toEqual([
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
  });

  it("excludes the exclusive upper bound's own day", () => {
    const tz = 0;
    const since = Date.UTC(2026, 8, 1, 0, 0, 0);
    const until = Date.UTC(2026, 8, 2, 0, 0, 0);
    expect(datasetDayKeys(since, until, tz)).toEqual(["2026-09-01"]);
  });
});

describe("sumMetaCounts", () => {
  it("sums per event name across only the requested days", () => {
    const rows = [
      { dayKey: "2026-09-02", eventName: "QualifiedLead", count: 5 },
      { dayKey: "2026-09-03", eventName: "QualifiedLead", count: 3 },
      { dayKey: "2026-09-09", eventName: "QualifiedLead", count: 99 },
      { dayKey: "2026-09-02", eventName: "LeadSubmitted", count: 40 },
    ];
    const out = sumMetaCounts(rows, ["2026-09-02", "2026-09-03"]);
    expect(out.get("QualifiedLead")).toBe(8);
    expect(out.get("LeadSubmitted")).toBe(40);
  });

  it("is empty, not zero-filled, for an event with no rows", () => {
    expect(sumMetaCounts([], ["2026-09-02"]).has("Purchase")).toBe(false);
  });
});

describe("buildReconciliation", () => {
  const events = [
    { conversationId: "c1", stage: "new_lead", eventName: "LeadSubmitted", status: "sent" },
    { conversationId: "c1", stage: "new_lead", eventName: "LeadSubmitted", status: "sent" },
    { conversationId: "c2", stage: "new_lead", eventName: "LeadSubmitted", status: "unmatched" },
    { conversationId: "c1", stage: "qualified", eventName: "QualifiedLead", status: "sent" },
  ] as const;

  it("counts reached as DISTINCT conversations, not rows", () => {
    const rows = buildReconciliation({ events: [...events], metaCounts: null });
    const newLead = rows.find((r) => r.stage === "new_lead")!;
    // c1 produced two rows for the same milestone; it is one lead.
    expect(newLead.reached).toBe(2);
  });

  it("counts delivered as distinct conversations with a sent row", () => {
    const rows = buildReconciliation({ events: [...events], metaCounts: null });
    expect(rows.find((r) => r.stage === "new_lead")!.delivered).toBe(1);
  });

  it("breaks the reached-minus-delivered gap down by status", () => {
    const rows = buildReconciliation({ events: [...events], metaCounts: null });
    const newLead = rows.find((r) => r.stage === "new_lead")!;
    expect(newLead.byStatus.sent).toBe(1);
    expect(newLead.byStatus.unmatched).toBe(1);
    expect(newLead.byStatus.error).toBe(0);
  });

  it("reports recorded and delta as null — NOT zero — when Meta is unavailable", () => {
    const rows = buildReconciliation({ events: [...events], metaCounts: null });
    for (const row of rows) {
      expect(row.recorded).toBeNull();
      expect(row.delta).toBeNull();
    }
  });

  it("reports a real zero when Meta is available and recorded nothing", () => {
    const metaCounts = new Map<string, number>([["LeadSubmitted", 1]]);
    const rows = buildReconciliation({ events: [...events], metaCounts });
    expect(rows.find((r) => r.stage === "new_lead")!.recorded).toBe(1);
    // Available, and Meta holds none of these: a genuine 0, not an unknown.
    expect(rows.find((r) => r.stage === "qualified")!.recorded).toBe(0);
  });

  it("computes delta as recorded minus delivered", () => {
    const metaCounts = new Map<string, number>([["LeadSubmitted", 3]]);
    const rows = buildReconciliation({ events: [...events], metaCounts });
    expect(rows.find((r) => r.stage === "new_lead")!.delta).toBe(2);
  });

  it("leaves internal-only stages null throughout — they are never sent", () => {
    const rows = buildReconciliation({ events: [...events], metaCounts: new Map() });
    const internal = rows.find((r) => r.stage === "itinerary_created")!;
    expect(internal.eventName).toBeNull();
    expect(internal.recorded).toBeNull();
    expect(internal.delta).toBeNull();
  });

  it("returns a row for every catalogue entry even with no events at all", () => {
    const rows = buildReconciliation({ events: [], metaCounts: null });
    expect(rows).toHaveLength(META_EVENT_CATALOGUE.length);
    expect(rows.every((r) => r.reached === 0 && r.delivered === 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/lib/metaEventStats.test.ts`
Expected: FAIL — `Failed to resolve import "./metaEventStats"`.

- [ ] **Step 3: Write the implementation**

```ts
// convex/lib/metaEventStats.ts
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
import { EVENT_STATUS_KEYS, type EventStatusKey } from "./reportStats";
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

const DAY_MS = 86_400_000;

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
  const shift = tzOffsetMinutes * 60_000;
  const firstLocalMidnight =
    Math.floor((sinceMs - shift) / DAY_MS) * DAY_MS + shift;
  const keys: string[] = [];
  for (let ms = firstLocalMidnight; ms < untilMs; ms += DAY_MS) {
    keys.push(localDayKeyFromMs(ms, tzOffsetMinutes));
  }
  return keys;
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

/** The subset of a `conversionEvents` document this fold reads. */
export interface ConversionEventFact {
  conversationId: string;
  stage: string;
  eventName: string;
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

function emptyStatusCounts(): Record<EventStatusKey, number> {
  return Object.fromEntries(EVENT_STATUS_KEYS.map((k) => [k, 0])) as Record<
    EventStatusKey,
    number
  >;
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
    const byStatus = emptyStatusCounts();
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/lib/metaEventStats.test.ts`
Expected: PASS, all cases.

If `datasetDayKeys` fails on the UTC+4 case, check the sign convention: read `convex/lib/dashboardDate.ts:41` and make the test match the real `localDayKeyFromMs` contract rather than adjusting the implementation to match a guess.

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit`
Run: `npx eslint convex/lib/metaEventStats.ts convex/lib/metaEventStats.test.ts`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/metaEventStats.ts convex/lib/metaEventStats.test.ts
git commit -m "$(cat <<'EOF'
feat(reports): pure folds for the Meta event reconciliation

Distinct conversations everywhere rather than row counts, because one
milestone can produce several outbox rows for a single lead and counting
rows would report more qualified leads than there are leads.

An unavailable Meta column is null, never 0. The two say different
things, and a report that conflates them starts lying.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Storage for Meta's counts

**Files:**
- Modify: `convex/schema.ts`
- Create: `convex/metaEventStats.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: tables `metaEventDailyStats`, `metaDatasetSyncState`; `internal.metaEventStats.upsertDayCounts({ accountId, datasetId, dayKey, counts })`; `internal.metaEventStats.putSyncState({ accountId, datasetId, tzName, tzOffsetMinutes, lastSyncedAt, lastError })`; `internal.metaEventStats.getSyncState({ accountId })`.

- [ ] **Step 1: Add the tables to the schema**

Insert immediately after the `conversionEvents` table definition (ends at `convex/schema.ts:2677` with `.index("by_account", ["accountId"]),`):

```ts
  // Meta's OWN count of what dataset `META_CAPI_DATASET_ID` received, per
  // day per event name — the third column of the Reports → Events tab.
  //
  // WHY THIS TABLE IS DAY-KEYED WHEN `messageHourlyStats` REFUSES TO BE.
  // That table's header states the rule: a day-keyed rollup has to pick a
  // timezone at WRITE time, and the reader's timezone is unknowable then,
  // so buckets are hourly UTC and re-bucketed on read.
  //
  // This table cannot follow that rule, and the reason is a property of
  // the SOURCE rather than a choice. Meta returns counts already bucketed
  // into whole days in the dataset's business timezone. That boundary is
  // baked in before we see the numbers; there are no sub-day counts to
  // re-bucket. Storing a fabricated hourly split would invent precision
  // Meta never gave us.
  //
  // The consequence is handled in `reports.metaEventReconciliation`: the
  // Events tab pins ALL THREE columns to `metaDatasetSyncState`'s offset,
  // never the viewer's. Our columns on local days against Meta's on Meta's
  // days would manufacture a delta at every window edge that looks exactly
  // like a delivery failure and is not — the same class of mismatch that
  // made the 7-day Ads figure 22.7% high (see `funnelOverview`).
  metaEventDailyStats: defineTable({
    accountId: v.id("accounts"),
    // Pinned on the row, so a dataset change cannot blend two datasets'
    // history into one silently-wrong series.
    datasetId: v.string(),
    // "YYYY-MM-DD" in the DATASET's timezone — see above.
    dayKey: v.string(),
    // Meta's wire name: LeadSubmitted, QualifiedLead, Purchase, …
    eventName: v.string(),
    count: v.number(),
    syncedAt: v.number(),
  })
    // One index, not two. With `accountId` + `datasetId` bound as
    // equalities it serves the windowed read as a `dayKey` range; with
    // `eventName` appended it serves the upsert's point lookup. A second
    // index would be one more thing to keep in sync for no new capability.
    .index("by_account_dataset_day_event", [
      "accountId",
      "datasetId",
      "dayKey",
      "eventName",
    ]),

  // One row per account: what the last dataset sync learned. Drives the
  // Events tab's header strip AND its degradation — `available: false`
  // with a `lastError` is what turns the Meta column into "—  <reason>"
  // instead of a misleading zero.
  //
  // `tzOffsetMinutes` is FETCHED, never assumed. It follows the codebase
  // convention (`localDayKeyFromMs`): local = ms - tzOffsetMinutes*60_000,
  // so UTC+4 is -240. When it cannot be determined the sync records
  // `available: false` rather than guessing, because a guessed offset
  // misaligns every column on the page.
  metaDatasetSyncState: defineTable({
    accountId: v.id("accounts"),
    datasetId: v.string(),
    available: v.boolean(),
    tzName: v.optional(v.string()),
    tzOffsetMinutes: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  }).index("by_account", ["accountId"]),
```

- [ ] **Step 2: Write the failing test**

```ts
// convex/metaEventStats.test.ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";

// This repo declares the module glob per test file rather than sharing
// a setup module — see convex/campaignAds.test.ts:11.
const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("accounts", { name: "Test", defaultCurrency: "AED" } as never),
  );
}

describe("upsertDayCounts", () => {
  it("writes one row per event name for the day", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.mutation(internal.metaEventStats.upsertDayCounts, {
      accountId,
      datasetId: "ds1",
      dayKey: "2026-09-02",
      counts: { LeadSubmitted: 40, QualifiedLead: 8 },
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.eventName === "QualifiedLead")!.count).toBe(8);
  });

  it("OVERWRITES on re-sync rather than accumulating", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    const args = {
      accountId,
      datasetId: "ds1",
      dayKey: "2026-09-02",
      counts: { QualifiedLead: 8 },
    };
    await t.mutation(internal.metaEventStats.upsertDayCounts, args);
    await t.mutation(internal.metaEventStats.upsertDayCounts, {
      ...args,
      counts: { QualifiedLead: 9 },
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(9);
  });

  it("keeps two datasets' counts for the same day apart", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.mutation(internal.metaEventStats.upsertDayCounts, {
      accountId, datasetId: "ds1", dayKey: "2026-09-02", counts: { Purchase: 1 },
    });
    await t.mutation(internal.metaEventStats.upsertDayCounts, {
      accountId, datasetId: "ds2", dayKey: "2026-09-02", counts: { Purchase: 7 },
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("putSyncState", () => {
  it("keeps exactly one row per account across repeated writes", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.mutation(internal.metaEventStats.putSyncState, {
      accountId, datasetId: "ds1", available: true,
      tzName: "Asia/Dubai", tzOffsetMinutes: -240, lastSyncedAt: 1,
    });
    await t.mutation(internal.metaEventStats.putSyncState, {
      accountId, datasetId: "ds1", available: false, lastError: "boom",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaDatasetSyncState").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].available).toBe(false);
    expect(rows[0].lastError).toBe("boom");
  });

  it("retains the last known offset through a failed sync", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.mutation(internal.metaEventStats.putSyncState, {
      accountId, datasetId: "ds1", available: true,
      tzName: "Asia/Dubai", tzOffsetMinutes: -240, lastSyncedAt: 1,
    });
    await t.mutation(internal.metaEventStats.putSyncState, {
      accountId, datasetId: "ds1", available: false, lastError: "boom",
    });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    // The offset already-synced days were written under must survive, or
    // history becomes unreadable the moment one sync fails.
    expect(state!.tzOffsetMinutes).toBe(-240);
  });
});
```

Before running: confirm the test-harness import path with `sed -n '1,15p' convex/campaignAds.test.ts` and match it exactly (`modules` may come from a different file, and `convexTest` may be set up differently). Also confirm the required fields for an `accounts` insert with `grep -n "accounts: defineTable" -A 20 convex/schema.ts` and seed all of them.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run convex/metaEventStats.test.ts`
Expected: FAIL — `internal.metaEventStats` is undefined.

- [ ] **Step 4: Write the implementation**

```ts
// convex/metaEventStats.ts
// ============================================================
// Meta dataset event counts — the third column of Reports → Events
// (docs/superpowers/specs/2026-09-03-reports-events-tab-design.md).
//
// Read-only with respect to the delivery path: nothing here changes what
// we send to Meta. It records what Meta says it received.
// ============================================================

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/**
 * Replace one day's counts for one dataset.
 *
 * UPSERT, NOT INSERT, and that is the correctness property rather than an
 * optimization: Meta's counts settle after the fact, so the cron re-syncs
 * a trailing window every night. An insert would double yesterday's
 * numbers on the second pass, and the resulting delta would read as
 * duplicate delivery — a bug in the delivery path that does not exist.
 *
 * An event absent from `counts` has its row deleted rather than left
 * behind: a stale row from a previous sync is a number Meta no longer
 * reports, and keeping it is the same lie as double-counting.
 */
export const upsertDayCounts = internalMutation({
  args: {
    accountId: v.id("accounts"),
    datasetId: v.string(),
    dayKey: v.string(),
    counts: v.record(v.string(), v.number()),
  },
  handler: async (ctx, args) => {
    const syncedAt = Date.now();
    const existing = await ctx.db
      .query("metaEventDailyStats")
      .withIndex("by_account_dataset_day_event", (q) =>
        q
          .eq("accountId", args.accountId)
          .eq("datasetId", args.datasetId)
          .eq("dayKey", args.dayKey),
      )
      .collect();
    const seen = new Set<string>();

    for (const [eventName, count] of Object.entries(args.counts)) {
      seen.add(eventName);
      const row = existing.find((r) => r.eventName === eventName);
      if (row) {
        await ctx.db.patch(row._id, { count, syncedAt });
      } else {
        await ctx.db.insert("metaEventDailyStats", {
          accountId: args.accountId,
          datasetId: args.datasetId,
          dayKey: args.dayKey,
          eventName,
          count,
          syncedAt,
        });
      }
    }
    for (const row of existing) {
      if (!seen.has(row.eventName)) await ctx.db.delete(row._id);
    }
  },
});

/**
 * One sync-state row per account, patched in place.
 *
 * A failed sync must NOT clear `tzOffsetMinutes`: already-synced days were
 * written under that offset, and losing it makes the stored history
 * unreadable. Only the fields supplied are written.
 */
export const putSyncState = internalMutation({
  args: {
    accountId: v.id("accounts"),
    datasetId: v.string(),
    available: v.boolean(),
    tzName: v.optional(v.string()),
    tzOffsetMinutes: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { accountId, ...rest } = args;
    const existing = await ctx.db
      .query("metaDatasetSyncState")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique();
    if (!existing) {
      await ctx.db.insert("metaDatasetSyncState", { accountId, ...rest });
      return;
    }
    const patch: Record<string, unknown> = {
      datasetId: rest.datasetId,
      available: rest.available,
      // Cleared on success so a fixed problem stops being reported.
      lastError: rest.available ? undefined : rest.lastError,
    };
    if (rest.tzName !== undefined) patch.tzName = rest.tzName;
    if (rest.tzOffsetMinutes !== undefined) {
      patch.tzOffsetMinutes = rest.tzOffsetMinutes;
    }
    if (rest.lastSyncedAt !== undefined) patch.lastSyncedAt = rest.lastSyncedAt;
    await ctx.db.patch(existing._id, patch);
  },
});

export const getSyncState = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) =>
    await ctx.db
      .query("metaDatasetSyncState")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique(),
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run convex/metaEventStats.test.ts`
Expected: PASS.

The codegen drift guard will fail because `convex/metaEventStats.ts` is new — that is expected and is covered by the Global Constraints. Do not run codegen.

- [ ] **Step 6: Commit**

```bash
git add convex/schema.ts convex/metaEventStats.ts convex/metaEventStats.test.ts
git commit -m "$(cat <<'EOF'
feat(reports): store Meta's dataset event counts per day

Upsert rather than insert, and the distinction is load-bearing: Meta's
counts settle after the fact so the cron re-syncs a trailing window, and
an insert would double yesterday's numbers on the second pass. The
resulting delta would read as duplicate delivery — a bug that does not
exist.

The table is day-keyed where messageHourlyStats refuses to be. Meta
returns counts already bucketed into its own business days; there is no
sub-day detail to re-bucket, and fabricating one would invent precision
Meta never gave us. The schema comment records why, and where the
consequence is handled.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Probe the Graph API

The spec's one unverified dependency: **we do not know that Meta exposes per-event counts for a WhatsApp Business dataset.** This task ships the instrument that answers it, before anything is built on the assumption.

**Files:**
- Modify: `convex/metaEventStats.ts`

**Interfaces:**
- Consumes: `internal.whatsappConfig.getForAccount` (returns `{ wabaId, accessToken }`, the token encrypted); `decrypt` from `./lib/whatsappEncryption` — the same module `conversionEvents.ts:17` imports it from.
- Produces: `internal.metaEventStats.capiStatsProbe({ accountId })` → `{ url, httpStatus, body }` or `{ error }`.

- [ ] **Step 1: Add the probe**

Modelled directly on `conversionEvents.capiProbe` (`convex/conversionEvents.ts:1287`) — read it first and mirror its shape.

```ts
// Appended to convex/metaEventStats.ts

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { decrypt } from "./lib/whatsappEncryption";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";

/**
 * Ask the configured dataset for per-event counts and return whatever
 * Meta says, verbatim.
 *
 * This exists because the read-back endpoint is UNVERIFIED — Events
 * Manager may be the only surface for these numbers. One
 * `npx convex run metaEventStats:capiStatsProbe '{"accountId":"..."}'`
 * settles it against the real dataset and the real token, which is not
 * something a unit test can do.
 *
 * Diagnostic only. Writes nothing, and is never called by the cron.
 */
export const capiStatsProbe = internalAction({
  args: { accountId: v.id("accounts") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    url?: string;
    httpStatus?: number;
    body?: unknown;
    error?: string;
  }> => {
    const datasetId = process.env.META_CAPI_DATASET_ID;
    if (!datasetId) return { error: "META_CAPI_DATASET_ID unset" };
    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId: args.accountId,
    });
    if (!config?.wabaId) return { error: "no wabaId" };
    const token =
      process.env.META_CAPI_ACCESS_TOKEN ?? (await decrypt(config.accessToken));

    const until = Math.floor(Date.now() / 1000);
    const since = until - 7 * 24 * 60 * 60;
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(datasetId)}/stats` +
      `?aggregation=event&start_time=${since}&end_time=${until}` +
      `&access_token=${encodeURIComponent(token)}`;

    try {
      const res = await fetch(url);
      return {
        // Token stripped: this value is read off a terminal and pasted
        // into issues.
        url: url.replace(/access_token=[^&]*/, "access_token=REDACTED"),
        httpStatus: res.status,
        body: await res.json().catch(() => ({})),
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
});
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run the existing suite for regressions**

Run: `npx vitest run convex/metaEventStats.test.ts convex/lib/metaEventStats.test.ts`
Expected: PASS (the probe has no unit test — it exists to hit the live API).

- [ ] **Step 4: Commit**

```bash
git add convex/metaEventStats.ts
git commit -m "$(cat <<'EOF'
feat(reports): add capiStatsProbe to verify the dataset read-back

The Graph endpoint for per-event dataset counts is unverified — Events
Manager may be the only surface for these numbers. This returns Meta's
raw answer for the configured dataset so one convex run settles it
against the real token, which no unit test can do.

Diagnostic only: writes nothing, never called by the cron, and redacts
the token from the URL it echoes back.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: STOP and report to the repo owner**

Do not run `convex run` yourself — it hits production. Report:

> Task 3 shipped `capiStatsProbe`. Running it answers whether the Meta column can carry real numbers:
> ```bash
> npx convex run metaEventStats:capiStatsProbe '{"accountId":"<accountId>"}'
> ```
> Tasks 4-7 are built to work either way — the column degrades to a stated reason if the endpoint does not exist — so implementation continues regardless. Task 4 has a step that adapts the response parser to whatever shape comes back.

---

### Task 4: Sync Meta's counts

**Files:**
- Modify: `convex/metaEventStats.ts`
- Modify: `convex/metaEventStats.test.ts`

**Interfaces:**
- Consumes: `upsertDayCounts`, `putSyncState` (Task 2).
- Produces: `internal.metaEventStats.syncDatasetStats({ accountId, trailingDays? })`.

- [ ] **Step 1: Write the failing tests**

Append to `convex/metaEventStats.test.ts`. Stub `globalThis.fetch` following `convex/campaignAds.test.ts:47` — read that file's `beforeEach`/`afterEach` and copy the restore discipline exactly, or a stub leaks into every later test in the run.

```ts
import { beforeEach, afterEach } from "vitest";

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.META_CAPI_DATASET_ID;
});
beforeEach(() => {
  process.env.META_CAPI_DATASET_ID = "ds1";
});

describe("syncDatasetStats", () => {
  it("records unavailable with a reason when the dataset is unconfigured", async () => {
    delete process.env.META_CAPI_DATASET_ID;
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(false);
    expect(state!.lastError).toMatch(/META_CAPI_DATASET_ID/);
  });

  it("records unavailable when Meta returns an error, and writes NO counts", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "nope" } }), {
        status: 400,
      })) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(false);
    expect(state!.lastError).toContain("400");
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    // A failed fetch must never be recorded as "Meta had zero events".
    expect(rows).toHaveLength(0);
  });

  it("records unavailable when the timezone cannot be determined", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    // Guessing an offset misaligns every column on the page.
    expect(state!.available).toBe(false);
    expect(state!.lastError).toMatch(/timezone/i);
  });

  it("stores counts and marks available on a good response", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          timezone_name: "Asia/Dubai",
          data: [
            { date: "2026-09-02", event: "QualifiedLead", count: 8 },
            { date: "2026-09-02", event: "LeadSubmitted", count: 40 },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const state = await t.query(internal.metaEventStats.getSyncState, { accountId });
    expect(state!.available).toBe(true);
    expect(state!.tzOffsetMinutes).toBe(-240);
    expect(state!.lastError).toBeUndefined();
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows.find((r) => r.eventName === "QualifiedLead")!.count).toBe(8);
  });

  it("is idempotent — a second sync of the same day does not double", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await seedWhatsappConfig(t, accountId);
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          timezone_name: "Asia/Dubai",
          data: [{ date: "2026-09-02", event: "QualifiedLead", count: 8 }],
        }),
        { status: 200 },
      )) as typeof fetch;
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    await t.action(internal.metaEventStats.syncDatasetStats, { accountId });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("metaEventDailyStats").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(8);
  });
});
```

Add the `seedWhatsappConfig` helper next to `seedAccount`. Read `grep -n "whatsappConfig: defineTable" -A 25 convex/schema.ts` for the required fields and insert a row with a `wabaId` and an `accessToken` the `decrypt` used in Task 3 can handle — check how `convex/conversionEvents.test.ts` seeds one and copy that verbatim.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/metaEventStats.test.ts`
Expected: FAIL — `syncDatasetStats` is not a function.

- [ ] **Step 3: Write the implementation**

```ts
// Appended to convex/metaEventStats.ts

/** How many trailing days to re-sync each run. Meta's counts settle after
 *  the fact, so the most recent days are re-read rather than trusted from
 *  their first sync. Cheap: one request covers the whole span. */
const DEFAULT_TRAILING_DAYS = 3;

/** Minutes to subtract from a UTC instant to reach local time in `tzName`,
 *  in this codebase's convention (`localDayKeyFromMs`): UTC+4 → -240.
 *  Returns null for a name the runtime cannot resolve — the caller then
 *  degrades rather than guessing. */
function offsetMinutesFor(tzName: string, at: number): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tzName,
      timeZoneName: "longOffset",
    });
    const part = fmt
      .formatToParts(new Date(at))
      .find((p) => p.type === "timeZoneName")?.value;
    // "GMT+04:00" | "GMT-05:30" | "GMT"
    const m = part?.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return part === "GMT" ? 0 : null;
    const minutes = Number(m[2]) * 60 + Number(m[3]);
    return m[1] === "+" ? -minutes : minutes;
  } catch {
    return null;
  }
}

/**
 * Pull the dataset's per-event daily counts and store them.
 *
 * EVERY failure path records `available: false` with the reason and writes
 * NO counts. Recording an empty result as "Meta had zero events" is the
 * one outcome that would make this feature actively harmful: the Events
 * tab would show a full-height delta and blame the delivery path for an
 * outage on the reporting path.
 *
 * The parser below targets `{ timezone_name, data: [{date, event, count}] }`.
 * That shape is a HYPOTHESIS until `capiStatsProbe` is run against the live
 * dataset — see Task 3. If Meta answers differently, change `parseStats`
 * and its tests; nothing else in the file depends on the wire shape.
 */
export const syncDatasetStats = internalAction({
  args: {
    accountId: v.id("accounts"),
    trailingDays: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const datasetId = process.env.META_CAPI_DATASET_ID;
    if (!datasetId) {
      await ctx.runMutation(internal.metaEventStats.putSyncState, {
        accountId: args.accountId,
        datasetId: "",
        available: false,
        lastError: "META_CAPI_DATASET_ID unset",
      });
      return;
    }

    const fail = async (lastError: string) => {
      await ctx.runMutation(internal.metaEventStats.putSyncState, {
        accountId: args.accountId,
        datasetId,
        available: false,
        lastError: lastError.slice(0, 300),
      });
    };

    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId: args.accountId,
    });
    if (!config?.wabaId) return await fail("no wabaId configured for account");
    const token =
      process.env.META_CAPI_ACCESS_TOKEN ?? (await decrypt(config.accessToken));
    if (!token) return await fail("no CAPI token — WhatsApp not connected");

    const trailingDays = args.trailingDays ?? DEFAULT_TRAILING_DAYS;
    const until = Math.floor(Date.now() / 1000);
    const since = until - trailingDays * 24 * 60 * 60;
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(datasetId)}/stats` +
      `?aggregation=event&start_time=${since}&end_time=${until}` +
      `&access_token=${encodeURIComponent(token)}`;

    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      return await fail(
        `network: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return await fail(`Graph ${res.status}: ${text.slice(0, 200)}`);
    }

    const payload = (await res.json().catch(() => null)) as {
      timezone_name?: string;
      data?: { date?: string; event?: string; count?: number }[];
    } | null;
    if (!payload) return await fail("Graph returned unparseable JSON");

    const tzName = payload.timezone_name;
    const tzOffsetMinutes = tzName ? offsetMinutesFor(tzName, Date.now()) : null;
    if (tzOffsetMinutes === null) {
      // Deliberate: an assumed offset misaligns all three columns and the
      // resulting delta is indistinguishable from a delivery failure.
      return await fail(
        `dataset timezone could not be determined (timezone_name=${tzName ?? "absent"})`,
      );
    }

    const byDay = new Map<string, Record<string, number>>();
    for (const row of payload.data ?? []) {
      if (!row.date || !row.event || typeof row.count !== "number") continue;
      const day = byDay.get(row.date) ?? {};
      day[row.event] = (day[row.event] ?? 0) + row.count;
      byDay.set(row.date, day);
    }

    for (const [dayKey, counts] of byDay) {
      await ctx.runMutation(internal.metaEventStats.upsertDayCounts, {
        accountId: args.accountId,
        datasetId,
        dayKey,
        counts,
      });
    }

    await ctx.runMutation(internal.metaEventStats.putSyncState, {
      accountId: args.accountId,
      datasetId,
      available: true,
      tzName,
      tzOffsetMinutes,
      lastSyncedAt: Date.now(),
    });
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/metaEventStats.test.ts`
Expected: PASS.

- [ ] **Step 5: Adapt the parser to reality if the probe has answered**

If the repo owner has run `capiStatsProbe` and reported the real response shape, change **only** the `payload` type, the `byDay` loop, and the corresponding test fixtures to match it. If Meta has no such endpoint, leave the code exactly as written: every path already degrades correctly, and the Events tab ships on its own two columns.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit`
Run: `npx eslint convex/metaEventStats.ts convex/metaEventStats.test.ts`

- [ ] **Step 7: Commit**

```bash
git add convex/metaEventStats.ts convex/metaEventStats.test.ts
git commit -m "$(cat <<'EOF'
feat(reports): sync Meta dataset event counts

Every failure path records unavailable with a reason and writes no
counts. Storing an empty result as "Meta had zero events" is the one
outcome that would make this actively harmful — the tab would show a
full-height delta and blame the delivery path for an outage on the
reporting path.

The timezone is fetched and resolved, never assumed. An unresolvable one
degrades rather than defaulting, because a guessed offset misaligns all
three columns and the delta it invents is indistinguishable from a real
delivery failure.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Run the sync nightly

**Files:**
- Modify: `convex/lib/cronSummary.ts`
- Modify: `convex/cronSchedules.ts`
- Modify: `convex/crons.ts`

**Interfaces:**
- Consumes: `internal.metaEventStats.syncDatasetStats` (Task 4).
- Produces: cron `meta-dataset-stats`; `internal.cronSchedules.runSyncDatasetStats`; `internal.metaEventStats.syncAllAccounts`; `internal.metaEventStats.listAccountIds`.

`cronSchedules.test.ts` asserts `CRON_REGISTRY`, `crons.ts` and the wrappers stay in sync — all three edits are one task because any one alone fails that test.

- [ ] **Step 1: Run the sync test to confirm it currently passes**

Run: `npx vitest run convex/cronSchedules.test.ts`
Expected: PASS (baseline before the change).

- [ ] **Step 2: Add the registry entry**

In `convex/lib/cronSummary.ts`, append to `CRON_REGISTRY` (after `{ name: "dashboard-snapshot", intervalMinutes: 2 },`):

```ts
  { name: "meta-dataset-stats", intervalMinutes: 1440 },
```

- [ ] **Step 3: Add the account fan-out**

`runWrapped` (the helper every wrapper in `convex/cronSchedules.ts` uses) takes a **zero-argument** function reference, but `syncDatasetStats` needs an `accountId`. So the fan-out lives in `convex/metaEventStats.ts`, mirroring `dashboard.refreshSnapshots` (`convex/dashboard.ts:133`), which enumerates with `ctx.db.query("accounts").collect()`.

Append to `convex/metaEventStats.ts`:

```ts
export const listAccountIds = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("accounts").collect()).map((a) => a._id),
});

/**
 * Cron entry point: sync every account.
 *
 * Sequential, and errors are swallowed PER ACCOUNT rather than thrown.
 * One account with a revoked token must not stop the sync for the rest —
 * and it does not go unnoticed either, because `syncDatasetStats` has
 * already recorded that account's failure in its own sync state, which is
 * what the Events tab reads.
 */
export const syncAllAccounts = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const accountIds = await ctx.runQuery(
      internal.metaEventStats.listAccountIds,
      {},
    );
    for (const accountId of accountIds) {
      try {
        await ctx.runAction(internal.metaEventStats.syncDatasetStats, {
          accountId,
        });
      } catch {
        // Already recorded per-account by syncDatasetStats' own fail path.
      }
    }
  },
});
```

Then in `convex/cronSchedules.ts`, beside the other `run*` wrappers (mirror `runRetryConversionEvents` at line 113 exactly):

```ts
export const runSyncDatasetStats = internalAction({
  args: {},
  handler: (ctx): Promise<void> =>
    runWrapped(
      ctx,
      "meta-dataset-stats",
      internal.metaEventStats.syncAllAccounts,
    ),
});
```

- [ ] **Step 4: Register the cron**

In `convex/crons.ts`, after the last `crons.interval(...)` block:

```ts
// Pull Meta's own per-event counts for the CAPI dataset into
// metaEventDailyStats — the third column of Reports → Events.
//
// Daily, and daily is the grain of the SOURCE rather than a cost choice:
// Meta returns counts already bucketed into whole business days. Each run
// re-syncs a trailing window because those counts settle after the fact;
// the upsert makes that safe.
crons.interval(
  "meta-dataset-stats",
  { minutes: 1440 },
  internal.cronSchedules.runSyncDatasetStats,
  {},
);
```

- [ ] **Step 5: Run the sync test to verify it still passes**

Run: `npx vitest run convex/cronSchedules.test.ts`
Expected: PASS — the registry, `crons.ts` and the wrapper all agree.

If it fails naming the new cron, the three names disagree. Make them identical; do not relax the test.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS, except the codegen drift guard (expected — new `convex/` files).

- [ ] **Step 7: Commit**

```bash
git add convex/crons.ts convex/cronSchedules.ts convex/lib/cronSummary.ts
git commit -m "$(cat <<'EOF'
feat(reports): run the Meta dataset sync nightly

Daily is the grain of the source rather than a cost choice — Meta
returns counts already bucketed into whole business days. Each run
re-syncs a trailing window because those counts settle after the fact,
which the upsert makes safe.

Registered through the cronSchedules wrapper so each run stamps a
cronRuns row and shows up in Settings → Cron schedules.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The reconciliation query

**Files:**
- Modify: `convex/reports.ts`
- Create: `convex/reports.metaEvents.test.ts`

**Interfaces:**
- Consumes: `buildReconciliation`, `datasetDayKeys`, `sumMetaCounts`, `META_EVENT_CATALOGUE` (Task 1); `metaDatasetSyncState`, `metaEventDailyStats` (Task 2).
- Produces: `api.reports.metaEventReconciliation({ rangeDays })` → `{ rows: MetaEventRow[], meta: { available, datasetId, tzName, tzOffsetMinutes, lastSyncedAt, lastError, sinceMs, untilMs } }`.

- [ ] **Step 1: Write the failing test**

```ts
// convex/reports.metaEvents.test.ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

// This repo declares the module glob per test file rather than sharing
// a setup module — see convex/campaignAds.test.ts:11.
const modules = import.meta.glob("/convex/**/*.ts");

// Seeding an account + a supervisor identity: copy the exact helper the
// existing report tests use — read `sed -n '1,60p' convex/reports.test.ts`
// and reuse it rather than writing a second, drifting version.

describe("metaEventReconciliation", () => {
  it("requires supervisor", async () => {
    const t = convexTest(schema, modules);
    const { asAgent } = await seedAccountWithRoles(t);
    await expect(
      asAgent.query(api.reports.metaEventReconciliation, { rangeDays: 7 }),
    ).rejects.toThrow(/FORBIDDEN/);
  });

  it("returns a row per catalogue entry with Meta unknown when never synced", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor } = await seedAccountWithRoles(t);
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    expect(out.meta.available).toBe(false);
    // Never synced is UNKNOWN, not zero.
    expect(out.rows.every((r) => r.recorded === null)).toBe(true);
  });

  it("pins the window to the DATASET timezone, not the viewer's", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithRoles(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId, datasetId: "ds1", available: true,
        tzName: "Asia/Dubai", tzOffsetMinutes: -240, lastSyncedAt: Date.now(),
      });
    });
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    expect(out.meta.tzOffsetMinutes).toBe(-240);
    // The window's lower bound is a local midnight in the DATASET's zone:
    // 00:00 Asia/Dubai is 20:00 UTC the previous day.
    expect(new Date(out.meta.sinceMs).getUTCHours()).toBe(20);
  });

  it("counts reached and delivered from conversionEvents in the window", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithRoles(t);
    await seedConversionEvent(t, accountId, { stage: "qualified", eventName: "QualifiedLead", status: "sent" });
    await seedConversionEvent(t, accountId, { stage: "qualified", eventName: "QualifiedLead", status: "unmatched" });
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    const row = out.rows.find((r) => r.stage === "qualified")!;
    expect(row.reached).toBe(2);
    expect(row.delivered).toBe(1);
    expect(row.byStatus.unmatched).toBe(1);
  });

  it("fills recorded from stored Meta counts once available", async () => {
    const t = convexTest(schema, modules);
    const { asSupervisor, accountId } = await seedAccountWithRoles(t);
    const tzOffsetMinutes = -240;
    const todayKey = new Date(Date.now() - tzOffsetMinutes * 60_000)
      .toISOString()
      .slice(0, 10);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId, datasetId: "ds1", available: true,
        tzName: "Asia/Dubai", tzOffsetMinutes, lastSyncedAt: Date.now(),
      });
      await ctx.db.insert("metaEventDailyStats", {
        accountId, datasetId: "ds1", dayKey: todayKey,
        eventName: "QualifiedLead", count: 8, syncedAt: Date.now(),
      });
    });
    const out = await asSupervisor.query(api.reports.metaEventReconciliation, {
      rangeDays: 7,
    });
    expect(out.rows.find((r) => r.stage === "qualified")!.recorded).toBe(8);
  });
});
```

Write `seedConversionEvent` to insert a `conversionEvents` row with `_creationTime` inside the window — check the required fields at `convex/schema.ts:2611` and supply all of them.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/reports.metaEvents.test.ts`
Expected: FAIL — `metaEventReconciliation` is not a function.

- [ ] **Step 3: Write the implementation**

Append to `convex/reports.ts`, and add the imports to the existing import block at the top:

```ts
import {
  buildReconciliation,
  datasetDayKeys,
  sumMetaCounts,
  META_EVENT_CATALOGUE,
} from "./lib/metaEventStats";
```

```ts
/**
 * Reports → Events: our funnel against Meta's dataset, per event.
 *
 * TAKES `rangeDays`, NOT `sinceMs`/`untilMs`, which is the one place this
 * query deliberately departs from every sibling in this file.
 *
 * The siblings take a window the CLIENT built from the viewer's local
 * midnights, which is right for them. This tab cannot use it. Meta's
 * counts arrive pre-bucketed into whole days in the DATASET's business
 * timezone, and that boundary cannot be re-bucketed on read. So the window
 * is rebuilt here from the dataset's own offset and all three columns are
 * folded against it.
 *
 * The alternative — our columns on the viewer's days, Meta's on Meta's —
 * manufactures a delta at every window edge that looks exactly like a
 * delivery failure. That is the same mismatch that made the 7-day Ads
 * figure 22.7% high; see `funnelOverview`.
 *
 * With no sync state yet there is no dataset offset to pin to, so the
 * window falls back to UTC days and `meta.available` is false — every
 * `recorded` is null, and the panel says why rather than showing zeros.
 */
export const metaEventReconciliation = accountQuery({
  args: { rangeDays: v.number() },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");

    const state = await ctx.db
      .query("metaDatasetSyncState")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();

    const tzOffsetMinutes = state?.tzOffsetMinutes ?? 0;
    const shift = tzOffsetMinutes * 60_000;
    const DAY_MS = 86_400_000;
    // Exclusive upper bound: the next local midnight in the dataset's zone,
    // matching `reportWindow`'s own convention (start of tomorrow, local).
    const untilMs =
      Math.floor((Date.now() - shift) / DAY_MS) * DAY_MS + shift + DAY_MS;
    const sinceMs = untilMs - args.rangeDays * DAY_MS;

    const events = await ctx.db
      .query("conversionEvents")
      .withIndex("by_account", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .gte("_creationTime", sinceMs)
          .lt("_creationTime", untilMs),
      )
      .collect();

    // `metaCounts === null` is the load-bearing signal: it is what makes
    // every `recorded` unknown rather than zero. Only an AVAILABLE sync
    // produces a Map, so an unsynced or failing dataset can never be
    // rendered as "Meta received nothing".
    let metaCounts: Map<string, number> | null = null;
    if (state?.available && state.datasetId) {
      const dayKeys = datasetDayKeys(sinceMs, untilMs, tzOffsetMinutes);
      const statRows = await ctx.db
        .query("metaEventDailyStats")
        .withIndex("by_account_dataset_day_event", (q) =>
          q
            .eq("accountId", ctx.accountId)
            .eq("datasetId", state.datasetId)
            .gte("dayKey", dayKeys[0])
            .lte("dayKey", dayKeys[dayKeys.length - 1]),
        )
        .collect();
      metaCounts = sumMetaCounts(statRows, dayKeys);
    }

    return {
      rows: buildReconciliation({
        events: events.map((e) => ({
          conversationId: e.conversationId as string,
          stage: e.stage,
          eventName: e.eventName,
          status: e.status,
        })),
        metaCounts,
      }),
      meta: {
        available: state?.available ?? false,
        datasetId: state?.datasetId ?? null,
        tzName: state?.tzName ?? null,
        tzOffsetMinutes,
        lastSyncedAt: state?.lastSyncedAt ?? null,
        lastError: state?.lastError ?? null,
        sinceMs,
        untilMs,
        catalogueSize: META_EVENT_CATALOGUE.length,
      },
    };
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/reports.metaEvents.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, full suite**

Run: `npx tsc --noEmit`
Run: `npx eslint convex/reports.ts convex/reports.metaEvents.test.ts`
Run: `npx vitest run`
Expected: PASS except the codegen drift guard.

- [ ] **Step 6: Commit**

```bash
git add convex/reports.ts convex/reports.metaEvents.test.ts
git commit -m "$(cat <<'EOF'
feat(reports): metaEventReconciliation query

Takes rangeDays rather than a client-built window — the one deliberate
departure from every sibling in this file. Meta's counts arrive
pre-bucketed into the dataset's own business days, a boundary that
cannot be re-bucketed on read, so the window is rebuilt from that offset
and all three columns are folded against it.

Only an available sync produces a counts Map. An unsynced or failing
dataset yields null, so it can never be rendered as "Meta received
nothing".

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The Events panel

**Files:**
- Modify: `src/lib/reports/types.ts`
- Create: `src/components/reports/events-panel.tsx`
- Modify: `src/app/(dashboard)/reports/page.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.reports.metaEventReconciliation` (Task 6); `ReportPanelProps` from `@/lib/reports/types`.
- Produces: the `events` tab.

- [ ] **Step 1: Register the tab**

In `src/lib/reports/types.ts`, add `'events'` to `REPORT_TABS` between `'funnel'` and `'billing'`:

```ts
  'funnel',
  // Windowed like its neighbours, and placed beside the funnel it reports
  // on. Its query rebuilds the window from the DATASET's timezone rather
  // than the viewer's — see `reports.metaEventReconciliation` — so the
  // range control drives it through `rangeDays` alone.
  'events',
  'billing',
```

- [ ] **Step 2: Add the copy**

In `messages/en.json`, inside `"Reports"`, add a `"tabs"` entry `"events": "Events"` and a sibling block:

```json
    "events": {
      "heading": "Meta dataset reconciliation",
      "datasetLabel": "Dataset",
      "lastSynced": "Last synced {when}",
      "neverSynced": "Never synced",
      "timezoneNote": "Days as Meta reports them ({tz})",
      "timezoneUnknown": "Days in UTC — the dataset timezone is unknown",
      "openEventsManager": "Open in Events Manager",
      "unavailable": "Meta counts unavailable — {reason}",
      "colMilestone": "Milestone (ours)",
      "colEvent": "Meta event",
      "colReached": "Reached",
      "colDelivered": "Delivered",
      "colRecorded": "Recorded",
      "colDelta": "Δ",
      "reachedTooltip": "Leads that hit this milestone in our CRM, counted once each.",
      "deliveredTooltip": "Events Meta accepted from us. The gap below Reached is ours.",
      "recordedTooltip": "Events Meta's dataset holds. The gap below Delivered is Meta's.",
      "internalOnly": "Not sent to Meta",
      "unknown": "—",
      "statusBreakdown": "Why the gap",
      "empty": "No conversion events in this range."
    }
```

Run `node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8'))"` after editing — a trailing comma here breaks the whole app, not just this tab.

- [ ] **Step 3: Write the panel**

```tsx
// src/components/reports/events-panel.tsx
'use client'

import { Fragment, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronDown, ExternalLink, Radio } from 'lucide-react'
import { useQuery } from '@/lib/convex/cached'
import { api } from '../../../convex/_generated/api'
import { Skeleton } from '@/components/dashboard/skeleton'
import { EmptyState } from '@/components/dashboard/empty-state'
import { downloadCsv } from '@/lib/reports/csv'
import { cn } from '@/lib/utils'
import type { ReportPanelProps } from '@/lib/reports/types'

/**
 * Events panel: our funnel against Meta's dataset, per event.
 *
 * THE ONE RULE THIS FILE EXISTS TO HOLD: a null `recorded` is UNKNOWN and
 * renders as an em dash with a reason. It is never coerced to 0. Meta
 * having received nothing and our not knowing what Meta received are
 * different claims, and a reconciliation table that conflates them
 * reports a delivery failure that did not happen.
 *
 * Internal-only milestones are shown greyed rather than filtered out —
 * the funnel has eight stages and hiding two implies it has six.
 */
export function EventsPanel({ reportWindow, canRead }: ReportPanelProps) {
  const t = useTranslations('Reports')
  const [expanded, setExpanded] = useState<string | null>(null)

  const data = useQuery(
    api.reports.metaEventReconciliation,
    canRead ? { rangeDays: reportWindow.dayKeys.length } : 'skip',
  )

  if (!data) return <Skeleton className="h-64 w-full" />

  const { rows, meta } = data
  const hasEvents = rows.some((r) => r.reached > 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-2 text-sm">
          <Radio className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">
            {t('events.datasetLabel')}
          </span>
          <span className="font-mono text-foreground">
            {meta.datasetId ?? t('events.unknown')}
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          {meta.tzName
            ? t('events.timezoneNote', { tz: meta.tzName })
            : t('events.timezoneUnknown')}
          {' · '}
          {meta.lastSyncedAt
            ? t('events.lastSynced', {
                when: new Date(meta.lastSyncedAt).toLocaleString(),
              })
            : t('events.neverSynced')}
        </div>
        {meta.datasetId && (
          <a
            href={`https://eventsmanager.facebook.com/events_manager2/list/dataset/${meta.datasetId}/overview`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {t('events.openEventsManager')}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      {!meta.available && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
          {t('events.unavailable', {
            reason: meta.lastError ?? t('events.neverSynced'),
          })}
        </div>
      )}

      {!hasEvents ? (
        <EmptyState title={t('events.empty')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t('events.colMilestone')}</th>
                <th className="px-3 py-2 font-medium">{t('events.colEvent')}</th>
                <th className="px-3 py-2 text-right font-medium" title={t('events.reachedTooltip')}>{t('events.colReached')}</th>
                <th className="px-3 py-2 text-right font-medium" title={t('events.deliveredTooltip')}>{t('events.colDelivered')}</th>
                <th className="px-3 py-2 text-right font-medium" title={t('events.recordedTooltip')}>{t('events.colRecorded')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('events.colDelta')}</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const internal = row.eventName === null
                const open = expanded === row.stage
                const gap = row.reached - row.delivered
                return (
                  <Fragment key={row.stage}>
                  <tr
                    className={cn(
                      'border-b border-border last:border-0',
                      internal && 'text-muted-foreground',
                    )}
                  >
                    <td className="px-3 py-2">{row.label}</td>
                    <td className="px-3 py-2 font-mono text-xs">
                      {row.eventName ?? t('events.internalOnly')}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{row.reached}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {internal ? t('events.unknown') : row.delivered}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {/* null is UNKNOWN, never 0 — see this file's header. */}
                      {row.recorded === null ? t('events.unknown') : row.recorded}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2 text-right tabular-nums',
                        row.delta !== null && row.delta !== 0 && 'text-amber-600',
                      )}
                    >
                      {row.delta === null
                        ? t('events.unknown')
                        : row.delta > 0
                          ? `+${row.delta}`
                          : row.delta}
                    </td>
                    <td className="px-3 py-2">
                      {gap > 0 && (
                        <button
                          type="button"
                          aria-label={t('events.statusBreakdown')}
                          onClick={() => setExpanded(open ? null : row.stage)}
                        >
                          <ChevronDown
                            className={cn('h-4 w-4 transition-transform', open && 'rotate-180')}
                          />
                        </button>
                      )}
                    </td>
                  </tr>
                  {/* The reached-minus-delivered gap, itemised. Only
                      non-zero statuses are listed: a row of zeros is
                      noise, and the whole point of this drawer is to
                      name the one status that accounts for the gap. */}
                  {open && gap > 0 && (
                    <tr className="border-b border-border bg-muted/30">
                      <td colSpan={7} className="px-3 py-2">
                        <div className="text-xs text-muted-foreground">
                          {t('events.statusBreakdown')}
                        </div>
                        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                          {Object.entries(row.byStatus)
                            .filter(([, count]) => count > 0)
                            .map(([status, count]) => (
                              <li key={status} className="tabular-nums">
                                <span className="font-mono">{status}</span>{' '}
                                {count}
                              </li>
                            ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {hasEvents && (
        <button
          type="button"
          onClick={() =>
            downloadCsv(
              'meta-events.csv',
              ['milestone', 'event', 'reached', 'delivered', 'recorded', 'delta'],
              rows.map((r) => [
                r.label,
                r.eventName ?? '',
                r.reached,
                r.delivered,
                // Empty cell, not 0: an unknown must not become a number
                // the moment it leaves the screen for a spreadsheet.
                r.recorded === null ? null : r.recorded,
                r.delta === null ? null : r.delta,
              ]),
            )
          }
          className="text-sm text-primary hover:underline"
        >
          {t('exportCsv')}
        </button>
      )}
    </div>
  )
}
```

`downloadCsv(filename, headers, rows)` and `EmptyState({ title, hint, icon, className })` are the real signatures (`src/lib/reports/csv.ts:50`, `src/components/dashboard/empty-state.tsx:13`).

- [ ] **Step 4: Write the panel test**

Static-render, no jsdom and no Testing Library — match `src/components/reports/agents-panel.test.tsx`, which is the convention here. Read its first 40 lines before writing; rendering against the REAL `messages/en.json` is what makes a typo'd `Reports.events.*` key fail here instead of shipping a raw key string to screen.

```tsx
// src/components/reports/events-panel.test.tsx
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../../messages/en.json";

const useQuery = vi.fn();
vi.mock("@/lib/convex/cached", () => ({
  useQuery: (...args: unknown[]) => useQuery(...args),
}));

const { EventsPanel } = await import("./events-panel");

const reportWindow = {
  sinceMs: 0,
  untilMs: 1,
  dayKeys: ["2026-09-01", "2026-09-02", "2026-09-03"],
} as never;

function render(data: unknown) {
  useQuery.mockReturnValue(data);
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <EventsPanel reportWindow={reportWindow} canRead />
    </NextIntlClientProvider>,
  );
}

const baseRow = {
  stage: "qualified",
  label: "Qualified lead",
  eventName: "QualifiedLead",
  reached: 9,
  delivered: 8,
  byStatus: { pending: 0, sent: 8, unmatched: 1, error: 0, abandoned: 0, dormant: 0 },
  recorded: null as number | null,
  delta: null as number | null,
};

describe("EventsPanel", () => {
  it("renders an unknown Meta count as an em dash, never as zero", () => {
    const html = render({
      rows: [baseRow],
      meta: {
        available: false, datasetId: "ds1", tzName: null, tzOffsetMinutes: 0,
        lastSyncedAt: null, lastError: "Graph 400: no such edge",
        sinceMs: 0, untilMs: 1, catalogueSize: 8,
      },
    });
    expect(html).toContain("—");
    expect(html).toContain("Graph 400: no such edge");
    // The delta cell must not claim -8 from an unknown.
    expect(html).not.toContain("-8");
  });

  it("renders a real zero when Meta is available and recorded none", () => {
    const html = render({
      rows: [{ ...baseRow, recorded: 0, delta: -8 }],
      meta: {
        available: true, datasetId: "ds1", tzName: "Asia/Dubai",
        tzOffsetMinutes: -240, lastSyncedAt: Date.now(), lastError: null,
        sinceMs: 0, untilMs: 1, catalogueSize: 8,
      },
    });
    expect(html).toContain("-8");
    expect(html).toContain("Asia/Dubai");
  });

  it("labels an internal-only milestone rather than hiding it", () => {
    const html = render({
      rows: [{ ...baseRow, stage: "itinerary_created", label: "Itinerary created",
               eventName: null, recorded: null, delta: null }],
      meta: {
        available: true, datasetId: "ds1", tzName: "Asia/Dubai",
        tzOffsetMinutes: -240, lastSyncedAt: Date.now(), lastError: null,
        sinceMs: 0, untilMs: 1, catalogueSize: 8,
      },
    });
    expect(html).toContain("Itinerary created");
    expect(html).toContain("Not sent to Meta");
  });

  it("passes the range through as rangeDays", () => {
    render({ rows: [], meta: { available: false, datasetId: null, tzName: null,
      tzOffsetMinutes: 0, lastSyncedAt: null, lastError: null,
      sinceMs: 0, untilMs: 1, catalogueSize: 8 } });
    expect(useQuery).toHaveBeenCalledWith(expect.anything(), { rangeDays: 3 });
  });
});
```

Run: `npx vitest run src/components/reports/events-panel.test.tsx`
Expected: PASS. If the em-dash assertion fails, the panel is coercing null to 0 — fix the panel, not the test.

- [ ] **Step 5: Render the panel**

In `src/app/(dashboard)/reports/page.tsx`, add the import beside the others and the branch after the `funnel` line:

```tsx
import { EventsPanel } from '@/components/reports/events-panel'
```

```tsx
      {tab === 'events' && <EventsPanel reportWindow={reportWindow} canRead={canRead} />}
```

- [ ] **Step 6: Typecheck, lint, build**

Run: `npx tsc --noEmit`
Run: `npx eslint src/components/reports/events-panel.tsx src/app/\(dashboard\)/reports/page.tsx src/lib/reports/types.ts`
Run: `node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8'))"`
Expected: all clean.

- [ ] **Step 7: Verify no server code reached the browser bundle**

The panel must not pull `convex/reports.ts` into the client bundle. Confirm the only cross-boundary import is the generated `api`:

Run: `grep -n "convex/" src/components/reports/events-panel.tsx`
Expected: only `../../../convex/_generated/api`. If a constant is needed from the backend, move it to `convex/lib/reportStats.ts` or `convex/lib/metaEventStats.ts` and import from there.

- [ ] **Step 8: Commit**

```bash
git add src/lib/reports/types.ts src/components/reports/events-panel.tsx \
        src/components/reports/events-panel.test.tsx \
        "src/app/(dashboard)/reports/page.tsx" messages/en.json
git commit -m "$(cat <<'EOF'
feat(reports): Events tab comparing our funnel to Meta's dataset

Three counts per event: reached, delivered, recorded. The first gap is
ours and expands into the delivery statuses that caused it; the second
is Meta's.

A null recorded value renders as an em dash with a stated reason and is
never coerced to zero — Meta receiving nothing and our not knowing what
Meta received are different claims, and conflating them reports a
delivery failure that did not happen. Internal-only milestones are shown
greyed rather than hidden, so the tab does not imply a six-stage funnel.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification Before Done

- [ ] `npx vitest run` — passes except the codegen drift guard (expected for new `convex/` files; the repo owner runs codegen).
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx eslint` over every changed file — clean.
- [ ] `messages/en.json` parses.
- [ ] `npx vitest run src/components/reports/events-panel.test.tsx` — passes.
- [ ] `grep -rn "convex/reports" src/components/reports/events-panel.tsx` returns nothing.
- [ ] Report to the repo owner: codegen is needed, and `capiStatsProbe` should be run to confirm whether the Meta column can carry real numbers.

## Known Gaps

- **RESOLVED 2026-09-03 — the Graph read-back endpoint does not exist.** The probe was run against the live dataset: `/stats` is a web-pixel edge that a business-messaging dataset does not populate, and `timezone_name` is absent from both the edge and the dataset object. Task 4's hypothesised `{ timezone_name, data: [{date, event, count}] }` parser is therefore dead code that will never match a real response — it is retained because the sync fails closed before reaching it, and rewriting it would be speculation about an API Meta does not document. See the spec's "Unverified dependency — RESOLVED" section for the full probe table and reasoning.
- **No backfill.** The Meta column starts at the first successful sync. Meta's stats retention is unknown, so the tab shows the range it has.
- **Nothing about what we send changes.** This plan is read-only with respect to the delivery path.
