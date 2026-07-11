// ============================================================
// Account role helpers — pure, unit-testable, no I/O.
//
// `roleRank`/`hasMinRole` give the linear ladder (owner=5 > admin=4 >
// supervisor=3 > agent=2 > viewer=1) most guards in this codebase need
// — a plain "does the caller outrank this floor" check. The Postgres
// `account_role_enum`/`is_account_member` CASE expression this once
// mirrored is gone (this codebase is fully on Convex now); nothing
// here speaks to a database layer anymore.
//
// Below the ladder, this file also holds the NON-linear policy
// functions the per-conversation access model needs —
// `canAccessConversation`, `canSeeContactPhone`, `canAssignToOthers`,
// and the settings split. These don't reduce to a single rank
// comparison: an agent's access depends on WHICH conversation
// (assigned to them vs. the unassigned pool vs. a colleague's), not
// just their rank, so each takes the caller's role AND the relevant
// row's ownership shape as separate inputs.
// ============================================================

export type AccountRole =
  | "owner"
  | "admin"
  | "supervisor"
  | "agent"
  | "viewer";

/** Numeric rank. Higher = more privileged. `supervisor` sits between
 *  admin and agent: it outranks agents on chat access but is below
 *  admin on settings/management. */
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

export function hasMinRole(role: AccountRole, min: AccountRole): boolean {
  return roleRank(role) >= roleRank(min);
}

// ── Non-linear policy: chat visibility ──────────────────────────────
export type ConversationScope = "all" | "own_and_pool" | "unassigned";

/** Which conversations a role may see. `own_and_pool` = assigned to the
 *  caller OR unassigned (the claimable lead pool). */
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

/** May the caller read a contact's real phone number for a
 *  conversation? admin/owner/supervisor always; an agent only on a
 *  conversation assigned to them; a viewer never. */
export function canSeeContactPhone(
  role: AccountRole,
  isAssignedToCaller: boolean,
): boolean {
  if (hasMinRole(role, "supervisor")) return true;
  if (role === "agent") return isAssignedToCaller;
  return false;
}

/** Only supervisor+ may assign a conversation to someone other than
 *  themselves. Agents self-claim only. */
export function canAssignToOthers(role: AccountRole): boolean {
  return hasMinRole(role, "supervisor");
}

/** Whether a role may reach one conversation. `view` = read/open;
 *  `own` = act on it (send/status/release). supervisor+ = all; agent
 *  view = own-or-unassigned, own = own-only; viewer view =
 *  unassigned-only, never own. */
export function canAccessConversation(
  role: AccountRole,
  where: { isMine: boolean; isUnassigned: boolean },
  mode: "view" | "own",
): boolean {
  if (hasMinRole(role, "supervisor")) return true;
  if (mode === "own") return role === "agent" && where.isMine;
  if (role === "agent") return where.isMine || where.isUnassigned;
  if (role === "viewer") return where.isUnassigned;
  return false;
}

// ── Settings split ──────────────────────────────────────────────────
/** Operational config: templates, quick replies, tags, custom fields,
 *  pipelines, deals & currency. */
export function canEditOperationalSettings(role: AccountRole): boolean {
  return hasMinRole(role, "supervisor");
}

/** Critical config: WhatsApp connection, API keys, AI provider keys. */
export function canEditCriticalSettings(role: AccountRole): boolean {
  return hasMinRole(role, "admin");
}
