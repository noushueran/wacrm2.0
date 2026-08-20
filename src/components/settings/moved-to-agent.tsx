'use client';

import Link from 'next/link';
import { ArrowRight, Bot } from 'lucide-react';

/**
 * A settings section whose editor now lives in its agent's window.
 *
 * Deliberately a pointer rather than a second copy of the form. These
 * settings belong to one agent and are edited in one place; rendering
 * them here as well would mean two editors over one config row, which is
 * how two surfaces silently diverge.
 *
 * The rail entry stays because that is where people have learned to look
 * — removing it outright would just make the settings feel deleted.
 */
export function MovedToAgent({
  agentKey,
  agentName,
  what,
}: {
  agentKey: string;
  agentName: string;
  /** What the reader came here to change, in their words. */
  what: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center gap-2">
        <Bot className="h-5 w-5 text-primary" />
        <p className="font-medium text-foreground">Now with the agent</p>
      </div>
      <p className="mt-2 max-w-prose text-sm text-muted-foreground">
        {what} is set on the {agentName} itself, alongside what it does, whether
        it is on, and what it has handled today.
      </p>
      <Link
        href={`/agents?tab=roster&agent=${agentKey}`}
        className="mt-4 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
      >
        Open the {agentName}
        <ArrowRight className="h-4 w-4" />
      </Link>
    </div>
  );
}
