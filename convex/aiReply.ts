import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { aiContextMessageLimit, buildSystemPrompt, HANDOFF_SENTINEL } from "./lib/ai/defaults";
import { latestUserMessage } from "./lib/ai/query";
import { buildHandoffSummary } from "./lib/ai/handoff";
import { toChatMessages, type HistoryMessage } from "./lib/ai/context";
import { generateReply, parseGeneration } from "./lib/ai/generate";
import type { GenerateResult } from "./lib/ai/types";

// ============================================================
// AI auto-reply dispatch (Phase 7, Task 3 — the final Convex-backend
// task) — Convex port of `src/lib/ai/auto-reply.ts`'s
// `dispatchInboundToAiReply`. On a freshly-arrived inbound message,
// loads the account's RAG-grounded prompt, calls the account's own
// LLM (BYO key), and either sends the reply or hands the thread off to
// a human. `dispatchInbound` is an `internalAction` — never exposed to
// any client, `accountId` always an explicit caller-supplied argument
// (there is no user session inside a webhook-triggered dispatch),
// exactly like `convex/automationsEngine.ts`'s `runForTrigger` and
// `convex/flowsEngine.ts`'s dispatch entry point before it. Every DB
// read/write is delegated to a small `internalQuery`/`internalMutation`
// below (actions cannot touch `ctx.db` directly) — same split as those
// two engines.
//
// NOT reproduced from the source (deliberate scope cuts, not oversights):
//   - The "stand down when an active message-level automation exists"
//     check (`automations` where `trigger_type` is `new_message_received`/
//     `keyword_match`). That's an ORCHESTRATION decision about which of
//     several inbound handlers (flows / automations / this) a webhook
//     should invoke for one inbound message — this task's own brief
//     scopes `dispatchInbound` to the reply generation itself, not to
//     that cross-engine precedence call, and nothing in this codebase
//     yet wires an inbound webhook to `automationsEngine.runForTrigger`,
//     `flowsEngine`, or this function (checked `convex/ingest.ts`). A
//     future integration task owns deciding when to call this at all.
//   - The account-wide rate limiter (`checkRateLimit` on a shared BYO
//     key) — an in-process token bucket in the source with no obvious
//     Convex equivalent (no long-lived process to hold the bucket
//     state); left for a future task if BYO-key throttling turns out to
//     matter here.
//
// Two deliberate IMPROVEMENTS over the source, both directed by this
// task's own brief:
//   1. On handoff, the conversation's `status` is set to `"pending"` —
//      the source never touched `status` on handoff (an oversight fixed
//      here, matching `flowsEngine.ts`'s own `executeHandoff`, which
//      already does exactly this for a flow-triggered handoff).
//   2. The source's `claim_ai_reply_slot` Postgres RPC existed solely to
//      make the cap-check-then-increment atomic against a concurrent
//      inbound. Convex mutations are already serializable per document
//      via OCC (see `bumpExecutionCount`'s own comment on this same
//      point) — so `claimReplySlot` below is a plain read-then-patch
//      `internalMutation`, no special RPC needed, and is exactly as
//      race-proof.
//
// One gap this task closes without touching any Phase 0–6 file: sending
// via `convex/metaSend.ts`'s `sendText` persists the reply as an
// ordinary `senderType: "bot"` message — that action's args have no
// `aiGenerated` field to set `schema.ts`'s `messages.aiGenerated` (unlike
// the source's `engineSendText({ ..., aiGenerated: true })`), and
// `metaSend.ts` is a Phase 6 file this phase's Exit Gate requires left
// untouched. Rather than leave `aiGenerated` permanently dead, this file
// patches it on right after the send (`markMessageAiGenerated`, keyed by
// the just-returned `whatsappMessageId` via the `by_message_id` index) —
// see the report for this call-out in case a future phase would rather
// thread the field through `metaSend.sendText` itself instead.
// ============================================================

function isDryRun(): boolean {
  return !!process.env.CONVEX_AI_DRY_RUN;
}

const DRY_RUN_REPLY_TEXT =
  "Thanks for your message! This is an automated reply while our team follows up.";

/**
 * DRY-RUN stand-in for `generate.ts`'s `generateReply` — skips the
 * network entirely, same convention as `convex/aiKnowledge.ts`'s
 * `syntheticEmbedding`. There's no live model to consult, so it makes
 * the handoff/no-handoff call along the SAME signal a real model is
 * instructed to use (`buildSystemPrompt`'s auto-reply guidance: reply
 * with exactly `HANDOFF_SENTINEL` to bail) — just sourced from the
 * latest customer message instead of a model's own judgement. That
 * gives `aiReply.test.ts` a deterministic way to steer the handoff
 * branch (seed the triggering inbound message with the sentinel in it)
 * without ever touching the network. Usage is all-zero, matching the
 * brief ("DRY-RUN returns a synthetic reply + zero usage") and
 * `aiUsage.log`'s own "skip when there's no usage" no-op.
 */
function syntheticGeneration(latestMessage: string): GenerateResult {
  const raw = latestMessage.includes(HANDOFF_SENTINEL) ? HANDOFF_SENTINEL : DRY_RUN_REPLY_TEXT;
  const { text, handoff } = parseGeneration(raw);
  return { text, handoff, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
}

// ------------------------------------------------------------
// Internal queries — DB reads for the action below.
// ------------------------------------------------------------

/**
 * Loads the conversation + the contact's phone in one round trip,
 * re-verifying BOTH against `accountId` — the isolation boundary for
 * this whole dispatch (mirrors `automationsEngine.ts`'s own
 * `resolveSendTargetQuery`). Returns `null` on ANY mismatch (missing
 * conversation, missing contact, or either belonging to a different
 * account) so a cross-account-id mix-up degrades to a silent no-op
 * rather than ever reading — let alone acting on — another account's
 * conversation.
 */
export const loadDispatchContext = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return null;
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== args.accountId) return null;
    return { conversation, to: contact.phone };
  },
});

/**
 * The last `limit` TEXT messages of a conversation, oldest → newest,
 * re-asserting `accountId` on every row even though `by_conversation`
 * alone would already scope correctly in practice (belt-and-braces,
 * same discipline as `aiKnowledge.ts`'s `getChunksByIds` — see that
 * file's header for why isolation here is layered, not single-point).
 * Convex port of `src/lib/ai/context.ts`'s DB half; `toChatMessages`
 * (called by `dispatchInbound`, not here) is the pure other half.
 */
export const recentMessages = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    limit: v.number(),
  },
  handler: async (ctx, args): Promise<HistoryMessage[]> => {
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .filter((q) =>
        q.and(
          q.eq(q.field("accountId"), args.accountId),
          q.eq(q.field("contentType"), "text"),
        ),
      )
      .take(args.limit);

    // Newest-first off the index — reverse for the chronological
    // transcript the provider APIs expect (oldest message first).
    return rows.reverse().map((m) => ({
      senderType: m.senderType,
      contentText: m.contentText,
    }));
  },
});

/**
 * Cheap existence check on the account's knowledge chunks — lets
 * `dispatchInbound` skip the `aiKnowledge.retrieve` action call (its own
 * config load + potential embedding call) entirely when there's nothing
 * to retrieve. Purely a perf fast-path: skipping it would still behave
 * correctly, since `retrieve` already returns `[]` for an empty KB.
 */
export const hasKnowledgeChunks = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<boolean> => {
    const chunk = await ctx.db
      .query("aiKnowledgeChunks")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    return chunk !== null;
  },
});

// ------------------------------------------------------------
// Internal mutations — DB writes for the action below.
// ------------------------------------------------------------

/**
 * Atomically claims one reply slot: read-then-patch in a single Convex
 * mutation, so two concurrent inbounds for the same conversation can
 * never both squeeze past the cap (Convex's OCC serializes them — see
 * this file's own header comment). Returns `false` — no patch applied —
 * when the account/conversation mismatch OR the cap is already reached;
 * `dispatchInbound` skips the send in either case.
 */
export const claimReplySlot = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    maxReplies: v.number(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return false;
    const current = conversation.aiReplyCount ?? 0;
    if (current >= args.maxReplies) return false;
    await ctx.db.patch(args.conversationId, {
      aiReplyCount: current + 1,
      updatedAt: Date.now(),
    });
    return true;
  },
});

/**
 * Applies a handoff: pauses the bot on this thread (sticky — the
 * conversation-level early-exit in `dispatchInbound` checks
 * `aiAutoreplyDisabled` on every future inbound), records the internal
 * summary, bumps `status` to `"pending"` (see this file's header on why
 * that's an intentional addition over the source), and assigns
 * `handoffAgentId` when one is configured — omitted (never stomping an
 * existing assignment) when it isn't, dropping the conversation into the
 * shared unassigned queue instead.
 */
export const markHandoff = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    handoffAgentId: v.optional(v.id("users")),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;

    const patch: Partial<{
      aiAutoreplyDisabled: boolean;
      aiHandoffSummary: string;
      status: "open" | "pending" | "closed";
      updatedAt: number;
      assignedToUserId: Id<"users">;
    }> = {
      aiAutoreplyDisabled: true,
      aiHandoffSummary: args.summary,
      status: "pending",
      updatedAt: Date.now(),
    };
    if (args.handoffAgentId) patch.assignedToUserId = args.handoffAgentId;

    await ctx.db.patch(args.conversationId, patch);
  },
});

/**
 * Flags the message `metaSend.sendText` just persisted as AI-generated —
 * see this file's header for why this follow-up patch exists instead of
 * `sendText` accepting the flag directly. Looked up by the wamid
 * `sendText` returned (unique per send, including DRY-RUN's synthetic
 * `dry-run-<hex>` ids) via the `by_message_id` index; re-verifies
 * `accountId` the same way every other lookup in this file does.
 */
export const markMessageAiGenerated = internalMutation({
  args: { accountId: v.id("accounts"), whatsappMessageId: v.string() },
  handler: async (ctx, args) => {
    const message = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.whatsappMessageId))
      .first();
    if (!message || message.accountId !== args.accountId) return;
    await ctx.db.patch(message._id, { aiGenerated: true });
  },
});

// ------------------------------------------------------------
// Dispatch — the public entry point.
// ------------------------------------------------------------

/**
 * AI auto-reply for a freshly-arrived inbound message. Never throws
 * into the caller (own top-level try/catch, mirrors the source and
 * every other engine's dispatch entry point in this codebase) — a
 * failing or slow LLM call must never take down whatever triggered it.
 *
 * Eligibility gates (any → silent no-op, no send):
 *   - AI off (`isActive` false) / auto-reply disabled for the account
 *   - `conversationId`/`contactId` don't resolve to THIS account
 *   - a human (or a prior handoff) already owns the thread (`assignedToUserId`)
 *   - auto-reply was disabled on this conversation (prior handoff)
 *   - the per-conversation reply cap is already reached
 *   - there's no text history to ground a reply in
 */
export const dispatchInbound = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      const config = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
        accountId: args.accountId,
      });
      if (!config || !config.isActive || !config.autoReplyEnabled) return;

      const dispatchContext: { conversation: Doc<"conversations">; to: string } | null =
        await ctx.runQuery(internal.aiReply.loadDispatchContext, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          contactId: args.contactId,
        });
      if (!dispatchContext) return;
      const { conversation, to } = dispatchContext;

      if (conversation.assignedToUserId) return; // a human owns this thread
      if (conversation.aiAutoreplyDisabled) return; // handed off / turned off here
      const replyCountSoFar = conversation.aiReplyCount ?? 0;
      // Cheap early-out; `claimReplySlot` below is the authoritative,
      // race-proof check at the point a reply is actually sent.
      if (replyCountSoFar >= config.autoReplyMaxPerConversation) return;

      const historyRows = await ctx.runQuery(internal.aiReply.recentMessages, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        limit: aiContextMessageLimit(),
      });
      const messages = toChatMessages(historyRows);
      if (messages.length === 0) return; // nothing to reply to

      const queryText = latestUserMessage(messages);

      // Ground the reply in the account's knowledge base (best-effort;
      // skipped entirely when there's nothing to retrieve — see
      // `hasKnowledgeChunks`'s own doc comment).
      let knowledge: string[] = [];
      const hasKb = await ctx.runQuery(internal.aiReply.hasKnowledgeChunks, {
        accountId: args.accountId,
      });
      if (hasKb) {
        knowledge = await ctx.runAction(internal.aiKnowledge.retrieve, {
          accountId: args.accountId,
          queryText,
        });
      }

      const systemPrompt = buildSystemPrompt({
        userPrompt: config.systemPrompt ?? null,
        mode: "auto_reply",
        knowledge,
      });

      const generation: GenerateResult = isDryRun()
        ? syntheticGeneration(queryText)
        : await generateReply({
            provider: config.provider,
            model: config.model,
            apiKey: config.apiKey,
            systemPrompt,
            messages,
          });
      const { text, handoff, usage } = generation;

      // Record token spend on the account's BYO key. Awaited (unlike the
      // source's fire-and-forget `void logAiUsage(...)`: an action's own
      // lifecycle ends when its handler returns, so an un-awaited
      // `ctx.runMutation` isn't guaranteed to complete) but best-effort —
      // logged regardless of handoff, since the provider call happened
      // either way.
      try {
        await ctx.runMutation(internal.aiUsage.log, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          mode: "auto_reply",
          provider: config.provider,
          model: config.model,
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
        });
      } catch (err) {
        console.warn("[ai auto-reply] usage log failed:", err);
      }

      if (handoff || !text) {
        // The model can't (or shouldn't) answer — stop auto-replying on
        // this thread and hand it to a human.
        const summary = buildHandoffSummary({ messages, replyCount: replyCountSoFar });
        await ctx.runMutation(internal.aiReply.markHandoff, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          handoffAgentId: config.handoffAgentId,
          summary,
        });
        return;
      }

      const claimed = await ctx.runMutation(internal.aiReply.claimReplySlot, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        maxReplies: config.autoReplyMaxPerConversation,
      });
      if (!claimed) return; // lost the per-conversation cap race

      const sendResult = await ctx.runAction(internal.metaSend.sendText, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        to,
        text,
      });
      await ctx.runMutation(internal.aiReply.markMessageAiGenerated, {
        accountId: args.accountId,
        whatsappMessageId: sendResult.whatsappMessageId,
      });
    } catch (err) {
      console.error("[ai auto-reply] dispatch failed:", err);
    }
  },
});
