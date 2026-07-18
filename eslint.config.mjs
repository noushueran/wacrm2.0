import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored minified opus-recorder encoder worker (served statically).
    "public/opus/**",
    // Nested worktrees each carry their own generated `.next/**` (and
    // other build output) that ESLint would otherwise walk in full —
    // multi-MB chunks across every stale worktree under here, which is
    // what pushes a bare `npm run lint` past its runtime budget.
    ".claude/**",
  ]),
]);

export default eslintConfig;
