/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { triggerMatches } from "./automationsEngine";
import type { Id } from "./_generated/dataModel";

// Convex function modules for convex-test to resolve `internal.*`
// references against. Absolute, from-project-root pattern (matches
// every other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

// Every test in this suite exercises `internalAction`/`internalMutation`/
// `internalQuery` entry points with an explicit, caller-supplied
// `accountId` — there is no user session inside a trigger fired from a
// webhook or a scheduled resume, so (unlike `contacts.test.ts` etc.)
// none of the seed helpers below create a `memberships` row, matching
// `ingest.test.ts`/`webhookDelivery.test.ts`'s own established pattern
// for this exact class of engine test.

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

async function seedContactAndConversation(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  phone: string,
) {
  return await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone,
      phoneNormalized: phone,
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
    });
    return { contactId, conversationId };
  });
}

async function seedTag(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">, name: string) {
  return await t.run((ctx) => ctx.db.insert("tags", { accountId, name, color: "#000000" }));
}

async function seedAutomation(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    triggerType: string;
    triggerConfig?: unknown;
    isActive?: boolean;
    name?: string;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("automations", {
      accountId: opts.accountId,
      name: opts.name ?? "Test automation",
      triggerType: opts.triggerType,
      triggerConfig: opts.triggerConfig,
      isActive: opts.isActive ?? true,
      executionCount: 0,
    }),
  );
}

async function seedStep(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    automationId: Id<"automations">;
    parentStepId?: Id<"automationSteps">;
    branch?: "yes" | "no";
    stepType:
      | "send_message"
      | "send_buttons"
      | "send_list"
      | "send_template"
      | "add_tag"
      | "remove_tag"
      | "assign_conversation"
      | "update_contact_field"
      | "create_deal"
      | "wait"
      | "condition"
      | "send_webhook"
      | "close_conversation";
    stepConfig?: unknown;
    position: number;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("automationSteps", {
      accountId: opts.accountId,
      automationId: opts.automationId,
      parentStepId: opts.parentStepId,
      branch: opts.branch,
      stepType: opts.stepType,
      stepConfig: opts.stepConfig,
      position: opts.position,
    }),
  );
}

/**
 * Scans (not `.withIndex`) — a helper function parameter typed as the
 * bare `ReturnType<typeof convexTest>` (no schema type argument) loses
 * this suite's concrete index names, so a `.withIndex("by_contact_tag",
 * ...)` call inside a helper can't resolve; a `.filter()` scan needs no
 * declared index name and works fine at this suite's tiny scale.
 * Mirrors `convex/deals.test.ts`'s own documented workaround for the
 * same gotcha.
 */
async function tagLink(
  t: ReturnType<typeof convexTest>,
  contactId: Id<"contacts">,
  tagId: Id<"tags">,
) {
  return await t.run((ctx) =>
    ctx.db
      .query("contactTags")
      .filter((q) => q.and(q.eq(q.field("contactId"), contactId), q.eq(q.field("tagId"), tagId)))
      .first(),
  );
}

afterEach(() => {
  // Belt-and-suspenders: any test that opts into fake timers restores
  // real ones itself, but a thrown assertion could skip that cleanup —
  // guard every other test in this file from inheriting fake timers.
  vi.useRealTimers();
  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// triggerMatches — pure function, unit-tested directly (mirrors
// `engine.test.ts`'s own dedicated describe block).
// ============================================================

test("triggerMatches: keyword_match respects contains vs. exact and case sensitivity", () => {
  const contains = { triggerType: "keyword_match", triggerConfig: { keywords: ["order"], match_type: "contains" as const } };
  expect(triggerMatches(contains, { messageText: "Where is my order?" })).toBe(true);
  expect(triggerMatches(contains, { messageText: "nothing relevant" })).toBe(false);

  const exact = { triggerType: "keyword_match", triggerConfig: { keywords: ["hi"], match_type: "exact" as const } };
  expect(triggerMatches(exact, { messageText: "hi" })).toBe(true);
  expect(triggerMatches(exact, { messageText: "hi there" })).toBe(false);

  const caseSensitive = {
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["HELP"], match_type: "contains" as const, case_sensitive: true },
  };
  expect(triggerMatches(caseSensitive, { messageText: "I need HELP" })).toBe(true);
  expect(triggerMatches(caseSensitive, { messageText: "I need help" })).toBe(false);
});

test("triggerMatches: keyword_match with no keywords or no message text never matches", () => {
  const cfg = { triggerType: "keyword_match", triggerConfig: { keywords: [], match_type: "contains" as const } };
  expect(triggerMatches(cfg, { messageText: "anything" })).toBe(false);
  const withKeywords = { triggerType: "keyword_match", triggerConfig: { keywords: ["hi"], match_type: "contains" as const } };
  expect(triggerMatches(withKeywords, {})).toBe(false);
});

test("triggerMatches: interactive_reply matches only an exact reply id", () => {
  const automation = { triggerType: "interactive_reply", triggerConfig: { reply_ids: ["yes", "no"] } };
  expect(triggerMatches(automation, { interactiveReplyId: "yes" })).toBe(true);
  expect(triggerMatches(automation, { interactiveReplyId: "yes_please" })).toBe(false);
  expect(triggerMatches(automation, { interactiveReplyId: "maybe" })).toBe(false);
  expect(triggerMatches(automation, {})).toBe(false);
});

test("triggerMatches: any other trigger type always matches (no context-based filter)", () => {
  expect(triggerMatches({ triggerType: "new_message_received", triggerConfig: {} }, undefined)).toBe(true);
  expect(triggerMatches({ triggerType: "first_inbound_message", triggerConfig: {} }, {})).toBe(true);
});

// ============================================================
// 1. keyword_match trigger -> add_tag step tags the contact
// ============================================================

test("a keyword_match automation's add_tag step tags the contact and finalizes the log as success", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { contactId } = await seedContactAndConversation(t, accountId, "15551234567");
  const tagId = await seedTag(t, accountId, "vip");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hello"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "add_tag",
    stepConfig: { tag_id: tagId },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hello there" },
  });

  expect(await tagLink(t, contactId, tagId)).not.toBeNull();

  const automation = await t.run((ctx) => ctx.db.get(automationId));
  expect(automation!.executionCount).toBe(1);
  expect(automation!.lastExecutedAt).toBeDefined();

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.status).toBe("success");
  expect(logs[0]!.contactId).toBe(contactId);
  expect(logs[0]!.stepsExecuted).toHaveLength(1);
});

test("a non-matching keyword never applies the tag", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { contactId } = await seedContactAndConversation(t, accountId, "15551234567");
  const tagId = await seedTag(t, accountId, "vip");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hello"], match_type: "contains" },
  });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: tagId }, position: 0 });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "goodbye" },
  });

  expect(await tagLink(t, contactId, tagId)).toBeNull();
  const automation = await t.run((ctx) => ctx.db.get(automationId));
  expect(automation!.executionCount).toBe(0);
});

// ============================================================
// 2. wait step schedules a resume via ctx.scheduler; the post-wait
//    step runs once finishAllScheduledFunctions drains it.
// ============================================================

test("a wait step schedules a resume; the post-wait step runs after finishAllScheduledFunctions", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { contactId } = await seedContactAndConversation(t, accountId, "15551234567");
  const tagId = await seedTag(t, accountId, "reminded");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
  });
  await seedStep(t, { accountId, automationId, stepType: "wait", stepConfig: { amount: 1, unit: "minutes" }, position: 0 });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: tagId }, position: 1 });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "remind me later" },
  });

  // Suspended: the post-wait step hasn't run yet, and the log reports
  // 'partial' — the execution counter, however, already bumped once
  // (matches the original: the counter tracks "was triggered", not
  // "fully completed").
  expect(await tagLink(t, contactId, tagId)).toBeNull();
  let logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.status).toBe("partial");
  let automation = await t.run((ctx) => ctx.db.get(automationId));
  expect(automation!.executionCount).toBe(1);

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await tagLink(t, contactId, tagId)).not.toBeNull();
  logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.status).toBe("success");
  expect(logs[0]!.stepsExecuted).toHaveLength(2);

  // Resuming must NOT bump the counter a second time.
  automation = await t.run((ctx) => ctx.db.get(automationId));
  expect(automation!.executionCount).toBe(1);

  vi.useRealTimers();
});

// ============================================================
// 3. condition step branches to the correct child
// ============================================================

test("a tag_presence condition branches yes/no to the correct child steps", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const vipTagId = await seedTag(t, accountId, "vip");
  const yesTagId = await seedTag(t, accountId, "vip-welcome");
  const noTagId = await seedTag(t, accountId, "standard-welcome");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  const conditionStepId = await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "tag_presence", operand: vipTagId },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    parentStepId: conditionStepId,
    branch: "yes",
    stepType: "add_tag",
    stepConfig: { tag_id: yesTagId },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    parentStepId: conditionStepId,
    branch: "no",
    stepType: "add_tag",
    stepConfig: { tag_id: noTagId },
    position: 0,
  });

  // No vip tag -> "no" branch.
  const { contactId: plainContactId } = await seedContactAndConversation(t, accountId, "15550000001");
  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId: plainContactId,
    context: { messageText: "hi" },
  });
  expect(await tagLink(t, plainContactId, yesTagId)).toBeNull();
  expect(await tagLink(t, plainContactId, noTagId)).not.toBeNull();

  // Has the vip tag -> "yes" branch.
  const { contactId: vipContactId } = await seedContactAndConversation(t, accountId, "15550000002");
  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId: vipContactId, tagId: vipTagId }));
  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId: vipContactId,
    context: { messageText: "hi" },
  });
  expect(await tagLink(t, vipContactId, yesTagId)).not.toBeNull();
  expect(await tagLink(t, vipContactId, noTagId)).toBeNull();
});

// ============================================================
// 4. send_message persists a "bot" message (DRY-RUN)
// ============================================================

test("a send_message step persists a bot message in DRY-RUN, without calling Meta", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { text: "Thanks for reaching out!" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi", conversationId },
  });

  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.accountId).toBe(accountId);
  expect(messages[0]!.senderType).toBe("bot");
  expect(messages[0]!.contentType).toBe("text");
  expect(messages[0]!.contentText).toBe("Thanks for reaching out!");
  expect(messages[0]!.messageId).toMatch(/^dry-run-[0-9a-f]{16}$/);

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.lastMessageText).toBe("Thanks for reaching out!");
});

test("send_message interpolates {{ message.text }} and {{ vars.* }} from the trigger context", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { text: "You said: {{ message.text }} (source={{ vars.source }})" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi there", conversationId, vars: { source: "WhatsApp Ad" } },
  });

  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages[0]!.contentText).toBe("You said: hi there (source=WhatsApp Ad)");
});

// ============================================================
// 5. Account isolation
// ============================================================

test("runForTrigger for account A never runs account B's automations", async () => {
  const t = convexTest(schema, modules);
  const accountA = await seedAccount(t, "Acme");
  const accountB = await seedAccount(t, "Globex");
  const { contactId: contactA } = await seedContactAndConversation(t, accountA, "15550000001");
  const tagB = await seedTag(t, accountB, "should-never-apply");

  // Same trigger type + matching keyword, but lives entirely in B.
  const automationB = await seedAutomation(t, {
    accountId: accountB,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, { accountId: accountB, automationId: automationB, stepType: "add_tag", stepConfig: { tag_id: tagB }, position: 0 });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId: accountA,
    triggerType: "keyword_match",
    contactId: contactA,
    context: { messageText: "hi" },
  });

  const logsB = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountB)).collect(),
  );
  expect(logsB).toHaveLength(0);
  const automationBDoc = await t.run((ctx) => ctx.db.get(automationB));
  expect(automationBDoc!.executionCount).toBe(0);
});

test("refuses to dispatch when contactId belongs to a different account (tenant-isolation guard)", async () => {
  const t = convexTest(schema, modules);
  const accountA = await seedAccount(t, "Acme");
  const accountB = await seedAccount(t, "Globex");
  const { contactId: victimContactId } = await seedContactAndConversation(t, accountB, "15550000009");
  const tagA = await seedTag(t, accountA, "pwned");

  const automationA = await seedAutomation(t, {
    accountId: accountA,
    triggerType: "new_message_received",
    triggerConfig: {},
  });
  await seedStep(t, { accountId: accountA, automationId: automationA, stepType: "add_tag", stepConfig: { tag_id: tagA }, position: 0 });

  // accountA + a contactId that actually belongs to accountB.
  await t.action(internal.automationsEngine.runForTrigger, {
    accountId: accountA,
    triggerType: "new_message_received",
    contactId: victimContactId,
    context: {},
  });

  // Bailed at the guard: no log was ever created, and the victim's
  // contact was never tagged.
  const logsA = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountA)).collect(),
  );
  expect(logsA).toHaveLength(0);
  const links = await t.run((ctx) =>
    ctx.db.query("contactTags").withIndex("by_contact", (q) => q.eq("contactId", victimContactId)).collect(),
  );
  expect(links).toHaveLength(0);
  const automationADoc = await t.run((ctx) => ctx.db.get(automationA));
  expect(automationADoc!.executionCount).toBe(0);
});

// ============================================================
// Bonus: security-regression parity with engine.test.ts's own named
// GHSA cases, since this port reuses the exact guarded code paths.
// ============================================================

test("send_webhook refuses a private/link-local destination and never calls fetch (GHSA-8jqh-598v-rfxc parity)", async () => {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
  vi.stubGlobal("fetch", fetchSpy);

  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { contactId } = await seedContactAndConversation(t, accountId, "15551234567");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_webhook",
    stepConfig: {
      url: "http://169.254.169.254/latest/meta-data/",
      headers: { "Metadata-Flavor": "Google" },
      body_template: "{}",
    },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  expect(fetchSpy).not.toHaveBeenCalled();
  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  // The automation matched and the step genuinely ran (reached the
  // send_webhook case) — it just failed there, recorded as such.
  expect(logs[0]!.status).toBe("failed");
  expect(logs[0]!.errorMessage).toMatch(/destination not allowed/);

  vi.unstubAllGlobals();
});

test("update_contact_field refuses to write a custom field owned by a different account", async () => {
  const t = convexTest(schema, modules);
  const accountA = await seedAccount(t, "Acme");
  const accountB = await seedAccount(t, "Globex");
  const { contactId } = await seedContactAndConversation(t, accountA, "15550000001");
  const foreignFieldId = await t.run((ctx) =>
    ctx.db.insert("customFields", { accountId: accountB, fieldName: "Secret", fieldType: "text" }),
  );

  const automationId = await seedAutomation(t, {
    accountId: accountA,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId: accountA,
    automationId,
    stepType: "update_contact_field",
    stepConfig: { field: `custom:${foreignFieldId}`, value: "leaked" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId: accountA,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  const values = await t.run((ctx) =>
    ctx.db.query("contactCustomValues").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect(),
  );
  expect(values).toHaveLength(0);
});
