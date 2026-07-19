'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
  const templates = useQuery(
    api.templates.list,
    canEditCriticalSettings ? {} : 'skip',
  );
  const tags = useQuery(api.tags.list, canEditCriticalSettings ? {} : 'skip');
  const members = useQuery(api.members.list, canEditCriticalSettings ? {} : 'skip');
  const memberTagLinks = useQuery(
    api.memberTags.list,
    canEditCriticalSettings ? {} : 'skip',
  );
  const setForTag = useMutation(api.memberTags.setForTag);
  const updateConfig = useMutation(api.qualification.updateConfig);
  const [routingSavingTag, setRoutingSavingTag] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [purchaseSaving, setPurchaseSaving] = useState(false);
  const [alertsSaving, setAlertsSaving] = useState(false);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [alertsSaved, setAlertsSaved] = useState(false);

  // Alerts & templates form state, hydrated from the stored config once.
  const [phonesInput, setPhonesInput] = useState('');
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [autoAssign, setAutoAssign] = useState(true);
  const [reengagementName, setReengagementName] = useState('');
  const [alertTemplateName, setAlertTemplateName] = useState('');
  // Contact-card (company half) form state — the card the customer
  // receives when an agent accepts a lead. Same hydrate-once pattern.
  const [card, setCard] = useState({
    companyName: '',
    website: '',
    email: '',
    phone: '',
    street: '',
    city: '',
    state: '',
    zip: '',
    country: '',
    countryCode: '',
  });
  const [cardSaving, setCardSaving] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [cardSaved, setCardSaved] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!config || hydrated) return;
    setPhonesInput(config.adminAlertPhones.join(', '));
    setAlertsEnabled(config.adminAlertEnabled);
    setAutoAssign(config.autoAssignEnabled !== false);
    setReengagementName(config.reengagementTemplateName ?? '');
    setAlertTemplateName(config.adminAlertTemplateName ?? '');
    const cc = config.contactCard;
    setCard({
      companyName: cc?.companyName ?? '',
      website: cc?.website ?? '',
      email: cc?.email ?? '',
      phone: cc?.phone ?? '',
      street: cc?.street ?? '',
      city: cc?.city ?? '',
      state: cc?.state ?? '',
      zip: cc?.zip ?? '',
      country: cc?.country ?? '',
      countryCode: cc?.countryCode ?? '',
    });
    setHydrated(true);
  }, [config, hydrated]);

  const templateLanguage = (name: string): string | undefined =>
    templates?.find((row) => row.name === name)?.language ?? undefined;

  const onToggle = async (enabled: boolean) => {
    setSaving(true);
    try {
      await updateConfig({ patch: { enabled } });
    } finally {
      setSaving(false);
    }
  };

  const onTogglePurchase = async (purchaseSignalsEnabled: boolean) => {
    setPurchaseSaving(true);
    try {
      await updateConfig({ patch: { purchaseSignalsEnabled } });
    } finally {
      setPurchaseSaving(false);
    }
  };

  const onSaveAlerts = async () => {
    setAlertsSaving(true);
    setAlertsError(null);
    setAlertsSaved(false);
    try {
      await updateConfig({
        patch: {
          adminAlertEnabled: alertsEnabled,
          autoAssignEnabled: autoAssign,
          adminAlertPhones: phonesInput
            .split(/[,\n]/)
            .map((p) => p.trim())
            .filter(Boolean),
          reengagementTemplateName: reengagementName || undefined,
          reengagementTemplateLanguage: reengagementName
            ? templateLanguage(reengagementName)
            : undefined,
          adminAlertTemplateName: alertTemplateName || undefined,
          adminAlertTemplateLanguage: alertTemplateName
            ? templateLanguage(alertTemplateName)
            : undefined,
        },
      });
      setAlertsSaved(true);
    } catch (err) {
      const data = (err as { data?: { reason?: string } })?.data;
      setAlertsError(data?.reason ?? t('alerts.saveError'));
    } finally {
      setAlertsSaving(false);
    }
  };

  const onSaveCard = async () => {
    setCardSaving(true);
    setCardError(null);
    setCardSaved(false);
    try {
      // Trim everything; omit blanks so the stored object only carries
      // real values (the send path treats missing as "not configured").
      const contactCard = Object.fromEntries(
        Object.entries(card)
          .map(([k, v]) => [k, v.trim()])
          .filter(([, v]) => v !== ''),
      );
      await updateConfig({ patch: { contactCard } });
      setCardSaved(true);
    } catch (err) {
      const data = (err as { data?: { reason?: string } })?.data;
      setCardError(data?.reason ?? t('contactCard.saveError'));
    } finally {
      setCardSaving(false);
    }
  };

  const setCardField = (key: keyof typeof card) => (value: string) =>
    setCard((prev) => ({ ...prev, [key]: value }));

  const templateOptions = (templates ?? []).filter((row) =>
    ['APPROVED', 'PENDING'].includes(row.status ?? ''),
  );

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
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{t('purchase.title')}</p>
                    <p className="mt-1 text-muted-foreground">{t('purchase.desc')}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {purchaseSaving ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : null}
                    <Switch
                      checked={config.purchaseSignalsEnabled === true}
                      onCheckedChange={onTogglePurchase}
                      disabled={purchaseSaving}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{t('purchase.criteriaHint')}</p>
                <p className="text-xs text-muted-foreground">{t('purchase.strictnessHint')}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-4 pt-6 text-sm">
                <p className="font-medium text-foreground">{t('alerts.title')}</p>
                <div className="flex items-center justify-between gap-4">
                  <p className="text-muted-foreground">{t('alerts.enableLabel')}</p>
                  <Switch checked={alertsEnabled} onCheckedChange={setAlertsEnabled} />
                </div>
                <div className="flex items-center justify-between gap-4">
                  <p className="text-muted-foreground">{t('alerts.autoAssignLabel')}</p>
                  <Switch checked={autoAssign} onCheckedChange={setAutoAssign} />
                </div>
                <div className="space-y-1.5">
                  <p className="text-muted-foreground">{t('alerts.phonesLabel')}</p>
                  <Input
                    value={phonesInput}
                    onChange={(e) => setPhonesInput(e.target.value)}
                    placeholder="+971 50 123 4567, +971 55 987 6543"
                  />
                  <p className="text-xs text-muted-foreground">{t('alerts.phonesHint')}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <p className="text-muted-foreground">{t('alerts.alertTemplateLabel')}</p>
                    <select
                      value={alertTemplateName}
                      onChange={(e) => setAlertTemplateName(e.target.value)}
                      className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                    >
                      <option value="">{t('alerts.noTemplate')}</option>
                      {templateOptions.map((row) => (
                        <option key={row._id} value={row.name}>
                          {row.name} · {row.status}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-muted-foreground">{t('alerts.reengagementTemplateLabel')}</p>
                    <select
                      value={reengagementName}
                      onChange={(e) => setReengagementName(e.target.value)}
                      className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                    >
                      <option value="">{t('alerts.noTemplate')}</option>
                      {templateOptions.map((row) => (
                        <option key={row._id} value={row.name}>
                          {row.name} · {row.status}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Button size="sm" onClick={onSaveAlerts} disabled={alertsSaving}>
                    {alertsSaving ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {t('alerts.save')}
                  </Button>
                  {alertsSaved ? (
                    <span className="text-xs text-emerald-500">{t('alerts.saved')}</span>
                  ) : null}
                  {alertsError ? (
                    <span className="text-xs text-red-400">{alertsError}</span>
                  ) : null}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-4 pt-6 text-sm">
                <p className="font-medium text-foreground">{t('contactCard.title')}</p>
                <p className="text-muted-foreground">{t('contactCard.desc')}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <p className="text-muted-foreground">{t('contactCard.companyName')}</p>
                    <Input
                      value={card.companyName}
                      onChange={(e) => setCardField('companyName')(e.target.value)}
                      placeholder="Holidayys Tours LLC"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-muted-foreground">{t('contactCard.website')}</p>
                    <Input
                      value={card.website}
                      onChange={(e) => setCardField('website')(e.target.value)}
                      placeholder="https://holidayys.co"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-muted-foreground">{t('contactCard.email')}</p>
                    <Input
                      type="email"
                      value={card.email}
                      onChange={(e) => setCardField('email')(e.target.value)}
                      placeholder="hello@holidayys.co"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-muted-foreground">{t('contactCard.phone')}</p>
                    <Input
                      value={card.phone}
                      onChange={(e) => setCardField('phone')(e.target.value)}
                      placeholder="+971 4 000 0000"
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <p className="text-muted-foreground">{t('contactCard.street')}</p>
                    <Input
                      value={card.street}
                      onChange={(e) => setCardField('street')(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-muted-foreground">{t('contactCard.city')}</p>
                    <Input
                      value={card.city}
                      onChange={(e) => setCardField('city')(e.target.value)}
                      placeholder="Dubai"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <p className="text-muted-foreground">{t('contactCard.state')}</p>
                    <Input
                      value={card.state}
                      onChange={(e) => setCardField('state')(e.target.value)}
                    />
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1.5">
                      <p className="text-muted-foreground">{t('contactCard.zip')}</p>
                      <Input
                        value={card.zip}
                        onChange={(e) => setCardField('zip')(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-muted-foreground">{t('contactCard.country')}</p>
                      <Input
                        value={card.country}
                        onChange={(e) => setCardField('country')(e.target.value)}
                        placeholder="UAE"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <p className="text-muted-foreground">{t('contactCard.countryCode')}</p>
                      <Input
                        value={card.countryCode}
                        onChange={(e) => setCardField('countryCode')(e.target.value)}
                        placeholder="AE"
                      />
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{t('contactCard.hint')}</p>
                <div className="flex items-center gap-3">
                  <Button size="sm" onClick={onSaveCard} disabled={cardSaving}>
                    {cardSaving ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : null}
                    {t('contactCard.save')}
                  </Button>
                  {cardSaved ? (
                    <span className="text-xs text-emerald-500">{t('contactCard.saved')}</span>
                  ) : null}
                  {cardError ? (
                    <span className="text-xs text-red-400">{cardError}</span>
                  ) : null}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-4 pt-6 text-sm">
                <p className="font-medium text-foreground">{t('routing.title')}</p>
                <p className="text-muted-foreground">{t('routing.desc')}</p>
                {(tags ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('routing.noTags')}</p>
                ) : (
                  <div className="space-y-3">
                    {(tags ?? []).map((tag) => {
                      const linked = new Set(
                        (memberTagLinks ?? [])
                          .filter((l) => l.tagId === tag._id)
                          .map((l) => l.userId),
                      );
                      const eligible = (members ?? []).filter(
                        (m) => m.role === 'agent' || m.role === 'supervisor',
                      );
                      return (
                        <div key={tag._id} className="rounded-lg border border-border p-3">
                          <p className="mb-2 font-medium text-foreground">{tag.name}</p>
                          {eligible.length === 0 ? (
                            <p className="text-xs text-muted-foreground">{t('routing.noAgents')}</p>
                          ) : (
                            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                              {eligible.map((m) => (
                                <label key={m.userId} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                  <input
                                    type="checkbox"
                                    checked={linked.has(m.userId)}
                                    disabled={routingSavingTag === tag._id}
                                    onChange={async (e) => {
                                      setRoutingSavingTag(tag._id);
                                      try {
                                        const next = new Set(linked);
                                        if (e.target.checked) next.add(m.userId);
                                        else next.delete(m.userId);
                                        await setForTag({
                                          tagId: tag._id,
                                          userIds: [...next] as never,
                                        });
                                      } finally {
                                        setRoutingSavingTag(null);
                                      }
                                    }}
                                  />
                                  {m.fullName || m.email}
                                  {m.phone ? ' 📱' : (
                                    <span className="text-amber-500">{t('routing.noPhone')}</span>
                                  )}
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
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
