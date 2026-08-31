# Conversation Notes — Phase 2 (The Panel) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening a contact answers "what is happening with this customer" in one screen — current state at the top, the facts that matter next, then everything that has happened, newest first.

**Architecture:** The 704-line `contact-sidebar.tsx` splits into a shell plus three focused components. The activity feed is built on `contactNotes`, which five backend engines already mirror into — not on a five-source merge, which would double-count. Pure formatting logic lives in `src/lib/inbox/activity.ts` and is unit-tested without rendering.

**Tech Stack:** Convex, Next.js + React 19, TypeScript, Tailwind, `next-intl`, Vitest.

**Spec:** [`docs/superpowers/specs/2026-07-29-conversation-notes-design.md`](../specs/2026-07-29-conversation-notes-design.md) — the "UI → Contact sidebar, restructured" section.

**Depends on:** Phase 1 and Phase 3, both merged and deployed. `contactNotes.listForContact` already returns author-joined rows; `NoteCard` already renders one; `Contact.do_not_contact` already reaches the frontend through `toUiContact`.

---

## Two corrections to the spec, established by reading the code

**1. The spec's five-source activity merge would double-count.** It called for merging `contactNotes` + `funnelTransitions` + `contactTags` + `salesChecklists` + `deals`. But the engines already write notes for most of that:

| Event | Already a `contactNotes` row? | Written by |
| --- | --- | --- |
| Deal won / lost / reopened | **Yes** | `convex/funnel.ts:318-338` |
| Sales-checklist item completed | **Yes** | `convex/salesChecklists.ts:109` |
| AI tag accepted | **Yes** | `convex/aiTagging.ts:471` |
| Qualification events | **Yes** | `convex/qualificationEngine.ts:2221` |
| Do-not-contact cleared | **Yes** | `convex/contactNotes.ts` (`clearDoNotContact`) |
| **Non-terminal stage moves** (qualified, price_quoted, itinerary_created, itinerary_sent) | **No** | — |

So merging `deals` and `salesChecklists` in would render the same event twice. The feed is therefore **`contactNotes` plus non-terminal funnel transitions** — the one genuine gap. `contactTags` is excluded too: a tag is current state, not an event, and it already has its own section.

**2. `funnelTransitions` has no `by_contact` index.** It carries `contactId` but indexes only `by_conversation` and `by_account` (`convex/schema.ts:2029-2032`). Task 1 adds the index. Adding an index is additive and safe — the last deploy reported "No indexes are deleted by this push".

## Global Constraints

- **Every Convex function is built with `accountQuery`/`accountMutation`** from `convex/lib/auth.ts` — never the raw `query`/`mutation`.
- **Cross-account and missing rows both throw `ConvexError({ code: "NOT_FOUND", entity })`** — never `FORBIDDEN`, never distinguishable.
- **Reads have no role floor beyond membership.** Do not add `requireRole` to a query.
- **Every new schema field is `v.optional(...)`.** No backfill, no migration.
- **NEVER run `convex dev`, `convex deploy`, or `convex codegen`.** After a real deploy, `convex/_generated/api.d.ts` gains an entry for any new module under `convex/` — including plain helpers under `convex/lib/**` — but that is the deploy's job, not this plan's.
- **The tree has concurrent writers.** Run `git status` and stage explicit paths before every commit — never `git add -A`. **Never use `git stash`** — sessions share one stash stack; write the test before the implementation instead.
- **All user-facing copy through `next-intl`** into `messages/en.json` (the only locale file). A merge on this file has silently dropped keys before (`5f5bd88`) — after any merge, re-check that the keys you added still exist.
- **`npm test` runs the suite.** Single file: `npx vitest run <path>`. Baseline at plan start: **199 test files, 3002 tests, 0 failures.**

---

## File Structure

| File | Responsibility |
| --- | --- |
| `convex/schema.ts` (modify) | `funnelTransitions.by_contact` index; `contactNotes.outcomeClearedAt`. |
| `convex/contactActivity.ts` (create) | One query returning the merged, sorted feed. |
| `convex/contactNotes.ts` (modify) | `clearDoNotContact` stamps the originating note. |
| `src/lib/inbox/activity.ts` (create) | Pure: merge, sort, and label activity entries. |
| `src/components/inbox/contact-status-header.tsx` (create) | Assigned agent, stage, last contacted, next follow-up, do-not-contact strip. |
| `src/components/inbox/contact-key-facts.tsx` (create) | The custom-fields block, hoisted to the top. |
| `src/components/inbox/contact-activity.tsx` (create) | The feed, with a notes-only filter. |
| `src/components/inbox/contact-sidebar.tsx` (modify) | Shell: reorders sections, mounts the three components, loses its inline notes block. |
| `src/components/inbox/note-card.tsx` (modify) | Renders a cleared do-not-contact outcome honestly. |
| `src/app/(dashboard)/broadcasts/new/page.tsx` (modify) | Warns before sending, not only after. |

---

## Task 1: Activity backend — index, query, and the double-count decision

**Files:**
- Modify: `convex/schema.ts` (`funnelTransitions`, ~line 2029)
- Create: `convex/contactActivity.ts`
- Test: `convex/contactActivity.test.ts`

**Interfaces:**
- Consumes: `contactNotes` (Phase 1), `funnelTransitions`.
- Produces: `api.contactActivity.listForContact({ contactId }) => ActivityEntry[]`, newest first, where

```ts
type ActivityEntry =
  | { kind: "note"; at: number; note: <one row of contactNotes.listForContact> }
  | { kind: "stage"; at: number; stage: string; auto: boolean;
      author: { userId: string; fullName?: string; avatarUrl?: string } | null }
```

- [ ] **Step 1: Write the failing test**

Create `convex/contactActivity.test.ts`. Use `convex/contactNotes.test.ts`'s `seedAccountMember` helper as your model — copy it into this file (each `convex/*.test.ts` owns its copy; see that file's own comment).

```ts
test("listForContact merges notes and stage moves, newest first", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
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

  await asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Called him",
    kind: "call",
  });
  await t.run((ctx) =>
    ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "qualified",
      byUserId: userId,
      auto: false,
    }),
  );

  const feed = await asUser.query(api.contactActivity.listForContact, { contactId });

  expect(feed.map((e) => e.kind)).toEqual(["stage", "note"]);
  expect(feed[0].at).toBeGreaterThanOrEqual(feed[1].at);
});

// The double-count decision, pinned as a test so nobody "helpfully"
// adds deals/checklists back into the merge later.
test("a deal outcome appears ONCE — as the note funnel.ts already writes", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
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

  // Exactly what `funnel.ts` writes on a won deal: a terminal transition
  // AND its mirrored note.
  await t.run(async (ctx) => {
    await ctx.db.insert("funnelTransitions", {
      accountId,
      conversationId,
      contactId,
      stage: "purchased",
      byUserId: userId,
      auto: false,
    });
    await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      createdByUserId: userId,
      noteText: "🏆 Deal won — 5000 AED",
    });
  });

  const feed = await asUser.query(api.contactActivity.listForContact, { contactId });
  // The note renders it; the terminal transition must NOT also render it.
  expect(feed.filter((e) => e.kind === "stage")).toHaveLength(0);
  expect(feed.filter((e) => e.kind === "note")).toHaveLength(1);
});

test("listForContact rejects another account's contact as NOT_FOUND", async () => {
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
  const bobContact = await bob.asUser.mutation(api.contacts.create, { phone: "2" });

  await expect(
    alice.asUser.query(api.contactActivity.listForContact, { contactId: bobContact }),
  ).rejects.toThrow(/NOT_FOUND/);
});

test("a viewer can read the feed — reads have no role floor", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const contactId = await owner.asUser.mutation(api.contacts.create, { phone: "1" });

  const viewerId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Vic", email: "vic@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: viewerId,
      accountId: owner.accountId,
      role: "viewer",
      fullName: "Vic",
      email: "vic@example.com",
    }),
  );
  const asViewer = t.withIdentity({ subject: `${viewerId}|session-vic` });

  await expect(
    asViewer.query(api.contactActivity.listForContact, { contactId }),
  ).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/contactActivity.test.ts`
Expected: FAIL — `api.contactActivity` does not exist, and the `by_contact` index is missing.

- [ ] **Step 3: Add the index**

In `convex/schema.ts`, extend `funnelTransitions`'s index list (it currently has `by_conversation` and `by_account`):

```ts
    // The contact panel's activity feed is per-CONTACT, not per-conversation
    // — a contact can hold several threads and the panel shows the person's
    // whole history. `by_conversation` cannot answer that without reading
    // every conversation first.
    .index("by_contact", ["contactId"]),
```

- [ ] **Step 4: Write the query**

Create `convex/contactActivity.ts`:

```ts
import { accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// The contact panel's activity feed.
//
// DELIBERATELY NOT a five-source merge. The design spec called for
// merging notes + funnelTransitions + contactTags + salesChecklists +
// deals, but four of those already write a `contactNotes` row when they
// happen — `funnel.ts:318` (deal won/lost/reopened),
// `salesChecklists.ts:109` (item completed), `aiTagging.ts:471` (tag
// accepted), `qualificationEngine.ts:2221`. Merging them again renders
// the same event twice.
//
// So the feed is: every note, plus the ONE thing notes do not already
// capture — a non-terminal funnel stage move. `contactTags` is excluded
// on different grounds: a tag is current state, not an event, and the
// panel shows it in its own section.
// ============================================================

/** Stages whose transition ALREADY produces a note in `funnel.ts`.
 *  Including them here would double-render the deal outcome. */
const NOTE_MIRRORED_STAGES = new Set(["purchased", "lost"]);

async function requireOwnContact(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  contactId: Id<"contacts">,
) {
  const contact = await ctx.db.get(contactId);
  if (!contact || contact.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "contact" });
  }
  return contact;
}

export const listForContact = accountQuery({
  args: { contactId: v.id("contacts") },
  handler: async (ctx, args) => {
    await requireOwnContact(ctx, args.contactId);

    const [notes, transitions] = await Promise.all([
      ctx.db
        .query("contactNotes")
        .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
        .order("desc")
        .collect(),
      ctx.db
        .query("funnelTransitions")
        .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
        .order("desc")
        .collect(),
    ]);

    // Author resolution, cached per user for the whole call — a contact's
    // history is usually two or three people, so this is a handful of
    // reads rather than one per row.
    const cache = new Map<
      string,
      { userId: Id<"users">; fullName?: string; avatarUrl?: string } | null
    >();
    const resolve = async (userId: Id<"users">) => {
      const hit = cache.get(userId);
      if (hit !== undefined) return hit;
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_account", (q) =>
          q.eq("userId", userId).eq("accountId", ctx.accountId),
        )
        .first();
      const value = membership
        ? { userId, fullName: membership.fullName, avatarUrl: membership.avatarUrl }
        : null;
      cache.set(userId, value);
      return value;
    };

    const noteEntries = await Promise.all(
      notes.map(async (note) => ({
        kind: "note" as const,
        at: note._creationTime,
        note: {
          ...note,
          author: note.createdByUserId ? await resolve(note.createdByUserId) : null,
        },
      })),
    );

    const stageEntries = await Promise.all(
      transitions
        .filter((tr) => !NOTE_MIRRORED_STAGES.has(tr.stage))
        .map(async (tr) => ({
          kind: "stage" as const,
          at: tr._creationTime,
          stage: tr.stage,
          auto: tr.auto,
          author: tr.byUserId ? await resolve(tr.byUserId) : null,
        })),
    );

    return [...noteEntries, ...stageEntries].sort((a, b) => b.at - a.at);
  },
});
```

**Note on `by_user_account`:** that index exists on `memberships` and is the idiom this codebase settled on — `convex/notifications.ts` documents why scanning `by_user` and re-filtering in JS is wrong for a multi-account user. Use it.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run convex/contactActivity.test.ts` then `npm test`
Expected: PASS. A schema change touches every `convex-test` suite — a failure elsewhere means an existing row shape broke.

- [ ] **Step 6: Commit**

```bash
git status --short
git add convex/schema.ts convex/contactActivity.ts convex/contactActivity.test.ts
git commit -m "feat(contacts): one activity feed, without double-counting

The spec called for merging five sources, but four of them already write
a contactNotes row when they happen — merging again would render each
deal outcome and checklist step twice. The feed is every note plus the
one thing notes miss: a non-terminal stage move. Pinned by a test so it
does not get 'helpfully' re-merged later.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Pure activity formatting

**Files:**
- Create: `src/lib/inbox/activity.ts`
- Test: `src/lib/inbox/activity.test.ts`

**Interfaces:**
- Produces:
  - `type ActivityFilter = "all" | "notes"`
  - `filterActivity<T extends { kind: string }>(entries: T[], filter: ActivityFilter): T[]`
  - `stageI18nKey(stage: string): string`
  - `groupActivityByDay<T extends { at: number }>(entries: T[]): Array<{ day: string; entries: T[] }>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/inbox/activity.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { filterActivity, stageI18nKey, groupActivityByDay } from "./activity";

describe("filterActivity", () => {
  const entries = [
    { kind: "note", at: 3 },
    { kind: "stage", at: 2 },
    { kind: "note", at: 1 },
  ];

  test("'all' returns everything unchanged", () => {
    expect(filterActivity(entries, "all")).toEqual(entries);
  });

  test("'notes' keeps only notes, preserving order", () => {
    expect(filterActivity(entries, "notes").map((e) => e.at)).toEqual([3, 1]);
  });

  test("does not mutate its input", () => {
    const copy = [...entries];
    filterActivity(entries, "notes");
    expect(entries).toEqual(copy);
  });
});

describe("stageI18nKey", () => {
  test("namespaces the stage under `stage.`", () => {
    expect(stageI18nKey("qualified")).toBe("stage.qualified");
  });
});

describe("groupActivityByDay", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const base = Date.parse("2026-08-03T09:00:00Z");

  test("groups entries falling on the same UTC day", () => {
    const groups = groupActivityByDay([
      { at: base + 3600_000 },
      { at: base },
      { at: base - DAY },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].entries).toHaveLength(2);
    expect(groups[1].entries).toHaveLength(1);
  });

  test("preserves the newest-first order the query returned", () => {
    const groups = groupActivityByDay([
      { at: base + 7200_000 },
      { at: base + 3600_000 },
    ]);
    expect(groups[0].entries.map((e) => e.at)).toEqual([
      base + 7200_000,
      base + 3600_000,
    ]);
  });

  test("returns an empty array for no entries", () => {
    expect(groupActivityByDay([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/inbox/activity.test.ts`
Expected: FAIL — `Cannot find module './activity'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/inbox/activity.ts`:

```ts
// ============================================================
// Pure activity-feed logic. No React, no Convex — same shape as
// `src/lib/inbox/notes.ts`, so the branching is testable without a
// rendering harness.
// ============================================================

export type ActivityFilter = "all" | "notes";

/** Non-mutating. The query already returns newest-first; every helper
 *  here preserves that order rather than re-sorting, so the two cannot
 *  disagree about what "newest" means. */
export function filterActivity<T extends { kind: string }>(
  entries: T[],
  filter: ActivityFilter,
): T[] {
  if (filter === "all") return entries;
  return entries.filter((entry) => entry.kind === "note");
}

/** Key under the `Inbox.activity` namespace. */
export function stageI18nKey(stage: string): string {
  return `stage.${stage}`;
}

/** Buckets by UTC calendar day. UTC rather than local: the same feed is
 *  read by staff in Dubai and India, and a bucket that shifts with the
 *  reader's clock makes "which day did that happen" unanswerable. The
 *  day string is a plain `YYYY-MM-DD` for the component to format. */
export function groupActivityByDay<T extends { at: number }>(
  entries: T[],
): Array<{ day: string; entries: T[] }> {
  const groups: Array<{ day: string; entries: T[] }> = [];
  for (const entry of entries) {
    const day = new Date(entry.at).toISOString().slice(0, 10);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/inbox/activity.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/lib/inbox/activity.ts src/lib/inbox/activity.test.ts
git commit -m "feat(contacts): pure activity filtering and day grouping

Buckets by UTC day rather than the reader's local day — the same feed is
read from Dubai and India, and a bucket that moves with the clock makes
'which day did that happen' unanswerable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: The status header

**Files:**
- Create: `src/components/inbox/contact-status-header.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Produces: `<ContactStatusHeader contactId assignedName stage lastContactedAt nextFollowUpAt doNotContact canClear />`

- [ ] **Step 1: Read what the sidebar already has**

Run: `sed -n '100,180p' src/components/inbox/contact-sidebar.tsx` and `sed -n '355,405p' src/components/inbox/contact-sidebar.tsx`

The sidebar already queries `api.funnel.getState` for the current stage and renders a Funnel section. Determine what it already holds — assigned agent, last message time — and what genuinely needs a new source. **Do not add a query for something already in scope.** Report what you found and what you had to add.

`nextFollowUpAt` lives on `qualificationSessions`. If reaching it needs a new query, add a narrow one rather than widening an existing return; if it is not reachable without disproportionate work, render the header without it and say so in your report — the other four fields carry most of the value.

- [ ] **Step 2: Add the copy**

Add to `messages/en.json` under a new `Inbox.activity` block, sibling of `Inbox.notes`:

```json
    "activity": {
      "title": "Activity",
      "filterAll": "All",
      "filterNotes": "Notes only",
      "empty": "Nothing recorded yet.",
      "assignedTo": "Assigned to {name}",
      "unassigned": "Unassigned",
      "lastContacted": "Last contacted {when}",
      "neverContacted": "Not contacted yet",
      "nextFollowUp": "Follow up {when}",
      "autoStage": "automatically",
      "stageMoved": "Stage → {stage}",
      "stage": {
        "new_lead": "New lead",
        "qualified": "Qualified",
        "price_quoted": "Price quoted",
        "itinerary_created": "Itinerary created",
        "itinerary_sent": "Itinerary sent",
        "invoice_sent": "Invoice sent",
        "purchased": "Purchased",
        "lost": "Lost"
      }
    },
```

- [ ] **Step 3: Write the component**

Create `src/components/inbox/contact-status-header.tsx`. It is presentational — it takes resolved values as props and owns no queries, so the sidebar stays the single place that talks to Convex.

Requirements, in order of importance:
1. When `doNotContact` is set, the whole strip is **replaced** by the red banner — not accompanied by it. State that competes with a stop signal buries it. Reuse `DoNotContactBanner` from `./do-not-contact-banner` rather than writing a second one; pass `canClear` through.
2. Otherwise render a compact two-line strip: assigned agent and stage on one line, last-contacted and next-follow-up on the second, each omitted when absent.
3. Muted, small text (`text-xs` / `text-[11px]`), consistent with the sidebar's existing `SectionLabel` weight. This is orientation, not a headline.
4. No horizontal overflow at the sidebar's width — long agent names truncate.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`, `npx eslint src/components/inbox/contact-status-header.tsx`, `python3 -c "import json; json.load(open('messages/en.json'))"`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/components/inbox/contact-status-header.tsx messages/en.json
git commit -m "feat(contacts): status header for the contact panel

Reuses the do-not-contact banner and REPLACES the strip with it when the
flag is set — state that competes with a stop signal buries it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Key facts, hoisted

**Files:**
- Create: `src/components/inbox/contact-key-facts.tsx`
- Modify: `src/components/inbox/contact-sidebar.tsx` (custom-fields block, ~line 530)

**Interfaces:**
- Produces: `<ContactKeyFacts contactId />`

- [ ] **Step 1: Read the existing block**

Run: `sed -n '525,540p' src/components/inbox/contact-sidebar.tsx` and `sed -n '1,40p' src/components/inbox/contact-custom-fields.tsx`

The sidebar already renders `ContactCustomFields` under a `SectionLabel`. This task extracts that pairing into a named component and moves it up — it is not a rewrite of custom fields.

- [ ] **Step 2: Write the component**

Create `src/components/inbox/contact-key-facts.tsx` wrapping the existing `SectionLabel` + `ContactCustomFields` pairing. If `SectionLabel` is currently a private helper inside `contact-sidebar.tsx`, export it from there and import it here rather than duplicating it — two copies will drift.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx eslint src/components/inbox/contact-key-facts.tsx`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git status --short
git add src/components/inbox/contact-key-facts.tsx src/components/inbox/contact-sidebar.tsx
git commit -m "feat(contacts): extract key facts as its own component

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: The activity feed component

**Files:**
- Create: `src/components/inbox/contact-activity.tsx`

**Interfaces:**
- Consumes: `api.contactActivity.listForContact` (Task 1); `filterActivity`, `groupActivityByDay`, `stageI18nKey` (Task 2); `NoteCard` from `./note-card`.
- Produces: `<ContactActivity contactId canManageNote />`

- [ ] **Step 1: Write the component**

Create `src/components/inbox/contact-activity.tsx`:

- Query `api.contactActivity.listForContact`, `"skip"` when there is no `contactId`.
- A two-button filter row (All · Notes only) driven by `filterActivity`.
- Group with `groupActivityByDay` and render a small day heading per group.
- **Numbered, newest first** — the spec asks for 1..n. Number across the whole filtered list, not per day group, so the count means "how many things have happened".
- A note entry renders through the existing `NoteCard`. **Reuse it — do not write a second note renderer.** `NoteCard` requires `onDelete` and takes an optional `onEdit`; wire delete to `api.contactNotes.remove` following the pattern in `message-thread.tsx`, and omit `onEdit` so the Edit item stays hidden until an edit UI exists.
- A stage entry renders as a compact line: `Stage → Qualified`, the author's name or "automatically" when `auto` is true, and the time.
- Empty state uses `Inbox.activity.empty`.

`canManageNote` is computed by the parent exactly as `message-thread.tsx` does — `(!!note.createdByUserId && note.createdByUserId === user?.id) || hasMinRole(accountRole, "admin")` — so the UI never offers a delete the server will reject. Since that rule is per-note, take a predicate prop rather than a boolean: `canManageNote: (note: NoteRow) => boolean`.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx eslint src/components/inbox/contact-activity.tsx`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git status --short
git add src/components/inbox/contact-activity.tsx
git commit -m "feat(contacts): numbered activity feed with a notes-only filter

Renders notes through the existing NoteCard rather than a second
renderer, and gates delete per note with the same rule the server
enforces, so the UI never offers an action that will fail.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Restructure the sidebar

**Files:**
- Modify: `src/components/inbox/contact-sidebar.tsx` (704 lines)

**Interfaces:**
- Consumes: Tasks 3, 4, 5.

- [ ] **Step 1: Read the whole file first**

Run: `sed -n '280,600p' src/components/inbox/contact-sidebar.tsx`

Current section order is: Contact · Acquisition · Funnel · Location · Travel · About · Labels · Custom fields · Deals · Notes.

Target order:
1. **Status header** (Task 3)
2. **Key facts** (Task 4)
3. **Activity** (Task 5)
4. Contact · Acquisition · Funnel · Location · Travel · About · Labels · Deals — unchanged, in their current relative order

- [ ] **Step 2: Make the change**

- Mount the three new components at the top.
- **Delete the inline notes block** (`SectionLabel` + textarea + `handleAddNote` + the notes list, ~lines 580-615) and every state/handler that only served it (`newNote`, `addingNote`, `handleAddNote`, the `api.contactNotes.listForContact` query, and the `toUiContactNote` import if it becomes unused). Activity replaces it. Leaving both means two places to add a note that look different.
- Move the custom-fields block out; the `SectionLabel` there now lives in `ContactKeyFacts`.
- Everything else keeps its current markup and handlers exactly.

**Do not change what any surviving control does.** This task moves and deletes; it does not rewrite behaviour.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`, `npx eslint src/components/inbox/contact-sidebar.tsx`, `npm test`
Expected: clean, 3002+ tests passing. `tsc` is what catches a handler you removed but still reference.

- [ ] **Step 4: Report the line count**

Run: `wc -l src/components/inbox/contact-sidebar.tsx`

Report before and after. If it did not drop meaningfully below 704, say why — that is a signal the extraction did not actually move responsibility out.

- [ ] **Step 5: Commit**

```bash
git status --short
git add src/components/inbox/contact-sidebar.tsx
git commit -m "feat(contacts): reorder the panel around current state first

Status, then the facts you need next, then everything that happened.
Deletes the inline notes block — Activity replaces it, and two places to
add a note that look different is worse than one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: A cleared do-not-contact note must not still claim it

**Files:**
- Modify: `convex/schema.ts` (`contactNotes`), `convex/contactNotes.ts` (`clearDoNotContact`), `src/components/inbox/note-card.tsx`, `messages/en.json`
- Test: `convex/contactNotes.test.ts`

**The problem.** `clearDoNotContact` lifts `contacts.doNotContact`, and `update` refuses to change an outcome that is `do_not_contact` — so the originating note keeps saying "Do not contact" forever, permanently uncorrectable, even after a supervisor overrode it. Automation resumes correctly; the card lies.

**The fix is additive, not a rewrite.** The outcome stays — it is the audit trail of what the customer said. A new timestamp records that it was later cleared, and the card renders both facts.

- [ ] **Step 1: Write the failing test**

```ts
test("clearDoNotContact stamps the originating note as cleared", async () => {
  const t = convexTest(schema, modules);
  const agent = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await agent.asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await agent.asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Never contact",
    outcome: "do_not_contact",
  });

  const supId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: supId,
      accountId: agent.accountId,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    }),
  );
  const asSup = t.withIdentity({ subject: `${supId}|session-sam` });

  await asSup.mutation(api.contactNotes.clearDoNotContact, { contactId });

  const row = await t.run((ctx) => ctx.db.get(noteId));
  // The outcome SURVIVES — it records what the customer actually said.
  expect(row!.outcome).toBe("do_not_contact");
  // …and the note now also records that it was overridden.
  expect(row!.outcomeClearedAt).toBeGreaterThan(0);
});

test("clearing is safe when the originating note was already deleted", async () => {
  const t = convexTest(schema, modules);
  const agent = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const contactId = await agent.asUser.mutation(api.contacts.create, { phone: "1" });
  const noteId = await agent.asUser.mutation(api.contactNotes.add, {
    contactId,
    body: "Never contact",
    outcome: "do_not_contact",
  });
  await agent.asUser.mutation(api.contactNotes.remove, { noteId });

  const supId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sam", email: "sam@example.com" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: supId,
      accountId: agent.accountId,
      role: "supervisor",
      fullName: "Sam",
      email: "sam@example.com",
    }),
  );
  const asSup = t.withIdentity({ subject: `${supId}|session-sam` });

  // The flag deliberately outlives its note (Phase 1) — clearing must
  // still work rather than throwing on the dangling id.
  await asSup.mutation(api.contactNotes.clearDoNotContact, { contactId });
  const contact = await t.run((ctx) => ctx.db.get(contactId));
  expect(contact!.doNotContact).toBeUndefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/contactNotes.test.ts`
Expected: FAIL — `outcomeClearedAt` is not a schema field.

- [ ] **Step 3: Add the field**

In `convex/schema.ts`'s `contactNotes`, beside `editedAt`:

```ts
    // Set by `clearDoNotContact` on the note that raised the flag. The
    // `outcome` itself is NEVER erased — it records what the customer
    // actually said, and `update` still refuses to change it. This
    // records that a supervisor later overrode it, so the card can show
    // both facts instead of claiming a block that is no longer in force.
    outcomeClearedAt: v.optional(v.number()),
```

- [ ] **Step 4: Stamp it**

In `clearDoNotContact`, after loading the contact and before clearing, patch the originating note — guarding for the case where it was deleted (Phase 1 made the flag deliberately outlive its note):

```ts
    const origin = await ctx.db.get(contact.doNotContact.noteId);
    if (origin && origin.accountId === ctx.accountId) {
      await ctx.db.patch(origin._id, { outcomeClearedAt: Date.now() });
    }
```

- [ ] **Step 5: Render it**

In `note-card.tsx`, when `note.outcomeClearedAt` is set and the outcome is `do_not_contact`: render the card in the neutral (amber) tone rather than destructive, and show the outcome chip struck through with a `cleared` label beside it. Add `"cleared": "cleared"` to the `Inbox.notes` block.

The card must not read as an active block once it is not one.

- [ ] **Step 6: Verify**

Run: `npx vitest run convex/contactNotes.test.ts`, `npx tsc --noEmit`, `npx eslint src/components/inbox/note-card.tsx`, `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git status --short
git add convex/schema.ts convex/contactNotes.ts convex/contactNotes.test.ts src/components/inbox/note-card.tsx messages/en.json
git commit -m "fix(notes): a cleared do-not-contact note stops claiming a block

The outcome survives — it records what the customer said, and update
still refuses to change it. A new timestamp records the supervisor's
override so the card shows both facts instead of a block that is no
longer in force.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Warn before the broadcast, not only after

**Files:**
- Modify: `src/app/(dashboard)/broadcasts/new/page.tsx`, `messages/en.json`

**The problem.** Phase 3 makes `broadcasts.create` drop do-not-contact recipients and report a count, surfaced as a toast **after** sending. A sender who picked 200 contacts and reached 197 learns why only once it is too late to reconsider.

**This should need no backend work.** Phase 3 added `do_not_contact` to `toUiContact` and the `Contact` type, so the recipient picker already has the flag on every contact it renders.

- [ ] **Step 1: Confirm the data is already there**

Run: `grep -n "do_not_contact" src/types/index.ts src/lib/convex/adapters.ts` and read how `broadcasts/new/page.tsx` loads and selects its audience.

If the picker's contacts do NOT flow through `toUiContact`, stop and report — a backend change would then be needed and that changes this task's shape.

- [ ] **Step 2: Add the copy**

Add to the broadcasts namespace (find the real one; do not guess):

```json
      "willSkipDoNotContact": "{count, plural, one {# selected contact is marked do not contact and will be skipped} other {# selected contacts are marked do not contact and will be skipped}}",
```

- [ ] **Step 3: Show it**

Render the line beside the recipient count, before the send control, whenever the selection contains at least one flagged contact. Muted and informational, not an error — it is not blocking anything, and the send is still correct.

Keep the existing post-send toast: the pre-send line is what the sender plans against, the toast is what actually happened, and they can legitimately differ if someone is flagged in between.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`, `npx eslint` on the touched file, `python3 -c "import json; json.load(open('messages/en.json'))"`, `npm test`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git status --short
git add "src/app/(dashboard)/broadcasts/new/page.tsx" messages/en.json
git commit -m "feat(broadcasts): say who will be skipped before sending

The post-send toast told a sender their 200-person broadcast reached 197
only once it was too late to reconsider. No backend change needed — the
flag already reaches the picker through toUiContact.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Browser verification — required before merge

Phases 1 and 3 both shipped without a browser, and Phase 1's one Critical (a floating button that scrolled out of view) was that class of bug. This phase is almost entirely visual, so a preview check is not optional.

Verify on the PR's Netlify preview, or in the main checkout:

1. The panel reads top to bottom: status → key facts → activity → the rest.
2. A contact with a do-not-contact flag shows the red banner **instead of** the status strip, and Clear works for a supervisor.
3. Activity is numbered newest-first, the Notes-only filter works, and day headings are right.
4. Deleting your own note from Activity works; someone else's note offers no Delete.
5. The old notes textarea is **gone** — exactly one place to add a note.
6. A cleared do-not-contact note no longer reads as an active block.
7. The broadcast picker shows the skip warning before you press send.

---

## Self-Review

**Spec coverage.** Status header → Task 3. Key facts moved up → Task 4. Merged activity feed → Tasks 1, 2, 5 (with the double-count correction documented and test-pinned). Sidebar split into components → Tasks 3-6. Tags and Deals staying below → Task 6.

**Deferred items now closed:** the `clearDoNotContact` stale-note inconsistency (Task 7) and the broadcast recipient-picker gap the Phase 3 review raised (Task 8).

**Deliberately NOT in this plan — needs its own:** signed URLs and R2 garbage collection for note attachments. The owner deferred it "to Phase 2", but it is a different subsystem with a different risk profile: it means writing a `presignGet` (only `presignPut` exists in `convex/lib/r2/client.ts`), a Convex query to mint short-lived URLs, changing `note-card.tsx` from a static `mediaUrlFromKey` to an async resolve, and deleting R2 objects on note delete and on abandoned composer drafts. Mixing that into a UI-restructuring plan would make both harder to review. It should be its own plan, and it is not forgotten.

**Type consistency.** `ActivityEntry`'s discriminant is `kind` in Task 1's query, Task 2's `filterActivity`, and Task 5's rendering. `ActivityFilter` is declared once (Task 2). `NoteCard`'s existing props (`note`, `canManage`, required `onDelete`, optional `onEdit`) are used unchanged in Task 5.

**Known risk.** Task 6 deletes working UI (the inline notes block). If Task 5's Activity feed has a defect, an agent temporarily has no way to add a note from the sidebar — though the thread's floating composer still works, so notes are never unreachable. Task 6 runs after Task 5 for exactly this reason.
