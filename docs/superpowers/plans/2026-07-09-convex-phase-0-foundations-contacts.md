# Convex Phase 0 — Foundations + Contacts Vertical (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up self-hosted Convex + Convex Auth in the existing Next.js app, build the tenant-security spine, and migrate the **Contacts** vertical end-to-end as the reference implementation — proving schema, auth, account isolation, search, and reactive queries before the full sweep.

**Architecture:** Convex runs alongside the existing Supabase app on branch `feat/convex-migration`. Only the Contacts pages are wired to Convex in this phase (hybrid dev state; fine because data is empty and we don't merge to `main`). All new tenant functions go through `accountQuery`/`accountMutation`.

**Tech Stack:** Convex (self-hosted Docker + Postgres), `@convex-dev/auth` (Password), `convex-helpers`, `convex-test` + Vitest, Next.js 16.2.6.

## Global Constraints

*(Inherited verbatim from `2026-07-09-convex-migration-roadmap.md` — read that file's "Global Constraints" section. The load-bearing ones for this phase:)*
- **Read `node_modules/next/dist/docs/` before any Next.js code** (middleware, providers, layout, route handlers). This repo's Next.js differs from training data.
- **Every tenant function uses `accountQuery`/`accountMutation`; every tenant table has `by_account`; every feature ships a cross-account denial test.**
- **Pin** `@convex-dev/auth` + `@auth/core`; wrap auth behind `src/lib/auth/*`.
- **No ETL / no dual-write.** Do not merge to `main` this phase.

---

## Execution Prerequisite (do first, once)

- [ ] **Confirm a reachable Convex backend.** Self-host per roadmap: `curl -O https://raw.githubusercontent.com/get-convex/convex-backend/main/self-hosted/docker-compose.yml` then `docker compose up -d`; set `CONVEX_SELF_HOSTED_URL` + `CONVEX_SELF_HOSTED_ADMIN_KEY` in `.env.local`. (Or use provided Convex Cloud dev credentials as an interim.) Verify `npx convex dev --once` connects before proceeding.

---

## File Structure

- `convex/schema.ts` — schema (authTables + accounts, memberships, contacts, tags, contactTags)
- `convex/auth.ts` — `convexAuth({ providers: [Password] })`
- `convex/auth.config.ts` — auth provider config
- `convex/http.ts` — auth HTTP routes
- `convex/lib/auth.ts` — `accountQuery`/`accountMutation`/`requireRole` (the security spine)
- `convex/lib/roles.ts` — `roleRank`/`hasMinRole` (ported from `src/lib/auth/roles.ts`)
- `convex/accounts.ts` — first-signup-creates-account; `currentUser` query
- `convex/contacts.ts` — list/get/create/update/remove/filterByTags
- `convex/tags.ts` — list/create/delete + assign/unassign to contacts
- `convex/contacts.test.ts`, `convex/lib/auth.test.ts` — convex-test suites
- `src/lib/auth/convex.ts` — thin client wrapper over `useAuthActions`
- `src/app/ConvexClientProvider.tsx` — provider (Next.js-docs-first)
- `src/middleware.ts` — add Convex auth middleware (Next.js-docs-first; keep Supabase middleware until Phase 8)
- Modify: `src/app/(dashboard)/contacts/page.tsx`, `src/components/contacts/contact-form.tsx`, `contact-detail-view.tsx`, `import-modal.tsx`, `custom-fields-manager.tsx` (contacts-only bits)

---

### Task 1: Install & connect Convex + provider

**Files:** Create `src/app/ConvexClientProvider.tsx`; Modify `src/app/layout.tsx`, `package.json`.

**Interfaces:**
- Produces: `<ConvexClientProvider>` wrapping the app; `NEXT_PUBLIC_CONVEX_URL` in env.

- [ ] **Step 1: Install deps** — `npm install convex convex-helpers` and dev `npm install -D convex-test vitest @edge-runtime/vm` (skip any already present).
- [ ] **Step 2: Init** — `npx convex dev --once` to generate `convex/` + `_generated/` and confirm backend connectivity.
- [ ] **Step 3 (Next.js-docs-first):** Read `node_modules/next/dist/docs/` for the current App Router root-layout + client-provider pattern, THEN create `ConvexClientProvider.tsx` (a `"use client"` component holding a module-level `ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!)`) and wrap `children` in `layout.tsx`. (Will be swapped for `ConvexAuthProvider` in Task 3.)
- [ ] **Step 4: Verify** — `npx convex dev --once` clean; `npm run build` compiles.
- [ ] **Step 5: Commit** — `feat(convex): add convex client + provider`.

---

### Task 2: Convex Auth (Password provider)

**Files:** Create `convex/auth.ts`, `convex/auth.config.ts`, `convex/http.ts`, `src/lib/auth/convex.ts`; Modify `convex/schema.ts`, `src/app/ConvexClientProvider.tsx`, `src/middleware.ts`, `package.json` (pin versions).

**Interfaces:**
- Produces: `getAuthUserId(ctx)` usable server-side; `signIn`/`signOut` via `useAuthActions`; `authTables` in schema.

- [ ] **Step 1: Install & pin** — `npm install @convex-dev/auth @auth/core@0.41.1`, then `npx @convex-dev/auth` (setup CLI: writes keys/config). Pin exact versions in `package.json`.
- [ ] **Step 2: Schema** — add auth tables to `convex/schema.ts`:
```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

export default defineSchema({
  ...authTables,
  // (other tables added in Task 4 / Task 6)
});
```
- [ ] **Step 3: Provider** — `convex/auth.ts`:
```ts
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      validatePasswordRequirements: (password: string) => {
        if (password.length < 8) throw new Error("Password must be at least 8 characters.");
      },
    }),
  ],
});
```
- [ ] **Step 4 (Next.js-docs-first):** Read `node_modules/next/dist/docs/` for middleware, THEN wire `@convex-dev/auth/nextjs/server` (`convexAuthNextjsMiddleware`, `isAuthenticatedNextjs`) in `src/middleware.ts` **without deleting** the existing Supabase middleware (both run this phase; Supabase middleware removed in Phase 8). Swap `ConvexProvider` → `ConvexAuthNextjsServerProvider`/`ConvexAuthProvider` in the provider file per the docs.
- [ ] **Step 5: Client wrapper** — `src/lib/auth/convex.ts` re-exporting `useAuthActions` usage (`signInWithPassword({email,password,flow})`, `signOut`) so pages never import `@convex-dev/auth` directly.
- [ ] **Step 6: Manual verify** — a temporary throwaway sign-up form creates a `users` row (check `npx convex data users`). Then remove the throwaway.
- [ ] **Step 7: Commit** — `feat(convex): convex-auth password provider + next wiring`.

---

### Task 3: Roles helper (port)

**Files:** Create `convex/lib/roles.ts`, `convex/lib/roles.test.ts`.

**Interfaces:**
- Produces: `type AccountRole`, `roleRank(role): number`, `hasMinRole(role, min): boolean`.

- [ ] **Step 1: Failing test** — `convex/lib/roles.test.ts`:
```ts
import { test, expect } from "vitest";
import { hasMinRole, roleRank } from "./roles";
test("role ladder", () => {
  expect(roleRank("owner")).toBe(4);
  expect(hasMinRole("admin", "agent")).toBe(true);
  expect(hasMinRole("viewer", "admin")).toBe(false);
});
```
- [ ] **Step 2: Run → fail** (`npx vitest run convex/lib/roles.test.ts`).
- [ ] **Step 3: Implement** — copy the `AccountRole`/`roleRank`/`hasMinRole` logic from `src/lib/auth/roles.ts` (owner=4, admin=3, agent=2, viewer=1).
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(convex): port role ladder`.

---

### Task 4: Accounts + memberships schema & bootstrap

**Files:** Modify `convex/schema.ts`; Create `convex/accounts.ts`, `convex/accounts.test.ts`.

**Interfaces:**
- Consumes: `authTables`, `getAuthUserId`.
- Produces: `accounts`/`memberships` tables; `bootstrapAccount` mutation (idempotent, first login); `currentUser` query returning `{ user, accountId, role }`.

- [ ] **Step 1: Schema** — add to `convex/schema.ts`:
```ts
accounts: defineTable({
  name: v.string(),
  defaultCurrency: v.string(),          // ISO-4217, default "USD"
  ownerUserId: v.id("users"),
}).index("by_owner", ["ownerUserId"]),

memberships: defineTable({
  userId: v.id("users"),
  accountId: v.id("accounts"),
  role: v.union(v.literal("owner"), v.literal("admin"), v.literal("agent"), v.literal("viewer")),
  fullName: v.optional(v.string()),
  email: v.optional(v.string()),
  avatarUrl: v.optional(v.string()),
})
  .index("by_user", ["userId"])
  .index("by_account", ["accountId"])
  .index("by_user_account", ["userId", "accountId"]),
```
- [ ] **Step 2: Failing test** — `accounts.test.ts`: signing in a new user then calling `bootstrapAccount` creates exactly one account + one `owner` membership; calling it twice does not duplicate.
- [ ] **Step 3: Run → fail.**
- [ ] **Step 4: Implement** — `convex/accounts.ts`:
```ts
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";

export const bootstrapAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
    const existing = await ctx.db.query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId)).first();
    if (existing) return existing.accountId;
    const user = await ctx.db.get(userId);
    const accountId = await ctx.db.insert("accounts", {
      name: user?.email ?? "My account",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId, accountId, role: "owner",
      fullName: user?.name, email: user?.email,
    });
    return accountId;
  },
});

export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const membership = await ctx.db.query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId)).first();
    if (!membership) return null;
    const user = await ctx.db.get(userId);
    return { user, accountId: membership.accountId, role: membership.role };
  },
});
```
- [ ] **Step 5: Run → pass.**
- [ ] **Step 6: Commit** — `feat(convex): accounts + memberships + bootstrap`.

---

### Task 5: The security spine (`accountQuery`/`accountMutation`)

**Files:** Create `convex/lib/auth.ts`, `convex/lib/auth.test.ts`.

**Interfaces:**
- Consumes: `getAuthUserId`, `memberships.by_user`, `hasMinRole`.
- Produces: `accountQuery`, `accountMutation` (custom functions injecting `ctx.userId`, `ctx.accountId`, `ctx.role`, `ctx.requireRole(min)`).

- [ ] **Step 1: Failing test** — `auth.test.ts` (convex-test): an `accountQuery` invoked with no identity throws `UNAUTHENTICATED`; with identity but no membership throws `NO_ACCOUNT`; with membership injects the right `accountId`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement**:
```ts
import { customQuery, customMutation, customCtx } from "convex-helpers/server/customFunctions";
import { query, mutation } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { hasMinRole, type AccountRole } from "./roles";

const withAccount = customCtx(async (ctx) => {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
  const membership = await ctx.db.query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId)).first();
  if (!membership) throw new ConvexError({ code: "NO_ACCOUNT" });
  const role = membership.role as AccountRole;
  return {
    userId,
    accountId: membership.accountId,
    role,
    requireRole: (min: AccountRole) => {
      if (!hasMinRole(role, min)) throw new ConvexError({ code: "FORBIDDEN", min });
    },
  };
});

export const accountQuery = customQuery(query, withAccount);
export const accountMutation = customMutation(mutation, withAccount);
```
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit** — `feat(convex): account-scoped query/mutation wrappers (RLS replacement)`.

---

### Task 6: Contacts + tags schema

**Files:** Modify `convex/schema.ts`.

**Interfaces:**
- Produces: `contacts`, `tags`, `contactTags` tables with `by_account`, `by_account_phone`, tag-join indexes, and a name search index.

- [ ] **Step 1: Schema** — add:
```ts
contacts: defineTable({
  accountId: v.id("accounts"),
  createdByUserId: v.optional(v.id("users")),
  phone: v.string(),
  phoneNormalized: v.string(),          // digits-only; set in mutation
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  company: v.optional(v.string()),
  avatarUrl: v.optional(v.string()),
})
  .index("by_account", ["accountId"])
  .index("by_account_phone", ["accountId", "phoneNormalized"])
  .searchIndex("search_name", { searchField: "name", filterFields: ["accountId"] }),

tags: defineTable({
  accountId: v.id("accounts"),
  name: v.string(),
  color: v.string(),
}).index("by_account", ["accountId"]),

contactTags: defineTable({
  accountId: v.id("accounts"),
  contactId: v.id("contacts"),
  tagId: v.id("tags"),
})
  .index("by_contact", ["contactId"])
  .index("by_tag", ["tagId"])
  .index("by_contact_tag", ["contactId", "tagId"]),
```
- [ ] **Step 2: Verify** — `npx convex dev --once` applies schema without error.
- [ ] **Step 3: Commit** — `feat(convex): contacts/tags/contactTags schema`.

> **Search note:** `search_name` covers name only. Phone/email search is handled in `contacts.list` by a `by_account` scan + `phoneNormalized`/email `startsWith` fallback when the term is numeric/email-like. Revisit with per-field search indexes if scale demands.

---

### Task 7: Contacts functions (TDD, incl. denial test)

**Files:** Create `convex/contacts.ts`, `convex/tags.ts`, `convex/contacts.test.ts`; reuse `src/lib/whatsapp/phone-utils.ts` `normalizePhone` (import or port into `convex/lib/phone.ts`).

**Interfaces:**
- Consumes: `accountQuery`, `accountMutation`, `normalizePhone`.
- Produces:
  - `list({ search?, paginationOpts })` → `{ page, isDone, continueCursor }` of contacts with embedded `tags`.
  - `filterByTags({ tagIds, search?, paginationOpts })` → OR-across-tags, deduped, searched, paged.
  - `create({ phone, name?, email?, company? })` → dedup-checked `Id<"contacts">`.
  - `update`, `remove` (cascades `contactTags`), `assignTag`, `unassignTag`.

- [ ] **Step 1: Failing test — create + dedup** — inserting two contacts with the same normalized phone in one account throws; different accounts is fine.
- [ ] **Step 2: Failing test — cross-account denial** — account A creates a contact; `list`/`get` as account B never returns it.
- [ ] **Step 3: Run → fail.**
- [ ] **Step 4: Implement `create`** (dedup via `by_account_phone`):
```ts
import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import { normalizePhone } from "./lib/phone";

export const create = accountMutation({
  args: { phone: v.string(), name: v.optional(v.string()),
          email: v.optional(v.string()), company: v.optional(v.string()) },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const phoneNormalized = normalizePhone(args.phone);
    const dup = await ctx.db.query("contacts")
      .withIndex("by_account_phone", (q) =>
        q.eq("accountId", ctx.accountId).eq("phoneNormalized", phoneNormalized))
      .first();
    if (dup) throw new ConvexError({ code: "DUPLICATE_PHONE", contactId: dup._id });
    return await ctx.db.insert("contacts", {
      accountId: ctx.accountId, createdByUserId: ctx.userId,
      phone: args.phone, phoneNormalized,
      name: args.name, email: args.email, company: args.company,
    });
  },
});
```
- [ ] **Step 5: Implement `list`** — `by_account` index + optional `search_name`; embed tags via `contactTags.by_contact` → `tags` gets; paginate with `paginationOpts`.
- [ ] **Step 6: Implement `filterByTags`** — for each `tagId`, `contactTags.by_tag`; union contactIds; `ctx.db.get` each; drop nulls and any whose `accountId !== ctx.accountId` (defense-in-depth); apply search; sort by `_creationTime` desc; page.
- [ ] **Step 7: Implement `update`/`remove`/`assignTag`/`unassignTag`** — all `accountMutation`; `remove` deletes the contact's `contactTags` rows first (explicit cascade); every write asserts the target row's `accountId === ctx.accountId`.
- [ ] **Step 8: Run → all pass.**
- [ ] **Step 9: Commit** — `feat(convex): contacts + tags functions with dedup and isolation tests`.

---

### Task 8: Rewire the Contacts UI to Convex

**Files:** Modify `src/app/(dashboard)/contacts/page.tsx`, `src/components/contacts/{contact-form,contact-detail-view,import-modal}.tsx`.

**Interfaces:**
- Consumes: `api.contacts.*`, `api.tags.*` via `useQuery`/`useMutation`.

- [ ] **Step 1 (Next.js-docs-first):** Confirm client-component/data rules in `node_modules/next/dist/docs/`.
- [ ] **Step 2:** Replace the Supabase `createClient().from('contacts')…` and `.rpc('filter_contacts_by_tags')` calls in `contacts/page.tsx` with `useQuery(api.contacts.list, …)` / `useQuery(api.contacts.filterByTags, …)`. Delete the manual refetch/loading dance the reactive query makes unnecessary.
- [ ] **Step 3:** Point `contact-form` create/edit and `contact-detail-view` at `useMutation(api.contacts.create/update/remove)`; map the `DUPLICATE_PHONE` `ConvexError` to the existing toast (reuse `isUniqueViolation` semantics).
- [ ] **Step 4:** Point `import-modal` at `api.contacts.create` in a loop (or a batch mutation) reusing the existing `parseContactCsv`/`dedupeByPhone` helpers.
- [ ] **Step 5: Verify (Preview):** Start dev, sign up (creates account via `bootstrapAccount`), add/search/tag-filter/delete contacts; confirm updates appear **without manual refresh** (reactive). Confirm a second account cannot see the first's contacts.
- [ ] **Step 6: Commit** — `feat(convex): contacts UI on convex (reactive)`.

---

## Exit Gate (Phase 0 done when ALL true)

- [ ] Sign-up/sign-in via Convex Auth works; first sign-in bootstraps an account + owner membership.
- [ ] Contacts CRUD + tag-filter + search work from the UI, reactively (no manual refetch).
- [ ] Phone dedup enforced (duplicate within account rejected; across accounts allowed).
- [ ] **Cross-account denial test is green** for contacts (the isolation pattern is proven).
- [ ] `npx vitest run` green; `npm run build` clean; `convex/_generated/` committed.
- [ ] Supabase still powers the rest of the app (hybrid) — nothing merged to `main`.

## Self-Review (run before handing off)
1. **Coverage:** contacts list/search/tag-filter/create/update/delete/dedup + auth bootstrap + isolation — all have tasks. ✅
2. **Placeholders:** none — Next.js glue steps are "read local docs then implement," which is the mandated correctness path, not a TODO.
3. **Type consistency:** `accountId`/`role`/`requireRole` names match across `lib/auth.ts`, `accounts.ts`, `contacts.ts`. ✅
