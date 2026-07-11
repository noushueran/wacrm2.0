# Roles & Access Control — Phase 1 Design

- **Date:** 2026-07-11
- **Branch:** `feat/roles-access-control` (worktree, off `origin/main`)
- **Status:** Approved design — pending implementation plan
- **Author:** brainstormed with the user (Noushad)

---

## 1. Context & problem

Holidayys WA CRM ships a WhatsApp inbox where teammates share a single account.
Today authorization is a **single linear rank** — `owner(4) > admin(3) > agent(2) > viewer(1)` — mirrored in [`convex/lib/roles.ts`](../../../convex/lib/roles.ts) and [`src/lib/auth/roles.ts`](../../../src/lib/auth/roles.ts), with capability predicates (`canEditSettings`, `canSendMessages`, …) as the single source of truth. The Convex auth spine ([`convex/lib/auth.ts`](../../../convex/lib/auth.ts)) injects `ctx.role` + `ctx.requireRole(min)` into every query/mutation.

Two gaps the business needs closed:

1. **Chat visibility is wide open.** `conversations.list` returns *every* conversation in the account with no per-user filter, so agents and viewers currently see everyone's chats. The business wants front-line staff scoped to their own work + a shared lead pool.
2. **There is no Supervisor tier and no PII protection.** The team needs an oversight role that can see all chats but cannot touch critical settings, and front-line staff must not be able to read/export customer phone numbers (anti-poaching).

This is **Phase 1** of a two-phase effort. **Phase 2 (Lead Value & Spend)** — every lead has a value, claiming charges that value, per-agent spend tracking — is deferred and rides on top of Phase 1's assignment model. This document covers Phase 1 only.

## 2. Goals

- Add a new **Supervisor** role.
- Re-map role capabilities into the matrix in §4.
- Enforce **per-role chat visibility** server-side.
- **Mask contact phone numbers** for front-line roles, enforced server-side.
- Implement the **agent self-claim** assignment model (foundation for Phase 2 charging).
- Keep the codebase's centralized-predicate pattern; server and client role logic stay mirrored.

## 3. Non-goals (this phase)

- Lead value, per-lead cost, wallets/credits, or spend reporting (**Phase 2**).
- Any change to how inbound WhatsApp messages are ingested or how the AI auto-reply works.
- Reworking `owner` semantics or ownership transfer.
- A separate "Available leads" screen — the pool lives in the existing inbox for agents.

## 4. Decisions (locked with the user)

### 4.1 Role model & architecture

Keep the linear rank for the genuinely-hierarchical **management/settings axis**, insert `supervisor`, and add **explicit policy predicates** for the two non-linear axes (chat visibility, phone masking).

New ranks: `owner(5) > admin(4) > supervisor(3) > agent(2) > viewer(1)`.

Renumbering is safe: the rank is computed in JS (`roleRank` switch), never stored in the DB, and the old Postgres `is_account_member` CASE it once mirrored is gone (Convex migration complete). Every existing `hasMinRole(role, 'admin')` / `hasMinRole(role, 'agent')` call keeps its intended meaning after renumbering (see §6.2).

*Rejected alternatives:* a full capability-matrix rewrite (too invasive — touches every `requireRole` call site); inline `role === 'agent'` checks scattered across handlers (violates the centralized-predicate principle this codebase is built on).

### 4.2 Permission matrix

| Capability | Owner | Admin | **Supervisor** | Agent | Viewer |
|---|:--:|:--:|:--:|:--:|:--:|
| **View chats** | all | all | all | own + unassigned pool | unassigned only |
| Reply / send message | ✓ | ✓ | ✓ | ✓ (own) | ✗ (read-only) |
| Claim unassigned lead → self | ✓ | ✓ | ✓ | ✓ | ✗ |
| Assign / reassign to **others** | ✓ | ✓ | ✓ | ✗ (self only) | ✗ |
| Release own chat → pool | ✓ | ✓ | ✓ | ✓ | ✗ |
| **See contact phone number** | ✓ | ✓ | ✓ | only on chats **assigned to them** | ✗ (never) |
| Operational settings¹ | ✓ | ✓ | ✓ | ✗ | ✗ |
| Critical settings² | ✓ | ✓ | **✗** | ✗ | ✗ |
| Manage team members | ✓ | ✓ | ✗ | ✗ | ✗ |
| Delete account / transfer ownership | ✓ | ✗ | ✗ | ✗ | ✗ |
| **App nav sections** | all | all | all | Inbox + Notifications | Inbox |

¹ **Operational settings** = Templates · Quick replies · Fields & tags (incl. custom fields) · Deals & currency.
² **Critical settings** = WhatsApp connection · API keys.

Everyone (incl. agent/viewer) keeps their **personal** Profile (own name/password) and Appearance (theme) — assumption confirmed in §11.

### 4.3 Chat visibility scopes

`conversationScope(role)`:

- `all` → owner, admin, supervisor
- `own_and_pool` → agent — conversations where `assignedToUserId === callerUserId` **OR** `assignedToUserId` is unset
- `unassigned` → viewer — conversations where `assignedToUserId` is unset

### 4.4 Phone masking

Show the real number iff **caller is owner/admin/supervisor**, or **caller is the agent the conversation is assigned to**. Otherwise mask.

- **Style:** partial, last-2-digits — e.g. `••••••••34`. Country code hidden.
- **Enforcement:** server-side. The Convex query strips the number *before it leaves the server* (masked `phone` string; `phoneNormalized` nulled). CSS/JS hiding is not acceptable — it leaks via the network tab.
- Viewer: always masked. Agent: masked on the pool, real on their own claimed chats.

### 4.5 Claim / assign / reassign model

- **Agent** may claim an **unassigned** conversation to **themselves only** (`assign` where `userId === self` and the conversation is currently unassigned). May **release** their own conversation back to the pool (`unassign`). May **not** assign to anyone else, nor touch another agent's conversation.
- **Supervisor / Admin / Owner** may assign/reassign any conversation to any member, and release any conversation.
- **Viewer** may not assign, claim, or release.

### 4.6 Section / nav access

- **Main sidebar** ([`sidebar.tsx`](../../../src/components/layout/sidebar.tsx)): owner/admin/supervisor → all items. Agent → Inbox + Notifications only. Viewer → Inbox only. (Broadcasts, Automations, Flows, AI Agents, Contacts, Pipelines, Dashboard are hidden for agent/viewer.)
- **Settings rail** ([`settings-sections.ts`](../../../src/components/settings/settings-sections.ts)): owner/admin → all. Supervisor → Overview, Profile, Appearance, Templates, Quick replies, Fields & tags, Deals & currency (WhatsApp, API keys, Members hidden). Agent/Viewer → Profile + Appearance only.
- **Settings entry point:** the main-sidebar "Settings" link (`bottomNavItems`) is hidden for agent/viewer — consistent with "no settings access." They still reach their personal **Profile** (own name/password) and **Appearance** (theme) via the header avatar dropdown ([`header.tsx`](../../../src/components/layout/header.tsx)), which lands on `/settings?tab=profile`; the rail there exposes only those two personal sections for them. Supervisor keeps the sidebar Settings link (they have workspace settings).
- **Enforcement is server-side** (Convex queries reject with `FORBIDDEN`); nav hiding + a client route guard are UX. A member deep-linking to a forbidden route/section is redirected to their allowed home (agent/viewer default landing = `/inbox`; a forbidden settings section → `/settings?tab=profile`).

## 5. Data model changes

- [`convex/schema.ts`](../../../convex/schema.ts): add `v.literal("supervisor")` to the `memberships.role` union. **Additive — no backfill.** Existing rows keep their current role.
- **Indexing for visibility:** `conversations.list` will apply the scope as a `.filter` on the existing `by_account_last_message` ordered query — the same pattern the current `status` filter already uses (`convex/conversations.ts:84`). If profiling later shows the agent/viewer filtered scan is too heavy, add a composite index `by_account_assignee_last_message` on `["accountId", "assignedToUserId", "lastMessageAt"]`; noted as a follow-up, not required for correctness.

## 6. Server changes (the real enforcement)

### 6.1 New/updated role policy — `convex/lib/roles.ts` (+ mirror in `src/lib/auth/roles.ts`)

- Add `"supervisor"` to `AccountRole`, `ACCOUNT_ROLES`, and `roleRank` (renumber to §4.1).
- `conversationScope(role)` → `'all' | 'own_and_pool' | 'unassigned'`.
- `canSeeContactPhone(role, isAssignedToCaller: boolean)` → boolean.
- `canAssignToOthers(role)` = `hasMinRole(role, 'supervisor')`.
- `canEditCriticalSettings(role)` = `hasMinRole(role, 'admin')`.
- `canEditOperationalSettings(role)` = `hasMinRole(role, 'supervisor')`.
- `canManageMembers` stays `admin+`; `canSendMessages` stays `agent+` (now also true for supervisor, still false for viewer).

### 6.2 Effect of renumber on existing guards (verify, don't break)

- `hasMinRole(role, 'admin')` → still "admin or owner" (rank ≥ 4); supervisor(3) correctly excluded. Used by member management, critical settings.
- `hasMinRole(role, 'agent')` → agent, supervisor, admin, owner (rank ≥ 2); viewer excluded. Used by `canSendMessages` and the current `assign`/`unassign`/`setStatus` guards — semantics preserved.
- `canEditSettings` (old, admin+) is **split**; every current caller is re-pointed to `canEditCriticalSettings` (WhatsApp, API keys, members) or `canEditOperationalSettings` (templates, quick replies, tags, custom fields, deals). Audit each call site.

### 6.3 Central conversation-access helper — `convex/conversations.ts`

Replace the account-only `requireOwnConversation` with `requireConversationAccess(ctx, conversationId, mode)`:

- `mode: 'read'` — owner/admin/supervisor: any in-account; agent: assigned-to-self **or** unassigned; viewer: unassigned only. Else `NOT_FOUND` (same "doesn't exist / not yours" collapse the codebase already uses).
- `mode: 'write'` — owner/admin/supervisor: any; agent: assigned-to-self only; viewer: none.

Apply the scope + helper to: `list` (scope filter), `get` (read), `getByContact` (read), `unreadTotal` (scope filter), and the write mutations `assign`, `unassign`, `setStatus`, `markRead`, `toggleAiAutoreply`. `messages.listByConversation` (read) and `messages.send` (write) call the same helper.

### 6.4 Phone masking — `convex/conversations.ts`

In `embedContact`, compute `canSee = canSeeContactPhone(ctx.role, conversation.assignedToUserId === ctx.userId)` and pass the contact through a shared `maskContactPhone(contact, canSee)` helper: when `!canSee`, replace `phone` with the last-2 mask and drop `phoneNormalized`. The inbox list's name-fallback (`contact.name || contact.phone`) then shows the masked string for unnamed contacts — acceptable.

### 6.5 Assignment mutations — `convex/conversations.ts`

- `assign`: keep `requireRole('agent')`; add — if `!canAssignToOthers(ctx.role)` then require `args.userId === ctx.userId` **and** the conversation currently unassigned (`FORBIDDEN` otherwise).
- `unassign`: keep `requireRole('agent')`; add — if `!canAssignToOthers(ctx.role)` then require the conversation is assigned to the caller.

### 6.6 Members & invitations

- [`members.ts`](../../../convex/members.ts) `setRole`: allow `"supervisor"` as a target role (still `requireRole('admin')`; owner still special-cased).
- `invitations.create`: allow `"supervisor"` in the role validator (still admin+).

### 6.7 Settings mutations

Audit each settings vertical and set its write guard: **critical** (`whatsappConfig`, `apiKeys`) → `requireRole('admin')`; **operational** (`templates`, `quickReplies`, `tags`, `customFields`, `deals`/currency) → `requireRole('supervisor')`.

## 7. Client changes (UX gating — security is §6)

- [`src/lib/auth/roles.ts`](../../../src/lib/auth/roles.ts): mirror §6.1; add a section-access map (`canAccessNav(role, href)`, `canAccessSettingsSection(role, section)`).
- `useCan` hook + `RequireRole` component: extend for `edit-critical-settings` / `edit-operational-settings`; add a `RequireSection` route guard + per-role default landing.
- [`sidebar.tsx`](../../../src/components/layout/sidebar.tsx): filter `navItems` by `canAccessNav(role, …)`.
- [`settings-sections.ts`](../../../src/components/settings/settings-sections.ts) / `settings-rail.tsx`: hide sections per role; re-point each panel's gate to the critical/operational split (e.g. `FieldsAndTagsPanel`'s custom-fields card, `whatsapp-config`, `api-keys-settings`, `template-manager`, `deals-settings`).
- Members UI: add `"supervisor"` to `EDITABLE_ROLES` ([`members-tab.tsx`](../../../src/components/settings/members-tab.tsx)) and the invite dialog; add a `supervisor` entry to [`role-meta.ts`](../../../src/components/settings/role-meta.ts) (icon/label/variant/className) and the sidebar `ROLE_CHIP`.
- Phone display components render whatever `phone` the server returns, so masking is mostly automatic; the copy-phone buttons in `contact-sidebar`, `contact-detail-view`, `message-thread` copy the masked string when masked (a no-op for the number) — acceptable.

## 8. Internationalization

Add a `supervisor` role label under `Settings.roles` and any new strings (masked-number placeholder, "no access" redirect copy) across all locale files in `messages/`. Follow the existing i18n key structure.

## 9. Testing strategy (TDD)

Write tests first (vitest + convex-test). At minimum:

- **Role predicates** (`convex/lib/roles.test.ts`): renumbered ranks; `conversationScope`; `canSeeContactPhone`; `canEditCritical/Operational`; `canAssignToOthers`.
- **Conversation visibility**: admin/supervisor see all; agent sees own + unassigned (not other agents'); viewer sees unassigned only; `get`/`messages` reject out-of-scope reads.
- **Phone masking**: agent sees real number on own chat, masked on pool; viewer masked everywhere; supervisor/admin unmasked; `phoneNormalized` stripped when masked.
- **Claim model**: agent self-claim on unassigned ✓; agent assigning to another user ✗; agent grabbing another agent's chat ✗; supervisor reassign ✓; agent release own ✓; viewer assign ✗.
- **Members**: `setRole` to supervisor by admin ✓, by supervisor ✗.
- **Settings guards**: supervisor edits templates ✓ / WhatsApp ✗; agent edits anything ✗.

## 10. Rollout & migration

- Additive schema → deploy Convex functions + schema first, then the frontend (Netlify).
- No data backfill required.
- **Behavioral change to announce:** existing `agent` members lose "see all chats" (now own + pool); existing `viewer` members lose "see all" (now unassigned only). Existing phone visibility narrows for agents/viewers. Owner/admin unaffected. This is intended but real for the live team.

## 11. Assumptions (confirmed with user)

1. **"Category" = "Role."** The "category" the user referenced when creating a member is the role field, not a separate concept.
2. **Agents/Viewers keep personal Profile + Appearance only** — not a total Settings blackout (they can still change their own password/theme). Everything account-level is hidden + server-blocked.

## 12. Phase 2 hooks (deferred — do not build now)

The self-claim mutation (`assign` where `userId === self`) is the single choke point Phase 2 will charge against. Keep that path clean and well-tested so Phase 2 can attach a per-lead cost and a per-agent spend ledger without re-plumbing assignment.
