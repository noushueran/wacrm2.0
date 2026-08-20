'use client';

import { useState } from 'react';
import type { ComponentType } from 'react';
import { useQuery } from 'convex/react';
import {
  BookOpen,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock,
  FileText,
  GraduationCap,
  Megaphone,
  MessageCircle,
  RefreshCw,
  Tag,
  Target,
} from 'lucide-react';
import { Skeleton } from '@/components/dashboard/skeleton';
import { cn } from '@/lib/utils';

import { api } from '../../../convex/_generated/api';

/**
 * Icons live client-side, keyed by the registry's agent key, rather than
 * travelling in the query payload — `convex/lib/agentRegistry.ts` stays
 * free of any React dependency, and importing a convex query module into
 * a 'use client' component is the exact pattern that once shipped server
 * code to the browser in this repo.
 */
export const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  reply: MessageCircle,
  qualify: ClipboardList,
  score: Target,
  checklist: CheckSquare,
  tags: Tag,
  admatch: Megaphone,
  revival: RefreshCw,
  kbgap: BookOpen,
  coach: GraduationCap,
  quote: FileText,
};

export const STATUS_LABEL: Record<string, string> = {
  working: 'Working',
  on_duty: 'On duty',
  on_call: 'On call',
  attention: 'Needs attention',
  off_duty: 'Off duty',
  not_hired: 'Not hired',
};

export const STATUS_CLASS: Record<string, string> = {
  working: 'bg-primary/10 text-primary',
  on_duty: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  on_call: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  attention: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  off_duty: 'bg-muted text-muted-foreground',
  not_hired: 'bg-muted text-muted-foreground',
};

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="rounded-lg bg-muted/50 p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold', tone)}>{value}</p>
    </div>
  );
}

export interface RosterAgentView {
  key: string;
  name: string;
  duty: string;
  status: string;
  workToday: number;
  blockedReason: string | null;
  notHiredReason: string | null;
}

export interface RosterData {
  agents: RosterAgentView[];
}

export interface RosterSummary {
  live: RosterAgentView[];
  unhired: RosterAgentView[];
  onDuty: RosterAgentView[];
  working: RosterAgentView[];
  attention: RosterAgentView[];
}

/**
 * Split out of the component so it can be unit-tested without rendering
 * (this repo has no jsdom — see `lead-analysis-list.test.tsx`).
 *
 * The counts are NOT a partition, and reading them as one is the easy
 * mistake: `onDuty` counts everyone enabled and healthy, which INCLUDES
 * everyone in `working` and everyone on call. `working` is a subset of
 * `onDuty`, not a sibling of it. Only `unhired` plus `live` sum to the
 * full roster.
 */
export function summarizeRoster(agents: RosterAgentView[]): RosterSummary {
  const live = agents.filter((a) => a.status !== 'not_hired');
  return {
    live,
    unhired: agents.filter((a) => a.status === 'not_hired'),
    onDuty: live.filter(
      (a) => a.status !== 'attention' && a.status !== 'off_duty',
    ),
    working: live.filter((a) => a.status === 'working'),
    attention: live.filter((a) => a.status === 'attention'),
  };
}

interface JobsView {
  crons: Array<{
    name: string;
    intervalMinutes: number;
    lastRun: { status: string } | null;
  }>;
}

export function AgentRoster({ onOpen }: { onOpen?: (agentKey: string) => void }) {
  const data = useQuery(api.agentRoster.roster, {});
  const [showJobs, setShowJobs] = useState(false);
  // Only queried once the section is opened — `cronSchedules.overview`
  // walks every cron's run history plus due sessions and open offers,
  // which is not work worth doing for a panel nobody expanded.
  const jobs = useQuery(api.cronSchedules.overview, showJobs ? {} : 'skip');

  if (data === undefined) {
    return (
      <div className="mt-6 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  return (
    <AgentRosterView
      data={data}
      jobs={jobs}
      showJobs={showJobs}
      onToggleJobs={() => setShowJobs((v) => !v)}
      onOpen={onOpen}
    />
  );
}

export function AgentRosterView({
  data,
  jobs,
  showJobs,
  onToggleJobs,
  onOpen,
}: {
  data: RosterData;
  jobs: JobsView | undefined;
  showJobs: boolean;
  onToggleJobs: () => void;
  /** Opens the agent window. Optional so the view renders standalone in tests. */
  onOpen?: (agentKey: string) => void;
}) {
  const { live, unhired, onDuty, working, attention } = summarizeRoster(
    data.agents,
  );

  return (
    <div className="mt-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="On duty" value={onDuty.length} />
        <Tile label="Working now" value={working.length} tone="text-primary" />
        <Tile
          label="Needs attention"
          value={attention.length}
          tone={
            attention.length ? 'text-amber-600 dark:text-amber-400' : undefined
          }
        />
        <Tile
          label="Not hired"
          value={unhired.length}
          tone="text-muted-foreground"
        />
      </div>

      <p className="mt-8 text-sm text-muted-foreground">On the floor</p>
      <ul className="mt-2 border-t border-border">
        {live.map((agent) => {
          const Icon = ICONS[agent.key] ?? MessageCircle;
          return (
            <li key={agent.key} className="border-b border-border">
            <button
              type="button"
              onClick={() => onOpen?.(agent.key)}
              className="flex w-full items-center gap-3 py-3.5 text-left hover:bg-muted/40"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
                <Icon className="h-[18px] w-[18px] text-muted-foreground" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">
                  {agent.name}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {agent.duty}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span
                  className={cn(
                    'inline-block rounded-full px-2.5 py-0.5 text-xs',
                    STATUS_CLASS[agent.status],
                  )}
                >
                  {STATUS_LABEL[agent.status]}
                </span>
                <span
                  className={cn(
                    'mt-1 block text-xs',
                    agent.blockedReason
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground',
                  )}
                >
                  {agent.blockedReason ??
                    (agent.workToday > 0
                      ? `${agent.workToday} today`
                      : 'nothing yet today')}
                </span>
              </span>
            </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-8 text-sm text-muted-foreground">Not hired yet</p>
      <ul className="mt-2 border-t border-border">
        {unhired.map((agent) => {
          const Icon = ICONS[agent.key] ?? MessageCircle;
          return (
            <li key={agent.key} className="border-b border-border opacity-70">
            <button
              type="button"
              onClick={() => onOpen?.(agent.key)}
              className="flex w-full items-center gap-3 py-3.5 text-left hover:bg-muted/40"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-border">
                <Icon className="h-[18px] w-[18px] text-muted-foreground" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-foreground">
                  {agent.name}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {agent.duty}
                </span>
              </span>
              {agent.notHiredReason && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {agent.notHiredReason}
                </span>
              )}
            </button>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={onToggleJobs}
        className="mt-8 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        aria-expanded={showJobs}
      >
        {showJobs ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
        Background jobs
      </button>

      {showJobs && (
        <ul className="mt-2 border-t border-border">
          {jobs === undefined ? (
            <li className="py-3">
              <Skeleton className="h-10 w-full" />
            </li>
          ) : (
            jobs.crons.map((cron) => (
              <li
                key={cron.name}
                className="flex items-center gap-3 border-b border-border py-3"
              >
                <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                  {cron.name}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  every {cron.intervalMinutes} min
                </span>
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    cron.lastRun?.status === 'failed'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-muted-foreground',
                  )}
                >
                  {cron.lastRun ? cron.lastRun.status : 'never run'}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
