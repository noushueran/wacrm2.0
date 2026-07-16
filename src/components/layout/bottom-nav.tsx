"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, MessageSquare, Users, Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { canAccessNav } from "@/lib/auth/roles";

const items = [
  { href: "/inbox", labelKey: "inbox", icon: MessageSquare },
  { href: "/contacts", labelKey: "contacts", icon: Users },
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
];

// Fixed bottom tab bar, mobile only (hidden lg+). "More" opens the full
// sidebar drawer via the same handler the Header hamburger uses.
export function BottomNav({ onOpenMore }: { onOpenMore: () => void }) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const { accountRole } = useAuth();
  const totalUnread = useTotalUnread();
  if (!accountRole) return null;

  const visible = items.filter((i) => canAccessNav(accountRole, i.href));

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-card pb-safe lg:hidden">
      {visible.map((item) => {
        const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
        const showDot = item.href === "/inbox" && totalUnread > 0 && !active;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-label={t(item.labelKey)}
            className={cn(
              "relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium",
              active ? "text-primary" : "text-muted-foreground",
            )}
          >
            <item.icon className="h-5 w-5" />
            {t(item.labelKey)}
            {showDot && <span className="absolute right-[28%] top-1.5 h-2 w-2 rounded-full bg-primary" />}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onOpenMore}
        aria-label={t("openMenu")}
        className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium text-muted-foreground"
      >
        <Menu className="h-5 w-5" />
        {t("more")}
      </button>
    </nav>
  );
}
