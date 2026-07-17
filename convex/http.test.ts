/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test } from "vitest";
import schema from "./schema";
import { groupStatusesByWamid } from "./http";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

// ------------------------------------------------------------
// groupStatusesByWamid — the unit the batch's concurrency safety rests
// on. Tested directly because convex-test runs mutations serially and so
// cannot reproduce the same-row race this grouping exists to prevent (the
// end-to-end tests below pin the outcome, not the mechanism).
// ------------------------------------------------------------

test("groupStatusesByWamid: one group per wamid, arrival order preserved inside a group", () => {
  const groups = groupStatusesByWamid([
    { id: "wamid.A", status: "sent" },
    { id: "wamid.B", status: "sent" },
    { id: "wamid.A", status: "delivered" },
    { id: "wamid.A", status: "read" },
  ]);

  expect(groups).toEqual([
    // Same-wamid statuses must stay together and in order — they are
    // read-modify-writes against one row, up a ladder.
    ["wamid.A", ["sent", "delivered", "read"]],
    // A different wamid shares no row, so it is free to run concurrently.
    ["wamid.B", ["sent"]],
  ]);
});

test("groupStatusesByWamid: drops statuses Meta added that we don't model", () => {
  const groups = groupStatusesByWamid([
    { id: "wamid.A", status: "warp-speed" },
    { id: "wamid.A", status: "sent" },
    { id: "wamid.B", status: "also-nonsense" },
  ]);

  // An unknown status is skipped, and a wamid left with nothing valid
  // produces no group at all (rather than an empty one to iterate).
  expect(groups).toEqual([["wamid.A", ["sent"]]]);
});

// ============================================================
// POST /whatsapp/ingest — the status-update half.
//
// `processChange` applies each `value.statuses[]` entry to two independent
// tables (`messages.updateDeliveryStatusByWamid` +
// `broadcasts.recordRecipientStatusByWamid`) inline, before Meta gets its
// 200. The two are parallelized per status; the batch is NOT parallelized
// across statuses that share a wamid, because both mutations are
// read-modify-write on the same row and `broadcasts.isValidStatusTransition`
// enforces a pending->sent->delivered->read ladder over that read. These
// tests pin the ordering-sensitive outcome that protects.
// ============================================================

const PROXY_SECRET = "test-proxy-secret";
const origProxySecret = process.env.WEBHOOK_PROXY_SECRET;
afterEach(() => {
  if (origProxySecret === undefined) delete process.env.WEBHOOK_PROXY_SECRET;
  else process.env.WEBHOOK_PROXY_SECRET = origProxySecret;
});

async function seedAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Acme",
      email: "acme@example.com",
    });
    const accountId = await ctx.db.insert("accounts", {
      name: "Acme",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    await ctx.db.insert("whatsappConfig", {
      accountId,
      phoneNumberId: "pn-acme",
      accessToken: "tok",
      status: "connected",
    });
    return accountId;
  });
}

/** An outbound broadcast message sitting at the bottom of the status ladder. */
async function seedOutbound(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  wamid: string,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15551230000",
      phoneNormalized: "15551230000",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
    });
    const broadcastId = await ctx.db.insert("broadcasts", {
      accountId,
      name: "B",
      templateName: "t",
      templateLanguage: "en_US",
      status: "sending",
      totalRecipients: 1,
      sentCount: 0,
      deliveredCount: 0,
      readCount: 0,
      repliedCount: 0,
      failedCount: 0,
    });
    const recipientId = await ctx.db.insert("broadcastRecipients", {
      accountId,
      broadcastId,
      contactId,
      status: "pending",
      whatsappMessageId: wamid,
    });
    const messageId = await ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "agent",
      contentType: "template",
      messageId: wamid,
      status: "sending",
    });
    return { recipientId, messageId };
  });
}

function statusBatch(statuses: Array<{ id: string; status: string }>) {
  return {
    method: "POST",
    headers: {
      "x-wacrm-proxy-secret": PROXY_SECRET,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: { metadata: { phone_number_id: "pn-acme" }, statuses },
            },
          ],
        },
      ],
    }),
  };
}

test("a batch of statuses for the SAME wamid stays ordered: the ladder lands on the last one", async () => {
  process.env.WEBHOOK_PROXY_SECRET = PROXY_SECRET;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { recipientId, messageId } = await seedOutbound(t, accountId, "wamid.A");

  // Meta batches a whole ladder for one message into a single webhook.
  // Applied concurrently these race on the same row: each reads "pending",
  // each passes `isValidStatusTransition`, and the last writer wins at random.
  const res = await t.fetch(
    "/whatsapp/ingest",
    statusBatch([
      { id: "wamid.A", status: "sent" },
      { id: "wamid.A", status: "delivered" },
      { id: "wamid.A", status: "read" },
    ]),
  );
  expect(res.status).toBe(200);

  const recipient = await t.run((ctx) => ctx.db.get(recipientId));
  expect(recipient!.status).toBe("read");
  expect(recipient!.sentAt).toBeDefined();
  expect(recipient!.deliveredAt).toBeDefined();
  expect(recipient!.readAt).toBeDefined();
  const message = await t.run((ctx) => ctx.db.get(messageId));
  expect(message!.status).toBe("read");
});

test("a same-wamid regression (read then a late sent) is still refused by the ladder", async () => {
  process.env.WEBHOOK_PROXY_SECRET = PROXY_SECRET;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const { recipientId } = await seedOutbound(t, accountId, "wamid.A");

  await t.fetch(
    "/whatsapp/ingest",
    statusBatch([
      { id: "wamid.A", status: "read" },
      { id: "wamid.A", status: "sent" }, // out-of-order redelivery
    ]),
  );

  const recipient = await t.run((ctx) => ctx.db.get(recipientId));
  expect(recipient!.status).toBe("read");
});

test("statuses for DIFFERENT wamids are all applied", async () => {
  process.env.WEBHOOK_PROXY_SECRET = PROXY_SECRET;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const a = await seedOutbound(t, accountId, "wamid.A");
  const b = await seedOutbound(t, accountId, "wamid.B");
  const c = await seedOutbound(t, accountId, "wamid.C");

  const res = await t.fetch(
    "/whatsapp/ingest",
    statusBatch([
      { id: "wamid.A", status: "sent" },
      { id: "wamid.B", status: "delivered" },
      { id: "wamid.C", status: "failed" },
    ]),
  );
  expect(res.status).toBe(200);

  expect((await t.run((ctx) => ctx.db.get(a.recipientId)))!.status).toBe("sent");
  expect((await t.run((ctx) => ctx.db.get(b.recipientId)))!.status).toBe(
    "delivered",
  );
  expect((await t.run((ctx) => ctx.db.get(c.recipientId)))!.status).toBe(
    "failed",
  );
  // Both tables, every wamid — the messages half is patched independently.
  expect((await t.run((ctx) => ctx.db.get(a.messageId)))!.status).toBe("sent");
  expect((await t.run((ctx) => ctx.db.get(b.messageId)))!.status).toBe(
    "delivered",
  );
  expect((await t.run((ctx) => ctx.db.get(c.messageId)))!.status).toBe(
    "failed",
  );
});

test("an unrecognized status is skipped without derailing the rest of the batch", async () => {
  process.env.WEBHOOK_PROXY_SECRET = PROXY_SECRET;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  const a = await seedOutbound(t, accountId, "wamid.A");

  const res = await t.fetch(
    "/whatsapp/ingest",
    statusBatch([
      { id: "wamid.A", status: "warp-speed" },
      { id: "wamid.A", status: "sent" },
    ]),
  );
  expect(res.status).toBe(200);
  expect((await t.run((ctx) => ctx.db.get(a.recipientId)))!.status).toBe("sent");
});

test("POST /whatsapp/ingest without the proxy secret is rejected", async () => {
  process.env.WEBHOOK_PROXY_SECRET = PROXY_SECRET;
  const t = convexTest(schema, modules);
  const res = await t.fetch("/whatsapp/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ entry: [] }),
  });
  expect(res.status).toBe(401);
});
