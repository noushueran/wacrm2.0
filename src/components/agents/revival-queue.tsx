'use client';

import { useEffect, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { Clock, RefreshCw, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/dashboard/skeleton';
import { cn } from '@/lib/utils';

import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

export interface RevivalDraftView {
  id: string;
  conversationId: string;
  contactName: string;
  body: string;
  reason: string;
  confidence: string;
  assignedToUserId: string | null;
  createdAt: number;
  expiresAt: number;
}

/**
 * Why a send was refused, in words a salesperson can act on.
 *
 * Every one of these means the agent's judgement went stale while the
 * draft waited — which is exactly what the queue is for. They are
 * outcomes, not errors, so they surface as plain messages rather than
 * failures.
 */
export const BLOCKED_MESSAGE: Record<string, string> = {
  customer_replied: 'They replied — open the thread instead',
  expired: 'The 24-hour window has closed',
  already_actioned: 'Someone already handled this one',
  snoozed: 'This thread is snoozed',
  do_not_contact: 'This contact asked not to be messaged',
  archived: 'This thread was archived',
};

export function blockedMessage(reason: string): string {
  return BLOCKED_MESSAGE[reason] ?? 'This nudge is no longer valid';
}

/** Hours until the window shuts — the only number that decides whether a
 *  draft is still worth reading. */
export function hoursLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.floor((expiresAt - now) / 3_600_000));
}

export function RevivalQueue() {
  const data = useQuery(api.revival.queue, {});
  const send = useAction(api.revival.send);
  const dismiss = useMutation(api.revival.dismiss);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});

  // The countdown must stay honest without a reload: a draft that read
  // "2h left" when the tab was opened is not still 2h later.
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  async function handleSend(draft: RevivalDraftView) {
    setBusyId(draft.id);
    try {
      const body = edits[draft.id];
      const res = await send({
        draftId: draft.id as Id<'revivalDrafts'>,
        ...(body !== undefined && body !== draft.body ? { body } : {}),
      });
      if ('blocked' in res) {
        // Not a failure — the world changed while the draft waited.
        toast.message(blockedMessage(res.blocked));
      } else {
        toast.success(`Sent to ${draft.contactName}`);
      }
    } catch {
      toast.error('Could not send that nudge');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDismiss(draft: RevivalDraftView) {
    setBusyId(draft.id);
    try {
      await dismiss({ draftId: draft.id as Id<'revivalDrafts'> });
      toast.success('Dismissed');
    } catch {
      toast.error('Could not dismiss that nudge');
    } finally {
      setBusyId(null);
    }
  }

  if (data === undefined) {
    return (
      <div className="mt-6 space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    );
  }

  return (
    <RevivalQueueView
      drafts={data.drafts as RevivalDraftView[]}
      overflow={data.overflow}
      busyId={busyId}
      edits={edits}
      onEdit={(id, body) => setEdits((e) => ({ ...e, [id]: body }))}
      onSend={handleSend}
      onDismiss={handleDismiss}
      now={now}
    />
  );
}

export function RevivalQueueView({
  drafts,
  overflow,
  busyId,
  edits,
  onEdit,
  onSend,
  onDismiss,
  now,
}: {
  drafts: RevivalDraftView[];
  overflow: boolean;
  busyId: string | null;
  edits: Record<string, string>;
  onEdit: (id: string, body: string) => void;
  onSend: (draft: RevivalDraftView) => void;
  onDismiss: (draft: RevivalDraftView) => void;
  /** Passed in rather than read from the clock here: calling `Date.now()`
   *  during render is impure, and the countdown needs to tick anyway. */
  now: number;
}) {
  if (drafts.length === 0) {
    return (
      <div className="mt-6 flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border py-16 text-center">
        <RefreshCw className="h-8 w-8 text-muted-foreground opacity-40" />
        <p className="font-medium text-foreground">Nothing to chase right now</p>
        <p className="max-w-md text-sm text-muted-foreground">
          The revival agent queues a nudge when a lead goes quiet while there is
          still time to reach them. Nothing is ever sent without you.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-3">
      <p className="text-sm text-muted-foreground">
        {drafts.length}
        {overflow ? '+' : ''} waiting. Nothing sends until you tap send.
      </p>

      {drafts.map((draft) => {
        const left = hoursLeft(draft.expiresAt, now);
        const busy = busyId === draft.id;
        return (
          <div
            key={draft.id}
            className="rounded-lg border border-border bg-card p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-foreground">{draft.contactName}</p>
                <p className="text-sm text-muted-foreground">{draft.reason}</p>
              </div>
              {/* `now` is 0 until the clock effect runs. Rendering the
                  countdown from it would show a nonsense figure on the
                  first paint, so it waits one tick instead. */}
              {now > 0 && (
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-1 text-xs',
                    left <= 2
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground',
                  )}
                >
                  <Clock className="h-3.5 w-3.5" />
                  {left <= 0 ? 'closing now' : `${left}h left`}
                </span>
              )}
            </div>

            <Textarea
              className="mt-3 min-h-[72px]"
              value={edits[draft.id] ?? draft.body}
              onChange={(e) => onEdit(draft.id, e.target.value)}
              aria-label={`Message to ${draft.contactName}`}
            />

            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => onSend(draft)}>
                <Send className="mr-1.5 h-4 w-4" />
                Send
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onDismiss(draft)}
              >
                <X className="mr-1.5 h-4 w-4" />
                Dismiss
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
