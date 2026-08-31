"use client";

import { useCallback, useRef, useState } from "react";
import { Download, X, ZoomIn, ZoomOut } from "lucide-react";
import type { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface MediaLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "image" | "video";
  /** Already-resolved source — a blob URL for proxied media. Passed in
   *  rather than re-resolved so opening costs no second request and shows
   *  no second spinner. */
  src: string;
  alt: string;
  caption?: string | null;
  onDownload: () => void;
  downloadPending?: boolean;
  t: ReturnType<typeof useTranslations>;
}

/** How far a pointer may travel before we treat the gesture as a pan
 *  rather than a click. Below this, a shaky click still toggles zoom. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Full-viewport viewer for an image or video in a message bubble.
 *
 * An image opens scaled to fit and toggles to its natural size on click,
 * where the container scrolls and can be dragged to pan — the case that
 * matters is a tall banner whose fine print is unreadable at fit size,
 * which is the whole reason this exists. Video gets the size but not the
 * zoom, which does not apply to it.
 */
export function MediaLightbox({
  open,
  onOpenChange,
  kind,
  src,
  alt,
  caption,
  onDownload,
  downloadPending = false,
  t,
}: MediaLightboxProps) {
  const [zoomed, setZoomed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragOrigin = useRef<
    { x: number; y: number; left: number; top: number } | null
  >(null);
  const dragged = useRef(false);

  // Each opening starts fit-to-window; carrying the previous zoom over
  // would drop the next image in at some arbitrary scroll offset. Adjusted
  // during render rather than in an effect so the reset is already applied
  // in the commit that shows the image — an effect would paint the stale
  // zoom for a frame first.
  const [lastOpen, setLastOpen] = useState(open);
  if (open !== lastOpen) {
    setLastOpen(open);
    setZoomed(false);
  }

  /** Zoom toward the point that was clicked, so the detail under the
   *  cursor is what ends up on screen. */
  const toggleZoom = useCallback((event: React.MouseEvent<HTMLImageElement>) => {
    event.stopPropagation();
    if (dragged.current) {
      dragged.current = false;
      return;
    }

    const bounds = event.currentTarget.getBoundingClientRect();
    const ratioX = (event.clientX - bounds.left) / bounds.width;
    const ratioY = (event.clientY - bounds.top) / bounds.height;

    setZoomed((wasZoomed) => {
      if (wasZoomed) return false;
      // After the natural-size layout lands, not before it.
      requestAnimationFrame(() => {
        const container = scrollRef.current;
        if (!container) return;
        container.scrollLeft =
          ratioX * container.scrollWidth - container.clientWidth / 2;
        container.scrollTop =
          ratioY * container.scrollHeight - container.clientHeight / 2;
      });
      return true;
    });
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!zoomed) return;
      const container = scrollRef.current;
      if (!container) return;
      dragged.current = false;
      dragOrigin.current = {
        x: event.clientX,
        y: event.clientY,
        left: container.scrollLeft,
        top: container.scrollTop,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [zoomed],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const origin = dragOrigin.current;
      const container = scrollRef.current;
      if (!origin || !container) return;
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
        dragged.current = true;
      }
      container.scrollLeft = origin.left - dx;
      container.scrollTop = origin.top - dy;
    },
    [],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragOrigin.current) return;
    dragOrigin.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /** Clicking the empty space around the media closes, the way every
   *  other lightbox behaves. The media itself stops propagation. */
  const onSurfaceClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (dragged.current) {
        dragged.current = false;
        return;
      }
      onOpenChange(false);
    },
    [onOpenChange],
  );

  const toolbarButton =
    "text-white hover:bg-white/15 hover:text-white focus-visible:ring-white/40";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        // Overrides the default centred card: full viewport, no chrome, a
        // dark surface of its own (the shared backdrop is a light blur,
        // which would wash out a photo).
        className={cn(
          "top-0 left-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0",
          "flex-col gap-0 rounded-none bg-black/95 p-0 text-white ring-0 sm:max-w-none",
        )}
      >
        <DialogTitle className="sr-only">
          {kind === "image" ? t("imageViewer") : t("videoViewer")}
        </DialogTitle>

        <div className="absolute top-0 right-0 z-10 flex items-center gap-1 p-3">
          {kind === "image" && (
            <Button
              variant="ghost"
              size="icon-lg"
              className={toolbarButton}
              aria-label={zoomed ? t("zoomOut") : t("zoomIn")}
              onClick={() => setZoomed((value) => !value)}
            >
              {zoomed ? <ZoomOut /> : <ZoomIn />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-lg"
            className={toolbarButton}
            aria-label={t("download")}
            disabled={downloadPending}
            onClick={onDownload}
          >
            <Download />
          </Button>
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-lg"
                className={toolbarButton}
                aria-label={t("close")}
              />
            }
          >
            <X />
          </DialogClose>
        </div>

        <div
          ref={scrollRef}
          onClick={onSurfaceClick}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className={cn(
            // `flex` + `m-auto` on the child rather than `justify-center`:
            // centring a flex container's overflowing child clips its top
            // and left, putting part of a zoomed banner out of reach.
            "flex min-h-0 flex-1",
            // `active:` rather than reading the drag ref: a ref change
            // triggers no re-render, so a class derived from it would go
            // stale the moment it mattered.
            zoomed
              ? "overflow-auto active:cursor-grabbing"
              : "overflow-hidden p-4 sm:p-8",
          )}
        >
          {kind === "image" ? (
            // Plain `<img>`, not `next/image`, for the same reason the
            // bubble's thumbnail is: `src` is a short-lived signed URL on
            // object storage (often already a blob: URL here), which the
            // optimizer can neither cache nor be configured for.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={alt}
              draggable={false}
              onClick={toggleZoom}
              className={cn(
                "m-auto select-none",
                zoomed
                  ? "h-auto max-h-none w-auto max-w-none cursor-zoom-out"
                  : "max-h-full max-w-full object-contain cursor-zoom-in",
              )}
            />
          ) : (
            <video
              src={src}
              controls
              className="m-auto max-h-full max-w-full"
              onClick={(event) => event.stopPropagation()}
            />
          )}
        </div>

        {caption && (
          <p className="max-h-24 shrink-0 overflow-y-auto whitespace-pre-wrap break-words bg-black/60 px-4 py-3 text-center text-sm text-white/90">
            {caption}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
