# Conversation Notes — Phase 1 (The Trail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can log what happened outside WhatsApp — a phone call, a meeting, a payment — as a tagged, attributed, attachment-carrying note that appears inline in the conversation timeline and can never be sent to the customer.

**Architecture:** Extend the existing `contactNotes` table with optional fields rather than adding a table, because five backend engines already write there. Pure display logic (label derivation, timeline merging) lives in `src/lib/inbox/notes.ts` and is unit-tested without rendering; two new client components consume it; `message-thread.tsx` gains only a merge call and two mounts. Attachments reuse the existing R2 presigned-PUT path with one new media kind.

**Tech Stack:** Convex (schema + `accountQuery`/`accountMutation`), Next.js + React 19, TypeScript, Tailwind, `next-intl`, Vitest + `convex-test`, Cloudflare R2.

**Spec:** [`docs/superpowers/specs/2026-07-29-conversation-notes-design.md`](../specs/2026-07-29-conversation-notes-design.md)

## Global Constraints

- **Every Convex function is built with `accountQuery`/`accountMutation`** from `convex/lib/auth.ts` — never the raw `query`/`mutation` from `_generated/server`. This is the tenant-isolation spine.
- **Cross-account and missing rows both throw `ConvexError({ code: "NOT_FOUND", entity })`** — never `FORBIDDEN`, never a distinguishable error. A cross-account probe must not be able to tell "doesn't exist" from "isn't yours".
- **Role checks run BEFORE ownership checks**, so a `viewer` is rejected identically regardless of whose row it is.
- **Writing a note is `ctx.requireRole("agent")`.** Reading is plain membership. Clearing do-not-contact is `ctx.requireRole("supervisor")`.
- **Every new schema field is `v.optional(...)`.** No backfill, no migration; existing rows must keep validating.
- **Never run `convex dev`, `convex deploy`, or `convex codegen`.** `convex/_generated/` is already committed and current; schema edits are verified by `npm test` alone.
- **The tree has concurrent writers.** Run `git status` and stage explicit paths before every commit — never `git add -A` or `git add .`.
- **Role vocabulary** (highest to lowest): `owner`, `admin`, `supervisor`, `agent`, `viewer`. `hasMinRole` from `convex/lib/roles.ts` does the comparison.
- **All user-facing copy goes through `next-intl`** with keys added to `messages/en.json` (the only locale file). No hardcoded English in components.
- **Run the full suite with `npm test`.** A single file: `npx vitest run <path>`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `convex/schema.ts` (modify) | `contactNotes` gains 5 optional fields + `by_conversation`; `contacts` gains `doNotContact`. |
| `convex/lib/r2/keys.ts` (modify) | `"note"` joins `MEDIA_KINDS`. |
| `convex/contactNotes.ts` (modify) | Note CRUD: extended `add`, new `update`, tightened `remove`, new `listForConversation`, new `clearDoNotContact`, author-joined `listForContact`. |
| `src/lib/inbox/notes.ts` (create) | Pure, render-free logic: kind/outcome vocabularies, legacy-row classification, timeline merging, earlier-notes split, attachment limits. |
| `src/components/inbox/note-card.tsx` (create) | Renders one note. Used by the timeline now, by the sidebar in Phase 2. |
| `src/components/inbox/note-composer.tsx` (create) | The floating button, its popover, chip selection, and upload handling. |
| `src/components/inbox/message-thread.tsx` (modify) | Merge notes into the existing date groups; mount the composer. |
| `messages/en.json` (modify) | `Inbox.notes.*` copy. |

---

## Task 1: Schema fields and the `note` media kind

**Files:**
- Modify: `convex/schema.ts` (`contactNotes` ~line 771, `contacts` ~line 110)
- Modify: `convex/lib/r2/keys.ts:13`
- Test: `convex/contactNotes.test.ts`, `convex/lib/r2/keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `contactNotes` fields `conversationId`, `kind`, `outcome`, `attachments`, `editedAt`; the `by_conversation` index; `contacts.doNotContact`; `MediaKind` now includes `"note"`.

- [ ] **Step 1: Write the failing tests**

Append to `convex/contactNotes.test.ts`:

```ts
// ============================================================
// schema — the Phase 1 optional fields
// ============================================================

test("contactNotes accepts the extended fields and indexes them by conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const noteId = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "971500000001",
      phoneNormalized: "971500000001",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    });
    return await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      conversationId,
      createdByUserId: userId,
      noteText: "Called, wants March",
      kind: "call",
      outcome: "follow_up",
      attachments: [
        {
          key: `${accountId}/note/abc.pdf`,
          filename: "quote.pdf",
          contentType: "application/pdf",
          size: 1234,
        },
      ],
      editedAt: Date.now(),
    });
  });

  const row = await t.run((ctx) => ctx.db.get(noteId));
  expect(row!.kind).toBe("call");
  expect(row!.outcome).toBe("follow_up");
  expect(row!.attachments).toHaveLength(1);

  // The index the thread's inline query ranges on.
  const byConversation = await t.run((ctx) =>
    ctx.db
      .query("contactNotes")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", row!.conversationId!),
      )
      .collect(),
  );
  expect(byConversation).toHaveLength(1);
});

test("contacts accepts the doNotContact flag", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const contactId = await t.run(async (ctx) => {
    const cId = await ctx.db.insert("contacts", {
      accountId,
      phone: "971500000002",
      phoneNormalized: "971500000002",
    });
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId: cId,
      noteText: "Asked never to be contacted",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(cId, {
      doNotContact: { at: Date.now(), byUserId: userId, noteId },
    });
    return cId;
  });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeDefined();
  expect(contact!.doNotContact!.byUserId).toBe(userId);
});
```

Append to `convex/lib/r2/keys.test.ts`:

```ts
test("buildMediaKey mints a note key under the account's own prefix", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "note",
    filename: "passport.pdf",
    contentType: "application/pdf",
  });
  expect(key.startsWith("acc123/note/")).toBe(true);
  expect(key.endsWith(".pdf")).toBe(true);
  expect(parseMediaKey(key)).toEqual({ accountId: "acc123", kind: "note" });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/contactNotes.test.ts convex/lib/r2/keys.test.ts`
Expected: FAIL — schema validation rejects the unknown fields, `by_conversation` index does not exist, and `"note"` is not an accepted `MediaKind`.

- [ ] **Step 3: Extend the `contactNotes` table**

In `convex/schema.ts`, replace the `contactNotes` block:

```ts
  // A note an account member left on a contact — the account's audit
  // trail. Written by hand from the inbox AND automatically by five
  // engines (funnel transitions, AI tag acceptance, sales-checklist
  // steps, qualification, invitations), which is why the human-facing
  // fields below are ALL optional: an engine-written row carries only
  // `noteText`, and nothing about this table's history is rewritten.
  contactNotes: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    createdByUserId: v.optional(v.id("users")),
    noteText: v.string(),

    // Which thread the note was written in. Absent on engine-written
    // rows and on notes added from the contacts page, which is why the
    // inline thread query tolerates a null result.
    conversationId: v.optional(v.id("conversations")),

    // HOW the contact happened — the channel this system cannot see.
    // Absent on legacy and engine-written rows; `noteKindOf` in
    // `src/lib/inbox/notes.ts` derives a display kind for those.
    kind: v.optional(
      v.union(
        v.literal("call"),
        v.literal("whatsapp_external"),
        v.literal("meeting"),
        v.literal("email"),
        v.literal("payment"),
        v.literal("general"),
      ),
    ),

    // WHAT IT MEANS. `do_not_contact` is the only value with teeth: it
    // sets `contacts.doNotContact`, which gates automation in Phase 3.
    outcome: v.optional(
      v.union(
        v.literal("no_answer"),
        v.literal("follow_up"),
        v.literal("do_not_contact"),
        v.literal("not_interested"),
      ),
    ),

    // R2 objects under `{accountId}/note/…`. Bounded at
    // NOTE_ATTACHMENT_MAX_COUNT by the mutation, not the schema —
    // a schema can't express a max length.
    attachments: v.optional(
      v.array(
        v.object({
          key: v.string(),
          filename: v.string(),
          contentType: v.string(),
          size: v.number(),
        }),
      ),
    ),

    editedAt: v.optional(v.number()),
  })
    .index("by_contact", ["contactId"])
    .index("by_account", ["accountId"])
    // The inline thread renders ONE conversation's notes. On
    // `by_contact` that would over-read every note the contact has
    // across every thread; this binds the conversation directly.
    .index("by_conversation", ["conversationId"]),
```

- [ ] **Step 4: Add `doNotContact` to `contacts`**

In `convex/schema.ts`, immediately after the existing `notes: v.optional(v.string()),` field in the `contacts` table (~line 110):

```ts
    // Denormalised from the `contactNotes` row whose `outcome` is
    // `do_not_contact`. Denormalised on purpose: the Phase 3 gates run
    // on every inbound message and every chase sweep and need an O(1)
    // field read, not a per-contact note scan. `noteId` keeps the WHY
    // one `db.get` away.
    //
    // ONE path clears this: `contactNotes.clearDoNotContact`. Deleting
    // the note that set it does NOT, and neither does editing that
    // note's outcome — a customer's stated wish must outlive an agent
    // tidying up their notes.
    doNotContact: v.optional(
      v.object({
        at: v.number(),
        byUserId: v.optional(v.id("users")),
        noteId: v.id("contactNotes"),
      }),
    ),
```

- [ ] **Step 5: Add the `note` media kind**

In `convex/lib/r2/keys.ts`, extend the array at line 13:

```ts
export const MEDIA_KINDS = [
  "inbound",
  "outbound",
  "template",
  "flow",
  "avatar",
  "ad",
  // Note attachments. Unlike every kind above, a `note` object is never
  // sent to Meta — it is internal-only evidence (a passport scan, a
  // signed quote), so Meta's per-type size caps do not apply to it.
  "note",
] as const;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run convex/contactNotes.test.ts convex/lib/r2/keys.test.ts`
Expected: PASS

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all files pass. A schema change touches every `convex-test` suite, so a failure here means an existing row shape broke — fix it before committing.

- [ ] **Step 8: Commit**

```bash
git status --short
git add convex/schema.ts convex/lib/r2/keys.ts convex/contactNotes.test.ts convex/lib/r2/keys.test.ts
git commit -m "feat(notes): extend contactNotes with channel, outcome and attachments

Adds the optional fields a hand-written note needs (conversationId,
kind, outcome, attachments, editedAt) plus a by_conversation index for
the inline thread, and a doNotContact flag on contacts denormalised for
the Phase 3 automation gates. Every field is optional, so the five
engines already writing to this table are unaffected and nothing needs
backfilling.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Pure note vocabulary and classification

**Files:**
- Create: `src/lib/inbox/notes.ts`
- Test: `src/lib/inbox/notes.test.ts`

**Interfaces:**
- Consumes: the `contactNotes` field shapes from Task 1.
- Produces:
  - `NOTE_KINDS: readonly NoteKind[]` and `NOTE_OUTCOMES: readonly NoteOutcome[]`
  - `type NoteKind = "call" | "whatsapp_external" | "meeting" | "email" | "payment" | "general"`
  - `type NoteOutcome = "no_answer" | "follow_up" | "do_not_contact" | "not_interested"`
  - `type DisplayNoteKind = NoteKind | "system"`
  - `noteKindOf(note: { kind?: NoteKind; createdByUserId?: string | null }): DisplayNoteKind`
  - `noteKindI18nKey(kind: DisplayNoteKind): string`, `noteOutcomeI18nKey(o: NoteOutcome): string`
  - `NOTE_ATTACHMENT_MAX_COUNT = 5`, `NOTE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024`

- [ ] **Step 1: Write the failing test**

Create `src/lib/inbox/notes.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  NOTE_KINDS,
  NOTE_OUTCOMES,
  NOTE_ATTACHMENT_MAX_COUNT,
  NOTE_ATTACHMENT_MAX_BYTES,
  noteKindOf,
  noteKindI18nKey,
  noteOutcomeI18nKey,
} from "./notes";

describe("noteKindOf", () => {
  test("returns the explicit kind when the note carries one", () => {
    expect(noteKindOf({ kind: "call", createdByUserId: "u1" })).toBe("call");
  });

  // The two legacy shapes this table already contains. Neither is
  // rewritten — the display kind is derived at read time.
  test("classifies an engine-written row (no kind, no author) as system", () => {
    expect(noteKindOf({})).toBe("system");
    expect(noteKindOf({ createdByUserId: null })).toBe("system");
  });

  test("classifies a legacy human note (no kind, but an author) as general", () => {
    expect(noteKindOf({ createdByUserId: "u1" })).toBe("general");
  });

  test("an explicit kind wins even without an author", () => {
    expect(noteKindOf({ kind: "payment" })).toBe("payment");
  });
});

describe("i18n keys", () => {
  test("every kind including system has a key, and they are unique", () => {
    const keys = [...NOTE_KINDS, "system" as const].map(noteKindI18nKey);
    expect(keys).toHaveLength(7);
    expect(new Set(keys).size).toBe(7);
    expect(keys.every((k) => k.startsWith("kind."))).toBe(true);
  });

  test("every outcome has a unique key", () => {
    const keys = NOTE_OUTCOMES.map(noteOutcomeI18nKey);
    expect(keys).toHaveLength(4);
    expect(new Set(keys).size).toBe(4);
    expect(keys.every((k) => k.startsWith("outcome."))).toBe(true);
  });
});

describe("attachment limits", () => {
  test("are the values the mutation and the composer both enforce", () => {
    expect(NOTE_ATTACHMENT_MAX_COUNT).toBe(5);
    expect(NOTE_ATTACHMENT_MAX_BYTES).toBe(26_214_400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/inbox/notes.test.ts`
Expected: FAIL — `Cannot find module './notes'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/inbox/notes.ts`:

```ts
// ============================================================
// Pure note logic — vocabulary, classification and limits, with no
// React and no Convex import, so it is unit-testable without rendering
// and without a convex-test harness. Mirrors the structure
// `src/lib/inbox/threadHeader.ts` established: branching lives here,
// components stay presentational.
// ============================================================

export const NOTE_KINDS = [
  "call",
  "whatsapp_external",
  "meeting",
  "email",
  "payment",
  "general",
] as const;

export type NoteKind = (typeof NOTE_KINDS)[number];

export const NOTE_OUTCOMES = [
  "no_answer",
  "follow_up",
  "do_not_contact",
  "not_interested",
] as const;

export type NoteOutcome = (typeof NOTE_OUTCOMES)[number];

/** What the UI renders. `system` is never stored — it is derived for
 *  the engine-written rows that predate (and continue alongside) the
 *  hand-written ones. */
export type DisplayNoteKind = NoteKind | "system";

/** Bounded in `contactNotes.add`/`update`, mirrored in the composer so
 *  a user is told before the upload rather than after. */
export const NOTE_ATTACHMENT_MAX_COUNT = 5;

/** 25 MB. Deliberately above `MEDIA_MAX_BYTES` (16 MB): that ceiling
 *  mirrors Meta's WhatsApp caps, and a note attachment is never sent to
 *  Meta. `uploadAccountMedia` leaves size validation to its caller
 *  precisely so a feature can set its own. */
export const NOTE_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * The display kind for a note row, including the two legacy shapes this
 * table already holds:
 *
 *   - no `kind`, no `createdByUserId` → written by an engine (funnel,
 *     AI tagging, checklist, qualification, invitations) → `system`.
 *   - no `kind`, but an author → a human note from before this feature
 *     → `general`.
 *
 * Derived at read time on purpose: no backfill, and an engine that
 * starts stamping `kind` later needs no change here.
 */
export function noteKindOf(note: {
  kind?: NoteKind | null;
  createdByUserId?: string | null;
}): DisplayNoteKind {
  if (note.kind) return note.kind;
  return note.createdByUserId ? "general" : "system";
}

/** Key under the `Inbox.notes` namespace. */
export function noteKindI18nKey(kind: DisplayNoteKind): string {
  return `kind.${kind}`;
}

/** Key under the `Inbox.notes` namespace. */
export function noteOutcomeI18nKey(outcome: NoteOutcome): string {
  return `outcome.${outcome}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/inbox/notes.test.ts`
Expected: PASS (12 assertions across 8 tests)

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/lib/inbox/notes.ts src/lib/inbox/notes.test.ts
git commit -m "feat(notes): pure note vocabulary, classification and limits

Derives the display kind for the two legacy row shapes already in
contactNotes (engine-written -> system, authored-but-untagged ->
general) at read time, so no row needs backfilling.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: `contactNotes.add` — tags, attachments, and the do-not-contact flag

**Files:**
- Modify: `convex/contactNotes.ts:70-88`
- Test: `convex/contactNotes.test.ts`

**Interfaces:**
- Consumes: Task 1's schema fields; `parseMediaKey` from `convex/lib/r2/keys.ts`.
- Produces: `api.contactNotes.add({ contactId, body, conversationId?, kind?, outcome?, attachments? }) => Id<"contactNotes">`. The existing two-arg call in `contact-sidebar.tsx` keeps working unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `convex/contactNotes.test.ts`:

```ts
test("add stores the channel, outcome and conversation link", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const conversationId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );

  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    conversationId,
    body: "Rang him, no answer",
    kind: "call",
    outcome: "no_answer",
  });

  const row = await t.run((ctx) => ctx.db.get(noteId));
  expect(row!.kind).toBe("call");
  expect(row!.outcome).toBe("no_answer");
  expect(row!.conversationId).toBe(conversationId);
});

test("add sets contacts.doNotContact when the outcome is do_not_contact", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Said never contact again",
    kind: "call",
    outcome: "do_not_contact",
  });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeDefined();
  expect(contact!.doNotContact!.noteId).toBe(noteId);
  expect(contact!.doNotContact!.byUserId).toBe(userId);
});

test("add leaves doNotContact untouched for every other outcome", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Will call back Tuesday",
    kind: "call",
    outcome: "follow_up",
  });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeUndefined();
});

test("add rejects more than 5 attachments", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  const attachment = (n: number) => ({
    key: `${accountId}/note/file${n}.pdf`,
    filename: `f${n}.pdf`,
    contentType: "application/pdf",
    size: 10,
  });

  await expect(
    asUser.mutation(api.contactNotes.add, {
      contactId,
      body: "Too many",
      attachments: [1, 2, 3, 4, 5, 6].map(attachment),
    }),
  ).rejects.toThrow(/TOO_MANY_ATTACHMENTS/);
});

test("add rejects an attachment key belonging to another account as NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });

  await expect(
    asUser.mutation(api.contactNotes.add, {
      contactId,
      body: "Someone else's file",
      attachments: [
        {
          key: "some-other-account/note/stolen.pdf",
          filename: "stolen.pdf",
          contentType: "application/pdf",
          size: 10,
        },
      ],
    }),
  ).rejects.toThrow(/NOT_FOUND/);
});

test("add rejects a conversationId belonging to another account as NOT_FOUND", async () => {
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
  const aliceContact = await alice.asUser.mutation(api.contacts.create, {
    phone: "1",
  });
  const bobContact = await bob.asUser.mutation(api.contacts.create, {
    phone: "2",
  });
  const bobConversation = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: bob.accountId,
      contactId: bobContact,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );

  await expect(
    alice.asUser.mutation(api.contactNotes.add, {
      contactId: aliceContact,
      conversationId: bobConversation,
      body: "Cross-tenant probe",
    }),
  ).rejects.toThrow(/NOT_FOUND/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/contactNotes.test.ts`
Expected: FAIL — `add` does not accept `kind`/`outcome`/`attachments`/`conversationId`.

- [ ] **Step 3: Implement the extended `add`**

In `convex/contactNotes.ts`, add the import and a validation helper below `requireOwnNote`:

```ts
import { parseMediaKey } from "./lib/r2/keys";

/** Mirrors `src/lib/inbox/notes.ts`'s NOTE_ATTACHMENT_MAX_COUNT. Kept
 *  as a literal rather than imported: `convex/` must not import from
 *  `src/`, and the pair is pinned by tests on both sides. */
const NOTE_ATTACHMENT_MAX_COUNT = 5;

const attachmentValidator = v.object({
  key: v.string(),
  filename: v.string(),
  contentType: v.string(),
  size: v.number(),
});

const kindValidator = v.union(
  v.literal("call"),
  v.literal("whatsapp_external"),
  v.literal("meeting"),
  v.literal("email"),
  v.literal("payment"),
  v.literal("general"),
);

const outcomeValidator = v.union(
  v.literal("no_answer"),
  v.literal("follow_up"),
  v.literal("do_not_contact"),
  v.literal("not_interested"),
);

/**
 * Bounds the attachment list and proves every key belongs to the
 * caller's own account. A key is the ONLY ownership signal an R2 object
 * carries (`convex/lib/r2/keys.ts`), so this is the same check
 * `files.remove` and `send.sendMedia` perform — a foreign OR unparseable
 * key is `NOT_FOUND`, never `FORBIDDEN`, so a probe learns nothing.
 */
function validateAttachments(
  attachments: Array<{ key: string }> | undefined,
  accountId: Id<"accounts">,
) {
  if (!attachments) return;
  if (attachments.length > NOTE_ATTACHMENT_MAX_COUNT) {
    throw new ConvexError({
      code: "TOO_MANY_ATTACHMENTS",
      max: NOTE_ATTACHMENT_MAX_COUNT,
    });
  }
  for (const attachment of attachments) {
    const parsed = parseMediaKey(attachment.key);
    if (!parsed || parsed.accountId !== accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "file" });
    }
  }
}

/**
 * Loads a conversation and throws `NOT_FOUND` unless it belongs to the
 * caller's own account — same non-leaky treatment as
 * `requireOwnContact`.
 */
async function requireOwnConversation(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  conversationId: Id<"conversations">,
) {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "conversation" });
  }
  return conversation;
}
```

Then replace the `add` mutation:

```ts
export const add = accountMutation({
  args: {
    contactId: v.id("contacts"),
    body: v.string(),
    conversationId: v.optional(v.id("conversations")),
    kind: v.optional(kindValidator),
    outcome: v.optional(outcomeValidator),
    attachments: v.optional(v.array(attachmentValidator)),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnContact(ctx, args.contactId);
    if (args.conversationId) {
      await requireOwnConversation(ctx, args.conversationId);
    }
    validateAttachments(args.attachments, ctx.accountId);

    // The schema's real field is `noteText`; the public arg stays `body`
    // per this module's original API (see the file header).
    const noteId = await ctx.db.insert("contactNotes", {
      accountId: ctx.accountId,
      contactId: args.contactId,
      conversationId: args.conversationId,
      noteText: args.body,
      kind: args.kind,
      outcome: args.outcome,
      attachments: args.attachments,
      createdByUserId: ctx.userId,
    });

    // The one outcome with teeth. Denormalised onto the contact so the
    // Phase 3 automation gates are an O(1) field read rather than a note
    // scan on every inbound message. Overwrites any earlier flag: the
    // most recent refusal is the one that carries the reason.
    if (args.outcome === "do_not_contact") {
      await ctx.db.patch(args.contactId, {
        doNotContact: { at: Date.now(), byUserId: ctx.userId, noteId },
      });
    }

    return noteId;
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/contactNotes.test.ts`
Expected: PASS — including the pre-existing tests, since every new arg is optional.

- [ ] **Step 5: Commit**

```bash
git status --short
git add convex/contactNotes.ts convex/contactNotes.test.ts
git commit -m "feat(notes): accept channel, outcome and attachments on add

Every new arg is optional, so the existing two-arg call site in
contact-sidebar.tsx is unchanged. A do_not_contact outcome denormalises
onto contacts.doNotContact for the Phase 3 gates; attachment keys are
proven to belong to the caller's own account, with a foreign or
unparseable key treated identically as NOT_FOUND.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `update`, tightened `remove`, and `clearDoNotContact`

**Files:**
- Modify: `convex/contactNotes.ts` (`remove` at :90-97, plus two new mutations)
- Test: `convex/contactNotes.test.ts`

**Interfaces:**
- Consumes: Task 3's `validateAttachments`, `attachmentValidator`, `kindValidator`, `outcomeValidator`.
- Produces:
  - `api.contactNotes.update({ noteId, body?, kind?, outcome?, attachments? }) => null`
  - `api.contactNotes.clearDoNotContact({ contactId }) => null`
  - `remove` now author-only or `admin`+.

- [ ] **Step 1: Write the failing tests**

Append to `convex/contactNotes.test.ts`:

```ts
test("update edits an author's own note and stamps editedAt", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Typo",
    kind: "call",
  });

  await asUser.mutation(api.contactNotes.update, {
    noteId,
    body: "Fixed",
    kind: "meeting",
  });

  const row = await t.run((ctx) => ctx.db.get(noteId));
  expect(row!.noteText).toBe("Fixed");
  expect(row!.kind).toBe("meeting");
  expect(row!.editedAt).toBeGreaterThan(0);
});

test("update refuses to change an outcome that is already do_not_contact", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Never contact",
    outcome: "do_not_contact",
  });

  await expect(
    asUser.mutation(api.contactNotes.update, { noteId, outcome: "follow_up" }),
  ).rejects.toThrow(/DO_NOT_CONTACT_LOCKED/);

  // Editing the TEXT of that same note is still allowed.
  await asUser.mutation(api.contactNotes.update, {
    noteId,
    body: "Never contact — he was firm about it",
  });
  const row = await t.run((ctx) => ctx.db.get(noteId));
  expect(row!.outcome).toBe("do_not_contact");
});

test("update and remove reject an agent who is not the author", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await alice.asUser.mutation(api.contacts.create, {
    phone: "1",
  });
  const noteId = await alice.asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Alice's note",
  });

  // A second agent in the SAME account — membership is fine, authorship
  // is not.
  const bobUserId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Bob", email: "bob@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: bobUserId,
      accountId: alice.accountId,
      role: "agent",
      fullName: "Bob",
      email: "bob@example.com",
    }),
  );
  const asBob = t.withIdentity({ subject: `${bobUserId}|session-bob` });

  await expect(
    asBob.mutation(api.contactNotes.update, { noteId, body: "hijack" }),
  ).rejects.toThrow(/FORBIDDEN/);
  await expect(
    asBob.mutation(api.contactNotes.remove, { noteId }),
  ).rejects.toThrow(/FORBIDDEN/);
});

test("an admin may remove a note they did not author", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await alice.asUser.mutation(api.contacts.create, {
    phone: "1",
  });
  const noteId = await alice.asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Alice's note",
  });

  const adminUserId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Ada", email: "ada@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: adminUserId,
      accountId: alice.accountId,
      role: "admin",
      fullName: "Ada",
      email: "ada@example.com",
    }),
  );
  const asAdmin = t.withIdentity({ subject: `${adminUserId}|session-ada` });

  await asAdmin.mutation(api.contactNotes.remove, { noteId });
  expect(await t.run((ctx) => ctx.db.get(noteId))).toBeNull();
});

test("deleting the note that set doNotContact leaves the flag standing", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Never contact",
    outcome: "do_not_contact",
  });

  await asUser.mutation(api.contactNotes.remove, { noteId });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeDefined();
});

test("clearDoNotContact requires supervisor and writes an audit note", async () => {
  const t = convexTest(schema, modules);
  const agent = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await agent.asUser.mutation(api.contacts.create, {
    phone: "1",
  });
  await agent.asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Never contact",
    outcome: "do_not_contact",
  });

  // An agent may not overrule a customer's stated wish.
  await expect(
    agent.asUser.mutation(api.contactNotes.clearDoNotContact, { contactId }),
  ).rejects.toThrow(/FORBIDDEN/);

  const supUserId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: supUserId,
      accountId: agent.accountId,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    }),
  );
  const asSup = t.withIdentity({ subject: `${supUserId}|session-sam` });

  await asSup.mutation(api.contactNotes.clearDoNotContact, { contactId });

  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeUndefined();

  // Clearing is itself auditable.
  const notes = await t.run((ctx) =>
    ctx.db
      .query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect(),
  );
  const audit = notes.find((n) => n.createdByUserId === supUserId);
  expect(audit).toBeDefined();
  expect(audit!.kind).toBe("general");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/contactNotes.test.ts`
Expected: FAIL — `api.contactNotes.update` and `clearDoNotContact` do not exist; `remove` allows any agent.

- [ ] **Step 3: Add an authorship helper**

In `convex/contactNotes.ts`, below `requireOwnNote`:

```ts
import { hasMinRole } from "./lib/roles";

/**
 * A note is its author's to edit or delete; an `admin` may act on
 * anyone's. Engine-written rows have no `createdByUserId`, which makes
 * them admin-only by construction — correct, since they are the audit
 * trail rather than someone's memo.
 *
 * `FORBIDDEN` (not `NOT_FOUND`) is right here: the caller has already
 * proven, via `requireOwnNote`, that the row is inside their own
 * account. Nothing is leaked by admitting it exists.
 */
function requireAuthorOrAdmin(
  ctx: { userId: Id<"users">; role: AccountRole },
  note: { createdByUserId?: Id<"users"> },
) {
  if (note.createdByUserId && note.createdByUserId === ctx.userId) return;
  if (hasMinRole(ctx.role, "admin")) return;
  throw new ConvexError({ code: "FORBIDDEN" });
}
```

Add `import type { AccountRole } from "./lib/roles";` alongside the existing type imports.

- [ ] **Step 4: Implement `update`**

```ts
export const update = accountMutation({
  args: {
    noteId: v.id("contactNotes"),
    body: v.optional(v.string()),
    kind: v.optional(kindValidator),
    outcome: v.optional(outcomeValidator),
    attachments: v.optional(v.array(attachmentValidator)),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const note = await requireOwnNote(ctx, args.noteId);
    requireAuthorOrAdmin(ctx, note);
    validateAttachments(args.attachments, ctx.accountId);

    // A do-not-contact note's OUTCOME is frozen. `clearDoNotContact` is
    // the single path that lifts the flag, and it is supervisor-gated
    // and audited — editing the note must not be a back door around
    // that. The note's TEXT stays editable (a typo in the reason is
    // still worth fixing).
    if (note.outcome === "do_not_contact" && args.outcome !== undefined) {
      throw new ConvexError({ code: "DO_NOT_CONTACT_LOCKED" });
    }

    await ctx.db.patch(args.noteId, {
      ...(args.body !== undefined ? { noteText: args.body } : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
      ...(args.attachments !== undefined
        ? { attachments: args.attachments }
        : {}),
      editedAt: Date.now(),
    });
    return null;
  },
});
```

- [ ] **Step 5: Tighten `remove`**

Replace the existing `remove`:

```ts
export const remove = accountMutation({
  args: { noteId: v.id("contactNotes") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const note = await requireOwnNote(ctx, args.noteId);
    // Tightened from "any agent" — a shared audit trail nobody owns is
    // one an agent can quietly edit history in.
    requireAuthorOrAdmin(ctx, note);

    // Deliberately does NOT clear `contacts.doNotContact`. See that
    // field's own comment in schema.ts: a customer's stated wish must
    // outlive an agent tidying up their notes.
    await ctx.db.delete(args.noteId);
    return null;
  },
});
```

Note: the R2 objects behind `note.attachments` are intentionally **not** deleted here — orphan cleanup is a Phase 2 concern once the sidebar can also delete, and a leaked object is a storage nit while a wrongly-deleted passport scan is not. Leave a comment saying so.

- [ ] **Step 6: Implement `clearDoNotContact`**

```ts
export const clearDoNotContact = accountMutation({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    // Supervisor floor: this overrides something the CUSTOMER asked
    // for, which is a different class of act from writing a note.
    ctx.requireRole("supervisor");
    const contact = await requireOwnContact(ctx, args.contactId);
    if (!contact.doNotContact) return null;

    // Audit first, so the trail exists even if the patch below is the
    // last thing this transaction does.
    await ctx.db.insert("contactNotes", {
      accountId: ctx.accountId,
      contactId: args.contactId,
      noteText: "Do-not-contact flag cleared.",
      kind: "general",
      createdByUserId: ctx.userId,
    });
    await ctx.db.patch(args.contactId, { doNotContact: undefined });
    return null;
  },
});
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run convex/contactNotes.test.ts`
Expected: PASS

- [ ] **Step 8: Check the tightened `remove` against its existing callers**

Run: `grep -rn "contactNotes.remove" src convex --include='*.ts' --include='*.tsx'`
Expected: no call site outside the tests. If one exists, confirm its caller is the note's author; otherwise report it before proceeding.

- [ ] **Step 9: Commit**

```bash
git status --short
git add convex/contactNotes.ts convex/contactNotes.test.ts
git commit -m "feat(notes): author-scoped edit and delete, plus an audited DNC clear

Tightens remove from any agent to the note's author or an admin, so
nobody can quietly edit a shared audit trail. A do-not-contact note's
outcome is frozen: clearDoNotContact is the one path that lifts the
flag, it is supervisor-gated, and it writes its own audit note.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Reads — author names and the per-conversation query

**Files:**
- Modify: `convex/contactNotes.ts` (`listForContact` at :51-68)
- Test: `convex/contactNotes.test.ts`

**Interfaces:**
- Consumes: Task 1's `by_conversation` index.
- Produces: both queries return `Array<Doc<"contactNotes"> & { author: { userId, fullName, avatarUrl } | null }>`.
  - `api.contactNotes.listForContact({ contactId })`
  - `api.contactNotes.listForConversation({ conversationId })`

- [ ] **Step 1: Write the failing tests**

```ts
test("listForContact embeds the author's name and returns newest first", async () => {
  const t = convexTest(schema, modules);
  const { asUser, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  await asUser.mutation(api.contactNotes.add, { contactId, body: "First" });
  await asUser.mutation(api.contactNotes.add, { contactId, body: "Second" });

  const notes = await asUser.query(api.contactNotes.listForContact, {
    contactId,
  });

  expect(notes.map((n) => n.noteText)).toEqual(["Second", "First"]);
  expect(notes[0].author).toEqual({
    userId,
    fullName: "Alice",
    avatarUrl: undefined,
  });
});

test("listForContact returns a null author for an engine-written note", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  await t.run((ctx) =>
    ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: "Stage moved to qualified",
    }),
  );

  const notes = await asUser.query(api.contactNotes.listForContact, {
    contactId,
  });
  expect(notes[0].author).toBeNull();
});

test("listForConversation returns only that conversation's notes", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "1" });
  const [convA, convB] = await t.run(async (ctx) => [
    await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
    await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  ]);
  await asUser.mutation(api.contactNotes.add, {
    contactId,
    conversationId: convA,
    body: "In A",
  });
  await asUser.mutation(api.contactNotes.add, {
    contactId,
    conversationId: convB,
    body: "In B",
  });
  // A contact-level note with no conversation must appear in NEITHER.
  await asUser.mutation(api.contactNotes.add, { contactId, body: "Unlinked" });

  const inA = await asUser.query(api.contactNotes.listForConversation, {
    conversationId: convA,
  });
  expect(inA.map((n) => n.noteText)).toEqual(["In A"]);
});

test("listForConversation rejects another account's conversation as NOT_FOUND", async () => {
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
  const bobContact = await bob.asUser.mutation(api.contacts.create, {
    phone: "2",
  });
  const bobConversation = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId: bob.accountId,
      contactId: bobContact,
      status: "open",
      lastMessageAt: Date.now(),
      unreadCount: 0,
    }),
  );

  await expect(
    alice.asUser.query(api.contactNotes.listForConversation, {
      conversationId: bobConversation,
    }),
  ).rejects.toThrow(/NOT_FOUND/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/contactNotes.test.ts`
Expected: FAIL — no `author` field; `listForConversation` does not exist.

- [ ] **Step 3: Write the author-join helper**

```ts
/**
 * Embeds each note's author (name + avatar) so the UI need not fan out
 * one membership query per note. Memberships are cached per userId
 * within the call: a thread is usually two or three agents' notes, so
 * this is a handful of reads rather than one per row.
 *
 * Returns `null` for an engine-written note (no `createdByUserId`) and
 * for an author whose membership has since been removed — the UI renders
 * both as a system entry rather than a missing name.
 */
async function withAuthors(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  notes: Array<Doc<"contactNotes">>,
) {
  const cache = new Map<
    string,
    { userId: Id<"users">; fullName?: string; avatarUrl?: string } | null
  >();

  const resolve = async (userId: Id<"users">) => {
    const hit = cache.get(userId);
    if (hit !== undefined) return hit;
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    const value =
      membership && membership.accountId === ctx.accountId
        ? {
            userId,
            fullName: membership.fullName,
            avatarUrl: membership.avatarUrl,
          }
        : null;
    cache.set(userId, value);
    return value;
  };

  return await Promise.all(
    notes.map(async (note) => ({
      ...note,
      author: note.createdByUserId ? await resolve(note.createdByUserId) : null,
    })),
  );
}
```

Add `import type { Doc, Id } from "./_generated/dataModel";` (extend the existing `Id` import).

- [ ] **Step 4: Apply it to `listForContact` and add `listForConversation`**

```ts
export const listForContact = accountQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    await requireOwnContact(ctx, args.contactId);
    const notes = await ctx.db
      .query("contactNotes")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .order("desc")
      .collect();
    return await withAuthors(ctx, notes);
  },
});

/**
 * One conversation's notes, OLDEST first — the thread renders them in
 * chronological order alongside messages, unlike the sidebar's
 * newest-first log.
 *
 * A note with no `conversationId` (engine-written, or added from the
 * contacts page) is deliberately absent: it belongs to the contact, not
 * to any one thread, and the sidebar is where it surfaces.
 */
export const listForConversation = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireOwnConversation(ctx, args.conversationId);
    const notes = await ctx.db
      .query("contactNotes")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("asc")
      .collect();
    return await withAuthors(ctx, notes);
  },
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run convex/contactNotes.test.ts`
Expected: PASS

- [ ] **Step 6: Verify the existing sidebar adapter still compiles**

`toUiContactNote` in `src/lib/convex/adapters.ts:176` takes `Doc<"contactNotes">`; the returned rows are now a superset, which is assignable. Confirm:

Run: `npx tsc --noEmit`
Expected: no errors. If `toUiContactNote`'s parameter type rejects the extra `author` key, widen it to `Doc<"contactNotes"> & { author?: unknown }` rather than casting at the call site.

- [ ] **Step 7: Commit**

```bash
git status --short
git add convex/contactNotes.ts convex/contactNotes.test.ts
git commit -m "feat(notes): embed note authors and add a per-conversation read

A note showed a date but never a name. Both queries now embed the
author's membership (cached per user within the call), returning null
for engine-written rows and for departed members so the UI renders them
as system entries rather than blanks.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Timeline merging

**Files:**
- Modify: `src/lib/inbox/notes.ts`
- Test: `src/lib/inbox/notes.test.ts`

**Interfaces:**
- Consumes: Task 2's module.
- Produces:
  - `type TimelineNote = { _id: string; _creationTime: number }`
  - `splitEarlierNotes<T extends TimelineNote>(notes: T[], oldestLoadedAt: number | null): { earlier: T[]; inWindow: T[] }`
  - `mergeNotesIntoGroups<M, N extends TimelineNote>(groups, notes, getMessageTime) => Array<{ date: string; items: Array<{ type: "message"; value: M } | { type: "note"; value: N }> }>`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/inbox/notes.test.ts`:

```ts
import { splitEarlierNotes, mergeNotesIntoGroups } from "./notes";

const note = (id: string, at: number) => ({ _id: id, _creationTime: at });
const message = (id: string, at: number) => ({ id, created_at: at });
const timeOf = (m: { created_at: number }) => m.created_at;

describe("splitEarlierNotes", () => {
  test("parks notes older than the loaded window in `earlier`", () => {
    const notes = [note("a", 100), note("b", 500), note("c", 900)];
    const { earlier, inWindow } = splitEarlierNotes(notes, 400);
    expect(earlier.map((n) => n._id)).toEqual(["a"]);
    expect(inWindow.map((n) => n._id)).toEqual(["b", "c"]);
  });

  test("a note exactly at the boundary stays in the window", () => {
    const { earlier, inWindow } = splitEarlierNotes([note("a", 400)], 400);
    expect(earlier).toHaveLength(0);
    expect(inWindow).toHaveLength(1);
  });

  // The whole history is loaded, so nothing can be "earlier".
  test("keeps everything in the window when there is no oldest message", () => {
    const { earlier, inWindow } = splitEarlierNotes(
      [note("a", 100), note("b", 900)],
      null,
    );
    expect(earlier).toHaveLength(0);
    expect(inWindow).toHaveLength(2);
  });
});

describe("mergeNotesIntoGroups", () => {
  test("interleaves notes with messages by time inside each date group", () => {
    const groups = [
      { date: "2026-07-28", messages: [message("m1", 10), message("m2", 30)] },
      { date: "2026-07-29", messages: [message("m3", 50)] },
    ];
    const notes = [note("n1", 20), note("n2", 60)];

    const merged = mergeNotesIntoGroups(groups, notes, timeOf);

    expect(merged[0].items.map((i) => i.type)).toEqual([
      "message",
      "note",
      "message",
    ]);
    expect(merged[1].items.map((i) => i.type)).toEqual(["message", "note"]);
  });

  test("puts a note into the LAST group when it is newer than every message", () => {
    const groups = [{ date: "2026-07-29", messages: [message("m1", 10)] }];
    const merged = mergeNotesIntoGroups(groups, [note("n1", 999)], timeOf);
    expect(merged[0].items.map((i) => i.type)).toEqual(["message", "note"]);
  });

  test("puts a note into the FIRST group when it is older than every message", () => {
    const groups = [{ date: "2026-07-29", messages: [message("m1", 500)] }];
    const merged = mergeNotesIntoGroups(groups, [note("n1", 1)], timeOf);
    expect(merged[0].items.map((i) => i.type)).toEqual(["note", "message"]);
  });

  test("returns a note-only group when there are no messages at all", () => {
    const merged = mergeNotesIntoGroups([], [note("n1", 5)], timeOf);
    expect(merged).toHaveLength(1);
    expect(merged[0].items).toHaveLength(1);
    expect(merged[0].items[0].type).toBe("note");
  });

  test("leaves groups untouched when there are no notes", () => {
    const groups = [{ date: "2026-07-29", messages: [message("m1", 10)] }];
    const merged = mergeNotesIntoGroups(groups, [], timeOf);
    expect(merged[0].items.map((i) => i.type)).toEqual(["message"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/inbox/notes.test.ts`
Expected: FAIL — `splitEarlierNotes` and `mergeNotesIntoGroups` are not exported.

- [ ] **Step 3: Implement both functions**

Append to `src/lib/inbox/notes.ts`:

```ts
/** The minimum a row needs to be placed on the timeline. */
export interface TimelineNote {
  _id: string;
  _creationTime: number;
}

/**
 * The thread is cursor-paginated (`loadMore(30)`), so a note older than
 * the oldest loaded message has no message to sit beside. Those are
 * split off and rendered as a single "N earlier notes" pill at the top
 * of the loaded range rather than being silently dropped.
 *
 * `oldestLoadedAt` is `null` when nothing is loaded or the whole history
 * is present — either way nothing can be "earlier", so everything stays
 * in the window.
 */
export function splitEarlierNotes<T extends TimelineNote>(
  notes: T[],
  oldestLoadedAt: number | null,
): { earlier: T[]; inWindow: T[] } {
  if (oldestLoadedAt === null) return { earlier: [], inWindow: notes };
  const earlier: T[] = [];
  const inWindow: T[] = [];
  for (const note of notes) {
    // `>=` — a note created in the same millisecond as the oldest
    // message belongs beside it, not above the fold.
    (note._creationTime >= oldestLoadedAt ? inWindow : earlier).push(note);
  }
  return { earlier, inWindow };
}

export type TimelineItem<M, N> =
  | { type: "message"; value: M }
  | { type: "note"; value: N };

/**
 * Places each note inside the existing date groups by timestamp, so the
 * thread reads as one story: customer said X, I called and they said Y,
 * I sent the quote.
 *
 * Notes are assigned to a group rather than re-grouped by their own date
 * on purpose — the caller already owns date bucketing and its separators,
 * and duplicating that here would let the two drift. A note newer than
 * every message lands in the last group; older than every message, the
 * first; with no messages at all, its own single group.
 */
export function mergeNotesIntoGroups<
  M,
  N extends TimelineNote,
  G extends { date: string; messages: M[] },
>(
  groups: G[],
  notes: N[],
  getMessageTime: (message: M) => number,
): Array<{ date: string; items: Array<TimelineItem<M, N>> }> {
  const sorted = [...notes].sort((a, b) => a._creationTime - b._creationTime);

  if (groups.length === 0) {
    if (sorted.length === 0) return [];
    return [
      {
        date: "",
        items: sorted.map((value) => ({ type: "note" as const, value })),
      },
    ];
  }

  const base = groups.map((group) => ({
    date: group.date,
    items: group.messages.map((value) => ({ type: "message" as const, value })),
  })) as Array<{ date: string; items: Array<TimelineItem<M, N>> }>;

  for (const note of sorted) {
    // The last group whose first message starts at or before the note.
    let target = 0;
    for (let i = 0; i < groups.length; i++) {
      const first = groups[i].messages[0];
      if (first !== undefined && getMessageTime(first) <= note._creationTime) {
        target = i;
      }
    }

    const items = base[target].items;
    const at = items.findIndex(
      (item) =>
        item.type === "message" &&
        getMessageTime(item.value) > note._creationTime,
    );
    const entry: TimelineItem<M, N> = { type: "note", value: note };
    if (at === -1) items.push(entry);
    else items.splice(at, 0, entry);
  }

  return base;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/inbox/notes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/lib/inbox/notes.ts src/lib/inbox/notes.test.ts
git commit -m "feat(notes): merge notes into the thread's date groups

Places notes inside the caller's existing date buckets rather than
re-grouping, so the two cannot drift, and splits off notes older than
the paginated window for an 'N earlier notes' pill instead of dropping
them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: The note card

**Files:**
- Create: `src/components/inbox/note-card.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `noteKindOf`, `noteKindI18nKey`, `noteOutcomeI18nKey` (Task 2); `mediaUrlFromKey` from `src/lib/storage/media-url.ts`.
- Produces: `<NoteCard note={NoteRow} canManage={boolean} onEdit={(id) => void} onDelete={(id) => void} />` where `NoteRow` is one element of `api.contactNotes.listForConversation`'s return.

- [ ] **Step 1: Add the copy**

In `messages/en.json`, add a `notes` block inside the existing `Inbox` namespace (a sibling of `sidebar`):

```json
    "notes": {
      "internal": "Internal · not sent",
      "addNote": "Add note",
      "placeholder": "What happened? e.g. Called him, wants March, will confirm Tuesday",
      "save": "Save note",
      "cancel": "Cancel",
      "edited": "edited",
      "attach": "Attach file",
      "earlierNotes": "{count, plural, one {# earlier note} other {# earlier notes}}",
      "tooManyFiles": "Up to {max} files per note.",
      "fileTooLarge": "{name} is too large. Maximum {max} MB per file.",
      "uploadFailed": "Couldn't upload {name}.",
      "saveFailed": "Couldn't save the note.",
      "confirmDoNotContact": "Stop all automated messages to this customer?",
      "delete": "Delete",
      "edit": "Edit",
      "systemAuthor": "System",
      "kind": {
        "call": "Phone call",
        "whatsapp_external": "WhatsApp",
        "meeting": "Meeting",
        "email": "Email",
        "payment": "Payment",
        "general": "Note",
        "system": "System"
      },
      "outcome": {
        "no_answer": "No answer",
        "follow_up": "Follow up",
        "do_not_contact": "Do not contact",
        "not_interested": "Not interested"
      }
    },
```

- [ ] **Step 2: Write the component**

Create `src/components/inbox/note-card.tsx`:

```tsx
"use client";

import { useTranslations } from "next-intl";
import { format } from "date-fns";
import {
  Phone,
  MessageCircle,
  Users,
  Mail,
  Banknote,
  StickyNote,
  Settings2,
  Lock,
  Paperclip,
  MoreVertical,
} from "lucide-react";
import {
  noteKindOf,
  noteKindI18nKey,
  noteOutcomeI18nKey,
  type DisplayNoteKind,
  type NoteKind,
  type NoteOutcome,
} from "@/lib/inbox/notes";
import { mediaUrlFromKey } from "@/lib/storage/media-url";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface NoteAttachment {
  key: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface NoteRow {
  _id: string;
  _creationTime: number;
  noteText: string;
  kind?: NoteKind;
  outcome?: NoteOutcome;
  attachments?: NoteAttachment[];
  editedAt?: number;
  createdByUserId?: string;
  author: { userId: string; fullName?: string; avatarUrl?: string } | null;
}

const ICON_BY_KIND: Record<DisplayNoteKind, typeof Phone> = {
  call: Phone,
  whatsapp_external: MessageCircle,
  meeting: Users,
  email: Mail,
  payment: Banknote,
  general: StickyNote,
  system: Settings2,
};

/**
 * One internal note. Rendered full-width and centred, NEVER as a
 * left/right chat bubble — an agent must never be able to mistake a note
 * for something the customer received. (It cannot be: notes live in a
 * different table from `messages`, and the Meta send path reads only
 * `messages`. The visual distinction exists so the reader knows that.)
 */
export function NoteCard({
  note,
  canManage,
  onEdit,
  onDelete,
}: {
  note: NoteRow;
  canManage: boolean;
  onEdit?: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  const t = useTranslations("Inbox.notes");
  const kind = noteKindOf(note);
  const Icon = ICON_BY_KIND[kind];
  const isDoNotContact = note.outcome === "do_not_contact";

  return (
    <div
      className={`mx-auto w-full max-w-[85%] rounded-lg border border-dashed px-3 py-2 ${
        isDoNotContact
          ? "border-destructive/50 bg-destructive/5"
          : "border-amber-500/40 bg-amber-500/5"
      }`}
    >
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <Lock className="h-3 w-3 shrink-0" />
        <span className="uppercase tracking-wider">{t("internal")}</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5">
          <Icon className="h-3 w-3" />
          {t(noteKindI18nKey(kind))}
        </span>
        {note.outcome && (
          <span
            className={`rounded-full px-1.5 py-0.5 ${
              isDoNotContact
                ? "bg-destructive/15 text-destructive"
                : "bg-muted"
            }`}
          >
            {t(noteOutcomeI18nKey(note.outcome))}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {format(new Date(note._creationTime), "MMM d, HH:mm")}
        </span>
        {canManage && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-5 w-5 p-0">
                <MoreVertical className="h-3 w-3" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onEdit?.(note._id)}>
                {t("edit")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => onDelete?.(note._id)}
              >
                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <p className="mt-1.5 whitespace-pre-wrap text-xs text-foreground">
        {note.noteText}
      </p>

      {note.attachments && note.attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {note.attachments.map((attachment) => (
            <NoteAttachmentChip key={attachment.key} attachment={attachment} />
          ))}
        </div>
      )}

      <p className="mt-1.5 text-[10px] text-muted-foreground">
        {note.author?.fullName ?? t("systemAuthor")}
        {note.editedAt ? ` · ${t("edited")}` : ""}
      </p>
    </div>
  );
}

function NoteAttachmentChip({ attachment }: { attachment: NoteAttachment }) {
  const url = mediaUrlFromKey(attachment.key);
  const isImage = attachment.contentType.startsWith("image/");

  if (!url) return null;

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[10px] text-foreground hover:bg-muted"
    >
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={attachment.filename}
          className="h-6 w-6 rounded object-cover"
        />
      ) : (
        <Paperclip className="h-3 w-3" />
      )}
      <span className="max-w-[10rem] truncate">{attachment.filename}</span>
    </a>
  );
}
```

- [ ] **Step 3: Verify it typechecks and lints**

Run: `npx tsc --noEmit && npx eslint src/components/inbox/note-card.tsx src/lib/inbox/notes.ts`
Expected: no errors. If `@/components/ui/dropdown-menu` does not export these names, run `ls src/components/ui/` and use the project's actual menu primitive — `message-actions.tsx` shows the established pattern.

- [ ] **Step 4: Commit**

```bash
git status --short
git add src/components/inbox/note-card.tsx messages/en.json
git commit -m "feat(notes): render an internal note card

Full-width, dashed, lock-marked and explicitly labelled 'not sent', so
a note can never read as a message the customer received. Do-not-contact
notes render in the destructive tone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: The floating note composer

**Files:**
- Create: `src/components/inbox/note-composer.tsx`

**Interfaces:**
- Consumes: `NOTE_KINDS`, `NOTE_OUTCOMES`, `NOTE_ATTACHMENT_MAX_COUNT`, `NOTE_ATTACHMENT_MAX_BYTES`, the i18n key helpers (Task 2); `api.contactNotes.add` (Task 3); `uploadAccountMedia` from `src/lib/storage/upload-media.ts`.
- Produces: `<NoteComposer contactId={Id<"contacts">} conversationId={Id<"conversations">} />`.

- [ ] **Step 1: Write the component**

Create `src/components/inbox/note-composer.tsx`:

```tsx
"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useConvex, useMutation } from "convex/react";
import { StickyNote, Paperclip, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import {
  NOTE_KINDS,
  NOTE_OUTCOMES,
  NOTE_ATTACHMENT_MAX_COUNT,
  NOTE_ATTACHMENT_MAX_BYTES,
  noteKindI18nKey,
  noteOutcomeI18nKey,
  type NoteKind,
  type NoteOutcome,
} from "@/lib/inbox/notes";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface StagedAttachment {
  key: string;
  filename: string;
  contentType: string;
  size: number;
}

/**
 * The floating "add note" button and its popover. A popover rather than
 * a modal on purpose: the agent is usually reading the conversation
 * while writing the note, and a modal would hide it.
 *
 * Files upload to R2 as soon as they are picked (staged), so Save is a
 * single fast mutation. An abandoned draft therefore leaks its uploaded
 * objects — accepted: `files.remove` GC is a Phase 2 concern, and a few
 * orphan objects cost less than a Save that hangs on a 25 MB upload.
 */
export function NoteComposer({
  contactId,
  conversationId,
}: {
  contactId: Id<"contacts">;
  conversationId: Id<"conversations">;
}) {
  const t = useTranslations("Inbox.notes");
  const convex = useConvex();
  const startUpload = useMutation(api.files.startUpload);
  const addNote = useMutation(api.contactNotes.add);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<NoteKind>("call");
  const [outcome, setOutcome] = useState<NoteOutcome | null>(null);
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const picked = Array.from(files);

      if (attachments.length + picked.length > NOTE_ATTACHMENT_MAX_COUNT) {
        toast.error(t("tooManyFiles", { max: NOTE_ATTACHMENT_MAX_COUNT }));
        return;
      }
      const tooBig = picked.find((f) => f.size > NOTE_ATTACHMENT_MAX_BYTES);
      if (tooBig) {
        toast.error(
          t("fileTooLarge", {
            name: tooBig.name,
            max: Math.round(NOTE_ATTACHMENT_MAX_BYTES / (1024 * 1024)),
          }),
        );
        return;
      }

      setUploading(true);
      try {
        for (const file of picked) {
          try {
            const { key } = await uploadAccountMedia(
              convex,
              startUpload,
              file,
              "note",
            );
            setAttachments((prev) => [
              ...prev,
              {
                key,
                filename: file.name,
                contentType: file.type || "application/octet-stream",
                size: file.size,
              },
            ]);
          } catch {
            toast.error(t("uploadFailed", { name: file.name }));
          }
        }
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [attachments.length, convex, startUpload, t],
  );

  const reset = useCallback(() => {
    setBody("");
    setKind("call");
    setOutcome(null);
    setAttachments([]);
  }, []);

  const handleSave = useCallback(async () => {
    if (!body.trim() || saving) return;

    // Stopping every automated message is a consequential act, so it
    // gets a confirm the other outcomes do not.
    if (outcome === "do_not_contact" && !window.confirm(t("confirmDoNotContact"))) {
      return;
    }

    setSaving(true);
    try {
      await addNote({
        contactId,
        conversationId,
        body: body.trim(),
        kind,
        outcome: outcome ?? undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      reset();
      setOpen(false);
    } catch {
      toast.error(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }, [
    addNote,
    attachments,
    body,
    contactId,
    conversationId,
    kind,
    outcome,
    reset,
    saving,
    t,
  ]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          aria-label={t("addNote")}
          className="absolute bottom-4 right-4 z-10 h-11 w-11 rounded-full bg-amber-500 p-0 shadow-lg hover:bg-amber-600"
        >
          <StickyNote className="h-5 w-5 text-white" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" side="top" className="w-80 p-3">
        <div className="flex flex-wrap gap-1">
          {NOTE_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-full px-2 py-1 text-[10px] ${
                kind === k
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {t(noteKindI18nKey(k))}
            </button>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {NOTE_OUTCOMES.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => setOutcome(outcome === o ? null : o)}
              className={`rounded-full px-2 py-1 text-[10px] ${
                outcome === o
                  ? o === "do_not_contact"
                    ? "bg-destructive text-destructive-foreground"
                    : "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {t(noteOutcomeI18nKey(o))}
            </button>
          ))}
        </div>

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSave();
            }
          }}
          placeholder={t("placeholder")}
          rows={3}
          className="mt-2 w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />

        {attachments.length > 0 && (
          <div className="mt-2 space-y-1">
            {attachments.map((a) => (
              <div
                key={a.key}
                className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[10px]"
              >
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="flex-1 truncate">{a.filename}</span>
                <button
                  type="button"
                  aria-label={t("cancel")}
                  onClick={() =>
                    setAttachments((prev) =>
                      prev.filter((x) => x.key !== a.key),
                    )
                  }
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2 flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("attach")}
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Paperclip className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            size="sm"
            className="ml-auto"
            disabled={!body.trim() || saving || uploading}
            onClick={() => void handleSave()}
          >
            {t("save")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 2: Confirm the UI primitives and toast library match this repo**

Run: `ls src/components/ui/ | grep -E 'popover|button'` and `grep -rn "from \"sonner\"" src/components/inbox | head -3`
Expected: `popover.tsx` and `button.tsx` exist, and `sonner`'s `toast` is the established pattern. If the repo uses a different toaster (see `src/components/themed-toaster.tsx`), match the pattern used in `message-composer.tsx` instead.

- [ ] **Step 3: Verify it typechecks and lints**

Run: `npx tsc --noEmit && npx eslint src/components/inbox/note-composer.tsx`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git status --short
git add src/components/inbox/note-composer.tsx
git commit -m "feat(notes): floating note composer with staged R2 uploads

Two clicks to log a call: tap the button, tap a channel chip, type,
save. Files upload to R2 on pick so Save stays a single fast mutation,
and the do-not-contact chip confirms before it stops every automated
message.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Wire notes into the thread

**Files:**
- Modify: `src/components/inbox/message-thread.tsx` (scroll-area block at :1355-1395)
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: everything from Tasks 5–8.
- Produces: notes visible inline in `/inbox`, with the composer mounted.

- [ ] **Step 1: Read the surrounding code before editing**

Run: `sed -n '1340,1450p' src/components/inbox/message-thread.tsx`

Identify: the name of the messages array, the shape of `messageGroups` (`{ date, messages }`), the field carrying each message's timestamp, and the variables holding `conversationId` and the contact. The edit below must use the file's actual names — do not assume.

Another session may be editing this file's **header** block (~945–1352). Confirm with `git status` that the file is clean before editing, and keep every change inside the scroll-area block.

- [ ] **Step 2: Add the query and the merge**

Near the other `useQuery` calls in the component:

```tsx
const noteDocs = useQuery(
  api.contactNotes.listForConversation,
  conversationId ? { conversationId } : "skip",
);
```

Then, after `messageGroups` is computed:

```tsx
// Notes render inline so the thread reads as one story. `messageGroups`
// keeps owning date bucketing and its separators; the merge only places
// notes inside the groups it already produced.
const { earlierNotes, timelineGroups } = useMemo(() => {
  const notes = noteDocs ?? [];
  const oldest = messageGroups[0]?.messages[0];
  const { earlier, inWindow } = splitEarlierNotes(
    notes,
    oldest ? new Date(oldest.created_at).getTime() : null,
  );
  return {
    earlierNotes: earlier,
    timelineGroups: mergeNotesIntoGroups(messageGroups, inWindow, (m) =>
      new Date(m.created_at).getTime(),
    ),
  };
}, [noteDocs, messageGroups]);
```

Add the imports:

```tsx
import { splitEarlierNotes, mergeNotesIntoGroups } from "@/lib/inbox/notes";
import { NoteCard } from "./note-card";
import { NoteComposer } from "./note-composer";
```

- [ ] **Step 3: Render notes inside the existing loop**

Change the group loop from mapping `group.messages` to mapping `group.items`, branching on the discriminator. Keep the existing `MessageBubble` call byte-identical inside the `"message"` branch:

```tsx
{timelineGroups.map((group) => (
  <div key={group.date}>
    {/* Date separator — unchanged */}
    <div className="mb-4 flex items-center justify-center">
      <span className="rounded-full bg-muted px-3 py-1 text-[10px] font-medium text-muted-foreground">
        {formatDateSeparator(group.date, t)}
      </span>
    </div>
    <div className="space-y-2">
      {group.items.map((item) => {
        if (item.type === "note") {
          return (
            <NoteCard
              key={item.value._id}
              note={item.value}
              canManage={item.value.createdByUserId === currentUserId}
            />
          );
        }
        const msg = item.value;
        /* ...the existing per-message body, unchanged... */
      })}
    </div>
  </div>
))}
```

- [ ] **Step 4: Add the earlier-notes pill**

Directly above the `timelineGroups.map(...)`, beside the existing "Load older messages" button:

```tsx
{earlierNotes.length > 0 && (
  <div className="flex justify-center pb-2">
    <span className="rounded-full bg-amber-500/10 px-3 py-1 text-[10px] text-muted-foreground">
      {tNotes("earlierNotes", { count: earlierNotes.length })}
    </span>
  </div>
)}
```

Add `const tNotes = useTranslations("Inbox.notes");` alongside the component's existing `useTranslations` calls.

- [ ] **Step 5: Mount the composer**

The scroll container at line 1355 needs `relative` so the floating button anchors to it:

```tsx
<div ref={scrollRef} className="relative flex-1 overflow-y-auto px-4 py-4">
```

Mount the composer as the last child of that container, guarded so it only renders with both ids:

```tsx
{conversationId && contactId && (
  <NoteComposer contactId={contactId} conversationId={conversationId} />
)}
```

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx eslint src/components/inbox/message-thread.tsx && npm test`
Expected: no type errors, no lint errors, all 2887+ tests pass.

- [ ] **Step 7: Verify in the browser**

Start the dev server via `preview_start` (never `npm run dev` in Bash), open `/inbox`, select a conversation, and confirm:

1. The amber floating button sits bottom-right of the message area, above the composer, and does not cover the last message.
2. Adding a note with the **Call** chip renders it inline at the bottom, full-width, dashed, marked "Internal · not sent", with your name.
3. Attaching a PDF shows a chip that opens from `objs.amaniworld.com`.
4. Picking **Do not contact** prompts for confirmation, and the saved card renders in red.
5. `read_console_messages` shows no errors.

Screenshot the result for the review.

- [ ] **Step 8: Commit**

```bash
git status --short
git add src/components/inbox/message-thread.tsx messages/en.json
git commit -m "feat(inbox): show internal notes inline in the conversation

The thread now reads as one story — what the customer sent, and what
the team did about it off-platform. Date bucketing and separators are
untouched; notes are placed inside the groups message grouping already
produced, and notes older than the paginated window surface as a count
rather than vanishing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Phase 1 rows only).** Schema extension → Task 1. `note` media kind → Task 1. Note CRUD with attachments → Tasks 3–4. `listForConversation` → Task 5. Inline note cards → Tasks 6, 7, 9. Floating composer → Tasks 8, 9. Author on every note → Task 5. Earlier-notes pill → Tasks 6, 9. i18n → Tasks 7, 9.

Phase 2 (`contactActivity`, status header, key facts, sidebar split) and Phase 3 (the three gates, AI wiring, leak regression test) are deliberately absent — they get their own plan files once this one lands.

**Deferred with reasons stated in-plan, not silently dropped:**
- R2 objects are not GC'd on note delete or on an abandoned composer draft (Tasks 4, 8). A leaked object is a storage nit; a wrongly-deleted passport scan is not.
- `toUiContactNote` and the sidebar's existing notes block are untouched — the sidebar is Phase 2's job. The two note UIs coexist until then.

**Type consistency.** `NoteKind`/`NoteOutcome`/`DisplayNoteKind` are declared once in Task 2 and imported everywhere after. The `kindValidator`/`outcomeValidator`/`attachmentValidator` in Task 3 are reused verbatim by Task 4. `NoteRow.author` (Task 7) matches `withAuthors`'s return (Task 5). `NOTE_ATTACHMENT_MAX_COUNT` is 5 in both `src/lib/inbox/notes.ts` and `convex/contactNotes.ts`, pinned by a test on each side — `convex/` must not import from `src/`.

**Known assumption to verify at Task 9, Step 1.** This plan assumes each message row exposes its timestamp as `created_at` (as `toUiContactNote` and the sidebar's `format(new Date(note.created_at))` suggest). Step 1 requires reading the real code first; if the field differs, the `getMessageTime` callbacks are the only lines that change — `mergeNotesIntoGroups` takes the accessor precisely so this is a one-line fix.
