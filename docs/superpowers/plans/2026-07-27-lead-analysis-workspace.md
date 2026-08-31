# Lead Analysis Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the conversation on the same screen as its lead score — a split-pane workspace on `/lead-analysis` with the scored queue on the left and the inbox's own `MessageThread` on the right, so working the queue never leaves the page.

**Architecture:** The right pane renders the *existing* `MessageThread` component unmodified, fed by its own `api.conversations.get` call keyed on a `selectedConversationId` held by the page. The board query keeps its shape but stops doing two of its four per-row reads, via two optional denormalised fields that every reader falls back from when absent.

**Tech Stack:** Next.js (App Router, `src/app/(dashboard)/`), Convex (self-hosted), React 19, Tailwind, next-intl, vitest + convex-test.

## Global Constraints

- **Branch from `origin/main`.** Work on `feat/lead-analysis-workspace`, which already exists and holds the design doc one commit off `main`. `feat/media-understanding` has a diverged, older copy of this feature — do not branch from it.
- **Never run `npx convex dev`, `convex deploy`, or `convex codegen`.** Convex here is a single self-hosted *production* instance; all three push straight to it. The owner runs deploys.
- **Do not create new files under `convex/`.** A brand-new Convex module must be registered in the generated `convex/_generated/api.d.ts`, which only `convex deploy` writes. Every backend change in this plan goes into an existing module. New *exports* in existing modules are fine.
- **Stage git paths explicitly.** Never `git add -A` or `git add .` — other Claude sessions share this working tree and routinely hold uncommitted work in it.
- **Lint is scoped, not global.** Gate with `npx eslint <changed-file>`; `npm run lint` surfaces pre-existing repo-wide debt that is not yours.
- **There is no jsdom and no Testing Library.** `src/**` tests run in plain `node` and assert on `renderToStaticMarkup` output. Clicks, typing, and select changes cannot be simulated — behaviour that needs testing goes in a pure function.
- **Both new schema fields are `v.optional(...)`** so existing documents still validate on deploy.
- Verify with `npm test`, `npm run typecheck`, `npm run build`.

---

### Task 1: Schema — two optional denormalised fields

**Files:**
- Modify: `convex/schema.ts` (conversations table, after `lastMessageAt`; leadAnalyses table, after `signals`)

**Interfaces:**
- Consumes: nothing.
- Produces: `conversations.lastMessageSenderType?: "customer" | "agent" | "bot"` and `leadAnalyses.serviceName?: string`, both read by Tasks 3 and 5.

- [ ] **Step 1: Add the field to `conversations`**

In `convex/schema.ts`, immediately after the `lastMessageAt: v.optional(v.number()),` line in the `conversations` table:

```ts
    // Denormalised sender type of the message that set `lastMessageText`
    // and `lastMessageAt` above — written in the same patch, in the
    // backend's single `insert("messages")` site, so it cannot drift.
    //
    // Read ONLY by `leadAnalysis.board`, to spare it a per-row `messages`
    // query for the lane badge. `undefined` means "not backfilled yet",
    // and every reader MUST fall back to the real query rather than
    // assume a value: `leadLane` turns this into an automation-relevant
    // verdict (`convex/lib/leadAnalysis/priority.ts` — "a customer
    // waiting on US is never sequenced and never archived"), so a guess
    // here could authorise a send. The sequence engine deliberately does
    // NOT read this field; it keeps deriving eligibility from real
    // message rows.
    lastMessageSenderType: v.optional(
      v.union(v.literal("customer"), v.literal("agent"), v.literal("bot")),
    ),
```

- [ ] **Step 2: Add the field to `leadAnalyses`**

In the same file, in the `leadAnalyses` table, immediately after `signals: v.optional(v.array(v.string())),`:

```ts
    // Denormalised copy of the conversation's newest
    // `qualificationSessions.serviceName` as of the last score, so the
    // board doesn't run a per-row session query. DISPLAY ONLY — nothing
    // branches on it. `undefined` means "not cached yet" and the board
    // falls back to the real query, so rows scored before this field
    // existed keep rendering their service name.
    serviceName: v.optional(v.string()),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. No existing code reads either field yet, so nothing else changes.

- [ ] **Step 4: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(lead-analysis): add denormalised lastMessageSenderType and serviceName fields"
```

---

### Task 2: Write `lastMessageSenderType` on every message insert

**Files:**
- Modify: `convex/messages.ts` (the `patch` object inside `insertMessageAndUpdateConversation`, around line 231-238)
- Test: `convex/messages.test.ts`

**Interfaces:**
- Consumes: `conversations.lastMessageSenderType` from Task 1.
- Produces: the field is populated for every message written from now on. Task 3 reads it; Task 4 backfills history.

- [ ] **Step 1: Write the failing test**

Append to `convex/messages.test.ts`:

```ts
test("insertMessageAndUpdateConversation denormalises the last sender type", async () => {
  const t = convexTest(schema, modules);

  const { accountId, conversationId } = await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      name: "Acct", defaultCurrency: "AED",
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000001",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    return { accountId, contactId, conversationId };
  });

  for (const senderType of ["customer", "agent", "bot"] as const) {
    await t.run(async (ctx) => {
      const conversation = (await ctx.db.get(conversationId))!;
      await insertMessageAndUpdateConversation(
        ctx,
        {
          accountId,
          conversationId,
          senderType,
          contentType: "text",
          contentText: `hello from ${senderType}`,
        },
        conversation,
      );
    });

    const conversation = await t.run((ctx) => ctx.db.get(conversationId));
    expect(conversation?.lastMessageSenderType).toBe(senderType);
    expect(conversation?.lastMessageText).toBe(`hello from ${senderType}`);
  }
});
```

Add `insertMessageAndUpdateConversation` to the existing import from `./messages` at the top of that test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/messages.test.ts -t "denormalises the last sender type"`
Expected: FAIL — `expected undefined to be "customer"`.

- [ ] **Step 3: Write the implementation**

In `convex/messages.ts`, in `insertMessageAndUpdateConversation`, extend both the `patch` type and its initialiser:

```ts
  const patch: Partial<{
    lastMessageText: string;
    lastMessageAt: number;
    lastMessageSenderType: "customer" | "agent" | "bot";
    updatedAt: number;
    unreadCount: number;
    lastInboundAt: number;
    firstReplyAt: number;
  }> = {
    lastMessageText: contentText ?? `[${contentType}]`,
    lastMessageAt: now,
    // Denormalised for `leadAnalysis.board`'s lane badge — same patch as
    // the other preview fields above, for the same reason: this is the
    // single insert site, so the copy cannot drift from the raw rows.
    lastMessageSenderType: senderType,
    updatedAt: now,
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/messages.test.ts -t "denormalises the last sender type"`
Expected: PASS

- [ ] **Step 5: Run the full message and conversation suites**

Run: `npx vitest run convex/messages.test.ts convex/conversations.test.ts`
Expected: PASS — the new field is additive and nothing asserts on exact conversation shape.

- [ ] **Step 6: Commit**

```bash
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(lead-analysis): denormalise last message sender type onto conversations"
```

---

### Task 3: Board reads the denormalised sender type, with a conservative fallback

**Files:**
- Modify: `convex/leadAnalysis.ts` (the `for (const row of rows)` loop in `board`)
- Test: `convex/leadAnalysis.test.ts`

**Interfaces:**
- Consumes: `conversations.lastMessageSenderType` (Tasks 1-2).
- Produces: no API change. `board`'s return shape is byte-identical; only its read count changes.

- [ ] **Step 1: Write the failing tests**

Append to `convex/leadAnalysis.test.ts`. These assert the *fallback contract*, which is the whole safety argument — do not skip the second one.

```ts
test("board uses the denormalised sender type when present", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });

  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000002", name: "Asha",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      lastMessageAt: Date.now(),
      // Field says "bot" and there is NO messages row at all. Today's
      // code passes `null` to `leadLane`, which yields "awaiting_us", so
      // this fails until the field is actually read — the assertion is
      // deliberately the value the fallback could never produce.
      lastMessageSenderType: "bot",
    });
    await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored", score: 8, band: "hot",
      attempts: 0, sequenceStatus: "idle", followUpsSent: 0,
    });
  });

  const board = await asUser.query(api.leadAnalysis.board, { view: "active" });
  expect(board.leads).toHaveLength(1);
  expect(board.leads[0]!.lane).toBe("awaiting_them");
});

test("board falls back to the messages query when the field is absent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });

  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000003", name: "Budi",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      lastMessageAt: Date.now(),
      // Field deliberately absent — the pre-backfill state.
    });
    await ctx.db.insert("messages", {
      accountId, conversationId, senderType: "customer",
      contentType: "text", contentText: "still waiting", status: "sent",
    });
    await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored", score: 5, band: "warm",
      attempts: 0, sequenceStatus: "idle", followUpsSent: 0,
    });
  });

  const board = await asUser.query(api.leadAnalysis.board, { view: "active" });
  expect(board.leads).toHaveLength(1);
  // Absent must never be coerced to a sender type: the real row says
  // "customer", so the lane is the one automation may not act on.
  expect(board.leads[0]!.lane).toBe("awaiting_us");
});

test("board leaves an empty thread in the conservative lane", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });

  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000004",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored", score: 3, band: "cold",
      attempts: 0, sequenceStatus: "idle", followUpsSent: 0,
    });
  });

  const board = await asUser.query(api.leadAnalysis.board, { view: "active" });
  expect(board.leads[0]!.lane).toBe("awaiting_us");
});
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `npx vitest run convex/leadAnalysis.test.ts -t "board uses the denormalised"`
Expected: FAIL — `expected 'awaiting_us' to be 'awaiting_them'`.

The other two tests pass before the change and must keep passing after it: they pin the fallback, so a green-to-green transition is exactly the point. Only the first is red-to-green.

- [ ] **Step 3: Write the implementation**

In `convex/leadAnalysis.ts`, replace the unconditional `lastMessage` query inside the loop:

```ts
      // Denormalised lane source. `undefined` means "not backfilled
      // yet" and MUST fall back to the real row rather than default —
      // `leadLane` is the primitive that decides what automation may
      // touch (`lib/leadAnalysis/priority.ts`), so a guess here is a
      // safety bug, not a cosmetic one. Once the backfill has run this
      // branch is cold and the board does two point-gets per row
      // instead of four reads.
      const lastSenderType =
        conversation.lastMessageSenderType ??
        (
          await ctx.db
            .query("messages")
            .withIndex("by_conversation", (q) =>
              q.eq("conversationId", row.conversationId),
            )
            .order("desc")
            .first()
        )?.senderType ??
        null;
```

Then change the `lane` property in the pushed object from
`lane: leadLane(lastMessage?.senderType ?? null),` to:

```ts
        lane: leadLane(lastSenderType),
```

Delete the now-unused `lastMessage` query.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: PASS, all three new tests plus every pre-existing board test.

- [ ] **Step 5: Lint and typecheck**

Run: `npx eslint convex/leadAnalysis.ts && npm run typecheck`
Expected: no new warnings, typecheck PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/leadAnalysis.ts convex/leadAnalysis.test.ts
git commit -m "perf(lead-analysis): read the denormalised sender type, falling back when absent"
```

---

### Task 4: Backfill `lastMessageSenderType` for existing conversations

**Files:**
- Modify: `convex/messages.ts` (new export, alongside `backfillMessageHourlyStats`)
- Test: `convex/messages.test.ts`

**Interfaces:**
- Consumes: `conversations.lastMessageSenderType` (Task 1).
- Produces: `internal.messages.backfillLastMessageSenderType({ cursorMs?: number })` — self-scheduling, idempotent, resumable. Nothing else calls it; the owner triggers it once after deploy.

This follows the existing `backfillMessageHourlyStats` pattern in the same file: a bounded batch, a cursor threaded through `ctx.scheduler.runAfter(0, …)`, and a stop when the batch comes back empty.

- [ ] **Step 1: Write the failing test**

Append to `convex/messages.test.ts`:

```ts
test("backfillLastMessageSenderType fills only conversations missing the field", async () => {
  const t = convexTest(schema, modules);

  const ids = await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      name: "Acct", defaultCurrency: "AED",
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000005",
    });

    // (a) missing the field, has messages → filled from the newest row
    const missing = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    await ctx.db.insert("messages", {
      accountId, conversationId: missing, senderType: "customer",
      contentType: "text", contentText: "first", status: "sent",
    });
    await ctx.db.insert("messages", {
      accountId, conversationId: missing, senderType: "bot",
      contentType: "text", contentText: "newest", status: "sent",
    });

    // (b) already set → left alone even though messages disagree
    const preset = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      lastMessageSenderType: "agent",
    });
    await ctx.db.insert("messages", {
      accountId, conversationId: preset, senderType: "customer",
      contentType: "text", contentText: "ignored", status: "sent",
    });

    // (c) no messages at all → stays undefined, never guessed
    const empty = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });

    return { missing, preset, empty };
  });

  await t.mutation(internal.messages.backfillLastMessageSenderType, {});

  const after = await t.run(async (ctx) => ({
    missing: (await ctx.db.get(ids.missing))?.lastMessageSenderType,
    preset: (await ctx.db.get(ids.preset))?.lastMessageSenderType,
    empty: (await ctx.db.get(ids.empty))?.lastMessageSenderType,
  }));

  expect(after.missing).toBe("bot");
  expect(after.preset).toBe("agent");
  expect(after.empty).toBeUndefined();

  // Idempotent: a second pass changes nothing.
  await t.mutation(internal.messages.backfillLastMessageSenderType, {});
  const again = await t.run(async (ctx) => ({
    missing: (await ctx.db.get(ids.missing))?.lastMessageSenderType,
    empty: (await ctx.db.get(ids.empty))?.lastMessageSenderType,
  }));
  expect(again.missing).toBe("bot");
  expect(again.empty).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/messages.test.ts -t "backfillLastMessageSenderType"`
Expected: FAIL — the function does not exist on `internal.messages`.

- [ ] **Step 3: Write the implementation**

Add to `convex/messages.ts`, near `backfillMessageHourlyStats`:

```ts
/** Conversations touched per backfill batch. Small enough to stay well
 *  inside a mutation's transaction budget, since each row costs one
 *  index read on `messages` plus at most one patch. */
const SENDER_TYPE_BACKFILL_BATCH = 100;

/**
 * One-off backfill for `conversations.lastMessageSenderType`, added with
 * the field itself so `leadAnalysis.board`'s fallback branch can go cold.
 *
 * Self-scheduling over `_creationTime`, same shape as
 * `backfillMessageHourlyStats` above. Idempotent by construction: a
 * conversation that already has the field is skipped, so a re-run (or a
 * resume after a crash) cannot overwrite a value that live traffic has
 * since written.
 *
 * A conversation with NO messages is deliberately left `undefined`
 * rather than given a default — `leadLane` treats absent as
 * "awaiting us", the lane automation may not act on, and inventing a
 * value here would silently move it out of that protection.
 */
export const backfillLastMessageSenderType = internalMutation({
  args: { cursorMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const batch = await ctx.db
      .query("conversations")
      .withIndex("by_creation_time", (q) =>
        args.cursorMs === undefined ? q : q.gt("_creationTime", args.cursorMs),
      )
      .take(SENDER_TYPE_BACKFILL_BATCH);

    if (batch.length === 0) return;

    for (const conversation of batch) {
      if (conversation.lastMessageSenderType !== undefined) continue;

      const newest = await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) =>
          q.eq("conversationId", conversation._id),
        )
        .order("desc")
        .first();
      if (!newest) continue;

      await ctx.db.patch(conversation._id, {
        lastMessageSenderType: newest.senderType,
      });
    }

    await ctx.scheduler.runAfter(0, internal.messages.backfillLastMessageSenderType, {
      cursorMs: batch[batch.length - 1]!._creationTime,
    });
  },
});
```

`by_creation_time` is a system index Convex defines on every table, so this needs no schema change and no new index — which matters, because adding one would require a deploy.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/messages.test.ts -t "backfillLastMessageSenderType"`
Expected: PASS

- [ ] **Step 5: Lint and typecheck**

Run: `npx eslint convex/messages.ts && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(lead-analysis): backfill lastMessageSenderType for existing conversations"
```

---

### Task 5: Cache `serviceName` at score time

**Files:**
- Modify: `convex/leadAnalysisEngine.ts` (`applyScore`)
- Modify: `convex/leadAnalysis.ts` (the session query in `board`)
- Test: `convex/leadAnalysisEngine.test.ts`, `convex/leadAnalysis.test.ts`

**Interfaces:**
- Consumes: `leadAnalyses.serviceName` (Task 1).
- Produces: no API change. `board`'s `serviceName` field keeps its current meaning and nullability.

- [ ] **Step 1: Write the failing test**

Append to `convex/leadAnalysisEngine.test.ts`:

```ts
test("applyScore caches the conversation's service name", async () => {
  const t = convexTest(schema, modules);

  const analysisId = await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      name: "Acct", defaultCurrency: "AED",
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000006",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    await ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId,
      status: "collecting", origin: "inbound", fields: [],
      expectedCount: 0, answeredCount: 0, followUpsSent: 0,
      phrasingCursor: 0, sendAttemptErrors: 0,
      serviceName: "UAE Tourist Visa",
    });
    return await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "pending", attempts: 0,
      sequenceStatus: "idle", followUpsSent: 0,
    });
  });

  await t.mutation(internal.leadAnalysisEngine.applyScore, {
    analysisId, score: 7, reason: "Gave dates", signals: [],
    model: "test", throughMs: Date.now(),
  });

  const row = await t.run((ctx) => ctx.db.get(analysisId));
  expect(row?.serviceName).toBe("UAE Tourist Visa");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts -t "caches the conversation's service name"`
Expected: FAIL — `expected undefined to be "UAE Tourist Visa"`.

- [ ] **Step 3: Write the implementation**

In `convex/leadAnalysisEngine.ts`, inside `applyScore`, after `const bands = …` and before the patch:

```ts
    // Cache the service name alongside the verdict so the board doesn't
    // run a per-row `qualificationSessions` query. DISPLAY ONLY —
    // nothing branches on it — and refreshed on every re-score, so it
    // tracks the session rather than freezing at first score.
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
      .order("desc")
      .first();
```

and add to the patch object:

```ts
      serviceName: session?.serviceName ?? undefined,
```

- [ ] **Step 4: Add the board's fallback**

In `convex/leadAnalysis.ts`, replace the unconditional session query in the loop with:

```ts
      // Cached at score time by `applyScore`; absent on rows scored
      // before the field existed, which fall back to the real session
      // query so their service name doesn't blank out.
      const serviceName =
        row.serviceName ??
        (
          await ctx.db
            .query("qualificationSessions")
            .withIndex("by_conversation", (q) =>
              q.eq("conversationId", row.conversationId),
            )
            .order("desc")
            .first()
        )?.serviceName ??
        null;
```

and change the pushed property from `serviceName: session?.serviceName ?? null,` to `serviceName,`. Delete the now-unused `session` query.

- [ ] **Step 5: Add the board fallback test**

Append to `convex/leadAnalysis.test.ts`:

```ts
test("board falls back to the session for a row with no cached service name", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });

  await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000007",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      lastMessageSenderType: "bot", lastMessageAt: Date.now(),
    });
    await ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId,
      status: "collecting", origin: "inbound", fields: [],
      expectedCount: 0, answeredCount: 0, followUpsSent: 0,
      phrasingCursor: 0, sendAttemptErrors: 0,
      serviceName: "Freelance Visa",
    });
    await ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored", score: 6, band: "warm",
      attempts: 0, sequenceStatus: "idle", followUpsSent: 0,
      // serviceName deliberately absent
    });
  });

  const board = await asUser.query(api.leadAnalysis.board, { view: "active" });
  expect(board.leads[0]!.serviceName).toBe("Freelance Visa");
});
```

- [ ] **Step 6: Run both suites**

Run: `npx vitest run convex/leadAnalysis.test.ts convex/leadAnalysisEngine.test.ts`
Expected: PASS

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npx eslint convex/leadAnalysis.ts convex/leadAnalysisEngine.ts && npm run typecheck
git add convex/leadAnalysis.ts convex/leadAnalysisEngine.ts convex/leadAnalysis.test.ts convex/leadAnalysisEngine.test.ts
git commit -m "perf(lead-analysis): cache serviceName at score time and fall back when absent"
```

---

### Task 6: Pure selection module

**Files:**
- Create: `src/components/lead-analysis/lead-analysis-selection.ts`
- Test: `src/components/lead-analysis/lead-analysis-selection.test.ts`

**Interfaces:**
- Consumes: `LeadAnalysisRow` from `./lead-analysis-list` (Task 7). To avoid an ordering dependency, this module takes a **structural minimum** instead: `{ conversationId: string }`.
- Produces: `nextSelectionAfterArchive(rows: readonly { conversationId: string }[], archivedConversationId: string, selectedConversationId: string | null): string | null` — used by Task 9's page container.

- [ ] **Step 1: Write the failing test**

Create `src/components/lead-analysis/lead-analysis-selection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { nextSelectionAfterArchive } from './lead-analysis-selection';

const rows = (...ids: string[]) => ids.map((conversationId) => ({ conversationId }));

describe('nextSelectionAfterArchive', () => {
  it('advances to the following row when the selected lead is archived', () => {
    expect(nextSelectionAfterArchive(rows('a', 'b', 'c'), 'b', 'b')).toBe('c');
  });

  it('falls back to the previous row when the last row is archived', () => {
    expect(nextSelectionAfterArchive(rows('a', 'b', 'c'), 'c', 'c')).toBe('b');
  });

  it('clears selection when the only row is archived', () => {
    expect(nextSelectionAfterArchive(rows('a'), 'a', 'a')).toBeNull();
  });

  it('leaves selection untouched when a different row is archived', () => {
    expect(nextSelectionAfterArchive(rows('a', 'b', 'c'), 'a', 'b')).toBe('b');
  });

  it('leaves selection untouched when nothing is selected', () => {
    expect(nextSelectionAfterArchive(rows('a', 'b'), 'a', null)).toBeNull();
  });

  it('clears selection when the archived row is not in the list', () => {
    expect(nextSelectionAfterArchive(rows('a', 'b'), 'z', 'z')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/lead-analysis/lead-analysis-selection.test.ts`
Expected: FAIL — cannot resolve `./lead-analysis-selection`.

- [ ] **Step 3: Write the implementation**

Create `src/components/lead-analysis/lead-analysis-selection.ts`:

```ts
// ============================================================
// Selection arithmetic for the Lead Analysis workspace — pure, so it
// can be tested in a repo with no jsdom (component tests here assert on
// static markup and cannot simulate a click).
//
// Takes the structural minimum `{ conversationId }` rather than the full
// `LeadAnalysisRow`, so the list component can evolve without dragging
// this module along.
// ============================================================

/**
 * Where selection lands after a lead is archived.
 *
 * Called with the filtered, sorted rows AS THEY STOOD AT CLICK TIME —
 * not after the reactive update lands. The board is a live query and
 * archiving re-sorts it; choosing from the post-update list would race
 * that re-sort and land somewhere arbitrary.
 *
 * Archiving a lead that isn't the selected one never moves selection.
 */
export function nextSelectionAfterArchive(
  rows: readonly { conversationId: string }[],
  archivedConversationId: string,
  selectedConversationId: string | null,
): string | null {
  if (selectedConversationId === null) return null;
  if (archivedConversationId !== selectedConversationId) {
    return selectedConversationId;
  }

  const index = rows.findIndex((r) => r.conversationId === archivedConversationId);
  // Archived row already gone from the list (a concurrent update, or a
  // filter that excludes it) — there is no meaningful neighbour to pick.
  if (index === -1) return null;

  const next = rows[index + 1] ?? rows[index - 1] ?? null;
  return next?.conversationId ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/lead-analysis/lead-analysis-selection.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/lead-analysis/lead-analysis-selection.ts src/components/lead-analysis/lead-analysis-selection.test.ts
git commit -m "feat(lead-analysis): add pure selection arithmetic for archive auto-advance"
```

---

### Task 7: Split the board into filter, summary, and list modules

**Files:**
- Create: `src/components/lead-analysis/lead-analysis-filter.ts`
- Create: `src/components/lead-analysis/lead-analysis-summary.tsx`
- Create: `src/components/lead-analysis/lead-analysis-list.tsx`
- Delete: `src/components/lead-analysis/lead-analysis-board.tsx`
- Rename: `lead-analysis-board.test.tsx` → `lead-analysis-list.test.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `lead-analysis-filter.ts`: `filterLeadRows(leads, filters)`, types `LeadBandKey`, `LeadLaneKey`, `LeadAnalysisFilters`, `LeadAnalysisRow`, `LeadAnalysisView`, `LeadAnalysisBoardData`.
  - `lead-analysis-summary.tsx`: `<LeadAnalysisSummary board view onViewChange filters onFiltersChange />`.
  - `lead-analysis-list.tsx`: `<LeadAnalysisList leads selectedConversationId onSelect canReanalyze onReanalyze canArchive onArchive onRestore />`.

This task is a pure refactor plus the narrow-row redesign. It must not change what the page renders semantically — Task 9 does the layout.

- [ ] **Step 1: Add the two new i18n keys**

In `messages/en.json`, inside `LeadAnalysis`, add alongside the existing keys:

```json
  "selectLead": "Select a lead to open its conversation.",
  "back": "Back to leads",
```

- [ ] **Step 2: Create the filter module**

Create `src/components/lead-analysis/lead-analysis-filter.ts` and move into it, verbatim, from `lead-analysis-board.tsx`: `LeadBandKey`, `LeadLaneKey`, `LeadAnalysisRow`, `LeadAnalysisView`, `LeadAnalysisBoardData`, `LeadAnalysisFilters`, and `filterLeadRows`. Add the module header:

```ts
// ============================================================
// Row types and the client-side filter predicate for the Lead Analysis
// workspace. Standalone because this repo has no jsdom: component tests
// assert on static markup and cannot simulate a select change or a
// keystroke, so the predicate is unit-tested directly instead.
// ============================================================
```

- [ ] **Step 3: Create the summary component**

Create `src/components/lead-analysis/lead-analysis-summary.tsx` holding the title, the Active/Archived pills, the `<dl>` of tiles, the three filter controls, and the local `Tile` helper — all moved verbatim from `lead-analysis-board.tsx`, with two changes:

1. Filter state is **lifted**: the component takes `filters: LeadAnalysisFilters` and `onFiltersChange: (next: LeadAnalysisFilters) => void` instead of owning three `useState`s. The page needs the filtered list for auto-advance, so the filter values have to live above both panes.
2. The tiles grid becomes one compact row to buy vertical space for the thread:
   `className="grid grid-cols-3 gap-2 sm:grid-cols-6"` and each `Tile` uses `p-2`, `text-xs` label, `text-base font-semibold` value.

Keep every existing `data-testid` (`view-toggle-active`, `view-toggle-archived`, `tile-hot`, `tile-awaitingUs`) — existing tests assert on them.

- [ ] **Step 4: Create the list component**

Create `src/components/lead-analysis/lead-analysis-list.tsx`. Rows become narrow and selectable; the `Open chat` `<Link>` is **removed** (selection replaces navigation):

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { RotateCw, Archive as ArchiveIcon, ArchiveRestore } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { LeadAnalysisRow, LeadBandKey } from './lead-analysis-filter';

// ============================================================
// The Lead Analysis queue — PRESENTATIONAL ONLY, so it can be rendered
// with mock data and asserted on as static markup (this repo has no
// jsdom). Rows carry signal only; the actions are icon buttons revealed
// on hover/focus so a narrow column still supports triage without
// opening a lead — dismissing an obvious dud shouldn't cost an open,
// which would also mark it read.
// ============================================================

const BAND_CLASS: Record<LeadBandKey, string> = {
  hot: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  warm: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  cold: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

export function LeadAnalysisList({
  leads,
  selectedConversationId,
  onSelect,
  canReanalyze,
  onReanalyze,
  canArchive,
  onArchive,
  onRestore,
}: {
  leads: LeadAnalysisRow[];
  selectedConversationId: string | null;
  onSelect: (lead: LeadAnalysisRow) => void;
  canReanalyze: boolean;
  onReanalyze: (lead: LeadAnalysisRow) => void;
  canArchive: boolean;
  onArchive: (lead: LeadAnalysisRow) => void;
  onRestore: (lead: LeadAnalysisRow) => void;
}) {
  const t = useTranslations('LeadAnalysis');

  if (leads.length === 0) {
    return <p className="text-muted-foreground p-4 text-sm">{t('empty')}</p>;
  }

  return (
    <ul className="divide-y">
      {leads.map((lead) => {
        const selected = lead.conversationId === selectedConversationId;
        return (
          <li
            key={lead.analysisId}
            data-testid="lead-row"
            aria-current={selected ? 'true' : undefined}
            className={cn(
              'group hover:bg-muted/50 flex cursor-pointer items-start gap-2 px-3 py-2.5',
              selected && 'bg-muted'
            )}
            onClick={() => onSelect(lead)}
          >
            <span
              data-testid="lead-score"
              className={cn(
                'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                lead.band ? BAND_CLASS[lead.band] : 'bg-muted text-muted-foreground'
              )}
              title={lead.reason ?? undefined}
            >
              {lead.score ?? '–'}
            </span>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{lead.contactName}</p>
              <p
                data-testid="lead-reason"
                className="text-muted-foreground line-clamp-2 text-xs"
              >
                {lead.reason ?? t('row.unscored')}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="text-[10px]">
                  {t(`lane.${lead.lane}` as never)}
                </Badge>
                {lead.returnedAt !== null && (
                  <Badge data-testid="row-returned-badge" variant="outline" className="text-[10px]">
                    {t('row.returned')}
                  </Badge>
                )}
                <span className="text-muted-foreground text-[10px]">
                  {lead.daysSinceLastMessage && lead.daysSinceLastMessage > 0
                    ? t('row.daysSilent', { days: lead.daysSinceLastMessage })
                    : t('row.today')}
                </span>
              </div>
            </div>

            {/* Actions stop propagation so acting on a row never also
                opens it — archiving an obvious dud must not mark it
                read on the way past. */}
            <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              {canReanalyze && (
                <button
                  type="button"
                  data-testid="row-reanalyze-action"
                  title={t('row.reanalyze')}
                  aria-label={t('row.reanalyze')}
                  className="hover:bg-background rounded-md p-1.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    onReanalyze(lead);
                  }}
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </button>
              )}
              {canArchive && (
                <button
                  type="button"
                  data-testid="row-archive-action"
                  title={lead.archived ? t('row.restore') : t('row.archive')}
                  aria-label={lead.archived ? t('row.restore') : t('row.archive')}
                  className="hover:bg-background rounded-md p-1.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (lead.archived) onRestore(lead);
                    else onArchive(lead);
                  }}
                >
                  {lead.archived ? (
                    <ArchiveRestore className="h-3.5 w-3.5" />
                  ) : (
                    <ArchiveIcon className="h-3.5 w-3.5" />
                  )}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 5: Move and update the tests**

`git mv src/components/lead-analysis/lead-analysis-board.test.tsx src/components/lead-analysis/lead-analysis-list.test.tsx`, then update it:

- Import `filterLeadRows` and the types from `./lead-analysis-filter`, `LeadAnalysisList` from `./lead-analysis-list`, `LeadAnalysisSummary` from `./lead-analysis-summary`.
- Keep every existing `filterLeadRows` test unchanged — the move is mechanical and must not alter behaviour.
- Split the existing render assertions: tile/view-toggle assertions now render `<LeadAnalysisSummary>`, row assertions render `<LeadAnalysisList>`.
- Add these three:

```tsx
it('marks the selected row with aria-current', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <LeadAnalysisList
        leads={[lead({ conversationId: 'c1' }), lead({ analysisId: 'a2', conversationId: 'c2' })]}
        selectedConversationId="c2"
        onSelect={vi.fn()}
        canReanalyze
        onReanalyze={vi.fn()}
        canArchive
        onArchive={vi.fn()}
        onRestore={vi.fn()}
      />
    </NextIntlClientProvider>
  );
  expect(html.match(/aria-current="true"/g)).toHaveLength(1);
});

it('hides row actions from a user who cannot act', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <LeadAnalysisList
        leads={[lead()]}
        selectedConversationId={null}
        onSelect={vi.fn()}
        canReanalyze={false}
        onReanalyze={vi.fn()}
        canArchive={false}
        onArchive={vi.fn()}
        onRestore={vi.fn()}
      />
    </NextIntlClientProvider>
  );
  expect(html).not.toContain('row-archive-action');
  expect(html).not.toContain('row-reanalyze-action');
});

it('offers restore rather than archive on an archived lead', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <LeadAnalysisList
        leads={[lead({ archived: true })]}
        selectedConversationId={null}
        onSelect={vi.fn()}
        canReanalyze
        onReanalyze={vi.fn()}
        canArchive
        onArchive={vi.fn()}
        onRestore={vi.fn()}
      />
    </NextIntlClientProvider>
  );
  expect(html).toContain(messages.LeadAnalysis.row.restore);
});
```

- [ ] **Step 6: Delete the old component**

```bash
git rm src/components/lead-analysis/lead-analysis-board.tsx
```

The page still imports it — typecheck will fail until Task 9. That is expected; do **not** patch the page here, and do not commit until Step 7 confirms the tests pass on their own.

- [ ] **Step 7: Run the component tests**

Run: `npx vitest run src/components/lead-analysis/`
Expected: PASS. `npm run typecheck` will still fail on `page.tsx`'s stale import — that is Task 9's job.

- [ ] **Step 8: Commit**

```bash
# `git mv` and `git rm` in Steps 5-6 already staged the rename and the
# deletion; only the new files and the i18n edit are left to add.
git add src/components/lead-analysis/lead-analysis-filter.ts src/components/lead-analysis/lead-analysis-summary.tsx src/components/lead-analysis/lead-analysis-list.tsx src/components/lead-analysis/lead-analysis-list.test.tsx messages/en.json
git commit -m "refactor(lead-analysis): split the board into filter, summary and list modules"
```

---

### Task 8: Extract the conversation-fetch error boundary

**Files:**
- Create: `src/components/inbox/conversation-fetch-boundary.tsx`
- Modify: `src/app/(dashboard)/inbox/page.tsx` (remove the local class, import the shared one)

**Interfaces:**
- Consumes: nothing.
- Produces: `<ConversationFetchBoundary>{children}</ConversationFetchBoundary>` — a class error boundary rendering `null` on catch. Task 9 wraps the right pane's fetcher in it.

- [ ] **Step 1: Create the shared boundary**

Create `src/components/inbox/conversation-fetch-boundary.tsx`, moving the `DeepLinkFallbackBoundary` class out of the inbox page verbatim and renaming it. Preserve its existing doc comment — it explains why a class boundary rather than `try`/`catch` (a `try` around the hook trips `rules-of-hooks`) — and add:

```tsx
/**
 * Shared by the Inbox's deep-link fallback and the Lead Analysis
 * workspace's right pane. Both render a component whose only job is a
 * `conversations.get` that can throw at render time: `NOT_FOUND` for an
 * id that doesn't exist, belongs to another account, or sits outside the
 * caller's role scope, and an argument-validator throw for a malformed
 * id. Both cases mean the same thing to the UI — there is no
 * conversation to show — so the boundary renders `null` and each caller
 * falls back to the empty state it already has.
 *
 * ALWAYS key this by the conversation id at the call site. Without a
 * key the instance (and its `hasError` state) survives an id change, so
 * one bad id silently disables every fetch that follows it.
 */
```

- [ ] **Step 2: Point the inbox at it**

In `src/app/(dashboard)/inbox/page.tsx`: delete the local `DeepLinkFallbackBoundary` class, add
`import { ConversationFetchBoundary } from '@/components/inbox/conversation-fetch-boundary';`
and rename the single JSX usage. Leave `DeepLinkFallbackFetcher` where it is — it is inbox-specific.

- [ ] **Step 3: Verify the inbox is unchanged**

Run: `npx vitest run src/ && npm run typecheck`
Expected: PASS. This step is a pure move; if any inbox test changes behaviour, the move was not verbatim.

- [ ] **Step 4: Lint and commit**

```bash
npx eslint src/components/inbox/conversation-fetch-boundary.tsx "src/app/(dashboard)/inbox/page.tsx"
git add src/components/inbox/conversation-fetch-boundary.tsx "src/app/(dashboard)/inbox/page.tsx"
git commit -m "refactor(inbox): extract the conversation-fetch error boundary for reuse"
```

---

### Task 9: The split-pane page container

**Files:**
- Modify: `src/app/(dashboard)/lead-analysis/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: `nextSelectionAfterArchive` (Task 6); `filterLeadRows`, `LeadAnalysisRow`, `LeadAnalysisFilters`, `LeadAnalysisView` (Task 7); `LeadAnalysisSummary`, `LeadAnalysisList` (Task 7); `ConversationFetchBoundary` (Task 8); `MessageThread`, `ContactPanelDrawer`, `toUiConversation` (existing).
- Produces: the finished route. Nothing consumes it.

- [ ] **Step 1: Write the page**

Replace `src/app/(dashboard)/lead-analysis/page.tsx` entirely. Keep the existing `canView` / `canArchive` role logic and all four mutation handlers with their current toasts; the new parts are selection, the `?c=` sync, the right pane, and auto-advance.

Structure, in order:

```tsx
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';

import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { toUiConversation } from '@/lib/convex/adapters';
import { MessageThread } from '@/components/inbox/message-thread';
import { ContactPanelDrawer } from '@/components/inbox/contact-panel-drawer';
import { ConversationFetchBoundary } from '@/components/inbox/conversation-fetch-boundary';
import { LeadAnalysisSummary } from '@/components/lead-analysis/lead-analysis-summary';
import { LeadAnalysisList } from '@/components/lead-analysis/lead-analysis-list';
import { filterLeadRows, type LeadAnalysisFilters, type LeadAnalysisRow, type LeadAnalysisView }
  from '@/components/lead-analysis/lead-analysis-filter';
import { nextSelectionAfterArchive } from '@/components/lead-analysis/lead-analysis-selection';

import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
```

Then, inside the component:

1. **Selection state seeded from the URL**, so a shared link opens the right lead:

```tsx
  const searchParams = useSearchParams();
  const router = useRouter();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(
    () => searchParams.get('c'),
  );

  // Mirror selection into `?c=` so the open lead survives a reload and a
  // shared link lands on it. `replace`, not `push`: stepping through a
  // queue must not fill the back stack with one entry per lead.
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (selectedConversationId) params.set('c', selectedConversationId);
    else params.delete('c');
    router.replace(`/lead-analysis${params.size ? `?${params}` : ''}`, { scroll: false });
  }, [selectedConversationId, router, searchParams]);
```

2. **Lifted filters**, so the same filtered list drives both the list and auto-advance:

```tsx
  const [filters, setFilters] = useState<LeadAnalysisFilters>({
    band: 'all', lane: 'all', search: '',
  });
  const visible = useMemo(
    () => (board ? filterLeadRows(board.leads, filters) : []),
    [board, filters],
  );
```

3. **The right pane's own fetch**, isolated so the boundary can catch its render-time throw:

```tsx
/**
 * Renders nothing; lifts a resolved conversation up to the page. Split
 * out so `ConversationFetchBoundary` wraps ONLY this query and not the
 * list or the thread — a throw here must not take the page down.
 */
type ResolvedConversation = FunctionReturnType<typeof api.conversations.get>;

function SelectedConversationFetcher({
  conversationId,
  onResolved,
}: {
  conversationId: Id<'conversations'>;
  onResolved: (c: ResolvedConversation) => void;
}) {
  const conversation = useQuery(api.conversations.get, { conversationId });
  useEffect(() => {
    if (conversation) onResolved(conversation);
  }, [conversation, onResolved]);
  return null;
}
```

Declare the two remaining pieces of local state alongside the others:

```tsx
  const [resolved, setResolved] = useState<ResolvedConversation | null>(null);
  const [contactPanelOpen, setContactPanelOpen] = useState(false);

  // A stale thread must never render under a new selection: clear the
  // resolved conversation the moment the id changes, so the pane shows
  // its empty state for the one frame before the new fetch lands rather
  // than the previous lead's messages.
  useEffect(() => {
    setResolved(null);
  }, [selectedConversationId]);
```

Then derive:

```tsx
  const activeConversation = resolved ? toUiConversation(resolved) : null;
  const activeContact = activeConversation?.contact ?? null;
  const selectedLead = visible.find((l) => l.conversationId === selectedConversationId) ?? null;
```

4. **Auto-advance on archive.** Snapshot the list at click time:

```tsx
  const handleArchive = useCallback(
    async (lead: LeadAnalysisRow) => {
      // Snapshot BEFORE awaiting: the board is a live query and the
      // archive re-sorts it, so picking the neighbour afterwards would
      // race that update.
      const advanceTo = nextSelectionAfterArchive(
        visible, lead.conversationId, selectedConversationId,
      );
      try {
        await archive({ conversationId: lead.conversationId as Id<'conversations'> });
        setSelectedConversationId(advanceTo);
        toast.success(t('archivedToast'));
      } catch (err) {
        console.error('Failed to archive this lead:', err);
        toast.error(t('archiveError'));
      }
    },
    [archive, t, visible, selectedConversationId],
  );
```

`handleRestore` keeps its current body unchanged — restore never advances.

5. **The layout**, mirroring the inbox's full-height escape and one-pane-on-mobile rule:

```tsx
  return (
    <div className="-m-4 flex h-app-content flex-col overflow-hidden sm:-m-6">
      {selectedConversationId && (
        <ConversationFetchBoundary key={selectedConversationId}>
          <SelectedConversationFetcher
            conversationId={selectedConversationId as Id<'conversations'>}
            onResolved={setResolved}
          />
        </ConversationFetchBoundary>
      )}

      {/* Summary + filters. Hidden on mobile while a thread is open so
          the conversation gets the whole screen. */}
      <div className={cn('shrink-0 border-b px-4 py-3', selectedConversationId && 'hidden lg:block')}>
        <LeadAnalysisSummary
          board={board}
          view={view}
          onViewChange={setView}
          filters={filters}
          onFiltersChange={setFilters}
        />
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div
          className={cn(
            'flex h-full flex-col overflow-y-auto border-r lg:w-96 lg:shrink-0',
            selectedConversationId ? 'hidden lg:flex' : 'flex flex-1',
          )}
        >
          <LeadAnalysisList
            leads={visible}
            selectedConversationId={selectedConversationId}
            onSelect={(lead) => setSelectedConversationId(lead.conversationId)}
            canReanalyze={canView}
            onReanalyze={handleReanalyze}
            canArchive={canArchive}
            onArchive={handleArchive}
            onRestore={handleRestore}
          />
        </div>

        <div
          className={cn(
            'min-w-0 flex-1 flex-col lg:flex',
            selectedConversationId ? 'flex' : 'hidden lg:flex',
          )}
        >
          {activeConversation ? (
            <>
              {/* Score + reason for the open lead — the one piece of
                  context the Inbox structurally cannot show. */}
              {selectedLead && (
                <div className="flex shrink-0 items-start gap-2 border-b px-4 py-2">
                  <button
                    type="button"
                    className="hover:bg-muted rounded-md p-1 lg:hidden"
                    aria-label={t('back')}
                    onClick={() => setSelectedConversationId(null)}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <span data-testid="thread-score" className="text-sm font-semibold">
                    {selectedLead.score ?? '–'}
                  </span>
                  <p className="text-muted-foreground min-w-0 flex-1 text-xs">
                    {selectedLead.reason ?? t('row.unscored')}
                  </p>
                </div>
              )}
              <div className="relative flex min-h-0 flex-1">
                <MessageThread
                  conversation={activeConversation}
                  contact={activeContact}
                  onBack={() => setSelectedConversationId(null)}
                  contactPanelOpen={contactPanelOpen}
                  onToggleContactPanel={() => setContactPanelOpen((o) => !o)}
                />
                <ContactPanelDrawer
                  open={contactPanelOpen}
                  onClose={() => setContactPanelOpen(false)}
                  contact={activeContact}
                  conversationId={selectedConversationId ?? undefined}
                />
              </div>
            </>
          ) : (
            <p className="text-muted-foreground m-auto text-sm">{t('selectLead')}</p>
          )}
        </div>
      </div>
    </div>
  );
```

Keep the two existing early returns (`!canView` → `t('empty')`, `!board` → `t('loading')`) **above** all of this, unchanged.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS — this is the task that repairs Task 7's deliberate break.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Lint the changed file**

Run: `npx eslint "src/app/(dashboard)/lead-analysis/page.tsx"`
Expected: no new warnings. If `react-hooks/exhaustive-deps` fires on the URL-sync effect, fix the dependency list rather than disabling the rule.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS

- [ ] **Step 6: Verify in the browser**

Start the dev server via the preview tooling (never `npm run dev` in Bash), open `/lead-analysis`, and confirm:
- The list renders on the left; the right pane shows the select-a-lead message.
- Clicking a row opens its thread, and `?c=<id>` appears in the URL.
- Reloading with `?c=<id>` reopens the same thread.
- Sending a reply works and the thread does not swap when the row re-sorts.
- Archiving the open lead advances to the next row.
- Archiving a *different* row leaves the open thread alone.
- At a narrow viewport, selecting a lead hides the list and the summary, and the back arrow returns.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(dashboard)/lead-analysis/page.tsx"
git commit -m "feat(lead-analysis): open lead conversations in a split pane instead of navigating"
```

---

## Deploy note

Tasks 1-5 change Convex functions and the schema, so they are inert until someone runs `convex deploy` — which this plan never does. Hand the owner this order:

1. `convex deploy` (both new fields are optional, so existing documents still validate; expect "Schema validation complete" and no index deletions).
2. `npx convex run messages:backfillLastMessageSenderType '{}'` — wait for it to drain. If it
   throws partway through, just re-trigger it: the mutation is atomic, so a failed run rolls
   back with its cursor unmoved — no rows are lost or skipped. (The known cause would be an
   unusually large single-millisecond tie group exceeding a mutation's read budget;
   `SENDER_TYPE_BACKFILL.batchSize` in `convex/messages.ts` can be lowered if it recurs.)
3. Merge the frontend.

Until step 1 lands, the deployed board keeps using its fallback path and behaves exactly as it does today.
