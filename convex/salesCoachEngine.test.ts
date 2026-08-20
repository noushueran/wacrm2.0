/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

const modules = import.meta.glob("/convex/**/*.ts");
type T = ReturnType<typeof convexTest>;

beforeEach(() => vi.stubEnv("CONVEX_AI_DRY_RUN", "1"));
afterEach(() => vi.unstubAllEnvs());

async function seedAccount(t: T) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Owner", email: "o@x.com" }));
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", { name: "A", defaultCurrency: "AED", ownerUserId: userId });
    await ctx.db.insert("memberships", { userId, accountId: id, role: "admin", fullName: "Owner", email: "o@x.com" });
    return id;
  });
  const as = t.withIdentity({ subject: `${userId}|s` });
  await as.mutation(api.aiConfig.upsert, {
    provider: "openai", model: "gpt-5", apiKey: "sk-test", isActive: true, autoReplyEnabled: true,
  });
  return { userId, accountId, as };
}

async function addMember(t: T, accountId: Id<"accounts">, role: AccountRole, name: string) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { name, email: `${name}@x.com` }));
  await t.run((ctx) => ctx.db.insert("memberships", {
    userId, accountId, role, fullName: name, email: `${name}@x.com`,
  }));
  return { userId, as: t.withIdentity({ subject: `${userId}|s` }) };
}

async function enable(t: T, accountId: Id<"accounts">, over: Record<string, number|boolean> = {}) {
  await t.run((ctx) => ctx.db.insert("salesCoachConfigs", {
    accountId, enabled: true, threadsPerRun: 15, minMessages: 4, lookbackDays: 30,
    updatedAt: Date.now(), ...over,
  }));
}

async function thread(
  t: T, accountId: Id<"accounts">,
  opts: { assignedToUserId?: Id<"users">; humanReplied?: boolean; messages?: number },
) {
  const n = opts.messages ?? 6;
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: `+9715${Math.floor(Math.random()*1e8)}`,
      phoneNormalized: `+9715${Math.floor(Math.random()*1e8)}`, name: "Ravi",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0, lastMessageAt: Date.now(),
      ...(opts.assignedToUserId ? { assignedToUserId: opts.assignedToUserId } : {}),
    });
    for (let i = 0; i < n; i++) {
      const isHuman = opts.humanReplied !== false && i % 2 === 1;
      await ctx.db.insert("messages", {
        accountId, conversationId,
        senderType: i % 2 === 0 ? "customer" : isHuman ? "agent" : "bot",
        contentType: "text", contentText: `message ${i}`, status: "delivered",
      });
    }
    return { conversationId, contactId };
  });
}

const notes = (t: T) => t.run((ctx) => ctx.db.query("salesCoachNotes").collect());

test("with no config the sweep writes nothing", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId } = await seedAccount(t);
  await thread(t, accountId, { assignedToUserId: userId });
  await t.action(internal.salesCoachEngine.sweep, {});
  expect(await notes(t)).toHaveLength(0);
});

test("a handled thread gets coached, with the salesperson recorded", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const neha = await addMember(t, accountId, "agent", "Neha");
  await enable(t, accountId);
  await thread(t, accountId, { assignedToUserId: neha.userId });

  await t.action(internal.salesCoachEngine.sweep, {});

  const rows = await notes(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.subjectUserId).toBe(neha.userId);
  expect(rows[0]!.observations.length).toBeGreaterThan(0);
  // Coaching, not a fault list.
  expect(rows[0]!.strengths.length).toBeGreaterThan(0);
});

test("a thread the bot handled alone is never coached", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const neha = await addMember(t, accountId, "agent", "Neha");
  await enable(t, accountId);
  // Assigned, but no human ever typed — blaming Neha for the bot's work
  // is the fastest way to make this tool resented.
  await thread(t, accountId, { assignedToUserId: neha.userId, humanReplied: false });

  await t.action(internal.salesCoachEngine.sweep, {});
  expect(await notes(t)).toHaveLength(0);
});

test("an unassigned thread is never coached", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await thread(t, accountId, {});
  await t.action(internal.salesCoachEngine.sweep, {});
  expect(await notes(t)).toHaveLength(0);
});

test("the same thread is not re-reviewed until it moves on", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const neha = await addMember(t, accountId, "agent", "Neha");
  await enable(t, accountId);
  await thread(t, accountId, { assignedToUserId: neha.userId });

  await t.action(internal.salesCoachEngine.sweep, {});
  await t.action(internal.salesCoachEngine.sweep, {});
  expect(await notes(t)).toHaveLength(1);
});

test("threadsPerRun bounds one sweep", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const neha = await addMember(t, accountId, "agent", "Neha");
  await enable(t, accountId, { threadsPerRun: 2 });
  for (let i = 0; i < 5; i++) await thread(t, accountId, { assignedToUserId: neha.userId });

  await t.action(internal.salesCoachEngine.sweep, {});
  expect(await notes(t)).toHaveLength(2);
});

test("a person reads their OWN coaching and not a colleague's", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const neha = await addMember(t, accountId, "agent", "Neha");
  const sam = await addMember(t, accountId, "agent", "Sam");
  await enable(t, accountId);
  await thread(t, accountId, { assignedToUserId: neha.userId });
  await thread(t, accountId, { assignedToUserId: sam.userId });
  await t.action(internal.salesCoachEngine.sweep, {});

  const mine = await neha.as.query(api.salesCoach.forMe, {});
  expect(mine.notes).toHaveLength(1);
  expect(mine.notes[0]!.subjectUserId).toBe(neha.userId);
});

test("an agent cannot read the team's coaching; a supervisor can", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  const neha = await addMember(t, accountId, "agent", "Neha");
  const boss = await addMember(t, accountId, "supervisor", "Boss");
  await enable(t, accountId);
  await thread(t, accountId, { assignedToUserId: neha.userId });
  await t.action(internal.salesCoachEngine.sweep, {});

  await expect(neha.as.query(api.salesCoach.forTeam, {})).rejects.toMatchObject({
    data: { code: "FORBIDDEN", min: "supervisor" },
  });
  const team = await boss.as.query(api.salesCoach.forTeam, {});
  expect(team.notes).toHaveLength(1);
  // Counts, deliberately not scores or a ranking.
  expect(team.byPerson[0]!.reviews).toBe(1);
});

test("one account's coaching never reaches another", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedAccount(t);
  const theirs = await seedAccount(t);
  const theirAgent = await addMember(t, theirs.accountId, "agent", "Other");
  await enable(t, theirs.accountId);
  await thread(t, theirs.accountId, { assignedToUserId: theirAgent.userId });
  await t.action(internal.salesCoachEngine.sweep, {});

  const team = await mine.as.query(api.salesCoach.forTeam, {});
  expect(team.notes).toHaveLength(0);
});
