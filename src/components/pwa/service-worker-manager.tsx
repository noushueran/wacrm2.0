"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

// Headless. Registers /sw.js once, relays SW push messages to the in-app
// notifier via a window CustomEvent, and offers a reload when a new
// worker is waiting. No-op where unsupported.
export function ServiceWorkerManager() {
  const t = useTranslations("Pwa");
  // Survives the effect, so a `controllerchange` that we did NOT ask for
  // (another tab took the update) can be told apart from our own.
  const reloadingRef = useRef(false);
  // The effect below must run EXACTLY ONCE — it registers the service
  // worker and attaches listeners, and re-running it would re-register
  // and stack duplicate handlers (and duplicate update toasts).
  // `useTranslations` does not promise a stable function identity across
  // renders, so depending on `t` directly would risk exactly that. The
  // strings are only read when a toast is actually shown, so a ref
  // refreshed on every render gives current copy with no dependency.
  const tRef = useRef(t);
  // Written in an effect, never during render (`react-hooks/refs`), and
  // with no dependency array so it stays current after every render.
  useEffect(() => {
    tRef.current = t;
  });

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let cancelled = false;

    /**
     * Offer the update rather than applying it.
     *
     * A standalone PWA can stay open for days, so "reload when
     * convenient" has to be the user's call — an agent mid-reply must
     * not have the page swapped under them. Clicking posts SKIP_WAITING;
     * the worker activates, fires `controllerchange`, and the listener
     * below reloads so the document and its chunks come from one build.
     */
    const offerUpdate = (waiting: ServiceWorker) => {
      if (cancelled) return;
      toast(tRef.current("updateTitle"), {
        description: tRef.current("updateBody"),
        duration: Infinity,
        action: {
          label: tRef.current("updateAction"),
          onClick: () => {
            reloadingRef.current = true;
            waiting.postMessage({ type: "SKIP_WAITING" });
          },
        },
      });
    };

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
      // `updateViaCache: "none"` keeps the browser's HTTP cache out of the
      // update check for the worker script itself. Without it a cached
      // /sw.js can defer an update by as long as its own cache lifetime,
      // which would make the prompt above arrive late or not at all.
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then((registration) => {
        if (cancelled) return;
        // Already waiting when this page loaded — the update landed on a
        // previous visit and nobody accepted it yet.
        if (registration.waiting && navigator.serviceWorker.controller) {
          offerUpdate(registration.waiting);
        }
        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            // `controller` is null on a FIRST install, where "installed"
            // means the app just became offline-capable — there is
            // nothing to reload and no reason to interrupt. Only an
            // update to an already-controlled page is worth a prompt.
            if (
              installing.state === "installed" &&
              navigator.serviceWorker.controller
            ) {
              offerUpdate(installing);
            }
          });
        });
      })
      .catch((err) =>
        console.warn(
          "[sw] registration unavailable — push and offline fallback are off:",
          err,
        ),
      );

    const onControllerChange = () => {
      // Only reload for an update this tab accepted. Another tab
      // accepting one also fires this here, and reloading out from under
      // someone who never clicked anything is precisely the surprise the
      // prompt exists to avoid.
      if (!reloadingRef.current) return;
      reloadingRef.current = false;
      window.location.reload();
    };

    const onMessage = (event: MessageEvent) => {
      if (cancelled) return;
      if (event.data?.type === "wa-push" && event.data.payload) {
        window.dispatchEvent(
          new CustomEvent("wa-push", { detail: event.data.payload }),
        );
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
    };
  }, []);

  return null;
}
