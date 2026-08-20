import { ESLint } from "eslint"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * Guards the `no-restricted-syntax` pair in `eslint.config.mjs` that
 * catches a container query pointed at the element declaring the
 * container — see the container-query note in `src/app/globals.css` for
 * why that construct is dead CSS.
 *
 * The guard is two regexes with a backreference. Without a test, a tidy-up
 * of those regexes could quietly stop matching and nobody would notice:
 * the failure mode of the guard is the same as the failure mode of the bug
 * it guards — silence.
 */

/**
 * Fixtures below write `~` where a class name needs `@`. Tailwind's
 * automatic source detection scans this file, and a complete class name
 * spelled out here — even inside a test fixture — gets compiled into the
 * shipped stylesheet as a rule no element will ever match. Substituting
 * the `@` back in at runtime keeps the fixtures honest for ESLint while
 * leaving nothing for Tailwind to find.
 */
const classes = (fixture: string) => fixture.replaceAll("~", "@")

let eslint: ESLint

/** Lints `markup` as if it were a component file, returns the rule's hits. */
async function violations(markup: string): Promise<string[]> {
  const [result] = await eslint.lintText(
    `export const C = () => (${classes(markup)})`,
    // Never written to disk; only used to resolve which config applies.
    { filePath: "src/components/__container-query-probe.tsx" }
  )
  return result.messages
    .filter((m) => m.ruleId === "no-restricted-syntax")
    .map((m) => m.message)
}

beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() })
})

describe("self-referencing container query lint", () => {
  it.each([
    ["declaration then query", `<div className="~container/ib ~lg/ib:flex-row" />`],
    ["query then declaration", `<div className="~lg/ib:flex-row ~container/ib" />`],
    ["inside cn()", `<div className={cn("~container/x ~sm/x:grid-cols-2")} />`],
    ["template literal", "<div className={`~container/x gap-2 ~md/x:flex-row`} />"],
    ["max-* query", `<div className="~container/ib ~max-lg/ib:hidden" />`],
    ["arbitrary query", `<div className="~container/ib ~min-[480px]/ib:flex-row" />`],
  ])("flags %s", async (_label, markup) => {
    expect(await violations(markup)).toHaveLength(1)
  })

  it.each([
    [
      "declaration and query split across two elements",
      `<div className="~container/ib"><div className="~lg/ib:flex-row" /></div>`,
    ],
    [
      "querying a different, ancestor container",
      `<div className="~container/card-header ~lg/ib:flex-row" />`,
    ],
    [
      "a container name that merely prefixes another",
      `<div className="~container/ibex ~lg/ib:flex-row" />`,
    ],
    [
      "the real CardHeader class string (declaration only)",
      `<div className="group/card-header ~container/card-header grid px-4" />`,
    ],
    ["viewport breakpoints", `<div className="flex flex-col md:flex-row" />`],
    [
      "group variants, which reuse the /name syntax",
      `<div className="group/card-header group-data-[size=sm]/card:px-3" />`,
    ],
  ])("allows %s", async (_label, markup) => {
    expect(await violations(markup)).toEqual([])
  })
})
