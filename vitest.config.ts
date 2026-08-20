import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta service, so any
    // 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      // Brand identity — `src/lib/brand.ts` and `convex/lib/brand.ts`
      // throw on a missing value BY DESIGN (a fallback is how one
      // company's CRM ships wearing another's name), so the suites must
      // supply their own. Deliberately a nonsense company: a test that
      // passes only because the value happens to be the real brand is a
      // test that would pass in the wrong deployment too.
      NEXT_PUBLIC_BRAND_NAME: "Testco",
      NEXT_PUBLIC_BRAND_LEGAL_NAME: "Testco Holdings LLC",
      NEXT_PUBLIC_SITE_URL: "https://wa.testco.example",
      NEXT_PUBLIC_BRAND_WEBSITE: "https://testco.example",
      NEXT_PUBLIC_BRAND_EMAIL: "hello@testco.example",
      BRAND_NAME: "Testco",
      BRAND_SITE_URL: "https://wa.testco.example",
    },
    clearMocks: true,
    // Split by directory: `convex/**` runs Convex functions through
    // convex-test, which mocks the Convex backend and requires the
    // V8-isolate-like `edge-runtime` environment (Convex functions run
    // in an edge-like runtime, not plain Node). `src/**` keeps the
    // previous plain "node" environment unchanged.
    projects: [
      {
        extends: true,
        test: {
          name: "src",
          environment: "node",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "convex",
          environment: "edge-runtime",
          include: ["convex/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "scripts",
          environment: "node",
          include: ["scripts/**/*.test.mjs"],
        },
      },
    ],
  },
});
