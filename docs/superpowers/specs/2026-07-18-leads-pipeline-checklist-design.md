# Leads: post-qualification sales checklist + deals pipeline — design

**Date:** 2026-07-18 · **Owner ask:** every lead gets a sales checklist the salesperson must
follow after qualification (checklist defined in the product knowledge base → AI generates it
and posts it on every lead; completing a task requires a comment, saved where the AI can
process it), plus a drag-and-drop deals pipeline every lead goes through before closing —
closing as lost requires stating exactly why. `/leads` becomes a compact pipeline dashboard.

## Decisions (with alternatives considered)

1. **Pipeline = the existing funnel** (`convex/lib/funnel.ts`), not the legacy
   `pipelines`/`pipelineStages`/`deals` tables (OSS-template leftovers shown read-only in the
   contact sidebar) and not a new stage machine. The funnel is already the single source of
   stage truth, denormalized on `conversations.funnel`, audited in `funnelTransitions`, and
   wired to Meta conversion events. Dragging a card IS `funnel.setStage` — pipeline moves
   keep feeding Meta (`QualifiedLead` → `InitiateCheckout` → … → `Purchase`) for free.
   *Rejected:* reviving legacy deals tables (duplicate stage truth, no Meta wiring); a
   per-account configurable pipeline (YAGNI — the funnel is the business's real pipeline).
2. **New terminal stage `lost`** appended LAST in `FUNNEL_STAGES` (`metaCapi: null`,
   `webPixel: null` — Meta's business-messaging vocabulary has no "lost" event; internal
   CRM state only). Appending last keeps `neverDowngrade` index math safe: the engine
   (new_lead/qualified, auto) can never pull a lost deal back. `setStage("lost")` requires
   a loss reason: fixed category union + free-text detail (≥ 5 chars) — "exactly why".
   Reasons are written to the `funnelTransitions` audit row (new optional fields), the
   checklist row's `outcome`, and a `contactNotes` row.
3. **Won gate:** `setStage("purchased")` throws `BAD_REQUEST/checklist_incomplete` when the
   conversation's latest qualification session has a sales checklist with unfinished items.
   Server-side, so the inbox dropdown and the kanban obey the same rule for every role
   ("every salesperson has to follow completely"). Conversations with no checklist (organic,
   pre-feature) are not gated. Lost is NOT checklist-gated (you can lose before pitching) —
   the loss-reason requirement is its gate.
4. **Checklist storage: one `salesChecklists` row per qualification session**, items as an
   embedded array (≤ 12, atomic patches). The session (not the conversation) is the lead —
   v3 multi-lead safe. Indexes `by_session`, `by_account`.
5. **Checklist source: KB-driven with a deterministic fallback.** On
   `completeQualification`, a scheduled internal action retrieves `SALES CHECKLIST
   <service>` excerpts via `aiKnowledge.retrieve` (mirror of the QUALIFICATION CHECKLIST
   sentinel pattern) and asks the account's LLM for a strict-JSON task list; any failure or
   missing KB/AI falls back to the built-in 6-step Holidayys checklist (call → pitch →
   offer price → negotiate → follow up → win back objections). A checklist is therefore
   ALWAYS posted on every qualified lead. Idempotent per session. Dry-run env
   (`CONVEX_AI_DRY_RUN`) makes tests deterministic. `aiUsageLog.mode` gains `"checklist"`
   (schema + `aiUsage.log` validator + agents usage tile typed record — the tile indexes
   `byMode[row.mode]`, an unknown mode would crash it). A `backfill` internal mutation
   creates default checklists for already-qualified sessions (owner runs once post-deploy).
   The drafted KB section is appended to `holidayys-ai-agent/agent-content.md` for the
   owner to paste (same delivery as qualification checklists).
6. **Completing a task requires a comment.** `salesChecklists.setItemDone` rejects an
   empty/short note. The note lands on the item (`note`, `doneByUserId`, `doneAt`) AND as a
   `contactNotes` row (`✅ Checklist — <title>: <note>`) — contactNotes is the established
   AI-processable trail (agent WhatsApp feedback already goes there). Reopening writes a
   `↩️` note. Won/lost/reopen outcomes write notes too. Access mirrors `funnel.setStage`:
   `requireRole("agent")` + `requireConversationAccess(…, "own")` (agents only their own
   assigned leads; supervisor+ any; viewers read-only).
7. **UI: `/leads` gets a List | Pipeline toggle** (localStorage-persisted). Pipeline =
   compact kanban over the deal stages (Qualified → Price quoted → Itinerary created →
   Itinerary sent → Invoice sent → Won → Lost) showing only `status === "qualified"`
   sessions, grouped by effective stage = max(conversation stage, qualified); Won column
   shows sale value. HTML5 native drag-and-drop (no new dependency) + a per-card "Move to"
   menu (touch fallback). Drops to Won open the existing sale-value dialog; drops to Lost
   open the loss-reason dialog; `checklist_incomplete` surfaces as a toast + opens the
   card's checklist. Card click → dialog with the existing LeadDetail + the checklist
   panel. The checklist panel also renders inside the List view's expandable detail, and
   rows get a checklist x/y progress chip. The inbox thread-header stage dropdown gains
   "Lost" with the same loss dialog. `buildFunnelSteps` (sidebar stepper) hides `lost`
   unless reached/current (terminal flag) — it's an exit, not a step. The campaigns
   funnel-by-stage card picks up the Lost row automatically.
8. **Dashboard:** compact per-stage pipeline strip card on `/dashboard` (supervisor+/agent —
   same `leadsBoard` cached query the leads page subscribes to, so no new backend and the
   ConvexQueryCacheProvider dedupes), linking to `/leads` pipeline view. Hidden for viewers
   (query is role-gated) and when there are no deals.

## Schema (additive only — `npx convex deploy` BEFORE the Netlify merge)

```ts
salesChecklists: defineTable({
  accountId: v.id("accounts"),
  sessionId: v.id("qualificationSessions"),
  conversationId: v.id("conversations"),
  contactId: v.id("contacts"),
  source: v.union(v.literal("kb"), v.literal("default")),
  items: v.array(v.object({
    key: v.string(), title: v.string(), description: v.optional(v.string()),
    done: v.boolean(), doneAt: v.optional(v.number()),
    doneByUserId: v.optional(v.id("users")), note: v.optional(v.string()),
  })),
  outcome: v.optional(v.object({
    result: v.union(v.literal("won"), v.literal("lost")),
    lossCategory: v.optional(v.string()), lossDetail: v.optional(v.string()),
    at: v.number(), byUserId: v.optional(v.id("users")),
  })),
  generatedAt: v.number(),
}).index("by_session", ["sessionId"]).index("by_account", ["accountId"]),
```

- `conversations.funnel.stage` + `funnelTransitions.stage` unions gain `"lost"`;
  `funnelTransitions` gains optional `lossCategory`/`lossDetail`; `aiUsageLog.mode` gains
  `"checklist"`. `funnel.setStage` args gain optional `lossCategory`/`lossDetail`
  (backend deploys first → old clients simply never send them).
- Loss categories (shared const): `price`, `competitor`, `budget`, `timing`,
  `unresponsive`, `changed_plans`, `other`.

## Surfaces

- `convex/lib/salesChecklist.ts` — DEFAULT_SALES_CHECKLIST, LOSS_CATEGORIES,
  `parseChecklistGeneration` (strict JSON → clamped items | null), `allItemsDone`. Pure.
- `convex/salesChecklists.ts` (new module → 2-line `_generated/api.d.ts` hand-edit):
  `setItemDone` / `reopenItem` (accountMutations), internal `generationContext` (query),
  `insertChecklist` (mutation, idempotent), `generateForSession` (action),
  `backfill` (mutation).
- `convex/funnel.ts` — stage validator + gates + outcome/notes writes;
  `applyStageTransition` passes loss fields through to the audit row.
- `convex/qualificationEngine.ts` — `completeQualification` schedules
  `salesChecklists.generateForSession` (one added scheduler line).
- `convex/qualification.ts` — `leadsBoard` rows gain `funnelStage`, `saleValue`,
  `saleCurrency`, `checklist {source, doneCount, total, outcome, items[…, doneByName]}`
  (one extra indexed `.first()` per rendered lead, same caps).
- `src/lib/inbox/funnel.ts` (+`lost`, `terminal` flag) · `src/lib/inbox/funnelView.ts`
  (hide unreached terminal) · `src/lib/leads/pipeline.ts` (stage grouping, pure) ·
  `src/components/leads/lead-checklist.tsx` · `src/components/leads/leads-pipeline-view.tsx`
  · `leads-board-view.tsx` (toggle + chip + detail wiring; stays mock-renderable — the
  page injects mutation callbacks) · `message-thread.tsx` (Lost dialog + gate toast) ·
  `src/components/dashboard/pipeline-card.tsx` · `messages/en.json`.

## Testing

convex-test: checklist CRUD + note-required + RBAC + contactNotes; generation fallback /
idempotency / dry-run parse; backfill; setStage lost (reason required, audit fields,
outcome, terminal vs engine downgrade) and purchased gate; leadsBoard payload. Vitest for
the pure libs (parse, pipeline grouping, funnelView terminal). Full gates: tsc, eslint,
vitest, next build. Browser-verify via a temp public preview route (registered in the
OUTER `.claude/launch.json` preview registry), desktop+mobile × light+dark, deleted
before merge.
