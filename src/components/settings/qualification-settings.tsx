'use client';

import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';

import { api } from '../../../convex/_generated/api';

// ============================================================
// QualificationSettings — Settings → Lead qualification (P0 skeleton;
// spec §11). Admin-gated on the same two layers as conversions-tab.tsx:
// 'qualification' sits in CRITICAL_SECTIONS (page-level redirect) AND
// <RequireRole min="admin"> below; the query itself is skipped until the
// role is known, so a sub-admin never round-trips into FORBIDDEN.
// P0 ships the master toggle + a read-only view of the active defaults;
// the question editor, cadence editor and admin-alert config arrive
// with their phases (P1–P4).
// ============================================================

function fmtMinute(minute: number): string {
  const h = String(Math.floor(minute / 60)).padStart(2, '0');
  const m = String(minute % 60).padStart(2, '0');
  return `${h}:${m}`;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function QualificationSettings() {
  const t = useTranslations('Settings.qualification');
  const { canEditCriticalSettings } = useAuth();
  const config = useQuery(
    api.qualification.getConfig,
    canEditCriticalSettings ? {} : 'skip',
  );
  const updateConfig = useMutation(api.qualification.updateConfig);
  const [saving, setSaving] = useState(false);

  const onToggle = async (enabled: boolean) => {
    setSaving(true);
    try {
      await updateConfig({ patch: { enabled } });
    } finally {
      setSaving(false);
    }
  };

  return (
    <RequireRole min="admin">
      <div>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        {config === undefined ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : (
          <div className="space-y-4">
            <Card>
              <CardContent className="flex items-center justify-between gap-4 pt-6">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{t('enableLabel')}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{t('enableDesc')}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {saving ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : null}
                  <Switch
                    checked={config.enabled}
                    onCheckedChange={onToggle}
                    disabled={saving}
                  />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-3 pt-6 text-sm">
                <p className="font-medium text-foreground">{t('defaultsTitle')}</p>
                <p className="text-muted-foreground">
                  {t('hours', {
                    start: fmtMinute(config.workStartMinute),
                    end: fmtMinute(config.workEndMinute),
                    tz: config.timezoneLabel,
                    days: config.workDays.map((d) => DAY_LABELS[d]).join(', '),
                  })}
                </p>
                <p className="text-muted-foreground">
                  {t('cadence', {
                    count: config.maxFollowUps,
                    window: config.sessionWindowHours,
                    threshold: config.qualifyThresholdScore,
                  })}
                </p>
                <p className="text-muted-foreground">{t('fallbackFields')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {config.basicFields.map((f) => (
                    <Badge key={f.key} variant="secondary">
                      {f.label}
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{t('comingSoon')}</p>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </RequireRole>
  );
}
