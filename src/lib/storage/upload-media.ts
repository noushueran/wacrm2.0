import type { ConvexReactClient, ReactMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * Convex-backed media-upload helper — the Phase 6 replacement for this
 * module's Supabase Storage version (account-scoped bucket paths, RLS
 * write policies). Convex's storage model needs no bucket/path
 * convention of its own: every stored file gets an opaque
 * `Id<"_storage">`, minted via `api.files.generateUploadUrl` and
 * resolved to a fetchable URL via `api.files.getUrl` — see
 * `convex/files.ts`'s header comment.
 *
 * Both functions below are plain (non-hook) functions — they run inside
 * event handlers / callbacks, not render bodies, so they can't call
 * `useConvex()`/`useMutation()` themselves. Callers thread in the Convex
 * handles they already hold from their OWN hooks instead: a
 * `ConvexReactClient` (from `useConvex()`) for the `getUrl`/`remove`
 * calls, plus the `generateUploadUrl` mutation fn (from
 * `useMutation(api.files.generateUploadUrl)`) for minting the upload
 * URL. This mirrors `src/components/settings/profile-form.tsx`'s
 * avatar-upload flow exactly (see its `onSubmit`, ~L115-140).
 */

/** 16 MB — mirrors the old Supabase bucket's `file_size_limit`
 *  (migrations 016/020/023) so upload behavior is unchanged for callers. */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Per-kind upload ceilings that mirror Meta's WhatsApp Cloud API caps so
 * a file Convex storage would accept but Meta would reject is caught
 * client-side BEFORE upload — otherwise it lands in storage as an
 * orphan and the send fails with a confusing 400. Images are Meta's
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
  /** Resolved, fetchable URL — store this in the row (e.g.
   *  `messages.mediaUrl`, `templates.headerMediaUrl`, a flow node's
   *  `media_url`); `metaSend` sends it to Meta as `link`. */
  url: string;
  /** Convex storage id backing `url` — kept so the caller can later
   *  `deleteAccountMedia` an abandoned/unsent attachment. */
  storageId: Id<"_storage">;
}

/** The `useMutation(api.files.generateUploadUrl)` handle a caller passes in. */
type GenerateUploadUrlMutation = ReactMutation<typeof api.files.generateUploadUrl>;

/**
 * Upload a file to Convex storage and resolve it to a fetchable URL.
 * The Convex client-upload flow: mint a short-lived upload URL, POST the
 * file bytes to it directly, then resolve the returned storage id to a
 * URL. Throws with a user-facing message on upload / resolution
 * failure — callers surface it via a toast.
 *
 * Size validation is the caller's responsibility (limits can differ per
 * feature); `MEDIA_MAX_BYTES`/`MEDIA_MAX_BYTES_BY_KIND` are exported for
 * the common cases.
 */
export async function uploadAccountMedia(
  convex: ConvexReactClient,
  generateUploadUrl: GenerateUploadUrlMutation,
  file: File,
): Promise<UploadAccountMediaResult> {
  const uploadUrl = await generateUploadUrl({});
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!response.ok) {
    throw new Error("Upload failed.");
  }
  const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };

  const url = await convex.query(api.files.getUrl, { storageId });
  if (!url) {
    throw new Error("Upload failed.");
  }

  return { url, storageId };
}

/**
 * Delete a previously-uploaded object. Used to GC media that was staged
 * (uploaded) but never sent — a cancelled draft or a failed Meta send —
 * so abandoned attachments don't accumulate in Convex storage.
 *
 * Best-effort: callers fire-and-forget and swallow errors (a missed
 * delete is a storage nit, not something to surface to the user).
 */
export async function deleteAccountMedia(
  convex: ConvexReactClient,
  storageId: Id<"_storage">,
): Promise<void> {
  await convex.mutation(api.files.remove, { storageId });
}
