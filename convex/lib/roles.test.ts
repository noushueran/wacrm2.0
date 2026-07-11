import { test, expect } from "vitest";
import {
  hasMinRole,
  roleRank,
  conversationScope,
  canSeeContactPhone,
  canAssignToOthers,
  canAccessConversation,
  canEditOperationalSettings,
  canEditCriticalSettings,
} from "./roles";

test("role ladder with supervisor inserted between admin and agent", () => {
  expect(roleRank("owner")).toBe(5);
  expect(roleRank("admin")).toBe(4);
  expect(roleRank("supervisor")).toBe(3);
  expect(roleRank("agent")).toBe(2);
  expect(roleRank("viewer")).toBe(1);
  expect(hasMinRole("supervisor", "agent")).toBe(true);
  expect(hasMinRole("supervisor", "admin")).toBe(false);
  expect(hasMinRole("admin", "supervisor")).toBe(true);
  expect(hasMinRole("viewer", "admin")).toBe(false);
});

test("conversationScope maps roles to visibility", () => {
  expect(conversationScope("owner")).toBe("all");
  expect(conversationScope("admin")).toBe("all");
  expect(conversationScope("supervisor")).toBe("all");
  expect(conversationScope("agent")).toBe("own_and_pool");
  expect(conversationScope("viewer")).toBe("unassigned");
});

test("canSeeContactPhone: supervisor+ always; agent only when assigned; viewer never", () => {
  expect(canSeeContactPhone("owner", false)).toBe(true);
  expect(canSeeContactPhone("admin", false)).toBe(true);
  expect(canSeeContactPhone("supervisor", false)).toBe(true);
  expect(canSeeContactPhone("agent", true)).toBe(true);
  expect(canSeeContactPhone("agent", false)).toBe(false);
  expect(canSeeContactPhone("viewer", true)).toBe(false);
});

test("canAssignToOthers: supervisor+ only", () => {
  expect(canAssignToOthers("owner")).toBe(true);
  expect(canAssignToOthers("admin")).toBe(true);
  expect(canAssignToOthers("supervisor")).toBe(true);
  expect(canAssignToOthers("agent")).toBe(false);
  expect(canAssignToOthers("viewer")).toBe(false);
});

test("canAccessConversation view/own by role", () => {
  // supervisor+ : everything, both modes
  for (const role of ["owner", "admin", "supervisor"] as const) {
    expect(canAccessConversation(role, { isMine: false, isUnassigned: false }, "view")).toBe(true);
    expect(canAccessConversation(role, { isMine: false, isUnassigned: false }, "own")).toBe(true);
  }
  // agent view: own or unassigned; own: only own
  expect(canAccessConversation("agent", { isMine: true, isUnassigned: false }, "view")).toBe(true);
  expect(canAccessConversation("agent", { isMine: false, isUnassigned: true }, "view")).toBe(true);
  expect(canAccessConversation("agent", { isMine: false, isUnassigned: false }, "view")).toBe(false);
  expect(canAccessConversation("agent", { isMine: false, isUnassigned: true }, "own")).toBe(false);
  expect(canAccessConversation("agent", { isMine: true, isUnassigned: false }, "own")).toBe(true);
  // viewer view: unassigned only; own: never
  expect(canAccessConversation("viewer", { isMine: false, isUnassigned: true }, "view")).toBe(true);
  expect(canAccessConversation("viewer", { isMine: false, isUnassigned: false }, "view")).toBe(false);
  expect(canAccessConversation("viewer", { isMine: false, isUnassigned: true }, "own")).toBe(false);
});

test("settings split: operational supervisor+, critical admin+", () => {
  expect(canEditOperationalSettings("supervisor")).toBe(true);
  expect(canEditOperationalSettings("agent")).toBe(false);
  expect(canEditCriticalSettings("supervisor")).toBe(false);
  expect(canEditCriticalSettings("admin")).toBe(true);
});
