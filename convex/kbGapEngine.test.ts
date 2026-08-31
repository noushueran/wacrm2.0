/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");
type T = ReturnType<typeof convexTest>;

beforeEach(() => vi.stubEnv("CONVEX_AI_DRY_RUN", "1"));
afterEach(() => vi.unstubAllEnvs());

async function seedAccount(t: T) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Owner", email: "o@x.com" }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "A", defaultCurrency: "AED", ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId, accountId: id, role: "admin", fullName: "Owner", email: "o@x.com",
    });
    return id;
  });
  const as = t.withIdentity({ subject: `${userId}|s` });
  await as.mutation(api.aiConfig.upsert, {
    provider: "openai", model: "gpt-5", apiKey: "sk-test",
    isActive: true, autoReplyEnabled: true,
  });
  return { userId, accountId, as };
}

async function enable(t: T, accountId: Id<"accounts">, over: Record<string, number|boolean> = {}) {
  await t.run((ctx) => ctx.db.insert("kbGapConfigs", {
    accountId, enabled: true, entriesPerRun: 10, minAnswerChars: 20,
    updatedAt: Date.now(), ...over,
  }));
}

async function inquiry(
  t: T, accountId: Id<"accounts">,
  opts: { question: string; answer?: string; status: "pending"|"answered"|"delivered" },
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId, phone: `+9715${Math.floor(Math.random()*1e8)}`,
      phoneNormalized: `+9715${Math.floor(Math.random()*1e8)}`, name: "Ravi",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", unreadCount: 0,
    });
    return await ctx.db.insert("adminInquiries", {
      accountId, conversationId, contactId,
      question: opts.question,
      customerName: "Ravi", customerPhone: "+971500000000",
      status: opts.status,
      ...(opts.answer ? { answer: opts.answer } : {}),
      askedAt: Date.now(),
    });
  });
}

const entries = (t: T) => t.run((ctx) => ctx.db.query("kbEntries").collect());
const processed = (t: T) => t.run((ctx) => ctx.db.query("kbGapProcessed").collect());
const themes = (t: T) => t.run((ctx) => ctx.db.query("kbGapThemes").collect());

test("with no config the sweep writes nothing", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await inquiry(t, accountId, { question: "Q?", answer: "A real answer about visas", status: "answered" });

  await t.action(internal.kbGapEngine.sweep, {});
  expect(await entries(t)).toHaveLength(0);
  expect(await processed(t)).toHaveLength(0);
});

test("an answered inquiry becomes a knowledge-base DRAFT, never published", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await inquiry(t, accountId, {
    question: "Can a freelance visa change to an employment visa?",
    answer: "Yes , freelance visa can change to employment visa later",
    status: "answered",
  });

  await t.action(internal.kbGapEngine.sweep, {});

  const rows = await entries(t);
  expect(rows).toHaveLength(1);
  // Publishing stays a human act.
  expect(rows[0]!.status).toBe("draft");
  expect(rows[0]!.audience).toBe("customer");
  expect(rows[0]!.accountId).toBe(accountId);
  expect((await processed(t))[0]!.outcome).toBe("drafted");
});

test("a bare acknowledgement is skipped without spending a provider call", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  // "Okay" is a real stored answer in production.
  await inquiry(t, accountId, { question: "Do we cover Abu Dhabi?", answer: "Okay", status: "answered" });

  await t.action(internal.kbGapEngine.sweep, {});

  expect(await entries(t)).toHaveLength(0);
  const p = await processed(t);
  expect(p[0]!.outcome).toBe("skipped_thin_answer");
  expect(p[0]!.reason).toBeTruthy();
});

test("the same inquiry is never drafted twice", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await inquiry(t, accountId, {
    question: "Can a freelance visa change later?",
    answer: "Yes , freelance visa can change to employment visa later",
    status: "answered",
  });

  await t.action(internal.kbGapEngine.sweep, {});
  await t.action(internal.kbGapEngine.sweep, {});

  expect(await entries(t)).toHaveLength(1);
  expect(await processed(t)).toHaveLength(1);
});

test("unanswered questions become themes, and no entry is invented for them", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  await inquiry(t, accountId, { question: "What are the Schengen requirements?", status: "pending" });

  await t.action(internal.kbGapEngine.sweep, {});

  const th = await themes(t);
  expect(th).toHaveLength(1);
  expect(th[0]!.questionCount).toBe(1);
  // Verbatim, so a reader can judge the theme rather than trust the label.
  expect(th[0]!.examples[0]).toContain("Schengen");
  // Nobody answered it, so nothing may be written into the KB.
  expect(await entries(t)).toHaveLength(0);
});

test("themes are replaced wholesale, so a closed gap stops being reported", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId);
  const id = await inquiry(t, accountId, { question: "Old question?", status: "pending" });

  await t.action(internal.kbGapEngine.sweep, {});
  expect(await themes(t)).toHaveLength(1);

  // The question gets answered; the theme must not linger.
  await t.run((ctx) => ctx.db.patch(id, { status: "answered", answer: "A proper answer about visas" }));
  await t.action(internal.kbGapEngine.sweep, {});
  expect(await themes(t)).toHaveLength(0);
});

test("entriesPerRun bounds one sweep", async () => {
  const t = convexTest(schema, modules);
  const { accountId } = await seedAccount(t);
  await enable(t, accountId, { entriesPerRun: 2 });
  for (let i = 0; i < 5; i++) {
    await inquiry(t, accountId, {
      question: `Question ${i}?`,
      answer: "A perfectly good answer about visa processing times",
      status: "answered",
    });
  }

  await t.action(internal.kbGapEngine.sweep, {});
  expect(await entries(t)).toHaveLength(2);
});

test("one account's inquiries never reach another's knowledge base", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedAccount(t);
  const theirs = await seedAccount(t);
  await enable(t, mine.accountId);
  await inquiry(t, theirs.accountId, {
    question: "Their question?", answer: "Their perfectly good answer here", status: "answered",
  });

  await t.action(internal.kbGapEngine.sweep, {});
  expect(await entries(t)).toHaveLength(0);
});
