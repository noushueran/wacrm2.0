'use client';

import { useTranslations } from 'next-intl';

import { useQuery } from '@/lib/convex/cached';
import { useAuth } from '@/hooks/use-auth';
import { LeadsBoardView } from '@/components/leads/leads-board-view';

import { api } from '../../../../convex/_generated/api';

// ============================================================
// /leads — thin data wrapper over LeadsBoardView (the presentational
// board, kept separate so it can be rendered with mock data for visual
// verification). RBAC: agents see only their own assigned leads (the
// query filters server-side), supervisor+ the full board.
// ============================================================

export default function LeadsPage() {
  const t = useTranslations('Leads');
  const { accountRole } = useAuth();
  const canView =
    accountRole === 'agent' ||
    accountRole === 'supervisor' ||
    accountRole === 'admin' ||
    accountRole === 'owner';
  const board = useQuery(api.qualification.leadsBoard, canView ? {} : 'skip');

  if (!board) {
    return <p className="mt-8 text-sm text-muted-foreground">{t('loading')}</p>;
  }
  return <LeadsBoardView board={board} />;
}
