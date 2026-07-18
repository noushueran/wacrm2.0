'use client';

import { useMemo } from 'react';
import { useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';
import { format } from 'date-fns';
import { Loader2, Target } from 'lucide-react';

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
import { formatCurrency } from '@/lib/currency';
import { SettingsPanelHead } from './settings-panel-head';

import { api } from '../../../convex/_generated/api';

// ============================================================
// ConversionsTab — Settings → Conversions (Task B4)
//
// Read-only admin view over `api.conversionEvents.listRecent`: the most
// recent rows of the live funnel conversion outbox (Meta CAPI / Platform A
// pixel), newest first, capped server-side. Replaces the old
// `api.attribution.listConversions` view over `attributionSignals` — a
// table with NO remaining writers (the pipeline moved to
// `conversionEvents` when the funnel shipped, Task B5 deletes the dead
// write path) — which showed frozen historical rows forever.
//
// The query is `ctx.requireRole("admin")`-gated (it returns raw lead
// phone numbers, same as the query it replaces), so this tab mirrors the
// same admin+ gate on two layers, exactly like `members-tab.tsx` /
// `whatsapp-config.tsx` / `api-keys-settings.tsx`:
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

const STATUS_BADGE_CLASS: Record<string, string> = {
  sent: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
  pending: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
  unmatched: 'border-slate-500/40 bg-slate-500/10 text-slate-400',
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
  abandoned: 'border-muted-foreground/30 bg-muted text-muted-foreground',
};

function fmtDateTime(ms: number): string {
  // Extends the "MMM d" short-month style `fmtDate` helpers use
  // elsewhere in settings (members-tab.tsx, api-keys-settings.tsx) with
  // a time-of-day component, via date-fns, since `createdAt` is a
  // precise event rather than just a day.
  return format(new Date(ms), 'MMM d, yyyy · HH:mm');
}

export function ConversionsTab() {
  const t = useTranslations('Settings.conversions');
  // Reuses the funnel stage labels the inbox stepper already carries
  // (`Inbox.funnel.stage.*`) rather than duplicating them here —
  // `conversionEvents.stage` is the same 7-stage union minus `lost`
  // (a lost deal is never reported to Meta).
  const tFunnel = useTranslations('Inbox.funnel');
  const { canEditCriticalSettings } = useAuth();

  // Admin+ only — same "skip client-side rather than round-trip into
  // a guaranteed FORBIDDEN" pattern `members-tab.tsx` uses for
  // `api.invitations.list`.
  const rows = useQuery(
    api.conversionEvents.listRecent,
    canEditCriticalSettings ? {} : 'skip',
  );
  const loading = rows === undefined;
  const events = useMemo(() => rows ?? [], [rows]);

  return (
    <RequireRole min="admin">
      <section className="animate-in fade-in-50 space-y-6 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : events.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-10 text-center">
              <Target className="size-6 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">{t('empty')}</p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columns.contact')}</TableHead>
                    <TableHead>{t('columns.lane')}</TableHead>
                    <TableHead>{t('columns.stage')}</TableHead>
                    <TableHead>{t('columns.eventName')}</TableHead>
                    <TableHead>{t('columns.status')}</TableHead>
                    <TableHead className="text-center">{t('columns.attempts')}</TableHead>
                    <TableHead className="text-right">{t('columns.value')}</TableHead>
                    <TableHead>{t('columns.createdAt')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium text-foreground">
                        <div className="max-w-[200px] truncate">{row.contactName ?? '—'}</div>
                        <div className="text-xs font-normal text-muted-foreground">+{row.phone}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={LANE_BADGE_CLASS[row.lane]}>
                          {t(`lane.${row.lane}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {tFunnel(`stage.${row.stage}`)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <span className="block max-w-[160px] truncate" title={row.eventName}>
                          {row.eventName}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={STATUS_BADGE_CLASS[row.status]}>
                          {t(`status.${row.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center tabular-nums text-muted-foreground">
                        {row.attempts}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-foreground">
                        {row.value !== undefined ? formatCurrency(row.value, row.currency) : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {fmtDateTime(row.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </section>
    </RequireRole>
  );
}
