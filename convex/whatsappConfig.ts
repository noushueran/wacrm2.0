import { accountMutation, accountQuery } from "./lib/auth";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";
import { encrypt, decrypt } from "./lib/whatsappEncryption";
import { hasMinRole } from "./lib/roles";
import { verifyPhoneNumber, getSubscribedApps } from "./lib/whatsapp/metaApi";
import type { Id } from "./_generated/dataModel";

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

/**
 * Server-only tenancy lookup for the inbound webhook (Phase 8, Task 4):
 * every Meta delivery (message OR status change) carries `value.metadata
 * .phone_number_id`, and this is how the httpAction maps that back to
 * the owning account/config before calling `ingest.processInbound` (or
 * the status/template handlers). Mirrors `getForAccount`'s exact "never
 * throws, `null` for not-configured" contract, just keyed by
 * `by_phone_number_id` instead of `by_account` — `wacrm` is
 * single-tenant-per-WhatsApp-number (see `upsert`'s own comment on this),
 * so at most one row can ever match.
 *
 * Returns the row AS-IS, including the encrypted `accessToken`
 * ciphertext — this is a `query`; decrypting it is the caller's job (an
 * action, since whatever needs the plaintext token also needs `fetch`
 * for the downstream Meta call). This function itself never decrypts
 * anything.
 */
export const accountByPhoneNumberId = internalQuery({
  args: { phoneNumberId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("whatsappConfig")
      .withIndex("by_phone_number_id", (q) =>
        q.eq("phoneNumberId", args.phoneNumberId),
      )
      .first();
  },
});

/**
 * Server-only counterpart to the webhook GET-verification check in
 * `src/app/api/whatsapp/webhook/route.ts` (lines ~117-132): Meta's
 * subscribe handshake carries a plaintext `hub.verify_token` query
 * param, matched here against every stored config's `verifyToken`.
 *
 * IMPORTANT deviation from the source: the source's `verify_token`
 * column is ENCRYPTED at rest, so its GET handler decrypts each stored
 * row before comparing. This Convex table's `verifyToken` is stored as
 * plain text — `upsert` above (`convex/whatsappConfig.ts`) never
 * encrypts it (only `accessToken` gets that treatment), confirmed by
 * `whatsappConfig.test.ts`'s own existing assertion
 * (`expect(row!.verifyToken).toBe("verify-1")`, no `decrypt()` in
 * sight). Matching against THIS codebase's actual current data model
 * means a plain equality check, not a decrypt-then-compare — decrypting
 * a plaintext value would throw on every row and never match anything.
 * (Whether `verifyToken` SHOULD be encrypted like `accessToken` is a
 * pre-existing question for `upsert`, not something this read-only
 * lookup can fix — see this task's own report.)
 *
 * There's no index to look this up by (the plaintext token is only
 * known at verification time, never stored elsewhere), so this is a
 * full table scan, mirroring the source's own unfiltered `SELECT id,
 * verify_token FROM whatsapp_config`. A config with no `verifyToken` set
 * is skipped. Returns the matched config's `accountId`, or `null` for no
 * match. Does NOT port the source's opportunistic legacy-format-to-GCM
 * token upgrade (a write, and moot besides — there is no encrypted
 * format here to upgrade FROM).
 */
export const matchVerifyToken = internalQuery({
  args: { verifyToken: v.string() },
  handler: async (ctx, args): Promise<Id<"accounts"> | null> => {
    const configs = await ctx.db.query("whatsappConfig").collect();
    for (const config of configs) {
      if (!config.verifyToken) continue;
      if (config.verifyToken === args.verifyToken) {
        return config.accountId;
      }
    }
    return null;
  },
});

// ============================================================
// verifyRegistration — admin-gated diagnostic action (transitive-
// Supabase gap-fill task). Convex port of `GET /api/whatsapp/config/
// verify-registration`: confirms the account's saved phone number is
// actually reachable/subscribed on Meta's side ("UI says Connected but
// Meta isn't delivering events"). A plain `action` (like `send.ts`/
// `broadcasts.ts`'s `send`, `reactions.ts`'s `reactToMeta`) since it has
// no `ctx.db` of its own — `getAuthUserId` + `internal.accounts
// .accountContextForUser` derive the caller's account/role, same as
// those. The source route itself has NO role check at all (any
// authenticated member of the account can view the diagnostic); this
// action deliberately tightens that to admin+, matching this task's own
// brief.
//
// DRY-RUN aware, mirroring `convex/metaSend.ts`'s own
// `CONVEX_META_DRY_RUN` convention: ONLY the two outbound Meta calls
// (`verifyPhoneNumber`/`getSubscribedApps`) are skipped and replaced
// with a synthetic success — the "does a config exist"/"can we decrypt
// the token" checks are local, network-free work and always run for
// real, dry-run or not (exactly like `metaSend.ts`'s own config-load +
// decrypt steps aren't skipped either).
// ============================================================

function isDryRun(): boolean {
  return !!process.env.CONVEX_META_DRY_RUN;
}

interface VerifyRegistrationChecks {
  config_exists: boolean;
  token_decryptable?: boolean;
  phone_metadata_ok?: boolean;
  waba_subscribed_to_app?: boolean | null;
  locally_marked_registered?: boolean;
}

interface VerifyRegistrationResult {
  live: boolean;
  checks: VerifyRegistrationChecks;
  errors?: string[];
  message?: string;
  last_registration_error?: string | null;
  registered_at?: number | null;
  subscribed_apps_at?: number | null;
}

/**
 * Admin+ diagnostic — verifies the account's saved WhatsApp phone
 * number against Meta: phone metadata reachability, WABA app
 * subscription, and the locally-recorded registration timestamp. Every
 * failure mode returns `live: false` with a `checks`/`message` (or
 * `errors`) breakdown rather than throwing, exactly matching the
 * route's own "always 200 with diagnostic detail" contract — the UI
 * renders per-check pass/fail rather than a generic error toast. Only
 * auth/role gating throws (`ConvexError`, matching every other function
 * in this codebase).
 */
export const verifyRegistration = action({
  args: {},
  handler: async (ctx): Promise<VerifyRegistrationResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
    const context = await ctx.runQuery(internal.accounts.accountContextForUser, {
      userId,
    });
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(context.role, "admin")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "admin" });
    }
    const { accountId } = context;

    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId,
    });
    if (!config) {
      return {
        live: false,
        checks: { config_exists: false },
        message: "No WhatsApp configuration saved yet.",
      };
    }

    let accessToken: string;
    try {
      accessToken = await decrypt(config.accessToken);
    } catch {
      return {
        live: false,
        checks: { config_exists: true, token_decryptable: false },
        message:
          "Stored access token can't be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.",
      };
    }

    const checks: Required<VerifyRegistrationChecks> = {
      config_exists: true,
      token_decryptable: true,
      phone_metadata_ok: false,
      waba_subscribed_to_app: null,
      locally_marked_registered: config.registeredAt != null,
    };
    const errors: string[] = [];

    if (isDryRun()) {
      // Skip the network entirely — same convention as `metaSend.ts`'s
      // own DRY-RUN branch — and report as if both Meta calls succeeded.
      checks.phone_metadata_ok = true;
      checks.waba_subscribed_to_app = true;
    } else {
      try {
        await verifyPhoneNumber({ phoneNumberId: config.phoneNumberId, accessToken });
        checks.phone_metadata_ok = true;
      } catch (err) {
        errors.push(
          `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (config.wabaId) {
        try {
          const subs = await getSubscribedApps({ wabaId: config.wabaId, accessToken });
          checks.waba_subscribed_to_app = subs.length > 0;
          if (!checks.waba_subscribed_to_app) {
            errors.push(
              "WABA has no subscribed apps. Re-save the configuration to subscribe.",
            );
          }
        } catch (err) {
          errors.push(
            `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        errors.push(
          "No WABA ID on file — webhooks can't be wired without it. Add it in the form and re-save.",
        );
      }
    }

    const live =
      checks.phone_metadata_ok &&
      (checks.waba_subscribed_to_app ?? false) &&
      checks.locally_marked_registered;

    return {
      live,
      checks,
      errors,
      last_registration_error: config.lastRegistrationError ?? null,
      registered_at: config.registeredAt ?? null,
      subscribed_apps_at: config.subscribedAppsAt ?? null,
    };
  },
});
