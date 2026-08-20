import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// `convex/_generated/api.d.ts` is written by `convex codegen`, which the
// owner runs — and which `convex deploy` also runs as a step of its own.
// So the committed copy can sit stale for as long as nobody deploys, and
// nothing complains: the file is types only, and a module missing from
// `fullApi` costs nothing at runtime. `lib/reportStats.ts` shipped that
// way and stayed unregistered until a deploy's codegen step happened to
// rewrite the file and leave the diff sitting in a worktree.
//
// Harmless in that instance, because `reportStats` exports helpers rather
// than Convex functions. Not harmless in general: `api.<module>.<fn>` and
// `internal.<module>.<fn>` are typed FROM this file, so a genuinely
// missing function module makes its call sites fail to type-check for
// reasons that point at the call site rather than at the stale artifact.
//
// This asserts the cheap half of what codegen guarantees — every module
// is present. The opposite drift (a registered module that no longer
// exists) already fails `tsc`, since the import would not resolve.
const CONVEX_DIR = __dirname;

// Codegen does not register these, and they are not function modules:
// `schema.ts` is the data model, `auth.config.ts` is provider config read
// by Convex directly. Verified against a real codegen run — if Convex
// ever excludes more, this list is where that gets recorded.
const NOT_MODULES = new Set(["schema", "auth.config"]);

const modules = readdirSync(CONVEX_DIR, {
  recursive: true,
  withFileTypes: true,
})
  .filter((e) => e.isFile() && e.name.endsWith(".ts"))
  .map((e) =>
    join(e.parentPath, e.name)
      .replace(`${CONVEX_DIR}/`, "")
      .replace(/\.ts$/, ""),
  )
  .filter(
    (m) =>
      !m.startsWith("_generated/") &&
      !m.endsWith(".test") &&
      !NOT_MODULES.has(m),
  );

const api = readFileSync(
  join(CONVEX_DIR, "_generated", "api.d.ts"),
  "utf8",
);

describe("generated api.d.ts", () => {
  it("found modules to check", () => {
    // Guards the guard — a path change that empties this list would make
    // the assertion below vacuously true.
    expect(modules.length).toBeGreaterThan(50);
  });

  it.each(modules)("registers %s", (mod) => {
    // Two references per module, and codegen quotes the `fullApi` key only
    // when the module path contains a slash — `accounts: typeof accounts`
    // but `"lib/reportStats": typeof lib_reportStats`.
    const fullApiKey = mod.includes("/") ? `"${mod}":` : `${mod}:`;
    expect(
      api.includes(`"../${mod}.js"`),
      `${mod}.ts has no import in _generated/api.d.ts — run codegen and commit the result`,
    ).toBe(true);
    expect(
      api.includes(fullApiKey),
      `${mod}.ts is imported but missing from fullApi in _generated/api.d.ts`,
    ).toBe(true);
  });
});
