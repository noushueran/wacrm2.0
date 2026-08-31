import { expect, test } from "vitest";
import { comparePriority, leadLane, type PriorityInput } from "./priority";

test("a customer's last message means they are awaiting us", () => {
  expect(leadLane("customer")).toBe("awaiting_us");
});

test("our last message — agent or bot — means we are awaiting them", () => {
  expect(leadLane("agent")).toBe("awaiting_them");
  expect(leadLane("bot")).toBe("awaiting_them");
});

test("a thread with no messages is treated as awaiting us", () => {
  expect(leadLane(null)).toBe("awaiting_us");
});

const row = (p: Partial<PriorityInput>): PriorityInput => ({
  score: 5,
  lane: "awaiting_them",
  lastMessageAt: 1000,
  ...p,
});

test("higher score sorts first", () => {
  expect(comparePriority(row({ score: 9 }), row({ score: 4 }))).toBeLessThan(0);
});

test("an unscored lead sorts after every scored lead", () => {
  expect(comparePriority(row({ score: null }), row({ score: 1 }))).toBeGreaterThan(0);
});

test("at equal score, awaiting-us sorts before awaiting-them", () => {
  const us = row({ lane: "awaiting_us" });
  const them = row({ lane: "awaiting_them" });
  expect(comparePriority(us, them)).toBeLessThan(0);
});

test("at equal score and lane, the more recent sorts first", () => {
  const newer = row({ lastMessageAt: 5000 });
  const older = row({ lastMessageAt: 1000 });
  expect(comparePriority(newer, older)).toBeLessThan(0);
});

test("a null lastMessageAt sorts last within its group", () => {
  expect(comparePriority(row({ lastMessageAt: null }), row({ lastMessageAt: 1 })))
    .toBeGreaterThan(0);
});

test("sorting a mixed list produces the documented order", () => {
  const rows: (PriorityInput & { id: string })[] = [
    { id: "cold-old", score: 2, lane: "awaiting_them", lastMessageAt: 10 },
    { id: "hot-waiting", score: 9, lane: "awaiting_us", lastMessageAt: 10 },
    { id: "hot-quiet", score: 9, lane: "awaiting_them", lastMessageAt: 99 },
    { id: "unscored", score: null, lane: "awaiting_us", lastMessageAt: 99 },
  ];
  const order = [...rows].sort(comparePriority).map((r) => r.id);
  expect(order).toEqual(["hot-waiting", "hot-quiet", "cold-old", "unscored"]);
});
