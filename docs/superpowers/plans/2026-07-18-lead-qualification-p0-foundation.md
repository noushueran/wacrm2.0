# Lead Qualification P0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the dormant foundation of the lead-qualification engine: schema, per-account config with Holidayys defaults, session tracking hooks on every inbound/outbound message, and the admin Settings tab skeleton.

**Architecture:** Two new tables (`qualificationConfigs`, `qualificationSessions`) + pure tracking helpers in `convex/lib/qualification/`. One inbound hook in `ingest.processInbound` (best-effort, before flows) and one outbound hook inside `messages.appendInternal` (covers agent/bot/broadcast sends in one place). Public config CRUD in `convex/qualification.ts`; engine internals in `convex/qualificationEngine.ts`. No sends, no LLM calls, no cron in P0 — pure state tracking, invisible until `enabled: true`.

**Tech Stack:** Convex (self-hosted), convex-test + vitest, Next.js 15 App Router + next-intl, shadcn/ui.

## Global Constraints

- **NEVER run `npx convex dev`, `npx convex deploy`, or `npx convex codegen`** — the single live deployment (convex-api.holidayys.co) receives whatever is pushed. Hand-edit `convex/_generated/api.d.ts` (Task 6) instead.
- Feature must be **dormant**: no `qualificationConfigs` row (or `enabled: false`) ⇒ every hook is a cheap no-op. Nothing user-visible changes for the live account.
- Spec: `docs/superpowers/specs/2026-07-18-lead-qualification-followup-design.md` (approved v2). Schema shapes come from spec §5 verbatim — include the P1–P4 fields now so later phases need no schema migration.
- All tenant-scoped public functions via `accountQuery`/`accountMutation` from `convex/lib/auth.ts`; engine functions are `internalMutation` with explicit `accountId` args (webhook context — no session).
- TDD: failing test → implement → pass → commit. Full suite (`npx vitest run`), `npx tsc --noEmit`, `npx next lint`, `npm run build` all green before the final commit.
- Next.js in this repo is newer than training data (AGENTS.md): for any App-Router API doubt, check `node_modules/next/dist/docs/`. The settings work here only follows existing component patterns, so no new router surface.
- Work happens in an isolated worktree branched off `origin/main` (the main checkout sits on an unrelated branch).

---

### Task 1: Worktree + commit the approved spec

**Files:**
- Create: worktree `.claude/worktrees/feat-lead-qualification` on branch `feat/lead-qualification` from `origin/main`
- Add: `docs/superpowers/specs/2026-07-18-lead-qualification-followup-design.md` (copy from the main checkout where it is untracked)

- [ ] **Step 1:** From `/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0`:

```bash
git worktree add .claude/worktrees/feat-lead-qualification -b feat/lead-qualification origin/main
cp docs/superpowers/specs/2026-07-18-lead-qualification-followup-design.md \
   .claude/worktrees/feat-lead-qualification/docs/superpowers/specs/
```

- [ ] **Step 2:** All later tasks run inside the worktree. `node_modules` is not shared automatically — symlink it (repo's established worktree practice, node_modules is untracked):

```bash
cd .claude/worktrees/feat-lead-qualification && ln -s ../../../node_modules node_modules 2>/dev/null || true
npx vitest run convex/funnel.test.ts   # sanity: harness works in the worktree
```

Expected: funnel tests PASS.

- [ ] **Step 3: Commit the spec**

```bash
git add docs/superpowers/specs/2026-07-18-lead-qualification-followup-design.md
git commit -m "docs(qualification): approved design spec for lead qualification + follow-up engine"
```

---

### Task 2: Schema — two tables + notifications union widening

**Files:**
- Modify: `convex/schema.ts` (append two tables before the closing `});`; widen `notifications.type`)
- Test: `convex/qualification.test.ts` (new)

**Interfaces (produced):** tables `qualificationConfigs` (index `by_account`), `qualificationSessions` (indexes `by_conversation`, `by_account_status`, `by_due`); `notifications.type` accepts `"lead_qualified"`.

- [ ] **Step 1: Write the failing test** — create `convex/qualification.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("/convex/**/*.ts");

test("schema accepts qualificationConfigs, qualificationSessions and lead_qualified notifications", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "U", email: "u@example.com" });
    const accountId = await ctx.db.insert("accounts", {
      name: "A", defaultCurrency: "AED", ownerUserId: userId,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000001", phoneNormalized: "971500000001",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    const configId = await ctx.db.insert("qualificationConfigs", {
      accountId, enabled: false,
      basicFields: [{ key: "destination", label: "Destination", required: true, phrasings: ["Where would you like to go?"] }],
      qualifyThresholdScore: 60,
      timezoneLabel: "Asia/Dubai", utcOffsetMinutes: 240,
      workStartMinute: 600, workEndMinute: 1260, workDays: [1, 2, 3, 4, 5, 6],
      followUpDelaysMinutes: [60, 180, 720, 1440], maxFollowUps: 4, sessionWindowHours: 72,
      closingMessage: "Thank you! Our travel expert will contact you shortly.",
      adminAlertEnabled: false, adminAlertPhones: [], outboundNudgesEnabled: false,
    });
    const sessionId = await ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId,
      status: "collecting", origin: "inbound",
      fields: [], expectedCount: 0, answeredCount: 0,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
    });
    await ctx.db.insert("notifications", {
      accountId, userId, type: "lead_qualified", title: "New qualified lead",
    });
    expect(configId).toBeDefined();
    const bySession = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .unique();
    expect(bySession?._id).toBe(sessionId);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run convex/qualification.test.ts` → Expected FAIL (unknown table `qualificationConfigs` / validator rejects `lead_qualified`).

- [ ] **Step 3: Add the schema.** In `convex/schema.ts`:

(a) widen the notifications union — change

```ts
    type: v.union(v.literal("conversation_assigned")),
```
to
```ts
    type: v.union(
      v.literal("conversation_assigned"),
      v.literal("lead_qualified"),
    ),
```

(b) append the two tables right before the file's final `});`, with the spec §5 shapes verbatim (copy the full `qualificationConfigs` and `qualificationSessions` blocks from the spec, including the doc comments and the three session indexes):

```ts
  // ============================================================
  // Lead qualification (spec: docs/superpowers/specs/
  // 2026-07-18-lead-qualification-followup-design.md §5). Per-account
  // config, one row (mirrors aiConfigs). DORMANT until `enabled`.
  // ============================================================
  qualificationConfigs: defineTable({
    accountId: v.id("accounts"),
    enabled: v.boolean(),
    basicFields: v.array(v.object({
      key: v.string(),
      label: v.string(),
      required: v.boolean(),
      phrasings: v.array(v.string()),
    })),
    qualifyThresholdScore: v.number(),
    timezoneLabel: v.string(),
    utcOffsetMinutes: v.number(),
    workStartMinute: v.number(),
    workEndMinute: v.number(),
    workDays: v.array(v.number()),
    followUpDelaysMinutes: v.array(v.number()),
    maxFollowUps: v.number(),
    sessionWindowHours: v.number(),
    reengagementTemplateName: v.optional(v.string()),
    reengagementTemplateLanguage: v.optional(v.string()),
    closingMessage: v.string(),
    adminAlertEnabled: v.boolean(),
    adminAlertPhones: v.array(v.string()),
    adminAlertTemplateName: v.optional(v.string()),
    adminAlertTemplateLanguage: v.optional(v.string()),
    outboundNudgesEnabled: v.boolean(),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One qualification session per conversation — this row IS the lead the
  // sales team works (spec §5). Keys in `fields` are dynamic (doc-driven).
  qualificationSessions: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    status: v.union(
      v.literal("collecting"),
      v.literal("qualified"),
      v.literal("expired"),
      v.literal("opted_out"),
      v.literal("disqualified"),
    ),
    origin: v.union(v.literal("inbound"), v.literal("outbound")),
    serviceName: v.optional(v.string()),
    fields: v.array(v.object({
      key: v.string(),
      label: v.optional(v.string()),
      value: v.string(),
      confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
      updatedAt: v.number(),
    })),
    score: v.optional(v.number()),
    scoreBreakdown: v.optional(v.array(v.object({
      criterion: v.string(),
      marks: v.number(),
      maxMarks: v.number(),
      reason: v.optional(v.string()),
    }))),
    expectedCount: v.number(),
    answeredCount: v.number(),
    pendingQuestion: v.optional(v.object({
      key: v.string(),
      text: v.string(),
      alternates: v.array(v.string()),
    })),
    lastCustomerMessageAt: v.optional(v.number()),
    humanTouchedAt: v.optional(v.number()),
    followUpsSent: v.number(),
    phrasingCursor: v.number(),
    nextFollowUpAt: v.optional(v.number()),
    sendAttemptErrors: v.number(),
    qualifiedAt: v.optional(v.number()),
    closedReason: v.optional(v.string()),
    summary: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_account_status", ["accountId", "status"])
    .index("by_due", ["status", "nextFollowUpAt"]),
```

- [ ] **Step 4:** Run `npx vitest run convex/qualification.test.ts` → PASS. Also `npx vitest run convex/notifications.test.ts` (if present) + `npx vitest run convex/conversations.test.ts` → still PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/schema.ts convex/qualification.test.ts
git commit -m "feat(qualification): schema for configs + sessions, lead_qualified notification type"
```

---

### Task 3: Defaults + tracking helpers (`convex/lib/qualification/`)

**Files:**
- Create: `convex/lib/qualification/defaults.ts`
- Create: `convex/lib/qualification/track.ts`
- Test: `convex/lib/qualification/track.test.ts`

**Interfaces (produced):**
- `holidayysDefaultConfig(): Omit<Doc<"qualificationConfigs">, "_id" | "_creationTime" | "accountId">` — the seeded defaults (spec §11/§17).
- `loadEnabledConfig(ctx, accountId): Promise<Doc<"qualificationConfigs"> | null>` — null when absent or disabled.
- `isAdminAlertNumber(config, phoneNormalized): boolean` — loop guard (spec §9).
- `ensureSession(ctx, {accountId, conversationId, contactId, origin, now}): Promise<Id<"qualificationSessions">>` — idempotent by `by_conversation` (first-wins; never demotes an existing session's origin/status).
- `recordInboundActivity(ctx, {accountId, conversationId, contactId, now})` — ensure(origin "inbound") + bump `lastCustomerMessageAt`, clear `nextFollowUpAt`, reset `sendAttemptErrors` (only while status is `collecting`).
- `recordOutboundSend(ctx, {accountId, conversationId, senderType, now})` — ensure(origin "outbound"); `senderType === "agent"` additionally sets `humanTouchedAt`.

All db-touching helpers take `ctx: { db: MutationCtx["db"] }` (the `convex/lib/leadCharge.ts` pattern).

- [ ] **Step 1: Write the failing tests** — `convex/lib/qualification/track.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../../schema";
import type { Id } from "../../_generated/dataModel";
import { holidayysDefaultConfig } from "./defaults";
import {
  ensureSession, recordInboundActivity, recordOutboundSend,
  isAdminAlertNumber, loadEnabledConfig,
} from "./track";

const modules = import.meta.glob("/convex/**/*.ts");

async function seed(t: ReturnType<typeof convexTest>, opts: { enabled: boolean; adminPhones?: string[] }) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "U", email: "u@example.com" });
    const accountId = await ctx.db.insert("accounts", { name: "A", defaultCurrency: "AED", ownerUserId: userId });
    await ctx.db.insert("qualificationConfigs", {
      accountId,
      ...holidayysDefaultConfig(),
      enabled: opts.enabled,
      adminAlertPhones: opts.adminPhones ?? [],
    });
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+971500000001", phoneNormalized: "971500000001" });
    const conversationId = await ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 });
    return { accountId, contactId, conversationId };
  });
}

function sessionsFor(t: ReturnType<typeof convexTest>, conversationId: Id<"conversations">) {
  return t.run((ctx) =>
    ctx.db.query("qualificationSessions").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
}

test("holidayysDefaultConfig matches the approved spec defaults", () => {
  const d = holidayysDefaultConfig();
  expect(d.enabled).toBe(false);
  expect(d.qualifyThresholdScore).toBe(60);
  expect(d.workStartMinute).toBe(600);    // 10:00
  expect(d.workEndMinute).toBe(1260);     // 21:00
  expect(d.workDays).toEqual([1, 2, 3, 4, 5, 6]); // closed Sunday (0)
  expect(d.utcOffsetMinutes).toBe(240);   // Asia/Dubai
  expect(d.followUpDelaysMinutes).toEqual([60, 180, 720, 1440]);
  expect(d.maxFollowUps).toBe(4);
  expect(d.sessionWindowHours).toBe(72);
  const keys = d.basicFields.map((f) => f.key);
  expect(keys).toEqual(["looking_for", "travel_dates", "travelers", "email"]);
  expect(d.basicFields.every((f) => f.phrasings.length >= 2)).toBe(true);
});

test("ensureSession is idempotent and first-wins on origin", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t, { enabled: true });
  await t.run(async (ctx) => {
    const a = await ensureSession(ctx, { accountId, conversationId, contactId, origin: "outbound", now: 1000 });
    const b = await ensureSession(ctx, { accountId, conversationId, contactId, origin: "inbound", now: 2000 });
    expect(a).toBe(b);
  });
  const rows = await sessionsFor(t, conversationId);
  expect(rows).toHaveLength(1);
  expect(rows[0].origin).toBe("outbound"); // first-wins
  expect(rows[0].status).toBe("collecting");
});

test("recordInboundActivity bumps the clock and clears a pending follow-up, only while collecting", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t, { enabled: true });
  await t.run(async (ctx) => {
    await recordInboundActivity(ctx, { accountId, conversationId, contactId, now: 5000 });
  });
  let [s] = await sessionsFor(t, conversationId);
  expect(s.lastCustomerMessageAt).toBe(5000);
  await t.run(async (ctx) => {
    await ctx.db.patch(s._id, { nextFollowUpAt: 9999, sendAttemptErrors: 2 });
    await recordInboundActivity(ctx, { accountId, conversationId, contactId, now: 6000 });
  });
  [s] = await sessionsFor(t, conversationId);
  expect(s.lastCustomerMessageAt).toBe(6000);
  expect(s.nextFollowUpAt).toBeUndefined();
  expect(s.sendAttemptErrors).toBe(0);
  await t.run(async (ctx) => {
    await ctx.db.patch(s._id, { status: "qualified" });
    await recordInboundActivity(ctx, { accountId, conversationId, contactId, now: 7000 });
  });
  [s] = await sessionsFor(t, conversationId);
  expect(s.lastCustomerMessageAt).toBe(6000); // terminal session untouched
});

test("recordOutboundSend creates an outbound session; only agent sends set humanTouchedAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seed(t, { enabled: true });
  await t.run(async (ctx) => {
    await recordOutboundSend(ctx, { accountId, conversationId, senderType: "bot", now: 100 });
  });
  let [s] = await sessionsFor(t, conversationId);
  expect(s.origin).toBe("outbound");
  expect(s.humanTouchedAt).toBeUndefined();
  await t.run(async (ctx) => {
    await recordOutboundSend(ctx, { accountId, conversationId, senderType: "agent", now: 200 });
  });
  [s] = await sessionsFor(t, conversationId);
  expect(s.humanTouchedAt).toBe(200);
});

test("loadEnabledConfig returns null when disabled; isAdminAlertNumber matches normalized phones", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seed(t, { enabled: false, adminPhones: ["+971 50 111 2222"] });
  await t.run(async (ctx) => {
    expect(await loadEnabledConfig(ctx, accountId)).toBeNull();
    const config = await ctx.db.query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).unique();
    expect(isAdminAlertNumber(config!, "971501112222")).toBe(true);
    expect(isAdminAlertNumber(config!, "971509999999")).toBe(false);
  });
});
```

- [ ] **Step 2:** Run `npx vitest run convex/lib/qualification/track.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement** `convex/lib/qualification/defaults.ts`:

```ts
import type { Doc } from "../../_generated/dataModel";

// Approved defaults — spec §11 (Holidayys preset) + §17 (decision log).
// Hours are the VERIFIED company hours (10:00–21:00 GST, closed Sunday),
// not the 9–6 example; owner can change everything in Settings.
export type QualificationConfigSeed = Omit<
  Doc<"qualificationConfigs">,
  "_id" | "_creationTime" | "accountId"
>;

export function holidayysDefaultConfig(): QualificationConfigSeed {
  return {
    enabled: false,
    basicFields: [
      {
        key: "looking_for", label: "What they're looking for", required: true,
        phrasings: [
          "What are you looking for — a holiday package, a visa, or flights & hotels?",
          "Happy to help! Is this about a holiday package, a visa, or flights/hotels?",
        ],
      },
      {
        key: "travel_dates", label: "Travel dates", required: true,
        phrasings: [
          "When are you planning to travel — exact dates or a rough month is fine.",
          "What time are you looking at for the trip? Even a rough month helps.",
        ],
      },
      {
        key: "travelers", label: "Travelers", required: true,
        phrasings: [
          "How many people will be travelling? If kids are coming, their ages help too.",
          "Who's coming along — how many adults, and any children?",
        ],
      },
      {
        key: "email", label: "Email", required: true,
        phrasings: [
          "Could you share your email so we can send your detailed quote?",
          "What's the best email to send the details and quote to?",
        ],
      },
    ],
    qualifyThresholdScore: 60,
    timezoneLabel: "Asia/Dubai",
    utcOffsetMinutes: 240,
    workStartMinute: 10 * 60,
    workEndMinute: 21 * 60,
    workDays: [1, 2, 3, 4, 5, 6],
    followUpDelaysMinutes: [60, 180, 720, 1440],
    maxFollowUps: 4,
    sessionWindowHours: 72,
    closingMessage: "Thank you! Our travel expert will contact you shortly.",
    adminAlertEnabled: false,
    adminAlertPhones: [],
    outboundNudgesEnabled: false,
  };
}
```

- [ ] **Step 4: Implement** `convex/lib/qualification/track.ts`:

```ts
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { normalizePhone } from "../phone";

// ============================================================
// P0 tracking core — every helper is a no-throw, cheap building block
// called from hot paths (ingest fan-out, message persist), so:
//   - `loadEnabledConfig` is the single gate: one indexed read; null
//     (absent row or enabled:false) means every caller no-ops.
//   - db helpers take `{ db }` (the `lib/leadCharge.ts` pattern) so any
//     mutation's ctx can call them.
// ============================================================

type DbCtx = { db: MutationCtx["db"] };

export async function loadEnabledConfig(
  ctx: DbCtx,
  accountId: Id<"accounts">,
): Promise<Doc<"qualificationConfigs"> | null> {
  const config = await ctx.db
    .query("qualificationConfigs")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .unique();
  return config?.enabled ? config : null;
}

/** Loop guard (spec §9): the bot must never open a qualification session
 *  on its own admin-alert channel. Compared on normalized digits. */
export function isAdminAlertNumber(
  config: Doc<"qualificationConfigs">,
  phoneNormalized: string,
): boolean {
  return config.adminAlertPhones.some(
    (p) => normalizePhone(p) === phoneNormalized,
  );
}

/** Idempotent create — one session per conversation, first-wins (an
 *  existing session's origin/status are never rewritten here). */
export async function ensureSession(
  ctx: DbCtx,
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    contactId: Id<"contacts">;
    origin: "inbound" | "outbound";
    now: number;
  },
): Promise<Id<"qualificationSessions">> {
  const existing = await ctx.db
    .query("qualificationSessions")
    .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
    .unique();
  if (existing) return existing._id;
  return await ctx.db.insert("qualificationSessions", {
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    status: "collecting",
    origin: args.origin,
    fields: [],
    expectedCount: 0,
    answeredCount: 0,
    followUpsSent: 0,
    phrasingCursor: 0,
    sendAttemptErrors: 0,
    ...(args.origin === "inbound" ? { lastCustomerMessageAt: args.now } : {}),
  });
}

/** Any inbound message = engagement: bump the 24h/72h clocks, cancel the
 *  pending follow-up, reset the send-error streak. Terminal sessions are
 *  left untouched. */
export async function recordInboundActivity(
  ctx: DbCtx,
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    contactId: Id<"contacts">;
    now: number;
  },
): Promise<void> {
  const sessionId = await ensureSession(ctx, { ...args, origin: "inbound" });
  const session = await ctx.db.get(sessionId);
  if (!session || session.status !== "collecting") return;
  await ctx.db.patch(sessionId, {
    lastCustomerMessageAt: args.now,
    nextFollowUpAt: undefined,
    sendAttemptErrors: 0,
  });
}

/** Outbound persist hook: ensures an outbound-origin session exists for
 *  chats WE start; a manual agent send additionally makes the engine
 *  yield (spec §6 — `humanTouchedAt`). */
export async function recordOutboundSend(
  ctx: DbCtx,
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    senderType: "agent" | "bot";
    now: number;
  },
): Promise<void> {
  const conversation = await ctx.db.get(args.conversationId);
  if (!conversation || conversation.accountId !== args.accountId) return;
  const sessionId = await ensureSession(ctx, {
    accountId: args.accountId,
    conversationId: args.conversationId,
    contactId: conversation.contactId,
    origin: "outbound",
    now: args.now,
  });
  if (args.senderType === "agent") {
    const session = await ctx.db.get(sessionId);
    if (session && session.status === "collecting") {
      await ctx.db.patch(sessionId, { humanTouchedAt: args.now });
    }
  }
}
```

- [ ] **Step 5:** Run `npx vitest run convex/lib/qualification/track.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/qualification/
git commit -m "feat(qualification): default config + session tracking helpers (TDD)"
```

---

### Task 4: Engine inbound hook + ingest wiring

**Files:**
- Create: `convex/qualificationEngine.ts`
- Modify: `convex/ingest.ts` (one `runBestEffort` block before the Flows block, ~line 619)
- Test: `convex/qualificationEngine.test.ts`

**Interfaces (produced):** `internal.qualificationEngine.onInbound({ accountId, conversationId, contactId, phoneNormalized })` — no-op unless config enabled; skips admin-alert numbers; otherwise `recordInboundActivity`.

- [ ] **Step 1: Write the failing tests** — `convex/qualificationEngine.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { holidayysDefaultConfig } from "./lib/qualification/defaults";

const modules = import.meta.glob("/convex/**/*.ts");

async function seed(t: ReturnType<typeof convexTest>, opts: { enabled: boolean; adminPhones?: string[] } = { enabled: true }) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "U", email: "u@example.com" });
    const accountId = await ctx.db.insert("accounts", { name: "A", defaultCurrency: "AED", ownerUserId: userId });
    await ctx.db.insert("qualificationConfigs", {
      accountId, ...holidayysDefaultConfig(),
      enabled: opts.enabled, adminAlertPhones: opts.adminPhones ?? [],
    });
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+971500000001", phoneNormalized: "971500000001" });
    const conversationId = await ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 });
    return { accountId, contactId, conversationId };
  });
}

function sessionsFor(t: ReturnType<typeof convexTest>, conversationId: Id<"conversations">) {
  return t.run((ctx) =>
    ctx.db.query("qualificationSessions").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
}

test("onInbound creates a collecting session and stamps activity", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t);
  await t.mutation(internal.qualificationEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: "971500000001",
  });
  const rows = await sessionsFor(t, conversationId);
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("collecting");
  expect(rows[0].origin).toBe("inbound");
  expect(rows[0].lastCustomerMessageAt).toBeGreaterThan(0);
});

test("onInbound is a no-op when the feature is disabled", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t, { enabled: false });
  await t.mutation(internal.qualificationEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: "971500000001",
  });
  expect(await sessionsFor(t, conversationId)).toHaveLength(0);
});

test("onInbound never opens a session for an admin-alert number (loop guard)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t, {
    enabled: true, adminPhones: ["+971 50 000 0001"],
  });
  await t.mutation(internal.qualificationEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: "971500000001",
  });
  expect(await sessionsFor(t, conversationId)).toHaveLength(0);
});

test("onInbound leaves closed conversations alone", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seed(t);
  await t.run(async (ctx) => { await ctx.db.patch(conversationId, { status: "closed" }); });
  await t.mutation(internal.qualificationEngine.onInbound, {
    accountId, conversationId, contactId, phoneNormalized: "971500000001",
  });
  expect(await sessionsFor(t, conversationId)).toHaveLength(0);
});
```

- [ ] **Step 2:** Run `npx vitest run convex/qualificationEngine.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `convex/qualificationEngine.ts`:

```ts
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import {
  loadEnabledConfig,
  isAdminAlertNumber,
  recordInboundActivity,
} from "./lib/qualification/track";

// ============================================================
// Qualification engine internals (P0: tracking only — spec §6). Every
// entry point is an `internalMutation` with explicit `accountId`
// (webhook context, no user session) — exactly like
// `automationsEngine.runForTrigger` / `flowsEngine.dispatchInbound`.
// P1 adds the analysis action; P3 adds the follow-up sweep.
// ============================================================

export const onInbound = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    phoneNormalized: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config) return; // dormant
    if (isAdminAlertNumber(config, args.phoneNormalized)) return; // loop guard
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;
    if (conversation.status === "closed") return;
    await recordInboundActivity(ctx, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      now: Date.now(),
    });
  },
});
```

- [ ] **Step 4: Wire into ingest.** In `convex/ingest.ts`, directly ABOVE the `// ---- Flows FIRST` comment block (~line 619), insert:

```ts
    // ---- Qualification session tracking (P0 — spec §6). Every
    // non-duplicate inbound counts as customer activity: upsert the
    // session and bump the 24h/72h clocks BEFORE the reply engines run,
    // so nothing downstream (flow-consumed or not) can lose the signal.
    // Dormant-safe: no enabled config → the mutation no-ops. P1 adds the
    // analysis step separately (after flows, before the AI reply).
    await runBestEffort("qualificationEngine.onInbound", () =>
      ctx.runMutation(internal.qualificationEngine.onInbound, {
        accountId,
        conversationId: res.conversationId,
        contactId: res.contactId,
        phoneNormalized: normalizePhone(from),
      }),
    );
```

(`normalizePhone` is already imported in `ingest.ts` — verify; it is used at line ~740.)

- [ ] **Step 5:** Run `npx vitest run convex/qualificationEngine.test.ts convex/ingest.test.ts` → PASS. (The `internal.qualificationEngine` reference will not typecheck until Task 6's api.d.ts edit — vitest is fine because convex-test resolves modules at runtime; run `npx tsc --noEmit` only after Task 6.)

- [ ] **Step 6: Commit**

```bash
git add convex/qualificationEngine.ts convex/qualificationEngine.test.ts convex/ingest.ts
git commit -m "feat(qualification): inbound session tracking hook in the ingest fan-out"
```

---

### Task 5: Outbound hook in `messages.appendInternal`

**Files:**
- Modify: `convex/messages.ts` (`appendInternal` handler)
- Test: append to `convex/qualificationEngine.test.ts`

**Interfaces (consumed):** `recordOutboundSend` from Task 3. `appendInternal` is the single persist step every outbound send (inbox agent send, automations, flows, broadcasts, AI replies, REST v1) already goes through — one hook covers them all (spec §6 "on outbound").

- [ ] **Step 1: Write the failing tests** — append to `convex/qualificationEngine.test.ts`:

```ts
test("appendInternal (agent send) opens an outbound session and stamps humanTouchedAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seed(t);
  await t.mutation(internal.messages.appendInternal, {
    accountId, conversationId, senderType: "agent",
    contentType: "text", contentText: "Hello from an agent",
  });
  const rows = await sessionsFor(t, conversationId);
  expect(rows).toHaveLength(1);
  expect(rows[0].origin).toBe("outbound");
  expect(rows[0].humanTouchedAt).toBeGreaterThan(0);
});

test("appendInternal (bot send) opens a session but never sets humanTouchedAt; disabled config no-ops", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seed(t);
  await t.mutation(internal.messages.appendInternal, {
    accountId, conversationId, senderType: "bot",
    contentType: "text", contentText: "template blast",
  });
  const rows = await sessionsFor(t, conversationId);
  expect(rows).toHaveLength(1);
  expect(rows[0].humanTouchedAt).toBeUndefined();

  const off = await seed(t, { enabled: false });
  await t.mutation(internal.messages.appendInternal, {
    accountId: off.accountId, conversationId: off.conversationId, senderType: "agent",
    contentType: "text", contentText: "hi",
  });
  expect(await sessionsFor(t, off.conversationId)).toHaveLength(0);
});
```

- [ ] **Step 2:** Run → FAIL (no sessions written).

- [ ] **Step 3: Implement.** In `convex/messages.ts` `appendInternal`, replace the handler body's return with a capture + hook + return, and add the import:

```ts
import { loadEnabledConfig, recordOutboundSend } from "./lib/qualification/track";
```

```ts
  handler: async (ctx, args) => {
    const conversation = await requireOwnConversation(
      ctx,
      args.accountId,
      args.conversationId,
    );
    const result = await insertMessageAndUpdateConversation(ctx, args, conversation);

    // Qualification P0 (spec §6): every outbound send — agent, bot,
    // broadcast — flows through this one persist step, so this is THE
    // outbound tracking hook. try/catch: a tracking bug must never fail
    // the send that already went out to Meta. Customer rows never reach
    // this mutation (inbound persists via `ingest.ingestInbound`), but
    // guard anyway.
    if (args.senderType === "agent" || args.senderType === "bot") {
      try {
        const config = await loadEnabledConfig(ctx, args.accountId);
        if (config) {
          await recordOutboundSend(ctx, {
            accountId: args.accountId,
            conversationId: args.conversationId,
            senderType: args.senderType,
            now: Date.now(),
          });
        }
      } catch (err) {
        console.error("[qualification] outbound tracking failed:", err);
      }
    }
    return result;
  },
```

- [ ] **Step 4:** Run `npx vitest run convex/qualificationEngine.test.ts convex/messages.test.ts convex/send.test.ts` → PASS (messages/send suites prove no regression on the persist path).

- [ ] **Step 5: Commit**

```bash
git add convex/messages.ts convex/qualificationEngine.test.ts
git commit -m "feat(qualification): outbound session tracking in the shared message persist step"
```

---

### Task 6: Config CRUD (`convex/qualification.ts`) + hand-edited codegen

**Files:**
- Create: `convex/qualification.ts`
- Create: `convex/lib/qualification/validate.ts`
- Modify: `convex/_generated/api.d.ts` (hand edit — Global Constraints)
- Test: append to `convex/qualification.test.ts`

**Interfaces (produced):**
- `api.qualification.getConfig({})` → `Doc<"qualificationConfigs">`-shaped object (stored row, or the defaults with `accountId` when absent) + `{ isPersisted: boolean }`. `requireRole("admin")`.
- `api.qualification.updateConfig({ patch })` → upserts (seeding defaults first if absent), validates, stamps `updatedAt`. `requireRole("admin")`.
- `validateConfigPatch(patch)` (pure) → `string | null` error.

- [ ] **Step 1: Write the failing tests** — append to `convex/qualification.test.ts`:

```ts
import { api } from "./_generated/api";
import type { AccountRole } from "./lib/roles";

async function seedMember(t: ReturnType<typeof convexTest>, role: AccountRole) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: role, email: `${role}@example.com` }));
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", { name: "A", defaultCurrency: "AED", ownerUserId: userId });
    await ctx.db.insert("memberships", { userId, accountId: id, role, fullName: role, email: `${role}@example.com` });
    return id;
  });
  return { userId, accountId, as: t.withIdentity({ subject: `${userId}|s` }) };
}

test("getConfig returns seeded defaults when no row exists, and the row after updateConfig", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  const before = await admin.as.query(api.qualification.getConfig, {});
  expect(before.isPersisted).toBe(false);
  expect(before.enabled).toBe(false);
  expect(before.workStartMinute).toBe(600);

  await admin.as.mutation(api.qualification.updateConfig, { patch: { enabled: true } });
  const after = await admin.as.query(api.qualification.getConfig, {});
  expect(after.isPersisted).toBe(true);
  expect(after.enabled).toBe(true);
  expect(after.basicFields.length).toBe(4); // defaults seeded alongside the patch
});

test("updateConfig rejects invalid values and non-admin callers", async () => {
  const t = convexTest(schema, modules);
  const admin = await seedMember(t, "admin");
  await expect(
    admin.as.mutation(api.qualification.updateConfig, { patch: { qualifyThresholdScore: 150 } }),
  ).rejects.toThrow();
  await expect(
    admin.as.mutation(api.qualification.updateConfig, {
      patch: { workStartMinute: 1300, workEndMinute: 600 },
    }),
  ).rejects.toThrow();

  const supervisor = await seedMember(t, "supervisor");
  await expect(
    supervisor.as.mutation(api.qualification.updateConfig, { patch: { enabled: true } }),
  ).rejects.toThrow(); // FORBIDDEN — admin-gated (spec §12)
});
```

- [ ] **Step 2:** Run `npx vitest run convex/qualification.test.ts` → FAIL.

- [ ] **Step 3: Implement** `convex/lib/qualification/validate.ts`:

```ts
import type { Doc } from "../../_generated/dataModel";

export type QualificationConfigPatch = Partial<
  Omit<Doc<"qualificationConfigs">, "_id" | "_creationTime" | "accountId" | "updatedAt">
>;

/** Pure patch validation for `qualification.updateConfig` — returns an
 *  error string (thrown by the mutation as BAD_REQUEST) or null. Only
 *  checks fields present on the patch; merged-state rules (start < end)
 *  are checked by the caller against the merged row. */
export function validateConfigPatch(patch: QualificationConfigPatch): string | null {
  if (patch.qualifyThresholdScore !== undefined &&
      (patch.qualifyThresholdScore < 0 || patch.qualifyThresholdScore > 100)) {
    return "qualifyThresholdScore must be 0–100";
  }
  for (const key of ["workStartMinute", "workEndMinute"] as const) {
    const value = patch[key];
    if (value !== undefined && (value < 0 || value >= 24 * 60)) return `${key} out of range`;
  }
  if (patch.workDays !== undefined &&
      (patch.workDays.length === 0 || patch.workDays.some((d) => d < 0 || d > 6))) {
    return "workDays must be non-empty, 0–6";
  }
  if (patch.followUpDelaysMinutes !== undefined &&
      (patch.followUpDelaysMinutes.length === 0 || patch.followUpDelaysMinutes.some((m) => m < 5))) {
    return "followUpDelaysMinutes must be >= 5 minutes each";
  }
  if (patch.maxFollowUps !== undefined && (patch.maxFollowUps < 1 || patch.maxFollowUps > 10)) {
    return "maxFollowUps must be 1–10";
  }
  if (patch.sessionWindowHours !== undefined &&
      (patch.sessionWindowHours < 1 || patch.sessionWindowHours > 24 * 14)) {
    return "sessionWindowHours must be 1–336";
  }
  if (patch.basicFields !== undefined) {
    if (patch.basicFields.length === 0) return "basicFields must not be empty";
    for (const f of patch.basicFields) {
      if (!f.key.trim() || !f.label.trim() || f.phrasings.length === 0) {
        return "each basic field needs a key, label and at least one phrasing";
      }
    }
  }
  return null;
}
```

`convex/qualification.ts`:

```ts
import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import { holidayysDefaultConfig } from "./lib/qualification/defaults";
import { validateConfigPatch } from "./lib/qualification/validate";

// ============================================================
// Lead-qualification config CRUD (P0 — spec §11/§12). Admin-gated on
// BOTH read and write: the config carries admin phone numbers. The
// engine itself never reads through here (it uses
// `lib/qualification/track.ts`'s `loadEnabledConfig`).
// ============================================================

// `v.any()` + pure validation (not a giant validator literal): the patch
// is admin-only input, schema enforcement happens on the insert/patch
// against the table validator anyway, and the pure `validateConfigPatch`
// gives friendlier errors + unit-testability.
export const getConfig = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const row = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();
    if (row) return { ...row, isPersisted: true as const };
    return {
      ...holidayysDefaultConfig(),
      accountId: ctx.accountId,
      isPersisted: false as const,
    };
  },
});

export const updateConfig = accountMutation({
  args: { patch: v.any() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const patch = (args.patch ?? {}) as Record<string, unknown>;
    delete patch._id; delete patch._creationTime;
    delete patch.accountId; delete patch.isPersisted;

    const error = validateConfigPatch(patch);
    if (error) throw new ConvexError({ code: "BAD_REQUEST", reason: error });

    const existing = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();

    const base = existing ?? { ...holidayysDefaultConfig(), accountId: ctx.accountId };
    const merged = { ...base, ...patch, updatedAt: Date.now() };
    const start = merged.workStartMinute as number;
    const end = merged.workEndMinute as number;
    if (start >= end) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "workStartMinute must be before workEndMinute" });
    }

    if (existing) {
      const { _id, _creationTime, ...update } = merged as typeof existing;
      await ctx.db.patch(existing._id, update);
      return existing._id;
    }
    const { ...insert } = merged;
    return await ctx.db.insert("qualificationConfigs", insert as never);
  },
});
```

- [ ] **Step 4: Hand-edit `convex/_generated/api.d.ts`** (the standing offline-codegen rule). Alphabetically insert the four imports:

```ts
import type * as lib_qualification_defaults from "../lib/qualification/defaults.js";
import type * as lib_qualification_track from "../lib/qualification/track.js";
import type * as lib_qualification_validate from "../lib/qualification/validate.js";
```
(after `lib_pushRecipients`, before `lib_roles`), and
```ts
import type * as qualification from "../qualification.js";
import type * as qualificationEngine from "../qualificationEngine.js";
```
(after `pushSend`, before `quickReplies`). Then add the matching entries in the `fullApi` object literal, same alphabetical spots:

```ts
  "lib/qualification/defaults": typeof lib_qualification_defaults;
  "lib/qualification/track": typeof lib_qualification_track;
  "lib/qualification/validate": typeof lib_qualification_validate;
  ...
  qualification: typeof qualification;
  qualificationEngine: typeof qualificationEngine;
```
(Match the existing `lib/...` key-quoting style used by e.g. `"lib/pushRecipients"` — check the file; keys with slashes are quoted.)

- [ ] **Step 5:** Run `npx vitest run convex/qualification.test.ts` → PASS, then `npx tsc --noEmit` → 0 errors (this is the gate that proves the api.d.ts hand-edit is right — Task 4's `internal.qualificationEngine` reference resolves now).

- [ ] **Step 6: Commit**

```bash
git add convex/qualification.ts convex/lib/qualification/validate.ts convex/qualification.test.ts convex/_generated/api.d.ts
git commit -m "feat(qualification): admin config CRUD with seeded defaults + hand-edited codegen"
```

---

### Task 7: Settings tab skeleton (admin-only)

**Files:**
- Modify: `src/components/settings/settings-sections.ts` (new section)
- Modify: `src/lib/auth/roles.ts` (`SettingsSectionKey` + `CRITICAL_SECTIONS`)
- Create: `src/components/settings/qualification-settings.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx` (import + panel entry)
- Modify: `messages/en.json` (`Settings.qualification` block)

**Interfaces (consumed):** `api.qualification.getConfig` / `api.qualification.updateConfig` from Task 6.

- [ ] **Step 1:** `settings-sections.ts` — add `'qualification'` to `SETTINGS_SECTIONS` (after `'conversions'`), and to `SECTION_META`:

```ts
import { ..., ClipboardCheck } from 'lucide-react';
...
  qualification: { id: 'qualification', label: 'Lead qualification', icon: ClipboardCheck, group: 'workspace' },
```

- [ ] **Step 2:** `src/lib/auth/roles.ts` — add `"qualification"` to the `SettingsSectionKey` union/list (wherever the existing keys are declared in that file) and to `CRITICAL_SECTIONS`:

```ts
const CRITICAL_SECTIONS: SettingsSectionKey[] = ["whatsapp", "api", "members", "conversions", "qualification"];
```

- [ ] **Step 3:** Create `src/components/settings/qualification-settings.tsx` — P0 skeleton: admin gate, master toggle, read-only summary of the active defaults, and a "what's coming" note. Follow `conversions-tab.tsx`'s structure (RequireRole + skip-query pattern):

```tsx
'use client';

import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';
import { ClipboardCheck, Loader2 } from 'lucide-react';

import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { SettingsPanelHead } from './settings-panel-head';

import { api } from '../../../convex/_generated/api';

function fmtMinute(minute: number): string {
  const h = String(Math.floor(minute / 60)).padStart(2, '0');
  const m = String(minute % 60).padStart(2, '0');
  return `${h}:${m}`;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function QualificationSettings() {
  const t = useTranslations('Settings.qualification');
  const { canEditCriticalSettings } = useAuth();
  const config = useQuery(
    api.qualification.getConfig,
    canEditCriticalSettings ? {} : 'skip',
  );
  const updateConfig = useMutation(api.qualification.updateConfig);
  const [saving, setSaving] = useState(false);

  const onToggle = async (enabled: boolean) => {
    setSaving(true);
    try {
      await updateConfig({ patch: { enabled } });
    } finally {
      setSaving(false);
    }
  };

  return (
    <RequireRole min="admin">
      <div className="space-y-6">
        <SettingsPanelHead
          icon={ClipboardCheck}
          title={t('title')}
          description={t('description')}
        />
        {config === undefined ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <>
            <Card>
              <CardContent className="flex items-center justify-between gap-4 pt-6">
                <div>
                  <p className="text-sm font-medium text-foreground">{t('enableLabel')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('enableDesc')}</p>
                </div>
                <div className="flex items-center gap-2">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
                  <Switch checked={config.enabled} onCheckedChange={onToggle} disabled={saving} />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-3 pt-6 text-sm">
                <p className="font-medium text-foreground">{t('defaultsTitle')}</p>
                <p className="text-muted-foreground">
                  {t('hours', {
                    start: fmtMinute(config.workStartMinute),
                    end: fmtMinute(config.workEndMinute),
                    tz: config.timezoneLabel,
                    days: config.workDays.map((d) => DAY_LABELS[d]).join(', '),
                  })}
                </p>
                <p className="text-muted-foreground">
                  {t('cadence', {
                    count: config.maxFollowUps,
                    window: config.sessionWindowHours,
                    threshold: config.qualifyThresholdScore,
                  })}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {config.basicFields.map((f) => (
                    <Badge key={f.key} variant="secondary">{f.label}</Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{t('comingSoon')}</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </RequireRole>
  );
}
```

Before finishing this step, open `src/components/settings/settings-panel-head.tsx` and one existing usage — if its props differ from `{icon, title, description}`, match the real signature. Same for `RequireRole` (`src/components/auth/require-role.tsx`) and `useAuth().canEditCriticalSettings` (already used by `conversions-tab.tsx`). If `@/components/ui/switch` does not exist, use the checkbox pattern from an existing settings panel instead.

- [ ] **Step 4:** Wire into `src/app/(dashboard)/settings/page.tsx`:

```tsx
import { QualificationSettings } from '@/components/settings/qualification-settings';
...
    conversions: <ConversionsTab />,
    qualification: <QualificationSettings />,
```

- [ ] **Step 5:** `messages/en.json` — inside the top-level `"Settings"` object, after the `"conversions"` block, add:

```json
"qualification": {
  "title": "Lead qualification",
  "description": "AI-driven qualification sessions on every chat: questions from your service docs, automatic follow-ups, lead scoring, and a Meta signal when a lead qualifies.",
  "enableLabel": "Enable lead qualification",
  "enableDesc": "Dormant until enabled. Turning this on starts tracking qualification sessions for new conversations.",
  "defaultsTitle": "Active configuration",
  "hours": "Follow-up hours: {start}–{end} {tz} · {days}",
  "cadence": "Up to {count} follow-ups within {window}h · qualify at score ≥ {threshold}",
  "comingSoon": "Question editing, follow-up cadence, admin alerts and the Leads workspace arrive with the next phases — this switch only enables session tracking for now."
},
```

Also add `"qualification": "Lead qualification"` to `Settings.sections` if that map exists in en.json (check how `settings-rail.tsx` resolves labels — SECTION_META label vs i18n; mirror whichever the rail actually uses).

- [ ] **Step 6: Verify**

```bash
npx next lint --file src/components/settings/qualification-settings.tsx \
  --file src/components/settings/settings-sections.ts \
  --file "src/app/(dashboard)/settings/page.tsx"
npx tsc --noEmit
```
Expected: 0 errors. (Repo convention: no component tests for settings gating — the RBAC is enforced server-side and covered by Task 6's tests.)

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/ src/lib/auth/roles.ts "src/app/(dashboard)/settings/page.tsx" messages/en.json
git commit -m "feat(qualification): admin settings tab skeleton with master toggle"
```

---

### Task 8: Full verification

- [ ] **Step 1:** `npx vitest run` → full suite green (baseline was 1650+; expect +~12 new).
- [ ] **Step 2:** `npx tsc --noEmit` → 0 errors.
- [ ] **Step 3:** `npx next lint` → 0 errors (warnings only if pre-existing).
- [ ] **Step 4:** `npm run build` → succeeds.
- [ ] **Step 5:** Commit any straggler fixes:

```bash
git add -A && git commit -m "chore(qualification): P0 verification fixes" || echo "clean"
```

**P0 deploy note (for the eventual release, NOT part of this plan's execution):** `npx convex deploy` (adds the 2 tables + 3 indexes + widened union — additive, zero-risk to live traffic) BEFORE the Netlify push. Feature stays invisible until an admin flips the toggle.

---

## Self-review

- **Spec coverage (P0 scope, spec §16):** schema ✓ (Task 2, full §5 shapes so P1–P4 need no migration), config CRUD + Holidayys defaults ✓ (Tasks 3/6), session upsert hooks ingest ✓ (Task 4) / send+broadcast ✓ (Task 5 — `appendInternal` is the shared persist step for BOTH, which is why there is no separate broadcast task), Settings tab skeleton ✓ (Task 7). Admin-number loop guard front-loaded into P0 ✓ (Task 4) so no session ever exists for alert channels even before P2 ships alerts.
- **Placeholders:** none — every step has runnable code/commands.
- **Type consistency:** `ensureSession/recordInboundActivity/recordOutboundSend/loadEnabledConfig/isAdminAlertNumber` signatures match across Tasks 3–5; `holidayysDefaultConfig` consumed in Tasks 3/4/6 with the same shape; `api.qualification.getConfig/updateConfig` names match Task 7's component.
