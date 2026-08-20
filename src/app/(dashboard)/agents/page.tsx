'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@/lib/convex/cached';
import {
  Bot,
  Sparkles,
  Settings2,
  BarChart3,
  BookOpen,
  Loader2,
  RefreshCw,
  Users,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AgentRoster } from '@/components/agents/agent-roster';
import { AgentWindow } from '@/components/agents/agent-window';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { RevivalQueue } from '@/components/agents/revival-queue';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiConfig } from '@/components/settings/ai-config';
import { KnowledgeStudio } from '@/components/knowledge/knowledge-studio';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';

import { api } from '../../../../convex/_generated/api';

/**
 * The usage chart pulls in `recharts` (via the vendored Tremor bar chart)
 * — 107 KB gzip, the largest chunk in the app. It renders only on the
 * "usage" tab, which is not the default AND requires the settings role,
 * so eagerly importing it made every visit to this page download a chart
 * most callers never open. Loaded on demand instead.
 */
const AiUsageCard = dynamic(
  () => import('@/components/agents/ai-usage').then((m) => m.AiUsageCard),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    ),
  },
);

type Tab = 'roster' | 'revival' | 'playground' | 'knowledge' | 'setup' | 'usage';

export default function AgentsPage() {
  const { accountRole, profileLoading } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  const tKnowledge = useTranslations('Knowledge');
  const searchParams = useSearchParams();
  const urlTab = searchParams.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(urlTab ?? 'roster');
  const [decided, setDecided] = useState(false);
  // Deep-linkable: ?agent=<key> opens that agent's window, so a link to
  // one agent is shareable the same way a tab already is.
  const [openAgent, setOpenAgent] = useState<string | null>(
    searchParams.get('agent'),
  );

  const showAgent = (key: string | null) => {
    setOpenAgent(key);
    const params = new URLSearchParams(window.location.search);
    if (key) params.set('agent', key);
    else params.delete('agent');
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
  };

  // Skip until the role is BOTH known and sufficient. `api.aiConfig
  // .getFull` is admin-gated server-side; firing it as a non-admin
  // throws FORBIDDEN synchronously inside `useQuery` (no Error Boundary
  // in this app), which would crash the page before `RequireSection`
  // can redirect a non-admin away from this admin/owner-only route.
  const configDoc = useQuery(
    api.aiConfig.getFull,
    !profileLoading && canViewUsage ? {} : 'skip',
  );
  // Land first-time users on Setup, returning users on the Roster —
  // decided exactly once. Render-time "adjust state" (React's own
  // recommended fix for an effect that only mirrors external data into
  // state — see https://react.dev/learn/you-might-not-need-an-effect)
  // rather than a `useEffect`: `!decided` guards it from ever firing
  // again once true, so finishing Setup (which makes `configDoc` go
  // non-null) can't yank the user back to Playground out from under
  // them. Now yields to an explicit `?tab=` deep link, which must never
  // be overridden.
  if (!decided && configDoc !== undefined) {
    setDecided(true);
    if (!urlTab) setTab(configDoc ? 'roster' : 'setup');
  }

  // Shallow URL sync so the active tab is deep-linkable/shareable. Uses
  // the native History API directly rather than a router method — per
  // node_modules/next/dist/docs/01-app/02-guides/single-page-applications.md
  // ("Shallow routing on the client"), `window.history.replaceState`
  // integrates with `useSearchParams` without remounting the page, and
  // is the same pattern already used for the inbox's chat selection
  // (src/app/(dashboard)/inbox/page.tsx).
  const selectTab = (next: Tab) => {
    setTab(next);
    const params = new URLSearchParams(window.location.search);
    params.set('tab', next);
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`);
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          AI Agents
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        The AI agents working on your account — who is on duty, what each
        one does, and what they have handled today.
      </p>

      {decided && (
        <Tabs
          value={tab}
          onValueChange={(v) => selectTab(v as Tab)}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="roster">
              <Users className="mr-1.5 h-4 w-4" /> Roster
            </TabsTrigger>
            <TabsTrigger value="revival">
              <RefreshCw className="mr-1.5 h-4 w-4" /> Revival
            </TabsTrigger>
            <TabsTrigger value="playground">
              <Sparkles className="mr-1.5 h-4 w-4" /> Playground
            </TabsTrigger>
            {canViewUsage && (
              <TabsTrigger value="knowledge">
                <BookOpen className="mr-1.5 h-4 w-4" /> {tKnowledge('tab')}
              </TabsTrigger>
            )}
            <TabsTrigger value="setup">
              <Settings2 className="mr-1.5 h-4 w-4" /> Setup
            </TabsTrigger>
            {canViewUsage && (
              <TabsTrigger value="usage">
                <BarChart3 className="mr-1.5 h-4 w-4" /> Usage
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="roster" className="mt-4">
            <AgentRoster onOpen={showAgent} />
          </TabsContent>

          <TabsContent value="revival" className="mt-4">
            {/* Settings live in the agent's own window now — the queue is
                the working surface, not the config screen. */}
            <RevivalQueue />
          </TabsContent>

          <TabsContent value="playground" className="mt-4">
            <AiPlayground onGoToSetup={() => selectTab('setup')} />
          </TabsContent>

          {canViewUsage && (
            <TabsContent value="knowledge" className="mt-4">
              <KnowledgeStudio />
            </TabsContent>
          )}

          <TabsContent value="setup" className="mt-4">
            <AiConfig />
          </TabsContent>

          {canViewUsage && (
            <TabsContent value="usage" className="mt-4">
              <AiUsageCard />
            </TabsContent>
          )}
        </Tabs>
      )}

      <Sheet
        open={openAgent !== null}
        onOpenChange={(next) => {
          if (!next) showAgent(null);
        }}
      >
        {/* The width MUST carry the same `data-[side=right]:` prefix the
            base class uses. A plain `sm:max-w-2xl` does not look like a
            conflict to tailwind-merge, so both survive and the more
            specific variant wins — which pinned this panel at 384px.
            SheetContent also ships with no padding of its own. */}
        {/* `bg-background` because `--popover` and `--card` are the SAME
            colour in this theme (measured: rgb(15,18,22) for both), so
            every Card embedded here rendered with zero separation from
            the panel. Making the sheet the page surface restores the
            contrast those cards already have on the settings page. */}
        <SheetContent className="w-full overflow-y-auto bg-background p-6 data-[side=right]:sm:max-w-2xl">
          {openAgent && (
            <AgentWindow agentKey={openAgent} onClose={() => showAgent(null)} />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
