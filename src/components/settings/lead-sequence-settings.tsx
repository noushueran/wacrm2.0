'use client';

import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import type { BandRule } from '../../../convex/lib/leadAnalysis/bands';
import {
  excludedParameterisedTemplateCount,
  pickableSequenceTemplates,
} from '../../../convex/lib/leadAnalysis/templatePicker';
import {
  LeadSequenceSettingsView,
  type CadencePatch,
} from './lead-sequence-settings-view';

import { api } from '../../../convex/_generated/api';

// ============================================================
// LeadSequenceSettings — the Lead scorer's own settings, rendered
// inside its agent window (moved out of Settings → Follow-up sequence
// 2026-08-09). (P3 Task 10).
// Admin-gated on the same two layers as `qualification-settings.tsx`:
// 'lead-sequence' sits in CRITICAL_SECTIONS (page-level redirect) AND
// <RequireRole min="admin"> below; every query is skipped until the
// role is known so a sub-admin never round-trips into FORBIDDEN.
//
// This is a thin data wrapper — it fetches config/preview/templates
// and wires them into `LeadSequenceSettingsView`, the presentational
// component that carries the actual safety logic (see its own header
// comment) and is what `lead-sequence-settings-view.test.tsx` exercises.
// ============================================================

/** Preview size: enough to give a meaningful count without an
 *  unbounded read — mirrors `sequencePreview`'s own default. */
const PREVIEW_LIMIT = 50;

function errorReason(err: unknown, fallback: string): string {
  const data = (err as { data?: { reason?: string } })?.data;
  return data?.reason ?? fallback;
}

export function LeadSequenceSettings({
  showEnableToggle = true,
}: {
  /** False inside the agent window — see the view's own prop. */
  showEnableToggle?: boolean;
} = {}) {
  const { canEditCriticalSettings } = useAuth();

  const config = useQuery(
    api.leadAnalysis.getConfig,
    canEditCriticalSettings ? {} : 'skip',
  );
  const preview = useQuery(
    api.leadAnalysis.sequencePreview,
    canEditCriticalSettings ? { limit: PREVIEW_LIMIT } : 'skip',
  );
  const templates = useQuery(
    api.templates.list,
    canEditCriticalSettings ? {} : 'skip',
  );
  const updateConfig = useMutation(api.leadAnalysis.updateConfig);

  const [savingEnable, setSavingEnable] = useState(false);
  const [savingCadence, setSavingCadence] = useState(false);
  const [savingBands, setSavingBands] = useState(false);

  // Fix 3 (whole-branch review, "prevent" half): excludes a template
  // whose body is parameterised even if APPROVED — `sendSequenceStep`
  // (`leadAnalysisEngine.ts`) always sends a fixed body with no
  // `params`, so picking one here would silently burn the lead's
  // cadence at send time (Meta error 132000, now surfaced loudly via
  // the "send_failed" stop reason — see that fix's other half). Both
  // helpers live in `lib/leadAnalysis/templatePicker.ts` so this filter
  // can never drift from what the picker actually renders.
  const approvedTemplates = pickableSequenceTemplates(templates ?? []);
  const excludedParamTemplateCount = excludedParameterisedTemplateCount(templates ?? []);

  const onToggleEnabled = async (next: boolean) => {
    setSavingEnable(true);
    try {
      await updateConfig({ patch: { enabled: next } });
    } catch (err) {
      console.error('Failed to update the follow-up sequence toggle:', err);
      toast.error(errorReason(err, 'Could not update — check that every band step has a template.'));
    } finally {
      setSavingEnable(false);
    }
  };

  const onSaveCadence = async (patch: CadencePatch) => {
    setSavingCadence(true);
    try {
      await updateConfig({ patch });
      toast.success('Saved');
    } catch (err) {
      console.error('Failed to save the follow-up sequence cadence:', err);
      toast.error(errorReason(err, 'Could not save — check the values.'));
    } finally {
      setSavingCadence(false);
    }
  };

  const onSaveBands = async (bands: BandRule[]) => {
    setSavingBands(true);
    try {
      await updateConfig({ patch: { bands } });
      toast.success('Saved');
    } catch (err) {
      console.error('Failed to save the follow-up sequence schedule:', err);
      toast.error(errorReason(err, 'Could not save — check the values.'));
    } finally {
      setSavingBands(false);
    }
  };

  return (
    <RequireRole min="admin">
      {config === undefined ? (
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      ) : (
        <LeadSequenceSettingsView
          showEnableToggle={showEnableToggle}
          config={config}
          preview={preview}
          approvedTemplates={approvedTemplates}
          excludedParamTemplateCount={excludedParamTemplateCount}
          savingEnable={savingEnable}
          onToggleEnabled={onToggleEnabled}
          savingCadence={savingCadence}
          onSaveCadence={onSaveCadence}
          savingBands={savingBands}
          onSaveBands={onSaveBands}
          qualificationSettingsHref="/settings?tab=qualification"
        />
      )}
    </RequireRole>
  );
}
