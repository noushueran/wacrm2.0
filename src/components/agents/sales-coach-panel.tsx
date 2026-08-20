'use client';

import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/dashboard/skeleton';

import { api } from '../../../convex/_generated/api';

export interface CoachObservationView {
  dimension: string;
  observation: string;
  quote?: string;
}

export interface CoachNoteView {
  id: string;
  subjectUserId: string;
  observations: CoachObservationView[];
  strengths: string[];
  firstResponseMinutes: number | null;
  createdAt: number;
}

export interface CoachTeamView {
  notes: CoachNoteView[];
  byPerson: { userId: string; reviews: number; observations: number }[];
}

export const DIMENSION_LABEL: Record<string, string> = {
  unanswered_question: 'Question never answered',
  checklist_skipped: 'Checklist step skipped',
  slow_response: 'Slow to reply',
  tone: 'Tone',
};

export const TUNABLES = [
  { key: 'threadsPerRun' as const, label: 'Threads per run', help: 'How many handled conversations one daily sweep reviews.' },
  { key: 'minMessages' as const, label: 'Shortest thread', help: 'Below this many messages there is no handling to judge.' },
  { key: 'lookbackDays' as const, label: 'Look back', help: 'How many days of conversations are in scope.' },
];

export function SalesCoachPanel() {
  const team = useQuery(api.salesCoach.forTeam, {});
  const config = useQuery(api.salesCoachConfig.get, {});
  const update = useMutation(api.salesCoachConfig.update);
  const [busy, setBusy] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});

  async function save(patch: Record<string, number>) {
    setBusy(true);
    try {
      await update(patch);
      setEdits({});
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

  if (team === undefined || config === undefined) return <Skeleton className="h-40 w-full" />;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        {TUNABLES.map((field) => {
          const current = String(config[field.key]);
          const value = edits[field.key] ?? current;
          return (
            <div key={field.key}>
              <Label htmlFor={field.key} className="text-sm">{field.label}</Label>
              <Input
                id={field.key}
                type="number"
                className="mt-1"
                value={value}
                disabled={busy}
                onChange={(e) => setEdits((s) => ({ ...s, [field.key]: e.target.value }))}
              />
              <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>
              {value !== current && (
                <Button size="sm" className="mt-2" disabled={busy} onClick={() => save({ [field.key]: Number(value) })}>
                  Save
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <CoachReport data={team as CoachTeamView} />
    </div>
  );
}

export function CoachReport({ data }: { data: CoachTeamView }) {
  if (data.notes.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4">
        <p className="text-sm text-muted-foreground">
          No reviews yet. It looks at conversations a person actually replied in,
          once a day.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm text-muted-foreground">Reviewed so far</p>
        <ul className="space-y-1">
          {data.byPerson.map((p) => (
            <li key={p.userId} className="flex items-baseline justify-between text-sm">
              <span className="text-foreground">{p.userId}</span>
              {/* Counts, not a score and not a ranking — there is no
                  outcome data here that could justify either. */}
              <span className="text-muted-foreground">
                {p.reviews} thread{p.reviews === 1 ? '' : 's'} · {p.observations} note
                {p.observations === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="mb-2 text-sm text-muted-foreground">Recent coaching</p>
        <ul className="space-y-2">
          {data.notes.slice(0, 10).map((n) => (
            <li key={n.id} className="rounded-lg bg-muted/50 p-3">
              {n.firstResponseMinutes !== null && (
                <p className="text-xs text-muted-foreground">
                  First human reply after {n.firstResponseMinutes} min
                </p>
              )}
              {n.observations.map((o, i) => (
                <div key={i} className="mt-2">
                  <p className="text-sm text-foreground">
                    <span className="text-muted-foreground">
                      {DIMENSION_LABEL[o.dimension] ?? o.dimension}:{' '}
                    </span>
                    {o.observation}
                  </p>
                  {/* The evidence. Without it the observation would not
                      have been recorded at all. */}
                  {o.quote && (
                    <p className="mt-0.5 text-xs italic text-muted-foreground">
                      &ldquo;{o.quote}&rdquo;
                    </p>
                  )}
                </div>
              ))}
              {n.strengths.length > 0 && (
                <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                  Went well: {n.strengths.join('; ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
