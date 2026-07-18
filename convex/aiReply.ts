import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";
import { hasMinRole } from "./lib/roles";
import { chargeLeadIfAgent } from "./lib/leadCharge";
import type { Doc, Id } from "./_generated/dataModel";
import { aiContextMessageLimit, buildSystemPrompt, HANDOFF_SENTINEL } from "./lib/ai/defaults";
import { latestUserMessage } from "./lib/ai/query";
import { buildHandoffSummary } from "./lib/ai/handoff";
import {
  AI_VISIBLE_MEDIA_TYPES,
  toChatMessages,
  type HistoryMessage,
} from "./lib/ai/context";
import { generateReply, parseGeneration } from "./lib/ai/generate";
import { AiError } from "./lib/ai/types";
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
//     that cross-engine precedence call. CLOSED as of Phase 8, Task 4b:
//     `convex/ingest.ts`'s `processInbound` now owns exactly this
//     decision (`shouldDispatchAiReply` + `automationsEngine.
//     hasActiveAutoResponder`), gating whether it calls
//     `aiReply.dispatchInbound` at all — this function itself still has
//     no such check in its own body, by design; the precedence lives at
//     the orchestration layer, not here.
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

// One scheduled retry per inbound: a transient provider/network failure
// (429, timeout) must not leave the customer unanswered, but a broken
// config (bad key) mustn't loop either — attempt 2 is the last.
const DISPATCH_MAX_ATTEMPTS = 2;
const DISPATCH_RETRY_DELAY_MS = 30_000;

/** `[[FAIL]]` in the triggering message steers the provider-failure
 *  branch in DRY-RUN tests — thrown from `syntheticGeneration`, exactly
 *  where a real `generateReply` network failure would surface. */
const FAILURE_SENTINEL = "[[FAIL]]";

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
  if (latestMessage.includes(FAILURE_SENTINEL)) {
    throw new Error("DRY-RUN synthetic provider failure");
  }
  // `[[NEEDINFO:<q>]]` in the triggering message steers the ask-admin
  // branch in tests, same convention as the handoff sentinel below.
  const needInfo = latestMessage.match(/\[\[NEEDINFO:([\s\S]*?)\]\]/);
  const raw = latestMessage.includes(HANDOFF_SENTINEL)
    ? HANDOFF_SENTINEL
    : needInfo
      ? `Let me check with my team and get back to you shortly! [[ASK_ADMIN: ${needInfo[1].trim()}]]`
      : DRY_RUN_REPLY_TEXT;
  const parsed = parseGeneration(raw);
  return { ...parsed, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
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
 * Loads a conversation and re-verifies it belongs to `accountId`,
 * returning `null` on any mismatch — for the `draft` action below.
 * `loadDispatchContext` (above) does the same ownership check but ALSO
 * requires a `contactId` (it fetches the contact's phone for the
 * eventual `metaSend`); `draft` never sends anything and is only ever
 * given a `conversationId` (matching `src/app/api/ai/draft/route.ts`'s
 * `{ conversation_id }` body), so it has no `contactId` on hand to pass
 * in. This is the same lookup, minus that requirement.
 */
export const getConversationForAccount = internalQuery({
  args: { accountId: v.id("accounts"), conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<Doc<"conversations"> | null> => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return null;
    return conversation;
  },
});

/**
 * The last `limit` conversation messages the AI can "see" (text + the
 * customer-content media types — see `context.ts`'s
 * `AI_VISIBLE_MEDIA_TYPES`), oldest → newest, re-asserting `accountId`
 * on every row even though `by_conversation` alone would already scope
 * correctly in practice (belt-and-braces, same discipline as
 * `aiKnowledge.ts`'s `getChunksByIds` — see that file's header for why
 * isolation here is layered, not single-point). Convex port of
 * `src/lib/ai/context.ts`'s DB half; `toChatMessages` (called by
 * `dispatchInbound`, not here) is the pure other half — it renders the
 * media rows as placeholders.
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
          q.or(
            q.eq(q.field("contentType"), "text"),
            ...AI_VISIBLE_MEDIA_TYPES.map((t) => q.eq(q.field("contentType"), t)),
          ),
        ),
      )
      .take(args.limit);

    // Newest-first off the index — reverse for the chronological
    // transcript the provider APIs expect (oldest message first).
    // `createdAt` rides along for callers that need a transcript
    // boundary (qualification v4); `toChatMessages` ignores it.
    return rows.reverse().map((m) => ({
      senderType: m.senderType,
      contentText: m.contentText,
      contentType: m.contentType,
      createdAt: m._creationTime,
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

    // Same charge-on-assignment guarantee as `conversations.assign`,
    // `conversations.setAutoreplyPaused`, and `automationsEngine.ts`'s
    // `assign_conversation` step — feature-off/agents-only/idempotent, so
    // safe to call unconditionally right after the patch. Guarded on
    // `handoffAgentId` itself (not just the patch above) since there's
    // nothing to charge when the bot handed off into the shared
    // unassigned queue rather than to a specific agent (lead-value fix
    // wave — final review).
    if (args.handoffAgentId) {
      await chargeLeadIfAgent(ctx, args.accountId, args.handoffAgentId, args.conversationId);
    }
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
 *   - there's no text history to ground a reply in
 *
 * The per-conversation reply cap is NOT a silent gate: a capped thread
 * with a customer still writing into it hands off to a human instead
 * (see the cap branch below) — silence would strand the customer.
 */
export const dispatchInbound = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    // 1-based retry counter (absent = first attempt). Only the retry
    // scheduled from the catch below ever passes it.
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    // Flipped right after the Meta send succeeds: a failure AFTER this
    // point must never retry (the customer already has the reply —
    // re-dispatching would double-text them).
    let sent = false;
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
      // Reply budget spent: the customer is still writing, so going
      // silent would strand them — hand the thread to a human instead
      // (markHandoff sets `aiAutoreplyDisabled`, so this fires once).
      // `claimReplySlot` below stays the authoritative, race-proof check
      // at the point a reply is actually sent.
      if (replyCountSoFar >= config.autoReplyMaxPerConversation) {
        const historyRows = await ctx.runQuery(internal.aiReply.recentMessages, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          limit: aiContextMessageLimit(),
        });
        await ctx.runMutation(internal.aiReply.markHandoff, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          handoffAgentId: config.handoffAgentId,
          summary: buildHandoffSummary({
            messages: toChatMessages(historyRows),
            replyCount: replyCountSoFar,
            reason: "cap",
          }),
        });
        return;
      }

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

      // Lead-qualification steering (spec §7): tell the assistant which
      // answers exist (never re-ask) and the ONE question to weave in.
      // Null when the feature is dormant / session terminal — prompt is
      // then byte-identical to pre-qualification behaviour.
      const qualification = await ctx.runQuery(
        internal.qualificationEngine.getObjectives,
        { accountId: args.accountId, conversationId: args.conversationId },
      );
      // v4: on the turn a lead just qualified, the closing message IS
      // the reply — a second assistant message here double-texted and
      // could re-ask already-given details.
      if (qualification?.suppressReply) return;

      // Ask-admin relay (v3): team answers that haven't reached the
      // customer yet are injected as knowledge so THIS reply can deliver
      // them; marked delivered after a successful send below.
      const teamAnswers = await ctx.runQuery(
        internal.qualificationEngine.pendingAnswers,
        { accountId: args.accountId, conversationId: args.conversationId },
      );
      if (teamAnswers.notes.length > 0) knowledge = [...knowledge, ...teamAnswers.notes];

      const systemPrompt = buildSystemPrompt({
        userPrompt: config.systemPrompt ?? null,
        mode: "auto_reply",
        knowledge,
        qualification: qualification ?? undefined,
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

      // Ask-admin (v3): a marker with no accompanying text still owes the
      // customer a holding line — never fall through to handoff for it.
      let replyText = text;
      if (!handoff && !replyText && generation.askAdmin) {
        replyText = "Let me check with my team and get back to you shortly!";
      }

      if (handoff || !replyText) {
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
        text: replyText,
      });
      sent = true;
      await ctx.runMutation(internal.aiReply.markMessageAiGenerated, {
        accountId: args.accountId,
        whatsappMessageId: sendResult.whatsappMessageId,
      });

      // Ask-admin relay (v3): fan the question out to the admin numbers
      // AFTER the holding reply went out; and retire any team answers
      // this reply just delivered.
      if (generation.askAdmin) {
        await ctx.scheduler.runAfter(
          0,
          internal.qualificationEngine.relayQuestionToAdmin,
          {
            accountId: args.accountId,
            conversationId: args.conversationId,
            contactId: args.contactId,
            question: generation.askAdmin,
          },
        );
      }
      if (teamAnswers.inquiryIds.length > 0) {
        await ctx.runMutation(internal.qualificationEngine.markAnswersDelivered, {
          inquiryIds: teamAnswers.inquiryIds,
        });
      }
    } catch (err) {
      console.error("[ai auto-reply] dispatch failed:", err);
      // Transient failures (provider 429/timeout, an infra hiccup) must
      // not leave the customer unanswered — schedule ONE retry. The
      // retry re-runs every eligibility gate, so a human takeover in the
      // meantime turns it into a no-op. Never after a successful send.
      const attempt = args.attempt ?? 1;
      if (!sent && attempt < DISPATCH_MAX_ATTEMPTS) {
        try {
          await ctx.scheduler.runAfter(
            DISPATCH_RETRY_DELAY_MS,
            internal.aiReply.dispatchInbound,
            {
              accountId: args.accountId,
              conversationId: args.conversationId,
              contactId: args.contactId,
              attempt: attempt + 1,
            },
          );
        } catch (schedErr) {
          // Preserve this action's never-throws contract even here.
          console.error("[ai auto-reply] retry scheduling failed:", schedErr);
        }
      }
    }
  },
});

// ============================================================
// playground / draft — public, authed AI entry points (transitive-
// Supabase gap-fill task). Unlike `dispatchInbound` above (an
// `internalAction` with no user session), both derive the caller's
// account/role the same way `send.ts`/`broadcasts.ts`'s `send` and
// `reactions.ts`'s `reactToMeta` do: `getAuthUserId` +
// `internal.accounts.accountContextForUser` (a plain `action` has no
// `ctx.db` to run `lib/auth.ts`'s own membership lookup inline, and
// there is no `accountAction` helper in this codebase). Neither
// mutates/sends anything — see each action's own comment.
// ============================================================

const PLAYGROUND_MAX_TURNS = 20;

const playgroundMessageValidator = v.object({
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
});

/** Matches `src/app/api/ai/playground/route.ts`'s JSON body exactly
 *  (`{reply, handoff}` on success; `{error, code?}` — never thrown —
 *  for the same domain failures the route itself returns as a body
 *  rather than raising). */
type PlaygroundResult = { reply: string; handoff: boolean } | { error: string; code?: string };

/**
 * Agent+ "test-chat with the agent" action — Convex port of `POST
 * /api/ai/playground`. Runs the EXACT path the auto-reply bot uses
 * (knowledge retrieval + `auto_reply` system prompt + the account's
 * configured provider) against a client-supplied transcript, so what's
 * seen here is what a real customer would get. Reads the config even
 * when the master switch is off (`loadDecrypted` has no `requireActive`
 * gate — see that function's own doc comment), matching the route's own
 * `requireActive:false`. Stateless: never persists anything — the
 * client resends the running transcript every turn, same as the route.
 *
 * The route accepts no config/system-prompt overrides beyond `messages`
 * (checked against the actual route, not just the task brief's
 * paraphrase) — so neither does this action.
 */
export const playground = action({
  args: { messages: v.array(playgroundMessageValidator) },
  handler: async (ctx, args): Promise<PlaygroundResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
    const context = await ctx.runQuery(internal.accounts.accountContextForUser, {
      userId,
    });
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(context.role, "agent")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "agent" });
    }
    const { accountId } = context;

    // Bound the transcript + drop blank turns — the same two real (not
    // just shape-validation) rules the route's own filter/slice apply;
    // role/content shape itself is already enforced by the args
    // validator above, unlike the route's defensive re-check.
    const messages = args.messages
      .filter((m) => m.content.trim().length > 0)
      .slice(-PLAYGROUND_MAX_TURNS);
    if (messages.length === 0) {
      return { error: "Send a message to test the agent." };
    }

    let config;
    try {
      config = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
    } catch {
      return { error: "Stored API key could not be decrypted.", code: "key_decrypt_failed" };
    }
    if (!config) {
      return {
        error: "No agent configured yet. Add your provider key in Setup.",
        code: "ai_not_configured",
      };
    }

    const queryText = latestUserMessage(messages);
    let knowledge: string[] = [];
    const hasKb = await ctx.runQuery(internal.aiReply.hasKnowledgeChunks, { accountId });
    if (hasKb) {
      knowledge = await ctx.runAction(internal.aiKnowledge.retrieve, { accountId, queryText });
    }

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt ?? null,
      mode: "auto_reply",
      knowledge,
    });

    try {
      const { text, handoff } = await generateReply({
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        systemPrompt,
        messages,
      });
      return { reply: text, handoff };
    } catch (err) {
      if (err instanceof AiError) return { error: err.message, code: err.code };
      throw err;
    }
  },
});

/** Matches `src/app/api/ai/draft/route.ts`'s JSON body exactly
 *  (`{draft}` on success; `{error, code?}` for the same domain failures
 *  the route itself returns as a body rather than raising — ownership
 *  is the one exception, which throws `NOT_FOUND` like every other
 *  cross-account check in this codebase; see the handler below). */
type DraftResult = { draft: string } | { error: string; code?: string };

/**
 * Agent+ "suggest a reply" action — Convex port of `POST /api/ai/draft`.
 * Body: `{conversationId}` (matches the route's `{conversation_id}`).
 * Loads the account's config + the conversation's recent text history
 * (REUSING `recentMessages`/`toChatMessages`, the same internals
 * `dispatchInbound` above uses), grounds the reply in the knowledge
 * base, and generates a SUGGESTED reply — it never sends or persists a
 * message, only hands text back for the agent to edit (same contract as
 * the route's own doc comment: "Read-only… just hands text back to the
 * composer").
 *
 * Ownership is asserted via `getConversationForAccount` (this file) and
 * throws `ConvexError({code:"NOT_FOUND", entity:"conversation"})` on any
 * mismatch — the same "doesn't exist" / "isn't yours" conflation
 * `conversations.ts`'s `requireOwnConversation` uses everywhere else in
 * this codebase (the route's own RLS-scoped 404 is this same idea,
 * enforced at the SQL layer instead). Usage is logged via
 * `internal.aiUsage.log` — awaited (not fire-and-forget: an action's
 * lifecycle ends when its handler returns, same reasoning as
 * `dispatchInbound`'s own usage-log comment) but best-effort, matching
 * the route's own resilience around `logAiUsage`.
 */
export const draft = action({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<DraftResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
    const context = await ctx.runQuery(internal.accounts.accountContextForUser, {
      userId,
    });
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(context.role, "agent")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "agent" });
    }
    const { accountId } = context;

    const conversation = await ctx.runQuery(internal.aiReply.getConversationForAccount, {
      accountId,
      conversationId: args.conversationId,
    });
    if (!conversation) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
    }

    let config;
    try {
      config = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
    } catch {
      return { error: "Stored API key could not be decrypted.", code: "key_decrypt_failed" };
    }
    if (!config) {
      return {
        error: "AI assistant is not set up. Enable it in Settings → AI Assistant.",
        code: "ai_not_configured",
      };
    }

    const historyRows = await ctx.runQuery(internal.aiReply.recentMessages, {
      accountId,
      conversationId: args.conversationId,
      limit: aiContextMessageLimit(),
    });
    const messages = toChatMessages(historyRows);
    if (messages.length === 0) {
      return { error: "No messages to draft from yet.", code: "no_messages" };
    }

    const queryText = latestUserMessage(messages);
    let knowledge: string[] = [];
    const hasKb = await ctx.runQuery(internal.aiReply.hasKnowledgeChunks, { accountId });
    if (hasKb) {
      knowledge = await ctx.runAction(internal.aiKnowledge.retrieve, { accountId, queryText });
    }

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt ?? null,
      mode: "draft",
      knowledge,
    });

    let generation: GenerateResult;
    try {
      generation = await generateReply({
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        systemPrompt,
        messages,
      });
    } catch (err) {
      if (err instanceof AiError) return { error: err.message, code: err.code };
      throw err;
    }

    try {
      await ctx.runMutation(internal.aiUsage.log, {
        accountId,
        conversationId: args.conversationId,
        mode: "draft",
        provider: config.provider,
        model: config.model,
        promptTokens: generation.usage?.promptTokens ?? 0,
        completionTokens: generation.usage?.completionTokens ?? 0,
        totalTokens: generation.usage?.totalTokens ?? 0,
      });
    } catch (err) {
      console.warn("[ai draft] usage log failed:", err);
    }

    return { draft: generation.text };
  },
});
