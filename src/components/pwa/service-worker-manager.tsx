"use client";

import { useEffect } from "react";

// Headless. Registers /sw.js once and relays SW push messages to the
// in-app notifier via a window CustomEvent. No-op where unsupported.
export function ServiceWorkerManager() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let cancelled = false;
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.error("[sw] registration failed:", err));

    const onMessage = (event: MessageEvent) => {
      if (cancelled) return;
      if (event.data?.type === "wa-push" && event.data.payload) {
        window.dispatchEvent(
          new CustomEvent("wa-push", { detail: event.data.payload }),
        );
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  return null;
}
