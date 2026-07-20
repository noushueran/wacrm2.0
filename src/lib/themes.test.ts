import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { MODES, DEFAULT_MODE } from "./themes";

// `globals.css` and `themes.ts` describe the same mechanism from two
// sides: the TS constants drive `document.documentElement.dataset.mode`,
// and the CSS has to key off that same attribute. Nothing else checks
// that they agree — and when they disagreed, they disagreed silently:
// the `dark:` variant shipped keyed to a `.dark` class no code ever set,
// so every `dark:` utility in the app compiled to a selector that could
// never match. Type checking, lint and 1965 unit tests all passed.
const css = readFileSync(
  join(__dirname, "..", "app", "globals.css"),
  "utf8",
);

const darkVariant = css.match(/@custom-variant\s+dark\s*\(([^;]*)\);/)?.[1];

describe("dark mode wiring", () => {
  it("declares a dark custom-variant", () => {
    expect(darkVariant, "@custom-variant dark not found in globals.css")
      .toBeTypeOf("string");
  });

  it("keys the dark: variant off the data-mode attribute the app sets", () => {
    expect(darkVariant).toContain('[data-mode="dark"]');
  });

  it("does not key the dark: variant off a .dark class", () => {
    // Nothing in the app adds a `.dark` class; a variant scoped to one
    // can never match, which disables every `dark:` utility silently.
    expect(darkVariant).not.toMatch(/(^|[^-\w])\.dark\b/);
  });

  it("defines a CSS block for every mode, matching MODES", () => {
    for (const mode of MODES) {
      expect(css, `missing html[data-mode="${mode}"] block`).toContain(
        `html[data-mode="${mode}"]`,
      );
    }
  });

  it("has a dark mode among MODES for the variant to target", () => {
    expect(MODES).toContain("dark");
    expect(MODES).toContain(DEFAULT_MODE);
  });
});
