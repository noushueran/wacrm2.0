# Convex Phase 4 — Messaging Ops (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.

**Goal:** Account-scoped Convex **DB layer** for messaging — message templates, broadcasts + recipients (with the count aggregation that was a Postgres trigger), and quick replies — with isolation tests. The Meta-API network calls (template submit, broadcast send) are Phase 6 actions; Phase 4 provides the mutations those will call.

**Architecture:** Pure Convex functions on the Phase 1 schema, all via `accountQuery`/`accountMutation`. The broadcast count aggregation (migration 005) becomes an **incremental in-mutation update** on every recipient status change.

## Global Constraints
*(Inherit the roadmap's.)* Every fn via `accountQuery`/`accountMutation`, scoped by `ctx.accountId`; every feature ships a cross-account denial test; ownership asserted before writes. Validate offline (`tsc`+`vitest`) then `npx convex dev --once`. Commit `_generated`; double-quote `convex/` style (no `prettier --write`); TS strict; no Supabase changes. Reuse `convex/contacts.ts`/`convex/conversations.ts` patterns. Role gates: templates/broadcasts/quick-replies writes = `requireRole("agent")` (operational).

## Behavior reference (read the named files)
- **Templates** (`src/app/api/whatsapp/templates/submit/route.ts`, `[id]/route.ts`, `src/lib/whatsapp/template-webhook.ts`): columns incl. `name, category, language, headerType?, headerContent?, headerMediaUrl?, headerHandle?, bodyText, footerText?, buttons?, sampleValues?, status(DRAFT/PENDING/APPROVED/REJECTED), metaTemplateId?, rejectionReason?, qualityScore?, submissionError?, lastSubmittedAt?`. Upserted by `(accountId, name, language)` (the `by_account_name_lang` index). The Meta webhook patches by `metaTemplateId` (status + rejectionReason).
- **Broadcasts** (`src/lib/whatsapp/broadcast-core.ts`): create `broadcasts` (status "sending"/"draft", `totalRecipients`) + one `broadcastRecipients` row per contact (status "pending"). Counts (`sentCount/deliveredCount/readCount/repliedCount/failedCount`) are DERIVED from recipient statuses — never seeded manually.
- **Count model** (migration 005) — the columns a recipient status contributes to (cumulative "at or past"):
  `pending → []`, `sent → [sent]`, `delivered → [sent,delivered]`, `read → [sent,delivered,read]`, `replied → [sent,delivered,read,replied]`, `failed → [failed]`.
- **Quick replies** (`src/app/api/quick-replies/route.ts`): `title, kind(text/interactive), contentText?, interactivePayload?`. CRUD.

---

### Task 1: Templates + Quick replies

**Files:** Create `convex/templates.ts`, `convex/quickReplies.ts` (+ tests).

**Templates (`templates.ts`, agent):**
- `list()` — `accountQuery`; `messageTemplates.by_account`, newest-first.
- `get({ templateId })` — ownership.
- `upsert({ name, language, category, bodyText, headerType?, headerContent?, headerMediaUrl?, headerHandle?, footerText?, buttons?, sampleValues?, status?, metaTemplateId?, submissionError?, lastSubmittedAt? })` — agent; find existing by `by_account_name_lang` (accountId+name+language); patch it or insert `{ accountId, createdByUserId: ctx.userId, ... }`. Return the `_id`.
- `updateStatusByMetaId({ metaTemplateId, status, rejectionReason?, qualityScore? })` — agent; find the account's template with that `metaTemplateId` (scoped to `ctx.accountId`); patch status/rejectionReason (+ clear submissionError). (The Phase-6 webhook path will call an internal variant; for now expose the account-scoped one + test it.)
- `remove({ templateId })` — agent; ownership.

**Quick replies (`quickReplies.ts`, agent):**
- `list()`; `create({ title, kind, contentText?, interactivePayload? })`; `update({ quickReplyId, ...patch })`; `remove({ quickReplyId })` — all agent, account-scoped. (Accept `interactivePayload` as `v.optional(v.any())`; deep validation is deferred.)

- [ ] TDD: upsert-by-(name,language) updates-not-duplicates; `updateStatusByMetaId` patches the right row and won't touch another account's template with the same metaTemplateId; quick-reply CRUD; cross-account denial on every fn.
- [ ] tsc; vitest; deploy; commit `feat(convex): message templates + quick replies`.

---

### Task 2: Broadcasts + recipients + count aggregation

**Files:** Create `convex/broadcasts.ts` (+ test).

**Functions (agent):**
- `list()` — `accountQuery`; `broadcasts.by_account`, newest-first (returns the denormalized counts).
- `get({ broadcastId })` — ownership; returns the broadcast + its counts.
- `listRecipients({ broadcastId, paginationOpts })` — ownership; `broadcastRecipients.by_broadcast`, paginated.
- `create({ name, templateName, templateLanguage, contactIds: array(id), templateVariables?, audienceFilter?, status? })` — agent; assert every `contactId` belongs to the account; insert the broadcast `{ accountId, createdByUserId, ..., status: status ?? "sending", totalRecipients: contactIds.length, sentCount:0, deliveredCount:0, readCount:0, repliedCount:0, failedCount:0 }`; insert a `broadcastRecipients` row per contact `{ accountId, broadcastId, contactId, status: "pending" }`. Return `broadcastId`.
- `setRecipientStatus({ recipientId, status, whatsappMessageId?, errorMessage? })` — agent; load recipient, assert account ownership (via its broadcast or its own `accountId`); if `status` unchanged, no-op; else **incrementally adjust the parent broadcast's counts**: for each column in `cols(oldStatus)` do −1, for each in `cols(newStatus)` do +1 (use the count model above); patch the recipient `{ status, + sentAt/deliveredAt/readAt/repliedAt = Date.now() as appropriate, whatsappMessageId?, errorMessage? }`. Clamp counts at ≥0.
- `setStatus({ broadcastId, status })` (draft/scheduled/sending/sent/failed) — agent; ownership; patch `{ status, updatedAt: Date.now() }`.
- `remove({ broadcastId })` — agent; ownership; cascade-delete its `broadcastRecipients` (`by_broadcast`) then the broadcast.

Include a private helper `colsForStatus(status): string[]` implementing the count model; unit-test it.

- [ ] TDD: `create` seeds recipients + zeroed counts; a recipient `pending→sent` bumps `sentCount` to 1 (not delivered/read); `sent→delivered` bumps `deliveredCount` (sent stays 1); `→failed` bumps `failedCount` only; a full sequence to `replied` yields sent=delivered=read=replied=1; `remove` cascades recipients; cross-account denial on every fn (B can't create-with-A's-contacts, read, or setRecipientStatus on A's broadcast).
- [ ] tsc; vitest; deploy; commit `feat(convex): broadcasts + recipients + count aggregation`.

---

## Exit Gate
All messaging DB functions exist, account-scoped, deploy clean; counts derive correctly from recipient status transitions; cross-account denial green everywhere; tsc + full suite green; Phase 0–3 untouched.

## Self-Review
1. Count deltas match the `cols(status)` model exactly (cumulative sent→replied; failed separate); counts never go negative.
2. `upsert`/`updateStatusByMetaId` never cross accounts (same name/metaId in another account is invisible).
3. Every fn via `accountQuery`/`accountMutation`; denial test per feature.
