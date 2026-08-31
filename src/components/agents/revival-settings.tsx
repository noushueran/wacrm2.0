'use client';

import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/dashboard/skeleton';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';

import { api } from '../../../convex/_generated/api';

/**
 * The numbers a person actually tunes. The rest of `revivalConfigs`
 * (draftsPerRun, dailyDraftCap) are throughput knobs with sensible
 * defaults and no business meaning, so they stay out of the form rather
 * than adding fields nobody has a reason to touch.
 */
export const TUNABLES = [
  {
    key: 'minQuietMinutes' as const,
    label: 'Wait before chasing',
    unit: 'minutes',
    help: 'How long a lead must have gone quiet before the agent drafts anything.',
  },
  {
    key: 'cooldownHours' as const,
    label: 'Leave alone after a nudge',
    unit: 'hours',
    help: 'No second draft for the same lead within this window, sent or dismissed.',
  },
  {
    key: 'minLeadScore' as const,
    label: 'Minimum lead score',
    unit: '0–10',
    help: 'Skip leads scoring below this. 0 chases everyone. Unscored leads are never skipped.',
  },
];

export function RevivalSettings({
  showToggle = true,
}: {
  /** False inside the agent window, whose header already owns the
   *  switch. Two toggles over one flag is how a panel starts
   *  disagreeing with itself. */
  showToggle?: boolean;
} = {}) {
  const { accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  // `revivalConfig.get` is admin-gated server-side, and firing it as a
  // non-admin throws FORBIDDEN synchronously inside `useQuery`. There is
  // no Error Boundary in this app, so that would take the whole page
  // down — the same trap `agents/page.tsx` documents for
  // `aiConfig.getFull`.
  const config = useQuery(
    api.revivalConfig.get,
    !profileLoading && canEdit ? {} : 'skip',
  );
  const update = useMutation(api.revivalConfig.update);
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});

  // Someone who cannot change the settings simply does not see them;
  // the queue below is still theirs to work.
  if (!profileLoading && !canEdit) return null;
  if (config === undefined) return <Skeleton className="h-24 w-full" />;

  async function save(patch: Record<string, number | boolean>) {
    setBusy(true);
    try {
      await update(patch);
      toast.success('Saved');
      setEdits({});
    } catch (err) {
      // The server enforces bounds; surface its reason rather than a
      // generic failure, since the reason is the actionable part.
      const reason =
        typeof err === 'object' && err !== null && 'data' in err
          ? ((err as { data?: { reason?: string } }).data?.reason ?? null)
          : null;
      toast.error(reason ?? 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      {showToggle && (
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-medium text-foreground">Revival agent</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {config.enabled
                ? 'Drafting nudges for leads that go quiet. Nothing sends without you.'
                : 'Switched off. No leads are being chased and nothing is being drafted.'}
            </p>
          </div>
          <Switch
            checked={config.enabled}
            disabled={busy}
            onCheckedChange={(v) => save({ enabled: v })}
            aria-label="Enable the revival agent"
          />
        </div>
      )}

      {config.enabled && (
        <div className={showToggle ? 'mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-3' : 'grid gap-4 sm:grid-cols-2'}>
          {TUNABLES.map((field) => {
            const current = String(config[field.key]);
            const value = edits[field.key] ?? current;
            const dirty = value !== current;
            return (
              <div key={field.key}>
                <Label htmlFor={field.key} className="text-sm">
                  {field.label}
                </Label>
                <div className="mt-1 flex items-center gap-2">
                  <Input
                    id={field.key}
                    type="number"
                    value={value}
                    disabled={busy}
                    onChange={(e) =>
                      setEdits((s) => ({ ...s, [field.key]: e.target.value }))
                    }
                  />
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {field.unit}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>
                {dirty && (
                  <Button
                    size="sm"
                    className="mt-2"
                    disabled={busy}
                    onClick={() => save({ [field.key]: Number(value) })}
                  >
                    Save
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
