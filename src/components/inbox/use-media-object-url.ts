"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchMediaBlob } from "@/lib/media/download";

/** Inbound WhatsApp media that has to be fetched through our own
 *  authenticated proxy (`src/app/api/whatsapp/media/[mediaId]/route.ts`) —
 *  the browser can't hold the decrypted access token, so the bytes come
 *  back through Next.js and become a blob URL. Everything else (R2 public
 *  URLs, legacy Convex storage URLs) is already directly displayable. */
const PROXY_PREFIX = "/api/whatsapp/media/";

export type MediaLoadState = "loading" | "ready" | "error";

interface Resolved {
  src: string | null;
  state: MediaLoadState;
}

function isProxied(url: string | null | undefined): url is string {
  return !!url && url.startsWith(PROXY_PREFIX);
}

function initialFor(url: string | null | undefined): Resolved {
  if (!url) return { src: null, state: "error" };
  if (isProxied(url)) return { src: null, state: "loading" };
  return { src: url, state: "ready" };
}

/**
 * Resolve a message's `media_url` into something an `<img>`/`<video>` can
 * actually display.
 *
 * A directly-displayable URL resolves during the first render — no spinner
 * flash for the R2 URLs that are the common case, and the markup is
 * complete during a static render, which is the only kind of component
 * test this repo can run. Only the proxied case needs the effect.
 */
export function useMediaObjectUrl(url: string | null | undefined) {
  const [resolved, setResolved] = useState<Resolved>(() => initialFor(url));

  // Adjusting state during render when a prop changes, rather than
  // syncing it in an effect: React re-runs this component before touching
  // the DOM, so there is no flash of the previous image and no cascading
  // second commit. See "You Might Not Need an Effect".
  const [seenUrl, setSeenUrl] = useState(url);
  if (url !== seenUrl) {
    setSeenUrl(url);
    setResolved(initialFor(url));
  }

  useEffect(() => {
    // Everything else was already resolved during render.
    if (!isProxied(url)) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      try {
        const blob = await fetchMediaBlob(url);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved({ src: objectUrl, state: "ready" });
      } catch {
        if (!cancelled) setResolved({ src: null, state: "error" });
      }
    })();

    return () => {
      cancelled = true;
      // `objectUrl` is a local that this closure captures directly, so it
      // is the URL created by THIS effect run. The code this replaced
      // closed over the `src` STATE from the render the effect ran in —
      // `null` on mount — so `revokeObjectURL` was called on nothing and
      // every proxied image leaked its blob for the page's lifetime.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  /** For the element's own `onError` — a URL can resolve fine and still
   *  fail to decode. */
  const markError = useCallback(
    () => setResolved((current) => ({ ...current, state: "error" })),
    [],
  );

  return { src: resolved.src, state: resolved.state, markError };
}
