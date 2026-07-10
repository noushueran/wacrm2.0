import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

// ---------------------------------------------------------------------------
// Tests for the thinned webhook proxy (Phase 8, Task 4b). This route no
// longer parses Meta's payload itself — it only (a) verifies Meta's
// signature on POST, and (b) forwards to the Convex httpAction
// (`convex/http.ts`) with a shared-secret header, relaying the response
// back. `verifyMetaWebhookSignature` itself is exercised in
// `src/lib/whatsapp/webhook-signature.test.ts`; these tests focus on the
// proxy behavior: what gets forwarded, with what headers, and what comes
// back to the caller (Meta) in each case.
// ---------------------------------------------------------------------------

const META_APP_SECRET = process.env.META_APP_SECRET!;
const SITE_URL = "https://convex-site.example.test";
const PROXY_SECRET = "test-proxy-secret";

function signedHeader(body: string): string {
  const hex = crypto
    .createHmac("sha256", META_APP_SECRET)
    .update(body)
    .digest("hex");
  return `sha256=${hex}`;
}

let originalSiteUrl: string | undefined;
let originalProxySecret: string | undefined;

beforeEach(() => {
  originalSiteUrl = process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  originalProxySecret = process.env.WEBHOOK_PROXY_SECRET;
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL = SITE_URL;
  process.env.WEBHOOK_PROXY_SECRET = PROXY_SECRET;
});

afterEach(() => {
  if (originalSiteUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
  else process.env.NEXT_PUBLIC_CONVEX_SITE_URL = originalSiteUrl;
  if (originalProxySecret === undefined) delete process.env.WEBHOOK_PROXY_SECRET;
  else process.env.WEBHOOK_PROXY_SECRET = originalProxySecret;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/whatsapp/webhook (thin proxy)", () => {
  it("rejects a request with an invalid signature and never calls Convex", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const body = JSON.stringify({ entry: [] });
    const res = await POST(
      new Request("http://localhost/api/whatsapp/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=deadbeef" },
        body,
      }),
    );

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the exact raw body to the Convex httpAction with the shared-secret header, and acks 200", async () => {
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ status: "received" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const rawBody = JSON.stringify({ entry: [{ id: "waba-1", changes: [] }] });
    const res = await POST(
      new Request("http://localhost/api/whatsapp/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": signedHeader(rawBody) },
        body: rawBody,
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "received" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0];
    expect(target).toBe(`${SITE_URL}/whatsapp/ingest`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(rawBody);
    expect((init?.headers as Record<string, string>)["x-wacrm-proxy-secret"]).toBe(
      PROXY_SECRET,
    );
  });

  it("still acks 200 to Meta even when the Convex httpAction is unreachable (fetch throws)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const rawBody = JSON.stringify({ entry: [] });
    const res = await POST(
      new Request("http://localhost/api/whatsapp/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": signedHeader(rawBody) },
        body: rawBody,
      }),
    );

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("still acks 200 to Meta even when Convex itself responds with an error status", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Unauthorized", { status: 401 })),
    );

    const rawBody = JSON.stringify({ entry: [] });
    const res = await POST(
      new Request("http://localhost/api/whatsapp/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": signedHeader(rawBody) },
        body: rawBody,
      }),
    );

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("GET /api/whatsapp/webhook (thin proxy)", () => {
  it("relays hub.mode/challenge/verify_token to Convex's GET httpAction and returns its challenge response", async () => {
    const fetchMock = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response("CHALLENGE123", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(
      new Request(
        "http://localhost/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=CHALLENGE123&hub.verify_token=mytoken",
      ),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("CHALLENGE123");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0];
    expect(target.toString()).toBe(
      `${SITE_URL}/whatsapp/webhook?hub.mode=subscribe&hub.challenge=CHALLENGE123&hub.verify_token=mytoken`,
    );
    expect((init?.headers as Record<string, string>)["x-wacrm-proxy-secret"]).toBe(
      PROXY_SECRET,
    );
  });

  it("relays a token-mismatch 403 from Convex as-is", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Verification token mismatch", { status: 403 })),
    );

    const res = await GET(
      new Request(
        "http://localhost/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=wrong",
      ),
    );

    expect(res.status).toBe(403);
  });

  it("500s when NEXT_PUBLIC_CONVEX_SITE_URL is not configured", async () => {
    delete process.env.NEXT_PUBLIC_CONVEX_SITE_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await GET(
      new Request(
        "http://localhost/api/whatsapp/webhook?hub.mode=subscribe&hub.challenge=abc&hub.verify_token=x",
      ),
    );

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
