// Readiness rule for a knowledge-base service, kept pure so it is unit
// testable and can be shared by the Convex query that computes it and any
// UI that needs to re-derive it. The rule itself is a product decision
// (design spec, 2026-07-19): a service is usable by the AI engines only
// when it can be described, scored, and reported on.
export type OpsSlotState = 'published' | 'draft' | 'absent';
export type ServiceVerdict = 'ready' | 'blocked' | 'draft' | 'empty';

/**
 * Total marks across a qualification checklist's criteria.
 *
 * Returns `null` rather than a partial sum when the list is empty or any
 * criterion is missing `marks` — a partial total would read as a real
 * score and could show "90" for a checklist that simply has not had its
 * marks filled in yet. Mirrors `lintOpsBlock`, which only enforces the
 * sum-to-100 rule when every criterion carries a numeric `marks`.
 */
export function marksTotal(criteria: { marks?: number }[]): number | null {
  if (criteria.length === 0) return null;
  let total = 0;
  for (const c of criteria) {
    if (typeof c.marks !== 'number') return null;
    total += c.marks;
  }
  return total;
}

export function serviceVerdict(input: {
  overviewPublished: boolean;
  hasAnyContent: boolean;
  hasAnyPublished: boolean;
  qualification: { state: OpsSlotState; marksTotal: number | null };
  purchase: { state: OpsSlotState };
}): ServiceVerdict {
  if (!input.hasAnyContent) return 'empty';
  if (!input.hasAnyPublished) return 'draft';
  const qualificationReady =
    input.qualification.state === 'published' &&
    input.qualification.marksTotal === 100;
  const ready =
    input.overviewPublished &&
    qualificationReady &&
    input.purchase.state === 'published';
  return ready ? 'ready' : 'blocked';
}
