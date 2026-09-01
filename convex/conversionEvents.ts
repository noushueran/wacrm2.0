import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { resolveEventName, backendForLane, resolveLeadStage } from "./lib/funnel";
import { hashedPhone, hashedEmail } from "./lib/metaHash";
import {
  applyStageTransition,
  recordConversionEventInRollup,
  moveConversionEventStatusInRollup,
} from "./funnel";
import { accountQuery } from "./lib/auth";
import { decrypt } from "./lib/whatsappEncryption";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";
export const MAX_DELIVER_ATTEMPTS = 5;

/**
 * The transient lane's own budget + backoff. A transient failure (429/5xx/
 * network) doesn't spend `attempts` — but "free" retries with no gate were the
 * livelock: a persistently-5xx row was re-selected every 15-minute tick
 * forever, and 100 of them filled the oldest-first error window so no pending
 * row was ever reached again. Now each transient failure bumps its OWN
 * counter and pushes `nextAttemptAt` out exponentially; the budget's worst
 * case (4 doubling steps + 16 capped waits ≈ 4.4 days) still fits inside
 * Meta CAPI's 7-day `event_time` acceptance window, so a row that survives
 * a long outage is still worth delivering when it finally sends.
 */
export const MAX_TRANSIENT_DELIVER_ATTEMPTS = 20;
const TRANSIENT_BACKOFF_BASE_MS = 15 * 60 * 1000; // one cron tick
const TRANSIENT_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

function transientBackoffMs(transientAttempts: number): number {
  return Math.min(
    TRANSIENT_BACKOFF_BASE_MS * 2 ** (transientAttempts - 1),
    TRANSIENT_BACKOFF_CAP_MS,
  );
}

/** Rows per pass of `migrateDormantOutOfAbandoned`'s cursor walk. */
const MIGRATE_BATCH = 512;

/**
 * Delay between each `deliverConversionEvent` the retry cron schedules. The
 * cron pulls up to 100 rows every 15 minutes and every one of them is an
 * external Graph POST; firing them all at `runAfter(0)` is a 100-call burst
 * that draws 429s from the very backend we're delivering to. Mirrors
 * `broadcasts.ts`'s `DELIVER_STAGGER_MS` — same reasoning, same ~10/s steady
 * state: Convex's scheduler already IS the queue, so a flat per-row interval
 * is all it takes.
 */
const DELIVER_STAGGER_MS = 100;

/**
 * A 429 or 5xx is the backend telling us to come back later — it says nothing
 * about the row itself, so spending an attempt on it is what let a burst of
 * our own making walk a live conversion to the terminal `"abandoned"` state.
 * Carried as its own Error subclass rather than parsed back out of the message
 * text, so the classification can't drift from the status that set it.
 */
class TransientDeliveryError extends Error {}

/**
 * Everything else with an HTTP status (a 4xx, a malformed body) is the row's
 * own fault: it bumps `attempts` and can legitimately exhaust the budget and
 * give up. A failure with NO status (reset/timeout — the fetch itself threw)
 * is wrapped as transient at the call site: it's the failure mode most likely
 * to be self-inflicted by our own send burst, and burning the permanent
 * budget on it let 5 connection resets destroy a conversion a 503 would have
 * survived.
 */
function deliveryError(status: number, message: string): Error {
  return status === 429 || status >= 500
    ? new TransientDeliveryError(message)
    : new Error(message);
}

/** The fetch call itself threw — no HTTP status to classify on. Transient. */
function networkError(err: unknown): TransientDeliveryError {
  return new TransientDeliveryError(
    `network: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/**
 * The row-identifying half of a `logDelivery` line. Split out so every
 * call site names the same fields — and, more to the point, so no call
 * site is free to reach for `row.phone` or `row.identifier` while
 * assembling one.
 */
function logFieldsFor(row: Doc<"conversionEvents">) {
  return {
    // Identity of the ROW, not of the person. `crmLeadId` is the
    // conversation id, which is what correlates a Meta-side diagnostic
    // back to a thread in this CRM without carrying anything about who
    // the customer is.
    crmLeadId: row.conversationId as string,
    eventId: row.eventId,
    eventName: row.eventName,
    // `leadStage` is the MQL/SQL/Converted label. It is the field that
    // makes these lines answerable for "which lifecycle step is
    // failing", which is the whole reason the lead-quality work sends
    // it to Meta in `custom_data` — see `lib/funnel.ts`.
    leadStage: resolveLeadStage(row.stage),
    backend: row.backend,
    lane: row.lane,
    stage: row.stage,
    eventTime: Math.floor(row._creationTime / 1000),
    attempt: row.attempts + 1,
    // Transient failures spend a SEPARATE budget from permanent ones
    // (see `errorPatchFor`), so a line that reports only `attempt`
    // cannot explain why a row is still queued after many tries.
    transientAttempt: row.transientAttempts ?? 0,
  };
}

/**
 * One structured line per delivery attempt, for reading the pipeline in
 * the Convex logs rather than only in the Conversions tab (which shows
 * current state, not the sequence that produced it).
 *
 * WHAT IS DELIBERATELY ABSENT is the point of this function existing at
 * all rather than callers writing their own `console.log`: no access
 * token, no raw phone or email, no `ctwa_clid`, and no request/response
 * body. `eventId` is `${conversationId}:${stage}` — an internal key that
 * identifies the row without carrying anything about the person — and
 * `outcome`/`httpStatus`/`fbTraceId` are what an operator actually needs
 * to correlate a row with Meta's own diagnostics. `error` is the message
 * we already persist to `lastError`, which is sliced to 200 chars at the
 * throw site and is Meta's own error text, never our payload.
 *
 * Logged at `error` level only for a genuine failure: a `dormant` retire
 * is normal operation on an unconfigured deployment and would otherwise
 * make every tick look broken.
 */
function logDelivery(entry: {
  crmLeadId: string;
  eventId: string;
  eventName: string;
  leadStage: string | null;
  backend: string;
  lane: string;
  stage: string;
  eventTime: number;
  attempt: number;
  transientAttempt: number;
  outcome: "sent" | "unmatched" | "error" | "dormant";
  httpStatus?: number;
  fbTraceId?: string;
  error?: string;
  // Which retry budget the failure spends. Carried alongside `error`
  // rather than instead of it: the category is what you filter on, the
  // message is what you read once you have filtered.
  errorCategory?: "transient" | "permanent" | "unconfigured";
}): void {
  const line = `[conversionEvents] ${JSON.stringify(entry)}`;
  if (entry.outcome === "error") console.error(line);
  else console.log(line);
}

/**
 * The `patchStatus` args a failed delivery attempt should write. Transient
 * failures re-queue as `"error"` without spending `attempts`; they spend
 * `transientAttempts` instead and back off via `nextAttemptAt` (see
 * `patchStatus`), so they neither retire a live conversion NOR occupy a
 * retry slot on every tick forever.
 */
function errorPatchFor(err: unknown): {
  status: "error";
  lastError: string;
  bumpAttempts: boolean;
  transient: boolean;
} {
  const transient = err instanceof TransientDeliveryError;
  return {
    status: "error",
    lastError: err instanceof Error ? err.message : String(err),
    bumpAttempts: !transient,
    transient,
  };
}


// ============================================================
// User matching. Meta matches a server event back to the person who
// clicked the ad using whatever identifiers we can legitimately supply.
// On the CTWA lane `ctwa_clid` + `whatsapp_business_account_id` are the
// authoritative pair, but they are only as good as the click record; a
// hashed phone or email is a second, independent key that lifts Event
// Match Quality when the click id alone does not resolve.
//
// NORMALIZATION AND HASHING LIVE IN `lib/metaHash.ts`, NOT HERE. They
// are one operation — normalizing after hashing is not a thing you can
// do — and that module is where the rule that actually bites is written
// down and tested: Meta strips LEADING ZEROS before hashing its copy,
// while this CRM's own `lib/phone.ts` deliberately keeps the trunk zero
// for `by_account_phone` dedup. Hashing through `lib/phone.ts` would
// silently mismatch every number stored in local format — `0585824488`
// against the `971585824488` Meta holds — and a mismatch is invisible:
// the request still returns 200, the event simply never attributes.
// `metaHash.test.ts` pins the two normalizations apart for that reason.
// ============================================================

/**
 * Whether to send the hashed `ph`/`em` match keys at all.
 *
 * Gated by `META_CAPI_MATCH_KEYS` so the extra keys can be dropped
 * without a deploy: Meta's business-messaging reference documents the
 * `ctwa_clid` + `whatsapp_business_account_id` pair explicitly but does
 * not enumerate which additional `user_data` fields that channel
 * accepts. If Events Manager ever flags a malformed-parameter warning
 * against `ph`/`em`, set the var to "off" and the payload falls back to
 * the documented-minimal pair. Default is ON, because better matching is
 * the point of sending these at all.
 */
export function matchKeysEnabled(): boolean {
  return (
    (process.env.META_CAPI_MATCH_KEYS ?? "on").trim().toLowerCase() !== "off"
  );
}

/**
 * The hashed `user_data` match keys for one lead, omitting any key we do
 * not genuinely have. Meta expects each as an ARRAY of digests.
 *
 * A key we cannot build is OMITTED rather than sent empty: a SHA-256 of
 * `""` is a perfectly valid-looking digest that matches nobody, and Meta
 * counts it as a supplied-but-unmatched key.
 */
export async function buildHashedMatchKeys(input: {
  phone?: string | null;
  email?: string | null;
}): Promise<{ ph?: string[]; em?: string[] }> {
  const keys: { ph?: string[]; em?: string[] } = {};
  const ph = await hashedPhone(input.phone);
  if (ph) keys.ph = [ph];
  const em = await hashedEmail(input.email);
  if (em) keys.em = [em];
  return keys;
}

export const getById = internalQuery({
  args: { conversionEventId: v.id("conversionEvents") },
  handler: async (ctx, args): Promise<Doc<"conversionEvents"> | null> =>
    await ctx.db.get(args.conversionEventId),
});

export const getWabaId = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<string | null> => {
    const cfg = await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    return cfg?.wabaId ?? null;
  },
});

/**
 * The contact's email, for the second hashed match key (spec §4). Separate
 * from the outbox row because `conversionEvents` deliberately snapshots only
 * what Platform A's contract needs (phone/waMessageId/firstMessageAt) — an
 * email added to the contact AFTER the row was seeded should still improve
 * the match on delivery, and a snapshot could not do that. Returns null for
 * a contact with no email, which is most of them (WhatsApp never supplies
 * one; it is only ever entered by an agent).
 */
export const getContactEmail = internalQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args): Promise<string | null> => {
    const contact = await ctx.db.get(args.contactId);
    return contact?.email ?? null;
  },
});

/**
 * Classifies a conversation's lead source from the identifiers seen on an
 * inbound message and seeds the ONE `new_lead` conversion event for its
 * lane. `code` (website HY-code) wins over `ctwa` (ad click) if both are
 * present; both identifiers are retained on `conversation.attribution`
 * (set once, never overwritten). Fire-once per conversation via the
 * deterministic `eventId = ${conversationId}:new_lead` + the `by_event_id`
 * guard. Returns `{ conversionEventId }` on a fresh insert (so the caller
 * schedules delivery), or `null` for an organic message (no identifier) or a
 * conversation whose `new_lead` was already seeded. Replaces the old
 * `attribution.recordSignal` first-touch write.
 *
 * Also advances `conversation.funnel`/`funnelTransitions` to `new_lead`
 * (Task B3) via `funnel.ts`'s engine-path helper — same `auto` +
 * `neverDowngrade` calling convention as `qualificationEngine.ts`'s
 * `completeQualification` — so a fresh attributed lead is immediately
 * visible in the stepper instead of showing "no stage yet" until an agent
 * acts. `neverDowngrade` makes this a no-op when the conversation already
 * sits at or past `new_lead` (its lowest stage), so it can never pull an
 * already-progressed conversation backward.
 */
export const seedNewLead = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    waMessageId: v.string(),
    phone: v.string(),
    firstMessageAt: v.number(),
    code: v.optional(v.string()),
    ctwaClid: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ conversionEventId: Id<"conversionEvents"> } | null> => {
    const { accountId, contactId, conversationId, waMessageId, phone, firstMessageAt, code, ctwaClid } =
      args;
    if (!code && !ctwaClid) return null; // organic — nothing to attribute

    const lane: "code" | "ctwa" = code ? "code" : "ctwa";
    const identifier = code ?? ctwaClid!;

    // Classify once — set conversation.attribution if unset (retain both ids).
    const conversation = await ctx.db.get(conversationId);
    if (conversation && !conversation.attribution) {
      await ctx.db.patch(conversationId, {
        attribution: { lane, code, ctwaClid, firstSeenAt: firstMessageAt },
      });
    }

    // Fire-once per conversation.
    const eventId = `${conversationId}:new_lead`;
    const existing = await ctx.db
      .query("conversionEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", eventId))
      .first();
    if (existing) return null;

    const eventName = resolveEventName(lane, "new_lead")!; // new_lead is never internal-only
    const conversionEventId = await ctx.db.insert("conversionEvents", {
      accountId,
      conversationId,
      contactId,
      stage: "new_lead",
      lane,
      backend: backendForLane(lane),
      eventName,
      identifier,
      phone,
      waMessageId,
      firstMessageAt,
      eventId,
      status: "pending",
      attempts: 0,
    });
    // Rollup: born `pending` in today's bucket; every later status change
    // moves it inside that same bucket rather than into another day's.
    await recordConversionEventInRollup(ctx, {
      accountId,
      atMs: Date.now(),
      status: "pending",
    });

    // Funnel visibility (Task B3). Re-read so `applyStageTransition` sees
    // the attribution patch just above (if this call is what set it); its
    // own `by_event_id` lookup for this same `eventId` finds the row just
    // inserted, so it links `conversionEventId` onto the transition rather
    // than creating a second event or re-scheduling delivery.
    const withAttribution = await ctx.db.get(conversationId);
    if (withAttribution) {
      const account = await ctx.db.get(accountId);
      await applyStageTransition(ctx, {
        accountId,
        conversation: withAttribution,
        stage: "new_lead",
        auto: true,
        neverDowngrade: true,
        defaultCurrency: account?.defaultCurrency ?? "USD",
      });
    }

    return { conversionEventId };
  },
});

/**
 * Advances a conversionEvents row after a delivery attempt. Conditional
 * spread (a field is only patched when supplied). `attempts` bumps only on
 * an explicit `bumpAttempts === true` — a transient failure passes `false`
 * (see `errorPatchFor`) so it re-queues without spending that budget. An
 * `"error"` bump that reaches `MAX_DELIVER_ATTEMPTS` is retired to the
 * terminal `"abandoned"` state — the give-up point for a row that keeps
 * failing on its own merits (mirrors `attribution.patchResult`).
 * A row that can't be attempted at all is retired by `retireDormant` instead.
 *
 * The transient lane is symmetric, just on its own ledger: `transient: true`
 * bumps `transientAttempts`, gates the next try via `nextAttemptAt`
 * (exponential, capped), and gives up at `MAX_TRANSIENT_DELIVER_ATTEMPTS` —
 * so "the backend is down" retries generously but never forever. A permanent
 * failure clears any stale gate: it's immediately retryable on its own budget.
 */
export const patchStatus = internalMutation({
  args: {
    conversionEventId: v.id("conversionEvents"),
    status: v.union(
      v.literal("sent"),
      v.literal("unmatched"),
      v.literal("error"),
    ),
    fbTraceId: v.optional(v.string()),
    matchResult: v.optional(v.string()),
    lastError: v.optional(v.string()),
    bumpAttempts: v.optional(v.boolean()),
    transient: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.conversionEventId);
    if (!row) return;
    const bumping = args.bumpAttempts === true;
    const transient = args.transient === true && args.status === "error";
    const nextAttempts = row.attempts + 1;
    const nextTransientAttempts = (row.transientAttempts ?? 0) + 1;
    const status =
      bumping && args.status === "error" && nextAttempts >= MAX_DELIVER_ATTEMPTS
        ? ("abandoned" as const)
        : transient && nextTransientAttempts >= MAX_TRANSIENT_DELIVER_ATTEMPTS
          ? ("abandoned" as const)
          : args.status;
    const patch: Record<string, unknown> = { status };
    if (args.fbTraceId !== undefined) patch.fbTraceId = args.fbTraceId;
    if (args.matchResult !== undefined) patch.matchResult = args.matchResult;
    if (args.lastError !== undefined) patch.lastError = args.lastError;
    if (args.status === "sent") {
      patch.sentAt = Date.now();
      // Clear the previous attempt's error. Without this a row that failed
      // once and then succeeded still reads as broken — which is exactly
      // how a working delivery got mistaken for a rejected one while the
      // WABA/dataset link was being fixed.
      patch.lastError = undefined;
    }
    if (bumping) {
      patch.attempts = nextAttempts;
      if (row.nextAttemptAt !== undefined) patch.nextAttemptAt = undefined;
    }
    if (transient) {
      patch.transientAttempts = nextTransientAttempts;
      if (status === "error") {
        patch.nextAttemptAt =
          Date.now() + transientBackoffMs(nextTransientAttempts);
      }
    }
    await ctx.db.patch(args.conversionEventId, patch);
    // Keep the Funnel tab's status counts exact across a MUTABLE field:
    // decrement whatever this row was counted as, increment what it now is,
    // both in its CREATION day's bucket. A no-op when the status is
    // unchanged (a patch that only rewrites `fbTraceId`, say).
    await moveConversionEventStatusInRollup(ctx, {
      accountId: row.accountId,
      createdAtMs: row._creationTime,
      from: row.status,
      to: status,
    });
  },
});

/**
 * Retires a row whose backend cannot be attempted at all (relevant env unset,
 * or capi with no wabaId) to `"abandoned"` WITHOUT bumping `attempts`.
 *
 * Such rows used to be left `"pending"` with `attempts: 0`, which matches
 * `getPendingToRetry`'s predicate forever: since that window is oldest-first
 * and capped at 100, a dormant backlog permanently starved every newer row
 * behind it (in prod the CAPI env is unset, so every CTWA ad lead seeds
 * exactly such a row). Retiring to a status the window doesn't read is what
 * keeps it reachable.
 *
 * `attempts < MAX_DELIVER_ATTEMPTS` is what marks a row dormant-retired
 * rather than genuinely given-up — `patchStatus`'s give-up path can only
 * land on `attempts >= MAX_DELIVER_ATTEMPTS` — and is exactly what
 * `getDormantToSweep` re-reads once the backend is finally configured.
 */
export const retireDormant = internalMutation({
  args: {
    conversionEventId: v.id("conversionEvents"),
    reason: v.string(),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.conversionEventId);
    if (!row) return;
    await ctx.db.patch(args.conversionEventId, {
      status: "dormant",
      lastError: `dormant: ${args.reason}`,
    });
    await moveConversionEventStatusInRollup(ctx, {
      accountId: row.accountId,
      createdAtMs: row._creationTime,
      from: row.status,
      to: "dormant",
    });
  },
});

/**
 * One-off: reclassifies rows the PREVIOUS release retired as `"abandoned"`
 * with `attempts < MAX_DELIVER_ATTEMPTS` into the `"dormant"` partition the
 * sweep now reads. Without it those rows are stranded — `getDormantToSweep`
 * no longer looks at `"abandoned"`, so they would never deliver once their
 * backend is configured, silently. Production carried 19 of them, all real
 * undelivered CTWA conversions.
 *
 * `attempts` is what identifies them, and it is exact rather than heuristic:
 * `patchStatus`'s give-up path can only ever land on `attempts >= MAX`, so a
 * sub-MAX `"abandoned"` row can only have come from `retireDormant`.
 *
 * Walks the `"abandoned"` partition on a `_creationTime` cursor (the implicit
 * trailing key of `by_status`) rather than filtering it, so each pass reads a
 * bounded window and never re-reads a row it has already stepped over. Safe to
 * re-run: a second pass finds nothing left below MAX.
 */
export const migrateDormantOutOfAbandoned = internalMutation({
  args: { cursorMs: v.optional(v.number()) },
  handler: async (ctx, args): Promise<void> => {
    const cursorMs = args.cursorMs ?? 0;
    const page = await ctx.db
      .query("conversionEvents")
      .withIndex("by_status", (q) =>
        q.eq("status", "abandoned").gt("_creationTime", cursorMs),
      )
      .take(MIGRATE_BATCH);
    if (page.length === 0) return;

    for (const row of page) {
      if (row.attempts < MAX_DELIVER_ATTEMPTS) {
        await ctx.db.patch(row._id, { status: "dormant" });
        await moveConversionEventStatusInRollup(ctx, {
          accountId: row.accountId,
          createdAtMs: row._creationTime,
          from: row.status,
          to: "dormant",
        });
      }
    }

    if (page.length === MIGRATE_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.conversionEvents.migrateDormantOutOfAbandoned,
        { cursorMs: page[page.length - 1]!._creationTime },
      );
    }
  },
});

/**
 * Delivers one conversion event to its backend. Never throws. Idempotent:
 * an already-`sent` row is skipped. Dormant (relevant env unset, or capi with
 * no wabaId) → `retireDormant`, which the cron re-sweeps once the backend is
 * configured. We dedupe ourselves (one row per conversation×stage) — Meta does
 * not dedupe business-messaging events.
 */
export const deliverConversionEvent = internalAction({
  args: { conversionEventId: v.id("conversionEvents") },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.runQuery(internal.conversionEvents.getById, {
      conversionEventId: args.conversionEventId,
    });
    if (!row) return;
    if (row.status === "sent") return;

    if (row.backend === "capi") {
      const datasetId = process.env.META_CAPI_DATASET_ID;
      if (!datasetId) {
        await ctx.runMutation(internal.conversionEvents.retireDormant, {
          conversionEventId: args.conversionEventId,
          reason: "META_CAPI_DATASET_ID unset",
        });
        logDelivery({
          ...logFieldsFor(row),
          outcome: "dormant",
          errorCategory: "unconfigured",
        });
        return;
      }
      // The credential is the account's OWN WhatsApp system-user token by
      // default, not a second secret minted by hand.
      //
      // Why: a Click-to-WhatsApp event goes to the dataset that belongs to
      // the WABA (`POST /{waba_id}/dataset`), and the principal owning that
      // dataset is the same system user already sending and receiving
      // messages — on this deployment `wa_api_user`, which carries
      // `whatsapp_business_manage_events` and never expires. A token minted
      // separately in Events Manager is scoped to a WEB pixel and draws
      // "Object with ID ... cannot be loaded due to missing permissions"
      // from the WABA's dataset, which is exactly how this lane sat broken.
      //
      // `META_CAPI_ACCESS_TOKEN` remains an explicit override for a
      // deployment that must deliver to a dataset the WhatsApp system user
      // cannot reach. Unset (the normal case), the account's own token is
      // used and there is one credential to rotate rather than two.
      const config = await ctx.runQuery(
        internal.whatsappConfig.getForAccount,
        { accountId: row.accountId },
      );
      const wabaId = config?.wabaId ?? null;
      const token =
        process.env.META_CAPI_ACCESS_TOKEN ??
        (config ? await decrypt(config.accessToken) : undefined);
      if (!token) {
        await ctx.runMutation(internal.conversionEvents.retireDormant, {
          conversionEventId: args.conversionEventId,
          reason: "no CAPI token — WhatsApp not connected for account",
        });
        logDelivery({
          ...logFieldsFor(row),
          outcome: "dormant",
          error: "META_CAPI_DATASET_ID/META_CAPI_ACCESS_TOKEN unset",
        });
        return;
      }
      if (!wabaId) {
        // Re-swept on every tick while the CAPI env is set (the sweep keys on
        // env, which is configured here) — a no-op round-trip per row until
        // the account connects a WABA, which is the price of not dropping the
        // conversion the moment it does.
        await ctx.runMutation(internal.conversionEvents.retireDormant, {
          conversionEventId: args.conversionEventId,
          reason: "no wabaId configured for account",
        });
        logDelivery({
          ...logFieldsFor(row),
          outcome: "dormant",
          error: "no wabaId configured for account",
        });
        return;
      }
      const email = matchKeysEnabled()
        ? await ctx.runQuery(internal.conversionEvents.getContactEmail, {
            contactId: row.contactId,
          })
        : null;
      try {
        // `user_data`: the documented business-messaging pair first, then
        // the hashed match keys when enabled. Normalized to META's rules
        // BEFORE hashing — see `lib/metaHash.ts`, and note that its phone
        // rule deliberately differs from `lib/phone.ts`'s.
        const userData: Record<string, unknown> = {
          whatsapp_business_account_id: wabaId,
          ctwa_clid: row.identifier,
        };
        if (matchKeysEnabled()) {
          Object.assign(
            userData,
            await buildHashedMatchKeys({ phone: row.phone, email }),
          );
        }

        // `custom_data` always carries the CRM lifecycle label + lead id.
        // `lead_stage` is what Events Manager Custom Conversions and our
        // own reporting segment on, because Meta's business-messaging
        // `event_name` enum has no MQL/SQL/Converted member — see
        // `lib/funnel.ts`'s header. `value`/`currency` ride along only when
        // the milestone actually carried money.
        const leadStage = resolveLeadStage(row.stage);
        const customData: Record<string, unknown> = {
          crm_lead_id: row.conversationId,
          ...(leadStage ? { lead_stage: leadStage } : {}),
        };
        if (row.value !== undefined) {
          customData.value = row.value;
          customData.currency = row.currency;
        }
        const event: Record<string, unknown> = {
          // `event_time` is the milestone's OWN moment (the outbox row's
          // creation), never "now" — a retry days later must still report
          // when the lead actually reached this stage (spec Rule C).
          event_name: row.eventName,
          // The MILESTONE's time, not this attempt's: `_creationTime` is when
          // the outbox row was written, which is the moment the stage was
          // reached. A retry days later re-sends this same value rather than
          // stamping "now" — the event says when it happened.
          event_time: Math.floor(row._creationTime / 1000),
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          event_id: row.eventId,
          user_data: userData,
          custom_data: customData,
        };
        const body: Record<string, unknown> = { data: [event] };
        const partnerAgent = process.env.META_CAPI_PARTNER_AGENT;
        if (partnerAgent) body.partner_agent = partnerAgent;
        // Events Manager → Test Events. Set META_CAPI_TEST_EVENT_CODE and
        // deliveries are routed to the test stream instead of counting as
        // production conversions; UNSET IT before going live, or the whole
        // funnel keeps landing in the test panel and optimizes nothing.
        // Read per-delivery (not cached at module load) so flipping the env
        // takes effect on the next retry tick rather than the next deploy.
        const testEventCode = process.env.META_CAPI_TEST_EVENT_CODE;
        if (testEventCode) body.test_event_code = testEventCode;
        const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
          datasetId,
        )}/events?access_token=${encodeURIComponent(token)}`;
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (err) {
          throw networkError(err);
        }
        if (!res.ok) {
          const text = await res.text();
          throw deliveryError(
            res.status,
            `CAPI ${res.status}: ${text.slice(0, 200)}`,
          );
        }
        const data = (await res.json().catch(() => ({}))) as {
          fbtrace_id?: string;
        };
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          status: "sent",
          fbTraceId: data.fbtrace_id,
        });
        logDelivery({
          ...logFieldsFor(row),
          outcome: "sent",
          httpStatus: res.status,
          fbTraceId: data.fbtrace_id,
        });
      } catch (err) {
        const patch = errorPatchFor(err);
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          ...patch,
        });
        logDelivery({
          ...logFieldsFor(row),
          // The counters reflect what this attempt actually SPENT, which
          // is not `logFieldsFor`'s pre-attempt view: a transient failure
          // bumps `transientAttempts` and leaves `attempts` alone.
          attempt: row.attempts + (patch.bumpAttempts ? 1 : 0),
          transientAttempt:
            (row.transientAttempts ?? 0) + (patch.transient ? 1 : 0),
          outcome: "error",
          errorCategory: patch.transient ? "transient" : "permanent",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // backend === "platformA" — website/code lane → Platform A web Pixel.
    const url = process.env.LANDING_CONVERSION_URL;
    const secret = process.env.WA_CONVERSION_SHARED_SECRET;
    if (!url || !secret) {
      await ctx.runMutation(internal.conversionEvents.retireDormant, {
        conversionEventId: args.conversionEventId,
        reason: "LANDING_CONVERSION_URL/WA_CONVERSION_SHARED_SECRET unset",
      });
      logDelivery({
        ...logFieldsFor(row),
        outcome: "dormant",
        error: "LANDING_CONVERSION_URL/WA_CONVERSION_SHARED_SECRET unset",
      });
      return;
    }
    try {
      const body: Record<string, unknown> = {
        code: row.identifier,
        phone: row.phone,
        waMessageId: row.waMessageId,
        firstMessageAt: row.firstMessageAt,
        stage: row.stage,
        event: row.eventName,
      };
      if (row.value !== undefined) body.value = row.value;
      if (row.currency !== undefined) body.currency = row.currency;
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        throw networkError(err);
      }
      if (!res.ok) {
        throw deliveryError(res.status, `Platform A responded ${res.status}`);
      }
      const data = (await res.json()) as {
        matched?: boolean;
        firedAt?: number;
        offerSlug?: string;
        reason?: string;
      };
      if (data.matched) {
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          status: "sent",
          matchResult: data.offerSlug,
        });
        logDelivery({
          ...logFieldsFor(row),
          outcome: "sent",
          httpStatus: res.status,
        });
      } else {
        await ctx.runMutation(internal.conversionEvents.patchStatus, {
          conversionEventId: args.conversionEventId,
          status: "unmatched",
        });
        logDelivery({
          ...logFieldsFor(row),
          outcome: "unmatched",
          httpStatus: res.status,
        });
      }
    } catch (err) {
      await ctx.runMutation(internal.conversionEvents.patchStatus, {
        conversionEventId: args.conversionEventId,
        ...errorPatchFor(err),
      });
      logDelivery({
        ...logFieldsFor(row),
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

/**
 * Live retry candidates: `error` OR `pending` with `attempts < MAX`, capped at
 * 100 total. Queried through `by_status` (never a full scan), each `.take(100)`,
 * combined and re-capped. Mirrors `attribution.getPendingToRetry`.
 *
 * Both partitions drain: an `error` row succeeds, bumps its way to
 * `"abandoned"` on the permanent budget, or exhausts the transient budget and
 * abandons there; a `pending` row is delivered the moment it's seeded. A row
 * whose backend isn't configured never got either treatment and so used to sit
 * in `pending` permanently — since this window is oldest-first, that backlog
 * starved every newer row behind it. Those rows are now retired by
 * `retireDormant` to a status neither partition reads, and come back through
 * `getDormantToSweep` instead.
 *
 * The `nextAttemptAt` backoff gate is applied in JS over the already-bounded
 * window — NOT as a query `.filter()`, which would not narrow the scan and
 * would walk the partition end-to-end whenever due rows are rare (the
 * `.filter().take()` trap that took down the cron-settings page). The cost of
 * doing it here is that backing-off rows inside the window shrink the batch
 * below 100 even when due rows exist beyond it — acceptable, because every
 * gated row's gate expires (capped backoff) and its lane's budget is finite,
 * so the front of the window always drains and the window advances. The win
 * is the livelock fix: a backing-off row no longer occupies a slot, so
 * `pending` rows behind 100 sick `error` rows still deliver.
 */
export const getPendingToRetry = internalQuery({
  args: {},
  handler: async (ctx): Promise<Doc<"conversionEvents">[]> => {
    const now = Date.now();
    const errored = await ctx.db
      .query("conversionEvents")
      .withIndex("by_status", (q) => q.eq("status", "error"))
      .filter((q) => q.lt(q.field("attempts"), MAX_DELIVER_ATTEMPTS))
      .take(100);
    const pending = await ctx.db
      .query("conversionEvents")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .filter((q) => q.lt(q.field("attempts"), MAX_DELIVER_ATTEMPTS))
      .take(100);
    return [...errored, ...pending]
      .filter((row) => (row.nextAttemptAt ?? 0) <= now)
      .slice(0, 100);
  },
});

/**
 * Dormant-retired rows (see `retireDormant`) for the backends whose env is NOW
 * configured — the path that gets a conversion delivered after its backend is
 * finally wired up, rather than losing it for having arrived too early.
 *
 * The `backends` arg is why this is separate from `getPendingToRetry`: only an
 * action can read `process.env`, so the caller decides what's configured and
 * asks for nothing while nothing is — otherwise an undeliverable backlog would
 * churn the scheduler every 15 minutes for as long as the env stayed unset.
 * `attempts < MAX_DELIVER_ATTEMPTS` excludes rows that reached `"abandoned"`
 * the honest way, through `patchStatus`'s give-up.
 *
 * Dormant now has its own status, so this carries NO `.filter()`: one
 * `by_status_backend` range per configured backend, each bounded by its own
 * `.take()`. It previously ranged `"abandoned"` and filtered on both
 * `attempts < MAX` and the backend list — a scan across a partition that
 * genuinely-given-up rows never leave, so it walked further every time one
 * accumulated. That comment argued the two "only mix when an account both
 * fails deliveries permanently AND has undeliverable rows"; the real
 * production state is simpler and worse, since capi-dormant rows pile up
 * indefinitely while only platformA is configured.
 *
 * Per-backend rather than one range over `"dormant"` with a backend filter,
 * for the same reason: a filter over the whole dormant set would scan past
 * every capi row to find platformA's.
 */
export const getDormantToSweep = internalQuery({
  args: {
    backends: v.array(v.union(v.literal("platformA"), v.literal("capi"))),
    /**
     * Earliest `_creationTime` eligible to be swept, from
     * `CONVERSION_DELIVERY_START_MS`. Omitted means "sweep the whole
     * backlog", which is the behaviour every caller had before this existed.
     *
     * Why it exists: configuring a backend for the first time makes every
     * dormant row eligible at once, and `deliverConversionEvent` derives
     * `event_time` from `_creationTime`. So switching CAPI on with a backlog
     * present fires months of backdated conversions at the dataset in one
     * sweep. The cutoff makes "from now on" expressible without deleting or
     * rewriting the backlog — those rows stay dormant and inert, and remain
     * available if the decision is reversed.
     */
    cutoffMs: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Doc<"conversionEvents">[]> => {
    if (args.backends.length === 0) return [];
    const { cutoffMs } = args;
    const perBackend = await Promise.all(
      args.backends.map((backend) =>
        ctx.db
          .query("conversionEvents")
          .withIndex("by_status_backend", (q) => {
            const partition = q.eq("status", "dormant").eq("backend", backend);
            // Bound on the INDEX, never a post-index `.filter()`. Convex
            // indexes end implicitly with `_creationTime` (`by_account`
            // already relies on that), so this is a genuine range: the walk
            // starts AT the cutoff. A filter would instead read every older
            // row and discard it on each 15-minute tick — the same
            // scan-that-grows this function was restructured to escape, and
            // worse here, because `.take(100)` oldest-first means a backlog
            // of 100+ would fill the window and starve new rows outright.
            return cutoffMs === undefined
              ? partition
              : partition.gte("_creationTime", cutoffMs);
          })
          .take(100),
      ),
    );
    return perBackend.flat().slice(0, 100);
  },
});

/**
 * `CONVERSION_DELIVERY_START_MS` — the earliest `_creationTime` the dormant
 * sweep will deliver, as epoch milliseconds. Unset means "deliver the whole
 * backlog", which is what every deployment did before this existed.
 *
 * Set it to roughly "now" when turning a backend on for the first time, and
 * the rows that accumulated while it was unconfigured stay dormant instead of
 * arriving at the provider stamped with months-old `event_time` values. It
 * only gates the DORMANT sweep: live `pending` rows retry regardless, so a
 * cutoff can never strand a conversion that is actively being delivered.
 *
 * A malformed value fails CLOSED — it skips the backlog rather than
 * delivering it. The asymmetry is deliberate: failing open here means an
 * irreversible burst of backdated events at a third party, while failing
 * closed leaves rows exactly where they already are, and says so in the log.
 */
function deliveryCutoffMs(): number | undefined {
  const raw = process.env.CONVERSION_DELIVERY_START_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (Number.isFinite(parsed)) return parsed;
  console.error(
    `[conversionEvents] CONVERSION_DELIVERY_START_MS is ${JSON.stringify(raw)}, ` +
      "which is not a number. Holding the dormant backlog rather than delivering " +
      "it; correct the value to resume sweeping.",
  );
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Cron entry point (`convex/crons.ts`, every 15 minutes): pulls the live retry
 * batch plus any dormant rows whose backend has since been configured, and
 * re-schedules `deliverConversionEvent` for each, `DELIVER_STAGGER_MS` apart.
 * Tiny by design — every delivery decision (dormant, idempotent,
 * transient-vs-permanent) lives in `deliverConversionEvent` itself.
 */
export const retryConversionEvents = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const backends: Array<"platformA" | "capi"> = [];
    // Dataset id alone now decides whether capi can be attempted: the token
    // is resolved PER ACCOUNT from its WhatsApp connection (see
    // `deliverConversionEvent`), so a deployment-wide env check can no
    // longer answer "is this configured".
    if (process.env.META_CAPI_DATASET_ID) {
      backends.push("capi");
    }
    if (
      process.env.LANDING_CONVERSION_URL &&
      process.env.WA_CONVERSION_SHARED_SECRET
    ) {
      backends.push("platformA");
    }

    // Loud when dark. Silence here WAS the defect: the sweep asks for nothing
    // while a backend's env is unset, so a months-long blackout and a healthy
    // tick produced byte-identical logs. One line per unconfigured backend
    // that is actually holding rows — a deployment that never used a backend
    // has no dormant rows for it and stays quiet.
    const unconfigured = DELIVERY_BACKENDS.filter(
      (backend) => !backends.includes(backend),
    );
    if (unconfigured.length > 0) {
      const holding = await ctx.runQuery(
        internal.conversionEvents.getUnconfiguredHold,
        { backends: [...unconfigured] },
      );
      for (const row of holding) {
        console.error(
          `[conversionEvents] ${row.backend} delivery is UNCONFIGURED and is ` +
            "holding conversions — oldest since " +
            `${new Date(row.oldestHeldAt).toISOString()} (${row.reason}). ` +
            "They deliver automatically once the env is set.",
        );
      }
    }

    const [live, dormant] = await Promise.all([
      ctx.runQuery(internal.conversionEvents.getPendingToRetry, {}),
      ctx.runQuery(internal.conversionEvents.getDormantToSweep, {
        backends,
        cutoffMs: deliveryCutoffMs(),
      }),
    ]);

    // Live rows first: a dormant backlog must never crowd them out of the
    // 100-row budget — the same ordering rule `getPendingToRetry` applies
    // between its own two partitions.
    const batch = [...live, ...dormant].slice(0, 100);
    for (const [i, row] of batch.entries()) {
      await ctx.scheduler.runAfter(
        i * DELIVER_STAGGER_MS,
        internal.conversionEvents.deliverConversionEvent,
        { conversionEventId: row._id },
      );
    }
  },
});

const LIST_RECENT_DEFAULT_LIMIT = 50;
const LIST_RECENT_CAP = 100;

/**
 * Recent conversion events for the Settings → Conversions admin view (Task
 * B4). Replaces `attribution.listConversions`, which read `attributionSignals`
 * — a table with no remaining writers, so that tab showed frozen historical
 * rows forever; this is the live pipeline. Admin+ only, same gate as the
 * query it replaces (`ctx.requireRole("admin")` — the tab exposes raw lead
 * phone numbers, and the old query wasn't masked either, so this doesn't
 * introduce a new exposure). Newest-first off `by_account` (the same index
 * `campaigns.overview` range-scans), bounded to a caller-supplied limit
 * clamped to [1, 100] so no click can request an unbounded payload — this
 * is a live admin list, not a paginated export.
 */
export const listRecent = accountQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const limit = Number.isFinite(args.limit)
      ? Math.min(LIST_RECENT_CAP, Math.max(1, Math.floor(args.limit as number)))
      : LIST_RECENT_DEFAULT_LIMIT;

    const rows = await ctx.db
      .query("conversionEvents")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .take(limit);

    return await Promise.all(
      rows.map(async (row) => {
        const contact = await ctx.db.get(row.contactId);
        return {
          id: row._id,
          lane: row.lane,
          stage: row.stage,
          eventName: row.eventName,
          status: row.status,
          attempts: row.attempts,
          value: row.value,
          currency: row.currency,
          createdAt: row._creationTime,
          contactName: contact?.name ?? null,
          phone: row.phone,
        };
      }),
    );
  },
});

// ============================================================
// Delivery health — why a backend is dark, surfaced instead of inferred.
//
// The failure this exists for: an unconfigured backend is not an error.
// `deliverConversionEvent` retires its rows to `"dormant"` and returns
// cleanly, the cron keeps ticking, and `getDormantToSweep` asks for
// nothing while the env stays unset. That is the correct RUNTIME
// behaviour — it is what lets a backlog self-heal the moment the env
// lands — but it is indistinguishable from health at every observable
// surface. Production ran this way for months: every conversion the
// account produced was parked, and the only symptom was rows quietly
// accumulating in a status the Conversions tab renders as one indigo
// badge among fifty.
//
// So the signal is derived from what the retire path ALREADY persists
// (`status` + `lastError`) rather than from `process.env`, which a query
// cannot read (`getDormantToSweep`'s header). No new table, no new
// index, and it stays true for a backend that is dark for a reason
// OTHER than env — `"no wabaId configured for account"` is retired
// through the same path and reads out here identically.
// ============================================================

const DELIVERY_BACKENDS = ["capi", "platformA"] as const;

/**
 * Ceiling on the dormant scan behind `deliveryHealth`. A dark backend's
 * backlog grows without bound (production reached 2,483 on one account),
 * and this query runs on an admin tab open in a browser — the exact shape
 * that has taken this deployment down before. Past the cap the count is
 * reported as capped rather than counted: "500+, oldest 94 days ago" and
 * "2,483, oldest 94 days ago" call for the same action, so paying 2,483
 * document reads to tell them apart buys nothing.
 */
export const DORMANT_HEALTH_SCAN_CAP = 500;

/** Strips `retireDormant`'s `"dormant: "` prefix off a stored `lastError`. */
function heldReason(lastError: string | undefined): string | null {
  if (!lastError) return null;
  return lastError.startsWith("dormant: ")
    ? lastError.slice("dormant: ".length)
    : lastError;
}

/**
 * Per-backend hold state for the Settings → Conversions banner. Admin+,
 * matching `listRecent` — this reads the same table and the same tab gates
 * both on `CRITICAL_SECTIONS`.
 *
 * Scanned off `by_status_backend` (the partition `getDormantToSweep`
 * already uses) rather than `by_account`, because there is no
 * account+status index and ranging `by_account` would walk every event the
 * account ever produced to find the dormant ones. The scan is therefore
 * deployment-wide and filtered to `ctx.accountId` in memory: rows belonging
 * to other tenants are read but never returned, and on the single-account
 * deployments this ships to the filter is a no-op. In a genuinely busy
 * multi-tenant deployment the count degrades to "at least this many" — the
 * same direction `capped` already reports, and never an overcount.
 *
 * `oldestHeldAt` is exact even when capped: `.take()` on this index walks
 * `_creationTime` ascending, so the oldest dormant row is always in the
 * first page. `newest` is deliberately NOT reported for the mirror-image
 * reason — inside a capped window it would be the newest of the OLDEST 500,
 * which is a number that looks meaningful and is not.
 */
export const deliveryHealth = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");

    return await Promise.all(
      DELIVERY_BACKENDS.map(async (backend) => {
        const scanned = await ctx.db
          .query("conversionEvents")
          .withIndex("by_status_backend", (q) =>
            q.eq("status", "dormant").eq("backend", backend),
          )
          .take(DORMANT_HEALTH_SCAN_CAP + 1);

        const capped = scanned.length > DORMANT_HEALTH_SCAN_CAP;
        const held = scanned
          .slice(0, DORMANT_HEALTH_SCAN_CAP)
          .filter((row) => row.accountId === ctx.accountId);

        return {
          backend,
          heldCount: held.length,
          capped,
          oldestHeldAt: held[0]?._creationTime ?? null,
          // The most recent reason inside the window, not the oldest: if the
          // cause CHANGED (env set, but the account has no WABA), the newer
          // one is the one still standing between these rows and delivery.
          reason: heldReason(held[held.length - 1]?.lastError),
        };
      }),
    );
  },
});

/**
 * The backends that are holding conversions while unconfigured — one
 * document read each, for `retryConversionEvents`'s log line. Takes the
 * backends the caller found UNCONFIGURED (the action owns `process.env`,
 * exactly as `getDormantToSweep` does) and reports which of them have a
 * backlog, so a configured-and-empty deployment logs nothing.
 */
export const getUnconfiguredHold = internalQuery({
  args: {
    backends: v.array(v.union(v.literal("platformA"), v.literal("capi"))),
  },
  handler: async (ctx, args) => {
    const found = await Promise.all(
      args.backends.map(async (backend) => {
        const oldest = await ctx.db
          .query("conversionEvents")
          .withIndex("by_status_backend", (q) =>
            q.eq("status", "dormant").eq("backend", backend),
          )
          .first();
        return oldest
          ? {
              backend,
              oldestHeldAt: oldest._creationTime,
              reason: heldReason(oldest.lastError),
            }
          : null;
      }),
    );
    return found.filter((row): row is NonNullable<typeof row> => row !== null);
  },
});


/**
 * Diagnostic: who owns the WhatsApp token, and can it carry CAPI events?
 *
 * Exists because the CAPI lane needs a token with
 * `whatsapp_business_manage_events` on the WABA's dataset, and the
 * obvious candidate is the system user ALREADY configured for sending and
 * receiving messages — one credential the business already rotates,
 * rather than a second one minted by hand in Events Manager.
 *
 * Returns metadata ONLY. The token is decrypted in memory to make the
 * call and is never returned, logged, or echoed — the whole point is to
 * answer "which system user is this, and does it have the scope" without
 * anyone having to look at the secret itself.
 */
export const whoAmI = internalAction({
  args: { accountId: v.id("accounts") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    ok: boolean;
    identity?: { id?: string; name?: string };
    app?: { id?: string; name?: string };
    type?: string;
    expiresAt?: number | null;
    scopes?: string[];
    hasManageEvents?: boolean;
    error?: string;
  }> => {
    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId: args.accountId,
    });
    if (!config) return { ok: false, error: "WhatsApp not configured" };
    const token = await decrypt(config.accessToken);

    const g = async (path: string) => {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`,
      );
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };

    // `/me` names the system user; `/debug_token` reports the app, type,
    // expiry and the granted scope list.
    const me = await g("me?fields=id,name");
    const dbg = await g(
      `debug_token?input_token=${encodeURIComponent(token)}`,
    );
    const data = (dbg.body as { data?: Record<string, unknown> }).data ?? {};
    const scopes = (data.scopes as string[] | undefined) ?? [];
    const expires = data.expires_at as number | undefined;

    return {
      ok: true,
      identity: me.body as { id?: string; name?: string },
      app: { id: data.app_id as string, name: data.application as string },
      type: data.type as string,
      // 0 / absent means "never expires" — what a system user token looks
      // like, and the reason it is usable in production at all.
      expiresAt: expires === undefined || expires === 0 ? null : expires,
      scopes,
      hasManageEvents: scopes.includes("whatsapp_business_manage_events"),
    };
  },
});


/**
 * Diagnostic: POST one probe event down the exact production path and hand
 * back Meta's raw answer.
 *
 * `deliverConversionEvent` records only a coarse outcome (`sent` / an error
 * string), which was enough to know a delivery had failed but not enough to
 * confirm one had genuinely landed — Meta's dataset stats lag by minutes to
 * hours, so "no events yet" and "silently rejected" look identical for a
 * long window. This closes that gap by returning `events_received` and the
 * response body verbatim.
 *
 * Same credential resolution, same endpoint, same payload shape as the real
 * sender. The probe carries a nonsense `ctwa_clid`, so Meta accepts it as a
 * well-formed event that matches no real person — which is what makes it
 * safe to run against a live dataset.
 */
export const capiProbe = internalAction({
  args: { accountId: v.id("accounts") },
  handler: async (
    ctx,
    args,
  ): Promise<{ httpStatus?: number; body?: unknown; error?: string }> => {
    const datasetId = process.env.META_CAPI_DATASET_ID;
    if (!datasetId) return { error: "META_CAPI_DATASET_ID unset" };
    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId: args.accountId,
    });
    if (!config?.wabaId) return { error: "no wabaId" };
    const token =
      process.env.META_CAPI_ACCESS_TOKEN ?? (await decrypt(config.accessToken));

    const body = {
      data: [
        {
          event_name: "QualifiedLead",
          event_time: Math.floor(Date.now() / 1000),
          action_source: "business_messaging",
          messaging_channel: "whatsapp",
          event_id: `probe:${Date.now()}`,
          user_data: {
            whatsapp_business_account_id: config.wabaId,
            ctwa_clid: "probe-not-a-real-click",
          },
          custom_data: { lead_stage: "MQL", crm_lead_id: "probe" },
        },
      ],
    };
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(datasetId)}/events?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    return {
      httpStatus: res.status,
      body: await res.json().catch(() => ({})),
    };
  },
});


// ============================================================
// Requeue — bringing back conversions that failed for a reason since fixed.
// ============================================================

/**
 * Meta's acceptance window for `event_time` on the Conversions API. An
 * event older than this is rejected on arrival, permanently.
 *
 * This is why the requeue is WINDOWED rather than "retry everything": the
 * dormant backlog is mostly months old, and pushing it at Meta would earn
 * one 4xx per row, spend each row's retry budget a second time, and leave
 * them `abandoned` again with nothing gained. Rows outside the window are
 * left exactly where they are — inert, still on record, still available if
 * the decision is ever revisited.
 */
export const REQUEUE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows examined per pass. Bounded like `MIGRATE_BATCH`. */
const REQUEUE_BATCH = 256;

/** The two partitions a requeue can legitimately draw from. `sent` is
 *  excluded by construction — re-delivering a success would double-report
 *  it — and `pending`/`error` are already draining on their own. */
const REQUEUEABLE = ["abandoned", "dormant"] as const;

/**
 * Returns `abandoned`/`dormant` rows to `pending` so the retry cron
 * delivers them.
 *
 * Written for the aftermath of a configuration fault rather than a code
 * one: while the CAPI lane pointed at the wrong dataset with the wrong
 * token, Meta 400'd every event, five retries spent the budget, and real
 * conversions retired to `abandoned`. Nothing was wrong with those rows.
 *
 * Resets `attempts` AND `transientAttempts` to zero and clears the backoff
 * gate, because the failures they accumulated describe a world that no
 * longer exists. Clearing `lastError` too, so a requeued row does not go
 * on reading as broken while it waits.
 *
 * Deliberately does NOT schedule delivery itself. Setting `pending` hands
 * the rows to `getPendingToRetry`, which already staggers its sends — a
 * few hundred rows scheduled at once would be exactly the self-inflicted
 * burst that `DELIVER_STAGGER_MS` exists to prevent.
 *
 * `dryRun` reports what would move without moving it. The counts are the
 * point: "requeue the backlog" is a decision that deserves a number in
 * front of it first.
 */
export const requeueDeliverable = internalMutation({
  args: {
    /** Oldest `_creationTime` eligible. Defaults to Meta's 7-day window. */
    sinceMs: v.optional(v.number()),
    dryRun: v.optional(v.boolean()),
    cursorMs: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    examined: number;
    requeued: number;
    dryRun: boolean;
    windowStartMs: number;
    byStatus: Record<string, number>;
  }> => {
    const windowStart = args.sinceMs ?? Date.now() - REQUEUE_WINDOW_MS;
    const from = Math.max(windowStart, args.cursorMs ?? 0);
    const dryRun = args.dryRun === true;

    let examined = 0;
    let requeued = 0;
    const byStatus: Record<string, number> = {};
    let lastSeen = from;

    for (const status of REQUEUEABLE) {
      // Bound on the INDEX — `by_status` ends implicitly with
      // `_creationTime`, so this is a genuine range starting at the window
      // rather than a scan of every retired row ever accumulated.
      const page = await ctx.db
        .query("conversionEvents")
        .withIndex("by_status", (q) =>
          q.eq("status", status).gte("_creationTime", from),
        )
        .take(REQUEUE_BATCH);

      for (const row of page) {
        examined++;
        lastSeen = Math.max(lastSeen, row._creationTime);
        if (dryRun) {
          byStatus[status] = (byStatus[status] ?? 0) + 1;
          continue;
        }
        await ctx.db.patch(row._id, {
          status: "pending",
          attempts: 0,
          transientAttempts: 0,
          nextAttemptAt: undefined,
          lastError: undefined,
        });
        await moveConversionEventStatusInRollup(ctx, {
          accountId: row.accountId,
          createdAtMs: row._creationTime,
          from: row.status,
          to: "pending",
        });
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        requeued++;
      }
    }

    // More to walk: continue past the newest row seen. Only when a full
    // page came back, so a partial page ends the walk rather than looping.
    if (!dryRun && examined >= REQUEUE_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.conversionEvents.requeueDeliverable,
        { sinceMs: windowStart, cursorMs: lastSeen + 1 },
      );
    }

    return { examined, requeued, dryRun, windowStartMs: windowStart, byStatus };
  },
});


/**
 * Diagnostic: fire several payload VARIANTS of the same event down the real
 * delivery path and report Meta's answer to each.
 *
 * Built for a question the ordinary probe cannot answer: a 200 with a
 * trace id proves Meta ACCEPTED an event, not that it COUNTED it. Sending
 * several variants at once and comparing what surfaces in the dataset is
 * the only way to tell a payload problem from a reporting delay.
 *
 * Read the result patiently. This was written while `AddToCart` appeared
 * to be silently dropped — it had returned 200 and was still missing after
 * ninety minutes, while events sent later had already surfaced. It landed
 * eventually. Event types backfill on DIFFERENT schedules, especially the
 * first time a dataset sees a given name, so "a later event appeared and
 * this one has not" is not evidence of rejection. Absence is only ever
 * provisional; wait, then look again.
 *
 * Pass a `testEventCode` to route the variants to Events Manager's Test
 * Events view, which reports within seconds instead of the live dataset's
 * 30-minute-plus lag and does not touch live data. Uses a REAL `ctwa_clid`
 * off an existing conversion so the events validate the way production
 * ones do; a fake id is rejected outright (`error_subcode 2804087`).
 */
export const capiProbeMatrix = internalAction({
  args: {
    accountId: v.id("accounts"),
    testEventCode: v.optional(v.string()),
    variants: v.array(
      v.object({
        label: v.string(),
        eventName: v.string(),
        withContents: v.optional(v.boolean()),
        /**
         * Which identity to put in `user_data`.
         *
         * - `ctwa` (default) — the documented business-messaging pair,
         *   `whatsapp_business_account_id` + a real `ctwa_clid`. What
         *   production sends.
         * - `phone` — WABA id + hashed phone, NO click id. This is the
         *   organic question: a chat that never came from an ad has no
         *   `ctwa_clid` to send, so whether Meta accepts this decides
         *   whether organic conversions can be reported at all.
         * - `none` — WABA id alone. The negative control; if this were
         *   accepted the endpoint would not be validating identity.
         */
        identity: v.optional(
          v.union(v.literal("ctwa"), v.literal("phone"), v.literal("none")),
        ),
      }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ label: string; eventName: string; httpStatus?: number; body?: unknown; error?: string }>> => {
    const datasetId = process.env.META_CAPI_DATASET_ID;
    if (!datasetId) return [{ label: "-", eventName: "-", error: "no dataset" }];
    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId: args.accountId,
    });
    if (!config?.wabaId) return [{ label: "-", eventName: "-", error: "no wabaId" }];
    const token =
      process.env.META_CAPI_ACCESS_TOKEN ?? (await decrypt(config.accessToken));

    const donor = await ctx.runQuery(internal.conversionEvents.getProbeIdentity, {
      accountId: args.accountId,
    });
    if (!donor) return [{ label: "-", eventName: "-", error: "no ctwa_clid available" }];

    // A real, delivered phone number, hashed the same way production hashes
    // it. Using a made-up number would test the wrong thing: Meta can
    // reject an identity for being unknown as easily as for being absent,
    // and only a number it has already seen separates those two answers.
    // Routed through `lib/metaHash` like every other hash in this file —
    // the probe must hash by exactly the rule production uses, or it
    // answers a question about the probe rather than about delivery.
    const donorPhoneHash = (await hashedPhone(donor.phone)) ?? null;

    const out = [];
    for (const [i, variant] of args.variants.entries()) {
      const custom: Record<string, unknown> = {
        lead_stage: "PROBE",
        crm_lead_id: "probe",
      };
      if (variant.withContents) {
        // The hypothesis: commerce events may be dropped without content
        // parameters, which is what distinguishes them from LeadSubmitted.
        custom.currency = "AED";
        custom.value = 1;
        custom.content_type = "product";
        custom.content_ids = ["probe-service"];
        custom.contents = [{ id: "probe-service", quantity: 1, item_price: 1 }];
      }
      const body: Record<string, unknown> = {
        data: [
          {
            event_name: variant.eventName,
            event_time: Math.floor(Date.now() / 1000),
            action_source: "business_messaging",
            messaging_channel: "whatsapp",
            event_id: `probe-matrix:${Date.now()}:${i}`,
            user_data: (() => {
              const identity = variant.identity ?? "ctwa";
              const ud: Record<string, unknown> = {
                whatsapp_business_account_id: config.wabaId,
              };
              if (identity === "ctwa") ud.ctwa_clid = donor.ctwaClid;
              if (identity === "phone" && donorPhoneHash) ud.ph = donorPhoneHash;
              return ud;
            })(),
            custom_data: custom,
          },
        ],
      };
      if (args.testEventCode) body.test_event_code = args.testEventCode;

      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(datasetId)}/events?access_token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      out.push({
        label: variant.label,
        eventName: variant.eventName,
        httpStatus: res.status,
        body: await res.json().catch(() => ({})),
      });
    }
    return out;
  },
});

/** A real `ctwa_clid` (and its phone) from a delivered conversion, for
 *  `capiProbeMatrix`. Both are real values Meta has already seen, so a
 *  rejection means the SHAPE was refused rather than the identity being
 *  unrecognised. */
export const getProbeIdentity = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (
    ctx,
    args,
  ): Promise<{ ctwaClid: string; phone?: string } | null> => {
    const row = await ctx.db
      .query("conversionEvents")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .order("desc")
      .filter((q) => q.eq(q.field("lane"), "ctwa"))
      .first();
    return row?.identifier
      ? {
          ctwaClid: row.identifier,
          ...(row.phone ? { phone: row.phone } : {}),
        }
      : null;
  },
});
