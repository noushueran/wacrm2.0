import type { AccountRole } from '@/lib/auth/roles';

/**
 * Which of three things a role-gated page should render: still working
 * out who you are, you may not be here, or here is the content.
 *
 * Split out as a pure function because pages used to collapse all three
 * into one boolean. `canView` was derived from `accountRole` alone, and
 * `useAuth` documents that field as "Null while loading", so a
 * signing-in user fell into the same branch as a denied one. On
 * `/lead-analysis` that branch rendered "No leads scored yet" — a false
 * statement on an account with 400 scored leads, and the wrong answer
 * for a viewer, who lacks access rather than data. On `/leads` the same
 * conflation left a viewer on "Loading leads…" forever, because the
 * query is skipped for them and `board` therefore never arrives.
 *
 * "Identity unknown" is `authLoading || profileLoading`, not
 * `profileLoading` on its own: `profileLoading` is
 * `isAuthenticated && me === undefined`, which is FALSE during the
 * session check that runs before authentication resolves. Gating on it
 * alone would leave exactly the window those bugs lived in.
 *
 * Pure, and therefore testable: this repo has no jsdom, so a page
 * component cannot be rendered in a test and a rule kept inside one
 * cannot be pinned. That is why both bugs shipped.
 */
export type PageAccessGate = 'loading' | 'no_access' | 'ready';

export interface PageAccessAuth {
  /** `useAuth().loading` — the session-level check. */
  authLoading: boolean;
  /** `useAuth().profileLoading` — authenticated, profile row still in flight. */
  profileLoading: boolean;
  /** `useAuth().accountRole` — null while loading AND when there is no role. */
  accountRole: AccountRole | null;
}

/**
 * The roles the lead boards are for. Viewers are deliberately absent:
 * both `/leads` and `/lead-analysis` skip their board query entirely for
 * a viewer, and the server enforces the same floor independently.
 *
 * Shared because the two pages agree TODAY, not because they must — the
 * allowlist is a parameter so either can diverge without the other
 * silently following.
 */
export const BOARD_ROLES: readonly AccountRole[] = ['agent', 'supervisor', 'admin', 'owner'];

export function pageAccessGate(
  auth: PageAccessAuth,
  allowedRoles: readonly AccountRole[],
): PageAccessGate {
  // Order matters: unknown identity is checked FIRST, so a null role that
  // simply has not arrived yet can never be read as a denial.
  if (auth.authLoading || auth.profileLoading) return 'loading';
  if (auth.accountRole === null) return 'no_access';
  return allowedRoles.includes(auth.accountRole) ? 'ready' : 'no_access';
}
