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
    ],
  },
});
