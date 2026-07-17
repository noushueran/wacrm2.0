"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { softBadge } from "@/lib/ui/soft-badge";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import {
  BarChart3,
  Bot,
  Crown,
  GitBranch,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Pin,
  PinOff,
  Radio,
  Settings,
  Shield,
  ShieldCheck,
  User,
  UserCog,
  Users,
  UsersRound,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { canAccessNav, type AccountRole } from "@/lib/auth/roles";

// Per-role chip metadata used in the sidebar's account strip + the Members
// tab roster. Owner (amber) and supervisor (cyan) go through `softBadge` so
// their text carries a light-mode stop too — the old `text-amber-300` /
// `text-cyan-300` were dark-only and washed out on the light surface.
// Admin/agent/viewer already used mode-correct theme tokens.
const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; labelKey: string; className: string }
> = {
  owner: {
    icon: Crown,
    labelKey: "roleOwner",
    className: softBadge("warning"),
  },
  admin: {
    icon: Shield,
    labelKey: "roleAdmin",
    className: "border-primary/40 bg-primary/10 text-primary",
  },
  supervisor: {
    icon: ShieldCheck,
    labelKey: "roleSupervisor",
    className: softBadge("cyan"),
  },
  agent: {
    icon: UserCog,
    labelKey: "roleAgent",
    className: "border-border bg-muted text-foreground",
  },
  viewer: {
    icon: User,
    labelKey: "roleViewer",
    className: "border-border bg-card text-muted-foreground",
  },
};
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface NavItem {
  href: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
}

const navItems: NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/inbox", labelKey: "inbox", icon: MessageSquare },
  { href: "/contacts", labelKey: "contacts", icon: Users },
  { href: "/pipelines", labelKey: "pipelines", icon: GitBranch },
  { href: "/broadcasts", labelKey: "broadcasts", icon: Radio },
  { href: "/automations", labelKey: "automations", icon: Zap },
  { href: "/flows", labelKey: "flows", icon: Workflow, beta: true },
  { href: "/agents", labelKey: "aiAgents", icon: Bot },
  { href: "/campaigns", labelKey: "campaigns", icon: BarChart3 },
];

const bottomNavItems = [
  { href: "/settings", labelKey: "settings", icon: Settings },
];

interface SidebarProps {
  /** Controlled on mobile by the Header's hamburger button. Ignored on lg+. */
  open?: boolean;
  onClose?: () => void;
}

import { useTranslations } from "next-intl";

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const { profile, profileLoading, account, accountRole, signOut } = useAuth();
  const totalUnread = useTotalUnread();
  // Only surface the account-name strip when it actually carries
  // information — a renamed or shared account. For a default solo account
  // the name matches the user's own, so it would just duplicate the footer.
  const showAccountStrip =
    !profileLoading &&
    !!account?.name &&
    account.name !== profile?.full_name;

  // Desktop rail state. Default collapsed (icon rail); hovering or keyboard-
  // focusing the rail floats the full labelled menu over the content as an
  // overlay (no reflow), and the pin locks it open. Server renders unpinned;
  // reconcile from localStorage after mount to avoid a hydration mismatch.
  // `pinned` only drives `lg:` styles — the mobile drawer stays full-width.
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem("wacrm:sidebar:pinned");
      if (stored !== null) setPinned(stored === "true");
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);
  const togglePinned = () => {
    setPinned((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("wacrm:sidebar:pinned", String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  };

  // Desktop label visibility: when pinned, always shown; otherwise hidden on
  // the rail and revealed while the rail is hovered or holds keyboard focus.
  // `group-*` targets these descendants; the `<aside>` carries `group`.
  const revealOnExpand = pinned
    ? ""
    : "lg:hidden lg:group-hover:block lg:group-focus-within:block";

  // Close the drawer when route changes — users opened it to navigate, so once
  // they pick a destination the drawer should get out of the way.
  useEffect(() => {
    onClose?.();
    // Only pathname drives this — onClose identity doesn't need to re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Lock body scroll and allow Escape to close while the drawer is open on
  // mobile. No-ops on desktop because the sidebar isn't a drawer there.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <>
      {/* Backdrop — mobile only, only when the drawer is open. */}
      <button
        type="button"
        aria-label={t("closeMenu")}
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      />

      {/* Desktop layout spacer — reserves the rail (or pinned) width in the
          flex row so the fixed panel below can overlay content on hover
          without reflowing the page. Absent on mobile (drawer overlays). */}
      <div
        aria-hidden
        className={cn(
          "hidden shrink-0 transition-[width] duration-200 lg:block",
          pinned ? "lg:w-60" : "lg:w-16",
        )}
      />

      <aside
        className={cn(
          // Mobile: fixed drawer that slides in from the left.
          // `pt-safe`: this is `fixed`, so it is positioned against the
          // viewport and does NOT inherit the shell's `pt-safe` — without its
          // own the brand/pin row (and the first nav items) render under the
          // iOS status bar in the installed PWA. Inset is 0 on desktop.
          "group fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col overflow-hidden whitespace-nowrap border-r border-border bg-card pt-safe",
          "transition-[transform,width,box-shadow] duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          // Desktop: always visible. Collapsed rail expands over content on
          // hover / focus-within (overlay, no reflow); pinned = static + flush.
          "lg:z-30 lg:translate-x-0",
          pinned
            ? "lg:w-60"
            : "lg:w-16 lg:hover:w-60 lg:focus-within:w-60 lg:hover:shadow-2xl lg:focus-within:shadow-2xl",
        )}
        aria-label="Primary"
      >
        {/* Logo + pin row. */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <MessageSquare className="h-4 w-4" />
            </span>
            <span
              className={cn(
                "text-sm font-semibold text-foreground",
                revealOnExpand,
              )}
            >
              {t("title")}
            </span>
          </Link>
          <div className="flex items-center gap-1">
            {/* Desktop pin toggle — only reachable once the rail is expanded. */}
            <button
              type="button"
              onClick={togglePinned}
              aria-label={pinned ? t("unpinSidebar") : t("pinSidebar")}
              title={pinned ? t("unpinSidebar") : t("pinSidebar")}
              className={cn(
                "hidden h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
                pinned
                  ? "lg:flex"
                  : "lg:hidden lg:group-hover:flex lg:group-focus-within:flex",
              )}
            >
              {pinned ? (
                <PinOff className="h-5 w-5" />
              ) : (
                <Pin className="h-5 w-5" />
              )}
            </button>
            {/* Mobile close. */}
            <button
              type="button"
              onClick={onClose}
              aria-label={t("closeMenu")}
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Main navigation */}
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <ul className="flex flex-col gap-1">
            {navItems
              .filter((item) => accountRole && canAccessNav(accountRole, item.href))
              .map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/dashboard" && pathname.startsWith(item.href));

                const showUnreadDot =
                  item.href === "/inbox" && totalUnread > 0 && !isActive;

                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-label={t(item.labelKey as string)}
                      className={cn(
                        // Taller on mobile so fingers can hit the row reliably (≥44px).
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span className={cn("flex-1", revealOnExpand)}>
                        {t(item.labelKey as string)}
                      </span>
                      {item.beta && (
                        <span
                          aria-label={t("beta")}
                          className={cn(
                            "rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                            softBadge("amber"),
                            revealOnExpand,
                          )}
                        >
                          {t("beta")}
                        </span>
                      )}
                      {showUnreadDot && (
                        <span
                          aria-label={t("unreadConversations", { count: totalUnread })}
                          className="relative flex h-2 w-2 shrink-0"
                        >
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                          <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
          </ul>

          <div className="my-4 border-t border-border" />

          <ul className="flex flex-col gap-1">
            {bottomNavItems
              .filter((item) => accountRole && canAccessNav(accountRole, item.href))
              .map((item) => {
                const isActive = pathname.startsWith(item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-label={t(item.labelKey as string)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors lg:py-2",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span className={cn(revealOnExpand)}>
                        {t(item.labelKey as string)}
                      </span>
                    </Link>
                  </li>
                );
              })}
          </ul>
        </nav>

        {/* User section */}
        <div className="shrink-0 border-t border-border p-3">
          {/* Account name display — surfaced only when the account name
              differs from the user's own (see `showAccountStrip`). */}
          {showAccountStrip && account?.name ? (
            <div
              className={cn(
                "mb-2 flex items-center gap-2 px-3 text-xs text-muted-foreground",
                revealOnExpand,
              )}
            >
              <UsersRound className="size-3.5 shrink-0" />
              <span className="truncate" title={account.name}>
                {account.name}
              </span>
              {accountRole
                ? (() => {
                    const meta = ROLE_CHIP[accountRole];
                    const Icon = meta.icon;
                    return (
                      <span
                        className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${meta.className}`}
                      >
                        <Icon className="size-3" />
                        {t(meta.labelKey as string)}
                      </span>
                    );
                  })()
                : null}
            </div>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted/60 focus:bg-muted/60 focus:outline-none data-popup-open:bg-muted/60">
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? t("defaultAvatar")}
                  />
                ) : null}
                <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    "U"}
                </AvatarFallback>
              </Avatar>
              <div className={cn("min-w-0 flex-1", revealOnExpand)}>
                <p className="truncate text-sm font-medium text-foreground">
                  {profile?.full_name ?? t("defaultUser")}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {profile?.email ?? ""}
                </p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <User className="size-4" />
                {t("menuProfile")}
              </DropdownMenuItem>
              {accountRole && canAccessNav(accountRole, "/settings") && (
                <DropdownMenuItem
                  render={
                    <Link
                      href="/settings"
                      onClick={onClose}
                      className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                    />
                  }
                >
                  <Settings className="size-4" />
                  {t("menuSettings")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                {t("menuSignOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
