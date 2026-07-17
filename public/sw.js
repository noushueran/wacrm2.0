// Holidayys WA CRM service worker. Hand-rolled (no next-pwa/Serwist) to
// avoid coupling with the customized next.config.ts. Jobs: receive Web
// Push, show/route notifications, hand off to a visible tab, minimal
// offline fallback. Bump SW_VERSION on any change.
const SW_VERSION = "v1";
const OFFLINE_CACHE = `wa-offline-${SW_VERSION}`;
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE).then((cache) => cache.add(OFFLINE_URL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== OFFLINE_CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

// Network-first navigations with an offline fallback. Never touch API /
// Convex / static assets — let the network own them.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_e) {
    payload = {};
  }
  const title = payload.title || "Holidayys WA CRM";
  const options = {
    body: payload.body || "New WhatsApp message",
    tag: payload.tag || "wa-message",
    renotify: true,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    data: { url: payload.url || "/inbox" },
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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/inbox";
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
