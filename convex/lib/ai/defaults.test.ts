import { expect, test } from "vitest";
import { buildSystemPrompt } from "./defaults";

test("buildSystemPrompt renders the qualification objectives block in auto_reply mode", () => {
  const prompt = buildSystemPrompt({
    userPrompt: "Be friendly.",
    mode: "auto_reply",
    qualification: {
      collected: [{ label: "Destination", value: "Bali" }],
      nextQuestion: "When are you planning to travel?",
    },
  });
  expect(prompt).toContain("Lead qualification objective");
  expect(prompt).toContain("Destination: Bali");
  expect(prompt).toContain("never re-ask");
  expect(prompt).toContain("When are you planning to travel?");
});

test("buildSystemPrompt omits the block without the arg, without a next question stays quiet about asking, and never renders it in draft mode", () => {
  expect(
    buildSystemPrompt({ userPrompt: null, mode: "auto_reply" }),
  ).not.toContain("Lead qualification objective");

  const noQuestion = buildSystemPrompt({
    userPrompt: null,
    mode: "auto_reply",
    qualification: { collected: [{ label: "Email", value: "a@b.com" }], nextQuestion: null },
  });
  expect(noQuestion).toContain("Email: a@b.com");
  expect(noQuestion).not.toContain("weave in exactly ONE question");

  expect(
    buildSystemPrompt({
      userPrompt: null,
      mode: "draft",
      qualification: { collected: [], nextQuestion: "Q?" },
    }),
  ).not.toContain("Lead qualification objective");
});

test("auto_reply prompt teaches the ask-admin protocol instead of handoff-on-unknown; draft does not", () => {
  const auto = buildSystemPrompt({ userPrompt: null, mode: "auto_reply" });
  expect(auto).toContain("ASK_ADMIN");
  expect(auto).toContain("check with");
  const draft = buildSystemPrompt({ userPrompt: null, mode: "draft" });
  expect(draft).not.toContain("ASK_ADMIN");
});
