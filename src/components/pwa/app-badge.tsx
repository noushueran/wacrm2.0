"use client";

import { useEffect } from "react";
import { useTotalUnread } from "@/hooks/use-total-unread";

// The Badging API isn't in lib.dom's Navigator yet. Narrow to exactly the
// two methods used rather than casting to `any`, matching how
// `src/lib/push/platform.ts` types iOS Safari's legacy `standalone` flag.
type NavigatorWithBadge = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/**
 * Headless. Mirrors the unread-conversation count onto the installed
 * app's home-screen icon.
 *
 * This is only HALF the badge, and the smaller half: it runs while a tab
 * is alive, which for a phone CRM is the minority of the day. The other
 * half — the one that matters — lives in `public/sw.js`, which reads
 * `payload.unread` on every push and badges the icon with the app closed.
 * Both read the same server-side number (`conversationInScope` in
 * convex/lib/roles.ts) so they cannot disagree.
 *
 * Why it still earns its place despite the SW covering the closed case:
 * push is best-effort and can be denied, unsubscribed, or dormant (no
 * VAPID env), and the badge must also come DOWN when the user reads
 * things — which produces no push at all. `useTotalUnread` is a reactive
 * Convex query, so marking a chat read clears the badge immediately.
 *
 * Every call is best-effort: the API is absent on desktop Safari and on
 * Android before Chrome 81, and both methods return promises that can
 * reject. A badge is decoration; it must never surface an error.
 */
export function AppBadge() {
  const totalUnread = useTotalUnread();

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const nav = navigator as NavigatorWithBadge;
    if (!nav.setAppBadge) return;

    if (totalUnread > 0) {
      void nav.setAppBadge(totalUnread).catch(() => {});
    } else {
      void nav.clearAppBadge?.().catch(() => {});
    }
  }, [totalUnread]);

  // No cleanup that clears the badge on unmount. This unmounts on sign-out
  // and on navigation away from the dashboard shell — neither of which
  // means "you have nothing unread". Clearing there would wipe a badge the
  // service worker had correctly set and then have nothing to restore it
  // until the next push.
  return null;
}
