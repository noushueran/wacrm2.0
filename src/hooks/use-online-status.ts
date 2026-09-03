"use client";

import { useEffect, useState } from "react";

/**
 * Whether this device currently has a network.
 *
 * Reads `navigator.onLine` and keeps up with the `online`/`offline`
 * events. Note what each value is worth:
 *
 *  - `false` is DEFINITIVE. The OS is telling us there is no network
 *    interface at all, so a request provably cannot leave the device.
 *    That is exactly the signal the outbox uses to decide a failed send
 *    is safe to retry automatically (`OutboxFailureKind`).
 *  - `true` is only a hint. It means an interface exists, not that
 *    anything is reachable — captive portals, a dead uplink and a
 *    half-open socket all report `true`. So this is never used to claim
 *    the app is working, only to explain why it isn't.
 *
 * Starts `true` on the server and before the first effect: an offline
 * banner that flashes on every cold start would be worse than one that
 * appears a frame late, and `navigator` cannot be read during render.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (typeof navigator === "undefined") return;

    const sync = () => setOnline(navigator.onLine);
    // Read once on mount — the device may already have been offline
    // before this component existed.
    sync();

    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  return online;
}
