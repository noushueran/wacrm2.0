# Lead Qualification P1 — Analysis Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every inbound text, an LLM pass identifies the service, pulls that service's QUALIFICATION CHECKLIST from the knowledge base, extracts answers with per-criterion marks (0–100 score), detects intent (opt-out / wants-human / disqualified), pre-writes the next question + alternates, and steers the existing AI assistant — plus the inbox progress chip and the checklist sections authored into the KB drafts.

**Architecture:** Pure logic in `convex/lib/qualification/analyze.ts` (prompt build, never-throw parse, merge, marks clamp) mirrored on `lib/ai/classify.ts`. Engine: `qualificationEngine.analyzeInbound` (internalAction) → `loadAnalysisContext` (internalQuery) → `generateReply` on the account's BYO key → `applyAnalysis` (internalMutation). Steering: `buildSystemPrompt` gains an optional `qualification` block fed by `qualificationEngine.getObjectives`. Wired into `ingest.processInbound` after Flows, before automations + AI reply. Status stays `collecting` in P1 — completion side-effects are P2; readiness is recorded as `checklistSatisfiedAt`.

**Tech Stack:** unchanged (Convex, convex-test/vitest, existing `generateReply` provider adapters, `CONVEX_AI_DRY_RUN`).

## Global Constraints

- Same as P0 (no convex CLI against prod; hand-edit `_generated/api.d.ts`; dormant behind `enabled`; TDD; worktree `feat/lead-qualification`).
- Analysis must be **best-effort and passive**: any failure leaves the assistant/flows/human reply path untouched; extraction runs regardless of `aiAutoreplyDisabled` (human-led chats keep tracking) but never when the session is terminal.
- No LLM call may happen without an active `aiConfigs` row (`isActive`); `autoReplyEnabled` is NOT required (extraction ≠ replying).
- Token spend logs via `aiUsage.log` with a new `"qualify"` mode (schema union + validator widened — additive, nothing deployed yet).

---

### Task 1: Schema additions (checklistSatisfiedAt + aiUsageLog "qualify" mode)

**Files:** Modify `convex/schema.ts`, `convex/aiUsage.ts`. Test: extend `convex/qualification.test.ts` schema round-trip with `checklistSatisfiedAt` + an aiUsageLog insert with mode `"qualify"`.

- [ ] Step 1: failing test — in the existing schema round-trip test, add `checklistSatisfiedAt: 123` to the `qualificationSessions` insert and a `ctx.db.insert("aiUsageLog", { accountId, mode: "qualify", provider: "openai", model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2 })` (match the table's actual required fields — check schema block first).
- [ ] Step 2: run → FAIL. 
- [ ] Step 3: schema — add to `qualificationSessions` after `answeredCount`: `checklistSatisfiedAt: v.optional(v.number()),` (readiness marker: set when checklist satisfied + score ≥ threshold + ≥3 answers; P2's completion consumes it). Widen `aiUsageLog.mode` union with `v.literal("qualify")` and the same literal in `convex/aiUsage.ts` `log` args.
- [ ] Step 4: run → PASS (+ `convex/aiUsage.test.ts`). Commit `feat(qualification): readiness marker + qualify usage mode`.

### Task 2: Pure analysis lib (`convex/lib/qualification/analyze.ts`)

**Files:** Create `convex/lib/qualification/analyze.ts`, test `convex/lib/qualification/analyze.test.ts`.

**Interfaces (produced):**
```ts
export interface AnalysisField { key: string; label?: string; value: string; confidence: "high"|"medium"|"low" }
export interface AnalysisResult {
  serviceName: string | null;
  fields: AnalysisField[];
  score: number;                       // clamped 0–100
  scoreBreakdown: { criterion: string; marks: number; maxMarks: number; reason?: string }[];
  checklistSatisfied: boolean;
  expectedCount: number;               // >= 1
  nextQuestion: { key: string; text: string; alternates: string[] } | null; // alternates capped at 3
  intent: "none" | "opt_out" | "wants_human" | "disqualified";
  summary: string | null;
}
buildAnalysisPrompt(args: { checklistExcerpts: string[]; basicFields: Doc<"qualificationConfigs">["basicFields"]; knownFields: {key:string; value:string}[] }): string
parseAnalysis(raw: string): AnalysisResult | null     // never throws; null when no JSON object found
mergeFields(existing: SessionField[], extracted: AnalysisField[], now: number): SessionField[]  // high/medium overwrite; low fills blanks only
countAnswered(fields: SessionField[]): number          // confidence high|medium only
```

- [ ] Step 1: failing tests covering — prompt contains checklist excerpts + known fields + the exact JSON shape line; parse: happy path, fenced ```json, prose-wrapped, missing keys (defaults: intent "none", score clamp 0–100, expectedCount floor 1, alternates capped 3, non-string entries dropped), garbage → null; merge: high overwrites, low never overwrites, low fills blank, updatedAt stamped; countAnswered ignores "low".
- [ ] Step 2: FAIL. Step 3: implement (JSON extraction via the `classify.ts` `indexOf("{")`/`lastIndexOf("}")` idiom). The prompt must instruct: identify the service; use ONLY the checklist for questions+marks (fall back to the basic fields when no checklist matches); extract every answered item from the WHOLE conversation; assign marks per criterion honestly; detect intent; propose the ONE next question with 2 alternate phrasings; output ONLY JSON in the exact shape (spec §7's example embedded verbatim).
- [ ] Step 4: PASS. Commit `feat(qualification): pure analysis prompt/parse/merge lib (TDD)`.

### Task 3: Engine analysis pipeline

**Files:** Modify `convex/qualificationEngine.ts` (add `loadAnalysisContext` internalQuery, `applyAnalysis` internalMutation, `analyzeInbound` internalAction, `syntheticAnalysisRaw` dry-run helper), extend `convex/qualificationEngine.test.ts`. Hand-add nothing to api.d.ts (module already registered).

**Interfaces (produced):**
- `internal.qualificationEngine.analyzeInbound({ accountId, conversationId, contactId })` — best-effort, void.
- `internal.qualificationEngine.applyAnalysis({ accountId, conversationId, analysis })` → `{ wantsHuman: boolean }`.
- DRY-RUN (`CONVEX_AI_DRY_RUN`): `syntheticAnalysisRaw(latestText)` — deterministic JSON derived from markers in the latest customer message: `field:key=value;...` pairs → high-confidence fields; `[[COMPLETE]]` → checklistSatisfied true; `score:NN`; `[[STOP]]`→opt_out, `[[HUMAN]]`→wants_human, `[[DISQ]]`→disqualified; always proposes nextQuestion `{key:"travel_dates", text:"When are you planning to travel?", alternates:["Rough month works too — when are you thinking?"]}`.

Pipeline in `analyzeInbound` (all wrapped in one try/catch, console.error like `dispatchInbound`):
1. `loadAnalysisContext` → null unless: enabled config + session exists with status `collecting` + conversation open/pending + account match. Returns `{ config, session }`.
2. `aiConfig.loadDecrypted` → require `config.isActive` (NOT autoReplyEnabled).
3. `aiReply.recentMessages` (limit `aiContextMessageLimit()`) → `toChatMessages` → empty ⇒ return.
4. Checklist retrieval (best-effort): `hasKnowledgeChunks` then `aiKnowledge.retrieve({ queryText: "QUALIFICATION CHECKLIST " + (session.serviceName ?? "") + " " + latestUserMessage(messages) })`.
5. `buildAnalysisPrompt` + (dry-run ? synthetic : `generateReply`) + `parseAnalysis`; null ⇒ return.
6. `aiUsage.log` mode `"qualify"` (best-effort try/catch).
7. `applyAnalysis` — in one mutation: re-check session `collecting`; merge fields; `answeredCount = countAnswered(merged)`; `expectedCount = max(analysis.expectedCount, answeredCount)`; patch score/breakdown/serviceName/summary/pendingQuestion; readiness: `checklistSatisfied && score >= config.qualifyThresholdScore && answeredCount >= 3` ⇒ `checklistSatisfiedAt = now`. Intents: `opt_out` ⇒ status `opted_out` + `closedReason` + patch conversation `aiAutoreplyDisabled: true`; `disqualified` ⇒ status + reason; `wants_human` ⇒ return `{wantsHuman:true}` (no session change).
8. On `wantsHuman`: action calls `internal.aiReply.markHandoff` with `handoffAgentId` from the AI config and summary `"🤖 Customer asked for a human during qualification." + (analysis.summary ? " " + analysis.summary : "")`.

- [ ] Step 1: failing convex-test tests (dry-run env is already set for the suite? check how aiReply.test.ts sets `CONVEX_AI_DRY_RUN` — mirror it): fields extracted from marker message land merged with score; `[[COMPLETE]] score:80` + ≥3 fields ⇒ `checklistSatisfiedAt` set, status still `collecting`; `[[STOP]]` ⇒ session `opted_out` + conversation `aiAutoreplyDisabled`; `[[HUMAN]]` ⇒ conversation `aiAutoreplyDisabled` + status "pending" (markHandoff ran) while session stays `collecting`; no aiConfig row ⇒ no-op; terminal session ⇒ no-op.
- [ ] Step 2: FAIL → implement → PASS. Commit `feat(qualification): LLM analysis pipeline with marks + intents`.

### Task 4: Steering + ingest wiring

**Files:** Modify `convex/lib/ai/defaults.ts` (optional `qualification` arg), `convex/qualificationEngine.ts` (`getObjectives` internalQuery), `convex/aiReply.ts` (fetch + pass), `convex/ingest.ts` (analysis hook after Flows block, before automations). Tests: extend `convex/qualificationEngine.test.ts` (objectives shape) + a `buildSystemPrompt` unit test in `convex/lib/qualification/analyze.test.ts` or the existing defaults test file if present.

- `getObjectives({accountId, conversationId})` → `null` unless enabled config + `collecting` session; else `{ collected: {label, value}[], nextQuestion: string | null, expectedCount, answeredCount }` (label falls back to key; nextQuestion from `session.pendingQuestion?.text`, else the first unanswered required basic field's first phrasing).
- `buildSystemPrompt` new block (auto_reply mode only), appended AFTER the business context, BEFORE knowledge: "Lead qualification objective: collect the details below naturally, ONE question per reply, never as a form or checklist. Already provided (NEVER re-ask): label: value…. Next to ask: <q>. If the customer's latest message already answers it, acknowledge instead of re-asking. Answer their question first, then weave in the ask."
- `aiReply.dispatchInbound`: after the knowledge retrieval block, `const qualification = await ctx.runQuery(internal.qualificationEngine.getObjectives, { accountId, conversationId });` and pass `qualification: qualification ?? undefined` into `buildSystemPrompt`.
- `ingest.processInbound`: after the Flows block (so flow replies aren't delayed) and before the automations fan-out, add
  `if (inboundText.trim() && !message.interactiveReplyId) await runBestEffort("qualificationEngine.analyzeInbound", () => ctx.runAction(internal.qualificationEngine.analyzeInbound, { accountId, conversationId: res.conversationId, contactId: res.contactId }));`
  (note: `inboundText` is declared just above the automations block today — move its `const` declaration up beside `flowConsumed` so this hook can read it).
- [ ] TDD as above; regression `npx vitest run convex/aiReply.test.ts convex/ingest.test.ts`. Commit `feat(qualification): assistant steering + ingest analysis hook`.

### Task 5: Inbox progress chip

**Files:** Modify `convex/qualification.ts` (`getSessionForConversation` accountQuery via `requireConversationAccess(ctx, conversationId, "view")` → null | `{status, answeredCount, expectedCount, score, qualified: boolean}`), create `src/components/inbox/qualification-chip.tsx`, wire into `src/components/inbox/message-thread.tsx` header badges (after the ad-lead badge), en.json `Inbox.qualification.*` keys. Test: extend `convex/qualification.test.ts` (RBAC: viewer can read, agent blocked on colleague's assigned conversation — mirror existing conversation-access tests).

- Chip renders only when a session exists: `collecting` → `ClipboardCheck n/m` (+ `· 64` score when present, tooltip via `title=` listing status), `qualified` → ✓ label; terminal states render nothing (keep the header calm).
- Uses `useQuery` from `@/lib/convex/cached` like the thread's other queries; skip when no conversation id.
- [ ] TDD backend query; UI verified by tsc/eslint/build (repo convention). Commit `feat(qualification): inbox qualification progress chip`.

### Task 6: KB QUALIFICATION CHECKLIST sections (outside repo)

**Files:** Modify `/Volumes/CurserDisk/Dev/wacrm2.0/holidayys-ai-agent/agent-content.md` — append a `QUALIFICATION CHECKLIST — <service>` block to each service KB doc's content (KB list read first; packages/UAE visa/international visa/flights-hotels at minimum, derived from SOP Step 4 + behavior prompt), using the spec §4 format with marks that sum to 100 per service (e.g. UAE visa: nationality 20, visa type 20, inside/outside 15, dates 15, email 20, bonus travel ≤30 days +10). Also append a short "How checklists drive the AI" note at the top of PART 2 explaining the format for the owner.
- [ ] No tests (docs). Commit is N/A (file is outside the app repo — report it in the final summary instead).

### Task 7: Verification

- [ ] `npx vitest run` full green; `npx tsc --noEmit` 0; `npm run lint` 0 errors; `npm run build` green. Commit stragglers.

## Self-review
- Spec §4 (doc-driven + fallback) → Tasks 2/3/6; §7 (analysis JSON, marks, intents, steering) → Tasks 2/3/4; §7 reply-cap note untouched (follow-ups are P3); inbox chip (§10) → Task 5; readiness w/o completion (P2 boundary) → checklistSatisfiedAt. No placeholders; signatures consistent (AnalysisResult consumed by applyAnalysis validator-shaped arg).
