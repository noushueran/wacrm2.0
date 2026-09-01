import { accountMutation, accountQuery } from "./lib/auth";
import { internalMutation, internalQuery } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { insertNotification } from "./notifications";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { conversationScope, canAccessConversation, canSeeContactPhone, canAssignToOthers } from "./lib/roles";
import type { AccountRole } from "./lib/roles";
import { requireConversationAccess } from "./lib/conversationAccess";
import { maskPhone } from "./lib/phone";
import { chargeLeadIfAgent } from "./lib/leadCharge";
import { applyAssignment } from "./lib/assignment";
import { dispatchConversationAssigned } from "./lib/automations/triggers";
import { recipientsForInbound } from "./lib/pushRecipients";
import { chasingCutoffMs, graceCutoffMs } from "./lib/inbox/lanes";
import { bumpConversationStartedStat } from "./messages";
// Pure state machine only — `lib/leadQuality`, never `./leadQuality`,
// which would pull this query into that module's auth/funnel graph.
import { stepStates, summarizeSteps } from "./lib/leadQuality";

// ============================================================
// Conversations — the Inbox list/thread read (`list`/`get`/
// `getByContact`/`unreadTotal`) plus the mutations that drive its write
// side: `findOrCreateForContact`, `assign`, `unassign`, `setStatus`,
// `markRead`/`markUnread`. Every function here is built on `accountQuery`/
// `accountMutation` (never the raw `query`/`mutation`), mirroring the
// account-isolation pattern `contacts.ts` establishes: `ctx.accountId`
// always comes from the caller's own `memberships` row, never a
// client-supplied argument (there is no `accountId` field in any args
// validator below).
// ============================================================

/**
 * Attaches this contact's `tags` (via the `contactTags` join table).
 * Mirrors `contacts.ts`'s own `embedTags` byte-for-byte — that helper
 * is private to `contacts.ts` (not exported), so it's duplicated here
 * rather than importing across verticals, matching the codebase's
 * existing one-helper-per-file style (each of `contacts.ts`/`tags.ts`
 * only ever reads its own table's shape).
 */
async function embedTags(ctx: QueryCtx, contact: Doc<"contacts">) {
  const links = await ctx.db
    .query("contactTags")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .collect();
  const tags = (
    await Promise.all(
      links.map(async (link) => {
        const tag = await ctx.db.get(link.tagId);
        // Provenance rides along with the tag so the UI can mark an
        // ad-derived label without a second round trip.
        return tag ? { ...tag, source: link.source } : null;
      }),
    )
  ).filter(
    (tag): tag is Doc<"tags"> & { source: "ai" | "manual" | "ad" | undefined } =>
      tag !== null,
  );
  return { ...contact, tags };
}

/** Strips a contact's real number for callers not allowed to see it. */
function maskContactPhone<
  T extends { phone: string; phoneNormalized: string; altPhone?: string },
>(contact: T): T {
  return {
    ...contact,
    phone: maskPhone(contact.phone),
    phoneNormalized: "",
    altPhone: contact.altPhone ? maskPhone(contact.altPhone) : contact.altPhone,
  };
}

/**
 * Embeds a conversation's `contact` (+ that contact's `tags`) for
 * display, so the Inbox list/thread view never needs a second
 * round-trip. `contactId` has no DB-level referential integrity in
 * Convex (and `contacts.remove` has no cascade onto `conversations`
 * today), so the contact can in principle be missing — `contact: null`
 * covers that defensively rather than throwing.
 *
 * Also enforces server-side phone masking (Task 5): the real number is
 * only ever embedded for a caller `canSeeContactPhone` allows — owner/
 * admin/supervisor always, an agent only on a conversation assigned to
 * them. Everyone else gets `maskContactPhone`'s last-2-digits mask, with
 * `phoneNormalized` dropped — CSS/JS hiding is not acceptable here since
 * it would still leak via the network tab, so the strip happens before
 * the contact ever leaves this function.
 */
async function embedContact(
  ctx: QueryCtx & { role: AccountRole; userId: Id<"users"> },
  conversation: Doc<"conversations">,
) {
  const contact = await ctx.db.get(conversation.contactId);
  if (!contact) return { ...conversation, contact: null };
  const withTags = await embedTags(ctx, contact);
  const canSee = canSeeContactPhone(
    ctx.role,
    conversation.assignedToUserId === ctx.userId,
  );
  return {
    ...conversation,
    contact: canSee ? withTags : maskContactPhone(withTags),
  };
}

export const list = accountQuery({
  args: {
    status: v.optional(
      v.union(v.literal("open"), v.literal("pending"), v.literal("closed")),
    ),
    assignment: v.optional(
      v.union(v.literal("mine"), v.literal("unassigned")),
    ),
    // Absent/false = the active Inbox. True = the Archived tab.
    archived: v.optional(v.boolean()),
    // Which lane tab. Absent = today's unlaned behaviour, so every
    // existing caller is untouched.
    lane: v.optional(
      v.union(
        v.literal("active"),
        v.literal("waiting"),
        v.literal("chasing"),
        v.literal("snoozed"),
      ),
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { status, assignment, archived, lane, paginationOpts } = args;
    const scope = conversationScope(ctx.role);

    // Collapse the role scope and the Mine/Unassigned tab into ONE
    // assignment predicate before touching the database. Both used to be
    // `.filter()`s stacked on a `by_account_last_message` scan, which does
    // not narrow the traversal — `.paginate()` then reads until `numItems`
    // MATCHES accumulate, so a tab matching nothing near the front scanned
    // to the end of the account. See the index comment in schema.ts.
    //
    // The tab AND-composes with the scope and so can never widen what a
    // role may see; collapsing them here keeps that property explicit
    // rather than emergent from filter order.
    type AssignmentPlan =
      // No assignment predicate at all — supervisor+ with no tab.
      | { kind: "any" }
      // Exactly one assignee (a user id, or `undefined` for the pool).
      | { kind: "eq"; assignee: Id<"users"> | undefined }
      // An agent's default view: assigned to me OR unassigned.
      | { kind: "meOrPool" }
      // Unsatisfiable — e.g. a viewer (pool-only scope) clicking "Mine".
      | { kind: "empty" };

    const plan: AssignmentPlan = (() => {
      if (scope === "unassigned") {
        // Viewer: the pool is all they may see, so "Mine" is a
        // contradiction. This is the worst case of the old code — an
        // impossible predicate scanned every conversation in the account
        // to return nothing.
        return assignment === "mine"
          ? { kind: "empty" }
          : { kind: "eq", assignee: undefined };
      }
      if (assignment === "mine") return { kind: "eq", assignee: ctx.userId };
      if (assignment === "unassigned") return { kind: "eq", assignee: undefined };
      return scope === "own_and_pool" ? { kind: "meOrPool" } : { kind: "any" };
    })();

    // Nothing can match — answer without a single read.
    if (plan.kind === "empty") {
      return { page: [], isDone: true, continueCursor: "" };
    }

    // Lanes are unavailable on the Archived tab: there `archivedAt` is
    // RANGED (`gt(0)`), and Convex leaves index keys after a range key
    // unordered, so `awaitingReply`/`lastMessageAt` cannot be bound.
    // Reject rather than silently dropping the argument, so a UI bug
    // surfaces as a failure instead of a quietly wrong list.
    if (lane && archived) {
      throw new ConvexError({
        code: "BAD_REQUEST",
        reason: "lane_unavailable_on_archived",
      });
    }

    // The Waiting/Chasing boundary. Read from `qualificationConfigs`
    // (NOT `loadEnabledConfig` — the lane must work whether or not that
    // feature is enabled) and computed by `lib/inbox/lanes.ts`, never
    // inline. Absent row → fall back to the 72h default so the lane
    // still works on an account that has never opened those settings.
    const nowMs = Date.now();
    let cutoff = 0;
    if (lane === "waiting" || lane === "chasing") {
      const qualConfig = await ctx.db
        .query("qualificationConfigs")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .unique();
      cutoff = chasingCutoffMs(nowMs, {
        chasingAfterDays: qualConfig?.chasingAfterDays,
        sessionWindowHours: qualConfig?.sessionWindowHours ?? 72,
      });
    }

    // The grace boundary (owner report 2026-07-28): a thread WE spoke on
    // last stays in Active for a few minutes, so a live back-and-forth
    // does not throw the row across the Active/Waiting line on every
    // message. Waiting simply gains an upper bound — still one range —
    // and Active gains the small complementary set, handled below.
    const grace = graceCutoffMs(nowMs);

    // `status` stays a filter in every branch. That is safe alongside an
    // indexed assignment: it is a coarse predicate (almost everything is
    // "open", since nothing auto-closes — see `dashboard.metrics`), so it
    // matches early and often rather than starving the scan.
    const result = await (async () => {
      if (plan.kind === "eq") {
        // Single assignee → a genuine index range, now over the
        // archive-partitioned four-key index. `archivedAt` is optional and
        // Convex sorts a missing field before every present value, so
        // `eq("archivedAt", undefined)` is exactly the active set and
        // `gt("archivedAt", 0)` is exactly the archived set — both real
        // ranges, not post-scan filters, which matters because archived
        // rows only ever accumulate (see schema.ts's index comment).
        //
        // Careful: in the archived branch `assignedToUserId` CANNOT also
        // be bound as an index key. `archivedAt` is being ranged (`gt`)
        // rather than equated there, and index keys after a range key are
        // unordered, so the assignee is bound as a `.filter()` in that
        // branch only. That is acceptable here — and nowhere else in this
        // function — because the archived set is small relative to the
        // active set and is not the hot path, unlike the active side,
        // where a filter is exactly the failure this whole design avoids.
        const q = lane
          ? ctx.db
              .query("conversations")
              .withIndex("by_account_assigned_lane_last_message", (ix) => {
                const scoped = ix
                  .eq("accountId", ctx.accountId)
                  .eq("archivedAt", undefined)
                  .eq("assignedToUserId", plan.assignee);
                // Snoozed is the complement: the one lane where
                // `snoozedUntil` is RANGED rather than equated, which is
                // why it cannot also bind the keys after it — same
                // constraint the Archived tab hits with `archivedAt`.
                if (lane === "snoozed") return scoped.gt("snoozedUntil", 0);

                const notOverridden = scoped
                  .eq("snoozedUntil", undefined)
                  .eq("chasingForcedAt", undefined)
                  .eq("awaitingReply", lane === "active");
                // Bounded on both sides: newer than the chasing cutoff,
                // older than the grace window (still-live work stays in
                // Active). One range, so the plan is unchanged.
                if (lane === "waiting") {
                  return notOverridden.gt("lastMessageAt", cutoff).lte("lastMessageAt", grace);
                }
                // `gt(0)` excludes message-less rows — see the index comment.
                if (lane === "chasing") {
                  return notOverridden.gt("lastMessageAt", 0).lte("lastMessageAt", cutoff);
                }
                return notOverridden; // active: no range on lastMessageAt
              })
              // Chasing and Snoozed are neglect/wake queues, not message
              // lists — both sort ascending (oldest neglect / soonest
              // wake first).
              .order(lane === "chasing" || lane === "snoozed" ? "asc" : "desc")
          : ctx.db
              .query("conversations")
              .withIndex("by_account_archived_assigned_last_message", (ix) => {
                const scoped = ix.eq("accountId", ctx.accountId);
                return archived
                  ? scoped.gt("archivedAt", 0)
                  : scoped.eq("archivedAt", undefined).eq("assignedToUserId", plan.assignee);
              })
              .order("desc");
        const filtered = archived
          ? q.filter((f) => f.eq(f.field("assignedToUserId"), plan.assignee))
          : q;
        return status
          ? await filtered
              .filter((f) => f.eq(f.field("status"), status))
              .paginate(paginationOpts)
          : await filtered.paginate(paginationOpts);
      }

      // `any` and `meOrPool` both move onto `by_account_archived_last_message`
      // — the archive partition becomes an indexed range for both plans,
      // the same `eq(undefined)`/`gt(0)` trick as above. `any` needs no
      // further assignment predicate at all. `meOrPool` is an OR across two
      // disjoint assignment ranges, which a single `.paginate()` cursor
      // cannot express; that piece stays a filter deliberately, and is the
      // benign case — for an agent, "mine or unassigned" matches a large
      // share of the rows near the front, so it terminates quickly. This is
      // a strict improvement over the old plain `by_account_last_message`
      // scan: the archive partition is now indexed, and only the
      // assignment predicate remains a filter. Splitting that OR into two
      // paginated streams merged under a composite cursor is a separate
      // change, worth doing only if an account ever accumulates enough
      // OTHER agents' threads to starve it.
      const q = lane
        ? ctx.db
            .query("conversations")
            .withIndex("by_account_lane_last_message", (ix) => {
              const scoped = ix.eq("accountId", ctx.accountId).eq("archivedAt", undefined);
              // See the identical comment in the assigned-index branch
              // above — Snoozed ranges `snoozedUntil` and so cannot bind
              // anything after it.
              if (lane === "snoozed") return scoped.gt("snoozedUntil", 0);

              const notOverridden = scoped
                .eq("snoozedUntil", undefined)
                .eq("chasingForcedAt", undefined)
                .eq("awaitingReply", lane === "active");
              // Waiting is now bounded on BOTH sides: older than the
              // grace window (else it is still live work, and belongs in
              // Active) and newer than the chasing cutoff. Still a single
              // range, so the index plan is unchanged.
              if (lane === "waiting") {
                return notOverridden.gt("lastMessageAt", cutoff).lte("lastMessageAt", grace);
              }
              if (lane === "chasing") {
                return notOverridden.gt("lastMessageAt", 0).lte("lastMessageAt", cutoff);
              }
              return notOverridden;
            })
            .order(lane === "chasing" || lane === "snoozed" ? "asc" : "desc")
        : ctx.db
            .query("conversations")
            .withIndex("by_account_archived_last_message", (ix) => {
              const scoped = ix.eq("accountId", ctx.accountId);
              return archived ? scoped.gt("archivedAt", 0) : scoped.eq("archivedAt", undefined);
            })
            .order("desc");

      if (!status && plan.kind === "any") return await q.paginate(paginationOpts);

      return await q
        .filter((f) => {
          const parts = [];
          if (status) parts.push(f.eq(f.field("status"), status));
          if (plan.kind === "meOrPool") {
            parts.push(
              f.or(
                f.eq(f.field("assignedToUserId"), ctx.userId),
                f.eq(f.field("assignedToUserId"), undefined),
              ),
            );
          }
          return parts.reduce((a, b) => f.and(a, b));
        })
        .paginate(paginationOpts);
    })();

    // The Active lane's grace set (owner report 2026-07-28). Active is
    // `awaitingReply === true` UNION "we spoke last, but only just" —
    // two index ranges, which one `.paginate()` cursor cannot express.
    //
    // It does not need to. The grace set is bounded by construction: it
    // is only threads this account replied to within the last few
    // minutes, so it is small, and because those rows carry the newest
    // `lastMessageAt` in the whole lane they belong at the very top of a
    // recency-ordered list. So it is read once with a hard `.take()` cap
    // and prepended to PAGE ONE only; later pages come from the main
    // range untouched, and the cursor keeps working because it never saw
    // these rows. Deliberately NOT a `.filter()` over the main range —
    // that is the unbounded-scan trap this file documents throughout.
    //
    // The cap is a real ceiling, not a guess at a maximum: an account
    // that somehow replied to more than this many threads inside the
    // window shows the most recent of them, which is the right
    // truncation for a recency list.
    const GRACE_CAP = 60;
    let graceRows: Doc<"conversations">[] = [];
    if (lane === "active" && paginationOpts.cursor === null) {
      const graceQuery = ctx.db
        .query("conversations")
        .withIndex(
          plan.kind === "eq"
            ? "by_account_assigned_lane_last_message"
            : "by_account_lane_last_message",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the two index builders have different key tuples; the branch above picks the matching one
          (ix: any) => {
            // Same `eq(undefined)` pair as the main range above, in both
            // branches — load-bearing now that overrides are live: it is
            // what keeps a snoozed or forced-chasing row out of the grace
            // set, the same exclusion the main Active range enforces.
            // Without it a thread the owner just snoozed (or force-parked
            // into Chasing) could still surface at the top of Active
            // because we happened to reply moments before marking it.
            const scoped =
              plan.kind === "eq"
                ? ix
                    .eq("accountId", ctx.accountId)
                    .eq("archivedAt", undefined)
                    .eq("assignedToUserId", plan.assignee)
                    .eq("snoozedUntil", undefined)
                    .eq("chasingForcedAt", undefined)
                    .eq("awaitingReply", false)
                : ix
                    .eq("accountId", ctx.accountId)
                    .eq("archivedAt", undefined)
                    .eq("snoozedUntil", undefined)
                    .eq("chasingForcedAt", undefined)
                    .eq("awaitingReply", false);
            return scoped.gt("lastMessageAt", grace);
          },
        )
        .order("desc");
      const raw = await graceQuery.take(GRACE_CAP);
      graceRows = raw.filter((c) => {
        if (status && c.status !== status) return false;
        // `meOrPool` binds assignment as a filter in the main query too —
        // same predicate, applied here by hand for the same reason.
        if (plan.kind === "meOrPool") {
          return c.assignedToUserId === ctx.userId || c.assignedToUserId === undefined;
        }
        return true;
      });
    }

    // The Chasing lane's forced set (spec §Force-to-Chasing). Chasing is
    // (derived) UNION (forced), and like the grace set the second half is
    // bounded by construction — only threads a human has explicitly
    // marked — so it is one capped read merged into page one rather than
    // a filter over the main range.
    //
    // Merged into page one only, for the same reason: the cursor belongs
    // to the main range and never saw these rows.
    //
    // ORDERED ASCENDING BY `chasingForcedAt`, and that direction is a
    // correctness property, not a preference. Unlike the grace set — whose
    // truncation self-heals within minutes because its rows age out of the
    // window on their own — a force NEVER expires, so a forced row that
    // falls past this cap is gone from every lane (the derived Chasing
    // range binds `eq("chasingForcedAt", undefined)` and excludes it, and
    // so do Active, Waiting and Snoozed) until somebody un-forces it.
    // Reading oldest-forced first means the rows that survive truncation
    // are the ones that have been forced longest — the most neglected,
    // which is exactly what a neglect queue must not drop — and the rows
    // dropped are the just-forced, which the agent who forced them is
    // still looking at.
    //
    // The truncation is also SIGNALLED rather than silent: the read takes
    // one more than the cap purely to detect overflow. There is no cheap
    // way to make this set never truncate — merging two disjoint index
    // ranges under a single `.paginate()` cursor needs a composite cursor
    // (the same change `by_account_archived_last_message`'s `meOrPool`
    // branch defers), and an uncapped `.collect()` over the forced range
    // is exactly the unbounded read this file refuses everywhere else.
    // Note the `status`/`meOrPool` post-filter below shrinks the set
    // further, after the cap, so a filtered view can lose forced rows
    // before this warning fires.
    const FORCED_CAP = 60;
    let forcedRows: Doc<"conversations">[] = [];
    if (lane === "chasing" && paginationOpts.cursor === null) {
      const forcedQuery = ctx.db
        .query("conversations")
        .withIndex(
          plan.kind === "eq"
            ? "by_account_assigned_lane_last_message"
            : "by_account_lane_last_message",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the two builders have different key tuples; the branch above picks the matching one
          (ix: any) => {
            const scoped =
              plan.kind === "eq"
                ? ix
                    .eq("accountId", ctx.accountId)
                    .eq("archivedAt", undefined)
                    .eq("assignedToUserId", plan.assignee)
                    .eq("snoozedUntil", undefined)
                : ix
                    .eq("accountId", ctx.accountId)
                    .eq("archivedAt", undefined)
                    .eq("snoozedUntil", undefined);
            return scoped.gt("chasingForcedAt", 0);
          },
        )
        // Oldest-forced first — see the cap comment above.
        .order("asc");
      const probed = await forcedQuery.take(FORCED_CAP + 1);
      if (probed.length > FORCED_CAP) {
        console.warn(
          `[inbox-chasing-forced] account=${ctx.accountId} forced set exceeds cap=${FORCED_CAP}; the most recently forced threads are not shown in Chasing until earlier forces are cleared`,
        );
      }
      const raw = probed.slice(0, FORCED_CAP);
      forcedRows = raw.filter((c) => {
        if (status && c.status !== status) return false;
        if (plan.kind === "meOrPool") {
          return c.assignedToUserId === ctx.userId || c.assignedToUserId === undefined;
        }
        return true;
      });
    }

    // Each extra set is merged in its own lane's ordering, matching the
    // main range: grace merges newest-first (a customer who replied 30
    // seconds ago should still outrank a thread we answered 10 minutes
    // ago), forced merges oldest-first (Chasing is a neglect queue, so
    // the longest-ignored forced thread should still outrank a
    // just-forced one). The two sets are disjoint by construction
    // (`awaitingReply` true vs false plus the `chasingForcedAt`
    // binding), so no dedupe is needed — only which comparator to sort
    // with.
    //
    // `graceRows` and `forcedRows` can never both be non-empty — one is
    // gated on `lane === "active"` and the other on `lane === "chasing"`
    // — so the branches below are exclusive by construction. Chasing
    // sorts ascending by neglect (opposite of the grace merge), so it
    // needs its own comparator.
    const mergedPage = forcedRows.length
      ? [...forcedRows, ...result.page].sort(
          (a, b) => (a.lastMessageAt ?? 0) - (b.lastMessageAt ?? 0),
        )
      : graceRows.length
        ? [...graceRows, ...result.page].sort(
            (a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0),
          )
        : result.page;

    const page = await Promise.all(
      mergedPage.map(async (conversation) => {
        const withContact = await embedContact(ctx, conversation);

        // Sequence detail for the Chasing rows. Per PAGE, so it is
        // bounded by `numItems` — the same shape as this function's
        // existing contact join. Gated on the lane so no other tab pays
        // for it. Read-only: `leadAnalyses` stays the system of record
        // and nothing here mirrors it onto `conversations` (see the
        // spec's §Why time-derived and not sequence-derived).
        const analysis =
          lane === "chasing"
            ? await ctx.db
                .query("leadAnalyses")
                .withIndex("by_conversation", (q) =>
                  q.eq("conversationId", conversation._id),
                )
                .unique()
            : null;

        // Lead-quality progress for the row badge. An agent could not see
        // which threads still owed an answer without opening each one,
        // which is most of why the panel went unused.
        //
        // A per-page join, the same shape and the same bound as the
        // `leadAnalyses` read just above: one indexed lookup per row,
        // capped by `numItems`. Ungated, unlike that one, because the
        // badge belongs on every lane — and cheap in practice because the
        // overwhelming majority of conversations have NO answer rows, so
        // the query returns empty without reading a document.
        //
        // Derived through the same `stepStates` the panel renders from, so
        // the badge and the panel cannot disagree about what is pending.
        const answers = await ctx.db
          .query("leadQualityAnswers")
          .withIndex("by_conversation", (q) =>
            q.eq("conversationId", conversation._id),
          )
          .collect();

        return {
          ...withContact,
          followUpsSent: analysis?.followUpsSent,
          sequenceStatus: analysis?.sequenceStatus,
          leadQuality: summarizeSteps(
            stepStates({
              answers: answers.map((a) => ({
                step: a.step,
                answer: a.answer,
                at: a._creationTime,
                ...(a.value !== undefined ? { value: a.value } : {}),
                ...(a.currency !== undefined ? { currency: a.currency } : {}),
              })),
              currentStage: conversation.funnel?.stage ?? null,
            }),
          ),
          // Manual lane overrides (Task 7) — already on `conversation`
          // itself (no extra read, unlike the `leadAnalyses` join just
          // above), so `...withContact` already carries them; spelled out
          // here anyway so the row's shape is self-documenting at the
          // call site rather than relying on the spread to smuggle them
          // through.
          snoozedUntil: conversation.snoozedUntil,
          chasingForcedAt: conversation.chasingForcedAt,
        };
      }),
    );
    return { ...result, page };
  },
});

export const get = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );
    return await embedContact(ctx, conversation);
  },
});

/**
 * The contact's own conversation, or `null` if no thread has been
 * opened for them yet — the read the deal-form "Link to Conversation"
 * banner needs (Phase 8, Task 3). Ownership is checked on the CONTACT
 * (mirrors `findOrCreateForContact`'s own check below) rather than on
 * a conversation id, since the caller may not know whether a
 * conversation exists at all yet. Unlike `findOrCreateForContact`,
 * this never creates one — a deal can exist before any inbound/
 * outbound WhatsApp message ever happened for its contact, and the
 * banner only needs to know whether a thread exists to link to.
 */
export const getByContact = accountQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
    }

    const conversation = await ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .filter((q) => q.eq(q.field("accountId"), ctx.accountId))
      .first();
    if (!conversation) return null;
    const allowed = canAccessConversation(
      ctx.role,
      {
        isMine: conversation.assignedToUserId === ctx.userId,
        isUnassigned: conversation.assignedToUserId === undefined,
      },
      "view",
    );
    if (!allowed) return null;
    return await embedContact(ctx, conversation);
  },
});

/**
 * Count of the account's conversations with `unreadCount > 0` — the
 * sidebar's unread nav badge (Phase 8/9 stragglers: the Convex
 * counterpart to `src/hooks/use-total-unread.ts`, which currently sums
 * this client-side from a Supabase realtime subscription).
 *
 * Ranges over `by_account_unread` (`["accountId", "unreadCount"]`) so
 * the `> 0` test is an index-level range bound, not a JS filter over
 * the account's full conversation set. That matters for more than the
 * read cost: this query is subscribed app-wide by the sidebar, and a
 * Convex subscription re-runs whenever any document it *read* changes.
 * Ranging on `unreadCount` keeps already-read conversations out of the
 * read set entirely, so the routine `lastMessageAt` patch that every
 * message writes (`messages.ts`'s `insertMessageAndUpdateConversation`)
 * no longer invalidates this badge for every connected client. Ordering
 * is irrelevant to a count, so `by_account_last_message` (which `list`
 * uses) is still the wrong index here.
 *
 * The role scope stays a JS filter — it's an OR across two fields for
 * `own_and_pool`, which no single index range expresses — but it now
 * runs over only the unread rows rather than the whole account.
 */
export const unreadTotal = accountQuery({
  args: {},
  handler: async (ctx) => {
    const scope = conversationScope(ctx.role);
    // No archive predicate needed: `leadAnalysis.archive` zeroes
    // `unreadCount`, so an archived thread leaves this range on its own.
    const unread = await ctx.db
      .query("conversations")
      .withIndex("by_account_unread", (q) =>
        q.eq("accountId", ctx.accountId).gt("unreadCount", 0),
      )
      .collect();
    return unread.filter((c) => {
      if (scope === "all") return true;
      if (scope === "own_and_pool")
        return c.assignedToUserId === ctx.userId || c.assignedToUserId === undefined;
      return c.assignedToUserId === undefined; // viewer: pool only
    }).length;
  },
});

/**
 * The ONE place a `conversations` row is created — `notifications.ts`'s
 * `insertNotification` precedent, and for the same reason: four separate
 * `insert("conversations")` call sites had drifted, three of them
 * omitting `awaitingReply` entirely. Every path now routes through here:
 * `findOrCreateForContact` and `findOrCreateForContactInternal` below,
 * `ingest.ts`'s inbound upsert, and `qualificationEngine.ts`'s
 * `ensureAdminConversation`. A fifth site cannot repeat the omission
 * without deliberately bypassing this function.
 *
 * `awaitingReply: true` is not a convenience default — it is the
 * schema's documented semantics for a message-less thread (see
 * `schema.ts`'s own comment on the field): whoever opened the thread
 * owes it its first message, so Active is the honest lane, and it also
 * preserves the row's existing sort position (Active applies no range to
 * `lastMessageAt`, which is absent, and Convex sorts missing first, so it
 * lands last under `.order("desc")`).
 *
 * Leaving it `undefined` was NOT benign: Active binds
 * `eq("awaitingReply", true)` and Waiting/Chasing bind `eq(..., false)`,
 * and the Inbox always sends a lane, so an `undefined` row matched no tab
 * at all. `broadcasts.ts` reaches this with no human in the loop (the
 * conversation is created in one mutation, the Meta send is a separate
 * action), so every failed broadcast recipient left a permanently
 * invisible row.
 *
 * Takes a bare `{ db }` rather than a full `MutationCtx` so it is
 * callable from any mutation's ctx, exactly like `insertNotification`.
 */
export async function insertConversation(
  ctx: { db: MutationCtx["db"] },
  fields: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    /** Only `ensureAdminConversation` sets this — the assistant must
     *  never talk to its own staff-alert channel. */
    aiAutoreplyDisabled?: boolean;
  },
): Promise<Id<"conversations">> {
  const conversationId = await ctx.db.insert("conversations", {
    ...fields,
    status: "open",
    unreadCount: 0,
    awaitingReply: true,
  });
  // The reports rollup's conversations-started series (docs/superpowers/
  // specs/2026-08-05-reports-section-design.md). This is the single choke
  // point every creation path already routes through (see this function's
  // own doc comment above), so counting here cannot be bypassed the way
  // the four drifted `insert` call sites this function replaced were.
  await bumpConversationStartedStat(
    ctx,
    fields.accountId,
    Date.now(),
    "conversationsStarted",
  );
  return conversationId;
}

// ============================================================
// Conversation mutations (Phase 2, Task 3) — creating a thread for a
// contact, assigning it, changing its status, and marking it read.
// Every mutation asserts access to its target conversation via the
// shared `requireConversationAccess` guard (`convex/lib/
// conversationAccess.ts`) before writing — "view" for reads/toggles
// that the assigned-or-pool scope should reach, "own" for writes that
// require the caller to actually hold the assignment (Task 6).
// ============================================================

/**
 * Returns the existing thread for a contact, or opens a new one.
 * `by_contact` isn't itself account-scoped (see schema.ts), so the
 * match is additionally filtered to `ctx.accountId` — defense-in-depth
 * that doesn't actually change behavior today (a contact only ever
 * belongs to one account, and the ownership check above already proves
 * it's this caller's own, so no other account's conversation could
 * share its `contactId`), matching `contacts.ts`'s own "re-check the
 * target row's accountId, don't rely solely on the index" philosophy.
 */
export const findOrCreateForContact = accountMutation({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
    }

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .filter((q) => q.eq(q.field("accountId"), ctx.accountId))
      .first();
    if (existing) return existing._id;

    return await insertConversation(ctx, {
      accountId: ctx.accountId,
      contactId: args.contactId,
    });
  },
});

/**
 * Server-only counterpart to `findOrCreateForContact` above, for
 * `send.ts`'s public `send` action (Phase 8, Task 4) — an action has no
 * `ctx.db`/user session of its own (same reasoning as `messages.ts`'s
 * `appendInternal`), so `accountId` is an explicit, caller-supplied
 * argument instead of `ctx.accountId`. Otherwise byte-for-byte the same
 * find-or-create body: verify the contact belongs to `accountId`, reuse
 * `by_contact` + an `accountId` filter (see `findOrCreateForContact`'s
 * own comment for why that filter is defense-in-depth, not
 * load-bearing), insert if none exists.
 *
 * `role` is OPTIONAL and, when supplied, gates the CREATE branch only
 * (RBAC final review, C1): a brand-new conversation is always
 * unassigned, and `canAccessConversation`'s "own" mode can never grant
 * an agent access to an unassigned conversation (see that function's
 * own doc comment) — so a caller below `supervisor` who has no
 * existing conversation for this contact is denied BEFORE the row is
 * inserted, rather than being allowed to create it and only THEN
 * denied when `send.ts` checks "own" access on the result, which would
 * leave a dead, empty, never-messaged conversation behind. The
 * EXISTING-conversation branch is deliberately NOT re-checked here
 * (no side effect to prevent there — it already existed); `send.ts`'s
 * own uniform post-resolution access check covers that case instead.
 * Every other caller (`apiV1.sendMessage`'s API-key-authenticated REST
 * send, `broadcasts.ts`'s account-level bulk send) omits `role`
 * entirely and keeps its exact prior, unrestricted-creation behavior —
 * neither is scoped to an individual user's role at all.
 */
export const findOrCreateForContactInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    role: v.optional(
      v.union(
        v.literal("owner"),
        v.literal("admin"),
        v.literal("supervisor"),
        v.literal("agent"),
        v.literal("viewer"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== args.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
    }

    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .filter((q) => q.eq(q.field("accountId"), args.accountId))
      .first();
    if (existing) return existing._id;

    if (
      args.role !== undefined &&
      !canAccessConversation(
        args.role,
        { isMine: false, isUnassigned: true },
        "own",
      )
    ) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
    }

    return await insertConversation(ctx, {
      accountId: args.accountId,
      contactId: args.contactId,
    });
  },
});

/**
 * Server-only conversation lookup by id+accountId — the action-callable
 * ownership check `send.ts`'s `send` (C1) and `reactions.ts`'s
 * `reactToMeta` (I1) both need before they can apply
 * `canAccessConversation(..., "own")` against a resolved conversation's
 * `assignedToUserId`: neither is a query/mutation with its own `ctx.db`
 * (only `ctx.runQuery`/`ctx.runMutation`/`ctx.runAction`), and each
 * already derived the caller's role/userId itself
 * (`accounts.accountContextForUser` + `getAuthUserId`) — this is just
 * the one remaining piece only `ctx.db` can supply. Same NOT_FOUND
 * collapse as every other ownership check in this file: "doesn't
 * exist" and "belongs to a different account" are indistinguishable to
 * the caller. Mirrors `messages.ts`'s `getForAccount` one-to-one (same
 * name pattern, same shape), just for `conversations` instead of
 * `messages`.
 */
export const getForAccountInternal = internalQuery({
  args: { accountId: v.id("accounts"), conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
    }
    return conversation;
  },
});

/**
 * Assigns a conversation to an account teammate and bumps it to
 * "pending" — the agent now owns following up. `userId` must itself be
 * a member of this same account (checked via `by_user_account`); an
 * arbitrary/foreign user id is rejected the same way a missing/foreign
 * conversation is, so a cross-account probe can't distinguish "no such
 * user" from "not your teammate".
 *
 * Claim model (Task 6): access to the conversation itself is checked
 * in "view" mode (`requireConversationAccess`), so an agent can reach
 * — and claim — any pool conversation even though they don't yet own
 * it. `canAssignToOthers` (`convex/lib/roles.ts`) then gates who the
 * target can be: below supervisor, `userId` must be the caller's own
 * (self-claim) and the conversation must be unassigned or already
 * theirs — reassigning a colleague's conversation is a supervisor+
 * action. supervisor+ may assign anyone to anyone.
 *
 * Also notifies the assignee (`convex/notifications.ts`'s
 * `insertNotification`) — the Convex counterpart to migration 027's
 * `notify_conversation_assigned` trigger. Skipped for self-assignment
 * (mirrors the trigger's own `auth.uid() = NEW.assigned_agent_id`
 * guard): nothing to notify an agent about when they assigned the
 * conversation to themselves.
 */
export const assign = accountMutation({
  args: { conversationId: v.id("conversations"), userId: v.id("users") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    // View access reaches the conversation; the claim constraints below
    // restrict agents to self-claiming the pool.
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );

    if (!canAssignToOthers(ctx.role)) {
      const notSelf = args.userId !== ctx.userId;
      const ownedByOther =
        conversation.assignedToUserId !== undefined &&
        conversation.assignedToUserId !== ctx.userId;
      if (notSelf || ownedByOther) {
        throw new ConvexError({ code: "FORBIDDEN", min: "supervisor" });
      }
    }

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", args.userId).eq("accountId", ctx.accountId),
      )
      .first();
    if (!membership) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "member" });
    }

    // `applyAssignment` owns the field + the timeline row and reports
    // whether this was a real change of hands — the guard that used to
    // be a local `previousAssignee !== args.userId` here. `status` stays
    // this mutation's own business: assigning IS the start of someone
    // working the thread, which `setAutoreplyPaused` deliberately is not.
    const changed = await applyAssignment(ctx, {
      conversation,
      nextAssignee: args.userId,
      actorUserId: ctx.userId,
      source: "manual",
    });
    await ctx.db.patch(args.conversationId, { status: "pending" });

    await chargeLeadIfAgent(ctx, ctx.accountId, args.userId, args.conversationId);

    if (changed) {
      await dispatchConversationAssigned(ctx, {
        accountId: ctx.accountId,
        conversationId: args.conversationId,
        contactId: conversation.contactId,
        agentId: args.userId,
      });
    }

    if (args.userId !== ctx.userId) {
      const [contact, actorMembership] = await Promise.all([
        ctx.db.get(conversation.contactId),
        ctx.db
          .query("memberships")
          .withIndex("by_user_account", (q) =>
            q.eq("userId", ctx.userId).eq("accountId", ctx.accountId),
          )
          .first(),
      ]);
      // COALESCE(NULLIF(name, ''), phone) / COALESCE(actor, 'Someone') —
      // same fallback chain as migration 027's trigger body text.
      const contactName = contact?.name || contact?.phone || "a contact";
      const actorName = actorMembership?.fullName || "Someone";

      await insertNotification(ctx, {
        accountId: ctx.accountId,
        userId: args.userId,
        type: "conversation_assigned",
        conversationId: args.conversationId,
        contactId: conversation.contactId,
        actorUserId: ctx.userId,
        title: "New conversation assigned",
        body: `${actorName} assigned you a conversation with ${contactName}`,
      });
    }

    return args.conversationId;
  },
});

/**
 * Clears a conversation's assignment — the inverse of `assign`, for
 * the Inbox's "Unassign" dropdown option and the "Resume AI" banner
 * (Phase 8/9 stragglers): `assign` requires a concrete `userId`, so it
 * has no way to represent "nobody owns this anymore." `assignedToUserId`
 * is an optional field, and patching it to `undefined` removes it —
 * the same idiom `templates.ts`'s `submissionError: undefined` uses to
 * clear an optional field, rather than a special-cased "unset" API.
 *
 * `status` is deliberately left untouched. This mirrors the legacy
 * Supabase write it replaces (`src/components/inbox/message-
 * thread.tsx`'s `handleAssignChange`, the "Unassign" branch), which
 * only ever cleared `assigned_agent_id` and never touched `status` —
 * unlike `assign`, which bumps status to "pending" because assigning
 * is itself the start of someone actively working the thread, clearing
 * the assignee isn't itself a statement about whether the conversation
 * is still open, pending, or closed. Callers that also want a status
 * change (e.g. reopening) call `setStatus` explicitly. There's also no
 * notification to fire in reverse — unassigning notifies nobody, since
 * there's no `notify_conversation_assigned`-style trigger for it in the
 * original schema.
 */
export const unassign = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "own",
    );
    await applyAssignment(ctx, {
      conversation,
      nextAssignee: undefined,
      actorUserId: ctx.userId,
      source: "manual",
    });
    return args.conversationId;
  },
});

/**
 * One conversation's ownership history, OLDEST first — the thread renders
 * these inline beside messages and notes, the same chronological order
 * `contactNotes.listForConversation` uses.
 *
 * Names are resolved here rather than client-side so the thread doesn't
 * need a second membership subscription. `fullName ?? "Member"` mirrors
 * `leadsBoard`: `members.list` nulls email below admin as staff PII, so
 * an email is never an acceptable fallback. A null name means the member
 * left the account; the UI has its own wording for that.
 *
 * `.collect()` is safe for the same reason it is on notes: rows here are
 * bounded by human handovers, not by message volume.
 */
export const listEvents = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireConversationAccess(ctx, args.conversationId, "view");

    const events = await ctx.db
      .query("conversationEvents")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("asc")
      .collect();
    if (events.length === 0) return [];

    const cache = new Map<Id<"users">, string | null>();
    const nameOf = async (userId: Id<"users"> | undefined) => {
      if (!userId) return null;
      const hit = cache.get(userId);
      if (hit !== undefined) return hit;
      // Binds both fields on `by_user_account` — a `by_user` scan can
      // surface a different account's membership row for a user who
      // belongs to several. Same idiom as `contactNotes`' `withAuthors`.
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_account", (q) =>
          q.eq("userId", userId).eq("accountId", ctx.accountId),
        )
        .first();
      const value = membership ? (membership.fullName ?? "Member") : null;
      cache.set(userId, value);
      return value;
    };

    const out = [];
    for (const e of events) {
      out.push({
        _id: e._id,
        _creationTime: e._creationTime,
        kind: e.kind,
        source: e.source,
        actorUserId: e.actorUserId ?? null,
        targetUserId: e.targetUserId ?? null,
        actorName: await nameOf(e.actorUserId),
        targetName: await nameOf(e.targetUserId),
        previousName: await nameOf(e.previousUserId),
      });
    }
    return out;
  },
});

/**
 * Toggle the AI auto-reply bot for one conversation — the Inbox's
 * "Take over" / "Resume AI" banner. Convex port of `src/app/api/ai/
 * autoreply/[conversationId]/route.ts`'s POST handler (lines ~44-99).
 *
 * `paused: true` (Take over) — sets `aiAutoreplyDisabled`; when
 * `assignToMe` is also set, assigns the thread to the caller too
 * (mirrors the route's `if (assign_to_me) update.assigned_agent_id =
 * userId`). Since the assignee here is ALWAYS the caller themselves,
 * this is exactly the self-assignment case `conversations.assign`'s own
 * notification step exempts — see that mutation's doc comment — so no
 * `insertNotification` call is needed here either; it would only ever
 * no-op.
 *
 * `paused: false` (Resume AI) — clears the pause, releases ANY
 * assignment (not just the caller's own — the route's own comment: a
 * stale assignee from a prior handoff would otherwise keep the "human
 * owns this" eligibility gate tripped and make Resume AI a no-op), and
 * resets the bot's reply tally (`aiReplyCount: 0` — a metric, there
 * is no cap) + clears the flag note. `status` is deliberately left untouched in BOTH
 * branches, exactly like the route — unlike `assign`, which bumps it to
 * "pending".
 */
export const setAutoreplyPaused = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    paused: v.boolean(),
    assignToMe: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );

    if (args.paused) {
      await ctx.db.patch(args.conversationId, {
        aiAutoreplyDisabled: true,
        updatedAt: Date.now(),
      });

      if (args.assignToMe) {
        // Taking over a thread IS an assignment, even though it's a
        // self-assignment the notification path deliberately skips.
        const changed = await applyAssignment(ctx, {
          conversation,
          nextAssignee: ctx.userId,
          actorUserId: ctx.userId,
          source: "takeover",
        });
        await chargeLeadIfAgent(ctx, ctx.accountId, ctx.userId, args.conversationId);
        if (changed) {
          await dispatchConversationAssigned(ctx, {
            accountId: ctx.accountId,
            conversationId: args.conversationId,
            contactId: conversation.contactId,
            agentId: ctx.userId,
          });
        }
      }
    } else {
      await ctx.db.patch(args.conversationId, {
        aiAutoreplyDisabled: false,
        aiReplyCount: 0,
        aiHandoffSummary: undefined,
        updatedAt: Date.now(),
      });
      // Resume AI releases ANY assignment, not just the caller's own —
      // a stale assignee keeps the "human owns this" gate tripped. No
      // actor: the AI resuming is what released it, not a person
      // handing the thread to someone.
      await applyAssignment(ctx, {
        conversation,
        nextAssignee: undefined,
        source: "release",
      });
    }

    return { success: true as const, paused: args.paused };
  },
});

export const setStatus = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    status: v.union(
      v.literal("open"),
      v.literal("pending"),
      v.literal("closed"),
    ),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireConversationAccess(ctx, args.conversationId, "own");
    await ctx.db.patch(args.conversationId, {
      status: args.status,
      updatedAt: Date.now(),
    });
    return args.conversationId;
  },
});

/**
 * Zeroes `unreadCount` — the Inbox calls this the moment an agent opens
 * a thread. No `updatedAt` bump here: unlike `assign`/`setStatus`,
 * reading a thread isn't a change to the conversation's own state an
 * agent would expect reflected in "last updated" (matches the task
 * brief's own spec for this mutation).
 */
export const markRead = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireConversationAccess(ctx, args.conversationId, "view");
    await ctx.db.patch(args.conversationId, { unreadCount: 0 });
    return args.conversationId;
  },
});

/**
 * Ceiling on the badge `markUnread` restores, and on the messages it
 * reads to compute one. A run longer than this is already "lots of
 * unread" as far as the inbox badge communicates anything, and the cap
 * is what keeps this mutation's read set fixed rather than growing with
 * a thread the customer has been talking into for months.
 */
const MAX_RESTORED_UNREAD = 50;

/**
 * The inverse of `markRead`, for the misclick. Opening a thread zeroes
 * `unreadCount` the moment it renders (the Inbox's select handler, the
 * `?c=` deep-link, and `message-thread.tsx`'s own effect all call
 * `markRead`), so an agent who clicked the wrong row had no way back to
 * "still waiting on us" short of asking the customer to write again.
 *
 * Restores a COUNT, not a flag, because the badge renders a number —
 * and the original count is gone by the time this runs, so it's
 * recomputed as the trailing run of customer-authored messages: every
 * inbound message since the account itself last said anything. That's
 * the same set `markRead` would have cleared on a thread nobody had
 * opened yet. The walk is newest-first and stops at the first
 * non-customer message, so it reads that run and nothing more, capped
 * at `MAX_RESTORED_UNREAD`. A thread with no inbound messages at all
 * still comes back as 1: the agent explicitly asked for it to look
 * unread, and 0 would silently do nothing.
 *
 * No-ops when the conversation is already unread, so a double-click
 * can't stack the badge higher. No `updatedAt` bump, matching
 * `markRead`: read state isn't a change to the conversation itself, and
 * bumping it would shuffle the inbox order as a side effect of undoing
 * a click.
 */
export const markUnread = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );

    if (conversation.unreadCount > 0) return args.conversationId;

    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .take(MAX_RESTORED_UNREAD);

    let trailingInbound = 0;
    for (const message of recent) {
      if (message.senderType !== "customer") break;
      trailingInbound++;
    }

    await ctx.db.patch(args.conversationId, {
      unreadCount: Math.max(trailingInbound, 1),
    });
    return args.conversationId;
  },
});

/**
 * Resolves the Meta recipient phone (+ optional reply context) for a
 * conversation, scoped to `accountId` — the piece `send.ts`'s public
 * `send` action and `metaSend.sendReaction` both need before they can
 * call into `metaSend.ts`'s actions, which take `to`/`contextMessageId`
 * directly rather than a `conversationId` (see that module's header
 * comment on why the contact-phone lookup was deliberately left OUT of
 * those actions — this query is exactly that lookup, resurrected for
 * the two callers that DO still need it). An `internalQuery` rather
 * than folded into `metaSend.ts` itself, since it reads
 * `conversations`/`contacts`/`messages` — tables that file has never
 * needed to touch directly.
 *
 * Doubles as both callers' tenancy gate: throws the same `NOT_FOUND`
 * "doesn't exist" / "exists but isn't yours" conflation
 * `requireConversationAccess`'s own account check
 * (`convex/lib/conversationAccess.ts`) uses elsewhere in this file, for
 * either a foreign `conversationId` or a `replyToMessageId` that exists
 * but belongs to a different conversation — so a cross-account probe
 * can't distinguish "no such row" from "not yours" via either argument.
 * This query stays a hand-rolled check rather than calling that helper
 * directly: it's an `internalQuery` with a caller-supplied `accountId`
 * and no user session, so it has no `role`/`userId` to satisfy that
 * helper's ctx shape.
 *
 * A reply target that exists (in this conversation) but has no Meta
 * `messageId` yet (still sending, or failed) is NOT an error —
 * `contextMessageId` comes back `undefined` and the send proceeds
 * without reply context, mirroring `src/lib/whatsapp/send-message.ts`'s
 * own "warn and send without context" handling for the same case.
 */
export const resolveSendTarget = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    replyToMessageId: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
    }
    const contact = await ctx.db.get(conversation.contactId);
    if (!contact) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
    }

    let contextMessageId: string | undefined;
    if (args.replyToMessageId) {
      const parent = await ctx.db.get(args.replyToMessageId);
      if (!parent || parent.conversationId !== args.conversationId) {
        throw new ConvexError({ code: "NOT_FOUND", entity: "replyToMessage" });
      }
      contextMessageId = parent.messageId;
    }

    return { to: contact.phone, contextMessageId };
  },
});

/**
 * A customer replied — bring the thread back (spec 2026-07-26
 * §"Stopping and returning").
 *
 * GATED ON NOTHING, deliberately. This deliberately does NOT live in
 * `leadAnalysisEngine.onInbound`, which returns early when
 * `leadAnalysisConfigs.enabled` is false: putting it there would mean
 * that switching Lead Analysis off strands every already-archived
 * conversation out of the Inbox permanently, with no way back. Archive
 * is a Lead Analysis feature; UN-archive is a safety property of the
 * Inbox itself.
 *
 * No-ops on a conversation that is not archived, so it is free to call
 * on every single inbound.
 */
/**
 * The un-archive itself, callable inside another mutation's transaction.
 *
 * Extracted 2026-07-28 so `messages.ts`'s
 * `insertMessageAndUpdateConversation` can run it in the SAME
 * transaction as the message insert. It previously only ran from
 * `ingest.ts`'s best-effort fan-out, which swallows failures by design —
 * so a swallowed failure left an archived customer invisible in every
 * lane while they were actively writing in, and nothing ever retried.
 * P2's own spec called for the transactional placement; the shipped code
 * did not do it.
 *
 * The old reasoning was "restoring a thread must never fail message
 * ingestion". That weighs the wrong risk: the alternative to a failed
 * ingest is not nothing, it is a stored message whose sender the
 * business cannot see. A rolled-back transaction means Meta retries the
 * webhook, which is recoverable; an invisible customer is not.
 *
 * No-ops on a conversation that is not archived, so it is free to call
 * on every single inbound.
 */
export async function unarchiveOnInboundCore(
  ctx: { db: MutationCtx["db"] },
  args: {
    accountId: Id<"accounts">;
    conversationId: Id<"conversations">;
    contactId: Id<"contacts">;
  },
): Promise<void> {
  {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;
    if (conversation.archivedAt === undefined) return;

    await ctx.db.patch(args.conversationId, {
      archivedAt: undefined,
      archivedReason: undefined,
      archivedNote: undefined,
      archivedByUserId: undefined,
      returnedAt: Date.now(),
    });

    const analysis = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    // CLEARED, not `false` — see the representation note in schema.ts.
    if (analysis) await ctx.db.patch(analysis._id, { archived: undefined });

    // Same recipient rule as an inbound on an unassigned thread: the
    // assigned agent if there is one, else everyone who works the whole
    // pool (supervisor+).
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    const contact = await ctx.db.get(args.contactId);
    const who = contact?.name?.trim() || contact?.phone || "A contact";

    for (const userId of recipientsForInbound({
      assignedToUserId: conversation.assignedToUserId ?? null,
      members,
    })) {
      await insertNotification(ctx, {
        accountId: args.accountId,
        userId,
        type: "lead_returned",
        conversationId: args.conversationId,
        contactId: args.contactId,
        title: `${who} replied`,
        body: "An archived lead came back.",
      });
    }
  }
}

/**
 * Thin wrapper kept so existing tests and any future caller keep
 * working. The behaviour lives in `unarchiveOnInboundCore` above, which
 * `messages.ts` calls inside the message transaction — the placement
 * that actually guarantees an archived customer becomes visible the
 * moment they write. `ingest.ts` no longer calls this.
 */
export const unarchiveOnInbound = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    await unarchiveOnInboundCore(ctx, args);
  },
});
