# Lead Analysis P1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Score every conversation 1–10 with the account's LLM and render a read-only, filterable, score-sorted Lead Analysis board.

**Architecture:** A new `leadAnalyses` table holds one row per conversation. `ingest` debounces a re-score request onto it; a 5-minute cron claims due rows under a lease, calls the account's BYO LLM, and writes back score + reason + signals. When nothing is due, the same cron backfills historical conversations using a per-account cursor so it walks the account exactly once. The board is a single account-scoped query. All scoring math, banding, lane derivation, and prompt parsing live as pure functions in `convex/lib/leadAnalysis/`, unit-tested with no database.

**Tech Stack:** Convex (queries/mutations/actions/crons), TypeScript, Vitest + convex-test, Next.js App Router, next-intl, shadcn/ui, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-26-lead-analysis-design.md`

## Global Constraints

- **Never run `convex deploy`, `convex dev`, or `convex codegen`.** The deployment is self-hosted production; the owner deploys. Schema edits are committed only.
- **`convex/_generated/api.d.ts` is edited BY HAND.** It is tracked in git and, because codegen is forbidden above, every new file under `convex/` must be registered there manually or it will not typecheck. It is two alphabetically-sorted lists (an import block and the `fullApi` map); Tasks 3, 4, and 5 each add their own entries with the exact lines given. Owner-approved 2026-07-26. Do not reorder or reformat anything else in that file.
- **Verify commands:** `npm test` (full suite), `npx vitest run <path>` (one file), `npm run typecheck`, `npx eslint <path>`. This repo has pre-existing lint debt — `npm run lint` over the whole tree is NOT the gate; lint only the files you changed.
- **Never `git add -A` or `git add .`** — untracked `amani-ai-agent/*.md` and `.superpowers/` are present, and a concurrent session has unrelated uncommitted work in `convex/conversations.ts` and `src/components/inbox/*`. Stage exact paths only, and never stage a file this task did not change.
- **Read-only P1.** No archiving, no template sends, no outbound messages of any kind. `sequenceStatus` fields are written to schema but only ever hold `"idle"` in P1.
- **Dormant by default.** `leadAnalysisConfigs.enabled` defaults to `false`. Every engine entry point returns early when unset or disabled, so deploying P1 changes nothing user-visible.
- **No unbounded reads.** Every query is an index range with an explicit `.take()`. Never `.filter()` across a partition that grows forever — see the index comments in `convex/schema.ts`.
- **Dedup key is `scoredThroughMs`, NOT a message count.** Owner decision 2026-07-26, after Task 7's review found that a count derived from a `.take(TRANSCRIPT_LIMIT)` slice saturates at 40 and permanently freezes the score on any longer conversation. The key is the `_creationTime` of the newest message at scoring time; "unchanged" means that timestamp has not moved. Tasks 4/6/7 shipped the old field and were amended in place — any task text below still naming `scoredMessageCount`/`messageCount` is superseded by this constraint.
- **Score is an integer 1–10.** Clamp and round at the parse boundary; never trust the model's number.
- **Tenancy:** every table carries `accountId`; every handler uses `ctx.accountId` from `accountQuery`/`accountMutation` and never a client-supplied account id.
- **Tests:** `npx vitest run <path>` for a file. Convex tests set `const modules = import.meta.glob("/convex/**/*.ts")`.
- **Git:** stage paths explicitly (`git add <path>`), never `git add -A` — concurrent sessions share this working tree.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

**Create — pure logic (no I/O, no `Date.now()`):**

| File | Responsibility |
|---|---|
| `convex/lib/leadAnalysis/bands.ts` | score clamping, score → band lookup |
| `convex/lib/leadAnalysis/defaults.ts` | `defaultLeadAnalysisConfig()` — the approved defaults |
| `convex/lib/leadAnalysis/priority.ts` | lane derivation + the board sort comparator |
| `convex/lib/leadAnalysis/prompt.ts` | prompt construction, strict-JSON parse/validate |
| plus a `.test.ts` beside each | |

**Create — Convex functions:**

| File | Responsibility |
|---|---|
| `convex/leadAnalysis.ts` | account-scoped: `board`, `reanalyze`, `getConfig`, `updateConfig` |
| `convex/leadAnalysisEngine.ts` | internal: inbound hook, claim/apply/fail, backfill, `sweepScoring` action |
| `convex/leadAnalysis.test.ts`, `convex/leadAnalysisEngine.test.ts` | convex-test coverage |

**Create — UI:**

| File | Responsibility |
|---|---|
| `src/app/(dashboard)/lead-analysis/page.tsx` | thin data wrapper (mirrors `leads/page.tsx`) |
| `src/components/lead-analysis/lead-analysis-board.tsx` | presentational board |
| `src/components/lead-analysis/lead-analysis-board.test.tsx` | component test |

**Modify:**

| File | Change |
|---|---|
| `convex/schema.ts` | add `leadAnalyses`, `leadAnalysisConfigs`; add `"score"` to `aiUsageLog.mode` |
| `convex/ingest.ts` | one `runBestEffort` hook after the `qualificationEngine.onInbound` block (~line 681) |
| `convex/crons.ts` | register `lead-scoring` |
| `convex/cronSchedules.ts` | add the `runSweepLeadScoring` wrapper |
| `convex/lib/cronSummary.ts` | add `lead-scoring` to `CRON_REGISTRY` |
| `messages/en.json` | `LeadAnalysis.*` strings |
| sidebar nav component | add the Lead Analysis link |

---

### Task 1: Bands and defaults (pure)

**Files:**
- Create: `convex/lib/leadAnalysis/bands.ts`
- Create: `convex/lib/leadAnalysis/bands.test.ts`
- Create: `convex/lib/leadAnalysis/defaults.ts`
- Create: `convex/lib/leadAnalysis/defaults.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type LeadBand = "hot" | "warm" | "cold"`; `interface BandStep { delayDays: number; templateName: string; templateLanguage?: string }`; `interface BandRule { key: LeadBand; minScore: number; maxScore: number; autoArchive: boolean; steps: BandStep[] }`; `clampScore(raw: number): number`; `bandForScore(score: number, bands: BandRule[]): LeadBand | null`; `defaultLeadAnalysisConfig(): LeadAnalysisConfigDefaults`.

- [ ] **Step 1: Write the failing test for bands**

Create `convex/lib/leadAnalysis/bands.test.ts`:

```ts
import { expect, test } from "vitest";
import { bandForScore, clampScore, type BandRule } from "./bands";

const BANDS: BandRule[] = [
  { key: "hot", minScore: 8, maxScore: 10, autoArchive: false, steps: [] },
  { key: "warm", minScore: 4, maxScore: 7, autoArchive: true, steps: [] },
  { key: "cold", minScore: 1, maxScore: 3, autoArchive: true, steps: [] },
];

test("clampScore rounds to an integer", () => {
  expect(clampScore(7.4)).toBe(7);
  expect(clampScore(7.5)).toBe(8);
});

test("clampScore pins out-of-range values into 1..10", () => {
  expect(clampScore(0)).toBe(1);
  expect(clampScore(-3)).toBe(1);
  expect(clampScore(11)).toBe(10);
  expect(clampScore(99)).toBe(10);
});

test("clampScore rejects non-finite input by returning the floor", () => {
  expect(clampScore(Number.NaN)).toBe(1);
  expect(clampScore(Number.POSITIVE_INFINITY)).toBe(10);
});

test("bandForScore maps each band's interior", () => {
  expect(bandForScore(9, BANDS)).toBe("hot");
  expect(bandForScore(5, BANDS)).toBe("warm");
  expect(bandForScore(2, BANDS)).toBe("cold");
});

test("bandForScore is inclusive at both boundaries", () => {
  expect(bandForScore(8, BANDS)).toBe("hot");
  expect(bandForScore(10, BANDS)).toBe("hot");
  expect(bandForScore(7, BANDS)).toBe("warm");
  expect(bandForScore(4, BANDS)).toBe("warm");
  expect(bandForScore(3, BANDS)).toBe("cold");
  expect(bandForScore(1, BANDS)).toBe("cold");
});

test("bandForScore returns null when no rule covers the score", () => {
  expect(bandForScore(5, [BANDS[0]])).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/lib/leadAnalysis/bands.test.ts`
Expected: FAIL — `Failed to resolve import "./bands"`.

- [ ] **Step 3: Implement `bands.ts`**

Create `convex/lib/leadAnalysis/bands.ts`:

```ts
// ============================================================
// Pure banding math for Lead Analysis. No I/O, no Date.now() — the
// board and the engine both route every score through here so a band
// can never be computed two different ways.
// ============================================================

export type LeadBand = "hot" | "warm" | "cold";

export interface BandStep {
  delayDays: number;
  templateName: string;
  templateLanguage?: string;
}

export interface BandRule {
  key: LeadBand;
  minScore: number;
  maxScore: number;
  autoArchive: boolean;
  steps: BandStep[];
}

export const MIN_SCORE = 1;
export const MAX_SCORE = 10;

/**
 * Coerce a model-supplied number into a trustworthy integer score.
 * The model is never trusted: NaN floors to MIN_SCORE, Infinity caps at
 * MAX_SCORE, and everything else rounds then clamps.
 */
export function clampScore(raw: number): number {
  if (Number.isNaN(raw)) return MIN_SCORE;
  const rounded = Math.round(raw);
  if (rounded < MIN_SCORE) return MIN_SCORE;
  if (rounded > MAX_SCORE) return MAX_SCORE;
  return rounded;
}

/** The band whose inclusive [minScore, maxScore] covers `score`. */
export function bandForScore(score: number, bands: BandRule[]): LeadBand | null {
  const hit = bands.find((b) => score >= b.minScore && score <= b.maxScore);
  return hit ? hit.key : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/lib/leadAnalysis/bands.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing test for defaults**

Create `convex/lib/leadAnalysis/defaults.test.ts`:

```ts
import { expect, test } from "vitest";
import { defaultLeadAnalysisConfig } from "./defaults";
import { bandForScore } from "./bands";

test("ships dormant", () => {
  expect(defaultLeadAnalysisConfig().enabled).toBe(false);
});

test("carries the approved scoring defaults", () => {
  const c = defaultLeadAnalysisConfig();
  expect(c.rescoreDebounceMinutes).toBe(10);
  expect(c.scorePerRun).toBe(25);
  expect(c.backfillEnabled).toBe(true);
  expect(c.backfillPerRun).toBe(10);
});

test("carries the approved sequence defaults", () => {
  const c = defaultLeadAnalysisConfig();
  expect(c.idleDaysBeforeSequence).toBe(3);
  expect(c.humanQuietHours).toBe(24);
  expect(c.dailySendCap).toBe(100);
  expect(c.agedOutDays).toBe(120);
});

test("every score in 1..10 maps to exactly one default band", () => {
  const { bands } = defaultLeadAnalysisConfig();
  for (let s = 1; s <= 10; s++) {
    expect(bandForScore(s, bands)).not.toBeNull();
  }
});

test("default step counts match the approved cadence", () => {
  const { bands } = defaultLeadAnalysisConfig();
  const byKey = Object.fromEntries(bands.map((b) => [b.key, b]));
  expect(byKey.hot.steps.map((s) => s.delayDays)).toEqual([2, 5, 10]);
  expect(byKey.warm.steps.map((s) => s.delayDays)).toEqual([3, 7]);
  expect(byKey.cold.steps.map((s) => s.delayDays)).toEqual([5]);
});

test("hot leads are never auto-archived", () => {
  const { bands } = defaultLeadAnalysisConfig();
  const byKey = Object.fromEntries(bands.map((b) => [b.key, b]));
  expect(byKey.hot.autoArchive).toBe(false);
  expect(byKey.warm.autoArchive).toBe(true);
  expect(byKey.cold.autoArchive).toBe(true);
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run convex/lib/leadAnalysis/defaults.test.ts`
Expected: FAIL — `Failed to resolve import "./defaults"`.

- [ ] **Step 7: Implement `defaults.ts`**

Create `convex/lib/leadAnalysis/defaults.ts`:

```ts
import type { BandRule } from "./bands";

// ============================================================
// The seeded Lead Analysis config (spec "Approved defaults"). Mirrors
// `lib/qualification/defaults.ts`: a pure factory the config CRUD falls
// back to until an admin persists a row, so the feature is fully
// described in code rather than half in the database.
//
// `templateName` is intentionally EMPTY on every step. P1 never sends,
// and P3's config UI forces the admin to pick a real approved template
// before the sequence can be enabled — an empty name is the "not
// configured yet" marker, never a send.
// ============================================================

export interface LeadAnalysisConfigDefaults {
  enabled: boolean;
  rescoreDebounceMinutes: number;
  scorePerRun: number;
  backfillEnabled: boolean;
  backfillPerRun: number;
  idleDaysBeforeSequence: number;
  humanQuietHours: number;
  dailySendCap: number;
  agedOutDays: number;
  bands: BandRule[];
}

export function defaultLeadAnalysisConfig(): LeadAnalysisConfigDefaults {
  return {
    enabled: false,
    rescoreDebounceMinutes: 10,
    scorePerRun: 25,
    backfillEnabled: true,
    backfillPerRun: 10,
    idleDaysBeforeSequence: 3,
    humanQuietHours: 24,
    dailySendCap: 100,
    agedOutDays: 120,
    bands: [
      {
        key: "hot",
        minScore: 8,
        maxScore: 10,
        autoArchive: false,
        steps: [
          { delayDays: 2, templateName: "" },
          { delayDays: 5, templateName: "" },
          { delayDays: 10, templateName: "" },
        ],
      },
      {
        key: "warm",
        minScore: 4,
        maxScore: 7,
        autoArchive: true,
        steps: [
          { delayDays: 3, templateName: "" },
          { delayDays: 7, templateName: "" },
        ],
      },
      {
        key: "cold",
        minScore: 1,
        maxScore: 3,
        autoArchive: true,
        steps: [{ delayDays: 5, templateName: "" }],
      },
    ],
  };
}
```

- [ ] **Step 8: Run both test files to verify they pass**

Run: `npx vitest run convex/lib/leadAnalysis/`
Expected: PASS, 12 tests across 2 files.

- [ ] **Step 9: Commit**

```bash
git add convex/lib/leadAnalysis/bands.ts convex/lib/leadAnalysis/bands.test.ts convex/lib/leadAnalysis/defaults.ts convex/lib/leadAnalysis/defaults.test.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): pure band math and seeded defaults

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Lane derivation and board sort (pure)

**Files:**
- Create: `convex/lib/leadAnalysis/priority.ts`
- Create: `convex/lib/leadAnalysis/priority.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `type LeadLane = "awaiting_us" | "awaiting_them"`; `leadLane(lastSenderType: "customer" | "agent" | "bot" | null): LeadLane`; `interface PriorityInput { score: number | null; lane: LeadLane; lastMessageAt: number | null }`; `comparePriority(a: PriorityInput, b: PriorityInput): number`.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/leadAnalysis/priority.test.ts`:

```ts
import { expect, test } from "vitest";
import { comparePriority, leadLane, type PriorityInput } from "./priority";

test("a customer's last message means they are awaiting us", () => {
  expect(leadLane("customer")).toBe("awaiting_us");
});

test("our last message — agent or bot — means we are awaiting them", () => {
  expect(leadLane("agent")).toBe("awaiting_them");
  expect(leadLane("bot")).toBe("awaiting_them");
});

test("a thread with no messages is treated as awaiting us", () => {
  expect(leadLane(null)).toBe("awaiting_us");
});

const row = (p: Partial<PriorityInput>): PriorityInput => ({
  score: 5,
  lane: "awaiting_them",
  lastMessageAt: 1000,
  ...p,
});

test("higher score sorts first", () => {
  expect(comparePriority(row({ score: 9 }), row({ score: 4 }))).toBeLessThan(0);
});

test("an unscored lead sorts after every scored lead", () => {
  expect(comparePriority(row({ score: null }), row({ score: 1 }))).toBeGreaterThan(0);
});

test("at equal score, awaiting-us sorts before awaiting-them", () => {
  const us = row({ lane: "awaiting_us" });
  const them = row({ lane: "awaiting_them" });
  expect(comparePriority(us, them)).toBeLessThan(0);
});

test("at equal score and lane, the more recent sorts first", () => {
  const newer = row({ lastMessageAt: 5000 });
  const older = row({ lastMessageAt: 1000 });
  expect(comparePriority(newer, older)).toBeLessThan(0);
});

test("a null lastMessageAt sorts last within its group", () => {
  expect(comparePriority(row({ lastMessageAt: null }), row({ lastMessageAt: 1 })))
    .toBeGreaterThan(0);
});

test("sorting a mixed list produces the documented order", () => {
  const rows: (PriorityInput & { id: string })[] = [
    { id: "cold-old", score: 2, lane: "awaiting_them", lastMessageAt: 10 },
    { id: "hot-waiting", score: 9, lane: "awaiting_us", lastMessageAt: 10 },
    { id: "hot-quiet", score: 9, lane: "awaiting_them", lastMessageAt: 99 },
    { id: "unscored", score: null, lane: "awaiting_us", lastMessageAt: 99 },
  ];
  const order = [...rows].sort(comparePriority).map((r) => r.id);
  expect(order).toEqual(["hot-waiting", "hot-quiet", "cold-old", "unscored"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/lib/leadAnalysis/priority.test.ts`
Expected: FAIL — `Failed to resolve import "./priority"`.

- [ ] **Step 3: Implement `priority.ts`**

Create `convex/lib/leadAnalysis/priority.ts`:

```ts
// ============================================================
// Lane derivation + the board's sort key. Both are PURE and computed at
// read time, never stored: a lead going stale must change position with
// no LLM call and no write. `leadLane` is the safety primitive the whole
// automation rests on — a customer waiting on US is never sequenced and
// never archived (see the spec's Principle section).
// ============================================================

export type LeadLane = "awaiting_us" | "awaiting_them";

/**
 * Who owes the next message. A thread with no messages at all is
 * conservatively "awaiting us" — the lane that is never automated
 * against — so an unexpected empty thread can never be nudged.
 */
export function leadLane(
  lastSenderType: "customer" | "agent" | "bot" | null,
): LeadLane {
  return lastSenderType === "customer" || lastSenderType === null
    ? "awaiting_us"
    : "awaiting_them";
}

export interface PriorityInput {
  score: number | null;
  lane: LeadLane;
  lastMessageAt: number | null;
}

const LANE_RANK: Record<LeadLane, number> = {
  awaiting_us: 0,
  awaiting_them: 1,
};

/**
 * Board order: score desc (unscored last), then awaiting-us first, then
 * most recent activity first. Usable directly as an Array#sort
 * comparator.
 */
export function comparePriority(a: PriorityInput, b: PriorityInput): number {
  // -1 sorts an unscored lead below score 1 without special-casing.
  const byScore = (b.score ?? -1) - (a.score ?? -1);
  if (byScore !== 0) return byScore;

  const byLane = LANE_RANK[a.lane] - LANE_RANK[b.lane];
  if (byLane !== 0) return byLane;

  return (b.lastMessageAt ?? -1) - (a.lastMessageAt ?? -1);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/lib/leadAnalysis/priority.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/leadAnalysis/priority.ts convex/lib/leadAnalysis/priority.test.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): lane derivation and board sort comparator

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Prompt construction and strict-JSON parsing (pure)

**Files:**
- Create: `convex/lib/leadAnalysis/prompt.ts`
- Create: `convex/lib/leadAnalysis/prompt.test.ts`

**Interfaces:**
- Consumes: `clampScore` from `./bands` (Task 1).
- Produces: `SIGNAL_VOCABULARY: readonly string[]`; `interface ScorePromptInput { serviceName: string | null; services: string[]; contact: { name?: string; travelDates?: string; travelers?: string; budget?: string; preferredDestination?: string } }`; `buildScoreSystemPrompt(input: ScorePromptInput): string`; `interface ParsedScore { score: number; reason: string; signals: string[] }`; `parseScoreResponse(raw: string): ParsedScore | null`.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/leadAnalysis/prompt.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  buildScoreSystemPrompt,
  parseScoreResponse,
  SIGNAL_VOCABULARY,
} from "./prompt";

test("the prompt states the 1-10 range and demands JSON only", () => {
  const p = buildScoreSystemPrompt({ serviceName: null, services: [], contact: {} });
  expect(p).toContain("1");
  expect(p).toContain("10");
  expect(p).toMatch(/JSON/i);
});

test("the prompt lists every allowed signal", () => {
  const p = buildScoreSystemPrompt({ serviceName: null, services: [], contact: {} });
  for (const s of SIGNAL_VOCABULARY) expect(p).toContain(s);
});

test("the prompt includes the matched service and the service catalogue", () => {
  const p = buildScoreSystemPrompt({
    serviceName: "UAE Visa",
    services: ["UAE Visa", "Holiday Packages"],
    contact: {},
  });
  expect(p).toContain("UAE Visa");
  expect(p).toContain("Holiday Packages");
});

test("the prompt includes known contact profile detail", () => {
  const p = buildScoreSystemPrompt({
    serviceName: null,
    services: [],
    contact: { name: "Asha", budget: "AED 3000", travelers: "2 adults" },
  });
  expect(p).toContain("Asha");
  expect(p).toContain("AED 3000");
  expect(p).toContain("2 adults");
});

test("the prompt omits absent profile fields rather than printing empties", () => {
  const p = buildScoreSystemPrompt({ serviceName: null, services: [], contact: {} });
  expect(p).not.toContain("undefined");
  expect(p).not.toContain("null");
});

test("parses a clean JSON response", () => {
  const parsed = parseScoreResponse(
    '{"score":8,"reason":"Gave dates and budget","signals":["dates_given","budget_given"]}',
  );
  expect(parsed).toEqual({
    score: 8,
    reason: "Gave dates and budget",
    signals: ["dates_given", "budget_given"],
  });
});

test("parses a response wrapped in a fenced code block", () => {
  const parsed = parseScoreResponse(
    '```json\n{"score":3,"reason":"Just browsing","signals":[]}\n```',
  );
  expect(parsed?.score).toBe(3);
});

test("parses JSON embedded in surrounding prose", () => {
  const parsed = parseScoreResponse(
    'Here is my assessment: {"score":5,"reason":"Unclear","signals":[]} Hope that helps.',
  );
  expect(parsed?.score).toBe(5);
});

test("clamps an out-of-range score instead of rejecting the response", () => {
  expect(parseScoreResponse('{"score":42,"reason":"x","signals":[]}')?.score).toBe(10);
  expect(parseScoreResponse('{"score":0,"reason":"x","signals":[]}')?.score).toBe(1);
});

test("accepts a numeric score delivered as a string", () => {
  expect(parseScoreResponse('{"score":"7","reason":"x","signals":[]}')?.score).toBe(7);
});

test("drops signals outside the vocabulary", () => {
  const parsed = parseScoreResponse(
    '{"score":6,"reason":"x","signals":["budget_given","totally_made_up"]}',
  );
  expect(parsed?.signals).toEqual(["budget_given"]);
});

test("de-duplicates repeated signals", () => {
  const parsed = parseScoreResponse(
    '{"score":6,"reason":"x","signals":["ghosted","ghosted"]}',
  );
  expect(parsed?.signals).toEqual(["ghosted"]);
});

test("tolerates a missing signals array", () => {
  expect(parseScoreResponse('{"score":6,"reason":"x"}')?.signals).toEqual([]);
});

test("truncates an overlong reason", () => {
  const parsed = parseScoreResponse(
    `{"score":6,"reason":"${"x".repeat(500)}","signals":[]}`,
  );
  expect(parsed!.reason.length).toBeLessThanOrEqual(240);
});

test("returns null for unparseable or structurally wrong output", () => {
  expect(parseScoreResponse("I cannot score this conversation.")).toBeNull();
  expect(parseScoreResponse("")).toBeNull();
  expect(parseScoreResponse('{"reason":"no score","signals":[]}')).toBeNull();
  expect(parseScoreResponse('{"score":"high","reason":"x","signals":[]}')).toBeNull();
  expect(parseScoreResponse('{"score":7,"signals":[]}')).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/lib/leadAnalysis/prompt.test.ts`
Expected: FAIL — `Failed to resolve import "./prompt"`.

- [ ] **Step 3: Implement `prompt.ts`**

Create `convex/lib/leadAnalysis/prompt.ts`:

```ts
import { clampScore } from "./bands";

// ============================================================
// Scoring prompt + response parsing. Pure and separately testable
// because the parse boundary is where an unreliable model meets a typed
// database: the score is clamped, the reason is truncated, and signals
// are intersected with a closed vocabulary, so nothing the model invents
// can reach the schema.
// ============================================================

/** The closed signal set. Anything else the model emits is discarded. */
export const SIGNAL_VOCABULARY = [
  "budget_given",
  "dates_given",
  "travelers_given",
  "destination_given",
  "ready_to_book",
  "price_shopping",
  "wrong_service",
  "unresponsive",
  "ghosted",
  "complaint",
  "spam",
] as const;

const REASON_MAX_CHARS = 240;

export interface ScorePromptInput {
  serviceName: string | null;
  services: string[];
  contact: {
    name?: string;
    travelDates?: string;
    travelers?: string;
    budget?: string;
    preferredDestination?: string;
  };
}

export function buildScoreSystemPrompt(input: ScorePromptInput): string {
  const profile: string[] = [];
  const { contact } = input;
  if (contact.name) profile.push(`Name: ${contact.name}`);
  if (contact.preferredDestination) profile.push(`Destination: ${contact.preferredDestination}`);
  if (contact.travelDates) profile.push(`Travel dates: ${contact.travelDates}`);
  if (contact.travelers) profile.push(`Travellers: ${contact.travelers}`);
  if (contact.budget) profile.push(`Budget: ${contact.budget}`);

  const sections = [
    "You score sales leads for a travel agency that talks to customers on WhatsApp.",
    "You will be shown a conversation transcript. Judge how worth chasing this lead is.",
    "",
    "Score from 1 to 10:",
    "  9-10 — ready to book: explicit intent, concrete dates or budget, asking how to pay.",
    "  6-8  — genuine enquiry with real detail, still deciding.",
    "  4-5  — vague interest, little detail, or only price questions.",
    "  2-3  — browsing, one-line enquiry, or long silence after our reply.",
    "  1    — wrong service, spam, or clearly not a customer.",
    "",
    "Judge intent, fit, and specificity. Do NOT reward long conversations on their own —",
    "a short message with dates and a budget outranks a long one with neither.",
  ];

  if (input.serviceName) {
    sections.push("", `The customer is enquiring about: ${input.serviceName}`);
  }
  if (input.services.length > 0) {
    sections.push(`Services this agency sells: ${input.services.join(", ")}`);
  }
  if (profile.length > 0) {
    sections.push("", "Known details about this customer:", ...profile.map((p) => `  ${p}`));
  }

  sections.push(
    "",
    `Allowed signals (use only these): ${SIGNAL_VOCABULARY.join(", ")}`,
    "",
    "Reply with JSON ONLY, no prose and no code fence:",
    '{"score": <1-10>, "reason": "<one short sentence>", "signals": ["<signal>", ...]}',
  );

  return sections.join("\n");
}

export interface ParsedScore {
  score: number;
  reason: string;
  signals: string[];
}

/** Pull the first balanced JSON object out of arbitrary model output. */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

export function parseScoreResponse(raw: string): ParsedScore | null {
  const json = extractJsonObject(raw ?? "");
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Accept a number or a numeric string; reject anything else outright —
  // a missing or non-numeric score means the model did not do the task.
  const rawScore =
    typeof obj.score === "number"
      ? obj.score
      : typeof obj.score === "string" && obj.score.trim() !== ""
        ? Number(obj.score)
        : Number.NaN;
  if (!Number.isFinite(rawScore)) return null;

  if (typeof obj.reason !== "string" || obj.reason.trim() === "") return null;

  const allowed = new Set<string>(SIGNAL_VOCABULARY);
  const signals = Array.isArray(obj.signals)
    ? [...new Set(obj.signals.filter((s): s is string => typeof s === "string" && allowed.has(s)))]
    : [];

  return {
    score: clampScore(rawScore),
    reason: obj.reason.trim().slice(0, REASON_MAX_CHARS),
    signals,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/lib/leadAnalysis/prompt.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Register the four lib modules in the generated API types**

`convex/_generated/api.d.ts` is TRACKED IN GIT and is a mechanical two-list file. `convex codegen` must NOT be run in this repo (self-hosted production deployment), so the entries are added by hand. They are deterministic — the owner's next real `convex deploy` regenerates this file identically.

All four lib files exist as of this task, so they are registered together here.

In the **import block**, between `import type * as lib_kb_types …` (line ~85) and `import type * as lib_leadCharge …` (line ~86), insert:

```ts
import type * as lib_leadAnalysis_bands from "../lib/leadAnalysis/bands.js";
import type * as lib_leadAnalysis_defaults from "../lib/leadAnalysis/defaults.js";
import type * as lib_leadAnalysis_priority from "../lib/leadAnalysis/priority.js";
import type * as lib_leadAnalysis_prompt from "../lib/leadAnalysis/prompt.js";
```

In the **`fullApi` map**, between `"lib/kb/types": typeof lib_kb_types;` (line ~214) and `"lib/leadCharge": typeof lib_leadCharge;` (line ~215), insert:

```ts
  "lib/leadAnalysis/bands": typeof lib_leadAnalysis_bands;
  "lib/leadAnalysis/defaults": typeof lib_leadAnalysis_defaults;
  "lib/leadAnalysis/priority": typeof lib_leadAnalysis_priority;
  "lib/leadAnalysis/prompt": typeof lib_leadAnalysis_prompt;
```

Both lists are alphabetical by identifier (`lib_leadA…` sorts before `lib_leadC…`). Do not reorder anything else.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add convex/lib/leadAnalysis/prompt.ts convex/lib/leadAnalysis/prompt.test.ts convex/_generated/api.d.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): scoring prompt and strict-JSON response parsing

The parse boundary clamps the score, truncates the reason, and
intersects signals with a closed vocabulary, so nothing the model
invents can reach the schema.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Schema tables and config CRUD

**Files:**
- Modify: `convex/schema.ts` (append two tables before the closing `});`; widen `aiUsageLog.mode`)
- Create: `convex/leadAnalysis.ts`
- Create: `convex/leadAnalysis.test.ts`

**Interfaces:**
- Consumes: `defaultLeadAnalysisConfig()` from `./lib/leadAnalysis/defaults` (Task 1).
- Produces: tables `leadAnalyses`, `leadAnalysisConfigs`; `api.leadAnalysis.getConfig`, `api.leadAnalysis.updateConfig`.

- [ ] **Step 1: Add `"score"` to the `aiUsageLog.mode` union**

In `convex/schema.ts`, inside `aiUsageLog`, change the `mode` union to include the new literal:

```ts
    mode: v.union(
      v.literal("auto_reply"),
      v.literal("draft"),
      v.literal("classify"),
      v.literal("qualify"),
      v.literal("checklist"),
      // Lead Analysis scoring (spec 2026-07-26-lead-analysis).
      v.literal("score"),
    ),
```

- [ ] **Step 2: Add the two new tables**

In `convex/schema.ts`, immediately before the final `});`, add:

```ts
  // ============================================================
  // Lead Analysis (spec: docs/superpowers/specs/
  // 2026-07-26-lead-analysis-design.md). One row per conversation;
  // `by_conversation` doubles as the 1:1 enforcing index (a single
  // upsert path), mirroring `qualificationSessions`.
  //
  // `by_score_due` and `by_sequence_due` are partitioned cron ranges,
  // the same shape as `qualificationSessions.by_due` and
  // `conversionEvents.by_status`: each sweep reads only its own
  // partition, and a row that gives up LEAVES that partition
  // ("failed" / "stopped") rather than accumulating in front of the
  // rows the sweep still wants. `scoreStatus` is bound before
  // `rescoreDueAt` so the due test is a genuine range, never a
  // post-index `.filter()` — see this file's `broadcastRecipients`
  // comment for what that filter costs once dead rows pile up.
  //
  // P1 writes only `sequenceStatus: "idle"`; the sequence fields exist
  // now so P3 adds no second schema deploy.
  // ============================================================
  leadAnalyses: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),

    score: v.optional(v.number()), // 1–10, absent until first scored
    band: v.optional(
      v.union(v.literal("hot"), v.literal("warm"), v.literal("cold")),
    ),
    reason: v.optional(v.string()),
    signals: v.optional(v.array(v.string())),
    scoredAt: v.optional(v.number()),
    // Dedup: a re-queue carrying no new content short-circuits without
    // spending an LLM call.
    scoredMessageCount: v.optional(v.number()),
    model: v.optional(v.string()),
    scoreStatus: v.union(
      v.literal("pending"),
      v.literal("scored"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    rescoreDueAt: v.optional(v.number()),
    attempts: v.number(),
    lastError: v.optional(v.string()),

    sequenceStatus: v.union(
      v.literal("idle"),
      v.literal("running"),
      v.literal("exhausted"),
      v.literal("stopped"),
    ),
    followUpsSent: v.number(),
    lastFollowUpAt: v.optional(v.number()),
    nextFollowUpAt: v.optional(v.number()),
    stoppedReason: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_account_score", ["accountId", "score"])
    .index("by_score_due", ["scoreStatus", "rescoreDueAt"])
    .index("by_sequence_due", ["sequenceStatus", "nextFollowUpAt"]),

  // Per-account Lead Analysis config, one row (`by_account` doubles as
  // the enforcing unique index — same treatment as
  // `qualificationConfigs`). DORMANT until `enabled`: every engine entry
  // point gates on it, so deploying this schema changes nothing
  // user-visible.
  leadAnalysisConfigs: defineTable({
    accountId: v.id("accounts"),
    enabled: v.boolean(),

    rescoreDebounceMinutes: v.number(),
    scorePerRun: v.number(),
    backfillEnabled: v.boolean(),
    backfillPerRun: v.number(),

    idleDaysBeforeSequence: v.number(),
    humanQuietHours: v.number(),
    dailySendCap: v.number(),
    agedOutDays: v.optional(v.number()),
    bands: v.array(
      v.object({
        key: v.union(v.literal("hot"), v.literal("warm"), v.literal("cold")),
        minScore: v.number(),
        maxScore: v.number(),
        autoArchive: v.boolean(),
        steps: v.array(
          v.object({
            delayDays: v.number(),
            templateName: v.string(),
            templateLanguage: v.optional(v.string()),
          }),
        ),
      }),
    ),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),
```

- [ ] **Step 3: Write the failing config CRUD test**

Create `convex/leadAnalysis.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccountMember(
  t: ReturnType<typeof convexTest>,
  opts: { name: string; email: string; role: AccountRole },
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: opts.name, email: opts.email }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: `${opts.name}'s account`,
      defaultCurrency: "AED",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  return {
    userId,
    accountId,
    asUser: t.withIdentity({ subject: `${userId}|session-${opts.name}` }),
  };
}

test("getConfig returns unpersisted defaults before any save", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  const config = await asUser.query(api.leadAnalysis.getConfig, {});
  expect(config.isPersisted).toBe(false);
  expect(config.enabled).toBe(false);
  expect(config.scorePerRun).toBe(25);
  expect(config.bands).toHaveLength(3);
});

test("updateConfig persists a partial patch onto the defaults", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  await asUser.mutation(api.leadAnalysis.updateConfig, { patch: { enabled: true } });
  const config = await asUser.query(api.leadAnalysis.getConfig, {});
  expect(config.isPersisted).toBe(true);
  expect(config.enabled).toBe(true);
  // Untouched keys still carry their defaults.
  expect(config.scorePerRun).toBe(25);
});

test("updateConfig is idempotent — a second patch updates, never inserts twice", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  await asUser.mutation(api.leadAnalysis.updateConfig, { patch: { enabled: true } });
  await asUser.mutation(api.leadAnalysis.updateConfig, { patch: { scorePerRun: 5 } });
  const rows = await t.run((ctx) =>
    ctx.db
      .query("leadAnalysisConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].enabled).toBe(true);
  expect(rows[0].scorePerRun).toBe(5);
});

test("updateConfig ignores unknown keys instead of failing validation", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  await asUser.mutation(api.leadAnalysis.updateConfig, {
    patch: { enabled: true, nonsenseKey: "boom" },
  });
  const config = await asUser.query(api.leadAnalysis.getConfig, {});
  expect(config.enabled).toBe(true);
});

test("updateConfig rejects a scorePerRun outside 1..100", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Admin", email: "a@x.com", role: "admin",
  });
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { scorePerRun: 0 } }),
  ).rejects.toThrow();
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { scorePerRun: 101 } }),
  ).rejects.toThrow();
});

test("config is admin-gated on both read and write", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Agent", email: "ag@x.com", role: "agent",
  });
  await expect(asUser.query(api.leadAnalysis.getConfig, {})).rejects.toThrow();
  await expect(
    asUser.mutation(api.leadAnalysis.updateConfig, { patch: { enabled: true } }),
  ).rejects.toThrow();
});
```

- [ ] **Step 4: Register the new module in the generated API types**

`convex/_generated/api.d.ts` is TRACKED IN GIT; `convex codegen` must NOT be run in this repo (self-hosted production deployment), so this entry is added by hand. Without it `api.leadAnalysis` does not exist and the test below cannot resolve it.

In the **import block**, between `import type * as knowledge …` (line ~48) and `import type * as leadCharges …` (line ~49), insert:

```ts
import type * as leadAnalysis from "../leadAnalysis.js";
```

In the **`fullApi` map**, between `knowledge: typeof knowledge;` (line ~177) and `leadCharges: typeof leadCharges;` (line ~178), insert:

```ts
  leadAnalysis: typeof leadAnalysis;
```

Create `convex/leadAnalysis.ts` as an empty placeholder first if the typecheck complains about a missing module — Step 5 fills it in.

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: FAIL — `getConfig is not a function` (the module resolves, but is empty).

- [ ] **Step 6: Implement the config CRUD**

Create `convex/leadAnalysis.ts`:

```ts
import { v, ConvexError } from "convex/values";
import { accountQuery, accountMutation } from "./lib/auth";
import { defaultLeadAnalysisConfig } from "./lib/leadAnalysis/defaults";

// ============================================================
// Lead Analysis — account-scoped surface (spec 2026-07-26).
// Config CRUD is admin-gated on BOTH read and write, mirroring
// `qualification.getConfig`: the config governs automated outbound
// spend, so it is not an agent-visible setting.
//
// `patch: v.any()` plus a key whitelist (not a giant validator literal)
// mirrors `qualification.updateConfig`: the schema's own table
// validator still enforces shape on insert/patch, and the whitelist
// turns a stray client field into a clean no-op rather than a raw
// schema-validation error.
// ============================================================

const CONFIG_PATCH_KEYS = [
  "enabled",
  "rescoreDebounceMinutes",
  "scorePerRun",
  "backfillEnabled",
  "backfillPerRun",
  "idleDaysBeforeSequence",
  "humanQuietHours",
  "dailySendCap",
  "agedOutDays",
  "bands",
] as const;

/** Bounds that keep a mis-typed admin value from melting the cron budget. */
const NUMERIC_BOUNDS: Record<string, { min: number; max: number }> = {
  rescoreDebounceMinutes: { min: 1, max: 240 },
  scorePerRun: { min: 1, max: 100 },
  backfillPerRun: { min: 1, max: 100 },
  idleDaysBeforeSequence: { min: 1, max: 90 },
  humanQuietHours: { min: 1, max: 720 },
  dailySendCap: { min: 1, max: 1000 },
  agedOutDays: { min: 7, max: 3650 },
};

export const getConfig = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const row = await ctx.db
      .query("leadAnalysisConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();
    if (row) return { ...row, isPersisted: true as const };
    return {
      ...defaultLeadAnalysisConfig(),
      accountId: ctx.accountId,
      isPersisted: false as const,
    };
  },
});

export const updateConfig = accountMutation({
  args: { patch: v.any() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const raw = (args.patch ?? {}) as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const key of CONFIG_PATCH_KEYS) {
      if (raw[key] !== undefined) patch[key] = raw[key];
    }

    for (const [key, bounds] of Object.entries(NUMERIC_BOUNDS)) {
      const value = patch[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) ||
          value < bounds.min || value > bounds.max) {
        throw new ConvexError({
          code: "BAD_REQUEST",
          reason: `${key} must be ${bounds.min}–${bounds.max}`,
        });
      }
    }

    const existing = await ctx.db
      .query("leadAnalysisConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();

    // Merge over the stored row (or the seeded defaults on first save) so
    // a partial patch always lands as a complete, schema-valid document.
    const base = existing ?? {
      ...defaultLeadAnalysisConfig(),
      accountId: ctx.accountId,
    };
    const merged = { ...base, ...patch, updatedAt: Date.now() };

    if (existing) {
      const { _id, _creationTime, ...update } = merged as typeof existing;
      await ctx.db.patch(existing._id, update);
      return existing._id;
    }
    return await ctx.db.insert("leadAnalysisConfigs", merged);
  },
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 8: Verify the schema test still passes**

Run: `npx vitest run convex/schema.test.ts`
Expected: PASS — the two new tables and the widened union are additive.

- [ ] **Step 9: Commit**

```bash
git add convex/schema.ts convex/leadAnalysis.ts convex/leadAnalysis.test.ts convex/_generated/api.d.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): leadAnalyses + leadAnalysisConfigs tables, config CRUD

Ships dormant (enabled defaults to false). Sequence fields exist now so
P3 needs no second schema deploy.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Inbound hook — debounced re-score request

**Files:**
- Create: `convex/leadAnalysisEngine.ts`
- Create: `convex/leadAnalysisEngine.test.ts`
- Modify: `convex/ingest.ts` (insert after the `qualificationEngine.onInbound` block, ~line 681)

**Interfaces:**
- Consumes: `defaultLeadAnalysisConfig()` (Task 1); `leadAnalysisConfigs` / `leadAnalyses` tables (Task 4).
- Produces: `internal.leadAnalysisEngine.onInbound({ accountId, conversationId, contactId })`.

- [ ] **Step 1: Write the failing test**

Create `convex/leadAnalysisEngine.test.ts` with this content (the `seedAccountMember` helper is repeated deliberately — each test file stands alone):

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccount(t: ReturnType<typeof convexTest>) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Owner", email: "o@x.com" }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "Acct", defaultCurrency: "AED", ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId, accountId: id, role: "owner", fullName: "Owner", email: "o@x.com",
    });
    return id;
  });
  return { userId, accountId };
}

async function seedConversation(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000001", phoneNormalized: "971500000001", name: "Asha",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0, lastMessageAt: Date.now(),
    });
    return { contactId, conversationId };
  });
}

async function enable(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  const { defaultLeadAnalysisConfig } = await import("./lib/leadAnalysis/defaults");
  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(), accountId, enabled: true,
    }),
  );
}

test("onInbound no-ops while the feature is disabled", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId,
  });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(0);
});

test("onInbound creates a pending row with a debounced due time", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  const before = Date.now();
  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId,
  });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].scoreStatus).toBe("pending");
  expect(rows[0].sequenceStatus).toBe("idle");
  expect(rows[0].attempts).toBe(0);
  expect(rows[0].followUpsSent).toBe(0);
  // Default debounce is 10 minutes.
  expect(rows[0].rescoreDueAt!).toBeGreaterThanOrEqual(before + 10 * 60_000);
});

test("a burst of inbounds pushes the same row's timer — never a second row", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId,
  });
  const first = (await t.run((ctx) => ctx.db.query("leadAnalyses").collect()))[0];

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId,
  });
  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());

  expect(rows).toHaveLength(1);
  expect(rows[0]._id).toBe(first._id);
  expect(rows[0].rescoreDueAt!).toBeGreaterThanOrEqual(first.rescoreDueAt!);
});

test("onInbound re-arms an already-scored row", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId,
  });
  const id = (await t.run((ctx) => ctx.db.query("leadAnalyses").collect()))[0]._id;
  await t.run((ctx) =>
    ctx.db.patch(id, {
      scoreStatus: "scored", score: 6, rescoreDueAt: undefined, scoredMessageCount: 3,
    }),
  );

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId,
  });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row!.scoreStatus).toBe("pending");
  expect(row!.rescoreDueAt).toBeDefined();
  // The previous score stays visible on the board until the re-score lands.
  expect(row!.score).toBe(6);
});

test("onInbound re-arms a failed row and resets its attempt budget", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId,
  });
  const id = (await t.run((ctx) => ctx.db.query("leadAnalyses").collect()))[0]._id;
  await t.run((ctx) =>
    ctx.db.patch(id, { scoreStatus: "failed", attempts: 5, rescoreDueAt: undefined }),
  );

  await t.mutation(internal.leadAnalysisEngine.onInbound, {
    accountId, conversationId, contactId,
  });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row!.scoreStatus).toBe("pending");
  expect(row!.attempts).toBe(0);
});
```

- [ ] **Step 2: Register the new module in the generated API types**

`convex/_generated/api.d.ts` is TRACKED IN GIT; `convex codegen` must NOT be run in this repo, so this entry is added by hand. Without it `internal.leadAnalysisEngine` does not exist.

In the **import block**, directly after the `leadAnalysis` line added in Task 4, insert:

```ts
import type * as leadAnalysisEngine from "../leadAnalysisEngine.js";
```

In the **`fullApi` map**, directly after the `leadAnalysis: typeof leadAnalysis;` line added in Task 4, insert:

```ts
  leadAnalysisEngine: typeof leadAnalysisEngine;
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts`
Expected: FAIL — `onInbound is not a function`.

- [ ] **Step 4: Implement `onInbound`**

Create `convex/leadAnalysisEngine.ts`:

```ts
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { defaultLeadAnalysisConfig } from "./lib/leadAnalysis/defaults";

// ============================================================
// Lead Analysis engine — internal machinery only (spec 2026-07-26).
// Every entry point is dormant-safe: with no enabled config the account
// has no rows, so the crons find nothing and the feature costs nothing.
// ============================================================

/** The account's config, or null when the feature is off for them. */
export async function loadEnabledConfig(ctx: MutationCtx, accountId: Id<"accounts">) {
  const row = await ctx.db
    .query("leadAnalysisConfigs")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .unique();
  if (!row || !row.enabled) return null;
  return { ...defaultLeadAnalysisConfig(), ...row };
}

/**
 * Every non-duplicate inbound customer message re-arms scoring for the
 * conversation. DEBOUNCED, not immediate: the due time is pushed to
 * `now + rescoreDebounceMinutes` on every message, so a burst of five
 * messages settles into ONE LLM call rather than five. A silent thread
 * is never re-scored at all.
 *
 * A previously-scored row keeps its `score` while re-arming — the board
 * shows the last known score rather than blanking for the debounce
 * window.
 */
export const onInbound = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config) return;

    const dueAt = Date.now() + config.rescoreDebounceMinutes * 60_000;

    const existing = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        scoreStatus: "pending",
        rescoreDueAt: dueAt,
        // A fresh message is a fresh chance: a row that gave up earlier
        // re-enters the sweep with a full budget instead of staying dead.
        attempts: 0,
        lastError: undefined,
      });
      return;
    }

    await ctx.db.insert("leadAnalyses", {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      scoreStatus: "pending",
      rescoreDueAt: dueAt,
      attempts: 0,
      sequenceStatus: "idle",
      followUpsSent: 0,
    });
  },
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Wire the hook into ingest**

In `convex/ingest.ts`, immediately after the closing `);` of the `runBestEffort("qualificationEngine.onInbound", …)` block (~line 681) and before the `// ---- Ask-admin relay` comment, insert:

```ts
    // ---- Lead Analysis (spec 2026-07-26 §Scoring engine). Every inbound
    // customer message re-arms the debounced re-score timer. Dormant-safe
    // (no enabled config → the mutation no-ops) and best-effort: scoring
    // is an analytics concern and must never fail message ingestion.
    await runBestEffort("leadAnalysisEngine.onInbound", () =>
      ctx.runMutation(internal.leadAnalysisEngine.onInbound, {
        accountId,
        conversationId: res.conversationId,
        contactId: res.contactId,
      }),
    );
```

- [ ] **Step 7: Run the ingest tests to verify nothing regressed**

Run: `npx vitest run convex/ingest.test.ts`
Expected: PASS — the hook is dormant in every existing test (no enabled config is seeded).

- [ ] **Step 8: Commit**

```bash
git add convex/leadAnalysisEngine.ts convex/leadAnalysisEngine.test.ts convex/ingest.ts convex/_generated/api.d.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): debounced re-score request on every inbound

A burst of messages pushes one timer rather than queueing one call per
message, and a silent thread is never re-scored.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Claim, apply, and fail — the scoring write path

**Files:**
- Modify: `convex/leadAnalysisEngine.ts`
- Modify: `convex/leadAnalysisEngine.test.ts`

**Interfaces:**
- Consumes: `loadEnabledConfig` (Task 5); `bandForScore` (Task 1).
- Produces: `internal.leadAnalysisEngine.claimDueForScoring({ limit }) → { analysisId, accountId, conversationId }[]`; `internal.leadAnalysisEngine.applyScore({ analysisId, score, reason, signals, model, messageCount })`; `internal.leadAnalysisEngine.markUnchanged({ analysisId, messageCount })`; `internal.leadAnalysisEngine.recordScoreFailure({ analysisId, error })`.

- [ ] **Step 1: Write the failing tests**

Append to `convex/leadAnalysisEngine.test.ts`:

```ts
async function seedPendingRow(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  dueAt: number,
) {
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const analysisId = await t.run((ctx) =>
    ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "pending" as const, rescoreDueAt: dueAt, attempts: 0,
      sequenceStatus: "idle" as const, followUpsSent: 0,
    }),
  );
  return { analysisId, conversationId, contactId };
}

test("claimDueForScoring returns only rows already due", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const due = await seedPendingRow(t, accountId, Date.now() - 1000);
  await seedPendingRow(t, accountId, Date.now() + 3_600_000);

  const claimed = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 10,
  });

  expect(claimed.map((c) => c.analysisId)).toEqual([due.analysisId]);
});

test("claimDueForScoring honours its limit", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  for (let i = 0; i < 5; i++) await seedPendingRow(t, accountId, Date.now() - 1000);

  const claimed = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 2,
  });

  expect(claimed).toHaveLength(2);
});

test("claiming leases a row so an overlapping sweep cannot double-score it", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await seedPendingRow(t, accountId, Date.now() - 1000);

  const first = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 10,
  });
  const second = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 10,
  });

  expect(first).toHaveLength(1);
  expect(second).toHaveLength(0);
});

test("applyScore writes the score, band, and dedup counter", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);

  await t.mutation(internal.leadAnalysisEngine.applyScore, {
    analysisId,
    score: 9,
    reason: "Gave dates and budget",
    signals: ["dates_given"],
    model: "gpt-test",
    messageCount: 12,
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.scoreStatus).toBe("scored");
  expect(row!.score).toBe(9);
  expect(row!.band).toBe("hot");
  expect(row!.reason).toBe("Gave dates and budget");
  expect(row!.signals).toEqual(["dates_given"]);
  expect(row!.scoredMessageCount).toBe(12);
  expect(row!.model).toBe("gpt-test");
  expect(row!.scoredAt).toBeDefined();
  // Leaves the sweep partition.
  expect(row!.rescoreDueAt).toBeUndefined();
  expect(row!.attempts).toBe(0);
});

test("applyScore bands a mid score as warm and a low score as cold", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const warm = await seedPendingRow(t, accountId, Date.now() - 1000);
  const cold = await seedPendingRow(t, accountId, Date.now() - 1000);

  await t.mutation(internal.leadAnalysisEngine.applyScore, {
    analysisId: warm.analysisId, score: 5, reason: "x", signals: [],
    model: "m", messageCount: 1,
  });
  await t.mutation(internal.leadAnalysisEngine.applyScore, {
    analysisId: cold.analysisId, score: 2, reason: "x", signals: [],
    model: "m", messageCount: 1,
  });

  expect((await t.run((ctx) => ctx.db.get(warm.analysisId)))!.band).toBe("warm");
  expect((await t.run((ctx) => ctx.db.get(cold.analysisId)))!.band).toBe("cold");
});

test("markUnchanged scores the row without touching the previous verdict", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  await t.run((ctx) => ctx.db.patch(analysisId, { score: 7, band: "warm" as const }));

  await t.mutation(internal.leadAnalysisEngine.markUnchanged, {
    analysisId, messageCount: 4,
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.scoreStatus).toBe("scored");
  expect(row!.score).toBe(7);
  expect(row!.scoredMessageCount).toBe(4);
  expect(row!.rescoreDueAt).toBeUndefined();
});

test("recordScoreFailure retries with backoff below the attempt cap", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);

  await t.mutation(internal.leadAnalysisEngine.recordScoreFailure, {
    analysisId, error: "provider 429",
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.scoreStatus).toBe("pending");
  expect(row!.attempts).toBe(1);
  expect(row!.lastError).toBe("provider 429");
  expect(row!.rescoreDueAt!).toBeGreaterThan(Date.now());
});

test("recordScoreFailure retires the row at the attempt cap", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  await t.run((ctx) => ctx.db.patch(analysisId, { attempts: 2 }));

  await t.mutation(internal.leadAnalysisEngine.recordScoreFailure, {
    analysisId, error: "provider down",
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row!.scoreStatus).toBe("failed");
  // A retired row LEAVES the sweep partition so it can never be re-read.
  expect(row!.rescoreDueAt).toBeUndefined();
});

test("a retired row is invisible to the next claim", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);
  await t.run((ctx) => ctx.db.patch(analysisId, { attempts: 2 }));
  await t.mutation(internal.leadAnalysisEngine.recordScoreFailure, {
    analysisId, error: "gone",
  });

  const claimed = await t.mutation(internal.leadAnalysisEngine.claimDueForScoring, {
    limit: 10,
  });
  expect(claimed).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts`
Expected: FAIL — `claimDueForScoring is not a function` (the 5 Task-5 tests still pass).

- [ ] **Step 3: Implement the write path**

Append to `convex/leadAnalysisEngine.ts`:

```ts
import { bandForScore } from "./lib/leadAnalysis/bands";

/** Attempts before a row is retired out of the sweep partition. */
const MAX_SCORE_ATTEMPTS = 3;
/** How long a claimed row is hidden from a concurrent sweep. */
const CLAIM_LEASE_MS = 10 * 60_000;
/** Retry backoff per attempt: 5 min, 20 min, … */
const BACKOFF_BASE_MS = 5 * 60_000;
const ERROR_MAX_CHARS = 300;

/**
 * Take the next due rows and LEASE them: `rescoreDueAt` is pushed out by
 * `CLAIM_LEASE_MS` so a sweep that overlaps a slow predecessor cannot
 * claim the same row and pay for the same LLM call twice. A crash mid-
 * scoring costs one lease of latency, never a lost row.
 *
 * `by_score_due` binds `scoreStatus` before `rescoreDueAt`, so this is a
 * genuine index range over the pending partition — never a `.filter()`
 * across the scored/failed rows, which grow forever.
 */
export const claimDueForScoring = internalMutation({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const due = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_score_due", (q) =>
        q.eq("scoreStatus", "pending").lte("rescoreDueAt", now),
      )
      .take(args.limit);

    const claimed: {
      analysisId: Id<"leadAnalyses">;
      accountId: Id<"accounts">;
      conversationId: Id<"conversations">;
    }[] = [];

    for (const row of due) {
      await ctx.db.patch(row._id, { rescoreDueAt: now + CLAIM_LEASE_MS });
      claimed.push({
        analysisId: row._id,
        accountId: row.accountId,
        conversationId: row.conversationId,
      });
    }
    return claimed;
  },
});

/** Persist a completed scoring verdict and leave the sweep partition. */
export const applyScore = internalMutation({
  args: {
    analysisId: v.id("leadAnalyses"),
    score: v.number(),
    reason: v.string(),
    signals: v.array(v.string()),
    model: v.string(),
    messageCount: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.analysisId);
    if (!row) return;
    const config = await loadEnabledConfig(ctx, row.accountId);
    const bands = (config ?? defaultLeadAnalysisConfig()).bands;

    await ctx.db.patch(args.analysisId, {
      score: args.score,
      band: bandForScore(args.score, bands) ?? undefined,
      reason: args.reason,
      signals: args.signals,
      model: args.model,
      scoredAt: Date.now(),
      scoredMessageCount: args.messageCount,
      scoreStatus: "scored",
      rescoreDueAt: undefined,
      attempts: 0,
      lastError: undefined,
    });
  },
});

/**
 * The dedup short-circuit: the thread carries no new content since the
 * last verdict, so the previous score stands and no LLM call is spent.
 */
export const markUnchanged = internalMutation({
  args: { analysisId: v.id("leadAnalyses"), messageCount: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.analysisId, {
      scoreStatus: "scored",
      scoredMessageCount: args.messageCount,
      rescoreDueAt: undefined,
      attempts: 0,
    });
  },
});

/**
 * Back off, then retire. A retired row moves to "failed" and clears
 * `rescoreDueAt`, so it LEAVES the pending partition rather than
 * accumulating at its front — the failure mode `conversionEvents` and
 * `campaignAds` both document in schema.ts.
 */
export const recordScoreFailure = internalMutation({
  args: { analysisId: v.id("leadAnalyses"), error: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.analysisId);
    if (!row) return;
    const attempts = row.attempts + 1;
    const lastError = args.error.slice(0, ERROR_MAX_CHARS);

    if (attempts >= MAX_SCORE_ATTEMPTS) {
      await ctx.db.patch(args.analysisId, {
        scoreStatus: "failed",
        attempts,
        lastError,
        rescoreDueAt: undefined,
      });
      return;
    }

    await ctx.db.patch(args.analysisId, {
      scoreStatus: "pending",
      attempts,
      lastError,
      rescoreDueAt: Date.now() + BACKOFF_BASE_MS * Math.pow(4, attempts - 1),
    });
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/leadAnalysisEngine.ts convex/leadAnalysisEngine.test.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): leased claim, apply, and retire for scoring

Claiming leases the row so overlapping sweeps cannot pay for the same
LLM call twice, and a retired row leaves the pending partition instead
of accumulating at its front.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: The scoring sweep action

**Files:**
- Modify: `convex/leadAnalysisEngine.ts`
- Modify: `convex/leadAnalysisEngine.test.ts`

**Interfaces:**
- Consumes: `claimDueForScoring` / `applyScore` / `markUnchanged` / `recordScoreFailure` (Task 6); `buildScoreSystemPrompt` / `parseScoreResponse` (Task 3); `toChatMessages` from `./lib/ai/context`; `generateReply` from `./lib/ai/generate`; `internal.aiConfig.loadDecrypted`; `internal.aiUsage.log`.
- Produces: `internal.leadAnalysisEngine.loadScoreInput({ analysisId })`; `internal.leadAnalysisEngine.sweepScoring()`.

- [ ] **Step 1: Write the failing tests**

Append to `convex/leadAnalysisEngine.test.ts` (and add `beforeEach`/`afterEach` to the vitest import at the top of the file):

```ts
async function seedAiConfig(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  await t.run((ctx) =>
    ctx.db.insert("aiConfigs", {
      accountId, provider: "openai" as const, model: "gpt-test",
      apiKey: "unused-under-dry-run", isActive: true, autoReplyEnabled: false,
    }),
  );
}

async function seedCustomerMessage(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  text: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId, conversationId, senderType: "customer" as const,
      contentType: "text" as const, contentText: text, status: "delivered" as const,
    }),
  );
}

test("sweepScoring scores a due row end to end under dry run", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccount(t);
    await enable(t, accountId);
    await seedAiConfig(t, accountId);
    const { analysisId, conversationId } = await seedPendingRow(
      t, accountId, Date.now() - 1000,
    );
    await seedCustomerMessage(t, accountId, conversationId, "Goa in December, 2 adults");

    await t.action(internal.leadAnalysisEngine.sweepScoring, {});

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.scoreStatus).toBe("scored");
    expect(row!.score).toBeGreaterThanOrEqual(1);
    expect(row!.score).toBeLessThanOrEqual(10);
    expect(row!.band).toBeDefined();
    expect(row!.scoredMessageCount).toBe(1);
  } finally {
    delete process.env.CONVEX_AI_DRY_RUN;
  }
});

test("sweepScoring skips the LLM when the message count is unchanged", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccount(t);
    await enable(t, accountId);
    await seedAiConfig(t, accountId);
    const { analysisId, conversationId } = await seedPendingRow(
      t, accountId, Date.now() - 1000,
    );
    await seedCustomerMessage(t, accountId, conversationId, "hello");
    await t.run((ctx) =>
      ctx.db.patch(analysisId, { scoredMessageCount: 1, score: 4, band: "warm" as const }),
    );

    await t.action(internal.leadAnalysisEngine.sweepScoring, {});

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.scoreStatus).toBe("scored");
    expect(row!.score).toBe(4); // untouched — no call was made
    const usage = await t.run((ctx) => ctx.db.query("aiUsageLog").collect());
    expect(usage).toHaveLength(0);
  } finally {
    delete process.env.CONVEX_AI_DRY_RUN;
  }
});

test("sweepScoring skips a conversation with no customer message", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccount(t);
    await enable(t, accountId);
    await seedAiConfig(t, accountId);
    const { analysisId } = await seedPendingRow(t, accountId, Date.now() - 1000);

    await t.action(internal.leadAnalysisEngine.sweepScoring, {});

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.scoreStatus).toBe("skipped");
    expect(row!.rescoreDueAt).toBeUndefined();
  } finally {
    delete process.env.CONVEX_AI_DRY_RUN;
  }
});

test("sweepScoring retires a row whose account has no AI config", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccount(t);
    await enable(t, accountId);
    const { analysisId, conversationId } = await seedPendingRow(
      t, accountId, Date.now() - 1000,
    );
    await seedCustomerMessage(t, accountId, conversationId, "hi");

    await t.action(internal.leadAnalysisEngine.sweepScoring, {});

    const row = await t.run((ctx) => ctx.db.get(analysisId));
    expect(row!.attempts).toBeGreaterThan(0);
    expect(row!.lastError).toContain("ai_config");
  } finally {
    delete process.env.CONVEX_AI_DRY_RUN;
  }
});

test("sweepScoring is a no-op when nothing is due", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  try {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccount(t);
    await enable(t, accountId);
    await seedAiConfig(t, accountId);
    await seedPendingRow(t, accountId, Date.now() + 3_600_000);

    await expect(
      t.action(internal.leadAnalysisEngine.sweepScoring, {}),
    ).resolves.toBeUndefined();
  } finally {
    delete process.env.CONVEX_AI_DRY_RUN;
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts`
Expected: FAIL — `sweepScoring is not a function`.

- [ ] **Step 3: Implement `loadScoreInput` and `sweepScoring`**

Append to `convex/leadAnalysisEngine.ts` — and extend the imports at the top of the file to:

```ts
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { defaultLeadAnalysisConfig } from "./lib/leadAnalysis/defaults";
import { bandForScore } from "./lib/leadAnalysis/bands";
import { buildScoreSystemPrompt, parseScoreResponse } from "./lib/leadAnalysis/prompt";
import { toChatMessages } from "./lib/ai/context";
import { generateReply } from "./lib/ai/generate";
```

Then append:

```ts
/** How much transcript the scorer reads. Bounded: the cost of a score
 *  must not grow with the length of a long-running chat. */
const TRANSCRIPT_LIMIT = 40;

/** Everything one scoring call needs, in a single indexed read. */
export const loadScoreInput = internalQuery({
  args: { analysisId: v.id("leadAnalyses") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.analysisId);
    if (!row) return null;

    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
      .order("desc")
      .take(TRANSCRIPT_LIMIT);
    const messages = [...recent].reverse();

    // A thread nobody wrote into is not a lead — the board never shows it
    // and no LLM call is spent on it.
    const hasCustomerMessage = messages.some((m) => m.senderType === "customer");

    const contact = await ctx.db.get(row.contactId);
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
      .order("desc")
      .first();
    const services = await ctx.db
      .query("kbServices")
      .withIndex("by_account", (q) => q.eq("accountId", row.accountId))
      .take(50);

    return {
      accountId: row.accountId,
      conversationId: row.conversationId,
      hasCustomerMessage,
      messageCount: messages.length,
      scoredMessageCount: row.scoredMessageCount ?? null,
      // NOTE the field name: `HistoryMessage.transcription`, NOT
      // `aiTranscription` (which is the raw column name on `messages`).
      // See convex/lib/ai/context.ts:53.
      chat: toChatMessages(
        messages.map((m) => ({
          senderType: m.senderType,
          contentText: m.contentText,
          contentType: m.contentType,
          transcription: m.aiTranscription,
        })),
      ),
      serviceName: session?.serviceName ?? null,
      services: services.map((s) => s.name),
      contact: {
        ...(contact?.name ? { name: contact.name } : {}),
        ...(contact?.travelDates ? { travelDates: contact.travelDates } : {}),
        ...(contact?.travelers ? { travelers: contact.travelers } : {}),
        ...(contact?.budget ? { budget: contact.budget } : {}),
        ...(contact?.preferredDestination
          ? { preferredDestination: contact.preferredDestination }
          : {}),
      },
    };
  },
});

/** Deterministic stand-in so tests never reach a provider — the same
 *  `CONVEX_AI_DRY_RUN` convention `aiReply.ts` uses. */
function isDryRun(): boolean {
  return !!process.env.CONVEX_AI_DRY_RUN;
}

/**
 * The scoring sweep. Claims a bounded slice of due rows, scores each in
 * turn, and writes the verdict back. Every row is independently
 * try/caught: one bad conversation can never abort the sweep and strand
 * the rest of the slice behind it.
 */
export const sweepScoring = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const claimed = await ctx.runMutation(
      internal.leadAnalysisEngine.claimDueForScoring,
      { limit: defaultLeadAnalysisConfig().scorePerRun },
    );

    for (const { analysisId } of claimed) {
      try {
        const input = await ctx.runQuery(internal.leadAnalysisEngine.loadScoreInput, {
          analysisId,
        });
        if (!input) continue;

        if (!input.hasCustomerMessage) {
          await ctx.runMutation(internal.leadAnalysisEngine.markSkipped, { analysisId });
          continue;
        }

        // Dedup: no new content since the last verdict — the previous
        // score stands and no call is spent.
        if (input.scoredMessageCount === input.messageCount) {
          await ctx.runMutation(internal.leadAnalysisEngine.markUnchanged, {
            analysisId,
            messageCount: input.messageCount,
          });
          continue;
        }

        const systemPrompt = buildScoreSystemPrompt({
          serviceName: input.serviceName,
          services: input.services,
          contact: input.contact,
        });

        if (isDryRun()) {
          await ctx.runMutation(internal.leadAnalysisEngine.applyScore, {
            analysisId,
            score: 5,
            reason: "Dry-run synthetic score",
            signals: [],
            model: "dry-run",
            messageCount: input.messageCount,
          });
          continue;
        }

        const aiConfig = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
          accountId: input.accountId,
        });
        if (!aiConfig || !aiConfig.isActive) {
          await ctx.runMutation(internal.leadAnalysisEngine.recordScoreFailure, {
            analysisId,
            error: "ai_config missing or inactive",
          });
          continue;
        }

        const result = await generateReply({
          provider: aiConfig.provider,
          model: aiConfig.model,
          apiKey: aiConfig.apiKey,
          systemPrompt,
          messages: input.chat,
        });

        const parsed = parseScoreResponse(result.text);
        if (!parsed) {
          await ctx.runMutation(internal.leadAnalysisEngine.recordScoreFailure, {
            analysisId,
            error: `unparseable response: ${result.text.slice(0, 120)}`,
          });
          continue;
        }

        await ctx.runMutation(internal.leadAnalysisEngine.applyScore, {
          analysisId,
          score: parsed.score,
          reason: parsed.reason,
          signals: parsed.signals,
          model: aiConfig.model,
          messageCount: input.messageCount,
        });

        if (result.usage) {
          await ctx.runMutation(internal.aiUsage.log, {
            accountId: input.accountId,
            conversationId: input.conversationId,
            mode: "score",
            provider: aiConfig.provider,
            model: aiConfig.model,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
          });
        }
      } catch (error) {
        await ctx.runMutation(internal.leadAnalysisEngine.recordScoreFailure, {
          analysisId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },
});
```

Also append the `markSkipped` mutation next to `markUnchanged`:

```ts
/** Not a lead (no customer message ever). Terminal, and out of the
 *  sweep partition — re-armed only if a customer eventually writes in. */
export const markSkipped = internalMutation({
  args: { analysisId: v.id("leadAnalyses") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.analysisId, {
      scoreStatus: "skipped",
      rescoreDueAt: undefined,
    });
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/leadAnalysisEngine.ts convex/leadAnalysisEngine.test.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): scoring sweep action

Bounded transcript, per-row try/catch so one bad conversation cannot
strand the slice, dedup short-circuit on unchanged message count, and
usage logged under the new "score" mode.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Cursored backfill

**Files:**
- Modify: `convex/leadAnalysisEngine.ts`
- Modify: `convex/leadAnalysisEngine.test.ts`

**Interfaces:**
- Consumes: `loadEnabledConfig` (Task 5); the existing `counters` table.
- Produces: `internal.leadAnalysisEngine.backfillAccount({ accountId }) → { enqueued: number; done: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `convex/leadAnalysisEngine.test.ts`:

```ts
async function seedConversationAt(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  lastMessageAt: number,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: `+9715${lastMessageAt}`,
      phoneNormalized: `9715${lastMessageAt}`,
    });
    return await ctx.db.insert("conversations", {
      accountId, contactId, status: "open" as const, unreadCount: 0, lastMessageAt,
    });
  });
}

test("backfill enqueues historical conversations newest-first", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const oldest = await seedConversationAt(t, accountId, 1_000);
  const newest = await seedConversationAt(t, accountId, 3_000);
  await seedConversationAt(t, accountId, 2_000);

  const result = await t.mutation(internal.leadAnalysisEngine.backfillAccount, {
    accountId, limit: 1,
  });

  expect(result.enqueued).toBe(1);
  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].conversationId).toBe(newest);
  expect(rows[0].conversationId).not.toBe(oldest);
});

test("backfill resumes below the cursor instead of rescanning", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedConversationAt(t, accountId, 1_000);
  await seedConversationAt(t, accountId, 2_000);
  await seedConversationAt(t, accountId, 3_000);

  await t.mutation(internal.leadAnalysisEngine.backfillAccount, { accountId, limit: 1 });
  await t.mutation(internal.leadAnalysisEngine.backfillAccount, { accountId, limit: 1 });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(2);
  const stamps = await t.run(async (ctx) => {
    const out: number[] = [];
    for (const r of rows) {
      const c = await ctx.db.get(r.conversationId);
      out.push(c!.lastMessageAt!);
    }
    return out.sort((a, b) => a - b);
  });
  expect(stamps).toEqual([2_000, 3_000]);
});

test("backfill reports done once the account is exhausted", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await seedConversationAt(t, accountId, 1_000);

  await t.mutation(internal.leadAnalysisEngine.backfillAccount, { accountId, limit: 10 });
  const second = await t.mutation(internal.leadAnalysisEngine.backfillAccount, {
    accountId, limit: 10,
  });

  expect(second.enqueued).toBe(0);
  expect(second.done).toBe(true);
});

test("backfill never double-enqueues a conversation that already has a row", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const conversationId = await seedConversationAt(t, accountId, 5_000);
  const contactId = await t.run(async (ctx) =>
    (await ctx.db.get(conversationId))!.contactId,
  );
  await t.run((ctx) =>
    ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored" as const, attempts: 0,
      sequenceStatus: "idle" as const, followUpsSent: 0,
    }),
  );

  await t.mutation(internal.leadAnalysisEngine.backfillAccount, { accountId, limit: 10 });

  const rows = await t.run((ctx) => ctx.db.query("leadAnalyses").collect());
  expect(rows).toHaveLength(1);
});

test("backfill no-ops while the feature is disabled", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await seedConversationAt(t, accountId, 1_000);

  const result = await t.mutation(internal.leadAnalysisEngine.backfillAccount, {
    accountId, limit: 10,
  });

  expect(result.enqueued).toBe(0);
  expect(await t.run((ctx) => ctx.db.query("leadAnalyses").collect())).toHaveLength(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts`
Expected: FAIL — `backfillAccount is not a function`.

- [ ] **Step 3: Implement the cursored backfill**

Append to `convex/leadAnalysisEngine.ts`:

```ts
const BACKFILL_COUNTER = "leadAnalysisBackfill";

/**
 * Enqueue historical conversations that have no analysis row yet.
 *
 * "Has no row" is NOT an indexable predicate on `conversations`, so a
 * naive backfill rescans from the newest conversation every run and
 * walks further each time — the unbounded-scan shape schema.ts warns
 * about throughout. Instead this keeps a per-account CURSOR in
 * `counters` (the `lastMessageAt` of the last conversation enqueued) and
 * resumes strictly below it, so the account is walked exactly once, in
 * bounded slices.
 */
export const backfillAccount = internalMutation({
  args: { accountId: v.id("accounts"), limit: v.number() },
  handler: async (ctx, args) => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config || !config.backfillEnabled) return { enqueued: 0, done: true };

    const counter = await ctx.db
      .query("counters")
      .withIndex("by_account_name", (q) =>
        q.eq("accountId", args.accountId).eq("name", BACKFILL_COUNTER),
      )
      .unique();

    // value 0 = never run: start above every real timestamp.
    const cursor = counter && counter.value > 0 ? counter.value : Number.MAX_SAFE_INTEGER;

    const batch = await ctx.db
      .query("conversations")
      .withIndex("by_account_last_message", (q) =>
        q.eq("accountId", args.accountId).lt("lastMessageAt", cursor),
      )
      .order("desc")
      .take(args.limit);

    let enqueued = 0;
    let lowest = cursor;

    for (const conversation of batch) {
      lowest = conversation.lastMessageAt ?? lowest;

      const existing = await ctx.db
        .query("leadAnalyses")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
        .unique();
      if (existing) continue;

      await ctx.db.insert("leadAnalyses", {
        accountId: args.accountId,
        conversationId: conversation._id,
        contactId: conversation.contactId,
        scoreStatus: "pending",
        // Due immediately: backfill rows are already old, and the sweep
        // drains live rows first anyway.
        rescoreDueAt: Date.now(),
        attempts: 0,
        sequenceStatus: "idle",
        followUpsSent: 0,
      });
      enqueued++;
    }

    if (batch.length > 0) {
      if (counter) await ctx.db.patch(counter._id, { value: lowest });
      else {
        await ctx.db.insert("counters", {
          accountId: args.accountId,
          name: BACKFILL_COUNTER,
          value: lowest,
        });
      }
    }

    return { enqueued, done: batch.length === 0 };
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts`
Expected: PASS, 24 tests.

- [ ] **Step 5: Drive backfill from the sweep when nothing is due**

In `sweepScoring`, immediately after the `claimDueForScoring` call, insert:

```ts
    // Live rows always drain first: backfill only runs on an idle sweep,
    // so a fresh lead never waits behind historical work.
    if (claimed.length === 0) {
      const accounts = await ctx.runQuery(
        internal.leadAnalysisEngine.enabledAccountIds,
        {},
      );
      for (const accountId of accounts) {
        await ctx.runMutation(internal.leadAnalysisEngine.backfillAccount, {
          accountId,
          limit: defaultLeadAnalysisConfig().backfillPerRun,
        });
      }
      return;
    }
```

And append the supporting query:

```ts
/** Accounts with the feature switched on. Bounded: one small row per
 *  account, and only accounts that opted in are ever swept. */
export const enabledAccountIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("leadAnalysisConfigs").take(200);
    return rows.filter((r) => r.enabled).map((r) => r.accountId);
  },
});
```

- [ ] **Step 6: Run the full engine suite**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts`
Expected: PASS, 24 tests — the "no-op when nothing is due" test now exercises the backfill branch and must still resolve.

- [ ] **Step 7: Commit**

```bash
git add convex/leadAnalysisEngine.ts convex/leadAnalysisEngine.test.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): cursored historical backfill

Keeps a per-account counters cursor so the account is walked exactly
once rather than rescanned from the newest conversation every run.
Runs only on an idle sweep, so live leads never queue behind history.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Register the cron

**Files:**
- Modify: `convex/lib/cronSummary.ts` (`CRON_REGISTRY`)
- Modify: `convex/cronSchedules.ts` (add the wrapper)
- Modify: `convex/crons.ts` (register the interval)

**Interfaces:**
- Consumes: `internal.leadAnalysisEngine.sweepScoring` (Task 7).
- Produces: `internal.cronSchedules.runSweepLeadScoring`; the `"lead-scoring"` cron name.

- [ ] **Step 1: Add the name to the registry**

In `convex/lib/cronSummary.ts`, extend `CRON_REGISTRY`:

```ts
export const CRON_REGISTRY = [
  { name: "retry-ad-resolution", intervalMinutes: 60 },
  { name: "retry-conversion-events", intervalMinutes: 15 },
  { name: "qualification-follow-ups", intervalMinutes: 5 },
  { name: "qualification-lead-offers", intervalMinutes: 5 },
  { name: "qualification-staff-loops", intervalMinutes: 60 },
  { name: "lead-scoring", intervalMinutes: 5 },
] as const;
```

- [ ] **Step 2: Add the wrapper action**

In `convex/cronSchedules.ts`, after `runSweepFollowUps` (~line 131), add:

```ts
export const runSweepLeadScoring = internalAction({
  args: {},
  handler: (ctx): Promise<void> =>
    runWrapped(ctx, "lead-scoring", internal.leadAnalysisEngine.sweepScoring),
});
```

- [ ] **Step 3: Register the interval**

In `convex/crons.ts`, before `export default crons;`, add:

```ts
// Lead Analysis scoring (spec 2026-07-26): sweep due leadAnalyses rows
// (by_score_due, leased claim) and score each against the account's BYO
// key. On an idle sweep it advances the historical backfill instead.
// No-op while the feature is disabled (no rows exist).
crons.interval(
  "lead-scoring",
  { minutes: 5 },
  internal.cronSchedules.runSweepLeadScoring,
  {},
);
```

- [ ] **Step 4: Run the cron-sync test**

Run: `npx vitest run convex/cronSchedules.test.ts`
Expected: PASS — the existing test asserts `CRON_REGISTRY` matches `crons.ts`; all three edits must agree or it fails.

- [ ] **Step 5: Run the cron summary unit tests**

Run: `npx vitest run convex/lib/cronSummary.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/cronSummary.ts convex/cronSchedules.ts convex/crons.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): register the lead-scoring cron

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The board query and manual re-analyze

**Files:**
- Modify: `convex/leadAnalysis.ts`
- Modify: `convex/leadAnalysis.test.ts`

**Interfaces:**
- Consumes: `leadLane` / `comparePriority` (Task 2); `leadAnalyses` (Task 4).
- Produces: `api.leadAnalysis.board({}) → { summary, leads }`; `api.leadAnalysis.reanalyze({ conversationId })`.

  `leads` row shape: `{ analysisId, conversationId, contactName, contactPhone, score, band, reason, signals, lane, scoreStatus, lastMessageAt, daysSinceLastMessage, assigneeName, source, serviceName, sequenceStatus, followUpsSent, scoredAt }`.

- [ ] **Step 1: Write the failing tests**

Append to `convex/leadAnalysis.test.ts` (add `internal` to the `_generated/api` import and `Id` to the imports):

```ts
async function seedScoredLead(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: {
    score?: number;
    band?: "hot" | "warm" | "cold";
    lastSender?: "customer" | "agent";
    assignedToUserId?: Id<"users">;
    phone?: string;
  } = {},
) {
  return await t.run(async (ctx) => {
    const phone = opts.phone ?? `+9715${Math.floor(Math.random() * 1e8)}`;
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone, phoneNormalized: phone.replace(/\D/g, ""), name: "Asha",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open" as const, unreadCount: 0,
      lastMessageAt: Date.now() - 86_400_000,
      ...(opts.assignedToUserId ? { assignedToUserId: opts.assignedToUserId } : {}),
    });
    await ctx.db.insert("messages", {
      accountId, conversationId,
      senderType: (opts.lastSender ?? "customer") as "customer" | "agent",
      contentType: "text" as const, contentText: "hi", status: "delivered" as const,
    });
    const analysisId = await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored" as const, attempts: 0,
      sequenceStatus: "idle" as const, followUpsSent: 0,
      ...(opts.score !== undefined ? { score: opts.score } : {}),
      ...(opts.band ? { band: opts.band } : {}),
      reason: "test reason", signals: ["dates_given"], scoredAt: Date.now(),
    });
    return { analysisId, conversationId, contactId };
  });
}

test("board returns scored leads sorted by priority", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedScoredLead(t, accountId, { score: 3, band: "cold" });
  await seedScoredLead(t, accountId, { score: 9, band: "hot" });

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads.map((l) => l.score)).toEqual([9, 3]);
});

test("board derives the lane from the last message sender", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedScoredLead(t, accountId, { score: 5, lastSender: "customer" });

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads[0].lane).toBe("awaiting_us");
});

test("board summary counts bands and lanes", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedScoredLead(t, accountId, { score: 9, band: "hot", lastSender: "customer" });
  await seedScoredLead(t, accountId, { score: 5, band: "warm", lastSender: "agent" });

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.summary.hot).toBe(1);
  expect(board.summary.warm).toBe(1);
  expect(board.summary.cold).toBe(0);
  expect(board.summary.awaitingUs).toBe(1);
  expect(board.summary.total).toBe(2);
});

test("board reports unscored leads separately from scored ones", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4, band: "warm" });
  await t.run((ctx) =>
    ctx.db.patch(lead.analysisId, {
      scoreStatus: "pending" as const, score: undefined, band: undefined,
    }),
  );

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.summary.unscored).toBe(1);
  expect(board.leads[0].score).toBeNull();
});

test("board never returns skipped rows", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });
  await t.run((ctx) => ctx.db.patch(lead.analysisId, { scoreStatus: "skipped" as const }));

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads).toHaveLength(0);
});

test("an agent sees only leads assigned to them", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Agent", email: "ag@x.com", role: "agent",
  });
  await seedScoredLead(t, accountId, { score: 9, assignedToUserId: userId });
  await seedScoredLead(t, accountId, { score: 8 }); // unassigned

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads).toHaveLength(1);
  expect(board.leads[0].score).toBe(9);
});

test("a viewer is denied the board entirely", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Viewer", email: "v@x.com", role: "viewer",
  });
  await expect(asUser.query(api.leadAnalysis.board, {})).rejects.toThrow();
});

test("the board never leaks another account's leads", async () => {
  const t = convexTest(schema, modules);
  const a = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "owner" });
  const b = await seedAccountMember(t, { name: "B", email: "b@x.com", role: "owner" });
  await seedScoredLead(t, b.accountId, { score: 10 });

  const board = await a.asUser.query(api.leadAnalysis.board, {});

  expect(board.leads).toHaveLength(0);
});

test("reanalyze re-arms the row immediately", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });
  await t.run((ctx) => ctx.db.patch(lead.analysisId, { scoredThroughMs: 9_000 }));

  await asUser.mutation(api.leadAnalysis.reanalyze, {
    conversationId: lead.conversationId,
  });

  const row = await t.run((ctx) => ctx.db.get(lead.analysisId));
  expect(row!.scoreStatus).toBe("pending");
  expect(row!.rescoreDueAt!).toBeLessThanOrEqual(Date.now());
  // Cleared so the dedup short-circuit cannot swallow the manual request.
  expect(row!.scoredThroughMs).toBeUndefined();
  expect(row!.attempts).toBe(0);
});

test("reanalyze is denied to a viewer", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, { name: "O", email: "o@x.com", role: "owner" });
  const viewer = await seedAccountMember(t, {
    name: "V", email: "v@x.com", role: "viewer",
  });
  const lead = await seedScoredLead(t, owner.accountId, { score: 4 });

  await expect(
    viewer.asUser.mutation(api.leadAnalysis.reanalyze, {
      conversationId: lead.conversationId,
    }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: FAIL — `board is not a function`.

- [ ] **Step 3: Implement `board` and `reanalyze`**

Append to `convex/leadAnalysis.ts` — extend the imports to:

```ts
import { v, ConvexError } from "convex/values";
import { accountQuery, accountMutation } from "./lib/auth";
import { defaultLeadAnalysisConfig } from "./lib/leadAnalysis/defaults";
import { comparePriority, leadLane, type LeadLane } from "./lib/leadAnalysis/priority";
```

Then append:

```ts
// ============================================================
// The Lead Analysis board (spec §"The section"). ONE round-trip:
// summary tiles plus the priority-sorted lead list with the joins the
// board renders. Bounded by an explicit `take` — no unbounded collects
// (the campaigns.overview scale lesson).
//
// RBAC mirrors `qualification.leadsBoard`: agents work ONLY their own
// assigned leads, supervisor+ see everything, viewers have no board.
// ============================================================

const BOARD_CAP = 400;
const DAY_MS = 86_400_000;

export const board = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("agent");
    const ownOnly = ctx.role === "agent";

    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    const memberName = new Map(
      memberships.map((m) => [m.userId, m.fullName ?? "Member"]),
    );

    // Descending on `by_account_score` puts the highest scores first;
    // unscored rows (score unset) sort last, which is exactly where the
    // board wants them, so the cap never truncates a scored lead in
    // favour of an unscored one.
    const rows = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_account_score", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .take(BOARD_CAP);

    const now = Date.now();
    const leads: {
      analysisId: string;
      conversationId: string;
      contactName: string;
      contactPhone: string;
      score: number | null;
      band: "hot" | "warm" | "cold" | null;
      reason: string | null;
      signals: string[];
      lane: LeadLane;
      scoreStatus: string;
      lastMessageAt: number | null;
      daysSinceLastMessage: number | null;
      assigneeName: string | null;
      source: "ad" | "website" | "organic";
      serviceName: string | null;
      sequenceStatus: string;
      followUpsSent: number;
      scoredAt: number | null;
    }[] = [];

    for (const row of rows) {
      // "skipped" is not a lead (no customer ever wrote in).
      if (row.scoreStatus === "skipped") continue;

      const conversation = await ctx.db.get(row.conversationId);
      const contact = await ctx.db.get(row.contactId);
      if (!conversation || !contact) continue;
      if (ownOnly && conversation.assignedToUserId !== ctx.userId) continue;

      const lastMessage = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
        .order("desc")
        .first();

      const session = await ctx.db
        .query("qualificationSessions")
        .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
        .order("desc")
        .first();

      const source: "ad" | "website" | "organic" =
        conversation.attribution?.lane === "ctwa" || conversation.adReferral
          ? "ad"
          : conversation.attribution?.lane === "code"
            ? "website"
            : "organic";

      leads.push({
        analysisId: row._id,
        conversationId: row.conversationId,
        contactName: contact.name?.trim() || contact.phone,
        contactPhone: contact.phone,
        score: row.score ?? null,
        band: row.band ?? null,
        reason: row.reason ?? null,
        signals: row.signals ?? [],
        lane: leadLane(lastMessage?.senderType ?? null),
        scoreStatus: row.scoreStatus,
        lastMessageAt: conversation.lastMessageAt ?? null,
        daysSinceLastMessage: conversation.lastMessageAt
          ? Math.floor((now - conversation.lastMessageAt) / DAY_MS)
          : null,
        assigneeName: conversation.assignedToUserId
          ? (memberName.get(conversation.assignedToUserId) ?? null)
          : null,
        source,
        serviceName: session?.serviceName ?? null,
        sequenceStatus: row.sequenceStatus,
        followUpsSent: row.followUpsSent,
        scoredAt: row.scoredAt ?? null,
      });
    }

    leads.sort(comparePriority);

    const summary = {
      hot: leads.filter((l) => l.band === "hot").length,
      warm: leads.filter((l) => l.band === "warm").length,
      cold: leads.filter((l) => l.band === "cold").length,
      awaitingUs: leads.filter((l) => l.lane === "awaiting_us").length,
      awaitingThem: leads.filter((l) => l.lane === "awaiting_them").length,
      unscored: leads.filter((l) => l.score === null).length,
      total: leads.length,
      avgScore: (() => {
        const scored = leads.filter((l) => l.score !== null).map((l) => l.score as number);
        if (scored.length === 0) return 0;
        return Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10;
      })(),
    };

    return { summary, leads };
  },
});

/**
 * Manual re-score. Clears `scoredThroughMs` so the sweep's dedup
 * short-circuit cannot swallow the request when the transcript has not
 * changed — a human asking again always costs a real call.
 */
export const reanalyze = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");

    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", reason: "conversation" });
    }
    if (ctx.role === "agent" && conversation.assignedToUserId !== ctx.userId) {
      throw new ConvexError({ code: "FORBIDDEN", reason: "not_assigned" });
    }

    const existing = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        scoreStatus: "pending",
        rescoreDueAt: Date.now(),
        scoredThroughMs: undefined,
        attempts: 0,
        lastError: undefined,
      });
      return existing._id;
    }

    return await ctx.db.insert("leadAnalyses", {
      accountId: ctx.accountId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      scoreStatus: "pending",
      rescoreDueAt: Date.now(),
      attempts: 0,
      sequenceStatus: "idle",
      followUpsSent: 0,
    });
  },
});
```

Note: `requireRole("agent")` admits agents and above but **not** viewers, matching `qualification.leadsBoard`. The `defaultLeadAnalysisConfig` import stays in use by the config CRUD above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/leadAnalysis.ts convex/leadAnalysis.test.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): board query and manual re-analyze

Agents see only their assigned leads; viewers are denied. Re-analyze
clears the dedup counter so a human request always costs a real call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The board component

**Files:**
- Create: `src/components/lead-analysis/lead-analysis-board.tsx`
- Create: `src/components/lead-analysis/lead-analysis-board.test.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: the `board` return shape from Task 10.
- Produces: `export interface LeadAnalysisRow`; `export interface LeadAnalysisBoardData { summary: …; leads: LeadAnalysisRow[] }`; `export function LeadAnalysisBoard(props: { board: LeadAnalysisBoardData; canReanalyze: boolean; onReanalyze: (lead: LeadAnalysisRow) => void })`.

- [ ] **Step 1: Add the i18n strings**

In `messages/en.json`, add a top-level `"LeadAnalysis"` block alongside the existing `"Leads"` block:

```json
  "LeadAnalysis": {
    "title": "Lead Analysis",
    "loading": "Loading leads…",
    "empty": "No leads scored yet. Scoring runs in the background.",
    "tiles": {
      "hot": "Hot",
      "warm": "Warm",
      "cold": "Cold",
      "awaitingUs": "Awaiting us",
      "unscored": "Unscored",
      "avgScore": "Avg score"
    },
    "filters": {
      "all": "All",
      "band": "Band",
      "lane": "Lane",
      "search": "Search name or phone"
    },
    "lane": {
      "awaiting_us": "Awaiting us",
      "awaiting_them": "Awaiting them"
    },
    "row": {
      "unscored": "Unscored",
      "daysSilent": "{days}d silent",
      "today": "Today",
      "openChat": "Open chat",
      "reanalyze": "Re-analyze"
    },
    "reanalyzeQueued": "Re-analysis queued",
    "reanalyzeError": "Could not queue re-analysis"
  },
```

- [ ] **Step 2: Write the failing component test**

Create `src/components/lead-analysis/lead-analysis-board.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import messages from "../../../messages/en.json";
import {
  LeadAnalysisBoard,
  type LeadAnalysisBoardData,
  type LeadAnalysisRow,
} from "./lead-analysis-board";

const lead = (over: Partial<LeadAnalysisRow> = {}): LeadAnalysisRow => ({
  analysisId: "a1",
  conversationId: "c1",
  contactName: "Asha",
  contactPhone: "+971500000001",
  score: 9,
  band: "hot",
  reason: "Gave dates and budget",
  signals: ["dates_given"],
  lane: "awaiting_us",
  scoreStatus: "scored",
  lastMessageAt: Date.now(),
  daysSinceLastMessage: 0,
  assigneeName: null,
  source: "organic",
  serviceName: null,
  sequenceStatus: "idle",
  followUpsSent: 0,
  scoredAt: Date.now(),
  ...over,
});

const board = (leads: LeadAnalysisRow[]): LeadAnalysisBoardData => ({
  summary: {
    hot: leads.filter((l) => l.band === "hot").length,
    warm: leads.filter((l) => l.band === "warm").length,
    cold: leads.filter((l) => l.band === "cold").length,
    awaitingUs: leads.filter((l) => l.lane === "awaiting_us").length,
    awaitingThem: leads.filter((l) => l.lane === "awaiting_them").length,
    unscored: leads.filter((l) => l.score === null).length,
    total: leads.length,
    avgScore: 9,
  },
  leads,
});

function renderBoard(data: LeadAnalysisBoardData, onReanalyze = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <LeadAnalysisBoard board={data} canReanalyze onReanalyze={onReanalyze} />
    </NextIntlClientProvider>,
  );
  return { onReanalyze };
}

describe("LeadAnalysisBoard", () => {
  it("renders a lead's name, score, and reason", () => {
    renderBoard(board([lead()]));
    expect(screen.getByText("Asha")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("Gave dates and budget")).toBeInTheDocument();
  });

  it("renders the summary tiles", () => {
    renderBoard(board([lead()]));
    expect(screen.getByText("Hot")).toBeInTheDocument();
    expect(screen.getByText("Awaiting us")).toBeInTheDocument();
  });

  it("shows an empty state when there are no leads", () => {
    renderBoard(board([]));
    expect(
      screen.getByText("No leads scored yet. Scoring runs in the background."),
    ).toBeInTheDocument();
  });

  it("labels an unscored lead rather than showing a blank score", () => {
    renderBoard(board([lead({ score: null, band: null, reason: null })]));
    expect(screen.getByText("Unscored")).toBeInTheDocument();
  });

  it("filters by band", async () => {
    const user = userEvent.setup();
    renderBoard(
      board([
        lead({ analysisId: "a1", contactName: "HotLead", band: "hot", score: 9 }),
        lead({ analysisId: "a2", contactName: "ColdLead", band: "cold", score: 2 }),
      ]),
    );
    await user.selectOptions(screen.getByLabelText("Band"), "hot");
    expect(screen.getByText("HotLead")).toBeInTheDocument();
    expect(screen.queryByText("ColdLead")).not.toBeInTheDocument();
  });

  it("filters by search text across name and phone", async () => {
    const user = userEvent.setup();
    renderBoard(
      board([
        lead({ analysisId: "a1", contactName: "Asha", contactPhone: "+971500000001" }),
        lead({ analysisId: "a2", contactName: "Bilal", contactPhone: "+971500000002" }),
      ]),
    );
    await user.type(screen.getByLabelText("Search name or phone"), "Bilal");
    expect(screen.getByText("Bilal")).toBeInTheDocument();
    expect(screen.queryByText("Asha")).not.toBeInTheDocument();
  });

  it("calls onReanalyze with the row when the button is clicked", async () => {
    const user = userEvent.setup();
    const { onReanalyze } = renderBoard(board([lead()]));
    await user.click(screen.getByRole("button", { name: "Re-analyze" }));
    expect(onReanalyze).toHaveBeenCalledWith(expect.objectContaining({ analysisId: "a1" }));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/components/lead-analysis/lead-analysis-board.test.tsx`
Expected: FAIL — `Failed to resolve import "./lead-analysis-board"`.

- [ ] **Step 4: Implement the component**

Create `src/components/lead-analysis/lead-analysis-board.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ============================================================
// The Lead Analysis board — PRESENTATIONAL ONLY, so it can be rendered
// with mock data for visual verification and unit-tested without Convex
// (the same split `leads-board-view.tsx` uses). All filtering is
// client-side over the single bounded payload the board query returns.
// ============================================================

export type LeadBandKey = "hot" | "warm" | "cold";
export type LeadLaneKey = "awaiting_us" | "awaiting_them";

export interface LeadAnalysisRow {
  analysisId: string;
  conversationId: string;
  contactName: string;
  contactPhone: string;
  score: number | null;
  band: LeadBandKey | null;
  reason: string | null;
  signals: string[];
  lane: LeadLaneKey;
  scoreStatus: string;
  lastMessageAt: number | null;
  daysSinceLastMessage: number | null;
  assigneeName: string | null;
  source: "ad" | "website" | "organic";
  serviceName: string | null;
  sequenceStatus: string;
  followUpsSent: number;
  scoredAt: number | null;
}

export interface LeadAnalysisBoardData {
  summary: {
    hot: number;
    warm: number;
    cold: number;
    awaitingUs: number;
    awaitingThem: number;
    unscored: number;
    total: number;
    avgScore: number;
  };
  leads: LeadAnalysisRow[];
}

const BAND_CLASS: Record<LeadBandKey, string> = {
  hot: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
  warm: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  cold: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export function LeadAnalysisBoard({
  board,
  canReanalyze,
  onReanalyze,
}: {
  board: LeadAnalysisBoardData;
  canReanalyze: boolean;
  onReanalyze: (lead: LeadAnalysisRow) => void;
}) {
  const t = useTranslations("LeadAnalysis");
  const [bandFilter, setBandFilter] = useState<"all" | LeadBandKey>("all");
  const [laneFilter, setLaneFilter] = useState<"all" | LeadLaneKey>("all");
  const [search, setSearch] = useState("");

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return board.leads.filter((lead) => {
      if (bandFilter !== "all" && lead.band !== bandFilter) return false;
      if (laneFilter !== "all" && lead.lane !== laneFilter) return false;
      if (needle) {
        const haystack = `${lead.contactName} ${lead.contactPhone}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }, [board.leads, bandFilter, laneFilter, search]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label={t("tiles.hot")} value={board.summary.hot} />
        <Tile label={t("tiles.warm")} value={board.summary.warm} />
        <Tile label={t("tiles.cold")} value={board.summary.cold} />
        <Tile label={t("tiles.awaitingUs")} value={board.summary.awaitingUs} />
        <Tile label={t("tiles.unscored")} value={board.summary.unscored} />
        <Tile label={t("tiles.avgScore")} value={board.summary.avgScore} />
      </dl>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="band-filter">{t("filters.band")}</Label>
          <select
            id="band-filter"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={bandFilter}
            onChange={(e) => setBandFilter(e.target.value as "all" | LeadBandKey)}
          >
            <option value="all">{t("filters.all")}</option>
            <option value="hot">{t("tiles.hot")}</option>
            <option value="warm">{t("tiles.warm")}</option>
            <option value="cold">{t("tiles.cold")}</option>
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="lane-filter">{t("filters.lane")}</Label>
          <select
            id="lane-filter"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={laneFilter}
            onChange={(e) => setLaneFilter(e.target.value as "all" | LeadLaneKey)}
          >
            <option value="all">{t("filters.all")}</option>
            <option value="awaiting_us">{t("lane.awaiting_us")}</option>
            <option value="awaiting_them">{t("lane.awaiting_them")}</option>
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="lead-search">{t("filters.search")}</Label>
          <Input
            id="lead-search"
            className="w-56"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {visible.map((lead) => (
            <li
              key={lead.analysisId}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
            >
              <span
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                  lead.band ? BAND_CLASS[lead.band] : "bg-muted text-muted-foreground",
                )}
                title={lead.reason ?? undefined}
              >
                {lead.score ?? "–"}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{lead.contactName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {lead.reason ?? t("row.unscored")}
                </p>
              </div>

              <Badge variant="secondary">{t(`lane.${lead.lane}`)}</Badge>

              <span className="text-xs text-muted-foreground">
                {lead.daysSinceLastMessage && lead.daysSinceLastMessage > 0
                  ? t("row.daysSilent", { days: lead.daysSinceLastMessage })
                  : t("row.today")}
              </span>

              <Button asChild variant="ghost" size="sm">
                <Link href={`/inbox?conversation=${lead.conversationId}`}>
                  {t("row.openChat")}
                </Link>
              </Button>

              {canReanalyze && (
                <Button variant="outline" size="sm" onClick={() => onReanalyze(lead)}>
                  {t("row.reanalyze")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold">{value}</dd>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/lead-analysis/lead-analysis-board.test.tsx`
Expected: PASS, 7 tests.

If `Tile` labels collide with row text in `getByText`, scope the tile assertions with `within(screen.getByRole("list"))` or a `data-testid` — do not weaken the assertion to `queryAllByText`.

- [ ] **Step 6: Commit**

```bash
git add src/components/lead-analysis/lead-analysis-board.tsx src/components/lead-analysis/lead-analysis-board.test.tsx messages/en.json
git commit -m "$(cat <<'EOF'
feat(lead-analysis): presentational board component

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: The page and navigation

**Files:**
- Create: `src/app/(dashboard)/lead-analysis/page.tsx`
- Modify: `src/lib/auth/roles.ts` (`AGENT_NAV`, `SUPERVISOR_NAV`)
- Modify: `src/lib/auth/roles.test.ts`
- Modify: `src/components/layout/sidebar.tsx:94-101` (`navItems`)
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.leadAnalysis.board` / `api.leadAnalysis.reanalyze` (Task 10); `LeadAnalysisBoard` (Task 11).
- Produces: the `/lead-analysis` route.

**Critical:** `src/lib/auth/roles.ts` is an **allowlist**, deliberately — its own comment states that adding an entry "must be a conscious act". `canAccessRoute` route-guards every page through it, so **without the roles.ts edit the new page is inaccessible to agents and supervisors**, and the sidebar link is filtered out for them.

- [ ] **Step 1: Create the page**

Create `src/app/(dashboard)/lead-analysis/page.tsx`:

```tsx
'use client';

import { useCallback } from 'react';
import { useMutation } from 'convex/react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import {
  LeadAnalysisBoard,
  type LeadAnalysisRow,
} from '@/components/lead-analysis/lead-analysis-board';

import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

// ============================================================
// /lead-analysis — thin data wrapper over LeadAnalysisBoard (the
// presentational board, kept separate so it can be rendered with mock
// data for visual verification). RBAC: agents see only their own
// assigned leads (the query filters server-side); viewers have no board.
// ============================================================

export default function LeadAnalysisPage() {
  const t = useTranslations('LeadAnalysis');
  const { accountRole } = useAuth();
  const canView =
    accountRole === 'agent' ||
    accountRole === 'supervisor' ||
    accountRole === 'admin' ||
    accountRole === 'owner';

  const board = useQuery(api.leadAnalysis.board, canView ? {} : 'skip');
  const reanalyze = useMutation(api.leadAnalysis.reanalyze);

  const handleReanalyze = useCallback(
    async (lead: LeadAnalysisRow) => {
      try {
        await reanalyze({
          conversationId: lead.conversationId as Id<'conversations'>,
        });
        toast.success(t('reanalyzeQueued'));
      } catch (err) {
        console.error('Failed to queue re-analysis:', err);
        toast.error(t('reanalyzeError'));
      }
    },
    [reanalyze, t],
  );

  if (!canView) {
    return <p className="mt-8 text-sm text-muted-foreground">{t('empty')}</p>;
  }
  if (!board) {
    return <p className="mt-8 text-sm text-muted-foreground">{t('loading')}</p>;
  }
  return (
    <LeadAnalysisBoard
      board={board}
      canReanalyze={canView}
      onReanalyze={handleReanalyze}
    />
  );
}
```

- [ ] **Step 2: Write the failing role-allowlist test**

In `src/lib/auth/roles.test.ts`, beside the existing `/leads` assertions (~lines 172 and 198), add:

```ts
    expect(canAccessNav("supervisor", "/lead-analysis")).toBe(true);
    expect(canAccessNav("agent", "/lead-analysis")).toBe(true);
    expect(canAccessNav("viewer", "/lead-analysis")).toBe(false);
    expect(canAccessRoute("agent", "/lead-analysis")).toBe(true);
```

Ensure `canAccessRoute` is in the file's import list from `./roles`.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/auth/roles.test.ts`
Expected: FAIL — `canAccessNav("agent", "/lead-analysis")` returns `false`.

- [ ] **Step 4: Add the route to both allowlists**

In `src/lib/auth/roles.ts`, extend `AGENT_NAV` (line 149) and `SUPERVISOR_NAV` (line 165):

```ts
export const AGENT_NAV = ["/inbox", "/notifications", "/leads", "/lead-analysis"] as const;
```

```ts
export const SUPERVISOR_NAV = [
  "/dashboard",
  "/inbox",
  "/notifications",
  "/leads",
  "/lead-analysis",
  "/contacts",
  "/pipelines",
  "/broadcasts",
  "/campaigns",
  "/settings",
] as const;
```

`VIEWER_NAV` is deliberately left alone — viewers have no lead board.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/auth/roles.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the sidebar entry**

In `src/components/layout/sidebar.tsx`, add to `navItems` (line 94) directly after the `/leads` entry:

```ts
  { href: "/lead-analysis", labelKey: "leadAnalysis", icon: Gauge },
```

Add `Gauge` to the existing `lucide-react` import in that file.

- [ ] **Step 7: Add the nav label**

In `messages/en.json`, in the same block that holds the existing `"leads"` nav label (find it with `grep -n '"leads"' messages/en.json` — it is the nav/sidebar block, not the `"Leads"` page block added in Task 11), add:

```json
    "leadAnalysis": "Lead Analysis",
```

- [ ] **Step 8: Typecheck the whole app**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Lint the changed files only**

Run: `npx eslint "src/app/(dashboard)/lead-analysis/page.tsx" src/components/lead-analysis/lead-analysis-board.tsx src/components/layout/sidebar.tsx`
Expected: no NEW errors on these files. (This repo has pre-existing lint debt, so `npm run lint` over the whole tree is NOT the gate — scope to the changed files.)

- [ ] **Step 10: Run the full test suite**

Run: `npm test`
Expected: PASS — all pre-existing tests plus the ~64 new ones.

- [ ] **Step 11: Commit**

```bash
git add "src/app/(dashboard)/lead-analysis/page.tsx" src/lib/auth/roles.ts src/lib/auth/roles.test.ts src/components/layout/sidebar.tsx messages/en.json
git commit -m "$(cat <<'EOF'
feat(lead-analysis): /lead-analysis page, nav entry, and role allowlist

roles.ts is an allowlist by design — the route must be added there or
agents and supervisors are route-guarded out of the new page.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Deployment (owner-run, after all tasks land)

P1 is inert until both steps happen:

1. **Deploy the schema and functions.** `leadAnalyses`, `leadAnalysisConfigs`, the widened `aiUsageLog.mode`, and the `lead-scoring` cron all require a `convex deploy` run by the owner. No agent session runs it.
2. **Enable the feature.** Set `enabled: true` on the account's `leadAnalysisConfigs` row (via `api.leadAnalysis.updateConfig` as an admin). Until then the cron finds no rows and costs nothing.

Once enabled, scoring begins on the next inbound message, and the backfill walks the account's history at `backfillPerRun` (10) conversations per 5-minute idle sweep — roughly 120/hour. An account with 500 historical conversations is fully scored in about four hours.

## What P1 deliberately does not do

Archive, un-archive, inbox exclusion, the follow-up sequence, template sends, bulk actions, and the config UI are all **P2–P4**. Each gets its own plan. `leadAnalyses.sequenceStatus` never leaves `"idle"` in P1, and no code path in P1 sends a WhatsApp message.
