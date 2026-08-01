import { expect, test } from "vitest";
import { reasoningEffortFor } from "./reasoning";

// ------------------------------------------------------------
// reasoningEffortFor
//
// `max_completion_tokens` is ONE budget shared by reasoning tokens and
// the visible reply. Left unpinned, a reasoning-by-default model spends
// the whole budget thinking and returns a 200 with empty `content` —
// which `generateOpenAi` raises as an `empty_response` AiError. Verified
// against the live API on `gpt-5.4-mini`: at `max_completion_tokens: 320`
// with `reasoning_effort: "medium"`, `reasoning_tokens` came back 320 and
// `content` was zero-length.
//
// The return is a VALUE, not a boolean, because "none" is not universally
// accepted: the GPT-5.0 models predate it and bottom out at "minimal",
// and models that take no `reasoning_effort` at all must have it omitted
// rather than be sent a value they 400 on.
// ------------------------------------------------------------

test("reasoningEffortFor: GPT-5.1+ minors take 'none'", () => {
  expect(reasoningEffortFor("gpt-5.4-mini")).toBe("none");
  expect(reasoningEffortFor("gpt-5.1")).toBe("none");
  expect(reasoningEffortFor("gpt-5.6-mini")).toBe("none");
});

test("reasoningEffortFor: the GPT-5.0 family bottoms out at 'minimal' ('none' would 400)", () => {
  expect(reasoningEffortFor("gpt-5")).toBe("minimal");
  expect(reasoningEffortFor("gpt-5-mini")).toBe("minimal");
  expect(reasoningEffortFor("gpt-5-nano")).toBe("minimal");
});

test("reasoningEffortFor: null for models that reject the argument outright", () => {
  // Non-reasoning chat variants inside the gpt-5 namespace.
  expect(reasoningEffortFor("gpt-5-chat-latest")).toBeNull();
  // Older chat models.
  expect(reasoningEffortFor("gpt-4o")).toBeNull();
  expect(reasoningEffortFor("gpt-4o-mini")).toBeNull();
});

test("reasoningEffortFor: is not fooled by a longer major version", () => {
  // `gpt-50…` must not read as gpt-5.
  expect(reasoningEffortFor("gpt-50-turbo")).toBeNull();
});

test("reasoningEffortFor: tolerates casing and surrounding whitespace (aiConfigs.model is free text)", () => {
  expect(reasoningEffortFor("  GPT-5.4-Mini ")).toBe("none");
});
