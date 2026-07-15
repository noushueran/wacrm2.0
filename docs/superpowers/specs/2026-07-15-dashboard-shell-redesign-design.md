# Dashboard + app-shell redesign — design

Date: 2026-07-15
Status: Approved (brainstorming), pending spec review
Branch: `worktree-feat-dashboard-redesign` (off `origin/main` @90d8435)

## Goal

Enhance `/dashboard` and the shared app shell for **performance, UI quality,
useful analytics, and correct light/dark contrast**, per the owner's request:

1. Curate the dashboard to **operational, act-on-it-daily** analytics.
2. **Sidebar** defaults to a collapsed icon rail; hovering (or keyboard focus)
   floats the full menu as an **overlay** over content; a **pin** locks it open.
3. **Brand** ("Holidayys WA CRM" + mark) moves out of the collapsing sidebar
   corner into the **header**, always visible.
4. Every element uses **theme tokens** so it reads correctly in both modes.

The theme system itself (two axes: `data-mode` light/dark × `data-theme` accent,
OKLCH tokens, no-flash boot script) is sound and stays. The contrast problems are
**hardcoded dark-only palette utilities**, not the token system.

## Scope

- **App-wide** (all sections, via `dashboard-shell.tsx`): sidebar rail/hover/pin,
  header brand.
- **`/dashboard` only**: analytics rework.
- **Contrast sweep**: the specific hardcoded-color offenders listed below.

### Non-goals

- No change to the theme token system, accent catalog, or boot script.
- No new Convex **queries** on the live page (see Data Safety). Exactly one
  **additive, graceful** field on an existing query.
- No schema changes, migrations, or new indexes.
- No rework of the inbox, or of the (server-side) unbounded scans already noted
  in `convex/dashboard.ts` — out of scope for a UI pass (noted as follow-ups).

## Approved decisions

- Analytics: **operational rethink** (not just polish).
- Sidebar: **hover overlay + pin**, default collapsed.
- Header brand: **logo + wordmark, then page title** (`◆ Holidayys WA CRM │ Dashboard`).

## Data safety (why this can't break the live page)

Prod is one self-hosted Convex deployment; `convex dev/deploy/codegen` all push
to it, and Convex `useQuery` on a **missing function** throws. So:

- **Reuse already-deployed queries** for the new widgets:
  - `api.conversations.list` (paginated, role-scoped, `embedContact`-enriched,
    carries `unreadCount`, `assignedToUserId`, `lastMessageAt`, `adReferral`) →
    the Needs-attention queue.
  - `api.conversations.unreadTotal` (exact role-scoped count of `unreadCount>0`)
    → the "Waiting on reply" KPI.
  - `api.dashboard.responseTime` (existing) → the Response-performance strip.
- The only backend edit is an **additive field** on the existing
  `api.dashboard.metrics`. A missing *field* reads `undefined` (renders as
  "no split"), it does **not** throw. So the page keeps working even if the
  frontend ships before `convex deploy`.

## Architecture

### A. Sidebar — `src/components/layout/sidebar.tsx`

Replace the persisted `collapsed` toggle with a persisted `pinned` flag
(`localStorage["wacrm:sidebar:pinned"]`, default `false`). Mobile drawer path is
unchanged.

Desktop (`lg+`) behavior:

- The `<aside>` is the **layout box**: `lg:w-16` when unpinned, `lg:w-60` when
  pinned (`transition-[width]`). It is a `group` and `relative`.
- An **inner panel** is absolutely positioned (`lg:absolute lg:inset-y-0
  lg:left-0`), width `w-16`, growing to `w-60` on `lg:group-hover` /
  `lg:group-focus-within` (and always `w-60` when pinned). Because the panel is
  out of flow, growth **overlays** the main content instead of reflowing it.
- Elevation: when expanded-by-hover and **not** pinned, the panel gets a shadow
  + solid `bg-sidebar` so it reads as floating; pinned = flush, no shadow.
- Labels/chips: rendered always; `opacity-0 → group-hover/focus-within
  opacity-100` when unpinned, `opacity-100` when pinned. Panel is
  `overflow-hidden whitespace-nowrap` so labels clip cleanly at `w-16`.
- Rail top: compact brand **mark** (icon) linking to `/dashboard` + a **pin**
  toggle button (replaces the old expand/collapse button; `Pin`/`PinOff` icons,
  `pinSidebar`/`unpinSidebar` labels). The wordmark is gone from here (now in the
  header).
- Accessibility: `focus-within` expansion makes it keyboard-reachable; the pin
  is a persistent, non-hover affordance. Collapsed rail keeps the existing
  right-side tooltips.

Hydration: server renders unpinned (rail); reconcile `pinned` from
`localStorage` after mount (same pattern the old `collapsed` used) to avoid a
hydration mismatch.

### B. Header — `src/components/layout/header.tsx`

Left cluster becomes: hamburger (mobile only) → **brand mark** (rounded-square
icon) → **wordmark** "Holidayys WA CRM" (`hidden sm:inline`) → vertical divider
→ **page title**. Right cluster (ModeToggle, account menu) unchanged. Brand mark
+ wordmark link to `/dashboard`.

New i18n: `Header.brand = "Holidayys WA CRM"` (or reuse `Sidebar.title`).

### C. Dashboard page — `src/app/(dashboard)/dashboard/page.tsx`

Top→bottom, replacing today's layout:

1. **Remove the redundant in-page "Dashboard" H1** (the header now carries the
   title). Keep at most a slim, single-line "live" affordance — no vanity
   greeting — so the useful content (KPIs) starts higher.
2. **KPI row (4):**
   - **Waiting on reply** — value `unreadTotal`, warning-toned icon.
   - **Active conversations** — `metrics.activeConversations` + delta.
   - **New leads today** — `metrics.newContactsToday`, subtitle "N ads · M
     direct" from the additive `metrics.newLeadsBySource` (falls back to no split
     if the field is absent pre-deploy).
   - **Open pipeline** — `metrics.openDealsValue` + open-deal count.
   ("Messages sent today" is dropped as a KPI; outgoing volume still lives in the
   conversations chart.)
3. **LeadSpendCard** — **kept** (self-hides to `null` until an admin sets a lead
   value; removing it would delete the RBAC-phase-2 feature's only dashboard
   surface). Owner may still veto.
4. **Needs attention** panel (primary) — see D.
5. **Quick actions** — kept.
6. **Charts row (2):** Conversations trend (line) + Pipeline donut — kept,
   colors tokenized.
7. **Response performance** strip — replaces the weekday bar chart; reuses
   `responseTime` data (this week vs last week vs 5-min target). Removes the
   Tremor/Recharts import from this route (bundle win).
8. **Recent activity** feed — kept, contrast-fixed.

### D. New component — `src/components/dashboard/needs-attention-panel.tsx`

Presentational + container split (mirrors how `ConversationsChart` etc. already
take data as props, so it's previewable without Convex):

- **Container** (in `page.tsx` or a thin wrapper): `useQuery(api.conversations.
  list, { status: "open", assignment, paginationOpts: { numItems: 50, cursor:
  null } })` via the cached hook, per active tab.
- **Presentational** `NeedsAttentionPanel({ items, loading, tab, onTabChange,
  availableTabs })`:
  - Tabs **Unassigned / Mine / All**, filtered by role: admin/owner/supervisor
    get all three; agent gets Mine + Unassigned (+ "All" = their own scope);
    viewer gets Unassigned only. Derived from `accountRole` + the same
    `conversationScope` semantics the server enforces.
  - Rows: initials avatar, contact name, last-message preview, **waiting
    duration** (`now - lastMessageAt`), **ad-lead** badge when `adReferral` is
    present, assignee chip; row links to `/inbox?c=<id>`.
  - Selection logic is a **pure function** in `src/lib/dashboard/needs-
    attention.ts`: filter `unreadCount > 0`, sort oldest-first by `lastMessageAt`,
    format wait durations. Unit-tested (TDD).
  - Empty state: "You're all caught up." Loading: row skeletons.

### E. New component — `src/components/dashboard/response-performance.tsx`

Slim strip. Props `{ data: ResponseTimeSummary | null, loading }`. Shows this-week
avg, last-week avg with a delta, and a target pill — all mode-aware. Reuses the
existing `fmt()` formatting. No chart lib.

### F. Backend — `convex/dashboard.ts` `metrics` (additive)

Partition the **already-read** `recentContacts` (today+yesterday window) by
`acquisitionSource`:

```ts
newLeadsBySource: {
  adToday, directToday, adYesterday, directYesterday
}
```

Zero new reads, no new args. `acquisitionSource === "ad"` ⇒ ad, else direct.
Graceful: absent field ⇒ UI shows the total without a split. Owner runs `convex
deploy` to activate. Covered by a `convex-test` unit test.

### G. Contrast sweep (mode-aware colors)

Root cause: dark-only palette utilities. Introduce one helper
`src/lib/ui/soft-badge.ts` exporting mode-aware tone class strings
(`bg-<hue>-500/10 text-<hue>-700 dark:text-<hue>-300`, with a neutral/accent
variant), then apply:

- `sidebar.tsx` `ROLE_CHIP` (amber/cyan/primary/neutral) + the **Beta** chip
  (`text-amber-300`) → mode-aware.
- `activity-feed.tsx` `KIND_THEME` badges (`text-blue-400`, `text-amber-400`,
  `text-rose-400`) → mode-aware.
- `quick-actions.tsx` tints (`text-blue-400`, `text-amber-400`) → mode-aware.
- Response-performance target pill (was `text-rose-300`) → mode-aware.
- `conversations-chart.tsx`: hardcoded `#3b82f6`/`#7c3aed` (legend dots + SVG
  polylines) → new tokens **`--chart-incoming`** (a per-mode legible blue) and
  **`--chart-outgoing`** = `var(--primary)` (tracks the accent). Added to both
  `html[data-mode]` blocks in `globals.css`.
- Pipeline donut keeps per-stage user colors (data, not themeable); its ring
  already uses `var(--muted)` and legend text uses `--muted-foreground`. No change
  beyond confirming legibility.

### H. i18n — `messages/en.json` (en is the only locale)

Add: `Header.brand`; `Sidebar.pinSidebar`/`unpinSidebar`; `Dashboard.page`
keys for `waitingOnReply`, `newLeadsBySourceSplit`, greeting/updated; a
`Dashboard.needsAttention` group (title, tabUnassigned/tabMine/tabAll, waiting,
adLead, allCaught, viewAll, previewFallback, assignee); a
`Dashboard.responsePerformance` group (title, thisWeek, lastWeek, target,
faster/slower).

## Performance

- Drop the Tremor bar chart from the dashboard route (keep the component file for
  any other consumer; just stop importing it here).
- Reuse deployed queries; net new subscriptions on the page = `conversations.
  list` (per tab) + `unreadTotal` (already app-wide/cached). All go through the
  existing `@/lib/convex/cached` hooks.
- Memoize the needs-attention pure selection; keep presentational components
  prop-driven to avoid re-render churn.
- No new heavy deps.

## Testing (TDD)

- `src/lib/dashboard/needs-attention.ts` — filter/sort/format: unit tests first.
- `metrics` additive split — `convex-test` unit test (ad vs direct, today vs
  yesterday, missing `acquisitionSource`).
- `soft-badge.ts` — smoke test that both light and dark classes are emitted.
- Presentational renders (empty / populated / loading) for NeedsAttentionPanel
  and ResponsePerformance where the repo's component-test pattern supports it.
- Full suite + `typecheck` + `lint` + `next build` must stay green (baseline:
  1515 passing).

## Verification (prod is login-gated)

Can't headless-login to prod, so:

1. `typecheck`, `lint`, `vitest`, `next build` all green.
2. A **throwaway** local preview route (e.g. `src/app/(dev)/__preview/…`, not
   linked from any nav) renders the shell pieces + dashboard **presentational**
   components with mock data. Drive it in the Browser pane, toggle `data-mode`,
   screenshot **light and dark**, confirm contrast + layout + the rail/hover/pin
   interaction. **Delete the preview route before finishing.**

## Deploy notes

- Additive `metrics` field ⇒ owner runs `convex deploy` (self-hosted
  `convex-api.holidayys.co`) to light up the leads split; page degrades
  gracefully until then.
- Frontend ships via Netlify on merge to `main` (owner). No migration, no index.

## Risks & mitigations

- **Hover-overlay CSS** across breakpoints — mitigate with `focus-within`,
  the throwaway visual check in both modes, and keeping the mobile drawer path
  untouched.
- **`conversations.list` capped at 50** for the panel could under-count a large
  backlog — acceptable at current scale (the file's own comments assume small
  conversation volume); the "view all in inbox" link covers overflow. Noted, not
  silently truncated.
- **Pre-deploy metrics field** — graceful (undefined ⇒ no split), never throws.

## Open decision

- LeadSpendCard: recommend **keep** (invisible until enabled). Owner may veto to
  remove outright.
