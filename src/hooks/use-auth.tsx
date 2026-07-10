"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../convex/_generated/api";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  type AccountRole,
} from "@/lib/auth/roles";

// The current user under Convex Auth — the hook only ever exposes `id`
// + `email`.
// `created_at` is kept optional purely so the settings "Joined" line
// (src/components/settings/profile-form.tsx) keeps type-checking — Convex
// has no equivalent yet, so it is currently always `undefined`.
interface AuthUser {
  id: string;
  email: string | null;
  created_at?: string;
}

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  /**
   * Opted-in beta feature keys for this account. No current feature
   * reads this — Flows was the last user and went to soft-GA in PR
   * #134 — but the field survives for future beta gates. Convex has no
   * per-account beta list yet, so it is always `[]` post-cutover.
   */
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  /** Default deal currency (ISO-4217). NOT NULL DEFAULT 'USD' on the
   *  Convex `accounts` table; narrowed to DEFAULT_CURRENCY when absent. */
  default_currency: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  profile: Profile | null;
  /**
   * Session-level loading. Flips to false as soon as we know whether
   * a user is signed in, *without* waiting for the profile row. Use
   * this for chrome (sidebar / header) that can render with just the
   * user object. Sourced from `useConvexAuth().isLoading`.
   */
  loading: boolean;
  /**
   * Profile-row loading. Stays true while we're authenticated but the
   * `accounts.me` query hasn't resolved yet. Code that branches on
   * `profile.beta_features` MUST gate on this — otherwise it sees the
   * `{ loading: false, profile: null }` window during initial load
   * and may take the "not opted in" branch incorrectly.
   */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  /** Re-fetch the current user's profile row. No-op under Convex —
   *  `accounts.me` is a live subscription, so any write updates the
   *  context automatically — but kept in the contract so the settings
   *  form's post-save call site is untouched. */
  refreshProfile: () => Promise<void>;

  // ----------------------------------------------------------
  // Account-scoped context (added by the account-sharing series)
  //
  // All of these are nullable until `profileLoading` is false.
  // After the profile resolves they're guaranteed to be set,
  // because every bootstrapped user has exactly one membership +
  // account.
  // ----------------------------------------------------------

  /** Account id the current user belongs to. Null while loading. */
  accountId: string | null;
  /** Role within that account. Null while loading. */
  accountRole: AccountRole | null;
  /** Lightweight account meta — id + name + default_currency. Null while loading. */
  account: AccountSummary | null;
  /** Account default deal currency. Falls back to DEFAULT_CURRENCY
   *  while loading or when no account is resolved, so callers can use
   *  it unconditionally. */
  defaultCurrency: string;
  /** True if `accountRole === 'owner'`. */
  isOwner: boolean;
  /** True if `accountRole === 'admin'` (does NOT include owner — use canManageMembers for "admin or above"). */
  isAdmin: boolean;
  /** True if `accountRole === 'agent'`. */
  isAgent: boolean;
  /** True if `accountRole === 'viewer'`. */
  isViewer: boolean;
  /** True if the caller can manage members (admin+). */
  canManageMembers: boolean;
  /** True if the caller can edit account-wide settings (admin+). */
  canEditSettings: boolean;
  /** True if the caller can send messages and edit operational data (agent+). */
  canSendMessages: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * AuthProvider — wrap this around the dashboard layout.
 *
 * Sources everything from Convex Auth: `useConvexAuth()` gives the
 * session-level auth state, and the reactive `api.accounts.me` query
 * gives the profile + account. There's no imperative fetch/refetch —
 * every value is a live subscription, so a mutation anywhere updates the
 * whole tree without a manual refresh.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  // `undefined` while the query is in flight; `null` when authenticated
  // but not yet bootstrapped (no membership); the object once resolved.
  // When unauthenticated it resolves to `null` (the query returns null
  // for a missing identity).
  const me = useQuery(api.accounts.me);
  const { signOut: convexSignOut } = useAuthActions();
  const bootstrapAccount = useMutation(api.accounts.bootstrapAccount);

  // First-login bootstrap: a brand-new Convex user is authenticated but
  // has no membership yet (`me === null`). Give them their own account
  // once — same idempotent call `/convex-demo` makes. `bootstrapAccount`
  // is a documented no-op after the first success, and `me` flips to a
  // real object reactively once it lands, so the guard below stops firing.
  // Reset per session so a fresh sign-in re-arms it.
  const didBootstrapRef = useRef(false);
  useEffect(() => {
    if (!isAuthenticated) {
      didBootstrapRef.current = false;
      return;
    }
    if (me === null && !didBootstrapRef.current) {
      didBootstrapRef.current = true;
      bootstrapAccount({}).catch((err) => {
        // Leave the ref set so we don't hot-loop on a persistent failure;
        // the sign-up page also bootstraps, so this is a backstop.
        console.error("[AuthProvider] bootstrapAccount failed:", err);
      });
    }
  }, [isAuthenticated, me, bootstrapAccount]);

  const loading = isLoading;
  // Only "loading a profile" once we know there IS a user to load one for.
  const profileLoading = isAuthenticated && me === undefined;

  // Truthy the instant we're authenticated — independent of the profile
  // query — so the dashboard route guard (`!loading && !user`) never
  // bounces an authenticated user to /login during the `me` fetch window.
  // `id`/`email` fill in reactively when `me` resolves.
  const user: AuthUser | null = isAuthenticated
    ? { id: me?.userId ?? "", email: me?.email ?? null }
    : null;

  const profile: Profile | null = me
    ? {
        id: me.userId,
        full_name: me.name,
        email: me.email ?? "",
        avatar_url: me.avatarUrl,
        role: null,
        beta_features: [],
        account_id: me.accountId,
        account_role: me.accountRole,
      }
    : null;

  const account: AccountSummary | null = me
    ? {
        id: me.account.id,
        name: me.account.name,
        default_currency: me.account.defaultCurrency,
      }
    : null;

  const signOut = useCallback(async () => {
    try {
      await convexSignOut();
    } finally {
      // Full navigation (not router.push) so every provider/subscription
      // tears down and re-initializes cleanly on the login page.
      window.location.href = "/login";
    }
  }, [convexSignOut]);

  const refreshProfile = useCallback(async () => {
    // Intentionally a no-op: `api.accounts.me` is reactive.
  }, []);

  // Derive the role booleans once per role/account change rather than on
  // every consumer render, giving each derived value a stable identity
  // for React.memo / useEffect dependencies downstream.
  const derived = useMemo(() => {
    const role: AccountRole | null = me?.accountRole ?? null;
    return {
      accountRole: role,
      accountId: me?.accountId ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [me?.accountRole, me?.accountId]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (shouldn't
    // happen in normal flow, but don't crash the page). Account state
    // collapses to least-privileged null — every `canX` boolean is
    // false so UI gates fail closed.
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
    };
  }
  return ctx;
}
