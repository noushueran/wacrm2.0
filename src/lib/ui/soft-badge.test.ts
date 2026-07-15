import { describe, it, expect } from "vitest";
import { softBadge } from "./soft-badge";

describe("softBadge", () => {
  it("emits both a base and a dark-mode text stop for hue tones", () => {
    for (const tone of [
      "success",
      "warning",
      "danger",
      "info",
      "amber",
      "cyan",
    ] as const) {
      const cls = softBadge(tone);
      expect(cls, tone).toMatch(/(?:^|\s)text-[a-z]+-\d+/); // a base text- utility
      expect(cls, tone).toMatch(/dark:text-[a-z]+-\d+/); // and a dark override
    }
  });

  it("uses a tinted background at low opacity", () => {
    expect(softBadge("warning")).toMatch(/bg-\S+\/10/);
  });

  it("accent and neutral use mode-correct theme tokens", () => {
    expect(softBadge("accent")).toContain("text-primary");
    expect(softBadge("neutral")).toContain("text-foreground");
  });
});
