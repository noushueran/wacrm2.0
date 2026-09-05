import { readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse, type NextFetchEvent } from "next/server";

// --- Scenario knob ----------------------------------------------------------
// `mockAuthed` is what `convexAuth.isAuthenticated()` resolves to. The real
// token/cookie handling lives inside `convexAuthNextjsMiddleware` (exercised
// by Convex Auth's own suite); here we mock the wrapper so we can unit-test
// *our* routing decisions — who gets redirected where — in isolation.
let mockAuthed = false;

// When true, `isAuthenticated()` never settles — the shape of a Convex
// backend that accepts the connection and then goes quiet.
let mockAuthHangs = false;

// When true, `isAuthenticated()` rejects — a backend that answers, badly.
let mockAuthThrows = false;

// How many times the handler asked `isAuthenticated()`. That call is an
// uncached network round-trip to the Convex backend, so "did we ask at
// all?" is a behavior worth asserting, not an implementation detail.
let authCallCount = 0;

vi.mock("@convex-dev/auth/nextjs/server", () => ({
  // Invoke our handler with a mock `convexAuth`, mirroring the real
  // wrapper's fallback of `NextResponse.next()` when the handler returns
  // nothing.
  convexAuthNextjsMiddleware: (
    handler: (
      request: NextRequest,
      ctx: {
        event: unknown;
        convexAuth: {
          isAuthenticated: () => Promise<boolean>;
          getToken: () => Promise<string | undefined>;
        };
      },
    ) => Promise<NextResponse | undefined> | NextResponse | undefined,
  ) => {
    return async (request: NextRequest) => {
      const result = await handler(request, {
        event: {},
        convexAuth: {
          isAuthenticated: async () => {
            authCallCount++;
            if (mockAuthHangs) return new Promise<boolean>(() => {});
            if (mockAuthThrows) throw new Error("convex unreachable");
            return mockAuthed;
          },
          getToken: async () => (mockAuthed ? "token" : undefined),
        },
      });
      return result ?? NextResponse.next();
    };
  },
  // Minimal path-to-regexp stand-in: treats `(.*)` as "any chars" and
  // anchors the whole pathname (so "/login" doesn't match "/login/x").
  createRouteMatcher: (patterns: string[]) => {
    const regexes = patterns.map(
      (p) => new RegExp("^" + p.replace(/\(\.\*\)/g, ".*") + "$"),
    );
    return (request: NextRequest) =>
      regexes.some((re) => re.test(new URL(request.url).pathname));
  },
  nextjsMiddlewareRedirect: (request: NextRequest, route: string) => {
    const url = new URL(request.url);
    const parsed = new URL(route, "http://dummy");
    url.pathname = parsed.pathname;
    url.search = parsed.search;
    return NextResponse.redirect(url);
  },
}));

// Imported after the mock is registered.
const { default: middleware, PROTECTED_ROUTE_PATTERNS } = await import(
  "./middleware"
);

// The default export is typed as `NextMiddleware` (2 args, possibly-null
// result). At runtime our mock ignores the event and always returns a
// response, so pass a dummy event and narrow away null/undefined.
const fakeEvent = {} as unknown as NextFetchEvent;
async function run(url: string) {
  const res = await middleware(new NextRequest(url), fakeEvent);
  if (!res) throw new Error("middleware returned no response");
  return res;
}

beforeEach(() => {
  mockAuthed = false;
  mockAuthHangs = false;
  mockAuthThrows = false;
  authCallCount = 0;
});

afterEach(() => vi.clearAllMocks());

describe("middleware — Convex Auth route gating", () => {
  it("redirects a signed-in user off /login to /dashboard", async () => {
    mockAuthed = true;
    const res = await run("https://app.test/login");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockAuthed = true;
    const res = await run("https://app.test/login?invite=abc123");
    expect(res.headers.get("location")).toContain("/join/abc123");
  });

  it("redirects an unauthenticated user off a protected page to /login", async () => {
    mockAuthed = false;
    const res = await run("https://app.test/dashboard");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockAuthed = true;
    const res = await run("https://app.test/dashboard");
    expect(res.headers.get("location")).toBeNull();
  });

  it("401s an unauthenticated non-webhook WhatsApp API request", async () => {
    mockAuthed = false;
    const res = await run("https://app.test/api/whatsapp/send");
    expect(res.status).toBe(401);
  });

  it("does not 401 the WhatsApp webhook (Meta-authenticated, not cookie)", async () => {
    mockAuthed = false;
    const res = await run("https://app.test/api/whatsapp/webhook");
    expect(res.status).not.toBe(401);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("middleware — root entry point", () => {
  // `/` used to fall through to `app/page.tsx`, which redirected to
  // /dashboard unconditionally — so a signed-out visitor was bounced
  // / -> /dashboard -> /login, paying a full round trip per hop. The
  // decision needs the auth state, which this middleware already has.
  it("sends a signed-out visitor straight to /login, not via /dashboard", async () => {
    mockAuthed = false;
    const res = await run("https://app.test/");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.headers.get("location")).not.toContain("/dashboard");
  });

  it("sends a signed-in visitor to /dashboard", async () => {
    mockAuthed = true;
    const res = await run("https://app.test/");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
  });
});

describe("middleware — skips the auth round-trip when the route cannot need it", () => {
  // `isAuthenticated()` is an uncached `fetchQuery` to the self-hosted
  // Convex backend. Asking before deciding whether the answer is even
  // relevant spends a round trip on routes that will never use it.
  it("does not ask who the caller is for a public route", async () => {
    mockAuthed = false;
    await run("https://app.test/join/some-invite-token");
    expect(authCallCount).toBe(0);
  });

  it("does not ask who the caller is for a static asset the matcher still catches", async () => {
    mockAuthed = false;
    await run("https://app.test/opus/encoderWorker.min.js");
    expect(authCallCount).toBe(0);
  });

  it("still asks on a protected route, where the answer decides the outcome", async () => {
    mockAuthed = true;
    await run("https://app.test/inbox");
    expect(authCallCount).toBe(1);
  });
});

describe("middleware — every signed-in route is actually gated", () => {
  // The matcher list and the `(dashboard)` directory drifted apart once:
  // seven routes were added under `(dashboard)` without being added here,
  // and production answered 200 to an anonymous GET on every one of them
  // (/agents, /campaigns, /flows, /lead-analysis, /leads, /notifications,
  // /reports — measured 2026-09-05). Nothing failed; the pages simply
  // rendered their shell to a stranger. This is the guard.
  const segments = readdirSync(join(__dirname, "app", "(dashboard)"), {
    withFileTypes: true,
  })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
    .map((e) => e.name);

  it("found routes to check", () => {
    // Guards the guard — an empty list would pass every case below.
    expect(segments.length).toBeGreaterThan(10);
  });

  it.each(segments)("/%s is in PROTECTED_ROUTE_PATTERNS", (segment) => {
    expect(
      PROTECTED_ROUTE_PATTERNS,
      `/${segment} lives under (dashboard) — the signed-in app — but no ` +
        `matcher covers it, so middleware serves it to anyone.`,
    ).toContain(`/${segment}(.*)`);
  });

  it.each(segments)("redirects a signed-out visitor off /%s", async (segment) => {
    mockAuthed = false;
    const res = await run(`https://app.test/${segment}`);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });
});

describe("middleware — survives a Convex backend that stops answering", () => {
  // Measured 2026-09-05: `convex-api.holidayys.co` completed the TLS
  // handshake and then never sent an HTTP response. Because this
  // middleware awaited `isAuthenticated()` with no ceiling, it consumed
  // the Netlify edge function's entire execution budget, and Netlify
  // replaced EVERY page — /login included — with its own "This edge
  // function has crashed / the edge function timed out" page. The site
  // was unreachable, and the sign-in form with it.
  it("does not hang on a protected route — sends the visitor to /login", async () => {
    mockAuthHangs = true;
    const res = await run("https://app.test/inbox");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("still serves /login itself", async () => {
    mockAuthHangs = true;
    const res = await run("https://app.test/login");
    expect(res.headers.get("location")).toBeNull();
  });

  it("still resolves the root entry point", async () => {
    mockAuthHangs = true;
    const res = await run("https://app.test/");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });

  it("treats a backend that errors the same as one that is signed out", async () => {
    mockAuthThrows = true;
    const res = await run("https://app.test/inbox");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
  });
});
