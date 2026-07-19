import { accountMutation } from "./lib/auth";
import { internalAction } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { r2ConfigFromEnv } from "./lib/r2/config";
import { presignPut, deleteObject, putObject } from "./lib/r2/client";
import { buildMediaKey, parseMediaKey, MEDIA_KINDS } from "./lib/r2/keys";

// ============================================================
// Media object lifecycle, backed by Cloudflare R2 — the R2-migration
// replacement for this file's earlier Convex-file-storage version
// (`generateUploadUrl`/`registerUpload`/`getUrl`/`remove`, gated by a
// `fileOwners` table). That table existed because a bare
// `Id<"_storage">` carries no tenant: any holder of the id could
// resolve it, so ownership had to be recorded in a side table and
// checked on every read/delete.
//
// An R2 object key carries its own owner in its first path segment
// (`{accountId}/{kind}/{uuid}.{ext}` — see `convex/lib/r2/keys.ts`) and
// is minted SERVER-SIDE from `ctx.accountId`: a client supplies only a
// `kind`/`contentType`/optional `filename`, NEVER a key. Ownership is
// therefore guaranteed by construction and checkable by a plain string
// comparison — no lookup table required. `fileOwners` and
// `registerUpload` are retired accordingly (the `fileOwners` table
// definition itself is left in `convex/schema.ts` for now, unused —
// dropping it is a data-retention decision for the Plan 2 cleanup, not
// this task).
//
// Reading is no longer a privileged operation either, which is why
// there is no `getUrl` here anymore: `objs.holidayys.co` is a PUBLIC
// custom domain, so the object's URL is pure string concatenation from
// its key (`src/lib/storage/media-url.ts`'s `mediaUrlFromKey`) — it
// needs no auth, no signing, and no per-caller ownership check. Only
// MINTING an upload URL (`startUpload`) and DELETING (`remove`) touch
// anything account-scoped, so those are the only two mutations left.
//
// The tenant-isolation contract itself is unchanged and deliberately
// preserved from the Convex-storage version: a foreign or malformed key
// is `NOT_FOUND` (never `FORBIDDEN`, never a distinguishable error, never
// a different timing-observable path), and the role check runs BEFORE
// the ownership check so a viewer is rejected identically regardless of
// whose key it is or whether it even parses.
// ============================================================

const kindValidator = v.union(...MEDIA_KINDS.map((k) => v.literal(k)));

/**
 * Mint a key inside the caller's own account prefix and return a
 * short-lived presigned PUT URL for it. The browser PUTs the file bytes
 * straight to that URL — they never transit the VPS, and Convex never
 * sees them either.
 *
 * The caller MUST PUT with a byte-identical `Content-Type` to the
 * `contentType` given here: it is part of the presigned signature (see
 * `presignPut`), and it is also what R2 stores and later serves, which
 * is what lets `<img>`/`<audio>`/`<video>` and Meta's own media fetcher
 * handle the object correctly. `src/lib/storage/upload-media.ts`'s
 * `uploadAccountMedia` is the one place that PUTs, and it derives both
 * the arg sent here and its own `Content-Type` header from the same
 * `file.type` so the two can't drift apart.
 *
 * Role-gated at "agent" — the same floor `messages.append` uses, since
 * attaching media to a message is the same class of action.
 */
export const startUpload = accountMutation({
  args: {
    kind: kindValidator,
    contentType: v.string(),
    filename: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const cfg = r2ConfigFromEnv();
    const key = buildMediaKey({
      accountId: ctx.accountId,
      kind: args.kind,
      filename: args.filename,
      contentType: args.contentType,
    });
    const uploadUrl = await presignPut(cfg, {
      key,
      contentType: args.contentType,
    });
    return { uploadUrl, key };
  },
});

/**
 * Delete an object — GC for media staged (uploaded) but never sent (a
 * cancelled draft, a failed Meta send), so abandoned attachments don't
 * accumulate in the bucket forever.
 *
 * Only the owning account may delete: a key belonging to another
 * account, or a key too malformed to belong to anyone
 * (`parseMediaKey` returns `null`), both throw `NOT_FOUND` and delete
 * nothing — the same non-leaky treatment either way, and the ownership
 * check never even runs a network call in that case (see
 * `convex/files.test.ts`'s own assertions that `fetch` is never called
 * on a rejected path).
 *
 * Role checked BEFORE ownership (`requireRole` before `parseMediaKey`),
 * so a viewer is rejected identically — same `FORBIDDEN` — regardless
 * of whose key it is or whether it even parses.
 *
 * Callers fire-and-forget this and swallow errors (see
 * `src/lib/storage/upload-media.ts`'s `deleteAccountMedia`); a missed
 * delete is a storage nit, not something to surface to the user.
 */
export const remove = accountMutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const parsed = parseMediaKey(args.key);
    if (!parsed || parsed.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "file" });
    }
    await deleteObject(r2ConfigFromEnv(), args.key);
  },
});

/**
 * Download a URL's bytes and store them in R2 under a key scoped to the
 * given `accountId`/`kind` — the engine-side primitive for inbound media
 * (a customer's photo/voice note, resolved from a Meta media id) and for
 * re-hosting an already-public URL (a CTWA ad referral image; omit
 * `headers`).
 *
 * `accountId` is a plain caller-supplied argument rather than
 * `ctx.accountId` because this is an `internalAction` with no user
 * session: ingest resolves the owning account upstream from the
 * webhook's `phone_number_id` and hands it straight in. This is the
 * ONE place in this file where the caller — not this module — is
 * trusted to supply the right account; every caller of `storeFromUrl`
 * is itself an internal, server-only function that has already
 * resolved `accountId` from a source a client can't spoof (see
 * `convex/whatsappConfig.ts`'s `resolveInboundMedia` and
 * `convex/ingest.ts`'s ad-referral block).
 *
 * `contentType` prefers the response's own `Content-Type` header,
 * falling back to the `Blob`'s type, falling back to
 * `application/octet-stream` — mirrors `convex/ingest.ts`'s pre-R2
 * `downloadMedia` fallback chain so behavior is unchanged for a source
 * that omits the header.
 */
export const storeFromUrl = internalAction({
  args: {
    url: v.string(),
    /** e.g. `{ Authorization: "Bearer <meta access token>" }` for a
     *  Meta-authenticated media URL. Omit for an already-public URL. */
    headers: v.optional(v.record(v.string(), v.string())),
    accountId: v.string(),
    kind: kindValidator,
    filename: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const response = await fetch(args.url, { headers: args.headers });
    if (!response.ok) {
      throw new Error(
        `storeFromUrl: fetch failed with status ${response.status}`,
      );
    }
    const blob = await response.blob();
    const contentType =
      response.headers.get("content-type") ||
      blob.type ||
      "application/octet-stream";
    const cfg = r2ConfigFromEnv();
    const key = buildMediaKey({
      accountId: args.accountId,
      kind: args.kind,
      filename: args.filename,
      contentType,
    });
    await putObject(cfg, { key, body: blob, contentType });
    return { key };
  },
});
