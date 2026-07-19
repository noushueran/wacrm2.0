# Knowledge Studio — Phase 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a working authoring surface for structured knowledge — a Knowledge tab on `/agents` with a service readiness matrix and editors for services, entries, and the three ops-block kinds.

**Architecture:** One new read-only Convex query (`api.knowledge.studioOverview`) feeds a matrix of services × six content slots with a computed readiness verdict. Clicking a service opens a full-width detail view whose editors call the **existing** Phase 1 mutations unchanged. Verdict logic is a pure library so it is unit-testable and shared. Presentational components hold no Convex hooks so they can be browser-verified against mock data.

**Tech Stack:** Next.js (App Router), React, TypeScript, Convex (self-hosted, single production instance), Tailwind + local shadcn-style primitives in `src/components/ui/`, next-intl, vitest + convex-test.

**Spec:** `docs/superpowers/specs/2026-07-19-knowledge-studio-phase2a-design.md` (read it before Task 1).

## Global Constraints

- **App root / worktree:** `/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0/.claude/worktrees/feat-knowledge-studio`, branch `feat/knowledge-studio`, off `origin/main` @ `5979d03`. **Every command runs from that directory.** Verify with `git branch --show-current` before touching anything.
- **NEVER run `npx convex dev`, `npx convex deploy`, or `npx convex codegen`.** This project has ONE self-hosted Convex instance and it IS production; all three push to it. A new Convex **function module** requires hand-editing `convex/_generated/api.d.ts` (import line + record member, in **true alphabetical position**). `api.js` is a Proxy and needs no edit. New **tables** need no edit at all (none in this phase).
- **NEVER `git add -A` or `git add .`** — sibling worktrees under `.claude/` are untracked but not gitignored and would be swept in. Stage explicit paths only.
- **Read `node_modules/next/dist/docs/` before writing router/navigation code.** Per the repo's `AGENTS.md`: this Next.js version has breaking changes versus training data.
- **Admin-only, and the skip pattern is mandatory.** Every `kbServices` / `kbEntries` / `kbOps` / `knowledge` read is `ctx.requireRole("admin")`. This app has **no error boundary and no `error.tsx`**, and `accountRole` is `null` while the profile loads — a Convex `useQuery` that throws surfaces during render and crashes the page. **Every studio query must be `useQuery(fn, isAdmin ? {} : 'skip')`**, where `isAdmin` is false while the role is null. Precedent: `src/app/(dashboard)/campaigns/page.tsx`.
- **No `.filter()` in Convex queries.** `.filter()` never narrows the scan and `.take(n)` stops at n *matches*, not n reads — that combination took `/settings?tab=cron` down. Use indexes; group in memory.
- **Quotes:** `convex/` uses double quotes; `src/` uses single quotes. **No `any`** — the repo lints against it.
- **i18n:** single locale. User-facing strings live in `messages/en.json` and are read via `useTranslations('<Namespace>')`. This phase adds the `Knowledge` namespace.
- **Verification commands** (from the worktree root): `npm test` (vitest run), `npm run typecheck` (tsc --noEmit), `npm run build` (next build), `npm run lint` (eslint). Single file: `npx vitest run <path>`.
- **Lint has pre-existing debt.** Baseline at branch point is **0 errors / 15 warnings**. The gate is "adds no NEW findings", not globally clean. Capture the baseline before Task 1.
- **Baseline test suite: 1965 tests / 152 files.** Every task leaves the full suite green.
- **Do not modify any AI engine.** `convex/aiKnowledge.ts`, `convex/aiReply.ts`, `convex/qualificationEngine.ts`, `convex/salesChecklists.ts`, `convex/kbCompile.ts`, and `src/lib/ai/defaults.ts` are out of scope. This phase adds one query and UI; it changes no retrieval or engine behaviour.
- **Do not add new mutations.** All writes go through the existing Phase 1 functions: `kbServices.upsert` / `remove`, `kbEntries.save` / `publish` / `unpublish` / `remove`, `kbOps.save` / `publish` / `unpublish`.
- Commit style: `feat(kb): …` / `test(kb): …` / `docs: …`, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Context primer (read once before Task 1)

**Phase 1 backend (already merged, do not change):**

- `kbServices` — `{ accountId, key, name, aliases[], routingTagName?, relatedServiceKeys?, status: "active"|"paused", sortOrder, updatedAt, createdByUserId? }`. Indexes `by_account`, `by_account_key`.
- `kbEntries` — `{ accountId, scope: "company"|"service"|"package", serviceKey?, packageKey?, type: "overview"|"faq"|"itinerary"|"requirements"|"policy"|"process"|"note", title, body, audience: "customer"|"internal", status: "draft"|"published", version, updatedAt, updatedByUserId?, publishedAt? }`. Indexes `by_account`, `by_account_service`, `by_account_status`.
- `kbOpsBlocks` — `{ accountId, serviceKey, kind: "qualification"|"sales"|"purchase", criteria?: {key,label,question?,marks?}[], steps?: {key,label,description?}[], conditions?: {key,label}[], reportValue?, currency?, status: "draft"|"published", version, updatedAt, updatedByUserId?, publishedAt? }`. Indexes `by_account`, `by_account_service_kind`.
- `convex/lib/kb/lint.ts` exports `lintServiceInput`, `lintEntryInput`, `lintOpsBlock`, `hasLintErrors`; `convex/lib/kb/types.ts` exports `LintIssue = { level: "error"|"warning"; code: string; message: string }` and `OpsBlockInput`.
- Ops `save` blocks only on shape errors (`label_required`, `key_duplicate`); `publish` blocks on all error-level issues including `items_required` and `marks_sum`. Entry `save` on an existing row always demotes to `status: "draft"` and bumps `version`.

**Frontend facts:**

- `src/app/(dashboard)/agents/page.tsx` (106 lines) has `type Tab = 'playground' | 'setup' | 'usage'`, local `useState` tab state, and a deliberate **render-time state adjustment** landing first-time users on Setup. That pattern is intentional (an effect would be wrong and the repo's eslint rejects the useRef-latch alternative) — preserve it.
- `AiKnowledgeCard` is imported at `src/components/settings/ai-config.tsx:28` and rendered at `:414-421` inside a `{canEdit && …}` guard with props `canEdit` and `hasEmbeddingsKey`.
- Available UI primitives in `src/components/ui/`: `accordion, alert, avatar, badge, button, card, checkbox, dialog, dropdown-menu, gated-button, input, label, phone-input, popover, radio-group, scroll-area, select, separator, sheet, switch, table, tabs, textarea, tooltip`. **There is no form library** — forms are built from `input`/`textarea`/`label` with local state.
- Presentational-component precedent: `src/components/leads/leads-board-view.tsx` (props in, no Convex hooks).

---

### Task 1: Pure verdict library

**Files:**
- Create: `src/lib/knowledge/verdict.ts`
- Test: `src/lib/knowledge/verdict.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `type OpsSlotState = "published" | "draft" | "absent"`
  - `type ServiceVerdict = "ready" | "blocked" | "draft" | "empty"`
  - `marksTotal(criteria: { marks?: number }[]): number | null` — sum of `marks`, or `null` when the list is empty or any criterion lacks a numeric `marks`.
  - `serviceVerdict(input: { overviewPublished: boolean; hasAnyContent: boolean; hasAnyPublished: boolean; qualification: { state: OpsSlotState; marksTotal: number | null }; purchase: { state: OpsSlotState } }): ServiceVerdict`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest';
import { marksTotal, serviceVerdict } from './verdict';

describe('marksTotal', () => {
  test('sums when every criterion has numeric marks', () => {
    expect(marksTotal([{ marks: 60 }, { marks: 40 }])).toBe(100);
  });
  test('returns null when the list is empty', () => {
    expect(marksTotal([])).toBeNull();
  });
  test('returns null when any criterion lacks marks', () => {
    expect(marksTotal([{ marks: 50 }, {}])).toBeNull();
  });
  test('treats 0 as a real value, not missing', () => {
    expect(marksTotal([{ marks: 0 }, { marks: 100 }])).toBe(100);
  });
});

describe('serviceVerdict', () => {
  const ready = {
    overviewPublished: true,
    hasAnyContent: true,
    hasAnyPublished: true,
    qualification: { state: 'published' as const, marksTotal: 100 },
    purchase: { state: 'published' as const },
  };

  test('ready when overview, qualification at 100, and purchase are all published', () => {
    expect(serviceVerdict(ready)).toBe('ready');
  });

  test('empty when nothing is authored at all', () => {
    expect(serviceVerdict({
      overviewPublished: false,
      hasAnyContent: false,
      hasAnyPublished: false,
      qualification: { state: 'absent', marksTotal: null },
      purchase: { state: 'absent' },
    })).toBe('empty');
  });

  test('draft when content exists but nothing is published', () => {
    expect(serviceVerdict({
      overviewPublished: false,
      hasAnyContent: true,
      hasAnyPublished: false,
      qualification: { state: 'draft', marksTotal: 90 },
      purchase: { state: 'draft' },
    })).toBe('draft');
  });

  test('blocked when qualification is published but marks are not 100', () => {
    expect(serviceVerdict({
      ...ready,
      qualification: { state: 'published', marksTotal: 90 },
    })).toBe('blocked');
  });

  test('blocked when purchase criteria are missing', () => {
    expect(serviceVerdict({ ...ready, purchase: { state: 'absent' } })).toBe('blocked');
  });

  test('blocked when the overview exists only as a draft', () => {
    expect(serviceVerdict({ ...ready, overviewPublished: false })).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/knowledge/verdict.test.ts`
Expected: FAIL — cannot resolve `./verdict`.

- [ ] **Step 3: Write the implementation**

```ts
// Readiness rule for a knowledge-base service, kept pure so it is unit
// testable and can be shared by the Convex query that computes it and any
// UI that needs to re-derive it. The rule itself is a product decision
// (design spec, 2026-07-19): a service is usable by the AI engines only
// when it can be described, scored, and reported on.
export type OpsSlotState = 'published' | 'draft' | 'absent';
export type ServiceVerdict = 'ready' | 'blocked' | 'draft' | 'empty';

/**
 * Total marks across a qualification checklist's criteria.
 *
 * Returns `null` rather than a partial sum when the list is empty or any
 * criterion is missing `marks` — a partial total would read as a real
 * score and could show "90" for a checklist that simply has not had its
 * marks filled in yet. Mirrors `lintOpsBlock`, which only enforces the
 * sum-to-100 rule when every criterion carries a numeric `marks`.
 */
export function marksTotal(criteria: { marks?: number }[]): number | null {
  if (criteria.length === 0) return null;
  let total = 0;
  for (const c of criteria) {
    if (typeof c.marks !== 'number') return null;
    total += c.marks;
  }
  return total;
}

export function serviceVerdict(input: {
  overviewPublished: boolean;
  hasAnyContent: boolean;
  hasAnyPublished: boolean;
  qualification: { state: OpsSlotState; marksTotal: number | null };
  purchase: { state: OpsSlotState };
}): ServiceVerdict {
  if (!input.hasAnyContent) return 'empty';
  if (!input.hasAnyPublished) return 'draft';
  const qualificationReady =
    input.qualification.state === 'published' && input.qualification.marksTotal === 100;
  const ready =
    input.overviewPublished && qualificationReady && input.purchase.state === 'published';
  return ready ? 'ready' : 'blocked';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/knowledge/verdict.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/knowledge/verdict.ts src/lib/knowledge/verdict.test.ts
git commit -m "feat(kb): pure service-readiness verdict library

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `api.knowledge.studioOverview` query

**Files:**
- Create: `convex/knowledge.ts`
- Modify: `convex/_generated/api.d.ts` (add `knowledge` import + record member, alphabetical — it sorts between `invitations` and `kbCompile`)
- Test: `convex/knowledge.test.ts`

**Interfaces:**
- Consumes: `marksTotal`, `serviceVerdict`, `OpsSlotState`, `ServiceVerdict` from `../src/lib/knowledge/verdict` (import path from `convex/` is `"../src/lib/knowledge/verdict"`).
- Produces: `api.knowledge.studioOverview` — `accountQuery`, `requireRole("admin")`, args `{}`, returning:

```ts
{
  services: Array<{
    key: string; name: string; aliases: string[];
    status: "active" | "paused"; sortOrder: number;
    entries: Record<
      "overview" | "faq" | "itinerary" | "requirements" | "policy" | "process" | "note",
      { published: number; draft: number }
    >;
    ops: Record<
      "qualification" | "sales" | "purchase",
      { state: OpsSlotState; marksTotal: number | null }
    >;
    verdict: ServiceVerdict;
  }>;
  companyEntryCount: { draft: number; published: number };
}
```

Services are sorted by `sortOrder`, then `name`.

- [ ] **Step 1: Write the failing test**

Copy the `modules` glob and the `seedAccountMember` helper verbatim from `convex/kbServices.test.ts` (per-suite duplication is this repo's deliberate convention), then add:

```ts
test('groups content per service and computes verdicts', async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: 'A', email: 'a@x.co', role: 'admin' });

  await asUser.mutation(api.kbServices.upsert, { key: 'georgia', name: 'Georgia', aliases: [] });
  await asUser.mutation(api.kbServices.upsert, { key: 'uae-visas', name: 'UAE visas', aliases: [] });

  // Georgia: overview published + qualification at 100 published + purchase published = ready
  const overview = await asUser.mutation(api.kbEntries.save, {
    scope: 'service', serviceKey: 'georgia', type: 'overview',
    title: 'Georgia overview', body: '4N/5D packages.', audience: 'customer',
  });
  await asUser.mutation(api.kbEntries.publish, { entryId: overview });
  await asUser.mutation(api.kbOps.save, {
    serviceKey: 'georgia', kind: 'qualification',
    criteria: [{ key: 'dates', label: 'Travel dates', marks: 60 },
               { key: 'email', label: 'Email', marks: 40 }],
  });
  await asUser.mutation(api.kbOps.publish, { serviceKey: 'georgia', kind: 'qualification' });
  await asUser.mutation(api.kbOps.save, {
    serviceKey: 'georgia', kind: 'purchase',
    conditions: [{ key: 'budget', label: 'Budget confirmed' }],
  });
  await asUser.mutation(api.kbOps.publish, { serviceKey: 'georgia', kind: 'purchase' });

  // UAE visas: only a draft entry = draft
  await asUser.mutation(api.kbEntries.save, {
    scope: 'service', serviceKey: 'uae-visas', type: 'faq',
    title: 'Visa FAQ', body: 'Processing takes 3 days.', audience: 'customer',
  });

  const result = await asUser.query(api.knowledge.studioOverview, {});
  const georgia = result.services.find((s) => s.key === 'georgia');
  const uae = result.services.find((s) => s.key === 'uae-visas');

  expect(georgia?.verdict).toBe('ready');
  expect(georgia?.entries.overview).toEqual({ published: 1, draft: 0 });
  expect(georgia?.ops.qualification).toEqual({ state: 'published', marksTotal: 100 });
  expect(georgia?.ops.sales).toEqual({ state: 'absent', marksTotal: null });
  expect(uae?.verdict).toBe('draft');
  expect(uae?.entries.faq).toEqual({ published: 0, draft: 1 });
});

test('a published qualification whose marks are not 100 reads blocked', async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: 'A', email: 'a@x.co', role: 'admin' });
  await asUser.mutation(api.kbServices.upsert, { key: 'georgia', name: 'Georgia', aliases: [] });
  const overview = await asUser.mutation(api.kbEntries.save, {
    scope: 'service', serviceKey: 'georgia', type: 'overview',
    title: 'o', body: 'b', audience: 'customer',
  });
  await asUser.mutation(api.kbEntries.publish, { entryId: overview });
  // 100 marks so publish is allowed, then edited down to 90 — publish gate
  // only runs at publish time, so a published block CAN drift off 100.
  await asUser.mutation(api.kbOps.save, {
    serviceKey: 'georgia', kind: 'qualification',
    criteria: [{ key: 'a', label: 'A', marks: 100 }],
  });
  await asUser.mutation(api.kbOps.publish, { serviceKey: 'georgia', kind: 'qualification' });
  const blocked = await asUser.query(api.knowledge.studioOverview, {});
  expect(blocked.services[0].verdict).toBe('blocked'); // purchase still absent
});

test('company entries are counted separately, not attributed to a service', async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: 'A', email: 'a@x.co', role: 'admin' });
  const id = await asUser.mutation(api.kbEntries.save, {
    scope: 'company', type: 'policy', title: 'Hours', body: 'Daily 10-21.', audience: 'customer',
  });
  await asUser.mutation(api.kbEntries.publish, { entryId: id });
  await asUser.mutation(api.kbEntries.save, {
    scope: 'company', type: 'note', title: 'Internal', body: 'x', audience: 'internal',
  });
  const result = await asUser.query(api.knowledge.studioOverview, {});
  expect(result.companyEntryCount).toEqual({ published: 1, draft: 1 });
  expect(result.services).toEqual([]);
});

test('non-admin is rejected and accounts are isolated', async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: 'A', email: 'a@x.co', role: 'admin' });
  await asUser.mutation(api.kbServices.upsert, { key: 'georgia', name: 'Georgia', aliases: [] });
  const { asUser: asAgent } = await seedAccountMember(t, { name: 'B', email: 'b@x.co', role: 'agent' });
  await expect(asAgent.query(api.knowledge.studioOverview, {})).rejects.toThrow();
  const { asUser: asOtherAdmin } = await seedAccountMember(t, { name: 'C', email: 'c@x.co', role: 'admin' });
  const other = await asOtherAdmin.query(api.knowledge.studioOverview, {});
  expect(other.services).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/knowledge.test.ts`
Expected: FAIL — `api.knowledge` is undefined.

- [ ] **Step 3: Write the implementation**

```ts
import { accountQuery } from "./lib/auth";
import type { Doc } from "./_generated/dataModel";
import {
  marksTotal,
  serviceVerdict,
  type OpsSlotState,
} from "../src/lib/knowledge/verdict";

// ============================================================
// Read model for the Knowledge Studio (Settings → Agents →
// Knowledge). Deliberately returns STATUS ONLY — never entry
// bodies — because the matrix renders presence/state dots for
// every service at once and pulling full `body` text for that
// would move kilobytes per row to draw a badge.
//
// Three index-backed reads, grouped in memory. No `.filter()`:
// per the repo-wide rule it never narrows the scan, and
// `.take(n)` stops at n matches rather than n reads.
// ============================================================

const ENTRY_TYPES = [
  "overview", "faq", "itinerary", "requirements", "policy", "process", "note",
] as const;
type EntryType = (typeof ENTRY_TYPES)[number];

const OPS_KINDS = ["qualification", "sales", "purchase"] as const;
type OpsKind = (typeof OPS_KINDS)[number];

function emptyEntryCounts(): Record<EntryType, { published: number; draft: number }> {
  return {
    overview: { published: 0, draft: 0 },
    faq: { published: 0, draft: 0 },
    itinerary: { published: 0, draft: 0 },
    requirements: { published: 0, draft: 0 },
    policy: { published: 0, draft: 0 },
    process: { published: 0, draft: 0 },
    note: { published: 0, draft: 0 },
  };
}

function emptyOpsSlots(): Record<OpsKind, { state: OpsSlotState; marksTotal: number | null }> {
  return {
    qualification: { state: "absent", marksTotal: null },
    sales: { state: "absent", marksTotal: null },
    purchase: { state: "absent", marksTotal: null },
  };
}

export const studioOverview = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");

    const [services, entries, opsBlocks] = await Promise.all([
      ctx.db.query("kbServices")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId)).collect(),
      ctx.db.query("kbEntries")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId)).collect(),
      ctx.db.query("kbOpsBlocks")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId)).collect(),
    ]);

    const entriesByService = new Map<string, Doc<"kbEntries">[]>();
    const companyEntryCount = { published: 0, draft: 0 };
    for (const entry of entries) {
      if (entry.scope === "company" || !entry.serviceKey) {
        if (entry.status === "published") companyEntryCount.published++;
        else companyEntryCount.draft++;
        continue;
      }
      const list = entriesByService.get(entry.serviceKey);
      if (list) list.push(entry);
      else entriesByService.set(entry.serviceKey, [entry]);
    }

    const opsByService = new Map<string, Doc<"kbOpsBlocks">[]>();
    for (const block of opsBlocks) {
      const list = opsByService.get(block.serviceKey);
      if (list) list.push(block);
      else opsByService.set(block.serviceKey, [block]);
    }

    const rows = services.map((service) => {
      const entryCounts = emptyEntryCounts();
      for (const entry of entriesByService.get(service.key) ?? []) {
        const slot = entryCounts[entry.type as EntryType];
        if (!slot) continue;
        if (entry.status === "published") slot.published++;
        else slot.draft++;
      }

      const ops = emptyOpsSlots();
      for (const block of opsByService.get(service.key) ?? []) {
        const kind = block.kind as OpsKind;
        ops[kind] = {
          state: block.status === "published" ? "published" : "draft",
          // Marks are a qualification-only concept; sales steps and
          // purchase conditions carry none.
          marksTotal:
            kind === "qualification" ? marksTotal(block.criteria ?? []) : null,
        };
      }

      const entryTotals = ENTRY_TYPES.reduce(
        (acc, type) => {
          acc.published += entryCounts[type].published;
          acc.draft += entryCounts[type].draft;
          return acc;
        },
        { published: 0, draft: 0 },
      );
      const opsPresent = OPS_KINDS.filter((k) => ops[k].state !== "absent");
      const hasAnyContent =
        entryTotals.published + entryTotals.draft > 0 || opsPresent.length > 0;
      const hasAnyPublished =
        entryTotals.published > 0 || opsPresent.some((k) => ops[k].state === "published");

      return {
        key: service.key,
        name: service.name,
        aliases: service.aliases,
        status: service.status,
        sortOrder: service.sortOrder,
        entries: entryCounts,
        ops,
        verdict: serviceVerdict({
          overviewPublished: entryCounts.overview.published > 0,
          hasAnyContent,
          hasAnyPublished,
          qualification: ops.qualification,
          purchase: { state: ops.purchase.state },
        }),
      };
    });

    rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return { services: rows, companyEntryCount };
  },
});
```

- [ ] **Step 4: Hand-edit `convex/_generated/api.d.ts`, then run tests**

Add, in true alphabetical position (between `invitations` and `kbCompile`):
```ts
import type * as knowledge from "../knowledge.js";
```
and in the record:
```ts
  knowledge: typeof knowledge;
```

Run: `npx vitest run convex/knowledge.test.ts && npm run typecheck`
Expected: PASS (4 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add convex/knowledge.ts convex/knowledge.test.ts convex/_generated/api.d.ts
git commit -m "feat(kb): studioOverview read model for the knowledge studio

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Knowledge tab shell + relocate the legacy card

**Files:**
- Modify: `src/app/(dashboard)/agents/page.tsx`
- Modify: `src/components/settings/ai-config.tsx` (remove import at `:28`, remove render at `:414-421`)
- Create: `src/components/knowledge/knowledge-studio.tsx`
- Create: `src/components/knowledge/legacy-documents.tsx`
- Modify: `messages/en.json` (add the `Knowledge` namespace)

**Interfaces:**
- Consumes: `api.knowledge.studioOverview` (Task 2).
- Produces: `<KnowledgeStudio />` — default-exported-free named export, no props. Owns selected-service state and the `studioOverview` query. For now renders a placeholder panel plus `<LegacyDocuments />`; Tasks 4–7 fill it in.
- Produces: `<LegacyDocuments />` — wraps the existing `AiKnowledgeCard` in a collapsed `accordion` section.

**Deliverable:** the Knowledge tab exists, is admin-only, deep-links via `?tab=knowledge`, and renders the legacy documents card in its new home. First clickable increment.

- [ ] **Step 1: Read the Next.js navigation docs**

Per `AGENTS.md`, this Next.js version differs from training data. Before writing URL-sync code, read the relevant guide:

Run: `ls node_modules/next/dist/docs/ && grep -rl "useSearchParams\|history" node_modules/next/dist/docs/ | head -5`

Then read whichever file covers client navigation and query params. **Use `window.history.replaceState` for the shallow URL update** rather than a router method — it is framework-version-agnostic and does not remount the page. Read `useSearchParams` usage for the initial read.

- [ ] **Step 2: Add the i18n namespace**

In `messages/en.json`, add a top-level `"Knowledge"` namespace (keep the file's existing alphabetical placement convention among top-level namespaces):

```json
"Knowledge": {
  "tab": "Knowledge",
  "title": "Knowledge base",
  "subtitle": "The structured knowledge your AI agent uses to describe services, qualify leads, and report purchases.",
  "legacy": {
    "sectionTitle": "Legacy documents",
    "sectionHint": "Free-text documents from the old knowledge base. Still searched by the assistant. These will be retired once their content is migrated."
  },
  "empty": {
    "title": "No services yet",
    "body": "Add a service to start building structured knowledge your AI agent can use.",
    "action": "Add your first service"
  }
}
```

- [ ] **Step 3: Create `legacy-documents.tsx`**

```tsx
'use client';

import { useTranslations } from 'next-intl';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { AiKnowledgeCard } from '@/components/settings/ai-knowledge';

/**
 * The pre-v2 knowledge base, relocated here from the Setup tab.
 *
 * Collapsed by default and labelled as legacy: retrieval still searches
 * these documents, but structured entries are the system of record going
 * forward, and Phase 2b adds the migration + deletion flow. `AiKnowledgeCard`
 * itself is unchanged — only its home moved.
 */
export function LegacyDocuments({
  canEdit,
  hasEmbeddingsKey,
}: {
  canEdit: boolean;
  hasEmbeddingsKey: boolean;
}) {
  const t = useTranslations('Knowledge.legacy');
  return (
    <Accordion type="single" collapsible className="mt-6">
      <AccordionItem value="legacy">
        <AccordionTrigger>{t('sectionTitle')}</AccordionTrigger>
        <AccordionContent>
          <p className="mb-3 text-sm text-muted-foreground">{t('sectionHint')}</p>
          <AiKnowledgeCard canEdit={canEdit} hasEmbeddingsKey={hasEmbeddingsKey} />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
```

- [ ] **Step 4: Create `knowledge-studio.tsx` (shell only)**

`api.aiConfig.get` returns `null` when no config exists, and otherwise an object that already exposes `hasEmbeddingsKey: !!config.embeddingsApiKey` (verified at `convex/aiConfig.ts`). So `config?.hasEmbeddingsKey ?? false` is exactly right — no duplication of `ai-config`'s local state.

The admin predicate is `canEditSettings` from `src/lib/auth/roles.ts`, which resolves to `hasMinRole(role, "admin")` — the same bar the backend's `ctx.requireRole("admin")` enforces, so the UI gate and the server gate cannot disagree. Use it rather than open-coding a role comparison; that file's header explicitly asks call sites to use the predicates.

```tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import { LegacyDocuments } from './legacy-documents';
import { api } from '../../../convex/_generated/api';

/**
 * Root of the Knowledge tab.
 *
 * Every query here is admin-only on the server. `accountRole` is null while
 * the profile loads, and this app has no error boundary — firing an
 * admin-gated query in that window throws during render and crashes the
 * page. Hence the `'skip'` guard rather than an optimistic call.
 */
export function KnowledgeStudio() {
  const t = useTranslations('Knowledge');
  const { accountRole } = useAuth();
  // `accountRole` is null while the profile loads, so this is false during
  // that window — which is exactly what keeps the admin-only queries below
  // from firing early and throwing in render.
  const isAdmin = accountRole ? canEditSettings(accountRole) : false;
  const [selectedService, setSelectedService] = useState<string | null>(null);

  const overview = useQuery(api.knowledge.studioOverview, isAdmin ? {} : 'skip');
  const config = useQuery(api.aiConfig.get, isAdmin ? {} : 'skip');

  if (!isAdmin) return null;

  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>

      {/* Tasks 4-7 render the matrix / detail here. */}
      {overview === undefined ? (
        <div className="mt-6 h-24 animate-pulse rounded-md bg-muted" />
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          {overview.services.length} service(s)
        </p>
      )}

      <LegacyDocuments
        canEdit={isAdmin}
        hasEmbeddingsKey={config?.hasEmbeddingsKey ?? false}
      />
    </div>
  );
}
```

Import the predicate: `import { canEditSettings } from '@/lib/auth/roles';`.

- [ ] **Step 5: Wire the tab into the agents page**

In `src/app/(dashboard)/agents/page.tsx`:
1. Widen the union: `type Tab = 'playground' | 'knowledge' | 'setup' | 'usage';`
2. Import `KnowledgeStudio` and `useSearchParams`.
3. Read the initial tab from the URL, and make the existing first-visit landing logic yield to it. Replace the render-time adjustment's condition so it only fires when the URL did **not** specify a tab:

```tsx
const searchParams = useSearchParams();
const urlTab = searchParams.get('tab') as Tab | null;
const [tab, setTab] = useState<Tab>(urlTab ?? 'playground');
const [decided, setDecided] = useState(false);

// Unchanged intent: land first-time users on Setup, returning users on the
// Playground, decided exactly once. Now yields to an explicit ?tab= deep
// link, which must never be overridden.
if (!decided && configDoc !== undefined) {
  setDecided(true);
  if (!urlTab) setTab(configDoc ? 'playground' : 'setup');
}
```

4. Sync the URL on change, shallowly:

```tsx
const selectTab = (next: Tab) => {
  setTab(next);
  const params = new URLSearchParams(window.location.search);
  params.set('tab', next);
  window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
};
```
Pass `selectTab` to `<Tabs onValueChange={(v) => selectTab(v as Tab)}>` and to `AiPlayground`'s `onGoToSetup`.

5. Add the trigger (admin-only, mirroring how `usage` is gated by `canViewUsage`) and the content:

```tsx
{canViewUsage && (
  <TabsTrigger value="knowledge">
    <BookOpen className="mr-1.5 h-4 w-4" /> {tKnowledge('tab')}
  </TabsTrigger>
)}
```
```tsx
{canViewUsage && (
  <TabsContent value="knowledge" className="mt-4">
    <KnowledgeStudio />
  </TabsContent>
)}
```
Import `BookOpen` from `lucide-react` alongside the existing icons.

> Note on the gate: `canViewUsage` is already `canEditSettings(accountRole)`, which resolves to `hasMinRole(role, "admin")` — the same bar the backend enforces. Reusing it for the Knowledge trigger is therefore correct and keeps the trigger and the query in agreement. Rename the local to something covering both uses (e.g. `canManageAi`) if the two-purpose name bothers you, but do **not** introduce a second, differently-derived predicate: a mismatch between the tab gate and the query gate is exactly what produces the render-crash the Global Constraints warn about.

- [ ] **Step 6: Remove the card from its old home**

In `src/components/settings/ai-config.tsx`: delete the import on line 28 and the entire `{canEdit && (<AiKnowledgeCard … />)}` block at lines 414-421. Leave everything else untouched. Confirm nothing else in that file references `AiKnowledgeCard`:

Run: `grep -n "AiKnowledgeCard" src/components/settings/ai-config.tsx`
Expected: no output.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm run build && npm test 2>&1 | tail -3`
Expected: tsc clean, build green, full suite still 1965+ passing.

- [ ] **Step 8: Commit**

```bash
git add src/app/\(dashboard\)/agents/page.tsx src/components/settings/ai-config.tsx \
  src/components/knowledge/knowledge-studio.tsx src/components/knowledge/legacy-documents.tsx \
  messages/en.json
git commit -m "feat(kb): knowledge tab shell, relocate legacy documents card

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Service matrix

**Files:**
- Create: `src/components/knowledge/service-matrix.tsx`
- Create: `src/components/knowledge/service-matrix.test.tsx`
- Modify: `src/components/knowledge/knowledge-studio.tsx` (render the matrix)
- Modify: `messages/en.json` (matrix keys)

**Interfaces:**
- Consumes: the `studioOverview` return type from Task 2; `ServiceVerdict` from Task 1.
- Produces:

```tsx
export type ServiceRow = {
  key: string; name: string; aliases: string[];
  status: 'active' | 'paused'; sortOrder: number;
  entries: Record<string, { published: number; draft: number }>;
  ops: Record<'qualification' | 'sales' | 'purchase',
    { state: 'published' | 'draft' | 'absent'; marksTotal: number | null }>;
  verdict: ServiceVerdict;
};

export function ServiceMatrix(props: {
  services: ServiceRow[];
  onSelectService: (key: string) => void;
  onCreateService: () => void;
}): JSX.Element;
```

**No Convex hooks in this file** — it is rendered against mock data during browser verification (Task 8).

The six columns, in order: Overview (`entries.overview`), FAQ (`entries.faq`), Requirements (`entries.requirements`), Qualification (`ops.qualification`), Sales (`ops.sales`), Purchase (`ops.purchase`). The four remaining entry types (`itinerary`, `policy`, `process`, `note`) are summed into a trailing "+N more" count so nothing is invisible.

- [ ] **Step 1: Write the failing test**

> **This repo has no `@testing-library/react` and you must not add one.** Its only component test, `src/components/ui/dropdown-menu-group-label.test.tsx`, renders with `renderToStaticMarkup` from `react-dom/server` — match that exactly. Static markup cannot exercise click handlers, so `onSelectService` / `onCreateService` wiring is verified in the browser pass (Task 8), not here. Name the test file `service-matrix.test.tsx` (it contains JSX).

```tsx
import { describe, expect, test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';
import { ServiceMatrix, otherEntryCount, type ServiceRow } from './service-matrix';

const emptyEntries = {
  overview: { published: 0, draft: 0 }, faq: { published: 0, draft: 0 },
  itinerary: { published: 0, draft: 0 }, requirements: { published: 0, draft: 0 },
  policy: { published: 0, draft: 0 }, process: { published: 0, draft: 0 },
  note: { published: 0, draft: 0 },
};
const absentOps = {
  qualification: { state: 'absent' as const, marksTotal: null },
  sales: { state: 'absent' as const, marksTotal: null },
  purchase: { state: 'absent' as const, marksTotal: null },
};

function row(over: Partial<ServiceRow> = {}): ServiceRow {
  return {
    key: 'georgia', name: 'Georgia', aliases: [], status: 'active', sortOrder: 0,
    entries: emptyEntries, ops: absentOps, verdict: 'empty', ...over,
  };
}

function markup(services: ServiceRow[]): string {
  return renderToStaticMarkup(
    React.createElement(
      NextIntlClientProvider,
      { locale: 'en', messages },
      React.createElement(ServiceMatrix, {
        services,
        onSelectService: () => {},
        onCreateService: () => {},
      }),
    ),
  );
}

describe('otherEntryCount', () => {
  test('sums only entry types that have no column of their own', () => {
    expect(otherEntryCount({
      ...emptyEntries,
      overview: { published: 5, draft: 5 },   // has a column — excluded
      policy: { published: 1, draft: 0 },
      note: { published: 0, draft: 2 },
    })).toBe(3);
  });
  test('is zero when only column-backed types have content', () => {
    expect(otherEntryCount({ ...emptyEntries, faq: { published: 9, draft: 0 } })).toBe(0);
  });
});

describe('ServiceMatrix', () => {
  test('renders the empty state when there are no services', () => {
    expect(markup([])).toContain(messages.Knowledge.empty.title);
  });

  test('renders the service name and its verdict label', () => {
    const html = markup([row({ verdict: 'ready' })]);
    expect(html).toContain('Georgia');
    expect(html).toContain(messages.Knowledge.verdict.ready);
  });

  test('renders the qualification marks total when one is known', () => {
    expect(markup([row({
      ops: { ...absentOps, qualification: { state: 'published', marksTotal: 90 } },
    })])).toContain('90');
  });

  test('renders a "+N more" count for entry types without a column', () => {
    expect(markup([row({
      entries: {
        ...emptyEntries,
        policy: { published: 1, draft: 0 },
        note: { published: 0, draft: 2 },
      },
    })])).toContain('+3 more');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/knowledge/service-matrix.test.tsx`
Expected: FAIL — cannot resolve `./service-matrix`.

- [ ] **Step 3: Add i18n keys**

Extend the `Knowledge` namespace in `messages/en.json`:

```json
"verdict": {
  "ready": "Ready",
  "blocked": "Blocked",
  "draft": "Draft",
  "empty": "Empty"
},
"columns": {
  "service": "Service",
  "overview": "Overview",
  "faq": "FAQ",
  "requirements": "Requirements",
  "qualification": "Qualification",
  "sales": "Sales",
  "purchase": "Purchase"
},
"matrix": {
  "otherCount": "+{count} more",
  "newService": "Add service",
  "marksOff": "Marks total {total}, needs 100"
}
```

- [ ] **Step 4: Implement the matrix**

Export two pure helpers alongside the component so they are testable without DOM:

```tsx
export const MATRIX_ENTRY_COLUMNS = ['overview', 'faq', 'requirements'] as const;
export const OTHER_ENTRY_TYPES = ['itinerary', 'policy', 'process', 'note'] as const;

/** Entries whose type has no column of its own, so nothing is invisible. */
export function otherEntryCount(
  entries: Record<string, { published: number; draft: number }>,
): number {
  return OTHER_ENTRY_TYPES.reduce(
    (n, type) => n + (entries[type]?.published ?? 0) + (entries[type]?.draft ?? 0),
    0,
  );
}
```

Render a `Table` from `@/components/ui/table` on `sm` and up; below `sm` render one `Card` per service (the repo's established responsive approach — see `leads-board-view.tsx` for the icon-only/stacked treatment below `sm`). Each service row is a `button` (so it is keyboard-reachable) calling `onSelectService(key)`.

Cell rendering:
- Entry columns: a filled dot when `published > 0`, a hollow dot when only `draft > 0`, a muted dash when both are zero. Put the counts in a `title`/`aria-label` so the state is not conveyed by shape alone.
- Ops columns: same three states from `state`. For `qualification`, additionally render `marksTotal` when non-null, styled as a warning when it is published and not 100, with the `matrix.marksOff` message as its tooltip.
- Verdict: a `Badge` per verdict. Use `softBadge` styling if the repo has it (`grep -rn "softBadge" src/ | head -3`) — that helper exists specifically for readable contrast in both themes.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/components/knowledge/service-matrix.test.tsx && npm run typecheck`
Expected: PASS, tsc clean.

- [ ] **Step 6: Render it from the studio**

In `knowledge-studio.tsx`, replace the placeholder `<p>{overview.services.length} service(s)</p>` with `<ServiceMatrix services={overview.services} onSelectService={setSelectedService} onCreateService={…} />`. Leave `onCreateService` as a no-op that opens nothing until Task 5 supplies the form; wire a `useState` boolean for it now so Task 5 only has to render the dialog.

- [ ] **Step 7: Commit**

```bash
git add src/components/knowledge/service-matrix.tsx src/components/knowledge/service-matrix.test.tsx \
  src/components/knowledge/knowledge-studio.tsx messages/en.json
git commit -m "feat(kb): service readiness matrix

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Service create/edit form

**Files:**
- Create: `src/components/knowledge/service-form.tsx`
- Modify: `src/components/knowledge/knowledge-studio.tsx` (render the dialog)
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.kbServices.upsert` and `api.kbServices.remove` (both existing), `lintServiceInput` + `hasLintErrors` from `convex/lib/kb/lint` (import path from `src/`: `'../../../convex/lib/kb/lint'` — verify the relative depth compiles).
- Produces:

```tsx
export function ServiceForm(props: {
  open: boolean;
  initial?: {
    key: string; name: string; aliases: string[]; routingTagName?: string;
    status: 'active' | 'paused'; sortOrder: number;
  };
  existingKeys: string[];
  onClose: () => void;
  onSubmit: (values: {
    key: string; name: string; aliases: string[]; routingTagName?: string;
    status: 'active' | 'paused'; sortOrder: number;
  }) => Promise<void>;
  /** Present only in edit mode; omit for create. */
  onDelete?: () => Promise<void>;
}): JSX.Element;
```

The component is presentational: it renders a `Dialog`, validates with `lintServiceInput`, and calls `onSubmit`. The studio owns the `useMutation` call, so this file stays Convex-free and browser-verifiable.

**Key behaviour:** `key` is the service's immutable identity — when `initial` is provided, the key field is rendered read-only. Creating derives a suggested key by slugifying the name, which the user may override before first save.

**Deletion:** in edit mode the dialog shows a Delete action behind a confirm step. `kbServices.remove` refuses with `ConvexError({ code: 'BAD_REQUEST', reason: 'service_in_use' })` while any entry or ops block still references the key — Convex has no cascading deletes, so this is enforced in application code. Catch that specific `reason` and render `serviceForm.deleteBlocked` rather than a generic failure; the user's next action is to delete the service's content first, and the message must say so.

`routingTagName` is a free-text field linking this service to the member-routing tag used when offering leads to salespeople. It is optional and unvalidated here; leave it blank if unused.

- [ ] **Step 1: Write the failing test**

Test the two pure pieces (no DOM required):

```ts
import { expect, test } from 'vitest';
import { suggestServiceKey, parseAliases } from './service-form';

test('suggestServiceKey slugifies a display name', () => {
  expect(suggestServiceKey('UAE Visa Services')).toBe('uae-visa-services');
  expect(suggestServiceKey('  Flights & Hotels ')).toBe('flights-hotels');
});

test('parseAliases splits on commas, trims, drops blanks, dedupes case-insensitively', () => {
  expect(parseAliases('visa, Tourist Visa , , visa')).toEqual(['visa', 'Tourist Visa']);
  expect(parseAliases('')).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/knowledge/service-form.test.ts`
Expected: FAIL — cannot resolve `./service-form`.

- [ ] **Step 3: Add i18n keys**

```json
"serviceForm": {
  "createTitle": "Add service",
  "editTitle": "Edit service",
  "name": "Display name",
  "namePlaceholder": "UAE Visa Services",
  "key": "Key",
  "keyHint": "Used internally to link content, routing, and reports. Cannot be changed once created.",
  "aliases": "Aliases",
  "aliasesHint": "Comma-separated. Other ways customers name this service, e.g. \"tourist visa, visit visa\".",
  "routingTag": "Routing tag",
  "routingTagHint": "Optional. The member tag used to decide which salespeople are offered leads for this service.",
  "status": "Status",
  "statusActive": "Active",
  "statusPaused": "Paused",
  "sortOrder": "Display order",
  "save": "Save",
  "cancel": "Cancel",
  "delete": "Delete service",
  "deleteConfirm": "Delete this service? Its key can be reused afterwards.",
  "deleteBlocked": "This service still has entries or checklists. Delete its content first, then delete the service."
}
```

- [ ] **Step 4: Implement**

```tsx
export function suggestServiceKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function parseAliases(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const norm = trimmed.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(trimmed);
  }
  return out;
}
```

The dialog holds local state for each field, runs `lintServiceInput({ key, name, aliases, existingKeys })` on every change, renders each returned `issue.message` beneath its field, and disables Save while `hasLintErrors(issues)`. On submit, `await onSubmit(values)`; if it rejects, render the thrown `ConvexError`'s `data.issues` (array of `LintIssue`) or `data.reason` at the top of the dialog rather than closing it.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/components/knowledge/service-form.test.ts && npm run typecheck`
Expected: PASS (2 tests), tsc clean.

- [ ] **Step 6: Wire into the studio**

In `knowledge-studio.tsx`:

```tsx
const upsertService = useMutation(api.kbServices.upsert);
const removeService = useMutation(api.kbServices.remove);
```

Render the dialog with `existingKeys={overview.services.map((s) => s.key)}`, `onSubmit={async (v) => { await upsertService(v); setFormOpen(false); }}`, and — only when editing an existing service — `onDelete={async () => { await removeService({ key: editing.key }); setFormOpen(false); setSelectedService(null); }}`. Returning to the matrix after a delete matters: leaving the detail view open on a service that no longer exists would render an empty shell.

Note `existingKeys` is used purely for the create-mode uniqueness check; `lintServiceInput` is called with `existingKeys: []` in edit mode so a service's own key is never reported as taken (the same conditional the backend's `upsert` applies).

- [ ] **Step 7: Commit**

```bash
git add src/components/knowledge/service-form.tsx src/components/knowledge/service-form.test.ts \
  src/components/knowledge/knowledge-studio.tsx messages/en.json
git commit -m "feat(kb): service create/edit form

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Service detail + entry editor

**Files:**
- Create: `src/components/knowledge/service-detail.tsx`
- Create: `src/components/knowledge/entry-editor.tsx`
- Modify: `src/components/knowledge/knowledge-studio.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.kbEntries.list` (existing, args `{ serviceKey }`), `api.kbEntries.save` / `publish` / `unpublish` / `remove` (existing); `lintEntryInput` from `convex/lib/kb/lint`.
- Produces:

```tsx
export function ServiceDetail(props: {
  service: ServiceRow;                      // from service-matrix.tsx
  entries: EntrySummary[];
  onBack: () => void;
  onEditService: () => void;
  onSaveEntry: (values: EntryDraft) => Promise<void>;
  onPublishEntry: (entryId: string) => Promise<void>;
  onUnpublishEntry: (entryId: string) => Promise<void>;
  onRemoveEntry: (entryId: string) => Promise<void>;
  opsSlot: (kind: 'qualification' | 'sales' | 'purchase') => React.ReactNode;
}): JSX.Element;

export type EntrySummary = {
  _id: string; type: string; title: string; body: string;
  audience: 'customer' | 'internal'; status: 'draft' | 'published'; version: number;
};
export type EntryDraft = {
  entryId?: string; type: string; title: string; body: string;
  audience: 'customer' | 'internal';
};
```

`opsSlot` is a render prop so Task 7's checklist editors mount inside the detail view without this file importing them — keeping the two tasks independently reviewable.

**Deliverable:** an admin can create, edit, publish, unpublish, and delete prose entries for a service.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { groupEntriesByType, ENTRY_TYPE_ORDER } from './service-detail';

test('groupEntriesByType buckets entries and preserves the canonical type order', () => {
  const grouped = groupEntriesByType([
    { _id: '1', type: 'faq', title: 'Q1', body: '', audience: 'customer', status: 'published', version: 1 },
    { _id: '2', type: 'overview', title: 'O', body: '', audience: 'customer', status: 'draft', version: 1 },
    { _id: '3', type: 'faq', title: 'Q2', body: '', audience: 'customer', status: 'draft', version: 1 },
  ]);
  expect(Object.keys(grouped)).toEqual(ENTRY_TYPE_ORDER.filter((t) => grouped[t]?.length));
  expect(grouped.faq?.map((e) => e._id)).toEqual(['1', '3']);
  expect(grouped.overview?.map((e) => e._id)).toEqual(['2']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/knowledge/service-detail.test.ts`
Expected: FAIL — cannot resolve `./service-detail`.

- [ ] **Step 3: Add i18n keys**

```json
"detail": {
  "back": "All services",
  "editService": "Edit service",
  "addEntry": "Add {type}",
  "noEntries": "Nothing here yet.",
  "draftBadge": "Draft",
  "publishedBadge": "Published",
  "version": "v{n}"
},
"entryEditor": {
  "title": "Title",
  "body": "Content",
  "type": "Type",
  "audience": "Audience",
  "audienceCustomer": "Customer-facing",
  "audienceInternal": "Internal only",
  "audienceHint": "Internal content is used to steer the AI but is never quoted to a customer.",
  "saveDraft": "Save draft",
  "publish": "Publish",
  "unpublish": "Unpublish",
  "delete": "Delete",
  "deleteConfirm": "Delete this entry and its compiled search content? This cannot be undone.",
  "editWarning": "Saving changes moves this entry back to draft. It stays out of the AI's answers until you publish again."
}
```

`editWarning` is important: the backend's `save` deliberately demotes a published entry to draft and bumps its version, so the UI must set that expectation before the user clicks.

- [ ] **Step 4: Implement**

```ts
export const ENTRY_TYPE_ORDER = [
  'overview', 'faq', 'requirements', 'itinerary', 'policy', 'process', 'note',
] as const;

export function groupEntriesByType(
  entries: EntrySummary[],
): Partial<Record<string, EntrySummary[]>> {
  const grouped: Partial<Record<string, EntrySummary[]>> = {};
  for (const type of ENTRY_TYPE_ORDER) {
    const matching = entries.filter((e) => e.type === type);
    if (matching.length) grouped[type] = matching;
  }
  return grouped;
}
```

`ServiceDetail` renders: a back button, the service name + verdict badge + "Edit service", then one section per entry type in `ENTRY_TYPE_ORDER` (each listing its entries with status badge, version, and edit/publish/unpublish/delete actions), then three ops sections rendered via `opsSlot('qualification' | 'sales' | 'purchase')`.

`EntryEditor` is a `Dialog` with type `Select`, title `Input`, body `Textarea`, audience `RadioGroup`. It runs `lintEntryInput` and renders issues inline; `price_mention` is warning-level and renders as an advisory note that does **not** disable saving. Delete uses a confirm `Dialog` with `deleteConfirm`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/components/knowledge/service-detail.test.ts && npm run typecheck`
Expected: PASS, tsc clean.

- [ ] **Step 6: Wire into the studio**

In `knowledge-studio.tsx`, when `selectedService` is non-null, run `useQuery(api.kbEntries.list, isAdmin && selectedService ? { serviceKey: selectedService } : 'skip')` and render `<ServiceDetail … />` instead of the matrix. Wire the four mutation callbacks to `useMutation(api.kbEntries.save/publish/unpublish/remove)`. Also sync `?service=<key>` into the URL with the same `window.history.replaceState` helper Task 3 introduced, and read it on mount to restore a deep link. If `?service=` names a key not present in `overview.services`, clear the param and fall back to the matrix.

- [ ] **Step 7: Commit**

```bash
git add src/components/knowledge/service-detail.tsx src/components/knowledge/service-detail.test.ts \
  src/components/knowledge/entry-editor.tsx src/components/knowledge/knowledge-studio.tsx messages/en.json
git commit -m "feat(kb): service detail view and entry editor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Checklist editor (all three ops kinds)

**Files:**
- Create: `src/components/knowledge/checklist-editor.tsx`
- Create: `src/components/knowledge/checklist-editor.test.ts`
- Modify: `src/components/knowledge/knowledge-studio.tsx` (supply `opsSlot`)
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.kbOps.get` (existing, args `{ serviceKey, kind }`), `api.kbOps.save` / `publish` / `unpublish` (existing); `lintOpsBlock` + `hasLintErrors` from `convex/lib/kb/lint`; `marksTotal` from `src/lib/knowledge/verdict`.
- Produces:

```tsx
export type ChecklistRow = {
  key: string; label: string;
  question?: string;      // qualification only
  description?: string;   // sales only
  marks?: number;         // qualification only
};

export function ChecklistEditor(props: {
  kind: 'qualification' | 'sales' | 'purchase';
  rows: ChecklistRow[];
  reportValue?: number;
  currency?: string;
  status: 'draft' | 'published' | 'absent';
  onSave: (values: {
    rows: ChecklistRow[]; reportValue?: number; currency?: string;
  }) => Promise<void>;
  onPublish: () => Promise<void>;
  onUnpublish: () => Promise<void>;
}): JSX.Element;

export function nextRowKey(label: string, existing: string[]): string;
```

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from 'vitest';
import { nextRowKey } from './checklist-editor';

test('nextRowKey slugifies the label', () => {
  expect(nextRowKey('Travel dates', [])).toBe('travel-dates');
});

test('nextRowKey dedupes against existing keys with a numeric suffix', () => {
  expect(nextRowKey('Travel dates', ['travel-dates'])).toBe('travel-dates-2');
  expect(nextRowKey('Travel dates', ['travel-dates', 'travel-dates-2'])).toBe('travel-dates-3');
});

test('nextRowKey falls back for a label with no slug-able characters', () => {
  expect(nextRowKey('!!!', [])).toBe('item');
  expect(nextRowKey('!!!', ['item'])).toBe('item-2');
});

test('nextRowKey truncates very long labels to 40 characters', () => {
  const key = nextRowKey('a'.repeat(80), []);
  expect(key.length).toBeLessThanOrEqual(40);
});
```

This mirrors `kbImport`'s `dedupedItemKeys` so hand-authored and imported blocks are shaped identically. Read `convex/kbImport.ts`'s implementation first and match its rules exactly.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/knowledge/checklist-editor.test.ts`
Expected: FAIL — cannot resolve `./checklist-editor`.

- [ ] **Step 3: Add i18n keys**

```json
"checklist": {
  "qualification": "Qualification checklist",
  "sales": "Sales checklist",
  "purchase": "Purchase criteria",
  "qualificationHint": "What the AI must learn before a lead counts as qualified. Marks must total exactly 100.",
  "salesHint": "The steps a salesperson works through after a lead qualifies.",
  "purchaseHint": "When a qualified lead is strong enough to report as a Purchase to Meta.",
  "addRow": "Add item",
  "removeRow": "Remove",
  "moveUp": "Move up",
  "moveDown": "Move down",
  "label": "Item",
  "question": "Question to ask",
  "description": "Detail",
  "marks": "Marks",
  "marksTotal": "Total {total} / 100",
  "marksIncomplete": "Fill in marks for every item to see the total.",
  "reportValue": "Reported value",
  "currency": "Currency",
  "saveDraft": "Save draft",
  "publish": "Publish",
  "unpublish": "Unpublish",
  "publishBlocked": "Fix the issues above before publishing.",
  "notCreated": "Not set up yet."
}
```

- [ ] **Step 4: Implement**

```ts
const MAX_KEY_LENGTH = 40;

export function nextRowKey(label: string, existing: string[]): string {
  const base =
    label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      .slice(0, MAX_KEY_LENGTH).replace(/-+$/, '') || 'item';
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
```

The component renders rows in a vertical list with per-row `Input`s for label (plus `question` for qualification, `description` for sales), a numeric `Input` for `marks` on qualification only, and move-up / move-down / remove buttons. Below the rows:

- **qualification:** a live total using `marksTotal(rows)`. When it returns `null`, show `marksIncomplete`. When non-null, show `marksTotal` and style it as an error unless it equals 100.
- **purchase:** numeric `reportValue` and a 3-letter `currency` input.

Validation calls `lintOpsBlock({ kind, criteria|steps|conditions, reportValue, currency })`, mapping `rows` into the field the kind expects. Save is disabled only when a **shape** error is present (`label_required`, `key_duplicate`), matching the backend's permissive `save`. Publish is disabled when `hasLintErrors(issues)`, with `publishBlocked` explaining why. Row `key` is assigned once via `nextRowKey` when a row is added and never rewritten when its label is edited.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/components/knowledge/checklist-editor.test.ts && npm run typecheck`
Expected: PASS (4 tests), tsc clean.

- [ ] **Step 6: Wire into the studio**

Supply `opsSlot` from `knowledge-studio.tsx`: for each kind, `useQuery(api.kbOps.get, isAdmin && selectedService ? { serviceKey: selectedService, kind } : 'skip')` and render `<ChecklistEditor … />` with `onSave` → `useMutation(api.kbOps.save)`, `onPublish` → `api.kbOps.publish`, `onUnpublish` → `api.kbOps.unpublish`. Map each block's stored field into `rows`: `criteria` for qualification, `steps` for sales, `conditions` for purchase.

> Hooks note: `opsSlot` is called during render for three kinds. Do **not** call `useQuery` inside that callback — React hooks cannot run conditionally or in a loop body. Run the three `useQuery` calls unconditionally at the top of `KnowledgeStudio` (each `'skip'`ped when there is no selected service) and have `opsSlot` merely select from the already-fetched results.

- [ ] **Step 7: Commit**

```bash
git add src/components/knowledge/checklist-editor.tsx src/components/knowledge/checklist-editor.test.ts \
  src/components/knowledge/knowledge-studio.tsx messages/en.json
git commit -m "feat(kb): checklist editor for qualification, sales, and purchase blocks

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Browser verification and the merge gate

**Files:**
- Create (temporary): `src/app/preview-knowledge/page.tsx`
- Modify: `/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0/.claude/launch.json` (dev-server registration)
- Delete before commit: the temporary preview route

**Why a preview route:** `/agents` is auth-gated and bounces to `/` after roughly 20 seconds, so the studio cannot be driven directly in a browser session. This repo has twice used a temporary public route rendering the presentational components against mock data (`/preview-leads`, `/preview-pipeline`), verified it, then deleted the route before merge. Do the same.

- [ ] **Step 1: Register the dev server**

The preview registry is the **outer** workspace file `/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0/.claude/launch.json` — a worktree-local `.claude/launch.json` is **ignored**. Add a configuration whose `runtimeArgs` use `npm --prefix .claude/worktrees/feat-knowledge-studio run dev` and a free port.

- [ ] **Step 2: Create the temporary preview route**

Render `<ServiceMatrix>` with a mock array covering every verdict (`ready`, `blocked`, `draft`, `empty`), a service with a 90-mark published qualification, and one with `+N more` entries; then `<ServiceDetail>` with mock entries; then `<ChecklistEditor kind="qualification">` with rows totalling 90 so the error state is visible. Pass no-op async callbacks. Wrap in `NextIntlClientProvider` with the real `messages/en.json` so the i18n keys are exercised.

- [ ] **Step 3: Verify in the browser**

Start the server via the preview tooling and check, capturing a screenshot of each:
1. Desktop width, dark mode (the app default).
2. Desktop width, light mode — set with `document.documentElement.dataset.mode = 'light'`. The app keys off `html[data-mode]`, **not** a `.dark` class or next-themes.
3. Mobile width (375px) — confirm the matrix falls back to cards and no row overflows horizontally.

Confirm specifically: verdict badges are legible in both themes; the 90/100 marks total reads as an error; `+N more` appears; the checklist editor's publish button is disabled with `publishBlocked` visible.

Read the browser console and report any errors or warnings.

- [ ] **Step 4: Fix anything the browser reveals, then delete the route**

```bash
rm -rf src/app/preview-knowledge
grep -rn "preview-knowledge" src/ || echo "route fully removed"
```

- [ ] **Step 5: Run the full gate**

```bash
npm test
npm run typecheck
npm run build
npm run lint 2>&1 | tail -3   # compare against the baseline captured before Task 1
git diff --stat origin/main -- convex/aiKnowledge.ts convex/aiReply.ts \
  convex/qualificationEngine.ts convex/salesChecklists.ts convex/kbCompile.ts src/lib/ai/defaults.ts
```

Expected: full suite green (1965 baseline + this phase's new tests), tsc clean, build green, lint findings **equal to the pre-Task-1 baseline** (0 errors / 15 warnings — the repo carries known debt, so "clean" is not the bar), and the final `git diff --stat` **EMPTY**, proving no engine or retrieval file was touched.

- [ ] **Step 6: Commit**

```bash
git add .claude/launch.json
git commit -m "chore(kb): register knowledge studio preview server

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(If `.claude/launch.json` is outside the worktree and therefore not stageable from it, skip the commit and note that in the report — the registration is developer-local tooling, not shipped code.)

---

## Deploy runbook (owner-gated — do NOT run during implementation)

1. `git fetch origin && git merge origin/main` into the branch; re-run the Task 8 gate. Check `gh pr list --state merged --limit 5` for surprises — a stale deploy previously stomped another branch's functions for ten minutes.
2. Copy `.env.local` from the main checkout into the worktree (worktrees lack it).
3. `npx convex deploy -y`, then confirm `npx convex function-spec` lists `knowledge:studioOverview`.
4. Merge the PR → Netlify builds `main`.
5. **Unlike Phase 1, this phase is user-visible**: admins gain a Knowledge tab. It only exposes authoring; no engine reads structured content until Phase 3.

## Follow-up (Phase 2b, separate plan)

Import wizard over `kbImport.preview` / `apply`, draft review queue, migration progress, gated legacy-document deletion, and retrieval verification (surfacing which chunks grounded a reply, most likely as an addition to the existing `ai-playground`).
