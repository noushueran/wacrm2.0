# Lead Value & Spend — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Charge an agent a configurable flat value each time a lead (conversation) becomes theirs, record it in an append-only ledger, and report per-agent spend.

**Architecture:** Append-only `leadCharges` ledger (one row per `(agent, conversation)`), written from the two `conversations` mutations that assign a conversation to a user; aggregation query for reporting; `accounts.leadValue` flat rate set by admin.

**Tech Stack:** Convex + `@convex-dev/auth`, Next.js (breaking-changes fork — read `node_modules/next/dist/docs/` before routing code), TypeScript, `vitest` + `convex-test`, `next-intl`.

## Global Constraints

- **Money in `accounts.defaultCurrency`.** The charge snapshots `value` + `currency` at charge time.
- **Agents only** are charged; **once per `(agent, conversation)`**; **no refunds**; feature is **off** when `accounts.leadValue` is unset or `<= 0`.
- Tenant-scoped Convex fns use `accountQuery`/`accountMutation` (ctx carries `role`/`userId`/`accountId`/`requireRole`), except identity-inline mutations that mirror `accounts.setDefaultCurrency` (`getAuthUserId` + `memberships.by_user` + `hasMinRole`).
- Convex tests: `convex/**/*.test.ts`, `import.meta.glob("/convex/**/*.ts")` (absolute), `convexTest(schema, modules)`, seed via `t.run`, auth via `t.withIdentity({subject:\`${userId}|s\`})`. Assert errors with `.rejects.toMatchObject({data:{code,...}})`.
- ConvexError shape: `{code:"FORBIDDEN", min}` / `{code:"INVALID_INPUT", message}` / `{code:"UNAUTHENTICATED"|"NO_ACCOUNT"}`.
- Test command: `npm test` (= `vitest run`); single file `npx vitest run <path>`.
- Commit after every task. Branch: `feat/lead-value-spend` (worktree off `origin/main` = `712705a`, which has RBAC Phase 1).
- Do NOT build the out-of-scope items (wallet/budget enforcement, per-category values, commission calc, CSV export).

---

## File Structure

**Created:** `convex/lib/leadCharge.ts` (charge helper) · `convex/leadCharges.ts` (report query) · `convex/leadCharges.test.ts` · `src/components/dashboard/lead-spend-card.tsx`.
**Modified:** `convex/schema.ts` · `convex/accounts.ts` (+ `me` exposes leadValue, new `setLeadValue`) · `convex/conversations.ts` (charge calls) · `src/hooks/use-auth.tsx` (+ `leadValue`) · `src/components/settings/deals-settings.tsx` (lead-value input) · `src/app/(dashboard)/dashboard/page.tsx` (card) · `messages/en.json`.

---

## Task 1: Schema + `accounts.leadValue` config

**Files:** Modify `convex/schema.ts`, `convex/accounts.ts`. Test `convex/accounts.test.ts`.

**Interfaces produced:** `leadCharges` table; `accounts.leadValue?: number`; `accounts.setLeadValue({value}) ` (admin+); `accounts.me` returns `account.leadValue`.

- [ ] **Step 1: Failing tests** — add to `convex/accounts.test.ts` (uses `insertUser` + `bootstrapAccount` + `insertTeammate`; follow the file's existing pattern):

```ts
test("setLeadValue: admin sets the account lead value", async () => {
  const t = convexTest(schema, modules);
  const adminId = await insertUser(t, { name: "Ad", email: "ad@x.com" });
  const asAdmin = t.withIdentity({ subject: `${adminId}|s` });
  await asAdmin.mutation(api.accounts.bootstrapAccount, {}); // creates account + owner membership
  // bootstrap makes them owner; owner is admin+ so setLeadValue is allowed
  const accountId = await asAdmin.mutation(api.accounts.setLeadValue, { value: 5 });
  const acct = await t.run((ctx) => ctx.db.get(accountId));
  expect(acct?.leadValue).toBe(5);
});

test("setLeadValue: rejects a value below zero", async () => {
  const t = convexTest(schema, modules);
  const adminId = await insertUser(t, { name: "Ad", email: "ad@x.com" });
  const asAdmin = t.withIdentity({ subject: `${adminId}|s` });
  await asAdmin.mutation(api.accounts.bootstrapAccount, {});
  await expect(
    asAdmin.mutation(api.accounts.setLeadValue, { value: -1 }),
  ).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
});

test("setLeadValue: FORBIDDEN below admin", async () => {
  const t = convexTest(schema, modules);
  const ownerId = await insertUser(t, { name: "O", email: "o@x.com" });
  const asOwner = t.withIdentity({ subject: `${ownerId}|s` });
  await asOwner.mutation(api.accounts.bootstrapAccount, {});
  const { userId: supId } = await insertTeammate(t, {
    accountId: (await t.run((ctx) => ctx.db.query("accounts").first()))!._id,
    name: "Su", email: "su@x.com", role: "supervisor",
  });
  const asSup = t.withIdentity({ subject: `${supId}|s` });
  await expect(
    asSup.mutation(api.accounts.setLeadValue, { value: 5 }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});
```

Run `npx vitest run convex/accounts.test.ts -t setLeadValue` → FAIL (mutation undefined).

- [ ] **Step 2: Schema** — in `convex/schema.ts` add `leadValue` to `accounts` and a new `leadCharges` table:

```ts
  accounts: defineTable({
    name: v.string(),
    defaultCurrency: v.string(), // ISO-4217, default "USD"
    ownerUserId: v.id("users"),
    leadValue: v.optional(v.number()), // flat per-lead charge; unset/<=0 = feature OFF
  }).index("by_owner", ["ownerUserId"]),

  // Append-only spend ledger — one row = one agent charged once for one
  // conversation. Never updated/deleted in normal operation. `value`/
  // `currency` are snapshots of the account rate at charge time so later
  // rate changes don't rewrite history. `by_user_conversation` backs the
  // once-per-(agent,conversation) idempotency check.
  leadCharges: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    value: v.number(),
    currency: v.string(),
  })
    .index("by_account", ["accountId"])
    .index("by_user_account", ["userId", "accountId"])
    .index("by_user_conversation", ["userId", "conversationId"]),
```

- [ ] **Step 3: `setLeadValue`** — append to `convex/accounts.ts` (mirrors `setDefaultCurrency`; admin+):

```ts
/**
 * Sets the account-wide flat lead value (Phase 2). Admin+ only — a
 * stricter floor than setDefaultCurrency's supervisor+, per the Phase 2
 * decision that only admins configure money charged to agents. Same
 * inline identity derivation as setDefaultCurrency. `value` is the
 * per-lead charge in the account's defaultCurrency; 0 disables charging.
 */
export const setLeadValue = mutation({
  args: { value: v.number() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!membership) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(membership.role, "admin")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "admin" });
    }
    if (!Number.isFinite(args.value) || args.value < 0) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "lead value must be a number >= 0",
      });
    }
    await ctx.db.patch(membership.accountId, { leadValue: args.value });
    return membership.accountId;
  },
});
```

- [ ] **Step 4: Expose `leadValue` in `accounts.me`** — read the current `me` query in `convex/accounts.ts`; in the object it returns for `account`, add `leadValue: account.leadValue ?? 0` (mirror how `defaultCurrency` is returned). This is what the settings prefill + dashboard card read.

- [ ] **Step 5: Run** `npx vitest run convex/accounts.test.ts` → PASS. Commit:
```bash
git add convex/schema.ts convex/accounts.ts convex/accounts.test.ts
git commit -m "feat(lead-value): leadCharges schema + accounts.leadValue + setLeadValue (admin+)"
```

---

## Task 2: Charge helper + wire into assignment

**Files:** Create `convex/lib/leadCharge.ts`. Modify `convex/conversations.ts`. Test `convex/leadCharges.test.ts` (new).

**Interfaces:** Consumes `accounts.leadValue`, `memberships.role`, `leadCharges`. Produces `chargeLeadIfAgent(ctx, accountId, targetUserId, conversationId)`.

- [ ] **Step 1: Create `convex/lib/leadCharge.ts`:**

```ts
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Records a lead charge iff: the feature is on (account.leadValue > 0),
 * the target is an `agent`, and there is no existing charge for this
 * (agent, conversation) pair. Idempotent — releasing + re-claiming your
 * own lead never double-charges; a different agent taking it later pays
 * their own charge. Snapshots value + currency at charge time. No-op
 * otherwise. Call AFTER the assignment patch lands.
 */
export async function chargeLeadIfAgent(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  targetUserId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<void> {
  const account = await ctx.db.get(accountId);
  const leadValue = account?.leadValue ?? 0;
  if (leadValue <= 0) return; // feature off

  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user_account", (q) =>
      q.eq("userId", targetUserId).eq("accountId", accountId),
    )
    .first();
  if (membership?.role !== "agent") return; // agents only

  const existing = await ctx.db
    .query("leadCharges")
    .withIndex("by_user_conversation", (q) =>
      q.eq("userId", targetUserId).eq("conversationId", conversationId),
    )
    .first();
  if (existing) return; // idempotent

  await ctx.db.insert("leadCharges", {
    accountId,
    userId: targetUserId,
    conversationId,
    value: leadValue,
    currency: account!.defaultCurrency,
  });
}
```

- [ ] **Step 2: Failing tests** — create `convex/leadCharges.test.ts`. Copy the four seed helpers (`seedAccountMember`, `seedUserInAccount`, `seedConv`, `seedAccountWithOwner`) + the header/`modules` block verbatim from `convex/conversations.test.ts` (lines 1–52, 130–204). Add a helper to set the rate directly:

```ts
async function setRate(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">, value: number) {
  await t.run((ctx) => ctx.db.patch(accountId, { leadValue: value }));
}
const rows = (t: ReturnType<typeof convexTest>) => t.run((ctx) => ctx.db.query("leadCharges").collect());
```

Then:

```ts
test("agent self-claim writes one charge with a snapshot", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  const all = await rows(t);
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ userId: a.userId, conversationId, value: 5, currency: "USD" });
});

test("supervisor assigning to an agent charges the agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const s = await seedUserInAccount(t, accountId, { name: "S", email: "s@x.com", role: "supervisor" });
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await s.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  const all = await rows(t);
  expect(all).toHaveLength(1);
  expect(all[0].userId).toBe(a.userId);
});

test("no charge when target is not an agent (supervisor self-assign)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const s = await seedUserInAccount(t, accountId, { name: "S", email: "s@x.com", role: "supervisor" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await s.asUser.mutation(api.conversations.assign, { conversationId, userId: s.userId });
  expect(await rows(t)).toHaveLength(0);
});

test("no charge when feature is off (leadValue unset)", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  expect(await rows(t)).toHaveLength(0);
});

test("idempotent: release + re-claim = one charge", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  await a.asUser.mutation(api.conversations.unassign, { conversationId });
  await a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  expect(await rows(t)).toHaveLength(1);
});

test("reassign A->B (by supervisor) = two independent charges", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const s = await seedUserInAccount(t, accountId, { name: "S", email: "s@x.com", role: "supervisor" });
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "B", email: "b@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "1", name: "L" });
  await s.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  await s.asUser.mutation(api.conversations.assign, { conversationId, userId: b.userId });
  const all = await rows(t);
  expect(all).toHaveLength(2);
  expect(all.map((r) => r.userId).sort()).toEqual([a.userId, b.userId].sort());
});

test("value snapshot survives a later rate change", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const a = await seedUserInAccount(t, accountId, { name: "A", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "B", email: "b@x.com", role: "agent" });
  const c1 = await seedConv(t, accountId, { phone: "1", name: "L1" });
  await a.asUser.mutation(api.conversations.assign, { conversationId: c1.conversationId, userId: a.userId });
  await setRate(t, accountId, 9);
  const c2 = await seedConv(t, accountId, { phone: "2", name: "L2" });
  await b.asUser.mutation(api.conversations.assign, { conversationId: c2.conversationId, userId: b.userId });
  const all = await rows(t);
  expect(all.find((r) => r.userId === a.userId)?.value).toBe(5);
  expect(all.find((r) => r.userId === b.userId)?.value).toBe(9);
});
```

Run → FAIL (no charges written).

- [ ] **Step 3: Wire the charge** in `convex/conversations.ts`. Add import `import { chargeLeadIfAgent } from "./lib/leadCharge";`. In `assign`, right after the `ctx.db.patch(args.conversationId, {...})` (the `assignedToUserId` patch, ~line 425) and before the notification block, add:
```ts
    await chargeLeadIfAgent(ctx, ctx.accountId, args.userId, args.conversationId);
```
In `setAutoreplyPaused`, the `paused` branch assigns to self only when `assignToMe`. After that `ctx.db.patch(...)` in the `if (args.paused)` branch, add:
```ts
      if (args.assignToMe) {
        await chargeLeadIfAgent(ctx, ctx.accountId, ctx.userId, args.conversationId);
      }
```

- [ ] **Step 4: Run** `npx vitest run convex/leadCharges.test.ts` → PASS. Commit:
```bash
git add convex/lib/leadCharge.ts convex/conversations.ts convex/leadCharges.test.ts
git commit -m "feat(lead-value): charge agents on assignment (idempotent, agents-only, snapshot)"
```

---

## Task 3: Spend report query

**Files:** Create `convex/leadCharges.ts`. Test `convex/leadCharges.test.ts`.

**Interfaces:** `leadCharges.report({from?, to?})` → `{ enabled, currency, rows: Array<{userId, name, leadCount, totalSpent}> }`. Role-scoped: supervisor+ all agents; agent own only.

- [ ] **Step 1: Failing tests** — add to `convex/leadCharges.test.ts`:

```ts
test("report aggregates per agent; supervisor sees all, agent sees own", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  await setRate(t, accountId, 5);
  const s = await seedUserInAccount(t, accountId, { name: "Sup", email: "s@x.com", role: "supervisor" });
  const a = await seedUserInAccount(t, accountId, { name: "Alice", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "Bob", email: "b@x.com", role: "agent" });
  for (const p of ["1", "2", "3"]) {
    const { conversationId } = await seedConv(t, accountId, { phone: p, name: p });
    await a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  }
  const { conversationId } = await seedConv(t, accountId, { phone: "9", name: "9" });
  await b.asUser.mutation(api.conversations.assign, { conversationId, userId: b.userId });

  const asSupReport = await s.asUser.query(api.leadCharges.report, {});
  expect(asSupReport.enabled).toBe(true);
  const alice = asSupReport.rows.find((r) => r.userId === a.userId);
  expect(alice).toMatchObject({ name: "Alice", leadCount: 3, totalSpent: 15 });
  expect(asSupReport.rows.find((r) => r.userId === b.userId)).toMatchObject({ leadCount: 1, totalSpent: 5 });

  const asAgentReport = await a.asUser.query(api.leadCharges.report, {});
  expect(asAgentReport.rows).toHaveLength(1);
  expect(asAgentReport.rows[0]).toMatchObject({ userId: a.userId, leadCount: 3, totalSpent: 15 });
});

test("report enabled=false when feature is off", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const s = await seedUserInAccount(t, accountId, { name: "Sup", email: "s@x.com", role: "supervisor" });
  const r = await s.asUser.query(api.leadCharges.report, {});
  expect(r.enabled).toBe(false);
  expect(r.rows).toEqual([]);
});
```

Run → FAIL (query undefined).

- [ ] **Step 2: Create `convex/leadCharges.ts`:**

```ts
import { accountQuery } from "./lib/auth";
import { v } from "convex/values";
import { hasMinRole } from "./lib/roles";
import type { Id } from "./_generated/dataModel";

/**
 * Per-agent lead-spend rollup for the Dashboard "Lead spend" card.
 * supervisor+ see every agent; an agent sees only their own row.
 * `from`/`to` (ms) filter over the charge's `_creationTime`. `enabled`
 * is false when the account has no positive lead value (feature off) —
 * the card hides itself.
 */
export const report = accountQuery({
  args: { from: v.optional(v.number()), to: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(ctx.accountId);
    const leadValue = account?.leadValue ?? 0;
    const currency = account?.defaultCurrency ?? "USD";
    if (leadValue <= 0) return { enabled: false, currency, rows: [] as const };

    const seeAll = hasMinRole(ctx.role, "supervisor");

    let charges = await ctx.db
      .query("leadCharges")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();

    if (!seeAll) charges = charges.filter((c) => c.userId === ctx.userId);
    if (args.from !== undefined) charges = charges.filter((c) => c._creationTime >= args.from!);
    if (args.to !== undefined) charges = charges.filter((c) => c._creationTime <= args.to!);

    const byUser = new Map<Id<"users">, { leadCount: number; totalSpent: number }>();
    for (const c of charges) {
      const row = byUser.get(c.userId) ?? { leadCount: 0, totalSpent: 0 };
      row.leadCount += 1;
      row.totalSpent += c.value;
      byUser.set(c.userId, row);
    }

    const rows = await Promise.all(
      [...byUser.entries()].map(async ([userId, agg]) => {
        const m = await ctx.db
          .query("memberships")
          .withIndex("by_user_account", (q) =>
            q.eq("userId", userId).eq("accountId", ctx.accountId),
          )
          .first();
        return { userId, name: m?.fullName ?? "Unknown", ...agg };
      }),
    );
    rows.sort((a, b) => b.totalSpent - a.totalSpent);
    return { enabled: true, currency, rows };
  },
});
```

- [ ] **Step 3: Run** `npx vitest run convex/leadCharges.test.ts` → PASS. Commit:
```bash
git add convex/leadCharges.ts convex/leadCharges.test.ts
git commit -m "feat(lead-value): per-agent spend report query (role-scoped, period filter)"
```

---

## Task 4: Settings — lead value input

**Files:** Modify `src/hooks/use-auth.tsx`, `src/components/settings/deals-settings.tsx`, `messages/en.json`.

- [ ] **Step 1: Expose `leadValue` in `useAuth`.** Read `src/hooks/use-auth.tsx`: the `AccountSummary` object is built from `me.account`. Add `leadValue: me.account.leadValue ?? 0` to that mapping (mirror `default_currency`), add `leadValue: number` to the `AccountSummary` type, and expose `leadValue` from the hook (either on `account` or as a top-level `leadValue` — match how `defaultCurrency` is surfaced). Also add `leadValue: 0` to the outside-provider fallback if `defaultCurrency` has one there.

- [ ] **Step 2: Add the lead-value control** to `src/components/settings/deals-settings.tsx`. Import `useState`/`useEffect` are already there. Add `const setLeadValue = useMutation(api.accounts.setLeadValue);` and read `leadValue` from `useAuth()`. Add a second card block (below the currency card) — a number input + Save, gated exactly like the currency control (`disabled={!canEditSettings || profileLoading}`, Save shown only when `canEditSettings`). Prefill from `leadValue`; on save `await setLeadValue({ value })` then `refreshProfile()`; toast on success/fail. Copy the currency card's structure; use these i18n keys under `Settings.deals`: `leadValueTitle`, `leadValueDesc`, `leadValueLabel`, `leadValueHint`.

- [ ] **Step 3: i18n** — add to `messages/en.json` under `Settings.deals`:
```json
"leadValueTitle": "Lead value",
"leadValueDesc": "Amount charged to an agent each time a lead is assigned to them.",
"leadValueLabel": "Value per lead",
"leadValueHint": "Set to 0 to disable lead-spend tracking."
```

- [ ] **Step 4: Verify** `npx tsc --noEmit` clean; `npx eslint src/hooks/use-auth.tsx src/components/settings/deals-settings.tsx` clean. Commit:
```bash
git add src/hooks/use-auth.tsx src/components/settings/deals-settings.tsx messages/en.json
git commit -m "feat(lead-value): admin lead-value setting in Deals & currency"
```

---

## Task 5: Dashboard "Lead spend" card

**Files:** Create `src/components/dashboard/lead-spend-card.tsx`. Modify `src/app/(dashboard)/dashboard/page.tsx`, `messages/en.json`.

- [ ] **Step 1: Create `src/components/dashboard/lead-spend-card.tsx`** — a client component that:
  - reads `useQuery(api.leadCharges.report, accountId ? { from } : 'skip')` (import `useQuery` from `@/lib/convex/cached`), where `from` toggles between "this month" (`startOfLocalDay`/month start) and all-time (`undefined`);
  - a period toggle (This month / All time) via local `useState` (mirror the dashboard's existing range toggle pattern);
  - returns `null` when the report is loading OR `report.enabled === false` (feature off / no card);
  - **admin/supervisor** (`useAuth().canManageMembers` OR role ≥ supervisor — use `accountRole` + `hasMinRole`): render a small table (agent name · lead count · spent via `formatCurrency(totalSpent, report.currency)`);
  - **agent**: render a single figure — "You've spent {formatCurrency(sum, currency)} on {count} leads" from their own single row (`report.rows[0]`);
  - style using the same card shell as `metric-card.tsx` (`rounded-xl border border-border bg-card p-5`). Use i18n keys under `Dashboard.leadSpend`.

- [ ] **Step 2: Wire into the dashboard** — in `src/app/(dashboard)/dashboard/page.tsx`, import `LeadSpendCard` and render it once (e.g. below the metric-cards grid, above Quick actions): `<LeadSpendCard />`. It self-hides when the feature is off, so no conditional needed at the call site.

- [ ] **Step 3: i18n** — add to `messages/en.json` under `Dashboard`:
```json
"leadSpend": {
  "title": "Lead spend",
  "thisMonth": "This month",
  "allTime": "All time",
  "agent": "Agent",
  "leads": "Leads",
  "spent": "Spent",
  "yourSpend": "You've spent {amount} on {count} leads",
  "empty": "No lead spend yet"
}
```

- [ ] **Step 4: Verify** `npx tsc --noEmit` clean; `npx eslint` on the two files clean. Commit:
```bash
git add src/components/dashboard/lead-spend-card.tsx src/app/\(dashboard\)/dashboard/page.tsx messages/en.json
git commit -m "feat(lead-value): role-aware Lead spend card on the dashboard"
```

---

## Task 6: Full verification

- [ ] **Step 1:** `npm test` → all green (fix any straggler).
- [ ] **Step 2:** `npx tsc --noEmit` → clean.
- [ ] **Step 3:** `npm run lint` → 0 errors.
- [ ] **Step 4:** Live preview smoke via `preview_*`: as owner/admin, set a lead value in Settings › Deals & currency; confirm the Dashboard "Lead spend" card appears; claim a lead in the inbox and confirm the card increments. Screenshot as proof. (Per-role views — agent's own-only figure — need a seeded agent account; note as manual QA, automated coverage is in the Convex suites.)
- [ ] **Step 5:** Commit any straggler fixes.

## Plan self-review

- **Spec coverage:** ledger table (T1) · charge trigger both assign paths + agents-only + idempotent + snapshot (T2) · report role-scoped + period (T3) · admin rate config in Deals (T1 server, T4 UI) · dashboard card role-aware (T5) · additive/no-backfill (T1 schema, feature-off default). All §2 decisions mapped.
- **Type/name consistency:** `chargeLeadIfAgent(ctx, accountId, targetUserId, conversationId)`, `leadCharges` fields, `report` return `{enabled, currency, rows}` used identically across tasks.
- **Deferred (spec §10):** wallet enforcement, per-category values, commission, CSV — not built.
