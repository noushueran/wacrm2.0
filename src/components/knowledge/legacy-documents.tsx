'use client';

import { useTranslations } from 'next-intl';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { AiKnowledgeCard } from '@/components/settings/ai-knowledge';

/**
 * The pre-v2 knowledge base, relocated here from the Setup tab.
 *
 * Collapsed by default and labelled as legacy: retrieval still searches
 * these documents, but structured entries are the system of record going
 * forward, and Phase 2b adds the migration + deletion flow. `AiKnowledgeCard`
 * itself is unchanged — only its home moved.
 */
export function LegacyDocuments({
  canEdit,
  hasEmbeddingsKey,
}: {
  canEdit: boolean;
  hasEmbeddingsKey: boolean;
}) {
  const t = useTranslations('Knowledge.legacy');
  return (
    // This repo's Accordion wraps `@base-ui/react/accordion`, not the
    // Radix/shadcn API the `type="single" collapsible` props belong to —
    // base-ui has neither prop. Uncontrolled with no `value`/`defaultValue`
    // (the same shape whatsapp-config.tsx's Accordion already uses) starts
    // with nothing open, and every item already toggles closed on a
    // second click, which is exactly the "collapsed by default" behaviour
    // this section needs.
    <Accordion className="mt-6">
      <AccordionItem value="legacy">
        <AccordionTrigger>{t('sectionTitle')}</AccordionTrigger>
        <AccordionContent>
          <p className="mb-3 text-sm text-muted-foreground">{t('sectionHint')}</p>
          <AiKnowledgeCard canEdit={canEdit} hasEmbeddingsKey={hasEmbeddingsKey} />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
