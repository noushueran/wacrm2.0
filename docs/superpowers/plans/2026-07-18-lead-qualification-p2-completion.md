# Lead Qualification P2 — Completion Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the analysis pass reports readiness, complete the lead: session → `qualified`, funnel stage → `qualified` (auto) seeding the live Meta conversion outbox, closing message to the customer, bot handoff into the human queue (with the lead-value charge), **WhatsApp lead alert to the admin numbers**, and in-app bell + web-push notifications.

**Architecture:** `funnel.setStage`'s core is extracted into an exported `applyStageTransition(ctx, …)` helper (byte-identical behavior for the authed path; adds `auto`/optional `byUserId`/never-downgrade for the engine path). `qualificationEngine.completeQualification` (internalMutation) does ALL db work in one transaction — compare-and-set, funnel via the helper, handoff patch mirroring `aiReply.markHandoff` (+ idempotent `chargeLeadIfAgent`), `insertNotification` rows — and schedules three actions: `sendClosingMessage`, `sendAdminAlerts` (template-first, free-form fallback; internal contact/conversation with `aiAutoreplyDisabled`), and `pushSend.deliverForQualifiedLead` (VAPID-dormant like inbound push). Triggered from `analyzeInbound` when `applyAnalysis` returns `readyToComplete`.

## Global Constraints
Same as P0/P1 (offline codegen, dormant feature, TDD, worktree). Plus: **never downgrade a funnel stage** a human already advanced (order per `FUNNEL_STAGE_KEYS`); admin-alert conversations are flagged `aiAutoreplyDisabled` at creation and are excluded from sessions (P0 guard already keys off `adminAlertPhones`).

### Task 1: `applyStageTransition` extraction (funnel refactor, behavior-preserving)
Files: `convex/funnel.ts` (helper + `setStage` delegating), tests: existing `convex/funnel.test.ts` stays green + new auto-transition test in `convex/qualificationEngine.test.ts` (via Task 2).
Interfaces: `applyStageTransition(ctx: { db: MutationCtx["db"]; scheduler: MutationCtx["scheduler"] }, args: { accountId; conversation: Doc<"conversations">; stage: FunnelStageKey; byUserId?: Id<"users">; auto: boolean; saleValue?: number; saleCurrency?: string; defaultCurrency: string; neverDowngrade?: boolean }) => Promise<Id<"conversations">>` — patches `conversations.funnel`, seeds the deduped `conversionEvents` row + schedules the dispatcher, appends `funnelTransitions`.

### Task 2: `completeQualification` + trigger wiring
Files: `convex/qualificationEngine.ts`, `convex/notifications.ts` (widen `insertNotification` type arg), tests in `convex/qualificationEngine.test.ts`.
- `applyAnalysis` returns `{ wantsHuman, readyToComplete }`; `analyzeInbound` calls `completeQualification` when ready.
- `completeQualification({accountId, conversationId})`: session must be `collecting` with `checklistSatisfiedAt` → set `qualified`/`qualifiedAt`; funnel qualified via helper (`auto: true`, `neverDowngrade: true`); handoff patch (`aiAutoreplyDisabled`, conversation `pending`, `aiHandoffSummary` = summary + answers; assign `aiConfigs.handoffAgentId` only when unassigned + `chargeLeadIfAgent`); `insertNotification` (`lead_qualified`, title "New qualified lead", body = summary/score) to assignee else every supervisor+ member; schedule `sendClosingMessage` + `sendAdminAlerts` + `pushSend.deliverForQualifiedLead`. Idempotent via the status compare-and-set.

### Task 3: closing message + admin WhatsApp alert actions
Files: `convex/qualificationEngine.ts`; tests same file.
- `sendClosingMessage`: session `qualified` guard → contact phone → `metaSend.sendText` (bot). `CONVEX_META_DRY_RUN` in tests.
- `ensureAdminConversation` (internalMutation): upsert contact by `by_account_phone` (name "Lead alerts (staff)"), find-or-create conversation (direct insert if none for contact), patch `aiAutoreplyDisabled: true`; returns `{conversationId, to}`.
- `sendAdminAlerts`: config `adminAlertEnabled` + phones; per phone → ensure conversation → template (`adminAlertTemplateName`, params `[name, phone, service — summary, score]`, rendered `contentText`) else free-form fallback text; each send try/caught.

### Task 4: qualified-lead web push
Files: `convex/lib/pushPayload.ts` (`buildQualifiedLeadPayload` — hidePreview collapses to generic), `convex/push.ts` (`assembleQualifiedLeadDelivery` internalQuery: recipients assignee-else-supervisor+ via `recipientsForInbound`, per-user prefs, subs fan-out), `convex/pushSend.ts` (`deliverForQualifiedLead`, mirrors `deliverForMessage`). Tests: `convex/push.test.ts` additions (assembly only — the node sender stays untested like `deliverForMessage`).

### Task 5: verification
Full vitest + tsc + lint + build; commit plan doc.

## Self-review
Spec §9 steps 1–6 → Tasks 1–4 (Meta signal = helper's conversionEvents seeding; Events-Manager caveats unchanged). Loop guards already live from P0. No placeholders; signatures declared above are the ones implemented.
