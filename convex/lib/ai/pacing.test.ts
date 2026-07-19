import { describe, expect, it } from "vitest";
import { classifyMessageShape, debounceMsForText, deliveryDelayMs } from "./pacing";

describe("classifyMessageShape", () => {
  it("treats terminal punctuation as a finished thought", () => {
    expect(classifyMessageShape("how much?")).toBe("complete");
    expect(classifyMessageShape("Book it.")).toBe("complete");
    expect(classifyMessageShape("Great!")).toBe("complete");
  });

  it("recognises non-Latin terminal punctuation", () => {
    expect(classifyMessageShape("كم السعر؟")).toBe("complete");
    expect(classifyMessageShape("多少钱。")).toBe("complete");
  });

  it("treats long unpunctuated text as a finished thought", () => {
    expect(
      classifyMessageShape("I am looking for a family package for August"),
    ).toBe("complete");
  });

  it("treats short unpunctuated text as a fragment", () => {
    expect(classifyMessageShape("hi")).toBe("fragment");
    expect(classifyMessageShape("how much")).toBe("fragment");
    expect(classifyMessageShape("good morning")).toBe("fragment");
  });

  it("treats mid-length unpunctuated text as neutral", () => {
    expect(classifyMessageShape("what packages do you have")).toBe("neutral");
  });

  it("treats empty, whitespace, and absent text as neutral", () => {
    expect(classifyMessageShape("")).toBe("neutral");
    expect(classifyMessageShape("   ")).toBe("neutral");
    expect(classifyMessageShape(null)).toBe("neutral");
    expect(classifyMessageShape(undefined)).toBe("neutral");
  });

  it("ignores surrounding whitespace when classifying", () => {
    expect(classifyMessageShape("  hi  ")).toBe("fragment");
    expect(classifyMessageShape("  how much?  ")).toBe("complete");
  });
});

describe("debounceMsForText", () => {
  it("waits least for a finished thought", () => {
    expect(debounceMsForText("how much?")).toBe(2_000);
  });

  it("waits longest for a fragment", () => {
    expect(debounceMsForText("hi")).toBe(6_000);
  });

  it("falls back to the base window otherwise", () => {
    expect(debounceMsForText("what packages do you have")).toBe(3_000);
    expect(debounceMsForText(null)).toBe(3_000);
  });
});

describe("deliveryDelayMs", () => {
  // random() === 0.5 → jitter factor exactly 1.0, isolating the base maths.
  const noJitter = () => 0.5;

  it("floors a very short reply at the minimum", () => {
    expect(
      deliveryDelayMs({ replyLength: 18, elapsedMs: 0, random: noJitter }),
    ).toBe(3_000);
  });

  it("scales with reply length between the bounds", () => {
    // 180 chars / 18 chars-per-sec = 10s
    expect(
      deliveryDelayMs({ replyLength: 180, elapsedMs: 0, random: noJitter }),
    ).toBe(10_000);
  });

  it("caps a long reply at the maximum, staying under Meta's 25s ceiling", () => {
    expect(
      deliveryDelayMs({ replyLength: 5_000, elapsedMs: 0, random: noJitter }),
    ).toBe(15_000);
  });

  it("subtracts time already elapsed since the inbound arrived", () => {
    expect(
      deliveryDelayMs({ replyLength: 180, elapsedMs: 4_000, random: noJitter }),
    ).toBe(6_000);
  });

  it("returns 0 when generation already outran the target", () => {
    expect(
      deliveryDelayMs({ replyLength: 180, elapsedMs: 12_000, random: noJitter }),
    ).toBe(0);
  });

  it("never returns a negative delay", () => {
    expect(
      deliveryDelayMs({ replyLength: 10, elapsedMs: 99_000, random: noJitter }),
    ).toBe(0);
  });

  it("applies jitter within +/-25% of the base", () => {
    const low = deliveryDelayMs({ replyLength: 180, elapsedMs: 0, random: () => 0 });
    const high = deliveryDelayMs({
      replyLength: 180,
      elapsedMs: 0,
      random: () => 0.999999,
    });
    expect(low).toBe(7_500); // 10s * 0.75
    expect(high).toBeGreaterThan(12_400); // ~10s * 1.25
    expect(high).toBeLessThanOrEqual(12_500);
  });

  it("treats a negative reply length as zero rather than a negative delay", () => {
    expect(
      deliveryDelayMs({ replyLength: -50, elapsedMs: 0, random: noJitter }),
    ).toBe(3_000);
  });
});
