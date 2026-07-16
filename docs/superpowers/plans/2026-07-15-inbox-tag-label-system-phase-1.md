# Inbox Tag Groups & Labelling — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give tags a grouped structure (dimensions like Product / Destination / Priority, each single- or multi-select), let agents assign/remove those labels **and** set typed custom-field values directly from the inbox chat sidebar.

**Architecture:** Additive Convex schema (`tagGroups` table + optional `groupId`/`position` on `tags`); a new `tagGroups.ts` function module; extensions to `tags.ts`, `contacts.assignTag`, and `customFields.ts`; and inbox/settings UI built from small focused components. No filtering/perf changes (Phase 2) and no follow-ups (Phase 3) — those are separate plans.

**Tech Stack:** Convex (self-hosted), `convex-test` + Vitest, Next.js (non-standard fork — see constraint), React 19, `convex/react` hooks, shadcn/ui, `next-intl`, `sonner` toasts, `lucide-react`.

## Global Constraints

- **This is NOT stock Next.js.** Per `AGENTS.md`: read the relevant guide in `node_modules/next/dist/docs/` before writing any Next.js-specific code. Phase 1 touches only client components + Convex, so this rarely bites — but honour it if you touch routing/server components.
- **Convex codegen pushes prod.** Never run `convex dev`/`deploy`/`codegen` — they write to the single live deployment `convex-api.holidayys.co`. Build **offline**: a new table or new field = edit `convex/schema.ts` only (`convex/_generated/dataModel.d.ts` is generic — `DataModelFromSchemaDefinition<typeof schema>` — so `Doc<>`/`Id<>` resolve automatically). A new function module = add two lines to `convex/_generated/api.d.ts` (runtime `api` is `anyApi`; `convex-test` auto-discovers via `import.meta.glob`).
- **All tenant-scoped Convex functions** use `accountQuery`/`accountMutation` from `./lib/auth` — never raw `query`/`mutation`. `ctx.accountId`/`ctx.userId`/`ctx.role` come from the caller's membership; `ctx.requireRole(min)` gates by the `owner>admin>supervisor>agent>viewer` ladder (`convex/lib/roles.ts`).
- **Role floors:** create/edit tag groups, tags, and custom-field definitions = `requireRole("supervisor")`; assign/unassign tags and set field values = `requireRole("agent")`. (Matches existing `tags.ts`/`customFields.ts`/`contacts.ts` gates.)
- **Cross-account safety:** every write re-loads the target row and throws `ConvexError({ code: "NOT_FOUND", entity })` unless `row.accountId === ctx.accountId` — the same error for "missing" and "not yours" (mirror `requireOwnContact`/`requireOwnCustomField`).
- **i18n:** no hard-coded UI copy. Add keys to `messages/en.json` (single locale) under the existing namespaces. Access with `useTranslations`.
- **Tests run offline:** `npx vitest run convex/<file>.test.ts`. Never invoke Convex CLI.
- **Commit after every green task.** Conventional-commit messages, no attribution footer required by the repo.

---

## Task 1: Schema — `tagGroups` table + grouped `tags`

**Files:**
- Modify: `convex/schema.ts` (the `tags` table, ~lines 96-100 on `main`)
- Test: `convex/schema.test.ts` (exists — add one assertion)

**Interfaces:**
- Produces: table `tagGroups` `{ accountId, name, color?, selectionMode: "single"|"multi", position }` indexed `by_account`; `tags` gains `groupId?: Id<"tagGroups">`, `position?: number`, index `by_group`.

- [ ] **Step 1: Write the failing test** — append to `convex/schema.test.ts`:

```ts
test("tagGroups table accepts a group and a tag can reference it", async () => {
  const t = convexTest(schema, modules);
  const { accountId, groupId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "S", email: "s@x.com" });
    const accountId = await ctx.db.insert("accounts", {
      name: "A", defaultCurrency: "USD", ownerUserId: userId,
    });
    const groupId = await ctx.db.insert("tagGroups", {
      accountId, name: "Product", selectionMode: "single", position: 0,
    });
    await ctx.db.insert("tags", {
      accountId, name: "UAE Visa", color: "#3b82f6", groupId, position: 0,
    });
    return { accountId, groupId };
  });
  const group = await t.run((ctx) => ctx.db.get(groupId));
  expect(group!.selectionMode).toBe("single");
  const tags = await t.run((ctx) =>
    ctx.db.query("tags").withIndex("by_group", (q) => q.eq("groupId", groupId)).collect(),
  );
  expect(tags).toHaveLength(1);
  expect(tags[0].accountId).toBe(accountId);
});
```

*(If `convex/schema.test.ts` has no `convexTest`/`modules`/`schema` imports, copy them from the top of `convex/tags.test.ts`.)*

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run convex/schema.test.ts -t "tagGroups table accepts"`
Expected: FAIL — schema validation rejects the unknown `tagGroups` table / unknown `groupId` field.

- [ ] **Step 3: Edit `convex/schema.ts`** — replace the `tags` table definition with the grouped version and add `tagGroups` immediately after it:

```ts
  // A label attached to contacts via `contactTags`. Optionally belongs
  // to a `tagGroups` dimension (Product, Destination, …); ungrouped tags
  // (groupId unset) remain valid — pre-grouping tags stay usable.
  tags: defineTable({
    accountId: v.id("accounts"),
    name: v.string(),
    color: v.string(),
    groupId: v.optional(v.id("tagGroups")),
    position: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_group", ["groupId"]),

  // A dimension that tags are organised under. `selectionMode: "single"`
  // means a contact holds at most one tag from this group (e.g. Priority);
  // "multi" allows several (e.g. Destination). `position` orders groups
  // in the UI.
  tagGroups: defineTable({
    accountId: v.id("accounts"),
    name: v.string(),
    color: v.optional(v.string()),
    selectionMode: v.union(v.literal("single"), v.literal("multi")),
    position: v.number(),
  }).index("by_account", ["accountId"]),
```

- [ ] **Step 4: Run the schema test + full existing suite to prove nothing regressed**

Run: `npx vitest run convex/schema.test.ts convex/tags.test.ts convex/contacts.test.ts convex/customFields.test.ts`
Expected: PASS (new test green; existing tag/contact/customField tests unaffected — all fields added are optional).

- [ ] **Step 5: Commit**

```bash
git add convex/schema.ts convex/schema.test.ts
git commit -m "feat(tags): add tagGroups table and group fields on tags"
```

---

## Task 2: Backend — `tagGroups.ts` CRUD

**Files:**
- Create: `convex/tagGroups.ts`
- Modify: `convex/_generated/api.d.ts` (register the new module — offline codegen)
- Test: `convex/tagGroups.test.ts`

**Interfaces:**
- Consumes: `accountQuery`/`accountMutation` (`./lib/auth`); `v`, `ConvexError` (`convex/values`).
- Produces:
  - `list()` → `Doc<"tagGroups">[]` sorted by `position` then `_creationTime`.
  - `create({ name: string, color?: string, selectionMode: "single"|"multi" })` → `Id<"tagGroups">` (supervisor). New group gets `position = (max existing position) + 1`.
  - `update({ groupId, name?: string, color?: string, selectionMode?: "single"|"multi" })` → `Id<"tagGroups">` (supervisor).
  - `reorder({ orderedIds: Id<"tagGroups">[] })` (supervisor) — writes each id's array index to `position`.
  - `remove({ groupId })` (supervisor) — cascade: **ungroup** its tags (`patch(tagId, { groupId: undefined, position: undefined })`), then delete the group. Tags survive.

- [ ] **Step 1: Write the failing tests** — create `convex/tagGroups.test.ts`. Copy the `seedAccountMember` helper and the header (`/// <reference types="vite/client" />`, imports, `const modules = import.meta.glob("/convex/**/*.ts")`) verbatim from `convex/tags.test.ts`, then add:

```ts
test("create inserts a group scoped to the account and auto-assigns position", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Sup", email: "s@x.com", role: "supervisor" });

  const g0 = await asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });
  const g1 = await asUser.mutation(api.tagGroups.create, { name: "Destination", selectionMode: "multi" });

  const rows = await asUser.query(api.tagGroups.list);
  expect(rows.map((r) => r.name)).toEqual(["Product", "Destination"]);
  expect(rows[0].accountId).toBe(accountId);
  expect(rows[0].position).toBe(0);
  expect(rows[1].position).toBe(1);
  expect(rows[0]._id).toBe(g0);
  expect(rows[1]._id).toBe(g1);
});

test("create is FORBIDDEN below supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Ag", email: "a@x.com", role: "agent" });
  await expect(
    asUser.mutation(api.tagGroups.create, { name: "Nope", selectionMode: "single" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });
});

test("update changes name/mode; cross-account update is NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, { name: "Al", email: "al@x.com", role: "supervisor" });
  const bob = await seedAccountMember(t, { name: "Bo", email: "bo@x.com", role: "supervisor" });
  const gid = await alice.asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });

  await alice.asUser.mutation(api.tagGroups.update, { groupId: gid, name: "Products", selectionMode: "multi" });
  const [row] = await alice.asUser.query(api.tagGroups.list);
  expect(row.name).toBe("Products");
  expect(row.selectionMode).toBe("multi");

  await expect(
    bob.asUser.mutation(api.tagGroups.update, { groupId: gid, name: "Hacked" }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "tagGroup" } });
});

test("remove ungroups its tags rather than deleting them", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Sup", email: "s2@x.com", role: "supervisor" });
  const gid = await asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });
  // Insert the tag directly — tags.create doesn't accept groupId until Task 3.
  const tagId = await t.run((ctx) =>
    ctx.db.insert("tags", { accountId, name: "UAE Visa", color: "#3b82f6", groupId: gid }),
  );

  await asUser.mutation(api.tagGroups.remove, { groupId: gid });

  expect(await asUser.query(api.tagGroups.list)).toHaveLength(0);
  const tag = await t.run((ctx) => ctx.db.get(tagId));
  expect(tag).not.toBeNull();          // tag survives
  expect(tag!.groupId).toBeUndefined(); // now ungrouped
});

test("reorder rewrites positions to array order", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Sup", email: "s3@x.com", role: "supervisor" });
  const a = await asUser.mutation(api.tagGroups.create, { name: "A", selectionMode: "single" });
  const b = await asUser.mutation(api.tagGroups.create, { name: "B", selectionMode: "single" });
  await asUser.mutation(api.tagGroups.reorder, { orderedIds: [b, a] });
  const rows = await asUser.query(api.tagGroups.list);
  expect(rows.map((r) => r.name)).toEqual(["B", "A"]);
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run convex/tagGroups.test.ts`
Expected: FAIL — `api.tagGroups` functions don't exist.

- [ ] **Step 3: Create `convex/tagGroups.ts`**

```ts
import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

// ============================================================
// Tag groups — the account-defined dimensions tags are organised
// under (Product, Destination, Priority, …). Same account-scoping and
// supervisor role floor as `tags.ts`. Deleting a group UNGROUPS its
// tags (they survive as ungrouped) rather than cascading a delete.
// ============================================================

async function requireOwnGroup(
  ctx: { db: QueryCtx["db"]; accountId: Id<"accounts"> },
  groupId: Id<"tagGroups">,
) {
  const group = await ctx.db.get(groupId);
  if (!group || group.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "tagGroup" });
  }
  return group;
}

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    const groups = await ctx.db
      .query("tagGroups")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    return groups.sort(
      (a, b) => a.position - b.position || a._creationTime - b._creationTime,
    );
  },
});

export const create = accountMutation({
  args: {
    name: v.string(),
    color: v.optional(v.string()),
    selectionMode: v.union(v.literal("single"), v.literal("multi")),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const existing = await ctx.db
      .query("tagGroups")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    const position = existing.reduce((max, g) => Math.max(max, g.position + 1), 0);
    return await ctx.db.insert("tagGroups", {
      accountId: ctx.accountId,
      name: args.name,
      color: args.color,
      selectionMode: args.selectionMode,
      position,
    });
  },
});

export const update = accountMutation({
  args: {
    groupId: v.id("tagGroups"),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    selectionMode: v.optional(v.union(v.literal("single"), v.literal("multi"))),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    await requireOwnGroup(ctx, args.groupId);
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.color !== undefined) patch.color = args.color;
    if (args.selectionMode !== undefined) patch.selectionMode = args.selectionMode;
    await ctx.db.patch(args.groupId, patch);
    return args.groupId;
  },
});

export const reorder = accountMutation({
  args: { orderedIds: v.array(v.id("tagGroups")) },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    for (let i = 0; i < args.orderedIds.length; i++) {
      await requireOwnGroup(ctx, args.orderedIds[i]); // proves account ownership
      await ctx.db.patch(args.orderedIds[i], { position: i });
    }
  },
});

export const remove = accountMutation({
  args: { groupId: v.id("tagGroups") },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    await requireOwnGroup(ctx, args.groupId);
    // Ungroup this group's tags (they survive as ungrouped), then delete.
    const tags = await ctx.db
      .query("tags")
      .withIndex("by_group", (q) => q.eq("groupId", args.groupId))
      .collect();
    for (const tag of tags) {
      await ctx.db.patch(tag._id, { groupId: undefined, position: undefined });
    }
    await ctx.db.delete(args.groupId);
  },
});
```

- [ ] **Step 4: Register the module in `convex/_generated/api.d.ts`** — types-only (runtime `api` is `anyApi`; `convex-test` already resolved it via `import.meta.glob`, which is why Step 3's tests could pass without this). Add the import alongside the others (after `import type * as tags from "../tags.js";`):

```ts
import type * as tagGroups from "../tagGroups.js";
```

and add to the `fullApi` object literal (after `tags: typeof tags;`):

```ts
  tagGroups: typeof tagGroups;
```

- [ ] **Step 5: Run to confirm pass**

Run: `npx vitest run convex/tagGroups.test.ts`
Expected: PASS (all 5 tests).

- [ ] **Step 6: Commit**

```bash
git add convex/tagGroups.ts convex/tagGroups.test.ts convex/_generated/api.d.ts
git commit -m "feat(tags): tagGroups CRUD (create/update/reorder/remove-ungroups)"
```

---

## Task 3: Backend — grouped `tags.create` + `tags.update`

**Files:**
- Modify: `convex/tags.ts`
- Test: `convex/tags.test.ts`

**Interfaces:**
- Produces: `tags.create` gains optional `groupId: Id<"tagGroups">`, `position: number`; new `tags.update({ tagId, name?, color?, groupId?, position? })` → `Id<"tags">` (supervisor). `groupId: null` sentinel not used — omit to leave unchanged; pass a real id to move.

- [ ] **Step 1: Write failing tests** — append to `convex/tags.test.ts`:

```ts
test("create attaches a groupId + position when supplied", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Sup", email: "sc@x.com", role: "supervisor" });
  const gid = await asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });
  const tagId = await asUser.mutation(api.tags.create, { name: "UAE Visa", color: "#3b82f6", groupId: gid, position: 2 });
  const row = await t.run((ctx) => ctx.db.get(tagId));
  expect(row!.groupId).toBe(gid);
  expect(row!.position).toBe(2);
});

test("update renames, recolors, and moves a tag between groups", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Sup", email: "su@x.com", role: "supervisor" });
  const g1 = await asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });
  const g2 = await asUser.mutation(api.tagGroups.create, { name: "Destination", selectionMode: "multi" });
  const tagId = await asUser.mutation(api.tags.create, { name: "Thailand", color: "#10b981", groupId: g1 });

  await asUser.mutation(api.tags.update, { tagId, name: "Thailand ✈", color: "#06b6d4", groupId: g2 });
  const row = await t.run((ctx) => ctx.db.get(tagId));
  expect(row!.name).toBe("Thailand ✈");
  expect(row!.color).toBe("#06b6d4");
  expect(row!.groupId).toBe(g2);
});

test("update is FORBIDDEN below supervisor and NOT_FOUND cross-account", async () => {
  const t = convexTest(schema, modules);
  const sup = await seedAccountMember(t, { name: "Sup", email: "su2@x.com", role: "supervisor" });
  const ag = await seedAccountMember(t, { name: "Ag", email: "ag3@x.com", role: "agent" });
  const tagId = await sup.asUser.mutation(api.tags.create, { name: "VIP", color: "#f00" });
  await expect(
    ag.asUser.mutation(api.tags.update, { tagId, name: "x" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });

  const bob = await seedAccountMember(t, { name: "Bo", email: "bo2@x.com", role: "supervisor" });
  await expect(
    bob.asUser.mutation(api.tags.update, { tagId, name: "x" }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "tag" } });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run convex/tags.test.ts -t "update"`
Expected: FAIL — `api.tags.update` undefined; `create` rejects unknown `groupId` arg.

- [ ] **Step 3: Edit `convex/tags.ts`** — replace `create` and add `update`:

```ts
export const create = accountMutation({
  args: {
    name: v.string(),
    color: v.string(),
    groupId: v.optional(v.id("tagGroups")),
    position: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    if (args.groupId) {
      const group = await ctx.db.get(args.groupId);
      if (!group || group.accountId !== ctx.accountId) {
        throw new ConvexError({ code: "NOT_FOUND", entity: "tagGroup" });
      }
    }
    return await ctx.db.insert("tags", {
      accountId: ctx.accountId,
      name: args.name,
      color: args.color,
      groupId: args.groupId,
      position: args.position,
    });
  },
});

export const update = accountMutation({
  args: {
    tagId: v.id("tags"),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
    groupId: v.optional(v.id("tagGroups")),
    position: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const tag = await ctx.db.get(args.tagId);
    if (!tag || tag.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "tag" });
    }
    if (args.groupId) {
      const group = await ctx.db.get(args.groupId);
      if (!group || group.accountId !== ctx.accountId) {
        throw new ConvexError({ code: "NOT_FOUND", entity: "tagGroup" });
      }
    }
    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.color !== undefined) patch.color = args.color;
    if (args.groupId !== undefined) patch.groupId = args.groupId;
    if (args.position !== undefined) patch.position = args.position;
    await ctx.db.patch(args.tagId, patch);
    return args.tagId;
  },
});
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run convex/tags.test.ts`
Expected: PASS (existing + 3 new tests).

- [ ] **Step 5: Commit**

```bash
git add convex/tags.ts convex/tags.test.ts
git commit -m "feat(tags): grouped tags.create + tags.update"
```

---

## Task 4: Backend — single-select displacement in `contacts.assignTag`

**Files:**
- Modify: `convex/contacts.ts` (`assignTag`, ~lines 458-483)
- Test: `convex/contacts.test.ts`

**Interfaces:**
- Consumes: `tags.groupId`, `tagGroups.selectionMode`.
- Produces: `assignTag` behaviour change — assigning a tag whose group is `selectionMode: "single"` first removes any other of the contact's tags from that same group (in `contactTags`). Ungrouped tags and `multi` groups are unaffected. Signature unchanged (`{ contactId, tagId }`).

- [ ] **Step 1: Write the failing test** — append to `convex/contacts.test.ts` (reuse its existing `seedAccountMember` + any contact-creation helper; if none, create a contact with `t.run((ctx)=>ctx.db.insert("contacts", { accountId, phone:"+15550001", phoneNormalized:"15550001" }))`):

```ts
test("assignTag displaces the prior tag from a single-select group", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Sup", email: "ss@x.com", role: "supervisor" });
  const gid = await asUser.mutation(api.tagGroups.create, { name: "Product", selectionMode: "single" });
  const uae = await asUser.mutation(api.tags.create, { name: "UAE Visa", color: "#3b82f6", groupId: gid });
  const pkg = await asUser.mutation(api.tags.create, { name: "Packages", color: "#f59e0b", groupId: gid });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+15550001", phoneNormalized: "15550001" }),
  );

  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: uae });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: pkg }); // same single group

  const links = await t.run((ctx) =>
    ctx.db.query("contactTags").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect(),
  );
  expect(links.map((l) => l.tagId)).toEqual([pkg]); // UAE displaced
});

test("assignTag keeps both tags for a multi-select group", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Sup", email: "sm@x.com", role: "supervisor" });
  const gid = await asUser.mutation(api.tagGroups.create, { name: "Destination", selectionMode: "multi" });
  const th = await asUser.mutation(api.tags.create, { name: "Thailand", color: "#10b981", groupId: gid });
  const ba = await asUser.mutation(api.tags.create, { name: "Bali", color: "#06b6d4", groupId: gid });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+15550002", phoneNormalized: "15550002" }),
  );

  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: th });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: ba });

  const links = await t.run((ctx) =>
    ctx.db.query("contactTags").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect(),
  );
  expect(links.map((l) => l.tagId).sort()).toEqual([th, ba].sort());
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run convex/contacts.test.ts -t "assignTag"`
Expected: FAIL on the first test — both tags present (no displacement yet).

- [ ] **Step 3: Edit `assignTag` in `convex/contacts.ts`** — insert the displacement block after the tag-ownership check and before the existing-link short-circuit:

```ts
export const assignTag = accountMutation({
  args: { contactId: v.id("contacts"), tagId: v.id("tags") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnContact(ctx, args.contactId);

    const tag = await ctx.db.get(args.tagId);
    if (!tag || tag.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "tag" });
    }

    // Single-select displacement: if this tag's group is single-select,
    // remove any other tag the contact holds from the SAME group first.
    if (tag.groupId) {
      const group = await ctx.db.get(tag.groupId);
      if (group?.selectionMode === "single") {
        const links = await ctx.db
          .query("contactTags")
          .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
          .collect();
        for (const link of links) {
          if (link.tagId === args.tagId) continue;
          const other = await ctx.db.get(link.tagId);
          if (other?.groupId === tag.groupId) {
            await ctx.db.delete(link._id);
          }
        }
      }
    }

    const existing = await ctx.db
      .query("contactTags")
      .withIndex("by_contact_tag", (q) =>
        q.eq("contactId", args.contactId).eq("tagId", args.tagId),
      )
      .first();
    if (existing) return existing._id;

    return await ctx.db.insert("contactTags", {
      accountId: ctx.accountId,
      contactId: args.contactId,
      tagId: args.tagId,
    });
  },
});
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run convex/contacts.test.ts`
Expected: PASS (both new tests + existing suite).

- [ ] **Step 5: Commit**

```bash
git add convex/contacts.ts convex/contacts.test.ts
git commit -m "feat(tags): single-select group displacement on assignTag"
```

---

## Task 5: Backend — typed custom fields (options + value validation)

**Files:**
- Modify: `convex/customFields.ts`
- Test: `convex/customFields.test.ts`

**Interfaces:**
- Produces:
  - `create` gains optional `fieldOptions: { options: string[] }`. `fieldType` stays required (default `"text"` supplied by the UI). Store `fieldOptions` only for `select`/`multiselect`.
  - New `update({ fieldId, fieldType?, fieldOptions? })` → `Id<"customFields">` (supervisor) — edit an existing field's type/options (name edits stay in `rename`).
  - `setForContact` validates each value against its field's type: `number` must parse as finite; `date` must be an ISO `YYYY-MM-DD`; `select` must be one of `fieldOptions.options`; `multiselect` value is a JSON array whose items ⊆ options. Invalid → `ConvexError({ code: "INVALID_VALUE", customFieldId })`. `text` and empty values keep today's behaviour (empty is skipped).

- [ ] **Step 1: Write failing tests** — append to `convex/customFields.test.ts` (reuse its `seedAccountMember`; make a contact via `t.run` insert as in Task 4):

```ts
test("create stores options for a select field", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Sup", email: "cf1@x.com", role: "supervisor" });
  const fid = await asUser.mutation(api.customFields.create, {
    fieldName: "Product Category",
    fieldType: "select",
    fieldOptions: { options: ["UAE Visa", "Global Visa", "Packages"] },
  });
  const row = await t.run((ctx) => ctx.db.get(fid));
  expect(row!.fieldType).toBe("select");
  expect(row!.fieldOptions).toEqual({ options: ["UAE Visa", "Global Visa", "Packages"] });
});

test("setForContact accepts a valid select value and rejects an off-list one", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Sup", email: "cf2@x.com", role: "supervisor" });
  const fid = await asUser.mutation(api.customFields.create, {
    fieldName: "Product Category", fieldType: "select",
    fieldOptions: { options: ["UAE Visa", "Packages"] },
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone: "+15550003", phoneNormalized: "15550003" }),
  );

  await asUser.mutation(api.customFields.setForContact, {
    contactId, values: [{ customFieldId: fid, value: "Packages" }],
  });
  const stored = await asUser.query(api.customFields.getForContact, { contactId });
  expect(stored.map((s) => s.value)).toEqual(["Packages"]);

  await expect(
    asUser.mutation(api.customFields.setForContact, {
      contactId, values: [{ customFieldId: fid, value: "Cruise" }],
    }),
  ).rejects.toMatchObject({ data: { code: "INVALID_VALUE" } });
});

test("update switches a field to a new type + options", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Sup", email: "cf3@x.com", role: "supervisor" });
  const fid = await asUser.mutation(api.customFields.create, { fieldName: "Budget", fieldType: "text" });
  await asUser.mutation(api.customFields.update, { fieldId: fid, fieldType: "number" });
  const row = await t.run((ctx) => ctx.db.get(fid));
  expect(row!.fieldType).toBe("number");
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run convex/customFields.test.ts -t "select"`
Expected: FAIL — `create` rejects unknown `fieldOptions` arg; no validation yet.

- [ ] **Step 3: Edit `convex/customFields.ts`** — add a validation helper near the other helpers, extend `create`, add `update`, and call the helper in `setForContact`:

```ts
// Placed with the other module helpers (after findDuplicateFieldName):
const FIELD_OPTIONS = v.object({ options: v.array(v.string()) });

/** Validates one value string against a field's declared type. Throws
 *  INVALID_VALUE on mismatch. Empty strings are the caller's concern
 *  (setForContact skips them before calling this). */
function assertValidFieldValue(
  field: { _id: Id<"customFields">; fieldType: string; fieldOptions?: unknown },
  value: string,
) {
  const bad = () =>
    new ConvexError({ code: "INVALID_VALUE", customFieldId: field._id });
  const opts =
    (field.fieldOptions as { options?: string[] } | undefined)?.options ?? [];
  switch (field.fieldType) {
    case "number":
      if (!Number.isFinite(Number(value))) throw bad();
      return;
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))
        throw bad();
      return;
    case "select":
      if (!opts.includes(value)) throw bad();
      return;
    case "multiselect": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw bad();
      }
      if (!Array.isArray(parsed) || parsed.some((x) => !opts.includes(x as string)))
        throw bad();
      return;
    }
    default:
      return; // "text" and any legacy freeform type
  }
}
```

Extend `create`'s args + body:

```ts
export const create = accountMutation({
  args: {
    fieldName: v.string(),
    fieldType: v.string(),
    fieldOptions: v.optional(FIELD_OPTIONS),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    const dup = await findDuplicateFieldName(ctx, args.fieldName);
    if (dup) throw new ConvexError({ code: "DUPLICATE_FIELD", fieldId: dup._id });
    return await ctx.db.insert("customFields", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      fieldName: args.fieldName,
      fieldType: args.fieldType,
      fieldOptions: args.fieldOptions,
    });
  },
});
```

Add `update` after `rename`:

```ts
export const update = accountMutation({
  args: {
    fieldId: v.id("customFields"),
    fieldType: v.optional(v.string()),
    fieldOptions: v.optional(FIELD_OPTIONS),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("supervisor");
    await requireOwnCustomField(ctx, args.fieldId);
    const patch: Record<string, unknown> = {};
    if (args.fieldType !== undefined) patch.fieldType = args.fieldType;
    if (args.fieldOptions !== undefined) patch.fieldOptions = args.fieldOptions;
    await ctx.db.patch(args.fieldId, patch);
    return args.fieldId;
  },
});
```

In `setForContact`, validate before insert — replace the final insert loop:

```ts
    for (const [customFieldId, value] of byField) {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const field = await ctx.db.get(customFieldId);
      if (field) assertValidFieldValue(field, trimmed);
      await ctx.db.insert("contactCustomValues", {
        accountId: ctx.accountId,
        contactId: args.contactId,
        customFieldId,
        value: trimmed,
      });
    }
```

- [ ] **Step 4: Run to confirm pass**

Run: `npx vitest run convex/customFields.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add convex/customFields.ts convex/customFields.test.ts
git commit -m "feat(fields): typed custom fields (options + value validation)"
```

---

## Task 6: Frontend — types, adapters, and label view logic

**Files:**
- Modify: `src/types/index.ts` (add `TagGroup`; add `group_id?` to `Tag`)
- Modify: `src/lib/convex/adapters.ts` (add `toUiTagGroup`; extend `toUiTag`)
- Create: `src/lib/inbox/labels.ts` (pure grouping/selection helpers)
- Test: `src/lib/inbox/labels.test.ts`

**Interfaces:**
- Produces:
  - Type `TagGroup { id: string; name: string; color?: string; selection_mode: "single" | "multi"; position: number }`.
  - `Tag` gains `group_id?: string`.
  - `toUiTagGroup(doc: Doc<"tagGroups">): TagGroup`.
  - `src/lib/inbox/labels.ts`:
    - `type LabelDimension = { group: TagGroup | null; tags: Tag[] }`
    - `groupTags(groups: TagGroup[], tags: Tag[]): LabelDimension[]` — ordered by group position; ungrouped tags collected under a trailing `group: null` dimension (omitted if none).
    - `isSelected(tag: Tag, selectedIds: Set<string>): boolean`.

- [ ] **Step 1: Write failing tests** — create `src/lib/inbox/labels.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupTags } from "./labels";
import type { Tag, TagGroup } from "@/types";

const g = (id: string, position: number, mode: "single" | "multi" = "multi"): TagGroup =>
  ({ id, name: id, selection_mode: mode, position });
const t = (id: string, group_id?: string): Tag =>
  ({ id, name: id, color: "#000", group_id });

describe("groupTags", () => {
  it("orders dimensions by group position and nests their tags", () => {
    const dims = groupTags(
      [g("dest", 1), g("prod", 0)],
      [t("uae", "prod"), t("thai", "dest"), t("pkg", "prod")],
    );
    expect(dims.map((d) => d.group?.id)).toEqual(["prod", "dest"]);
    expect(dims[0].tags.map((x) => x.id)).toEqual(["uae", "pkg"]);
  });

  it("collects ungrouped tags under a trailing null dimension", () => {
    const dims = groupTags([g("prod", 0)], [t("vip"), t("uae", "prod")]);
    expect(dims.at(-1)!.group).toBeNull();
    expect(dims.at(-1)!.tags.map((x) => x.id)).toEqual(["vip"]);
  });

  it("omits the null dimension when every tag is grouped", () => {
    const dims = groupTags([g("prod", 0)], [t("uae", "prod")]);
    expect(dims.every((d) => d.group !== null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npx vitest run src/lib/inbox/labels.test.ts`
Expected: FAIL — `./labels` module not found.

- [ ] **Step 3: Add the `Tag` field + `TagGroup` type** in `src/types/index.ts` — extend the `Tag` interface with `group_id?: string;` and add:

```ts
export interface TagGroup {
  id: string;
  name: string;
  color?: string;
  selection_mode: 'single' | 'multi';
  position: number;
}
```

- [ ] **Step 4: Add adapters** in `src/lib/convex/adapters.ts` — extend `toUiTag`'s return with `group_id: doc.groupId` and add:

```ts
export function toUiTagGroup(doc: Doc<"tagGroups">): TagGroup {
  return {
    id: doc._id,
    name: doc.name,
    color: doc.color,
    selection_mode: doc.selectionMode,
    position: doc.position,
  };
}
```

*(Import `TagGroup` from `@/types` at the top of the file alongside the existing type imports.)*

- [ ] **Step 5: Create `src/lib/inbox/labels.ts`**

```ts
import type { Tag, TagGroup } from "@/types";

export type LabelDimension = { group: TagGroup | null; tags: Tag[] };

/** Organises an account's tags into ordered dimensions for the label
 *  picker: one per group (by `position`), with any ungrouped tags under a
 *  trailing `group: null` dimension (omitted when there are none). */
export function groupTags(groups: TagGroup[], tags: Tag[]): LabelDimension[] {
  const ordered = [...groups].sort((a, b) => a.position - b.position);
  const byGroup = new Map<string, Tag[]>();
  const ungrouped: Tag[] = [];
  for (const tag of tags) {
    if (tag.group_id) {
      const list = byGroup.get(tag.group_id) ?? [];
      list.push(tag);
      byGroup.set(tag.group_id, list);
    } else {
      ungrouped.push(tag);
    }
  }
  const dims: LabelDimension[] = ordered.map((group) => ({
    group,
    tags: byGroup.get(group.id) ?? [],
  }));
  if (ungrouped.length > 0) dims.push({ group: null, tags: ungrouped });
  return dims;
}

export function isSelected(tag: Tag, selectedIds: Set<string>): boolean {
  return selectedIds.has(tag.id);
}
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/lib/inbox/labels.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/lib/convex/adapters.ts src/lib/inbox/labels.ts src/lib/inbox/labels.test.ts
git commit -m "feat(inbox): TagGroup type, adapter, and label grouping helper"
```

---

## Task 7: Settings — grouped tag manager

**Files:**
- Create: `src/components/settings/tag-groups-manager.tsx`
- Modify: `src/components/settings/tag-manager.tsx` (render the grouped manager; keep the card shell)
- Modify: `messages/en.json` (add `Settings.tagGroups.*` keys)

**Interfaces:**
- Consumes: `api.tagGroups.{list,create,update,remove}`, `api.tags.{list,create,update,remove}`, `toUiTag`, `toUiTagGroup`, `groupTags`.
- Produces: a settings card where a supervisor creates groups (name + single/multi), adds tags under a group (name + colour), and deletes either. Reuses `PRESET_COLORS` (copy from `tag-manager.tsx`).

- [ ] **Step 1: Add i18n keys** — in `messages/en.json`, inside the existing `"Settings"` object add a `"tagGroups"` block:

```json
"tagGroups": {
  "title": "Tag groups",
  "desc": "Organise labels into dimensions (Product, Destination, Priority…). Single-select groups allow one tag per chat; multi-select allow several.",
  "newGroupName": "New group name",
  "single": "Single-select",
  "multi": "Multi-select",
  "addGroup": "Add group",
  "addTag": "Add tag",
  "tagName": "Tag name",
  "ungrouped": "Ungrouped",
  "deleteGroup": "Delete group",
  "deleteGroupConfirm": "Delete “{name}”? Its tags become ungrouped (they are not deleted).",
  "deleteTag": "Delete tag",
  "deleteTagConfirm": "Delete “{name}”? It is removed from every chat.",
  "created": "Created",
  "deleted": "Deleted",
  "failed": "Something went wrong",
  "nameRequired": "Enter a name"
}
```

- [ ] **Step 2: Create `src/components/settings/tag-groups-manager.tsx`** — a supervisor-only manager. Full component:

```tsx
'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toUiTag, toUiTagGroup } from '@/lib/convex/adapters';
import { groupTags } from '@/lib/inbox/labels';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#10b981',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
];

export function TagGroupsManager() {
  const t = useTranslations('Settings.tagGroups');
  const groupsRes = useQuery(api.tagGroups.list);
  const tagsRes = useQuery(api.tags.list);
  const groups = useMemo(() => (groupsRes ?? []).map(toUiTagGroup), [groupsRes]);
  const tags = useMemo(() => (tagsRes ?? []).map(toUiTag), [tagsRes]);
  const dimensions = useMemo(() => groupTags(groups, tags), [groups, tags]);
  const loading = groupsRes === undefined || tagsRes === undefined;

  const createGroup = useMutation(api.tagGroups.create);
  const removeGroup = useMutation(api.tagGroups.remove);
  const createTag = useMutation(api.tags.create);
  const removeTag = useMutation(api.tags.remove);

  const [groupName, setGroupName] = useState('');
  const [mode, setMode] = useState<'single' | 'multi'>('multi');
  const [busy, setBusy] = useState(false);

  async function addGroup() {
    if (!groupName.trim()) return toast.error(t('nameRequired'));
    setBusy(true);
    try {
      await createGroup({ name: groupName.trim(), selectionMode: mode });
      setGroupName('');
      toast.success(t('created'));
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup(id: string, name: string) {
    if (!window.confirm(t('deleteGroupConfirm', { name }))) return;
    try {
      await removeGroup({ groupId: id as Id<'tagGroups'> });
      toast.success(t('deleted'));
    } catch {
      toast.error(t('failed'));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {dimensions.map(({ group, tags: groupTagsList }) => (
        <div key={group?.id ?? 'ungrouped'} className="rounded-lg border border-border p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                {group ? group.name : t('ungrouped')}
              </span>
              {group && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                  {group.selection_mode === 'single' ? t('single') : t('multi')}
                </span>
              )}
            </div>
            {group && (
              <Button
                variant="ghost" size="icon-sm"
                onClick={() => deleteGroup(group.id, group.name)}
                title={t('deleteGroup')}
                className="text-muted-foreground hover:text-red-400"
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {groupTagsList.map((tag) => (
              <span
                key={tag.id}
                className="group inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium"
                style={{ backgroundColor: `${tag.color}20`, color: tag.color, border: `1px solid ${tag.color}40` }}
              >
                {tag.name}
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm(t('deleteTagConfirm', { name: tag.name }))) return;
                    try { await removeTag({ tagId: tag.id as Id<'tags'> }); }
                    catch { toast.error(t('failed')); }
                  }}
                  aria-label={t('deleteTag')}
                  className="ml-0.5 rounded-full p-0.5 opacity-60 hover:opacity-100"
                >
                  ×
                </button>
              </span>
            ))}
            {group && (
              <AddTagInline
                colorPool={PRESET_COLORS}
                placeholder={t('tagName')}
                addLabel={t('addTag')}
                onAdd={(name, color) =>
                  createTag({ name, color, groupId: group.id as Id<'tagGroups'> })
                }
              />
            )}
          </div>
        </div>
      ))}

      {/* New group row */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Input
          value={groupName}
          onChange={(e) => setGroupName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addGroup(); }}
          placeholder={t('newGroupName')}
          className="min-w-[180px] flex-1"
          maxLength={40}
        />
        <div className="flex overflow-hidden rounded-md border border-border text-xs">
          {(['multi', 'single'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn('px-2.5 py-1.5', mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground')}
            >
              {m === 'single' ? t('single') : t('multi')}
            </button>
          ))}
        </div>
        <Button variant="outline" size="sm" onClick={addGroup} disabled={busy || !groupName.trim()}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          {t('addGroup')}
        </Button>
      </div>
    </div>
  );
}

/** Inline "add a tag to this group" control: name + colour swatch + add. */
function AddTagInline({
  colorPool, placeholder, addLabel, onAdd,
}: {
  colorPool: string[];
  placeholder: string;
  addLabel: string;
  onAdd: (name: string, color: string) => Promise<unknown>;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(colorPool[3]);
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!name.trim()) return;
    setBusy(true);
    try { await onAdd(name.trim(), color); setName(''); }
    finally { setBusy(false); }
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder={placeholder}
        className="h-7 w-28 text-xs"
        maxLength={30}
      />
      <button
        type="button"
        aria-label="tag colour"
        onClick={() => setColor(colorPool[(colorPool.indexOf(color) + 1) % colorPool.length])}
        className="size-5 rounded"
        style={{ backgroundColor: color }}
      />
      <Button variant="ghost" size="icon-sm" onClick={submit} disabled={busy} title={addLabel}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
      </Button>
    </span>
  );
}
```

- [ ] **Step 3: Swap the manager into the settings card** — in `src/components/settings/tag-manager.tsx`, replace the body of the `<CardContent>` (the flat tag list + inline-create row + delete dialog) with the grouped manager. Keep the `Card`/`CardHeader`/`CardTitle`/`CardDescription` shell and the `Settings.tagsAndFields` title strings; render `<TagGroupsManager />` inside `<CardContent>`. Remove now-unused state/handlers (`newTagName`, `selectedColor`, delete dialog) and imports flagged by the linter.

```tsx
// top of file
import { TagGroupsManager } from './tag-groups-manager';
// ...
      <CardContent>
        <TagGroupsManager />
      </CardContent>
```

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint src/components/settings/tag-groups-manager.tsx src/components/settings/tag-manager.tsx`
Expected: no errors (fix any unused-import warnings from the removed flat UI).

- [ ] **Step 5: Verify in the browser** — start the dev server and confirm the grouped manager renders and a group + tag can be created.

Use `preview_start` with the app's launch config (create `.claude/launch.json` if absent, `npm run dev`), sign in, navigate to `/settings?tab=fields`, and confirm: create group "Product" (single), add tag "UAE Visa"; create group "Destination" (multi), add "Thailand". Screenshot for proof. (Auth-gated — if no session is available, note that and rely on the type/lint gates.)

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/tag-groups-manager.tsx src/components/settings/tag-manager.tsx messages/en.json
git commit -m "feat(settings): grouped tag manager"
```

---

## Task 8: Settings — custom-field type + options editor

**Files:**
- Modify: `src/components/contacts/custom-fields-manager.tsx` (`CustomFieldsPanel` create row + `FieldRow`)
- Modify: `messages/en.json` (`Contacts.customFields.*` additions)

**Interfaces:**
- Consumes: `api.customFields.{create,update}`; `CustomField.field_type`, `field_options`.
- Produces: on create, a **type** selector (`text|select|multiselect|date|number`) and, for select types, a comma-separated options input. Each `FieldRow` shows its type and, for select types, an editable options list saved via `api.customFields.update`.

- [ ] **Step 1: Add i18n keys** — inside `Contacts.customFields` in `messages/en.json`:

```json
"type": "Type",
"typeText": "Text",
"typeSelect": "Dropdown",
"typeMultiselect": "Multi-select",
"typeDate": "Date",
"typeNumber": "Number",
"options": "Options (comma-separated)",
"optionsPlaceholder": "UAE Visa, Global Visa, Packages",
"saveOptions": "Save options",
"toastUpdated": "Field updated"
```

- [ ] **Step 2: Extend the create row in `CustomFieldsPanel`** — add `type`/`options` state and a `<select>` + conditional options `<Input>`; pass them to `createField`. Replace `handleCreate`:

```tsx
const [newType, setNewType] = useState<'text' | 'select' | 'multiselect' | 'date' | 'number'>('text');
const [newOptions, setNewOptions] = useState('');

async function handleCreate() {
  const name = newName.trim();
  if (!name) return;
  const isSelect = newType === 'select' || newType === 'multiselect';
  const options = newOptions.split(',').map((o) => o.trim()).filter(Boolean);
  setCreating(true);
  try {
    await createField({
      fieldName: name,
      fieldType: newType,
      ...(isSelect && options.length ? { fieldOptions: { options } } : {}),
    });
    toast.success(t('toastCreated', { name }));
    setNewName(''); setNewType('text'); setNewOptions('');
  } catch (err) {
    if (isConvexErrorCode(err, 'DUPLICATE_FIELD')) toast.error(t('toastDuplicate', { name }));
    else toast.error(t('toastCreateFailed'));
  } finally {
    setCreating(false);
  }
}
```

Render the type `<select>` (native element, styled) next to the name `<Input>`, and the options `<Input>` on its own row shown only when `newType` is `select`/`multiselect`:

```tsx
<select
  value={newType}
  onChange={(e) => setNewType(e.target.value as typeof newType)}
  className="h-9 rounded-md border border-border bg-muted px-2 text-sm text-foreground"
>
  <option value="text">{t('typeText')}</option>
  <option value="select">{t('typeSelect')}</option>
  <option value="multiselect">{t('typeMultiselect')}</option>
  <option value="date">{t('typeDate')}</option>
  <option value="number">{t('typeNumber')}</option>
</select>
{(newType === 'select' || newType === 'multiselect') && (
  <Input
    value={newOptions}
    onChange={(e) => setNewOptions(e.target.value)}
    placeholder={t('optionsPlaceholder')}
    className="bg-muted text-foreground"
  />
)}
```

- [ ] **Step 3: Show type + editable options in `FieldRow`** — add an `updateField = useMutation(api.customFields.update)` in `CustomFieldsPanel`, pass it down, and in `FieldRow` render the type label plus (for select types) an options input that saves on blur:

```tsx
// In FieldRow, after the name Input:
{(field.field_type === 'select' || field.field_type === 'multiselect') && (
  <OptionsEditor field={field} onSave={onSaveOptions} />
)}
<span className="shrink-0 text-[10px] uppercase text-muted-foreground">{field.field_type}</span>
```

```tsx
function OptionsEditor({
  field, onSave,
}: {
  field: CustomField;
  onSave: (field: CustomField, options: string[]) => Promise<void>;
}) {
  const current = (field.field_options?.options as string[] | undefined) ?? [];
  const [text, setText] = useState(current.join(', '));
  return (
    <Input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onSave(field, text.split(',').map((o) => o.trim()).filter(Boolean))}
      className="h-8 flex-1 text-xs"
      placeholder="options…"
    />
  );
}
```

Wire `onSaveOptions` in `CustomFieldsPanel`:

```tsx
async function handleSaveOptions(field: CustomField, options: string[]) {
  try {
    await updateField({ fieldId: field.id as Id<'customFields'>, fieldOptions: { options } });
    toast.success(t('toastUpdated'));
  } catch {
    toast.error(t('toastRenameFailed'));
  }
}
```

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint src/components/contacts/custom-fields-manager.tsx`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/contacts/custom-fields-manager.tsx messages/en.json
git commit -m "feat(fields): type + options editor in custom-fields manager"
```

---

## Task 9: Inbox — interactive Labels picker in the chat sidebar

**Files:**
- Create: `src/components/inbox/label-picker.tsx`
- Modify: `src/components/inbox/contact-sidebar.tsx` (replace the read-only tags block, ~lines 459-483)
- Modify: `messages/en.json` (`Inbox.labels.*`)

**Interfaces:**
- Consumes: `api.tagGroups.list`, `api.tags.list`, `api.contacts.{assignTag,unassignTag}`, `groupTags`, `contact.tags` (already embedded).
- Produces: `<LabelPicker contactId tags={contact.tags} />` — shows the contact's current tags as chips and a popover (per group) to toggle tags on/off. Toggling calls `assignTag`/`unassignTag`; single-select displacement is handled server-side (Task 4), and the reactive `contact.tags` query updates the chips automatically.

- [ ] **Step 1: Add i18n keys** — inside `Inbox` in `messages/en.json`:

```json
"labels": {
  "title": "Labels",
  "add": "Add label",
  "none": "No labels yet",
  "ungrouped": "Other",
  "failed": "Couldn’t update labels"
}
```

- [ ] **Step 2: Create `src/components/inbox/label-picker.tsx`**

```tsx
'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { Check, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { toUiTag, toUiTagGroup } from '@/lib/convex/adapters';
import { groupTags } from '@/lib/inbox/labels';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Tag } from '@/types';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

export function LabelPicker({
  contactId, tags: assigned,
}: {
  contactId: string;
  tags: Tag[];
}) {
  const t = useTranslations('Inbox.labels');
  const groupsRes = useQuery(api.tagGroups.list);
  const tagsRes = useQuery(api.tags.list);
  const groups = useMemo(() => (groupsRes ?? []).map(toUiTagGroup), [groupsRes]);
  const allTags = useMemo(() => (tagsRes ?? []).map(toUiTag), [tagsRes]);
  const dimensions = useMemo(() => groupTags(groups, allTags), [groups, allTags]);
  const selectedIds = useMemo(() => new Set(assigned.map((x) => x.id)), [assigned]);

  const assignTag = useMutation(api.contacts.assignTag);
  const unassignTag = useMutation(api.contacts.unassignTag);
  const [open, setOpen] = useState(false);

  async function toggle(tag: Tag) {
    const isOn = selectedIds.has(tag.id);
    try {
      if (isOn) {
        await unassignTag({ contactId: contactId as Id<'contacts'>, tagId: tag.id as Id<'tags'> });
      } else {
        await assignTag({ contactId: contactId as Id<'contacts'>, tagId: tag.id as Id<'tags'> });
      }
    } catch {
      toast.error(t('failed'));
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {assigned.length === 0 && (
        <span className="px-1 text-xs text-muted-foreground">{t('none')}</span>
      )}
      {assigned.map((tag) => (
        <button
          key={tag.id}
          type="button"
          onClick={() => toggle(tag)}
          className="rounded-full px-2 py-0.5 text-[10px] font-medium"
          style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
          title={tag.name}
        >
          {tag.name} ×
        </button>
      ))}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
        >
          <Plus className="size-3" /> {t('add')}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-2">
          <div className="max-h-72 space-y-3 overflow-y-auto">
            {dimensions.map(({ group, tags: groupTagsList }) => (
              <div key={group?.id ?? 'ungrouped'}>
                <p className="mb-1 px-1 text-[10px] uppercase text-muted-foreground">
                  {group ? group.name : t('ungrouped')}
                </p>
                <div className="flex flex-col">
                  {groupTagsList.map((tag) => {
                    const on = selectedIds.has(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() => toggle(tag)}
                        className={cn(
                          'flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-muted',
                          on ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="size-2 rounded-full" style={{ backgroundColor: tag.color }} />
                          {tag.name}
                        </span>
                        {on && <Check className="size-3.5 text-primary" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
```

*(If `@/components/ui/popover` is absent, add it via the repo's shadcn setup — check `src/components/ui/` first; the project already uses Radix, so `DropdownMenu` from `@/components/ui/dropdown-menu` is a drop-in fallback with the same trigger/content shape.)*

- [ ] **Step 3: Wire it into `contact-sidebar.tsx`** — replace the read-only tags block (the `SectionLabel icon={TagIcon} label={tSidebar("tags")}` div and its `tags.map(...)` chips) with:

```tsx
<div>
  <SectionLabel icon={TagIcon} label={t('Inbox.labels.title')} />
  <LabelPicker contactId={contact.id} tags={tags} />
</div>
```

Import `LabelPicker` at the top: `import { LabelPicker } from "./label-picker";`. Use the existing `tags` local (`contact?.tags ?? []`) and the component's existing `useTranslations`. (Confirm the translations instance/namespace used for the label title — reuse whatever `useTranslations` root the file already has, or add a `const tLabels = useTranslations("Inbox.labels")`.)

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint src/components/inbox/label-picker.tsx src/components/inbox/contact-sidebar.tsx`
Expected: no errors.

- [ ] **Step 5: Verify in the browser** — open a chat, open the Labels popover, toggle a Product tag on, confirm the chip appears and (for a single-select group) toggling a second Product tag replaces the first. Screenshot. (Auth-gated — note if unavailable.)

- [ ] **Step 6: Commit**

```bash
git add src/components/inbox/label-picker.tsx src/components/inbox/contact-sidebar.tsx messages/en.json
git commit -m "feat(inbox): interactive grouped label picker in chat sidebar"
```

---

## Task 10: Inbox — editable custom fields in the chat sidebar

**Files:**
- Create: `src/components/inbox/contact-custom-fields.tsx`
- Modify: `src/components/inbox/contact-sidebar.tsx` (add a Custom Fields section)
- Modify: `messages/en.json` (`Inbox.customFields.*`)

**Interfaces:**
- Consumes: `api.customFields.list`, `api.customFields.getForContact`, `api.customFields.setForContact`, `toUiCustomField`.
- Produces: `<ContactCustomFields contactId />` — lists the account's fields with the contact's current values, editable inline (text/number/date `<input>`, `<select>` for `select`, checkboxes for `multiselect` encoded as a JSON array), saving all values via one `setForContact` call on blur/change.

- [ ] **Step 1: Add i18n keys** — inside `Inbox` in `messages/en.json`:

```json
"customFields": {
  "title": "Details",
  "none": "No fields configured",
  "saved": "Saved",
  "failed": "Couldn’t save",
  "selectPlaceholder": "—"
}
```

- [ ] **Step 2: Create `src/components/inbox/contact-custom-fields.tsx`**

```tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { toUiCustomField } from '@/lib/convex/adapters';
import { Input } from '@/components/ui/input';
import type { CustomField } from '@/types';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

export function ContactCustomFields({ contactId }: { contactId: string }) {
  const t = useTranslations('Inbox.customFields');
  const fieldsRes = useQuery(api.customFields.list);
  const valuesRes = useQuery(api.customFields.getForContact, {
    contactId: contactId as Id<'contacts'>,
  });
  const fields = useMemo(() => (fieldsRes ?? []).map(toUiCustomField), [fieldsRes]);
  const setForContact = useMutation(api.customFields.setForContact);

  // Local editable map: fieldId -> string value (multiselect = JSON array string).
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!valuesRes) return;
    const next: Record<string, string> = {};
    for (const v of valuesRes) next[v.customFieldId] = v.value ?? '';
    setValues(next);
  }, [valuesRes]);

  async function commit(next: Record<string, string>) {
    setValues(next);
    try {
      await setForContact({
        contactId: contactId as Id<'contacts'>,
        values: Object.entries(next)
          .filter(([, val]) => val.trim() !== '' && val !== '[]')
          .map(([customFieldId, value]) => ({
            customFieldId: customFieldId as Id<'customFields'>,
            value,
          })),
      });
    } catch {
      toast.error(t('failed'));
    }
  }

  if (fields.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">{t('none')}</p>;
  }

  return (
    <div className="mt-2 space-y-2">
      {fields.map((field) => (
        <FieldInput
          key={field.id}
          field={field}
          value={values[field.id] ?? ''}
          onChange={(val) => commit({ ...values, [field.id]: val })}
        />
      ))}
    </div>
  );
}

function FieldInput({
  field, value, onChange,
}: {
  field: CustomField;
  value: string;
  onChange: (value: string) => void;
}) {
  const options = (field.field_options?.options as string[] | undefined) ?? [];
  const label = <p className="text-xs capitalize text-muted-foreground">{field.field_name}</p>;

  if (field.field_type === 'select') {
    return (
      <div className="space-y-1">
        {label}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground"
        >
          <option value="">—</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }

  if (field.field_type === 'multiselect') {
    const selected: string[] = value ? safeParse(value) : [];
    const toggle = (o: string) => {
      const next = selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o];
      onChange(JSON.stringify(next));
    };
    return (
      <div className="space-y-1">
        {label}
        <div className="flex flex-wrap gap-1">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => toggle(o)}
              className={`rounded-full px-2 py-0.5 text-[11px] ${
                selected.includes(o)
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {o}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const inputType = field.field_type === 'date' ? 'date' : field.field_type === 'number' ? 'number' : 'text';
  return (
    <div className="space-y-1">
      {label}
      <Input
        type={inputType}
        defaultValue={value}
        onBlur={(e) => onChange(e.target.value)}
        className="h-8 bg-muted text-sm"
      />
    </div>
  );
}

function safeParse(s: string): string[] {
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 3: Add the section to `contact-sidebar.tsx`** — after the Labels block (Task 9), add a divider + section:

```tsx
<Divider />
<div>
  <SectionLabel icon={SlidersHorizontal} label={tCustom('title')} />
  <ContactCustomFields contactId={contact.id} />
</div>
```

Import `ContactCustomFields` (`import { ContactCustomFields } from "./contact-custom-fields";`) and `SlidersHorizontal` from `lucide-react`, and add `const tCustom = useTranslations("Inbox.customFields")`.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint src/components/inbox/contact-custom-fields.tsx src/components/inbox/contact-sidebar.tsx`
Expected: no errors.

- [ ] **Step 5: Verify in the browser** — with a `select` field "Product Category" and a `multiselect` "Destinations" configured, open a chat, set the dropdown, toggle destinations, reload, and confirm values persist. Screenshot. (Auth-gated — note if unavailable.)

- [ ] **Step 6: Commit**

```bash
git add src/components/inbox/contact-custom-fields.tsx src/components/inbox/contact-sidebar.tsx messages/en.json
git commit -m "feat(inbox): editable typed custom fields in chat sidebar"
```

---

## Task 11: Full-suite verification + Phase 1 wrap

**Files:** none (verification only)

- [ ] **Step 1: Run the entire Convex test suite**

Run: `npx vitest run convex/`
Expected: PASS — the pre-existing ~1500 tests plus the new tagGroups/tags/contacts/customFields tests.

- [ ] **Step 2: Run the frontend logic tests + typecheck + build**

Run: `npx vitest run src/lib/inbox/labels.test.ts && npx tsc --noEmit && npx next build`
Expected: tests PASS, no type errors, build succeeds.

- [ ] **Step 3: Update the deploy note** — append a short "Phase 1 deploy checklist" to the spec file (`docs/superpowers/specs/2026-07-15-inbox-tag-label-system-design.md`): owner runs `convex deploy` to `convex-api.holidayys.co` (new `tagGroups` table + `tags` fields) and lets Netlify build `main` after merge. No backfill needed in Phase 1 (that arrives with `conversationTags` in Phase 2). Commit the doc update.

- [ ] **Step 4: Finish the branch** — invoke the `superpowers:finishing-a-development-branch` skill to choose merge/PR/cleanup. Do NOT auto-merge or deploy; the owner controls the `convex deploy`.

---

## Self-review notes (author)

- **Spec coverage (Phase 1 scope):** grouped tags (Tasks 1-3), single/multi selection semantics (Task 4 server + Tasks 7/9 UI), inbox label assignment (Task 9), typed + editable custom fields (Tasks 5, 8, 10), roles (every backend task's gate), i18n (each UI task). Phase 2 (server-side filtering, `conversationTags`, time labels) and Phase 3 (follow-ups) are intentionally excluded — separate plans.
- **Deferred to Phase 2/3 by design:** `conversationTags`, `conversations.list` filter args, time smart-labels, follow-up fields/indexes. Not gaps.
- **Type consistency:** `selectionMode` (Convex) ↔ `selection_mode` (UI type); `groupId`/`fieldOptions` (Convex) ↔ `group_id`/`field_options` (UI). Adapters (`toUiTag`, `toUiTagGroup`, `toUiCustomField`) are the single translation boundary. `assignTag`/`unassignTag` signatures unchanged.
- **Known soft spots for the implementer:** (a) confirm `@/components/ui/popover` exists (Task 9 fallback noted); (b) the exact translations root already used in `contact-sidebar.tsx` (reuse vs. add namespace) — Task 9/10 call this out; (c) browser verification is auth-gated — lean on tsc/lint/build gates when no session is available.
