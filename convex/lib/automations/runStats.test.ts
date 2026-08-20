import { expect, test } from "vitest";
import { summarizeRuns } from "./runStats";

const row = (status: string) => ({ status }) as never;

test("counts each status and totals enrolled", () => {
  expect(
    summarizeRuns([
      row("waiting"),
      row("waiting"),
      row("completed"),
      row("failed"),
      row("cancelled"),
      row("running"),
    ]),
  ).toEqual({
    enrolled: 6,
    waiting: 2,
    running: 1,
    completed: 1,
    failed: 1,
    cancelled: 1,
  });
});

test("an empty set is all zeroes, not undefined", () => {
  expect(summarizeRuns([])).toEqual({
    enrolled: 0,
    waiting: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  });
});

test("cancelled runs count toward enrolled — someone did enter the automation", () => {
  expect(summarizeRuns([row("cancelled")]).enrolled).toBe(1);
});

test("an unknown status is counted in enrolled but no bucket", () => {
  const out = summarizeRuns([row("weird")]);
  expect(out.enrolled).toBe(1);
  expect(out.waiting + out.running + out.completed + out.failed + out.cancelled).toBe(0);
});
