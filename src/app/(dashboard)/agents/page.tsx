'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@/lib/convex/cached';
import { Bot, Sparkles, Settings2, BarChart3, BookOpen, Loader2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
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

type Tab = 'playground' | 'knowledge' | 'setup' | 'usage';

export default function AgentsPage() {
  const { accountRole } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  const tKnowledge = useTranslations('Knowledge');
  const searchParams = useSearchParams();
  const urlTab = searchParams.get('tab') as Tab | null;
  const [tab, setTab] = useState<Tab>(urlTab ?? 'playground');
  const [decided, setDecided] = useState(false);

  const configDoc = useQuery(api.aiConfig.get);
  // Land first-time users on Setup, returning users on the Playground —
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
    if (!urlTab) setTab(configDoc ? 'playground' : 'setup');
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
        Your bring-your-own-key AI agent — set it up, then test it in the
        playground before it replies to customers in the inbox.
      </p>

      {decided && (
        <Tabs
          value={tab}
          onValueChange={(v) => selectTab(v as Tab)}
          className="mt-6"
        >
          <TabsList>
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
    </div>
  );
}
