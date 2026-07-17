# Notification bell in header + recent-notifications popover

**Date:** 2026-07-16
**Status:** Approved (design)
**Author:** pairing session

## Summary

Move Notifications out of the left sidebar and into a **bell button in the
top-right header, next to the profile avatar**. Clicking the bell opens a
**popover** listing the most recent notifications, with a **"View all
notifications" link at the bottom** that navigates to the existing
`/notifications` page. The full page is unchanged.

## Goals

- Remove the `/notifications` nav item from the left sidebar.
- Add a header bell (next to the avatar, all breakpoints) with an unread
  **count badge capped at "9+"**.
- Bell opens a popover of the **6 most recent** notifications; each row is
  clickable (mark read + jump to the linked inbox conversation).
- Popover has a **"Mark all as read"** action and a bottom **"View all
  notifications"** link to `/notifications`.
- Preserve today's role visibility exactly (viewers never saw Notifications).

## Non-goals

- No change to the `/notifications` full page (kept as the "View all"
  destination).
- No change to the Convex backend (`notifications.list/markRead/markAllRead`
  already exist and are reactive).
- No new notification types; `conversation_assigned` remains the only type.
- No push/PWA notifications (that is a separate, unrelated effort).

## Current state (verified)

- **Backend** `convex/notifications.ts`: `list` (accountQuery, newest-first,
  scoped to `ctx.userId` + `ctx.accountId`), `markRead`, `markAllRead`. All
  reactive.
- **UI type** `src/types/index.ts`: `Notification` with `read_at?`,
  `conversation_id?`, `created_at`, `title`, `body?`, `type`. Adapter
  `toUiNotification` in `src/lib/convex/adapters.ts`.
- **Full page** `src/app/(dashboard)/notifications/page.tsx`: renders the list;
  row click → `markRead` + `router.push('/inbox?c=<conversationId>')`; has a
  local `TYPE_ICON` map and a "Mark all as read" button.
- **Sidebar** `src/components/layout/sidebar.tsx`: `navItems` includes
  `{ href: "/notifications", icon: Bell }`; renders a count badge via
  `useUnreadNotifications()`; filters items through `canAccessNav`.
- **Header** `src/components/layout/header.tsx`: top-right cluster is
  `<ModeToggle />` + profile `<DropdownMenu>` inside
  `<div className="flex items-center gap-1 sm:gap-2">`.
- **UI kit**: `Popover` (Base UI, controlled `open` supported) and
  `ScrollArea` exist in `src/components/ui/`.
- **Roles** `src/lib/auth/roles.ts`: `canAccessNav(role, "/notifications")` is
  true for owner/admin/supervisor/agent, **false for viewer**.
- **i18n**: single catalog `messages/en.json`; header uses the `Header`
  namespace via `next-intl`.
- `useUnreadNotifications` (`src/hooks/use-unread-notifications.ts`) is used
  **only** by the sidebar.

## Design

### Components & responsibilities

**`src/lib/notifications/shared.ts`** (new, tiny — shared to prevent drift)
- `TYPE_ICON: Record<NotificationType, LucideIcon>` — the icon-per-type map.
- `notificationHref(n: Notification): string | null` — returns
  `/inbox?c=<conversation_id>` when `conversation_id` is set, else `null`.
- Consumed by both the full page and the new bell so click-destination and
  iconography have one source of truth. (Page change is a behavior-preserving
  import swap.)

**`src/components/layout/notification-bell.tsx`** (new, client, self-contained)
- Reads `api.notifications.list` via the cached `useQuery`
  (`@/lib/convex/cached`), maps with `toUiNotification`.
- Derives `unreadCount` from that list (no separate query/hook).
- Renders a ghost icon button (styled like `ModeToggle`) with `Bell`; a red
  count badge overlays when `unreadCount > 0`, showing `min(count, "9+")`.
- `Popover` with **controlled `open` state** so it closes on row click / link
  navigation.
- Popover panel (~328px wide):
  - Header row: title + "Mark all as read" (calls `markAllRead`; disabled when
    `unreadCount === 0`; spinner while pending).
  - Body: up to **6** most-recent rows in a `ScrollArea`. Row = type icon +
    title + truncated body + relative time (`date-fns formatDistanceToNow`) +
    unread dot & accent tint when `!read_at`. Row click → `markRead(id)` (only
    if unread) → navigate to `notificationHref(n)` if non-null → close popover.
  - Loading state: centered spinner (list `undefined`).
  - Empty state: bell glyph + "No notifications yet".
  - Footer: full-width **"View all notifications"** `Link` → `/notifications`,
    closes popover on click.
- Errors from mutations surfaced with `toast.error(convexErrorMessage(err))`,
  matching the page.

**`src/components/layout/header.tsx`** (edit)
- Import and render `<NotificationBell />` **between `<ModeToggle />` and the
  profile `<DropdownMenu>`** (bell sits next to the avatar).
- The bell component internally gates its own visibility on
  `accountRole && canAccessNav(accountRole, "/notifications")` (uses
  `useAuth()`), so viewers render nothing — identical to today's sidebar
  behavior. (Header already has `accountRole`; the bell reads it itself to stay
  self-contained.)

**`src/components/layout/sidebar.tsx`** (edit)
- Remove the `{ href: "/notifications", labelKey: "notifications", icon: Bell }`
  entry from `navItems`.
- Remove now-unused: `Bell` import, `useUnreadNotifications` import + call,
  `unreadNotifications` var, and the `showNotificationBadge` branch/JSX.
- Leave the inbox unread dot and everything else untouched.

**`src/hooks/use-unread-notifications.ts`** (delete)
- Unused after the sidebar edit; count now derived inside the bell.

**`src/app/(dashboard)/notifications/page.tsx`** (minimal edit)
- Replace the local `TYPE_ICON` with the import from
  `@/lib/notifications/shared`. Behavior unchanged. (Optionally adopt
  `notificationHref` in `handleClick`; keep the rest of the page as-is.)

**`messages/en.json`** (edit)
- Add a `Notifications` namespace (or extend `Header`) with:
  `bellLabel` ("Notifications"), `markAllRead` ("Mark all as read"),
  `viewAll` ("View all notifications"), `empty` ("No notifications yet").

### Data flow

`api.notifications.list` (reactive Convex subscription, already scoped to the
caller) → cached `useQuery` in the bell → `toUiNotification[]` → slice top 6 for
the popover; `unreadCount` from the full array for the badge. `markRead` /
`markAllRead` mutations patch `readAt`; the reactive query updates the badge and
rows automatically — no optimistic wiring.

### Accessibility

- Bell button: `aria-label` ("Notifications"); badge count is decorative
  (`aria-hidden`) with the unread state conveyed by the label, or an
  `aria-label` like "Notifications, 3 unread".
- Popover follows Base UI focus semantics (focus trap, Esc to close).
- Rows are `<button>`s; the footer is a real `<Link>`.

## Edge cases

- **Viewer role**: bell not rendered (no notifications route access). Verified
  via `canAccessNav`.
- **>9 unread**: badge shows "9+".
- **0 unread**: no badge; "Mark all as read" disabled.
- **Empty list**: empty state in popover; badge absent.
- **Notification with no `conversation_id`**: row still marks read on click but
  does not navigate (`notificationHref` returns null).
- **Loading**: badge hidden (count 0 while `undefined`), popover shows spinner.
- **Navigation closing**: controlled `open=false` on row/link click so the
  popover doesn't linger over the new route.

## Testing

The `src` vitest project runs in a plain `node` environment with **no
jsdom/testing-library** (the sole existing `.test.tsx` uses
`renderToStaticMarkup`). Introducing an interactive DOM test harness is out of
scope, so the real logic is extracted into pure functions and unit-tested
(TDD), and the thin view is verified by typecheck + production build.

Unit tests — `src/lib/notifications/shared.test.ts`:

- `notificationHref` → `/inbox?c=<id>` when a conversation is linked; `null`
  otherwise (drives both the page's and the bell's click-through).
- `formatUnreadBadge` → hidden (`null`) at 0; exact number 1–9; "9+" above 9.

The component itself (Popover open/close, row rendering, mark-all wiring,
viewer gating) is a thin consumer of those tested helpers plus existing
reactive Convex hooks; it is covered by `tsc --noEmit`, `eslint`, and a full
`next build`, and matches the approved mockup. The interactive, logged-in
visual pass is owner-side (the app is auth-gated).

Plus the existing suite must stay green (`tsc`, lint, `vitest run --project
src`, `next build`).

## Rollout

Additive + a nav relocation; no backend or schema change, so no `convex deploy`
required. Frontend-only (Netlify) once merged. Feature branch off `main`.

## Open decisions (resolved)

- Mark-read behavior: **manual + "Mark all as read"** (not auto-clear).
- Badge: **count with "9+" cap**.
- Full page: **unchanged**.
- Mobile: **bell always visible**.
- Shared helper: **yes** (page gets the import swap).
