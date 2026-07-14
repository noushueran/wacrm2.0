// ============================================================
// Account role helpers — pure, unit-testable, no I/O.
//
// Mirrors the `account_role_enum` Postgres type from migration
// 017_account_sharing.sql. The hierarchy is intentionally a flat
// ordinal (owner=4 … viewer=1) — it matches the same CASE
// expression the `is_account_member(account_id, min_role)` SQL
// helper uses, so server-side TypeScript guards and database-side
// RLS speak the same language.
//
// Predicates (`canManageMembers`, `canEditSettings`, …) are the
// single source of truth for "what can this role do?" — both
// API route guards and UI gates should call them rather than
// open-coding their own role checks. That keeps role-policy
// changes a one-file diff.
// ============================================================

export type AccountRole =
  | "owner"
  | "admin"
  | "supervisor"
  | "agent"
  | "viewer";

/** Ordered list, lowest privilege first. */
export const ACCOUNT_ROLES: readonly AccountRole[] = [
  "viewer",
  "agent",
  "supervisor",
  "admin",
  "owner",
] as const;

export function roleRank(role: AccountRole): number {
  switch (role) {
    case "owner":
      return 5;
    case "admin":
      return 4;
    case "supervisor":
      return 3;
    case "agent":
      return 2;
    case "viewer":
      return 1;
  }
}

/**
 * True iff `role` is at least as privileged as `min`. Use this
 * for any "user has at least admin" / "at least agent" checks.
 */
export function hasMinRole(role: AccountRole, min: AccountRole): boolean {
  return roleRank(role) >= roleRank(min);
}

/** Type-narrow an unknown string into a valid `AccountRole`. */
export function isAccountRole(value: unknown): value is AccountRole {
  return (
    typeof value === "string" &&
    (ACCOUNT_ROLES as readonly string[]).includes(value)
  );
}

// ============================================================
// Capability predicates
//
// Every UI gate and API route guard should call one of these
// instead of comparing role strings inline. Adding a capability
// = one new predicate here + one call site change per consumer.
// ============================================================

/** Owner / admin: invite, remove, change roles. */
export function canManageMembers(role: AccountRole): boolean {
  return hasMinRole(role, "admin");
}

/** @deprecated Prefer `canEditCriticalSettings` / `canEditOperationalSettings`.
 *  Retained (admin+) so existing critical-settings call sites are unchanged. */
export function canEditSettings(role: AccountRole): boolean {
  return canEditCriticalSettings(role);
}

export function canEditCriticalSettings(role: AccountRole): boolean {
  return hasMinRole(role, "admin");
}

export function canEditOperationalSettings(role: AccountRole): boolean {
  return hasMinRole(role, "supervisor");
}

/**
 * Owner / admin / agent: write operational data — send messages,
 * create contacts, move deals, run broadcasts, edit automations.
 * Viewers are read-only.
 */
export function canSendMessages(role: AccountRole): boolean {
  return hasMinRole(role, "agent");
}

/**
 * Viewer: read-only across everything. Provided as a positive
 * predicate so UI gates read naturally (`if (canViewOnly(role))`
 * shows the "Read-only" tooltip without inverting `canSendMessages`).
 */
export function canViewOnly(role: AccountRole): boolean {
  return role === "viewer";
}

/** Owner only: irreversible destructive operations. */
export function canDeleteAccount(role: AccountRole): boolean {
  return role === "owner";
}

/** Owner only: hand the account to another member. */
export function canTransferOwnership(role: AccountRole): boolean {
  return role === "owner";
}

export type ConversationScope = "all" | "own_and_pool" | "unassigned";
export function conversationScope(role: AccountRole): ConversationScope {
  switch (role) {
    case "owner":
    case "admin":
    case "supervisor":
      return "all";
    case "agent":
      return "own_and_pool";
    case "viewer":
      return "unassigned";
  }
}

export function canSeeContactPhone(
  role: AccountRole,
  isAssignedToCaller: boolean,
): boolean {
  if (hasMinRole(role, "supervisor")) return true;
  if (role === "agent") return isAssignedToCaller;
  return false;
}

export function canAssignToOthers(role: AccountRole): boolean {
  return hasMinRole(role, "supervisor");
}

// ── Section access (nav + settings rail) ────────────────────────────
/** Top-level nav hrefs. */
export const AGENT_NAV = ["/inbox", "/notifications"] as const;
export const VIEWER_NAV = ["/inbox"] as const;

export function canAccessNav(role: AccountRole, href: string): boolean {
  // Match the concrete href or a nested route under it.
  const base = "/" + (href.split("/")[1] ?? "");
  if (hasMinRole(role, "supervisor")) return true; // supervisor/admin/owner: all
  if (role === "agent") return (AGENT_NAV as readonly string[]).includes(base);
  if (role === "viewer") return (VIEWER_NAV as readonly string[]).includes(base);
  return false;
}

/** Route-level access (for the client route guard). Same as `canAccessNav`
 *  except `/settings` is always reachable — the personal Profile/Appearance
 *  sections are universal, and the settings page gates its own tabs. */
export function canAccessRoute(role: AccountRole, path: string): boolean {
  const base = "/" + (path.split("?")[0].split("/")[1] ?? "");
  if (base === "/settings") return true;
  return canAccessNav(role, base);
}

/** Settings section ids (mirror of settings-sections.ts). */
export type SettingsSectionKey =
  | "overview"
  | "profile"
  | "appearance"
  | "whatsapp"
  | "templates"
  | "quick-replies"
  | "fields"
  | "deals"
  | "members"
  | "api"
  | "conversions";

const PERSONAL_SECTIONS: SettingsSectionKey[] = ["overview", "profile", "appearance"];
// `conversions` renders `api.attribution.listConversions`, which is
// itself `ctx.requireRole("admin")`-gated (it exposes raw lead phone
// numbers) — same threshold as `whatsapp`/`api`/`members`, so it joins
// them here rather than being reachable by a supervisor.
const CRITICAL_SECTIONS: SettingsSectionKey[] = ["whatsapp", "api", "members", "conversions"];

export function canAccessSettingsSection(
  role: AccountRole,
  section: SettingsSectionKey,
): boolean {
  if (PERSONAL_SECTIONS.includes(section)) return true; // everyone
  if (hasMinRole(role, "admin")) return true; // admin/owner: all
  if (role === "supervisor") return !CRITICAL_SECTIONS.includes(section);
  return false; // agent/viewer: personal only
}

export function defaultLandingPath(role: AccountRole): string {
  return hasMinRole(role, "supervisor") ? "/dashboard" : "/inbox";
}
