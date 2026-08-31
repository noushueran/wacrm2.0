# Roster work counts from the hourly rollup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `/agents` Roster tab's "work today" count exact and ≤24 document reads, by sourcing it from the `aiUsageHourlyStats` rollup instead of a capped scan of raw `aiUsageLog` rows.

**Architecture:** `agentRoster.roster` currently reads today's raw usage rows with `.take(1024)` and counts one per row. That cap trips daily on this account (~4,084 calls/day), so the count freezes on the earliest quarter of the day. The rollup already stores per-mode `calls` per UTC hour, indexed `by_account_hour`; midnight UTC is itself an hour boundary, so today's buckets are an exact index range of at most 24 documents. `tallyWork` generalizes from counting rows to summing per-mode tallies, and the `workOverflow` flag plus its `+` suffix in the UI are deleted.

**Tech Stack:** Convex (queries, schema, `convex-test`), TypeScript, React 19 + Next.js, Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-09-roster-hourly-rollup-design.md`. Read it before starting.
- **Never run `npx convex deploy`, `npx convex dev`, or `npx convex codegen`.** No codegen is required: `convex/_generated/dataModel.d.ts:60` derives `DataModel` from `schema.ts` at the type level, and `api.d.ts` imports `typeof aiUsage` wholesale. This was verified — typecheck passes clean on this branch with `aiUsageHourlyStats` already in schema.
- **Prerequisite is already merged into this branch** (merge of `94cf3f6`, `fix/usage-tab-hourly-rollup`). `convex/lib/aiUsageStats.ts` and the `aiUsageHourlyStats` table exist here. That branch is not yet on `main` — do not rebase or force-push this branch.
- **Baseline is green:** 50 tests pass across the five affected files. Any red at the start of a task is a problem with the task, not pre-existing.
- **Lint scoped to changed files only:** `npx eslint <paths>`, never a whole-repo run.
- **Stage explicit paths in `git add`** — never `git add -A` or `git add .`. Other sessions share this checkout.
- `roster` stays MEMBER-safe: no `ctx.requireRole`, and no keys, prompts, models, or token counts in the response.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `convex/lib/agentRegistry.ts` | Pure registry + `tallyWork` + status derivation. Gains a tally-shaped `tallyWork`; loses `ROSTER_SCAN_WINDOW`. | 1, 2 |
| `convex/lib/agentRegistry.test.ts` | Unit tests for the pure module. | 1 |
| `convex/agentRoster.ts` | The `roster` query. Switches read source; loses `workOverflow`. | 1, 2 |
| `convex/agentRoster.test.ts` | `convex-test` integration tests for `roster`. | 2 |
| `src/components/agents/agent-roster.tsx` | Roster view. Loses `workOverflow` from `RosterData` and the `+` suffix. | 2 |
| `src/components/agents/agent-roster.test.tsx` | Static-render tests. Loses the capped-count test. | 2 |

Two tasks, because the signature change and the data-source change are separately reviewable, but neither can be split further without leaving the tree red: removing `workOverflow` from the query's return type immediately breaks `RosterData` at the call site, so backend and UI must move together in Task 2.

---

### Task 1: `tallyWork` counts per-mode tallies instead of rows

A pure, behaviour-preserving refactor. The call site adapts by mapping each raw row to `{ mode, calls: 1 }`, so `roster`'s output is byte-identical after this task. Task 2 then swaps what feeds it.

**Files:**
- Modify: `convex/lib/agentRegistry.ts:196-222` (the `tallyWork` doc comment and body)
- Modify: `convex/agentRoster.ts:84` (the call site)
- Test: `convex/lib/agentRegistry.test.ts:59-88`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `tallyWork(tallies: Array<{ mode: string; calls: number }>): Record<AgentKey, number>` — Task 2 calls this with the `modes` arrays of `aiUsageHourlyStats` rows flattened together.

- [ ] **Step 1: Rewrite the three existing `tallyWork` tests to pass tallies, and add an accumulation test**

In `convex/lib/agentRegistry.test.ts`, replace the three tests spanning lines 59-88 with these four:

```ts
test("tallyWork buckets per-mode tallies by owning agent", () => {
  const counts = tallyWork([
    { mode: "auto_reply", calls: 2 },
    { mode: "draft", calls: 1 },
    { mode: "qualify", calls: 1 },
    { mode: "classify", calls: 1 },
    { mode: "match_service", calls: 1 },
  ]);
  expect(counts.reply).toBe(3);
  expect(counts.qualify).toBe(1);
  expect(counts.tags).toBe(1);
  expect(counts.admatch).toBe(1);
  expect(counts.score).toBe(0);
});

test("repeated entries for one mode accumulate, never overwrite", () => {
  // One entry per mode per HOUR bucket, so a full day hands the same
  // mode over twenty times. Assigning instead of adding would report
  // the last hour and call it the day.
  const counts = tallyWork([
    { mode: "qualify", calls: 40 },
    { mode: "qualify", calls: 55 },
    { mode: "qualify", calls: 12 },
  ]);
  expect(counts.qualify).toBe(107);
});

test("match_service counts to the ad matcher, never the tag suggester", () => {
  const counts = tallyWork([
    { mode: "match_service", calls: 1 },
    { mode: "match_service", calls: 1 },
  ]);
  expect(counts.admatch).toBe(2);
  expect(counts.tags).toBe(0);
});

test("shared-sense modes are attributed to no agent", () => {
  const counts = tallyWork([
    { mode: "transcribe", calls: 31 },
    { mode: "describe", calls: 4 },
    { mode: "embed", calls: 1963 },
  ]);
  expect(Object.values(counts).every((n) => n === 0)).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run convex/lib/agentRegistry.test.ts
```

Expected: FAIL. The tally objects have an extra `calls` property that the current `Array<{ mode: string }>` parameter does not declare, and `repeated entries for one mode accumulate` expects 107 where the current body would produce 3 (one per entry).

- [ ] **Step 3: Change `tallyWork` to sum tallies**

In `convex/lib/agentRegistry.ts`, replace the `tallyWork` doc comment and function (lines 196-222) with:

```ts
/**
 * Bucket per-mode call tallies onto the agent that earned them.
 *
 * Takes tallies rather than rows because the source is
 * `aiUsageHourlyStats`, which already counted the calls at write time —
 * one `{ mode, calls }` entry per mode per UTC hour. It therefore
 * ACCUMULATES: a mode reappears in every hour it was used, so assigning
 * would report the last hour of the day and call it the whole day.
 *
 * `transcribe`, `describe`, and `embed` are deliberately attributed to
 * NOBODY. They are shared senses — the vision pass, the voice pass, and
 * the retrieval embedding are used by several agents on one another's
 * behalf, so charging them to any single agent would misreport all of
 * them. They remain visible in aggregate on the usage tab. They are also
 * roughly half of this deployment's daily call volume, which is why the
 * old row-scanning version spent half its read budget on rows that could
 * not increment anything.
 */
export function tallyWork(
  tallies: Array<{ mode: string; calls: number }>,
): Record<AgentKey, number> {
  const owner = new Map<string, AgentKey>();
  for (const agent of AGENT_REGISTRY) {
    for (const mode of agent.modes) owner.set(mode, agent.key);
  }

  const counts = Object.fromEntries(
    AGENT_REGISTRY.map((a) => [a.key, 0]),
  ) as Record<AgentKey, number>;

  for (const tally of tallies) {
    const key = owner.get(tally.mode);
    if (key) counts[key] += tally.calls;
  }
  return counts;
}
```

- [ ] **Step 4: Adapt the call site so the tree still compiles**

In `convex/agentRoster.ts`, replace line 84:

```ts
    const work = tallyWork(usageRows);
```

with:

```ts
    // `calls: 1` per row — Task 2 replaces this scan with the rollup,
    // which carries real per-mode counts.
    const work = tallyWork(usageRows.map((row) => ({ mode: row.mode, calls: 1 })));
```

- [ ] **Step 5: Run the tests and typecheck to verify they pass**

```bash
npx vitest run convex/lib/agentRegistry.test.ts convex/agentRoster.test.ts
```

Expected: PASS, all tests in both files. `agentRoster.test.ts` must stay green untouched — that is the proof this refactor changed no behaviour.

```bash
npm run typecheck
```

Expected: no output, exit 0.

- [ ] **Step 6: Lint and commit**

```bash
npx eslint convex/lib/agentRegistry.ts convex/lib/agentRegistry.test.ts convex/agentRoster.ts
```

```bash
git add convex/lib/agentRegistry.ts convex/lib/agentRegistry.test.ts convex/agentRoster.ts
git commit -m "refactor(agents): tallyWork counts per-mode tallies, not rows

Behaviour-preserving. The caller still hands it one entry per raw usage
row with calls: 1; the next commit swaps that scan for the hourly
rollup, which counted the calls already."
```

---

### Task 2: `roster` reads the hourly rollup, and the overflow flag goes

**Files:**
- Modify: `convex/agentRoster.ts` (header comment, imports, `startOfTodayMs` doc, the read, the return type, the return statement)
- Modify: `convex/lib/agentRegistry.ts:188-194` (delete `ROSTER_SCAN_WINDOW`)
- Modify: `src/components/agents/agent-roster.tsx` (the `RosterData` interface, and the work-count line at :236)
- Test: `convex/agentRoster.test.ts`, `src/components/agents/agent-roster.test.tsx`

**Interfaces:**
- Consumes: `tallyWork(tallies: Array<{ mode: string; calls: number }>)` from Task 1.
- Produces: `roster` returns `{ agents: RosterAgent[] }` — `workOverflow` is gone from the wire.

- [ ] **Step 1: Write the failing backend tests**

In `convex/agentRoster.test.ts`, remove `workOverflow: boolean;` from the `RosterShape` interface (line 39).

Add these two helpers below the existing `seedAiConfig` helper:

```ts
const HOUR_MS = 60 * 60 * 1000;

/** Matches `agentRoster.ts`'s own `startOfTodayMs`: midnight UTC. */
function startOfTodayMs(): number {
  return new Date(new Date().toISOString().slice(0, 10)).getTime();
}

/**
 * One `aiUsageHourlyStats` bucket. Token counters are deliberately
 * NON-ZERO so the viewer-access test below genuinely proves the roster
 * does not leak them — seeding zeroes would make that assertion pass for
 * the wrong reason.
 *
 * The caller gives `{ mode, calls }`; the schema's `modes` entries also
 * require `tokens`, which the roster never reads, so it is filled in
 * here rather than at every call site.
 */
async function seedUsageHour(
  t: ReturnType<typeof convexTest>,
  accountId: string,
  hourStartMs: number,
  modes: Array<{ mode: AiUsageMode; calls: number }>,
) {
  return await t.run((ctx) =>
    ctx.db.insert("aiUsageHourlyStats", {
      accountId: accountId as never,
      hourStartMs,
      calls: modes.reduce((n, m) => n + m.calls, 0),
      promptTokens: 900,
      completionTokens: 300,
      totalTokens: 1200,
      cachedPromptTokens: 100,
      cacheablePromptTokens: 900,
      reasoningTokens: 50,
      modes: modes.map((m) => ({ ...m, tokens: m.calls * 10 })),
      models: [
        { provider: "openai" as const, model: "gpt-5", calls: 1, tokens: 1200 },
      ],
    }),
  );
}
```

Add this import at the top of the file, below the `AccountRole` import:

```ts
import type { AiUsageMode } from "./lib/aiUsageStats";
```

Replace the test `today's usage rows count to their owning agent` (lines 136-159) with:

```ts
test("today's rollup counts to the owning agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");
  await seedAiConfig(t, accountId, userId);

  await seedUsageHour(t, accountId, startOfTodayMs(), [
    { mode: "auto_reply", calls: 2 },
    { mode: "draft", calls: 1 },
    { mode: "classify", calls: 1 },
  ]);

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(find(result, "reply").workToday).toBe(3);
  expect(find(result, "tags").workToday).toBe(1);
});

test("a mode's calls sum across every hour bucket of the day", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");
  await seedAiConfig(t, accountId, userId);

  // The case the old 1024-row cap could not report: a day's real volume,
  // spread across the hours it actually happened in.
  const midnight = startOfTodayMs();
  await seedUsageHour(t, accountId, midnight, [{ mode: "qualify", calls: 40 }]);
  await seedUsageHour(t, accountId, midnight + 5 * HOUR_MS, [
    { mode: "qualify", calls: 55 },
  ]);
  await seedUsageHour(t, accountId, midnight + 9 * HOUR_MS, [
    { mode: "qualify", calls: 12 },
  ]);

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(find(result, "qualify").workToday).toBe(107);
});

test("a bucket from before midnight UTC is not today's work", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");
  await seedAiConfig(t, accountId, userId);

  const midnight = startOfTodayMs();
  await seedUsageHour(t, accountId, midnight - HOUR_MS, [
    { mode: "auto_reply", calls: 99 },
  ]);
  await seedUsageHour(t, accountId, midnight, [
    { mode: "auto_reply", calls: 4 },
  ]);

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(find(result, "reply").workToday).toBe(4);
});
```

Replace the body of `one account's usage never counts toward another's roster` (lines 175-185, the `t.run` inserting into `aiUsageLog`) with:

```ts
  await seedUsageHour(t, theirAccountId, startOfTodayMs(), [
    { mode: "auto_reply", calls: 7 },
  ]);
```

Finally, make the viewer test load-bearing. Replace `a viewer may read the roster — it carries no keys, prompts, or tokens` (lines 191-201) in full with:

```ts
test("a viewer may read the roster — it carries no keys, prompts, or tokens", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "viewer");
  // Seed real token counters: the roster now reads documents that CARRY
  // tokens, so this assertion only means something if there are some to
  // leak.
  await seedUsageHour(t, accountId, startOfTodayMs(), [
    { mode: "auto_reply", calls: 3 },
  ]);

  const result = (await as.query(api.agentRoster.roster, {})) as RosterShape;
  expect(result.agents).toHaveLength(10);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("apiKey");
  expect(serialized).not.toContain("systemPrompt");
  expect(serialized).not.toContain("promptTokens");
  expect(serialized).not.toContain("1200");
});
```

- [ ] **Step 2: Run the backend tests to verify they fail**

```bash
npx vitest run convex/agentRoster.test.ts
```

Expected: FAIL. `today's rollup counts to the owning agent` reports 0 for both agents (the query still scans `aiUsageLog`, and nothing seeds it any more), and the two new tests fail the same way.

- [ ] **Step 3: Switch the query to the rollup**

In `convex/agentRoster.ts`, drop `ROSTER_SCAN_WINDOW` from the import block (lines 2-9), leaving:

```ts
import { accountQuery } from "./lib/auth";
import {
  AGENT_REGISTRY,
  deriveAgentStatus,
  tallyWork,
  type AgentKey,
  type AgentStatus,
} from "./lib/agentRegistry";
```

Replace the last paragraph of the module header (lines 24-28, beginning "Every read is bounded.") with:

```
// Every read is bounded. This is a live subscription over tables the
// engines write constantly — see `lib/cronSummary.ts`'s
// `SYSTEM_SCAN_WINDOW` for what the unbounded version cost this
// deployment in production on 2026-07-18. Work counts come from the
// hourly rollup rather than the raw usage log, which makes them bounded
// by the DAY (24 documents) instead of by traffic, and exact besides.
```

Replace the `startOfTodayMs` doc comment (lines 40-45) with:

```ts
/**
 * Midnight UTC today. Account-local day boundaries are deliberately not
 * modeled: this is the same bound `aiUsage`'s own windows use, and the
 * roster's claim is "today's work", not "work since your local
 * midnight" — a distinction nobody reading a status board is relying on.
 *
 * It is also, conveniently, exactly an hour boundary, which is what lets
 * the `aiUsageHourlyStats` read below range on it directly with no
 * partial-hour guard — unlike `aiUsage.summary`, whose caller-supplied
 * `sinceMs` can land mid-hour and needs `hourStartMs()` first.
 */
```

Add this constant directly below that function:

```ts
/**
 * At most 24 UTC hours can start on or after midnight UTC today, so this
 * bound is exact rather than defensive. It stays a `.take()` anyway:
 * every read in this query is bounded, and here the bound documents the
 * arithmetic instead of hiding a truncation — which is what the 1024-row
 * cap it replaced had quietly become.
 */
const HOURS_PER_DAY = 24;
```

Replace the read (lines 74-85) with:

```ts
    // Bounded AND exact: the rollup counted these calls at write time, so
    // today is at most 24 documents no matter how busy the account is.
    // The raw-log version this replaces needed a 1024-row cap that this
    // account tripped every morning, freezing the count on the earliest
    // quarter of the day — see
    // `docs/superpowers/specs/2026-08-09-roster-hourly-rollup-design.md`.
    const sinceMs = startOfTodayMs(Date.now());
    const hours = await ctx.db
      .query("aiUsageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q.eq("accountId", ctx.accountId).gte("hourStartMs", sinceMs),
      )
      .take(HOURS_PER_DAY);
    const work = tallyWork(hours.flatMap((h) => h.modes));
```

Change the handler's return type (line 54) from:

```ts
  ): Promise<{ agents: RosterAgent[]; workOverflow: boolean }> => {
```

to:

```ts
  ): Promise<{ agents: RosterAgent[] }> => {
```

and the return statement (line 181) from `return { agents, workOverflow };` to:

```ts
    return { agents };
```

- [ ] **Step 4: Delete `ROSTER_SCAN_WINDOW`**

In `convex/lib/agentRegistry.ts`, delete lines 188-194 in full — the doc comment and the `export const ROSTER_SCAN_WINDOW = 1024;`. `agentRoster.ts` was its only consumer. Leave `SYSTEM_SCAN_WINDOW` in `lib/cronSummary.ts` alone; it is a different constant with a live consumer in `cronSchedules.ts`.

- [ ] **Step 5: Run the backend tests to verify they pass**

```bash
npx vitest run convex/agentRoster.test.ts convex/lib/agentRegistry.test.ts
```

Expected: PASS.

- [ ] **Step 6: Update the UI and its tests**

In `src/components/agents/agent-roster.tsx`, change the `RosterData` interface (around line 91) from:

```ts
export interface RosterData {
  agents: RosterAgentView[];
  workOverflow: boolean;
}
```

to:

```ts
export interface RosterData {
  agents: RosterAgentView[];
}
```

and the work-count line (around line 236) from:

```tsx
                  {agent.blockedReason ??
                    (agent.workToday > 0
                      ? `${agent.workToday}${data.workOverflow ? '+' : ''} today`
                      : 'nothing yet today')}
```

to:

```tsx
                  {agent.blockedReason ??
                    (agent.workToday > 0
                      ? `${agent.workToday} today`
                      : 'nothing yet today')}
```

In `src/components/agents/agent-roster.test.tsx`, change the `render` helper (lines 71-73) from:

```tsx
  const render = (data: {
    agents: RosterAgentView[];
    workOverflow: boolean;
  }) =>
```

to:

```tsx
  const render = (data: { agents: RosterAgentView[] }) =>
```

Delete `workOverflow: false,` from the two surviving `render({ ... })` calls (the `names every agent and its duty` test and the `says so plainly when an agent has done nothing yet` test), and delete `workOverflow: false,` from the `shows a blocker instead of a work count` test.

Delete this test outright — it exists only to assert the `+` suffix:

```tsx
  it('marks a capped count as approximate rather than reporting it exactly', () => {
    const html = render({
      agents: [agent({ key: 'reply', workToday: 1024 })],
      workOverflow: true,
    });
    expect(html).toContain('1024+ today');
  });
```

Add this in its place, so the plain rendering stays covered:

```tsx
  it('reports the work count exactly, with no approximation marker', () => {
    const html = render({ agents: [agent({ key: 'reply', workToday: 1307 })] });
    expect(html).toContain('1307 today');
    expect(html).not.toContain('1307+');
  });
```

- [ ] **Step 7: Run the full affected suite and typecheck**

```bash
npx vitest run convex/agentRoster.test.ts convex/lib/agentRegistry.test.ts convex/aiUsage.test.ts convex/lib/aiUsageStats.test.ts src/components/agents/agent-roster.test.tsx
```

Expected: PASS, all files.

```bash
npm run typecheck
```

Expected: no output, exit 0. Nothing outside `agent-roster.tsx` should need touching: `api.agentRoster.roster` is consumed in exactly one place (`agent-roster.tsx:136`, via `useQuery`), and `RosterData` is declared and used only in that same file — verified before this plan was written. Keeping the query's return an object rather than a bare array is what holds that boundary.

- [ ] **Step 8: Run the whole test suite**

```bash
npm run test
```

Expected: PASS. This is the check that nothing else in the repo consumed `roster`'s old shape or `ROSTER_SCAN_WINDOW`.

- [ ] **Step 9: Lint and commit**

```bash
npx eslint convex/agentRoster.ts convex/agentRoster.test.ts convex/lib/agentRegistry.ts src/components/agents/agent-roster.tsx src/components/agents/agent-roster.test.tsx
```

```bash
git add convex/agentRoster.ts convex/agentRoster.test.ts convex/lib/agentRegistry.ts src/components/agents/agent-roster.tsx src/components/agents/agent-roster.test.tsx
git commit -m "perf(agents): count the roster's work exactly, from the hourly rollup

The 1024-row cap on today's aiUsageLog scan tripped every morning on this
account (~4,084 calls/day), so workToday froze on the earliest quarter of
the day and workOverflow was permanently true. Half the read budget went
to shared-sense rows that tally to nobody.

aiUsageHourlyStats already counts calls per mode per UTC hour, and
midnight UTC is an hour boundary, so today is an exact index range of at
most 24 documents. Drops workOverflow, its UI suffix, and
ROSTER_SCAN_WINDOW."
```

---

## Before this ships

The rollup only knows hours it has observed. Do not deploy this ahead of the backfill, or `workToday` reads near-zero for the pre-deploy part of the day — worse than the truncation it replaces. Order, per the spec:

1. `fix/usage-tab-hourly-rollup` (`94cf3f6`) merges to `main`.
2. It is deployed — schema plus the `aiUsage.log` writer.
3. `npx convex run aiUsage:backfillAiUsageHourlyStats` is run **once** and left to drain.
4. Only then does this branch ship.

Step 3 must not be started twice. The backfill is idempotent per chain (it rebuilds whole hours by SET) but is **not** concurrency-safe; overlapping chains inflated a prod rollup 1.8× on a previous backfill. All four steps are the owner's to run — this plan does not perform them.
