import { accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// The contact panel's activity feed.
//
// DELIBERATELY NOT a five-source merge. The design spec called for
// merging notes + funnelTransitions + contactTags + salesChecklists +
// deals, but four of those already write a `contactNotes` row when they
// happen — `funnel.ts:318` (deal won/lost/reopened),
// `salesChecklists.ts:109` (item completed), `aiTagging.ts:471` (tag
// accepted), `qualificationEngine.ts:2221`. Merging them again renders
// the same event twice.
//
// So the feed is: every note, plus the ONE thing notes do not already
// capture — a non-terminal funnel stage move. `contactTags` is excluded
// on different grounds: a tag is current state, not an event, and the
// panel shows it in its own section.
// ============================================================

/** Stages whose transition ALREADY produces a note in `funnel.ts`, on its
 *  own `stage` (branches 1 and 2 below). Terminal, so a transition landing
 *  on one of these is always note-mirrored regardless of what came before. */
const NOTE_MIRRORED_STAGES = new Set(["purchased", "lost"]);

/**
 * Mirrors the THREE branches in `funnel.ts` (~lines 318-339) that insert a
 * `contactNotes` row on a stage transition — this is the exact set a
 * `stage` entry must be dropped for, or the deal outcome (and its reopen)
 * renders twice: once as the note, once as the raw transition.
 *
 *   1. `stage === "purchased"`                        -> "🏆 Deal won"
 *   2. `stage === "lost"`                              -> "❌ Deal lost"
 *   3. `previousStage === "purchased" || "lost"`       -> "↩️ Deal reopened"
 *
 * Branch 3 has no field to read directly: `funnelTransitions` doesn't
 * store `previousStage`. `funnel.ts` computes it from
 * `conversation.funnel?.stage` — the conversation's most recent stage
 * before this transition applied — which is exactly the transition
 * immediately preceding this one IN THE SAME CONVERSATION. `predecessor`
 * must therefore be looked up per-conversation, never across a contact's
 * other threads (see `predecessorOf` below).
 */
function isNoteMirroredTransition(
  transition: Doc<"funnelTransitions">,
  predecessor: Doc<"funnelTransitions"> | undefined,
): boolean {
  if (NOTE_MIRRORED_STAGES.has(transition.stage)) return true;
  return predecessor !== undefined && NOTE_MIRRORED_STAGES.has(predecessor.stage);
}

async function requireOwnContact(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  contactId: Id<"contacts">,
) {
  const contact = await ctx.db.get(contactId);
  if (!contact || contact.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
  }
  return contact;
}

export const listForContact = accountQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    await requireOwnContact(ctx, args.contactId);

    const [notes, transitions] = await Promise.all([
      ctx.db
        .query("contactNotes")
        .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
        .order("desc")
        .collect(),
      ctx.db
        .query("funnelTransitions")
        .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
        .order("desc")
        .collect(),
    ]);

    // Author resolution, cached per user for the whole call — a contact's
    // history is usually two or three people, so this is a handful of
    // reads rather than one per row.
    const cache = new Map<
      string,
      { userId: Id<"users">; fullName?: string; avatarUrl?: string } | null
    >();
    const resolve = async (userId: Id<"users">) => {
      const hit = cache.get(userId);
      if (hit !== undefined) return hit;
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_account", (q) =>
          q.eq("userId", userId).eq("accountId", ctx.accountId),
        )
        .first();
      const value = membership
        ? { userId, fullName: membership.fullName, avatarUrl: membership.avatarUrl }
        : null;
      cache.set(userId, value);
      return value;
    };

    const noteEntries = await Promise.all(
      notes.map(async (note) => ({
        kind: "note" as const,
        at: note._creationTime,
        note: {
          ...note,
          author: note.createdByUserId ? await resolve(note.createdByUserId) : null,
        },
      })),
    );

    // Group each conversation's transitions while preserving the
    // newest-first order already fetched above. A contact can hold
    // several threads, so a predecessor must be found WITHIN one
    // conversation's own history — interleaving two conversations by
    // time would let one thread's terminal stage look like the
    // predecessor of an unrelated thread's move.
    const byConversation = new Map<Id<"conversations">, Doc<"funnelTransitions">[]>();
    for (const tr of transitions) {
      const list = byConversation.get(tr.conversationId);
      if (list) list.push(tr);
      else byConversation.set(tr.conversationId, [tr]);
    }
    // Each per-conversation list is still newest-first (desc), so index
    // i+1 is chronologically BEFORE index i — i.e. index i+1 is index i's
    // predecessor. Spelled out explicitly here because a descending list
    // makes "next element = predecessor" easy to get backwards.
    const predecessorOf = new Map<Id<"funnelTransitions">, Doc<"funnelTransitions">>();
    for (const list of byConversation.values()) {
      for (let i = 0; i < list.length - 1; i++) {
        predecessorOf.set(list[i]._id, list[i + 1]);
      }
    }

    const stageEntries = await Promise.all(
      transitions
        .filter((tr) => !isNoteMirroredTransition(tr, predecessorOf.get(tr._id)))
        .map(async (tr) => ({
          kind: "stage" as const,
          at: tr._creationTime,
          stage: tr.stage,
          auto: tr.auto,
          author: tr.byUserId ? await resolve(tr.byUserId) : null,
        })),
    );

    return [...noteEntries, ...stageEntries].sort((a, b) => b.at - a.at);
  },
});
