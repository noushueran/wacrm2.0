# Contact panel — checklist reach + decluttering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every lead a sales checklist in the Inbox contact panel, and reorganize that panel so its fourteen stacked blocks stop feeling crowded.

**Architecture:** A second, earlier trigger for `generateForSession` — fired the moment a qualification session's `serviceName` is first set, which is what the checklist's KB retrieval keys on — so the existing generation moves earlier rather than duplicating. On the frontend, the panel pins the four things a salesperson reads mid-chat, compacts the seven-row funnel to its current stage, and collapses the reference detail behind a small primitive whose branching lives in a pure, testable module.

**Tech Stack:** Convex (internalMutation, scheduler), Next.js 15 App Router, React 19, TypeScript, next-intl, Tailwind, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-14-inbox-contact-panel-design.md`

## Global Constraints

- **Never run `npx convex deploy`, `convex dev`, or `convex codegen`.** The owner runs those.
- **Never run prettier.** Match surrounding formatting by hand.
- **Scope lint to changed files:** `npx eslint <paths>` — never the whole repo.
- **Stage git paths explicitly:** `git add <specific paths>`; never `git add -A` or `git add .`.
- **`messages/en.json` is the single locale file — additive edits only.** Never reorder or reformat what you did not add; keep it valid JSON.
- **This repo has no jsdom, no Testing Library, and no React test renderer.** Component behaviour cannot be unit-tested. Any branching worth testing must live in a plain `.ts` module — that is why Task 2 splits the logic out. Do not add a DOM test harness.
- **Staff email is PII below admin role:** display names resolve `fullName ?? "Member"`, never email.
- Branch: `feat/inbox-contact-panel`, cut from `main` at `17cd5d4`.
- Tests: `npx vitest run <path>`. Type-check: `npx tsc --noEmit`.
- **Browser verification is impossible right now** and is not required by any task: `NEXT_PUBLIC_CONVEX_URL` points at a shared remote Convex deployment that lacks `salesChecklists.forConversation`, so the checklist section cannot render. Do not start a dev server to verify. Say so in your report rather than claiming visual confirmation.

---

## File Structure

**Create:**
- `src/lib/inbox/panelSections.ts` — pure section-state logic (which sections exist, resolving open/closed, parsing and serializing persisted state). No React.
- `src/lib/inbox/panelSections.test.ts`
- `src/components/inbox/contact-collapsible-section.tsx` — the collapsible primitive; presentational over `panelSections.ts`.
- `src/components/inbox/contact-detail-sections.tsx` — the travel, location, acquisition and about field groups, moved out whole.

**Modify:**
- `convex/qualificationEngine.ts` — the second generation trigger.
- `convex/qualificationEngine.test.ts` — its tests.
- `src/components/inbox/contact-sidebar.tsx` — composition, queries and edit state only.
- `messages/en.json` — the few new strings.

---

## Task 1: Generate the checklist when the service is first identified

**Files:**
- Modify: `convex/qualificationEngine.ts` (in `applyAnalysis`, around the `await ctx.db.patch(sessionId, patch);` at line 531)
- Test: `convex/qualificationEngine.test.ts`

**Interfaces:**
- Consumes: `internal.salesChecklists.generateForSession({accountId, sessionId})`, an existing `internalAction`.
- Produces: nothing new. No exported signature changes.

**Context you need:** `applyAnalysis` is an `internalMutation` (line 368) with `ctx.scheduler`. Its `args` carry `accountId`. `session` is the session document as it was **before** this patch, and `sessionId` is its id. `generateForSession` early-returns when the session already has a checklist (`if (!info || info.hasChecklist) return;`), which is what makes a second trigger safe.

- [ ] **Step 1: Write the failing tests**

Append to `convex/qualificationEngine.test.ts`, reusing that file's existing seed helpers and its established way of driving `applyAnalysis`. If the file drives analysis through a helper, use it rather than building a new harness.

```ts
test("identifying the service schedules the checklist, before qualification", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedQualConfig(t); // existing helper in this file
  const { conversationId, contactId, sessionId } = await seedCollectingSession(t, accountId);

  // Pre-condition: no serviceName yet, so no checklist has been asked for.
  const before = await t.run((ctx) => ctx.db.get(sessionId));
  expect(before!.serviceName).toBeUndefined();

  await t.mutation(internal.qualificationEngine.applyAnalysis, {
    accountId,
    conversationId,
    contactId,
    analysis: analysisWith({ serviceName: "Bali Packages" }),
  });

  const after = await t.run((ctx) => ctx.db.get(sessionId));
  expect(after!.serviceName).toBe("Bali Packages");
  // The scheduled action runs the real generator, which falls back to the
  // built-in default with no AI config — so a checklist row must exist.
  await t.finishAllScheduledFunctions();
  const checklist = await t.run((ctx) =>
    ctx.db
      .query("salesChecklists")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique(),
  );
  expect(checklist).not.toBeNull();
  expect(checklist!.items.length).toBeGreaterThan(0);
});

test("a session that already had a service does not generate a second time", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedQualConfig(t);
  const { conversationId, contactId, sessionId } = await seedCollectingSession(t, accountId);
  await t.run((ctx) => ctx.db.patch(sessionId, { serviceName: "Bali Packages" }));

  await t.mutation(internal.qualificationEngine.applyAnalysis, {
    accountId,
    conversationId,
    contactId,
    analysis: analysisWith({ serviceName: "Bali Packages" }),
  });
  await t.finishAllScheduledFunctions();

  const rows = await t.run((ctx) =>
    ctx.db
      .query("salesChecklists")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
});

test("analysis with no service name generates nothing", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedQualConfig(t);
  const { conversationId, contactId, sessionId } = await seedCollectingSession(t, accountId);

  await t.mutation(internal.qualificationEngine.applyAnalysis, {
    accountId,
    conversationId,
    contactId,
    analysis: analysisWith({ serviceName: null }),
  });
  await t.finishAllScheduledFunctions();

  const rows = await t.run((ctx) =>
    ctx.db
      .query("salesChecklists")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect(),
  );
  expect(rows).toHaveLength(0);
});
```

Then add one test proving the *reach* actually changed, in `convex/salesChecklists.test.ts` (that file already has `seedLead` and `seedAccountMember`):

```ts
test("forConversation returns a checklist for a lead still being collected", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@x.com", role: "agent",
  });
  // status "collecting", NOT qualified — the case that showed nothing before.
  const { conversationId } = await seedLead(t, {
    accountId, assignedToUserId: userId, status: "collecting", withChecklist: true,
  });

  const projection = await asUser.query(api.salesChecklists.forConversation, {
    conversationId,
  });
  expect(projection).not.toBeNull();
  expect(projection!.total).toBe(2);
});
```

`seedCollectingSession` and `analysisWith` may not exist under those names. Before writing, read the file and reuse whatever it already has for (a) seeding an account with an enabled qualification config, (b) seeding a `collecting` session, and (c) building a valid `analysis` argument. Only add a helper if none exists, and follow the file's existing shape.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run convex/qualificationEngine.test.ts -t "identifying the service"`
Expected: FAIL — no `salesChecklists` row is created, because nothing schedules generation yet.

- [ ] **Step 3: Capture the pre-patch service name**

In `applyAnalysis`, before the patch object is applied, capture whether the session already had a service. Put this immediately after the line reading `if (ready && !session.checklistSatisfiedAt) patch.checklistSatisfiedAt = now;` (~line 514), where `session` is already narrowed to non-null:

```ts
    // Captured BEFORE the patch lands: `patch.serviceName` is only set
    // when the analyst named a service, and we want the transition from
    // "unknown" to "known", not every later re-confirmation of the same one.
    const serviceWasUnknown = !session.serviceName;
```

- [ ] **Step 4: Schedule generation on the transition**

Immediately after `await ctx.db.patch(sessionId, patch);` (~line 531), add:

```ts
    // The lead's sales checklist used to wait for `completeQualification`,
    // which most sessions never reach — 188 checklists against 1,802
    // conversations — so the Inbox panel was empty for nine leads in ten.
    // It is scheduled here instead, the moment the service is first
    // identified, because `serviceName` is exactly what
    // `generateForSession`'s KB retrieval and prompt key on. Generating any
    // earlier (at `ensureSession`, which sets no service) would produce a
    // GENERIC checklist and then permanently block the tailored one, since
    // generation early-returns once a row exists.
    //
    // `completeQualification` keeps its own call as the safety net for a
    // lead that qualifies without a service ever being named. Whichever
    // fires first wins; the other no-ops on `info.hasChecklist`.
    if (serviceWasUnknown && patch.serviceName) {
      await ctx.scheduler.runAfter(
        0,
        internal.salesChecklists.generateForSession,
        { accountId: args.accountId, sessionId },
      );
    }
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run convex/qualificationEngine.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Run the neighbouring suites**

Run: `npx vitest run convex/salesChecklists.test.ts convex/qualification.test.ts`
Expected: PASS. These cover generation and the board's read; neither should change.

- [ ] **Step 7: Lint, type-check and commit**

```bash
npx eslint convex/qualificationEngine.ts convex/qualificationEngine.test.ts
npx tsc --noEmit
git add convex/qualificationEngine.ts convex/qualificationEngine.test.ts
git commit -m "feat(checklist): generate as soon as the service is identified

Generation waited for completeQualification, which most sessions never
reach — 188 checklists against 1,802 conversations — so the Inbox panel
was empty for nine leads in ten. Scheduling on the serviceName transition
keeps the KB-tailored quality (that field is what retrieval keys on) and
only moves the timing earlier. The qualification-time call stays as the
safety net; generation is idempotent, so whichever fires first wins."
```

---

## Task 2: The pure section-state logic

**Files:**
- Create: `src/lib/inbox/panelSections.ts`
- Test: `src/lib/inbox/panelSections.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PANEL_SECTION_KEYS: readonly PanelSectionKey[]` and `type PanelSectionKey`
  - `type PanelSectionState = Partial<Record<PanelSectionKey, boolean>>`
  - `resolveSectionOpen(opts: {editing: boolean; editable: boolean; persisted: boolean | undefined; defaultOpen: boolean}): boolean`
  - `parseSectionState(raw: string | null): PanelSectionState`
  - `serializeSectionState(state: PanelSectionState): string`
  - `PANEL_SECTION_STORAGE_KEY: string`

Tasks 3 and 4 consume exactly these.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/inbox/panelSections.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  PANEL_SECTION_KEYS,
  PANEL_SECTION_STORAGE_KEY,
  parseSectionState,
  resolveSectionOpen,
  serializeSectionState,
  shouldShowMarker,
} from "./panelSections";

describe("PANEL_SECTION_KEYS", () => {
  test("covers exactly the six collapsible sections, no duplicates", () => {
    expect([...PANEL_SECTION_KEYS].sort()).toEqual(
      ["acquisition", "activity", "deals", "keyFacts", "location", "travel"].sort(),
    );
    expect(new Set(PANEL_SECTION_KEYS).size).toBe(PANEL_SECTION_KEYS.length);
  });
});

describe("resolveSectionOpen", () => {
  test("uses the default when nothing is persisted", () => {
    expect(
      resolveSectionOpen({ editing: false, editable: true, persisted: undefined, defaultOpen: false }),
    ).toBe(false);
    expect(
      resolveSectionOpen({ editing: false, editable: true, persisted: undefined, defaultOpen: true }),
    ).toBe(true);
  });

  test("a persisted choice wins over the default, in both directions", () => {
    expect(
      resolveSectionOpen({ editing: false, editable: true, persisted: true, defaultOpen: false }),
    ).toBe(true);
    expect(
      resolveSectionOpen({ editing: false, editable: true, persisted: false, defaultOpen: true }),
    ).toBe(false);
  });

  test("edit mode forces an editable section open, overriding a persisted close", () => {
    expect(
      resolveSectionOpen({ editing: true, editable: true, persisted: false, defaultOpen: false }),
    ).toBe(true);
  });

  test("edit mode does NOT force open a section with no editable fields", () => {
    // Activity and Deals are read-only; forcing them open on Edit would
    // just re-crowd the panel at the moment the user needs to focus.
    expect(
      resolveSectionOpen({ editing: true, editable: false, persisted: false, defaultOpen: false }),
    ).toBe(false);
  });
});

describe("parseSectionState", () => {
  test("returns an empty state for null, invalid JSON, or a non-object", () => {
    expect(parseSectionState(null)).toEqual({});
    expect(parseSectionState("{oops")).toEqual({});
    expect(parseSectionState('"a string"')).toEqual({});
    expect(parseSectionState("[1,2]")).toEqual({});
  });

  test("keeps only known keys with boolean values", () => {
    const parsed = parseSectionState(
      JSON.stringify({ travel: true, deals: false, bogus: true, location: "yes" }),
    );
    expect(parsed).toEqual({ travel: true, deals: false });
  });

  test("round-trips through serialize", () => {
    const state = { travel: true, activity: false } as const;
    expect(parseSectionState(serializeSectionState(state))).toEqual(state);
  });
});

describe("shouldShowMarker", () => {
  test("never shows while the section is open — the content speaks for itself", () => {
    expect(shouldShowMarker({ open: true, marker: 3 })).toBe(false);
    expect(shouldShowMarker({ open: true, marker: true })).toBe(false);
  });

  test("shows a positive count, hides a zero count", () => {
    expect(shouldShowMarker({ open: false, marker: 3 })).toBe(true);
    expect(shouldShowMarker({ open: false, marker: 0 })).toBe(false);
  });

  test("shows on true, hides on false and null", () => {
    expect(shouldShowMarker({ open: false, marker: true })).toBe(true);
    expect(shouldShowMarker({ open: false, marker: false })).toBe(false);
    expect(shouldShowMarker({ open: false, marker: null })).toBe(false);
  });
});

describe("PANEL_SECTION_STORAGE_KEY", () => {
  test("is namespaced so it cannot collide with other app storage", () => {
    expect(PANEL_SECTION_STORAGE_KEY).toContain("inbox");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/inbox/panelSections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `src/lib/inbox/panelSections.ts`:

```ts
// ============================================================
// Pure contact-panel section state: which sections collapse, and whether
// a given one is open right now. No React and no browser API, so the
// branching is unit-testable in a repo with no DOM test harness — the
// same split `src/lib/inbox/notes.ts` established.
//
// The panel pins identity, status, funnel, checklist and labels; these
// six are the reference detail that collapses.
// ============================================================

export const PANEL_SECTION_KEYS = [
  "travel",
  "location",
  "acquisition",
  "keyFacts",
  "deals",
  "activity",
] as const;

export type PanelSectionKey = (typeof PANEL_SECTION_KEYS)[number];

/** Only sections the user has explicitly toggled appear here; an absent
 *  key means "never touched", which is why `persisted` is optional
 *  rather than defaulted at the storage layer. */
export type PanelSectionState = Partial<Record<PanelSectionKey, boolean>>;

/** Namespaced: `localStorage` is shared with everything else this origin
 *  stores. */
export const PANEL_SECTION_STORAGE_KEY = "inbox.contactPanel.sections";

const KNOWN = new Set<string>(PANEL_SECTION_KEYS);

/**
 * Is this section open?
 *
 * Edit mode wins over everything, but ONLY for sections that actually
 * contain editable fields: forcing Activity and Deals open on Edit would
 * re-crowd the panel at the exact moment the user is trying to focus on
 * one field. Otherwise an explicit persisted choice wins, and the
 * default applies when the user has never touched this section.
 */
export function resolveSectionOpen(opts: {
  editing: boolean;
  editable: boolean;
  persisted: boolean | undefined;
  defaultOpen: boolean;
}): boolean {
  if (opts.editing && opts.editable) return true;
  return opts.persisted ?? opts.defaultOpen;
}

/** Tolerant by design: a corrupt or hand-edited value must degrade to
 *  "no preferences" rather than throwing inside a render. */
export function parseSectionState(raw: string | null): PanelSectionState {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: PanelSectionState = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (KNOWN.has(key) && typeof value === "boolean") {
      out[key as PanelSectionKey] = value;
    }
  }
  return out;
}

export function serializeSectionState(state: PanelSectionState): string {
  return JSON.stringify(state);
}

/**
 * Should the closed-state content marker render?
 *
 * This is what stops collapsing from being lossy: with six sections shut,
 * "collapsed" and "empty" are otherwise indistinguishable. Never shown
 * while open — the content is right there. A zero count is treated as no
 * content, so an empty Deals section does not advertise a "0".
 */
export function shouldShowMarker(opts: {
  open: boolean;
  marker: number | boolean | null;
}): boolean {
  if (opts.open) return false;
  return typeof opts.marker === "number" ? opts.marker > 0 : opts.marker === true;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/inbox/panelSections.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint src/lib/inbox/panelSections.ts src/lib/inbox/panelSections.test.ts
git add src/lib/inbox/panelSections.ts src/lib/inbox/panelSections.test.ts
git commit -m "feat(inbox): pure section-state logic for the contact panel

Branching lives here rather than in the component because this repo has
no DOM test harness — the same split notes.ts established. Edit mode
forces only sections that actually hold editable fields, so opening Edit
does not re-crowd the panel with Activity and Deals."
```

---

## Task 3: The collapsible primitive

**Files:**
- Create: `src/components/inbox/contact-collapsible-section.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `resolveSectionOpen`, `PanelSectionKey` from Task 2.
- Produces:
  ```tsx
  <ContactCollapsibleSection
    sectionKey={PanelSectionKey}
    icon={LucideIcon}
    label={string}
    /** Shown beside the label when collapsed and the section has content:
     *  a number renders as a count, `true` renders as a filled dot. */
    marker={number | boolean | null}
    open={boolean}
    onToggle={(next: boolean) => void}
  >{children}</ContactCollapsibleSection>
  ```
  Task 4 renders six of these. State lives in the sidebar, not here — this component is presentational.

- [ ] **Step 1: Add the i18n strings**

In `messages/en.json`, inside `Inbox.sidebar`, add:

```json
      "expandSection": "Show {label}",
      "collapseSection": "Hide {label}",
      "sectionHasContent": "Has content",
```

- [ ] **Step 2: Build the component**

Create `src/components/inbox/contact-collapsible-section.tsx`:

```tsx
"use client";

import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { shouldShowMarker, type PanelSectionKey } from "@/lib/inbox/panelSections";

/**
 * One collapsible block of the contact panel.
 *
 * Purely presentational — open/closed state and its persistence live in
 * `ContactSidebar`, because six of these share one stored object and one
 * `editing` flag; `resolveSectionOpen` decides, this renders.
 *
 * `marker` is what stops collapsing from being lossy: with six sections
 * shut, "collapsed" and "empty" are indistinguishable without it, so a
 * section holding data shows a count (or a dot where a count means
 * nothing) on its closed header.
 */
export function ContactCollapsibleSection({
  sectionKey,
  icon: Icon,
  label,
  marker,
  open,
  onToggle,
  children,
}: {
  sectionKey: PanelSectionKey;
  icon: LucideIcon;
  label: string;
  marker: number | boolean | null;
  open: boolean;
  onToggle: (next: boolean) => void;
  children: React.ReactNode;
}) {
  const t = useTranslations("Inbox.sidebar");
  const showMarker = shouldShowMarker({ open, marker });

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        aria-controls={`panel-section-${sectionKey}`}
        title={open ? t("collapseSection", { label }) : t("expandSection", { label })}
        className="flex w-full items-center gap-2 px-1 py-2.5 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
        />
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{label}</span>
        {showMarker && (
          <span
            className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal normal-case tracking-normal text-muted-foreground"
            title={t("sectionHasContent")}
          >
            {typeof marker === "number" ? marker : "•"}
          </span>
        )}
      </button>
      {open && (
        <div id={`panel-section-${sectionKey}`} className="pb-3">
          {children}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean. (No test for this file: its only decision — whether the closed-state marker renders — is `shouldShowMarker` from Task 2 and is already covered there. What remains is markup, and the repo has no DOM harness. See Global Constraints.)

- [ ] **Step 4: Lint and commit**

```bash
npx eslint src/components/inbox/contact-collapsible-section.tsx
git add src/components/inbox/contact-collapsible-section.tsx messages/en.json
git commit -m "feat(inbox): collapsible section primitive for the contact panel

Presentational over panelSections' resolveSectionOpen. The closed-state
marker is the part that matters: with six sections shut, collapsed and
empty are otherwise indistinguishable."
```

---

## Task 4: Extract the detail field groups

**Files:**
- Create: `src/components/inbox/contact-detail-sections.tsx`
- Modify: `src/components/inbox/contact-sidebar.tsx`

**Interfaces:**
- Consumes: nothing from Tasks 1-3.
- Produces: four components, each rendering only the *inside* of its section (no heading — Task 5's `ContactCollapsibleSection` supplies that):
  ```tsx
  <ContactTravelFields form={EditForm|null} editing={boolean} onChange={(patch: Partial<EditForm>) => void} contact={Contact} />
  <ContactLocationFields  ...same props />
  <ContactAboutFields     ...same props />
  <ContactAcquisitionFields contact={Contact} />   // read-only, no edit props
  ```

**This task is a pure move with no behaviour change.** Do not redesign the fields, do not change copy, do not alter the edit wiring. If you find yourself improving something, stop — that belongs to a later change.

- [ ] **Step 1: Read the four blocks**

They are contiguous in `contact-sidebar.tsx`: Acquisition (~558-583), Location (~627-657), Travel profile (~658-706), About (~707-729). Read all four plus the `Section`, `Field` and `EditForm` definitions near the bottom of the file so the moved code keeps compiling.

- [ ] **Step 2: Move them verbatim**

Create `src/components/inbox/contact-detail-sections.tsx` with a `"use client"` directive and the four components, each containing exactly the JSX that lived inside its old `<Section>` wrapper — the wrapper itself stays behind, because Task 5 replaces it with a collapsible one. Export the `EditForm` type from wherever it currently lives, or move it here and import it back into the sidebar, whichever produces fewer cross-imports.

Add a file header in the codebase's voice, e.g.:

```tsx
// ============================================================
// The contact panel's reference detail — travel, location, acquisition
// and about. Extracted from `contact-sidebar.tsx` (958 lines carrying
// layout, queries, edit state, photo staging AND every field group) so
// the sidebar can own composition and these can own fields.
//
// Each component renders only the INSIDE of its section: the heading and
// the collapse control belong to `ContactCollapsibleSection`.
// ============================================================
```

- [ ] **Step 3: Wire them back in unchanged**

In `contact-sidebar.tsx`, replace each moved block's body with the new component, leaving the existing `<Section>` wrappers in place for now:

```tsx
          <Section icon={Plane} label={tSidebar("sectionTravel")}>
            <ContactTravelFields
              form={form}
              editing={editing}
              onChange={(patch) => setForm((f) => (f ? { ...f, ...patch } : f))}
              contact={contact}
            />
          </Section>
```

Match each existing block's props to whatever it actually reads — the shape above is the pattern, not a spec for all four.

- [ ] **Step 4: Verify nothing changed**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx vitest run`
Expected: everything passes. A pure move must not move a single test.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint src/components/inbox/contact-detail-sections.tsx src/components/inbox/contact-sidebar.tsx
git add src/components/inbox/contact-detail-sections.tsx src/components/inbox/contact-sidebar.tsx
git commit -m "refactor(inbox): extract the contact panel's detail field groups

Pure move, no behaviour change: travel, location, acquisition and about
leave a 958-line sidebar that was carrying layout, queries, edit state,
photo staging and every field group at once."
```

---

## Task 5: Reorganize the panel

**Files:**
- Modify: `src/components/inbox/contact-sidebar.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `PANEL_SECTION_KEYS`, `PanelSectionState`, `parseSectionState`, `serializeSectionState`, `resolveSectionOpen`, `PANEL_SECTION_STORAGE_KEY` (Task 2); `ContactCollapsibleSection` (Task 3); the four field-group components (Task 4).
- Produces: nothing consumed later.

**The target order.** Pinned, in this order: Identity (absorbing the old standalone Contact section — the WhatsApp number moves up beside the name and that section disappears entirely), Status strip, Funnel, Sales checklist, Labels + tag-suggestion banner. Then the six collapsibles: Travel profile, Location, Acquisition, Key facts, Deals, Activity.

- [ ] **Step 1: Add the section-state hook to the sidebar**

Near the component's other state, add:

```tsx
  // One stored object for all six sections. Read once on mount rather
  // than per section: `localStorage` is synchronous and this component
  // never unmounts (it lives inside the always-mounted drawer).
  const [sectionState, setSectionState] = useState<PanelSectionState>({});
  useEffect(() => {
    setSectionState(parseSectionState(window.localStorage.getItem(PANEL_SECTION_STORAGE_KEY)));
  }, []);

  const toggleSection = useCallback((key: PanelSectionKey, next: boolean) => {
    setSectionState((prev) => {
      const updated = { ...prev, [key]: next };
      try {
        window.localStorage.setItem(
          PANEL_SECTION_STORAGE_KEY,
          serializeSectionState(updated),
        );
      } catch {
        // Private mode or a full quota — the preference is a convenience,
        // never a correctness requirement, so a failed write is ignored
        // and the session keeps its in-memory choice.
      }
      return updated;
    });
  }, []);
```

Reading in an effect rather than a `useState` initializer is deliberate: the initializer would run during SSR where `window` is undefined.

- [ ] **Step 2: Move the WhatsApp number into the identity header and delete the Contact section**

Take the WhatsApp-number row out of the `<Section icon={Phone} label={tSidebar("sectionContact")}>` block and render it under the name in the header block (~line 381). Keep its copy-to-clipboard behaviour exactly as-is. If the Contact section holds anything besides the number, move that into the About collapsible rather than inventing a new section. Then delete the now-empty `<Section>` and its `sectionContact` usage.

Leave the `sectionContact` key in `messages/en.json` — removing a key is not additive, and a stray unused string costs nothing.

- [ ] **Step 3: Render the six collapsibles**

Replace each remaining `<Section>` wrapper for travel/location/acquisition/keyFacts/deals/activity with:

```tsx
          <ContactCollapsibleSection
            sectionKey="travel"
            icon={Plane}
            label={tSidebar("sectionTravel")}
            marker={hasTravelDetail}
            open={resolveSectionOpen({
              editing,
              editable: true,
              persisted: sectionState.travel,
              defaultOpen: false,
            })}
            onToggle={(next) => toggleSection("travel", next)}
          >
            <ContactTravelFields
              form={form}
              editing={editing}
              onChange={(patch) => setForm((f) => (f ? { ...f, ...patch } : f))}
              contact={contact}
            />
          </ContactCollapsibleSection>
```

For each section, pass `editable` and `marker` as follows:

| sectionKey | icon | editable | marker |
|---|---|---|---|
| `travel` | `Plane` | `true` | `true` when any travel field on the contact is set |
| `location` | `MapPin` | `true` | `true` when any location field is set |
| `acquisition` | `Megaphone` | `false` | `true` when the contact has ad/campaign attribution |
| `keyFacts` | `SlidersHorizontal` | `true` | `true` (custom fields are their own component and the sidebar cannot cheaply count them) |
| `deals` | `DollarSign` | `false` | `deals.length` |
| `activity` | the icon the activity block already uses | `false` | `true` |

Compute each boolean marker from data already in scope — do not add a query for it.

- [ ] **Step 4: Compact the funnel**

The funnel block (~line 584) renders all seven stages as a stacked list, one of the largest single contributors to the crowding. Keep it pinned, but show only the current stage at rest with a control to reveal the rest. Add local state beside the others:

```tsx
  const [showAllStages, setShowAllStages] = useState(false);
```

Then render the current stage plus a toggle, and the full `buildFunnelSteps(funnelState).map(...)` list only when `showAllStages` is true. Do not change `buildFunnelSteps`, the Meta-reporting badges, the `crmOnly` note or the sale-value line — only which of them are visible at rest.

Add to `messages/en.json` under `Inbox.funnel`:

```json
    "showAllStages": "All stages",
    "hideAllStages": "Hide stages",
```

- [ ] **Step 5: Order the panel**

Ensure the final JSX order is: identity header → status strip → funnel → sales checklist → tag-suggestion banner → labels → travel → location → acquisition → key facts → deals → activity. The do-not-contact indicator stays exactly where it is inside the status strip.

- [ ] **Step 6: Type-check and run the suite**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx vitest run`
Expected: everything passes.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint src/components/inbox/contact-sidebar.tsx
git add src/components/inbox/contact-sidebar.tsx messages/en.json
git commit -m "feat(inbox): pin what a salesperson reads, collapse the rest

The panel stacked fourteen blocks in a ~300px column. Identity absorbs
the standalone Contact section, the seven-row funnel rests at its current
stage, and six reference sections collapse behind markers that keep
'collapsed' distinguishable from 'empty'. Edit mode force-opens only the
sections that actually hold editable fields."
```

---

## Final verification

- [ ] `npx vitest run` — passes, except any codegen-drift failure the owner has not yet cleared.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx eslint` over every file this plan touched — clean.
- [ ] `git status --short` — clean.
- [ ] Confirm no task started a dev server or claimed browser verification (see Global Constraints).
- [ ] Report to the owner that the checklist changes are invisible until `npx convex deploy` runs.
