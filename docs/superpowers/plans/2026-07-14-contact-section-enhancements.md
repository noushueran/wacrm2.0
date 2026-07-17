# Contact Section Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give contacts a `+CC`-formatted phone (country picker on entry), a human-readable sequential Contact ID (`HC-000123`), list search by phone/email/ID, and open-chat + copy-ID actions.

**Architecture:** A per-account `counters` table + `allocateContactCode` helper assigns `HC-…` codes at every contact-insert site (manual create, public-API find-or-create, inbound-WhatsApp ingest; import reuses `contacts.create`). A one-shot backfill codes existing contacts. `contacts.list` gains an in-memory search branch over name/phone/email/ID. `libphonenumber-js` powers a `PhoneInput` country picker and a `formatPhoneDisplay` helper used across the contacts UI. "Open chat" reuses the existing `conversations.findOrCreateForContact` + the inbox `?c=` deep-link.

**Tech Stack:** Next.js 16 (customized — see Global Constraints), React 19, Convex (self-hosted), convex-test + vitest, next-intl, Tailwind, `libphonenumber-js` (new).

## Global Constraints

- **Customized Next.js.** `wacrm2.0/AGENTS.md`: "This is NOT the Next.js you know." Before writing Next-specific code (routing, navigation), check `node_modules/next/dist/docs/`.
- **One live Convex prod.** `npx convex dev` / `deploy` / `codegen` ALL push to the single self-hosted prod DB — **do not run them.** Build/verify offline only.
- **No `_generated` edits needed.** `convex/_generated/dataModel.d.ts` is `DataModelFromSchemaDefinition<typeof schema>`, and `api.d.ts` already imports the `contacts`/`conversations` modules — a new table/field/index in `schema.ts` plus new exports in existing modules type-check with no `_generated` change.
- **Convex tenant fns** use `accountQuery`/`accountMutation` (ctx carries `accountId`/`userId`/`role`/`requireRole`); never raw `query`/`mutation` for account-scoped reads/writes. Inbound/action paths use `internalMutation` with an explicit `accountId` arg.
- **Convex tests:** `convexTest(schema, modules)` with `const modules = import.meta.glob("/convex/**/*.ts")`; auth via `t.withIdentity({ subject: "<userId>|<session>" })`; assert errors via `.rejects.toMatchObject({ data: { code } })`; seed rows via `t.run`. Reuse the `seedAccountMember` helper already in `convex/contacts.test.ts`.
- **No RTL/jsdom configured.** Unit-test pure logic modules only; verify React components with `npm run typecheck` + `npm run lint` + `npm run build`.
- **Verification commands:** `npm test` (vitest), `npm run typecheck` (`tsc --noEmit`), `npm run lint`, `npm run build`. Run from `wacrm2.0/`.
- **Do NOT deploy or run the backfill against prod.** Those are the owner's steps (see the Rollout section at the end).
- **Contact ID format:** `HC-` + the running number zero-padded to a **minimum of 6 digits** (`HC-000001`; natural width beyond 999999).
- **Default phone country:** UAE (`AE`).
- **Commit** after every green task.

---

### Task 1: Schema + `allocateContactCode`, wired into `contacts.create`

**Files:**
- Modify: `convex/schema.ts` (the `contacts` table ~line 58; add a new `counters` table)
- Modify: `convex/contacts.ts` (add helpers near the top; use in `create` ~line 74)
- Test: `convex/contacts.test.ts` (append)

**Interfaces:**
- Produces:
  - `contacts.contactCode?: string` + index `by_account_code` on `["accountId", "contactCode"]`.
  - `counters` table `{ accountId: Id<"accounts">, name: string, value: number }`, index `by_account_name` on `["accountId", "name"]`.
  - `formatContactCode(n: number): string` (exported from `convex/contacts.ts`).
  - `allocateContactCode(db: MutationCtx["db"], accountId: Id<"accounts">): Promise<string>` (exported from `convex/contacts.ts`).

- [ ] **Step 1: Write the failing test**

Append to `convex/contacts.test.ts`:

```ts
test("create assigns sequential HC- contact codes per account, starting at HC-000001", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const firstId = await asUser.mutation(api.contacts.create, { phone: "111" });
  const secondId = await asUser.mutation(api.contacts.create, { phone: "222" });

  const first = await t.run((ctx) => ctx.db.get(firstId));
  const second = await t.run((ctx) => ctx.db.get(secondId));
  expect(first!.contactCode).toBe("HC-000001");
  expect(second!.contactCode).toBe("HC-000002");
});

test("contact codes are numbered independently per account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const aliceId = await asAlice.mutation(api.contacts.create, { phone: "111" });
  const bobId = await asBob.mutation(api.contacts.create, { phone: "111" });

  const alice = await t.run((ctx) => ctx.db.get(aliceId));
  const bob = await t.run((ctx) => ctx.db.get(bobId));
  expect(alice!.contactCode).toBe("HC-000001");
  expect(bob!.contactCode).toBe("HC-000001");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- contacts.test.ts -t "sequential HC-"`
Expected: FAIL — `contactCode` is `undefined`.

- [ ] **Step 3: Add the schema changes**

In `convex/schema.ts`, add `contactCode` to the `contacts` table (with the other optional fields) and the `by_account_code` index:

```ts
  contacts: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    phone: v.string(),
    phoneNormalized: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    company: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    // Human-readable per-account identifier, e.g. "HC-000123". Optional in
    // the schema so pre-backfill rows validate, but written on every new
    // insert via `allocateContactCode`.
    contactCode: v.optional(v.string()),
    altPhone: v.optional(v.string()),
    address: v.optional(v.string()),
    city: v.optional(v.string()),
    country: v.optional(v.string()),
    nationality: v.optional(v.string()),
    preferredDestination: v.optional(v.string()),
    notes: v.optional(v.string()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_phone", ["accountId", "phoneNormalized"])
    .index("by_account_code", ["accountId", "contactCode"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["accountId"],
    }),
```

Add a `counters` table (place it right after the `contacts`/`tags`/`contactTags` block):

```ts
  // Per-account monotonic counters for human-readable sequential codes
  // (e.g. `("contacts")` backs the HC-000123 contact code). One row per
  // (accountId, name); `value` is the last number allocated (0 = none yet).
  counters: defineTable({
    accountId: v.id("accounts"),
    name: v.string(),
    value: v.number(),
  }).index("by_account_name", ["accountId", "name"]),
```

- [ ] **Step 4: Add the allocator + formatter and use them in `create`**

In `convex/contacts.ts`, add near the top (after the imports/helpers, before `create`):

```ts
/** Formats a running number as the human-readable contact code, e.g.
 *  1 -> "HC-000001". Pad is a 6-digit MINIMUM (natural width beyond). */
export function formatContactCode(n: number): string {
  return `HC-${String(n).padStart(6, "0")}`;
}

/**
 * Atomically allocates the next `HC-…` code for `accountId` by
 * incrementing the account's `("contacts")` counter row (creating it at 1
 * the first time). Convex mutations are transactional with optimistic-
 * concurrency retry, so two concurrent creates can't collide on a number.
 * Takes a bare `db` so it works from `accountMutation`, the plain-`{db}`
 * `findOrCreateContactByPhone`, and the `internalMutation` inbound path.
 */
export async function allocateContactCode(
  db: MutationCtx["db"],
  accountId: Id<"accounts">,
): Promise<string> {
  const existing = await db
    .query("counters")
    .withIndex("by_account_name", (q) =>
      q.eq("accountId", accountId).eq("name", "contacts"),
    )
    .first();
  if (existing) {
    const next = existing.value + 1;
    await db.patch(existing._id, { value: next });
    return formatContactCode(next);
  }
  await db.insert("counters", { accountId, name: "contacts", value: 1 });
  return formatContactCode(1);
}
```

Then in `create`, allocate the code after the dedup check passes and include it in the insert:

```ts
    if (dup) {
      throw new ConvexError({ code: "DUPLICATE_PHONE", contactId: dup._id });
    }
    const contactCode = await allocateContactCode(ctx.db, ctx.accountId);
    return await ctx.db.insert("contacts", {
      accountId: ctx.accountId,
      createdByUserId: ctx.userId,
      phone: args.phone,
      phoneNormalized,
      contactCode,
      name: args.name,
      email: args.email,
      company: args.company,
    });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- contacts.test.ts`
Expected: PASS (new tests + all existing contacts tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add convex/schema.ts convex/contacts.ts convex/contacts.test.ts
git commit -m "feat(contacts): sequential HC- contact code on create"
```

---

### Task 2: Route `findOrCreateContactByPhone` and inbound ingest through the allocator

**Files:**
- Modify: `convex/contacts.ts` (`findOrCreateContactByPhone` ~line 527)
- Modify: `convex/ingest.ts` (`ingestInbound` contact-create branch ~line 166)
- Test: `convex/contacts.test.ts` and `convex/ingest.test.ts` (append)

**Interfaces:**
- Consumes: `allocateContactCode` (Task 1).
- Produces: every server-side `contacts` insert now carries `contactCode`.

- [ ] **Step 1: Write the failing tests**

Append to `convex/contacts.test.ts`:

```ts
test("findOrCreateByPhoneInternal assigns a contact code on create, none extra on find", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const created = await t.mutation(
    internal.contacts.findOrCreateByPhoneInternal,
    { accountId, phone: "+971501234567", name: "Guest" },
  );
  expect(created.created).toBe(true);
  const row = await t.run((ctx) => ctx.db.get(created.contactId));
  expect(row!.contactCode).toBe("HC-000001");

  const found = await t.mutation(
    internal.contacts.findOrCreateByPhoneInternal,
    { accountId, phone: "+971501234567" },
  );
  expect(found.created).toBe(false);
  expect(found.contactId).toBe(created.contactId);

  // No wasted number: the counter only advanced once.
  const counter = await t.run((ctx) =>
    ctx.db
      .query("counters")
      .withIndex("by_account_name", (q) =>
        q.eq("accountId", accountId).eq("name", "contacts"),
      )
      .first(),
  );
  expect(counter!.value).toBe(1);
});
```

Add `import { internal } from "./_generated/api";` to `convex/contacts.test.ts` if not already present (it imports `api` today).

Append to `convex/ingest.test.ts` (mirror that file's existing seeding/setup for `ingestInbound`; construct the same `message`/args shape its other tests use):

```ts
test("ingestInbound assigns a contact code when it creates a new contact", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedIngestAccount(t); // reuse this file's existing account seeder

  const res = await t.mutation(internal.ingest.ingestInbound, {
    accountId,
    from: "+971501234567",
    name: "Guest",
    message: sampleInboundText("hello"), // reuse this file's existing message factory
  });

  const contact = await t.run((ctx) => ctx.db.get(res.contactId));
  expect(contact!.contactCode).toBe("HC-000001");
});
```

Note: use `convex/ingest.test.ts`'s own existing account seeder and inbound-message factory (whatever they are named there) rather than inventing new ones; the two `// reuse …` placeholders above are the only lines to adapt to that file's helpers.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- contacts.test.ts -t "findOrCreateByPhoneInternal assigns"` then `npm test -- ingest.test.ts -t "assigns a contact code"`
Expected: FAIL — `contactCode` is `undefined`.

- [ ] **Step 3: Wire the allocator into `findOrCreateContactByPhone`**

In `convex/contacts.ts`, in the create branch of `findOrCreateContactByPhone`:

```ts
  if (existing) return { contactId: existing._id, created: false };

  const contactCode = await allocateContactCode(ctx.db, accountId);
  const contactId = await ctx.db.insert("contacts", {
    accountId,
    phone: input.phone,
    phoneNormalized,
    contactCode,
    name: input.name ?? input.phone,
    email: input.email,
    company: input.company,
  });
  return { contactId, created: true };
```

- [ ] **Step 4: Wire the allocator into `ingestInbound`**

In `convex/ingest.ts`, add the import and use it in the contact-create branch:

```ts
import { allocateContactCode } from "./contacts";
```

```ts
    } else {
      const contactCode = await allocateContactCode(ctx.db, accountId);
      contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: from,
        phoneNormalized,
        contactCode,
        name,
      });
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- contacts.test.ts ingest.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add convex/contacts.ts convex/ingest.ts convex/contacts.test.ts convex/ingest.test.ts
git commit -m "feat(contacts): assign contact codes on find-or-create and inbound ingest"
```

---

### Task 3: Backfill mutation for existing contacts

**Files:**
- Modify: `convex/contacts.ts` (add `backfillContactCodes`)
- Test: `convex/contacts.test.ts` (append)

**Interfaces:**
- Consumes: `formatContactCode` (Task 1).
- Produces: `internal.contacts.backfillContactCodes` (no args) — assigns `HC-` codes to code-less contacts per account in `_creationTime` order, idempotently, and seeds each account's counter.

- [ ] **Step 1: Write the failing test**

Append to `convex/contacts.test.ts`:

```ts
test("backfillContactCodes assigns codes in creation order, is idempotent, and seeds the counter", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  // Insert three code-less contacts directly (simulating pre-migration rows).
  const ids: Id<"contacts">[] = [];
  for (const phone of ["111", "222", "333"]) {
    const id = await t.run((ctx) =>
      ctx.db.insert("contacts", { accountId, phone, phoneNormalized: phone }),
    );
    ids.push(id);
  }

  await t.mutation(internal.contacts.backfillContactCodes, {});

  const codes = await Promise.all(
    ids.map((id) => t.run((ctx) => ctx.db.get(id).then((c) => c!.contactCode))),
  );
  expect(codes).toEqual(["HC-000001", "HC-000002", "HC-000003"]);

  // Idempotent: re-running changes nothing.
  await t.mutation(internal.contacts.backfillContactCodes, {});
  const codesAgain = await Promise.all(
    ids.map((id) => t.run((ctx) => ctx.db.get(id).then((c) => c!.contactCode))),
  );
  expect(codesAgain).toEqual(["HC-000001", "HC-000002", "HC-000003"]);

  // Counter is seeded to the highest number used, so the next create
  // continues at HC-000004 rather than colliding at HC-000001.
  const counter = await t.run((ctx) =>
    ctx.db
      .query("counters")
      .withIndex("by_account_name", (q) =>
        q.eq("accountId", accountId).eq("name", "contacts"),
      )
      .first(),
  );
  expect(counter!.value).toBe(3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- contacts.test.ts -t "backfillContactCodes"`
Expected: FAIL — `internal.contacts.backfillContactCodes` does not exist.

- [ ] **Step 3: Implement the backfill**

In `convex/contacts.ts` (it already imports `internalMutation`):

```ts
/**
 * One-shot migration: assign `HC-…` codes to every contact that lacks one,
 * per account, in `_creationTime` order, and seed each account's
 * `("contacts")` counter to the highest number in use. Idempotent — coded
 * contacts are skipped and the counter never moves backwards, so it is safe
 * to re-run. Run once after deploying the schema change.
 */
export const backfillContactCodes = internalMutation({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").collect();
    for (const account of accounts) {
      const contacts = await ctx.db
        .query("contacts")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .collect();
      contacts.sort((a, b) => a._creationTime - b._creationTime);

      // Start from whichever is higher: the existing counter, or the max
      // numeric code already assigned (covers a counter that lags reality).
      const counter = await ctx.db
        .query("counters")
        .withIndex("by_account_name", (q) =>
          q.eq("accountId", account._id).eq("name", "contacts"),
        )
        .first();
      let next = counter?.value ?? 0;
      for (const c of contacts) {
        if (c.contactCode) {
          const n = Number(c.contactCode.replace(/\D/g, ""));
          if (Number.isFinite(n) && n > next) next = n;
        }
      }

      for (const c of contacts) {
        if (c.contactCode) continue;
        next += 1;
        await ctx.db.patch(c._id, { contactCode: formatContactCode(next) });
      }

      if (counter) {
        if (next !== counter.value) await ctx.db.patch(counter._id, { value: next });
      } else if (next > 0) {
        await ctx.db.insert("counters", {
          accountId: account._id,
          name: "contacts",
          value: next,
        });
      }
    }
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- contacts.test.ts -t "backfillContactCodes"`
Expected: PASS.

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run typecheck && npm test`
Expected: no errors; all green.

- [ ] **Step 6: Commit**

```bash
git add convex/contacts.ts convex/contacts.test.ts
git commit -m "feat(contacts): backfill mutation for existing contact codes"
```

---

### Task 4: Search by phone / email / ID in `contacts.list`

**Files:**
- Create: `convex/lib/contactSearch.ts`
- Create: `convex/lib/contactSearch.test.ts`
- Modify: `convex/contacts.ts` (`list` ~line 105)
- Test: `convex/contacts.test.ts` (append)

**Interfaces:**
- Produces:
  - `matchesContactCode(code: string | undefined, term: string): boolean`
  - `matchesContactSearch(c: { name?: string; phoneNormalized?: string; email?: string; contactCode?: string }, term: string): boolean`
- Consumes: contact codes from Task 1 (so created contacts are searchable by ID).

- [ ] **Step 1: Write the failing unit test for the matchers**

Create `convex/lib/contactSearch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { matchesContactCode, matchesContactSearch } from "./contactSearch";

describe("matchesContactCode", () => {
  it("matches by bare number, padded number, and full code (any case)", () => {
    expect(matchesContactCode("HC-000042", "42")).toBe(true);
    expect(matchesContactCode("HC-000042", "000042")).toBe(true);
    expect(matchesContactCode("HC-000042", "HC-000042")).toBe(true);
    expect(matchesContactCode("HC-000042", "hc-000042")).toBe(true);
  });
  it("does not match a different number or an empty/undefined code", () => {
    expect(matchesContactCode("HC-000042", "43")).toBe(false);
    expect(matchesContactCode(undefined, "42")).toBe(false);
    expect(matchesContactCode("HC-000042", "")).toBe(false);
  });
});

describe("matchesContactSearch", () => {
  const c = {
    name: "Jonas Petraitis",
    phoneNormalized: "971501234567",
    email: "jonas@example.com",
    contactCode: "HC-000042",
  };
  it("matches name, email, phone digits, and id", () => {
    expect(matchesContactSearch(c, "jonas")).toBe(true);
    expect(matchesContactSearch(c, "EXAMPLE")).toBe(true);
    expect(matchesContactSearch(c, "50123")).toBe(true);
    expect(matchesContactSearch(c, "+971 50")).toBe(true); // non-digits ignored for phone
    expect(matchesContactSearch(c, "42")).toBe(true);
  });
  it("returns false when nothing matches", () => {
    expect(matchesContactSearch(c, "zzz")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- contactSearch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the matchers**

Create `convex/lib/contactSearch.ts`:

```ts
/** True when `term` plausibly refers to the `HC-…` code: a case-insensitive
 *  substring of the full code, or a digit run equal to the code's number
 *  ignoring leading zeros ("42" == "HC-000042"). */
export function matchesContactCode(
  code: string | undefined,
  term: string,
): boolean {
  if (!code) return false;
  const t = term.trim().toLowerCase();
  if (!t) return false;
  if (code.toLowerCase().includes(t)) return true;
  const codeDigits = code.replace(/\D/g, "");
  const termDigits = t.replace(/\D/g, "");
  return (
    termDigits.length > 0 &&
    codeDigits.length > 0 &&
    Number(codeDigits) === Number(termDigits)
  );
}

/** Case-insensitive match of a contact against a free-text term across
 *  name, email, phone (digits only), and contact code. Empty term = match. */
export function matchesContactSearch(
  c: {
    name?: string;
    phoneNormalized?: string;
    email?: string;
    contactCode?: string;
  },
  term: string,
): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  if (c.name && c.name.toLowerCase().includes(t)) return true;
  if (c.email && c.email.toLowerCase().includes(t)) return true;
  const termDigits = t.replace(/\D/g, "");
  if (termDigits && c.phoneNormalized && c.phoneNormalized.includes(termDigits))
    return true;
  return matchesContactCode(c.contactCode, term);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- contactSearch.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing integration test for `list` search**

Append to `convex/contacts.test.ts`:

```ts
test("list search matches by phone digits, email, and contact ID (not just name)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "supervisor", // supervisor+ so the phone isn't masked in the result
  });

  await asUser.mutation(api.contacts.create, {
    phone: "+971501234567",
    name: "Jonas",
    email: "jonas@travel.com",
  }); // HC-000001
  await asUser.mutation(api.contacts.create, { phone: "222", name: "Marija" });

  const byPhone = await asUser.query(api.contacts.list, {
    search: "50123",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(byPhone.page.map((c) => c.name)).toEqual(["Jonas"]);

  const byEmail = await asUser.query(api.contacts.list, {
    search: "travel.com",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(byEmail.page.map((c) => c.name)).toEqual(["Jonas"]);

  const byId = await asUser.query(api.contacts.list, {
    search: "HC-000001",
    paginationOpts: { numItems: 50, cursor: null },
  });
  expect(byId.page.map((c) => c.name)).toEqual(["Jonas"]);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -- contacts.test.ts -t "list search matches by phone"`
Expected: FAIL — the current search index only covers `name`, so `byPhone`/`byEmail`/`byId` are empty.

- [ ] **Step 7: Rewrite the `list` search branch**

In `convex/contacts.ts`, add the import:

```ts
import { matchesContactSearch } from "./lib/contactSearch";
```

Replace the body of `list`'s handler with:

```ts
  handler: async (ctx, args) => {
    const { search, paginationOpts } = args;
    const term = search?.trim();

    const embedAndMask = async (contact: Doc<"contacts">) => {
      const withTags = await embedTags(ctx, contact);
      return hasMinRole(ctx.role, "supervisor")
        ? withTags
        : maskContactPhone(withTags);
    };

    if (term) {
      // Full name/phone/email/ID search: scan the account's contacts in
      // memory (same approach as `filterByTags`), newest-first, and page
      // manually with the cursor as a stringified offset. Bounded by the
      // account's own contact count; search does not use the name index.
      const all = await ctx.db
        .query("contacts")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
        .order("desc")
        .collect();
      const matched = all.filter((c) => matchesContactSearch(c, term));
      const offset = paginationOpts.cursor
        ? Number(paginationOpts.cursor)
        : 0;
      const end = offset + paginationOpts.numItems;
      const page = await Promise.all(matched.slice(offset, end).map(embedAndMask));
      return { page, isDone: end >= matched.length, continueCursor: String(end) };
    }

    const result = await ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .paginate(paginationOpts);
    const page = await Promise.all(result.page.map(embedAndMask));
    return { ...result, page };
  },
```

Note: the `search_name` search index in `schema.ts` is now unused by `list` but is left in place (removing it is an unrelated schema change).

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -- contacts.test.ts`
Expected: PASS, including the pre-existing "list search_name matches by name prefix" test (name search still works via the new branch).

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add convex/lib/contactSearch.ts convex/lib/contactSearch.test.ts convex/contacts.ts convex/contacts.test.ts
git commit -m "feat(contacts): list search by phone, email, and contact ID"
```

---

### Task 5: `formatPhoneDisplay` helper + add `libphonenumber-js`

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/lib/whatsapp/phone-utils.ts` (add `formatPhoneDisplay`)
- Test: `src/lib/whatsapp/phone-utils.test.ts` (append)

**Interfaces:**
- Produces: `formatPhoneDisplay(value: string): string` — international spaced form via `libphonenumber-js`, falling back to `formatPhoneIntl` on unparseable input.

- [ ] **Step 1: Add the dependency**

Run: `npm install libphonenumber-js`
Expected: `libphonenumber-js` added to `package.json` dependencies and lockfile.

- [ ] **Step 2: Write the failing test**

Append to `src/lib/whatsapp/phone-utils.test.ts` (add `formatPhoneDisplay` to the existing import from `./phone-utils`):

```ts
describe("formatPhoneDisplay", () => {
  it("formats a full international number with spacing", () => {
    expect(formatPhoneDisplay("+971501234567")).toBe("+971 50 123 4567");
  });
  it("adds the + for a digits-only number and handles a 00 prefix", () => {
    expect(formatPhoneDisplay("971501234567")).toBe("+971 50 123 4567");
    expect(formatPhoneDisplay("00971501234567")).toBe("+971 50 123 4567");
  });
  it("returns empty for blank input", () => {
    expect(formatPhoneDisplay("")).toBe("");
  });
  it("falls back to +digits for an unparseable number", () => {
    expect(formatPhoneDisplay("123")).toBe("+123");
  });
});
```

(If `phone-utils.test.ts` doesn't already import `describe`, add it to the `vitest` import.)

- [ ] **Step 3: Run it to verify it fails**

Run: `npm test -- phone-utils.test.ts -t "formatPhoneDisplay"`
Expected: FAIL — `formatPhoneDisplay` is not exported.

- [ ] **Step 4: Implement `formatPhoneDisplay`**

In `src/lib/whatsapp/phone-utils.ts` add at the top:

```ts
import { parsePhoneNumberFromString } from 'libphonenumber-js'
```

and append:

```ts
/**
 * Human-facing international format, e.g. "+971 50 123 4567". Normalizes a
 * digits-only or `00`-prefixed value to `+E.164` first, then formats via
 * libphonenumber-js; falls back to `formatPhoneIntl` (bare `+digits`) when
 * the number can't be parsed. Blank input returns "".
 */
export function formatPhoneDisplay(phone: string): string {
  if (!phone || !phone.trim()) return ''
  let digits = phone.replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (!digits) return ''
  const parsed = parsePhoneNumberFromString(`+${digits}`)
  if (parsed) return parsed.formatInternational()
  return formatPhoneIntl(phone)
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npm test -- phone-utils.test.ts`
Expected: PASS.
If a spacing assertion differs from libphonenumber's actual output for a number, adjust the expected string to match the library (the goal is "correct international spacing," not a hand-picked layout). Confirm the exact export name against the installed version if `tsc` complains — the docs MCP (`resolve-library-id` → `query-docs` for `libphonenumber-js`) has the current API.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/lib/whatsapp/phone-utils.ts src/lib/whatsapp/phone-utils.test.ts
git commit -m "feat(phone): formatPhoneDisplay via libphonenumber-js"
```

---

### Task 6: Surface `contact_code`, add ID column + formatted phone + Open-chat row action

**Files:**
- Modify: `src/types/index.ts` (`Contact` ~line 99)
- Modify: `src/lib/convex/adapters.ts` (`toUiContact` ~line 88)
- Create: `src/hooks/use-open-contact-chat.ts`
- Modify: `src/app/(dashboard)/contacts/page.tsx` (table header/cells + row menu)

**Interfaces:**
- Produces:
  - `Contact.contact_code?: string`
  - `toUiContact` maps `doc.contactCode -> contact_code`
  - `useOpenContactChat(): (contactId: string) => Promise<void>` — find-or-creates the contact's conversation and navigates to `/inbox?c=<id>`.
- Consumes: `formatPhoneDisplay` (Task 5).

- [ ] **Step 1: Add `contact_code` to the `Contact` type**

In `src/types/index.ts`, inside `interface Contact` (after `company?`):

```ts
  /** Human-readable per-account identifier, e.g. "HC-000123". */
  contact_code?: string;
```

- [ ] **Step 2: Map it in the adapter**

In `src/lib/convex/adapters.ts`, in `toUiContact`'s returned object (after `company: doc.company,`):

```ts
    contact_code: doc.contactCode,
```

- [ ] **Step 3: Add the open-chat hook**

Create `src/hooks/use-open-contact-chat.ts`:

```ts
'use client';

import { useRouter } from 'next/navigation';
import { useMutation } from 'convex/react';
import { toast } from 'sonner';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { convexErrorMessage } from '@/lib/convex/adapters';

/**
 * Returns a handler that opens (find-or-creates) the contact's WhatsApp
 * conversation and navigates to it in the inbox via the `?c=` deep-link
 * the inbox page already reads (`src/app/(dashboard)/inbox/page.tsx`).
 */
export function useOpenContactChat(): (contactId: string) => Promise<void> {
  const router = useRouter();
  const findOrCreate = useMutation(api.conversations.findOrCreateForContact);
  return async (contactId: string) => {
    try {
      const conversationId = await findOrCreate({
        contactId: contactId as Id<'contacts'>,
      });
      router.push(`/inbox?c=${conversationId}`);
    } catch (err) {
      toast.error(convexErrorMessage(err));
    }
  };
}
```

- [ ] **Step 4: Show the ID column, format the phone, add the row action**

In `src/app/(dashboard)/contacts/page.tsx`:

Add imports:

```ts
import { formatPhoneDisplay } from '@/lib/whatsapp/phone-utils';
import { useOpenContactChat } from '@/hooks/use-open-contact-chat';
import { MessageSquare } from 'lucide-react';
```

Inside `ContactsPage`, near the other hooks:

```ts
  const openChat = useOpenContactChat();
```

In the table header, add a Contact ID column before the Name column:

```tsx
              <TableHead className="text-muted-foreground hidden sm:table-cell">{t('tableColumns.contactId')}</TableHead>
              <TableHead className="text-muted-foreground">{t('tableColumns.name')}</TableHead>
```

In the body row, add the ID cell (before the name cell) and format the phone cell:

```tsx
                  <TableCell className="text-muted-foreground font-mono text-xs hidden sm:table-cell">
                    {contact.contact_code || '—'}
                  </TableCell>
                  <TableCell className="text-foreground font-medium">
                    {contact.name || <span className="text-muted-foreground italic">{t('unnamed')}</span>}
                  </TableCell>
```

Change the phone cell to:

```tsx
                  <TableCell className="text-muted-foreground font-mono text-xs">
                    {formatPhoneDisplay(contact.phone)}
                  </TableCell>
```

Update the two loading/empty `TableCell colSpan={8}` values to `colSpan={9}` (a column was added).

Add an "Open chat" item to the row dropdown (before the Edit item):

```tsx
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            void openChat(contact.id);
                          }}
                          className="text-popover-foreground focus:bg-muted focus:text-foreground"
                        >
                          <MessageSquare className="size-4" />
                          {t('openChatAction')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-border" />
```

- [ ] **Step 5: Add the i18n strings**

Add `Contacts.page.tableColumns.contactId`, `Contacts.page.openChatAction`, and (Task 8) `Contacts.detailView.openChatBtn` / `Contacts.detailView.copyId` to every locale file under `src/` messages (match the existing message-file structure and locale set used by `useTranslations('Contacts.page')`). Grep an existing key such as `tableColumns.name` to find all locale files and add the new keys to each so no locale is missing a string.

Suggested English values: `contactId: "Contact ID"`, `openChatAction: "Open chat"`, `openChatBtn: "Open chat"`, `copyId: "Copy ID"`.

- [ ] **Step 6: Verify (typecheck, lint, build)**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: no errors; the contacts page compiles with the new column, formatted phone, and row action. (No RTL suite exists; this is the verification for presentational changes.)

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/lib/convex/adapters.ts src/hooks/use-open-contact-chat.ts "src/app/(dashboard)/contacts/page.tsx" src/**/messages* 2>/dev/null; git add -A
git commit -m "feat(contacts): show contact ID column, formatted phone, open-chat row action"
```

---

### Task 7: `PhoneInput` country picker + wire into the create/edit form

**Files:**
- Create: `src/lib/whatsapp/phone-input-logic.ts`
- Create: `src/lib/whatsapp/phone-input-logic.test.ts`
- Create: `src/components/ui/phone-input.tsx`
- Modify: `src/components/contacts/contact-form.tsx` (phone field ~line 219)

**Interfaces:**
- Produces:
  - `DEFAULT_COUNTRY: CountryCode` (= `'AE'`)
  - `listCountryOptions(): { country: CountryCode; dialCode: string; flag: string }[]`
  - `composeE164(country: CountryCode, national: string): string`
  - `isValidNationalNumber(country: CountryCode, national: string): boolean`
  - `splitE164(value: string): { country: CountryCode; national: string } | null`
  - `<PhoneInput value={string} onChange={(e164: string) => void} />`

- [ ] **Step 1: Write the failing logic test**

Create `src/lib/whatsapp/phone-input-logic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COUNTRY,
  composeE164,
  isValidNationalNumber,
  listCountryOptions,
  splitE164,
} from "./phone-input-logic";

describe("phone-input-logic", () => {
  it("defaults to the UAE", () => {
    expect(DEFAULT_COUNTRY).toBe("AE");
  });

  it("lists countries with dial codes and a flag, including AE +971", () => {
    const opts = listCountryOptions();
    const ae = opts.find((o) => o.country === "AE");
    expect(ae?.dialCode).toBe("971");
    expect(ae?.flag).toBe("🇦🇪");
    expect(opts.length).toBeGreaterThan(100);
  });

  it("composes a national number into E.164", () => {
    expect(composeE164("AE", "50 123 4567")).toBe("+971501234567");
    expect(composeE164("GB", "7700 900123")).toBe("+447700900123");
  });

  it("validates a national number for its country", () => {
    expect(isValidNationalNumber("AE", "50 123 4567")).toBe(true);
    expect(isValidNationalNumber("AE", "123")).toBe(false);
  });

  it("splits an E.164 value back into country + national number", () => {
    expect(splitE164("+971501234567")).toEqual({
      country: "AE",
      national: "501234567",
    });
    expect(splitE164("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- phone-input-logic.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the logic module**

Create `src/lib/whatsapp/phone-input-logic.ts`:

```ts
import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js'

export const DEFAULT_COUNTRY: CountryCode = 'AE'

/** Regional-indicator flag emoji for an ISO-3166 alpha-2 code, e.g. 🇦🇪. */
function flagFor(country: string): string {
  return country
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)))
}

/** All dialable countries with their calling code and flag, sorted by name-
 *  agnostic country code (stable). Consumers can re-sort for display. */
export function listCountryOptions(): {
  country: CountryCode
  dialCode: string
  flag: string
}[] {
  return getCountries()
    .map((country) => ({
      country,
      dialCode: getCountryCallingCode(country),
      flag: flagFor(country),
    }))
    .sort((a, b) => a.country.localeCompare(b.country))
}

/** Compose a (possibly spaced) national number into `+E.164`. Falls back to
 *  `+<dialCode><digits>` when the number is incomplete/unparseable so the
 *  stored value always carries the country code. */
export function composeE164(country: CountryCode, national: string): string {
  const parsed = parsePhoneNumberFromString(national, country)
  if (parsed) return parsed.number
  const digits = national.replace(/\D/g, '')
  return `+${getCountryCallingCode(country)}${digits}`
}

export function isValidNationalNumber(
  country: CountryCode,
  national: string,
): boolean {
  return isValidPhoneNumber(national, country)
}

/** Parse a stored `+E.164` value back into the picker's parts. */
export function splitE164(
  value: string,
): { country: CountryCode; national: string } | null {
  if (!value || !value.trim()) return null
  const parsed = parsePhoneNumberFromString(value)
  if (!parsed || !parsed.country) return null
  return { country: parsed.country, national: parsed.nationalNumber }
}

/** Live as-you-type formatting for the national-number input. */
export function formatAsYouType(country: CountryCode, national: string): string {
  return new AsYouType(country).input(national)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test -- phone-input-logic.test.ts`
Expected: PASS. (If a flag/dial-code assertion differs, correct the expectation to match libphonenumber's data — the intent is real country data, not hand-authored values.)

- [ ] **Step 5: Build the `PhoneInput` component**

Create `src/components/ui/phone-input.tsx`. It renders a country `<select>` (flag + `+dial`) beside the national-number `<Input>`, keeps local country/national state seeded from `value` via `splitE164`, and calls `onChange(composeE164(country, national))` on every change:

```tsx
'use client';

import { useEffect, useState } from 'react';
import type { CountryCode } from 'libphonenumber-js';
import { Input } from '@/components/ui/input';
import {
  DEFAULT_COUNTRY,
  composeE164,
  formatAsYouType,
  listCountryOptions,
  splitE164,
} from '@/lib/whatsapp/phone-input-logic';

const COUNTRY_OPTIONS = listCountryOptions();

interface PhoneInputProps {
  value: string;
  onChange: (e164: string) => void;
  id?: string;
  placeholder?: string;
}

export function PhoneInput({ value, onChange, id, placeholder }: PhoneInputProps) {
  const initial = splitE164(value);
  const [country, setCountry] = useState<CountryCode>(
    initial?.country ?? DEFAULT_COUNTRY,
  );
  const [national, setNational] = useState<string>(initial?.national ?? '');

  // Re-seed when the incoming value changes to a different number (e.g. the
  // form switches from "add" to "edit", or resets on open).
  useEffect(() => {
    const parts = splitE164(value);
    if (parts) {
      setCountry(parts.country);
      setNational(parts.national);
    } else if (!value) {
      setNational('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only on external value change
  }, [value]);

  function emit(nextCountry: CountryCode, nextNational: string) {
    onChange(composeE164(nextCountry, nextNational));
  }

  return (
    <div className="flex gap-2">
      <select
        aria-label="Country calling code"
        value={country}
        onChange={(e) => {
          const next = e.target.value as CountryCode;
          setCountry(next);
          emit(next, national);
        }}
        className="rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary/50"
      >
        {COUNTRY_OPTIONS.map((o) => (
          <option key={o.country} value={o.country}>
            {o.flag} +{o.dialCode}
          </option>
        ))}
      </select>
      <Input
        id={id}
        inputMode="tel"
        value={national}
        placeholder={placeholder}
        onChange={(e) => {
          const formatted = formatAsYouType(country, e.target.value);
          setNational(formatted);
          emit(country, formatted);
        }}
        className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
      />
    </div>
  );
}
```

- [ ] **Step 6: Wire `PhoneInput` into the contact form**

In `src/components/contacts/contact-form.tsx`, import it:

```ts
import { PhoneInput } from '@/components/ui/phone-input';
```

Replace the phone `<Input>` (the block using `id="cf-phone"`) with:

```tsx
            <PhoneInput
              id="cf-phone"
              value={phone}
              onChange={(next) => {
                setPhone(next);
                if (dupContactId) setDupContactId(null);
              }}
              placeholder={t('phonePlaceholder')}
            />
```

The existing `phone`/`setPhone` state, the `DUPLICATE_PHONE` handling, and the submit path stay unchanged (they already store whatever string `phone` holds; now it is always `+E.164`).

- [ ] **Step 7: Verify (typecheck, lint, build)**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: no errors. Confirm the `libphonenumber-js` imports resolve against the installed version (adjust names via the docs MCP if `tsc` flags one).

- [ ] **Step 8: Commit**

```bash
git add src/lib/whatsapp/phone-input-logic.ts src/lib/whatsapp/phone-input-logic.test.ts src/components/ui/phone-input.tsx src/components/contacts/contact-form.tsx
git commit -m "feat(contacts): country-picker PhoneInput on the contact form"
```

---

### Task 8: Detail drawer — PhoneInput, formatted header phone, copy ID, Open chat

**Files:**
- Modify: `src/components/contacts/contact-detail-view.tsx`

**Interfaces:**
- Consumes: `PhoneInput` (Task 7), `formatPhoneDisplay` (Task 5), `useOpenContactChat` (Task 6), `Contact.contact_code` (Task 6).

- [ ] **Step 1: Add imports**

In `src/components/contacts/contact-detail-view.tsx`:

```ts
import { PhoneInput } from '@/components/ui/phone-input';
import { formatPhoneDisplay } from '@/lib/whatsapp/phone-utils';
import { useOpenContactChat } from '@/hooks/use-open-contact-chat';
import { Hash, MessageSquare } from 'lucide-react';
```

Near the other hooks in the component:

```ts
  const openChat = useOpenContactChat();
  const [copiedId, setCopiedId] = useState(false);
```

- [ ] **Step 2: Show the contact ID (with copy) and format the header phone**

In the header meta row (the `flex flex-wrap … text-xs` block that currently renders the copy-phone button, email, company), change the phone button's text to the formatted phone:

```tsx
                      <Phone className="size-3" />
                      {formatPhoneDisplay(contact.phone)}
```

And add a copy-ID control right after the phone button (only when a code exists):

```tsx
                    {contact.contact_code && (
                      <button
                        onClick={async () => {
                          await navigator.clipboard.writeText(contact.contact_code!);
                          setCopiedId(true);
                          setTimeout(() => setCopiedId(false), 2000);
                        }}
                        className="flex items-center gap-1 font-mono hover:text-primary transition-colors cursor-pointer"
                        aria-label={t('copyId')}
                      >
                        <Hash className="size-3" />
                        {contact.contact_code}
                        {copiedId ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
                      </button>
                    )}
```

- [ ] **Step 3: Add the Open-chat button beside Send template**

In the header's action row (the `mt-3` div containing the Send template button), add before it:

```tsx
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void openChat(contact.id)}
                  className="border-border text-muted-foreground hover:bg-muted"
                >
                  <MessageSquare className="size-4" />
                  {t('openChatBtn')}
                </Button>
```

- [ ] **Step 4: Use `PhoneInput` in the Details tab**

Replace the Details-tab phone `<Input>` (the one bound to `editPhone`) with:

```tsx
                    <PhoneInput
                      value={editPhone}
                      onChange={setEditPhone}
                    />
```

The `saveDetails` path (which sends `phone: editPhone.trim()`) is unchanged — `editPhone` now always holds `+E.164`.

- [ ] **Step 5: Verify (typecheck, lint, build)**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: no errors.

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/components/contacts/contact-detail-view.tsx
git commit -m "feat(contacts): detail drawer PhoneInput, formatted phone, copy ID, open chat"
```

---

## Rollout (owner-run — NOT part of implementation)

The implementer stops after Task 8 with everything green offline. Deploying touches the single live Convex prod, so the owner runs:

1. `npx convex deploy` — pushes the schema (`counters` table, `contacts.contactCode` + `by_account_code`) and the new/changed functions.
2. Run the backfill once: `npx convex run contacts:backfillContactCodes` (assigns `HC-` codes to existing contacts; idempotent — safe to re-run).
3. Spot-check in the app: existing contacts show `HC-…` codes and `+CC`-formatted phones; a new manual contact enforces a valid `+CC` number and gets the next code; list search finds a contact by phone/email/ID; "Open chat" lands in the inbox thread.
4. The frontend ships via Netlify on `main` once merged.

## Self-review

- **Spec coverage:** §4 (ID: format/schema/allocation/backfill) → Tasks 1–3; §5 (phone input + display) → Tasks 5, 7, 8; §6 (search) → Task 4; §7 (open chat + copy ID + ID column) → Tasks 6, 8; §8 testing/rollout → per-task tests + Rollout section. All covered.
- **Deviation from spec §4.3 (noted):** import does not need a batch allocator — `ImportModal` calls `contacts.create` per row, so import inherits codes through Task 1 with no extra work. §8's "hand-edit `_generated`" is unnecessary (schema-derived types); replaced with an explicit "do not run codegen" constraint.
- **Type consistency:** `contactCode` (Convex doc) ↔ `contact_code` (UI `Contact`) mapped once in `toUiContact`; `allocateContactCode`/`formatContactCode`/`matchesContactSearch`/`formatPhoneDisplay`/`composeE164`/`splitE164`/`useOpenContactChat` names are used identically across the tasks that define and consume them.
- **Placeholders:** the only intentionally-parameterized spots are Task 2's reuse of `convex/ingest.test.ts`'s own existing seeder/message-factory names and Task 6's locale-file set — both are "match what the file/dir already does," not unresolved design.
