# Voice-note mic button + reply-quote write-path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing voice recorder a first-class mic button in the composer, and complete the reply-quote write path so replies render as quotes in our inbox (both directions).

**Architecture:** Two independent changes. (A) Frontend-only Send⇄Mic swap in `message-composer.tsx` reusing the existing recorder. (B) Backend threading of `replyToMessageId` through the outbound send path and inbound ingest — no schema/index change (`messages.replyToMessageId` column and `by_message_id` index already exist; the client already renders the quote).

**Tech Stack:** Next.js (custom build), Convex (self-hosted), convex-test + vitest, opus-recorder.

## Global Constraints

- Convex functions only — **no schema migration, no new index.** `messages.replyToMessageId: v.optional(v.id("messages"))` and index `by_message_id` already exist.
- Reply reference stored is the internal `Id<"messages">` of the parent (client resolves `messagesById.get(reply_to_message_id)`).
- Every test that reaches `metaSend` sets `process.env.CONVEX_META_DRY_RUN = "1"` and deletes it at the end (existing convention).
- convex-test module glob: `const modules = import.meta.glob("/convex/**/*.ts");`.
- Voice = free-form media: mic disabled when `inputsDisabled` (viewer role or expired 24h window).

---

### Task 1: Capture inbound reply context in the webhook parser

**Files:**
- Modify: `convex/lib/whatsapp/webhookParse.ts` (`FlattenedInboundMessage` ~L269; `flattenInboundMessage` ~L294)
- Test: `convex/lib/whatsapp/webhookParse.test.ts`

**Interfaces:**
- Produces: `FlattenedInboundMessage.contextWamid?: string` — the wamid of the message this inbound message replies to (from Meta `message.context.id`).

- [ ] **Step 1: Write the failing test** (append to `webhookParse.test.ts`)

```ts
test("flattenInboundMessage captures context.id as contextWamid", () => {
  const flat = flattenInboundMessage({
    id: "wamid.REPLY",
    type: "text",
    text: { body: "yes please" },
    context: { id: "wamid.PARENT" },
  } as MetaWebhookMessage);
  expect(flat?.contextWamid).toBe("wamid.PARENT");
});

test("flattenInboundMessage leaves contextWamid undefined for a non-reply", () => {
  const flat = flattenInboundMessage({
    id: "wamid.X",
    type: "text",
    text: { body: "hello" },
  } as MetaWebhookMessage);
  expect(flat?.contextWamid).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/whatsapp/webhookParse.test.ts -t "contextWamid"`
Expected: FAIL (property `contextWamid` does not exist / is undefined).

- [ ] **Step 3: Add the field to the interface** (`FlattenedInboundMessage`)

```ts
  interactiveReplyId?: string;
  ctwaClid?: string;
  /** wamid of the message this one replies to (Meta `context.id`). */
  contextWamid?: string;
  referral?: AdReferral;
```

- [ ] **Step 4: Merge it in `flattenInboundMessage`** (alongside the ctwaClid/referral merge, before the `return`)

```ts
  const contextWamid = message.context?.id || undefined;
  return {
    ...base,
    ...(ctwaClid ? { ctwaClid } : {}),
    ...(contextWamid ? { contextWamid } : {}),
    ...(referral ? { referral } : {}),
  };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run convex/lib/whatsapp/webhookParse.test.ts -t "contextWamid"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/whatsapp/webhookParse.ts convex/lib/whatsapp/webhookParse.test.ts
git commit -m "feat(webhook): capture inbound reply context.id as contextWamid"
```

---

### Task 2: Thread `replyToMessageId` through the message insert core

**Files:**
- Modify: `convex/messages.ts` (`AppendMessageArgs` L73; `insertMessageAndUpdateConversation` L106; `append` args L189; `appendInternal` args L249)
- Test: `convex/messages.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AppendMessageArgs.replyToMessageId?: Id<"messages">`, persisted onto the `messages` row; `append`/`appendInternal` both accept `replyToMessageId: v.optional(v.id("messages"))`.

- [ ] **Step 1: Write the failing test** (append to `convex/messages.test.ts`; mirror its existing seed helpers)

```ts
test("appendInternal persists replyToMessageId", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Ann", email: "ann@example.com", role: "agent",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "15550001111", phoneNormalized: "15550001111" }),
  );
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 }),
  );
  const parentId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId, conversationId, senderType: "customer",
      contentType: "text", contentText: "Q?", status: "delivered",
    }),
  );

  const replyId = await t.run((ctx) =>
    ctx.runMutation(internal.messages.appendInternal, {
      accountId, conversationId, senderType: "agent",
      contentType: "text", contentText: "A!", replyToMessageId: parentId,
    }),
  );

  const stored = await t.run((ctx) => ctx.db.get(replyId));
  expect(stored!.replyToMessageId).toBe(parentId);
});
```

(If `convex/messages.test.ts` lacks a `seedAccountMember` helper, copy the one from `convex/send.test.ts` L22-48, and import `internal` from `./_generated/api`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/messages.test.ts -t "persists replyToMessageId"`
Expected: FAIL (`appendInternal` rejects the unknown `replyToMessageId` arg / field not stored).

- [ ] **Step 3: Add to `AppendMessageArgs`** (after `referral?`)

```ts
  referral?: AdReferral;
  /** Internal id of the message this one replies to (WhatsApp quoted reply).
   *  Outbound: the agent's reply target. Inbound: resolved from context.id. */
  replyToMessageId?: Id<"messages">;
```

- [ ] **Step 4: Destructure + write it** in `insertMessageAndUpdateConversation`

Add `replyToMessageId` to the destructure block and to the `ctx.db.insert("messages", {...})` object (alongside `referral`).

- [ ] **Step 5: Add the validator to `appendInternal` AND `append`**

In both args validators, after `aiGenerated: v.optional(v.boolean()),` add:

```ts
    replyToMessageId: v.optional(v.id("messages")),
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run convex/messages.test.ts -t "persists replyToMessageId"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(messages): persist replyToMessageId on the message row"
```

---

### Task 3: Thread `replyToMessageId` through metaSend + send (outbound acceptance)

**Files:**
- Modify: `convex/metaSend.ts` (`sendText` L109, `sendTemplate` L153, `sendInteractive` L210, `sendMedia` L283)
- Modify: `convex/send.ts` (the 4 `ctx.runAction(internal.metaSend.*, {...})` dispatches L146-213)
- Test: `convex/send.test.ts`

**Interfaces:**
- Consumes: `AppendMessageArgs.replyToMessageId` (Task 2).
- Produces: `api.send.send({ replyToMessageId })` persists `replyToMessageId` on the outbound row.

- [ ] **Step 1: Write the failing test** (append to `convex/send.test.ts`)

```ts
test("send persists replyToMessageId on the outbound reply (DRY-RUN)", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice", email: "alice@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "15551234567" });
  const conversationId = await seedConversation(t, { accountId, contactId, assignedToUserId: userId });
  const parentId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId, conversationId, senderType: "customer",
      contentType: "text", contentText: "Do you have availability?",
      messageId: "wamid.PARENT", status: "delivered",
    }),
  );

  await asUser.action(api.send.send, {
    conversationId, messageType: "text",
    contentText: "Yes we do!", replyToMessageId: parentId,
  });

  const messages = await t.run((ctx) =>
    ctx.db.query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  const reply = messages.find((m) => m.senderType === "agent");
  expect(reply!.replyToMessageId).toBe(parentId);
  delete process.env.CONVEX_META_DRY_RUN;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/send.test.ts -t "persists replyToMessageId"`
Expected: FAIL (`reply.replyToMessageId` is undefined).

- [ ] **Step 3: Add the arg to all four metaSend actions**

To each of `sendText`, `sendTemplate`, `sendInteractive`, `sendMedia` args, after `senderType: v.optional(...)`, add:

```ts
    replyToMessageId: v.optional(v.id("messages")),
```

- [ ] **Step 4: Pass it into each `appendInternal` call**

In each handler's `ctx.runMutation(internal.messages.appendInternal, { ... })`, add:

```ts
      replyToMessageId: args.replyToMessageId,
```

- [ ] **Step 5: Pass it from `send.ts` into each dispatch**

In `send.ts`, in each of the `image/video/document/audio`, `template`, `interactive`, and `text` `ctx.runAction(internal.metaSend.*, {...})` calls, add:

```ts
          replyToMessageId: args.replyToMessageId,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run convex/send.test.ts -t "persists replyToMessageId"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add convex/metaSend.ts convex/send.ts convex/send.test.ts
git commit -m "feat(send): persist agent reply reference on outbound messages"
```

---

### Task 4: Resolve inbound reply context in ingest

**Files:**
- Modify: `convex/ingest.ts` (`inboundMessageValidator` L78; `ingestInbound` handler — add lookup before `appendArgs` L244)
- Test: `convex/ingest.test.ts`

**Interfaces:**
- Consumes: `FlattenedInboundMessage.contextWamid` (Task 1), `AppendMessageArgs.replyToMessageId` (Task 2).
- Produces: an inbound message whose `context.id` matches a stored message in the same conversation is persisted with `replyToMessageId` set to that message's `_id`.

- [ ] **Step 1: Write the failing test** (append to `convex/ingest.test.ts`, mirroring its existing account/whatsappConfig seed helpers; if it seeds inbound via `internal.ingest.ingestInbound`, reuse that)

```ts
test("ingestInbound links a reply to its parent via contextWamid", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountForIngest(t); // existing helper in this suite
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "15559990000", phoneNormalized: "15559990000" }),
  );
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 }),
  );
  const parentId = await t.run((ctx) =>
    ctx.db.insert("messages", {
      accountId, conversationId, senderType: "agent",
      contentType: "text", contentText: "Here is your quote",
      messageId: "wamid.OURS", status: "sent",
    }),
  );

  const res = await t.run((ctx) =>
    ctx.runMutation(internal.ingest.ingestInbound, {
      accountId, from: "15559990000", name: "Cust",
      message: { type: "text", text: "thanks!", wamid: "wamid.THEIRS", contextWamid: "wamid.OURS" },
    }),
  );

  const stored = await t.run((ctx) => ctx.db.get(res.messageId));
  expect(stored!.replyToMessageId).toBe(parentId);
});

test("ingestInbound leaves replyToMessageId undefined when contextWamid matches nothing", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountForIngest(t);
  const res = await t.run((ctx) =>
    ctx.runMutation(internal.ingest.ingestInbound, {
      accountId, from: "15559990001", name: "Cust",
      message: { type: "text", text: "hi", wamid: "wamid.NEW", contextWamid: "wamid.MISSING" },
    }),
  );
  const stored = await t.run((ctx) => ctx.db.get(res.messageId));
  expect(stored!.replyToMessageId).toBeUndefined();
});
```

(Use whatever account-seed helper `convex/ingest.test.ts` already defines in place of `seedAccountForIngest`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/ingest.test.ts -t "reply to its parent"`
Expected: FAIL (`contextWamid` rejected by validator, or `replyToMessageId` not set).

- [ ] **Step 3: Add `contextWamid` to `inboundMessageValidator`** (after `interactiveReplyId`)

```ts
  interactiveReplyId: v.optional(v.string()),
  contextWamid: v.optional(v.string()),
  ctwaClid: v.optional(v.string()),
```

- [ ] **Step 4: Resolve it to `replyToMessageId` in `ingestInbound`** (insert just before the `const appendArgs: AppendMessageArgs = {` block at ~L244, where `conversationId` and `accountId` are in scope)

```ts
    // Reply linkage: map the WhatsApp quoted-message wamid (context.id) to
    // the parent's internal id, scoped to this conversation. wamids aren't
    // globally unique (see the dedup guard above), so filter by conversation.
    let replyToMessageId: Id<"messages"> | undefined;
    const parentWamid = message.contextWamid;
    if (parentWamid) {
      const parent = await ctx.db
        .query("messages")
        .withIndex("by_message_id", (q) => q.eq("messageId", parentWamid))
        .filter((q) => q.eq(q.field("conversationId"), conversationId))
        .first();
      replyToMessageId = parent?._id;
    }
```

- [ ] **Step 5: Add it to `appendArgs`** (after `interactiveReplyId: message.interactiveReplyId,`)

```ts
      interactiveReplyId: message.interactiveReplyId,
      replyToMessageId,
      referral: message.referral,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run convex/ingest.test.ts -t "replyToMessageId"`
Expected: PASS (both).

- [ ] **Step 7: Commit**

```bash
git add convex/ingest.ts convex/ingest.test.ts
git commit -m "feat(ingest): link inbound customer replies to their parent message"
```

---

### Task 5: First-class mic button in the composer (frontend)

**Files:**
- Modify: `src/components/inbox/message-composer.tsx` (default composer row ~L644-775; 📎 menu ~L664-681)

**Interfaces:**
- Consumes: existing `startRecording`, `recording`, `draft`, `inputsDisabled`, `readOnly`, `text`, `handleSend` state/handlers.
- Produces: no new exported interface — UX change only.

- [ ] **Step 1: Swap Send↔Mic based on whether there is text to send**

Replace the single always-rendered Send `GatedButton` (currently ~L765-774) with a conditional: when `text.trim()` is non-empty render the existing Send button; otherwise render a Mic button that starts recording.

```tsx
{text.trim() ? (
  <GatedButton
    size="sm"
    canAct={!readOnly}
    gateReason="send messages"
    disabled={sessionExpired || sending}
    onClick={handleSend}
    className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
  >
    <Send className="h-4 w-4" />
  </GatedButton>
) : (
  <GatedButton
    size="sm"
    canAct={!readOnly}
    gateReason="send voice notes"
    disabled={inputsDisabled || busy}
    title={readOnly ? undefined : t("voiceNote")}
    aria-label={t("voiceNote")}
    onClick={() => void startRecording()}
    className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
  >
    <Mic className="h-4 w-4" />
  </GatedButton>
)}
```

- [ ] **Step 2: Remove the now-redundant "Voice note" item from the 📎 menu**

Delete the `<DropdownMenuItem onClick={() => void startRecording()}>…{t("voiceNote")}</DropdownMenuItem>` block (~L677-680). The 📎 menu keeps photo/video/document.

- [ ] **Step 3: Verify in the browser** (see Task 6 — this change is verified via preview, not a unit test, because it depends on `getUserMedia`/opus-recorder which convex-test/vitest can't exercise)

- [ ] **Step 4: Commit**

```bash
git add src/components/inbox/message-composer.tsx
git commit -m "feat(inbox): first-class mic button in the composer (tap to record)"
```

---

### Task 6: Full verification

- [ ] **Step 1: Typecheck** — Run: `npx tsc --noEmit` — Expected: no errors.
- [ ] **Step 2: Lint** — Run: `npm run lint` — Expected: clean.
- [ ] **Step 3: Full test suite** — Run: `npx vitest run` — Expected: all green (existing count + the new reply/webhook tests).
- [ ] **Step 4: Production build** — Run: `npm run build` (or the project's build script) — Expected: success.
- [ ] **Step 5: Browser preview** — start the dev server; in a conversation, confirm:
  - Empty composer shows a **Mic** button; typing swaps it to **Send**.
  - Tapping Mic opens the recording bar (timer + Stop); Stop shows the audio preview; Send dispatches.
  - Mic is disabled with a tooltip when the 24h window is expired / for a viewer.
  - Selecting a message to reply to, then sending, renders a quote bubble above the new outbound message.
- [ ] **Step 6: Final commit** (if any verification fixups were needed).

## Self-Review

- **Spec coverage:** Part A (mic swap + remove 📎 item + disabled gating) → Task 5. Part B1 (outbound) → Tasks 2+3. Part B2 (inbound) → Tasks 1+4. Testing → per-task + Task 6. Rollout → Task 6 (deploy is a separate owner-confirmed step). ✅ No gaps.
- **Placeholder scan:** all steps carry real code/commands. ✅
- **Type consistency:** `replyToMessageId: Id<"messages">` / `v.optional(v.id("messages"))` and `contextWamid?: string` / `v.optional(v.string())` used consistently across Tasks 1–4. ✅
