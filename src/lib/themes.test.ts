import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MODE, MODES } from "./themes";

// The theme system has two halves that must agree and live in different
// files, with nothing in the type system tying them together:
//
//   • `use-theme.tsx` / the `layout.tsx` boot script write the mode to
//     `document.documentElement.dataset.mode` — i.e. `data-mode="dark"`.
//   • `globals.css` declares Tailwind's `dark:` variant via
//     `@custom-variant`, which decides what selector every `dark:`
//     utility in the app compiles to.
//
// They drifted: the variant was keyed to a `.dark` class that nothing has
// ever set, so every `dark:` utility silently compiled to a selector that
// can never match. Nothing caught it — the class strings are still
// emitted (see soft-badge.test.ts), the CSS still compiles, and the app
// still renders, just with every dark-mode colour override inert. The
// only observable symptom was contrast: components rendered their light
// stop on a dark surface.
//
// These tests pin the two halves together so the next edit to either one
// fails loudly instead of silently disabling app-wide theming.
const globalsCss = readFileSync(
  join(process.cwd(), "src/app/globals.css"),
  "utf8",
);

function darkVariantSelector(): string {
  const match = globalsCss.match(/@custom-variant\s+dark\s+\(([\s\S]*?)\);/);
  if (!match) throw new Error("no `@custom-variant dark (...)` in globals.css");
  return match[1];
}

describe("the `dark:` Tailwind variant", () => {
  it("is declared in globals.css", () => {
    expect(() => darkVariantSelector()).not.toThrow();
  });

  it("targets the `data-mode` attribute the theme system actually sets", () => {
    // `use-theme.tsx` sets `documentElement.dataset.mode`, so the variant
    // must key off `[data-mode="dark"]` for any `dark:` utility to apply.
    expect(darkVariantSelector()).toContain('[data-mode="dark"]');
  });

  it("does not key off a `.dark` class, which nothing in the app sets", () => {
    expect(darkVariantSelector()).not.toMatch(/\.dark\b/);
  });

  it("matches elements nested under the themed root, not just the root", () => {
    // `data-mode` lives on <html>; every styled element is a descendant,
    // so a selector that only matched the root itself would be useless.
    expect(darkVariantSelector()).toMatch(/\[data-mode="dark"\]\s+\*/);
  });
});

describe("mode constants", () => {
  it("declares exactly the two modes globals.css defines blocks for", () => {
    for (const mode of MODES) {
      expect(globalsCss).toContain(`html[data-mode="${mode}"]`);
    }
  });

  it("defaults to a mode globals.css can style", () => {
    expect(MODES).toContain(DEFAULT_MODE);
  });
});
