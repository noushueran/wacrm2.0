'use client';

import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import { Check, Loader2, Target } from 'lucide-react';

import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SettingsPanelHead } from './settings-panel-head';

import { api } from '../../../convex/_generated/api';

// ============================================================
// ConversionsTab — Settings → Conversions (Task B7b)
//
// Read-only admin view over `api.attribution.listConversions`
// (Task B7a): every inbound WhatsApp signal this account has POSTed
// to Platform A, tallied by match result (the "funnel"), plus the
// matched rows themselves — each one a lead whose WhatsApp message
// carried an attribution identifier Platform A confirmed against a
// real booking. Newest-`firedAt`-first, capped at 200 server-side.
//
// The query is `ctx.requireRole("admin")`-gated (it returns raw lead
// phone numbers), so this tab mirrors the same admin+ gate on two
// layers, exactly like `members-tab.tsx` / `whatsapp-config.tsx` /
// `api-keys-settings.tsx`:
//   1. Page-level: `'conversions'` is in `CRITICAL_SECTIONS`
//      (`src/lib/auth/roles.ts`), so `canAccessSettingsSection`
//      redirects anyone below admin away from `?tab=conversions`
//      before this component ever mounts.
//   2. Component-level: `<RequireRole min="admin">` below, so the
//      brief window where `accountRole` is still loading never
//      flashes this tab's content, and the query itself only ever
//      fires once we know the caller is admin+ (`'skip'` otherwise)
//      — never a round-trip that would just come back FORBIDDEN.
// ============================================================

const LANE_BADGE_CLASS: Record<'code' | 'ctwa', string> = {
  code: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
  ctwa: 'border-primary/40 bg-primary/10 text-primary',
};

const EMPTY_COUNTS = {
  total: 0,
  matched: 0,
  pending: 0,
  unmatched: 0,
  error: 0,
};

function fmtDateTime(ms: number): string {
  // Extends the "MMM d" short-month style `fmtDate` helpers use
  // elsewhere in settings (members-tab.tsx, api-keys-settings.tsx)
  // with a time-of-day component, via date-fns, since `firedAt` is a
  // precise event rather than just a day.
  return format(new Date(ms), 'MMM d, yyyy · HH:mm');
}

export function ConversionsTab() {
  const t = useTranslations('Settings.conversions');
  const { canEditCriticalSettings } = useAuth();

  // Admin+ only — same "skip client-side rather than round-trip into
  // a guaranteed FORBIDDEN" pattern `members-tab.tsx` uses for
  // `api.invitations.list`.
  const result = useQuery(
    api.attribution.listConversions,
    canEditCriticalSettings ? {} : 'skip',
  );
  const loading = result === undefined;

  const counts = result?.counts ?? EMPTY_COUNTS;
  const conversions = result?.conversions ?? [];
  const matchRate =
    counts.total > 0 ? Math.round((counts.matched / counts.total) * 100) : 0;

  const stats = useMemo(
    () => [
      { key: 'sent' as const, value: counts.total.toLocaleString() },
      { key: 'matched' as const, value: counts.matched.toLocaleString() },
      { key: 'matchRate' as const, value: `${matchRate}%` },
      { key: 'pending' as const, value: counts.pending.toLocaleString() },
      { key: 'unmatched' as const, value: counts.unmatched.toLocaleString() },
      { key: 'error' as const, value: counts.error.toLocaleString() },
    ],
    [counts, matchRate],
  );

  return (
    <RequireRole min="admin">
      <section className="animate-in fade-in-50 space-y-6 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {/* Funnel / summary */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {stats.map((stat) => (
                <div
                  key={stat.key}
                  className="rounded-xl border border-border bg-card p-4"
                >
                  <p className="text-xs font-medium text-muted-foreground">
                    {t(`funnel.${stat.key}`)}
                  </p>
                  <p className="mt-1.5 text-2xl leading-none font-bold tabular-nums text-foreground">
                    {stat.value}
                  </p>
                </div>
              ))}
            </div>

            {/* Table */}
            {conversions.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-10 text-center">
                  <Target className="size-6 text-muted-foreground" />
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t('empty')}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('columns.phone')}</TableHead>
                        <TableHead>{t('columns.identifier')}</TableHead>
                        <TableHead>{t('columns.lane')}</TableHead>
                        <TableHead>{t('columns.offer')}</TableHead>
                        <TableHead>{t('columns.time')}</TableHead>
                        <TableHead className="text-center">
                          {t('columns.fired')}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {conversions.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="font-medium text-foreground">
                            +{row.phone}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            <span
                              className="block max-w-[220px] truncate"
                              title={row.identifier}
                            >
                              {row.identifier}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant="outline"
                              className={LANE_BADGE_CLASS[row.lane]}
                            >
                              {t(`lane.${row.lane}`)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {row.offerSlug ?? '—'}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {fmtDateTime(row.firedAt ?? row.firstMessageAt)}
                          </TableCell>
                          <TableCell className="text-center">
                            <Check
                              className="mx-auto size-4 text-emerald-500"
                              aria-label={t('columns.fired')}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </section>
    </RequireRole>
  );
}
