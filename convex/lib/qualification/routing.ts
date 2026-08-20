import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

// ============================================================
// The lead-routing rule: who a lead should go to, given a service name.
// Extracted from `qualificationEngine.offerContext` (spec
// 2026-07-27-inbox-lanes §Chasing ownership) so the consent-offer flow
// and the Chasing auto-assign sweep share ONE rule. Two copies would
// drift, and the four `FallbackCause` values exist precisely because
// naming the wrong cause costs an admin a pointless hunt.
//
// This decides WHO IS ELIGIBLE. It deliberately does not rank them: the
// two callers rank differently (offers by fewest recent accepts, Chasing
// by current Chasing load), and folding both in would make the shared
// piece the union of two policies rather than their intersection.
// ============================================================

// Reader-typed ctx (the `lib/qualification/track.ts` pattern) so both
// `internalQuery` and mutation handlers can call this — a MutationCtx's
// db is a strict superset, so either call site typechecks.
type DbReadCtx = { db: QueryCtx["db"] };

/**
 * Why a lead had to be offered to the whole team instead of the agents
 * linked to its service tag.
 *
 * A plain `usedFallback: boolean` used to stand on the `offer` variant,
 * which collapsed four genuinely different misconfigurations into a
 * single admin message ("no agent is linked to that tag") that is only
 * accurate for one of them. Each cause has a different remedy, and
 * naming the wrong one costs an admin a pointless hunt — so each
 * carries its own text. Listing them in one place also means a new
 * fallback path cannot be added without choosing what to tell the admin.
 */
export type FallbackCause =
  /** Qualified without the AI naming a service, so there was never a tag
   *  to route by. Not a routing misconfiguration at all. */
  | "no_service_name"
  /** No `tags` row matches the service name. Remedy: create the tag. */
  | "tag_missing"
  /** The tag exists with zero `memberTags` links. Remedy: link agents. */
  | "tag_unlinked"
  /** Links exist, but no linked member can take a lead — each is missing
   *  a phone or holds an `admin`/`viewer` role. Remedy: a phone number
   *  or a role change, NOT another link. */
  | "links_ineligible";

/** A member who could take a lead at all: right role, reachable. */
export type EligibleMember = { userId: Id<"users">; phone: string; name: string };

export type RoutingResult = {
  /** Every eligible member in the account, keyed by user — the superset
   *  `poolIds` is drawn from, so callers can rank without re-reading. */
  eligibleById: Map<Id<"users">, EligibleMember>;
  /** Who to route to: the tag's eligible links, or the whole eligible
   *  team when `fallback` is set. */
  poolIds: Id<"users">[];
  /** `null` on the happy path (routed by tag); otherwise why we widened. */
  fallback: FallbackCause | null;
};

/**
 * Resolves who is eligible to receive a lead for `serviceName`, and why
 * the tag-linked pool had to be widened to the whole team when it did.
 */
export async function resolveRouting(
  ctx: DbReadCtx,
  args: { accountId: Id<"accounts">; serviceName: string | null },
): Promise<RoutingResult> {
  const serviceName = args.serviceName;
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
    .collect();
  // Everyone who could take a lead at all: right role, reachable.
  const eligibleById = new Map<Id<"users">, EligibleMember>();
  for (const m of memberships) {
    if (!m.phone) continue;
    if (m.role !== "agent" && m.role !== "supervisor") continue;
    eligibleById.set(m.userId, {
      userId: m.userId,
      phone: m.phone,
      name: m.fullName ?? m.email ?? "Team member",
    });
  }

  // Who the service tag routes to, computed BEFORE subtracting anyone
  // already tried — an empty set here means no routing intent was ever
  // expressed, which is what licenses the whole-team fallback. This is
  // deliberately NOT the "linked people exist but have all passed"
  // case: there the intent WAS expressed and honoured, so we fall
  // through to `exhausted` and let a human decide instead of silently
  // overriding a deliberate configuration.
  let poolIds: Id<"users">[] = [];
  let fallback: FallbackCause | null = null;
  if (!serviceName) {
    fallback = "no_service_name";
  } else {
    // the service tag (auto-created at completion)
    const tags = await ctx.db
      .query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    const serviceTag = tags.find(
      (t) => t.name.trim().toLowerCase() === serviceName.trim().toLowerCase(),
    );
    if (!serviceTag) {
      // Reachable: `tagContactForService` runs best-effort inside a
      // try/catch at completion, so the row can simply never exist.
      fallback = "tag_missing";
    } else {
      const links = await ctx.db
        .query("memberTags")
        .withIndex("by_account_tag", (q) =>
          q.eq("accountId", args.accountId).eq("tagId", serviceTag._id),
        )
        .collect();
      poolIds = links.map((l) => l.userId).filter((id) => eligibleById.has(id));
      // Someone linked but unreachable is a different problem, and a
      // different remedy, from nobody linked at all.
      if (poolIds.length === 0) {
        fallback = links.length === 0 ? "tag_unlinked" : "links_ineligible";
      }
    }
  }
  // Widen to the whole team rather than lose the lead.
  if (fallback) poolIds = Array.from(eligibleById.keys());

  return { eligibleById, poolIds, fallback };
}
