/// <reference types="vite/client" />
import { expect, test, afterEach } from "vitest";
import { verifyPhoneNumber, downloadMedia, getMediaUrl } from "./metaApi";

// ============================================================
// metaApi — every outbound call to Meta must carry an abort timeout.
//
// This module is the shared client for *every* Meta Graph call the app
// makes, including `broadcasts.deliverOne`'s per-recipient send. A hung
// connection on any of them stalls its action with no ceiling, so the
// timeout is a property of the module, not of individual call sites.
// These tests pin that: they assert on the `signal` each call hands to
// `fetch`, which is the only observable evidence of it.
// ============================================================

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

/** Swaps in a fetch that records its `init` and returns `body` as 200 JSON. */
function captureFetch(body: unknown = {}) {
  const calls: RequestInit[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return calls;
}

test("verifyPhoneNumber sends an abort signal, so a hung Meta call cannot stall forever", async () => {
  const calls = captureFetch({ id: "PN1" });

  await verifyPhoneNumber({ phoneNumberId: "PN1", accessToken: "tok" });

  expect(calls).toHaveLength(1);
  expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
  // Not already aborted — the timeout is a ceiling, not an immediate kill.
  expect(calls[0]!.signal!.aborted).toBe(false);
});

test("getMediaUrl sends an abort signal", async () => {
  const calls = captureFetch({ url: "https://cdn.example/m", mime_type: "image/jpeg" });

  await getMediaUrl({ mediaId: "M1", accessToken: "tok" });

  expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
});

test("downloadMedia sends an abort signal on the binary fetch", async () => {
  const calls: RequestInit[] = [];
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(new Response(new ArrayBuffer(8), { status: 200 }));
  }) as unknown as typeof fetch;

  await downloadMedia({ downloadUrl: "https://cdn.example/m", accessToken: "tok" });

  expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
});
