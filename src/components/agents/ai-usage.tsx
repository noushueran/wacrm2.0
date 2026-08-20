'use client';

import { useMemo, useState } from 'react';
import { useQuery } from 'convex/react';
import {
  BarChart3,
  Bot,
  ClipboardCheck,
  Coins,
  Gauge,
  Image,
  Info,
  ListChecks,
  Megaphone,
  PencilLine,
  RefreshCw,
  Settings2,
  Tag,
  Zap,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/dashboard/skeleton';
import { BarChart } from '@/components/tremor/bar-chart';
import { Button } from '@/components/ui/button';
import { ModelRatesDialog } from '@/components/agents/model-rates-dialog';
import {
  formatUsd,
  formatUsdWithAed,
  mergeRates,
  summarizeSpend,
} from '@/lib/ai/pricing';
import { formatCompactNumber } from '@/lib/currency';
import { format, parseISO } from 'date-fns';
import { daysAgoStart, lastNDayKeys } from '@/lib/dashboard/date-utils';
import { useTranslations } from 'next-intl';

import { api } from '../../../convex/_generated/api';

const WINDOWS = [7, 30, 90] as const;

/**
 * Token-spend dashboard for the account's BYO key. Admin-only (spend is
 * billing-class), mirroring the `ai_usage_log` SELECT policy and the
 * `GET /api/ai/usage` route. Renders nothing for non-admins.
 */
export function AiUsageCard() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canView = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Agents.usage');

  const [days, setDays] = useState<number>(30);

  // `api.aiUsage.summary` returns the finished breakdown — totals,
  // by-mode, by-model and a zero-filled daily series — folded server-side
  // out of the hourly rollup. It used to return every raw `aiUsageLog`
  // row for this component to aggregate, which at ~4k calls/day meant
  // ~120k documents for the default window: Convex killed the query and
  // this card showed its skeleton forever. See convex/lib/aiUsageStats.ts.
  //
  // Local day boundaries are the caller's-timezone concept, so `sinceMs`,
  // `dayKeys` and `tzOffsetMinutes` are computed here and passed to the
  // UTC-only aggregation — the same contract `dashboard.conversationsSeries`
  // uses. Memoized on `days` so switching windows re-queries but a plain
  // re-render doesn't. Skipped entirely for non-admins, mirroring the old
  // `if (!canView || !accountId) return` guard.
  const usageArgs = useMemo(
    () =>
      canView && accountId
        ? {
            sinceMs: daysAgoStart(days - 1).getTime(),
            dayKeys: lastNDayKeys(days),
            tzOffsetMinutes: new Date().getTimezoneOffset(),
          }
        : ('skip' as const),
    [canView, accountId, days],
  );
  const data = useQuery(api.aiUsage.summary, usageArgs);
  const loading = canView && data === undefined;

  // Admin-gated on the server too (`aiModelRates.list` calls
  // `requireRole("admin")`), so this mirrors the guard rather than being
  // the guard. Skipped for non-admins alongside the summary.
  const rateDocs = useQuery(
    api.aiModelRates.list,
    canView && accountId ? {} : ('skip' as const),
  );

  const [ratesOpen, setRatesOpen] = useState(false);

  // Spend is derived, never stored: the rollup counts tokens, the rate
  // table prices them, and this joins the two at read time so editing a
  // rate re-prices history immediately.
  const spend = useMemo(
    () => summarizeSpend(data?.byModel ?? [], mergeRates(rateDocs ?? [])),
    [data?.byModel, rateDocs],
  );

  // The rate editor offers a row per model actually seen in the window,
  // so the list matches what the card shows rather than every model that
  // ever billed.
  const ratedModels = useMemo(
    () =>
      (data?.byModel ?? []).map((m) => ({ model: m.model, provider: m.provider })),
    [data?.byModel],
  );

  if (profileLoading || !canView) return null;

  const chartData =
    data?.daily.map((d) => ({ day: format(parseISO(d.date), 'MMM d'), Tokens: d.tokens })) ??
    [];
  const hasSpend = (data?.totals.totalTokens ?? 0) > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <BarChart3 className="h-4 w-4 text-primary" /> Token usage
            </CardTitle>
            <CardDescription>
              Tokens spent on your provider key by drafts and the auto-reply
              bot. Counts only — no message content is stored here.
            </CardDescription>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRatesOpen(true)}
              disabled={ratedModels.length === 0}
            >
              <Settings2 className="mr-1.5 h-3.5 w-3.5" />
              Rates
            </Button>
            <Select
              value={String(days)}
              onValueChange={(v) => setDays(Number(v))}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((w) => (
                  <SelectItem key={w} value={String(w)}>
                    Last {w} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>

      <ModelRatesDialog
        open={ratesOpen}
        onOpenChange={setRatesOpen}
        models={ratedModels}
      />
      <CardContent className="space-y-5">
        {loading || !data ? (
          <Skeleton className="h-[220px] w-full" />
        ) : !hasSpend ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <BarChart3 className="h-8 w-8 opacity-40" />
            <p>No AI usage in the last {data.windowDays} days yet.</p>
            <p className="text-xs">
              This fills in as the assistant drafts and auto-replies.
            </p>
          </div>
        ) : (
          <>
            {/* Spend leads the card: it is the question the tiles below
                are a breakdown OF, and the one figure that reconciles
                against the provider's bill. Deliberately labelled as a
                floor whenever anything was excluded — see `spendCaveats`. */}
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Coins className="h-3.5 w-3.5" />
                {spend.complete ? 'Spend' : 'Spend (at least)'} · last{' '}
                {data.windowDays} days
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                {formatUsdWithAed(spend.totalUsd)}
              </p>
              <SpendCaveats spend={spend} />
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
              <Stat label="Total tokens" value={formatCompactNumber(data.totals.totalTokens)} />
              <Stat label="LLM calls" value={String(data.totals.calls)} />
              <Stat
                label="Auto-reply"
                value={formatCompactNumber(data.byMode.auto_reply.tokens)}
                icon={Bot}
              />
              <Stat
                label="Drafts"
                value={formatCompactNumber(data.byMode.draft.tokens)}
                icon={PencilLine}
              />
              <Stat
                label={t('classifyLabel')}
                value={formatCompactNumber(data.byMode.classify.tokens)}
                icon={Tag}
              />
              <Stat
                label={t('qualifyLabel')}
                value={formatCompactNumber(data.byMode.qualify.tokens)}
                icon={ClipboardCheck}
              />
              <Stat
                label={t('checklistLabel')}
                value={formatCompactNumber(data.byMode.checklist.tokens)}
                icon={ListChecks}
              />
              {/* Lead scoring had no tile at all, so its spend counted
                  toward Total while appearing in no breakdown — the tiles
                  silently stopped reconciling the moment it was enabled. */}
              <Stat
                label="Lead scoring"
                value={formatCompactNumber(data.byMode.score.tokens)}
                icon={Gauge}
              />
              {/* Ad matching split out of `classify` on 2026-08-08. Without
                  its own tile it would repeat the lead-scoring mistake
                  directly above: counted in Total, shown in no breakdown. */}
              <Stat
                label="Ad matching"
                value={formatCompactNumber(data.byMode.match_service.tokens)}
                icon={Megaphone}
              />
              {/* Same reasoning again: a mode with no tile is counted in
                  Total and shown in no breakdown. */}
              <Stat
                label="Revival"
                value={formatCompactNumber(data.byMode.revive.tokens)}
                icon={RefreshCw}
              />
              {/* Media understanding: vision over images/PDFs plus
                  speech-to-text. Billed to the same key since it shipped,
                  logged only from 2026-07-27. */}
              <Stat
                label="Media"
                value={formatCompactNumber(
                  data.byMode.describe.tokens + data.byMode.transcribe.tokens,
                )}
                icon={Image}
              />
              <Stat
                label="Embeddings"
                value={formatCompactNumber(data.byMode.embed.tokens)}
                icon={Zap}
              />
            </div>

            {/* Prompt-cache health. The reply prompt is dominated by a
                static ~3.9k-token prefix (the fixed scaffold plus the
                account's Business Context); when it hits the provider's
                prefix cache those tokens bill at ~10% of the input rate,
                so this ratio is the single biggest lever on the bill. */}
            {data.totals.cacheablePromptTokens > 0 && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat
                  label="Prompt cache hit rate"
                  value={`${Math.round(
                    (data.totals.cachedPromptTokens /
                      data.totals.cacheablePromptTokens) *
                      100,
                  )}%`}
                />
                <Stat
                  label="Cached prompt tokens"
                  value={formatCompactNumber(data.totals.cachedPromptTokens)}
                />
                <Stat
                  label="Reasoning tokens"
                  value={formatCompactNumber(data.totals.reasoningTokens)}
                />
              </div>
            )}

            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Tokens per day
              </p>
              <BarChart
                data={chartData}
                index="day"
                categories={['Tokens']}
                colors={['violet']}
                valueFormatter={(v) => formatCompactNumber(v)}
                showLegend={false}
                yAxisWidth={48}
                className="h-[200px]"
              />
            </div>

            {data.byModel.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  By model
                </p>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {spend.models.map((m) => (
                    <li
                      key={`${m.provider}:${m.model}`}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-foreground">{m.model}</span>{' '}
                        <span className="text-xs text-muted-foreground">
                          ({m.provider})
                        </span>
                      </span>
                      <span className="flex flex-shrink-0 items-center gap-3 tabular-nums text-muted-foreground">
                        <span>
                          {formatCompactNumber(m.tokens)} tok · {m.calls}{' '}
                          {m.calls === 1 ? 'call' : 'calls'}
                        </span>
                        {/* A dash, not "$0.00" — the whole point of
                            `rowCostUsd` returning null is that unpriced
                            must never render as free. */}
                        <span
                          className={
                            m.costUsd === null
                              ? 'w-20 text-right text-muted-foreground/60'
                              : 'w-20 text-right font-medium text-foreground'
                          }
                          title={
                            m.unpricedReason === 'no-rate'
                              ? 'No rate for this model — add one under Rates'
                              : m.unpricedReason === 'no-split'
                                ? 'Rolled up before per-model token splits were recorded'
                                : undefined
                          }
                        >
                          {m.costUsd === null ? '—' : formatUsd(m.costUsd)}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* No "partial window" notice any more: the read is a
                function of the WINDOW (24 rollup rows per day), not of
                call volume, so a busy account no longer truncates — it
                was the unbounded read that used to fail outright. */}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Everything the spend figure does NOT cover, stated on the card rather
 * than in a comment nobody reading the number will see.
 *
 * There are three separate holes and they are listed separately because
 * they need three different actions:
 *
 *   1. A model with no rate — the admin types one in under Rates.
 *   2. A model rolled up before per-model token splits existed — only
 *      re-running `aiUsage.backfillAiUsageHourlyStats` fixes it.
 *   3. Media understanding (`describe` / `transcribe`) is never written
 *      to `aiUsageLog` at all, so it is missing from the rollup and
 *      therefore from spend, whatever the rates say. This one is
 *      unconditional: it holds even when the window prices completely,
 *      which is exactly when a reader is most likely to take the total
 *      as the whole bill.
 */
export function SpendCaveats({
  spend,
}: {
  spend: ReturnType<typeof summarizeSpend>;
}) {
  const lines: string[] = [];

  if (spend.needRates.length > 0) {
    lines.push(
      `Excludes ${spend.needRates.length === 1 ? 'a model with no rate' : `${spend.needRates.length} models with no rate`}: ${spend.needRates.join(', ')}. Add rates to include them.`,
    );
  }
  if (spend.needBackfill.length > 0) {
    lines.push(
      `Excludes hours rolled up before per-model token splits were recorded (${spend.needBackfill.join(', ')}). Re-run the usage backfill to price them.`,
    );
  }
  lines.push(
    'Excludes image, PDF and voice-note understanding — those calls bill your key but are not logged.',
  );

  return (
    <ul className="mt-2 space-y-1">
      {lines.map((line) => (
        <li
          key={line}
          className="flex items-start gap-1.5 text-xs text-muted-foreground"
        >
          <Info className="mt-0.5 h-3 w-3 flex-shrink-0" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

function Stat({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon?: typeof Bot;
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
        {value}
      </p>
    </div>
  );
}
