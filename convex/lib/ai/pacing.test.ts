import { describe, expect, it, afterEach } from "vitest";
import { classifyMessageShape, debounceMsForText, deliveryDelayMs } from "./pacing";

// Preserve original env values for cleanup
const origDebounceMs = process.env.AI_REPLY_DEBOUNCE_MS;
const origDebounceFastMs = process.env.AI_REPLY_DEBOUNCE_FAST_MS;
const origDebounceSlowMs = process.env.AI_REPLY_DEBOUNCE_SLOW_MS;
const origTypingCharsPerSec = process.env.AI_TYPING_CHARS_PER_SEC;
const origTypingMinMs = process.env.AI_TYPING_MIN_MS;
const origTypingMaxMs = process.env.AI_TYPING_MAX_MS;

afterEach(() => {
  // Restore all env vars to their original state
  if (origDebounceMs === undefined) delete process.env.AI_REPLY_DEBOUNCE_MS;
  else process.env.AI_REPLY_DEBOUNCE_MS = origDebounceMs;

  if (origDebounceFastMs === undefined) delete process.env.AI_REPLY_DEBOUNCE_FAST_MS;
  else process.env.AI_REPLY_DEBOUNCE_FAST_MS = origDebounceFastMs;

  if (origDebounceSlowMs === undefined) delete process.env.AI_REPLY_DEBOUNCE_SLOW_MS;
  else process.env.AI_REPLY_DEBOUNCE_SLOW_MS = origDebounceSlowMs;

  if (origTypingCharsPerSec === undefined) delete process.env.AI_TYPING_CHARS_PER_SEC;
  else process.env.AI_TYPING_CHARS_PER_SEC = origTypingCharsPerSec;

  if (origTypingMinMs === undefined) delete process.env.AI_TYPING_MIN_MS;
  else process.env.AI_TYPING_MIN_MS = origTypingMinMs;

  if (origTypingMaxMs === undefined) delete process.env.AI_TYPING_MAX_MS;
  else process.env.AI_TYPING_MAX_MS = origTypingMaxMs;
});

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

  it("pins exact threshold boundaries", () => {
    // Exactly 15 characters should classify as neutral (not fragment)
    const exactly15 = "abcdefghijklmno";
    expect(exactly15).toHaveLength(15);
    expect(classifyMessageShape(exactly15)).toBe("neutral");

    // Exactly 40 characters should classify as neutral (not complete)
    const exactly40 = "abcdefghijklmnopqrstuvwxyzabcdefghijklmn";
    expect(exactly40).toHaveLength(40);
    expect(classifyMessageShape(exactly40)).toBe("neutral");
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

  describe("kill switch and env overrides", () => {
    it("respects AI_REPLY_DEBOUNCE_MS=0 as a kill switch for all shape tiers", () => {
      process.env.AI_REPLY_DEBOUNCE_MS = "0";
      // All three shape tiers should return 0, not their normal debounce times
      expect(debounceMsForText("how much?")).toBe(0); // complete normally 2_000
      expect(debounceMsForText("hi")).toBe(0); // fragment normally 6_000
      expect(debounceMsForText("what packages do you have")).toBe(0); // neutral normally 3_000
    });

    it("honours AI_REPLY_DEBOUNCE_FAST_MS override for complete-shaped messages", () => {
      process.env.AI_REPLY_DEBOUNCE_FAST_MS = "1500";
      expect(debounceMsForText("how much?")).toBe(1_500);
    });

    it("honours AI_REPLY_DEBOUNCE_SLOW_MS override for fragment-shaped messages", () => {
      process.env.AI_REPLY_DEBOUNCE_SLOW_MS = "7500";
      expect(debounceMsForText("hi")).toBe(7_500);
    });

    it("honours AI_REPLY_DEBOUNCE_MS override for neutral-shaped messages", () => {
      process.env.AI_REPLY_DEBOUNCE_MS = "4000";
      expect(debounceMsForText("what packages do you have")).toBe(4_000);
    });

    it("falls back to default when env value is malformed (banana)", () => {
      process.env.AI_REPLY_DEBOUNCE_MS = "banana";
      expect(debounceMsForText("what packages do you have")).toBe(3_000); // default
    });

    it("falls back to default when env value is negative", () => {
      process.env.AI_REPLY_DEBOUNCE_MS = "-5";
      expect(debounceMsForText("what packages do you have")).toBe(3_000); // default
    });
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

  describe("env variable overrides and hardening", () => {
    it("honours AI_TYPING_MIN_MS override", () => {
      process.env.AI_TYPING_MIN_MS = "5000";
      expect(
        deliveryDelayMs({ replyLength: 18, elapsedMs: 0, random: noJitter }),
      ).toBe(5_000);
    });

    it("honours AI_TYPING_CHARS_PER_SEC override", () => {
      process.env.AI_TYPING_CHARS_PER_SEC = "36";
      // 180 chars / 36 chars-per-sec = 5s
      expect(
        deliveryDelayMs({ replyLength: 180, elapsedMs: 0, random: noJitter }),
      ).toBe(5_000);
    });

    it("clamps AI_TYPING_MAX_MS to the hardcoded ceiling (prevents operator misconfiguration)", () => {
      // Try to set max to 30s, which exceeds Meta's auto-dismiss at 25s.
      // The module should clamp this to 20s ceiling to prevent silent failures.
      process.env.AI_TYPING_MAX_MS = "30000";
      const result = deliveryDelayMs({
        replyLength: 5_000,
        elapsedMs: 0,
        random: noJitter,
      });
      // Should be clamped to 20s ceiling, not 30s
      expect(result).toBeLessThanOrEqual(20_000);
    });

    it("falls back to default when AI_TYPING_MIN_MS is malformed", () => {
      process.env.AI_TYPING_MIN_MS = "not_a_number";
      expect(
        deliveryDelayMs({ replyLength: 18, elapsedMs: 0, random: noJitter }),
      ).toBe(3_000); // default minimum
    });

    it("falls back to default when AI_TYPING_MIN_MS is negative", () => {
      process.env.AI_TYPING_MIN_MS = "-1000";
      expect(
        deliveryDelayMs({ replyLength: 18, elapsedMs: 0, random: noJitter }),
      ).toBe(3_000); // default minimum
    });
  });
});
