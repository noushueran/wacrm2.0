import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id, Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { defaultLeadAnalysisConfig } from "./lib/leadAnalysis/defaults";
import { archivedForInsert } from "./lib/leadAnalysis/archive";
import { bandForScore } from "./lib/leadAnalysis/bands";
import { firstTouchAt, isWithinWorkingHours, nextStepAt } from "./lib/leadAnalysis/sequenceSchedule";
import {
  evaluateSequence,
  type EligibilityInput,
  type SequenceVerdict,
} from "./lib/leadAnalysis/eligibility";
import { claimSendSlot, type SendRateState } from "./lib/leadAnalysis/sendRate";
import {
  buildScoreSystemPrompt,
  formatNotesForScoring,
  parseScoreResponse,
  SCORING_NOTES_MAX,
  withScoringInstruction,
} from "./lib/leadAnalysis/prompt";
import { toChatMessages } from "./lib/ai/context";
import { generateReply } from "./lib/ai/generate";
import { loadStaffPhoneSet, isStaffNumber } from "./lib/qualification/track";
import { aiJudgeModel, aiJudgeReasoningEffort, promptCacheKey } from "./lib/ai/defaults";
import { blockedReason } from "./lib/notes/gate";

// ============================================================
// Lead Analysis engine — internal machinery only (spec 2026-07-26).
// Every entry point is dormant-safe: with no enabled config the account
// has no rows, so the crons find nothing and the feature costs nothing.
// ============================================================

/**
 * The account's config, or null when the feature is off for them.
 * Typed over the minimal `{ db: QueryCtx["db"] }` (read-only) rather
 * than `QueryCtx | MutationCtx` by name: every existing caller passes a
 * full `MutationCtx` or `QueryCtx` (both structurally satisfy this), and
 * `armOnOutbound` below needs to call this from
 * `messages.ts`'s `insertMessageAndUpdateConversation`, whose own ctx
 * parameter is typed just as narrowly (`{ db: MutationCtx["db"] }`) —
 * widening this signature to the common shape is what lets that call
 * through without a cast, without loosening what any existing caller
 * (`onInbound`, `applyScore`, `backfillAccount`, `sweepScoring` via
 * `enabledConfigForAccount`) already provides.
 */
export async function loadEnabledConfig(
  ctx: { db: QueryCtx["db"] },
  accountId: Id<"accounts">,
) {
  const row = await ctx.db
    .query("leadAnalysisConfigs")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .unique();
  if (!row || !row.enabled) return null;
  return { ...defaultLeadAnalysisConfig(), ...row };
}

/** `loadEnabledConfig`, exposed as a query so `sweepScoring` (an action)
 *  can resolve a claimed row's account config via `ctx.runQuery`. */
export const enabledConfigForAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => loadEnabledConfig(ctx, args.accountId),
});

/**
 * Every non-duplicate inbound customer message re-arms scoring for the
 * conversation. DEBOUNCED, not immediate: the due time is pushed to
 * `now + rescoreDebounceMinutes` on every message, so a burst of five
 * messages settles into ONE LLM call rather than five. A silent thread
 * is never re-scored at all.
 *
 * A previously-scored row keeps its `score` while re-arming — the board
 * shows the last known score rather than blanking for the debounce
 * window.
 *
 * Fix 6 (final whole-branch review): the spec says a staff chat never
 * enters this section — `lib/qualification/track.ts`'s own module
 * comment states the invariant: "a staff chat must never become a
 * lead." Admin inbound messages arrive with `senderType: "customer"`
 * like any other inbound, so without this guard the admin thread (or
 * any team member's own WhatsApp number) would get its own
 * `leadAnalyses` row, get scored, and show up on the board as a
 * non-lead. This reuses `loadStaffPhoneSet` + `isStaffNumber`
 * (`lib/qualification/track.ts`) — the SAME predicate
 * `qualificationEngine.onInbound`'s own loop guard uses (admin alert
 * phones PLUS every membership's own phone), NOT the narrower
 * `isAdminAlertNumber` (which covers only the admin alert phones and
 * is otherwise used solely by `onAdminInbound`'s routing) — inventing a
 * second, narrower definition here would let a team member's phone slip
 * through and get scored as a lead. Excluded HERE (never create the
 * row) rather than filtered at read time: `phoneNormalized` is already
 * computed at the one call site (`ingest.ts`, for the sibling
 * `qualificationEngine.onInbound`/`onAdminInbound` calls), so passing it
 * through costs nothing new there — just the same bounded
 * `loadStaffPhoneSet` read (one indexed `qualificationConfigs` lookup
 * plus one indexed `memberships` collect) `qualificationEngine.onInbound`
 * already pays at the same call site per inbound message.
 */
export const onInbound = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    phoneNormalized: v.string(),
  },
  handler: async (ctx, args) => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config) return;

    const qualConfig = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique();
    const staff = await loadStaffPhoneSet(ctx, args.accountId, qualConfig);
    if (isStaffNumber(staff, args.phoneNormalized)) return;

    const dueAt = Date.now() + config.rescoreDebounceMinutes * 60_000;

    const existing = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        scoreStatus: "pending",
        rescoreDueAt: dueAt,
        // A fresh message is a fresh chance: a row that gave up earlier
        // re-enters the sweep with a full budget instead of staying dead.
        attempts: 0,
        lastError: undefined,
      });
      return;
    }

    // SYNC INVARIANT (schema.ts, `leadAnalyses.archived`): a conversation
    // can already be archived the first time it ever gets a row (e.g. an
    // inbound arrives after a manual archive, before its own best-effort
    // un-archive elsewhere runs — that is a SEPARATE call and must not be
    // relied on for this one to be correct). One bounded point read per
    // inbound message is the price of the invariant holding structurally.
    const conversation = await ctx.db.get(args.conversationId);

    await ctx.db.insert("leadAnalyses", {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      archived: conversation ? archivedForInsert(conversation) : undefined,
      scoreStatus: "pending",
      rescoreDueAt: dueAt,
      attempts: 0,
      sequenceStatus: "idle",
      followUpsSent: 0,
    });
  },
});

/**
 * Arm the follow-up sequence the moment we send and the customer goes
 * quiet (P3 Task 6, spec "Follow-up sequence" — the mirror image of
 * `stopOnInbound` below). Called from `messages.ts`'s
 * `insertMessageAndUpdateConversation` — the single `insert("messages")`
 * in the backend (see that file's own comment on the choke point) — for
 * every outbound (`"agent"`/`"bot"`) message, in the SAME transaction as
 * the message it reacts to. Not an `internalMutation`: a separate
 * `ctx.runMutation` would be a second transaction, and the caller's own
 * ctx (`{ db: MutationCtx["db"] }`) is already enough for every read/
 * write this needs.
 *
 * DELIBERATELY optimistic and cheap: this does NOT evaluate
 * `lib/leadAnalysis/eligibility.ts`'s twelve-gate chain. Every gate is
 * re-checked at send time by the follow-up sweep (a later task), so a
 * lead armed here in error simply resolves to `stop`/`reschedule` there
 * and costs nothing — duplicating that policy here is exactly how it
 * would drift from the one module that owns it.
 *
 * Skips (writes nothing) when:
 *  - `conversationArchivedAt` is set — the conversation is archived;
 *  - `lastCustomerMessageAt` is `undefined` — no customer message is on
 *    record (`conversations.lastInboundAt`), so there is no idle time to
 *    measure `firstTouchAt` from;
 *  - the account's `leadAnalysisConfigs` row is missing or `!enabled`;
 *  - no `leadAnalyses` row exists for the conversation yet (an
 *    outbound-only thread the scoring engine has never touched — only
 *    `onInbound`/`backfillAccount` ever create one);
 *  - the row's `sequenceStatus` is anything other than `"idle"` or
 *    `"stopped"`. This guard is LOAD-BEARING, not a nicety: the
 *    follow-up sweep's own send (a later task) is itself a `"bot"`
 *    outbound through this exact choke point, so without it every
 *    scheduled step would re-arm ITSELF the instant it sent, resetting
 *    `followUpsSent` back to 0 and recomputing `nextFollowUpAt` from
 *    `firstTouchAt` (step 0's math) forever, instead of advancing to the
 *    NEXT step via `nextStepAt`. `"exhausted"` is excluded for a
 *    different reason: the spec's hot-band table marks it *"Needs your
 *    decision"* — a human call, not something a later outbound should
 *    silently restart;
 *  - the row is `"stopped"` with `stoppedReason === "manual"` (Fix 2,
 *    whole-branch review). Every OTHER stop reason is safe to re-arm
 *    over because it is re-derived at send time by the gate chain
 *    itself (`opted_out` re-stops at gate 7, `archived` at gate 2,
 *    `disabled` at gate 1) — `"manual"` (a human pulling a lead out via
 *    `leadAnalysis.stopSequence`) has no corresponding gate, so without
 *    this check the very next outbound on the thread (an agent's reply,
 *    or the bot) would silently undo that decision and restart the
 *    whole cadence from step 0;
 *  - the row has no `band` yet (unscored, or scored outside every
 *    configured band) — nothing to schedule a cadence against;
 *  - the resolved band's `steps` array is empty (a degenerate config);
 *  - the account has no `qualificationConfigs` row — working hours are
 *    unknown, so there is no arming time to compute. Mirrors
 *    `eligibility.ts`'s own fail-closed `working_hours_unset` gate in
 *    spirit, without importing that module — this stays a plain data
 *    lookup, never a re-evaluation of that gate chain.
 */
export async function armOnOutbound(
  ctx: { db: MutationCtx["db"] },
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    conversationArchivedAt: number | undefined;
    lastCustomerMessageAt: number | undefined;
  },
): Promise<void> {
  if (args.conversationArchivedAt !== undefined) return;
  if (args.lastCustomerMessageAt === undefined) return;

  const config = await loadEnabledConfig(ctx, args.accountId);
  if (!config) return;

  const row = await ctx.db
    .query("leadAnalyses")
    .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
    .unique();
  if (!row) return;
  if (row.sequenceStatus !== "idle" && row.sequenceStatus !== "stopped") return;
  // Fix 2 (whole-branch review): a manual stop has no re-deriving gate
  // anywhere else — see the doc comment above for why this must never
  // re-arm regardless of how much later, or what else, this outbound is.
  if (row.sequenceStatus === "stopped" && row.stoppedReason === "manual") return;
  if (!row.band) return;

  const bandRule = config.bands.find((b) => b.key === row.band);
  const step0 = bandRule?.steps[0];
  if (!step0) return;

  const qualConfig = await ctx.db
    .query("qualificationConfigs")
    .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
    .unique();
  if (!qualConfig) return;

  const nextFollowUpAt = firstTouchAt({
    lastCustomerMessageAt: args.lastCustomerMessageAt,
    idleDaysBeforeSequence: config.idleDaysBeforeSequence,
    step0DelayDays: step0.delayDays,
    config: {
      utcOffsetMinutes: qualConfig.utcOffsetMinutes,
      workStartMinute: qualConfig.workStartMinute,
      workEndMinute: qualConfig.workEndMinute,
      workDays: qualConfig.workDays,
    },
  });

  await ctx.db.patch(row._id, {
    sequenceStatus: "running",
    followUpsSent: 0,
    nextFollowUpAt,
  });
}

/**
 * Stop the follow-up sequence the moment the customer replies (P3 Task
 * 6, spec "Stopping and returning"). Called from `ingest.ts` beside P2's
 * `unarchiveOnInbound`, wrapped in the same `runBestEffort` — stopping a
 * sequence must never fail message ingestion, which is why this is its
 * own plain best-effort `internalMutation` rather than folded into
 * `onInbound` above (whose failure mode — scoring — is a separate
 * concern with its own debounce timer).
 *
 * Unconditional whenever a row exists, regardless of its CURRENT
 * `sequenceStatus`: the spec's "any inbound customer message" stops the
 * sequence is not qualified by what state it happens to be in, and every
 * field this writes is already inert on an `"idle"` row (`followUpsSent`
 * and `nextFollowUpAt` are already 0/`undefined` there). A cheap no-op
 * when no `leadAnalyses` row exists at all — nothing to stop.
 *
 * `followUpsSent` resets to 0 deliberately, not left as-is: a customer
 * who replies and later goes quiet again deserves a fresh cadence
 * measured from THIS reply (the next `armOnOutbound` re-measures
 * `firstTouchAt` from the new `lastInboundAt`), not the tail end of
 * whichever step the previous run had reached.
 *
 * `stoppedReason` PRESERVES an existing `"manual"` rather than always
 * overwriting it with `"replied"` (Fix 2, whole-branch review): once
 * `armOnOutbound` reads this field to refuse re-arming a manual stop
 * (see that function's own comment), relabeling it here on the very
 * next inbound would erase the one signal that keeps that guard
 * working — silently undoing the human's manual stop by a different
 * route than the re-arm bug itself. Every other prior reason is
 * legitimately superseded by "the customer just replied".
 */
export const stopOnInbound = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    // Tenancy defense-in-depth, mirroring `leadAnalysis.archiveAutomated`:
    // "internal" only means unreachable from a client, not immune to a
    // caller bug passing a mismatched pair.
    if (!row || row.accountId !== args.accountId) return;

    await ctx.db.patch(row._id, {
      sequenceStatus: "stopped",
      stoppedReason: row.stoppedReason === "manual" ? "manual" : "replied",
      followUpsSent: 0,
      nextFollowUpAt: undefined,
    });
  },
});

/** What a `send` verdict hands the caller to actually place the send
 *  (Task 8's `sendSequenceStep`) and to persist the outbound `messages`
 *  row: the recipient, the resolved template, and its rendered body. */
interface SequenceSend {
  to: string;
  templateName: string;
  templateLanguage: string | undefined;
  contentText: string;
}

/**
 * The send-time verdict (P3 Task 7, spec "The gate chain"). Mirrors
 * `qualificationEngine.ts`'s `followUpContext`: ONE internal query that
 * re-reads every gate's input fresh — arming (Task 6) happened hours or
 * days earlier, and in that window the customer may have replied, an
 * agent may have taken over, the lead may have been archived, the
 * config may have been disabled, or Meta may have rejected the
 * template. Nothing the sweep carried from arming time is trusted here.
 *
 * THIS QUERY HOLDS NO POLICY OF ITS OWN. It only assembles a plain
 * `EligibilityInput` and hands it to `evaluateSequence`
 * (`lib/leadAnalysis/eligibility.ts`, Task 1) — every `if` that decides
 * whether to send, reschedule, stop, exhaust, or archive lives there,
 * gate-tested in isolation. Read that module's header comment before
 * touching this function: it took three correction rounds to land on
 * the five-tier order, and this query must not second-guess it.
 *
 * READS, each an index range or a single point read — never an
 * unbounded scan of a conversation's history:
 *  - the `leadAnalyses` row and its `conversations` row (point reads)
 *  - `leadAnalysisConfigs` by account (`by_account`, gate 1 + bands +
 *    cap + idle/quiet windows) — read RAW (not through
 *    `loadEnabledConfig`, which already discards the true `enabled`
 *    value by returning null) and merged over `defaultLeadAnalysisConfig()`
 *    so every numeric knob is defined even for an account that never
 *    configured this feature
 *  - the newest message overall, the newest CUSTOMER message, and the
 *    newest AGENT message — all three via `by_conversation_sender`
 *    (`by_conversation` for the first), `.order("desc").first()`: a
 *    genuine index range that costs nothing extra in a long thread
 *  - the conversation's newest `qualificationSessions` row
 *    (`by_conversation`, gates 6/7)
 *  - `qualificationConfigs` by account (`by_account`) for working
 *    hours — ABSENT MEANS `workingHoursKnown: false`, never a default.
 *    This is the owner's explicit fail-closed decision (see
 *    `eligibility.ts`'s gate 10a) — substituting one here would silently
 *    launder a real "we don't know this account's hours" into a send.
 *  - `leadSequenceSendRate` by account (`by_account`) — run through
 *    Task 3's `claimSendSlot`/`dayStartFor` arithmetic to answer "is
 *    today's budget exhausted", but the result is NEVER persisted here.
 *    Task 8's `claimSequenceSlot` is the only writer of this table;
 *    this query only reads it.
 *  - the current step's `messageTemplates` row by (account, name,
 *    language) via `by_account_name_lang` — but ONLY when there IS a
 *    current step (a resolved band whose `followUpsSent` is still
 *    inside `steps.length`). An exhausted or unresolved band has no
 *    step to check a template for, and `eligibility.ts`'s header
 *    comment explains exactly why answering that incoherent question
 *    used to be a bug (a permanently un-archivable lead) — this query
 *    avoids ever asking it by skipping the read entirely rather than
 *    inventing a default.
 *
 * For a `send` verdict, the current step's already-fetched contact and
 * template are reused to fill in `send` — no second round of reads.
 */
export const sequenceContext = internalQuery({
  args: { analysisId: v.id("leadAnalyses") },
  handler: async (ctx, args): Promise<SequenceVerdict & { send?: SequenceSend }> => {
    const row = await ctx.db.get(args.analysisId);
    if (!row) {
      throw new Error(`sequenceContext: no leadAnalyses row ${args.analysisId}`);
    }
    const conversation = await ctx.db.get(row.conversationId);
    if (!conversation || conversation.accountId !== row.accountId) {
      throw new Error(
        `sequenceContext: conversation missing or tenancy mismatch for ${args.analysisId}`,
      );
    }

    const now = Date.now();

    // RAW read, deliberately not `loadEnabledConfig` (Fix parity with
    // that helper's OWN doc comment: it collapses "disabled" and
    // "never configured" into the same `null`, which is exactly right
    // for its callers but wrong here — gate 1 needs the true `enabled`
    // value, not one already pre-filtered to null).
    const rawConfig = await ctx.db
      .query("leadAnalysisConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", row.accountId))
      .unique();
    const config = rawConfig
      ? { ...defaultLeadAnalysisConfig(), ...rawConfig }
      : defaultLeadAnalysisConfig();

    const [lastMessage, lastCustomerMessage, lastAgentMessage, session, qualConfig, sendRateRow, contact] =
      await Promise.all([
        ctx.db
          .query("messages")
          .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
          .order("desc")
          .first(),
        ctx.db
          .query("messages")
          .withIndex("by_conversation_sender", (q) =>
            q.eq("conversationId", row.conversationId).eq("senderType", "customer"),
          )
          .order("desc")
          .first(),
        ctx.db
          .query("messages")
          .withIndex("by_conversation_sender", (q) =>
            q.eq("conversationId", row.conversationId).eq("senderType", "agent"),
          )
          .order("desc")
          .first(),
        ctx.db
          .query("qualificationSessions")
          .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
          .order("desc")
          .first(),
        ctx.db
          .query("qualificationConfigs")
          .withIndex("by_account", (q) => q.eq("accountId", row.accountId))
          .unique(),
        ctx.db
          .query("leadSequenceSendRate")
          .withIndex("by_account", (q) => q.eq("accountId", row.accountId))
          .unique(),
        // Loaded here (not only in the `send` branch below, where it used
        // to be fetched a second time) because gate 7's `optedOut` input,
        // just below, needs it too: a `send`-branch-only read would run
        // AFTER `evaluateSequence` already decided to send.
        ctx.db.get(row.contactId),
      ]);

    const bandRule = config.bands.find((b) => b.key === row.band) ?? null;

    // The step this send would use, IF one exists. Deliberately left
    // `null` (never guessed) when the band is unresolved or exhausted —
    // see the module comment above and `eligibility.ts`'s tier-4 header
    // for why the template lookup below must not run in that case.
    const currentStep =
      bandRule && row.followUpsSent < bandRule.steps.length
        ? bandRule.steps[row.followUpsSent]
        : null;

    const template = currentStep
      ? await ctx.db
          .query("messageTemplates")
          .withIndex("by_account_name_lang", (q) =>
            q
              .eq("accountId", row.accountId)
              .eq("name", currentStep.templateName)
              .eq("language", currentStep.templateLanguage),
          )
          .first()
      : null;

    // The send cap's day boundary shares `qualificationConfigs.utcOffsetMinutes`
    // with working hours (schema.ts's own comment on `leadSequenceSendRate`).
    // When that config is absent, `workingHoursKnown: false` below already
    // stops the chain in tier 4 before `dailyCapReached` is ever consulted —
    // the offset used here in that case is inert.
    const utcOffsetMinutes = qualConfig?.utcOffsetMinutes ?? 0;
    const sendRateState: SendRateState | null = sendRateRow
      ? { dayStartMs: sendRateRow.dayStartMs, count: sendRateRow.count }
      : null;
    // READ-ONLY: `claimSendSlot` is pure arithmetic over values already
    // in hand — this never calls `ctx.db.patch`, so evaluating a verdict
    // (even a `send` one) can never itself spend the day's budget.
    // Task 8's `claimSequenceSlot` is the only mutation allowed to
    // persist a new `leadSequenceSendRate` state.
    const capCheck = claimSendSlot(sendRateState, now, utcOffsetMinutes, config.dailySendCap);

    const input: EligibilityInput = {
      now,
      enabled: config.enabled,
      archived: conversation.archivedAt !== undefined,
      // A human parked this thread until a set time (Task 1's
      // `snoozedUntil`). Same tier-1 lead-level fact as `archived` —
      // see eligibility.ts's tier documentation.
      snoozed: conversation.snoozedUntil !== undefined,
      conversationStatus: conversation.status,
      // Defensive default only: `armOnOutbound` requires an outbound
      // message to arm the sequence at all, so a message-less
      // conversation should be unreachable here. "bot" is a safe inert
      // choice either way — gate 4 only ever tests `=== "customer"`.
      lastMessageSenderType: lastMessage?.senderType ?? "bot",
      lastCustomerMessageAt: lastCustomerMessage?._creationTime ?? null,
      lastAgentMessageAt: lastAgentMessage?._creationTime ?? null,
      idleDaysBeforeSequence: config.idleDaysBeforeSequence,
      humanQuietHours: config.humanQuietHours,
      qualification: session
        ? {
            status: session.status,
            followUpsSent: session.followUpsSent,
            // `qualConfig` is absent only in the practically-unreachable
            // case of a session existing with no qualificationConfigs
            // row at all (sessions are only ever created THROUGH that
            // config — see `qualificationEngine.ts`'s own
            // `loadEnabledConfig` gate on every session-creating path).
            // Falling back to the session's own `followUpsSent` makes
            // "budget remaining" resolve to already-spent rather than
            // holding this lead hostage on qualification_owns forever
            // over data that doesn't exist.
            maxFollowUps: qualConfig?.maxFollowUps ?? session.followUpsSent,
          }
        : null,
      // Two independent sources feed gate 7, not one:
      //   - `session?.status === "opted_out"`: Task 5's qualification-flow
      //     gate flips a session to this status when it sees the contact
      //     is blocked. That only fires once a qualification session
      //     EXISTS and its own sweep has already run — a contact who has
      //     never had a qualification session, or whose session hasn't
      //     been swept yet, is invisible to this check alone.
      //   - `blockedReason(contact) !== null`: reads `contacts.doNotContact`
      //     directly, closing that window. `blockedReason` fails closed —
      //     a missing contact counts as blocked — so this can only ever
      //     make `optedOut` MORE conservative, never less.
      // Either source is sufficient; gate 7 (eligibility.ts) already
      // gives `optedOut` the correct terminal `stop` handling, so this
      // reuses that gate instead of adding a parallel one.
      optedOut: session?.status === "opted_out" || blockedReason(contact) !== null,
      band: bandRule,
      followUpsSent: row.followUpsSent,
      lastFollowUpAt: row.lastFollowUpAt ?? null,
      workingHoursKnown: qualConfig !== null,
      withinWorkingHours: qualConfig !== null && isWithinWorkingHours(now, qualConfig),
      dailyCapReached: !capCheck.granted,
      templateApproved: template?.status === "APPROVED",
    };

    const verdict = evaluateSequence(input);
    if (verdict.kind !== "send") return verdict;

    // Reaching `send` means tier 3 found a real current step and tier
    // 4's template gate resolved true, so both are guaranteed non-null
    // here — this is a data-integrity assertion, not a policy decision.
    // `contact` itself was already loaded above (it also feeds gate 7's
    // `optedOut`); re-checking it non-null here is still required since
    // `evaluateSequence` cannot have used a missing contact to reach
    // `send` (a missing contact makes `blockedReason` return non-null,
    // which routes to `stop` instead) — this null check is unreachable
    // in practice, same as `currentStep`/`template`, but kept for the
    // same data-integrity reason.
    if (!contact || !currentStep || !template) {
      throw new Error(`sequenceContext: inconsistent send verdict for ${args.analysisId}`);
    }

    return {
      ...verdict,
      send: {
        to: contact.phone,
        templateName: currentStep.templateName,
        templateLanguage: template.language,
        contentText: template.bodyText,
      },
    };
  },
});

// ============================================================
// P3 Task 8 — claim, send, sweep. This is the task that spends the
// owner's money: a real WhatsApp marketing template goes out to a real
// customer. Mirrors `qualificationEngine.ts`'s `claimFollowUpSlot` /
// `sendFollowUp` / `sweepFollowUps` (around line 1530) exactly,
// including the reasoning in their comments — this is not a new
// design, it is the same at-most-once discipline applied to a second
// engine.
// ============================================================

/** Address lookup for `sendSequenceStep` (an action has no db) — mirrors
 *  `qualificationEngine.sendTarget`. */
export const sequenceRowMeta = internalQuery({
  args: { analysisId: v.id("leadAnalyses") },
  handler: async (
    ctx,
    args,
  ): Promise<{ accountId: Id<"accounts">; conversationId: Id<"conversations"> } | null> => {
    const row = await ctx.db.get(args.analysisId);
    if (!row) return null;
    return { accountId: row.accountId, conversationId: row.conversationId };
  },
});

/**
 * CLAIMS the slot BEFORE the send (spec P3, mirrors
 * `qualificationEngine.claimFollowUpSlot` — read that function's own
 * comment first). In ONE transaction:
 *
 *   1. re-read the row and bail if `sequenceStatus !== "running"` OR
 *      `nextFollowUpAt` is no longer due (absent, or in the future) —
 *      either means another sender already claimed this exact slot, or
 *      something about the lead changed since `sequenceContext` was
 *      evaluated a moment ago (a reply, a manual stop, a rescore).
 *   2. re-resolve the account's config and this row's band fresh — NOT
 *      trusted from the caller, for the same "state may have moved"
 *      reason as (1). A disabled account, a since-exhausted band, or a
 *      missing working-hours config all fail the claim rather than
 *      guess.
 *   3. claim the account's daily send budget via `claimSendSlot`
 *      (Task 3) and persist the result — refuse rather than send over
 *      cap.
 *   4. only once all of the above hold: increment `followUpsSent`, set
 *      `lastFollowUpAt = now`, and BOOK THE NEXT RUNG (`nextStepAt` for
 *      the new current step, or clear `nextFollowUpAt` entirely once
 *      there is no next step — see the module header on
 *      `by_sequence_due`'s ordering for why clearing it, rather than
 *      leaving the row un-swept, is what lets a later sweep tick reach
 *      tier 3's archive/exhaust verdict for an exhausted band).
 *
 * THE ORDER IS THE ENTIRE SAFETY PROPERTY: every write above happens
 * BEFORE `sendSequenceStep` ever calls `metaSend.sendTemplate`. By the
 * time the provider is called, the slot is already spent and the next
 * rung is already booked — so a transient provider failure (Meta down,
 * a network blip) costs exactly one skipped nudge, never a duplicate
 * one, and a second concurrent caller (two overlapping sweeps, a retry
 * racing the original) re-reads this same row, finds `nextFollowUpAt`
 * already moved past `now` (or the row no longer `"running"`), and
 * returns `false` — Convex's OCC serializes the two mutations, so
 * there is no window in which both can see the row as still claimable.
 * At-most-once, by construction — the same tradeoff
 * `claimFollowUpSlot` makes for the qualification engine's own
 * follow-ups.
 *
 * DELIBERATELY NARROW SCOPE, matching `claimFollowUpSlot`: this
 * re-checks `sequenceStatus` and the send-capability facts (config,
 * band, cap) — it does NOT re-check `conversation.archivedAt` or
 * `conversation.status`. `sequenceContext` (called instants earlier by
 * `sendSequenceStep`) already checked those and only returned `"send"`
 * because they were clear; a race in the handful of milliseconds
 * between that read and this claim is the same narrow, accepted window
 * `claimFollowUpSlot` has always had for its own equivalent fields.
 */
export const claimSequenceSlot = internalMutation({
  args: { analysisId: v.id("leadAnalyses") },
  handler: async (ctx, args): Promise<boolean> => {
    const row = await ctx.db.get(args.analysisId);
    if (!row || row.sequenceStatus !== "running") return false;
    const now = Date.now();
    if (!row.nextFollowUpAt || row.nextFollowUpAt > now) return false;

    const config = await loadEnabledConfig(ctx, row.accountId);
    if (!config) return false; // disabled since sequenceContext's own read

    const bandRule = config.bands.find((b) => b.key === row.band);
    if (!bandRule || row.followUpsSent >= bandRule.steps.length) return false;

    const qualConfig = await ctx.db
      .query("qualificationConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", row.accountId))
      .unique();
    if (!qualConfig) return false; // working hours became unknown

    const sendRateRow = await ctx.db
      .query("leadSequenceSendRate")
      .withIndex("by_account", (q) => q.eq("accountId", row.accountId))
      .unique();
    const sendRateState: SendRateState | null = sendRateRow
      ? { dayStartMs: sendRateRow.dayStartMs, count: sendRateRow.count }
      : null;
    const capCheck = claimSendSlot(
      sendRateState,
      now,
      qualConfig.utcOffsetMinutes,
      config.dailySendCap,
    );
    if (!capCheck.granted) return false;

    // Persist the spent budget BEFORE the send-side effects below — this
    // write and the `leadAnalyses` patch below commit in the same
    // transaction, so a crash here can never leave the budget claimed
    // without the corresponding rung booked, or vice versa.
    if (sendRateRow) {
      await ctx.db.patch(sendRateRow._id, capCheck.next);
    } else {
      await ctx.db.insert("leadSequenceSendRate", {
        accountId: row.accountId,
        ...capCheck.next,
      });
    }

    const sent = row.followUpsSent + 1;
    const upcomingStep = bandRule.steps[sent];
    const nextFollowUpAt = upcomingStep
      ? nextStepAt({
          lastFollowUpAt: now,
          delayDays: upcomingStep.delayDays,
          config: {
            utcOffsetMinutes: qualConfig.utcOffsetMinutes,
            workStartMinute: qualConfig.workStartMinute,
            workEndMinute: qualConfig.workEndMinute,
            workDays: qualConfig.workDays,
          },
        })
      : undefined; // no next step — see module header: an undefined
    // `nextFollowUpAt` still sorts inside `by_sequence_due`'s "<= now"
    // range, so the row is immediately due again and the NEXT sweep
    // tick resolves it to `archive`/`exhaust` via tier 3, rather than
    // it silently vanishing from the sweep forever.

    await ctx.db.patch(args.analysisId, {
      followUpsSent: sent,
      lastFollowUpAt: now,
      nextFollowUpAt,
    });
    return true;
  },
});

export const rescheduleSequenceRow = internalMutation({
  args: { analysisId: v.id("leadAnalyses"), at: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.analysisId);
    if (!row || row.sequenceStatus !== "running") return;
    await ctx.db.patch(args.analysisId, { nextFollowUpAt: args.at });
  },
});

export const stopSequenceRow = internalMutation({
  args: { analysisId: v.id("leadAnalyses"), reason: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.analysisId);
    if (!row) return;
    await ctx.db.patch(args.analysisId, {
      sequenceStatus: "stopped",
      stoppedReason: args.reason,
      nextFollowUpAt: undefined,
    });
  },
});

/** Fix 4 (whole-branch review): how far into the future a `reschedule`
 *  verdict defers a row, instead of the previous exact-`now` re-stamp.
 *  See `sendSequenceStep`'s `"reschedule"` case for the full reasoning
 *  and the anti-starvation argument. One hour is "modest" on purpose:
 *  long enough (4 cron ticks, at 15 minutes each) to meaningfully cut
 *  down on re-evaluating a reason that can't resolve that fast anyway
 *  (`daily_cap`, usually `outside_hours`), short enough that a reason
 *  which CAN resolve quickly (`agent_active`, `not_idle_yet`) is never
 *  delayed by more than this one fixed window past the moment it
 *  actually clears. Exported for the test suite's own assertions. */
export const SEQUENCE_RESCHEDULE_DEFER_MS = 60 * 60_000;

export const exhaustSequenceRow = internalMutation({
  args: { analysisId: v.id("leadAnalyses") },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.analysisId);
    if (!row) return;
    // Hot-band terminal state (spec's table: "Needs your decision") —
    // deliberately does NOT archive. See `evaluateSequence`'s own tier-3
    // comment for why exhaust and archive are separate verdicts.
    await ctx.db.patch(args.analysisId, {
      sequenceStatus: "exhausted",
      nextFollowUpAt: undefined,
    });
  },
});

export const sendSequenceStep = internalAction({
  args: { analysisId: v.id("leadAnalyses") },
  handler: async (ctx, args): Promise<void> => {
    const verdict = await ctx.runQuery(internal.leadAnalysisEngine.sequenceContext, {
      analysisId: args.analysisId,
    });

    switch (verdict.kind) {
      case "send": {
        if (!verdict.send) {
          // Guarded by `sequenceContext` itself (throws rather than
          // returning `send` without a payload) — unreachable in
          // practice, but never send blind.
          console.error(
            "[lead sequence] send verdict with no send payload:",
            args.analysisId,
          );
          return;
        }
        // Claim BEFORE the send (see `claimSequenceSlot`'s own comment):
        // losing the claim means another sender, or a state change,
        // already got here first — never send twice.
        const claimed = await ctx.runMutation(internal.leadAnalysisEngine.claimSequenceSlot, {
          analysisId: args.analysisId,
        });
        if (!claimed) {
          // Usually just a lost race (see `claimSequenceSlot`'s own
          // comment) — silent by design there. But there is one narrow
          // livelock this can also mean: a row sitting at
          // (`running`, `followUpsSent === band.steps.length`,
          // `nextFollowUpAt: undefined`) whose band's `steps` array
          // grows (a config edit) flips `sequenceContext`'s verdict from
          // `exhaust`/`archive` back to `send` — but the claim's own
          // `followUpsSent >= bandRule.steps.length` re-check no longer
          // agrees the moment the row's `followUpsSent` catches up, and
          // for band `key`/`steps.length` combinations where it doesn't,
          // this can refuse indefinitely. Always safe (never sends), but
          // otherwise silent — a `console.warn` at least makes a stuck
          // row observable instead of vanishing into "nothing happened".
          console.warn("[lead sequence] claim refused, not sending:", args.analysisId);
          return;
        }

        const meta = await ctx.runQuery(internal.leadAnalysisEngine.sequenceRowMeta, {
          analysisId: args.analysisId,
        });
        if (!meta) return; // row vanished between the claim and here
        try {
          await ctx.runAction(internal.metaSend.sendTemplate, {
            accountId: meta.accountId,
            conversationId: meta.conversationId,
            to: verdict.send.to,
            templateName: verdict.send.templateName,
            language: verdict.send.templateLanguage ?? undefined,
            contentText: verdict.send.contentText,
            senderType: "bot",
          });
        } catch (err) {
          // At-most-once by design: the slot is already spent
          // (`claimSequenceSlot`) — do NOT roll back the claim, since
          // retrying immediately is exactly how a flaky provider turns
          // into a double send.
          //
          // Fix 3 (whole-branch review, "a parameterised template
          // silently burns the cadence"): the claim ALSO already booked
          // the next rung before this send was even attempted — left
          // standing, a DURABLE failure (a template whose body needs
          // `params` this fixed-body send never supplies, Meta rejecting
          // it outright, any non-transient cause) would silently repeat
          // the identical failure at every future step, forever, with
          // nothing surfaced on the board, the preview, or the logs —
          // the one place the owner's "a rejected template stops that
          // lead loudly" decision wasn't honoured (it only ever covered
          // approval-time rejection, never a send-time one). Stop the
          // lead outright instead of leaving the next rung to fail the
          // same way again. A transient failure now costs the REST of
          // this lead's cadence rather than one skipped nudge — a
          // deliberate trade against a silent, indefinitely-repeating
          // failure with no operator-visible signal at all.
          console.error("[lead sequence] send failed:", args.analysisId, err);
          await ctx.runMutation(internal.leadAnalysisEngine.stopSequenceRow, {
            analysisId: args.analysisId,
            reason: "send_failed",
          });
        }
        return;
      }
      case "reschedule": {
        // No per-reason revisit math here (that would be policy
        // creeping out of `eligibility.ts`) — patch `nextFollowUpAt` to
        // a fixed, modest future offset, which leaves the row due again
        // soon without pretending to know exactly when its condition
        // resolves. The periodic sweep (Task 9's cron) re-evaluates it
        // fresh at that point; whichever condition caused the defer
        // (idle timer, agent activity, qualification's own clock,
        // closed hours, the daily cap) is re-checked from scratch every
        // time, so this never drifts from `evaluateSequence`'s own
        // answer.
        //
        // Fix 4 (whole-branch review, "the sweep re-runs its whole
        // slice every tick"): this used to re-stamp to EXACTLY `now`,
        // so a deferred row was fully re-evaluated on literally every
        // future sweep tick, forever — including for reasons
        // (`daily_cap`, often `outside_hours`) that provably cannot
        // resolve within one 15-minute cron interval. Stamping
        // `SEQUENCE_RESCHEDULE_DEFER_MS` into the future instead
        // removes the row from `by_sequence_due`'s range ENTIRELY for
        // that window, not merely reordering it — cheaper, and it
        // still can't delay a reason that genuinely does resolve
        // sooner (e.g. `agent_active`) by more than this one fixed
        // window, since the very next tick after it elapses picks the
        // row back up.
        //
        // DELIBERATELY kept as a fixed constant in this action layer,
        // not a per-reason `revisitAt` computed inside `evaluateSequence`
        // itself (the reviewer's own suggested alternative): that would
        // mean threading working-hours/cap schedule data into
        // `EligibilityInput`, a genuinely bigger change to a pure
        // 12-gate module whose five-tier ordering has already been
        // corrected three times (see that file's own header) — not
        // something to risk for this fix. A fixed, modest, well-
        // commented deferral here is the smaller, safer change.
        //
        // ANTI-STARVATION, preserved (and strengthened) from the
        // original "stamp to now" trick: that trick relied on the
        // deferred row merely sorting to the BACK of `by_sequence_due`'s
        // ascending order, so it still competed for a slot in the
        // bounded slice against genuinely-due rows (it just usually
        // lost, since a real backlog's `nextFollowUpAt` values are
        // historical and thus numerically smaller). Stamping a REAL
        // FUTURE time is strictly stronger: for the entire deferral
        // window the row isn't just sorted last, it is excluded from
        // `getDueSequenceRows`' `.lte(now)` range altogether, freeing
        // its slot in the (now smaller, 25-row) bounded slice for rows
        // that are actually ready — see the regression tests pinning
        // both properties.
        await ctx.runMutation(internal.leadAnalysisEngine.rescheduleSequenceRow, {
          analysisId: args.analysisId,
          at: Date.now() + SEQUENCE_RESCHEDULE_DEFER_MS,
        });
        return;
      }
      case "stop": {
        await ctx.runMutation(internal.leadAnalysisEngine.stopSequenceRow, {
          analysisId: args.analysisId,
          reason: verdict.reason,
        });
        return;
      }
      case "exhaust": {
        await ctx.runMutation(internal.leadAnalysisEngine.exhaustSequenceRow, {
          analysisId: args.analysisId,
        });
        return;
      }
      case "archive": {
        const meta = await ctx.runQuery(internal.leadAnalysisEngine.sequenceRowMeta, {
          analysisId: args.analysisId,
        });
        if (!meta) return;
        // Task 5's shared archive core, reason `no_response` — the
        // sequence's own auto-archive, not a human action.
        await ctx.runMutation(internal.leadAnalysis.archiveAutomated, {
          accountId: meta.accountId,
          conversationId: meta.conversationId,
          reason: "no_response",
        });
        await ctx.runMutation(internal.leadAnalysisEngine.stopSequenceRow, {
          analysisId: args.analysisId,
          reason: "archived",
        });
        return;
      }
    }
  },
});

/** Bounded slice per sweep tick. Fix 4 (whole-branch review, "the sweep
 *  re-runs its whole slice every tick"): dropped from 100 to 25 — the
 *  cron runs every 15 minutes, so 100/tick was 9,600 row-evaluations/day
 *  against a 100/day account-wide send cap, buying nothing but wasted
 *  reads and action-call overhead. Exported for the test suite's own
 *  assertion, so a future change to this number can't silently drift
 *  from what the tests actually pin. */
export const SEQUENCE_SWEEP_LIMIT = 25;

/** `by_sequence_due` binds `sequenceStatus` before `nextFollowUpAt`, so
 *  this is a genuine index range over the running partition — never a
 *  scan. An absent `nextFollowUpAt` (a row `claimSequenceSlot` just
 *  exhausted) sorts before every defined value and so is included by
 *  `.lte(now)` — see `claimSequenceSlot`'s own comment on why that is
 *  load-bearing, not incidental. */
export const getDueSequenceRows = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"leadAnalyses">[]> => {
    const now = Date.now();
    return await ctx.db
      .query("leadAnalyses")
      .withIndex("by_sequence_due", (q) =>
        q.eq("sequenceStatus", "running").lte("nextFollowUpAt", now),
      )
      .take(SEQUENCE_SWEEP_LIMIT);
  },
});

export const sweepLeadSequence = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const due = await ctx.runQuery(internal.leadAnalysisEngine.getDueSequenceRows, {});
    // Per-row isolation (mirrors `sweepScoring`'s own try/catch, same
    // file): one bad lead — a deleted conversation, a tenancy mismatch,
    // any throw surfacing out of `sequenceContext` or the mutations
    // `sendSequenceStep` calls — must never strand the rest of this
    // slice. `sendSequenceStep`'s own try/catch already isolates the
    // provider call itself (a failed SEND never rolls back the claim);
    // this catches everything else that can throw further up the chain,
    // so one poisoned row is skipped and logged rather than aborting
    // every row after it, every sweep, indefinitely.
    //
    // DELIBERATE DIVERGENCE from `qualificationEngine.sweepFollowUps`
    // (which fans each due row out via `ctx.scheduler.runAfter(0, ...)`
    // instead): this sweep `await`s `sendSequenceStep` INLINE, one row
    // at a time. Scheduling all of them for the same instant would let
    // Convex run several `claimSequenceSlot` calls for the SAME
    // account concurrently, and every one of them reads-then-writes
    // that account's single `leadSequenceSendRate` row — manufacturing
    // OCC contention (and retries) on that row for no benefit, since
    // the daily cap is account-wide, not per-row, and needs the claims
    // serialized against each other anyway. Processing the slice
    // in-line already gives that serialization for free.
    for (const row of due) {
      try {
        await ctx.runAction(internal.leadAnalysisEngine.sendSequenceStep, {
          analysisId: row._id,
        });
      } catch (error) {
        console.error(
          "[lead sequence] sendSequenceStep failed for row:",
          row._id,
          error,
        );
      }
    }
  },
});

/** Attempts before a row is retired out of the sweep partition. */
const MAX_SCORE_ATTEMPTS = 3;
/**
 * How long a claimed row is hidden from a concurrent sweep. MUST exceed
 * the sweep's worst case: up to `scorePerRun` (default 25, see
 * `defaults.ts`) sequential provider calls, each bounded by
 * `aiRequestTimeoutMs()` (default 30s, see `lib/ai/defaults.ts`) —
 * 25 * 30s = 12.5 minutes, which is also past Convex's action time
 * limit. A lease shorter than that (the previous value here, 10 min)
 * means a sweep degraded by a slow/timing-out provider gets killed with
 * its tail still leased, and those rows re-enter the pending partition
 * almost immediately, compounding the load that caused the slowdown.
 * Set well above the worst case so this can't happen. If `scorePerRun`'s
 * default or the request timeout ever changes, re-check this still
 * clears their product with room to spare — the two are coupled even
 * though nothing enforces it in code.
 */
const CLAIM_LEASE_MS = 20 * 60_000;
/** Retry backoff per attempt: 5 min, 20 min, … */
const BACKOFF_BASE_MS = 5 * 60_000;
const ERROR_MAX_CHARS = 300;

/**
 * Take the next due rows and LEASE them: `rescoreDueAt` is pushed out by
 * `CLAIM_LEASE_MS` so a sweep that overlaps a slow predecessor cannot
 * claim the same row and pay for the same LLM call twice. A crash mid-
 * scoring costs one lease of latency, never a lost row.
 *
 * `by_score_due` binds `scoreStatus` before `rescoreDueAt`, so this is a
 * genuine index range over the pending partition — never a `.filter()`
 * across the scored/failed rows, which grow forever.
 */
export const claimDueForScoring = internalMutation({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const due = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_score_due", (q) =>
        q.eq("scoreStatus", "pending").lte("rescoreDueAt", now),
      )
      .take(args.limit);

    const claimed: {
      analysisId: Id<"leadAnalyses">;
      accountId: Id<"accounts">;
      conversationId: Id<"conversations">;
    }[] = [];

    for (const row of due) {
      await ctx.db.patch(row._id, { rescoreDueAt: now + CLAIM_LEASE_MS });
      claimed.push({
        analysisId: row._id,
        accountId: row.accountId,
        conversationId: row.conversationId,
      });
    }
    return claimed;
  },
});

/**
 * Backoff applied to a released, disabled-account row (Fix B, final
 * whole-branch review). The previous behaviour re-dued the row
 * IMMEDIATELY (`rescoreDueAt: Date.now()`), so an account disabled
 * AFTER accumulating a backlog had every one of its rows claimed and
 * released again on EVERY 5-minute sweep forever (`crons.ts`'s
 * `lead-scoring` interval) — ~300 writes/hour spent on an account that
 * isn't going anywhere, and those claim slots (`claimDueForScoring`'s
 * bounded `scorePerRun`) came out of the same pool enabled accounts
 * share. A released row is never urgent by definition: it was released
 * BECAUSE its account is disabled, and a disabled account does not
 * resolve itself within seconds — there is no reason to reconsider it
 * before a human re-enables it. 30 minutes is long enough to kill the
 * churn while still bounded (never leased indefinitely — the row stays
 * in the pending partition with a concrete due time throughout).
 */
const DISABLED_RELEASE_BACKOFF_MS = 30 * 60_000;
/**
 * Backoff applied to a released, over-cap row (Fix B). This is a
 * DIFFERENT case from the disabled-account release above: the account
 * is still enabled, and it is legitimately due again soon — the row was
 * only released because its account's own `scorePerRun` cap was already
 * hit THIS sweep (Fix 3), not because anything about the row or account
 * is wrong. The very next sweep, `crons.ts`'s `lead-scoring` interval
 * (5 minutes) away, should pick it up rather than waiting out the full
 * disabled-account backoff — so this uses a much shorter one, matched to
 * that cadence, instead of reusing `DISABLED_RELEASE_BACKOFF_MS`.
 */
const OVER_CAP_RELEASE_BACKOFF_MS = 5 * 60_000;

/**
 * Undo a claim's lease without touching the row's failure state. Used
 * when a claimed row turns out to belong to a currently-disabled account
 * (Fix 2: `enabled: false` must be a real kill switch even for rows
 * already claimed before the owner flipped it) or falls outside its
 * account's per-run `scorePerRun` cap (Fix 3). Either way NO LLM call
 * was spent, so the row must not be retired (`recordScoreFailure`) or
 * lose attempt budget. It goes back to the pending partition with a
 * concrete future due time — never immediately due again (Fix B: that
 * was the churn bug on a disabled account) and never left un-due
 * indefinitely either. `reason` picks the backoff: see
 * `DISABLED_RELEASE_BACKOFF_MS` / `OVER_CAP_RELEASE_BACKOFF_MS` above
 * for why the two cases deliberately differ.
 */
export const releaseClaim = internalMutation({
  args: {
    analysisId: v.id("leadAnalyses"),
    reason: v.union(v.literal("disabled"), v.literal("overCap")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.analysisId);
    if (!row) return;
    const backoffMs =
      args.reason === "disabled" ? DISABLED_RELEASE_BACKOFF_MS : OVER_CAP_RELEASE_BACKOFF_MS;
    await ctx.db.patch(args.analysisId, { rescoreDueAt: Date.now() + backoffMs });
  },
});

/** Persist a completed scoring verdict and leave the sweep partition. */
export const applyScore = internalMutation({
  args: {
    analysisId: v.id("leadAnalyses"),
    score: v.number(),
    reason: v.string(),
    signals: v.array(v.string()),
    model: v.string(),
    throughMs: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.analysisId);
    if (!row) return;
    const config = await loadEnabledConfig(ctx, row.accountId);
    const bands = (config ?? defaultLeadAnalysisConfig()).bands;

    // Cache the service name alongside the verdict so the board doesn't
    // run a per-row `qualificationSessions` query. DISPLAY ONLY —
    // nothing branches on it — and refreshed on every re-score, so it
    // tracks the session rather than freezing at first score.
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
      .order("desc")
      .first();

    await ctx.db.patch(args.analysisId, {
      score: args.score,
      band: bandForScore(args.score, bands) ?? undefined,
      reason: args.reason,
      signals: args.signals,
      model: args.model,
      scoredAt: Date.now(),
      scoredThroughMs: args.throughMs,
      scoreStatus: "scored",
      rescoreDueAt: undefined,
      attempts: 0,
      lastError: undefined,
      serviceName: session?.serviceName ?? undefined,
    });
  },
});

/**
 * The dedup short-circuit: the thread carries no new content since the
 * last verdict, so the previous score stands and no LLM call is spent.
 */
export const markUnchanged = internalMutation({
  args: { analysisId: v.id("leadAnalyses"), throughMs: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.analysisId, {
      scoreStatus: "scored",
      scoredThroughMs: args.throughMs,
      rescoreDueAt: undefined,
      attempts: 0,
      // A row that failed earlier, then re-armed and dedup-short-circuited
      // here, must not keep a stale error string on a "scored" row forever
      // — `lastError` is what the owner reads when debugging cost.
      lastError: undefined,
    });
  },
});

/** Not a lead (no customer message ever). Terminal, and out of the
 *  sweep partition — re-armed only if a customer eventually writes in. */
export const markSkipped = internalMutation({
  args: { analysisId: v.id("leadAnalyses") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.analysisId, {
      scoreStatus: "skipped",
      rescoreDueAt: undefined,
    });
  },
});

/**
 * Back off, then retire. A retired row moves to "failed" and clears
 * `rescoreDueAt`, so it LEAVES the pending partition rather than
 * accumulating at its front — the failure mode `conversionEvents` and
 * `campaignAds` both document in schema.ts.
 */
export const recordScoreFailure = internalMutation({
  args: { analysisId: v.id("leadAnalyses"), error: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.analysisId);
    if (!row) return;
    const attempts = row.attempts + 1;
    const lastError = args.error.slice(0, ERROR_MAX_CHARS);

    if (attempts >= MAX_SCORE_ATTEMPTS) {
      await ctx.db.patch(args.analysisId, {
        scoreStatus: "failed",
        attempts,
        lastError,
        rescoreDueAt: undefined,
      });
      return;
    }

    await ctx.db.patch(args.analysisId, {
      scoreStatus: "pending",
      attempts,
      lastError,
      rescoreDueAt: Date.now() + BACKOFF_BASE_MS * Math.pow(4, attempts - 1),
    });
  },
});

/** How much transcript the scorer reads. Bounded: the cost of a score
 *  must not grow with the length of a long-running chat. */
const TRANSCRIPT_LIMIT = 40;

/** Everything one scoring call needs, in a single indexed read. */
export const loadScoreInput = internalQuery({
  args: { analysisId: v.id("leadAnalyses") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.analysisId);
    if (!row) return null;

    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
      .order("desc")
      .take(TRANSCRIPT_LIMIT);
    const messages = [...recent].reverse();

    // A thread nobody wrote into is not a lead — the board never shows it
    // and no LLM call is spent on it.
    const hasCustomerMessage = messages.some((m) => m.senderType === "customer");

    const contact = await ctx.db.get(row.contactId);
    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", row.conversationId))
      .order("desc")
      .first();
    const services = await ctx.db
      .query("kbServices")
      .withIndex("by_account", (q) => q.eq("accountId", row.accountId))
      .take(50);

    // Task 9 (P3): the team's own notes, real text — see `agentNotes`'s
    // doc comment in `prompt.ts` for why this job (unlike the reply bot)
    // is allowed the raw wording. Newest-first off the index, capped at
    // `formatNotesForScoring`'s own `SCORING_NOTES_MAX` — shared, not
    // duplicated, so the read cap and the emit cap can never drift apart.
    const notes = await ctx.db
      .query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", row.contactId))
      .order("desc")
      .take(SCORING_NOTES_MAX);

    // Existence-only check: whether the account even HAS an active AI
    // config. Deliberately NOT `internal.aiConfig.loadDecrypted` — that
    // query unconditionally decrypts `apiKey`, which is exactly the
    // provider call this function must stay free of under
    // `CONVEX_AI_DRY_RUN` (the sweep still needs to know "is this
    // account configured at all" without ever touching a real or
    // synthetic ciphertext).
    const aiConfigRow = await ctx.db
      .query("aiConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", row.accountId))
      .first();
    const hasActiveAiConfig = !!aiConfigRow && aiConfigRow.isActive;

    return {
      accountId: row.accountId,
      conversationId: row.conversationId,
      hasCustomerMessage,
      hasActiveAiConfig,
      // Dedup key material: the `_creationTime` of the newest message in
      // the fetched slice (already sorted oldest-first above), or `null`
      // when the conversation has no messages at all. Derived from the
      // rows already read here — never a second query.
      newestMessageAt: messages.length > 0 ? messages[messages.length - 1]._creationTime : null,
      scoredThroughMs: row.scoredThroughMs ?? null,
      // NOTE the field name: `HistoryMessage.transcription`, NOT
      // `aiTranscription` (which is the raw column name on `messages`).
      // See convex/lib/ai/context.ts:53.
      chat: toChatMessages(
        messages.map((m) => ({
          senderType: m.senderType,
          contentText: m.contentText,
          contentType: m.contentType,
          transcription: m.aiTranscription,
        })),
      ),
      serviceName: session?.serviceName ?? null,
      services: services.map((s) => s.name),
      agentNotes: formatNotesForScoring(notes),
      contact: {
        ...(contact?.name ? { name: contact.name } : {}),
        ...(contact?.travelDates ? { travelDates: contact.travelDates } : {}),
        ...(contact?.travelers ? { travelers: contact.travelers } : {}),
        ...(contact?.budget ? { budget: contact.budget } : {}),
        ...(contact?.preferredDestination
          ? { preferredDestination: contact.preferredDestination }
          : {}),
      },
    };
  },
});

/** Deterministic stand-in so tests never reach a provider — the same
 *  `CONVEX_AI_DRY_RUN` convention `aiReply.ts` uses. */
function isDryRun(): boolean {
  return !!process.env.CONVEX_AI_DRY_RUN;
}

/**
 * The scoring sweep. Claims a bounded slice of due rows, scores each in
 * turn, and writes the verdict back. Every row is independently
 * try/caught: one bad conversation can never abort the sweep and strand
 * the rest of the slice behind it.
 *
 * The AI-config-existence check runs BEFORE the dry-run branch (unlike
 * a naive "dry run skips everything" reading): a row with no active
 * config is a genuine failure to surface and retry even under
 * `CONVEX_AI_DRY_RUN` — dry run only stands in for the PROVIDER call
 * (`generateReply`, via the real, decrypting `aiConfig.loadDecrypted`),
 * never for "is this account even configured to score." That existence
 * check is `loadScoreInput`'s `hasActiveAiConfig`, deliberately NOT
 * `aiConfig.loadDecrypted` at this point — the latter unconditionally
 * decrypts `apiKey`, which would blow up under dry run against a
 * config row seeded with an unencrypted placeholder key (see
 * `seedAiConfig`'s `"unused-under-dry-run"` in the test file: it is
 * never meant to reach `decrypt()`).
 *
 * Two config knobs are enforced per CLAIMED ROW below, not per row read
 * from `leadAnalysisConfigs` directly — `configFor` resolves and caches
 * each distinct `accountId` at most ONCE per sweep, since a single
 * `scorePerRun`-sized claim can span many accounts and re-querying the
 * config table per row would turn a bounded read into an unbounded one:
 *
 *  - Fix 2 (kill switch): `enabled: false` must stop a row that was
 *    already claimed before the owner flipped it. No LLM call is spent
 *    and the row is released (`releaseClaim`), never retired — a
 *    disabled account may be re-enabled and this must not cost it an
 *    attempt.
 *  - Fix 3 (per-account `scorePerRun`): the claim's SIZE below is
 *    necessarily bounded by the platform DEFAULT `scorePerRun` — the
 *    claim ranges the GLOBAL `by_score_due` partition across every
 *    enabled account in one shot, so there is no single account's config
 *    to read yet at that point. Each account's OWN `scorePerRun` is
 *    instead enforced here, as a per-account cap on how many of ITS
 *    claimed rows are actually processed in this sweep — an admin
 *    lowering it throttles their spend on the very next sweep even
 *    though the claim size itself didn't change.
 */
export const sweepScoring = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const claimed = await ctx.runMutation(
      internal.leadAnalysisEngine.claimDueForScoring,
      { limit: defaultLeadAnalysisConfig().scorePerRun },
    );

    // Live rows always drain first: backfill only runs on an idle sweep,
    // so a fresh lead never waits behind historical work.
    if (claimed.length === 0) {
      const accounts = await ctx.runQuery(
        internal.leadAnalysisEngine.enabledAccountIds,
        {},
      );
      for (const accountId of accounts) {
        // Fix 3: `backfillPerRun` is straightforwardly per-account (no
        // cross-account claim to reconcile it against) — read this
        // account's own row instead of the platform default.
        const config = await ctx.runQuery(
          internal.leadAnalysisEngine.enabledConfigForAccount,
          { accountId },
        );
        if (!config) continue; // disabled between the list read and here
        // Fix C (final whole-branch review): isolate one account's
        // backfill failure — same spirit as the per-row try/catch below
        // (a single bad row/account can never abort the sweep and
        // strand everything behind it). The known throwing case is an
        // oversized tie-group at a single `lastMessageAt` exceeding
        // Convex's per-transaction limits (deferred: needs pagination,
        // not fixed here); without this try/catch that throw would
        // propagate out of `sweepScoring` and skip every account AFTER
        // the poisoned one, every sweep, indefinitely.
        try {
          await ctx.runMutation(internal.leadAnalysisEngine.backfillAccount, {
            accountId,
            limit: config.backfillPerRun,
          });
        } catch (error) {
          console.error(
            "[lead analysis backfill] backfillAccount failed for account:",
            accountId,
            error,
          );
        }
      }
      return;
    }

    type EnabledConfig = Awaited<ReturnType<typeof loadEnabledConfig>>;
    const configCache = new Map<Id<"accounts">, EnabledConfig>();
    async function configFor(accountId: Id<"accounts">): Promise<EnabledConfig> {
      if (!configCache.has(accountId)) {
        configCache.set(
          accountId,
          await ctx.runQuery(internal.leadAnalysisEngine.enabledConfigForAccount, {
            accountId,
          }),
        );
      }
      return configCache.get(accountId) ?? null;
    }
    // Rows actually processed per account THIS sweep, for the
    // `scorePerRun` cap (Fix 3).
    const processedPerAccount = new Map<Id<"accounts">, number>();

    for (const { analysisId, accountId } of claimed) {
      const config = await configFor(accountId);

      // Fix 2: disabled account — release, never retire, never call.
      if (!config) {
        await ctx.runMutation(internal.leadAnalysisEngine.releaseClaim, {
          analysisId,
          reason: "disabled",
        });
        continue;
      }

      // Fix 3: over this account's own per-run cap — release rather than
      // score, so a later sweep (still respecting the same cap) picks it
      // up instead of it being lost or unfairly retried ahead of others.
      const processedSoFar = processedPerAccount.get(accountId) ?? 0;
      if (processedSoFar >= config.scorePerRun) {
        await ctx.runMutation(internal.leadAnalysisEngine.releaseClaim, {
          analysisId,
          reason: "overCap",
        });
        continue;
      }
      processedPerAccount.set(accountId, processedSoFar + 1);

      try {
        const input = await ctx.runQuery(internal.leadAnalysisEngine.loadScoreInput, {
          analysisId,
        });
        if (!input) continue;

        if (!input.hasCustomerMessage) {
          await ctx.runMutation(internal.leadAnalysisEngine.markSkipped, { analysisId });
          continue;
        }

        // Guard: `hasCustomerMessage` above guarantees at least one
        // message exists, so `newestMessageAt` should be unreachable as
        // `null` here. Never write `null` as a score-through value
        // regardless — treat it as a genuine failure to retry rather
        // than silently corrupting the dedup key.
        if (input.newestMessageAt === null) {
          await ctx.runMutation(internal.leadAnalysisEngine.recordScoreFailure, {
            analysisId,
            error: "no messages found despite hasCustomerMessage",
          });
          continue;
        }
        const throughMs = input.newestMessageAt;

        // Dedup: the newest message hasn't moved since the last verdict
        // — the previous score stands and no call is spent. This key is
        // a TIMESTAMP, not a message count, so it never saturates even
        // once the transcript slice hits TRANSCRIPT_LIMIT.
        if (input.scoredThroughMs !== null && input.scoredThroughMs === throughMs) {
          await ctx.runMutation(internal.leadAnalysisEngine.markUnchanged, {
            analysisId,
            throughMs,
          });
          continue;
        }

        if (!input.hasActiveAiConfig) {
          await ctx.runMutation(internal.leadAnalysisEngine.recordScoreFailure, {
            analysisId,
            error: "ai_config missing or inactive",
          });
          continue;
        }

        const scoreInstructions = await ctx.runQuery(
          internal.agentInstructions.forAgent,
          { accountId: input.accountId, agentKey: "score" },
        );
        const systemPrompt = buildScoreSystemPrompt(
          {
            serviceName: input.serviceName,
            services: input.services,
            contact: input.contact,
            agentNotes: input.agentNotes,
          },
          scoreInstructions,
        );

        if (isDryRun()) {
          await ctx.runMutation(internal.leadAnalysisEngine.applyScore, {
            analysisId,
            score: 5,
            reason: "Dry-run synthetic score",
            signals: [],
            model: "dry-run",
            throughMs,
          });
          continue;
        }

        const aiConfig = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
          accountId: input.accountId,
        });
        if (!aiConfig || !aiConfig.isActive) {
          await ctx.runMutation(internal.leadAnalysisEngine.recordScoreFailure, {
            analysisId,
            error: "ai_config missing or inactive",
          });
          continue;
        }

        // Scoring returns `{"score":…,"reason":…,"signals":[…]}` into
        // `parseScoreResponse` — machine-read, so the cheap judge tier
        // with reasoning off. This matters more here than anywhere else:
        // the sweep runs every 5 minutes at 25 conversations per run.
        const model = aiJudgeModel(aiConfig.provider, aiConfig.model);
        const result = await generateReply({
          provider: aiConfig.provider,
          model,
          apiKey: aiConfig.apiKey,
          systemPrompt,
          // NOT `input.chat` directly — see `withScoringInstruction`'s own
          // doc comment for why a trailing assistant turn (every
          // "awaiting them" lead) must never reach the provider bare.
          messages: withScoringInstruction(input.chat),
          reasoningEffort: aiJudgeReasoningEffort(),
          promptCacheKey: promptCacheKey(input.accountId, "score"),
        });

        const parsed = parseScoreResponse(result.text);
        if (!parsed) {
          await ctx.runMutation(internal.leadAnalysisEngine.recordScoreFailure, {
            analysisId,
            error: `unparseable response: ${result.text.slice(0, 120)}`,
          });
          continue;
        }

        await ctx.runMutation(internal.leadAnalysisEngine.applyScore, {
          analysisId,
          score: parsed.score,
          reason: parsed.reason,
          signals: parsed.signals,
          model,
          throughMs,
        });

        if (result.usage) {
          await ctx.runMutation(internal.aiUsage.log, {
            accountId: input.accountId,
            conversationId: input.conversationId,
            mode: "score",
            provider: aiConfig.provider,
            model,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            cachedPromptTokens: result.usage.cachedPromptTokens,
            reasoningTokens: result.usage.reasoningTokens,
          });
        }
      } catch (error) {
        await ctx.runMutation(internal.leadAnalysisEngine.recordScoreFailure, {
          analysisId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  },
});

const BACKFILL_COUNTER = "leadAnalysisBackfill";

/**
 * Enqueue historical conversations that have no analysis row yet.
 *
 * "Has no row" is NOT an indexable predicate on `conversations`, so a
 * naive backfill rescans from the newest conversation every run and
 * walks further each time — the unbounded-scan shape schema.ts warns
 * about throughout. Instead this keeps a per-account CURSOR in
 * `counters` (the `lastMessageAt` of the last conversation enqueued) and
 * resumes strictly below it, so the account is walked exactly once, in
 * bounded slices.
 *
 * Fix 5 (final whole-branch review): the main batch below still resumes
 * with `.lt` (strictly below the cursor) — NOT `.lte` — because `.lte`
 * would re-include the previous batch's own tail conversation on every
 * subsequent call (the new cursor is always exactly that conversation's
 * own `lastMessageAt`), which never advances when nothing else remains
 * and leaves `done` permanently false. The real bug `.lt` alone has is
 * different: another conversation can share the batch's tail timestamp
 * EXACTLY without being in the batch (`take(limit)` cut it off first,
 * routine after a bulk import stamps a whole slice with one instant),
 * and `.lt` on the next call excludes that timestamp forever, skipping
 * it permanently. The straggler drain below closes exactly that gap: it
 * fetches every conversation at the batch's tail timestamp via a plain
 * equality read (bounded by the size of that one tie group, not the
 * account's history) and enqueues whichever of them the batch didn't
 * already cover, BEFORE the cursor moves past that timestamp — so by the
 * time `.lt(newCursor)` runs next, everything at `newCursor` is already
 * accounted for and can never resurface.
 *
 * KNOWN LIMITATION (documented, not fixed here): the claim that the
 * cursor "strictly decreases every non-empty call" is only true when at
 * least one conversation in the batch has a defined `lastMessageAt`
 * below the current cursor. `lastMessageAt` is `v.optional` on
 * `conversations` (schema.ts), and `lowest = conversation.lastMessageAt
 * ?? lowest` leaves `lowest` — and therefore the persisted cursor —
 * UNCHANGED whenever a whole batch is message-less conversations with no
 * `lastMessageAt` at all. In that case `done` (`batch.length === 0`)
 * never becomes true for the account, and the same message-less batch
 * is refetched on every subsequent call. This is bounded and harmless in
 * practice — `enqueueIfNew` is idempotent (`by_conversation` existence
 * check), so nothing is double-enqueued and no LLM cost is spent — but
 * the account's backfill genuinely never reports `done` in this case.
 * Fixing it needs a secondary tiebreaker (e.g. `_creationTime` or
 * `_id`) so the cursor can still advance across an all-absent-timestamp
 * batch; deferred.
 */
export const backfillAccount = internalMutation({
  args: { accountId: v.id("accounts"), limit: v.number() },
  handler: async (ctx, args) => {
    const config = await loadEnabledConfig(ctx, args.accountId);
    if (!config || !config.backfillEnabled) return { enqueued: 0, done: true };

    const counter = await ctx.db
      .query("counters")
      .withIndex("by_account_name", (q) =>
        q.eq("accountId", args.accountId).eq("name", BACKFILL_COUNTER),
      )
      .unique();

    // value 0 = never run: start above every real timestamp.
    const cursor = counter && counter.value > 0 ? counter.value : Number.MAX_SAFE_INTEGER;

    const batch = await ctx.db
      .query("conversations")
      .withIndex("by_account_last_message", (q) =>
        q.eq("accountId", args.accountId).lt("lastMessageAt", cursor),
      )
      .order("desc")
      .take(args.limit);

    let enqueued = 0;
    let lowest = cursor;

    async function enqueueIfNew(conversation: {
      _id: Id<"conversations">;
      contactId: Id<"contacts">;
      archivedAt?: number;
    }) {
      const existing = await ctx.db
        .query("leadAnalyses")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
        .unique();
      if (existing) return;

      await ctx.db.insert("leadAnalyses", {
        accountId: args.accountId,
        conversationId: conversation._id,
        contactId: conversation.contactId,
        // SYNC INVARIANT (schema.ts, `leadAnalyses.archived`): this is the
        // HIGHEST-RISK insert site — the backfill walks the account's
        // whole history, and once archiving is in use a large share of
        // those conversations will already be archived. Mirror
        // `archivedAt` at enqueue time rather than defaulting to active.
        archived: archivedForInsert(conversation),
        scoreStatus: "pending",
        // Due immediately: backfill rows are already old, and the sweep
        // drains live rows first anyway.
        rescoreDueAt: Date.now(),
        attempts: 0,
        sequenceStatus: "idle",
        followUpsSent: 0,
      });
      enqueued++;
    }

    for (const conversation of batch) {
      lowest = conversation.lastMessageAt ?? lowest;
      await enqueueIfNew(conversation);
    }

    // Straggler drain (Fix 5): before the cursor moves to `lowest`, make
    // sure EVERY conversation at that exact timestamp — not just the
    // ones `take(limit)` happened to include — is accounted for. A plain
    // equality read, so it costs nothing beyond the tie group's own size
    // on the (usual) case where nothing actually ties.
    if (batch.length > 0) {
      const tiedAtLowest = await ctx.db
        .query("conversations")
        .withIndex("by_account_last_message", (q) =>
          q.eq("accountId", args.accountId).eq("lastMessageAt", lowest),
        )
        .collect();
      const batchIds = new Set(batch.map((c) => c._id));
      for (const conversation of tiedAtLowest) {
        if (batchIds.has(conversation._id)) continue; // already handled above
        await enqueueIfNew(conversation);
      }
    }

    if (batch.length > 0) {
      if (counter) await ctx.db.patch(counter._id, { value: lowest });
      else {
        await ctx.db.insert("counters", {
          accountId: args.accountId,
          name: BACKFILL_COUNTER,
          value: lowest,
        });
      }
    }

    return { enqueued, done: batch.length === 0 };
  },
});

/** Accounts with the feature switched on. Bounded: one small row per
 *  account, and only accounts that opted in are ever swept. */
export const enabledAccountIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("leadAnalysisConfigs").take(200);
    return rows.filter((r) => r.enabled).map((r) => r.accountId);
  },
});
