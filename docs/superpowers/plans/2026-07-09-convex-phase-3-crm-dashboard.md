# Convex Phase 3 — CRM + Dashboard (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Account-scoped Convex functions for the CRM (pipelines, stages, deals, custom fields + values, contact notes) and the dashboard aggregation queries — with cross-account isolation tests.

**Architecture:** Pure Convex functions on the Phase 1 schema, all via `accountQuery`/`accountMutation`. Dashboard aggregations replicate `src/lib/dashboard/queries.ts` (currently client-side) as account-scoped queries. UI rewire is the Phase 8 cutover.

**Tech Stack:** Convex, `convex-test` + Vitest, self-hosted backend (deploys work).

## Global Constraints
*(Inherit the roadmap's. Load-bearing here:)*
- Every function via `accountQuery`/`accountMutation`, scoped by `ctx.accountId`; every feature ships a **cross-account denial test**.
- Ownership: every mutation asserts the target row's `accountId === ctx.accountId` (or reaches it via an already-verified parent) BEFORE writing. Child tables now carry `accountId` (Phase 1 fix) — use it.
- Validate offline (`tsc` + `vitest`), then `npx convex dev --once` deploys clean. Commit `convex/_generated/`; double-quote `convex/` style; TS strict; no Supabase changes.
- Reuse patterns from `convex/contacts.ts`, `convex/conversations.ts` (ownership helpers, `requireRole`, `ConvexError` `NOT_FOUND`, embed helpers, cursor pagination).
- Role gates: settings-class writes (`customFields`, pipeline/stage structure) = `requireRole("admin")`; operational writes (deals, values, notes) = `requireRole("agent")`.

## Behavior reference (read the named source files for exact fields/logic)
- **Pipelines/stages** (`src/app/(dashboard)/pipelines/page.tsx`, `src/components/pipelines/pipeline-settings.tsx`): create pipeline → also insert default stages (the `SPEC_DEFAULT_STAGES` constant — find it); stages have `position` ordering; add/rename/reorder(position)/delete stage.
- **Deals** (`src/components/pipelines/deal-form.tsx`, `pipeline-board.tsx`): fields `title, value(number), currency, contactId?, pipelineId, stageId, assignedToUserId?, notes?, expectedCloseDate?, status(open/won/lost)`. Board = deals for a pipeline, grouped by `stageId`. Move = patch `stageId`. Also update, setStatus, delete.
- **Custom fields** (`src/components/contacts/custom-fields-manager.tsx`): `fieldName, fieldType, fieldOptions?`; account-wide catalogue, admin-gated. **Values** (`src/components/contacts/contact-detail-view.tsx`): per contact, **replace-all** on save (delete the contact's values, insert the non-empty ones).
- **Contact notes**: `contactId, body, createdByUserId`; list/add/delete per contact (read the notes section of `contact-detail-view.tsx` for the exact column name — `body`/`content`/`note`).
- **Dashboard** (`src/lib/dashboard/queries.ts` + `date-utils.ts`): 5 aggregations. **Local-day boundaries** are computed client-side today — the Convex queries must ACCEPT the boundary timestamps (ms) as args (e.g. `todayStartMs`, `yesterdayStartMs`, `sinceMs`, `dayBoundariesMs[]`) so server-side (UTC) aggregation preserves the client's local-day semantics.

---

### Task 1: Pipelines + stages + deals

**Files:** Create `convex/pipelines.ts`, `convex/deals.ts` (+ tests).

**Pipelines/stages (`pipelines.ts`, admin for structure):**
- `list()` — `accountQuery`; pipelines `by_account`, each with its stages (`pipelineStages.by_pipeline`, ordered by `position`).
- `create({ name })` — `accountMutation` `requireRole("admin")`; insert pipeline + default stages (port `SPEC_DEFAULT_STAGES`).
- `renameStage`/`addStage`/`reorderStages`/`deleteStage` — admin; assert the stage's pipeline belongs to the account.

**Deals (`deals.ts`, agent):**
- `listByPipeline({ pipelineId })` — `accountQuery`; assert pipeline ownership; deals `by_pipeline` scoped to account (return flat list; the board groups by `stageId` client-side).
- `create({ title, value, currency, contactId?, pipelineId, stageId, assignedToUserId?, notes?, expectedCloseDate? })` — agent; assert pipeline+stage(+contact) ownership; insert `{ accountId, status:"open", updatedAt: Date.now(), ... }`.
- `move({ dealId, stageId })` — agent; ownership; assert new stage's pipeline matches; patch `{ stageId, updatedAt }`.
- `update` / `setStatus({ dealId, status })` (open/won/lost) / `remove` — agent; ownership.

- [ ] TDD: cross-account denial on every fn (B can't list/create/move/delete A's pipeline/deal → `NOT_FOUND`); `create` sets defaults; `move` rejects a foreign-pipeline stage; `list` returns pipelines with ordered stages.
- [ ] tsc; vitest; `npx convex dev --once`; commit `feat(convex): pipelines + stages + deals`.

---

### Task 2: Custom fields + values + contact notes

**Files:** Create `convex/customFields.ts`, `convex/contactNotes.ts` (+ tests).

**Custom fields (admin):**
- `list()` — `accountQuery`; `customFields.by_account`, ordered by `fieldName`.
- `create({ fieldName, fieldType })` / `rename({ fieldId, fieldName })` / `remove({ fieldId })` — admin; ownership; reject duplicate `fieldName` in the account.

**Contact custom values (agent):**
- `getForContact({ contactId })` — `accountQuery`; assert contact ownership; return `contactCustomValues.by_contact` (map fieldId→value shape or the raw rows).
- `setForContact({ contactId, values: array({ customFieldId, value }) })` — agent; assert contact ownership + each `customFieldId` belongs to the account; **replace-all**: delete the contact's existing values (`by_contact`), insert the non-empty ones with `accountId`.

**Contact notes (agent):**
- `listForContact({ contactId })` — `accountQuery`; ownership; notes `by_contact` newest-first.
- `add({ contactId, body })` — agent; ownership; insert `{ accountId, contactId, body, createdByUserId: ctx.userId }`.
- `remove({ noteId })` — agent; ownership.

- [ ] TDD: cross-account denial on every fn; `setForContact` replace-all (removing a field clears its value; re-set updates); duplicate custom-field name rejected.
- [ ] tsc; vitest; deploy; commit `feat(convex): custom fields + values + contact notes`.

---

### Task 3: Dashboard aggregation queries

**Files:** Create `convex/dashboard.ts` (+ test); port the local-day helpers you need into `convex/lib/dashboardDate.ts` (from `src/lib/dashboard/date-utils.ts`) OR take boundary timestamps as args (preferred).

**Read `src/lib/dashboard/queries.ts` for exact logic**, then build these `accountQuery` functions (all scoped by `ctx.accountId`; accept client-computed local-day boundary args so UTC server aggregation stays faithful):
- `metrics({ todayStartMs, yesterdayStartMs })` → `{ activeConversations:{current,previous}, newContactsToday:{current,previous}, openDealsValue, openDealsCount, messagesSentToday:{current,previous} }`. (open conversations count; new conversations today vs yesterday; new contacts today vs yesterday; open deals value-sum + count; agent messages today vs yesterday.)
- `conversationsSeries({ sinceMs, dayKeys: array(string) })` → per-day `{ day, incoming, outgoing }` (messages since `sinceMs`, bucketed to the provided day keys; `incoming` = senderType customer, `outgoing` = agent/bot).
- `pipelineDonut()` → `{ stages: [{ id, name, color, dealCount, totalValue }], totalValue }` (open deals grouped by stage).
- `responseTime({ sinceMs })` → replicate `loadResponseTime` exactly (read it — it buckets customer→agent reply latencies).
- `activity({ limit })` → interleaved recent items from messages(customer)/contacts/deals/broadcasts/automationLogs, sorted by time desc, capped at `limit` (mirror `loadActivity`, incl. the embedded contact/stage/automation names).

Aggregate in-memory over `by_account` scans (current scale = low thousands; matches how the app does it today). Note in the report if any scan looks unbounded for a large tenant.

- [ ] TDD: seed a small dataset for one account + a decoy account; assert each aggregation's numbers AND that the decoy account's rows are excluded (isolation). Denial: an unauthenticated call throws.
- [ ] tsc; vitest; deploy; commit `feat(convex): dashboard aggregation queries`.

---

## Exit Gate
- All CRM + dashboard functions exist, account-scoped, deploy clean; cross-account denial green for pipelines/deals/customFields/values/notes/dashboard.
- `tsc` clean; full suite green; Phase 0/1/2 untouched.

## Self-Review
1. Every fn via `accountQuery`/`accountMutation`; correct role gates (admin for structure/fields, agent for operational).
2. Dashboard numbers match `queries.ts` semantics; local-day handled via args; decoy-account rows excluded.
3. `setForContact` replace-all correct; deal `move` validates the target stage's pipeline.
