import { expect, test } from "vitest";
import { parseStaffReply } from "./staffReply";

test("accepts the quick-reply button label with a typographic apostrophe", () => {
  expect(parseStaffReply("I'll take it")).toBe("accept");
});

test("still accepts the straight-apostrophe form", () => {
  expect(parseStaffReply("I'll take it")).toBe("accept");
});

test("declines on the Not now button label", () => {
  expect(parseStaffReply("Not now")).toBe("decline");
});

test("treats the window-opener button as neither accept nor decline", () => {
  expect(parseStaffReply("Show me")).toBe("other");
});
