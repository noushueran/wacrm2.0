# Convex Phase 6 — Engines & Server Surfaces (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. This is the most complex phase — external I/O (actions), the scheduler, and intricate engine logic.

**Goal:** Port the automations + flows engines, the inbound ingestion path, Meta-send, webhook delivery, and media storage to Convex — using **actions** for external Meta calls, **mutations** for DB effects, and **`ctx.scheduler`** to replace the `automation_pending_executions` cron polling and the flows fallback cron. Webhook stays a Next.js route that calls these Convex functions (rewired at Phase 8 cutover).

**Architecture (the split that makes this testable):**
- **Pure decision helpers** (which step/node is next, condition eval, branch, fallback) → port the existing pure-TS modules 1:1 into `convex/lib/` WITH their tests: `automations/steps-tree.ts` + `validate.ts`; `flows/edges.ts` + `fallback.ts` + `validate.ts` + `layout.ts`. These are already pure and tested — copy them, they carry their own correctness.
- **DB effects** (set_tag, assign, create_deal, update_contact_field, persist message, advance run, counters) → Convex **mutations** (account/internal), fully `convex-test`-covered.
- **External Meta sends** → Convex **actions** with a DRY-RUN path (env `CONVEX_META_DRY_RUN` — when set, skip the fetch and return a synthetic wamid, mirroring the app's `WHATSAPP_TEMPLATES_DRY_RUN`). Tests run in DRY-RUN and assert the DB-persist side effects.
- **Waits/timeouts** → `ctx.scheduler.runAfter(ms, internal.<engine>.<resume>, {...})`. No pending-executions table, no cron for automations. Flow fallback: schedule a per-run timeout on each advance; cancel+reschedule on the next advance.

## Global Constraints
*(Inherit the roadmap's.)* Tenant fns via `accountQuery`/`accountMutation`; internal engine fns via `internalMutation`/`internalAction`/`internalQuery` (server-only). Every ingestion/engine write is account-scoped (the account comes from the webhook's `whatsappConfig`, not client input). Validate offline (`tsc`+`vitest`) then `npx convex dev --once`. Commit `_generated`; double-quote style (no `prettier --write`); TS strict; no Supabase changes. Reuse the Phase-2 `messages.append`/`conversations.*`, Phase-0 `contacts` dedupe, Phase-3 `deals`/`customFields`, Phase-5 `whatsappConfig`/`webhookEndpoints`.

## Behavior reference (read the source engine files + THEIR tests as the spec)
- Automations: `src/lib/automations/engine.ts` + `engine.test.ts` (trigger dispatch, step execution, `wait` suspension via `automation_pending_executions` → **scheduler**), `steps-tree.ts`, `validate.ts`, `meta-send.ts`, `trigger-meta.ts`. Counter: `increment_automation_execution_count` → a mutation `+1`.
- Flows: `src/lib/flows/engine.ts` + `engine.test.ts` (`dispatchInboundToFlows`, node executors, `collect_input` suspension, `startNewRun`/`advance`), `edges.ts`, `fallback.ts`, `validate.ts`, `layout.ts`, `meta-send.ts`. Counter: `increment_flow_execution_count`.
- Webhook ingestion: `src/app/api/whatsapp/webhook/route.ts` `processMessage` (find-or-create contact by normalized phone, find-or-create conversation, insert inbound message, update conversation unread, media download, fan-out order: flows first → if not consumed, automations + AI + webhook-delivery).
- Send: `src/lib/whatsapp/send-message.ts` `sendMessageToConversation` + `meta-send.ts` (Meta POST → wamid → persist message + conversation denorm — the persist is Phase-2 `messages.append`).
- Webhook delivery: `src/lib/webhooks/deliver.ts` `dispatchWebhookEvent` (HMAC-sign + POST to the account's active `webhookEndpoints`; bump `failureCount`/`lastDeliveryAt`).
- Storage: `src/lib/storage/upload-media.ts` (buckets flow-media/chat-media, account-scoped path, public URL) → `ctx.storage`.

---

### Task 1: Pure helpers + Meta-send actions + storage
**Files:** Create `convex/lib/automations/*` + `convex/lib/flows/*` (ported pure helpers + tests), `convex/metaSend.ts` (actions), `convex/files.ts` (storage), `convex/lib/whatsappEncryption.ts` (port the access-token decrypt using Web Crypto or a `"use node"` action).
- Port the pure modules (steps-tree, flows edges/fallback/validate/layout) + their tests verbatim (adjust imports). They must pass unchanged in behavior.
- `metaSend.ts` actions: `sendText`/`sendTemplate`/`sendInteractive`/`sendMedia` — `internalAction`; load the account's `whatsappConfig` (via internalQuery), decrypt the access token, POST to Meta (skip when `CONVEX_META_DRY_RUN` set → synthetic wamid), then `ctx.runMutation` Phase-2 `messages.append` (senderType "bot") to persist. Return `{ whatsappMessageId }`.
- `files.ts`: `generateUploadUrl` (mutation), `getUrl` (query), and an internal `storeFromUrl` action (download Meta media → `ctx.storage.store`) for inbound media.
- [ ] TDD: the ported pure-helper tests pass; `metaSend` in DRY-RUN persists a message + updates the conversation (assert via `messages.append` effects) and is account-scoped; storage upload URL round-trips. tsc; vitest; deploy; commit `feat(convex): engine pure helpers + meta-send actions + storage`.

### Task 2: Inbound ingestion mutation + webhook delivery
**Files:** Create `convex/ingest.ts`, `convex/webhookDelivery.ts` (+ tests).
- `ingest.ingestInbound({ accountId, from, name, message })` — `internalMutation` (called by the Next webhook after signature verify): normalize phone, find-or-create contact (dedupe by `by_account_phone`; flag `wasCreated`), find-or-create conversation (`by_contact`), insert the inbound message (senderType "customer", via the same logic as `messages.append` incl. conversation denorm + unread++), detect `isFirstInboundMessage`. Return `{ contactId, conversationId, messageId, wasCreated, isFirstInbound }`.
- `webhookDelivery.dispatch({ accountId, event, payload })` — `internalAction`: load active `webhookEndpoints` for the account subscribed to `event`; HMAC-sign + POST each; on success bump `lastDeliveryAt`, on failure bump `failureCount` (via a mutation). SSRF-guard the URL.
- [ ] TDD: ingest creates contact+conversation+message on first contact, reuses them on the second, bumps unread, sets first-inbound correctly; cross-account safety (accountId drives all lookups). Webhook delivery in DRY-RUN/stub selects only subscribed active endpoints. tsc; vitest; deploy; commit `feat(convex): inbound ingestion + webhook delivery`.

### Task 3: Automations engine
**Files:** Create `convex/automationsEngine.ts` (+ test).
- `runForTrigger({ accountId, triggerType, contactId, context })` — `internalMutation` (or action if a step sends): fetch active automations for (account, triggerType); for each, check `triggerMatches` (ported), create an `automationLogs` row, execute steps from position 0.
- Step execution: walk `automationSteps` (by_automation, ordered). DB steps (`set_tag`→contactTags, `assign_conversation`→conversations.assign, `update_contact_field`→contactCustomValues, `create_deal`→deals.create, `condition`→branch via ported eval) run inline. Send steps (`send_message`/`send_buttons`/`send_list`/`send_template`) schedule/run the `metaSend` action. `send_webhook` → `webhookDelivery`. **`wait` step → `ctx.scheduler.runAfter(waitMs, internal.automationsEngine.resume, { automationId, contactId, nextPosition, branch, logId, context })`** and STOP this scope. `resume` continues from `nextPosition`. Bump the automation's execution counter (a `+1` mutation).
- [ ] TDD (port `engine.test.ts` scenarios): a keyword trigger runs a set_tag step (assert the tag); a `wait` step schedules a resume (assert via `t.finishInProgressScheduledFunctions()` / the scheduler test API) and continues after; a `condition` branches correctly; account-scoped. tsc; vitest; deploy; commit `feat(convex): automations engine (scheduler-based wait)`.

### Task 4: Flows engine
**Files:** Create `convex/flowsEngine.ts` (+ test).
- `dispatchInbound({ accountId, contactId, message, isFirstInboundMessage })` — `internalMutation`: load the active `flowRuns` for the contact (`by_account_contact`, status active) → advance it; else find an entry flow whose trigger matches (ported) → start a new run. Return `{ consumed, outcome }`.
- Node executors (ported logic): `send_*` → `metaSend`; `collect_input` → persist the awaited node + SUSPEND (return; the next inbound wakes it); `condition` → branch (ported edges eval); `set_tag`; `handoff` → conversations.assign + status pending; `end` → close run. Persist `lastPromptMessageId`/`lastAdvancedAt`.
- **Fallback:** on each advance, `ctx.scheduler.runAfter(timeoutMs, internal.flowsEngine.timeout, { runId })` (store the scheduled id; cancel the previous on the next advance). `timeout` applies the fallback policy (ported `decideFallback`). Bump the flow execution counter.
- [ ] TDD (port `engine.test.ts` scenarios): an inbound matching a keyword starts a run + sends the first node; a button reply advances a `collect_input`; an unmatched reply hits fallback; a timeout fires the fallback policy (scheduler test API); account-scoped. tsc; vitest; deploy; commit `feat(convex): flows engine (collect_input + scheduler fallback)`.

---

## Exit Gate
Engines + ingestion + send + delivery + storage exist as account/internal Convex fns; waits/timeouts use the scheduler (no pending-executions table, no automations cron); DRY-RUN makes the Meta paths testable; ported pure-helper tests pass; cross-account safety holds; tsc + full suite green; Phases 0–5 untouched.

## Self-Review
1. Pure helpers are byte-faithful ports (their tests pass). 2. `wait`/fallback use `ctx.scheduler` (+ cancel on re-advance); no polling table. 3. Every Meta send is an action with DRY-RUN; every DB effect is a tested mutation. 4. Ingestion is account-driven; dedupe correct. 5. Fan-out order flows→(automations+ai+delivery) preserved.
