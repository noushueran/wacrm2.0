"use client";

import { RotateCw, WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * One strip above the composer covering both "you have no network" and
 * "these messages didn't go out".
 *
 * Deliberately ONE element rather than a retry control on every failed
 * bubble: the case this exists for is an agent walking back into signal
 * with a handful of queued replies, and a single "Retry" beats hunting
 * for three separate crosses up the thread. The bubbles still carry
 * their own failed state — `MessageBubble` already draws a red cross for
 * `status: "failed"` — so nothing is hidden; this only adds the action.
 *
 * Renders nothing when there is a network and nothing has failed, which
 * is the overwhelmingly common case.
 */
export function ConnectionBanner({
  online,
  failedCount,
  onRetry,
}: {
  online: boolean;
  failedCount: number;
  onRetry: () => void;
}) {
  const t = useTranslations("Inbox.connection");

  if (online && failedCount === 0) return null;

  // Offline is the more useful thing to say when both are true: it
  // explains the failures, and retrying now would only fail again.
  const offline = !online;

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        offline
          ? "flex shrink-0 items-center justify-center gap-2 border-t border-amber-500/20 bg-amber-500/10 px-4 py-2"
          : "flex shrink-0 items-center justify-between gap-3 border-t border-red-500/20 bg-red-500/10 px-4 py-2"
      }
    >
      {offline ? (
        <>
          <WifiOff className="h-4 w-4 shrink-0 text-amber-400" />
          <p className="text-xs text-amber-400">
            {failedCount > 0
              ? t("offlineWithQueued", { count: failedCount })
              : t("offline")}
          </p>
        </>
      ) : (
        <>
          <p className="text-xs text-red-400">
            {t("failed", { count: failedCount })}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-red-500/30 px-2.5 py-1 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/10"
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t("retry")}
          </button>
        </>
      )}
    </div>
  );
}
