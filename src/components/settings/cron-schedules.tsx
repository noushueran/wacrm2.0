'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { useQuery } from '@/lib/convex/cached';
import { SettingsPanelHead } from './settings-panel-head';
import { CronSchedulesView, type ListControl } from './cron-schedules-view';

import { api } from '../../../convex/_generated/api';
import {
  COMPLETED_CAP,
  COMPLETED_DEFAULT_LIMIT,
  PENDING_DEFAULT_LIMIT,
  PENDING_SCAN_CAP,
  RUNS_CAP,
  RUNS_DEFAULT_LIMIT,
} from '../../../convex/lib/cronSummary';

// ============================================================
// CronSchedulesPanel — Settings → Cron schedules. Admin-gated on the
// same two layers as qualification-settings: 'cron' sits in
// CRITICAL_SECTIONS (page-level redirect) AND <RequireRole min="admin">
// below; both queries are skipped until the role is known. Data is
// live — Convex subscriptions push cron runs / scheduler changes as
// they happen; the 15s ticker only refreshes the relative labels.
//
// The history lists load bounded: small server-side defaults on first
// paint, and each "Show more" click re-queries with a bigger limit
// (capped server-side). The initial payload stays a handful of rows
// instead of the whole 7-day history.
// ============================================================

// How many extra rows each "Show more" click requests.
const SHOW_MORE_STEP = 25;

/**
 * Latch the last defined query result so bumping a limit (which makes
 * `useQuery` momentarily return `undefined` for the new args) expands
 * the list in place instead of blanking the panel. Render-phase state
 * adjustment per react.dev's "adjusting state when props change".
 */
function useLatched<T>(value: T | undefined): T | undefined {
  const [latched, setLatched] = useState(value);
  if (value !== undefined && value !== latched) {
    setLatched(value);
  }
  return value ?? latched;
}

function makeControl(
  limit: number,
  setLimit: (updater: (v: number) => number) => void,
  defaultLimit: number,
  cap: number,
  hasMore: boolean,
): ListControl {
  return {
    canShowMore: hasMore && limit < cap,
    expanded: limit > defaultLimit,
    showMore: () => setLimit((v) => Math.min(cap, v + SHOW_MORE_STEP)),
    showLess: () => setLimit(() => defaultLimit),
  };
}

export function CronSchedulesPanel() {
  const t = useTranslations('Settings.cron');
  const { canEditCriticalSettings } = useAuth();

  const [runsLimit, setRunsLimit] = useState(RUNS_DEFAULT_LIMIT);
  const [pendingLimit, setPendingLimit] = useState(PENDING_DEFAULT_LIMIT);
  const [completedLimit, setCompletedLimit] = useState(COMPLETED_DEFAULT_LIMIT);

  const overview = useLatched(
    useQuery(
      api.cronSchedules.overview,
      canEditCriticalSettings ? { runsLimit } : 'skip',
    ),
  );
  const tasks = useLatched(
    useQuery(
      api.cronSchedules.listSystemTasks,
      canEditCriticalSettings ? { pendingLimit, completedLimit } : 'skip',
    ),
  );

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <RequireRole min="admin">
      <div>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <CronSchedulesView
          overview={overview}
          tasks={tasks}
          now={now}
          controls={{
            runs: makeControl(
              runsLimit,
              setRunsLimit,
              RUNS_DEFAULT_LIMIT,
              RUNS_CAP,
              overview?.recentRunsOverflow ?? false,
            ),
            // Pending has more to reveal while fewer rows are shown than
            // the (scan-capped) true count the server reported.
            pending: makeControl(
              pendingLimit,
              setPendingLimit,
              PENDING_DEFAULT_LIMIT,
              PENDING_SCAN_CAP,
              tasks !== undefined && tasks.pending.length < tasks.pendingCount,
            ),
            completed: makeControl(
              completedLimit,
              setCompletedLimit,
              COMPLETED_DEFAULT_LIMIT,
              COMPLETED_CAP,
              tasks?.completedOverflow ?? false,
            ),
          }}
        />
      </div>
    </RequireRole>
  );
}
