'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';

/**
 * An agent's own settings, rendered inside its window.
 *
 * These are the EXISTING editors, embedded rather than reimplemented —
 * `QualificationSettings` and `LeadSequenceSettings` both take no props
 * and load their own data, so moving them is a matter of where they
 * mount. Rewriting them would have meant two editors over one config
 * row, which is precisely the drift this phase removes.
 *
 * Loaded on demand: the qualification editor alone is 565 lines and
 * nobody opening the roster should pay for it until they open that one
 * agent.
 */
const spinner = () => (
  <div className="flex h-32 items-center justify-center">
    <Loader2 className="h-5 w-5 animate-spin text-primary" />
  </div>
);

const QualificationSettings = dynamic(
  () =>
    import('@/components/settings/qualification-settings').then(
      (m) => m.QualificationSettings,
    ),
  { ssr: false, loading: spinner },
);

const LeadSequenceSettings = dynamic(
  () =>
    import('@/components/settings/lead-sequence-settings').then(
      (m) => m.LeadSequenceSettings,
    ),
  { ssr: false, loading: spinner },
);

const KbGapPanel = dynamic(
  () => import('@/components/agents/kb-gap-panel').then((m) => m.KbGapPanel),
  { ssr: false, loading: spinner },
);

const SalesCoachPanel = dynamic(
  () => import('@/components/agents/sales-coach-panel').then((m) => m.SalesCoachPanel),
  { ssr: false, loading: spinner },
);

const RevivalSettings = dynamic(
  () =>
    import('@/components/agents/revival-settings').then((m) => m.RevivalSettings),
  { ssr: false, loading: spinner },
);

/** Which agents have an editor to show. Anything absent renders nothing. */
export const AGENTS_WITH_SETTINGS = ['qualify', 'score', 'revival', 'kbgap', 'coach'] as const;

export function hasSettings(agentKey: string): boolean {
  return (AGENTS_WITH_SETTINGS as readonly string[]).includes(agentKey);
}

export function AgentSettings({ agentKey }: { agentKey: string }) {
  switch (agentKey) {
    case 'qualify':
      return <QualificationSettings />;
    case 'score':
      // Same reason as the revival case below: the window header owns
      // the enable switch, so the panel must not render a second one.
      return <LeadSequenceSettings showEnableToggle={false} />;
    case 'revival':
      // Its own enable switch is suppressed — the window header already
      // owns that control, and two toggles over one flag is how a panel
      // starts disagreeing with itself.
      return <RevivalSettings showToggle={false} />;
    case 'kbgap':
      // Its enable switch lives in the window header, like the others.
      return <KbGapPanel />;
    case 'coach':
      return <SalesCoachPanel />;
    default:
      return null;
  }
}
