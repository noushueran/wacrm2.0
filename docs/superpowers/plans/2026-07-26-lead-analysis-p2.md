# Lead Analysis P2 — Archive & Un-archive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a supervisor archive a dead lead so it leaves the active Inbox, and bring it back automatically the moment the customer replies.

**Architecture:** `conversations.archivedAt` is the system of record; a denormalised `leadAnalyses.archived` mirrors it so the board's read stays bounded. Archive/restore write both rows in one transactional mutation, so they cannot drift. The Inbox excludes archived rows through two new indexes rather than a post-scan filter. Un-archive runs from `ingest` on its own ungated path — it must work even when Lead Analysis is switched off.

**Tech Stack:** Convex (queries/mutations/internal mutations), TypeScript, Vitest + convex-test, Next.js App Router, next-intl, shadcn/ui, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-26-lead-analysis-design.md` (the "Changes to `conversations`" and "Stopping and returning" sections)
**Predecessor:** `docs/superpowers/plans/2026-07-26-lead-analysis-p1.md` — shipped on branch `feat/lead-analysis-clean`.

## Global Constraints

- **Never run `convex deploy`, `convex dev`, or `convex codegen`.** Self-hosted production; the owner deploys. Schema edits are committed only.
- **`convex/_generated/api.d.ts` is edited BY HAND** (owner-approved 2026-07-26), because codegen is forbidden. Two alphabetically-sorted lists: an import block and the `fullApi` map. Task 1 adds the one new lib module. Do not reorder or reformat anything else.
- **P2 still sends NO WhatsApp messages.** No template, no free-form, no scheduler call that leads to one. The follow-up sequence is P3. `leadAnalyses.sequenceStatus` still never leaves `"idle"`.
- **Archiving in P2 is MANUAL ONLY.** Nothing archives a conversation automatically — that is P3, driven by the sequence.
- **Un-archive is UNCONDITIONAL.** It must not be gated on `leadAnalysisConfigs.enabled`, on the feature being configured, or on a `leadAnalyses` row existing. A customer reply always restores the thread.
- **No unbounded reads.** Every query is an index range with an explicit `.take()` or `.paginate()`. Never `.filter()` across a partition that grows forever — see the index comments in `convex/schema.ts`.
- **Tenancy:** every handler uses `ctx.accountId` from `accountQuery`/`accountMutation`, never a client-supplied account id.
- **Verify commands:** `npm test` (full suite), `npx vitest run <path>` (one file), `npm run typecheck`, `npx eslint <path>`. This repo has pre-existing lint debt — `npm run lint` over the whole tree is NOT the gate.
- **No jsdom, no Testing Library.** Component tests use `renderToStaticMarkup` plus string assertions. Because that lacks single-match uniqueness enforcement, **every assertion must be scoped to a `data-testid`** — assert on a string the component also renders unconditionally and the test is vacuous. Three such traps were found in P1.
- **Git:** stage paths explicitly (`git add <path>`), never `git add -A`. Concurrent sessions share this repository.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Baseline on `feat/lead-analysis-clean`:** 2394 tests passing across 179 files, `npm run typecheck` clean.

## Two design decisions that drive this plan

### `archived` is denormalised onto `leadAnalyses`

The board reads `leadAnalyses` by `by_account_score` and takes 400. If archived rows were filtered out *after* that read, the board would degrade continuously: archiving is a one-way accumulation, so over months most rows are archived, and the query would read a mostly-archived page to surface a shrinking set of active leads — the exact unbounded-scan shape `convex/schema.ts` documents for `broadcastRecipients` and `conversionEvents`.

So `leadAnalyses` gains `archived: v.optional(v.boolean())` plus `by_account_archived_score`. `conversations.archivedAt` remains the system of record and the only thing the Inbox reads; the boolean is a read-optimisation mirror.

**The sync invariant:** `archive` and `restore` are the ONLY writers of either field, and each patches both rows inside one mutation. Convex mutations are transactional, so the two cannot commit apart. Any future writer must uphold this — say so in the schema comment.

### Un-archive lives in `conversations.ts`, not the Lead Analysis engine

`leadAnalysisEngine.onInbound` returns early when `leadAnalysisConfigs.enabled` is false. Putting un-archive there would mean that switching Lead Analysis off strands every already-archived conversation out of the Inbox permanently, with no way back. Un-archive therefore gets its own internal mutation in `convex/conversations.ts`, called from `ingest` on every inbound, gated on nothing.

## File Structure

**Create:**

| File | Responsibility |
|---|---|
| `convex/lib/leadAnalysis/archive.ts` | pure: the archive-reason vocabulary and its validation |
| `convex/lib/leadAnalysis/archive.test.ts` | its unit tests |

**Modify:**

| File | Change |
|---|---|
| `convex/schema.ts` | `conversations` archive fields + 2 indexes; `leadAnalyses.archived` + 1 index; `notifications.type` += `"lead_returned"` |
| `convex/_generated/api.d.ts` | register `lib/leadAnalysis/archive` (by hand) |
| `convex/leadAnalysis.ts` | `archive` / `restore` mutations; `board` gains a `view` arg |
| `convex/conversations.ts` | `list` gains `archived`; both indexable plans re-pointed; `unarchiveOnInbound` internal mutation |
| `convex/notifications.ts` | `insertNotification`'s type union += `"lead_returned"` |
| `convex/dashboard.ts` | `metrics` stops counting archived conversations as open |
| `convex/ingest.ts` | one `runBestEffort` call to `unarchiveOnInbound` |
| `src/components/lead-analysis/lead-analysis-board.tsx` | Archive/Restore actions, Active/Archived view toggle |
| `src/app/(dashboard)/lead-analysis/page.tsx` | wire the two mutations and the view state |
| `src/app/(dashboard)/inbox/page.tsx` | Archived tab |
| `src/components/inbox/conversation-list.tsx` | pass the archived flag through |
| `messages/en.json` | new strings |

**Coordination note:** `convex/conversations.ts`, `src/app/(dashboard)/inbox/page.tsx`, and `src/components/inbox/conversation-list.tsx` had uncommitted work from a concurrent session as of 2026-07-26. Re-check `git status` before starting Tasks 5 and 9, and rebase onto whatever landed rather than assuming this plan's line references still hold.

---

### Task 1: Archive reasons (pure)

**Files:**
- Create: `convex/lib/leadAnalysis/archive.ts`
- Create: `convex/lib/leadAnalysis/archive.test.ts`
- Modify: `convex/_generated/api.d.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ARCHIVE_REASONS: readonly ["manual", "no_response", "aged_out", "not_a_lead"]`; `type ArchiveReason`; `isArchiveReason(v: unknown): v is ArchiveReason`; `ARCHIVE_REASON_MAX_NOTE: 200`; `normalizeArchiveNote(raw: unknown): string | undefined`.

- [ ] **Step 1: Write the failing test**

Create `convex/lib/leadAnalysis/archive.test.ts`:

```ts
import { expect, test } from "vitest";
import {
  ARCHIVE_REASONS,
  isArchiveReason,
  normalizeArchiveNote,
  ARCHIVE_REASON_MAX_NOTE,
} from "./archive";

test("the vocabulary is exactly the four supported reasons", () => {
  expect([...ARCHIVE_REASONS]).toEqual([
    "manual",
    "no_response",
    "aged_out",
    "not_a_lead",
  ]);
});

test("isArchiveReason accepts every member of the vocabulary", () => {
  for (const r of ARCHIVE_REASONS) expect(isArchiveReason(r)).toBe(true);
});

test("isArchiveReason rejects anything outside it", () => {
  expect(isArchiveReason("spam")).toBe(false);
  expect(isArchiveReason("")).toBe(false);
  expect(isArchiveReason(null)).toBe(false);
  expect(isArchiveReason(undefined)).toBe(false);
  expect(isArchiveReason(7)).toBe(false);
  expect(isArchiveReason({ reason: "manual" })).toBe(false);
});

test("normalizeArchiveNote trims and keeps real text", () => {
  expect(normalizeArchiveNote("  went quiet  ")).toBe("went quiet");
});

test("normalizeArchiveNote returns undefined for empty or non-string input", () => {
  expect(normalizeArchiveNote("")).toBeUndefined();
  expect(normalizeArchiveNote("   ")).toBeUndefined();
  expect(normalizeArchiveNote(undefined)).toBeUndefined();
  expect(normalizeArchiveNote(null)).toBeUndefined();
  expect(normalizeArchiveNote(42)).toBeUndefined();
});

test("normalizeArchiveNote truncates an overlong note", () => {
  const note = normalizeArchiveNote("x".repeat(500));
  expect(note!.length).toBe(ARCHIVE_REASON_MAX_NOTE);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/lib/leadAnalysis/archive.test.ts`
Expected: FAIL — `Failed to resolve import "./archive"`.

- [ ] **Step 3: Implement `archive.ts`**

Create `convex/lib/leadAnalysis/archive.ts`:

```ts
// ============================================================
// Archive vocabulary. Pure — no I/O, no Date.now().
//
// `archivedReason` is stored as a plain string on `conversations` (the
// schema keeps it a `v.optional(v.string())` so a future reason is a
// code change rather than a schema migration, exactly as
// `apiKeys.scopes` and `automations.triggerType` are handled). That
// makes THIS module the actual enforcement point, so validation lives
// here and every writer routes through it.
// ============================================================

export const ARCHIVE_REASONS = [
  /** A human archived it by hand (P2's only path). */
  "manual",
  /** The follow-up sequence exhausted its steps (P3). */
  "no_response",
  /** Older than `agedOutDays` and never scored (P3). */
  "aged_out",
  /** Not a sales conversation at all. */
  "not_a_lead",
] as const;

export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export const ARCHIVE_REASON_MAX_NOTE = 200;

export function isArchiveReason(value: unknown): value is ArchiveReason {
  return (
    typeof value === "string" &&
    (ARCHIVE_REASONS as readonly string[]).includes(value)
  );
}

/**
 * Optional free-text note attached to a manual archive. Trimmed,
 * truncated, and collapsed to `undefined` when empty — so an empty
 * textarea never persists as `""`.
 */
export function normalizeArchiveNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, ARCHIVE_REASON_MAX_NOTE);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/lib/leadAnalysis/archive.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Register the module in the generated API types**

`convex/_generated/api.d.ts` is TRACKED IN GIT and hand-edited because codegen is forbidden here.

In the **import block**, between `import type * as lib_kb_types …` and `import type * as lib_leadAnalysis_bands …`, insert:

```ts
import type * as lib_leadAnalysis_archive from "../lib/leadAnalysis/archive.js";
```

In the **`fullApi` map**, between `"lib/kb/types": typeof lib_kb_types;` and `"lib/leadAnalysis/bands": typeof lib_leadAnalysis_bands;`, insert:

```ts
  "lib/leadAnalysis/archive": typeof lib_leadAnalysis_archive;
```

(`archive` sorts before `bands`.) Insert only — do not reorder anything else.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add convex/lib/leadAnalysis/archive.ts convex/lib/leadAnalysis/archive.test.ts convex/_generated/api.d.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): archive reason vocabulary

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Schema — archive fields, indexes, notification type

**Files:**
- Modify: `convex/schema.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `conversations.archivedAt/archivedReason/archivedByUserId/returnedAt`; indexes `by_account_archived_last_message`, `by_account_archived_assigned_last_message`; `leadAnalyses.archived` + `by_account_archived_score`; `notifications.type` literal `"lead_returned"`.

- [ ] **Step 1: Add the `conversations` fields**

In `convex/schema.ts`, inside the `conversations` table definition, after the `funnel` object field and before the closing `})`, add:

```ts
    // ---- Archive (spec 2026-07-26 §"Changes to conversations") ----
    // `archivedAt` is the SYSTEM OF RECORD for archived state and the
    // only thing the Inbox reads. Presence = archived.
    //
    // A TIMESTAMP rather than a fourth `status` literal, deliberately:
    // `conversations.list` applies `status` as a post-index `.filter()`,
    // which is safe today only because almost every row is "open" (the
    // predicate matches early and often). Archived rows accumulate
    // FOREVER, so as a filter they would make the Inbox scan grow
    // without bound — the failure this file documents for
    // `broadcastRecipients`, `conversionEvents` and `campaignAds`.
    // Convex sorts a missing field before every present value, so
    // `eq("archivedAt", undefined)` is one genuine index range over
    // exactly the active set.
    archivedAt: v.optional(v.number()),
    // One of `lib/leadAnalysis/archive.ts`'s ARCHIVE_REASONS, plus an
    // optional human note. Kept a plain string (not a union) so a new
    // reason is a code change, not a schema migration — that module is
    // the enforcement point.
    archivedReason: v.optional(v.string()),
    archivedNote: v.optional(v.string()),
    // Absent = archived by automation (P3). Set for a manual archive.
    archivedByUserId: v.optional(v.id("users")),
    // When the customer last brought this thread BACK by replying. Drives
    // the board's "returned" flag; never cleared.
    returnedAt: v.optional(v.number()),
```

- [ ] **Step 2: Add the two `conversations` indexes**

Immediately after the existing `.index("by_account_assigned_last_message", [...])`, add:

```ts
    // The Inbox's active list. `archivedAt` sits between `accountId` and
    // `lastMessageAt` so `eq(accountId).eq(archivedAt, undefined)` is a
    // real single range over the active set, still ordered by recency.
    // The Archived tab uses the complementary `gt("archivedAt", 0)`
    // range on this same index — which orders by `archivedAt`, i.e.
    // most-recently-archived first. That is a deliberate semantic
    // difference from the active tab's recency ordering, and the right
    // one for a review queue.
    .index("by_account_archived_last_message", [
      "accountId",
      "archivedAt",
      "lastMessageAt",
    ])
    // Same, for the single-assignee plan (the Mine / Unassigned tabs).
    // Two indexes rather than one because `conversations.list` has two
    // distinct indexable plans: "any" needs global recency order, and
    // "eq" binds the assignee first. A four-key index cannot serve both.
    .index("by_account_archived_assigned_last_message", [
      "accountId",
      "archivedAt",
      "assignedToUserId",
      "lastMessageAt",
    ])
    // `dashboard.metrics`' open-conversation tile. `by_account_status`
    // alone counts archived threads as open, and that error only grows,
    // because archiving accumulates. The archive dimension has to be in
    // the INDEX rather than a JS filter: that query's whole read-bound
    // argument is "every document in this range is a match, so there is
    // no `.filter()` to starve" — a post-take filter would both break
    // that property and silently under-report, since the take would fill
    // with archived rows.
    .index("by_account_archived_status", ["accountId", "archivedAt", "status"]),
```

Note: the previous index entry's trailing `,` becomes the separator; the final entry keeps the `,` before the closing `,` of the table. Match the file's existing punctuation exactly.

- [ ] **Step 3: Add `leadAnalyses.archived` and its index**

In the `leadAnalyses` table, after `contactId` and before the `// --- scoring ---` comment, add:

```ts
    // DENORMALISED mirror of `conversations.archivedAt` (presence →
    // true). `conversations.archivedAt` stays the system of record; this
    // exists purely so the board's read stays bounded.
    //
    // Without it, the board would read `by_account_score` and drop
    // archived rows afterwards. Archiving only ever accumulates, so over
    // time the query would read a mostly-archived page to surface a
    // shrinking active set — the same unbounded shape this file warns
    // about elsewhere.
    //
    // REPRESENTATION (load-bearing): archived rows hold `true`; active
    // rows hold `undefined` — restore CLEARS the field rather than
    // writing `false`. That is what makes `eq("archived", undefined)` an
    // exact range over the active set. Writing `false` instead would
    // split active rows across two index values and force the active
    // view to read past archived rows to find them, which is the
    // starvation this denormalisation exists to prevent.
    //
    // SYNC INVARIANT: `leadAnalysis.archive`, `leadAnalysis.restore` and
    // `conversations.unarchiveOnInbound` are the ONLY writers of this
    // field or of `conversations.archivedAt`, and each patches BOTH rows
    // in one mutation. Convex mutations are transactional, so the two
    // cannot commit apart. Any future writer must uphold this.
    archived: v.optional(v.boolean()),
```

And after the existing `.index("by_account_score", ["accountId", "score"])`, add:

```ts
    // The board's read, partitioned by archive state. Convex sorts a
    // missing field before every present value, so
    // `eq("archived", undefined)` and `eq("archived", true)` are two
    // disjoint, exact ranges. Pre-archive rows (written before this
    // field existed) hold `undefined` and so correctly land in the
    // active partition with no backfill.
    .index("by_account_archived_score", ["accountId", "archived", "score"])
```

- [ ] **Step 4: Widen the notification type union**

In the `notifications` table, add to the `type` union after `v.literal("purchase_signal")`:

```ts
      // An archived conversation came back — the customer replied
      // (spec 2026-07-26 §"Stopping and returning").
      v.literal("lead_returned"),
```

- [ ] **Step 5: Verify the schema change is additive**

Run: `npx vitest run convex/schema.test.ts`
Expected: PASS. Every change is a new optional field, a new index, or a widened union — all of which validate against existing documents.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, 2394 across 179 files (unchanged — nothing reads the new fields yet).

- [ ] **Step 7: Commit**

```bash
git add convex/schema.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): archive schema — conversation fields, indexes, lead_returned

archivedAt is a timestamp rather than a status literal so the Inbox can
exclude archived rows with an index range instead of a filter over a
partition that only ever grows. leadAnalyses.archived is a denormalised
mirror kept transactionally in sync so the board's read stays bounded.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `archive` and `restore` mutations

**Files:**
- Modify: `convex/leadAnalysis.ts`
- Modify: `convex/leadAnalysis.test.ts`

**Interfaces:**
- Consumes: `isArchiveReason`, `normalizeArchiveNote` (Task 1); the schema fields (Task 2).
- Produces: `api.leadAnalysis.archive({ conversationId, reason?, note? })`; `api.leadAnalysis.restore({ conversationId })`.

- [ ] **Step 1: Write the failing tests**

Append to `convex/leadAnalysis.test.ts` (reuse the file's existing `seedAccountMember` and `seedScoredLead` helpers):

```ts
test("archive stamps the conversation and mirrors onto the analysis row", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });

  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
    note: "  went quiet  ",
  });

  const conversation = await t.run((ctx) => ctx.db.get(lead.conversationId));
  expect(conversation!.archivedAt).toBeDefined();
  expect(conversation!.archivedReason).toBe("manual");
  expect(conversation!.archivedNote).toBe("went quiet");
  expect(conversation!.archivedByUserId).toBe(userId);
  // Archiving declares the thread dealt with, so the unread badge clears.
  expect(conversation!.unreadCount).toBe(0);

  const analysis = await t.run((ctx) => ctx.db.get(lead.analysisId));
  expect(analysis!.archived).toBe(true);
});

test("archive rejects a reason outside the vocabulary", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });

  await expect(
    asUser.mutation(api.leadAnalysis.archive, {
      conversationId: lead.conversationId,
      reason: "because_i_said_so",
    }),
  ).rejects.toThrow();
});

test("archive works on a conversation with no analysis row", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });
  await t.run((ctx) => ctx.db.delete(lead.analysisId));

  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });

  const conversation = await t.run((ctx) => ctx.db.get(lead.conversationId));
  expect(conversation!.archivedAt).toBeDefined();
});

test("archive is idempotent — re-archiving does not move the timestamp", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });

  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });
  const first = (await t.run((ctx) => ctx.db.get(lead.conversationId)))!.archivedAt;
  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });
  const second = (await t.run((ctx) => ctx.db.get(lead.conversationId)))!.archivedAt;

  expect(second).toBe(first);
});

test("restore clears both rows", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 4 });
  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });

  await asUser.mutation(api.leadAnalysis.restore, {
    conversationId: lead.conversationId,
  });

  const conversation = await t.run((ctx) => ctx.db.get(lead.conversationId));
  expect(conversation!.archivedAt).toBeUndefined();
  expect(conversation!.archivedReason).toBeUndefined();
  expect(conversation!.archivedNote).toBeUndefined();
  expect(conversation!.archivedByUserId).toBeUndefined();

  // Cleared, not `false` — the active board view ranges on `undefined`.
  const analysis = await t.run((ctx) => ctx.db.get(lead.analysisId));
  expect(analysis!.archived).toBeUndefined();
});

test("an agent cannot archive", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "O", email: "o@x.com", role: "owner",
  });
  const agent = await seedAccountMember(t, {
    name: "A", email: "a@x.com", role: "agent",
  });
  const lead = await seedScoredLead(t, owner.accountId, { score: 4 });

  await expect(
    agent.asUser.mutation(api.leadAnalysis.archive, {
      conversationId: lead.conversationId,
    }),
  ).rejects.toThrow();
});

test("archive cannot reach another account's conversation", async () => {
  const t = convexTest(schema, modules);
  const a = await seedAccountMember(t, { name: "A", email: "a@x.com", role: "owner" });
  const b = await seedAccountMember(t, { name: "B", email: "b@x.com", role: "owner" });
  const lead = await seedScoredLead(t, b.accountId, { score: 4 });

  await expect(
    a.asUser.mutation(api.leadAnalysis.archive, {
      conversationId: lead.conversationId,
    }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: FAIL — `archive is not a function`.

- [ ] **Step 3: Implement the mutations**

Append to `convex/leadAnalysis.ts`, extending its imports with:

```ts
import {
  isArchiveReason,
  normalizeArchiveNote,
} from "./lib/leadAnalysis/archive";
```

Then:

```ts
// ============================================================
// Archive / restore (spec 2026-07-26 §"Changes to conversations").
//
// Supervisor+ only: archiving removes a thread from every agent's
// Inbox, so it is a queue-management act, not per-lead work.
//
// Each mutation patches BOTH `conversations` and the mirrored
// `leadAnalyses.archived` — see the sync invariant in schema.ts. They
// are the only writers of either field.
//
// P2 NOTE: nothing here archives automatically. The sequence-driven
// auto-archive is P3.
// ============================================================

/** The conversation, checked for tenancy. Shared by both mutations.
 *  Type the `ctx` parameter from the project's own mutation-ctx type
 *  (see how `convex/qualification.ts` types its shared helpers) — do
 *  NOT introduce `any`. */
async function requireOwnConversation(
  ctx: { db: MutationCtx["db"]; accountId: Id<"accounts"> },
  conversationId: Id<"conversations">,
) {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", reason: "conversation" });
  }
  return conversation;
}

export const archive = accountMutation({
  args: {
    conversationId: v.id("conversations"),
    reason: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const conversation = await requireOwnConversation(ctx, args.conversationId);

    const reason = args.reason ?? "manual";
    if (!isArchiveReason(reason)) {
      throw new ConvexError({ code: "BAD_REQUEST", reason: "unknown_archive_reason" });
    }

    // Idempotent: re-archiving an archived thread must not move the
    // timestamp, or a double-click would reorder the Archived tab.
    if (conversation.archivedAt === undefined) {
      await ctx.db.patch(args.conversationId, {
        archivedAt: Date.now(),
        archivedReason: reason,
        archivedNote: normalizeArchiveNote(args.note),
        archivedByUserId: ctx.userId,
        // Archiving declares the thread dealt with. Clearing the unread
        // count keeps the app-wide sidebar badge honest without needing
        // an archive-aware variant of the `by_account_unread` index.
        unreadCount: 0,
      });
    }

    const analysis = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    // A conversation the backfill has not reached yet has no row; the
    // conversation is still the system of record, so this is not an error.
    if (analysis) await ctx.db.patch(analysis._id, { archived: true });

    return args.conversationId;
  },
});

export const restore = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    await requireOwnConversation(ctx, args.conversationId);

    await ctx.db.patch(args.conversationId, {
      archivedAt: undefined,
      archivedReason: undefined,
      archivedNote: undefined,
      archivedByUserId: undefined,
    });

    const analysis = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    // CLEARED, not `false` — see the representation note in schema.ts.
    if (analysis) await ctx.db.patch(analysis._id, { archived: undefined });

    return args.conversationId;
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: PASS, 26 tests (19 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add convex/leadAnalysis.ts convex/leadAnalysis.test.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): archive and restore mutations

Supervisor+ only. Each patches the conversation and its mirrored
leadAnalyses.archived in one transaction, so the two cannot drift.
Archiving clears unreadCount so the sidebar badge stays honest.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Un-archive on inbound + `lead_returned` notification

**Files:**
- Modify: `convex/notifications.ts`
- Modify: `convex/conversations.ts`
- Modify: `convex/conversations.test.ts`
- Modify: `convex/ingest.ts`

**Interfaces:**
- Consumes: the schema fields (Task 2); `insertNotification` from `convex/notifications.ts`; `recipientsForInbound` from `convex/lib/pushRecipients.ts`.
- Produces: `internal.conversations.unarchiveOnInbound({ accountId, conversationId, contactId })`.

**This is the task most likely to be got wrong.** The mutation must run for EVERY inbound, gated on nothing — not on `leadAnalysisConfigs.enabled`, not on a `leadAnalyses` row existing. If it were gated, switching Lead Analysis off would strand every archived conversation out of the Inbox with no way back.

- [ ] **Step 1: Widen `insertNotification`'s union**

In `convex/notifications.ts`, change the `type` field of `insertNotification`'s args to:

```ts
    type:
      | "conversation_assigned"
      | "lead_qualified"
      | "sla_alert"
      | "purchase_signal"
      | "lead_returned";
```

- [ ] **Step 2: Write the failing tests**

Append to `convex/conversations.test.ts` (reuse that file's existing account/conversation seed helpers; if it has none matching, mirror the ones in `convex/leadAnalysisEngine.test.ts`):

```ts
test("unarchiveOnInbound restores an archived conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await t.run((ctx) =>
    ctx.db.patch(conversationId, {
      archivedAt: Date.now() - 1000,
      archivedReason: "manual",
    }),
  );

  await t.mutation(internal.conversations.unarchiveOnInbound, {
    accountId, conversationId, contactId,
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.archivedAt).toBeUndefined();
  expect(conversation!.archivedReason).toBeUndefined();
  expect(conversation!.returnedAt).toBeDefined();
});

test("unarchiveOnInbound clears the mirrored analysis flag too", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(conversationId, { archivedAt: Date.now() }));
  const analysisId = await t.run((ctx) =>
    ctx.db.insert("leadAnalyses", {
      accountId, conversationId, contactId,
      scoreStatus: "scored" as const, attempts: 0,
      sequenceStatus: "idle" as const, followUpsSent: 0, archived: true,
    }),
  );

  await t.mutation(internal.conversations.unarchiveOnInbound, {
    accountId, conversationId, contactId,
  });

  expect((await t.run((ctx) => ctx.db.get(analysisId)))!.archived).toBeUndefined();
});

test("unarchiveOnInbound notifies the assigned agent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  await t.run((ctx) =>
    ctx.db.patch(conversationId, {
      archivedAt: Date.now(), assignedToUserId: userId,
    }),
  );

  await t.mutation(internal.conversations.unarchiveOnInbound, {
    accountId, conversationId, contactId,
  });

  const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
  expect(notes).toHaveLength(1);
  expect(notes[0].type).toBe("lead_returned");
  expect(notes[0].userId).toBe(userId);
});

test("unarchiveOnInbound is a no-op on a conversation that is not archived", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);

  await t.mutation(internal.conversations.unarchiveOnInbound, {
    accountId, conversationId, contactId,
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.returnedAt).toBeUndefined();
  expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toHaveLength(0);
});

test("unarchiveOnInbound runs even when lead analysis is disabled", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const { contactId, conversationId } = await seedConversation(t, accountId);
  const { defaultLeadAnalysisConfig } = await import("./lib/leadAnalysis/defaults");
  await t.run((ctx) =>
    ctx.db.insert("leadAnalysisConfigs", {
      ...defaultLeadAnalysisConfig(), accountId, enabled: false,
    }),
  );
  await t.run((ctx) => ctx.db.patch(conversationId, { archivedAt: Date.now() }));

  await t.mutation(internal.conversations.unarchiveOnInbound, {
    accountId, conversationId, contactId,
  });

  // The whole point: disabling the feature must never strand an archived
  // conversation out of the Inbox.
  expect((await t.run((ctx) => ctx.db.get(conversationId)))!.archivedAt).toBeUndefined();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run convex/conversations.test.ts`
Expected: FAIL — `unarchiveOnInbound is not a function`.

- [ ] **Step 4: Implement the mutation**

Append to `convex/conversations.ts` (add the needed imports — `internalMutation` from `./_generated/server`, `insertNotification` from `./notifications`, `recipientsForInbound` from `./lib/pushRecipients`):

```ts
/**
 * A customer replied — bring the thread back (spec 2026-07-26
 * §"Stopping and returning").
 *
 * GATED ON NOTHING, deliberately. This deliberately does NOT live in
 * `leadAnalysisEngine.onInbound`, which returns early when
 * `leadAnalysisConfigs.enabled` is false: putting it there would mean
 * that switching Lead Analysis off strands every already-archived
 * conversation out of the Inbox permanently, with no way back. Archive
 * is a Lead Analysis feature; UN-archive is a safety property of the
 * Inbox itself.
 *
 * No-ops on a conversation that is not archived, so it is free to call
 * on every single inbound.
 */
export const unarchiveOnInbound = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.accountId !== args.accountId) return;
    if (conversation.archivedAt === undefined) return;

    await ctx.db.patch(args.conversationId, {
      archivedAt: undefined,
      archivedReason: undefined,
      archivedNote: undefined,
      archivedByUserId: undefined,
      returnedAt: Date.now(),
    });

    const analysis = await ctx.db
      .query("leadAnalyses")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .unique();
    // CLEARED, not `false` — see the representation note in schema.ts.
    if (analysis) await ctx.db.patch(analysis._id, { archived: undefined });

    // Same recipient rule as an inbound on an unassigned thread: the
    // assigned agent if there is one, else everyone who works the whole
    // pool (supervisor+).
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    const contact = await ctx.db.get(args.contactId);
    const who = contact?.name?.trim() || contact?.phone || "A contact";

    for (const userId of recipientsForInbound({
      assignedToUserId: conversation.assignedToUserId ?? null,
      members,
    })) {
      await insertNotification(ctx, {
        accountId: args.accountId,
        userId,
        type: "lead_returned",
        conversationId: args.conversationId,
        contactId: args.contactId,
        title: `${who} replied`,
        body: "An archived lead came back.",
      });
    }
  },
});
```

Check `recipientsForInbound`'s real signature in `convex/lib/pushRecipients.ts` and match it exactly rather than assuming the shape above.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run convex/conversations.test.ts`
Expected: PASS, 5 new tests plus everything already there.

- [ ] **Step 6: Wire it into ingest**

In `convex/ingest.ts`, immediately after the `runBestEffort("leadAnalysisEngine.onInbound", …)` block added in P1, insert:

```ts
    // ---- Un-archive (spec 2026-07-26 §"Stopping and returning"). A
    // customer reply always brings an archived thread back, regardless
    // of whether Lead Analysis is configured or enabled — see the
    // mutation's own comment. Best-effort: restoring a thread must never
    // fail message ingestion.
    await runBestEffort("conversations.unarchiveOnInbound", () =>
      ctx.runMutation(internal.conversations.unarchiveOnInbound, {
        accountId,
        conversationId: res.conversationId,
        contactId: res.contactId,
      }),
    );
```

- [ ] **Step 7: Verify ingest did not regress**

Run: `npx vitest run convex/ingest.test.ts`
Expected: PASS — the mutation no-ops for every non-archived conversation, which is every conversation in the existing fixtures.

- [ ] **Step 8: Commit**

```bash
git add convex/notifications.ts convex/conversations.ts convex/conversations.test.ts convex/ingest.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): un-archive on customer reply

Lives in conversations.ts and is gated on nothing — putting it behind
the leadAnalysisConfigs.enabled check would strand archived threads out
of the Inbox forever whenever the feature is switched off.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Exclude archived from the Inbox

**Files:**
- Modify: `convex/conversations.ts` (the `list` query)
- Modify: `convex/conversations.test.ts`

**Interfaces:**
- Consumes: the two new `conversations` indexes (Task 2).
- Produces: `api.conversations.list` gains `archived: v.optional(v.boolean())` — absent/false = active only, true = archived only.

**Re-read `list` before editing.** A concurrent session had uncommitted work in this file; the plan's structure below describes the committed version.

- [ ] **Step 1: Write the failing tests**

Append to `convex/conversations.test.ts`:

```ts
test("list excludes archived conversations by default", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const active = await seedConversation(t, accountId);
  const archived = await seedConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(archived.conversationId, { archivedAt: Date.now() }));

  const page = await asUser.query(api.conversations.list, {
    paginationOpts: { numItems: 50, cursor: null },
  });

  const ids = page.page.map((c: { _id: string }) => c._id);
  expect(ids).toContain(active.conversationId);
  expect(ids).not.toContain(archived.conversationId);
});

test("list with archived:true returns only archived conversations", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const active = await seedConversation(t, accountId);
  const archived = await seedConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(archived.conversationId, { archivedAt: Date.now() }));

  const page = await asUser.query(api.conversations.list, {
    archived: true,
    paginationOpts: { numItems: 50, cursor: null },
  });

  const ids = page.page.map((c: { _id: string }) => c._id);
  expect(ids).toContain(archived.conversationId);
  expect(ids).not.toContain(active.conversationId);
});

test("the archived exclusion holds on the single-assignee plan", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const mine = await seedConversation(t, accountId);
  const mineArchived = await seedConversation(t, accountId);
  await t.run(async (ctx) => {
    await ctx.db.patch(mine.conversationId, { assignedToUserId: userId });
    await ctx.db.patch(mineArchived.conversationId, {
      assignedToUserId: userId, archivedAt: Date.now(),
    });
  });

  const page = await asUser.query(api.conversations.list, {
    assignment: "mine",
    paginationOpts: { numItems: 50, cursor: null },
  });

  const ids = page.page.map((c: { _id: string }) => c._id);
  expect(ids).toContain(mine.conversationId);
  expect(ids).not.toContain(mineArchived.conversationId);
});

test("the archived exclusion holds on an agent's me-or-pool view", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Agent", email: "a@x.com", role: "agent",
  });
  const pool = await seedConversation(t, accountId);
  const poolArchived = await seedConversation(t, accountId);
  await t.run((ctx) =>
    ctx.db.patch(poolArchived.conversationId, { archivedAt: Date.now() }),
  );

  const page = await asUser.query(api.conversations.list, {
    paginationOpts: { numItems: 50, cursor: null },
  });

  const ids = page.page.map((c: { _id: string }) => c._id);
  expect(ids).toContain(pool.conversationId);
  expect(ids).not.toContain(poolArchived.conversationId);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/conversations.test.ts`
Expected: FAIL — archived conversations still appear in the default list.

- [ ] **Step 3: Re-point the query plans**

In `list`, add to the args validator:

```ts
    // Absent/false = the active Inbox. True = the Archived tab.
    archived: v.optional(v.boolean()),
```

Destructure it alongside `status`/`assignment`, then apply the archive partition to each plan. The `kind: "eq"` branch moves to the four-key index:

```ts
      if (plan.kind === "eq") {
        const q = ctx.db
          .query("conversations")
          .withIndex("by_account_archived_assigned_last_message", (ix) => {
            const scoped = ix.eq("accountId", ctx.accountId);
            // `archivedAt` is optional and Convex sorts a missing field
            // before every present value, so `eq(undefined)` is exactly
            // the active set and `gt(0)` is exactly the archived set.
            // Both are real ranges, not post-scan filters — which
            // matters because archived rows only ever accumulate.
            return archived
              ? scoped.gt("archivedAt", 0)
              : scoped.eq("archivedAt", undefined).eq("assignedToUserId", plan.assignee);
          })
          .order("desc");
        ...
      }
```

**Careful:** in the archived branch you cannot also bind `assignedToUserId`, because `archivedAt` is being ranged rather than equated and index keys after a range key are unordered. Handle the archived + single-assignee combination by binding the assignee as a `.filter()` in that branch only, and comment why. The archived set is small relative to the active set and is not the hot path, so a filter there is acceptable — unlike on the active side, where it is the failure this whole design avoids.

The `any` and `meOrPool` branches both move to `by_account_archived_last_message`:

```ts
      const q = ctx.db
        .query("conversations")
        .withIndex("by_account_archived_last_message", (ix) => {
          const scoped = ix.eq("accountId", ctx.accountId);
          return archived ? scoped.gt("archivedAt", 0) : scoped.eq("archivedAt", undefined);
        })
        .order("desc");
```

This is a strict improvement for `meOrPool`: the archive partition is now indexed, and only the assignment predicate remains a filter — the same tradeoff that branch already documented.

Leave the existing `by_account_last_message` index defined in the schema. It may have other callers, and dropping a live index mid-deploy is exactly what the schema comments forbid.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/conversations.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS. Any pre-existing `conversations.list` test that seeded no archived rows must be unaffected, since `eq("archivedAt", undefined)` matches every legacy row.

- [ ] **Step 6: Commit**

```bash
git add convex/conversations.ts convex/conversations.test.ts
git commit -m "$(cat <<'EOF'
feat(inbox): exclude archived conversations via index ranges

Both indexable plans move onto the new archive-partitioned indexes, so
the exclusion is a range rather than a filter over a partition that only
ever grows. meOrPool gains an indexed archive partition too.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Stop counting archived conversations as open

**Files:**
- Modify: `convex/dashboard.ts`
- Modify: `convex/dashboard.test.ts`

**Interfaces:**
- Consumes: `conversations.by_account_archived_status` (Task 2).
- Produces: no new exports — `api.dashboard.metrics`' `openConversations` figure now excludes archived threads.

**Why this is indexed and not filtered.** `metrics` reads `by_account_status` and `.take(ACTIVE_CONVERSATIONS_CAP + 1)`. Its own comment explains why that is a real read bound: *"every document in this index range is a match (the range pins `status`, so there is no `.filter()` to starve)"*. Dropping archived rows in JS after the take would break that argument twice over — the count would silently under-report (some of the 501 taken rows get discarded), and as archived rows accumulate the take would fill with them until the tile approached zero. The archive dimension has to be in the index.

`unreadTotal` in `convex/conversations.ts` needs **no change**, and Step 4 pins why: `archive` sets `unreadCount: 0`, so archived rows leave the `by_account_unread` range on their own. That is a load-bearing consequence of Task 3, not a coincidence — hence the test.

- [ ] **Step 1: Write the failing tests**

Append to `convex/dashboard.test.ts`, matching that file's existing seed helpers and the `metrics` args it already passes (`todayStartMs` / `yesterdayStartMs`):

```ts
test("metrics does not count an archived conversation as open", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner", email: "o@x.com", role: "owner",
  });
  const active = await seedConversation(t, accountId);
  const archived = await seedConversation(t, accountId);
  await t.run((ctx) =>
    ctx.db.patch(archived.conversationId, { archivedAt: Date.now() }),
  );

  const now = Date.now();
  const metrics = await asUser.query(api.dashboard.metrics, {
    todayStartMs: now - 3_600_000,
    yesterdayStartMs: now - 90_000_000,
  });

  expect(metrics.openConversations).toBe(1);
});

test("restoring a conversation returns it to the open count", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner", email: "o@x.com", role: "owner",
  });
  const lead = await seedConversation(t, accountId);
  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });
  await asUser.mutation(api.leadAnalysis.restore, {
    conversationId: lead.conversationId,
  });

  const now = Date.now();
  const metrics = await asUser.query(api.dashboard.metrics, {
    todayStartMs: now - 3_600_000,
    yesterdayStartMs: now - 90_000_000,
  });

  expect(metrics.openConversations).toBe(1);
});

test("a conversation archived today is not counted as new-open today", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner", email: "o@x.com", role: "owner",
  });
  const archived = await seedConversation(t, accountId);
  await t.run((ctx) =>
    ctx.db.patch(archived.conversationId, { archivedAt: Date.now() }),
  );

  const now = Date.now();
  const metrics = await asUser.query(api.dashboard.metrics, {
    todayStartMs: now - 3_600_000,
    yesterdayStartMs: now - 90_000_000,
  });

  expect(metrics.openConversations).toBe(0);
  expect(metrics.newOpenToday ?? 0).toBe(0);
});

test("archiving drops the thread out of the unread badge", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Owner", email: "o@x.com", role: "owner",
  });
  const lead = await seedConversation(t, accountId);
  await t.run((ctx) => ctx.db.patch(lead.conversationId, { unreadCount: 3 }));
  expect(await asUser.query(api.conversations.unreadTotal, {})).toBe(1);

  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });

  // Load-bearing: `archive` zeroes `unreadCount`, so archived rows leave
  // the `by_account_unread` range without `unreadTotal` needing to know
  // anything about archiving.
  expect(await asUser.query(api.conversations.unreadTotal, {})).toBe(0);
});
```

Adjust the `newOpenToday` assertion to whatever key `metrics` actually returns — read the query's return shape first rather than assuming the name.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/dashboard.test.ts`
Expected: FAIL — the archived conversation is still counted as open.

- [ ] **Step 3: Re-point the open-conversation sample**

In `convex/dashboard.ts`'s `metrics`, change the `openSample` query to range on the new index:

```ts
    const openSample = await ctx.db
      .query("conversations")
      .withIndex("by_account_archived_status", (q) =>
        q
          .eq("accountId", ctx.accountId)
          // Archived threads are not open work. `archivedAt` sits before
          // `status` in this index, so this stays a pure range: every
          // document read is still a match, which is what keeps the
          // `.take(CAP + 1)` below an honest read bound rather than a
          // filter that starves as archived rows accumulate.
          .eq("archivedAt", undefined)
          .eq("status", "open"),
      )
      .take(ACTIVE_CONVERSATIONS_CAP + 1);
```

Update the block comment above it so it names the new index instead of `by_account_status`, and keeps its existing reasoning about the `+ 1` and `capped`.

- [ ] **Step 4: Exclude archived from the today/yesterday deltas**

Those come from the bounded 2-day `by_account` range and already apply `status` in JS. Add the archive check to both predicates:

```ts
    const newOpenToday = recentConversations.filter(
      (c) =>
        c.status === "open" &&
        c.archivedAt === undefined &&
        c._creationTime >= todayStartMs,
    ).length;
```

and the same added clause in `newOpenYesterday`.

A JS filter is correct *here* and not in Step 3: this range is bounded by a two-day creation window rather than by account size, so it stays small no matter how much the account accumulates — which is the reasoning the existing comment already gives for filtering `status` in JS at this call site.

- [ ] **Step 5: Leave `unreadTotal` alone**

Make no change to `convex/conversations.ts`'s `unreadTotal`. Add a one-line comment there recording *why* it needs none:

```ts
    // No archive predicate needed: `leadAnalysis.archive` zeroes
    // `unreadCount`, so an archived thread leaves this range on its own.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run convex/dashboard.test.ts`
Expected: PASS, 4 new tests.

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS. Existing `metrics` tests seed no archived rows, and `eq("archivedAt", undefined)` matches every legacy conversation, so their counts are unchanged.

- [ ] **Step 8: Commit**

```bash
git add convex/dashboard.ts convex/dashboard.test.ts convex/conversations.ts
git commit -m "$(cat <<'EOF'
fix(dashboard): stop counting archived conversations as open

The archive dimension goes in the index, not a post-take filter: that
query's read bound rests on every document in the range being a match,
and archived rows only accumulate, so a filter would both under-report
and eventually starve the take.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Board `view` arg

**Files:**
- Modify: `convex/leadAnalysis.ts` (the `board` query)
- Modify: `convex/leadAnalysis.test.ts`

**Interfaces:**
- Consumes: `leadAnalyses.by_account_archived_score` (Task 2).
- Produces: `api.leadAnalysis.board({ view })` where `view: v.optional(v.union(v.literal("active"), v.literal("archived")))`, defaulting to `"active"`. Each returned row gains `archived: boolean` and `returnedAt: number | null`.

- [ ] **Step 1: Write the failing tests**

Append to `convex/leadAnalysis.test.ts`:

```ts
test("board defaults to the active view and hides archived leads", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const active = await seedScoredLead(t, accountId, { score: 5 });
  const archived = await seedScoredLead(t, accountId, { score: 9 });
  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: archived.conversationId,
  });

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads.map((l) => l.conversationId)).toEqual([active.conversationId]);
});

test("board with view archived returns only archived leads", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  await seedScoredLead(t, accountId, { score: 5 });
  const archived = await seedScoredLead(t, accountId, { score: 9 });
  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: archived.conversationId,
  });

  const board = await asUser.query(api.leadAnalysis.board, { view: "archived" });

  expect(board.leads.map((l) => l.conversationId)).toEqual([archived.conversationId]);
  expect(board.leads[0].archived).toBe(true);
});

test("a restored lead returns to the active view", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 6 });
  await asUser.mutation(api.leadAnalysis.archive, {
    conversationId: lead.conversationId,
  });
  await asUser.mutation(api.leadAnalysis.restore, {
    conversationId: lead.conversationId,
  });

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads.map((l) => l.conversationId)).toEqual([lead.conversationId]);
});

test("a pre-archive row with no `archived` field counts as active", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s@x.com", role: "supervisor",
  });
  const lead = await seedScoredLead(t, accountId, { score: 6 });
  await t.run((ctx) => ctx.db.patch(lead.analysisId, { archived: undefined }));

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.leads.map((l) => l.conversationId)).toEqual([lead.conversationId]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: FAIL — archived leads still appear in the default board.

- [ ] **Step 3: Implement the `view` arg**

In `board`:

- Add `view: v.optional(v.union(v.literal("active"), v.literal("archived")))` to the args; `const view = args.view ?? "active";`.
- The **supervisor+ path** switches from `by_account_score` to `by_account_archived_score`. Both views are exact ranges — no post-read dropping, which is the whole point of the denormalised field:

```ts
        .withIndex("by_account_archived_score", (q) =>
          q
            .eq("accountId", ctx.accountId)
            // Exact ranges, both directions. Archived rows hold `true`;
            // active rows hold `undefined` because `restore` and
            // `unarchiveOnInbound` CLEAR the field rather than writing
            // `false` (see the representation note in schema.ts).
            // Pre-archive rows also hold `undefined`, so they land in
            // the active view with no backfill.
            .eq("archived", view === "archived" ? true : undefined),
        )
```

Do NOT filter archived rows out after the read. That would read a mostly-archived page to surface a shrinking active set once archiving has been used for a while — exactly the starvation this index exists to prevent.

- The **agent path** (which queries `conversations` by assignee) filters on `conversation.archivedAt` directly, since it already loads each conversation.
- Add `archived` and `returnedAt` to each returned row, and an `archived` count to `summary`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/leadAnalysis.ts convex/leadAnalysis.test.ts
git commit -m "$(cat <<'EOF'
feat(lead-analysis): board active/archived views

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Board UI — archive, restore, view toggle

**Files:**
- Modify: `src/components/lead-analysis/lead-analysis-board.tsx`
- Modify: `src/components/lead-analysis/lead-analysis-board.test.tsx`
- Modify: `src/app/(dashboard)/lead-analysis/page.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.leadAnalysis.archive` / `restore` (Task 3); the board's `view` arg (Task 7).
- Produces: `LeadAnalysisBoard` gains props `view: 'active' | 'archived'`, `onViewChange`, `canArchive: boolean`, `onArchive`, `onRestore`. `LeadAnalysisRow` gains `archived: boolean`, `returnedAt: number | null`.

- [ ] **Step 1: Add the i18n strings**

In `messages/en.json`, inside the existing `"LeadAnalysis"` block, add:

```json
    "view": { "active": "Active", "archived": "Archived" },
    "row": {
      "archive": "Archive",
      "restore": "Restore",
      "returned": "Returned"
    },
    "archivedToast": "Lead archived",
    "restoredToast": "Lead restored",
    "archiveError": "Could not archive this lead",
    "restoreError": "Could not restore this lead"
```

Merge into the existing `"row"` object rather than creating a second one.

- [ ] **Step 2: Write the failing component tests**

Append to `src/components/lead-analysis/lead-analysis-board.test.tsx`. **Every assertion must be scoped via `data-testid` and the file's existing `textByTestId` helper** — the component renders the words "Active", "Archived", "Restore" in the view toggle unconditionally, so a bare `toContain` would be vacuous (three such traps were found in P1):

```tsx
it("shows Archive on an active row and Restore on an archived one", () => {
  renderBoard(board([lead({ archived: false })]));
  expect(textByTestId(html, "row-archive-action")).toBe("Archive");

  renderBoard(board([lead({ archived: true })]));
  expect(textByTestId(html, "row-archive-action")).toBe("Restore");
});

it("hides the archive action when canArchive is false", () => {
  // render with canArchive={false}
  expect(html).not.toContain('data-testid="row-archive-action"');
});

it("marks a returned lead", () => {
  renderBoard(board([lead({ returnedAt: Date.now() })]));
  expect(textByTestId(html, "row-returned-badge")).toBe("Returned");
});
```

Adapt these to the file's existing render helper and fixture shape — do not introduce a second helper.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/components/lead-analysis/lead-analysis-board.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement the component changes**

- An Active/Archived segmented toggle bound to `view`/`onViewChange`.
- Per row: one action button, labelled Archive or Restore from `lead.archived`, calling `onArchive`/`onRestore`, rendered only when `canArchive`. Give it `data-testid="row-archive-action"`.
- A "Returned" badge when `lead.returnedAt` is set, with `data-testid="row-returned-badge"`.

- [ ] **Step 5: Wire the page**

In `src/app/(dashboard)/lead-analysis/page.tsx`: hold `view` in `useState`, pass it to `useQuery`, wire `useMutation(api.leadAnalysis.archive)` / `restore` with toasts, and compute `canArchive` from the role (supervisor/admin/owner — mirroring the server's `requireRole("supervisor")`).

- [ ] **Step 6: Verify**

Run: `npx vitest run src/components/lead-analysis/lead-analysis-board.test.tsx`, then `npm test`, `npm run typecheck`, and `npx eslint` on the three changed files.
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/lead-analysis/lead-analysis-board.tsx src/components/lead-analysis/lead-analysis-board.test.tsx "src/app/(dashboard)/lead-analysis/page.tsx" messages/en.json
git commit -m "$(cat <<'EOF'
feat(lead-analysis): board archive, restore, and view toggle

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Inbox — Archived tab and restore affordance

**Files:**
- Modify: `src/app/(dashboard)/inbox/page.tsx`
- Modify: `src/components/inbox/conversation-list.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.conversations.list`'s `archived` arg (Task 5); `api.leadAnalysis.restore` (Task 3).

**Re-read both files before editing** — a concurrent session had uncommitted work in them.

- [ ] **Step 1: Add the i18n strings**

In the Inbox's existing namespace in `messages/en.json`:

```json
    "archivedTab": "Archived",
    "archivedBanner": "This conversation is archived. It will return automatically if the customer replies.",
    "restore": "Restore"
```

- [ ] **Step 2: Add the Archived tab**

In `src/app/(dashboard)/inbox/page.tsx`, add `archived` to the tab state alongside the existing `assignment` tab, and pass `archived: true` to the `list` query when that tab is active. Keep it a separate piece of state from `assignment` — a user can be in Archived while also filtering Mine.

- [ ] **Step 3: Add the archived banner and Restore action**

When the selected conversation has `archivedAt` set, render a banner above the thread with the `archivedBanner` copy and a Restore button calling `api.leadAnalysis.restore`. Show the button only for supervisor+, matching the server.

- [ ] **Step 4: Verify**

Run: `npm test`, `npm run typecheck`, and `npx eslint` on the changed files.
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/inbox/page.tsx" src/components/inbox/conversation-list.tsx messages/en.json
git commit -m "$(cat <<'EOF'
feat(inbox): archived tab and restore affordance

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Deployment (owner-run, after all tasks land)

One `convex deploy`. Every schema change is additive — new optional fields, three new indexes, one widened union — so existing documents validate unchanged and no migration runs.

**Unlike P1, this deploy is immediately user-visible even with `enabled: false`:** the Archived tab appears in the Inbox and the Archive action appears on the board for supervisor+. That is intended — archiving is manual in P2 and does not depend on the scoring engine being on.

## What P2 deliberately does not do

Auto-archive at the end of a follow-up sequence, the sequence itself, template sends, and bulk archive are **P3/P4**. `leadAnalyses.sequenceStatus` still never leaves `"idle"`, and no code path added here sends a WhatsApp message.

## Risks and open items

| Risk | Mitigation / status |
|---|---|
| Archived conversations counted by `dashboard.metrics`' open tile | **Fixed in Task 6** via `by_account_archived_status`. `unreadTotal` needs no equivalent fix because `archive` zeroes `unreadCount` — pinned by a test so that stays true. |
| `leadAnalyses.archived` drifting from `conversations.archivedAt` | Both are written in one transactional mutation, and the schema comment names archive/restore as the only permitted writers. |
| Archived + single-assignee list falls back to a filter | Accepted: the archived set is small relative to active and is not the hot path. Documented at the call site. |
| A supervisor archives a thread an agent is mid-conversation on | Restore is one click and any customer reply restores automatically. Consider surfacing "archived by X" in the banner if this proves annoying. |
| The concurrent session's uncommitted work in `conversations.ts` and the inbox components | Re-check `git status` and rebase before Tasks 5 and 8; the line references in this plan describe the committed state. |
