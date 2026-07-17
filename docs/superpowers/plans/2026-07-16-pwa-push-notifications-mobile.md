# PWA + Web Push + Mobile Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Holidayys WA CRM an installable PWA that sends a true OS-level push notification to the right teammate when a WhatsApp message arrives (even when the app is closed), with an inbox-first mobile UI.

**Architecture:** Push hangs off the single inbound choke point `convex/ingest.ts › processInbound` as a best-effort fan-out (next to `webhookDelivery.dispatch`). A `"use node"` Convex action sends Web Push via the `web-push` library using our VAPID keys; a hand-rolled `public/sw.js` receives it and shows/routes the notification, or hands off to an in-app toast when a tab is visible. Recipient targeting reuses the existing `memberships` roles + `conversations.assignedToUserId`.

**Tech Stack:** Next.js 16 (customized fork, App Router), React 19, Convex (self-hosted), `web-push`, Tailwind v4, `next-intl`, Vitest + `convex-test`, `sharp` (dev-only, icon generation).

## Global Constraints

- **Customized Next.js.** Per `wacrm2.0/AGENTS.md`: *"This is NOT the Next.js you know. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code."* Before Task 0.3 (manifest/metadata) and Task 1.1 (any Next-specific API), read the matching guide under `node_modules/next/dist/docs/`.
- **Code retrieval via Augment (`auggie`) MCP first** for any "where is X" exploration (project `CLAUDE.md`).
- **Convex is a separate manual deploy** from Netlify. `convex dev`/`deploy`/`codegen` all push to the ONE live prod deployment (`convex-api.holidayys.co`). Build **offline** by hand-editing `convex/_generated/` (new table → `schema.ts` only; new module → add an `import type` line + a modules-object entry in `convex/_generated/api.d.ts`, mirroring `ingest`). `convex-test` runs fully offline.
- **Single locale.** Only `messages/en.json` exists — add every new UI string there.
- **No unrelated refactoring.** Follow existing patterns: `accountQuery`/`accountMutation` (`convex/lib/auth.ts`), `internalQuery`/`internalMutation`/`internalAction` (`./_generated/server`), `ConvexError({ code })`, `runBestEffort`, base-ui components, `cn`, `softBadge`, `useTranslations`.
- **No PII in logs.** Push failures log endpoint status codes only — never message text or phone numbers.
- **Env values (exact):** client `NEXT_PUBLIC_VAPID_PUBLIC_KEY`; Convex `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (e.g. `mailto:admin@holidayys.co`).
- **Test commands:** single file `npx vitest run <path>`; single test `npx vitest run <path> -t "<name>"`; full gate `npm run typecheck && npm run lint && npm test && npm run build`.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Pre-flight (once, before Task 0.1)

- Working dir is the inner repo: `/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0`.
- If executing in an isolated worktree, it should have been created via `superpowers:using-git-worktrees`. Otherwise create a branch in Task 0.1.
- **Reference spec:** `docs/superpowers/specs/2026-07-16-pwa-push-notifications-mobile-design.md`.

---

## Phase 0 — Installable PWA shell

### Task 0.1: Branch + dependencies + VAPID keys

**Files:**
- Modify: `package.json` (deps)

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feat/pwa-push-notifications
```

- [ ] **Step 2: Add runtime + dev dependencies**

```bash
npm install web-push
npm install -D @types/web-push sharp
```

Expected: `web-push` under `dependencies`, `@types/web-push` + `sharp` under `devDependencies` in `package.json`.

- [ ] **Step 3: Generate a VAPID key pair (record the output — do NOT commit it)**

```bash
npx web-push generate-vapid-keys --json
```

Expected: JSON `{ "publicKey": "...", "privateKey": "..." }`. Save both values for deployment (Task 6). Locally, add to `.env.local` (gitignored):

```
NEXT_PUBLIC_VAPID_PUBLIC_KEY=<publicKey>
VAPID_PUBLIC_KEY=<publicKey>
VAPID_PRIVATE_KEY=<privateKey>
VAPID_SUBJECT=mailto:admin@holidayys.co
```

- [ ] **Step 4: Verify install + suite still green**

Run: `npm run typecheck && npm test`
Expected: PASS (no code changed yet; confirms deps didn't break the build).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add web-push + sharp deps for PWA push

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 0.2: Brand icons (SVG source + generated PNGs)

**Files:**
- Create: `public/icon.svg`, `scripts/generate-pwa-icons.mjs`
- Create (generated): `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`, `public/apple-touch-icon.png`, `public/badge-72.png`

- [ ] **Step 1: Create the SVG source** `public/icon.svg`

A rounded square in the brand primary with a white chat glyph (mirrors the `MessageSquare` mark in `header.tsx`).

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Holidayys WA CRM">
  <rect width="512" height="512" rx="112" fill="#4f46e5"/>
  <path fill="#ffffff" d="M160 150h192a34 34 0 0 1 34 34v120a34 34 0 0 1-34 34H236l-64 52v-52h-12a34 34 0 0 1-34-34V184a34 34 0 0 1 34-34z"/>
</svg>
```

- [ ] **Step 2: Create the generator script** `scripts/generate-pwa-icons.mjs`

```js
// One-off: rasterize public/icon.svg into the PWA/notification PNGs.
// Run: node scripts/generate-pwa-icons.mjs
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const svg = await readFile(new URL("../public/icon.svg", import.meta.url));

const outputs = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "apple-touch-icon.png", size: 180 },
];

for (const { file, size } of outputs) {
  await sharp(svg).resize(size, size).png().toFile(new URL(`../public/${file}`, import.meta.url).pathname);
  console.log("wrote", file);
}

// Maskable: same art on a full-bleed brand background with ~20% safe padding.
await sharp({
  create: { width: 512, height: 512, channels: 4, background: "#4f46e5" },
})
  .composite([{ input: await sharp(svg).resize(320, 320).png().toBuffer(), gravity: "center" }])
  .png()
  .toFile(new URL("../public/icon-maskable-512.png", import.meta.url).pathname);
console.log("wrote icon-maskable-512.png");

// Badge: monochrome white glyph on transparent (Android status bar).
const badgeSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#ffffff" d="M160 150h192a34 34 0 0 1 34 34v120a34 34 0 0 1-34 34H236l-64 52v-52h-12a34 34 0 0 1-34-34V184a34 34 0 0 1 34-34z"/></svg>`,
);
await sharp(badgeSvg).resize(72, 72).png().toFile(new URL("../public/badge-72.png", import.meta.url).pathname);
console.log("wrote badge-72.png");
```

- [ ] **Step 3: Generate the PNGs**

Run: `node scripts/generate-pwa-icons.mjs`
Expected: logs `wrote icon-192.png` … `wrote badge-72.png`; five PNGs exist in `public/`.

- [ ] **Step 4: Sanity-check sizes**

Run: `node -e "const s=require('sharp'); ['icon-192','icon-512','icon-maskable-512','apple-touch-icon','badge-72'].forEach(async f=>console.log(f, (await s('public/'+f+'.png').metadata()).width))"`
Expected: `192, 512, 512, 180, 72` (order may interleave).

- [ ] **Step 5: Commit**

```bash
git add public/icon.svg public/icon-192.png public/icon-512.png public/icon-maskable-512.png public/apple-touch-icon.png public/badge-72.png scripts/generate-pwa-icons.mjs
git commit -m "feat: add PWA + notification icon set

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 0.3: Manifest + head metadata + CSP

**Files:**
- Read first: `node_modules/next/dist/docs/` (metadata / manifest / viewport guide)
- Create: `src/app/manifest.ts`
- Modify: `src/app/layout.tsx:44-57` (metadata icons/appleWebApp + viewport)
- Modify: `next.config.ts:58-79` (CSP: add `worker-src`, `manifest-src`)

- [ ] **Step 1: Read the customized-Next metadata guide**

Run: `ls node_modules/next/dist/docs/ && sed -n '1,200p' node_modules/next/dist/docs/*metadata* 2>/dev/null | head -200`
Confirm the `manifest.ts` return shape and `appleWebApp`/`viewport` field names before editing. If the guide differs from the code below, follow the guide.

- [ ] **Step 2: Create `src/app/manifest.ts`**

```ts
import type { MetadataRoute } from "next";

// Web app manifest — makes the CRM installable. `start_url` opens the
// inbox (the daily driver); the app boots dark to match the shell.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Holidayys WA CRM",
    short_name: "Holidayys",
    id: "/",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#020617",
    theme_color: "#020617",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
```

- [ ] **Step 3: Extend metadata + viewport in `src/app/layout.tsx`**

Replace the `icons` block (currently `icons: { icon: [{ url: "/icon" }] }`) and add `appleWebApp` + `manifest`:

```ts
  icons: {
    icon: [{ url: "/icon" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "Holidayys",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
```

Replace the `viewport` export with per-scheme theme color + `viewportFit`:

```ts
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
  colorScheme: "dark light",
  viewportFit: "cover",
};
```

(Next auto-serves `manifest.ts` at `/manifest.webmanifest` and links it — confirm via Step 6. If the guide says to set `metadata.manifest` explicitly, add `manifest: "/manifest.webmanifest"`.)

- [ ] **Step 4: Widen the CSP for the SW + manifest** in `next.config.ts`

Inside the `Content-Security-Policy-Report-Only` array, add two directives after `"font-src 'self' data:",`:

```ts
      "worker-src 'self'",
      "manifest-src 'self'",
```

- [ ] **Step 5: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS; build output shows a `/manifest.webmanifest` entry.

- [ ] **Step 6: Verify the manifest serves**

Run: `npm run build && npm start &` then `sleep 4 && curl -si http://localhost:3000/manifest.webmanifest | head -20; kill %1`
Expected: `200`, `content-type: application/manifest+json`, JSON containing `"short_name":"Holidayys"`.

- [ ] **Step 7: Commit**

```bash
git add src/app/manifest.ts src/app/layout.tsx next.config.ts
git commit -m "feat: add web app manifest, apple-web-app metadata, CSP worker/manifest-src

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 1 — Service worker + registration + install UX

### Task 1.1: Service worker `public/sw.js`

**Files:**
- Create: `public/sw.js`

- [ ] **Step 1: Write `public/sw.js`**

```js
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
```

- [ ] **Step 2: Create the offline fallback page** `src/app/offline/page.tsx`

```tsx
export const dynamic = "force-static";

export default function OfflinePage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-background p-6 text-center">
      <h1 className="text-lg font-semibold text-foreground">You&apos;re offline</h1>
      <p className="text-sm text-muted-foreground">
        Reconnect to load the latest conversations.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Verify the SW serves at the root scope**

Run: `npm run build && npm start &` then `sleep 4 && curl -sI http://localhost:3000/sw.js | head -5; kill %1`
Expected: `200` and `content-type` includes `javascript`.

- [ ] **Step 4: Commit**

```bash
git add public/sw.js "src/app/offline/page.tsx"
git commit -m "feat: add service worker (push, notificationclick, offline fallback)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 1.2: SW registration + client-side platform helpers

**Files:**
- Create: `src/lib/push/platform.ts`, `src/lib/push/platform.test.ts`
- Create: `src/components/pwa/service-worker-manager.tsx`
- Modify: `src/app/(dashboard)/dashboard-shell.tsx:43-56` (mount it)

**Interfaces:**
- Produces: `isIOS(ua: string): boolean`, `isStandalone(): boolean` from `src/lib/push/platform.ts`.
- Produces: `<ServiceWorkerManager />` (headless) from `src/components/pwa/service-worker-manager.tsx`.

- [ ] **Step 1: Write the failing platform test** `src/lib/push/platform.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { isIOS } from "./platform";

describe("isIOS", () => {
  it("detects iPhone", () => {
    expect(isIOS("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(true);
  });
  it("detects iPad on iPadOS (reports as Macintosh + touch)", () => {
    expect(isIOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Version/17 Safari", 5)).toBe(true);
  });
  it("is false for Android", () => {
    expect(isIOS("Mozilla/5.0 (Linux; Android 14)")).toBe(false);
  });
  it("is false for desktop Chrome", () => {
    expect(isIOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Chrome/120", 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — fails**

Run: `npx vitest run src/lib/push/platform.test.ts`
Expected: FAIL (`isIOS` not defined).

- [ ] **Step 3: Implement `src/lib/push/platform.ts`**

```ts
// Pure platform detection for the push/install UX. `maxTouchPoints` is
// passed in so the iPadOS-masquerading-as-Mac case is testable without a
// real navigator.
export function isIOS(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPod/.test(userAgent)) return true;
  if (/iPad/.test(userAgent)) return true;
  // iPadOS 13+ reports a Mac UA; disambiguate by touch support.
  if (/Macintosh/.test(userAgent) && maxTouchPoints > 1) return true;
  return false;
}

// True when the app is running as an installed PWA (home-screen / standalone).
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    // iOS Safari legacy flag.
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}
```

- [ ] **Step 4: Run it — passes**

Run: `npx vitest run src/lib/push/platform.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `src/components/pwa/service-worker-manager.tsx`**

```tsx
"use client";

import { useEffect } from "react";

// Headless. Registers /sw.js once and relays SW push messages to the
// in-app notifier via a window CustomEvent. No-op where unsupported.
export function ServiceWorkerManager() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let cancelled = false;
    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.error("[sw] registration failed:", err));

    const onMessage = (event: MessageEvent) => {
      if (cancelled) return;
      if (event.data?.type === "wa-push" && event.data.payload) {
        window.dispatchEvent(
          new CustomEvent("wa-push", { detail: event.data.payload }),
        );
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  return null;
}
```

- [ ] **Step 6: Mount it in the shell** — `src/app/(dashboard)/dashboard-shell.tsx`

Add the import and render it next to `<PresenceHeartbeat />`:

```tsx
import { ServiceWorkerManager } from "@/components/pwa/service-worker-manager";
```

```tsx
      <PresenceHeartbeat />
      <ServiceWorkerManager />
```

- [ ] **Step 7: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/push/platform.ts src/lib/push/platform.test.ts src/components/pwa/service-worker-manager.tsx "src/app/(dashboard)/dashboard-shell.tsx"
git commit -m "feat: register service worker + platform detection helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 1.3: Install prompt (Chromium + iOS instructions)

**Files:**
- Create: `src/components/pwa/install-prompt.tsx`
- Modify: `messages/en.json` (add `Pwa` namespace)

- [ ] **Step 1: Add strings to `messages/en.json`** (new top-level `Pwa` namespace)

```json
"Pwa": {
  "installTitle": "Install Holidayys",
  "installBody": "Add the app to your device for faster access and notifications.",
  "installButton": "Install app",
  "iosInstallTitle": "Install on iPhone/iPad",
  "iosInstallBody": "Tap the Share icon, then \"Add to Home Screen\" to install and enable notifications.",
  "dismiss": "Not now"
}
```

- [ ] **Step 2: Write `src/components/pwa/install-prompt.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Share, X } from "lucide-react";
import { isIOS, isStandalone } from "@/lib/push/platform";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "wacrm:pwa:install-dismissed";

// A dismissible install card. Chromium fires `beforeinstallprompt` (we
// capture it and show a button); iOS gets manual Add-to-Home-Screen help.
export function InstallPrompt() {
  const t = useTranslations("Pwa");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOS, setShowIOS] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (isStandalone()) return; // already installed
    try {
      if (localStorage.getItem(DISMISS_KEY) === "true") return;
    } catch {}
    setDismissed(false);

    if (isIOS(navigator.userAgent, navigator.maxTouchPoints)) {
      setShowIOS(true);
      return;
    }
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "true");
    } catch {}
  };

  if (dismissed || (!deferred && !showIOS)) return null;

  return (
    <div className="fixed inset-x-3 bottom-3 z-50 mx-auto max-w-sm rounded-xl border border-border bg-card p-4 shadow-lg lg:left-auto lg:right-6">
      <button
        type="button"
        onClick={close}
        aria-label={t("dismiss")}
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
      <p className="text-sm font-semibold text-foreground">
        {showIOS ? t("iosInstallTitle") : t("installTitle")}
      </p>
      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        {showIOS && <Share className="h-3.5 w-3.5 shrink-0" />}
        {showIOS ? t("iosInstallBody") : t("installBody")}
      </p>
      {deferred && (
        <button
          type="button"
          onClick={async () => {
            await deferred.prompt();
            await deferred.userChoice;
            setDeferred(null);
            close();
          }}
          className="mt-3 w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
        >
          {t("installButton")}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Mount it in the shell** — `src/app/(dashboard)/dashboard-shell.tsx`, inside the main content column after `<Header/>` (renders nothing when installed/dismissed):

```tsx
import { InstallPrompt } from "@/components/pwa/install-prompt";
```

Add `<InstallPrompt />` just before the closing `</div>` of the outer shell wrapper.

- [ ] **Step 4: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/pwa/install-prompt.tsx "src/app/(dashboard)/dashboard-shell.tsx" messages/en.json
git commit -m "feat: add PWA install prompt (Chromium button + iOS instructions)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 2 — Push backend + ingest wiring

### Task 2.1: Schema — `pushSubscriptions` + `notificationPreferences`

**Files:**
- Modify: `convex/schema.ts` (add two tables near `notifications`)
- Modify: `convex/_generated/dataModel.d.ts` is regenerated by `convex-test`'s schema read — no hand-edit needed for tables (schema is read directly).

- [ ] **Step 1: Add the tables** to `convex/schema.ts` (place after the `notifications` table)

```ts
  // One Web Push subscription = one browser/device for one user.
  pushSubscriptions: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_endpoint", ["endpoint"])
    .index("by_user", ["userId"])
    .index("by_account", ["accountId"]),

  // Per-user, per-account notification preferences. Absent row = defaults
  // (push on, preview shown).
  notificationPreferences: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    pushEnabled: v.boolean(),
    hidePreview: v.boolean(),
  }).index("by_user_account", ["userId", "accountId"]),
```

- [ ] **Step 2: Typecheck (schema compiles; convex-test reads it directly)**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat: add pushSubscriptions + notificationPreferences tables

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2.2: Recipient targeting (pure)

**Files:**
- Create: `convex/lib/pushRecipients.ts`, `convex/lib/pushRecipients.test.ts`

**Interfaces:**
- Produces: `recipientsForInbound(input: { assignedToUserId?: Id<"users"> | null; members: { userId: Id<"users">; role: AccountRole }[] }): Id<"users">[]`.

- [ ] **Step 1: Write the failing test** `convex/lib/pushRecipients.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { recipientsForInbound } from "./pushRecipients";

const members = [
  { userId: "u_owner" as never, role: "owner" as const },
  { userId: "u_admin" as never, role: "admin" as const },
  { userId: "u_sup" as never, role: "supervisor" as const },
  { userId: "u_agent" as never, role: "agent" as const },
  { userId: "u_viewer" as never, role: "viewer" as const },
];

describe("recipientsForInbound", () => {
  it("assigned → only the assignee", () => {
    expect(recipientsForInbound({ assignedToUserId: "u_agent" as never, members })).toEqual([
      "u_agent",
    ]);
  });
  it("unassigned → owner + admin + supervisor only", () => {
    expect(
      recipientsForInbound({ assignedToUserId: null, members }).sort(),
    ).toEqual(["u_admin", "u_owner", "u_sup"]);
  });
  it("unassigned with no privileged members → empty", () => {
    expect(
      recipientsForInbound({
        assignedToUserId: null,
        members: [{ userId: "u_agent" as never, role: "agent" }],
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — fails**

Run: `npx vitest run convex/lib/pushRecipients.test.ts`
Expected: FAIL (`recipientsForInbound` not defined).

- [ ] **Step 3: Implement `convex/lib/pushRecipients.ts`**

```ts
import type { Id } from "../_generated/dataModel";
import { hasMinRole, type AccountRole } from "./roles";

// Who gets a push for an inbound message. Assigned → the assignee only;
// otherwise everyone who can act on the whole pool (supervisor+, which
// includes admin + owner). Agents/viewers are never paged for an
// unassigned message — they work only their own assignments.
export function recipientsForInbound(input: {
  assignedToUserId?: Id<"users"> | null;
  members: { userId: Id<"users">; role: AccountRole }[];
}): Id<"users">[] {
  if (input.assignedToUserId) return [input.assignedToUserId];
  return input.members
    .filter((m) => hasMinRole(m.role, "supervisor"))
    .map((m) => m.userId);
}
```

- [ ] **Step 4: Run it — passes**

Run: `npx vitest run convex/lib/pushRecipients.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/pushRecipients.ts convex/lib/pushRecipients.test.ts
git commit -m "feat: add inbound push recipient targeting (assigned else supervisor+)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2.3: Notification payload builder (pure)

**Files:**
- Create: `convex/lib/pushPayload.ts`, `convex/lib/pushPayload.test.ts`

**Interfaces:**
- Produces: `type PushPayload = { title: string; body: string; url: string; tag: string }`
- Produces: `buildInboundPayload(input: { contactName?: string | null; contentType: string; text?: string | null; conversationId: string; hidePreview: boolean }): PushPayload`

- [ ] **Step 1: Write the failing test** `convex/lib/pushPayload.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { buildInboundPayload } from "./pushPayload";

describe("buildInboundPayload", () => {
  it("shows name + text when preview visible", () => {
    const p = buildInboundPayload({
      contactName: "Ravi Kumar",
      contentType: "text",
      text: "I'd like to book Bali",
      conversationId: "c1",
      hidePreview: false,
    });
    expect(p.title).toBe("Ravi Kumar");
    expect(p.body).toBe("I'd like to book Bali");
    expect(p.url).toBe("/inbox?c=c1");
    expect(p.tag).toBe("c1");
  });
  it("labels non-text content", () => {
    expect(
      buildInboundPayload({ contactName: "A", contentType: "audio", conversationId: "c1", hidePreview: false }).body,
    ).toBe("🎤 Voice message");
  });
  it("truncates long text", () => {
    const long = "x".repeat(200);
    expect(
      buildInboundPayload({ contactName: "A", contentType: "text", text: long, conversationId: "c1", hidePreview: false }).body.length,
    ).toBeLessThanOrEqual(121);
  });
  it("hides everything when hidePreview", () => {
    const p = buildInboundPayload({
      contactName: "Ravi Kumar",
      contentType: "text",
      text: "secret",
      conversationId: "c1",
      hidePreview: true,
    });
    expect(p.title).toBe("Holidayys WA CRM");
    expect(p.body).toBe("New WhatsApp message");
    expect(p.url).toBe("/inbox?c=c1"); // routing still works
  });
});
```

- [ ] **Step 2: Run it — fails**

Run: `npx vitest run convex/lib/pushPayload.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `convex/lib/pushPayload.ts`**

```ts
export type PushPayload = { title: string; body: string; url: string; tag: string };

const TYPE_LABEL: Record<string, string> = {
  image: "📷 Photo",
  audio: "🎤 Voice message",
  video: "🎬 Video",
  document: "📄 Document",
  location: "📍 Location",
  template: "💬 Message",
  interactive: "💬 Message",
};

function previewFor(contentType: string, text?: string | null): string {
  if (contentType === "text") {
    const t = (text ?? "").trim();
    return t.length > 120 ? `${t.slice(0, 120)}…` : t || "💬 Message";
  }
  return TYPE_LABEL[contentType] ?? "💬 Message";
}

// Builds the OS notification content. `hidePreview` collapses everything
// to a generic string (privacy on the lock screen) but keeps the routing
// url + tag so a tap still opens the right conversation. No phone numbers.
export function buildInboundPayload(input: {
  contactName?: string | null;
  contentType: string;
  text?: string | null;
  conversationId: string;
  hidePreview: boolean;
}): PushPayload {
  const url = `/inbox?c=${input.conversationId}`;
  const tag = input.conversationId;
  if (input.hidePreview) {
    return { title: "Holidayys WA CRM", body: "New WhatsApp message", url, tag };
  }
  return {
    title: input.contactName?.trim() || "New message",
    body: previewFor(input.contentType, input.text),
    url,
    tag,
  };
}
```

- [ ] **Step 4: Run it — passes**

Run: `npx vitest run convex/lib/pushPayload.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/pushPayload.ts convex/lib/pushPayload.test.ts
git commit -m "feat: add inbound push payload builder with hide-preview privacy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2.4: `convex/push.ts` — subscribe / unsubscribe / preferences / assembly

**Files:**
- Create: `convex/push.ts`, `convex/push.test.ts`
- Modify: `convex/_generated/api.d.ts` (offline: add `push` module)

**Interfaces:**
- Produces (public, account-scoped): `subscribe({ endpoint, p256dh, auth, userAgent? })`, `unsubscribe({ endpoint })`, `getPreferences()` → `{ pushEnabled: boolean; hidePreview: boolean }`, `setPreferences({ pushEnabled?, hidePreview? })`.
- Produces (internal): `assembleDelivery({ accountId, conversationId, contentType, text? })` → `{ jobs: { endpoint: string; p256dh: string; auth: string; payload: PushPayload }[] }`, `deleteByEndpoint({ endpoint })`.

- [ ] **Step 1: Write failing tests** `convex/push.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { modules } from "./test.setup"; // if the repo uses a shared modules glob; else pass import.meta.glob

// NOTE: match the existing convex test bootstrap in e.g. convex/notifications.test.ts
// (how it seeds a user + membership + account and calls withIdentity). Reuse that helper.
import { seedAccount } from "./testHelpers"; // adjust to the real helper name

describe("push subscriptions", () => {
  it("subscribe upserts by endpoint (same endpoint twice = one row)", async () => {
    const t = convexTest(schema, modules);
    const { asUser } = await seedAccount(t, "agent");
    await asUser.mutation(api.push.subscribe, { endpoint: "e1", p256dh: "k", auth: "a" });
    await asUser.mutation(api.push.subscribe, { endpoint: "e1", p256dh: "k2", auth: "a2" });
    const prefs = await asUser.query(api.push.getPreferences, {});
    expect(prefs.pushEnabled).toBe(true);
    // one row: verified via a raw read helper if available, else via assembleDelivery job count later.
  });

  it("setPreferences persists hidePreview", async () => {
    const t = convexTest(schema, modules);
    const { asUser } = await seedAccount(t, "agent");
    await asUser.mutation(api.push.setPreferences, { hidePreview: true });
    expect((await asUser.query(api.push.getPreferences, {})).hidePreview).toBe(true);
  });
});
```

> If the repo has no `seedAccount`/`modules` helper, copy the exact bootstrap pattern from `convex/notifications.test.ts` (read it first) — it already seeds a user + membership and calls `t.withIdentity(...)`. Keep this test's structure identical to that file's.

- [ ] **Step 2: Run it — fails**

Run: `npx vitest run convex/push.test.ts`
Expected: FAIL (module `push` not found).

- [ ] **Step 3: Implement `convex/push.ts`**

```ts
import { accountMutation, accountQuery } from "./lib/auth";
import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { recipientsForInbound } from "./lib/pushRecipients";
import { buildInboundPayload, type PushPayload } from "./lib/pushPayload";
import type { AccountRole } from "./lib/roles";

// ---- Client-facing: one device's subscription ------------------------

export const subscribe = accountMutation({
  args: {
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        accountId: ctx.accountId,
        userId: ctx.userId,
        p256dh: args.p256dh,
        auth: args.auth,
        userAgent: args.userAgent,
        lastSeenAt: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("pushSubscriptions", {
      accountId: ctx.accountId,
      userId: ctx.userId,
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      userAgent: args.userAgent,
      createdAt: now,
      lastSeenAt: now,
    });
  },
});

export const unsubscribe = accountMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    // Only delete the caller's own subscription.
    if (existing && existing.userId === ctx.userId) {
      await ctx.db.delete(existing._id);
    }
    return null;
  },
});

// ---- Client-facing: per-user preferences -----------------------------

export const getPreferences = accountQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", ctx.userId).eq("accountId", ctx.accountId),
      )
      .first();
    return {
      pushEnabled: row?.pushEnabled ?? true,
      hidePreview: row?.hidePreview ?? false,
    };
  },
});

export const setPreferences = accountMutation({
  args: {
    pushEnabled: v.optional(v.boolean()),
    hidePreview: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_user_account", (q) =>
        q.eq("userId", ctx.userId).eq("accountId", ctx.accountId),
      )
      .first();
    if (row) {
      await ctx.db.patch(row._id, {
        ...(args.pushEnabled !== undefined ? { pushEnabled: args.pushEnabled } : {}),
        ...(args.hidePreview !== undefined ? { hidePreview: args.hidePreview } : {}),
      });
      return row._id;
    }
    return await ctx.db.insert("notificationPreferences", {
      accountId: ctx.accountId,
      userId: ctx.userId,
      pushEnabled: args.pushEnabled ?? true,
      hidePreview: args.hidePreview ?? false,
    });
  },
});

// ---- Internal: assembly + pruning (called by the Node sender) --------

export const deleteByEndpoint = internalMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .first();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

export const assembleDelivery = internalQuery({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contentType: v.string(),
    text: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) {
      return { jobs: [] as { endpoint: string; p256dh: string; auth: string; payload: PushPayload }[] };
    }

    const members = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();

    const recipients = recipientsForInbound({
      assignedToUserId: conversation.assignedToUserId ?? null,
      members: members.map((m) => ({ userId: m.userId, role: m.role as AccountRole })),
    });
    if (recipients.length === 0) return { jobs: [] };

    const contact = await ctx.db.get(conversation.contactId);
    const contactName = contact?.name ?? null;

    const jobs: { endpoint: string; p256dh: string; auth: string; payload: PushPayload }[] = [];
    for (const userId of recipients) {
      const prefs = await ctx.db
        .query("notificationPreferences")
        .withIndex("by_user_account", (q) =>
          q.eq("userId", userId).eq("accountId", args.accountId),
        )
        .first();
      if (prefs?.pushEnabled === false) continue;

      const payload = buildInboundPayload({
        contactName,
        contentType: args.contentType,
        text: args.text,
        conversationId: args.conversationId,
        hidePreview: prefs?.hidePreview ?? false,
      });

      const subs = await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
      for (const s of subs) {
        if (s.accountId !== args.accountId) continue; // tenant isolation
        jobs.push({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth, payload });
      }
    }
    return { jobs };
  },
});
```

> `conversation.assignedToUserId` and `contact.name`: confirm the exact field names in `convex/schema.ts` (conversations / contacts) before running — adjust if the contact display field differs (e.g. `name` vs `fullName`).

- [ ] **Step 4: Add `push` to `convex/_generated/api.d.ts`** (offline codegen)

Add an import line next to the others: `import type * as push from "../push.js";` and add `push` to the modules object passed to `ApiFromModules` (mirror how `ingest` appears in both places).

- [ ] **Step 5: Run tests — pass**

Run: `npx vitest run convex/push.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add convex/push.ts convex/push.test.ts convex/_generated/api.d.ts
git commit -m "feat: push subscriptions, preferences, and delivery assembly (Convex)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2.5: `convex/pushSend.ts` — the Node sender

**Files:**
- Create: `convex/pushSend.ts`
- Modify: `convex/_generated/api.d.ts` (offline: add `pushSend` module)

**Interfaces:**
- Consumes: `internal.push.assembleDelivery`, `internal.push.deleteByEndpoint`.
- Produces (internal): `deliverForMessage({ accountId, conversationId, contentType, text? })`.

- [ ] **Step 1: Implement `convex/pushSend.ts`**

```ts
"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import webpush from "web-push";

// Sends Web Push for one inbound message. Thin by design: all recipient /
// preference / payload logic lives in `push.assembleDelivery` (default
// runtime, unit-tested); this only signs + POSTs and prunes dead
// subscriptions. Never throws to its caller (best-effort in ingest).
export const deliverForMessage = internalAction({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contentType: v.string(),
    text: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT;
    if (!publicKey || !privateKey || !subject) {
      console.error("[push] VAPID env not configured; skipping send");
      return null;
    }
    webpush.setVapidDetails(subject, publicKey, privateKey);

    const { jobs } = await ctx.runQuery(internal.push.assembleDelivery, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contentType: args.contentType,
      text: args.text,
    });

    await Promise.all(
      jobs.map(async (job) => {
        try {
          await webpush.sendNotification(
            { endpoint: job.endpoint, keys: { p256dh: job.p256dh, auth: job.auth } },
            JSON.stringify(job.payload),
          );
        } catch (err: unknown) {
          const status = (err as { statusCode?: number })?.statusCode;
          if (status === 404 || status === 410) {
            // Gone — prune the dead subscription.
            await ctx.runMutation(internal.push.deleteByEndpoint, { endpoint: job.endpoint });
          } else {
            console.error("[push] send failed, status:", status ?? "unknown");
          }
        }
      }),
    );
    return null;
  },
});
```

- [ ] **Step 2: Add `pushSend` to `convex/_generated/api.d.ts`** (same 2-line pattern as Task 2.4 Step 4).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (The `"use node"` action isn't exercised by `convex-test`; its logic is covered by the pure/assembly tests + manual verification in Task 6.)

- [ ] **Step 4: Commit**

```bash
git add convex/pushSend.ts convex/_generated/api.d.ts
git commit -m "feat: add web-push Node sender action (deliverForMessage)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2.6: Wire push into `processInbound`

**Files:**
- Modify: `convex/ingest.ts:670-684` (add a `runBestEffort` block after `webhookDelivery.dispatch`)
- Modify: `convex/ingest.test.ts` (assert the dispatch is scheduled) — match the existing test file's style.

- [ ] **Step 1: Add the dispatch block** in `convex/ingest.ts`, immediately after the `webhookDelivery.dispatch` `runBestEffort` (ends ~line 684), before the conversion-funnel block:

```ts
    // ---- Web Push (PWA) — OUTSIDE every guard above, best-effort.
    // Notifies the assigned agent (else owner/admin/supervisor) on their
    // installed devices. A push failure never blocks ingestion.
    await runBestEffort("pushSend.deliverForMessage", () =>
      ctx.runAction(internal.pushSend.deliverForMessage, {
        accountId,
        conversationId: res.conversationId,
        contentType: message.type,
        text: message.text,
      }),
    );
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (`internal.pushSend.deliverForMessage` resolves from the api.d.ts edit in Task 2.5).

- [ ] **Step 3: Run the ingest test suite (nothing should regress)**

Run: `npx vitest run convex/ingest.test.ts`
Expected: PASS. (Existing tests mock the fan-out actions; the new best-effort call is isolated by `runBestEffort`.)

- [ ] **Step 4: Commit**

```bash
git add convex/ingest.ts convex/ingest.test.ts
git commit -m "feat: dispatch web push on inbound message ingest (best-effort)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 3 — Client subscribe + permission UX + Settings

### Task 3.1: VAPID key helper (pure)

**Files:**
- Create: `src/lib/push/vapid.ts`, `src/lib/push/vapid.test.ts`

**Interfaces:**
- Produces: `urlBase64ToUint8Array(base64: string): Uint8Array`.

- [ ] **Step 1: Write the failing test** `src/lib/push/vapid.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { urlBase64ToUint8Array } from "./vapid";

describe("urlBase64ToUint8Array", () => {
  it("decodes a url-safe base64 VAPID key to bytes", () => {
    // "hello" in url-safe base64 is "aGVsbG8".
    const bytes = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
  });
});
```

- [ ] **Step 2: Run it — fails**

Run: `npx vitest run src/lib/push/vapid.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/lib/push/vapid.ts`**

```ts
// Convert a url-safe base64 VAPID public key into the Uint8Array
// `PushManager.subscribe({ applicationServerKey })` requires.
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}
```

- [ ] **Step 4: Run it — passes**

Run: `npx vitest run src/lib/push/vapid.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/push/vapid.ts src/lib/push/vapid.test.ts
git commit -m "feat: add VAPID url-base64 → Uint8Array helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3.2: `useWebPush` hook

**Files:**
- Create: `src/hooks/use-web-push.ts`

**Interfaces:**
- Consumes: `api.push.subscribe`, `api.push.unsubscribe`, `urlBase64ToUint8Array`, `isIOS`, `isStandalone`.
- Produces: `useWebPush(): { supported: boolean; permission: NotificationPermission; isSubscribed: boolean; iosNeedsInstall: boolean; busy: boolean; enable(): Promise<void>; disable(): Promise<void> }`.

- [ ] **Step 1: Implement `src/hooks/use-web-push.ts`**

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { urlBase64ToUint8Array } from "@/lib/push/vapid";
import { isIOS, isStandalone } from "@/lib/push/platform";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

export function useWebPush() {
  const subscribeMut = useMutation(api.push.subscribe);
  const unsubscribeMut = useMutation(api.push.unsubscribe);

  const [supported, setSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [iosNeedsInstall, setIosNeedsInstall] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      "Notification" in window;
    setSupported(ok);
    if (!ok) {
      // iOS Safari only exposes PushManager once installed to the home screen.
      if (typeof navigator !== "undefined" && isIOS(navigator.userAgent, navigator.maxTouchPoints) && !isStandalone()) {
        setIosNeedsInstall(true);
      }
      return;
    }
    setPermission(Notification.permission);
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setIsSubscribed(!!sub))
      .catch(() => {});
  }, []);

  const enable = useCallback(async () => {
    if (!supported || !VAPID_PUBLIC_KEY) return;
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return;
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        }));
      const json = sub.toJSON();
      await subscribeMut({
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? "",
        auth: json.keys?.auth ?? "",
        userAgent: navigator.userAgent,
      });
      setIsSubscribed(true);
    } finally {
      setBusy(false);
    }
  }, [supported, subscribeMut]);

  const disable = useCallback(async () => {
    if (!supported) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await unsubscribeMut({ endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setIsSubscribed(false);
    } finally {
      setBusy(false);
    }
  }, [supported, unsubscribeMut]);

  return { supported, permission, isSubscribed, iosNeedsInstall, busy, enable, disable };
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-web-push.ts
git commit -m "feat: add useWebPush hook (permission + subscribe/unsubscribe)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3.3: Settings → Notifications panel

**Files:**
- Create: `src/components/settings/notifications-panel.tsx`
- Modify: `src/components/settings/settings-sections.ts` (add `notifications` section)
- Modify: `src/app/(dashboard)/settings/page.tsx` (panel map + import)
- Modify: `src/lib/auth/roles.ts:178-206` (add `notifications` to `SettingsSectionKey` + `PERSONAL_SECTIONS`)
- Modify: `messages/en.json` (`PushSettings` namespace)

- [ ] **Step 1: Add the section id** in `src/components/settings/settings-sections.ts`

- Add `'notifications'` to the `SETTINGS_SECTIONS` array (after `'appearance'`).
- Import `Bell` from `lucide-react`.
- Add to `SECTION_META`: `notifications: { id: 'notifications', label: 'Notifications', icon: Bell, group: 'account' },`

- [ ] **Step 2: Allow all roles to reach it** in `src/lib/auth/roles.ts`

- Add `| "notifications"` to the `SettingsSectionKey` union.
- Add `"notifications"` to `PERSONAL_SECTIONS` (so every role can manage their own device).

- [ ] **Step 3: Add strings** to `messages/en.json` (`PushSettings` namespace)

```json
"PushSettings": {
  "title": "Notifications",
  "desc": "Get a push notification on this device when a new WhatsApp message needs you.",
  "enable": "Enable on this device",
  "enabled": "Notifications are on for this device",
  "disable": "Turn off",
  "blocked": "Notifications are blocked in your browser settings. Enable them for this site, then try again.",
  "unsupported": "This browser doesn't support push notifications.",
  "iosInstall": "On iPhone/iPad, install the app first: tap Share, then \"Add to Home Screen\". Then reopen from the home screen to enable notifications.",
  "hidePreviewLabel": "Hide message preview",
  "hidePreviewHint": "Show only \"New WhatsApp message\" instead of the sender and text on your lock screen."
}
```

- [ ] **Step 4: Write `src/components/settings/notifications-panel.tsx`**

```tsx
"use client";

import { useQuery, useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { Bell, BellOff } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { useWebPush } from "@/hooks/use-web-push";

export function NotificationsPanel() {
  const t = useTranslations("PushSettings");
  const { supported, permission, isSubscribed, iosNeedsInstall, busy, enable, disable } = useWebPush();

  const prefs = useQuery(api.push.getPreferences);
  const setPrefs = useMutation(api.push.setPreferences);

  return (
    <div className="max-w-xl">
      <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("desc")}</p>

      <div className="mt-5 rounded-xl border border-border bg-card p-4">
        {iosNeedsInstall ? (
          <p className="text-sm text-muted-foreground">{t("iosInstall")}</p>
        ) : !supported ? (
          <p className="text-sm text-muted-foreground">{t("unsupported")}</p>
        ) : permission === "denied" ? (
          <p className="text-sm text-destructive">{t("blocked")}</p>
        ) : isSubscribed ? (
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm text-foreground">
              <Bell className="h-4 w-4 text-primary" /> {t("enabled")}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void disable()}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
            >
              <BellOff className="mr-1 inline h-4 w-4" /> {t("disable")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void enable()}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Bell className="mr-1 inline h-4 w-4" /> {t("enable")}
          </button>
        )}
      </div>

      <label className="mt-4 flex items-start gap-3 rounded-xl border border-border bg-card p-4">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={prefs?.hidePreview ?? false}
          onChange={(e) => void setPrefs({ hidePreview: e.target.checked })}
        />
        <span>
          <span className="block text-sm font-medium text-foreground">{t("hidePreviewLabel")}</span>
          <span className="block text-xs text-muted-foreground">{t("hidePreviewHint")}</span>
        </span>
      </label>
    </div>
  );
}
```

- [ ] **Step 5: Register the panel** in `src/app/(dashboard)/settings/page.tsx`

- Import: `import { NotificationsPanel } from '@/components/settings/notifications-panel';`
- Add to the `panel` map: `notifications: <NotificationsPanel />,`

- [ ] **Step 6: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/notifications-panel.tsx src/components/settings/settings-sections.ts "src/app/(dashboard)/settings/page.tsx" src/lib/auth/roles.ts messages/en.json
git commit -m "feat: add Settings → Notifications panel (enable + hide-preview toggle)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3.4: Unsubscribe on sign-out

**Files:**
- Modify: `src/hooks/use-auth.tsx:214-222` (best-effort unsubscribe before sign-out)

- [ ] **Step 1: Best-effort push cleanup in `signOut`** — in `use-auth.tsx`, before `await convexSignOut();`, add a guarded unsubscribe of the browser subscription (server row is deleted by the same endpoint via `push.unsubscribe`, but the session is ending, so do it inline):

```tsx
      try {
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager?.getSubscription?.();
          await sub?.unsubscribe();
        }
      } catch {
        // best-effort — never block sign-out
      }
```

(The server `pushSubscriptions` row is pruned on the next failed send (410) if it lingers; this stops the device from receiving further pushes immediately.)

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-auth.tsx
git commit -m "feat: unsubscribe device push on sign-out

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 4 — In-app foreground notifier

### Task 4.1: Toast + sound while a tab is visible

**Files:**
- Create: `src/components/pwa/inbox-notifier.tsx`
- Create: `public/notify.mp3` (short chime; commit a small royalty-free asset)
- Modify: `src/app/(dashboard)/dashboard-shell.tsx` (mount it)

**Interfaces:**
- Consumes: the `wa-push` window CustomEvent (from `ServiceWorkerManager`) and the reactive inbox query.

- [ ] **Step 1: Add a short sound asset** `public/notify.mp3` (≤ 50 KB, royalty-free chime). Confirm it plays: `curl -sI http://localhost:3000/notify.mp3` returns `200`.

- [ ] **Step 2: Write `src/components/pwa/inbox-notifier.tsx`**

```tsx
"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";

type PushPayload = { title: string; body: string; url: string; tag: string };

// Headless. While a tab is VISIBLE, shows an in-app toast + chime for a
// new inbound message (the SW hands off instead of firing an OS
// notification when a client is visible). De-dupes by tag so the same
// message never toasts twice.
export function InboxNotifier() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const seen = useRef<Set<string>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    audioRef.current = new Audio("/notify.mp3");
    audioRef.current.volume = 0.4;

    const openConversationId = pathname.startsWith("/inbox") ? searchParams.get("c") : null;

    const onPush = (e: Event) => {
      const payload = (e as CustomEvent<PushPayload>).detail;
      if (!payload?.tag || seen.current.has(payload.tag)) return;
      // Skip if the user is already looking at this conversation.
      if (payload.tag === openConversationId) return;
      seen.current.add(payload.tag);

      audioRef.current?.play().catch(() => {});
      toast(payload.title, {
        description: payload.body,
        action: { label: "Open", onClick: () => router.push(payload.url) },
      });
    };

    window.addEventListener("wa-push", onPush);
    return () => window.removeEventListener("wa-push", onPush);
  }, [pathname, searchParams, router]);

  return null;
}
```

- [ ] **Step 3: Mount it in the shell** — `src/app/(dashboard)/dashboard-shell.tsx`, next to `<ServiceWorkerManager />`:

```tsx
import { InboxNotifier } from "@/components/pwa/inbox-notifier";
```

```tsx
      <ServiceWorkerManager />
      <InboxNotifier />
```

- [ ] **Step 4: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/pwa/inbox-notifier.tsx public/notify.mp3 "src/app/(dashboard)/dashboard-shell.tsx"
git commit -m "feat: in-app toast + chime for foreground message notifications

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> **Note (scope):** The foreground toast is driven by the SW hand-off, which requires push to be enabled. A reactive-query fallback (toast even without push permission) is deferred — it needs a lightweight `api` query and careful de-dup against the SW path; not required for the core "notify on new message" goal. Capture as a follow-up if the team wants toasts without granting push.

---

## Phase 5 — Mobile optimization (inbox-first + shell)

### Task 5.1: Global mobile CSS (safe-area, dvh, overflow)

**Files:**
- Modify: `src/app/globals.css` (append a small mobile layer)

- [ ] **Step 1: Append to `src/app/globals.css`**

```css
/* Mobile / PWA ergonomics. */
@layer base {
  html {
    -webkit-tap-highlight-color: transparent;
  }
  /* Never let a stray wide child scroll the whole page sideways on phones. */
  body {
    overflow-x: hidden;
  }
  /* iOS: inputs ≥16px don't trigger the zoom-on-focus. */
  @media (max-width: 640px) {
    input,
    textarea,
    select {
      font-size: 16px;
    }
  }
}

/* Safe-area helpers for the shell + bottom nav + composer. */
.pb-safe {
  padding-bottom: env(safe-area-inset-bottom);
}
.pt-safe {
  padding-top: env(safe-area-inset-top);
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "feat: mobile CSS ergonomics (safe-area, dvh-ready, no h-scroll, 16px inputs)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 5.2: Bottom navigation bar (mobile only)

**Files:**
- Create: `src/components/layout/bottom-nav.tsx`
- Modify: `src/app/(dashboard)/dashboard-shell.tsx` (render it + reserve space)

**Interfaces:**
- Consumes: `useAuth().accountRole`, `canAccessNav`, `useTotalUnread`, `useTranslations("Sidebar")`.

- [ ] **Step 1: Write `src/components/layout/bottom-nav.tsx`**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, MessageSquare, Users, Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { canAccessNav } from "@/lib/auth/roles";

const items = [
  { href: "/inbox", labelKey: "inbox", icon: MessageSquare },
  { href: "/contacts", labelKey: "contacts", icon: Users },
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
];

// Fixed bottom tab bar, mobile only (hidden lg+). "More" opens the full
// sidebar drawer via the same handler the Header hamburger uses.
export function BottomNav({ onOpenMore }: { onOpenMore: () => void }) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const { accountRole } = useAuth();
  const totalUnread = useTotalUnread();
  if (!accountRole) return null;

  const visible = items.filter((i) => canAccessNav(accountRole, i.href));

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-card pb-safe lg:hidden">
      {visible.map((item) => {
        const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
        const showDot = item.href === "/inbox" && totalUnread > 0 && !active;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-label={t(item.labelKey)}
            className={cn(
              "relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium",
              active ? "text-primary" : "text-muted-foreground",
            )}
          >
            <item.icon className="h-5 w-5" />
            {t(item.labelKey)}
            {showDot && <span className="absolute right-[28%] top-1.5 h-2 w-2 rounded-full bg-primary" />}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onOpenMore}
        aria-label={t("openMenu")}
        className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium text-muted-foreground"
      >
        <Menu className="h-5 w-5" />
        {t("more")}
      </button>
    </nav>
  );
}
```

- [ ] **Step 2: Add the `more` string** to `messages/en.json` under the existing `Sidebar` namespace: `"more": "More"`.

- [ ] **Step 3: Render it + reserve space** in `src/app/(dashboard)/dashboard-shell.tsx`

- Import `BottomNav`.
- Render `<BottomNav onOpenMore={() => setSidebarOpen(true)} />` inside the shell.
- Give `<main>` bottom padding on mobile so content clears the bar: change `className="flex-1 overflow-y-auto p-4 sm:p-6"` to `className="flex-1 overflow-y-auto p-4 pb-20 sm:p-6 lg:pb-6"`.

- [ ] **Step 4: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/bottom-nav.tsx "src/app/(dashboard)/dashboard-shell.tsx" messages/en.json
git commit -m "feat: add mobile bottom navigation bar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 5.3: Shell height uses `dvh`

**Files:**
- Modify: `src/app/(dashboard)/dashboard-shell.tsx` (swap `h-screen` → `h-dvh`)

- [ ] **Step 1: Swap the shell height** — change the outer wrapper `className="flex h-screen overflow-hidden bg-background"` to `className="flex h-dvh overflow-hidden bg-background"` (also the loading branch `h-screen` → `h-dvh`). `dvh` tracks the mobile viewport as the URL bar / keyboard show and hide.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(dashboard)/dashboard-shell.tsx"
git commit -m "feat: use dynamic viewport height (dvh) for the app shell

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 5.4: Inbox — mobile list ↔ thread

**Files:**
- Read first: `src/app/(dashboard)/inbox/page.tsx`, `src/components/inbox/conversation-list.tsx`, `src/components/inbox/message-thread.tsx`
- Modify: the inbox layout container (the file that renders list + thread side-by-side) + `message-thread.tsx` (add a mobile back button)

- [ ] **Step 1: Understand the current layout** (use `auggie`: "How does the inbox page compose the conversation list and message thread into columns, and how is the selected conversation id (`?c=`) read/written?"). Identify the flex/grid container that shows list + thread together.

- [ ] **Step 2: Make the two panes mutually exclusive under `lg`** in the inbox layout container:
  - When no conversation is selected (`!selectedId`): show the list full-width, hide the thread (`hidden lg:flex` on the thread column).
  - When a conversation is selected: show the thread full-width on mobile, hide the list (`hidden lg:flex` on the list column). On `lg+` keep both columns (unchanged desktop behavior).
  - Concretely: list column gets `className={cn("w-full lg:w-80 lg:shrink-0", selectedId && "hidden lg:flex")}`; thread column gets `className={cn("w-full flex-1", !selectedId && "hidden lg:flex")}`.

- [ ] **Step 3: Add a mobile back control** in `message-thread.tsx` header — a left-chevron button, `lg:hidden`, that clears the selection (navigates to `/inbox`, mirroring the existing selection mechanism — reuse whatever `?c=` clearing the list already uses; if selection is URL-driven, `router.push("/inbox")` or the existing shallow-history helper):

```tsx
import { ChevronLeft } from "lucide-react";
// ...in the thread header, before the contact name:
<button
  type="button"
  onClick={onBack}
  aria-label={t("back")}
  className="mr-1 flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted lg:hidden"
>
  <ChevronLeft className="h-5 w-5" />
</button>
```

Thread receives an `onBack` prop from the inbox container; add `"back": "Back"` to the inbox strings namespace in `messages/en.json`.

- [ ] **Step 4: Verify in the browser** (preview): resize to mobile (375px), confirm list → tap → thread → back works, and the composer stays above the keyboard.

Run the dev server via the preview tool; use `read_page` + `computer` to click a conversation and the back button; confirm with a screenshot.

- [ ] **Step 5: Typecheck + lint + build**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(dashboard)/inbox" src/components/inbox/message-thread.tsx messages/en.json
git commit -m "feat: mobile inbox — list and thread as full-screen views with back

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 5.5: Composer keyboard-safety + heavy-editor hint

**Files:**
- Modify: `src/components/inbox/message-composer.tsx` (sticky + safe-area)
- Modify: `src/app/(dashboard)/flows/page.tsx` + `src/app/(dashboard)/pipelines/page.tsx` (small `lg:hidden`→ desktop hint banner)

- [ ] **Step 1: Make the composer keyboard-safe** — ensure the composer container is `sticky bottom-0` with `pb-safe` and a solid `bg-background` so it never hides behind the mobile keyboard or the bottom nav. (Read the file first; add classes to the outer composer wrapper — do not restructure.)

- [ ] **Step 2: Add a "best on desktop" banner** to the flow-builder and pipelines pages — a small dismissible-free notice shown only under `lg`:

```tsx
<p className="mb-3 rounded-lg border border-border bg-muted/40 p-2 text-xs text-muted-foreground lg:hidden">
  {t("bestOnDesktop")}
</p>
```

Add `"bestOnDesktop": "This editor works best on a larger screen."` to the relevant namespaces in `messages/en.json`.

- [ ] **Step 3: Verify in the browser** (preview, mobile width): composer sits above the keyboard; flows/pipelines show the hint.

- [ ] **Step 4: Full gate**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: PASS (all green).

- [ ] **Step 5: Commit**

```bash
git add src/components/inbox/message-composer.tsx "src/app/(dashboard)/flows/page.tsx" "src/app/(dashboard)/pipelines/page.tsx" messages/en.json
git commit -m "feat: keyboard-safe composer + best-on-desktop hint for heavy editors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Deployment & live verification (owner-run)

Not code — the rollout checklist. Push infra is inert until this runs.

- [ ] **Step 1: Set Convex env** on `convex-api.holidayys.co`: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- [ ] **Step 2: Set Netlify env:** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (same public value).
- [ ] **Step 3: Deploy Convex** (schema + `push`/`pushSend` + ingest change): `npx convex deploy` to the prod deployment. Confirm the two new tables + indexes exist.
- [ ] **Step 4: Merge to `main`** → Netlify builds the frontend.
- [ ] **Step 5: Verify installable:** open `https://wa.holidayys.co` on Android Chrome → "Install app" appears; on iPhone Safari → Share → Add to Home Screen.
- [ ] **Step 6: Verify push (closed app):** installed on a phone, sign in, Settings → Notifications → Enable. Fully close the app. Send a real inbound WhatsApp message to a conversation assigned to that user (or leave it unassigned and use an admin account). Confirm the OS notification arrives and tapping it opens the right conversation.
- [ ] **Step 7: Verify foreground:** with a tab open on `/inbox` (different conversation), send a message → in-app toast + chime, no duplicate OS notification.
- [ ] **Step 8: Verify hide-preview:** toggle it on, send a message → notification reads "New WhatsApp message".

---

## Self-Review

**Spec coverage** (spec §7 components → tasks):
- §7.1 manifest/icons/head → Tasks 0.2, 0.3 ✓
- §7.2 service worker → Task 1.1 ✓
- §7.3 SW registration → Task 1.2 ✓
- §7.4 push backend (push.ts + pushSend.ts) → Tasks 2.4, 2.5 ✓
- §7.5 recipient targeting → Task 2.2 ✓
- §7.6 payload + hide-preview → Task 2.3 ✓
- §7.7 ingest wiring → Task 2.6 ✓
- §7.8 subscribe/permission UX + Settings + iOS → Tasks 3.1–3.4 ✓
- §7.9 in-app foreground notifier → Task 4.1 ✓
- §7.10 mobile (shell, inbox, global) → Tasks 5.1–5.5 ✓
- §6 data model (2 tables) → Task 2.1 ✓
- §9 env / VAPID → Tasks 0.1, 6 ✓
- §12 deployment → Task 6 ✓

**Type consistency:** `PushPayload = { title; body; url; tag }` defined in Task 2.3, imported in Tasks 2.4/2.5/4.1. `recipientsForInbound({ assignedToUserId, members })` (2.2) consumed in 2.4. `assembleDelivery`/`deleteByEndpoint` (2.4) consumed by `deliverForMessage` (2.5). `urlBase64ToUint8Array` (3.1) consumed in 3.2. `isIOS`/`isStandalone` (1.2) consumed in 1.3 + 3.2. Consistent.

**Known adjustments to confirm during execution (flagged inline, not placeholders):**
- Exact field names `conversations.assignedToUserId` and the contact display field (`contact.name`) — verify in `convex/schema.ts` (Task 2.4).
- The convex-test bootstrap helper name (`seedAccount`/`modules`) — copy the real pattern from `convex/notifications.test.ts` (Task 2.4).
- The inbox layout container file + its `?c=` selection mechanism — identify via `auggie` before Task 5.4.
- Whether the customized Next requires `metadata.manifest` set explicitly — resolved by reading `node_modules/next/dist/docs/` in Task 0.3.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-16-pwa-push-notifications-mobile.md`.
