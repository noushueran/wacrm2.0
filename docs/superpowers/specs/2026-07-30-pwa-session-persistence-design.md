# PWA session persistence — stay signed in across app restarts

**Date:** 2026-07-30
**Surface:** `src/middleware.ts`, `convex/auth.ts`, new `convex/sessions.ts`,
`src/components/settings/profile-form.tsx`
**Status:** Approved design, ready for implementation planning

## Problem

Installed as a PWA, the CRM asks for a password again every time the app is
closed and reopened. Agents work from phones all day; being bounced to
`/login` on every cold start makes the installed app feel worse than the
browser tab it replaced.

The cause is **not** an expiring session. It is a cookie that the browser was
never told to keep.

## Root cause

`src/middleware.ts` calls `convexAuthNextjsMiddleware(handler)` with no
options. Convex Auth defaults `cookieConfig` to `{ maxAge: null }`, and
`getCookieOptions` turns that into `maxAge: undefined`:

```js
// node_modules/@convex-dev/auth/dist/nextjs/server/cookies.js:71-81
function getCookieOptions(isLocalhost, cookieConfig) {
  return {
    secure: isLocalhost ? false : true,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: cookieConfig.maxAge ?? undefined,
  };
}
```

A `Set-Cookie` with no `Max-Age` and no `Expires` is a **session cookie**. Both
`__Host-__convexAuthJWT` and `__Host-__convexAuthRefreshToken` are written that
way. When iOS or Android tears down a standalone PWA — swiped away, or simply
evicted under memory pressure while backgrounded — the browsing session ends
and the browser discards both. The next launch presents no cookie, so
`convexAuth.isAuthenticated()` fails and the middleware redirects to `/login`.

The library documents this default plainly:

> `maxAge` is the number of seconds the cookie will be valid for. If this is
> not set, the cookie will be a session cookie.
> — `dist/nextjs/server/index.d.ts:105`

Meanwhile the **server-side session was still valid the whole time**: Convex
Auth defaults to a 30-day session (`sessions.js:4`) with a 30-day refresh-token
window (`refreshTokens.js:2`). The app has been discarding a live 30-day
session because the browser never persisted the ticket to it.

## Two clocks worth distinguishing

Convex Auth exposes two session durations that behave differently. Conflating
them is easy and produces surprising re-logins.

| | `totalDurationMs` | `inactiveDurationMs` |
|---|---|---|
| Governs | Absolute session lifetime | Refresh-token lifetime |
| Stamped | Once, at sign-in | On **every** token rotation |
| Slides with use | **No** | **Yes** |
| Default | 30 days | 30 days |

`createSession` writes `expirationTime` once and never revisits it
(`sessions.js:40-47`), so with the defaults a user is forced to re-authenticate
30 days after sign-in **no matter how heavily they use the app**. Fixing only
the cookie would leave that monthly interruption in place.

## Design

### 1. Persist the auth cookies

`src/middleware.ts` — pass a `cookieConfig` to the middleware factory:

```ts
// 30 days, deliberately equal to `inactiveDurationMs` in convex/auth.ts.
// Without this, Convex Auth writes session cookies, which a standalone
// PWA loses the moment the OS tears the app down.
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export default convexAuthNextjsMiddleware(
  async (request, { convexAuth }) => {
    /* handler body unchanged */
  },
  { cookieConfig: { maxAge: SESSION_COOKIE_MAX_AGE_SECONDS } },
);
```

Cookies are re-written on every token refresh — which happens when the 1-hour
JWT comes within a minute of expiry (`request.js:58-85`) — so each refresh
re-stamps a fresh 30 days and the window slides forward under normal use.

### 2. Session lifetime policy

`convex/auth.ts` — add a `session` block to the `convexAuth({...})` call:

```ts
session: {
  // Sliding: 30 days with no activity at all ends the session.
  inactiveDurationMs: 1000 * 60 * 60 * 24 * 30,
  // Absolute ceiling: one year from sign-in, however active the user is.
  totalDurationMs: 1000 * 60 * 60 * 24 * 365,
},
```

Net behaviour: **open the app at least once a month and you are never asked to
sign in; a full re-authentication is forced once a year.**

**Invariant:** cookie `maxAge` must equal `inactiveDurationMs`. Both are
stamped at the same instant on each rotation, so the cookie can neither die
before the refresh token (premature logout) nor outlive it (a cookie that
presents a dead token).

Configuration lives in `convex/auth.ts` rather than the
`AUTH_SESSION_TOTAL_DURATION_MS` / `AUTH_SESSION_INACTIVE_DURATION_MS`
environment variables that `sessions.js` and `refreshTokens.js` also read.
Both work; the code path keeps the policy reviewable in the repo and immune to
per-deployment env drift.

`totalDurationMs` is written at session creation, so it governs only sessions
created after the deploy. Sessions that already exist keep their 30-day expiry
and roll over naturally. No migration.

### 3. Sign out other devices

A year-long session on a phone needs a kill switch. Member removal does not
serve that purpose: `convex/members.ts:141` deletes the membership and moves
the user into a fresh solo account, so access dies at the authorization layer
while the session itself survives — correct for offboarding, useless for a
stolen handset.

New `convex/sessions.ts`, an **action** (`invalidateSessions` requires an
action ctx — it dispatches through `ctx.runMutation`):

```ts
export const signOutOtherDevices = action({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    const sessionId = await getAuthSessionId(ctx);
    if (userId === null || sessionId === null) {
      throw new ConvexError({ code: "UNAUTHENTICATED" });
    }
    await invalidateSessions(ctx, { userId, except: [sessionId] });
  },
});
```

Using the library's exported `invalidateSessions` rather than hand-deleting
`authSessions` / `authRefreshTokens` rows keeps the token-tree bookkeeping
correct.

**Semantics:** every other device is signed out; the calling device stays. That
matches the recovery flow — sign in on a laptop, press the button, the lost
phone is dead and your laptop session is untouched.

**UI:** a row in Settings → Profile (`src/components/settings/profile-form.tsx`)
with a confirmation dialog and a sonner toast, following the patterns already
in that file.

## Security posture

Persisting a cookie changes only where the browser files it, not what protects
it. Unchanged and still in force:

- **`__Host-` prefix** (non-localhost) — origin-locked, `path=/`, no `Domain`,
  so no subdomain can plant or overwrite it.
- **`httpOnly`** — XSS cannot read the refresh token.
- **`secure`** + **`SameSite=Lax`** — HTTPS-only, CSRF-resistant.
- **1-hour access token** (`tokens.js:8`) — a leaked JWT expires quickly.
- **Refresh-token rotation with reuse detection** — replaying a spent refresh
  token invalidates its entire descendant subtree
  (`invalidateRefreshTokensInSubtree`, `refreshTokens.js:37-64`), so a stolen
  token surfaces as an incident instead of silent persistent access.

An attacker able to read the on-disk cookie jar already controls the device.
The marginal exposure is a lost or stolen phone, which §3 addresses directly.

One gap worth recording rather than fixing here: Convex Auth does **not**
invalidate existing sessions on password change. Changing a password is
therefore not a way to evict a stolen device; `signOutOtherDevices` is.

## Testing

- `convex/sessions.test.ts` (convex-test, following the conventions in the
  sibling `*.test.ts` files): establish two sessions for one user, call
  `signOutOtherDevices`, assert the other session's refresh tokens are gone and
  the calling session survives. Cover the unauthenticated path.
- Cookie behaviour is not meaningfully unit-testable. Verify against the running
  dev server that the `Set-Cookie` response headers for
  `__convexAuthJWT` and `__convexAuthRefreshToken` carry `Max-Age`.
- `npm run typecheck`, plus `npm run lint` scoped to changed files.

## Rollout

The work lands in two independent pieces.

1. **`src/middleware.ts`** ships with the normal Netlify build from `main` and
   on its own resolves the reported problem: sessions survive app close,
   bounded by the existing 30-day absolute cap.
2. **`convex/auth.ts` and `convex/sessions.ts` are inert until Convex is
   deployed.** Per the repo's standing rule, the implementing session must not
   run `convex deploy`; the owner deploys from a clean `origin/main` worktree.
   Until then the lifetime stays 30 days absolute and the Settings button has no
   backend to call — so the UI in §3 must not ship ahead of that deploy.

## Out of scope

- A full active-sessions list with per-device metadata and individual revoke.
  Considered and declined: it needs new schema to record device details at
  sign-in, and the single button covers the actual recovery scenario.
- Biometric or PIN re-lock on app resume.
- Invalidating sessions on password change (recorded above as a known gap).
