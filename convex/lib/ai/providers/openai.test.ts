import { expect, test } from "vitest";
import { buildOpenAiRequestBody } from "./openai";
import { MAX_OUTPUT_TOKENS, ANALYSIS_MAX_OUTPUT_TOKENS } from "../defaults";

// Pure-builder pinning, same approach as `whatsapp/metaApi.test.ts`: the
// exact wire shape sent to Chat Completions, without any fetch.
//
// Both fields pinned here were live production failures on
// `qualificationEngine.analyzeInbound`, reproduced against the real API
// on `gpt-5.4-mini`:
//
//   320 tokens + reasoning on   -> reasoning_tokens 320, content ""
//                                  => AiError "empty_response"
//   320 tokens + reasoning off  -> finish_reason "length", JSON cut
//                                  mid-object => parseAnalysis discards it
//
// The first is what surfaced in the logs; the second is what would have
// remained silently broken had only the first been fixed.

const BASE = {
  model: "gpt-5.4-mini",
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user" as const, content: "Hi" }],
};

test("buildOpenAiRequestBody: pins reasoning_effort on a reasoning-capable model", () => {
  const body = buildOpenAiRequestBody(BASE);
  expect(body.reasoning_effort).toBe("none");
});

test("buildOpenAiRequestBody: omits reasoning_effort where the model would 400 on it", () => {
  expect(
    buildOpenAiRequestBody({ ...BASE, model: "gpt-4o-mini" }),
  ).not.toHaveProperty("reasoning_effort");
  expect(
    buildOpenAiRequestBody({ ...BASE, model: "gpt-5-chat-latest" }),
  ).not.toHaveProperty("reasoning_effort");
});

test("buildOpenAiRequestBody: GPT-5.0 gets 'minimal', which is its floor", () => {
  expect(buildOpenAiRequestBody({ ...BASE, model: "gpt-5-mini" }).reasoning_effort).toBe(
    "minimal",
  );
});

test("buildOpenAiRequestBody: defaults to the WhatsApp-reply token cap", () => {
  expect(buildOpenAiRequestBody(BASE).max_completion_tokens).toBe(MAX_OUTPUT_TOKENS);
});

test("buildOpenAiRequestBody: honours a per-call token override", () => {
  expect(
    buildOpenAiRequestBody({ ...BASE, maxTokens: ANALYSIS_MAX_OUTPUT_TOKENS })
      .max_completion_tokens,
  ).toBe(ANALYSIS_MAX_OUTPUT_TOKENS);
});

test("ANALYSIS_MAX_OUTPUT_TOKENS clears the measured requirement of the analysis JSON", () => {
  // A real 7-turn conversation against a two-service checklist needed 404
  // completion tokens for the complete object; 320 truncated it.
  expect(ANALYSIS_MAX_OUTPUT_TOKENS).toBeGreaterThan(404);
  expect(MAX_OUTPUT_TOKENS).toBeLessThan(404); // documents why the override exists
});

test("buildOpenAiRequestBody: keeps the system prompt first, then the turns", () => {
  const body = buildOpenAiRequestBody(BASE);
  expect(body.messages).toEqual([
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hi" },
  ]);
});
