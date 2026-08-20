import { describe, expect, it } from 'vitest';

import { BOARD_ROLES, pageAccessGate } from './page-access';

/**
 * The bugs this pins. Both pages derived one boolean (`canView`) from
 * `accountRole` alone, and `useAuth` documents that field as "Null while
 * loading", so a signing-in user landed in the same branch as a denied
 * one:
 *
 * - `/lead-analysis` rendered `LeadAnalysis.empty` — "No leads scored
 *   yet" — which was false on an account with 400 scored leads, and the
 *   wrong answer for a viewer, who lacks access rather than data.
 * - `/leads` had no denial branch at all: its query is skipped for a
 *   viewer, so `board` never arrives and the page sat on "Loading
 *   leads…" forever.
 *
 * Kept pure because this repo has no jsdom and a page component cannot
 * be rendered in a test — which is why neither bug could fail anything.
 */
const resolved = (accountRole: Parameters<typeof pageAccessGate>[0]['accountRole']) => ({
  authLoading: false,
  profileLoading: false,
  accountRole,
});

describe('pageAccessGate', () => {
  it('reports loading while the session is still resolving', () => {
    expect(
      pageAccessGate({ authLoading: true, profileLoading: false, accountRole: null }, BOARD_ROLES),
    ).toBe('loading');
  });

  it('reports loading while the profile row is still in flight', () => {
    expect(
      pageAccessGate({ authLoading: false, profileLoading: true, accountRole: null }, BOARD_ROLES),
    ).toBe('loading');
  });

  it('never claims "no access" merely because the role has not arrived yet', () => {
    // The regression, in one line: a null role during load must not read
    // as denial, and must never reach a page's data-empty copy.
    expect(
      pageAccessGate({ authLoading: true, profileLoading: true, accountRole: null }, BOARD_ROLES),
    ).not.toBe('no_access');
  });

  it('reports no_access for a resolved role outside the allowlist', () => {
    expect(pageAccessGate(resolved('viewer'), BOARD_ROLES)).toBe('no_access');
  });

  it('reports no_access when authentication resolved to no role at all', () => {
    expect(pageAccessGate(resolved(null), BOARD_ROLES)).toBe('no_access');
  });

  it.each(BOARD_ROLES)('lets %s through to the board', (role) => {
    expect(pageAccessGate(resolved(role), BOARD_ROLES)).toBe('ready');
  });

  it('honours a narrower allowlist than BOARD_ROLES', () => {
    // The allowlist is a parameter so `/leads` and `/lead-analysis` can
    // diverge without one silently following the other.
    expect(pageAccessGate(resolved('agent'), ['supervisor', 'admin', 'owner'])).toBe('no_access');
    expect(pageAccessGate(resolved('supervisor'), ['supervisor', 'admin', 'owner'])).toBe('ready');
  });

  it('excludes viewer from BOARD_ROLES', () => {
    expect(BOARD_ROLES).not.toContain('viewer');
  });
});
