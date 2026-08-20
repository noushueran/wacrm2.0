import { expect, test } from "vitest";
import { blockedReason, optedOutReason } from "./gate";

test("a contact with no doNotContact is not blocked", () => {
  expect(blockedReason({})).toBeNull();
  expect(blockedReason({ doNotContact: undefined })).toBeNull();
});

test("a contact carrying doNotContact is blocked", () => {
  expect(blockedReason({ doNotContact: { at: 1, noteId: "x" } })).toBe(
    "do_not_contact",
  );
});

// Fail closed. Every caller resolves the contact from an id that may
// race a delete; sending because the row vanished is the one failure
// mode this feature cannot have.
test("a missing contact is blocked, not allowed", () => {
  expect(blockedReason(null)).toBe("do_not_contact");
  expect(blockedReason(undefined)).toBe("do_not_contact");
});

test("an opted-out session blocks, and nothing else does", () => {
  expect(optedOutReason({ status: "opted_out" })).toBe("opted_out");
  expect(optedOutReason({ status: "collecting" })).toBeNull();
  expect(optedOutReason({ status: "qualified" })).toBeNull();
  expect(optedOutReason({ status: "expired" })).toBeNull();
  // No session at all is not an opt-out — most contacts have none, and
  // failing closed here would block every broadcast ever sent.
  expect(optedOutReason(null)).toBeNull();
  expect(optedOutReason(undefined)).toBeNull();
});

test("the two gates are independent — either one blocks alone", () => {
  // The whole point: a customer who told the bot to stop has no
  // `doNotContact`, and a human-flagged contact has no opted-out
  // session. Checking one would miss the other entirely.
  expect(blockedReason({ doNotContact: { at: 1 } })).toBe("do_not_contact");
  expect(optedOutReason({ status: "opted_out" })).toBe("opted_out");
  expect(blockedReason({})).toBeNull();
  expect(optedOutReason({ status: "collecting" })).toBeNull();
});
