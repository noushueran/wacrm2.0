# Knowledge Studio — Phase 2a (Authoring Surface) Design

**Status:** Approved in brainstorming 2026-07-19. Implementation plan to follow.
**Depends on:** Knowledge Engine v2 Phase 1 (merged to `main` @ 5979d03, PR #39) — tables
`kbServices` / `kbEntries` / `kbOpsBlocks` / `kbChunks`, the compiler, and the merged retrieval path.
**Branch:** `feat/knowledge-studio`, worktree `.claude/worktrees/feat-knowledge-studio`, off `origin/main` @ 5979d03.

## Goal

Give admins a real workspace for authoring structured knowledge, replacing the flat
"paste a document" card. One sentence: **a service-oriented studio where you can see at a
glance which services are ready for the AI engines, and edit the content that makes them
ready.**

## Why this exists

Phase 1 built the structured backend but shipped it dormant — there is currently **no way to
create a `kbService`, `kbEntry`, or `kbOpsBlock` from the UI at all**. The only knowledge UI is
`AiKnowledgeCard`, which pastes free text into the legacy `aiKnowledgeDocuments` table and is
buried at line 415 of the 15KB `src/components/settings/ai-config.tsx`.

The owner has committed to **retiring the legacy documents once content is migrated**
(brainstorming decision, 2026-07-19). That makes the studio the sole authoring surface, so it
must be complete enough to author everything before Phase 2b can delete anything.

## Decisions taken in brainstorming (do not re-litigate)

1. **Placement:** a fourth tab, `Knowledge`, on `/agents` — not a new top-level route, not a
   Settings section.
2. **Legacy documents:** retire once migrated. 2a keeps them visible and editable; 2b builds the
   gated deletion.
3. **Scope:** 2a is the **authoring surface only**. The import wizard, draft review queue,
   migration progress, gated legacy deletion, and retrieval verification are **Phase 2b**.
4. **Readiness rule:** a service is `ready` when it has a **published overview entry**, a
   **published qualification ops block whose marks total exactly 100**, and **published purchase
   criteria**. Everything else (FAQ, requirements, policy, itinerary, sales checklist) displays as
   status but does not block the badge.
5. **Navigation:** matrix landing → drill into a full-width service detail view (Option B).

## Non-goals

- No import wizard, no draft review queue, no migration progress, no legacy deletion (Phase 2b).
- No retrieval test console or grounding display (Phase 2b).
- No changes to any AI engine, to `aiKnowledge.retrieve`, or to the compiler. 2a is UI plus one
  new read-only query.
- No package-scope entry UI. `kbEntries` supports `scope: "package"` in the schema, but no UI
  surfaces it in 2a; entries are company- or service-scoped only.
- No reordering of `kbServices.sortOrder` by drag. The field exists and is respected for display
  order; editing it is a numeric input, not a drag interaction.

---

## Architecture

### Shell and routing

`src/app/(dashboard)/agents/page.tsx` gains a `knowledge` tab between `playground` and `setup`.
Its `Tab` union widens to `'playground' | 'knowledge' | 'setup' | 'usage'`.

Today the page holds tab state in local `useState` with a render-time adjustment that lands
first-time users on Setup:

```tsx
if (!decided && configDoc !== undefined) {
  setDecided(true);
  setTab(configDoc ? 'playground' : 'setup');
}
```

That render-time-adjust pattern is deliberate (the file documents why an effect would be wrong,
and this repo's eslint config rejects the useRef-latch alternative). **Preserve it exactly.**

Add URL synchronisation on top, matching what `/settings` already does with `?tab=`:

- `?tab=knowledge` selects the tab; `?service=<key>` selects a service's detail view.
- Writing the URL uses a **shallow** replace (the pattern established for the inbox's chat
  selection) so switching services does not remount the page or refetch.
- The existing first-visit landing logic wins only when there is no `?tab=` in the URL — a
  deep link must never be overridden by the "land on Setup" rule.

**Role gating.** All five `kbServices` / `kbEntries` / `kbOps` read functions are
`ctx.requireRole("admin")` (Phase 1 RBAC fix). The tab is therefore admin-only: hidden for
non-admins, exactly as the `usage` tab is hidden via `canViewUsage`.

> **Repo-specific hazard — must be handled.** This app has no error boundary and no `error.tsx`.
> A Convex `useQuery` that throws surfaces the error during render, so firing an admin-only query
> before `accountRole` has resolved crashes the page to Next's unhandled-exception screen instead
> of redirecting. `accountRole` is `null` while the profile loads. **Every query in the studio must
> use the skip pattern**: `useQuery(api.knowledge.studioOverview, isAdmin ? {} : 'skip')`, where
> `isAdmin` is false while the role is still `null`. Precedent in repo: `campaigns/page.tsx`.

### Data flow — one lean query, not three

The matrix needs data from three tables. Calling the three existing list queries would work but
drags **every entry's full `body` text** across the wire to render status dots — the same class
of waste the Phase 1 review flagged when `getKbChunksByIds` was returning 1536-float embeddings
for data it discarded.

Add one new read-only query:

**`convex/knowledge.ts` → `api.knowledge.studioOverview`** (`accountQuery`, `requireRole("admin")`, args `{}`)

Returns:

```ts
{
  services: Array<{
    key: string;
    name: string;
    aliases: string[];
    status: "active" | "paused";
    sortOrder: number;
    // presence/state per content type — NO bodies
    entries: {
      overview:     SlotStatus;
      faq:          SlotStatus;
      itinerary:    SlotStatus;
      requirements: SlotStatus;
      policy:       SlotStatus;
      process:      SlotStatus;
      note:         SlotStatus;
    };
    ops: {
      qualification: OpsSlotStatus;
      sales:         OpsSlotStatus;
      purchase:      OpsSlotStatus;
    };
    verdict: "ready" | "blocked" | "draft" | "empty";
  }>;
  companyEntryCount: { draft: number; published: number };
}
```

where

```ts
type SlotStatus    = { published: number; draft: number };            // counts only
type OpsSlotStatus = { state: "published" | "draft" | "absent"; marksTotal: number | null };
```

`marksTotal` is `null` for `sales` and `purchase` (marks are a qualification-only concept) and the
sum of `criteria[].marks` for `qualification`.

**Read discipline.** Exactly three index-backed reads scoped to `ctx.accountId`:
`kbServices.by_account`, `kbEntries.by_account`, `kbOpsBlocks.by_account`. **No `.filter()`
anywhere** — per the repo-wide rule, `.filter()` never narrows the scan and `.take(n)` stops at n
*matches*, not n reads; that combination took `/settings?tab=cron` down. Grouping happens in memory
after the indexed reads.

Deliberately **not** returned: any count of legacy `aiKnowledgeDocuments`. The legacy section
renders the existing `AiKnowledgeCard`, which already runs `aiKnowledge.list` and knows its own
count; duplicating it here would add a fourth read for data the page already has. Migration
progress is Phase 2b's concern.

**Verdict computation lives in a pure function**, `src/lib/knowledge/verdict.ts`, not inside the
Convex handler — so it is unit-testable without a backend and reusable by the matrix:

```ts
export function serviceVerdict(input: {
  overviewPublished: boolean;
  qualification: { state: "published" | "draft" | "absent"; marksTotal: number | null };
  purchase: { state: "published" | "draft" | "absent" };
}): "ready" | "blocked" | "draft" | "empty";
```

- `empty` — nothing authored at all for this service.
- `ready` — overview published **and** qualification published with `marksTotal === 100` **and**
  purchase published.
- `draft` — content exists but only as drafts; nothing published yet.
- `blocked` — something is published but a required slot is missing, unpublished, or (for
  qualification) published with marks not totalling 100.

Mutations reuse the **existing Phase 1 functions unchanged**: `kbServices.upsert` / `remove`,
`kbEntries.save` / `publish` / `unpublish` / `remove`, `kbOps.save` / `publish` / `unpublish`.
2a adds no new mutations.

---

## Components

All under `src/components/knowledge/`. Presentational components take plain props and hold **no
Convex hooks**, so they can be rendered against mock data in a temp preview route for browser
verification (the pattern used for `/preview-leads` and `/preview-pipeline`).

| File | Responsibility | Convex? |
|---|---|---|
| `knowledge-studio.tsx` | Tab root. Owns the selected-service state, runs `studioOverview`, switches between matrix and detail. | yes |
| `service-matrix.tsx` | Presentational. Services × six columns + verdict badges + "new service" affordance. | no |
| `service-detail.tsx` | Presentational shell for one service: header, verdict, section list, delegates to editors. | no |
| `entry-editor.tsx` | Create/edit one `kbEntry`: type, title, body, audience; save-draft / publish / unpublish / delete. | no |
| `checklist-editor.tsx` | Create/edit one `kbOpsBlock`, parameterised by `kind`. Rows with add/remove/reorder; qualification adds a marks column and a live total gauge. | no |
| `service-form.tsx` | Create/edit a `kbService`: key, name, aliases, routing tag, status, sort order. | no |
| `legacy-documents.tsx` | The relocated `AiKnowledgeCard`, wrapped in a collapsed section labelled as the legacy system. | yes (existing) |

`src/lib/knowledge/verdict.ts` holds the pure verdict + marks-total logic.

### Which columns the matrix shows

`kbEntries` supports seven `type` values and `kbOpsBlocks` three `kind` values — ten slots in
total. A ten-column grid is unreadable, so the matrix shows **six**:

| Column | Source | Why |
|---|---|---|
| Overview | entry `type: "overview"` | Required for `ready`. |
| FAQ | entry `type: "faq"` | The type most services accumulate most of. |
| Requirements | entry `type: "requirements"` | Visa/document rules — the most commonly asked-about content for this business. |
| Qualification | ops `kind: "qualification"` | Required for `ready`; shows its marks total. |
| Sales | ops `kind: "sales"` | Drives the per-lead sales checklist. |
| Purchase | ops `kind: "purchase"` | Required for `ready`; its absence silently costs Meta Purchase events. |

The remaining entry types — `itinerary`, `policy`, `process`, `note` — are returned by
`studioOverview` and are fully editable in the service detail view; they simply do not get their
own matrix column. Their presence is conveyed on the service row as a single "+N more" count so
nothing is invisible.

**`AiKnowledgeCard` moves, it does not change.** It is lifted out of `ai-config.tsx` (removing the
import at line 28 and the render at line 415) and rendered inside the Knowledge tab instead. Its
own props (`canEdit`, `hasEmbeddingsKey`) and internals stay as they are. `ai-config.tsx` shrinks;
no other behaviour moves with it.

### The checklist editor is the load-bearing component

One component serves all three ops kinds because the three differ only in row shape:

- **qualification** — rows are `{ key, label, question?, marks }`; shows a marks column and a
  running total with a sum-to-100 gauge.
- **sales** — rows are `{ key, label, description? }`.
- **purchase** — rows are `{ key, label }`, plus optional `reportValue` + `currency` fields.

Row `key` is generated from the label by slugifying it, deduped with a numeric suffix on collision
— the same rule `kbImport` uses, so hand-authored and imported blocks are shaped identically.
Keys are stable once created: editing a label does not rewrite its key, because the key is what
downstream data (and any future per-criterion analytics) would join on.

### Validation mirrors the backend and never replaces it

The editors call the pure `lintOpsBlock` / `lintEntryInput` from `convex/lib/kb/lint.ts` to render
inline messages against the same `code` strings the server uses. But:

- **Save stays permissive.** The backend deliberately blocks `save` only on shape errors
  (`label_required`, `key_duplicate`) so a half-finished checklist can be parked as a draft. The UI
  matches: save is enabled unless a shape error exists.
- **Publish is gated.** The publish button disables when any error-level issue exists — most
  visibly `marks_sum` when the qualification total isn't 100.
- **The server remains authoritative.** Every mutation's `ConvexError` is caught and its
  `reason` / `issues` surfaced to the user. A UI that thinks a save is legal but the server rejects
  must show the server's reason, never a generic failure.

`price_mention` is warning-level and customer-audience-only; it renders as an advisory note on the
entry editor, not a blocker — it exists because this business routes all cost conversations to a
human, and legitimate phrases like "no hidden fees" would otherwise be blocked.

---

## Error handling

| Situation | Behaviour |
|---|---|
| Role still loading (`accountRole === null`) | Queries are `'skip'`ped; the tab renders a skeleton. Never fires an admin query before the role resolves. |
| Non-admin | The Knowledge tab is not rendered at all, mirroring how `usage` is hidden. |
| Mutation rejected by a server gate | Catch the `ConvexError` and surface its `reason` (e.g. `service_in_use`) or its `issues[]` inline on the offending field. Never a bare "something went wrong". |
| Deleting a service that still has content | `kbServices.remove` throws `BAD_REQUEST / service_in_use`; the UI explains that its entries and checklists must be removed first. |
| `?service=` names a service that doesn't exist | Fall back to the matrix and drop the param, rather than rendering an empty detail view. |
| Account has no services yet | The matrix renders an empty state whose primary action is "Add your first service". |

---

## Testing and verification

**Unit (vitest).** `src/lib/knowledge/verdict.ts` — every verdict branch, including the
qualification-published-but-marks-are-90 case that must read `blocked`, and the
nothing-authored case that must read `empty`. Marks-total arithmetic including the
all-criteria-lack-marks case (which must not claim a total).

**Convex (convex-test).** `api.knowledge.studioOverview` — shape correctness, per-service grouping,
verdict values end-to-end, admin gating, and cross-account isolation (a second account's services
must not appear). Follows the established suite scaffolding: `import.meta.glob("/convex/**/*.ts")`
and a per-suite duplicated `seedAccountMember` helper.

**Browser verification before ship.** `/agents` is auth-gated, so verification uses the temp public
preview route pattern this repo has used twice: a route rendering the presentational components
against mock data, checked at desktop and mobile widths in both light and dark, then deleted before
merge. Note for whoever does it: light mode is `document.documentElement.dataset.mode = 'light'`
(the app keys off `html[data-mode]`, **not** a `.dark` class), and non-dashboard routes auth-bounce
to `/` after roughly 20 seconds — re-navigate when that happens.

**Gate before merge.** `npm test`, `npm run typecheck`, `npm run build` all green; `npm run lint`
at the pre-existing baseline of 0 errors / 15 warnings (this repo carries known lint debt — the bar
is "adds no new findings", not "globally clean").

---

## Deployment

`api.knowledge.studioOverview` is a **new Convex function**, so:

- Register it by hand-editing `convex/_generated/api.d.ts` (import line + record member, in true
  alphabetical position). **Never run `npx convex dev` / `deploy` / `codegen` during
  development** — this project has one self-hosted Convex instance and all three push straight to
  production.
- Shipping requires an owner-gated `npx convex deploy` **before** the Netlify merge, with
  `origin/main` merged into the deploying tree first (the deploy replaces the full function set;
  deploying a stale tree has previously stomped another branch's functions for ten minutes).

Unlike Phase 1, **this phase is not dormant** — it puts a visible tab in front of admins. But it
only exposes authoring; no engine reads structured content until Phase 3.

## Open items deliberately deferred

- **Phase 2b** owns: import wizard over `kbImport.preview` / `apply`, draft review queue, migration
  progress, gated legacy deletion, retrieval verification.
- **Phase 3** owns the engine cutover and will remove the `Math.ceil(k / 2)` compiled-pool budget
  in `aiKnowledge.retrieve` once the legacy pool is retired — that guard exists only for the
  migration window.
