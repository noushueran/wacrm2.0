import {
  convexAuthNextjsMiddleware,
  createRouteMatcher,
  nextjsMiddlewareRedirect,
} from "@convex-dev/auth/nextjs/server";
import { NextResponse } from "next/server";

// Auth pages — a signed-in user has no business here.
const isAuthPage = createRouteMatcher(["/login", "/signup", "/forgot-password"]);

// Protected app surface — same set the old Supabase middleware guarded
// (`protectedPaths`). `(.*)` also covers each section's nested routes.
const isProtectedRoute = createRouteMatcher([
  "/dashboard(.*)",
  "/inbox(.*)",
  "/contacts(.*)",
  "/pipelines(.*)",
  "/broadcasts(.*)",
  "/automations(.*)",
  "/settings(.*)",
]);

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

  const authed = await convexAuth.isAuthenticated();

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
});

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
