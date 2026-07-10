import { accountMutation, accountQuery } from "./lib/auth";
import { internalQuery } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { encrypt } from "./lib/whatsappEncryption";

// ============================================================
// WhatsApp Cloud API connection — one row per account
// (`convex/schema.ts`'s `whatsappConfig`, Convex counterpart to the
// UNIQUE(account_id) `whatsapp_config` table migration 017 left
// behind). This module is the data layer PLUS the one encryption step
// `upsert` below owns directly: `accessToken` is encrypted inline
// (`convex/lib/whatsappEncryption.ts`'s `encrypt`) before the row is
// ever written, exactly like `convex/aiConfig.ts`'s `upsert` encrypts
// its own BYO provider key — see that helper's header for why this
// used to be an application-layer (Next.js API route) concern and no
// longer is, now that the settings form talks to Convex directly.
// `convex/metaSend.ts` decrypts the stored ciphertext back out
// (`whatsappEncryption.decrypt`) when actually sending. Verifying
// credentials against Meta and registering the phone number for
// inbound webhooks remain application-layer concerns (`src/app/api/
// whatsapp/config/route.ts`) that happen around calls to this module.
// Built on `accountQuery`/`accountMutation` (never the raw `query`/
// `mutation`), so `ctx.accountId` always comes from the caller's own
// `memberships` row.
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
 * mirrors `templates.ts`'s `upsert` find-or-patch-else-insert idiom,
 * and `aiConfig.ts`'s `upsert` for the encrypt-when-provided /
 * reuse-when-omitted `accessToken` handling below). Every OTHER
 * optional field is patched only when the caller actually supplies it
 * (an omitted `v.optional(...)` arg carries no key, so spreading `rest`
 * over `ctx.db.patch` leaves that column untouched on the existing
 * row) — the same idiom `templates.upsert` uses, so e.g. rotating just
 * the access token doesn't clobber a previously stored `registeredAt`.
 *
 * `accessToken` is the one deliberate exception to "patch only what's
 * supplied": when supplied, the plaintext the settings form sends is
 * encrypted (`whatsappEncryption.encrypt`) and stored — `metaSend.ts`
 * decrypts it back out (`whatsappEncryption.decrypt`) when actually
 * sending. When OMITTED, the existing stored ciphertext is reused
 * verbatim (re-encrypting nothing, so a save that only flips `status`
 * or edits `wabaId` doesn't rotate the token's IV/ciphertext for no
 * reason) — exactly like `aiConfig.upsert`'s `apiKey` handling.
 * `accessToken` has no stored fallback only on the very first save for
 * an account (no `existing` row yet) — schema requires a non-empty
 * `accessToken: v.string()`, so that combination throws
 * `ACCESS_TOKEN_REQUIRED`, mirroring `aiConfig.upsert`'s own
 * `API_KEY_REQUIRED`.
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
    accessToken: v.optional(v.string()),
    verifyToken: v.optional(v.string()),
    status: v.union(v.literal("connected"), v.literal("disconnected")),
    connectedAt: v.optional(v.number()),
    registeredAt: v.optional(v.number()),
    subscribedAppsAt: v.optional(v.number()),
    lastRegistrationError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const { accessToken, ...rest } = args;

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

    let storedAccessToken: string;
    if (accessToken) {
      storedAccessToken = await encrypt(accessToken);
    } else if (existing) {
      storedAccessToken = existing.accessToken;
    } else {
      throw new ConvexError({ code: "ACCESS_TOKEN_REQUIRED" });
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...rest,
        accessToken: storedAccessToken,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("whatsappConfig", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      ...rest,
      accessToken: storedAccessToken,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Admin+ clears the caller's own account's WhatsApp config entirely —
 * a plain delete-if-present, not an error when there's nothing to
 * clear (mirrors `get`'s own "never configured" contract — `null`
 * rather than throwing — applied to a delete). Scoped by `by_account`
 * exactly like `get`/`upsert`; there is no `configId` argument
 * anywhere in this module, so a caller can never reach another
 * account's row even by guessing an id.
 */
export const remove = accountMutation({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");

    const existing = await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

/**
 * Server-only counterpart to `get`, for the engine primitives in
 * `convex/metaSend.ts` — same "one row per account" `by_account` lookup,
 * but keyed on a caller-supplied `accountId` instead of `ctx.accountId`,
 * since an `internalAction`'s send has no user session to derive one
 * from (mirrors `convex/apiKeys.ts`'s `lookupByHash`: an `internalQuery`
 * never exposed to any client, called only via
 * `ctx.runQuery(internal.whatsappConfig.getForAccount, { accountId })`).
 * Returns `null`, never throws, for "never configured" — same contract
 * as `get`.
 */
export const getForAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
  },
});
