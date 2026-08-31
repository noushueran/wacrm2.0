"use client";

import { useEffect } from "react";

// Headless. Registers /sw.js once and relays SW push messages to the
// in-app notifier via a window CustomEvent. No-op where unsupported.
export function ServiceWorkerManager() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let cancelled = false;
    // `"serviceWorker" in navigator` is necessary but NOT sufficient: the
    // API is present and `isSecureContext` is true in embedded webviews,
    // Firefox private windows, and policy-restricted profiles that still
    // refuse to register, failing with an opaque "unknown error occurred
    // when fetching the script" no matter what the script contains — a
    // 9-byte file fails identically. There is no synchronous capability
    // check for that, so the rejection IS the support test, and it is the
    // "where unsupported" case this component's header promises to no-op
    // on rather than a fault anyone can act on.
    //
    // So: warn, never error. Push and the offline fallback are optional
    // progressive enhancement and have already degraded cleanly by this
    // point; logging at error level additionally trips Next's dev overlay,
    // which reports it as if the page had crashed.
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) =>
        console.warn(
          "[sw] registration unavailable — push and offline fallback are off:",
          err,
        ),
      );

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
