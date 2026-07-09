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
  const authed = await convexAuth.isAuthenticated();
  const { pathname } = request.nextUrl;

  // Already signed in and on an auth page → send to the app. Preserve the
  // invite deep-link: a forwarded invite opened by an already-signed-in
  // user goes straight to /join/<token> to accept in one click, instead
  // of being dropped on /dashboard.
  if (isAuthPage(request) && authed) {
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
  if (isProtectedRoute(request) && !authed) {
    return nextjsMiddlewareRedirect(request, "/login");
  }

  // Protected WhatsApp API while signed out → 401 (not a redirect; these
  // are fetched by client code that expects JSON).
  if (
    isProtectedWhatsappApi(request) &&
    !pathname.includes("/webhook") &&
    !authed
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
});

export const config = {
  // Unchanged from the Supabase middleware: run on everything except
  // static assets. This still matches `/api/auth`, which the Convex Auth
  // middleware needs in order to proxy auth actions.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
