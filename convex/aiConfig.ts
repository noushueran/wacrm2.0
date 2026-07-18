import { accountMutation, accountQuery } from "./lib/auth";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v, ConvexError } from "convex/values";
import { encrypt, decrypt } from "./lib/whatsappEncryption";
import { hasMinRole } from "./lib/roles";
import { generateReply } from "./lib/ai/generate";
import { AiError } from "./lib/ai/types";

// ============================================================
// AI assistant configuration — one row per account (`convex/schema.ts`'s
// `aiConfigs`, Convex counterpart to migrations 029/031/033). Same "one
// row per account" `by_account` find-or-patch-else-insert idiom as
// `convex/whatsappConfig.ts`'s `upsert`, and the same never-leak-the-
// secret discipline as `convex/apiKeys.ts` (`list` never selects
// `keyHash`; here, `get` never selects/returns `apiKey`/
// `embeddingsApiKey`, only derived `hasKey`/`hasEmbeddingsKey` booleans).
//
// Port of `src/lib/ai/config.ts` (`loadAiConfig`) and
// `src/app/api/ai/config/route.ts` (GET/POST). Unlike `whatsappConfig`
// (whose `accessToken` arrives ALREADY encrypted by the Next.js API
// route, per that module's own header comment), `aiConfig.upsert` below
// receives the caller's PLAINTEXT provider key directly and must
// encrypt it itself — see `convex/lib/whatsappEncryption.ts`'s updated
// header for why `encrypt` was ported there for exactly this.
//
// Provider-key validation against the live OpenAI/Anthropic API
// (`src/lib/ai/validate.ts`'s `validateAiCredentials`, and the
// embeddings "ping" check in the POST route) is deliberately DEFERRED
// here: that requires an external network call, which only belongs in
// an `action` (DRY-RUN-testable), not this data-layer mutation. Phase 7
// Task 1 scopes `upsert` to persistence only; a future `verifyKey`
// `internalAction` can be layered in front of it without changing this
// module's shape.
// ============================================================

const providerValidator = v.union(v.literal("openai"), v.literal("anthropic"));

/**
 * The caller's own account's AI config, or `null` if never configured.
 * Any member may read it (mirrors the Next.js GET route's own comment:
 * "so the inbox/settings can reflect whether AI is set up"). The
 * encrypted `apiKey`/`embeddingsApiKey` columns are NEVER selected into
 * the return value — only `hasKey`/`hasEmbeddingsKey` booleans derived
 * from them, exactly like the GET route's own `has_key`/
 * `has_embeddings_key` flags (there, the columns are selected only to
 * derive the flags then destructured back out before the response is
 * built; here, the fields are simply never referenced in the object
 * literal below, so there's no destructure-then-omit step to get wrong).
 */
export const get = accountQuery({
  args: {},
  handler: async (ctx) => {
    const config = await ctx.db
      .query("aiConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();
    if (!config) return null;

    return {
      provider: config.provider,
      model: config.model,
      systemPrompt: config.systemPrompt,
      isActive: config.isActive,
      autoReplyEnabled: config.autoReplyEnabled,
      autoReplyMaxPerConversation: config.autoReplyMaxPerConversation,
      handoffAgentId: config.handoffAgentId,
      hasKey: !!config.apiKey,
      hasEmbeddingsKey: !!config.embeddingsApiKey,
    };
  },
});

/**
 * Admin+ creates-or-updates the caller's own account's single AI config
 * row (find via `by_account`, patch if found else insert — same idiom
 * as `whatsappConfig.upsert`/`templates.upsert`). `provider`/`model`/
 * `isActive`/`autoReplyEnabled`/`autoReplyMaxPerConversation` are
 * required on every call and always overwritten (the settings form
 * resubmits the whole state, like the POST route's own `shared` object);
 * `systemPrompt`/`handoffAgentId` are patched only when actually
 * supplied, leaving a previous value untouched when omitted (the
 * `whatsappConfig.upsert`/`templates.upsert` "omitted optional arg
 * carries no key at all" idiom — NOT the POST route's own "always
 * resend or it's cleared" behaviour, which is an HTTP-form artifact
 * this Convex counterpart doesn't need to replicate).
 *
 * `apiKey`/`embeddingsApiKey` are the one deliberate exception to
 * "patch only what's supplied": when supplied, the plaintext is
 * encrypted (`whatsappEncryption.encrypt`) and stored; when OMITTED,
 * the existing stored ciphertext is reused verbatim (re-encrypting
 * nothing, so a save that only flips `isActive` or edits the system
 * prompt doesn't rotate the key's IV/ciphertext for no reason) — this
 * mirrors the POST route's own "form sends `api_key` only when the
 * admin re-enters it, otherwise the existing encrypted key is reused"
 * contract exactly. `apiKey` has no stored fallback only on the very
 * first save for an account (no `existing` row yet) — schema requires
 * a non-empty `apiKey: v.string()`, so that combination throws
 * `API_KEY_REQUIRED`, mirroring the POST route's own `return
 * bad('api_key is required')`.
 */
export const upsert = accountMutation({
  args: {
    provider: providerValidator,
    model: v.string(),
    systemPrompt: v.optional(v.string()),
    isActive: v.boolean(),
    autoReplyEnabled: v.boolean(),
    // DEPRECATED — no reply cap anymore (see schema.ts). Still accepted
    // so an older client bundle mid-deploy can't hit a validator error.
    autoReplyMaxPerConversation: v.optional(v.number()),
    handoffAgentId: v.optional(v.id("users")),
    apiKey: v.optional(v.string()),
    embeddingsApiKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");

    const { apiKey, embeddingsApiKey, ...rest } = args;

    const existing = await ctx.db
      .query("aiConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .first();

    let storedApiKey: string;
    if (apiKey) {
      storedApiKey = await encrypt(apiKey);
    } else if (existing) {
      storedApiKey = existing.apiKey;
    } else {
      throw new ConvexError({ code: "API_KEY_REQUIRED" });
    }

    const storedEmbeddingsKey = embeddingsApiKey
      ? await encrypt(embeddingsApiKey)
      : existing?.embeddingsApiKey;

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...rest,
        apiKey: storedApiKey,
        embeddingsApiKey: storedEmbeddingsKey,
        updatedAt: Date.now(),
      });
      return existing._id;
    }

    return await ctx.db.insert("aiConfigs", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      ...rest,
      apiKey: storedApiKey,
      embeddingsApiKey: storedEmbeddingsKey,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Server-only counterpart to `get`, for the auto-reply (Task 3) and
 * knowledge-ingest (Task 2) actions — same "caller-supplied accountId,
 * no client can ever call this" shape as `whatsappConfig.getForAccount`/
 * `apiKeys.lookupByHash`. Port of `loadAiConfig`'s decrypt logic
 * (`src/lib/ai/config.ts`), but WITHOUT that function's `requireActive`
 * gate: callers here (the auto-reply dispatch action) need to inspect
 * `isActive`/`autoReplyEnabled`/`autoReplyMaxPerConversation` themselves
 * to decide whether to proceed, exactly like the source's own Playground
 * path (`requireActive: false`) does — so this always returns the row
 * as configured, active or not.
 *
 * Returns `null` when there's no config row for the account.
 * `embeddingsApiKey` decrypt failure is swallowed to `null` (a
 * rotated/mismatched `ENCRYPTION_KEY` degrades semantic search to
 * lexical-only, exactly like the source's own comment on this) — but an
 * `apiKey` decrypt failure is left to THROW, uncaught, same as the
 * source: that failure must surface distinctly rather than silently
 * looking like "AI not configured".
 */
export const loadDecrypted = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const config = await ctx.db
      .query("aiConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .first();
    if (!config) return null;

    let embeddingsApiKey: string | null = null;
    if (config.embeddingsApiKey) {
      try {
        embeddingsApiKey = await decrypt(config.embeddingsApiKey);
      } catch {
        // Not silent in the source (a `console.error` breadcrumb) — the
        // Convex counterpart has no equivalent server-log call site more
        // useful than what the caller (Task 3's dispatch action) can
        // already infer from `embeddingsApiKey` coming back `null` while
        // the config row itself is otherwise present, so no log call
        // is duplicated here.
        embeddingsApiKey = null;
      }
    }

    return {
      provider: config.provider,
      model: config.model,
      apiKey: await decrypt(config.apiKey),
      systemPrompt: config.systemPrompt,
      isActive: config.isActive,
      autoReplyEnabled: config.autoReplyEnabled,
      autoReplyMaxPerConversation: config.autoReplyMaxPerConversation,
      handoffAgentId: config.handoffAgentId,
      embeddingsApiKey,
    };
  },
});

/**
 * Result shape mirrors `src/app/api/ai/test/route.ts`'s JSON body
 * exactly (minus its HTTP status, which has no Convex counterpart) —
 * `{ok:true}` on success, `{error, code?}` on any validation/provider
 * failure. Callers (the settings "Test key" button) branch on `ok`
 * rather than a thrown rejection, same as the route's own `res.ok`
 * check — auth/role gating is the one exception, which throws
 * `ConvexError` like every other function in this codebase.
 */
type TestConnectionResult = { ok: true } | { error: string; code?: string };

/**
 * Admin+ "Test key" action — Convex port of `POST /api/ai/test`.
 * Validates a provider/model/key combo WITHOUT saving it: when `apiKey`
 * is omitted, the account's own saved (decrypted) key is used instead,
 * so an admin can re-test an existing config (e.g. after changing the
 * model) without retyping the secret. `provider`/`model` are ALWAYS
 * required from the caller — matching the route's own body reads
 * (`body.provider`/`body.model`), which never fall back to a saved
 * config for those two fields, only for `api_key`.
 *
 * "Call the provider minimally" is `generate.ts`'s `generateReply` with
 * the exact ping the source's `validateAiCredentials`
 * (`src/lib/ai/validate.ts`) uses: a fixed system prompt + a `"ping"`
 * user turn. Any `AiError` (invalid key, rate limit, network, empty
 * response) is caught and reported via `{error, code}` — never thrown —
 * matching the route's own `catch (err) { if (err instanceof AiError)
 * return NextResponse.json({error: err.message, code: err.code}, ...) }`.
 *
 * Rate limiting (`RATE_LIMITS.adminAction` in the source route) has no
 * Convex counterpart in this codebase yet and is NOT ported here.
 */
export const testConnection = action({
  args: {
    provider: providerValidator,
    model: v.string(),
    apiKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<TestConnectionResult> => {
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

    const model = args.model.trim();
    if (!model) return { error: "model is required" };

    let apiKeyPlain = args.apiKey?.trim() ?? "";
    if (!apiKeyPlain) {
      let saved: { apiKey: string } | null;
      try {
        saved = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
      } catch {
        return {
          error: "Stored API key could not be decrypted — re-enter your key.",
        };
      }
      if (!saved?.apiKey) {
        return { error: "Enter an API key to test." };
      }
      apiKeyPlain = saved.apiKey;
    }

    try {
      await generateReply({
        provider: args.provider,
        model,
        apiKey: apiKeyPlain,
        systemPrompt: "You are a connectivity check. Reply with the single word: OK.",
        messages: [{ role: "user", content: "ping" }],
      });
    } catch (err) {
      if (err instanceof AiError) {
        return { error: err.message, code: err.code };
      }
      console.error("[ai/test] validation error:", err);
      return { error: "Could not validate the API key." };
    }

    return { ok: true };
  },
});
