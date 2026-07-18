import { describe, it, expect } from "vitest";
import { buildHandoffSummary } from "./handoff";

describe("buildHandoffSummary", () => {
  it("notes the reply count and quotes the last customer message", () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello! How can I help?" },
        { role: "user", content: "I want a refund" },
      ],
      replyCount: 2,
    });
    expect(summary).toBe(
      "🤖 AI agent handed off after 2 replies. Last customer message: “I want a refund”",
    );
  });

  it('uses the singular "reply" for a count of one', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: "user", content: "help" }],
      replyCount: 1,
    });
    expect(summary).toContain("after 1 reply.");
  });

  it('says "without replying" when the bot bailed on the first inbound', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: "user", content: "agent please" }],
      replyCount: 0,
    });
    expect(summary).toContain("handed off without replying.");
    expect(summary).toContain("“agent please”");
  });

  it("picks the most recent customer turn, ignoring assistant turns", () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: "user", content: "first" },
        { role: "user", content: "second" },
        { role: "assistant", content: "a reply" },
      ],
      replyCount: 1,
    });
    expect(summary).toContain("“second”");
  });

  it("collapses whitespace and truncates a long message", () => {
    const long = "x".repeat(300);
    const summary = buildHandoffSummary({
      messages: [{ role: "user", content: long }],
      replyCount: 0,
    });
    expect(summary).toContain("…");
    // 160-char cap on the quote; the whole note stays well under 250.
    expect(summary.length).toBeLessThan(250);
  });

  it("degrades gracefully when there is no customer message", () => {
    const summary = buildHandoffSummary({
      messages: [{ role: "assistant", content: "greeting" }],
      replyCount: 0,
    });
    expect(summary).toBe("🤖 AI agent handed off without replying.");
  });

  it('describes the reply-limit stop when reason is "cap"', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: "user", content: "when are you open?" },
        { role: "assistant", content: "10am to 9pm!" },
        { role: "user", content: "and my email is sam@example.com" },
      ],
      replyCount: 8,
      reason: "cap",
    });
    expect(summary).toBe(
      "🤖 AI agent reached its reply limit after 8 replies — a human needs to continue. " +
        "Last customer message: “and my email is sam@example.com”",
    );
  });

  it("cap reason still quotes nothing when there is no customer message", () => {
    const summary = buildHandoffSummary({
      messages: [{ role: "assistant", content: "greeting" }],
      replyCount: 3,
      reason: "cap",
    });
    expect(summary).toBe(
      "🤖 AI agent reached its reply limit after 3 replies — a human needs to continue.",
    );
  });
});
