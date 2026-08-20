import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  buildStepsTree,
  seedsToTree,
  stepsTreeEqual,
  type BuilderStepInput,
  type BuilderStepNode,
  type StepRow,
} from "./lib/automations/stepsTree";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from "./lib/automations/validate";
import { clampLimit } from "./lib/cronSummary";
import { summarizeRuns } from "./lib/automations/runStats";

// ============================================================
// Automations config CRUD — the account-scoped builder-facing
// counterpart to `automationsEngine.ts`'s runtime. Built on
// `accountQuery`/`accountMutation` (never the raw `query`/`mutation`),
// mirroring `contacts.ts`/`deals.ts`: `ctx.accountId` always comes from
// the caller's own `memberships` row, never a client-supplied argument.
// Every write re-checks the target automation's own `accountId` before
// touching it (defense-in-depth, same philosophy as every other CRUD
// module in this codebase).
//
// Ported from `src/app/api/automations/route.ts` (list/create),
// `src/app/api/automations/[id]/route.ts` (get/update/delete), and
// `src/app/api/automations/[id]/duplicate/route.ts`. Those source write
// routes gated on `requireRole('agent')` (the RLS
// `automations_insert`/`_update`/`_delete` policies the service-role
// client bypasses), and their reads had no role gate beyond "is logged
// in", matching `accountQuery`'s default.
//
// WRITE FLOOR — why every function here, read AND write, is `admin`:
// the reads were raised to `admin` (see `list`) because `/automations`
// is absent from every nav allowlist in `src/lib/auth/roles.ts` —
// `AGENT_NAV`, `VIEWER_NAV` and `SUPERVISOR_NAV` all omit it, so
// `canAccessNav`/`canAccessRoute` admit only admin/owner to this
// section at all. The mutations were left behind at the ported `agent`
// floor, which left the write side TWO ranks below the read side
// (agent=2 vs admin=4 in `lib/roles.ts`): a caller who could not list,
// open or audit a single automation could still `create` one and
// `setActive` it. That is not a smaller privilege than reading, it is a
// strictly larger one — an active automation sends WhatsApp messages to
// real contacts on the account's own number, and its `send_webhook`
// step POSTs the run context (contact name, phone, inbound message
// text) to any URL the step names, so the gap was an account-wide
// message-sending and data-egress primitive handed to the second-lowest
// role. `remove` at the same floor let that caller delete automations
// it was never allowed to see. Reads and writes are now both `admin`,
// matching the nav policy that was always the intent. If a lower role
// ever legitimately needs this section, the nav allowlist and these
// floors must move together, never one without the other.
//
// Activation guard: `create`/`update`/`setActive` run the source's
// `validateStepsForActivation`/`validateTriggerForActivation` gate
// (reusing `convex/lib/automations/validate.ts` verbatim, never
// reimplemented) whenever a write would leave the automation ACTIVE,
// refusing a malformed step/trigger structure with a `VALIDATION_FAILED`
// `ConvexError` — the same shape `flows.activate` throws via
// `convex/lib/flows/validate.ts`. Draft saves and deactivations are never
// validated, so work-in-progress can still be saved and a running
// automation can still be paused without first fixing it. See
// `assertActivatable` below.
// ============================================================

/**
 * Spec-ported from `src/lib/automations/templates.ts`'s
 * `AUTOMATION_TEMPLATES`, values copied verbatim. Steps stay in the
 * legacy flat seed form (`parent_index`/`branch`) exactly like the
 * source — `normalizeStepsInput` below (the same auto-detect gate the
 * original `insertSteps` used) converts them via the already-ported,
 * pure `seedsToTree`.
 */
const AUTOMATION_TEMPLATES: Record<
  string,
  {
    name: string;
    description: string;
    triggerType: string;
    triggerConfig: Record<string, unknown>;
    steps: BuilderStepInput[];
  }
> = {
  welcome_message: {
    name: "Welcome Message",
    description: "Auto-reply to first-time contacts with a greeting.",
    triggerType: "first_inbound_message",
    triggerConfig: {},
    steps: [
      {
        step_type: "send_message",
        step_config: {
          text: "Hi! 👋 Thanks for reaching out. We'll get back to you shortly.",
        },
      },
      { step_type: "add_tag", step_config: { tag_id: "" } },
    ],
  },
  out_of_office: {
    name: "Out of Office",
    description: "Auto-reply during off-hours so nobody is left waiting.",
    triggerType: "new_message_received",
    triggerConfig: {},
    steps: [
      {
        step_type: "condition",
        step_config: { subject: "time_of_day", operand: "18:00-09:00" },
      },
      {
        step_type: "send_message",
        step_config: {
          text: "Thanks for your message! Our team is offline right now (9am–6pm) and will reply first thing tomorrow.",
        },
        parent_index: 0,
        branch: "yes",
      },
    ],
  },
  lead_qualifier: {
    name: "Lead Qualifier",
    description: "Ask qualification questions to filter inbound leads.",
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["pricing", "quote", "buy"], match_type: "contains" },
    steps: [
      {
        step_type: "send_message",
        step_config: {
          text: "Great — happy to help with pricing! Quick question: roughly how many seats are you looking for?",
        },
      },
      { step_type: "wait", step_config: { amount: 10, unit: "minutes" } },
      { step_type: "assign_conversation", step_config: { mode: "round_robin" } },
    ],
  },
  follow_up_reminder: {
    name: "Follow-up Reminder",
    description: "Send a nudge if a contact has not replied within 24 hours.",
    triggerType: "new_message_received",
    triggerConfig: {},
    steps: [
      { step_type: "wait", step_config: { amount: 1, unit: "days" } },
      {
        step_type: "send_message",
        step_config: {
          text: "Just circling back — did you have any other questions for us? Happy to help!",
        },
      },
    ],
  },
};

/**
 * Loads an automation and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — same error for "doesn't exist" and "exists but
 * isn't yours" on purpose (mirrors `contacts.ts`'s `requireOwnContact`),
 * so a cross-account probe can't distinguish the two.
 */
async function requireOwnAutomation(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  automationId: Id<"automations">,
) {
  const automation = await ctx.db.get(automationId);
  if (!automation || automation.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "automation" });
  }
  return automation;
}

/** Steps for one automation, fetched once and sorted by `position` —
 * `buildStepsTree` (and `insertStepsTree` below) both rely on receiving
 * rows/steps in position order, since sibling order in the rebuilt tree
 * (and each branch bucket's push order) follows input order, not any
 * sort the caller does afterward. */
async function loadOrderedSteps(
  ctx: { db: QueryCtx["db"] },
  automationId: Id<"automations">,
): Promise<Doc<"automationSteps">[]> {
  const rows = await ctx.db
    .query("automationSteps")
    .withIndex("by_automation", (q) => q.eq("automationId", automationId))
    .collect();
  return rows.sort((a, b) => a.position - b.position);
}

/**
 * Adapts one `automationSteps` row into the pure `stepsTree.ts` shape, and
 * is the single place the schema's documented `stepKey ?? _id` fallback is
 * applied on the READ side (see `automationSteps.stepKey`'s own comment).
 *
 * The fallback has to live here rather than in `buildStepsTree`: that
 * module is deliberately a faithful passthrough of whatever `StepRow` it's
 * handed (its own test pins that), and it has no business knowing that
 * `StepRow.id` happens to be a Convex `_id` — the very value the WRITE side
 * resolves the same fallback to. This function is the only layer that sees
 * both fields as what they actually are.
 *
 * Without it the contract is broken exactly where it matters: for a step
 * that predates key-minting, `automationsEngine.ts` records both
 * `automationStepStats.stepKey` and a parked run's `currentStepKey` as
 * `step.stepKey ?? step._id` — the row id — while `get` handed the builder
 * a bare `undefined`, so the UI's per-step lookups missed real data. It
 * stays a fallback, never an override: a minted key still wins.
 */
function toStepRow(row: Doc<"automationSteps">): StepRow {
  return {
    id: row._id,
    parentStepId: row.parentStepId,
    branch: row.branch,
    stepType: row.stepType,
    stepConfig: row.stepConfig,
    stepKey: row.stepKey ?? row._id,
  };
}

/**
 * Ported verbatim from the original `insertSteps`'s own gate: a
 * `steps` array is either already the nested `branches: {yes, no}`
 * tree the builder UI posts, or the legacy flat seed form (each step
 * optionally carrying `parent_index`/`branch`, as `AUTOMATION_TEMPLATES`
 * above uses) that needs `seedsToTree` first. Only the top-level array
 * is inspected — exactly like the source, which never looked inside an
 * already-nested step's `branches` for stray flat markers.
 */
function normalizeStepsInput(input: BuilderStepInput[]): BuilderStepInput[] {
  const looksFlat = input.some(
    (s) => s.branch !== undefined || s.parent_index !== undefined,
  );
  return looksFlat ? seedsToTree(input) : input;
}

const STEP_KEY_HEX_CHARS = "0123456789abcdef";

function stepKeyBytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += STEP_KEY_HEX_CHARS[byte >> 4] + STEP_KEY_HEX_CHARS[byte & 0x0f];
  }
  return out;
}

/**
 * Mints a fresh `automationSteps.stepKey`. Hand-rolled UUIDv4 (RFC 4122
 * §4.4 version/variant bits set over 16 CSPRNG bytes) via
 * `crypto.getRandomValues`, NOT `crypto.randomUUID()` — matching this
 * codebase's established convention (`convex/webhookDelivery.ts`'s
 * `randomUuidV4`, `convex/lib/apiKey.ts`/`inviteToken.ts`, `convex/lib/
 * r2/keys.ts`'s `defaultRandomHex`) of not assuming `randomUUID` over the
 * more conservatively-supported Web Crypto primitive. Confirmed `crypto.
 * randomUUID` IS present under the `edge-runtime` vitest environment
 * `convex/**.test.ts` runs under (see vitest.config.ts), but that is the
 * test shim, not proof it is present in every real Convex deployment's
 * isolate — `r2/keys.ts`'s own comment calls `getRandomValues` "known-good
 * in Convex's default runtime" specifically because `randomUUID` is not
 * relied on. This codebase has already made that call six times over; a
 * seventh call site shouldn't be the first to gamble on it. Only needs to
 * be unique + string-shaped for a `stepKey`, same contract every other
 * caller of this pattern has.
 */
function mintStepKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10
  const hex = stepKeyBytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Recursively inserts a builder step tree as flat `automationSteps`
 * rows, top-down. This is the genuinely new piece `convex/lib/
 * automations/stepsTree.ts`'s header comment flags as NOT ported there
 * ("belongs to Task 3 / this task"): the original `insertSteps` could
 * pre-assign a UUID to every node before a single bulk INSERT so
 * `parent_step_id` references resolved within one round trip — Convex's
 * `ctx.db.insert` only returns a real `Id` AFTER the write commits, so
 * each node must be inserted before its children can reference it.
 * `position` is the index within its own sibling list (root list or one
 * branch bucket), matching the original's per-level `steps.forEach((s,
 * idx) => ...)` numbering.
 *
 * Every inserted row also gets a `stepKey` (Task 10, see the schema
 * field's comment): the incoming `step.id` is reused verbatim when the
 * caller supplied one — a save round-tripping a step the builder already
 * knew about, via `automation-builder.tsx`'s `toApiSteps` — otherwise a
 * fresh one is minted for a step that has never been saved before.
 * Callers that must NOT reuse an incoming id (`duplicate`, below) strip
 * `step.id` before calling this.
 */
async function insertStepsTree(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  automationId: Id<"automations">,
  steps: BuilderStepInput[],
  parentStepId: Id<"automationSteps"> | undefined,
  branch: "yes" | "no" | undefined,
): Promise<void> {
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]!;
    const stepId = await ctx.db.insert("automationSteps", {
      accountId,
      automationId,
      parentStepId,
      branch,
      stepType: step.step_type as Doc<"automationSteps">["stepType"],
      stepConfig: step.step_config ?? {},
      position: index,
      stepKey: step.id && step.id.trim() ? step.id : mintStepKey(),
    });
    if (step.step_type === "condition" && step.branches) {
      if (step.branches.yes && step.branches.yes.length > 0) {
        await insertStepsTree(ctx, accountId, automationId, step.branches.yes, stepId, "yes");
      }
      if (step.branches.no && step.branches.no.length > 0) {
        await insertStepsTree(ctx, accountId, automationId, step.branches.no, stepId, "no");
      }
    }
  }
}

/**
 * Delete-then-reinsert, matching the source `replaceSteps`'s DELETE +
 * `insertSteps` semantics for a PATCH that supplies a new `steps` tree.
 */
async function replaceSteps(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  automationId: Id<"automations">,
  steps: BuilderStepInput[],
): Promise<void> {
  const existing = await ctx.db
    .query("automationSteps")
    .withIndex("by_automation", (q) => q.eq("automationId", automationId))
    .collect();
  for (const row of existing) {
    await ctx.db.delete(row._id);
  }
  const tree = normalizeStepsInput(steps);
  await insertStepsTree(ctx, accountId, automationId, tree, undefined, undefined);
}

/**
 * Refuses to *activate* a structurally-broken automation, reusing the
 * already-ported pure validators in `convex/lib/automations/validate.ts`
 * verbatim (never reimplemented) — the same guard `flows.activate` runs
 * via `convex/lib/flows/validate.ts`. An automation whose trigger/steps
 * are malformed (a `keyword_match` with no keywords, an `add_tag` with no
 * `tag_id`, zero steps, ...) used to activate silently and then no-op on
 * every trigger, surfacing only as cryptic failed log rows; this makes
 * the write refuse with a `VALIDATION_FAILED` `ConvexError` at save time.
 * Unlike `flows`' validator there is no `severity` axis here — every
 * issue these two functions return is a blocker.
 *
 * Callers invoke this ONLY when a write would leave the automation ACTIVE
 * — draft saves and deactivations are never validated, so users can save
 * broken work-in-progress and pause a running automation without first
 * fixing it (mirroring `flows.activate`'s "drafts/archives are
 * unconditional" rule).
 */
function assertActivatable(
  steps: BuilderStepInput[],
  triggerType: string,
  triggerConfig: unknown,
): void {
  const issues = [
    ...validateTriggerForActivation(triggerType, triggerConfig),
    ...validateStepsForActivation(steps),
  ];
  if (issues.length > 0) {
    throw new ConvexError({
      code: "VALIDATION_FAILED",
      message: "Cannot activate automation — fix the issues below first.",
      // Spread each issue into a fresh object literal so the array
      // structurally satisfies Convex's `Value` type (which needs an
      // index signature) — a bare `ValidationIssue[]` interface doesn't
      // get that bypass. Same trick as `flows.activate`.
      issues: issues.map((issue) => ({ ...issue })),
    });
  }
}

/**
 * How many rows of ONE status `countRunsBounded` below reads before
 * treating that status's count as a floor rather than an exact figure.
 * Fix wave (2026-08), finding 4: `list` used to `.collect()` every run
 * row of every automation, inside a `Promise.all` over the whole
 * account — unbounded in exactly the dimension (`automationRuns`, the
 * fastest-growing table this phase adds, pruned only on automation
 * deletion) that eventually throws once an account crosses Convex's
 * per-transaction read limit, taking `/automations` down as a hard
 * error rather than degraded counts. This repo has had exactly that
 * shape of outage before — `/settings?tab=cron` (143d66c) — from the
 * same mistake: capping the PAYLOAD (`.slice`/display) instead of the
 * READ itself.
 *
 * Bounded per STATUS, not per automation as a single scan, because
 * `RunCounts` is a breakdown BY status (`RunStatsBar`'s Enrolled/
 * Waiting/Sent/Failed chips) — a single capped scan over an unfiltered
 * range would skew toward whichever statuses happen to sort first
 * rather than giving an honest (if capped) count of each. 200 mirrors
 * this file's own `RUN_CANCEL_BATCH`-class conservatism: the number of
 * AUTOMATIONS an account defines is bounded by human effort (`list`'s
 * own `Promise.all` is over automations, not runs), so a per-status
 * cap here converts "grows without bound as runs accumulate" (the
 * actual reported danger) into "bounded by automation count times a
 * constant" — a fundamentally safer growth curve, not just a bigger
 * number.
 */
export const RUN_COUNTS_STATUS_CAP = 200;

const RUN_STATUSES_FOR_COUNTING = [
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;

/**
 * `RunCounts` for one automation, read as five separate bounded,
 * indexed range reads (one per status, via the same
 * `by_account_automation_status` index `stepStats`/`waitingRuns` below
 * already use) rather than one unbounded `.collect()`. Reuses
 * `summarizeRuns` (`convex/lib/automations/runStats.ts`) so the
 * counting logic itself stays the single already-tested source of
 * truth for what "enrolled" etc. mean — this only bounds WHAT gets
 * fed into it.
 *
 * A status that comes back at exactly the cap means there may be MORE
 * rows this read never saw — logged via `console.warn` (Convex logs,
 * for operators) AND returned as `RunCounts.truncated` (re-review fix,
 * 2026-08: the console warning alone left the read bound genuine but
 * the PAYLOAD silent — `RunStatsBar` rendered "200 enrolled / 200
 * waiting" with nothing on the page itself saying it was a floor, the
 * exact "reads as complete when it isn't" failure this finding was
 * about, just moved from the read to the payload). Mirrors
 * `sweepTimeBased`'s own `truncated` field in `automationsEngine.ts`
 * for the identical class of bounded-audience read.
 */
async function countRunsBounded(
  ctx: { db: QueryCtx["db"] },
  accountId: Id<"accounts">,
  automationId: Id<"automations">,
): Promise<ReturnType<typeof summarizeRuns>> {
  // The five status reads are independent, so they are issued together
  // rather than awaited one after another. Sequentially this was five
  // round trips deep per automation — and `list` below pays that for
  // EVERY automation in the account, so the serial version made the
  // whole page's latency scale with (automations x statuses) instead of
  // just with the slowest single read. `summarizeRuns` only tallies by
  // status, so the order rows arrive in does not affect the result.
  const batches = await Promise.all(
    RUN_STATUSES_FOR_COUNTING.map((status) =>
      ctx.db
        .query("automationRuns")
        .withIndex("by_account_automation_status", (q) =>
          q.eq("accountId", accountId).eq("automationId", automationId).eq("status", status),
        )
        .take(RUN_COUNTS_STATUS_CAP),
    ),
  );
  const rows: { status: string }[] = batches.flat();
  const truncated = batches.some((b) => b.length === RUN_COUNTS_STATUS_CAP);
  if (truncated) {
    console.warn(
      "[automations] runCounts capped — at least one status hit the read bound, so its count (and enrolled) is a floor, not exact",
      { accountId, automationId, cap: RUN_COUNTS_STATUS_CAP },
    );
  }
  return { ...summarizeRuns(rows), truncated };
}

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    // Admin+: `/automations` is absent from `SUPERVISOR_NAV`, so
    // `canAccessNav` already admits only admin/owner in the UI. `get` and
    // `logs` share the floor so the list can't be walked around.
    ctx.requireRole("admin");
    const automations = await ctx.db
      .query("automations")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .collect();

    return await Promise.all(
      automations.map(async (automation) => {
        // Step rows and run counts are independent reads — issued
        // together, not one after the other, for the same reason
        // `countRunsBounded` batches its own five.
        const [steps, runCounts] = await Promise.all([
          ctx.db
            .query("automationSteps")
            .withIndex("by_automation", (q) => q.eq("automationId", automation._id))
            .collect(),
          countRunsBounded(ctx, ctx.accountId, automation._id),
        ]);
        return { ...automation, stepCount: steps.length, runCounts };
      }),
    );
  },
});

export const get = accountQuery({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // same floor as `list`
    const automation = await requireOwnAutomation(ctx, args.automationId);
    const rows = await loadOrderedSteps(ctx, args.automationId);
    const steps = buildStepsTree(rows.map(toStepRow));
    return { automation, steps };
  },
});

export const create = accountMutation({
  args: {
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    triggerType: v.optional(v.string()),
    triggerConfig: v.optional(v.any()),
    isActive: v.optional(v.boolean()),
    steps: v.optional(v.array(v.any())),
    template: v.optional(v.string()),
    // See `schema.ts`'s own comment on `automations.stopOnReply` — new
    // in Task 5, optional and default-off.
    stopOnReply: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // same floor as every read — see WRITE FLOOR above

    let effectiveName = args.name;
    let effectiveDescription = args.description;
    let effectiveTriggerType = args.triggerType;
    let effectiveTriggerConfig = args.triggerConfig;
    let effectiveSteps = args.steps as BuilderStepInput[] | undefined;

    // Template seed path — ported from the source POST: a `template`
    // slug only takes effect when no steps were explicitly supplied,
    // and only fills in whichever of name/description/trigger the
    // caller left unset.
    if (args.template && (!effectiveSteps || effectiveSteps.length === 0)) {
      const tpl = AUTOMATION_TEMPLATES[args.template];
      if (tpl) {
        effectiveName = effectiveName ?? tpl.name;
        effectiveDescription = effectiveDescription ?? tpl.description;
        effectiveTriggerType = effectiveTriggerType ?? tpl.triggerType;
        effectiveTriggerConfig = effectiveTriggerConfig ?? tpl.triggerConfig;
        effectiveSteps = tpl.steps;
      }
    }

    if (!effectiveName || !effectiveTriggerType) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: "name and triggerType are required",
      });
    }

    // Normalize once so the SAME tree is both validated (below) and
    // inserted (further down): the validator walks `branches`, so it must
    // see the nested shape `insertStepsTree` stores, not the flat
    // template-seed form `normalizeStepsInput` converts.
    const tree: BuilderStepInput[] =
      effectiveSteps && effectiveSteps.length > 0
        ? normalizeStepsInput(effectiveSteps)
        : [];

    // Creating an automation already switched ON runs the same activation
    // validation as `update`/`setActive` and `flows.activate`.
    if (args.isActive) {
      assertActivatable(tree, effectiveTriggerType, effectiveTriggerConfig ?? {});
    }

    const automationId = await ctx.db.insert("automations", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      name: effectiveName,
      description: effectiveDescription,
      triggerType: effectiveTriggerType,
      triggerConfig: effectiveTriggerConfig ?? {},
      isActive: !!args.isActive,
      executionCount: 0,
      updatedAt: Date.now(),
      stopOnReply: args.stopOnReply,
    });

    if (tree.length > 0) {
      await insertStepsTree(ctx, ctx.accountId, automationId, tree, undefined, undefined);
    }

    return automationId;
  },
});

export const update = accountMutation({
  args: {
    automationId: v.id("automations"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    triggerType: v.optional(v.string()),
    triggerConfig: v.optional(v.any()),
    isActive: v.optional(v.boolean()),
    steps: v.optional(v.array(v.any())),
    // See `schema.ts`'s own comment on `automations.stopOnReply` — new
    // in Task 5, optional and default-off.
    stopOnReply: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // same floor as every read — see WRITE FLOOR above
    const { automationId, steps, ...rest } = args;
    const existing = await requireOwnAutomation(ctx, automationId);

    // Normalized once, up front, so both the activation check below and
    // the change-detection guard further down (finding 3, fix wave
    // 2026-08) work off the SAME incoming tree rather than each calling
    // `normalizeStepsInput` on their own.
    const incomingTree: BuilderStepInput[] | undefined =
      steps !== undefined ? normalizeStepsInput(steps as BuilderStepInput[]) : undefined;

    // If this PATCH would leave the automation ACTIVE — either it flips
    // `isActive` on, or it's already on and staying on while its
    // steps/trigger change — validate the *resulting* config (new fields
    // where supplied, the stored ones otherwise), so an active automation
    // can't be quietly edited into a broken state and a broken one can't
    // be switched on. Deactivations and edits to an inactive draft skip
    // this. See `assertActivatable`.
    const willBeActive = rest.isActive !== undefined ? rest.isActive : existing.isActive;
    if (willBeActive) {
      const resultingTriggerType =
        rest.triggerType !== undefined ? rest.triggerType : existing.triggerType;
      const resultingTriggerConfig =
        rest.triggerConfig !== undefined ? rest.triggerConfig : existing.triggerConfig;
      const resultingSteps =
        incomingTree ?? buildStepsTree((await loadOrderedSteps(ctx, automationId)).map(toStepRow));
      assertActivatable(resultingSteps, resultingTriggerType, resultingTriggerConfig ?? {});
    }

    // Only ever patch fields the caller actually supplied — mirrors the
    // source PATCH's `for (const k of [...]) if (k in body) update[k] =
    // body[k]`. `updatedAt` is stamped ONLY when at least one of these
    // lands (matching the source: a PATCH carrying only `steps` never
    // issues an `automations` UPDATE at all, so Postgres's on-UPDATE
    // trigger for `updated_at` never fires for a steps-only PATCH).
    const patch: Partial<{
      name: string;
      description: string;
      triggerType: string;
      triggerConfig: unknown;
      isActive: boolean;
      updatedAt: number;
      stopOnReply: boolean;
    }> = {};
    if (rest.name !== undefined) patch.name = rest.name;
    if (rest.description !== undefined) patch.description = rest.description;
    if (rest.triggerType !== undefined) patch.triggerType = rest.triggerType;
    if (rest.triggerConfig !== undefined) patch.triggerConfig = rest.triggerConfig;
    if (rest.isActive !== undefined) patch.isActive = rest.isActive;
    if (rest.stopOnReply !== undefined) patch.stopOnReply = rest.stopOnReply;

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = Date.now();
      await ctx.db.patch(automationId, patch);
    }

    // Fix wave (2026-08), finding 3: `steps !== undefined` alone is a
    // dead guard in practice — `automation-builder.tsx`'s `save()`
    // sends the full (edited or not) steps array on EVERY save, so a
    // pure rename or a `stopOnReply` toggle looked identical, at this
    // check, to a real structural edit. `stepsTreeEqual` (`convex/lib/
    // automations/stepsTree.ts`) makes the actual, originally-intended
    // distinction: did the tree ACTUALLY change, not merely "was a
    // steps array present". A byte-for-byte resend (the real UI's
    // rename-only path) now skips `replaceSteps` entirely — which also
    // means it does NOT churn every step row's `_id`, so a run parked
    // inside a `condition` branch stays resumable across it too, not
    // just spared the cancellation below.
    if (incomingTree !== undefined) {
      const storedTree = buildStepsTree((await loadOrderedSteps(ctx, automationId)).map(toStepRow));
      if (!stepsTreeEqual(storedTree, incomingTree)) {
        await replaceSteps(ctx, ctx.accountId, automationId, steps as BuilderStepInput[]);
        // A waiting run's suspension tuple (`parentStepId`, and the same
        // argument the scheduler holds for `resume`) is a step ROW ID,
        // and `replaceSteps` just deleted every one of them. Task 10's
        // `stepKey` made per-step STATS durable, but not the engine's
        // resume scope — rekeying that would mean reworking
        // `resume`/`executeStepsFrom`/`scopedSteps`, out of scope here.
        //
        // So cancel instead. Editing an automation while contacts are
        // queued inside it is genuinely ambiguous, and "cancelled —
        // automation edited" is a better answer than silently stranding
        // them as permanently `waiting` or resuming them into a tree
        // that changed underneath — confirmed by this task's own
        // failing test: without this call, a resume that lands after a
        // steps-replacing save either runs a step tree that no longer
        // matches what the wait was scheduled against, or (when the new
        // tree is shorter) finds nothing at its old `nextPosition` and
        // finishes the run as if it had completed cleanly. Gated on a
        // GENUINE structural change (not just `steps !== undefined`) —
        // see this block's own header comment.
        await ctx.scheduler.runAfter(0, internal.automationsEngine.cancelRunsForAutomation, {
          accountId: ctx.accountId,
          automationId,
          reason: "automation edited",
        });
      }
    }

    // Fix wave (2026-08), finding 5: deactivating via `update` must stop
    // queued work exactly like `setActive(false)` does (below). Latent
    // until now because the only caller (`automation-builder.tsx`)
    // always sends the full steps array too, which — before finding 3's
    // fix — already triggered the cancellation above for an unrelated
    // reason on every save. `update` is a public `accountMutation`
    // though, and nothing in its own contract limits a caller to that
    // shape — finding 2's `resume`-time `isActive` re-check makes a
    // missed cancellation harmless rather than a live send, but closing
    // this gap too means a run reaches "cancelled" promptly instead of
    // sitting as "waiting" until its scheduled resume eventually wakes
    // up and self-cancels.
    if (rest.isActive === false) {
      await ctx.scheduler.runAfter(0, internal.automationsEngine.cancelRunsForAutomation, {
        accountId: ctx.accountId,
        automationId,
        reason: "automation deactivated",
      });
    }

    return automationId;
  },
});

export const setActive = accountMutation({
  args: { automationId: v.id("automations"), isActive: v.boolean() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // same floor as every read — see WRITE FLOOR above
    const existing = await requireOwnAutomation(ctx, args.automationId);

    // Switching ON runs the same activation validation as create/update
    // and flows.activate; switching OFF is unconditional (you can always
    // pause a running automation). See `assertActivatable`.
    if (args.isActive) {
      const steps = buildStepsTree(
        (await loadOrderedSteps(ctx, args.automationId)).map(toStepRow),
      );
      assertActivatable(steps, existing.triggerType, existing.triggerConfig ?? {});
    }

    await ctx.db.patch(args.automationId, {
      isActive: args.isActive,
      updatedAt: Date.now(),
    });

    // Pausing must actually stop queued work. Without this, a
    // deactivated automation's already-scheduled resumes keep firing
    // and keep sending — the bug Task 5 exists to close.
    if (!args.isActive) {
      await ctx.scheduler.runAfter(0, internal.automationsEngine.cancelRunsForAutomation, {
        accountId: ctx.accountId,
        automationId: args.automationId,
        reason: "automation deactivated",
      });
    }

    return args.automationId;
  },
});

/**
 * How many `automationLogs` rows one transaction may delete. Convex bounds
 * both the documents a transaction reads and what it writes, and this cascade
 * does both to every row — so an automation with a large enough log history
 * could not be deleted AT ALL: the mutation threw on every attempt, with no
 * way for a user to get past it.
 *
 * Deliberately conservative. `stepsExecuted` is `v.any()`, so a log row has no
 * bounded size and a batch's byte cost cannot be predicted from its row count.
 * Raising this trades scheduler rows (one continuation per batch) against
 * per-transaction risk; 512 keeps a full batch far below the read budget while
 * leaving room for rows with large step payloads.
 */
export const LOG_CASCADE_BATCH = 512;

/**
 * Deletes one batch of a removed automation's logs and re-schedules itself
 * while a full batch keeps coming back. Internal-only: it takes `accountId`
 * explicitly (an internalMutation has no user session) and ranges on the same
 * `by_account_automation` index `remove` does, so it can never reach beyond
 * the account whose automation was deleted.
 *
 * Terminates when a short batch comes back, which is also why the delete must
 * be `.take(LOG_CASCADE_BATCH)` and not a filtered read: a `.filter()` that
 * matched nothing would return short while rows remained, and the purge would
 * stop early leaving orphans behind forever.
 */
export const purgeAutomationLogs = internalMutation({
  args: {
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
  },
  handler: async (ctx, args): Promise<void> => {
    const logs = await ctx.db
      .query("automationLogs")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", args.accountId).eq("automationId", args.automationId),
      )
      .take(LOG_CASCADE_BATCH);
    for (const log of logs) {
      await ctx.db.delete(log._id);
    }
    if (logs.length === LOG_CASCADE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.automations.purgeAutomationLogs, {
        accountId: args.accountId,
        automationId: args.automationId,
      });
    }
  },
});

/**
 * Same shape as `purgeAutomationLogs` immediately above, for
 * `automationRuns` — added by Task 5 alongside that task's cancellation
 * mutations, so a removed automation's run history (which can grow as
 * unboundedly as its log history — one row per enrolment) doesn't leak
 * rows the way it did before this table existed.
 */
export const purgeAutomationRuns = internalMutation({
  args: {
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
  },
  handler: async (ctx, args): Promise<void> => {
    const runs = await ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", args.accountId).eq("automationId", args.automationId),
      )
      .take(LOG_CASCADE_BATCH);
    for (const run of runs) {
      await ctx.db.delete(run._id);
    }
    if (runs.length === LOG_CASCADE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.automations.purgeAutomationRuns, {
        accountId: args.accountId,
        automationId: args.automationId,
      });
    }
  },
});

/** Same shape again, for `automationStepStats`. */
export const purgeAutomationStepStats = internalMutation({
  args: {
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
  },
  handler: async (ctx, args): Promise<void> => {
    const stats = await ctx.db
      .query("automationStepStats")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", args.accountId).eq("automationId", args.automationId),
      )
      .take(LOG_CASCADE_BATCH);
    for (const stat of stats) {
      await ctx.db.delete(stat._id);
    }
    if (stats.length === LOG_CASCADE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.automations.purgeAutomationStepStats, {
        accountId: args.accountId,
        automationId: args.automationId,
      });
    }
  },
});

export const remove = accountMutation({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // same floor as every read — see WRITE FLOOR above
    await requireOwnAutomation(ctx, args.automationId);

    // Explicit cascade — Convex has no ON DELETE. Postgres declared
    // BOTH `automation_steps.automation_id` and `automation_logs.
    // automation_id` as `REFERENCES automations(id) ON DELETE CASCADE`
    // (migration 006_automations.sql), so both child sets are deleted
    // here before the automation row itself goes. `automationPending
    // Executions` also cascaded in Postgres, but is never written to by
    // this Convex engine (see `automationsEngine.ts`'s header comment)
    // — there is nothing to clean up there.
    const steps = await ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", args.automationId))
      .collect();
    for (const step of steps) {
      await ctx.db.delete(step._id);
    }

    // Ranged on `by_account_automation` rather than filtering an account-wide
    // scan, and capped at one batch rather than collecting the lot: this
    // cascade both reads and writes every row it touches, so an automation
    // with a large enough log history used to be undeletable outright — the
    // mutation blew the per-transaction budget on every attempt. Whatever is
    // left over drains through `purgeAutomationLogs`.
    //
    // Only the LOG cleanup is deferred. The automation and its steps go in
    // this transaction, so the delete is immediate as far as the user is
    // concerned; the trade-off is a window where log rows outlive the
    // automation they point at. Nothing breaks on that — `dashboard.activity`
    // is the only reader that resolves `log.automationId` and it already
    // falls back to "Automation" for a missing row, and the logs page gates
    // on `automations.get`, which is already gone by then.
    const logs = await ctx.db
      .query("automationLogs")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", ctx.accountId).eq("automationId", args.automationId),
      )
      .take(LOG_CASCADE_BATCH);
    for (const log of logs) {
      await ctx.db.delete(log._id);
    }
    if (logs.length === LOG_CASCADE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.automations.purgeAutomationLogs, {
        accountId: ctx.accountId,
        automationId: args.automationId,
      });
    }

    // Same batching shape again, for `automationRuns` and
    // `automationStepStats` — added by Task 5 alongside that task's
    // cancellation mutations, so a removed automation's run history
    // (which can grow as unboundedly as its log history — one row per
    // enrolment) doesn't leak rows the way it did before those tables
    // existed. `purgeAutomationRuns`/`purgeAutomationStepStats` (defined
    // above) drain whatever overflows this first batch.
    const runs = await ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", ctx.accountId).eq("automationId", args.automationId),
      )
      .take(LOG_CASCADE_BATCH);
    for (const run of runs) {
      await ctx.db.delete(run._id);
    }
    if (runs.length === LOG_CASCADE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.automations.purgeAutomationRuns, {
        accountId: ctx.accountId,
        automationId: args.automationId,
      });
    }

    const stats = await ctx.db
      .query("automationStepStats")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", ctx.accountId).eq("automationId", args.automationId),
      )
      .take(LOG_CASCADE_BATCH);
    for (const stat of stats) {
      await ctx.db.delete(stat._id);
    }
    if (stats.length === LOG_CASCADE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.automations.purgeAutomationStepStats, {
        accountId: ctx.accountId,
        automationId: args.automationId,
      });
    }

    // Deleting must actually stop queued work too — same reasoning as
    // `setActive(false)` above. A `waiting` run whose row survives past
    // this first inline batch (large history, deferred to the scheduled
    // purge above) is still reachable by this: `cancelRunsForAutomation`
    // and the purges above are independent, separately-scheduled jobs
    // with no ordering guarantee between them, so a run that the purge
    // happens to delete first is simply gone before this ever sees it —
    // its OWN scheduled resume is never explicitly cancelled (a harmless
    // zombie scheduled function), but `markRunRunning`'s null-row guard
    // still refuses to execute it when it eventually fires, so no send
    // ever reaches the customer either way.
    await ctx.scheduler.runAfter(0, internal.automationsEngine.cancelRunsForAutomation, {
      accountId: ctx.accountId,
      automationId: args.automationId,
      reason: "automation deleted",
    });

    await ctx.db.delete(args.automationId);
  },
});

/**
 * Strips `buildStepsTree`'s tree-reconstruction `id` (the ORIGINAL row's
 * real `_id`, carried only to resolve `parentStepId` edges while
 * rebuilding the tree — see `StepRow`'s comment in stepsTree.ts) before
 * handing the tree to `insertStepsTree`. Left in place, `duplicate`'s
 * clone would inherit `stepKey = original row's real _id`:
 * `insertStepsTree` treats any non-empty `step.id` as "reuse this as the
 * key," and a `BuilderStepNode` always has one. That would not literally
 * collide with the ORIGINAL's own `stepKey` (a row `_id` and a `stepKey`
 * are different values), but it would pin the clone's key to a value that
 * has nothing to do with its own identity instead of a freshly minted
 * one — the opposite of what `duplicate` is for. Every cloned step must
 * mint a genuinely fresh key, so `id` is dropped here rather than merely
 * happening not to collide.
 */
function stripTreeIds(nodes: BuilderStepNode[]): BuilderStepInput[] {
  return nodes.map((n) => ({
    step_type: n.step_type,
    step_config: n.step_config,
    branches: { yes: stripTreeIds(n.branches.yes), no: stripTreeIds(n.branches.no) },
  }));
}

export const duplicate = accountMutation({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // same floor as every read — see WRITE FLOOR above
    const original = await requireOwnAutomation(ctx, args.automationId);

    const copyId = await ctx.db.insert("automations", {
      accountId: original.accountId,
      createdByUserId: ctx.userId,
      name: `${original.name} (Copy)`,
      description: original.description,
      triggerType: original.triggerType,
      triggerConfig: original.triggerConfig,
      isActive: false,
      executionCount: 0,
      updatedAt: Date.now(),
    });

    // Convex can't pre-assign ids for a single-pass id-remap the way the
    // source's `Map<oldId, newId>` two-pass copy did (see stepsTree.ts's
    // header comment on why bulk pre-assigned-UUID inserts don't
    // translate). Rebuilding into the nested tree (the same pure
    // `buildStepsTree` helper `get` uses) and re-flattening it under the
    // new automation id via `insertStepsTree` gets the same result
    // without a bespoke id map. `stripTreeIds` (above) then clears the
    // tree-reconstruction id so every cloned step mints its own fresh
    // `stepKey` instead of inheriting anything from the original.
    const rows = await loadOrderedSteps(ctx, args.automationId);
    if (rows.length > 0) {
      const tree = stripTreeIds(buildStepsTree(rows.map(toStepRow)));
      await insertStepsTree(ctx, original.accountId, copyId, tree, undefined, undefined);
    }

    return copyId;
  },
});

/**
 * Newest-first log history for the account, optionally narrowed to one
 * automation.
 *
 * `limit` bounds the READ, not just the payload. The previous form collected
 * the whole account partition and then `.slice(0, limit)`d it in JS, so the
 * argument capped what was returned while the query still read every log row
 * the account had ever written — the same "the cap is on the payload, not the
 * scan" mistake that took `/settings?tab=cron` down (143d66c). `.take(limit)`
 * on an unfiltered range is a true read bound: exactly that many documents.
 *
 * The filtered branch ranges `automationId` on `by_account_automation` instead
 * of testing it in a `.filter()`, which would not have narrowed the scan — and
 * with `.take()` in front of it would have been strictly worse than the old
 * `.collect()`, since `.take(n)` stops after n *matches* and would walk the
 * whole partition whenever an automation had fewer than `limit` logs. Both
 * branches keep `accountId` as the index prefix, so tenancy stays enforced by
 * the index rather than by a post-scan predicate.
 */
/**
 * The display identity of one contact — just enough for a log/queue row's
 * title. Deliberately NOT the whole contact doc: these rows only ever
 * render a name (falling back to a phone number), and shipping the full
 * document would put every contact field on the wire for every row.
 */
export interface ContactSummary {
  _id: Id<"contacts">;
  name?: string;
  phone: string;
}

/**
 * Resolves the contacts named by a batch of rows in ONE pass, and
 * attaches each row's own summary to it.
 *
 * Replaces a per-row `api.contacts.get` subscription on
 * `/automations/[id]/logs`: every `LogRow` and `WaitingRow` ran its own,
 * so a full page of 100 logs opened 100 extra queries — each of which
 * ALSO embedded that contact's tags — and none of them could even start
 * until the `logs` query they were derived from had already resolved.
 * That is a third sequential round trip on a page that only needs two,
 * multiplied by the row count.
 *
 * Deduped by id, so the common case of one contact appearing across
 * several rows costs a single read. Every contact is re-checked against
 * `accountId` before being returned — `logs`/`waitingRuns` are already
 * account-scoped by their indexes, so this is defense-in-depth in the
 * same spirit as `requireOwnAutomation`, and a row whose contact is
 * missing or foreign simply resolves to `null` (which the UI already
 * renders as "unknown contact", the same as a deleted contact's
 * `SET NULL`-style `contactId`).
 */
async function attachContacts<T extends { contactId?: Id<"contacts"> }>(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  rows: T[],
): Promise<(T & { contact: ContactSummary | null })[]> {
  const byId = new Map<string, ContactSummary | null>();
  for (const row of rows) {
    if (!row.contactId || byId.has(row.contactId)) continue;
    const contact = await ctx.db.get(row.contactId);
    byId.set(
      row.contactId,
      contact && contact.accountId === ctx.accountId
        ? { _id: contact._id, name: contact.name, phone: contact.phone }
        : null,
    );
  }
  return rows.map((row) => ({
    ...row,
    contact: row.contactId ? (byId.get(row.contactId) ?? null) : null,
  }));
}

export const logs = accountQuery({
  args: {
    automationId: v.optional(v.id("automations")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // same floor as `list`
    // Clamp before it reaches `.take()`: a negative throws, and a huge value
    // makes either branch's read as heavy as the `.collect()` this replaced.
    const limit = clampLimit(args.limit, 100, 200);
    const { automationId } = args;

    // `contact` is attached server-side (see `attachContacts`) rather
    // than resolved per row on the client — that used to be one extra
    // `contacts.get` subscription per visible log, none of which could
    // start until this query had already returned.
    if (automationId !== undefined) {
      const rows = await ctx.db
        .query("automationLogs")
        .withIndex("by_account_automation", (q) =>
          q.eq("accountId", ctx.accountId).eq("automationId", automationId),
        )
        .order("desc")
        .take(limit);
      return await attachContacts(ctx, rows);
    }

    const rows = await ctx.db
      .query("automationLogs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .take(limit);
    return await attachContacts(ctx, rows);
  },
});

// ============================================================
// Task 7 — observability for a run's progress through one automation:
// per-step counts (`stepStats`), the live queue (`waitingRuns`), and a
// way to pull one contact out of it (`cancelRun`). `list` above already
// grew a per-automation `runCounts` summary; these four go one level
// deeper, into a single automation.
// ============================================================

/**
 * `runCounts` for ONE automation — the dedicated query finding 4 (fix
 * wave, 2026-08) adds so a single-automation detail page doesn't have
 * to read the account's WHOLE `list` just to pick one row back out of
 * it. Before this existed, `src/app/(dashboard)/automations/[id]/logs/
 * page.tsx` did exactly that (a documented, deliberate fallback at the
 * time — adding this query needed a `convex codegen` run a prior task
 * couldn't perform), which meant a detail page paid the account-wide
 * cost `list` itself was unbounded on. Same bounded counting as
 * `list` (`countRunsBounded`), same ownership/role floor as
 * `stepStats`/`waitingRuns` immediately below.
 */
export const runCounts = accountQuery({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // same floor as `list`/`get`/`logs`
    await requireOwnAutomation(ctx, args.automationId);
    return await countRunsBounded(ctx, ctx.accountId, args.automationId);
  },
});

export const stepStats = accountQuery({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // same floor as `list`/`get`/`logs`
    await requireOwnAutomation(ctx, args.automationId);

    const cumulative = await ctx.db
      .query("automationStepStats")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", ctx.accountId).eq("automationId", args.automationId),
      )
      .collect();

    // "Waiting" is deliberately NOT a stored counter — schema.ts's own
    // comment on `automationStepStats` says so explicitly, because a
    // stored count would be a second source of truth that can drift.
    // Derived here instead, every read, from the live `automationRuns`
    // rows it describes.
    //
    // Bounded by the same `RUN_COUNTS_STATUS_CAP` as `countRunsBounded`
    // above, for the same reason (finding 4): an unbounded `.collect()`
    // over `automationRuns` throws once an account crosses Convex's
    // per-transaction read limit, and this one feeds the builder canvas'
    // per-step chips — so the failure mode is the whole builder page
    // erroring rather than showing capped counts. Smaller in practice
    // than `list`'s was: ONE status, and a transient one (contacts
    // resume out of "waiting", unlike the three terminal statuses that
    // accumulate forever) — which is why the earlier wave left it — but
    // the ceiling is the same, and a busy automation with enough
    // contacts parked on a wait at once reaches it. Capping only omits
    // runs from the per-step breakdown; it cannot misattribute them,
    // since each row carries its own `currentStepKey`.
    const waiting = await ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation_status", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .eq("automationId", args.automationId)
          .eq("status", "waiting"),
      )
      .take(RUN_COUNTS_STATUS_CAP);
    if (waiting.length === RUN_COUNTS_STATUS_CAP) {
      console.warn(
        "[automations] stepStats waiting capped — hit the read bound, so every per-step waiting count is a floor, not exact",
        { accountId: ctx.accountId, automationId: args.automationId, cap: RUN_COUNTS_STATUS_CAP },
      );
    }

    const waitingByStep = new Map<string, number>();
    for (const run of waiting) {
      if (!run.currentStepKey) continue;
      waitingByStep.set(run.currentStepKey, (waitingByStep.get(run.currentStepKey) ?? 0) + 1);
    }

    const byStep = new Map(
      cumulative.map((s) => [
        s.stepKey,
        { stepKey: s.stepKey, reached: s.reached, sent: s.sent, failed: s.failed, waiting: 0 },
      ]),
    );
    // A step can have waiting runs with no cumulative row of its own yet
    // (e.g. a run whose log write was skipped — see `appendLogResults`'s
    // own `if (!args.logId) return` guard) — merge onto the existing row
    // when there is one, otherwise synthesize a zeroed one so the step
    // still appears.
    for (const [stepKey, count] of waitingByStep) {
      const row = byStep.get(stepKey);
      if (row) {
        row.waiting = count;
      } else {
        byStep.set(stepKey, { stepKey, reached: 0, sent: 0, failed: 0, waiting: count });
      }
    }
    return [...byStep.values()];
  },
});

export const waitingRuns = accountQuery({
  args: { automationId: v.id("automations"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // same floor as `list`/`get`/`logs`
    await requireOwnAutomation(ctx, args.automationId);
    const limit = clampLimit(args.limit, 100, 200);
    const rows = await ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation_status", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .eq("automationId", args.automationId)
          .eq("status", "waiting"),
      )
      .take(limit);
    // Soonest resume first. Sorted client-side, over only the `limit`
    // rows `.take()` already bounded the read to — same trade-off as
    // every other bounded list in this file: exact ordering across the
    // WHOLE waiting set would need every row read, not just `limit` of
    // them. Sorted BEFORE `attachContacts` so the contact reads follow
    // the display order rather than the index order.
    rows.sort((a, b) => (a.resumeAt ?? 0) - (b.resumeAt ?? 0));
    return await attachContacts(ctx, rows);
  },
});

export const cancelRun = accountMutation({
  args: { runId: v.id("automationRuns") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // matches every other mutation in this module
    const run = await ctx.db.get(args.runId);
    // Same NOT_FOUND for "doesn't exist" and "exists but isn't yours" as
    // `requireOwnAutomation` above — a cross-account probe must not be
    // able to tell the two apart.
    if (!run || run.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "automationRun" });
    }

    // Only a run Task 5's own cancellation machinery would consider
    // cancellable may actually be cancelled here — the exact two-clause
    // definition `cancelRunsForAutomation`/`cancelRunsForContact` already
    // use (see that mutation's own comment on why `status === "running"`
    // alone doesn't rule a run out: a multi-branch run can read
    // `"running"` overall while a SIBLING condition branch is still
    // genuinely parked on its own live `resume`, tracked only by
    // `outstandingBranches`). Without this, a `runId` copied off an
    // earlier `waitingRuns()` read that has since resumed-and-finished
    // — the exact race Task 8's Cancel button will hit — got silently
    // relabelled "cancelled" over its real outcome, discarding
    // `endedAt`/`errorMessage` and corrupting both the audit trail and
    // the `runCounts` this module reports.
    //
    // Checked strictly AFTER the ownership check above, never before:
    // this must not become a second, distinguishing signal for a
    // cross-account probe. A foreign run has to look identical whether
    // it's waiting, running, or long finished — NOT_FOUND either way —
    // and only a run already confirmed to be the caller's own can ever
    // reach this branch.
    const cancellable =
      run.status === "waiting" ||
      (run.status === "running" && (run.outstandingBranches ?? 0) > 0);
    if (!cancellable) {
      throw new ConvexError({
        code: "NOT_CANCELLABLE",
        message: "This run has already finished and can no longer be cancelled.",
        status: run.status,
      });
    }

    // Cancel the scheduled resume BEFORE patching the row — same
    // ordering, and the same reason, as automationsEngine.ts's
    // `cancelOne` (module-private there, so re-implemented here rather
    // than imported; see this task's own report for why). An
    // already-dequeued-but-not-yet-executed resume calls
    // `markRunRunning`, which guards on the row's status AT THE MOMENT
    // IT RUNS: patching first would leave a window where that resume
    // reads the still-"waiting" row before this reaches
    // `ctx.scheduler.cancel`, and proceeds regardless. Cancelling first
    // closes that window — `ctx.scheduler.cancel` on a function that has
    // already started running is a documented no-op, so this ordering
    // never race-loses the other way.
    if (run.scheduledFnId) await ctx.scheduler.cancel(run.scheduledFnId);
    const now = Date.now();
    await ctx.db.patch(args.runId, {
      status: "cancelled",
      errorMessage: "cancelled from the dashboard",
      resumeAt: undefined,
      scheduledFnId: undefined,
      endedAt: now,
      updatedAt: now,
    });
    return null;
  },
});
