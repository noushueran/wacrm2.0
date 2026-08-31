'use client';

import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { Lock, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/dashboard/skeleton';
import { cn } from '@/lib/utils';
import { ICONS, STATUS_CLASS, STATUS_LABEL } from './agent-roster';
import { AgentSettings, hasSettings } from './agent-settings';

import { api } from '../../../convex/_generated/api';

export interface AgentDetailView {
  key: string;
  name: string;
  duty: string;
  status: string;
  instructions: string | null;
  trigger: string | null;
  reads: string | null;
  writes: string | null;
  /** Null when this agent has no switch of its own — see `dependsOn`. */
  enabled: boolean | null;
  dependsOn: { label: string; note: string; agentKey?: string } | null;
  workToday: number;
  blockedReason: string | null;
  notHiredReason: string | null;
  lastRun: { status: string; startedAt: number } | null;
  /** False where the agent's prompt does not read them — no box shown. */
  supportsExtraInstructions: boolean;
}

/** "6 min ago" from a timestamp, or null when there is nothing to say. */
export function sinceLabel(then: number | null, now: number): string | null {
  if (then === null || now <= 0) return null;
  // Floor, not round: 30 seconds ago is "just now", not "1 min ago".
  const mins = Math.max(0, Math.floor((now - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function AgentWindow({
  agentKey,
  onClose,
}: {
  agentKey: string;
  onClose: () => void;
}) {
  const detail = useQuery(api.agentRoster.detail, { agentKey });
  const setEnabled = useMutation(api.agentControls.setEnabled);
  const instructions = useQuery(api.agentInstructions.get, { agentKey });
  const saveInstructions = useMutation(api.agentInstructions.set);
  const [busy, setBusy] = useState(false);
  const [draftText, setDraftText] = useState<string | null>(null);

  async function onSaveInstructions(text: string) {
    setBusy(true);
    try {
      await saveInstructions({ agentKey, extraInstructions: text });
      setDraftText(null);
      toast.success('Saved');
    } catch (err) {
      const reason =
        typeof err === 'object' && err !== null && 'data' in err
          ? ((err as { data?: { reason?: string } }).data?.reason ?? null)
          : null;
      toast.error(reason ?? 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await setEnabled({ agentKey, enabled: next });
      toast.success(next ? 'Switched on' : 'Switched off');
    } catch (err) {
      // The server refuses a toggle that would rewrite another agent's
      // config, and says which agent controls this one. Surface that
      // rather than a generic failure.
      const data =
        typeof err === 'object' && err !== null && 'data' in err
          ? (err as { data?: { code?: string; controlledBy?: string } }).data
          : undefined;
      if (data?.code === 'NOT_CONFIGURED') {
        toast.error('Set this agent up first');
      } else if (data?.code === 'NO_OWN_SWITCH') {
        toast.error(`Controlled by ${data.controlledBy ?? 'another setting'}`);
      } else {
        toast.error('Could not change that');
      }
    } finally {
      setBusy(false);
    }
  }

  if (detail === undefined) {
    return (
      <div className="space-y-3 p-1">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <AgentWindowView
      detail={detail as AgentDetailView}
      busy={busy}
      onToggle={toggle}
      onClose={onClose}
      now={Date.now()}
      instructionsValue={draftText ?? instructions?.extraInstructions ?? ''}
      instructionsSaved={instructions?.extraInstructions ?? ''}
      instructionsMax={instructions?.max ?? 2000}
      onInstructionsChange={setDraftText}
      onInstructionsSave={onSaveInstructions}
    />
  );
}

export function AgentWindowView({
  detail,
  busy,
  onToggle,
  now,
  instructionsValue = '',
  instructionsSaved = '',
  instructionsMax = 2000,
  onInstructionsChange,
  onInstructionsSave,
}: {
  detail: AgentDetailView;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onClose?: () => void;
  instructionsValue?: string;
  instructionsSaved?: string;
  instructionsMax?: number;
  onInstructionsChange?: (text: string) => void;
  onInstructionsSave?: (text: string) => void;
  /** Passed in rather than read during render — `Date.now()` there is impure. */
  now: number;
}) {
  const Icon = ICONS[detail.key] ?? MessageCircle;
  const built = detail.status !== 'not_hired' || detail.instructions !== null;
  const ran = sinceLabel(detail.lastRun?.startedAt ?? null, now);

  return (
    <div className="space-y-5">
      {/* `pr-9` keeps the status pill clear of the sheet's own close
          button, which is absolutely positioned in the top-right corner
          and would otherwise sit on top of it. */}
      <div className="flex items-start gap-3 border-b border-border pb-4 pr-9">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground">{detail.name}</span>
          <span className="block text-sm text-muted-foreground">{detail.duty}</span>
        </span>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-xs',
            STATUS_CLASS[detail.status],
          )}
        >
          {STATUS_LABEL[detail.status]}
        </span>
      </div>

      {detail.enabled !== null ? (
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-foreground">Enabled</span>
          <Switch
            checked={detail.enabled}
            disabled={busy}
            onCheckedChange={onToggle}
            aria-label={`Enable ${detail.name}`}
          />
        </div>
      ) : detail.dependsOn ? (
        /* No switch of its own. Saying so beats a toggle that would
           silently write a different agent's setting. */
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="text-sm text-foreground">{detail.dependsOn.note}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Controlled by {detail.dependsOn.label}
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border p-3">
          <p className="text-sm text-muted-foreground">
            Not built yet
            {detail.notHiredReason ? ` — ${detail.notHiredReason}` : '.'}
          </p>
        </div>
      )}

      {detail.blockedReason && (
        <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-400">
          {detail.blockedReason}
        </p>
      )}

      {built && (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">Details</p>
          <table className="w-full table-fixed text-sm">
            <tbody>
              {detail.trigger && (
                <tr>
                  <td className="py-1 text-muted-foreground">Runs</td>
                  <td className="py-1 text-right">{detail.trigger}</td>
                </tr>
              )}
              {detail.reads && (
                <tr>
                  <td className="py-1 text-muted-foreground">Reads</td>
                  <td className="py-1 text-right">{detail.reads}</td>
                </tr>
              )}
              {detail.writes && (
                <tr>
                  <td className="py-1 text-muted-foreground">Writes</td>
                  <td className="py-1 text-right">{detail.writes}</td>
                </tr>
              )}
              <tr>
                <td className="py-1 text-muted-foreground">Done today</td>
                <td className="py-1 text-right">
                  {detail.workToday}
                </td>
              </tr>
              {ran && (
                <tr>
                  <td className="py-1 text-muted-foreground">Last run</td>
                  <td className="py-1 text-right">{ran}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {detail.instructions && (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">Instructions</p>
          <div className="rounded-lg bg-muted/50 p-3">
            <p className="text-sm leading-relaxed text-foreground">
              {detail.instructions}
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-3.5 w-3.5" />
              Read-only — this agent returns structured data that gets parsed
            </p>
          </div>
        </div>
      )}

      {hasSettings(detail.key) && (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">Settings</p>
          <AgentSettings agentKey={detail.key} />
        </div>
      )}

      {detail.supportsExtraInstructions && (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">
            Additional instructions
          </p>
          <Textarea
            className="min-h-[80px]"
            value={instructionsValue}
            maxLength={instructionsMax}
            disabled={busy}
            onChange={(e) => onInstructionsChange?.(e.target.value)}
            aria-label={`Additional instructions for ${detail.name}`}
            placeholder="Anything this agent should always keep in mind."
          />
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Added to what this agent is told, never replacing it.{' '}
              {instructionsValue.length} / {instructionsMax}
            </p>
            {instructionsValue !== instructionsSaved && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => onInstructionsSave?.(instructionsValue)}
              >
                Save
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
