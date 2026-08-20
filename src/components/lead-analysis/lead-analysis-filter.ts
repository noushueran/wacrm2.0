// ============================================================
// Row types and the client-side filter predicate for the Lead Analysis
// workspace. Standalone because this repo has no jsdom: component tests
// assert on static markup and cannot simulate a select change or a
// keystroke, so the predicate is unit-tested directly instead.
//
// MERGE NOTE (2026-07-27): `main` carried a second, orphaned copy of
// this module — only its own test imported it, while the live board
// declared its own types. This file is the surviving one. The digit-
// normalised phone search below came from that copy and is kept
// deliberately: it is a real improvement, and letting a merge delete it
// would have been a silent regression.
// ============================================================

export type LeadBandKey = 'hot' | 'warm' | 'cold';
export type LeadLaneKey = 'awaiting_us' | 'awaiting_them';

export interface LeadAnalysisRow {
  analysisId: string;
  conversationId: string;
  contactName: string;
  contactPhone: string;
  score: number | null;
  band: LeadBandKey | null;
  reason: string | null;
  signals: string[];
  lane: LeadLaneKey;
  scoreStatus: string;
  lastMessageAt: number | null;
  daysSinceLastMessage: number | null;
  assigneeName: string | null;
  source: 'ad' | 'website' | 'organic';
  serviceName: string | null;
  sequenceStatus: string;
  followUpsSent: number;
  scoredAt: number | null;
  archived: boolean;
  returnedAt: number | null;
}

export type LeadAnalysisView = 'active' | 'archived';

export interface LeadAnalysisBoardData {
  summary: {
    hot: number;
    warm: number;
    cold: number;
    awaitingUs: number;
    awaitingThem: number;
    unscored: number;
    total: number;
    avgScore: number;
  };
  leads: LeadAnalysisRow[];
}

export interface LeadAnalysisFilters {
  band: 'all' | LeadBandKey;
  lane: 'all' | LeadLaneKey;
  search: string;
}

/** The no-op filter — every lead passes. */
export const EMPTY_FILTER: LeadAnalysisFilters = {
  band: 'all',
  lane: 'all',
  search: '',
};

/**
 * Name OR phone, case-insensitively. The phone is matched on digits too,
 * so "500000001" finds "+971 50 000 0001" — an agent reading a number
 * off a screen rarely types the punctuation.
 *
 * The `digits.length > 0` guard is load-bearing: without it a search of
 * only punctuation strips to an empty string, and `includes("")` is true
 * for every phone on earth, so the filter would silently match
 * everything instead of nothing.
 */
/*
 * `matchesSearch` and `filterLeadRows` used to live here. They moved
 * SERVER-SIDE with pagination (`matchesLeadSearch` and the band/lane
 * filters in `convex/leadAnalysis.ts`): once only one page crosses the
 * wire, a client-side filter silently narrows from "search the board"
 * to "search these 25 rows". Deliberately not re-added — the components
 * here render whatever rows the server hands them.
 */

export function silenceLabel(
  daysSinceLastMessage: number | null
): { kind: 'today' } | { kind: 'days'; days: number } {
  return daysSinceLastMessage !== null && daysSinceLastMessage > 0
    ? { kind: 'days', days: daysSinceLastMessage }
    : { kind: 'today' };
}
