// Service worker. Hand-rolled (no next-pwa/Serwist) to
// avoid coupling with the customized next.config.ts. Jobs: serve
// content-hashed static assets from cache, receive Web Push, show/route
// notifications, keep the app-icon badge in sync, hand off to a visible
// tab, and fall back to an offline page.
//
// Behaviour is unit-tested — `src/lib/pwa/service-worker.test.ts` loads
// THIS FILE into a sandbox with a fake Cache API and drives the handlers
// directly. Anything you change here should be provable there.

// ---------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------

// Versioned, because it holds ONE fixed URL whose contents change
// between deploys. Bump to force every client to re-fetch the offline
// page.
const SW_VERSION = "v2";
const OFFLINE_CACHE = `wa-offline-${SW_VERSION}`;
const OFFLINE_URL = "/offline.html";

// DELIBERATELY UNVERSIONED, and this is the fix for the "SW_VERSION goes
// stale because a human forgot to bump it" problem rather than an
// oversight.
//
// Everything in here is under `/_next/static/`, where Next puts a
// content hash in the filename. Two different builds therefore never
// collide on a URL, so a stale entry is not a correctness problem the
// way a stale HTML document would be — it is only dead weight. Tying
// this cache to a hand-maintained version string would buy nothing and
// silently rot the moment someone edited this file without bumping it
// (which is exactly what happened between v1 and this change).
//
// Dead weight is bounded by count instead, evicted oldest-first on
// write. `Cache.keys()` resolves in insertion order, which is what makes
// the FIFO below well-defined rather than a guess.
const STATIC_CACHE = "wa-static";
const STATIC_CACHE_LIMIT = 240;

/** Caches this worker owns. Anything else found at activate is a leftover
 *  from a previous version and gets deleted. */
const OWNED_CACHES = [OFFLINE_CACHE, STATIC_CACHE];

// ---------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(OFFLINE_CACHE)
      .then((cache) => cache.add(OFFLINE_URL))
      .catch(() => {}),
  );
  // NO `skipWaiting()` here — deliberately, and this is a behaviour
  // change from v1.
  //
  // Calling it unconditionally swaps the worker under a page that is
  // already running, so a long-lived standalone PWA could have its
  // controller replaced mid-session. The new worker then serves the new
  // build's assets to a document that was built against the old one.
  //
  // Instead this worker waits, the page notices it waiting
  // (`service-worker-manager.tsx`) and offers the user a reload; that
  // click posts SKIP_WAITING below. The update happens at a moment the
  // user chose, followed immediately by a reload, so the document and
  // its assets always come from the same build.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Navigation preload: the browser starts the network request for a
      // navigation IN PARALLEL with booting this worker, instead of
      // after. A service worker that has gone idle takes real time to
      // start on a phone, and without this that startup is added to
      // every single navigation — a service worker whose only job on
      // navigations is `fetch(request)` would otherwise make the app
      // measurably SLOWER than having no service worker at all.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {});
      }
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !OWNED_CACHES.includes(k)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// The page asks for the waiting worker to take over (see the update
// prompt in `service-worker-manager.tsx`). This is the ONLY path to
// `skipWaiting`, so an update can never surprise someone mid-task.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// ---------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------

/**
 * Is this a build asset that can be cached forever?
 *
 * Only `/_next/static/*`, and only same-origin. The content hash in the
 * filename is what makes cache-first safe: the URL changes whenever the
 * bytes do, so a cached entry can never be stale for its own URL.
 *
 * Everything in `public/` (icons, the offline page) is deliberately
 * excluded — those keep stable filenames across deploys, so caching them
 * first would pin an old copy with no way to invalidate it.
 */
function isImmutableBuildAsset(url) {
  return url.origin === self.location.origin &&
    url.pathname.startsWith("/_next/static/");
}

/** Oldest-first eviction. `Cache.keys()` is insertion-ordered. */
async function trimStaticCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - STATIC_CACHE_LIMIT;
  for (let i = 0; i < excess; i++) {
    await cache.delete(keys[i]);
  }
}

/**
 * Cache-first. This is the cold-start win: on every launch after the
 * first, the app's JavaScript and CSS come off disk with no network at
 * all, which on a congested mobile connection is the difference between
 * an instant open and several seconds of blank screen.
 */
async function serveBuildAsset(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;

  const response = await fetch(request);
  // Only store a real, complete, same-origin success. `type === "basic"`
  // rejects opaque cross-origin responses (status 0, unreadable), and
  // the status check rejects 206 partials and error pages — caching
  // either would serve a broken asset forever, since nothing invalidates
  // a content-hashed URL.
  if (response && response.status === 200 && response.type === "basic") {
    await cache.put(request, response.clone());
    await trimStaticCache(cache);
  }
  return response;
}

/**
 * Navigations stay NETWORK-FIRST and are never written to the cache.
 *
 * Two reasons, and the second is the important one:
 *
 *  - The HTML is per-deploy: it names the exact content-hashed chunks it
 *    needs. Serving a cached document from an older build alongside a
 *    static cache that has since evicted those chunks reproduces exactly
 *    the failure `next.config.ts` documents at length — HTML 200, every
 *    asset 404, page renders unstyled.
 *  - Offline, a cached shell would render skeletons that never fill,
 *    because the data behind them lives in Convex over a socket that is
 *    also down. Until there is an offline banner to make that
 *    intelligible (phase 3), an honest "you're offline" is the better
 *    answer.
 *
 * `event.preloadResponse` is the parallel request the browser already
 * started; using it is what makes intercepting navigations free.
 */
async function serveNavigation(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch (_e) {
    const offline = await caches.match(OFFLINE_URL);
    return offline || Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  // Never intercept another origin. Convex (the reactive query socket
  // and its HTTP fallback) and R2 media both live off-origin, and an
  // opaque cached response there would be both useless and impossible to
  // debug. Anything not handled here falls through to the network
  // untouched, which is also what happens for same-origin `/api/*`.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isImmutableBuildAsset(url)) {
    event.respondWith(serveBuildAsset(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(serveNavigation(event));
  }
});

// ---------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------

// App-icon badge (the unread count on the home-screen icon). Best-effort
// in every direction: the Badging API is absent on desktop Safari and on
// Android before Chrome 81, `setAppBadge` returns a promise that can
// reject, and a wrong or missing count must never cost us the
// notification itself — so every failure path here is swallowed.
//
// This is the half of the badge that matters. The in-app `<AppBadge />`
// only runs while a tab is alive; a CRM's phone spends its day with the
// app CLOSED, and this handler is the only thing running then.
function syncBadge(unread) {
  if (typeof unread !== "number" || !Number.isFinite(unread) || unread < 0) {
    return;
  }
  try {
    const p =
      unread > 0
        ? navigator.setAppBadge && navigator.setAppBadge(unread)
        : navigator.clearAppBadge && navigator.clearAppBadge();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_e) {
    // Unsupported or blocked — the notification below still fires.
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_e) {
    payload = {};
  }
  // Before the visible-client branch below: the badge should be right
  // whether or not this push turns into an OS notification.
  syncBadge(payload.unread);
  const title = payload.title || "New message";
  // `actions` are what turn a notification from an announcement into a
  // place of work: on Android an agent can answer from the shade without
  // the app ever launching, which given a cold start costs a network
  // round trip is the fastest reply path in the product.
  //
  // iOS ignores `actions` entirely and shows a plain notification, so
  // this degrades to today's tap-to-open there. `conversationId` rides
  // in `data` because acting needs the id, not the URL it is embedded
  // in — `payload.tag` is the conversation id for message pushes, but
  // relying on that coupling would break the moment a tag scheme
  // changes (the qualified-lead push already prefixes its own).
  const conversationId = payload.conversationId || null;
  const options = {
    body: payload.body || "New WhatsApp message",
    tag: payload.tag || "wa-message",
    renotify: true,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    data: { url: payload.url || "/inbox", conversationId },
    actions: conversationId
      ? [
          { action: "reply", type: "text", title: "Reply", placeholder: "Message" },
          { action: "read", title: "Mark read" },
        ]
      : [],
  };

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const visible = clients.some((c) => c.visibilityState === "visible");
      if (visible) {
        // A tab is open — let the app show an in-app toast instead of an
        // OS notification (Chrome exempts the visible-client case from the
        // userVisibleOnly default-notification rule).
        clients.forEach((c) => c.postMessage({ type: "wa-push", payload }));
        return;
      }
      return self.registration.showNotification(title, options);
    }),
  );
});

/**
 * Perform a shade action through the app's own origin.
 *
 * The worker has no Convex client and no way to hold a session, but a
 * same-origin `fetch` carries the session cookie — so
 * `/api/whatsapp/notification` acts as the caller. It grants no
 * authority of its own: Convex still authorizes, so a stale
 * notification for a conversation since reassigned fails there.
 *
 * Resolves to true only on a 2xx. A failure re-shows the notification
 * rather than swallowing the reply, because the alternative is an agent
 * believing they answered a customer when nothing was sent.
 */
async function actOnNotification(action, conversationId, text, original) {
  try {
    const res = await fetch("/api/whatsapp/notification", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, conversationId, text }),
    });
    if (res.ok) return true;
  } catch (_e) {
    // Falls through to the re-notify below.
  }
  await self.registration.showNotification(
    action === "reply" ? "Reply not sent" : "Couldn't mark as read",
    {
      body:
        action === "reply"
          ? "Tap to open the conversation and try again."
          : "Tap to open the conversation.",
      tag: `${original.tag || "wa-message"}-failed`,
      icon: "/icon-192.png",
      badge: "/badge-72.png",
      data: original.data,
    },
  );
  return false;
}

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  const conversationId = data.conversationId || null;

  // An action button: do the work, never open a window. Opening the app
  // after an inline reply would defeat the point of replying inline.
  if (event.action === "reply" || event.action === "read") {
    event.notification.close();
    if (!conversationId) return;
    event.waitUntil(
      actOnNotification(
        event.action,
        conversationId,
        // `event.reply` is the text the user typed into the shade.
        event.action === "reply" ? event.reply || "" : undefined,
        { tag: event.notification.tag, data },
      ),
    );
    return;
  }

  event.notification.close();
  const url = data.url || "/inbox";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) client.navigate(url).catch(() => {});
          return;
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
