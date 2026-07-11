# Lead Value & Spend — Phase 2 Design

- **Date:** 2026-07-11
- **Branch:** `feat/lead-value-spend` (worktree, off `origin/main` = `712705a`, which contains RBAC Phase 1)
- **Status:** Approved design — pending implementation plan
- **Depends on:** RBAC Phase 1 (the `conversations.assign` self-claim choke point + roles)

---

## 1. Context

Phase 1 shipped the roles/access model, including the agent **self-claim** assignment flow (`conversations.assign`, `conversations.setAutoreplyPaused` with `assignToMe`). Phase 2 attaches a **cost** to taking a lead and **tracks per-agent spend** for commission / cost accounting.

Original intent: "the lead value must be set… if I assign 10 leads to myself, I pay 5 per lead… we calculate the total spent per agent." Reading: agents are **charged a configurable value when a lead becomes theirs**, recorded in a ledger, reported per agent.

## 2. Decisions (locked with the user)

| Axis | Decision |
|---|---|
| **Lead unit** | A WhatsApp **conversation** (charge tied to assignment) |
| **Value source** | **Flat account-wide rate** (one number, admin-configured) |
| **Value unit** | **Money** in the account's `defaultCurrency` |
| **Enforcement** | **Soft ledger** — record the charge; block nothing |
| **Charge trigger** | Whenever a conversation becomes **assigned to an agent** (self-claim OR supervisor/admin assigning it to them) |
| **Charged roles** | **Agents only** — supervisor/admin/owner assignees are never charged |
| **Idempotency** | **Once per `(agent, conversation)`** — release + re-claim never double-charges; a different agent taking it later pays their own charge |
| **Refunds** | **None** — a charge stands through release/reassignment |
| **Value snapshot** | The charge records the rate + currency **at charge time** (later rate changes don't rewrite history) |
| **Reporting** | Per-agent lead count + total spent, **period filter** (this month / all-time); admin/owner/**supervisor** see all agents, **agent** sees own only |
| **Rate config** | **Admin+**, in Settings › **Deals & currency** |
| **Backfill** | **None** — charging starts fresh once a rate is set; pre-existing assignments aren't retro-charged |

## 3. Architecture — append-only ledger

An append-only `leadCharges` table, one row per `(agent, conversation)` charge, with a money snapshot. Reports are aggregation queries over it.

*Rejected:* denormalized counters on `memberships` (can't do the period filter or audit trail the report requires); on-the-fly compute from current `conversations` (loses history — a lead reassigned A→B would erase A's charge, and rate changes would rewrite the past). Only a ledger satisfies once-per-agent-per-lead + no-refund + historical + per-period.

## 4. Data model (both additive — safe, no migration)

```ts
// convex/schema.ts

// The append-only spend ledger. One row = one agent charged once for one
// conversation. Never updated or deleted in normal operation.
leadCharges: defineTable({
  accountId: v.id("accounts"),
  userId: v.id("users"),            // the agent charged
  conversationId: v.id("conversations"),
  value: v.number(),                // money snapshot (account rate at charge time)
  currency: v.string(),             // currency snapshot
})
  .index("by_account", ["accountId"])
  .index("by_user_account", ["userId", "accountId"])
  .index("by_user_conversation", ["userId", "conversationId"]), // idempotency lookup

// accounts: add
leadValue: v.optional(v.number()),  // flat per-lead charge; unset/0 = feature OFF
```

Charge timestamp = the row's implicit `_creationTime` (period filtering ranges over it; no separate field, per the codebase's "rely on _creationTime" convention).

## 5. Charging logic

Shared internal helper in `convex/lib/leadCharge.ts` (pure-ish; takes a mutation ctx):

```
async function chargeLeadIfAgent(ctx, accountId, targetUserId, conversationId):
  account = ctx.db.get(accountId)
  if !account?.leadValue or account.leadValue <= 0: return          // feature off
  membership = memberships by (targetUserId, accountId)
  if membership?.role !== "agent": return                          // agents only
  existing = leadCharges by_user_conversation (targetUserId, conversationId).first()
  if existing: return                                              // idempotent
  ctx.db.insert("leadCharges", {
    accountId, userId: targetUserId, conversationId,
    value: account.leadValue, currency: account.defaultCurrency,
  })
```

Called from the **two** mutation paths in `convex/conversations.ts` that set `assignedToUserId` to a user (after the patch):
- `assign` → `chargeLeadIfAgent(ctx, ctx.accountId, args.userId, args.conversationId)` (covers self-claim AND supervisor-assigns-to-agent).
- `setAutoreplyPaused` when `args.assignToMe` → `chargeLeadIfAgent(ctx, ctx.accountId, ctx.userId, args.conversationId)`.

Release/unassign paths write nothing.

## 6. Reporting

`convex/leadCharges.ts`:
- `report` (accountQuery, args `{ from?: number, to?: number }`) → `Array<{ userId, name, leadCount, totalSpent, currency }>`.
  - Range over `by_account` (JS-filter `_creationTime` to `[from, to]` if given), group by `userId`, sum `value`, count rows; join `memberships` for `name`.
  - **Role scope:** if `hasMinRole(ctx.role, "supervisor")` → all agents; else (`agent`) → only `ctx.userId`'s own row (viewer → empty; viewers can't be assigned/charged anyway).
- `myTotal` (optional convenience) or fold into `report` — keep one query, filter by role.

## 7. Settings & UI

- `convex/accounts.ts`: new `setLeadValue` mutation (**admin+**, mirroring `setDefaultCurrency`'s inline `getAuthUserId` + membership + `hasMinRole(role,"admin")` guard; validate `value >= 0`). Patches `accounts.leadValue`.
- `src/components/settings/deals-settings.tsx`: add a **"Lead value"** number input beside the currency, wired to `setLeadValue`; the field is enabled only for admin+ (`canEditCriticalSettings`), with a hint ("Charged to an agent each time a lead is assigned to them; 0 disables").
- **Spend report UI:** a role-aware **"Lead spend" card on the Dashboard** (`src/app/(dashboard)/dashboard/…`) with a period toggle (This month / All time). Admin/supervisor: a small table (agent · leads · spent). Agent: their own "You've spent X on N leads." Uses `api.leadCharges.report`. Hidden entirely when `leadValue` is unset (feature off).

## 8. Rollout & testing

- Additive schema (new table + optional field) → deploy Convex, then frontend. **No backfill.** Feature is dark until an admin sets a lead value.
- **Tests (TDD, convex-test):** charge written on self-claim; charge on supervisor-assign-to-agent; NO charge when target is supervisor/admin/owner; NO charge when `leadValue` unset/0; idempotent (release+re-claim = 1 row); reassign A→B = 2 rows (one each); value/currency snapshot survives a later `setLeadValue` change; `report` aggregation (count + sum) + period filter + role-scoping (agent sees only own); `setLeadValue` admin-gated (supervisor → FORBIDDEN).

## 9. Assumptions (confirmed)

1. **No backfill** — only assignments after a rate is set are charged.
2. **Report is a Dashboard card**, not a new nav section.

## 10. Out of scope (future)

Hard wallet/budget enforcement (balances, top-ups, blocking on insufficient funds); per-category/variable lead values; commission calculation on top of spend; CSV export of the ledger.
