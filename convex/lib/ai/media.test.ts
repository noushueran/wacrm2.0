import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  describeImageFromUrl,
  reasoningEffortFor,
  supportsReasoningEffort,
  DESCRIBE_FALLBACK_MODEL,
} from "./media";

// ============================================================
// `reasoning_effort` is the load-bearing bit here. Reasoning tokens are
// billed as output tokens and are drawn from the SAME budget as the
// visible reply (`max_completion_tokens`), so a model that reasons by
// default can burn the whole budget and return EMPTY content — a
// success-shaped 200 with nothing in it. These tests pin what actually
// goes out on the wire so a model-string edit can't silently
// reintroduce that.
// ============================================================

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response;
}

/** Body of the Nth fetch call, parsed. */
function bodyOf(fetchMock: ReturnType<typeof vi.fn>, n = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[n][1].body);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("reasoningEffortFor", () => {
  it("asks for no reasoning on GPT-5.1-and-later, which accept 'none'", () => {
    expect(reasoningEffortFor("gpt-5.4-mini")).toBe("none");
    expect(reasoningEffortFor("gpt-5.1")).toBe("none");
    expect(reasoningEffortFor("gpt-5.6")).toBe("none");
    expect(reasoningEffortFor("gpt-5.6-sol")).toBe("none");
    expect(reasoningEffortFor("gpt-5.10")).toBe("none");
  });

  it("falls back to 'minimal' on the GPT-5.0 family, which predates 'none'", () => {
    // Sending "none" to these would be a 400 — the exact failure the
    // gate exists to prevent.
    expect(reasoningEffortFor("gpt-5")).toBe("minimal");
    expect(reasoningEffortFor("gpt-5-mini")).toBe("minimal");
    expect(reasoningEffortFor("gpt-5-nano")).toBe("minimal");
  });

  it("omits the argument for models that would reject it", () => {
    // Non-reasoning chat variant inside the GPT-5 family.
    expect(reasoningEffortFor("gpt-5-chat-latest")).toBeNull();
    // Pre-GPT-5 models — including the vision fallback.
    expect(reasoningEffortFor("gpt-4o")).toBeNull();
    expect(reasoningEffortFor(DESCRIBE_FALLBACK_MODEL)).toBeNull();
    // Unknown / o-series: stay conservative rather than risk a 400.
    expect(reasoningEffortFor("o3-mini")).toBeNull();
    expect(reasoningEffortFor("gpt-test")).toBeNull();
    expect(reasoningEffortFor("")).toBeNull();
  });

  it("is case- and whitespace-insensitive, and does not match gpt-50", () => {
    expect(reasoningEffortFor("  GPT-5.4-Mini  ")).toBe("none");
    expect(reasoningEffortFor("gpt-50-turbo")).toBeNull();
  });

  it("supportsReasoningEffort mirrors it as a boolean gate", () => {
    expect(supportsReasoningEffort("gpt-5.4-mini")).toBe(true);
    expect(supportsReasoningEffort("gpt-5-mini")).toBe(true);
    expect(supportsReasoningEffort(DESCRIBE_FALLBACK_MODEL)).toBe(false);
    expect(supportsReasoningEffort("gpt-5-chat-latest")).toBe(false);
  });
});

describe("describeImageFromUrl — wire payload", () => {
  const base = { apiKey: "sk-test", mediaUrl: "https://example.com/a.jpg" };

  it("pins reasoning_effort off so the 150-token budget is all description", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: "A beach." } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const out = await describeImageFromUrl({ ...base, model: "gpt-5.4-mini" });

    expect(out).toBe("A beach.");
    const body = bodyOf(fetchMock);
    expect(body.reasoning_effort).toBe("none");
    expect(body.max_completion_tokens).toBe(150);
    expect(body.model).toBe("gpt-5.4-mini");
  });

  it("omits reasoning_effort on the gpt-4o-mini vision fallback", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: "A passport." } }] }));
    vi.stubGlobal("fetch", fetchMock);

    await describeImageFromUrl({ ...base, model: DESCRIBE_FALLBACK_MODEL });

    expect(bodyOf(fetchMock)).not.toHaveProperty("reasoning_effort");
  });

  it("still returns null (never throws) when the model yields empty content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: "" } }] })),
    );
    await expect(describeImageFromUrl({ ...base, model: "gpt-5.4-mini" })).resolves.toBeNull();
  });
});
