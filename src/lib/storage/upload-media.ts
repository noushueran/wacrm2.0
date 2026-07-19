import type { ConvexReactClient, ReactMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { MediaKind } from "../../../convex/lib/r2/keys";

/**
 * R2-backed media-upload helper — the R2-migration replacement for this
 * module's earlier Convex-storage version (`generateUploadUrl` +
 * `registerUpload` + `getUrl` round trip). The browser now PUTs bytes
 * straight to Cloudflare R2: `convex/files.ts`'s `startUpload` mints a
 * key inside the caller's own account prefix and a short-lived presigned
 * PUT URL for it, the browser PUTs the file to that URL directly (never
 * transiting Convex/the VPS), and the caller stores the returned KEY —
 * not a resolved URL — in its own row. Display-time resolution is
 * `resolveMediaUrl`/`mediaUrlFromKey` from `./media-url`, not this file.
 *
 * Both functions below are plain (non-hook) functions — they run inside
 * event handlers / callbacks, not render bodies, so they can't call
 * `useConvex()`/`useMutation()` themselves. Callers thread in the Convex
 * handles they already hold from their OWN hooks instead: a
 * `ConvexReactClient` (from `useConvex()`, needed by `deleteAccountMedia`)
 * plus the `startUpload` mutation fn (from
 * `useMutation(api.files.startUpload)`) for `uploadAccountMedia`.
 */

/** 16 MB — mirrors the old Supabase bucket's `file_size_limit`
 *  (migrations 016/020/023) so upload behavior is unchanged for callers. */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Per-kind upload ceilings that mirror Meta's WhatsApp Cloud API caps so
 * a file that would fit in a single R2 PUT but that Meta would reject is
 * caught client-side BEFORE upload — otherwise it lands in the bucket as
 * an orphan and the send fails with a confusing 400. Images are Meta's
 * tightest cap at 5 MB; documents are held at the 16 MB limit above
 * (Meta allows 100 MB, but shared-hosting upload UX caps lower).
 */
export const MEDIA_MAX_BYTES_BY_KIND = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
} as const;

export interface UploadAccountMediaResult {
  /** R2 object key — store this in the row (`messages.mediaKey`,
   *  `messageTemplates.headerMediaKey`, a flow node's `config.media_key`,
   *  `memberships.avatarKey`). Resolve it for display with
   *  `resolveMediaUrl`/`mediaUrlFromKey` from `./media-url`. */
  key: string;
}

/** The `useMutation(api.files.startUpload)` handle a caller passes in. */
type StartUploadMutation = ReactMutation<typeof api.files.startUpload>;

/**
 * Upload a file straight to R2. The server mints a key inside the
 * caller's account prefix and presigns a PUT for it; the browser then
 * PUTs the bytes directly to R2, so they never transit Convex or the VPS.
 *
 * The `Content-Type` sent on the PUT below MUST be byte-identical to the
 * one the server signed — both are derived from the same `file.type`
 * here, so they can't drift apart. A mismatch makes R2 reject the
 * upload with a signature error rather than a friendly one (see
 * `convex/lib/r2/client.ts`'s `presignPut` doc comment).
 *
 * Size validation is the caller's responsibility (limits can differ per
 * feature); `MEDIA_MAX_BYTES`/`MEDIA_MAX_BYTES_BY_KIND` are exported for
 * the common cases.
 */
export async function uploadAccountMedia(
  convex: ConvexReactClient,
  startUpload: StartUploadMutation,
  file: File,
  kind: MediaKind,
): Promise<UploadAccountMediaResult> {
  const contentType = file.type || "application/octet-stream";
  const { uploadUrl, key } = await startUpload({
    kind,
    contentType,
    filename: file.name,
  });

  // The upload verb is R2's PUT — Convex's client-upload flow used POST,
  // but a presigned R2 URL only accepts the verb it was signed for.
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!response.ok) {
    throw new Error("Upload failed.");
  }

  return { key };
}

/**
 * Delete a previously-uploaded object. Used to GC media that was staged
 * (uploaded) but never sent — a cancelled draft or a failed Meta send —
 * so abandoned attachments don't accumulate in the bucket.
 *
 * Best-effort: callers fire-and-forget and swallow errors (a missed
 * delete is a storage nit, not something to surface to the user).
 */
export async function deleteAccountMedia(
  convex: ConvexReactClient,
  key: string,
): Promise<void> {
  await convex.mutation(api.files.remove, { key });
}
