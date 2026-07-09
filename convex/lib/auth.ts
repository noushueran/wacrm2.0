import {
  customQuery,
  customMutation,
  customCtx,
} from "convex-helpers/server/customFunctions";
import { query, mutation, type QueryCtx } from "../_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { hasMinRole, type AccountRole } from "./roles";

// ============================================================
// The security spine — Convex's replacement for Supabase Row-Level
// Security. Every tenant-scoped query/mutation must be built with
// `accountQuery`/`accountMutation` instead of the raw `query`/`mutation`
// from `_generated/server`, so that:
//   1. an unauthenticated caller never reaches a handler body
//      (`UNAUTHENTICATED`);
//   2. an authenticated caller with no account membership never reaches
//      a handler body (`NO_ACCOUNT`);
//   3. every handler gets a trustworthy `ctx.accountId`/`ctx.role`
//      derived server-side from the caller's own `memberships` row —
//      never from client-supplied args — so a handler that scopes its
//      DB reads/writes to `ctx.accountId` cannot leak across tenants;
//   4. role checks are a one-line `ctx.requireRole(min)` away.
// ============================================================

// `customCtx`'s `InCtx` type parameter can't be inferred from a bare,
// unannotated `(ctx) => ...` callback (there's nothing here for
// TypeScript to infer it from), so it falls back to its constraint,
// `Record<string, any>` — which has no `auth` property, so
// `getAuthUserId(ctx)` below fails to typecheck without this
// annotation. `QueryCtx` (not `MutationCtx`) is the right one to name:
// this same `withAccount` is reused for both `accountQuery` and
// `accountMutation` below, and a callback typed to accept `QueryCtx`
// can safely be called with an actual `MutationCtx` too (its `db` is a
// strict superset — every read method `QueryCtx` has, `MutationCtx`
// also has), so one annotation covers both call sites.
const withAccount = customCtx(async (ctx: QueryCtx) => {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });

  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (!membership) throw new ConvexError({ code: "NO_ACCOUNT" });

  const role = membership.role as AccountRole;
  return {
    userId,
    accountId: membership.accountId,
    role,
    requireRole: (min: AccountRole) => {
      if (!hasMinRole(role, min)) throw new ConvexError({ code: "FORBIDDEN", min });
    },
  };
});

export const accountQuery = customQuery(query, withAccount);
export const accountMutation = customMutation(mutation, withAccount);
