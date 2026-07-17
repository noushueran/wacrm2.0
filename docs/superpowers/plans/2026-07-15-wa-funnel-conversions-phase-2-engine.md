# WA Funnel Conversions — Phase 2: Funnel engine (`setStage`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agents a backend to advance a conversation's funnel stage — `funnel.setStage` records the current stage on the conversation, appends a `funnelTransitions` audit row, and (for an attributed conversation whose stage maps to a Meta event) seeds + dispatches a `conversionEvents` row for the right lane, reusing the first-touch anchor.

**Architecture:** `conversation.funnel` holds the denormalized current stage (+ sale value); `funnelTransitions` is the append-only progress log. `setStage` is an `accountMutation` mirroring `conversations.setStatus`'s access guard. The auto `new_lead` is already seeded at ingest (Phase 1); this phase adds the agent-driven advance for the remaining stages. Delivery reuses Phase 1's `deliverConversionEvent`; the mapped event name + backend come from `convex/lib/funnel.ts`. UI is Phase 3.

**Tech Stack:** Convex (self-hosted), TypeScript, `convex-test` + Vitest.

## Global Constraints

- **Offline codegen only.** NEVER run `convex dev`/`deploy`/`codegen`. New field / new table = `convex/schema.ts` only. New module = hand-edit `convex/_generated/api.d.ts` (import + member); no `api.js`.
- **Stage files EXPLICITLY by exact path.** NEVER `git add -A` (untracked `.claude/worktrees/*` present).
- **Match file style** (convex files double-quoted). No broad `prettier --write`. Verify with `npm test` / `npm run typecheck` / `npm run build`.
- **Access guard:** `setStage` uses `ctx.requireRole("agent")` (excludes viewers) + `requireConversationAccess(ctx, conversationId, "own")` — the SAME mode `conversations.setStatus` uses (agent must be the conversation's assignee; supervisor+ any; viewers excluded). *(Correction: an earlier draft of this plan wrote `"view"` in error — the shipped code and `setStatus` both use `"own"`.)*
- **Dormant + reuse:** `setStage` never calls Meta directly — it inserts a `conversionEvents` row and schedules Phase 1's `internal.conversionEvents.deliverConversionEvent` (dormant without env). Dedup via `eventId = ${conversationId}:${stage}`.
- **Value rule:** `stage === "purchased"` requires `saleValue > 0` (throws `ConvexError` otherwise); currency defaults to the account's `defaultCurrency`.
- **TDD, frequent commits.** Test harness: `convexTest(schema, modules)` with `import.meta.glob("/convex/**/*.ts")`; `accountMutation`s are called via `t.withIdentity({ subject: \`${userId}|session-…\` })`.

---

## File Structure

- **Modify** `convex/schema.ts` — add `conversations.funnel` field + `funnelTransitions` table.
- **Create** `convex/funnel.ts` — `setStage` accountMutation (patches funnel, logs transition, seeds+dispatches the mapped conversion event).
- **Create** `convex/funnel.test.ts`.
- **Modify** `convex/_generated/api.d.ts` — register `funnel`.

---

### Task 1: Schema — `conversation.funnel` + `funnelTransitions`

**Files:**
- Modify: `convex/schema.ts`

**Interfaces:**
- Produces: `conversations.funnel?` object; `funnelTransitions` table → `Doc<"funnelTransitions">`, `Id<"funnelTransitions">`.

- [ ] **Step 1: Add the `funnel` field to `conversations`**

In `convex/schema.ts`, inside the `conversations: defineTable({ ... })` object, immediately AFTER the `attribution: v.optional(...)` field (added in Phase 1) and BEFORE the table's closing `})`/`.index(...)` chain, add:

```ts
    // Denormalized CURRENT funnel stage for fast inbox render + future
    // stage-filtering, without scanning `funnelTransitions`. `saleValue`/
    // `saleCurrency` are captured at the Purchased stage (and optionally at
    // quote/invoice). The full progress history lives in `funnelTransitions`.
    funnel: v.optional(
      v.object({
        stage: v.union(
          v.literal("new_lead"),
          v.literal("qualified"),
          v.literal("price_quoted"),
          v.literal("itinerary_created"),
          v.literal("itinerary_sent"),
          v.literal("invoice_sent"),
          v.literal("purchased"),
        ),
        stageUpdatedAt: v.number(),
        stageUpdatedByUserId: v.optional(v.id("users")),
        saleValue: v.optional(v.number()),
        saleCurrency: v.optional(v.string()),
      }),
    ),
```

- [ ] **Step 2: Add the `funnelTransitions` table**

In `convex/schema.ts`, immediately AFTER the `conversionEvents` table's `.index(...)` chain (added in Phase 1) and BEFORE the Phase-0 `adReferrals` table, add:

```ts
  // Append-only funnel progress log (funnel Phase 2). One row per stage
  // ENTERED, for every conversation (incl. organic and the internal
  // `itinerary_created` stage). Powers the stepper (Phase 3) + funnel
  // analytics (Phase 4). Links to the fired `conversionEvents` row when one
  // was seeded. `auto` = the ingest-seeded first-touch (Phase 1 seeds the
  // new_lead conversionEvent; a matching `auto` transition may be backfilled
  // later — this phase writes only agent-driven `auto:false` rows).
  funnelTransitions: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    stage: v.union(
      v.literal("new_lead"),
      v.literal("qualified"),
      v.literal("price_quoted"),
      v.literal("itinerary_created"),
      v.literal("itinerary_sent"),
      v.literal("invoice_sent"),
      v.literal("purchased"),
    ),
    byUserId: v.optional(v.id("users")),
    auto: v.boolean(),
    conversionEventId: v.optional(v.id("conversionEvents")),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_account_stage", ["accountId", "stage"]),
```

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` → PASS.
```bash
git add convex/schema.ts
git commit -m "feat(funnel): conversation.funnel + funnelTransitions log (Phase 2)"
```

---

### Task 2: `convex/funnel.ts` — `setStage`

**Files:**
- Create: `convex/funnel.ts`
- Create: `convex/funnel.test.ts`
- Modify: `convex/_generated/api.d.ts`

**Interfaces:**
- Consumes: `resolveEventName`/`backendForLane`/`getStage`/`FunnelStageKey` (`convex/lib/funnel.ts`, Phase 1); `requireConversationAccess` (`convex/lib/conversationAccess.ts`); `accountMutation` (`convex/lib/auth.ts`); `normalizePhone` (`convex/lib/phone.ts`); `internal.conversionEvents.deliverConversionEvent` (Phase 1).
- Produces: `api.funnel.setStage({ conversationId, stage, saleValue?, saleCurrency? }) → Id<"conversations">`.

- [ ] **Step 1: Write the failing test** — create `convex/funnel.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
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
  return { userId, accountId, asUser: t.withIdentity({ subject: `${userId}|session-${opts.name}` }) };
}

// Seeds a contact + conversation, optionally attributed with a first-touch
// new_lead conversionEvent anchor (mimicking what Phase 1's ingest seeds).
async function seedConv(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: { lane?: "code" | "ctwa"; identifier?: string; assignedToUserId?: Id<"users"> } = {},
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000000", phoneNormalized: "971500000000",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      assignedToUserId: opts.assignedToUserId,
      ...(opts.lane
        ? {
            attribution: {
              lane: opts.lane,
              ...(opts.lane === "code" ? { code: opts.identifier } : { ctwaClid: opts.identifier }),
              firstSeenAt: 1_000_000,
            },
          }
        : {}),
    });
    if (opts.lane) {
      await ctx.db.insert("conversionEvents", {
        accountId, conversationId, contactId,
        stage: "new_lead", lane: opts.lane,
        backend: opts.lane === "code" ? "platformA" : "capi",
        eventName: opts.lane === "code" ? "Lead" : "LeadSubmitted",
        identifier: opts.identifier!,
        phone: "971500000000", waMessageId: "wamid.first", firstMessageAt: 1_000_000,
        eventId: `${conversationId}:new_lead`, status: "pending", attempts: 0,
      });
    }
    return { contactId, conversationId };
  });
}

async function eventsFor(t: ReturnType<typeof convexTest>, conversationId: Id<"conversations">) {
  return await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
}
async function transitionsFor(t: ReturnType<typeof convexTest>, conversationId: Id<"conversations">) {
  return await t.run((ctx) =>
    ctx.db.query("funnelTransitions").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
}

test("setStage advances the stage, logs a transition, and seeds a capi conversion event for an ad lead", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Ann", email: "ann@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { lane: "ctwa", identifier: "clid-1", assignedToUserId: userId });

  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "price_quoted" });

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.funnel?.stage).toBe("price_quoted");
  expect(conv?.funnel?.stageUpdatedByUserId).toBe(userId);

  const evs = await eventsFor(t, conversationId);
  const quote = evs.find((e) => e.stage === "price_quoted");
  expect(quote?.backend).toBe("capi");
  expect(quote?.eventName).toBe("InitiateCheckout");
  expect(quote?.identifier).toBe("clid-1");
  expect(quote?.eventId).toBe(`${conversationId}:price_quoted`);

  const trans = await transitionsFor(t, conversationId);
  const t2 = trans.find((x) => x.stage === "price_quoted");
  expect(t2?.auto).toBe(false);
  expect(t2?.byUserId).toBe(userId);
  expect(t2?.conversionEventId).toBe(quote?._id);
});

test("setStage purchased requires a sale value; with one, seeds a Purchase event carrying value+currency", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Ben", email: "ben@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { lane: "ctwa", identifier: "clid-2", assignedToUserId: userId });

  await expect(
    asUser.mutation(api.funnel.setStage, { conversationId, stage: "purchased" }),
  ).rejects.toThrow();

  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "purchased", saleValue: 4200 });

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.funnel?.stage).toBe("purchased");
  expect(conv?.funnel?.saleValue).toBe(4200);
  expect(conv?.funnel?.saleCurrency).toBe("AED"); // account defaultCurrency

  const evs = await eventsFor(t, conversationId);
  const purchase = evs.find((e) => e.stage === "purchased");
  expect(purchase?.eventName).toBe("Purchase");
  expect(purchase?.value).toBe(4200);
  expect(purchase?.currency).toBe("AED");
});

test("setStage to an internal-only stage logs a transition but seeds NO conversion event", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Cyd", email: "cyd@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { lane: "ctwa", identifier: "clid-3", assignedToUserId: userId });

  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "itinerary_created" });

  const evs = await eventsFor(t, conversationId);
  expect(evs.some((e) => e.stage === "itinerary_created")).toBe(false);
  const trans = await transitionsFor(t, conversationId);
  expect(trans.some((x) => x.stage === "itinerary_created")).toBe(true);
});

test("setStage on an ORGANIC conversation records CRM state only (no conversion event)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Dan", email: "dan@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { assignedToUserId: userId }); // no lane = organic

  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "price_quoted" });

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.funnel?.stage).toBe("price_quoted");
  const evs = await eventsFor(t, conversationId);
  expect(evs).toHaveLength(0);
  const trans = await transitionsFor(t, conversationId);
  expect(trans.some((x) => x.stage === "price_quoted")).toBe(true);
});

test("setStage dedups the conversion event per (conversation, stage)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, { name: "Eve", email: "eve@example.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { lane: "code", identifier: "ABCDEF", assignedToUserId: userId });

  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "itinerary_sent" });
  await asUser.mutation(api.funnel.setStage, { conversationId, stage: "itinerary_sent" });

  const evs = (await eventsFor(t, conversationId)).filter((e) => e.stage === "itinerary_sent");
  expect(evs).toHaveLength(1);
  expect(evs[0].backend).toBe("platformA");
  expect(evs[0].eventName).toBe("AddToCart");
});

test("setStage is forbidden for a viewer", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, { name: "Own", email: "own@example.com", role: "owner" });
  const { asUser: asViewer } = await (async () => {
    const uid = await t.run((ctx) => ctx.db.insert("users", { name: "Vic", email: "vic@example.com" }));
    await t.run((ctx) => ctx.db.insert("memberships", { userId: uid, accountId, role: "viewer", fullName: "Vic", email: "vic@example.com" }));
    return { asUser: t.withIdentity({ subject: `${uid}|session-Vic` }) };
  })();
  const { conversationId } = await seedConv(t, accountId, { lane: "ctwa", identifier: "clid-9" });

  await expect(
    asViewer.mutation(api.funnel.setStage, { conversationId, stage: "qualified" }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- funnel.test`
Expected: FAIL — `api.funnel` / `setStage` undefined.

- [ ] **Step 3: Create the module** — create `convex/funnel.ts`:

```ts
import { accountMutation } from "./lib/auth";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireConversationAccess } from "./lib/conversationAccess";
import { normalizePhone } from "./lib/phone";
import {
  resolveEventName,
  backendForLane,
  getStage,
  type FunnelStageKey,
} from "./lib/funnel";

const STAGE_VALIDATOR = v.union(
  v.literal("new_lead"),
  v.literal("qualified"),
  v.literal("price_quoted"),
  v.literal("itinerary_created"),
  v.literal("itinerary_sent"),
  v.literal("invoice_sent"),
  v.literal("purchased"),
);

/**
 * Advances one conversation's funnel stage (agent-driven). Records the
 * denormalized current stage on the conversation, appends a
 * `funnelTransitions` audit row, and — for an ATTRIBUTED conversation whose
 * stage maps to a Meta event on its lane — seeds a deduped `conversionEvents`
 * row and schedules Phase 1's dispatcher (dormant without env). Organic
 * conversations and internal-only stages (`itinerary_created`) record CRM
 * state only. `purchased` requires a positive `saleValue`.
 *
 * Access mirrors `conversations.setStatus`: `requireRole("agent")` (viewers
 * excluded) + `requireConversationAccess(..., "own")` (agent must be the
 * conversation's assignee; all for supervisor+).
 */
export const setStage = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    stage: STAGE_VALIDATOR,
    saleValue: v.optional(v.number()),
    saleCurrency: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"conversations">> => {
    ctx.requireRole("agent");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "own",
    );

    const stage = args.stage as FunnelStageKey;
    const stageDef = getStage(stage);
    const hasValue = args.saleValue !== undefined && args.saleValue > 0;
    if (stageDef.needsValue && !hasValue) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "value_required" });
    }

    const now = Date.now();
    const account = await ctx.db.get(ctx.accountId);
    const currency = args.saleCurrency ?? account?.defaultCurrency ?? "USD";

    await ctx.db.patch(args.conversationId, {
      funnel: {
        stage,
        stageUpdatedAt: now,
        stageUpdatedByUserId: ctx.userId,
        ...(hasValue ? { saleValue: args.saleValue, saleCurrency: currency } : {}),
      },
      updatedAt: now,
    });

    // Seed the mapped Meta conversion event when the conversation is
    // attributed AND the stage maps to an event on its lane. Reuses the
    // first-touch (new_lead) row as the anchor for the Platform A contract
    // fields (phone/waMessageId/firstMessageAt).
    let conversionEventId: Id<"conversionEvents"> | undefined;
    const attribution = conversation.attribution;
    if (attribution) {
      const eventName = resolveEventName(attribution.lane, stage);
      const identifier =
        attribution.lane === "code" ? attribution.code : attribution.ctwaClid;
      if (eventName && identifier) {
        const eventId = `${args.conversationId}:${stage}`;
        const existing = await ctx.db
          .query("conversionEvents")
          .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
          .first();
        if (existing) {
          conversionEventId = existing._id;
        } else {
          const anchor = await ctx.db
            .query("conversionEvents")
            .withIndex("by_event_id", (q) =>
              q.eq("eventId", `${args.conversationId}:new_lead`),
            )
            .first();
          const contact = await ctx.db.get(conversation.contactId);
          conversionEventId = await ctx.db.insert("conversionEvents", {
            accountId: ctx.accountId,
            conversationId: args.conversationId,
            contactId: conversation.contactId,
            stage,
            lane: attribution.lane,
            backend: backendForLane(attribution.lane),
            eventName,
            identifier,
            ...(hasValue ? { value: args.saleValue, currency } : {}),
            phone: anchor?.phone ?? (contact ? normalizePhone(contact.phone) : ""),
            waMessageId: anchor?.waMessageId ?? "",
            firstMessageAt: anchor?.firstMessageAt ?? attribution.firstSeenAt,
            eventId,
            status: "pending",
            attempts: 0,
          });
          await ctx.scheduler.runAfter(
            0,
            internal.conversionEvents.deliverConversionEvent,
            { conversionEventId },
          );
        }
      }
    }

    await ctx.db.insert("funnelTransitions", {
      accountId: ctx.accountId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      stage,
      byUserId: ctx.userId,
      auto: false,
      ...(conversionEventId ? { conversionEventId } : {}),
    });

    return args.conversationId;
  },
});
```

- [ ] **Step 4: Register the module** — in `convex/_generated/api.d.ts`, add (correct alphabetical slot — `grep -n "import type \* as" convex/_generated/api.d.ts`; `funnel` sorts after `flows*`, before `handoff`/`http`-ish entries):

```ts
import type * as funnel from "../funnel.js";
```
and the member:
```ts
  funnel: typeof funnel;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- funnel.test`
Expected: PASS (6 tests).

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` → PASS.
```bash
git add convex/funnel.ts convex/funnel.test.ts convex/_generated/api.d.ts
git commit -m "feat(funnel): setStage engine — advance + transition + seed mapped conversion (Phase 2)"
```

---

### Task 3: Phase verification

**Files:** none.

- [ ] **Step 1:** `npm test` → PASS (full suite; +6 funnel tests over the Phase-1 baseline of 1498).
- [ ] **Step 2:** `npm run typecheck` → PASS.
- [ ] **Step 3:** `npm run build` → PASS.
- [ ] **Step 4:** Confirm by inspection: no `convex dev/deploy/codegen` run; `setStage` never calls Meta directly (only schedules `deliverConversionEvent`, dormant without env); organic + internal-only stages seed no conversion event; `purchased` without value throws.

---

## Self-Review

**Spec coverage (Phase 2 from design §12 + §9):**
- `funnel.setStage` mutation → Task 2. ✓ (access guard, value rule, patch funnel, insert transition, seed+dispatch mapped event, dedup.)
- `conversation.funnel` current stage → Task 1 (field) + Task 2 (patched). ✓
- `funnelTransitions` audit log → Task 1 (table) + Task 2 (inserted). ✓
- Auto `new_lead` → already seeded by Phase 1's ingest; Task 2 reuses it as the anchor (not re-seeded here). ✓
- Value capture (agent-entered at Purchase; currency default) → Task 2 (`needsValue` gate + `defaultCurrency` fallback + stored on `funnel` and the event's `custom_data`). ✓

**Placeholder scan:** every code step is complete; every test step names the command + expected result. No TBD/TODO.

**Type consistency:** `setStage({ conversationId, stage, saleValue?, saleCurrency? }) → Id<"conversations">` matches the tests. `resolveEventName(lane, stage)`/`backendForLane(lane)`/`getStage(stage)` (Phase 1 `lib/funnel.ts`) used consistently; `stage` is a `FunnelStageKey`. `conversionEvents` inserted rows carry every required Phase-1 field (`accountId…eventId`, status `pending`, attempts 0); `funnelTransitions` rows match the Task-1 schema. `internal.conversionEvents.deliverConversionEvent` is the Phase-1 dispatcher.

**Anchor-reuse note for reviewers:** advanced-stage events reuse the first-touch `new_lead` conversionEvent's `phone`/`waMessageId`/`firstMessageAt` (the Platform A contract fields) via a `by_event_id` lookup. If a code-lane conversation somehow has `attribution` set but no `new_lead` row (shouldn't happen — Phase 1's `seedNewLead` creates both atomically), the fallbacks (`normalizePhone(contact.phone)`, `""`, `attribution.firstSeenAt`) keep the row valid. The ctwa lane doesn't use these fields in delivery.
