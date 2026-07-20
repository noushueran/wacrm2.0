import { accountMutation, accountQuery } from "./lib/auth";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";
import { encrypt, decrypt } from "./lib/whatsappEncryption";
import { hasMinRole } from "./lib/roles";
import {
  verifyPhoneNumber,
  getSubscribedApps,
  registerPhoneNumber,
  subscribeWabaToApp,
  getMediaUrl,
  downloadMedia,
  type MetaPhoneInfo,
} from "./lib/whatsapp/metaApi";
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
 * Plain-English rejection used by both `upsert` and `connectAndSave`
 * when a caller supplies a `wabaId` identical to the `phoneNumberId`.
 * A WhatsApp Business Account ID and a Phone Number ID are two separate
 * Meta objects — the same value in both is a copy-paste mistake that
 * otherwise surfaces downstream only as Meta's opaque "#100" (a
 * WABA-scoped call like `subscribeWabaToApp` hitting a phone-number
 * ID). `connectAndSave` (an action) returns this as its `{ error }`
 * string, which the settings form toasts verbatim; `upsert` (a raw
 * mutation) throws a `WABA_EQUALS_PHONE_NUMBER` ConvexError instead.
 */
const WABA_EQUALS_PHONE_NUMBER_MESSAGE =
  "The WhatsApp Business Account ID and Phone Number ID must be different " +
  "values. They are two separate IDs from Meta WhatsApp Manager — you've " +
  "entered the same value for both. Copy the WhatsApp Business Account ID " +
  "(WABA ID) from your WhatsApp account overview and try again.";

/**
 * The caller's own account's single WhatsApp config, or `null` if
 * never configured. `by_account` is the same "one row per account"
 * index `upsert` below relies on for its find-or-insert check — there
 * is no `configId` argument anywhere in this module, so a caller can
 * never address another account's row even by guessing an id.
 *
 * Admin+ only (Task 5, supervisor-lockdown series): this returns the
 * FULL raw row — phone number id, WABA id, verify token, encrypted
 * access token — which is far more than any non-admin surface needs.
 * Both non-admin consumers (`src/app/(dashboard)/inbox/page.tsx` and
 * `settings-overview.tsx`) have been migrated onto `connectionState`
 * below, which exposes only the two booleans they actually read.
 */
export const get = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    return await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
  },
});

/**
 * Member-safe connection state. `get` above returns the FULL raw row —
 * phone number id, WABA id, verify token, encrypted access token — which
 * is far more than the two non-admin surfaces that read it actually
 * need: the inbox wants "are we connected?", and the settings overview
 * tile wants "is this set up at all?".
 *
 * Those two booleans are what this returns, so `get` can be gated to
 * admin without breaking either surface. Never throws for an
 * unconfigured account — absence is a legitimate state to render.
 */
export const connectionState = accountQuery({
  args: {},
  handler: async (ctx) => {
    const config = await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
    return {
      status: config?.status ?? null,
      isConfigured: !!config?.phoneNumberId,
    };
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
 * throws `PHONE_NUMBER_CLAIMED` before touching anything. Holidayys WA CRM is
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

    // A WABA ID equal to the Phone Number ID is always a mistake (see
    // `WABA_EQUALS_PHONE_NUMBER_MESSAGE`) — reject before writing the
    // row, alongside the `PHONE_NUMBER_CLAIMED` guard below.
    // `connectAndSave` makes the same check and returns the plain-English
    // message; here (a raw mutation) it surfaces as a ConvexError code.
    if (args.wabaId && args.wabaId === args.phoneNumberId) {
      throw new ConvexError({ code: "WABA_EQUALS_PHONE_NUMBER" });
    }

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
 * Server-only find-or-insert persist step for `connectAndSave` below
 * (the Convex port of `POST /api/whatsapp/config`'s save/register/
 * subscribe pipeline) — an `internalMutation` (not `accountMutation`)
 * because `connectAndSave` is an `action` with no `ctx.db` of its own
 * and has ALREADY derived + validated `accountId`/`userId` itself
 * (mirrors `messages.appendInternal`'s "auth already happened one
 * level up" split). Reuses `upsert`'s own three building blocks:
 * the `by_phone_number_id` cross-account claim guard, the
 * `by_account` find-or-patch-else-insert idiom, and the inline
 * `whatsappEncryption.encrypt()` step for `accessToken` — this
 * mutation always receives a PLAINTEXT token (`connectAndSave` has
 * already resolved it, fresh or decrypted-from-storage) and encrypts
 * it itself, exactly like `upsert` does for its own callers.
 *
 * `wabaId`/`verifyToken` follow `upsert`'s own "omitted = leave
 * untouched" idiom (an omitted `v.optional` arg carries no key at
 * all once it crosses the action->mutation boundary, so spreading it
 * via `rest` below is a no-op patch) — `connectAndSave`'s own
 * `handleSave` caller already relies on this exact behavior for
 * `upsert`, so a re-save that doesn't touch the WABA ID field must
 * not clobber it here either.
 *
 * `status`/`connectedAt`/`registeredAt`/`subscribedAppsAt`/
 * `lastRegistrationError` are the deliberate OPPOSITE: `connectAndSave`
 * computes a definitive value for every one of these on EVERY call
 * (including `undefined` — e.g. clearing a previously-failed
 * `lastRegistrationError` once a retry succeeds), so they're always
 * assigned explicitly by name below rather than folded into `rest`'s
 * conditional spread. `ctx.db.patch` documents "fields set to
 * undefined are removed" — an explicitly-present-but-undefined key in
 * the object literal genuinely clears a stale value, whereas a key
 * that's merely absent (rest's behavior for wabaId/verifyToken) is
 * left untouched. Getting this distinction backwards would leave a
 * fixed-then-resaved config stuck showing its OLD registration error
 * forever, the exact class of staleness bug this task exists to fix.
 */
export const persistConnection = internalMutation({
  args: {
    accountId: v.id("accounts"),
    userId: v.id("users"),
    phoneNumberId: v.string(),
    wabaId: v.optional(v.string()),
    // Always plaintext — `connectAndSave` has already resolved it
    // (fresh arg or decrypted from the existing row) before calling
    // this mutation; encrypted here, exactly like `upsert` does.
    accessToken: v.string(),
    verifyToken: v.optional(v.string()),
    status: v.union(v.literal("connected"), v.literal("disconnected")),
    connectedAt: v.optional(v.number()),
    registeredAt: v.optional(v.number()),
    subscribedAppsAt: v.optional(v.number()),
    lastRegistrationError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { accountId, userId, phoneNumberId, wabaId, accessToken, verifyToken } =
      args;

    const claimed = await ctx.db
      .query("whatsappConfig")
      .withIndex("by_phone_number_id", (q) =>
        q.eq("phoneNumberId", phoneNumberId),
      )
      .first();
    if (claimed && claimed.accountId !== accountId) {
      throw new ConvexError({ code: "PHONE_NUMBER_CLAIMED" });
    }

    const existing = await ctx.db
      .query("whatsappConfig")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();

    const storedAccessToken = await encrypt(accessToken);
    // Only included when the caller actually supplied them, so an
    // omitted field is left untouched on patch (mirrors `upsert`).
    const maybeWabaId = wabaId !== undefined ? { wabaId } : {};
    const maybeVerifyToken = verifyToken !== undefined ? { verifyToken } : {};
    // Built via EXPLICIT property access (never `...rest`-destructured
    // from `args`) — an optional arg the caller omitted is stripped
    // entirely by the time it crosses the action->mutation boundary
    // (confirmed empirically: a `...rest` destructure here reproduced
    // the exact staleness bug this function's doc comment warns about,
    // silently dropping `lastRegistrationError` from the patch instead
    // of clearing it). Explicitly naming each field below means the
    // key is always present in this literal — `undefined` included —
    // which `ctx.db.patch` correctly treats as "remove this field."
    const connectionState = {
      status: args.status,
      connectedAt: args.connectedAt,
      registeredAt: args.registeredAt,
      subscribedAppsAt: args.subscribedAppsAt,
      lastRegistrationError: args.lastRegistrationError,
    };

    if (existing) {
      await ctx.db.patch(existing._id, {
        phoneNumberId,
        ...maybeWabaId,
        ...maybeVerifyToken,
        accessToken: storedAccessToken,
        ...connectionState,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("whatsappConfig", {
      accountId,
      createdByUserId: userId,
      phoneNumberId,
      ...maybeWabaId,
      ...maybeVerifyToken,
      accessToken: storedAccessToken,
      ...connectionState,
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
 * `by_phone_number_id` instead of `by_account` — Holidayys WA CRM is
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
 * Looked up through `by_verify_token` rather than scanned. This used to
 * be a full table scan justified as "there's no index to look this up by
 * (the plaintext token is only known at verification time, never stored
 * elsewhere)" — but that is exactly backwards: the token IS stored, in
 * plain text, as this docblock says two paragraphs up. Only an ENCRYPTED
 * column would be unindexable by its plaintext. So the handshake no
 * longer reads every tenant's config on every webhook GET. (The source's
 * own unfiltered `SELECT id, verify_token FROM whatsapp_config` had the
 * same shape, but there it was forced: that column really is encrypted.)
 *
 * The empty token is guarded explicitly rather than left to the index. A
 * stored `""` is falsy — so the old scan's `if (!config.verifyToken)
 * continue` skipped it — but `""` is a perfectly matchable index key, and
 * without the guard a caller supplying no token at all would be handed an
 * accountId. Configs with no `verifyToken` at all need no guard: Convex
 * sorts a missing field before every present value, so it can never be
 * the `.eq` match for a non-empty string.
 *
 * Where two configs share a token, `.first()` returns the oldest, which
 * is what the scan's creation-order walk did — the index key is
 * (verifyToken, _creationTime). Returns the matched config's `accountId`,
 * or `null` for no match. Does NOT port the source's opportunistic
 * legacy-format-to-GCM token upgrade (a write, and moot besides — there
 * is no encrypted format here to upgrade FROM).
 */
export const matchVerifyToken = internalQuery({
  args: { verifyToken: v.string() },
  handler: async (ctx, args): Promise<Id<"accounts"> | null> => {
    if (!args.verifyToken) return null;
    const config = await ctx.db
      .query("whatsappConfig")
      .withIndex("by_verify_token", (q) =>
        q.eq("verifyToken", args.verifyToken),
      )
      .first();
    return config?.accountId ?? null;
  },
});

// ============================================================
// connectAndSave / connectionStatus — connect-flow regression fix.
// The settings form's Save button had been rewired straight onto
// `upsert` above, which ONLY stores the row: it never verifies the
// credentials against Meta, never calls `/register` (so a freshly-
// saved production number is never actually subscribed for inbound
// webhooks), and never calls `/subscribed_apps`. These two actions
// restore the full pipeline `POST`/`GET /api/whatsapp/config` used to
// run, as Convex ports (mirroring `verifyRegistration` below's own
// `getAuthUserId` + `internal.accounts.accountContextForUser` auth
// derivation, and its DRY-RUN convention via the shared `isDryRun()`
// helper defined just below this section).
// ============================================================

interface ConnectAndSaveResult {
  success: boolean;
  saved: true;
  registered: boolean;
  registration_skipped?: boolean;
  registration_error?: string | null;
  phone_info: MetaPhoneInfo;
}

/**
 * Admin+ verify→register→subscribe→persist, for the settings form's
 * Save button. Convex port of `POST /api/whatsapp/config` — replicates
 * its exact branch logic (numbered to match that route's own comments):
 *
 *   1. Resolve the PLAINTEXT access token to use against Meta: the
 *      caller's freshly-supplied `accessToken`, or (when omitted, e.g.
 *      a re-save that only touched `wabaId`) the account's already-
 *      stored one, decrypted. Neither available -> `ACCESS_TOKEN_REQUIRED`
 *      (mirrors `upsert`'s own first-save-with-no-token guard).
 *   2. Reject a `phoneNumberId` already claimed by a DIFFERENT account
 *      -> `PHONE_NUMBER_CLAIMED` (same code + same `by_phone_number_id`
 *      check as `upsert`, so the settings form's existing
 *      `isConvexErrorCode(err, 'PHONE_NUMBER_CLAIMED')` catch keeps
 *      working unchanged).
 *   3. Verify the credentials against Meta (`verifyPhoneNumber`) BEFORE
 *      touching storage — on failure, return `{ error }` (NOT saved),
 *      exactly like the route's own 400 JSON body.
 *   4. Register the phone number for inbound webhooks
 *      (`registerPhoneNumber`) when needed: the first save for this
 *      number, or whenever a fresh PIN is supplied. No PIN given ->
 *      `registration_skipped: true` (best-effort, not a failure — Meta
 *      TEST numbers have no 2FA PIN to give; route's own issue #242
 *      comment). A register failure does NOT abort the save — it
 *      still persists, with `status: "disconnected"` and the error
 *      recorded, so the user can retry without re-entering everything.
 *   5. Subscribe the WABA to this app (`subscribeWabaToApp`) whenever
 *      `wabaId` is supplied THIS round (no fallback to a previously
 *      stored one, matching the route's own `if (waba_id)` check on
 *      the request body, not the DB row) — failures here are non-fatal
 *      (logged, not surfaced as `registration_error`).
 *   6. Persist via `internal.whatsappConfig.persistConnection`,
 *      computing `status`/`connectedAt`/`registeredAt` exactly like the
 *      route's own `baseRow`: `disconnected`/`null`/`null` when
 *      registration failed this round, `connected`/now/the resolved
 *      registration timestamp otherwise.
 *
 * DRY-RUN aware (`CONVEX_META_DRY_RUN`, via the shared `isDryRun()`
 * below): all three outbound Meta calls (`verifyPhoneNumber`,
 * `registerPhoneNumber`, `subscribeWabaToApp`) are skipped and treated
 * as succeeding, with a synthetic `phone_info` — the claim-check and
 * persistence steps are local, network-free work and always run for
 * real, mirroring `verifyRegistration`'s own "only the Meta calls are
 * faked" convention.
 */
export const connectAndSave = action({
  args: {
    phoneNumberId: v.string(),
    wabaId: v.optional(v.string()),
    accessToken: v.optional(v.string()),
    verifyToken: v.optional(v.string()),
    pin: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<ConnectAndSaveResult | { error: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
    const context = await ctx.runQuery(
      internal.accounts.accountContextForUser,
      { userId },
    );
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(context.role, "admin")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "admin" });
    }
    const { accountId } = context;

    if (
      args.pin !== undefined &&
      args.pin !== null &&
      args.pin !== "" &&
      !/^\d{6}$/.test(args.pin)
    ) {
      return { error: "PIN must be exactly 6 digits." };
    }

    // Reject the copy-paste mistake where the WhatsApp Business Account
    // ID and the Phone Number ID are the same value. They are two
    // DIFFERENT Meta objects; pasting the Phone Number ID in as the
    // WABA ID is what made `subscribeWabaToApp` (POST /{waba-id}/
    // subscribed_apps) fail against Meta with the opaque "#100". Caught
    // here, before any Meta call, so the user sees an actionable message
    // instead. Only meaningful when a wabaId was actually supplied
    // (it's optional — an empty string is falsy and skips this).
    if (args.wabaId && args.wabaId === args.phoneNumberId) {
      return { error: WABA_EQUALS_PHONE_NUMBER_MESSAGE };
    }

    const existing = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId,
    });

    // Step 1 — resolve the plaintext token to use against Meta.
    let accessToken: string;
    if (args.accessToken) {
      accessToken = args.accessToken;
    } else if (existing) {
      accessToken = await decrypt(existing.accessToken);
    } else {
      throw new ConvexError({ code: "ACCESS_TOKEN_REQUIRED" });
    }

    // Step 2 — reject a phoneNumberId already claimed by a different account.
    const claimed = await ctx.runQuery(
      internal.whatsappConfig.accountByPhoneNumberId,
      { phoneNumberId: args.phoneNumberId },
    );
    if (claimed && claimed.accountId !== accountId) {
      throw new ConvexError({ code: "PHONE_NUMBER_CLAIMED" });
    }

    const dryRun = isDryRun();

    // Step 3 — verify credentials against Meta BEFORE saving anything.
    let phoneInfo: MetaPhoneInfo;
    if (dryRun) {
      phoneInfo = {
        id: args.phoneNumberId,
        display_phone_number: args.phoneNumberId,
        verified_name: "DRY-RUN",
      };
    } else {
      try {
        phoneInfo = await verifyPhoneNumber({
          phoneNumberId: args.phoneNumberId,
          accessToken,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown Meta API error";
        return { error: `Meta API error: ${message}` };
      }
    }

    // Step 4 — register the phone number for inbound webhooks.
    const sameNumber =
      existing?.phoneNumberId === args.phoneNumberId &&
      existing?.registeredAt != null;
    const needsRegistration =
      !sameNumber || (typeof args.pin === "string" && args.pin.length > 0);

    let registeredAt: number | null = existing?.registeredAt ?? null;
    let registrationError: string | null = null;
    let registrationSkipped = false;

    if (needsRegistration) {
      if (!args.pin) {
        // No PIN provided — best-effort skip, not a failure. See this
        // action's own doc comment (step 4) for why.
        registrationSkipped = true;
      } else if (dryRun) {
        registeredAt = Date.now();
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: args.phoneNumberId,
            accessToken,
            pin: args.pin,
          });
          registeredAt = Date.now();
        } catch (err) {
          registrationError =
            err instanceof Error ? err.message : "Unknown Meta API error";
          // Fall through — still persist below so the user can retry
          // without re-entering everything.
        }
      }
    }

    // Step 5 — subscribe the WABA to this app (non-fatal on failure).
    let subscribedAppsAt: number | null = null;
    if (args.wabaId) {
      if (dryRun) {
        subscribedAppsAt = Date.now();
      } else {
        try {
          await subscribeWabaToApp({ wabaId: args.wabaId, accessToken });
          subscribedAppsAt = Date.now();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn("WABA subscribed_apps failed (non-fatal):", message);
        }
      }
    }

    // Step 6 — persist, even when /register failed.
    await ctx.runMutation(internal.whatsappConfig.persistConnection, {
      accountId,
      userId,
      phoneNumberId: args.phoneNumberId,
      wabaId: args.wabaId,
      accessToken,
      verifyToken: args.verifyToken,
      status: registrationError ? "disconnected" : "connected",
      connectedAt: registrationError ? undefined : Date.now(),
      registeredAt: registrationError ? undefined : (registeredAt ?? undefined),
      subscribedAppsAt: subscribedAppsAt ?? undefined,
      lastRegistrationError: registrationError ?? undefined,
    });

    if (registrationError) {
      // Save succeeded but the number isn't actually live. Structured
      // failure, not a throw, so the UI can show the specific
      // remediation step instead of a generic toast — matches the
      // route's own 200-with-detail contract for this branch.
      return {
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
      };
    }

    return {
      success: true,
      saved: true,
      registered: registeredAt != null,
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    };
  },
});

interface ConnectionStatusResult {
  connected: boolean;
  reason?: "no_config" | "token_corrupted" | "meta_api_error";
  message?: string;
  needs_reset?: boolean;
  phone_info?: MetaPhoneInfo;
}

/**
 * Health-check backing the settings form's connection banner/"Test API
 * Connection" button. Convex port of `GET /api/whatsapp/config` —
 * mirrors its exact branches: no config saved yet (`no_config`), a
 * token that can't be decrypted with the current `ENCRYPTION_KEY`
 * (`token_corrupted`, `needs_reset: true` — surfaces the Reset
 * Configuration flow), Meta rejecting the credentials
 * (`meta_api_error`), or a genuine `{ connected: true, phone_info }`.
 * Always resolves (never throws) for every one of those diagnostic
 * outcomes, exactly like the source route's own "200 in all non-auth
 * cases" contract.
 *
 * The source route has NO role check at all — any authenticated member
 * of the account can view this diagnostic. Task 5 of the
 * supervisor-lockdown series deliberately tightens that here to
 * admin+, matching `whatsappConfig.get` (this performs a LIVE Meta API
 * call against the account's own credentials on every invocation, and
 * the settings tile that used to drive it for non-admins now reads the
 * member-safe `connectionState` query instead — see that query's own
 * doc comment). `verifyRegistration` below made the same admin+
 * tightening earlier.
 *
 * DRY-RUN aware (`CONVEX_META_DRY_RUN`): the one outbound Meta call
 * (`verifyPhoneNumber`) is skipped and replaced with a synthetic
 * success — the config-load/decrypt steps are local, network-free work
 * and always run for real, dry-run or not.
 */
export const connectionStatus = action({
  args: {},
  handler: async (ctx): Promise<ConnectionStatusResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
    const context = await ctx.runQuery(
      internal.accounts.accountContextForUser,
      { userId },
    );
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    // Admin+ only: this performs a live Meta health check against the
    // account's own credentials, and the settings tile it feeds is
    // itself admin-gated. Supervisors and below use `connectionState`.
    if (!hasMinRole(context.role, "admin")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "admin" });
    }
    const { accountId } = context;

    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId,
    });
    if (!config) {
      return {
        connected: false,
        reason: "no_config",
        message:
          "No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.",
      };
    }

    let accessToken: string;
    try {
      accessToken = await decrypt(config.accessToken);
    } catch {
      return {
        connected: false,
        reason: "token_corrupted",
        needs_reset: true,
        message:
          'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs production, or between deployments). Click "Reset Configuration" below, then re-save.',
      };
    }

    if (isDryRun()) {
      return {
        connected: true,
        phone_info: {
          id: config.phoneNumberId,
          display_phone_number: config.phoneNumberId,
          verified_name: "DRY-RUN",
        },
      };
    }

    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phoneNumberId,
        accessToken,
      });
      return { connected: true, phone_info: phoneInfo };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown Meta API error";
      return {
        connected: false,
        reason: "meta_api_error",
        message: `Meta API rejected the credentials: ${message}`,
      };
    }
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

// ============================================================
// fetchMedia — public authed action backing the inbound-media proxy
// (`GET /api/whatsapp/media/[mediaId]`, `src/app/api/whatsapp/media/
// [mediaId]/route.ts`). Every Supabase call that route used to make
// (`getUser`, `profiles.account_id`, `whatsapp_config`, `decrypt`) now
// happens here instead, PLUS the two-step Meta media fetch itself
// (`getMediaUrl` → `downloadMedia`) — so the decrypted WhatsApp access
// token never has to cross back out to Next.js; only the downloaded
// bytes + content type do. The route's job shrinks to bridging the
// caller's own Convex auth token through via a per-request
// `ConvexHttpClient` (never the shared singleton — see that file).
//
// Auth mirrors `verifyRegistration` above (`getAuthUserId` +
// `internal.accounts.accountContextForUser`), but gates at "agent"
// rather than "admin" — viewing an already-received inbox attachment
// is a routine agent action (the same floor `convex/files.ts`'s
// `startUpload` uses for attaching OUTBOUND media), not an
// admin-only diagnostic like `verifyRegistration`.
//
// No DRY-RUN branch (unlike `verifyRegistration`/`metaSend.ts`): this
// is a synchronous read the UI is actively waiting on to render an
// image/audio/document bubble, not a background diagnostic or a send
// — there's no meaningful synthetic response to fake here.
// ============================================================

/**
 * Resolve a Meta media id to its bytes, for the caller's own account's
 * WhatsApp config: decrypt the stored access token, ask Meta for the
 * short-lived CDN URL (`getMediaUrl`), then download it
 * (`downloadMedia`). Always throws on failure (missing config,
 * undecryptable token, or the Meta calls themselves failing) rather
 * than a soft `null`/`live:false` — unlike `verifyRegistration` there
 * is no partial-diagnostic UI to render into; the route's only move on
 * any failure is a 500.
 */
export const fetchMedia = action({
  args: { mediaId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ data: ArrayBuffer; contentType: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError({ code: "UNAUTHENTICATED" });
    const context = await ctx.runQuery(internal.accounts.accountContextForUser, {
      userId,
    });
    if (!context) throw new ConvexError({ code: "NO_ACCOUNT" });
    if (!hasMinRole(context.role, "agent")) {
      throw new ConvexError({ code: "FORBIDDEN", min: "agent" });
    }
    const { accountId } = context;

    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId,
    });
    if (!config) {
      // Matches `convex/metaSend.ts`'s exact wording for the same
      // "never configured" condition.
      throw new Error("WhatsApp not configured for this account");
    }

    const accessToken = await decrypt(config.accessToken);

    const mediaInfo = await getMediaUrl({ mediaId: args.mediaId, accessToken });
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    });

    // Exactly these two fields — `accessToken` (or anything else
    // derived from it) never joins this object, so it can't leave
    // Convex via the action's return value.
    return {
      data: buffer,
      contentType: contentType || mediaInfo.mimeType,
    };
  },
});

// ============================================================
// resolveInboundMedia — the INBOUND half of the media flow, and the
// "future inbound-ingestion path" that `convex/files.ts`'s `storeFromUrl`
// and `convex/lib/whatsapp/webhookParse.ts` both flag as a follow-up.
// `fetchMedia` above serves the outbound-proxy read for a signed-in
// agent; this serves inbound ingestion, which has NO user session — the
// `accountId` is resolved upstream from the webhook's phone_number_id
// (`accountByPhoneNumberId`) and handed straight in.
//
// The decrypted access token never leaves this action (same one-way-door
// design `fetchMedia` documents): it decrypts, resolves the Meta media
// id to its short-lived CDN URL (`getMediaUrl`), then hands that URL plus
// a `Bearer` header to `files.storeFromUrl`, which downloads the bytes
// and PUTs them to Cloudflare R2 under a key scoped to this account.
//
// Returns `{ key }`, NOT a resolved URL (R2-migration cutover, Task 7):
// `convex/ingest.ts`'s caller persists this key directly onto the
// message row (`messages.setMediaKey`) instead of eagerly resolving it
// to R2's public URL here — the inbox `<audio>`/`<video>`/`<img>`
// resolves `mediaKey ?? mediaUrl` lazily, at render time, instead
// (`src/lib/convex/adapters.ts`'s `toUiMessage`, Task 5). Task 6 already
// moved the underlying primitive (`storeFromUrl`) from a Convex-storage
// upload returning `{ storageId }` to an R2 PUT returning `{ key }`; this
// action briefly kept resolving that key to a URL itself (`publicUrl`)
// as a behavior-preserving shim while `ingest.ts`'s caller still expected
// one — Task 7 retires that shim now that the caller has been cut over
// too.
//
// Best-effort by contract: returns `null` (never throws) for a missing
// config, an undecryptable token, or any failing Meta/R2 step —
// including R2 being unconfigured (`r2ConfigFromEnv()` throwing inside
// `storeFromUrl`) — so one media that can't be fetched degrades to an
// "unavailable" bubble rather than derailing `ingest.processInbound`'s
// whole fan-out. The caller reads `null` as "leave this message without
// a mediaKey".
// ============================================================

export const resolveInboundMedia = internalAction({
  args: { accountId: v.id("accounts"), mediaId: v.string() },
  handler: async (ctx, args): Promise<{ key: string } | null> => {
    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId: args.accountId,
    });
    if (!config) return null;

    try {
      const accessToken = await decrypt(config.accessToken);
      const mediaInfo = await getMediaUrl({
        mediaId: args.mediaId,
        accessToken,
      });
      const { key } = await ctx.runAction(internal.files.storeFromUrl, {
        url: mediaInfo.url,
        headers: { Authorization: `Bearer ${accessToken}` },
        accountId: args.accountId,
        kind: "inbound",
      });
      return { key };
    } catch (err) {
      console.error(
        "[resolveInboundMedia] failed to resolve media",
        args.mediaId,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  },
});
