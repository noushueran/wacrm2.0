"use client";

import { useMemo } from "react";
import { useQuery } from "@/lib/convex/cached";
import { api } from "../../../convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { useTranslations } from "next-intl";

/**
 * Local-midnight start of the current calendar month, in ms. Same
 * "this month" local-calendar convention as `startOfThisMonth` in
 * `src/components/dashboard/lead-spend-card.tsx` — duplicated here
 * rather than shared because that card also needs an "all time"
 * toggle this line doesn't.
 */
function startOfThisMonth(d: Date = new Date()): number {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/**
 * Inbox "own spend" line — the agent-facing substitute for the
 * Dashboard's "Lead spend" card
 * (`src/components/dashboard/lead-spend-card.tsx`). Agents are
 * RBAC-limited to Inbox + Notifications (`defaultLandingPath` /
 * dashboard route guards), so they can never reach `/dashboard` to see
 * that card. This renders a compact this-month summary at the top of
 * the conversation list instead, reusing the same
 * `api.leadCharges.report` query.
 *
 * Only renders for `accountRole === 'agent'` — supervisors/admins/
 * owners already have the dashboard card, so this stays hidden for
 * them. Also self-hides while the report is loading or when the
 * account has never set a positive `leadValue`
 * (`report.enabled === false`), mirroring `LeadSpendCard`'s own
 * self-hide, so the call site needs no conditional.
 */
export function OwnSpendLine() {
  const t = useTranslations("Inbox.ownSpend");
  const { accountId, accountRole } = useAuth();

  // Computed once per mount — this is a glanceable summary line, not
  // a live clock, so it doesn't need to track a month rollover
  // mid-session.
  const startOfThisMonthMs = useMemo(() => startOfThisMonth(), []);

  const report = useQuery(
    api.leadCharges.report,
    accountId ? { from: startOfThisMonthMs } : "skip",
  );

  if (accountRole !== "agent") return null;
  if (report === undefined || report.enabled === false) return null;

  const row = report.rows[0];

  return (
    <div className="border-b border-border px-3 py-1.5">
      <p className="text-xs text-muted-foreground">
        {t("line", {
          amount: formatCurrency(row?.totalSpent ?? 0, report.currency),
          count: row?.leadCount ?? 0,
        })}
      </p>
    </div>
  );
}
