# Convex Phase 2 — Inbox Vertical (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Build the account-scoped Convex **data layer** for the Inbox — reactive queries + DB mutations for `conversations`, `messages`, `messageReactions` — with cross-account isolation tests. This is where Convex reactivity replaces the app's `postgres_changes` subscriptions.

**Architecture:** Pure Convex backend functions on the Phase 1 schema. Every function goes through `accountQuery`/`accountMutation` (`convex/lib/auth.ts`). The external Meta WhatsApp **send** (network call) and the inbound **webhook** ingestion are NOT in this phase — they're Phase 6 (engines). Phase 2 provides the `messages.append` / conversation mutations those will later call, and the reactive reads the inbox UI will use at cutover. UI rewiring + deleting `use-realtime.ts` happen at the Phase 8 cutover.

**Tech Stack:** Convex queries/mutations, `convex-test` + Vitest, self-hosted backend (deploys currently work).

## Global Constraints
*(Inherit the roadmap's Global Constraints. Load-bearing here:)*
- **Every function uses `accountQuery`/`accountMutation`** (never raw `query`/`mutation`) and scopes by `ctx.accountId`. Every feature ships a **cross-account denial test**.
- Validate offline with `npx tsc --noEmit` + `npx vitest run`; then `npx convex dev --once` deploys clean (backend is up).
- `convex/_generated/` committed; double-quote `convex/` style; no Supabase changes; TS strict.
- Timestamps set in mutations use `Date.now()` (ms) — allowed in Convex functions.
- Reuse the established patterns in `convex/contacts.ts` (`requireOwnContact`-style ownership asserts, `embedTags`, `ConvexError` codes `NOT_FOUND`/`DUPLICATE_*`).

## Behavior reference (from the Supabase app)
- **Conversation list:** `by_account`, order by `lastMessageAt` desc, embed `contact` (+ its tags). Optional `status` filter. `lastMessageText/At` + `unreadCount` are denormalized on the row — never join messages for a preview.
- **Message list:** per conversation, order by `_creationTime` desc (newest first), paginated; the conversation must belong to the caller's account.
- **Persist a message** (`messages.append`): insert the message (accountId derived from the conversation), then update the conversation's `lastMessageText`, `lastMessageAt = Date.now()`, `updatedAt`; increment `unreadCount` ONLY when `senderType === "customer"` (inbound). Agent/bot sends don't bump unread.
- **markRead:** set `unreadCount = 0`.
- **assign:** set `assignedToUserId`; set `status = "pending"` (matches the flow/AI handoff behavior).
- **setStatus:** open | pending | closed.
- **Reactions:** upsert by `(messageId, actorType, actorId)` (the `by_message_actor` index); remove deletes that row.

---

### Task 1: Conversation queries

**Files:** Create `convex/conversations.ts`, `convex/conversations.test.ts`.

**Produces:**
- `list({ status?: union("open","pending","closed"), paginationOpts })` — `accountQuery`; `by_account`; order by `lastMessageAt` desc (fall back to `_creationTime` for null); optional `status` filter; each row embeds `contact` (via `ctx.db.get(contactId)`) with the contact's `tags` (via `contactTags.by_contact` → `tags`). Cursor pagination.
- `get({ conversationId })` — `accountQuery`; assert `conversation.accountId === ctx.accountId` (else `NOT_FOUND`); embed the contact (+ tags).

- [ ] **Step 1: Failing tests** — cross-account denial: account A's conversation never appears in B's `list` and `get` throws `NOT_FOUND` for B. Same-account happy path: a seeded conversation appears with its embedded contact.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `list` + `get` (embed helper mirrors `contacts.embedTags`). Order by `lastMessageAt` desc — since Convex indexes order by the indexed field + `_creationTime`, add an index `by_account_last_message` on `["accountId","lastMessageAt"]` to `conversations` in `convex/schema.ts` (additive) and query it `.order("desc")`.
- [ ] **Step 4: Run → pass;** `tsc` clean; `npx convex dev --once` deploys (new index builds); full suite green.
- [ ] **Step 5: Commit** `feat(convex): conversation queries (list + get, reactive)`.

---

### Task 2: Message queries + append mutation

**Files:** Create `convex/messages.ts`, `convex/messages.test.ts`.

**Consumes:** `conversations` (ownership), the `messages.by_conversation` index (Phase 1).

**Produces:**
- `listByConversation({ conversationId, paginationOpts })` — `accountQuery`; first assert the conversation belongs to `ctx.accountId` (else `NOT_FOUND`); then `messages.by_conversation` ordered `desc`, paginated.
- `append({ conversationId, senderType, contentType, contentText?, mediaUrl?, templateName?, messageId?, interactivePayload?, aiGenerated? })` — `accountMutation`, `requireRole("agent")`; load the conversation, assert account ownership; insert the message with `accountId = ctx.accountId`; then patch the conversation: `lastMessageText` = a preview (contentText or `[${contentType}]`), `lastMessageAt = Date.now()`, `updatedAt = Date.now()`, and `unreadCount = unreadCount + 1` IFF `senderType === "customer"`. `status` defaults to `"sent"`. Returns the new message `_id`.

- [ ] **Step 1: Failing tests** — (a) `append` inserts a message AND updates the conversation's `lastMessageAt`/`lastMessageText`; a `"customer"` message bumps `unreadCount`, an `"agent"` one does not. (b) Cross-account denial: B cannot `listByConversation` or `append` to A's conversation (throws `NOT_FOUND`). (c) `listByConversation` returns newest-first.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → pass;** `tsc`; deploy; suite green.
- [ ] **Step 5: Commit** `feat(convex): message list + append (with conversation denorm update)`.

---

### Task 3: Conversation mutations + reactions

**Files:** Create `convex/reactions.ts`, `convex/reactions.test.ts`; extend `convex/conversations.ts` + its test.

**Produces (conversations):**
- `findOrCreateForContact({ contactId })` — `accountMutation`, `requireRole("agent")`; assert the contact belongs to the account; return the existing `by_contact` conversation or insert a new one (`status:"open"`, `unreadCount:0`).
- `assign({ conversationId, userId })` — assert ownership + that `userId` is a member of the account (via `memberships.by_user_account`); set `assignedToUserId` + `status:"pending"`.
- `setStatus({ conversationId, status })` — ownership; set status.
- `markRead({ conversationId })` — ownership; `unreadCount = 0`.

**Produces (reactions):**
- `set({ messageId, emoji, actorType, actorId })` — `accountMutation`; assert the message belongs to the account; upsert by `by_message_actor` (`messageId`,`actorType`,`actorId`) — patch emoji if present else insert (`accountId = ctx.accountId`).
- `remove({ messageId, actorType, actorId })` — ownership; delete the matching row.
- `forMessage({ messageId })` — `accountQuery`; the message's reactions (account-scoped).

- [ ] **Step 1: Failing tests** — findOrCreate idempotency (second call returns same conv); assign rejects a non-member `userId`; markRead zeroes unread; reactions upsert (set twice = one row, updated emoji) + cross-account denial on all (B cannot mutate A's conversation/message/reaction → `NOT_FOUND`).
- [ ] **Step 2: Run → fail.** **Step 3: Implement.** **Step 4: pass; tsc; deploy; suite green.**
- [ ] **Step 5: Commit** `feat(convex): conversation mutations + reactions with isolation tests`.

---

## Exit Gate
- All Inbox data-layer functions exist, account-scoped, deploy clean; cross-account denial tests green for conversations, messages, reactions.
- `tsc` clean; full suite green; `convex/_generated/` committed; Phase 0/1 untouched.

## Self-Review
1. Every function routes through `accountQuery`/`accountMutation`; no raw `query`/`mutation` on inbox tables.
2. `append` updates the conversation denormals correctly (unread only for inbound); `markRead` zeroes.
3. Every mutation asserts account ownership of the target before writing; every feature has a denial test.
