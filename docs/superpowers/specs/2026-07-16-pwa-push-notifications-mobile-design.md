# PWA + Web Push + Mobile Optimization — Design Spec

**Date:** 2026-07-16
**Status:** Draft for review
**Scope:** Turn Holidayys WA CRM into an installable Progressive Web App with true Web Push notifications for inbound WhatsApp messages, plus a focused mobile optimization of the inbox and app shell.

---

## 1. Summary

Make the CRM installable and "native-like" on phones:

1. **Installable PWA** — web app manifest, icons, service worker, install affordance (incl. iOS Add-to-Home-Screen guidance).
2. **True Web Push** — an inbound WhatsApp message triggers an OS-level push notification on each recipient's device **even when the app is fully closed**, delivered via the browser's push service and a service worker.
3. **RBAC-aware targeting** — the assigned agent is notified; if the conversation is unassigned, owners + admins + supervisors are notified.
4. **In-app foreground alerts** — while a tab is open, new messages surface as a toast + sound instead of a redundant OS notification.
5. **Mobile optimization (inbox-first)** — the inbox and app shell become first-class on phones (bottom nav, list↔thread navigation, safe-area, keyboard-aware composer). Other sections are made "usable" (no horizontal overflow); heavy editors (flow-builder, kanban) stay desktop-oriented.

## 2. Locked decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Notification reach | **True Web Push** (works when app closed/backgrounded; iOS requires installed PWA) |
| Who is notified for a new inbound message | **Assigned agent; else owners + admins + supervisors** |
| Mobile optimization breadth | **Inbox-first + app shell**; other sections merely usable; flow-builder/kanban stay desktop-oriented |
| Notification content | **Contact name + message preview**, with a per-user **"Hide message preview"** toggle (generic text when on) |

## 3. Goals / Non-goals

**Goals**
- Reliable push for inbound messages, closed-app included, on Android/desktop Chromium + Firefox, and on iOS 16.4+ **when installed to the home screen**.
- Zero added latency or failure risk to the existing ingestion path (push is best-effort, off the hot path).
- Respect existing tenant isolation (account-scoping) and RBAC (assignment, phone-masking, viewer restrictions).
- Inbox usable one-handed on a phone.

**Non-goals**
- No aggressive offline caching of authed app data (real-time CRM; stale authed pages are a hazard — see the stale-chunk incident documented in `next.config.ts`).
- No rework of the flow-builder (xyflow) or pipeline kanban for touch.
- No native app / app-store packaging.
- No third-party push vendor (OneSignal/Firebase Messaging SDK). We use the open **Web Push protocol** directly with our own VAPID keys.

## 4. Architecture

Every inbound message already passes through one Convex choke point. Push hangs off it as a best-effort fan-out, exactly like the existing engines.

```
Meta Cloud API
  │  POST (signed)
  ▼
src/app/api/whatsapp/webhook/route.ts     ← verifies x-hub-signature-256 (unchanged)
  │  forwards raw bytes + proxy secret
  ▼
convex/http.ts  POST /whatsapp/ingest
  │  scheduler.runAfter(0, ingest.processInbound)
  ▼
convex/ingest.ts  processInbound  ────────────────────────────────┐
  ├─ ingestInbound (persist; dedupe by wamid)                      │
  ├─ flowsEngine.dispatchInbound                                   │
  ├─ automations / aiReply                                         │
  ├─ webhookDelivery.dispatch("message.received")                  │
  └─ pushSend.deliverForMessage   ← NEW (best-effort, runBestEffort)│
        │  resolve recipients (assigned → else owner/admin/supervisor)
        │  per recipient: load prefs + subscriptions, build payload
        ▼
     convex/pushSend.ts  ("use node")  web-push.sendNotification(VAPID, encrypted payload)
        │                                   │ prune subscription on 404/410
        ▼                                   ▼
     Browser push service (FCM / Mozilla / Apple)
        ▼
     public/sw.js  "push" event
        ├─ visible client exists?  → postMessage to page (in-app toast); no OS notification
        └─ else                    → showNotification(name + preview, data.url=/inbox?c=…)
                                        "notificationclick" → focus/open the conversation
```

Client side, once (per device), after a user gesture:

```
useWebPush() → register /sw.js → Notification.requestPermission()
  → PushManager.subscribe({ applicationServerKey: VAPID public })
  → push.subscribe mutation stores { endpoint, p256dh, auth } in Convex
```

## 5. Global constraints (must hold for every task)

- **Customized Next.js 16 fork.** Per `wacrm2.0/AGENTS.md`, **read the relevant guide under `node_modules/next/dist/docs/` before using any Next API** — specifically the metadata / manifest / viewport / file-conventions guides before writing `manifest.ts`, `appleWebApp`, `viewport`, or icon files. Do not assume upstream Next behavior.
- **Code retrieval via Augment (`auggie`) MCP first** (project `CLAUDE.md`).
- **Single locale.** Only `messages/en.json` exists — every new UI string goes there under an appropriate namespace.
- **No unrelated refactoring.** Touch only what the feature needs; follow existing patterns (account-scoped Convex fns, `insertNotification`-style shared helpers, base-ui components, `softBadge`, `cn`).
- **Convex is a separate manual deploy** from Netlify. New tables/indexes/actions require `convex deploy` to `convex-api.holidayys.co`. `convex dev`/`deploy`/`codegen` all push to the single live prod deployment — build offline by hand-editing `convex/_generated/` where possible; `convex-test` runs offline.
- **CSP.** `next.config.ts` sets a strict CSP. Verify/extend it for: `worker-src 'self'` (service worker), `manifest-src 'self'`, `img-src 'self' data:` (icons/badge). The push subscription itself is browser-internal (no page fetch to the push service); the subscribe RPC to Convex is already covered by `connect-src`.
- **No PII in logs.** Push failures log endpoint status codes, never message text or phone numbers.

## 6. Data model changes (`convex/schema.ts`)

Two new account-scoped tables. Both are additive (no migration of existing rows).

```ts
// One Web Push subscription = one browser/device for one user.
pushSubscriptions: defineTable({
  accountId: v.id("accounts"),
  userId: v.id("users"),
  endpoint: v.string(),          // unique per browser push channel
  p256dh: v.string(),            // client public key (base64url)
  auth: v.string(),              // client auth secret (base64url)
  userAgent: v.optional(v.string()),
  createdAt: v.number(),
  lastSeenAt: v.number(),        // refreshed on re-subscribe / successful send
})
  .index("by_endpoint", ["endpoint"])   // upsert + prune by endpoint
  .index("by_user", ["userId"])         // load a recipient's devices
  .index("by_account", ["accountId"]),

// Per-user, per-account notification preferences. Absent row = defaults.
notificationPreferences: defineTable({
  accountId: v.id("accounts"),
  userId: v.id("users"),
  pushEnabled: v.boolean(),      // master mute for this user (default true)
  hidePreview: v.boolean(),      // true = generic "New WhatsApp message" (default false)
})
  .index("by_user_account", ["userId", "accountId"]),
```

We deliberately **do not** overload the existing `notifications` table (its `type` is the single literal `conversation_assigned` and it drives the in-app Notifications page). Message pushes are ephemeral OS notifications, not persisted inbox items.

## 7. Component design

Each unit has one purpose, a defined interface, and is independently testable.

### 7.1 PWA manifest + icons + head metadata
- **Files:** `src/app/manifest.ts` (Next metadata route — verify shape against `node_modules/next/dist/docs/`), `public/icon-192.png`, `public/icon-512.png`, `public/icon-maskable-512.png`, `public/apple-touch-icon.png` (180×180), `public/badge-72.png` (monochrome, Android status bar); extend `metadata` + `viewport` in `src/app/layout.tsx`.
- **Manifest:** `name: "Holidayys WA CRM"`, `short_name: "Holidayys"`, `id: "/"`, `start_url: "/inbox"`, `scope: "/"`, `display: "standalone"`, `orientation: "portrait"`, `background_color: "#020617"`, `theme_color: "#020617"`, icons (192/512 + maskable 512 with `purpose: "maskable"`).
- **Layout metadata:** add `manifest` link, `appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Holidayys" }`, apple-touch-icon; set `viewport.viewportFit: "cover"` and per-scheme `themeColor` (light `#ffffff` / dark `#020617`).
- **Icons** are generated from the existing brand mark (white message glyph on the primary square used in `header.tsx`); maskable variant carries the ~20% safe-area padding.
- **Dependencies:** none at runtime. Icons are static.
- **Test:** `next build` emits manifest + links; manual Lighthouse "installable" check.

### 7.2 Service worker (`public/sw.js`)
- **Purpose:** receive pushes, show/route notifications, minimal offline fallback. Plain JS, served at `/sw.js` (root scope). Hand-rolled — **no `next-pwa`/Serwist** (avoids wrapping the customized `next.config.ts` and its deliberate Cache-Control policy; we don't want precaching).
- **Events:**
  - `install` → `skipWaiting()`. `activate` → `clients.claim()` + drop old caches by version key.
  - `push` → parse JSON. `clients.matchAll({type:"window", includeUncontrolled:true})`; if any client `visibilityState === "visible"`, `postMessage({type:"wa-push", payload})` to clients and **return without** `showNotification` (Chrome exempts the visible-client case from the `userVisibleOnly` default-notification rule); else `showNotification(title, { body, tag: conversationId, renotify: true, icon, badge, data: { url } })`.
  - `notificationclick` → `notification.close()`; focus an existing client on the same origin and navigate it to `data.url`, else `clients.openWindow(data.url)`.
  - `fetch` → network-first for navigations with a cached `/offline` fallback; **never** intercept/cache Convex or `/api/*` requests. Conservative — presence of a fetch handler also satisfies installability.
- **Versioning:** a `SW_VERSION` constant bumped on change; `?v=` cache-bust on registration.
- **Test:** logic is exercised via unit tests over extracted pure helpers (`buildNotificationOptions`, `pickClientToFocus`) in `src/lib/push/`; SW runtime behavior verified manually in-browser.

### 7.3 Service worker registration (`src/components/pwa/service-worker-manager.tsx`)
- **Purpose:** headless client component mounted once in `dashboard-shell.tsx`. Registers `/sw.js`, listens for `controllerchange`/updates (toast "Update available — reload"), and relays SW `postMessage` to the in-app notifier.
- **Dependencies:** browser `navigator.serviceWorker`. No-op when unsupported.

### 7.4 Web Push backend
- **`convex/push.ts`** (account-scoped):
  - `subscribe({ endpoint, p256dh, auth, userAgent? })` — upsert by `by_endpoint` for `ctx.userId`/`ctx.accountId`; refresh `lastSeenAt`.
  - `unsubscribe({ endpoint })` — delete the row (logout / permission revoked).
  - `getPreferences()` / `setPreferences({ pushEnabled?, hidePreview? })` — read/write `notificationPreferences` (upsert; any role, self only).
  - `internal.push.listSubscriptionsForUsers({ userIds })` and `internal.push.deleteByEndpoint({ endpoint })` — used by the sender.
- **`convex/pushSend.ts`** (`"use node"` action) — `internal.pushSend.deliverForMessage({ accountId, conversationId })`. A Node action has **no direct `ctx.db`**, so every data touch below is a `ctx.runQuery`/`ctx.runMutation` into `push.ts`/`conversations`/`memberships`:
  1. Load conversation + account members → resolve recipients via `recipientsForInbound` (see 7.5). Skip if none.
  2. For each recipient: load `notificationPreferences` (default enabled, preview shown); skip if `pushEnabled === false`.
  3. Build the payload (title/body per preview preference — see 7.6); load the recipient's subscriptions.
  4. `web-push.sendNotification(subscription, JSON.stringify(payload), { vapidDetails })`. On `404`/`410` → `internal.push.deleteByEndpoint`. Other errors logged (status only), non-fatal.
  - **Data access shape:** one internal query returns everything the send needs (`{ recipients, prefs, subscriptions }`) so the Node action stays a thin send-loop; pruning is one internal mutation. Keeps the recipient/payload logic in the testable default runtime, not the Node action.
  - **VAPID** from Convex env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
  - **Fallback** (only if the self-hosted Convex Node runtime can't run `web-push`): a Next.js API route on Netlify performs the send; Convex calls it with the proxy secret. Preferred path is the Node action (no extra hop, secrets stay in Convex).
- **Dependencies:** `web-push` (prod), `@types/web-push` (dev).

### 7.5 Recipient targeting (`convex/lib/pushRecipients.ts`, pure + unit-tested)
- `recipientsForInbound({ assignedToUserId, members }): Id<"users">[]`
  - If `assignedToUserId` set → `[assignedToUserId]`.
  - Else → all members with role in `{ owner, admin, supervisor }`. **`owner` is included as the top-level admin** (the account owner is a super-admin); your choice said "admins/supervisors" and this reads owner into that set. Flag if you'd rather exclude the owner.
  - Never includes `viewer`/`agent` for unassigned (they act only on their own assignments).
  - De-duplicated; excludes nobody based on presence (offline users still get a push — that's the point).
- The Convex side loads members via `memberships` `by_account` and passes them in, keeping the decision logic pure.

### 7.6 Notification payload + preview privacy (`src/lib/push/payload.ts`, pure + unit-tested)
- `buildInboundPayload({ contactName, contentType, text, conversationId, hidePreview }): PushPayload`
  - `hidePreview === true` → `{ title: "Holidayys WA CRM", body: "New WhatsApp message" }`.
  - Else → `{ title: contactName || "New message", body: previewFor(contentType, text) }` where `previewFor` truncates text to ~120 chars and maps non-text types to labels ("📷 Photo", "🎤 Voice message", "📄 Document", "📍 Location", …).
  - Always `data.url = "/inbox?c=" + conversationId`, `tag = conversationId`.
  - Contact name respects existing display rules; **no raw phone numbers** in the payload (aligns with the phone-masking RBAC work).

### 7.7 Ingest wiring (`convex/ingest.ts`)
- After a non-duplicate `ingestInbound`, add one `runBestEffort("pushSend.deliverForMessage", …)` block scheduling `internal.pushSend.deliverForMessage({ accountId, conversationId })`, mirroring the existing `webhookDelivery.dispatch` block. Only for **customer** inbound (never bot/agent echoes). A push failure never blocks ingestion or the other engines.

### 7.8 Client subscribe + permission UX (`src/hooks/use-web-push.ts` + `src/components/pwa/*`)
- `useWebPush()` returns `{ supported, permission, isSubscribed, isIOSNeedsInstall, enable(), disable() }`.
  - `enable()` (user-gesture only): `requestPermission()` → `subscribe(applicationServerKey = urlBase64ToUint8Array(NEXT_PUBLIC_VAPID_PUBLIC_KEY))` → `push.subscribe`.
  - Detects iOS Safari **not** in standalone mode → surfaces install instructions instead of an enable button (Apple allows push only for installed PWAs; there is no `beforeinstallprompt` on iOS).
  - On logout: `disable()` (unsubscribe + `push.unsubscribe`).
- **Surfaces:**
  - **Settings → Notifications** panel (`src/components/settings/notifications-panel.tsx`): enable/disable this device, the **Hide message preview** toggle, master mute, per-device list, iOS install help. Registered in `settings-sections.ts` (new `notifications` section, group `account`, `Bell` icon; accessible to all roles for their own device).
  - **One-time inline nudge** in the inbox (dismissible, stored in `localStorage`) prompting enablement — never an auto-prompt on load.
  - **Install affordance** (`src/components/pwa/install-prompt.tsx`): captures `beforeinstallprompt` (Chromium) for an "Install app" button; iOS shows the manual Add-to-Home-Screen sheet.
- **`urlBase64ToUint8Array`** helper is pure + unit-tested.

### 7.9 In-app foreground notifier (`src/components/pwa/inbox-notifier.tsx`)
- Headless, mounted in `dashboard-shell.tsx`. While the tab is **visible**, a new inbound message (in a conversation the user may see, not the one currently open) shows a **sonner toast** (click → open conversation) + a short **sound** + an unread count in `document.title`.
- **Two sources, de-duplicated by message id (seen-set):**
  1. Service-worker `postMessage` (fires when push is enabled and a client is visible — the SW handed off instead of showing an OS notification).
  2. A lightweight reactive Convex query (`api.push.latestInboundForViewer` or a reuse of the inbox list) so the toast still works when the user has **not** granted push permission.
- Suppressed entirely for the conversation currently open (the message already streams in live).

### 7.10 Mobile optimization (inbox-first + shell)
- **App shell** (`dashboard-shell.tsx`, `header.tsx`, new `src/components/layout/bottom-nav.tsx`): add a **bottom tab bar** under `md` (Inbox / Contacts / Dashboard / More), role-filtered via the existing `canAccessNav`; keep the drawer for the full nav ("More"). Apply `env(safe-area-inset-*)` padding (bottom nav, composer, header); switch the shell height to `100dvh` so the mobile keyboard doesn't crop it.
- **Inbox** (`src/components/inbox/*`): under `md`, render **either** the conversation list **or** the thread (not the 3-column desktop layout), driven by the existing `?c=` selection with a back button (shallow URL via `history.replaceState`, matching the existing inbox click-load pattern). Composer sticks above the keyboard; tap targets ≥44px; text inputs ≥16px to prevent iOS zoom. The contact panel is already a slide-over.
- **Global polish** (`globals.css`): prevent horizontal overflow; make wide tables/kanban scroll within their own container on small screens; tap-highlight-color; momentum scroll.
- **Heavy editors** (flows, pipelines): a small "Best experienced on desktop" hint under `md`; no deep touch rework (per scope).

## 8. Security & privacy
- **Payload confidentiality:** Web Push payloads are encrypted client-side (aes128gcm) using the subscription's `p256dh`/`auth`; the push service relays ciphertext. Text is only visible on the recipient's own device (lock screen) — hence the **Hide message preview** toggle.
- **VAPID** private key lives only in Convex env; public key is safe to expose (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`).
- **Tenant isolation:** subscriptions and preferences are account-scoped; the sender only ever loads subscriptions for resolved recipients of the **same** account.
- **RBAC:** targeting reuses assignment + role; no notification is sent to a user who couldn't open the conversation. No raw phone numbers in payloads or logs.
- **Subscription hygiene:** dead endpoints pruned on 404/410; `unsubscribe` on logout.
- **CSP** extended minimally as in §5.

## 9. Environment & one-time setup
- Generate keys once: `npx web-push generate-vapid-keys`.
- **Convex deployment env:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (e.g. `mailto:admin@holidayys.co`).
- **Netlify env:** `NEXT_PUBLIC_VAPID_PUBLIC_KEY` (same public value).
- Add `web-push` + `@types/web-push` to `package.json`.

## 10. Phasing (each phase independently shippable)

- **Phase 0 — Installable shell:** manifest, icons, layout metadata/viewport, CSP tweak. Deliverable: app is installable; passes Lighthouse PWA.
- **Phase 1 — Service worker + registration + install UX:** `public/sw.js`, `service-worker-manager.tsx`, `install-prompt.tsx`. Deliverable: SW active; install button (Chromium) + iOS instructions.
- **Phase 2 — Push backend + ingest wiring:** schema (both tables) + `_generated` edits, `push.ts`, `pushSend.ts`, `pushRecipients.ts`, `payload.ts`, `ingest.ts` hook. Deliverable: an inbound message sends a push to a hard-subscribed test device.
- **Phase 3 — Client subscribe/permission + Settings:** `use-web-push.ts`, `notifications-panel.tsx`, `settings-sections.ts` entry, inbox nudge. Deliverable: a user can enable notifications and set the preview toggle end-to-end.
- **Phase 4 — In-app foreground:** `inbox-notifier.tsx` + SW handoff + reactive fallback + sound asset. Deliverable: open-tab toasts, no double-notify.
- **Phase 5 — Mobile inbox + shell:** bottom nav, inbox list↔thread, safe-area/dvh, global polish. Deliverable: one-handed inbox on a phone.

## 11. Testing strategy
- **TDD with Vitest + `convex-test` (offline)** for the pure/testable cores:
  - `recipientsForInbound` — assigned → agent; unassigned → owner/admin/supervisor only; dedupe.
  - `buildInboundPayload` — preview vs. hidden; per-content-type labels; truncation; url/tag; no phone numbers.
  - `push.subscribe` upsert (same endpoint twice = one row, `lastSeenAt` refreshed); `unsubscribe`; preferences upsert; cross-account denial.
  - `pushSend.deliverForMessage` — recipient resolution + per-recipient preference gating + prune-on-410 (mock the `web-push` send); no-op when no subscriptions.
  - `urlBase64ToUint8Array`; SW pure helpers (`buildNotificationOptions`, `pickClientToFocus`).
- **Manual / browser** (auth-gated, real push services can't be unit-tested): install flow, permission grant, closed-app push receipt, `notificationclick` routing, iOS installed-PWA push, mobile inbox layout, keyboard-aware composer, dark/light.
- Full suite (`tsc`, `lint`, `vitest`, `next build`) green before each phase merges.

## 12. Deployment & rollout
- Convex changes (tables, indexes, `push.ts`, `pushSend.ts`) require a **manual `convex deploy`** to `convex-api.holidayys.co` — separate from the Netlify build. Set VAPID env on Convex **before** deploying the sender. Set `NEXT_PUBLIC_VAPID_PUBLIC_KEY` on Netlify before the frontend build.
- Prefer building `convex/_generated/` offline (new tables → `schema.ts` + generated edits; new modules → `api.d.ts` additions) per the project's codegen-pushes-prod gotcha; run the offline `convex-test` suite.
- Land per phase; each phase is safe to ship because push is best-effort and the UI surfaces are opt-in.
- Post-deploy: owner enables notifications on a device, installs the PWA on an iPhone (required for iOS push), and verifies a real inbound message pushes while the app is closed.

## 13. Risks & mitigations
- **iOS constraints:** push only for installed PWAs on 16.4+; mitigated by explicit install guidance and capability detection.
- **Self-hosted Convex Node action + `web-push`:** validated early in Phase 2; Next.js API-route fallback documented if the runtime can't bundle it.
- **CSP regressions:** SW/manifest/icon directives verified in Phase 0/1 (`worker-src`, `manifest-src`, `img-src data:`).
- **Double-notify:** solved by the SW visible-client handoff + seen-set de-dup in the notifier.
- **Notification fatigue:** targeting limits recipients; master mute + (future) quiet hours available.

## 14. Out of scope (future)
- Assignment/mention pushes (the generic `pushSend.deliver` makes this a small follow-on — wire `conversations.assign` to it).
- Quiet hours / per-conversation mute.
- Badging API (app-icon unread count).
- Offline composing / background sync of outbound messages.
- Touch rework of flow-builder and pipeline kanban.
