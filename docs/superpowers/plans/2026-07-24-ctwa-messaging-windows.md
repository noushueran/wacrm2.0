# CTWA Messaging Windows (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Meta's authoritative messaging-window and billing data from WhatsApp status webhooks, and expose one pure resolver that answers "what can I send right now, and will it be free?"

**Architecture:** Meta reports the real window expiry and billing category on every outbound message's status webhook (`statuses[].conversation.expiration_timestamp` + `statuses[].pricing`), which `convex/http.ts` currently discards. We capture that as source of truth, add two conversation timestamps (`lastInboundAt`, `firstReplyAt`) that let us *estimate* the window in the gap before Meta confirms, and combine both in a pure `resolveWindowState()` function. Phase 1 ships **no user-visible change**.

**Tech Stack:** TypeScript, Convex (`convex/`), Next.js 16 (`src/`), Vitest 4 + `convex-test`.

## Global Constraints

- **Additive schema only.** Every new schema field is `v.optional(...)`. No migration, no backfill.
- **Raw + normalized, never closed unions** for `pricing.category`, `pricing.type`, `conversation.origin.type`. Meta is mid-migration between conversation-based pricing (`CBP`) and per-message pricing (`PMP`); an unrecognized value must degrade to "unknown", never throw and never drop a webhook.
- **`metaWindow.expiresAt` only ever advances.** Status webhooks are unordered; a late `delivered` must not shrink a live window. Regression is allowed only when a different `conversation.id` arrives.
- **Zero user-visible behaviour change in Phase 1.** No UI, no send gating, no bot changes.
- **Constants:** CSW = 24h = `86_400_000` ms. FEP = 72h = `259_200_000` ms.
- **Test command:** `npm test` (= `vitest run`). Single file: `npx vitest run <path>`.
- **Tests are co-located** as `*.test.ts` beside the module, importing `{ expect, test } from "vitest"`.

### Repo environment rules (binding on every task)

- **App root** for all npm commands: `/Volumes/CurserDisk/Dev/wa-amani`.
- **Convex is self-hosted PRODUCTION — never run `convex dev`, `convex deploy`, or `convex codegen`.** No codegen is needed for this plan: `convex/_generated/dataModel.d.ts:60` derives table types from `schema.ts` via `DataModelFromSchemaDefinition<typeof schema>`, and `convex/_generated/api.d.ts:241` maps `messages: typeof messages` for the whole module — so new optional fields and new exports in existing modules are picked up by `tsc` with no regeneration. `convex-test` runs fully offline under `npm test`.
- **Stage files EXPLICITLY by exact path. Never `git add -A` or `git add .`** — the working tree carries unrelated untracked files (`amani-ai-agent/*.md`, `.superpowers/`).
- **Lint the CHANGED FILES ONLY:** `npx eslint <path>`. The repo has pre-existing lint debt, so `npm run lint` reports unrelated noise; the gate is "no NEW lint on this diff."
- **Every commit must carry the trailer** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `convex/lib/whatsapp/webhookParse.ts` | Pure webhook parsing. Gains `MetaWebhookStatus` billing fields + `parseStatusPricing()`. | Modify |
| `convex/lib/whatsapp/webhookParse.test.ts` | Tests for the above. | Modify |
| `convex/schema.ts` | 1 field on `messages`, 3 on `conversations`. | Modify |
| `convex/messages.ts` | New `applyStatusPricing` internal mutation; `insertMessageAndUpdateConversation` maintains the two timestamps. | Modify |
| `convex/messages.test.ts` | Tests for both of the above. Already exists (~39KB) — **append only**, reusing its `modules`, imports and `seedAccountMember` / `seedConv` / `appendVia` helpers. | Modify |
| `convex/http.ts` | Status loop calls the parser + mutation. | Modify `:111-130` |
| `convex/lib/whatsapp/messagingWindow.ts` | **New.** The pure `resolveWindowState()` resolver. | Create |
| `convex/lib/whatsapp/messagingWindow.test.ts` | **New.** The four-quadrant matrix + FEP rules. | Create |
| `convex/qualificationEngine.ts` | Its ad-hoc 24h check calls the resolver instead. | Modify `:3042` |

**Deviation from spec, deliberate:** the spec said Phase 1 refactors *both* duplicate window computations. Planning revealed `convex/` and `src/` **mirror** rather than share modules (`convex/lib/whatsapp/metaApi.ts` ↔ `src/lib/whatsapp/meta-api.ts`), so consolidating the frontend copy (`src/lib/inbox/adWindow.ts`, `message-thread.tsx:289`) requires either a duplicated mirror or a new Convex query — both are Phase 2 UI concerns. Task 7 refactors the **backend** consumer only; `adWindow.ts` is left untouched and still works.

---

### Task 1: Parse Meta's billing data off status webhooks

**Files:**
- Modify: `convex/lib/whatsapp/webhookParse.ts:107-112` (extend `MetaWebhookStatus`), then append new exports
- Test: `convex/lib/whatsapp/webhookParse.test.ts`

**Interfaces:**
- Consumes: nothing (pure, first task)
- Produces: `parseStatusPricing(status: MetaWebhookStatus): ParsedStatusPricing | null` and the `ParsedStatusPricing` interface, used by Tasks 3 and 4.

- [ ] **Step 1: Write the failing tests**

Append to `convex/lib/whatsapp/webhookParse.test.ts`. Also add `parseStatusPricing` and `type MetaWebhookStatus` to the existing `import { ... } from "./webhookParse";` block at the top of the file.

```ts
// ------------------------------------------------------------
// parseStatusPricing
// ------------------------------------------------------------

test("parseStatusPricing: CBP shape — referral_conversion origin marks a free entry point", () => {
  expect(
    parseStatusPricing({
      id: "wamid.X",
      status: "sent",
      timestamp: "1753300000",
      recipient_id: "971500000000",
      conversation: {
        id: "CONV1",
        expiration_timestamp: "1753560000",
        origin: { type: "referral_conversion" },
      },
      pricing: {
        billable: false,
        pricing_model: "CBP",
        category: "referral_conversion",
      },
    }),
  ).toEqual({
    conversationMetaId: "CONV1",
    expiresAt: 1753560000000,
    originType: "referral_conversion",
    pricingModel: "CBP",
    pricingCategory: "referral_conversion",
    pricingType: undefined,
    billable: false,
    isFreeEntryPoint: true,
  });
});

test("parseStatusPricing: PMP shape — pricing.type free_entry_point marks a free entry point", () => {
  const parsed = parseStatusPricing({
    id: "wamid.Y",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: { id: "CONV2", expiration_timestamp: "1753560000" },
    pricing: {
      billable: false,
      pricing_model: "PMP",
      category: "service",
      type: "free_entry_point",
    },
  });
  expect(parsed?.isFreeEntryPoint).toBe(true);
  expect(parsed?.pricingModel).toBe("PMP");
  expect(parsed?.pricingType).toBe("free_entry_point");
});

test("parseStatusPricing: an ordinary billed message is not a free entry point", () => {
  const parsed = parseStatusPricing({
    id: "wamid.Z",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: {
      id: "CONV3",
      expiration_timestamp: "1753386400",
      origin: { type: "marketing" },
    },
    pricing: {
      billable: true,
      pricing_model: "PMP",
      category: "marketing",
      type: "regular",
    },
  });
  expect(parsed?.isFreeEntryPoint).toBe(false);
  expect(parsed?.billable).toBe(true);
});

test("parseStatusPricing: returns null when neither pricing nor conversation is present", () => {
  expect(
    parseStatusPricing({
      id: "wamid.NONE",
      status: "delivered",
      timestamp: "1753300000",
      recipient_id: "971500000000",
    }),
  ).toBeNull();
});

test("parseStatusPricing: tolerates a missing pricing object", () => {
  const parsed = parseStatusPricing({
    id: "wamid.A",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: { id: "CONV4", origin: { type: "user_initiated" } },
  });
  expect(parsed).not.toBeNull();
  expect(parsed?.expiresAt).toBeUndefined();
  expect(parsed?.billable).toBeUndefined();
  expect(parsed?.isFreeEntryPoint).toBe(false);
});

test("parseStatusPricing: tolerates a missing conversation object", () => {
  const parsed = parseStatusPricing({
    id: "wamid.A2",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    pricing: { billable: true, pricing_model: "PMP", category: "marketing", type: "regular" },
  });
  expect(parsed).not.toBeNull();
  expect(parsed?.conversationMetaId).toBeUndefined();
  expect(parsed?.expiresAt).toBeUndefined();
  expect(parsed?.billable).toBe(true);
  expect(parsed?.isFreeEntryPoint).toBe(false);
});

test("parseStatusPricing: unknown enum values normalize instead of throwing", () => {
  const parsed = parseStatusPricing({
    id: "wamid.B",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: { id: "CONV5", origin: { type: "some_future_origin" } },
    pricing: { pricing_model: "XYZ", category: "brand_new", type: "unheard_of" },
  });
  expect(parsed?.originType).toBe("some_future_origin");
  expect(parsed?.pricingType).toBe("unheard_of");
  expect(parsed?.isFreeEntryPoint).toBe(false);
});

test("parseStatusPricing: a non-numeric expiration_timestamp yields undefined, not NaN", () => {
  const parsed = parseStatusPricing({
    id: "wamid.C",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: { id: "CONV6", expiration_timestamp: "not-a-number" },
  });
  expect(parsed?.expiresAt).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/lib/whatsapp/webhookParse.test.ts`
Expected: FAIL — `parseStatusPricing is not exported` / `is not a function`.

- [ ] **Step 3: Extend `MetaWebhookStatus`**

Replace `convex/lib/whatsapp/webhookParse.ts:107-112` with:

```ts
export interface MetaWebhookStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  /** Present on billing-bearing statuses. Meta's conversation-window
   *  record for this message. */
  conversation?: {
    id?: string;
    /** Unix SECONDS, as a string. Meta's authoritative window expiry. */
    expiration_timestamp?: string;
    origin?: { type?: string };
  };
  /** Present on billing-bearing statuses. `type` exists only in the
   *  per-message ("PMP") era; the conversation-based ("CBP") era carries
   *  the signal in `category` / `conversation.origin.type` instead. */
  pricing?: {
    billable?: boolean;
    pricing_model?: string;
    category?: string;
    type?: string;
  };
}
```

- [ ] **Step 4: Implement `parseStatusPricing`**

Append to the end of `convex/lib/whatsapp/webhookParse.ts`:

```ts
// ------------------------------------------------------------
// Status pricing / conversation-window capture
//
// Meta reports the real window expiry and billing outcome on every
// outbound message's status webhook. Every field here is OPTIONAL and
// every enum-ish value stays a RAW string: Meta is mid-migration between
// conversation-based pricing ("CBP") and per-message pricing ("PMP"),
// and the two eras spell the free-entry-point signal differently. An
// unrecognized value must degrade to "unknown", never throw and never
// drop the webhook.
// ------------------------------------------------------------

export interface ParsedStatusPricing {
  conversationMetaId?: string;
  /** Milliseconds since epoch (Meta sends unix SECONDS as a string). */
  expiresAt?: number;
  originType?: string;
  pricingModel?: string;
  pricingCategory?: string;
  pricingType?: string;
  billable?: boolean;
  /** True when either era's spelling says this is a free entry point. */
  isFreeEntryPoint: boolean;
}

/** CBP-era spelling, on `conversation.origin.type`. */
const FEP_ORIGIN_TYPE = "referral_conversion";
/** PMP-era spelling, on `pricing.type`. */
const FEP_PRICING_TYPE = "free_entry_point";

/**
 * Lift Meta's billing/window facts off one status webhook entry.
 * Returns `null` when the status carries neither object — ordinary for
 * some `delivered`/`read` callbacks, and NOT an error.
 */
export function parseStatusPricing(
  status: MetaWebhookStatus,
): ParsedStatusPricing | null {
  const { conversation, pricing } = status;
  if (!conversation && !pricing) return null;

  const seconds = Number(conversation?.expiration_timestamp);
  const expiresAt =
    Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;

  const originType = conversation?.origin?.type;
  const pricingType = pricing?.type;

  return {
    conversationMetaId: conversation?.id,
    expiresAt,
    originType,
    pricingModel: pricing?.pricing_model,
    pricingCategory: pricing?.category,
    pricingType,
    billable: pricing?.billable,
    isFreeEntryPoint:
      originType === FEP_ORIGIN_TYPE || pricingType === FEP_PRICING_TYPE,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run convex/lib/whatsapp/webhookParse.test.ts`
Expected: PASS — all tests, including the pre-existing ones in that file.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/whatsapp/webhookParse.ts convex/lib/whatsapp/webhookParse.test.ts
git commit -m "$(cat <<'EOF'
feat(whatsapp): parse Meta pricing + conversation window off status webhooks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Schema fields

**Files:**
- Modify: `convex/schema.ts` — `messages` table (near `referral`, ~`:383`) and `conversations` table (near `adReferral`, ~`:216`)

**Interfaces:**
- Consumes: nothing
- Produces: `messages.pricing`, `conversations.metaWindow`, `conversations.lastInboundAt`, `conversations.firstReplyAt` — read/written by Tasks 3, 5, 6, 7.

- [ ] **Step 1: Add the `messages.pricing` field**

In `convex/schema.ts`, inside the `messages` table definition, immediately after the closing `),` of the existing `referral: v.optional(v.object({ ... }))` block, add:

```ts
    // Meta's per-message billing outcome, captured from the status
    // webhook (`statuses[].pricing`). All sub-fields optional and raw:
    // Meta is mid-migration between conversation-based ("CBP") and
    // per-message ("PMP") pricing, which spell categories differently.
    // Phase 4 aggregates this for spend reporting.
    pricing: v.optional(
      v.object({
        billable: v.optional(v.boolean()),
        model: v.optional(v.string()),
        category: v.optional(v.string()),
        type: v.optional(v.string()),
        capturedAt: v.number(),
      }),
    ),
```

- [ ] **Step 2: Add the three `conversations` fields**

In `convex/schema.ts`, inside the `conversations` table definition, immediately after the closing `),` of the existing `attribution: v.optional(v.object({ ... }))` block, add:

```ts
    // Meta's AUTHORITATIVE messaging-window record, captured from
    // outbound status webhooks (`statuses[].conversation`). Preferred
    // over any local estimate. `isFreeEntryPoint` is derived from either
    // era's spelling (CBP `origin.type === "referral_conversion"` or PMP
    // `pricing.type === "free_entry_point"`). `expiresAt` only ever
    // ADVANCES — status webhooks are unordered, so a late `delivered`
    // must not shrink a live window.
    metaWindow: v.optional(
      v.object({
        conversationMetaId: v.optional(v.string()),
        originType: v.optional(v.string()),
        expiresAt: v.optional(v.number()),
        isFreeEntryPoint: v.boolean(),
        updatedAt: v.number(),
      }),
    ),
    // Timestamp of the most recent CUSTOMER message — the anchor for
    // Meta's 24h customer service window, which governs whether
    // free-form (non-template) messages may be sent. Distinct from
    // `lastMessageAt`, which includes outbound messages and therefore
    // cannot express this window.
    lastInboundAt: v.optional(v.number()),
    // Timestamp of the first outbound message sent AFTER
    // `adReferral.startedAt`. Anchors the 72h free-entry-point ESTIMATE
    // used before Meta confirms via `metaWindow`. Written once.
    firstReplyAt: v.optional(v.number()),
```

- [ ] **Step 3: Verify the schema compiles**

Run: `npm run typecheck`
Expected: succeeds with no errors.

**Do NOT run `npx convex codegen`** — see the Repo environment rules above. The generated types derive from `schema.ts` at type-check time, so the new optional fields need no regeneration.

- [ ] **Step 4: Verify the existing suite still passes**

Run: `npm test`
Expected: PASS. All fields are optional, so every existing `ctx.db.insert` remains valid.

- [ ] **Step 5: Commit**

```bash
git add convex/schema.ts
git commit -m "$(cat <<'EOF'
feat(schema): add messaging-window and per-message pricing fields

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Persist captured pricing + window state

**Files:**
- Modify: `convex/messages.ts` — add `applyStatusPricing` after the existing `updateDeliveryStatusByWamid` (ends `:497`)
- Test: `convex/messages.test.ts`

**Interfaces:**
- Consumes: `ParsedStatusPricing` (Task 1); the schema fields (Task 2)
- Produces: `internal.messages.applyStatusPricing({ wamid, accountId?, pricing })` — called by Task 4.

- [ ] **Step 1: Write the failing tests**

`convex/messages.test.ts` **already exists (~39KB)** and already declares `modules`, the vitest/convex imports, and the helpers `seedAccountMember(t, {name, email, role})` and `seedConv(t, accountId, {phone, name})`. **Append the block below to the end of that file** — do not redeclare the imports, `modules`, or any existing helper.

```ts
// ============================================================
// applyStatusPricing — Meta pricing + conversation-window capture
// ============================================================

/** One outbound message carrying a known wamid, so the `by_message_id`
 *  lookup inside `applyStatusPricing` has a row to match. */
async function seedMessageWithWamid(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  conversationId: Id<"conversations">,
  wamid: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "agent",
      contentType: "text",
      contentText: "hello",
      messageId: wamid,
      status: "sent",
    }),
  );
}

test("applyStatusPricing: stores per-message pricing and the conversation window", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  const messageId = await seedMessageWithWamid(
    t,
    accountId,
    conversationId,
    "wamid.P1",
  );

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P1",
    accountId,
    pricing: {
      conversationMetaId: "CONV1",
      expiresAt: 1753560000000,
      originType: "referral_conversion",
      pricingModel: "CBP",
      pricingCategory: "referral_conversion",
      billable: false,
      isFreeEntryPoint: true,
    },
  });

  const { message, conversation } = await t.run(async (ctx) => ({
    message: await ctx.db.get(messageId),
    conversation: await ctx.db.get(conversationId),
  }));

  expect(message?.pricing?.billable).toBe(false);
  expect(message?.pricing?.model).toBe("CBP");
  expect(message?.pricing?.category).toBe("referral_conversion");
  expect(conversation?.metaWindow?.isFreeEntryPoint).toBe(true);
  expect(conversation?.metaWindow?.expiresAt).toBe(1753560000000);
  expect(conversation?.metaWindow?.conversationMetaId).toBe("CONV1");
});

test("applyStatusPricing: a later expiry advances the window", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P2");

  const base = {
    conversationMetaId: "CONV1",
    originType: "referral_conversion",
    isFreeEntryPoint: true,
  };
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P2",
    accountId,
    pricing: { ...base, expiresAt: 1000 },
  });
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P2",
    accountId,
    pricing: { ...base, expiresAt: 5000 },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.expiresAt).toBe(5000);
});

test("applyStatusPricing: an out-of-order older expiry does NOT shrink the window", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P3");

  const base = {
    conversationMetaId: "CONV1",
    originType: "referral_conversion",
    isFreeEntryPoint: true,
  };
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P3",
    accountId,
    pricing: { ...base, expiresAt: 5000 },
  });
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P3",
    accountId,
    pricing: { ...base, expiresAt: 1000 },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.expiresAt).toBe(5000);
});

test("applyStatusPricing: a different conversation id replaces the window even if earlier", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  await seedMessageWithWamid(t, accountId, conversationId, "wamid.P4");

  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P4",
    accountId,
    pricing: {
      conversationMetaId: "CONV_OLD",
      expiresAt: 5000,
      isFreeEntryPoint: true,
    },
  });
  await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.P4",
    accountId,
    pricing: {
      conversationMetaId: "CONV_NEW",
      expiresAt: 1000,
      isFreeEntryPoint: false,
    },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.metaWindow?.conversationMetaId).toBe("CONV_NEW");
  expect(conversation?.metaWindow?.expiresAt).toBe(1000);
});

test("applyStatusPricing: an unknown wamid is a silent no-op", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const res = await t.mutation(internal.messages.applyStatusPricing, {
    wamid: "wamid.DOES_NOT_EXIST",
    accountId,
    pricing: { isFreeEntryPoint: false },
  });
  expect(res.matched).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/messages.test.ts`
Expected: FAIL — `internal.messages.applyStatusPricing` is undefined.

- [ ] **Step 3: Implement the mutation**

Insert into `convex/messages.ts` immediately after the closing `});` of `updateDeliveryStatusByWamid` (`:497`):

```ts
/**
 * Capture Meta's billing + conversation-window facts for one outbound
 * message. Companion to `updateDeliveryStatusByWamid`, which handles the
 * same webhook's delivery state.
 *
 * Writes twice: the per-message billing outcome onto `messages.pricing`
 * (Phase 4 aggregates it), and the conversation-level window onto
 * `conversations.metaWindow`. Matches 0..N message rows via
 * `by_message_id` for the same reason `updateDeliveryStatusByWamid`
 * does — a wamid is not unique across accounts.
 *
 * `expiresAt` ONLY ADVANCES. Meta's status webhooks are unordered, so a
 * late `delivered` for an older message must never shrink a live window.
 * The single exception is a genuinely different `conversation.id`, which
 * means Meta opened a new conversation and its window supersedes.
 */
export const applyStatusPricing = internalMutation({
  args: {
    wamid: v.string(),
    accountId: v.optional(v.id("accounts")),
    pricing: v.object({
      conversationMetaId: v.optional(v.string()),
      expiresAt: v.optional(v.number()),
      originType: v.optional(v.string()),
      pricingModel: v.optional(v.string()),
      pricingCategory: v.optional(v.string()),
      pricingType: v.optional(v.string()),
      billable: v.optional(v.boolean()),
      isFreeEntryPoint: v.boolean(),
    }),
  },
  handler: async (ctx, args) => {
    const matches = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.wamid))
      .collect();

    const now = Date.now();
    const owned = matches.filter(
      (m) => !args.accountId || m.accountId === args.accountId,
    );

    // A conversation-only callback (no `pricing` object) says nothing about
    // this message's billing — writing it would blank facts a previous
    // callback already captured, since `patch` replaces nested objects
    // wholesale rather than deep-merging.
    const hasPricingFacts =
      args.pricing.billable !== undefined ||
      args.pricing.pricingModel !== undefined ||
      args.pricing.pricingCategory !== undefined ||
      args.pricing.pricingType !== undefined;

    for (const message of owned) {
      if (!hasPricingFacts) continue;
      await ctx.db.patch(message._id, {
        pricing: {
          billable: args.pricing.billable ?? message.pricing?.billable,
          model: args.pricing.pricingModel ?? message.pricing?.model,
          category: args.pricing.pricingCategory ?? message.pricing?.category,
          type: args.pricing.pricingType ?? message.pricing?.type,
          capturedAt: now,
        },
      });
    }

    // The window is a property of the conversation, not the message, so
    // it is written once off the first owned match.
    const first = owned[0];
    if (first) {
      const conversation = await ctx.db.get(first.conversationId);
      if (conversation) {
        const prev = conversation.metaWindow;
        const differentConversation =
          !!args.pricing.conversationMetaId &&
          !!prev?.conversationMetaId &&
          prev.conversationMetaId !== args.pricing.conversationMetaId;
        const advances =
          (args.pricing.expiresAt ?? 0) > (prev?.expiresAt ?? 0);

        if (!prev || differentConversation || advances) {
          // `ctx.db.patch` REPLACES a nested object wholesale rather than
          // deep-merging it, so opening this gate rewrites EVERY field of
          // `metaWindow`, not just `expiresAt`. Meta reports the window's
          // identity fields (`origin`, `id`) on the callback that OPENS a
          // conversation and may omit them on later ones, and
          // `parseStatusPricing` accepts `pricing`-only and
          // `conversation`-only payloads independently. Without carrying the
          // previous values forward, a later callback that merely advances
          // `expiresAt` would blank `originType` and flip `isFreeEntryPoint`
          // back to false — silently re-pricing a free conversation as
          // billable.
          //
          // Free-entry-point-ness belongs to the CONVERSATION, not to one
          // status callback: Meta does not reclassify an open conversation.
          // So within the same conversation the flag latches on and absent
          // fields inherit. A different `conversation.id` IS a different
          // conversation, so it replaces everything.
          const carryForward = !!prev && !differentConversation;
          await ctx.db.patch(first.conversationId, {
            metaWindow: {
              conversationMetaId:
                args.pricing.conversationMetaId ??
                (carryForward ? prev.conversationMetaId : undefined),
              originType:
                args.pricing.originType ??
                (carryForward ? prev.originType : undefined),
              expiresAt:
                args.pricing.expiresAt ??
                (carryForward ? prev.expiresAt : undefined),
              isFreeEntryPoint: carryForward
                ? prev.isFreeEntryPoint || args.pricing.isFreeEntryPoint
                : args.pricing.isFreeEntryPoint,
              updatedAt: now,
            },
          });
        }
      }
    }

    return { matched: matches.length, updated: owned.length };
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/messages.test.ts`
Expected: PASS — all five `applyStatusPricing` tests.

- [ ] **Step 5: Commit**

```bash
git add convex/messages.ts convex/messages.test.ts
git commit -m "$(cat <<'EOF'
feat(messages): persist Meta pricing and conversation window

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire capture into the webhook status loop

**Files:**
- Modify: `convex/http.ts:111-130` (the `value.statuses` loop) and its import block

**Interfaces:**
- Consumes: `parseStatusPricing` (Task 1), `internal.messages.applyStatusPricing` (Task 3)
- Produces: end-to-end capture. Nothing downstream imports from here.

- [ ] **Step 1: Add the imports**

In `convex/http.ts`, add `parseStatusPricing` to the existing import from `./lib/whatsapp/webhookParse` (the one already bringing in `isRecipientStatus`, `flattenInboundMessage`, `resolveContactName`, `parseTemplateStatusUpdate`).

Also add `import { runBestEffort } from "./ingest";` — the codebase's existing best-effort helper (`convex/ingest.ts:545-557`), used in Step 2 so a pricing-capture failure cannot cascade. `http.ts → ingest.ts` is a one-way edge (nothing under `convex/` imports `./http`), so there is no circular-import risk.

- [ ] **Step 2: Extend the status loop**

Replace `convex/http.ts:111-130` with:

```ts
  if (value.statuses) {
    for (const status of value.statuses) {
      // Billing/window capture runs FIRST and independently of the
      // recipient-status guard below: Meta attaches `pricing` /
      // `conversation` to statuses whose `status` string we may not
      // recognize, and that data is authoritative for the messaging
      // window. Dropping it because of an unknown status value would
      // lose the only signal Meta gives us about what a send costs.
      //
      // Best-effort: pricing capture must never take down the
      // delivery-status and inbound-message handling that follow it.
      // `processChange` is only wrapped per-CHANGE, so an unguarded throw
      // here would skip the rest of this change's statuses AND its
      // `value.messages` branch — and `ingestWebhook` answers 200
      // regardless, so Meta would never retry. `runBestEffort` is this
      // codebase's existing idiom for exactly that (`convex/ingest.ts`).
      const pricing = parseStatusPricing(status);
      if (pricing) {
        await runBestEffort("messages.applyStatusPricing", () =>
          ctx.runMutation(internal.messages.applyStatusPricing, {
            wamid: status.id,
            accountId: accountId ?? undefined,
            pricing,
          }),
        );
      }

      if (!isRecipientStatus(status.status)) {
        console.warn(
          "[webhook httpAction] unrecognized recipient status, skipping:",
          status.status,
        );
        continue;
      }
      await ctx.runMutation(internal.messages.updateDeliveryStatusByWamid, {
        wamid: status.id,
        status: status.status,
        accountId: accountId ?? undefined,
      });
      await ctx.runMutation(internal.broadcasts.recordRecipientStatusByWamid, {
        wamid: status.id,
        status: status.status,
      });
    }
  }
```

- [ ] **Step 3: Verify types and the full suite**

Run: `npm run typecheck && npm test`
Expected: both PASS. No existing test asserts on the status loop's call count, so behaviour for statuses without `pricing` is unchanged.

- [ ] **Step 4: Commit**

```bash
git add convex/http.ts
git commit -m "$(cat <<'EOF'
feat(webhook): capture Meta pricing and window from status callbacks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Maintain `lastInboundAt` and `firstReplyAt`

**Files:**
- Modify: `convex/messages.ts:227-240` (the patch block inside `insertMessageAndUpdateConversation`)
- Test: `convex/messages.test.ts`

**Interfaces:**
- Consumes: the schema fields (Task 2)
- Produces: populated `conversations.lastInboundAt` / `firstReplyAt`, read by Tasks 6 and 7.

This is the correct choke point: `convex/messages.ts:216-218` documents it as *"the single `insert("messages")` in the backend — every path funnels through it."*

- [ ] **Step 1: Write the failing tests**

Append to the end of `convex/messages.test.ts`. This reuses that file's existing `appendVia(t, accountId, conversationId, senderType)` helper, which calls `insertMessageAndUpdateConversation` directly — the function under test.

```ts
// ============================================================
// lastInboundAt / firstReplyAt maintenance
// ============================================================

/** A fresh account + conversation, seeded the way the rest of this
 *  suite does it. */
async function seedWindowConv(t: ReturnType<typeof convexTest>) {
  const { accountId } = await seedAccountMember(t, {
    name: "A",
    email: "a@x.com",
    role: "admin",
  });
  const { conversationId } = await seedConv(t, accountId, {
    phone: "+15551230000",
    name: "Lead",
  });
  return { accountId, conversationId };
}

test("insertMessageAndUpdateConversation: an inbound customer message sets lastInboundAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedWindowConv(t);

  const before = Date.now();
  await appendVia(t, accountId, conversationId, "customer");

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.lastInboundAt).toBeGreaterThanOrEqual(before);
});

test("insertMessageAndUpdateConversation: an outbound message does NOT set lastInboundAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedWindowConv(t);

  await appendVia(t, accountId, conversationId, "agent");

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.lastInboundAt).toBeUndefined();
});

test("insertMessageAndUpdateConversation: first outbound on an ad conversation sets firstReplyAt once", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedWindowConv(t);
  await t.run((ctx) =>
    ctx.db.patch(conversationId, { adReferral: { startedAt: 1_000 } }),
  );

  await appendVia(t, accountId, conversationId, "agent");
  const afterFirst = await t.run((ctx) => ctx.db.get(conversationId));
  const firstReplyAt = afterFirst?.firstReplyAt;
  expect(firstReplyAt).toBeGreaterThan(0);

  await appendVia(t, accountId, conversationId, "agent");
  const afterSecond = await t.run((ctx) => ctx.db.get(conversationId));
  expect(afterSecond?.firstReplyAt).toBe(firstReplyAt);
});

test("insertMessageAndUpdateConversation: no adReferral means no firstReplyAt", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId } = await seedWindowConv(t);

  await appendVia(t, accountId, conversationId, "agent");

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation?.firstReplyAt).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/messages.test.ts -t "lastInboundAt"`
Expected: FAIL — `lastInboundAt` is `undefined` after an inbound message.

- [ ] **Step 3: Implement the patch changes**

Replace `convex/messages.ts:227-240` with:

```ts
  const now = Date.now();
  const patch: Partial<{
    lastMessageText: string;
    lastMessageAt: number;
    updatedAt: number;
    unreadCount: number;
    lastInboundAt: number;
    firstReplyAt: number;
  }> = {
    lastMessageText: contentText ?? `[${contentType}]`,
    lastMessageAt: now,
    updatedAt: now,
  };
  if (senderType === "customer") {
    patch.unreadCount = conversation.unreadCount + 1;
    // Anchor for Meta's 24h customer service window. `lastMessageAt`
    // cannot serve this — it also moves on outbound messages.
    patch.lastInboundAt = now;
  } else if (
    conversation.adReferral &&
    conversation.firstReplyAt === undefined
  ) {
    // Anchor for the 72h free-entry-point ESTIMATE. Only meaningful on
    // an ad conversation, and only the FIRST reply after the referral —
    // `adReferral` is already set by the time this fires, so an outbound
    // that predates the ad click cannot claim this slot.
    patch.firstReplyAt = now;
  }
  await ctx.db.patch(conversationId, patch);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/messages.test.ts`
Expected: PASS — all four new tests plus the Task 3 tests.

- [ ] **Step 5: Verify nothing regressed**

Run: `npm test`
Expected: PASS. The two `Date.now()` calls became one `now`, which is behaviour-preserving.

- [ ] **Step 6: Commit**

```bash
git add convex/messages.ts convex/messages.test.ts
git commit -m "$(cat <<'EOF'
feat(messages): track lastInboundAt and firstReplyAt on conversations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The `resolveWindowState` resolver

**Files:**
- Create: `convex/lib/whatsapp/messagingWindow.ts`
- Test: `convex/lib/whatsapp/messagingWindow.test.ts`

**Interfaces:**
- Consumes: nothing at runtime (pure); shaped by the fields from Tasks 2/3/5
- Produces: `resolveWindowState(input: ResolveWindowInput): WindowState`, plus `CSW_WINDOW_MS` and `FEP_WINDOW_MS`. Used by Task 7 and every later phase.

- [ ] **Step 1: Write the failing tests**

Create `convex/lib/whatsapp/messagingWindow.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  CSW_WINDOW_MS,
  FEP_WINDOW_MS,
  resolveWindowState,
} from "./messagingWindow";

const NOW = 1_000_000_000_000;

// ------------------------------------------------------------
// 24h customer service window
// ------------------------------------------------------------

test("csw: open when the last inbound message is under 24h old", () => {
  const s = resolveWindowState({ now: NOW, lastInboundAt: NOW - 1000 });
  expect(s.csw.open).toBe(true);
  expect(s.canSendFreeForm).toBe(true);
  expect(s.csw.expiresAt).toBe(NOW - 1000 + CSW_WINDOW_MS);
});

test("csw: closed at exactly 24h and beyond", () => {
  expect(
    resolveWindowState({ now: NOW, lastInboundAt: NOW - CSW_WINDOW_MS }).csw
      .open,
  ).toBe(false);
});

test("csw: absent lastInboundAt is treated as closed, not an error", () => {
  const s = resolveWindowState({ now: NOW });
  expect(s.csw.open).toBe(false);
  expect(s.csw.remainingMs).toBe(0);
  expect(s.canSendFreeForm).toBe(false);
});

// ------------------------------------------------------------
// 72h free entry point window
// ------------------------------------------------------------

test("fep: no ad referral means no free entry point, ever", () => {
  const s = resolveWindowState({ now: NOW, lastInboundAt: NOW - 1000 });
  expect(s.fep.open).toBe(false);
  expect(s.fep.source).toBe("none");
});

test("fep: ad referral with a reply inside 24h opens an estimated window", () => {
  const startedAt = NOW - 2 * 60 * 60 * 1000;
  const firstReplyAt = startedAt + 60 * 60 * 1000;
  const s = resolveWindowState({
    now: NOW,
    lastInboundAt: startedAt,
    adReferralStartedAt: startedAt,
    firstReplyAt,
  });
  expect(s.fep.open).toBe(true);
  expect(s.fep.source).toBe("estimated");
  expect(s.fep.expiresAt).toBe(firstReplyAt + FEP_WINDOW_MS);
  expect(s.confidence).toBe("estimated");
});

test("fep: ad referral with NO reply inside 24h never opens a window", () => {
  const startedAt = NOW - 100 * 60 * 60 * 1000;
  const s = resolveWindowState({
    now: NOW,
    adReferralStartedAt: startedAt,
    firstReplyAt: startedAt + CSW_WINDOW_MS + 1,
  });
  expect(s.fep.open).toBe(false);
  expect(s.fep.source).toBe("none");
  expect(s.confidence).toBe("authoritative");
});

test("fep: ad referral with no reply at all never opens a window", () => {
  const s = resolveWindowState({
    now: NOW,
    adReferralStartedAt: NOW - 1000,
  });
  expect(s.fep.open).toBe(false);
  expect(s.fep.source).toBe("none");
});

test("fep: Meta's authoritative window overrides an active estimate", () => {
  const startedAt = NOW - 2 * 60 * 60 * 1000;
  const s = resolveWindowState({
    now: NOW,
    adReferralStartedAt: startedAt,
    firstReplyAt: startedAt + 1000,
    metaWindow: { isFreeEntryPoint: true, expiresAt: NOW + 5000 },
  });
  expect(s.fep.source).toBe("meta");
  expect(s.fep.expiresAt).toBe(NOW + 5000);
  expect(s.confidence).toBe("authoritative");
});

test("fep: an expired Meta window stays authoritative and closed", () => {
  const s = resolveWindowState({
    now: NOW,
    metaWindow: { isFreeEntryPoint: true, expiresAt: NOW - 1 },
  });
  expect(s.fep.open).toBe(false);
  expect(s.fep.source).toBe("meta");
});

// ------------------------------------------------------------
// The four-quadrant cost matrix
// ------------------------------------------------------------

test("quadrant 1 — CSW open, FEP open: everything free", () => {
  const s = resolveWindowState({
    now: NOW,
    lastInboundAt: NOW - 1000,
    metaWindow: { isFreeEntryPoint: true, expiresAt: NOW + 5000 },
  });
  expect(s.canSendFreeForm).toBe(true);
  expect(s.cost.freeForm).toEqual({ free: true, reason: "fep" });
  expect(s.cost.templateMarketing).toEqual({ free: true, reason: "fep" });
  expect(s.cost.templateAuthentication).toEqual({ free: true, reason: "fep" });
  expect(s.cost.templateUtility).toEqual({ free: true, reason: "fep" });
});

test("quadrant 2 — CSW closed, FEP open: template-only but still free", () => {
  const s = resolveWindowState({
    now: NOW,
    lastInboundAt: NOW - CSW_WINDOW_MS - 1,
    metaWindow: { isFreeEntryPoint: true, expiresAt: NOW + 5000 },
  });
  expect(s.canSendFreeForm).toBe(false);
  expect(s.cost.templateMarketing).toEqual({ free: true, reason: "fep" });
});

test("quadrant 3 — CSW open, FEP closed: free-form and utility free, marketing and auth billed", () => {
  const s = resolveWindowState({ now: NOW, lastInboundAt: NOW - 1000 });
  expect(s.canSendFreeForm).toBe(true);
  expect(s.cost.freeForm).toEqual({
    free: true,
    reason: "customer_service_window",
  });
  expect(s.cost.templateUtility).toEqual({
    free: true,
    reason: "customer_service_window",
  });
  expect(s.cost.templateMarketing).toEqual({ free: false, reason: "billed" });
  expect(s.cost.templateAuthentication).toEqual({
    free: false,
    reason: "billed",
  });
});

test("quadrant 4 — both closed: template-only and billed", () => {
  const s = resolveWindowState({
    now: NOW,
    lastInboundAt: NOW - CSW_WINDOW_MS - 1,
  });
  expect(s.canSendFreeForm).toBe(false);
  expect(s.cost.templateUtility).toEqual({ free: false, reason: "billed" });
  expect(s.cost.templateMarketing).toEqual({ free: false, reason: "billed" });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/lib/whatsapp/messagingWindow.test.ts`
Expected: FAIL — cannot resolve `./messagingWindow`.

- [ ] **Step 3: Implement the resolver**

Create `convex/lib/whatsapp/messagingWindow.ts`:

```ts
// Pure resolver for Meta's two WhatsApp messaging windows. Dependency-
// free (no Convex, no React) so it is unit-testable and callable from
// any layer — same convention as `./webhookParse.ts`.
//
// THE TWO CLOCKS ARE INDEPENDENT AND DO DIFFERENT JOBS:
//
//   24h customer service window  → governs message TYPE.
//        Resets on every inbound customer message. While open, free-form
//        (non-template) messages may be sent; while closed, templates only.
//
//   72h free entry point window  → governs COST.
//        Opened when the business replies to a Click-to-WhatsApp / Page-CTA
//        lead within 24h. While open, EVERY message is free — including
//        marketing and authentication templates that are otherwise billed.
//
// Conflating them is the bug class this module exists to prevent: a
// conversation can be template-only AND free at the same time.

/** Meta's customer service window: 24 hours. */
export const CSW_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Meta's free entry point window: 72 hours. */
export const FEP_WINDOW_MS = 72 * 60 * 60 * 1000;

export type CostReason = "fep" | "customer_service_window" | "billed";
export type FepSource = "meta" | "estimated" | "none";

export interface CostEntry {
  free: boolean;
  reason: CostReason;
}

export interface ResolveWindowInput {
  now: number;
  /** `conversations.lastInboundAt` — last CUSTOMER message. */
  lastInboundAt?: number;
  /** `conversations.metaWindow` — Meta's authoritative record. */
  metaWindow?: { expiresAt?: number; isFreeEntryPoint: boolean };
  /** `conversations.adReferral.startedAt` — the ad click. */
  adReferralStartedAt?: number;
  /** `conversations.firstReplyAt` — first outbound after the ad click. */
  firstReplyAt?: number;
}

export interface WindowState {
  csw: { open: boolean; expiresAt?: number; remainingMs: number };
  fep: {
    open: boolean;
    expiresAt?: number;
    remainingMs: number;
    source: FepSource;
  };
  /** Free-form (non-template) messages are permitted. Always `csw.open`. */
  canSendFreeForm: boolean;
  /** Cost per message kind. A DATA MAP, not a boolean: in quadrant 3
   *  free-form and utility are free while marketing and authentication
   *  are billed, which no single flag can express. */
  cost: {
    freeForm: CostEntry;
    templateUtility: CostEntry;
    templateMarketing: CostEntry;
    templateAuthentication: CostEntry;
  };
  confidence: "authoritative" | "estimated";
}

const BILLED: CostEntry = { free: false, reason: "billed" };

export function resolveWindowState(input: ResolveWindowInput): WindowState {
  const { now, lastInboundAt, metaWindow, adReferralStartedAt, firstReplyAt } =
    input;

  // ---- 24h customer service window
  const cswExpiresAt =
    lastInboundAt !== undefined ? lastInboundAt + CSW_WINDOW_MS : undefined;
  const cswRemaining =
    cswExpiresAt !== undefined ? Math.max(0, cswExpiresAt - now) : 0;
  const cswOpen = cswRemaining > 0;

  // ---- 72h free entry point window: Meta first, estimate only in the gap
  let fepExpiresAt: number | undefined;
  let fepSource: FepSource = "none";

  if (metaWindow?.isFreeEntryPoint && metaWindow.expiresAt !== undefined) {
    fepExpiresAt = metaWindow.expiresAt;
    fepSource = "meta";
  } else if (adReferralStartedAt !== undefined && firstReplyAt !== undefined) {
    // Meta opens the window only if the business replied within 24h of
    // the ad click. No reply in time ⇒ no free window, ever. Meta
    // anchors on the reply being DELIVERED; we anchor on sent, which is
    // typically seconds earlier and is superseded the moment the status
    // webhook lands.
    if (firstReplyAt - adReferralStartedAt < CSW_WINDOW_MS) {
      fepExpiresAt = firstReplyAt + FEP_WINDOW_MS;
      fepSource = "estimated";
    }
  }

  const fepRemaining =
    fepExpiresAt !== undefined ? Math.max(0, fepExpiresAt - now) : 0;
  const fepOpen = fepRemaining > 0;

  // ---- cost, in precedence order
  let cost: WindowState["cost"];
  if (fepOpen) {
    const free: CostEntry = { free: true, reason: "fep" };
    cost = {
      freeForm: free,
      templateUtility: free,
      templateMarketing: free,
      templateAuthentication: free,
    };
  } else if (cswOpen) {
    const free: CostEntry = { free: true, reason: "customer_service_window" };
    cost = {
      freeForm: free,
      templateUtility: free,
      templateMarketing: BILLED,
      templateAuthentication: BILLED,
    };
  } else {
    cost = {
      freeForm: BILLED,
      templateUtility: BILLED,
      templateMarketing: BILLED,
      templateAuthentication: BILLED,
    };
  }

  return {
    csw: { open: cswOpen, expiresAt: cswExpiresAt, remainingMs: cswRemaining },
    fep: {
      open: fepOpen,
      expiresAt: fepExpiresAt,
      remainingMs: fepRemaining,
      source: fepSource,
    },
    canSendFreeForm: cswOpen,
    cost,
    confidence: fepSource === "estimated" ? "estimated" : "authoritative",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/lib/whatsapp/messagingWindow.test.ts`
Expected: PASS — all 13 tests (3 CSW + 6 FEP + 4 quadrant).

- [ ] **Step 5: Commit**

```bash
git add convex/lib/whatsapp/messagingWindow.ts convex/lib/whatsapp/messagingWindow.test.ts
git commit -m "$(cat <<'EOF'
feat(whatsapp): add pure messaging-window resolver

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Route the backend consumer through the resolver

**Files:**
- Modify: `convex/qualificationEngine.ts:3042` (the inline `windowOpen` computation)

**Interfaces:**
- Consumes: `resolveWindowState`, `CSW_WINDOW_MS` (Task 6); `conversations.lastInboundAt` (Task 5)
- Produces: nothing new. This is a behaviour-preserving refactor.

- [ ] **Step 1: Add the import**

At the top of `convex/qualificationEngine.ts`, alongside the other `./lib/...` imports, add:

```ts
import { resolveWindowState } from "./lib/whatsapp/messagingWindow";
```

- [ ] **Step 2: Replace the inline computation**

At `convex/qualificationEngine.ts:3042`, inside the `out.push({ ... })` call, replace this exact line:

```ts
          windowOpen: now - lastInbound < 24 * 3_600_000 && lastInbound > 0,
```

with:

```ts
          windowOpen: resolveWindowState({
            now,
            // `lastInbound` is 0 when the conversation has no customer
            // message yet. The resolver takes `undefined` for that case
            // and reports the window closed either way, which preserves
            // the `lastInbound > 0` guard this replaces.
            lastInboundAt: lastInbound > 0 ? lastInbound : undefined,
          }).csw.open,
```

For orientation, the surrounding call currently reads:

```ts
        out.push({
          accountId: config.accountId,
          phone,
          phoneNormalized,
          windowOpen: now - lastInbound < 24 * 3_600_000 && lastInbound > 0,
          templateName: config.staffCheckinTemplateName ?? null,
          templateLanguage: config.staffCheckinTemplateLanguage ?? null,
        });
```

- [ ] **Step 3: Verify behaviour is unchanged**

Run: `npx vitest run convex/qualificationEngine.test.ts && npm run typecheck`
Expected: PASS. The resolver's CSW rule (`now - lastInboundAt < 24h`) is arithmetically identical to the expression it replaces, and the `lastInbound > 0` guard is preserved by the `undefined` mapping.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — no behaviour change anywhere.

- [ ] **Step 5: Commit**

```bash
git add convex/qualificationEngine.ts
git commit -m "$(cat <<'EOF'
refactor(qualification): use the shared messaging-window resolver

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Verification of the whole phase

- [ ] Run `npm test` — full suite green.
- [ ] Run `npm run typecheck` — clean.
- [ ] Run `npx eslint` on the changed files only — no NEW lint introduced by this diff:
      `npx eslint convex/http.ts convex/messages.ts convex/schema.ts convex/qualificationEngine.ts convex/lib/whatsapp/webhookParse.ts convex/lib/whatsapp/messagingWindow.ts`
- [ ] Confirm **no user-visible change**: run `git diff --stat main -- src/` and verify it is empty. Nothing under `src/` is modified in Phase 1 — `src/lib/inbox/adWindow.ts` and `message-thread.tsx` still compute exactly as before.

## What Phase 1 deliberately does not do

- No inbox countdowns, badges, or any UI (Phase 2). The resolver is not yet exposed to the frontend.
- No `fep.eligibleUntil` "you can still unlock this window" signal — Phase 2 adds it when the nudge UI needs it. Do **not** invent it here.
- No send-layer gating, AI auto-reply, automation or broadcast behaviour (Phase 3).
- No cost aggregation or spend reporting (Phase 4) — `messages.pricing` is captured but not yet read.
