# Purchase Signals — proxy Meta Purchase events for highly-qualified leads

**Date:** 2026-07-19 · **Status:** approved by owner (chat, 2026-07-19) · **Branch:** `feat/purchase-signals`

## 1. Problem

The owner runs Meta CTWA campaigns with a Sales objective ("maximise purchases
through messaging"). Real purchases close offline (sales team calls, deals take
days/weeks), far too slow to feed Meta's optimization. The owner's strategy: a
**highly-qualified lead counts as a Purchase immediately**. "Qualified" alone is
not enough — each service has its own stricter bar (Georgia package: budget ≥
~AED 2,500–3,000 **per person**; UAE visa: all documents + details received).
Criteria must stay owner-editable per service, forever, without code changes.

## 2. What already exists (verified 2026-07-19)

- `convex/lib/funnel.ts` maps stage `purchased` → CAPI `Purchase` (ctwa lane) /
  web-pixel `Purchase` (code lane), `needsValue: true` for the *agent* path.
- `funnel.applyStageTransition` seeds a deduped `conversionEvents` row
  (`eventId = ${conversationId}:${stage}`, `by_event_id` lookup links instead of
  re-inserting) and schedules `deliverConversionEvent`. The CAPI branch already
  sends `custom_data {value, currency}` when the row has a value
  (conversionEvents.ts:404–413).
- The qualification engine (LIVE in prod) runs a passive analysis LLM pass on
  every inbound **text** (`ingest.ts` gates on `inboundText.trim()`), scores
  leads against per-service `QUALIFICATION CHECKLIST — <Service>` sentinel
  sections retrieved from the KB via `aiKnowledge.retrieve`, and
  `completeQualification` flips the session to `qualified` + fires the funnel
  `qualified` stage (Meta `QualifiedLead`).
- `qualificationEngine.onInbound` runs for **every** inbound including media —
  the hook point that text-only analysis lacks (visa documents arrive as
  images/PDFs).
- Everything is dormant at the Meta edge until the owner sets
  `META_CAPI_DATASET_ID` + `META_CAPI_ACCESS_TOKEN` (still unset; dormant rows
  auto-drain once set).

## 3. Design

### 3.1 Criteria live in the KB (owner-editable, per service)

New sentinel section per service doc, mirroring the checklist pattern:

```
PURCHASE CRITERIA — Georgia Packages
- Budget of AED 2,500 or more PER PERSON (ask trip budget per person, never monthly income).
- Email collected.
- Travel dates confirmed (month at minimum).
Report value: 3000 AED per person.
```

Retrieved with `aiKnowledge.retrieve({queryText: "PURCHASE CRITERIA <service>"})`
exactly like checklists. No section found ⇒ verdict `criteriaFound:false`,
never fires. The optional `Report value:` line lets the judge compute an
estimated event value (per-person × travelers when stated); no line ⇒ event
sent value-less (still counts for max-conversions optimization).

### 3.2 A dedicated judge, only for qualified sessions

New pure lib `convex/lib/qualification/purchase.ts`:

- `buildPurchasePrompt({criteriaExcerpts, serviceName, fields, score, summary, mediaNote})`
  — strict judge: default to NOT met when uncertain; JSON verdict only.
- `parsePurchaseVerdict(raw)` → `{met, confidence 0–100, reasons[], value|null,
  currency|null, criteriaFound}` — never throws.
- `syntheticPurchaseRaw(latestText)` — dry-run markers for tests:
  `[[PURCHASE]]` (met, confidence 90), `pvalue:9000;` / `pcurrency:AED;`,
  `[[NOPURCHASE]]` (explicit not-met). No marker ⇒ not met.
- `MIN_PURCHASE_CONFIDENCE = 70`, `PURCHASE_EVAL_WINDOW_MS = 7 days` (after
  `qualifiedAt`, stop re-evaluating — attribution decays and stale fires are
  noise).

Engine (`convex/qualificationEngine.ts`):

- `loadPurchaseContext` internalQuery — null unless: qualification config
  enabled **and** `purchaseSignalsEnabled`, conversation open + attributed
  (identifier present), not staff, latest session `qualified`, purchase not
  already `sent`, within the eval window, and not evaluated in the last 10s
  (debounce). Returns session snapshot + previous-session transcript boundary
  (multi-lead: judge only sees messages after the prior inquiry finished).
- `evaluatePurchase` internalAction — context → BYO-key LLM (same
  `aiConfig.loadDecrypted` + `CONVEX_AI_DRY_RUN` gates and usage-log `mode:
  "qualify"` shape as `analyzeInbound`) → `applyPurchaseVerdict`. Transcript =
  `aiReply.recentMessages` (includes media rows) + an explicit deterministic
  media count in the prompt so "documents received" is judgeable.
- `applyPurchaseVerdict` internalMutation — recheck gates transactionally.
  met && confidence ≥ 70 ⇒ seed the `purchased` conversion event (below), stamp
  `session.purchase = {status:"sent", …, sentAt, conversionEventId}`, notify
  (`purchase_signal` bell to the same recipients as `lead_qualified`).
  Otherwise stamp `{status:"not_met", evaluatedAt, confidence, reasons}` and
  keep listening.

### 3.3 Firing without touching the operational funnel

Factor the conversion-event seeding out of `applyStageTransition` into
`seedStageConversionEvent(ctx, {accountId, conversation, stage, value?,
currency?})` (same file, byte-identical behavior for the authed path; returns
`{conversionEventId, created}`). The purchase path calls it directly with stage
`"purchased"`:

- **No `conversation.funnel` patch, no `funnelTransitions` row** — the CRM
  funnel keeps reporting operational truth; only Meta gets the proxy.
- `eventId = ${conversationId}:purchased` — if the sales team later marks the
  real Purchase, `applyStageTransition`'s existing `by_event_id` lookup finds
  the row, links it, and **never double-sends**. If the agent marked purchased
  first, the proxy path finds the existing row and no-ops the same way.
- Both lanes work unchanged: ctwa → CAPI `Purchase` (+`custom_data` value),
  code → Platform A `{stage:"purchased", event:"Purchase", value, currency}`
  (P5 already parses + per-(code,stage) dedups). Organic conversations are
  skipped (nothing to attribute).

Known carried-over limitation (same as `qualified` today): eventId is per
conversation × stage, so a second lead in the same conversation cannot re-fire
Purchase.

### 3.4 Triggers

1. `completeQualification` tail — schedules `evaluatePurchase` (covers criteria
   already satisfied during qualification, e.g. budget was asked as a checklist
   item).
2. `onInbound` — after the existing activity bump, when the latest session is
   `qualified` + signals enabled + not sent + in window ⇒ schedule
   `evaluatePurchase`. Runs for **media too** (the visa-documents case).
3. Manual: `qualification.sendPurchaseSignal({sessionId})` accountMutation,
   supervisor+, for case-by-case human judgment — fires the same seed (reusing
   the last verdict's value when present), stamps `manual:true`.

### 3.5 Config, schema, UI

- `qualificationConfigs.purchaseSignalsEnabled: v.optional(v.boolean())` —
  default **false** (feature ships dormant). Patch key + validation + default.
  (Auto vs review mode: owner chose fully automatic; the status shape leaves
  room for a future "review" state without migration.)
- `qualificationSessions.purchase: v.optional(v.object({status: "sent"|"not_met",
  evaluatedAt, confidence, reasons: string[], value?, currency?, sentAt?,
  conversionEventId?, manual?}))`.
- `notifications.type` union + client `NotificationType` + `TYPE_ICON` gain
  `purchase_signal` (💰).
- Settings → Lead qualification: new "Purchase signals (Meta)" card — toggle +
  explainer + doc-format hint. Admin-gated like the rest of the tab.
- `/leads` board: 💰 badge on rows whose session purchase status is `sent`
  (+ tooltip reasons in the detail pane); detail pane shows the verdict and a
  "Send purchase signal" button (supervisor+) when qualified-but-not-sent.
- Inbox `getSessionForConversation` exposes `purchase` for the chip/sidebar.

### 3.6 KB content for the owner

Author `PURCHASE CRITERIA` sections for the 6 existing checklist services in
`holidayys-ai-agent/agent-content.md` (outside the app repo), marked
paste-ready: Dubai packages, international packages (incl. Georgia example),
UAE visas (documents-received bar), international visas, flights & hotels,
ladies-only tours.

## 4. Quality guardrails

- Judge is prompted to **refuse when uncertain** and requires explicit evidence
  per criterion; confidence < 70 never fires.
- Once `sent`, the session never re-evaluates (idempotent at three layers:
  session status, `by_event_id` dedup, conversionEvents outbox).
- Every fire is visible: bell notification, /leads badge with reasons, and the
  conversionEvents row in `/campaigns` Meta-delivery grid.
- Proxy strictness = ad quality: the settings card copy tells the owner to keep
  criteria strict and watch the firing rate.

## 5. Testing

Dry-run (`CONVEX_AI_DRY_RUN`) + convex-test, offline codegen discipline
(hand-edit `_generated/api.d.ts`, never run convex CLI against prod):

1. lib: prompt determinism, verdict parsing (valid/garbage/clamps), markers.
2. Happy path: qualified session + `[[PURCHASE]]` ⇒ conversionEvents row
   (`stage purchased`, correct eventId/lane/value), session stamped `sent`,
   notification inserted, funnel stage UNCHANGED.
3. Not met ⇒ `not_met`, no event; later inbound re-evaluates.
4. Idempotency: second fire attempt no-ops; agent-marked real purchase links
   the existing row (no second insert/send); reverse order too.
5. Gates: disabled config / organic conversation / staff number / non-qualified
   session / outside 7-day window ⇒ no evaluation.
6. Media inbound on a qualified session triggers evaluation.
7. Manual fire: role gate (supervisor+), fires once, `manual:true`.
8. `seedStageConversionEvent` refactor: existing funnel.setStage behavior
   byte-identical (existing suite must stay green untouched).

## 6. Rollout

Ship dormant (`purchaseSignalsEnabled:false` default). Backend-first deploy
(merge origin/main → `npx convex deploy` → merge PR → Netlify). Owner go-live:
set META_* env (pre-existing blocker), paste the 6 PURCHASE CRITERIA sections,
flip the toggle in Settings, then verify in Meta Events Manager and point the
ad set's optimization event at `Purchase` (OUTCOME_SALES).
