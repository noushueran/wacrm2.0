import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { chasingCutoffMs } from "./lib/inbox/lanes";
import { dispatchConversationAssigned } from "./lib/automations/triggers";
import { applyAssignment } from "./lib/assignment";
import { resolveRouting } from "./lib/qualification/routing";
import type { RoutingResult } from "./lib/qualification/routing";
import { recipientsForInbound } from "./lib/pushRecipients";
import { insertNotification } from "./notifications";
import { blockedReason } from "./lib/notes/gate";

// ============================================================
// Auto-assign unowned Chasing threads (spec
// 2026-07-27-inbox-lanes §Chasing ownership).
//
// WHY ITS OWN CRON. Time-derived Chasing has no entry EVENT — a thread
// ages in — so there is nothing to hook. The `lead-sequence` sweep
// ranges `by_sequence_due`, which is empty on an account with no
// approved band templates (the very condition that killed v2's design);
// `qualification-follow-ups` ranges `by_due` over `collecting` sessions,
// and a Chasing thread's session has expired; and scheduling per
// outbound message would create one scheduled job per send. Folding this
// into an unrelated sweep to keep the cron count at seven would trade
// clarity for a number.
//
// SENDS NOTHING. It patches `assignedToUserId`, tells the new owner via
// `conversation_assigned` (same as `conversations.assign`), and — when
// nobody in the account is eligible at all — writes one `chase_unassigned`
// notification per sweep for that account. It deliberately does NOT call
// `chargeLeadIfAgent` and does NOT go through the `assign` mutation —
// billing an agent for an unresponsive lead they did not choose is the
// owner's call, and not-charging is the reversible direction. One line
// to change if that decision flips.
// ============================================================

/** Conversations promoted per run. Bounded so the first sweep over a
 *  months-old backlog cannot fan out unboundedly. */
const ASSIGN_PER_RUN = 50;

/** How far to count a candidate's current Chasing threads, applied to
 *  EACH half of that lane (derived and forced) separately, since they are
 *  two index ranges. At or above this they are already the least
 *  attractive choice, so counting further buys nothing and would make the
 *  read grow with the backlog. */
const LOAD_PROBE = 25;

/** Cache key for `resolveRouting`'s `serviceName: null` case — distinct
 *  from any real service name, which is always a non-empty string. */
const NULL_SERVICE_KEY = "\0";

export const sweepChaseAssign = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ assigned: number; unroutable: number }> => {
    const now = Date.now();
    let assigned = 0;
    let unroutable = 0;

    const accounts = await ctx.db.query("accounts").collect();
    for (const account of accounts) {
      const config = await ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .unique();
      // Two gates, and they are not the same question.
      //
      // `enabled` is the account's MASTER qualification switch — a
      // required `v.boolean()` an owner sets deliberately. This cron did
      // not consult it, so an account that had switched qualification
      // OFF still had its whole Chasing backlog assigned every 30
      // minutes, and its staff notified about it. Every other
      // per-account job keyed on this table already stops there
      // (`qualificationEngine.ts`'s staff-keepalive loop is the exact
      // precedent: `if (!config.enabled) continue`). Honouring it here
      // cannot silently change anyone's behaviour, because the field is
      // required — there is no absent case to reinterpret.
      //
      // Runs BY DEFAULT: `autoAssignEnabled` is `v.optional(v.boolean())`
      // with schema.ts's own `// default true`, and `defaults.ts` seeds
      // it `true` on every new config. Absent or `true` means active;
      // only an explicit `false` disables it. Same flag the consent-offer
      // path gates on (`qualificationEngine.ts`'s `startLeadOffer` guard
      // and `offerContext`) — an owner cannot have lead offers without
      // this sweep, or this sweep without lead offers.
      if (!config || !config.enabled) continue;
      if (config.autoAssignEnabled === false) continue;

      const cutoff = chasingCutoffMs(now, {
        chasingAfterDays: config.chasingAfterDays,
        sessionWindowHours: config.sessionWindowHours,
      });

      // Exactly the Chasing lane's own DERIVED range, and exactly its
      // unassigned slice — `assignedToUserId: undefined` is a real index
      // key, so this reads only rows that need work rather than filtering
      // after. `snoozedUntil: eq(undefined)` excludes a parked thread —
      // a deliberate human park must not be talked over by auto-assignment
      // either. `chasingForcedAt: eq(undefined)` excludes a FORCED thread
      // from this range on purpose: a forced thread sits outside the
      // `lastMessageAt` window this range is keyed on (that is the whole
      // point of forcing it), so it is read separately below instead.
      const due = await ctx.db
        .query("conversations")
        .withIndex("by_account_assigned_lane_last_message", (ix) =>
          ix
            .eq("accountId", account._id)
            .eq("archivedAt", undefined)
            .eq("assignedToUserId", undefined)
            .eq("snoozedUntil", undefined)
            .eq("chasingForcedAt", undefined)
            .eq("awaitingReply", false)
            .gt("lastMessageAt", 0)
            .lte("lastMessageAt", cutoff),
        )
        .order("asc")
        .take(ASSIGN_PER_RUN);

      // The Chasing lane's FORCED half (spec 2026-07-28-inbox-manual-
      // overrides §Force-to-Chasing) — a human declared this lead
      // ghosted, so it belongs in Chasing regardless of age, and by
      // definition sits outside the range above. Forcing a thread is a
      // request for MORE attention, not less: unlike the snooze
      // exclusion above, this read does not test `awaitingReply` or
      // `lastMessageAt` at all — a forced thread stays fully eligible for
      // auto-assignment even if it would otherwise read as Active. Same
      // `by_account_assigned_lane_last_message` index, but `snoozedUntil`
      // is the last equality before the range: `chasingForcedAt` is
      // itself the range key here (`gt(0)` = "forced, at any timestamp"),
      // so nothing after it in the index (`awaitingReply`,
      // `lastMessageAt`) can be bound in the same chain — same
      // constraint the archived-tab lane query already documents.
      const forced = await ctx.db
        .query("conversations")
        .withIndex("by_account_assigned_lane_last_message", (ix) =>
          ix
            .eq("accountId", account._id)
            .eq("archivedAt", undefined)
            .eq("assignedToUserId", undefined)
            .eq("snoozedUntil", undefined)
            .gt("chasingForcedAt", 0),
        )
        .order("asc")
        .take(ASSIGN_PER_RUN);

      // Disjoint by construction (`chasingForcedAt` is `eq(undefined)` in
      // one range and `gt(0)` in the other), so no dedupe is needed.
      // Filtered here — the one point BOTH the derived and forced ranges
      // converge — rather than inside each range's own query, so a
      // do-not-contact contact is excluded once regardless of which
      // range surfaced its conversation. This sweep exists to put a
      // human on a lead so they will chase it; a customer who asked not
      // to be contacted should not spend the per-run assignment budget,
      // nor put a "go chase this" prompt in front of an agent whose
      // customer asked to be left alone. The thread stays visible in the
      // inbox regardless — only automatic assignment stops. Excluded
      // silently, not counted as `unroutable`: nothing is misconfigured,
      // there is simply nothing to do here. `blockedReason` fails closed
      // (a missing contact reads as blocked), which is the right default
      // for a contact record that raced a delete.
      const batch: Doc<"conversations">[] = [];
      for (const conversation of [...due, ...forced]) {
        const contact = await ctx.db.get(conversation.contactId);
        if (blockedReason(contact) !== null) continue;
        batch.push(conversation);
      }
      if (batch.length === 0) continue;

      // Memoizes `resolveRouting` per DISTINCT service name seen in this
      // account's due batch, so its memberships/tags/memberTags reads run
      // once per distinct service (typically a handful), not once per
      // conversation — the read cost stops growing with the batch size.
      // Local to this account's pass; never reused across accounts.
      const routingCache = new Map<string, RoutingResult>();
      const routeFor = async (serviceName: string | null): Promise<RoutingResult> => {
        const key = serviceName ?? NULL_SERVICE_KEY;
        const cached = routingCache.get(key);
        if (cached) return cached;
        const result = await resolveRouting(ctx, { accountId: account._id, serviceName });
        routingCache.set(key, result);
        return result;
      };

      // Zero eligible members is an ACCOUNT-WIDE condition, not a
      // per-conversation one: `resolveRouting`'s fallback ALWAYS widens
      // `poolIds` to the whole eligible team once triggered, so `poolIds`
      // can only ever come back empty when `eligibleById` itself is
      // empty — true or false for every service name in this account
      // alike. Checking it once here, instead of once per conversation,
      // is what keeps the `chase_unassigned` notification below to one
      // per sweep per account rather than one per stuck conversation.
      const { eligibleById: accountEligible } = await routeFor(null);
      if (accountEligible.size === 0) {
        unroutable += batch.length;
        await notifyUnassignedAccount(ctx, account._id, batch);
        console.log(
          `[inbox-chase-assign] account=${account._id} due=${batch.length} assigned=0 unroutable=${batch.length} reason=no_eligible_members`,
        );
        continue;
      }

      // Per-account tallies, logged below. The sweep's return value is
      // discarded by its cron wrapper (`cronSchedules.runSweepChaseAssign`
      // records only start/finish/status in `cronRuns`, which has no field
      // for a payload), so without this the deploy plan's "watch one sweep
      // and confirm the spread across agents" is unobservable. The
      // Convex deployment log is where it lands.
      let accountAssigned = 0;
      let accountUnroutable = 0;
      const spread = new Map<string, number>();

      for (const conversation of batch) {
        const session = await latestSession(ctx, conversation._id);
        const routing = await routeFor(session?.serviceName ?? null);
        // Unreachable given the account-level gate above (every service
        // name's `poolIds` widens to the same non-empty eligible team),
        // but `pickOwner` still types as `Id<"users"> | null` — handled
        // rather than asserted away, the same defensive-typing reasoning
        // `qualificationEngine.ts`'s `offerContext` documents for its own
        // "unreachable today" branch.
        const picked = await pickOwner(ctx, conversation, cutoff, routing);
        if (!picked) {
          unroutable++;
          accountUnroutable++;
          continue;
        }
        // No `actorUserId`: the sweep is the system, and that absence is
        // what makes the thread's line read "Auto-assigned to …".
        const changed = await applyAssignment(ctx, {
          conversation,
          nextAssignee: picked,
          source: "auto_assign",
        });
        await notifyAssigned(ctx, conversation, picked);
        if (changed) {
          await dispatchConversationAssigned(ctx, {
            accountId: conversation.accountId,
            conversationId: conversation._id,
            contactId: conversation.contactId,
            agentId: picked,
          });
        }
        assigned++;
        accountAssigned++;
        spread.set(picked, (spread.get(picked) ?? 0) + 1);
      }

      console.log(
        `[inbox-chase-assign] account=${account._id} due=${batch.length} assigned=${accountAssigned} unroutable=${accountUnroutable} spread=${JSON.stringify(Object.fromEntries(spread))}`,
      );
    }

    console.log(
      `[inbox-chase-assign] sweep complete: assigned=${assigned} unroutable=${unroutable}`,
    );
    return { assigned, unroutable };
  },
});

/** The session that actually describes this conversation today. Not
 *  `.unique()`: `by_conversation` is NOT 1:1 — a repeat inquiry from the
 *  same contact inserts a SECOND `qualificationSessions` row for the same
 *  `conversationId` (`qualificationEngine.ts`'s "Fresh lead for the same
 *  contact" path). `.unique()` throws on more than one match, which would
 *  abort this entire mutation — every account's assignments in this
 *  pass — the instant a repeat-inquiry thread reached Chasing, and since
 *  the offending row is read oldest-first and nothing here clears it,
 *  the same throw would repeat every 30 minutes indefinitely. `.order
 *  ("desc").first()` is what every other reader of this index already
 *  does (`qualification.ts`'s `getSessionForConversation`, `push.ts`,
 *  `leadAnalysis.ts`, `funnel.ts`). */
async function latestSession(
  ctx: { db: MutationCtx["db"] },
  conversationId: Id<"conversations">,
): Promise<Doc<"qualificationSessions"> | null> {
  return await ctx.db
    .query("qualificationSessions")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .order("desc")
    .first();
}

/** The routed candidate currently holding the fewest Chasing threads.
 *  `cutoff` is threaded in rather than recomputed so the load count
 *  measures exactly the same lane the sweep is filling — a count over
 *  Waiting+Chasing would let a busy Waiting queue hide a genuinely idle
 *  Chasing one. `routing` is resolved by the caller (and cached per
 *  distinct service name across the account's whole batch) rather than
 *  requested here, so this function does no membership/tag reads of its
 *  own. */
async function pickOwner(
  ctx: { db: MutationCtx["db"] },
  conversation: Doc<"conversations">,
  cutoff: number,
  routing: Pick<RoutingResult, "eligibleById" | "poolIds">,
): Promise<Id<"users"> | null> {
  // Ranked by CURRENT Chasing load, not by historical offer accepts:
  // accepts are blind to direct assignments, so on the first sweep they
  // would stack the whole backlog onto whoever has fewest.
  let best: { userId: Id<"users">; load: number } | null = null;
  for (const userId of routing.poolIds) {
    if (!routing.eligibleById.has(userId)) continue;
    const held = await ctx.db
      .query("conversations")
      .withIndex("by_account_assigned_lane_last_message", (ix) =>
        ix
          .eq("accountId", conversation.accountId)
          .eq("archivedAt", undefined)
          .eq("assignedToUserId", userId)
          // Same `eq(undefined)` pair as the sweep's main range above.
          .eq("snoozedUntil", undefined)
          .eq("chasingForcedAt", undefined)
          .eq("awaitingReply", false)
          .gt("lastMessageAt", 0)
          .lte("lastMessageAt", cutoff),
      )
      .take(LOAD_PROBE);
    // The FORCED half of this candidate's Chasing load. The range above
    // binds `eq("chasingForcedAt", undefined)` and so cannot see it —
    // and forced threads are exactly what this sweep is handing out in
    // the same batch, so without this second read the load-balancer
    // observes no change at all while it assigns them and every forced
    // thread in a run lands on whichever candidate started with the
    // lowest count. Same index, same shape as the sweep's own forced
    // read: `snoozedUntil` is the last equality, `chasingForcedAt`
    // becomes the range key (`gt(0)` = "forced at any timestamp"), so
    // nothing after it can be bound in this chain. Capped the same way,
    // so the read still does not grow with the backlog.
    const heldForced = await ctx.db
      .query("conversations")
      .withIndex("by_account_assigned_lane_last_message", (ix) =>
        ix
          .eq("accountId", conversation.accountId)
          .eq("archivedAt", undefined)
          .eq("assignedToUserId", userId)
          .eq("snoozedUntil", undefined)
          .gt("chasingForcedAt", 0),
      )
      .take(LOAD_PROBE);
    // Disjoint by construction (`eq(undefined)` vs `gt(0)` on the same
    // key), so summing cannot double-count — the same disjointness the
    // sweep's own `[...due, ...forced]` batch relies on.
    const load = held.length + heldForced.length;
    if (!best || load < best.load) best = { userId, load };
    if (best.load === 0) break; // cannot do better
  }
  return best?.userId ?? null;
}

/**
 * Tells the new owner, the same way a human assignment does —
 * `conversations.ts`'s `assign` mutation inserts this exact
 * `conversation_assigned` shape when it hands a conversation to someone
 * else. No `actorUserId`: schema.ts's own comment on that field is "NULL
 * means an automation/system action", which this is.
 */
async function notifyAssigned(
  ctx: { db: MutationCtx["db"] },
  conversation: Doc<"conversations">,
  userId: Id<"users">,
): Promise<void> {
  const contact = await ctx.db.get(conversation.contactId);
  const contactName = contact?.name || contact?.phone || "a contact";
  await insertNotification(ctx, {
    accountId: conversation.accountId,
    userId,
    type: "conversation_assigned",
    conversationId: conversation._id,
    contactId: conversation.contactId,
    title: "New conversation assigned",
    body: `Auto-assigned: a Chasing lead with ${contactName} had gone quiet with no owner.`,
  });
}

/**
 * Nobody in this account is eligible at all, so every due conversation
 * in this pass stays in the pool — silence would recreate the
 * invisible-orphan problem one level up. ONE `chase_unassigned`
 * notification per supervisor+ recipient per sweep, not one per stuck
 * conversation: `resolveRouting`'s widen-to-team fallback means "nobody
 * eligible" is an account-wide fact, established once by the caller
 * before this runs, so 50 due conversations must not turn into 50×
 * recipients of the same news. Reuses `recipientsForInbound` (the same
 * rule `conversations.ts`'s `unarchiveOnInbound` uses for an unassigned
 * thread) rather than hand-rolling the recipient set.
 *
 * ALSO deduped ACROSS sweeps, which the per-sweep bound alone did not
 * do. "No eligible agent" is a standing configuration fault (the
 * commonest cause is memberships with no `phone` —
 * `lib/qualification/routing.ts`'s eligibility rule), so it persists
 * until an admin fixes it: at one sweep every 30 minutes that is 48
 * notifications per supervisor per day, indefinitely, and the only off
 * switch (`autoAssignEnabled`) also disables lead offers. The rule is
 * therefore "do not tell someone again while they still have an UNREAD
 * one of this type for this account".
 */
async function notifyUnassignedAccount(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
  due: Doc<"conversations">[],
): Promise<void> {
  const members = await ctx.db
    .query("memberships")
    .withIndex("by_account", (q) => q.eq("accountId", accountId))
    .collect();
  const first = due[0]!;
  const count = due.length;

  for (const userId of recipientsForInbound({
    assignedToUserId: null,
    members,
  })) {
    // `by_user_account_read` makes the unread set an index RANGE
    // (`readAt: undefined`), not a scan of this recipient's whole
    // history — the same reason `notifications.ts`'s badge read uses it.
    // `.order("desc")` matters: the previous sweep's notification is the
    // newest thing in that range on the very next sweep, so the common
    // case stops after one document. The `type` test is a `.filter()`
    // rather than a fourth index key because the unread set is already
    // small by construction (the bell is read to clear it), and adding an
    // index for a once-per-30-minutes read is not worth the write cost on
    // every notification insert.
    const outstanding = await ctx.db
      .query("notifications")
      .withIndex("by_user_account_read", (q) =>
        q.eq("userId", userId).eq("accountId", accountId).eq("readAt", undefined),
      )
      .order("desc")
      .filter((f) => f.eq(f.field("type"), "chase_unassigned"))
      .first();
    if (outstanding) continue;

    await insertNotification(ctx, {
      accountId,
      userId,
      type: "chase_unassigned",
      conversationId: first._id,
      contactId: first.contactId,
      title:
        count === 1
          ? "A Chasing lead has no eligible agent"
          : `${count} Chasing leads have no eligible agent`,
      body: "No agent is eligible to receive leads in this account — link an agent to a service, or set at least one agent's WhatsApp number, and the sweep will catch up automatically.",
    });
  }
}
