import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey, hashApiKey } from "@/lib/api-keys/keys";
import { ApiError } from "@/lib/api/v1/respond";
import { __resetRateLimitForTests, RATE_LIMITS } from "@/lib/rate-limit";

// Mock the Convex HTTP client factory — `requireApiKey` calls
// `.query(api.apiKeys.resolveByHash, ...)` and (fire-and-forget)
// `.mutation(api.apiKeys.touchLastUsedByHash, ...)`. Tests control both
// return values directly rather than spinning up a real Convex backend.
// `api` itself is kept real (via `importOriginal`) — it's just
// `anyApi`, a Proxy that returns a valid function-reference-shaped
// value for any property path with no actual module resolution, so
// there's nothing meaningful to mock there.
const queryMock = vi.fn();
const mutationMock = vi.fn();
vi.mock("@/lib/convex/server-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/convex/server-client")>();
  return {
    ...actual,
    getConvexClient: () => ({ query: queryMock, mutation: mutationMock }),
  };
});

// Import AFTER the mock is registered.
const { requireApiKey } = await import("./api-context");

const KEY = generateApiKey().plaintext;

function reqWith(authHeader?: string): Request {
  return new Request("https://crm.example.com/api/v1/me", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function resolved(
  overrides: Partial<{ accountId: string; scopes: string[] }> = {}
) {
  return { accountId: "acct-1", scopes: ["messages:send"], ...overrides };
}

beforeEach(() => {
  __resetRateLimitForTests();
  queryMock.mockReset();
  mutationMock.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  __resetRateLimitForTests();
});

async function expectApiError(p: Promise<unknown>, code: string, status: number) {
  await expect(p).rejects.toBeInstanceOf(ApiError);
  await p.catch((e: unknown) => {
    const err = e as ApiError;
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });
}

describe("requireApiKey", () => {
  it("401s when no Authorization header is present", async () => {
    await expectApiError(requireApiKey(reqWith()), "unauthorized", 401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("401s on a token that doesn't look like a wacrm key", async () => {
    await expectApiError(
      requireApiKey(reqWith("Bearer some-invite-token")),
      "unauthorized",
      401,
    );
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("401s when the key is unknown / revoked / expired (Convex resolves null)", async () => {
    queryMock.mockResolvedValue(null);
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      "unauthorized",
      401,
    );
  });

  it("returns a context for a valid key with no scope required", async () => {
    queryMock.mockResolvedValue(resolved());
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`));
    expect(ctx.authType).toBe("api_key");
    expect(ctx.accountId).toBe("acct-1");
    expect(ctx.keyHash).toBe(hashApiKey(KEY));
    expect(ctx.scopes).toEqual(["messages:send"]);
    // The query is hashed, never the plaintext key.
    expect(queryMock).toHaveBeenCalledWith(expect.anything(), {
      keyHash: hashApiKey(KEY),
    });
    expect(mutationMock).toHaveBeenCalledWith(expect.anything(), {
      keyHash: hashApiKey(KEY),
    });
  });

  it("accepts a bare key without the 'Bearer ' prefix", async () => {
    queryMock.mockResolvedValue(resolved());
    const ctx = await requireApiKey(reqWith(KEY));
    expect(ctx.accountId).toBe("acct-1");
  });

  it("403s when the key lacks the required scope", async () => {
    queryMock.mockResolvedValue(resolved({ scopes: ["contacts:read"] }));
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`), "messages:send"),
      "forbidden",
      403,
    );
  });

  it("passes when the key has the required scope", async () => {
    queryMock.mockResolvedValue(resolved({ scopes: ["messages:send"] }));
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`), "messages:send");
    expect(ctx.accountId).toBe("acct-1");
  });

  it("429s once the per-key budget is exhausted", async () => {
    queryMock.mockResolvedValue(resolved());
    // Burn the whole window.
    for (let i = 0; i < RATE_LIMITS.publicApi.limit; i++) {
      await requireApiKey(reqWith(`Bearer ${KEY}`));
    }
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      "rate_limited",
      429,
    );
  });

  it("still returns a context when the best-effort lastUsedAt bump rejects", async () => {
    queryMock.mockResolvedValue(resolved());
    mutationMock.mockRejectedValue(new Error("network down"));
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`));
    expect(ctx.accountId).toBe("acct-1");
  });
});
