# Lead Analysis P3 — Follow-up Sequence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically nudge a lead that went quiet — up to three approved-template follow-ups on a score-banded cadence — then archive it, unless the customer replies first.

**Architecture:** Mirrors the proven follow-up machinery in `convex/qualificationEngine.ts`: a cron sweep fans out one action per due lead; a verdict query re-evaluates **every** gate at send time (arming happened hours earlier and anything may have changed); the action **claims the slot before sending**, so a transient failure skips a nudge rather than duplicating one. Arming is event-driven on outbound. Auto-archive routes through the same shared core P2's manual archive uses, so the mirror invariant holds.

**Tech Stack:** Convex (queries/mutations/actions/crons), TypeScript, Vitest + convex-test, Next.js App Router, next-intl, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-07-26-lead-analysis-design.md` (§"Follow-up sequence")
**Predecessors:** P1 (`…-p1.md`) and P2 (`…-p2.md`), both shipped on `feat/lead-analysis-clean`.

---

## ⚠️ THIS IS THE PHASE THAT SENDS

P1 and P2 sent **nothing**. Every one of their reviews verified that invariant. **P3 removes it.** This code sends real WhatsApp marketing templates to real customers on the owner's Meta account, costing money per send and risking the account's quality rating.

Everything below follows from that. Read this section before any task.

- **Fail closed, always.** Every unknown is a reason NOT to send: no working hours configured → don't send. Template not approved → don't send. Cap reached → don't send. Config disabled → don't send. There is no default that sends.
- **At-most-once, never at-least-once.** Claim the slot and book the next rung *before* the provider call, exactly as `qualificationEngine.sendFollowUp` does. A duplicate marketing message to a customer is far worse than a missed one.
- **Re-check everything at send time.** Arming happens on an outbound message; the send happens days later. The customer may have replied, an agent may have taken over, the lead may have been archived, the config may have been disabled, the template may have been rejected by Meta.
- **The kill switch must be real.** `leadAnalysisConfigs.enabled === false` must stop sends *immediately*, including for work already queued. P1 shipped a version of this bug: `claimDueForScoring` ranged a global partition with no config check, so disabling the feature left a backlog running. Do not repeat it.
- **Every send is visible.** Each send writes a normal `messages` row, so it appears in the thread exactly as an agent's message would. There are no invisible sends.

## Global Constraints

- **Never run `convex deploy`, `convex dev`, or `convex codegen`.** Self-hosted production; the owner deploys. Schema edits are committed only.
- **`convex/_generated/api.d.ts` is edited BY HAND** (owner-approved). Two alphabetically-sorted lists: an import block and the `fullApi` map. Task 3 registers all new lib modules at once. Insert only.
- **Before widening any schema union, grep for its hand-maintained twins.** This repo keeps mirrors that `tsc` enforces separately, and both prior phases were bitten: P1's `aiUsageLog.mode` had a twin in `convex/aiUsage.ts` *and* an exhaustive `Record` in a component; P2's `notifications.type` had **four** mirrors. Run `grep -rn "<literal>" src/ convex/` and look for `Record<Union, …>` before editing.
- **No unbounded reads.** Every query is an index range with an explicit `.take()`. Never `.filter()` across a partition that grows forever.
- **Tenancy:** account-scoped handlers use `ctx.accountId`; internal handlers take an explicit `accountId` and verify the row belongs to it.
- **Verify commands:** `npm test`, `npx vitest run <path>`, `npm run typecheck`, `npx eslint <path>`. Pre-existing lint debt — `npm run lint` over the tree is NOT the gate.
- **No jsdom, no Testing Library.** Component tests use `renderToStaticMarkup` + string assertions with **no** single-match uniqueness enforcement, so **every assertion must be scoped to a `data-testid`** via the existing `textByTestId` helper. P1 shipped three vacuous assertions this way and P2 nearly shipped a fourth.
- **Git:** stage paths explicitly; never `git add -A`. Concurrent sessions share this repository.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- **Baseline on `feat/lead-analysis-clean`:** 2434 tests passing across 180 files, typecheck clean.

## Owner decisions already made (2026-07-26)

| Question | Decision |
|---|---|
| Where do working hours come from? | **`qualificationConfigs`, and refuse to send if unset.** One source of truth for "when may we message customers". Duplicating it is how you get 3am sends after someone updates one copy. The config UI must say plainly that hours are unset and nothing will send. |
| Template rejected/paused by Meta at send time? | **Stop that lead's sequence and flag it.** No send; `sequenceStatus: "stopped"`, `stoppedReason: "template_unavailable"`; the lead surfaces for review. Loud, not silent — a rejected template is a real problem, and retrying forever tells nobody. |
| Auto-archive hot leads? | **Never.** Hot (8–10) ends at `exhausted` and waits for a human. Warm and cold auto-archive with reason `no_response`. (Spec, already encoded in `defaultLeadAnalysisConfig`.) |

## The gate chain

Evaluated **at send time**. **The numbered gates below describe WHAT is checked; they are NOT the evaluation order.** Evaluation follows the five-tier model beneath the table — three correction rounds on Task 1 established that a flat pass in gate-number order is wrong, because it lets a transient verdict pre-empt a terminal one and lets an *action* (`archive`) pre-empt a defer.


| # | Gate | Fails → |
|---|---|---|
| 1 | `leadAnalysisConfigs.enabled` | `stop` (disabled) |
| 2 | conversation not archived | `stop` |
| 3 | `conversation.status !== "closed"` | `stop` |
| 4 | lane is *awaiting them* — last message not from the customer | `stop` (they replied) |
| 5 | idle ≥ `idleDaysBeforeSequence` | `reschedule` |
| 6 | qualification has released the clock: no session, **or** session not `collecting`, **or** `followUpsSent >= maxFollowUps` | `reschedule` |
| 7 | not opted out (no `opted_out` qualification session) | `stop` |
| 8 | no `senderType: "agent"` message within `humanQuietHours` | `reschedule` |
| 9 | band resolves and has a step at this index | `exhaust` or `archive` |
| 10 | working hours known **and** now is inside them | `reschedule` (or `stop` if unknown) |
| 11 | daily cap not exhausted | `reschedule` |
| 12 | the step's template exists and is `APPROVED` | `stop` (`template_unavailable`) |

### The five-tier evaluation order (authoritative)

| Tier | Contains | Rationale |
|---|---|---|
| 1 | **Lead-level stops** — `disabled`, `archived`, `conversation_closed`, `replied`, `no_customer_message`, `opted_out`, `no_band` | Facts about the **lead**. Absolute; nothing later can override them. |
| 2 | **Activity defers** (reschedule) — `not_idle_yet`, `qualification_owns`, `agent_active` | The lead is **alive**. Defer everything, *including archiving* — auto-archiving a lead an agent or the qualification engine is actively working is the "silently drops a lead" failure. |
| 3 | **Band exhaustion** — `archive` (auto-archive bands) / `exhaust` (hot) | Reached only once the lead is genuinely quiet on all three counts above. |
| 4 | **Send-capability gates** — `working_hours_unset` (stop), `template_unavailable` (stop), then `outside_hours` (reschedule), `daily_cap` (reschedule) | Facts about our ability to **send**, not about the lead. They must sit *after* tier 3: archiving sends nothing, so an unset-hours or rejected-template config must never prevent a dead lead from being filed. Within this tier the two stops precede the two reschedules — the only place "stop beats reschedule" is not guaranteed by whole-tier ordering. |
| 5 | **`send`** | |

Tier 4's placement also keeps the interface coherent: with the band exhausted, tier 3 returns first, so nothing ever has to answer "is the non-existent step's template approved?"

**Gate 6 is the relaxation the owner approved during P1 brainstorming.** A session that has spent its `maxFollowUps` releases the clock even while still `collecting` — safe by construction, because `convex/qualificationEngine.ts` stops sending at that point and only reschedules to its expiry revisit. Without it a half-answered lead stays invisible to nurture for the whole `sessionWindowHours`.

## File Structure

**Create — pure logic:**

| File | Responsibility |
|---|---|
| `convex/lib/leadAnalysis/eligibility.ts` | the gate chain as one pure predicate over a plain input record |
| `convex/lib/leadAnalysis/sequenceSchedule.ts` | first-touch time, next-step time, working-hours clamp |
| `convex/lib/leadAnalysis/sendRate.ts` | daily-cap fixed-window arithmetic |
| + a `.test.ts` beside each | |

**Modify:**

| File | Change |
|---|---|
| `convex/schema.ts` | `leadSequenceSendRate` table; `leadAnalysisConfigs` gains nothing (all fields exist from P1) |
| `convex/_generated/api.d.ts` | register the three new lib modules (by hand) |
| `convex/leadAnalysis.ts` | extract the shared archive core; add `sequencePreview` query; `stopSequence` mutation |
| `convex/leadAnalysisEngine.ts` | arming, verdict query, claim, send action, sweep |
| `convex/messages.ts` *or* `convex/send.ts` | arm the sequence on outbound |
| `convex/ingest.ts` | stop the sequence on inbound |
| `convex/crons.ts`, `convex/cronSchedules.ts`, `convex/lib/cronSummary.ts` | register `lead-sequence` |
| `src/components/settings/…` + settings section registry | the config UI |
| `messages/en.json` | new strings |

---

### Task 1: The gate chain (pure)

**Files:** Create `convex/lib/leadAnalysis/eligibility.ts` + `.test.ts`

**Interfaces:**
- Produces: `STOP_REASONS` / `RESCHEDULE_REASONS` (closed vocabularies, below); `type SequenceVerdict = { kind: "send"; stepIndex: number } | { kind: "reschedule"; reason: RescheduleReason } | { kind: "stop"; reason: StopReason } | { kind: "exhaust" } | { kind: "archive" }`; `interface EligibilityInput {…}`; `evaluateSequence(input: EligibilityInput): SequenceVerdict`.

**The reason vocabularies are closed sets, exported from this module**, mirroring how `convex/lib/leadAnalysis/archive.ts` owns `ARCHIVE_REASONS`. These strings are persisted to `leadAnalyses.stoppedReason` and rendered in the UI, and they are referenced by Tasks 7, 8, 9 and 10 — a free-form string would drift across four tasks and leave the UI rendering reasons it has no label for.

```ts
export const STOP_REASONS = [
  "disabled",             // gate 1 — the feature was switched off
  "archived",             // gate 2, or the sequence's own auto-archive
  "conversation_closed",  // gate 3
  "replied",              // gate 4 — the customer came back
  "opted_out",            // gate 7
  "no_band",              // gate 9 — score outside every configured band
  "working_hours_unset",  // gate 10 — fail-closed, owner decision
  "template_unavailable", // gate 12 — Meta rejected or paused it
  "manual",               // a human pulled the lead out (Task 9)
] as const;

export const RESCHEDULE_REASONS = [
  "not_idle_yet",       // gate 5
  "qualification_owns", // gate 6
  "agent_active",       // gate 8
  "outside_hours",      // gate 10
  "daily_cap",          // gate 11
] as const;
```

Type both as string-literal unions and have `evaluateSequence`'s return type use them, so a typo is a compile error rather than an unlabelled chip in the UI.

The input record is **plain data** — no Convex types, no `Doc<>`. The verdict query assembles it; this module never touches a database. That is what makes the twelve-gate chain unit-testable without fixtures.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/leadAnalysis/eligibility.test.ts`. Cover **each gate failing in isolation** (twelve tests), then these combinations:

```ts
import { expect, test } from "vitest";
import {
  evaluateSequence,
  STOP_REASONS,
  RESCHEDULE_REASONS,
  type EligibilityInput,
} from "./eligibility";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 6, 20, 8, 0); // Mon 12:00 Gulf

/** A lead that SHOULD send: quiet 5 days, warm band, everything clear. */
function ok(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    now: NOW,
    enabled: true,
    archived: false,
    conversationStatus: "open",
    lastMessageSenderType: "agent",
    lastCustomerMessageAt: NOW - 5 * DAY,
    lastAgentMessageAt: NOW - 5 * DAY,
    idleDaysBeforeSequence: 3,
    humanQuietHours: 24,
    qualification: null,
    optedOut: false,
    band: {
      key: "warm",
      minScore: 4,
      maxScore: 7,
      autoArchive: true,
      steps: [
        { delayDays: 3, templateName: "nudge_1" },
        { delayDays: 7, templateName: "nudge_2" },
      ],
    },
    followUpsSent: 0,
    lastFollowUpAt: null,
    workingHoursKnown: true,
    withinWorkingHours: true,
    dailyCapReached: false,
    templateApproved: true,
    ...over,
  };
}

test("a clear lead sends step 0", () => {
  expect(evaluateSequence(ok())).toEqual({ kind: "send", stepIndex: 0 });
});

test("gate 1 — disabled stops", () => {
  expect(evaluateSequence(ok({ enabled: false })).kind).toBe("stop");
});

test("gate 2 — archived stops", () => {
  expect(evaluateSequence(ok({ archived: true })).kind).toBe("stop");
});

test("gate 3 — a closed conversation stops", () => {
  expect(evaluateSequence(ok({ conversationStatus: "closed" })).kind).toBe("stop");
});

test("gate 4 — the customer having replied last stops, never reschedules", () => {
  const v = evaluateSequence(ok({ lastMessageSenderType: "customer" }));
  expect(v.kind).toBe("stop");
});

test("gate 5 — not idle long enough reschedules rather than stopping", () => {
  const v = evaluateSequence(ok({ lastCustomerMessageAt: NOW - 1 * DAY }));
  expect(v.kind).toBe("reschedule");
});

test("gate 6 — a collecting session with follow-ups left reschedules", () => {
  const v = evaluateSequence(
    ok({ qualification: { status: "collecting", followUpsSent: 1, maxFollowUps: 4 } }),
  );
  expect(v.kind).toBe("reschedule");
});

test("gate 6 — a collecting session that spent its budget RELEASES the clock", () => {
  const v = evaluateSequence(
    ok({ qualification: { status: "collecting", followUpsSent: 4, maxFollowUps: 4 } }),
  );
  expect(v).toEqual({ kind: "send", stepIndex: 0 });
});

test("gate 6 — a non-collecting session never blocks", () => {
  const v = evaluateSequence(
    ok({ qualification: { status: "qualified", followUpsSent: 0, maxFollowUps: 4 } }),
  );
  expect(v).toEqual({ kind: "send", stepIndex: 0 });
});

test("gate 7 — opted out stops", () => {
  expect(evaluateSequence(ok({ optedOut: true })).kind).toBe("stop");
});

test("gate 8 — a recent agent message reschedules", () => {
  const v = evaluateSequence(ok({ lastAgentMessageAt: NOW - 2 * HOUR }));
  expect(v.kind).toBe("reschedule");
});

test("gate 9 — steps exhausted on an auto-archive band archives", () => {
  expect(evaluateSequence(ok({ followUpsSent: 2 })).kind).toBe("archive");
});

test("gate 9 — steps exhausted on a NON-auto-archive band exhausts, never archives", () => {
  const hot = ok({
    followUpsSent: 3,
    band: {
      key: "hot", minScore: 8, maxScore: 10, autoArchive: false,
      steps: [
        { delayDays: 2, templateName: "a" },
        { delayDays: 5, templateName: "b" },
        { delayDays: 10, templateName: "c" },
      ],
    },
  });
  expect(evaluateSequence(hot)).toEqual({ kind: "exhaust" });
});

test("gate 9 — an unresolvable band stops rather than guessing a cadence", () => {
  expect(evaluateSequence(ok({ band: null })).kind).toBe("stop");
});

test("gate 10 — unknown working hours STOP, they do not reschedule", () => {
  const v = evaluateSequence(ok({ workingHoursKnown: false }));
  expect(v.kind).toBe("stop");
});

test("gate 10 — outside working hours reschedules", () => {
  const v = evaluateSequence(ok({ withinWorkingHours: false }));
  expect(v.kind).toBe("reschedule");
});

test("gate 11 — the daily cap reschedules, it never drops a lead", () => {
  const v = evaluateSequence(ok({ dailyCapReached: true }));
  expect(v.kind).toBe("reschedule");
});

test("gate 12 — an unapproved template stops with a reviewable reason", () => {
  const v = evaluateSequence(ok({ templateApproved: false }));
  expect(v).toEqual({ kind: "stop", reason: "template_unavailable" });
});

test("every reason a verdict can carry is in its declared vocabulary", () => {
  // Guards the four tasks downstream that persist and render these.
  const cases: EligibilityInput[] = [
    ok({ enabled: false }), ok({ archived: true }),
    ok({ conversationStatus: "closed" }), ok({ lastMessageSenderType: "customer" }),
    ok({ optedOut: true }), ok({ band: null }),
    ok({ workingHoursKnown: false }), ok({ templateApproved: false }),
    ok({ lastCustomerMessageAt: NOW - 1 * DAY }),
    ok({ qualification: { status: "collecting", followUpsSent: 1, maxFollowUps: 4 } }),
    ok({ lastAgentMessageAt: NOW - 2 * HOUR }),
    ok({ withinWorkingHours: false }), ok({ dailyCapReached: true }),
  ];
  for (const input of cases) {
    const v = evaluateSequence(input);
    if (v.kind === "stop") expect(STOP_REASONS).toContain(v.reason);
    if (v.kind === "reschedule") expect(RESCHEDULE_REASONS).toContain(v.reason);
  }
});

test("a stop always beats a reschedule when both apply", () => {
  // Archived (stop) AND outside hours (reschedule): must stop.
  const v = evaluateSequence(ok({ archived: true, withinWorkingHours: false }));
  expect(v.kind).toBe("stop");
});

test("every send verdict names a step index inside the band", () => {
  const v = evaluateSequence(ok({ followUpsSent: 1 }));
  expect(v).toEqual({ kind: "send", stepIndex: 1 });
});
```

- [ ] **Step 2: Run it and watch it fail** — `npx vitest run convex/lib/leadAnalysis/eligibility.test.ts`. Expected: `Failed to resolve import "./eligibility"`.

- [ ] **Step 3: Implement `eligibility.ts`**

Write the chain in the gate order of the table above, returning on the first failure. Requirements the tests pin:

- **`stop` beats `reschedule`.** A lead that is archived *and* out of hours stops.
- **`stop` for terminal conditions** (disabled, archived, closed, replied, opted out, no band, unknown hours, bad template); **`reschedule` for transient ones** (not idle yet, qualification still owns the clock, agent active, outside hours, cap reached).
- Every `stop` and `reschedule` carries a `reason` string — it is written to `stoppedReason` and shown in the UI, so it must be a stable identifier, not prose.
- `stepIndex` is `followUpsSent`; exhaustion is `followUpsSent >= band.steps.length`.
- Header comment explaining that this is evaluated at SEND time, and why each transient/terminal split is what it is.

- [ ] **Step 4: Run and watch it pass.** Expected: 21 tests.

- [ ] **Step 5: Commit** — stage `convex/lib/leadAnalysis/eligibility.ts` and `.test.ts`.

---

### Task 2: Sequence scheduling (pure)

**Files:** Create `convex/lib/leadAnalysis/sequenceSchedule.ts` + `.test.ts`

**Interfaces:**
- Consumes: `clampToWorkingHours` and `WorkingHoursConfig` from `convex/lib/qualification/schedule.ts` — **read that module first and reuse it; do not reimplement the timezone arithmetic.**
- Produces: `firstTouchAt(input): number`; `nextStepAt(input): number`; `isWithinWorkingHours(ts, config): boolean`.

**The measurement rule** (from the spec, and the thing most likely to be got wrong):
- **Step 0** is measured from the **last customer message**.
- **Every later step** is measured from the **previous follow-up send**.
- `idleDaysBeforeSequence` is an independent floor on entry, so the effective first touch is `max(idleDaysBeforeSequence, steps[0].delayDays)` days after the last customer message.

With the approved defaults that means hot and warm are first nudged at day 3, cold at day 5.

- [ ] **Step 1: Write the failing test.** Pin at minimum:
  - first touch = `lastCustomerMessageAt + max(idleDays, step0.delayDays)`, exercised where the floor dominates (hot: idle 3 > delay 2 → day 3) **and** where the step delay dominates (cold: delay 5 > idle 3 → day 5)
  - step *n>0* = `lastFollowUpAt + steps[n].delayDays`, **not** measured from the customer message
  - the result is clamped into working hours (use the Dubai fixture from `convex/lib/qualification/schedule.test.ts` for consistency)
  - a computed time already inside working hours is returned unchanged
  - a time landing on a non-working day rolls to the next working day's opening
  - `isWithinWorkingHours` agrees with `clampToWorkingHours` returning its input unchanged

- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement**, delegating all timezone/working-day arithmetic to `clampToWorkingHours`. Pure: no `Date.now()`, every timestamp is an argument.
- [ ] **Step 4: Run and watch it pass.**
- [ ] **Step 5: Commit.**

---

### Task 3: Daily send cap (pure) + register all three lib modules

**Files:** Create `convex/lib/leadAnalysis/sendRate.ts` + `.test.ts`; modify `convex/_generated/api.d.ts`

**Interfaces:**
- Produces: `interface SendRateState { dayStartMs: number; count: number }`; `dayStartFor(ts, utcOffsetMinutes): number`; `claimSendSlot(state: SendRateState | null, now: number, utcOffsetMinutes: number, cap: number): { granted: boolean; next: SendRateState }`.

**Mirror `convex/lib/aiRateLimit.ts`** — read it first. It is a pure fixed-window budget with no Convex imports; the mutation reads the row, calls the helper, writes the result back. Same shape here, with one difference: `aiRateLimit` **paces** (a refusal is "come back in N ms" because the owner decided the bot answers every message). **This one refuses** — a marketing send over the daily cap must not happen today at all. The caller reschedules to tomorrow's window.

The day boundary is **account-local**, not UTC — a cap called "100 per day" that resets at 4am local time would be surprising. Derive it from the same `utcOffsetMinutes` the working hours use.

- [ ] **Step 1: Write the failing test.** Pin: a fresh account (null state) grants; the count increments; the cap boundary grants at `cap-1` and refuses at `cap`; a new day resets the window; a stale state from an earlier day resets rather than accumulating; the returned `next` is always a complete valid state; the day boundary honours a non-zero `utcOffsetMinutes`.
- [ ] **Step 2: Run it and watch it fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and watch it pass.**

- [ ] **Step 5: Register all three new lib modules in `convex/_generated/api.d.ts`**

Codegen is forbidden here; this file is hand-edited (owner-approved). All three modules from Tasks 1–3 exist now, so register them together. In the import block and the `fullApi` map, in alphabetical position — `eligibility` sorts after `defaults`, `sendRate` after `prompt`, `sequenceSchedule` after `sendRate`:

```ts
import type * as lib_leadAnalysis_eligibility from "../lib/leadAnalysis/eligibility.js";
import type * as lib_leadAnalysis_sendRate from "../lib/leadAnalysis/sendRate.js";
import type * as lib_leadAnalysis_sequenceSchedule from "../lib/leadAnalysis/sequenceSchedule.js";
```

```ts
  "lib/leadAnalysis/eligibility": typeof lib_leadAnalysis_eligibility;
  "lib/leadAnalysis/sendRate": typeof lib_leadAnalysis_sendRate;
  "lib/leadAnalysis/sequenceSchedule": typeof lib_leadAnalysis_sequenceSchedule;
```

Verify the alphabetical positions against the file rather than trusting this snippet. Insert only.

- [ ] **Step 6: `npm run typecheck`** — must be clean.
- [ ] **Step 7: Commit** all three lib files, their tests, and `api.d.ts`.

---

### Task 4: Schema — the send-rate counter

**Files:** Modify `convex/schema.ts`

Add one table. Everything else P3 needs already exists on `leadAnalyses` (`sequenceStatus`, `followUpsSent`, `lastFollowUpAt`, `nextFollowUpAt`, `stoppedReason`) and `leadAnalysisConfigs` (`bands` with steps, `idleDaysBeforeSequence`, `humanQuietHours`, `dailySendCap`) — P1 put them there deliberately so this phase needs no second production schema deploy for them.

```ts
  // Daily marketing-send budget, one row per account. Mirrors
  // `aiAutoReplyRate`'s fixed-window shape, with one deliberate
  // difference: `aiAutoReplyRate` PACES (a refusal there means "retry in
  // N ms", because the bot answers every message), whereas this one
  // REFUSES — a marketing template over the day's cap must not be sent
  // today at all, and the caller reschedules to tomorrow.
  //
  // `dayStartMs` is the ACCOUNT-LOCAL midnight, derived from the same
  // `qualificationConfigs.utcOffsetMinutes` the working hours use: a cap
  // described as "100 per day" that reset at 4am local would be
  // surprising to the person who set it.
  leadSequenceSendRate: defineTable({
    accountId: v.id("accounts"),
    dayStartMs: v.number(),
    count: v.number(),
  }).index("by_account", ["accountId"]),
```

- [ ] **Step 1: Add the table** immediately before the final `});`.
- [ ] **Step 2: `npx vitest run convex/schema.test.ts`** — the change is a new table, purely additive.
- [ ] **Step 3: `npm test` + `npm run typecheck`** — the full-suite count must be UNCHANGED; nothing reads the table yet.
- [ ] **Step 4: Commit** `convex/schema.ts` only.

---

### Task 5: Extract the shared archive core

**Files:** Modify `convex/leadAnalysis.ts`, `convex/leadAnalysis.test.ts`

P2 established a **sync invariant**: `conversations.archivedAt` and its `leadAnalyses.archived` mirror are written only by `archive`, `restore`, and `unarchiveOnInbound`, each patching both rows in one transaction. The schema comment names them.

P3 adds a **fourth** writer — the sequence's auto-archive, which runs from a cron with no user and therefore cannot call `archive` (an `accountMutation` gated on `requireRole("supervisor")`).

**Do not duplicate the archive logic.** Extract the body into a shared internal function and have both call it, so the invariant stays enforced in one place.

- [ ] **Step 1: Write the failing test.** Pin that an auto-archive performed with no acting user:
  - sets `archivedAt`, `archivedReason: "no_response"`, and leaves `archivedByUserId` **unset** (absent = automation, per the P2 schema comment)
  - sets the `leadAnalyses.archived` mirror to `true`
  - zeroes `unreadCount`, exactly as the manual path does
  - is idempotent — a second call does not move `archivedAt`

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Extract.** Create an internal, non-exported-to-the-API helper (e.g. `async function archiveConversationCore(ctx, { conversationId, reason, note?, byUserId? })`) holding P2's existing body verbatim. `archive` becomes: `requireRole("supervisor")` → `requireOwnConversation` → validate the reason → call the core. Add an `internalMutation` wrapper for the engine to call.

  **Update the schema comment** in `convex/schema.ts` that enumerates the permitted writers, so it names the core rather than a stale list of three mutations. A comment that lies about an invariant is worse than none.

- [ ] **Step 4: Run and watch it pass**, plus the full P2 archive suite unchanged.
- [ ] **Step 5: Commit.**

---

### Task 6: Arm on outbound, stop on inbound

**Files:** Modify `convex/leadAnalysisEngine.ts`, `convex/ingest.ts`, the outbound message choke point, and their tests.

**Arming.** A lead becomes a nurture candidate at the moment *we* send and they go quiet — which is an outbound message. Arm there: set `sequenceStatus: "running"`, `followUpsSent: 0`, and `nextFollowUpAt = firstTouchAt(...)`.

Arming is deliberately **optimistic and cheap** — it does not evaluate the gate chain. Every gate is re-checked at send time, so a lead armed in error simply resolves to `stop` or `reschedule` and costs nothing. Do not duplicate the gates here.

Find the single outbound choke point: `convex/schema.ts`'s `messageHourlyStats` comment names `messages.ts`'s `insert("messages")` as the one place every message is written. Read it and hook there, or at the nearest equivalent that sees every agent and bot send. **Report which you chose and why.**

Skip arming when: the config is disabled, the conversation is archived, or the message is inbound.

**Stopping.** Any inbound customer message stops the sequence: `sequenceStatus: "stopped"`, `stoppedReason: "replied"`, `followUpsSent: 0`, `nextFollowUpAt: undefined`. Hook it in `convex/ingest.ts` beside P2's `unarchiveOnInbound`, wrapped in `runBestEffort` — stopping a sequence must never fail message ingestion.

Reset `followUpsSent` to 0 deliberately: a customer who replies and later goes quiet again deserves a fresh cadence, not the tail of the old one.

- [ ] **Step 1: Write the failing tests.** Pin: an outbound arms with the right `nextFollowUpAt`; an outbound to an archived conversation does not arm; an outbound with the feature disabled does not arm; an inbound stops a running sequence and resets the counter; an inbound on a lead with no sequence is a cheap no-op; arming twice does not double-advance the clock.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement**, adding exactly one `runBestEffort` block to `ingest.ts` at the named anchor and nothing else in that file.
- [ ] **Step 4: Run the focused tests, then `npx vitest run convex/ingest.test.ts`** to prove the webhook path did not regress.
- [ ] **Step 5: `npm test` + `npm run typecheck`.**
- [ ] **Step 6: Commit.**

---

### Task 7: The verdict query

**Files:** Modify `convex/leadAnalysisEngine.ts`, `convex/leadAnalysisEngine.test.ts`

**Interfaces:** Produces `internal.leadAnalysisEngine.sequenceContext({ analysisId }) → SequenceVerdict & { send?: {…} }`.

This is the heart. It assembles the plain-data input record and calls `evaluateSequence` from Task 1. **It must contain no policy of its own** — every decision belongs in the pure module. If you find yourself writing an `if` that decides whether to send, it belongs in `eligibility.ts` with a test.

Mirror `convex/qualificationEngine.ts`'s `followUpContext` (around line 1430): a single internal query returning a discriminated verdict, with the guards evaluated fresh.

What it must read:
- the analysis row and its conversation
- the account's `leadAnalysisConfigs` (gate 1, bands, cap, idle/quiet windows)
- the last message and the last **customer** message (`by_conversation_sender` — an indexed range, not a scan of the thread)
- the last **agent** message (same index, gate 8)
- the conversation's newest `qualificationSessions` row (gates 6 and 7)
- `qualificationConfigs` for working hours — **absent ⇒ `workingHoursKnown: false` ⇒ stop.** This is the owner's fail-closed decision; do not substitute a default
- the account's `leadSequenceSendRate` row (gate 11)
- the step's `messageTemplates` row by name+language, requiring `status === "APPROVED"` (gate 12)

For a `send` verdict, also return what the send needs: the recipient phone, the resolved template name and language, and the rendered `contentText` for the persisted message row.

- [ ] **Step 1: Write the failing tests.** At least: each verdict kind reachable end to end through real fixtures; the working-hours-unset case stops; an unapproved template stops with `template_unavailable`; a lead whose customer replied since arming stops; the reads use indexes (assert behaviour, and eyeball the query shapes).
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and watch them pass.**
- [ ] **Step 5: Commit.**

---

### Task 8: Claim, send, sweep

**Files:** Modify `convex/leadAnalysisEngine.ts`, `convex/leadAnalysisEngine.test.ts`

**Interfaces:** Produces `internal.leadAnalysisEngine.claimSequenceSlot({ analysisId })`; `internal.leadAnalysisEngine.sendSequenceStep({ analysisId })`; `internal.leadAnalysisEngine.sweepLeadSequence()`.

**This is the task that spends the owner's money.** Mirror `qualificationEngine.sendFollowUp` (around line 1573) exactly, including its comments' reasoning.

**`claimSequenceSlot` (internalMutation) — the safety mechanism.** Called *before* the provider call. In one transaction it must:
1. re-read the row and bail (returning `false`) if `sequenceStatus !== "running"` or `nextFollowUpAt` has moved — another sender or a state change got there first
2. claim the daily budget via `claimSendSlot`, writing the `leadSequenceSendRate` row back; return `false` if refused
3. increment `followUpsSent`, set `lastFollowUpAt = now`, and **book the next rung** (`nextStepAt`, or clear it if this was the last step)
4. return `true`

**The order is the point.** The slot is spent and the next rung booked *before* the send, so a transient provider failure skips one nudge rather than duplicating one. At-most-once, by construction. Say so in a comment.

**`sendSequenceStep` (internalAction).** Runs `sequenceContext`, switches on the verdict:
- `send` → `claimSequenceSlot`; if it returns `false`, return silently; otherwise `internal.metaSend.sendTemplate` with `senderType: "bot"`, wrapped in its own try/catch that logs and does **not** roll back the claim
- `reschedule` → patch `nextFollowUpAt`
- `stop` → `sequenceStatus: "stopped"` with the verdict's reason, clear `nextFollowUpAt`
- `exhaust` → `sequenceStatus: "exhausted"`, clear `nextFollowUpAt` (this is the hot-band terminal state; it does **not** archive)
- `archive` → call Task 5's internal archive core with reason `no_response`, then `sequenceStatus: "stopped"`, `stoppedReason: "archived"`

**`sweepLeadSequence` (internalAction).** Ranges `by_sequence_due` on `("running", <= now)`, takes a bounded slice, and schedules one `sendSequenceStep` per row. Per-row isolation: one bad lead must never strand the rest of the slice.

- [ ] **Step 1: Write the failing tests.** At minimum:
  - a due lead sends exactly one template, and `followUpsSent` becomes 1
  - **a second concurrent claim returns `false` and sends nothing** (the duplicate-send guard)
  - a provider failure after a successful claim does **not** re-send on the next sweep — the rung is already booked
  - the daily cap refuses and reschedules rather than sending
  - a warm lead past its last step archives; a hot lead past its last step **exhausts and is not archived**
  - a disabled config stops rather than sending, even with a due row already queued
  - the sweep is bounded and one throwing row does not stop the others

  Use the repo's `CONVEX_AI_DRY_RUN` convention or an equivalent so **no test ever reaches a real provider**. Verify how `metaSend` behaves under dry run before relying on it.

- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and watch them pass, then `npm test` + `npm run typecheck`.**
- [ ] **Step 5: Commit.**

---

### Task 9: Cron, preview, manual stop

**Files:** Modify `convex/crons.ts`, `convex/cronSchedules.ts`, `convex/lib/cronSummary.ts`, `convex/leadAnalysis.ts` + tests

**The three-file cron sync.** `convex/cronSchedules.test.ts` already asserts `CRON_REGISTRY` matches `crons.ts`. Register `lead-sequence` at **15 minutes** in all three, with `crons.ts` pointing at the `cronSchedules.ts` wrapper (not the engine directly) so each run stamps a `cronRuns` row.

**`sequencePreview` (accountQuery, supervisor+).** The spec calls for a "who would be messaged in the next 7 days" list, to be run **before** enabling. It must:
- work with the feature **disabled** — its entire purpose is to be run before you turn it on, so it must not be gated on `enabled`
- evaluate the same `evaluateSequence` chain with `enabled` forced true, so the preview reflects the real cadence rather than a second implementation
- return, per lead: contact, band, which step, the projected send time, and the template name
- be bounded by an explicit `.take()`
- surface the fail-closed conditions loudly — if working hours are unset, or a step's template is missing or unapproved, the preview must say so rather than showing a send that will never happen

**`stopSequence` (accountMutation, supervisor+).** Lets a human take a lead out of the sequence: `sequenceStatus: "stopped"`, `stoppedReason: "manual"`, clear `nextFollowUpAt`.

- [ ] **Step 1: Write the failing tests** — the cron sync test will fail if the three files disagree; preview returns projected sends with the feature off; preview flags unset working hours; preview flags an unapproved template; `stopSequence` is denied to an agent.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `npx vitest run convex/cronSchedules.test.ts convex/lib/cronSummary.test.ts`, then `npm test` + `npm run typecheck`.**
- [ ] **Step 5: Commit.**

---

### Task 10: The config UI

**Files:** the settings section registry, a new settings component + test, `messages/en.json`

Admin-only, mirroring how the existing AI/qualification settings sections are registered and gated. Read one of those first and follow it.

It must expose: the master `enabled` toggle; `idleDaysBeforeSequence`, `humanQuietHours`, `dailySendCap`; and per band the step list — each step's `delayDays` and its **template picked from the account's APPROVED templates**, not free text. `autoArchive` per band is shown but hot's is fixed off, with the reason stated.

**Three things the UI must make impossible to get wrong**, because they are the ways this feature silently does nothing or does harm:

1. **`enabled` cannot be turned on while any enabled band has a step with no template** — that step would stop every lead that reaches it with `template_unavailable`. Block it at save time in `updateConfig` too, not only in the UI; the UI is not the security or correctness boundary.
2. **If working hours are unset in `qualificationConfigs`, say so prominently and state that nothing will send.** This is the owner's fail-closed decision and its most confusing consequence — a feature that looks configured but sends nothing. Link to where hours are set.
3. **Show the preview before enabling.** Wire Task 9's `sequencePreview` into this screen so the admin sees exactly who gets messaged in the next 7 days, with counts, before the toggle goes on.

- [ ] **Step 1: Add the i18n strings** to `messages/en.json`, merging into existing blocks rather than creating duplicates.
- [ ] **Step 2: Write the failing component test.** **Every assertion must be scoped to a `data-testid`** via `textByTestId` — the component will render band names, step labels and template names in several places, so a bare `toContain` is vacuous by construction. Pin: the unset-working-hours warning renders when hours are absent; the enable toggle is disabled when a step lacks a template; the preview count renders.
- [ ] **Step 3: Run and watch it fail.**
- [ ] **Step 4: Implement the component and register the settings section.**
- [ ] **Step 5: Add the save-time guard in `updateConfig`** rejecting `enabled: true` when any band step has an empty `templateName`, with a test.
- [ ] **Step 6: `npm test`, `npm run typecheck`, `npx eslint` on the changed files.**
- [ ] **Step 7: Commit.**

---

## Deployment (owner-run, after all tasks land)

1. **Deploy.** One new table (`leadSequenceSendRate`) and one new cron. Additive; no migration.
2. **The feature stays OFF.** `leadAnalysisConfigs.enabled` still defaults false, and P3 adds a second lock: `updateConfig` refuses `enabled: true` until every band step has an approved template.
3. **Before enabling, in order:**
   - confirm working hours are set in `qualificationConfigs` — **without them nothing sends, by design**
   - create and get Meta approval for the follow-up templates
   - assign a template to each band step
   - **run the preview** and read the list of who would be messaged in the next 7 days
   - set `dailySendCap` low for the first week
4. **After enabling, watch:** `cronRuns` for `lead-sequence` failures; `messages` for sends with `senderType: "bot"`; the WhatsApp quality rating in Meta Business Manager; and the count of leads landing in `stopped` with `template_unavailable`.

## Risks

| Risk | Mitigation |
|---|---|
| **A duplicate marketing message to a customer** | Claim-before-send with the next rung booked first — at-most-once by construction, mirroring `qualificationEngine`. Pinned by a concurrent-claim test. |
| **Sends continue after the owner disables the feature** | Gate 1 is evaluated in the send-time verdict, not only at arming — the exact bug P1 shipped and had to fix in its scoring sweep. Pinned by a test with a due row and a disabled config. |
| **Messages at 3am** | Working hours are fail-closed: unknown ⇒ stop, never a default. |
| **Meta quality rating damage** | Daily cap; sends only to leads who went quiet on *us*; hot leads never auto-archived; every send visible in-thread; a rejected template stops the lead loudly. |
| **A rejected template silently stalls every lead** | Gate 12 stops with `template_unavailable`, which is surfaced in the UI rather than retried forever. |
| **The gate chain drifts from the spec** | The chain is one pure function with a test per gate; the verdict query holds no policy of its own. |
| **Auto-archive breaks P2's mirror invariant** | Task 5 extracts a single shared core; the schema comment is updated to name it. |

## What P3 deliberately does not do

Bulk actions, template sending from the board, and the richer board surfaces are **P4**. P3 adds no scoring behaviour and does not change how leads are scored or archived manually.
