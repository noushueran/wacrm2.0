import { describe, it, expect } from "vitest";
import { recipientsForInbound } from "./pushRecipients";

const members = [
  { userId: "u_owner" as never, role: "owner" as const },
  { userId: "u_admin" as never, role: "admin" as const },
  { userId: "u_sup" as never, role: "supervisor" as const },
  { userId: "u_agent" as never, role: "agent" as const },
  { userId: "u_viewer" as never, role: "viewer" as const },
];

describe("recipientsForInbound", () => {
  it("assigned → only the assignee", () => {
    expect(recipientsForInbound({ assignedToUserId: "u_agent" as never, members })).toEqual([
      "u_agent",
    ]);
  });
  it("unassigned → owner + admin + supervisor only", () => {
    expect(
      recipientsForInbound({ assignedToUserId: null, members }).sort(),
    ).toEqual(["u_admin", "u_owner", "u_sup"]);
  });
  it("unassigned with no privileged members → empty", () => {
    expect(
      recipientsForInbound({
        assignedToUserId: null,
        members: [{ userId: "u_agent" as never, role: "agent" }],
      }),
    ).toEqual([]);
  });
});
