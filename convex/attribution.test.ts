import { expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { extractRefCode, extractCtwaClid } from "./attribution";

test("extractRefCode finds our code anywhere, uppercased", () => {
  expect(extractRefCode("Hi… my enquiry ref: hy-3f9k2q")).toBe("HY-3F9K2Q");
  expect(extractRefCode("just a normal message")).toBeNull();
  expect(extractRefCode(undefined)).toBeNull();
});

test("extractCtwaClid reads a flattened ctwaClid", () => {
  expect(extractCtwaClid({ ctwaClid: "abc123" })).toBe("abc123");
  expect(extractCtwaClid({})).toBeNull();
});

test("extractRefCode embeds code mid-sentence", () => {
  expect(extractRefCode("book now HY-ABCDEF please")).toBe("HY-ABCDEF");
});

test("extractRefCode charset boundary", () => {
  expect(extractRefCode("HY-IIIIII")).toBeNull();
  expect(extractRefCode("HY-000000")).toBe("HY-000000");
  expect(extractRefCode("HY-ABCDEL")).toBeNull(); // L now excluded
});

test("extractRefCode null input", () => {
  expect(extractRefCode(null)).toBeNull();
  expect(extractRefCode("")).toBeNull(); // empty string
});

// ============================================================
// recordSignal (Task B3) — convex-test integration. Convex function
// modules for convex-test to resolve `internal.*` references against.
// Absolute, from-project-root pattern (matches every other
// `convex/*.test.ts` suite — see `convex/ingest.test.ts`'s own comment
// on why this must be absolute rather than a relative "./**").
// ============================================================

const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Bare `users` + `accounts` row — same minimal shape as
 * `ingest.test.ts`'s own `seedAccount`: `recordSignal` is a plain
 * `internalMutation` with an explicit caller-supplied `accountId`, no
 * session/role to seed against — only the `accounts.ownerUserId` FK
 * `accounts` itself requires. Duplicated here (not imported) per this
 * suite's own established per-suite-owns-its-own-helpers convention.
 */
async function seedAccount(t: ReturnType<typeof convexTest>, name: string) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name,
      email: `${name.toLowerCase()}@example.com`,
    });
    return await ctx.db.insert("accounts", {
      name: `${name}'s account`,
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
  });
}

/** Minimal valid `contacts` row: `accountId`/`phone`/`phoneNormalized`
 *  are the table's only required fields (`convex/schema.ts`). */
async function seedContact(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "15551234567",
      phoneNormalized: "15551234567",
    }),
  );
}

/** Minimal valid `conversations` row: `accountId`/`contactId`/`status`/
 *  `unreadCount` are the table's only required fields. */
async function seedConversation(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  contactId: Id<"contacts">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
    }),
  );
}

test("recordSignal inserts a fresh pending row on first occurrence and returns its id", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const firstMessageAt = Date.now();

  const id = await t.mutation(internal.attribution.recordSignal, {
    accountId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    contactId,
    conversationId,
    firstMessageAt,
  });

  expect(id).not.toBeNull();

  const row = await t.run((ctx) =>
    ctx.db.get(id as Id<"attributionSignals">),
  );
  expect(row).not.toBeNull();
  expect(row!.accountId).toBe(accountId);
  expect(row!.identifier).toBe("HY-ABCDEF");
  expect(row!.lane).toBe("code");
  expect(row!.phone).toBe("15551234567");
  expect(row!.waMessageId).toBe("wamid.SIGNAL1");
  expect(row!.contactId).toBe(contactId);
  expect(row!.conversationId).toBe(conversationId);
  expect(row!.firstMessageAt).toBe(firstMessageAt);
  expect(row!.landingResult).toBe("pending");
  expect(row!.attempts).toBe(0);
});

test("recordSignal is idempotent: a second call for the same (accountId, identifier) returns null and does not insert a duplicate", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);

  const first = await t.mutation(internal.attribution.recordSignal, {
    accountId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    contactId,
    conversationId,
    firstMessageAt: Date.now(),
  });
  expect(first).not.toBeNull();

  // Same (accountId, identifier), deliberately different phone/wamid —
  // proves the dedupe key is (accountId, identifier) alone, not the
  // rest of the payload.
  const second = await t.mutation(internal.attribution.recordSignal, {
    accountId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15559999999",
    waMessageId: "wamid.SIGNAL2",
    contactId,
    conversationId,
    firstMessageAt: Date.now(),
  });
  expect(second).toBeNull();

  const rows = await t.run((ctx) =>
    ctx.db
      .query("attributionSignals")
      .withIndex("by_account_identifier", (q) =>
        q.eq("accountId", accountId).eq("identifier", "HY-ABCDEF"),
      )
      .collect(),
  );
  expect(rows).toHaveLength(1);
});

test("recordSignal dedupe is per-account: the same identifier under a different accountId inserts its own independent row", async () => {
  const t = convexTest(schema, modules);
  const accountA = await seedAccount(t, "Acme");
  const accountB = await seedAccount(t, "Globex");
  const contactA = await seedContact(t, accountA);
  const contactB = await seedContact(t, accountB);
  const conversationA = await seedConversation(t, accountA, contactA);
  const conversationB = await seedConversation(t, accountB, contactB);

  const idA = await t.mutation(internal.attribution.recordSignal, {
    accountId: accountA,
    identifier: "HY-SHARED",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.A1",
    contactId: contactA,
    conversationId: conversationA,
    firstMessageAt: Date.now(),
  });
  const idB = await t.mutation(internal.attribution.recordSignal, {
    accountId: accountB,
    identifier: "HY-SHARED",
    lane: "code",
    phone: "15557654321",
    waMessageId: "wamid.B1",
    contactId: contactB,
    conversationId: conversationB,
    firstMessageAt: Date.now(),
  });

  expect(idA).not.toBeNull();
  expect(idB).not.toBeNull();
  expect(idA).not.toBe(idB);
});
