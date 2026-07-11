"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/hooks/use-auth";
import { canAccessRoute, defaultLandingPath } from "@/lib/auth/roles";

/** Redirects a member who lands on a route their role can't access to
 *  their default home. Server queries already reject; this is UX. */
export function RequireSection({ children }: { children: ReactNode }) {
  const { accountRole, profileLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const blocked = !profileLoading && !!accountRole && !canAccessRoute(accountRole, pathname);

  useEffect(() => {
    if (blocked && accountRole) router.replace(defaultLandingPath(accountRole));
  }, [blocked, accountRole, router]);

  if (blocked) return null;
  return <>{children}</>;
}
