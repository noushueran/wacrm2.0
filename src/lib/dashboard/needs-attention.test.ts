import { describe, it, expect } from "vitest";
import { selectWaiting, formatWaiting } from "./needs-attention";

const row = (id: string, unread: number, at?: number) => ({
  _id: id,
  unreadCount: unread,
  lastMessageAt: at,
  contact: null,
});

describe("selectWaiting", () => {
  it("drops read conversations and sorts oldest-waiting first", () => {
    const out = selectWaiting([row("a", 0, 5), row("b", 3, 100), row("c", 2, 50)]);
    expect(out.map((r) => r._id)).toEqual(["c", "b"]);
  });

  it("keeps undefined lastMessageAt but sorts it last", () => {
    const out = selectWaiting([row("a", 1, undefined), row("b", 1, 10)]);
    expect(out.map((r) => r._id)).toEqual(["b", "a"]);
  });
});

describe("formatWaiting", () => {
  const now = 10_000_000;
  it("formats hours+minutes, bare hours, minutes, days, and empty", () => {
    expect(formatWaiting(now - (2 * 3600 + 14 * 60) * 1000, now)).toBe("2h 14m");
    expect(formatWaiting(now - 3 * 3600 * 1000, now)).toBe("3h");
    expect(formatWaiting(now - 48 * 60 * 1000, now)).toBe("48m");
    expect(formatWaiting(now - 3 * 86400 * 1000, now)).toBe("3d");
    expect(formatWaiting(undefined, now)).toBe("");
  });
});
