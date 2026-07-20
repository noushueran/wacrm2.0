import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { validateFlowForActivation, type ValidationIssue } from "./lib/flows/validate";
import { clampLimit } from "./lib/cronSummary";
import { maskPhone } from "./lib/phone";
import { hasMinRole } from "./lib/roles";

// ============================================================
// Flows config CRUD — the account-scoped builder-facing counterpart to
// `flowsEngine.ts`'s runtime, mirroring `automations.ts`'s own shape
// (same `accountQuery`/`accountMutation` spine, same
// requireOwn*/ConvexError-code conventions). `ctx.accountId`/`ctx.userId`
// always come from the caller's own `memberships` row, never a
// client-supplied argument.
//
// Ported from `src/app/api/flows/route.ts` (list/create),
// `src/app/api/flows/[id]/route.ts` (get/update/remove),
// `src/app/api/flows/[id]/activate/route.ts` (activate),
// `src/app/api/flows/[id]/runs/route.ts` (runs), and
// `src/app/api/flows/templates/route.ts` (templates). All four source
// WRITE routes (POST /flows, PUT/DELETE/activate /flows/[id]) gate on
// `requireRole('agent')` — mirrored here as `ctx.requireRole("agent")`
// on every mutation. The source READ routes (GET list/[id]/runs/
// templates) have no role gate beyond "is logged in", matching
// `accountQuery`'s default (no `requireRole` call).
//
// Reuses the already-ported pure helper `convex/lib/flows/validate.ts`
// on `activate` (never reimplemented). `edges.ts`/`fallback.ts`/
// `layout.ts` are NOT imported here — nothing in this CRUD module
// needs canvas-edge derivation, fallback-policy resolution, or
// dagre auto-layout; those exist for the (not-yet-wired) canvas editor
// and the runtime engine (`flowsEngine.ts`) respectively.
//
// Deliberate deviation from a literal "activate({flowId, isActive})"
// reading: `flows.status` is a genuine three-state enum
// (draft/active/archived — see `schema.ts` and the source activate
// route's own `status?: 'draft' | 'active' | 'archived'` body), not a
// boolean column the way `automations.isActive` is. Collapsing it to a
// boolean would silently drop "archived" as a reachable state, so
// `activate` takes `status`, matching the source route and schema
// exactly.
//
// "Only one active flow" was checked against the source and does NOT
// exist: migration 010's `idx_flows_active_trigger` is a plain
// (non-unique) index purely for the runner's hot-path lookup, and
// `flowsEngine.ts`'s own `findEntryFlow`/`listActiveFlows` explicitly
// tolerate multiple simultaneously-active flows with overlapping
// triggers ("first-registered wins on trigger overlap"). No such
// constraint is invented here either — see the "no active-constraint"
// test in `flows.test.ts`. The only real "one active" invariant in
// this domain is per-(account,contact) on `flowRuns`, already enforced
// by `flowsEngine.insertFlowRun` — unrelated to this config CRUD.
// ============================================================

const nodeInputValidator = v.object({
  nodeKey: v.string(),
  nodeType: v.union(
    v.literal("start"),
    v.literal("send_buttons"),
    v.literal("send_list"),
    v.literal("send_message"),
    v.literal("send_media"),
    v.literal("collect_input"),
    v.literal("condition"),
    v.literal("set_tag"),
    v.literal("handoff"),
    v.literal("http_fetch"),
    v.literal("end"),
  ),
  config: v.optional(v.any()),
  positionX: v.optional(v.number()),
  positionY: v.optional(v.number()),
});

const triggerTypeValidator = v.union(
  v.literal("keyword"),
  v.literal("first_inbound_message"),
  v.literal("manual"),
);

const statusValidator = v.union(
  v.literal("draft"),
  v.literal("active"),
  v.literal("archived"),
);

// ============================================================
// Template catalog — spec-ported from `src/lib/flows/templates.ts`'s
// `TEMPLATES` registry, values copied verbatim. Outer node/flow FIELD
// NAMES are camelCased (`nodeKey`/`nodeType`, matching `flowNodes`'
// own document shape); the contents of every `config`/`triggerConfig`
// blob stay snake_case UNCHANGED (`next_node_key`, `reply_id`,
// `var_key`, `match_type`, ...) because those are the exact keys
// `flowsEngine.ts`'s node executors and pure helpers
// (`matchReplyId`/`matchesKeywordTrigger`/etc.) already read — only
// top-level Convex document field names get the camelCase treatment,
// never the contents of a `v.any()` JSON blob (see
// `convex/lib/flows/types.ts`'s own header comment on this same rule).
// ============================================================

interface FlowTemplateNode {
  nodeKey: string;
  nodeType: Doc<"flowNodes">["nodeType"];
  config: Record<string, unknown>;
}

interface FlowTemplate {
  name: string;
  description: string;
  icon: string;
  triggerType: "keyword" | "first_inbound_message" | "manual";
  triggerConfig: Record<string, unknown>;
  entryNodeId: string;
  nodes: FlowTemplateNode[];
}

const FLOW_TEMPLATES: Record<string, FlowTemplate> = {
  welcome_menu: {
    name: "Welcome menu",
    description:
      "Greet customers who type a keyword and route them to the right agent based on whether they're new or existing.",
    icon: "MessageSquare",
    triggerType: "keyword",
    triggerConfig: { keywords: ["support", "help", "hi"], match_type: "contains" },
    entryNodeId: "start",
    nodes: [
      { nodeKey: "start", nodeType: "start", config: { next_node_key: "welcome" } },
      {
        nodeKey: "welcome",
        nodeType: "send_buttons",
        config: {
          text: "Hi! 👋 Welcome to support. Are you an existing customer or new here?",
          footer_text: "Tap a button below to continue.",
          buttons: [
            { reply_id: "existing", title: "Existing customer", next_node_key: "existing_handoff" },
            { reply_id: "new", title: "New customer", next_node_key: "new_handoff" },
          ],
        },
      },
      {
        nodeKey: "existing_handoff",
        nodeType: "handoff",
        config: { note: "Existing customer needs assistance — please check account history before replying." },
      },
      {
        nodeKey: "new_handoff",
        nodeType: "handoff",
        config: { note: "New customer — share pricing + onboarding link." },
      },
    ],
  },
  faq_bot: {
    name: "FAQ bot",
    description:
      "Answer common questions automatically. Customer picks a topic from a list; the bot replies with the answer and ends.",
    icon: "HelpCircle",
    triggerType: "keyword",
    triggerConfig: { keywords: ["faq", "question", "info"], match_type: "contains" },
    entryNodeId: "start",
    nodes: [
      { nodeKey: "start", nodeType: "start", config: { next_node_key: "topics" } },
      {
        nodeKey: "topics",
        nodeType: "send_list",
        config: {
          text: "What can I help you with?",
          button_label: "View topics",
          sections: [
            {
              title: "Common questions",
              rows: [
                { reply_id: "hours", title: "Opening hours", next_node_key: "answer_hours" },
                { reply_id: "pricing", title: "Pricing", next_node_key: "answer_pricing" },
                { reply_id: "refunds", title: "Refund policy", next_node_key: "answer_refunds" },
              ],
            },
            {
              title: "Other",
              rows: [{ reply_id: "human", title: "Talk to a human", next_node_key: "human_handoff" }],
            },
          ],
        },
      },
      {
        nodeKey: "answer_hours",
        nodeType: "send_message",
        config: {
          text: "We're open Mon–Fri, 9am–6pm local time. Weekend support is limited to urgent issues.",
          next_node_key: "end",
        },
      },
      {
        nodeKey: "answer_pricing",
        nodeType: "send_message",
        config: {
          text: "Our pricing starts at $9/mo. Visit https://example.com/pricing for the full breakdown.",
          next_node_key: "end",
        },
      },
      {
        nodeKey: "answer_refunds",
        nodeType: "send_message",
        config: {
          text: "Refunds are honored within 30 days of purchase. Reply with your order number and we'll process it.",
          next_node_key: "end",
        },
      },
      {
        nodeKey: "human_handoff",
        nodeType: "handoff",
        config: { note: "Customer asked to talk to a human from the FAQ bot." },
      },
      { nodeKey: "end", nodeType: "end", config: {} },
    ],
  },
  lead_capture: {
    name: "Lead capture",
    description:
      "Greet first-time inbounds, capture name + email + company, then hand off to sales with the answers in the note.",
    icon: "UserPlus",
    triggerType: "first_inbound_message",
    triggerConfig: {},
    entryNodeId: "start",
    nodes: [
      { nodeKey: "start", nodeType: "start", config: { next_node_key: "intro" } },
      {
        nodeKey: "intro",
        nodeType: "send_message",
        config: {
          text: "Welcome! 👋 I'll ask a few quick questions so we can get you to the right person.",
          next_node_key: "ask_name",
        },
      },
      {
        nodeKey: "ask_name",
        nodeType: "collect_input",
        config: { prompt_text: "What's your name?", var_key: "name", next_node_key: "ask_email" },
      },
      {
        nodeKey: "ask_email",
        nodeType: "collect_input",
        config: {
          prompt_text: "Thanks {{vars.name}}! What's your work email?",
          var_key: "email",
          next_node_key: "ask_company",
        },
      },
      {
        nodeKey: "ask_company",
        nodeType: "collect_input",
        config: {
          prompt_text: "Almost done — what's your company name?",
          var_key: "company",
          next_node_key: "handoff",
        },
      },
      {
        nodeKey: "handoff",
        nodeType: "handoff",
        config: {
          note: "New lead — name={{vars.name}}, email={{vars.email}}, company={{vars.company}}.",
        },
      },
    ],
  },
};

/**
 * Loads a flow and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — same error for "doesn't exist" and "exists
 * but isn't yours" (mirrors `automations.ts`'s `requireOwnAutomation`),
 * so a cross-account probe can't distinguish the two.
 */
async function requireOwnFlow(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  flowId: Id<"flows">,
) {
  const flow = await ctx.db.get(flowId);
  if (!flow || flow.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "flow" });
  }
  return flow;
}

/** One flow's full node set. Same index + no extra sort as
 * `flowsEngine.listNodesForFlow` — order follows the `by_flow_node_key`
 * index (nodeKey-ascending), a cosmetic difference from the source's
 * `created_at asc` that has no functional effect (the engine keys
 * everything off `nodeKey` via a `Map`, never array position, and
 * neither does the validator). */
async function nodesForFlow(ctx: { db: QueryCtx["db"] }, flowId: Id<"flows">) {
  return await ctx.db
    .query("flowNodes")
    .withIndex("by_flow_node_key", (q) => q.eq("flowId", flowId))
    .collect();
}

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    // Admin+: `/flows` is absent from `SUPERVISOR_NAV`, so `canAccessNav`
    // already admits only admin/owner in the UI. `get`, `templates` and
    // `runs` share the floor so the list can't be walked around.
    ctx.requireRole("admin");
    const flows = await ctx.db
      .query("flows")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .collect();

    return await Promise.all(
      flows.map(async (flow) => {
        const nodes = await nodesForFlow(ctx, flow._id);
        return { ...flow, nodeCount: nodes.length, isActive: flow.status === "active" };
      }),
    );
  },
});

export const get = accountQuery({
  args: { flowId: v.id("flows") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin"); // same floor as `list`
    const flow = await requireOwnFlow(ctx, args.flowId);
    const nodes = await nodesForFlow(ctx, args.flowId);
    return { flow, nodes };
  },
});

export const create = accountMutation({
  args: {
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    triggerType: v.optional(triggerTypeValidator),
    triggerConfig: v.optional(v.any()),
    template: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");

    // -------- Template clone path --------
    if (args.template) {
      const tpl = FLOW_TEMPLATES[args.template];
      if (!tpl) {
        throw new ConvexError({
          code: "INVALID_INPUT",
          message: `Unknown template "${args.template}"`,
        });
      }

      const flowId = await ctx.db.insert("flows", {
        accountId: ctx.accountId,
        createdByUserId: ctx.userId,
        // Body `name` overrides the template default when given — a
        // blank/whitespace-only override falls back to the template's
        // own name, matching the source's `body.name?.trim() ||
        // template.name`. Nothing else (description/trigger/entry) is
        // overridable on this path, matching the source exactly.
        name: args.name?.trim() || tpl.name,
        description: tpl.description,
        status: "draft",
        triggerType: tpl.triggerType,
        triggerConfig: tpl.triggerConfig,
        entryNodeId: tpl.entryNodeId,
        executionCount: 0,
      });

      // Convex mutations are one transaction — unlike the source's
      // two-step insert-then-rollback-on-error, a failed node insert
      // here aborts the WHOLE mutation atomically, so there is no
      // manual "delete the half-cloned flow" step to port.
      for (const n of tpl.nodes) {
        await ctx.db.insert("flowNodes", {
          accountId: ctx.accountId,
          flowId,
          nodeKey: n.nodeKey,
          nodeType: n.nodeType,
          config: n.config,
          positionX: 0,
          positionY: 0,
        });
      }
      return flowId;
    }

    // -------- Plain (empty) create path --------
    if (!args.name?.trim()) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "name is required" });
    }

    return await ctx.db.insert("flows", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      name: args.name.trim(),
      description: args.description,
      status: "draft",
      triggerType: args.triggerType ?? "keyword",
      triggerConfig: args.triggerConfig ?? {},
      executionCount: 0,
    });
  },
});

export const update = accountMutation({
  args: {
    flowId: v.id("flows"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    triggerType: v.optional(triggerTypeValidator),
    triggerConfig: v.optional(v.any()),
    entryNodeId: v.optional(v.string()),
    fallbackPolicy: v.optional(v.any()),
    nodes: v.optional(v.array(nodeInputValidator)),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const { flowId, nodes, ...rest } = args;
    await requireOwnFlow(ctx, flowId);

    if (rest.name !== undefined && !rest.name.trim()) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "name cannot be empty" });
    }

    // The source PUT ALWAYS writes `updated_at` (it builds `flowPatch =
    // { updated_at: ... }` unconditionally, then layers in whichever
    // fields the body supplied) — unlike `automations.update`'s
    // conditional PATCH, which skips the whole `automations` write when
    // no scalar field changed. Preserved here: `updatedAt` is stamped
    // even on a nodes-only / header-only save.
    const patch: Partial<{
      name: string;
      description: string;
      triggerType: "keyword" | "first_inbound_message" | "manual";
      triggerConfig: unknown;
      entryNodeId: string;
      fallbackPolicy: unknown;
      updatedAt: number;
    }> = { updatedAt: Date.now() };
    if (rest.name !== undefined) patch.name = rest.name.trim();
    if (rest.description !== undefined) patch.description = rest.description;
    if (rest.triggerType !== undefined) patch.triggerType = rest.triggerType;
    if (rest.triggerConfig !== undefined) patch.triggerConfig = rest.triggerConfig;
    if (rest.entryNodeId !== undefined) patch.entryNodeId = rest.entryNodeId;
    if (rest.fallbackPolicy !== undefined) patch.fallbackPolicy = rest.fallbackPolicy;
    await ctx.db.patch(flowId, patch);

    if (nodes !== undefined) {
      // Delete-then-insert, matching the source PUT's own node-replace
      // semantics exactly ("Not transactional but the runner handles
      // mid-edit reads safely"). Caller-supplied `nodeKey` strings are
      // reused verbatim — never server-regenerated — which is what
      // preserves any in-flight `flowRuns.currentNodeKey`/
      // `flows.entryNodeId` reference across a save: those only ever
      // store the stable nodeKey STRING, never a flowNodes row id, so
      // a run parked on nodeKey "next" still resolves correctly against
      // the brand-new row inserted here as long as the editor keeps
      // sending back the same "next" key for that node.
      const existing = await nodesForFlow(ctx, flowId);
      for (const row of existing) {
        await ctx.db.delete(row._id);
      }
      for (const n of nodes) {
        await ctx.db.insert("flowNodes", {
          accountId: ctx.accountId,
          flowId,
          nodeKey: n.nodeKey,
          nodeType: n.nodeType,
          config: n.config ?? {},
          positionX: n.positionX ?? 0,
          positionY: n.positionY ?? 0,
        });
      }
    }

    // Re-fetch and return the new state — mirrors the source PUT's own
    // "the editor uses the response to reconcile its local form state",
    // and matches `get`'s own `{flow, nodes}` shape for symmetry.
    const flow = await ctx.db.get(flowId);
    const freshNodes = await nodesForFlow(ctx, flowId);
    return { flow, nodes: freshNodes };
  },
});

export const remove = accountMutation({
  args: { flowId: v.id("flows") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnFlow(ctx, args.flowId);

    // Explicit cascade — Convex has no ON DELETE. Postgres declared
    // `flow_nodes.flow_id`/`flow_runs.flow_id` both `REFERENCES
    // flows(id) ON DELETE CASCADE`, and `flow_run_events.flow_run_id
    // REFERENCES flow_runs(id) ON DELETE CASCADE` in turn (migration
    // 010) — so deleting a flow cascades through all three tables, not
    // just the two named in this task's own brief. Ported in full here.
    const nodes = await nodesForFlow(ctx, args.flowId);
    for (const node of nodes) {
      await ctx.db.delete(node._id);
    }

    const runs = await ctx.db
      .query("flowRuns")
      .withIndex("by_flow", (q) => q.eq("flowId", args.flowId))
      .collect();
    for (const run of runs) {
      const events = await ctx.db
        .query("flowRunEvents")
        .withIndex("by_run", (q) => q.eq("flowRunId", run._id))
        .collect();
      for (const event of events) {
        await ctx.db.delete(event._id);
      }
      await ctx.db.delete(run._id);
    }

    await ctx.db.delete(args.flowId);
  },
});

export const activate = accountMutation({
  args: { flowId: v.id("flows"), status: statusValidator },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const flow = await requireOwnFlow(ctx, args.flowId);

    // Activating runs the full validator and refuses on any 'error'
    // severity issue (reusing `convex/lib/flows/validate.ts` verbatim —
    // never reimplemented). Drafts and archives are unconditional: users
    // need to be able to save broken work-in-progress and pause flows
    // without first fixing them (matches the source route's own
    // comment). No "only one active flow" gate exists to port — see
    // this file's header comment.
    if (args.status === "active") {
      const nodes = await nodesForFlow(ctx, args.flowId);
      const issues: ValidationIssue[] = validateFlowForActivation(
        {
          name: flow.name,
          trigger_type: flow.triggerType,
          trigger_config: (flow.triggerConfig ?? {}) as Record<string, unknown>,
          entry_node_id: flow.entryNodeId ?? null,
        },
        nodes.map((n) => ({
          node_key: n.nodeKey,
          node_type: n.nodeType,
          config: (n.config ?? {}) as Record<string, unknown>,
        })),
      );
      const blockers = issues.filter((i) => i.severity === "error");
      if (blockers.length > 0) {
        throw new ConvexError({
          code: "VALIDATION_FAILED",
          message: "Cannot activate flow — fix the issues below first.",
          // Spread each issue into a fresh object literal: `ConvexError`'s
          // data must structurally satisfy Convex's `Value` type (which
          // requires an index signature), and a plain `ValidationIssue[]`
          // (an `interface`, not a type alias) doesn't get that bypass —
          // spreading strips the nominal interface type without changing
          // the actual shape/content of each issue.
          issues: issues.map((issue) => ({ ...issue })),
        });
      }
    }

    await ctx.db.patch(args.flowId, { status: args.status, updatedAt: Date.now() });
    return await ctx.db.get(args.flowId);
  },
});

export const runs = accountQuery({
  args: { flowId: v.id("flows"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const flow = await requireOwnFlow(ctx, args.flowId);
    // Clamp the caller-supplied limit: a negative throws in `.take()` and a
    // huge value makes it an unbounded read.
    const limit = clampLimit(args.limit, 50, 200);

    const runRows = await ctx.db
      .query("flowRuns")
      .withIndex("by_flow", (q) => q.eq("flowId", args.flowId))
      .order("desc")
      .take(limit);

    // Embed a lightweight contact snapshot per run — same
    // "fetch-once-then-Promise.all" embedding style as
    // `deals.ts`'s own stage embedding.
    //
    // The phone is masked below supervisor, matching the policy
    // `lib/roles.ts`'s `canSeeContactPhone` states and that
    // `contacts.ts`/`conversations.ts` already enforce. A flow run has no
    // "assigned to caller" notion for the agent half of that rule, so
    // supervisor is the floor. Read access itself stays where the module
    // header puts it — this closes the PII leak without changing who may
    // open a flow's run history.
    const canSeePhone = hasMinRole(ctx.role, "supervisor");
    const runsWithContact = await Promise.all(
      runRows.map(async (run) => {
        const contact = run.contactId ? await ctx.db.get(run.contactId) : null;
        return {
          ...run,
          contact: contact
            ? {
                _id: contact._id,
                name: contact.name,
                phone: canSeePhone ? contact.phone : maskPhone(contact.phone),
              }
            : null,
        };
      }),
    );

    // Flattened event timeline across all matched runs, oldest-first —
    // mirrors the source's single `.in('flow_run_id', runIds).order
    // ('created_at', ascending: true)` query, done here as one
    // per-run fetch (each already ascending internally via `by_run`)
    // plus a final merge-sort by creation time.
    const eventLists = await Promise.all(
      runRows.map((run) =>
        ctx.db
          .query("flowRunEvents")
          .withIndex("by_run", (q) => q.eq("flowRunId", run._id))
          .collect(),
      ),
    );
    const events = eventLists.flat().sort((a, b) => a._creationTime - b._creationTime);

    return { flow, runs: runsWithContact, events };
  },
});

export const templates = accountQuery({
  args: {},
  // `ctx` is unused for data — the catalogue is a module constant — but is
  // taken so the admin floor can be enforced, matching `list`/`get`. Its
  // only caller is the flow-builder template picker on the admin-only
  // `/flows` page.
  handler: async (ctx) => {
    ctx.requireRole("admin");
    return Object.entries(FLOW_TEMPLATES).map(([slug, tpl]) => ({
      slug,
      name: tpl.name,
      description: tpl.description,
      icon: tpl.icon,
      triggerType: tpl.triggerType,
      nodeCount: tpl.nodes.length,
    }));
  },
});
