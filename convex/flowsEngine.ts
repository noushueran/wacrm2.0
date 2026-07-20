import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { decideFallback, resolveFallbackPolicy } from "./lib/flows/fallback";
import { chargeLeadIfAgent } from "./lib/leadCharge";
import { r2ConfigFromEnv } from "./lib/r2/config";
import { resolveMediaUrlLazy } from "./lib/r2/url";
import { parseMediaKey } from "./lib/r2/keys";
import type {
  CollectInputNodeConfig,
  ConditionNodeConfig,
  HandoffNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMediaNodeConfig,
  SendMessageNodeConfig,
  SetTagNodeConfig,
  StartNodeConfig,
} from "./lib/flows/types";
import type { InteractiveMessagePayload } from "./lib/whatsapp/interactive";

// ============================================================
// Flows engine (Phase 6, Task 4) — Convex port of
// `src/lib/flows/engine.ts` (`dispatchInboundToFlows`,
// `loadActiveRunForContact`, `findEntryFlow`, `startNewRun`,
// `handleReplyForActiveRun`/`advanceFromNodeKey`, the node executors
// for `start`/`send_message`/`send_buttons`/`send_list`/`send_media`/
// `collect_input`/`condition`/`set_tag`/`handoff`/`end`) and the cron
// sweep it fed, `src/app/api/flows/cron/route.ts`.
//
// Structural sibling of `automationsEngine.ts` (Task 3) — same shape:
// two `internalAction` entry points (`dispatchInbound`, `timeout`),
// every DB read/write behind a small `internalQuery`/`internalMutation`
// (actions cannot touch `ctx.db` directly), and the actual node-walk
// (`advanceFromNodeKey`, mirroring the original's own function of the
// same name) is a plain TypeScript function, not a separate Convex
// function.
//
// THE key structural difference from automations: automations only
// ever suspend on `wait` (a timer); flows ALSO suspend on
// `collect_input`/`send_buttons`/`send_list` (waiting on the CUSTOMER's
// next reply, not a clock) — so a flow run needs a dedicated "is there
// already an active run for this contact, and does this inbound
// message advance it?" dispatch path with no automations analogue.
// The fallback TIMEOUT is still scheduler-based like automations' own
// `wait`, but with one addition automations didn't need: a flow run's
// timeout must be CANCELLED and RESCHEDULED every time the customer
// genuinely advances the run (otherwise a fast reply would still get
// timed out later by the original schedule) — so `flowRuns` grows a
// `fallbackTimeoutId` field (see `schema.ts`) to remember what to
// cancel. Automations never re-schedule an in-flight `wait` this way
// (nothing can "advance" a parked wait early), so it never needed the
// equivalent field.
//
// `accountId`/`contactId` are always explicit, caller-supplied
// arguments (never `ctx.accountId`) — there is no user session inside
// a webhook-triggered dispatch, exactly like `ingest.ts`/`metaSend.ts`/
// `automationsEngine.ts` before it.
//
// Deliberate deviations from a literal reading of this task's brief,
// explained in full where they matter below:
//   1. `dispatchInbound` is an `internalAction` (the brief's own
//      planning doc, `.superpowers/sdd/p6-task-4-brief.md`, says
//      `internalMutation`; the task instructions that superseded it —
//      "study automationsEngine.ts as the sibling pattern... internal-
//      action + scheduler structure" — require it: the dispatcher must
//      call Meta-send actions (`ctx.runAction`) and schedule/cancel the
//      fallback timeout (`ctx.scheduler`), neither of which a plain
//      mutation can do while also sending).
//   2. `send_buttons`/`send_list` are wrapped in a try/catch that ends
//      the run as `failed` on a Meta-send exception. The ORIGINAL
//      `engine.ts` does NOT wrap these two node types (unlike
//      `send_message`/`send_media`/`collect_input`, which all do) — a
//      thrown Meta error there propagates all the way to the outer
//      `dispatchInboundToFlows` catch, which only logs and returns
//      `no_match`, silently leaving the run stuck `active` forever with
//      a stale `current_node_key`. Nothing in the original's own
//      comments explains this asymmetry; it reads as an oversight, not
//      a deliberate design choice, so this port closes it (same spirit
//      as `automationsEngine.ts`'s own documented "stricter than the
//      original" deviations).
//   3. A genuine TIMEOUT (no reply at all) applies the same
//      `decideFallback` ported policy function that an unmatched REPLY
//      uses, incrementing the same `repromptCount` ladder — the
//      ORIGINAL cron sweep (`/api/flows/cron`) never did this; it just
//      unconditionally marked a stale run `timed_out`. The brief calls
//      for `decideFallback` explicitly ("apply decideFallback (ported)
//      — end or reprompt"), which unifies "customer went quiet" and
//      "customer replied with something we don't understand" under one
//      escalation ladder instead of two independent mechanisms. Within
//      that reuse, `on_unknown_reply: 'ignore'`'s "ignore" verdict is
//      reinterpreted as "reprompt" for a timeout specifically — there
//      is no inbound message to hand to automations the way a live
//      "ignore" verdict hands one off, so silently doing nothing would
//      strand the run with no timeout ever scheduled again.
// ============================================================

// ------------------------------------------------------------
// Types — mirrors `src/lib/flows/types.ts`'s `ParsedInbound` /
// `DispatchInboundResult`, camelCased for the field names (string
// VALUES — status/outcome/endReason literals — stay snake_case,
// matching this codebase's own established convention of porting
// enum-like VALUES byte-for-byte while camelCasing field NAMES; see
// `schema.ts`'s own `flowRuns.status`/`flows.triggerType` literals).
// ------------------------------------------------------------

type ParsedInbound =
  | { kind: "text"; text: string; metaMessageId: string }
  | { kind: "interactive_reply"; replyId: string; replyTitle: string; metaMessageId: string };

export interface DispatchInboundResult {
  consumed: boolean;
  flowRunId?: Id<"flowRuns">;
  outcome?:
    | "advanced"
    | "started"
    | "completed"
    | "handed_off"
    | "fallback_fired"
    | "duplicate_inbound_ignored"
    | "no_match";
}

const messageValidator = v.union(
  v.object({
    kind: v.literal("text"),
    text: v.string(),
    metaMessageId: v.string(),
  }),
  v.object({
    kind: v.literal("interactive_reply"),
    replyId: v.string(),
    replyTitle: v.string(),
    metaMessageId: v.string(),
  }),
);

// ============================================================
// Pure helpers — byte-faithful ports of `src/lib/flows/engine.ts`'s
// own exported pure functions (extracted there "so engine.test.ts can
// exercise them without a Supabase / Meta mock"; here, so
// `flowsEngine.test.ts` can do the same without a `convexTest`
// instance). Signatures — including the snake_case `node_type`/
// `reply_id` parameter shape — are kept EXACTLY as the original, not
// camelCased, on purpose: this is what "byte-faithful port (tests
// pass)" means per the Phase 6 plan's own Self-Review checklist. The
// call sites below that feed these from a real `Doc<"flowNodes">`
// (camelCase `nodeType`) adapt at the boundary instead.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key to
 * advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Pure — the engine wraps it with a DB lookup for `tag` /
 * `contact_field` subjects (`resolveConditionSubject` below).
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  subjectValue: string | undefined;
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

/**
 * Tiny `{{vars.foo}}` interpolation — ported verbatim. Missing vars
 * render as empty string, matching the automations engine's own
 * `interpolate` behavior for its `{{vars.*}}` namespace.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const val = vars[key];
    return val === undefined || val === null ? "" : String(val);
  });
}

// ============================================================
// Public entry points
// ============================================================

/**
 * The single entry point the (not-yet-built) webhook fan-out calls on
 * every inbound message for an account that has flows enabled. Loads
 * the contact's active run (if any) and advances it; otherwise looks
 * for a flow whose entry trigger matches and starts a new run. Mirrors
 * `dispatchInboundToFlows`'s own top-level try/catch: unexpected
 * errors are logged and swallowed into `{ consumed: false, outcome:
 * "no_match" }` rather than thrown, since every EXPECTED failure mode
 * (a Meta send failing, a bad node graph, a condition eval error) is
 * already handled inline by `advanceFromNodeKey`/
 * `handleReplyForActiveRun`, which end the run cleanly and return a
 * normal result instead of throwing.
 */
export const dispatchInbound = internalAction({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    message: messageValidator,
    isFirstInboundMessage: v.boolean(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<DispatchInboundResult> => {
    let result: DispatchInboundResult;
    try {
      result = await dispatchInboundInner(ctx, args.accountId, args.contactId, args.message, args.isFirstInboundMessage);
    } catch (err) {
      console.error(
        "[flows] dispatchInbound threw:",
        err instanceof Error ? err.message : err,
      );
      return { consumed: false, outcome: "no_match" };
    }

    // Fallback-timeout (re)scheduling — see this file's header comment.
    // Kept OUTSIDE the try/catch above so a scheduling hiccup can never
    // clobber an already-successful dispatch result; failing to
    // reschedule just means this run risks never timing out, the same
    // failure mode the original's cron sweep had if it ever stopped
    // running — not a new risk this port introduces.
    try {
      if (
        result.flowRunId &&
        (result.outcome === "advanced" ||
          result.outcome === "started" ||
          result.outcome === "fallback_fired")
      ) {
        await maybeRescheduleFallback(ctx, result.flowRunId);
      }
    } catch (err) {
      console.error(
        "[flows] fallback-timeout reschedule failed:",
        err instanceof Error ? err.message : err,
      );
    }
    return result;
  },
});

async function dispatchInboundInner(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  contactId: Id<"contacts">,
  message: ParsedInbound,
  isFirstInboundMessage: boolean,
): Promise<DispatchInboundResult> {
  const activeRun = await ctx.runQuery(internal.flowsEngine.loadActiveRunForContact, {
    accountId,
    contactId,
  });

  if (activeRun) {
    const dupe: boolean = await ctx.runQuery(internal.flowsEngine.isDuplicateInbound, {
      flowRunId: activeRun._id,
      metaMessageId: message.metaMessageId,
    });
    if (dupe) {
      return { consumed: true, flowRunId: activeRun._id, outcome: "duplicate_inbound_ignored" };
    }
    const nodes = await loadNodeMap(ctx, activeRun.flowId);
    return await handleReplyForActiveRun(ctx, activeRun, message, nodes);
  }

  const flow = await findEntryFlow(ctx, accountId, message, isFirstInboundMessage);
  if (!flow || !flow.entryNodeId) {
    return { consumed: false, outcome: "no_match" };
  }
  const nodes = await loadNodeMap(ctx, flow._id);
  return await startNewRun(ctx, flow, { accountId, contactId, message }, nodes);
}

/**
 * Resume a run parked at a suspending node whose fallback timeout just
 * elapsed with no reply. See this file's header comment #3 for why
 * this reuses `decideFallback` (the same policy an unmatched LIVE
 * reply applies) rather than the original cron sweep's unconditional
 * `timed_out`.
 */
export const timeout = internalAction({
  args: { flowRunId: v.id("flowRuns") },
  handler: async (ctx, args): Promise<void> => {
    const run = await ctx.runQuery(internal.flowsEngine.getRun, { flowRunId: args.flowRunId });
    // Stale callback — the run already advanced/ended since this was
    // scheduled (should be rare: every genuine advance cancels the
    // previous scheduled timeout — see `rescheduleFallbackTimeout` —
    // but a cancel can race a fire, so this guard stays defensive).
    if (!run || run.status !== "active") return;

    // This invocation IS the scheduled function `run.fallbackTimeoutId`
    // points at — it has already fired (we're running inside it right
    // now), so clear that bookkeeping field immediately. Without this,
    // `endRunMutation`/`executeHandoffMutation` below (or the
    // "reprompt" reschedule further down) would each try to
    // `ctx.scheduler.cancel` this SAME in-flight invocation: Convex
    // documents that as "any new functions it tries to schedule will be
    // canceled" for the remainder of this run, which would silently
    // poison the very reschedule the "reprompt" branch needs to make,
    // and the `convex-test` harness raises it as a hard invariant error.
    await ctx.runMutation(internal.flowsEngine.clearFallbackTimeoutId, { flowRunId: run._id });

    if (!run.currentNodeKey) {
      await endRun(ctx, run._id, "failed", "active_run_missing_current_node");
      return;
    }
    const nodes = await loadNodeMap(ctx, run.flowId);
    const currentNode = nodes.get(run.currentNodeKey) ?? null;
    if (!currentNode) {
      await endRun(ctx, run._id, "failed", "current_node_not_found");
      return;
    }

    const flow = await ctx.runQuery(internal.flowsEngine.getFlow, { flowId: run.flowId });
    const policy = resolveFallbackPolicy(flow?.fallbackPolicy);
    const newRepromptCount = run.repromptCount + 1;
    await ctx.runMutation(internal.flowsEngine.setRepromptCount, {
      flowRunId: run._id,
      repromptCount: newRepromptCount,
    });

    const action = decideFallback({ policy, reprompt_count: newRepromptCount });
    await insertEvent(ctx, run, "timeout", run.currentNodeKey, {
      action: action.type,
      repromptCount: newRepromptCount,
    });

    if (action.type === "handoff") {
      await handoffAndEndRun(ctx, run, { note: "fallback_exhausted_timeout", nodeKey: run.currentNodeKey });
      return;
    }
    if (action.type === "end") {
      await endRun(ctx, run._id, "completed", "fallback_exhausted_end");
      return;
    }
    // "reprompt" or "ignore" — see header comment #3 for why "ignore"
    // is folded into "reprompt" here: a genuine timeout has no inbound
    // message for automations to pick up instead, so doing nothing
    // would leave the run active with no timeout ever scheduled again.
    await resendPrompt(ctx, run, currentNode);
    // `previousTimeoutId` is `undefined` here, not `run.fallbackTimeoutId`
    // — that field was already cleared above (it was THIS invocation's
    // own id; see this handler's opening comment for why cancelling it
    // again would be a self-cancel).
    await rescheduleFallbackTimeout(ctx, run._id, undefined, policy.on_timeout_hours);
  },
});

// ============================================================
// Dispatch-level plain functions — mirror `engine.ts`'s own
// `findEntryFlow` / `startNewRun` / `handleReplyForActiveRun` /
// `advanceFromNodeKey` 1:1, just calling `ctx.runQuery`/
// `ctx.runMutation`/`ctx.runAction`/`ctx.scheduler` instead of a
// Supabase client.
// ============================================================

async function loadNodeMap(
  ctx: ActionCtx,
  flowId: Id<"flows">,
): Promise<Map<string, Doc<"flowNodes">>> {
  const list: Doc<"flowNodes">[] = await ctx.runQuery(internal.flowsEngine.listNodesForFlow, { flowId });
  return new Map(list.map((n) => [n.nodeKey, n]));
}

/**
 * Only text messages can match an entry trigger — interactive replies
 * are responses to existing prompts and never start a new flow.
 */
async function findEntryFlow(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<Doc<"flows"> | null> {
  if (message.kind !== "text") return null;

  const flows: Doc<"flows">[] = await ctx.runQuery(internal.flowsEngine.listActiveFlows, { accountId });
  for (const flow of flows) {
    if (flow.triggerType === "keyword") {
      if (matchesKeywordTrigger(message.text, (flow.triggerConfig ?? {}) as KeywordTriggerConfig)) {
        return flow;
      }
    } else if (flow.triggerType === "first_inbound_message" && isFirstInbound) {
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

async function startNewRun(
  ctx: ActionCtx,
  flow: Doc<"flows">,
  input: { accountId: Id<"accounts">; contactId: Id<"contacts">; message: ParsedInbound },
  nodes: Map<string, Doc<"flowNodes">>,
): Promise<DispatchInboundResult> {
  const target = await ctx.runQuery(internal.flowsEngine.resolveDispatchTarget, {
    accountId: input.accountId,
    contactId: input.contactId,
  });
  if (!target) {
    return { consumed: false, outcome: "no_match" };
  }

  // `insertFlowRun` re-checks "one active run per (account, contact)"
  // itself, atomically, inside its own transaction — the Convex
  // counterpart to the original's partial-unique-index-plus-23505-catch
  // (see that mutation's own comment).
  const runId: Id<"flowRuns"> | null = await ctx.runMutation(internal.flowsEngine.insertFlowRun, {
    accountId: flow.accountId,
    createdByUserId: flow.createdByUserId,
    flowId: flow._id,
    contactId: input.contactId,
    conversationId: target.conversationId,
    entryNodeKey: flow.entryNodeId!,
  });
  if (!runId) {
    return { consumed: true, outcome: "duplicate_inbound_ignored" };
  }

  const run = await ctx.runQuery(internal.flowsEngine.getRun, { flowRunId: runId });
  if (!run) {
    return { consumed: true, flowRunId: runId, outcome: "no_match" };
  }

  await insertEvent(ctx, run, "started", flow.entryNodeId ?? undefined, {
    flowId: flow._id,
    triggerType: flow.triggerType,
    metaMessageId: input.message.metaMessageId,
  });

  // Atomic +1 — mirrors `increment_flow_execution_count` (migration
  // 012)/`automationsEngine.ts`'s own `bumpExecutionCount`.
  await ctx.runMutation(internal.flowsEngine.bumpFlowExecutionCount, { flowId: flow._id });

  const outcome = await advanceFromNodeKey(ctx, run, flow.entryNodeId!, nodes);
  return {
    consumed: true,
    flowRunId: run._id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}

async function handleReplyForActiveRun(
  ctx: ActionCtx,
  run: Doc<"flowRuns">,
  message: ParsedInbound,
  nodes: Map<string, Doc<"flowNodes">>,
): Promise<DispatchInboundResult> {
  // Note: intentionally does NOT persist the raw customer text in the
  // event payload — see `engine.ts`'s own comment on why (a
  // `collect_input` prompt asking for a card number would otherwise
  // leave the PAN sitting in the audit trail forever). Length only.
  await insertEvent(ctx, run, "reply_received", run.currentNodeKey ?? undefined, {
    metaMessageId: message.metaMessageId,
    replyKind: message.kind,
    replyId: message.kind === "interactive_reply" ? message.replyId : null,
    textLength: message.kind === "text" ? message.text.length : null,
  });

  if (!run.currentNodeKey) {
    await endRun(ctx, run._id, "failed", "active_run_missing_current_node");
    return { consumed: true, flowRunId: run._id, outcome: "no_match" };
  }

  const currentNode = nodes.get(run.currentNodeKey) ?? null;
  if (!currentNode) {
    await endRun(ctx, run._id, "failed", "current_node_not_found");
    return { consumed: true, flowRunId: run._id, outcome: "no_match" };
  }

  // Two ways a reply can advance: an interactive button/list tap on a
  // send_buttons/send_list node, or a text reply on a collect_input
  // node (captured into vars). Everything else falls through to the
  // fallback policy below.
  let matched: string | null = null;

  if (
    message.kind === "interactive_reply" &&
    (currentNode.nodeType === "send_buttons" || currentNode.nodeType === "send_list")
  ) {
    matched = matchReplyId(
      { node_type: currentNode.nodeType, config: (currentNode.config ?? {}) as Record<string, unknown> },
      message.replyId,
    );
  } else if (message.kind === "text" && currentNode.nodeType === "collect_input") {
    const cfg = (currentNode.config ?? {}) as CollectInputNodeConfig;
    const captured = message.text.trim();
    if (captured.length > 0 && cfg.var_key) {
      // Persist captured value + reset reprompt count atomically.
      await ctx.runMutation(internal.flowsEngine.captureVar, {
        flowRunId: run._id,
        varKey: cfg.var_key,
        value: captured,
      });
      await insertEvent(ctx, run, "node_entered", currentNode.nodeKey, {
        capturedKey: cfg.var_key,
        capturedLength: captured.length,
      });
      matched = cfg.next_node_key;
    }
  }

  if (matched) {
    if (run.repromptCount !== 0) {
      await ctx.runMutation(internal.flowsEngine.setRepromptCount, { flowRunId: run._id, repromptCount: 0 });
    }
    // Re-read: the capture/reprompt-reset mutations above may have
    // changed `vars`/`repromptCount` since `run` was loaded at the top
    // of `dispatchInbound` — the advance loop below needs the freshest
    // copy for correct `{{vars.*}}` interpolation.
    const freshRun = (await ctx.runQuery(internal.flowsEngine.getRun, { flowRunId: run._id })) ?? run;
    const outcome = await advanceFromNodeKey(ctx, freshRun, matched, nodes);
    return { consumed: true, flowRunId: run._id, outcome: outcome.outcome };
  }

  // No match → fallback. Apply the policy.
  const flow = await ctx.runQuery(internal.flowsEngine.getFlow, { flowId: run.flowId });
  const policy = resolveFallbackPolicy(flow?.fallbackPolicy);
  const newReprompts = run.repromptCount + 1;
  await ctx.runMutation(internal.flowsEngine.setRepromptCount, { flowRunId: run._id, repromptCount: newReprompts });

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await insertEvent(ctx, run, "fallback_fired", run.currentNodeKey, {
    action: action.type,
    repromptCount: newReprompts,
  });

  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flowRunId: run._id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    await resendPrompt(ctx, run, currentNode);
    return { consumed: true, flowRunId: run._id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    await handoffAndEndRun(ctx, run, { note: "fallback_exhausted", nodeKey: run.currentNodeKey });
    return { consumed: true, flowRunId: run._id, outcome: "handed_off" };
  }
  // action.type === "end"
  await endRun(ctx, run._id, "completed", "fallback_exhausted_end");
  return { consumed: true, flowRunId: run._id, outcome: "completed" };
}

/**
 * The synchronous advance loop. Walks through auto-advancing nodes
 * until it hits one that suspends (send_buttons/send_list/
 * collect_input) or terminates (handoff/end).
 */
async function advanceFromNodeKey(
  ctx: ActionCtx,
  run: Doc<"flowRuns">,
  startNodeKey: string,
  nodes: Map<string, Doc<"flowNodes">>,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  const to = await resolveContactPhone(ctx, run.accountId, run.contactId);
  let currentKey: string | null = startNodeKey;

  // Defensive cap — mirrors the original's own safety break in case a
  // flow has a cycle the (not-yet-built) validator should have caught.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logError(ctx, run, null, "next_node_key was null mid-advance");
      await endRun(ctx, run._id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: Doc<"flowNodes"> | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logError(ctx, run, currentKey, "node_not_found");
      await endRun(ctx, run._id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await insertEvent(ctx, run, "node_entered", node.nodeKey, { nodeType: node.nodeType });

    if (node.nodeType === "start") {
      currentKey = (node.config as StartNodeConfig | undefined)?.next_node_key ?? null;
      continue;
    }

    if (node.nodeType === "send_message") {
      const cfg = node.config as SendMessageNodeConfig;
      try {
        if (!to || !run.conversationId) throw new Error("no send target for this run");
        const { whatsappMessageId } = await ctx.runAction(internal.metaSend.sendText, {
          accountId: run.accountId,
          conversationId: run.conversationId,
          to,
          text: interpolateVars(cfg.text, run.vars ?? {}),
        });
        await insertEvent(ctx, run, "message_sent", node.nodeKey, { nodeType: "send_message", whatsappMessageId });
      } catch (err) {
        await logError(ctx, run, node.nodeKey, "send_text_failed", err);
        await endRun(ctx, run._id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }

    if (node.nodeType === "send_media") {
      const cfg = node.config as SendMediaNodeConfig;
      try {
        if (!to || !run.conversationId) throw new Error("no send target for this run");
        // A flow node's `media_key` is operator-authored (the flow
        // builder UI persists it into `flowNodes.config`), not
        // client-supplied at request time the way `send.ts`'s
        // `mediaKey` argument is — but the same class of cross-tenant
        // risk still applies: without this check, `resolveMediaUrlLazy`
        // below would happily resolve a key belonging to a DIFFERENT
        // account to a real, fetchable R2 URL, and that URL would then
        // be persisted onto THIS run's own message row via
        // `metaSend.sendMedia` (which persists `mediaUrl: args.link`
        // unconditionally). A foreign key is rejected here — landing in
        // the catch below exactly like any other send failure
        // (`send_media_failed`), never a raw throw out of the advance
        // loop — the same non-leaky treatment `send.ts`'s identical
        // check (and `files.ts`'s `remove`) already give this class of
        // key.
        if (
          cfg.media_key &&
          parseMediaKey(cfg.media_key)?.accountId !== run.accountId
        ) {
          throw new Error("media_key does not belong to this account");
        }
        // `resolveMediaUrlLazy` only builds the R2 config (which throws
        // when R2 env vars are unset) when `cfg.media_key` is actually
        // present, so an existing `media_url`-only node keeps working
        // unchanged on a deployment where R2 isn't configured yet — see
        // `convex/lib/r2/url.ts`'s doc comment on `resolveMediaUrlLazy`.
        // A thrown config error still lands in the catch below exactly
        // like any other send failure, which is the intended
        // best-effort behavior for a hot path this deep in an action.
        const link = resolveMediaUrlLazy(r2ConfigFromEnv, {
          key: cfg.media_key,
          url: cfg.media_url,
        });
        if (!link) {
          // Explicit, readable failure instead of letting `runAction`
          // reject on Convex's own (opaque) `link: v.string()` argument
          // validation — same "throw a clear message here rather than
          // downstream" rationale as `send.ts`'s media guard.
          throw new Error("no media_key or media_url on send_media node");
        }
        const { whatsappMessageId } = await ctx.runAction(internal.metaSend.sendMedia, {
          accountId: run.accountId,
          conversationId: run.conversationId,
          to,
          kind: cfg.media_type,
          link,
          // Threaded through (not just resolved into `link` above) so
          // the message row durably keeps the key — final-review fix:
          // previously `cfg.media_key` was resolved to `link` and then
          // discarded, so a flow's `send_media` node never persisted a
          // key. Safe to pass unconditionally: when present, it already
          // passed the ownership check above; when absent, this is a
          // no-op legacy `media_url` node.
          mediaKey: cfg.media_key,
          caption: cfg.caption ? interpolateVars(cfg.caption, run.vars ?? {}) : undefined,
          filename: cfg.filename,
        });
        await insertEvent(ctx, run, "message_sent", node.nodeKey, {
          nodeType: "send_media",
          mediaType: cfg.media_type,
          whatsappMessageId,
        });
      } catch (err) {
        await logError(ctx, run, node.nodeKey, "send_media_failed", err);
        await endRun(ctx, run._id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }

    if (node.nodeType === "collect_input") {
      // Send the prompt and suspend — the customer's next TEXT reply
      // wakes this run back up via `handleReplyForActiveRun`'s
      // collect_input branch above.
      const cfg = node.config as CollectInputNodeConfig;
      try {
        if (!to || !run.conversationId) throw new Error("no send target for this run");
        const { whatsappMessageId } = await ctx.runAction(internal.metaSend.sendText, {
          accountId: run.accountId,
          conversationId: run.conversationId,
          to,
          text: interpolateVars(cfg.prompt_text, run.vars ?? {}),
        });
        await insertEvent(ctx, run, "message_sent", node.nodeKey, { nodeType: "collect_input", whatsappMessageId });
        await persistLastPromptMessage(ctx, run, whatsappMessageId);
      } catch (err) {
        await logError(ctx, run, node.nodeKey, "collect_input_prompt_failed", err);
        await endRun(ctx, run._id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await ctx.runMutation(internal.flowsEngine.advanceCurrentNodeKey, {
        flowRunId: run._id,
        expectedOldKey: run.currentNodeKey ?? null,
        newKey: node.nodeKey,
      });
      if (!advanced) await logError(ctx, run, node.nodeKey, "lost_race_during_advance");
      return { outcome: "advanced" };
    }

    if (node.nodeType === "condition") {
      const cfg = node.config as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(ctx, run, cfg)) ? "true" : "false";
      } catch (err) {
        await logError(ctx, run, node.nodeKey, "condition_evaluation_failed", err);
        await endRun(ctx, run._id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey = branch === "true" ? cfg.true_next : cfg.false_next;
      await insertEvent(ctx, run, "node_entered", node.nodeKey, {
        conditionResult: branch,
        advancingTo: currentKey,
      });
      continue;
    }

    if (node.nodeType === "set_tag") {
      const cfg = node.config as SetTagNodeConfig;
      try {
        if (!run.contactId) throw new Error("set_tag needs a contact");
        await ctx.runMutation(internal.flowsEngine.applyTag, {
          accountId: run.accountId,
          contactId: run.contactId,
          tagId: cfg.tag_id as Id<"tags">,
          mode: cfg.mode,
        });
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow (matches the original exactly).
        await logError(ctx, run, node.nodeKey, "set_tag_failed", err);
      }
      currentKey = cfg.next_node_key;
      continue;
    }

    if (node.nodeType === "send_buttons") {
      try {
        if (!to || !run.conversationId) throw new Error("no send target for this run");
        await sendButtonsAndPersist(ctx, run, node, to);
      } catch (err) {
        // See header comment #2 — the original leaves this unguarded;
        // this port closes that gap so a Meta failure here ends the
        // run cleanly instead of stranding it `active` forever.
        await logError(ctx, run, node.nodeKey, "send_buttons_failed", err);
        await endRun(ctx, run._id, "failed", "send_buttons_failed");
        return { outcome: "completed" };
      }
      const advanced = await ctx.runMutation(internal.flowsEngine.advanceCurrentNodeKey, {
        flowRunId: run._id,
        expectedOldKey: run.currentNodeKey ?? null,
        newKey: node.nodeKey,
      });
      if (!advanced) await logError(ctx, run, node.nodeKey, "lost_race_during_advance");
      return { outcome: "advanced" };
    }

    if (node.nodeType === "send_list") {
      try {
        if (!to || !run.conversationId) throw new Error("no send target for this run");
        await sendListAndPersist(ctx, run, node, to);
      } catch (err) {
        await logError(ctx, run, node.nodeKey, "send_list_failed", err);
        await endRun(ctx, run._id, "failed", "send_list_failed");
        return { outcome: "completed" };
      }
      const advanced = await ctx.runMutation(internal.flowsEngine.advanceCurrentNodeKey, {
        flowRunId: run._id,
        expectedOldKey: run.currentNodeKey ?? null,
        newKey: node.nodeKey,
      });
      if (!advanced) await logError(ctx, run, node.nodeKey, "lost_race_during_advance");
      return { outcome: "advanced" };
    }

    if (node.nodeType === "handoff") {
      const cfg = node.config as HandoffNodeConfig;
      await handoffAndEndRun(ctx, run, { note: cfg.note, nodeKey: node.nodeKey, assignToUserId: cfg.assign_to });
      return { outcome: "handed_off" };
    }

    if (node.nodeType === "end") {
      await insertEvent(ctx, run, "completed", node.nodeKey);
      await endRun(ctx, run._id, "completed", "end_node");
      return { outcome: "completed" };
    }

    // Unknown node type — `http_fetch` is accepted by `schema.ts`'s
    // union (reserved for a future v2) but, like the original v1.5
    // engine, is not implemented here; falling through this far means
    // exactly that (or a genuinely corrupt node_type the — not yet
    // built — validator should have caught).
    await logError(ctx, run, node.nodeKey, `unknown_node_type:${node.nodeType}`);
    await endRun(ctx, run._id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }

  await logError(ctx, run, currentKey, "advance_loop_safety_break");
  await endRun(ctx, run._id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

// ------------------------------------------------------------
// Node-executor helpers
// ------------------------------------------------------------

async function resolveContactPhone(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  contactId: Id<"contacts"> | undefined,
): Promise<string | null> {
  if (!contactId) return null;
  return await ctx.runQuery(internal.flowsEngine.getContactPhone, { accountId, contactId });
}

async function persistLastPromptMessage(
  ctx: ActionCtx,
  run: Doc<"flowRuns">,
  whatsappMessageId: string,
): Promise<void> {
  const messageId: Id<"messages"> | null = await ctx.runQuery(internal.flowsEngine.findMessageIdByWamid, {
    wamid: whatsappMessageId,
  });
  if (messageId) {
    await ctx.runMutation(internal.flowsEngine.setLastPromptMessage, {
      flowRunId: run._id,
      lastPromptMessageId: messageId,
    });
  }
}

async function sendButtonsAndPersist(
  ctx: ActionCtx,
  run: Doc<"flowRuns">,
  node: Doc<"flowNodes">,
  to: string,
): Promise<void> {
  const cfg = node.config as SendButtonsNodeConfig;
  const payload: InteractiveMessagePayload = {
    kind: "buttons",
    body: cfg.text,
    header: cfg.header_text,
    footer: cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
  };
  const { whatsappMessageId } = await ctx.runAction(internal.metaSend.sendInteractive, {
    accountId: run.accountId,
    conversationId: run.conversationId!,
    to,
    payload,
  });
  await insertEvent(ctx, run, "message_sent", node.nodeKey, { nodeType: "send_buttons", whatsappMessageId });
  await persistLastPromptMessage(ctx, run, whatsappMessageId);
}

async function sendListAndPersist(
  ctx: ActionCtx,
  run: Doc<"flowRuns">,
  node: Doc<"flowNodes">,
  to: string,
): Promise<void> {
  const cfg = node.config as SendListNodeConfig;
  const payload: InteractiveMessagePayload = {
    kind: "list",
    body: cfg.text,
    header: cfg.header_text,
    footer: cfg.footer_text,
    button_label: cfg.button_label,
    sections: cfg.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({ id: r.reply_id, title: r.title, description: r.description })),
    })),
  };
  const { whatsappMessageId } = await ctx.runAction(internal.metaSend.sendInteractive, {
    accountId: run.accountId,
    conversationId: run.conversationId!,
    to,
    payload,
  });
  await insertEvent(ctx, run, "message_sent", node.nodeKey, { nodeType: "send_list", whatsappMessageId });
  await persistLastPromptMessage(ctx, run, whatsappMessageId);
}

/**
 * Re-send the current node's prompt without changing `currentNodeKey`
 * — used by both a live "reprompt" fallback verdict and a `timeout`
 * reprompt. Mirrors the original's own reprompt branch (which
 * re-invokes `sendButtonsAndSuspend`/`sendListAndSuspend`/a bare
 * `engineSendText` for collect_input) exactly, including that a send
 * failure here is logged but non-fatal — the run stays active and
 * simply waits for the next event (reply or timeout) rather than
 * failing outright, same as the source.
 */
async function resendPrompt(ctx: ActionCtx, run: Doc<"flowRuns">, node: Doc<"flowNodes">): Promise<void> {
  const to = await resolveContactPhone(ctx, run.accountId, run.contactId);
  if (!to || !run.conversationId) return;
  try {
    if (node.nodeType === "send_buttons") {
      await sendButtonsAndPersist(ctx, run, node, to);
    } else if (node.nodeType === "send_list") {
      await sendListAndPersist(ctx, run, node, to);
    } else if (node.nodeType === "collect_input") {
      const cfg = node.config as CollectInputNodeConfig;
      await ctx.runAction(internal.metaSend.sendText, {
        accountId: run.accountId,
        conversationId: run.conversationId,
        to,
        text: interpolateVars(cfg.prompt_text, run.vars ?? {}),
      });
    }
  } catch (err) {
    await logError(ctx, run, node.nodeKey, "reprompt_send_failed", err);
  }
}

async function handoffAndEndRun(
  ctx: ActionCtx,
  run: Doc<"flowRuns">,
  opts: { note?: string; nodeKey: string; assignToUserId?: string },
): Promise<void> {
  await ctx.runMutation(internal.flowsEngine.executeHandoffMutation, {
    accountId: run.accountId,
    flowRunId: run._id,
    conversationId: run.conversationId,
    assignToUserId: opts.assignToUserId,
    note: opts.note,
    nodeKey: opts.nodeKey,
  });
}

/**
 * Resolve a condition node's subject value, then delegate to the pure
 * `evaluateConditionPredicate`. `var` never touches the DB (it reads
 * straight off the in-memory `run.vars`); `tag`/`contact_field` go
 * through `resolveConditionSubject`.
 */
async function evaluateConditionNode(
  ctx: ActionCtx,
  run: Doc<"flowRuns">,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const raw = (run.vars ?? {})[cfg.subject_key];
    subjectValue = typeof raw === "string" ? raw : raw === undefined ? undefined : String(raw);
  } else {
    // Convex functions can't return a bare `undefined` over the
    // `ctx.runQuery` boundary (it serializes to `null`), so
    // `resolveConditionSubject` below returns `string | null` — convert
    // back to `undefined` here to match `evaluateConditionPredicate`'s
    // own "absent" sentinel.
    const resolved = await ctx.runQuery(internal.flowsEngine.resolveConditionSubject, {
      accountId: run.accountId,
      contactId: run.contactId,
      subject: cfg.subject,
      subjectKey: cfg.subject_key,
    });
    subjectValue = resolved ?? undefined;
  }
  return evaluateConditionPredicate({ operator: cfg.operator, subjectValue, configValue: cfg.value });
}

async function insertEvent(
  ctx: ActionCtx,
  run: Doc<"flowRuns">,
  eventType:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  nodeKey?: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  await ctx.runMutation(internal.flowsEngine.insertRunEvent, {
    accountId: run.accountId,
    flowRunId: run._id,
    eventType,
    nodeKey,
    payload,
  });
}

async function logError(
  ctx: ActionCtx,
  run: Doc<"flowRuns">,
  nodeKey: string | null,
  reason: string,
  err?: unknown,
): Promise<void> {
  await insertEvent(ctx, run, "error", nodeKey ?? undefined, {
    reason,
    detail: err instanceof Error ? err.message : err !== undefined ? String(err) : undefined,
  });
}

async function endRun(
  ctx: ActionCtx,
  flowRunId: Id<"flowRuns">,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await ctx.runMutation(internal.flowsEngine.endRunMutation, { flowRunId, status, reason });
}

/**
 * Cancel the run's previously-scheduled fallback timeout (if any) and
 * schedule a fresh one `onTimeoutHours` from now — the Convex
 * counterpart to the original cron sweep re-evaluating every active
 * run's staleness on each poll. Called once per `dispatchInbound` call
 * that leaves the run genuinely active (see the "advanced"/"started"/
 * "fallback_fired" outcome gate in `dispatchInbound` itself), and again
 * from `timeout` itself when a timeout resolves to another reprompt.
 */
async function rescheduleFallbackTimeout(
  ctx: ActionCtx,
  flowRunId: Id<"flowRuns">,
  previousTimeoutId: Id<"_scheduled_functions"> | undefined,
  onTimeoutHours: number,
): Promise<void> {
  if (previousTimeoutId) {
    try {
      await ctx.scheduler.cancel(previousTimeoutId);
    } catch {
      // Already fired or already cancelled — fine, a fresh one is
      // scheduled unconditionally below regardless.
    }
  }
  const ms = Math.max(1_000, onTimeoutHours * 3_600_000);
  const newTimeoutId = await ctx.scheduler.runAfter(ms, internal.flowsEngine.timeout, { flowRunId });
  await ctx.runMutation(internal.flowsEngine.setFallbackTimeoutId, { flowRunId, fallbackTimeoutId: newTimeoutId });
}

async function maybeRescheduleFallback(ctx: ActionCtx, flowRunId: Id<"flowRuns">): Promise<void> {
  const run = await ctx.runQuery(internal.flowsEngine.getRun, { flowRunId });
  if (!run || run.status !== "active") return;
  const flow = await ctx.runQuery(internal.flowsEngine.getFlow, { flowId: run.flowId });
  const policy = resolveFallbackPolicy(flow?.fallbackPolicy);
  await rescheduleFallbackTimeout(ctx, run._id, run.fallbackTimeoutId, policy.on_timeout_hours);
}

// ------------------------------------------------------------
// Internal queries
// ------------------------------------------------------------

export const getRun = internalQuery({
  args: { flowRunId: v.id("flowRuns") },
  handler: async (ctx, args) => await ctx.db.get(args.flowRunId),
});

export const getFlow = internalQuery({
  args: { flowId: v.id("flows") },
  handler: async (ctx, args) => await ctx.db.get(args.flowId),
});

/**
 * The active run for a contact, or `null`. Mirrors
 * `loadActiveRunForContact`'s own ".limit(1)" forgiveness comment: the
 * "one active run per (account, contact)" invariant is enforced at
 * INSERT time (`insertFlowRun` below), so more than one active row here
 * should be impossible — but picking the newest rather than erroring
 * out keeps dispatch alive for this contact even if that invariant
 * were ever violated by a future direct DB edit.
 */
export const loadActiveRunForContact = internalQuery({
  args: { accountId: v.id("accounts"), contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("flowRuns")
      .withIndex("by_account_contact", (q) => q.eq("accountId", args.accountId).eq("contactId", args.contactId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .collect();
    if (runs.length === 0) return null;
    runs.sort((a, b) => b._creationTime - a._creationTime);
    return runs[0];
  },
});

/** All active flows for an account, oldest first (first-registered wins on trigger overlap, matching the original's `.order('created_at', asc)`). */
export const listActiveFlows = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const flows = await ctx.db
      .query("flows")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .collect();
    return flows.sort((a, b) => a._creationTime - b._creationTime);
  },
});

/** One SELECT for a whole flow's nodes — the advance loop is in-memory from there, mirroring `loadAllNodes`'s own comment. */
export const listNodesForFlow = internalQuery({
  args: { flowId: v.id("flows") },
  handler: async (ctx, args) =>
    await ctx.db
      .query("flowNodes")
      .withIndex("by_flow_node_key", (q) => q.eq("flowId", args.flowId))
      .collect(),
});

/**
 * Idempotency check — mirrors `isDuplicateInbound`, scoped to just this
 * ACTIVE run's own event log (via `by_run`) rather than every historical
 * run for the contact: only an active run can be advanced twice, so a
 * duplicate against an already-ended run can never happen and doesn't
 * need checking.
 */
export const isDuplicateInbound = internalQuery({
  args: { flowRunId: v.id("flowRuns"), metaMessageId: v.string() },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("flowRunEvents")
      .withIndex("by_run", (q) => q.eq("flowRunId", args.flowRunId))
      .collect();
    return events.some(
      (e) =>
        e.eventType === "reply_received" &&
        (e.payload as Record<string, unknown> | undefined)?.metaMessageId === args.metaMessageId,
    );
  },
});

export const getContactPhone = internalQuery({
  args: { accountId: v.id("accounts"), contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== args.accountId) return null;
    return contact.phone;
  },
});

/**
 * Resolves the (already-existing) conversation + phone to send through
 * when STARTING a new run — mirrors `resolveSendTargetQuery`'s own
 * "resolve once, thread the result through" shape, simplified because a
 * flow run persists its OWN `conversationId` at creation (unlike an
 * automation's transient per-trigger context), so later sends within
 * the SAME run just reuse `run.conversationId` directly.
 */
export const resolveDispatchTarget = internalQuery({
  args: { accountId: v.id("accounts"), contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== args.accountId) return null;
    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .filter((q) => q.eq(q.field("accountId"), args.accountId))
      .first();
    if (!conversation) return null;
    return { conversationId: conversation._id, phone: contact.phone };
  },
});

export const findMessageIdByWamid = internalQuery({
  args: { wamid: v.string() },
  handler: async (ctx, args) => {
    const msg = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.wamid))
      .first();
    return msg?._id ?? null;
  },
});

/** DB half of `evaluateConditionNode` for `tag`/`contact_field` subjects — `var` never reaches here (resolved from in-memory `run.vars`). */
export const resolveConditionSubject = internalQuery({
  args: {
    accountId: v.id("accounts"),
    contactId: v.optional(v.id("contacts")),
    subject: v.union(v.literal("tag"), v.literal("contact_field")),
    subjectKey: v.string(),
  },
  // Returns `string | null`, not `string | undefined` — a Convex
  // function can't return a bare `undefined` over the `ctx.runQuery`
  // boundary (it serializes to `null` on the wire); the caller
  // (`evaluateConditionNode`) converts back to `undefined` to match
  // `evaluateConditionPredicate`'s own "absent" sentinel.
  handler: async (ctx, args): Promise<string | null> => {
    if (!args.contactId) return null;
    if (args.subject === "tag") {
      const link = await ctx.db
        .query("contactTags")
        .withIndex("by_contact_tag", (q) => q.eq("contactId", args.contactId!).eq("tagId", args.subjectKey as Id<"tags">))
        .first();
      // For tags, "present"/"absent" is the only meaningful test — the
      // subject VALUE, when present, is just the tag id echoed back
      // (mirrors the original's own comment on this exact branch).
      return link ? args.subjectKey : null;
    }
    const ALLOWED = new Set(["name", "email", "phone", "company"]);
    if (!ALLOWED.has(args.subjectKey)) {
      throw new Error(`unsupported contact_field: ${args.subjectKey}`);
    }
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== args.accountId) return null;
    const raw = (contact as unknown as Record<string, unknown>)[args.subjectKey];
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  },
});

// ------------------------------------------------------------
// Internal mutations
// ------------------------------------------------------------

export const insertRunEvent = internalMutation({
  args: {
    accountId: v.id("accounts"),
    flowRunId: v.id("flowRuns"),
    eventType: v.union(
      v.literal("started"),
      v.literal("node_entered"),
      v.literal("message_sent"),
      v.literal("reply_received"),
      v.literal("fallback_fired"),
      v.literal("handoff"),
      v.literal("timeout"),
      v.literal("error"),
      v.literal("completed"),
    ),
    nodeKey: v.optional(v.string()),
    payload: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("flowRunEvents", {
      accountId: args.accountId,
      flowRunId: args.flowRunId,
      eventType: args.eventType,
      nodeKey: args.nodeKey,
      payload: args.payload ?? {},
    });
  },
});

/**
 * Ends a run and cancels any pending fallback-timeout scheduled
 * function — there is no point keeping a timeout alive for a run that
 * just ended, and `ctx.scheduler.cancel` on an already-completed
 * scheduled function throws, so the cancel is best-effort.
 */
export const endRunMutation = internalMutation({
  args: {
    flowRunId: v.id("flowRuns"),
    status: v.union(v.literal("completed"), v.literal("handed_off"), v.literal("timed_out"), v.literal("failed")),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.flowRunId);
    if (!run) return;
    if (run.fallbackTimeoutId) {
      try {
        await ctx.scheduler.cancel(run.fallbackTimeoutId);
      } catch {
        // Already fired or already cancelled — fine.
      }
    }
    await ctx.db.patch(args.flowRunId, {
      status: args.status,
      endedAt: Date.now(),
      endReason: args.reason,
      fallbackTimeoutId: undefined,
    });
  },
});

/**
 * Optimistic advance — only moves `currentNodeKey` when it still
 * matches the value read at the top of dispatch, mirroring the
 * original's own `advanceCurrentNodeKey` UPDATE-with-precondition
 * (Convex's per-mutation serializability already prevents a genuine
 * lost update; this check is kept anyway for behavioral/log parity
 * with the source, including its own "lost the race" log line).
 */
export const advanceCurrentNodeKey = internalMutation({
  args: {
    flowRunId: v.id("flowRuns"),
    expectedOldKey: v.union(v.string(), v.null()),
    newKey: v.string(),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.flowRunId);
    if (!run || run.status !== "active") return false;
    if ((run.currentNodeKey ?? null) !== args.expectedOldKey) return false;
    await ctx.db.patch(args.flowRunId, { currentNodeKey: args.newKey, lastAdvancedAt: Date.now() });
    return true;
  },
});

export const setLastPromptMessage = internalMutation({
  args: { flowRunId: v.id("flowRuns"), lastPromptMessageId: v.id("messages") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.flowRunId, { lastPromptMessageId: args.lastPromptMessageId });
  },
});

/** Persists a collect_input capture + resets repromptCount atomically — mirrors the original's own read-merge-write on `vars`. */
export const captureVar = internalMutation({
  args: { flowRunId: v.id("flowRuns"), varKey: v.string(), value: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.flowRunId);
    if (!run) return;
    const vars = { ...(run.vars ?? {}), [args.varKey]: args.value };
    await ctx.db.patch(args.flowRunId, { vars, repromptCount: 0 });
  },
});

export const setRepromptCount = internalMutation({
  args: { flowRunId: v.id("flowRuns"), repromptCount: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.flowRunId, { repromptCount: args.repromptCount });
  },
});

/**
 * add/remove a contact tag for the `set_tag` node. Verifies the tag
 * belongs to the run's own account before adding it — stricter than
 * the original (which trusted `tag_id` unchecked), mirroring
 * `automationsEngine.ts`'s own `add_tag` deviation for the same reason:
 * Convex's `ctx.db.insert` has no `WHERE account_id = ...` clause the
 * way a Postgres `INSERT` would fail closed against a foreign id.
 */
export const applyTag = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    tagId: v.id("tags"),
    mode: v.union(v.literal("add"), v.literal("remove")),
  },
  handler: async (ctx, args) => {
    if (args.mode === "add") {
      const tag = await ctx.db.get(args.tagId);
      if (!tag || tag.accountId !== args.accountId) return;
      const existing = await ctx.db
        .query("contactTags")
        .withIndex("by_contact_tag", (q) => q.eq("contactId", args.contactId).eq("tagId", args.tagId))
        .first();
      if (!existing) {
        await ctx.db.insert("contactTags", { accountId: args.accountId, contactId: args.contactId, tagId: args.tagId });
      }
      return;
    }
    const existing = await ctx.db
      .query("contactTags")
      .withIndex("by_contact_tag", (q) => q.eq("contactId", args.contactId).eq("tagId", args.tagId))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});

/**
 * Shared by an explicit `handoff` node AND a fallback-exhausted /
 * timeout-exhausted escalation — all three are "flip the conversation
 * to pending (+ optionally assign) and end the run as handed_off."
 * `assignToUserId`, when given, is only applied after verifying
 * membership in this account (stricter than the original's unchecked
 * `assign_to`, same reasoning as `applyTag` above).
 */
export const executeHandoffMutation = internalMutation({
  args: {
    accountId: v.id("accounts"),
    flowRunId: v.id("flowRuns"),
    conversationId: v.optional(v.id("conversations")),
    assignToUserId: v.optional(v.string()),
    note: v.optional(v.string()),
    nodeKey: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.conversationId) {
      const conversation = await ctx.db.get(args.conversationId);
      if (conversation && conversation.accountId === args.accountId) {
        const patch: { status: "pending"; updatedAt: number; assignedToUserId?: Id<"users"> } = {
          status: "pending",
          updatedAt: Date.now(),
        };
        if (args.assignToUserId) {
          const membership = await ctx.db
            .query("memberships")
            .withIndex("by_user_account", (q) =>
              q.eq("userId", args.assignToUserId as Id<"users">).eq("accountId", args.accountId),
            )
            .first();
          if (membership) patch.assignedToUserId = args.assignToUserId as Id<"users">;
        }
        await ctx.db.patch(args.conversationId, patch);
        // Same charge-on-assignment guarantee as `conversations.assign`,
        // `conversations.setAutoreplyPaused`, and `automationsEngine.ts`'s
        // `assign_conversation` step — feature-off/agents-only/idempotent,
        // so safe to call unconditionally right after the patch. Reads
        // `patch.assignedToUserId` (not the raw `args.assignToUserId`) so
        // this only fires when the membership check above actually
        // confirmed the target belongs to this account (lead-value fix
        // wave — final review).
        if (patch.assignedToUserId) {
          await chargeLeadIfAgent(ctx, args.accountId, patch.assignedToUserId, args.conversationId);
        }
      }
    }
    await ctx.db.insert("flowRunEvents", {
      accountId: args.accountId,
      flowRunId: args.flowRunId,
      eventType: "handoff",
      nodeKey: args.nodeKey,
      payload: { note: args.note ?? null, assignedTo: args.assignToUserId ?? null },
    });

    const run = await ctx.db.get(args.flowRunId);
    if (run?.fallbackTimeoutId) {
      try {
        await ctx.scheduler.cancel(run.fallbackTimeoutId);
      } catch {
        // Already fired or already cancelled — fine.
      }
    }
    await ctx.db.patch(args.flowRunId, {
      status: "handed_off",
      endedAt: Date.now(),
      endReason: "handoff_node",
      fallbackTimeoutId: undefined,
    });
  },
});

/**
 * Starts a new run, atomically re-checking "one active run per
 * (account, contact)" inside this same mutation transaction — the
 * Convex counterpart to the original's partial unique index +
 * 23505-catch. Returns `null` (never throws) when a concurrent dispatch
 * already won the race; the caller treats that identically to the
 * original's own duplicate-insert handling.
 */
export const insertFlowRun = internalMutation({
  args: {
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    flowId: v.id("flows"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    entryNodeKey: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("flowRuns")
      .withIndex("by_account_contact", (q) => q.eq("accountId", args.accountId).eq("contactId", args.contactId))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();
    if (existing) return null;

    return await ctx.db.insert("flowRuns", {
      accountId: args.accountId,
      createdByUserId: args.createdByUserId,
      flowId: args.flowId,
      contactId: args.contactId,
      conversationId: args.conversationId,
      status: "active",
      currentNodeKey: args.entryNodeKey,
      vars: {},
      repromptCount: 0,
      lastAdvancedAt: Date.now(),
    });
  },
});

export const bumpFlowExecutionCount = internalMutation({
  args: { flowId: v.id("flows") },
  handler: async (ctx, args) => {
    const flow = await ctx.db.get(args.flowId);
    if (!flow) return;
    await ctx.db.patch(args.flowId, { executionCount: flow.executionCount + 1, lastExecutedAt: Date.now() });
  },
});

export const setFallbackTimeoutId = internalMutation({
  args: { flowRunId: v.id("flowRuns"), fallbackTimeoutId: v.id("_scheduled_functions") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.flowRunId, { fallbackTimeoutId: args.fallbackTimeoutId });
  },
});

/**
 * Clears `fallbackTimeoutId` WITHOUT calling `ctx.scheduler.cancel` —
 * used exactly once, at the top of `timeout`'s own handler, to
 * self-clear the reference to the scheduled function that is, at that
 * point, itself currently running (see that handler's own comment for
 * why calling `.cancel` on it there would be a self-cancel).
 */
export const clearFallbackTimeoutId = internalMutation({
  args: { flowRunId: v.id("flowRuns") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.flowRunId, { fallbackTimeoutId: undefined });
  },
});
