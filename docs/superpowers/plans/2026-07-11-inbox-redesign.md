# Inbox Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Inbox easier to use — a collapsible left menu, an on-demand slide-over contact panel opened by clicking the chat header, and a richer editable contact panel with `+`-formatted phone numbers.

**Architecture:** All UI changes are client React components under `src/`. Contact data gains optional Convex fields (backward-compatible, no migration). A pure display helper normalizes phone numbers to `+E.164`. The contact panel becomes an absolutely-positioned slide-over inside the thread's center column, opened by turning the thread-header name/number into a button.

**Tech Stack:** Next.js (customized fork), React client components, Convex (self-hosted), `@base-ui/react` (tooltip/dropdown primitives), `next-intl` (i18n), `lucide-react` icons, Vitest + `convex-test`.

## Global Constraints

- **Customized Next.js.** Per `wacrm2.0/AGENTS.md`, read the relevant guide under `node_modules/next/dist/docs/` before using any Next-specific API. (Most tasks here are plain React client components and need none.)
- **Code retrieval** goes through the Augment (`auggie`) MCP server first (project `CLAUDE.md`).
- **No new dependencies.** Reuse the existing `@/components/ui/tooltip` (base-ui) and existing `phone-utils`; do not add a phone library.
- **Single locale.** Only `messages/en.json` exists — add every new UI string there, under the existing namespace it belongs to.
- **Hydration-safe localStorage.** Any persisted UI default must render the server default first, then reconcile in a mount effect (mirror `inbox/page.tsx`'s existing `CONTACT_PANEL_STORAGE_KEY` pattern). Keep the `// eslint-disable-next-line react-hooks/set-state-in-effect` comment on one-shot mount syncs.
- **Phones stored as `+E.164`.** New/edited numbers are normalized to `+<digits>` (never `00`, never bare). Existing stored numbers are formatted at render time; no data migration.
- **New contact fields are optional** everywhere: `v.optional(v.string())` in Convex, `?:` in the UI `Contact` type (snake_case).
- **Verification gates per UI task:** `npm run typecheck` (`tsc --noEmit`) and `npm run lint` must pass. Logic tasks add Vitest tests (`npm run test`).

---

### Task 1: `formatPhoneIntl` phone display helper

**Files:**
- Modify: `src/lib/whatsapp/phone-utils.ts` (append one function)
- Test: `src/lib/whatsapp/phone-utils.test.ts` (append a `describe` block)

**Interfaces:**
- Produces: `formatPhoneIntl(phone: string): string` — returns `""` for blank input, otherwise `"+" + digits` with a leading `00` rewritten to `+`. Consumed by Tasks 5 and 6.

- [ ] **Step 1: Write the failing test.** Append to `src/lib/whatsapp/phone-utils.test.ts`:

```ts
describe("formatPhoneIntl", () => {
  it("prefixes a digits-only international number with +", () => {
    expect(formatPhoneIntl("971501234567")).toBe("+971501234567");
  });
  it("strips separators but keeps the leading +", () => {
    expect(formatPhoneIntl("+971 50 123 4567")).toBe("+971501234567");
  });
  it("rewrites a 00 international prefix to +", () => {
    expect(formatPhoneIntl("00971501234567")).toBe("+971501234567");
  });
  it("returns an empty string for blank input", () => {
    expect(formatPhoneIntl("")).toBe("");
    expect(formatPhoneIntl("   ")).toBe("");
  });
});
```

Also add `formatPhoneIntl` to the existing top `import { ... } from "./phone-utils"` line in that test file.

- [ ] **Step 2: Run test to verify it fails.**

Run: `npm run test -- phone-utils`
Expected: FAIL — `formatPhoneIntl is not a function` / not exported.

- [ ] **Step 3: Implement.** Append to `src/lib/whatsapp/phone-utils.ts`:

```ts
/**
 * Format a phone number for display in international `+E.164` form:
 * strip every non-digit, rewrite a leading `00` international prefix to
 * `+`, and prefix the result with `+`. Never returns bare digits or a
 * `00` prefix. Blank input returns "". Also used to normalize a
 * user-entered number to its stored form (prefill the input with the
 * default country code, e.g. "971", so a plain entry becomes +971…).
 */
export function formatPhoneIntl(phone: string): string {
  if (!phone || !phone.trim()) return "";
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits ? `+${digits}` : "";
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `npm run test -- phone-utils`
Expected: PASS (all `formatPhoneIntl` cases + existing cases).

- [ ] **Step 5: Commit.**

```bash
git add src/lib/whatsapp/phone-utils.ts src/lib/whatsapp/phone-utils.test.ts
git commit -m "feat(inbox): add formatPhoneIntl phone display helper"
```

---

### Task 2: Backend — extended contact fields (schema + update mutation)

**Files:**
- Modify: `convex/schema.ts:40-49` (contacts table)
- Modify: `convex/contacts.ts` (the `update` mutation, ~lines 265-311)
- Test: `convex/contacts.test.ts` (append one test)

**Interfaces:**
- Produces: `contacts` docs may carry optional `altPhone`, `address`, `city`, `country`, `nationality`, `preferredDestination`, `notes`. `api.contacts.update` accepts all of them. Consumed by Tasks 3 and 6.

- [ ] **Step 1: Write the failing test.** Append to `convex/contacts.test.ts`:

```ts
test("update persists the extended contact fields", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Ana",
    email: "ana@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "+971501234567",
    name: "Guest",
  });

  await asUser.mutation(api.contacts.update, {
    contactId,
    altPhone: "+971559876543",
    address: "12 Marina Walk",
    city: "Dubai",
    country: "UAE",
    nationality: "Indian",
    preferredDestination: "Maldives",
    notes: "VIP — prefers window seat",
  });

  const doc = await t.run((ctx) => ctx.db.get(contactId));
  expect(doc?.altPhone).toBe("+971559876543");
  expect(doc?.address).toBe("12 Marina Walk");
  expect(doc?.city).toBe("Dubai");
  expect(doc?.country).toBe("UAE");
  expect(doc?.nationality).toBe("Indian");
  expect(doc?.preferredDestination).toBe("Maldives");
  expect(doc?.notes).toBe("VIP — prefers window seat");
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `npm run test -- contacts`
Expected: FAIL — `update` rejects unknown args (Convex ArgumentValidationError) / schema rejects the extra fields.

- [ ] **Step 3: Extend the schema.** In `convex/schema.ts`, replace the contacts field block (currently ending at `avatarUrl: v.optional(v.string()),` on line 48) so it reads:

```ts
    avatarUrl: v.optional(v.string()),
    // Extended CRM detail — all optional, edited from the inbox contact
    // panel. Additive/backward-compatible; no migration.
    altPhone: v.optional(v.string()),
    address: v.optional(v.string()),
    city: v.optional(v.string()),
    country: v.optional(v.string()),
    nationality: v.optional(v.string()),
    preferredDestination: v.optional(v.string()),
    notes: v.optional(v.string()),
  })
```

(Leave the `.index(...)`/`.searchIndex(...)` chain that follows unchanged.)

- [ ] **Step 4: Extend the `update` mutation.** In `convex/contacts.ts`, replace the `update` mutation's `args` and the `patch` type declaration. New `args`:

```ts
  args: {
    contactId: v.id("contacts"),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    company: v.optional(v.string()),
    phone: v.optional(v.string()),
    altPhone: v.optional(v.string()),
    address: v.optional(v.string()),
    city: v.optional(v.string()),
    country: v.optional(v.string()),
    nationality: v.optional(v.string()),
    preferredDestination: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
```

And widen the `patch` type (the new fields flow in through the existing `...rest` spread, but the explicit type must list them):

```ts
    const patch: Partial<{
      name: string;
      email: string;
      company: string;
      phone: string;
      phoneNormalized: string;
      altPhone: string;
      address: string;
      city: string;
      country: string;
      nationality: string;
      preferredDestination: string;
      notes: string;
    }> = { ...rest };
```

(The `const { contactId, phone, ...rest } = args;` destructure and the phone-dedup block below it stay unchanged — `rest` now carries the new fields straight into `patch`.)

- [ ] **Step 5: Run test to verify it passes.**

Run: `npm run test -- contacts`
Expected: PASS (new test + existing contacts tests).

- [ ] **Step 6: Typecheck the Convex layer.**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 7: Commit.**

```bash
git add convex/schema.ts convex/contacts.ts convex/contacts.test.ts
git commit -m "feat(contacts): add extended CRM fields to schema + update mutation"
```

---

### Task 3: UI type + adapter mapping

**Files:**
- Modify: `src/types/index.ts` (the `Contact` interface, ~lines 99-116)
- Modify: `src/lib/convex/adapters.ts:84-102` (`toUiContact`)

**Interfaces:**
- Produces: `Contact` gains `alt_phone?`, `address?`, `city?`, `country?`, `nationality?`, `preferred_destination?`, `notes?` (all `string | undefined`), populated by `toUiContact`. Consumed by Task 6.

- [ ] **Step 1: Extend the `Contact` type.** In `src/types/index.ts`, insert the new optional fields into the `Contact` interface (after `company?: string;`):

```ts
  company?: string;
  alt_phone?: string;
  address?: string;
  city?: string;
  country?: string;
  nationality?: string;
  preferred_destination?: string;
  notes?: string;
  avatar_url?: string;
```

- [ ] **Step 2: Map them in the adapter.** In `src/lib/convex/adapters.ts`, extend `toUiContact`'s returned object (after `company: doc.company,`):

```ts
    company: doc.company,
    alt_phone: doc.altPhone,
    address: doc.address,
    city: doc.city,
    country: doc.country,
    nationality: doc.nationality,
    preferred_destination: doc.preferredDestination,
    notes: doc.notes,
    avatar_url: doc.avatarUrl,
```

- [ ] **Step 3: Verify typecheck passes.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/types/index.ts src/lib/convex/adapters.ts
git commit -m "feat(contacts): surface extended fields on the UI Contact type"
```

---

### Task 4: Collapsible left menu (icon rail + tooltips)

**Files:**
- Modify: `src/components/layout/sidebar.tsx`
- Modify: `messages/en.json` (namespace `Sidebar`)

**Interfaces:**
- Self-contained. Adds a persisted `collapsed` state (localStorage key `wacrm:sidebar:collapsed`), desktop-only.

- [ ] **Step 1: Add i18n keys.** In `messages/en.json`, add to the `Sidebar` object:

```json
  "collapseMenu": "Collapse menu",
  "expandMenu": "Expand menu"
```

- [ ] **Step 2: Add imports + collapse state.** In `sidebar.tsx`:
  - Add to the `lucide-react` import: `PanelLeftClose`, `PanelLeftOpen`.
  - Add a new import: `import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip";`
  - Change `import { useEffect } from "react";` to `import { useEffect, useState } from "react";`
  - Inside the component, after the existing hooks, add the hydration-safe collapse state:

```ts
  // Desktop-only rail collapse. Server renders expanded; reconcile from
  // localStorage after mount to avoid a hydration mismatch (same pattern
  // as the inbox contact panel).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      const stored = localStorage.getItem("wacrm:sidebar:collapsed");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot mount sync from localStorage
      if (stored !== null) setCollapsed(stored === "true");
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("wacrm:sidebar:collapsed", String(next));
      } catch {
        // best-effort
      }
      return next;
    });
  };
```

- [ ] **Step 3: Make the rail width responsive to `collapsed`.** Change the `<aside>` desktop width token from `lg:w-60` to a conditional. Replace `"lg:static lg:z-0 lg:w-60 lg:translate-x-0 lg:transition-none"` with:

```ts
          "lg:static lg:z-0 lg:translate-x-0 lg:transition-none",
          collapsed ? "lg:w-16" : "lg:w-60",
```

- [ ] **Step 4: Wrap the aside body in `TooltipProvider` and add the collapse toggle in the logo row.** Wrap the aside's children in `<TooltipProvider delay={0}>…</TooltipProvider>`. In the logo row, hide the title text when collapsed and add a desktop-only toggle button. Replace the logo row's inner markup:

```tsx
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <MessageSquare className="h-4 w-4" />
            </div>
            {!collapsed && (
              <span className="text-sm font-semibold text-foreground">
                {t("title")}
              </span>
            )}
          </Link>
          <div className="flex items-center gap-1">
            {/* Desktop-only collapse toggle */}
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? t("expandMenu") : t("collapseMenu")}
              title={collapsed ? t("expandMenu") : t("collapseMenu")}
              className="hidden h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:flex"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-5 w-5" />
              ) : (
                <PanelLeftClose className="h-5 w-5" />
              )}
            </button>
            {/* Mobile close (unchanged) */}
            <button
              type="button"
              onClick={onClose}
              aria-label={t("closeMenu")}
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
```

(When collapsed, the logo row has only the mark + toggle; keep the row's existing `justify-between`.)

- [ ] **Step 5: Collapse the nav rows to icons + tooltips.** For each main nav `<li>`, when `collapsed`, center the icon, hide the label/beta chip, and wrap the `<Link>` in a tooltip. Replace the `<Link>` inside the `navItems.map` with:

```tsx
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Link
                          href={item.href}
                          className={cn(
                            "flex items-center rounded-lg text-sm font-medium transition-colors",
                            collapsed
                              ? "h-10 w-10 justify-center"
                              : "gap-3 px-3 py-2.5 lg:py-2",
                            isActive
                              ? "bg-primary/10 text-primary"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          {!collapsed && (
                            <span className="flex-1">{t(item.labelKey as string)}</span>
                          )}
                          {!collapsed && item.beta && (
                            <span
                              aria-label={t("beta")}
                              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
                            >
                              {t("beta")}
                            </span>
                          )}
                          {showUnreadDot && (
                            <span
                              aria-label={t("unreadConversations", { count: totalUnread })}
                              className={cn(
                                "relative flex h-2 w-2",
                                collapsed && "absolute right-1.5 top-1.5",
                              )}
                            >
                              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                            </span>
                          )}
                          {showNotificationBadge && (
                            <span
                              aria-label={t("unreadNotifications", { count: unreadNotifications })}
                              className={cn(
                                "flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground",
                                collapsed
                                  ? "absolute right-0.5 top-0.5 h-4 min-w-4 px-0.5 text-[9px]"
                                  : "",
                              )}
                            >
                              {unreadNotifications > 9 ? "9+" : unreadNotifications}
                            </span>
                          )}
                        </Link>
                      }
                    />
                    {collapsed && (
                      <TooltipContent side="right">
                        {t(item.labelKey as string)}
                      </TooltipContent>
                    )}
                  </Tooltip>
```

Add `relative` to the `<li>` when collapsed so the corner dot/badge anchors correctly: change `<li key={item.href}>` to `<li key={item.href} className={cn(collapsed && "relative flex justify-center")}>`.

- [ ] **Step 6: Collapse the bottom nav (Settings) the same way.** Apply the same tooltip-wrap + `collapsed` sizing to the `bottomNavItems.map` `<Link>` (it has no badges): center it when collapsed, wrap in `<Tooltip>` with a right-side `<TooltipContent>` showing `t(item.labelKey)`, and hide the label text when collapsed.

- [ ] **Step 7: Collapse the user footer.** In the user section, when `collapsed`, hide the account strip and the name/email column so only the avatar shows (the dropdown still opens on click). Wrap the `<div className="min-w-0 flex-1">…</div>` (name + email) in `{!collapsed && ( … )}`, and gate the account strip with `!collapsed && showAccountStrip`.

- [ ] **Step 8: Verify.**

Run: `npm run typecheck && npm run lint`
Expected: PASS.
Then run the app (`npm run dev`) and confirm on desktop: the collapse toggle shrinks the sidebar to an icon rail; hovering an icon shows its label tooltip; the active highlight, unread dot, and notification badge still show; reloading preserves the collapsed choice; the mobile drawer is unchanged.

- [ ] **Step 9: Commit.**

```bash
git add src/components/layout/sidebar.tsx messages/en.json
git commit -m "feat(nav): collapsible icon-rail sidebar with tooltips"
```

---

### Task 5: Contact panel — click-to-open slide-over

**Files:**
- Create: `src/components/inbox/contact-panel-drawer.tsx`
- Modify: `src/components/inbox/contact-sidebar.tsx` (root width only — 2 lines)
- Modify: `src/app/(dashboard)/inbox/page.tsx`
- Modify: `src/components/inbox/message-thread.tsx` (header)
- Modify: `messages/en.json` (`Inbox.sidebar`, `Inbox.messageThread`)

**Interfaces:**
- Consumes: `formatPhoneIntl` (Task 1).
- Produces: `ContactPanelDrawer({ open, onClose, contact })` slide-over. The thread-header name/number is now the open/close trigger. Panel default-closed, resets closed on conversation change.

- [ ] **Step 1: Add i18n keys.** In `messages/en.json`:
  - `Inbox.sidebar`: add `"close": "Close"` (keep existing `contactInfo`).
  - `Inbox.messageThread`: add `"viewContactDetails": "View contact details"`.

- [ ] **Step 2: Let `ContactSidebar` fill its container.** In `contact-sidebar.tsx`, change both root wrappers from a fixed rail to full width:
  - The `!contact` branch: `className="flex h-full w-70 items-center justify-center border-l border-border bg-card"` → `className="flex h-full w-full items-center justify-center bg-card"`.
  - The main return root: `className="flex h-full w-70 flex-col border-l border-border bg-card"` → `className="flex h-full w-full flex-col bg-card"`.

- [ ] **Step 3: Create the drawer.** Create `src/components/inbox/contact-panel-drawer.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Contact } from "@/types";
import { cn } from "@/lib/utils";
import { ContactSidebar } from "./contact-sidebar";

interface ContactPanelDrawerProps {
  open: boolean;
  onClose: () => void;
  contact: Contact | null;
}

/**
 * On-demand contact details, shown as a slide-over on the right edge of
 * the thread (opened by clicking the header name/number). Absolutely
 * positioned inside the thread's `relative` center column so it overlays
 * the chat without resizing it. Desktop: transparent scrim keeps the
 * chat visible; mobile: a light dim + full-width sheet.
 */
export function ContactPanelDrawer({ open, onClose, contact }: ContactPanelDrawerProps) {
  const t = useTranslations("Inbox.sidebar");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      {/* Scrim — catches outside clicks to close. */}
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          "absolute inset-0 z-20 bg-foreground/10 transition-opacity lg:bg-transparent",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      {/* Panel */}
      <aside
        aria-label={t("contactInfo")}
        aria-hidden={!open}
        className={cn(
          "absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-border bg-card shadow-xl transition-transform duration-200 ease-out sm:w-[360px]",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
          <span className="text-sm font-semibold text-foreground">
            {t("contactInfo")}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <ContactSidebar contact={contact} />
        </div>
      </aside>
    </>
  );
}
```

- [ ] **Step 4: Rewire the page.** In `src/app/(dashboard)/inbox/page.tsx`:
  - Remove `import { ContactSidebar } from "@/components/inbox/contact-sidebar";` and add `import { ContactPanelDrawer } from "@/components/inbox/contact-panel-drawer";`.
  - Delete the `CONTACT_PANEL_STORAGE_KEY` const (line ~20) and the `useEffect` that reads it (lines ~46-54).
  - Change `const [contactPanelOpen, setContactPanelOpen] = useState(true);` to `useState(false)`.
  - Replace `handleToggleContactPanel` with a persistence-free toggle, and add a reset-on-conversation-change effect:

```ts
  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => !prev);
  }, []);

  // The panel is on-demand, not sticky: collapse it whenever the agent
  // opens or switches conversations, so it only appears when they click
  // the header name/number.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset tied to conversation change, not a per-render derivation
    setContactPanelOpen(false);
  }, [activeConversationId]);
```

  - Make the center column `relative` and mount the drawer inside it; delete the old right-panel block. Replace the center-panel `<div>` (the one wrapping `<MessageThread>`, lines ~210-223) and the trailing `{contactPanelOpen && (…ContactSidebar…)}` block (lines ~225-233) with:

```tsx
        <div
          className={cn(
            "relative flex h-full min-w-0 flex-1 lg:flex",
            hasActiveConv ? "flex" : "hidden lg:flex",
          )}
        >
          <MessageThread
            conversation={activeConversation}
            contact={activeContact}
            onBack={handleCloseConversation}
            contactPanelOpen={contactPanelOpen}
            onToggleContactPanel={handleToggleContactPanel}
          />
          <ContactPanelDrawer
            open={contactPanelOpen}
            onClose={handleToggleContactPanel}
            contact={activeContact}
          />
        </div>
```

- [ ] **Step 5: Turn the thread header name/number into the trigger.** In `src/components/inbox/message-thread.tsx`:
  - In the `lucide-react` import, remove `PanelRightClose` and `PanelRightOpen`; add `ChevronRight`.
  - Add `import { formatPhoneIntl } from "@/lib/whatsapp/phone-utils";`.
  - Replace the name/phone `<div className="min-w-0">…</div>` block (lines ~598-601) with a button:

```tsx
          <button
            type="button"
            onClick={() => onToggleContactPanel?.()}
            aria-label={t("viewContactDetails")}
            aria-expanded={!!contactPanelOpen}
            className="group flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-foreground">
                {displayName}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {formatPhoneIntl(contact.phone)}
              </span>
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
```

  - Delete the standalone contact-panel toggle button block (lines ~617-642, the `{onToggleContactPanel && (<button …PanelRight… />)}`).

- [ ] **Step 6: Verify.**

Run: `npm run typecheck && npm run lint`
Expected: PASS.
Then run the app and confirm: opening a chat shows **no** contact panel; clicking the header name/number slides the panel in over the chat (chat does not resize); clicking the chat, the ✕, or pressing Esc closes it; switching to another conversation leaves it closed; the header number renders with a leading `+`; on mobile the panel is a full-width sheet reachable by tapping the name.

- [ ] **Step 7: Commit.**

```bash
git add src/components/inbox/contact-panel-drawer.tsx src/components/inbox/contact-sidebar.tsx src/app/\(dashboard\)/inbox/page.tsx src/components/inbox/message-thread.tsx messages/en.json
git commit -m "feat(inbox): open contact details as an on-demand slide-over from the header"
```

---

### Task 6: Contact panel — enhanced, editable content

**Files:**
- Modify: `src/components/inbox/contact-sidebar.tsx` (content overhaul)
- Modify: `messages/en.json` (`Inbox.sidebar`)

**Interfaces:**
- Consumes: `formatPhoneIntl` (Task 1), `api.contacts.update` with extended fields (Task 2), extended `Contact` type (Task 3).

- [ ] **Step 1: Add i18n keys.** In `messages/en.json`, add to `Inbox.sidebar`:

```json
  "edit": "Edit",
  "save": "Save",
  "cancel": "Cancel",
  "saving": "Saving…",
  "saved": "Contact updated",
  "saveError": "Couldn't save contact",
  "sectionContact": "Contact",
  "sectionLocation": "Location",
  "sectionTravel": "Travel profile",
  "sectionAbout": "About",
  "whatsappNumber": "WhatsApp number",
  "name": "Name",
  "company": "Company",
  "email": "Email",
  "altPhone": "Alternate phone",
  "address": "Address",
  "city": "City",
  "country": "Country",
  "nationality": "Nationality",
  "preferredDestination": "Preferred destination",
  "aboutPlaceholder": "Add notes about this contact…",
  "notFilled": "—"
```

- [ ] **Step 2: Rewrite `contact-sidebar.tsx`.** Replace the whole file with the sectioned, editable version below. It keeps the existing Tags / Deals / dated-notes-log behavior and adds an Edit mode (`contacts.update`), the extended fields, and `+`-formatted phones.

```tsx
"use client";

import { useState, useCallback, useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { toUiContactNote, toUiDeal } from "@/lib/convex/adapters";
import type { Contact } from "@/types";
import { formatPhoneIntl } from "@/lib/whatsapp/phone-utils";
import {
  Phone,
  Smartphone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Pencil,
  MapPin,
  Plane,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

interface ContactSidebarProps {
  contact: Contact | null;
}

type EditForm = {
  name: string;
  company: string;
  email: string;
  altPhone: string;
  address: string;
  city: string;
  country: string;
  nationality: string;
  preferredDestination: string;
  notes: string;
};

function formToState(c: Contact): EditForm {
  return {
    name: c.name ?? "",
    company: c.company ?? "",
    email: c.email ?? "",
    altPhone: c.alt_phone ?? "",
    address: c.address ?? "",
    city: c.city ?? "",
    country: c.country ?? "",
    nationality: c.nationality ?? "",
    preferredDestination: c.preferred_destination ?? "",
    notes: c.notes ?? "",
  };
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const [copied, setCopied] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);

  const contactId = contact ? (contact.id as Id<"contacts">) : undefined;

  // Leave edit mode + drop the draft whenever the active contact changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset tied to contact identity, not a per-render derivation
    setEditing(false);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm(null);
  }, [contactId]);

  const dealDocs = useQuery(
    api.deals.listByContact,
    contactId ? { contactId } : "skip",
  );
  const deals = (dealDocs ?? []).map(toUiDeal);

  const noteDocs = useQuery(
    api.contactNotes.listForContact,
    contactId ? { contactId } : "skip",
  );
  const notes = (noteDocs ?? []).map(toUiContactNote);

  const tags = contact?.tags ?? [];

  const addNote = useMutation(api.contactNotes.add);
  const updateContact = useMutation(api.contacts.update);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(formatPhoneIntl(contact.phone));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    setAddingNote(true);
    try {
      await addNote({
        contactId: contact.id as Id<"contacts">,
        body: newNote.trim(),
      });
      setNewNote("");
    } catch (err) {
      console.error("Failed to add note:", err);
      toast.error("Failed to add note");
    } finally {
      setAddingNote(false);
    }
  }, [contact, newNote, addNote]);

  const startEdit = useCallback(() => {
    if (!contact) return;
    setForm(formToState(contact));
    setEditing(true);
  }, [contact]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setForm(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!contact || !form) return;
    setSaving(true);
    try {
      await updateContact({
        contactId: contact.id as Id<"contacts">,
        name: form.name.trim() || undefined,
        company: form.company.trim() || undefined,
        email: form.email.trim() || undefined,
        // Normalize the alternate number to +E.164 on save.
        altPhone: form.altPhone.trim()
          ? formatPhoneIntl(form.altPhone)
          : undefined,
        address: form.address.trim() || undefined,
        city: form.city.trim() || undefined,
        country: form.country.trim() || undefined,
        nationality: form.nationality.trim() || undefined,
        preferredDestination: form.preferredDestination.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      toast.success(tSidebar("saved"));
      setEditing(false);
      setForm(null);
    } catch (err) {
      console.error("Failed to update contact:", err);
      toast.error(tSidebar("saveError"));
    } finally {
      setSaving(false);
    }
  }, [contact, form, updateContact, tSidebar]);

  if (!contact) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-card">
        <p className="text-sm text-muted-foreground">
          {tThread("selectConversation")}
        </p>
      </div>
    );
  }

  const displayName = contact.name || formatPhoneIntl(contact.phone);
  const initials = displayName.charAt(0).toUpperCase();
  const set = (k: keyof EditForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  const inputCls =
    "w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50";

  return (
    <div className="flex h-full w-full flex-col bg-card">
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {/* Header: avatar + name/company + Edit toggle */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            {editing && form ? (
              <input
                value={form.name}
                onChange={set("name")}
                placeholder={tSidebar("name")}
                className={`mt-3 text-center ${inputCls}`}
              />
            ) : (
              <h3 className="mt-3 text-sm font-semibold text-foreground">
                {displayName}
              </h3>
            )}
            {editing && form ? (
              <input
                value={form.company}
                onChange={set("company")}
                placeholder={tSidebar("company")}
                className={`mt-2 text-center ${inputCls}`}
              />
            ) : (
              contact.company && (
                <p className="text-xs text-muted-foreground">{contact.company}</p>
              )
            )}

            {!editing ? (
              <button
                type="button"
                onClick={startEdit}
                className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-3 w-3" />
                {tSidebar("edit")}
              </button>
            ) : (
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  {saving ? tSidebar("saving") : tSidebar("save")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={cancelEdit}
                  disabled={saving}
                >
                  {tSidebar("cancel")}
                </Button>
              </div>
            )}
          </div>

          {/* Section: Contact */}
          <Section icon={Phone} label={tSidebar("sectionContact")}>
            {/* WhatsApp number — read-only routing key, copyable */}
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-left">
                {formatPhoneIntl(contact.phone)}
              </span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            <Field
              icon={Smartphone}
              label={tSidebar("altPhone")}
              editing={editing}
              value={form?.altPhone ?? ""}
              display={contact.alt_phone ? formatPhoneIntl(contact.alt_phone) : ""}
              onChange={set("altPhone")}
              placeholder="+971…"
              notFilled={tSidebar("notFilled")}
            />
            <Field
              icon={Mail}
              label={tSidebar("email")}
              editing={editing}
              value={form?.email ?? ""}
              display={contact.email ?? ""}
              onChange={set("email")}
              placeholder={tSidebar("email")}
              notFilled={tSidebar("notFilled")}
            />
          </Section>

          {/* Section: Location */}
          <Section icon={MapPin} label={tSidebar("sectionLocation")}>
            <Field
              label={tSidebar("address")}
              editing={editing}
              value={form?.address ?? ""}
              display={contact.address ?? ""}
              onChange={set("address")}
              placeholder={tSidebar("address")}
              notFilled={tSidebar("notFilled")}
            />
            <Field
              label={tSidebar("city")}
              editing={editing}
              value={form?.city ?? ""}
              display={contact.city ?? ""}
              onChange={set("city")}
              placeholder={tSidebar("city")}
              notFilled={tSidebar("notFilled")}
            />
            <Field
              label={tSidebar("country")}
              editing={editing}
              value={form?.country ?? ""}
              display={contact.country ?? ""}
              onChange={set("country")}
              placeholder={tSidebar("country")}
              notFilled={tSidebar("notFilled")}
            />
          </Section>

          {/* Section: Travel profile */}
          <Section icon={Plane} label={tSidebar("sectionTravel")}>
            <Field
              label={tSidebar("nationality")}
              editing={editing}
              value={form?.nationality ?? ""}
              display={contact.nationality ?? ""}
              onChange={set("nationality")}
              placeholder={tSidebar("nationality")}
              notFilled={tSidebar("notFilled")}
            />
            <Field
              label={tSidebar("preferredDestination")}
              editing={editing}
              value={form?.preferredDestination ?? ""}
              display={contact.preferred_destination ?? ""}
              onChange={set("preferredDestination")}
              placeholder={tSidebar("preferredDestination")}
              notFilled={tSidebar("notFilled")}
            />
          </Section>

          {/* Section: About (persistent freeform) */}
          <Section icon={Info} label={tSidebar("sectionAbout")}>
            {editing && form ? (
              <textarea
                value={form.notes}
                onChange={set("notes")}
                placeholder={tSidebar("aboutPlaceholder")}
                rows={3}
                className={`resize-none ${inputCls}`}
              />
            ) : contact.notes ? (
              <p className="whitespace-pre-wrap px-1 text-sm text-foreground">
                {contact.notes}
              </p>
            ) : (
              <p className="px-1 text-xs text-muted-foreground">
                {tSidebar("notFilled")}
              </p>
            )}
          </Section>

          <Divider />

          {/* Tags (unchanged) */}
          <div>
            <SectionLabel icon={TagIcon} label={tSidebar("tags")} />
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">
                  {tSidebar("noTags")}
                </p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          <Divider />

          {/* Active Deals (unchanged) */}
          <div>
            <SectionLabel icon={DollarSign} label={tSidebar("deals")} />
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">
                  {tSidebar("noDeals")}
                </p>
              ) : (
                deals.map((deal) => (
                  <div key={deal.id} className="rounded-lg bg-muted px-3 py-2">
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <Divider />

          {/* Notes log (unchanged dated entries) */}
          <div>
            <SectionLabel icon={StickyNote} label={tSidebar("notes")} />
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div key={note.id} className="rounded-lg bg-muted px-3 py-2">
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function Divider() {
  return <div className="my-4 border-t border-border" />;
}

function SectionLabel({
  icon: Icon,
  label,
}: {
  icon: typeof TagIcon;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      <Icon className="h-3 w-3" />
      {label}
    </div>
  );
}

function Section({
  icon,
  label,
  children,
}: {
  icon: typeof TagIcon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <Divider />
      <div>
        <SectionLabel icon={icon} label={label} />
        <div className="mt-2 space-y-1">{children}</div>
      </div>
    </>
  );
}

function Field({
  icon: Icon,
  label,
  editing,
  value,
  display,
  onChange,
  placeholder,
  notFilled,
}: {
  icon?: typeof TagIcon;
  label: string;
  editing: boolean;
  value: string;
  display: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder: string;
  notFilled: string;
}) {
  if (editing) {
    return (
      <label className="block px-1">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <input
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className="mt-1 w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
      </label>
    );
  }
  return (
    <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm">
      {Icon && <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />}
      <span className="min-w-0 flex-1 truncate text-foreground">
        {display || <span className="text-muted-foreground">{notFilled}</span>}
      </span>
    </div>
  );
}
```

- [ ] **Step 3: Verify.**

Run: `npm run typecheck && npm run lint`
Expected: PASS.
Then run the app and confirm: opening the panel shows Contact / Location / Travel / About sections; the WhatsApp number shows a leading `+` and copies the formatted value; clicking **Edit** turns fields into inputs; saving persists (reload / reopen shows the new values, and the panel updates reactively); an entered alternate number is stored/displayed as `+971…`; empty fields show the `—` placeholder; Tags, Deals, and the dated notes log still work.

- [ ] **Step 4: Commit.**

```bash
git add src/components/inbox/contact-sidebar.tsx messages/en.json
git commit -m "feat(inbox): sectioned, editable contact panel with extended fields"
```

---

## Self-Review

**Spec coverage:**
- Collapsible left menu → Task 4. ✓
- Contact panel default-closed + open-on-header-click + slide-over → Task 5. ✓
- Enhanced editable fields (basics + location + travel + alt phone + about) → Tasks 2/3/6. ✓
- `+971`-default phone formatting (display + input normalization) → Task 1 (helper) + Task 5 (header) + Task 6 (panel/edit). ✓
- Data model + adapter + type → Tasks 2/3. ✓
- Single-locale i18n additions → Tasks 4/5/6. ✓
- Tooltip primitive exists (`@/components/ui/tooltip`) → used in Task 4, no new dep. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code; tests include assertions. ✓

**Type consistency:** Convex fields are camelCase (`altPhone`, `preferredDestination`); UI `Contact` fields are snake_case (`alt_phone`, `preferred_destination`); `toUiContact` maps camel→snake (Task 3); `contacts.update` args are camelCase and called with camelCase in Task 6's `handleSave`. `formatPhoneIntl` signature is identical across Tasks 1/5/6. ✓

## Notes / deferred

- The primary WhatsApp number stays **read-only** in the panel (it is the conversation routing key); only the alternate number is editable. Matches the approved design.
- The existing `customFields` / `contactCustomValues` system is intentionally **not** used — dedicated typed fields are simpler for the requested set.
- Unused i18n keys (`hideContact*`, `showContact*`) left in place after removing the old toggle button; harmless, optional cleanup later.
