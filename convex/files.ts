import { accountMutation, accountQuery } from "./lib/auth";
import { internalAction } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Convex file storage — the Phase 6 replacement for
// `src/lib/storage/upload-media.ts`'s Supabase Storage buckets
// (`flow-media`/`chat-media`, account-scoped object path, public URL).
// Convex's storage model needs no bucket/path convention of its own:
// every stored file gets an opaque `Id<"_storage">`; `generateUploadUrl`/
// `registerUpload`/`getUrl`/`remove` are the client's entry points,
// `storeFromUrl` is the engine's (inbound media download).
//
// All of them are built on `accountMutation`/`accountQuery` (never the
// raw `mutation`/`query`) for the same reason every other tenant-facing
// function in this codebase is (see `convex/lib/auth.ts`'s header
// comment). Convex `_storage` itself carries no `accountId` — a storage
// id, once minted, resolves for anyone holding it — so per-file
// ownership can't be read off the object the way a DB row's `accountId`
// column can. Instead the client reports each completed upload back via
// `registerUpload`, which records the storageId→accountId mapping in the
// `fileOwners` table; `getUrl`/`remove` then assert that mapping against
// `ctx.accountId` before resolving/deleting, so one account can never
// reach another's uploads even holding the (opaque, unguessable) id.
// This hardens what was previously gated only on "signed-in member of
// SOME account".
// ============================================================

/**
 * Any agent+ member of the caller's own account gets a short-lived
 * upload URL. The client `POST`s the file bytes to this URL directly
 * (the standard Convex client-upload flow) and gets back a
 * `{ storageId }` JSON body, then reports that id back via
 * `registerUpload` (below) so ownership is recorded before anything
 * tries to `getUrl`/`remove` it. Role-gated at "agent" — the same floor
 * `messages.append` uses for sending a message, since attaching media to
 * a message is the same class of action.
 */
export const generateUploadUrl = accountMutation({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("agent");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * The `fileOwners` record for a storage id, or `null` if none exists.
 * `getUrl`/`remove`/`registerUpload` gate on it against `ctx.accountId`
 * — the only per-file ownership signal there is, since Convex `_storage`
 * itself carries no `accountId` (see this file's header comment). Typed
 * on a bare `QueryCtx["db"]` so the one query and both mutations can
 * share it (a `MutationCtx`'s `db` is structurally a superset).
 */
async function fileOwnerRecord(
  ctx: { db: QueryCtx["db"] },
  storageId: Id<"_storage">,
) {
  return await ctx.db
    .query("fileOwners")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
}

/**
 * Record the storageId→accountId ownership mapping for a just-completed
 * client upload — the client calls this with the `{ storageId }` the
 * upload POST handed back, so `getUrl`/`remove` will honor it. Idempotent
 * for the caller's own id (an upload retry re-reporting the same id is a
 * no-op); a storage id already owned by ANOTHER account is reported as
 * `NOT_FOUND` and never re-pointed — the same non-leaky treatment
 * `getUrl`/`remove` give a foreign id, so this can't be used to hijack an
 * id. Role-gated at "agent", matching `generateUploadUrl`.
 */
export const registerUpload = accountMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const existing = await fileOwnerRecord(ctx, args.storageId);
    if (existing) {
      if (existing.accountId !== ctx.accountId) {
        throw new ConvexError({ code: "NOT_FOUND", entity: "file" });
      }
      return;
    }
    await ctx.db.insert("fileOwners", {
      accountId: ctx.accountId,
      storageId: args.storageId,
    });
  },
});

/**
 * Resolve a storage id to its (signed, time-limited) download URL — but
 * only for a storage id the caller's own account owns (per `fileOwners`;
 * see this file's header comment). Returns `null` for a foreign or
 * unregistered id, and for an owned id whose object no longer resolves
 * (already deleted) — the same "null, don't throw, for not-found"
 * contract `ctx.storage.getUrl` itself has, so a caller can't tell a
 * cross-account id from a missing one.
 */
export const getUrl = accountQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const owner = await fileOwnerRecord(ctx, args.storageId);
    if (!owner || owner.accountId !== ctx.accountId) return null;
    return await ctx.storage.getUrl(args.storageId);
  },
});

/**
 * Delete a previously-uploaded object — GC for media that was staged
 * (uploaded) but never sent (a cancelled draft, or a failed Meta send),
 * so abandoned attachments don't accumulate in Convex storage. Only the
 * account that owns the id (per `fileOwners`) may delete it: a foreign or
 * unregistered id throws `NOT_FOUND` (the same non-leaky treatment
 * `contacts.ts`'s `requireOwnContact` gives) and deletes nothing. On a
 * successful delete the `fileOwners` row is removed too, so the mapping
 * doesn't outlive the object. Callers (e.g. the inbox composer)
 * fire-and-forget this and swallow errors — a missed delete is a storage
 * nit, not something to surface to the user — same best-effort contract
 * `src/lib/storage/upload-media.ts`'s Supabase-era `deleteAccountMedia`
 * had.
 *
 * Role-gated at "agent", the same floor `generateUploadUrl` uses; the
 * role check runs before the ownership check, so a viewer is rejected as
 * `FORBIDDEN` regardless of whose id it is.
 */
export const remove = accountMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const owner = await fileOwnerRecord(ctx, args.storageId);
    if (!owner || owner.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "file" });
    }
    await ctx.storage.delete(args.storageId);
    await ctx.db.delete(owner._id);
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
