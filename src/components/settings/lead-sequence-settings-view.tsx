'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';

import { bandsMissingTemplate, type BandRule } from '../../../convex/lib/leadAnalysis/bands';

// ============================================================
// LeadSequenceSettingsView — the presentational half of the follow-up
// sequence's config UI (P3 Task 10). Pure props in, no `useQuery`/
// `useMutation` of its own — mirrors the `LeadAnalysisBoard` /
// `page.tsx` split (see that component's own header comment) so this
// piece can be exercised with `renderToStaticMarkup` in a repo with no
// jsdom and no Testing Library. `LeadSequenceSettings` (the container,
// in the sibling file) does the data fetching and wires this in.
//
// THREE THINGS THIS VIEW MAKES IMPOSSIBLE TO GET WRONG (spec):
//   1. The enable switch is `disabled` whenever the CURRENTLY PERSISTED
//      config has a band step with no template AND the sequence is not
//      already on — computed via `bandsMissingTemplate`, the exact same
//      pure function `leadAnalysis.updateConfig` calls server-side, so
//      the UI and the actual save-time guard can never drift apart.
//      Turning an already-enabled sequence OFF is never blocked.
//   2. `sequence-hours-warning` renders prominently, with a link to
//      where hours are configured, whenever `preview.workingHoursKnown`
//      is false — the exact same flag Task 9's `sequencePreview` query
//      computes from whether `qualificationConfigs` has a row at all.
//   3. The preview's projected-send count renders before the toggle —
//      wired from the SAME `sequencePreview` query result, never a
//      second hand-rolled estimate.
// ============================================================

export type SequenceBand = 'hot' | 'warm' | 'cold';

export interface LeadSequenceConfigView {
  enabled: boolean;
  idleDaysBeforeSequence: number;
  humanQuietHours: number;
  dailySendCap: number;
  bands: BandRule[];
}

export interface LeadSequencePreviewLeadView {
  verdict: 'send' | 'reschedule' | 'stop' | 'archive' | 'exhaust';
  projectedSendAt: number | null;
}

export interface LeadSequencePreviewView {
  workingHoursKnown: boolean;
  warnings: string[];
  windowDays: number;
  leads: LeadSequencePreviewLeadView[];
}

export interface LeadSequenceTemplateOption {
  name: string;
  language?: string;
}

export interface CadencePatch {
  idleDaysBeforeSequence: number;
  humanQuietHours: number;
  dailySendCap: number;
}

export interface LeadSequenceSettingsViewProps {
  config: LeadSequenceConfigView;
  /** `undefined` while `sequencePreview` is still loading. */
  preview: LeadSequencePreviewView | undefined;
  /** Only APPROVED, un-parameterised templates — the picker is never
   *  free text (spec), and never a template the sequence's fixed-body
   *  send would fail on (Fix 3, whole-branch review). */
  approvedTemplates: LeadSequenceTemplateOption[];
  /** Count of APPROVED templates hidden from the picker specifically
   *  because their body needs variables the sequence can't supply —
   *  Fix 3's "say why in the UI rather than silently hiding them". */
  excludedParamTemplateCount: number;
  savingEnable: boolean;
  onToggleEnabled: (next: boolean) => void;
  savingCadence: boolean;
  onSaveCadence: (patch: CadencePatch) => void;
  savingBands: boolean;
  onSaveBands: (bands: BandRule[]) => void;
  /** Where "Set working hours" links to — the qualification settings tab. */
  qualificationSettingsHref: string;
  /** False inside the agent window, whose header already owns the
   *  switch. Two toggles over one flag is how a panel starts
   *  disagreeing with itself. */
  showEnableToggle?: boolean;
}

const BAND_ORDER: SequenceBand[] = ['hot', 'warm', 'cold'];

export function LeadSequenceSettingsView({
  config,
  preview,
  approvedTemplates,
  excludedParamTemplateCount,
  savingEnable,
  onToggleEnabled,
  savingCadence,
  onSaveCadence,
  savingBands,
  onSaveBands,
  qualificationSettingsHref,
  showEnableToggle = true,
}: LeadSequenceSettingsViewProps) {
  const t = useTranslations('Settings.leadSequence');

  const [cadence, setCadence] = useState<CadencePatch>(() => ({
    idleDaysBeforeSequence: config.idleDaysBeforeSequence,
    humanQuietHours: config.humanQuietHours,
    dailySendCap: config.dailySendCap,
  }));
  const [bands, setBands] = useState<BandRule[]>(() => config.bands);

  // Gate 1, mirrored client-side (see header comment): computed off the
  // PERSISTED config, not the unsaved `bands` draft state above — the
  // switch reflects what the server would actually enforce right now.
  const persistedMissingTemplate = bandsMissingTemplate(config.bands);
  const enableSwitchDisabled =
    savingEnable || (!config.enabled && persistedMissingTemplate);

  const willMessageCount =
    preview?.leads.filter((lead) => lead.projectedSendAt !== null).length ?? 0;
  // The hours-unset warning has its own dedicated banner below; drop
  // the server's matching text from this generic list so the same
  // fact isn't stated twice in two different boxes.
  const templateWarnings =
    preview?.warnings.filter((w) => !w.toLowerCase().startsWith('working hours')) ?? [];

  const setStepField = (
    bandKey: SequenceBand,
    stepIndex: number,
    patch: Partial<BandRule['steps'][number]>,
  ) => {
    setBands((prev) =>
      prev.map((band) =>
        band.key === bandKey
          ? {
              ...band,
              steps: band.steps.map((step, i) =>
                i === stepIndex ? { ...step, ...patch } : step,
              ),
            }
          : band,
      ),
    );
  };

  const setBandAutoArchive = (bandKey: SequenceBand, autoArchive: boolean) => {
    // Defense in depth: hot's auto-archive can never be toggled on
    // from here regardless of what called this (the switch itself is
    // also `disabled` for hot below).
    if (bandKey === 'hot') return;
    setBands((prev) =>
      prev.map((band) => (band.key === bandKey ? { ...band, autoArchive } : band)),
    );
  };

  return (
    <div data-testid="lead-sequence-settings">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {preview && !preview.workingHoursKnown ? (
        <Card
          data-testid="sequence-hours-warning"
          className="mb-4 border-amber-500/50 bg-amber-500/10"
        >
          <CardContent className="flex items-start gap-3 pt-6">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div className="min-w-0 space-y-1.5">
              <p className="font-semibold text-amber-100">{t('hoursWarning.title')}</p>
              <p data-testid="sequence-hours-warning-body" className="text-sm text-amber-200">
                {t('hoursWarning.body')}
              </p>
              <Link
                href={qualificationSettingsHref}
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  'border-amber-500/50 text-amber-100 hover:bg-amber-500/15',
                )}
              >
                {t('hoursWarning.link')}
              </Link>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {showEnableToggle ? (
      <Card className="mb-4">
        <CardContent className="space-y-2 pt-6">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{t('enable.title')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('enable.desc')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {savingEnable ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
              <Switch
                data-testid="sequence-enable-switch"
                checked={config.enabled}
                onCheckedChange={onToggleEnabled}
                disabled={enableSwitchDisabled}
              />
            </div>
          </div>
          {!config.enabled && persistedMissingTemplate ? (
            <p data-testid="sequence-enable-blocked-hint" className="text-xs text-amber-500">
              {t('enable.blockedHint')}
            </p>
          ) : null}
        </CardContent>
      </Card>
      ) : null}

      <Card className="mb-4">
        <CardContent className="space-y-3 pt-6 text-sm">
          <p className="font-medium text-foreground">{t('preview.title')}</p>
          <p className="text-muted-foreground">{t('preview.desc')}</p>
          {preview === undefined ? (
            <p data-testid="sequence-preview-loading" className="text-muted-foreground">
              <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
              {t('preview.loading')}
            </p>
          ) : (
            <>
              <p>
                <span data-testid="sequence-preview-count" className="text-lg font-semibold text-foreground">
                  {willMessageCount}
                </span>{' '}
                {t('preview.countLabel', { days: preview.windowDays })}
              </p>
              {preview.leads.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('preview.empty')}</p>
              ) : null}
              {templateWarnings.length > 0 ? (
                <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
                  <p className="text-xs font-semibold text-amber-200">
                    {t('preview.warningsTitle')}
                  </p>
                  <ul className="list-disc space-y-1 pl-4 text-xs text-amber-200">
                    {templateWarnings.map((w, i) => (
                      <li key={i} data-testid={`sequence-preview-warning-${i}`}>
                        {w}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardContent className="space-y-4 pt-6 text-sm">
          <p className="font-medium text-foreground">{t('cadence.title')}</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <p className="text-muted-foreground">{t('cadence.idleDaysLabel')}</p>
              <Input
                type="number"
                min={1}
                data-testid="sequence-idle-days-input"
                value={cadence.idleDaysBeforeSequence}
                onChange={(e) =>
                  setCadence((prev) => ({
                    ...prev,
                    idleDaysBeforeSequence: Number(e.target.value),
                  }))
                }
              />
              <p className="text-xs text-muted-foreground">{t('cadence.idleDaysHint')}</p>
            </div>
            <div className="space-y-1.5">
              <p className="text-muted-foreground">{t('cadence.humanQuietHoursLabel')}</p>
              <Input
                type="number"
                min={1}
                data-testid="sequence-quiet-hours-input"
                value={cadence.humanQuietHours}
                onChange={(e) =>
                  setCadence((prev) => ({ ...prev, humanQuietHours: Number(e.target.value) }))
                }
              />
              <p className="text-xs text-muted-foreground">{t('cadence.humanQuietHoursHint')}</p>
            </div>
            <div className="space-y-1.5">
              <p className="text-muted-foreground">{t('cadence.dailySendCapLabel')}</p>
              <Input
                type="number"
                min={1}
                data-testid="sequence-daily-cap-input"
                value={cadence.dailySendCap}
                onChange={(e) =>
                  setCadence((prev) => ({ ...prev, dailySendCap: Number(e.target.value) }))
                }
              />
              <p className="text-xs text-muted-foreground">{t('cadence.dailySendCapHint')}</p>
            </div>
          </div>
          <Button size="sm" disabled={savingCadence} onClick={() => onSaveCadence(cadence)}>
            {savingCadence ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {t('cadence.save')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-5 pt-6 text-sm">
          <div>
            <p className="font-medium text-foreground">{t('bands.title')}</p>
            <p className="text-muted-foreground">{t('bands.desc')}</p>
          </div>
          {excludedParamTemplateCount > 0 ? (
            <p
              data-testid="sequence-param-templates-excluded"
              className="text-xs text-amber-500"
            >
              {t('bands.paramTemplatesExcluded', { count: excludedParamTemplateCount })}
            </p>
          ) : null}
          {BAND_ORDER.map((bandKey) => {
            const band = bands.find((b) => b.key === bandKey);
            if (!band) return null;
            const isHot = bandKey === 'hot';
            return (
              <div key={bandKey} className="rounded-lg border border-border p-3">
                <div className="mb-3 flex items-center justify-between gap-4">
                  <Badge data-testid={`sequence-band-${bandKey}`} variant="secondary">
                    {t(`bands.${bandKey}`)}
                  </Badge>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    {t('bands.autoArchiveLabel')}
                    <Switch
                      data-testid={`sequence-autoarchive-${bandKey}`}
                      checked={isHot ? false : band.autoArchive}
                      disabled={isHot}
                      onCheckedChange={(next) => setBandAutoArchive(bandKey, next)}
                    />
                  </div>
                </div>
                {isHot ? (
                  <p
                    data-testid="sequence-autoarchive-hot-reason"
                    className="mb-3 text-xs text-muted-foreground"
                  >
                    {t('bands.hotAutoArchiveLockedReason')}
                  </p>
                ) : null}
                <div className="space-y-2">
                  {band.steps.map((step, stepIndex) => {
                    const missing = !step.templateName || step.templateName.trim() === '';
                    return (
                      <div
                        key={stepIndex}
                        data-testid={`sequence-step-${bandKey}-${stepIndex}`}
                        className="grid gap-2 sm:grid-cols-[auto_1fr_1fr] sm:items-center"
                      >
                        <span className="text-xs text-muted-foreground">
                          {t('bands.step', { n: stepIndex + 1 })}
                        </span>
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">
                            {t('bands.delayDaysLabel')}
                          </p>
                          <Input
                            type="number"
                            min={1}
                            data-testid={`sequence-step-delay-${bandKey}-${stepIndex}`}
                            value={step.delayDays}
                            onChange={(e) =>
                              setStepField(bandKey, stepIndex, {
                                delayDays: Number(e.target.value),
                              })
                            }
                          />
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">
                            {t('bands.templateLabel')}
                          </p>
                          <select
                            data-testid={`sequence-step-template-${bandKey}-${stepIndex}`}
                            value={step.templateName}
                            onChange={(e) =>
                              setStepField(bandKey, stepIndex, {
                                templateName: e.target.value,
                                templateLanguage: approvedTemplates.find(
                                  (opt) => opt.name === e.target.value,
                                )?.language,
                              })
                            }
                            className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                          >
                            <option value="">{t('bands.noTemplate')}</option>
                            {approvedTemplates.length === 0 ? (
                              <option value="" disabled>
                                {t('bands.noApprovedTemplates')}
                              </option>
                            ) : null}
                            {approvedTemplates.map((opt) => (
                              <option key={opt.name} value={opt.name}>
                                {opt.name}
                              </option>
                            ))}
                          </select>
                          {missing ? (
                            <p
                              data-testid={`sequence-step-missing-${bandKey}-${stepIndex}`}
                              className="text-xs text-amber-500"
                            >
                              {t('bands.missingTemplateHint')}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <Button size="sm" disabled={savingBands} onClick={() => onSaveBands(bands)}>
            {savingBands ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {t('bands.save')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
