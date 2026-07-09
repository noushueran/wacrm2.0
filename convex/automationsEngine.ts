import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { ActionCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  validateInteractivePayload,
  type InteractiveMessagePayload,
} from "./lib/whatsapp/interactive";
import { isDeliverableUrl } from "./webhookDelivery";

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
// directly. There is no cron, and `automationPendingExecutions` (still
// in `schema.ts` for now, unused) is never written to by this engine.
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
// Two deliberate deviations from a byte-literal reading of this task's
// own brief, both explained where they matter below:
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
  /** The tag id that was added, for a future tag_added trigger. */
  tagId?: Id<"tags">;
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agentId?: Id<"users">;
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactiveReplyId?: string;
}

interface KeywordMatchTriggerConfig {
  keywords: string[];
  match_type: "exact" | "contains";
  case_sensitive?: boolean;
}

interface InteractiveReplyTriggerConfig {
  reply_ids: string[];
}

interface SendMessageStepConfig {
  text: string;
}

type SendButtonsStepConfig = InteractiveMessagePayload;
type SendListStepConfig = InteractiveMessagePayload;

interface SendTemplateStepConfig {
  template_name: string;
  language?: string;
  variables?: Record<string, string>;
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

type ConditionSubject = "contact_field" | "tag_presence" | "message_content" | "time_of_day";

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

      // Tenant isolation (GHSA-63cv-2c49-m5v3): `contactId` may come
      // from a future public entrypoint that reads it straight off a
      // request body. Refuse silently — same as the original — rather
      // than a distinct error that would leak whether a given contact
      // id exists in some other account.
      if (args.contactId) {
        const owned: boolean = await ctx.runQuery(
          internal.automationsEngine.contactBelongsToAccount,
          { accountId: args.accountId, contactId: args.contactId },
        );
        if (!owned) {
          console.warn(
            "[automations] contact not in account, refusing dispatch",
            args.contactId,
          );
          return;
        }
      }

      const automations: Doc<"automations">[] = await ctx.runQuery(
        internal.automationsEngine.listActiveAutomations,
        { accountId: args.accountId, triggerType: args.triggerType },
      );
      if (automations.length === 0) return;

      for (const automation of automations) {
        if (!triggerMatches(automation, context)) continue;
        try {
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
  });

  // Atomic +1 (a single `internalMutation` read-patch — Convex has no
  // concurrent-write race the way the original's SQL RPC guarded
  // against, but the shape mirrors `increment_automation_execution_count`
  // 1:1, including its `last_executed_at = NOW()` refresh).
  await ctx.runMutation(internal.automationsEngine.bumpExecutionCount, {
    automationId: automation._id,
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

async function executeStepsFrom(
  ctx: ActionCtx,
  allSteps: Doc<"automationSteps">[],
  args: ExecuteArgs,
): Promise<void> {
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
    return;
  }

  const results: StepResult[] = [];
  let status: "success" | "partial" | "failed" = "success";
  let errorMessage: string | undefined;

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
      await ctx.scheduler.runAfter(ms, internal.automationsEngine.resume, {
        automationId: args.automation._id,
        contactId: args.contactId ?? undefined,
        parentStepId: args.parentStepId ?? undefined,
        branch: args.branch ?? undefined,
        nextPosition: step.position + 1,
        logId: args.logId ?? undefined,
        context: args.context,
      });
      return;
    }

    try {
      if (step.stepType === "condition") {
        const cfg = step.stepConfig as ConditionStepConfig;
        const taken = await evaluateCondition(ctx, cfg, args);
        results.push({
          stepId: step._id,
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
        await executeStepsFrom(ctx, allSteps, {
          ...args,
          parentStepId: step._id,
          branch: taken ? "yes" : "no",
          startPosition: 0,
        });
        continue;
      }

      const detail = await runStep(ctx, step, args);
      results.push({ stepId: step._id, stepType: step.stepType, status: "success", detail });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ stepId: step._id, stepType: step.stepType, status: "failed", detail: msg });
      status = "failed";
      errorMessage = msg;
      break;
    }
  }

  // Only the root scope's completion overwrites the log's overall
  // status; a nested branch's own completion just appends its steps
  // (the original's `appendResults(..., null, errorMessage)` for any
  // `parentStepId !== null` scope).
  await ctx.runMutation(internal.automationsEngine.appendLogResults, {
    logId: args.logId ?? undefined,
    newItems: results,
    status: args.parentStepId === null ? status : undefined,
    errorMessage,
  });
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
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00"). Pure, no DB.
      const [from, to] = (cfg.operand ?? "").split("-");
      if (!from || !to) return false;
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const parse = (s: string) => {
        const [h, m] = s.split(":").map(Number);
        return (h || 0) * 60 + (m || 0);
      };
      const f = parse(from);
      const t = parse(to);
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t;
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
      const text = interpolate(cfg.text, args.context);
      if (!text.trim()) throw new Error("send_message has empty text");
      const { conversationId, to } = await resolveSendTarget(ctx, args);
      const result: { whatsappMessageId: string } = await ctx.runAction(internal.metaSend.sendText, {
        accountId: args.automation.accountId,
        conversationId,
        to,
        text,
      });
      return `sent via Meta (${result.whatsappMessageId})`;
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
      const params = cfg.variables ? sortTemplateParams(cfg.variables) : [];
      const result: { whatsappMessageId: string } = await ctx.runAction(
        internal.metaSend.sendTemplate,
        {
          accountId: args.automation.accountId,
          conversationId,
          to,
          templateName: cfg.template_name,
          language: cfg.language,
          params,
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
  automation: { triggerType: string; triggerConfig?: unknown },
  ctx: AutomationContext | undefined,
): boolean {
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

export const contactBelongsToAccount = internalQuery({
  args: { accountId: v.id("accounts"), contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    return !!contact && contact.accountId === args.accountId;
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

export const getAutomation = internalQuery({
  args: { automationId: v.id("automations") },
  handler: async (ctx, args) => await ctx.db.get(args.automationId),
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
 * Read-merge-write onto one log's `stepsExecuted` — the Convex
 * counterpart to `engine.ts`'s `appendResults`. `status` is left
 * untouched when omitted (nested-branch scopes pass no `status`, only
 * the root scope's own completion overwrites the log's overall
 * status), matching the original's `if (status !== null)` guard.
 */
export const appendLogResults = internalMutation({
  args: {
    logId: v.optional(v.id("automationLogs")),
    newItems: v.array(
      v.object({
        stepId: v.string(),
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

    const merged = [...((log.stepsExecuted as unknown[] | undefined) ?? []), ...args.newItems];
    const patch: { stepsExecuted: unknown[]; status?: "success" | "partial" | "failed"; errorMessage?: string } = {
      stepsExecuted: merged,
    };
    if (args.status !== undefined) patch.status = args.status;
    if (args.errorMessage) patch.errorMessage = args.errorMessage;
    await ctx.db.patch(args.logId, patch);
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
          await ctx.db.patch(conversation._id, { assignedToUserId: agentId });
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
