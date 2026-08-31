# Inbox Manual Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent say two things the lane derivation cannot know — *"not until Tuesday"* (snooze) and *"this one has ghosted"* (force into Chasing).

**Architecture:** Snooze is a presence field (`snoozedUntil`) that every lane binds by equality, so a snoozed thread appears in no lane and needs no union — the same shape `archivedAt` already uses. Force-to-Chasing does need a union, so it reuses the bounded capped-read-merged-into-page-one pattern already shipped for the grace window. A 5-minute cron clears expired snoozes; any inbound message clears both overrides inside the message transaction.

**Tech Stack:** Convex (schema, queries, mutations, crons, `convex-test`), Next.js App Router, React, TypeScript, `next-intl`, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-28-inbox-manual-overrides-design.md`

## Global Constraints

- **NEVER run `convex deploy`, `convex dev`, or `npx convex codegen`** unless the owner explicitly asks in that session. Self-hosted production deployment; the owner runs deploys. `convex-test` reads `convex/schema.ts` directly and needs no codegen.
- Run tests with `npx vitest run <path>`. Lint only changed files: `npx eslint <paths>`.
- **Stage git paths explicitly** — never `git add -A`. Other sessions share this checkout.
- `npx tsc --noEmit` must stay silent. It is a gate on this branch.
- **No jsdom, no Testing Library.** Component tests are static-render assertions via `renderToStaticMarkup`, targeting exported presentational subcomponents (`ConversationItem`, `LaneTabs`) — `ConversationList` itself cannot be static-rendered because it opens Convex subscriptions.
- **Presence means set; clearing means `undefined`, never `false` or `0`.** `snoozedUntil` and `chasingForcedAt` follow `archivedAt`: a cleared field must be `undefined` so `eq(field, undefined)` stays an exact index range. Writing a sentinel breaks every lane query at once.
- **This repo keeps five hand-copied declarations in sync** with `notifications.type`: `convex/schema.ts`, `src/types/index.ts`, `src/lib/notifications/shared.ts`'s exhaustive `TYPE_ICON`, `convex/notifications.ts`'s `insertNotification` union, and `convex/_generated/api.d.ts`'s module list. This plan adds no notification type, but if you find yourself adding one, update all five.
- **Never widen a lane query into a `.filter()`.** Every lane is an exact index range; that property is the whole design. A union is acceptable only where the second set is bounded by construction and capped.

---

## File Structure

| File | Responsibility |
|---|---|
| `convex/schema.ts` | Five fields, two lane indexes gain keys, one new `by_snoozed_until` index |
| `convex/lib/inbox/overrides.ts` | **New.** Pure snooze-preset arithmetic — resolving "tomorrow 9am" against account working hours |
| `convex/lib/inbox/overrides.test.ts` | **New.** Unit tests, no database |
| `convex/inboxOverrides.ts` | **New.** `snooze` / `wake` / `forceChasing` / `unforceChasing` mutations + the wake sweep |
| `convex/inboxOverrides.test.ts` | **New.** Mutation and sweep tests |
| `convex/messages.ts` | Clear both overrides on inbound, in the message transaction |
| `convex/conversations.ts` | Bind both fields in the lane plans; Snoozed tab; Chasing union with forced rows |
| `convex/qualificationEngine.ts` | Snooze guard in `followUpContext` |
| `convex/lib/leadAnalysis/eligibility.ts` | `snoozed` tier-1 stop reason |
| `convex/inboxChaseAssign.ts` | Sweep skips snoozed; forced rows stay eligible |
| `convex/crons.ts`, `convex/cronSchedules.ts`, `convex/lib/cronSummary.ts` | Register `inbox-snooze-wake` |
| `src/components/inbox/conversation-list.tsx` | Snoozed tab, snoozed/forced row rendering |
| `src/components/inbox/message-thread.tsx` | Snooze split-button, Chase now |
| `src/app/(dashboard)/inbox/page.tsx` | `snoozed` lane wiring |
| `messages/en.json` | New strings |

---

### Task 1: Schema, indexes, and the preset arithmetic

**Files:**
- Create: `convex/lib/inbox/overrides.ts`, `convex/lib/inbox/overrides.test.ts`
- Modify: `convex/schema.ts` — fields after `returnedAt` (~line 321), the two lane indexes (~lines 444–461), one new index

**Interfaces:**
- Consumes: nothing
- Produces:
  - `conversations.snoozedUntil?: number`, `.snoozedByUserId?: Id<"users">`, `.snoozedReason?: string`
  - `conversations.chasingForcedAt?: number`, `.chasingForcedByUserId?: Id<"users">`
  - indexes `by_account_lane_last_message` and `by_account_assigned_lane_last_message` (both re-keyed), plus `by_snoozed_until`
  - `SNOOZE_PRESETS`, `resolveSnoozeUntilMs(preset, nowMs, config)`, `MAX_SNOOZE_DAYS`

- [ ] **Step 1: Write the failing preset test**

Create `convex/lib/inbox/overrides.test.ts`:

```ts
import { expect, test } from "vitest";
import { resolveSnoozeUntilMs, MAX_SNOOZE_DAYS } from "./overrides";

const HOUR = 3_600_000;
// Wed 2026-07-29 06:00 UTC == 10:00 Dubai (UTC+4).
const NOW = Date.UTC(2026, 6, 29, 6, 0, 0);
// Dubai, opens 10:00, Mon–Sat.
const CONFIG = { utcOffsetMinutes: 240, workStartMinute: 600, workDays: [1, 2, 3, 4, 5, 6] };

test("three_hours is exactly three hours out, no working-hours rounding", () => {
  expect(resolveSnoozeUntilMs("three_hours", NOW, CONFIG)).toBe(NOW + 3 * HOUR);
});

test("tomorrow lands at the next working day's opening, in account-local time", () => {
  // Thu 30 Jul, 10:00 Dubai == 06:00 UTC.
  expect(resolveSnoozeUntilMs("tomorrow", NOW, CONFIG)).toBe(Date.UTC(2026, 6, 30, 6, 0, 0));
});

test("tomorrow skips a non-working day", () => {
  // Sat 2026-08-01 10:00 Dubai. Sunday (0) is not a workday, so "tomorrow" is Monday.
  const sat = Date.UTC(2026, 7, 1, 6, 0, 0);
  expect(resolveSnoozeUntilMs("tomorrow", sat, CONFIG)).toBe(Date.UTC(2026, 7, 3, 6, 0, 0));
});

test("next_week lands on the following Monday's opening", () => {
  expect(resolveSnoozeUntilMs("next_week", NOW, CONFIG)).toBe(Date.UTC(2026, 7, 3, 6, 0, 0));
});

test("a custom time is returned as given, floored to five minutes", () => {
  const target = NOW + 7 * HOUR + 4 * 60_000 + 37_000;
  const got = resolveSnoozeUntilMs({ customMs: target }, NOW, CONFIG);
  expect(got % 300_000).toBe(0);
  expect(got).toBeLessThanOrEqual(target);
  expect(target - got).toBeLessThan(300_000);
});

test("a custom time in the past is rejected", () => {
  expect(() => resolveSnoozeUntilMs({ customMs: NOW - HOUR }, NOW, CONFIG)).toThrow();
});

test("a custom time beyond the ceiling is rejected", () => {
  const tooFar = NOW + (MAX_SNOOZE_DAYS + 1) * 24 * HOUR;
  expect(() => resolveSnoozeUntilMs({ customMs: tooFar }, NOW, CONFIG)).toThrow();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run convex/lib/inbox/overrides.test.ts`
Expected: FAIL — cannot resolve `./overrides`.

- [ ] **Step 3: Write the module**

Create `convex/lib/inbox/overrides.ts`. Note the working-hours arithmetic is the same
fixed-offset shifting `convex/lib/qualification/schedule.ts` uses — read
`clampToWorkingHours` there first and match its style; Gulf/India have no DST, which is why
plain millisecond maths is correct here and no `Intl` is needed.

```ts
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
```

- [ ] **Step 4: Run and confirm the tests pass**

Run: `npx vitest run convex/lib/inbox/overrides.test.ts`
Expected: PASS (all seven).

- [ ] **Step 5: Add the five fields**

In `convex/schema.ts`, in the `conversations` table after `returnedAt`:

```ts
    // ---- Manual overrides (spec 2026-07-28-inbox-manual-overrides) ----
    // PRESENCE = snoozed; the value is when to wake. A snoozed thread
    // appears in NO lane — that is what snooze means — and the lane
    // queries get that for free by binding `eq("snoozedUntil", undefined)`
    // as a single equality, exactly as they bind `archivedAt`.
    //
    // The wake sweep CLEARS this field rather than letting it sit in the
    // past. That is load-bearing, not tidiness: an expired-but-uncleared
    // row holds a number, not `undefined`, so it would fall out of every
    // lane range and stay invisible forever. See `inboxOverrides`.
    snoozedUntil: v.optional(v.number()),
    snoozedByUserId: v.optional(v.id("users")),
    /** Optional free text, shown on the Snoozed row so the tab is scannable. */
    snoozedReason: v.optional(v.string()),

    // PRESENCE = an agent has declared this lead ghosted, so it belongs
    // in Chasing regardless of age. Unlike snooze this does not expire;
    // it ends when the customer replies, the thread is archived, or an
    // agent undoes it.
    //
    // This one costs a union (Chasing becomes derived ∪ forced) and is
    // therefore an index key too, so Waiting can EXCLUDE forced rows by
    // equality instead of filtering — without that a forced thread would
    // appear in two lanes at once.
    chasingForcedAt: v.optional(v.number()),
    chasingForcedByUserId: v.optional(v.id("users")),
```

- [ ] **Step 6: Re-key the two lane indexes and add the wake index**

Replace the two lane index definitions. **Both new keys go before `lastMessageAt`** so it
stays the sole range/order key:

```ts
    .index("by_account_lane_last_message", [
      "accountId",
      "archivedAt",
      "snoozedUntil",
      "chasingForcedAt",
      "awaitingReply",
      "lastMessageAt",
    ])
    .index("by_account_assigned_lane_last_message", [
      "accountId",
      "archivedAt",
      "assignedToUserId",
      "snoozedUntil",
      "chasingForcedAt",
      "awaitingReply",
      "lastMessageAt",
    ])
    // The wake sweep's partition: `gt(0).lte(now)` is every snooze that
    // has come due. Deployment-global, no accountId — the same shape as
    // `qualificationSessions.by_due` and `leadAnalyses.by_score_due`.
    .index("by_snoozed_until", ["snoozedUntil"]),
```

**Expect the deploy to report these two indexes as deleted and re-added.** Changing an
index's key tuple is a drop-and-rebuild in Convex; that is normal for this change and not a
sign anything is wrong. Say so in your report.

- [ ] **Step 6b: Reorder the EXISTING index bindings so the branch stays green**

Re-keying a live index breaks every `withIndex` chain that binds it. Both new keys sit before
`lastMessageAt`, so every existing chain must bind them too — as `eq(undefined)`, which is
exactly what today's semantics already mean, since no conversation has an override yet. The
queries therefore return identical rows in an identical order; only the binding changes.

In `convex/conversations.ts` and `convex/inboxChaseAssign.ts`, find every chain with
`grep -n "by_account_lane_last_message\|by_account_assigned_lane_last_message"` and insert
`.eq("snoozedUntil", undefined).eq("chasingForcedAt", undefined)` at the position the index
declares:

- `by_account_lane_last_message`: after `archivedAt`
- `by_account_assigned_lane_last_message`: after `assignedToUserId`

**Add no new behaviour here** — no Snoozed tab, no forced union, no new `lane` value. Those
are Task 4 and must not leak forward.

- [ ] **Step 7: Verify the schema parses**

Run: `npx vitest run convex/schema.test.ts convex/lib/inbox/overrides.test.ts`
Expected: PASS. Then `npx tsc --noEmit` silent and `npx vitest run` fully green — Step 6b is
what makes that possible.

- [ ] **Step 8: Lint and commit**

```bash
npx eslint convex/schema.ts convex/lib/inbox/overrides.ts convex/lib/inbox/overrides.test.ts
git add convex/schema.ts convex/lib/inbox/overrides.ts convex/lib/inbox/overrides.test.ts
git commit -m "feat(inbox): override fields, re-keyed lane indexes, snooze presets"
```

---

### Task 2: The override mutations

**Files:**
- Create: `convex/inboxOverrides.ts`, `convex/inboxOverrides.test.ts`

**Interfaces:**
- Consumes: the five fields and `resolveSnoozeUntilMs` from Task 1
- Produces:
  - `api.inboxOverrides.snooze({ conversationId, preset?, customMs?, reason? })`
  - `api.inboxOverrides.wake({ conversationId })`
  - `api.inboxOverrides.forceChasing({ conversationId })`
  - `api.inboxOverrides.unforceChasing({ conversationId })`

- [ ] **Step 1: Write the failing tests**

Create `convex/inboxOverrides.test.ts`. Write a `seedThread` helper returning
`{ accountId, userId, asUser, conversationId }` with a `qualificationConfigs` row carrying
`utcOffsetMinutes: 240, workStartMinute: 600, workDays: [1,2,3,4,5,6]` — read the equivalent
helper in `convex/conversations.test.ts` and match how it seeds accounts/contacts, supplying
every field those tables require (`accounts.ownerUserId`, `contacts.phoneNormalized`).

```ts
test("snooze sets the wake time, the author, and the reason", async () => {
  const t = convexTest(schema, modules);
  const { userId, asUser, conversationId } = await seedThread(t, { role: "agent" });
  await asUser.mutation(api.inboxOverrides.snooze, {
    conversationId, preset: "three_hours", reason: "customer asked to call Tuesday",
  });
  const c = await t.run((ctx) => ctx.db.get(conversationId));
  expect(c!.snoozedUntil).toBeGreaterThan(Date.now());
  expect(c!.snoozedByUserId).toBe(userId);
  expect(c!.snoozedReason).toBe("customer asked to call Tuesday");
});

test("wake CLEARS the fields rather than zeroing them", async () => {
  const t = convexTest(schema, modules);
  const { asUser, conversationId } = await seedThread(t, { role: "agent" });
  await asUser.mutation(api.inboxOverrides.snooze, { conversationId, preset: "tomorrow" });
  await asUser.mutation(api.inboxOverrides.wake, { conversationId });
  const c = await t.run((ctx) => ctx.db.get(conversationId));
  // undefined, NOT 0 — a sentinel would fall out of every lane range.
  expect(c!.snoozedUntil).toBeUndefined();
  expect(c!.snoozedByUserId).toBeUndefined();
  expect(c!.snoozedReason).toBeUndefined();
});

test("snooze and force are mutually exclusive — each clears the other", async () => {
  const t = convexTest(schema, modules);
  const { asUser, conversationId } = await seedThread(t, { role: "agent" });

  await asUser.mutation(api.inboxOverrides.snooze, { conversationId, preset: "tomorrow" });
  await asUser.mutation(api.inboxOverrides.forceChasing, { conversationId });
  let c = await t.run((ctx) => ctx.db.get(conversationId));
  expect(c!.snoozedUntil).toBeUndefined();
  expect(c!.chasingForcedAt).toBeGreaterThan(0);

  await asUser.mutation(api.inboxOverrides.snooze, { conversationId, preset: "tomorrow" });
  c = await t.run((ctx) => ctx.db.get(conversationId));
  expect(c!.chasingForcedAt).toBeUndefined();
  expect(c!.snoozedUntil).toBeGreaterThan(0);
});

test("a custom snooze beyond the ceiling is rejected", async () => {
  const t = convexTest(schema, modules);
  const { asUser, conversationId } = await seedThread(t, { role: "agent" });
  await expect(
    asUser.mutation(api.inboxOverrides.snooze, {
      conversationId, customMs: Date.now() + 45 * 24 * 3_600_000,
    }),
  ).rejects.toThrow();
});

test("an agent may snooze and force; a viewer may do neither", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asAgent, conversationId } = await seedThread(t, { role: "agent" });
  const { asUser: asViewer } = await seedThread(t, { role: "viewer", accountId });

  await asAgent.mutation(api.inboxOverrides.snooze, { conversationId, preset: "three_hours" });
  await asAgent.mutation(api.inboxOverrides.wake, { conversationId });
  await asAgent.mutation(api.inboxOverrides.forceChasing, { conversationId });

  await expect(
    asViewer.mutation(api.inboxOverrides.snooze, { conversationId, preset: "three_hours" }),
  ).rejects.toThrow();
  await expect(
    asViewer.mutation(api.inboxOverrides.forceChasing, { conversationId }),
  ).rejects.toThrow();
});

test("the wake sweep clears only snoozes that have come due", async () => {
  const t = convexTest(schema, modules);
  const { conversationId: due } = await seedThread(t, { role: "agent" });
  const { conversationId: notDue } = await seedThread(t, { role: "agent" });
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.patch(due, { snoozedUntil: now - 60_000 });
    await ctx.db.patch(notDue, { snoozedUntil: now + 3_600_000 });
  });

  await t.mutation(internal.inboxOverrides.sweepSnoozeWake, {});

  expect((await t.run((ctx) => ctx.db.get(due)))!.snoozedUntil).toBeUndefined();
  expect((await t.run((ctx) => ctx.db.get(notDue)))!.snoozedUntil).toBeGreaterThan(now);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run convex/inboxOverrides.test.ts`
Expected: FAIL — `api.inboxOverrides` does not exist.

- [ ] **Step 3: Write the module**

Create `convex/inboxOverrides.ts`. All four public mutations use `accountMutation` from
`./lib/auth` and `requireConversationAccess` from `./lib/conversationAccess`, matching
`conversations.assign`. RBAC is `ctx.requireRole("agent")` — the same level as archive,
restore and stop-chasing, for the reason the spec's §RBAC gives.

```ts
import { v, ConvexError } from "convex/values";
import { accountMutation } from "./lib/auth";
import { internalMutation } from "./_generated/server";
import { requireConversationAccess } from "./lib/conversationAccess";
import { resolveSnoozeUntilMs, SNOOZE_PRESETS } from "./lib/inbox/overrides";
import type { SnoozeChoice } from "./lib/inbox/overrides";

// ============================================================
// Manual lane overrides (spec 2026-07-28-inbox-manual-overrides).
//
// An override is a fact a human knows that the derivation cannot. It is
// NOT a mirror of anything — there is no second source of truth to
// disagree with — which is what distinguishes it from the
// `conversations.chasing` mirror that v2 of the lanes spec removed.
//
// Both fields are PRESENCE flags. Clearing writes `undefined`, never a
// sentinel: every lane binds `eq(field, undefined)` as an index equality,
// so a `0` would drop the row out of all four lanes at once.
// ============================================================

/** Snooze and force are mutually exclusive: a thread is either parked or
 *  chased, never both. Applied on the way in by each mutation rather than
 *  checked afterwards, so the two fields can never both be set. */
const CLEAR_FORCE = { chasingForcedAt: undefined, chasingForcedByUserId: undefined };
const CLEAR_SNOOZE = {
  snoozedUntil: undefined,
  snoozedByUserId: undefined,
  snoozedReason: undefined,
};

export const snooze = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    preset: v.optional(v.union(...SNOOZE_PRESETS.map((p) => v.literal(p)))),
    customMs: v.optional(v.number()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireConversationAccess(ctx, args.conversationId, "view");

    if ((args.preset === undefined) === (args.customMs === undefined)) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "snooze_needs_exactly_one_of_preset_or_custom" });
    }

    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();

    const choice: SnoozeChoice =
      args.preset ?? { customMs: args.customMs as number };
    let until: number;
    try {
      until = resolveSnoozeUntilMs(choice, Date.now(), {
        // Fall back to the same Dubai defaults `lib/qualification/defaults.ts`
        // seeds, so an account that has never opened those settings still
        // gets a sensible "tomorrow" rather than a UTC midnight.
        utcOffsetMinutes: config?.utcOffsetMinutes ?? 240,
        workStartMinute: config?.workStartMinute ?? 600,
        workDays: config?.workDays ?? [1, 2, 3, 4, 5, 6],
      });
    } catch (err) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: err instanceof Error ? err.message : "snooze_invalid",
      });
    }

    await ctx.db.patch(args.conversationId, {
      snoozedUntil: until,
      snoozedByUserId: ctx.userId,
      snoozedReason: args.reason?.trim() || undefined,
      ...CLEAR_FORCE,
    });
    return until;
  },
});

export const wake = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireConversationAccess(ctx, args.conversationId, "view");
    await ctx.db.patch(args.conversationId, CLEAR_SNOOZE);
  },
});

export const forceChasing = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireConversationAccess(ctx, args.conversationId, "view");
    await ctx.db.patch(args.conversationId, {
      chasingForcedAt: Date.now(),
      chasingForcedByUserId: ctx.userId,
      ...CLEAR_SNOOZE,
    });
  },
});

export const unforceChasing = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireConversationAccess(ctx, args.conversationId, "view");
    await ctx.db.patch(args.conversationId, CLEAR_FORCE);
  },
});

/** Conversations woken per run. Bounded so a burst of same-minute
 *  snoozes cannot make one sweep unboundedly large. */
const WAKE_PER_RUN = 200;

/**
 * Clears every snooze that has come due.
 *
 * This sweep is LOAD-BEARING, not a convenience. `snoozedUntil` in the
 * past is still a present value, so the row keeps failing every lane's
 * `eq(snoozedUntil, undefined)` binding and stays invisible until this
 * runs. A stalled sweep hides conversations silently — which is why the
 * cron is registered through `cronSchedules.ts` (so a stall shows in
 * Settings → Cron schedules) and why the Snoozed tab ranges the
 * complement, keeping the set reachable even if this never fires.
 */
export const sweepSnoozeWake = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ woken: number }> => {
    const now = Date.now();
    const due = await ctx.db
      .query("conversations")
      .withIndex("by_snoozed_until", (q) =>
        q.gt("snoozedUntil", 0).lte("snoozedUntil", now),
      )
      .take(WAKE_PER_RUN);
    for (const conversation of due) {
      await ctx.db.patch(conversation._id, CLEAR_SNOOZE);
    }
    if (due.length > 0) console.log(`[inbox-snooze-wake] woke ${due.length}`);
    return { woken: due.length };
  },
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run convex/inboxOverrides.test.ts`
Expected: PASS (all six).

- [ ] **Step 5: Register the wake cron in all three places**

They must agree — `crons.ts`'s own header comment requires it. Add a wrapper in
`convex/cronSchedules.ts` following `runSweepChaseAssign`'s exact shape (so the run stamps a
`cronRuns` row), then in `convex/crons.ts`:

```ts
// Wake snoozed conversations whose time has come (spec
// 2026-07-28-inbox-manual-overrides §Waking). Clearing the field is what
// returns the thread to a lane — an expired-but-uncleared snooze is
// invisible forever — so this sweep is load-bearing, not cosmetic.
crons.interval(
  "inbox-snooze-wake",
  { minutes: 5 },
  internal.cronSchedules.runSweepSnoozeWake,
  {},
);
```

Add `{ name: "inbox-snooze-wake", intervalMinutes: 5 }` to `CRON_REGISTRY` in
`convex/lib/cronSummary.ts`.

- [ ] **Step 6: Run the cron and override suites**

Run: `npx vitest run convex/inboxOverrides.test.ts convex/cronSchedules.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/inboxOverrides.ts convex/inboxOverrides.test.ts convex/crons.ts convex/cronSchedules.ts convex/lib/cronSummary.ts
git add convex/inboxOverrides.ts convex/inboxOverrides.test.ts convex/crons.ts convex/cronSchedules.ts convex/lib/cronSummary.ts
git commit -m "feat(inbox): snooze and force-chasing mutations plus the wake sweep"
```

---

### Task 3: Clear both overrides on inbound, in the message transaction

**Files:**
- Modify: `convex/messages.ts` — the `patch` object in `insertMessageAndUpdateConversation`
- Test: `convex/messages.test.ts`

**Interfaces:**
- Consumes: the five fields from Task 1
- Produces: the invariant that after any inbound message, both overrides are cleared

**Read this before you start — it is the reason this task exists as its own task.**
The override clears go in `insertMessageAndUpdateConversation`, beside the existing
`awaitingReply` write and the un-archive call, because that function is the single
`insert("messages")` in the backend and therefore genuinely transactional.

This placement is not a preference. Un-archive-on-inbound was written into `ingest.ts`'s
best-effort fan-out for its first two months, and `runBestEffort` swallows failures by
design — so a swallowed failure left an archived customer invisible in every lane while they
were actively writing in, with nothing to retry it. That was fixed on 2026-07-28 (commit
`1fab57a`) by moving it into this same function; you will find `unarchiveOnInboundCore`
called there already. Put the override clears beside it, and do not move any of it back to
the fan-out.

- [ ] **Step 1: Write the failing tests**

Append to `convex/messages.test.ts`, reusing that file's existing seed helpers by their real
names (read the top of the file first):

```ts
test("an inbound message clears a snooze, in the message transaction", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "agent",
  });
  const conversationId = await seedConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(conversationId, {
    snoozedUntil: Date.now() + 86_400_000, snoozedReason: "next week",
  }));

  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "customer", contentType: "text", contentText: "actually...",
  });

  const c = await t.run((ctx) => ctx.db.get(conversationId));
  // Cleared WITHOUT the ingest fan-out running. A customer writing to us
  // outranks every filing decision, and must not depend on best-effort.
  expect(c!.snoozedUntil).toBeUndefined();
  expect(c!.snoozedReason).toBeUndefined();
  expect(c!.awaitingReply).toBe(true);
});

test("an inbound message clears a forced-chasing mark", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "agent",
  });
  const conversationId = await seedConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(conversationId, { chasingForcedAt: Date.now() }));

  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "customer", contentType: "text", contentText: "hi",
  });

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.chasingForcedAt).toBeUndefined();
});

test("an OUTBOUND message leaves both overrides alone", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "agent",
  });
  const conversationId = await seedConversation(t, accountId);
  const until = Date.now() + 86_400_000;
  await t.run((ctx) => ctx.db.patch(conversationId, { snoozedUntil: until }));

  // Sending a template into a snoozed thread must not un-park it — only
  // the CUSTOMER coming back does that.
  await asUser.mutation(api.messages.append, {
    conversationId, senderType: "bot", contentType: "text", contentText: "nudge",
  });

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.snoozedUntil).toBe(until);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run convex/messages.test.ts -t "clears a snooze"`
Expected: FAIL — `snoozedUntil` is still set.

- [ ] **Step 3: Implement**

In `insertMessageAndUpdateConversation`, extend the `Partial<{...}>` type literal with the
five override fields (each `undefined`-able), then inside the **existing**
`if (senderType === "customer") { ... }` block — the one that already sets `unreadCount` and
`lastInboundAt` — add:

```ts
    // A customer coming back outranks every filing decision an agent
    // made. Cleared HERE, in the message transaction, rather than in
    // `ingest`'s best-effort fan-out where `unarchiveOnInbound` lives:
    // that path swallows failures by design, so a swallowed failure
    // would leave a snoozed thread hidden while its customer is
    // actively writing into it. Same class of bug the lanes spec fixed
    // for `chasing`; do not "harmonise" this back to the fan-out.
    //
    // Unconditional rather than guarded on presence — patching
    // `undefined` over `undefined` is free, and a guard is one more
    // branch that can be wrong.
    patch.snoozedUntil = undefined;
    patch.snoozedByUserId = undefined;
    patch.snoozedReason = undefined;
    patch.chasingForcedAt = undefined;
    patch.chasingForcedByUserId = undefined;
```

Leave the `else if (conversation.adReferral ...)` branch untouched.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run convex/messages.test.ts convex/ingest.test.ts convex/alwaysReplyStrategy.test.ts`
Expected: PASS. `alwaysReplyStrategy.test.ts` drives the real inbound entry point end-to-end
and is the best single guard that the reply lifecycle is undisturbed.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint convex/messages.ts convex/messages.test.ts
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(inbox): an inbound message clears both lane overrides"
```

---

### Task 4: Lane queries — bind the overrides, add the Snoozed tab, union the forced set

**Files:**
- Modify: `convex/conversations.ts` — `list`'s args and both index callbacks
- Test: `convex/conversations.test.ts`

**Interfaces:**
- Consumes: the fields and re-keyed indexes from Task 1
- Produces: `lane: "active" | "waiting" | "chasing" | "snoozed"` on `api.conversations.list`

**The four bindings.** Every lane binds both override keys by equality except where noted:

| Lane | `snoozedUntil` | `chasingForcedAt` | `awaitingReply` | `lastMessageAt` |
|---|---|---|---|---|
| Active | `eq(undefined)` | `eq(undefined)` | `eq(true)` | none, order desc |
| Waiting | `eq(undefined)` | `eq(undefined)` | `eq(false)` | `gt(cutoff).lte(grace)`, desc |
| Chasing (derived) | `eq(undefined)` | `eq(undefined)` | `eq(false)` | `gt(0).lte(cutoff)`, **asc** |
| Chasing (forced) | `eq(undefined)` | `gt(0)` | — | — (see below) |
| Snoozed | `gt(0)` | — | — | — (ordered by wake time) |

- [ ] **Step 1: Write the failing tests**

Append to `convex/conversations.test.ts`, extending the existing `seedConversation` options
object with `snoozedUntil` and `chasingForcedAt` rather than writing a second helper:

```ts
test("a snoozed conversation appears in NO lane, and in the Snoozed tab", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const snoozed = await seedConversation(t, {
    accountId, contactId, awaitingReply: true,
    lastMessageAt: Date.now() - 60_000, snoozedUntil: Date.now() + 86_400_000,
  });

  const ids = async (lane: "active" | "waiting" | "chasing" | "snoozed") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  for (const lane of ["active", "waiting", "chasing"] as const) {
    expect(await ids(lane)).not.toContain(snoozed);
  }
  expect(await ids("snoozed")).toEqual([snoozed]);
});

test("a forced thread is in Chasing and NOT in Waiting, however recent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  // 30 minutes old: past grace, nowhere near the 3-day chasing cutoff,
  // so without the force this would be squarely in Waiting.
  const forced = await seedConversation(t, {
    accountId, contactId, awaitingReply: false,
    lastMessageAt: Date.now() - 30 * 60_000, chasingForcedAt: Date.now(),
  });

  const ids = async (lane: "waiting" | "chasing") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  expect(await ids("chasing")).toContain(forced);
  expect(await ids("waiting")).not.toContain(forced);
});

test("forced and derived Chasing rows appear together, without duplicates", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  const derived = await seedConversation(t, {
    accountId, contactId, awaitingReply: false, lastMessageAt: now - 9 * 86_400_000,
  });
  const forced = await seedConversation(t, {
    accountId, contactId, awaitingReply: false,
    lastMessageAt: now - 30 * 60_000, chasingForcedAt: now,
  });

  const page = (await asUser.query(api.conversations.list, {
    lane: "chasing", paginationOpts: { numItems: 50, cursor: null },
  })).page.map((c) => c._id);

  expect(new Set(page)).toEqual(new Set([derived, forced]));
  expect(page.length).toBe(2); // no row counted twice by the union
});

test("the four working lanes plus Snoozed stay disjoint and exhaustive", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sam", email: "sam@example.com", role: "supervisor",
  });
  await seedQualConfig(t, accountId);
  const contactId = await graceContact(t, accountId);
  const now = Date.now();
  const made = [
    await seedConversation(t, { accountId, contactId, awaitingReply: true, lastMessageAt: now - 60_000 }),
    await seedConversation(t, { accountId, contactId, awaitingReply: false, lastMessageAt: now - 60 * 60_000 }),
    await seedConversation(t, { accountId, contactId, awaitingReply: false, lastMessageAt: now - 9 * 86_400_000 }),
    await seedConversation(t, { accountId, contactId, awaitingReply: false, lastMessageAt: now - 60 * 60_000, chasingForcedAt: now }),
    await seedConversation(t, { accountId, contactId, awaitingReply: true, lastMessageAt: now - 60_000, snoozedUntil: now + 86_400_000 }),
  ];
  const page = async (lane: "active" | "waiting" | "chasing" | "snoozed") =>
    (await asUser.query(api.conversations.list, {
      lane, paginationOpts: { numItems: 50, cursor: null },
    })).page.map((c) => c._id);

  const all = [
    ...(await page("active")), ...(await page("waiting")),
    ...(await page("chasing")), ...(await page("snoozed")),
  ];
  expect(new Set(all).size).toBe(all.length); // disjoint
  expect(new Set(all)).toEqual(new Set(made)); // exhaustive
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run convex/conversations.test.ts -t "snoozed"`
Expected: FAIL — `"snoozed"` is not an accepted `lane` value.

- [ ] **Step 3: Widen the argument**

In `list`'s args:

```ts
    lane: v.optional(
      v.union(
        v.literal("active"),
        v.literal("waiting"),
        v.literal("chasing"),
        v.literal("snoozed"),
      ),
    ),
```

- [ ] **Step 4: Bind both overrides in each index callback**

In **both** index callbacks (the `eq`-plan one and the `any`/`meOrPool` one), insert the two
new equalities after `archivedAt` and before `awaitingReply`, and add the `snoozed` branch.
Keep the existing `waiting` / `chasing` / `active` bodies exactly as they are otherwise:

```ts
              // Snoozed is the complement: the one lane where these
              // fields are RANGED rather than equated, which is why it
              // cannot also bind the keys after them — same constraint
              // the Archived tab hits with `archivedAt`.
              if (lane === "snoozed") return scoped.gt("snoozedUntil", 0);

              const notOverridden = scoped
                .eq("snoozedUntil", undefined)
                .eq("chasingForcedAt", undefined);
              // ...then the existing active/waiting/chasing bodies,
              // built on `notOverridden` instead of `scoped`.
```

Snoozed orders **ascending** — soonest to wake first, which is what makes the tab scannable.
Pass `.order(lane === "chasing" || lane === "snoozed" ? "asc" : "desc")`.

- [ ] **Step 5: Add the forced-Chasing union**

Directly beneath the existing grace-set block (`GRACE_CAP`, `graceRows`) in the same function,
add its sibling. It is the identical pattern — read that block first and match it:

```ts
    // The Chasing lane's forced set (spec §Force-to-Chasing). Chasing is
    // (derived) UNION (forced), and like the grace set the second half is
    // bounded by construction — only threads a human has explicitly
    // marked — so it is one capped read merged into page one rather than
    // a filter over the main range.
    //
    // Merged into page one only, for the same reason: the cursor belongs
    // to the main range and never saw these rows.
    const FORCED_CAP = 60;
    let forcedRows: Doc<"conversations">[] = [];
    if (lane === "chasing" && paginationOpts.cursor === null) {
      const forcedQuery = ctx.db
        .query("conversations")
        .withIndex(
          plan.kind === "eq"
            ? "by_account_assigned_lane_last_message"
            : "by_account_lane_last_message",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the two builders have different key tuples; the branch above picks the matching one
          (ix: any) => {
            const scoped =
              plan.kind === "eq"
                ? ix
                    .eq("accountId", ctx.accountId)
                    .eq("archivedAt", undefined)
                    .eq("assignedToUserId", plan.assignee)
                    .eq("snoozedUntil", undefined)
                : ix
                    .eq("accountId", ctx.accountId)
                    .eq("archivedAt", undefined)
                    .eq("snoozedUntil", undefined);
            return scoped.gt("chasingForcedAt", 0);
          },
        )
        .order("desc");
      const raw = await forcedQuery.take(FORCED_CAP);
      forcedRows = raw.filter((c) => {
        if (status && c.status !== status) return false;
        if (plan.kind === "meOrPool") {
          return c.assignedToUserId === ctx.userId || c.assignedToUserId === undefined;
        }
        return true;
      });
    }
```

Then extend the existing merge so both extra sets are folded in. Chasing sorts **ascending**
by neglect, the opposite of the grace merge, so it needs its own comparator:

```ts
    const mergedPage = forcedRows.length
      ? [...forcedRows, ...result.page].sort(
          (a, b) => (a.lastMessageAt ?? 0) - (b.lastMessageAt ?? 0),
        )
      : graceRows.length
        ? [...graceRows, ...result.page].sort(
            (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
          )
        : result.page;
```

`graceRows` and `forcedRows` can never both be non-empty — one is gated on `lane === "active"`
and the other on `lane === "chasing"` — so the branches are exclusive by construction.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run convex/conversations.test.ts`
Expected: PASS, including every pre-existing test. `lane` absent must still reproduce
today's behaviour exactly.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/conversations.ts convex/conversations.test.ts
git add convex/conversations.ts convex/conversations.test.ts
git commit -m "feat(inbox): snoozed lane, forced-chasing union, override bindings"
```

---

### Task 5: Teach the three engines about a snooze

**Files:**
- Modify: `convex/qualificationEngine.ts` (`followUpContext`), `convex/lib/leadAnalysis/eligibility.ts` (`STOP_REASONS` + the gate chain), `convex/inboxChaseAssign.ts` (the sweep range)
- Test: `convex/qualificationEngine.test.ts`, `convex/lib/leadAnalysis/eligibility.test.ts`, `convex/inboxChaseAssign.test.ts`

**Interfaces:**
- Consumes: `conversations.snoozedUntil` / `.chasingForcedAt` from Task 1
- Produces: no new exports; `STOP_REASONS` gains `"snoozed"`

**The rule:** a deliberate park must not be talked over by a bot. A **forced** thread stays
fully eligible for everything — forcing it is a request for *more* attention, not less.

- [ ] **Step 1: Write the failing tests**

In `convex/qualificationEngine.test.ts`. It uses that file's real helpers — `seed`,
`seedAllHours`, `seedDueSession` and `messagesFor` (defined at lines 22, 695, 708 and 735
respectively); read the test at line 755 first, which is the closest existing analogue:

```ts
test("a snoozed conversation gets no qualification follow-up", async () => {
  const t = convexTest(schema, modules);
  const base = await seed(t);
  await seedAllHours(t);
  const sessionId = await seedDueSession(t, base);

  // Parked by a human until tomorrow.
  await t.run((ctx) => ctx.db.patch(base.conversationId, {
    snoozedUntil: Date.now() + 86_400_000,
  }));

  const verdict = await t.run(() =>
    t.query(internal.qualificationEngine.followUpContext, { sessionId }),
  );
  // A snooze defers; it does not cancel. The session stays `collecting`
  // so it resumes when the snooze lifts.
  expect(verdict.kind).toBe("reschedule");

  await t.mutation(internal.qualificationEngine.sweepFollowUps, {});
  // Nothing was said to the customer.
  expect(await messagesFor(t, base.conversationId)).toHaveLength(0);
  expect((await t.run((ctx) => ctx.db.get(sessionId)))!.status).toBe("collecting");
});
```

If `followUpContext` is an `internalQuery` that must be reached via `t.query` directly rather
than inside `t.run`, adjust the call to match how line 755's test invokes it — that test is
the authority on the calling convention, not this snippet.

In `convex/inboxChaseAssign.test.ts`:

```ts
test("the auto-assign sweep skips a snoozed thread", async () => {
  const t = convexTest(schema, modules);
  const { conversationId } = await seedChasing(t);
  await t.run((ctx) => ctx.db.patch(conversationId, {
    snoozedUntil: Date.now() + 86_400_000,
  }));

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId).toBeUndefined();
});

test("the auto-assign sweep DOES pick up a forced thread", async () => {
  const t = convexTest(schema, modules);
  // quietDays: 1 keeps it inside Waiting by derivation; the force is the
  // only reason it should be swept.
  const { agentId, conversationId } = await seedChasing(t, { quietDays: 1 });
  await t.run((ctx) => ctx.db.patch(conversationId, { chasingForcedAt: Date.now() }));

  await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});

  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.assignedToUserId).toBe(agentId);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run convex/inboxChaseAssign.test.ts -t "snoozed"`
Expected: FAIL — the sweep assigns it anyway.

- [ ] **Step 3: Guard the qualification engine**

In `followUpContext`, beside the existing `aiAutoreplyDisabled` and archived guards, add:

```ts
    // A snooze is a deliberate park by a human. Same class of signal as
    // an explicit Take over, so it yields the same way — waiting out the
    // expiry clock rather than cancelling the session, since the snooze
    // will lift on its own.
    if (conversation.snoozedUntil !== undefined) {
      return { kind: "reschedule", at: expiryRevisit };
    }
```

- [ ] **Step 4: Add the sequence engine's stop reason**

In `convex/lib/leadAnalysis/eligibility.ts`, add `"snoozed"` to `STOP_REASONS` beside
`"archived"` with the comment `// a human parked this thread until a set time`, and add the
gate itself in **tier 1** — it is a fact about the lead, not about our ability to send, so it
belongs with `archived` and not with the tier-4 send-capability gates. Read that file's tier
documentation before placing it; the tier ordering is explicitly load-bearing.

- [ ] **Step 5: Exclude snoozed rows from the auto-assign sweep**

In `convex/inboxChaseAssign.ts`, add `.eq("snoozedUntil", undefined)` to the sweep's index
range. **It goes AFTER `assignedToUserId`, not before it** — the sweep uses
`by_account_assigned_lane_last_message`, whose key order after Task 1 is
`accountId, archivedAt, assignedToUserId, snoozedUntil, chasingForcedAt, awaitingReply,
lastMessageAt`. Bind the equalities in exactly that order; Convex requires an equality on
every key preceding a range, so a mis-ordered chain either fails to compile or silently
selects the wrong rows.
Then, so a forced thread is actually reachable, add a second bounded read for forced rows
mirroring the sweep's main range but binding `gt("chasingForcedAt", 0)` instead of the
`lastMessageAt` window, capped at `ASSIGN_PER_RUN`, and process both lists.

- [ ] **Step 6: Run all three suites**

Run: `npx vitest run convex/qualificationEngine.test.ts convex/lib/leadAnalysis/eligibility.test.ts convex/inboxChaseAssign.test.ts`
Expected: PASS. Record `qualificationEngine.test.ts`'s count before and after — it must not
drop.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/qualificationEngine.ts convex/lib/leadAnalysis/eligibility.ts convex/inboxChaseAssign.ts convex/inboxChaseAssign.test.ts convex/qualificationEngine.test.ts
git add convex/qualificationEngine.ts convex/lib/leadAnalysis/eligibility.ts convex/inboxChaseAssign.ts convex/inboxChaseAssign.test.ts convex/qualificationEngine.test.ts convex/lib/leadAnalysis/eligibility.test.ts
git commit -m "feat(inbox): every engine respects a snooze; forced stays eligible"
```

---

### Task 6: Archive clears both overrides

**Files:**
- Modify: `convex/leadAnalysis.ts` — `archiveConversationCore`
- Test: `convex/leadAnalysis.test.ts`

**Interfaces:**
- Consumes: the fields from Task 1
- Produces: no new exports

Archived outranks everything. A stale snooze on a shelved thread would resurrect it into no
lane at all once the wake sweep cleared it — invisible in both the Archived tab and every
working lane.

- [ ] **Step 1: Write the failing test**

```ts
test("archiving clears a snooze and a forced-chasing mark", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "agent",
  });
  const conversationId = await seedConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(conversationId, {
    snoozedUntil: Date.now() + 86_400_000, chasingForcedAt: Date.now(),
  }));

  await asUser.mutation(api.leadAnalysis.archive, { conversationId });

  const c = await t.run((ctx) => ctx.db.get(conversationId));
  expect(c!.archivedAt).toBeGreaterThan(0);
  expect(c!.snoozedUntil).toBeUndefined();
  expect(c!.chasingForcedAt).toBeUndefined();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run convex/leadAnalysis.test.ts -t "archiving clears"`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `archiveConversationCore`, inside the existing
`if (conversation.archivedAt === undefined)` patch, add the five clears with a comment noting
archived outranks both overrides.

- [ ] **Step 4: Run and commit**

```bash
npx vitest run convex/leadAnalysis.test.ts
npx eslint convex/leadAnalysis.ts convex/leadAnalysis.test.ts
git add convex/leadAnalysis.ts convex/leadAnalysis.test.ts
git commit -m "feat(inbox): archiving clears both lane overrides"
```

---

### Task 7: The UI

**Files:**
- Modify: `src/components/inbox/conversation-list.tsx`, `src/components/inbox/message-thread.tsx`, `src/app/(dashboard)/inbox/page.tsx`, `messages/en.json`
- Test: `src/components/inbox/conversation-list.test.tsx`

**Interfaces:**
- Consumes: the `snoozed` lane from Task 4; the four mutations from Task 2
- Produces: `InboxLane` widens to include `"snoozed"`

**Do not attempt browser verification.** This app has an auth wall that blocks unauthenticated
in-app checks; a subagent will burn turns on a login screen. Tests plus typecheck are your
verification. Say in your report that you skipped it.

- [ ] **Step 1: Add the strings**

```json
"laneSnoozed": "Snoozed",
"laneSnoozedEmpty": "Nothing snoozed.",
"snooze": "Snooze",
"snoozeThreeHours": "3 hours",
"snoozeTomorrow": "Tomorrow morning",
"snoozeNextWeek": "Next Monday",
"snoozeCustom": "Pick a time…",
"snoozeReasonPlaceholder": "Why? (optional)",
"snoozedUntilRow": "Snoozed until {when}",
"snoozeFailed": "Could not snooze this conversation.",
"wake": "Wake now",
"chaseNow": "Chase now",
"chaseNowTooltip": "Move to Chasing now — for a lead you can already tell has gone quiet.",
"forcedChasingBadge": "Marked",
"chaseNowFailed": "Could not move this conversation to Chasing.",
"undo": "Undo"
```

- [ ] **Step 2: Write the failing component tests**

Append to `src/components/inbox/conversation-list.test.tsx`. That file already has everything
you need: a module-level `t` translator stub (a plain `Record` lookup cast to the prop type,
line ~30), a `tWindow` stub, a fixed `NOW` clock, and a `render(conv, props?)` helper (line 75)
that supplies every required `ConversationItem` prop. **Use `render`, do not hand-build the
element**, and add your new strings to that file's `T_STRINGS` map so the translator resolves
them:

```ts
test("a forced Chasing row is marked, so it reads differently from one that aged in", () => {
  const markup = render(
    {
      ...baseConversation,
      chasing_forced_at: new Date(NOW - 60_000).toISOString(),
      last_message_at: new Date(NOW - 30 * 60_000).toISOString(),
    },
    { lane: "chasing" },
  );
  expect(markup).toContain("Marked");
});

test("a snoozed row shows when it wakes", () => {
  const markup = render(
    {
      ...baseConversation,
      snoozed_until: new Date(NOW + 86_400_000).toISOString(),
    },
    { lane: "snoozed" },
  );
  expect(markup).toContain("Snoozed until");
});
```

`baseConversation` is whatever fixture the file's existing tests pass as `render`'s first
argument — read one and reuse it by its real name rather than inventing a fixture.

For the fifth tab, extend the file's existing `LaneTabs` test rather than adding a new one:
add `"Snoozed"` to the list of labels it already asserts.

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run src/components/inbox/conversation-list.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Widen the lane type and tab list**

In `conversation-list.tsx`, widen `InboxLane` to include `"snoozed"`, add the tab to
`LANE_TABS`, and add `snoozed: "laneSnoozedEmpty"` to the `laneEmptyMessageKey` map.

Surface `snoozedUntil` / `chasingForcedAt` on the row: add them to the returned row shape in
`conversations.list` beside `followUpsSent`, thread them through `toUiConversation` in
`src/lib/convex/adapters.ts` as `snoozed_until` / `chasing_forced_at` (snake_case, matching
that type's convention — note `followUpsSent` broke it and should not be copied), and render
`snoozedUntilRow` on Snoozed rows and the `forcedChasingBadge` on forced Chasing rows.

- [ ] **Step 5: Wire the page**

In `inbox/page.tsx`, the query spread becomes three-way — `archived` and `lane` are still
mutually exclusive and `snoozed` is a normal lane value:

```tsx
      ...(lane === "archived" ? { archived: true } : { lane }),
```

That line already handles it once `InboxLane` includes `"snoozed"`; confirm no other branch
needs changing.

- [ ] **Step 6: Add the thread-header controls**

In `message-thread.tsx`, beside the existing Archive and Stop chasing buttons, add a **Snooze**
split-button (primary action = 3 hours, dropdown = the other presets plus Custom) and a
**Chase now** button. Gate both on `hasMinRole(accountRole, "agent")`, exactly as `canArchive`
and `canStopChasing` already are. Show **Wake now** instead of Snooze when
`conversation.snoozed_until` is set, and hide **Chase now** when it is.

Both actions toast with an Undo that calls the inverse mutation (`wake` / `unforceChasing`) —
each hides the thread from where the agent was looking, so a misclick is otherwise only
recoverable by hunting through a tab. Failures use `toast.error`, matching `handleArchive`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/components/inbox/conversation-list.test.tsx convex/conversations.test.ts`
Expected: PASS.

- [ ] **Step 8: Full suite, typecheck, lint, commit**

```bash
npx vitest run
npx tsc --noEmit
npx eslint src/components/inbox/conversation-list.tsx src/components/inbox/conversation-list.test.tsx src/components/inbox/message-thread.tsx "src/app/(dashboard)/inbox/page.tsx" src/lib/convex/adapters.ts convex/conversations.ts
git add src/components/inbox/conversation-list.tsx src/components/inbox/conversation-list.test.tsx src/components/inbox/message-thread.tsx "src/app/(dashboard)/inbox/page.tsx" src/lib/convex/adapters.ts convex/conversations.ts messages/en.json
git commit -m "feat(inbox): snoozed tab, snooze and chase-now controls"
```

---

## Deploy sequence (owner-run)

Much simpler than the lanes rollout, and for a specific reason: **absence is already the
correct value for every existing row**, so there is no backfill and no window where the data
is half-migrated.

1. **`npx convex deploy` from the worktree.** Ships the fields, the re-keyed indexes, the
   mutations, the engine guards and the wake cron together.

   Expect the output to report `by_account_lane_last_message` and
   `by_account_assigned_lane_last_message` as **deleted and re-added** — changing an index's
   key tuple is a drop-and-rebuild. That is expected here, unlike the lanes deploy where "no
   indexes are deleted" was the reassuring signal. The rebuild is online; the lanes keep
   working throughout.

   Everything is inert on arrival: no row has either field set, so every lane's
   `eq(undefined)` binding matches exactly what it matched before, and the wake sweep finds
   nothing.

2. **Merge the PR** so Netlify ships the UI.

There is no ordering hazard between the two halves this time — the UI's only new query
argument is `lane: "snoozed"`, and step 1 deploys the backend that accepts it.

## Note on a defect this plan was originally written around

An earlier revision of this plan warned that `conversations.unarchiveOnInbound` ran in
`ingest.ts`'s best-effort fan-out rather than the message transaction, contradicting P2's own
spec — so an archived customer who replied could silently stay archived.

**That was fixed before this plan began** (commit `1fab57a`, 2026-07-28): the behaviour moved
into `unarchiveOnInboundCore`, called from `insertMessageAndUpdateConversation`. Task 3 now
sits beside a correct precedent rather than warning against a broken one.
