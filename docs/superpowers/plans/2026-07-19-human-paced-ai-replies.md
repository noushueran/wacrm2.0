# Human-Paced AI Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 12-second reply delay with an immediate typing acknowledgement plus a shape-adaptive, length-proportional, jittered reply cadence, so the bot reads as a person typing rather than a machine pausing.

**Architecture:** All pacing arithmetic lives in one new pure module (`convex/lib/ai/pacing.ts`) that is unit-tested in isolation. `convex/ingest.ts` fires an immediate acknowledgement action and schedules the dispatch on a shape-derived window. `convex/aiReply.ts` no longer sends inline — it schedules a small `deliverReply` action after a delay computed from the generated reply's length, measured from inbound arrival so the LLM's think time is absorbed rather than stacked.

**Tech Stack:** Convex (actions, internal actions, scheduler), TypeScript, Vitest + `convex-test`.

**Spec:** [`docs/superpowers/specs/2026-07-19-reply-pacing-and-supervisor-rbac-design.md`](../specs/2026-07-19-reply-pacing-and-supervisor-rbac-design.md) — Part A.

## Global Constraints

- **Meta dismisses the typing indicator after 25 seconds.** No documented refresh. Total time-to-reply must stay well under this; `TYPING_MAX_MS = 15_000` enforces it by construction. Never raise it above `20_000`.
- **There is no inbound typing/composing webhook.** Do not attempt to detect customer typing. Silence is the only available evidence.
- `AI_REPLY_DEBOUNCE_MS=0` remains the documented kill switch and must silence **every** debounce tier, not just the neutral one.
- Convex `process.env` reads must happen **inside function bodies**, never at module scope (matches the existing `aiReplyDebounceMs` pattern).
- Only `convex/lib/ai/defaults.ts`'s `MAX_OUTPUT_TOKENS` changes. Leave `src/lib/ai/defaults.ts` alone — that constant serves the human-reviewed draft-reply route, which may legitimately be longer.
- This is the WhatsApp auto-reply path in production. Every new failure mode must be best-effort: an error in acknowledgement or pacing must never cost the customer their reply.
- Run the full suite with `npm test` before every commit.

---

### Task 1: Pacing module

The pure arithmetic, isolated and heavily tested. Everything later depends on this.

**Files:**
- Create: `convex/lib/ai/pacing.ts`
- Create: `convex/lib/ai/pacing.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module)
- Produces:
  - `type MessageShape = "complete" | "fragment" | "neutral"`
  - `classifyMessageShape(text: string | null | undefined): MessageShape`
  - `debounceMsForText(text: string | null | undefined): number`
  - `deliveryDelayMs(args: { replyLength: number; elapsedMs: number; random?: () => number }): number`

- [ ] **Step 1: Write the failing test**

Create `convex/lib/ai/pacing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyMessageShape, debounceMsForText, deliveryDelayMs } from "./pacing";

describe("classifyMessageShape", () => {
  it("treats terminal punctuation as a finished thought", () => {
    expect(classifyMessageShape("how much?")).toBe("complete");
    expect(classifyMessageShape("Book it.")).toBe("complete");
    expect(classifyMessageShape("Great!")).toBe("complete");
  });

  it("recognises non-Latin terminal punctuation", () => {
    expect(classifyMessageShape("كم السعر؟")).toBe("complete");
    expect(classifyMessageShape("多少钱。")).toBe("complete");
  });

  it("treats long unpunctuated text as a finished thought", () => {
    expect(
      classifyMessageShape("I am looking for a family package for August"),
    ).toBe("complete");
  });

  it("treats short unpunctuated text as a fragment", () => {
    expect(classifyMessageShape("hi")).toBe("fragment");
    expect(classifyMessageShape("how much")).toBe("fragment");
    expect(classifyMessageShape("good morning")).toBe("fragment");
  });

  it("treats mid-length unpunctuated text as neutral", () => {
    expect(classifyMessageShape("what packages do you have")).toBe("neutral");
  });

  it("treats empty, whitespace, and absent text as neutral", () => {
    expect(classifyMessageShape("")).toBe("neutral");
    expect(classifyMessageShape("   ")).toBe("neutral");
    expect(classifyMessageShape(null)).toBe("neutral");
    expect(classifyMessageShape(undefined)).toBe("neutral");
  });

  it("ignores surrounding whitespace when classifying", () => {
    expect(classifyMessageShape("  hi  ")).toBe("fragment");
    expect(classifyMessageShape("  how much?  ")).toBe("complete");
  });
});

describe("debounceMsForText", () => {
  it("waits least for a finished thought", () => {
    expect(debounceMsForText("how much?")).toBe(2_000);
  });

  it("waits longest for a fragment", () => {
    expect(debounceMsForText("hi")).toBe(6_000);
  });

  it("falls back to the base window otherwise", () => {
    expect(debounceMsForText("what packages do you have")).toBe(3_000);
    expect(debounceMsForText(null)).toBe(3_000);
  });
});

describe("deliveryDelayMs", () => {
  // random() === 0.5 → jitter factor exactly 1.0, isolating the base maths.
  const noJitter = () => 0.5;

  it("floors a very short reply at the minimum", () => {
    expect(
      deliveryDelayMs({ replyLength: 18, elapsedMs: 0, random: noJitter }),
    ).toBe(3_000);
  });

  it("scales with reply length between the bounds", () => {
    // 180 chars / 18 chars-per-sec = 10s
    expect(
      deliveryDelayMs({ replyLength: 180, elapsedMs: 0, random: noJitter }),
    ).toBe(10_000);
  });

  it("caps a long reply at the maximum, staying under Meta's 25s ceiling", () => {
    expect(
      deliveryDelayMs({ replyLength: 5_000, elapsedMs: 0, random: noJitter }),
    ).toBe(15_000);
  });

  it("subtracts time already elapsed since the inbound arrived", () => {
    expect(
      deliveryDelayMs({ replyLength: 180, elapsedMs: 4_000, random: noJitter }),
    ).toBe(6_000);
  });

  it("returns 0 when generation already outran the target", () => {
    expect(
      deliveryDelayMs({ replyLength: 180, elapsedMs: 12_000, random: noJitter }),
    ).toBe(0);
  });

  it("never returns a negative delay", () => {
    expect(
      deliveryDelayMs({ replyLength: 10, elapsedMs: 99_000, random: noJitter }),
    ).toBe(0);
  });

  it("applies jitter within +/-25% of the base", () => {
    const low = deliveryDelayMs({ replyLength: 180, elapsedMs: 0, random: () => 0 });
    const high = deliveryDelayMs({
      replyLength: 180,
      elapsedMs: 0,
      random: () => 0.999999,
    });
    expect(low).toBe(7_500); // 10s * 0.75
    expect(high).toBeGreaterThan(12_400); // ~10s * 1.25
    expect(high).toBeLessThanOrEqual(12_500);
  });

  it("treats a negative reply length as zero rather than a negative delay", () => {
    expect(
      deliveryDelayMs({ replyLength: -50, elapsedMs: 0, random: noJitter }),
    ).toBe(3_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/ai/pacing.test.ts`
Expected: FAIL — `Failed to resolve import "./pacing"`

- [ ] **Step 3: Write the implementation**

Create `convex/lib/ai/pacing.ts`:

```ts
// ============================================================
// Reply pacing — how long the auto-reply waits before generating, and
// how long the generated text then "types" before it lands.
//
// Split out of `defaults.ts` (which owns the prompt scaffold) because
// everything here is pure arithmetic and carries a dense unit suite.
//
// Two Meta constraints shape this file, both verified against their
// docs rather than assumed:
//   1. There is NO inbound typing/composing webhook. "Wait until the
//      customer stops typing" is unbuildable — silence is the only
//      evidence a thought is finished, so the debounce window is a
//      guess made from message SHAPE.
//   2. The typing indicator auto-dismisses after 25s, with no
//      documented way to refresh it. `DEFAULT_TYPING_MAX_MS` keeps
//      every reply well inside that ceiling by construction; raising
//      it past ~20s means customers watch "typing…" die into silence.
// ============================================================

const DEFAULT_DEBOUNCE_BASE_MS = 3_000;
const DEFAULT_DEBOUNCE_FAST_MS = 2_000;
const DEFAULT_DEBOUNCE_SLOW_MS = 6_000;

const DEFAULT_TYPING_CHARS_PER_SEC = 18;
const DEFAULT_TYPING_JITTER = 0.25;
const DEFAULT_TYPING_MIN_MS = 3_000;
const DEFAULT_TYPING_MAX_MS = 15_000;

/** Terminal punctuation across the languages this CRM actually serves
 *  (Latin, Arabic, CJK) — a message ending in one reads as finished. */
const TERMINAL_PUNCTUATION = /[.!?。！？؟…]$/u;

/** Below this, an unpunctuated message is almost certainly a fragment
 *  with its follow-up already being typed ("hi", "how much", "I want"). */
const FRAGMENT_MAX_LENGTH = 15;

/** Above this, a message is a finished thought even unpunctuated —
 *  nobody types 40 characters as the first half of a sentence. */
const COMPLETE_MIN_LENGTH = 40;

export type MessageShape = "complete" | "fragment" | "neutral";

/** Convex reads `process.env` per-call, never at module scope. */
function envNumber(name: string, fallback: number, floor: boolean): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return floor ? Math.floor(raw) : raw;
}

export function classifyMessageShape(text: string | null | undefined): MessageShape {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "neutral";
  if (TERMINAL_PUNCTUATION.test(trimmed)) return "complete";
  if (trimmed.length > COMPLETE_MIN_LENGTH) return "complete";
  if (trimmed.length < FRAGMENT_MAX_LENGTH) return "fragment";
  return "neutral";
}

/**
 * How long to wait after this inbound before generating a reply. The
 * burst-coalescing itself is unchanged and lives in `aiReply.ts`: each
 * inbound schedules its own dispatch, and an older dispatch stands down
 * when its trigger is no longer the newest message. This function only
 * decides how long we listen before concluding they're done.
 */
export function debounceMsForText(text: string | null | undefined): number {
  const base = envNumber("AI_REPLY_DEBOUNCE_MS", DEFAULT_DEBOUNCE_BASE_MS, true);
  // `0` is the documented kill switch (restores immediate dispatch) and
  // must silence EVERY tier, not just the neutral one.
  if (base === 0) return 0;
  switch (classifyMessageShape(text)) {
    case "complete":
      return envNumber("AI_REPLY_DEBOUNCE_FAST_MS", DEFAULT_DEBOUNCE_FAST_MS, true);
    case "fragment":
      return envNumber("AI_REPLY_DEBOUNCE_SLOW_MS", DEFAULT_DEBOUNCE_SLOW_MS, true);
    case "neutral":
      return base;
  }
}

/**
 * How much longer to hold a finished reply so it lands at a human pace.
 *
 * `elapsedMs` is time since the INBOUND arrived, not since generation
 * started — so the LLM's think time is absorbed into the typing window
 * rather than stacked on top of it. Slow generation yields a short
 * artificial wait, fast generation a longer one, and the customer
 * experiences the same rhythm either way.
 *
 * Jitter matters for its own sake: a bot replying in exactly 3.0s every
 * time is detectable precisely BECAUSE it is consistent.
 *
 * `random` is injectable purely so the suite can pin the jitter.
 */
export function deliveryDelayMs(args: {
  replyLength: number;
  elapsedMs: number;
  random?: () => number;
}): number {
  const { replyLength, elapsedMs, random = Math.random } = args;

  const charsPerSec =
    envNumber("AI_TYPING_CHARS_PER_SEC", DEFAULT_TYPING_CHARS_PER_SEC, false) ||
    DEFAULT_TYPING_CHARS_PER_SEC;
  const jitter = envNumber("AI_TYPING_JITTER", DEFAULT_TYPING_JITTER, false);
  const minMs = envNumber("AI_TYPING_MIN_MS", DEFAULT_TYPING_MIN_MS, true);
  const maxMs = envNumber("AI_TYPING_MAX_MS", DEFAULT_TYPING_MAX_MS, true);

  const baseMs = (Math.max(0, replyLength) / charsPerSec) * 1_000;
  // random() ∈ [0,1) → factor ∈ [1-jitter, 1+jitter)
  const jittered = baseMs * (1 + (random() * 2 - 1) * jitter);
  const target = Math.min(maxMs, Math.max(minMs, jittered));
  return Math.max(0, Math.round(target - elapsedMs));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/lib/ai/pacing.test.ts`
Expected: PASS — 20 tests

- [ ] **Step 5: Commit**

```bash
git add convex/lib/ai/pacing.ts convex/lib/ai/pacing.test.ts
git commit -m "feat(ai): add pure reply-pacing module

Shape classifier + debounce tiers + length-proportional jittered
delivery delay. No callers yet."
```

---

### Task 2: Wire the adaptive debounce into ingest

Replaces the flat 12s window at the one call site.

**Files:**
- Modify: `convex/lib/ai/defaults.ts:40-52` (delete `aiReplyDebounceMs` and its `DEFAULT_REPLY_DEBOUNCE_MS`)
- Modify: `convex/ingest.ts:6` (import) and `convex/ingest.ts:782` (call site)

**Interfaces:**
- Consumes: `debounceMsForText` from Task 1
- Produces: nothing new

`aiReplyDebounceMs` has exactly one importer (`convex/ingest.ts:6`) and no test references — verified by grep. Deleting it is safe.

- [ ] **Step 1: Delete the old constant**

In `convex/lib/ai/defaults.ts`, delete lines 40-52 entirely — the `DEFAULT_REPLY_DEBOUNCE_MS` const, the doc comment, and the `aiReplyDebounceMs` function. Its replacement lives in `pacing.ts`.

- [ ] **Step 2: Update the ingest import**

In `convex/ingest.ts`, line 6 currently reads:

```ts
import { aiReplyDebounceMs } from "./lib/ai/defaults";
```

Replace with:

```ts
import { debounceMsForText } from "./lib/ai/pacing";
```

- [ ] **Step 3: Update the call site**

In `convex/ingest.ts` around line 782, the scheduler call currently opens:

```ts
        await ctx.scheduler.runAfter(
          aiReplyDebounceMs(),
          internal.aiReply.dispatchInbound,
```

Replace the delay argument so the window comes from the message's shape:

```ts
        await ctx.scheduler.runAfter(
          debounceMsForText(inboundText),
          internal.aiReply.dispatchInbound,
```

`inboundText` is already in scope — it is used in the guard at line 755.

- [ ] **Step 4: Run the suite to verify nothing regressed**

Run: `npm test`
Expected: PASS — no test referenced `aiReplyDebounceMs`, and `convex/ingest.test.ts` must stay green.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/ai/defaults.ts convex/ingest.ts
git commit -m "feat(ai): pick reply debounce from inbound message shape

Replaces the flat 12s wait. A finished-looking message waits 2s, a
fragment 6s, anything else 3s."
```

---

### Task 3: Acknowledge the inbound immediately

Moves the blue tick and "typing…" from *after* the debounce to *within a second of* the inbound — the change that removes the felt silence.

**Files:**
- Modify: `convex/aiReply.ts` (add `ackInbound`; delete the inline `markRead` block at lines 571-585)
- Modify: `convex/ingest.ts` (schedule `ackInbound` alongside the dispatch)
- Modify: `convex/aiReply.test.ts` (add coverage)

**Interfaces:**
- Consumes: `internal.aiConfig.loadDecrypted`, `internal.aiReply.loadDispatchContext`, `internal.metaSend.markRead` (all existing)
- Produces: `internal.aiReply.ackInbound({ accountId, conversationId, contactId, triggerWamid })`

- [ ] **Step 1: Write the failing test**

Append to `convex/aiReply.test.ts`:

```ts
test("ackInbound is a no-op when auto-reply is switched off", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-ack-off@example.com",
    role: "owner",
  });
  await configureAi(asUser, { autoReplyEnabled: false });
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000101",
    messageText: "hi",
  });

  // Must resolve without throwing and without reaching Meta. A throw
  // here would surface as an unhandled scheduled-function failure.
  await expect(
    t.action(internal.aiReply.ackInbound, {
      accountId,
      conversationId,
      contactId,
      triggerWamid: "wamid.TEST_ACK_OFF",
    }),
  ).resolves.toBeUndefined();
});

test("ackInbound is a no-op once a human owns the thread", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-ack-assigned@example.com",
    role: "owner",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000102",
    messageText: "hi",
  });

  await t.run(async (ctx) => {
    await ctx.db.patch(conversationId, { assignedToUserId: userId });
  });

  await expect(
    t.action(internal.aiReply.ackInbound, {
      accountId,
      conversationId,
      contactId,
      triggerWamid: "wamid.TEST_ACK_ASSIGNED",
    }),
  ).resolves.toBeUndefined();
});
```

These reuse the suite's existing helpers, verified present at
`convex/aiReply.test.ts:41` (`seedAccountMember` → `{ userId, accountId,
asUser }`), `:96` (`configureAi(asUser, overrides)`), and `:114`
(`seedInboundThread(t, asUser, { accountId, phone, messageText })` →
`{ contactId, conversationId }`). Do not add a new seeding helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/aiReply.test.ts -t ackInbound`
Expected: FAIL — `internal.aiReply.ackInbound` is undefined

- [ ] **Step 3: Add the action**

In `convex/aiReply.ts`, insert immediately **before** `export const dispatchInbound`:

```ts
/**
 * Blue-tick the inbound and show "typing…" as soon as it lands, rather
 * than after the debounce elapses. Scheduled at `runAfter(0)` from
 * `ingest.ts` in parallel with the (delayed) dispatch.
 *
 * This exists because the customer used to sit in total silence for the
 * whole debounce window, which reads as being ignored. Acknowledging
 * first makes the wait legible, so the wait itself no longer has to be
 * short to feel human.
 *
 * Gates mirror `dispatchInbound`'s first four (config live, auto-reply
 * on, account owns the thread, no human in charge) but deliberately
 * NOT its debounce-token check: re-acking on every message of a burst
 * is correct — a human reading along would keep the receipt current.
 *
 * Best-effort throughout. A failure here costs a read receipt, never a
 * reply, so it must never throw into the scheduler.
 */
export const ackInbound = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    triggerWamid: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const config = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
        accountId: args.accountId,
      });
      if (!config || !config.isActive || !config.autoReplyEnabled) return;

      const dispatchContext: { conversation: Doc<"conversations">; to: string } | null =
        await ctx.runQuery(internal.aiReply.loadDispatchContext, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          contactId: args.contactId,
        });
      if (!dispatchContext) return;

      const { conversation } = dispatchContext;
      if (conversation.assignedToUserId) return; // a human owns this thread
      if (conversation.aiAutoreplyDisabled) return; // handed off / turned off here

      await ctx.runAction(internal.metaSend.markRead, {
        accountId: args.accountId,
        whatsappMessageId: args.triggerWamid,
        typingIndicator: true,
      });
    } catch (err) {
      console.warn("[ai auto-reply] ack failed:", err);
    }
  },
});
```

- [ ] **Step 4: Delete the now-duplicated inline acknowledgement**

In `convex/aiReply.ts`, delete lines 571-585 — the comment block beginning `// Every gate passed — we intend to reply. Blue-tick the triggering` through the closing brace of its `if (args.triggerWamid) { ... }`. Leaving it would cost a second Meta round-trip per reply.

`dispatchInbound`'s `triggerWamid` argument stays — it is still threaded through the retry path at line 750.

- [ ] **Step 5: Schedule it from ingest**

In `convex/ingest.ts`, directly **above** the existing `await ctx.scheduler.runAfter(debounceMsForText(inboundText), ...)` call, add:

```ts
        // Acknowledge instantly — blue tick + "typing…" within a second,
        // rather than after the debounce. Separate from the dispatch
        // because the whole point is that it does NOT wait.
        await ctx.scheduler.runAfter(0, internal.aiReply.ackInbound, {
          accountId,
          conversationId: res.conversationId,
          contactId: res.contactId,
          triggerWamid: message.wamid,
        });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — including the two new `ackInbound` tests

- [ ] **Step 7: Commit**

```bash
git add convex/aiReply.ts convex/ingest.ts convex/aiReply.test.ts
git commit -m "feat(ai): acknowledge inbound immediately instead of after the debounce

Blue tick + typing indicator now fire within ~1s of the message
landing. Removes the inline mark-read from dispatch so we still make
only one Meta call."
```

---

### Task 4: Length-proportional delivery

The reply stops being sent the instant it is generated, and instead lands on a human cadence.

**Files:**
- Modify: `convex/aiReply.ts` (add `deliverReply`; replace the inline send block at lines 742-789)
- Modify: `convex/ingest.ts` (thread `inboundAt`)
- Modify: `convex/aiReply.test.ts` (add coverage)

**Interfaces:**
- Consumes: `deliveryDelayMs` from Task 1
- Produces: `internal.aiReply.deliverReply({ accountId, conversationId, contactId, to, replyText, triggerMessageId?, askAdmin?, inquiryIds })`
- Changes: `internal.aiReply.dispatchInbound` gains an optional `inboundAt: number` arg

**Behaviour change to be explicit about:** once `deliverReply` is scheduled, `dispatchInbound` treats its work as done and sets `sent = true`. Provider and generation failures still retry exactly as before, because they happen upstream of scheduling. A failure inside `deliverReply` (a Meta send rejection) no longer triggers `dispatchInbound`'s retry — it is logged instead. This is deliberate: Meta send rejections were near-always non-retryable anyway, and a retry that re-generates would risk double-texting.

Delivery is **scheduled, not slept**. An in-action sleep would hold a Convex action slot and bill up to ~12s of idle compute per reply.

- [ ] **Step 1: Write the failing test**

Append to `convex/aiReply.test.ts`:

```ts
test("deliverReply sends the text it was handed", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-deliver@example.com",
    role: "owner",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000201",
    messageText: "how much?",
  });

  await t.action(internal.aiReply.deliverReply, {
    accountId,
    conversationId,
    contactId,
    to: "+971500000201",
    replyText: "Yes, we have packages for August!",
    inquiryIds: [],
  });

  const messages = await messagesFor(t, conversationId);
  expect(
    messages.some((m) => m.contentText === "Yes, we have packages for August!"),
  ).toBe(true);
});

test("deliverReply stands down when a newer inbound has arrived", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner-deliver-stale@example.com",
    role: "owner",
  });
  await configureAi(asUser);
  const { contactId, conversationId } = await seedInboundThread(t, asUser, {
    accountId,
    phone: "+971500000202",
    messageText: "first",
  });

  // The thread's only message so far is the debounce token we will pass.
  const [firstInbound] = await messagesFor(t, conversationId);

  // A newer customer message overtakes it, so the delivery must abort.
  await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer" as const,
      contentType: "text" as const,
      contentText: "second, newer",
      status: "sent" as const,
    }),
  );

  await t.action(internal.aiReply.deliverReply, {
    accountId,
    conversationId,
    contactId,
    to: "+971500000202",
    replyText: "stale reply that must not send",
    triggerMessageId: firstInbound._id,
    inquiryIds: [],
  });

  const messages = await messagesFor(t, conversationId);
  expect(
    messages.some((m) => m.contentText === "stale reply that must not send"),
  ).toBe(false);
});
```

The `messages` insert shape above is copied from `seedInboundThread`
(`convex/aiReply.test.ts:128-137`) — the table uses `senderType` /
`contentType` / `contentText` / `status`, **not** `direction` / `type`.

**One thing to confirm while implementing:** the first test sends for
real via `metaSend.sendText`. Follow whatever dry-run or `fetch`-stubbing
convention the neighbouring `dispatchInbound` send tests in this suite
already use (see the `okChatCompletion` helper at
`convex/aiReply.test.ts:685` and its call sites). If those tests rely on
a dry-run env flag, set it the same way here rather than letting the test
attempt a live Meta call.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/aiReply.test.ts -t deliverReply`
Expected: FAIL — `internal.aiReply.deliverReply` is undefined

- [ ] **Step 3: Add the delivery action**

In `convex/aiReply.ts`, insert immediately **after** the `dispatchInbound` export:

```ts
/**
 * Send a reply that has already been generated, then do the post-send
 * bookkeeping. Scheduled by `dispatchInbound` after a delay derived from
 * the reply's own length, so the message lands at a human typing pace
 * instead of the instant the model finishes.
 *
 * Split out rather than sleeping inside `dispatchInbound`: an in-action
 * sleep would hold an action slot and bill up to ~12s of idle compute on
 * every single reply.
 *
 * The debounce token is re-checked HERE, at the last possible moment —
 * more time has passed than at any earlier gate, so this is where a
 * newer customer message is most likely to have overtaken us.
 */
export const deliverReply = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    to: v.string(),
    replyText: v.string(),
    triggerMessageId: v.optional(v.id("messages")),
    askAdmin: v.optional(v.string()),
    // Table name verified against `qualificationEngine.markAnswersDelivered`
    // (`convex/qualificationEngine.ts:1332`) — it is `adminInquiries`.
    inquiryIds: v.array(v.id("adminInquiries")),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      if (args.triggerMessageId) {
        const latestNow = await ctx.runQuery(internal.aiReply.latestInboundMessageId, {
          accountId: args.accountId,
          conversationId: args.conversationId,
        });
        if (latestNow && latestNow !== args.triggerMessageId) return;
      }

      const sendResult = await ctx.runAction(internal.metaSend.sendText, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        to: args.to,
        text: args.replyText,
      });
      await ctx.runMutation(internal.aiReply.markMessageAiGenerated, {
        accountId: args.accountId,
        whatsappMessageId: sendResult.whatsappMessageId,
      });
      await ctx.runMutation(internal.aiReply.bumpReplyCount, {
        accountId: args.accountId,
        conversationId: args.conversationId,
      });

      if (args.askAdmin) {
        await ctx.scheduler.runAfter(
          0,
          internal.qualificationEngine.relayQuestionToAdmin,
          {
            accountId: args.accountId,
            conversationId: args.conversationId,
            contactId: args.contactId,
            question: args.askAdmin,
          },
        );
      }
      if (args.inquiryIds.length > 0) {
        await ctx.runMutation(internal.qualificationEngine.markAnswersDelivered, {
          inquiryIds: args.inquiryIds,
        });
      }
    } catch (err) {
      // No retry: `dispatchInbound` already considers this reply handed
      // off, and re-generating here would risk double-texting a customer
      // who may already have received the message.
      console.error("[ai auto-reply] delivery failed:", err);
    }
  },
});
```

`generation.askAdmin` is typed `string | null` (`convex/lib/ai/types.ts:48`), so the `?? undefined` conversion at the call site in Step 4 is required — `v.optional()` rejects an explicit `null`.

- [ ] **Step 4: Replace the inline send in `dispatchInbound`**

In `convex/aiReply.ts`, delete lines 742-789 — from the comment `// Re-check the debounce token at the last moment:` through the closing brace of the `if (teamAnswers.inquiryIds.length > 0) { ... }` block. Replace with:

```ts
      // Hand off to a delayed delivery instead of sending now, so the
      // reply lands at a pace proportional to its own length. `elapsed`
      // is measured from the INBOUND, not from here — that absorbs the
      // model's think time into the typing window rather than stacking
      // on top of it.
      const elapsedMs = args.inboundAt ? Date.now() - args.inboundAt : 0;
      await ctx.scheduler.runAfter(
        deliveryDelayMs({ replyLength: replyText.length, elapsedMs }),
        internal.aiReply.deliverReply,
        {
          accountId: args.accountId,
          conversationId: args.conversationId,
          contactId: args.contactId,
          to,
          replyText,
          triggerMessageId: args.triggerMessageId,
          askAdmin: generation.askAdmin ?? undefined,
          inquiryIds: teamAnswers.inquiryIds,
        },
      );
      // Delivery is scheduled and owns the send from here. Any failure
      // past this point must not re-dispatch — see this flag's own
      // declaration comment.
      sent = true;
```

- [ ] **Step 5: Add the `inboundAt` argument**

In `convex/aiReply.ts`, in `dispatchInbound`'s `args` block (near the existing `triggerMessageId` at line 528), add:

```ts
    // Wall-clock ms when the triggering inbound arrived, so delivery can
    // subtract time already spent. Optional: dispatches scheduled before
    // this shipped carry no value and simply skip the subtraction.
    inboundAt: v.optional(v.number()),
```

Add the pacing import at the top of `convex/aiReply.ts`, alongside the existing `./lib/ai/defaults` import on line 14:

```ts
import { deliveryDelayMs } from "./lib/ai/pacing";
```

- [ ] **Step 6: Thread `inboundAt` from ingest**

In `convex/ingest.ts`, in the `dispatchInbound` scheduler call, add `inboundAt` alongside the existing arguments:

```ts
            triggerMessageId: res.messageId,
            inboundAt: Date.now(),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test`
Expected: PASS — including both new `deliverReply` tests

- [ ] **Step 8: Commit**

```bash
git add convex/aiReply.ts convex/ingest.ts convex/aiReply.test.ts
git commit -m "feat(ai): deliver replies on a length-proportional jittered delay

Generation no longer sends inline; it schedules deliverReply after a
wait derived from the reply's length and measured from inbound arrival,
so model think time is absorbed rather than stacked."
```

---

### Task 5: Generation-latency trims

Two independent one-line wins, folded together because both target the same stage.

**Files:**
- Modify: `convex/lib/ai/defaults.ts:22`
- Modify: `convex/aiReply.ts:652-670`

**Interfaces:**
- Consumes: nothing new
- Produces: nothing new

- [ ] **Step 1: Cap output tokens**

In `convex/lib/ai/defaults.ts`, line 20-22 currently reads:

```ts
/** Cap on generated reply length — keeps WhatsApp replies short and
 *  bounds token spend on the caller's own key. */
export const MAX_OUTPUT_TOKENS = 1024;
```

Replace with:

```ts
/** Cap on generated reply length — keeps WhatsApp replies short, bounds
 *  token spend on the caller's own key, and bounds worst-case generation
 *  time (which now sits inside a customer-visible typing window).
 *  WhatsApp replies run 60-120 tokens; 320 leaves real headroom.
 *
 *  Deliberately NOT changed in `src/lib/ai/defaults.ts` — that constant
 *  serves the human-reviewed draft-reply route, which may run longer. */
export const MAX_OUTPUT_TOKENS = 320;
```

Both providers (`convex/lib/ai/providers/openai.ts:50`, `convex/lib/ai/providers/anthropic.ts:64`) read this constant and need no edit.

- [ ] **Step 2: Parallelize the two independent lookups**

In `convex/aiReply.ts`, the knowledge block (lines ~652-661) and the qualification call (lines ~667-670) run back-to-back but share no data. Replace both with a single concurrent pair:

```ts
      // Independent of each other — the knowledge lookup makes a network
      // call for embeddings, so overlapping them saves real wall-clock
      // inside a window the customer is now watching.
      const [knowledgeResult, qualification] = await Promise.all([
        (async (): Promise<string[]> => {
          const hasKb = await ctx.runQuery(internal.aiReply.hasKnowledgeChunks, {
            accountId: args.accountId,
          });
          if (!hasKb) return [];
          return await ctx.runAction(internal.aiKnowledge.retrieve, {
            accountId: args.accountId,
            queryText,
          });
        })(),
        ctx.runQuery(internal.qualificationEngine.getObjectives, {
          accountId: args.accountId,
          conversationId: args.conversationId,
        }),
      ]);
      let knowledge: string[] = knowledgeResult;
```

The existing `if (qualification?.suppressReply) return;` guard and the later `knowledge = [...knowledge, ...teamAnswers.notes]` reassignment both still work unchanged — `knowledge` remains a mutable `let`.

- [ ] **Step 3: Run the suite**

Run: `npm test`
Expected: PASS — no test asserts on `MAX_OUTPUT_TOKENS`'s value or on lookup ordering

- [ ] **Step 4: Commit**

```bash
git add convex/lib/ai/defaults.ts convex/aiReply.ts
git commit -m "perf(ai): cap auto-reply output at 320 tokens, parallelize pre-LLM lookups

Bounds worst-case generation time now that it sits inside a
customer-visible typing window."
```

---

### Task 6: Live verification

This plan changes customer-visible behaviour on a production WhatsApp number. It is not done until it has been watched on a real handset.

**Files:** none (verification only)

- [ ] **Step 1: Deploy the Convex backend**

Per repo convention, merge `origin/main` first — the backend is a separate manual deploy from Netlify.

```bash
git fetch origin && git merge origin/main
npx convex deploy
```

- [ ] **Step 2: Send a complete-shaped message from a real handset**

Send `"how much for 4 nights in Baku?"` to the production number.

Expected, watched on the handset:
- Blue ticks + "typing…" appear within ~1 second
- "typing…" stays visible continuously — it must never disappear and come back
- Reply lands roughly 5-8 seconds after sending
- Exactly one reply

- [ ] **Step 3: Send a fragmented burst**

Send `"hi"`, then ~3 seconds later `"I want a package for August"`.

Expected:
- Acknowledgement appears after the first message
- **One** reply, addressing the August package — not two replies
- This is the burst-coalescing regression check; two replies here means `FRAGMENT_MAX_LENGTH` is too low for real traffic

- [ ] **Step 4: Send a question that produces a long answer**

Ask something that draws a detailed itinerary response.

Expected:
- Reply lands no later than ~15 seconds
- "typing…" is still visible when it arrives — if it vanished first, `AI_TYPING_MAX_MS` is set too close to Meta's 25s ceiling and must come down

- [ ] **Step 5: Confirm human takeover still suppresses the bot**

Assign a live conversation to yourself from the dashboard, then message that thread from the handset.

Expected: no blue tick from the bot, no "typing…", no reply. This verifies `ackInbound`'s gates match `dispatchInbound`'s.

- [ ] **Step 6: Record the result**

If any step failed, stop and fix before merging. If all passed, note the observed timings in the PR description — they are the evidence the pacing works, and the baseline for any future tuning.

---

## Notes for whoever tunes this later

The one knob most likely to need adjusting from real traffic is `FRAGMENT_MAX_LENGTH` (15 chars). It decides which messages get the patient 6s window. If customers routinely write longer fragments — `"what packages do you have"` at 25 chars would currently take the 3s middle path — raise it. Symptom to watch for: two replies to what was clearly one thought.

`AI_TYPING_CHARS_PER_SEC` (18) is a *perceived* typing speed for a fast business agent, not a real one. Real mobile typing is ~3.3 chars/sec, which would put a 150-character reply at 45 seconds — well past Meta's ceiling and far past a customer's patience. Do not "correct" it toward realism.
