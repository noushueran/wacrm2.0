import { mutation, query, internalQuery } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";

/**
 * First-login bootstrap: gives the current user exactly one account (as
 * `owner`) the first time they call this, and is a no-op on every call
 * after that. Idempotency is keyed off `memberships.by_user` — a user can
 * only ever have one membership row created here, so "have I already been
 * bootstrapped" and "what's my account" are the same lookup.
 */
export const bootstrapAccount = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });

    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) return existing.accountId;

    const user = await ctx.db.get(userId);
    const accountId = await ctx.db.insert("accounts", {
      name: user?.email ?? "My account",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId,
      role: "owner",
      fullName: user?.name,
      email: user?.email,
    });
    return accountId;
  },
});

/**
 * The authenticated user plus their (first) account membership and role.
 * `null` if unauthenticated or authenticated but not yet bootstrapped.
 */
export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!membership) return null;

    const user = await ctx.db.get(userId);
    return { user, accountId: membership.accountId, role: membership.role };
  },
});

/**
 * The exact projection the client-side `useAuth()` hook
 * (src/hooks/use-auth.tsx) needs to build its `user` / `profile` /
 * `account` context — flattened so the hook never joins client-side.
 *
 * Sourced from the caller's `memberships` row (the denormalized
 * `fullName`/`email`/`avatarUrl`/`role` snapshot) plus the `accounts`
 * row, with the `users` document as a fallback for name/email/avatar.
 *
 * Returns `null` when unauthenticated OR authenticated-but-not-yet-
 * bootstrapped (no membership); the hook treats that second case as the
 * cue to call `bootstrapAccount` once. Every string field is narrowed to
 * `| null` (never `undefined`) so the hook's `Profile` mapping type-checks.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!membership) return null;

    const account = await ctx.db.get(membership.accountId);
    // A membership without its account is a data-integrity impossibility
    // in normal flow, but guard so the hook gets a clean `null` rather
    // than a partial object it can't map.
    if (!account) return null;

    const user = await ctx.db.get(userId);

    return {
      userId,
      name: membership.fullName ?? user?.name ?? null,
      email: membership.email ?? user?.email ?? null,
      avatarUrl: membership.avatarUrl ?? user?.image ?? null,
      accountId: membership.accountId,
      accountRole: membership.role,
      account: {
        id: account._id,
        name: account.name,
        defaultCurrency: account.defaultCurrency,
      },
    };
  },
});

/**
 * The caller updates their OWN account membership's display profile —
 * `fullName`/`avatarUrl`, the same denormalized snapshot `me` above
 * reads back (Phase 8, Task 3: the settings "profile" form). A plain
 * `mutation` (not `accountMutation`) — matches this file's existing
 * `bootstrapAccount`/`currentUser`/`me` style of deriving identity via
 * `getAuthUserId` + a direct `memberships.by_user` lookup, rather than
 * scoping by `ctx.accountId`: there's no cross-tenant reach to guard
 * here, since a user only ever has the one membership row this looks
 * up, and this mutation never takes an accountId/userId argument a
 * client could supply to target anyone else's.
 *
 * `avatarUrl` is patched only when supplied — the same "omitted
 * optional arg carries no key at all" idiom `whatsappConfig.upsert`/
 * `aiConfig.upsert` use for their own optional fields, so clearing the
 * avatar field is never an accidental side effect of a name-only save.
 * `name` is required on every call, mirroring `me`'s own "the profile
 * form always has a name field" shape.
 */
export const updateProfile = mutation({
  args: {
    name: v.string(),
    avatarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!membership) throw new ConvexError({ code: "NO_ACCOUNT" });

    const patch: { fullName: string; avatarUrl?: string } = {
      fullName: args.name,
    };
    if (args.avatarUrl !== undefined) patch.avatarUrl = args.avatarUrl;

    await ctx.db.patch(membership._id, patch);
    return membership._id;
  },
});

/**
 * Server-only counterpart to the membership lookup `lib/auth.ts`'s
 * `withAccount` performs for every `accountQuery`/`accountMutation` —
 * for the PUBLIC actions (`send.ts`'s `send`, `reactions.reactToMeta`,
 * Phase 8 Task 4) that need the exact same "trustworthy account+role
 * from the caller's own session" derivation but have no `ctx.db` of
 * their own to run it inline (an action's `ctx` has no `db`; only
 * `runQuery`/`runMutation`/`runAction`). Callers resolve
 * `getAuthUserId(ctx)` themselves first (an action's `ctx.auth` supports
 * it exactly like a query/mutation ctx's — `getAuthUserId` only ever
 * needs `ctx.auth`), then call this via
 * `ctx.runQuery(internal.accounts.accountContextForUser, {userId})`.
 *
 * Returns `null` for "authenticated but not yet bootstrapped" (mirrors
 * `withAccount`'s own `NO_ACCOUNT` case, and `currentUser`/`me`'s `null`
 * contract above) rather than throwing, so each caller maps it to its
 * own action-specific `ConvexError` instead of this query dictating
 * one — this is a data lookup, not an auth gate itself. Same "first
 * membership row" resolution as `withAccount`/`currentUser`/`me`
 * (`by_user`, `.first()`) — a user has exactly one membership in this
 * codebase's current model, so there's nothing to disambiguate.
 */
export const accountContextForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .first();
    if (!membership) return null;
    return { accountId: membership.accountId, role: membership.role };
  },
});
