# WA Funnel Conversions — Phase 4: Funnel analytics dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins an in-app view of funnel performance — a `/campaigns` dashboard showing per-stage conversion counts, total purchases + value, and the Meta delivery breakdown — rolled up from the unified `conversionEvents` + `funnelTransitions` tables.

**Architecture:** Purely additive and read-only. One admin-gated `campaigns.overview` `accountQuery` aggregates the funnel; a new admin-only `/campaigns` section renders it with the existing `MetricCard` + skeleton components. No changes to any deployed write path (`setStage`/`seedNewLead`/the dispatcher are untouched). The two small deferred fixes (sale-value on `funnelTransitions`, auto-`new_lead` display) stay deferred — the dashboard reads what's already written.

**Tech Stack:** Next.js (App Router) + React, Convex (`accountQuery`/`useQuery`), next-intl, `convex-test` + Vitest.

## Global Constraints

- **Offline codegen only.** NEVER run `convex dev`/`deploy`/`codegen`. New module `convex/campaigns.ts` = a 2-line `convex/_generated/api.d.ts` hand-edit (import + member) in correct alphabetical order. New frontend files aren't Convex modules.
- **Stage files EXPLICITLY.** NEVER `git add -A` (untracked `.claude/worktrees/*` present).
- **i18n = single locale** `messages/en.json`.
- **Style:** convex files double-quoted; frontend follows local style. No broad `prettier --write`. Lint gate = no NEW findings; verify via `npm test` + `npm run typecheck` + `npm run build`.
- **Admin-gated:** `campaigns.overview` calls `ctx.requireRole("admin")` (it exposes account-wide conversion/revenue aggregates — same gate as `attribution.listConversions`). The `/campaigns` nav + route are gated admin+ via a new `ADMIN_ONLY_NAV` entry (supervisors are otherwise all-access, so this override is required).
- **TDD** for Task 1 (query) + Task 2 (nav gating). Task 3 (UI page) verified via typecheck + lint-delta + build (auth-gated; the ctwa-ad-inbox UI precedent).

---

## File Structure

- **Create** `convex/campaigns.ts` — `overview` admin accountQuery.
- **Create** `convex/campaigns.test.ts`.
- **Modify** `convex/_generated/api.d.ts` — register `campaigns`.
- **Modify** `src/lib/auth/roles.ts` — `ADMIN_ONLY_NAV` + `canAccessNav` override.
- **Modify** `src/lib/auth/roles.test.ts` — nav-gate tests.
- **Modify** `src/components/layout/sidebar.tsx` — the nav item.
- **Create** `src/app/(dashboard)/campaigns/page.tsx` + `src/app/(dashboard)/campaigns/loading.tsx`.
- **Modify** `messages/en.json` — `Sidebar.campaigns` + `Campaigns.*`.

---

### Task 1: `campaigns.overview` query (admin+)

**Files:**
- Create: `convex/campaigns.ts`, `convex/campaigns.test.ts`
- Modify: `convex/_generated/api.d.ts`

**Interfaces:**
- Produces: `api.campaigns.overview() → { funnel: {stage,count}[], purchase: {count,reportedValue,currency}, meta: {sent,pending,unmatched,error,abandoned,total} }`. `funnel[].count` = distinct conversations that reached each stage (from `funnelTransitions`); `purchase.reportedValue` = Σ `conversionEvents.value` for `purchased`; `meta` = `conversionEvents` status counts (account-scoped).

- [ ] **Step 1: Write the failing test** — create `convex/campaigns.test.ts` (mirror an existing convex test's `convexTest(schema, modules)` + `import.meta.glob("/convex/**/*.ts")`; admin auth via `t.withIdentity` + a `memberships` row with `role:"admin"`):

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Ada", email: "ada@example.com" }));
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", { name: "Ada", defaultCurrency: "AED", ownerUserId: userId });
    await ctx.db.insert("memberships", { userId, accountId: id, role: "admin", fullName: "Ada", email: "ada@example.com" });
    return id;
  });
  return { userId, accountId, asAdmin: t.withIdentity({ subject: `${userId}|s-Ada` }) };
}

async function seedConv(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">, stage: string, saleValue?: number) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+9715", phoneNormalized: "9715" });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      funnel: { stage: stage as "new_lead", stageUpdatedAt: 1, ...(saleValue !== undefined ? { saleValue, saleCurrency: "AED" } : {}) },
    });
    // one transition per reached stage (simplified: just the current stage)
    await ctx.db.insert("funnelTransitions", { accountId, conversationId, contactId, stage: stage as "new_lead", auto: false });
    return { contactId, conversationId };
  });
}

test("overview rolls up per-stage counts, purchases, and Meta status", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asAdmin } = await seedAdmin(t);
  await seedConv(t, accountId, "new_lead");
  await seedConv(t, accountId, "price_quoted");
  const { conversationId } = await seedConv(t, accountId, "purchased", 4200);
  // a sent Purchase conversion event + a pending lead event
  await t.run((ctx) => ctx.db.insert("conversionEvents", {
    accountId, conversationId, contactId: (await ctx.db.get(conversationId))!.contactId,
    stage: "purchased", lane: "ctwa", backend: "capi", eventName: "Purchase", identifier: "c1",
    value: 4200, currency: "AED", phone: "+9715", waMessageId: "w1", firstMessageAt: 1,
    eventId: `${conversationId}:purchased`, status: "sent", attempts: 0,
  }));

  const o = await asAdmin.query(api.campaigns.overview, {});
  const byStage = Object.fromEntries(o.funnel.map((f) => [f.stage, f.count]));
  expect(byStage.new_lead).toBe(1);
  expect(byStage.price_quoted).toBe(1);
  expect(byStage.purchased).toBe(1);
  expect(o.purchase.count).toBe(1);
  expect(o.purchase.reportedValue).toBe(4200);
  expect(o.purchase.currency).toBe("AED");
  expect(o.meta.sent).toBe(1);
  expect(o.meta.total).toBe(1);
});

test("overview is admin-gated", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAdmin(t);
  const agentId = await t.run((ctx) => ctx.db.insert("users", { name: "Ag", email: "ag@example.com" }));
  await t.run((ctx) => ctx.db.insert("memberships", { userId: agentId, accountId, role: "agent", fullName: "Ag", email: "ag@example.com" }));
  const asAgent = t.withIdentity({ subject: `${agentId}|s-Ag` });
  await expect(asAgent.query(api.campaigns.overview, {})).rejects.toThrow();
});
```

Note: the nested `await ctx.db.get(...)` inside an insert object literal in the first test won't parse — instead, capture the `contactId` from `seedConv`'s return (change `seedConv` to also return it, which it does) and pass it. Adjust the test to read `const { conversationId, contactId } = await seedConv(...)` and use `contactId` directly in the `conversionEvents` insert.

- [ ] **Step 2: Run — expect FAIL.** `npm test -- campaigns`.

- [ ] **Step 3: Create the query** — create `convex/campaigns.ts`:

```ts
import { accountQuery } from "./lib/auth";
import { FUNNEL_STAGE_KEYS } from "./lib/funnel";
import type { Id } from "./_generated/dataModel";

const STATUSES = ["sent", "pending", "unmatched", "error", "abandoned"] as const;

/**
 * Funnel performance overview for the admin dashboard. Admin+ only (exposes
 * account-wide conversion/revenue aggregates — same gate as
 * `attribution.listConversions`). Read-only, account-scoped index scans:
 *  - per-stage funnel counts (distinct conversations reaching each stage) via
 *    `funnelTransitions.by_account_stage`,
 *  - Meta delivery status counts + reported purchase value via
 *    `conversionEvents.by_account_stage`.
 */
export const overview = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const account = await ctx.db.get(ctx.accountId);
    const currency = account?.defaultCurrency ?? "USD";

    const funnel: { stage: string; count: number }[] = [];
    const meta: Record<string, number> = { sent: 0, pending: 0, unmatched: 0, error: 0, abandoned: 0, total: 0 };
    let purchaseCount = 0;
    let reportedValue = 0;

    for (const stage of FUNNEL_STAGE_KEYS) {
      // Distinct conversations that reached this stage.
      const transitions = await ctx.db
        .query("funnelTransitions")
        .withIndex("by_account_stage", (q) =>
          q.eq("accountId", ctx.accountId).eq("stage", stage),
        )
        .collect();
      const convos = new Set<Id<"conversations">>(transitions.map((t) => t.conversationId));
      funnel.push({ stage, count: convos.size });
      if (stage === "purchased") purchaseCount = convos.size;

      // Meta events seeded for this stage.
      const events = await ctx.db
        .query("conversionEvents")
        .withIndex("by_account_stage", (q) =>
          q.eq("accountId", ctx.accountId).eq("stage", stage),
        )
        .collect();
      for (const ev of events) {
        if (ev.status in meta) meta[ev.status] += 1;
        meta.total += 1;
        if (stage === "purchased" && ev.value !== undefined) reportedValue += ev.value;
      }
    }

    return {
      funnel,
      purchase: { count: purchaseCount, reportedValue, currency },
      meta: {
        sent: meta.sent, pending: meta.pending, unmatched: meta.unmatched,
        error: meta.error, abandoned: meta.abandoned, total: meta.total,
      },
    };
  },
});
```

- [ ] **Step 4: Register the module** — in `convex/_generated/api.d.ts`, add `import type * as campaigns from "../campaigns.js";` and the `campaigns: typeof campaigns;` member, both in correct alphabetical order (grep the import list — `campaigns` sorts between `broadcasts` and `contactNotes`).

- [ ] **Step 5: Run — expect PASS + typecheck + commit.**

```bash
npm test -- campaigns   # PASS
npm run typecheck       # PASS
git add convex/campaigns.ts convex/campaigns.test.ts convex/_generated/api.d.ts
git commit -m "feat(funnel): campaigns.overview funnel-analytics query (Phase 4)"
```

---

### Task 2: Admin-only nav gating

**Files:**
- Modify: `src/lib/auth/roles.ts`, `src/lib/auth/roles.test.ts`, `src/components/layout/sidebar.tsx`, `messages/en.json`

**Interfaces:**
- Consumes: the existing `canAccessNav` + `hasMinRole`.
- Produces: `ADMIN_ONLY_NAV`; `/campaigns` reachable only by admin+.

- [ ] **Step 1: Add `ADMIN_ONLY_NAV` + the override (TDD).** In `src/lib/auth/roles.test.ts`, add tests (mirror the existing `canAccessNav` tests): admin & owner → `canAccessNav(role, "/campaigns")` true; supervisor, agent, viewer → false. Run `npm test -- roles` → FAIL.

Then in `src/lib/auth/roles.ts`, add above `canAccessNav`:

```ts
/** Sections gated to admin+ even though supervisors otherwise see all nav. */
export const ADMIN_ONLY_NAV = ["/campaigns"] as const;
```

and as the FIRST check inside `canAccessNav` (before the `hasMinRole(role, "supervisor")` blanket):

```ts
  // Admin-only sections (e.g. Campaigns) override the supervisor+ blanket.
  if ((ADMIN_ONLY_NAV as readonly string[]).includes(base)) {
    return hasMinRole(role, "admin");
  }
```

Run `npm test -- roles` → PASS.

- [ ] **Step 2: Add the nav item.** In `src/components/layout/sidebar.tsx`, add `BarChart3` to the `lucide-react` import block, and add to `navItems` (after the `/agents` entry): `{ href: "/campaigns", labelKey: "campaigns", icon: BarChart3 },`. The existing `.filter((item) => accountRole && canAccessNav(accountRole, item.href))` now hides it for < admin — no other gate needed.

- [ ] **Step 3: i18n.** In `messages/en.json`, add `"campaigns": "Campaigns"` to the `Sidebar` namespace.

- [ ] **Step 4: Verify + commit.** `npm test -- roles` PASS; `npm run typecheck` PASS.

```bash
git add src/lib/auth/roles.ts src/lib/auth/roles.test.ts src/components/layout/sidebar.tsx messages/en.json
git commit -m "feat(funnel): admin-only Campaigns nav gating (Phase 4)"
```

---

### Task 3: `/campaigns` dashboard page

**Files:**
- Create: `src/app/(dashboard)/campaigns/page.tsx`, `src/app/(dashboard)/campaigns/loading.tsx`
- Modify: `messages/en.json` (`Campaigns.*`)

**Interfaces:**
- Consumes: `api.campaigns.overview`; `MetricCard` (`@/components/dashboard/metric-card`); `SkeletonCard` (`@/components/dashboard/skeleton`); `DashboardSectionSkeleton` (`@/components/layout/section-skeletons`); `useAuth`; `useTranslations`; `formatCurrency` (`@/lib/format` or wherever the dashboard imports it from — grep the dashboard page's import).

- [ ] **Step 1: `loading.tsx`** — create `src/app/(dashboard)/campaigns/loading.tsx`:

```tsx
import { DashboardSectionSkeleton } from "@/components/layout/section-skeletons";

export default function Loading() {
  return <DashboardSectionSkeleton />;
}
```

- [ ] **Step 2: The page** — create `src/app/(dashboard)/campaigns/page.tsx` (mirror `src/app/(dashboard)/dashboard/page.tsx`'s "use client" + `useQuery` + `MetricCard`/`SkeletonCard` structure; grep it for the exact `MetricCard` props + the `formatCurrency` import path):

```tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "../../../../convex/_generated/api";
import { useTranslations } from "next-intl";
import { useAuth } from "@/hooks/use-auth";
import { MetricCard } from "@/components/dashboard/metric-card";
import { SkeletonCard } from "@/components/dashboard/skeleton";
import { formatCurrency } from "@/lib/format";
import { UI_FUNNEL_STAGE_KEYS } from "@/lib/inbox/funnel";
import { Users, ShoppingCart, DollarSign, Send } from "lucide-react";

export default function CampaignsPage() {
  const t = useTranslations("Campaigns");
  const tFunnel = useTranslations("Inbox.funnel");
  const { accountId, defaultCurrency } = useAuth();
  const data = useQuery(api.campaigns.overview, accountId ? {} : "skip");
  const loading = data === undefined;
  const byStage = Object.fromEntries((data?.funnel ?? []).map((f) => [f.stage, f.count]));
  const maxCount = Math.max(1, ...(data?.funnel ?? []).map((f) => f.count));

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading || !data ? (
          Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
        ) : (
          <>
            <MetricCard title={t("newLeads")} value={(byStage.new_lead ?? 0).toLocaleString()} icon={Users} />
            <MetricCard title={t("qualified")} value={(byStage.qualified ?? 0).toLocaleString()} icon={Users} />
            <MetricCard title={t("purchases")} value={data.purchase.count.toLocaleString()} icon={ShoppingCart} />
            <MetricCard title={t("purchaseValue")} value={formatCurrency(data.purchase.reportedValue, data.purchase.currency)} icon={DollarSign} subtitle={t("reportedToMeta")} />
          </>
        )}
      </div>

      {/* Funnel breakdown */}
      {!loading && data && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-medium text-foreground">{t("funnelTitle")}</h2>
          <div className="space-y-2">
            {UI_FUNNEL_STAGE_KEYS.map((stage) => {
              const count = byStage[stage] ?? 0;
              return (
                <div key={stage} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 text-sm text-muted-foreground">{tFunnel(`stage.${stage}`)}</span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${(count / maxCount) * 100}%` }} />
                  </div>
                  <span className="w-10 shrink-0 text-right text-sm tabular-nums text-foreground">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Meta delivery */}
      {!loading && data && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-3 text-sm font-medium text-foreground">{t("metaTitle")}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {(["sent", "pending", "unmatched", "error", "abandoned", "total"] as const).map((k) => (
              <div key={k} className="rounded-lg border border-border bg-background p-3">
                <p className="text-xs text-muted-foreground">{t(`meta.${k}`)}</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{data.meta[k]}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

(Verify the imports resolve: `useAuth` must expose `accountId` + `defaultCurrency` — grep `use-auth`; `formatCurrency` import path — grep the dashboard page. If `defaultCurrency` isn't on `useAuth`, use `data.purchase.currency` only. Adapt to the real signatures rather than assuming.)

- [ ] **Step 3: i18n** — in `messages/en.json`, add a `"Campaigns"` namespace:

```json
  "Campaigns": {
    "title": "Campaigns",
    "subtitle": "Funnel performance and Meta conversion reporting.",
    "newLeads": "New leads",
    "qualified": "Qualified",
    "purchases": "Purchases",
    "purchaseValue": "Purchase value",
    "reportedToMeta": "reported to Meta",
    "funnelTitle": "Funnel by stage",
    "metaTitle": "Meta delivery",
    "meta": { "sent": "Sent", "pending": "Pending", "unmatched": "Unmatched", "error": "Error", "abandoned": "Abandoned", "total": "Total" }
  }
```

- [ ] **Step 4: Verify + commit.** `npm run typecheck` PASS; `npm run lint <the new files>` no new findings; `npm run build` PASS.

```bash
git add "src/app/(dashboard)/campaigns/page.tsx" "src/app/(dashboard)/campaigns/loading.tsx" messages/en.json
git commit -m "feat(funnel): /campaigns funnel-analytics dashboard (Phase 4)"
```

---

### Task 4: Phase verification

- [ ] `npm test` → PASS (full suite; + campaigns + roles tests).
- [ ] `npm run typecheck` → PASS.
- [ ] `npm run build` → PASS (the `/campaigns` route registers).
- [ ] Confirm: no `convex dev/deploy/codegen`; `overview` is admin-gated + read-only; the nav item is hidden for < admin (`canAccessNav`); no deployed write path touched.

---

## Self-Review

**Spec coverage (design §11 analytics + §12 P4):**
- Per-stage funnel counts + purchase value + Meta match/delivery → Task 1 (`overview`). ✓
- Admin-gated dashboard section → Task 2 (nav) + Task 3 (page). ✓
- Additive/read-only (no write-path changes) → the whole plan reads `funnelTransitions`/`conversionEvents`; `setStage`/`seedNewLead`/dispatcher untouched. ✓
- Deferred (noted): sale-value on `funnelTransitions` + auto-`new_lead` display + per-campaign (adReferrals⋈campaignAds) drill-down — a richer v2; the v1 reports the account-wide funnel.

**Placeholder scan:** complete code in each step; the two "grep the real signature" notes (`MetricCard` props, `formatCurrency`/`useAuth` imports) are deliberate — match the real components rather than guess.

**Type consistency:** `overview() → { funnel, purchase, meta }` consumed by the page. `FUNNEL_STAGE_KEYS` (convex `lib/funnel.ts`) drives the query; `UI_FUNNEL_STAGE_KEYS` (`src/lib/inbox/funnel.ts`) drives the page's stage order + `Inbox.funnel.stage.*` labels (reused from Phase 3). `ADMIN_ONLY_NAV` + `canAccessNav` gate `/campaigns`.
