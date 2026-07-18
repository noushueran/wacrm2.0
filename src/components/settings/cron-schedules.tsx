'use client';

import { useEffect, useState } from 'react';
import { useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';

import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { SettingsPanelHead } from './settings-panel-head';
import { CronSchedulesView } from './cron-schedules-view';

import { api } from '../../../convex/_generated/api';

// ============================================================
// CronSchedulesPanel — Settings → Cron schedules. Admin-gated on the
// same two layers as qualification-settings: 'cron' sits in
// CRITICAL_SECTIONS (page-level redirect) AND <RequireRole min="admin">
// below; both queries are skipped until the role is known. Data is
// live — Convex subscriptions push cron runs / scheduler changes as
// they happen; the 15s ticker only refreshes the relative labels.
// ============================================================

export function CronSchedulesPanel() {
  const t = useTranslations('Settings.cron');
  const { canEditCriticalSettings } = useAuth();
  const overview = useQuery(
    api.cronSchedules.overview,
    canEditCriticalSettings ? {} : 'skip',
  );
  const tasks = useQuery(
    api.cronSchedules.listSystemTasks,
    canEditCriticalSettings ? {} : 'skip',
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
        <CronSchedulesView overview={overview} tasks={tasks} now={now} />
      </div>
    </RequireRole>
  );
}
