"use client";

import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import {
  fetchMediaBlob,
  mediaFilename,
  triggerBlobDownload,
  type MediaKind,
} from "@/lib/media/download";

export interface MediaDownloadTarget {
  kind: MediaKind;
  url: string;
  createdAt: number | string;
  /** A document's own filename — WhatsApp puts it in `content_text`. */
  documentName?: string | null;
}

/** Copy is passed in rather than read from next-intl context so that every
 *  component using this hook stays renderable without a provider — the
 *  condition this repo's static-render component tests depend on. */
export interface MediaDownloadLabels {
  failed: string;
  openInTab: string;
}

/**
 * Save inbox media to disk, with the fallback that makes it safe to offer
 * at all.
 *
 * The fetch is cross-origin against R2, whose CORS allow-list is the
 * production origin alone, so it fails in development and would fail
 * behind any other origin. On failure the user gets a toast carrying an
 * "open in a new tab" action. That escape hatch is deliberately behind a
 * CLICK: calling `window.open` here directly would run after an `await`,
 * outside the user gesture that started it, and popup blockers routinely
 * eat exactly that call.
 */
export function useMediaDownload(labels: MediaDownloadLabels) {
  const [pending, setPending] = useState(false);
  // A ref, not the state, guards re-entry: the state value read inside the
  // callback would be the one captured when the callback was created.
  const inFlight = useRef(false);

  const download = useCallback(
    async (target: MediaDownloadTarget) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      try {
        const blob = await fetchMediaBlob(target.url);
        triggerBlobDownload(blob, mediaFilename({ ...target, mime: blob.type }));
      } catch {
        toast.error(labels.failed, {
          action: {
            label: labels.openInTab,
            onClick: () =>
              window.open(target.url, "_blank", "noopener,noreferrer"),
          },
        });
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [labels.failed, labels.openInTab],
  );

  return { download, pending };
}
