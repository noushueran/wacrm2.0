# Holidayys Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release the merged codebase to Holidayys' live CRM without emptying the Inbox or
auto-assigning a months-old backlog to the team.

**Architecture:** Amani received this work as **six separate deploys**, each inert until the next.
The merge collapses all six into one, which is what makes this dangerous. The rollout re-creates
the staging using the one lever the merge leaves intact: **Convex and Netlify deploy separately.**
Backend first (invisible to users), then the data backfill, then the frontend.

**Tech Stack:** Convex (self-hosted), Netlify, WhatsApp Cloud API.

**Parent spec:** `docs/superpowers/specs/2026-08-02-crm-codebase-unification-design.md`
**Precedent:** `docs/superpowers/specs/2026-07-27-inbox-lanes-design.md` §Rollout — the same
sequence, executed once already on Amani.

## The staging that was lost, and how it comes back

Amani's original rollout, from the inbox-lanes spec:

> 1. Deploy schema + indexes. Inert: no caller passes `lane`.
> 2. Ship the `awaitingReply` write path. Still invisible.
> 3. **Backfill.** Must reach `patched: 0` before step 4.
> 4. Ship the read side and the RBAC change.
> 5. Ship the tabs. First user-visible change.
> 6. **Ship auto-assign last**, on its own, and watch the first sweep.

One merge delivers 1-6 at once. But the frontend lives on Netlify and the backend on Convex, and
they are deployed independently — so steps 1-3 can still happen with the old frontend live, and
steps 4-5 become "deploy Netlify". That is the whole design of this plan.

### Why the gap between backend deploy and backfill is safe

Deploying Convex starts four new crons, one of which (`inbox-chase-assign`) auto-assigns
conversations and **runs by default**. There is no way to set `autoAssignEnabled: false` before that
deploy, because the field does not exist in Holidayys' schema until the deploy creates it. So there
is an unavoidable window.

That window is safe, and provably so — not by configuration but by index structure. Both halves of
the sweep read `by_account_assigned_lane_last_message` (`convex/inboxChaseAssign.ts:86-128`):

```ts
    .eq("awaitingReply", false)      // derived range
    .gt("chasingForcedAt", 0)        // forced range
```

`awaitingReply` and `chasingForcedAt` are both **new optional fields**. Until the backfill runs, no
Holidayys row has either. Convex sorts a missing field before every present value, so
`eq(false)` matches nothing and `gt(0)` matches nothing. **The sweep finds zero rows and no-ops.**

The danger begins the instant the backfill completes — which is exactly why Task 3 disables
auto-assign *before* Task 4 runs it, and why auto-assign is re-enabled last, alone, and watched.

## Global Constraints

- **The owner runs every deploy and every production mutation.** No agent session runs
  `convex deploy`, `convex dev`, `convex codegen`, or `convex run` against production. This is the
  standing rule for this project and it is also what the inbox-lanes spec said: *"Owner-run
  throughout; no agent session runs `convex deploy`."* An agent executing this plan prepares,
  verifies and reads — it does not write to production.
- **Deploy only from a clean checkout of `origin/main`.** Not from a feature branch, not from a
  dirty tree.
- **Never run two backfill loops at once.** The backfill is caller-driven and idempotent per chain,
  but *not* concurrency-safe. Overlapping backfill runs on this codebase have already caused a
  production incident, inflating figures 1.8×. One terminal, one loop.
- **Any failed verification stops the rollout.** Each task's verification gates the next. There is
  no step here whose failure is cosmetic.
- **`npx convex run` can only call `internal*` functions.** This repo's public API is wrapped in
  `accountQuery` / `accountMutation`, which resolve the tenant from an authenticated user the CLI
  does not have — `qualification.getConfig` and `cronSchedules.overview` both require a signed-in
  admin. So the only thing this plan runs from a terminal is the backfill (an `internalMutation`);
  **every other check is done in the app UI or the Convex dashboard's data browser.** Verification
  steps below name which.
- Holidayys is a live business. Every step below is timed to land outside the account's peak hours
  where it can be — the qualification engine's own working window is Mon–Sat 10:00–21:00 Dubai.

## Rollback posture

| After | To undo | Cost |
|---|---|---|
| Task 2 (Convex deploy) | Redeploy the previous commit | Schema additions are all optional, so old code tolerates new rows. Safe. |
| Task 4 (backfill) | Nothing to undo | `awaitingReply` is derived from messages; re-running recomputes it. Harmless. |
| Task 6 (frontend deploy) | Roll back the Netlify deploy | Instant. This is the only user-visible step. |
| Task 8 (auto-assign on) | Toggle it off | Assignments already made are **not** reverted automatically — see Task 8's own rollback. |

The genuinely irreversible thing in this plan is auto-assignment writing `assignedToUserId` onto
conversations. That is why it is last, alone, and watched.

---

### Task 1: Pre-flight

**Files:** none. Read-only.

**Interfaces:**
- Consumes: the merge PR from `2026-08-02-history-graft-and-merge.md`, landed on Holidayys `main`.
- Produces: a go/no-go, plus baseline numbers Task 5 and Task 7 compare against.

- [ ] **Step 1: Confirm the merge is on `main` and the tree is clean**

```bash
export H=/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0
git -C "$H" fetch origin
git -C "$H" log -1 --format='%h %s%n  parents: %p' origin/main
git -C "$H" status --porcelain | wc -l
```

Expected: the merge commit with **two** parents, and a clean tree. If `main` does not carry the
merge, stop — this plan has nothing to roll out.

- [ ] **Step 2: Confirm the suites pass on exactly what will ship**

```bash
cd "$H" && git checkout main && git pull --ff-only && npx vitest run && npx tsc --noEmit
```

Expected: PASS, no type errors. Do not roll out a commit that has not been verified locally, even
if CI is green — CI does not run against this working copy.

- [ ] **Step 3: Record the pre-deploy baseline**

In the **Convex dashboard for the Holidayys deployment**, data browser, note:

- the row count of `conversations` — Task 4 patches roughly this many
- the row count of `qualificationConfigs` — Task 3 must set the flag on every one of them

Write both down. They are the only way to tell afterwards whether the backfill and the config
change covered everything.

- [ ] **Step 4: Confirm the deployment target out loud**

```bash
grep -E 'CONVEX_SELF_HOSTED_URL|NEXT_PUBLIC_CONVEX_URL' "$H/.env.local" | sed 's/=.*/=<redacted>/'
grep -E 'CONVEX_SELF_HOSTED_URL' "$H/.env.local" | cut -d= -f2
```

Expected: a `convex-api.holidayys.co` host. **If this prints an `amaniworld.com` host, stop
immediately** — the checkout is bound to the wrong deployment and the next task would deploy
Holidayys' code onto Amani's database.

- [ ] **Step 5: Pick the window**

Schedule Tasks 2-6 outside Mon–Sat 10:00–21:00 Dubai. Between the backend deploy and the frontend
deploy the app is *functional but mid-migration*; a quiet window keeps the number of conversations
changing underneath the backfill small.

---

### Task 2: Deploy the Convex backend

**Files:** none. This is a deploy.

**Interfaces:**
- Consumes: verified `main` from Task 1.
- Produces: the new schema, indexes, write path, four new crons, and the backfill module live on
  Holidayys' Convex deployment. **The frontend is untouched, so users see nothing.**

> **OWNER-RUN.** An agent executing this plan must stop here and hand over. Do not run the deploy.

- [ ] **Step 1: Owner deploys Convex**

```bash
cd /Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0
npx convex deploy
```

Expect this to take longer than usual: five new indexes are being built on `conversations`, the
largest table. **A deploy that appears to hang is probably building indexes — let it finish.**

- [ ] **Step 2: Confirm the schema validated against live data**

A Convex deploy validates every existing document against the new schema. If it succeeded, the
additive-only analysis in the spec held. If it *failed*, it will name the table and field — stop
and report; do not retry or relax the schema.

- [ ] **Step 3: Confirm the new crons are registered**

In the live CRM, as an admin: **Settings → Cron schedules**. Nine crons should be listed — the five
that were already there plus `inbox-chase-assign`, `inbox-snooze-wake`, `lead-scoring` and
`lead-sequence`.

This panel is `cronSchedules.overview`, an `accountQuery` gated on `requireRole("admin")`, so it
needs an admin login — it cannot be read from the CLI. The Convex dashboard's Crons view is the
fallback if no admin session is available.

- [ ] **Step 4: Verify the chase-assign sweep is finding nothing**

This is the safety property the whole window rests on. Wait for at least one 30-minute interval,
then look at `inbox-chase-assign` in **Settings → Cron schedules**. The panel shows each cron's last
run and its result.

Expected: the sweep has run, and assigned **0** conversations.

If it reports a non-zero `assigned`, the pre-backfill inertness analysis is wrong — **stop and
investigate before running the backfill.** The backfill is what turns this from a trickle into the
whole backlog, so a non-zero here before Task 4 is the cheapest possible moment to catch it.

- [ ] **Step 5: Confirm the app still works on the old frontend**

Open the live Holidayys CRM. The frontend is still the pre-merge build talking to the new backend.
Send a test WhatsApp message to the business number and confirm it arrives in the Inbox.

Expected: normal operation. The backend's additions are all optional fields the old frontend
ignores. **If inbound messages stop arriving, roll back immediately** (redeploy the previous
commit) — that is the one failure here that costs real leads.

---

### Task 3: Disable auto-assign

**Files:** none. A configuration change through the app.

**Interfaces:**
- Consumes: the deployed backend from Task 2 (the field does not exist before it).
- Produces: `autoAssignEnabled: false` on every Holidayys `qualificationConfigs` row, so the sweep
  stays inert *after* the backfill lands.

Absent means **on**. Every existing Holidayys config row lacks the field, so every account is
currently opted in. This must be done before Task 4, not after.

- [ ] **Step 1: Turn the toggle off in the app**

In the live Holidayys CRM: **Settings → Lead qualification → Alerts**, switch **auto-assign** off,
and save.

The control is an ordinary switch (`src/components/settings/qualification-settings.tsx:276`) and
the save validates only that the value is a boolean
(`convex/lib/qualification/validate.ts:86`) — it does not require templates to be configured, so
this save works on an account that has never set one up.

Note the save posts the whole alerts group, so it also re-saves the admin-alert phone list and
template names as currently shown. Confirm those fields look right *before* saving.

- [ ] **Step 2: Repeat for every account**

`sweepChaseAssign` iterates **all** accounts (`ctx.db.query("accounts").collect()`), so one account
left opted in is one account whose backlog gets assigned.

Use the `accounts` row count recorded in Task 1 Step 3. If it is more than one, repeat Step 1 for
each — and confirm with the owner how to reach the others, since the settings page acts on the
signed-in user's account.

- [ ] **Step 3: Verify the flag is actually persisted**

Do not trust the toggle's visual state — read it back in the **Convex dashboard data browser**,
table `qualificationConfigs`. Check the `autoAssignEnabled` column on **every** row.

Expected: `false` on all of them. **`undefined` is not good enough** — absent means enabled
(`inboxChaseAssign.ts:70` treats only an explicit `false` as off). That distinction is the entire
point of this task, and it is invisible in the UI, where an untouched toggle and a saved-off toggle
look identical.

The number of rows showing `false` must equal the `qualificationConfigs` count from Task 1 Step 3.

---

### Task 4: Run the `awaitingReply` backfill

**Files:** none. A production data migration.

**Interfaces:**
- Consumes: `internal.inboxBackfill.backfillAwaitingReply({ cursor?, batchSize? })
  → { cursor, isDone, patched }`.
- Produces: every Holidayys conversation carrying an explicit `awaitingReply` boolean.

Until this completes, `awaitingReply` is `undefined` on every row and — once the new frontend
ships — **every lane tab reads empty**. The module's own header: *"`undefined` is not a lane, and an
un-backfilled row would be silently swallowed by whichever range it happens to sort into."*

> **OWNER-RUN**, and **one loop only**. This backfill is idempotent per chain but not
> concurrency-safe. Two loops at once have already caused a production incident on this codebase.

- [ ] **Step 1: Run one batch by hand and read the output**

Before automating, confirm the response shape:

```bash
npx convex run inboxBackfill:backfillAwaitingReply '{"batchSize": 200}'
```

Expected: `{ cursor: "...", isDone: false, patched: <n> }` with `patched` > 0 on a fresh database.
If `patched` is 0 on the very first batch, either the backfill already ran or the deployment is the
wrong one — stop and check Task 1 Step 4.

- [ ] **Step 2: Drive it to completion**

One terminal, one loop. Adjust the JSON parsing if Step 1 showed a different output shape:

```bash
CURSOR=null
TOTAL=0
while : ; do
  OUT=$(npx convex run inboxBackfill:backfillAwaitingReply \
        "{\"cursor\": $CURSOR, \"batchSize\": 200}")
  PATCHED=$(echo "$OUT" | jq -r '.patched')
  DONE=$(echo "$OUT"    | jq -r '.isDone')
  CURSOR=$(echo "$OUT"  | jq -c '.cursor')
  TOTAL=$((TOTAL + PATCHED))
  echo "batch: patched=$PATCHED  total=$TOTAL  done=$DONE"
  [ "$DONE" = "true" ] && break
done
echo "backfill complete: $TOTAL rows patched"
```

This reads one `messages` row per conversation, so it is not instant on a large table. Let it run.

- [ ] **Step 3: Confirm a second full pass reports `patched: 0`**

This is the completion signal the module documents, and the gate on everything after it.

```bash
npx convex run inboxBackfill:backfillAwaitingReply '{"batchSize": 200}'
```

Expected: `patched: 0`. If it is non-zero, the loop did not finish (or conversations were created
while it ran) — re-run Step 2 until a fresh first batch reports 0.

- [ ] **Step 4: Re-confirm auto-assign is still finding nothing**

The backfill has just made the Chasing lane real, so the sweep's inertness no longer comes from
missing data — it now rests entirely on Task 3's flag. Verify rather than assume; this is the moment
the risk becomes live.

Wait one 30-minute interval, then check `inbox-chase-assign` in **Settings → Cron schedules**.

Expected: still **0** assigned.

**If it is non-zero, an account was missed in Task 3.** Turn its toggle off immediately, then work
out which conversations were assigned and to whom — the Convex data browser can filter
`conversations` on a recently-changed `assignedToUserId`. Reassigning is manual, so catching this
within one sweep is the difference between 50 threads and a day's worth.

---

### Task 5: Verify the data before exposing it

**Files:** none. Read-only.

**Interfaces:**
- Consumes: the backfilled database.
- Produces: confidence that the tabs will be correct when they appear. **This is the last checkpoint
  before users see anything.**

- [ ] **Step 1: Confirm no conversation is left without a lane**

Every row must hold an explicit `true` or `false`. Ask the owner to run a count of conversations
where `awaitingReply` is absent — via the Convex dashboard's data browser, filtering
`conversations` on that field.

Expected: **zero**. A single row here is a conversation that will be invisible in every lane tab.

- [ ] **Step 2: Sanity-check the split**

Compare the counts of `awaitingReply: true` (Active — the customer spoke last) against `false`
(Waiting or Chasing — we spoke last).

Expected: both non-zero, and plausible for the business. All-true or all-false means the derivation
read the wrong end of the message list, and the tabs would be uniformly wrong in a way that looks
plausible on any single thread.

- [ ] **Step 3: Spot-check three threads by hand**

Pick three conversations the owner recognises — one the customer answered last, one the team
answered last, one dormant for weeks. Confirm `awaitingReply` matches reality for each.

Three hand-checked threads catch an inverted boolean that aggregate counts cannot.

---

### Task 6: Deploy the frontend

**Files:** none. This is a deploy.

**Interfaces:**
- Consumes: verified data from Task 5.
- Produces: the merged UI live — lane tabs, archive, snooze, and everything else Amani built.
  **First user-visible change.**

> **OWNER-RUN.**

- [ ] **Step 1: Confirm the brand environment variables are set on Netlify**

Before deploying, confirm the Holidayys Netlify site carries all five:
`NEXT_PUBLIC_BRAND_NAME`, `NEXT_PUBLIC_BRAND_LEGAL_NAME`, `NEXT_PUBLIC_SITE_URL`,
`NEXT_PUBLIC_BRAND_WEBSITE`, `NEXT_PUBLIC_BRAND_EMAIL` — set to **Holidayys'** values.

The build fails without them by design. That is the intended behaviour and must not be worked
around by adding a fallback: a fallback is how this site would ship displaying Amani's name.

- [ ] **Step 2: Confirm the Convex brand variables are set**

```bash
npx convex env list | grep -E 'BRAND_NAME|BRAND_SITE_URL'
```

Expected: both present, Holidayys' values. These drive push-notification titles and the ad-context
User-Agent.

- [ ] **Step 3: Deploy**

Netlify builds Holidayys from `main`. Trigger the deploy and watch the build log.

- [ ] **Step 4: Confirm the site says Holidayys**

Open the live CRM. Check, in this order:

1. The **browser tab title** — must read `Holidayys WA CRM`, not Amani.
2. The **installed PWA name**, if installed.
3. An **invite link's** preview card, if one can be generated safely.

**If any of these say Amani, roll back the Netlify deploy immediately.** The brand plan and the
merge plan both have checks for this; this is the last one, on the real rendered page, and it is
the one that matters to a customer.

---

### Task 7: Verify the app

**Files:** none. Read-only.

**Interfaces:**
- Consumes: the live merged app.
- Produces: confirmation before the final, irreversible task.

- [ ] **Step 1: The lane tabs are populated**

Open the Inbox. Active, Waiting and Chasing must each show a plausible count.

**An empty lane tab means the backfill did not take** — stop and return to Task 4. This is the exact
failure R2 exists to prevent, and it is visible here in one glance.

- [ ] **Step 2: Chasing will be large — that is expected**

From the inbox-lanes spec:

> Chasing is populated from the moment step 5 lands… The first view of it will be large: that is
> the 72h-cliff backlog becoming visible, not a new problem.

Tell the team this before they see it. A sudden queue of long-dormant leads reads as a bug or an
emergency if nobody was warned. It is neither — it is work that was always there and invisible.

- [ ] **Step 3: Send a real message end to end**

From a personal WhatsApp, message the Holidayys business number. Confirm: it arrives, it lands in
**Active** (the customer spoke last), a reply from the CRM sends, and the thread moves to
**Waiting** after the reply.

That single round trip exercises ingest, the `awaitingReply` write path, the lane derivation and
outbound send — the four things this release changed that matter most.

- [ ] **Step 4: Confirm no push notification is misbranded**

If push is enabled, trigger one and check its title reads Holidayys. This reads
`convex/lib/brand.ts` rather than the Next.js env, so it is the one brand surface Task 6 Step 4
does not cover.

---

### Task 8: Enable auto-assign, and watch it

**Files:** none. A configuration change.

**Interfaces:**
- Consumes: a verified, working app.
- Produces: auto-assignment of unowned Chasing threads. **The only irreversible step in this plan.**

Deliberately last and alone, exactly as the inbox-lanes spec staged it: *"Ship auto-assign last, on
its own, and watch the first sweep. It is the only part of this work that changes who owns a
conversation."*

- [ ] **Step 1: Warn the team first**

The first sweeps will assign up to 50 conversations every 30 minutes (`ASSIGN_PER_RUN = 50`) and
notify each new owner. Against a months-old backlog that is roughly 2,400 assignments and
notifications per day until it drains. Agents must know this is coming, or it reads as the system
malfunctioning.

Consider leaving it off entirely until the team has worked the Chasing backlog down manually. The
lanes deliver most of the value; auto-assign is an optimisation, and nothing else in this rollout
depends on it.

- [ ] **Step 2: Turn it on for ONE account**

Settings → Lead qualification → Alerts → auto-assign → on. If there are several accounts, enable
one and leave the rest off.

- [ ] **Step 3: Watch the first sweep**

Within 30 minutes, check `inbox-chase-assign` in **Settings → Cron schedules**. Stay on the page —
this is the one sweep worth watching live.

Expected: one run with `assigned` between 1 and 50, and `unroutable` small.

A large `unroutable` means no eligible agent was found — check that team members carry the tags the
routing expects. (Assignment matches a tag whose name equals the service name, against
`memberTags`; the `kbServices` routing-tag field is not used.) Every unroutable sweep also writes a
`chase_unassigned` notification to supervisors, so leaving this unfixed is a notification flood.

- [ ] **Step 4: Confirm the assignments are sensible**

Ask two agents whether the threads they just received look like theirs. Auto-assignment is a
judgement the system is making on the team's behalf; the only real test is whether the team agrees.

- [ ] **Step 5: Roll out to the remaining accounts, or roll back**

If the first account looks right, enable the rest. If not, switch it off — but note that
**assignments already made are not reverted**. Reassigning them is manual, so this decision is worth
making on one account's evidence rather than all of them.

---

### Task 9: Release to Amani

**Files:** none.

**Interfaces:**
- Consumes: a successful Holidayys rollout.
- Produces: both companies on one codebase — the goal of the whole project.

Amani's release is ordinary. Its database already satisfies the merged schema, its backfill has
already run, and its crons are already live. The merge brought Holidayys' work *to* Amani, not the
reverse, so what is new here is Holidayys' contribution: the media viewer, the AI reasoning module,
and the fixes merged in Task 5 of the graft plan.

- [ ] **Step 1: Confirm Amani's brand variables are set**

Same five on Netlify and same two on Convex as Task 6, with **Amani's** values. Amani's site was
also built from hardcoded strings until the brand plan; its first build after that change needs the
variables just as much.

- [ ] **Step 2: Owner deploys Convex, then Netlify**

```bash
cd /Volumes/CurserDisk/Dev/wa-amani
npx convex deploy
```

Then trigger the Netlify build.

No backfill, no auto-assign staging, no lane migration — those all happened on Amani weeks ago.

- [ ] **Step 3: Verify Amani says Amani**

Browser tab title, PWA name, one push notification. The same check as Task 6 Step 4, and for the
same reason in the opposite direction: this is the first Amani build whose branding comes from the
environment rather than the source.

- [ ] **Step 4: Send one message end to end**

As in Task 7 Step 3, against Amani's business number.

- [ ] **Step 5: Close the loop**

Both companies are now on one `main`. From here a change is written once and deployed twice. Record
in the PR or a follow-up note that the duplication this project set out to end is ended — and that
the next feature does not need porting.

---

## What this plan does NOT do

- **Deliver the media-viewer decision.** Still outstanding from the graft plan; Amani's zoom-and-pan
  viewer never reached `main`. Its own change.
- **Set up the two-tenant deploy machinery** — `.env.<tenant>` files, `npm run deploy:<tenant>`, the
  preflight that prints the target host. This rollout is performed by hand, carefully, once. That
  machinery is what makes the *second* and every later deploy safe, and it deserves its own plan.
  Until it exists, Task 1 Step 4's manual check is the only thing standing between a tired operator
  and deploying one company's code onto the other's database.
- **Purge `.claude/worktrees` from history.** Untracked going forward by the graft plan; the blobs
  stay in the pack.
