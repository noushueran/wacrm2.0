/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("/convex/**/*.ts");

test("backfill derives awaitingReply from the newest message, and is idempotent", async () => {
  const t = convexTest(schema, modules);

  const { inbound, outbound, silent } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "test@example.com",
      name: "Test User",
    });
    const accountId = await ctx.db.insert("accounts", {
      name: "acct", defaultCurrency: "AED", ownerUserId: userId,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000000", phoneNormalized: "971500000000",
    });
    const mk = async () =>
      await ctx.db.insert("conversations", {
        accountId, contactId, status: "open", unreadCount: 0,
      });
    const inbound = await mk();
    const outbound = await mk();
    const silent = await mk();
    const msg = async (conversationId: typeof inbound, senderType: "customer" | "agent") =>
      await ctx.db.insert("messages", {
        accountId, conversationId, senderType,
        contentType: "text", contentText: "x", status: "sent",
      });
    await msg(inbound, "customer");
    await msg(outbound, "customer");
    await msg(outbound, "agent"); // newest is ours
    return { inbound, outbound, silent };
  });

  const run = async () =>
    await t.mutation(internal.inboxBackfill.backfillAwaitingReply, { batchSize: 100 });
  const read = async (id: typeof inbound) =>
    (await t.run((ctx) => ctx.db.get(id)))!.awaitingReply;

  const first = await run();
  expect(first.isDone).toBe(true);
  expect(await read(inbound)).toBe(true);
  expect(await read(outbound)).toBe(false);
  // No messages at all: we owe the first one, so Active.
  expect(await read(silent)).toBe(true);

  const second = await run();
  expect(second.patched).toBe(0);
  expect(await read(inbound)).toBe(true);
});

test("the cursor traverses every page, leaving no conversation unset", async () => {
  // Final review, Finding 8. This module runs ONCE, against production,
  // and `undefined` is not a lane — a cursor that stalled or restarted
  // would leave rows invisible in every Inbox tab, and the operator would
  // see only `isDone: false` forever. Cheap insurance for a one-shot
  // migration.
  const t = convexTest(schema, modules);
  const TOTAL = 25;
  const BATCH = 4; // 25 / 4 -> 7 pages, so the cursor is genuinely driven

  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      email: "pages@example.com",
      name: "Pages",
    });
    const accountId = await ctx.db.insert("accounts", {
      name: "acct", defaultCurrency: "AED", ownerUserId: userId,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: "+971500000001", phoneNormalized: "971500000001",
    });
    const created = [];
    for (let i = 0; i < TOTAL; i++) {
      const conversationId = await ctx.db.insert("conversations", {
        accountId, contactId, status: "open", unreadCount: 0,
      });
      // Alternate the direction of the newest message so the assertion
      // proves the value was DERIVED per row, not blanket-written: every
      // third row has no message at all (-> true), and the rest end on a
      // customer (-> true) or on us (-> false).
      if (i % 3 !== 0) {
        await ctx.db.insert("messages", {
          accountId, conversationId,
          senderType: i % 3 === 1 ? "customer" : "agent",
          contentType: "text", contentText: "x", status: "sent",
        });
      }
      created.push(conversationId);
    }
    return created;
  });

  let cursor: string | null = null;
  let isDone = false;
  let pages = 0;
  let totalPatched = 0;
  while (!isDone) {
    const result: { cursor: string; isDone: boolean; patched: number } =
      await t.mutation(internal.inboxBackfill.backfillAwaitingReply, {
        cursor, batchSize: BATCH,
      });
    cursor = result.cursor;
    isDone = result.isDone;
    totalPatched += result.patched;
    pages++;
    expect(pages).toBeLessThan(20); // a stalled cursor fails here, not by hanging
  }

  expect(pages).toBeGreaterThan(1); // it really was multi-page
  // Every seeded row starts with `awaitingReply` ABSENT, and `undefined`
  // never equals a boolean, so all 25 are written exactly once — nothing
  // was skipped by a page boundary.
  expect(totalPatched).toBe(TOTAL);

  const values = await t.run(async (ctx) =>
    Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.awaitingReply)),
  );
  expect(values.filter((v) => v === undefined)).toEqual([]);
  for (const [i, value] of values.entries()) {
    expect(value).toBe(i % 3 === 2 ? false : true);
  }

  // A full second traversal patches nothing — idempotent across pages,
  // not just within one.
  cursor = null;
  isDone = false;
  let secondPassPatched = 0;
  while (!isDone) {
    const result: { cursor: string; isDone: boolean; patched: number } =
      await t.mutation(internal.inboxBackfill.backfillAwaitingReply, {
        cursor, batchSize: BATCH,
      });
    cursor = result.cursor;
    isDone = result.isDone;
    secondPassPatched += result.patched;
  }
  expect(secondPassPatched).toBe(0);
});
