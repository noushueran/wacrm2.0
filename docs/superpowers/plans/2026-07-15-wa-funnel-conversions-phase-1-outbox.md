# WA Funnel Conversions — Phase 1: Unified conversion outbox + dispatcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every WhatsApp conversion signal through ONE outbox (`conversionEvents`) with a lane-branching dispatcher — code lane → Platform A (web Pixel), ctwa lane → direct Meta CAPI — and re-point the ingest first-touch (`new_lead`) through it, which also fixes the latent ad-lead double-fire.

**Architecture:** A `conversation.attribution {lane, code?, ctwaClid?}` classifier (set once at ingest) + a `conversionEvents` outbox (one row per conversation×stage) + a `deliverConversionEvent` dispatcher that branches on `backend`. The ingest step that previously wrote `attributionSignals` and POSTed BOTH lanes to Platform A is replaced by one that classifies, seeds the `new_lead` conversionEvent for the correct lane, and dispatches it. `code` → Platform A only; `ctwa` → CAPI only.

**Tech Stack:** Convex (self-hosted), TypeScript, `convex-test` + Vitest, Meta CAPI for Business Messaging (v25.0) + Platform A `/whatsapp-conversion`.

## Global Constraints

- **Offline codegen only.** NEVER run `convex dev`/`deploy`/`codegen`. New table / new field on an existing table = `convex/schema.ts` only. New module = hand-edit `convex/_generated/api.d.ts` (import + member); `api.js` is a Proxy — no edit.
- **Stage files EXPLICITLY by exact path.** NEVER `git add -A` / `git add .` (an untracked `.claude/worktrees/*` dir is present).
- **Match file style** (convex files double-quoted). No broad `prettier --write`. Verify with `npm test` / `npm run typecheck` / `npm run build`; lint gate is "no NEW lint issue," not global-clean.
- **Dormant-by-default.** `deliverConversionEvent` is a no-op that leaves the row `pending` (no attempt bump) when the relevant env is unset: capi needs `META_CAPI_DATASET_ID` + `META_CAPI_ACCESS_TOKEN` + the account's `wabaId`; platformA needs `LANDING_CONVERSION_URL` + `WA_CONVERSION_SHARED_SECRET`. Graph API `v25.0` (`process.env.META_GRAPH_VERSION || "v25.0"`).
- **Meta does NOT dedupe** business-messaging events — dedup is ours, via `eventId = ${conversationId}:${stage}` + the `by_event_id` guard.
- **Preserve Platform A's first-touch contract:** the code-lane `new_lead` POST keeps the existing body fields (`code`, `phone`, `waMessageId`, `firstMessageAt`) and only ADDS `stage`/`event` — so Platform A (once extended in Phase 5) treats `stage:"new_lead"` as the legacy first-touch.
- **Deprecation, not deletion:** the old `attribution.ts` write path (`recordSignal`/`sendSignal`/`patchResult`/`getPendingToRetry`/`retryPending`) and the `attributionSignals` table + `listConversions` UI stay in place, no longer called by the pipeline (removed in a later cleanup). Only the ingest call site and the `retry-attribution-signals` cron change. The pure `extractRefCode`/`extractCtwaClid` helpers are REUSED.

## Status-set note (intentional refinement of the design spec)

The spec's `conversionEvents.status` listed a `skipped` state for "dormant". This plan instead leaves dormant rows `pending` (no bump) so the retry cron resends them once env is configured — identical to the worktree's `capiEvents` dormancy, and simpler. Final states: `pending | sent | unmatched | error | abandoned`. `unmatched` (Platform A said no match) is terminal (not retried).

---

## File Structure

- **Create** `convex/lib/funnel.ts` — `FUNNEL_STAGES` config + `FunnelStageKey` + `resolveEventName(lane, key)` + `backendForLane(lane)`. Pure, dependency-free.
- **Create** `convex/lib/funnel.test.ts`.
- **Create** `convex/conversionEvents.ts` — `getById`, `getWabaId`, `patchStatus`, `deliverConversionEvent` (capi | platformA branches), `getPendingToRetry`, `retryConversionEvents`, `seedNewLead`.
- **Create** `convex/conversionEvents.test.ts`.
- **Modify** `convex/schema.ts` — add `conversations.attribution` field + `conversionEvents` table.
- **Modify** `convex/_generated/api.d.ts` — register `conversionEvents`.
- **Modify** `convex/crons.ts` — add `retry-conversion-events`; remove `retry-attribution-signals`.
- **Modify** `convex/ingest.ts` — replace the `attribution.signal` best-effort step with the classify + seed-new-lead + dispatch step.
- **Modify** `convex/ingest.test.ts` — assert code→platformA and ctwa→capi `new_lead` rows; assert NO `attributionSignals` row.

---

### Task 1: Stage config — `convex/lib/funnel.ts`

**Files:**
- Create: `convex/lib/funnel.ts`
- Create: `convex/lib/funnel.test.ts`

**Interfaces:**
- Produces: `FUNNEL_STAGES` (readonly array), `FunnelStageKey` (union type), `FUNNEL_STAGE_KEYS: FunnelStageKey[]`, `getStage(key): {key,label,metaCapi,webPixel,auto,needsValue}`, `resolveEventName(lane: "code"|"ctwa", key: FunnelStageKey): string | null` (null = not sent on that lane), `backendForLane(lane): "platformA"|"capi"`.

- [ ] **Step 1: Write the failing test** — create `convex/lib/funnel.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_KEYS,
  getStage,
  resolveEventName,
  backendForLane,
} from "./funnel";

test("there are 7 stages in funnel order, new_lead first and purchased last", () => {
  expect(FUNNEL_STAGE_KEYS).toEqual([
    "new_lead",
    "qualified",
    "price_quoted",
    "itinerary_created",
    "itinerary_sent",
    "invoice_sent",
    "purchased",
  ]);
});

test("only new_lead is auto; only purchased needs a value", () => {
  expect(FUNNEL_STAGES.filter((s) => s.auto).map((s) => s.key)).toEqual([
    "new_lead",
  ]);
  expect(FUNNEL_STAGES.filter((s) => s.needsValue).map((s) => s.key)).toEqual([
    "purchased",
  ]);
});

test("resolveEventName maps each lane to its event, null for internal-only", () => {
  expect(resolveEventName("ctwa", "new_lead")).toBe("LeadSubmitted");
  expect(resolveEventName("code", "new_lead")).toBe("Lead");
  expect(resolveEventName("ctwa", "purchased")).toBe("Purchase");
  expect(resolveEventName("code", "purchased")).toBe("Purchase");
  expect(resolveEventName("ctwa", "invoice_sent")).toBe("OrderCreated");
  expect(resolveEventName("code", "invoice_sent")).toBe("InitiateCheckout");
  // itinerary_created is internal-only on BOTH lanes
  expect(resolveEventName("ctwa", "itinerary_created")).toBeNull();
  expect(resolveEventName("code", "itinerary_created")).toBeNull();
});

test("backendForLane routes code→platformA, ctwa→capi", () => {
  expect(backendForLane("code")).toBe("platformA");
  expect(backendForLane("ctwa")).toBe("capi");
});

test("getStage returns the stage record by key", () => {
  expect(getStage("qualified").metaCapi).toBe("QualifiedLead");
  expect(getStage("price_quoted").webPixel).toBe("InitiateCheckout");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- funnel`
Expected: FAIL — module `./funnel` not found.

- [ ] **Step 3: Create the module** — create `convex/lib/funnel.ts`:

```ts
// The fixed sales funnel — the single source of truth for the stages an
// agent advances a conversation through, and how each maps to a Meta event
// per lane. Pure + dependency-free (no Convex/React) so it is unit-testable
// and shared by the dispatcher, the setStage mutation (Phase 2), and the UI.
//
// `metaCapi` = the business-messaging event sent on the AD (ctwa) lane.
// `webPixel` = the web-Pixel event Platform A fires on the WEBSITE (code)
// lane. `null` = internal-only (a back-office milestone, never sent to Meta).
// Meta's business-messaging event vocabulary is a FIXED set — these names
// come from it; web-Pixel names are web-standard events.

export const FUNNEL_STAGES = [
  { key: "new_lead", label: "New lead", metaCapi: "LeadSubmitted", webPixel: "Lead", auto: true, needsValue: false },
  { key: "qualified", label: "Qualified lead", metaCapi: "QualifiedLead", webPixel: "Lead", auto: false, needsValue: false },
  { key: "price_quoted", label: "Price quoted", metaCapi: "InitiateCheckout", webPixel: "InitiateCheckout", auto: false, needsValue: false },
  { key: "itinerary_created", label: "Itinerary created", metaCapi: null, webPixel: null, auto: false, needsValue: false },
  { key: "itinerary_sent", label: "Itinerary sent", metaCapi: "AddToCart", webPixel: "AddToCart", auto: false, needsValue: false },
  { key: "invoice_sent", label: "Invoice sent", metaCapi: "OrderCreated", webPixel: "InitiateCheckout", auto: false, needsValue: false },
  { key: "purchased", label: "Purchased", metaCapi: "Purchase", webPixel: "Purchase", auto: false, needsValue: true },
] as const;

export type FunnelStageKey = (typeof FUNNEL_STAGES)[number]["key"];

export const FUNNEL_STAGE_KEYS: FunnelStageKey[] = FUNNEL_STAGES.map(
  (s) => s.key,
);

export type FunnelLane = "code" | "ctwa";

export function getStage(key: FunnelStageKey) {
  const stage = FUNNEL_STAGES.find((s) => s.key === key);
  if (!stage) throw new Error(`unknown funnel stage: ${key}`);
  return stage;
}

/** The Meta event to send for a (lane, stage), or null when this stage is
 *  internal-only (not reported to Meta on any lane). */
export function resolveEventName(
  lane: FunnelLane,
  key: FunnelStageKey,
): string | null {
  const stage = getStage(key);
  return lane === "ctwa" ? stage.metaCapi : stage.webPixel;
}

/** Which delivery backend a lane dispatches to. */
export function backendForLane(lane: FunnelLane): "platformA" | "capi" {
  return lane === "code" ? "platformA" : "capi";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- funnel`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` → PASS.
```bash
git add convex/lib/funnel.ts convex/lib/funnel.test.ts
git commit -m "feat(funnel): fixed stage config + per-lane event mapping (Phase 1)"
```

---

### Task 2: Schema — `conversation.attribution` + `conversionEvents`

**Files:**
- Modify: `convex/schema.ts` — add the `attribution` field to the `conversations` table's object, and add the `conversionEvents` table after `attributionSignals`.

**Interfaces:**
- Produces: `conversations.attribution?` object; the `conversionEvents` table → `Doc<"conversionEvents">`, `Id<"conversionEvents">`.

- [ ] **Step 1: Add the `attribution` field to `conversations`**

In `convex/schema.ts`, inside the `conversations: defineTable({ ... })` object, immediately AFTER the `adReferral: v.optional(...)` field (ends `),` around line 164) and BEFORE the `})` that closes the table's object (before its `.index(...)` chain), add:

```ts
    // Lead-source classifier for the conversion funnel. Set ONCE, the first
    // time an attribution identifier is seen on an inbound message (the HY-
    // zero-width code → website lane, or the Meta `ctwa_clid` → ad lane);
    // never overwritten. Both identifiers are retained if both ever appear;
    // `lane` (code-wins) decides which backend the funnel dispatches to, so a
    // conversation never double-fires. Absent = organic (never reported).
    attribution: v.optional(
      v.object({
        lane: v.union(v.literal("code"), v.literal("ctwa")),
        code: v.optional(v.string()),
        ctwaClid: v.optional(v.string()),
        firstSeenAt: v.number(),
      }),
    ),
```

- [ ] **Step 2: Add the `conversionEvents` table**

In `convex/schema.ts`, immediately AFTER the `attributionSignals` table's `.index(...)` chain (around line 1146) and BEFORE the `adReferrals` table added in Phase 0, add:

```ts
  // ============================================================
  // Unified conversion outbox (funnel Phase 1). One row per
  // (conversation, stage) that maps to a Meta event. `backend`
  // discriminates delivery: "platformA" (website/code lane → web Pixel via
  // go-holidayys) or "capi" (ad/ctwa lane → direct Meta CAPI). `eventId`
  // (= `${conversationId}:${stage}`) is our dedup key — Meta does not dedupe
  // business-messaging events. Dormant rows stay `pending` (no attempt bump)
  // until env is configured; the retry cron resends them.
  // ============================================================
  conversionEvents: defineTable({
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
    lane: v.union(v.literal("code"), v.literal("ctwa")),
    backend: v.union(v.literal("platformA"), v.literal("capi")),
    eventName: v.string(), // resolved per lane (web-pixel name | business_messaging name)
    identifier: v.string(), // HY-code (code lane) | ctwa_clid (ctwa lane)
    value: v.optional(v.number()),
    currency: v.optional(v.string()),
    phone: v.string(),
    waMessageId: v.string(),
    firstMessageAt: v.number(),
    eventId: v.string(), // `${conversationId}:${stage}` — dedup
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("unmatched"),
      v.literal("error"),
      v.literal("abandoned"),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    fbTraceId: v.optional(v.string()),
    matchResult: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_event_id", ["eventId"])
    .index("by_status", ["status"])
    .index("by_account_stage", ["accountId", "stage"]),
```

- [ ] **Step 3: Typecheck + commit**

Run: `npm run typecheck` → PASS.
```bash
git add convex/schema.ts
git commit -m "feat(funnel): conversation.attribution + conversionEvents outbox table (Phase 1)"
```

---

### Task 3: Dispatcher — `convex/conversionEvents.ts`

**Files:**
- Create: `convex/conversionEvents.ts`
- Create: `convex/conversionEvents.test.ts`
- Modify: `convex/_generated/api.d.ts` (register `conversionEvents`)
- Modify: `convex/crons.ts` (add `retry-conversion-events`; remove `retry-attribution-signals`)

**Interfaces:**
- Consumes: `conversionEvents` table (Task 2); `whatsappConfig` (`by_account` index) for the wabaId.
- Produces: `internal.conversionEvents.getById`, `.getWabaId`, `.patchStatus`, `.deliverConversionEvent({ conversionEventId })`, `.getPendingToRetry`, `.retryConversionEvents`; const `MAX_DELIVER_ATTEMPTS = 5`. Dispatcher branches on `row.backend`: `capi` → POST Meta CAPI; `platformA` → POST Platform A.

- [ ] **Step 1: Write the failing test** — create `convex/conversionEvents.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test, afterEach } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Acme", email: "acme@example.com" });
    return await ctx.db.insert("accounts", { name: "Acme", defaultCurrency: "USD", ownerUserId: userId });
  });
}

async function seedConversation(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+15551230000", phoneNormalized: "15551230000" });
    const conversationId = await ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 });
    return { contactId, conversationId };
  });
}

async function seedWaba(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  await t.run((ctx) => ctx.db.insert("whatsappConfig", { accountId, wabaId: "WABA1", phoneNumberId: "PN1" }));
}

async function seedEvent(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  contactId: Id<"contacts">,
  over: Partial<{ backend: "platformA" | "capi"; lane: "code" | "ctwa"; eventName: string; identifier: string; stage: string; value: number; currency: string; status: string; attempts: number }> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("conversionEvents", {
      accountId, conversationId, contactId,
      stage: (over.stage ?? "new_lead") as "new_lead",
      lane: over.lane ?? "ctwa",
      backend: over.backend ?? "capi",
      eventName: over.eventName ?? "LeadSubmitted",
      identifier: over.identifier ?? "clid-1",
      value: over.value,
      currency: over.currency,
      phone: "+15551230000",
      waMessageId: "wamid.1",
      firstMessageAt: 1_000_000,
      eventId: `${conversationId}:${over.stage ?? "new_lead"}`,
      status: (over.status ?? "pending") as "pending",
      attempts: over.attempts ?? 0,
    }),
  );
}

const env = ["META_CAPI_DATASET_ID", "META_CAPI_ACCESS_TOKEN", "LANDING_CONVERSION_URL", "WA_CONVERSION_SHARED_SECRET"];
const orig: Record<string, string | undefined> = {};
for (const k of env) orig[k] = process.env[k];
const origFetch = globalThis.fetch;
afterEach(() => {
  for (const k of env) { if (orig[k] === undefined) delete process.env[k]; else process.env[k] = orig[k]; }
  globalThis.fetch = origFetch;
});

test("capi: dormant without env leaves the row pending (no attempt bump)", async () => {
  delete process.env.META_CAPI_DATASET_ID;
  delete process.env.META_CAPI_ACCESS_TOKEN;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "capi", lane: "ctwa" });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("pending");
  expect(row?.attempts).toBe(0);
});

test("capi: POSTs the business_messaging payload and marks sent + fbTraceId", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  let captured: any = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ fbtrace_id: "trace-9" }), { status: 200 });
  }) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, {
    backend: "capi", lane: "ctwa", stage: "purchased", eventName: "Purchase", value: 1500, currency: "AED",
  });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const ev = captured.data[0];
  expect(ev.event_name).toBe("Purchase");
  expect(ev.action_source).toBe("business_messaging");
  expect(ev.messaging_channel).toBe("whatsapp");
  expect(ev.user_data.whatsapp_business_account_id).toBe("WABA1");
  expect(ev.user_data.ctwa_clid).toBe("clid-1");
  expect(ev.custom_data).toEqual({ value: 1500, currency: "AED" });
  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("sent");
  expect(row?.fbTraceId).toBe("trace-9");
});

test("platformA: POSTs code + stage/event and marks sent on matched", async () => {
  process.env.LANDING_CONVERSION_URL = "https://a.example/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "secret";
  let captured: any = null;
  let authHeader: string | null = null;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(init.body as string);
    authHeader = (init.headers as Record<string, string>).Authorization;
    return new Response(JSON.stringify({ matched: true, firedAt: 123, offerSlug: "maldives" }), { status: 200 });
  }) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, {
    backend: "platformA", lane: "code", eventName: "Lead", identifier: "ABCDEF",
  });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  expect(captured.code).toBe("ABCDEF");
  expect(captured.stage).toBe("new_lead");
  expect(captured.event).toBe("Lead");
  expect(captured.phone).toBe("+15551230000");
  expect(authHeader).toBe("Bearer secret");
  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("sent");
  expect(row?.matchResult).toBe("maldives");
});

test("platformA: marks unmatched when Platform A returns matched:false", async () => {
  process.env.LANDING_CONVERSION_URL = "https://a.example/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "secret";
  globalThis.fetch = (async () => new Response(JSON.stringify({ matched: false, reason: "no click" }), { status: 200 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "platformA", lane: "code", eventName: "Lead", identifier: "ABCDEF" });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("unmatched");
});

test("error path bumps attempts; the bump that reaches MAX retires to abandoned", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "capi", lane: "ctwa", attempts: 4 });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });

  const row = await t.run((ctx) => ctx.db.get(id));
  expect(row?.status).toBe("abandoned");
  expect(row?.attempts).toBe(5);
});

test("already-sent row is a no-op (idempotent)", async () => {
  process.env.META_CAPI_DATASET_ID = "DS1";
  process.env.META_CAPI_ACCESS_TOKEN = "tok";
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("{}", { status: 200 }); }) as typeof fetch;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await seedWaba(t, accountId);
  const id = await seedEvent(t, accountId, conversationId, contactId, { backend: "capi", lane: "ctwa", status: "sent" });

  await t.action(internal.conversionEvents.deliverConversionEvent, { conversionEventId: id });
  expect(calls).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- conversionEvents`
Expected: FAIL — `internal.conversionEvents` undefined.

- [ ] **Step 3: Create the module** — create `convex/conversionEvents.ts`:

```ts
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
export const MAX_DELIVER_ATTEMPTS = 5;

export const getById = internalQuery({
  args: { conversionEventId: v.id("conversionEvents") },
  handler: async (ctx, args): Promise<Doc<"conversionEvents"> | null> =>
    await ctx.db.get(args.conversionEventId),
});

export const getWabaId = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<string | null> => {
    const cfg = await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    return cfg?.wabaId ?? null;
  },
});

/**
 * Advances a conversionEvents row after a delivery attempt. Conditional
 * spread (a field is only patched when supplied). `attempts` bumps only on
 * an explicit `bumpAttempts === true`. An `"error"` bump that reaches
 * `MAX_DELIVER_ATTEMPTS` is retired to the terminal `"abandoned"` state — the
 * single give-up point — so dead rows leave the retry cron's partitions
 * (mirrors `attribution.patchResult`).
 */
export const patchStatus = internalMutation({
  args: {
    conversionEventId: v.id("conversionEvents"),
    status: v.union(
      v.literal("sent"),
      v.literal("unmatched"),
      v.literal("error"),
    ),
    fbTraceId: v.optional(v.string()),
    matchResult: v.optional(v.string()),
    lastError: v.optional(v.string()),
    bumpAttempts: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.conversionEventId);
    if (!row) return;
    const bumping = args.bumpAttempts === true;
    const nextAttempts = row.attempts + 1;
    const status =
      bumping && args.status === "error" && nextAttempts >= MAX_DELIVER_ATTEMPTS
        ? ("abandoned" as const)
        : args.status;
    const patch: Record<string, unknown> = { status };
    if (args.fbTraceId !== undefined) patch.fbTraceId = args.fbTraceId;
    if (args.matchResult !== undefined) patch.matchResult = args.matchResult;
    if (args.lastError !== undefined) patch.lastError = args.lastError;
    if (args.status === "sent") patch.sentAt = Date.now();
    if (bumping) patch.attempts = nextAttempts;
    await ctx.db.patch(args.conversionEventId, patch);
  },
});

/**
 * Delivers one conversion event to its backend. Never throws. Idempotent:
 * an already-`sent` row is skipped. Dormant (relevant env unset, or capi with
 * no wabaId) → leave the row `pending`, no bump, so the retry cron resends
 * once configured. We dedupe ourselves (one row per conversation×stage) —
 * Meta does not dedupe business-messaging events.
 */
export const deliverConversionEvent = internalAction({
  args: { conversionEventId: v.id("conversionEvents") },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.runQuery(internal.conversionEvents.getById, {
      conversionEventId: args.conversionEventId,
    });
    if (!row) return;
    if (row.status === "sent") return;

    if (row.backend === "capi") {
      const datasetId = process.env.META_CAPI_DATASET_ID;
      const token = process.env.META_CAPI_ACCESS_TOKEN;
      if (!datasetId || !token) return; // dormant
      const wabaId = await ctx.runQuery(internal.conversionEvents.getWabaId, {
        accountId: row.accountId,
      });
      if (!wabaId) return; // dormant — no WABA configured
      try {
        const event: Record<string, unknown> = {
          event_name: row.eventName,
          event_time: Math.floor(row._creationTime / 1000),
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          event_id: row.eventId,
          user_data: {
            whatsapp_business_account_id: wabaId,
            ctwa_clid: row.identifier,
          },
        };
        if (row.value !== undefined) {
          event.custom_data = { value: row.value, currency: row.currency };
        }
        const body: Record<string, unknown> = { data: [event] };
        const partnerAgent = process.env.META_CAPI_PARTNER_AGENT;
        if (partnerAgent) body.partner_agent = partnerAgent;
        const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
          datasetId,
        )}/events?access_token=${encodeURIComponent(token)}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`CAPI ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = (await res.json().catch(() => ({}))) as {
          fbtrace_id?: string;
        };
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          status: "sent",
          fbTraceId: data.fbtrace_id,
        });
      } catch (err) {
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          status: "error",
          lastError: err instanceof Error ? err.message : String(err),
          bumpAttempts: true,
        });
      }
      return;
    }

    // backend === "platformA" — website/code lane → Platform A web Pixel.
    const url = process.env.LANDING_CONVERSION_URL;
    const secret = process.env.WA_CONVERSION_SHARED_SECRET;
    if (!url || !secret) return; // dormant
    try {
      const body: Record<string, unknown> = {
        code: row.identifier,
        phone: row.phone,
        waMessageId: row.waMessageId,
        firstMessageAt: row.firstMessageAt,
        stage: row.stage,
        event: row.eventName,
      };
      if (row.value !== undefined) body.value = row.value;
      if (row.currency !== undefined) body.currency = row.currency;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Platform A responded ${res.status}`);
      const data = (await res.json().catch(() => ({}))) as {
        matched?: boolean;
        firedAt?: number;
        offerSlug?: string;
        reason?: string;
      };
      if (data.matched) {
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          status: "sent",
          matchResult: data.offerSlug,
        });
      } else {
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          status: "unmatched",
        });
      }
    } catch (err) {
      await ctx.runMutation(internal.conversionEvents.patchStatus, {
        conversionEventId: args.conversionEventId,
        status: "error",
        lastError: err instanceof Error ? err.message : String(err),
        bumpAttempts: true,
      });
    }
  },
});

/**
 * Retry candidates: `error` OR `pending` with `attempts < MAX`, capped at
 * 100 total. `pending` covers dormant rows (env not yet set) so they send
 * once configured. Queried through `by_status` (never a full scan), each
 * `.take(100)`, combined and re-capped. Mirrors `attribution.getPendingToRetry`.
 */
export const getPendingToRetry = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"conversionEvents">[]> => {
    const errored = await ctx.db
      .query("conversionEvents")
      .withIndex("by_status", (q) => q.eq("status", "error"))
      .filter((q) => q.lt(q.field("attempts"), MAX_DELIVER_ATTEMPTS))
      .take(100);
    const pending = await ctx.db
      .query("conversionEvents")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .filter((q) => q.lt(q.field("attempts"), MAX_DELIVER_ATTEMPTS))
      .take(100);
    return [...errored, ...pending].slice(0, 100);
  },
});

export const retryConversionEvents = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const rows = await ctx.runQuery(
      internal.conversionEvents.getPendingToRetry,
      {},
    );
    for (const row of rows) {
      await ctx.scheduler.runAfter(
        0,
        internal.conversionEvents.deliverConversionEvent,
        { conversionEventId: row._id },
      );
    }
  },
});
```

- [ ] **Step 4: Register the module** — in `convex/_generated/api.d.ts`, add (place in correct alphabetical slot — grep the import list):

```ts
import type * as conversionEvents from "../conversionEvents.js";
```
and the member:
```ts
  conversionEvents: typeof conversionEvents;
```

- [ ] **Step 5: Swap the crons** — in `convex/crons.ts`: (a) DELETE the entire `crons.interval("retry-attribution-signals", ...)` block (the old attribution write-path is no longer used — see Global Constraints deprecation note); (b) add:

```ts
// Retry unified conversion events (conversionEvents pending/error with
// attempts < MAX) across both backends. Also resends dormant `pending` rows
// once the relevant env is configured. Bounded, best-effort.
crons.interval(
  "retry-conversion-events",
  { minutes: 15 },
  internal.conversionEvents.retryConversionEvents,
  {},
);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -- conversionEvents`
Expected: PASS (7 tests).

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck` → PASS.
```bash
git add convex/conversionEvents.ts convex/conversionEvents.test.ts convex/_generated/api.d.ts convex/crons.ts
git commit -m "feat(funnel): unified conversionEvents dispatcher (Platform A | CAPI) + retry cron (Phase 1)"
```

---

### Task 4: Classifier + new-lead seeding — `seedNewLead`

**Files:**
- Modify: `convex/conversionEvents.ts` — add the `seedNewLead` internalMutation.
- Modify: `convex/conversionEvents.test.ts` — add seedNewLead tests.

**Interfaces:**
- Consumes: `resolveEventName`/`backendForLane` (`convex/lib/funnel.ts`, Task 1); the `conversionEvents` + `conversations` tables.
- Produces: `internal.conversionEvents.seedNewLead(args)` where
  `args = { accountId, contactId, conversationId, waMessageId, phone, firstMessageAt, code?, ctwaClid? }`.
  It (1) picks lane (`code` wins if both), returning `null` if neither identifier; (2) sets `conversation.attribution` if unset (retaining both identifiers); (3) dedups on `eventId = ${conversationId}:new_lead` via `by_event_id`; (4) inserts the `new_lead` conversionEvents row (`pending`) for the lane's backend + resolved eventName; returns `{ conversionEventId }` on a fresh insert, else `null`.

- [ ] **Step 1: Write the failing test** — append to `convex/conversionEvents.test.ts`:

```ts
import { resolveEventName } from "./lib/funnel";

test("seedNewLead (code): sets attribution + a platformA new_lead row, once", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  const first = await t.mutation(internal.conversionEvents.seedNewLead, {
    accountId, contactId, conversationId, waMessageId: "wamid.1",
    phone: "+15551230000", firstMessageAt: 1_000_000, code: "ABCDEF",
  });
  expect(first).not.toBeNull();

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.attribution?.lane).toBe("code");
  expect(conv?.attribution?.code).toBe("ABCDEF");

  const rows = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].backend).toBe("platformA");
  expect(rows[0].lane).toBe("code");
  expect(rows[0].eventName).toBe("Lead");
  expect(rows[0].identifier).toBe("ABCDEF");
  expect(rows[0].eventId).toBe(`${conversationId}:new_lead`);

  // Idempotent: a second call for the same conversation seeds nothing new.
  const second = await t.mutation(internal.conversionEvents.seedNewLead, {
    accountId, contactId, conversationId, waMessageId: "wamid.2",
    phone: "+15551230000", firstMessageAt: 1_000_050, code: "ABCDEF",
  });
  expect(second).toBeNull();
  const after = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
  expect(after).toHaveLength(1);
});

test("seedNewLead (ctwa): a capi new_lead row with LeadSubmitted", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.conversionEvents.seedNewLead, {
    accountId, contactId, conversationId, waMessageId: "wamid.1",
    phone: "+15551230000", firstMessageAt: 1_000_000, ctwaClid: "clid-9",
  });

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.attribution?.lane).toBe("ctwa");
  expect(conv?.attribution?.ctwaClid).toBe("clid-9");
  const rows = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
  expect(rows[0].backend).toBe("capi");
  expect(rows[0].eventName).toBe("LeadSubmitted");
  expect(rows[0].identifier).toBe("clid-9");
});

test("seedNewLead: code wins when both identifiers present; both retained", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.conversionEvents.seedNewLead, {
    accountId, contactId, conversationId, waMessageId: "wamid.1",
    phone: "+15551230000", firstMessageAt: 1_000_000, code: "ABCDEF", ctwaClid: "clid-9",
  });

  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.attribution?.lane).toBe("code");
  expect(conv?.attribution?.code).toBe("ABCDEF");
  expect(conv?.attribution?.ctwaClid).toBe("clid-9");
  const rows = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
  expect(rows[0].backend).toBe("platformA");
});

test("seedNewLead: returns null and writes nothing for an organic message", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  const res = await t.mutation(internal.conversionEvents.seedNewLead, {
    accountId, contactId, conversationId, waMessageId: "wamid.1",
    phone: "+15551230000", firstMessageAt: 1_000_000,
  });
  expect(res).toBeNull();
  const conv = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conv?.attribution).toBeUndefined();
  const rows = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect());
  expect(rows).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- conversionEvents`
Expected: FAIL — `internal.conversionEvents.seedNewLead` undefined.

- [ ] **Step 3: Add the mutation** — in `convex/conversionEvents.ts`, add the import at the top (with the others):

```ts
import { resolveEventName, backendForLane } from "./lib/funnel";
```

and add the mutation (after `getWabaId`, before `patchStatus`):

```ts
/**
 * Classifies a conversation's lead source from the identifiers seen on an
 * inbound message and seeds the ONE `new_lead` conversion event for its
 * lane. `code` (website HY-code) wins over `ctwa` (ad click) if both are
 * present; both identifiers are retained on `conversation.attribution`
 * (set once, never overwritten). Fire-once per conversation via the
 * deterministic `eventId = ${conversationId}:new_lead` + the `by_event_id`
 * guard. Returns `{ conversionEventId }` on a fresh insert (so the caller
 * schedules delivery), or `null` for an organic message (no identifier) or a
 * conversation whose `new_lead` was already seeded. Replaces the old
 * `attribution.recordSignal` first-touch write.
 */
export const seedNewLead = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    waMessageId: v.string(),
    phone: v.string(),
    firstMessageAt: v.number(),
    code: v.optional(v.string()),
    ctwaClid: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ conversionEventId: Id<"conversionEvents"> } | null> => {
    const { accountId, contactId, conversationId, waMessageId, phone, firstMessageAt, code, ctwaClid } =
      args;
    if (!code && !ctwaClid) return null; // organic — nothing to attribute

    const lane: "code" | "ctwa" = code ? "code" : "ctwa";
    const identifier = code ?? ctwaClid!;

    // Classify once — set conversation.attribution if unset (retain both ids).
    const conversation = await ctx.db.get(conversationId);
    if (conversation && !conversation.attribution) {
      await ctx.db.patch(conversationId, {
        attribution: { lane, code, ctwaClid, firstSeenAt: firstMessageAt },
      });
    }

    // Fire-once per conversation.
    const eventId = `${conversationId}:new_lead`;
    const existing = await ctx.db
      .query("conversionEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
      .first();
    if (existing) return null;

    const eventName = resolveEventName(lane, "new_lead")!; // new_lead is never internal-only
    const conversionEventId = await ctx.db.insert("conversionEvents", {
      accountId,
      conversationId,
      contactId,
      stage: "new_lead",
      lane,
      backend: backendForLane(lane),
      eventName,
      identifier,
      phone,
      waMessageId,
      firstMessageAt,
      eventId,
      status: "pending",
      attempts: 0,
    });
    return { conversionEventId };
  },
});
```

Note: `Id` is already imported in this module via `import type { Doc } from "./_generated/dataModel";` — change that line to `import type { Doc, Id } from "./_generated/dataModel";`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- conversionEvents`
Expected: PASS (7 + 4 = 11 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` → PASS.
```bash
git add convex/conversionEvents.ts convex/conversionEvents.test.ts
git commit -m "feat(funnel): seedNewLead classifier + first-touch seeding (Phase 1)"
```

---

### Task 5: Ingest routing swap (the double-fire fix)

**Files:**
- Modify: `convex/ingest.ts` — replace the `runBestEffort("attribution.signal", ...)` step in `processInbound` with a classify + seed-new-lead + dispatch step.
- Modify: `convex/ingest.test.ts` — replace/extend the attribution-signal assertions.

**Interfaces:**
- Consumes: `internal.conversionEvents.seedNewLead` + `internal.conversionEvents.deliverConversionEvent` (Tasks 3-4); the existing `extractRefCode` / `extractCtwaClid` imports (unchanged) and `res.contactId`/`res.conversationId`.

- [ ] **Step 1: Write the failing tests** — in `convex/ingest.test.ts`, replace the two existing tests `"processInbound records a code-lane attribution signal..."` and `"processInbound records a ctwa-lane attribution signal..."` (they assert the OLD `attributionSignals` behavior which this task removes) with:

```ts
test("processInbound seeds a code-lane new_lead conversionEvent from an HY- code, and NO attributionSignals row", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  await t.action(internal.ingest.processInbound, {
    accountId, from: "15551234567",
    message: { type: "text", text: "hi," + hidden("ABCDEF") + " please", wamid: "wamid.CODE1" },
  });

  const conv = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first());
  const events = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conv!._id)).collect());
  expect(events).toHaveLength(1);
  expect(events[0].lane).toBe("code");
  expect(events[0].backend).toBe("platformA");
  expect(events[0].eventName).toBe("Lead");
  expect(events[0].stage).toBe("new_lead");

  const signals = await t.run((ctx) =>
    ctx.db.query("attributionSignals").withIndex("by_account_result", (q) => q.eq("accountId", accountId)).collect());
  expect(signals).toHaveLength(0); // old path no longer writes
});

test("processInbound seeds a ctwa-lane new_lead conversionEvent (backend capi) from a ctwaClid", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedWebhookEndpoint(t, { accountId, events: ["message.received"] });

  await t.action(internal.ingest.processInbound, {
    accountId, from: "15551234567",
    message: { type: "text", text: "hello", wamid: "wamid.CTWA1", ctwaClid: "clid-xyz789" },
  });

  const conv = await t.run((ctx) =>
    ctx.db.query("conversations").withIndex("by_account", (q) => q.eq("accountId", accountId)).first());
  const events = await t.run((ctx) =>
    ctx.db.query("conversionEvents").withIndex("by_conversation", (q) => q.eq("conversationId", conv!._id)).collect());
  expect(events).toHaveLength(1);
  expect(events[0].lane).toBe("ctwa");
  expect(events[0].backend).toBe("capi");
  expect(events[0].eventName).toBe("LeadSubmitted");
  expect(events[0].identifier).toBe("clid-xyz789");
});
```

(Keep the existing `"an HY- code in the text wins over a ctwaClid..."` test if present, but update its assertions to read `conversionEvents` — the first event's `lane` should be `"code"`. If adapting it is unclear, replace its body with a `conversationEvents`-based `lane === "code"` assertion mirroring the code-lane test above.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- ingest`
Expected: FAIL — no `conversionEvents` row (the step still writes `attributionSignals`).

- [ ] **Step 3: Replace the ingest step** — in `convex/ingest.ts` `processInbound`, replace the entire `await runBestEffort("attribution.signal", async () => { ... });` block with:

```ts
    // ---- Conversion funnel: first-touch (new_lead) — OUTSIDE every guard
    // above, best-effort. Classify the lead source from the inbound
    // identifiers (our HY- zero-width code → website/code lane, else Meta's
    // ctwa_clid → ad/ctwa lane), set `conversation.attribution` once, seed the
    // ONE new_lead conversion event for that lane, and dispatch it. Replaces
    // the old attribution.recordSignal/sendSignal step: `code` → Platform A
    // only, `ctwa` → direct CAPI only (no more double-fire). Never blocks.
    await runBestEffort("conversionEvents.newLead", async () => {
      const code = extractRefCode(message.text);
      const ctwaClid = extractCtwaClid(message);
      if (!code && !ctwaClid) return;
      const seeded = await ctx.runMutation(
        internal.conversionEvents.seedNewLead,
        {
          accountId,
          contactId: res.contactId,
          conversationId: res.conversationId,
          waMessageId: message.wamid,
          phone: normalizePhone(from),
          firstMessageAt: Date.now(),
          code: code ?? undefined,
          ctwaClid: ctwaClid ?? undefined,
        },
      );
      if (seeded) {
        await ctx.scheduler.runAfter(
          0,
          internal.conversionEvents.deliverConversionEvent,
          { conversionEventId: seeded.conversionEventId },
        );
      }
    });
```

(The `extractRefCode` / `extractCtwaClid` imports at the top of `ingest.ts` stay — they are still used here. Do NOT remove them.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- ingest`
Expected: PASS — the two new tests plus all other ingest tests.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck` → PASS.
```bash
git add convex/ingest.ts convex/ingest.test.ts
git commit -m "feat(funnel): route ingest first-touch through conversionEvents; fix ctwa double-fire (Phase 1)"
```

---

### Task 6: Phase verification

**Files:** none (verification only).

- [ ] **Step 1: Full suite** — `npm test` → PASS (all files; the two removed attribution tests are replaced by the two new conversionEvents ingest tests, so net count rises by funnel(5) + conversionEvents(11) + no net ingest change beyond the added assertions; confirm zero failures).
- [ ] **Step 2: Typecheck** — `npm run typecheck` → PASS.
- [ ] **Step 3: Build** — `npm run build` → PASS.
- [ ] **Step 4: Confirm** by inspection: no `convex dev/deploy/codegen` run; `deliverConversionEvent` is dormant (no env → pending) for both backends; ingest no longer calls `attribution.recordSignal`/`sendSignal`; `retry-attribution-signals` cron removed, `retry-conversion-events` added; `attributionSignals` table + `listConversions` untouched (deprecated, still compiles).

---

## Self-Review

**Spec coverage (Phase 1 from design §12):**
- `conversation.attribution` classifier → Task 2 (field) + Task 4 (`seedNewLead` sets it) + Task 5 (ingest calls it). ✓
- `conversionEvents` table + `deliverConversionEvent` dispatcher (Platform A | CAPI) → Task 2 + Task 3. ✓
- Stage config → Task 1 (`convex/lib/funnel.ts`). ✓
- Retry cron → Task 3. ✓
- Fold first-touch attribution into `new_lead` (preserve A's contract) → Task 4 (`seedNewLead`) + Task 5 (ingest swap); platformA branch keeps `code/phone/waMessageId/firstMessageAt` + adds `stage/event`. ✓
- Double-fire fix (ctwa → CAPI only) → Task 5: ctwa lane routes to `backend:"capi"`, never Platform A; the old both-lanes-to-A step is removed. ✓

**Placeholder scan:** every code step has complete code; every test step names the `npm test -- <pattern>` command + expected pass/fail. No TBD/TODO.

**Type consistency:** `seedNewLead` returns `{ conversionEventId } | null` — matched in Task 5 (`if (seeded) … seeded.conversionEventId`) and Task 4 tests (`expect(first).not.toBeNull()`). `deliverConversionEvent({ conversionEventId })`, `patchStatus`, `getPendingToRetry`, `retryConversionEvents` names match the cron (`internal.conversionEvents.retryConversionEvents`) and the ingest dispatch. `resolveEventName(lane, key)` / `backendForLane(lane)` (Task 1) used by `seedNewLead` (Task 4). `conversionEvents` fields written by `seedNewLead` + the tests match the Task 2 schema exactly (every required field supplied; `value`/`currency` optional).

**Deprecation note for reviewers:** Tasks 3/5 leave `attribution.ts` (`recordSignal`/`sendSignal`/`patchResult`/`getPendingToRetry`/`retryPending`/`listConversions`) and the `attributionSignals` table defined but no longer called by the pipeline; only the ingest call site and the `retry-attribution-signals` cron are changed. This is intentional (removed in a later cleanup) to keep the Conversions UI compiling and minimize blast radius. `extractRefCode`/`extractCtwaClid` remain in use.
