# Inbox Lanes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the lane a conversation is in — Active / Waiting / Chasing / Archived — as server-side indexed tabs in the Inbox, so the team can see what owes a reply instead of re-reading one flat list.

**Architecture:** One denormalized boolean on `conversations` (`awaitingReply`) records the direction of the last message. Waiting and Chasing are complementary *ranges* on `lastMessageAt` around a cutoff that defaults to exactly where the qualification engine gives up. Two composite indexes make every lane an exact index range. No mirror of any engine's state, no new sender; one new cron, for auto-assignment only.

**Tech Stack:** Convex (schema, queries, mutations, `convex-test`), Next.js App Router, React, TypeScript, `next-intl`, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-27-inbox-lanes-design.md` (v3).

## Global Constraints

- **Never run `convex deploy`, `convex dev`, or `npx convex codegen`.** This repo points at a self-hosted production deployment; the owner runs every deploy. Write schema changes and stop — `convex-test` reads `convex/schema.ts` directly and needs no codegen.
- **Run tests with `npx vitest run <path>`.** The repo script is `vitest run`.
- **Lint only what you changed:** `npx eslint <paths>`. Never lint the whole repo.
- **Stage git paths explicitly.** Never `git add -A` or `git add .` — other sessions share this working tree.
- **Every Convex function uses `accountQuery` / `accountMutation`** from `./lib/auth`, never raw `query` / `mutation`. Conversation-scoped functions go through `requireConversationAccess` or `requireOwnConversation`.
- **No jsdom, no Testing Library.** Component tests are static-render assertions — follow `src/components/inbox/conversation-list.test.tsx`.
- **Never mirror another table's state onto `conversations`.** v2 of this spec did and it produced three defects. `awaitingReply` records a fact about `messages`, written in the same transaction as the message itself; everything else is derived from timestamps at read time.
- **`awaitingReply` is `true` for a conversation with no messages** — we owe it its first message. Do not "fix" this to `false`.
- **Do not touch either follow-up engine's cadence, gating or sending.** `qualificationEngine` and `leadAnalysisEngine` are already mutually exclusive via `lib/leadAnalysis/eligibility.ts` tier 2 (`qualification_owns`). Task 8 is the only task that edits engine code, and only to move a block without changing behaviour.

---

## File Structure

| File | Responsibility |
|---|---|
| `convex/schema.ts` | `awaitingReply`, two indexes, `chasingAfterDays`, one notification literal |
| `convex/lib/inbox/lanes.ts` | **New.** Pure cutoff arithmetic — the only place the boundary is computed |
| `convex/lib/inbox/lanes.test.ts` | **New.** Unit tests, no database |
| `convex/messages.ts` | `awaitingReply` inside `insertMessageAndUpdateConversation` |
| `convex/inboxBackfill.ts` | **New.** One-shot paginated backfill; deleted after use |
| `convex/conversations.ts` | `lane` argument across `list`'s plans |
| `convex/leadAnalysis.ts` | Archive / restore / manual stop drop to agent+ |
| `convex/lib/qualification/routing.ts` | **New.** Routing rule extracted from `offerContext` |
| `convex/inboxChaseAssign.ts` | **New.** The auto-assign sweep |
| `convex/crons.ts`, `convex/cronSchedules.ts` | Register `inbox-chase-assign` |
| `src/components/inbox/conversation-list.tsx` | Lane tabs, Chasing row rendering |
| `src/components/inbox/message-thread.tsx` | Lane indicator, Stop chasing |
| `src/app/(dashboard)/inbox/page.tsx` | Lane state, passes `lane` to the query |
| `messages/en.json` | New strings |

Task order is the rollout order: schema (inert) → write path (invisible) → backfill → reads → UI → auto-assign.

---

### Task 1: Schema and the cutoff helper

**Files:**
- Create: `convex/lib/inbox/lanes.ts`, `convex/lib/inbox/lanes.test.ts`
- Modify: `convex/schema.ts` — fields after `returnedAt` (~line 321), indexes after `by_account_archived_status` (~line 402), `chasingAfterDays` in `qualificationConfigs` (~line 1955), one `notifications.type` literal (~line 982)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `conversations.awaitingReply?: boolean`
  - `qualificationConfigs.chasingAfterDays?: number`
  - indexes `by_account_lane_last_message`, `by_account_assigned_lane_last_message`
  - `notifications.type` literal `"chase_unassigned"`
  - `chasingCutoffMs(nowMs: number, config: { chasingAfterDays?: number; sessionWindowHours: number }): number`

- [ ] **Step 1: Write the failing cutoff test**

Create `convex/lib/inbox/lanes.test.ts`:

```ts
import { expect, test } from "vitest";
import { chasingCutoffMs } from "./lanes";

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

test("a non-default qualification window still derives the matching cutoff", () => {
  expect(chasingCutoffMs(NOW, { sessionWindowHours: 48 })).toBe(NOW - 2 * DAY);
});

test("zero and negative values are clamped to a minimum of one day", () => {
  // A cutoff of `now` would put every just-answered thread in Chasing.
  expect(chasingCutoffMs(NOW, { chasingAfterDays: 0, sessionWindowHours: 72 }))
    .toBe(NOW - DAY);
  expect(chasingCutoffMs(NOW, { chasingAfterDays: -3, sessionWindowHours: 72 }))
    .toBe(NOW - DAY);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run convex/lib/inbox/lanes.test.ts`
Expected: FAIL — cannot resolve `./lanes`.

- [ ] **Step 3: Write the helper**

Create `convex/lib/inbox/lanes.ts`:

```ts
// ============================================================
// Pure lane arithmetic (spec 2026-07-27-inbox-lanes §The four lanes).
// No I/O and no `Date.now()` — the caller passes `nowMs`, so every
// boundary is deterministic under test. This is the ONLY place the
// Waiting/Chasing cutoff is computed; two copies would let the two
// lanes drift apart and overlap or leave a gap.
// ============================================================

const DAY_MS = 24 * 3_600_000;

/** Never let the cutoff reach `now`: at 0 days every thread an agent
 *  just answered would render as neglected. */
const MIN_DAYS = 1;

/**
 * The instant that divides Waiting (newer) from Chasing (at or older).
 *
 * `chasingAfterDays` absent means "exactly where the qualification
 * engine gives up" — `sessionWindowHours / 24` — so out of the box the
 * two boundaries are the same number by construction and a thread can
 * never be in Chasing while its session could still be `collecting`.
 * That is safety property two in the spec, and deriving it here rather
 * than duplicating the literal `3` is what keeps it true if an owner
 * ever changes `sessionWindowHours`.
 */
export function chasingCutoffMs(
  nowMs: number,
  config: { chasingAfterDays?: number; sessionWindowHours: number },
): number {
  const raw = config.chasingAfterDays ?? config.sessionWindowHours / 24;
  return nowMs - Math.max(raw, MIN_DAYS) * DAY_MS;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run convex/lib/inbox/lanes.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Add `awaitingReply` to `conversations`**

In `convex/schema.ts`, after the `returnedAt` field and before the table's closing `})`:

```ts
    // ---- Lanes (spec 2026-07-27-inbox-lanes §Data model) ----
    // TRUE = the customer spoke last so we owe a reply (Active), OR the
    // conversation has no messages at all — an agent created it to write
    // into, so we owe it the first message. FALSE = we spoke last
    // (Waiting, or Chasing once `lastMessageAt` passes the cutoff).
    //
    // Written in `messages.ts`'s `insertMessageAndUpdateConversation`,
    // the single `insert("messages")` in the backend, so it cannot drift
    // from the fact it records.
    //
    // Both values are written EXPLICITLY, unlike `leadAnalyses.archived`
    // (true-or-absent). That rule guards an accumulating set whose
    // complement must never read past it; this is a genuine two-way
    // partition where both sides are bounded and both need an exact
    // range. `undefined` is not a third lane — it is a pre-backfill row,
    // eliminated by `inboxBackfill` before any lane tab ships.
    //
    // Deliberately NOT a mirror of any engine's state. Waiting vs
    // Chasing is a RANGE on `lastMessageAt`, computed at read time by
    // `lib/inbox/lanes.ts` — see the spec's §Why time-derived and not
    // sequence-derived for the three defects a mirror produced.
    awaitingReply: v.optional(v.boolean()),
```

- [ ] **Step 6: Add the two indexes**

Replace the trailing `,` after `.index("by_account_archived_status", [...])` with:

```ts
    .index("by_account_archived_status", ["accountId", "archivedAt", "status"])
    // The Inbox's lane tabs. Every key before `lastMessageAt` is bound by
    // EQUALITY — including `archivedAt` as `eq(undefined)` — leaving that
    // final key free for both the range and the ordering:
    //   Active  = no range,               order desc
    //   Waiting = gt(cutoff),             order desc
    //   Chasing = gt(0).lte(cutoff),      order ASC (longest-neglected first)
    // Waiting and Chasing are complementary ranges on one key, so they
    // are provably disjoint and exhaustive with no coordinating state.
    //
    // Chasing's `gt(0)` is the "field present" idiom
    // `qualificationEngine.getDueSessions` uses: `lastMessageAt` is
    // optional and Convex sorts a missing field before every present
    // value, so without it a message-less conversation would fall into
    // Chasing.
    //
    // Lanes are NOT available on the Archived tab: there `archivedAt` is
    // ranged (`gt(0)`), and index keys after a range key are unordered —
    // the same constraint the archived branch of `conversations.list`
    // already hit with `assignedToUserId`.
    .index("by_account_lane_last_message", [
      "accountId",
      "archivedAt",
      "awaitingReply",
      "lastMessageAt",
    ])
    // Same, for the single-assignee plan (Mine / Unassigned), and for
    // the auto-assign sweep's per-candidate Chasing-load count. Two
    // indexes rather than one for the reason the archive pair documents:
    // "any" needs global recency order, "eq" binds the assignee first,
    // and no single index serves both.
    .index("by_account_assigned_lane_last_message", [
      "accountId",
      "archivedAt",
      "assignedToUserId",
      "awaitingReply",
      "lastMessageAt",
    ]),
```

- [ ] **Step 7: Add `chasingAfterDays` and the notification literal**

In `qualificationConfigs`, beside `sessionWindowHours`:

```ts
    // Days of our-turn silence before a thread moves from the Waiting
    // lane to Chasing. ABSENT = `sessionWindowHours / 24`, i.e. exactly
    // where this engine's own follow-up ladder gives up — so the two
    // boundaries agree by construction. Lives here, next to the number
    // it must match, rather than in `leadAnalysisConfigs`, which is
    // gated on its own `enabled` flag while the lane boundary must work
    // regardless. Computed by `lib/inbox/lanes.ts`, never inline.
    chasingAfterDays: v.optional(v.number()),
```

In the `notifications.type` union, beside `v.literal("lead_returned")`:

```ts
      // No eligible agent existed when the auto-assign sweep reached an
      // unowned Chasing thread, so it stayed in the pool. Silence would
      // recreate the invisible-orphan problem one level up. Additive
      // union literal — the `lead_returned` precedent; existing rows
      // stay valid.
      v.literal("chase_unassigned"),
```

- [ ] **Step 8: Verify the schema parses**

Run: `npx vitest run convex/schema.test.ts convex/lib/inbox/lanes.test.ts`
Expected: PASS. `convex-test` loads the schema directly, so a malformed index or validator fails here.

- [ ] **Step 9: Lint and commit**

```bash
npx eslint convex/schema.ts convex/lib/inbox/lanes.ts convex/lib/inbox/lanes.test.ts
git add convex/schema.ts convex/lib/inbox/lanes.ts convex/lib/inbox/lanes.test.ts
git commit -m "feat(inbox): lane schema, indexes and cutoff arithmetic"
```

---

### Task 2: Write `awaitingReply` on every message

**Files:**
- Modify: `convex/messages.ts` — the `patch` object in `insertMessageAndUpdateConversation` (~lines 229–257)
- Test: `convex/messages.test.ts`

**Interfaces:**
- Consumes: `conversations.awaitingReply` (Task 1)
- Produces: after any `messages.append`, `conversation.awaitingReply === (senderType === "customer")`

- [ ] **Step 1: Write the failing tests**

Append to `convex/messages.test.ts`, reusing that file's existing `seedAccountMember` and conversation helpers by their real names:

```ts
test("awaitingReply tracks the direction of the last message", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "agent",
  });
  const conversationId = await seedConversation(t, accountId);
  const read = async () =>
    (await t.run((ctx) => ctx.db.get(conversationId)))!.awaitingReply;

  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "customer", contentType: "text", contentText: "hi",
  });
  expect(await read()).toBe(true);

  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "agent", contentType: "text", contentText: "hello",
  });
  expect(await read()).toBe(false);

  // A bot message is ours too — an auto-reply must not leave the thread
  // looking like it still owes the customer an answer.
  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "bot", contentType: "text", contentText: "auto",
  });
  expect(await read()).toBe(false);

  // ...and a fresh customer message puts it straight back to Active.
  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "customer", contentType: "text", contentText: "still there?",
  });
  expect(await read()).toBe(true);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run convex/messages.test.ts -t "awaitingReply tracks"`
Expected: FAIL — `expected undefined to be true`.

- [ ] **Step 3: Write the implementation**

In `insertMessageAndUpdateConversation`, add `awaitingReply: boolean;` to the `Partial<{...}>` type literal and set it unconditionally in the object:

```ts
  const patch: Partial<{
    lastMessageText: string;
    lastMessageAt: number;
    updatedAt: number;
    unreadCount: number;
    lastInboundAt: number;
    firstReplyAt: number;
    awaitingReply: boolean;
  }> = {
    lastMessageText: contentText ?? `[${contentType}]`,
    lastMessageAt: now,
    updatedAt: now,
    // The Active/Waiting lane axis. Set here rather than at any call
    // site because this is the single `insert("messages")` in the
    // backend — the same reason `recordMessageInHourlyStats` and
    // `armOnOutbound` hook here. Unconditional, so no send path can
    // leave it stale.
    //
    // Nothing else is needed for the Chasing lane: Chasing is this same
    // `false` plus a RANGE on `lastMessageAt`, which the line above
    // already updates. That is the whole reason v3 has no mirror field
    // to keep in sync.
    awaitingReply: senderType === "customer",
  };
```

Leave the existing `if (senderType === "customer") { ... } else if (...) { ... }` block below entirely untouched.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run convex/messages.test.ts -t "awaitingReply tracks"`
Expected: PASS.

- [ ] **Step 5: Run the whole suite for regressions**

Run: `npx vitest run convex/messages.test.ts convex/ingest.test.ts convex/alwaysReplyStrategy.test.ts`
Expected: PASS. `alwaysReplyStrategy.test.ts` drives the real inbound entry point end-to-end and is the best single guard that this change did not disturb the reply lifecycle.

- [ ] **Step 6: Lint and commit**

```bash
npx eslint convex/messages.ts convex/messages.test.ts
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(inbox): track awaitingReply on every message write"
```

---

### Task 3: Backfill `awaitingReply`

**Files:**
- Create: `convex/inboxBackfill.ts`, `convex/inboxBackfill.test.ts`

**Interfaces:**
- Consumes: `conversations.awaitingReply` (Task 1)
- Produces: `internal.inboxBackfill.backfillAwaitingReply({ cursor?: string | null, batchSize?: number }) → { cursor: string | null, isDone: boolean, patched: number }`

Existing rows have no `awaitingReply`, and `undefined` is not a lane. This must reach `patched: 0` before Task 6 ships the tabs.

- [ ] **Step 1: Write the failing test**

Create `convex/inboxBackfill.test.ts`:

```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("/convex/**/*.ts");

test("backfill derives awaitingReply from the newest message, and is idempotent", async () => {
  const t = convexTest(schema, modules);

  const { inbound, outbound, silent } = await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      name: "acct", defaultCurrency: "AED",
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000000",
    });
    const mk = async () =>
      await ctx.db.insert("conversations", {
        accountId, contactId, status: "open", unreadCount: 0,
      });
    const inbound = await mk();
    const outbound = await mk();
    const silent = await mk();
    const msg = async (conversationId: typeof inbound, senderType: "customer" | "agent") =>
      await ctx.db.insert("messages", {
        accountId, conversationId, senderType,
        contentType: "text", contentText: "x", status: "sent",
      });
    await msg(inbound, "customer");
    await msg(outbound, "customer");
    await msg(outbound, "agent"); // newest is ours
    return { inbound, outbound, silent };
  });

  const run = async () =>
    await t.mutation(internal.inboxBackfill.backfillAwaitingReply, { batchSize: 100 });
  const read = async (id: typeof inbound) =>
    (await t.run((ctx) => ctx.db.get(id)))!.awaitingReply;

  const first = await run();
  expect(first.isDone).toBe(true);
  expect(await read(inbound)).toBe(true);
  expect(await read(outbound)).toBe(false);
  // No messages at all: we owe the first one, so Active.
  expect(await read(silent)).toBe(true);

  const second = await run();
  expect(second.patched).toBe(0);
  expect(await read(inbound)).toBe(true);
});
```

If `contacts` or `accounts` require more fields, read those tables in `convex/schema.ts` and supply exactly what they need — do not relax the schema to suit the test.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run convex/inboxBackfill.test.ts`
Expected: FAIL — `internal.inboxBackfill` does not exist.

- [ ] **Step 3: Write the implementation**

Create `convex/inboxBackfill.ts`:

```ts
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

// ============================================================
// One-shot backfill for `conversations.awaitingReply` (spec
// 2026-07-27-inbox-lanes §Rollout step 3). Must reach `patched: 0`
// BEFORE the lane tabs ship: `undefined` is not a lane, and an
// un-backfilled row would be silently swallowed by whichever range it
// happens to sort into.
//
// Internal and paginated. Re-runnable and idempotent — a row already
// holding the right value is skipped, so `patched: 0` on a second pass
// is the signal that the backfill is complete.
//
// DELETE THIS MODULE once the backfill has run in production.
// ============================================================

const DEFAULT_BATCH = 200;

export const backfillAwaitingReply = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("conversations").paginate({
      cursor: args.cursor ?? null,
      numItems: args.batchSize ?? DEFAULT_BATCH,
    });

    let patched = 0;
    for (const conversation of page.page) {
      // Newest message wins. `by_conversation` binds its only field, so
      // the remaining sort key is the implicit `_creationTime` — the
      // same reasoning `messages.listByConversation` documents.
      const newest = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) =>
          q.eq("conversationId", conversation._id),
        )
        .order("desc")
        .first();
      // No messages: an agent created this thread to write into, so we
      // owe it the first message — Active, not Waiting. Matches the
      // schema comment on `awaitingReply`.
      const awaitingReply = newest ? newest.senderType === "customer" : true;
      if (conversation.awaitingReply === awaitingReply) continue;
      await ctx.db.patch(conversation._id, { awaitingReply });
      patched++;
    }

    return { cursor: page.continueCursor, isDone: page.isDone, patched };
  },
});
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run convex/inboxBackfill.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint convex/inboxBackfill.ts convex/inboxBackfill.test.ts
git add convex/inboxBackfill.ts convex/inboxBackfill.test.ts
git commit -m "feat(inbox): one-shot awaitingReply backfill"
```

---

### Task 4: `lane` argument on `conversations.list`

**Files:**
- Modify: `convex/conversations.ts` — `list`'s args (~lines 91–102) and its plan branches (~lines 151–215)
- Test: `convex/conversations.test.ts`

**Interfaces:**
- Consumes: both indexes and `chasingCutoffMs` (Task 1)
- Produces: `api.conversations.list({ lane?: "active" | "waiting" | "chasing", archived?, assignment?, status?, paginationOpts })`

- [ ] **Step 1: Write the failing tests**

Append to `convex/conversations.test.ts`, reusing its existing helpers. Extend `seedConversation`'s options object to accept `awaitingReply`, `lastMessageAt`, `archivedAt` and `assignedToUserId` rather than writing a second helper:

```ts
const DAY = 24 * 3_600_000;

/** A qualificationConfigs row so the cutoff resolves. 72h → 3 days. */
async function seedQualConfig(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  await t.run((ctx) =>
    ctx.db.insert("qualificationConfigs", {
      accountId, enabled: true, basicFields: [], qualifyThresholdScore: 60,
      timezoneLabel: "Asia/Dubai", utcOffsetMinutes: 240,
      workStartMinute: 600, workEndMinute: 1260, workDays: [1, 2, 3, 4, 5, 6],
      followUpDelaysMinutes: [60], maxFollowUps: 4, sessionWindowHours: 72,
      closingMessage: "thanks", adminAlertEnabled: false, adminAlertPhones: [],
      outboundNudgesEnabled: false,
    }),
  );
}

test("each lane returns exactly its own set, and the sets are disjoint", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const now = Date.now();

  const active = await seedConversation(t, accountId, {
    awaitingReply: true, lastMessageAt: now - 10 * DAY, // age is irrelevant to Active
  });
  const waiting = await seedConversation(t, accountId, {
    awaitingReply: false, lastMessageAt: now - 1 * DAY,
  });
  const chasing = await seedConversation(t, accountId, {
    awaitingReply: false, lastMessageAt: now - 9 * DAY,
  });
  const archived = await seedConversation(t, accountId, {
    awaitingReply: true, lastMessageAt: now - 2 * DAY, archivedAt: now,
  });

  const ids = async (lane: "active" | "waiting" | "chasing") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  expect(await ids("active")).toEqual([active]);
  expect(await ids("waiting")).toEqual([waiting]);
  expect(await ids("chasing")).toEqual([chasing]);
  for (const lane of ["active", "waiting", "chasing"] as const) {
    expect(await ids(lane)).not.toContain(archived);
  }
});

test("an old thread the customer spoke on last stays in Active, never Chasing", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const id = await seedConversation(t, accountId, {
    awaitingReply: true, lastMessageAt: Date.now() - 90 * DAY,
  });

  const ids = async (lane: "active" | "chasing") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  // Safety property one: no age puts an unanswered customer out of Active.
  expect(await ids("active")).toEqual([id]);
  expect(await ids("chasing")).toEqual([]);
});

test("a message-less conversation is Active and never Chasing", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  // No lastMessageAt at all — Convex sorts missing before every number,
  // so without the range's `gt(0)` this would land in Chasing.
  const id = await seedConversation(t, accountId, { awaitingReply: true });

  const ids = async (lane: "active" | "chasing") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  expect(await ids("active")).toEqual([id]);
  expect(await ids("chasing")).toEqual([]);
});

test("a thread exactly at the cutoff lands in exactly one lane", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  // Waiting is gt(cutoff), Chasing is lte(cutoff) — complementary, so a
  // thread ON the boundary must appear once and only once. 3 days back
  // plus a small margin so the cutoff moving during the test cannot
  // flip which side it falls on.
  const id = await seedConversation(t, accountId, {
    awaitingReply: false, lastMessageAt: Date.now() - 3 * DAY - 1_000,
  });

  const ids = async (lane: "waiting" | "chasing") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  const inWaiting = await ids("waiting");
  const inChasing = await ids("chasing");
  expect([...inWaiting, ...inChasing]).toEqual([id]);
});

test("Chasing orders longest-neglected first", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const now = Date.now();
  const recent = await seedConversation(t, accountId, {
    awaitingReply: false, lastMessageAt: now - 5 * DAY,
  });
  const ancient = await seedConversation(t, accountId, {
    awaitingReply: false, lastMessageAt: now - 40 * DAY,
  });

  const page = await asUser.query(api.conversations.list, {
    lane: "chasing", paginationOpts: { numItems: 50, cursor: null },
  });
  expect(page.page.map((c) => c._id)).toEqual([ancient, recent]);
});

test("lane combined with archived is rejected, not silently ignored", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  await expect(
    asUser.query(api.conversations.list, {
      lane: "active", archived: true,
      paginationOpts: { numItems: 10, cursor: null },
    }),
  ).rejects.toThrow();
});

test("lanes narrow correctly under the Mine tab (the eq plan)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "agent",
  });
  await seedQualConfig(t, accountId);
  const now = Date.now();
  const mine = await seedConversation(t, accountId, {
    awaitingReply: false, lastMessageAt: now - 9 * DAY, assignedToUserId: userId,
  });
  await seedConversation(t, accountId, {
    awaitingReply: false, lastMessageAt: now - 9 * DAY, // unassigned
  });

  const page = await asUser.query(api.conversations.list, {
    lane: "chasing", assignment: "mine",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(page.page.map((c) => c._id)).toEqual([mine]);
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `npx vitest run convex/conversations.test.ts -t "lane"`
Expected: FAIL — `lane` is not a recognised argument.

- [ ] **Step 3: Add the argument, the guard and the cutoff**

Add to `list`'s `args`, after `archived`:

```ts
    // Which lane tab. Absent = today's unlaned behaviour, so every
    // existing caller is untouched.
    lane: v.optional(
      v.union(v.literal("active"), v.literal("waiting"), v.literal("chasing")),
    ),
```

Destructure `lane`, then immediately after the existing `plan.kind === "empty"` early return:

```ts
    // Lanes are unavailable on the Archived tab: there `archivedAt` is
    // RANGED (`gt(0)`), and Convex leaves index keys after a range key
    // unordered, so `awaitingReply`/`lastMessageAt` cannot be bound.
    // Reject rather than silently dropping the argument, so a UI bug
    // surfaces as a failure instead of a quietly wrong list.
    if (lane && archived) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: "lane_unavailable_on_archived",
      });
    }

    // The Waiting/Chasing boundary. Read from `qualificationConfigs`
    // (NOT `loadEnabledConfig` — the lane must work whether or not that
    // feature is enabled) and computed by `lib/inbox/lanes.ts`, never
    // inline. Absent row → fall back to the 72h default so the lane
    // still works on an account that has never opened those settings.
    let cutoff = 0;
    if (lane === "waiting" || lane === "chasing") {
      const qualConfig = await ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .unique();
      cutoff = chasingCutoffMs(Date.now(), {
        chasingAfterDays: qualConfig?.chasingAfterDays,
        sessionWindowHours: qualConfig?.sessionWindowHours ?? 72,
      });
    }
```

Import `chasingCutoffMs` from `./lib/inbox/lanes`. `ConvexError` is already imported — confirm before adding a duplicate.

**On `Date.now()` inside a query.** This is an established pattern in this repo — `convex/dashboard.ts:354` does the same, with its own comment. The consequence to understand rather than "fix": a Convex query re-runs when a document it read changes, not when wall-clock time passes, so a thread crossing the cutoff moves from Waiting to Chasing on the next re-run (any new message in the account, a tab switch, a refresh) rather than at the exact second. That is correct and intended for a lane boundary measured in days — do not add a timer, a scheduled re-evaluation, or a stored lane field to make it instant.

- [ ] **Step 4: Bind the lane in the `eq` plan**

In the `plan.kind === "eq"` branch, replace the `.withIndex(...)` chain, leaving the archived branch exactly as it is:

```ts
        const q = lane
          ? ctx.db
              .query("conversations")
              .withIndex("by_account_assigned_lane_last_message", (ix) => {
                const scoped = ix
                  .eq("accountId", ctx.accountId)
                  .eq("archivedAt", undefined)
                  .eq("assignedToUserId", plan.assignee)
                  .eq("awaitingReply", lane === "active");
                if (lane === "waiting") return scoped.gt("lastMessageAt", cutoff);
                // `gt(0)` excludes message-less rows — see the index comment.
                if (lane === "chasing") {
                  return scoped.gt("lastMessageAt", 0).lte("lastMessageAt", cutoff);
                }
                return scoped; // active: no range on lastMessageAt
              })
              // Chasing is a neglect queue, not a message list.
              .order(lane === "chasing" ? "asc" : "desc")
          : ctx.db
              .query("conversations")
              .withIndex("by_account_archived_assigned_last_message", (ix) => {
                const scoped = ix.eq("accountId", ctx.accountId);
                return archived
                  ? scoped.gt("archivedAt", 0)
                  : scoped.eq("archivedAt", undefined).eq("assignedToUserId", plan.assignee);
              })
              .order("desc");
```

The `filtered` / `status` handling below is unchanged — `archived` is always false when `lane` is set, so the archived branch's assignee `.filter()` never applies.

- [ ] **Step 5: Bind the lane in the `any` / `meOrPool` plans**

```ts
      const q = lane
        ? ctx.db
            .query("conversations")
            .withIndex("by_account_lane_last_message", (ix) => {
              const scoped = ix
                .eq("accountId", ctx.accountId)
                .eq("archivedAt", undefined)
                .eq("awaitingReply", lane === "active");
              if (lane === "waiting") return scoped.gt("lastMessageAt", cutoff);
              if (lane === "chasing") {
                return scoped.gt("lastMessageAt", 0).lte("lastMessageAt", cutoff);
              }
              return scoped;
            })
            .order(lane === "chasing" ? "asc" : "desc")
        : ctx.db
            .query("conversations")
            .withIndex("by_account_archived_last_message", (ix) => {
              const scoped = ix.eq("accountId", ctx.accountId);
              return archived ? scoped.gt("archivedAt", 0) : scoped.eq("archivedAt", undefined);
            })
            .order("desc");
```

The `meOrPool` assignment `.filter()` below is unchanged.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run convex/conversations.test.ts`
Expected: PASS, including every pre-existing test — `lane` absent must reproduce today's behaviour exactly.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/conversations.ts convex/conversations.test.ts
git add convex/conversations.ts convex/conversations.test.ts
git commit -m "feat(inbox): lane argument on conversations.list"
```

---

### Task 5: Drop archive RBAC to agent+

**Files:**
- Modify: `convex/leadAnalysis.ts` — `archive` (~line 826), `restore` (~line 891), and the manual sequence-stop handler that writes `sequenceStatus: "stopped"` (~line 730)
- Test: `convex/leadAnalysis.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: those three mutations callable by role `agent`

A deliberate amendment to shipped P2 policy (spec §RBAC), not a bug fix.

- [ ] **Step 1: Write the failing test**

Append to `convex/leadAnalysis.test.ts`. Extend that file's `seedAccountMember` to accept an optional existing `accountId` so two members can share one account, rather than duplicating the helper:

```ts
test("an agent can archive and restore; a viewer cannot", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asAgent } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "agent",
  });
  const { asUser: asViewer } = await seedAccountMember(t, {
    name: "Vic", email: "vic@example.com", role: "viewer", accountId,
  });
  const conversationId = await seedConversation(t, accountId);

  await asAgent.mutation(api.leadAnalysis.archive, { conversationId });
  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.archivedAt)
    .toBeGreaterThan(0);

  await asAgent.mutation(api.leadAnalysis.restore, { conversationId });
  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.archivedAt)
    .toBeUndefined();

  await expect(
    asViewer.mutation(api.leadAnalysis.archive, { conversationId }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run convex/leadAnalysis.test.ts -t "an agent can archive"`
Expected: FAIL — the agent call throws on `requireRole("supervisor")`.

- [ ] **Step 3: Lower exactly three roles**

Change `ctx.requireRole("supervisor")` to `ctx.requireRole("agent")` in those three handlers only, adding above each:

```ts
    // agent+, not supervisor+ (spec 2026-07-27-inbox-lanes §RBAC): at
    // supervisor+ the people who actually read the Inbox cannot clear a
    // wrong number or a spam message, so Active — the one count this
    // design asks the team to drive to zero — fills with threads that
    // need no work. `archivedByUserId` records who, and Restore is one
    // click, so the blast radius is small.
```

Leave every other `requireRole("supervisor")` alone. The config mutations (~lines 60, 77) are `admin`; the board reads (~199, ~384) are already `agent`. Do **not** touch `archiveAutomated` — an `internalMutation` with no role check by design.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: PASS. A pre-existing test asserting "an agent cannot archive" now encodes the old policy — change it to assert the viewer denial and note the amendment in its comment.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint convex/leadAnalysis.ts convex/leadAnalysis.test.ts
git add convex/leadAnalysis.ts convex/leadAnalysis.test.ts
git commit -m "feat(inbox): lower archive, restore and stop-chasing to agent+"
```

---

### Task 6: Lane tabs in the Inbox

**Files:**
- Modify: `src/components/inbox/conversation-list.tsx`, `src/app/(dashboard)/inbox/page.tsx`, `messages/en.json`
- Test: `src/components/inbox/conversation-list.test.tsx`

**Interfaces:**
- Consumes: `api.conversations.list`'s `lane` argument (Task 4)
- Produces: `export type InboxLane = "active" | "waiting" | "chasing" | "archived"`, from `conversation-list.tsx` beside the existing `AssignmentTab`

**Do not ship until the Task 3 backfill reports `patched: 0` in production.** Before it, un-backfilled rows have `awaitingReply: undefined` and appear in no lane at all — the inbox would look empty.

- [ ] **Step 1: Add the strings**

In `messages/en.json`, in the existing Inbox group, matching the surrounding key style:

```json
"laneActive": "Active",
"laneWaiting": "Waiting",
"laneChasing": "Chasing",
"laneArchived": "Archived",
"laneActiveEmpty": "Nothing waiting on a reply. Good place to be.",
"laneWaitingEmpty": "No threads waiting on a customer.",
"laneChasingEmpty": "Nothing has gone quiet long enough to chase.",
"laneArchivedEmpty": "Nothing archived yet."
```

- [ ] **Step 2: Write the failing component test**

Append to `src/components/inbox/conversation-list.test.tsx`, reusing that file's existing render helper, `baseProps` and `NextIntlClientProvider` wrapper by their real names:

```ts
test("renders one tab per lane", () => {
  const markup = renderToStaticMarkup(
    <ConversationList {...baseProps} lane="chasing" onLaneChange={() => {}} />,
  );
  for (const label of ["Active", "Waiting", "Chasing", "Archived"]) {
    expect(markup).toContain(label);
  }
});

test("each lane renders its own empty state", () => {
  const markup = renderToStaticMarkup(
    <ConversationList
      {...baseProps} conversations={[]} lane="chasing" onLaneChange={() => {}}
    />,
  );
  expect(markup).toContain("Nothing has gone quiet long enough to chase.");
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run src/components/inbox/conversation-list.test.tsx`
Expected: FAIL — `lane` is not a prop.

- [ ] **Step 4: Add the lane axis to the list component**

Beside the existing `AssignmentTab` type:

```tsx
/** Which lane tab is showing. A SEPARATE axis from `AssignmentTab` — the
 *  two compose, which is what makes "my Chasing queue" work with no
 *  per-agent state. Server-filtered via `conversations.list`'s `lane`
 *  argument, unlike the status/tag/search filters below, which still
 *  narrow only the loaded page. */
export type InboxLane = "active" | "waiting" | "chasing" | "archived";
```

Add `lane: InboxLane` and `onLaneChange: (lane: InboxLane) => void` to `ConversationListProps`. Render a tab row above the existing assignment tabs, following the exact markup and class pattern of `ASSIGNMENT_TABS`:

```tsx
  const LANE_TABS: { label: string; value: InboxLane }[] = useMemo(
    () => [
      { label: t("laneActive"), value: "active" },
      { label: t("laneWaiting"), value: "waiting" },
      { label: t("laneChasing"), value: "chasing" },
      { label: t("laneArchived"), value: "archived" },
    ],
    [t],
  );

  const emptyLaneMessage = {
    active: t("laneActiveEmpty"),
    waiting: t("laneWaitingEmpty"),
    chasing: t("laneChasingEmpty"),
    archived: t("laneArchivedEmpty"),
  }[lane];
```

Use `emptyLaneMessage` in the existing `filtered.length === 0` branch.

- [ ] **Step 5: Wire the page**

In `src/app/(dashboard)/inbox/page.tsx`, beside the `assignment` state:

```tsx
  // Which lane the list shows. Server-filtered via the `lane`/`archived`
  // args below, so each tab paginates its own complete set — unlike the
  // status/tag/search filters, which narrow only the loaded page.
  const [lane, setLane] = useState<InboxLane>("active");
```

```tsx
  const conv = usePaginatedQuery(
    api.conversations.list,
    {
      assignment: assignment === "all" ? undefined : assignment,
      // Mutually exclusive — `conversations.list` rejects the combination.
      ...(lane === "archived" ? { archived: true } : { lane }),
    },
    { initialNumItems: 30 },
  );
```

Pass `lane={lane}` and `onLaneChange={setLane}` to `<ConversationList />`, importing `InboxLane` alongside `AssignmentTab`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/components/inbox/conversation-list.test.tsx`
Expected: PASS.

- [ ] **Step 7: Verify in the running app**

Start the dev server with `preview_start` (never `npm run dev` in Bash), open the Inbox, click each of the four tabs. Confirm with `read_page` that the list changes and `read_console_messages` shows no error. Screenshot the Chasing tab.

- [ ] **Step 8: Lint and commit**

```bash
npx eslint src/components/inbox/conversation-list.tsx src/components/inbox/conversation-list.test.tsx "src/app/(dashboard)/inbox/page.tsx"
git add src/components/inbox/conversation-list.tsx src/components/inbox/conversation-list.test.tsx "src/app/(dashboard)/inbox/page.tsx" messages/en.json
git commit -m "feat(inbox): lane tabs over the conversation list"
```

---

### Task 7: Chasing row detail and the Stop chasing control

**Files:**
- Modify: `convex/conversations.ts` (per-page `leadAnalyses` join, Chasing lane only), `src/lib/convex/adapters.ts`, `src/components/inbox/conversation-list.tsx`, `src/components/inbox/message-thread.tsx`, `messages/en.json`
- Test: `src/components/inbox/conversation-list.test.tsx`, `convex/conversations.test.ts`

**Interfaces:**
- Consumes: `InboxLane` (Task 6); the manual stop whose RBAC dropped in Task 5
- Produces: `followUpsSent?: number`, `sequenceStatus?: string` on the row shape `list` returns, for `lane === "chasing"` only

- [ ] **Step 1: Add the strings**

```json
"chasingQuietDays": "Quiet {days}d",
"chasingProgress": "{sent, plural, =0 {no nudges} =1 {1 nudge} other {# nudges}}",
"chasingNeedsDecision": "Needs your decision",
"stopChasing": "Stop chasing",
"stopChasingFailed": "Could not stop chasing this conversation."
```

**No "of N" total.** The ladder length lives in `leadAnalysisConfigs.bands[].steps.length`, keyed by band — neither is on the conversation row, and joining the config per page to render a denominator is not worth it. `followUpsSent` answers the question the agent actually has.

- [ ] **Step 2: Write the failing tests**

Both tests use only the two fields Step 3 exposes. `exhausted` is a `sequenceStatus` value — do not invent a separate boolean:

```ts
test("a chasing row shows how long it has been quiet", () => {
  const markup = renderToStaticMarkup(
    <ConversationList
      {...baseProps} lane="chasing" onLaneChange={() => {}}
      conversations={[{
        ...baseProps.conversations[0],
        last_message_at: new Date(Date.now() - 9 * 86_400_000).toISOString(),
        followUpsSent: 2,
        sequenceStatus: "running",
      }]}
    />,
  );
  expect(markup).toContain("Quiet 9d");
  expect(markup).toContain("2 nudges");
});

test("an exhausted lead is badged as needing a decision", () => {
  const markup = renderToStaticMarkup(
    <ConversationList
      {...baseProps} lane="chasing" onLaneChange={() => {}}
      conversations={[{
        ...baseProps.conversations[0],
        last_message_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        followUpsSent: 3,
        sequenceStatus: "exhausted",
      }]}
    />,
  );
  expect(markup).toContain("Needs your decision");
});
```

Match `baseProps.conversations[0]`'s real field names for the timestamp — read the file rather than assuming `last_message_at`.

Also append to `convex/conversations.test.ts`:

```ts
test("the leadAnalyses join happens only on the Chasing lane", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const now = Date.now();
  const id = await seedConversation(t, accountId, {
    awaitingReply: false, lastMessageAt: now - 9 * DAY,
  });
  await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(id))!;
    await ctx.db.insert("leadAnalyses", {
      accountId, conversationId: id, contactId: conversation.contactId,
      scoreStatus: "scored", sequenceStatus: "exhausted",
      attempts: 0, followUpsSent: 3,
    });
  });

  const chasing = await asUser.query(api.conversations.list, {
    lane: "chasing", paginationOpts: { numItems: 10, cursor: null },
  });
  expect(chasing.page[0].followUpsSent).toBe(3);
  expect(chasing.page[0].sequenceStatus).toBe("exhausted");

  // Other lanes must not pay for the join.
  const active = await asUser.query(api.conversations.list, {
    lane: "active", paginationOpts: { numItems: 10, cursor: null },
  });
  expect(active.page.every((c) => c.followUpsSent === undefined)).toBe(true);
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run src/components/inbox/conversation-list.test.tsx convex/conversations.test.ts -t "chasing"`
Expected: FAIL on both — the fields and strings do not exist.

- [ ] **Step 4: Add the per-page join**

In `conversations.list`, where the page's rows are mapped, add — **only when `lane === "chasing"`**:

```ts
        // Sequence detail for the Chasing rows. Per PAGE, so it is
        // bounded by `numItems` — the same shape as this function's
        // existing contact join. Gated on the lane so no other tab pays
        // for it. Read-only: `leadAnalyses` stays the system of record
        // and nothing here mirrors it onto `conversations` (see the
        // spec's §Why time-derived and not sequence-derived).
        const analysis =
          lane === "chasing"
            ? await ctx.db
                .query("leadAnalyses")
                .withIndex("by_conversation", (q) => q.eq("conversationId", row._id))
                .unique()
            : null;
```

Expose `followUpsSent: analysis?.followUpsSent` and `sequenceStatus: analysis?.sequenceStatus` on the returned row, then thread both through `toUiConversation` in `src/lib/convex/adapters.ts`.

- [ ] **Step 5: Render the Chasing row and the badge**

When `lane === "chasing"`, replace the timestamp slot's **contents** with `t("chasingQuietDays", { days })` where `days = Math.floor((Date.now() - lastMessageAt) / 86_400_000)`, plus `t("chasingProgress", { sent: followUpsSent ?? 0 })`. Render the `chasingNeedsDecision` badge when `sequenceStatus === "exhausted"`, reusing the row's existing `STATUS_COLORS` badge markup.

Keep every other lane's row rendering byte-for-byte unchanged. The row is a single `<button>` whose structure the mark-unread control depends on (see that component's own comment), so the Chasing branch swaps the slot's contents, never the row's structure.

- [ ] **Step 6: Add the thread-header control**

In `src/components/inbox/message-thread.tsx`, beside the existing archive/status controls, add **Stop chasing** — shown when the conversation has a running sequence, calling the manual stop mutation. Gate on agent+ with the same `useAuth()` role check the neighbouring controls use, and surface failures with `toast.error(t("stopChasingFailed"))`, matching `handleMarkUnread` in `inbox/page.tsx`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/components/inbox/conversation-list.test.tsx convex/conversations.test.ts`
Expected: PASS.

- [ ] **Step 8: Verify in the running app**

With the dev server up, open the Chasing tab and confirm a row renders its quiet-days line; open the thread and confirm **Stop chasing** appears. Screenshot both.

- [ ] **Step 9: Lint and commit**

```bash
npx eslint convex/conversations.ts convex/conversations.test.ts src/lib/convex/adapters.ts src/components/inbox/conversation-list.tsx src/components/inbox/conversation-list.test.tsx src/components/inbox/message-thread.tsx
git add convex/conversations.ts convex/conversations.test.ts src/lib/convex/adapters.ts src/components/inbox/conversation-list.tsx src/components/inbox/conversation-list.test.tsx src/components/inbox/message-thread.tsx messages/en.json
git commit -m "feat(inbox): chasing row detail and stop-chasing control"
```

---

### Task 8: Extract the lead-routing rule

**Files:**
- Create: `convex/lib/qualification/routing.ts`, `convex/lib/qualification/routing.test.ts`
- Modify: `convex/qualificationEngine.ts` — `offerContext` (~lines 2500–2620)

**Interfaces:**
- Consumes: nothing — **independent; may ship any time**
- Produces:
  ```ts
  export type FallbackCause =
    | "no_service_name" | "tag_missing" | "tag_unlinked" | "links_ineligible";

  export type EligibleMember = { userId: Id<"users">; phone: string; name: string };

  export type RoutingResult = {
    eligibleById: Map<Id<"users">, EligibleMember>;
    poolIds: Id<"users">[];
    fallback: FallbackCause | null;
  };

  export async function resolveRouting(
    ctx: { db: QueryCtx["db"] },
    args: { accountId: Id<"accounts">; serviceName: string | null },
  ): Promise<RoutingResult>;
  ```

**This is the one genuinely risky edit in the plan.** `offerContext` assigns real leads and its `FallbackCause` values drive admin-facing messages. Behaviour-preserving only; the existing tests are the gate.

- [ ] **Step 1: Record the baseline**

Run: `npx vitest run convex/qualificationEngine.test.ts`
Expected: PASS. Note the passing test count — it must be identical at Step 6.

- [ ] **Step 2: Write the failing unit test**

Create `convex/lib/qualification/routing.test.ts`, covering all four causes plus the happy path, since each has a different admin remedy:

```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import { resolveRouting } from "./routing";

const modules = import.meta.glob("/convex/**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      name: "acct", defaultCurrency: "AED",
    });
    const agentId = await ctx.db.insert("users", { name: "Ann", email: "a@x.com" });
    await ctx.db.insert("memberships", {
      userId: agentId, accountId, role: "agent",
      fullName: "Ann", email: "a@x.com", phone: "+971500000001",
    });
    return { accountId, agentId };
  });
}

test("no service name widens to the whole team", async () => {
  const t = convexTest(schema, modules);
  const { accountId, agentId } = await seed(t);
  const r = await t.run((ctx) => resolveRouting(ctx, { accountId, serviceName: null }));
  expect(r.fallback).toBe("no_service_name");
  expect(r.poolIds).toEqual([agentId]);
});

test("an unknown service name reports tag_missing", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seed(t);
  const r = await t.run((ctx) =>
    resolveRouting(ctx, { accountId, serviceName: "Nonexistent" }),
  );
  expect(r.fallback).toBe("tag_missing");
});

test("a tag with no memberTags links reports tag_unlinked", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seed(t);
  await t.run((ctx) => ctx.db.insert("tags", { accountId, name: "UAE Visa" }));
  // Case-insensitive, trimmed match — the rule offerContext already used.
  const r = await t.run((ctx) =>
    resolveRouting(ctx, { accountId, serviceName: "  uae visa  " }),
  );
  expect(r.fallback).toBe("tag_unlinked");
});

test("a linked, eligible agent routes with no fallback", async () => {
  const t = convexTest(schema, modules);
  const { accountId, agentId } = await seed(t);
  await t.run(async (ctx) => {
    const tagId = await ctx.db.insert("tags", { accountId, name: "UAE Visa" });
    await ctx.db.insert("memberTags", { accountId, userId: agentId, tagId });
  });
  const r = await t.run((ctx) =>
    resolveRouting(ctx, { accountId, serviceName: "UAE Visa" }),
  );
  expect(r.fallback).toBeNull();
  expect(r.poolIds).toEqual([agentId]);
});

test("a linked member with no phone reports links_ineligible", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seed(t);
  await t.run(async (ctx) => {
    const phoneless = await ctx.db.insert("users", { name: "Bob", email: "b@x.com" });
    await ctx.db.insert("memberships", {
      userId: phoneless, accountId, role: "agent", fullName: "Bob", email: "b@x.com",
    });
    const tagId = await ctx.db.insert("tags", { accountId, name: "Tours" });
    await ctx.db.insert("memberTags", { accountId, userId: phoneless, tagId });
  });
  const r = await t.run((ctx) => resolveRouting(ctx, { accountId, serviceName: "Tours" }));
  expect(r.fallback).toBe("links_ineligible");
});
```

If `tags` requires more fields, read the table and supply exactly what it needs.

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run convex/lib/qualification/routing.test.ts`
Expected: FAIL — cannot resolve `./routing`.

- [ ] **Step 4: Create the module by MOVING the existing code**

Create `convex/lib/qualification/routing.ts`. **Move** three blocks out of `offerContext` — the `memberships` → `eligibleById` loop, the `tags`/`memberTags` → `poolIds` resolution, and the `fallback` widening — plus the `FallbackCause` declaration. Preserve every comment verbatim. Do not retype from memory and do not tidy: a behaviour-preserving move is the whole point.

Header comment:

```ts
// ============================================================
// The lead-routing rule: who a lead should go to, given a service name.
// Extracted from `qualificationEngine.offerContext` (spec
// 2026-07-27-inbox-lanes §Chasing ownership) so the consent-offer flow
// and the Chasing auto-assign sweep share ONE rule. Two copies would
// drift, and the four `FallbackCause` values exist precisely because
// naming the wrong cause costs an admin a pointless hunt.
//
// This decides WHO IS ELIGIBLE. It deliberately does not rank them: the
// two callers rank differently (offers by fewest recent accepts, Chasing
// by current Chasing load), and folding both in would make the shared
// piece the union of two policies rather than their intersection.
// ============================================================
```

- [ ] **Step 5: Rewrite `offerContext` to call the helper**

Re-export `FallbackCause` from its new home so existing importers are unaffected, then replace the moved blocks with:

```ts
    const { eligibleById, poolIds: routedIds, fallback } = await resolveRouting(ctx, {
      accountId: session.accountId,
      serviceName,
    });
    let poolIds = routedIds;
```

Everything below — `nobodyLeft()`, the `alreadyTried` subtraction, the accept-count ranking — stays exactly as it is.

- [ ] **Step 6: Run both suites and compare to the baseline**

Run: `npx vitest run convex/lib/qualification/routing.test.ts convex/qualificationEngine.test.ts`
Expected: PASS, with the **same** `qualificationEngine` test count as Step 1. A dropped test means behaviour changed.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/lib/qualification/routing.ts convex/lib/qualification/routing.test.ts convex/qualificationEngine.ts
git add convex/lib/qualification/routing.ts convex/lib/qualification/routing.test.ts convex/qualificationEngine.ts
git commit -m "refactor(qualification): extract the lead-routing rule for reuse"
```

---

### Task 9: Auto-assign unowned Chasing threads

**Files:**
- Create: `convex/inboxChaseAssign.ts`, `convex/inboxChaseAssign.test.ts`
- Modify: `convex/crons.ts`, `convex/cronSchedules.ts`, `src/lib/cronSummary.ts`

**Interfaces:**
- Consumes: `chasingCutoffMs` (Task 1), both lane indexes (Task 1), `resolveRouting` (Task 8), the `chase_unassigned` literal (Task 1)
- Produces: cron `inbox-chase-assign` (30 min) → `internal.inboxChaseAssign.sweepChaseAssign`

**This is the only task that changes who owns a conversation, and the only new cron.** It sends nothing. Deploy it alone and watch the first sweep.

- [ ] **Step 1: Write the failing tests**

Create `convex/inboxChaseAssign.test.ts`. Write a `seedChasing` helper covering: an account with `qualificationConfigs` (`sessionWindowHours: 72`, `autoAssignEnabled: true` unless overridden), a phone-bearing `agent` membership, a `tags` row plus `memberTags` link, a contact, and a conversation. Options, all used by the tests below:

```ts
type SeedChasingOpts = {
  /** "other" seeds a second member and pre-assigns the conversation to them. */
  assignTo?: "other";
  /** Seed no eligible members at all (no phone, or no memberships). */
  noAgents?: boolean;
  /** Defaults to true; false writes autoAssignEnabled: false. */
  autoAssign?: boolean;
  /** Days since lastMessageAt. Defaults to 9 — well past the 3-day cutoff. */
  quietDays?: number;
  /** Defaults to false (Waiting/Chasing side). True puts it in Active. */
  awaitingReply?: boolean;
};
```

It returns `{ accountId, agentId, otherUserId, conversationId }`.

```ts
test("assigns an unowned Chasing thread to a routed agent, without charging", async () => {
  const t = convexTest(schema, modules);
  const { agentId, conversationId } = await seedChasing(t);

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBe(agentId);
  // Deliberately NOT charged — see the spec's billing decision.
  expect(await t.run((ctx) => ctx.db.query("leadCharges").collect())).toHaveLength(0);
});

test("never reassigns a thread that already has an owner", async () => {
  const t = convexTest(schema, modules);
  const { conversationId, otherUserId } = await seedChasing(t, { assignTo: "other" });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBe(otherUserId);
});

test("leaves a Waiting thread alone — only Chasing is swept", async () => {
  const t = convexTest(schema, modules);
  // One day quiet, well inside the 3-day cutoff.
  const { conversationId } = await seedChasing(t, { quietDays: 1 });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBeUndefined();
});

test("an Active thread is never assigned by this sweep, however old", async () => {
  const t = convexTest(schema, modules);
  const { conversationId } = await seedChasing(t, { awaitingReply: true, quietDays: 90 });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBeUndefined();
});

test("no eligible agent leaves it unassigned and notifies the pool", async () => {
  const t = convexTest(schema, modules);
  const { conversationId } = await seedChasing(t, { noAgents: true });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBeUndefined();
  const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
  expect(notes.map((n) => n.type)).toContain("chase_unassigned");
});

test("skipped entirely when autoAssignEnabled is false", async () => {
  const t = convexTest(schema, modules);
  const { conversationId } = await seedChasing(t, { autoAssign: false });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId)
    .toBeUndefined();
});

test("spreads across agents by current Chasing load", async () => {
  const t = convexTest(schema, modules);
  // Two eligible agents, one already holding a Chasing thread; three
  // unowned threads must not all land on the same person.
  const { conversationIds, agentIds } = await seedChasingFleet(t, {
    agents: 2, loaded: 1, unowned: 3,
  });

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  const owners = await Promise.all(
    conversationIds.map(async (id) =>
      (await t.run((ctx) => ctx.db.get(id)))!.assignedToUserId),
  );
  expect(new Set(owners).size).toBeGreaterThan(1);
  for (const owner of owners) expect(agentIds).toContain(owner);
});
```

Write `seedChasingFleet` alongside `seedChasing`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run convex/inboxChaseAssign.test.ts`
Expected: FAIL — `internal.inboxChaseAssign` does not exist.

- [ ] **Step 3: Write the sweep**

Create `convex/inboxChaseAssign.ts`:

```ts
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { chasingCutoffMs } from "./lib/inbox/lanes";
import { resolveRouting } from "./lib/qualification/routing";

// ============================================================
// Auto-assign unowned Chasing threads (spec
// 2026-07-27-inbox-lanes §Chasing ownership).
//
// WHY ITS OWN CRON. Time-derived Chasing has no entry EVENT — a thread
// ages in — so there is nothing to hook. The `lead-sequence` sweep
// ranges `by_sequence_due`, which is empty on an account with no
// approved band templates (the very condition that killed v2's design);
// `qualification-follow-ups` ranges `by_due` over `collecting` sessions,
// and a Chasing thread's session has expired; and scheduling per
// outbound message would create one scheduled job per send. Folding this
// into an unrelated sweep to keep the cron count at seven would trade
// clarity for a number.
//
// SENDS NOTHING. It patches `assignedToUserId` and, when nobody is
// eligible, writes one notification. It deliberately does NOT call
// `chargeLeadIfAgent` and does NOT go through the `assign` mutation —
// billing an agent for an unresponsive lead they did not choose is the
// owner's call, and not-charging is the reversible direction. One line
// to change if that decision flips.
// ============================================================

/** Conversations promoted per run. Bounded so the first sweep over a
 *  months-old backlog cannot fan out unboundedly. */
const ASSIGN_PER_RUN = 50;

/** How far to count a candidate's current Chasing threads. At or above
 *  this they are already the least attractive choice, so counting
 *  further buys nothing and would make the read grow with the backlog. */
const LOAD_PROBE = 25;

export const sweepChaseAssign = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ assigned: number; unroutable: number }> => {
    const now = Date.now();
    let assigned = 0;
    let unroutable = 0;

    const accounts = await ctx.db.query("accounts").collect();
    for (const account of accounts) {
      const config = await ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .unique();
      // Inert unless the owner has turned auto-assignment on.
      if (!config || config.autoAssignEnabled === false) continue;

      const cutoff = chasingCutoffMs(now, {
        chasingAfterDays: config.chasingAfterDays,
        sessionWindowHours: config.sessionWindowHours,
      });

      // Exactly the Chasing lane's own range, and exactly its unassigned
      // slice — `assignedToUserId: undefined` is a real index key, so
      // this reads only rows that need work rather than filtering after.
      const due = await ctx.db
        .query("conversations")
        .withIndex("by_account_assigned_lane_last_message", (ix) =>
          ix
            .eq("accountId", account._id)
            .eq("archivedAt", undefined)
            .eq("assignedToUserId", undefined)
            .eq("awaitingReply", false)
            .gt("lastMessageAt", 0)
            .lte("lastMessageAt", cutoff),
        )
        .order("asc")
        .take(ASSIGN_PER_RUN);

      for (const conversation of due) {
        const picked = await pickOwner(ctx, conversation, cutoff);
        if (!picked) {
          await notifyUnassigned(ctx, conversation);
          unroutable++;
          continue;
        }
        await ctx.db.patch(conversation._id, {
          assignedToUserId: picked,
          updatedAt: Date.now(),
        });
        assigned++;
      }
    }

    return { assigned, unroutable };
  },
});

/** The routed candidate currently holding the fewest Chasing threads.
 *  `cutoff` is threaded in rather than recomputed so the load count
 *  measures exactly the same lane the sweep is filling — a count over
 *  Waiting+Chasing would let a busy Waiting queue hide a genuinely idle
 *  Chasing one. */
async function pickOwner(
  ctx: { db: MutationCtx["db"] },
  conversation: Doc<"conversations">,
  cutoff: number,
): Promise<Id<"users"> | null> {
  const session = await ctx.db
    .query("qualificationSessions")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
    .unique();

  const { eligibleById, poolIds } = await resolveRouting(ctx, {
    accountId: conversation.accountId,
    serviceName: session?.serviceName ?? null,
  });

  // Ranked by CURRENT Chasing load, not by historical offer accepts:
  // accepts are blind to direct assignments, so on the first sweep they
  // would stack the whole backlog onto whoever has fewest.
  let best: { userId: Id<"users">; load: number } | null = null;
  for (const userId of poolIds) {
    if (!eligibleById.has(userId)) continue;
    const held = await ctx.db
      .query("conversations")
      .withIndex("by_account_assigned_lane_last_message", (ix) =>
        ix
          .eq("accountId", conversation.accountId)
          .eq("archivedAt", undefined)
          .eq("assignedToUserId", userId)
          .eq("awaitingReply", false)
          .gt("lastMessageAt", 0)
          .lte("lastMessageAt", cutoff),
      )
      .take(LOAD_PROBE);
    if (!best || held.length < best.load) best = { userId, load: held.length };
    if (best.load === 0) break; // cannot do better
  }
  return best?.userId ?? null;
}
```

Write `notifyUnassigned` to insert one `chase_unassigned` notification per supervisor+ recipient, reusing `recipientsForInbound` from `./lib/pushRecipients` (see `convex/conversations.ts:877`) rather than hand-rolling the recipient rule, and matching the field shape the neighbouring `lead_returned` insert uses.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run convex/inboxChaseAssign.test.ts`
Expected: PASS (all seven).

- [ ] **Step 5: Register the cron**

Add the `cronSchedules.ts` wrapper following the pattern of `runSweepLeadSequence` (so the run stamps a `cronRuns` row), then in `convex/crons.ts`:

```ts
// Auto-assign unowned Chasing threads (spec 2026-07-27-inbox-lanes
// §Chasing ownership). Sends NOTHING — patches `assignedToUserId` and
// notifies when nobody is eligible. Bounded per run, and a no-op unless
// `qualificationConfigs.autoAssignEnabled` is on.
crons.interval(
  "inbox-chase-assign",
  { minutes: 30 },
  internal.cronSchedules.runSweepChaseAssign,
  {},
);
```

Add the matching entry to `CRON_REGISTRY` in `src/lib/cronSummary.ts` — `crons.ts`'s own header comment requires names and intervals stay in sync with it.

- [ ] **Step 6: Run the cron and lane suites**

Run: `npx vitest run convex/inboxChaseAssign.test.ts convex/cronSchedules.test.ts convex/conversations.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/inboxChaseAssign.ts convex/inboxChaseAssign.test.ts convex/crons.ts convex/cronSchedules.ts src/lib/cronSummary.ts
git add convex/inboxChaseAssign.ts convex/inboxChaseAssign.test.ts convex/crons.ts convex/cronSchedules.ts src/lib/cronSummary.ts
git commit -m "feat(inbox): auto-assign unowned Chasing threads on a bounded sweep"
```

---

## Deploy sequence (owner-run)

No agent session runs any of this.

> **CORRECTION (2026-07-27, found by loading the deploy preview).** The per-task sequence below
> was written assuming each task deploys as it lands. It does not survive all nine tasks
> arriving on one branch: **`npx convex deploy` ships the entire `convex/` directory in one
> shot**, so there is no way to deploy Task 1's schema without also shipping Task 9's cron.
> Steps 1, 2, 4 and the "Task 9 last and alone" instruction cannot be followed as written.
>
> **Use this instead. Deploy from the worktree, not from `main` — `main` does not contain the
> code.**
>
> 1. **`cd` to the branch worktree and `npx convex deploy`.** Ships schema, indexes,
>    `chasingAfterDays`, the notification literal, the `lane` argument, `inboxBackfill`,
>    `inboxChaseAssign` and its cron — all of it, together.
>
>    This is safe despite shipping the cron live, and the reason is worth understanding rather
>    than trusting: the sweep's range binds `eq("awaitingReply", false)`, and every pre-backfill
>    row holds `undefined`, which Convex treats as a distinct index value. The sweep therefore
>    matches zero rows and does nothing. **The cron wakes up at step 3, not step 1.**
>
> 2. **Confirm at least one membership per account carries a `phone`** — `resolveRouting`
>    requires one, so an account with none makes every Chasing thread unroutable. This gate
>    belongs before step 3, not before step 1, because step 3 is when the sweep starts matching.
>
> 3. **Run the backfill to completion**, then once more to confirm `patched: 0`:
>    `npx convex run inboxBackfill:backfillAwaitingReply '{"batchSize": 200}'`
>    Re-run with the returned `cursor` until `isDone`. **This is the moment the auto-assign cron
>    becomes live**, because rows finally hold `false`.
>
> 4. **Merge the PR** so Netlify ships the UI.
>
> **One consequence worth knowing before you look at the deploy preview:** the preview points at
> production Convex, so the lane tabs cannot render anything until steps 1 and 3 have actually
> run against production. There is no way to preview this feature without performing the real
> data migration first. That is not extra risk — steps 1 and 3 are meant to precede the merge
> anyway — but it does mean "look at the preview, then decide whether to migrate" is not
> available; the order is forced the other way.

### Original per-task sequence (superseded by the correction above; kept for the reasoning)

1. After **Task 1**, `convex deploy` — schema, indexes, config field, notification literal. Inert: no caller passes `lane`.
2. After **Task 2**, `convex deploy` — `awaitingReply` starts being maintained. Still invisible.
3. After **Task 3**, `convex deploy`, then run the backfill to completion:
   ```
   npx convex run --prod inboxBackfill:backfillAwaitingReply '{"batchSize": 200}'
   ```
   Re-run with the returned `cursor` until `isDone` is true, then once more to confirm `patched: 0`.
4. After **Tasks 4–5**, `convex deploy` — the read side and the RBAC change.
5. **Task 6** is the first user-visible change. Do not deploy until step 3 reports `patched: 0`. Chasing will be populated immediately — that is the 72h-cliff backlog becoming visible, not a new problem.
6. **Task 7** next.
7. **Task 8** any time — it is an independent, behaviour-preserving refactor.
8. **Task 9 last and alone.** It is the only part of this work that reassigns conversations.

   **`autoAssignEnabled` defaults to TRUE.** It is `v.optional(v.boolean())` with `// default true` (`convex/schema.ts:2060`) and `convex/lib/qualification/defaults.ts` seeds `true`; the sweep's gate tests `=== false`. So this cron is **active the moment it deploys** unless that flag has been explicitly set false — it is not opt-in, and earlier drafts of this plan wrongly described it as inert until switched on. It also shares that flag with the consent-offer flow, so the flag cannot disable one without the other.

   **Before deploying, confirm at least one membership per account carries a `phone`.** `resolveRouting` requires one for eligibility, so an account with none makes every Chasing thread unroutable — which is survivable but noisy. The sweep now suppresses repeat `chase_unassigned` notifications while an unread one exists, so it will not spam, but the underlying misconfiguration should be fixed rather than absorbed.

   Then watch one sweep in the Settings → Cron schedules panel. The sweep logs a per-account `spread={userId:count}` and a per-sweep summary, so the distribution across agents is checkable from the deployment logs.

**Do not delete `convex/inboxBackfill.ts` until after step 5 is live and step 3 has reported `patched: 0`.** Its original "delete in a follow-up" note was written when `awaitingReply` was only ever unset on pre-existing rows. Final review found the three conversation-create paths never set it either, which meant *new* invisible rows kept appearing and the backfill was the only repair tool. That is fixed — every conversation now goes through the single `insertConversation` helper — but keep the module until the deployed system has been observed producing no unset rows.
