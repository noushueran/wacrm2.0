# Revival agent (backend core) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent that finds quiet leads still inside the 24-hour window, drafts a message grounded in their actual trip, and queues it for one-tap human approval — with every guard re-checked at send time.

**Architecture:** Pure selection and guard logic in `convex/lib/revival/` (no ctx, unit-tested). A 30-minute cron sweeps candidates and generates drafts into a `revivalDrafts` queue. A separate `send` mutation re-validates and dispatches. Dormant-safe: `revivalConfigs.enabled` defaults false, so with no config the sweep finds nothing and costs nothing.

**Tech Stack:** Convex, convex-test, vitest, TypeScript.

**Scope:** Backend only. The approval UI and the inbox banner are a follow-on plan; this one ends with a queue that fills correctly and a send path that is safe. Template drafting for the cold stock is also separate.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-09-revival-agent-design.md`. Read it first.
- Tests: `npx vitest run`. Typecheck: `npx tsc --noEmit`. Lint changed files only: `npx eslint <file>`.
- **Never** run `convex deploy` / `convex dev` / `convex codegen`. New modules must be hand-registered in `convex/_generated/api.d.ts` — both the import and the `FullApi` key, alphabetically. `convex/generatedApi.test.ts` enforces this and covers `lib/**` modules too.
- Stage git paths explicitly. Concurrent sessions share this tree.
- Every read in a cron or live query must be bounded. See `convex/lib/cronSummary.ts`'s `SYSTEM_SCAN_WINDOW` for the production outage that rule comes from.
- **Nothing in this plan may send a message without a human action.** Auto-send is deliberately absent; do not add it.
- Meta's customer-service window is **24 hours**. `qualificationConfigs.sessionWindowHours` (72) is an internal lane setting and must never be used as the channel decision.

---

### Task 1: Schema — config, queue, and the `revive` usage mode

**Files:**
- Modify: `convex/schema.ts`
- Modify: `convex/aiUsage.ts` (the `log` args union — a separate union from the table's, which has drifted before)
- Modify: `src/components/agents/ai-usage.tsx` (`byMode` record, `UsageResponse.by_mode`, and a tile)
- Test: `convex/aiUsage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `revivalConfigs` and `revivalDrafts`; `aiUsageLog.mode` accepts `"revive"`. Tasks 2–5 depend on all three.

- [ ] **Step 1: Write the failing test**

Append to `convex/aiUsage.test.ts`:

```ts
test("the revival agent logs under its own mode", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  await t.mutation(internal.aiUsage.log, {
    accountId,
    mode: "revive",
    provider: "openai",
    model: "gpt-5",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });

  const rows = await t.run((ctx) => ctx.db.query("aiUsageLog").collect());
  expect(rows[0]!.mode).toBe("revive");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run convex/aiUsage.test.ts`
Expected: FAIL — the args validator rejects `"revive"`.

- [ ] **Step 3: Add the mode to both unions and the usage tab**

In `convex/schema.ts`, in `aiUsageLog`'s `mode` union, after `v.literal("match_service"),`:

```ts
      // The revival agent (spec 2026-08-09). Its own mode so the roster
      // can report what it drafted today, separately from replies.
      v.literal("revive"),
```

Add the identical literal to `convex/aiUsage.ts`'s `log` args union in the same position.

In `src/components/agents/ai-usage.tsx`, add to the `byMode` initialiser and to `UsageResponse.by_mode`:

```ts
    revive: { calls: 0, tokens: 0 },
```

and add a tile beside the "Ad matching" one, importing `RefreshCw` from `lucide-react`:

```tsx
              {/* Same reasoning as the two tiles above: a mode with no
                  tile is counted in Total and shown in no breakdown. */}
              <Stat
                label="Revival"
                value={formatCompactNumber(data.by_mode.revive.tokens)}
                icon={RefreshCw}
              />
```

- [ ] **Step 4: Add the two tables**

In `convex/schema.ts`, beside the other per-account config tables:

```ts
  // Revival agent config (spec 2026-08-09). One row per account,
  // `by_account` doubling as the uniqueness key — same shape as
  // `aiConfigs`/`leadAnalysisConfigs`. `enabled` defaults FALSE at the
  // read site: with no enabled row the sweep selects nothing, so the
  // feature costs nothing until it is switched on.
  revivalConfigs: defineTable({
    accountId: v.id("accounts"),
    enabled: v.boolean(),
    // How long a lead must have been quiet before it is worth a nudge.
    minQuietMinutes: v.number(),
    // Headroom left before the 24h window shuts, so a queued draft
    // cannot be approved into an already-expired window.
    windowSafetyMinutes: v.number(),
    // No second draft for the same conversation inside this many hours,
    // in ANY status — a dismissed draft is a "no", not a retry.
    cooldownHours: v.number(),
    draftsPerRun: v.number(),
    dailyDraftCap: v.number(),
    minLeadScore: v.number(),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One queued draft. Modelled on `tagSuggestions` — the same
  // propose-then-accept shape already proven in the inbox.
  revivalDrafts: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    body: v.string(),
    // Why this lead, now — shown to the approver so they are accepting a
    // judgement rather than just a sentence.
    reason: v.string(),
    // "template" exists so the cold-stock path needs no schema change
    // once Meta approves re-engagement templates. Nothing writes it yet.
    channel: v.union(v.literal("free_text"), v.literal("template")),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("dismissed"),
      v.literal("expired"),
    ),
    // Routes to the lead's owner when there is one, rather than the
    // shared queue. Assignment is deliberately not a disqualifier.
    assignedToUserId: v.optional(v.id("users")),
    model: v.string(),
    confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    reviewedByUserId: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    createdAt: v.number(),
    // When the 24h window shuts. What keeps the queue honest: a draft
    // past this is swept to `expired` rather than looking sendable.
    expiresAt: v.number(),
  })
    .index("by_account_status", ["accountId", "status"])
    .index("by_conversation", ["conversationId"]),
```

- [ ] **Step 5: Verify**

Run: `npx vitest run convex/aiUsage.test.ts convex/schema.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: exit 0. If `ai-usage.tsx` still errors, the `UsageResponse.by_mode` interface is missing `revive` — add it there too.

- [ ] **Step 6: Commit**

```bash
git add convex/schema.ts convex/aiUsage.ts convex/aiUsage.test.ts src/components/agents/ai-usage.tsx
git commit -m "feat(revival): the queue, its config, and the agent's own usage mode"
```

---

### Task 2: Pure selection and guard logic

Extracted from the engine so it tests without a ctx, matching `lib/cronSummary.ts` and `lib/agentRegistry.ts`.

**Files:**
- Create: `convex/lib/revival/select.ts`
- Create: `convex/lib/revival/select.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DEFAULT_REVIVAL_CONFIG`, `WINDOW_MS`, types `RevivalConfig` / `CandidateInput` / `SkipReason`, and functions `candidateSkipReason(input, config, now): SkipReason | null` and `sendBlockReason(input, now): SkipReason | null`. Tasks 3 and 4 consume both.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/revival/select.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  DEFAULT_REVIVAL_CONFIG,
  WINDOW_MS,
  candidateSkipReason,
  sendBlockReason,
  type CandidateInput,
} from "./select";

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function candidate(over: Partial<CandidateInput> = {}): CandidateInput {
  return {
    lastMessageAt: NOW - 240 * MIN,
    lastMessageInbound: true,
    snoozedUntil: null,
    doNotContact: false,
    archived: false,
    qualificationCollecting: false,
    lastDraftAt: null,
    leadScore: 70,
    ...over,
  };
}

test("a lead quiet inside the window with nothing against it is a candidate", () => {
  expect(candidateSkipReason(candidate(), DEFAULT_REVIVAL_CONFIG, NOW)).toBeNull();
});

test("we do not chase a lead we spoke to last", () => {
  expect(
    candidateSkipReason(candidate({ lastMessageInbound: false }), DEFAULT_REVIVAL_CONFIG, NOW),
  ).toBe("we_spoke_last");
});

test("a lead who has only just gone quiet is left alone", () => {
  expect(
    candidateSkipReason(candidate({ lastMessageAt: NOW - 10 * MIN }), DEFAULT_REVIVAL_CONFIG, NOW),
  ).toBe("too_recent");
});

test("the window-safety margin excludes a lead too close to the 24h edge", () => {
  // 23h30m quiet: still technically in-window, but under the 60m of
  // headroom a queued draft needs to survive until a human taps send.
  const almostShut = NOW - (WINDOW_MS - 30 * MIN);
  expect(
    candidateSkipReason(candidate({ lastMessageAt: almostShut }), DEFAULT_REVIVAL_CONFIG, NOW),
  ).toBe("window_closing");
});

test("a lead past the 24h window is out of reach without a template", () => {
  expect(
    candidateSkipReason(
      candidate({ lastMessageAt: NOW - 30 * 60 * MIN }),
      DEFAULT_REVIVAL_CONFIG,
      NOW,
    ),
  ).toBe("window_closing");
});

test("snoozed, do-not-contact, and archived leads are all skipped", () => {
  const c = DEFAULT_REVIVAL_CONFIG;
  expect(candidateSkipReason(candidate({ snoozedUntil: NOW + MIN }), c, NOW)).toBe("snoozed");
  expect(candidateSkipReason(candidate({ doNotContact: true }), c, NOW)).toBe("do_not_contact");
  expect(candidateSkipReason(candidate({ archived: true }), c, NOW)).toBe("archived");
});

test("an expired snooze does not skip", () => {
  expect(
    candidateSkipReason(candidate({ snoozedUntil: NOW - MIN }), DEFAULT_REVIVAL_CONFIG, NOW),
  ).toBeNull();
});

test("a lead the qualification engine is already working is left to it", () => {
  expect(
    candidateSkipReason(candidate({ qualificationCollecting: true }), DEFAULT_REVIVAL_CONFIG, NOW),
  ).toBe("qualification_active");
});

test("cooldown suppresses a second draft, and lapses afterwards", () => {
  const c = DEFAULT_REVIVAL_CONFIG;
  expect(candidateSkipReason(candidate({ lastDraftAt: NOW - 60 * MIN }), c, NOW)).toBe("cooldown");
  const past = NOW - (c.cooldownHours * 60 + 1) * MIN;
  expect(candidateSkipReason(candidate({ lastDraftAt: past }), c, NOW)).toBeNull();
});

test("a lead below the score floor is not worth a nudge", () => {
  const c = { ...DEFAULT_REVIVAL_CONFIG, minLeadScore: 50 };
  expect(candidateSkipReason(candidate({ leadScore: 20 }), c, NOW)).toBe("score_too_low");
  // An unscored lead is not a low-scored one — it must not be excluded.
  expect(candidateSkipReason(candidate({ leadScore: null }), c, NOW)).toBeNull();
});

test("sendBlockReason lets a still-valid draft through", () => {
  expect(sendBlockReason({ ...candidate(), status: "pending", expiresAt: NOW + MIN }, NOW))
    .toBeNull();
});

test("a customer reply since drafting blocks the send", () => {
  // The draft was made 4h ago; they replied 2m ago. Sending the nudge
  // now would talk over them.
  expect(
    sendBlockReason(
      { ...candidate({ lastMessageAt: NOW - 2 * MIN }), status: "pending", expiresAt: NOW + MIN, draftedAt: NOW - 240 * MIN },
      NOW,
    ),
  ).toBe("customer_replied");
});

test("an expired or already-actioned draft can never be sent", () => {
  expect(
    sendBlockReason({ ...candidate(), status: "pending", expiresAt: NOW - MIN }, NOW),
  ).toBe("expired");
  expect(
    sendBlockReason({ ...candidate(), status: "sent", expiresAt: NOW + MIN }, NOW),
  ).toBe("already_actioned");
  expect(
    sendBlockReason({ ...candidate(), status: "dismissed", expiresAt: NOW + MIN }, NOW),
  ).toBe("already_actioned");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run convex/lib/revival/select.test.ts`
Expected: FAIL — cannot resolve `./select`.

- [ ] **Step 3: Write the implementation**

Create `convex/lib/revival/select.ts`:

```ts
/**
 * Revival agent — who is worth chasing, and whether a queued draft is
 * still safe to send.
 *
 * Pure (no ctx, no `_generated` imports) so both decisions carry unit
 * tests, the same reason `cronSummary.ts` and `agentRegistry.ts` are.
 * These two functions are the whole safety story of this feature: one
 * decides who we may write to, the other is re-run at send time so a
 * draft that sat in the queue can never go out into changed
 * circumstances.
 */

/** Meta's customer-service window. NOT
 *  `qualificationConfigs.sessionWindowHours` (72), which is an internal
 *  lane setting — confusing the two would send free text into a shut
 *  window and get it rejected by the Cloud API. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RevivalConfig {
  enabled: boolean;
  minQuietMinutes: number;
  windowSafetyMinutes: number;
  cooldownHours: number;
  draftsPerRun: number;
  dailyDraftCap: number;
  minLeadScore: number;
}

export const DEFAULT_REVIVAL_CONFIG: RevivalConfig = {
  enabled: false,
  minQuietMinutes: 180,
  windowSafetyMinutes: 60,
  cooldownHours: 72,
  draftsPerRun: 20,
  dailyDraftCap: 50,
  minLeadScore: 0,
};

export type SkipReason =
  | "we_spoke_last"
  | "too_recent"
  | "window_closing"
  | "snoozed"
  | "do_not_contact"
  | "archived"
  | "qualification_active"
  | "cooldown"
  | "score_too_low"
  | "customer_replied"
  | "expired"
  | "already_actioned";

export interface CandidateInput {
  lastMessageAt: number;
  /** True when the customer spoke last. We never chase our own turn. */
  lastMessageInbound: boolean;
  snoozedUntil: number | null;
  doNotContact: boolean;
  archived: boolean;
  qualificationCollecting: boolean;
  /** `createdAt` of the most recent draft for this conversation, any status. */
  lastDraftAt: number | null;
  /** Null when the lead has never been scored — not the same as zero. */
  leadScore: number | null;
}

/**
 * Why this conversation is not worth a draft right now, or null when it
 * is. Order matters only for which reason gets reported; every check is
 * independent.
 *
 * `leadScore: null` deliberately passes the score floor. An unscored
 * lead is not a low-scoring one, and excluding it would silently make
 * the whole feature depend on Lead Analysis being enabled.
 */
export function candidateSkipReason(
  input: CandidateInput,
  config: RevivalConfig,
  now: number,
): SkipReason | null {
  if (!input.lastMessageInbound) return "we_spoke_last";
  if (input.doNotContact) return "do_not_contact";
  if (input.archived) return "archived";
  if (input.snoozedUntil !== null && input.snoozedUntil > now) return "snoozed";
  if (input.qualificationCollecting) return "qualification_active";

  const quietMs = now - input.lastMessageAt;
  if (quietMs < config.minQuietMinutes * 60_000) return "too_recent";

  // The margin is what makes a QUEUED draft safe: a human may not tap
  // send for a while, and a message that lands after the window shuts is
  // rejected by Meta.
  const latestUsable = WINDOW_MS - config.windowSafetyMinutes * 60_000;
  if (quietMs >= latestUsable) return "window_closing";

  if (
    input.lastDraftAt !== null &&
    now - input.lastDraftAt < config.cooldownHours * 3_600_000
  ) {
    return "cooldown";
  }

  if (input.leadScore !== null && input.leadScore < config.minLeadScore) {
    return "score_too_low";
  }

  return null;
}

export interface SendCheckInput extends CandidateInput {
  status: "pending" | "sent" | "dismissed" | "expired";
  expiresAt: number;
  /** When the draft was created; anything newer from the customer wins. */
  draftedAt?: number;
}

/**
 * Re-run at send time, never trusted from draft time. A draft can sit in
 * the queue for hours, and in that time the customer may reply, the
 * thread may be snoozed, or the window may shut.
 */
export function sendBlockReason(
  input: SendCheckInput,
  now: number,
): SkipReason | null {
  if (input.status !== "pending") return "already_actioned";
  if (input.expiresAt <= now) return "expired";
  if (input.doNotContact) return "do_not_contact";
  if (input.archived) return "archived";
  if (input.snoozedUntil !== null && input.snoozedUntil > now) return "snoozed";

  // They answered while the draft waited — sending now talks over them.
  if (input.draftedAt !== undefined && input.lastMessageAt > input.draftedAt) {
    return "customer_replied";
  }

  if (now - input.lastMessageAt >= WINDOW_MS) return "expired";

  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/lib/revival/select.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Register the module and commit**

Add to `convex/_generated/api.d.ts`, alphabetically (after `lib_reportStats`, before `lib_roles`):

```ts
import type * as lib_revival_select from "../lib/revival/select.js";
```

and in the `FullApi` map:

```ts
  "lib/revival/select": typeof lib_revival_select;
```

Run: `npx vitest run convex/generatedApi.test.ts`
Expected: PASS.

```bash
git add convex/lib/revival/select.ts convex/lib/revival/select.test.ts convex/_generated/api.d.ts
git commit -m "feat(revival): who is worth chasing, and when a queued draft goes stale"
```

---

### Task 3: The prompt

**Files:**
- Create: `convex/lib/revival/prompt.ts`
- Create: `convex/lib/revival/prompt.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildRevivalPrompt(input): string`, `parseRevivalDraft(raw): ParsedDraft | null`, `SYNTHETIC_REVIVAL_RAW`. Task 4 consumes all three.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/revival/prompt.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  SYNTHETIC_REVIVAL_RAW,
  buildRevivalPrompt,
  parseRevivalDraft,
} from "./prompt";

test("the prompt carries the trip detail the message must reference", () => {
  const p = buildRevivalPrompt({
    contactName: "Ravi",
    serviceName: "UAE Visa Services",
    profileLines: ["destination: Dubai", "dates: mid December", "pax: 2 adults"],
    quietHours: 5,
  });
  expect(p).toContain("Ravi");
  expect(p).toContain("UAE Visa Services");
  expect(p).toContain("mid December");
  expect(p).toContain("5");
});

test("the prompt forbids inventing commercial facts", () => {
  const p = buildRevivalPrompt({
    contactName: null,
    serviceName: null,
    profileLines: [],
    quietHours: 4,
  });
  expect(p.toLowerCase()).toContain("price");
  expect(p.toLowerCase()).toContain("do not");
});

test("a well-formed reply parses into body, reason, and confidence", () => {
  const parsed = parseRevivalDraft(
    JSON.stringify({
      body: "Hi Ravi, still planning Dubai for December?",
      reason: "Asked about visa timing, went quiet 5h ago",
      confidence: "high",
    }),
  );
  expect(parsed?.body).toContain("Dubai");
  expect(parsed?.reason).toContain("visa");
  expect(parsed?.confidence).toBe("high");
});

test("parsing never throws on junk — it returns null", () => {
  expect(parseRevivalDraft("not json at all")).toBeNull();
  expect(parseRevivalDraft("{}")).toBeNull();
  expect(parseRevivalDraft(JSON.stringify({ body: "   " }))).toBeNull();
});

test("an unknown confidence degrades to low rather than being trusted", () => {
  const parsed = parseRevivalDraft(
    JSON.stringify({ body: "Hello", reason: "r", confidence: "certain" }),
  );
  expect(parsed?.confidence).toBe("low");
});

test("fenced JSON from a chatty model still parses", () => {
  const parsed = parseRevivalDraft(
    '```json\n{"body":"Hi","reason":"r","confidence":"medium"}\n```',
  );
  expect(parsed?.body).toBe("Hi");
});

test("the synthetic draft parses, so dry-run exercises the real path", () => {
  expect(parseRevivalDraft(SYNTHETIC_REVIVAL_RAW)).not.toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run convex/lib/revival/prompt.test.ts`
Expected: FAIL — cannot resolve `./prompt`.

- [ ] **Step 3: Write the implementation**

Create `convex/lib/revival/prompt.ts`:

```ts
/**
 * Revival agent prompt and response parsing. Pure, so both carry unit
 * tests without a provider — same split as `lib/leadAnalysis/prompt.ts`.
 */

export interface RevivalPromptInput {
  contactName: string | null;
  serviceName: string | null;
  /** Rendered "field: value" lines from the qualification profile. */
  profileLines: string[];
  quietHours: number;
}

export function buildRevivalPrompt(input: RevivalPromptInput): string {
  const who = input.contactName ?? "this customer";
  const service = input.serviceName ?? "what they asked about";
  const profile = input.profileLines.length
    ? input.profileLines.join("\n")
    : "(nothing captured yet)";

  return [
    "You write ONE short WhatsApp follow-up to a travel customer who stopped replying.",
    "",
    `Customer: ${who}`,
    `Interested in: ${service}`,
    `Quiet for: ${input.quietHours} hours`,
    "What we know about their trip:",
    profile,
    "",
    "Rules:",
    "- Reply in the SAME language and script they were using, including Manglish.",
    "- Reference their actual trip. A generic 'just checking in' is a failure.",
    "- One or two sentences. This is WhatsApp, not email.",
    "- Do NOT invent a price, a discount, availability, or any commitment.",
    "- Do NOT apologise for messaging, and do not open with 'Sorry to bother'.",
    "- End with one easy question they can answer in a few words.",
    "",
    'Return ONLY JSON: {"body": string, "reason": string, "confidence": "high"|"medium"|"low"}',
    "`reason` is one line for a human reviewer explaining why this lead, now.",
  ].join("\n");
}

export interface ParsedDraft {
  body: string;
  reason: string;
  confidence: "high" | "medium" | "low";
}

/**
 * Never throws. A model that returns junk must degrade to "no draft",
 * not take down the sweep — same contract as
 * `lib/ai/classify.ts`'s `parseClassification`.
 */
export function parseRevivalDraft(raw: string): ParsedDraft | null {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const body = typeof obj.body === "string" ? obj.body.trim() : "";
  if (!body) return null;

  const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
  // Anything the model invents beyond the three known values is treated
  // as low — an unrecognised confidence is not evidence of confidence.
  const c = obj.confidence;
  const confidence =
    c === "high" || c === "medium" || c === "low" ? c : "low";

  return { body, reason, confidence };
}

/** DRY-RUN stand-in, so tests exercise the real parse path with no
 *  network — mirrors `aiTagging`'s `syntheticClassifyRaw`. */
export const SYNTHETIC_REVIVAL_RAW = JSON.stringify({
  body: "Hi! Still thinking about the trip? Happy to help with the next step.",
  reason: "Synthetic dry-run draft",
  confidence: "low",
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/lib/revival/prompt.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Register and commit**

Add to `convex/_generated/api.d.ts` alphabetically (`lib/revival/prompt` sorts before `lib/revival/select`):

```ts
import type * as lib_revival_prompt from "../lib/revival/prompt.js";
```
```ts
  "lib/revival/prompt": typeof lib_revival_prompt;
```

```bash
git add convex/lib/revival/prompt.ts convex/lib/revival/prompt.test.ts convex/_generated/api.d.ts
git commit -m "feat(revival): the prompt, and a parser that never throws"
```

---

### Task 4: The sweep — generate drafts into the queue

**Files:**
- Create: `convex/revivalEngine.ts`
- Create: `convex/revivalEngine.test.ts`
- Modify: `convex/crons.ts`, `convex/cronSchedules.ts`, `convex/lib/cronSummary.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `internal.revivalEngine.sweep`, and the `revival-sweep` cron. Task 5 consumes the queue rows it writes.

- [ ] **Step 1: Write the failing test**

Create `convex/revivalEngine.test.ts` covering, with `CONVEX_AI_DRY_RUN` set so no provider is touched:

```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("/convex/**/*.ts");

beforeEach(() => {
  vi.stubEnv("CONVEX_AI_DRY_RUN", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

test("with no config the sweep writes nothing and costs nothing", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(internal.revivalEngine.sweep, {});
  const drafts = await t.run((ctx) => ctx.db.query("revivalDrafts").collect());
  expect(drafts).toHaveLength(0);
});

test("a disabled config is also a no-op", async () => {
  // Seed an account + revivalConfigs with enabled:false and a perfect
  // candidate; assert zero drafts.
});

test("an enabled config drafts for a quiet in-window lead", async () => {
  // Seed account, aiConfigs (active), revivalConfigs enabled, a contact,
  // a conversation whose last message is inbound 4h ago, and that
  // message row. Assert exactly one pending revivalDrafts row, with
  // channel "free_text" and expiresAt == lastMessageAt + 24h.
});

test("the draft routes to the lead's assignee when there is one", async () => {
  // Same as above with conversation.assignedToUserId set; assert the
  // draft carries that assignedToUserId.
});

test("draftsPerRun bounds one sweep", async () => {
  // Seed 5 candidates with draftsPerRun: 2; assert 2 drafts.
});

test("the sweep is idempotent across runs — cooldown blocks a second draft", async () => {
  // Run sweep twice; assert still exactly one draft per conversation.
});
```

Fill each stub in following the seeding style of `convex/leadAnalysisEngine.test.ts`, which already seeds accounts, conversations, and messages for a cron-driven engine.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run convex/revivalEngine.test.ts`
Expected: FAIL — `internal.revivalEngine` does not exist.

- [ ] **Step 3: Implement the engine**

Create `convex/revivalEngine.ts` as an `internalAction` `sweep` plus the small internal query/mutation it needs, following `leadAnalysisEngine.sweepScoring`'s shape:

1. `loadEnabledConfig(ctx, accountId)` — returns null unless `enabled`, so every entry point is dormant-safe.
2. A bounded candidate query: conversations by account, `.take(500)`, mapped to `CandidateInput` and filtered through `candidateSkipReason`. Order survivors by lead score descending.

   **The mapping is not one-to-one — verified against the schema on 2026-08-09:**

   | `CandidateInput` field | Source | Note |
   |---|---|---|
   | `lastMessageAt` | `conversations.lastMessageAt` | **optional** — skip such a conversation before mapping; defaulting to `0` would make it look infinitely quiet and always qualify |
   | `archived` | `conversations.archivedAt !== undefined` | presence is the system of record; there is no boolean `archived` |
   | `snoozedUntil` | `conversations.snoozedUntil ?? null` | presence = snoozed |
   | `doNotContact` | **`contacts.doNotContact`** — on the contact, not the conversation | an optional object; presence = do-not-contact |
   | `lastMessageInbound` | direction of the newest `messages` row | `lastMessageAt` counts outbound messages too, so it cannot answer this on its own |

   For do-not-contact, call `blockedReason` from `convex/lib/notes/gate.ts` rather than reading the field directly. It is the gate `leadAnalysisEngine` already runs on every chase sweep, and a second hand-rolled check is how the two drift apart.
3. Enforce `dailyDraftCap` by counting `revivalDrafts` created since local midnight (bounded `.take(dailyDraftCap + 1)`), then `draftsPerRun`. `log()` when either truncates the run.
4. Per survivor: build the prompt, call `generateReply` at `aiJudgeModel`/`aiJudgeReasoningEffort` with `promptCacheKey(accountId, "revive")` — or `SYNTHETIC_REVIVAL_RAW` under `CONVEX_AI_DRY_RUN`. Parse with `parseRevivalDraft`; a null parse skips that lead without failing the sweep.
5. Insert the `revivalDrafts` row: `status: "pending"`, `channel: "free_text"`, `expiresAt: lastMessageAt + WINDOW_MS`, `assignedToUserId` copied from the conversation.
6. Best-effort `internal.aiUsage.log` with `mode: "revive"`, wrapped so a logging failure cannot fail the sweep.

- [ ] **Step 4: Register the cron**

`convex/crons.ts`, following the existing comment style:

```ts
// Revival agent (spec 2026-08-09): draft nudges for leads that went
// quiet while still inside the 24h window. Sends NOTHING — every draft
// waits for a human tap. No-op while the feature is disabled.
crons.interval(
  "revival-sweep",
  { minutes: 30 },
  internal.cronSchedules.runRevivalSweep,
  {},
);
```

Add the matching `runRevivalSweep` wrapper in `convex/cronSchedules.ts` (copy `runSweepLeadScoring`'s shape so run history is stamped), and add `{ name: "revival-sweep", intervalMinutes: 30 }` to `CRON_REGISTRY` in `convex/lib/cronSummary.ts`.

- [ ] **Step 5: Verify**

Run: `npx vitest run convex/revivalEngine.test.ts convex/cronSchedules.test.ts`
Expected: PASS. `cronSchedules.test.ts` asserts `crons.ts` and `CRON_REGISTRY` agree — if it fails, one of the three registrations is missing.

Run: `npx vitest run convex/` then `npx tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add convex/revivalEngine.ts convex/revivalEngine.test.ts convex/crons.ts convex/cronSchedules.ts convex/lib/cronSummary.ts convex/_generated/api.d.ts
git commit -m "feat(revival): the sweep that fills the queue, and never sends"
```

---

### Task 5: The send path, and the roster entry

**Files:**
- Create: `convex/revival.ts` (the member-facing queue API)
- Create: `convex/revival.test.ts`
- Modify: `convex/lib/agentRegistry.ts`, `convex/lib/agentRegistry.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `api.revival.queue`, `api.revival.send`, `api.revival.dismiss`. The follow-on UI plan consumes these.

- [ ] **Step 1: Write the failing test**

Create `convex/revival.test.ts` asserting:

- `queue` returns an account's pending drafts and never another account's
- a viewer may read the queue but `send` rejects with `FORBIDDEN`
- `send` on a valid pending draft dispatches, flips status to `sent`, and stamps `reviewedByUserId`
- `send` after the customer replied returns `{blocked: "customer_replied"}` and sends nothing
- `send` on an expired draft returns `{blocked: "expired"}`
- `send` twice returns `{blocked: "already_actioned"}` the second time — the guard against a double-tap or a stale tab
- `dismiss` flips status and stamps the reviewer
- an edited body is what gets sent, not the drafted one

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run convex/revival.test.ts`
Expected: FAIL — `api.revival` does not exist.

- [ ] **Step 3: Implement**

`convex/revival.ts`:

- `queue`: `accountQuery`, member-safe read, bounded `.take(100)` over `by_account_status` with `status: "pending"`, joined to contact name. Returns `{drafts, overflow}`.
- `send`: `accountAction` requiring `agent` role and the same per-conversation RBAC as `aiReply.draft`. Re-reads the draft and conversation, runs `sendBlockReason`, and on any block returns `{blocked: reason}` **without sending**. Otherwise dispatches through the existing outbound send path and marks the row `sent`.
- `dismiss`: `accountMutation`, same role floor, flips to `dismissed` with reviewer and timestamp.

`send` accepts an optional `body` override so an edited message is what goes out; when absent the drafted body is used.

- [ ] **Step 4: Flip the roster entry**

In `convex/lib/agentRegistry.ts`, the `revival` entry becomes:

```ts
    cronName: "revival-sweep",
    built: true,
    modes: ["revive"],
```

Add to `convex/lib/agentRegistry.test.ts`:

```ts
test("the revival agent is built, and claims its cron and mode", () => {
  const revival = AGENT_REGISTRY.find((a) => a.key === "revival")!;
  expect(revival.built).toBe(true);
  expect(revival.cronName).toBe("revival-sweep");
  expect(revival.modes).toEqual(["revive"]);
});
```

Also update `convex/agentRoster.ts`'s switch: `case "revival"` reads `revivalConfigs` for `configured`/`enabled`, exactly as `score` reads `leadAnalysisConfigs`. Without this the agent would show `not_hired` forever despite being built.

- [ ] **Step 5: Verify**

Run: `npx vitest run` then `npx tsc --noEmit` and `npx eslint` on each changed file.
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add convex/revival.ts convex/revival.test.ts convex/lib/agentRegistry.ts convex/lib/agentRegistry.test.ts convex/agentRoster.ts convex/_generated/api.d.ts
git commit -m "feat(revival): one-tap send with every guard re-checked, and the agent on the roster"
```

---

## Self-review

**Spec coverage.** Selection rules — Task 2, every rule asserted. Window-safety margin — Task 2. Generation with trip grounding and no invented prices — Task 3. `revive` usage mode and its roster timesheet — Tasks 1 and 5. Queue table modelled on `tagSuggestions` — Task 1. `expiresAt` — Tasks 1, 2, 4. Assignment routing rather than exclusion — Tasks 1, 4. Caps with logged truncation — Task 4. Re-check every guard at send time — Tasks 2 and 5. Dormancy — Tasks 2 and 4. Roster integration — Task 5. Access control — Task 5.

**Deliberately deferred, not dropped:** the approval UI and inbox banner (follow-on plan, consumes `api.revival.*` from Task 5), and the drafted cold-stock templates (separate deliverable). The spec's `channel: "template"` is schema-only here, written by nothing — stated in Task 1's comment so a reader does not expect it to work.

**Type consistency.** `RevivalConfig`, `CandidateInput`, `SkipReason` defined once in Task 2 and reused in Tasks 4–5. `SendCheckInput` extends `CandidateInput`, so the send path cannot drift from the selection path. `ParsedDraft`'s three fields map to `revivalDrafts.body`/`reason`/`confidence` from Task 1. `WINDOW_MS` is the single definition of the 24-hour window.

**One gap found and closed.** Task 5 originally flipped `built: true` without touching `convex/agentRoster.ts`, whose switch has no `revival` case — the agent would have shown `not_hired` forever while quietly drafting. Step 4 now covers it.
