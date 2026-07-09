# Convex Phase 1 — Full Schema Translation (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Translate all ~31 remaining Postgres tables into `convex/schema.ts`, producing the complete, typed Convex data model so every later function-phase compiles against real tables/indexes.

**Architecture:** Schema-only phase. Each task ADDS a coherent table group to the existing `convex/schema.ts` (never altering the Phase 0 tables), deploys it to the self-hosted backend, and validates it typechecks + round-trips. No queries/mutations yet — those come in per-vertical function phases (2+).

**Tech Stack:** Convex schema (`defineTable`/`v`), self-hosted backend, `convex-test` + Vitest.

## Global Constraints — TRANSLATION RULES (apply to every table)

*(Inherited from the roadmap's Global Constraints, plus these Postgres→Convex mapping rules. The implementer reads the named source migration(s) and translates EVERY column faithfully.)*

- **Additive only.** Add tables alongside the existing `...authTables`, `accounts`, `memberships`, `contacts`, `tags`, `contactTags`. Never remove or modify those.
- **Naming:** snake_case → **camelCase** for both table names and fields (`message_reactions`→`messageReactions`, `phone_number_id`→`phoneNumberId`, `last_message_at`→`lastMessageAt`). This matches Phase 0 (`accountId`, `phoneNormalized`, `createdByUserId`).
- **Tenancy:** every table that had `account_id` gets `accountId: v.id("accounts")` + `.index("by_account", ["accountId"])`. A table that had a `user_id` FK to `auth.users` keeps it as `v.optional(v.id("users"))` (assignment/audit), named per its role (`createdByUserId`, `assignedToUserId`, `userId`).
- **Enums / CHECK:** `TEXT ... CHECK (col IN ('a','b',...))` → `v.union(v.literal("a"), v.literal("b"), ...)`. Nullable → wrap in `v.optional(...)`.
- **JSONB:** default `v.optional(v.any())`. Use a typed `v.object({...})` ONLY where the shape is documented + stable — specifically `messageTemplates.sampleValues` = `v.optional(v.object({ body: v.optional(v.array(v.string())), header: v.optional(v.array(v.string())) }))`. Engine-internal blobs (`triggerConfig`, `stepConfig`, `stepsExecuted`, `context`, `config`, `vars`, `payload`, `fallbackPolicy`, `audienceFilter`, `templateVariables`, `buttons`, `fieldOptions`, `interactivePayload`) → `v.optional(v.any())` for Phase 1; refine in the owning function-phase.
- **Foreign keys:** `col UUID REFERENCES other(id)` → `v.id("<otherCamelName>")`. Nullable FK / `ON DELETE SET NULL` → `v.optional(v.id(...))`. ON DELETE CASCADE has no DB equivalent — model the `v.id` now; the parent's delete mutation will cascade in its function-phase (do NOT implement here).
- **Timestamps:** rely on the automatic `_creationTime` (ms) for `created_at` — do NOT add a `createdAt` field unless a query needs to filter/paginate by it beyond default order. Add `updatedAt: v.optional(v.number())` where the app updates/reads it. Domain/scheduling timestamps the app sets (`lastMessageAt`, `scheduledAt`, `runAt`, `sentAt`, `deliveredAt`, `readAt`, `expiresAt`, `lastUsedAt`, `revokedAt`, `lastSeenAt`, `lastSubmittedAt`, `lastDeliveryAt`, etc.) → `v.optional(v.number())` (ms epoch).
- **UNIQUE constraints:** Convex has none → add an index on the unique columns so the future mutation can check-before-insert. Name it `by_<cols>`. (Enumerated per table below.)
- **Generated columns:** omit them. `contacts.phone_normalized` is already handled (computed in the create mutation). `aiKnowledgeChunks.fts` (tsvector) → DROP; use a `.searchIndex` on `content` instead.
- **pgvector:** `embedding vector(1536)` → `embedding: v.optional(v.array(v.float64()))` + `.vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1536, filterFields: ["accountId"] })`.
- **Numeric:** `INTEGER`/`BIGINT`/counters → `v.number()`. `NUMERIC`/money → `v.number()`. `BOOLEAN` → `v.boolean()`.
- **Indexes:** add `by_account` (all tenant tables) + a `by_<fk>` index for every FK the app looks rows up by (e.g. `messages.by_conversation`, `broadcastRecipients.by_broadcast`) + the unique-enforcing indexes. Default ordering uses `_creationTime` (auto) — don't add a created_at index unless a query needs a compound one.
- Per task: `npx convex dev --once` must deploy clean; `npx tsc --noEmit` clean; full suite green; commit `convex/_generated/`; double-quote style; no Supabase changes.

---

## File Structure
- Modify only: `convex/schema.ts` (append each task's tables).
- Test: `convex/schema.test.ts` (one file, extended per task with a tiny insert+read smoke test for 1–2 representative tables in the group — catches validator/`v.id` mistakes).

---

### Task 1: Inbox + CRM tables

**Tables (source migrations):** `conversations`, `messages` (001 + `interactivePayload` from 035), `messageReactions` (009); `pipelines`, `pipelineStages`, `deals` (001 + 002); `customFields`, `contactCustomValues`, `contactNotes` (001).

**Tricky notes:**
- `conversations`: FK `contactId`→`v.id("contacts")`, `assignedToUserId`→`v.optional(v.id("users"))`; `status` CHECK→union; `lastMessageAt`→`v.optional(v.number())`. Indexes: `by_account`, `by_contact`, and (for the inbox list order) rely on `_creationTime`/`lastMessageAt`.
- `messages`: FK `conversationId`→`v.id("conversations")`; `senderType` (customer/agent/bot), `contentType` (text/image/document/audio/video/location/template/interactive?), `status` (sending/sent/delivered/read/failed) → unions; `messageId` (Meta wamid) `v.optional(v.string())`; `interactivePayload` `v.optional(v.any())`. Indexes: `by_conversation`, `by_message_id` (wamid lookups), `by_account`.
- `messageReactions`: UNIQUE(message_id, actor_type, actor_id) → `.index("by_message_actor", ["messageId","actorType","actorId"])`; `actorType` union.
- `deals`: FKs `contactId`, `pipelineId`, `stageId`(→`v.id("pipelineStages")`); `value`→`v.number()`; index `by_account`, `by_pipeline`, `by_stage`, `by_contact`.
- `pipelineStages`: FK `pipelineId`; `position` number; `by_pipeline` index.
- `contactCustomValues`: UNIQUE(contact_id, custom_field_id) → `.index("by_contact_field", ["contactId","customFieldId"])`; `by_contact`.
- `contactNotes`: FK `contactId`; `by_contact`, `by_account`.

- [ ] **Step 1:** Read migrations 001, 002, 009, 035. Translate the 9 tables into `convex/schema.ts` per the rules above.
- [ ] **Step 2:** `npx convex dev --once` deploys clean (indexes built).
- [ ] **Step 3:** Smoke test in `convex/schema.test.ts`: insert a `conversations` + `messages` row (via `convexTest`) and read them back; assert the union/`v.id` fields validate. `npx vitest run`.
- [ ] **Step 4:** `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `feat(convex): inbox + CRM schema`.

---

### Task 2: Messaging + Settings tables

**Tables (source migrations):** `messageTemplates` (001 + 014 + 015), `broadcasts`, `broadcastRecipients` (001 + 003 + 005), `quickReplies` (035); `whatsappConfig` (001 + 013 + 015 + 017), `accountInvitations` (017 + 019), `apiKeys` (026), `webhookEndpoints` (028), `notifications` (027), `memberPresence` (024).

**Tricky notes:**
- `messageTemplates`: `category`/`status`/`headerType` CHECK→unions; `sampleValues` typed object (see rules); `buttons` `v.any()`; Meta fields (`metaTemplateId`, `qualityScore`, `rejectionReason`, `headerHandle`, `submissionError`, `lastSubmittedAt`) from 014; UNIQUE(user_id/account_id, name, language) → `.index("by_account_name_lang", ["accountId","name","language"])`.
- `broadcasts`: `status` union; `templateVariables`/`audienceFilter` `v.any()`; counters `v.number()`; `scheduledAt` number; `by_account`.
- `broadcastRecipients`: FK `broadcastId`, `contactId`; `status` union; UNIQUE wamid → `.index("by_wamid", ["whatsappMessageId"])`; `by_broadcast`, `by_account`.
- `whatsappConfig`: UNIQUE(account_id) → `by_account` suffices; UNIQUE(phone_number_id) → `.index("by_phone_number_id", ["phoneNumberId"])`; encrypted token fields are `v.string()`.
- `accountInvitations`: `tokenHash` (unique) → `.index("by_token_hash", ["tokenHash"])`; `role` union; `expiresAt`/`acceptedAt` numbers; `by_account`.
- `apiKeys`: `keyHash` UNIQUE → `.index("by_key_hash", ["keyHash"])`; `scopes` `v.array(v.string())`; `by_account`.
- `webhookEndpoints`: `events` `v.array(v.string())`; `by_account`.
- `notifications`: FK `userId` (recipient); `type`/read fields; `by_account`, `by_user`.
- `memberPresence`: PK was `user_id` → model `userId: v.id("users")` + `.index("by_user", ["userId"])`; `status` union (online/away); `lastSeenAt` number; `by_account`.

- [ ] **Step 1:** Read migrations 001,003,005,013,014,015,017,019,024,026,027,028,035 (the parts creating/altering these tables). Translate the 10 tables.
- [ ] **Step 2:** `npx convex dev --once` clean.
- [ ] **Step 3:** Smoke test: insert+read a `messageTemplates` (with typed `sampleValues`) and an `apiKeys` row. `npx vitest run`.
- [ ] **Step 4:** `tsc --noEmit` clean.
- [ ] **Step 5:** Commit `feat(convex): messaging + settings schema`.

---

### Task 3: Automations + Flows tables

**Tables (source migrations):** `automations`, `automationSteps`, `automationLogs`, `automationPendingExecutions` (006 + 007); `flows`, `flowNodes`, `flowRuns`, `flowRunEvents` (010 + 012 + 016 + 020).

**Tricky notes:**
- All the `*Config`/`context`/`stepsExecuted`/`vars`/`payload`/`fallbackPolicy` JSONB → `v.optional(v.any())`.
- `automationSteps`: FK `automationId`; `stepType` union; `position` number; `by_automation`.
- `automationLogs`/`automationPendingExecutions`: FK `automationId`, `contactId`; `status` union; `runAt` number (scheduling — relevant later for `ctx.scheduler`); `by_account`, and `by_status_runat` (`["status","runAt"]`) on pending (the cron drains by status+run_at).
- `flowNodes`: UNIQUE(flow_id, node_key) → `.index("by_flow_node_key", ["flowId","nodeKey"])`; `nodeType` union (start/send_buttons/send_list/send_message/collect_input/condition/set_tag/handoff/http_fetch/end).
- `flowRuns`: partial UNIQUE (one active run per account+contact) → `.index("by_account_contact", ["accountId","contactId"])` (+ `status` union; the "one active" rule is enforced in the engine mutation later); `by_flow`, `by_status`.
- `flowRunEvents`: FK `flowRunId`; `payload` any; `by_run`.

- [ ] **Step 1:** Read migrations 006,007,010,012,016,020. Translate the 8 tables.
- [ ] **Step 2:** `npx convex dev --once` clean.
- [ ] **Step 3:** Smoke test: insert+read an `automations` + `flowRuns` row. `npx vitest run`.
- [ ] **Step 4:** `tsc --noEmit` clean.
- [ ] **Step 5:** Commit `feat(convex): automations + flows schema`.

---

### Task 4: AI tables (+ vector & search indexes)

**Tables (source migrations):** `aiConfigs` (029 + 031), `aiUsageLog` (033), `aiKnowledgeDocuments`, `aiKnowledgeChunks` (030 + 032).

**Tricky notes:**
- `aiConfigs`: UNIQUE(account_id) → `by_account`; `provider` union (openai/anthropic); encrypted `apiKey`/`embeddingsApiKey` `v.string()`/optional; booleans; `handoffAgentId`→`v.optional(v.id("users"))`.
- `aiUsageLog`: token counters `v.number()`; `mode`/`provider`/`model` fields; `by_account` (dashboard reads `by account + created_at` — rely on `_creationTime` order, filter by account).
- `aiKnowledgeDocuments`: FK `accountId`; status/title fields; `by_account`.
- `aiKnowledgeChunks`: FK `documentId`→`v.id("aiKnowledgeDocuments")`, `accountId`; **DROP the generated `fts` tsvector** — instead add `.searchIndex("search_content", { searchField: "content", filterFields: ["accountId"] })`; `embedding: v.optional(v.array(v.float64()))` + `.vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1536, filterFields: ["accountId"] })`; `by_document`, `by_account`.

- [ ] **Step 1:** Read migrations 029,030,031,032,033. Translate the 4 tables (note the fts→searchIndex and pgvector→vectorIndex conversions).
- [ ] **Step 2:** `npx convex dev --once` clean (vector + search indexes build).
- [ ] **Step 3:** Smoke test: insert+read an `aiKnowledgeChunks` row with a small `embedding` array; assert it validates. `npx vitest run`.
- [ ] **Step 4:** `tsc --noEmit` clean.
- [ ] **Step 5:** Commit `feat(convex): AI schema (vector + search indexes)`.

---

## Exit Gate (Phase 1 done when ALL true)
- All ~31 remaining tables present in `convex/schema.ts`; the full 36-table model deploys clean to the self-hosted backend.
- `npx tsc --noEmit` clean; full suite green; `convex/_generated/dataModel.d.ts` reflects every table.
- Every tenant table has `by_account`; every UNIQUE has an enforcing index; `aiKnowledgeChunks` has vector + search indexes.
- Phase 0 tables untouched; nothing merged to `main`.

## Self-Review
1. Coverage: cross-check the 36-table list (roadmap table→phase map) against `convex/schema.ts` — every table present.
2. No CHECK left as bare `v.string()` where a union was intended; no JSONB left un-optional where the column was nullable.
3. `v.id()` targets all resolve to declared camelCase table names.
