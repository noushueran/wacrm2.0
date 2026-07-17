import { describe, it, expect } from "vitest";

import type { Notification } from "@/types";
import { notificationHref, formatUnreadBadge } from "./shared";

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n1",
    account_id: "a1",
    user_id: "u1",
    type: "conversation_assigned",
    title: "Conversation assigned to you",
    created_at: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("notificationHref", () => {
  it("links to the inbox conversation when conversation_id is set", () => {
    const n = makeNotification({ conversation_id: "conv_123" });
    expect(notificationHref(n)).toBe("/inbox?c=conv_123");
  });

  it("returns null when there is no linked conversation", () => {
    const n = makeNotification({ conversation_id: undefined });
    expect(notificationHref(n)).toBeNull();
  });
});

describe("formatUnreadBadge", () => {
  it("hides the badge when there are no unread notifications", () => {
    expect(formatUnreadBadge(0)).toBeNull();
  });

  it("shows the exact number for a single unread", () => {
    expect(formatUnreadBadge(1)).toBe("1");
  });

  it("shows the exact number at the nine boundary", () => {
    expect(formatUnreadBadge(9)).toBe("9");
  });

  it("caps the badge at '9+' once above nine", () => {
    expect(formatUnreadBadge(10)).toBe("9+");
    expect(formatUnreadBadge(42)).toBe("9+");
  });
});
