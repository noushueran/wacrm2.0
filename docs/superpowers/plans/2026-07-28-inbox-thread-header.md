# Inbox Thread Header Reorganisation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inbox thread header's single wrapping thirteen-element flex row with three fixed zones — identity, a merged window pill, and three controls — so its height and control positions never change between conversations.

**Architecture:** Two pure functions in `src/lib/inbox/threadHeader.ts` own the branching (which window segments render, what the lead button says) and are unit-tested without rendering. Two new client components — `LeadPopover` and `ThreadHeader` — consume them. `message-thread.tsx` keeps every handler, query and derivation it has today and simply passes them down, so no Convex contract or role gate changes.

**Tech Stack:** Next.js (App Router), React 19, TypeScript, Convex, next-intl, Tailwind, Base UI (`@base-ui/react`) via `src/components/ui/*`, Vitest.

## Global Constraints

- **No Convex changes.** No file under `convex/` is created, edited, or deployed. Never run `convex deploy`, `convex dev`, or `convex codegen` in this plan.
- **No behaviour changes.** Every control keeps its current handler, condition, and role gate. This is a layout change only.
- **Source of truth for spec:** `docs/superpowers/specs/2026-07-28-inbox-thread-header-design.md`.
- **i18n:** `messages/en.json` is the only locale file. New keys go under `Inbox.messageThread`.
- **Lint is scoped to changed files:** `npx eslint <paths>`, never a bare `npx eslint`.
- **Git staging is explicit:** `git add <path> <path>`, never `git add -A` or `git add .`.
- **Branch:** work continues on `perf/inbox-lane-tabs`. **Other sessions commit to this same working tree concurrently** — the lane-tabs work was committed by another session mid-plan (`50f1ea6`). Before each commit, run `git status --short` and stage only the paths this plan names. Never `git add -A` or `git add .`, and never `git commit -a`.
- **Colour classes** must come from the existing header: `text-primary`, `text-red-400`, `text-emerald-400`, `text-muted-foreground`, `border-border`, `bg-popover`, `text-popover-foreground`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/inbox/threadHeader.ts` | **Create.** Pure: `windowPill()`, `leadButtonLabel()`, `initials()`. No React, no i18n, no Convex. |
| `src/lib/inbox/threadHeader.test.ts` | **Create.** Vitest unit tests for the three functions. |
| `messages/en.json` | **Modify.** Five new keys under `Inbox.messageThread`. |
| `src/components/inbox/lead-popover.tsx` | **Create.** Stage picker, assignee picker, read-only ad/qualification context, tag chips. |
| `src/components/inbox/thread-header.tsx` | **Create.** The header row: identity, window pill, Status, LeadPopover, Snooze, overflow. |
| `src/components/inbox/message-thread.tsx` | **Modify.** Delete the inline header (lines ~943–1352), render `<ThreadHeader />`, drop now-unused imports. |

---

## Task 1: Pure header helpers and i18n keys

**Files:**
- Create: `src/lib/inbox/threadHeader.ts`
- Create: `src/lib/inbox/threadHeader.test.ts`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type WindowTone = "primary" | "expired" | "free"`
  - `interface WindowSegment { key: "service" | "free"; text: string; tone: WindowTone }`
  - `windowPill(input: { sessionRemaining: string; sessionExpired: boolean; freeText: string | null }): WindowSegment[]`
  - `initials(name: string): string`
  - `leadButtonLabel(input: { stageLabel: string | null; assigneeName: string | null; fallbackLabel: string }): string`
  - i18n keys `Inbox.messageThread.{leadSectionStage,leadSectionAssignee,leadSectionContext,leadSectionTags,leadFallback}`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/inbox/threadHeader.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { windowPill, leadButtonLabel, initials } from "./threadHeader";

describe("windowPill", () => {
  it("renders the service segment alone when the free window is shut", () => {
    expect(
      windowPill({ sessionRemaining: "23h", sessionExpired: false, freeText: null }),
    ).toEqual([{ key: "service", text: "23h", tone: "primary" }]);
  });

  it("renders both segments when the free window is open", () => {
    expect(
      windowPill({ sessionRemaining: "23h", sessionExpired: false, freeText: "free 65h" }),
    ).toEqual([
      { key: "service", text: "23h", tone: "primary" },
      { key: "free", text: "free 65h", tone: "free" },
    ]);
  });

  it("marks an expired service window without hiding it", () => {
    expect(
      windowPill({ sessionRemaining: "Expired", sessionExpired: true, freeText: null }),
    ).toEqual([{ key: "service", text: "Expired", tone: "expired" }]);
  });

  it("keeps the free segment green while the service window is expired", () => {
    // Legitimate: the two windows are independent. The 24h window can shut
    // while the 72h free-entry window is still open.
    expect(
      windowPill({ sessionRemaining: "Expired", sessionExpired: true, freeText: "free 12h" }),
    ).toEqual([
      { key: "service", text: "Expired", tone: "expired" },
      { key: "free", text: "free 12h", tone: "free" },
    ]);
  });

  it("returns no segments when there is nothing to say", () => {
    // `sessionInfo.remaining` is "" on a conversation with no messages.
    expect(
      windowPill({ sessionRemaining: "", sessionExpired: false, freeText: null }),
    ).toEqual([]);
  });

  it("still renders the free segment when the session string is empty", () => {
    expect(
      windowPill({ sessionRemaining: "", sessionExpired: false, freeText: "free 65h" }),
    ).toEqual([{ key: "free", text: "free 65h", tone: "free" }]);
  });
});

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("khadeeja banu")).toBe("KB");
  });

  it("takes one letter from a single-word name", () => {
    expect(initials("Noushad")).toBe("N");
  });

  it("ignores a third word", () => {
    expect(initials("maria del carmen")).toBe("MD");
  });

  it("collapses extra whitespace", () => {
    expect(initials("  ada   lovelace  ")).toBe("AL");
  });

  it("returns an empty string for an empty name", () => {
    expect(initials("   ")).toBe("");
  });
});

describe("leadButtonLabel", () => {
  it("joins stage and assignee initials", () => {
    expect(
      leadButtonLabel({
        stageLabel: "New lead",
        assigneeName: "khadeeja banu",
        fallbackLabel: "Lead",
      }),
    ).toBe("New lead · KB");
  });

  it("shows the stage alone when unassigned", () => {
    expect(
      leadButtonLabel({ stageLabel: "Qualified", assigneeName: null, fallbackLabel: "Lead" }),
    ).toBe("Qualified");
  });

  it("falls back to the generic label when no stage is set", () => {
    expect(
      leadButtonLabel({ stageLabel: null, assigneeName: "khadeeja banu", fallbackLabel: "Lead" }),
    ).toBe("Lead · KB");
  });

  it("shows the fallback alone when neither is set", () => {
    expect(
      leadButtonLabel({ stageLabel: null, assigneeName: null, fallbackLabel: "Lead" }),
    ).toBe("Lead");
  });

  it("does not append a separator for a whitespace-only assignee name", () => {
    expect(
      leadButtonLabel({ stageLabel: "New lead", assigneeName: "  ", fallbackLabel: "Lead" }),
    ).toBe("New lead");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npx vitest run src/lib/inbox/threadHeader.test.ts
```

Expected: FAIL — `Failed to resolve import "./threadHeader"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/inbox/threadHeader.ts`:

```ts
// Pure branching for the thread header (spec:
// docs/superpowers/specs/2026-07-28-inbox-thread-header-design.md).
// Kept out of the component because `message-thread.tsx` is not statically
// renderable, so this is the only place these rules can be tested.

export type WindowTone = "primary" | "expired" | "free";

export interface WindowSegment {
  key: "service" | "free";
  text: string;
  tone: WindowTone;
}

/**
 * The two messaging windows, as up to two segments of one pill.
 *
 * They are INDEPENDENT: the 24h customer service window governs whether a
 * free-form reply is allowed at all, the 72h free-entry-point window
 * governs whether the conversation costs money. Either can be open alone,
 * and an expired service window alongside an open free window is a normal
 * state, not a contradiction — hence no cross-segment suppression here.
 */
export function windowPill(input: {
  sessionRemaining: string;
  sessionExpired: boolean;
  freeText: string | null;
}): WindowSegment[] {
  const segments: WindowSegment[] = [];
  if (input.sessionRemaining) {
    segments.push({
      key: "service",
      text: input.sessionRemaining,
      tone: input.sessionExpired ? "expired" : "primary",
    });
  }
  if (input.freeText) {
    segments.push({ key: "free", text: input.freeText, tone: "free" });
  }
  return segments;
}

/** First letter of each of the first two words, uppercased. */
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

/**
 * The lead button's trigger text: the funnel stage, then the assignee's
 * initials. Falls back to a generic label when no stage is set, so the
 * button never renders empty.
 */
export function leadButtonLabel(input: {
  stageLabel: string | null;
  assigneeName: string | null;
  fallbackLabel: string;
}): string {
  const stage = input.stageLabel ?? input.fallbackLabel;
  const who = input.assigneeName ? initials(input.assigneeName) : "";
  return who ? `${stage} · ${who}` : stage;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run src/lib/inbox/threadHeader.test.ts
```

Expected: PASS, 16 tests.

- [ ] **Step 5: Add the i18n keys**

In `messages/en.json`, inside the existing `Inbox.messageThread` object (it already
contains `snooze`, `wake`, `archive`, `more`, `markUnread`, `chaseNow`, `stopChasing`,
`adLeadBadge` — add these alongside them, keeping the file's existing indentation):

```json
"leadFallback": "Lead",
"leadSectionStage": "Stage",
"leadSectionAssignee": "Assigned to",
"leadSectionContext": "Context",
"leadSectionTags": "Tags"
```

- [ ] **Step 6: Verify the JSON still parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8'));console.log('ok')"
```

Expected: `ok`

- [ ] **Step 7: Lint and typecheck**

```bash
npx eslint src/lib/inbox/threadHeader.ts src/lib/inbox/threadHeader.test.ts && npm run typecheck
```

Expected: no errors from either.

- [ ] **Step 8: Commit**

```bash
git add src/lib/inbox/threadHeader.ts src/lib/inbox/threadHeader.test.ts messages/en.json
git commit -m "feat(inbox): pure helpers and copy for the reorganised thread header"
```

---

## Task 2: LeadPopover

**Files:**
- Create: `src/components/inbox/lead-popover.tsx`

**Interfaces:**
- Consumes: `leadButtonLabel` from Task 1; `Popover`/`PopoverTrigger`/`PopoverContent` from `@/components/ui/popover`; `UI_FUNNEL_STAGES` from `@/lib/inbox/funnel`; `QualificationChip` from `@/components/inbox/qualification-chip`; `PresenceDot` from `@/components/presence/presence-dot`; `presenceLabel` from `@/lib/presence`; `canAssignToOthers` from wherever `message-thread.tsx` imports it today.
- Produces: `<LeadPopover />` with the prop type below, consumed only by Task 3.

There is no unit test for this task — it is a presentational component with no branching that
Task 1's helpers do not already cover, and the repo has no React testing setup (`vitest` runs
node-environment `.test.ts` files only). It is verified by typecheck here and by the manual
checks in Task 5.

- [ ] **Step 1: Create the component**

Create `src/components/inbox/lead-popover.tsx`:

```tsx
"use client";

import { Check, Megaphone } from "lucide-react";
import { useTranslations } from "next-intl";

import { PresenceDot } from "@/components/presence/presence-dot";
import { QualificationChip } from "@/components/inbox/qualification-chip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { UI_FUNNEL_STAGES, type UiFunnelStageKey } from "@/lib/inbox/funnel";
import { presenceLabel } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type { Profile, Tag } from "@/types";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PresenceStatus } from "@/lib/presence";

export interface LeadPopoverProps {
  /** Rendered inside the trigger; produced by `leadButtonLabel`. */
  label: string;
  /** Drives the trigger's accent — true once a stage is set. */
  active: boolean;
  conversationId: Id<"conversations"> | null;
  currentStage: UiFunnelStageKey | null;
  onStageSelect: (stage: UiFunnelStageKey) => void;
  profiles: Profile[];
  assignedAgentId: string | null;
  currentUserId: string | null;
  /** Supervisor+ gets the full teammate list; an agent gets claim/release. */
  canAssignToOthers: boolean;
  mine: boolean;
  isPool: boolean;
  onAssignChange: (userId: string | null) => void;
  getPresence: (userId: string) => PresenceStatus;
  getLastSeenAt: (userId: string) => string | null;
  now: number;
  isAdLead: boolean;
  tags: Tag[];
  tagOverflow: number;
}

/**
 * Everything that answers "what kind of lead is this?" — stage, assignee,
 * ad provenance, qualification progress, tags — behind one trigger.
 *
 * The four used to be two dropdowns plus three badge families competing
 * for room in the header row. They are one question, so they get one home.
 *
 * Because the popup unmounts while closed, `QualificationChip`'s Convex
 * query only runs once the popover is opened, rather than on every thread
 * open. That is deliberate.
 */
export function LeadPopover(props: LeadPopoverProps) {
  const t = useTranslations("Inbox.messageThread");
  const tFunnel = useTranslations("Inbox.funnel");

  const hasContext = props.isAdLead || !!props.conversationId;
  const hasTags = props.tags.length > 0 || props.tagOverflow > 0;

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted",
          props.active ? "text-primary" : "text-muted-foreground",
        )}
      >
        <span className="hidden sm:inline">{props.label}</span>
        <ChevronDownIcon />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-0 p-0">
        <Section title={t("leadSectionStage")}>
          {UI_FUNNEL_STAGES.map((s) => {
            const selected = props.currentStage === s.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => props.onStageSelect(s.key)}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  selected ? "text-primary" : "text-popover-foreground",
                )}
              >
                {tFunnel(`stage.${s.key}`)}
                {selected && <Check className="h-3 w-3" />}
              </button>
            );
          })}
        </Section>

        <Section title={t("leadSectionAssignee")} bordered>
          {props.canAssignToOthers ? (
            <>
              {props.profiles.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  {t("noTeammates")}
                </p>
              ) : (
                props.profiles.map((p) => {
                  const selected = p.user_id === props.assignedAgentId;
                  const presence = props.getPresence(p.user_id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => props.onAssignChange(p.user_id)}
                      className={cn(
                        "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                        selected ? "text-primary" : "text-popover-foreground",
                      )}
                    >
                      <PresenceDot
                        status={presence}
                        label={presenceLabel(
                          presence,
                          props.getLastSeenAt(p.user_id),
                          props.now,
                        )}
                        className="mr-2"
                      />
                      <span className="flex-1 truncate">
                        {p.full_name}
                        {p.user_id === props.currentUserId ? t("me") : ""}
                      </span>
                      {selected && <Check className="ml-2 h-3 w-3" />}
                    </button>
                  );
                })
              )}
              {props.assignedAgentId && (
                <button
                  type="button"
                  onClick={() => props.onAssignChange(null)}
                  className="flex w-full rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
                >
                  {t("unassign")}
                </button>
              )}
            </>
          ) : props.mine ? (
            <button
              type="button"
              onClick={() => props.onAssignChange(null)}
              className="flex w-full rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted"
            >
              {t("release")}
            </button>
          ) : (
            <button
              type="button"
              disabled={!props.isPool || !props.currentUserId}
              onClick={() =>
                props.currentUserId && props.onAssignChange(props.currentUserId)
              }
              className="flex w-full rounded-md px-2 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted disabled:opacity-50"
            >
              {t("claim")}
            </button>
          )}
        </Section>

        {hasContext && (
          <Section title={t("leadSectionContext")} bordered>
            <div className="flex flex-wrap items-center gap-1.5 px-2 py-1">
              {props.isAdLead && (
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 px-2 py-0.5 text-[10px] text-primary">
                  <Megaphone className="h-3 w-3" />
                  {t("adLeadBadge")}
                </span>
              )}
              <QualificationChip conversationId={props.conversationId} />
            </div>
          </Section>
        )}

        {hasTags && (
          <Section title={t("leadSectionTags")} bordered>
            <div className="flex flex-wrap items-center gap-1.5 px-2 py-1">
              {props.tags.map((tag) => (
                <span
                  key={tag.id}
                  className="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                >
                  {tag.name}
                </span>
              ))}
              {props.tagOverflow > 0 && (
                <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  +{props.tagOverflow}
                </span>
              )}
            </div>
          </Section>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Section({
  title,
  bordered,
  children,
}: {
  title: string;
  bordered?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("p-1.5", bordered && "border-t border-border")}>
      <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3 w-3 shrink-0"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
```

- [ ] **Step 2: Replace the hand-rolled chevron with the lucide import**

The inline `ChevronDownIcon` above exists only so the file is readable in isolation. Delete
that function and instead import the same icon the rest of the header uses:

- add `ChevronDown` to the `lucide-react` import at the top (`import { Check, ChevronDown, Megaphone } from "lucide-react";`)
- replace `<ChevronDownIcon />` with `<ChevronDown className="h-3 w-3 shrink-0" />`
- delete the `function ChevronDownIcon() {...}` block

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: no errors. If `Profile` or `Tag` are not exported from `@/types`, correct the
import path — `message-thread.tsx` imports both today, so copy its import specifiers.

- [ ] **Step 4: Lint**

```bash
npx eslint src/components/inbox/lead-popover.tsx
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/inbox/lead-popover.tsx
git commit -m "feat(inbox): lead popover for stage, assignee, ad and qualification context"
```

---

## Task 3: ThreadHeader

**Files:**
- Create: `src/components/inbox/thread-header.tsx`

**Interfaces:**
- Consumes: `windowPill`, `leadButtonLabel` (Task 1); `LeadPopover` (Task 2).
- Produces: `<ThreadHeader />` with the props below, consumed by Task 4.

- [ ] **Step 1: Create the component**

Create `src/components/inbox/thread-header.tsx`:

```tsx
"use client";

import {
  ArchiveIcon,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Clock,
  Mail,
  MoreVertical,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { LeadPopover } from "@/components/inbox/lead-popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { leadButtonLabel, windowPill } from "@/lib/inbox/threadHeader";
import type { UiFunnelStageKey } from "@/lib/inbox/funnel";
import { cn } from "@/lib/utils";
import { formatPhoneIntl } from "@/lib/whatsapp/phone-utils";
import type { Profile, Tag } from "@/types";
import type { Id } from "../../../convex/_generated/dataModel";
import type { PresenceStatus } from "@/lib/presence";

const TONE_CLASS = {
  primary: "text-primary",
  expired: "text-red-400",
  free: "text-emerald-400",
} as const;

export interface ThreadHeaderProps {
  displayName: string;
  phone: string;
  onBack?: () => void;
  onToggleContactPanel?: () => void;
  contactPanelOpen?: boolean;

  sessionRemaining: string;
  sessionExpired: boolean;
  freeText: string | null;
  /** Tooltip for the free segment; already switched on `windows.fep.source`. */
  freeTitle: string | undefined;

  /** Null for a viewer, who gets no status control. */
  status: { label: string; value: string; color: string } | null;
  statusOptions: { label: string; value: string; color: string }[];
  onStatusChange: (value: string) => void;
  canEditStatus: boolean;

  canEditLead: boolean;
  conversationId: Id<"conversations"> | null;
  currentStage: UiFunnelStageKey | null;
  stageLabel: string | null;
  onStageSelect: (stage: UiFunnelStageKey) => void;
  profiles: Profile[];
  assignedAgentId: string | null;
  assigneeName: string | null;
  currentUserId: string | null;
  canAssignToOthers: boolean;
  mine: boolean;
  isPool: boolean;
  onAssignChange: (userId: string | null) => void;
  getPresence: (userId: string) => PresenceStatus;
  getLastSeenAt: (userId: string) => string | null;
  now: number;
  isAdLead: boolean;
  tags: Tag[];
  tagOverflow: number;

  showSnooze: boolean;
  showWake: boolean;
  onSnoozeThreeHours: () => void;
  onSnoozeTomorrow: () => void;
  onSnoozeNextWeek: () => void;
  onSnoozeCustom: () => void;
  onWake: () => void;

  showChaseNow: boolean;
  onChaseNow: () => void;
  showStopChasing: boolean;
  onStopChasing: () => void;
  showArchive: boolean;
  onArchive: () => void;
  showMarkUnread: boolean;
  onMarkUnread: () => void;
}

/**
 * The thread header: three zones on one row that never wraps.
 *
 * Identity shrinks (`min-w-0` + truncate), the window pill and the control
 * cluster do not (`shrink-0`). The previous single wrapping row changed
 * height and control position per conversation depending on which
 * conditional badges happened to render.
 */
export function ThreadHeader(props: ThreadHeaderProps) {
  const t = useTranslations("Inbox.messageThread");

  const segments = windowPill({
    sessionRemaining: props.sessionRemaining,
    sessionExpired: props.sessionExpired,
    freeText: props.freeText,
  });

  const label = leadButtonLabel({
    stageLabel: props.stageLabel,
    assigneeName: props.assigneeName,
    fallbackLabel: t("leadFallback"),
  });

  // The overflow trigger must not render when every item inside is hidden:
  // a viewer has no archive, no chase, no stop-chasing and no mark-unread,
  // and an empty menu that opens onto nothing is worse than no menu.
  const hasOverflow =
    props.showChaseNow ||
    props.showStopChasing ||
    props.showArchive ||
    props.showMarkUnread;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-3 sm:px-4">
      {/* Identity — the only zone allowed to shrink. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        {props.onBack && (
          <button
            type="button"
            onClick={props.onBack}
            aria-label={t("backToConversations")}
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
          {props.displayName.charAt(0).toUpperCase()}
        </div>
        <button
          type="button"
          onClick={() => props.onToggleContactPanel?.()}
          aria-label={t("viewContactDetails")}
          aria-expanded={!!props.contactPanelOpen}
          className="group flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">
              {props.displayName}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {formatPhoneIntl(props.phone)}
            </span>
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>

        {/* Window pill — one border, up to two segments. */}
        {segments.length > 0 && (
          <span className="hidden shrink-0 items-center overflow-hidden rounded-full border border-border text-[10px] sm:inline-flex">
            {segments.map((seg, i) => (
              <span
                key={seg.key}
                title={seg.key === "free" ? props.freeTitle : undefined}
                className={cn(
                  "inline-flex items-center gap-1 px-2 py-0.5",
                  TONE_CLASS[seg.tone],
                  i > 0 && "border-l border-border",
                )}
              >
                {seg.key === "service" && <Clock className="h-3 w-3" />}
                {seg.text}
              </span>
            ))}
          </span>
        )}
      </div>

      {/* Controls — fixed width, never wrap. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {props.canEditStatus && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs hover:bg-muted",
                props.status?.color ?? "text-muted-foreground",
              )}
            >
              {props.status ? t(`status${props.status.label}`) : t("status")}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-popover">
              {props.statusOptions.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => props.onStatusChange(opt.value)}
                  className={cn("text-sm", opt.color)}
                >
                  {t(`status${opt.label}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {props.canEditLead && (
          <LeadPopover
            label={label}
            active={!!props.currentStage}
            conversationId={props.conversationId}
            currentStage={props.currentStage}
            onStageSelect={props.onStageSelect}
            profiles={props.profiles}
            assignedAgentId={props.assignedAgentId}
            currentUserId={props.currentUserId}
            canAssignToOthers={props.canAssignToOthers}
            mine={props.mine}
            isPool={props.isPool}
            onAssignChange={props.onAssignChange}
            getPresence={props.getPresence}
            getLastSeenAt={props.getLastSeenAt}
            now={props.now}
            isAdLead={props.isAdLead}
            tags={props.tags}
            tagOverflow={props.tagOverflow}
          />
        )}

        {/* Snooze stays out of the overflow menu deliberately — it is a
            frequent action, and the icon-only form costs ~28px. */}
        {props.showWake && (
          <button
            type="button"
            onClick={props.onWake}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {t("wake")}
          </button>
        )}
        {props.showSnooze && (
          <div className="inline-flex items-stretch rounded-md text-muted-foreground">
            <button
              type="button"
              onClick={props.onSnoozeThreeHours}
              aria-label={t("snooze")}
              title={t("snoozeThreeHours")}
              className="inline-flex h-7 items-center rounded-l-md pl-2 pr-1.5 hover:bg-muted hover:text-foreground"
            >
              <Clock className="h-3.5 w-3.5" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t("snooze")}
                className="inline-flex h-7 w-5 items-center justify-center rounded-r-md border-l border-border hover:bg-muted hover:text-foreground"
              >
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="border-border bg-popover">
                <DropdownMenuItem
                  onClick={props.onSnoozeTomorrow}
                  className="text-sm text-popover-foreground"
                >
                  {t("snoozeTomorrow")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={props.onSnoozeNextWeek}
                  className="text-sm text-popover-foreground"
                >
                  {t("snoozeNextWeek")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={props.onSnoozeCustom}
                  className="text-sm text-popover-foreground"
                >
                  {t("snoozeCustom")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {hasOverflow && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("more")}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-popover">
              {props.showChaseNow && (
                <DropdownMenuItem
                  onClick={props.onChaseNow}
                  className="text-sm text-popover-foreground"
                >
                  {t("chaseNow")}
                </DropdownMenuItem>
              )}
              {props.showStopChasing && (
                <DropdownMenuItem
                  onClick={props.onStopChasing}
                  className="text-sm text-popover-foreground"
                >
                  {t("stopChasing")}
                </DropdownMenuItem>
              )}
              {props.showArchive && (
                <DropdownMenuItem
                  onClick={props.onArchive}
                  className="text-sm text-popover-foreground"
                >
                  <ArchiveIcon className="mr-2 h-3.5 w-3.5" />
                  {t("archive")}
                </DropdownMenuItem>
              )}
              {props.showMarkUnread && (
                <DropdownMenuItem
                  onClick={props.onMarkUnread}
                  className="text-sm text-popover-foreground"
                >
                  <Mail className="mr-2 h-3.5 w-3.5" />
                  {t("markUnread")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck and lint**

```bash
npm run typecheck && npx eslint src/components/inbox/thread-header.tsx
```

Expected: no errors. `thread-header.tsx` is not yet rendered anywhere, so this only proves it compiles.

- [ ] **Step 3: Commit**

```bash
git add src/components/inbox/thread-header.tsx
git commit -m "feat(inbox): three-zone thread header component"
```

---

## Task 4: Wire ThreadHeader into MessageThread

**Files:**
- Modify: `src/components/inbox/message-thread.tsx`

**Interfaces:**
- Consumes: `<ThreadHeader />` (Task 3).
- Produces: nothing — this is the last consumer.

- [ ] **Step 1: Re-locate the header block**

Line numbers will have drifted. Find the exact block to replace:

```bash
grep -n "border-b border-border bg-card px-3 py-3" src/components/inbox/message-thread.tsx
grep -n "{/\* Messages Area \*/}" src/components/inbox/message-thread.tsx
```

The block to delete runs from the `{/* Header — solid card surface ... */}` comment above the
first match, through the `</div>` that closes it, and ends immediately before the
`{/* Messages Area */}` comment.

- [ ] **Step 2: Replace the block with the component**

Delete that entire block and put this in its place:

```tsx
      <ThreadHeader
        displayName={displayName}
        phone={contact.phone}
        onBack={onBack}
        onToggleContactPanel={onToggleContactPanel}
        contactPanelOpen={contactPanelOpen}

        sessionRemaining={sessionInfo.remaining}
        sessionExpired={sessionInfo.expired}
        freeText={
          freeWindowRemaining
            ? tWindow("freeBadge", { remaining: freeWindowRemaining })
            : null
        }
        freeTitle={
          freeWindowRemaining
            ? tWindow(
                windows.fep.source === "meta"
                  ? "freeBadgeTitle"
                  : "freeBadgeEstimatedTitle",
                { remaining: freeWindowRemaining },
              )
            : undefined
        }

        status={currentStatus ?? null}
        statusOptions={STATUS_OPTIONS}
        onStatusChange={(v) => handleStatusChange(v as ConversationStatus)}
        canEditStatus={accountRole !== "viewer"}

        canEditLead={accountRole !== "viewer"}
        conversationId={conversationId ? (conversationId as Id<"conversations">) : null}
        currentStage={funnelState?.currentStage ?? null}
        stageLabel={
          funnelState?.currentStage
            ? tFunnel(`stage.${funnelState.currentStage}`)
            : null
        }
        onStageSelect={handleStageSelect}
        profiles={profiles}
        assignedAgentId={assignedAgentId}
        assigneeName={currentAssignee?.full_name ?? null}
        currentUserId={user?.id ?? null}
        canAssignToOthers={!!accountRole && canAssignToOthers(accountRole)}
        mine={mine}
        isPool={isPool}
        onAssignChange={handleAssignChange}
        getPresence={getPresence}
        getLastSeenAt={(id) => getRow(id)?.last_seen_at ?? null}
        now={now}
        isAdLead={!!conversation.ad_referral}
        tags={headerChips.visible}
        tagOverflow={headerChips.overflow}

        showSnooze={overrides.snooze}
        showWake={overrides.wake}
        onSnoozeThreeHours={() => void handleSnooze({ preset: "three_hours" })}
        onSnoozeTomorrow={() => void handleSnooze({ preset: "tomorrow" })}
        onSnoozeNextWeek={() => void handleSnooze({ preset: "next_week" })}
        onSnoozeCustom={() => setSnoozeCustomOpen(true)}
        onWake={() => void handleWake()}

        showChaseNow={overrides.chaseNow}
        onChaseNow={() => void handleChaseNow()}
        showStopChasing={canStopChasing && conversation.sequenceStatus === "running"}
        onStopChasing={() => void handleStopChasing()}
        showArchive={canArchive && !conversation.archived_at}
        onArchive={() => void handleArchive()}
        showMarkUnread={accountRole !== "viewer" && !!onMarkUnread && !!conversationId}
        onMarkUnread={() => conversationId && onMarkUnread?.(conversationId)}
      />
```

- [ ] **Step 3: Add the ThreadHeader import**

Add alongside the other `@/components/inbox/*` imports near the top:

```tsx
import { ThreadHeader } from "@/components/inbox/thread-header";
```

- [ ] **Step 4: Remove imports the old header owned**

Only remove a symbol once you have confirmed it has no other use in the file. For each of
`QualificationChip`, `Megaphone`, `BadgeCheck`, `UserPlus`, `Check`, `Mail`, `ArchiveIcon`,
`ArrowLeft`, `ChevronRight`, `Badge`, `PresenceDot`, `presenceLabel`, `UI_FUNNEL_STAGES`,
`formatPhoneIntl`, `Clock`, `MoreVertical`, `ChevronDown`:

```bash
grep -c "\bSYMBOL\b" src/components/inbox/message-thread.tsx
```

A count of 1 means the import line is the only remaining occurrence — delete it. A count above
1 means something else still uses it — keep it. `Clock`, for instance, is also used by the
composer's window banner, and `formatPhoneIntl` may be used elsewhere in the file.

- [ ] **Step 5: Typecheck**

```bash
npm run typecheck
```

Expected: no errors. A "declared but never read" error names an import Step 4 missed — delete it.

- [ ] **Step 6: Lint the changed files**

```bash
npx eslint src/components/inbox/message-thread.tsx src/components/inbox/thread-header.tsx src/components/inbox/lead-popover.tsx
```

Expected: no errors.

- [ ] **Step 7: Run the full unit suite**

```bash
npm test
```

Expected: PASS. Nothing under test imports the header, so a failure here means something
unrelated broke — investigate before continuing.

- [ ] **Step 8: Commit**

```bash
git add src/components/inbox/message-thread.tsx
git commit -m "refactor(inbox): render the thread header from its own component"
```

---

## Task 5: Verify in the running app

**Files:** none — verification only.

**Interfaces:**
- Consumes: the whole feature.
- Produces: nothing.

- [ ] **Step 1: Start the dev server**

Use the preview tooling, not a bare shell:

- If `.claude/launch.json` has no entry for this app, create one with
  `{"name": "wa-amani", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000}`.
- Start it with `preview_start` using `{name: "wa-amani"}`.

Note: the app is behind a login wall. If the session is not already authenticated, stop here
and report that to the owner rather than attempting to sign in.

- [ ] **Step 2: Check the console and server log are clean**

Navigate to `/inbox`, open any conversation, then read console messages and preview logs.
Expected: no React key warnings, no hydration errors, no missing-i18n-key warnings (next-intl
logs these loudly — they would mean Task 1 Step 5 put the keys in the wrong object).

- [ ] **Step 3: Verify the row never wraps**

Resize the viewport to 1440, 1024, 768, and 375 px wide. At each width, read the page and
confirm the header renders as a single row. Screenshot the 1440 and 375 cases.

- [ ] **Step 4: Verify height stability**

Open a conversation with an ad referral, an open free window and tags; then one with none of
those. Measure both:

```js
document.querySelector('[class*="border-b"][class*="bg-card"]').getBoundingClientRect().height
```

Expected: identical values. This is the defect the whole change exists to fix.

- [ ] **Step 5: Verify the lead popover writes through**

Open the lead popover, pick a different stage, reload the page, confirm it stuck. Repeat for
assignee.

- [ ] **Step 6: Verify the archived and snoozed paths**

On an archived conversation: no Snooze control, and no Archive item in `⋮`. On a snoozed
conversation: a "Wake now" button and no Snooze split button.

- [ ] **Step 7: Report**

Post the two screenshots and the two height measurements. Do not claim the change works
without them.

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| Layout — identity zone | 3 |
| Layout — window pill (segments, tones, tooltip, `hidden sm:`) | 1 (branching), 3 (markup) |
| Actions — Status unchanged | 3, 4 |
| Actions — lead button label precedence | 1 (`leadButtonLabel`), 3 |
| Actions — lead popover sections 1–4 | 2 |
| Actions — Snooze icon-only, outside the menu | 3 |
| Actions — overflow items and conditions | 3, 4 |
| `⋮` hidden when empty (viewer path) | 3 (`hasOverflow`) |
| Structure — three new files, derivations stay put | 1, 2, 3, 4 |
| i18n — five new keys, en.json only | 1 |
| Testing — `threadHeader.test.ts` cases | 1 |
| Testing — manual checks | 5 |

No spec requirement is unassigned.

**Deviations from the spec, and why**

- The spec named the helper module's exports as `windowPill()` and `leadButtonLabel()`; this
  plan adds a third, `initials()`, because the label precedence table needs it and it is
  worth testing separately.
- The spec listed the popover's read-only context and tags as sections 3 and 4; this plan
  renders each only when non-empty, which the spec also requires — no conflict, just
  implemented via `hasContext` / `hasTags`.

**Placeholder scan:** no TBDs, no "add error handling", no "similar to Task N". Every code
step carries the code.

**Type consistency:** `windowPill` / `leadButtonLabel` / `initials` signatures in Task 1
match their call sites in Task 3. `LeadPopoverProps` in Task 2 matches the props Task 3
passes, field for field. `ThreadHeaderProps` in Task 3 matches the JSX in Task 4, field for
field — including `onMarkUnread` being a zero-arg callback in the child while
`message-thread.tsx` closes over `conversationId` at the call site.

**Import paths verified against the codebase**, not assumed:

| Symbol | Module | Confirmed by |
|---|---|---|
| `PresenceStatus` | `@/lib/presence` | `src/lib/presence.ts:32` |
| `presenceLabel(status, lastSeenAt, now)` | `@/lib/presence` | `src/lib/presence.ts:97` |
| `DropdownMenu*` | `@/components/ui/dropdown-menu` | `message-thread.tsx:71` |
| `canAssignToOthers` | `@/lib/auth/roles` | `message-thread.tsx:88` |
| `Popover*` | `@/components/ui/popover` | used by `label-picker.tsx` |
| `Profile` (not `MemberProfile`) | return type of `toUiMemberProfile` | `adapters.ts:195` |
| `UI_FUNNEL_STAGES`, `UiFunnelStageKey` | `@/lib/inbox/funnel` | `funnel.ts:6,17` |
