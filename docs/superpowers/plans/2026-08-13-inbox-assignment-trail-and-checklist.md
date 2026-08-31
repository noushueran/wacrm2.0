# Inbox assignment trail + in-thread sales checklist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a small line in the Inbox thread whenever a chat changes hands, and let the assigned salesperson work the sales checklist from the Inbox instead of walking back to Leads.

**Architecture:** A new `conversationEvents` table is written by exactly one helper, `applyAssignment`, that all seven `assignedToUserId` write paths route through — so the field cannot move without the timeline recording it. The thread already merges non-message items (contact notes) into its date groups via a pure function; that function is generalised to interleave events too. The checklist half is mostly assembly: `LeadChecklist` is already presentational and `setItemDone` already gates on the assignee, so only a per-conversation read and a sidebar section are new.

**Tech Stack:** Convex (schema, queries, mutations), Next.js 15 App Router, React 19, TypeScript, next-intl, Tailwind, Vitest + convex-test.

**Spec:** `docs/superpowers/specs/2026-08-13-inbox-assignment-trail-and-checklist-design.md`

## Global Constraints

- **Never run `npx convex deploy`, `convex dev`, or `convex codegen`.** The owner runs those. See "Codegen gate" below.
- **Never run prettier.** Match surrounding formatting by hand.
- **Scope lint to changed files:** `npx eslint <paths>` — never the whole repo.
- **Stage git paths explicitly.** `git add <specific paths>`; never `git add -A` or `git add .`. The working tree contains unrelated in-progress work (contact-avatar) that must not be committed.
- **Additive edits only** to `messages/en.json`, `convex/schema.ts`, `src/components/inbox/contact-sidebar.tsx` and `src/components/inbox/message-thread.tsx` — all four have uncommitted changes from other work. Never revert or reformat lines you did not add.
- **Run tests with** `npx vitest run <path>` for a single file, `npx vitest run` for all.
- Staff email is PII below admin role: resolve member display names as `fullName ?? "Member"`, **never** fall back to email.
- Existing behaviour that must not change: `chargeLeadIfAgent`, `insertNotification` and `dispatchConversationAssigned` keep firing on exactly the conditions they fire on today.

### Codegen gate

`convex/generatedApi.test.ts` asserts every `.ts` file under `convex/` appears in the committed `convex/_generated/api.d.ts`. Task 1 creates **one** new module, `convex/lib/assignment.ts`. From that point until the owner runs `npx convex codegen`, the single test `generatedApi.test.ts > registers lib/assignment` **will fail**. That is expected and is the only acceptable failing test in this plan. Every other test must pass at every commit. Adding *exports* to existing modules does not trip the guard.

---

## File Structure

**Create:**
- `convex/lib/assignment.ts` — the one write path for `assignedToUserId` + its event.
- `convex/lib/assignment.test.ts` — helper behaviour under convex-test.
- `src/lib/inbox/assignmentEvents.ts` — pure sentence selection (which i18n key + which names) for an event row.
- `src/lib/inbox/assignmentEvents.test.ts`
- `src/components/inbox/assignment-event.tsx` — the pill. Presentational only.

**Modify:**
- `convex/schema.ts` — add the `conversationEvents` table.
- `convex/conversations.ts` — route 4 paths through the helper; add `listEvents`.
- `convex/inboxChaseAssign.ts`, `convex/qualificationEngine.ts`, `convex/automationsEngine.ts` — route their path through the helper.
- `convex/lib/salesChecklist.ts` — gain the shared `projectChecklist` projection.
- `convex/qualification.ts` — `leadsBoard` uses the shared projection.
- `convex/salesChecklists.ts` — add `forConversation`; stamp `conversationId` on the notes it writes.
- `src/lib/inbox/notes.ts` — generalise the merge to interleave events.
- `src/components/inbox/message-thread.tsx` — subscribe to events, render pills.
- `src/components/inbox/contact-sidebar.tsx` — the checklist section.
- `messages/en.json` — new keys.

---

## Task 1: `conversationEvents` table + the `applyAssignment` helper

**Files:**
- Modify: `convex/schema.ts`
- Create: `convex/lib/assignment.ts`
- Test: `convex/lib/assignment.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `applyAssignment(ctx, args): Promise<boolean>` and `type AssignmentSource`. Returns `true` when the assignee genuinely changed (Task 2's call sites use this in place of their own `previousAssignee !== next` guards).

- [ ] **Step 1: Add the table to the schema**

In `convex/schema.ts`, insert this immediately **after** the `notifications` table definition (keeping the file's habit of a prose header per table):

```ts
  // Ownership history for one conversation — the Inbox thread's inline
  // "X assigned this to Y" line. `conversations.assignedToUserId` is a
  // bare field with no history: before this table the only trace of a
  // handover was a private `notifications` row to the recipient, so
  // "who gave me this, and when" was unanswerable by anyone else.
  //
  // Deliberately NOT `contactNotes`: notes are user-deletable
  // (`contactNotes.remove`), they store a baked English sentence (this
  // UI is translated and members get renamed), and they are the
  // AI-processable trail that `contactActivity` reads — assignment
  // churn belongs in none of those.
  //
  // `kind` is what happened to ownership; `source` is which machinery
  // did it. Separate on purpose: a new entry point adds one `source`
  // literal instead of a branch in the renderer. `actorUserId` absent
  // means the system did it (sweep, automation, cron). Written by
  // exactly one function — `lib/assignment.ts`'s `applyAssignment` —
  // and never updated or deleted.
  conversationEvents: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    kind: v.union(v.literal("assigned"), v.literal("unassigned")),
    actorUserId: v.optional(v.id("users")),
    targetUserId: v.optional(v.id("users")),
    previousUserId: v.optional(v.id("users")),
    source: v.union(
      v.literal("manual"),
      v.literal("takeover"),
      v.literal("release"),
      v.literal("auto_assign"),
      v.literal("automation"),
      v.literal("offer_accept"),
    ),
  }).index("by_conversation", ["conversationId"]),
```

- [ ] **Step 2: Write the failing test**

Create `convex/lib/assignment.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import { applyAssignment } from "./assignment";

const modules = import.meta.glob("/convex/**/*.ts");

/** Account + two members + a contact + a conversation owned by nobody. */
async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const alice = await ctx.db.insert("users", { name: "Alice", email: "a@x.co" });
    const bob = await ctx.db.insert("users", { name: "Bob", email: "b@x.co" });
    const accountId = await ctx.db.insert("accounts", {
      name: "Acme", defaultCurrency: "AED", ownerUserId: alice,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000000", phoneNormalized: "971500000000",
      name: "Customer",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0, updatedAt: 1000,
    });
    return { alice, bob, accountId, contactId, conversationId };
  });
}

const eventsOf = (t: ReturnType<typeof convexTest>, conversationId: Id<"conversations">) =>
  t.run((ctx) =>
    ctx.db
      .query("conversationEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );

test("assigning an unowned conversation writes one 'assigned' event", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);

  const changed = await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    return await applyAssignment(ctx, {
      conversation,
      nextAssignee: s.bob,
      actorUserId: s.alice,
      source: "manual",
    });
  });

  expect(changed).toBe(true);
  const events = await eventsOf(t, s.conversationId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    accountId: s.accountId,
    contactId: s.contactId,
    kind: "assigned",
    actorUserId: s.alice,
    targetUserId: s.bob,
    source: "manual",
  });
  expect(events[0].previousUserId).toBeUndefined();

  const after = await t.run((ctx) => ctx.db.get(s.conversationId));
  expect(after!.assignedToUserId).toBe(s.bob);
});

test("re-saving the same assignee writes nothing and returns false", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await t.run((ctx) => ctx.db.patch(s.conversationId, { assignedToUserId: s.bob }));

  const changed = await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    return await applyAssignment(ctx, {
      conversation, nextAssignee: s.bob, actorUserId: s.alice, source: "manual",
    });
  });

  expect(changed).toBe(false);
  expect(await eventsOf(t, s.conversationId)).toHaveLength(0);
});

test("a reassignment records who held it before", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await t.run((ctx) => ctx.db.patch(s.conversationId, { assignedToUserId: s.alice }));

  await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    await applyAssignment(ctx, {
      conversation, nextAssignee: s.bob, actorUserId: s.alice, source: "manual",
    });
  });

  const events = await eventsOf(t, s.conversationId);
  expect(events[0]).toMatchObject({
    kind: "assigned", previousUserId: s.alice, targetUserId: s.bob,
  });
});

test("releasing writes 'unassigned' with no target and clears the field", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);
  await t.run((ctx) => ctx.db.patch(s.conversationId, { assignedToUserId: s.bob }));

  const changed = await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    return await applyAssignment(ctx, {
      conversation, nextAssignee: undefined, source: "release",
    });
  });

  expect(changed).toBe(true);
  const events = await eventsOf(t, s.conversationId);
  expect(events[0]).toMatchObject({
    kind: "unassigned", previousUserId: s.bob, source: "release",
  });
  expect(events[0].targetUserId).toBeUndefined();
  expect(events[0].actorUserId).toBeUndefined();

  const after = await t.run((ctx) => ctx.db.get(s.conversationId));
  expect(after!.assignedToUserId).toBeUndefined();
});

test("unassigning an already-unowned conversation is a no-op", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);

  const changed = await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    return await applyAssignment(ctx, {
      conversation, nextAssignee: undefined, source: "manual",
    });
  });

  expect(changed).toBe(false);
  expect(await eventsOf(t, s.conversationId)).toHaveLength(0);
});

test("bumpUpdatedAt false leaves updatedAt alone", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);

  await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    await applyAssignment(ctx, {
      conversation, nextAssignee: s.bob, source: "automation", bumpUpdatedAt: false,
    });
  });

  const after = await t.run((ctx) => ctx.db.get(s.conversationId));
  expect(after!.updatedAt).toBe(1000);
  expect(after!.assignedToUserId).toBe(s.bob);
});

test("the helper never touches status", async () => {
  const t = convexTest(schema, modules);
  const s = await seed(t);

  await t.run(async (ctx) => {
    const conversation = (await ctx.db.get(s.conversationId))!;
    await applyAssignment(ctx, {
      conversation, nextAssignee: s.bob, actorUserId: s.alice, source: "manual",
    });
  });

  const after = await t.run((ctx) => ctx.db.get(s.conversationId));
  expect(after!.status).toBe("open");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run convex/lib/assignment.test.ts`
Expected: FAIL — cannot resolve `./assignment`.

- [ ] **Step 4: Write the helper**

Create `convex/lib/assignment.ts`:

```ts
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/** Which machinery moved the assignment. `kind` (assigned/unassigned) says
 *  what happened to ownership; this says who or what did it, and is what
 *  the thread's line is phrased from. A new entry point adds a literal
 *  here rather than a branch in the renderer. */
export type AssignmentSource =
  | "manual"
  | "takeover"
  | "release"
  | "auto_assign"
  | "automation"
  | "offer_accept";

/**
 * THE way `conversations.assignedToUserId` changes. Patches the field and
 * records the handover in `conversationEvents` in one step, so the two can
 * never drift: seven code paths assign conversations, and seven separate
 * inserts would be seven chances to forget one.
 *
 * Returns `true` when the assignee genuinely changed. Callers use that in
 * place of their own `previousAssignee !== next` guard — the same
 * double-click guard `conversations.assign` carried, now shared.
 *
 * Deliberately does NOT touch `status`: `assign` bumps it to "pending"
 * while `setAutoreplyPaused` documents that it must not, and that
 * divergence belongs with the callers. `bumpUpdatedAt` defaults true;
 * `automationsEngine` passes false because its comment records that
 * matching the legacy path's "no status/updatedAt bump" is deliberate.
 *
 * `ctx` is structurally typed (the `chargeLeadIfAgent` precedent) so this
 * works from `accountMutation` handlers and from the bare
 * `{db, scheduler}` cores in `qualificationEngine.ts` alike.
 */
export async function applyAssignment(
  ctx: { db: MutationCtx["db"] },
  args: {
    conversation: Doc<"conversations">;
    /** `undefined` releases the thread back to the pool. */
    nextAssignee: Id<"users"> | undefined;
    /** Omit when the system did it — that absence is what the UI reads. */
    actorUserId?: Id<"users">;
    source: AssignmentSource;
    bumpUpdatedAt?: boolean;
  },
): Promise<boolean> {
  const { conversation, nextAssignee, actorUserId, source } = args;
  const previous = conversation.assignedToUserId;
  if (previous === nextAssignee) return false;

  await ctx.db.patch(conversation._id, {
    assignedToUserId: nextAssignee,
    ...(args.bumpUpdatedAt === false ? {} : { updatedAt: Date.now() }),
  });

  await ctx.db.insert("conversationEvents", {
    accountId: conversation.accountId,
    conversationId: conversation._id,
    contactId: conversation.contactId,
    kind: nextAssignee ? "assigned" : "unassigned",
    ...(actorUserId ? { actorUserId } : {}),
    ...(nextAssignee ? { targetUserId: nextAssignee } : {}),
    ...(previous ? { previousUserId: previous } : {}),
    source,
  });

  return true;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run convex/lib/assignment.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Confirm the codegen guard is the only new failure**

Run: `npx vitest run convex/generatedApi.test.ts`
Expected: exactly one failure — `registers lib/assignment`. This is the documented gate; do not attempt to fix it by running codegen.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/lib/assignment.ts convex/lib/assignment.test.ts
git add convex/schema.ts convex/lib/assignment.ts convex/lib/assignment.test.ts
git commit -m "feat(inbox): record conversation assignment handovers

Adds conversationEvents plus the single applyAssignment helper that
patches assignedToUserId and writes the event together, so the field
cannot move without the timeline recording it."
```

---

## Task 2: Route all seven write paths through the helper

**Files:**
- Modify: `convex/conversations.ts` (`assign`, `unassign`, `setAutoreplyPaused` ×2)
- Modify: `convex/inboxChaseAssign.ts:211-215`
- Modify: `convex/qualificationEngine.ts:2346-2349`
- Modify: `convex/automationsEngine.ts:2523-2524`
- Test: `convex/conversations.test.ts` (extend)

**Interfaces:**
- Consumes: `applyAssignment(ctx, {conversation, nextAssignee, actorUserId?, source, bumpUpdatedAt?}) => Promise<boolean>` from Task 1.
- Produces: nothing new. Every existing exported signature is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `convex/conversations.test.ts`, reusing the helpers that file already defines: `seedAccountMember(t, {name, email, role}) => {userId, accountId, asUser}`, `seedTeammate(t, {accountId, name, email, role}) => userId` (a bare id, no client), and `seedConversation(t, {accountId, contactId}) => conversationId`. Contacts come from `api.contacts.create`, the idiom the surrounding tests already use.

Add this local reader beside the other helpers so the five tests below don't repeat it:

```ts
const eventsOf = (
  t: ReturnType<typeof convexTest>,
  conversationId: Id<"conversations">,
) =>
  t.run((ctx) =>
    ctx.db
      .query("conversationEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
```

```ts
test("assign records a manual handover on the timeline", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const agentId = await seedTeammate(t, {
    accountId, name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });

  const events = await eventsOf(t, conversationId);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "assigned", source: "manual",
    actorUserId: userId, targetUserId: agentId,
  });
});

test("assign still bumps status to pending", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const agentId = await seedTeammate(t, {
    accountId, name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });

  const after = await t.run((ctx) => ctx.db.get(conversationId));
  expect(after!.status).toBe("pending");
});

test("assigning the same person twice records only one event", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const agentId = await seedTeammate(t, {
    accountId, name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });
  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });

  expect(await eventsOf(t, conversationId)).toHaveLength(1);
});

test("unassign records the release and who held it", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const agentId = await seedTeammate(t, {
    accountId, name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });
  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });

  await asUser.mutation(api.conversations.unassign, { conversationId });

  const events = await eventsOf(t, conversationId);
  expect(events).toHaveLength(2);
  expect(events[1]).toMatchObject({
    kind: "unassigned", source: "manual",
    actorUserId: userId, previousUserId: agentId,
  });
});

test("taking over records a takeover, resuming AI records a release", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.setAutoreplyPaused, {
    conversationId, paused: true, assignToMe: true,
  });
  await asUser.mutation(api.conversations.setAutoreplyPaused, {
    conversationId, paused: false,
  });

  const events = await eventsOf(t, conversationId);
  expect(events.map((e) => e.source)).toEqual(["takeover", "release"]);
  expect(events[0]).toMatchObject({
    kind: "assigned", actorUserId: userId, targetUserId: userId,
  });
  expect(events[1]).toMatchObject({
    kind: "unassigned", previousUserId: userId,
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run convex/conversations.test.ts`
Expected: the five new tests FAIL (0 events found). Pre-existing tests still pass.

- [ ] **Step 3: Route `conversations.assign`**

Add to the imports at the top of `convex/conversations.ts`:

```ts
import { applyAssignment } from "./lib/assignment";
```

In `assign`, replace the block that reads

```ts
    const previousAssignee = conversation.assignedToUserId;

    await ctx.db.patch(args.conversationId, {
      assignedToUserId: args.userId,
      status: "pending",
      updatedAt: Date.now(),
    });

    await chargeLeadIfAgent(ctx, ctx.accountId, args.userId, args.conversationId);

    // Only a real change of hands is an assignment event — re-saving the
    // same assignee (a double-clicked Assign button) must not re-fire.
    if (previousAssignee !== args.userId) {
```

with

```ts
    // `applyAssignment` owns the field + the timeline row and reports
    // whether this was a real change of hands — the guard that used to
    // be a local `previousAssignee !== args.userId` here. `status` stays
    // this mutation's own business: assigning IS the start of someone
    // working the thread, which `setAutoreplyPaused` deliberately is not.
    const changed = await applyAssignment(ctx, {
      conversation,
      nextAssignee: args.userId,
      actorUserId: ctx.userId,
      source: "manual",
    });
    await ctx.db.patch(args.conversationId, { status: "pending" });

    await chargeLeadIfAgent(ctx, ctx.accountId, args.userId, args.conversationId);

    if (changed) {
```

- [ ] **Step 4: Route `conversations.unassign`**

In `unassign`, replace

```ts
    await requireConversationAccess(ctx, args.conversationId, "own");
    await ctx.db.patch(args.conversationId, {
      assignedToUserId: undefined,
      updatedAt: Date.now(),
    });
    return args.conversationId;
```

with

```ts
    const conversation = await requireConversationAccess(
      ctx,
      args.conversationId,
      "own",
    );
    await applyAssignment(ctx, {
      conversation,
      nextAssignee: undefined,
      actorUserId: ctx.userId,
      source: "manual",
    });
    return args.conversationId;
```

- [ ] **Step 5: Route both `setAutoreplyPaused` branches**

Replace the whole `if (args.paused) { ... } else { ... }` body with:

```ts
    if (args.paused) {
      await ctx.db.patch(args.conversationId, {
        aiAutoreplyDisabled: true,
        updatedAt: Date.now(),
      });

      if (args.assignToMe) {
        // Taking over a thread IS an assignment, even though it's a
        // self-assignment the notification path deliberately skips.
        const changed = await applyAssignment(ctx, {
          conversation,
          nextAssignee: ctx.userId,
          actorUserId: ctx.userId,
          source: "takeover",
        });
        await chargeLeadIfAgent(ctx, ctx.accountId, ctx.userId, args.conversationId);
        if (changed) {
          await dispatchConversationAssigned(ctx, {
            accountId: ctx.accountId,
            conversationId: args.conversationId,
            contactId: conversation.contactId,
            agentId: ctx.userId,
          });
        }
      }
    } else {
      await ctx.db.patch(args.conversationId, {
        aiAutoreplyDisabled: false,
        aiReplyCount: 0,
        aiHandoffSummary: undefined,
        updatedAt: Date.now(),
      });
      // Resume AI releases ANY assignment, not just the caller's own —
      // a stale assignee keeps the "human owns this" gate tripped. No
      // actor: the AI resuming is what released it, not a person
      // handing the thread to someone.
      await applyAssignment(ctx, {
        conversation,
        nextAssignee: undefined,
        source: "release",
      });
    }
```

- [ ] **Step 6: Run the conversations tests**

Run: `npx vitest run convex/conversations.test.ts`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 7: Route the auto-assign sweep**

In `convex/inboxChaseAssign.ts`, add `import { applyAssignment } from "./lib/assignment";` to the imports, then replace

```ts
        const previousAssignee = conversation.assignedToUserId;
        await ctx.db.patch(conversation._id, {
          assignedToUserId: picked,
          updatedAt: Date.now(),
        });
        await notifyAssigned(ctx, conversation, picked);
        if (previousAssignee !== picked) {
```

with

```ts
        // No `actorUserId`: the sweep is the system, and that absence is
        // what makes the thread's line read "Auto-assigned to …".
        const changed = await applyAssignment(ctx, {
          conversation,
          nextAssignee: picked,
          source: "auto_assign",
        });
        await notifyAssigned(ctx, conversation, picked);
        if (changed) {
```

- [ ] **Step 8: Route the WhatsApp offer accept**

In `convex/qualificationEngine.ts`, add `import { applyAssignment } from "./lib/assignment";` to the imports, then inside `acceptOfferCore` replace

```ts
  await ctx.db.patch(offer.conversationId, {
    assignedToUserId: offer.agentUserId,
    updatedAt: now,
  });
```

with

```ts
  // The agent accepted the offer themselves, so they are both actor and
  // target. Guarded above: this branch is only reached when the
  // conversation was still unassigned.
  await applyAssignment(ctx, {
    conversation,
    nextAssignee: offer.agentUserId,
    actorUserId: offer.agentUserId,
    source: "offer_accept",
  });
```

- [ ] **Step 9: Route the automation step**

In `convex/automationsEngine.ts`, add `import { applyAssignment } from "./lib/assignment";` to the imports, then replace

```ts
          const previousAssignee = conversation.assignedToUserId;
          await ctx.db.patch(conversation._id, { assignedToUserId: agentId });
```

with

```ts
          // `bumpUpdatedAt: false` — the original updated by
          // (account_id, contact_id) with no status/updatedAt bump, and
          // matching that exactly is deliberate (see the comment above).
          const changed = await applyAssignment(ctx, {
            conversation,
            nextAssignee: agentId,
            source: "automation",
            bumpUpdatedAt: false,
          });
```

and change the dispatch guard from `if (previousAssignee !== agentId && contactId) {` to `if (changed && contactId) {`.

- [ ] **Step 10: Run the full suite**

Run: `npx vitest run`
Expected: everything passes except the single known `generatedApi.test.ts > registers lib/assignment`. Pay particular attention to `automationsEngine`, `qualificationEngine` and `inboxChaseAssign` suites — they assert the existing assignment behaviour.

- [ ] **Step 11: Lint and commit**

```bash
npx eslint convex/conversations.ts convex/inboxChaseAssign.ts convex/qualificationEngine.ts convex/automationsEngine.ts convex/conversations.test.ts
git add convex/conversations.ts convex/inboxChaseAssign.ts convex/qualificationEngine.ts convex/automationsEngine.ts convex/conversations.test.ts
git commit -m "refactor(inbox): route every assignment write through applyAssignment

All seven paths that move assignedToUserId now go through one helper, so
each records its handover and each shares the same no-op guard. Status
bumping and the automation path's deliberate updatedAt omission are
preserved at the call sites."
```

---

## Task 3: `conversations.listEvents`

**Files:**
- Modify: `convex/conversations.ts`
- Test: `convex/conversations.test.ts` (extend)

**Interfaces:**
- Consumes: the `conversationEvents` table from Task 1.
- Produces: `api.conversations.listEvents({conversationId})` returning
  `Array<{_id: string; _creationTime: number; kind: "assigned" | "unassigned"; source: AssignmentSource; actorName: string | null; targetName: string | null; previousName: string | null; actorUserId: string | null; targetUserId: string | null}>`, oldest first. Tasks 4 and 5 consume exactly this shape.

- [ ] **Step 1: Write the failing test**

Append to `convex/conversations.test.ts`:

```ts
test("listEvents returns handovers oldest-first with resolved names", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const agentId = await seedTeammate(t, {
    accountId, name: "Agent", email: "agent@example.com", role: "agent",
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.assign, { conversationId, userId: agentId });
  await asUser.mutation(api.conversations.unassign, { conversationId });

  const events = await asUser.query(api.conversations.listEvents, { conversationId });

  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    kind: "assigned", source: "manual", actorName: "Owner", targetName: "Agent",
  });
  expect(events[1]).toMatchObject({
    kind: "unassigned", source: "manual", actorName: "Owner", previousName: "Agent",
  });
  expect(events[0]._creationTime).toBeLessThanOrEqual(events[1]._creationTime);
});

test("listEvents never leaks a member email as a name", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  // A membership with no fullName — the fallback must be the generic
  // word, never the email sitting right beside it.
  const namelessId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("users", {
      name: "N", email: "nameless@example.com",
    });
    await ctx.db.insert("memberships", {
      userId: id, accountId, role: "agent", email: "nameless@example.com",
    });
    return id;
  });
  const contactId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, { accountId, contactId });

  await asUser.mutation(api.conversations.assign, {
    conversationId, userId: namelessId,
  });

  const events = await asUser.query(api.conversations.listEvents, { conversationId });
  expect(events[0].targetName).toBe("Member");
});

test("listEvents refuses a conversation the caller cannot reach", async () => {
  const t = convexTest(schema, modules);
  const owner = await seedAccountMember(t, {
    name: "Owner", email: "owner@example.com", role: "admin",
  });
  const other = await seedAccountMember(t, {
    name: "Other", email: "other@example.com", role: "admin",
  });
  const contactId = await owner.asUser.mutation(api.contacts.create, { phone: "111" });
  const conversationId = await seedConversation(t, {
    accountId: owner.accountId, contactId,
  });

  await expect(
    other.asUser.query(api.conversations.listEvents, { conversationId }),
  ).rejects.toThrow();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/conversations.test.ts -t listEvents`
Expected: FAIL — `listEvents` is not a function on `api.conversations`.

- [ ] **Step 3: Implement the query**

Add to `convex/conversations.ts`, immediately after `unassign`:

```ts
/**
 * One conversation's ownership history, OLDEST first — the thread renders
 * these inline beside messages and notes, the same chronological order
 * `contactNotes.listForConversation` uses.
 *
 * Names are resolved here rather than client-side so the thread doesn't
 * need a second membership subscription. `fullName ?? "Member"` mirrors
 * `leadsBoard`: `members.list` nulls email below admin as staff PII, so
 * an email is never an acceptable fallback. A null name means the member
 * left the account; the UI has its own wording for that.
 *
 * `.collect()` is safe for the same reason it is on notes: rows here are
 * bounded by human handovers, not by message volume.
 */
export const listEvents = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireConversationAccess(ctx, args.conversationId, "view");

    const events = await ctx.db
      .query("conversationEvents")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("asc")
      .collect();
    if (events.length === 0) return [];

    const cache = new Map<Id<"users">, string | null>();
    const nameOf = async (userId: Id<"users"> | undefined) => {
      if (!userId) return null;
      const hit = cache.get(userId);
      if (hit !== undefined) return hit;
      // Binds both fields on `by_user_account` — a `by_user` scan can
      // surface a different account's membership row for a user who
      // belongs to several. Same idiom as `contactNotes`' `withAuthors`.
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_account", (q) =>
          q.eq("userId", userId).eq("accountId", ctx.accountId),
        )
        .first();
      const value = membership ? (membership.fullName ?? "Member") : null;
      cache.set(userId, value);
      return value;
    };

    const out = [];
    for (const e of events) {
      out.push({
        _id: e._id,
        _creationTime: e._creationTime,
        kind: e.kind,
        source: e.source,
        actorUserId: e.actorUserId ?? null,
        targetUserId: e.targetUserId ?? null,
        actorName: await nameOf(e.actorUserId),
        targetName: await nameOf(e.targetUserId),
        previousName: await nameOf(e.previousUserId),
      });
    }
    return out;
  },
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run convex/conversations.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint convex/conversations.ts convex/conversations.test.ts
git add convex/conversations.ts convex/conversations.test.ts
git commit -m "feat(inbox): read a conversation's ownership history

listEvents returns handovers oldest-first with member names resolved
server-side, gated by the same view access the thread already requires."
```

---

## Task 4: Interleave events into the thread timeline

**Files:**
- Modify: `src/lib/inbox/notes.ts`
- Test: `src/lib/inbox/notes.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from Convex — this file is pure and imports neither React nor Convex, by design.
- Produces:
  - `type TimelineItem<M, N, E> = {type:"message"; value:M} | {type:"note"; value:N} | {type:"event"; value:E}`
  - `mergeTimelineEntries<M, N, E, G>(groups, entries, getMessageTime)` where `entries: Array<{type:"note"; value:N} | {type:"event"; value:E}>` and both `N` and `E` extend `TimelineNote`.
  - `splitEarlierNotes` unchanged — Task 5 reuses it for events as-is.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/inbox/notes.test.ts` (and add `mergeTimelineEntries` to the existing import from `./notes`):

```ts
describe("mergeTimelineEntries", () => {
  const msg = (t: number) => ({ id: `m${t}`, at: t });
  const at = (m: { at: number }) => m.at;
  const note = (t: number) => ({ _id: `n${t}`, _creationTime: t });
  const evt = (t: number) => ({ _id: `e${t}`, _creationTime: t });

  test("places a note and an event in timestamp order between messages", () => {
    const groups = [{ date: "d1", messages: [msg(10), msg(40)] }];
    const out = mergeTimelineEntries(
      groups,
      [
        { type: "event" as const, value: evt(30) },
        { type: "note" as const, value: note(20) },
      ],
      at,
    );
    expect(out[0].items.map((i) => i.type)).toEqual([
      "message", "note", "event", "message",
    ]);
  });

  test("an entry newer than every message lands last in the final group", () => {
    const groups = [
      { date: "d1", messages: [msg(10)] },
      { date: "d2", messages: [msg(100)] },
    ];
    const out = mergeTimelineEntries(
      groups, [{ type: "event" as const, value: evt(500) }], at,
    );
    expect(out[1].items.map((i) => i.type)).toEqual(["message", "event"]);
  });

  test("an entry older than every message lands first in the first group", () => {
    const groups = [{ date: "d1", messages: [msg(100)] }];
    const out = mergeTimelineEntries(
      groups, [{ type: "event" as const, value: evt(5) }], at,
    );
    expect(out[0].items.map((i) => i.type)).toEqual(["event", "message"]);
  });

  test("with no messages at all, entries form one dateless group in order", () => {
    const out = mergeTimelineEntries(
      [],
      [
        { type: "event" as const, value: evt(20) },
        { type: "note" as const, value: note(10) },
      ],
      at,
    );
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("");
    expect(out[0].items.map((i) => i.type)).toEqual(["note", "event"]);
  });

  test("no entries leaves the groups untouched", () => {
    const groups = [{ date: "d1", messages: [msg(10), msg(20)] }];
    const out = mergeTimelineEntries(groups, [], at);
    expect(out[0].items.map((i) => i.type)).toEqual(["message", "message"]);
  });

  test("entries sharing a timestamp with a message sit after it", () => {
    const groups = [{ date: "d1", messages: [msg(10), msg(20)] }];
    const out = mergeTimelineEntries(
      groups, [{ type: "event" as const, value: evt(10) }], at,
    );
    expect(out[0].items.map((i) => i.type)).toEqual(["message", "event", "message"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/inbox/notes.test.ts`
Expected: FAIL — `mergeTimelineEntries` is not exported.

- [ ] **Step 3: Generalise the merge**

In `src/lib/inbox/notes.ts`, replace the `TimelineItem` type and the whole `mergeNotesIntoGroups` function with:

```ts
export type TimelineItem<M, N, E> =
  | { type: "message"; value: M }
  | { type: "note"; value: N }
  | { type: "event"; value: E };

/** A note or an ownership event, already tagged by the caller. Tagging up
 *  front rather than merging twice keeps ONE sorted pass, so a note and an
 *  event a second apart can never land in the wrong order. */
export type TimelineEntry<N, E> =
  | { type: "note"; value: N }
  | { type: "event"; value: E };

/**
 * Places each entry inside the existing date groups by timestamp, so the
 * thread reads as one story: customer said X, the chat came to me, I
 * called and they said Y, I sent the quote.
 *
 * Entries are assigned to a group rather than re-grouped by their own date
 * on purpose — the caller already owns date bucketing and its separators,
 * and duplicating that here would let the two drift. An entry newer than
 * every message lands in the last group; older than every message, the
 * first; with no messages at all, its own single group.
 */
export function mergeTimelineEntries<
  M,
  N extends TimelineNote,
  E extends TimelineNote,
  G extends { date: string; messages: M[] },
>(
  groups: G[],
  entries: Array<TimelineEntry<N, E>>,
  getMessageTime: (message: M) => number,
): Array<{ date: string; items: Array<TimelineItem<M, N, E>> }> {
  const sorted = [...entries].sort(
    (a, b) => a.value._creationTime - b.value._creationTime,
  );

  if (groups.length === 0) {
    if (sorted.length === 0) return [];
    return [{ date: "", items: sorted }];
  }

  const base = groups.map((group) => ({
    date: group.date,
    items: group.messages.map((value) => ({ type: "message" as const, value })),
  })) as Array<{ date: string; items: Array<TimelineItem<M, N, E>> }>;

  for (const entry of sorted) {
    // The last group whose first message starts at or before the entry.
    let target = 0;
    for (let i = 0; i < groups.length; i++) {
      const first = groups[i].messages[0];
      if (
        first !== undefined &&
        getMessageTime(first) <= entry.value._creationTime
      ) {
        target = i;
      }
    }

    const items = base[target].items;
    const at = items.findIndex(
      (item) =>
        item.type === "message" &&
        getMessageTime(item.value) > entry.value._creationTime,
    );
    if (at === -1) items.push(entry);
    else items.splice(at, 0, entry);
  }

  return base;
}
```

Also update the file's `splitEarlierNotes` doc comment: it now splits notes **and** events, both keyed on `_creationTime`. Leave its code unchanged.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/inbox/notes.test.ts`
Expected: PASS. Any pre-existing `mergeNotesIntoGroups` tests must be renamed to call `mergeTimelineEntries` with `{type: "note", value: n}`-tagged entries — do this now; do not leave a compatibility alias.

- [ ] **Step 5: Move the existing call site to the new name**

`message-thread.tsx` imports `mergeNotesIntoGroups`, so renaming it breaks the build. Update the call site **in this task** — every commit must type-check on its own. Events arrive in Task 5; this is the rename only.

In `src/components/inbox/message-thread.tsx`, change the import to

```tsx
import { splitEarlierNotes, mergeTimelineEntries } from "@/lib/inbox/notes";
```

and inside the existing memo, change the merge call to tag its notes:

```tsx
      timelineGroups: mergeTimelineEntries(
        messageGroups,
        inWindow.map((value) => ({ type: "note" as const, value })),
        (m: Message) => new Date(m.created_at).getTime(),
      ),
```

Leave everything else in that memo, and the render branches, exactly as they are.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: clean. If it is not, the call site above is not fully migrated — fix it here rather than deferring to Task 5.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint src/lib/inbox/notes.ts src/lib/inbox/notes.test.ts src/components/inbox/message-thread.tsx
git add src/lib/inbox/notes.ts src/lib/inbox/notes.test.ts src/components/inbox/message-thread.tsx
git commit -m "refactor(inbox): merge notes and ownership events in one timeline pass

Tagging entries before the merge keeps a single sorted insertion, so a
note and an event seconds apart cannot land out of order. Call site moved
to the new name in the same commit — no broken intermediate state."
```

---

## Task 5: The pill, and wiring it into the thread

**Files:**
- Create: `src/lib/inbox/assignmentEvents.ts`
- Create: `src/lib/inbox/assignmentEvents.test.ts`
- Create: `src/components/inbox/assignment-event.tsx`
- Modify: `messages/en.json`
- Modify: `src/components/inbox/message-thread.tsx`

**Interfaces:**
- Consumes: `api.conversations.listEvents` (Task 3), `mergeTimelineEntries` + `splitEarlierNotes` (Task 4).
- Produces: `assignmentEventLine(event): {key: string; values: Record<string, string>}` and the `<AssignmentEvent event={...} />` component.

- [ ] **Step 1: Write the failing test for the sentence chooser**

Create `src/lib/inbox/assignmentEvents.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { assignmentEventLine, type AssignmentEventView } from "./assignmentEvents";

const base: AssignmentEventView = {
  kind: "assigned",
  source: "manual",
  actorUserId: "u1",
  targetUserId: "u2",
  actorName: "Noushad",
  targetName: "Fathima",
  previousName: null,
};

describe("assignmentEventLine", () => {
  test("a manual handover names both people", () => {
    expect(assignmentEventLine(base)).toEqual({
      key: "assigned",
      values: { actor: "Noushad", target: "Fathima" },
    });
  });

  test("a manual handover from someone else names all three", () => {
    expect(assignmentEventLine({ ...base, previousName: "Rashid" })).toEqual({
      key: "reassigned",
      values: { actor: "Noushad", target: "Fathima", previous: "Rashid" },
    });
  });

  test("claiming a chat for yourself reads as taking it, not assigning it", () => {
    expect(
      assignmentEventLine({ ...base, targetUserId: "u1", targetName: "Noushad" }),
    ).toEqual({ key: "selfAssigned", values: { actor: "Noushad" } });
  });

  test("the auto-assign sweep has no actor and says so", () => {
    expect(
      assignmentEventLine({ ...base, source: "auto_assign", actorUserId: null, actorName: null }),
    ).toEqual({ key: "autoAssigned", values: { target: "Fathima" } });
  });

  test("an automation is named as the actor", () => {
    expect(
      assignmentEventLine({ ...base, source: "automation", actorUserId: null, actorName: null }),
    ).toEqual({ key: "automationAssigned", values: { target: "Fathima" } });
  });

  test("accepting the WhatsApp offer reads as accepting a lead", () => {
    expect(
      assignmentEventLine({
        ...base, source: "offer_accept", actorUserId: "u2", actorName: "Fathima",
      }),
    ).toEqual({ key: "offerAccepted", values: { target: "Fathima" } });
  });

  test("taking over from the AI is its own sentence", () => {
    expect(
      assignmentEventLine({
        ...base, source: "takeover", targetUserId: "u1", targetName: "Noushad",
      }),
    ).toEqual({ key: "takeover", values: { actor: "Noushad" } });
  });

  test("resuming the AI reads as a release, with no actor", () => {
    expect(
      assignmentEventLine({
        kind: "unassigned", source: "release", actorUserId: null, targetUserId: null,
        actorName: null, targetName: null, previousName: "Fathima",
      }),
    ).toEqual({ key: "released", values: { previous: "Fathima" } });
  });

  test("a manual unassign names who did it and who lost it", () => {
    expect(
      assignmentEventLine({
        kind: "unassigned", source: "manual", actorUserId: "u1", targetUserId: null,
        actorName: "Noushad", targetName: null, previousName: "Fathima",
      }),
    ).toEqual({ key: "unassigned", values: { actor: "Noushad", previous: "Fathima" } });
  });

  test("a departed member falls back to a neutral word, never an empty name", () => {
    expect(
      assignmentEventLine({ ...base, targetName: null }),
    ).toEqual({ key: "assigned", values: { actor: "Noushad", target: "__unknown__" } });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/inbox/assignmentEvents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sentence chooser**

Create `src/lib/inbox/assignmentEvents.ts`:

```ts
// ============================================================
// Pure sentence selection for one ownership event: which i18n key, and
// which names fill it. No React and no Convex import, so the branching
// is unit-testable without rendering — the same split
// `src/lib/inbox/notes.ts` and `threadHeader.ts` established.
// ============================================================

export type AssignmentEventSource =
  | "manual"
  | "takeover"
  | "release"
  | "auto_assign"
  | "automation"
  | "offer_accept";

/** Exactly the fields `conversations.listEvents` projects that the
 *  sentence depends on. */
export interface AssignmentEventView {
  kind: "assigned" | "unassigned";
  source: AssignmentEventSource;
  actorUserId: string | null;
  targetUserId: string | null;
  actorName: string | null;
  targetName: string | null;
  previousName: string | null;
}

/** Stand-in for a member who has left the account — `listEvents` returns
 *  a null name for them. The component swaps this for a translated word;
 *  it is a sentinel rather than English so this module stays language-free. */
export const UNKNOWN_MEMBER = "__unknown__";

const name = (value: string | null) => value ?? UNKNOWN_MEMBER;

/** Key under the `Inbox.assignmentEvents` namespace, plus its values. */
export function assignmentEventLine(event: AssignmentEventView): {
  key: string;
  values: Record<string, string>;
} {
  if (event.kind === "unassigned") {
    // Resume AI released the thread — nobody handed it anywhere.
    if (event.source === "release") {
      return { key: "released", values: { previous: name(event.previousName) } };
    }
    return {
      key: "unassigned",
      values: { actor: name(event.actorName), previous: name(event.previousName) },
    };
  }

  // System paths have no actor, and each names its own machinery rather
  // than pretending a person did it.
  if (event.source === "auto_assign") {
    return { key: "autoAssigned", values: { target: name(event.targetName) } };
  }
  if (event.source === "automation") {
    return { key: "automationAssigned", values: { target: name(event.targetName) } };
  }
  if (event.source === "offer_accept") {
    return { key: "offerAccepted", values: { target: name(event.targetName) } };
  }
  if (event.source === "takeover") {
    return { key: "takeover", values: { actor: name(event.actorName) } };
  }

  // Manual. Claiming a chat for yourself is "took", not "assigned to".
  if (event.actorUserId && event.actorUserId === event.targetUserId) {
    return { key: "selfAssigned", values: { actor: name(event.actorName) } };
  }
  if (event.previousName) {
    return {
      key: "reassigned",
      values: {
        actor: name(event.actorName),
        target: name(event.targetName),
        previous: event.previousName,
      },
    };
  }
  return {
    key: "assigned",
    values: { actor: name(event.actorName), target: name(event.targetName) },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/inbox/assignmentEvents.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Add the i18n keys**

In `messages/en.json`, add a new `assignmentEvents` block inside `Inbox`, placed right after the existing `notes` block. Add **only** these keys; touch nothing else in the file.

```json
    "assignmentEvents": {
      "assigned": "{actor} assigned this chat to {target}",
      "reassigned": "{actor} moved this chat from {previous} to {target}",
      "selfAssigned": "{actor} took this chat",
      "autoAssigned": "Auto-assigned to {target}",
      "automationAssigned": "An automation assigned this chat to {target}",
      "offerAccepted": "{target} accepted this lead",
      "takeover": "{actor} took over from the AI",
      "unassigned": "{actor} unassigned this chat from {previous}",
      "released": "Returned to the pool when the AI resumed",
      "unknownMember": "a former teammate"
    },
```

Then, in the `Inbox.notes` block, add one key beside `earlierNotes` (leave `earlierNotes` in place — it is still used for the pluralised noun elsewhere):

```json
      "earlierItems": "{count} earlier notes and updates",
```

- [ ] **Step 6: Build the pill**

Create `src/components/inbox/assignment-event.tsx`:

```tsx
"use client";

import { useTranslations } from "next-intl";
import { UserMinus, UserPlus } from "lucide-react";
import { format } from "date-fns";

import {
  assignmentEventLine,
  UNKNOWN_MEMBER,
  type AssignmentEventView,
} from "@/lib/inbox/assignmentEvents";

/**
 * One ownership handover, inline in the thread. Deliberately a centred
 * pill in the date separator's visual language rather than a card: it is
 * context for the conversation, not a contribution to it.
 *
 * All branching lives in `assignmentEventLine`; this only renders.
 */
export function AssignmentEvent({
  event,
}: {
  event: AssignmentEventView & { _creationTime: number };
}) {
  const t = useTranslations("Inbox.assignmentEvents");
  const { key, values } = assignmentEventLine(event);

  // `assignmentEventLine` stays language-free and emits a sentinel for a
  // member who has left; the translated word is substituted here.
  const resolved = Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      k,
      v === UNKNOWN_MEMBER ? t("unknownMember") : v,
    ]),
  );

  const Icon = event.kind === "assigned" ? UserPlus : UserMinus;

  return (
    <div className="flex justify-center py-1">
      <span className="inline-flex max-w-[85%] items-center gap-1.5 rounded-full bg-muted/60 px-2.5 py-0.5 text-[11px] text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{t(key, resolved)}</span>
        <span className="shrink-0 opacity-70">
          {format(new Date(event._creationTime), "HH:mm")}
        </span>
      </span>
    </div>
  );
}
```

- [ ] **Step 7: Wire it into the thread**

In `src/components/inbox/message-thread.tsx` (Task 4 already moved the import to `mergeTimelineEntries` — this task adds the events):

1. Add `import { AssignmentEvent } from "./assignment-event";`
2. Beside the existing `noteDocs` query, add:

```tsx
  const eventDocs = useQuery(
    api.conversations.listEvents,
    conversationId
      ? { conversationId: conversationId as Id<"conversations"> }
      : "skip",
  );
```

3. Replace the `earlierNotes` / `timelineGroups` memo with:

```tsx
  // Notes and ownership events render inline so the thread reads as one
  // story. `messageGroups` keeps owning date bucketing and its
  // separators; the merge only places entries inside groups it produced.
  const { earlierCount, timelineGroups } = useMemo(() => {
    const oldest = messageGroups[0]?.messages[0];
    const oldestAt = oldest ? new Date(oldest.created_at).getTime() : null;
    const notes = splitEarlierNotes(noteDocs ?? [], oldestAt);
    const events = splitEarlierNotes(eventDocs ?? [], oldestAt);
    return {
      earlierCount: notes.earlier.length + events.earlier.length,
      timelineGroups: mergeTimelineEntries(
        messageGroups,
        [
          ...notes.inWindow.map((value) => ({ type: "note" as const, value })),
          ...events.inWindow.map((value) => ({ type: "event" as const, value })),
        ],
        (m: Message) => new Date(m.created_at).getTime(),
      ),
    };
  }, [noteDocs, eventDocs, messageGroups]);
```

4. Replace the "earlier notes" pill's condition and copy:

```tsx
              {earlierCount > 0 && (
                <div className="flex justify-center pb-2">
                  <span className="rounded-full bg-amber-500/10 px-3 py-1 text-[11px] text-muted-foreground">
                    {tNotes("earlierItems", { count: earlierCount })}
                  </span>
                </div>
              )}
```

5. In the `group.items.map` body, add this branch **immediately before** the existing `if (item.type === "note")` branch:

```tsx
                      if (item.type === "event") {
                        return (
                          <AssignmentEvent
                            key={item.value._id}
                            event={item.value}
                          />
                        );
                      }
```

- [ ] **Step 8: Type-check and run the suite**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npx vitest run`
Expected: everything passes except the known `generatedApi.test.ts > registers lib/assignment`.

- [ ] **Step 9: Verify in the browser**

Start the dev server via `preview_start`, open `/inbox`, pick a conversation, assign it to a teammate from the thread header, and confirm a small centred pill appears in the thread reading "X assigned this chat to Y" with a time. Then unassign and confirm the second line. Check `read_console_messages` for errors and take a screenshot.

- [ ] **Step 10: Lint and commit**

```bash
npx eslint src/lib/inbox/assignmentEvents.ts src/lib/inbox/assignmentEvents.test.ts src/components/inbox/assignment-event.tsx src/components/inbox/message-thread.tsx
git add src/lib/inbox/assignmentEvents.ts src/lib/inbox/assignmentEvents.test.ts src/components/inbox/assignment-event.tsx src/components/inbox/message-thread.tsx messages/en.json
git commit -m "feat(inbox): show who assigned a chat, to whom, and when

A small centred pill in the thread, in the date separator's visual
language. Sentence selection is a pure tested function so the component
stays presentational and the system paths each name their own machinery."
```

---

## Task 6: Share the checklist projection and read it per conversation

**Files:**
- Modify: `convex/lib/salesChecklist.ts`
- Modify: `convex/qualification.ts` (`leadsBoard`)
- Modify: `convex/salesChecklists.ts`
- Test: `convex/salesChecklists.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `projectChecklist(row: Doc<"salesChecklists">, memberName: Map<Id<"users">, string>): ChecklistProjection` in `convex/lib/salesChecklist.ts`.
  - `api.salesChecklists.forConversation({conversationId})` returning `ChecklistProjection | null`, whose shape is exactly `LeadChecklistData` in `src/components/leads/lead-checklist.tsx`.

- [ ] **Step 1: Write the failing test**

Append to `convex/salesChecklists.test.ts`:

Use this file's existing `seedLead(t, {accountId, assignedToUserId?, status?, withChecklist?})` helper, which returns `{contactId, conversationId, sessionId, checklistId}`. Its seeded checklist has **two** items — `call` (not done) and `pitch` (already done, note `"done earlier"`) — so a freshly seeded projection is `total: 2, doneCount: 1`.

```ts
test("forConversation returns the checklist in the board's shape", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@x.com", role: "agent",
  });
  const { conversationId, checklistId } = await seedLead(t, {
    accountId, assignedToUserId: userId, withChecklist: true,
  });

  const projection = await asUser.query(api.salesChecklists.forConversation, {
    conversationId,
  });

  expect(projection).not.toBeNull();
  expect(projection!.checklistId).toBe(checklistId);
  expect(projection!.source).toBe("default");
  expect(projection!.total).toBe(2);
  expect(projection!.doneCount).toBe(1);
  expect(projection!.outcome).toBeNull();
  expect(projection!.items[0]).toMatchObject({
    key: "call", title: "Call the lead",
    done: false, doneAt: null, doneByName: null, note: null, description: null,
  });
  // Seeded as done but with no `doneByUserId` — the name must be null,
  // never a stray empty string.
  expect(projection!.items[1]).toMatchObject({
    key: "pitch", done: true, doneByName: null, note: "done earlier",
  });
});

test("forConversation is null when the conversation has no session", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@x.com", role: "agent",
  });
  const conversationId = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971509998877", phoneNormalized: "971509998877",
    });
    return await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
      assignedToUserId: userId,
    });
  });

  expect(
    await asUser.query(api.salesChecklists.forConversation, { conversationId }),
  ).toBeNull();
});

test("forConversation is null when a session has no checklist yet", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@x.com", role: "agent",
  });
  const { conversationId } = await seedLead(t, {
    accountId, assignedToUserId: userId, withChecklist: false,
  });

  expect(
    await asUser.query(api.salesChecklists.forConversation, { conversationId }),
  ).toBeNull();
});

test("forConversation refuses a conversation the caller cannot reach", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedAccountMember(t, {
    name: "Ann", email: "ann@x.com", role: "agent",
  });
  const other = await seedAccountMember(t, {
    name: "Bea", email: "bea@x.com", role: "admin",
  });
  const { conversationId } = await seedLead(t, {
    accountId: mine.accountId, assignedToUserId: mine.userId, withChecklist: true,
  });

  await expect(
    other.asUser.query(api.salesChecklists.forConversation, { conversationId }),
  ).rejects.toThrow();
});

test("a completed item reports who did it by name", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@x.com", role: "agent",
  });
  const { conversationId, checklistId } = await seedLead(t, {
    accountId, assignedToUserId: userId, withChecklist: true,
  });

  await asUser.mutation(api.salesChecklists.setItemDone, {
    checklistId: checklistId!, itemKey: "call", note: "Called, going ahead",
  });

  const projection = await asUser.query(api.salesChecklists.forConversation, {
    conversationId,
  });
  expect(projection!.doneCount).toBe(2);
  expect(projection!.items[0]).toMatchObject({
    key: "call", done: true, doneByName: "Ann", note: "Called, going ahead",
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/salesChecklists.test.ts`
Expected: the five new tests FAIL — `forConversation` is not a function.

- [ ] **Step 3: Extract the shared projection**

Append to `convex/lib/salesChecklist.ts`:

```ts
import type { Doc, Id } from "../_generated/dataModel";

/** Exactly the payload `LeadChecklist` renders — one shape shared by the
 *  Leads board and the Inbox panel, so adding an item field can never
 *  reach one surface and miss the other. */
export interface ChecklistProjection {
  checklistId: string;
  source: "kb" | "default";
  doneCount: number;
  total: number;
  outcome: {
    result: "won" | "lost";
    lossCategory: string | null;
    lossDetail: string | null;
    at: number;
  } | null;
  items: Array<{
    key: string;
    title: string;
    description: string | null;
    done: boolean;
    doneAt: number | null;
    doneByName: string | null;
    note: string | null;
  }>;
}

/** `memberName` is the caller's already-loaded userId → display name map;
 *  a miss yields null rather than an email (staff PII below admin). */
export function projectChecklist(
  row: Doc<"salesChecklists">,
  memberName: Map<Id<"users">, string>,
): ChecklistProjection {
  return {
    checklistId: row._id,
    source: row.source,
    doneCount: row.items.filter((i) => i.done).length,
    total: row.items.length,
    outcome: row.outcome
      ? {
          result: row.outcome.result,
          lossCategory: row.outcome.lossCategory ?? null,
          lossDetail: row.outcome.lossDetail ?? null,
          at: row.outcome.at,
        }
      : null,
    items: row.items.map((i) => ({
      key: i.key,
      title: i.title,
      description: i.description ?? null,
      done: i.done,
      doneAt: i.doneAt ?? null,
      doneByName: i.doneByUserId ? (memberName.get(i.doneByUserId) ?? null) : null,
      note: i.note ?? null,
    })),
  };
}
```

- [ ] **Step 4: Point `leadsBoard` at it**

In `convex/qualification.ts`, add `projectChecklist` (and `type ChecklistProjection`) to the existing import from `./lib/salesChecklist`, replace the inline `checklist: checklistRow ? { ... } : null` object with

```ts
          checklist: checklistRow ? projectChecklist(checklistRow, memberName) : null,
```

and replace the inline `checklist: { ... }` type annotation in the `leads` array declaration with `checklist: ChecklistProjection | null;`.

- [ ] **Step 5: Add the per-conversation query**

Append to `convex/salesChecklists.ts` (adding `accountQuery` to the existing `./lib/auth` import, and `projectChecklist` to the `./lib/salesChecklist` import):

```ts
/**
 * One conversation's sales checklist, for the Inbox contact panel — the
 * Leads board's payload without the board. Returns null when the
 * conversation never qualified or its checklist has not been generated
 * yet; the panel renders nothing at all in that case, matching
 * `QualificationChip`'s calm-by-default rule.
 *
 * Read access only ("view"): seeing the checklist is not working it.
 * `setItemDone`/`reopenItem` keep their own stricter "own" gate, which
 * is what makes the assigned salesperson the one who completes it.
 */
export const forConversation = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    await requireConversationAccess(ctx, args.conversationId, "view");

    const session = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .first();
    if (!session || session.accountId !== ctx.accountId) return null;

    const row = await ctx.db
      .query("salesChecklists")
      .withIndex("by_session", (q) => q.eq("sessionId", session._id))
      .first();
    if (!row || row.accountId !== ctx.accountId) return null;

    // Only the members who actually completed something — the board loads
    // every membership because it renders every lead; one thread needs at
    // most a handful.
    const memberName = new Map<Id<"users">, string>();
    for (const item of row.items) {
      if (!item.doneByUserId || memberName.has(item.doneByUserId)) continue;
      const membership = await ctx.db
        .query("memberships")
        .withIndex("by_user_account", (q) =>
          q.eq("userId", item.doneByUserId!).eq("accountId", ctx.accountId),
        )
        .first();
      if (membership) memberName.set(item.doneByUserId, membership.fullName ?? "Member");
    }

    return projectChecklist(row, memberName);
  },
});
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run convex/salesChecklists.test.ts convex/qualification.test.ts`
Expected: PASS — including the pre-existing `leadsBoard` tests, which must still see an identical checklist payload.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/lib/salesChecklist.ts convex/qualification.ts convex/salesChecklists.ts convex/salesChecklists.test.ts
git add convex/lib/salesChecklist.ts convex/qualification.ts convex/salesChecklists.ts convex/salesChecklists.test.ts
git commit -m "feat(inbox): read one conversation's sales checklist

Extracts the board's checklist projection into lib/salesChecklist so both
surfaces share one shape, then adds forConversation for the Inbox panel."
```

---

## Task 7: The checklist section in the contact panel

**Files:**
- Modify: `src/components/inbox/contact-sidebar.tsx`
- Modify: `messages/en.json`

**Interfaces:**
- Consumes: `api.salesChecklists.forConversation` (Task 6), the existing `LeadChecklist` component and the existing `salesChecklists.setItemDone` / `reopenItem` mutations.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the i18n key**

In `messages/en.json`, inside `Inbox.sidebar`, add:

```json
      "salesChecklist": "Sales checklist",
```

The panel reuses the existing `Leads.checklist.*` strings for everything inside it — do not duplicate them.

- [ ] **Step 2: Wire the section**

In `src/components/inbox/contact-sidebar.tsx`:

1. Add these imports (add `ListChecks` to the existing `lucide-react` import rather than a second one; `useCallback`, `useMutation`, `useQuery` and `useTranslations` are already imported in this file):

```tsx
import { ListChecks } from "lucide-react";
import { LeadChecklist } from "@/components/leads/lead-checklist";
import { hasMinRole } from "@/lib/auth/roles";
import { convexErrorData } from "@/lib/convex/adapters";
import { toast } from "sonner";
```

2. Inside the component, beside the existing `qualificationSession` query. `user` and `accountRole` come from the `useAuth()` call already at the top of this component, and `conversation` is the `api.conversations.get` query already there for the status header — no new subscriptions beyond the checklist itself:

```tsx
  const checklist = useQuery(
    api.salesChecklists.forConversation,
    conversationId
      ? { conversationId: conversationId as Id<"conversations"> }
      : "skip",
  );
  const setItemDone = useMutation(api.salesChecklists.setItemDone);
  const reopenItem = useMutation(api.salesChecklists.reopenItem);
  const tChecklist = useTranslations("Leads.checklist");

  const handleCompleteItem = useCallback(
    async (itemKey: string, note: string) => {
      if (!checklist) return;
      try {
        await setItemDone({
          checklistId: checklist.checklistId as Id<"salesChecklists">,
          itemKey,
          note,
        });
      } catch (err) {
        // Same reason mapping the Leads board uses — the server rejects a
        // completion with no note, and the agent must be told which rule
        // they hit rather than a generic failure.
        const reason = convexErrorData(err)?.reason;
        toast.error(
          reason === "note_required"
            ? tChecklist("noteRequired")
            : tChecklist("updateError"),
        );
      }
    },
    [checklist, setItemDone, tChecklist],
  );

  const handleReopenItem = useCallback(
    async (itemKey: string) => {
      if (!checklist) return;
      try {
        await reopenItem({
          checklistId: checklist.checklistId as Id<"salesChecklists">,
          itemKey,
        });
      } catch {
        toast.error(tChecklist("updateError"));
      }
    },
    [checklist, reopenItem, tChecklist],
  );
```

3. Render the section immediately **before** the "Active Deals" block, so the checklist sits above deals but below labels:

```tsx
          {/* Sales checklist — only for a lead that has qualified and had
              one generated. Absent for every other chat, which is most of
              them: the panel stays calm, the same rule `QualificationChip`
              follows in the header. */}
          {checklist && (
            <>
              <Divider />
              <div>
                <SectionLabel icon={ListChecks} label={tSidebar("salesChecklist")} />
                <div className="mt-2">
                  <LeadChecklist
                    checklist={checklist}
                    canEdit={canWorkThisLead}
                    onCompleteItem={handleCompleteItem}
                    onReopenItem={handleReopenItem}
                  />
                </div>
              </div>
            </>
          )}
```

4. Define `canWorkThisLead` next to the queries, using the `conversation`, `user` and `accountRole` already in scope. The server is the real gate — `setItemDone` throws for anyone who is not the assignee or supervisor+ — so this only decides whether to render controls that would fail:

```tsx
  // Mirrors the server's `requireConversationAccess(..., "own")`: the
  // assigned salesperson works their own lead, supervisor+ works any.
  // `!!user?.id` guards the `undefined === undefined` false positive an
  // unassigned thread would otherwise produce while auth is loading —
  // the same trap `message-thread.tsx` documents for note ownership.
  const canWorkThisLead =
    (!!user?.id && conversation?.assignedToUserId === user.id) ||
    (accountRole ? hasMinRole(accountRole, "supervisor") : false);
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Verify in the browser**

With the dev server running, open a conversation whose lead has qualified (the Leads page lists them; pick one and open its chat). Confirm:
- the "Sales checklist" section appears in the right panel with the same items the Leads board shows;
- completing an item without a note is refused with the "note required" message;
- completing one with a note ticks it and shows who did it;
- a conversation that never qualified shows **no** checklist section at all;
- the panel drawer on a narrow viewport (`resize_window` to mobile) shows the same section.

Check `read_console_messages` for errors, and screenshot both the qualified and non-qualified cases.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint src/components/inbox/contact-sidebar.tsx
git add src/components/inbox/contact-sidebar.tsx messages/en.json
git commit -m "feat(inbox): work the sales checklist without leaving the chat

Adds the checklist to the contact panel, reusing the Leads board's
component and mutations unchanged, so the assigned salesperson ticks
items where the conversation is. Renders nothing when a chat has no
checklist, which is most of them."
```

---

## Task 8: Show checklist completions in the thread

**Files:**
- Modify: `convex/salesChecklists.ts` (`setItemDone`, `reopenItem`)
- Test: `convex/salesChecklists.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing. The completions surface through the thread's existing note rendering.

- [ ] **Step 1: Write the failing test**

Append to `convex/salesChecklists.test.ts`:

```ts
test("completing an item files its note against the conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@x.com", role: "agent",
  });
  const { conversationId, checklistId } = await seedLead(t, {
    accountId, assignedToUserId: userId, withChecklist: true,
  });

  await asUser.mutation(api.salesChecklists.setItemDone, {
    checklistId: checklistId!, itemKey: "call", note: "Called, going ahead",
  });

  // The thread reads notes by conversation — an unstamped note appears in
  // no thread at all, which is what this fixes.
  const inThread = await asUser.query(api.contactNotes.listForConversation, {
    conversationId,
  });
  expect(inThread).toHaveLength(1);
  expect(inThread[0].noteText).toContain("Called, going ahead");
});

test("reopening an item also files its note against the conversation", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, {
    name: "Ann", email: "ann@x.com", role: "agent",
  });
  const { conversationId, checklistId } = await seedLead(t, {
    accountId, assignedToUserId: userId, withChecklist: true,
  });

  await asUser.mutation(api.salesChecklists.setItemDone, {
    checklistId: checklistId!, itemKey: "call", note: "Called, going ahead",
  });
  await asUser.mutation(api.salesChecklists.reopenItem, {
    checklistId: checklistId!, itemKey: "call",
  });

  const inThread = await asUser.query(api.contactNotes.listForConversation, {
    conversationId,
  });
  expect(inThread).toHaveLength(2);
  expect(inThread[1].noteText).toContain("reopened");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/salesChecklists.test.ts -t "files its note against the conversation"`
Expected: FAIL — 0 notes, because the rows carry no `conversationId`.

- [ ] **Step 3: Stamp the conversation**

In `convex/salesChecklists.ts`, in **both** `setItemDone` and `reopenItem`, add one line to the `ctx.db.insert("contactNotes", {...})` call:

```ts
      conversationId: checklist.conversationId,
```

Add a comment above the insert in `setItemDone`:

```ts
    // Stamped with the conversation so the completion appears inline in
    // that thread — the thread reads notes by conversation, so an
    // unstamped row surfaced in no thread at all. Contacts with several
    // threads get it filed against the right one.
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run convex/salesChecklists.test.ts convex/contactActivity.test.ts`
Expected: PASS. `contactActivity` reads `by_contact` and is unaffected.

- [ ] **Step 5: Full suite and type-check**

Run: `npx vitest run && npx tsc --noEmit`
Expected: everything passes except the known `generatedApi.test.ts > registers lib/assignment`; type-check clean.

- [ ] **Step 6: Verify in the browser**

Tick a checklist item from the contact panel and confirm a "✅ Checklist — …" note card appears inline in that thread at the right position, and that the assignment pills from Task 5 still render correctly alongside it. Screenshot.

- [ ] **Step 7: Lint and commit**

```bash
npx eslint convex/salesChecklists.ts convex/salesChecklists.test.ts
git add convex/salesChecklists.ts convex/salesChecklists.test.ts
git commit -m "fix(checklist): file completion notes against their conversation

Both mutations already wrote a note but left conversationId unset, so the
completions surfaced in no thread. Stamping it puts each one inline in
the chat it happened in."
```

---

## Final verification

- [ ] `npx vitest run` — only `generatedApi.test.ts > registers lib/assignment` fails.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npx eslint` over every file this plan touched — clean.
- [ ] `git status --short` — the only uncommitted entries are the unrelated contact-avatar work that was present before this plan started (`convex/contacts.ts`, `src/components/inbox/contact-avatar.tsx`, `src/lib/inbox/avatar.ts`, `src/lib/inbox/avatar.test.ts`, and their siblings).
- [ ] **Ask the owner to run `npx convex codegen`**, then confirm `npx vitest run` is fully green and commit the regenerated `convex/_generated/api.d.ts` on its own.
