'use client';

import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, ExternalLink, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { softBadge } from '@/lib/ui/soft-badge';
import { cn } from '@/lib/utils';

// ============================================================
// CronSchedulesView — presentational body of Settings → Cron
// schedules. Pure props in, markup out (no queries), so the panel can
// be previewed with mock data and unit-tested without Convex. Data
// shapes mirror api.cronSchedules.overview / listSystemTasks.
// ============================================================

export interface CronRunEntry {
  id: string;
  name: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  status: 'running' | 'success' | 'failed';
  error: string | null;
}

export interface CronEntry {
  name: string;
  intervalMinutes: number;
  lastRun: CronRunEntry | null;
  nextRunAt: number | null;
}

export interface FollowUpEntry {
  sessionId: string;
  conversationId: string;
  contactName: string;
  serviceName: string | null;
  nextFollowUpAt: number;
  followUpsSent: number;
  maxFollowUps: number;
}

export interface OfferEntry {
  offerId: string;
  agentName: string;
  contactName: string;
  offeredAt: number;
  expiresAt: number;
}

export interface CronOverviewData {
  crons: CronEntry[];
  recentRuns: CronRunEntry[];
  recentRunsOverflow: boolean;
  followUps: FollowUpEntry[];
  offers: OfferEntry[];
  qualificationEnabled: boolean;
}

export interface PendingTaskEntry {
  id: string;
  name: string;
  scheduledTime: number;
  inProgress: boolean;
}

export interface CompletedTaskEntry {
  id: string;
  name: string;
  completedTime: number | null;
  outcome: 'success' | 'failed';
  error: string | null;
}

export interface SystemTasksData {
  pending: PendingTaskEntry[];
  /** True pending total (scan-capped server-side; render "N+" on overflow). */
  pendingCount: number;
  pendingOverflow: boolean;
  completed: CompletedTaskEntry[];
  completedOverflow: boolean;
}

/** Per-list expand state the panel owns; the view just renders it. */
export interface ListControl {
  canShowMore: boolean;
  expanded: boolean;
  showMore: () => void;
  showLess: () => void;
}

type Translator = ReturnType<typeof useTranslations<'Settings.cron'>>;

/**
 * Known one-off scheduler functions → friendly i18n label keys.
 * Specific prefixes first — the module-wide catch-alls below them pick
 * up any sibling function so new scheduler targets in a covered module
 * still get a sensible label. Unmatched names render raw (never
 * hidden), so an entirely new module remains visible either way.
 */
const JOB_LABELS: Array<[prefix: string, key: string]> = [
  ['aiReply.', 'aiReply'],
  ['qualificationEngine.analyzeInbound', 'leadAnalysis'],
  ['qualificationEngine.sendFollowUp', 'followUpNudge'],
  ['qualificationEngine.sendClosingMessage', 'closingMessage'],
  ['qualificationEngine.sendAdminAlerts', 'adminAlert'],
  ['qualificationEngine.relayQuestionToAdmin', 'askAdmin'],
  ['qualificationEngine.relayAnswerToCustomer', 'adminAnswer'],
  ['qualificationEngine.startLeadOffer', 'leadOffer'],
  ['qualificationEngine.announceAssignment', 'leadOffer'],
  ['qualificationEngine.notifyStaffText', 'staffMessage'],
  ['qualificationEngine.', 'qualification'],
  ['pushSend.', 'push'],
  ['webhookDelivery.', 'webhook'],
  ['conversionEvents.', 'conversion'],
  ['metaSend.', 'whatsappSend'],
  ['ingest.', 'ingest'],
  ['cronSchedules.', 'cronWrapper'],
  ['broadcasts.', 'broadcast'],
  ['attribution.', 'attribution'],
  ['campaignAds.', 'adResolution'],
  ['aiKnowledge.', 'kbIngest'],
  ['flowsEngine.', 'flowTimer'],
  ['automationsEngine.', 'automationTimer'],
  ['salesChecklists.', 'checklist'],
];

function jobLabel(name: string, t: Translator): string {
  const hit = JOB_LABELS.find(([prefix]) => name.startsWith(prefix));
  return hit ? t(`jobs.${hit[1]}`) : name;
}

/** Signed relative time — "in 4m" / "2h ago" / "just now". */
function rel(ts: number, now: number, t: Translator): string {
  const diff = ts - now;
  const future = diff > 0;
  const s = Math.round(Math.abs(diff) / 1000);
  if (!future && s < 10) return t('rel.justNow');
  if (s < 60) return t(future ? 'rel.inS' : 'rel.agoS', { n: Math.max(1, s) });
  const m = Math.floor(s / 60);
  if (m < 60) return t(future ? 'rel.inM' : 'rel.agoM', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t(future ? 'rel.inH' : 'rel.agoH', { n: h });
  const d = Math.floor(h / 24);
  return t(future ? 'rel.inD' : 'rel.agoD', { n: d });
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function StatusDot({ status }: { status: CronRunEntry['status'] | 'idle' }) {
  if (status === 'running') {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />;
  }
  return (
    <span
      className={cn(
        'size-2.5 shrink-0 rounded-full',
        status === 'success' && 'bg-emerald-500',
        status === 'failed' && 'bg-rose-500',
        status === 'idle' && 'bg-muted-foreground/40',
      )}
    />
  );
}

function GroupHead({ label, count }: { label: string; count: number | string }) {
  return (
    <div className="flex items-center gap-2">
      <p className="text-sm font-medium text-foreground">{label}</p>
      <Badge variant="outline" className={cn('px-1.5 text-xs', softBadge('neutral'))}>
        {count}
      </Badge>
    </div>
  );
}

/**
 * "Show more" / "Show less" footer under a bounded list. "Show more"
 * re-queries with a bigger limit — nothing beyond the visible slice is
 * fetched until it is clicked.
 */
function ShowMoreFooter({ control }: { control: ListControl }) {
  const t = useTranslations('Settings.cron');
  if (!control.canShowMore && !control.expanded) return null;
  return (
    <div className="mt-1 flex items-center gap-2">
      {control.canShowMore ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={control.showMore}
        >
          <ChevronDown className="size-3.5" />
          {t('actions.showMore')}
        </Button>
      ) : null}
      {control.expanded ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={control.showLess}
        >
          <ChevronUp className="size-3.5" />
          {t('actions.showLess')}
        </Button>
      ) : null}
    </div>
  );
}

export function CronSchedulesView({
  overview,
  tasks,
  now,
  controls,
}: {
  overview: CronOverviewData | undefined;
  tasks: SystemTasksData | undefined;
  now: number;
  controls: { runs: ListControl; pending: ListControl; completed: ListControl };
}) {
  const t = useTranslations('Settings.cron');

  if (overview === undefined) {
    return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />;
  }

  const upcomingTotal =
    overview.followUps.length +
    overview.offers.length +
    (tasks?.pendingCount ?? 0);
  // "N+" wherever a server-side cap may hide rows beyond the count.
  const upcomingLabel = tasks?.pendingOverflow
    ? `${upcomingTotal}+`
    : upcomingTotal;
  const completedTotal =
    overview.recentRuns.length + (tasks?.completed.length ?? 0);
  const completedLabel =
    overview.recentRunsOverflow || (tasks?.completedOverflow ?? false)
      ? `${completedTotal}+`
      : completedTotal;

  return (
    <div className="space-y-4">
      {/* Recurring interval crons */}
      <Card>
        <CardContent className="pt-6">
          <GroupHead label={t('recurring.title')} count={overview.crons.length} />
          <p className="mt-1 text-xs text-muted-foreground">{t('recurring.desc')}</p>
          <div className="mt-3 divide-y divide-border">
            {overview.crons.map((cron) => {
              const nextDue = cron.nextRunAt !== null && cron.nextRunAt <= now;
              return (
                <div
                  key={cron.name}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5"
                >
                  <StatusDot status={cron.lastRun?.status ?? 'idle'} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {t(`crons.${cron.name}.title`)}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {cron.name} · {t('recurring.every', { min: cron.intervalMinutes })}
                    </p>
                    {cron.lastRun?.status === 'failed' && cron.lastRun.error ? (
                      <p className="mt-0.5 truncate text-xs text-rose-600 dark:text-rose-400">
                        {cron.lastRun.error}
                      </p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right text-xs text-muted-foreground">
                    <p>
                      {t('recurring.lastRun')}{' '}
                      <span className="text-foreground">
                        {cron.lastRun ? rel(cron.lastRun.startedAt, now, t) : t('recurring.never')}
                      </span>
                    </p>
                    <p>
                      {t('recurring.nextRun')}{' '}
                      <span className="text-foreground">
                        {cron.nextRunAt === null
                          ? t('recurring.pendingFirstRun')
                          : nextDue
                            ? t('rel.dueNow')
                            : rel(cron.nextRunAt, now, t)}
                      </span>
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Upcoming scheduled work */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div>
            <GroupHead label={t('upcoming.title')} count={upcomingLabel} />
            <p className="mt-1 text-xs text-muted-foreground">{t('upcoming.desc')}</p>
          </div>

          {overview.followUps.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('upcoming.followUps', { count: overview.followUps.length })}
              </p>
              <div className="mt-1 divide-y divide-border">
                {overview.followUps.map((f) => (
                  <div key={f.sessionId} className="flex items-center gap-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">
                        {f.contactName}
                        {f.serviceName ? (
                          <span className="text-muted-foreground"> · {f.serviceName}</span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('upcoming.attempt', {
                          n: Math.min(f.followUpsSent + 1, f.maxFollowUps),
                          max: f.maxFollowUps,
                        })}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-foreground">
                      {rel(f.nextFollowUpAt, now, t)}
                    </span>
                    <a
                      href={`/inbox?c=${f.conversationId}`}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={t('upcoming.openChat')}
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {overview.offers.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('upcoming.offers', { count: overview.offers.length })}
              </p>
              <div className="mt-1 divide-y divide-border">
                {overview.offers.map((o) => (
                  <div key={o.offerId} className="flex items-center gap-3 py-2">
                    <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                      {o.agentName}
                      <span className="text-muted-foreground"> ← {o.contactName}</span>
                    </p>
                    <span className="shrink-0 text-xs text-foreground">
                      {t('upcoming.expires')} {rel(o.expiresAt, now, t)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {tasks && tasks.pending.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('upcoming.queued', {
                  count: tasks.pendingOverflow
                    ? `${tasks.pendingCount}+`
                    : tasks.pendingCount,
                })}
              </p>
              <div className="mt-1 divide-y divide-border">
                {tasks.pending.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 py-2">
                    {p.inProgress ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <StatusDot status="idle" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{jobLabel(p.name, t)}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{p.name}</p>
                    </div>
                    <span className="shrink-0 text-xs text-foreground">
                      {p.inProgress
                        ? t('upcoming.runningNow')
                        : p.scheduledTime <= now
                          ? t('rel.dueNow')
                          : rel(p.scheduledTime, now, t)}
                    </span>
                  </div>
                ))}
              </div>
              <ShowMoreFooter control={controls.pending} />
            </div>
          ) : null}

          {upcomingTotal === 0 ? (
            <p className="text-sm text-muted-foreground">{t('upcoming.empty')}</p>
          ) : null}

          {!overview.qualificationEnabled ? (
            <p className="text-xs text-muted-foreground">{t('upcoming.qualificationOff')}</p>
          ) : null}
        </CardContent>
      </Card>

      {/* Completed work */}
      <Card>
        <CardContent className="space-y-4 pt-6">
          <div>
            <GroupHead label={t('recent.title')} count={completedLabel} />
            <p className="mt-1 text-xs text-muted-foreground">{t('recent.desc')}</p>
          </div>

          {overview.recentRuns.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('recent.cronRuns', {
                  count: overview.recentRunsOverflow
                    ? `${overview.recentRuns.length}+`
                    : overview.recentRuns.length,
                })}
              </p>
              <div className="mt-1 divide-y divide-border">
                {overview.recentRuns.map((run) => (
                  <div key={run.id} className="flex items-center gap-3 py-2">
                    <StatusDot status={run.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">
                        {t(`crons.${run.name}.title`)}
                      </p>
                      {run.status === 'failed' && run.error ? (
                        <p className="truncate text-xs text-rose-600 dark:text-rose-400">
                          {run.error}
                        </p>
                      ) : null}
                    </div>
                    {run.durationMs !== null ? (
                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                        {fmtDuration(run.durationMs)}
                      </span>
                    ) : null}
                    <span className="shrink-0 text-xs text-foreground">
                      {rel(run.startedAt, now, t)}
                    </span>
                  </div>
                ))}
              </div>
              <ShowMoreFooter control={controls.runs} />
            </div>
          ) : null}

          {tasks && tasks.completed.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('recent.tasks', {
                  count: tasks.completedOverflow
                    ? `${tasks.completed.length}+`
                    : tasks.completed.length,
                })}
              </p>
              <div className="mt-1 divide-y divide-border">
                {tasks.completed.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 py-2">
                    <StatusDot status={c.outcome} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{jobLabel(c.name, t)}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{c.name}</p>
                      {c.outcome === 'failed' && c.error ? (
                        <p className="truncate text-xs text-rose-600 dark:text-rose-400">
                          {c.error}
                        </p>
                      ) : null}
                    </div>
                    {c.completedTime !== null ? (
                      <span className="shrink-0 text-xs text-foreground">
                        {rel(c.completedTime, now, t)}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
              <ShowMoreFooter control={controls.completed} />
            </div>
          ) : null}

          {overview.recentRuns.length === 0 && (tasks?.completed.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">{t('recent.empty')}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
