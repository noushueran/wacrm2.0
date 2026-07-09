import { accountMutation, accountQuery } from "./lib/auth";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";
import { generateInviteToken } from "./lib/inviteToken";
import type { Id } from "./_generated/dataModel";

// ============================================================
// Invitations — port of `supabase/migrations/019_invitation_rpcs.sql`'s
// `peek_invitation`/`redeem_invitation` SECURITY DEFINER RPCs, plus the
// admin-facing CRUD (`create`/`list`/`revoke`) that used to be plain
// RLS-guarded REST routes (`src/app/api/account/invitations/route.ts`).
//
// `create`/`list`/`revoke` are built on `accountMutation`/`accountQuery`
// exactly like every other admin-gated, account-scoped function in this
// codebase — `ctx.accountId` comes from the caller's own membership,
// never a client-supplied arg.
//
// `peek`/`redeem` are DELIBERATELY NOT — see the comment directly above
// each for why.
// ============================================================

const DEFAULT_INVITE_EXPIRY_DAYS = 7;
const MAX_INVITE_EXPIRY_DAYS = 365;

/**
 * Port of `clampExpiryDays` (`src/lib/auth/invitations.ts`): clamps to
 * `[1, MAX_INVITE_EXPIRY_DAYS]`, falling back to the 7-day default for
 * missing/non-finite/non-positive input.
 */
function clampExpiryDays(expiresInDays: number | undefined): number {
  if (
    expiresInDays === undefined ||
    !Number.isFinite(expiresInDays) ||
    expiresInDays <= 0
  ) {
    return DEFAULT_INVITE_EXPIRY_DAYS;
  }
  return Math.min(Math.floor(expiresInDays), MAX_INVITE_EXPIRY_DAYS);
}

/**
 * Every account-scoped table `redeem_invitation` (019) checks before
 * letting a caller abandon their current account — the same 11 tables
 * from that migration's `UNION ALL SELECT 1 FROM ... WHERE account_id =
 * v_old_account_id` existence check, translated 1:1 to Convex table
 * names (e.g. `message_templates` -> `messageTemplates`). Written as
 * 11 explicit, literally-named queries (not a loop over a table-name
 * array) so each one is unambiguous to audit and to typecheck — this
 * gates a security-relevant "would joining orphan real data?" decision,
 * so favors being tedious-but-obvious over being clever.
 */
async function accountHasDomainData(
  ctx: { db: MutationCtx["db"] },
  accountId: Id<"accounts">,
): Promise<boolean> {
  const [
    contact,
    conversation,
    broadcast,
    automation,
    flow,
    pipeline,
    messageTemplate,
    tag,
    customField,
    contactNote,
    whatsappConfig,
  ] = await Promise.all([
    ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
    ctx.db
      .query("conversations")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
    ctx.db
      .query("broadcasts")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
    ctx.db
      .query("automations")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
    ctx.db
      .query("flows")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
    ctx.db
      .query("pipelines")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
    ctx.db
      .query("messageTemplates")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
    ctx.db
      .query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
    ctx.db
      .query("customFields")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
    ctx.db
      .query("contactNotes")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
    ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  ]);

  return [
    contact,
    conversation,
    broadcast,
    automation,
    flow,
    pipeline,
    messageTemplate,
    tag,
    customField,
    contactNote,
    whatsappConfig,
  ].some((row) => row !== null);
}

/**
 * Admin+ creates an invite link for the caller's own account. Generates
 * the plaintext token + its hash (see `convex/lib/inviteToken.ts`),
 * persists only the hash, and returns the plaintext exactly once — the
 * caller (a future settings UI) is responsible for showing it to the
 * admin and never fetching it again.
 */
export const create = accountMutation({
  args: {
    // "owner" is structurally excluded here (unlike `members.setRole`,
    // which accepts it on purpose to exercise a runtime guard) — this
    // mirrors migration 017's own `CHECK (role <> 'owner')` on
    // `account_invitations.role`, which the Convex schema already
    // encodes the same way (`convex/schema.ts`'s `accountInvitations`).
    // There is no equivalent runtime guard to port because there is no
    // way to construct an invalid request in the first place.
    role: v.union(v.literal("admin"), v.literal("agent"), v.literal("viewer")),
    expiresInDays: v.optional(v.number()),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const { token, tokenHash } = await generateInviteToken();
    const days = clampExpiryDays(args.expiresInDays);
    const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;

    const invitationId = await ctx.db.insert("accountInvitations", {
      accountId: ctx.accountId,
      tokenHash,
      role: args.role,
      createdByUserId: ctx.userId,
      label: args.label,
      expiresAt,
    });

    return { invitationId, token, expiresAt };
  },
});

/**
 * Admin+ lists the caller's own account's outstanding invites.
 * `tokenHash` is deliberately stripped from every row before it's
 * returned — nothing in the UI needs it (it's a lookup key for
 * `peek`/`redeem`, not a display field), so it never leaves the server,
 * on the same "don't expose more than the caller needs" principle as
 * `peek`'s minimal success payload below.
 */
export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");

    const invitations = await ctx.db
      .query("accountInvitations")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();

    return invitations.map((invitation) => ({
      _id: invitation._id,
      _creationTime: invitation._creationTime,
      accountId: invitation.accountId,
      role: invitation.role,
      createdByUserId: invitation.createdByUserId,
      label: invitation.label,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      acceptedByUserId: invitation.acceptedByUserId,
      // `tokenHash` deliberately omitted — see this function's doc
      // comment.
    }));
  },
});

/** Admin+ revokes (deletes) one of the caller's own account's invites. */
export const revoke = accountMutation({
  args: { invitationId: v.id("accountInvitations") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const invitation = await ctx.db.get(args.invitationId);
    if (!invitation || invitation.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "invitation" });
    }
    await ctx.db.delete(args.invitationId);
  },
});

// ============================================================
// peek + redeem — DELIBERATELY built on the raw `query`/`mutation` from
// `./_generated/server`, NOT `accountQuery`/`accountMutation`.
//
// Both act on the INVITE's account, which is never the caller's own
// `ctx.accountId`. `accountQuery`/`accountMutation` derive `ctx.accountId`
// from the CALLER's own membership — using them here would either:
//   - reject an anonymous caller outright (`peek` must work for a
//     signed-out visitor previewing a join link before they sign in,
//     mirroring 019 granting `peek_invitation` to `anon, authenticated`),
//     or
//   - silently scope every read/write to the wrong account (`redeem`
//     moves the caller INTO a different account than whatever
//     `ctx.accountId` would have resolved to — the entire point of the
//     function is to change which account the caller belongs to).
// This is a correctness requirement, not just unnecessary ceremony.
// ============================================================

/**
 * Port of `peek_invitation` (019). Public/anonymous — no auth check at
 * all, by design (same as the SQL granting EXECUTE to `anon`). Takes an
 * already-hashed `tokenHash` (not the plaintext token) as its arg: the
 * caller — e.g. a future `/join/[token]` page — hashes the plaintext
 * from the URL via `hashInviteToken` before calling this, the same way
 * `peek_invitation`'s Postgres route handler hashed it before the RPC
 * call. The plaintext token itself never needs to reach this function.
 *
 * Returns a uniform `{ ok, ... }` shape and NOTHING ELSE for a valid
 * invite (no ids, no `accountId`, no `tokenHash`) — only the three
 * fields a join page needs to render "You're being invited to
 * <account> as <role>".
 */
export const peek = query({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const invitation = await ctx.db
      .query("accountInvitations")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .first();

    if (!invitation) {
      return { ok: false as const, reason: "not_found" as const };
    }
    if (invitation.acceptedAt !== undefined) {
      return { ok: false as const, reason: "used" as const };
    }
    if (invitation.expiresAt <= Date.now()) {
      return { ok: false as const, reason: "expired" as const };
    }

    const account = await ctx.db.get(invitation.accountId);
    return {
      ok: true as const,
      accountName: account?.name ?? "",
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    };
  },
});

/**
 * Port of `redeem_invitation` (019). Authenticated (via `getAuthUserId`
 * directly, not `accountQuery`/`accountMutation` — see the section
 * comment above), acting on the invite's account. Also takes
 * `tokenHash`, not the plaintext token, for the same reason as `peek`.
 *
 * Order of checks mirrors 019 exactly: invite validity, then the
 * caller's current-account safety checks, then the move. One
 * mechanical difference: 019 takes an explicit `SELECT ... FOR UPDATE`
 * row lock to stop two concurrent redeems of the same token — Convex
 * mutations are already fully serialized against any other mutation
 * touching the same documents (optimistic concurrency control), so
 * there's no separate lock primitive to port; the transactional
 * guarantee is automatic here.
 */
export const redeem = mutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, args) => {
    const callerId = await getAuthUserId(ctx);
    if (!callerId) throw new ConvexError({ code: "UNAUTHENTICATED" });

    const invitation = await ctx.db
      .query("accountInvitations")
      .withIndex("by_token_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .first();
    if (!invitation) {
      throw new ConvexError({
        code: "INVALID_INVITATION",
        reason: "not_found",
      });
    }
    if (invitation.acceptedAt !== undefined) {
      throw new ConvexError({ code: "INVALID_INVITATION", reason: "used" });
    }
    if (invitation.expiresAt <= Date.now()) {
      throw new ConvexError({ code: "INVALID_INVITATION", reason: "expired" });
    }

    const callerMembership = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", callerId))
      .first();
    if (!callerMembership) {
      // Defensive — mirrors 019's own "every authenticated user has a
      // profile" comment. Reuses the same `NO_ACCOUNT` code
      // `accountQuery`/`accountMutation` throw for "authenticated, no
      // membership yet" (`convex/lib/auth.ts`) rather than inventing a
      // parallel vocabulary for the same state.
      throw new ConvexError({ code: "NO_ACCOUNT" });
    }

    // Edge case: the inviter sent themselves a link, or the caller is
    // somehow already in the inviter's account.
    if (callerMembership.accountId === invitation.accountId) {
      throw new ConvexError({ code: "ALREADY_MEMBER" });
    }

    // Safety: the caller must be the SOLE OWNER of their current
    // account (i.e. a fresh personal account from bootstrap, or a
    // prior `members.remove`). Any other state means they're either a
    // member of another shared account (joining a second would
    // silently orphan their access to the first) or the owner of an
    // account with teammates (they'd abandon their team to join the
    // inviter's) — either way, the safe answer is "use a different
    // login".
    const oldAccountId = callerMembership.accountId;
    const oldAccount = await ctx.db.get(oldAccountId);
    if (!oldAccount || oldAccount.ownerUserId !== callerId) {
      throw new ConvexError({ code: "NOT_SOLE_OWNER" });
    }

    // Belt: even if they own their account, refuse if it has any
    // domain data — joining would orphan their contacts, deals,
    // broadcasts, automations, flows, templates, etc.
    if (await accountHasDomainData(ctx, oldAccountId)) {
      throw new ConvexError({ code: "ACCOUNT_HAS_DATA" });
    }

    // Move the membership in place — mirrors 019's own
    // `UPDATE profiles SET account_id = .., account_role = ..`, which
    // leaves every other profile column (there, full_name/email; here,
    // fullName/email/avatarUrl) untouched. (019 also orders this before
    // deleting the old account "so the cascade doesn't nuke the
    // caller's profile too" — Convex has no cascade deletes at all, so
    // that specific hazard doesn't apply here, but the move-before-
    // delete order is kept anyway so no membership ever points at a
    // deleted account, even momentarily.)
    await ctx.db.patch(callerMembership._id, {
      accountId: invitation.accountId,
      role: invitation.role,
    });

    await ctx.db.patch(invitation._id, {
      acceptedAt: Date.now(),
      acceptedByUserId: callerId,
    });

    // Clean up the orphaned personal account — verified empty above,
    // and no membership references it anymore (just moved away).
    await ctx.db.delete(oldAccountId);

    return invitation.accountId;
  },
});
