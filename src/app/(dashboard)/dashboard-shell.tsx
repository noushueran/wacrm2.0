"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { BottomNav } from "@/components/layout/bottom-nav";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { ServiceWorkerManager } from "@/components/pwa/service-worker-manager";
import { InboxNotifier } from "@/components/pwa/inbox-notifier";
import { InstallPrompt } from "@/components/pwa/install-prompt";
import { RequireSection } from "@/components/auth/require-section";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    // `pt-safe` keeps the header out from under the iOS status bar. The
    // installed PWA runs `viewport-fit=cover` + `black-translucent`, so the
    // web view extends to the physical top of the screen — without this the
    // whole h-14 header (hamburger, brand, title, bell, avatar) renders
    // underneath the ~59px status bar and is unreachable. Tailwind's
    // border-box means the padding comes OUT of h-dvh rather than adding to
    // it, so the flex children below still fit exactly. Safe on desktop,
    // where the inset is 0. The fixed sidebar can't inherit this and carries
    // its own `pt-safe`.
    <div className="flex h-dvh overflow-hidden bg-background pt-safe">
      {/* Reports this tab's online/away presence once we know a user is
          signed in. Headless — renders nothing. */}
      <PresenceHeartbeat />
      <ServiceWorkerManager />
      <InboxNotifier />
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Thinner horizontal padding on mobile so cards have room to breathe.
            Bottom padding on mobile clears the fixed BottomNav — but BottomNav
            hides itself on /inbox (a full-bleed surface), so skip pb-20 there
            to avoid ~4rem of empty scroll space below the composer. */}
        <main
          className={`flex-1 overflow-y-auto p-4 sm:p-6 lg:pb-6 ${
            pathname.startsWith("/inbox") ? "" : "pb-20"
          }`}
        >
          <RequireSection>{children}</RequireSection>
        </main>
      </div>
      <BottomNav onOpenMore={() => setSidebarOpen(true)} />
      <InstallPrompt />
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
