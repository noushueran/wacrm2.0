'use client';

import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/dashboard/skeleton';

import { api } from '../../../convex/_generated/api';

export interface KbGapTheme {
  theme: string;
  questionCount: number;
  examples: string[];
}

export interface KbGapView {
  themes: KbGapTheme[];
  themesOverflow: boolean;
  counts: { drafted: number; skipped_thin_answer: number; skipped_not_durable: number };
  countsTruncated: boolean;
}

/** The numbers worth tuning. `enabled` is not here — the window header
 *  owns that switch, and two toggles over one flag is how a panel starts
 *  disagreeing with itself. */
export const TUNABLES = [
  {
    key: 'entriesPerRun' as const,
    label: 'Drafts per run',
    help: 'How many answered questions one sweep turns into knowledge entries.',
  },
  {
    key: 'minAnswerChars' as const,
    label: 'Shortest usable answer',
    help: 'Answers shorter than this are treated as acknowledgements, not knowledge.',
  },
];

export function KbGapPanel() {
  const overview = useQuery(api.kbGap.overview, {});
  const config = useQuery(api.kbGapConfig.get, {});
  const update = useMutation(api.kbGapConfig.update);
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

  if (overview === undefined || config === undefined) {
    return <Skeleton className="h-40 w-full" />;
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        {TUNABLES.map((field) => {
          const current = String(config[field.key]);
          const value = edits[field.key] ?? current;
          return (
            <div key={field.key}>
              <Label htmlFor={field.key} className="text-sm">
                {field.label}
              </Label>
              <Input
                id={field.key}
                type="number"
                className="mt-1"
                value={value}
                disabled={busy}
                onChange={(e) =>
                  setEdits((s) => ({ ...s, [field.key]: e.target.value }))
                }
              />
              <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>
              {value !== current && (
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

      <KbGapReport data={overview as KbGapView} />
    </div>
  );
}

export function KbGapReport({ data }: { data: KbGapView }) {
  const { counts } = data;
  return (
    <div>
      <p className="text-sm text-muted-foreground">
        {counts.drafted} entr{counts.drafted === 1 ? 'y' : 'ies'} drafted
        {counts.skipped_thin_answer + counts.skipped_not_durable > 0 && (
          <>
            {' · '}
            {counts.skipped_thin_answer + counts.skipped_not_durable} answer
            {counts.skipped_thin_answer + counts.skipped_not_durable === 1 ? '' : 's'} judged
            not worth keeping
          </>
        )}
        {data.countsTruncated ? ' (recent only)' : ''}
      </p>

      <p className="mt-4 mb-2 text-sm text-muted-foreground">
        Asked but never answered
      </p>

      {data.themes.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4">
          <p className="text-sm text-muted-foreground">
            Nothing outstanding. Every question the assistant escalated has an
            answer.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {data.themes.map((t) => (
            <li key={t.theme} className="rounded-lg bg-muted/50 p-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium text-foreground">{t.theme}</p>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t.questionCount} question{t.questionCount === 1 ? '' : 's'}
                </span>
              </div>
              {/* Verbatim, so you can judge the theme rather than trust
                  the label the model put on it. */}
              {t.examples.slice(0, 2).map((q) => (
                <p key={q} className="mt-1.5 text-xs italic text-muted-foreground">
                  &ldquo;{q}&rdquo;
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}

      {data.themesOverflow && (
        <p className="mt-2 text-xs text-muted-foreground">
          More themes exist than are shown.
        </p>
      )}
    </div>
  );
}
