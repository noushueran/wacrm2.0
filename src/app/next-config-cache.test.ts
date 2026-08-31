import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// Netlify's CDN caches the server-rendered HTML of these routes at its
// edge and SHARES one copy between users — measured against production:
// `age` up to 2494s with a `cache-status` hit on `/automations` and
// `/flows`. That is Netlify's own default behaviour for the Next runtime,
// not something this repo configures, so it cannot be turned off from
// here and holds whether or not any cache header is set.
//
// It is only safe because of one property: every route under
// `(dashboard)` is a client component that fetches its data from Convex
// after hydration, so the server-rendered HTML is identical for everyone
// — a shell and skeletons, carrying nobody's data. Auth is enforced
// separately by `src/middleware.ts`, which runs before the cache is
// consulted (an unauthenticated request to a cached dashboard URL still
// gets a 307 to /login).
//
// The moment someone adds a Server Component under `(dashboard)` that
// awaits per-user data, that HTML becomes user-specific and the edge
// would serve one tenant's page to another. Nothing else in the codebase
// would complain: it would render correctly for the author, in dev, and
// in tests. This is the guard.
const DASHBOARD_DIR = join(__dirname, "(dashboard)");

function pagesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && (e.name === "page.tsx" || e.name === "layout.tsx"))
    .map((e) => join(e.parentPath, e.name));
}

const files = pagesUnder(DASHBOARD_DIR);

/** Server-side, per-request data access. Any of these in a `(dashboard)`
 *  page/layout means its HTML may differ per user. */
const SERVER_DATA_APIS = [
  "fetchQuery",
  "preloadQuery",
  "fetchMutation",
  "cookies(",
  "headers(",
  "draftMode(",
];

describe("(dashboard) routes stay edge-cacheable", () => {
  it("found routes to check", () => {
    // Guards the guard — a path change that empties this list would make
    // every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(files.map((f) => [f.replace(`${__dirname}/`, ""), f]))(
    "%s renders no per-user data on the server",
    (_label, file) => {
      const src = readFileSync(file, "utf8");
      const isClient = /^\s*['"]use client['"]/m.test(src.split("\n").slice(0, 3).join("\n"));
      const serverApis = SERVER_DATA_APIS.filter((api) => src.includes(api));

      // A client component cannot fetch per-user data during SSR, so it is
      // safe by construction. A server component is only safe if it
      // touches none of the per-request APIs above (e.g. a bare
      // `redirect()`, or a layout that only declares metadata).
      if (!isClient) {
        expect(
          serverApis,
          `${file} is a Server Component using ${serverApis.join(", ")}. Its HTML ` +
            `is now per-user, but Netlify's CDN caches this route at its edge and ` +
            `SHARES it across users. Either make it a client component, or give ` +
            `this route a no-store cache header in next.config.ts.`,
        ).toEqual([]);
      }
    },
  );
});
