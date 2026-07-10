import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  buildStepsTree,
  seedsToTree,
  type BuilderStepInput,
  type StepRow,
} from "./lib/automations/stepsTree";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from "./lib/automations/validate";

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
// `src/app/api/automations/[id]/duplicate/route.ts`. All three source
// write routes gate on `requireRole('agent')` (the RLS
// `automations_insert`/`_update`/`_delete` policies the service-role
// client bypasses) — mirrored here as `ctx.requireRole("agent")` on
// every mutation. Reads (`list`/`get`/`logs`) have no role gate in the
// source beyond "is logged in", matching `accountQuery`'s default.
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

function toStepRow(row: Doc<"automationSteps">): StepRow {
  return {
    id: row._id,
    parentStepId: row.parentStepId,
    branch: row.branch,
    stepType: row.stepType,
    stepConfig: row.stepConfig,
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

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    const automations = await ctx.db
      .query("automations")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .collect();

    return await Promise.all(
      automations.map(async (automation) => {
        const steps = await ctx.db
          .query("automationSteps")
          .withIndex("by_automation", (q) => q.eq("automationId", automation._id))
          .collect();
        return { ...automation, stepCount: steps.length };
      }),
    );
  },
});

export const get = accountQuery({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
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
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");

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
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const { automationId, steps, ...rest } = args;
    const existing = await requireOwnAutomation(ctx, automationId);

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
        steps !== undefined
          ? normalizeStepsInput(steps as BuilderStepInput[])
          : buildStepsTree((await loadOrderedSteps(ctx, automationId)).map(toStepRow));
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
    }> = {};
    if (rest.name !== undefined) patch.name = rest.name;
    if (rest.description !== undefined) patch.description = rest.description;
    if (rest.triggerType !== undefined) patch.triggerType = rest.triggerType;
    if (rest.triggerConfig !== undefined) patch.triggerConfig = rest.triggerConfig;
    if (rest.isActive !== undefined) patch.isActive = rest.isActive;

    if (Object.keys(patch).length > 0) {
      patch.updatedAt = Date.now();
      await ctx.db.patch(automationId, patch);
    }

    if (steps !== undefined) {
      await replaceSteps(ctx, ctx.accountId, automationId, steps as BuilderStepInput[]);
    }

    return automationId;
  },
});

export const setActive = accountMutation({
  args: { automationId: v.id("automations"), isActive: v.boolean() },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
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
    return args.automationId;
  },
});

export const remove = accountMutation({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
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

    const logs = await ctx.db
      .query("automationLogs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .filter((q) => q.eq(q.field("automationId"), args.automationId))
      .collect();
    for (const log of logs) {
      await ctx.db.delete(log._id);
    }

    await ctx.db.delete(args.automationId);
  },
});

export const duplicate = accountMutation({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
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
    // without a bespoke id map.
    const rows = await loadOrderedSteps(ctx, args.automationId);
    if (rows.length > 0) {
      const tree = buildStepsTree(rows.map(toStepRow));
      await insertStepsTree(ctx, original.accountId, copyId, tree, undefined, undefined);
    }

    return copyId;
  },
});

export const logs = accountQuery({
  args: {
    automationId: v.optional(v.id("automations")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;
    const base = ctx.db
      .query("automationLogs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc");

    const rows =
      args.automationId !== undefined
        ? await base.filter((q) => q.eq(q.field("automationId"), args.automationId)).collect()
        : await base.collect();

    return rows.slice(0, limit);
  },
});
