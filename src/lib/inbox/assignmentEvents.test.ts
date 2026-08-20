import { describe, expect, test } from "vitest";
import { assignmentEventLine, type AssignmentEventView } from "./assignmentEvents";

const base: AssignmentEventView = {
  kind: "assigned",
  source: "manual",
  actorUserId: "u1",
  targetUserId: "u2",
  actorName: "Noushad",
  targetName: "Fathima",
  previousName: null,
};

describe("assignmentEventLine", () => {
  test("a manual handover names both people", () => {
    expect(assignmentEventLine(base)).toEqual({
      key: "assigned",
      values: { actor: "Noushad", target: "Fathima" },
    });
  });

  test("a manual handover from someone else names all three", () => {
    expect(assignmentEventLine({ ...base, previousName: "Rashid" })).toEqual({
      key: "reassigned",
      values: { actor: "Noushad", target: "Fathima", previous: "Rashid" },
    });
  });

  test("claiming a chat for yourself reads as taking it, not assigning it", () => {
    expect(
      assignmentEventLine({ ...base, targetUserId: "u1", targetName: "Noushad" }),
    ).toEqual({ key: "selfAssigned", values: { actor: "Noushad" } });
  });

  test("the auto-assign sweep has no actor and says so", () => {
    expect(
      assignmentEventLine({ ...base, source: "auto_assign", actorUserId: null, actorName: null }),
    ).toEqual({ key: "autoAssigned", values: { target: "Fathima" } });
  });

  test("an automation is named as the actor", () => {
    expect(
      assignmentEventLine({ ...base, source: "automation", actorUserId: null, actorName: null }),
    ).toEqual({ key: "automationAssigned", values: { target: "Fathima" } });
  });

  test("accepting the WhatsApp offer reads as accepting a lead", () => {
    expect(
      assignmentEventLine({
        ...base, source: "offer_accept", actorUserId: "u2", actorName: "Fathima",
      }),
    ).toEqual({ key: "offerAccepted", values: { target: "Fathima" } });
  });

  test("taking over from the AI is its own sentence", () => {
    expect(
      assignmentEventLine({
        ...base, source: "takeover", targetUserId: "u1", targetName: "Noushad",
      }),
    ).toEqual({ key: "takeover", values: { actor: "Noushad" } });
  });

  // Two supervisors racing an unassigned thread: the second one's
  // takeover lands on a chat the first already holds. "Took over from
  // the AI" would be a lie — the AI never had it.
  test("a takeover from a colleague names them instead of the AI", () => {
    expect(
      assignmentEventLine({
        ...base, source: "takeover", targetUserId: "u1", targetName: "Noushad",
        previousName: "Rashid",
      }),
    ).toEqual({
      key: "reassigned",
      values: { actor: "Noushad", target: "Noushad", previous: "Rashid" },
    });
  });

  // A supervisor pulling a colleague's chat onto themselves through the
  // Assign dropdown — a normal path, not a race. "Took this chat" would
  // drop Rashid entirely.
  test("self-assigning someone else's chat still names who lost it", () => {
    expect(
      assignmentEventLine({
        ...base, targetUserId: "u1", targetName: "Noushad", previousName: "Rashid",
      }),
    ).toEqual({
      key: "reassigned",
      values: { actor: "Noushad", target: "Noushad", previous: "Rashid" },
    });
  });

  test("resuming the AI reads as a release, with no actor", () => {
    expect(
      assignmentEventLine({
        kind: "unassigned", source: "release", actorUserId: null, targetUserId: null,
        actorName: null, targetName: null, previousName: "Fathima",
      }),
    ).toEqual({ key: "released", values: { previous: "Fathima" } });
  });

  test("a manual unassign names who did it and who lost it", () => {
    expect(
      assignmentEventLine({
        kind: "unassigned", source: "manual", actorUserId: "u1", targetUserId: null,
        actorName: "Noushad", targetName: null, previousName: "Fathima",
      }),
    ).toEqual({ key: "unassigned", values: { actor: "Noushad", previous: "Fathima" } });
  });

  test("a departed member falls back to a neutral word, never an empty name", () => {
    expect(
      assignmentEventLine({ ...base, targetName: null }),
    ).toEqual({ key: "assigned", values: { actor: "Noushad", target: "__unknown__" } });
  });
});
