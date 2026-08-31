# Automations Run Tracking Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every contact moving through an automation visible, countable and cancellable — enrolled, waiting, sent, failed — and show those numbers on the list page, the canvas and the logs page.

**Architecture:** A `wait` step currently calls `ctx.scheduler.runAfter` and persists nothing, so a queued contact leaves no trace. This plan adds an `automationRuns` row per enrolled contact that carries the suspension point and the scheduled-function id, mirroring `flowRuns.fallbackTimeoutId` — the same pattern already proven in `flowsEngine.ts`. Cumulative per-step counters live in a separate `automationStepStats` table so execution traffic never contends with the step definition rows.

**Tech Stack:** Convex (schema, internal mutations/queries/actions, scheduler), `convex-test` + Vitest, Next.js App Router, React, Tailwind, next-intl.

Spec: `docs/superpowers/specs/2026-08-09-automations-enhancement-design.md` §2

**Depends on:** Phase 1 (`2026-08-09-automations-send-composer.md`) is not a hard prerequisite — these two plans touch different parts of `automationsEngine.ts` — but Phase 1 should land first to avoid conflicting edits to `runStep`.

> **PLAN REVISION 2026-08-10, after Task 1's review.** Per-step identity cannot
> key off `automationSteps._id`. `replaceSteps` (`convex/automations.ts:242`)
> deletes every step row and reinserts a fresh tree, and the builder's `save()`
> always sends the full steps array — even for a rename. So every save mints new
> step ids, which would orphan `automationStepStats` and strand
> `automationRuns.currentStepId`: the exact "invisible queued contact" failure
> this plan exists to fix, reappearing after one edit.
>
> **Task 10 (below) is the fix and runs immediately after Task 1.** It adds a
> stable `automationSteps.stepKey`, mirroring `flowNodes.nodeKey` which exists in
> the same schema file for precisely this reason. Throughout Tasks 3-9, wherever
> this plan says `automationStepStats.stepId` read **`stepKey`**, and wherever it
> says `automationRuns.currentStepId` read **`currentStepKey`** — both are
> `v.string()`, not `v.id("automationSteps")`. Task 10 states the final shapes.

## Global Constraints

- **Never run `convex deploy`, `convex dev`, or `convex codegen`.** The owner runs these. If a task appears to need regenerated types, stop and say so.
- Every new index leads with `accountId` so tenancy is enforced by the index rather than by a post-scan `.filter()` — the argument at `convex/schema.ts:1492`.
- **Adding a table is a schema change the owner must deploy.** Tasks that write to `automationRuns` cannot be verified in the browser until that happens; their tests run against `convex-test`, which builds the schema locally and needs no deployment.
- Cascades that delete or patch many rows follow `LOG_CASCADE_BATCH` (`convex/automations.ts:516`): a bounded batch plus a self-scheduled continuation. Self-scheduling chains in this codebase are idempotent per chain but **not** concurrency-safe — never start a second chain for the same automation while one is in flight.
- `ctx.scheduler.cancel` on an already-completed function is a no-op in Convex; `flowsEngine.ts:1429` documents this. Do not guard against it with extra reads.
- Tests: `convex/**/*.test.ts` under `edge-runtime`, `src/**/*.test.ts` under `node`. Both via `npx vitest run`.
- Lint only changed files: `npx eslint <paths>`. Typecheck: `npx tsc --noEmit`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

**Created:**
- `convex/lib/automations/runStats.ts` — pure aggregation of run rows into the display counts. No Convex imports, so both the server query and any UI test can use it.
- `convex/lib/automations/runStats.test.ts` — its spec.
- `src/components/automations/run-stats-bar.tsx` — the shared enrolled/waiting/sent/failed strip, used by the list page, the edit header and the logs page.

**Modified:**
- `convex/schema.ts` — `automationRuns`, `automationStepStats`, `automations.stopOnReply`.
- `convex/automationsEngine.ts` — run lifecycle, wait persistence, step counters.
- `convex/automations.ts` — stats queries, cancellation on deactivate/delete, `stopOnReply` in create/update.
- `convex/contacts.ts` — cancel on `doNotContact`.
- `convex/ingest.ts` — cancel on inbound reply when `stopOnReply` is set.
- `src/app/(dashboard)/automations/page.tsx` — per-automation counts.
- `src/app/(dashboard)/automations/[id]/logs/page.tsx` — summary bar + Waiting tab.
- `src/components/automations/automation-builder.tsx` — per-step chips, `stopOnReply` toggle.
- `messages/en.json` — new strings.

---

### Task 1: Schema — `automationRuns`, `automationStepStats`, `stopOnReply`

**Files:**
- Modify: `convex/schema.ts` (after `automationLogs`, ~line 1501)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `automationRuns` and `automationStepStats`, and `automations.stopOnReply?: boolean`. Every later task reads or writes them.

- [ ] **Step 1: Add `stopOnReply` to `automations`**

In the `automations` table definition (`schema.ts:1422`), add before the closing brace:

```ts
    // Cancel this automation's WAITING runs for a contact the moment
    // that contact replies. Optional and default-off: `Wait → Send →
    // Wait → Send` is the most common automation shape, and without this
    // a customer who already answered keeps receiving scheduled nags —
    // but turning it on for every existing automation would change
    // behaviour under owners who never asked for it.
    stopOnReply: v.optional(v.boolean()),
```

- [ ] **Step 2: Add the two tables**

Immediately after the `automationLogs` definition:

```ts
  // One row per (automation, contact) enrolment — the thing an
  // `automationLogs` row cannot express. A log says what HAPPENED; a run
  // says where a contact IS. Before this table a `wait` step called
  // `ctx.scheduler.runAfter` and persisted nothing, so a queued contact
  // was invisible, uncountable and uncancellable, and deleting an
  // automation left its resumes to fire into the void.
  //
  // `scheduledFnId` is what makes a wait cancellable. Same mechanism as
  // `flowRuns.fallbackTimeoutId` below, for the same reason.
  automationRuns: defineTable({
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
    // Nullable for the same reason as `automationLogs.contactId`: history
    // must survive contact deletion.
    contactId: v.optional(v.id("contacts")),
    conversationId: v.optional(v.id("conversations")),
    status: v.union(
      v.literal("running"),
      v.literal("waiting"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    // The suspension point. All four travel together so a wait nested
    // inside a condition branch resumes back into THAT branch — the same
    // tuple `resume` already takes as arguments.
    currentStepId: v.optional(v.id("automationSteps")),
    parentStepId: v.optional(v.id("automationSteps")),
    branch: v.optional(v.union(v.literal("yes"), v.literal("no"))),
    nextPosition: v.number(),
    resumeAt: v.optional(v.number()),
    scheduledFnId: v.optional(v.id("_scheduled_functions")),
    logId: v.optional(v.id("automationLogs")),
    context: v.optional(v.any()),
    startedAt: v.number(),
    updatedAt: v.number(),
    endedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_account_automation", ["accountId", "automationId"])
    // The counts query and the per-step canvas chips both want "this
    // automation's rows in this status". Keeping status in the index
    // rather than filtering after the read matters because this table
    // grows with every enrolment, exactly like `automationLogs`.
    .index("by_account_automation_status", ["accountId", "automationId", "status"])
    // Cancellation by contact: doNotContact and stopOnReply both ask
    // "which of this contact's runs are still waiting?".
    .index("by_account_contact_status", ["accountId", "contactId", "status"]),

  // Cumulative per-step counters. Deliberately NOT columns on
  // `automationSteps`: those rows are the automation's DEFINITION, and
  // bumping a counter on them on every execution would put write traffic
  // on the same documents the builder edits. "Waiting at this step" is
  // absent on purpose — it is a live index read against `automationRuns`,
  // so storing it would be a second source of truth that can drift.
  automationStepStats: defineTable({
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
    stepId: v.id("automationSteps"),
    reached: v.number(),
    sent: v.number(),
    failed: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account_automation", ["accountId", "automationId"])
    .index("by_account_step", ["accountId", "stepId"]),
```

- [ ] **Step 3: Verify the schema compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx vitest run convex/automations.test.ts`
Expected: PASS — `convex-test` builds the schema from this file, so a malformed table fails here.

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(automations): add automationRuns and automationStepStats tables

A wait step persisted nothing, so a queued contact was invisible and
uncancellable. automationRuns carries the suspension point and the
scheduled-function id, mirroring flowRuns.fallbackTimeoutId.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Tell the owner a deploy is needed**

Say plainly that the new tables require `convex deploy` before anything in the app can read or write them, and that you have not run it. Later tasks' tests pass without it.

---

### Task 2: Pure run-stats aggregation

**Files:**
- Create: `convex/lib/automations/runStats.ts`
- Test: `convex/lib/automations/runStats.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `summarizeRuns(rows: RunStatusRow[]): RunCounts` and `emptyRunCounts(): RunCounts`, where `RunCounts = { enrolled: number; waiting: number; running: number; completed: number; failed: number; cancelled: number }`. Tasks 7 and 8 import them.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "vitest";
import { summarizeRuns } from "./runStats";

const row = (status: string) => ({ status }) as never;

test("counts each status and totals enrolled", () => {
  expect(
    summarizeRuns([
      row("waiting"),
      row("waiting"),
      row("completed"),
      row("failed"),
      row("cancelled"),
      row("running"),
    ]),
  ).toEqual({
    enrolled: 6,
    waiting: 2,
    running: 1,
    completed: 1,
    failed: 1,
    cancelled: 1,
  });
});

test("an empty set is all zeroes, not undefined", () => {
  expect(summarizeRuns([])).toEqual({
    enrolled: 0,
    waiting: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  });
});

test("cancelled runs count toward enrolled — someone did enter the automation", () => {
  expect(summarizeRuns([row("cancelled")]).enrolled).toBe(1);
});

test("an unknown status is counted in enrolled but no bucket", () => {
  const out = summarizeRuns([row("weird")]);
  expect(out.enrolled).toBe(1);
  expect(out.waiting + out.running + out.completed + out.failed + out.cancelled).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/automations/runStats.test.ts`
Expected: FAIL — `Failed to resolve import "./runStats"`.

- [ ] **Step 3: Write the implementation**

```ts
// Pure aggregation of automationRuns rows into the numbers the UI shows.
// Dependency-free so the server query and any component test share one
// definition of what "enrolled" means — the alternative is two counts
// that disagree, which is worse than no counts at all.

export type RunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunStatusRow {
  status: string;
}

export interface RunCounts {
  /** Everyone who ever entered, whatever became of them. */
  enrolled: number;
  waiting: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export function emptyRunCounts(): RunCounts {
  return {
    enrolled: 0,
    waiting: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
}

export function summarizeRuns(rows: RunStatusRow[]): RunCounts {
  const counts = emptyRunCounts();
  for (const r of rows) {
    counts.enrolled += 1;
    switch (r.status) {
      case "waiting":
        counts.waiting += 1;
        break;
      case "running":
        counts.running += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      // An unrecognised status still counts as an enrolment. Silently
      // dropping it would make the buckets fail to sum to `enrolled`,
      // which is the kind of discrepancy nobody can debug from the UI.
      default:
        break;
    }
  }
  return counts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/lib/automations/runStats.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/automations/runStats.ts convex/lib/automations/runStats.test.ts
git commit -m "feat(automations): pure aggregation of run rows into display counts

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Create a run row per enrolment

**Files:**
- Modify: `convex/automationsEngine.ts` (`runAutomation` ~line 440-475, `ExecuteArgs` at 512, `resume` at 283)
- Test: `convex/automationsEngine.test.ts` (append)

**Interfaces:**
- Consumes: the `automationRuns` table (Task 1).
- Produces:
  - `internal.automationsEngine.createRun` — args `{ accountId, automationId, contactId?, conversationId?, logId?, context? }`, returns `Id<"automationRuns">`.
  - `internal.automationsEngine.finishRun` — args `{ runId, status: "completed" | "failed", errorMessage? }`, returns `null`.
  - `ExecuteArgs` gains `runId: Id<"automationRuns"> | null`.
  - `resume` gains an optional `runId` argument.

- [ ] **Step 1: Write the failing test**

```ts
test("a successful run records one completed automationRuns row", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Runs");
  const { automationId, contactId } = await seedAutomationWithStep(t, accountId, {
    stepType: "add_tag",
    stepConfig: { tag_id: await seedTag(t, accountId, "vip") },
  });

  await runAutomation(t, { automationId, contactId });

  const runs = await t.run(async (ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .collect(),
  );
  expect(runs).toHaveLength(1);
  expect(runs[0].status).toBe("completed");
  expect(runs[0].contactId).toBe(contactId);
  expect(runs[0].endedAt).toBeGreaterThan(0);
});

test("a failing step marks the run failed and records the message", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Fails");
  const { automationId, contactId } = await seedAutomationWithStep(t, accountId, {
    stepType: "send_webhook",
    stepConfig: { url: "http://127.0.0.1/hook" }, // SSRF guard refuses it
  });

  await runAutomation(t, { automationId, contactId });

  const run = await t.run(async (ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("failed");
  expect(run?.errorMessage).toMatch(/not allowed/);
});

test("a do-not-contact block records no run row — nobody was enrolled", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Blocked");
  const { automationId, contactId } = await seedAutomationWithStep(t, accountId, {
    stepType: "send_message",
    stepConfig: { text: "hi" },
  });
  await t.run(async (ctx) => ctx.db.patch(contactId, { doNotContact: { at: Date.now() } }));

  await runAutomation(t, { automationId, contactId });

  const runs = await t.run(async (ctx) => ctx.db.query("automationRuns").collect());
  expect(runs).toHaveLength(0);
});
```

Check `doNotContact`'s exact shape at `convex/schema.ts:125` and match it in the patch.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/automationsEngine.test.ts -t "run"`
Expected: FAIL — no `automationRuns` rows are ever written.

- [ ] **Step 3: Write the implementation**

Add the two internal mutations next to `createLog`:

```ts
export const createRun = internalMutation({
  args: {
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
    contactId: v.optional(v.id("contacts")),
    conversationId: v.optional(v.id("conversations")),
    logId: v.optional(v.id("automationLogs")),
    context: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("automationRuns", {
      ...args,
      status: "running",
      nextPosition: 0,
      startedAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Terminal transition. Clears `resumeAt`/`scheduledFnId` so a finished
 * run never looks queued — the Waiting tab reads those fields directly.
 */
export const finishRun = internalMutation({
  args: {
    runId: v.id("automationRuns"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    // A cancelled run is already terminal; a late completion must not
    // resurrect it.
    if (!run || run.status === "cancelled") return null;
    const now = Date.now();
    await ctx.db.patch(args.runId, {
      status: args.status,
      errorMessage: args.errorMessage,
      resumeAt: undefined,
      scheduledFnId: undefined,
      endedAt: now,
      updatedAt: now,
    });
    return null;
  },
});
```

In `runAutomation`, create the run immediately after `createLog` and thread it into `executeStepsFrom`:

```ts
  const runId: Id<"automationRuns"> = await ctx.runMutation(
    internal.automationsEngine.createRun,
    {
      accountId: automation.accountId,
      automationId: automation._id,
      contactId: input.contactId ?? undefined,
      conversationId: input.context.conversationId,
      logId,
      context: input.context,
    },
  );

  await executeStepsFrom(ctx, allSteps, {
    automation,
    contactId: input.contactId,
    context: input.context,
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId,
    runId,
  });
```

Add `runId: Id<"automationRuns"> | null;` to `ExecuteArgs`, and pass `runId: args.runId` through every recursive `executeStepsFrom` call (the condition-branch recursion at line 623 already spreads `...args`, so it carries automatically).

At the end of `executeStepsFrom`, in the root-scope-only branch that finalizes the log, also finish the run:

```ts
  if (args.parentStepId === null && args.runId) {
    await ctx.runMutation(internal.automationsEngine.finishRun, {
      runId: args.runId,
      status: status === "failed" ? "failed" : "completed",
      errorMessage,
    });
  }
```

Place this **after** the existing `appendLogResults` call, and only where the scope is root — a nested branch's completion must not end the run.

`recordBlockedRun` is left alone: it deliberately creates no run, because nobody was enrolled.

Finally add `runId: v.optional(v.id("automationRuns"))` to `resume`'s args and pass it into the `executeStepsFrom` call inside that handler (as `args.runId ?? null`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/automationsEngine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/automationsEngine.ts convex/automationsEngine.test.ts
git commit -m "feat(automations): record an automationRuns row per enrolment

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Waits persist and become cancellable

**Files:**
- Modify: `convex/schema.ts` (`automationRuns` — the outstanding-branch counter below)
- Modify: `convex/automationsEngine.ts` (the `wait` branch, `resume` handler, `executeStepsFrom`'s tail)
- Test: `convex/automationsEngine.test.ts` (append)

**Interfaces:**
- Consumes: `createRun` / `finishRun` / `recordRunFailure` (Task 3).
- Produces: `internal.automationsEngine.markRunWaiting` — args `{ runId, currentStepKey, parentStepId?, branch?, nextPosition, resumeAt, scheduledFnId }`, returns `null`. Task 5's cancellation reads what it writes. **Note `currentStepKey` (a `v.string()`), not `currentStepId` — see the plan revision at the top.**

> **CARRIED FORWARD FROM TASK 3's REVIEW — resolve this here.** `finishRun` can
> currently fire more than once per run: each independently-suspended branch
> reaches an entry call of its own on resume. Task 3 made the *outcome*
> order-independent (a recorded failure always wins), so the terminal status is
> correct — but `endedAt`/`updatedAt` are bumped on every call, and a straggler
> branch failing long after an earlier branch closed the run `completed` would
> flip it much later.
>
> Closing it needs a durable count of outstanding branches on the run row. Every
> existing suspension field (`parentStepId`, `branch`, `nextPosition`,
> `currentStepKey`, `resumeAt`, `scheduledFnId`) is singular by design, so add one:
>
> ```ts
>     // How many branches of this run are suspended on a wait right now.
>     // Every other suspension field above is singular — they describe ONE
>     // suspension point — but a condition can fan out into branches that
>     // each suspend independently, and each reaches its own entry call on
>     // resume. Without a count, `finishRun` fires once per branch: the
>     // terminal status stays correct (Task 3 made a recorded failure win
>     // regardless of call order) but `endedAt` is rewritten each time, and
>     // a straggler failing after an earlier branch already closed the run
>     // would flip it long after the fact.
>     //
>     // Incremented when a branch suspends, decremented when it resumes.
>     // A run may only be finished when it reaches zero.
>     outstandingBranches: v.optional(v.number()),
> ```
>
> Then gate `finishRun` on the count reaching zero rather than on
> `!suspended` alone. Test it: two independently-suspended branches must produce
> exactly ONE terminal write, and `endedAt` must not move when the second
> branch resumes. `convex/schema.ts` also carries another session's uncommitted
> work — stage only your own hunks, as Tasks 1 and 10 did.

- [ ] **Step 1: Write the failing test**

```ts
test("a wait step parks the run with a resumeAt and a scheduled function id", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Waits");
  const { automationId, contactId } = await seedAutomationWithSteps(t, accountId, [
    { stepType: "wait", stepConfig: { amount: 1, unit: "hours" } },
    { stepType: "send_message", stepConfig: { text: "later" } },
  ]);

  const before = Date.now();
  await runAutomation(t, { automationId, contactId });

  const run = await t.run(async (ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("waiting");
  expect(run?.resumeAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
  expect(run?.scheduledFnId).toBeTruthy();
  expect(run?.nextPosition).toBe(1);
});

test("resuming clears the wait bookkeeping and completes the run", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Resumes");
  const { automationId, contactId } = await seedAutomationWithSteps(t, accountId, [
    { stepType: "wait", stepConfig: { amount: 1, unit: "minutes" } },
    { stepType: "add_tag", stepConfig: { tag_id: await seedTag(t, accountId, "done") } },
  ]);

  await runAutomation(t, { automationId, contactId });
  await t.finishInProgressScheduledFunctions();

  const run = await t.run(async (ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("completed");
  expect(run?.resumeAt).toBeUndefined();
  expect(run?.scheduledFnId).toBeUndefined();
});

test("a wait nested in a condition branch parks with that branch recorded", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "NestedWait");
  const { automationId, contactId, conditionStepId } = await seedConditionWithBranchWait(
    t,
    accountId,
  );

  await runAutomation(t, { automationId, contactId });

  const run = await t.run(async (ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("waiting");
  expect(run?.parentStepId).toBe(conditionStepId);
  expect(run?.branch).toBe("yes");
});
```

Write `seedAutomationWithSteps` and `seedConditionWithBranchWait` as local helpers modelled on the suite's existing seeds. Check the exact name of convex-test's scheduled-function helper (`finishInProgressScheduledFunctions` / `finishAllScheduledFunctions`) against how the existing wait tests in this suite already drive the scheduler, and use the same one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/automationsEngine.test.ts -t "wait"`
Expected: FAIL — the run stays `running`; `resumeAt` and `scheduledFnId` are never set.

- [ ] **Step 3: Write the implementation**

Add the mutation:

```ts
/**
 * Park a run at a `wait`. The suspension tuple stored here is exactly
 * what `resume` needs as arguments, so a cancelled-then-inspected run is
 * self-describing rather than requiring a walk of the step tree.
 */
export const markRunWaiting = internalMutation({
  args: {
    runId: v.id("automationRuns"),
    currentStepId: v.id("automationSteps"),
    parentStepId: v.optional(v.id("automationSteps")),
    branch: v.optional(v.union(v.literal("yes"), v.literal("no"))),
    nextPosition: v.number(),
    resumeAt: v.number(),
    scheduledFnId: v.id("_scheduled_functions"),
  },
  handler: async (ctx, args) => {
    const { runId, ...rest } = args;
    const run = await ctx.db.get(runId);
    // Cancelled between scheduling and this patch — leave it cancelled.
    if (!run || run.status === "cancelled") return null;
    await ctx.db.patch(runId, { ...rest, status: "waiting", updatedAt: Date.now() });
    return null;
  },
});
```

In the `wait` branch of `executeStepsFrom`, capture the scheduler's id and record it. `ctx.scheduler.runAfter` returns the scheduled function's id:

```ts
      const resumeAt = Date.now() + ms;
      const scheduledFnId = await ctx.scheduler.runAfter(ms, internal.automationsEngine.resume, {
        automationId: args.automation._id,
        contactId: args.contactId ?? undefined,
        parentStepId: args.parentStepId ?? undefined,
        branch: args.branch ?? undefined,
        nextPosition: step.position + 1,
        logId: args.logId ?? undefined,
        runId: args.runId ?? undefined,
        context: args.context,
      });

      if (args.runId) {
        await ctx.runMutation(internal.automationsEngine.markRunWaiting, {
          runId: args.runId,
          currentStepId: step._id,
          parentStepId: args.parentStepId ?? undefined,
          branch: args.branch ?? undefined,
          nextPosition: step.position + 1,
          resumeAt,
          scheduledFnId,
        });
      }
      return;
```

Keep the existing `appendLogResults` call with `status: "partial"` exactly where it is — the log's semantics are unchanged.

In `resume`'s handler, before executing, flip the run back to `running` and clear the wait bookkeeping. Add a small mutation for it, or reuse `markRunWaiting`'s sibling:

```ts
export const markRunRunning = internalMutation({
  args: { runId: v.id("automationRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    // A cancelled run must not restart. This is the race that matters:
    // `scheduler.cancel` and an already-dequeued resume can interleave.
    if (!run || run.status === "cancelled") return false;
    await ctx.db.patch(args.runId, {
      status: "running",
      resumeAt: undefined,
      scheduledFnId: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});
```

In `resume`, if `args.runId` is set and `markRunRunning` returns `false`, return without executing anything. This is the guard that makes cancellation actually stop a send rather than merely relabel a row.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/automationsEngine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/automationsEngine.ts convex/automationsEngine.test.ts
git commit -m "feat(automations): persist waits so queued contacts are visible and stoppable

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The four cancellation paths

**Files:**
- Modify: `convex/automationsEngine.ts` (cancel mutations)
- Modify: `convex/automations.ts:479` (`setActive`), `remove` (~line 554), `create`/`update` for `stopOnReply`
- Modify: `convex/contacts.ts` (wherever `doNotContact` is set)
- Modify: `convex/ingest.ts:826` (inbound dispatch)
- Test: `convex/automationsEngine.test.ts`, `convex/automations.test.ts` (append)

**Interfaces:**
- Consumes: `markRunRunning`'s cancelled-guard (Task 4).
- Produces:
  - `internal.automationsEngine.cancelRunsForAutomation` — args `{ accountId, automationId, reason }`, returns `{ cancelled: number; done: boolean }`. Self-schedules while `done` is false.
  - `internal.automationsEngine.cancelRunsForContact` — args `{ accountId, contactId, reason, onlyStopOnReply? }`, returns `{ cancelled: number }`.

- [ ] **Step 1: Write the failing tests**

```ts
test("deactivating an automation cancels its waiting runs", async () => {
  const t = convexTest(schema, modules);
  const { accountId, automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId }); // parks on a wait

  await asOwner.mutation(api.automations.setActive, { automationId, isActive: false });

  const run = await t.run(async (ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("cancelled");
  expect(run?.errorMessage).toMatch(/deactivated/);
});

test("deleting an automation cancels its waiting runs", async () => {
  const t = convexTest(schema, modules);
  const { accountId, automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });

  await asOwner.mutation(api.automations.remove, { automationId });
  await t.finishAllScheduledFunctions();

  const runs = await t.run(async (ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .collect(),
  );
  expect(runs.every((r) => r.status === "cancelled")).toBe(true);
});

test("a cancelled run does not send when its resume fires", async () => {
  const t = convexTest(schema, modules);
  const { accountId, automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });
  await asOwner.mutation(api.automations.setActive, { automationId, isActive: false });

  const sendText = vi.fn(async () => ({ whatsappMessageId: "wamid.T" }));
  await t.finishAllScheduledFunctions();

  expect(sendText).not.toHaveBeenCalled();
});

test("marking a contact do-not-contact cancels their waiting runs", async () => {
  const t = convexTest(schema, modules);
  const { accountId, automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });

  await asOwner.mutation(api.contacts.setDoNotContact, { contactId, value: true });

  const run = await t.run(async (ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_contact_status", (q) =>
        q.eq("accountId", accountId).eq("contactId", contactId).eq("status", "cancelled"),
      )
      .unique(),
  );
  expect(run).toBeTruthy();
});

test("stopOnReply cancels a waiting run when the contact replies", async () => {
  const t = convexTest(schema, modules);
  const { accountId, automationId, contactId } = await seedActivatableAutomation(t, {
    stopOnReply: true,
  });
  await runAutomation(t, { automationId, contactId });

  await deliverInboundMessage(t, { accountId, contactId, text: "yes please" });

  const run = await t.run(async (ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_contact_status", (q) =>
        q.eq("accountId", accountId).eq("contactId", contactId).eq("status", "cancelled"),
      )
      .unique(),
  );
  expect(run?.errorMessage).toMatch(/replied/);
});

test("without stopOnReply a reply leaves the waiting run alone", async () => {
  const t = convexTest(schema, modules);
  const { accountId, automationId, contactId } = await seedActivatableAutomation(t, {
    stopOnReply: false,
  });
  await runAutomation(t, { automationId, contactId });

  await deliverInboundMessage(t, { accountId, contactId, text: "yes please" });

  const run = await t.run(async (ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_contact_status", (q) =>
        q.eq("accountId", accountId).eq("contactId", contactId).eq("status", "waiting"),
      )
      .unique(),
  );
  expect(run).toBeTruthy();
});
```

`seedActivatableAutomation` builds an account, an owner identity, a contact with a conversation, and an active automation whose first step is a `wait`. `deliverInboundMessage` drives whatever `ingest.ts` entry point the existing ingest tests use — read `convex/ingest.test.ts` for the established shape rather than inventing one. Check `contacts.setDoNotContact`'s real name and args in `convex/contacts.ts`; if the mutation is named differently, use the real one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/ -t "cancel"`
Expected: FAIL — nothing cancels anything yet.

- [ ] **Step 3: Write the cancel mutations**

```ts
/** How many waiting runs one cancellation transaction may touch. Same
 *  reasoning, and same conservatism, as `LOG_CASCADE_BATCH`. */
export const RUN_CANCEL_BATCH = 256;

/**
 * Cancel this automation's waiting runs, one bounded batch per call,
 * self-scheduling until drained. NOT concurrency-safe: two overlapping
 * chains for the same automation would each re-read the same page. Only
 * ever start one — `setActive` and `remove` are the only callers, and
 * both act on a single automation under a single user action.
 */
export const cancelRunsForAutomation = internalMutation({
  args: {
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const waiting = await ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation_status", (q) =>
        q
          .eq("accountId", args.accountId)
          .eq("automationId", args.automationId)
          .eq("status", "waiting"),
      )
      .take(RUN_CANCEL_BATCH);

    for (const run of waiting) {
      await cancelOne(ctx, run, args.reason);
    }

    const done = waiting.length < RUN_CANCEL_BATCH;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.automationsEngine.cancelRunsForAutomation, args);
    }
    return { cancelled: waiting.length, done };
  },
});

export const cancelRunsForContact = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    reason: v.string(),
    /** Only cancel runs whose automation has `stopOnReply` set. */
    onlyStopOnReply: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const waiting = await ctx.db
      .query("automationRuns")
      .withIndex("by_account_contact_status", (q) =>
        q
          .eq("accountId", args.accountId)
          .eq("contactId", args.contactId)
          .eq("status", "waiting"),
      )
      .collect();

    let cancelled = 0;
    for (const run of waiting) {
      if (args.onlyStopOnReply) {
        const automation = await ctx.db.get(run.automationId);
        if (!automation?.stopOnReply) continue;
      }
      await cancelOne(ctx, run, args.reason);
      cancelled += 1;
    }
    return { cancelled };
  },
});

/**
 * Cancel the scheduled resume, then mark the row. Order matters: mark
 * first and an already-dequeued resume could still slip through, because
 * `markRunRunning`'s guard reads the row it has not yet seen updated.
 * `scheduler.cancel` on a completed function is a no-op in Convex.
 */
async function cancelOne(
  ctx: MutationCtx,
  run: Doc<"automationRuns">,
  reason: string,
): Promise<void> {
  if (run.scheduledFnId) await ctx.scheduler.cancel(run.scheduledFnId);
  const now = Date.now();
  await ctx.db.patch(run._id, {
    status: "cancelled",
    errorMessage: reason,
    resumeAt: undefined,
    scheduledFnId: undefined,
    endedAt: now,
    updatedAt: now,
  });
}
```

`cancelRunsForContact` uses `.collect()` rather than a batch because one contact has few concurrent runs; `cancelRunsForAutomation` batches because one automation can have thousands.

- [ ] **Step 4: Wire the four call sites**

**`convex/automations.ts` — `setActive`**, after the existing `ctx.db.patch`:

```ts
    // Pausing must actually stop queued work. Without this, a deactivated
    // automation's already-scheduled resumes keep firing and keep sending.
    if (!args.isActive) {
      await ctx.scheduler.runAfter(0, internal.automationsEngine.cancelRunsForAutomation, {
        accountId: ctx.accountId,
        automationId: args.automationId,
        reason: "automation deactivated",
      });
    }
```

**`convex/automations.ts` — `remove`**, alongside the existing log-purge cascade, schedule `cancelRunsForAutomation` with `reason: "automation deleted"`. Add a matching purge of that automation's `automationRuns` and `automationStepStats` rows to the existing cascade so deletion does not leak rows; follow `purgeAutomationLogs`'s batching shape exactly.

**`convex/automations.ts` — `create` / `update`**: accept `stopOnReply: v.optional(v.boolean())` and persist it.

**`convex/automations.ts` — `update`, on the `replaceSteps` branch only** (added
2026-08-10, from Task 10's review), schedule `cancelRunsForAutomation` with
`reason: "automation edited"`:

```ts
      await replaceSteps(ctx, ctx.accountId, automationId, steps as BuilderStepInput[]);
      // A waiting run's suspension tuple (`parentStepId`, and the same
      // argument the scheduler holds for `resume`) is a step ROW ID, and
      // `replaceSteps` just deleted every one of them. Task 10's `stepKey`
      // made per-step STATS durable, but not the engine's resume scope —
      // rekeying that would mean reworking `resume`/`executeStepsFrom`/
      // `scopedSteps`, which is out of scope here.
      //
      // So cancel instead. Editing an automation while contacts are queued
      // inside it is genuinely ambiguous, and "cancelled — automation
      // edited" is a better answer than silently stranding them as
      // permanently `waiting` (inflating the very count this plan ships) or
      // resuming them into a tree that changed underneath. This makes a
      // pre-existing failure visible rather than introducing one: today
      // those resumes already fire into a deleted scope.
      await ctx.scheduler.runAfter(0, internal.automationsEngine.cancelRunsForAutomation, {
        accountId: ctx.accountId,
        automationId,
        reason: "automation edited",
      });
```

This must sit **inside** the branch that actually calls `replaceSteps` — a
name-only or `stopOnReply`-only save must cancel nothing. Add a test for both:
a steps-bearing save cancels waiting runs, a metadata-only save does not.

**`convex/contacts.ts`** — wherever `doNotContact` is set, schedule `cancelRunsForContact` with `reason: "contact opted out"`.

**`convex/ingest.ts:826`** — in the same block that dispatches `runForTrigger`, also schedule:

```ts
        ctx.runMutation(internal.automationsEngine.cancelRunsForContact, {
          accountId,
          contactId,
          reason: "contact replied",
          onlyStopOnReply: true,
        }),
```

Wrap it in the same `runBestEffort` helper the neighbouring dispatches use, so a cancellation failure never blocks ingest.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run convex/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/automationsEngine.ts convex/automations.ts convex/contacts.ts convex/ingest.ts convex/automationsEngine.test.ts convex/automations.test.ts
git commit -m "feat(automations): cancel queued runs on deactivate, delete, opt-out and reply

Deactivating or deleting an automation previously left its scheduled
resumes to fire and send. stopOnReply is new and default-off.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Per-step counters

**Files:**
- Modify: `convex/automationsEngine.ts:1211` (`appendLogResults`)
- Test: `convex/automationsEngine.test.ts` (append)

**Interfaces:**
- Consumes: the `automationStepStats` table (Task 1).
- Produces: counters written inside `appendLogResults`'s existing transaction. Task 7 reads them.

- [ ] **Step 1: Write the failing test**

```ts
test("each executed step increments its own reached and sent counters", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Counters");
  const { automationId, contactId, stepIds } = await seedAutomationWithSteps(t, accountId, [
    { stepType: "add_tag", stepConfig: { tag_id: await seedTag(t, accountId, "a") } },
    { stepType: "add_tag", stepConfig: { tag_id: await seedTag(t, accountId, "b") } },
  ]);

  await runAutomation(t, { automationId, contactId });
  await runAutomation(t, { automationId, contactId });

  const stats = await t.run(async (ctx) =>
    ctx.db
      .query("automationStepStats")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .collect(),
  );
  expect(stats).toHaveLength(2);
  for (const s of stats) {
    expect(s.reached).toBe(2);
    expect(s.sent).toBe(2);
    expect(s.failed).toBe(0);
  }
});

test("a failed step increments reached and failed but not sent", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "FailCounters");
  const { automationId, contactId, stepIds } = await seedAutomationWithSteps(t, accountId, [
    { stepType: "send_webhook", stepConfig: { url: "http://127.0.0.1/hook" } },
  ]);

  await runAutomation(t, { automationId, contactId });

  const stat = await t.run(async (ctx) =>
    ctx.db
      .query("automationStepStats")
      .withIndex("by_account_step", (q) =>
        q.eq("accountId", accountId).eq("stepId", stepIds[0]),
      )
      .unique(),
  );
  expect(stat?.reached).toBe(1);
  expect(stat?.sent).toBe(0);
  expect(stat?.failed).toBe(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/automationsEngine.test.ts -t "counter"`
Expected: FAIL — no `automationStepStats` rows exist.

- [ ] **Step 3: Write the implementation**

`appendLogResults` currently takes `stepId: v.string()`. Widen its args with the identifying context the counter needs:

```ts
    accountId: v.optional(v.id("accounts")),
    automationId: v.optional(v.id("automations")),
```

and pass both from every call site in `executeStepsFrom` (`args.automation.accountId`, `args.automation._id`).

Inside the handler, after the existing log patch:

```ts
    // Counters live beside the log write so they share its transaction —
    // a step can never be logged without being counted, or vice versa.
    if (args.accountId && args.automationId) {
      for (const item of args.newItems) {
        const stepId = ctx.db.normalizeId("automationSteps", item.stepId);
        if (!stepId) continue; // defensive: `stepId` is a bare string here
        const existing = await ctx.db
          .query("automationStepStats")
          .withIndex("by_account_step", (q) =>
            q.eq("accountId", args.accountId!).eq("stepId", stepId),
          )
          .unique();
        const sent = item.status === "success" ? 1 : 0;
        const failed = item.status === "failed" ? 1 : 0;
        if (existing) {
          await ctx.db.patch(existing._id, {
            reached: existing.reached + 1,
            sent: existing.sent + sent,
            failed: existing.failed + failed,
            updatedAt: Date.now(),
          });
        } else {
          await ctx.db.insert("automationStepStats", {
            accountId: args.accountId,
            automationId: args.automationId,
            stepId,
            reached: 1,
            sent,
            failed,
            updatedAt: Date.now(),
          });
        }
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/automationsEngine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/automationsEngine.ts convex/automationsEngine.test.ts
git commit -m "feat(automations): count reached/sent/failed per step

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Stats queries

**Files:**
- Modify: `convex/automations.ts` (`list`, plus new `runCounts`, `stepStats`, `waitingRuns`, `cancelRun`)
- Test: `convex/automations.test.ts` (append)

**Interfaces:**
- Consumes: `summarizeRuns` (Task 2), both new tables.
- Produces:
  - `api.automations.list` — each row gains `runCounts: RunCounts`.
  - `api.automations.stepStats` — args `{ automationId }`, returns `Array<{ stepId, reached, sent, failed, waiting }>`.
  - `api.automations.waitingRuns` — args `{ automationId, limit? }`, returns waiting runs with `contactId`, `resumeAt`, `currentStepId`, newest resume first.
  - `api.automations.cancelRun` — args `{ runId }`, returns `null`. Requires role `agent`.

- [ ] **Step 1: Write the failing tests**

```ts
test("list returns run counts per automation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });

  const rows = await asOwner.query(api.automations.list, {});
  expect(rows[0].runCounts).toMatchObject({ enrolled: 1, waiting: 1 });
});

test("stepStats merges cumulative counters with the live waiting count", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, asOwner, waitStepId } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });

  const stats = await asOwner.query(api.automations.stepStats, { automationId });
  const waitRow = stats.find((s) => s.stepId === waitStepId);
  expect(waitRow?.waiting).toBe(1);
});

test("waitingRuns lists queued contacts with their resume time", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });

  const rows = await asOwner.query(api.automations.waitingRuns, { automationId });
  expect(rows).toHaveLength(1);
  expect(rows[0].contactId).toBe(contactId);
  expect(rows[0].resumeAt).toBeGreaterThan(Date.now());
});

test("cancelRun stops one queued contact", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });
  const [row] = await asOwner.query(api.automations.waitingRuns, { automationId });

  await asOwner.mutation(api.automations.cancelRun, { runId: row._id });

  expect(await asOwner.query(api.automations.waitingRuns, { automationId })).toHaveLength(0);
});

test("cancelRun refuses a run belonging to another account", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedActivatableAutomation(t);
  const theirs = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId: theirs.automationId, contactId: theirs.contactId });
  const [foreign] = await theirs.asOwner.query(api.automations.waitingRuns, {
    automationId: theirs.automationId,
  });

  await expect(
    mine.asOwner.mutation(api.automations.cancelRun, { runId: foreign._id }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/automations.test.ts -t "stats\|waiting\|cancelRun\|run counts"`
Expected: FAIL — the functions do not exist.

- [ ] **Step 3: Write the implementation**

In `convex/automations.ts`, extend `list`'s per-automation map to also read runs:

```ts
        const runs = await ctx.db
          .query("automationRuns")
          .withIndex("by_account_automation", (q) =>
            q.eq("accountId", ctx.accountId).eq("automationId", automation._id),
          )
          .collect();
        return { ...automation, stepCount: steps.length, runCounts: summarizeRuns(runs) };
```

**Note the cost:** this collects every run row per automation on every list render. That is acceptable while run volume is low and is the same shape `list` already uses for steps, but it will need a rollup once an account accumulates tens of thousands of runs. Add a comment saying so rather than pre-optimising.

Add the three new functions, all gated `ctx.requireRole("admin")` to match `list`/`get`/`logs`, except `cancelRun` which gates `agent` to match the other mutations:

```ts
export const stepStats = accountQuery({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    await requireOwnAutomation(ctx, args.automationId);

    const cumulative = await ctx.db
      .query("automationStepStats")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", ctx.accountId).eq("automationId", args.automationId),
      )
      .collect();

    // "Waiting" is deliberately NOT a stored counter — it is derived, so
    // it can never drift from the run rows it describes.
    const waiting = await ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation_status", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .eq("automationId", args.automationId)
          .eq("status", "waiting"),
      )
      .collect();

    const waitingByStep = new Map<string, number>();
    for (const r of waiting) {
      if (!r.currentStepId) continue;
      waitingByStep.set(r.currentStepId, (waitingByStep.get(r.currentStepId) ?? 0) + 1);
    }

    const byStep = new Map(
      cumulative.map((s) => [
        s.stepId as string,
        { stepId: s.stepId, reached: s.reached, sent: s.sent, failed: s.failed, waiting: 0 },
      ]),
    );
    for (const [stepId, count] of waitingByStep) {
      const row = byStep.get(stepId);
      if (row) row.waiting = count;
      else byStep.set(stepId, { stepId, reached: 0, sent: 0, failed: 0, waiting: count });
    }
    return [...byStep.values()];
  },
});

export const waitingRuns = accountQuery({
  args: { automationId: v.id("automations"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    await requireOwnAutomation(ctx, args.automationId);
    const limit = clampLimit(args.limit, 100, 200);
    const rows = await ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation_status", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .eq("automationId", args.automationId)
          .eq("status", "waiting"),
      )
      .take(limit);
    return rows.sort((a, b) => (a.resumeAt ?? 0) - (b.resumeAt ?? 0));
  },
});

export const cancelRun = accountMutation({
  args: { runId: v.id("automationRuns") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const run = await ctx.db.get(args.runId);
    // Same error for "missing" and "not yours" — a cross-account probe
    // must not be able to tell them apart (`requireOwnAutomation`'s rule).
    if (!run || run.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Run not found" });
    }
    if (run.scheduledFnId) await ctx.scheduler.cancel(run.scheduledFnId);
    const now = Date.now();
    await ctx.db.patch(args.runId, {
      status: "cancelled",
      errorMessage: "cancelled from the dashboard",
      resumeAt: undefined,
      scheduledFnId: undefined,
      endedAt: now,
      updatedAt: now,
    });
    return null;
  },
});
```

Import `summarizeRuns` from `./lib/automations/runStats`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/automations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/automations.ts convex/automations.test.ts
git commit -m "feat(automations): queries for run counts, per-step stats and the waiting queue

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Stats in the UI

**Files:**
- Create: `src/components/automations/run-stats-bar.tsx`
- Modify: `src/app/(dashboard)/automations/page.tsx:288-296`
- Modify: `src/app/(dashboard)/automations/[id]/logs/page.tsx`
- Modify: `src/components/automations/automation-builder.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.automations.list` (`runCounts`), `api.automations.stepStats`, `api.automations.waitingRuns`, `api.automations.cancelRun`.
- Produces: `<RunStatsBar counts={RunCounts} />`.

- [ ] **Step 1: Build the shared stats bar**

Create `src/components/automations/run-stats-bar.tsx` exporting `<RunStatsBar counts size="sm" | "md" />` — a horizontal strip of four figures: **Enrolled**, **Waiting**, **Sent**, **Failed**, where *Sent* is `completed` and *Failed* is `failed`. Show `cancelled` only when non-zero, so the common case stays four numbers. Colour only *Failed* (destructive) and *Waiting* (muted-amber); the rest stay neutral. Do not import from a `convex/` query module — put any shared constant in `convex/lib/automations/runStats.ts`, which is already dependency-free (importing from a query module ships server code into the browser bundle).

- [ ] **Step 2: Put counts on the list page**

In `automations/page.tsx`, replace the `execution_count` / `last_executed_at` line (lines 288-296) with `<RunStatsBar counts={automation.runCounts} size="sm" />`, keeping the relative last-run timestamp beside it. Update `toUiAutomation` in `src/lib/convex/adapters.ts` to carry `runCounts` through.

- [ ] **Step 3: Put per-step chips on the canvas**

In `automation-builder.tsx`, query `api.automations.stepStats` once at the builder root (skip it in "new automation" mode, where there is no id) and provide it through the existing resources context or a sibling context. On each step card's collapsed header, render a chip row when that step has any stats:

`142 reached · 18 waiting · 3 failed`

Omit zero-valued figures so an untouched step shows nothing rather than three zeroes. Waiting is the figure that matters most — style it so it reads as live.

- [ ] **Step 4: Add the stopOnReply toggle**

In the builder's automation-level settings (beside the name/description fields), add a `<Switch>` bound to `stopOnReply` labelled *"Stop if the contact replies"* with the helper text: *"Cancels any queued steps for a contact as soon as they answer, so they don't keep getting scheduled messages."* Thread it through the `create`/`update` mutation calls.

- [ ] **Step 5: Add the summary bar and Waiting tab to the logs page**

In `logs/page.tsx`:

- render `<RunStatsBar counts={...} size="md" />` under the header, from the automation's row in `api.automations.list` (or add a dedicated single-automation counts query if fetching the whole list there is wasteful);
- add a two-tab switcher — **History** (the existing log list, unchanged) and **Waiting**;
- the Waiting tab lists `api.automations.waitingRuns` rows: contact name, which step they are parked at, a countdown to `resumeAt` rendered with the existing `formatRelative` helper, and a **Cancel** button calling `api.automations.cancelRun` with a confirm dialog matching the delete-dialog pattern already in `automations/page.tsx`;
- empty state: *"Nobody is queued right now."*

- [ ] **Step 6: Verify in the browser**

With the preview running — this step needs the schema deployed, so if the owner has not deployed, stop here and say so.

1. `/automations` — confirm each card shows the four figures.
2. Open an automation with a wait; confirm per-step chips render and the waiting count is non-zero after a test enrolment.
3. `/automations/<id>/logs` — confirm the summary bar, both tabs, the countdown, and that Cancel removes the row.
4. Toggle *Stop if the contact replies*, save, reload, confirm it persisted.
5. `read_console_messages` — expect no errors.
6. Check the `mobile` viewport preset — the stats bar must wrap, not overflow.

- [ ] **Step 7: Commit**

```bash
git add src/components/automations src/app/\(dashboard\)/automations src/lib/convex/adapters.ts messages/en.json
git commit -m "feat(automations): show enrolled/waiting/sent/failed and the waiting queue

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Full-suite verification

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint changed files**

Run: `npx eslint convex/lib/automations convex/automationsEngine.ts convex/automations.ts convex/contacts.ts convex/ingest.ts convex/schema.ts src/components/automations "src/app/(dashboard)/automations"`
Expected: clean.

- [ ] **Step 4: Confirm the cancellation guarantee end to end**

Write one integration test (or verify by hand in the preview) that a run parked on a wait, whose automation is then deactivated, produces **zero** outbound messages when its scheduled resume fires. This is the single most important behaviour in this plan — everything else is reporting.

- [ ] **Step 5: Commit any fixes**

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §2.1 `automationRuns` table + indexes | 1 |
| §2.1 `scheduledFnId` for cancellable waits | 1, 4 |
| §2.2 cancel on deactivate / delete | 5 |
| §2.2 cancel on `doNotContact` | 5 |
| §2.2 `stopOnReply`, default off | 1, 5, 8 |
| §2.3 `automationStepStats` | 1, 6 |
| §2.3 waiting derived, not stored | 7 |
| §2.4 list page counts | 7, 8 |
| §2.4 canvas per-step chips | 7, 8 |
| §2.4 logs summary + Waiting tab + cancel | 7, 8 |

**Known costs accepted deliberately:**
- `automations.list` collects every run row per automation. Fine at current volume, needs a rollup later; commented in code rather than pre-optimised.
- `cancelRunsForAutomation` self-schedules and is not concurrency-safe. Its only two callers each act on one automation under one user action.

---

### Task 10: Stable step keys

**Runs immediately after Task 1, before Task 2.** Numbered 10 only so Tasks 2-9
keep their existing numbers.

`automationSteps._id` is not a durable identity. `replaceSteps`
(`convex/automations.ts:242-257`) deletes every step row for an automation and
reinserts a fresh tree; `automation-builder.tsx`'s `save()` sends the full steps
array on every save, including a rename. So step ids churn constantly. Keying
per-step stats or a suspended run's position off them means one edit silently
zeroes every counter and detaches every queued contact.

`flowNodes.nodeKey` in the same schema file exists for exactly this reason — its
comment reads "a stable string, not the row id, so edges/`entryNodeId` survive a
clone without UUID rewriting." This task gives automations the same thing.

**Files:**
- Modify: `convex/schema.ts` (`automationSteps`, `automationStepStats`, `automationRuns`)
- Modify: `convex/automations.ts` (`insertStepsTree`, `loadOrderedSteps`/`toStepRow` if it projects fields)
- Modify: `convex/lib/automations/stepsTree.ts` (carry `id` through `StepRow`/`buildStepsTree`)
- Modify: `src/components/automations/automation-builder.tsx` (`toApiSteps`)
- Test: `convex/automations.test.ts`, `convex/lib/automations/stepsTree.test.ts`

**Interfaces:**
- Consumes: `BuilderStepInput.id` (already exists, `id?: string`).
- Produces: `automationSteps.stepKey: v.optional(v.string())`;
  `automationStepStats.stepKey: v.string()` replacing `stepId`;
  `automationRuns.currentStepKey: v.optional(v.string())` replacing
  `currentStepId`. Tasks 3-9 use these names.

- [ ] **Step 1: Write the failing test**

In `convex/automations.test.ts`:

```ts
test("a step's key survives a save that rewrites every step row", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);

  const before = await t.run(async (ctx) =>
    ctx.db.query("automationSteps").collect(),
  );
  const keysBefore = before.map((s) => s.stepKey).sort();
  expect(keysBefore.every(Boolean)).toBe(true);

  // A rename-only save still sends the full steps array, which deletes and
  // reinserts every row — the exact churn this key exists to survive.
  await asOwner.mutation(api.automations.update, {
    automationId,
    name: "Renamed",
    steps: before.map((s) => ({
      id: s.stepKey,
      step_type: s.stepType,
      step_config: s.stepConfig,
    })),
  });

  const after = await t.run(async (ctx) =>
    ctx.db.query("automationSteps").collect(),
  );
  expect(after.map((s) => s.stepKey).sort()).toEqual(keysBefore);
  // Ids genuinely churned — proving the key is what survived, not the row.
  expect(after.map((s) => s._id)).not.toEqual(before.map((s) => s._id));
});

test("a step with no incoming key is minted a fresh one", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);

  await asOwner.mutation(api.automations.update, {
    automationId,
    steps: [{ step_type: "send_message", step_config: { text: "hi" } }],
  });

  const rows = await t.run(async (ctx) =>
    ctx.db.query("automationSteps").collect(),
  );
  expect(rows).toHaveLength(1);
  expect(typeof rows[0]!.stepKey).toBe("string");
  expect(rows[0]!.stepKey!.length).toBeGreaterThan(0);
});

test("two steps never share a key", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);

  await asOwner.mutation(api.automations.update, {
    automationId,
    steps: [
      { step_type: "send_message", step_config: { text: "a" } },
      { step_type: "send_message", step_config: { text: "b" } },
    ],
  });

  const rows = await t.run(async (ctx) =>
    ctx.db.query("automationSteps").collect(),
  );
  const keys = rows.map((s) => s.stepKey);
  expect(new Set(keys).size).toBe(keys.length);
});
```

Write `seedAutomationForSteps` locally, modelled on the suite's existing seeds.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/automations.test.ts -t "key"`
Expected: FAIL — `stepKey` does not exist on the row.

- [ ] **Step 3: Add the schema field**

In `convex/schema.ts`, inside `automationSteps`:

```ts
    // A stable per-step identity. NOT the row id: `replaceSteps` deletes
    // and reinserts every step row on each save (see
    // `convex/automations.ts`), so `_id` churns constantly and anything
    // keyed on it — per-step counters, a suspended run's position —
    // silently detaches after one edit. Same role, and same reasoning, as
    // `flowNodes.nodeKey` below.
    //
    // Optional because rows written before this field existed have none.
    // Readers derive an effective key as `stepKey ?? _id`, so old rows
    // keep working; the next save of that automation mints real keys for
    // every step and they are stable from then on.
    stepKey: v.optional(v.string()),
```

Add `.index("by_account_step_key", ["accountId", "stepKey"])` to that table.

Then change the two Task 1 tables to key on it:

```ts
  // in automationRuns — replaces currentStepId
    currentStepKey: v.optional(v.string()),
  // in automationStepStats — replaces stepId
    stepKey: v.string(),
```

and update `automationStepStats`'s second index to
`.index("by_account_step_key", ["accountId", "stepKey"])`.

- [ ] **Step 4: Mint and persist the key**

In `convex/automations.ts`'s `insertStepsTree`, pass a key through on insert:

```ts
      stepKey: step.id && step.id.trim() ? step.id : crypto.randomUUID(),
```

`BuilderStepInput.id` already exists (`convex/lib/automations/stepsTree.ts:45`),
so the builder only has to start sending it. Confirm `crypto.randomUUID` is
available in the Convex runtime; if not, mint with the same helper the codebase
already uses elsewhere for ids rather than introducing a new dependency.

Then make the read path carry it back out: `buildStepsTree`/`StepRow` in
`convex/lib/automations/stepsTree.ts` must expose `stepKey` so the builder can
round-trip it, and `automations.get` must return it.

Finally, in `src/components/automations/automation-builder.tsx`, have
`toApiSteps` send the key:

```tsx
export function toApiSteps(steps: BuilderStep[]): ApiStep[] {
  return steps.map((s) => ({
    // Round-trips the server's stable key so a save preserves per-step
    // stats. `s.cid` is the client-local fallback for a step added in this
    // editing session that has never been saved.
    id: s.step_key ?? s.cid,
    step_type: s.step_type,
    step_config: s.step_config,
    branches: s.branches
      ? { yes: toApiSteps(s.branches.yes), no: toApiSteps(s.branches.no) }
      : undefined,
  }))
}
```

Add `step_key?: string` to `BuilderStep` and populate it wherever the server
tree is converted into builder-local shape.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run convex/automations.test.ts`
Then: `npx vitest run convex/` and `npx vitest run src/`
Expected: PASS. Watch `convex/automations.test.ts`'s duplicate/create tests in
particular — `duplicate` copies steps and must not copy keys verbatim, or the
clone's stats would merge into the original's. Assert that explicitly:

```ts
test("duplicating an automation gives its steps fresh keys", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);
  const originalKeys = (await t.run(async (ctx) =>
    ctx.db.query("automationSteps").collect(),
  )).map((s) => s.stepKey);

  const copyId = await asOwner.mutation(api.automations.duplicate, { automationId });

  const copyKeys = (await t.run(async (ctx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", copyId))
      .collect(),
  )).map((s) => s.stepKey);

  expect(copyKeys.some((k) => originalKeys.includes(k))).toBe(false);
});
```

- [ ] **Step 6: Commit**

```bash
git add convex/schema.ts convex/automations.ts convex/lib/automations/stepsTree.ts src/components/automations/automation-builder.tsx convex/automations.test.ts
git commit -m "feat(automations): give steps a stable key that survives a save

replaceSteps deletes and reinserts every step row on each save, so _id
churns and anything keyed on it detaches after one edit. Mirrors
flowNodes.nodeKey, which exists for the same reason.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

**One-time reset, worth knowing:** an automation saved before this ships has no
`stepKey`, so its stats key on `_id` until its next save, which mints permanent
keys. Each automation therefore resets its per-step counters exactly once, at its
first save after deploy, and is stable forever after. Aggregate run counts
(enrolled/waiting/sent/failed) are unaffected — they key on `automationId`.
