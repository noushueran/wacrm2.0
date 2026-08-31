# History Graft and Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Join the Amani and Holidayys histories into one repository with a real merge base, so the
335 commits of Amani work land in Holidayys as an ordinary merge rather than a hand-port.

**Architecture:** `git replace --graft` gives Amani's root commit the fork point as its parent.
This is **not** a history rewrite — no SHA changes, no force-push, every existing branch stays
valid. The merge commit that follows records both parents for real, so the join outlives the graft.

**Tech Stack:** git 2.50.1, vitest 4, TypeScript.

**Parent spec:** `docs/superpowers/specs/2026-08-02-crm-codebase-unification-design.md`

## What a dry run already established

Every number below was measured on 2026-08-02 in a throwaway clone, not estimated. Re-measure at
execution time — both repos move — but the shape is unlikely to change.

| Question | Answer |
|---|---|
| Does the graft produce a merge base? | **Yes.** `git merge-base` returned exactly `e4a5e2e` after `git replace --graft`. Before it: nothing (unrelated histories). |
| Does it require rewriting history? | **No.** Zero SHAs changed. This retires most of the spec's R5. |
| How many files actually conflict? | **5**, 9 hunks total — all in AI-provider code. Listed in Task 5. |
| Does the media viewer conflict (spec R3)? | **No — because Amani's media work is not on `main`.** It sits on `feat/inbox-media-view-download` (`d770b0a`). Holidayys' version therefore wins by default. See Task 6. |
| Does `.claude/worktrees` come across? | **Yes — 9,599 files.** Task 2 prevents it. |
| Does anything else go silently wrong? | **Yes, and it is the dangerous one.** See below. |

### The silent failure this plan exists to prevent

The trial merge completed with 5 conflicts and produced a `src/app/layout.tsx` reading:

```ts
    default: "Amani WA CRM",
    description: "Internal WhatsApp CRM for Amani Tourism & Travel LLC — …",
```

**Holidayys was rebranded as Amani, with no conflict raised.** Git behaved correctly: the fork
point holds Holidayys' strings, Holidayys never touched them again, Amani changed them — so "take
the side that changed" is the right three-way answer. It is also completely wrong.

This is worse than a conflict, because a conflict stops you. The spec's brand-externalization plan
(`2026-08-02-brand-externalization.md`) is therefore a **hard precondition**, not a nicety: once
both repos carry identical brand-neutral files, there is no company string left for the merge to
choose between. Task 1 refuses to proceed without it, and Task 7 verifies the outcome independently
rather than trusting that it worked.

## Global Constraints

- **Nothing is pushed until Task 8**, and `main` is never committed to directly. The merge lands on
  a branch and goes through a PR like any other change.
- **Never run `npx convex deploy`, `convex dev`, or `convex codegen` as part of this plan.** Convex
  deploys are owner-initiated in this project. This plan produces a merged *branch*; deploying it is
  the rollout plan's job, and it has its own ordering constraints (`autoAssignEnabled`, the
  `awaitingReply` backfill) that must not be pre-empted.
- **`git replace` is reversible.** `git replace -d <sha>` removes a graft; nothing here is
  destructive until Task 8 pushes.
- Work in a dedicated worktree so neither repo's main working tree is disturbed. Both currently
  carry uncommitted work — 16 files in Amani, 22 in Holidayys.
- Stage paths explicitly. Never `git add -A` in this plan: an accidental `.claude/worktrees` stage
  re-imports 9,599 files.
- **Holidayys is the trunk.** It holds the merge base and the deeper history, so Amani grafts onto
  it and Holidayys' refs are never rewritten.
- **Every shell block below assumes these two variables.** Each step is a separate block and shell
  state does not persist between them, so re-export them in any new shell:

  ```bash
  export A=/Volumes/CurserDisk/Dev/wa-amani
  export H=/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0
  ```

## File Structure

No application files are created by this plan. The artifacts are:

| Artifact | Purpose |
|---|---|
| `refs/replace/a12b44c…` in the Holidayys repo | The graft. Local, reversible, and the thing that makes a three-way merge possible. |
| Branch `merge/amani-unification` | Where the merge lands and is reviewed. |
| One merge commit | The durable join. Records both parents, so the histories stay connected whether or not the replace ref survives. |
| `docs/superpowers/merge-conflict-report.md` | Task 4's inventory. Deleted before the PR; it exists so Task 5 is reviewed against a written list rather than memory. |

---

### Task 1: Verify preconditions

**Files:** none — this task only reads.

**Interfaces:**
- Consumes: a completed `2026-08-02-brand-externalization.md` in **both** repos.
- Produces: a go/no-go. Every later task assumes these hold.

- [ ] **Step 1: Confirm brand externalization has landed in both repos**

```bash
A=/Volumes/CurserDisk/Dev/wa-amani
H=/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0
for R in "$A" "$H"; do
  echo "--- $R"
  git -C "$R" cat-file -e main:src/lib/brand.ts 2>/dev/null \
    && echo "  brand.ts on main: yes" || echo "  brand.ts on main: NO — STOP"
done
```

Both must print `yes`. **If either prints `NO`, stop and finish the brand plan first.** Merging
without it silently rebrands Holidayys as Amani — see the section above. This is the single
precondition that cannot be worked around later.

- [ ] **Step 2: Confirm no company string survives on either main**

```bash
for R in "$A" "$H"; do
  echo "--- $R"
  git -C "$R" grep -niE 'amani|holidayys' main -- 'src/**/*.ts' 'src/**/*.tsx' \
    | grep -v '\.test\.' | grep -viE '//|\*' | head
done
```

Expected: no output from either. Any live string here becomes a silent wrong value after the merge.

- [ ] **Step 3: Confirm both working trees are clean enough**

```bash
for R in "$A" "$H"; do echo "--- $R: $(git -C "$R" status --porcelain | wc -l | tr -d ' ') dirty"; done
```

Uncommitted work does not block this plan — everything happens in a separate worktree — but the six
files dirty in *both* trees (`dashboard.ts`, `messages.ts`, `messageStats.ts`, `schema.ts` and two
tests) should be landed first. They are being edited in two places at once, and merging around them
means merging a half-finished change on one side.

- [ ] **Step 4: Confirm Holidayys' own in-flight work has landed on main**

```bash
git -C "$H" log --oneline main..HEAD
```

Expected: empty. If it lists commits (at the time of writing, 2 — the media viewer), land them on
`main` first. Merging into a feature branch works, but it entangles Holidayys' review with this
one.

- [ ] **Step 5: Record the starting SHAs**

```bash
git -C "$A" log -1 --format='amani     main: %h %s' main
git -C "$H" log -1 --format='holidayys main: %h %s' main
```

Write both into the PR description in Task 8. If the merge later needs redoing, these say exactly
what was merged.

---

### Task 2: Untrack `.claude/worktrees` on Amani's main

**Files:**
- Modify (Amani repo): `.gitignore` — only if the rule is missing
- Delete from the index (Amani repo): `.claude/worktrees/**` — 9,599 files

**Interfaces:**
- Consumes: nothing.
- Produces: an `amani/main` that does not carry 9,599 files of nested working copies into the
  merge.

Amani has 17 entire nested checkouts of itself committed — 98.8 MB, 9,599 files. The dry run
confirmed all of them cross into Holidayys on merge. `.gitignore` already carries the rule
(`.gitignore:57-58`), but the files were committed *before* it and gitignore does not untrack.

A branch `chore/untrack-claude-worktrees` (`4a223b4`, 2026-07-27) already does this and removes
exactly 9,599 files, but it is not an ancestor of `main` and is a week stale. Redoing the removal
is mechanical and avoids a rebase, so do that rather than resurrecting the branch.

- [ ] **Step 1: Branch off Amani's main in a worktree**

```bash
A=/Volumes/CurserDisk/Dev/wa-amani
git -C "$A" worktree add /tmp/untrack-wt -b chore/untrack-worktrees-v2 main
cd /tmp/untrack-wt
```

- [ ] **Step 2: Confirm the gitignore rule is present**

```bash
grep -n '\.claude/worktrees/' .gitignore || echo "MISSING — add it"
```

If missing, add these two lines to `.gitignore`:

```
# Claude Code worktrees (isolated workspaces, never committed)
.claude/worktrees/
```

- [ ] **Step 3: Untrack the directory without deleting it from disk**

`--cached` is load-bearing: these paths are *live registered worktrees* (`git worktree list` shows
several). Deleting the files would break them. Untracking only removes them from the index.

```bash
git rm -r --cached --quiet .claude/worktrees
git status --porcelain | grep -c '^D ' | xargs echo "staged deletions:"
```

Expected: 9599 (or close — the count moves as worktrees are added and removed).

- [ ] **Step 4: Verify nothing outside `.claude/worktrees` got staged**

```bash
git diff --cached --name-only | grep -v '^\.claude/worktrees/' | head
```

Expected: empty, or only `.gitignore` if Step 2 changed it. Anything else means the `git rm` caught
more than intended — unstage and retry.

- [ ] **Step 5: Confirm the worktrees still work**

```bash
git -C "$A" worktree list
```

Expected: the same list as before. If a worktree has vanished, `--cached` was omitted somewhere —
restore from `main` before continuing.

- [ ] **Step 6: Commit**

```bash
git add .gitignore 2>/dev/null
git commit -q -m "chore: untrack the committed copies of .claude/worktrees

17 nested working copies of this repo — 9,599 files, 98.8 MB — were
committed before .gitignore learned to exclude them, and gitignore does
not untrack what is already tracked.

They are removed from the INDEX only (git rm --cached): several are live
registered worktrees and deleting the files would break them.

Doing this before the Holidayys merge rather than after: a dry run
confirmed all 9,599 cross over otherwise, importing a second repo's
worth of duplicated source into a codebase that never had it."
```

- [ ] **Step 7: Land it on Amani's main and clean up**

Open a PR from `chore/untrack-worktrees-v2`, get it merged, then:

```bash
git -C "$A" worktree remove /tmp/untrack-wt
```

Do not proceed until this is on `main` — the merge in Task 4 reads `amani/main`.

---

### Task 3: Build the merge worktree and create the graft

**Files:** none committed. This task creates a worktree and one replace ref.

**Interfaces:**
- Consumes: `amani/main` from Task 2.
- Produces: a worktree on branch `merge/amani-unification` where `git merge-base origin/main
  amani/main` returns the fork point. Tasks 4-7 all work inside it.

- [ ] **Step 1: Create the merge worktree in the Holidayys repo**

```bash
H=/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0
git -C "$H" worktree add /tmp/merge-wt -b merge/amani-unification main
cd /tmp/merge-wt
```

- [ ] **Step 2: Add Amani as a remote and fetch it**

```bash
git remote add amani /Volumes/CurserDisk/Dev/wa-amani
git fetch amani
git log -1 --format='amani/main: %h %s' amani/main
```

A local path is deliberate — it is faster than GitHub and this is all local until Task 8.

- [ ] **Step 3: Confirm the histories are unrelated before grafting**

```bash
git merge-base main amani/main || echo "no merge base — expected"
```

Expected: `no merge base — expected`. If it *does* print a SHA, a graft already exists in this
repository; inspect `git replace -l` before adding another.

- [ ] **Step 4: Create the graft**

`a12b44c` is Amani's root commit — the squashed "Initial commit: Amani WA CRM". `e4a5e2e` is the
fork point, a verified ancestor of Holidayys' `main`. The graft says what was always true: the one
descends from the other.

```bash
ROOT=$(git rev-list --max-parents=0 amani/main)
BASE=$(git rev-parse e4a5e2e)
echo "root: $ROOT"   # expect a12b44c811247cf0129eb7bdbd53b191c854a760
echo "base: $BASE"   # expect e4a5e2e0a0f98bd7df4724f4bb55d6e001844a28
git replace --graft "$ROOT" "$BASE"
```

If `git rev-list --max-parents=0 amani/main` returns more than one SHA, stop: Amani has more than
one root and the wrong one may be picked. Investigate before continuing.

- [ ] **Step 5: Verify the graft produced the right merge base**

This is the assertion the whole plan rests on. Do not skip it.

```bash
MB=$(git merge-base main amani/main)
[ "$MB" = "$(git rev-parse e4a5e2e)" ] && echo "OK: merge base is the fork point" \
  || echo "WRONG: got $MB"
```

Expected: `OK: merge base is the fork point`.

If it reports `WRONG`, remove the graft (`git replace -d "$ROOT"`) and do not merge. A merge with
the wrong base silently produces a wrong tree — that is the failure mode this whole plan is built
to avoid, and it will not announce itself.

---

### Task 4: Merge, and inventory what happened

**Files:**
- Create: `docs/superpowers/merge-conflict-report.md` (temporary; deleted in Task 8)

**Interfaces:**
- Consumes: the grafted worktree from Task 3.
- Produces: an in-progress merge with conflicts unresolved, plus a written inventory that Task 5
  works through and Task 8 reviews against.

- [ ] **Step 1: Start the merge without committing**

`--no-commit` keeps the merge open so Task 5's resolutions and Task 2's exclusions land in one
commit rather than a commit plus fixups.

```bash
cd /tmp/merge-wt
git merge --no-commit --no-ff amani/main
```

Expected: `Automatic merge failed; fix conflicts and then commit the result.` A clean merge is
**not** good news here — it means the conflicts moved somewhere unexpected. Investigate before
continuing.

- [ ] **Step 2: Write the inventory**

```bash
{
  echo "# Merge conflict report"
  echo
  echo "- merged: \`$(git rev-parse --short amani/main)\` (amani/main) into \`$(git rev-parse --short HEAD)\` (holidayys main)"
  echo "- merge base: \`$(git merge-base --short HEAD amani/main)\`"
  echo "- generated: $(git log -1 --format=%ad --date=short)"
  echo
  echo "## Conflicted files"
  echo
  for f in $(git diff --name-only --diff-filter=U); do
    echo "- [ ] \`$f\` — $(grep -c '^<<<<<<<' "$f") hunk(s)"
  done
  echo
  echo "## Totals"
  echo
  echo "- conflicted files: $(git diff --name-only --diff-filter=U | wc -l | tr -d ' ')"
  echo "- files changed by the merge: $(git diff --cached --name-only | wc -l | tr -d ' ')"
  echo "- .claude/worktrees files pulled in: $(git diff --cached --name-only | grep -c '^\.claude/worktrees/')"
} > docs/superpowers/merge-conflict-report.md
cat docs/superpowers/merge-conflict-report.md
```

- [ ] **Step 3: Check the `.claude/worktrees` count is zero**

The report's last line must read `0`. If it does not, Task 2 did not land on `amani/main` — abort
the merge (`git merge --abort`), finish Task 2, and restart from Task 4 Step 1:

```bash
grep '.claude/worktrees files pulled in' docs/superpowers/merge-conflict-report.md
```

- [ ] **Step 4: Compare against the dry run**

As of 2026-08-02 the dry run produced exactly 5 conflicted files:

```
convex/lib/ai/defaults.ts            1 hunk
convex/lib/ai/generate.ts            2 hunks
convex/lib/ai/providers/openai.ts    3 hunks
convex/lib/ai/providers/shared.ts    1 hunk
convex/qualificationEngine.ts        2 hunks
```

More than this is expected — both mains have moved, and the brand plan touched ~21 files. A
*substantially* different list (say, conflicts in `src/app/` or `convex/schema.ts`) means something
changed structurally since; read those before resolving anything.

---

### Task 5: Resolve the conflicts

**Files:** the files listed in Task 4's report. As of the dry run, five, all under `convex/lib/ai/`
plus `convex/qualificationEngine.ts`.

**Interfaces:**
- Consumes: the open merge from Task 4.
- Produces: a fully staged, conflict-free index. No commit yet — Task 7 commits.

**These conflicts are a union, not a choice.** Both repos independently diagnosed the *same* bug in
the same week — an AI call exhausting its output-token budget and returning nothing — and each
fixed a different cause. Holidayys' `main` message is literally "pin reasoning_effort and raise the
analysis token cap"; Amani's side adds `reasoningEffort` plus a prompt-cache-routing key. Neither
is superseded. The resolution is almost always "keep both sides", and a resolution that *deletes*
one side's constant or parameter is a bug.

Worked example — `convex/lib/ai/defaults.ts`, the single hunk from the dry run, abbreviated:

```
<<<<<<< HEAD
/** Output cap for the lead-qualification ANALYSIS call
 *  (`qualificationEngine.analyzeInbound`) … 1024 leaves real headroom … */
export const ANALYSIS_MAX_OUTPUT_TOKENS = 1024;
=======
/** Extra output allowance granted when a reasoning model is asked to
 *  actually think. Reasoning tokens are drawn from the SAME
 *  `max_completion_tokens` budget as the visible reply … */
export const REASONING_OUTPUT_ALLOWANCE = …;
>>>>>>> amani/main
```

Both constants are wanted: one bounds the structured-analysis response, the other reserves budget
for reasoning tokens, and they address different halves of the same failure. The resolution keeps
both declarations and both doc comments — delete the markers, keep everything between them.

(The exact identifier on Amani's side is elided above; read the real hunk. The point is the shape:
two additive declarations, not two spellings of one.)

- [ ] **Step 1: Resolve one file at a time, ticking the report as you go**

For each file in `docs/superpowers/merge-conflict-report.md`:

```bash
git diff --diff-filter=U -- <file>   # see both sides in context
$EDITOR <file>
git add -- <file>
```

Tick its checkbox in the report. Working from the written list is what stops a file being resolved
from memory and half-finished.

- [ ] **Step 2: Watch specifically for a duplicated `reasoning_effort`**

Both repos implemented it. A textual union can leave the parameter threaded twice — declared on
both `shared.ts`'s options type and sent twice in `providers/openai.ts`'s request body. Check:

```bash
grep -rn 'reasoning_effort\|reasoningEffort' convex/lib/ai/ | sort
```

Each should appear once per role: once in the options type, once where the request body is built,
once in whatever picks the value. Two request-body sites is a real bug that no test will catch,
because both would set the same value.

- [ ] **Step 3: Confirm nothing is left unmerged**

```bash
git diff --name-only --diff-filter=U | wc -l
grep -rn '^<<<<<<<\|^>>>>>>>\|^=======$' convex src --include='*.ts' --include='*.tsx' | head
```

Expected: `0`, and no output from the grep. A conflict marker committed into a source file compiles
in neither repo, and the grep catches the case where a file was edited but not re-staged.

---

### Task 6: Decide the media viewer

**Files:** `src/components/inbox/media-lightbox.tsx`, `src/lib/media/download.ts`,
`src/app/api/media/download/route.ts`, `src/components/inbox/message-bubble.tsx`.

**Interfaces:**
- Consumes: the resolved merge from Task 5.
- Produces: a tree carrying exactly one media implementation.

The spec (§Decision) chose Holidayys' server-route transport with Amani's zoom-and-pan viewer.
**This merge does not deliver that, and cannot** — Amani's media work is not on `main`. It lives on
`feat/inbox-media-view-download` (`d770b0a`), so the merge sees no competing implementation and
Holidayys' version survives untouched.

That is a correct and safe outcome for *this* merge. It also means the spec's decision is deferred,
not delivered: Amani's zoom-and-pan viewer is still on a branch, and merging that branch later will
hit exactly the conflict §Decision describes.

- [ ] **Step 1: Confirm exactly one implementation is present**

```bash
ls -1 src/components/inbox/media-lightbox.tsx src/lib/media/download.ts \
      src/app/api/media/download/route.ts 2>&1
ls -1 src/components/inbox/use-media-download.ts \
      src/components/inbox/use-media-object-url.ts 2>&1
```

Expected: the first three present (Holidayys' transport and viewer), the last two **absent** —
those are Amani's client-fetch hooks, which §Decision discards. If they are present, Amani's branch
reached `main` after all and this merge is delivering a hybrid; stop and apply §Decision properly
before committing.

```bash
wc -l src/components/inbox/media-lightbox.tsx
```

Expected: 109 — Holidayys' fit-to-window viewer. 262 would be Amani's.

- [ ] **Step 2: Record the deferral so it is not lost**

Add to the PR description in Task 8, verbatim:

> Does not deliver the spec's §Decision on the media viewer. Amani's zoom-and-pan lightbox is on
> `feat/inbox-media-view-download` (`d770b0a`) and never reached `main`, so this merge keeps
> Holidayys' implementation unchanged. Applying §Decision — Holidayys' server-route transport with
> Amani's viewer — remains outstanding and needs its own change.

---

### Task 7: Verify

**Files:** none modified. This task only runs checks.

**Interfaces:**
- Consumes: the resolved, staged merge.
- Produces: the merge commit.

- [ ] **Step 1: The anti-rebrand check — do this first**

The dry run's headline failure. Verify independently rather than trusting Task 1:

```bash
grep -rniE 'amani' src convex --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.' | grep -viE '^[^:]+:[0-9]+: *(//|\*)'
```

Expected: **no output.** Any live string here means Holidayys is about to ship wearing Amani's
name. This check exists because the failure raises no conflict, produces no test failure, and is
visible only in the rendered page — the browser tab, the invite card, the push notification.

Also check the reverse, which catches a resolution that took the wrong side wholesale:

```bash
git diff --cached -- src/app/layout.tsx | head -30
```

Expected: no change to the brand strings at all — after the brand plan they are `BRAND.name` on
both sides and should merge to identical text.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors. This is the fastest signal that a union resolution left a parameter declared
but unthreaded.

- [ ] **Step 3: Run both suites**

```bash
npx vitest run
```

Expected: PASS. The pre-merge baselines were Amani 3,124 tests / 203 files and Holidayys 2,332 /
177; the merged tree should land near their union, not near either alone. A total close to 2,332
means Amani's test files did not come across — investigate before committing.

- [ ] **Step 4: Build**

```bash
npx next build
```

Expected: success. The suites do not exercise Next.js route or metadata wiring, and this is where a
bad `src/app/` merge surfaces. It is also where a missing brand environment variable will fail the
build by design — if it does, set the five `NEXT_PUBLIC_*` values and re-run; do not add a fallback.

- [ ] **Step 5: Remove the conflict report and commit the merge**

```bash
rm docs/superpowers/merge-conflict-report.md
git add -- docs/superpowers/merge-conflict-report.md 2>/dev/null || true
git status --porcelain | grep -v '^M \|^A \|^D ' | head   # expect empty
git commit -q -F - <<'MSG'
Merge the Amani WA CRM history into Holidayys

The two CRMs forked on 2026-07-21 and both were worked on afterwards,
so every improvement had to be built twice or not at all. In the week
before this merge both repos independently fixed the SAME AI
token-budget bug and both built the SAME media viewer — that is the
cost this ends.

Joined by grafting Amani's root commit onto the fork point (e4a5e2e, a
verified ancestor of this history) so git had a real three-way base.
Deliberately a graft and not a history rewrite: no SHA changed, nothing
was force-pushed, and every existing Amani branch stays valid. This
merge commit records both parents, so the join outlives the graft.

The conflicts were a union rather than a choice. Both sides had
diagnosed an AI call exhausting its output-token budget and each fixed a
different cause — this side raised the analysis output cap, the other
pinned reasoning_effort and added prompt-cache routing. Both were kept.

Brand strings are absent from this diff on purpose. They were moved into
brand.ts in both repos first, because a trial merge showed git silently
resolving them in Amani's favour — correct three-way behaviour, and
completely wrong: it rebranded this CRM with no conflict raised.

Does not deliver the spec's decision on the media viewer; see the PR.
MSG
git log -1 --format='%h %s%n  parents: %p'
```

Expected: a commit with **two** parents.

---

### Task 8: Push and open the PR

**Files:** none.

**Interfaces:**
- Consumes: the merge commit.
- Produces: a PR. **This plan ends at review — it does not merge to `main` and does not deploy.**

- [ ] **Step 1: Push the branch**

```bash
cd /tmp/merge-wt
git push -u origin merge/amani-unification
```

Note this pushes only the branch. The replace ref is deliberately not pushed: it was a tool for
computing the merge base, and the merge commit has recorded the join permanently. Pushing it would
require every clone to opt into fetching `refs/replace/*` to see the same history, which is a
lasting complication in exchange for a cosmetic one — `git log` showing two roots.

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "Merge the Amani WA CRM history into Holidayys" --body "$(cat <<'BODY'
Joins the two CRM codebases. See
`docs/superpowers/specs/2026-08-02-crm-codebase-unification-design.md`.

## How
Grafted Amani's root commit onto the fork point `e4a5e2e` so git had a real
three-way merge base, then merged normally. **No history was rewritten** — no
SHA changed and nothing was force-pushed.

## Conflicts
Five files, all AI-provider code, all resolved as a **union**: both repos had
independently fixed the same output-token-budget bug, each addressing a
different cause. Both fixes are kept.

## Verification
- [ ] `npx tsc --noEmit` clean
- [ ] `npx vitest run` — near the union of the two suites, not either alone
- [ ] `npx next build` succeeds
- [ ] No live company string in `src/` or `convex/`

## Not in this PR
Does not deliver the spec's §Decision on the media viewer. Amani's zoom-and-pan
lightbox is on `feat/inbox-media-view-download` (`d770b0a`) and never reached
`main`, so this merge keeps Holidayys' implementation unchanged. Applying
§Decision remains outstanding.

## Do not deploy on merge
Deploying this needs the rollout plan's ordering: set `autoAssignEnabled: false`
on every Holidayys `qualificationConfigs` row **first** (it defaults to ON and
would auto-assign the backlog), then deploy, then run `inboxBackfill` to
`patched: 0` before anyone opens the Inbox.
BODY
)"
```

- [ ] **Step 3: Clean up the worktree once the PR is merged**

```bash
H=/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0
git -C "$H" worktree remove /tmp/merge-wt
```

Leave the replace ref in place — it costs nothing and keeps `git log --graph` readable locally. To
remove it: `git -C "$H" replace -d a12b44c811247cf0129eb7bdbd53b191c854a760`.

---

## What this plan does NOT do

- **Deploy anything.** The merged branch is not released. The rollout has ordering constraints that
  will cause an incident if pre-empted — see the spec's R1 and R2.
- **Deliver the media-viewer decision** (Task 6). Deferred, not dropped.
- **Purge `.claude/worktrees` from history.** Task 2 untracks it going forward, which stops it
  growing and keeps it out of the merge. The existing blobs stay in the pack. Removing them needs
  `git-filter-repo` and a full history rewrite of both repos — the force-push this plan was
  designed to avoid — in exchange for a modest win: `.git` is 45 MB despite 98.8 MB of raw content,
  because the 17 nested copies deduplicate almost perfectly. Not worth it. (`git_filter_repo` is
  importable as a Python module on this machine but not on `PATH` as a CLI, if it is ever wanted.)
- **Set up the two-tenant deploy machinery** — `.env.<tenant>` files, deploy scripts, the preflight.
  Its own plan.
