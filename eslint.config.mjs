import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/* A Tailwind container query cannot resolve against the element that
 * declares the container: a `<size>/<name>:` variant silently no-ops when
 * `container/<name>` sits on that same element. The full explanation, and
 * the two-element shape that fixes it, is the container-query note at the
 * top of `src/app/globals.css`.
 *
 * These two regexes match a container declaration and a query for the
 * SAME name inside ONE string — which, being one string, means one
 * element. The name is captured and backreferenced, so declaring one
 * container while querying a different, ancestor one stays legal. Both
 * orderings are checked because prettier-plugin-tailwindcss is free to
 * sort the declaration after the query.
 *
 * Class names are spelled without their leading `@` in this file's prose
 * on purpose — Tailwind's automatic source detection scans it, and a
 * complete class name written in a comment gets compiled into the
 * shipped stylesheet as a dead rule. */
const CONTAINER_NAME = String.raw`[\w-]+`;
const QUERY_PREFIX = String.raw`@[\w.%\[\]()-]+`; // @lg, @max-lg, @min-[480px], …
const SELF_REFERENCING_CONTAINER_QUERY = [
  // declaration first, then the query: …container/ib … lg/ib:…
  String.raw`@container\/(${CONTAINER_NAME})(?![\w-])[\s\S]*?${QUERY_PREFIX}\/\1:`,
  // query first, then the declaration: …lg/ib:… container/ib…
  String.raw`${QUERY_PREFIX}\/(${CONTAINER_NAME}):[\s\S]*?@container\/\2(?![\w-])`,
].join("|");

const SELF_REFERENCING_CONTAINER_QUERY_MESSAGE = [
  "A container query can't resolve against the element that declares the container:",
  "`@<size>/<name>:` silently no-ops when `@container/<name>` is on the SAME element.",
  "Split it — outer element declares the container, inner element carries the",
  "`@<size>/<name>:` variants. See the container-query note in src/app/globals.css.",
].join(" ");

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
    // Convex codegen output — hand-maintained to stay byte-identical to
    // what `convex dev`/`deploy` regenerates (see convex-codegen notes),
    // so it must never be edited to satisfy lint. Don't lint it at all.
    "convex/_generated/**",
  ]),
  {
    // The codebase already marks a deliberately-unused binding with a
    // leading underscore — `_id` / `_creationTime` dropped by
    // destructuring, `_init` on a fetch stub that must keep the
    // signature, `_numItems` on a callback that ignores it. That
    // convention was never configured, so ESLint reported thirteen of
    // them as findings. They are not findings: each one is load-bearing
    // punctuation saying "this is unused ON PURPOSE".
    //
    // Configure the convention instead of deleting the bindings, which
    // in most of these cases is not even possible — a positional
    // parameter cannot be removed without shifting the ones after it.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          // `const { _id, ...rest } = doc` is the omit idiom; the point
          // of naming the key is precisely to leave it behind.
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // See SELF_REFERENCING_CONTAINER_QUERY above. Scoped to the UI tree:
    // className strings only ever live here, and nothing outside it can
    // trip the pattern.
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // Plain string literals: className="…", cn("…"), clsx("…").
          selector: `Literal[value=/${SELF_REFERENCING_CONTAINER_QUERY}/]`,
          message: SELF_REFERENCING_CONTAINER_QUERY_MESSAGE,
        },
        {
          // The static chunks of a template literal: className={`…`}.
          selector: `TemplateElement[value.raw=/${SELF_REFERENCING_CONTAINER_QUERY}/]`,
          message: SELF_REFERENCING_CONTAINER_QUERY_MESSAGE,
        },
      ],
    },
  },
]);

export default eslintConfig;
