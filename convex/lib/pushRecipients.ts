import type { Id } from "../_generated/dataModel";
import { hasMinRole, type AccountRole } from "./roles";

// Who gets a push for an inbound message. Assigned → the assignee only;
// otherwise everyone who can act on the whole pool (supervisor+, which
// includes admin + owner). Agents/viewers are never paged for an
// unassigned message — they work only their own assignments.
export function recipientsForInbound(input: {
  assignedToUserId?: Id<"users"> | null;
  members: { userId: Id<"users">; role: AccountRole }[];
}): Id<"users">[] {
  if (input.assignedToUserId) return [input.assignedToUserId];
  return input.members
    .filter((m) => hasMinRole(m.role, "supervisor"))
    .map((m) => m.userId);
}
