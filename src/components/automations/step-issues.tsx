"use client"

/**
 * Inline validation for the automation builder (Phase 3 Task 4) — surfaces
 * exactly what `validateStepsForActivation` would refuse activation for,
 * while the operator is still editing, instead of after a round trip to
 * the server's `VALIDATION_FAILED` error (`convex/automations.ts`'s
 * `assertActivatable`). Runs the SAME function the server gates
 * activation on — imported directly, never reimplemented — so the
 * builder and the gate cannot disagree about what counts as broken.
 *
 * `convex/lib/automations/validate.ts` is a pure `convex/lib/**` module
 * safe to import from a client component: its only imports are
 * `../whatsapp/interactive`, `./sendPlan` and `./schedule`, and walking
 * their imports transitively (interactive -> metaApi -> templateComponents)
 * turns up no `./_generated/*` or `convex/server` anywhere in the chain —
 * confirmed by hand before writing this file, per this task's brief.
 *
 * Three pieces of pure logic live here, exported and unit-tested directly
 * in ./step-issues.test.tsx (no jsdom in this repo, so nothing that
 * renders can be tested with Testing Library — see preview-plan.ts's
 * header comment for the precedent; component output is instead checked
 * with `renderToStaticMarkup`, matching message-preview.test.tsx and
 * run-stats-bar.test.tsx):
 *
 *  - `collectStepPaths` walks the SAME tree shape validate.ts's own
 *    internal `walk()` does, generating the identical `steps[0]`,
 *    `steps[0].yes.steps[1]`, ... strings for every step actually
 *    rendered. This mirrors tree STRUCTURE (array position, yes/no
 *    branch), not a validation RULE, so duplicating it doesn't risk
 *    drifting from Meta's limits or validate.ts's messages the way
 *    reimplementing a check would — but it does have to keep matching
 *    validate.ts's naming scheme exactly, or bucketing below silently
 *    stops matching anything.
 *  - `bucketIssuesByStepPath` matches each issue's `path` to the LONGEST
 *    known step path that is either equal to it or a proper `"."`-delimited
 *    prefix of it. Longest wins so an issue on a step nested inside a
 *    branch (`steps[0].yes.steps[1].text`) attaches to the step that
 *    actually owns it (`steps[0].yes.steps[1]`) and not ALSO to the
 *    condition step wrapping it (`steps[0]`) — both are valid string
 *    prefixes of the same issue path, and getting this wrong either
 *    duplicates the issue onto the wrong card or drops it. An issue whose
 *    path matches no rendered step (the zero-steps `"steps"` path, or a
 *    stale index) is simply dropped from the map — see that function's
 *    own comment.
 *  - `unattachedIssues` (I-3 fix) is the complement: exactly the issues
 *    `bucketIssuesByStepPath` dropped, so whoever surfaces them (the
 *    top-bar badge's tooltip, today) can show their `message` verbatim
 *    instead of the issue existing nowhere a human can read it, despite
 *    still counting toward the total and gating Save.
 */

import { useMemo } from "react"
import { AlertTriangle } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  validateStepsForActivation,
  type ValidationIssue,
} from "../../../convex/lib/automations/validate"

export type { ValidationIssue }

/**
 * Matches `convex/lib/automations/validate.ts`'s own (unexported)
 * `StepLike` field-for-field, so `BuilderStep`
 * (automation-builder.tsx) — and any plain test fixture shaped like it —
 * satisfies this structurally with no cast.
 */
export interface StepTreeNode {
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: StepTreeNode[]; no?: StepTreeNode[] }
}

/**
 * Enumerates the dot-path (validate.ts's scheme) of every step in the
 * tree, in the same depth-first order `validate.ts`'s `walk()` visits
 * them. Read this as "what paths are actually rendered right now" — the
 * set `bucketIssuesByStepPath` matches issue paths against.
 */
export function collectStepPaths(steps: StepTreeNode[], prefix = ""): string[] {
  const paths: string[] = []
  steps.forEach((step, i) => {
    const path = `${prefix}steps[${i}]`
    paths.push(path)
    if (step.step_type === "condition" && step.branches) {
      if (step.branches.yes) paths.push(...collectStepPaths(step.branches.yes, `${path}.yes.`))
      if (step.branches.no) paths.push(...collectStepPaths(step.branches.no, `${path}.no.`))
    }
  })
  return paths
}

/**
 * Groups issues under the step path that owns them. An issue belongs to
 * the longest `stepPaths` entry that is either an exact match for
 * `issue.path`, or a proper prefix of it ending right before a `"."` —
 * longest wins so a field on a deeply-nested step attaches to that step
 * alone, never to an ancestor condition card whose path also happens to
 * prefix the same string (see this module's header comment for why that
 * would otherwise happen).
 *
 * The `"."` boundary also rules out numeric false-positives: `"steps[1]"`
 * is never treated as a prefix of `"steps[10]..."`, because the character
 * right after `steps[1` is `]` in the candidate but `0` in the issue path
 * — they diverge before the boundary check even runs.
 *
 * An issue whose path matches no entry in `stepPaths` — the zero-steps
 * `"steps"` path (nothing rendered to attach it to), or a stale index
 * left over from an in-flight edit — is dropped from the map, not thrown
 * on. It still counts toward `useStepIssues`'s flat `issues` total; it
 * just doesn't appear on any one card.
 */
export function bucketIssuesByStepPath(
  issues: ValidationIssue[],
  stepPaths: string[],
): Map<string, ValidationIssue[]> {
  const buckets = new Map<string, ValidationIssue[]>()
  for (const issue of issues) {
    let owner: string | undefined
    for (const candidate of stepPaths) {
      const matches = issue.path === candidate || issue.path.startsWith(`${candidate}.`)
      if (matches && (owner === undefined || candidate.length > owner.length)) {
        owner = candidate
      }
    }
    if (owner === undefined) continue
    const bucket = buckets.get(owner)
    if (bucket) bucket.push(issue)
    else buckets.set(owner, [issue])
  }
  return buckets
}

/**
 * I-3 fix. The complement to `bucketIssuesByStepPath`: issues it DROPPED
 * because no rendered step owns them (see that function's own comment —
 * the zero-steps `"steps"` path is the only shape this happens for today,
 * since `walk()` never runs for an empty tree and every issue it DOES
 * push is `steps[i]`-prefixed, which `collectStepPaths` always has a
 * matching entry for whenever at least one top-level step exists).
 *
 * Before this, an unattached issue was counted in the flat `issues` total
 * — so it inflated the top-bar badge and could gate Save
 * (`automation-builder.tsx`'s `saveBlocked`) — while being rendered on no
 * card, in no tooltip, anywhere. This is what lets a caller (the badge's
 * tooltip, today) surface its `message` text verbatim instead of quietly
 * discarding it.
 */
export function unattachedIssues(
  issues: ValidationIssue[],
  byPath: Map<string, ValidationIssue[]>,
): ValidationIssue[] {
  const attached = new Set<ValidationIssue>()
  for (const bucket of byPath.values()) {
    for (const issue of bucket) attached.add(issue)
  }
  return issues.filter((issue) => !attached.has(issue))
}

export interface StepIssuesResult {
  /** Flat list, in validate.ts's own order — what a total count and
   *  "scroll to the first offending card" both read. */
  issues: ValidationIssue[]
  /** Issues grouped by the exact step path that owns them. A step with no
   *  issues of its own simply has no entry — look up with
   *  `byPath.get(path) ?? []`. */
  byPath: Map<string, ValidationIssue[]>
  /** Issues no rendered step owns — see `unattachedIssues`'s own comment.
   *  Empty in the overwhelmingly common case. */
  unattached: ValidationIssue[]
}

/**
 * Runs `validateStepsForActivation` on the current step tree and buckets
 * the result by step path, memoized on `steps` so it only recomputes when
 * the tree actually changes (every keystroke in the builder touches
 * `state`, but most keystrokes don't touch `state.steps`).
 */
export function useStepIssues(steps: StepTreeNode[]): StepIssuesResult {
  return useMemo(() => {
    const issues = validateStepsForActivation(steps)
    const stepPaths = collectStepPaths(steps)
    const byPath = bucketIssuesByStepPath(issues, stepPaths)
    return { issues, byPath, unattached: unattachedIssues(issues, byPath) }
  }, [steps])
}

/**
 * Compact amber strip, one line per issue, `issue.message` reproduced
 * verbatim — never restated or rephrased here, so this and the server
 * gate cannot drift apart (this task's brief). Amber, not destructive
 * red: these are "this will not activate yet" notes on a draft, not
 * errors on something already broken. Renders nothing when `issues` is
 * empty, so callers can mount it unconditionally below a step's config
 * fields.
 */
export function StepIssues({ issues, className }: { issues: ValidationIssue[]; className?: string }) {
  if (issues.length === 0) return null
  return (
    <div
      className={cn(
        "mt-3 flex flex-col gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2",
        className,
      )}
    >
      {issues.map((issue) => (
        <p
          key={`${issue.path}:${issue.message}`}
          className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{issue.message}</span>
        </p>
      ))}
    </div>
  )
}
