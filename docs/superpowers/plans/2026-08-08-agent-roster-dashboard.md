# AI agent roster dashboard implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a roster page that presents all ten AI agents as staff — name, duty, live status, and today's work — with every status derived from data the system already writes.

**Architecture:** A pure registry module (`convex/lib/agentRegistry.ts`) holds agent identity, duty text, and status-derivation logic with no ctx, mirroring the `convex/lib/cronSummary.ts` precedent. One member-safe `accountQuery` (`convex/agentRoster.ts`) joins that registry against three config tables, `cronRuns`, and a bounded `aiUsageLog` window. A client component renders it as a new default tab on `/agents`.

**Tech Stack:** Convex (queries, convex-test), Next.js 16 App Router, React, TypeScript, Tailwind, shadcn/ui, lucide-react, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-08-agent-roster-dashboard-design.md`. Read it before starting.
- Node `>=20.0.0`. Tests run with `npx vitest run`.
- **Never** run `convex deploy`, `convex dev`, or `convex codegen` — the owner has reaffirmed this. If a change appears to need regenerated API types, stop and report rather than running codegen.
- Stage git paths explicitly (`git add <path>`), never `git add -A` or `git add .`. Concurrent sessions share this working tree.
- Every read in a live query must be bounded. `convex/lib/cronSummary.ts`'s `SYSTEM_SCAN_WINDOW` comment records an unbounded scan taking the cron panel down in production on 2026-07-18.
- Read-only feature: no mutations, no toggles, no sends. The roster only observes.
- Registry duty text is plain English, returned by the query. Do not add an i18n namespace — the `/agents` page hardcodes its own English headings and only `Agents.usage` has catalogue entries.
- `convex/lib/agentRegistry.ts` must import nothing from `./_generated/server`. It stays pure so it is unit-testable without a ctx, exactly as `summarizeSystemTasks` is.

---

### Task 1: Agent registry and status derivation

**Files:**
- Create: `convex/lib/agentRegistry.ts`
- Create: `convex/lib/agentRegistry.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AGENT_REGISTRY`, types `AgentKey` / `AgentStatus` / `AgentEntry` / `AgentStatusInput`, functions `deriveAgentStatus(input: AgentStatusInput): AgentStatus` and `tallyWork(rows: Array<{ mode: string }>): Record<AgentKey, number>`, constant `ROSTER_SCAN_WINDOW`. Task 3 consumes all of these.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/agentRegistry.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  AGENT_REGISTRY,
  deriveAgentStatus,
  tallyWork,
  type AgentStatusInput,
} from "./agentRegistry";

function input(over: Partial<AgentStatusInput> = {}): AgentStatusInput {
  return {
    built: true,
    configured: true,
    enabled: true,
    onDemand: false,
    lastRunStatus: null,
    blockedReason: null,
    ...over,
  };
}

test("an unbuilt agent is never hired, whatever else is true", () => {
  expect(deriveAgentStatus(input({ built: false }))).toBe("not_hired");
  expect(
    deriveAgentStatus(input({ built: false, enabled: true, configured: true })),
  ).toBe("not_hired");
});

test("a built but unconfigured agent is not hired", () => {
  expect(deriveAgentStatus(input({ configured: false }))).toBe("not_hired");
});

test("a configured but disabled agent is off duty", () => {
  expect(deriveAgentStatus(input({ enabled: false }))).toBe("off_duty");
});

test("attention outranks working", () => {
  expect(
    deriveAgentStatus(input({ lastRunStatus: "running", blockedReason: "no token" })),
  ).toBe("attention");
  expect(deriveAgentStatus(input({ lastRunStatus: "failed" }))).toBe("attention");
});

test("a disabled agent with a blocker reads as off duty, not attention", () => {
  expect(
    deriveAgentStatus(input({ enabled: false, blockedReason: "no token" })),
  ).toBe("off_duty");
});

test("an in-flight run is working; an on-demand agent is on call", () => {
  expect(deriveAgentStatus(input({ lastRunStatus: "running" }))).toBe("working");
  expect(deriveAgentStatus(input({ onDemand: true }))).toBe("on_call");
});

test("a healthy enabled agent is on duty", () => {
  expect(deriveAgentStatus(input({ lastRunStatus: "success" }))).toBe("on_duty");
  expect(deriveAgentStatus(input())).toBe("on_duty");
});

test("tallyWork buckets usage rows by owning agent", () => {
  const counts = tallyWork([
    { mode: "auto_reply" },
    { mode: "auto_reply" },
    { mode: "draft" },
    { mode: "qualify" },
    { mode: "classify" },
    { mode: "match_service" },
  ]);
  expect(counts.reply).toBe(3);
  expect(counts.qualify).toBe(1);
  expect(counts.tags).toBe(1);
  expect(counts.admatch).toBe(1);
  expect(counts.score).toBe(0);
});

test("match_service counts to the ad matcher, never the tag suggester", () => {
  const counts = tallyWork([{ mode: "match_service" }, { mode: "match_service" }]);
  expect(counts.admatch).toBe(2);
  expect(counts.tags).toBe(0);
});

test("shared-sense modes are attributed to no agent", () => {
  const counts = tallyWork([
    { mode: "transcribe" },
    { mode: "describe" },
    { mode: "embed" },
  ]);
  expect(Object.values(counts).every((n) => n === 0)).toBe(true);
});

test("the registry holds ten agents with unique keys", () => {
  expect(AGENT_REGISTRY).toHaveLength(10);
  const keys = AGENT_REGISTRY.map((a) => a.key);
  expect(new Set(keys).size).toBe(10);
});

test("only built agents may claim a cron or usage modes", () => {
  for (const agent of AGENT_REGISTRY) {
    if (!agent.built) {
      expect(agent.cronName).toBeNull();
      expect(agent.modes).toEqual([]);
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/lib/agentRegistry.test.ts`
Expected: FAIL — cannot resolve `./agentRegistry`.

- [ ] **Step 3: Write the implementation**

Create `convex/lib/agentRegistry.ts`:

```ts
/**
 * The agent roster — identity, duty, and status derivation for every AI
 * agent on the platform.
 *
 * A static registry in code, not a table: agents are software, not user
 * data, so identity and the rules that decide their status belong in one
 * reviewable place. Mirrors `CRON_REGISTRY` in `./cronSummary.ts`.
 *
 * Kept PURE (no ctx, no `_generated` imports) for the same reason
 * `summarizeSystemTasks` is: convex-test cannot emulate every ctx
 * surface, and the derivation rules carry the unit tests.
 */

export type AgentKey =
  | "reply"
  | "qualify"
  | "score"
  | "checklist"
  | "tags"
  | "admatch"
  | "revival"
  | "kbgap"
  | "coach"
  | "quote";

export type AgentStatus =
  | "working"
  | "on_duty"
  | "on_call"
  | "attention"
  | "off_duty"
  | "not_hired";

export interface AgentEntry {
  key: AgentKey;
  name: string;
  duty: string;
  /** The `CRON_REGISTRY` name whose run history is this agent's heartbeat. */
  cronName: string | null;
  /** Acts only when a human asks — never on its own schedule. */
  onDemand: boolean;
  /** False for agents that are specced but not written yet. */
  built: boolean;
  /** `aiUsageLog.mode` values whose rows count as this agent's work. */
  modes: string[];
  /** Shown under the status pill when the agent cannot be hired yet. */
  notHiredReason: string | null;
}

export const AGENT_REGISTRY: readonly AgentEntry[] = [
  {
    key: "reply",
    name: "Reply agent",
    duty: "Answers customer questions from the knowledge base, in their own language",
    cronName: null,
    onDemand: false,
    built: true,
    modes: ["auto_reply", "draft"],
    notHiredReason: null,
  },
  {
    key: "qualify",
    name: "Qualification agent",
    duty: "Asks the trip questions, builds the profile, spots buying intent",
    cronName: "qualification-follow-ups",
    onDemand: false,
    built: true,
    modes: ["qualify"],
    notHiredReason: null,
  },
  {
    key: "score",
    name: "Lead scorer",
    duty: "Scores every lead nought to a hundred and sorts them into bands",
    cronName: "lead-scoring",
    onDemand: false,
    built: true,
    modes: ["score"],
    notHiredReason: null,
  },
  {
    key: "checklist",
    name: "Checklist writer",
    duty: "Writes the salesperson's task list the moment a lead qualifies",
    cronName: null,
    onDemand: false,
    built: true,
    modes: ["checklist"],
    notHiredReason: null,
  },
  {
    key: "tags",
    name: "Tag suggester",
    duty: "Reads a thread and proposes the right tags, when asked",
    cronName: null,
    onDemand: true,
    built: true,
    modes: ["classify"],
    notHiredReason: null,
  },
  {
    key: "admatch",
    name: "Ad matcher",
    duty: "Matches each ad click to the service it was advertising",
    cronName: "retry-ad-resolution",
    onDemand: false,
    built: true,
    modes: ["match_service"],
    notHiredReason: null,
  },
  {
    key: "revival",
    name: "Revival agent",
    duty: "Chases leads that went quiet, in their own words",
    cronName: null,
    onDemand: false,
    built: false,
    modes: [],
    notHiredReason: null,
  },
  {
    key: "kbgap",
    name: "Knowledge gap agent",
    duty: "Turns questions nobody could answer into knowledge entries",
    cronName: null,
    onDemand: false,
    built: false,
    modes: [],
    notHiredReason: null,
  },
  {
    key: "coach",
    name: "Sales coach",
    duty: "Reads every handled thread and coaches the team on it",
    cronName: null,
    onDemand: false,
    built: false,
    modes: [],
    notHiredReason: null,
  },
  {
    key: "quote",
    name: "Quote drafter",
    duty: "Drafts the itinerary, inclusions, and visa notes",
    cronName: null,
    onDemand: false,
    built: false,
    modes: [],
    notHiredReason: "needs a pricing catalogue",
  },
] as const;

export interface AgentStatusInput {
  built: boolean;
  /** A config row exists for this account. */
  configured: boolean;
  enabled: boolean;
  onDemand: boolean;
  lastRunStatus: "running" | "success" | "failed" | null;
  /** A declared, currently-tripped blocker (e.g. a missing env var). */
  blockedReason: string | null;
}

/**
 * Precedence is deliberate and load-bearing:
 *
 *  - `not_hired` first — an unbuilt agent has no config to interpret.
 *  - `off_duty` before `attention` — a switched-off agent is not broken,
 *    it is off, and a blocker on it is not news.
 *  - `attention` before `working` — an agent that is failing while
 *    mid-run must read as broken, not busy. This is the one ordering a
 *    naive implementation gets wrong.
 */
export function deriveAgentStatus(input: AgentStatusInput): AgentStatus {
  if (!input.built) return "not_hired";
  if (!input.configured) return "not_hired";
  if (!input.enabled) return "off_duty";
  if (input.blockedReason !== null) return "attention";
  if (input.lastRunStatus === "failed") return "attention";
  if (input.lastRunStatus === "running") return "working";
  if (input.onDemand) return "on_call";
  return "on_duty";
}

/**
 * How many `aiUsageLog` rows one roster pass may read. See
 * `./cronSummary.ts`'s `SYSTEM_SCAN_WINDOW` for what an unbounded read
 * over a hot table cost this deployment once already. On overflow the
 * caller reports "1024+" rather than a wrong exact number.
 */
export const ROSTER_SCAN_WINDOW = 1024;

/**
 * Bucket usage rows onto the agent that earned them.
 *
 * `transcribe`, `describe`, and `embed` are deliberately attributed to
 * NOBODY. They are shared senses — the vision pass, the voice pass, and
 * the retrieval embedding are used by several agents on one another's
 * behalf, so charging them to any single agent would misreport all of
 * them. They remain visible in aggregate on the usage tab.
 */
export function tallyWork(
  rows: Array<{ mode: string }>,
): Record<AgentKey, number> {
  const owner = new Map<string, AgentKey>();
  for (const agent of AGENT_REGISTRY) {
    for (const mode of agent.modes) owner.set(mode, agent.key);
  }

  const counts = Object.fromEntries(
    AGENT_REGISTRY.map((a) => [a.key, 0]),
  ) as Record<AgentKey, number>;

  for (const row of rows) {
    const key = owner.get(row.mode);
    if (key) counts[key] += 1;
  }
  return counts;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/lib/agentRegistry.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/agentRegistry.ts convex/lib/agentRegistry.test.ts
git commit -m "feat(agents): the agent registry, and the rules that decide a status"
```

---

### Task 2: Give the ad matcher its own timesheet

The ad matcher logs `mode: "classify"` — the tag suggester's value. Two agents share one timesheet line, so neither can be counted. This task splits them.

**Files:**
- Modify: `convex/schema.ts` (the `aiUsageLog.mode` union)
- Modify: `convex/aiUsage.ts:45-62` (the `log` args validator — a separate union that has drifted from the schema before)
- Modify: `convex/adServiceTagging.ts:583`
- Test: `convex/aiUsage.test.ts`

**Interfaces:**
- Consumes: `AGENT_REGISTRY` from Task 1 (the `admatch` entry already declares `modes: ["match_service"]`).
- Produces: `"match_service"` as a valid `aiUsageLog.mode`. Task 3's counts depend on it.

- [ ] **Step 1: Write the failing test**

Append to `convex/aiUsage.test.ts`:

```ts
test("the ad matcher logs match_service, not the tag suggester's classify", async () => {
  const t = convexTest(schema, modules);
  const accountId = await t.run((ctx) =>
    ctx.db.insert("accounts", {
      name: "A",
      defaultCurrency: "AED",
      ownerUserId: undefined,
    }),
  );

  await t.mutation(internal.aiUsage.log, {
    accountId,
    mode: "match_service",
    provider: "openai",
    model: "gpt-5",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });

  const rows = await t.run((ctx) => ctx.db.query("aiUsageLog").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]!.mode).toBe("match_service");
});
```

If `convex/aiUsage.test.ts` does not already import them, add at the top:

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("/convex/**/*.ts");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/aiUsage.test.ts`
Expected: FAIL — the args validator rejects `"match_service"`.

- [ ] **Step 3: Widen both unions and update the writer**

In `convex/schema.ts`, inside `aiUsageLog`'s `mode` union, add after `v.literal("classify"),`:

```ts
    // The ad matcher. Split from `classify` (2026-08-08): it shared that
    // value with the tag suggester, so two distinct agents wrote one
    // timesheet line and neither could be counted. Rows written before
    // this split stay `classify` and are attributed to the tag
    // suggester — a bounded inaccuracy that ages out within a day,
    // since the roster reports today's work only.
    v.literal("match_service"),
```

In `convex/aiUsage.ts`, add the same literal to `log`'s own args union after `v.literal("classify"),`:

```ts
    v.literal("match_service"),
```

In `convex/adServiceTagging.ts:583`, change:

```ts
            mode: "classify",
```

to:

```ts
            mode: "match_service",
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/aiUsage.test.ts convex/adServiceTagging.test.ts convex/schema.test.ts`
Expected: PASS. If an `adServiceTagging` test asserts `mode: "classify"`, update that assertion to `"match_service"` — it is asserting the bug.

- [ ] **Step 5: Commit**

```bash
git add convex/schema.ts convex/aiUsage.ts convex/adServiceTagging.ts convex/aiUsage.test.ts
git commit -m "fix(ai): give the ad matcher its own usage mode instead of the tag suggester's"
```

---

### Task 3: The roster query

**Files:**
- Create: `convex/agentRoster.ts`
- Create: `convex/agentRoster.test.ts`

**Interfaces:**
- Consumes: `AGENT_REGISTRY`, `deriveAgentStatus`, `tallyWork`, `ROSTER_SCAN_WINDOW` from Task 1; `"match_service"` from Task 2; `accountQuery` from `./lib/auth`.
- Produces: `api.agentRoster.roster`, returning `{ agents: RosterAgent[], workOverflow: boolean }` where `RosterAgent` is `{ key, name, duty, status, workToday, blockedReason, notHiredReason }`. Task 4 renders exactly this shape.

- [ ] **Step 1: Write the failing test**

Create `convex/agentRoster.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedMember(t: ReturnType<typeof convexTest>, role: AccountRole) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: role, email: `${role}@example.com` }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "A",
      defaultCurrency: "AED",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role,
      fullName: role,
      email: `${role}@example.com`,
    });
    return id;
  });
  return { userId, accountId, as: t.withIdentity({ subject: `${userId}|s` }) };
}

function find(
  result: { agents: Array<{ key: string }> },
  key: string,
) {
  const agent = result.agents.find((a) => a.key === key);
  expect(agent, `no agent with key ${key}`).toBeDefined();
  return agent as { key: string; status: string; workToday: number; blockedReason: string | null };
}

test("with nothing configured, every built agent is not hired", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  const result = await as.query(api.agentRoster.roster, {});
  expect(result.agents).toHaveLength(10);
  expect(find(result, "reply").status).toBe("not_hired");
  expect(find(result, "qualify").status).toBe("not_hired");
  expect(find(result, "revival").status).toBe("not_hired");
});

test("an enabled reply agent is on duty; disabling auto-reply puts it off duty", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");

  const configId = await t.run((ctx) =>
    ctx.db.insert("aiConfigs", {
      accountId,
      createdByUserId: userId,
      provider: "openai",
      model: "gpt-5",
      apiKey: "cipher",
      isActive: true,
      autoReplyEnabled: true,
      updatedAt: Date.now(),
    }),
  );
  expect(find(await as.query(api.agentRoster.roster, {}), "reply").status).toBe(
    "on_duty",
  );

  await t.run((ctx) => ctx.db.patch(configId, { autoReplyEnabled: false }));
  expect(find(await as.query(api.agentRoster.roster, {}), "reply").status).toBe(
    "off_duty",
  );
});

test("a failed cron run puts the lead scorer in attention", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "admin");

  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      accountId,
      enabled: true,
      rescoreDebounceMinutes: 10,
      scorePerRun: 5,
      backfillEnabled: false,
      backfillPerRun: 5,
      idleDaysBeforeSequence: 3,
      humanQuietHours: 24,
      dailySendCap: 50,
      bands: [],
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("cronRuns", {
      name: "lead-scoring",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
      status: "failed",
      error: "provider timeout",
    }),
  );

  expect(find(await as.query(api.agentRoster.roster, {}), "score").status).toBe(
    "attention",
  );
});

test("today's usage rows count to their owning agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");

  await t.run((ctx) =>
    ctx.db.insert("aiConfigs", {
      accountId,
      createdByUserId: userId,
      provider: "openai",
      model: "gpt-5",
      apiKey: "cipher",
      isActive: true,
      autoReplyEnabled: true,
      updatedAt: Date.now(),
    }),
  );
  for (const mode of ["auto_reply", "auto_reply", "draft", "classify"] as const) {
    await t.run((ctx) =>
      ctx.db.insert("aiUsageLog", {
        accountId,
        mode,
        provider: "openai",
        model: "gpt-5",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      }),
    );
  }

  const result = await as.query(api.agentRoster.roster, {});
  expect(find(result, "reply").workToday).toBe(3);
  expect(find(result, "tags").workToday).toBe(1);
  expect(result.workOverflow).toBe(false);
});

test("one account's usage never counts toward another's roster", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedMember(t, "admin");
  const theirAccountId = await t.run((ctx) =>
    ctx.db.insert("accounts", {
      name: "B",
      defaultCurrency: "AED",
      ownerUserId: undefined,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("aiUsageLog", {
      accountId: theirAccountId,
      mode: "auto_reply",
      provider: "openai",
      model: "gpt-5",
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
    }),
  );

  const result = await mine.as.query(api.agentRoster.roster, {});
  expect(find(result, "reply").workToday).toBe(0);
});

test("a viewer may read the roster — it carries no keys, prompts, or tokens", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "viewer");

  const result = await as.query(api.agentRoster.roster, {});
  expect(result.agents).toHaveLength(10);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("apiKey");
  expect(serialized).not.toContain("systemPrompt");
  expect(serialized).not.toContain("promptTokens");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/agentRoster.test.ts`
Expected: FAIL — `api.agentRoster` does not exist.

- [ ] **Step 3: Write the implementation**

Create `convex/agentRoster.ts`:

```ts
import { accountQuery } from "./lib/auth";
import {
  AGENT_REGISTRY,
  ROSTER_SCAN_WINDOW,
  deriveAgentStatus,
  tallyWork,
  type AgentKey,
  type AgentStatus,
} from "./lib/agentRegistry";

// ============================================================
// The agent roster — what every AI agent on this account is, whether it
// is working, and what it has done today.
//
// Deliberately MEMBER-safe (no `ctx.requireRole`): it exposes agent
// identity, on/off state, and activity counts, the same trust level as
// `aiConfig.get`, which is member-visible so every role's inbox banner
// can reflect whether AI is on. It exposes no keys, prompts, models, or
// token counts — those stay behind the admin-gated `aiConfig.getFull`
// and `aiUsage.summary`. The `/agents` route is still admin-only, so
// this has no member-facing surface yet; built this way so a future
// inbox widget needs no re-gating.
//
// Every read is bounded. This is a live subscription over tables the
// engines write constantly — see `lib/cronSummary.ts`'s
// `SYSTEM_SCAN_WINDOW` for what the unbounded version cost in
// production on 2026-07-18.
// ============================================================

interface RosterAgent {
  key: AgentKey;
  name: string;
  duty: string;
  status: AgentStatus;
  workToday: number;
  blockedReason: string | null;
  notHiredReason: string | null;
}

/** Midnight today, account-local is not modeled here — UTC day is the
 *  same bound `aiUsage`'s own windows use, and the roster's claim is
 *  "today's work", not "work since your local midnight". */
function startOfTodayMs(now: number): number {
  return new Date(new Date(now).toISOString().slice(0, 10)).getTime();
}

export const roster = accountQuery({
  args: {},
  handler: async (ctx): Promise<{ agents: RosterAgent[]; workOverflow: boolean }> => {
    const [aiConfig, qualConfig, leadConfig] = await Promise.all([
      ctx.db
        .query("aiConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
      ctx.db
        .query("leadAnalysisConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .first(),
    ]);

    // Bounded: one index-range read capped at ROSTER_SCAN_WINDOW. Never
    // `.collect()` — `aiUsage.summary` does, over 30 days, and that is
    // exactly why this query does not reuse it.
    const sinceMs = startOfTodayMs(Date.now());
    const usageRows = await ctx.db
      .query("aiUsageLog")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", sinceMs),
      )
      .take(ROSTER_SCAN_WINDOW);
    const work = tallyWork(usageRows);
    const workOverflow = usageRows.length >= ROSTER_SCAN_WINDOW;

    // One single-document read per cron that an agent claims — no scan.
    const cronNames = [
      ...new Set(
        AGENT_REGISTRY.map((a) => a.cronName).filter(
          (n): n is string => n !== null,
        ),
      ),
    ];
    const lastRuns = new Map<string, "running" | "success" | "failed">();
    for (const name of cronNames) {
      const last = await ctx.db
        .query("cronRuns")
        .withIndex("by_name", (q) => q.eq("name", name))
        .order("desc")
        .first();
      if (last) lastRuns.set(name, last.status);
    }

    const adTokenMissing = !process.env.META_ADS_ACCESS_TOKEN;

    const agents: RosterAgent[] = AGENT_REGISTRY.map((entry) => {
      let configured = false;
      let enabled = false;
      let blockedReason: string | null = null;

      switch (entry.key) {
        case "reply":
          configured = aiConfig !== null;
          enabled = !!aiConfig?.isActive && !!aiConfig?.autoReplyEnabled;
          break;
        case "tags":
          configured = aiConfig !== null;
          enabled = !!aiConfig?.isActive;
          break;
        case "qualify":
        case "checklist":
          // The checklist writer has no switch of its own — it fires on
          // qualification completing, so it lives and dies with that config.
          configured = qualConfig !== null;
          enabled = !!qualConfig?.enabled;
          break;
        case "score":
          configured = leadConfig !== null;
          enabled = !!leadConfig?.enabled;
          break;
        case "admatch":
          // No config row of its own: it runs whenever ad referrals
          // arrive. Configured means the credential it needs exists.
          configured = true;
          enabled = true;
          blockedReason = adTokenMissing
            ? "no Meta token — ad names unresolved"
            : null;
          break;
        default:
          // Not built yet. `deriveAgentStatus` short-circuits on `built`.
          break;
      }

      const status = deriveAgentStatus({
        built: entry.built,
        configured,
        enabled,
        onDemand: entry.onDemand,
        lastRunStatus: entry.cronName
          ? (lastRuns.get(entry.cronName) ?? null)
          : null,
        blockedReason,
      });

      return {
        key: entry.key,
        name: entry.name,
        duty: entry.duty,
        status,
        workToday: work[entry.key],
        // Only surface a blocker when it is actually what is wrong.
        blockedReason: status === "attention" ? blockedReason : null,
        notHiredReason: status === "not_hired" ? entry.notHiredReason : null,
      };
    });

    return { agents, workOverflow };
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/agentRoster.test.ts`
Expected: PASS, 6 tests.

If the `leadAnalysisConfigs` insert in the third test fails schema validation, open `convex/schema.ts`, read that table's definition, and add the missing required fields to the test fixture. Do not weaken the schema.

- [ ] **Step 5: Run the whole backend suite for regressions**

Run: `npx vitest run convex/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/agentRoster.ts convex/agentRoster.test.ts
git commit -m "feat(agents): a member-safe roster query with bounded reads"
```

---

### Task 4: The roster component

**Files:**
- Create: `src/components/agents/agent-roster.tsx`

**Interfaces:**
- Consumes: `api.agentRoster.roster` from Task 3; `api.cronSchedules.overview` (existing, admin-gated, returns `{ crons: Array<{ name, intervalMinutes, lastRun, nextRunAt }> }` where `lastRun` is `{ id, name, startedAt, finishedAt, durationMs, status, error } | null`).
- Produces: `<AgentRoster />`, default-exported as a named export. Task 5 mounts it.

- [ ] **Step 1: Write the component**

Create `src/components/agents/agent-roster.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useQuery } from 'convex/react';
import {
  BookOpen,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  GraduationCap,
  MessageCircle,
  Megaphone,
  RefreshCw,
  Tag,
  Target,
  ClipboardList,
} from 'lucide-react';
import { Skeleton } from '@/components/dashboard/skeleton';
import { cn } from '@/lib/utils';

import { api } from '../../../convex/_generated/api';

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  reply: MessageCircle,
  qualify: ClipboardList,
  score: Target,
  checklist: CheckSquare,
  tags: Tag,
  admatch: Megaphone,
  revival: RefreshCw,
  kbgap: BookOpen,
  coach: GraduationCap,
  quote: FileText,
};

const STATUS_LABEL: Record<string, string> = {
  working: 'Working',
  on_duty: 'On duty',
  on_call: 'On call',
  attention: 'Needs attention',
  off_duty: 'Off duty',
  not_hired: 'Not hired',
};

const STATUS_CLASS: Record<string, string> = {
  working: 'bg-primary/10 text-primary',
  on_duty: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  on_call: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  attention: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  off_duty: 'bg-muted text-muted-foreground',
  not_hired: 'bg-muted text-muted-foreground',
};

function Tile({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold', tone)}>{value}</p>
    </div>
  );
}

export function AgentRoster() {
  const data = useQuery(api.agentRoster.roster, {});
  const [showJobs, setShowJobs] = useState(false);
  const jobs = useQuery(api.cronSchedules.overview, showJobs ? {} : 'skip');

  if (data === undefined) {
    return (
      <div className="mt-6 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  const live = data.agents.filter((a) => a.status !== 'not_hired');
  const unhired = data.agents.filter((a) => a.status === 'not_hired');
  const onDuty = live.filter((a) => a.status !== 'attention' && a.status !== 'off_duty');
  const working = live.filter((a) => a.status === 'working');
  const attention = live.filter((a) => a.status === 'attention');

  return (
    <div className="mt-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="On duty" value={onDuty.length} />
        <Tile label="Working now" value={working.length} tone="text-primary" />
        <Tile
          label="Needs attention"
          value={attention.length}
          tone={attention.length ? 'text-amber-600 dark:text-amber-400' : undefined}
        />
        <Tile label="Not hired" value={unhired.length} tone="text-muted-foreground" />
      </div>

      <p className="mt-8 text-sm text-muted-foreground">On the floor</p>
      <ul className="mt-2 border-t border-border">
        {live.map((agent) => {
          const Icon = ICONS[agent.key] ?? MessageCircle;
          return (
            <li
              key={agent.key}
              className="flex items-center gap-3 border-b border-border py-3.5"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <Icon className="h-[18px] w-[18px] text-muted-foreground" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">{agent.name}</span>
                <span className="block text-sm text-muted-foreground">{agent.duty}</span>
              </span>
              <span className="shrink-0 text-right">
                <span
                  className={cn(
                    'inline-block rounded-full px-2.5 py-0.5 text-xs',
                    STATUS_CLASS[agent.status],
                  )}
                >
                  {STATUS_LABEL[agent.status]}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {agent.blockedReason ??
                    (agent.workToday > 0
                      ? `${agent.workToday}${data.workOverflow ? '+' : ''} today`
                      : 'nothing yet today')}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mt-8 text-sm text-muted-foreground">Not hired yet</p>
      <ul className="mt-2 border-t border-border">
        {unhired.map((agent) => {
          const Icon = ICONS[agent.key] ?? MessageCircle;
          return (
            <li
              key={agent.key}
              className="flex items-center gap-3 border-b border-border py-3.5 opacity-70"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-border">
                <Icon className="h-[18px] w-[18px] text-muted-foreground" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">{agent.name}</span>
                <span className="block text-sm text-muted-foreground">{agent.duty}</span>
              </span>
              {agent.notHiredReason && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {agent.notHiredReason}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={() => setShowJobs((v) => !v)}
        className="mt-8 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        {showJobs ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        Background jobs
      </button>

      {showJobs && (
        <ul className="mt-2 border-t border-border">
          {jobs === undefined ? (
            <li className="py-3">
              <Skeleton className="h-10 w-full" />
            </li>
          ) : (
            jobs.crons.map((cron) => (
              <li
                key={cron.name}
                className="flex items-center gap-3 border-b border-border py-3"
              >
                <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 font-mono text-sm text-foreground">
                  {cron.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  every {cron.intervalMinutes} min
                </span>
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    cron.lastRun?.status === 'failed'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground',
                  )}
                >
                  {cron.lastRun ? cron.lastRun.status : 'never run'}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint src/components/agents/agent-roster.tsx`
Expected: clean. If `@/lib/utils`'s `cn` or `@/components/dashboard/skeleton`'s `Skeleton` resolve differently in this repo, fix the import to match the real path rather than adding a new helper.

- [ ] **Step 3: Commit**

```bash
git add src/components/agents/agent-roster.tsx
git commit -m "feat(agents): the roster component"
```

---

### Task 5: Mount the roster as the default tab

**Files:**
- Modify: `src/app/(dashboard)/agents/page.tsx`

**Interfaces:**
- Consumes: `<AgentRoster />` from Task 4.
- Produces: nothing downstream.

- [ ] **Step 1: Add the tab**

In `src/app/(dashboard)/agents/page.tsx`:

Add the import beside the other component imports:

```tsx
import { AgentRoster } from '@/components/agents/agent-roster';
```

Add `Users` to the existing `lucide-react` import list.

Widen the `Tab` type:

```tsx
type Tab = 'roster' | 'playground' | 'knowledge' | 'setup' | 'usage';
```

Change the initial state to land on the roster:

```tsx
  const [tab, setTab] = useState<Tab>(urlTab ?? 'roster');
```

Change the first-run decision so configured accounts land on the roster and
first-timers still land on setup:

```tsx
  if (!decided && configDoc !== undefined) {
    setDecided(true);
    if (!urlTab) setTab(configDoc ? 'roster' : 'setup');
  }
```

Add the trigger as the first entry in `<TabsList>`, before the playground trigger:

```tsx
            <TabsTrigger value="roster">
              <Users className="mr-1.5 h-4 w-4" /> Roster
            </TabsTrigger>
```

Add the panel alongside the other `<TabsContent>` blocks:

```tsx
          <TabsContent value="roster">
            <AgentRoster />
          </TabsContent>
```

- [ ] **Step 2: Fix the page description**

The current copy is singular and now wrong. Replace:

```tsx
        Your bring-your-own-key AI agent — set it up, then test it in the
        playground before it replies to customers in the inbox.
```

with:

```tsx
        The AI agents working on your account — who is on duty, what each
        one does, and what they have handled today.
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint "src/app/(dashboard)/agents/page.tsx"`
Expected: clean.

- [ ] **Step 4: Verify in the browser**

Start the dev server with the preview tool (never `npm run dev` in bash), open `/agents`, and confirm:

- the roster is the landing tab
- six agents appear under "On the floor", four under "Not hired yet"
- the ad matcher shows "Needs attention" with its missing-token reason
- "Background jobs" expands to nine cron rows
- tiles sum correctly: not-hired is 4, and on-duty includes working

Check `read_console_messages` for errors, then take a screenshot.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/agents/page.tsx"
git commit -m "feat(agents): land on the roster, and stop calling the team an agent"
```

---

## Self-review

**Spec coverage.** Roster of ten with duties — Task 1. Static registry over a table — Task 1. Six-status model with `attention` outranking `working` — Task 1, asserted. Declared blocker forcing attention — Tasks 1 and 3. `blockedReason` probe for the missing Meta token — Task 3. Bounded reads with the 2026-07-18 precedent honoured — Task 3, `ROSTER_SCAN_WINDOW` plus per-cron single reads. Not reusing `aiUsage.summary` — Task 3, stated in the module header. `match_service` mode split across schema, validator, and writer, no backfill — Task 2. Member-safe access with route staying admin-only — Task 3, asserted by the viewer test. Roster tab as default landing, header copy fixed — Task 5. Collapsed background-jobs section over `cronSchedules.overview` — Task 4. Testing plan including purity of the derivation helper — Tasks 1 and 3. Out-of-scope items (new agents, toggles, per-agent cost, backfill) appear in no task.

**Placeholder scan.** No TBD, TODO, "similar to Task N", or "add error handling". Every code step carries real code.

**Type consistency.** `AgentKey`, `AgentStatus`, `AgentEntry`, `AgentStatusInput` are defined once in Task 1 and imported unchanged in Task 3. `deriveAgentStatus`, `tallyWork`, `ROSTER_SCAN_WINDOW`, `AGENT_REGISTRY` keep the same names throughout. `RosterAgent`'s fields (`key`, `name`, `duty`, `status`, `workToday`, `blockedReason`, `notHiredReason`) are produced in Task 3 and consumed field-for-field in Task 4. `cronSchedules.overview`'s `crons[].lastRun.status` is read in Task 4 exactly as `pickRun` emits it.

**One gap found and closed.** The spec's status table lists `on_call` for the tag suggester but never says what happens to a *disabled* agent that also has a blocker. Task 1 resolves it explicitly — `off_duty` wins, because a switched-off agent is not broken — and asserts it.
