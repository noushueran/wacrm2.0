'use client';

import { useMemo, useState } from 'react';
import { useQuery } from 'convex/react';
import { BarChart3, Bot, ClipboardCheck, PencilLine, Tag } from 'lucide-react';
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
import { formatCompactNumber } from '@/lib/currency';
import { format, parseISO } from 'date-fns';
import { daysAgoStart, lastNDayKeys, localDayKey } from '@/lib/dashboard/date-utils';
import { useTranslations } from 'next-intl';

import { api } from '../../../convex/_generated/api';

interface UsageResponse {
  window_days: number;
  truncated: boolean;
  totals: {
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  by_mode: {
    auto_reply: { calls: number; tokens: number };
    draft: { calls: number; tokens: number };
    classify: { calls: number; tokens: number };
    qualify: { calls: number; tokens: number };
  };
  by_model: {
    model: string;
    provider: string;
    calls: number;
    tokens: number;
  }[];
  daily: { date: string; tokens: number; calls: number }[];
}

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

  // `api.aiUsage.summary` takes a `sinceMs` cutoff (not a `days` count)
  // and returns raw `aiUsageLog` rows — no totals/by-mode/by-model/daily
  // breakdown baked in (that's dashboard-rendering logic the query
  // deliberately leaves to its caller; see that query's own doc comment
  // in convex/aiUsage.ts). `sinceMs` is memoized on `days` only, not
  // recomputed on every render, so switching windows re-queries but a
  // plain re-render doesn't. Skipped entirely for non-admins, mirroring
  // the old `if (!canView || !accountId) return` guard.
  const sinceMs = useMemo(() => daysAgoStart(days - 1).getTime(), [days]);
  const usageDocs = useQuery(
    api.aiUsage.summary,
    canView && accountId ? { sinceMs } : 'skip',
  );
  const loading = canView && usageDocs === undefined;

  // Same totals/by-mode/by-model/zero-filled-daily aggregation
  // `src/app/api/ai/usage/route.ts` used to do server-side, now done
  // client-side over the raw rows (reusing the same local-day bucketing
  // helpers every other dashboard chart uses, so day boundaries agree).
  // This query has no MAX_ROWS cap (unlike the old route), so
  // `truncated` is always false.
  const data = useMemo<UsageResponse | null>(() => {
    if (!usageDocs) return null;

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    const byMode = {
      auto_reply: { calls: 0, tokens: 0 },
      draft: { calls: 0, tokens: 0 },
      classify: { calls: 0, tokens: 0 },
      qualify: { calls: 0, tokens: 0 },
    };
    const modelMap = new Map<
      string,
      { model: string; provider: string; calls: number; tokens: number }
    >();
    const daily = new Map<string, { date: string; tokens: number; calls: number }>();
    for (const key of lastNDayKeys(days)) {
      daily.set(key, { date: key, tokens: 0, calls: 0 });
    }

    for (const row of usageDocs) {
      promptTokens += row.promptTokens;
      completionTokens += row.completionTokens;
      totalTokens += row.totalTokens;

      byMode[row.mode].calls += 1;
      byMode[row.mode].tokens += row.totalTokens;

      const mk = `${row.provider}:${row.model}`;
      const m =
        modelMap.get(mk) ??
        { model: row.model, provider: row.provider, calls: 0, tokens: 0 };
      m.calls += 1;
      m.tokens += row.totalTokens;
      modelMap.set(mk, m);

      const bucket = daily.get(localDayKey(new Date(row._creationTime)));
      if (bucket) {
        bucket.tokens += row.totalTokens;
        bucket.calls += 1;
      }
    }

    return {
      window_days: days,
      truncated: false,
      totals: {
        calls: usageDocs.length,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
      by_mode: byMode,
      by_model: [...modelMap.values()].sort((a, b) => b.tokens - a.tokens),
      daily: [...daily.values()],
    };
  }, [usageDocs, days]);

  if (profileLoading || !canView) return null;

  const chartData =
    data?.daily.map((d) => ({ day: format(parseISO(d.date), 'MMM d'), Tokens: d.tokens })) ??
    [];
  const hasSpend = (data?.totals.total_tokens ?? 0) > 0;

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
          <Select
            value={String(days)}
            onValueChange={(v) => setDays(Number(v))}
          >
            <SelectTrigger className="w-32 flex-shrink-0">
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
      </CardHeader>
      <CardContent className="space-y-5">
        {loading || !data ? (
          <Skeleton className="h-[220px] w-full" />
        ) : !hasSpend ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <BarChart3 className="h-8 w-8 opacity-40" />
            <p>No AI usage in the last {data.window_days} days yet.</p>
            <p className="text-xs">
              This fills in as the assistant drafts and auto-replies.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Total tokens" value={formatCompactNumber(data.totals.total_tokens)} />
              <Stat label="LLM calls" value={String(data.totals.calls)} />
              <Stat
                label="Auto-reply"
                value={formatCompactNumber(data.by_mode.auto_reply.tokens)}
                icon={Bot}
              />
              <Stat
                label="Drafts"
                value={formatCompactNumber(data.by_mode.draft.tokens)}
                icon={PencilLine}
              />
              <Stat
                label={t('classifyLabel')}
                value={formatCompactNumber(data.by_mode.classify.tokens)}
                icon={Tag}
              />
              <Stat
                label={t('qualifyLabel')}
                value={formatCompactNumber(data.by_mode.qualify.tokens)}
                icon={ClipboardCheck}
              />
            </div>

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

            {data.by_model.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  By model
                </p>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {data.by_model.map((m) => (
                    <li
                      key={`${m.provider}:${m.model}`}
                      className="flex items-center justify-between px-3 py-2 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-foreground">{m.model}</span>{' '}
                        <span className="text-xs text-muted-foreground">
                          ({m.provider})
                        </span>
                      </span>
                      <span className="flex-shrink-0 tabular-nums text-muted-foreground">
                        {formatCompactNumber(m.tokens)} tok · {m.calls}{' '}
                        {m.calls === 1 ? 'call' : 'calls'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.truncated && (
              <p className="text-xs text-muted-foreground">
                Showing a partial window — usage is high enough that only the
                most recent records are summarized here.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
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
