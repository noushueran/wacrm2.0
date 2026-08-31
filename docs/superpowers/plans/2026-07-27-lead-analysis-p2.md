# Lead Analysis P2 — Archive & Restore — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the inbox a reversible shelf — supervisors archive a dead thread, any customer reply brings it back automatically, and nothing is ever deleted.

**Architecture:** Four optional fields on `conversations` plus two indexes, so "active" is a genuine index range (`eq("archivedAt", undefined)`) rather than a filter that grows without bound. Archive/restore are ordinary account mutations; the un-archive lives inside `ingestInbound`'s existing transaction because it is a correctness property, not analytics. An archived thread suspends its qualification follow-ups without ending the lead.

**Tech Stack:** Convex (schema, queries, mutations, indexes), convex-test + vitest, Next.js 16 App Router, next-intl, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-27-lead-analysis-p2-design.md`

## Global Constraints

- **Manual archive only.** No cron, no sweep, no automatic archive of any kind. `archivedReason` is always written as `"manual"` in P2. The `agedOutDays` sweep and the sequence's terminal archive are P3.
- **Archive is NOT gated by `leadAnalysisConfigs.enabled`.** The field, the `conversations.list` exclusion and the return-on-reply hook are unconditional. Gating exclusion would resurrect archived threads when the flag flips; gating the return hook would strand archived customers forever.
- **RBAC: supervisor+ archives and restores.** Agents get read/Open chat/Re-analyze only; viewers have no access. Mirrors `qualification.leadsBoard`.
- **No unbounded reads.** Every query is an index range with an explicit `.take()`/`.paginate()`. Never a `.filter()` across a partition that grows forever — see the index comments in `convex/schema.ts`.
- **Tenancy:** every handler uses `ctx.accountId` from `accountQuery`/`accountMutation` and never a client-supplied account id. Cross-account ids fail as `NOT_FOUND` via `requireConversationAccess`.
- **Never run `convex deploy`, `convex dev` or `convex codegen`.** The deployment is self-hosted production and the owner runs those. `convex/_generated/api.d.ts` imports modules as `typeof <module>`, so new exports typecheck without codegen.
- **Tests:** `npx vitest run <path>` for one file. Convex tests set `const modules = import.meta.glob("/convex/**/*.ts")` and run under the `edge-runtime` environment. There is **no jsdom and no Testing Library** — component tests use `renderToStaticMarkup`.
- **Lint scope:** `npx eslint <changed files>`. The repo has pre-existing lint debt, so a whole-tree `npm run lint` is not the gate.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `convex/schema.ts` | four `conversations` fields, two indexes, `notifications.type` literal | 1 |
| `convex/lib/qualification/track.ts` | `disarmFollowUp` — the one place that knows how to silence a session's clock | 2 |
| `convex/conversations.ts` | `archive` / `restore`; archived handling in `list`'s query plans | 2, 3 |
| `convex/notifications.ts` | widen `insertNotification`'s own `type` union | 4 |
| `convex/ingest.ts` | transactional un-archive + `lead_returned` notification | 4 |
| `convex/qualificationEngine.ts` | archived guard in `followUpContext` | 5 |
| `src/components/inbox/conversation-list.tsx` | the Archived tab | 6 |
| `src/app/(dashboard)/inbox/page.tsx` | passes `archived` to the paginated query | 6 |
| `src/components/inbox/message-thread.tsx` | Archive / Restore control + Archived badge | 7 |
| `src/components/lead-analysis/lead-analysis-board.tsx` | Archive row action + Archived tile | 8 |
| `messages/en.json` | all new strings | 6, 7, 8 |

---

### Task 1: Schema — fields, indexes, notification literal

**Files:**
- Modify: `convex/schema.ts`
- Modify: `convex/schema.test.ts`

**Interfaces:**
- Produces: `conversations.archivedAt` / `archivedReason` / `archivedByUserId` / `returnedAt`; the indexes `by_account_archived_last_message` and `by_account_archived_assigned_last_message`; the `notifications.type` literal `"lead_returned"`.

- [ ] **Step 1: Write the failing test**

Append to `convex/schema.test.ts`:

```ts
test("P2 — conversations carry archive state and range on the archived indexes", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId, phone: "+971500000009", phoneNormalized: "971500000009",
    }),
  );

  const activeId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId, contactId, status: "open" as const, unreadCount: 0,
      lastMessageAt: 2_000,
    }),
  );
  const archivedId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId, contactId, status: "open" as const, unreadCount: 0,
      lastMessageAt: 1_000,
      archivedAt: 5_000,
      archivedReason: "manual" as const,
      returnedAt: 4_000,
    }),
  );

  // Active set: `eq(archivedAt, undefined)` is a genuine range, not a filter.
  const active = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_account_archived_last_message", (q) =>
        q.eq("accountId", accountId).eq("archivedAt", undefined),
      )
      .collect(),
  );
  expect(active.map((c) => c._id)).toEqual([activeId]);

  // Archived set: the complementary range, "field present".
  const archived = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_account_archived_last_message", (q) =>
        q.eq("accountId", accountId).gt("archivedAt", 0),
      )
      .collect(),
  );
  expect(archived.map((c) => c._id)).toEqual([archivedId]);

  // The assignment-bound index serves the same active range.
  const activeUnassigned = await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_account_archived_assigned_last_message", (q) =>
        q
          .eq("accountId", accountId)
          .eq("archivedAt", undefined)
          .eq("assignedToUserId", undefined),
      )
      .collect(),
  );
  expect(activeUnassigned.map((c) => c._id)).toEqual([activeId]);
});

test("P2 — notifications accept the lead_returned type", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Sup", email: "sup@example.com" }),
  );
  const id = await t.run((ctx) =>
    ctx.db.insert("notifications", {
      accountId, userId, type: "lead_returned" as const, title: "Lead returned",
    }),
  );
  expect(await t.run((ctx) => ctx.db.get(id))).not.toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/schema.test.ts`
Expected: FAIL — the validator rejects `archivedAt` / `"lead_returned"`, and `withIndex` rejects the unknown index names.

- [ ] **Step 3: Add the four fields**

In `convex/schema.ts`, inside `conversations: defineTable({ … })`, immediately after the `attribution` object and before `funnel`:

```ts
    // ============================================================
    // Archive (Lead Analysis P2). A reversible shelf, NOT a delete:
    // nothing is removed and any inbound un-archives the thread inside
    // ingest's own transaction.
    //
    // A TIMESTAMP rather than a fourth `status` literal, deliberately.
    // `conversations.list` applies `status` as a post-index `.filter()`,
    // which is safe today only because almost every row is "open" — the
    // predicate matches early and often. Archived rows accumulate
    // forever, so as a filter they would make the inbox scan grow
    // without bound: the exact failure documented for
    // `broadcastRecipients`, `conversionEvents` and `campaignAds`.
    // `archivedAt` is optional and Convex sorts a missing field before
    // every present value, so `eq("archivedAt", undefined)` is one
    // genuine index range over exactly the active set.
    //
    // P2 only ever writes "manual"; "no_response"/"aged_out" ship in the
    // union now so P3's automated archive needs no second schema deploy
    // (the treatment `leadAnalyses.sequenceStatus` got in P1).
    // `archivedByUserId` absent = archived by automation.
    // ============================================================
    archivedAt: v.optional(v.number()),
    archivedReason: v.optional(
      v.union(
        v.literal("manual"),
        v.literal("no_response"),
        v.literal("aged_out"),
      ),
    ),
    archivedByUserId: v.optional(v.id("users")),
    returnedAt: v.optional(v.number()),
```

- [ ] **Step 4: Add the two indexes**

In the same table's index chain, after `.index("by_account_assigned_last_message", …)`:

```ts
    // Lead Analysis P2. `conversations.list` binds `archivedAt` FIRST so
    // the active set is a range, then whatever that plan needs. Field
    // order is load-bearing: putting `assignedToUserId` before
    // `archivedAt` would break the active-set range, which is the hot
    // path. The archived tab ranges `gt("archivedAt", 0)` on the first
    // index and filters assignment — Convex permits no equality after a
    // range field, and the archived tab is a cold path.
    .index("by_account_archived_last_message", [
      "accountId",
      "archivedAt",
      "lastMessageAt",
    ])
    .index("by_account_archived_assigned_last_message", [
      "accountId",
      "archivedAt",
      "assignedToUserId",
      "lastMessageAt",
    ])
```

- [ ] **Step 5: Add the notification literal**

In `notifications: defineTable({ … })`, extend the `type` union after `purchase_signal`:

```ts
      // An archived conversation came back — the customer replied
      // (Lead Analysis P2). Fired from ingest's own transaction.
      v.literal("lead_returned"),
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run convex/schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Confirm nothing else broke**

Run: `npx vitest run convex/ && npx tsc --noEmit`
Expected: PASS, no type errors. Adding optional fields and a union member is additive.

- [ ] **Step 8: Commit**

```bash
git add convex/schema.ts convex/schema.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): conversations archive fields, indexes, lead_returned type

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Archive and restore mutations

**Files:**
- Modify: `convex/lib/qualification/track.ts`
- Modify: `convex/conversations.ts`
- Modify: `convex/conversations.test.ts`

**Interfaces:**
- Consumes: Task 1's fields; the existing `requireConversationAccess(ctx, conversationId, "view")` from `convex/lib/conversationAccess.ts`.
- Produces: `export async function disarmFollowUp(ctx: { db: MutationCtx["db"] }, conversationId: Id<"conversations">): Promise<void>` in `track.ts`; `api.conversations.archive({ conversationId })` and `api.conversations.restore({ conversationId })`, both returning `null`.

- [ ] **Step 1: Write the failing tests**

Append to `convex/conversations.test.ts`:

```ts
test("archive stamps the archive fields, zeroes unread, and is idempotent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "sup@x.com", role: "supervisor",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId, phone: "+971500000010", phoneNormalized: "971500000010",
    }),
  );
  const conversationId = await seedConversation(t, {
    accountId, contactId, unreadCount: 3,
  });

  await asUser.mutation(api.conversations.archive, { conversationId });

  let row = await t.run((ctx) => ctx.db.get(conversationId));
  const firstArchivedAt = row!.archivedAt;
  expect(firstArchivedAt).toBeGreaterThan(0);
  expect(row!.archivedReason).toBe("manual");
  expect(row!.archivedByUserId).toBe(userId);
  // Otherwise the sidebar badge keeps counting a chat you cannot open.
  expect(row!.unreadCount).toBe(0);
  // …and the badge itself must actually drop. `unreadTotal` ranges
  // `by_account_unread` and knows nothing about archiving, so zeroing
  // the count is the ONLY thing keeping the two consistent.
  expect(await asUser.query(api.conversations.unreadTotal, {})).toBe(0);
  // Orthogonal axes — archiving is not closing.
  expect(row!.status).toBe("open");

  // Idempotent: a double-click must not restamp or error.
  await asUser.mutation(api.conversations.archive, { conversationId });
  row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.archivedAt).toBe(firstArchivedAt);
});

test("restore clears the archive fields, stamps returnedAt, and is idempotent", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "sup2@x.com", role: "supervisor",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId, phone: "+971500000011", phoneNormalized: "971500000011",
    }),
  );
  const conversationId = await seedConversation(t, { accountId, contactId });
  await asUser.mutation(api.conversations.archive, { conversationId });

  await asUser.mutation(api.conversations.restore, { conversationId });

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.archivedAt).toBeUndefined();
  expect(row!.archivedReason).toBeUndefined();
  expect(row!.archivedByUserId).toBeUndefined();
  expect(row!.returnedAt).toBeGreaterThan(0);

  // Restoring an active thread is a no-op, not an error.
  await asUser.mutation(api.conversations.restore, { conversationId });
});

test("archiving disarms a collecting qualification session's follow-up clock", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "sup3@x.com", role: "supervisor",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId, phone: "+971500000012", phoneNormalized: "971500000012",
    }),
  );
  const conversationId = await seedConversation(t, { accountId, contactId });
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId,
      status: "collecting" as const, origin: "inbound" as const,
      fields: [], expectedCount: 4, answeredCount: 1,
      lastCustomerMessageAt: Date.now() - 3_600_000,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
      nextFollowUpAt: Date.now() + 3_600_000,
    }),
  );

  await asUser.mutation(api.conversations.archive, { conversationId });

  const session = await t.run((ctx) => ctx.db.get(sessionId));
  expect(session!.nextFollowUpAt).toBeUndefined();
  // Suspended, NOT ended — a reply re-arms it through the normal path.
  expect(session!.status).toBe("collecting");
});

test("archive and restore are supervisor+ only", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner", email: "own@x.com", role: "owner",
  });
  const agent = await seedTeammate(t, {
    accountId: owner.accountId, name: "Ag", email: "ag@x.com", role: "agent",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId: owner.accountId, phone: "+971500000013",
      phoneNormalized: "971500000013",
    }),
  );
  const conversationId = await seedConversation(t, {
    accountId: owner.accountId, contactId, assignedToUserId: agent.userId,
  });

  await expect(
    agent.asUser.mutation(api.conversations.archive, { conversationId }),
  ).rejects.toThrow();

  await owner.asUser.mutation(api.conversations.archive, { conversationId });
  await expect(
    agent.asUser.mutation(api.conversations.restore, { conversationId }),
  ).rejects.toThrow();
});

test("archive never reaches another account's conversation", async () => {
  const t = convexTest(schema, modules);
  const a = await seedAccountMember(t, {
    name: "A", email: "a2@x.com", role: "owner",
  });
  const b = await seedAccountMember(t, {
    name: "B", email: "b2@x.com", role: "owner",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId: b.accountId, phone: "+971500000014",
      phoneNormalized: "971500000014",
    }),
  );
  const conversationId = await seedConversation(t, {
    accountId: b.accountId, contactId,
  });

  await expect(
    a.asUser.mutation(api.conversations.archive, { conversationId }),
  ).rejects.toThrow();
});
```

`seedTeammate` already exists in this file (it adds a membership to an *existing* account); check its exact option names before use and match them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/conversations.test.ts`
Expected: FAIL — `archive is not a function`.

- [ ] **Step 3: Add `disarmFollowUp` to the qualification lib**

Append to `convex/lib/qualification/track.ts`:

```ts
/**
 * Silence a conversation's pending follow-up without ending its lead
 * (Lead Analysis P2). Archiving means "I am done with this thread", so
 * no nudge may be scheduled against it — but the session stays
 * `collecting`, and the ordinary `onInbound` re-arm brings the lead back
 * intact if the customer ever replies.
 *
 * Lives here rather than in `conversations.ts` so the qualification
 * tables keep exactly one owner: every other reader/writer of
 * `qualificationSessions` already goes through this module.
 */
export async function disarmFollowUp(
  ctx: DbCtx,
  conversationId: Id<"conversations">,
): Promise<void> {
  const session = await ctx.db
    .query("qualificationSessions")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .order("desc")
    .first();
  if (!session || session.status !== "collecting") return;
  if (session.nextFollowUpAt === undefined) return;
  await ctx.db.patch(session._id, { nextFollowUpAt: undefined });
}
```

`DbCtx` and `Id` are already imported at the top of that file.

- [ ] **Step 4: Add the two mutations**

In `convex/conversations.ts`, after `setAutoreplyPaused`, add — and extend the file's existing imports with `import { disarmFollowUp } from "./lib/qualification/track";`:

```ts
// ============================================================
// Archive / restore (Lead Analysis P2). A reversible shelf: nothing is
// deleted, and any inbound un-archives the thread from inside ingest's
// own transaction (see `ingest.ingestInbound` step 4c).
//
// Supervisor+ only, mirroring `qualification.leadsBoard` — an agent
// works their own leads but does not decide what leaves the inbox.
// Both mutations are idempotent so a double-click or a stale client can
// never produce a wrong state.
//
// Deliberately does NOT touch `status`: archived and open/pending/closed
// are orthogonal axes, and a restored thread returns in the state it
// left.
// ============================================================

export const archive = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );
    if (conversation.archivedAt !== undefined) return null; // idempotent

    const now = Date.now();
    await ctx.db.patch(args.conversationId, {
      archivedAt: now,
      archivedReason: "manual",
      archivedByUserId: ctx.userId,
      // Otherwise `unreadTotal` keeps counting a conversation the user
      // can no longer open — it ranges `by_account_unread` and knows
      // nothing about archiving.
      unreadCount: 0,
      updatedAt: now,
    });
    await disarmFollowUp(ctx, args.conversationId);
    return null;
  },
});

export const restore = accountMutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "view",
    );
    if (conversation.archivedAt === undefined) return null; // idempotent

    const now = Date.now();
    await ctx.db.patch(args.conversationId, {
      archivedAt: undefined,
      archivedReason: undefined,
      archivedByUserId: undefined,
      returnedAt: now,
      updatedAt: now,
    });
    return null;
  },
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run convex/conversations.test.ts`
Expected: PASS.

- [ ] **Step 6: Lint and typecheck**

Run: `npx tsc --noEmit && npx eslint convex/conversations.ts convex/lib/qualification/track.ts convex/conversations.test.ts`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add convex/conversations.ts convex/lib/qualification/track.ts convex/conversations.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): archive/restore mutations, supervisor-gated and idempotent

Archiving zeroes unreadCount so the sidebar badge cannot count a chat
the user can no longer open, and disarms any collecting qualification
session's follow-up clock without ending the lead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Inbox exclusion in `conversations.list`

**Files:**
- Modify: `convex/conversations.ts:89-207` (the `list` query)
- Modify: `convex/conversations.test.ts`

**Interfaces:**
- Consumes: Task 1's indexes.
- Produces: `api.conversations.list` gains `archived: v.optional(v.boolean())` — absent/false = the active set, true = the archived set. Return shape is unchanged.

**This is the one task that can hurt production.** Each of the three indexable plans excludes archived by a different mechanism, so each gets its own test.

- [ ] **Step 1: Write the failing tests**

Append to `convex/conversations.test.ts`:

```ts
/** Seeds one active and one archived conversation on the same account,
 *  optionally assigned, so each `list` plan can be probed separately. */
async function seedArchivePair(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  assignedToUserId?: Id<"users">,
) {
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId, phone: "+971500000020", phoneNormalized: "971500000020",
    }),
  );
  const activeId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId, contactId, status: "open" as const, unreadCount: 0,
      lastMessageAt: 2_000, assignedToUserId,
    }),
  );
  const archivedId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId, contactId, status: "open" as const, unreadCount: 0,
      lastMessageAt: 1_000, assignedToUserId,
      archivedAt: 5_000, archivedReason: "manual" as const,
    }),
  );
  return { activeId, archivedId };
}

const PAGE = { numItems: 20, cursor: null };

test("list plan `any` excludes archived rows (supervisor+, no tab)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Own", email: "own3@x.com", role: "owner",
  });
  const { activeId } = await seedArchivePair(t, accountId);

  const res = await asUser.query(api.conversations.list, { paginationOpts: PAGE });

  expect(res.page.map((c) => c._id)).toEqual([activeId]);
});

test("list plan `eq` excludes archived rows (Mine / Unassigned tabs)", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Own", email: "own4@x.com", role: "owner",
  });
  const { activeId } = await seedArchivePair(t, accountId, userId);

  const res = await asUser.query(api.conversations.list, {
    assignment: "mine", paginationOpts: PAGE,
  });

  expect(res.page.map((c) => c._id)).toEqual([activeId]);
});

test("list plan `meOrPool` excludes archived rows (an agent's default view)", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Own", email: "own5@x.com", role: "owner",
  });
  const agent = await seedTeammate(t, {
    accountId: owner.accountId, name: "Ag", email: "ag5@x.com", role: "agent",
  });
  const { activeId } = await seedArchivePair(t, owner.accountId, agent.userId);

  const res = await agent.asUser.query(api.conversations.list, {
    paginationOpts: PAGE,
  });

  expect(res.page.map((c) => c._id)).toEqual([activeId]);
});

test("the archived tab returns exactly the complement, in every plan", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Own", email: "own6@x.com", role: "owner",
  });
  const { archivedId } = await seedArchivePair(t, accountId, userId);

  const any = await asUser.query(api.conversations.list, {
    archived: true, paginationOpts: PAGE,
  });
  expect(any.page.map((c) => c._id)).toEqual([archivedId]);

  const eq = await asUser.query(api.conversations.list, {
    archived: true, assignment: "mine", paginationOpts: PAGE,
  });
  expect(eq.page.map((c) => c._id)).toEqual([archivedId]);
});

test("the archived tab still honours the assignment tab", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Own", email: "own7@x.com", role: "owner",
  });
  // Archived AND assigned to me…
  await seedArchivePair(t, accountId, userId);
  // …plus an archived row in the pool, which "Mine" must not return.
  const poolContact = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId, phone: "+971500000021", phoneNormalized: "971500000021",
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId, contactId: poolContact, status: "open" as const,
      unreadCount: 0, lastMessageAt: 900, archivedAt: 6_000,
      archivedReason: "manual" as const,
    }),
  );

  const mine = await asUser.query(api.conversations.list, {
    archived: true, assignment: "mine", paginationOpts: PAGE,
  });

  expect(mine.page).toHaveLength(1);
  expect(mine.page[0].assignedToUserId).toBe(userId);
});

test("the status filter still composes with the archived range", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Own", email: "own8@x.com", role: "owner",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId, phone: "+971500000022", phoneNormalized: "971500000022",
    }),
  );
  const pendingId = await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId, contactId, status: "pending" as const, unreadCount: 0,
      lastMessageAt: 3_000,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId, contactId, status: "open" as const, unreadCount: 0,
      lastMessageAt: 2_000,
    }),
  );

  const res = await asUser.query(api.conversations.list, {
    status: "pending", paginationOpts: PAGE,
  });

  expect(res.page.map((c) => c._id)).toEqual([pendingId]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/conversations.test.ts`
Expected: FAIL — the archived rows come back in every plan, and `archived: true` is rejected as an unknown argument.

- [ ] **Step 3: Add the `archived` argument**

In `convex/conversations.ts`, in `list`'s `args`, after `assignment`:

```ts
    /** Lead Analysis P2. Absent/false = the ACTIVE set (the inbox);
     *  true = the Archived tab's complementary range. */
    archived: v.optional(v.boolean()),
```

And destructure it at the top of the handler:

```ts
    const { status, assignment, archived, paginationOpts } = args;
```

- [ ] **Step 4: Rewrite the query-plan block**

Replace the whole `const result = await (async () => { … })();` block with:

```ts
    // Archive (P2). `archivedAt` is optional and Convex sorts a missing
    // field before every present value, so the ACTIVE set is
    // `eq("archivedAt", undefined)` — one genuine index range, never a
    // filter that grows as archived rows accumulate.
    //
    // The archived tab takes ONE cold-path shape for every plan: a
    // single `gt("archivedAt", 0)` range with assignment as a filter.
    // Convex permits no equality after a range field, so the assignment
    // -bound index cannot serve it — and it does not need to. The tab is
    // opened deliberately and rarely, ordered newest-archived-first, so
    // the rows a user wants are at the front of the scan.
    const result = await (async () => {
      if (archived) {
        const q = ctx.db
          .query("conversations")
          .withIndex("by_account_archived_last_message", (ix) =>
            ix.eq("accountId", ctx.accountId).gt("archivedAt", 0),
          )
          .order("desc");
        return await q
          .filter((f) => {
            const parts = [];
            if (status) parts.push(f.eq(f.field("status"), status));
            if (plan.kind === "eq") {
              parts.push(f.eq(f.field("assignedToUserId"), plan.assignee));
            }
            if (plan.kind === "meOrPool") {
              parts.push(
                f.or(
                  f.eq(f.field("assignedToUserId"), ctx.userId),
                  f.eq(f.field("assignedToUserId"), undefined),
                ),
              );
            }
            return parts.length === 0
              ? f.eq(f.field("accountId"), ctx.accountId) // always true
              : parts.reduce((a, b) => f.and(a, b));
          })
          .paginate(paginationOpts);
      }

      if (plan.kind === "eq") {
        // Single assignee → a genuine index range on BOTH archived and
        // assignment. Field order in the index is load-bearing: binding
        // `archivedAt` first is what keeps the active set a range.
        const q = ctx.db
          .query("conversations")
          .withIndex("by_account_archived_assigned_last_message", (ix) =>
            ix
              .eq("accountId", ctx.accountId)
              .eq("archivedAt", undefined)
              .eq("assignedToUserId", plan.assignee),
          )
          .order("desc");
        return status
          ? await q
              .filter((f) => f.eq(f.field("status"), status))
              .paginate(paginationOpts)
          : await q.paginate(paginationOpts);
      }

      // `any` and `meOrPool` both range the archived index and keep
      // `lastMessageAt` ordering. `meOrPool` is an OR across two
      // disjoint assignment ranges that a single `.paginate()` cursor
      // cannot express, so assignment stays a filter there — the benign
      // case, since for an agent "mine or unassigned" matches a large
      // share of the rows near the front. Archived does NOT stay a
      // filter: it is a range here too.
      const q = ctx.db
        .query("conversations")
        .withIndex("by_account_archived_last_message", (ix) =>
          ix.eq("accountId", ctx.accountId).eq("archivedAt", undefined),
        )
        .order("desc");

      if (!status && plan.kind === "any") return await q.paginate(paginationOpts);

      return await q
        .filter((f) => {
          const parts = [];
          if (status) parts.push(f.eq(f.field("status"), status));
          if (plan.kind === "meOrPool") {
            parts.push(
              f.or(
                f.eq(f.field("assignedToUserId"), ctx.userId),
                f.eq(f.field("assignedToUserId"), undefined),
              ),
            );
          }
          return parts.reduce((a, b) => f.and(a, b));
        })
        .paginate(paginationOpts);
    })();
```

Note the deliberate improvement on the spec: the spec allowed `meOrPool` to keep archived as a `.filter()`; ranging it on `by_account_archived_last_message` costs nothing and is strictly better, so do that. The assignment OR remains a filter, exactly as before.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run convex/conversations.test.ts`
Expected: PASS — including every pre-existing `list` test, which must be unchanged.

- [ ] **Step 6: Typecheck, lint, and run the whole Convex suite**

Run: `npx tsc --noEmit && npx eslint convex/conversations.ts convex/conversations.test.ts && npx vitest run convex/`
Expected: clean, all PASS. `apiV1.ts` and `dashboard.ts` also read conversations — the suite proves they are unaffected.

- [ ] **Step 7: Commit**

```bash
git add convex/conversations.ts convex/conversations.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): exclude archived conversations from the inbox

Active is `eq(archivedAt, undefined)` — a genuine index range in all
three query plans, not a filter that would grow without bound as
archived rows accumulate. The archived tab takes one cold-path shape:
a `gt(archivedAt, 0)` range with assignment as a filter, since Convex
permits no equality after a range field.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Transactional un-archive on reply

**Files:**
- Modify: `convex/notifications.ts:57-71`
- Modify: `convex/ingest.ts`
- Modify: `convex/ingest.test.ts`

**Interfaces:**
- Consumes: Task 1's fields and notification literal; the existing `recipientsForInbound({ assignedToUserId, members })` from `convex/lib/pushRecipients.ts`; `insertNotification` (already imported in `ingest.ts`).
- Produces: no new exports — a new step 4c inside `ingestInbound`'s transaction.

**Why in the transaction.** The hooks below step 4 (`qualificationEngine.onInbound`, `leadAnalysisEngine.onInbound`) run through `runBestEffort` because they are analytics and automation: a swallowed failure costs a score or a nudge. Un-archiving is a correctness property of the inbox — a swallowed failure leaves a thread hidden while its customer is actively writing into it, and nothing would ever retry. It goes in the same transaction as the message insert.

- [ ] **Step 1: Write the failing tests**

Append to `convex/ingest.test.ts`. That file already provides `seedAccount(t, name)` (returns the account id and seeds its owner + WhatsApp config) and `notificationsFor(t, accountId)`; `ingestInbound`'s argument shape is `{ accountId, from, name, message: { type, text, wamid } }`. One new local helper is needed:

```ts
/** An archived conversation for `from`, so an inbound lands on it and
 *  must un-archive it. Mirrors how ingest itself finds a conversation:
 *  by contact, via `by_contact`. */
async function seedArchivedConversationFor(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  phoneNormalized: string,
  assignedToUserId?: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: `+${phoneNormalized}`,
      phoneNormalized,
      name: "Asha",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open" as const,
      unreadCount: 0,
      lastMessageAt: Date.now() - 30 * 86_400_000,
      assignedToUserId,
      archivedAt: Date.now() - 86_400_000,
      archivedReason: "manual" as const,
      archivedByUserId: assignedToUserId,
    });
    return { contactId, conversationId };
  });
}
```

```ts
test("an inbound message un-archives the conversation and notifies the pool", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Returns");
  const { conversationId, contactId } = await seedArchivedConversationFor(
    t, accountId, "15551230030",
  );

  await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551230030",
    name: "Asha",
    message: { type: "text", text: "still interested", wamid: "wamid.RETURN1" },
  });

  const row = await t.run((ctx) => ctx.db.get(conversationId));
  expect(row!.archivedAt).toBeUndefined();
  expect(row!.archivedReason).toBeUndefined();
  expect(row!.archivedByUserId).toBeUndefined();
  expect(row!.returnedAt).toBeGreaterThan(0);

  const returned = (await notificationsFor(t, accountId)).filter(
    (n) => n.type === "lead_returned",
  );
  expect(returned).toHaveLength(1);
  expect(returned[0].conversationId).toBe(conversationId);
  expect(returned[0].contactId).toBe(contactId);
});

test("an inbound on an ACTIVE conversation writes no lead_returned notification", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "NoReturn");

  await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551230031",
    name: "Bilal",
    message: { type: "text", text: "hello", wamid: "wamid.RETURN2" },
  });

  const notes = (await notificationsFor(t, accountId)).filter(
    (n) => n.type === "lead_returned",
  );
  expect(notes).toHaveLength(0);
});

test("a returned lead notifies its assignee rather than the pool", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Assigned");
  const agentUserId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Ag", email: "ag-return@x.com",
    });
    await ctx.db.insert("memberships", {
      userId, accountId, role: "agent", fullName: "Ag", email: "ag-return@x.com",
    });
    return userId;
  });
  await seedArchivedConversationFor(t, accountId, "15551230032", agentUserId);

  await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551230032",
    name: "Asha",
    message: { type: "text", text: "back", wamid: "wamid.RETURN3" },
  });

  const returned = (await notificationsFor(t, accountId)).filter(
    (n) => n.type === "lead_returned",
  );
  expect(returned).toHaveLength(1);
  expect(returned[0].userId).toBe(agentUserId);
});

test("a reply to an archived thread also re-arms its qualification clock", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Rearm");
  const { conversationId, contactId } = await seedArchivedConversationFor(
    t, accountId, "15551230033",
  );
  // Qualification enabled, 24/7 hours so the clamp never interferes.
  await t.run(async (ctx) => {
    const { amaniDefaultConfig } = await import("./lib/qualification/defaults");
    await ctx.db.insert("qualificationConfigs", {
      ...amaniDefaultConfig(),
      accountId,
      enabled: true,
      workStartMinute: 0,
      workEndMinute: 1440,
      workDays: [0, 1, 2, 3, 4, 5, 6],
    });
  });
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("qualificationSessions", {
      accountId, conversationId, contactId,
      status: "collecting" as const, origin: "inbound" as const,
      fields: [], expectedCount: 4, answeredCount: 1,
      lastCustomerMessageAt: Date.now() - 86_400_000,
      followUpsSent: 0, phrasingCursor: 0, sendAttemptErrors: 0,
      nextFollowUpAt: undefined, // disarmed by the archive
    }),
  );

  await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "15551230033",
    name: "Asha",
    message: { type: "text", text: "still keen", wamid: "wamid.RETURN4" },
  });

  const session = await t.run((ctx) => ctx.db.get(sessionId));
  // The lead picks up where it left off — no new session, no new path.
  expect(session!.status).toBe("collecting");
  expect(session!.nextFollowUpAt).toBeGreaterThan(Date.now());
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run convex/ingest.test.ts`
Expected: FAIL — `archivedAt` is still set and no `lead_returned` row exists.

- [ ] **Step 3: Widen `insertNotification`'s own type union**

In `convex/notifications.ts`, the helper carries a hand-written union **separate from the schema's**, so widening the schema alone is not enough — the same trap `aiUsage.log`'s `mode` validator hit in P1. Change:

```ts
    type: "conversation_assigned" | "lead_qualified" | "sla_alert" | "purchase_signal";
```

to:

```ts
    type:
      | "conversation_assigned"
      | "lead_qualified"
      | "sla_alert"
      | "purchase_signal"
      | "lead_returned";
```

- [ ] **Step 4: Add the un-archive step to `ingestInbound`**

In `convex/ingest.ts`, extend the imports:

```ts
import { recipientsForInbound } from "./lib/pushRecipients";
import { hasMinRole, type AccountRole } from "./lib/roles";
```

(`hasMinRole` is already imported — add the type to that same statement rather than a second import.)

Then, directly after the `// ---- (4b) ad-lead denorm + contact acquisition (set once) ----` block and before the `return { … }`:

```ts
    // ---- (4c) return from archive (Lead Analysis P2) ----
    // `conversation` is the PRE-patch doc, so `.archivedAt` reflects
    // state before this message — the correct "was it archived?" check,
    // the same reasoning step 4b uses for `.adReferral`.
    //
    // In the transaction on purpose. The best-effort hooks below are
    // analytics; this is a correctness property of the inbox — a
    // swallowed failure would leave the thread hidden while its customer
    // is actively writing into it, and nothing would ever retry.
    // `lastMessageAt` was just updated by the insert above, so the
    // thread reappears at the top of the inbox by ordinary recency and
    // `conversations.list` needs no special case.
    if (conversation.archivedAt !== undefined) {
      await ctx.db.patch(conversationId, {
        archivedAt: undefined,
        archivedReason: undefined,
        archivedByUserId: undefined,
        returnedAt: Date.now(),
      });
      const members = await ctx.db
        .query("memberships")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .collect();
      const recipients = recipientsForInbound({
        assignedToUserId: conversation.assignedToUserId ?? null,
        members: members.map((m) => ({
          userId: m.userId,
          role: m.role as AccountRole,
        })),
      });
      const contactForNote = existingContact ?? (await ctx.db.get(contactId));
      const who =
        contactForNote?.name?.trim() || contactForNote?.phone || "A customer";
      for (const userId of recipients) {
        await insertNotification(ctx, {
          accountId,
          userId,
          type: "lead_returned",
          conversationId,
          contactId,
          title: "Lead returned",
          body: `${who} replied to an archived chat.`,
        });
      }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run convex/ingest.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck, lint, and run the whole Convex suite**

Run: `npx tsc --noEmit && npx eslint convex/ingest.ts convex/notifications.ts convex/ingest.test.ts && npx vitest run convex/`
Expected: clean, all PASS.

- [ ] **Step 7: Commit**

```bash
git add convex/ingest.ts convex/notifications.ts convex/ingest.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): un-archive on reply, inside ingest's own transaction

Un-archiving is a correctness property of the inbox, not analytics: a
best-effort hook that swallowed a failure would leave the thread hidden
while its customer is actively writing into it, with nothing to retry.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: The archived guard in `followUpContext`

**Files:**
- Modify: `convex/qualificationEngine.ts` (inside `followUpContext`)
- Modify: `convex/qualificationEngine.test.ts`

**Interfaces:**
- Consumes: Task 1's `archivedAt`.
- Produces: no new exports — one guard in the existing verdict chain.

Task 2 disarms the clock at archive time; this guard covers the race where a session was armed **before** the archive landed, or armed by an inbound the archive did not see. Belt and braces, deliberately.

- [ ] **Step 1: Write the failing test**

Append to `convex/qualificationEngine.test.ts`:

```ts
test("an armed follow-up never sends into an archived conversation", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAllHours(t);
  const lastCustomerMessageAt = Date.now() - 6 * 3_600_000;
  await t.run((ctx) =>
    ctx.db.patch(base.conversationId, {
      archivedAt: Date.now() - 60_000,
      archivedReason: "manual" as const,
    }),
  );
  const sessionId = await seedDueSession(t, base, { lastCustomerMessageAt });

  await t.action(internal.qualificationEngine.sendFollowUp, { sessionId });

  expect(await messagesFor(t, base.conversationId)).toHaveLength(0);
  const [s] = await sessionsFor(t, base.conversationId);
  expect(s.followUpsSent).toBe(0);
  // Archiving is an explicit "I am done here" — the same class of signal
  // as an explicit Take over, so the yield is permanent, not the bounded
  // deferral that assignment and a manual reply now get.
  expect(s.status).toBe("collecting");
  expect(s.nextFollowUpAt).toBeGreaterThan(
    lastCustomerMessageAt + 72 * 3_600_000,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run convex/qualificationEngine.test.ts`
Expected: FAIL — one message was sent and `followUpsSent` is 1.

- [ ] **Step 3: Add the guard**

In `convex/qualificationEngine.ts`, inside `followUpContext`, immediately after the `expiryRevisit` constant is defined and **before** the `aiAutoreplyDisabled` guard:

```ts
    // Archived (Lead Analysis P2): the thread has been taken off the
    // active inbox, so nothing automated may speak into it. Permanent
    // like the explicit pause below — archiving IS an explicit "I am
    // done here", unlike the incidental assignment/human-touch signals
    // further down, which only defer. `conversations.archive` also
    // disarms the clock; this covers a session armed before the archive
    // landed. A customer reply un-archives the thread inside ingest's
    // transaction and re-arms the clock through the ordinary
    // `onInbound` path.
    if (conversation.archivedAt !== undefined) {
      return { kind: "reschedule", at: expiryRevisit };
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run convex/qualificationEngine.test.ts`
Expected: PASS — all pre-existing follow-up tests included.

- [ ] **Step 5: Commit**

```bash
git add convex/qualificationEngine.ts convex/qualificationEngine.test.ts
git commit -m "$(cat <<'EOF'
feat(archive): never send a qualification follow-up into an archived chat

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The Archived tab

**Files:**
- Modify: `src/components/inbox/conversation-list.tsx`
- Modify: `src/app/(dashboard)/inbox/page.tsx`
- Modify: `messages/en.json`
- Modify: `src/components/inbox/conversation-list.test.tsx`

**Interfaces:**
- Consumes: `api.conversations.list`'s new `archived` argument (Task 3).
- Produces: `AssignmentTab` widens to `"all" | "mine" | "unassigned" | "archived"`.

Modelling Archived as a fourth value of the existing tab — rather than a separate boolean — keeps one piece of state driving one paginated query, and the page already resets the pagination cursor when the query args change.

- [ ] **Step 1: Add the i18n strings**

In `messages/en.json`, inside `"Inbox" → "conversationList"`, after `"tabUnassigned"`:

```json
      "tabArchived": "Archived",
      "emptyArchived": "Nothing archived yet",
```

- [ ] **Step 2: Write the failing component test**

Append to `src/components/inbox/conversation-list.test.tsx`. Note the difference from that file's existing tests: they render `ConversationItem`, which takes its translator as a prop, but `ConversationList` itself calls `useTranslations("Inbox.conversationList")`. So this needs `NextIntlClientProvider` — which works fine under `renderToStaticMarkup`, since it is ordinary React context (the `lead-analysis-board.test.tsx` tests do exactly this).

`ConversationListProps` requires exactly: `activeConversationId`, `onSelect`, `onMarkUnread`, `conversations`, `loadMore`, `status`, `assignment`, `onAssignmentChange`.

```tsx
import { NextIntlClientProvider } from "next-intl";
import { vi } from "vitest";
import messages from "../../../messages/en.json";
import { ConversationList, type AssignmentTab } from "./conversation-list";

function listMarkup(over: {
  assignment?: AssignmentTab;
  conversations?: Conversation[];
} = {}): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ConversationList
        activeConversationId={null}
        onSelect={vi.fn()}
        onMarkUnread={vi.fn()}
        conversations={over.conversations ?? []}
        loadMore={vi.fn()}
        status="Exhausted"
        assignment={over.assignment ?? "all"}
        onAssignmentChange={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

it("renders an Archived tab", () => {
  expect(listMarkup()).toContain("Archived");
});

it("shows the archived empty state on the Archived tab", () => {
  expect(listMarkup({ assignment: "archived" })).toContain("Nothing archived yet");
});
```

If `activeConversationId`'s type is not nullable, pass `undefined` or a dummy id to match its declared type — read the prop type rather than fighting the compiler.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/components/inbox/conversation-list.test.tsx`
Expected: FAIL — no "Archived" text in the markup.

- [ ] **Step 4: Widen the tab type and the tab list**

In `src/components/inbox/conversation-list.tsx`:

```ts
export type AssignmentTab = "all" | "mine" | "unassigned" | "archived";
```

Add the tab to `ASSIGNMENT_TABS` after `unassigned`, using `t('tabArchived')` for the label and `"archived"` for the value, exactly matching how the three existing entries are built.

Add the empty-state branch beside the existing `emptyMine` / `emptyUnassigned` cases: when `assignment === "archived"` and the list is empty, render `t('emptyArchived')`.

- [ ] **Step 5: Pass the argument through the page**

In `src/app/(dashboard)/inbox/page.tsx`, replace the `usePaginatedQuery` argument object:

```tsx
    {
      assignment:
        assignment === "all" || assignment === "archived"
          ? undefined
          : assignment,
      archived: assignment === "archived" ? true : undefined,
    },
```

The Archived tab shows every archived thread the caller may see, so it sends no assignment predicate — the server still applies the role scope.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/components/inbox/conversation-list.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/components/inbox/conversation-list.tsx "src/app/(dashboard)/inbox/page.tsx" src/components/inbox/conversation-list.test.tsx`
Expected: clean. `AssignmentTab` is a union widening, so any exhaustive `switch` on it will surface here.

- [ ] **Step 8: Commit**

```bash
git add src/components/inbox/conversation-list.tsx "src/app/(dashboard)/inbox/page.tsx" src/components/inbox/conversation-list.test.tsx messages/en.json
git commit -m "$(cat <<'EOF'
feat(archive): Archived tab in the inbox

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Archive / Restore in the thread header

**Files:**
- Modify: `src/components/inbox/message-thread.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.conversations.archive` / `api.conversations.restore` (Task 2).
- Produces: no exported types — a header control and an archived badge.

A deep-linked archived thread must still render: a link from the board, a notification, or a bookmark has to resolve. It shows an *Archived* badge and Restore instead of the Archive button.

- [ ] **Step 1: Add the i18n strings**

In `messages/en.json`, inside `"Inbox" → "messageThread"` — the namespace the component reads (`useTranslations("Inbox.messageThread")` at `message-thread.tsx:179`):

```json
      "archive": "Archive",
      "restore": "Restore",
      "archivedBadge": "Archived",
      "archived": "Chat archived",
      "restored": "Chat restored",
      "archiveFailed": "Couldn't archive this chat",
      "restoreFailed": "Couldn't restore this chat"
```

- [ ] **Step 2: Wire the mutations**

In `src/components/inbox/message-thread.tsx`, beside the component's existing `useMutation` calls:

```tsx
  const archive = useMutation(api.conversations.archive);
  const restore = useMutation(api.conversations.restore);

  const handleArchive = useCallback(async () => {
    try {
      await archive({ conversationId: conversation.id as Id<'conversations'> });
      toast.success(t('archived'));
    } catch (err) {
      console.error('Failed to archive conversation:', err);
      toast.error(t('archiveFailed'));
    }
  }, [archive, conversation.id, t]);

  const handleRestore = useCallback(async () => {
    try {
      await restore({ conversationId: conversation.id as Id<'conversations'> });
      toast.success(t('restored'));
    } catch (err) {
      console.error('Failed to restore conversation:', err);
      toast.error(t('restoreFailed'));
    }
  }, [restore, conversation.id, t]);
```

Match the file's existing conventions for `conversation.id`, its translator namespace, and its toast import rather than copying these lines blind.

- [ ] **Step 3: Render the control**

In the thread header, gated on supervisor+ (`canAssignToOthers(accountRole)` from `@/lib/auth/roles` is the existing supervisor+ predicate in the UI layer; use the same helper the header already uses for its other supervisor-only controls):

- when `conversation.archivedAt` is set: render the *Archived* badge (`t('archivedBadge')`) and a Restore button calling `handleRestore`
- otherwise: render an Archive button calling `handleArchive`

Style them as the header's other actions are styled — `buttonVariants({ variant: 'ghost', size: 'sm' })` on a plain `<button type="button">`. **Do not use `<Button asChild>`:** this repo's `Button` is base-ui's and has no `asChild` prop.

`archivedAt` must be present on the UI conversation type. If `src/lib/convex/adapters.ts`'s `toUiConversation` drops unknown fields, add `archivedAt` to the adapter and to the `Conversation` type in `src/types/index.ts`.

- [ ] **Step 4: Cover the two states with a test**

The spec requires that an archived thread shows the badge and Restore. `message-thread.tsx` is large and has no test file, so do **not** try to static-render the whole component. Extract the control into a small presentational sibling and test that — the same extract-to-test move `lead-analysis-filter.ts` made in P1, and the reason this repo can test behaviour at all without a DOM.

Create `src/components/inbox/thread-archive-control.tsx`:

```tsx
'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';

/** The header's archive affordance. Presentational and prop-driven so it
 *  can be static-rendered in tests — `message-thread.tsx` itself is far
 *  too large a prop surface to render in a unit test. */
export function ThreadArchiveControl({
  archived,
  canArchive,
  onArchive,
  onRestore,
}: {
  archived: boolean;
  canArchive: boolean;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const t = useTranslations('Inbox.messageThread');
  if (archived) {
    return (
      <span className="flex items-center gap-2">
        <Badge variant="secondary">{t('archivedBadge')}</Badge>
        {canArchive ? (
          <button
            type="button"
            onClick={onRestore}
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
          >
            {t('restore')}
          </button>
        ) : null}
      </span>
    );
  }
  if (!canArchive) return null;
  return (
    <button
      type="button"
      onClick={onArchive}
      className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
    >
      {t('archive')}
    </button>
  );
}
```

Create `src/components/inbox/thread-archive-control.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

import messages from "../../../messages/en.json";
import { ThreadArchiveControl } from "./thread-archive-control";

function markup(props: { archived: boolean; canArchive: boolean }): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ThreadArchiveControl
        archived={props.archived}
        canArchive={props.canArchive}
        onArchive={vi.fn()}
        onRestore={vi.fn()}
      />
    </NextIntlClientProvider>,
  );
}

describe("ThreadArchiveControl", () => {
  it("offers Archive on an active thread", () => {
    const html = markup({ archived: false, canArchive: true });
    expect(html).toContain("Archive");
    expect(html).not.toContain("Restore");
  });

  it("shows the badge and Restore on an archived thread", () => {
    const html = markup({ archived: true, canArchive: true });
    expect(html).toContain("Archived");
    expect(html).toContain("Restore");
  });

  it("renders nothing for a user who may not archive", () => {
    expect(markup({ archived: false, canArchive: false })).toBe("");
  });

  it("still shows the archived badge to a user who may not restore", () => {
    const html = markup({ archived: true, canArchive: false });
    expect(html).toContain("Archived");
    expect(html).not.toContain("Restore");
  });
});
```

Then render `<ThreadArchiveControl … />` from the thread header in place of the inline markup from Step 3.

Run: `npx vitest run src/components/inbox/thread-archive-control.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npx eslint src/components/inbox/message-thread.tsx src/components/inbox/thread-archive-control.tsx src/components/inbox/thread-archive-control.test.tsx`
Expected: clean.

- [ ] **Step 6: Verify in the browser**

Run `preview_start` with the `wacrm-dev` configuration, then check `preview_logs` for compile errors and `read_console_messages` for runtime errors. The app has a login wall, so the achievable check is that `/inbox` compiles and serves `200` with no errors — say so plainly rather than claiming the control was seen working.

- [ ] **Step 7: Commit**

```bash
git add src/components/inbox/message-thread.tsx src/components/inbox/thread-archive-control.tsx src/components/inbox/thread-archive-control.test.tsx messages/en.json src/types/index.ts src/lib/convex/adapters.ts
git commit -m "$(cat <<'EOF'
feat(archive): Archive/Restore control and archived badge in the thread

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Archive from the Lead Analysis board

**Files:**
- Modify: `src/components/lead-analysis/lead-analysis-filter.ts`
- Modify: `src/components/lead-analysis/lead-analysis-board.tsx`
- Modify: `src/components/lead-analysis/lead-analysis-board.test.tsx`
- Modify: `src/app/(dashboard)/lead-analysis/page.tsx`
- Modify: `convex/leadAnalysis.ts`
- Modify: `convex/leadAnalysis.test.ts`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.conversations.archive` (Task 2).
- Produces: `LeadAnalysisRow` gains `archivedAt: number | null`; `LeadAnalysisBoardData["summary"]` gains `archived: number`; `LeadAnalysisBoard` gains props `canArchive: boolean` and `onArchive: (lead: LeadAnalysisRow) => void`.

- [ ] **Step 1: Write the failing server test**

Append to `convex/leadAnalysis.test.ts`:

```ts
test("the board reports each lead's archived state and counts them", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Sup", email: "s9@x.com", role: "supervisor",
  });
  const active = await seedScoredLead(t, accountId, { score: 9, band: "hot" });
  const archived = await seedScoredLead(t, accountId, { score: 5, band: "warm" });
  await t.run((ctx) =>
    ctx.db.patch(archived.conversationId, {
      archivedAt: 7_000, archivedReason: "manual" as const,
    }),
  );

  const board = await asUser.query(api.leadAnalysis.board, {});

  expect(board.summary.archived).toBe(1);
  const byId = new Map(board.leads.map((l) => [l.conversationId, l]));
  expect(byId.get(active.conversationId)!.archivedAt).toBeNull();
  expect(byId.get(archived.conversationId)!.archivedAt).toBe(7_000);
});
```

The board deliberately keeps showing archived leads — it is the review surface for what was archived, and the Archived tile is how you find them.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: FAIL — `summary.archived` is undefined.

- [ ] **Step 3: Extend the board query**

In `convex/leadAnalysis.ts`'s `board` handler: add `archivedAt: number | null;` to the `leads` element type, push `archivedAt: conversation.archivedAt ?? null,` in the row literal, and add to `summary`:

```ts
      archived: leads.filter((l) => l.archivedAt !== null).length,
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run convex/leadAnalysis.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the i18n strings**

In `messages/en.json`, inside `"LeadAnalysis"`: add `"archived": "Archived"` to `"tiles"`, and to `"row"` add `"archive": "Archive"`. At the block's top level add:

```json
    "archiveQueued": "Chat archived",
    "archiveError": "Could not archive this chat",
```

- [ ] **Step 6: Write the failing component test**

Append to `src/components/lead-analysis/lead-analysis-board.test.tsx`:

```tsx
it("renders the Archive action when permitted", () => {
  const html = markup(board([lead()]));
  expect(html).toContain("Archive");
});

it("omits the Archive action when not permitted", () => {
  const html = markup(board([lead()]), { canArchive: false });
  expect(html).not.toContain(">Archive<");
});

it("marks an already-archived lead instead of offering Archive again", () => {
  const html = markup(board([lead({ archivedAt: 7_000 })]));
  expect(html).toContain("Archived");
});
```

Widen the file's `markup` helper to take an options object (`{ canReanalyze?, canArchive? }`, both defaulting to true) instead of its current single boolean, and update its existing call sites accordingly. Add `archivedAt: null` to the `lead()` factory and `archived: 0` to the `board()` summary factory.

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/components/lead-analysis/lead-analysis-board.test.tsx`
Expected: FAIL — no Archive text, and `archivedAt` is not on the row type.

- [ ] **Step 8: Extend the types and the component**

In `lead-analysis-filter.ts`, add `archivedAt: number | null;` to `LeadAnalysisRow` and `archived: number;` to `LeadAnalysisBoardData["summary"]`.

In `lead-analysis-board.tsx`: add `canArchive: boolean` and `onArchive: (lead: LeadAnalysisRow) => void` to the props; add an Archived tile (`t('tiles.archived')`, `board.summary.archived`) after the Unscored tile; and in the row, after the Re-analyze button:

```tsx
                {lead.archivedAt !== null ? (
                  <Badge variant="secondary">{t('tiles.archived')}</Badge>
                ) : canArchive ? (
                  <button
                    type="button"
                    onClick={() => onArchive(lead)}
                    className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
                  >
                    {t('row.archive')}
                  </button>
                ) : null}
```

- [ ] **Step 9: Wire the page**

In `src/app/(dashboard)/lead-analysis/page.tsx`, add the mutation and handler beside the existing `handleReanalyze`, and pass `canArchive` / `onArchive` to the board:

```tsx
  const archive = useMutation(api.conversations.archive);
  const canArchive =
    accountRole === 'supervisor' ||
    accountRole === 'admin' ||
    accountRole === 'owner';

  const handleArchive = useCallback(
    async (lead: LeadAnalysisRow) => {
      try {
        await archive({
          conversationId: lead.conversationId as Id<'conversations'>,
        });
        toast.success(t('archiveQueued'));
      } catch (err) {
        console.error('Failed to archive conversation:', err);
        toast.error(t('archiveError'));
      }
    },
    [archive, t],
  );
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `npx vitest run src/components/lead-analysis/ convex/leadAnalysis.test.ts`
Expected: PASS.

- [ ] **Step 11: Full verification**

Run: `npm run typecheck && npx eslint src/components/lead-analysis/ "src/app/(dashboard)/lead-analysis/page.tsx" convex/leadAnalysis.ts && npx vitest run`
Expected: clean, all PASS.

- [ ] **Step 12: Commit**

```bash
git add src/components/lead-analysis/ "src/app/(dashboard)/lead-analysis/page.tsx" convex/leadAnalysis.ts convex/leadAnalysis.test.ts messages/en.json
git commit -m "$(cat <<'EOF'
feat(archive): archive a lead from the Lead Analysis board

The board keeps showing archived leads — it is the review surface for
what was archived, and the Archived tile is how you find them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Deployment (owner-run, after all tasks land)

One deploy: `npx convex deploy`, run by the owner. No agent session runs it.

P2 is inert on arrival in the strongest sense — with no archived rows in existence, `eq("archivedAt", undefined)` matches every conversation and the inbox behaves exactly as it does today. The first behavioural change happens when a human clicks Archive.

No feature flag is involved: archive is deliberately ungated (see Global Constraints).

## What P2 deliberately does not do

The follow-up sequence engine, any automatic archive (including the `agedOutDays` sweep), bulk archive, template sends from the board, and the Lead Analysis config UI. All P3/P4, each with its own plan. No code path added here sends a WhatsApp message.
