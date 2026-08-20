import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  validateInteractivePayload,
  type InteractiveMessagePayload,
} from "./lib/whatsapp/interactive";
import { isDeliverableUrl } from "./webhookDelivery";
import { chargeLeadIfAgent } from "./lib/leadCharge";
import { applyAssignment } from "./lib/assignment";
import { dispatchTagAdded, dispatchConversationAssigned } from "./lib/automations/triggers";
import { isDailyDue, localMinuteOfDay, parseDailyTime } from "./lib/automations/schedule";
import { blockedReason } from "./lib/notes/gate";
import { planSend, type SendMessageStepConfig } from "./lib/automations/sendPlan";
import { parseMediaKey, type MediaKind } from "./lib/r2/keys";
import { resolveMediaUrlLazy } from "./lib/r2/url";
import { r2ConfigFromEnv } from "./lib/r2/config";
import { resolveWindowState } from "./lib/whatsapp/messagingWindow";

// ============================================================
// Automations engine (Phase 6, Task 3) — Convex port of
// `src/lib/automations/engine.ts` (`runAutomationsForTrigger`,
// `executeAutomation`, `executeStepsFrom`, `runStep`, `triggerMatches`,
// `evaluateCondition`, `resumePendingExecution`) and the cron endpoint
// it fed, `src/app/api/automations/cron/route.ts`.
//
// THE key structural change from the source: a `wait` step no longer
// INSERTs an `automation_pending_executions` row for a cron job to
// later poll (`by_status_runat`) — it calls
// `ctx.scheduler.runAfter(waitMs, internal.automationsEngine.resume, {...})`
// directly. There is no cron, and the Convex `automationPendingExecutions`
// table this engine never wrote to was dropped from `schema.ts` entirely
// (Task B7) — confirmed zero non-schema references before removal.
//
// Both public entry points are `internalAction`s (never exposed to any
// client) because they may need to send over the network (Meta sends,
// `send_webhook`) and schedule follow-up work — neither of which a
// plain `internalMutation`/`internalQuery` can do. Every DB read/write
// the action needs is delegated to a small `internalQuery`/
// `internalMutation` below (actions cannot touch `ctx.db` directly);
// the actual step-tree walk (`executeStepsFrom`, mirroring the
// original's own recursive function 1:1) is a plain TypeScript
// function, not a separate Convex function — exactly like the
// original, where `executeStepsFrom`/`runStep`/`evaluateCondition` are
// plain async functions, not new HTTP/RPC endpoints.
//
// `accountId` is always an explicit, caller-supplied argument (never
// `ctx.accountId`) — there is no user session inside a trigger fired
// from a webhook or a scheduled resume, exactly like `ingest.ts`/
// `metaSend.ts`/`webhookDelivery.ts` before it. The contact-ownership
// guard `runForTrigger` runs before touching anything is the one place
// that still matters even though nothing in THIS task exposes a public
// caller yet: it mirrors the original's own guard (regression test
// GHSA-63cv-2c49-m5v3 — a `contactId` handed to the engine that
// doesn't belong to `accountId` must never let a step touch it), which
// a future public wrapper (e.g. a `/api/v1` webhook trigger) will rely
// on exactly as-is.
//
// Four deliberate deviations from a byte-literal reading of this
// task's own brief, all explained where they matter below:
//   1. The `resume` scheduler payload carries `parentStepId` in
//      addition to the brief's listed `{ automationId, contactId,
//      nextPosition, branch, logId, context }` — required for
//      correctness whenever a `wait` step sits inside a `condition`'s
//      branch (see `executeStepsFrom`'s own comment on the wait case).
//   2. `send_webhook` reuses `webhookDelivery.ts`'s exported
//      `isDeliverableUrl` SSRF guard, but does NOT call that file's
//      `dispatch` action — `dispatch` fans a system EVENT out to the
//      account's *registered* `webhookEndpoints` with a signed
//      envelope; an automation's `send_webhook` step POSTs to an
//      arbitrary, per-step URL with a custom `body_template` and no
//      signing, exactly like the original `engine.ts`'s own
//      `send_webhook` case. Only the SSRF check is shared.
//   3. (Phase 2 run-tracking, Task 3) `executeStepsFrom` finishes the
//      run — via `finishRun` — on a different condition than the one it
//      uses to finalize the log's status. The run-tracking brief's own
//      snippets gate both on `parentStepId === null` ("this is the
//      automation's tree root"), but that conflates two things that
//      only coincide on the very first, never-suspended dispatch:
//        - The log is allowed to drift: it keeps a redundant
//          `stepsExecuted` array a stale summary `status` can't corrupt,
//          so leaving its existing root-scope-only rule untouched is
//          correct and deliberate (`schema.ts`'s own comment on
//          `automationRuns.status`: the run has no such fallback, it
//          IS the one source of truth Task 5's cancellation and Task
//          7's waiting-counts both key off).
//        - The run instead needs `ExecuteArgs.isEntryCall` — "is this
//          the outermost call of the CURRENT action invocation", true
//          for both `runAutomation`'s call and every `resume` call,
//          false only for the internal recursion into a `condition`'s
//          branch — plus a `suspended` signal that recursion bubbles
//          back up. Two failure modes without this: (a) the `wait`
//          case's scheduler payload to `resume` must carry the
//          enclosing `runId` (mirroring `logId` right next to it), or
//          a resumed run can never reach `finishRun` at all and sits at
//          `status: "running"` forever; (b) even with `runId` carried
//          across, gating solely on `parentStepId === null` either
//          finishes a run the instant a `condition`'s branch merely
//          SCHEDULES a nested wait (before that branch's own resume
//          has run) — since the branch that actually suspended never
//          again sees `parentStepId === null` on resume — or, for a
//          root-level wait, is simply the correct case already. Both
//          bugs are closed together: `isEntryCall` decides WHICH calls
//          may ever finish the run, `suspended` decides WHEN, even
//          across the scheduler boundary. `resume` declaring `runId` as
//          optional (rather than required) is still deliberate: Task 4
//          (persisted waits) still owns turning the run row's status to
//          `"waiting"` and back at the suspension point itself; this
//          deviation only keeps the id (and now the entry-call
//          eligibility) alive across that gap.
//   4. (Phase 2 run-tracking, Task 4) The brief's own snippets give
//      `markRunRunning` no role in `outstandingBranches` bookkeeping, and
//      give `finishRun` no reason to refuse an already-`completed`/
//      `failed` run (only an already-`cancelled` one, carried over from
//      Task 3). Both are deliberate, not omissions: nothing in Convex
//      serializes two DIFFERENT scheduled actions against each other —
//      only each action's OWN individual mutation calls are serialized —
//      so two branches of the SAME run can resume concurrently. Putting
//      the counter's decrement in `markRunRunning` (the moment a branch
//      resumes) would let both branches' "flip to running" calls
//      complete, and both then observe the counter at zero, before
//      EITHER reaches `finishRun` — reintroducing the double-write bug
//      the counter exists to close. Decrementing inside `finishRun`
//      itself, atomically with the zero-check, closes it for real:
//      whichever of the two branches' calls runs second is guaranteed to
//      see the other's decrement already applied, so only one can ever
//      act on zero. The widened terminal-status guard is the same
//      property from the other direction — see `finishRun`'s own comment
//      for the full argument.
//   5. (Fix wave, 2026-08) Deviation #4's `outstandingBranches` shape
//      still had a live bug: `markRunWaiting` incremented on EVERY
//      `wait`, unconditionally, but the only decrement (`finishRun`)
//      was reachable solely from a scope that finishes WITHOUT hitting
//      another `wait` — which a re-suspending entry call (two or more
//      sequential `wait`s in the SAME lineage: `wait -> ... -> wait ->
//      ...`) never does, since the `wait` case returns immediately. Any
//      automation with 2+ sequential waits therefore never reached a
//      terminal `status` at all — it accumulated one un-matched credit
//      per additional wait and sat at `"running"` forever. The existing
//      fan-out tests (a `condition` spawning branches that each suspend
//      ONCE) happened to net out correctly under the old code, which is
//      why this shipped uncaught — see `outstandingBranches`'s own
//      schema comment for the corrected invariant. The fix has two
//      parts, both required together: `createRun` now seeds the count
//      at 1 instead of leaving it unset, and `markRunWaiting` only
//      increments for a suspension that is genuinely new (a nested
//      `condition` branch, `isEntryCall: false`) — an entry call's OWN
//      re-suspension is net-zero, since the scheduled function that
//      just fired to produce this call IS the credit being spent.
//      `finishRun` is correspondingly now called UNCONDITIONALLY
//      whenever an entry call's own scope runs out of steps (dropping
//      the old `!suspended` gate and the `recordRunFailure` call it
//      needed for the failed-and-suspended case — `finishRun`'s own
//      "count still above zero" branch already persists a failure
//      without finalizing, so it subsumes that job once it's reachable
//      unconditionally). Two viable shapes existed for this; seeding
//      `createRun` and making the entry call's own re-suspension
//      net-zero was chosen over decrementing inside `markRunWaiting`
//      when the caller is the entry scope because it keeps the
//      decrement living in exactly one place (`finishRun`, atomically
//      with its own zero-check) rather than splitting it across two
//      mutations — preserving deviation #4's own concurrent-resume
//      argument untouched.
// ============================================================

// ------------------------------------------------------------
// Types — inlined rather than imported from `@/types` (the Next app's
// grab-bag types module), matching `convex/lib/automations/validate.ts`'s
// own stated convention: importing across the convex/src boundary for a
// handful of shapes isn't worth the coupling. camelCase throughout,
// matching `schema.ts`'s `automations`/`automationSteps` field names
// (the originals are the Supabase snake_case row shape).
// ------------------------------------------------------------

/** Mirrors `src/lib/automations/engine.ts`'s `AutomationContext`, camelCased. */
export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  messageText?: string;
  /** Conversation the event belongs to, if any. */
  conversationId?: Id<"conversations">;
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>;
  /** The tag id that was added, matched against a tag_added trigger's
   * own `tag_id` (see `lib/automations/triggers.ts` for the dispatch
   * side). */
  tagId?: Id<"tags">;
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agentId?: Id<"users">;
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactiveReplyId?: string;
  /** Automation->automation hops so far, capped by `MAX_TRIGGER_DEPTH`.
   * Only the `add_tag` / `assign_conversation` steps' own dispatches
   * propagate it; every other trigger source starts a fresh chain at 0. */
  depth?: number;
  /** For `time_based` only: the automation the cron sweep decided was
   * due. Pins the account-wide dispatch to that one automation — see
   * `triggerMatches`. */
  automationId?: Id<"automations">;
}

interface KeywordMatchTriggerConfig {
  keywords: string[];
  match_type: "exact" | "contains";
  case_sensitive?: boolean;
}

interface InteractiveReplyTriggerConfig {
  reply_ids: string[];
}

interface TagAddedTriggerConfig {
  tag_id: string;
}

interface TimeBasedTriggerConfig {
  /** Account-local daily time, "HH:mm". */
  schedule: string;
  /** Audience: the automation runs once per contact holding this tag. */
  tag_id: string;
}

type SendButtonsStepConfig = InteractiveMessagePayload;
type SendListStepConfig = InteractiveMessagePayload;

interface SendTemplateStepConfig {
  template_name: string;
  language?: string;
  variables?: Record<string, string>;
  /** Mirrors `SendMessageFallbackConfig["header"]` above. */
  header?: { type: "image" | "video" | "document"; key?: string; url?: string };
}

interface TagStepConfig {
  tag_id: string;
}

interface AssignConversationStepConfig {
  mode: "specific" | "round_robin";
  agent_id?: string;
}

interface UpdateContactFieldStepConfig {
  field: string;
  value: string;
}

interface CreateDealStepConfig {
  pipeline_id: string;
  stage_id: string;
  title: string;
  value?: number;
}

interface WaitStepConfig {
  amount: number;
  unit: "minutes" | "hours" | "days";
}

type ConditionSubject =
  | "contact_field"
  | "tag_presence"
  | "message_content"
  | "time_of_day"
  | "session_window";

interface ConditionStepConfig {
  subject: ConditionSubject;
  operand?: string;
  value?: string;
}

interface SendWebhookStepConfig {
  url: string;
  headers?: Record<string, string>;
  body_template?: string;
}

interface StepResult {
  stepId: string;
  // The step's STABLE key (Task 10's `automationSteps.stepKey`, falling
  // back to the row id — same `?? step._id` fallback as every other
  // reader of this field, e.g. `markRunWaiting`'s call site below) —
  // carried alongside `stepId` purely so `appendLogResults` can key the
  // `automationStepStats` counter off something that survives a builder
  // save. `replaceSteps` deletes and reinserts every step row on every
  // save (even a rename-only one), so a counter keyed on `stepId` (the
  // row id) would silently reset to zero on the next edit — see
  // `automationStepStats`'s own schema comment. Never persisted onto the
  // log itself: `appendLogResults` strips it back off before writing
  // `automationLogs.stepsExecuted`, which keeps its pre-existing shape.
  stepKey: string;
  stepType: string;
  status: "success" | "failed";
  detail?: string;
}

// ------------------------------------------------------------
// Public entry points
// ------------------------------------------------------------

/**
 * Fire all active automations matching `triggerType` for `accountId`.
 * Mirrors `runAutomationsForTrigger`: must never throw (fire-and-forget
 * callers), so every per-automation failure is caught and logged
 * rather than propagated, and a bad `contactId` refuses the whole
 * dispatch silently (see the guard below).
 */
export const runForTrigger = internalAction({
  args: {
    accountId: v.id("accounts"),
    triggerType: v.string(),
    contactId: v.optional(v.id("contacts")),
    context: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const context = (args.context ?? {}) as AutomationContext;

      // Tenant isolation (GHSA-63cv-2c49-m5v3) + do-not-contact gate,
      // resolved off the SAME read: `contactId` may come from a future
      // public entrypoint that reads it straight off a request body,
      // and every automation matching this trigger can send — both
      // checks must resolve before a single automation runs, not
      // per-automation.
      //
      // A contact that doesn't belong to `accountId` refuses silently
      // (no log at all, exactly as before) rather than a distinct error
      // that would leak whether a given contact id exists in some other
      // account. A contact that DOES belong here but is flagged
      // `doNotContact` is a different failure mode — not a security
      // refusal, an explicable skip — so `blocked` stays a normal
      // boolean threaded into the loop below rather than an early
      // return: each matching automation still gets its usual
      // `automationLogs` row (recorded via `recordBlockedRun`, not
      // `runAutomation`), so a blocked run is explicable afterwards
      // exactly like `broadcasts.ts`'s own recipient-level skip.
      let blocked = false;
      if (args.contactId) {
        const contact = await ctx.runQuery(
          internal.automationsEngine.getOwnedContact,
          { accountId: args.accountId, contactId: args.contactId },
        );
        if (!contact) {
          console.warn(
            "[automations] contact not in account, refusing dispatch",
            args.contactId,
          );
          return;
        }
        blocked = blockedReason(contact) !== null;
      }

      const automations: Doc<"automations">[] = await ctx.runQuery(
        internal.automationsEngine.listActiveAutomations,
        { accountId: args.accountId, triggerType: args.triggerType },
      );
      if (automations.length === 0) return;

      for (const automation of automations) {
        if (!triggerMatches(automation, context)) continue;
        try {
          if (blocked) {
            await recordBlockedRun(ctx, automation, {
              contactId: args.contactId ?? null,
              triggerType: args.triggerType,
            });
            continue;
          }
          await runAutomation(ctx, automation, {
            contactId: args.contactId ?? null,
            context,
            triggerType: args.triggerType,
          });
        } catch (err) {
          console.error("[automations] execute failed:", automation._id, err);
        }
      }
    } catch (err) {
      console.error("[automations] dispatch failed:", err);
    }
  },
});

/**
 * Resume a run parked at a `wait` step. Scheduled directly by
 * `executeStepsFrom` via `ctx.scheduler.runAfter` — this is the
 * replacement for `resumePendingExecution` + the cron endpoint that
 * used to drain `automation_pending_executions`. Never throws outward
 * (a scheduled function failing is logged, not surfaced to anything
 * that could react to it).
 */
export const resume = internalAction({
  args: {
    automationId: v.id("automations"),
    contactId: v.optional(v.id("contacts")),
    parentStepId: v.optional(v.id("automationSteps")),
    branch: v.optional(v.union(v.literal("yes"), v.literal("no"))),
    nextPosition: v.number(),
    logId: v.optional(v.id("automationLogs")),
    // Optional (not required): the wait case that schedules this
    // action always supplies its own run's id (see this file's header
    // comment #3), but keeping it optional here means a stale
    // scheduled call from before that field existed still type-checks
    // and simply runs with no run to finish.
    runId: v.optional(v.id("automationRuns")),
    context: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<void> => {
    const automation: Doc<"automations"> | null = await ctx.runQuery(
      internal.automationsEngine.getAutomation,
      { automationId: args.automationId },
    );
    if (!automation) {
      console.error("[automations] resume: missing automation", args.automationId);
      return;
    }

    // A cancelled run must not restart — Task 4: the guard that makes
    // cancellation actually stop a send rather than merely relabel a
    // row. Checked before the isActive gate and the do-not-contact gate
    // below, and before touching any step: a cancelled run must do
    // nothing further at all, not even append a do-not-contact (or
    // deactivated-automation) log entry.
    // `ctx.scheduler.cancel` (Task 5) and an already-dequeued resume can
    // interleave, so this re-checks the run's CURRENT status rather than
    // trusting that scheduling a cancellation means this call never
    // fires — see `markRunRunning`'s own comment.
    if (args.runId) {
      const canRun: boolean = await ctx.runMutation(
        internal.automationsEngine.markRunRunning,
        { runId: args.runId },
      );
      if (!canRun) return;
    }

    // Fix wave (2026-08): deactivation must be an INVARIANT `resume`
    // itself enforces, not a one-shot sweep. `setActive`/`update`
    // schedule `cancelRunsForAutomation` when an automation is turned
    // off, but that mutation's own query deliberately excludes a run
    // that is `status: "running"` with `outstandingBranches: 0` (see
    // its comment) — exactly what a run reads during the window between
    // `createRun` and its first `markRunWaiting`. A run enrolled just
    // before deactivation and still mid-flight on its very first step
    // (e.g. an in-progress Meta send) parks on its `wait` anyway once
    // that step finishes, and this resume would otherwise still fire it
    // — verbatim the bug this phase exists to close. Re-checking here,
    // on every resume, closes the gap deterministically regardless of
    // whether the sweep ever ran or caught this specific run: even a
    // cancellation that was missed reaches a dead end the moment it next
    // wakes up.
    //
    // Re-review fix (2026-08): moved to sit AFTER the cancelled-run
    // guard above, not before it. Originally placed before
    // `markRunRunning`, which meant a run that was BOTH already
    // cancelled AND belonged to a now-inactive automation still had
    // this gate append a `"failed"` log result before the cancelled-run
    // guard ever got a chance to short-circuit — `appendLogResults` has
    // no status check of its own, so the LOG got relabelled
    // `partial -> failed` even though the RUN itself stayed untouched
    // (`finishRun` already refuses an already-cancelled run). That
    // contradicts the cancelled-run guard's own contract immediately
    // above: a cancelled run must do nothing further at all, not even
    // append a log entry. This gate now occupies the exact position the
    // do-not-contact gate below already does, for the identical reason:
    // both must run strictly after `markRunRunning` has had its chance
    // to refuse. Still mirrors the do-not-contact gate's own shape (log
    // + finishRun + return) so this branch's own outstanding-branch
    // slot is released rather than leaving it stranded at "waiting"/
    // "running" forever — trading one never-terminates bug (finding 1)
    // for another.
    if (!automation.isActive) {
      console.warn(
        "[automations] resume: automation is no longer active, skipping resume",
        args.automationId,
      );
      if (args.logId) {
        await ctx.runMutation(internal.automationsEngine.appendLogResults, {
          logId: args.logId,
          newItems: [],
          status: "failed",
          errorMessage: "automation deactivated before this wait resumed",
        });
      }
      if (args.runId) {
        await ctx.runMutation(internal.automationsEngine.finishRun, {
          runId: args.runId,
          status: "failed",
          errorMessage: "automation deactivated before this wait resumed",
        });
      }
      return;
    }

    // Same do-not-contact gate as `runForTrigger`, required
    // INDEPENDENTLY here — a `wait` step can suspend for minutes,
    // hours, or days, and that suspension window is exactly when an
    // agent flags a contact. Re-checking only at initial dispatch would
    // miss every resume that fires after the flag was set.
    // `getOwnedContact` fails closed the same way `blockedReason` itself
    // does: a contact deleted mid-wait (or that never belonged to this
    // automation's account) reads as blocked, not as "nothing to check".
    if (args.contactId) {
      const contact = await ctx.runQuery(
        internal.automationsEngine.getOwnedContact,
        { accountId: automation.accountId, contactId: args.contactId },
      );
      if (blockedReason(contact) !== null) {
        console.warn(
          "[automations] resume: contact is do-not-contact, skipping resume",
          args.contactId,
        );
        if (args.logId) {
          await ctx.runMutation(internal.automationsEngine.appendLogResults, {
            logId: args.logId,
            newItems: [],
            status: "failed",
            errorMessage: "do_not_contact: contact opted out before this wait resumed",
          });
        }
        // Fix round (post-review): this branch's own suspension has to
        // be accounted for here, or `outstandingBranches` never reaches
        // zero and the run is stranded at "running" forever — invisible
        // to any `status === "waiting"` query and unreachable by later
        // cancellation, since `markRunRunning` above already flipped it
        // out of "waiting" and cleared `resumeAt`/`scheduledFnId` before
        // this gate was even reached. `finishRun` is the exact
        // mechanism already built for this: it decrements
        // `outstandingBranches` atomically with its own zero-check, so
        // if another branch of this SAME run is still outstanding this
        // just durably records the failure and leaves the run running
        // (matching `finishRun`'s own "not yet" path — see its
        // comment), and only finalizes once every branch, including
        // this one, is accounted for. A cancelled run stays cancelled:
        // `finishRun`'s own guard already refuses an already-terminal
        // run, and `markRunRunning` above would have already returned
        // `false` for one, so this line is never reached for it.
        if (args.runId) {
          await ctx.runMutation(internal.automationsEngine.finishRun, {
            runId: args.runId,
            status: "failed",
            errorMessage: "do_not_contact: contact opted out before this wait resumed",
          });
        }
        return;
      }
    }

    try {
      const allSteps: Doc<"automationSteps">[] = await ctx.runQuery(
        internal.automationsEngine.listSteps,
        { automationId: args.automationId },
      );
      await executeStepsFrom(ctx, allSteps, {
        automation,
        contactId: args.contactId ?? null,
        context: (args.context ?? {}) as AutomationContext,
        parentStepId: args.parentStepId ?? null,
        branch: args.branch ?? null,
        startPosition: args.nextPosition,
        logId: args.logId ?? null,
        runId: args.runId ?? null,
        // Always the entry call for this action invocation, even though
        // `parentStepId` here may be a condition's id (non-null) when
        // resuming a wait that was nested in a branch — see
        // `ExecuteArgs.isEntryCall`'s own comment.
        isEntryCall: true,
      });
      // No execution-counter bump here — matches `resumePendingExecution`,
      // which only ever continues `executeStepsFrom` and flips the
      // pending row's status. The counter is bumped exactly once, at
      // the INITIAL dispatch (`runAutomation` below), regardless of how
      // many waits the run later suspends through.
    } catch (err) {
      console.error("[automations] resume failed:", err);
    }
  },
});

/**
 * Cron entry point for `time_based` automations — the trigger the
 * builder has always offered with no engine behind it at all (no cron
 * entry existed in `crons.ts`, so a "Time-Based" automation validated,
 * activated, and fired nothing, forever).
 *
 * A time-based automation has no triggering contact, so its audience is
 * configured on the trigger: `{ schedule: "09:00", tag_id }` runs the
 * automation once per contact holding that tag, at that account-local
 * time, once a day.
 *
 * Claim-then-fan-out, deliberately in that order. `claimTimeBasedRun`
 * re-checks dueness and stamps `lastExecutedAt` inside ONE transaction,
 * so two overlapping sweeps cannot both fire the same automation — the
 * exact failure mode that inflated a prod backfill 1.8x when a
 * self-scheduling job was assumed to be concurrency-safe because it was
 * idempotent per chain.
 */
export const sweepTimeBased = internalAction({
  args: {},
  handler: async (ctx): Promise<{ fired: number; contacts: number }> => {
    const due: TimeBasedDue[] = await ctx.runQuery(
      internal.automationsEngine.listDueTimeBased,
      { nowMs: Date.now() },
    );

    let fired = 0;
    let contacts = 0;

    for (const item of due) {
      const claimed: boolean = await ctx.runMutation(
        internal.automationsEngine.claimTimeBasedRun,
        {
          automationId: item.automationId,
          nowMs: Date.now(),
          utcOffsetMinutes: item.utcOffsetMinutes,
          scheduledMinute: item.scheduledMinute,
        },
      );
      if (!claimed) continue;
      fired++;

      if (item.truncated) {
        // Never let a bounded audience read as a complete one.
        console.warn(
          "[automations] time_based audience truncated",
          {
            automationId: item.automationId,
            cap: MAX_TIME_BASED_CONTACTS,
            tagId: item.tagId,
          },
        );
      }

      for (const contactId of item.contactIds) {
        contacts++;
        // Per contact, so every existing guard still applies: tenant
        // ownership, do-not-contact, and its own automationLogs row.
        await ctx.runAction(internal.automationsEngine.runForTrigger, {
          accountId: item.accountId,
          triggerType: "time_based",
          contactId,
          context: { automationId: item.automationId, tagId: item.tagId },
        });
      }
    }

    return { fired, contacts };
  },
});

// ------------------------------------------------------------
// Internal execution (plain functions — mirror the original's own
// `executeAutomation`/`executeStepsFrom`/`runStep`/`evaluateCondition`,
// just calling `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction`/
// `ctx.scheduler` instead of a Supabase client).
// ------------------------------------------------------------

async function runAutomation(
  ctx: ActionCtx,
  automation: Doc<"automations">,
  input: { contactId: Id<"contacts"> | null; context: AutomationContext; triggerType: string },
): Promise<void> {
  const logId: Id<"automationLogs"> = await ctx.runMutation(
    internal.automationsEngine.createLog,
    {
      accountId: automation.accountId,
      createdByUserId: automation.createdByUserId,
      automationId: automation._id,
      contactId: input.contactId ?? undefined,
      triggerEvent: input.triggerType,
    },
  );

  // One `automationRuns` row per enrolment — created immediately, so
  // even a run that fails on its very first step (or suspends on a
  // `wait`) is observable, not just runs that make it to the end.
  // Mirrors `createLog` immediately above: same account/automation/
  // contact/conversation, plus a back-reference to the log this run's
  // own row is telling the same story as.
  const runId: Id<"automationRuns"> = await ctx.runMutation(
    internal.automationsEngine.createRun,
    {
      accountId: automation.accountId,
      automationId: automation._id,
      contactId: input.contactId ?? undefined,
      conversationId: input.context.conversationId,
      logId,
      context: input.context,
    },
  );

  const allSteps: Doc<"automationSteps">[] = await ctx.runQuery(
    internal.automationsEngine.listSteps,
    { automationId: automation._id },
  );

  await executeStepsFrom(ctx, allSteps, {
    automation,
    contactId: input.contactId,
    context: input.context,
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId,
    runId,
    isEntryCall: true,
  });

  // Atomic +1 (a single `internalMutation` read-patch — Convex has no
  // concurrent-write race the way the original's SQL RPC guarded
  // against, but the shape mirrors `increment_automation_execution_count`
  // 1:1, including its `last_executed_at = NOW()` refresh).
  await ctx.runMutation(internal.automationsEngine.bumpExecutionCount, {
    automationId: automation._id,
  });
}

/**
 * The do-not-contact counterpart to `runAutomation` — writes the exact
 * same `automationLogs` shape a real run would (via `createLog` +
 * `appendLogResults`), so a blocked run is explicable afterwards in the
 * automation's own log history rather than vanishing without a trace.
 * Deliberately does NOT call `executeStepsFrom` (no step ever runs, so
 * nothing can send) and does NOT bump `executionCount` — that counter
 * means "this automation actually ran", and a blocked automation didn't.
 * `status: "failed"` reuses the log's existing terminal shape (no
 * "skipped"/"blocked" literal exists on `automationLogs.status`) —
 * mirrors `broadcasts.ts` reusing its own recipient `"failed"` status
 * for the identical do-not-contact skip.
 */
async function recordBlockedRun(
  ctx: ActionCtx,
  automation: Doc<"automations">,
  input: { contactId: Id<"contacts"> | null; triggerType: string },
): Promise<void> {
  const logId: Id<"automationLogs"> = await ctx.runMutation(
    internal.automationsEngine.createLog,
    {
      accountId: automation.accountId,
      createdByUserId: automation.createdByUserId,
      automationId: automation._id,
      contactId: input.contactId ?? undefined,
      triggerEvent: input.triggerType,
    },
  );
  await ctx.runMutation(internal.automationsEngine.appendLogResults, {
    logId,
    newItems: [],
    status: "failed",
    errorMessage: "do_not_contact: contact has opted out, automation not executed",
  });
}

interface ExecuteArgs {
  automation: Doc<"automations">;
  contactId: Id<"contacts"> | null;
  context: AutomationContext;
  parentStepId: Id<"automationSteps"> | null;
  branch: "yes" | "no" | null;
  startPosition: number;
  logId: Id<"automationLogs"> | null;
  runId: Id<"automationRuns"> | null;
  // Distinct from `parentStepId === null` ("this scope sits at the
  // automation's tree root"). `isEntryCall` instead means "this
  // invocation of `executeStepsFrom` is the one `runAutomation` or
  // `resume` itself made" — i.e. the outermost call of the current
  // action invocation, as opposed to an inner call made by THIS SAME
  // invocation recursing into a `condition`'s branch. The two coincide
  // for the very first dispatch (which always starts at
  // `parentStepId: null`), but diverge for `resume`: a `wait` nested
  // inside a `condition` schedules its resume with that condition's own
  // (non-null) `parentStepId`, so the resumed call's `parentStepId` is
  // NOT `null` even though it is, once again, the outermost call of
  // that action invocation. Only an entry call may ever call
  // `finishRun` — see the two use sites below.
  isEntryCall: boolean;
}

/**
 * Filters `allSteps` (the whole automation's steps, fetched once by
 * the caller) down to one (parentStepId, branch) scope, `position`-
 * ordered from `startPosition` — the in-memory equivalent of the
 * original's `automation_steps` query (`.eq('parent_step_id', ...)`
 * `.eq('branch', ...)` `.gte('position', ...)` `.order('position')`).
 * Root-level steps have no `parentStepId`; a condition's children set
 * both `parentStepId` (the condition step's own id) and `branch`.
 */
function scopedSteps(
  allSteps: Doc<"automationSteps">[],
  parentStepId: Id<"automationSteps"> | null,
  branch: "yes" | "no" | null,
  fromPosition: number,
): Doc<"automationSteps">[] {
  return allSteps
    .filter((s) => {
      if (parentStepId === null) return !s.parentStepId;
      return s.parentStepId === parentStepId && (s.branch ?? "yes") === (branch ?? "yes");
    })
    .filter((s) => s.position >= fromPosition)
    .sort((a, b) => a.position - b.position);
}

/**
 * Walks one (parentStepId, branch) scope from `startPosition`, exactly
 * like before — but now returns whether ANY step it touched, at any
 * nesting depth, suspended this call's own subtree on a `wait` without
 * resolving it (`true`), as opposed to running that whole subtree to
 * completion synchronously (`false`). A `condition` branch's own call
 * ORs its return into the caller's, so the signal reaches the entry
 * call regardless of how many `condition`s it passed through — see the
 * `isEntryCall && !suspended` guards below, the only two places this
 * return value is consumed.
 */
async function executeStepsFrom(
  ctx: ActionCtx,
  allSteps: Doc<"automationSteps">[],
  args: ExecuteArgs,
): Promise<boolean> {
  const steps = scopedSteps(allSteps, args.parentStepId, args.branch, args.startPosition);

  if (steps.length === 0) {
    if (args.parentStepId === null && args.logId) {
      await ctx.runMutation(internal.automationsEngine.appendLogResults, {
        logId: args.logId,
        newItems: [],
        status: "success",
        errorMessage: undefined,
      });
    }
    // Reachable for a real, non-degenerate automation too — not just
    // "zero steps configured" (already unreachable; `validateStepsFor
    // Activation` refuses that at every write path): a `resume` can
    // land exactly one past the last step of its own scope whenever a
    // `wait` was that scope's final step. That is still this call's
    // own subtree finishing cleanly, so an entry call finishes the run
    // here too, same as the loop's own tail below.
    if (args.isEntryCall && args.runId) {
      await ctx.runMutation(internal.automationsEngine.finishRun, {
        runId: args.runId,
        status: "completed",
        errorMessage: undefined,
      });
    }
    return false;
  }

  const results: StepResult[] = [];
  let status: "success" | "partial" | "failed" = "success";
  let errorMessage: string | undefined;
  // True once any condition branch below reports it suspended
  // somewhere in ITS OWN subtree (whether directly, on one of its own
  // steps, or transitively through a branch nested even deeper inside
  // it). Deliberately NOT set by this scope's own `wait` case — that
  // case returns immediately instead, so it never reaches this flag at
  // all (see the `return true` there).
  let suspended = false;

  for (const step of steps) {
    // `wait` is the suspension point: schedule `resume` and stop
    // processing THIS scope. `parentStepId`/`branch` travel with it
    // (see this file's header comment #1) so a wait nested inside a
    // condition's branch resumes back into that same branch, not the
    // automation's root.
    if (step.stepType === "wait") {
      const cfg = step.stepConfig as WaitStepConfig;
      const ms = waitMs(cfg);
      results.push({
        stepId: step._id,
        stepKey: step.stepKey ?? step._id,
        stepType: step.stepType,
        status: "success",
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      });
      // A wait ALWAYS marks the whole log 'partial', even nested
      // inside a branch — matches the original's own unconditional
      // `status = 'partial'` in this exact spot (unlike the
      // success/failed finalization below, which only overwrites
      // status at the root scope).
      await ctx.runMutation(internal.automationsEngine.appendLogResults, {
        logId: args.logId ?? undefined,
        newItems: results,
        status: "partial",
        errorMessage,
      });
      const resumeAt = Date.now() + ms;
      // `runAfter` returns the scheduled function's own id — capturing
      // it (rather than assuming a shape) is what makes this wait
      // cancellable: it's the id Task 5's cancellation hands to
      // `ctx.scheduler.cancel`.
      const scheduledFnId = await ctx.scheduler.runAfter(ms, internal.automationsEngine.resume, {
        automationId: args.automation._id,
        contactId: args.contactId ?? undefined,
        parentStepId: args.parentStepId ?? undefined,
        branch: args.branch ?? undefined,
        nextPosition: step.position + 1,
        logId: args.logId ?? undefined,
        // See this file's header comment #3: without this, a run that
        // ever suspends on a `wait` would never reach `finishRun`.
        runId: args.runId ?? undefined,
        context: args.context,
      });
      // Persist the suspension (Task 4) — before this, a wait called
      // `ctx.scheduler.runAfter` and left no durable trace at all, so a
      // queued contact was invisible, uncountable, and uncancellable.
      // `step.stepKey` is the step's stable key (Task 10 — survives a
      // builder re-save); a step that predates key-minting has none
      // yet, so fall back to its row id. Still enough to record a
      // position; just not guaranteed to survive an edit made while
      // this run is parked there, same pre-existing limitation
      // `automationRuns.parentStepId` already has (see Task 10's own
      // report).
      if (args.runId) {
        await ctx.runMutation(internal.automationsEngine.markRunWaiting, {
          runId: args.runId,
          currentStepKey: step.stepKey ?? step._id,
          parentStepId: args.parentStepId ?? undefined,
          branch: args.branch ?? undefined,
          nextPosition: step.position + 1,
          resumeAt,
          scheduledFnId,
          // See `markRunWaiting`'s own comment: this call's `isEntryCall`
          // is exactly the signal it needs to decide whether this wait
          // is a genuinely new outstanding branch or this same lineage's
          // existing slot moving to a new suspension point.
          isEntryCall: args.isEntryCall,
        });
      }
      // This call's own subtree is now suspended — the resume above is
      // what eventually finishes it, whether that resume lands back on
      // this same entry call's scope (root-level wait) or on a scope
      // nested under it (wait inside a condition branch); either way it
      // will itself be a fresh `isEntryCall: true` invocation. See
      // `resume`'s own call site and `ExecuteArgs.isEntryCall`.
      return true;
    }

    try {
      if (step.stepType === "condition") {
        const cfg = step.stepConfig as ConditionStepConfig;
        const taken = await evaluateCondition(ctx, cfg, args);
        results.push({
          stepId: step._id,
          stepKey: step.stepKey ?? step._id,
          stepType: "condition",
          status: "success",
          detail: `branch=${taken ? "yes" : "no"}`,
        });
        // Recurse into the chosen branch at position 0. The ROOT
        // scope's own loop continues to its next sibling step right
        // after this `await` returns, whether the branch finished
        // outright or itself suspended on a nested wait — matches the
        // original's own `continue` here exactly (a branch's wait does
        // not pause its parent's later siblings).
        const branchSuspended = await executeStepsFrom(ctx, allSteps, {
          ...args,
          parentStepId: step._id,
          branch: taken ? "yes" : "no",
          startPosition: 0,
          // Never an entry call: a condition's branch is always a
          // nested continuation of THIS invocation, whether or not
          // `args.isEntryCall` is itself true for the current scope.
          isEntryCall: false,
        });
        // Bubble a suspension up regardless of nesting depth — this
        // scope may itself be nested several `condition`s deep, and
        // its own caller needs to know a wait is still pending
        // somewhere below it, all the way up to whichever call is the
        // entry call.
        if (branchSuspended) suspended = true;
        continue;
      }

      const detail = await runStep(ctx, step, args);
      results.push({
        stepId: step._id,
        stepKey: step.stepKey ?? step._id,
        stepType: step.stepType,
        status: "success",
        detail,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        stepId: step._id,
        stepKey: step.stepKey ?? step._id,
        stepType: step.stepType,
        status: "failed",
        detail: msg,
      });
      status = "failed";
      errorMessage = msg;
      break;
    }
  }

  // Only the root scope's completion overwrites the log's overall
  // status; a nested branch's own completion just appends its steps
  // (the original's `appendResults(..., null, errorMessage)` for any
  // `parentStepId !== null` scope). Unchanged by the `isEntryCall`
  // mechanism below: the log has its own redundant `stepsExecuted`
  // array to fall back on, so its pre-existing "root scope only"
  // (`parentStepId === null`) rule is left exactly as it was.
  await ctx.runMutation(internal.automationsEngine.appendLogResults, {
    logId: args.logId ?? undefined,
    newItems: results,
    status: args.parentStepId === null ? status : undefined,
    errorMessage,
  });

  // The run has no such fallback — `status` is its ONLY source of
  // truth (see the field's own comment in `schema.ts`), so unlike the
  // log update just above, this guard is NOT `parentStepId === null`:
  // an entry call resuming into a nested branch (`parentStepId` set to
  // that branch's condition) must still be able to finish the run once
  // ITS OWN subtree — not the whole automation's original root scope,
  // which may have already returned in a prior action invocation —
  // finishes.
  //
  // Fix wave (2026-08): called UNCONDITIONALLY whenever this is an
  // entry call, regardless of `suspended` — previously gated on
  // `!suspended`, with a separate `recordRunFailure` call for the
  // `suspended && failed` case (see that mutation's own comment on why
  // it's now unused). This scope reaching here (rather than returning
  // early from inside the loop above) means its OWN top-level steps are
  // exhausted WITHOUT it directly hitting another `wait` — i.e. this
  // call's own lineage-slot (seeded by `createRun`, or held across a
  // resume — see `markRunWaiting`'s comment) is genuinely spent, whether
  // that's because everything below it finished outright (`!suspended`)
  // or because it finished merely DELEGATING to a `condition` branch
  // that is still suspended (`suspended`, from the recursive call's own
  // `isEntryCall: false` — see `markRunWaiting`, which credited that
  // branch its OWN separate slot). `finishRun`'s own count-vs-zero check
  // is what keeps this from prematurely finalizing in the second case:
  // it decrements THIS call's slot and, finding the branch's slot still
  // outstanding, persists the count (and this call's own failure, if
  // any) without touching `status`/`endedAt` — exactly the fix for the
  // bug where a root `condition` whose branch suspended left the run
  // `"completed"` immediately, before that branch's resume had even
  // run, WITHOUT reintroducing the newer bug where a re-suspending
  // entry call's slot was never released at all.
  if (args.isEntryCall && args.runId) {
    await ctx.runMutation(internal.automationsEngine.finishRun, {
      runId: args.runId,
      status: status === "failed" ? "failed" : "completed",
      errorMessage,
    });
  }

  return suspended;
}

async function evaluateCondition(
  ctx: ActionCtx,
  cfg: ConditionStepConfig,
  args: ExecuteArgs,
): Promise<boolean> {
  switch (cfg.subject) {
    case "tag_presence":
    case "contact_field":
      return await ctx.runQuery(internal.automationsEngine.evaluateConditionQuery, {
        accountId: args.automation.accountId,
        contactId: args.contactId ?? undefined,
        subject: cfg.subject,
        operand: cfg.operand,
        value: cfg.value,
      });
    case "message_content": {
      const text = (args.context.messageText ?? "").toString();
      return text.toLowerCase().includes((cfg.value ?? "").toLowerCase());
    }
    case "time_of_day": {
      // operand form "HH:mm-HH:mm" — true if account-local now is inside
      // that window (over-midnight ranges like "18:00-09:00" supported).
      const [from, to] = (cfg.operand ?? "").split("-");
      if (!from || !to) return false;
      const offsetMinutes = await ctx.runQuery(
        internal.automationsEngine.accountUtcOffsetQuery,
        { accountId: args.automation.accountId },
      );
      const mins = localMinuteOfDay(Date.now(), offsetMinutes);
      const parse = (s: string) => {
        const [h, m] = s.split(":").map(Number);
        return (h || 0) * 60 + (m || 0);
      };
      const f = parse(from);
      const t = parse(to);
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t;
    }
    case "session_window": {
      // operand "open" (default) is true while free-form sends are
      // permitted; "closed" inverts it. Reuses `resolveWindowQuery`
      // (Task 5) — the same authoritative check the send step's own
      // fallback gate uses — rather than a second window resolver.
      const target = await resolveSendTarget(ctx, args).catch(() => null);
      if (!target) return false;
      const state: { canSendFreeForm: boolean; expiresAt?: number; remainingMs: number } =
        await ctx.runQuery(internal.automationsEngine.resolveWindowQuery, {
          accountId: args.automation.accountId,
          conversationId: target.conversationId,
        });
      return cfg.operand === "closed" ? !state.canSendFreeForm : state.canSendFreeForm;
    }
    default:
      return false;
  }
}

async function resolveSendTarget(
  ctx: ActionCtx,
  args: ExecuteArgs,
): Promise<{ conversationId: Id<"conversations">; to: string }> {
  if (!args.contactId) throw new Error("cannot resolve conversation: no contact");
  const result: { conversationId: Id<"conversations">; to: string } | null = await ctx.runQuery(
    internal.automationsEngine.resolveSendTargetQuery,
    {
      accountId: args.automation.accountId,
      contactId: args.contactId,
      conversationId: args.context.conversationId,
    },
  );
  if (!result) throw new Error("no conversation for contact");
  return result;
}

/**
 * The ONLY `MediaKind` an automation's send step may transmit. Mirrors
 * `flowsEngine.ts`'s `FLOW_SENDABLE_MEDIA_KINDS` and exists for the same
 * reason: even a key this account owns could name a kind that must never
 * reach a customer — most importantly `"note"`, which is internal-only
 * evidence. This dispatch path calls `internal.metaSend.*` directly, so
 * it never passes through `send.ts`'s own check.
 */
const AUTOMATION_SENDABLE_MEDIA_KINDS: ReadonlySet<MediaKind> = new Set(["automation"]);

/**
 * Resolve a send step's media to a URL Meta can fetch, refusing any key
 * that is not this account's own `automation`-kind object. Same guard,
 * and same rationale, as `flowsEngine.ts`'s `send_media` node.
 */
function resolveMediaLink(
  accountId: Id<"accounts">,
  key: string | undefined,
  url: string | undefined,
): string {
  if (key) {
    const parsed = parseMediaKey(key);
    if (
      !parsed ||
      parsed.accountId !== accountId ||
      !AUTOMATION_SENDABLE_MEDIA_KINDS.has(parsed.kind)
    ) {
      throw new Error("media_key does not belong to this account");
    }
  }
  const link = resolveMediaUrlLazy(r2ConfigFromEnv, { key, url });
  if (!link) throw new Error("send_message media has no key or url");
  return link;
}

/**
 * Meta templates use positional {{1}}, {{2}}, … placeholders, so params
 * MUST be emitted in strict numeric order — lexicographic sort of "1",
 * "2", …, "10" yields "1", "10", "2", … which silently scrambles any
 * template with ≥10 variables. Ported verbatim from `engine.ts`.
 */
function sortTemplateParams(variables: Record<string, string>): string[] {
  return Object.keys(variables)
    .sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      const aNum = Number.isFinite(na);
      const bNum = Number.isFinite(nb);
      if (aNum && bNum) return na - nb;
      if (aNum) return -1;
      if (bNum) return 1;
      return a.localeCompare(b);
    })
    .map((k) => String(variables[k]));
}

async function runStep(ctx: ActionCtx, step: Doc<"automationSteps">, args: ExecuteArgs): Promise<string> {
  switch (step.stepType) {
    case "send_message": {
      const cfg = step.stepConfig as SendMessageStepConfig;
      if (!args.contactId) throw new Error("send_message needs a contact");

      const interpolated: SendMessageStepConfig = {
        ...cfg,
        text: cfg.text ? interpolate(cfg.text, args.context) : undefined,
      };
      const plan = planSend(interpolated);
      if (plan.kind === "empty") throw new Error("send_message has nothing to send");

      if (plan.kind === "interactive") {
        const check = validateInteractivePayload(plan.payload);
        if (!check.ok) throw new Error(check.error);
      }

      const { conversationId, to } = await resolveSendTarget(ctx, args);
      const accountId = args.automation.accountId;

      // Meta's 24h customer service window governs whether a free-form
      // (non-template) send is even legal — `resolveWindowQuery` feeds the
      // request into the same pure `resolveWindowState` the qualification
      // engine already uses (`lib/whatsapp/messagingWindow.ts`), so this
      // is the one authoritative check, not a second implementation of
      // the window arithmetic. Closed window: send the step's configured
      // fallback template instead, or fail HERE — legibly, before any
      // network call — rather than let a free-form send reach Meta and
      // 400 (what happened before this check existed).
      const windowState: { canSendFreeForm: boolean; expiresAt?: number; remainingMs: number } =
        await ctx.runQuery(internal.automationsEngine.resolveWindowQuery, {
          accountId,
          conversationId,
        });

      if (!windowState.canSendFreeForm) {
        const fb = cfg.fallback;
        if (!fb?.template_name) {
          throw new Error("24h window closed and no fallback template configured");
        }
        const header = fb.header
          ? {
              type: fb.header.type,
              link: resolveMediaLink(accountId, fb.header.key, fb.header.url),
            }
          : undefined;
        const r: { whatsappMessageId: string } = await ctx.runAction(
          internal.metaSend.sendTemplate,
          {
            accountId,
            conversationId,
            to,
            templateName: fb.template_name,
            language: fb.language,
            params: fb.variables ? sortTemplateParams(fb.variables) : [],
            header,
          },
        );
        return `window closed — fallback template sent via Meta (${r.whatsappMessageId})`;
      }

      if (plan.kind === "text") {
        const r: { whatsappMessageId: string } = await ctx.runAction(
          internal.metaSend.sendText,
          { accountId, conversationId, to, text: plan.text },
        );
        return `sent via Meta (${r.whatsappMessageId})`;
      }

      if (plan.kind === "interactive") {
        const r: { whatsappMessageId: string } = await ctx.runAction(
          internal.metaSend.sendInteractive,
          { accountId, conversationId, to, payload: plan.payload },
        );
        return `interactive sent via Meta (${r.whatsappMessageId})`;
      }

      // Both remaining plans send media first. Resolve and guard once.
      const link = resolveMediaLink(accountId, plan.key, plan.url);
      const mediaKind = plan.kind === "media_then_text" ? "audio" : plan.mediaType;
      const media: { whatsappMessageId: string } = await ctx.runAction(
        internal.metaSend.sendMedia,
        {
          accountId,
          conversationId,
          to,
          kind: mediaKind,
          link,
          mediaKey: plan.key,
          caption: plan.kind === "media" ? plan.caption : undefined,
          filename: plan.kind === "media" ? plan.filename : undefined,
        },
      );

      if (plan.kind === "media") {
        return `media sent via Meta (${media.whatsappMessageId})`;
      }

      // Audio takes no caption, so the text follows as its own message.
      const follow: { whatsappMessageId: string } = await ctx.runAction(
        internal.metaSend.sendText,
        { accountId, conversationId, to, text: plan.text },
      );
      return `audio + text sent via Meta (${media.whatsappMessageId}, ${follow.whatsappMessageId})`;
    }

    case "send_buttons":
    case "send_list": {
      const payload = step.stepConfig as SendButtonsStepConfig | SendListStepConfig;
      if (!args.contactId) throw new Error(`${step.stepType} needs a contact`);
      // Validate against Meta's limits before resolving/sending so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation (mirrors `engine.ts`'s own ordering).
      const check = validateInteractivePayload(payload);
      if (!check.ok) throw new Error(check.error);
      const { conversationId, to } = await resolveSendTarget(ctx, args);
      const result: { whatsappMessageId: string } = await ctx.runAction(
        internal.metaSend.sendInteractive,
        { accountId: args.automation.accountId, conversationId, to, payload },
      );
      return `interactive sent via Meta (${result.whatsappMessageId})`;
    }

    case "send_template": {
      const cfg = step.stepConfig as SendTemplateStepConfig;
      if (!args.contactId) throw new Error("send_template needs a contact");
      if (!cfg.template_name) throw new Error("send_template needs template_name");
      const { conversationId, to } = await resolveSendTarget(ctx, args);
      const accountId = args.automation.accountId;
      const params = cfg.variables ? sortTemplateParams(cfg.variables) : [];
      // Mirrors the send_message fallback branch above: an absent header
      // is fine (undefined), a present one resolves through the same
      // account-scoped guard so this step can only transmit its own
      // "automation"-kind media, never another account's or another
      // kind's key.
      const header = cfg.header
        ? {
            type: cfg.header.type,
            link: resolveMediaLink(accountId, cfg.header.key, cfg.header.url),
          }
        : undefined;
      const result: { whatsappMessageId: string } = await ctx.runAction(
        internal.metaSend.sendTemplate,
        {
          accountId,
          conversationId,
          to,
          templateName: cfg.template_name,
          language: cfg.language,
          params,
          header,
        },
      );
      return `template sent via Meta (${result.whatsappMessageId})`;
    }

    case "add_tag":
    case "remove_tag":
    case "assign_conversation":
    case "update_contact_field":
    case "create_deal":
    case "close_conversation":
      // Every DB-only effect runs through one internal mutation so each
      // is its own atomic Convex transaction — see `runDbStep` below for
      // the per-stepType logic (1:1 with `engine.ts`'s own `runStep`
      // switch cases of the same names).
      return await ctx.runMutation(internal.automationsEngine.runDbStep, {
        accountId: args.automation.accountId,
        createdByUserId: args.automation.createdByUserId,
        contactId: args.contactId ?? undefined,
        stepType: step.stepType,
        stepConfig: step.stepConfig,
        context: args.context,
      });

    case "send_webhook": {
      const cfg = step.stepConfig as SendWebhookStepConfig;
      if (!cfg.url) throw new Error("send_webhook needs url");
      // SSRF guard (shared with `webhookDelivery.ts` — see this file's
      // header comment #2 for why `dispatch` itself isn't reused): the
      // URL/headers/body_template are account-controlled and the server
      // makes the request, so refuse any destination that resolves to a
      // private/loopback/link-local/reserved address.
      if (!isDeliverableUrl(cfg.url)) {
        throw new Error("send_webhook: destination not allowed");
      }
      const body = cfg.body_template
        ? interpolate(cfg.body_template, args.context)
        : JSON.stringify(args.context);
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above.
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
      return `webhook ${res.status}`;
    }

    default:
      return `unknown step: ${String(step.stepType)}`;
  }
}

// ------------------------------------------------------------
// Pure helpers — unit-testable directly, no ctx.
// ------------------------------------------------------------

/**
 * Ported from `src/lib/automations/engine.ts`'s `triggerMatches`
 * (camelCased field names — the real source of this function; the
 * brief's own pointer to `trigger-meta.ts` is a misnomer, that file
 * only has UI label helpers (`triggerMeta`, singular) and never defines
 * this function). Takes the loosely-typed `{ triggerType, triggerConfig }`
 * shape rather than the full `Doc<"automations">` so it stays trivially
 * unit-testable without seeding a real row.
 */
export function triggerMatches(
  automation: { _id?: string; triggerType: string; triggerConfig?: unknown },
  ctx: AutomationContext | undefined,
): boolean {
  // `time_based` is the one trigger whose "did it match?" was already
  // decided before dispatch: the cron sweep evaluated each automation's
  // own schedule against account-local time and pins the winner's id in
  // the context. Without this, `runForTrigger`'s account-wide fan-out
  // would fire EVERY active time_based automation in the account
  // whenever any one of them came due — a 09:00 job would drag the
  // 18:00 one along with it.
  if (automation.triggerType === "time_based") {
    const pinned = ctx?.automationId;
    if (!pinned || !automation._id) return false;
    return String(automation._id) === String(pinned);
  }

  if (automation.triggerType === "keyword_match") {
    const cfg = automation.triggerConfig as KeywordMatchTriggerConfig | undefined;
    if (!cfg?.keywords || cfg.keywords.length === 0) return false;
    const text = (ctx?.messageText ?? "").toString();
    if (!text) return false;
    const haystack = cfg.case_sensitive ? text : text.toLowerCase();
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase();
      return cfg.match_type === "exact" ? haystack === k : haystack.includes(k);
    });
  }

  // Match on the tag that was just attached. Without this case a
  // `tag_added` automation fell through to the `return true` below and
  // fired for EVERY tag in the account, ignoring the very `tag_id` the
  // builder collects and `validateTriggerForActivation` refuses to
  // activate without.
  if (automation.triggerType === "tag_added") {
    const cfg = automation.triggerConfig as TagAddedTriggerConfig | undefined;
    const tagId = ctx?.tagId;
    if (!tagId || !cfg?.tag_id) return false;
    return String(cfg.tag_id) === String(tagId);
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.triggerType === "interactive_reply") {
    const cfg = automation.triggerConfig as InteractiveReplyTriggerConfig | undefined;
    const replyId = ctx?.interactiveReplyId;
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) {
      return false;
    }
    return cfg.reply_ids.includes(replyId);
  }

  return true;
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === "days" ? 86_400_000 : cfg.unit === "hours" ? 3_600_000 : 60_000;
  return Math.max(1_000, cfg.amount * unitMs);
}

function interpolate(s: string, context: AutomationContext): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split(".");
    if (ns === "message" && prop === "text") return String(context.messageText ?? "");
    if (ns === "vars" && prop) return String(context.vars?.[prop] ?? "");
    return "";
  });
}

// ------------------------------------------------------------
// Internal queries
// ------------------------------------------------------------

/**
 * Loads `contactId`, but only if it actually belongs to `accountId` —
 * `null` otherwise (a foreign contact and a missing one are treated
 * identically, matching this codebase's own tenant-isolation
 * convention). Returns the full contact doc (not a boolean) so callers
 * can feed it straight into `blockedReason` without a second read —
 * `runForTrigger`'s tenant-isolation guard and its do-not-contact gate
 * share this one query, and `resume` reuses it too.
 */
export const getOwnedContact = internalQuery({
  args: { accountId: v.id("accounts"), contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    return contact && contact.accountId === args.accountId ? contact : null;
  },
});

export const listActiveAutomations = internalQuery({
  args: { accountId: v.id("accounts"), triggerType: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("automations")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .filter((q) =>
        q.and(
          q.eq(q.field("isActive"), true),
          q.eq(q.field("triggerType"), args.triggerType),
        ),
      )
      .collect();
  },
});

/**
 * Existence check backing the AI auto-reply "stand down" precedence
 * (Phase 8, Task 4b — `convex/ingest.ts`'s `shouldDispatchAiReply`).
 * Ported from `src/lib/ai/auto-reply.ts`'s own query (lines ~61-68):
 * does this account have ANY active automation whose trigger is a
 * per-message auto-responder (`new_message_received` or
 * `keyword_match`)? Deliberately account-wide and NOT keyed to whether
 * a particular automation's own `triggerConfig` would actually match
 * THIS message — matches the source's coarse `.limit(1)` existence
 * check exactly (relationship triggers like `first_inbound_message`/
 * `new_contact_created` don't count, same as the source's own comment
 * on this: "Relationship triggers... don't count — they're not
 * per-message auto-responders").
 */
export const hasActiveAutoResponder = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<boolean> => {
    const automations = await ctx.db
      .query("automations")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .filter((q) => q.eq(q.field("isActive"), true))
      .collect();
    return automations.some(
      (a) =>
        a.triggerType === "new_message_received" ||
        a.triggerType === "keyword_match",
    );
  },
});

export const getAutomation = internalQuery({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => await ctx.db.get(args.automationId),
});

/**
 * Hard cap on how many contacts ONE time_based automation touches per
 * firing. A daily automation pointed at a broad tag is the one shape in
 * this whole engine that can fan out unboundedly, and each contact can
 * cost a WhatsApp send. Truncation is logged by the sweep, never
 * silent.
 */
export const MAX_TIME_BASED_CONTACTS = 500;

/** One `time_based` automation the sweep found due, with its audience. */
export interface TimeBasedDue {
  automationId: Id<"automations">;
  accountId: Id<"accounts">;
  tagId: Id<"tags">;
  scheduledMinute: number;
  utcOffsetMinutes: number;
  contactIds: Id<"contacts">[];
  truncated: boolean;
}

/**
 * Every active `time_based` automation whose account-local schedule is
 * due right now, with the contacts its tag resolves to.
 *
 * Walks accounts and then each account's own `by_account` automations
 * index — the same shape `inboxChaseAssign.sweepChaseAssign` uses, and
 * the reason it needs the account loop at all is the same: local time
 * comes from that account's own `qualificationConfigs` offset.
 * Read-only; the actual once-a-day claim happens in
 * `claimTimeBasedRun`.
 */
export const listDueTimeBased = internalQuery({
  args: { nowMs: v.number() },
  handler: async (ctx, args): Promise<TimeBasedDue[]> => {
    const out: TimeBasedDue[] = [];
    const accounts = await ctx.db.query("accounts").collect();

    for (const account of accounts) {
      const automations = await ctx.db
        .query("automations")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .filter((q) =>
          q.and(
            q.eq(q.field("isActive"), true),
            q.eq(q.field("triggerType"), "time_based"),
          ),
        )
        .collect();
      if (automations.length === 0) continue;

      // Fixed UTC offset, exactly like working hours — accounts with no
      // qualification config fall back to UTC rather than being skipped,
      // so time_based works without the qualification feature enabled.
      const config = await ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .unique();
      const utcOffsetMinutes = config?.utcOffsetMinutes ?? 0;

      for (const automation of automations) {
        const cfg = automation.triggerConfig as TimeBasedTriggerConfig | undefined;
        if (!cfg?.schedule || !cfg.tag_id) continue;
        const scheduledMinute = parseDailyTime(cfg.schedule);
        if (scheduledMinute === null) continue;
        if (
          !isDailyDue({
            nowMs: args.nowMs,
            utcOffsetMinutes,
            scheduledMinute,
            lastExecutedAt: automation.lastExecutedAt,
          })
        ) {
          continue;
        }

        const tagId = cfg.tag_id as Id<"tags">;
        const tag = await ctx.db.get(tagId);
        if (!tag || tag.accountId !== account._id) continue;

        // One over the cap so truncation is detectable rather than
        // guessed at.
        const links = await ctx.db
          .query("contactTags")
          .withIndex("by_tag", (q) => q.eq("tagId", tagId))
          .take(MAX_TIME_BASED_CONTACTS + 1);
        const truncated = links.length > MAX_TIME_BASED_CONTACTS;

        out.push({
          automationId: automation._id,
          accountId: account._id,
          tagId,
          scheduledMinute,
          utcOffsetMinutes,
          contactIds: links
            .slice(0, MAX_TIME_BASED_CONTACTS)
            .map((l) => l.contactId),
          truncated,
        });
      }
    }

    return out;
  },
});

export const listSteps = internalQuery({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", args.automationId))
      .collect();
  },
});

export const evaluateConditionQuery = internalQuery({
  args: {
    accountId: v.id("accounts"),
    contactId: v.optional(v.id("contacts")),
    subject: v.string(),
    operand: v.optional(v.string()),
    value: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<boolean> => {
    if (args.subject === "tag_presence") {
      if (!args.contactId || !args.operand) return false;
      // contact_tags has no account_id column in the original (its RLS
      // keyed off the parent contact); tenant scoping here relies on
      // `contactId` already being verified by `runForTrigger`'s guard,
      // same as the source's own comment on this exact check.
      const link = await ctx.db
        .query("contactTags")
        .withIndex("by_contact_tag", (q) =>
          q.eq("contactId", args.contactId!).eq("tagId", args.operand as Id<"tags">),
        )
        .first();
      return link !== null;
    }
    if (args.subject === "contact_field") {
      if (!args.contactId || !args.operand) return false;
      const contact = await ctx.db.get(args.contactId);
      if (!contact || contact.accountId !== args.accountId) return false;
      const value = (contact as unknown as Record<string, unknown>)[args.operand];
      return value != null && String(value) === String(args.value ?? "");
    }
    return false;
  },
});

/**
 * Resolves both the conversation a send-type step should target and
 * the contact's phone (`to`) — `metaSend.ts`'s actions take `to`
 * directly (unlike the original's `engineSendText` etc., which took a
 * `contactId` and resolved the phone internally), so the engine
 * resolves it itself in one round trip. Prefers the conversation id
 * the triggering context already carries (the one that just received
 * the inbound message); falls back to the contact's own conversation
 * for resumed/wait paths — mirrors `engine.ts`'s `resolveConversationId`.
 * Returns `null` (never throws) for "not found" — the caller decides
 * how to surface that as a failed-step detail.
 */
export const resolveSendTargetQuery = internalQuery({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.optional(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== args.accountId) return null;

    if (args.conversationId) {
      const conversation = await ctx.db.get(args.conversationId);
      if (!conversation || conversation.accountId !== args.accountId) return null;
      return { conversationId: conversation._id, to: contact.phone };
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .filter((q) => q.eq(q.field("accountId"), args.accountId))
      .first();
    if (!conversation) return null;
    return { conversationId: conversation._id, to: contact.phone };
  },
});

/**
 * Resolve Meta's 24-hour customer service window for a conversation.
 * `resolveWindowState` is the pure resolver shared with the
 * qualification engine (`qualificationEngine.ts`'s own `staffLoopsDue`
 * call) — this query only feeds it the row's fields, verified against
 * `schema.ts`'s `conversations` table: `lastInboundAt`, `metaWindow`
 * (Meta's own authoritative record), `adReferral.startedAt` and
 * `firstReplyAt` (the 72h free-entry-point estimate's anchors). Only
 * `csw` (the 24h window) matters to a send-step gate — `fep` governs
 * COST, not whether a free-form send is legal — but the full state is
 * resolved in one place rather than hand-picking fields out of it.
 *
 * A foreign or missing `conversationId` reads as closed (not an
 * error): this is a gate, and the caller's own send path already
 * throws its own clear error when the conversation can't be resolved
 * at all (`resolveSendTarget`) — this query is never reached with a
 * conversation this account doesn't own.
 */
export const resolveWindowQuery = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args): Promise<{ canSendFreeForm: boolean; expiresAt?: number; remainingMs: number }> => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) {
      return { canSendFreeForm: false, expiresAt: undefined, remainingMs: 0 };
    }
    const state = resolveWindowState({
      now: Date.now(),
      lastInboundAt: conversation.lastInboundAt,
      metaWindow: conversation.metaWindow,
      adReferralStartedAt: conversation.adReferral?.startedAt,
      firstReplyAt: conversation.firstReplyAt,
    });
    return {
      canSendFreeForm: state.canSendFreeForm,
      expiresAt: state.csw.expiresAt,
      remainingMs: state.csw.remainingMs,
    };
  },
});

/**
 * The account's fixed UTC offset in minutes. Same source and same UTC
 * fallback the `time_based` trigger already uses — see the
 * `qualificationConfigs` lookup in `listDueTimeBased` above. Gulf/India
 * have no DST, so a fixed offset is exact rather than an approximation.
 */
export const accountUtcOffsetQuery = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();
    return config?.utcOffsetMinutes ?? 0;
  },
});

// ------------------------------------------------------------
// Internal mutations
// ------------------------------------------------------------

export const createLog = internalMutation({
  args: {
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    automationId: v.id("automations"),
    contactId: v.optional(v.id("contacts")),
    triggerEvent: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("automationLogs", {
      accountId: args.accountId,
      createdByUserId: args.createdByUserId,
      automationId: args.automationId,
      contactId: args.contactId,
      triggerEvent: args.triggerEvent,
      stepsExecuted: [],
      status: "success",
    });
  },
});

/**
 * One `automationRuns` row per enrolment — the counterpart to
 * `createLog` above, but answering "where is this contact NOW" rather
 * than "what happened". Starts `"running"` at `nextPosition: 0`;
 * `finishRun` below is the only way out to a terminal status (Task 4
 * adds the `"waiting"` transition at a `wait` step; Task 5 adds
 * `"cancelled"`).
 *
 * Seeds `outstandingBranches` at 1, not 0 — see that field's own
 * comment in `schema.ts`. This dispatch's own entry-call scope is
 * itself one live "lineage" until it either finishes (`finishRun`
 * decrements it) or suspends on its own `wait` (net-zero — see
 * `markRunWaiting`'s comment). Fix wave (2026-08): the previous
 * unseeded (0) baseline is what let a re-suspending entry call's
 * SECOND `wait` increment without anything ever having credited the
 * first — see `outstandingBranches`'s schema comment for the full
 * failure mode this closes.
 */
export const createRun = internalMutation({
  args: {
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
    contactId: v.optional(v.id("contacts")),
    conversationId: v.optional(v.id("conversations")),
    logId: v.optional(v.id("automationLogs")),
    context: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    return await ctx.db.insert("automationRuns", {
      ...args,
      status: "running",
      nextPosition: 0,
      outstandingBranches: 1,
      startedAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Terminal transition for ONE lineage's slot — but the run only
 * actually becomes terminal once EVERY live lineage `outstandingBranches`
 * is tracking is back. Fix wave (2026-08): `executeStepsFrom` now calls
 * this UNCONDITIONALLY whenever an entry call's own scope runs out of
 * steps without ITSELF hitting another `wait` — whether that scope
 * finished cleanly, failed, or merely finished DELEGATING to a
 * `condition` branch that is still suspended (previously gated on
 * `!suspended`, which skipped this call entirely in that last case —
 * see `outstandingBranches`'s schema comment for why that was the bug).
 * A `condition` can fan out into more than one independently-suspended
 * branch, each reaching an entry call of its own on resume, so this
 * mutation can legitimately be invoked more than once for the same run
 * — `outstandingBranches` is what makes only the LAST such call actually
 * write a terminal status: this reads the run, decrements the count,
 * and only patches `status`/`endedAt` when the result reaches zero —
 * otherwise it persists the decremented count (and any newly-found
 * failure, below) and returns, leaving the run's current status
 * untouched.
 *
 * The decrement happens HERE, atomically with the zero-check, and
 * deliberately NOT in `markRunRunning` at the moment a branch resumes —
 * see this file's header comment #4 for why: nothing in Convex
 * serializes two DIFFERENT scheduled actions against each other, only
 * each action's OWN individual mutation calls, so two branches of the
 * same run can resume concurrently. Decrementing here means whichever
 * of the two branches' `finishRun` calls runs second is guaranteed to
 * see the other's decrement already applied — only one call can ever
 * observe (and act on) zero, regardless of how the rest of each
 * action's own work interleaves.
 *
 * Still re-reads the run's own `errorMessage` fresh (Task 3's rule: a
 * failure recorded anywhere — by an earlier `finishRun` call that
 * itself couldn't finalize — always wins over this call's own
 * "completed"). A call that finds the count still above zero durably
 * records THIS call's own failure (if any) before returning, so a
 * later branch's `finishRun` — the one that actually closes the run
 * out — doesn't finalize over it. This now subsumes what
 * `recordRunFailure` used to be reached for exclusively (the
 * `suspended && failed` case): since this mutation is called
 * unconditionally, its own "persist the count and any failure without
 * finalizing" branch below already does that job. `recordRunFailure`
 * itself is kept, unused by this file, only because it still has direct
 * unit coverage of its own two guards (cancelled-run no-op, first
 * failure sticks) — nothing in the live engine calls it anymore.
 *
 * Refuses to touch a run that is ALREADY terminal (`cancelled`,
 * `completed`, or `failed`) — widened past Task 3's original
 * cancelled-only check. In ordinary operation `outstandingBranches`
 * reaching zero should only ever happen once per run, so this should
 * never fire on an already-`completed`/`failed` row — but refusing it
 * outright, rather than trusting that invariant, is what keeps a stray
 * extra call (a bug, a duplicate scheduled invocation, a straggler
 * arriving late) from moving `endedAt` a second time. Also clears
 * `resumeAt`/`scheduledFnId` so a finished run never looks queued — the
 * Waiting tab reads those fields directly.
 */
export const finishRun = internalMutation({
  args: {
    runId: v.id("automationRuns"),
    status: v.union(v.literal("completed"), v.literal("failed")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (
      !run ||
      run.status === "cancelled" ||
      run.status === "completed" ||
      run.status === "failed"
    ) {
      return null;
    }
    const now = Date.now();

    // This call's own lineage-slot is no longer outstanding. Clamped at
    // 0 (rather than trusting `createRun`'s seed alone) so a run
    // created before `outstandingBranches` existed at all (pre-Task-4)
    // or before this fix wave seeded it at 1 still finalizes safely
    // instead of going negative.
    const outstandingBranches = Math.max(0, (run.outstandingBranches ?? 0) - 1);

    // A run can span more than one dispatch (a `condition` branch that
    // suspends on a `wait` does not pause its parent's later root-level
    // siblings — see `executeStepsFrom`'s own comment on the condition
    // case), so a failure recorded by `recordRunFailure` — from an
    // EARLIER entry call that itself couldn't close out the run because
    // some OTHER branch was still suspended — must win over THIS call's
    // own "completed", exactly the way it would have if both had
    // happened to run in the same dispatch. Re-reading `run.errorMessage`
    // fresh here (rather than trusting only this call's own `args`) is
    // what makes repeated/out-of-order `finishRun` calls for the same
    // run converge on the correct answer regardless of which one
    // happens to fire last.
    const priorFailure = run.errorMessage;
    const failed = priorFailure !== undefined || args.status === "failed";
    const errorMessage = priorFailure ?? args.errorMessage;

    if (outstandingBranches > 0) {
      // Some OTHER branch this run fanned into hasn't resumed yet — not
      // done. Record the count and this call's own failure (if any)
      // durably, but leave `status`/`endedAt` alone: only the call that
      // brings the count to zero may set them.
      await ctx.db.patch(args.runId, { outstandingBranches, errorMessage, updatedAt: now });
      return null;
    }

    await ctx.db.patch(args.runId, {
      status: failed ? "failed" : args.status,
      errorMessage,
      outstandingBranches,
      resumeAt: undefined,
      scheduledFnId: undefined,
      endedAt: now,
      updatedAt: now,
    });
    return null;
  },
});

/**
 * Durably records a failure on a run that ISN'T finishing yet, without
 * touching `outstandingBranches`. Originally the ONLY way to record a
 * failure found by an entry call whose own scope finished delegating to
 * a still-`suspended` child branch (since `finishRun` was, at the time,
 * gated on `!suspended` and so unreachable from that call). Fix wave
 * (2026-08): `finishRun` is now called unconditionally from that same
 * site, and its own "count still above zero" branch persists the
 * failure AND correctly decrements the caller's own now-spent lineage
 * slot in the same transaction — this mutation's job, minus the
 * decrement `recordRunFailure` was never able to do safely from that
 * call site anyway (see `outstandingBranches`'s schema comment). Kept,
 * unused by the rest of this file, only for its own direct test
 * coverage of the two guards below — nothing in the live engine calls
 * it anymore.
 *
 * Deliberately does NOT set `status`, `endedAt`, `resumeAt`, or
 * `scheduledFnId` — a run this touches genuinely is not done yet, and
 * marking it so here would reintroduce exactly the premature-completion
 * bug the `isEntryCall`/`suspended` mechanism exists to prevent.
 *
 * Sticky on purpose (first failure recorded wins, matching `finishRun`'s
 * own "prior failure wins" rule above): if two independent branches of
 * the same run each fail, surfacing whichever was recorded first is
 * more useful than the two racing to overwrite each other, and it keeps
 * this function — like `finishRun` — safe to call more than once.
 */
export const recordRunFailure = internalMutation({
  args: {
    runId: v.id("automationRuns"),
    errorMessage: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status === "cancelled" || run.errorMessage !== undefined) {
      return null;
    }
    await ctx.db.patch(args.runId, {
      errorMessage: args.errorMessage,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Park a run at a `wait` (Task 4). The suspension tuple stored here is
 * exactly what `resume` needs as arguments, so a cancelled-then-inspected
 * run is self-describing rather than requiring a walk of the step tree.
 *
 * Conditionally increments `outstandingBranches` — see the field's own
 * comment in `schema.ts` for the full invariant. `isEntryCall` (the
 * SAME flag `executeStepsFrom` threads through its own recursion — see
 * `ExecuteArgs.isEntryCall`) decides whether this suspension is a
 * genuinely NEW live resume or just the current lineage's existing slot
 * moving to a new wait point:
 *   - `isEntryCall: false` — a nested `condition` branch, spawned fresh
 *     within the CURRENT dispatch, suspending for the first time. This
 *     IS new: nothing has ever credited a slot for it. Increment.
 *   - `isEntryCall: true` — the entry call's OWN top scope hitting a
 *     `wait`, whether that's the very first dispatch (its slot was
 *     seeded by `createRun`) or a RESUMED scope re-suspending on a
 *     second/third/... `wait` in the same lineage (its slot was never
 *     released — `markRunRunning` deliberately does not decrement, and
 *     the caller of THIS mutation is precisely the scheduled resume
 *     that slot was tracking). Net-zero: this scheduled function firing
 *     is what produced this call, and it is simply being replaced by a
 *     new one for the same lineage. Do NOT increment.
 * Fix wave (2026-08): the previous unconditional `+ 1` here is what let
 * a re-suspending entry call (two or more sequential waits) increment
 * without any matching decrement ever being reachable, stranding the
 * run at `status: "running"` forever — `finishRun` (the only decrement)
 * was only reachable from a scope that finishes WITHOUT hitting another
 * `wait`, which a re-suspending entry call by definition never does.
 */
export const markRunWaiting = internalMutation({
  args: {
    runId: v.id("automationRuns"),
    currentStepKey: v.string(),
    parentStepId: v.optional(v.id("automationSteps")),
    branch: v.optional(v.union(v.literal("yes"), v.literal("no"))),
    nextPosition: v.number(),
    resumeAt: v.number(),
    scheduledFnId: v.id("_scheduled_functions"),
    isEntryCall: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { runId, isEntryCall, ...rest } = args;
    const run = await ctx.db.get(runId);
    // Cancelled between scheduling and this patch — leave it cancelled.
    if (!run || run.status === "cancelled") return null;
    await ctx.db.patch(runId, {
      ...rest,
      status: "waiting",
      outstandingBranches: (run.outstandingBranches ?? 0) + (isEntryCall ? 0 : 1),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Flip a parked run back to `running` and clear the wait bookkeeping
 * (Task 4) — called at the very start of `resume`, before it walks any
 * steps. Returns whether the caller may proceed.
 *
 * A cancelled run must not restart. This is the race that matters:
 * `ctx.scheduler.cancel` (Task 5) and an already-dequeued resume can
 * interleave, so this re-checks the run's CURRENT status rather than
 * trusting that scheduling a cancellation means this call never fires.
 *
 * Deliberately does NOT touch `outstandingBranches` — see `finishRun`'s
 * own comment (and this file's header comment #4) for why the matching
 * decrement has to live there instead, to stay race-free when two
 * branches of the same run resume concurrently.
 */
export const markRunRunning = internalMutation({
  args: { runId: v.id("automationRuns") },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status === "cancelled") return false;
    await ctx.db.patch(args.runId, {
      status: "running",
      resumeAt: undefined,
      scheduledFnId: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});

// ------------------------------------------------------------
// Cancellation (Task 5). Five paths land here: automation deactivated
// (`automations.setActive`), deleted (`automations.remove`), edited on
// the branch that replaces its steps (`automations.update`), a contact
// flagged do-not-contact (`contactNotes.add`/`update` — the brief's own
// pointer to `contacts.ts` is stale; grepping the real codebase for
// where `doNotContact` is actually SET lands in `contactNotes.ts`, not
// `contacts.ts`), and a contact replying to a `stopOnReply` automation
// (`ingest.ts`'s inbound dispatch). All five ultimately call one of the
// two mutations below, which both bottom out in `cancelOne`.
// ------------------------------------------------------------

/** How many waiting runs one cancellation transaction may touch. Same
 *  reasoning, and same conservatism, as `LOG_CASCADE_BATCH`
 *  (`convex/automations.ts`) — an active automation's WAITING count can
 *  grow as unboundedly as that table's log history. */
export const RUN_CANCEL_BATCH = 256;

/**
 * Cancel this automation's still-pending runs, one bounded batch per
 * call, self-scheduling until drained. Two of Task 5's five
 * cancellation paths key off this directly (`setActive`, `remove`); a
 * third (`update`, on the branch that actually calls `replaceSteps`)
 * does too — see that mutation's own comment for why an edit has to
 * cancel rather than let a resume land in a step tree that changed
 * underneath it.
 *
 * Queries TWO statuses, not one. The obvious query — `status ===
 * "waiting"` — misses a real hazard Task 4's review flagged: a run
 * whose tree fanned into more than one branch (a `condition` with two
 * suspended children) stores its suspension bookkeeping
 * (`resumeAt`/`scheduledFnId`/…) in fields that describe only ONE
 * suspension point, so the SECOND branch to suspend overwrites what the
 * FIRST one wrote. Once one branch resumes, `markRunRunning` flips the
 * row to `status: "running"` — even though a SIBLING branch can still
 * be genuinely parked on its own live scheduled `resume`, with no
 * record of that fact anywhere in the row's singular fields.
 * `outstandingBranches` is the one field immune to that overwrite (every
 * `markRunWaiting` increments it, only `finishRun` decrements it), so a
 * run reading `status: "running"` with `outstandingBranches > 0` is
 * exactly this in-between state — a `status`-only query would call it
 * "not cancellable" despite a real pending send. Both queries reuse the
 * SAME status-keyed index (only the bound `status` value differs), so
 * this costs one extra indexed range read per batch, not a scan.
 *
 * NOT concurrency-safe: two overlapping chains for the SAME automation
 * would each re-read the same page. Only ever start one — `setActive`,
 * `remove`, and `update` each schedule this at most once per call, and
 * each acts on a single automation under a single user action, which is
 * what keeps that true (mirrors `purgeAutomationLogs`'s own
 * conservatism note in `convex/automations.ts`).
 */
export const cancelRunsForAutomation = internalMutation({
  args: {
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<{ cancelled: number; done: boolean }> => {
    const waiting = await ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation_status", (q) =>
        q
          .eq("accountId", args.accountId)
          .eq("automationId", args.automationId)
          .eq("status", "waiting"),
      )
      .take(RUN_CANCEL_BATCH);

    const runningRaw = await ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation_status", (q) =>
        q
          .eq("accountId", args.accountId)
          .eq("automationId", args.automationId)
          .eq("status", "running"),
      )
      .take(RUN_CANCEL_BATCH);
    const runningStuck = runningRaw.filter((run) => (run.outstandingBranches ?? 0) > 0);

    for (const run of [...waiting, ...runningStuck]) {
      await cancelOne(ctx, run, args.reason);
    }

    const done = waiting.length < RUN_CANCEL_BATCH && runningRaw.length < RUN_CANCEL_BATCH;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.automationsEngine.cancelRunsForAutomation, args);
    }
    return { cancelled: waiting.length + runningStuck.length, done };
  },
});

/**
 * Cancel one contact's still-pending runs — the do-not-contact path
 * (`onlyStopOnReply` unset) and the stopOnReply-on-reply path
 * (`onlyStopOnReply: true`, `convex/ingest.ts`'s inbound dispatch).
 * `.collect()`, not a batch: one contact can only be enrolled in as
 * many automations as the account has defined — nothing like
 * `cancelRunsForAutomation`'s unbounded "every contact this automation
 * ever enrolled" scan. Same two-status query as
 * `cancelRunsForAutomation`, and for the identical reason — see that
 * mutation's own comment on the multi-branch hazard.
 */
export const cancelRunsForContact = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    reason: v.string(),
    /** Only cancel runs whose automation has `stopOnReply` set. */
    onlyStopOnReply: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{ cancelled: number }> => {
    const waiting = await ctx.db
      .query("automationRuns")
      .withIndex("by_account_contact_status", (q) =>
        q.eq("accountId", args.accountId).eq("contactId", args.contactId).eq("status", "waiting"),
      )
      .collect();
    const runningStuck = (
      await ctx.db
        .query("automationRuns")
        .withIndex("by_account_contact_status", (q) =>
          q.eq("accountId", args.accountId).eq("contactId", args.contactId).eq("status", "running"),
        )
        .collect()
    ).filter((run) => (run.outstandingBranches ?? 0) > 0);

    let cancelled = 0;
    for (const run of [...waiting, ...runningStuck]) {
      if (args.onlyStopOnReply) {
        const automation = await ctx.db.get(run.automationId);
        if (!automation?.stopOnReply) continue;
      }
      await cancelOne(ctx, run, args.reason);
      cancelled += 1;
    }
    return { cancelled };
  },
});

/**
 * Cancel the scheduled resume, THEN mark the row. Order matters: an
 * already-dequeued-but-not-yet-executed resume calls `markRunRunning`,
 * which guards on the row's status at the moment IT runs — marking the
 * row first and cancelling the scheduled function second would leave a
 * window where that resume reads the still-"waiting" row before this
 * function ever reaches the `scheduler.cancel` call, and proceeds
 * regardless. Cancelling first closes that window: `ctx.scheduler.cancel`
 * on a function that has already started running is a documented no-op
 * in Convex, so this ordering never race-loses the other way.
 */
async function cancelOne(
  ctx: MutationCtx,
  run: Doc<"automationRuns">,
  reason: string,
): Promise<void> {
  if (run.scheduledFnId) await ctx.scheduler.cancel(run.scheduledFnId);
  const now = Date.now();
  await ctx.db.patch(run._id, {
    status: "cancelled",
    errorMessage: reason,
    resumeAt: undefined,
    scheduledFnId: undefined,
    endedAt: now,
    updatedAt: now,
  });
}

/**
 * Read-merge-write onto one log's `stepsExecuted` — the Convex
 * counterpart to `engine.ts`'s `appendResults`. `status` is left
 * untouched when omitted (nested-branch scopes pass no `status`, only
 * the root scope's own completion overwrites the log's overall
 * status), matching the original's `if (status !== null)` guard.
 *
 * Also the sole writer of the per-step `automationStepStats` counters
 * (Task 6) — folded into this same transaction so a step can never be
 * logged without being counted, or vice versa. Counters are keyed on
 * each item's `stepKey`, NOT `stepId` (the step row's `_id`): `stepId`
 * is only ever used for the log entry, unchanged since before this
 * task. `replaceSteps` (`convex/automations.ts`) deletes and reinserts
 * every step row on every builder save — even a rename-only one — so a
 * counter keyed on the row id would silently reset to zero on the next
 * edit. `stepKey` is `automationSteps`' stable per-step identity
 * (Task 10) precisely because it survives that churn; see its own
 * schema comment and `automationStepStats`'s. `accountId`/`automationId`
 * for the counter rows come straight off `log` (already loaded above for
 * the `stepsExecuted` merge) rather than as separate args — every log
 * row already carries both, so threading them again through every call
 * site would just be a second copy of the same two ids.
 */
export const appendLogResults = internalMutation({
  args: {
    logId: v.optional(v.id("automationLogs")),
    newItems: v.array(
      v.object({
        stepId: v.string(),
        // The step's stable key — see this mutation's own comment.
        // Deliberately NOT part of `stepsExecuted`'s stored shape: it is
        // stripped back off (the `forLog` map below) before the merge,
        // so the log keeps storing exactly the same four fields it did
        // before this task.
        stepKey: v.string(),
        stepType: v.string(),
        status: v.union(v.literal("success"), v.literal("failed")),
        detail: v.optional(v.string()),
      }),
    ),
    status: v.optional(v.union(v.literal("success"), v.literal("partial"), v.literal("failed"))),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!args.logId) return;
    const log = await ctx.db.get(args.logId);
    if (!log) return;

    // `stepsExecuted`'s shape is unchanged by this task — `stepKey` rides
    // along on `args.newItems` only to feed the counters below.
    const forLog = args.newItems.map(({ stepKey, ...rest }) => rest);
    const merged = [...((log.stepsExecuted as unknown[] | undefined) ?? []), ...forLog];
    const patch: { stepsExecuted: unknown[]; status?: "success" | "partial" | "failed"; errorMessage?: string } = {
      stepsExecuted: merged,
    };
    if (args.status !== undefined) patch.status = args.status;
    if (args.errorMessage) patch.errorMessage = args.errorMessage;
    await ctx.db.patch(args.logId, patch);

    // Cumulative per-step counters that drive Task 8's canvas chips.
    // Sequential (not `Promise.all`) so two items that happened to share
    // a `stepKey` within the same batch — never expected in practice,
    // since one `executeStepsFrom` scope visits each of its own steps at
    // most once, but not a physical guarantee — still read-then-write
    // without racing each other inside this one transaction.
    for (const item of args.newItems) {
      const existing = await ctx.db
        .query("automationStepStats")
        .withIndex("by_account_step_key", (q) =>
          q.eq("accountId", log.accountId).eq("stepKey", item.stepKey),
        )
        .unique();
      const sentDelta = item.status === "success" ? 1 : 0;
      const failedDelta = item.status === "failed" ? 1 : 0;
      if (existing) {
        await ctx.db.patch(existing._id, {
          reached: existing.reached + 1,
          sent: existing.sent + sentDelta,
          failed: existing.failed + failedDelta,
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.insert("automationStepStats", {
          accountId: log.accountId,
          automationId: log.automationId,
          stepKey: item.stepKey,
          reached: 1,
          sent: sentDelta,
          failed: failedDelta,
          updatedAt: Date.now(),
        });
      }
    }
  },
});

/**
 * The once-a-day claim for a `time_based` automation. Re-checks dueness
 * and stamps `lastExecutedAt` in ONE transaction, returning whether THIS
 * caller won it. Two overlapping sweeps both calling this can only have
 * one come away `true`, because the second one re-reads the row the
 * first already stamped and `isDailyDue` then rejects it on the
 * same-local-day check.
 *
 * `lastExecutedAt` doubles as the claim marker precisely because
 * `time_based` automations have exactly one dispatcher — this sweep —
 * so nothing else can move it out from under the check.
 */
export const claimTimeBasedRun = internalMutation({
  args: {
    automationId: v.id("automations"),
    nowMs: v.number(),
    utcOffsetMinutes: v.number(),
    scheduledMinute: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const automation = await ctx.db.get(args.automationId);
    if (!automation || !automation.isActive) return false;
    if (
      !isDailyDue({
        nowMs: args.nowMs,
        utcOffsetMinutes: args.utcOffsetMinutes,
        scheduledMinute: args.scheduledMinute,
        lastExecutedAt: automation.lastExecutedAt,
      })
    ) {
      return false;
    }
    await ctx.db.patch(args.automationId, { lastExecutedAt: args.nowMs });
    return true;
  },
});

export const bumpExecutionCount = internalMutation({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    const automation = await ctx.db.get(args.automationId);
    if (!automation) return;
    await ctx.db.patch(args.automationId, {
      executionCount: automation.executionCount + 1,
      lastExecutedAt: Date.now(),
    });
  },
});

/**
 * One atomic transaction per DB-only step effect — `add_tag`,
 * `remove_tag`, `assign_conversation`, `update_contact_field`,
 * `create_deal`, `close_conversation`. 1:1 with `engine.ts`'s own
 * `runStep` switch cases of the same names (the brief's prose says
 * "set_tag"; the real, and only, tag step types — in both the source
 * switch and `schema.ts`'s closed `stepType` union — are `add_tag` /
 * `remove_tag`, both ported here).
 *
 * Every write below re-verifies the target/referenced row's own
 * `accountId` before mutating it — stricter than a few spots in the
 * original (see inline notes), because Convex's `ctx.db.patch`/
 * `ctx.db.insert` have no `WHERE account_id = ...` clause the way a
 * Postgres `UPDATE ... WHERE account_id = $1` silently no-ops against:
 * an unchecked patch-by-id would actually cross-tenant-mutate a
 * foreign row if one were ever reachable here, so every id this
 * function touches is re-verified against `accountId` first, matching
 * this codebase's own stated convention (`contacts.ts`/`deals.ts`/
 * `customFields.ts`'s own header comments).
 */
export const runDbStep = internalMutation({
  args: {
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    contactId: v.optional(v.id("contacts")),
    stepType: v.string(),
    stepConfig: v.any(),
    context: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<string> => {
    const { accountId, createdByUserId, contactId, stepType, stepConfig } = args;
    const context = (args.context ?? {}) as AutomationContext;

    switch (stepType) {
      case "add_tag": {
        const cfg = stepConfig as TagStepConfig;
        if (!contactId || !cfg.tag_id) throw new Error("add_tag needs contact + tag_id");
        const tagId = cfg.tag_id as Id<"tags">;
        const tag = await ctx.db.get(tagId);
        if (!tag || tag.accountId !== accountId) {
          return `tag ${cfg.tag_id} not found in this account`;
        }
        const existing = await ctx.db
          .query("contactTags")
          .withIndex("by_contact_tag", (q) => q.eq("contactId", contactId).eq("tagId", tagId))
          .first();
        if (!existing) {
          await ctx.db.insert("contactTags", { accountId, contactId, tagId });
          // An automation adding a tag can itself trigger a `tag_added`
          // automation — that chaining is the point (tag a lead, a
          // follow-up automation picks it up). `context.depth` carries
          // the hop count so `dispatchTagAdded` can cap runaway chains;
          // see `MAX_TRIGGER_DEPTH` for why the idempotent-insert
          // rule alone isn't enough to bound them.
          await dispatchTagAdded(ctx, {
            accountId,
            contactId,
            tagId,
            conversationId: context.conversationId,
            depth: context.depth ?? 0,
          });
        }
        return `tag ${cfg.tag_id} added`;
      }

      case "remove_tag": {
        const cfg = stepConfig as TagStepConfig;
        if (!contactId || !cfg.tag_id) throw new Error("remove_tag needs contact + tag_id");
        const tagId = cfg.tag_id as Id<"tags">;
        const existing = await ctx.db
          .query("contactTags")
          .withIndex("by_contact_tag", (q) => q.eq("contactId", contactId).eq("tagId", tagId))
          .first();
        if (existing) await ctx.db.delete(existing._id);
        return `tag ${cfg.tag_id} removed`;
      }

      case "assign_conversation": {
        const cfg = stepConfig as AssignConversationStepConfig;
        if (!contactId) throw new Error("assign_conversation needs a contact");
        let agentId = cfg.agent_id as Id<"users"> | undefined;
        if (cfg.mode === "round_robin") {
          // Picks any member of the account — the original's own
          // comment: "preserving that shape until a real round-robin
          // algorithm replaces it" (it only ever returned the
          // automation's author).
          const membership = await ctx.db
            .query("memberships")
            .withIndex("by_account", (q) => q.eq("accountId", accountId))
            .first();
          agentId = membership?.userId;
        }
        if (!agentId) return "no agent resolved";
        // Original updates by (account_id, contact_id) directly, no
        // status/updatedAt bump, no notification — matches exactly
        // (the newer, richer `conversations.assign` mutation is a
        // different, user-facing code path).
        const conversation = await ctx.db
          .query("conversations")
          .withIndex("by_contact", (q) => q.eq("contactId", contactId))
          .filter((q) => q.eq(q.field("accountId"), accountId))
          .first();
        if (conversation) {
          // `bumpUpdatedAt: false` — the original updated by
          // (account_id, contact_id) with no status/updatedAt bump, and
          // matching that exactly is deliberate (see the comment above).
          const changed = await applyAssignment(ctx, {
            conversation,
            nextAssignee: agentId,
            source: "automation",
            bumpUpdatedAt: false,
          });
          // Same charge-on-assignment guarantee as `conversations.assign`
          // and `conversations.setAutoreplyPaused` — feature-off/
          // agents-only/idempotent, so safe to call unconditionally once
          // `applyAssignment` has run, whether or not it changed anything
          // (lead-value fix wave, Task 2b).
          await chargeLeadIfAgent(ctx, accountId, agentId, conversation._id);
          // An automation assigning a conversation can itself trigger a
          // `conversation_assigned` automation. `context.depth` carries
          // the hop count so the dispatcher can cap runaway chains — see
          // `MAX_TRIGGER_DEPTH`.
          if (changed && contactId) {
            await dispatchConversationAssigned(ctx, {
              accountId,
              conversationId: conversation._id,
              contactId,
              agentId,
              depth: context.depth ?? 0,
            });
          }
        }
        return `assigned to ${agentId}`;
      }

      case "update_contact_field": {
        const cfg = stepConfig as UpdateContactFieldStepConfig;
        if (!contactId) throw new Error("update_contact_field needs a contact");
        const value = interpolate(cfg.value, context);

        if (cfg.field.startsWith("custom:")) {
          const customFieldIdStr = cfg.field.slice("custom:".length);
          if (!customFieldIdStr) return `field ${cfg.field} not writable from automations`;
          const customFieldId = customFieldIdStr as Id<"customFields">;
          const field = await ctx.db.get(customFieldId);
          if (!field || field.accountId !== accountId) {
            return `field ${cfg.field} not writable from automations`;
          }
          const existingValue = await ctx.db
            .query("contactCustomValues")
            .withIndex("by_contact_field", (q) =>
              q.eq("contactId", contactId).eq("customFieldId", customFieldId),
            )
            .first();
          if (existingValue) {
            await ctx.db.patch(existingValue._id, { value });
          } else {
            await ctx.db.insert("contactCustomValues", {
              accountId,
              contactId,
              customFieldId,
              value,
            });
          }
          return "custom field updated";
        }

        const allowed = new Set(["name", "email", "company"]);
        if (!allowed.has(cfg.field)) return `field ${cfg.field} not writable from automations`;
        const contact = await ctx.db.get(contactId);
        if (!contact || contact.accountId !== accountId) {
          return `field ${cfg.field} not writable from automations`;
        }
        await ctx.db.patch(contactId, { [cfg.field]: value });
        return `${cfg.field} updated`;
      }

      case "create_deal": {
        const cfg = stepConfig as CreateDealStepConfig;
        if (!cfg.pipeline_id || !cfg.stage_id) {
          throw new Error("create_deal needs pipeline + stage");
        }
        // Strengthened vs. the original (which trusted `cfg.pipeline_id`/
        // `cfg.stage_id` unchecked): Convex `insert` has no FK to reject
        // a nonexistent/foreign id the way even a bare Postgres
        // `REFERENCES` constraint would for "doesn't exist" — so both
        // are verified to belong to this account, mirroring
        // `deals.create`'s own `requireOwnPipeline`/`requireOwnStage`.
        const pipelineId = cfg.pipeline_id as Id<"pipelines">;
        const stageId = cfg.stage_id as Id<"pipelineStages">;
        const pipeline = await ctx.db.get(pipelineId);
        if (!pipeline || pipeline.accountId !== accountId) {
          throw new Error("create_deal: pipeline not found in this account");
        }
        const stage = await ctx.db.get(stageId);
        if (!stage || stage.accountId !== accountId || stage.pipelineId !== pipelineId) {
          throw new Error("create_deal: stage not found in this pipeline");
        }

        const account = await ctx.db.get(accountId);
        await ctx.db.insert("deals", {
          accountId,
          createdByUserId,
          pipelineId,
          stageId,
          contactId: contactId ?? undefined,
          title: interpolate(cfg.title, context),
          value: cfg.value ?? 0,
          currency: account?.defaultCurrency ?? "USD",
          status: "open",
          updatedAt: Date.now(),
        });
        return "deal created";
      }

      case "close_conversation": {
        if (!contactId) throw new Error("close_conversation needs a contact");
        const conversation = await ctx.db
          .query("conversations")
          .withIndex("by_contact", (q) => q.eq("contactId", contactId))
          .filter((q) => q.eq(q.field("accountId"), accountId))
          .first();
        if (conversation) {
          await ctx.db.patch(conversation._id, { status: "closed", updatedAt: Date.now() });
        }
        return "conversation closed";
      }

      default:
        return `unknown step: ${stepType}`;
    }
  },
});
