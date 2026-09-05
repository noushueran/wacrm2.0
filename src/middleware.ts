import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";
import { NextResponse } from "next/server";
import { SESSION_COOKIE_MAX_AGE_SECONDS } from "../convex/lib/sessionDuration";

// Auth pages — a signed-in user has no business here.
const isAuthPage = createRouteMatcher(["/login", "/signup", "/forgot-password"]);

// Protected app surface — one entry per route segment under
// `src/app/(dashboard)`, the signed-in app. `(.*)` also covers each
// section's nested routes.
//
// Exported because this list drifted away from the directory once and
// nothing noticed: seven segments were added under `(dashboard)` without
// being added here, and production answered 200 to an anonymous GET on
// every one of them (/agents, /campaigns, /flows, /lead-analysis,
// /leads, /notifications, /reports — measured 2026-09-05). The pages
// rendered their shell to a stranger; no test, type or lint rule
// objected. `middleware.test.ts` now checks this list against the actual
// directory listing, so the next route added has to be listed here too.
export const PROTECTED_ROUTE_PATTERNS = [
  "/agents(.*)",
  "/automations(.*)",
  "/broadcasts(.*)",
  "/campaigns(.*)",
  "/contacts(.*)",
  "/dashboard(.*)",
  "/flows(.*)",
  "/inbox(.*)",
  "/lead-analysis(.*)",
  "/leads(.*)",
  "/notifications(.*)",
  "/pipelines(.*)",
  "/reports(.*)",
  "/settings(.*)",
  // The Web Share Target landing page. Not optional: it lives under
  // `(dashboard)` and so renders the app shell, and without this an
  // unauthenticated share got a 200 and a flash of chrome before the
  // client-side guard bounced it.
  "/share(.*)",
];

const isProtectedRoute = createRouteMatcher(PROTECTED_ROUTE_PATTERNS);

/**
 * How long the middleware will wait for Convex to say who the caller is.
 *
 * `convexAuth.isAuthenticated()` is an uncached round trip to the
 * self-hosted Convex backend, and this middleware runs as a Netlify edge
 * function with a hard execution ceiling. An *unbounded* await therefore
 * does not degrade one request — it spends the whole edge budget, and
 * Netlify discards our response in favour of its own "This edge function
 * has crashed / the edge function timed out" page.
 *
 * Measured 2026-09-05, when the backend completed the TLS handshake and
 * then never sent an HTTP response: every route served that Netlify page,
 * `/login` included, so nobody could even reach the sign-in form. The
 * outage was in Convex; the blackout was this await.
 *
 * 2.5s is well clear of a healthy check (single-digit ms) and well under
 * the edge ceiling, so a backend that is merely slow still answers.
 */
const AUTH_CHECK_TIMEOUT_MS = 2_500;

/**
 * `isAuthenticated()`, bounded by the budget above.
 *
 * Fails CLOSED — both a timeout and a rejection count as "not signed in".
 * The alternative, assuming a session we could not confirm, would hand
 * the signed-in app to a stranger every time the backend hiccuped. Being
 * bounced to /login while Convex is down is the honest outcome: the
 * session cannot be verified, and no page in the app can load its data
 * anyway.
 */
async function isAuthenticatedWithin(
  isAuthenticated: () => Promise<boolean>,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      isAuthenticated(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), AUTH_CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Non-webhook WhatsApp API routes that require a session (webhooks are
// authenticated by Meta's signature, not our cookie).
const isProtectedWhatsappApi = createRouteMatcher(["/api/whatsapp/(.*)"]);

// `convexAuthNextjsMiddleware` also transparently proxies the
// `/api/auth` action route (sign-in / sign-out / token refresh) to the
// Convex backend before our handler runs, and refreshes the session
// cookie — replacing the manual Supabase `getUser()` + cookie-rotation
// dance the previous middleware did.
export default convexAuthNextjsMiddleware(async (request, { convexAuth }) => {
  const { pathname } = request.nextUrl;

  const onAuthPage = isAuthPage(request);
  const onProtectedRoute = isProtectedRoute(request);
  const onProtectedApi =
    isProtectedWhatsappApi(request) && !pathname.includes("/webhook");
  const onRoot = pathname === "/";

  // Decide whether the caller's identity can change the outcome BEFORE
  // asking for it. `convexAuth.isAuthenticated()` is an uncached
  // `fetchQuery` to the self-hosted Convex backend — a real network
  // round-trip on every matched request that carries a session cookie,
  // including RSC navigation payloads and any static asset the matcher
  // below still catches. On a route none of the rules above apply to,
  // that round-trip buys nothing.
  //
  // Returning early is safe: `convexAuthNextjsMiddleware` proxies the
  // `/api/auth` action route and refreshes the session cookie BEFORE it
  // invokes this handler, and ports the refreshed cookie onto the
  // response afterwards — so cookie rotation does not depend on us
  // reaching `isAuthenticated()`.
  if (!onAuthPage && !onProtectedRoute && !onProtectedApi && !onRoot) return;

  const authed = await isAuthenticatedWithin(() =>
    convexAuth.isAuthenticated(),
  );

  // The root entry point. Decided here rather than in `app/page.tsx`,
  // which redirected to /dashboard unconditionally and so bounced a
  // signed-out visitor / → /dashboard → /login — three sequential round
  // trips to land on a page one could have reached directly.
  if (onRoot) {
    return nextjsMiddlewareRedirect(request, authed ? "/dashboard" : "/login");
  }

  // Already signed in and on an auth page → send to the app. Preserve the
  // invite deep-link: a forwarded invite opened by an already-signed-in
  // user goes straight to /join/<token> to accept in one click, instead
  // of being dropped on /dashboard.
  if (onAuthPage && authed) {
    const inviteToken = request.nextUrl.searchParams.get("invite");
    if (inviteToken && (pathname === "/login" || pathname === "/signup")) {
      return nextjsMiddlewareRedirect(
        request,
        `/join/${encodeURIComponent(inviteToken)}`,
      );
    }
    return nextjsMiddlewareRedirect(request, "/dashboard");
  }

  // Protected page while signed out → login.
  if (onProtectedRoute && !authed) {
    return nextjsMiddlewareRedirect(request, "/login");
  }

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

export const config = {
  // Run on everything except static assets. This still matches
  // `/api/auth`, which the Convex Auth middleware needs in order to proxy
  // auth actions (no extension, so the exclusions below never catch it).
  //
  // The extension list covers what `public/` actually serves — notably
  // `.js` (the opus recorder worker) and `.webmanifest`/`.json`, which
  // the original list missed, so a signed-in agent fetching the worker
  // triggered an auth round-trip to Convex just to serve a static file.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|js|json|txt|webmanifest|woff|woff2|map)$).*)",
  ],
};
