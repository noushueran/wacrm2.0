import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ROLES,
  type AccountRole,
  canAccessNav,
  canAccessRoute,
  canAccessSettingsSection,
  canDeleteAccount,
  canEditCriticalSettings,
  canEditOperationalSettings,
  canEditSettings,
  canManageMembers,
  canSendMessages,
  canTransferOwnership,
  canViewOnly,
  defaultLandingPath,
  hasMinRole,
  isAccountRole,
  roleRank,
} from "./roles";

describe("roleRank", () => {
  it("orders owner > admin > agent > viewer", () => {
    expect(roleRank("owner")).toBeGreaterThan(roleRank("admin"));
    expect(roleRank("admin")).toBeGreaterThan(roleRank("agent"));
    expect(roleRank("agent")).toBeGreaterThan(roleRank("viewer"));
  });

  it("matches the account-role model's numeric mapping", () => {
    expect(roleRank("owner")).toBe(5);
    expect(roleRank("admin")).toBe(4);
    expect(roleRank("supervisor")).toBe(3);
    expect(roleRank("agent")).toBe(2);
    expect(roleRank("viewer")).toBe(1);
  });
});

describe("hasMinRole", () => {
  it("returns true when role meets the threshold", () => {
    expect(hasMinRole("owner", "viewer")).toBe(true);
    expect(hasMinRole("admin", "agent")).toBe(true);
    expect(hasMinRole("agent", "agent")).toBe(true);
  });

  it("returns false when role is below the threshold", () => {
    expect(hasMinRole("viewer", "agent")).toBe(false);
    expect(hasMinRole("agent", "admin")).toBe(false);
    expect(hasMinRole("admin", "owner")).toBe(false);
  });

  // The full matrix — useful as a regression net if anyone reshuffles
  // the rank table.
  it.each<[AccountRole, AccountRole, boolean]>([
    ["owner", "owner", true],
    ["owner", "admin", true],
    ["owner", "supervisor", true],
    ["owner", "agent", true],
    ["owner", "viewer", true],
    ["admin", "owner", false],
    ["admin", "admin", true],
    ["admin", "supervisor", true],
    ["admin", "agent", true],
    ["admin", "viewer", true],
    ["supervisor", "owner", false],
    ["supervisor", "admin", false],
    ["supervisor", "supervisor", true],
    ["supervisor", "agent", true],
    ["supervisor", "viewer", true],
    ["agent", "owner", false],
    ["agent", "admin", false],
    ["agent", "supervisor", false],
    ["agent", "agent", true],
    ["agent", "viewer", true],
    ["viewer", "owner", false],
    ["viewer", "admin", false],
    ["viewer", "supervisor", false],
    ["viewer", "agent", false],
    ["viewer", "viewer", true],
  ])("%s vs min %s → %s", (role, min, expected) => {
    expect(hasMinRole(role, min)).toBe(expected);
  });
});

describe("isAccountRole", () => {
  it("accepts every value in ACCOUNT_ROLES", () => {
    for (const role of ACCOUNT_ROLES) {
      expect(isAccountRole(role)).toBe(true);
    }
  });

  it("rejects garbage / case mismatch / non-strings", () => {
    expect(isAccountRole("Owner")).toBe(false);
    expect(isAccountRole("")).toBe(false);
    expect(isAccountRole(null)).toBe(false);
    expect(isAccountRole(undefined)).toBe(false);
    expect(isAccountRole(123)).toBe(false);
    expect(isAccountRole("superuser")).toBe(false);
  });
});

describe("capability predicates", () => {
  it("canManageMembers: admin+ only", () => {
    expect(canManageMembers("owner")).toBe(true);
    expect(canManageMembers("admin")).toBe(true);
    expect(canManageMembers("agent")).toBe(false);
    expect(canManageMembers("viewer")).toBe(false);
  });

  it("canEditSettings: admin+ only", () => {
    expect(canEditSettings("owner")).toBe(true);
    expect(canEditSettings("admin")).toBe(true);
    expect(canEditSettings("agent")).toBe(false);
    expect(canEditSettings("viewer")).toBe(false);
  });

  it("canSendMessages: agent+ only", () => {
    expect(canSendMessages("owner")).toBe(true);
    expect(canSendMessages("admin")).toBe(true);
    expect(canSendMessages("agent")).toBe(true);
    expect(canSendMessages("viewer")).toBe(false);
  });

  it("canViewOnly: viewer only", () => {
    expect(canViewOnly("owner")).toBe(false);
    expect(canViewOnly("admin")).toBe(false);
    expect(canViewOnly("agent")).toBe(false);
    expect(canViewOnly("viewer")).toBe(true);
  });

  it("canDeleteAccount: owner only", () => {
    expect(canDeleteAccount("owner")).toBe(true);
    expect(canDeleteAccount("admin")).toBe(false);
    expect(canDeleteAccount("agent")).toBe(false);
    expect(canDeleteAccount("viewer")).toBe(false);
  });

  it("canTransferOwnership: owner only", () => {
    expect(canTransferOwnership("owner")).toBe(true);
    expect(canTransferOwnership("admin")).toBe(false);
    expect(canTransferOwnership("agent")).toBe(false);
    expect(canTransferOwnership("viewer")).toBe(false);
  });

  it("canEditOperationalSettings: supervisor+", () => {
    expect(canEditOperationalSettings("owner")).toBe(true);
    expect(canEditOperationalSettings("admin")).toBe(true);
    expect(canEditOperationalSettings("supervisor")).toBe(true);
    expect(canEditOperationalSettings("agent")).toBe(false);
    expect(canEditOperationalSettings("viewer")).toBe(false);
  });

  it("canEditCriticalSettings: admin+ (supervisor excluded)", () => {
    expect(canEditCriticalSettings("admin")).toBe(true);
    expect(canEditCriticalSettings("supervisor")).toBe(false);
  });

  it("canAccessNav gates agent/viewer to inbox + notifications", () => {
    expect(canAccessNav("agent", "/inbox")).toBe(true);
    expect(canAccessNav("agent", "/notifications")).toBe(true);
    expect(canAccessNav("agent", "/contacts")).toBe(false);
    expect(canAccessNav("agent", "/settings")).toBe(false);
    expect(canAccessNav("viewer", "/inbox")).toBe(true);
    expect(canAccessNav("viewer", "/notifications")).toBe(false);
    expect(canAccessNav("supervisor", "/broadcasts")).toBe(true);
    expect(canAccessNav("supervisor", "/settings")).toBe(true);
  });

  it("canAccessNav confines supervisor to its allowlist", () => {
    // Granted
    expect(canAccessNav("supervisor", "/dashboard")).toBe(true);
    expect(canAccessNav("supervisor", "/inbox")).toBe(true);
    expect(canAccessNav("supervisor", "/leads")).toBe(true);
    expect(canAccessNav("supervisor", "/contacts")).toBe(true);
    expect(canAccessNav("supervisor", "/pipelines")).toBe(true);
    expect(canAccessNav("supervisor", "/broadcasts")).toBe(true);
    expect(canAccessNav("supervisor", "/campaigns")).toBe(true);
    // Must stay granted: the sidebar filters the Settings link through
    // canAccessNav, and the route guard uses canAccessRoute.
    expect(canAccessNav("supervisor", "/settings")).toBe(true);
    expect(canAccessNav("supervisor", "/notifications")).toBe(true);

    // Denied
    expect(canAccessNav("supervisor", "/agents")).toBe(false);
    expect(canAccessNav("supervisor", "/automations")).toBe(false);
    expect(canAccessNav("supervisor", "/flows")).toBe(false);
  });

  it("canAccessNav still admits admin and owner everywhere", () => {
    for (const href of ["/agents", "/automations", "/flows", "/campaigns"]) {
      expect(canAccessNav("admin", href)).toBe(true);
      expect(canAccessNav("owner", href)).toBe(true);
    }
  });

  it("canAccessNav leaves agent and viewer untouched", () => {
    expect(canAccessNav("agent", "/inbox")).toBe(true);
    expect(canAccessNav("agent", "/notifications")).toBe(true);
    expect(canAccessNav("agent", "/leads")).toBe(true);
    expect(canAccessNav("agent", "/campaigns")).toBe(false);
    expect(canAccessNav("agent", "/agents")).toBe(false);
    expect(canAccessNav("viewer", "/inbox")).toBe(true);
    expect(canAccessNav("viewer", "/campaigns")).toBe(false);
    expect(canAccessNav("viewer", "/agents")).toBe(false);
  });

  it("canAccessNav matches nested routes to their base section", () => {
    expect(canAccessNav("supervisor", "/contacts/abc123")).toBe(true);
    expect(canAccessNav("supervisor", "/agents/abc123")).toBe(false);
  });

  it("a new unlisted page is private to supervisors by default", () => {
    // The whole point of the allowlist: adding a page must not silently
    // grant it. If this ever fails, someone reintroduced a denylist.
    expect(canAccessNav("supervisor", "/some-future-page")).toBe(false);
    expect(canAccessNav("admin", "/some-future-page")).toBe(true);
  });

  it("canAccessSettingsSection: agent/viewer personal-only; supervisor no critical", () => {
    expect(canAccessSettingsSection("agent", "profile")).toBe(true);
    expect(canAccessSettingsSection("agent", "appearance")).toBe(true);
    expect(canAccessSettingsSection("agent", "templates")).toBe(false);
    expect(canAccessSettingsSection("supervisor", "templates")).toBe(true);
    expect(canAccessSettingsSection("supervisor", "whatsapp")).toBe(false);
    expect(canAccessSettingsSection("supervisor", "members")).toBe(true);
    expect(canAccessSettingsSection("admin", "whatsapp")).toBe(true);
  });

  it("canAccessSettingsSection gives supervisor operational tabs only", () => {
    // Granted
    for (const section of [
      "overview",
      "profile",
      "appearance",
      "notifications",
      "templates",
      "quick-replies",
      "fields",
      "deals",
      "members",
    ] as const) {
      expect(canAccessSettingsSection("supervisor", section)).toBe(true);
    }
    // Denied
    for (const section of [
      "whatsapp",
      "api",
      "conversions",
      "qualification",
      "cron",
    ] as const) {
      expect(canAccessSettingsSection("supervisor", section)).toBe(false);
    }
  });

  it("defaultLandingPath: agent/viewer → /inbox, others → /dashboard", () => {
    expect(defaultLandingPath("agent")).toBe("/inbox");
    expect(defaultLandingPath("viewer")).toBe("/inbox");
    expect(defaultLandingPath("supervisor")).toBe("/dashboard");
    expect(defaultLandingPath("admin")).toBe("/dashboard");
  });

  it("canAccessRoute always allows /settings (personal) but gates feature routes", () => {
    expect(canAccessRoute("agent", "/settings")).toBe(true);
    expect(canAccessRoute("agent", "/settings?tab=whatsapp")).toBe(true); // page gates the tab
    expect(canAccessRoute("agent", "/contacts")).toBe(false);
    expect(canAccessRoute("agent", "/inbox")).toBe(true);
    expect(canAccessRoute("viewer", "/notifications")).toBe(false);
    expect(canAccessRoute("supervisor", "/broadcasts")).toBe(true);
  });
});
