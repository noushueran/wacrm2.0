'use client';

import { useQuery } from 'convex/react';
import { GraduationCap } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { api } from '../../../convex/_generated/api';
import { DIMENSION_LABEL } from '@/components/agents/sales-coach-panel';

export interface MyCoachingNote {
  id: string;
  observations: { dimension: string; observation: string; quote?: string }[];
  strengths: string[];
  firstResponseMinutes: number | null;
  createdAt: number;
}

/**
 * A person's own coaching, on the dashboard every member can reach.
 *
 * This exists because the sales coach was allowed to write about people
 * before they had anywhere to read it. Coaching someone without letting
 * them see it is surveillance, so this is the half of the visibility
 * rule that makes the other half legitimate.
 *
 * It renders NOTHING when there is no coaching — a permanent empty
 * "your coaching" box on everyone's home screen would be a standing
 * reminder of being watched, which is the opposite of the point.
 */
export function MyCoachingCard() {
  const mine = useQuery(api.salesCoach.forMe, {});
  if (mine === undefined) return null;

  const notes = (mine.notes ?? []) as MyCoachingNote[];
  if (notes.length === 0) return null;

  return <MyCoachingList notes={notes} />;
}

/** Pure, so the rendering carries tests — this repo has no jsdom. */
export function MyCoachingList({ notes }: { notes: MyCoachingNote[] }) {
  const recent = notes.slice(0, 3);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GraduationCap className="h-4 w-4 text-primary" />
          Your coaching
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {recent.map((n) => (
          <div key={n.id} className="rounded-lg bg-muted/50 p-3">
            {n.strengths.length > 0 && (
              <p className="text-sm text-emerald-600 dark:text-emerald-400">
                {n.strengths.join('; ')}
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
                {/* The evidence, so you can check the note against what
                    actually happened rather than take it on trust. */}
                {o.quote && (
                  <p className="mt-0.5 text-xs italic text-muted-foreground">
                    &ldquo;{o.quote}&rdquo;
                  </p>
                )}
              </div>
            ))}
          </div>
        ))}
        {notes.length > recent.length && (
          <p className="text-xs text-muted-foreground">
            {notes.length - recent.length} more from earlier threads.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
