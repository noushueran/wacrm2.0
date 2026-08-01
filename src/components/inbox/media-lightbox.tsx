"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Download, X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Full-screen viewer for an inbox image or video.
 *
 * Composed straight from the Base UI dialog primitive rather than from
 * `<DialogContent>`, following `src/components/ui/sheet.tsx`'s precedent: a
 * media viewer is a different surface from a card, and needs a dark
 * full-bleed backdrop (the shared one is a light `bg-background/10` blur,
 * which a photo cannot read against) plus a popup with no padding, fill or
 * width cap of its own.
 *
 * Esc and backdrop-click close come from the primitive.
 */
export function MediaLightbox({
  open,
  onOpenChange,
  kind,
  src,
  alt,
  title,
  downloadHref,
  filename,
  downloadLabel,
  closeLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "image" | "video";
  src: string;
  alt: string;
  /** Accessible name for the dialog itself — visually hidden. */
  title: string;
  downloadHref: string;
  filename: string;
  downloadLabel: string;
  closeLabel: string;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/80 duration-100",
            "data-open:animate-in data-open:fade-in-0",
            "data-closed:animate-out data-closed:fade-out-0",
          )}
        />
        <DialogPrimitive.Popup
          className={cn(
            "fixed inset-0 z-50 flex flex-col outline-none duration-100",
            "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
            "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            {title}
          </DialogPrimitive.Title>

          {/* Controls sit above the media on their own row so they never
              cover the image — the whole point of opening this is to see
              all of it. */}
          <div className="flex shrink-0 items-center justify-end gap-2 p-3">
            <a
              href={downloadHref}
              download={filename}
              className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
            >
              <Download className="h-4 w-4" />
              {downloadLabel}
            </a>
            <DialogPrimitive.Close
              className="inline-flex items-center justify-center rounded-lg bg-white/10 p-2 text-white transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none"
              aria-label={closeLabel}
            >
              <X className="h-5 w-5" />
            </DialogPrimitive.Close>
          </div>

          {/* `min-h-0` lets this flex child actually shrink, so
              `max-h-full` on the media is measured against the space left
              over after the control row — without it a tall image
              overflows the viewport and the bottom is unreachable again. */}
          <div className="flex min-h-0 flex-1 items-center justify-center p-4 pt-0">
            {kind === "image" ? (
              <img
                src={src}
                alt={alt}
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <video
                src={src}
                controls
                autoPlay
                className="max-h-full max-w-full"
              />
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
