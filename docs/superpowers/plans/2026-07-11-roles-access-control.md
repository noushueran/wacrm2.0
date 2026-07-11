# Roles & Access Control — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Supervisor role, enforce per-role chat visibility, mask contact phone numbers server-side, and implement the agent self-claim model.

**Architecture:** Keep the linear `roleRank` for the hierarchical management/settings axis (insert `supervisor` → `owner5 > admin4 > supervisor3 > agent2 > viewer1`) and add explicit, pure policy functions in `convex/lib/roles.ts` (mirrored in `src/lib/auth/roles.ts`) for the two non-linear axes — chat visibility and phone masking. All real enforcement is in Convex `accountQuery`/`accountMutation` handlers; client nav/rail hiding + a route guard are UX only.

**Tech Stack:** Next.js (breaking-changes fork — see Global Constraints), Convex + `@convex-dev/auth`, TypeScript, `vitest` + `convex-test`, `next-intl`.

## Global Constraints

- **Next.js is a breaking-changes fork.** Per `AGENTS.md`: read the relevant guide in `node_modules/next/dist/docs/` before writing any Next.js code (routing, middleware, redirects). Heed deprecation notices.
- **Role ranks (verbatim):** `owner=5, admin=4, supervisor=3, agent=2, viewer=1`. `convex/lib/roles.ts` and `src/lib/auth/roles.ts` MUST stay mirrored (same `AccountRole` union, same `roleRank`).
- **Tenant-scoped Convex functions use `accountQuery`/`accountMutation`** from `convex/lib/auth.ts` (never raw `query`/`mutation`). Their ctx carries `ctx.role`, `ctx.userId`, `ctx.accountId`, `ctx.requireRole(min)`.
- **Test placement decides runtime:** Convex-function tests go in `convex/**/*.test.ts` (edge-runtime); pure-logic/client tests in `src/**/*.test.ts(x)` (node). Convex tests MUST use `const modules = import.meta.glob("/convex/**/*.ts")` (absolute), `convexTest(schema, modules)`, seed via `t.run(ctx => ctx.db.insert(...))`, auth via `t.withIdentity({ subject: \`${userId}|session-x\` })`.
- **ConvexError shape:** `throw new ConvexError({ code: "FORBIDDEN", min })` / `{ code: "NOT_FOUND", entity }`. Assert with `.rejects.toMatchObject({ data: { code, ... } })` or catch + `instanceof ConvexError` + `.data` `toEqual`.
- **Phone mask style:** all digits except the last 2 become `•`; country code + formatting dropped; `phoneNormalized` is emptied. Enforced server-side.
- **Test command:** `npm test` (= `vitest run`). Single file: `npx vitest run <path>`. Filter: `npx vitest run -t "<name>"`.
- **Commit after every task** (frequent commits). The worktree branch is `feat/roles-access-control`.
- **Do not** implement Phase 2 (lead value / spend). Keep the self-claim `assign` path clean as its future hook.

---

## File Structure

**Created:**
- `convex/lib/conversationAccess.ts` — shared `requireConversationAccess(ctx, id, mode)` guard (used by `conversations.ts` + `messages.ts`).
- `src/components/auth/require-section.tsx` — client route guard for role-gated top-level sections.
- Test files as needed alongside the above.

**Modified — server (enforcement):**
- `convex/schema.ts` — add `"supervisor"` to `memberships.role` (+ `accountInvitations.role` if present).
- `convex/lib/roles.ts` (+ `convex/lib/roles.test.ts`) — supervisor, renumber, new policy predicates.
- `convex/lib/phone.ts` (+ `convex/lib/phone.test.ts`) — `maskPhone`.
- `convex/conversations.ts` (+ `convex/conversations.test.ts`) — visibility filter, masking, claim model.
- `convex/messages.ts` (+ `convex/messages.test.ts`) — view/own access on read/send.
- `convex/members.ts`, `convex/invitations.ts` (+ their tests) — allow supervisor.
- Settings verticals: `convex/tags.ts`, `convex/quickReplies.ts`, `convex/templates.ts`, `convex/customFields.ts`, `convex/pipelines.ts`, `convex/accounts.ts` — guard split (+ reconcile their tests).

**Modified — client (UX gating):**
- `src/lib/auth/roles.ts` (+ `src/lib/auth/roles.test.ts`) — mirror + section-access map.
- `src/hooks/use-auth.tsx`, `src/hooks/use-can.ts` — expose new capabilities.
- `src/components/settings/role-meta.ts`, `src/components/layout/sidebar.tsx` (`ROLE_CHIP` + nav), `src/components/layout/header.tsx`.
- `src/components/settings/settings-sections.ts`, `settings-rail.tsx`, `src/app/(dashboard)/settings/page.tsx`.
- `src/components/settings/members-tab.tsx`, `invite-member-dialog.tsx`.
- `src/components/inbox/message-composer.tsx` (+ thread) — "Claim to reply" for agents on pool chats.
- Operational-settings call sites re-pointed to `edit-operational-settings`.
- `messages/*.json` — supervisor role label/hint + masked/no-access strings.

---

## Task 1: Server role foundation (schema + roles policy)

**Files:**
- Modify: `convex/schema.ts` (`memberships.role` union; check `accountInvitations.role`)
- Modify: `convex/lib/roles.ts`
- Test: `convex/lib/roles.test.ts`

**Interfaces:**
- Produces: `AccountRole = "owner"|"admin"|"supervisor"|"agent"|"viewer"`; `roleRank`; `hasMinRole`; `conversationScope(role): "all"|"own_and_pool"|"unassigned"`; `canSeeContactPhone(role, isAssignedToCaller): boolean`; `canAssignToOthers(role): boolean`; `canAccessConversation(role, {isMine,isUnassigned}, mode): boolean`; `canEditOperationalSettings(role): boolean`; `canEditCriticalSettings(role): boolean`.

- [ ] **Step 1: Update the failing test** — replace `convex/lib/roles.test.ts` with:

```ts
import { test, expect } from "vitest";
import {
  hasMinRole,
  roleRank,
  conversationScope,
  canSeeContactPhone,
  canAssignToOthers,
  canAccessConversation,
  canEditOperationalSettings,
  canEditCriticalSettings,
} from "./roles";

test("role ladder with supervisor inserted between admin and agent", () => {
  expect(roleRank("owner")).toBe(5);
  expect(roleRank("admin")).toBe(4);
  expect(roleRank("supervisor")).toBe(3);
  expect(roleRank("agent")).toBe(2);
  expect(roleRank("viewer")).toBe(1);
  expect(hasMinRole("supervisor", "agent")).toBe(true);
  expect(hasMinRole("supervisor", "admin")).toBe(false);
  expect(hasMinRole("admin", "supervisor")).toBe(true);
  expect(hasMinRole("viewer", "admin")).toBe(false);
});

test("conversationScope maps roles to visibility", () => {
  expect(conversationScope("owner")).toBe("all");
  expect(conversationScope("admin")).toBe("all");
  expect(conversationScope("supervisor")).toBe("all");
  expect(conversationScope("agent")).toBe("own_and_pool");
  expect(conversationScope("viewer")).toBe("unassigned");
});

test("canSeeContactPhone: supervisor+ always; agent only when assigned; viewer never", () => {
  expect(canSeeContactPhone("owner", false)).toBe(true);
  expect(canSeeContactPhone("admin", false)).toBe(true);
  expect(canSeeContactPhone("supervisor", false)).toBe(true);
  expect(canSeeContactPhone("agent", true)).toBe(true);
  expect(canSeeContactPhone("agent", false)).toBe(false);
  expect(canSeeContactPhone("viewer", true)).toBe(false);
});

test("canAssignToOthers: supervisor+ only", () => {
  expect(canAssignToOthers("owner")).toBe(true);
  expect(canAssignToOthers("admin")).toBe(true);
  expect(canAssignToOthers("supervisor")).toBe(true);
  expect(canAssignToOthers("agent")).toBe(false);
  expect(canAssignToOthers("viewer")).toBe(false);
});

test("canAccessConversation view/own by role", () => {
  // supervisor+ : everything, both modes
  for (const role of ["owner", "admin", "supervisor"] as const) {
    expect(canAccessConversation(role, { isMine: false, isUnassigned: false }, "view")).toBe(true);
    expect(canAccessConversation(role, { isMine: false, isUnassigned: false }, "own")).toBe(true);
  }
  // agent view: own or unassigned; own: only own
  expect(canAccessConversation("agent", { isMine: true, isUnassigned: false }, "view")).toBe(true);
  expect(canAccessConversation("agent", { isMine: false, isUnassigned: true }, "view")).toBe(true);
  expect(canAccessConversation("agent", { isMine: false, isUnassigned: false }, "view")).toBe(false);
  expect(canAccessConversation("agent", { isMine: false, isUnassigned: true }, "own")).toBe(false);
  expect(canAccessConversation("agent", { isMine: true, isUnassigned: false }, "own")).toBe(true);
  // viewer view: unassigned only; own: never
  expect(canAccessConversation("viewer", { isMine: false, isUnassigned: true }, "view")).toBe(true);
  expect(canAccessConversation("viewer", { isMine: false, isUnassigned: false }, "view")).toBe(false);
  expect(canAccessConversation("viewer", { isMine: false, isUnassigned: true }, "own")).toBe(false);
});

test("settings split: operational supervisor+, critical admin+", () => {
  expect(canEditOperationalSettings("supervisor")).toBe(true);
  expect(canEditOperationalSettings("agent")).toBe(false);
  expect(canEditCriticalSettings("supervisor")).toBe(false);
  expect(canEditCriticalSettings("admin")).toBe(true);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run convex/lib/roles.test.ts`
Expected: FAIL (e.g. `roleRank("owner")` is 4 not 5; `conversationScope` is not exported).

- [ ] **Step 3: Rewrite `convex/lib/roles.ts`** (keep the existing header comment block; replace the body with):

```ts
export type AccountRole =
  | "owner"
  | "admin"
  | "supervisor"
  | "agent"
  | "viewer";

/** Numeric rank. Higher = more privileged. `supervisor` sits between
 *  admin and agent: it outranks agents on chat access but is below
 *  admin on settings/management. */
export function roleRank(role: AccountRole): number {
  switch (role) {
    case "owner":
      return 5;
    case "admin":
      return 4;
    case "supervisor":
      return 3;
    case "agent":
      return 2;
    case "viewer":
      return 1;
  }
}

export function hasMinRole(role: AccountRole, min: AccountRole): boolean {
  return roleRank(role) >= roleRank(min);
}

// ── Non-linear policy: chat visibility ──────────────────────────────
export type ConversationScope = "all" | "own_and_pool" | "unassigned";

/** Which conversations a role may see. `own_and_pool` = assigned to the
 *  caller OR unassigned (the claimable lead pool). */
export function conversationScope(role: AccountRole): ConversationScope {
  switch (role) {
    case "owner":
    case "admin":
    case "supervisor":
      return "all";
    case "agent":
      return "own_and_pool";
    case "viewer":
      return "unassigned";
  }
}

/** May the caller read a contact's real phone number for a
 *  conversation? admin/owner/supervisor always; an agent only on a
 *  conversation assigned to them; a viewer never. */
export function canSeeContactPhone(
  role: AccountRole,
  isAssignedToCaller: boolean,
): boolean {
  if (hasMinRole(role, "supervisor")) return true;
  if (role === "agent") return isAssignedToCaller;
  return false;
}

/** Only supervisor+ may assign a conversation to someone other than
 *  themselves. Agents self-claim only. */
export function canAssignToOthers(role: AccountRole): boolean {
  return hasMinRole(role, "supervisor");
}

/** Whether a role may reach one conversation. `view` = read/open;
 *  `own` = act on it (send/status/release). supervisor+ = all; agent
 *  view = own-or-unassigned, own = own-only; viewer view =
 *  unassigned-only, never own. */
export function canAccessConversation(
  role: AccountRole,
  where: { isMine: boolean; isUnassigned: boolean },
  mode: "view" | "own",
): boolean {
  if (hasMinRole(role, "supervisor")) return true;
  if (mode === "own") return role === "agent" && where.isMine;
  if (role === "agent") return where.isMine || where.isUnassigned;
  if (role === "viewer") return where.isUnassigned;
  return false;
}

// ── Settings split ──────────────────────────────────────────────────
/** Operational config: templates, quick replies, tags, custom fields,
 *  pipelines, deals & currency. */
export function canEditOperationalSettings(role: AccountRole): boolean {
  return hasMinRole(role, "supervisor");
}

/** Critical config: WhatsApp connection, API keys, AI provider keys. */
export function canEditCriticalSettings(role: AccountRole): boolean {
  return hasMinRole(role, "admin");
}
```

- [ ] **Step 4: Update `convex/schema.ts`** — add `v.literal("supervisor")` to `memberships.role`:

```ts
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("supervisor"),
      v.literal("agent"),
      v.literal("viewer"),
    ),
```

Then grep the file for `accountInvitations` — if its `role` field is a union of `admin|agent|viewer`, add `v.literal("supervisor")` there too (keep `"owner"` excluded). Run: `grep -n "accountInvitations" -A 12 convex/schema.ts` and edit the role union accordingly.

- [ ] **Step 5: Run tests, verify pass**

Run: `npx vitest run convex/lib/roles.test.ts`
Expected: PASS (6 tests).
Also run `npx convex codegen` is NOT needed here; the schema change is picked up by `convex-test` from `schema.ts` directly. If `npm run typecheck` is available, defer full typecheck to the task where the union is consumed.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/roles.ts convex/lib/roles.test.ts convex/schema.ts
git commit -m "feat(rbac): add supervisor role + non-linear access policies (server)"
```

---

## Task 2: Client role foundation (mirror + section-access map)

**Files:**
- Modify: `src/lib/auth/roles.ts`
- Test: `src/lib/auth/roles.test.ts`

**Interfaces:**
- Produces (mirrors Task 1) plus: keeps existing `canManageMembers`/`canEditSettings`/`canSendMessages`/`canViewOnly`/`canDeleteAccount`/`canTransferOwnership`; adds `canEditOperationalSettings`/`canEditCriticalSettings`/`conversationScope`/`canSeeContactPhone`/`canAssignToOthers`; adds `NavKey`/`SettingsSectionKey` types and `canAccessNav(role, key)` / `canAccessSettingsSection(role, key)` / `defaultLandingPath(role)`.
- `canEditSettings` is retained as an alias of `canEditCriticalSettings` (admin+) so unrelated existing critical call sites are unchanged.

- [ ] **Step 1: Update `src/lib/auth/roles.test.ts`** — update the numeric-rank assertions and add supervisor to the `it.each` matrix + new-predicate specs. Replace the `roleRank` "numeric mapping" test and the `hasMinRole` `it.each` block with:

```ts
  it("matches the account-role model's numeric mapping", () => {
    expect(roleRank("owner")).toBe(5);
    expect(roleRank("admin")).toBe(4);
    expect(roleRank("supervisor")).toBe(3);
    expect(roleRank("agent")).toBe(2);
    expect(roleRank("viewer")).toBe(1);
  });
```

And extend the `describe("capability predicates")` block with:

```ts
  it("canEditOperationalSettings: supervisor+", () => {
    expect(canEditOperationalSettings("owner")).toBe(true);
    expect(canEditOperationalSettings("admin")).toBe(true);
    expect(canEditOperationalSettings("supervisor")).toBe(true);
    expect(canEditOperationalSettings("agent")).toBe(false);
    expect(canEditOperationalSettings("viewer")).toBe(false);
  });

  it("canEditCriticalSettings: admin+ (supervisor excluded)", () => {
    expect(canEditCriticalSettings("admin")).toBe(true);
    expect(canEditCriticalSettings("supervisor")).toBe(false);
  });

  it("canAccessNav gates agent/viewer to inbox + notifications", () => {
    expect(canAccessNav("agent", "/inbox")).toBe(true);
    expect(canAccessNav("agent", "/notifications")).toBe(true);
    expect(canAccessNav("agent", "/contacts")).toBe(false);
    expect(canAccessNav("agent", "/settings")).toBe(false);
    expect(canAccessNav("viewer", "/inbox")).toBe(true);
    expect(canAccessNav("viewer", "/notifications")).toBe(false);
    expect(canAccessNav("supervisor", "/broadcasts")).toBe(true);
    expect(canAccessNav("supervisor", "/settings")).toBe(true);
  });

  it("canAccessSettingsSection: agent/viewer personal-only; supervisor no critical", () => {
    expect(canAccessSettingsSection("agent", "profile")).toBe(true);
    expect(canAccessSettingsSection("agent", "appearance")).toBe(true);
    expect(canAccessSettingsSection("agent", "templates")).toBe(false);
    expect(canAccessSettingsSection("supervisor", "templates")).toBe(true);
    expect(canAccessSettingsSection("supervisor", "whatsapp")).toBe(false);
    expect(canAccessSettingsSection("supervisor", "members")).toBe(false);
    expect(canAccessSettingsSection("admin", "whatsapp")).toBe(true);
  });

  it("defaultLandingPath: agent/viewer → /inbox, others → /dashboard", () => {
    expect(defaultLandingPath("agent")).toBe("/inbox");
    expect(defaultLandingPath("viewer")).toBe("/inbox");
    expect(defaultLandingPath("supervisor")).toBe("/dashboard");
    expect(defaultLandingPath("admin")).toBe("/dashboard");
  });
```

Add the new names to the import at the top of the test file:
`canEditOperationalSettings, canEditCriticalSettings, canAccessNav, canAccessSettingsSection, defaultLandingPath`.

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/lib/auth/roles.test.ts`
Expected: FAIL (rank is 4 not 5; new predicates undefined).

- [ ] **Step 3: Edit `src/lib/auth/roles.ts`** — update the union, `ACCOUNT_ROLES`, `roleRank`, and append the new predicates. Replace the type + `ACCOUNT_ROLES` + `roleRank`:

```ts
export type AccountRole =
  | "owner"
  | "admin"
  | "supervisor"
  | "agent"
  | "viewer";

/** Ordered list, lowest privilege first. */
export const ACCOUNT_ROLES: readonly AccountRole[] = [
  "viewer",
  "agent",
  "supervisor",
  "admin",
  "owner",
] as const;

export function roleRank(role: AccountRole): number {
  switch (role) {
    case "owner":
      return 5;
    case "admin":
      return 4;
    case "supervisor":
      return 3;
    case "agent":
      return 2;
    case "viewer":
      return 1;
  }
}
```

Keep `hasMinRole`, `isAccountRole`, `canManageMembers`, `canSendMessages`, `canViewOnly`, `canDeleteAccount`, `canTransferOwnership` as-is. Change `canEditSettings` to delegate, and append the rest:

```ts
/** @deprecated Prefer `canEditCriticalSettings` / `canEditOperationalSettings`.
 *  Retained (admin+) so existing critical-settings call sites are unchanged. */
export function canEditSettings(role: AccountRole): boolean {
  return canEditCriticalSettings(role);
}

export function canEditCriticalSettings(role: AccountRole): boolean {
  return hasMinRole(role, "admin");
}

export function canEditOperationalSettings(role: AccountRole): boolean {
  return hasMinRole(role, "supervisor");
}

export type ConversationScope = "all" | "own_and_pool" | "unassigned";
export function conversationScope(role: AccountRole): ConversationScope {
  switch (role) {
    case "owner":
    case "admin":
    case "supervisor":
      return "all";
    case "agent":
      return "own_and_pool";
    case "viewer":
      return "unassigned";
  }
}

export function canSeeContactPhone(
  role: AccountRole,
  isAssignedToCaller: boolean,
): boolean {
  if (hasMinRole(role, "supervisor")) return true;
  if (role === "agent") return isAssignedToCaller;
  return false;
}

export function canAssignToOthers(role: AccountRole): boolean {
  return hasMinRole(role, "supervisor");
}

// ── Section access (nav + settings rail) ────────────────────────────
/** Top-level nav hrefs. */
export const AGENT_NAV = ["/inbox", "/notifications"] as const;
export const VIEWER_NAV = ["/inbox"] as const;

export function canAccessNav(role: AccountRole, href: string): boolean {
  // Match the concrete href or a nested route under it.
  const base = "/" + (href.split("/")[1] ?? "");
  if (hasMinRole(role, "supervisor")) return true; // supervisor/admin/owner: all
  if (role === "agent") return (AGENT_NAV as readonly string[]).includes(base);
  if (role === "viewer") return (VIEWER_NAV as readonly string[]).includes(base);
  return false;
}

/** Settings section ids (mirror of settings-sections.ts). */
export type SettingsSectionKey =
  | "overview"
  | "profile"
  | "appearance"
  | "whatsapp"
  | "templates"
  | "quick-replies"
  | "fields"
  | "deals"
  | "members"
  | "api";

const PERSONAL_SECTIONS: SettingsSectionKey[] = ["overview", "profile", "appearance"];
const CRITICAL_SECTIONS: SettingsSectionKey[] = ["whatsapp", "api", "members"];

export function canAccessSettingsSection(
  role: AccountRole,
  section: SettingsSectionKey,
): boolean {
  if (PERSONAL_SECTIONS.includes(section)) return true; // everyone
  if (hasMinRole(role, "admin")) return true; // admin/owner: all
  if (role === "supervisor") return !CRITICAL_SECTIONS.includes(section);
  return false; // agent/viewer: personal only
}

export function defaultLandingPath(role: AccountRole): string {
  return hasMinRole(role, "supervisor") ? "/dashboard" : "/inbox";
}
```

Note: `members` is treated as a critical section here (supervisor excluded), matching the decision that supervisors don't manage the roster.

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run src/lib/auth/roles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/roles.ts src/lib/auth/roles.test.ts
git commit -m "feat(rbac): mirror supervisor role + section-access policy (client)"
```

---

## Task 3: Phone-mask helper

**Files:**
- Modify: `convex/lib/phone.ts`
- Test: `convex/lib/phone.test.ts`

**Interfaces:**
- Produces: `maskPhone(phone: string): string` — all digits but the last 2 become `•`.

- [ ] **Step 1: Add the failing test** to `convex/lib/phone.test.ts`:

```ts
import { maskPhone } from "./phone";

test("maskPhone keeps only the last two digits, bulleting the rest", () => {
  expect(maskPhone("12345")).toBe("•••45");
  expect(maskPhone("+1 (415) 555-0148")).toMatch(/^•+48$/);
  expect(maskPhone("+971 50 123 4534").endsWith("34")).toBe(true);
  expect(maskPhone("+971 50 123 4534").replace(/•/g, "")).toBe("34");
  expect(maskPhone("7")).toBe("••");
  expect(maskPhone("")).toBe("••");
});
```
(Reuse the file's existing `import { expect, test } from "vitest";` — do not duplicate it.)

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run convex/lib/phone.test.ts`
Expected: FAIL (`maskPhone` is not exported).

- [ ] **Step 3: Append to `convex/lib/phone.ts`:**

```ts
/** Mask all but the last two digits of a phone number, for callers not
 *  permitted to see it. Drops country code + formatting; keeps 2 digits
 *  so two leads stay distinguishable. Never returns the real number. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 2) return "••";
  return "•".repeat(digits.length - 2) + digits.slice(-2);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run convex/lib/phone.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/phone.ts convex/lib/phone.test.ts
git commit -m "feat(rbac): add maskPhone helper"
```

---

## Task 4: Conversation visibility + shared access guard

**Files:**
- Create: `convex/lib/conversationAccess.ts`
- Modify: `convex/conversations.ts` (`list`, `unreadTotal`, `get`, `getByContact`)
- Test: `convex/conversations.test.ts`

**Interfaces:**
- Consumes: `conversationScope`, `canAccessConversation` (Task 1).
- Produces: `requireConversationAccess(ctx, conversationId, mode): Promise<Doc<"conversations">>` where `ctx` has `{ db, accountId, role, userId }` and `mode: "view" | "own"`. Throws `NOT_FOUND {entity:"conversation"}` when the conversation is absent, cross-account, or out of the caller's scope.

- [ ] **Step 1: Create the shared guard** `convex/lib/conversationAccess.ts`:

```ts
import { ConvexError } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { canAccessConversation, type AccountRole } from "./roles";

/**
 * Loads a conversation and throws `NOT_FOUND` unless the caller's role
 * may reach it in `mode` (see `canAccessConversation`). Same error for
 * "doesn't exist", "another account's", and "out of your scope" — a
 * probe can't distinguish them (mirrors `contacts.ts`'s
 * `requireOwnContact`). Shared by `conversations.ts` and `messages.ts`.
 */
export async function requireConversationAccess(
  ctx: {
    db: QueryCtx["db"];
    accountId: Id<"accounts">;
    role: AccountRole;
    userId: Id<"users">;
  },
  conversationId: Id<"conversations">,
  mode: "view" | "own",
): Promise<Doc<"conversations">> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
  }
  const allowed = canAccessConversation(
    ctx.role,
    {
      isMine: conversation.assignedToUserId === ctx.userId,
      isUnassigned: conversation.assignedToUserId === undefined,
    },
    mode,
  );
  if (!allowed) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
  }
  return conversation;
}
```

- [ ] **Step 2: Add the failing tests** to `convex/conversations.test.ts`. First add these helpers near the top (after the existing imports/helpers — reuse the file's existing `modules`, `convexTest`, `schema`, `api`; add `conversationScope`-style multi-member seeding):

```ts
async function seedUserInAccount(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: { name: string; email: string; role: AccountRole },
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: opts.name, email: opts.email }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId,
      accountId,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    }),
  );
  return { userId, asUser: t.withIdentity({ subject: `${userId}|s-${opts.name}` }) };
}

async function seedConv(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  opts: { phone: string; name: string; assignedToUserId?: Id<"users"> },
) {
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: opts.phone,
      phoneNormalized: opts.phone.replace(/\D/g, ""),
      name: opts.name,
    }),
  );
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
      ...(opts.assignedToUserId
        ? { assignedToUserId: opts.assignedToUserId }
        : {}),
    }),
  );
  return { contactId, conversationId };
}

async function seedAccountWithOwner(t: ReturnType<typeof convexTest>) {
  const ownerId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Owner", email: "owner@x.com" }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "Acme",
      defaultCurrency: "USD",
      ownerUserId: ownerId,
    });
    await ctx.db.insert("memberships", { userId: ownerId, accountId: id, role: "owner" });
    return id;
  });
  return { ownerId, accountId };
}

const onePage = { paginationOpts: { numItems: 50, cursor: null } };
```

Add `import type { AccountRole } from "./lib/roles";` if not already imported. Then the tests:

```ts
test("list scopes conversations by role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const v = await seedUserInAccount(t, accountId, { name: "Vic", email: "v@x.com", role: "viewer" });
  const s = await seedUserInAccount(t, accountId, { name: "Sup", email: "s@x.com", role: "supervisor" });

  await seedConv(t, accountId, { phone: "111", name: "Mine", assignedToUserId: a.userId });
  await seedConv(t, accountId, { phone: "222", name: "Pool" });
  await seedConv(t, accountId, { phone: "333", name: "Bees", assignedToUserId: b.userId });

  const asA = await a.asUser.query(api.conversations.list, onePage);
  expect(asA.page.map((c) => c.contact?.name).sort()).toEqual(["Mine", "Pool"]);

  const asV = await v.asUser.query(api.conversations.list, onePage);
  expect(asV.page.map((c) => c.contact?.name)).toEqual(["Pool"]);

  const asS = await s.asUser.query(api.conversations.list, onePage);
  expect(asS.page).toHaveLength(3);
});

test("get denies an out-of-scope conversation with NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const { conversationId: bsConv } = await seedConv(t, accountId, { phone: "333", name: "Bees", assignedToUserId: b.userId });

  await expect(
    a.asUser.query(api.conversations.get, { conversationId: bsConv }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });
});
```

- [ ] **Step 3: Run, verify failure**

Run: `npx vitest run convex/conversations.test.ts -t "scopes conversations by role"`
Expected: FAIL — agent currently sees all 3 (no scope filter yet).

- [ ] **Step 4: Edit `convex/conversations.ts`.** Add imports at the top:

```ts
import { conversationScope, canAccessConversation } from "./lib/roles";
import { requireConversationAccess } from "./lib/conversationAccess";
```

Rewrite `list`'s handler body:

```ts
  handler: async (ctx, args) => {
    const { status, paginationOpts } = args;
    const scope = conversationScope(ctx.role);

    const base = ctx.db
      .query("conversations")
      .withIndex("by_account_last_message", (q) =>
        q.eq("accountId", ctx.accountId),
      )
      .order("desc");

    // Compose the optional status filter with the role visibility scope.
    // `own_and_pool` = assigned to me OR unassigned; `unassigned` = the
    // pool only; `all` = no extra predicate.
    const query =
      status || scope !== "all"
        ? base.filter((q) => {
            const parts = [];
            if (status) parts.push(q.eq(q.field("status"), status));
            if (scope === "own_and_pool") {
              parts.push(
                q.or(
                  q.eq(q.field("assignedToUserId"), ctx.userId),
                  q.eq(q.field("assignedToUserId"), undefined),
                ),
              );
            } else if (scope === "unassigned") {
              parts.push(q.eq(q.field("assignedToUserId"), undefined));
            }
            return parts.reduce((a, b) => q.and(a, b));
          })
        : base;

    const result = await query.paginate(paginationOpts);

    const page = await Promise.all(
      result.page.map((conversation) => embedContact(ctx, conversation)),
    );
    return { ...result, page };
  },
```

Rewrite `unreadTotal`'s handler to respect scope:

```ts
  handler: async (ctx) => {
    const scope = conversationScope(ctx.role);
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    return conversations.filter((c) => {
      if (c.unreadCount <= 0) return false;
      if (scope === "all") return true;
      if (scope === "own_and_pool")
        return c.assignedToUserId === ctx.userId || c.assignedToUserId === undefined;
      return c.assignedToUserId === undefined; // viewer: pool only
    }).length;
  },
```

Rewrite `get` to use the shared guard:

```ts
export const get = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );
    return await embedContact(ctx, conversation);
  },
});
```

In `getByContact`, after `if (!conversation) return null;`, add a scope gate so out-of-scope callers see `null`:

```ts
    if (!conversation) return null;
    const allowed = canAccessConversation(
      ctx.role,
      {
        isMine: conversation.assignedToUserId === ctx.userId,
        isUnassigned: conversation.assignedToUserId === undefined,
      },
      "view",
    );
    if (!allowed) return null;
    return await embedContact(ctx, conversation);
```

Leave the file's local `requireOwnConversation` helper in place for now — the mutations still use it until Task 6.

- [ ] **Step 5: Run, verify pass** (also verify the `undefined`-match assumption)

Run: `npx vitest run convex/conversations.test.ts`
Expected: PASS. **If the two new tests fail with agent/viewer seeing 0 rows**, then `q.eq(q.field("assignedToUserId"), undefined)` did not match unset fields in this Convex version — fall back to the composite index: add `.index("by_account_assignee_last_message", ["accountId", "assignedToUserId", "lastMessageAt"])` in `schema.ts`, and for the pool branch query that index with `q.eq("assignedToUserId", undefined)`. Re-run.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/conversationAccess.ts convex/conversations.ts convex/conversations.test.ts
git commit -m "feat(rbac): scope conversation list/get/unread by role"
```

---

## Task 5: Server-side phone masking

**Files:**
- Modify: `convex/conversations.ts` (`embedContact`)
- Modify: `convex/contacts.ts` (`list`, `get`)
- Test: `convex/conversations.test.ts`, `convex/contacts.test.ts`

**Interfaces:**
- Consumes: `maskPhone` (Task 3), `canSeeContactPhone` (Task 1).
- Produces: masked contacts (`phone` bulleted, `phoneNormalized` `""`) for callers who may not see the number.

- [ ] **Step 1: Add the failing test** to `convex/conversations.test.ts`:

```ts
test("phone is masked on the pool and unmasked on an agent's own chat", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const v = await seedUserInAccount(t, accountId, { name: "Vic", email: "v@x.com", role: "viewer" });
  const s = await seedUserInAccount(t, accountId, { name: "Sup", email: "s@x.com", role: "supervisor" });

  await seedConv(t, accountId, { phone: "+15551230148", name: "Mine", assignedToUserId: a.userId });
  await seedConv(t, accountId, { phone: "+15551230199", name: "Pool" });

  const asA = await a.asUser.query(api.conversations.list, onePage);
  const mine = asA.page.find((c) => c.contact?.name === "Mine");
  const pool = asA.page.find((c) => c.contact?.name === "Pool");
  expect(mine?.contact?.phone).toBe("+15551230148"); // own chat: real
  expect(pool?.contact?.phone).toMatch(/^•+99$/); // pool: masked
  expect(pool?.contact?.phoneNormalized).toBe("");

  const asV = await v.asUser.query(api.conversations.list, onePage);
  expect(asV.page[0]?.contact?.phone).toMatch(/^•+99$/); // viewer: masked

  const asS = await s.asUser.query(api.conversations.list, onePage);
  expect(asS.page.find((c) => c.contact?.name === "Mine")?.contact?.phone).toBe("+15551230148");
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run convex/conversations.test.ts -t "phone is masked"`
Expected: FAIL — pool phone currently returns the real number.

- [ ] **Step 3: Edit `convex/conversations.ts`.** Add imports:

```ts
import { maskPhone } from "./lib/phone";
import { canSeeContactPhone } from "./lib/roles";
import type { AccountRole } from "./lib/roles";
```

Add a masking helper (near `embedTags`):

```ts
/** Strips a contact's real number for callers not allowed to see it. */
function maskContactPhone<T extends { phone: string; phoneNormalized: string }>(
  contact: T,
): T {
  return { ...contact, phone: maskPhone(contact.phone), phoneNormalized: "" };
}
```

Change `embedContact` to take the viewer and mask when needed:

```ts
async function embedContact(
  ctx: QueryCtx & { role: AccountRole; userId: Id<"users"> },
  conversation: Doc<"conversations">,
) {
  const contact = await ctx.db.get(conversation.contactId);
  if (!contact) return { ...conversation, contact: null };
  const withTags = await embedTags(ctx, contact);
  const canSee = canSeeContactPhone(
    ctx.role,
    conversation.assignedToUserId === ctx.userId,
  );
  return {
    ...conversation,
    contact: canSee ? withTags : maskContactPhone(withTags),
  };
}
```

The `list`/`get`/`getByContact` handlers already pass `ctx` (the `accountQuery` ctx carries `role`/`userId` at runtime); the widened parameter type documents that. No call-site change needed beyond the type.

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run convex/conversations.test.ts`
Expected: PASS.

- [ ] **Step 5: Mask `contacts.list` / `contacts.get`** (defense-in-depth — agents/viewers have no Contacts UI, but the queries are callable). In `convex/contacts.ts`, add imports `import { maskPhone } from "./lib/phone"; import { hasMinRole } from "./lib/roles";`, then in `list` and `get` map the returned contact(s) through: when `!hasMinRole(ctx.role, "supervisor")` replace `phone` with `maskPhone(phone)` and `phoneNormalized` with `""`. Add a test to `convex/contacts.test.ts`:

```ts
test("contacts.get masks the phone for agent and viewer", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Ag", email: "ag@x.com", role: "agent" });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+15551230148", phoneNormalized: "15551230148", name: "X" }),
  );
  const got = await asUser.query(api.contacts.get, { contactId });
  expect(got.phone).toMatch(/^•+48$/);
  expect(got.phoneNormalized).toBe("");
});
```
(If an existing `contacts.get`/`list` test asserts a raw phone for an `agent`/`viewer` caller, update that caller to `supervisor`/`admin`, or its expected phone to the masked form.)

- [ ] **Step 6: Run full affected suites, verify pass**

Run: `npx vitest run convex/conversations.test.ts convex/contacts.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add convex/conversations.ts convex/contacts.ts convex/conversations.test.ts convex/contacts.test.ts
git commit -m "feat(rbac): mask contact phone numbers server-side"
```

---

## Task 6: Claim / assign / reassign model

**Files:**
- Modify: `convex/conversations.ts` (`assign`, `unassign`, `setStatus`, `markRead`, `setAutoreplyPaused`; remove the now-unused local `requireOwnConversation`)
- Test: `convex/conversations.test.ts`

**Interfaces:**
- Consumes: `requireConversationAccess` (Task 4), `canAssignToOthers` (Task 1).

- [ ] **Step 1: Add failing tests** to `convex/conversations.test.ts`:

```ts
test("agent self-claims an unassigned conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "111", name: "Pool" });

  await a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row?.assignedToUserId).toBe(a.userId);
  expect(row?.status).toBe("pending");
});

test("agent cannot assign a conversation to another user", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "111", name: "Pool" });

  await expect(
    a.asUser.mutation(api.conversations.assign, { conversationId, userId: b.userId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("agent cannot grab a conversation owned by another agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "111", name: "Bees", assignedToUserId: b.userId });

  await expect(
    a.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });
});

test("supervisor assigns a conversation to any agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const s = await seedUserInAccount(t, accountId, { name: "Sup", email: "s@x.com", role: "supervisor" });
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const { conversationId } = await seedConv(t, accountId, { phone: "111", name: "Pool" });

  await s.asUser.mutation(api.conversations.assign, { conversationId, userId: a.userId });
  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row?.assignedToUserId).toBe(a.userId);
});

test("agent releases only their own conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const mine = await seedConv(t, accountId, { phone: "111", name: "Mine", assignedToUserId: a.userId });
  const theirs = await seedConv(t, accountId, { phone: "222", name: "Bees", assignedToUserId: b.userId });

  await a.asUser.mutation(api.conversations.unassign, { conversationId: mine.conversationId });
  expect((await t.run((ctx) => ctx.db.get(mine.conversationId)))?.assignedToUserId).toBeUndefined();

  await expect(
    a.asUser.mutation(api.conversations.unassign, { conversationId: theirs.conversationId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });
});

test("viewer cannot assign", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const v = await seedUserInAccount(t, accountId, { name: "Vic", email: "v@x.com", role: "viewer" });
  const { conversationId } = await seedConv(t, accountId, { phone: "111", name: "Pool" });

  await expect(
    v.asUser.mutation(api.conversations.assign, { conversationId, userId: v.userId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});
```

- [ ] **Step 2: Run, verify failures**

Run: `npx vitest run convex/conversations.test.ts -t "agent cannot assign a conversation to another user"`
Expected: FAIL (agent can currently assign to anyone).

- [ ] **Step 3: Edit `convex/conversations.ts`.** Add import `import { canAssignToOthers } from "./lib/roles";` (extend the existing roles import). In `assign`, replace the line `const conversation = await requireOwnConversation(ctx, args.conversationId);` with:

```ts
    // View access reaches the conversation; the claim constraints below
    // restrict agents to self-claiming the pool.
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );

    if (!canAssignToOthers(ctx.role)) {
      const notSelf = args.userId !== ctx.userId;
      const ownedByOther =
        conversation.assignedToUserId !== undefined &&
        conversation.assignedToUserId !== ctx.userId;
      if (notSelf || ownedByOther) {
        throw new ConvexError({ code: "FORBIDDEN", min: "supervisor" });
      }
    }
```

Leave the rest of `assign` (membership check + patch + notification) unchanged.

In `unassign`, `setStatus`, `markRead`, `setAutoreplyPaused`, replace each `await requireOwnConversation(ctx, args.conversationId);` line with the shared guard at the right mode:
- `unassign` → `await requireConversationAccess(ctx, args.conversationId, "own");`
- `setStatus` → `await requireConversationAccess(ctx, args.conversationId, "own");`
- `markRead` → `await requireConversationAccess(ctx, args.conversationId, "view");`
- `setAutoreplyPaused` → `await requireConversationAccess(ctx, args.conversationId, "view");`

Then delete the now-unused local `requireOwnConversation` helper (and its doc comment). Verify nothing else references it: `grep -n "requireOwnConversation" convex/conversations.ts` should return no matches after deletion.

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run convex/conversations.test.ts`
Expected: PASS. (Existing `assign`/`unassign` tests that assigned across users as an `agent` must be updated: change the actor to `supervisor`, or keep the agent but target self.)

- [ ] **Step 5: Commit**

```bash
git add convex/conversations.ts convex/conversations.test.ts
git commit -m "feat(rbac): agent self-claim model for conversation assignment"
```

---

## Task 7: Message read/send access

**Files:**
- Modify: `convex/messages.ts` (`listByConversation`, `append`)
- Test: `convex/messages.test.ts`

**Interfaces:**
- Consumes: `requireConversationAccess` (Task 4). `appendInternal` keeps the local account-only `requireOwnConversation` (internal, no session).

- [ ] **Step 1: Add failing tests** to `convex/messages.test.ts`. Add the same `seedUserInAccount` / `seedConv` / `seedAccountWithOwner` / `onePage` helpers used in Task 4 (copy them into this file's helper section; also add `import type { AccountRole } from "./lib/roles";`). Then:

```ts
test("agent can send only in a conversation assigned to them", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const mine = await seedConv(t, accountId, { phone: "111", name: "Mine", assignedToUserId: a.userId });
  const pool = await seedConv(t, accountId, { phone: "222", name: "Pool" });

  await a.asUser.mutation(api.messages.append, {
    conversationId: mine.conversationId,
    senderType: "agent",
    contentType: "text",
    contentText: "hi",
  });
  expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(1);

  await expect(
    a.asUser.mutation(api.messages.append, {
      conversationId: pool.conversationId,
      senderType: "agent",
      contentType: "text",
      contentText: "nope",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });
});

test("agent cannot read messages of another agent's conversation; viewer can read the pool", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountWithOwner(t);
  const a = await seedUserInAccount(t, accountId, { name: "AgentA", email: "a@x.com", role: "agent" });
  const b = await seedUserInAccount(t, accountId, { name: "AgentB", email: "b@x.com", role: "agent" });
  const v = await seedUserInAccount(t, accountId, { name: "Vic", email: "v@x.com", role: "viewer" });
  const theirs = await seedConv(t, accountId, { phone: "111", name: "Bees", assignedToUserId: b.userId });
  const pool = await seedConv(t, accountId, { phone: "222", name: "Pool" });

  await expect(
    a.asUser.query(api.messages.listByConversation, { conversationId: theirs.conversationId, ...onePage }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "conversation" } });

  const poolMsgs = await v.asUser.query(api.messages.listByConversation, { conversationId: pool.conversationId, ...onePage });
  expect(poolMsgs.page).toEqual([]);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run convex/messages.test.ts -t "agent can send only"`
Expected: FAIL (agent can currently send in any in-account conversation).

- [ ] **Step 3: Edit `convex/messages.ts`.** Add `import { requireConversationAccess } from "./lib/conversationAccess";`. In `append`, replace:

```ts
    const conversation = await requireOwnConversation(
      ctx,
      ctx.accountId,
      args.conversationId,
    );
```
with:
```ts
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "own",
    );
```

In `listByConversation`, replace `await requireOwnConversation(ctx, ctx.accountId, args.conversationId);` with `await requireConversationAccess(ctx, args.conversationId, "view");`.

Leave `appendInternal` and the file's local `requireOwnConversation` unchanged (still used by `appendInternal`, which has no session/role).

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run convex/messages.test.ts`
Expected: PASS. (Update any existing `append`/`listByConversation` test that used an `agent` on an unassigned/foreign conversation — assign it to the actor first or use `supervisor`.)

- [ ] **Step 5: Commit**

```bash
git add convex/messages.ts convex/messages.test.ts
git commit -m "feat(rbac): scope message read/send to conversation access"
```

---

## Task 8: Allow supervisor in members + invitations

**Files:**
- Modify: `convex/members.ts` (`setRole` role validator)
- Modify: `convex/invitations.ts` (`create` role validator)
- Test: `convex/members.test.ts`, `convex/invitations.test.ts`

- [ ] **Step 1: Add failing tests.** To `convex/members.test.ts`:

```ts
test("admin can set a member's role to supervisor", async () => {
  const t = convexTest(schema, modules);
  const adminId = await t.run((ctx) => ctx.db.insert("users", { name: "Ad", email: "ad@x.com" }));
  const targetId = await t.run((ctx) => ctx.db.insert("users", { name: "Ag", email: "ag@x.com" }));
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", { name: "Acme", defaultCurrency: "USD", ownerUserId: adminId });
    await ctx.db.insert("memberships", { userId: adminId, accountId: id, role: "admin" });
    await ctx.db.insert("memberships", { userId: targetId, accountId: id, role: "agent" });
    return id;
  });
  const asAdmin = t.withIdentity({ subject: `${adminId}|s` });
  await asAdmin.mutation(api.members.setRole, { userId: targetId, role: "supervisor" });
  const m = await t.run((ctx) =>
    ctx.db.query("memberships")
      .withIndex("by_user_account", (q) => q.eq("userId", targetId).eq("accountId", accountId))
      .first(),
  );
  expect(m?.role).toBe("supervisor");
});

test("supervisor cannot change roles", async () => {
  const t = convexTest(schema, modules);
  const supId = await t.run((ctx) => ctx.db.insert("users", { name: "Su", email: "su@x.com" }));
  const targetId = await t.run((ctx) => ctx.db.insert("users", { name: "Ag", email: "ag@x.com" }));
  await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", { name: "Acme", defaultCurrency: "USD", ownerUserId: supId });
    await ctx.db.insert("memberships", { userId: supId, accountId: id, role: "supervisor" });
    await ctx.db.insert("memberships", { userId: targetId, accountId: id, role: "agent" });
  });
  const asSup = t.withIdentity({ subject: `${supId}|s` });
  await expect(
    asSup.mutation(api.members.setRole, { userId: targetId, role: "viewer" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});
```

To `convex/invitations.test.ts`:

```ts
test("admin can invite a supervisor", async () => {
  const t = convexTest(schema, modules);
  const adminId = await t.run((ctx) => ctx.db.insert("users", { name: "Ad", email: "ad@x.com" }));
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", { name: "Acme", defaultCurrency: "USD", ownerUserId: adminId });
    await ctx.db.insert("memberships", { userId: adminId, accountId: id, role: "admin" });
    return id;
  });
  const asAdmin = t.withIdentity({ subject: `${adminId}|s` });
  const res = await asAdmin.mutation(api.invitations.create, { role: "supervisor" });
  const row = await t.run((ctx) => ctx.db.get(res.invitationId));
  expect(row?.role).toBe("supervisor");
});
```

- [ ] **Step 2: Run, verify failure**

Run: `npx vitest run convex/members.test.ts convex/invitations.test.ts -t "supervisor"`
Expected: FAIL — validators reject `"supervisor"` (argument validation error).

- [ ] **Step 3: Edit the validators.** In `convex/members.ts` `setRole.args.role`, add `v.literal("supervisor")`:

```ts
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("supervisor"),
      v.literal("agent"),
      v.literal("viewer"),
    ),
```

In `convex/invitations.ts` `create.args.role`:

```ts
      role: v.union(
        v.literal("admin"),
        v.literal("supervisor"),
        v.literal("agent"),
        v.literal("viewer"),
      ),
```

- [ ] **Step 4: Run, verify pass**

Run: `npx vitest run convex/members.test.ts convex/invitations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/members.ts convex/invitations.ts convex/members.test.ts convex/invitations.test.ts
git commit -m "feat(rbac): allow assigning/inviting the supervisor role"
```

---

## Task 9: Settings guard split (server)

Moves operational-settings mutations to `supervisor+` (so supervisors can manage them and agents can't) and pulls the operational catalogs that were `admin`-only down to `supervisor+`. Critical config (WhatsApp, API keys, AI keys, webhooks) stays `admin+`. Per-lead data (contacts, deals, custom-field values, contact notes) stays `agent+` unchanged.

**Files & exact guard changes:**

| File | Function(s) | Current guard | New guard |
|---|---|---|---|
| `convex/tags.ts` | `create` (:23), `remove` (:42) | `ctx.requireRole("agent")` | `ctx.requireRole("supervisor")` |
| `convex/quickReplies.ts` | `create` (:56), `update` (:84), `remove` (:96) | `ctx.requireRole("agent")` | `ctx.requireRole("supervisor")` |
| `convex/templates.ts` | `upsert` (:179), `updateStatusByMetaId` (:276), `remove` (:305) | `ctx.requireRole("agent")` | `ctx.requireRole("supervisor")` |
| `convex/templates.ts` | `submit` (:485), `syncFromMeta` (:787) actions | `hasMinRole(context.role, "agent")` | `hasMinRole(context.role, "supervisor")` |
| `convex/templates.ts` | `editSubmit` (:693) action | `hasMinRole(context.role, "admin")` | `hasMinRole(context.role, "supervisor")` |
| `convex/customFields.ts` | `create` (:105), `rename` (:124), `remove` (:144) | `ctx.requireRole("admin")` | `ctx.requireRole("supervisor")` |
| `convex/accounts.ts` | `setDefaultCurrency` (:219) | `hasMinRole(membership.role, "admin")` | `hasMinRole(membership.role, "supervisor")` |
| `convex/pipelines.ts` | every mutation guarded `ctx.requireRole("admin")` | `ctx.requireRole("admin")` | `ctx.requireRole("supervisor")` |

**No change (critical / per-lead):** `whatsappConfig.*` (admin), `apiKeys.create/revoke` (admin), `aiConfig.*`/`aiKnowledge.*`/`webhookEndpoints.*` (admin), `contacts.*` (agent), `deals.*` (agent), `customFields.setForContact` (agent), `contactNotes.*` (agent), `whatsappConfig.fetchMedia` (agent).

- [ ] **Step 1: Enumerate pipelines guards**

Run: `grep -n 'requireRole("admin")' convex/pipelines.ts`
Record each line — all become `"supervisor"`.

- [ ] **Step 2: Apply the guard changes** in the table above (and each pipelines line). Use `Edit` per file. For the `templates.ts` actions, change the string inside `hasMinRole(context.role, "…")`.

- [ ] **Step 3: Reconcile + extend each vertical's tests.** For each changed file, run its test suite and fix expectations, then add boundary tests. Run e.g. `npx vitest run convex/tags.test.ts` and reconcile:
  - Tests where an **agent** performed a now-supervisor action → change that actor's role to `"supervisor"` (or `"admin"`).
  - `FORBIDDEN` assertions with `min: "agent"`/`min: "admin"` on these functions → update to `min: "supervisor"`.
  - Add one success + one denial boundary test per vertical, e.g. for tags:

```ts
test("supervisor can create a tag; agent cannot", async () => {
  const t = convexTest(schema, modules);
  const s = await seedAccountMember(t, { name: "Sup", email: "s@x.com", role: "supervisor" });
  await expect(
    s.asUser.mutation(api.tags.create, { name: "VIP", color: "#f00" }),
  ).resolves.not.toBeNull();

  const ag = await seedAccountMember(t, { name: "Ag", email: "ag@x.com", role: "agent" });
  await expect(
    ag.asUser.mutation(api.tags.create, { name: "Nope", color: "#00f" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});
```

(Use each file's real `seedAccountMember` and the real arg shapes for `quickReplies.create`, `templates.upsert`, `customFields.create`, `accounts.setDefaultCurrency`, `pipelines.create`. For the `admin→supervisor` verticals — customFields, accounts currency, pipelines — the boundary test asserts `supervisor` now succeeds and `agent` gets `FORBIDDEN {min:"supervisor"}`.)

- [ ] **Step 4: Run all affected suites, verify pass**

Run: `npx vitest run convex/tags.test.ts convex/quickReplies.test.ts convex/templates.test.ts convex/customFields.test.ts convex/accounts.test.ts convex/pipelines.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/tags.ts convex/quickReplies.ts convex/templates.ts convex/customFields.ts convex/accounts.ts convex/pipelines.ts convex/*.test.ts
git commit -m "feat(rbac): split settings guards into operational (supervisor+) vs critical (admin+)"
```

> Note: adding `"supervisor"` to the `AccountRole` union (Task 2) makes every exhaustive `Record<AccountRole, …>` and role `switch` a compile error until it has a supervisor arm. Tasks 10 & 12 add those arms; the full `npm run typecheck` gate is Task 13. Client tasks below are verified via typecheck + the live preview (this codebase unit-tests pure logic, not React components).

## Task 10: Client role wiring (auth hook, capabilities, chips)

**Files:**
- Modify: `src/hooks/use-auth.tsx`, `src/hooks/use-can.ts`
- Modify: `src/components/settings/role-meta.ts`, `src/components/settings/settings-chip.tsx`, `src/components/layout/sidebar.tsx` (`ROLE_CHIP`)

- [ ] **Step 1: `src/hooks/use-auth.tsx`.** Update the import to add the two split predicates:

```tsx
import {
  canEditCriticalSettings as canEditCriticalSettingsFor,
  canEditOperationalSettings as canEditOperationalSettingsFor,
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  type AccountRole,
} from "@/lib/auth/roles";
```

In the `AuthContextValue` interface add three fields (near `isViewer` / `canEditSettings`):

```tsx
  /** True if `accountRole === 'supervisor'`. */
  isSupervisor: boolean;
  /** Critical config (WhatsApp, API keys): admin+. */
  canEditCriticalSettings: boolean;
  /** Operational config (templates, quick replies, fields, deals): supervisor+. */
  canEditOperationalSettings: boolean;
```

In the `derived` `useMemo`, add the three derived values:

```tsx
      isSupervisor: role === "supervisor",
      canEditCriticalSettings: role ? canEditCriticalSettingsFor(role) : false,
      canEditOperationalSettings: role ? canEditOperationalSettingsFor(role) : false,
```

In the outside-provider fallback object add:

```tsx
      isSupervisor: false,
      canEditCriticalSettings: false,
      canEditOperationalSettings: false,
```

- [ ] **Step 2: `src/hooks/use-can.ts`.** Extend imports + the `CanAction` union + the switch:

```ts
import {
  canDeleteAccount,
  canEditCriticalSettings,
  canEditOperationalSettings,
  canEditSettings,
  canManageMembers,
  canSendMessages,
  canTransferOwnership,
  canViewOnly,
} from "@/lib/auth/roles";

export type CanAction =
  | "manage-members"
  | "edit-settings"
  | "edit-critical-settings"
  | "edit-operational-settings"
  | "send-messages"
  | "view-only"
  | "delete-account"
  | "transfer-ownership";
```

Add the two cases in the switch (before `default`):

```ts
    case "edit-critical-settings":
      return canEditCriticalSettings(accountRole);
    case "edit-operational-settings":
      return canEditOperationalSettings(accountRole);
```

- [ ] **Step 3: Add the supervisor chip variant.** In `src/components/settings/settings-chip.tsx`, add `'supervisor'` to the `ChipVariant` union and a matching style branch (mirror the `admin` branch but cyan, e.g. `border-cyan-500/40 bg-cyan-500/10 text-cyan-300`). Then in `src/components/settings/role-meta.ts` add the supervisor entry and import `ShieldCheck`:

```ts
import { Crown, Shield, ShieldCheck, UserCog, UserIcon, type LucideIcon } from 'lucide-react';
// ...
  supervisor: {
    icon: ShieldCheck,
    label: 'supervisor',
    variant: 'supervisor',
    className: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  },
```

- [ ] **Step 4: `src/components/layout/sidebar.tsx` `ROLE_CHIP`.** Add `ShieldCheck` to the lucide import and a supervisor entry:

```tsx
  supervisor: {
    icon: ShieldCheck,
    labelKey: "roleSupervisor",
    className: "border-cyan-500/40 bg-cyan-500/10 text-cyan-300",
  },
```

- [ ] **Step 5: Typecheck the touched surface**

Run: `npx tsc --noEmit`
Expected: no errors in `use-auth.tsx`, `use-can.ts`, `role-meta.ts`, `settings-chip.tsx`, `sidebar.tsx`. (Other files' `Record<AccountRole>` errors are resolved in Task 12 / caught in Task 13.)

- [ ] **Step 6: Commit**

```bash
git add src/hooks/use-auth.tsx src/hooks/use-can.ts src/components/settings/role-meta.ts src/components/settings/settings-chip.tsx src/components/layout/sidebar.tsx
git commit -m "feat(rbac): wire supervisor + settings-split capabilities into client hooks/chips"
```

---

## Task 11: Nav, route, and settings-section gating (+ agent claim-to-reply)

**Files:**
- Modify: `src/lib/auth/roles.ts` (+ test) — add `canAccessRoute`
- Create: `src/components/auth/require-section.tsx`
- Modify: `src/app/(dashboard)/dashboard-shell.tsx` (wrap with route guard)
- Modify: `src/components/layout/sidebar.tsx` (filter nav), `src/components/layout/header.tsx` (avatar menu)
- Modify: `src/components/settings/settings-rail.tsx`, `src/app/(dashboard)/settings/page.tsx`
- Modify: `src/components/inbox/message-composer.tsx` (or the thread) — claim-to-reply for agents on pool chats

- [ ] **Step 1: Add `canAccessRoute` (test first).** In `src/lib/auth/roles.test.ts`:

```ts
  it("canAccessRoute always allows /settings (personal) but gates feature routes", () => {
    expect(canAccessRoute("agent", "/settings")).toBe(true);
    expect(canAccessRoute("agent", "/settings?tab=whatsapp")).toBe(true); // page gates the tab
    expect(canAccessRoute("agent", "/contacts")).toBe(false);
    expect(canAccessRoute("agent", "/inbox")).toBe(true);
    expect(canAccessRoute("viewer", "/notifications")).toBe(false);
    expect(canAccessRoute("supervisor", "/broadcasts")).toBe(true);
  });
```
Add `canAccessRoute` to the test imports. Run `npx vitest run src/lib/auth/roles.test.ts` → FAIL. Then add to `src/lib/auth/roles.ts`:

```ts
/** Route-level access (for the client route guard). Same as `canAccessNav`
 *  except `/settings` is always reachable — the personal Profile/Appearance
 *  sections are universal, and the settings page gates its own tabs. */
export function canAccessRoute(role: AccountRole, path: string): boolean {
  const base = "/" + (path.split("?")[0].split("/")[1] ?? "");
  if (base === "/settings") return true;
  return canAccessNav(role, base);
}
```
Run the test → PASS.

- [ ] **Step 2: Create `src/components/auth/require-section.tsx`:**

```tsx
"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/hooks/use-auth";
import { canAccessRoute, defaultLandingPath } from "@/lib/auth/roles";

/** Redirects a member who lands on a route their role can't access to
 *  their default home. Server queries already reject; this is UX. */
export function RequireSection({ children }: { children: ReactNode }) {
  const { accountRole, profileLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const blocked = !profileLoading && !!accountRole && !canAccessRoute(accountRole, pathname);

  useEffect(() => {
    if (blocked && accountRole) router.replace(defaultLandingPath(accountRole));
  }, [blocked, accountRole, router]);

  if (blocked) return null;
  return <>{children}</>;
}
```

Before writing routing/redirect code, skim `node_modules/next/dist/docs/` for the current `useRouter`/`redirect` guidance (Global Constraints).

- [ ] **Step 3: Wrap the dashboard content** in `src/app/(dashboard)/dashboard-shell.tsx` — import `RequireSection` and wrap the rendered `children` (inside the existing auth-gated shell) with `<RequireSection>{children}</RequireSection>`.

- [ ] **Step 4: Filter the sidebar nav.** In `src/components/layout/sidebar.tsx`, import `canAccessNav` and `accountRole` (already from `useAuth`). Gate both lists at render:
  - `navItems.filter((item) => accountRole && canAccessNav(accountRole, item.href))` before `.map`.
  - `bottomNavItems.filter((item) => accountRole && canAccessNav(accountRole, item.href))` (hides Settings for agent/viewer).

- [ ] **Step 5: Header avatar menu.** In `src/components/layout/header.tsx`, import `useAuth` + `canAccessNav`; keep the **Profile** item for everyone, but render the **Settings** item only when `accountRole && canAccessNav(accountRole, "/settings")` (supervisor+). Point that Settings item at `/settings` (not `?tab=whatsapp`).

- [ ] **Step 6: Settings rail + page section gating.** In `src/components/settings/settings-rail.tsx`, read `accountRole` via `useAuth` and filter each group's `items` with `canAccessSettingsSection(accountRole, s)`. In `src/app/(dashboard)/settings/page.tsx`, read `accountRole`; after `const section = resolveSection(...)`, if `accountRole && !canAccessSettingsSection(accountRole, section)` then `router.replace('/settings?tab=profile')` (in an effect) and render the profile panel meanwhile.

- [ ] **Step 7: Agent claim-to-reply.** The composer must not let an agent send in a conversation they don't own (the server now rejects it). In the thread/composer that renders the message input (`src/components/inbox/message-composer.tsx` and/or `message-thread.tsx`), compute from the active conversation + `useAuth`:
  - `const mine = conversation.assigned_to_user_id === user?.id;` (use the adapted field name in the UI type)
  - `const isPool = !conversation.assigned_to_user_id;`
  - If `accountRole === 'agent' && !mine`: replace the composer with a **"Claim to reply"** button that calls `useMutation(api.conversations.assign)({ conversationId, userId: user.id })` (only enabled when `isPool`; if owned by someone else the agent can't see it anyway). After claim, the composer returns (the conversation becomes `mine` reactively).
  - If `accountRole === 'viewer'`: show a read-only notice instead of the composer (viewers can't send).
  Keep the existing `canSend = useCan("send-messages")` gate for supervisor/admin/owner (unchanged).

- [ ] **Step 8: Verify via preview** (deferred to Task 13's smoke pass — no unit test for these components). Typecheck now:

Run: `npx tsc --noEmit`
Expected: the nav/route/settings/composer files typecheck.

- [ ] **Step 9: Commit**

```bash
git add src/lib/auth/roles.ts src/lib/auth/roles.test.ts src/components/auth/require-section.tsx src/app/\(dashboard\)/dashboard-shell.tsx src/components/layout/sidebar.tsx src/components/layout/header.tsx src/components/settings/settings-rail.tsx src/app/\(dashboard\)/settings/page.tsx src/components/inbox/message-composer.tsx src/components/inbox/message-thread.tsx
git commit -m "feat(rbac): role-gate nav, routes, settings sections + agent claim-to-reply"
```

---

## Task 12: Members/invite UI + i18n for supervisor

**Files:**
- Modify: `src/components/settings/members-tab.tsx` (`EDITABLE_ROLES`)
- Modify: `src/components/settings/invite-member-dialog.tsx` (`InviteRole` + option + hint)
- Modify: every `messages/*.json` locale file

- [ ] **Step 1: `members-tab.tsx`** — add supervisor to `EDITABLE_ROLES` (ordered by rank):

```ts
const EDITABLE_ROLES: { value: AccountRole }[] = [
  { value: 'admin' },
  { value: 'supervisor' },
  { value: 'agent' },
  { value: 'viewer' },
];
```

- [ ] **Step 2: `invite-member-dialog.tsx`** — widen the type and add the option:

```ts
type InviteRole = 'admin' | 'supervisor' | 'agent' | 'viewer';
```
Add inside the role `<SelectContent>` (after admin):
```tsx
                    <SelectItem value="supervisor">{tRoles('supervisor')}</SelectItem>
```
The hint line already interpolates `tRoles(\`${role}Hint\`)`; widen its cast to include `'supervisorHint'`.

- [ ] **Step 3: Add i18n keys to every locale.** List them: `ls messages/`. For EACH `messages/<locale>.json` add:
  - `Settings.roles.supervisor` = `"Supervisor"`
  - `Settings.roles.supervisorHint` = `"Sees all chats and manages day-to-day settings, but not WhatsApp/API credentials or the team roster."`
  - `Sidebar.roleSupervisor` = `"Supervisor"`

  Use the English strings above in `en.json`; add the same keys to the other locales (English value is an acceptable placeholder — flag non-English translation as a follow-up so `next-intl` never hits a missing key). Match the existing nesting/formatting of each file exactly.

- [ ] **Step 4: Verify no missing-key crash + typecheck**

Run: `npx tsc --noEmit` (should now be clean — the last `Record<AccountRole>` arms exist).
Run: `grep -L '"supervisor"' messages/*.json` — should print nothing (every locale has the key).

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/members-tab.tsx src/components/settings/invite-member-dialog.tsx messages/
git commit -m "feat(rbac): supervisor in members/invite UI + i18n labels"
```

---

## Task 13: Full verification

**Files:** none (verification + any straggler fixes uncovered here).

- [ ] **Step 1: Full unit-test suite**

Run: `npm test`
Expected: all green. Fix any straggler test that still assumes the old role model (search hint: `grep -rn 'toBe(4)\|min: "admin"\|role: "agent"' convex/*.test.ts` and reconcile against the new ranks/guards).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. Any remaining error is almost certainly an exhaustive `Record<AccountRole, …>` or role `switch` missing a `supervisor` arm — add it.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean (fix any unused-import / exhaustiveness warnings introduced).

- [ ] **Step 4: Live preview smoke** (use the `preview_*` tooling, not `npm run dev` in Bash). Start the dev server and confirm, as the signed-in owner/admin:
  - Inbox loads; conversation list + a thread render; no console errors.
  - Settings rail shows all sections; the new **Supervisor** option appears in the invite dialog and the members role dropdown.
  - Sidebar shows the role chip.
  Record a screenshot of the members tab (supervisor selectable) and the inbox as proof.

  Per-role behavioral QA (agent sees only own+pool, masked pool numbers, viewer read-only pool, supervisor all-chats-no-critical-settings) is best done against seeded accounts — note in the PR that this needs a quick manual pass with test members of each role, since the automated coverage lives in the Convex suites (Tasks 4–9).

- [ ] **Step 5: Update CHANGELOG (optional but conventional)** — add an entry under an "Unreleased" heading summarizing the Supervisor role, chat-visibility scoping, phone masking, and the self-claim model.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "chore(rbac): changelog + verification fixes"
```

---

## Plan self-review

- **Spec coverage:** Supervisor role → Tasks 1,2,8,10,12. Chat visibility → Tasks 1,4. Phone masking → Tasks 1,3,5. Claim model → Tasks 1,4,6,7,11. Settings split → Tasks 1,2,9,10,11. Nav/section gating → Tasks 2,11,12. Rollout/behavioral-change → surfaced in Task 13 PR note. Phase-2 hook (self-claim choke point) → preserved in Task 6/11.
- **Type consistency:** `requireConversationAccess(ctx, id, mode)` / `canAccessConversation(role, {isMine,isUnassigned}, mode)` / `conversationScope` / `canSeeContactPhone` / `maskPhone` names are used identically across tasks. Client mirrors the server union.
- **Known risk flagged:** the `q.eq(field, undefined)` pool-match assumption has an explicit fallback (composite index) in Task 4 Step 5.
- **Deliberately out of scope (noted, not gaps):** `contacts/deals` write-scoping for agents (agents have no such UI; reads are masked); non-English translations of the supervisor strings (placeholder + follow-up).

