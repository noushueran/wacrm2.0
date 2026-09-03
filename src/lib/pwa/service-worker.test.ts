import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Behavioural tests for `public/sw.js`.
 *
 * That file is real, shipped logic that decides what every user sees on
 * a bad connection, and it is the one file in the repo nothing else can
 * reach: it is not imported by the app (the browser loads it by URL), it
 * cannot run in jsdom, and service-worker registration is refused
 * outright in sandboxed/embedded browsers — so it cannot be exercised by
 * hand either. A caching mistake here is also the single PWA bug users
 * cannot clear themselves.
 *
 * So it is loaded as TEXT into a `node:vm` context with a fake Cache API
 * and fake fetch, and the handlers it registers are driven directly.
 * This tests the shipped bytes, not a copy of them: if someone edits
 * `public/sw.js`, these tests see the edit.
 */

const SW_SOURCE = readFileSync(
  join(__dirname, "..", "..", "..", "public", "sw.js"),
  "utf8",
);

const ORIGIN = "https://wa.example.com";

/** Minimal Cache that preserves insertion order, which is what the
 *  worker's FIFO eviction depends on. */
class FakeCache {
  entries = new Map<string, { body: string; status: number; type: string }>();

  private key(request: unknown): string {
    return typeof request === "string"
      ? request
      : (request as { url: string }).url;
  }

  async match(request: unknown) {
    return this.entries.get(this.key(request)) ?? undefined;
  }
  async put(request: unknown, response: { body: string; status: number; type: string }) {
    this.entries.set(this.key(request), response);
  }
  async delete(request: unknown) {
    return this.entries.delete(this.key(request));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async add(url: string) {
    this.entries.set(url, { body: `cached:${url}`, status: 200, type: "basic" });
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  async open(name: string) {
    let c = this.caches.get(name);
    if (!c) {
      c = new FakeCache();
      this.caches.set(name, c);
    }
    return c;
  }
  async keys() {
    return [...this.caches.keys()];
  }
  async delete(name: string) {
    return this.caches.delete(name);
  }
  async match(url: string) {
    for (const c of this.caches.values()) {
      const hit = await c.match(url);
      if (hit) return hit;
    }
    return undefined;
  }
}

type Listeners = Record<string, (event: unknown) => void>;

/** What the fake fetch / fake cache hand back. Only the fields the
 *  worker actually inspects, plus `body` so tests can prove WHERE a
 *  response came from (network vs cache vs offline page). */
type FakeResponse = {
  body?: string;
  status: number;
  type?: string;
  /** Only the notification-action path reads `ok`. */
  ok?: boolean;
  clone?: () => FakeResponse;
};

function loadWorker() {
  const listeners: Listeners = {};
  const cacheStorage = new FakeCacheStorage();
  const fetchMock = vi.fn<(...args: unknown[]) => Promise<FakeResponse>>(
    async (request: unknown) => {
      const url =
        typeof request === "string" ? request : (request as { url: string }).url;
      const res: FakeResponse = {
        body: `network:${url}`,
        status: 200,
        type: "basic",
      };
      // Assigned after construction so `clone` closes over a fully-typed
      // object rather than an inferred `this`.
      res.clone = () => ({ ...res });
      return res;
    },
  );

  const navigationPreload = { enabled: false, enable: async () => { navigationPreload.enabled = true; } };
  const skipWaiting = vi.fn();
  const claim = vi.fn(async () => {});

  const registration = {
    navigationPreload,
    showNotification: vi.fn(async () => {}),
  };
  const self: Record<string, unknown> = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    location: { origin: ORIGIN },
    registration,
    clients: { claim, matchAll: async () => [], openWindow: async () => {} },
    skipWaiting,
  };

  const sandbox: Record<string, unknown> = {
    self,
    caches: cacheStorage,
    fetch: fetchMock,
    navigator: {},
    URL,
    Response: { error: () => ({ body: "network-error", status: 0, type: "error" }) },
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox);

  return {
    listeners,
    cacheStorage,
    fetchMock,
    navigationPreload,
    skipWaiting,
    self,
    registration,
  };
}

/** Drives the `fetch` listener and returns what it responded with, or
 *  `undefined` when it declined to handle the request (fell through to
 *  the network untouched). */
async function runFetch(
  listeners: Listeners,
  request: Record<string, unknown>,
  preloadResponse?: unknown,
): Promise<FakeResponse | undefined> {
  let responded: unknown;
  const event = {
    request,
    preloadResponse: Promise.resolve(preloadResponse),
    respondWith: (p: unknown) => {
      responded = p;
    },
  };
  listeners.fetch(event);
  if (responded === undefined) return undefined;
  return (await responded) as FakeResponse;
}

/** Drives a lifecycle listener (`install` / `activate`) and awaits
 *  whatever it handed to `event.waitUntil`, which is where all of its
 *  real work happens — the listener itself returns synchronously. */
async function runLifecycle(handler: (event: unknown) => void) {
  const pending: Promise<unknown>[] = [];
  handler({ waitUntil: (p: Promise<unknown>) => pending.push(p) });
  await Promise.all(pending);
}

function req(url: string, extra: Record<string, unknown> = {}) {
  return { url, method: "GET", mode: "no-cors", ...extra };
}

describe("service worker: what it refuses to touch", () => {
  let w: ReturnType<typeof loadWorker>;
  beforeEach(() => {
    w = loadWorker();
  });

  it("ignores non-GET requests entirely", async () => {
    const res = await runFetch(w.listeners, {
      url: `${ORIGIN}/_next/static/chunks/a.js`,
      method: "POST",
      mode: "cors",
    });
    expect(res).toBeUndefined();
  });

  it("never intercepts another origin — Convex's socket and R2 media must pass through", async () => {
    for (const url of [
      "https://convex.example.com/api/query",
      "https://objs.amaniworld.com/media/x.jpg",
      "https://graph.facebook.com/v20.0/x",
    ]) {
      expect(await runFetch(w.listeners, req(url, { mode: "cors" }))).toBeUndefined();
    }
  });

  it("never intercepts same-origin /api/* — those responses are per-user", async () => {
    const res = await runFetch(w.listeners, req(`${ORIGIN}/api/v1/me`, { mode: "cors" }));
    expect(res).toBeUndefined();
  });

  it("never writes a navigation into any cache", async () => {
    await runFetch(
      w.listeners,
      req(`${ORIGIN}/inbox`, { mode: "navigate" }),
      { body: "preloaded", status: 200, type: "basic" },
    );
    for (const cache of w.cacheStorage.caches.values()) {
      expect([...cache.entries.keys()]).not.toContain(`${ORIGIN}/inbox`);
    }
  });
});

describe("service worker: build assets are cache-first", () => {
  let w: ReturnType<typeof loadWorker>;
  beforeEach(() => {
    w = loadWorker();
  });

  it("fetches a chunk once, then serves every later request from cache", async () => {
    const url = `${ORIGIN}/_next/static/chunks/abc123.js`;

    const first = await runFetch(w.listeners, req(url));
    expect(first!.body).toBe(`network:${url}`);
    expect(w.fetchMock).toHaveBeenCalledTimes(1);

    const second = await runFetch(w.listeners, req(url));
    expect(second!.body).toBe(`network:${url}`);
    // The point of the whole change: no second network request. This is
    // the cold-start win.
    expect(w.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a non-200, so an error page can't be pinned forever", async () => {
    w.fetchMock.mockResolvedValueOnce({
      body: "boom",
      status: 500,
      type: "basic",
      clone() { return { ...this }; },
    });
    const url = `${ORIGIN}/_next/static/chunks/broken.js`;
    await runFetch(w.listeners, req(url));

    const cache = await w.cacheStorage.open("wa-static");
    expect(cache.entries.size).toBe(0);
  });

  it("does not cache an opaque response", async () => {
    w.fetchMock.mockResolvedValueOnce({
      body: "",
      status: 200,
      type: "opaque",
      clone() { return { ...this }; },
    });
    await runFetch(w.listeners, req(`${ORIGIN}/_next/static/chunks/opaque.js`));

    const cache = await w.cacheStorage.open("wa-static");
    expect(cache.entries.size).toBe(0);
  });

  it("bounds the cache and evicts oldest-first, so it cannot grow without limit", async () => {
    // The worker's own limit, read from the shipped source so this test
    // cannot drift from it.
    const limit = Number(/STATIC_CACHE_LIMIT = (\d+)/.exec(SW_SOURCE)![1]);
    expect(limit).toBeGreaterThan(0);

    for (let i = 0; i < limit + 5; i++) {
      await runFetch(w.listeners, req(`${ORIGIN}/_next/static/chunks/c${i}.js`));
    }

    const cache = await w.cacheStorage.open("wa-static");
    expect(cache.entries.size).toBe(limit);
    // Oldest gone, newest kept.
    expect(cache.entries.has(`${ORIGIN}/_next/static/chunks/c0.js`)).toBe(false);
    expect(
      cache.entries.has(`${ORIGIN}/_next/static/chunks/c${limit + 4}.js`),
    ).toBe(true);
  });

  it("leaves public/ assets alone — they keep stable names across deploys", async () => {
    expect(await runFetch(w.listeners, req(`${ORIGIN}/icon-192.png`))).toBeUndefined();
    expect(await runFetch(w.listeners, req(`${ORIGIN}/offline.html`))).toBeUndefined();
  });
});

describe("service worker: navigations", () => {
  let w: ReturnType<typeof loadWorker>;
  beforeEach(() => {
    w = loadWorker();
  });

  it("uses the browser's preloaded response when there is one", async () => {
    const preload = { body: "preloaded", status: 200, type: "basic" };
    const res = await runFetch(
      w.listeners,
      req(`${ORIGIN}/inbox`, { mode: "navigate" }),
      preload,
    );
    expect(res!.body).toBe("preloaded");
    // Preload already did the network work — don't duplicate it.
    expect(w.fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to the network when preload is unavailable", async () => {
    const res = await runFetch(
      w.listeners,
      req(`${ORIGIN}/inbox`, { mode: "navigate" }),
      undefined,
    );
    expect(res!.body).toBe(`network:${ORIGIN}/inbox`);
  });

  it("serves the offline page when the network is gone", async () => {
    // Prime the offline cache the way `install` does.
    await runLifecycle(w.listeners.install);

    w.fetchMock.mockRejectedValueOnce(new Error("offline"));
    const res = await runFetch(
      w.listeners,
      req(`${ORIGIN}/inbox`, { mode: "navigate" }),
      undefined,
    );
    expect(res!.body).toBe("cached:/offline.html");
  });
});

describe("service worker: update lifecycle", () => {
  let w: ReturnType<typeof loadWorker>;
  beforeEach(() => {
    w = loadWorker();
  });

  it("does NOT skip waiting on install — an update must never swap under a running page", async () => {
    await runLifecycle(w.listeners.install);
    expect(w.skipWaiting).not.toHaveBeenCalled();
  });

  it("skips waiting only when the page asks", async () => {
    w.listeners.message({ data: { type: "SKIP_WAITING" } });
    expect(w.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated messages", async () => {
    w.listeners.message({ data: { type: "something-else" } });
    w.listeners.message({ data: undefined });
    expect(w.skipWaiting).not.toHaveBeenCalled();
  });

  it("enables navigation preload on activate", async () => {
    await runLifecycle(w.listeners.activate);
    expect(w.navigationPreload.enabled).toBe(true);
  });

  it("keeps its own caches on activate and deletes leftovers", async () => {
    await w.cacheStorage.open("wa-static");
    await w.cacheStorage.open("wa-offline-v2");
    await w.cacheStorage.open("wa-offline-v1"); // previous version
    await w.cacheStorage.open("some-other-cache");

    await runLifecycle(w.listeners.activate);

    const remaining = await w.cacheStorage.keys();
    expect(remaining).toContain("wa-static");
    expect(remaining).toContain("wa-offline-v2");
    expect(remaining).not.toContain("wa-offline-v1");
    expect(remaining).not.toContain("some-other-cache");
  });

  it("survives a browser with no navigationPreload support", async () => {
    const bare = loadWorker();
    (bare.registration as unknown as Record<string, unknown>).navigationPreload =
      undefined;
    await expect(runLifecycle(bare.listeners.activate)).resolves.not.toThrow();
  });
});

/** Drives `notificationclick` and awaits its `waitUntil` work. */
async function runNotificationClick(
  listeners: Listeners,
  event: Record<string, unknown>,
) {
  const pending: Promise<unknown>[] = [];
  const close = vi.fn();
  listeners.notificationclick({
    ...event,
    notification: { close, ...(event.notification as object) },
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  });
  await Promise.all(pending);
  return { close };
}

describe("service worker: acting on a notification from the shade", () => {
  let w: ReturnType<typeof loadWorker>;
  beforeEach(() => {
    w = loadWorker();
  });

  function notification(data: Record<string, unknown> = {}) {
    return {
      tag: "conv1",
      data: { url: "/inbox?c=conv1", conversationId: "conv1", ...data },
    };
  }

  it("posts an inline reply to the app's own origin with cookies", async () => {
    w.fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await runNotificationClick(w.listeners, {
      action: "reply",
      reply: "on my way",
      notification: notification(),
    });

    expect(w.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = w.fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/whatsapp/notification");
    expect(init.method).toBe("POST");
    // Without this the route cannot identify the agent at all.
    expect(init.credentials).toBe("include");
    expect(JSON.parse(init.body as string)).toEqual({
      action: "reply",
      conversationId: "conv1",
      text: "on my way",
    });
  });

  it("posts a mark-read with no text", async () => {
    w.fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    await runNotificationClick(w.listeners, {
      action: "read",
      notification: notification(),
    });
    const [, init] = w.fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string).action).toBe("read");
    expect(JSON.parse(init.body as string).text).toBeUndefined();
  });

  it("never opens a window for an action — replying inline must not launch the app", async () => {
    w.fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });
    const openWindow = vi.fn();
    (w.self.clients as Record<string, unknown>).openWindow = openWindow;
    await runNotificationClick(w.listeners, {
      action: "reply",
      reply: "hi",
      notification: notification(),
    });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("tells the user when a reply did NOT send, rather than swallowing it", async () => {
    // The failure mode this guards against is an agent believing they
    // answered a customer when nothing left the device.
    w.fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    await runNotificationClick(w.listeners, {
      action: "reply",
      reply: "hi",
      notification: notification(),
    });
    expect(w.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(
      (w.registration.showNotification.mock.calls[0] as unknown as [string])[0],
    ).toBe("Reply not sent");
  });

  it("re-notifies when the network throws too", async () => {
    w.fetchMock.mockRejectedValueOnce(new Error("offline"));
    await runNotificationClick(w.listeners, {
      action: "read",
      notification: notification(),
    });
    expect(w.registration.showNotification).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an action on a notification carrying no conversation", async () => {
    await runNotificationClick(w.listeners, {
      action: "reply",
      reply: "hi",
      notification: { tag: "x", data: { url: "/inbox" } },
    });
    expect(w.fetchMock).not.toHaveBeenCalled();
  });

  it("a plain tap still focuses the app instead of posting anything", async () => {
    const focus = vi.fn();
    const navigate = vi.fn(async () => {});
    (w.self.clients as Record<string, unknown>).matchAll = async () => [
      { focus, navigate },
    ];
    await runNotificationClick(w.listeners, {
      action: "",
      notification: notification(),
    });
    expect(w.fetchMock).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
  });
});
