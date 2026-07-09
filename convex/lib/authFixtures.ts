import { v } from "convex/values";
import { accountMutation, accountQuery } from "./auth";

// ============================================================
// Test-only fixtures for convex/lib/auth.test.ts.
//
// `accountQuery`/`accountMutation` are `customFunctions` builders, not
// plain callables — convex-test can only invoke them through a real,
// registered Convex function (a `FunctionReference` it resolves against
// the `modules` glob), the same way production consumers (e.g. the
// future `convex/contacts.ts`) will. These two tiny endpoints exist
// purely to give the test suite that entry point; they carry no
// business logic beyond echoing what the wrapper injected into `ctx`.
// ============================================================

const roleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("agent"),
  v.literal("viewer"),
);

export const whoAmI = accountQuery({
  args: {},
  handler: async (ctx) => ({
    userId: ctx.userId,
    accountId: ctx.accountId,
    role: ctx.role,
  }),
});

export const requireAtLeast = accountMutation({
  args: { min: roleValidator },
  handler: async (ctx, args) => {
    ctx.requireRole(args.min);
    return { ok: true as const };
  },
});
