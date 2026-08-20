import { describe, expect, it } from "vitest";

import { silenceLabel } from "./lead-analysis-filter";

describe("silenceLabel", () => {
  it("reports today for a same-day lead", () => {
    expect(silenceLabel(0)).toEqual({ kind: "today" });
  });

  it("reports today when the timestamp is missing", () => {
    expect(silenceLabel(null)).toEqual({ kind: "today" });
  });

  it("reports the day count once the lead is stale", () => {
    expect(silenceLabel(6)).toEqual({ kind: "days", days: 6 });
  });
});
