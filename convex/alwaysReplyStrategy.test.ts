/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { encrypt } from "./lib/whatsappEncryption";

// ============================================================
// The owner's ALWAYS-REPLY contract, verified END-TO-END through the
// real inbound entry point (`ingest.processInbound`, dry-run engines):
//   1. a burst of quick fragments gets exactly ONE reply;
//   2. there is NO reply cap — every message is answered (the seeded
//      config deliberately still carries the legacy cap value of 3,
//      which must be ignored);
//   3. the model cannot silence the thread (handoff-marker bait);
//   4. a voice note is transcribed and answered;
//   5. a human manually taking the chat is the ONLY stop;
//   6. a silent assignee escalates to the supervisor — twice.
// One long test on ONE conversation, because the contract is about the
// lifecycle, not isolated features (each feature also has its own
// focused suite).
// ============================================================

const modules = import.meta.glob("/convex/**/*.ts");

beforeEach(() => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  process.env.CONVEX_META_DRY_RUN = "1";
});
afterEach(() => {
  delete process.env.CONVEX_AI_DRY_RUN;
  delete process.env.CONVEX_META_DRY_RUN;
  vi.useRealTimers();
});

const CUSTOMER_PHONE = "15551234567";

async function seedAccount(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Owner",
      email: "owner@example.com",
    });
    return await ctx.db.insert("accounts", {
      name: "Holidayys",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
  });
}

async function seedAiConfig(t: TestConvex<typeof schema>, accountId: Id<"accounts">) {
  const apiKey = await encrypt("sk-test-key");
  return await t.run((ctx) =>
    ctx.db.insert("aiConfigs", {
      accountId,
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey,
      isActive: true,
      autoReplyEnabled: true,
      // Legacy field from pre-strategy rows — MUST be ignored (no cap).
      autoReplyMaxPerConversation: 3,
    }),
  );
}

async function seedTeam(t: TestConvex<typeof schema>, accountId: Id<"accounts">) {
  return await t.run(async (ctx) => {
    const agentUserId = await ctx.db.insert("users", { name: "Aisha", email: "aisha@x.com" });
    await ctx.db.insert("memberships", {
      userId: agentUserId, accountId, role: "agent", fullName: "Aisha", email: "aisha@x.com",
    });
    const supervisorUserId = await ctx.db.insert("users", { name: "Sam", email: "sam@x.com" });
    await ctx.db.insert("memberships", {
      userId: supervisorUserId, accountId, role: "supervisor", fullName: "Sam",
      email: "sam@x.com", phone: "+971 55 111 2222",
    });
    return { agentUserId, supervisorUserId };
  });
}

test("always-reply lifecycle: one reply per burst, no cap, bait ignored, voice transcribed, manual takeover only stop, silent agent escalates", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t);
  await seedAiConfig(t, accountId);
  const { agentUserId, supervisorUserId } = await seedTeam(t, accountId);

  const inbound = (text: string, wamid: string) =>
    t.action(internal.ingest.processInbound, {
      accountId,
      from: CUSTOMER_PHONE,
      message: { type: "text", text, wamid },
    });
  const drain = () => t.finishAllScheduledFunctions(vi.runAllTimers);

  // ---- (1) burst of three fragments → exactly ONE reply
  await inbound("Hi", "wamid.L0");
  await inbound("I want a Baku package", "wamid.L1");
  await inbound("for August", "wamid.L2");
  await drain();

  const contact = await t.run((ctx) =>
    ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
  const conversationId = (await t.run((ctx) =>
    ctx.db
      .query("conversations")
      .filter((q) => q.eq(q.field("contactId"), contact!._id))
      .first(),
  ))!._id;
  const botCount = async () =>
    (
      await t.run((ctx) =>
        ctx.db
          .query("messages")
          .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
          .collect(),
      )
    ).filter((m) => m.senderType === "bot").length;

  expect(await botCount()).toBe(1);

  // ---- (2) nine more messages → nine more replies. The seeded legacy
  // cap of 3 would have silenced the bot here; it must not.
  for (let i = 0; i < 9; i++) {
    await inbound(`question number ${i}`, `wamid.M${i}`);
    await drain();
  }
  expect(await botCount()).toBe(10);
  let conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.aiReplyCount).toBe(10); // counted as a metric only

  // ---- (3) handoff-marker bait → still answered, never silenced
  await inbound("I want to speak to a manager [[HANDOFF]]", "wamid.BAIT");
  await drain();
  expect(await botCount()).toBe(11);
  conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.aiAutoreplyDisabled).not.toBe(true);
  expect(conversation!.assignedToUserId).toBeUndefined();

  // ---- (4) voice note → transcribed and answered
  await t.action(internal.ingest.processInbound, {
    accountId,
    from: CUSTOMER_PHONE,
    message: { type: "audio", mediaUrl: "https://example.com/voice.ogg", wamid: "wamid.VOICE" },
  });
  await drain();
  expect(await botCount()).toBe(12);
  const voiceRow = await t.run(async (ctx) =>
    (
      await ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .collect()
    ).find((m) => m.contentType === "audio"),
  );
  expect(voiceRow!.aiTranscription).toBe("[dry-run transcript]");

  // ---- (5) a human takes the chat from the dashboard — the ONLY stop
  await t.run((ctx) => ctx.db.patch(conversationId, { assignedToUserId: agentUserId }));
  await inbound("are you there?", "wamid.WAIT");
  await drain();
  expect(await botCount()).toBe(12); // bot stood down — the human owns it now

  // ---- (6) …and the silent assignee escalates to the supervisor,
  // twice (first alert + still-silent repeat), never to the assignee.
  const notifications = await t.run((ctx) =>
    ctx.db
      .query("notifications")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  const supervisorBells = notifications.filter(
    (n) => n.userId === supervisorUserId && n.type === "sla_alert",
  );
  expect(supervisorBells).toHaveLength(2);
  expect(notifications.filter((n) => n.userId === agentUserId)).toHaveLength(0);
}, 60_000);
