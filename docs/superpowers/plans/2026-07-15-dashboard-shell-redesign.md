# Dashboard + app-shell redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `/dashboard` into an operational analytics view and give the shared shell a collapsed-rail sidebar (hover-overlay + pin) and a brand-carrying header, with every element correct in light and dark.

**Architecture:** Reuse already-deployed Convex queries for the new widgets (`conversations.list`, `conversations.unreadTotal`, `dashboard.responseTime`); the only backend edit is an additive, graceful field on `dashboard.metrics`. Presentational components stay prop-driven so a throwaway preview can screenshot them in both modes. Contrast is fixed by replacing hardcoded dark-only palette utilities with mode-aware tone classes and by tokenizing chart colors.

**Tech Stack:** Next.js (vendored — read `node_modules/next/dist/docs/` before framework code), React, Convex (self-hosted; `convex/_generated` is committed — never run codegen, it pushes prod), Tailwind v4 + OKLCH tokens, next-intl, lucide-react, vitest (`src` = node, `convex` = edge-runtime via convex-test).

## Global Constraints

- Never run `convex dev`/`deploy`/`codegen` — they push the single prod deployment. Build offline against the committed `convex/_generated`.
- No new Convex **queries** consumed by the live page; the one backend change is an **additive optional field** (missing field ⇒ `undefined`, never throws).
- No schema changes, migrations, or new indexes.
- All colors via theme tokens or mode-aware pairs (`text-<hue>-700 dark:text-<hue>-300`). No dark-only palette utilities remain in touched files.
- i18n: `messages/en.json` only (single locale). Every user-facing string is a key.
- Keep the mobile drawer path in the sidebar working; new behavior is `lg:` only.
- Baseline to preserve: `typecheck` clean, `vitest` 1515 passing, `next build` green.
- Commit after each task.

## File Structure

**Create**
- `src/lib/ui/soft-badge.ts` — mode-aware tone → className map (+ `.test.ts`).
- `src/lib/dashboard/needs-attention.ts` — pure select/sort/format for the queue (+ `.test.ts`).
- `src/components/dashboard/needs-attention-panel.tsx` — presentational panel + `NeedsAttentionCard` container.
- `src/components/dashboard/response-performance.tsx` — presentational strip.
- `src/app/(dev)/__preview/dashboard/page.tsx` + `src/app/(dev)/layout.tsx` — throwaway visual harness (deleted in Task 11).

**Modify**
- `src/app/globals.css` — add `--chart-incoming` / `--chart-outgoing` to both mode blocks.
- `src/components/dashboard/conversations-chart.tsx` — tokenize the two hardcoded hexes.
- `src/components/dashboard/activity-feed.tsx` — mode-aware `KIND_THEME` badges.
- `src/components/dashboard/quick-actions.tsx` — mode-aware tints.
- `convex/dashboard.ts` — additive `newLeadsBySource` on `metrics` (+ `convex/dashboard.test.ts`).
- `src/lib/dashboard/types.ts` — `MetricsBundle.newLeadsBySource?`, `NeedsAttentionRow`.
- `src/components/layout/header.tsx` — brand cluster.
- `src/components/layout/sidebar.tsx` — rail + hover overlay + pin; chip contrast.
- `src/app/(dashboard)/dashboard/page.tsx` — reorg + new widgets + KPI swap.
- `messages/en.json` — new keys.

---

### Task 1: soft-badge tone helper (TDD)

**Files:**
- Create: `src/lib/ui/soft-badge.ts`
- Test: `src/lib/ui/soft-badge.test.ts`

**Interfaces:**
- Produces: `type SoftTone = "accent" | "success" | "warning" | "danger" | "info" | "neutral" | "amber" | "cyan"`; `softBadge(tone: SoftTone): string` returning a class string that includes a light-mode text stop and a `dark:` text stop.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { softBadge } from "./soft-badge";

describe("softBadge", () => {
  it("emits both a light-mode and a dark-mode text stop for every tone", () => {
    for (const tone of ["accent","success","warning","danger","info","neutral","amber","cyan"] as const) {
      const cls = softBadge(tone);
      expect(cls, tone).toMatch(/text-(?!.*dark:)\S+/); // a base text- utility
      expect(cls, tone).toMatch(/dark:text-\S+/);       // and a dark override
    }
  });

  it("uses a tinted background at low opacity", () => {
    expect(softBadge("warning")).toMatch(/bg-\S+\/10/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ui/soft-badge.test.ts`
Expected: FAIL (module not found / `softBadge` undefined).

- [ ] **Step 3: Implement**

```ts
// Mode-aware "soft badge" tone classes. The app's dark-only palette
// utilities (text-amber-300 etc.) wash out on light surfaces; each tone
// here pairs a light-mode 700 stop with a dark-mode 300 stop over a 10%
// tint so chips read correctly in BOTH modes. Prefer semantic tones
// (accent/success/warning/danger) — the named-hue tones exist only to
// port existing amber/cyan chips 1:1.
export type SoftTone =
  | "accent" | "success" | "warning" | "danger"
  | "info" | "neutral" | "amber" | "cyan";

const TONES: Record<SoftTone, string> = {
  accent: "border-primary/40 bg-primary/10 text-primary",
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger: "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  info: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  neutral: "border-border bg-muted text-foreground",
  amber: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  cyan: "border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
};

export function softBadge(tone: SoftTone): string {
  return TONES[tone];
}
```

Note: `accent`/`neutral` map to theme tokens (`text-primary`/`text-foreground`) that are already mode-correct, so they intentionally have no `dark:` override. Adjust the test's per-tone assertion to skip those two:

```ts
    for (const tone of ["success","warning","danger","info","amber","cyan"] as const) {
```
and assert `accent`/`neutral` separately return a token-based class:
```ts
  it("accent and neutral use mode-correct tokens", () => {
    expect(softBadge("accent")).toContain("text-primary");
    expect(softBadge("neutral")).toContain("text-foreground");
  });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/ui/soft-badge.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ui/soft-badge.ts src/lib/ui/soft-badge.test.ts
git commit -m "feat(ui): mode-aware soft-badge tone helper"
```

---

### Task 2: Contrast sweep — chart tokens + activity/quick-actions

**Files:**
- Modify: `src/app/globals.css` (both `html[data-mode]` blocks)
- Modify: `src/components/dashboard/conversations-chart.tsx`
- Modify: `src/components/dashboard/activity-feed.tsx`
- Modify: `src/components/dashboard/quick-actions.tsx`

No pure logic ⇒ verified by `typecheck` + `next build` + the Task 10 visual pass.

- [ ] **Step 1: Add chart tokens to `globals.css`** — in `html[data-mode="dark"]` add:
```css
  --chart-incoming: oklch(0.7 0.14 240);
  --chart-outgoing: var(--primary);
```
and in `html[data-mode="light"]` add:
```css
  --chart-incoming: oklch(0.55 0.16 240);
  --chart-outgoing: var(--primary);
```
Also expose them as Tailwind utilities in the `@theme inline` block:
```css
  --color-chart-incoming: var(--chart-incoming);
  --color-chart-outgoing: var(--chart-outgoing);
```

- [ ] **Step 2: Tokenize `conversations-chart.tsx`** — replace the two hardcoded hexes. Legend:
```tsx
        <LegendDot color="var(--chart-incoming)" label={t('incoming')} />
        <LegendDot color="var(--chart-outgoing)" label={t('outgoing')} />
```
and in `LineSvg` set the two `<polyline>`/stroke colors to `var(--chart-incoming)` (incoming) and `var(--chart-outgoing)` (outgoing). Grep the file for `#3b82f6` and `#7c3aed` and replace every occurrence (stroke, fill, dot fills).

- [ ] **Step 3: Mode-aware `activity-feed.tsx`** — import the helper and rebuild `KIND_THEME` badges:
```tsx
import { softBadge } from '@/lib/ui/soft-badge'
// ...
const KIND_THEME: Record<ActivityKind, KindTheme> = {
  message: { icon: MessageSquare, badge: softBadge('info') },
  contact: { icon: UserPlus, badge: softBadge('accent') },
  deal: { icon: Briefcase, badge: softBadge('accent') },
  broadcast: { icon: Radio, badge: softBadge('amber') },
  automation: { icon: Zap, badge: softBadge('danger') },
}
```
(`softBadge` returns border+bg+text; the badge span already applies it — keep its `rounded-full` layout classes.)

- [ ] **Step 4: Mode-aware `quick-actions.tsx`** — replace `text-blue-400`/`text-amber-400` tints with mode-aware text. Simplest: change `tint` values to `'text-primary'`, `'text-blue-600 dark:text-blue-400'`, `'text-amber-600 dark:text-amber-400'`, `'text-primary'` respectively (icons sit on `bg-muted`, so a mid stop reads in both modes).

- [ ] **Step 5: Verify + commit**

Run: `npm run typecheck` → clean.
```bash
git add src/app/globals.css src/components/dashboard/conversations-chart.tsx src/components/dashboard/activity-feed.tsx src/components/dashboard/quick-actions.tsx
git commit -m "fix(dashboard): tokenize chart colors and mode-aware badges/tints"
```

---

### Task 3: `metrics.newLeadsBySource` additive field (TDD, convex)

**Files:**
- Modify: `convex/dashboard.ts` (`metrics` handler + return)
- Test: `convex/dashboard.test.ts`
- Modify: `src/lib/dashboard/types.ts` (`MetricsBundle`)

**Interfaces:**
- Produces: `metrics` return gains `newLeadsBySource: { adToday: number; directToday: number; adYesterday: number; directYesterday: number }`. `MetricsBundle.newLeadsBySource?: {…}` (optional so a pre-deploy client typechecks and degrades).

- [ ] **Step 1: Write the failing test** — add to `convex/dashboard.test.ts` (mirror an existing test's `convexTest`/seed setup in that file for account + membership; insert contacts with/without `acquisitionSource`):

```ts
it("metrics splits today's new leads by acquisition source", async () => {
  const t = convexTest(schema);
  // (reuse this file's existing helper to create an account + admin membership,
  //  returning { asUser, accountId })
  const { asUser, accountId } = await seedAccount(t);
  const now = Date.now();
  const todayStart = new Date(new Date(now).setHours(0,0,0,0)).getTime();
  const yesterdayStart = todayStart - 86_400_000;

  await t.run(async (ctx) => {
    await ctx.db.insert("contacts", { accountId, phone: "+1", phoneNormalized: "1", acquisitionSource: "ad" });
    await ctx.db.insert("contacts", { accountId, phone: "+2", phoneNormalized: "2" }); // direct
    await ctx.db.insert("contacts", { accountId, phone: "+3", phoneNormalized: "3", acquisitionSource: "ad" });
  });

  const res = await asUser.query(api.dashboard.metrics, {
    todayStartMs: todayStart, yesterdayStartMs: yesterdayStart,
  });
  expect(res.newLeadsBySource.adToday).toBe(2);
  expect(res.newLeadsBySource.directToday).toBe(1);
});
```
(If `contacts.insert` in `t.run` needs `phoneNormalized`, it's set above. Match the seed helper actually present in the file — read it first.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/dashboard.test.ts -t "splits today"`
Expected: FAIL (`newLeadsBySource` undefined).

- [ ] **Step 3: Implement** — in `convex/dashboard.ts` `metrics`, after `newContactsYesterdayCount` is computed from `recentContacts`, add (no new reads — partition the array already collected):

```ts
    const isAd = (c: { acquisitionSource?: "ad" }) => c.acquisitionSource === "ad";
    const todayContacts = recentContacts.filter((c) => c._creationTime >= todayStartMs);
    const yesterdayContacts = recentContacts.filter(
      (c) => c._creationTime >= yesterdayStartMs && c._creationTime < todayStartMs,
    );
    const newLeadsBySource = {
      adToday: todayContacts.filter(isAd).length,
      directToday: todayContacts.filter((c) => !isAd(c)).length,
      adYesterday: yesterdayContacts.filter(isAd).length,
      directYesterday: yesterdayContacts.filter((c) => !isAd(c)).length,
    };
```
and add `newLeadsBySource,` to the returned object.

- [ ] **Step 4: Update the type** — in `src/lib/dashboard/types.ts` add to `MetricsBundle`:
```ts
  newLeadsBySource?: {
    adToday: number
    directToday: number
    adYesterday: number
    directYesterday: number
  }
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run convex/dashboard.test.ts` → PASS. Then `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add convex/dashboard.ts convex/dashboard.test.ts src/lib/dashboard/types.ts
git commit -m "feat(dashboard): additive newLeadsBySource split on metrics"
```

---

### Task 4: needs-attention pure logic (TDD)

**Files:**
- Create: `src/lib/dashboard/needs-attention.ts`
- Test: `src/lib/dashboard/needs-attention.test.ts`

**Interfaces:**
- Produces:
  - `interface WaitingConversation { _id: string; unreadCount: number; lastMessageAt?: number; lastMessageText?: string; assignedToUserId?: string; adReferral?: unknown; contact: { name?: string; phone?: string; avatarUrl?: string } | null }`
  - `selectWaiting<T extends WaitingConversation>(rows: T[]): T[]` — keeps `unreadCount > 0`, sorts oldest-first by `lastMessageAt` (undefined last).
  - `formatWaiting(sinceMs: number | undefined, nowMs: number): string` — `"2h 14m"`, `"48m"`, `"3d"`, or `""`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { selectWaiting, formatWaiting } from "./needs-attention";

const row = (id: string, unread: number, at?: number) => ({
  _id: id, unreadCount: unread, lastMessageAt: at, contact: null,
});

describe("selectWaiting", () => {
  it("drops read conversations and sorts oldest-waiting first", () => {
    const out = selectWaiting([row("a",0,5), row("b",3,100), row("c",2,50)]);
    expect(out.map((r) => r._id)).toEqual(["c","b"]);
  });
  it("keeps undefined lastMessageAt but sorts it last", () => {
    const out = selectWaiting([row("a",1,undefined), row("b",1,10)]);
    expect(out.map((r) => r._id)).toEqual(["b","a"]);
  });
});

describe("formatWaiting", () => {
  const now = 10_000_000;
  it("formats hours+minutes, minutes, days, and empty", () => {
    expect(formatWaiting(now - (2*3600+14*60)*1000, now)).toBe("2h 14m");
    expect(formatWaiting(now - 48*60*1000, now)).toBe("48m");
    expect(formatWaiting(now - 3*86400*1000, now)).toBe("3d");
    expect(formatWaiting(undefined, now)).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/dashboard/needs-attention.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
export interface WaitingConversation {
  _id: string;
  unreadCount: number;
  lastMessageAt?: number;
  lastMessageText?: string;
  assignedToUserId?: string;
  adReferral?: unknown;
  contact: { name?: string; phone?: string; avatarUrl?: string } | null;
}

export function selectWaiting<T extends WaitingConversation>(rows: T[]): T[] {
  return rows
    .filter((r) => r.unreadCount > 0)
    .sort((a, b) => (a.lastMessageAt ?? Infinity) - (b.lastMessageAt ?? Infinity));
}

export function formatWaiting(sinceMs: number | undefined, nowMs: number): string {
  if (sinceMs == null) return "";
  const mins = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) { const rem = mins % 60; return rem ? `${hrs}h ${rem}m` : `${hrs}h`; }
  return `${Math.floor(hrs / 24)}d`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/dashboard/needs-attention.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dashboard/needs-attention.ts src/lib/dashboard/needs-attention.test.ts
git commit -m "feat(dashboard): needs-attention selection + wait formatting"
```

---

### Task 5: NeedsAttentionPanel (presentational) + NeedsAttentionCard (container)

**Files:**
- Create: `src/components/dashboard/needs-attention-panel.tsx`

Verified via `typecheck`/`build`/preview (no RTL in repo).

**Interfaces:**
- Consumes: `selectWaiting`, `formatWaiting` (Task 4); `softBadge` (Task 1); `useQuery` from `@/lib/convex/cached`; `api.conversations.list`; `useAuth`; `conversationScope`.
- Produces:
  - `type QueueTab = "all" | "mine" | "unassigned"`
  - `NeedsAttentionPanel(props: { items: WaitingConversation[] | null; loading: boolean; tab: QueueTab; onTabChange: (t: QueueTab) => void; availableTabs: QueueTab[]; nowMs: number })` — presentational.
  - `NeedsAttentionCard()` — container (default in page): owns tab state, derives `availableTabs` from `conversationScope(accountRole)`, subscribes to `api.conversations.list` with `{ status: "open", assignment, paginationOpts: { numItems: 50, cursor: null } }` where `assignment` is `undefined` for `all`, else the tab; passes `selectWaiting(result.page)` to the panel.

- [ ] **Step 1: Implement the container mapping** — tab → list args:
```tsx
const assignmentForTab = (t: QueueTab) => (t === "all" ? undefined : t);
const tabsForScope = (scope: ReturnType<typeof conversationScope>): QueueTab[] =>
  scope === "all" ? ["all","mine","unassigned"]
  : scope === "own_and_pool" ? ["mine","unassigned"]
  : ["unassigned"];
```
Container body:
```tsx
const { accountId, accountRole } = useAuth();
const available = tabsForScope(conversationScope(accountRole ?? "viewer"));
const [tab, setTab] = useState<QueueTab>(available[0]);
const data = useQuery(
  api.conversations.list,
  accountId ? { status: "open", assignment: assignmentForTab(tab), paginationOpts: { numItems: 50, cursor: null } } : "skip",
);
const items = data ? selectWaiting(data.page as unknown as WaitingConversation[]) : null;
return <NeedsAttentionPanel items={items} loading={data === undefined} tab={tab} onTabChange={setTab} availableTabs={available} nowMs={Date.now()} />;
```
(When `available.length === 1`, render no tab bar.)

- [ ] **Step 2: Implement the presentational panel** — card wrapper `rounded-xl border border-border bg-card`; header with title + tab pills (active `bg-primary/10 text-primary`, inactive `text-muted-foreground hover:text-foreground`); body:
  - loading ⇒ 4 row skeletons (reuse `Skeleton` from `./skeleton`).
  - empty ⇒ `EmptyState` (from `./empty-state`) icon `CheckCircle2`, title `t('allCaught')`.
  - rows ⇒ for each item: initials avatar, `contact?.name || contact?.phone || t('unknown')`, `lastMessageText` preview (truncate), ad badge `softBadge('warning')` when `adReferral`, `formatWaiting(lastMessageAt, nowMs)` in `text-amber-700 dark:text-amber-300`; whole row is a `<Link href={`/inbox?c=${_id}`}>`.
  Use `useTranslations('Dashboard.needsAttention')`.

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck` → clean.
```bash
git add src/components/dashboard/needs-attention-panel.tsx
git commit -m "feat(dashboard): needs-attention queue panel + container"
```

---

### Task 6: ResponsePerformance strip (presentational)

**Files:**
- Create: `src/components/dashboard/response-performance.tsx`

**Interfaces:**
- Consumes: `ResponseTimeSummary` (types), `softBadge` (Task 1).
- Produces: `ResponsePerformance(props: { data: ResponseTimeSummary | null; loading: boolean; thresholdMinutes?: number })`.

- [ ] **Step 1: Implement** — a slim `rounded-xl border border-border bg-card px-5 py-4` row: left = title (`useTranslations('Dashboard.responsePerformance')`); right = three stats: this-week avg (bold `text-foreground`), last-week avg with a delta (`selectWaiting`-style faster/slower using `text-emerald-700 dark:text-emerald-300` when faster, `text-rose-700 dark:text-rose-300` when slower), and a target pill via `softBadge(underTarget ? 'success' : 'danger')`. Port the existing `fmt(mins)` helper from `response-time-chart.tsx`. Loading ⇒ a single `Skeleton className="h-6 w-full"`.

- [ ] **Step 2: Verify + commit**

Run: `npm run typecheck` → clean.
```bash
git add src/components/dashboard/response-performance.tsx
git commit -m "feat(dashboard): response-performance strip"
```

---

### Task 7: Header brand cluster

**Files:**
- Modify: `src/components/layout/header.tsx`
- Modify: `messages/en.json` (`Header.brand`)

- [ ] **Step 1: Add the key** — `messages/en.json` → `Header.brand = "Holidayys WA CRM"`.

- [ ] **Step 2: Rebuild the left cluster** — replace the header's left `<div>` (hamburger + `<h1>`) with hamburger + brand link + divider + title:
```tsx
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        {/* hamburger — unchanged, mobile only */}
        <Link href="/dashboard" className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <MessageSquare className="h-4 w-4" />
          </span>
          <span className="hidden text-sm font-semibold text-foreground sm:inline">{t('brand')}</span>
        </Link>
        <span className="hidden h-5 w-px bg-border sm:block" aria-hidden />
        <h1 className="truncate text-base font-semibold text-foreground sm:text-lg">{t(titleKey as string)}</h1>
      </div>
```
Import `MessageSquare` from `lucide-react` and `Link` from `next/link` (already imported).

- [ ] **Step 3: Verify + commit**

Run: `npm run typecheck` → clean.
```bash
git add src/components/layout/header.tsx messages/en.json
git commit -m "feat(shell): brand mark + wordmark in the header"
```

---

### Task 8: Sidebar — rail + hover overlay + pin

**Files:**
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `messages/en.json` (`Sidebar.pinSidebar`/`unpinSidebar`)

Key structural changes (desktop `lg:` only; mobile drawer path untouched):

- [ ] **Step 1: Swap persisted state to `pinned`** — replace the `collapsed`/`toggleCollapsed` block with:
```tsx
const [pinned, setPinned] = useState(false);
useEffect(() => {
  try { const s = localStorage.getItem("wacrm:sidebar:pinned"); if (s !== null) setPinned(s === "true"); } catch {}
}, []);
const togglePinned = () => setPinned((p) => { const n = !p; try { localStorage.setItem("wacrm:sidebar:pinned", String(n)); } catch {} return n; });
```

- [ ] **Step 2: Add a desktop layout spacer** — render before the `<aside>`, inside the fragment:
```tsx
<div aria-hidden className={cn("hidden shrink-0 transition-[width] duration-200 lg:block", pinned ? "lg:w-60" : "lg:w-16")} />
```

- [ ] **Step 3: Make the aside a fixed, hover/focus/pin-expanding group** — set its className to (mobile drawer bits kept):
```tsx
className={cn(
  "group fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col overflow-hidden whitespace-nowrap border-r border-border bg-sidebar",
  "transition-[transform,width,box-shadow] duration-200 ease-out will-change-transform",
  open ? "translate-x-0" : "-translate-x-full",
  "lg:translate-x-0 lg:w-16",
  "lg:group-hover:w-60 lg:group-focus-within:w-60 lg:group-hover:shadow-2xl lg:group-focus-within:shadow-2xl",
  "data-[pinned=true]:lg:w-60 data-[pinned=true]:lg:shadow-none",
)}
data-pinned={pinned}
```
(`bg-sidebar` is a defined token; keeps the panel opaque when it floats over content.)

- [ ] **Step 4: Rail top = brand mark (icon only) + pin toggle** — the logo row: keep the `<Link href="/dashboard">` icon box but drop the wordmark `<span>` (header owns it) and drop the old `collapsed && lg:hidden`. Replace the collapse button with a pin button:
```tsx
<button type="button" onClick={togglePinned}
  aria-label={pinned ? t("unpinSidebar") : t("pinSidebar")} title={pinned ? t("unpinSidebar") : t("pinSidebar")}
  className="hidden h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:flex">
  {pinned ? <PinOff className="h-5 w-5" /> : <Pin className="h-5 w-5" />}
</button>
```
Import `Pin, PinOff` from lucide; remove `PanelLeftClose, PanelLeftOpen` if now unused.

- [ ] **Step 5: Reveal labels only when expanded** — every nav label/chip/footer text that used `collapsed && "lg:hidden"` now uses opacity keyed to hover/focus/pin. Define once near the top of the return:
```tsx
const labelCls = "lg:opacity-0 lg:transition-opacity lg:duration-150 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 lg:group-data-[pinned=true]:opacity-100";
```
Apply `labelCls` to: nav item `<span>` labels, the Beta chip, the notification badge wrapper's text (keep the dot always), the account-strip block, and the user-footer name/email `<div>`. Remove the `collapsed`-gated tooltips OR keep tooltips (they still help on the rail) — simplest: keep the `Tooltip` always rendering `TooltipContent` on `lg` (harmless when expanded). Minimal change: render `TooltipContent` unconditionally.

- [ ] **Step 6: Chip contrast** — replace `ROLE_CHIP` dark-only classes with `softBadge` tones: owner→`softBadge('warning')`, admin→`softBadge('accent')`, supervisor→`softBadge('cyan')`, agent→`softBadge('neutral')`, viewer→`softBadge('neutral')`; Beta chip → `softBadge('amber')` (keep its `rounded-full px-1.5 …` layout classes). Import `softBadge`.

- [ ] **Step 7: i18n** — add `Sidebar.pinSidebar = "Pin sidebar"`, `Sidebar.unpinSidebar = "Unpin sidebar"`. (Leave `expandMenu`/`collapseMenu` in place; now unused but harmless.)

- [ ] **Step 8: Verify + commit**

Run: `npm run typecheck` → clean.
```bash
git add src/components/layout/sidebar.tsx messages/en.json
git commit -m "feat(shell): collapsed rail with hover-overlay + pin"
```

---

### Task 9: Dashboard page reorg + wire new widgets

**Files:**
- Modify: `src/app/(dashboard)/dashboard/page.tsx`
- Modify: `messages/en.json` (KPI + section strings)

- [ ] **Step 1: Add strings** — `Dashboard.page.waitingOnReply = "Waiting on reply"`, `Dashboard.page.leadsSplit = "{ad} ads · {direct} direct"`; `Dashboard.needsAttention` group (`title="Needs attention"`, `tabAll="All"`, `tabMine="Mine"`, `tabUnassigned="Unassigned"`, `allCaught="You're all caught up"`, `allCaughtHint="No conversations are waiting on a reply."`, `unknown="Unknown"`, `adLead="Ad lead"`, `viewAll="Open inbox"`); `Dashboard.responsePerformance` group (`title="Response performance"`, `thisWeek="This week"`, `lastWeek="Last week"`, `target="under {minutes}m target"`, `over="over {minutes}m target"`).

- [ ] **Step 2: Swap imports** — remove `ResponseTimeChart` import (and its `responseTime`-as-chart usage); add `NeedsAttentionCard` from `'@/components/dashboard/needs-attention-panel'` and `ResponsePerformance` from `'@/components/dashboard/response-performance'`. Add `Clock` (or reuse) for the waiting KPI icon. Keep the `responseTime` query (now feeds `ResponsePerformance`).

- [ ] **Step 3: Add the waiting subscription** —
```tsx
const unreadData = useQuery(api.conversations.unreadTotal, accountId ? {} : 'skip')
const waiting = unreadData ?? 0
const waitingLoading = unreadData === undefined
```

- [ ] **Step 4: Rework the KPI row** — 4 cards: Waiting on reply (`value={waiting.toLocaleString()}`, icon `Clock`, no delta — or subtitle `t('openChatsSuffix')`); Active conversations (unchanged); New leads today (value = `metrics.newContactsToday.current`, `subtitle={metrics.newLeadsBySource ? t('leadsSplit', { ad: metrics.newLeadsBySource.adToday, direct: metrics.newLeadsBySource.directToday }) : undefined}` with the existing delta kept if no split); Open pipeline (unchanged). Remove the Messages-sent-today card. Skeleton count stays 4.

- [ ] **Step 5: Replace the H1 block** — delete the `<h1>Dashboard</h1>` + description `<div>`; optionally keep nothing (header carries the title). Start the page at the KPI grid.

- [ ] **Step 6: Insert new widgets** — after the KPI grid + `LeadSpendCard` + `QuickActions`, render `<NeedsAttentionCard />` (before the charts row). Replace the `<ResponseTimeChart … />` line with `<ResponsePerformance data={responseTime} loading={responseTimeLoading} />`. Keep the charts row and `ActivityFeed` as-is.

- [ ] **Step 7: Verify + commit**

Run: `npm run typecheck` → clean; `npm run lint` → clean.
```bash
git add "src/app/(dashboard)/dashboard/page.tsx" messages/en.json
git commit -m "feat(dashboard): operational layout — waiting KPI, needs-attention, response strip"
```

---

### Task 10: Throwaway preview + light/dark visual verification

**Files (all deleted at the end of this task):**
- Create: `src/app/(dev)/layout.tsx`, `src/app/(dev)/__preview/dashboard/page.tsx`

- [ ] **Step 1: Build a mock harness** — a client page that renders, with hardcoded mock props (no Convex): the four `MetricCard`s, `NeedsAttentionPanel` (presentational, mock `items` incl. one with `adReferral` and one unread), `ConversationsChart`, `PipelineDonut`, `ResponsePerformance`, `ActivityFeed`, plus the `Header` and `Sidebar` are hard to mock (they use `useAuth`) — so render the dashboard *content* components only, inside a `<div className="p-6 bg-background">`. Add two buttons that set `document.documentElement.dataset.mode = 'light' | 'dark'`.

- [ ] **Step 2: Run the dev server + screenshot both modes** — start via the Browser pane (`preview_start` with a `.claude/launch.json` `dev` entry running `npm run dev`), navigate to `/__preview/dashboard`, screenshot dark, toggle light, screenshot light. Confirm: no washed-out chips, chart lines visible in both modes, needs-attention rows legible, KPI contrast good. Read console for errors.

- [ ] **Step 3: Fix any contrast/layout issues found**, re-screenshot.

- [ ] **Step 4: Delete the harness**
```bash
rm -r "src/app/(dev)"
git add -A && git commit -m "chore(dashboard): drop throwaway preview harness"
```

---

### Task 11: Full verification + finish

- [ ] **Step 1: Run the whole gate**

Run, all must pass:
```bash
npm run typecheck && npm run lint && npm test && npm run build
```
Expected: typecheck clean, lint clean, `>= 1515` tests passing (new tests added), build succeeds.

- [ ] **Step 2: Sidebar interaction sanity in the real shell** — with the dev server up, load `/login` (auth-gated app) and confirm the shell builds without runtime errors in the console; the pin/hover behavior is exercised in the preview (Task 10) since the real dashboard needs a session.

- [ ] **Step 3: Finish** — invoke `superpowers:finishing-a-development-branch` to choose merge/PR/cleanup. Note in the handoff: **owner must `convex deploy`** (self-hosted `convex-api.holidayys.co`) to activate `metrics.newLeadsBySource`; the page degrades gracefully until then. Frontend ships via Netlify on merge to `main`.

## Self-Review

**Spec coverage:** sidebar rail/hover/pin → T8; header brand → T7; analytics rethink (waiting KPI, needs-attention, leads split, response strip, drop weekday chart) → T3/T4/T5/T6/T9; contrast sweep → T1/T2/T8; performance (Tremor drop, reuse deployed queries, memoize) → T2/T9; graceful backend → T3; verification incl. light/dark → T10/T11; deploy note → T11. LeadSpendCard kept → T9 (unchanged). All covered.

**Placeholder scan:** TDD tasks carry full test + impl code; UI tasks carry concrete class strings and JSX. The only "read the file's existing helper" note is in T3's test (seed helper) — intentional, since it must match `convex/dashboard.test.ts`'s real setup.

**Type consistency:** `WaitingConversation`/`selectWaiting`/`formatWaiting` (T4) consumed unchanged in T5; `QueueTab` defined in T5; `MetricsBundle.newLeadsBySource` (T3) read in T9; `softBadge`/`SoftTone` (T1) consumed in T2/T5/T6/T8; `--chart-incoming`/`--chart-outgoing` (T2) consumed in `conversations-chart` (T2). Consistent.
