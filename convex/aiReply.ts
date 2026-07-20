import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";
import { hasMinRole, canAccessConversation } from "./lib/roles";
import { insertNotification } from "./notifications";
import type { Doc, Id } from "./_generated/dataModel";
import { aiContextMessageLimit, buildSystemPrompt, HANDOFF_SENTINEL } from "./lib/ai/defaults";
import { deliveryDelayMs } from "./lib/ai/pacing";
import { landingUrlKey, type AdContext } from "./lib/ai/adContext";
import { latestUserMessage } from "./lib/ai/query";
import {
  AI_VISIBLE_MEDIA_TYPES,
  toChatMessages,
  type HistoryMessage,
} from "./lib/ai/context";
import { generateReply, parseGeneration } from "./lib/ai/generate";
import { claimSlot, AUTO_REPLY_LIMIT } from "./lib/aiRateLimit";
import {
  transcribeAudioFromUrl,
  describeImageFromUrl,
  DESCRIBE_FALLBACK_MODEL,
} from "./lib/ai/media";
import { AiError } from "./lib/ai/types";
import type { GenerateResult } from "./lib/ai/types";
import { r2ConfigFromEnv } from "./lib/r2/config";
import { resolveMediaUrlLazy } from "./lib/r2/url";

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

// How many times one dispatch may be pushed back by the account's
// auto-reply burst budget before it goes through regardless. Each deferral
// waits out the remainder of a 60s window, so this is ~5 minutes of
// smoothing — comfortably past any organic burst. Unlike
// DISPATCH_MAX_ATTEMPTS, exhausting this does NOT abandon the reply: it
// bounds scheduler churn under sustained overload, and the reply still
// sends (see the pacing block in `dispatchInbound`).
const PACING_MAX_DEFERRALS = 5;

// One scheduled retry for a SEND-boundary failure only (Fix F4 — see
// `deliverReply`'s own doc comment for the full reasoning: the plan this
// branch originally shipped with assumed Meta send rejections were
// "near-always non-retryable," which is factually wrong — the WhatsApp
// Cloud API returns retryable 429/500/503 responses same as any other
// HTTP API). Deliberately its OWN budget, separate from
// `DISPATCH_MAX_ATTEMPTS`/`DISPATCH_RETRY_DELAY_MS` above: by the time
// `deliverReply` even runs, the typing indicator has already been ticking
// for up to `deliveryDelayMs`'s ~15-20s range, so this retry cannot afford
// the full 30s dispatch-level delay without risking the exact dead-air
// failure Fix F1 exists to close. In the worst case (target up to 20s +
// failed attempt + 3s wait + successful attempt), the total reaches ~25-27s
// — at or slightly past Meta's ~25s typing-indicator ceiling. When the
// margin is exceeded, the failure is graceful: the indicator disappears a
// few seconds early and the retried message still arrives — unlike the
// silent-forever failure the retry exists to prevent. One retry (never a
// loop) keeps this worst case bounded.
const DELIVER_MAX_ATTEMPTS = 2;
const DELIVER_RETRY_DELAY_MS = 3_000;

/** `[[FAIL]]` in the triggering message steers the provider-failure
 *  branch in DRY-RUN tests — thrown from `syntheticGeneration`, exactly
 *  where a real `generateReply` network failure would surface. */
const FAILURE_SENTINEL = "[[FAIL]]";

/** DRY-RUN send-boundary failure sentinels for `deliverReply`'s own
 *  retry tests (Fix F4) — same convention as `FAILURE_SENTINEL` above,
 *  but `metaSend.ts` itself is a file this phase leaves untouched and has
 *  no failure hook of its own, so the synthetic throw lives here instead,
 *  positioned at the exact boundary each sentinel is meant to probe:
 *    - `[[SENDFAIL]]` in `replyText` throws BEFORE the send call
 *      resolves, and ONLY on the first attempt — so the retry (which
 *      carries the same `replyText` forward unchanged) succeeds, same as
 *      a real transient failure that clears by the next try. This is
 *      exactly where a real Meta 429/500 rejection would surface.
 *    - `[[SENDFAIL_ALWAYS]]` is the same, but on EVERY attempt — for
 *      proving `DELIVER_MAX_ATTEMPTS` actually bounds the retry (a
 *      config-shaped failure that never clears must not loop), the same
 *      role `[[FAIL]]` plays for `dispatchInbound`'s own "persistent
 *      failure stops" test.
 *    - `[[POSTSENDFAIL]]` throws AFTER the send has already gone out,
 *      simulating a downstream bookkeeping failure — must NOT retry.
 */
const SEND_FAILURE_SENTINEL = "[[SENDFAIL]]";
const ALWAYS_SEND_FAILURE_SENTINEL = "[[SENDFAIL_ALWAYS]]";
const POST_SEND_FAILURE_SENTINEL = "[[POSTSENDFAIL]]";

/** DRY-RUN stand-in for a voice-note transcript / image description. */
const DRY_RUN_TRANSCRIPT = "[dry-run transcript]";

/** Upper bound on media rows transcribed per dispatch — a burst of
 *  voice notes costs at most this many transcription calls per reply. */
const MAX_TRANSCRIPTIONS_PER_DISPATCH = 3;

/**
 * Outcome of `ackInbound`: which gate (if any) fired, or success.
 * Returned instead of void so tests can verify the action's eligibility
 * gates without relying on side effects (which are skipped in DRY-RUN).
 */
export type AckOutcome =
  | "acked" // successful blue-tick + typing indicator
  | "skipped_inactive" // no config, or isActive/autoReplyEnabled off
  | "skipped_no_context" // loadDispatchContext returned null
  | "skipped_assigned" // a human owns the thread
  | "skipped_paused" // aiAutoreplyDisabled on this conversation
  | "failed"; // the try/catch caught something

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
 * rows whose media already resolved into storage (`mediaKey` OR
 * `mediaUrl` set) qualify; the rest keep their placeholder until a later
 * dispatch.
 *
 * Returns the RAW `mediaKey`/`mediaUrl` pair rather than a resolved URL:
 * this is a `query`, and resolving requires `r2ConfigFromEnv()` — Convex
 * codebase convention here (see `conversionEvents.ts`/`campaignAds.ts`'s
 * own "only an action can read process.env" comments) is that only an
 * action reads deployment env, so resolution happens in the caller
 * (`dispatchInbound`, an `internalAction`) instead, inside its own
 * per-row try/catch — see that call site's comment for why.
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
    {
      messageId: Id<"messages">;
      contentType: "audio" | "image";
      mediaKey: string | null;
      mediaUrl: string | null;
      caption: string | null;
    }[]
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
          (m.mediaKey || m.mediaUrl) &&
          !m.aiTranscription,
      )
      .slice(0, args.limit)
      .map((m) => ({
        messageId: m._id,
        contentType: m.contentType as "audio" | "image",
        mediaKey: m.mediaKey ?? null,
        mediaUrl: m.mediaUrl ?? null,
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
 *
 * Probes BOTH pools `retrieve` serves — the legacy `aiKnowledgeChunks`
 * and the compiled `kbChunks` — because every caller of `retrieve` is
 * gated on this query. Checking only the legacy pool would mean an
 * account that migrated to Knowledge Engine v2 and then deleted its
 * pasted documents (reachable today via `aiKnowledge.remove` in the
 * settings UI) gated itself OFF: auto-reply and all three engines would
 * silently ground on nothing despite a fully populated `kbChunks`.
 * `.first()` on each, never a `.collect()` — this runs on every inbound
 * message and only ever needs "is there at least one row".
 */
export const hasKnowledgeChunks = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<boolean> => {
    const legacyChunk = await ctx.db
      .query("aiKnowledgeChunks")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    if (legacyChunk !== null) return true;
    const compiledChunk = await ctx.db
      .query("kbChunks")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    return compiledChunk !== null;
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
/**
 * Take one slot from the account's auto-reply burst budget.
 *
 * A mutation rather than a helper so the read-decide-write is atomic:
 * `dispatchInbound` is an action, and two inbounds landing together would
 * otherwise both read the same count and both claim the same slot.
 *
 * Returns `{ allowed: false, retryAfterMs }` when the window is full —
 * which means "come back then", NOT "skip this reply". The caller
 * re-schedules itself; see the pacing block in `dispatchInbound`.
 */
export const claimAutoReplySlot = internalMutation({
  args: { accountId: v.id("accounts") },
  handler: async (
    ctx,
    args,
  ): Promise<{ allowed: boolean; retryAfterMs: number }> => {
    const row = await ctx.db
      .query("aiAutoReplyRate")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();

    const decision = claimSlot(
      row ? { windowStartMs: row.windowStartMs, count: row.count } : null,
      Date.now(),
    );

    if (!decision.allowed) {
      return { allowed: false, retryAfterMs: decision.retryAfterMs };
    }

    if (row) await ctx.db.patch(row._id, decision.next);
    else await ctx.db.insert("aiAutoReplyRate", { accountId: args.accountId, ...decision.next });

    return { allowed: true, retryAfterMs: 0 };
  },
});

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

/**
 * Ad-aware context for a conversation that began from a Click-to-
 * WhatsApp ad: the `conversation.adReferral` denorm (headline / ad text
 * / link) plus the cached landing-page extraction behind that link
 * (`adLandingPages`). Ensures the cache lazily — ingest already warms it
 * for new ad clicks, but threads that predate the prefetch hook (or a
 * lost race) get their fetch here, bounded by `ensureFresh`'s own
 * timeout. Best-effort by contract: any failure just means the reply
 * goes out without ad grounding, exactly as before this feature.
 * `undefined` on a non-ad conversation — zero extra reads, prompt
 * byte-identical to pre-feature behaviour.
 */
async function loadAdContext(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
  conversation: Doc<"conversations">,
): Promise<AdContext | undefined> {
  const ref = conversation.adReferral;
  if (!ref || (!ref.headline && !ref.body && !ref.sourceUrl)) return undefined;
  const adContext: AdContext = {
    headline: ref.headline,
    body: ref.body,
    sourceUrl: ref.sourceUrl,
  };
  const urlKey = ref.sourceUrl ? landingUrlKey(ref.sourceUrl) : null;
  if (ref.sourceUrl && urlKey) {
    try {
      await ctx.runAction(internal.adLanding.ensureFresh, {
        accountId,
        url: ref.sourceUrl,
      });
      const landing = await ctx.runQuery(internal.adLanding.get, { accountId, urlKey });
      if (landing) {
        adContext.landingTitle = landing.title;
        adContext.landingDescription = landing.description;
        adContext.landingContent = landing.content;
      }
    } catch (err) {
      console.warn("[ai reply] ad landing context failed:", err);
    }
  }
  return adContext;
}

// ------------------------------------------------------------
// Dispatch — the public entry point.
// ------------------------------------------------------------

/**
 * Blue-tick the inbound and show "typing…" as soon as it lands, rather
 * than after the debounce elapses. Scheduled at `runAfter(0)` from
 * `ingest.ts` in parallel with the (delayed) dispatch.
 *
 * This exists because the customer used to sit in total silence for the
 * whole debounce window, which reads as being ignored. Acknowledging
 * first makes the wait legible, so the wait itself no longer has to be
 * short to feel human.
 *
 * Gates mirror `dispatchInbound`'s first four (config live, auto-reply
 * on, account owns the thread, no human in charge) but deliberately
 * NOT its debounce-token check: re-acking on every message of a burst
 * is correct — a human reading along would keep the receipt current.
 *
 * Best-effort throughout. A failure here costs a read receipt, never a
 * reply, so it must never throw into the scheduler. Returns an `AckOutcome`
 * so tests can verify the eligibility gates without relying on side effects
 * (which are skipped in DRY-RUN).
 */
export const ackInbound = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    triggerWamid: v.string(),
  },
  handler: async (ctx, args): Promise<AckOutcome> => {
    try {
      const config = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
        accountId: args.accountId,
      });
      if (!config || !config.isActive || !config.autoReplyEnabled) {
        return "skipped_inactive";
      }

      const dispatchContext: { conversation: Doc<"conversations">; to: string } | null =
        await ctx.runQuery(internal.aiReply.loadDispatchContext, {
          accountId: args.accountId,
          conversationId: args.conversationId,
          contactId: args.contactId,
        });
      if (!dispatchContext) {
        return "skipped_no_context";
      }

      const { conversation } = dispatchContext;
      if (conversation.assignedToUserId) {
        return "skipped_assigned"; // a human owns this thread
      }
      if (conversation.aiAutoreplyDisabled) {
        return "skipped_paused"; // handed off / turned off here
      }

      await ctx.runAction(internal.metaSend.markRead, {
        accountId: args.accountId,
        whatsappMessageId: args.triggerWamid,
        typingIndicator: true,
      });
      return "acked";
    } catch (err) {
      console.warn("[ai auto-reply] ack failed:", err);
      return "failed";
    }
  },
});

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
    // Meta wamid of the inbound message that triggered this dispatch.
    // The initial blue-tick + "typing…" now fires immediately via
    // `ackInbound` (scheduled separately from `ingest.ts`); this is kept
    // only so a scheduled retry can carry it forward unchanged. Optional:
    // older callers simply skip it.
    triggerWamid: v.optional(v.string()),
    // Row id of that same inbound message — the debounce token. The
    // ingest layer schedules dispatch `debounceMsForText()` after each
    // inbound; at fire time only the dispatch whose trigger is still
    // the newest customer message replies, so a burst of quick
    // fragments gets ONE reply. Optional: direct callers (tests, a
    // future manual trigger) skip the staleness check.
    triggerMessageId: v.optional(v.id("messages")),
    // Wall-clock ms when the triggering inbound arrived, so delivery can
    // subtract time already spent. Optional: dispatches scheduled before
    // this shipped carry no value and simply skip the subtraction.
    inboundAt: v.optional(v.number()),
    // How many times this dispatch has been deferred by the account's
    // auto-reply burst budget (absent = never). Deliberately SEPARATE from
    // `attempt`: that one bounds error retries and gives up at its ceiling,
    // whereas exhausting this one must never drop the reply — it proceeds
    // anyway. Sharing a counter would let a long burst silently consume the
    // error budget and lose the message.
    pacingDeferrals: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    // Flipped right after delivery is successfully scheduled (before any
    // real Meta send happens): a failure AFTER this point must not retry
    // (delivery has been handed off, so this dispatch must not retry).
    // The actual send may still fail inside deliverReply, which logs
    // rather than retries, deliberately avoiding double-texts.
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
            // Resolved HERE, inside the per-row try — not in the query
            // above, and not hoisted above this `try` — so that
            // `r2ConfigFromEnv()`'s throw (only reachable when
            // `row.mediaKey` is actually present; see
            // `resolveMediaUrlLazy`'s doc comment) is caught by the same
            // best-effort per-row handling as any other transcription
            // failure, rather than aborting the whole dispatch. The
            // query's widened filter (`mediaKey || mediaUrl`) guarantees
            // at least one is truthy for every row reaching this loop,
            // so `link` is only ever null if that invariant is somehow
            // violated — the `continue` guard below is belt-and-braces.
            const link = resolveMediaUrlLazy(r2ConfigFromEnv, {
              key: row.mediaKey,
              url: row.mediaUrl,
            });
            if (!link) continue;
            const text = isDryRun()
              ? DRY_RUN_TRANSCRIPT
              : row.contentType === "audio"
                ? await transcribeAudioFromUrl({ apiKey: openAiKey, mediaUrl: link })
                : await describeImageFromUrl({
                    apiKey: openAiKey,
                    model:
                      config.provider === "openai" ? config.model : DESCRIBE_FALLBACK_MODEL,
                    mediaUrl: link,
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

      // Independent of each other — the knowledge lookup makes a network
      // call for embeddings, so overlapping them saves real wall-clock
      // inside a window the customer is now watching.
      const knowledgePromise = (async (): Promise<string[]> => {
        const hasKb = await ctx.runQuery(internal.aiReply.hasKnowledgeChunks, {
          accountId: args.accountId,
        });
        if (!hasKb) return [];
        return await ctx.runAction(internal.aiKnowledge.retrieve, {
          accountId: args.accountId,
          queryText,
        });
      })();
      // Unhandled-rejection guard (whole-branch review Fix F8): if
      // `qualification` below rejects FIRST, `Promise.all` settles on ITS
      // reason and stops awaiting `knowledgePromise` — but that promise
      // is still running, and if it later ALSO rejects, nothing is left
      // listening to it, so Node flags it as an unhandled rejection (a
      // runtime warning) even though the outer try/catch already has the
      // failure covered via `Promise.all`'s own rejection. This no-op
      // `.catch` just registers a handler so that warning never fires;
      // `Promise.all` below still listens to this SAME promise directly,
      // so it still rejects (and the outer catch still fires) exactly as
      // before if `knowledgePromise` itself fails — behaviour is
      // unchanged, only the spurious warning is gone.
      knowledgePromise.catch(() => {});
      const [knowledgeResult, qualification] = await Promise.all([
        knowledgePromise,
        ctx.runQuery(internal.qualificationEngine.getObjectives, {
          accountId: args.accountId,
          conversationId: args.conversationId,
        }),
      ]);
      let knowledge: string[] = knowledgeResult;
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

      // Ad-aware grounding (CTWA): what the customer clicked + what the
      // ad links to — so the FIRST reply can greet with the actual
      // package instead of a blind "how can I help?".
      const adContext = await loadAdContext(ctx, args.accountId, conversation);

      const systemPrompt = buildSystemPrompt({
        userPrompt: config.systemPrompt ?? null,
        mode: "auto_reply",
        knowledge,
        qualification: qualification ?? undefined,
        adContext,
      });

      // ── Burst pacing (RATE_LIMITS.aiAutoReplyAccount) ──────────────
      // Placed here on purpose: AFTER every eligibility gate, so a reply
      // that would have been skipped anyway never burns a slot, and BEFORE
      // generation, because the LLM call is the thing that costs money and
      // trips the provider's own rate limit.
      //
      // Over budget = defer, never drop. Re-scheduling `dispatchInbound`
      // re-runs all the gates above, so a human taking the thread during
      // the wait turns the deferred dispatch into a no-op — the same
      // property the error-retry path below relies on.
      //
      // The ceiling exists only to bound scheduler churn if inbound stays
      // above budget indefinitely; hitting it PROCEEDS rather than giving
      // up, because dropping the reply is the one outcome the owner's
      // always-reply decision rules out. That trades the budget for the
      // guarantee, so it is logged loudly.
      const deferrals = args.pacingDeferrals ?? 0;
      const slot = await ctx.runMutation(internal.aiReply.claimAutoReplySlot, {
        accountId: args.accountId,
      });
      if (!slot.allowed) {
        if (deferrals < PACING_MAX_DEFERRALS) {
          await ctx.scheduler.runAfter(
            slot.retryAfterMs,
            internal.aiReply.dispatchInbound,
            { ...args, pacingDeferrals: deferrals + 1 },
          );
          return;
        }
        console.warn(
          `[ai auto-reply] account ${args.accountId} still over the ${AUTO_REPLY_LIMIT}/min budget after ${deferrals} deferrals — replying anyway (always-reply wins over the budget)`,
        );
      }

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

      // Hand off to a delayed delivery instead of sending now, so the
      // reply lands at a pace proportional to its own length. `elapsed`
      // is measured from the INBOUND, not from here — that absorbs the
      // model's think time into the typing window rather than stacking
      // on top of it.
      const elapsedMs = args.inboundAt ? Date.now() - args.inboundAt : 0;
      await ctx.scheduler.runAfter(
        deliveryDelayMs({ replyLength: replyText.length, elapsedMs }),
        internal.aiReply.deliverReply,
        {
          accountId: args.accountId,
          conversationId: args.conversationId,
          contactId: args.contactId,
          to,
          replyText,
          triggerMessageId: args.triggerMessageId,
          askAdmin: generation.askAdmin ?? undefined,
          inquiryIds: teamAnswers.inquiryIds,
        },
      );
      // Delivery is scheduled and owns the send from here. Any failure
      // past this point must not re-dispatch — see this flag's own
      // declaration comment.
      sent = true;
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
              // Carry inboundAt forward so pacing still measures from the
              // customer's original message, not from the retry. Without
              // this, a delayed retry adds the full target delay on top of
              // the already-elapsed time, blowing past Meta's 25s ceiling.
              inboundAt: args.inboundAt,
            },
          );
          // Re-ack on retry (whole-branch review Fix F1 — CORRECTED: the
          // first attempt at this fix scheduled the re-ack at
          // `runAfter(0)`, which is wrong and this comment exists so
          // nobody repeats it). Both `runAfter` calls in this catch block
          // are issued at the SAME instant — the moment attempt N's
          // failure lands here — so their delays are directly comparable:
          // an ack scheduled at `+0ms` starts its "typing…" indicator
          // right now, and Meta auto-dismisses that indicator ~25s later
          // with no documented way to refresh it. The retry above isn't
          // scheduled to actually RUN until `+DISPATCH_RETRY_DELAY_MS`
          // (30s) later. 30s > 25s: a `+0ms` ack is therefore GUARANTEED
          // to expire roughly 5s before the retry even begins executing —
          // and the retry then still needs its own generation time on top
          // of that. The customer watches "typing…" die, then sits in
          // silence; re-acking at +0 shrinks that silent gap, it does not
          // eliminate it.
          //
          // The fix: schedule the re-ack at the SAME delay as the retry
          // itself (`DISPATCH_RETRY_DELAY_MS`), so its indicator becomes
          // live at the moment the retry actually STARTS running, not at
          // the moment it was merely scheduled. The two land together by
          // design — see `aiReply.test.ts`'s own timing assertion on this
          // exact relationship. This is what makes `triggerWamid` a live
          // argument (see its own declaration comment above) rather than
          // dead weight only ever forwarded, never read.
          //
          // Scheduled in its own try/catch: a failure acking must never
          // cost the customer the retry itself — same reasoning as Fix
          // F7's `ingest.ts` guard around the very same call.
          if (args.triggerWamid) {
            try {
              await ctx.scheduler.runAfter(
                DISPATCH_RETRY_DELAY_MS,
                internal.aiReply.ackInbound,
                {
                  accountId: args.accountId,
                  conversationId: args.conversationId,
                  contactId: args.contactId,
                  triggerWamid: args.triggerWamid,
                },
              );
            } catch (ackErr) {
              console.warn("[ai auto-reply] retry re-ack scheduling failed:", ackErr);
            }
          }
        } catch (schedErr) {
          // Preserve this action's never-throws contract even here.
          console.error("[ai auto-reply] retry scheduling failed:", schedErr);
        }
      }
    }
  },
});

/**
 * Send a reply that has already been generated, then do the post-send
 * bookkeeping. Scheduled by `dispatchInbound` after a delay derived from
 * the reply's own length, so the message lands at a human typing pace
 * instead of the instant the model finishes.
 *
 * Split out rather than sleeping inside `dispatchInbound`: an in-action
 * sleep would hold an action slot and bill up to ~15s of idle compute on
 * every single reply (`DEFAULT_TYPING_MAX_MS` in `lib/ai/pacing.ts` —
 * the 12s flat debounce this replaced is gone).
 *
 * The debounce token, the account-wide AI kill switch, and per-
 * conversation human takeover are ALL re-checked HERE, at the last
 * possible moment — more time has passed than at any earlier gate, so
 * this is where any of the three is most likely to have changed under us
 * (whole-branch review Fixes F2 (conversation-level, then completed to
 * also cover the account-level switch) and the debounce/takeover checks
 * alongside it).
 *
 * Retry semantics deliberately differ from `dispatchInbound`'s own, and
 * are scoped to the SEND itself (Fix F4 — overriding this branch's
 * original plan, which retried nothing here on the theory that "Meta
 * send rejections were near-always non-retryable." That theory is
 * factually wrong: the WhatsApp Cloud API returns retryable 429 (rate
 * limit) and 500/503 (transient) responses same as any other HTTP API,
 * so an un-retried 429 during a busy hour left the customer with a blue
 * tick, "typing…", and then nothing, ever). `metaSend.sendText` is the
 * first thing this action's try block actually DOES — everything before
 * it is a re-check, not an effect — so `sent` flips true the instant that
 * call resolves, and the catch below reschedules this action ONLY when
 * `sent` is still false, i.e. only when the send itself never went out.
 * A failure AFTER that point (a downstream mutation, the admin relay) is
 * logged, never retried: the customer already has the message, and
 * retrying would mean re-running this action's own body again, double-
 * texting them.
 *
 * The retry's safety from double-texting relies on the distinction between
 * a clean send rejection (definitive HTTP error from Meta, a pre-send check
 * throwing) vs. an ambiguous network failure where the response is lost in
 * transit after Meta has already received and processed the message. For
 * clean rejections, `sent` stays false and a retry is safe. But the Cloud
 * API's text-send endpoint takes no client-supplied idempotency key, and
 * our `fetch()` call has no `AbortController`, timeout, or timeout detection
 * — so a network-level response loss can go undetected, leaving `sent`
 * false while the customer already received the message. A retry in this
 * case sends a duplicate. This tradeoff was accepted deliberately: a rare
 * duplicate is preferred over the silent-forever failure (a typing indicator
 * that disappears without a reply) the retry exists to prevent.
 *
 * Bounded like `dispatchInbound`'s own retry (one retry, never a loop, its
 * own `sendAttempt` counter so the two schemes can't be confused) but with
 * its own much shorter delay — see `DELIVER_RETRY_DELAY_MS`'s own comment
 * for why it must stay short.
 */
export const deliverReply = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    to: v.string(),
    replyText: v.string(),
    triggerMessageId: v.optional(v.id("messages")),
    askAdmin: v.optional(v.string()),
    // Table name verified against `qualificationEngine.markAnswersDelivered`
    // (`convex/qualificationEngine.ts:1332`) — it is `adminInquiries`.
    inquiryIds: v.array(v.id("adminInquiries")),
    // 1-based retry counter for a SEND-boundary failure only (Fix F4;
    // absent = first attempt). Only ever set by this action's OWN catch
    // block below when it reschedules itself — deliberately a separate
    // field from `dispatchInbound`'s `attempt`, since the two are
    // different retry scopes (generation vs. send) with different
    // budgets and must never be conflated.
    sendAttempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    // Flipped the instant `metaSend.sendText` resolves (Fix F4): nothing
    // before this point is an externally-visible effect (they're re-
    // checks), so a failure while `sent` is still false means the
    // customer has NOT received anything yet and a retry is safe. Once
    // `sent` is true, the catch below must never retry — see this
    // action's own doc comment for the full reasoning.
    let sent = false;
    try {
      if (args.triggerMessageId) {
        const latestNow = await ctx.runQuery(internal.aiReply.latestInboundMessageId, {
          accountId: args.accountId,
          conversationId: args.conversationId,
        });
        if (latestNow && latestNow !== args.triggerMessageId) return;
      }

      // Re-check the account-wide AI kill switch (whole-branch review Fix
      // F2, completing the re-check below — this half was missing from
      // the first attempt at this fix): `dispatchInbound` already gated
      // on `config.isActive`/`config.autoReplyEnabled` — the very FIRST
      // gate it applies — before ever scheduling this delivery, but that
      // read is now stale by up to `deliveryDelayMs`'s max (~15s): long
      // enough for the owner to flip the account-wide emergency AI-off
      // switch in Settings (e.g. right after watching the bot say
      // something wrong) and reasonably expect it to take effect
      // immediately, not up to 15s later. Re-loading and re-checking it
      // here, exactly like `ackInbound` does at its own execution time
      // (see that action's handler), is what makes the switch actually
      // immediate.
      const config = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
        accountId: args.accountId,
      });
      if (!config || !config.isActive || !config.autoReplyEnabled) return;

      // Re-check human takeover (whole-branch review Fix F2): delivery
      // can be scheduled up to `deliveryDelayMs`'s max (~15s) after
      // `dispatchInbound` already checked `assignedToUserId`/
      // `aiAutoreplyDisabled` — long enough for an agent to claim or
      // pause the conversation from the dashboard in between. Before this
      // branch the send happened right after generation (~2-6s of
      // exposure); the scheduled delay widened that window, and manual
      // takeover is the ONLY stop the bot recognizes (see this file's
      // header) — re-checking here, at the last possible moment before
      // sending, is what keeps that guarantee true.
      const dispatchContext = await ctx.runQuery(internal.aiReply.loadDispatchContext, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        contactId: args.contactId,
      });
      if (!dispatchContext) return;
      if (dispatchContext.conversation.assignedToUserId) return;
      if (dispatchContext.conversation.aiAutoreplyDisabled) return;

      // DRY-RUN send-boundary failure sentinels (Fix F4 tests) — see
      // `SEND_FAILURE_SENTINEL`'s own comment. Positioned exactly where a
      // real Meta send rejection would surface, i.e. BEFORE `sent` is
      // ever set.
      if (
        isDryRun() &&
        ((args.replyText.includes(SEND_FAILURE_SENTINEL) && (args.sendAttempt ?? 1) === 1) ||
          args.replyText.includes(ALWAYS_SEND_FAILURE_SENTINEL))
      ) {
        throw new Error("DRY-RUN synthetic send failure");
      }

      const sendResult = await ctx.runAction(internal.metaSend.sendText, {
        accountId: args.accountId,
        conversationId: args.conversationId,
        to: args.to,
        text: args.replyText,
      });
      // The customer now has the message — nothing past this point may
      // ever cause a retry (see this handler's own `sent` declaration).
      sent = true;

      // DRY-RUN post-send failure sentinel (Fix F4 tests): proves a
      // failure AFTER the send does NOT retry (retrying would double-text
      // a customer who already has the message).
      if (isDryRun() && args.replyText.includes(POST_SEND_FAILURE_SENTINEL)) {
        throw new Error("DRY-RUN synthetic post-send failure");
      }

      await ctx.runMutation(internal.aiReply.markMessageAiGenerated, {
        accountId: args.accountId,
        whatsappMessageId: sendResult.whatsappMessageId,
      });
      await ctx.runMutation(internal.aiReply.bumpReplyCount, {
        accountId: args.accountId,
        conversationId: args.conversationId,
      });

      if (args.askAdmin) {
        await ctx.scheduler.runAfter(
          0,
          internal.qualificationEngine.relayQuestionToAdmin,
          {
            accountId: args.accountId,
            conversationId: args.conversationId,
            contactId: args.contactId,
            question: args.askAdmin,
          },
        );
      }
      if (args.inquiryIds.length > 0) {
        await ctx.runMutation(internal.qualificationEngine.markAnswersDelivered, {
          inquiryIds: args.inquiryIds,
        });
      }
    } catch (err) {
      console.error("[ai auto-reply] delivery failed:", err);
      // Retry ONLY a send-boundary failure (Fix F4 — see this action's
      // own doc comment for why "Meta rejections are non-retryable" was
      // the wrong call): the WhatsApp Cloud API's 429/500/503 responses
      // ARE retryable, so a failure reaching this catch while `sent` is
      // still false must not leave the customer with a dead "typing…"
      // indicator and permanent silence. A failure once `sent` is true
      // (a downstream mutation, the admin relay) is logged only —
      // `dispatchInbound` already considers this reply handed off, and
      // re-running this action's OWN body again would double-text a
      // customer who may already have received the message.
      //
      // Bounded exactly like `dispatchInbound`'s own retry (one retry,
      // never a loop) but with a SHORT delay of its own
      // (`DELIVER_RETRY_DELAY_MS`, its own comment explains why): the
      // customer already has a live typing indicator running from
      // `ackInbound`/the dispatch retry's re-ack by the time delivery
      // even starts, so this cannot afford anywhere near
      // `DISPATCH_RETRY_DELAY_MS` without risking the exact dead-air
      // failure Fix F1 exists to close.
      const attempt = args.sendAttempt ?? 1;
      if (!sent && attempt < DELIVER_MAX_ATTEMPTS) {
        try {
          await ctx.scheduler.runAfter(DELIVER_RETRY_DELAY_MS, internal.aiReply.deliverReply, {
            accountId: args.accountId,
            conversationId: args.conversationId,
            contactId: args.contactId,
            to: args.to,
            replyText: args.replyText,
            triggerMessageId: args.triggerMessageId,
            askAdmin: args.askAdmin,
            inquiryIds: args.inquiryIds,
            sendAttempt: attempt + 1,
          });
        } catch (schedErr) {
          // Preserve this action's never-throws contract even here.
          console.error("[ai auto-reply] delivery retry scheduling failed:", schedErr);
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
 * Admin+ "test-chat with the agent" action — Convex port of `POST
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
 *
 * Raised from Agent+ to Admin+ (whole-branch review Fix 3): this loads
 * the account's DECRYPTED config — including `systemPrompt`, which Task
 * 3 of this branch deliberately stopped exposing to the member-facing
 * config query — and spends the account's own BYO provider budget on
 * every call. Its only UI is the Playground tab on `/agents`, which is
 * already admin/owner-only (`/agents` is absent from `SUPERVISOR_NAV`/
 * `AGENT_NAV`/`VIEWER_NAV` in `src/lib/auth/roles.ts`); this closes the
 * matching backend gap. Contrast with `draft` below, which stays
 * Agent+ — the inbox "suggest a reply" action every agent uses daily —
 * see ITS doc comment for why raising that one would be wrong.
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
    if (!hasMinRole(context.role, "admin")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "admin" });
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
 *
 * Deliberately KEPT at Agent+ (whole-branch review Fix 3 — verified, not
 * changed): this backs the inbox message composer's "suggest a reply"
 * button (`src/components/inbox/message-composer.tsx`), which every
 * agent uses on every conversation they're allowed to see. It never
 * returns the raw config or `systemPrompt` to the caller (only the
 * generated `draft` text) and per-conversation RBAC below already keeps
 * an agent to their own/pool conversations. Raising this floor would
 * break the inbox for agents, which is out of scope for this branch —
 * contrast with `playground` above (raised to Admin+), which is a
 * different surface (the admin-only `/agents` page) with a different
 * blast radius (the decrypted config + the account's AI spend).
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
    // Per-conversation RBAC: the account check above is NOT sufficient — an
    // agent could otherwise draft a reply grounded in a COLLEAGUE'S thread
    // that `messages.listByConversation` would refuse to show them. Same
    // "view" policy + NOT_FOUND conflation as `reactions.reactToMeta`;
    // supervisor+ keep full access, the assignee and the unassigned pool work.
    if (
      !canAccessConversation(
        context.role,
        {
          isMine: conversation.assignedToUserId === userId,
          isUnassigned: conversation.assignedToUserId === undefined,
        },
        "view",
      )
    ) {
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

    // Same ad-aware grounding the auto-reply gets — an agent drafting
    // the first reply to an ad lead wants the package context too.
    const adContext = await loadAdContext(ctx, accountId, conversation);

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt ?? null,
      mode: "draft",
      knowledge,
      adContext,
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
