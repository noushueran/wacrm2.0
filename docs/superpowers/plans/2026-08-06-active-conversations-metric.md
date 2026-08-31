# Active Conversations Metric Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a seventh `messageHourlyStats` counter measuring how many distinct conversations saw traffic, surfaced as a tile and its own chart on the Reports Conversations tab.

**Architecture:** Distinctness comes from a `lastActiveDayMs` marker on the conversation, compared against the message's UTC day at the single `insert("messages")` choke point — which already holds the conversation document and already patches it, so the counter costs no extra read and no extra document. Deduping per UTC **day** rather than per hour is load-bearing: distinct counts are not additive across buckets, so an hourly dedup summed into a day would yield conversation-*hours* and could exceed the account's total conversation count.

**Tech Stack:** Convex (schema/mutations/queries), Next.js App Router, React, `recharts`, `next-intl`, `vitest` + `convex-test`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-06-active-conversations-metric-design.md`. Read it before Task 1.
- **Never run `convex deploy`, `convex dev`, or `convex codegen`.** The owner runs these.
- **Do not run the backfill.** It is a one-shot internal mutation the owner triggers.
- **New schema fields are `v.optional`** and every reader treats absent as zero. `activeConversations` on `messageHourlyStats`; `lastActiveDayMs` on `conversations`.
- **Never import from `convex/reports.ts` (or any `convex/` query module) in a client component.** It ships Convex server code to the browser — query handler bodies, table and index names, and the `requireRole` authorization wrapper — because webpack does not tree-shake it. Shared constants live in `convex/lib/reportStats.ts`, which is database-free by design.
- **Every new/changed Convex query stays on `accountQuery` with `ctx.requireRole("supervisor")`** and takes no `accountId` argument.
- **Verification gate:** `npx tsc --noEmit`, `npx eslint <changed files>`, `npx vitest run`, and `npm run build`. There is no deployed backend on this branch — **do not start a dev server and do not claim any page renders.**
- **No `any`.** `npx eslint` must report no `no-explicit-any`.
- **Test command:** `npx vitest run <path>`. **Lint scope:** changed files only.
- **Commit message bodies end with:** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **Timezone convention:** `tzOffsetMinutes` matches `Date.prototype.getTimezoneOffset()` — UTC minus local (UTC+4 → `-240`).

---

## File Structure

**Modify:**
| File | Change |
|---|---|
| `convex/lib/messageStats.ts` | Add `utcDayStartMs`, beside the existing `hourStartMs`. |
| `convex/lib/messageStats.test.ts` | Tests for it. |
| `convex/schema.ts` | `messageHourlyStats.activeConversations`; `conversations.lastActiveDayMs`. |
| `convex/messages.ts` | The write hook in `insertMessageAndUpdateConversation`; the new backfill. |
| `convex/messages.test.ts` | Write-hook and backfill tests. |
| `convex/lib/reportStats.ts` | `activeConversations` in `ReportHourRow` and `VolumeTotals`; folded in `foldHoursIntoVolume`. |
| `convex/lib/reportStats.test.ts` | Fold tests. |
| `convex/reports.ts` | `volume` returns the new field in `series` and `totals`. |
| `convex/reports.test.ts` | Query test. |
| `src/components/reports/conversations-panel.tsx` | Tile, chart, CSV column. |
| `messages/en.json` | Copy. |

No new files. Every change extends something that exists.

---

### Task 1: `utcDayStartMs` + schema fields

**Files:**
- Modify: `convex/lib/messageStats.ts`
- Modify: `convex/lib/messageStats.test.ts`
- Modify: `convex/schema.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `utcDayStartMs(ms: number): number` from `convex/lib/messageStats.ts`; `messageHourlyStats.activeConversations?: number`; `conversations.lastActiveDayMs?: number`.

- [ ] **Step 1: Write the failing test**

Append to `convex/lib/messageStats.test.ts`:

```ts
import { utcDayStartMs, DAY_MS } from "./messageStats";

describe("utcDayStartMs", () => {
  it("floors to the containing UTC day", () => {
    const t = Date.parse("2026-08-06T13:42:17.512Z");
    expect(utcDayStartMs(t)).toBe(Date.parse("2026-08-06T00:00:00.000Z"));
  });

  it("is idempotent on an exact day boundary", () => {
    const t = Date.parse("2026-08-06T00:00:00.000Z");
    expect(utcDayStartMs(t)).toBe(t);
  });

  it("puts the last millisecond of a day in that day, not the next", () => {
    const t = Date.parse("2026-08-06T23:59:59.999Z");
    expect(utcDayStartMs(t)).toBe(Date.parse("2026-08-06T00:00:00.000Z"));
  });

  // The dedup marker is compared for equality against this, so two instants
  // in the same UTC day must produce the SAME number — that equality is the
  // whole mechanism.
  it("returns the same value for any two instants in one UTC day", () => {
    const a = utcDayStartMs(Date.parse("2026-08-06T00:00:00.000Z"));
    const b = utcDayStartMs(Date.parse("2026-08-06T23:00:00.000Z"));
    expect(a).toBe(b);
  });

  it("exposes DAY_MS as 24 hours", () => {
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/messageStats.test.ts`
Expected: FAIL — `utcDayStartMs` / `DAY_MS` are not exported.

- [ ] **Step 3: Write the implementation**

In `convex/lib/messageStats.ts`, directly below the existing `hourStartMs`:

```ts
export const DAY_MS = 24 * HOUR_MS;

/**
 * The start of the UTC day containing `ms`. The dedup key for
 * `activeConversations`.
 *
 * UTC and not local, for the same reason the buckets themselves are UTC: a
 * Convex function runs in UTC and the viewer's offset arrives per request, so
 * a local-day key would have to choose a timezone at write time.
 *
 * The consequence is documented rather than hidden — a UTC+4 local day spans
 * two UTC days, so a thread active both before ~04:00 local and again later
 * counts twice in that local day. Business-hours traffic (09:00-18:00 local =
 * 05:00-14:00 UTC) falls in one UTC day and counts once.
 */
export function utcDayStartMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/lib/messageStats.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the schema fields**

In `convex/schema.ts`, in `messageHourlyStats`, after `billedMessagesByCategory`:

```ts
    /** Distinct conversations that saw any traffic — inbound or outbound.
     *  Deduped per UTC DAY, not per hour: distinct counts are not additive
     *  across buckets, so an hourly dedup summed into a day would yield
     *  conversation-HOURS and could exceed the account's total conversation
     *  count. The increment lands on the hour of the conversation's first
     *  message of that UTC day, so the rollup stays hourly and the existing
     *  local-day fold keeps working. See `conversations.lastActiveDayMs`. */
    activeConversations: v.optional(v.number()),
```

In `conversations`, beside the other denormalized activity fields:

```ts
    /** UTC midnight of the day this conversation was last counted toward
     *  `messageHourlyStats.activeConversations`. Compared for equality at the
     *  message choke point; a difference means "not yet counted today", which
     *  IS the dedup. Written in the patch that already happens on every
     *  message, so it costs no extra read and no extra document.
     *
     *  Not backfilled: it is a forward-looking marker, and an absent value
     *  correctly means the next message counts its day. */
    lastActiveDayMs: v.optional(v.number()),
```

- [ ] **Step 6: Verify nothing existing regressed**

Run: `npx vitest run convex/schema.test.ts convex/messages.test.ts convex/dashboard.test.ts convex/reports.test.ts`
Expected: PASS. Additive optional fields must not disturb any existing suite; a failure means the edit changed something that already existed.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/lib/messageStats.ts convex/lib/messageStats.test.ts convex/schema.ts
git add convex/lib/messageStats.ts convex/lib/messageStats.test.ts convex/schema.ts
git commit -m "feat(reports): utcDayStartMs and the activeConversations schema fields

Deduping per UTC day rather than per hour is load-bearing — distinct
counts are not additive across buckets.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The write hook

**Files:**
- Modify: `convex/messages.ts` (`insertMessageAndUpdateConversation`)
- Modify: `convex/messages.test.ts`

**Interfaces:**
- Consumes: `utcDayStartMs`, `hourStartMs` from `./lib/messageStats`.
- Produces: `messageHourlyStats.activeConversations` populated on write; `conversations.lastActiveDayMs` maintained.

- [ ] **Step 1: Write the failing tests**

Append to `convex/messages.test.ts`. Reuse the file's existing `seedThread(t, email)` helper (around line 948) and its established `vi.useFakeTimers({ toFake: ["Date"] })` discipline — `convex-test` derives `_creationTime` from `Date.now()` and clamps it forward only, so seed in non-decreasing time order.

```ts
// THE property this whole design exists for. A per-HOUR dedup passes the
// naive "twice in one hour" case and is still wrong; this test is what
// distinguishes them.
test("a thread messaged across several hours of one UTC day counts once", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
    vi.setSystemTime(dayStart + 2 * HOUR_MS);
    const { accountId, conversationId } = await seedThread(t, "a@x.com");

    for (const offsetHours of [2, 5, 9, 17]) {
      vi.setSystemTime(dayStart + offsetHours * HOUR_MS);
      await t.mutation(internal.messages.appendInternal, {
        accountId,
        conversationId,
        senderType: offsetHours % 2 === 0 ? "customer" : "agent",
        contentType: "text",
        contentText: `msg ${offsetHours}`,
      });
    }

    const total = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
        .collect();
      return rows.reduce((s, r) => s + (r.activeConversations ?? 0), 0);
    });
    expect(total).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test("the increment lands on the hour of the day's FIRST message", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
    const firstAt = dayStart + 3 * HOUR_MS;
    vi.setSystemTime(firstAt);
    const { accountId, conversationId } = await seedThread(t, "b@x.com");

    await t.mutation(internal.messages.appendInternal, {
      accountId, conversationId, senderType: "customer",
      contentType: "text", contentText: "first",
    });
    vi.setSystemTime(dayStart + 11 * HOUR_MS);
    await t.mutation(internal.messages.appendInternal, {
      accountId, conversationId, senderType: "agent",
      contentType: "text", contentText: "later",
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) =>
          q.eq("accountId", accountId).eq("hourStartMs", hourStartMs(firstAt)),
        )
        .unique(),
    );
    expect(row?.activeConversations).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

// The marker must not latch permanently.
test("the same thread counts again the next UTC day", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
    vi.setSystemTime(dayStart + HOUR_MS);
    const { accountId, conversationId } = await seedThread(t, "c@x.com");

    for (const at of [dayStart + HOUR_MS, dayStart + DAY_MS + HOUR_MS]) {
      vi.setSystemTime(at);
      await t.mutation(internal.messages.appendInternal, {
        accountId, conversationId, senderType: "customer",
        contentType: "text", contentText: "hi",
      });
    }

    const total = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
        .collect();
      return rows.reduce((s, r) => s + (r.activeConversations ?? 0), 0);
    });
    expect(total).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("two different threads in one day count separately", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
    vi.setSystemTime(dayStart + HOUR_MS);
    const first = await seedThread(t, "d@x.com");
    const second = await seedThread(t, "e@x.com");

    for (const conv of [first, second]) {
      await t.mutation(internal.messages.appendInternal, {
        accountId: conv.accountId, conversationId: conv.conversationId,
        senderType: "customer", contentType: "text", contentText: "hi",
      });
    }

    const total = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) => q.eq("accountId", first.accountId))
        .collect();
      return rows.reduce((s, r) => s + (r.activeConversations ?? 0), 0);
    });
    expect(total).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
```

Add `utcDayStartMs`, `DAY_MS`, `HOUR_MS`, `hourStartMs` to that file's `./lib/messageStats` import. If `seedThread` returns two accounts for two calls, adapt the last test to seed both threads under one account — read the helper before assuming its shape.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/messages.test.ts -t "UTC day"`
Expected: FAIL — `activeConversations` is `undefined`, so the totals are 0.

- [ ] **Step 3: Add the bump helper**

In `convex/messages.ts`, beside `bumpConversationStartedStat`:

```ts
/**
 * +1 on `activeConversations` for the hour containing `atMs`.
 *
 * Called only when the caller has established this conversation has not yet
 * been counted for this UTC day — the caller owns the dedup, this function
 * owns the write, exactly like `bumpConversationStartedStat`.
 *
 * `incoming`/`outgoing` are seeded to 0 on insert because the schema requires
 * them and this may be the hour's first write.
 */
async function bumpActiveConversationStat(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  atMs: number,
): Promise<void> {
  const bucketStart = hourStartMs(atMs);
  const existing = await ctx.db
    .query("messageHourlyStats")
    .withIndex("by_account_hour", (q) =>
      q.eq("accountId", accountId).eq("hourStartMs", bucketStart),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      activeConversations: (existing.activeConversations ?? 0) + 1,
    });
    return;
  }

  await ctx.db.insert("messageHourlyStats", {
    accountId,
    hourStartMs: bucketStart,
    incoming: 0,
    outgoing: 0,
    activeConversations: 1,
  });
}
```

- [ ] **Step 4: Wire it into the message choke point**

In `insertMessageAndUpdateConversation`, immediately after the existing `await recordMessageInHourlyStats(ctx, accountId, senderType);` and before the `const now = Date.now();` that builds the patch, replace that `now` declaration so a single timestamp serves both, then add the hook:

```ts
  const now = Date.now();

  // Distinct conversations with traffic, deduped per UTC DAY. The comparison
  // IS the dedup: a stored marker equal to today's UTC day means this thread
  // has already been counted, whatever else it does today.
  //
  // Deliberately per-day and not per-hour. Distinct counts are not additive
  // across buckets, so an hourly dedup summed into a day would count a thread
  // active at 09:00 and 15:00 twice — yielding conversation-HOURS, a figure
  // that can exceed the account's total conversation count.
  //
  // Costs nothing extra: `conversation` is already in hand, and
  // `lastActiveDayMs` rides the patch built below that already runs on every
  // message.
  const activeDay = utcDayStartMs(now);
  const alreadyCountedToday = conversation.lastActiveDayMs === activeDay;
  if (!alreadyCountedToday) {
    await bumpActiveConversationStat(ctx, accountId, now);
  }
```

Then add `lastActiveDayMs` to the patch's type union and its object literal:

```ts
    lastActiveDayMs: number;
```
```ts
    lastActiveDayMs: activeDay,
```

Add `utcDayStartMs` to the `./lib/messageStats` import.

> Setting `lastActiveDayMs` unconditionally (rather than only when it changed) is deliberate: patching the same value over itself is free, and a guard is one more branch that can go stale — the same reasoning the surrounding code applies to `snoozedUntil`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run convex/messages.test.ts convex/dashboard.test.ts convex/reports.test.ts`
Expected: PASS, including every pre-existing test — this touches the hottest write path in the app.

- [ ] **Step 6: Prove the dedup is per-day, not per-hour**

Temporarily change `utcDayStartMs(now)` to `hourStartMs(now)` in the hook. Run `npx vitest run convex/messages.test.ts -t "several hours of one UTC day"`. It MUST fail (expecting 1, receiving 4). Revert, re-run, confirm it passes. Record both observations in your report — a test that passes under both is worthless here, and the per-hour variant is the plausible wrong implementation.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/messages.ts convex/messages.test.ts
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(reports): count distinct active conversations per UTC day

The dedup is the comparison against the conversation's stored marker, so
the counter rides the patch that already happens on every message — no
extra read, no extra document.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The backfill

**Files:**
- Modify: `convex/messages.ts` (end of file)
- Modify: `convex/messages.test.ts`

**Interfaces:**
- Consumes: `utcDayStartMs`, `hourStartMs`, `DAY_MS` from `./lib/messageStats`.
- Produces: `internal.messages.backfillActiveConversationStats`.

**Read `backfillConversationStartedStats` in the same file before starting.** This backfill is its sibling — batched, self-scheduling per account, cursor-threaded, idempotent by SET-not-increment — with one structural difference described below.

- [ ] **Step 1: Write the failing test**

Append to `convex/messages.test.ts`:

```ts
test("backfillActiveConversationStats counts distinct conversation-days, idempotently", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
    vi.setSystemTime(dayStart);
    const accountId = await t.run(async (ctx) =>
      ctx.db.insert("accounts", {
        name: "Acme", defaultCurrency: "AED",
        ownerUserId: await ctx.db.insert("users", { email: "o@x.com" }),
      }),
    );

    // Seed raw messages directly, bypassing the write path, to simulate rows
    // that predate the counter. Thread A: 3 messages across day 1 plus 1 on
    // day 2 -> 2. Thread B: 1 message on day 1 -> 1. Expected total 3.
    await t.run(async (ctx) => {
      const mk = async (email: string) => {
        const contactId = await ctx.db.insert("contacts", {
          accountId, phone: `+9715${email.charCodeAt(0)}0000000`,
          phoneNormalized: `9715${email.charCodeAt(0)}0000000`,
        });
        return ctx.db.insert("conversations", {
          accountId, contactId, status: "open",
          unreadCount: 0, awaitingReply: true,
        });
      };
      const a = await mk("a");
      const b = await mk("b");
      const at = async (conversationId: typeof a, offsetMs: number) => {
        vi.setSystemTime(dayStart + offsetMs);
        await ctx.db.insert("messages", {
          accountId, conversationId, senderType: "customer",
          contentType: "text", status: "sent",
        });
      };
      await at(a, HOUR_MS);
      await at(b, 2 * HOUR_MS);
      await at(a, 6 * HOUR_MS);
      await at(a, 20 * HOUR_MS);
      await at(a, DAY_MS + 3 * HOUR_MS);
    });

    const runAll = async () => {
      await t.mutation(internal.messages.backfillActiveConversationStats, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    };
    const total = async () =>
      t.run(async (ctx) => {
        const rows = await ctx.db
          .query("messageHourlyStats")
          .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
          .collect();
        return rows.reduce((s, r) => s + (r.activeConversations ?? 0), 0);
      });

    await runAll();
    expect(await total()).toBe(3);
    // Converges rather than doubling — the property that makes a resumable
    // backfill safe to re-trigger after an interruption.
    await runAll();
    expect(await total()).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/messages.test.ts -t "backfillActiveConversationStats"`
Expected: FAIL — the function does not exist.

- [ ] **Step 3: Write the implementation**

Append to `convex/messages.ts`:

```ts
// ============================================================
// One-shot backfill for `activeConversations`.
//
//   npx convex run messages:backfillActiveConversationStats
//
// IDEMPOTENT by rebuilding whole UTC DAYS rather than incrementing — each
// pass SETs the buckets it just measured, exactly as its siblings do.
//
// THE STRUCTURAL DIFFERENCE FROM ITS SIBLINGS: they withhold the final
// partial HOUR of a batch, which guarantees an hour never straddles two
// batches. This backfill needs DAY-level distinctness, so it withholds the
// final partial DAY and resumes at that day's start — the same idea one unit
// coarser. Without it, a conversation whose messages for one day span a batch
// boundary would be counted once per batch.
//
// That raises the worst case from an hour of messages to a day of them, which
// is why the batch size below is its own constant rather than the shared
// `BACKFILL_BATCH`.
//
// NOT concurrency-safe: run one chain and let it finish.
// ============================================================

/** Messages read per batch. Sized against a DAY of traffic (see above), not an
 *  hour, while staying well under Convex's 4096-document read ceiling
 *  alongside this mutation's own bucket upserts. */
const ACTIVE_BACKFILL_BATCH = 1000;

export const backfillActiveConversationStats = internalMutation({
  args: {
    accountId: v.optional(v.id("accounts")),
    cursorMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const accounts = await ctx.db.query("accounts").collect();
    if (accounts.length === 0) return;

    const index = args.accountId
      ? accounts.findIndex((a) => a._id === args.accountId)
      : 0;
    if (index < 0) return;
    const account = accounts[index]!;

    const advanceToNextAccount = async () => {
      const next = accounts[index + 1];
      if (!next) return;
      await ctx.scheduler.runAfter(
        0,
        internal.messages.backfillActiveConversationStats,
        { accountId: next._id },
      );
    };

    const batch = await ctx.db
      .query("messages")
      .withIndex("by_account", (q) =>
        args.cursorMs === undefined
          ? q.eq("accountId", account._id)
          : q.eq("accountId", account._id).gte("_creationTime", args.cursorMs),
      )
      .take(ACTIVE_BACKFILL_BATCH);

    if (batch.length === 0) {
      await advanceToNextAccount();
      return;
    }

    // For each (conversation, UTC day), the hour of its EARLIEST message —
    // mirroring exactly what the live write path records.
    const firstHourByPair = new Map<string, number>();
    for (const m of batch) {
      const day = utcDayStartMs(m._creationTime);
      const key = `${m.conversationId}:${day}`;
      const hour = hourStartMs(m._creationTime);
      const prior = firstHourByPair.get(key);
      if (prior === undefined || hour < prior) firstHourByPair.set(key, hour);
    }

    // Count those pairs into the hour buckets they belong to.
    const perHour = new Map<number, number>();
    for (const hour of firstHourByPair.values()) {
      perHour.set(hour, (perHour.get(hour) ?? 0) + 1);
    }

    const sortedDays = [
      ...new Set(batch.map((m) => utcDayStartMs(m._creationTime))),
    ].sort((a, b) => a - b);
    const isFullBatch = batch.length === ACTIVE_BACKFILL_BATCH;

    // A full batch almost certainly stops mid-day. Withhold that last day and
    // resume from its start, so a day is only written once observed
    // end-to-end — that is what keeps SET idempotent AND what makes per-day
    // distinctness correct across batches.
    //
    // Unless the whole batch is ONE day: withholding it would rewind the
    // cursor to where it already is and loop forever. That needs more than
    // ACTIVE_BACKFILL_BATCH messages in a single day; handled by writing what
    // was measured and stepping past, with a warning.
    const singleDayOverflow = isFullBatch && sortedDays.length === 1;
    const daysToWrite = new Set(
      isFullBatch && !singleDayOverflow ? sortedDays.slice(0, -1) : sortedDays,
    );

    if (singleDayOverflow) {
      console.warn(
        `[backfill] account ${account._id}: day ${new Date(sortedDays[0]!).toISOString()} has more than ${ACTIVE_BACKFILL_BATCH} messages; its active-conversation bucket may undercount`,
      );
    }

    // Only hours belonging to a day we are writing.
    const hoursToWrite = [...perHour.entries()].filter(([hour]) =>
      daysToWrite.has(utcDayStartMs(hour)),
    );

    for (const [hour, count] of hoursToWrite) {
      const existing = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) =>
          q.eq("accountId", account._id).eq("hourStartMs", hour),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { activeConversations: count });
      } else {
        await ctx.db.insert("messageHourlyStats", {
          accountId: account._id,
          hourStartMs: hour,
          incoming: 0,
          outgoing: 0,
          activeConversations: count,
        });
      }
    }

    if (!isFullBatch) {
      await advanceToNextAccount();
      return;
    }

    const resumeFrom = singleDayOverflow
      ? sortedDays[0]! + DAY_MS
      : sortedDays[sortedDays.length - 1]!;
    await ctx.scheduler.runAfter(
      0,
      internal.messages.backfillActiveConversationStats,
      { accountId: account._id, cursorMs: resumeFrom },
    );
  },
});
```

> **A hazard to be deliberate about:** an hour can hold the first message of a withheld day *and* of a written day only if those are different days, which cannot happen — an hour belongs to exactly one UTC day. So filtering hours by `utcDayStartMs(hour)` is exact, not approximate. Verify that reasoning holds before relying on it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Make the batch size injectable and pin the multi-batch path**

Every test so far seeds a handful of messages against a 1000-message batch, so `cursorMs` is never non-`undefined` and the withheld-partial-day logic never executes — the riskiest code in this task would be hand-verified only. The previous branch solved this by threading an optional test-only `batchSize`; do the same.

Add `batchSize: v.optional(v.number())` to the args, resolve it as `args.batchSize ?? ACTIVE_BACKFILL_BATCH`, and thread it through **both** `ctx.scheduler.runAfter` calls so a chain cannot silently revert to the default mid-run. Production behaviour is unchanged.

Then add:

```ts
test("backfill keeps per-day distinctness across a batch boundary", async () => {
  const t = convexTest(schema, modules);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
    vi.setSystemTime(dayStart);
    const accountId = await t.run(async (ctx) =>
      ctx.db.insert("accounts", {
        name: "Acme", defaultCurrency: "AED",
        ownerUserId: await ctx.db.insert("users", { email: "o2@x.com" }),
      }),
    );

    // ONE conversation, five messages spread across ONE UTC day. With
    // batchSize 2 the day spans three batches — so a naive implementation
    // that wrote each batch's findings would count this thread up to three
    // times. The withheld-partial-day logic is what makes it 1.
    await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId, phone: "+971500000900", phoneNormalized: "971500000900",
      });
      const conversationId = await ctx.db.insert("conversations", {
        accountId, contactId, status: "open",
        unreadCount: 0, awaitingReply: true,
      });
      for (const h of [1, 4, 7, 12, 19]) {
        vi.setSystemTime(dayStart + h * HOUR_MS);
        await ctx.db.insert("messages", {
          accountId, conversationId, senderType: "customer",
          contentType: "text", status: "sent",
        });
      }
      // A second day, so the first day is not the final (withheld) one.
      vi.setSystemTime(dayStart + DAY_MS + 2 * HOUR_MS);
      await ctx.db.insert("messages", {
        accountId, conversationId, senderType: "customer",
        contentType: "text", status: "sent",
      });
    });

    await t.mutation(internal.messages.backfillActiveConversationStats, {
      batchSize: 2,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const total = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("messageHourlyStats")
        .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
        .collect();
      return rows.reduce((s, r) => s + (r.activeConversations ?? 0), 0);
    });
    // One per UTC day, regardless of how many batches each day took.
    expect(total).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
```

Confirm this test genuinely exercises the boundary: it must fail if the withheld-partial-day slice is removed. Temporarily change `daysToWrite` to always be `new Set(sortedDays)`, re-run, observe the failure, revert. Report both observations.

- [ ] **Step 6: Prove the backfill agrees with the live path**

This is the divergence class that shipped a bug on the previous branch, where the live rule and the rebuild rule quietly disagreed and both looked plausible. Drive identical traffic through both routes and assert identical totals:

```ts
test("backfill totals equal what the live write path produces", async () => {
  const dayStart = Date.parse("2026-08-06T00:00:00.000Z");
  const traffic = [1, 4, 4, 9, 26, 27]; // hours from dayStart; spans 2 UTC days

  const runLive = async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(dayStart);
      const { accountId, conversationId } = await seedThread(t, "live@x.com");
      for (const h of traffic) {
        vi.setSystemTime(dayStart + h * HOUR_MS);
        await t.mutation(internal.messages.appendInternal, {
          accountId, conversationId, senderType: "customer",
          contentType: "text", contentText: "x",
        });
      }
      return t.run(async (ctx) => {
        const rows = await ctx.db
          .query("messageHourlyStats")
          .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
          .collect();
        return rows.reduce((s, r) => s + (r.activeConversations ?? 0), 0);
      });
    } finally {
      vi.useRealTimers();
    }
  };

  const runBackfilled = async () => {
    const t = convexTest(schema, modules);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(dayStart);
      const accountId = await t.run(async (ctx) =>
        ctx.db.insert("accounts", {
          name: "Acme", defaultCurrency: "AED",
          ownerUserId: await ctx.db.insert("users", { email: "bf@x.com" }),
        }),
      );
      await t.run(async (ctx) => {
        const contactId = await ctx.db.insert("contacts", {
          accountId, phone: "+971500000901", phoneNormalized: "971500000901",
        });
        const conversationId = await ctx.db.insert("conversations", {
          accountId, contactId, status: "open",
          unreadCount: 0, awaitingReply: true,
        });
        for (const h of traffic) {
          vi.setSystemTime(dayStart + h * HOUR_MS);
          await ctx.db.insert("messages", {
            accountId, conversationId, senderType: "customer",
            contentType: "text", status: "sent",
          });
        }
      });
      await t.mutation(internal.messages.backfillActiveConversationStats, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      return t.run(async (ctx) => {
        const rows = await ctx.db
          .query("messageHourlyStats")
          .withIndex("by_account_hour", (q) => q.eq("accountId", accountId))
          .collect();
        return rows.reduce((s, r) => s + (r.activeConversations ?? 0), 0);
      });
    } finally {
      vi.useRealTimers();
    }
  };

  const live = await runLive();
  const backfilled = await runBackfilled();
  expect(live).toBe(2); // one per UTC day
  expect(backfilled).toBe(live);
});
```

If the two disagree, the rules have diverged — stop and report it rather than adjusting either expectation to match the other.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/messages.ts convex/messages.test.ts
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(reports): backfill activeConversations from message history

Withholds the final partial UTC DAY rather than the final partial hour —
day-level distinctness is what this counter needs, and an hour-level
withhold would double-count a conversation whose day spans a batch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Read path — fold and query

**Files:**
- Modify: `convex/lib/reportStats.ts`
- Modify: `convex/lib/reportStats.test.ts`
- Modify: `convex/reports.ts` (`volume`)
- Modify: `convex/reports.test.ts`

**Interfaces:**
- Consumes: `activeConversations` on the rollup.
- Produces: `VolumeTotals` and each `volume` series point gain `activeConversations: number`.

- [ ] **Step 1: Write the failing tests**

Append to `convex/lib/reportStats.test.ts`:

```ts
describe("foldHoursIntoVolume — activeConversations", () => {
  const rows = [
    { hourStartMs: Date.parse("2026-08-03T08:00:00Z"), incoming: 1, outgoing: 0, activeConversations: 2 },
    { hourStartMs: Date.parse("2026-08-03T14:00:00Z"), incoming: 1, outgoing: 0, activeConversations: 3 },
    { hourStartMs: Date.parse("2026-08-04T09:00:00Z"), incoming: 1, outgoing: 0, activeConversations: 1 },
  ];

  it("sums into the local day", () => {
    const out = foldHoursIntoVolume(rows, ["2026-08-03", "2026-08-04"], 0, "day");
    expect(out.get("2026-08-03")!.activeConversations).toBe(5);
    expect(out.get("2026-08-04")!.activeConversations).toBe(1);
  });

  // A row written before this counter shipped has no field. It must read as
  // zero, never NaN — one NaN poisons a whole chart axis.
  it("treats an absent counter as zero", () => {
    const out = foldHoursIntoVolume(
      [{ hourStartMs: Date.parse("2026-08-03T08:00:00Z"), incoming: 1, outgoing: 0 }],
      ["2026-08-03"], 0, "day",
    );
    expect(out.get("2026-08-03")!.activeConversations).toBe(0);
  });

  it("respects a non-zero offset", () => {
    // UTC+4: 2026-08-03T21:00Z is 2026-08-04 locally.
    const out = foldHoursIntoVolume(
      [{ hourStartMs: Date.parse("2026-08-03T21:00:00Z"), incoming: 0, outgoing: 0, activeConversations: 4 }],
      ["2026-08-03", "2026-08-04"], -240, "day",
    );
    expect(out.get("2026-08-04")!.activeConversations).toBe(4);
    expect(out.get("2026-08-03")!.activeConversations).toBe(0);
  });
});
```

Append to `convex/reports.test.ts`:

```ts
test("volume returns activeConversations in series and totals", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asSupervisor } = await seedAccountWithSupervisor(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("messageHourlyStats", {
      accountId, hourStartMs: Date.parse("2026-08-03T08:00:00Z"),
      incoming: 1, outgoing: 0, activeConversations: 2,
    });
    await ctx.db.insert("messageHourlyStats", {
      accountId, hourStartMs: Date.parse("2026-08-04T09:00:00Z"),
      incoming: 1, outgoing: 0, activeConversations: 5,
    });
  });

  const out = await asSupervisor.query(api.reports.volume, {
    sinceMs: Date.parse("2026-08-03T00:00:00Z"),
    untilMs: Date.parse("2026-08-05T00:00:00Z"),
    keys: ["2026-08-03", "2026-08-04"],
    tzOffsetMinutes: 0,
    granularity: "day",
  });

  expect(out.series[0]!.activeConversations).toBe(2);
  expect(out.series[1]!.activeConversations).toBe(5);
  expect(out.totals.activeConversations).toBe(7);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/lib/reportStats.test.ts convex/reports.test.ts`
Expected: FAIL — the property does not exist.

- [ ] **Step 3: Extend the fold**

In `convex/lib/reportStats.ts`, add to `ReportHourRow`:

```ts
  activeConversations?: number;
```

to `VolumeTotals`:

```ts
  activeConversations: number;
```

then seed it to zero in `foldHoursIntoVolume`'s per-key initializer and accumulate it in the loop:

```ts
    bucket.activeConversations += row.activeConversations ?? 0;
```

- [ ] **Step 4: Extend the query**

In `convex/reports.ts`'s `volume`, add `activeConversations: 0` to the `?? {}` fallback in the `series` map, and to both the reducer and its seed in `totals`:

```ts
        activeConversations: acc.activeConversations + p.activeConversations,
```
```ts
      { conversationsStarted: 0, conversationsStartedAd: 0, incoming: 0, outgoing: 0, activeConversations: 0 },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run convex/lib/reportStats.test.ts convex/reports.test.ts convex/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
npx eslint convex/lib/reportStats.ts convex/lib/reportStats.test.ts convex/reports.ts convex/reports.test.ts
git add convex/lib/reportStats.ts convex/lib/reportStats.test.ts convex/reports.ts convex/reports.test.ts
git commit -m "feat(reports): return activeConversations from the volume query

Rides rows the query already fetches — no additional read.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The tile and chart

**Files:**
- Modify: `src/components/reports/conversations-panel.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `activeConversations` on each `volume` series point and on `totals`.

**Read `conversations-panel.tsx` end to end first.** It already establishes every convention you need — `ReportPanelProps` with the prop named `reportWindow`, the `canRead ? {...} : 'skip'` gate, `MetricCard`, `SkeletonCard`, `EmptyState`, `downloadCsv`, the partial-week marking, and `.toLocaleString()` on tile values. Follow them; do not invent a second shape.

- [ ] **Step 1: Add the tile**

A fourth `MetricCard` beside "New conversations":

```tsx
<MetricCard
  title={t('conversations.active')}
  value={data.totals.activeConversations.toLocaleString()}
  icon={MessagesSquare}
  subtitle={t('conversations.activeSubtitle')}
/>
```

Import `MessagesSquare` from `lucide-react`. The subtitle is not decoration — "active" is a word every reader defines slightly differently, and the copy is what fixes the definition.

- [ ] **Step 2: Expose days-per-week on `ReportWindow`**

The weekly average needs a denominator. `reportWindow()` in `src/lib/reports/types.ts` already builds a `daysPerWeek` map internally (it derives `partialWeekKeys` from it) but does not return it. Add it to the returned object and to the `ReportWindow` type:

```ts
  /** Days of each week key that actually fall inside the range. The
   *  denominator for the active-conversations weekly average — a partial
   *  week must not be divided by 7. */
  daysPerWeek: Record<string, number>
```

Return it as `daysPerWeek: Object.fromEntries(daysPerWeek)`, leaving the existing `partialWeekKeys` derivation untouched.

Add a test to `src/lib/reports/types.test.ts` pinning that a 7-day range yields days-per-week summing to 7 across its (usually two) week keys, and that a 30-day range's interior weeks are exactly 7:

```ts
it('reports days per week that sum to the range length', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-05-18T10:00:00Z')) // a Monday
    const w = reportWindow(30)
    const total = Object.values(w.daysPerWeek).reduce((a, b) => a + b, 0)
    expect(total).toBe(30)
    expect(Object.values(w.daysPerWeek).filter((n) => n === 7).length).toBeGreaterThan(0)
  } finally {
    vi.useRealTimers()
  }
})
```

- [ ] **Step 3: Add the chart**

A separate card below the volume chart:

```tsx
{/* Its own chart rather than a fifth series on the volume chart — that one
    already carries stacked ad/direct bars plus incoming and outgoing lines,
    and a third line past that stops being readable. */}
<div className="rounded-xl border border-border bg-card p-5">
  <h2 className="mb-4 text-sm font-medium text-foreground">
    {t('conversations.activeTitle')}
  </h2>
  {data.totals.activeConversations === 0 ? (
    <EmptyState
      title={t('conversations.activeEmptyTitle')}
      hint={t('conversations.activeEmptyHint')}
    />
  ) : (
    <>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={activePoints} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis
            dataKey="key"
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }}
            tickLine={false}
            axisLine={false}
            allowDecimals={granularity === 'week'}
          />
          <Tooltip
            contentStyle={{
              background: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(value: number) => [
              granularity === 'week' ? value.toFixed(1) : value.toLocaleString(),
              granularity === 'week'
                ? t('conversations.activePerDay')
                : t('conversations.active'),
            ]}
          />
          <Bar
            dataKey="value"
            name={
              granularity === 'week'
                ? t('conversations.activePerDay')
                : t('conversations.active')
            }
            fill="hsl(var(--primary))"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
      <p className="mt-3 text-xs text-muted-foreground">
        {t('conversations.activeCaveat')}
      </p>
    </>
  )}
</div>
```

with, above the return:

```tsx
const activePoints = data.series.map((p) => {
  // At WEEK granularity this is AVERAGE DAILY ACTIVE, not a weekly total.
  // Distinct counts are not additive across buckets: summing a week's daily
  // counts would count a thread active on Monday and Thursday twice — the
  // exact bug the per-day dedup exists to prevent, one level up. The average
  // is the honest figure the stored data supports, which is why the axis
  // label and tooltip both say "avg/day".
  const days =
    granularity === 'week' ? (reportWindow.daysPerWeek[p.key] ?? 7) : 1
  return {
    key: p.key,
    value: days > 0 ? p.activeConversations / days : 0,
  }
})
```

`BarChart`, `Bar`, `XAxis`, `YAxis`, `CartesianGrid`, `Tooltip` and `ResponsiveContainer` are already imported by this file for the volume chart — reuse those imports rather than adding duplicates.

- [ ] **Step 4: Add the CSV column**

Extend the existing export's headers with `active_conversations` and each row with `p.activeConversations`. Keep the column raw (the per-day count), not the weekly average — a spreadsheet user can average, but cannot recover counts from an average.

- [ ] **Step 5: Add the copy**

In `messages/en.json`, inside `Reports.conversations`:

```json
      "active": "Active conversations",
      "activeSubtitle": "Threads with any message, in or out",
      "activeTitle": "Active conversations per day",
      "activePerDay": "avg/day",
      "activeEmptyTitle": "No conversation activity in this range",
      "activeEmptyHint": "Threads appear here on any message, sent or received.",
      "activeCaveat": "A thread active both overnight and later the same day may count twice, since a local day spans two UTC days.",
```

Render `activeCaveat` as small muted text under the chart. It is the honest disclosure of the design's one known imprecision, and the spec requires it be surfaced rather than left in a doc.

- [ ] **Step 6: Verify**

Run each and report the real output:

```bash
npx tsc --noEmit
```
```bash
npx eslint src/components/reports/conversations-panel.tsx
```
```bash
npx vitest run
```
```bash
npm run build
```

**Do not start a dev server.** There is no deployed backend on this branch, so the page cannot be exercised; `npm run build` is the real gate, since it compiles every route and catches an import or server/client-boundary mistake.

Then confirm no Convex server code leaked into the browser bundle: parse `.next/server/app/(dashboard)/reports/page_client-reference-manifest.js` for the route's chunk list, read those files with a **Node script** (a shell `for f in $FILES` silently no-ops under zsh word-splitting and reports a false clean), and grep for `requireRole`, `ctx.db`, `accountQuery`. Run a positive control — grep for a string you know is in your new copy, e.g. `conversations.activeSubtitle` — and name it in your report. A clean result with no control proves nothing.

- [ ] **Step 7: Commit**

```bash
git add src/components/reports/conversations-panel.tsx messages/en.json
git commit -m "feat(reports): active-conversations tile and chart

Weekly granularity shows average daily active, not a sum — distinct
counts are not additive across buckets.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Handoff to the owner

After Task 5 the branch is complete but **not deployed**. Remaining steps are the owner's, in this order:

1. Review and merge — but **deploy the backend first**. Netlify builds production from `main`, so merging publishes the frontend immediately; if the deployed Convex backend lacks `activeConversations`, the tile renders `undefined`.
2. Codegen and deploy Convex.
3. Trigger the backfill, one chain, and let it finish:
   ```
   npx convex run messages:backfillActiveConversationStats
   ```
   It is idempotent per chain but **not** concurrency-safe.
4. Merge.

Until the backfill completes, `activeConversations` reads zero for every period before the write path deployed — the same forward-only shape the billing counters have, except this one *does* have a backfill.
