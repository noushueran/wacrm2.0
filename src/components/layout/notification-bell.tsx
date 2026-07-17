"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

import { useQuery } from "@/lib/convex/cached";
import { useAuth } from "@/hooks/use-auth";
import { canAccessNav } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toUiNotification, convexErrorMessage } from "@/lib/convex/adapters";
import {
  TYPE_ICON,
  notificationHref,
  formatUnreadBadge,
} from "@/lib/notifications/shared";
import type { Notification } from "@/types";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

// How many recent notifications the popover shows before "View all".
const POPOVER_LIMIT = 6;

/**
 * The header's notification bell. Self-contained: owns its own reactive
 * notifications subscription, unread count, and mark-read mutations, so the
 * Header only has to drop `<NotificationBell />` into its right-hand cluster.
 *
 * Visibility mirrors the old sidebar entry exactly — viewers can't reach
 * `/notifications` (see `canAccessNav`), so they get no bell. Clicking a row
 * marks it read and jumps to the linked inbox conversation; the footer link
 * opens the full `/notifications` page.
 */
export function NotificationBell() {
  const t = useTranslations("Header");
  const router = useRouter();
  const { accountRole } = useAuth();

  const [open, setOpen] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  // Reactive — both are live Convex subscriptions scoped to the caller, so
  // the badge and rows update on their own as notifications arrive or are
  // marked read. No optimistic wiring needed.
  //
  // Deliberately NOT `api.notifications.list` (which the /notifications page
  // uses): this bell mounts on every authenticated page, and `list` reads the
  // caller's entire notification history. These two are index-bounded — the
  // rows stop at POPOVER_LIMIT, and the count saturates at its own cap — so
  // what the bell reads no longer grows with history.
  const recentResult = useQuery(api.notifications.listRecent, {
    limit: POPOVER_LIMIT,
  });
  const recent = useMemo(
    () => recentResult?.map(toUiNotification) ?? null,
    [recentResult],
  );

  // Saturates at the server's cap (>= 10), which `formatUnreadBadge` renders
  // as "9+" — visually identical to an exact count, but a bounded read.
  const unreadCount = useQuery(api.notifications.unreadCount) ?? 0;

  const markReadMutation = useMutation(api.notifications.markRead);
  const markAllReadMutation = useMutation(api.notifications.markAllRead);

  const handleClick = useCallback(
    async (n: Notification) => {
      // Close first so the popover doesn't linger over the destination route.
      setOpen(false);
      if (!n.read_at) {
        try {
          await markReadMutation({
            notificationId: n.id as Id<"notifications">,
          });
        } catch (err) {
          console.error("[NotificationBell] mark-read error:", err);
          toast.error(convexErrorMessage(err));
        }
      }
      const href = notificationHref(n);
      if (href) router.push(href);
    },
    [markReadMutation, router],
  );

  const markAllRead = useCallback(async () => {
    if (unreadCount === 0) return;
    setMarkingAll(true);
    try {
      await markAllReadMutation({});
    } catch (err) {
      console.error("[NotificationBell] mark-all-read error:", err);
      toast.error(convexErrorMessage(err));
    } finally {
      setMarkingAll(false);
    }
  }, [unreadCount, markAllReadMutation]);

  // Same gate the sidebar used: no notifications-route access → no bell.
  // `accountRole` is null until auth resolves; render nothing until then.
  if (!accountRole || !canAccessNav(accountRole, "/notifications")) {
    return null;
  }

  const badge = formatUnreadBadge(unreadCount);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={
          unreadCount > 0
            ? `${t("notifications")} — ${t("notificationsUnread", { count: unreadCount })}`
            : t("notifications")
        }
        className="relative flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus:bg-muted focus:outline-none data-popup-open:bg-muted data-popup-open:text-foreground"
      >
        <Bell className="h-5 w-5" />
        {badge && (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-background"
          >
            {badge}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 gap-0 overflow-hidden p-0"
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3.5 py-2.5">
          <span className="text-sm font-medium text-foreground">
            {t("notifications")}
          </span>
          <button
            type="button"
            onClick={markAllRead}
            disabled={unreadCount === 0 || markingAll}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:pointer-events-none disabled:text-muted-foreground/50"
          >
            {markingAll ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCheck className="h-3.5 w-3.5" />
            )}
            {t("notificationsMarkAllRead")}
          </button>
        </div>

        {recent === null ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : recent.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <Bell className="h-5 w-5 text-primary" />
            </div>
            <p className="text-sm font-medium text-foreground">
              {t("notificationsEmpty")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("notificationsEmptyHint")}
            </p>
          </div>
        ) : (
          <ul className="max-h-96 overflow-y-auto">
            {recent.map((n) => {
              const Icon = TYPE_ICON[n.type] ?? Bell;
              const isUnread = !n.read_at;
              return (
                <li
                  key={n.id}
                  className="border-b border-border last:border-b-0"
                >
                  <button
                    type="button"
                    onClick={() => handleClick(n)}
                    className={cn(
                      "flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors",
                      isUnread
                        ? "bg-primary/5 hover:bg-primary/10"
                        : "hover:bg-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        isUnread
                          ? "bg-primary/15 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                      aria-hidden
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            "truncate text-sm font-medium",
                            isUnread
                              ? "text-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {n.title}
                        </span>
                        {isUnread && (
                          <span
                            aria-hidden
                            className="h-2 w-2 shrink-0 rounded-full bg-primary"
                          />
                        )}
                      </span>
                      {n.body && (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {n.body}
                        </span>
                      )}
                      <span className="mt-1 block text-[11px] text-muted-foreground/70">
                        {formatDistanceToNow(new Date(n.created_at), {
                          addSuffix: true,
                        })}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <Link
          href="/notifications"
          onClick={() => setOpen(false)}
          className="flex items-center justify-center gap-1.5 border-t border-border px-3.5 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary/5"
        >
          {t("notificationsViewAll")}
        </Link>
      </PopoverContent>
    </Popover>
  );
}
