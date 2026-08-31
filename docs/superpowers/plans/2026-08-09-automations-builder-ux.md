# Automations Builder UX Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the thirteen actions discoverable, show what a send will look like before it goes out, and surface Meta's limits while editing instead of at runtime.

**Architecture:** Purely presentational. No schema changes, no engine changes, no new Convex functions. Three self-contained components — a grouped searchable action picker, a WhatsApp-style message preview, and an inline validation strip — replacing the flat menu and silent fields in `automation-builder.tsx`. The validation strip calls the *same* `validateStepsForActivation` the server runs, so the builder can never disagree with the activation gate.

**Tech Stack:** React, Tailwind, next-intl, `cmdk` (if already a dependency — check before adding).

Spec: `docs/superpowers/specs/2026-08-09-automations-enhancement-design.md` §3

**Depends on:** Phase 1 (`2026-08-09-automations-send-composer.md`). Task 1 below removes `send_buttons`/`send_list` from the menu, which Phase 1 Task 10 also does — if Phase 1 has not landed, that removal belongs to it, not here.

## Global Constraints

- **Never run `convex deploy`, `convex dev`, or `convex codegen`.**
- No changes to `convex/` in this plan. If a task seems to need one, stop and say so — it belongs in a different plan.
- **Do not import from a `convex/` query module in a `"use client"` component.** It ships server code into the browser bundle. Shared pure logic goes in `convex/lib/**`, which is dependency-free by convention.
- Every user-visible string goes through `next-intl` (`messages/en.json`), never hardcoded — the existing builder does this consistently.
- Reuse `convex/lib/whatsapp/interactive.ts`'s `INTERACTIVE_LIMITS` and `validateInteractivePayload`. Do not restate Meta's numbers anywhere in `src/`.
- Tests: component tests go in `src/**/*.test.tsx` under the `node` project. Run with `npx vitest run src/`.
- Lint only changed files: `npx eslint <paths>`. Typecheck: `npx tsc --noEmit`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

**Created:**
- `src/components/automations/action-picker.tsx` — the grouped, searchable add menu.
- `src/components/automations/action-catalog.ts` — the group/description/keyword data, pure and testable.
- `src/components/automations/action-catalog.test.ts` — its spec.
- `src/components/automations/message-preview.tsx` — WhatsApp-style bubble preview.
- `src/components/automations/step-issues.tsx` — inline validation strip.

**Modified:**
- `src/components/automations/automation-builder.tsx` — swap the menu, mount the preview and the issue strip.
- `src/components/automations/send-composer.tsx` (from Phase 1) — mount the preview and the strip.
- `messages/en.json` — group names, descriptions, search placeholder.

---

### Task 1: The action catalog

The menu's data — which group an action belongs to, its one-line description, and the words someone might search for it by — kept separate from the component so it can be tested and so a missing entry is a test failure rather than a blank row.

**Files:**
- Create: `src/components/automations/action-catalog.ts`
- Test: `src/components/automations/action-catalog.test.ts`

**Interfaces:**
- Consumes: `AutomationStepType` from `src/types`.
- Produces:
  - `ACTION_GROUPS: readonly ActionGroup[]` where `ActionGroup = { id: "message" | "contact" | "flow" | "advanced"; steps: readonly AutomationStepType[] }`
  - `ACTION_KEYWORDS: Record<AutomationStepType, readonly string[]>`
  - `searchActions(query: string): AutomationStepType[]`
  Task 2 imports all three.

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "vitest";
import { ACTION_GROUPS, ACTION_KEYWORDS, searchActions } from "./action-catalog";

const ADDABLE = [
  "send_message",
  "send_template",
  "add_tag",
  "remove_tag",
  "assign_conversation",
  "update_contact_field",
  "create_deal",
  "wait",
  "condition",
  "send_webhook",
  "close_conversation",
] as const;

test("every addable step appears in exactly one group", () => {
  const placed = ACTION_GROUPS.flatMap((g) => g.steps);
  expect([...placed].sort()).toEqual([...ADDABLE].sort());
});

test("send_buttons and send_list are NOT in the menu — they live in the composer", () => {
  const placed = ACTION_GROUPS.flatMap((g) => g.steps);
  expect(placed).not.toContain("send_buttons");
  expect(placed).not.toContain("send_list");
});

test("every addable step has search keywords", () => {
  for (const step of ADDABLE) {
    expect(ACTION_KEYWORDS[step]?.length ?? 0).toBeGreaterThan(0);
  }
});

test("an empty query returns every addable step in group order", () => {
  expect(searchActions("")).toEqual(ACTION_GROUPS.flatMap((g) => g.steps));
});

test("search matches the step type itself", () => {
  expect(searchActions("webhook")).toContain("send_webhook");
});

test("search matches a keyword the step type does not contain", () => {
  // Someone looking for buttons should land on the composer's step.
  expect(searchActions("button")).toContain("send_message");
  // "delay" is what people call a wait.
  expect(searchActions("delay")).toContain("wait");
  // "image" / "photo" should also find the send step.
  expect(searchActions("photo")).toContain("send_message");
});

test("search is case-insensitive and ignores surrounding whitespace", () => {
  expect(searchActions("  WEBHOOK ")).toContain("send_webhook");
});

test("a query matching nothing returns an empty array", () => {
  expect(searchActions("zzzzz")).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/automations/action-catalog.test.ts`
Expected: FAIL — `Failed to resolve import "./action-catalog"`.

- [ ] **Step 3: Write the implementation**

```ts
import type { AutomationStepType } from "@/types"

export type ActionGroupId = "message" | "contact" | "flow" | "advanced"

export interface ActionGroup {
  id: ActionGroupId
  steps: readonly AutomationStepType[]
}

/**
 * The add menu, grouped. `send_buttons` and `send_list` are deliberately
 * absent: they are a toggle inside the send composer now, not separate
 * actions. Their STEP_META entries survive so stored steps still render.
 *
 * Order is the order shown. Message first because it is what almost every
 * automation starts with; Advanced last because those two actions are
 * rarely what someone is looking for and were previously mixed in with
 * everything else in one flat scrolling list.
 */
export const ACTION_GROUPS: readonly ActionGroup[] = [
  { id: "message", steps: ["send_message", "send_template"] },
  {
    id: "contact",
    steps: [
      "add_tag",
      "remove_tag",
      "update_contact_field",
      "create_deal",
      "assign_conversation",
    ],
  },
  { id: "flow", steps: ["wait", "condition"] },
  { id: "advanced", steps: ["send_webhook", "close_conversation"] },
] as const

/**
 * Words someone might type looking for each action, beyond the step type
 * itself. "button"/"image" point at `send_message` because the composer
 * absorbed those capabilities — without them, searching "buttons" would
 * return nothing, which is exactly the discovery failure this fixes.
 */
export const ACTION_KEYWORDS: Record<AutomationStepType, readonly string[]> = {
  send_message: [
    "text", "reply", "message", "button", "buttons", "list", "quick reply",
    "media", "image", "photo", "video", "audio", "voice", "document", "pdf",
    "attachment", "caption",
  ],
  send_template: ["template", "approved", "hsm", "re-engage", "reengage", "outside window"],
  add_tag: ["tag", "label", "mark"],
  remove_tag: ["tag", "label", "untag"],
  update_contact_field: ["field", "custom field", "property", "attribute", "name", "email"],
  create_deal: ["deal", "pipeline", "opportunity", "sale"],
  assign_conversation: ["assign", "agent", "owner", "route", "round robin"],
  wait: ["wait", "delay", "pause", "sleep", "later"],
  condition: ["condition", "if", "else", "branch", "split", "window", "24 hour"],
  send_webhook: ["webhook", "http", "post", "api", "integration", "zapier"],
  close_conversation: ["close", "resolve", "archive", "done"],
  // Present so the record stays exhaustive over AutomationStepType; never
  // shown, because neither appears in ACTION_GROUPS.
  send_buttons: [],
  send_list: [],
}

/** Group-ordered, filtered by a free-text query. Empty query = everything. */
export function searchActions(query: string): AutomationStepType[] {
  const all = ACTION_GROUPS.flatMap((g) => g.steps)
  const q = query.trim().toLowerCase()
  if (!q) return [...all]
  return all.filter(
    (step) =>
      step.replace(/_/g, " ").includes(q) ||
      ACTION_KEYWORDS[step].some((k) => k.includes(q)),
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/automations/action-catalog.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/automations/action-catalog.ts src/components/automations/action-catalog.test.ts
git commit -m "feat(automations): grouped, searchable catalog for the add-action menu

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The action picker

**Files:**
- Create: `src/components/automations/action-picker.tsx`
- Modify: `src/components/automations/automation-builder.tsx:1260-1280` (the current flat `DropdownMenu`)
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `ACTION_GROUPS`, `searchActions`, `ACTION_KEYWORDS` (Task 1); `STEP_META` from `automation-builder.tsx` (export it if it is currently module-private).
- Produces: `<ActionPicker onPick={(type: AutomationStepType) => void} />` — renders its own trigger button.

- [ ] **Step 1: Check for an existing command component**

Run: `ls src/components/ui/ | grep -i "command\|popover"` and `node -e "console.log(Object.keys(require('./package.json').dependencies).filter(d=>/cmdk|popover|dialog/.test(d)))"`

If `src/components/ui/command.tsx` exists, build on it. If not, build the picker from the existing `DropdownMenu` primitives plus a plain `<Input>` — **do not add `cmdk` as a new dependency for this**. A filtered list inside a dropdown is enough.

- [ ] **Step 2: Build the picker**

`<ActionPicker>` renders the same circular `+` trigger the builder uses today, opening a panel roughly 320px wide containing:

- a search `<Input>`, autofocused on open, placeholder *"Search actions…"*;
- the results grouped under small uppercase group headings (**Message**, **Contact**, **Flow control**, **Advanced**), hiding any group whose steps all filtered out;
- one row per action: icon (from `STEP_META`), label (`t("steps.<type>")`), and a one-line description beneath it in muted text;
- an empty state — *"No actions match '<query>'."*

Keyboard: `↑`/`↓` move the highlight across the flattened result list, `Enter` picks, `Escape` closes. The search input keeps focus throughout.

Max height ~420px with `overflow-y-auto`, so the panel never runs past the viewport the way the current menu does.

- [ ] **Step 3: Add the strings**

In `messages/en.json` under `Automations.builder`, add:

```json
"actionPicker": {
  "searchPlaceholder": "Search actions…",
  "empty": "No actions match \"{query}\".",
  "groups": {
    "message": "Message",
    "contact": "Contact",
    "flow": "Flow control",
    "advanced": "Advanced"
  },
  "descriptions": {
    "send_message": "Text, image, video, audio or document — with optional reply buttons.",
    "send_template": "An approved template. The only thing you can send outside the 24-hour window.",
    "add_tag": "Attach a tag to the contact.",
    "remove_tag": "Take a tag off the contact.",
    "update_contact_field": "Set a built-in or custom field on the contact.",
    "create_deal": "Open a deal in a pipeline stage.",
    "assign_conversation": "Hand the conversation to an agent.",
    "wait": "Pause before the next step.",
    "condition": "Branch on a tag, a field, the message, the time, or the 24-hour window.",
    "send_webhook": "POST the trigger context to a URL.",
    "close_conversation": "Mark the conversation resolved."
  }
}
```

- [ ] **Step 4: Swap it in**

Replace the existing flat `DropdownMenu` add-step control in `automation-builder.tsx` with `<ActionPicker onPick={...} />`, keeping the existing `addStep` callback exactly as it is. Delete `ADDABLE_STEPS` — `ACTION_GROUPS` supersedes it. Leave `STEP_META` complete (all thirteen entries) and export it for the picker.

- [ ] **Step 5: Verify in the browser**

1. Open an automation, click `+`. Confirm four groups with descriptions, and no Send Buttons / Send List entries.
2. Type `button` — confirm Send Message matches.
3. Type `delay` — confirm Wait matches.
4. Type `zzz` — confirm the empty state.
5. Arrow down twice, press Enter — confirm the highlighted action is added.
6. Confirm the panel scrolls internally and does not overflow the viewport near the bottom of a long automation. This was a real defect in the old menu — it opened anchored under the `+` and overlapped the cards below it.
7. `read_console_messages` — expect no errors.
8. Screenshot at desktop and at the `mobile` preset.

- [ ] **Step 6: Commit**

```bash
git add src/components/automations/action-picker.tsx src/components/automations/automation-builder.tsx messages/en.json
git commit -m "feat(automations): grouped searchable action picker

Thirteen actions in one flat ungrouped scroll-list read as "send a message
and some odds and ends". Now grouped by purpose, described in one line
each, and searchable — including by capabilities the composer absorbed,
so "buttons" and "image" both find Send Message.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: WhatsApp-style message preview

**Files:**
- Create: `src/components/automations/message-preview.tsx`
- Modify: `src/components/automations/send-composer.tsx`
- Modify: `src/components/automations/automation-builder.tsx` (`send_template` editor)

**Interfaces:**
- Consumes: `SendMessageStepConfig` (`src/types`), `resolveMediaUrl` from `src/lib/r2/url` (check the real client-side export used by `node-config-form.tsx`).
- Produces: `<MessagePreview config={SendMessageStepConfig} />`.

- [ ] **Step 1: Check for an existing preview component**

Run: `grep -rln "preview" src/components/interactive/ src/components/conversations/ | head`

`interactive-builder.tsx` already renders a preview column for buttons and lists (`interactive-builder.tsx:164`). **Reuse it** for the interactive case rather than drawing bubbles twice — `<MessagePreview>` should delegate to it when `config.interactive` is set, and only draw its own bubble for the text/media cases.

- [ ] **Step 2: Build the preview**

A single outgoing bubble on the chat-background tint, matching the interactive builder's existing preview styling so the two read as one component:

- **text only** — the text, preserving line breaks, with `{{ }}` placeholders rendered in a muted pill so it is obvious they interpolate at send time;
- **image / video** — a thumbnail (or a placeholder tile when the media is still uploading or unresolvable), with the text beneath it as a caption;
- **audio** — an audio-bubble affordance, and when text is present, a **second** bubble beneath it, because that is literally what will be sent (Phase 1 §1.2 row 1). Showing one bubble here would be a lie;
- **document** — a file chip showing `filename`, caption beneath;
- **interactive** — delegate to the existing interactive preview;
- **nothing configured** — muted *"Nothing to send yet."*

Keep it presentational: no queries, no uploads, no `useEffect` fetches.

- [ ] **Step 3: Mount it**

In `send-composer.tsx`, place `<MessagePreview>` to the right of the fields at container width `@2xl` and beneath them below that — the same container-query breakpoint Phase 1 Task 9 established for `interactive-builder.tsx`, so the two components fold at the same width.

For `send_template`, render a simplified preview: the template body with each `{{n}}` substituted by the value typed into that variable's input, falling back to a muted `{{n}}` pill when empty.

- [ ] **Step 4: Verify in the browser**

For each case — text, image, audio-with-text, document, buttons, empty — confirm the preview matches what the step will actually send. The audio-with-text case must show two bubbles. Screenshot each.

- [ ] **Step 5: Commit**

```bash
git add src/components/automations/message-preview.tsx src/components/automations/send-composer.tsx src/components/automations/automation-builder.tsx
git commit -m "feat(automations): live preview of what a send step will actually send

Audio with text renders as two bubbles because that is what Meta will
receive — a single bubble would misrepresent it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Inline validation

**Files:**
- Create: `src/components/automations/step-issues.tsx`
- Modify: `src/components/automations/automation-builder.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `validateStepsForActivation` and `ValidationIssue` from `convex/lib/automations/validate` — this is a pure `convex/lib/**` module with no Convex imports, so importing it from a client component is safe and is the point: the builder and the activation gate then cannot disagree.
- Produces: `<StepIssues issues={ValidationIssue[]} />` and a `useStepIssues(steps)` hook returning issues keyed by step path.

- [ ] **Step 1: Confirm the import is client-safe**

Run: `grep -n "^import" convex/lib/automations/validate.ts`

Expected: imports only from other `convex/lib/**` modules — no `./_generated/*`, no `convex/server`. If it does import from `_generated`, stop: extract the pure part first, because importing it would ship server code to the browser.

- [ ] **Step 2: Build the issue strip**

`<StepIssues>` renders nothing when `issues` is empty; otherwise a compact amber strip listing each issue's message. Use amber, not destructive red — these are "this will not activate yet" warnings on a draft, not errors on something already broken.

`useStepIssues(steps)` memoizes `validateStepsForActivation(steps)` and buckets the results by the `path` prefix each issue carries (`steps[0]`, `steps[0].yes.steps[1]`, …) so each card can show only its own.

- [ ] **Step 3: Mount it in three places**

1. **Inside each expanded step card**, below the config fields — the issues for that step only.
2. **On the collapsed card header**, a small amber dot when that step has issues, so a problem deep in a long automation is visible without expanding everything.
3. **Beside the Save/Active toggle**, a count — *"3 issues"* — that scrolls to the first offending card when clicked. Disable the Active toggle while issues exist and tooltip it with the reason. Today activation fails server-side with a `VALIDATION_FAILED` error after the round trip; this moves it forward to the moment the field goes wrong.

- [ ] **Step 4: Add the strings**

```json
"issues": {
  "one": "1 issue",
  "other": "{count} issues",
  "cannotActivate": "Fix these before turning the automation on."
}
```

Reuse the messages `validate.ts` already produces — do not restate them in the UI layer, or the two will drift.

- [ ] **Step 5: Verify in the browser**

1. Add a Send Message step and leave it empty — confirm the amber strip, the header dot, the count, and that Active is disabled.
2. Type text — confirm all four clear.
3. Add a buttons payload with a 30-character button title — confirm Meta's own limit message appears (from `INTERACTIVE_LIMITS`, not a restatement).
4. Add a Send Message with both media and buttons — confirm the exclusivity message from Phase 1 Task 8 appears here too.
5. Attempt to activate with an issue outstanding — confirm the toggle is disabled rather than round-tripping to a server error.
6. `read_console_messages` — expect no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/automations/step-issues.tsx src/components/automations/automation-builder.tsx messages/en.json
git commit -m "feat(automations): surface validation issues while editing

Runs the same validateStepsForActivation the server gates activation on,
so the builder and the gate cannot disagree.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Full-suite verification

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint changed files**

Run: `npx eslint src/components/automations`
Expected: clean.

- [ ] **Step 4: Confirm no server code reached the browser bundle**

This repo has hit this before: importing from a `convex/` **query module** in a `"use client"` component ships server code to the browser. Task 4 imports from `convex/lib/automations/validate.ts`, which is pure — verify that held.

```bash
npm run build
grep -rl "accountMutation\|internalMutation\|ctx.db.query" .next/static/chunks/ | head
```

Expected: no matches. As a positive control, confirm the grep *can* match by running it against `.next/server/` — it should find hits there. A grep that matches nothing in both places is proving nothing.

- [ ] **Step 5: Full walkthrough**

Build a fresh automation end to end using only the new UI: pick actions from the grouped picker, compose a send with media and a fallback template, add a `session_window` condition, and confirm the previews and issue strip behave throughout. Screenshot the finished canvas.

- [ ] **Step 6: Commit any fixes**

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3 grouped, searchable add menu with descriptions | 1, 2 |
| §3 live WhatsApp-style preview on send steps | 3 |
| §3 inline validation against Meta's limits | 4 |
| Finding 1 (flat menu = poor discovery) | 1, 2 |

**Deliberate choices worth a reviewer's attention:**
- No new dependency for the picker unless `cmdk` is already present — a filtered list in the existing dropdown primitives is sufficient.
- The preview delegates the interactive case to `interactive-builder.tsx`'s existing preview rather than redrawing it, so the two can never diverge.
- Validation imports the server's own validator rather than reimplementing Meta's limits in `src/`.
