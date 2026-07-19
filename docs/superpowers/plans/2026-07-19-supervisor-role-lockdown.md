# Supervisor Role Lockdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict the supervisor role to Inbox, Dashboard, Leads, Contacts, Pipelines, Broadcasts and Campaigns, and enforce that restriction on the Convex backend rather than only hiding it in the UI.

**Architecture:** `canAccessNav` flips from a denylist ("supervisor sees everything except…") to an explicit supervisor allowlist, so pages added in future are private by default. Three Convex reads that currently answer any account member are narrowed: the ones with legitimate non-admin consumers gain a small member-safe variant, and the full-fidelity originals move behind `requireRole("admin")`.

**Tech Stack:** Next.js (App Router), Convex, TypeScript, Vitest + `convex-test`.

**Spec:** [`docs/superpowers/specs/2026-07-19-reply-pacing-and-supervisor-rbac-design.md`](../specs/2026-07-19-reply-pacing-and-supervisor-rbac-design.md) — Part B.

## Global Constraints

- **Deploy Convex before Netlify.** Safe in that direction because supervisors already cannot reach these tabs in the UI, so nothing errors mid-deploy. The reverse order ships UI changes with the guards still off. Merge `origin/main` before every `convex deploy`.
- **`/settings` and `/notifications` MUST stay in the supervisor allowlist.** `bottomNavItems` is filtered by `canAccessNav` (`src/components/layout/sidebar.tsx:336`), so dropping `/settings` would remove supervisors' access to their own Profile and Appearance. `require-section.tsx:16` route-guards on `canAccessRoute`, so dropping `/notifications` would redirect them off their own notifications page.
- **Never gate a query without first checking its consumers.** Three of the four reads here have non-admin callers; gating them blindly breaks the inbox for every agent and viewer.
- No plaintext secret is exposed today — the WhatsApp access token and API key hashes are already withheld. This work protects configuration and prompt content, not credentials. Do not weaken the existing withholding while editing these files.
- This plan touches supervisor permissions only. Agent and viewer behaviour must be byte-identical afterwards.
- Run the full suite with `npm test` before every commit.

---

### Task 1: Nav allowlist and settings sections

Pure policy change, fully unit-testable, no backend involvement.

**Files:**
- Modify: `src/lib/auth/roles.ts:148-214`
- Modify: `src/lib/auth/roles.test.ts:157-183`

**Interfaces:**
- Consumes: nothing
- Produces: `SUPERVISOR_NAV: readonly string[]` exported from `src/lib/auth/roles.ts`; `ADMIN_ONLY_NAV` is **removed**

- [ ] **Step 1: Write the failing test**

In `src/lib/auth/roles.test.ts`, replace the existing test at lines 168-174 (`"canAccessNav gates /campaigns to admin+ only"`) with:

```ts
  it("canAccessNav confines supervisor to its allowlist", () => {
    // Granted
    expect(canAccessNav("supervisor", "/dashboard")).toBe(true);
    expect(canAccessNav("supervisor", "/inbox")).toBe(true);
    expect(canAccessNav("supervisor", "/leads")).toBe(true);
    expect(canAccessNav("supervisor", "/contacts")).toBe(true);
    expect(canAccessNav("supervisor", "/pipelines")).toBe(true);
    expect(canAccessNav("supervisor", "/broadcasts")).toBe(true);
    expect(canAccessNav("supervisor", "/campaigns")).toBe(true);
    // Must stay granted: the sidebar filters the Settings link through
    // canAccessNav, and the route guard uses canAccessRoute.
    expect(canAccessNav("supervisor", "/settings")).toBe(true);
    expect(canAccessNav("supervisor", "/notifications")).toBe(true);

    // Denied
    expect(canAccessNav("supervisor", "/agents")).toBe(false);
    expect(canAccessNav("supervisor", "/automations")).toBe(false);
    expect(canAccessNav("supervisor", "/flows")).toBe(false);
  });

  it("canAccessNav still admits admin and owner everywhere", () => {
    for (const href of ["/agents", "/automations", "/flows", "/campaigns"]) {
      expect(canAccessNav("admin", href)).toBe(true);
      expect(canAccessNav("owner", href)).toBe(true);
    }
  });

  it("canAccessNav leaves agent and viewer untouched", () => {
    expect(canAccessNav("agent", "/inbox")).toBe(true);
    expect(canAccessNav("agent", "/notifications")).toBe(true);
    expect(canAccessNav("agent", "/leads")).toBe(true);
    expect(canAccessNav("agent", "/campaigns")).toBe(false);
    expect(canAccessNav("agent", "/agents")).toBe(false);
    expect(canAccessNav("viewer", "/inbox")).toBe(true);
    expect(canAccessNav("viewer", "/campaigns")).toBe(false);
    expect(canAccessNav("viewer", "/agents")).toBe(false);
  });

  it("canAccessNav matches nested routes to their base section", () => {
    expect(canAccessNav("supervisor", "/contacts/abc123")).toBe(true);
    expect(canAccessNav("supervisor", "/agents/abc123")).toBe(false);
  });

  it("a new unlisted page is private to supervisors by default", () => {
    // The whole point of the allowlist: adding a page must not silently
    // grant it. If this ever fails, someone reintroduced a denylist.
    expect(canAccessNav("supervisor", "/some-future-page")).toBe(false);
    expect(canAccessNav("admin", "/some-future-page")).toBe(true);
  });
```

Then update the two stale assertions in the existing tests:

- Line 165, inside `"canAccessNav gates agent/viewer to inbox + notifications"` — `expect(canAccessNav("supervisor", "/settings")).toBe(true);` is already correct; leave it.
- Line 182, inside `"canAccessSettingsSection: agent/viewer personal-only; supervisor no critical"` — change:

```ts
    expect(canAccessSettingsSection("supervisor", "members")).toBe(false);
```

to:

```ts
    expect(canAccessSettingsSection("supervisor", "members")).toBe(true);
```

And append a dedicated section test after that block:

```ts
  it("canAccessSettingsSection gives supervisor operational tabs only", () => {
    // Granted
    for (const section of [
      "overview",
      "profile",
      "appearance",
      "notifications",
      "templates",
      "quick-replies",
      "fields",
      "deals",
      "members",
    ] as const) {
      expect(canAccessSettingsSection("supervisor", section)).toBe(true);
    }
    // Denied
    for (const section of [
      "whatsapp",
      "api",
      "conversions",
      "qualification",
      "cron",
    ] as const) {
      expect(canAccessSettingsSection("supervisor", section)).toBe(false);
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auth/roles.test.ts`
Expected: FAIL — `canAccessNav("supervisor", "/agents")` returns `true`, and `canAccessNav("supervisor", "/campaigns")` returns `false`

- [ ] **Step 3: Rewrite the nav policy**

In `src/lib/auth/roles.ts`, replace lines 148-166 (from the `/** Top-level nav hrefs. */` comment through the closing brace of `canAccessNav`) with:

```ts
/** Top-level nav hrefs. */
export const AGENT_NAV = ["/inbox", "/notifications", "/leads"] as const;
export const VIEWER_NAV = ["/inbox"] as const;

/**
 * Everything a supervisor may reach. This is an ALLOWLIST, deliberately
 * — it used to be a denylist ("supervisor sees all except campaigns"),
 * which meant every page added to the app became visible to supervisors
 * the moment it shipped. Adding an entry here must be a conscious act.
 *
 * `/settings` and `/notifications` are load-bearing and must not be
 * removed: `sidebar.tsx` filters the Settings link through
 * `canAccessNav`, and `require-section.tsx` route-guards on
 * `canAccessRoute`. Dropping them would cost supervisors their own
 * profile page and their own notifications. The settings page gates its
 * individual tabs separately via `canAccessSettingsSection`.
 */
export const SUPERVISOR_NAV = [
  "/dashboard",
  "/inbox",
  "/notifications",
  "/leads",
  "/contacts",
  "/pipelines",
  "/broadcasts",
  "/campaigns",
  "/settings",
] as const;

export function canAccessNav(role: AccountRole, href: string): boolean {
  // Match the concrete href or a nested route under it.
  const base = "/" + (href.split("/")[1] ?? "");
  if (hasMinRole(role, "admin")) return true; // admin/owner: all
  if (role === "supervisor") {
    return (SUPERVISOR_NAV as readonly string[]).includes(base);
  }
  if (role === "agent") return (AGENT_NAV as readonly string[]).includes(base);
  if (role === "viewer") return (VIEWER_NAV as readonly string[]).includes(base);
  return false;
}
```

- [ ] **Step 4: Grant the members settings tab**

In `src/lib/auth/roles.ts`, line 204 currently reads:

```ts
const CRITICAL_SECTIONS: SettingsSectionKey[] = ["whatsapp", "api", "members", "conversions", "qualification", "cron"];
```

Replace with:

```ts
// `members` is NOT here: a supervisor may see the roster, but every
// members mutation is independently `requireRole("admin")`-gated, so
// they cannot invite, remove, or change anyone's role.
// `qualification` IS here — it configures the AI agent's question flow,
// which supervisors are deliberately kept out of.
const CRITICAL_SECTIONS: SettingsSectionKey[] = [
  "whatsapp",
  "api",
  "conversions",
  "qualification",
  "cron",
];
```

- [ ] **Step 5: Remove the now-dead ADMIN_ONLY_NAV**

`ADMIN_ONLY_NAV` no longer has a reader — `canAccessNav` was its only consumer. Confirm and delete:

Run: `grep -rn "ADMIN_ONLY_NAV" src/ convex/`
Expected: only the declaration in `src/lib/auth/roles.ts`. Delete that declaration and its comment. If grep shows any other consumer, update it to use `SUPERVISOR_NAV` instead and note it in the commit message.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/auth/roles.ts src/lib/auth/roles.test.ts
git commit -m "feat(rbac): confine supervisor nav to an explicit allowlist

Supervisors lose /agents, /automations and /flows; gain /campaigns.
Flipping from denylist to allowlist means pages added later are private
by default instead of silently visible. Grants the members settings tab
(read-only: every members mutation is already admin-gated)."
```

---

### Task 2: Guard `apiKeys.list`

The simplest of the three backend guards — its only consumer is already admin-gated client-side.

**Files:**
- Modify: `convex/apiKeys.ts:101-125`
- Modify: `convex/apiKeys.test.ts`

**Interfaces:**
- Consumes: `ctx.requireRole` (existing `accountQuery` helper)
- Produces: no signature change — `apiKeys.list` keeps its shape and starts throwing `FORBIDDEN` below admin

- [ ] **Step 1: Write the failing test**

Append to `convex/apiKeys.test.ts`:

```ts
test("list throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { asUser: asSupervisor } = await seedTeammate(t, {
    accountId,
    name: "Sup",
    email: "sup@example.com",
    role: "supervisor",
  });

  await expect(
    asSupervisor.query(api.apiKeys.list, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("list still returns keys for an admin", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  await asOwner.mutation(api.apiKeys.create, {
    name: "Test key",
    scopes: ["messages:send"],
  });

  const keys = await asOwner.query(api.apiKeys.list, {});
  expect(keys).toHaveLength(1);
  expect(keys[0]).not.toHaveProperty("keyHash");
});
```

`seedAccountMember` and `seedTeammate` already exist in this suite. `scopes` is validated as `v.array(v.string())` (`convex/apiKeys.ts:68`), so `["messages:send"]` is accepted as-is — no lookup needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/apiKeys.test.ts -t "list throws FORBIDDEN"`
Expected: FAIL — the query resolves instead of rejecting

- [ ] **Step 3: Add the guard**

In `convex/apiKeys.ts`, the `list` handler at line 101 currently begins:

```ts
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    const keys = await ctx.db
```

Insert the guard as the first statement:

```ts
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    // Admin+ only. The key INVENTORY (names, prefixes, scopes, last-used)
    // is itself sensitive even though `keyHash` is withheld below — it
    // maps out the account's integration surface. The sole consumer is
    // the admin-gated API keys settings tab.
    ctx.requireRole("admin");
    const keys = await ctx.db
```

**This deliberately reverses a documented decision.** The comment currently above line 101 reads: *"The roster (name/prefix/scopes/liveness) is not secret — only the key itself is, and it was never stored — so this is open to viewer+."* That reasoning is defensible, but the account owner has explicitly asked for API keys to be hidden from supervisors. Replace that comment rather than leaving it contradicting the new guard:

```ts
/**
 * Admin+ lists the caller's own account's API keys, newest-first.
 *
 * This was previously open to viewer+, on the reasoning that the roster
 * (name/prefix/scopes/liveness) is not itself secret — the key is, and
 * it was never stored. That reasoning still holds technically, but the
 * account owner requires API keys hidden from supervisors and below, so
 * the roster is now admin-only. `keyHash` remains explicitly unselected
 * below regardless.
 */

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add convex/apiKeys.ts convex/apiKeys.test.ts
git commit -m "fix(rbac): require admin to list API keys

The UI already hid this tab below admin, but the query answered any
account member. Key hashes were never exposed; the inventory was."
```

---

### Task 3: Split `aiConfig.get` from the system prompt

The inbox legitimately needs to know whether AI is live. It does not need the agent's prompt.

**Files:**
- Modify: `convex/aiConfig.ts:40-71`
- Modify: `convex/aiConfig.test.ts`
- Modify: `src/app/(dashboard)/agents/page.tsx:42`
- Modify: `src/components/settings/ai-config.tsx:73`
- Modify: `src/lib/convex/adapters.ts` (the `aiConfig.get` shape comment and mapper near line 688)

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `api.aiConfig.get` — **narrowed**, now returns `{ provider, model, isActive, autoReplyEnabled, hasKey, hasEmbeddingsKey } | null`. `systemPrompt` is gone.
  - `api.aiConfig.getFull` — **new**, admin-only, returns the above **plus** `systemPrompt: string | null`.

- [ ] **Step 1: Write the failing test**

Append to `convex/aiConfig.test.ts`:

```ts
test("get never exposes the system prompt to any member", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  await asOwner.mutation(api.aiConfig.upsert, {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-test-key",
    systemPrompt: "SECRET BUSINESS PROMPT",
    isActive: true,
    autoReplyEnabled: true,
  });

  const { asUser: asSupervisor } = await seedTeammate(t, {
    accountId,
    name: "Sup",
    email: "sup@example.com",
    role: "supervisor",
  });

  const config = await asSupervisor.query(api.aiConfig.get, {});
  expect(config).not.toBeNull();
  // The inbox banner's needs are still met...
  expect(config?.isActive).toBe(true);
  expect(config?.autoReplyEnabled).toBe(true);
  expect(config?.hasKey).toBe(true);
  // ...but the prompt is not part of the payload at all.
  expect(config).not.toHaveProperty("systemPrompt");
});

test("getFull returns the system prompt to an admin", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  await asOwner.mutation(api.aiConfig.upsert, {
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-test-key",
    systemPrompt: "SECRET BUSINESS PROMPT",
    isActive: true,
    autoReplyEnabled: true,
  });

  const config = await asOwner.query(api.aiConfig.getFull, {});
  expect(config?.systemPrompt).toBe("SECRET BUSINESS PROMPT");
});

test("getFull throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { asUser: asSupervisor } = await seedTeammate(t, {
    accountId,
    name: "Sup",
    email: "sup@example.com",
    role: "supervisor",
  });

  await expect(
    asSupervisor.query(api.aiConfig.getFull, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});
```

**Note for the implementer:** match the exact `upsert` argument shape used by the existing tests in this suite — `provider`/`model`/`apiKey`/`isActive`/`autoReplyEnabled` are required, and the provider/model values must satisfy `providerValidator`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/aiConfig.test.ts -t "system prompt"`
Expected: FAIL — `get` still returns `systemPrompt`, and `getFull` is undefined

- [ ] **Step 3: Narrow `get` and add `getFull`**

In `convex/aiConfig.ts`, replace the whole `get` export (lines 52-71) with:

```ts
export const get = accountQuery({
  args: {},
  handler: async (ctx) => {
    const config = await ctx.db
      .query("aiConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
    if (!config) return null;

    return {
      provider: config.provider,
      model: config.model,
      isActive: config.isActive,
      autoReplyEnabled: config.autoReplyEnabled,
      hasKey: !!config.apiKey,
      hasEmbeddingsKey: !!config.embeddingsApiKey,
      // `systemPrompt` deliberately omitted — see `getFull` below.
    };
  },
});

/**
 * Admin+ view of the same row, including `systemPrompt`. Split from
 * `get` because the inbox's AI banner needs `isActive`/`autoReplyEnabled`
 * for EVERY member, while the prompt itself is the business's own
 * behaviour engineering and belongs with the other admin-only settings.
 *
 * The encrypted `apiKey`/`embeddingsApiKey` columns are still never
 * selected here — only the `hasKey`/`hasEmbeddingsKey` booleans, exactly
 * as in `get`.
 */
export const getFull = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const config = await ctx.db
      .query("aiConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
    if (!config) return null;

    return {
      provider: config.provider,
      model: config.model,
      systemPrompt: config.systemPrompt ?? null,
      isActive: config.isActive,
      autoReplyEnabled: config.autoReplyEnabled,
      hasKey: !!config.apiKey,
      hasEmbeddingsKey: !!config.embeddingsApiKey,
    };
  },
});
```

Update the doc comment above `get` (lines 40-51) to say that it is the member-safe projection and that `systemPrompt` lives in `getFull`.

- [ ] **Step 4: Point the two prompt-editing consumers at `getFull`**

In `src/app/(dashboard)/agents/page.tsx`, line 42:

```ts
  const configDoc = useQuery(api.aiConfig.get);
```

becomes:

```ts
  const configDoc = useQuery(api.aiConfig.getFull);
```

In `src/components/settings/ai-config.tsx`, line 73: make the identical substitution.

Leave `src/components/inbox/ai-thread-banner.tsx:59` on `api.aiConfig.get` — it reads only `isActive` and `autoReplyEnabled`, which the narrowed query still provides.

- [ ] **Step 5: Update the adapter**

In `src/lib/convex/adapters.ts` near line 688, the comment and mapper describing `aiConfig.get`'s return shape must reflect the split. If the mapper reads `systemPrompt`, retarget that mapper at `getFull`'s shape and leave the `get` mapper without the field.

Run: `npx tsc --noEmit`
Expected: no errors. Any error here names a consumer that still expects `systemPrompt` from `get` — fix that consumer, do not re-add the field.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add convex/aiConfig.ts convex/aiConfig.test.ts src/app/\(dashboard\)/agents/page.tsx src/components/settings/ai-config.tsx src/lib/convex/adapters.ts
git commit -m "fix(rbac): keep the AI system prompt out of the member-facing config query

aiConfig.get is the inbox banner's isActive/autoReplyEnabled probe and
stays open to members, minus the prompt. New admin-only getFull serves
the settings form and the agents page."
```

---

### Task 4: Add a member-safe WhatsApp connection query

`whatsappConfig.get` returns the entire raw row. Two non-admin surfaces need two fields between them. Give them exactly those.

**Files:**
- Modify: `convex/whatsappConfig.ts:69-77`
- Modify: `convex/whatsappConfig.test.ts`
- Modify: `src/app/(dashboard)/inbox/page.tsx:115-116`

**Interfaces:**
- Consumes: nothing new
- Produces: `api.whatsappConfig.connectionState` — returns `{ status: string | null; isConfigured: boolean }`, readable by any account member. Never null; an account with no config row yields `{ status: null, isConfigured: false }`.

- [ ] **Step 1: Write the failing test**

Append to `convex/whatsappConfig.test.ts`:

```ts
test("connectionState exposes only status and configured-ness", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  await asOwner.mutation(api.whatsappConfig.upsert, {
    phoneNumberId: "123456789",
    wabaId: "987654321",
    accessToken: "EAA-secret-token",
    status: "connected",
  });

  const { asUser: asViewer } = await seedTeammate(t, {
    accountId,
    name: "Vee",
    email: "vee@example.com",
    role: "viewer",
  });

  const state = await asViewer.query(api.whatsappConfig.connectionState, {});
  expect(state).toEqual({ status: "connected", isConfigured: true });
  // The identifiers the raw row carries must not ride along.
  expect(state).not.toHaveProperty("phoneNumberId");
  expect(state).not.toHaveProperty("wabaId");
  expect(state).not.toHaveProperty("accessToken");
});

test("connectionState reports an unconfigured account without throwing", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });

  const state = await asOwner.query(api.whatsappConfig.connectionState, {});
  expect(state).toEqual({ status: null, isConfigured: false });
});
```

**Note for the implementer:** match the exact `upsert` argument shape this suite already uses — copy it from a neighbouring test rather than guessing which fields are required.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/whatsappConfig.test.ts -t connectionState`
Expected: FAIL — `api.whatsappConfig.connectionState` is undefined

- [ ] **Step 3: Add the query**

In `convex/whatsappConfig.ts`, insert immediately **after** the existing `get` export (which ends at line 77):

```ts
/**
 * Member-safe connection state. `get` above returns the FULL raw row —
 * phone number id, WABA id, verify token, encrypted access token — which
 * is far more than the two non-admin surfaces that read it actually
 * need: the inbox wants "are we connected?", and the settings overview
 * tile wants "is this set up at all?".
 *
 * Those two booleans are what this returns, so `get` can be gated to
 * admin without breaking either surface. Never throws for an
 * unconfigured account — absence is a legitimate state to render.
 */
export const connectionState = accountQuery({
  args: {},
  handler: async (ctx) => {
    const config = await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
    return {
      status: config?.status ?? null,
      isConfigured: !!config?.phoneNumberId,
    };
  },
});
```

- [ ] **Step 4: Migrate the inbox**

In `src/app/(dashboard)/inbox/page.tsx`, lines 115-116 currently read:

```ts
  const wa = useQuery(api.whatsappConfig.get);
  const whatsappConnected = wa === undefined ? null : wa?.status === "connected";
```

Replace with:

```ts
  const wa = useQuery(api.whatsappConfig.connectionState);
  const whatsappConnected = wa === undefined ? null : wa.status === "connected";
```

Note the `wa.status` rather than `wa?.status` — `connectionState` never returns null once loaded.

- [ ] **Step 5: Run tests and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors

- [ ] **Step 6: Commit**

```bash
git add convex/whatsappConfig.ts convex/whatsappConfig.test.ts src/app/\(dashboard\)/inbox/page.tsx
git commit -m "feat(rbac): add member-safe whatsappConfig.connectionState

Returns only {status, isConfigured}. Migrates the inbox off the raw-row
query so that query can be gated to admin next."
```

---

### Task 5: Gate the WhatsApp config behind admin

With both non-admin consumers migrated, close the door.

**Files:**
- Modify: `convex/whatsappConfig.ts:69-77` (`get`) and its `connectionStatus` action (near line 719)
- Modify: `convex/whatsappConfig.test.ts`
- Modify: `src/components/settings/settings-overview.tsx:65, 105-106, 128-140`
- Modify: `src/lib/convex/adapters.ts` (the `whatsappConfig.get` shape comment near line 615)

**Interfaces:**
- Consumes: `api.whatsappConfig.connectionState` from Task 4; `canAccessSettingsSection` from Task 1
- Produces: no new exports — `whatsappConfig.get` and `whatsappConfig.connectionStatus` start throwing `FORBIDDEN` below admin

- [ ] **Step 1: Write the failing test**

Append to `convex/whatsappConfig.test.ts`:

```ts
test("get throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { asUser: asSupervisor } = await seedTeammate(t, {
    accountId,
    name: "Sup",
    email: "sup@example.com",
    role: "supervisor",
  });

  await expect(
    asSupervisor.query(api.whatsappConfig.get, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("connectionState remains readable by a supervisor after get is gated", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const { asUser: asSupervisor } = await seedTeammate(t, {
    accountId,
    name: "Sup",
    email: "sup@example.com",
    role: "supervisor",
  });

  await expect(
    asSupervisor.query(api.whatsappConfig.connectionState, {}),
  ).resolves.toEqual({ status: null, isConfigured: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/whatsappConfig.test.ts -t "get throws FORBIDDEN"`
Expected: FAIL — the query resolves instead of rejecting

- [ ] **Step 3: Gate `get`**

In `convex/whatsappConfig.ts`, add the guard as the first statement of `get`'s handler:

```ts
export const get = accountQuery({
  args: {},
  handler: async (ctx) => {
    // Admin+ only: this returns the whole row, including the phone
    // number id, WABA id and verify token. Members who just need
    // connection state use `connectionState` below.
    ctx.requireRole("admin");
    return await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
  },
});
```

- [ ] **Step 4: Gate `connectionStatus`**

`connectionStatus` is a plain `action`, not an `accountQuery`, so it has no `ctx.requireRole`. It already performs its own role assertion — it just asserts the wrong threshold. At `convex/whatsappConfig.ts:730-732` it reads:

```ts
    if (!hasMinRole(context.role, "viewer")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "viewer" });
    }
```

Raise the threshold to admin:

```ts
    // Admin+ only: this performs a live Meta health check against the
    // account's own credentials, and the settings tile it feeds is
    // itself admin-gated. Supervisors and below use `connectionState`.
    if (!hasMinRole(context.role, "admin")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "admin" });
    }
```

No new helper and no import change — `hasMinRole` and `ConvexError` are already in scope in this file.

- [ ] **Step 5: Fix the settings overview**

`src/components/settings/settings-overview.tsx` is rendered for **every** role (the overview section is personal), and it currently calls both gated functions. Three edits:

At line 105, switch to the member-safe query:

```ts
  const whatsappConfigResult = useQuery(api.whatsappConfig.connectionState);
  const whatsappConfigLoading = whatsappConfigResult === undefined;
```

At line 132, the tile subtitle reads `!whatsappConfigResult?.phoneNumberId`. Change it to:

```ts
      subtitle: !whatsappConfigResult?.isConfigured ? (
```

At line 65, the `checkConnectionStatus` action is now admin-only, so it must not be invoked by anyone else. Guard its **call site** (not the `useAction` declaration, which is a hook and must stay unconditional):

```ts
  // Admin-only action: calling it as a supervisor now throws FORBIDDEN.
  const canSeeWhatsapp =
    !!accountRole && canAccessSettingsSection(accountRole, 'whatsapp');
```

and wrap wherever `checkConnectionStatus(...)` is actually invoked in `if (canSeeWhatsapp) { ... }`.

Finally, filter the rail tiles so gated sections do not render at all. Where `tiles` is mapped for render, add:

```ts
    .filter((tile) => !!accountRole && canAccessSettingsSection(accountRole, tile.section))
```

Import `canAccessSettingsSection` from `@/lib/auth/roles` if it is not already imported in this file.

- [ ] **Step 6: Update the adapter comment**

In `src/lib/convex/adapters.ts` near line 615, the comment states that `whatsappConfig.get` returns the FULL raw doc. Amend it to record that `get` is now admin-only and that `connectionState` is the member-facing projection.

- [ ] **Step 7: Run tests and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors

- [ ] **Step 8: Commit**

```bash
git add convex/whatsappConfig.ts convex/whatsappConfig.test.ts src/components/settings/settings-overview.tsx src/lib/convex/adapters.ts
git commit -m "fix(rbac): require admin for the raw WhatsApp config and health check

Both non-admin consumers now read connectionState instead. Settings
overview additionally filters its tiles by section access, so gated
tiles neither render nor query."
```

---

### Task 6: Verification

**Files:** none (verification only)

- [ ] **Step 1: Confirm no ungated read remains**

Run:

```bash
grep -nE "^export const (get|list|overview|listSystemTasks|listRecent|connectionStatus)" \
  convex/aiConfig.ts convex/apiKeys.ts convex/whatsappConfig.ts \
  convex/conversionEvents.ts convex/cronSchedules.ts
```

Then read each hit and confirm it either calls `requireRole("admin")` or is a deliberately member-safe projection (`aiConfig.get`, `whatsappConfig.connectionState`). Anything else is a gap — fix it before proceeding.

- [ ] **Step 2: Deploy the backend first**

```bash
git fetch origin && git merge origin/main
npx convex deploy
```

Backend-before-frontend is required here. It is safe in this direction because supervisors already cannot reach these tabs in the UI, so no live session starts erroring mid-deploy.

- [ ] **Step 3: Deploy the frontend**

Push the branch and let Netlify build, or merge per the repo's normal flow.

- [ ] **Step 4: Click-verify as a real supervisor**

Log in as an account member whose role is `supervisor` and confirm:

- Sidebar shows: Dashboard, Inbox, Leads, Contacts, Pipelines, Broadcasts, Campaigns, Settings
- Sidebar does **not** show: AI Agents, Automations, Flows
- Navigating directly to `/agents` redirects rather than rendering
- Settings rail shows: Overview, Your profile, Appearance, Notifications, Templates, Quick replies, Fields & tags, Deals & currency, Team members
- Settings rail does **not** show: WhatsApp, API keys, Conversions, Lead qualification, Cron schedules
- The Settings Overview page renders without a console error (this is where a missed `FORBIDDEN` would surface)
- Team members tab lists the roster but offers no invite/remove/role controls

- [ ] **Step 5: Regression-check the lower roles**

Log in as an `agent` and confirm the inbox still loads and still shows correct WhatsApp connection state. This is the surface most at risk from Task 4 and Task 5 — a `FORBIDDEN` here means a consumer was missed.

- [ ] **Step 6: Regression-check admin**

Log in as an `admin` or `owner` and confirm the AI agent settings page still loads the system prompt, the WhatsApp settings tab still populates, and the API keys tab still lists keys.
