import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";
import { hasMinRole } from "./lib/roles";
import { insertNotification } from "./notifications";
import type { Doc, Id } from "./_generated/dataModel";
import { aiContextMessageLimit, buildSystemPrompt, HANDOFF_SENTINEL } from "./lib/ai/defaults";
import { latestUserMessage } from "./lib/ai/query";
import {
  AI_VISIBLE_MEDIA_TYPES,
  toChatMessages,
  type HistoryMessage,
} from "./lib/ai/context";
import { generateReply, parseGeneration } from "./lib/ai/generate";
import {
  transcribeAudioFromUrl,
  describeImageFromUrl,
  DESCRIBE_FALLBACK_MODEL,
} from "./lib/ai/media";
import { AiError } from "./lib/ai/types";
import type { GenerateResult } from "./lib/ai/types";

// ============================================================
// AI auto-reply dispatch (Phase 7, Task 3 — the final Convex-backend
// task) — Convex port of `src/lib/ai/auto-reply.ts`'s
// `dispatchInboundToAiReply`. On a freshly-arrived inbound message,
// loads the account's RAG-grounded prompt, calls the account's own
// LLM (BYO key), and sends the reply — ALWAYS (handoff is manual-only;
// see `flagForHuman`). `dispatchInbound` is an `internalAction` — never exposed to
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
// Two deliberate departures from the source (owner decisions,
// 2026-07-18): the source's automatic handoff (sentinel-triggered
// `markHandoff` that silenced the bot and could auto-assign) and its
// per-conversation reply cap (`claim_ai_reply_slot`) are both GONE —
// the bot answers every message until a human manually takes the chat
// from the dashboard, and threads needing eyes are surfaced via
// `flagForHuman` (status pending) without ever stopping the bot.
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

/** Sent when the model returns nothing usable (empty / marker-only
 *  output). Handoff is manual-only, so silence is never an option —
 *  the customer always hears SOMETHING. */
const FALLBACK_REPLY_TEXT =
  "Thanks for your message! Let me look into this and get right back to you.";

// One scheduled retry per inbound: a transient provider/network failure
// (429, timeout) must not leave the customer unanswered, but a broken
// config (bad key) mustn't loop either — attempt 2 is the last.
const DISPATCH_MAX_ATTEMPTS = 2;
const DISPATCH_RETRY_DELAY_MS = 30_000;

/** `[[FAIL]]` in the triggering message steers the provider-failure
 *  branch in DRY-RUN tests — thrown from `syntheticGeneration`, exactly
 *  where a real `generateReply` network failure would surface. */
const FAILURE_SENTINEL = "[[FAIL]]";

/** DRY-RUN stand-in for a voice-note transcript / image description. */
const DRY_RUN_TRANSCRIPT = "[dry-run transcript]";

/** Upper bound on media rows transcribed per dispatch — a burst of
 *  voice notes costs at most this many transcription calls per reply. */
const MAX_TRANSCRIPTIONS_PER_DISPATCH = 3;

/**
 * DRY-RUN stand-in for `generate.ts`'s `generateReply` — skips the
 * network entirely, same convention as `convex/aiKnowledge.ts`'s
 * `syntheticEmbedding`. Markers in the triggering customer message
 * steer deterministic branches for `aiReply.test.ts`:
 *   - `[[FAIL]]` → throws (the retry path);
 *   - `[[NEEDINFO:<q>]]` → holding line + ask-admin marker;
 *   - the legacy `[[HANDOFF]]` sentinel → raw sentinel output, which
 *     dispatch must IGNORE (strip + fall back to a real reply — the
 *     model has no silence escape; handoff is manual-only).
 * Usage is all-zero, matching `aiUsage.log`'s own "skip when there's
 * no usage" no-op.
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
      transcription: m.aiTranscription,
      createdAt: m._creationTime,
    }));
  },
});

/**
 * Newest CUSTOMER message in a conversation — the debounce token
 * `dispatchInbound` compares its `triggerMessageId` against: when they
 * differ, a newer inbound arrived after this dispatch was scheduled and
 * that message's own dispatch owns the reply to the whole burst.
 */
export const latestInboundMessageId = internalQuery({
  args: { accountId: v.id("accounts"), conversationId: v.id("conversations") },
  handler: async (ctx, args): Promise<Id<"messages"> | null> => {
    const row = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .filter((q) =>
        q.and(
          q.eq(q.field("accountId"), args.accountId),
          q.eq(q.field("senderType"), "customer"),
        ),
      )
      .first();
    return row?._id ?? null;
  },
});

/**
 * Customer media rows (voice notes / images) still awaiting an AI
 * transcription/description — newest first, bounded by `limit`. Only
 * rows whose media already resolved into storage (`mediaUrl` set)
 * qualify; the rest keep their placeholder until a later dispatch.
 */
export const untranscribedMediaRows = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    limit: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    { messageId: Id<"messages">; contentType: "audio" | "image"; mediaUrl: string; caption: string | null }[]
  > => {
    // BOUNDED raw window, filtered in JS: a DB-level contentType filter
    // would stream the index until it found `limit` media matches —
    // i.e. read a long text-only conversation end-to-end on every
    // dispatch. Reading the newest 50 rows flat keeps the cost constant;
    // media older than that (or than the age cutoff below) simply keeps
    // its placeholder.
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(50);
    // Age cutoff: never backfill historical media from before this
    // feature (privacy + token spend) — only recent conversation media
    // is transcribed.
    const cutoff = Date.now() - 24 * 3_600_000;
    return rows
      .filter(
        (m) =>
          m.accountId === args.accountId &&
          m.senderType === "customer" &&
          (m.contentType === "audio" || m.contentType === "image") &&
          m._creationTime > cutoff &&
          m.mediaUrl &&
          !m.aiTranscription,
      )
      .slice(0, args.limit)
      .map((m) => ({
        messageId: m._id,
        contentType: m.contentType as "audio" | "image",
        mediaUrl: m.mediaUrl!,
        caption: m.contentText?.trim() || null,
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
 * Bumps the conversation's bot-reply tally after a successful send.
 * PURELY a metric (usage tiles, future analytics) — there is NO reply
 * cap: the bot answers every message until a human takes the chat from
 * the dashboard (owner decision 2026-07-18; the old `claimReplySlot`
 * cap-gate lived here before that).
 */
export const bumpReplyCount = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args): Promise<void> => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;
    await ctx.db.patch(args.conversationId, {
      aiReplyCount: (conversation.aiReplyCount ?? 0) + 1,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Surfaces a thread that needs human eyes WITHOUT touching the bot:
 * status → `"pending"` (the needs-attention queue), an internal summary
 * (shown in the inbox AI banner), and — on the FIRST flag only — a bell
 * to every supervisor+ member so somebody actually hears about it. That
 * is ALL the AI stack may ever do — taking a chat over (assignment,
 * autoreply pause, the lead charge) is exclusively a manual dashboard
 * action (owner decision 2026-07-18; the automatic `markHandoff` that
 * used to live here silenced the bot and could auto-assign, stranding
 * customers mid-conversation). Re-flagging an already-flagged thread
 * refreshes the note without re-belling.
 */
export const flagForHuman = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    summary: v.string(),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;
    const alreadyFlagged =
      conversation.status === "pending" && !!conversation.aiHandoffSummary;
    await ctx.db.patch(args.conversationId, {
      aiHandoffSummary: args.summary,
      status: "pending",
      updatedAt: Date.now(),
    });
    if (alreadyFlagged) return;
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    for (const member of memberships) {
      if (!hasMinRole(member.role, "supervisor")) continue;
      await insertNotification(ctx, {
        accountId: args.accountId,
        userId: member.userId,
        type: "sla_alert",
        conversationId: args.conversationId,
        contactId: conversation.contactId,
        title: "AI flagged a conversation for the team",
        body: args.summary,
      });
    }
  },
});

/** Stores a just-computed transcription/description on its media row. */
export const setTranscription = internalMutation({
  args: {
    accountId: v.id("accounts"),
    messageId: v.id("messages"),
    text: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const message = await ctx.db.get(args.messageId);
    if (!message || message.accountId !== args.accountId) return;
    await ctx.db.patch(args.messageId, { aiTranscription: args.text });
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
 *   - a human already took the thread from the dashboard (`assignedToUserId`)
 *   - auto-reply was paused on this conversation
 *   - there's no history to ground a reply in
 *
 * There is deliberately NO reply cap: the bot answers every message
 * until a human takes over manually (owner decision 2026-07-18).
 */
export const dispatchInbound = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    // 1-based retry counter (absent = first attempt). Only the retry
    // scheduled from the catch below ever passes it.
    attempt: v.optional(v.number()),
    // Meta wamid of the inbound message that triggered this dispatch —
    // lets the bot mark it read (blue ticks) + show "typing…" while the
    // reply generates. Optional: older callers simply skip the receipt.
    triggerWamid: v.optional(v.string()),
    // Row id of that same inbound message — the debounce token. The
    // ingest layer schedules dispatch `aiReplyDebounceMs()` after each
    // inbound; at fire time only the dispatch whose trigger is still
    // the newest customer message replies, so a burst of quick
    // fragments gets ONE reply. Optional: direct callers (tests, a
    // future manual trigger) skip the staleness check.
    triggerMessageId: v.optional(v.id("messages")),
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

      // Debounce gate (burst aggregation): a newer customer message
      // means ITS scheduled dispatch owns the reply to the whole burst —
      // this one stands down without sending, marking, or claiming
      // anything.
      if (args.triggerMessageId) {
        const latestInbound = await ctx.runQuery(
          internal.aiReply.latestInboundMessageId,
          { accountId: args.accountId, conversationId: args.conversationId },
        );
        if (latestInbound && latestInbound !== args.triggerMessageId) return;
      }

      // NO reply cap (owner decision): the bot answers every message
      // until a human takes the chat from the dashboard — manual
      // assignment / autoreply-pause (the two gates above) are the ONLY
      // stops. `aiReplyCount` is still counted after each send, purely
      // as a metric.

      // Every gate passed — we intend to reply. Blue-tick the triggering
      // message and show "typing…" for the LLM's think time (Meta
      // auto-dismisses it on our send). Polish, never load-bearing: a
      // failure here must not cost the customer their reply.
      if (args.triggerWamid) {
        try {
          await ctx.runAction(internal.metaSend.markRead, {
            accountId: args.accountId,
            whatsappMessageId: args.triggerWamid,
            typingIndicator: true,
          });
        } catch (err) {
          console.warn("[ai auto-reply] mark-read failed:", err);
        }
      }

      // Voice notes & images: transcribe / describe BEFORE building the
      // transcript, so the reply addresses the actual content (owner
      // requirement — the bot "listens" and "reads", then answers in
      // TEXT; it never sends media back). OpenAI-only: the account's own
      // key, or the (also-OpenAI) embeddings key on an Anthropic-model
      // account. Best-effort per row — a failure keeps the placeholder.
      const openAiKey =
        config.provider === "openai" ? config.apiKey : (config.embeddingsApiKey ?? null);
      if (openAiKey) {
        const pendingMedia = await ctx.runQuery(internal.aiReply.untranscribedMediaRows, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          limit: MAX_TRANSCRIPTIONS_PER_DISPATCH,
        });
        let transcribedAny = false;
        for (const row of pendingMedia) {
          try {
            const text = isDryRun()
              ? DRY_RUN_TRANSCRIPT
              : row.contentType === "audio"
                ? await transcribeAudioFromUrl({ apiKey: openAiKey, mediaUrl: row.mediaUrl })
                : await describeImageFromUrl({
                    apiKey: openAiKey,
                    model:
                      config.provider === "openai" ? config.model : DESCRIBE_FALLBACK_MODEL,
                    mediaUrl: row.mediaUrl,
                    caption: row.caption ?? undefined,
                  });
            if (text) {
              await ctx.runMutation(internal.aiReply.setTranscription, {
                accountId: args.accountId,
                messageId: row.messageId,
                text,
              });
              transcribedAny = true;
            }
          } catch (err) {
            console.warn("[ai auto-reply] media transcription failed:", err);
          }
        }
        // A fresh transcript is fresh extractable lead data — let the
        // qualification analysis see it (dormant-safe no-op otherwise;
        // ingest only triggers analysis for TEXT inbounds).
        if (transcribedAny) {
          await ctx.scheduler.runAfter(0, internal.qualificationEngine.analyzeInbound, {
            accountId: args.accountId,
            conversationId: args.conversationId,
            contactId: args.contactId,
          });
        }
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
      const { text, usage } = generation;

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

      // The customer ALWAYS hears something (handoff is manual-only —
      // the model has no escape hatch). A bare ask-admin marker owes a
      // holding line; any other empty/marker-only output (rare) gets the
      // warm generic fallback rather than silence.
      let replyText = text;
      if (!replyText && generation.askAdmin) {
        replyText = "Let me check with my team and get back to you shortly!";
      }
      if (!replyText) {
        replyText = FALLBACK_REPLY_TEXT;
      }

      // Re-check the debounce token at the last moment: transcription +
      // generation can take many seconds, and a message that arrived
      // meanwhile owns the reply (its own dispatch fires shortly). One
      // wasted generation beats a reply that ignores the newest message.
      if (args.triggerMessageId) {
        const latestNow = await ctx.runQuery(internal.aiReply.latestInboundMessageId, {
          accountId: args.accountId,
          conversationId: args.conversationId,
        });
        if (latestNow && latestNow !== args.triggerMessageId) return;
      }

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
      await ctx.runMutation(internal.aiReply.bumpReplyCount, {
        accountId: args.accountId,
        conversationId: args.conversationId,
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
              triggerWamid: args.triggerWamid,
              // Keeps the debounce gate honest on the retry too: if a
              // newer inbound arrived meanwhile, its dispatch replies.
              triggerMessageId: args.triggerMessageId,
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
