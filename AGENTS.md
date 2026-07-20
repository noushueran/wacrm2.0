<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
# Code retrieval

There is no semantic/embedding index for this repo — use the built-in search tools directly.
File and function names track the business vocabulary closely, so grepping the domain noun
("qualification", "purchase", "leads", "broadcast") usually lands on the right module.

## Entry points

- `convex/schema.ts` — the entire data model in one file. Read this first for any data question.
- `convex/_generated/api.d.ts` — generated index of every backend function. A Convex function is
  addressed `api.<module>.<fn>` / `internal.<module>.<fn>`, where `<module>` is its filename under
  `convex/`, so a call site tells you the file deterministically.
- Layout: `convex/` backend · `src/app/` routes · `src/components/` UI · `src/lib/` shared logic.
- A module's `*.test.ts` is the most reliable description of its behavior — read the test before
  reverse-engineering the implementation.

## Search rules

- **Prefer the Grep/Glob tools over `grep -r` in bash.** The tools honor the repo's ignore rules;
  bash `grep -r` does not, and will traverse `node_modules/` and every checkout under
  `.claude/worktrees/`, returning the same hit once per worktree. If a count looks implausibly
  large, this is why — re-run with the Grep tool.
- Grep for *known* identifiers. For open-ended "how does X work" questions spanning many files,
  dispatch the Explore agent instead of hand-grepping.
