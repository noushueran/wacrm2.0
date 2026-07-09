import { accountMutation, accountQuery } from "./lib/auth";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

// ============================================================
// Convex file storage — the Phase 6 replacement for
// `src/lib/storage/upload-media.ts`'s Supabase Storage buckets
// (`flow-media`/`chat-media`, account-scoped object path, public URL).
// Convex's storage model needs no bucket/path convention of its own:
// every stored file gets an opaque `Id<"_storage">`; `generateUploadUrl`/
// `getUrl` are the client's two entry points, `storeFromUrl` is the
// engine's (inbound media download).
//
// `generateUploadUrl`/`getUrl` are built on `accountMutation`/
// `accountQuery` (never the raw `mutation`/`query`) for the same
// reason every other tenant-facing function in this codebase is (see
// `convex/lib/auth.ts`'s header comment) — even though Convex file
// storage itself has no account-scoping concept of its own (a storage
// id, once minted, resolves for anyone holding it; there is no
// per-file ACL to check against `ctx.accountId` the way a DB row's
// `accountId` column gets checked). Gating entry on "is a signed-in
// member of SOME account" is the floor every other function in this
// codebase holds, and nothing in this task's brief calls for storage
// to be the one exception.
// ============================================================

/**
 * Any agent+ member of the caller's own account gets a short-lived
 * upload URL. The client `POST`s the file bytes to this URL directly
 * (the standard Convex client-upload flow) and gets back a
 * `{ storageId }` JSON body; the caller threads that id wherever it's
 * needed (e.g. a flow-builder `send_media` node's media reference, or
 * an inbox-composer attachment). Role-gated at "agent" — the same
 * floor `messages.append` uses for sending a message, since attaching
 * media to a message is the same class of action.
 */
export const generateUploadUrl = accountMutation({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("agent");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Resolve a storage id to its (signed, time-limited) download URL.
 * Any member of the caller's own account may resolve any storage id —
 * see this file's header comment on why there's no ownership check to
 * make here (Convex storage carries no per-file `accountId`). Returns
 * `null` if the id doesn't resolve to a stored file (already deleted,
 * or never existed) — same "null, don't throw, for not-found" contract
 * `ctx.storage.getUrl` itself has.
 */
export const getUrl = accountQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    return await ctx.storage.getUrl(args.storageId);
  },
});

/**
 * Download a URL's bytes and store them as a new Convex file —
 * internal engine primitive for inbound media (a customer sends a
 * photo/voice-note/document over WhatsApp; a future inbound-ingestion
 * path (Phase 6 Task 2) resolves Meta's media id to a fetchable,
 * authenticated URL — see `src/lib/whatsapp/meta-api.ts`'s
 * `getMediaUrl`, not ported by this task — then calls this to persist
 * the bytes into Convex storage). Also works for the simpler
 * "re-host an already-public URL" case (omit `headers`) that
 * `src/lib/storage/upload-media.ts` handled client-side for flow/chat
 * media uploads.
 *
 * Uses `fetch` + `Response#blob()` (both Web-standard, no `"use node"`
 * needed) rather than `src/lib/whatsapp/meta-api.ts`'s `downloadMedia`,
 * which returns a Node `Buffer` — `ctx.storage.store` takes a `Blob`,
 * so a `Buffer` buys nothing here.
 */
export const storeFromUrl = internalAction({
  args: {
    url: v.string(),
    /** e.g. `{ Authorization: "Bearer <meta access token>" }` for a
     *  Meta-authenticated media URL. Omit for an already-public URL. */
    headers: v.optional(v.record(v.string(), v.string())),
  },
  handler: async (ctx, args) => {
    const response = await fetch(args.url, {
      headers: args.headers,
    });
    if (!response.ok) {
      throw new Error(
        `storeFromUrl: fetch failed with status ${response.status}`,
      );
    }
    const blob = await response.blob();
    const storageId = await ctx.storage.store(blob);
    return { storageId };
  },
});
