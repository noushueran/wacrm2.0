import { test, expect } from "vitest";
import { hasMinRole, roleRank } from "./roles";

test("role ladder", () => {
  expect(roleRank("owner")).toBe(4);
  expect(hasMinRole("admin", "agent")).toBe(true);
  expect(hasMinRole("viewer", "admin")).toBe(false);
});
