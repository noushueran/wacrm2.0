import { mutation, query, internalQuery } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { hasMinRole } from "./lib/roles";

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
 * ISO-4217 codes offered by the currency picker (`src/lib/
 * currency.ts`'s `CURRENCIES`). Duplicated here — codes only, not the
 * labels/symbols — rather than imported: this codebase deliberately
 * keeps `convex/` from reaching across into `src/` (see
 * `convex/automationsEngine.ts`'s and `convex/lib/automations/
 * validate.ts`'s own "inlined rather than imported from `@/...`"
 * comments for the same convex/src boundary), so this list must be
 * kept in sync by hand if `CURRENCIES` ever grows.
 */
const KNOWN_CURRENCY_CODES: ReadonlySet<string> = new Set([
  "USD",
  "EUR",
  "GBP",
  "INR",
  "AUD",
  "CAD",
  "BRL",
  "JPY",
  "CNY",
  "AED",
  "ZAR",
  "NGN",
  "SGD",
  "MXN",
]);

/**
 * Sets the account-wide default currency — an admin+ action
 * (`src/components/settings/deals-settings.tsx`'s "Deals" settings
 * panel gates its own control on `canEditSettings` client-side; this
 * mutation is the server-side enforcement of that same admin-only
 * rule, the Convex counterpart to the Postgres original's
 * `is_account_member(account_id, 'admin')` RLS policy).
 *
 * Same identity derivation as `updateProfile` above — `getAuthUserId`
 * + a direct `memberships.by_user` lookup, not `accountMutation` —
 * matching this file's own style of deriving identity inline rather
 * than through `lib/auth.ts`'s wrapper. UNLIKE `updateProfile`,
 * though, this patches the *shared* `accounts` row rather than only
 * the caller's own membership, so (unlike `updateProfile`) a
 * `hasMinRole` check against the caller's own role is required here —
 * without it, a plain agent/viewer could change an account-wide
 * setting through an endpoint meant only for the caller's own data.
 *
 * `currency` is checked against `KNOWN_CURRENCY_CODES` above rather
 * than accepted as-is: an arbitrary string here would silently corrupt
 * every `formatCurrency` call across the account, and the valid set is
 * already small and known.
 */
export const setDefaultCurrency = mutation({
  args: { currency: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });

    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!membership) throw new ConvexError({ code: "NO_ACCOUNT" });

    if (!hasMinRole(membership.role, "admin")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "admin" });
    }

    if (!KNOWN_CURRENCY_CODES.has(args.currency)) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `unknown currency: ${args.currency}`,
      });
    }

    await ctx.db.patch(membership.accountId, {
      defaultCurrency: args.currency,
    });
    return membership.accountId;
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
