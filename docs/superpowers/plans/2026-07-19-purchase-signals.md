# Purchase Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline execution in the authoring session — the executor holds full spec context). Steps use checkbox syntax for tracking.

**Goal:** Fire a proxy Meta `Purchase` conversion the moment a qualified lead also meets its service's owner-editable PURCHASE CRITERIA, without touching the operational funnel.

**Architecture:** A pure judge lib + three engine functions (`loadPurchaseContext` → `evaluatePurchase` → `applyPurchaseVerdict`) layered on the live qualification engine; firing reuses the conversionEvents outbox via a `seedStageConversionEvent` helper factored out of `funnel.applyStageTransition` (same `${convId}:purchased` eventId ⇒ structurally impossible to double-send against the real sale). Spec: `docs/superpowers/specs/2026-07-19-purchase-signals-design.md`.

**Tech stack:** Convex (self-hosted, OFFLINE codegen — hand-edit `_generated/api.d.ts`, never run convex CLI), vitest + convex-test with `CONVEX_AI_DRY_RUN` marker steering, Next.js settings/leads UI, next-intl `messages/en.json`.

## Global constraints

- NEVER run `convex dev|deploy|codegen` during the build (single live prod deployment).
- Feature ships dormant: `purchaseSignalsEnabled` defaults `false`; META_* env unset in prod anyway.
- Dry-run markers: analysis owns `field:k=v;`/`score:NN`/`[[COMPLETE]]`; purchase adds `[[PURCHASE]]`/`[[NOPURCHASE]]`/`pvalue:N;`/`pcurrency:XXX;` — disjoint vocabularies.
- Constants: `MIN_PURCHASE_CONFIDENCE = 70`, `PURCHASE_EVAL_WINDOW_MS = 7d`, `PURCHASE_EVAL_DEBOUNCE_MS = 10_000`.
- Full suite (1887 baseline) + `tsc --noEmit` + `eslint` + `next build` green before ship.

---

### Task 1: Pure judge lib

**Files:** Create `convex/lib/qualification/purchase.ts`; Test `convex/lib/qualification/purchase.test.ts` (mirror sibling lib test placement — verify with `ls convex/lib/qualification/*.test.ts`, else co-locate in `convex/` like the engine tests).

**Produces:**
- `interface PurchaseVerdict { met: boolean; confidence: number; reasons: string[]; value: number | null; currency: string | null; criteriaFound: boolean }`
- `buildPurchasePrompt(args: { criteriaExcerpts: string[]; serviceName: string | null; fields: {key: string; label?: string; value: string}[]; score: number | null; summary: string | null; customerMediaCount: number }): string` — deterministic; instructs: judge ONLY against a `PURCHASE CRITERIA — <service>` section present in the excerpts; `criteriaFound:false` when none matches the service; strict default-refuse; compute value from a `Report value:` line (× travelers when per-person); JSON-only reply.
- `parsePurchaseVerdict(raw: string): PurchaseVerdict | null` — extract-first-JSON idiom from `analyze.ts`; clamp confidence 0–100; value must be finite > 0 else null; currency uppercased 3-letter else null; never throws.
- `syntheticPurchaseRaw(latestText: string): string` — dry-run JSON from markers.
- Constants above.

- [x] Failing tests: prompt contains excerpts/service/fields/media count & is deterministic; parse happy path; parse garbage → null; clamps; synthetic marker matrix.
- [x] Implement minimal lib; tests pass; commit.

### Task 2: `seedStageConversionEvent` refactor (behavior-preserving)

**Files:** Modify `convex/funnel.ts:102-155` (extract the attribution→eventName→dedup→insert→schedule block).

**Produces:** `export async function seedStageConversionEvent(ctx: {db; scheduler}, args: {accountId: Id<"accounts">; conversation: Doc<"conversations">; stage: FunnelStageKey; value?: number; currency?: string}): Promise<{conversionEventId: Id<"conversionEvents"> | undefined}>` — returns existing row id on eventId hit (no re-schedule); `undefined` when unattributed / stage unmapped / identifier missing. `applyStageTransition` delegates to it (passes `hasValue ? saleValue : undefined`).

- [x] Extract; existing `funnel.test.ts` + engine suite stay green untouched; commit.

### Task 3: Schema + config plumbing

**Files:** Modify `convex/schema.ts` (qualificationConfigs `purchaseSignalsEnabled: v.optional(v.boolean())`; qualificationSessions `purchase` object per spec §3.5; notifications type union + `purchase_signal`), `convex/lib/qualification/validate.ts` (patch key + boolean check), `convex/lib/qualification/defaults.ts` (`purchaseSignalsEnabled: false`), `src/lib/notifications/shared.ts` (+ any client NotificationType union — follow the `lead_qualified` trail) with a 💰-appropriate lucide icon.

- [x] Config-patch test in `convex/qualification.test.ts` (round-trips the new key; rejects non-boolean); suite green; commit.

### Task 4: Engine — context, action, verdict, triggers

**Files:** Modify `convex/qualificationEngine.ts`, `convex/ingest.ts` (none — trigger rides `onInbound`), tests in `convex/qualificationEngine.test.ts`.

**Produces (internal API, same module):**
- `loadPurchaseContext` internalQuery `{accountId, conversationId}` → `null` | `{sessionId, contactId, serviceName, fields: {key,label?,value}[], score, summary, boundary: number | null, customerPhone: string}` — gate order: enabled config + `purchaseSignalsEnabled === true` → conversation open & `attribution` with identifier → staff guard (`loadStaffPhoneSet`/`isStaffNumber`) → latest session `qualified` → `purchase?.status !== "sent"` → within `PURCHASE_EVAL_WINDOW_MS` of `qualifiedAt` → debounce vs `purchase.evaluatedAt`.
- `evaluatePurchase` internalAction `{accountId, conversationId}` — context → `aiConfig.loadDecrypted` (`isActive` required) → `recentMessages` (boundary-filter via `createdAt` like `analyzeInbound`) → `toChatMessages` + `customerMediaCount` from rows (`senderType === "customer" && contentType !== "text"`) → `hasKnowledgeChunks` gate → `aiKnowledge.retrieve({queryText: "PURCHASE CRITERIA <service> <latest>"})` → dry-run / `generateReply` (+ usage log mode `"qualify"`) → `parsePurchaseVerdict` → `applyPurchaseVerdict`. Never-throw discipline.
- `applyPurchaseVerdict` internalMutation `{accountId, conversationId, verdict}` → `{fired: boolean}` — transactional recheck (config, latest qualified session, not sent, attributed); fire = `met && confidence >= MIN && criteriaFound`; on fire: `seedStageConversionEvent(stage:"purchased", value?, currency ?? account.defaultCurrency)`; stamp `session.purchase` sent (incl. `conversionEventId`); `purchase_signal` notifications via `recipientsForInbound` (memberships collect, mirror `completeQualification`); else stamp `not_met`.
- Trigger A: `completeQualification` tail — `scheduler.runAfter(0, evaluatePurchase)` when `config.purchaseSignalsEnabled === true`.
- Trigger B: `onInbound` — after follow-up arming, when latest session `qualified` && enabled && not sent && in window ⇒ schedule `evaluatePurchase` (covers media inbounds).

- [x] Test battery (dry-run + convex-test, mirroring the file's existing harness): happy-path fire (row stage/eventId/lane/value + session stamp + notification + `conversation.funnel` UNCHANGED); not-met then re-eval fires later; idempotency both orders (proxy-then-agent links row & no 2nd insert; agent-then-proxy no-ops); gates (disabled / organic / non-qualified / window expiry); media-caption trigger path; confidence floor.
- [x] Suite green; commit.

### Task 5: Manual fire + read surfaces

**Files:** Modify `convex/qualification.ts`.

**Produces:** `sendPurchaseSignal` accountMutation `{sessionId}` — `ctx.requireRole("supervisor")`; session qualified & not sent; conversation attributed else `BAD_REQUEST reason:"not_attributed"`; seeds with last verdict's value when present; stamps `manual: true`. `getSessionForConversation` + `leadsBoard` rows expose `purchase` projection `{status, confidence, reasons, value, currency, sentAt, manual}`.

- [x] Tests: role gate (agent rejected, supervisor fires), unattributed rejection, board projection; commit.

### Task 6: UI + i18n

**Files:** Modify `src/components/settings/qualification-settings.tsx` (new "Purchase signals" card: Switch → `updateConfig {purchaseSignalsEnabled}`, strictness + doc-format hint copy), `src/components/leads/leads-board-view.tsx` (💰 badge on `purchase.status === "sent"`; detail-pane verdict block; supervisor+ "Send purchase signal" button → `api.qualification.sendPurchaseSignal`), `messages/en.json`.

- [ ] `tsc` + `eslint` + `next build` green; suite green; commit.

### Task 7: Registry + owner content + docs

**Files:** Modify `convex/_generated/api.d.ts` (add `lib/qualification/purchase` import + both map entries, alpha-ordered); append paste-ready `PURCHASE CRITERIA — <Service>` sections (6 services + intro note) to `/Volumes/CurserDisk/Dev/wacrm2.0/holidayys-ai-agent/agent-content.md` (outside the repo).

- [x] Full verification: `npx vitest run` (all green), `npx tsc --noEmit` (0), `npx eslint .` (0 new), `npx next build` (green); commit.

### Task 8: Ship (backend-first)

- [ ] Push branch, open PR with spec summary + dormancy note.
- [ ] `git merge origin/main` (deploy-collision rule); copy `.env.local` from the main checkout into the worktree; `npx convex deploy -y`; commit any `_generated` reconciliation.
- [ ] Merge PR → Netlify; verify function-spec lists the new engine functions + live site 200/307s.
