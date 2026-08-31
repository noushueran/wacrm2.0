import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

// The theme defines every colour token as a FULL CSS colour value
// (`--primary: oklch(0.526 0.247 293)`), not as the bare HSL component
// triplet (`262 83% 58%`) that shadcn's older template used. Those two
// conventions demand opposite call sites: bare triplets have to be wrapped
// — `hsl(var(--primary))` — while full values must be used raw,
// `var(--primary)`.
//
// Wrapping a full value produces `hsl(oklch(0.526 0.247 293))`, which is
// not a valid colour. For an SVG `fill`/`stroke` an invalid value falls
// back to the property's initial value — BLACK — so every bar, line and
// axis painted this way rendered pure `rgb(0, 0, 0)`. On the light theme
// that reads as a deliberate monochrome chart; on dark it is black on a
// near-black card, i.e. an invisible chart that still reports correct
// numbers in its tiles.
//
// Nothing already in the suite could catch it. It is a string as far as
// TypeScript is concerned, Recharts passes it through untouched, and
// `CSS.supports('fill', 'hsl(var(--primary))')` answers TRUE — custom
// properties are not resolved at parse time, so the check every reviewer
// would reach for is exactly the one that cannot see the bug. It only
// surfaces in a real browser, on a real render, with the eye.
//
// Guard the convention at the source instead. `src/lib/themes.test.ts`
// pins the same class of silent CSS/TS drift from the other direction.
const REPORTS_DIR = __dirname;

const panels = readdirSync(REPORTS_DIR)
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => ({ file: f, source: readFileSync(join(REPORTS_DIR, f), "utf8") }));

const css = readFileSync(
  join(__dirname, "..", "..", "app", "globals.css"),
  "utf8",
);

describe("reports chart colours", () => {
  it("has panels to check", () => {
    // Guards the guard: a rename that empties this list would make every
    // assertion below vacuously pass.
    expect(panels.length).toBeGreaterThan(0);
  });

  it("defines theme tokens as full colour values, not HSL triplets", () => {
    // The premise the rule below rests on. If the theme is ever migrated
    // back to bare triplets, this fails first and explains why.
    expect(css).toMatch(/--primary:\s*oklch\(/);
    expect(css).not.toMatch(/--primary:\s*[\d.]+\s+[\d.]+%\s+[\d.]+%/);
  });

  it.each(panels)("$file never wraps a theme token in hsl()", ({ source }) => {
    const offenders = [...source.matchAll(/hsl\(\s*var\(\s*(--[\w-]+)/g)].map(
      (m) => m[1],
    );
    expect(
      offenders,
      `hsl(var(…)) resolves to an invalid colour and paints black — use var(…) directly`,
    ).toEqual([]);
  });
});
