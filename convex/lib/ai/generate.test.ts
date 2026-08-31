import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateReply, parseGeneration } from "./generate";
import { AiError } from "./types";
import type { GenerateArgs } from "./generate";

function args(overrides: Partial<GenerateArgs> = {}): GenerateArgs {
  return {
    provider: "openai",
    model: "gpt-test",
    apiKey: "sk-test",
    systemPrompt: "sys",
    messages: [{ role: "user", content: "Hi" }],
    ...overrides,
  };
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response;
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("parseGeneration", () => {
  it("returns text with no handoff", () => {
    expect(parseGeneration("Hello there")).toEqual({
      text: "Hello there",
      handoff: false,
      askAdmin: null,
      usage: null,
    });
  });

  it("detects + strips the handoff sentinel", () => {
    expect(parseGeneration("[[HANDOFF]]")).toEqual({
      text: "",
      handoff: true,
      askAdmin: null,
      usage: null,
    });
    expect(parseGeneration("Let me get a human [[HANDOFF]]")).toEqual({
      text: "Let me get a human",
      handoff: true,
      askAdmin: null,
      usage: null,
    });
  });

  it("passes usage straight through", () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    expect(parseGeneration("Hi", usage)).toEqual({
      text: "Hi",
      handoff: false,
      askAdmin: null,
      usage,
    });
  });
});

describe("generateReply — OpenAI", () => {
  it("calls the chat completions endpoint and returns the reply", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: "Sure — happy to help!" } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateReply(args({ provider: "openai" }));

    expect(res).toEqual({
      text: "Sure — happy to help!",
      handoff: false,
      askAdmin: null,
      usage: {
        promptTokens: 42,
        completionTokens: 8,
        totalTokens: 50,
        // Neither block was present on this stubbed response, so both
        // normalize to 0 rather than being dropped.
        cachedPromptTokens: 0,
        reasoningTokens: 0,
      },
    });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("api.openai.com");
    expect(opts.headers.Authorization).toBe("Bearer sk-test");
  });

  it("maps a 401 to an invalid_key AiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(errResponse(401, { error: { message: "Incorrect API key" } })),
    );

    await expect(generateReply(args())).rejects.toMatchObject({
      code: "invalid_key",
      status: 401,
    });
  });

  it("throws on an empty completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: "" } }] })),
    );
    await expect(generateReply(args())).rejects.toBeInstanceOf(AiError);
  });
});

describe("generateReply — Anthropic", () => {
  it("calls the messages endpoint with the version header and parses text blocks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: "text", text: "Hi there!" }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateReply(args({ provider: "anthropic", apiKey: "sk-ant-x" }));

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: "Hi there!",
      handoff: false,
      askAdmin: null,
      usage: {
        promptTokens: 30,
        completionTokens: 6,
        totalTokens: 36,
        cachedPromptTokens: 0,
        reasoningTokens: 0,
      },
    });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain("api.anthropic.com");
    expect(opts.headers["x-api-key"]).toBe("sk-ant-x");
    expect(opts.headers["anthropic-version"]).toBeTruthy();
  });

  it("detects handoff in the model output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(okResponse({ content: [{ type: "text", text: "[[HANDOFF]]" }] })),
    );
    const res = await generateReply(
      args({ provider: "anthropic", messages: [{ role: "user", content: "I want to speak to a person" }] }),
    );
    expect(res.handoff).toBe(true);
    expect(res.text).toBe("");
  });

  it("drops a leading assistant turn so the payload starts on the customer", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ content: [{ type: "text", text: "ok" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await generateReply(
      args({
        provider: "anthropic",
        messages: [
          { role: "assistant", content: "Welcome!" },
          { role: "user", content: "Hi" },
        ],
      }),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages).toHaveLength(1);
  });
});

// ---- qualification v3: ask-admin marker ----

describe("parseGeneration ask-admin marker", () => {
  it("extracts the ASK_ADMIN question and strips the marker", () => {
    const out = parseGeneration(
      "Let me check with my team and get back to you shortly! [[ASK_ADMIN: What is the Georgia visa fee for Indian nationals?]]",
    );
    expect(out.askAdmin).toBe("What is the Georgia visa fee for Indian nationals?");
    expect(out.text).toBe("Let me check with my team and get back to you shortly!");
    expect(out.handoff).toBe(false);
  });

  it("a legacy handoff marker no longer suppresses ask-admin (handoff is manual-only); absent marker yields null", () => {
    const both = parseGeneration("[[HANDOFF]] [[ASK_ADMIN: x?]]");
    expect(both.handoff).toBe(true); // still reported; dispatch ignores it
    expect(both.askAdmin).toBe("x?"); // the open question must not be lost
    expect(parseGeneration("plain reply").askAdmin).toBeNull();
  });
});

// ------------------------------------------------------------
// Token-spend controls (audit 2026-07-27) — wire-level. These assert on
// the request BODY and the parsed usage, because the whole optimisation
// is invisible in the return value.
// ------------------------------------------------------------

describe("reasoning effort + usage telemetry (OpenAI)", () => {
  function chatOk(extra: Record<string, unknown> = {}) {
    return okResponse({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, ...extra },
    });
  }

  it("omits reasoning_effort entirely when the caller asks for none of it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatOk());
    vi.stubGlobal("fetch", fetchMock);

    await generateReply(args());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("reasoning_effort");
    // The flat visible-reply budget, unchanged from before this shipped.
    expect(body.max_completion_tokens).toBe(320);
  });

  it("sends reasoning_effort and widens the output budget when asked to reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatOk());
    vi.stubGlobal("fetch", fetchMock);

    await generateReply(args({ model: "gpt-5.6-terra", reasoningEffort: "low" }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBe("low");
    // Reasoning shares this budget with the visible reply — see
    // `maxOutputTokensFor`. Without the headroom the model can spend the
    // whole allowance thinking and return empty content.
    expect(body.max_completion_tokens).toBeGreaterThan(320);
  });

  it("never sends reasoning_effort to a model that would reject it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatOk());
    vi.stubGlobal("fetch", fetchMock);

    await generateReply(args({ model: "gpt-4o-mini", reasoningEffort: "low" }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("reasoning_effort");
    // The budget follows the EFFECTIVE effort, not the requested one:
    // this model will not reason, so it gets no headroom.
    expect(body.max_completion_tokens).toBe(320);
  });

  it("records cached prompt tokens and reasoning tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        chatOk({
          prompt_tokens_details: { cached_tokens: 90 },
          completion_tokens_details: { reasoning_tokens: 4 },
        }),
      ),
    );

    const res = await generateReply(args());

    // Cached tokens are a SUBSET of prompt tokens, not additional to
    // them — this is the number that tells us whether the big static
    // prefix is actually hitting the provider's cache.
    expect(res.usage?.promptTokens).toBe(100);
    expect(res.usage?.cachedPromptTokens).toBe(90);
    expect(res.usage?.reasoningTokens).toBe(4);
  });

  it("clamps a nonsensical cached count to the prompt total", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        chatOk({ prompt_tokens_details: { cached_tokens: 999_999 } }),
      ),
    );

    // Otherwise the usage page's hit rate would read far above 100%.
    const res = await generateReply(args());
    expect(res.usage?.cachedPromptTokens).toBe(100);
  });
});

describe("cache accounting (Anthropic)", () => {
  it("folds cache reads and writes into the prompt total", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okResponse({
          content: [{ type: "text", text: "Hi" }],
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 5,
            output_tokens: 6,
          },
        }),
      ),
    );

    const res = await generateReply(args({ provider: "anthropic" }));

    // Anthropic reports `input_tokens` NET of cache, unlike OpenAI —
    // summing restores the subset invariant the clamp relies on.
    expect(res.usage?.promptTokens).toBe(95);
    expect(res.usage?.cachedPromptTokens).toBe(80);
  });
});

describe("prompt_cache_key (cache routing)", () => {
  function chatOk() {
    return okResponse({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 4000, completion_tokens: 20, total_tokens: 4020 },
    });
  }

  it("sends the routing key when the caller supplies one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatOk());
    vi.stubGlobal("fetch", fetchMock);

    await generateReply(args({ promptCacheKey: "acct123:reply" }));

    // Without this, requests sharing a prefix scatter across cache shards
    // and miss — measured at a 6% hit rate on a ~3.9k-token static prefix.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.prompt_cache_key).toBe("acct123:reply");
  });

  it("omits it entirely when absent, leaving the body byte-identical", async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatOk());
    vi.stubGlobal("fetch", fetchMock);

    await generateReply(args());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("prompt_cache_key");
  });

  it("is not sent to Anthropic, which caches by explicit breakpoints instead", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: "text", text: "Hi" }],
        usage: { input_tokens: 10, output_tokens: 6 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateReply(args({ provider: "anthropic", promptCacheKey: "acct123:reply" }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("prompt_cache_key");
  });
});
