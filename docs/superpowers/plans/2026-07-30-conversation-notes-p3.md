# Conversation Notes — Phase 3 (The Machine) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A note an agent writes changes what the machine does — "do not contact" stops every automated message to that customer, and the AI reasons from the team's off-platform history without ever being able to quote it back.

**Architecture:** `contacts.doNotContact` (landed in Phase 1) becomes a hard gate on all five outbound-to-customer paths. Separately, notes are distilled by a pure function into a fixed-vocabulary `CustomerState` — enums, booleans and timestamps only, never agent prose — which is rendered into the customer-facing system prompt. Raw note text goes only to `buildScoreSystemPrompt`, an internal job whose output only agents read. The leak-proofness is enforced by the *type*: `CustomerState` has no string field an agent can write into.

**Tech Stack:** Convex (`internalQuery`/`internalAction`/`internalMutation`), TypeScript, Vitest + `convex-test`, Next.js + React 19, `next-intl`.

**Spec:** [`docs/superpowers/specs/2026-07-29-conversation-notes-design.md`](../specs/2026-07-29-conversation-notes-design.md) — the "Automation gates" and "AI integration" sections.

**Depends on:** Phase 1 (merged). Does NOT depend on Phase 2 — Task 10 ships a minimal do-not-contact banner precisely so this phase can land first without automation stopping invisibly.

## Global Constraints

- **Every user-facing Convex function is built with `accountQuery`/`accountMutation`** from `convex/lib/auth.ts` — never the raw `query`/`mutation`. Engine code uses `internalQuery`/`internalMutation`/`internalAction` and resolves `accountId` upstream from a source a client cannot spoof.
- **Cross-account and missing rows both throw `ConvexError({ code: "NOT_FOUND", entity })`** — never `FORBIDDEN`, never distinguishable.
- **NEVER run `convex dev`, `convex deploy`, or `convex codegen`.** `convex/_generated/` is committed and current; a NEW module under `convex/` needs its entry added to `convex/_generated/api.d.ts` by hand — new *exports* in an existing module do not.
- **The tree has concurrent writers.** Run `git status` and stage explicit paths before every commit — never `git add -A` or `git add .`.
- **Raw note text must never reach `buildSystemPrompt`.** That function builds the prompt for messages SENT TO CUSTOMERS. This is the phase's central invariant; Task 2 ships the regression test that enforces it.
- **A gate must fail closed.** If the contact cannot be loaded, do not send. Silence is recoverable; an unwanted WhatsApp message to someone who asked you to stop is not.
- **A blocked send is silent to the customer and visible to the team** — every gate records why it skipped somewhere an agent or an admin can see.
- **All user-facing copy through `next-intl`** into `messages/en.json` (the only locale file).
- **Run the full suite with `npm test`.** A single file: `npx vitest run <path>`. Baseline at the start of this phase: **197 test files, 2935 tests, 0 failures.**

---

## The five outbound paths

Phase 1's spec named three gates. Reading the code for this plan found **five** — the spec undercounted. All five are in scope:

| # | Path | Entry point | What it sends |
| --- | --- | --- | --- |
| 1 | Auto-reply | `aiReply.dispatchInbound` | An AI reply to an inbound message |
| 2 | Qualification follow-ups | `qualificationEngine.sendFollowUp` (cron `sweepFollowUps`) | Nudges to a lead who went quiet |
| 3 | Lead sequence steps | `leadAnalysisEngine.sendSequenceStep` (cron `sweepLeadSequence`) | Scheduled sequence messages |
| 4 | Broadcasts | `broadcasts.create` | Bulk template sends |
| 5 | Chase auto-assignment | `inboxChaseAssign.sweepChaseAssign` | No message — but it exists to *drive* chasing, so a do-not-contact lead must not consume its budget |

## File Structure

| File | Responsibility |
| --- | --- |
| `convex/lib/notes/signals.ts` (create) | Pure: derive `CustomerState` from notes. No Convex, no React. |
| `convex/lib/ai/defaults.ts` (modify) | `buildSystemPrompt` renders a `customerState` block. |
| `convex/lib/notes/gate.ts` (create) | Pure predicate + the shared skip-reason vocabulary. |
| `convex/aiReply.ts` (modify) | Gate 1; passes `customerState` into the prompt. |
| `convex/qualificationEngine.ts` (modify) | Gate 2, in `followUpContext`'s verdict. |
| `convex/leadAnalysisEngine.ts` (modify) | Gate 3, in `sequenceContext`'s verdict; raw notes into `buildScoreSystemPrompt`. |
| `convex/broadcasts.ts` (modify) | Gate 4 — drop, don't reject; return a `skipped` count. |
| `convex/inboxChaseAssign.ts` (modify) | Gate 5. |
| `src/components/inbox/do-not-contact-banner.tsx` (create) | The visible banner + clear action. |

---

## Task 1: Derive customer state from notes (pure)

**Files:**
- Create: `convex/lib/notes/signals.ts`
- Test: `convex/lib/notes/signals.test.ts`

**Interfaces:**
- Consumes: the `contactNotes` row shape from Phase 1 (`kind`, `outcome`, `_creationTime`).
- Produces:
  - `type OfflineNoteKind = "call" | "whatsapp_external" | "meeting" | "email"`
  - `interface CustomerState { lastOfflineContact: { kind: OfflineNoteKind; atMs: number } | null; followUpFlaggedAtMs: number | null; markedNotInterested: boolean }`
  - `deriveCustomerState(notes: NoteSignalInput[]): CustomerState`
  - `interface NoteSignalInput { _creationTime: number; kind?: string | null; outcome?: string | null }`

**Why this shape.** Every field is an enum, a boolean, or a number. There is no string field an agent can write into, so no agent-authored text can reach the prompt this feeds — the guarantee is structural, not a review rule.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/notes/signals.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { deriveCustomerState, OFFLINE_NOTE_KINDS } from "./signals";

const note = (
  atMs: number,
  kind?: string | null,
  outcome?: string | null,
) => ({ _creationTime: atMs, kind, outcome });

describe("lastOfflineContact", () => {
  test("is the most recent note whose kind is an off-platform channel", () => {
    const state = deriveCustomerState([
      note(100, "call"),
      note(300, "meeting"),
      note(200, "email"),
    ]);
    expect(state.lastOfflineContact).toEqual({ kind: "meeting", atMs: 300 });
  });

  test("ignores general and system notes — they are not a channel", () => {
    const state = deriveCustomerState([
      note(100, "call"),
      note(500, "general"),
      note(600, null), // engine-written
    ]);
    expect(state.lastOfflineContact).toEqual({ kind: "call", atMs: 100 });
  });

  test("ignores payment notes — money is not a contact channel", () => {
    const state = deriveCustomerState([note(100, "call"), note(900, "payment")]);
    expect(state.lastOfflineContact).toEqual({ kind: "call", atMs: 100 });
  });

  test("is null when no note carries an off-platform kind", () => {
    expect(deriveCustomerState([note(1, "general")]).lastOfflineContact).toBeNull();
    expect(deriveCustomerState([]).lastOfflineContact).toBeNull();
  });

  test("OFFLINE_NOTE_KINDS is exactly the four channels", () => {
    expect([...OFFLINE_NOTE_KINDS].sort()).toEqual([
      "call",
      "email",
      "meeting",
      "whatsapp_external",
    ]);
  });
});

describe("followUpFlaggedAtMs", () => {
  test("is the creation time of the most recent follow_up note", () => {
    const state = deriveCustomerState([
      note(100, "call", "follow_up"),
      note(400, "call", "follow_up"),
      note(200, "call", "no_answer"),
    ]);
    expect(state.followUpFlaggedAtMs).toBe(400);
  });

  test("is null when no note flags a follow-up", () => {
    expect(deriveCustomerState([note(1, "call", "no_answer")]).followUpFlaggedAtMs).toBeNull();
  });
});

describe("markedNotInterested", () => {
  // Stateful on purpose: only the LATEST outcome-bearing note counts, so a
  // customer who says "not interested" and later re-engages is not
  // permanently written off.
  test("is true when the most recent outcome-bearing note is not_interested", () => {
    const state = deriveCustomerState([
      note(100, "call", "follow_up"),
      note(500, "call", "not_interested"),
    ]);
    expect(state.markedNotInterested).toBe(true);
  });

  test("is false when a LATER outcome supersedes it", () => {
    const state = deriveCustomerState([
      note(100, "call", "not_interested"),
      note(500, "call", "follow_up"),
    ]);
    expect(state.markedNotInterested).toBe(false);
  });

  test("notes without an outcome do not supersede", () => {
    const state = deriveCustomerState([
      note(100, "call", "not_interested"),
      note(900, "general"), // no outcome — must not clear the flag
    ]);
    expect(state.markedNotInterested).toBe(true);
  });

  test("is false with no notes at all", () => {
    expect(deriveCustomerState([]).markedNotInterested).toBe(false);
  });
});

describe("input robustness", () => {
  test("tolerates unrecognised kind and outcome values without throwing", () => {
    const state = deriveCustomerState([note(100, "telepathy", "vibes")]);
    expect(state.lastOfflineContact).toBeNull();
    expect(state.followUpFlaggedAtMs).toBeNull();
    expect(state.markedNotInterested).toBe(false);
  });

  test("does not depend on input ordering", () => {
    const notes = [
      note(300, "meeting"),
      note(100, "call", "not_interested"),
      note(500, "email", "follow_up"),
    ];
    const forward = deriveCustomerState(notes);
    const backward = deriveCustomerState([...notes].reverse());
    expect(forward).toEqual(backward);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/lib/notes/signals.test.ts`
Expected: FAIL — `Cannot find module './signals'`

- [ ] **Step 3: Write the implementation**

Create `convex/lib/notes/signals.ts`:

```ts
// ============================================================
// Distils a contact's notes into a FIXED-VOCABULARY summary safe to put
// in front of the customer-facing reply model.
//
// The safety property is the TYPE, not a review rule: `CustomerState`
// has no string field an agent can write into, so no agent-authored
// prose can reach a prompt built from it. `convex/aiReply.ts`'s own
// comment (the `audience: "internal"` filter) explains why that matters
// — the model cannot self-censor, so the only reliable filter is one
// that runs before the model sees anything.
//
// Raw note text goes only to `buildScoreSystemPrompt`, whose output an
// agent reads and a customer never does.
// ============================================================

/** The channels that mean "someone actually spoke to this customer off
 *  this platform". `payment` and `general` are deliberately excluded:
 *  they record a fact, not a contact event. */
export const OFFLINE_NOTE_KINDS = [
  "call",
  "whatsapp_external",
  "meeting",
  "email",
] as const;

export type OfflineNoteKind = (typeof OFFLINE_NOTE_KINDS)[number];

/** The minimum a note row needs to be distilled. Deliberately typed with
 *  loose `string` fields rather than the schema's unions: this runs over
 *  rows written by five different engines across two years of history,
 *  and an unrecognised value must be ignored, never throw. */
export interface NoteSignalInput {
  _creationTime: number;
  kind?: string | null;
  outcome?: string | null;
}

export interface CustomerState {
  /** The most recent off-platform contact, or null. */
  lastOfflineContact: { kind: OfflineNoteKind; atMs: number } | null;
  /** When an agent last flagged "follow up later". The note carries no
   *  target date — only that the flag was raised, and when. */
  followUpFlaggedAtMs: number | null;
  /** Whether the LATEST outcome-bearing note says not-interested. Stateful
   *  on purpose: a customer who cools off and later re-engages must not be
   *  permanently written off by one old note. */
  markedNotInterested: boolean;
}

function isOfflineKind(kind: string | null | undefined): kind is OfflineNoteKind {
  return (OFFLINE_NOTE_KINDS as readonly string[]).includes(kind ?? "");
}

/**
 * Pure, order-independent. Callers pass whatever they have; this sorts
 * defensively rather than trusting the query's order, so a change to a
 * caller's `.order()` cannot silently invert the meaning of "latest".
 */
export function deriveCustomerState(notes: NoteSignalInput[]): CustomerState {
  const byNewest = [...notes].sort((a, b) => b._creationTime - a._creationTime);

  const offline = byNewest.find((n) => isOfflineKind(n.kind));
  const followUp = byNewest.find((n) => n.outcome === "follow_up");
  const latestOutcome = byNewest.find((n) => !!n.outcome);

  return {
    lastOfflineContact: offline
      ? { kind: offline.kind as OfflineNoteKind, atMs: offline._creationTime }
      : null,
    followUpFlaggedAtMs: followUp ? followUp._creationTime : null,
    markedNotInterested: latestOutcome?.outcome === "not_interested",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/lib/notes/signals.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git status --short
git add convex/lib/notes/signals.ts convex/lib/notes/signals.test.ts
git commit -m "feat(notes): distil notes into a fixed-vocabulary customer state

Every field is an enum, boolean or timestamp — there is no string field
an agent can write into, so no agent prose can reach a prompt built from
this. The guarantee is the type, not a review rule.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Render customer state in the reply prompt, and prove notes can't leak

**Files:**
- Modify: `convex/lib/ai/defaults.ts` (`buildSystemPrompt`, from line 292)
- Test: `convex/lib/ai/defaults.test.ts`

**Interfaces:**
- Consumes: `CustomerState` from Task 1.
- Produces: `buildSystemPrompt` accepts an optional `customerState?: CustomerState`. Omitting it leaves the prompt byte-identical to before.

- [ ] **Step 1: Read the existing function before changing it**

Run: `sed -n '280,420p' convex/lib/ai/defaults.ts`

`buildSystemPrompt` already takes three optional structured params (`qualification`, `adContext`, `now`) and pushes strings onto a `parts` array. Follow that established shape exactly — a new optional param, rendered only when supplied, so every existing caller and test keeps its byte-identical prompt. Note how `now` is used for Dubai wall-clock formatting and reuse that helper for dates rather than writing a second formatter.

- [ ] **Step 2: Write the failing tests**

Append to `convex/lib/ai/defaults.test.ts`:

```ts
// ============================================================
// customerState — the notes → prompt bridge
// ============================================================

test("buildSystemPrompt is byte-identical when customerState is omitted", () => {
  const base = buildSystemPrompt({ userPrompt: "Be warm.", mode: "auto_reply" });
  const explicitUndefined = buildSystemPrompt({
    userPrompt: "Be warm.",
    mode: "auto_reply",
    customerState: undefined,
  });
  expect(explicitUndefined).toBe(base);
});

test("buildSystemPrompt renders the off-platform contact and the follow-up flag", () => {
  const prompt = buildSystemPrompt({
    userPrompt: null,
    mode: "auto_reply",
    now: new Date("2026-08-05T10:00:00Z"),
    customerState: {
      lastOfflineContact: { kind: "call", atMs: Date.parse("2026-08-03T09:00:00Z") },
      followUpFlaggedAtMs: Date.parse("2026-08-03T09:00:00Z"),
      markedNotInterested: false,
    },
  });
  expect(prompt).toContain("CUSTOMER STATE");
  expect(prompt.toLowerCase()).toContain("phone call");
  // The model must be told not to surface any of it.
  expect(prompt.toLowerCase()).toMatch(/never mention|do not mention/);
});

test("buildSystemPrompt omits the customer-state block when every signal is empty", () => {
  const prompt = buildSystemPrompt({
    userPrompt: null,
    mode: "auto_reply",
    customerState: {
      lastOfflineContact: null,
      followUpFlaggedAtMs: null,
      markedNotInterested: false,
    },
  });
  // An all-empty state is no information — rendering an empty header
  // would spend tokens on every reply for nothing.
  expect(prompt).not.toContain("CUSTOMER STATE");
});

// ============================================================
// LEAK REGRESSION — this is the test that protects the phase's central
// invariant. If someone later widens CustomerState with a free-text
// field, or pipes noteText into this builder, this must fail.
// ============================================================

test("no agent-authored note text can reach the customer-facing prompt", () => {
  const SECRET = "he is a time-waster, quote him double";
  const state = {
    lastOfflineContact: { kind: "call" as const, atMs: Date.now() },
    followUpFlaggedAtMs: Date.now(),
    markedNotInterested: true,
  };

  const prompt = buildSystemPrompt({
    userPrompt: null,
    mode: "auto_reply",
    customerState: state,
  });

  expect(prompt).not.toContain(SECRET);

  // Structural guard: every value the customer-state block can render
  // comes from a closed vocabulary. If a future edit adds a string field
  // to CustomerState, this assertion is what catches it — it enumerates
  // the ONLY value types allowed through.
  for (const value of Object.values(state)) {
    if (value === null) continue;
    if (typeof value === "boolean" || typeof value === "number") continue;
    // The only object shape allowed is { kind, atMs }.
    expect(Object.keys(value as object).sort()).toEqual(["atMs", "kind"]);
    expect(typeof (value as { kind: string }).kind).toBe("string");
    expect(
      ["call", "whatsapp_external", "meeting", "email"],
    ).toContain((value as { kind: string }).kind);
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run convex/lib/ai/defaults.test.ts`
Expected: FAIL — `buildSystemPrompt` does not accept `customerState`.

- [ ] **Step 4: Implement the parameter**

In `convex/lib/ai/defaults.ts`, add to `buildSystemPrompt`'s args object (after `adContext`, before `now`), and import the type:

```ts
import type { CustomerState } from "../notes/signals";
```

```ts
  /** What the team knows from OUTSIDE this platform — a phone call, a
   *  meeting, an agent's follow-up flag — distilled by
   *  `deriveCustomerState` into a closed vocabulary.
   *
   *  Deliberately NOT the raw note text. The notes themselves say things
   *  like "he haggled, we can go to 4000" and "time-waster", and this
   *  prompt writes messages the customer receives. See this file's
   *  `customerState` rendering block and `aiReply.ts`'s `audience:
   *  "internal"` filter for the same reasoning: the model cannot
   *  self-censor, so nothing unsafe may reach it in the first place.
   *
   *  Absent, or present with every signal empty → prompt is
   *  byte-identical to before this feature. */
  customerState?: CustomerState;
```

Destructure it alongside the others, then render after the `adContext` block and before the closing return:

```ts
  if (customerState) {
    const lines: string[] = [];
    if (customerState.lastOfflineContact) {
      lines.push(
        `- Last contacted off this platform: ${OFFLINE_KIND_LABELS[customerState.lastOfflineContact.kind]}` +
          `, ${formatDubai(new Date(customerState.lastOfflineContact.atMs))}`,
      );
    }
    if (customerState.followUpFlaggedAtMs !== null) {
      lines.push(
        `- A team member flagged this lead for follow-up on ${formatDubai(new Date(customerState.followUpFlaggedAtMs))}`,
      );
    }
    if (customerState.markedNotInterested) {
      lines.push(
        "- A team member recorded that this customer said they are not interested",
      );
    }
    // An all-empty state carries no information; rendering an empty
    // header would spend tokens on every reply for nothing.
    if (lines.length > 0) {
      parts.push(
        "CUSTOMER STATE — what the team knows from outside WhatsApp. " +
          "Use it to stay consistent with what colleagues have already done. " +
          "NEVER mention, quote, or hint at any of it, and never tell the customer that notes about them exist:\n" +
          lines.join("\n"),
      );
    }
  }
```

Add the label map near the top of the file, beside the other constants:

```ts
/** Customer-facing-safe labels for the off-platform channels. A closed
 *  map, not a string passthrough — see `CustomerState`'s own comment. */
const OFFLINE_KIND_LABELS: Record<string, string> = {
  call: "a phone call",
  whatsapp_external: "WhatsApp (outside this inbox)",
  meeting: "an in-person meeting",
  email: "email",
};
```

Use the file's existing Dubai date formatter for `formatDubai` — read lines 260-276 and call the real function name rather than inventing one. If it is not exported or not reusable at this point in the file, hoist it rather than writing a second formatter.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run convex/lib/ai/defaults.test.ts`
Expected: PASS — including every pre-existing prompt-snapshot test, since omitting the param leaves the prompt unchanged.

- [ ] **Step 6: Commit**

```bash
git status --short
git add convex/lib/ai/defaults.ts convex/lib/ai/defaults.test.ts
git commit -m "feat(ai): render a closed-vocabulary customer state in the reply prompt

The bot learns that a colleague called two days ago without ever seeing
what the colleague wrote. Ships the leak regression test that enforces
it: if someone later widens CustomerState with a free-text field, that
test fails.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The shared gate predicate

**Files:**
- Create: `convex/lib/notes/gate.ts`
- Test: `convex/lib/notes/gate.test.ts`

**Interfaces:**
- Produces:
  - `type OutboundBlockReason = "do_not_contact"`
  - `blockedReason(contact: { doNotContact?: unknown } | null | undefined): OutboundBlockReason | null`

**Why a shared helper for one condition.** Five call sites must agree on what "blocked" means, and the fail-closed rule (a missing contact blocks) is exactly the kind of thing four of five sites get right and one forgets. One predicate, one test, five identical callers.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/notes/gate.test.ts`:

```ts
import { expect, test } from "vitest";
import { blockedReason } from "./gate";

test("a contact with no doNotContact is not blocked", () => {
  expect(blockedReason({})).toBeNull();
  expect(blockedReason({ doNotContact: undefined })).toBeNull();
});

test("a contact carrying doNotContact is blocked", () => {
  expect(blockedReason({ doNotContact: { at: 1, noteId: "x" } })).toBe(
    "do_not_contact",
  );
});

// Fail closed. Every caller resolves the contact from an id that may
// race a delete; sending because the row vanished is the one failure
// mode this feature cannot have.
test("a missing contact is blocked, not allowed", () => {
  expect(blockedReason(null)).toBe("do_not_contact");
  expect(blockedReason(undefined)).toBe("do_not_contact");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/lib/notes/gate.test.ts`
Expected: FAIL — `Cannot find module './gate'`

- [ ] **Step 3: Write the implementation**

Create `convex/lib/notes/gate.ts`:

```ts
// ============================================================
// The one predicate every outbound-to-customer path consults. Five call
// sites share it so they cannot drift: auto-reply, qualification
// follow-ups, lead-sequence steps, broadcasts, and chase
// auto-assignment.
// ============================================================

export type OutboundBlockReason = "do_not_contact";

/**
 * Whether an automated message may be sent to this contact.
 *
 * FAILS CLOSED: a null/undefined contact is treated as blocked. Every
 * caller resolves the contact from an id that can race a delete, and
 * "the row wasn't there so we sent anyway" is the one failure mode this
 * feature cannot have. Silence is recoverable; a message to someone who
 * asked you to stop is not.
 *
 * Humans are NOT gated by this — an agent who opens the thread and types
 * has seen the banner and made a decision. Machines are stopped; people
 * are informed.
 */
export function blockedReason(
  contact: { doNotContact?: unknown } | null | undefined,
): OutboundBlockReason | null {
  if (!contact) return "do_not_contact";
  return contact.doNotContact ? "do_not_contact" : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/lib/notes/gate.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git status --short
git add convex/lib/notes/gate.ts convex/lib/notes/gate.test.ts
git commit -m "feat(notes): one fail-closed gate predicate for five send paths

A missing contact counts as blocked. Every caller resolves the contact
from an id that can race a delete, and 'the row wasn't there so we sent
anyway' is the one failure mode this feature cannot have.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Gate 1 — auto-reply, and wire the customer state in

**Files:**
- Modify: `convex/aiReply.ts` — `AckOutcome` (line ~188), `loadDispatchContext` (line ~239), `dispatchInbound`'s gate block (line ~676), the two `buildSystemPrompt` call sites (~1120 and ~1739)
- Test: `convex/aiReply.test.ts`

**Interfaces:**
- Consumes: `blockedReason` (Task 3), `deriveCustomerState` (Task 1), `buildSystemPrompt`'s `customerState` param (Task 2).
- Produces: `AckOutcome` gains `"skipped_do_not_contact"`; `loadDispatchContext` additionally returns `{ blocked: boolean; customerState: CustomerState }`.

- [ ] **Step 1: Read the three sites before editing**

Run: `sed -n '185,196p;236,255p;672,706p' convex/aiReply.ts`

`loadDispatchContext` already loads the contact and returns `{ conversation, to }` — it is the natural place to compute both the gate input and the customer state, because it is the one query that already has the contact in hand.

Note there are TWO `buildSystemPrompt` call sites in this file (~1120 and ~1739). Read both and determine which builds a CUSTOMER-FACING reply. Both may need `customerState`; neither may receive raw note text. Report what you find.

- [ ] **Step 2: Write the failing tests**

Append to `convex/aiReply.test.ts`, following that file's existing seeding helpers:

```ts
test("dispatchInbound skips a do-not-contact customer and says so", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId, contactId } = await seedAutoReplyReady(t);

  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: "Asked us never to contact him again",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(contactId, {
      doNotContact: { at: Date.now(), noteId },
    });
  });

  const outcome = await t.action(internal.aiReply.dispatchInbound, {
    accountId,
    conversationId,
    contactId,
    triggerWamid: "wamid.test",
  });

  expect(outcome).toBe("skipped_do_not_contact");

  // Nothing was sent.
  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages.filter((m) => m.direction === "outbound")).toHaveLength(0);
});

test("dispatchInbound still replies to a contact with notes but no do-not-contact flag", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId, contactId } = await seedAutoReplyReady(t);

  await t.run((ctx) =>
    ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: "Called, wants March",
      kind: "call",
      outcome: "follow_up",
    }),
  );

  const outcome = await t.action(internal.aiReply.dispatchInbound, {
    accountId,
    conversationId,
    contactId,
    triggerWamid: "wamid.test",
  });
  expect(outcome).not.toBe("skipped_do_not_contact");
});

test("loadDispatchContext derives customer state without exposing note text", async () => {
  const t = convexTest(schema, modules);
  const { accountId, conversationId, contactId } = await seedAutoReplyReady(t);
  const SECRET = "time-waster, quote him double";

  await t.run((ctx) =>
    ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: SECRET,
      kind: "call",
      outcome: "follow_up",
    }),
  );

  const context = await t.query(internal.aiReply.loadDispatchContext, {
    accountId,
    conversationId,
    contactId,
  });

  expect(context).not.toBeNull();
  expect(context!.customerState.lastOfflineContact?.kind).toBe("call");
  expect(context!.customerState.followUpFlaggedAtMs).toBeGreaterThan(0);
  // The whole point: the note's TEXT is nowhere in what dispatch receives.
  expect(JSON.stringify(context)).not.toContain(SECRET);
});
```

If `seedAutoReplyReady` does not exist in `aiReply.test.ts`, find the helper that file already uses to reach a dispatchable state and use that instead — report the real name.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run convex/aiReply.test.ts`
Expected: FAIL — the outcome is not `skipped_do_not_contact`, and `customerState` is not on the context.

- [ ] **Step 4: Extend the outcome union**

In `convex/aiReply.ts`, add to `AckOutcome`:

```ts
  | "skipped_do_not_contact" // an agent recorded that this customer asked us to stop
```

- [ ] **Step 5: Extend `loadDispatchContext`**

Add the imports:

```ts
import { blockedReason } from "./lib/notes/gate";
import { deriveCustomerState } from "./lib/notes/signals";
```

Change the handler's return to include both derived values:

```ts
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return null;
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.accountId !== args.accountId) return null;

    // Both derived here because this is the one query that already holds
    // the contact — the gate needs an O(1) field, and the prompt needs
    // the notes distilled. Note text itself never leaves this handler.
    const notes = await ctx.db
      .query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .collect();

    return {
      conversation,
      to: contact.phone,
      blocked: blockedReason(contact) !== null,
      customerState: deriveCustomerState(notes),
    };
  },
```

- [ ] **Step 6: Add the gate to `dispatchInbound`**

Immediately after the existing `if (!dispatchContext) return "skipped_no_context";`, and BEFORE the assigned/paused checks:

```ts
      // An agent recorded that this customer asked not to be contacted.
      // Checked before the assigned/paused gates so the outcome log says
      // the real reason rather than whichever gate happens to be first.
      if (dispatchContext.blocked) {
        return "skipped_do_not_contact";
      }
```

- [ ] **Step 7: Pass the customer state to the prompt**

At each `buildSystemPrompt` call site you identified in Step 1 that builds a customer-facing reply, add:

```ts
        customerState: dispatchContext.customerState,
```

If a call site does not have `dispatchContext` in scope, thread the value through rather than re-querying the notes — and say so in your report. Do NOT pass note text anywhere.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run convex/aiReply.test.ts` then `npm test`
Expected: PASS. Existing `aiReply` tests must be unaffected — a contact with no notes and no flag produces an empty `CustomerState`, which renders nothing.

- [ ] **Step 9: Commit**

```bash
git status --short
git add convex/aiReply.ts convex/aiReply.test.ts
git commit -m "feat(ai): stop auto-replying to a do-not-contact customer

Adds skipped_do_not_contact to the outcome union so a blocked reply
shows up in the usage log rather than vanishing, and threads the
distilled customer state into the reply prompt. Note text stops at
loadDispatchContext and goes no further.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Gate 2 — qualification follow-ups

**Files:**
- Modify: `convex/qualificationEngine.ts` — `followUpContext` (the `internalQuery` behind `sendFollowUp` at line ~1811)
- Test: `convex/qualificationEngine.test.ts`

**Interfaces:**
- Consumes: `blockedReason` (Task 3).
- Produces: nothing new — `followUpContext` returns its existing `{ kind: "skip" }` verdict for a blocked contact.

- [ ] **Step 1: Read the verdict producer**

Run: `grep -n "export const followUpContext" -A 60 convex/qualificationEngine.ts`

`sendFollowUp` switches on a `FollowUpVerdict` (defined at line ~1601) whose `{ kind: "skip" }` already means "do nothing". The gate belongs in the query that produces the verdict, not in the action — that way the reason is decided in one place and the action stays a pure dispatcher. Confirm the query loads the contact; if it does not, load it there.

- [ ] **Step 2: Write the failing test**

```ts
test("a follow-up is not sent to a do-not-contact customer", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, sessionId } = await seedDueFollowUp(t);

  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: "Asked us to stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(contactId, { doNotContact: { at: Date.now(), noteId } });
  });

  const verdict = await t.query(internal.qualificationEngine.followUpContext, {
    sessionId,
  });
  expect(verdict.kind).toBe("skip");
});

test("a follow-up IS sent to a contact with notes but no do-not-contact flag", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, sessionId } = await seedDueFollowUp(t);
  await t.run((ctx) =>
    ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: "Called, will decide next week",
      kind: "call",
      outcome: "follow_up",
    }),
  );

  const verdict = await t.query(internal.qualificationEngine.followUpContext, {
    sessionId,
  });
  expect(verdict.kind).not.toBe("skip");
});
```

`seedDueFollowUp` is illustrative — find the helper `qualificationEngine.test.ts` already uses to build a session that is due for a follow-up, and use that. Report the real name. If no such helper exists, build the state inline the way the file's nearest existing follow-up test does.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run convex/qualificationEngine.test.ts`
Expected: FAIL — the blocked case returns a sending verdict.

- [ ] **Step 4: Add the gate**

In `followUpContext`, after the contact is resolved and BEFORE any other verdict branch is computed:

```ts
    // An agent recorded that this customer asked not to be contacted.
    // First branch on purpose: every other verdict below can schedule or
    // send, and none of them should run for a blocked contact.
    if (blockedReason(contact) !== null) {
      return { kind: "skip" as const };
    }
```

Add `import { blockedReason } from "./lib/notes/gate";`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run convex/qualificationEngine.test.ts` then `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git status --short
git add convex/qualificationEngine.ts convex/qualificationEngine.test.ts
git commit -m "feat(qualification): stop follow-up nudges to a do-not-contact customer

Gated in followUpContext rather than sendFollowUp, so the reason is
decided in one place and the action stays a pure dispatcher.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Gate 3 — lead sequence steps

**Files:**
- Modify: `convex/leadAnalysisEngine.ts` — `sequenceContext` (line ~390)
- Test: `convex/leadAnalysisEngine.test.ts`

**Interfaces:**
- Consumes: `blockedReason` (Task 3).
- Produces: `sequenceContext` returns a non-sending verdict for a blocked contact.

- [ ] **Step 1: Read the verdict producer**

Run: `sed -n '390,470p' convex/leadAnalysisEngine.ts`

`sendSequenceStep` (line ~759) switches on `sequenceContext`'s verdict, whose `send` branch is the only one that messages a customer. Identify the existing non-sending verdict kind that means "stop, don't reschedule" — read the union rather than assuming it is called `skip`, and use whichever kind leaves the row in a correct state. **Report which kind you chose and why**; picking one that reschedules would make the sweep retry the blocked row forever.

- [ ] **Step 2: Write the failing test**

```ts
test("a sequence step is not sent to a do-not-contact customer", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, analysisId } = await seedDueSequenceRow(t);

  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: "Asked us to stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(contactId, { doNotContact: { at: Date.now(), noteId } });
  });

  const verdict = await t.query(internal.leadAnalysisEngine.sequenceContext, {
    analysisId,
  });
  expect(verdict.kind).not.toBe("send");
});

test("a blocked sequence row is not left rescheduling forever", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, analysisId } = await seedDueSequenceRow(t);
  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: "Stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(contactId, { doNotContact: { at: Date.now(), noteId } });
  });

  await t.action(internal.leadAnalysisEngine.sendSequenceStep, { analysisId });

  // Whatever terminal state you chose, the row must not still be due —
  // otherwise every sweep re-reads it forever.
  const dueAfter = await t.query(internal.leadAnalysisEngine.getDueSequenceRows, {});
  expect(dueAfter.map((r) => r._id)).not.toContain(analysisId);
});
```

`seedDueSequenceRow` is illustrative — use the helper the file already has for a row due to send, and report its real name.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts`
Expected: FAIL — the blocked case returns a `send` verdict.

- [ ] **Step 4: Add the gate**

In `sequenceContext`, after the contact is resolved and before the sending branch:

```ts
    // An agent recorded that this customer asked not to be contacted.
    // Terminal, not a reschedule — a blocked row must leave the due set,
    // or every sweep re-reads it forever.
    if (blockedReason(contact) !== null) {
      return { kind: <the terminal kind you identified in Step 1> };
    }
```

Add `import { blockedReason } from "./lib/notes/gate";`. If `sequenceContext` does not currently load the contact, load it — the analysis row carries `contactId`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts` then `npm test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git status --short
git add convex/leadAnalysisEngine.ts convex/leadAnalysisEngine.test.ts
git commit -m "feat(leads): stop sequence steps to a do-not-contact customer

Terminal verdict rather than a reschedule, so a blocked row leaves the
due set instead of being re-read by every sweep.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Gate 4 — broadcasts drop, they do not reject

**Files:**
- Modify: `convex/broadcasts.ts` — `create` (line 292)
- Modify: the broadcast composer UI (find it: `grep -rln "broadcasts.create" src/`)
- Modify: `messages/en.json`
- Test: `convex/broadcasts.test.ts`

**Interfaces:**
- Consumes: `blockedReason` (Task 3).
- Produces: `broadcasts.create` returns `{ broadcastId: Id<"broadcasts">, skipped: number }` instead of a bare `Id<"broadcasts">`. **This is a breaking return-shape change — every caller must be updated.**

- [ ] **Step 1: Find every caller**

Run: `grep -rn "broadcasts.create\|api.broadcasts.create" src convex --include='*.ts' --include='*.tsx'`

List them in your report. Each must handle the new object shape.

- [ ] **Step 2: Write the failing tests**

```ts
test("create drops do-not-contact contacts and reports how many", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const keep = await asUser.mutation(api.contacts.create, { phone: "1" });
  const drop = await asUser.mutation(api.contacts.create, { phone: "2" });

  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId: drop,
      noteText: "Asked us to stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(drop, { doNotContact: { at: Date.now(), noteId } });
  });

  const result = await asUser.mutation(api.broadcasts.create, {
    name: "August offer",
    templateName: "promo",
    templateLanguage: "en",
    contactIds: [keep, drop],
  });

  expect(result.skipped).toBe(1);

  const recipients = await t.run((ctx) =>
    ctx.db
      .query("broadcastRecipients")
      .withIndex("by_broadcast", (q) => q.eq("broadcastId", result.broadcastId))
      .collect(),
  );
  expect(recipients.map((r) => r.contactId)).toEqual([keep]);

  const broadcast = await t.run((ctx) => ctx.db.get(result.broadcastId));
  // The count must reflect who will ACTUALLY be messaged, or every
  // progress percentage downstream is wrong.
  expect(broadcast!.totalRecipients).toBe(1);
});

test("create still rejects a foreign contactId outright", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const bob = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const mine = await alice.asUser.mutation(api.contacts.create, { phone: "1" });
  const theirs = await bob.asUser.mutation(api.contacts.create, { phone: "2" });

  // Dropping is for a customer who opted out. A cross-tenant id is an
  // error, and must stay one.
  await expect(
    alice.asUser.mutation(api.broadcasts.create, {
      name: "x",
      templateName: "promo",
      templateLanguage: "en",
      contactIds: [mine, theirs],
    }),
  ).rejects.toThrow(/NOT_FOUND/);
});

test("a broadcast to only do-not-contact contacts creates nothing sendable", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const drop = await asUser.mutation(api.contacts.create, { phone: "1" });
  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId: drop,
      noteText: "Stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(drop, { doNotContact: { at: Date.now(), noteId } });
  });

  const result = await asUser.mutation(api.broadcasts.create, {
    name: "x",
    templateName: "promo",
    templateLanguage: "en",
    contactIds: [drop],
  });
  expect(result.skipped).toBe(1);
  const broadcast = await t.run((ctx) => ctx.db.get(result.broadcastId));
  expect(broadcast!.totalRecipients).toBe(0);
});
```

Check the real recipients table name and index (`grep -n "broadcastRecipients" convex/schema.ts`) and correct the test if they differ.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run convex/broadcasts.test.ts`
Expected: FAIL — `create` returns a bare id and drops nothing.

- [ ] **Step 4: Implement the drop**

In `broadcasts.create`, the existing loop validates every `contactId` via `requireOwnContact`. Keep that — a foreign id stays an error. Partition inside the same loop:

```ts
    // Ownership is still fatal: a foreign id is a bug or an attack.
    // Opting out is NOT — dropping the opted-out recipients and telling
    // the sender is right, where rejecting a 200-person broadcast
    // because one person unsubscribed is not.
    const sendable: Id<"contacts">[] = [];
    let skipped = 0;
    for (const contactId of contactIds) {
      const contact = await requireOwnContact(ctx, contactId);
      if (blockedReason(contact) !== null) {
        skipped++;
        continue;
      }
      sendable.push(contactId);
    }
```

Then use `sendable` everywhere `contactIds` was used — including `totalRecipients: sendable.length` — and return `{ broadcastId, skipped }`.

Add `import { blockedReason } from "./lib/notes/gate";`.

- [ ] **Step 5: Update every caller from Step 1**

Each call site now receives an object. Where a caller used the returned id directly, use `result.broadcastId`.

- [ ] **Step 6: Surface the skip count in the composer**

Add to `messages/en.json` under the broadcasts namespace (find the real namespace first — `grep -n '"Broadcasts"' messages/en.json`):

```json
      "skippedDoNotContact": "{count, plural, one {# contact skipped — marked do not contact} other {# contacts skipped — marked do not contact}}",
```

After a successful create, when `skipped > 0`, show it with the existing toast mechanism in that component. A sender who thinks they messaged 200 people and actually messaged 197 must be told.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run convex/broadcasts.test.ts`, then `npx tsc --noEmit`, then `npm test`
Expected: PASS. `tsc` is the check that catches a caller you missed in Step 5.

- [ ] **Step 8: Commit**

```bash
git status --short
git add convex/broadcasts.ts convex/broadcasts.test.ts messages/en.json <the caller files>
git commit -m "feat(broadcasts): drop do-not-contact recipients and report the count

Rejecting a 200-person broadcast because one recipient opted out is the
wrong failure mode. Drops them, keeps totalRecipients honest so progress
percentages stay right, and tells the sender how many were skipped.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Gate 5 — chase auto-assignment

**Files:**
- Modify: `convex/inboxChaseAssign.ts` — `sweepChaseAssign` (line 49)
- Test: `convex/inboxChaseAssign.test.ts`

**Interfaces:**
- Consumes: `blockedReason` (Task 3).
- Produces: `sweepChaseAssign`'s existing `{ assigned, unroutable }` return is unchanged — a blocked conversation is simply not assigned.

**Why gate assignment at all, when it sends nothing.** This sweep exists to put a human on a lead so they will chase it. Assigning a do-not-contact lead spends the per-run budget on work nobody should do. The thread stays visible in the inbox either way.

- [ ] **Step 1: Write the failing test**

```ts
test("the sweep does not auto-assign a do-not-contact lead", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId, conversationId } = await seedChasingDue(t);

  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: "Asked us to stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(contactId, { doNotContact: { at: Date.now(), noteId } });
  });

  const result = await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});
  expect(result.assigned).toBe(0);

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.assignedToUserId).toBeUndefined();
});

test("the sweep still assigns a chasing lead with no do-not-contact flag", async () => {
  const t = convexTest(schema, modules);
  const { conversationId } = await seedChasingDue(t);
  const result = await t.mutation(internal.inboxChaseAssign.sweepChaseAssign, {});
  expect(result.assigned).toBe(1);
  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.assignedToUserId).toBeDefined();
});
```

`seedChasingDue` is illustrative — use the helper `inboxChaseAssign.test.ts` already has for a conversation the sweep will pick up, and report its real name.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/inboxChaseAssign.test.ts`
Expected: FAIL — the blocked lead is assigned.

- [ ] **Step 3: Add the gate**

Inside the per-conversation loop, before the routing/assignment work:

```ts
        // This sweep exists to put a human on a lead so they will chase
        // it. A customer who asked not to be contacted should not spend
        // the per-run budget — the thread stays visible in the inbox
        // either way. Skipped WITHOUT counting as unroutable: nothing is
        // misconfigured, we simply have nothing to do here.
        const contact = await ctx.db.get(conversation.contactId);
        if (blockedReason(contact) !== null) continue;
```

Add `import { blockedReason } from "./lib/notes/gate";`. Note this applies to BOTH ranges the sweep reads (the age-based one and the forced-chasing one) — put it where both pass through, or add it to both.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run convex/inboxChaseAssign.test.ts` then `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git status --short
git add convex/inboxChaseAssign.ts convex/inboxChaseAssign.test.ts
git commit -m "feat(inbox): don't auto-assign a do-not-contact lead for chasing

The sweep exists to put a human on a lead so they will chase it. A
customer who asked us to stop should not consume that budget; the thread
stays visible in the inbox regardless.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Raw note text into the internal scoring job

**Files:**
- Modify: `convex/leadAnalysisEngine.ts` — around `buildScoreSystemPrompt` (line ~1486) and its prompt builder
- Test: `convex/leadAnalysisEngine.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `buildScoreSystemPrompt` accepts an optional `agentNotes?: string[]`.

**Why this one gets the real text.** Lead scoring produces a number and a reason an AGENT reads. No output of this job is sent to a customer, so the constraint that governs `buildSystemPrompt` does not apply — and the notes are exactly the context that makes a score correct ("met him, he's ready to book" outranks any message history).

- [ ] **Step 1: Read the prompt builder**

Run: `grep -n "buildScoreSystemPrompt" -B 5 -A 40 convex/leadAnalysisEngine.ts | head -70`

Find where it is defined, what it already receives, and where the scoring action assembles its inputs. Report whether it lives in this file or is imported.

- [ ] **Step 2: Write the failing test**

```ts
test("the scoring prompt carries recent agent notes verbatim", () => {
  const prompt = buildScoreSystemPrompt({
    /* ...whatever the existing required args are — copy them from an
       existing test in this file... */
    agentNotes: [
      "2026-08-01 · Alice · phone call: met him at the office, ready to book",
      "2026-08-02 · Alice · follow up: waiting on his passport copy",
    ],
  });
  expect(prompt).toContain("ready to book");
  expect(prompt).toContain("waiting on his passport copy");
});

test("the scoring prompt is unchanged when there are no notes", () => {
  const withoutArg = buildScoreSystemPrompt({ /* required args */ });
  const withEmpty = buildScoreSystemPrompt({ /* required args */, agentNotes: [] });
  expect(withEmpty).toBe(withoutArg);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts`
Expected: FAIL — `agentNotes` is not accepted.

- [ ] **Step 4: Add the parameter and the budget**

```ts
  /** The team's own notes on this contact, newest first, already
   *  formatted and TRUNCATED by the caller.
   *
   *  Unlike `buildSystemPrompt`, this one gets the real text: this job's
   *  output is a score and a reason an AGENT reads, never a message a
   *  customer receives. "Met him, he's ready to book" is exactly the
   *  context that makes a score correct, and no message history carries
   *  it. */
  agentNotes?: string[];
```

Render it only when non-empty, under a clear header, e.g.:

```ts
  if (agentNotes && agentNotes.length > 0) {
    parts.push(
      "The team's own notes on this contact (most recent first). These record " +
        "what happened off WhatsApp — calls, meetings, payments — and are often " +
        "more decisive than the chat history:\n" +
        agentNotes.join("\n"),
    );
  }
```

- [ ] **Step 5: Supply the notes at the call site, with a hard budget**

Where the scoring action assembles its inputs, load the contact's notes and format them:

```ts
/** Newest-first, capped. A chatty thread must not be able to inflate
 *  token spend without bound — the account's usage card is a 30-day
 *  window, and an uncapped prompt input is how that number surprises
 *  someone. */
const SCORING_NOTES_MAX = 10;
const SCORING_NOTES_MAX_CHARS = 1500;

function formatNotesForScoring(
  notes: Array<{ _creationTime: number; noteText: string; kind?: string }>,
): string[] {
  const out: string[] = [];
  let budget = SCORING_NOTES_MAX_CHARS;
  for (const note of notes.slice(0, SCORING_NOTES_MAX)) {
    const line = `${new Date(note._creationTime).toISOString().slice(0, 10)} · ${note.kind ?? "note"}: ${note.noteText}`;
    // Oldest truncated first: the loop runs newest-first, so when the
    // budget runs out the notes left behind are the least recent.
    if (line.length > budget) break;
    budget -= line.length;
    out.push(line);
  }
  return out;
}
```

Load the notes with the `by_contact` index, `.order("desc")`, and pass `formatNotesForScoring(notes)` as `agentNotes`.

- [ ] **Step 6: Add a budget test**

```ts
test("scoring notes are capped so a chatty thread can't inflate token spend", () => {
  const long = Array.from({ length: 50 }, (_, i) => ({
    _creationTime: 1_000_000 + i,
    noteText: "x".repeat(200),
    kind: "call",
  }));
  const formatted = formatNotesForScoring(long);
  expect(formatted.length).toBeLessThanOrEqual(10);
  expect(formatted.join("\n").length).toBeLessThanOrEqual(1500);
});
```

Export `formatNotesForScoring` so the test can reach it.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run convex/leadAnalysisEngine.test.ts` then `npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git status --short
git add convex/leadAnalysisEngine.ts convex/leadAnalysisEngine.test.ts
git commit -m "feat(leads): score a lead using the team's own notes

This job's output is a score an agent reads, never a message a customer
receives, so it gets the real note text — "met him, he's ready to book"
is exactly the context no chat history carries. Capped at 10 notes /
1500 chars, oldest dropped first, so a chatty thread can't inflate spend.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Make the block visible

**Files:**
- Create: `src/components/inbox/do-not-contact-banner.tsx`
- Modify: `src/components/inbox/message-thread.tsx` (mount above the composer)
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.contactNotes.clearDoNotContact` (Phase 1), `api.contacts.get` or whatever the thread already uses to hold the contact doc.
- Produces: `<DoNotContactBanner contactId flag={{ at, byUserId }} canClear />`.

**Why this is in Phase 3 and not Phase 2.** Tasks 4-8 make automation stop silently. Without a visible reason, an agent sees a lead that gets no auto-replies, no follow-ups and no broadcasts, and has no way to find out why. Phase 2's status header will absorb this banner; until then it stands alone.

- [ ] **Step 1: Add the copy**

In `messages/en.json`, inside the existing `Inbox.notes` block:

```json
      "doNotContactTitle": "Do not contact",
      "doNotContactBody": "A team member recorded that this customer asked not to be contacted. Automatic replies, follow-ups and broadcasts are stopped. You can still message them manually.",
      "doNotContactSetBy": "Set by {name} on {date}",
      "doNotContactSetByUnknown": "Set on {date}",
      "doNotContactClear": "Clear",
      "doNotContactCleared": "Do-not-contact cleared",
      "doNotContactClearFailed": "Couldn't clear it — you may not have permission.",
```

- [ ] **Step 2: Write the component**

Create `src/components/inbox/do-not-contact-banner.tsx`:

```tsx
"use client";

import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { useMutation } from "convex/react";
import { format } from "date-fns";
import { Ban } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";

/**
 * The visible half of the do-not-contact gate. Every automated path
 * (auto-reply, qualification follow-ups, lead-sequence steps,
 * broadcasts, chase auto-assignment) silently stops for this contact —
 * without this banner an agent would have no way to learn why.
 *
 * A human is deliberately NOT blocked from messaging: the composer stays
 * usable. Machines are stopped; people are informed.
 */
export function DoNotContactBanner({
  contactId,
  at,
  byName,
  canClear,
}: {
  contactId: Id<"contacts">;
  at: number;
  byName: string | null;
  canClear: boolean;
}) {
  const t = useTranslations("Inbox.notes");
  const clear = useMutation(api.contactNotes.clearDoNotContact);
  const [clearing, setClearing] = useState(false);

  const handleClear = useCallback(async () => {
    setClearing(true);
    try {
      await clear({ contactId });
      toast.success(t("doNotContactCleared"));
    } catch {
      toast.error(t("doNotContactClearFailed"));
    } finally {
      setClearing(false);
    }
  }, [clear, contactId, t]);

  const date = format(new Date(at), "MMM d, yyyy");

  return (
    <div className="flex items-start gap-2 border-t border-destructive/30 bg-destructive/10 px-4 py-2">
      <Ban className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-destructive">
          {t("doNotContactTitle")}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {t("doNotContactBody")}
        </p>
        <p className="mt-0.5 text-[10px] text-muted-foreground">
          {byName
            ? t("doNotContactSetBy", { name: byName, date })
            : t("doNotContactSetByUnknown", { date })}
        </p>
      </div>
      {canClear && (
        <Button
          size="sm"
          variant="outline"
          disabled={clearing}
          onClick={() => void handleClear()}
        >
          {t("doNotContactClear")}
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Mount it**

In `message-thread.tsx`, render the banner directly above the message composer — not inside the scroll area, so it cannot scroll out of view — when the contact carries `doNotContact`.

Read how the component already holds the contact doc and the caller's role. `canClear` is `hasMinRole(accountRole, "supervisor")`, matching `clearDoNotContact`'s own server-side floor — a Clear button that always fails is worse than no button.

For `byName`, resolve `doNotContact.byUserId` against the members list the component already loads if one is available; pass `null` when it is not, and the banner renders the date-only variant. Do NOT add a query just for the name.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`, `npx eslint src/components/inbox/do-not-contact-banner.tsx src/components/inbox/message-thread.tsx`, `python3 -c "import json; json.load(open('messages/en.json'))"`, then `npm test`
Expected: all clean.

- [ ] **Step 5: Browser check — REQUIRED for this task**

This is the one task whose whole purpose is visual, and Phase 1 shipped a Critical (a floating button that scrolled away) precisely because it was never rendered. Verify in the main checkout, not a worktree — the preview tooling reads `.claude/launch.json` from the primary working directory and will otherwise serve the wrong branch.

Confirm: the banner appears above the composer on a flagged contact; it does not scroll away; the composer is still usable (a human is not blocked); Clear is visible to a supervisor and absent for an agent; clearing makes the banner disappear. Screenshot it.

If a browser genuinely cannot be run, say so explicitly in the report rather than marking this step done.

- [ ] **Step 6: Commit**

```bash
git status --short
git add src/components/inbox/do-not-contact-banner.tsx src/components/inbox/message-thread.tsx messages/en.json
git commit -m "feat(inbox): show why automation stopped for this customer

Tasks 4-8 stop auto-replies, follow-ups, broadcasts and auto-assignment
for a do-not-contact customer. Without this banner an agent sees a lead
that gets no automation and no explanation. The composer stays usable —
machines are stopped, people are informed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** The spec's "Automation gates" section named three paths; reading the code found five, and all five are gated (Tasks 4-8). "AI integration" splits exactly as specified: derived flags to the customer-facing generator (Tasks 1, 2, 4), full text to the internal job (Task 9). The leak regression test the spec called for is Task 2. Task 10 is not in the spec — it is a dependency the spec missed by assuming Phase 2 would land first.

**Deliberately out of scope, with reasons:**
- Notes are not fed to a thread-summarisation job — no such job exists yet. Adding one would be building the consumer to justify the input.
- `clearDoNotContact` still leaves the originating note reading `do_not_contact` (known from Phase 1's review). Not fixed here: it needs a product decision about whether clearing should amend the audit trail, and Task 10's banner makes the true state visible in the meantime.
- The deferred R2 cleanup and signed URLs from Phase 1 remain Phase 2's.

**Type consistency.** `CustomerState` and `OfflineNoteKind` are declared once (Task 1) and imported by Tasks 2 and 4. `blockedReason` is declared once (Task 3) and imported by Tasks 4-8 with identical call shape. `buildSystemPrompt`'s new param is `customerState` in both its definition (Task 2) and its call sites (Task 4). `buildScoreSystemPrompt`'s is `agentNotes` in both (Task 9).

**Known risk — the one breaking change.** Task 7 changes `broadcasts.create`'s return from `Id<"broadcasts">` to `{ broadcastId, skipped }`. Step 1 of that task enumerates callers before any edit and `tsc --noEmit` in Step 7 is the backstop. This is the only signature change in the phase.

**Verification honesty.** Tasks 1-9 are fully covered by unit and `convex-test` suites. Task 10 is visual and cannot be verified by tests; its Step 5 requires a real browser in the main checkout, and requires saying so plainly if that is impossible.
