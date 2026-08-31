# PWA Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the installed PWA from demanding a password on every cold start, by writing persistent auth cookies backed by a 30-day sliding / 1-year absolute session, plus a kill switch for a lost device.

**Architecture:** Three independent surfaces. A single shared constants module fixes the cookie lifetime and the refresh-token lifetime to the same number so they cannot drift. `src/middleware.ts` passes that number to Convex Auth's `cookieConfig`, turning the two session cookies into persistent ones. `convex/auth.ts` widens the absolute session cap so an active user is never interrupted. A new `convex/sessions.ts` action wraps the library's `invalidateSessions` so a user can evict every other device from Settings.

**Tech Stack:** Next.js 16 (App Router, edge middleware), Convex 1.42 + `@convex-dev/auth` 0.0.94, React 19, vitest + convex-test, next-intl.

**Design spec:** [`docs/superpowers/specs/2026-07-30-pwa-session-persistence-design.md`](../specs/2026-07-30-pwa-session-persistence-design.md)

## Global Constraints

- **NEVER run `git add .`, `git add -A`, or `git commit -a`.** A concurrent session has ~59 unrelated modified files in this shared working tree (a typography sweep). Stage only the exact paths listed in each task's commit step.
- **NEVER run `npx convex deploy`, `npx convex dev`, or `npx convex codegen`.** Repo standing rule, owner-reaffirmed. Tasks 3 and 4 are inert until the owner deploys; say so, do not deploy.
- **Do not `git checkout`/`switch` branches** unless the executing session confirms the concurrent work is committed or stashed. The spec file from brainstorming is intentionally left uncommitted for the same reason.
- Scope lint to changed files: `npx eslint <paths>`, never a bare `npm run lint`.
- Cookie `maxAge` (seconds) MUST equal `inactiveDurationMs / 1000`. Task 1 makes this structural; do not reintroduce a second literal.
- Convex tests run under the `convex` vitest project (`edge-runtime` environment); `src` tests run under `node`. Target a single file with `npx vitest run <path>`.
- Commit messages follow the repo's conventional-commit style (`feat(auth): …`, `fix(auth): …`).

---

### Task 1: Shared session-duration constants

The cookie lifetime and the refresh-token lifetime must be the same number. Putting them in two files invites drift, and drift here is silent: a cookie shorter than the token logs users out early, a cookie longer presents a dead token. One module, one literal, everything else derived.

**Files:**
- Create: `convex/lib/sessionDuration.ts`
- Test: `convex/lib/sessionDuration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SESSION_INACTIVE_DURATION_MS: number` — sliding refresh-token window, milliseconds.
  - `SESSION_TOTAL_DURATION_MS: number` — absolute session cap, milliseconds.
  - `SESSION_COOKIE_MAX_AGE_SECONDS: number` — cookie `Max-Age`, seconds, derived from `SESSION_INACTIVE_DURATION_MS`.

This module holds only plain constants — no `convex/_generated` imports, no Convex runtime — so `src/middleware.ts` can import it from the Next.js edge bundle in Task 2. Do not add Convex imports to it.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/sessionDuration.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SESSION_INACTIVE_DURATION_MS,
  SESSION_TOTAL_DURATION_MS,
} from "./sessionDuration";

const DAY_MS = 1000 * 60 * 60 * 24;

test("the sliding window is 30 days and the absolute cap is a year", () => {
  expect(SESSION_INACTIVE_DURATION_MS).toBe(30 * DAY_MS);
  expect(SESSION_TOTAL_DURATION_MS).toBe(365 * DAY_MS);
});

test("the absolute cap exceeds the sliding window", () => {
  // If the cap were the shorter of the two it would silently truncate
  // the sliding window, and users would be signed out on a schedule
  // nothing in the cookie layer explains.
  expect(SESSION_TOTAL_DURATION_MS).toBeGreaterThan(
    SESSION_INACTIVE_DURATION_MS,
  );
});

test("the cookie Max-Age matches the refresh-token window exactly", () => {
  // A cookie shorter than its refresh token logs the user out while the
  // server-side session is still valid — the exact bug this work fixes.
  // A longer one presents a token the server has already expired.
  expect(SESSION_COOKIE_MAX_AGE_SECONDS * 1000).toBe(
    SESSION_INACTIVE_DURATION_MS,
  );
});

test("the cookie Max-Age is a positive integer", () => {
  // `Set-Cookie: Max-Age=` must be an integer number of seconds; a
  // fractional value is not a valid cookie attribute.
  expect(Number.isInteger(SESSION_COOKIE_MAX_AGE_SECONDS)).toBe(true);
  expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/sessionDuration.test.ts`
Expected: FAIL — `Failed to resolve import "./sessionDuration"`.

- [ ] **Step 3: Write minimal implementation**

Create `convex/lib/sessionDuration.ts`:

```ts
// Session lifetimes, in one place because two of them must agree.
//
// Convex Auth exposes two clocks that behave differently
// (see docs/superpowers/specs/2026-07-30-pwa-session-persistence-design.md):
//
//   inactiveDurationMs — the refresh token's lifetime. Re-stamped on
//     every rotation, so it SLIDES forward with use.
//   totalDurationMs    — written into the session row once at sign-in
//     and never revisited, so it is an ABSOLUTE ceiling.
//
// Net policy: open the app at least once a month and you are never
// asked to sign in; a full re-authentication is forced once a year.

const DAY_MS = 1000 * 60 * 60 * 24;

/** Sliding window — this much inactivity ends the session. */
export const SESSION_INACTIVE_DURATION_MS = 30 * DAY_MS;

/** Absolute ceiling from sign-in, however active the user is. */
export const SESSION_TOTAL_DURATION_MS = 365 * DAY_MS;

/**
 * `Max-Age` for the two Convex Auth cookies, in seconds.
 *
 * Derived — never write this as its own literal. The cookie and the
 * refresh token are stamped at the same instant on every rotation, so
 * equal lifetimes mean the cookie can neither die before the token
 * (premature logout) nor outlive it (a cookie carrying a dead token).
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS =
  SESSION_INACTIVE_DURATION_MS / 1000;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/lib/sessionDuration.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and lint**

```bash
npm run typecheck
npx eslint convex/lib/sessionDuration.ts convex/lib/sessionDuration.test.ts
```

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/sessionDuration.ts convex/lib/sessionDuration.test.ts
git commit -m "feat(auth): single source of truth for session lifetimes"
```

---

### Task 2: Persist the auth cookies

This is the task that actually fixes the reported bug, and it ships on its own via the normal Netlify build from `main` — no Convex deploy needed. Until Task 3 is deployed the absolute cap stays at the library default of 30 days, which is still a large improvement over being signed out on every app close.

**Files:**
- Modify: `src/middleware.ts:32` (the `convexAuthNextjsMiddleware` call) and its import block

**Interfaces:**
- Consumes: `SESSION_COOKIE_MAX_AGE_SECONDS` from Task 1.
- Produces: nothing importable.

**Background for the implementer:** `convexAuthNextjsMiddleware(handler, options)` defaults `options.cookieConfig` to `{ maxAge: null }`, which `getCookieOptions` turns into `maxAge: undefined` (`node_modules/@convex-dev/auth/dist/nextjs/server/cookies.js:71-81`). A `Set-Cookie` with neither `Max-Age` nor `Expires` is a session cookie, which a standalone PWA loses when the OS tears the app down. The handler body is not changing — only the second argument to the factory.

- [ ] **Step 1: Add the import**

In `src/middleware.ts`, add below the existing `next/server` import:

```ts
import { SESSION_COOKIE_MAX_AGE_SECONDS } from "../convex/lib/sessionDuration";
```

The relative path is deliberate: `convex/lib/sessionDuration.ts` is a plain constants module (Task 1), and `src/` already reaches into `convex/` this way for `_generated/api`.

- [ ] **Step 2: Pass the cookie config**

`src/middleware.ts` currently ends the middleware factory call like this:

```ts
  // Protected WhatsApp API while signed out → 401 (not a redirect; these
  // are fetched by client code that expects JSON).
  if (onProtectedApi && !authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
});
```

Replace that closing `});` so the factory receives a second argument:

```ts
  // Protected WhatsApp API while signed out → 401 (not a redirect; these
  // are fetched by client code that expects JSON).
  if (onProtectedApi && !authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
},
  {
    // Without this, Convex Auth defaults to `{ maxAge: null }` and writes
    // `__Host-__convexAuthJWT` / `__Host-__convexAuthRefreshToken` as
    // SESSION cookies — which a standalone PWA discards the moment iOS or
    // Android tears the app down, so every cold start landed on /login
    // even though the server-side session was still perfectly valid.
    //
    // Re-stamped on every token refresh (the 1-hour JWT refreshes when it
    // comes within a minute of expiry), so the window slides forward under
    // normal use rather than counting down from first sign-in.
    cookieConfig: { maxAge: SESSION_COOKIE_MAX_AGE_SECONDS },
  },
);
```

- [ ] **Step 3: Typecheck and lint**

```bash
npm run typecheck
npx eslint src/middleware.ts
```

Expected: both clean. A type error on `cookieConfig` means the argument landed inside the handler rather than beside it — check the brace placement in Step 2.

- [ ] **Step 4: Verify the real `Set-Cookie` header**

Cookie behaviour is not meaningfully unit-testable; verify it against a running server.

Start the dev server with the `preview_start` tool (never `npm run dev` in Bash) and sign in. Then find the sign-in request with `read_network_requests` (URL pattern `/api/auth`) and read its response headers.

Do not try to verify via `document.cookie` in the page console — these cookies are `httpOnly` and will never appear there. The `Set-Cookie` response header is the only place the attribute is visible.

Expected: the `Set-Cookie` headers for both `__convexAuthJWT` and `__convexAuthRefreshToken` now carry `Max-Age=2592000` (30 days in seconds). Before this change neither had a `Max-Age` attribute at all. On localhost the `__Host-` prefix is absent by design — see `cookies.js:21-25`.

- [ ] **Step 5: Commit**

```bash
git add src/middleware.ts
git commit -m "fix(auth): persist auth cookies so the PWA survives app restarts"
```

---

### Task 3: Widen the session lifetime policy

**Files:**
- Modify: `convex/auth.ts:7` (the `convexAuth({...})` call) and its import block

**Interfaces:**
- Consumes: `SESSION_INACTIVE_DURATION_MS`, `SESSION_TOTAL_DURATION_MS` from Task 1.
- Produces: nothing new — the existing `auth, signIn, signOut, store, isAuthenticated` exports are unchanged.

**Background for the implementer:** without a `session` block, `createSession` stamps `expirationTime` at 30 days from sign-in and never revisits it (`node_modules/@convex-dev/auth/dist/server/implementation/sessions.js:40-47`), forcing a re-login every 30 days no matter how heavily the app is used. This does not touch the `providers` array.

- [ ] **Step 1: Add the import**

In `convex/auth.ts`, add below the existing `convex/values` import:

```ts
import {
  SESSION_INACTIVE_DURATION_MS,
  SESSION_TOTAL_DURATION_MS,
} from "./lib/sessionDuration";
```

- [ ] **Step 2: Add the session block**

`convex/auth.ts` currently opens the call as:

```ts
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
```

Insert the `session` block before `providers` (leave everything inside `providers` exactly as it is):

```ts
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  // Two clocks, deliberately different — see
  // convex/lib/sessionDuration.ts for why they are defined together.
  //
  // `totalDurationMs` is written into the session row at creation and
  // never revisited, so this governs only sessions created AFTER this
  // is deployed. Existing sessions keep their 30-day expiry and roll
  // over on their own — no migration needed.
  session: {
    inactiveDurationMs: SESSION_INACTIVE_DURATION_MS,
    totalDurationMs: SESSION_TOTAL_DURATION_MS,
  },
  providers: [
```

- [ ] **Step 3: Confirm no existing test regressed**

Run: `npx vitest run convex/accounts.test.ts`
Expected: PASS. This suite exercises the auth identity plumbing (`t.withIdentity({ subject: \`${userId}|<session>\` })`) and is the cheapest signal that `convex/auth.ts` still loads cleanly under convex-test.

- [ ] **Step 4: Typecheck and lint**

```bash
npm run typecheck
npx eslint convex/auth.ts
```

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add convex/auth.ts
git commit -m "feat(auth): 30-day sliding session with a one-year absolute cap"
```

**Do not deploy.** This change has no effect until the owner runs a Convex deploy from a clean `origin/main` worktree. Note that in the handoff.

---

### Task 4: `signOutOtherDevices` action

**Files:**
- Create: `convex/sessions.ts`
- Test: `convex/sessions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `api.sessions.signOutOtherDevices` — a public action, `args: {}`, returns `null`. Throws `ConvexError({ code: "UNAUTHENTICATED" })` when there is no caller identity. Task 5 calls it via `useAction`.

**Background for the implementer, two points that will otherwise look wrong:**

1. **It is an `action`, not a `mutation`.** `invalidateSessions` dispatches through `ctx.runMutation("auth:store", …)` (`node_modules/@convex-dev/auth/dist/server/implementation/mutations/invalidateSessions.js:8-15`) and its signature demands a `GenericActionCtx`. A mutation cannot call it.

2. **It deliberately does NOT use `accountQuery`/`accountMutation`** from `convex/lib/auth.ts`, the tenant-security spine every other module uses. Two reasons: this operates on the caller's own *user* identity rather than on any account-scoped data, so there is nothing to scope; and `withAccount` needs `ctx.db`, which actions do not have. The explicit `getAuthUserId` null check below is the equivalent guard.

- [ ] **Step 1: Write the failing test**

Create `convex/sessions.test.ts`:

```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

// Convex function modules for convex-test to resolve `api.*` references
// against (mirrors every other convex/*.test.ts suite).
const modules = import.meta.glob("./**/*.ts");

const HOUR_MS = 1000 * 60 * 60;

/**
 * Seeds one user with two live sessions — a phone and a laptop — plus a
 * refresh token on the phone session, so the test can prove that
 * revoking the phone also tears down its token tree.
 *
 * The session ids must be REAL `authSessions` ids: `invalidateSessions`
 * validates `except` as `v.array(v.id("authSessions"))`, so the fake
 * string session ids used elsewhere in this suite family (e.g.
 * `${userId}|test-session` in accounts.test.ts) would be rejected here.
 */
async function seedTwoDevices(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Sarah",
      email: "sarah@example.com",
    });
    const phoneSessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + HOUR_MS,
    });
    const laptopSessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + HOUR_MS,
    });
    await ctx.db.insert("authRefreshTokens", {
      sessionId: phoneSessionId,
      expirationTime: Date.now() + HOUR_MS,
    });
    return { userId, phoneSessionId, laptopSessionId };
  });
}

test("revokes every other session and keeps the caller's own", async () => {
  const t = convexTest(schema, modules);
  const { userId, phoneSessionId, laptopSessionId } = await seedTwoDevices(t);

  const asLaptop = t.withIdentity({ subject: `${userId}|${laptopSessionId}` });
  await asLaptop.action(api.sessions.signOutOtherDevices, {});

  await t.run(async (ctx) => {
    expect(await ctx.db.get(laptopSessionId)).not.toBeNull();
    expect(await ctx.db.get(phoneSessionId)).toBeNull();
  });
});

test("tears down the revoked session's refresh tokens", async () => {
  const t = convexTest(schema, modules);
  const { userId, phoneSessionId, laptopSessionId } = await seedTwoDevices(t);

  const asLaptop = t.withIdentity({ subject: `${userId}|${laptopSessionId}` });
  await asLaptop.action(api.sessions.signOutOtherDevices, {});

  await t.run(async (ctx) => {
    const orphans = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", phoneSessionId))
      .collect();
    // A surviving refresh token would let the revoked device mint a new
    // JWT and walk straight back in.
    expect(orphans).toEqual([]);
  });
});

test("leaves another user's sessions alone", async () => {
  const t = convexTest(schema, modules);
  const { userId, laptopSessionId } = await seedTwoDevices(t);

  const strangerSessionId = await t.run(async (ctx) => {
    const strangerId = await ctx.db.insert("users", {
      name: "Lee",
      email: "lee@example.com",
    });
    return await ctx.db.insert("authSessions", {
      userId: strangerId,
      expirationTime: Date.now() + HOUR_MS,
    });
  });

  const asLaptop = t.withIdentity({ subject: `${userId}|${laptopSessionId}` });
  await asLaptop.action(api.sessions.signOutOtherDevices, {});

  await t.run(async (ctx) => {
    expect(await ctx.db.get(strangerSessionId)).not.toBeNull();
  });
});

test("rejects an unauthenticated caller", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.action(api.sessions.signOutOtherDevices, {}),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/sessions.test.ts`
Expected: FAIL — `api.sessions` does not exist (a TypeScript/resolution error on the `api.sessions.signOutOtherDevices` reference).

- [ ] **Step 3: Write minimal implementation**

Create `convex/sessions.ts`:

```ts
import {
  getAuthSessionId,
  getAuthUserId,
  invalidateSessions,
} from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { action } from "./_generated/server";

/**
 * Signs the caller out of every device EXCEPT the one making the call.
 *
 * This is the recovery path for a lost or stolen phone: sign in on a
 * laptop, press the button, and the phone's session is dead while the
 * laptop keeps working. It is the only such path — Convex Auth does not
 * invalidate existing sessions on password change, so changing the
 * password does not evict a stolen device.
 *
 * Removing a member (`convex/members.ts`) is NOT this: that deletes the
 * membership and moves the user into their own solo account, ending
 * their access to team data while leaving their session intact.
 *
 * An `action`, not a `mutation`, because `invalidateSessions` dispatches
 * through `ctx.runMutation("auth:store", …)` and requires an action ctx.
 *
 * Deliberately not built on `accountMutation` (convex/lib/auth.ts): this
 * is scoped to the caller's own user, not to an account's data, and
 * `withAccount` needs a `ctx.db` that actions do not have. The
 * `getAuthUserId` check below is the equivalent guard.
 */
export const signOutOtherDevices = action({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const sessionId = await getAuthSessionId(ctx);
    if (userId === null || sessionId === null) {
      throw new ConvexError({ code: "UNAUTHENTICATED" });
    }

    await invalidateSessions(ctx, { userId, except: [sessionId] });
    return null;
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/sessions.test.ts`
Expected: PASS, 4 tests.

If `getAuthSessionId(ctx)` fails to typecheck against the action ctx, cast at the call site with a comment explaining that the helper reads only `ctx.auth.getUserIdentity()`, which actions do provide — do not weaken the runtime null check to work around a type.

- [ ] **Step 5: Typecheck and lint**

```bash
npm run typecheck
npx eslint convex/sessions.ts convex/sessions.test.ts
```

Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add convex/sessions.ts convex/sessions.test.ts
git commit -m "feat(auth): add signOutOtherDevices to evict a lost device"
```

**Do not deploy.** Like Task 3, this is inert until the owner deploys.

---

### Task 5: Settings UI for signing out other devices

**Files:**
- Modify: `src/components/settings/profile-form.tsx`
- Modify: `messages/en.json` (the `Settings.profile` object)

**Interfaces:**
- Consumes: `api.sessions.signOutOtherDevices` from Task 4, called through `useAction`.
- Produces: nothing importable.

**Sequencing warning:** this UI calls an action that does not exist on the deployed backend until the owner deploys Task 4. Committing is fine; it must not reach production ahead of that deploy. Flag this in the handoff.

**Pattern to follow:** the confirmation dialog in `src/components/settings/members-tab.tsx:619-662` — a `Dialog` driven by a boolean, `AlertTriangle` in the title, a destructive-styled confirm button with a `Loader2` spinner while pending. Errors surface through `convexErrorMessage` and `toast.error`, exactly as `onSubmit` already does in this file.

- [ ] **Step 1: Add the i18n strings**

In `messages/en.json`, inside `Settings.profile`, add after `"profileSaved": "Profile saved"`:

```json
    "security": "Security",
    "signOutOthers": "Sign out other devices",
    "signOutOthersHint": "Ends your session everywhere except here. Use this if you lose a phone — changing your password will not sign other devices out.",
    "signOutOthersBtn": "Sign out other devices",
    "signOutOthersDialogTitle": "Sign out other devices?",
    "signOutOthersDialogDesc": "Every other phone, tablet, and browser signed in as you will be signed out immediately. This device stays signed in.",
    "signingOutOthers": "Signing out…",
    "signedOutOthers": "Other devices signed out",
    "cancel": "Cancel"
```

Remember to add a comma after `"profileSaved": "Profile saved"`.

- [ ] **Step 2: Add the imports and state**

In `src/components/settings/profile-form.tsx`:

Extend the `lucide-react` import to include `AlertTriangle` and `LogOut`:

```ts
import { Loader2, Upload, Trash2, CircleAlert, AlertTriangle, LogOut } from 'lucide-react';
```

Extend the `convex/react` import to include `useAction`:

```ts
import { useConvex, useMutation, useAction } from 'convex/react';
```

Add the dialog primitives below the existing `Card` import:

```ts
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
```

Inside `ProfileForm`, below `const updateProfile = useMutation(api.accounts.updateProfile);`:

```ts
  const signOutOtherDevices = useAction(api.sessions.signOutOtherDevices);
```

And below `const [saving, setSaving] = useState(false);`:

```ts
  const [signOutOthersOpen, setSignOutOthersOpen] = useState(false);
  const [signingOutOthers, setSigningOutOthers] = useState(false);
```

- [ ] **Step 3: Add the handler**

Below the existing `onSubmit` handler, before `const dirty = …`:

```ts
  const onSignOutOtherDevices = async () => {
    setSigningOutOthers(true);
    try {
      await signOutOtherDevices({});
      setSignOutOthersOpen(false);
      toast.success(t('signedOutOthers'));
    } catch (err) {
      console.error('[ProfileForm] sign out other devices error:', err);
      toast.error(convexErrorMessage(err));
    } finally {
      setSigningOutOthers(false);
    }
  };
```

- [ ] **Step 4: Render the security row and dialog**

In the JSX, insert a security block after the read-only "Account details" block — that is, after the `</div>` that closes `<div className="rounded-lg border border-border bg-muted p-4">` and before the `{!profile && (` guard:

```tsx
          {/* Security — the only way to evict a device you no longer
              hold. Deliberately outside the <form>'s submit path: it
              acts immediately rather than on Save. */}
          <div className="space-y-2 border-t border-border pt-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('security')}
            </p>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-md text-sm text-muted-foreground">
                {t('signOutOthersHint')}
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setSignOutOthersOpen(true)}
                disabled={saving || !profile}
              >
                <LogOut className="size-4" />
                {t('signOutOthers')}
              </Button>
            </div>
          </div>
```

Then add the dialog as a sibling of the `<form>`, immediately before the closing `</section>`:

```tsx
      <Dialog open={signOutOthersOpen} onOpenChange={setSignOutOthersOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              {t('signOutOthersDialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('signOutOthersDialogDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setSignOutOthersOpen(false)}
              disabled={signingOutOthers}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={onSignOutOtherDevices}
              disabled={signingOutOthers}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {signingOutOthers ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('signingOutOthers')}
                </>
              ) : (
                t('signOutOthersBtn')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 5: Typecheck and lint**

```bash
npm run typecheck
npx eslint src/components/settings/profile-form.tsx
```

Expected: both clean.

If `api.sessions` does not resolve, do NOT run `convex codegen` — it is forbidden by the repo's standing rule. `convex/_generated/api.d.ts` is a *static* generated index: it carries an explicit `import type * as sessions from "../sessions.js";` line and a matching `sessions: typeof sessions;` entry in `fullApi`. It does not derive the module list from filenames. Task 4 hand-registered both lines in commit `c59e164`, following the in-repo precedent set by `d43f915` ("chore(convex): register lib/notes modules in the generated api"). If the type is missing, check that commit is present rather than regenerating anything.

- [ ] **Step 6: Verify it renders**

Start the dev server with `preview_start`, navigate to Settings → Profile, and confirm with `read_page` that the Security row and its button render. Click it and confirm the dialog opens.

The confirm button will fail against a backend that has not been deployed yet — that is expected, and it should surface as a toast error rather than an unhandled rejection. Confirm the toast appears and check `read_console_messages` for unhandled errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/profile-form.tsx messages/en.json
git commit -m "feat(settings): sign out other devices from the profile panel"
```

---

## Handoff notes for the owner

State these plainly when reporting completion:

1. **Deployed automatically:** Tasks 1 and 2 ship with the Netlify build from `main` and fix the PWA logout on their own.
2. **Needs your Convex deploy:** Tasks 3 and 4 are inert until you deploy from a clean `origin/main` worktree. Until then the session cap stays at the library default of 30 days and the Settings button has no backend to reach.
3. **Order matters:** do not release Task 5's UI to production ahead of the Convex deploy, or the button renders against a missing action.
4. **Known gap, unaddressed by design:** Convex Auth does not invalidate sessions on password change. `signOutOtherDevices` is the only way to evict a stolen device.
