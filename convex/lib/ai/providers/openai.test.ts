import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateOpenAi } from "./openai";
import { MAX_OUTPUT_TOKENS } from "../defaults";
import type { ProviderArgs } from "./shared";

// ============================================================
// Wire-level guard for the main auto-reply path. `max_completion_tokens`
// is a budget shared by reasoning tokens and the visible reply, so on a
// model that reasons by default the reply can come back EMPTY — a 200
// with `content: ""`, which `generateOpenAi` surfaces as an
// `empty_response` AiError and the customer sees as silence. Pinning
// `reasoning_effort` keeps the whole budget available for the reply.
// ============================================================

function args(overrides: Partial<ProviderArgs> = {}): ProviderArgs {
  return {
    apiKey: "sk-test",
    model: "gpt-5.4-mini",
    systemPrompt: "sys",
    messages: [{ role: "user", content: "Hi" }],
    timeoutMs: 30_000,
    ...overrides,
  };
}

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response;
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

function replyMock(content = "Sure — happy to help!") {
  const fetchMock = vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content } }] }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe("generateOpenAi — reasoning_effort on the wire", () => {
  it("sends reasoning_effort:'none' for the configured gpt-5.4-mini", async () => {
    const fetchMock = replyMock();

    await generateOpenAi(args({ model: "gpt-5.4-mini" }));

    const body = bodyOf(fetchMock);
    expect(body.reasoning_effort).toBe("none");
    expect(body.max_completion_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("pins it on GPT-5.6, which would otherwise default to medium and eat the budget", async () => {
    const fetchMock = replyMock();

    await generateOpenAi(args({ model: "gpt-5.6" }));

    expect(bodyOf(fetchMock).reasoning_effort).toBe("none");
  });

  it("downgrades to 'minimal' on GPT-5.0, which does not accept 'none'", async () => {
    const fetchMock = replyMock();

    await generateOpenAi(args({ model: "gpt-5-mini" }));

    expect(bodyOf(fetchMock).reasoning_effort).toBe("minimal");
  });

  it("omits the argument entirely on pre-GPT-5 models, which 400 on it", async () => {
    const fetchMock = replyMock();

    await generateOpenAi(args({ model: "gpt-4o-mini" }));

    const body = bodyOf(fetchMock);
    expect(body).not.toHaveProperty("reasoning_effort");
    // Everything else about the request is unchanged.
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.max_completion_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("still maps an empty completion to an empty_response AiError", async () => {
    replyMock("");
    await expect(generateOpenAi(args())).rejects.toMatchObject({ code: "empty_response" });
  });
});
