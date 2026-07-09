import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";

// ============================================================
// WhatsApp Cloud API connection — one row per account
// (`convex/schema.ts`'s `whatsappConfig`, Convex counterpart to the
// UNIQUE(account_id) `whatsapp_config` table migration 017 left
// behind). This module is the data layer only: verifying credentials
// against Meta, registering the phone number for inbound webhooks, and
// encrypting `accessToken` at rest are all application-layer concerns
// (`src/app/api/whatsapp/config/route.ts`) that must happen BEFORE
// calling `upsert` — this module just persists whatever it's given,
// exactly like `apiKeys.ts` never sees a plaintext key it didn't
// itself generate. Built on `accountQuery`/`accountMutation` (never
// the raw `query`/`mutation`), so `ctx.accountId` always comes from
// the caller's own `memberships` row.
// ============================================================

/**
 * The caller's own account's single WhatsApp config, or `null` if
 * never configured. `by_account` is the same "one row per account"
 * index `upsert` below relies on for its find-or-insert check — there
 * is no `configId` argument anywhere in this module, so a caller can
 * never address another account's row even by guessing an id.
 */
export const get = accountQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
  },
});

/**
 * Admin+ creates-or-updates the caller's own account's single WhatsApp
 * config row (find via `by_account`, patch if found else insert —
 * mirrors `templates.ts`'s `upsert` find-or-patch-else-insert idiom).
 * Every optional field is patched only when the caller actually
 * supplies it (an omitted `v.optional(...)` arg carries no key, so
 * spreading `args` over `ctx.db.patch` leaves that column untouched on
 * the existing row) — the same idiom `templates.upsert` uses, so e.g.
 * rotating just the access token doesn't clobber a previously stored
 * `registeredAt`.
 *
 * `phoneNumberId` is checked against `by_phone_number_id` FIRST: if a
 * row with that number already exists for a DIFFERENT account, this
 * throws `PHONE_NUMBER_CLAIMED` before touching anything. wacrm is
 * single-tenant-per-WhatsApp-number (see `src/app/api/whatsapp/config/
 * route.ts`'s own comment on issue #136) — letting two accounts bind
 * the same number would make inbound-webhook routing ambiguous. A row
 * the CALLER's own account already owns (same accountId) is not a
 * conflict — that's the normal "update my own number's other fields"
 * or "re-save the same number" path.
 */
export const upsert = accountMutation({
  args: {
    phoneNumberId: v.string(),
    wabaId: v.optional(v.string()),
    accessToken: v.string(),
    verifyToken: v.optional(v.string()),
    status: v.union(v.literal("connected"), v.literal("disconnected")),
    connectedAt: v.optional(v.number()),
    registeredAt: v.optional(v.number()),
    subscribedAppsAt: v.optional(v.number()),
    lastRegistrationError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const claimed = await ctx.db
      .query("whatsappConfig")
      .withIndex("by_phone_number_id", (q) =>
        q.eq("phoneNumberId", args.phoneNumberId),
      )
      .first();
    if (claimed && claimed.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "PHONE_NUMBER_CLAIMED" });
    }

    const existing = await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: Date.now() });
      return existing._id;
    }

    return await ctx.db.insert("whatsappConfig", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      ...args,
      updatedAt: Date.now(),
    });
  },
});
