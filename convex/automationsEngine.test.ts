/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { triggerMatches, RUN_CANCEL_BATCH } from "./automationsEngine";
import type { Id } from "./_generated/dataModel";
import { encrypt } from "./lib/whatsappEncryption";

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

/**
 * Flags a contact do-not-contact the same way the real feature does —
 * `contacts.doNotContact` is a denormalized `{ at, noteId }` object
 * (schema.ts), not a bare boolean, sourced from a `contactNotes` row
 * whose `outcome` is `"do_not_contact"`. Mirrors `broadcasts.test.ts`'s
 * own inline pattern for the identical setup.
 */
async function markDoNotContact(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  contactId: Id<"contacts">,
) {
  await t.run(async (ctx) => {
    const noteId = await ctx.db.insert("contactNotes", {
      accountId,
      contactId,
      noteText: "Asked us to stop",
      kind: "call",
      outcome: "do_not_contact",
    });
    await ctx.db.patch(contactId, { doNotContact: { at: Date.now(), noteId } });
  });
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
  // Open 24h window (send composer Task 5): this test is about the
  // DRY-RUN persistence path, not window state.
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

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
  // Open 24h window (send composer Task 5): this test is about
  // interpolation, not window state.
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

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

// ============================================================
// 6. assign_conversation step charges the assigned agent when the
//    account has a lead value set (lead-value fix wave, Task 2b) —
//    `runDbStep`'s `assign_conversation` case calls the same
//    `chargeLeadIfAgent` helper `conversations.assign` and
//    `conversations.setAutoreplyPaused` already use, right after its
//    own `assignedToUserId` patch. No membership row is seeded by
//    this suite's own helpers (see header comment), so the assigned
//    agent's membership is inserted inline here — it's what makes
//    `chargeLeadIfAgent`'s agents-only check pass.
// ============================================================

test("assign_conversation step writes a leadCharges row for the assigned agent", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await t.run((ctx) => ctx.db.patch(accountId, { leadValue: 5 }));
  const agentId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "Agent", email: "agent@example.com" });
    await ctx.db.insert("memberships", {
      userId,
      accountId,
      role: "agent",
      fullName: "Agent",
      email: "agent@example.com",
    });
    return userId;
  });
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15559990000");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["assign"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "assign_conversation",
    stepConfig: { mode: "specific", agent_id: agentId },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "please assign this" },
  });

  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.assignedToUserId).toBe(agentId);

  const charges = await t.run((ctx) =>
    ctx.db
      .query("leadCharges")
      .withIndex("by_user_conversation", (q) =>
        q.eq("userId", agentId).eq("conversationId", conversationId),
      )
      .collect(),
  );
  expect(charges).toHaveLength(1);
  expect(charges[0]).toMatchObject({ accountId, value: 5, currency: "USD" });
});

// The `"automation"` source literal and the deliberate
// `bumpUpdatedAt: false` are invisible to every other assertion in this
// suite. A swapped literal writes a permanently wrong audit row; a
// dropped flag silently re-sorts the Inbox on every automation run.
test("assign_conversation records an `automation` event and leaves updatedAt alone", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const agentId = await t.run((ctx) =>
    ctx.db.insert("users", { name: "Agent", email: "agent-event@example.com" }),
  );
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15559990001");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["assign"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "assign_conversation",
    stepConfig: { mode: "specific", agent_id: agentId },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "please assign this" },
  });

  const events = await t.run((ctx) =>
    ctx.db
      .query("conversationEvents")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    kind: "assigned",
    source: "automation",
    targetUserId: agentId,
  });

  // The legacy path this step ports updated by (account_id, contact_id)
  // with no status/updatedAt bump, and `seedContactAndConversation`
  // never writes the field — so still absent is the whole assertion.
  const conversation = await t.run((ctx) => ctx.db.get(conversationId));
  expect(conversation!.assignedToUserId).toBe(agentId);
  expect(conversation!.updatedAt).toBeUndefined();
});

// ------------------------------------------------------------
// hasActiveAutoResponder — backs convex/ingest.ts's AI "stand down"
// precedence (Phase 8, Task 4b). Direct, focused coverage of the
// query's own isActive + triggerType filtering, independent of the
// full processInbound fan-out (which exercises it indirectly in
// convex/ingest.test.ts).
// ------------------------------------------------------------

test("hasActiveAutoResponder: false with no automations at all", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  expect(
    await t.query(internal.automationsEngine.hasActiveAutoResponder, { accountId }),
  ).toBe(false);
});

test("hasActiveAutoResponder: true when an active new_message_received automation exists", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAutomation(t, { accountId, triggerType: "new_message_received" });

  expect(
    await t.query(internal.automationsEngine.hasActiveAutoResponder, { accountId }),
  ).toBe(true);
});

test("hasActiveAutoResponder: true when an active keyword_match automation exists", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["help"], match_type: "contains" },
  });

  expect(
    await t.query(internal.automationsEngine.hasActiveAutoResponder, { accountId }),
  ).toBe(true);
});

test("hasActiveAutoResponder: false when the only matching-triggerType automation is inactive", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAutomation(t, {
    accountId,
    triggerType: "new_message_received",
    isActive: false,
  });

  expect(
    await t.query(internal.automationsEngine.hasActiveAutoResponder, { accountId }),
  ).toBe(false);
});

test("hasActiveAutoResponder: false for an active automation whose trigger isn't a per-message auto-responder", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAutomation(t, { accountId, triggerType: "new_contact_created" });
  await seedAutomation(t, { accountId, triggerType: "first_inbound_message" });

  expect(
    await t.query(internal.automationsEngine.hasActiveAutoResponder, { accountId }),
  ).toBe(false);
});

test("hasActiveAutoResponder: scoped to the account — another account's active auto-responder doesn't leak in", async () => {
  const t = convexTest(schema, modules);
  const accountA = await seedAccount(t, "Acme");
  const accountB = await seedAccount(t, "Globex");
  await seedAutomation(t, { accountId: accountB, triggerType: "new_message_received" });

  expect(
    await t.query(internal.automationsEngine.hasActiveAutoResponder, { accountId: accountA }),
  ).toBe(false);
  expect(
    await t.query(internal.automationsEngine.hasActiveAutoResponder, { accountId: accountB }),
  ).toBe(true);
});

// ============================================================
// do-not-contact gate (final review, CRITICAL 1) — runForTrigger and
// resume must both refuse to execute a single step for a contact
// flagged `doNotContact`, independently: `resume` fires after a `wait`
// step's own delay, which is exactly the window in which an agent can
// flag a contact AFTER the initial dispatch already checked and passed.
// ============================================================

test("runForTrigger records a blocked run and never executes a step for a doNotContact contact; a non-blocked contact still runs", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { text: "Hello!" },
    position: 0,
  });

  const { contactId: blockedContactId, conversationId: blockedConversationId } = await seedContactAndConversation(
    t,
    accountId,
    "15550001111",
  );
  await markDoNotContact(t, accountId, blockedContactId);

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId: blockedContactId,
    context: { messageText: "hi", conversationId: blockedConversationId },
  });

  const blockedMessages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", blockedConversationId))
      .collect(),
  );
  expect(blockedMessages).toHaveLength(0);

  const blockedLogs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(blockedLogs).toHaveLength(1);
  expect(blockedLogs[0]!.status).toBe("failed");
  expect(blockedLogs[0]!.errorMessage).toMatch(/do_not_contact/);
  expect(blockedLogs[0]!.stepsExecuted).toHaveLength(0);

  const automationAfterBlocked = await t.run((ctx) => ctx.db.get(automationId));
  expect(automationAfterBlocked!.executionCount).toBe(0);

  // Non-blocked contact — the same automation still fires normally.
  const { contactId: okContactId, conversationId: okConversationId } = await seedContactAndConversation(
    t,
    accountId,
    "15550002222",
  );
  // Open 24h window (send composer Task 5): this test is about the
  // do-not-contact gate, not window state.
  await t.run((ctx) => ctx.db.patch(okConversationId, { lastInboundAt: Date.now() }));
  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId: okContactId,
    context: { messageText: "hi", conversationId: okConversationId },
  });

  const okMessages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", okConversationId)).collect(),
  );
  expect(okMessages).toHaveLength(1);
  const automationAfterOk = await t.run((ctx) => ctx.db.get(automationId));
  expect(automationAfterOk!.executionCount).toBe(1);
});

test("resume refuses to execute a post-wait step when the contact was flagged doNotContact during the wait window", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15550003333");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
  });
  await seedStep(t, { accountId, automationId, stepType: "wait", stepConfig: { amount: 1, unit: "minutes" }, position: 0 });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { text: "Following up!" },
    position: 1,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "remind me later", conversationId },
  });

  expect(
    await t.run((ctx) =>
      ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
    ),
  ).toHaveLength(0);

  // An agent flags this contact do-not-contact WHILE the wait step is
  // still pending — the delayed-send window `runForTrigger`'s own gate
  // (checked before the wait even started) cannot cover.
  await markDoNotContact(t, accountId, contactId);

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // The post-wait send_message step never ran.
  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages).toHaveLength(0);

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.status).toBe("failed");
  expect(logs[0]!.errorMessage).toMatch(/do_not_contact/);

  vi.useRealTimers();
});

// Fix wave (2026-08): `resume` only ever checked `!automation` (deleted),
// never `!automation.isActive` (deactivated) — so deactivation was a
// one-shot sweep (`cancelRunsForAutomation`, scheduled by `setActive`/
// `update`) rather than an invariant `resume` itself enforces. The
// uncovered window is `createRun` -> the first `markRunWaiting`: a run
// enrolled just before deactivation and still mid-flight on its very
// first step reads `status: "running"`, `outstandingBranches: 0` at
// that instant — exactly what `cancelRunsForAutomation`'s own two-clause
// query deliberately excludes (see that mutation's comment). This test
// skips the sweep entirely (a direct `isActive` patch, no
// `cancelRunsForAutomation` call at all) to isolate `resume`'s own
// defense from finding 5's cancellation-side fix — proving the send is
// refused even when nothing upstream ever cancelled this specific run.
test("resume refuses to execute a post-wait step when the automation was deactivated during the wait window", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "DeactivatedDuringWait");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15550003334");
  // Window held OPEN (unlike the doNotContact test above, which doesn't
  // need this — its gate fires before window resolution is ever
  // reached). Without this the post-wait send would fail on "24h window
  // closed" regardless of whether this fix exists, making the
  // zero-messages assertion below pass for the wrong reason.
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
  });
  await seedStep(t, { accountId, automationId, stepType: "wait", stepConfig: { amount: 1, unit: "minutes" }, position: 0 });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { text: "Following up!" },
    position: 1,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "remind me later", conversationId },
  });

  const parkedRun = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(parkedRun?.status).toBe("waiting");
  const runId = parkedRun!._id;

  await t.run((ctx) => ctx.db.patch(automationId, { isActive: false }));

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // The post-wait send_message step never ran.
  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages).toHaveLength(0);

  // Reaches a terminal state rather than being stranded "waiting" (or
  // "running" with a phantom outstanding branch) forever — the same
  // class of bug finding 1 closes, reachable again here if this guard
  // returned without ever finishing the run.
  const run = await t.run((ctx) => ctx.db.get(runId));
  expect(run?.status).toBe("failed");
  expect(run?.errorMessage).toMatch(/deactivat/);
  expect(run?.outstandingBranches).toBe(0);
  expect(run?.endedAt).toBeGreaterThan(0);

  vi.useRealTimers();
});

// ============================================================
// tag_added trigger (bug fix: the trigger the builder has always
// offered, and `validateTriggerForActivation` has always demanded a
// `tag_id` for, but that NOTHING ever dispatched — `AutomationContext
// .tagId`'s own doc comment called it "a future tag_added trigger").
// Two halves, both required: the pure matcher must respect the
// configured tag, and every code path that attaches a tag must
// actually fire the trigger.
// ============================================================

test("triggerMatches: tag_added matches only the configured tag", () => {
  const automation = { triggerType: "tag_added", triggerConfig: { tag_id: "tag_georgia" } };
  expect(triggerMatches(automation, { tagId: "tag_georgia" as Id<"tags"> })).toBe(true);
  expect(triggerMatches(automation, { tagId: "tag_other" as Id<"tags"> })).toBe(false);
  // No tag in context at all — nothing to match against.
  expect(triggerMatches(automation, {})).toBe(false);
});

test("triggerMatches: a tag_added automation with no tag_id configured never matches", () => {
  // `validateTriggerForActivation` refuses to activate this shape, but a
  // row can still reach the engine (activated before that validation
  // existed, or written straight to the DB) — it must not fire for
  // every tag in the account.
  const automation = { triggerType: "tag_added", triggerConfig: {} };
  expect(triggerMatches(automation, { tagId: "tag_georgia" as Id<"tags"> })).toBe(false);
});

/**
 * Seeds a user + account + membership and returns a client already
 * authenticated as that user. This suite's other helpers deliberately
 * skip `memberships` (see the header comment — engine entry points take
 * an explicit `accountId` and have no session), but the tag_added tests
 * below drive the real, user-facing `contacts.assignTag` mutation
 * end-to-end, which does require one. Mirrors `contacts.test.ts`'s own
 * `seedAccountMember`.
 */
async function seedAccountMember(t: ReturnType<typeof convexTest>, name: string) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name, email: `${name.toLowerCase()}@example.com` }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: `${name}'s account`,
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role: "owner",
      fullName: name,
      email: `${name.toLowerCase()}@example.com`,
    });
    return id;
  });
  return { userId, accountId, asUser: t.withIdentity({ subject: `${userId}|session-${name}` }) };
}

test("assigning a tag fires a matching tag_added automation: wait 1 minute, then send", async () => {
  // The exact shape a user builds in the UI: "when the tag Georgia is
  // added, wait 1 minute, then send a message".
  vi.useFakeTimers();
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, "Acme");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  // Open 24h window (send composer Task 5): this test is about the
  // tag_added -> wait -> send chain, not window state. Still well
  // inside the window a minute later when the wait resumes.
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));
  const georgiaId = await seedTag(t, accountId, "Georgia");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "tag_added",
    triggerConfig: { tag_id: georgiaId },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { text: "hi" },
    position: 1,
  });

  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: georgiaId });

  // Parked on the wait step: nothing sent yet, but the run is live.
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.contentText).toBe("hi");

  const automation = await t.run((ctx) => ctx.db.get(automationId));
  expect(automation!.executionCount).toBe(1);

  vi.useRealTimers();
});

test("assigning a DIFFERENT tag never fires a tag_added automation bound to another tag", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, "Acme");
  const { contactId } = await seedContactAndConversation(t, accountId, "15551234567");
  const georgiaId = await seedTag(t, accountId, "Georgia");
  const otherId = await seedTag(t, accountId, "Unrelated");
  const outcomeId = await seedTag(t, accountId, "was-tagged");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "tag_added",
    triggerConfig: { tag_id: georgiaId },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "add_tag",
    stepConfig: { tag_id: outcomeId },
    position: 0,
  });

  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: otherId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await tagLink(t, contactId, outcomeId)).toBeNull();
  const automation = await t.run((ctx) => ctx.db.get(automationId));
  expect(automation!.executionCount).toBe(0);
});

test("re-assigning a tag the contact already holds does not re-fire the automation", async () => {
  // `assignTag` is idempotent — it returns the existing link without
  // inserting. No insert means no tag was ADDED, so nothing fires.
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, "Acme");
  const { contactId } = await seedContactAndConversation(t, accountId, "15551234567");
  const georgiaId = await seedTag(t, accountId, "Georgia");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "tag_added",
    triggerConfig: { tag_id: georgiaId },
  });
  await seedStep(t, { accountId, automationId, stepType: "wait", stepConfig: { amount: 1, unit: "minutes" }, position: 0 });

  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: georgiaId });
  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: georgiaId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const automation = await t.run((ctx) => ctx.db.get(automationId));
  expect(automation!.executionCount).toBe(1);
});

test("an inactive tag_added automation stays silent", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, "Acme");
  const { contactId } = await seedContactAndConversation(t, accountId, "15551234567");
  const georgiaId = await seedTag(t, accountId, "Georgia");
  const outcomeId = await seedTag(t, accountId, "was-tagged");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "tag_added",
    triggerConfig: { tag_id: georgiaId },
    isActive: false,
  });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: outcomeId }, position: 0 });

  await asUser.mutation(api.contacts.assignTag, { contactId, tagId: georgiaId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await tagLink(t, contactId, outcomeId)).toBeNull();
});

// ============================================================
// conversation_assigned trigger — the second half of the same
// half-wired-trigger bug as `tag_added`. `AutomationContext.agentId`
// had been carved out for it ("Agent the conversation was assigned
// to") but nothing ever dispatched; `conversation_assigned` existed in
// convex/ only as a NOTIFICATION type.
// ============================================================

test("assigning a conversation fires a conversation_assigned automation", async () => {
  vi.useFakeTimers();
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, "Acme");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  // Open 24h window (send composer Task 5): this test is about the
  // conversation_assigned dispatch, not window state.
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "conversation_assigned",
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { text: "An agent will be with you shortly." },
    position: 0,
  });

  await asUser.mutation(api.conversations.assign, { conversationId, userId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const messages = await t.run((ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
      .collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.contentText).toBe("An agent will be with you shortly.");

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.status).toBe("success");
  expect(logs[0]!.contactId).toBe(contactId);

  const automation = await t.run((ctx) => ctx.db.get(automationId));
  expect(automation!.executionCount).toBe(1);

  vi.useRealTimers();
});

test("re-assigning a conversation to the SAME agent does not re-fire", async () => {
  // A double-clicked Assign button must not double-message the customer.
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, "Acme");
  const { conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  const outcomeId = await seedTag(t, accountId, "greeted");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "conversation_assigned",
  });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: outcomeId }, position: 0 });

  await asUser.mutation(api.conversations.assign, { conversationId, userId });
  await asUser.mutation(api.conversations.assign, { conversationId, userId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const automation = await t.run((ctx) => ctx.db.get(automationId));
  expect(automation!.executionCount).toBe(1);

  vi.useRealTimers();
});

test("unassigning a conversation never fires conversation_assigned", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const { accountId, userId, asUser } = await seedAccountMember(t, "Acme");
  const { conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  const outcomeId = await seedTag(t, accountId, "greeted");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "conversation_assigned",
  });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: outcomeId }, position: 0 });

  await asUser.mutation(api.conversations.assign, { conversationId, userId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const afterAssign = await t.run((ctx) => ctx.db.get(automationId));
  expect(afterAssign!.executionCount).toBe(1);

  await asUser.mutation(api.conversations.unassign, { conversationId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // Still 1 — the unassign added nothing.
  const afterUnassign = await t.run((ctx) => ctx.db.get(automationId));
  expect(afterUnassign!.executionCount).toBe(1);

  vi.useRealTimers();
});

// ============================================================
// time_based trigger — the third dead trigger, and the only one that
// needed a real engine rather than dispatch wiring: there was no cron
// entry for automations at all, so a "Time-Based" automation validated,
// activated, and fired nothing forever.
//
// Audience is configured on the trigger (`{ schedule, tag_id }`) because
// a clock tick has no contact of its own.
// ============================================================

/** 05:00 UTC = 09:00 in the Gulf (UTC+4) offset seeded below. */
const NINE_AM_GULF_UTC = Date.UTC(2026, 7, 9, 5, 0, 0, 0);

async function seedGulfOffset(t: ReturnType<typeof convexTest>, accountId: Id<"accounts">) {
  await t.run((ctx) =>
    ctx.db.insert("qualificationConfigs", {
      accountId,
      enabled: false,
      basicFields: [],
      qualifyThresholdScore: 50,
      timezoneLabel: "Asia/Dubai",
      utcOffsetMinutes: 240,
      workStartMinute: 540,
      workEndMinute: 1080,
      workDays: [0, 1, 2, 3, 4],
      followUpDelaysMinutes: [60],
      maxFollowUps: 1,
      sessionWindowHours: 24,
      closingMessage: "Thanks!",
      adminAlertEnabled: false,
      adminAlertPhones: [],
      outboundNudgesEnabled: false,
    }),
  );
}

test("a due time_based automation runs once per contact holding its tag", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NINE_AM_GULF_UTC);
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedGulfOffset(t, accountId);
  const followUp = await seedTag(t, accountId, "Follow-up");
  const outcome = await seedTag(t, accountId, "nudged");

  const a = await seedContactAndConversation(t, accountId, "15550000001");
  const b = await seedContactAndConversation(t, accountId, "15550000002");
  const outsider = await seedContactAndConversation(t, accountId, "15550000003");
  await t.run(async (ctx) => {
    await ctx.db.insert("contactTags", { accountId, contactId: a.contactId, tagId: followUp });
    await ctx.db.insert("contactTags", { accountId, contactId: b.contactId, tagId: followUp });
  });

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "time_based",
    triggerConfig: { schedule: "09:00", tag_id: followUp },
  });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: outcome }, position: 0 });

  const result = await t.action(internal.automationsEngine.sweepTimeBased, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(result).toEqual({ fired: 1, contacts: 2 });
  expect(await tagLink(t, a.contactId, outcome)).not.toBeNull();
  expect(await tagLink(t, b.contactId, outcome)).not.toBeNull();
  // Never held the audience tag, so it was never in the audience.
  expect(await tagLink(t, outsider.contactId, outcome)).toBeNull();

  vi.useRealTimers();
});

test("a time_based automation does not fire twice on the same local day", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NINE_AM_GULF_UTC);
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedGulfOffset(t, accountId);
  const followUp = await seedTag(t, accountId, "Follow-up");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550000001");
  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: followUp }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "time_based",
    triggerConfig: { schedule: "09:00", tag_id: followUp },
  });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: followUp }, position: 0 });

  expect(await t.action(internal.automationsEngine.sweepTimeBased, {})).toEqual({ fired: 1, contacts: 1 });
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // The next sweep 15 minutes later is still inside the catch-up window,
  // but the day is already claimed.
  vi.setSystemTime(NINE_AM_GULF_UTC + 15 * 60_000);
  expect(await t.action(internal.automationsEngine.sweepTimeBased, {})).toEqual({ fired: 0, contacts: 0 });

  vi.useRealTimers();
});

test("a time_based automation is silent outside its catch-up window", async () => {
  vi.useFakeTimers();
  // 20:00 local — hours past a 09:00 schedule.
  vi.setSystemTime(Date.UTC(2026, 7, 9, 16, 0, 0, 0));
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedGulfOffset(t, accountId);
  const followUp = await seedTag(t, accountId, "Follow-up");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550000001");
  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: followUp }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "time_based",
    triggerConfig: { schedule: "09:00", tag_id: followUp },
  });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: followUp }, position: 0 });

  expect(await t.action(internal.automationsEngine.sweepTimeBased, {})).toEqual({ fired: 0, contacts: 0 });

  vi.useRealTimers();
});

test("one due time_based automation never drags another account's or another schedule's along", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NINE_AM_GULF_UTC);
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedGulfOffset(t, accountId);
  const followUp = await seedTag(t, accountId, "Follow-up");
  const morning = await seedTag(t, accountId, "morning-ran");
  const evening = await seedTag(t, accountId, "evening-ran");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550000001");
  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: followUp }));

  const morningId = await seedAutomation(t, {
    accountId,
    triggerType: "time_based",
    triggerConfig: { schedule: "09:00", tag_id: followUp },
    name: "Morning nudge",
  });
  await seedStep(t, { accountId, automationId: morningId, stepType: "add_tag", stepConfig: { tag_id: morning }, position: 0 });

  // Same account, same audience, different time — must stay asleep.
  const eveningId = await seedAutomation(t, {
    accountId,
    triggerType: "time_based",
    triggerConfig: { schedule: "18:00", tag_id: followUp },
    name: "Evening nudge",
  });
  await seedStep(t, { accountId, automationId: eveningId, stepType: "add_tag", stepConfig: { tag_id: evening }, position: 0 });

  await t.action(internal.automationsEngine.sweepTimeBased, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await tagLink(t, contactId, morning)).not.toBeNull();
  expect(await tagLink(t, contactId, evening)).toBeNull();

  vi.useRealTimers();
});

test("a time_based automation with an unparseable schedule or no tag never fires", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NINE_AM_GULF_UTC);
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedGulfOffset(t, accountId);
  const followUp = await seedTag(t, accountId, "Follow-up");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550000001");
  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: followUp }));

  // A cron expression — what the old placeholder invited, and what the
  // old validation happily activated.
  const cronId = await seedAutomation(t, {
    accountId,
    triggerType: "time_based",
    triggerConfig: { schedule: "0 9 * * *", tag_id: followUp },
  });
  await seedStep(t, { accountId, automationId: cronId, stepType: "add_tag", stepConfig: { tag_id: followUp }, position: 0 });

  // Schedule but no audience.
  const noTagId = await seedAutomation(t, {
    accountId,
    triggerType: "time_based",
    triggerConfig: { schedule: "09:00" },
  });
  await seedStep(t, { accountId, automationId: noTagId, stepType: "add_tag", stepConfig: { tag_id: followUp }, position: 0 });

  expect(await t.action(internal.automationsEngine.sweepTimeBased, {})).toEqual({ fired: 0, contacts: 0 });

  vi.useRealTimers();
});

test("an inactive time_based automation stays silent", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NINE_AM_GULF_UTC);
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedGulfOffset(t, accountId);
  const followUp = await seedTag(t, accountId, "Follow-up");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550000001");
  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: followUp }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "time_based",
    triggerConfig: { schedule: "09:00", tag_id: followUp },
    isActive: false,
  });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: followUp }, position: 0 });

  expect(await t.action(internal.automationsEngine.sweepTimeBased, {})).toEqual({ fired: 0, contacts: 0 });

  vi.useRealTimers();
});

test("an account with no qualification config falls back to UTC rather than being skipped", async () => {
  vi.useFakeTimers();
  // 09:00 UTC exactly — no qualificationConfigs row is seeded.
  vi.setSystemTime(Date.UTC(2026, 7, 9, 9, 0, 0, 0));
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const followUp = await seedTag(t, accountId, "Follow-up");
  const outcome = await seedTag(t, accountId, "nudged");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550000001");
  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: followUp }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "time_based",
    triggerConfig: { schedule: "09:00", tag_id: followUp },
  });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: outcome }, position: 0 });

  expect(await t.action(internal.automationsEngine.sweepTimeBased, {})).toEqual({ fired: 1, contacts: 1 });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await tagLink(t, contactId, outcome)).not.toBeNull();

  vi.useRealTimers();
});

// ============================================================
// send_message media support (send composer Task 4): runStep's
// send_message case now goes through planSend and can carry an image/
// video/audio/document instead of (or alongside) text. Not renumbered
// into the sequence above to keep this diff scoped to the addition —
// mirrors flowsEngine.test.ts's own "3b." convention for the identical
// situation. Follows THIS suite's real stubbing convention
// (CONVEX_META_DRY_RUN + asserting on the persisted `messages`/
// `automationLogs` rows), not a mocked metaSend action — see section 4
// above and flowsEngine.test.ts's send_media tests for precedent.
// ============================================================

test("send_message with an image sends one captioned media message", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.R2_BUCKET = "wa-amani";
  process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "ak";
  process.env.R2_SECRET_ACCESS_KEY = "sk";
  process.env.R2_PUBLIC_HOST = "https://objs.amaniworld.com";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Media");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  // Open 24h window (send composer Task 5): this test is about media
  // send composition, not window state.
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["photo"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: {
      text: "look at this",
      media: { type: "image", key: `${accountId}/automation/a.jpg` },
    },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "photo" },
  });

  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.contentType).toBe("image");
  expect(messages[0]!.contentText).toBe("look at this");
  expect(messages[0]!.mediaKey).toBe(`${accountId}/automation/a.jpg`);
  expect(messages[0]!.mediaUrl).toBe(`https://objs.amaniworld.com/${accountId}/automation/a.jpg`);

  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

// `planSend` (sendPlan.test.ts) already locks the DECISION that audio +
// text splits into `media_then_text`; nothing exercised the engine's own
// half of that — the branch in runStep's send_message case that turns
// one plan into TWO sequential metaSend calls. Meta 400s a captioned
// audio message, which is exactly what a regression here would produce.
test("send_message with audio and text sends the audio uncaptioned, then the text as its own message", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.R2_BUCKET = "wa-amani";
  process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "ak";
  process.env.R2_SECRET_ACCESS_KEY = "sk";
  process.env.R2_PUBLIC_HOST = "https://objs.amaniworld.com";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Audio");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  // Open 24h window (send composer Task 5): this test is about the
  // media_then_text split, not window state.
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["listen"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: {
      text: "here's the recording",
      media: { type: "audio", key: `${accountId}/automation/a.ogg` },
    },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "listen" },
  });

  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages).toHaveLength(2);
  // Media first — no caption. A caption on an audio message is what
  // makes Meta 400 in the first place, so this is the one field a
  // regression here would most plausibly get wrong.
  expect(messages[0]!.contentType).toBe("audio");
  expect(messages[0]!.contentText).toBeUndefined();
  expect(messages[0]!.mediaKey).toBe(`${accountId}/automation/a.ogg`);
  // Text follows as its own message.
  expect(messages[1]!.contentType).toBe("text");
  expect(messages[1]!.contentText).toBe("here's the recording");

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs[0]!.stepsExecuted[0]!.detail).toMatch(/^audio \+ text sent via Meta \(.+, .+\)$/);

  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

test("send_message rejects a media key belonging to another account", async () => {
  // R2 is deliberately left CONFIGURED (not omitted) — with no ownership
  // check, this send would otherwise SUCCEED, resolving the foreign key
  // to a real fetchable URL. Same rationale as flowsEngine.test.ts's
  // identical cross-account send_media test.
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.R2_BUCKET = "wa-amani";
  process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "ak";
  process.env.R2_SECRET_ACCESS_KEY = "sk";
  process.env.R2_PUBLIC_HOST = "https://objs.amaniworld.com";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Mine");
  const otherId = await seedAccount(t, "Theirs");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  // Open 24h window (send composer Task 5): this test is about the
  // cross-account media-key guard, not window state — an open window
  // ensures the step actually reaches that guard instead of failing
  // earlier on the window check.
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["photo"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { media: { type: "image", key: `${otherId}/automation/a.jpg` } },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "photo" },
  });

  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages).toHaveLength(0);

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs[0]!.status).toBe("failed");
  expect(logs[0]!.errorMessage).toMatch(/does not belong to this account/);

  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

test("send_message rejects a note-kind key — internal evidence must never reach a customer", async () => {
  // Same-account key (isolates the KIND check from the ownership check
  // above) but kind "note" — the one kind that must never be forwarded
  // to a customer. This dispatch path calls internal.metaSend.sendMedia
  // directly, so send.ts's own SENDABLE_MEDIA_KINDS guard never runs on
  // it; AUTOMATION_SENDABLE_MEDIA_KINDS is what has to catch it here.
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.R2_BUCKET = "wa-amani";
  process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "ak";
  process.env.R2_SECRET_ACCESS_KEY = "sk";
  process.env.R2_PUBLIC_HOST = "https://objs.amaniworld.com";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Notes");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  // Open 24h window (send composer Task 5): this test is about the
  // note-kind media guard, not window state — an open window ensures
  // the step actually reaches that guard instead of failing earlier on
  // the window check.
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["photo"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { media: { type: "image", key: `${accountId}/note/passport.jpg` } },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "photo" },
  });

  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages).toHaveLength(0);

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs[0]!.status).toBe("failed");
  expect(logs[0]!.errorMessage).toMatch(/does not belong to this account/);

  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

test("a legacy { text } config still sends plain text", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Legacy");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  // Open 24h window (send composer Task 5): this test is about the
  // legacy { text } config shape, not window state.
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { text: "hello" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.contentType).toBe("text");
  expect(messages[0]!.contentText).toBe("hello");
});

// ============================================================
// 24h customer-service-window resolution + template fallback (send
// composer Task 5): `send_message` now resolves Meta's 24h window
// (`internal.automationsEngine.resolveWindowQuery`, a thin wrapper
// around the shared, pure `resolveWindowState` — see
// `convex/lib/whatsapp/messagingWindow.ts`) before sending anything.
// Open window: unchanged free-form behavior. Closed window: send the
// step's configured `fallback` template instead, or fail LEGIBLY with
// no network call if none is configured — replacing what used to be a
// silent 400 at Meta.
//
// `seedContactAndConversation` never sets `lastInboundAt` (see its own
// definition above), so "never received an inbound message" is just
// that helper's default, unpatched state — no special seeding needed
// for that case. Every other case patches it directly via
// `ctx.db.patch`, matching this suite's own established one-off-field
// convention (e.g. the `leadValue` patch in the assign_conversation
// section above) rather than inventing a new parameterized seed helper.
//
// Free-form / no-fallback-failure coverage stays on this suite's
// existing DRY-RUN + persisted-`messages`/`automationLogs` convention.
// The one case that must prove the ACTUAL wire payload — the fallback
// template's params reach Meta in the right slot, in the right order,
// with its optional header attached — runs a real (non-DRY-RUN) send
// with `fetch` stubbed, the same pattern `ingest.test.ts` already uses
// for its own outbound-Meta-call assertions.
// ============================================================

const HOUR = 60 * 60 * 1000;

test("window open: sends the composed free-form message, not a template", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Open");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() - HOUR }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: {
      text: "still here?",
      fallback: { template_name: "revival", language: "en_US" },
    },
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
  expect(messages[0]!.contentType).toBe("text");
  expect(messages[0]!.contentText).toBe("still here?");

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs[0]!.status).toBe("success");
});

test("window closed: sends the fallback template with correctly ordered params and its header, never the free-form text", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Closed");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() - 30 * HOUR }));
  await t.run(async (ctx) =>
    ctx.db.insert("whatsappConfig", {
      accountId,
      phoneNumberId: "pn-closed",
      accessToken: await encrypt("secret-token"),
      status: "connected",
    }),
  );

  // Real (non-DRY-RUN) send with `fetch` stubbed so the actual Meta wire
  // payload can be inspected — DRY-RUN never reaches `sendTemplateMessage`,
  // and the persisted `messages` row doesn't carry `params` at all (see
  // `metaSend.ts`'s `sendTemplate`), so this is the only way to prove
  // ordering. Keys "1"/"2"/"10" are deliberately the exact case
  // `sortTemplateParams`'s own doc comment warns about — a naive
  // lexicographic `.sort()` yields "1", "10", "2", scrambling the params.
  // Definite-assignment (`!`): assigned inside the fetch mock below,
  // which TS can't statically prove runs before the assertions read it.
  let capturedBody!: {
    type: string;
    template: { name: string; language: { code: string }; components?: unknown[] };
  };
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "wamid.FALLBACK1" }] }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: {
      text: "still here?",
      fallback: {
        template_name: "revival",
        language: "en_US",
        variables: { "1": "Ada", "2": "Karimi", "10": "Zephyr" },
        header: { type: "image", url: "https://example.com/revival-banner.jpg" },
      },
    },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi", conversationId },
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(capturedBody.type).toBe("template");
  expect(capturedBody.template.name).toBe("revival");
  expect(capturedBody.template.language).toEqual({ code: "en_US" });
  expect(capturedBody.template.components).toEqual([
    {
      type: "header",
      parameters: [{ type: "image", image: { link: "https://example.com/revival-banner.jpg" } }],
    },
    {
      type: "body",
      parameters: [
        { type: "text", text: "Ada" },
        { type: "text", text: "Karimi" },
        { type: "text", text: "Zephyr" },
      ],
    },
  ]);

  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.contentType).toBe("template");
  expect(messages[0]!.templateName).toBe("revival");
  expect(messages[0]!.messageId).toBe("wamid.FALLBACK1");

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs[0]!.status).toBe("success");

  vi.unstubAllGlobals();
});

test("window closed, no fallback configured: fails legibly before any network call", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "NoFallback");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() - 30 * HOUR }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { text: "still here?" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi", conversationId },
  });

  // The legibility claim: no message ever reached the wire.
  expect(fetchSpy).not.toHaveBeenCalled();

  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages).toHaveLength(0);

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.status).toBe("failed");
  expect(logs[0]!.errorMessage).toBe("24h window closed and no fallback template configured");

  vi.unstubAllGlobals();
});

test("a conversation that never received an inbound message counts as closed", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "NeverInbound");
  // seedContactAndConversation never sets lastInboundAt — this conversation
  // genuinely never received a customer message, unpatched.
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
    stepConfig: { text: "hi" },
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
  expect(messages).toHaveLength(0);

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.status).toBe("failed");
  expect(logs[0]!.errorMessage).toBe("24h window closed and no fallback template configured");
});

// ============================================================
// The standalone `send_template` step (Task 11, send composer): unlike
// send_message's fallback branch above — which has its own dedicated
// wire-payload test — send_template's own `case` in `runStep` had NO
// coverage of its outbound Meta payload at all before this section:
// neither its header component nor its params ordering was ever
// asserted, and nothing proved the account-scoped media guard is
// actually reached from THIS case (as opposed to merely existing,
// shared, on the fallback branch's call site). Same real-send +
// stubbed-`fetch` pattern as the fallback test above, since DRY-RUN
// never reaches `sendTemplateMessage` and can't prove wire ordering.
// ============================================================

test("send_template: sends with correctly ordered params and its header", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "TemplateWire");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  await t.run(async (ctx) =>
    ctx.db.insert("whatsappConfig", {
      accountId,
      phoneNumberId: "pn-template-wire",
      accessToken: await encrypt("secret-token"),
      status: "connected",
    }),
  );

  // Keys "1"/"2"/"10" are deliberately the exact case sortTemplateParams's
  // own doc comment warns about — a naive lexicographic `.sort()` yields
  // "1", "10", "2", scrambling the params. Definite-assignment (`!`):
  // assigned inside the fetch mock below, which TS can't statically prove
  // runs before the assertions read it.
  let capturedBody!: {
    type: string;
    template: { name: string; language: { code: string }; components?: unknown[] };
  };
  const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: "wamid.TEMPLATEWIRE1" }] }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_template",
    stepConfig: {
      template_name: "revival",
      language: "en_US",
      variables: { "1": "Ada", "2": "Karimi", "10": "Zephyr" },
      header: { type: "image", url: "https://example.com/revival-banner.jpg" },
    },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi", conversationId },
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(capturedBody.type).toBe("template");
  expect(capturedBody.template.name).toBe("revival");
  expect(capturedBody.template.language).toEqual({ code: "en_US" });
  // Header BEFORE body — Meta 400s on the reverse order — and params in
  // strict numeric order (Ada=1, Karimi=2, Zephyr=10), not lexicographic
  // ("1", "10", "2") order.
  expect(capturedBody.template.components).toEqual([
    {
      type: "header",
      parameters: [{ type: "image", image: { link: "https://example.com/revival-banner.jpg" } }],
    },
    {
      type: "body",
      parameters: [
        { type: "text", text: "Ada" },
        { type: "text", text: "Karimi" },
        { type: "text", text: "Zephyr" },
      ],
    },
  ]);

  const messages = await t.run((ctx) =>
    ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(messages).toHaveLength(1);
  expect(messages[0]!.contentType).toBe("template");
  expect(messages[0]!.templateName).toBe("revival");
  expect(messages[0]!.messageId).toBe("wamid.TEMPLATEWIRE1");

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs[0]!.status).toBe("success");

  vi.unstubAllGlobals();
});

test("send_template rejects a header media key belonging to another account", async () => {
  // R2 is deliberately left CONFIGURED (not omitted) — with no ownership
  // check, this send would otherwise SUCCEED, resolving the foreign key
  // to a real fetchable URL. Same rationale as send_message's identical
  // cross-account media-key test earlier in this file — this proves the
  // SAME resolveMediaLink guard is actually reached from send_template's
  // own case, not just from send_message's fallback branch (a different
  // call site sharing the same helper function).
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.R2_BUCKET = "wa-amani";
  process.env.R2_ENDPOINT = "https://acct.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "ak";
  process.env.R2_SECRET_ACCESS_KEY = "sk";
  process.env.R2_PUBLIC_HOST = "https://objs.amaniworld.com";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "TemplateMine");
  const otherId = await seedAccount(t, "TemplateTheirs");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_template",
    stepConfig: {
      template_name: "revival",
      language: "en_US",
      header: { type: "image", key: `${otherId}/automation/banner.jpg` },
    },
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
  expect(messages).toHaveLength(0);

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs[0]!.status).toBe("failed");
  expect(logs[0]!.errorMessage).toMatch(/does not belong to this account/);

  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
});

// ------------------------------------------------------------
// resolveWindowQuery directly — the interface Task 6 (`session_window`
// condition) reuses. Covered independently of the send-step behavior
// above so its own return shape and tenant-isolation guard are locked
// in regardless of how `send_message` happens to use it.
// ------------------------------------------------------------

test("resolveWindowQuery: open window reports canSendFreeForm with a matching expiresAt/remainingMs", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "WindowQueryOpen");
  const { conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  const lastInboundAt = Date.now() - HOUR;
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt }));

  const result = await t.query(internal.automationsEngine.resolveWindowQuery, {
    accountId,
    conversationId,
  });

  expect(result.canSendFreeForm).toBe(true);
  expect(result.expiresAt).toBe(lastInboundAt + 24 * HOUR);
  expect(result.remainingMs).toBeGreaterThan(0);
});

test("resolveWindowQuery: a conversation belonging to a different account reads as closed (tenant isolation)", async () => {
  const t = convexTest(schema, modules);
  const accountA = await seedAccount(t, "WindowQueryA");
  const accountB = await seedAccount(t, "WindowQueryB");
  const { conversationId } = await seedContactAndConversation(t, accountB, "15550000009");
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() - HOUR }));

  const result = await t.query(internal.automationsEngine.resolveWindowQuery, {
    accountId: accountA,
    conversationId,
  });

  expect(result.canSendFreeForm).toBe(false);
  expect(result.remainingMs).toBe(0);
});

// ============================================================
// session_window condition (send composer Task 6) — lets an operator
// branch on Meta's 24h customer service window directly on the canvas,
// via the exact same `resolveWindowQuery` the send step's fallback
// (Task 5, above) already uses. `seedContactAndConversation` +
// `ctx.db.patch(conversationId, { lastInboundAt })` is this suite's own
// established way to move the window open/closed (see the block above);
// no new seed helper is introduced here.
// ============================================================

test("session_window condition takes the yes branch while the window is open", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "CondOpen");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() - HOUR }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "session_window", operand: "open" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi", conversationId },
  });

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.stepsExecuted[0]!.detail).toBe("branch=yes");
});

test("session_window condition takes the no branch once the window has closed", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "CondClosed");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() - 30 * HOUR }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "session_window", operand: "open" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi", conversationId },
  });

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.stepsExecuted[0]!.detail).toBe("branch=no");
});

test("session_window condition operand 'closed' inverts the test", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "CondInvert");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() - 30 * HOUR }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "session_window", operand: "closed" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi", conversationId },
  });

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.stepsExecuted[0]!.detail).toBe("branch=yes");
});

test("session_window condition treats an unset operand the same as 'open'", async () => {
  // Not one of the brief's three illustrative cases, but an explicit
  // requirement ("treat operand unset as open") that none of the three
  // above actually locks in — the first test only proves an EXPLICIT
  // "open" behaves as open.
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "CondUnset");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15551234567");
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() - HOUR }));

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "session_window" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi", conversationId },
  });

  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.stepsExecuted[0]!.detail).toBe("branch=yes");
});

// ============================================================
// time_of_day condition (Task 7) — evaluates against the account's own
// qualificationConfigs.utcOffsetMinutes instead of the Convex runtime's
// own clock. Same source, and the same UTC fallback, that the
// time_based trigger already uses (`seedGulfOffset` / `listDueTimeBased`
// above) — this condition and that trigger now agree on what
// "account-local time" means.
//
// `process.env.TZ` is pinned to "UTC" for the duration of both tests
// below. Convex's production runtime has no timezone database, so
// `new Date()` there always reads UTC — the assumption the pre-fix
// `time_of_day` code relied on. This test process is plain Node under
// `vi`'s fake timers, though, and `Date#getHours()` here reads the
// *host machine's* local timezone. Left unpinned, these two tests would
// pass or fail depending on which machine ran them — including going
// green for the wrong reason on a host already set to UTC+4, which is
// this repo's own dev environment.
// ============================================================

/**
 * Restores `process.env.TZ` to its pre-test value. A plain
 * `process.env.TZ = original` would coerce `original === undefined` to
 * the literal string `"undefined"` — every `process.env` assignment is
 * stringified — which Node's Intl loader treats as just another
 * (bogus) zone rather than "unset", so the host's real original TZ
 * would never actually come back.
 */
function restoreTz(original: string | undefined) {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
}

/**
 * Every required field of `qualificationConfigs` (schema.ts) at inert
 * defaults, so a caller only has to spread this and override the one
 * field a test cares about — a partial insert fails schema validation.
 * Same table and the same reason as `seedGulfOffset` above, but leaves
 * `utcOffsetMinutes` at neutral (0) rather than hardcoding Gulf, since
 * the tests below need both a configured non-zero offset and an
 * explicit zero one.
 */
function qualificationConfigDefaults(accountId: Id<"accounts">) {
  return {
    accountId,
    enabled: false,
    basicFields: [],
    qualifyThresholdScore: 50,
    timezoneLabel: "UTC",
    utcOffsetMinutes: 0,
    workStartMinute: 540,
    workEndMinute: 1080,
    workDays: [0, 1, 2, 3, 4],
    followUpDelaysMinutes: [60],
    maxFollowUps: 1,
    sessionWindowHours: 24,
    closingMessage: "Thanks!",
    adminAlertEnabled: false,
    adminAlertPhones: [],
    outboundNudgesEnabled: false,
  };
}

test("time_of_day evaluates against the account's UTC offset, not the server's", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Dubai");
  // Dubai is UTC+4. 15:00 UTC is 19:00 local, inside an 18:00-09:00
  // out-of-office window; in UTC it would fall outside it.
  await t.run(async (ctx) => {
    await ctx.db.insert("qualificationConfigs", {
      ...qualificationConfigDefaults(accountId),
      utcOffsetMinutes: 240,
    });
  });
  const { contactId } = await seedContactAndConversation(t, accountId, "15551234567");

  const originalTz = process.env.TZ;
  process.env.TZ = "UTC";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T15:00:00Z"));
  try {
    const automationId = await seedAutomation(t, {
      accountId,
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["hi"], match_type: "contains" },
    });
    await seedStep(t, {
      accountId,
      automationId,
      stepType: "condition",
      stepConfig: { subject: "time_of_day", operand: "18:00-09:00" },
      position: 0,
    });

    await t.action(internal.automationsEngine.runForTrigger, {
      accountId,
      triggerType: "keyword_match",
      contactId,
      context: { messageText: "hi" },
    });

    const logs = await t.run((ctx) =>
      ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.stepsExecuted[0]!.detail).toBe("branch=yes");
  } finally {
    vi.useRealTimers();
    restoreTz(originalTz);
  }
});

// ============================================================
// automationRuns — one row per enrolment (Phase 2 run-tracking,
// Task 3). A log says what HAPPENED; a run says where a contact IS.
// `createRun` fires in `runAutomation` right after `createLog`,
// before any step executes; `finishRun` closes it out once the root
// scope's own log status goes final (success/failed) — a nested
// condition branch finishing does not end the run. A do-not-contact
// block never creates a run row at all: `recordBlockedRun` is a
// distinct path from `runAutomation` and nobody was enrolled.
// ============================================================

test("a successful run records one completed automationRuns row", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Runs");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550004444");
  const tagId = await seedTag(t, accountId, "vip");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
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
    context: { messageText: "hi" },
  });

  const runs = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .collect(),
  );
  expect(runs).toHaveLength(1);
  expect(runs[0]!.status).toBe("completed");
  expect(runs[0]!.contactId).toBe(contactId);
  expect(runs[0]!.endedAt).toBeGreaterThan(0);
});

test("a failing step marks the run failed and records the message", async () => {
  // Defense-in-depth, mirroring the GHSA-8jqh-598v-rfxc parity test
  // above: the SSRF guard should refuse this URL before `fetch` is
  // ever reached, so stub it to prove no real request escapes even
  // if that guard regresses.
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
  vi.stubGlobal("fetch", fetchSpy);

  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Fails");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550005555");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_webhook",
    stepConfig: { url: "http://127.0.0.1/hook" }, // SSRF guard refuses it
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  expect(fetchSpy).not.toHaveBeenCalled();
  const run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("failed");
  expect(run?.errorMessage).toMatch(/not allowed/);

  vi.unstubAllGlobals();
});

test("a do-not-contact block records no run row — nobody was enrolled", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Blocked");
  const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15550006666");
  await markDoNotContact(t, accountId, contactId);

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { text: "hi" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi", conversationId },
  });

  const runs = await t.run((ctx) => ctx.db.query("automationRuns").collect());
  expect(runs).toHaveLength(0);
});

// Task 3 review fix round, item 2: `finishRun`'s cancelled-guard (a
// missing or already-`"cancelled"` run is a no-op) was previously
// exercised only indirectly, by inspection — it is the one thing the
// original brief called out as load-bearing for Task 5 (cancellation),
// which needs a cancelled run to stay cancelled even if a step that was
// already in flight completes afterwards. `finishRun` is called
// directly here (no `cancelRun` mutation exists yet to set the status
// through) so this test exercises exactly the guard, nothing else.
test("finishRun refuses to resurrect an already-cancelled run", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "CancelledGuard");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550001111");
  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });

  const runId = await t.mutation(internal.automationsEngine.createRun, {
    accountId,
    automationId,
    contactId,
  });

  // Simulate Task 5's own cancellation transition directly, since no
  // `cancelRun` mutation exists yet to call.
  const cancelledAt = Date.now();
  await t.run((ctx) =>
    ctx.db.patch(runId, { status: "cancelled", endedAt: cancelledAt, updatedAt: cancelledAt }),
  );

  // A step that was already in flight when the cancellation landed
  // finishes afterwards and calls finishRun, same as any other step.
  await t.mutation(internal.automationsEngine.finishRun, {
    runId,
    status: "failed",
    errorMessage: "should never apply",
  });

  const run = await t.run((ctx) => ctx.db.get(runId));
  expect(run?.status).toBe("cancelled");
  expect(run?.errorMessage).toBeUndefined();
  expect(run?.endedAt).toBe(cancelledAt);
});

// Covers this file's header comment #3 (a deliberate deviation from the
// run-tracking brief's own snippets, which only cover the non-suspended
// path): the `runId` created at dispatch must survive a `wait`
// suspend/resume cycle, or the run row would sit at `status: "running"`
// forever even after the automation actually finishes.
test("a run that suspends on a wait still reaches finishRun once it resumes to completion", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Waits");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550007777");
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

  // Still suspended: exactly one run row, not yet terminal. Task 4: the
  // wait itself now parks the run as "waiting" (previously this stayed
  // "running" the whole time, since nothing persisted the suspension).
  let run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("waiting");
  expect(run?.endedAt).toBeUndefined();

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("completed");
  expect(run?.endedAt).toBeGreaterThan(0);

  vi.useRealTimers();
});

// Task 3 review fix round, item 1: a `wait` nested inside a `condition`
// branch must not let the ROOT scope's own completion mark the run
// `"completed"` while that branch is still suspended — and, once the
// branch's resume actually runs the rest of its steps, the run must
// reach `"completed"` for real. Reviewer's exact repro: a root-level
// `condition` whose taken branch is `[wait, add_tag]`.
test("a wait nested inside a condition branch does not prematurely complete the run", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "NestedWait");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550009999");
  const vipTagId = await seedTag(t, accountId, "vip");
  const welcomeTagId = await seedTag(t, accountId, "welcomed");

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
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    parentStepId: conditionStepId,
    branch: "yes",
    stepType: "add_tag",
    stepConfig: { tag_id: welcomeTagId },
    position: 1,
  });

  // Contact has the vip tag, so the condition takes the "yes" branch —
  // the one containing the wait.
  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: vipTagId }));

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  // Immediately after dispatch: the branch's wait hasn't resolved and
  // add_tag demonstrably has not run — the run row must not claim the
  // automation is done.
  expect(await tagLink(t, contactId, welcomeTagId)).toBeNull();
  let run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).not.toBe("completed");
  expect(run?.endedAt).toBeUndefined();

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // After the resume fires and add_tag actually runs, the run is
  // genuinely done.
  expect(await tagLink(t, contactId, welcomeTagId)).not.toBeNull();
  run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("completed");
  expect(run?.endedAt).toBeGreaterThan(0);

  vi.useRealTimers();
});

// Found while fixing the item above, not separately requested: a
// `wait` that is the LAST configured step in its scope means the
// resumed call lands on "zero remaining steps" (`scopedSteps` returns
// `[]`) rather than falling out of the for-loop's own tail — a
// different code path that, before this fix round, never called
// `finishRun` at all (only the loop's own tail did).
test("a run whose only step is a wait still reaches finishRun once it resumes", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "WaitIsLast");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550001010");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["bye"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "bye" },
  });

  // Task 4: the wait itself now parks the run as "waiting" (previously
  // this stayed "running" the whole time it was suspended).
  let run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("waiting");

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("completed");
  expect(run?.endedAt).toBeGreaterThan(0);

  vi.useRealTimers();
});

// Task 3 review fix round 2: a root-level step that fails in the SAME
// dispatch as a sibling branch suspending on a wait must not have that
// failure silently dropped once the branch's own resume later finishes
// the run. Before this fix, the entry call correctly declined to
// finish the run while `suspended` (fixing round 1's bug), but its own
// "send_webhook failed" outcome was never durably recorded anywhere —
// so the LATER resume, having no memory of it, finished the run
// "completed" with no error message, even though the log (which
// finalizes independently, in the same first dispatch) already says
// "failed". Reviewer's exact repro: root condition (branch = [wait])
// followed by a root-level step that fails.
test("a root-level failure sharing a dispatch with a suspended sibling branch is not lost when the branch later finishes the run", async () => {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
  vi.stubGlobal("fetch", fetchSpy);
  vi.useFakeTimers();

  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "LostFailure");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550001212");
  const vipTagId = await seedTag(t, accountId, "vip");

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
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });
  // Root-level sibling AFTER the condition: runs (and fails) in the
  // SAME dispatch as the branch's wait being scheduled, since a
  // suspended branch does not pause its parent's later siblings.
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_webhook",
    stepConfig: { url: "http://127.0.0.1/hook" }, // SSRF guard refuses it
    position: 1,
  });

  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: vipTagId }));

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  // Same dispatch: the log already reflects the failure...
  const logs = await t.run((ctx) =>
    ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]!.status).toBe("failed");
  expect(logs[0]!.errorMessage).toMatch(/not allowed/);

  // ...but the run isn't finished yet: the branch is still suspended,
  // so round 1's fix correctly holds off calling finishRun here. Task 4:
  // the still-pending wait parks the run as "waiting", not "running".
  let run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("waiting");

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // Once the branch's own resume finishes the run, the earlier failure
  // must still be there — not silently replaced with "completed".
  run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("failed");
  expect(run?.errorMessage).toMatch(/not allowed/);
  expect(run?.endedAt).toBeGreaterThan(0);

  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Broader than the reviewer's own repro above: TWO independent root
// branches each suspend on their own wait in the same dispatch (two
// scheduled resumes, not one), and only the second one's resume goes
// on to hit a real failure. `finishRun` is not called exactly once
// here — both resumes' entry calls reach it, since neither itself
// suspends further — but re-reading `run.errorMessage` fresh on every
// call (see `finishRun`'s own comment) means the two calls converge on
// the correct final answer regardless of which one happens to fire
// first. This is the evidence behind this fix round's report: it
// closes the LOST-FAILURE half of the "double finishRun" concern for
// any number of independent branches, not just this one pair; it does
// NOT stop finishRun from being invoked more than once, which would
// need a durable outstanding-branch count — a schema change left to
// Task 4 (see the report for the full reasoning).
test("two independently suspended branches converge on the failure even though finishRun fires for each", async () => {
  const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
  vi.stubGlobal("fetch", fetchSpy);
  vi.useFakeTimers();

  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "TwoBranches");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550001313");
  const tagA = await seedTag(t, accountId, "segment-a");
  const tagB = await seedTag(t, accountId, "segment-b");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  const conditionAId = await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "tag_presence", operand: tagA },
    position: 0,
  });
  // Branch A: just a wait — its resume lands on "zero remaining
  // steps" and, if it fires while nothing has failed yet, finishes
  // the run "completed".
  await seedStep(t, {
    accountId,
    automationId,
    parentStepId: conditionAId,
    branch: "yes",
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });
  const conditionBId = await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "tag_presence", operand: tagB },
    position: 1,
  });
  // Branch B: waits too, THEN fails once resumed — independently of
  // branch A's own resume.
  await seedStep(t, {
    accountId,
    automationId,
    parentStepId: conditionBId,
    branch: "yes",
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    parentStepId: conditionBId,
    branch: "yes",
    stepType: "send_webhook",
    stepConfig: { url: "http://127.0.0.1/hook" },
    position: 1,
  });

  await t.run((ctx) =>
    ctx.db.insert("contactTags", { accountId, contactId, tagId: tagA }),
  );
  await t.run((ctx) =>
    ctx.db.insert("contactTags", { accountId, contactId, tagId: tagB }),
  );

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  // Two independent resumes now scheduled; neither has fired. Task 4:
  // both waits parked the run as "waiting", not "running".
  let run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("waiting");

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // Whichever order the two resumes actually fired in, the FINAL
  // state must reflect the real failure, not just whichever call
  // happened to land last.
  run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("failed");
  expect(run?.errorMessage).toMatch(/not allowed/);
  expect(run?.endedAt).toBeGreaterThan(0);

  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// recordRunFailure's own two guards — introduced by this fix round,
// same class of previously-uncovered-guard gap as finishRun's
// cancelled check above, so covering it directly here rather than
// leaving it to a later round to flag again.
test("recordRunFailure is a no-op on an already-cancelled run, and keeps the first failure it records", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "RecordFailureGuard");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550001414");
  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });

  // A cancelled run must not be touched at all.
  const cancelledRunId = await t.mutation(internal.automationsEngine.createRun, {
    accountId,
    automationId,
    contactId,
  });
  await t.run((ctx) => ctx.db.patch(cancelledRunId, { status: "cancelled" }));
  await t.mutation(internal.automationsEngine.recordRunFailure, {
    runId: cancelledRunId,
    errorMessage: "should never apply",
  });
  const cancelledRun = await t.run((ctx) => ctx.db.get(cancelledRunId));
  expect(cancelledRun?.errorMessage).toBeUndefined();

  // On a still-running run, the FIRST recorded failure sticks — a
  // second, different one arriving later must not overwrite it.
  const runId = await t.mutation(internal.automationsEngine.createRun, {
    accountId,
    automationId,
    contactId,
  });
  await t.mutation(internal.automationsEngine.recordRunFailure, {
    runId,
    errorMessage: "first failure",
  });
  await t.mutation(internal.automationsEngine.recordRunFailure, {
    runId,
    errorMessage: "second failure",
  });
  const run = await t.run((ctx) => ctx.db.get(runId));
  expect(run?.errorMessage).toBe("first failure");
  expect(run?.status).toBe("running");
});

test("time_of_day falls back to UTC when the account has no qualification config", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "NoConfig");
  const { contactId } = await seedContactAndConversation(t, accountId, "15551234568");

  const originalTz = process.env.TZ;
  process.env.TZ = "UTC";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-09T15:00:00Z"));
  try {
    const automationId = await seedAutomation(t, {
      accountId,
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["hi"], match_type: "contains" },
    });
    await seedStep(t, {
      accountId,
      automationId,
      stepType: "condition",
      stepConfig: { subject: "time_of_day", operand: "18:00-09:00" },
      position: 0,
    });

    await t.action(internal.automationsEngine.runForTrigger, {
      accountId,
      triggerType: "keyword_match",
      contactId,
      context: { messageText: "hi" },
    });

    const logs = await t.run((ctx) =>
      ctx.db.query("automationLogs").withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.stepsExecuted[0]!.detail).toBe("branch=no");
  } finally {
    vi.useRealTimers();
    restoreTz(originalTz);
  }
});

// ============================================================
// Task 4: waits persist as `automationRuns` rows and become
// cancellable. Required behaviours:
//   1. A `wait` parks the run: status "waiting", resumeAt,
//      scheduledFnId, currentStepKey, and the suspension tuple.
//   2. Resuming clears the wait bookkeeping and completes the run.
//   3. A wait nested in a condition branch parks with that branch
//      recorded.
//   4. A cancelled run must not restart: `markRunRunning` returns
//      false and `resume` returns without executing anything.
//   5. Two independently-suspended branches produce exactly ONE
//      terminal write, and `endedAt` does not move on the other
//      branch's resume.
// ============================================================

test("a wait step parks the run with a resumeAt and a scheduled function id", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "WaitParks");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002020");
  const tagId = await seedTag(t, accountId, "later");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
  });
  const waitStepId = await seedStep(t, {
    accountId,
    automationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "hours" },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "add_tag",
    stepConfig: { tag_id: tagId },
    position: 1,
  });

  const before = Date.now();
  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "remind me later" },
  });

  const run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("waiting");
  expect(run?.resumeAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
  expect(run?.scheduledFnId).toBeTruthy();
  expect(run?.nextPosition).toBe(1);
  // `seedStep` never mints a `stepKey` (Task 10's key-minting only
  // happens through the real builder-save path), so the engine's
  // documented fallback applies: the step's own row id.
  expect(run?.currentStepKey).toBe(waitStepId);
});

test("resuming clears the wait bookkeeping and completes the run", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "WaitBookkeeping");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002121");
  const tagId = await seedTag(t, accountId, "done");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "add_tag",
    stepConfig: { tag_id: tagId },
    position: 1,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "remind me later" },
  });

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("completed");
  expect(run?.resumeAt).toBeUndefined();
  expect(run?.scheduledFnId).toBeUndefined();

  vi.useRealTimers();
});

test("a wait nested in a condition branch parks with that branch recorded", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "NestedWaitParks");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002222");
  const vipTagId = await seedTag(t, accountId, "vip");

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
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });

  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: vipTagId }));

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  const run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("waiting");
  expect(run?.parentStepId).toBe(conditionStepId);
  expect(run?.branch).toBe("yes");
});

// Behaviour 4: cancellation must actually stop a send, not merely
// relabel the row. Unit level first — `markRunRunning`'s own return
// value and guard, the same style as the existing direct `finishRun`/
// `recordRunFailure` guard tests above.
test("markRunRunning refuses to restart an already-cancelled run, but flips a live one back to running", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "MarkRunning");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002323");
  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });

  const cancelledRunId = await t.mutation(internal.automationsEngine.createRun, {
    accountId,
    automationId,
    contactId,
  });
  await t.run((ctx) => ctx.db.patch(cancelledRunId, { status: "cancelled" }));
  const cancelledResult = await t.mutation(internal.automationsEngine.markRunRunning, {
    runId: cancelledRunId,
  });
  expect(cancelledResult).toBe(false);
  const cancelledRun = await t.run((ctx) => ctx.db.get(cancelledRunId));
  expect(cancelledRun?.status).toBe("cancelled");

  const waitingRunId = await t.mutation(internal.automationsEngine.createRun, {
    accountId,
    automationId,
    contactId,
  });
  await t.run((ctx) =>
    ctx.db.patch(waitingRunId, { status: "waiting", resumeAt: Date.now() + 60_000 }),
  );
  const liveResult = await t.mutation(internal.automationsEngine.markRunRunning, {
    runId: waitingRunId,
  });
  expect(liveResult).toBe(true);
  const liveRun = await t.run((ctx) => ctx.db.get(waitingRunId));
  expect(liveRun?.status).toBe("running");
  expect(liveRun?.resumeAt).toBeUndefined();
});

// Behaviour 4, integration level: an already-scheduled resume for a run
// that gets cancelled in the meantime must execute nothing. Deliberately
// does NOT also cancel the scheduled function itself (no `cancelRun`
// mutation exists yet for Task 5 to call) — the point is that the row's
// OWN status, not whether `ctx.scheduler.cancel` "won" the race, is what
// stops the send. Mirrors the existing "finishRun refuses to resurrect
// an already-cancelled run" test's own justification for simulating the
// cancellation transition with a direct patch.
test("a cancelled run's already-scheduled resume executes nothing", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "CancelledResume");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002424");
  const tagId = await seedTag(t, accountId, "post-wait");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "add_tag",
    stepConfig: { tag_id: tagId },
    position: 1,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "remind me later" },
  });

  const parkedRun = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(parkedRun?.status).toBe("waiting");
  const runId = parkedRun!._id;

  // Simulate Task 5's own cancellation transition directly (no
  // `cancelRun` mutation exists yet to call).
  await t.run((ctx) => ctx.db.patch(runId, { status: "cancelled" }));

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await tagLink(t, contactId, tagId)).toBeNull();
  const finalRun = await t.run((ctx) => ctx.db.get(runId));
  expect(finalRun?.status).toBe("cancelled");

  vi.useRealTimers();
});

// Re-review residual (2026-08): the `isActive` gate (added earlier in
// this fix wave) sat BEFORE `markRunRunning`'s cancelled-run guard, so
// a run that is ALREADY cancelled while its automation is ALSO
// inactive still had its LOG relabelled `partial -> failed` by the
// `isActive` gate before the cancelled-run guard ever got a chance to
// short-circuit -- `appendLogResults` patches unconditionally, with no
// status check of its own. The RUN itself stayed safe regardless
// (`finishRun` refuses an already-cancelled run), but this contradicts
// the cancelled-run guard's own documented contract just above: "a
// cancelled run must do nothing further at all, not even append a
// do-not-contact log entry." The `isActive` gate's own comment claimed
// to mirror the do-not-contact gate, but sat on the WRONG side of that
// guard to actually do so. Fixed by moving the `isActive` gate to the
// do-not-contact gate's own position, after `markRunRunning`.
test("a cancelled run whose automation is also inactive leaves both the run and its log untouched", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "CancelledAndInactive");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550003335");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "add_tag",
    stepConfig: { tag_id: "unused" },
    position: 1,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "remind me later" },
  });

  const parkedRun = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(parkedRun?.status).toBe("waiting");
  const runId = parkedRun!._id;
  const logId = parkedRun!.logId!;

  const logBefore = await t.run((ctx) => ctx.db.get(logId));
  expect(logBefore?.status).toBe("partial");

  // Both conditions the residual is about, at once: the run is
  // cancelled AND its automation is deactivated -- the narrow window a
  // cancellation racing an already-dequeued resume produces
  // (`cancelOne` cancels the scheduled function, but a resume that had
  // already started dequeuing can still land; this simulates that by
  // leaving the scheduled resume itself untouched).
  await t.run((ctx) => ctx.db.patch(runId, { status: "cancelled" }));
  await t.run((ctx) => ctx.db.patch(automationId, { isActive: false }));

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const finalRun = await t.run((ctx) => ctx.db.get(runId));
  expect(finalRun?.status).toBe("cancelled");
  expect(finalRun?.endedAt).toBeUndefined();

  // The residual itself: the log must ALSO stay untouched, not
  // relabelled partial -> failed by the isActive gate firing before
  // the cancelled-run guard gets a chance to short-circuit.
  const logAfter = await t.run((ctx) => ctx.db.get(logId));
  expect(logAfter?.status).toBe("partial");
  expect(logAfter?.errorMessage).toBeUndefined();

  vi.useRealTimers();
});

// Behaviour 5: two independently-suspended branches must produce
// exactly ONE terminal write. Uses two different wait durations so the
// two resumes can be resolved one at a time and the run's state
// inspected strictly BETWEEN them — the existing "two independently
// suspended branches converge on the failure" test (Task 3) only
// inspects the FINAL state after draining both, which can't distinguish
// "one write" from "two writes that happen to converge on the same
// answer." Fires only the first, shorter wait via `advanceTimersByTime`
// + `finishInProgressScheduledFunctions` — NOT
// `finishAllScheduledFunctions`, which would drain both — mirroring
// `flowsEngine.test.ts`'s/`qualificationEngine.test.ts`'s own documented
// use of that pairing for the identical "resolve one scheduled step,
// not everything pending" reason.
test("two independently-suspended branches produce exactly one terminal write", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "OneTerminalWrite");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002525");
  const tagA = await seedTag(t, accountId, "segment-a");
  const tagB = await seedTag(t, accountId, "segment-b");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  const conditionAId = await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "tag_presence", operand: tagA },
    position: 0,
  });
  // Resolves first: a short wait.
  await seedStep(t, {
    accountId,
    automationId,
    parentStepId: conditionAId,
    branch: "yes",
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });
  const conditionBId = await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "tag_presence", operand: tagB },
    position: 1,
  });
  // Resolves independently, much later — stays pending while branch A
  // above is drained.
  await seedStep(t, {
    accountId,
    automationId,
    parentStepId: conditionBId,
    branch: "yes",
    stepType: "wait",
    stepConfig: { amount: 10, unit: "minutes" },
    position: 0,
  });

  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: tagA }));
  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: tagB }));

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  const dispatched = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  const runId = dispatched!._id;
  expect(dispatched?.status).toBe("waiting");
  expect(dispatched?.endedAt).toBeUndefined();

  // Resolve ONLY branch A's shorter (1-minute) wait — branch B's
  // 10-minute wait is nowhere near due yet.
  vi.advanceTimersByTime(2 * 60 * 1000);
  await t.finishInProgressScheduledFunctions();

  // Branch A's own subtree finished cleanly (nothing left in it), but
  // branch B is still outstanding — the run must NOT be finalized yet.
  let run = await t.run((ctx) => ctx.db.get(runId));
  expect(run?.status).not.toBe("completed");
  expect(run?.status).not.toBe("failed");
  expect(run?.endedAt).toBeUndefined();
  expect(run?.outstandingBranches).toBe(1);

  // Now resolve branch B's wait too.
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  // Exactly one terminal write: NOW, and only now, the run is finalized.
  run = await t.run((ctx) => ctx.db.get(runId));
  expect(run?.status).toBe("completed");
  expect(run?.endedAt).toBeGreaterThan(0);
  expect(run?.outstandingBranches).toBe(0);

  vi.useRealTimers();
});

// Behaviour 5, direct: a straggler `finishRun` call arriving after the
// run has already closed must not move `endedAt` (or flip the outcome).
// Same guarantee as the test above, isolated from the scheduler/timer
// machinery so it also pins the `finishRun` guard directly — the same
// way the existing "finishRun refuses to resurrect an already-cancelled
// run" test does for cancellation.
test("finishRun does not move endedAt on a redundant call after the run is already terminal", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "RedundantFinish");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002626");
  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });

  const runId = await t.mutation(internal.automationsEngine.createRun, {
    accountId,
    automationId,
    contactId,
  });

  await t.mutation(internal.automationsEngine.finishRun, {
    runId,
    status: "completed",
    errorMessage: undefined,
  });
  const firstFinish = await t.run((ctx) => ctx.db.get(runId));
  expect(firstFinish?.status).toBe("completed");
  const endedAt = firstFinish?.endedAt;
  expect(endedAt).toBeGreaterThan(0);

  // A second, redundant `finishRun` call for the SAME run — the shape a
  // straggler branch resuming after the run already closed would take —
  // must not move `endedAt` or flip the outcome.
  await t.mutation(internal.automationsEngine.finishRun, {
    runId,
    status: "failed",
    errorMessage: "should never apply",
  });
  const secondFinish = await t.run((ctx) => ctx.db.get(runId));
  expect(secondFinish?.status).toBe("completed");
  expect(secondFinish?.endedAt).toBe(endedAt);
  expect(secondFinish?.errorMessage).toBeUndefined();
});

// Fix round (post-review): the do-not-contact-during-wait short-circuit
// flips the run to "running" via `markRunRunning` (which does not touch
// `outstandingBranches` — see `finishRun`'s own comment for why) and then
// returns WITHOUT ever calling `finishRun`/`recordRunFailure`. That
// branch's own suspension is never accounted for, so `outstandingBranches`
// can never reach zero and the run is stranded at "running" forever —
// invisible to any `status === "waiting"` query (including
// `by_account_contact_status`, whose own schema comment says it exists so
// doNotContact/stopOnReply can ask "which of this contact's runs are
// still waiting") and unreachable by any later cancellation or waiting-
// counts logic that keys off `status`. Before the `outstandingBranches`
// gate existed (pre-Task-4), the SAME short-circuit still let a
// surviving sibling's own unconditional `finishRun` call close the run
// out (silently dropping this branch's fate, but reaching a terminal
// state) — the counter turns "closes with a dropped branch" into "never
// terminates at all".
test("a do-not-contact flag during a wait still reaches a terminal state, not a permanently stranded run", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "DncStrandsRun");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002727");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_message",
    stepConfig: { text: "Following up!" },
    position: 1,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "remind me later" },
  });

  const parkedRun = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(parkedRun?.status).toBe("waiting");
  expect(parkedRun?.outstandingBranches).toBe(1);
  const runId = parkedRun!._id;

  // An agent flags this contact do-not-contact WHILE the wait is still
  // pending — the exact window `runForTrigger`'s own dispatch-time gate
  // (checked before the wait even started) cannot cover.
  await markDoNotContact(t, accountId, contactId);

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const run = await t.run((ctx) => ctx.db.get(runId));
  // Must reach a terminal state, not be stranded at "running" forever
  // with a phantom outstanding branch.
  expect(run?.status).toBe("failed");
  expect(run?.errorMessage).toMatch(/do_not_contact/);
  expect(run?.outstandingBranches).toBe(0);
  expect(run?.endedAt).toBeGreaterThan(0);

  vi.useRealTimers();
});

// Two-branch variant: this is the shape that strands the WHOLE run, not
// just one branch's own accounting — with the count starting at 2, BOTH
// independently-scheduled resumes must each account for their own branch
// (both hit the do-not-contact gate, since the flag persists across both)
// before the run can ever reach zero.
test("a do-not-contact flag during two independently-suspended waits still reaches a terminal state", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "DncStrandsTwoBranches");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002828");
  const tagA = await seedTag(t, accountId, "segment-a");
  const tagB = await seedTag(t, accountId, "segment-b");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  const conditionAId = await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "tag_presence", operand: tagA },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    parentStepId: conditionAId,
    branch: "yes",
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });
  const conditionBId = await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "tag_presence", operand: tagB },
    position: 1,
  });
  await seedStep(t, {
    accountId,
    automationId,
    parentStepId: conditionBId,
    branch: "yes",
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });

  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: tagA }));
  await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: tagB }));

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  const dispatched = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(dispatched?.outstandingBranches).toBe(2);
  const runId = dispatched!._id;

  // Flagged before EITHER resume fires — both independent resumes will
  // hit the do-not-contact gate.
  await markDoNotContact(t, accountId, contactId);

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const run = await t.run((ctx) => ctx.db.get(runId));
  expect(run?.status).toBe("failed");
  expect(run?.errorMessage).toMatch(/do_not_contact/);
  expect(run?.outstandingBranches).toBe(0);
  expect(run?.endedAt).toBeGreaterThan(0);

  vi.useRealTimers();
});

// ============================================================
// Fix wave (2026-08): `outstandingBranches` double-counted a
// re-suspending branch. `markRunWaiting` incremented unconditionally on
// every wait, but `finishRun` (the only decrement) was only reachable
// once a call's OWN scope ran to completion without hitting another
// wait — a branch that resumes and immediately re-suspends on a SECOND
// wait returns early (see the `wait` case's own `return true`) and never
// reaches that decrement. Two sequential waits: +1, +1, one eventual -1
// -> stranded at 1. Three: +1,+1,+1, one -1 -> stranded at 2. The run
// never reaches a terminal status, which is exactly the shape of the
// owner's own live automation (`Wait 1m -> Send -> Wait 1m -> Send ->
// Wait 1m -> Send Template`). Never tested before — the existing
// fan-out tests above (two INDEPENDENT branches suspending once each)
// happen to net out correctly under the old code, which is why this
// shape shipped uncaught.
// ============================================================

test("sequential waits: two waits in the same lineage still reach a terminal status, not stranded running", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "SequentialWaitsTwo");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002930");
  const tagId = await seedTag(t, accountId, "touched-twice");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, { accountId, automationId, stepType: "wait", stepConfig: { amount: 1, unit: "minutes" }, position: 0 });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: tagId }, position: 1 });
  await seedStep(t, { accountId, automationId, stepType: "wait", stepConfig: { amount: 1, unit: "minutes" }, position: 2 });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: tagId }, position: 3 });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  const dispatched = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  const runId = dispatched!._id;
  expect(dispatched?.status).toBe("waiting");

  // Drains BOTH waits in sequence: dispatch -> wait #1 -> resume #1
  // (runs add_tag, hits wait #2) -> resume #2 (runs add_tag, completes).
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const run = await t.run((ctx) => ctx.db.get(runId));
  expect(run?.status).toBe("completed");
  expect(run?.outstandingBranches).toBe(0);
  expect(run?.endedAt).toBeGreaterThan(0);

  vi.useRealTimers();
});

test("sequential waits: three waits in the same lineage still reach a terminal status, not stranded running", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "SequentialWaitsThree");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002931");
  const tagId = await seedTag(t, accountId, "touched-thrice");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, { accountId, automationId, stepType: "wait", stepConfig: { amount: 1, unit: "minutes" }, position: 0 });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: tagId }, position: 1 });
  await seedStep(t, { accountId, automationId, stepType: "wait", stepConfig: { amount: 1, unit: "minutes" }, position: 2 });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: tagId }, position: 3 });
  await seedStep(t, { accountId, automationId, stepType: "wait", stepConfig: { amount: 1, unit: "minutes" }, position: 4 });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: tagId }, position: 5 });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  const dispatched = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  const runId = dispatched!._id;
  expect(dispatched?.status).toBe("waiting");

  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const run = await t.run((ctx) => ctx.db.get(runId));
  expect(run?.status).toBe("completed");
  expect(run?.outstandingBranches).toBe(0);
  expect(run?.endedAt).toBeGreaterThan(0);

  vi.useRealTimers();
});

// A single wait must still read outstandingBranches: 1 while parked —
// not 0 — since exactly one resume is genuinely live. Pins the seeded
// baseline directly rather than only checking the eventual terminal
// state (the two tests above), so a regression that under-counts a
// lone wait (e.g. forgetting to seed `createRun` at 1) fails here even
// though it would still coincidentally reach "completed" once resumed.
test("a single wait reads outstandingBranches: 1 while parked, matching the 'live scheduled resumes' invariant", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "SingleWaitCount");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550002932");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"], match_type: "contains" },
  });
  await seedStep(t, { accountId, automationId, stepType: "wait", stepConfig: { amount: 1, unit: "minutes" }, position: 0 });
  await seedStep(t, { accountId, automationId, stepType: "add_tag", stepConfig: { tag_id: "unused" }, position: 1 });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "hi" },
  });

  const run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("waiting");
  expect(run?.outstandingBranches).toBe(1);
});

// ============================================================
// Task 5 — cancelRunsForAutomation / cancelRunsForContact / cancelOne.
// The five cancellation call sites (setActive/remove/update,
// contactNotes' do-not-contact writes, ingest's stopOnReply-on-reply
// dispatch) are wired and tested where they live (automations.test.ts,
// contactNotes.test.ts, ingest.test.ts respectively); this suite covers
// the shared engine-level mutations directly.
// ============================================================

test("cancelRunsForAutomation cancels every waiting run for that automation in one batch", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "CancelAll");
  const { contactId: contactA } = await seedContactAndConversation(t, accountId, "15550003001");
  const { contactId: contactB } = await seedContactAndConversation(t, accountId, "15550003002");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "hours" },
    position: 0,
  });

  for (const contactId of [contactA, contactB]) {
    await t.action(internal.automationsEngine.runForTrigger, {
      accountId,
      triggerType: "keyword_match",
      contactId,
      context: { messageText: "remind me" },
    });
  }

  const runsBefore = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .collect(),
  );
  expect(runsBefore).toHaveLength(2);
  expect(runsBefore.every((r) => r.status === "waiting")).toBe(true);

  const result = await t.mutation(internal.automationsEngine.cancelRunsForAutomation, {
    accountId,
    automationId,
    reason: "automation deactivated",
  });
  expect(result).toEqual({ cancelled: 2, done: true });

  const runsAfter = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .collect(),
  );
  expect(runsAfter).toHaveLength(2);
  for (const run of runsAfter) {
    expect(run.status).toBe("cancelled");
    expect(run.errorMessage).toBe("automation deactivated");
    expect(run.resumeAt).toBeUndefined();
    expect(run.scheduledFnId).toBeUndefined();
    expect(run.endedAt).toBeGreaterThan(0);
  }
});

// The single most important test in this task: a cancelled run's
// ALREADY-SCHEDULED resume must produce ZERO outbound sends — not
// merely leave the row reading "cancelled". DRY-RUN send_message
// persists a `messages` row on a real send (see the "send_message step
// persists a bot message in DRY-RUN" test above); this asserts NO such
// row ever appears once the wait fires after cancellation.
test("cancelRunsForAutomation stops a parked run's own scheduled resume from ever sending", async () => {
  vi.useFakeTimers();
  try {
    process.env.CONVEX_META_DRY_RUN = "1";
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t, "ZeroSends");
    const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15550003030");
    await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

    const automationId = await seedAutomation(t, {
      accountId,
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
    });
    await seedStep(t, {
      accountId,
      automationId,
      stepType: "wait",
      stepConfig: { amount: 1, unit: "minutes" },
      position: 0,
    });
    await seedStep(t, {
      accountId,
      automationId,
      stepType: "send_message",
      stepConfig: { text: "Following up on your request!" },
      position: 1,
    });

    await t.action(internal.automationsEngine.runForTrigger, {
      accountId,
      triggerType: "keyword_match",
      contactId,
      context: { messageText: "remind me later", conversationId },
    });

    const parked = await t.run((ctx) =>
      ctx.db
        .query("automationRuns")
        .withIndex("by_account_automation", (q) =>
          q.eq("accountId", accountId).eq("automationId", automationId),
        )
        .unique(),
    );
    expect(parked?.status).toBe("waiting");
    expect(parked?.scheduledFnId).toBeTruthy();

    await t.mutation(internal.automationsEngine.cancelRunsForAutomation, {
      accountId,
      automationId,
      reason: "automation deactivated",
    });

    // Let the already-scheduled resume actually fire. Before this
    // mutation existed, this is exactly what sent a message to the
    // customer after the automation had been deactivated.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .collect(),
    );
    expect(messages).toHaveLength(0);

    const finalRun = await t.run((ctx) => ctx.db.get(parked!._id));
    expect(finalRun?.status).toBe("cancelled");
  } finally {
    vi.useRealTimers();
  }
});

test("cancelRunsForAutomation batches: a full page reschedules itself and drains the overflow", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t, "CancelBatches");
    const automationId = await seedAutomation(t, { accountId, triggerType: "keyword_match" });

    // Direct inserts, no `scheduledFnId` — this test is about the batch
    // mechanism's row count, not the scheduler-cancel side effect (the
    // previous test already covers that), mirroring
    // `automations.test.ts`'s own `seedManyLogs`/log-overflow tests.
    const overflow = 10;
    const total = RUN_CANCEL_BATCH + overflow;
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i++) {
        const phone = `15551110${String(i).padStart(4, "0")}`;
        const contactId = await ctx.db.insert("contacts", {
          accountId,
          phone,
          phoneNormalized: phone,
        });
        await ctx.db.insert("automationRuns", {
          accountId,
          automationId,
          contactId,
          status: "waiting",
          nextPosition: 1,
          resumeAt: Date.now() + 60_000,
          startedAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });

    const first = await t.mutation(internal.automationsEngine.cancelRunsForAutomation, {
      accountId,
      automationId,
      reason: "automation deleted",
    });
    expect(first).toEqual({ cancelled: RUN_CANCEL_BATCH, done: false });

    const countCancelled = () =>
      t.run(async (ctx) =>
        (
          await ctx.db
            .query("automationRuns")
            .withIndex("by_account_automation_status", (q) =>
              q.eq("accountId", accountId).eq("automationId", automationId).eq("status", "cancelled"),
            )
            .collect()
        ).length,
      );
    expect(await countCancelled()).toBe(RUN_CANCEL_BATCH);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await countCancelled()).toBe(total);
  } finally {
    vi.useRealTimers();
  }
});

// Behaviour 6 (Task 5): the multi-branch status ambiguity Task 4's
// review flagged. Between the first and last branch's resume, the
// run's own `status` field reflects only the most-recently-suspended
// branch (see `markRunWaiting`'s comment) — so a run with one branch
// already resumed and one still genuinely parked can read
// `status: "running"`, not "waiting". `outstandingBranches` stays
// correct through that overwrite (incremented by every
// `markRunWaiting`, decremented only by `finishRun`), so
// `cancelRunsForAutomation` also treats "running" rows with a
// nonzero `outstandingBranches` as cancellable.
test("cancelRunsForAutomation also catches a run whose status reads running while a sibling branch is still outstanding", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t, "MultiBranchCancel");
    const { contactId } = await seedContactAndConversation(t, accountId, "15550003131");
    const tagA = await seedTag(t, accountId, "segment-a");
    const tagB = await seedTag(t, accountId, "segment-b");
    const followupB = await seedTag(t, accountId, "segment-b-followup");

    const automationId = await seedAutomation(t, {
      accountId,
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["hi"], match_type: "contains" },
    });
    const conditionAId = await seedStep(t, {
      accountId,
      automationId,
      stepType: "condition",
      stepConfig: { subject: "tag_presence", operand: tagA },
      position: 0,
    });
    await seedStep(t, {
      accountId,
      automationId,
      parentStepId: conditionAId,
      branch: "yes",
      stepType: "wait",
      stepConfig: { amount: 1, unit: "minutes" },
      position: 0,
    });
    const conditionBId = await seedStep(t, {
      accountId,
      automationId,
      stepType: "condition",
      stepConfig: { subject: "tag_presence", operand: tagB },
      position: 1,
    });
    await seedStep(t, {
      accountId,
      automationId,
      parentStepId: conditionBId,
      branch: "yes",
      stepType: "wait",
      stepConfig: { amount: 10, unit: "minutes" },
      position: 0,
    });
    await seedStep(t, {
      accountId,
      automationId,
      parentStepId: conditionBId,
      branch: "yes",
      stepType: "add_tag",
      stepConfig: { tag_id: followupB },
      position: 1,
    });

    await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: tagA }));
    await t.run((ctx) => ctx.db.insert("contactTags", { accountId, contactId, tagId: tagB }));

    await t.action(internal.automationsEngine.runForTrigger, {
      accountId,
      triggerType: "keyword_match",
      contactId,
      context: { messageText: "hi" },
    });

    const dispatched = await t.run((ctx) =>
      ctx.db
        .query("automationRuns")
        .withIndex("by_account_automation", (q) =>
          q.eq("accountId", accountId).eq("automationId", automationId),
        )
        .unique(),
    );
    const runId = dispatched!._id;

    // Resolve ONLY branch A's shorter wait — branch B stays parked.
    vi.advanceTimersByTime(2 * 60 * 1000);
    await t.finishInProgressScheduledFunctions();

    const midFlight = await t.run((ctx) => ctx.db.get(runId));
    // The hazard this test pins down: the row's OWN `status` now
    // reflects branch A's resume, not branch B's still-live wait.
    expect(midFlight?.status).toBe("running");
    expect(midFlight?.outstandingBranches).toBe(1);

    const result = await t.mutation(internal.automationsEngine.cancelRunsForAutomation, {
      accountId,
      automationId,
      reason: "automation deactivated",
    });
    expect(result.cancelled).toBe(1);

    const cancelled = await t.run((ctx) => ctx.db.get(runId));
    expect(cancelled?.status).toBe("cancelled");

    // Branch B's wait now fires. If it had slipped past cancellation,
    // this would apply `followupB` to the contact.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await tagLink(t, contactId, followupB)).toBeNull();

    const finalRun = await t.run((ctx) => ctx.db.get(runId));
    expect(finalRun?.status).toBe("cancelled");
  } finally {
    vi.useRealTimers();
  }
});

test("cancelRunsForContact without onlyStopOnReply cancels every one of that contact's waiting runs", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "DncCancelsAll");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550003333");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["a"], match_type: "contains" },
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "hours" },
    position: 0,
  });
  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "a" },
  });

  const result = await t.mutation(internal.automationsEngine.cancelRunsForContact, {
    accountId,
    contactId,
    reason: "contact opted out",
  });
  expect(result).toEqual({ cancelled: 1 });

  const run = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .unique(),
  );
  expect(run?.status).toBe("cancelled");
  expect(run?.errorMessage).toBe("contact opted out");
});

test("cancelRunsForContact with onlyStopOnReply cancels only runs whose automation opted in", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "StopOnReplyFilter");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550003232");

  const stopAutomationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["a"], match_type: "contains" },
    name: "Stops on reply",
  });
  await t.run((ctx) => ctx.db.patch(stopAutomationId, { stopOnReply: true }));
  await seedStep(t, {
    accountId,
    automationId: stopAutomationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "hours" },
    position: 0,
  });

  const plainAutomationId = await seedAutomation(t, {
    accountId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["b"], match_type: "contains" },
    name: "Does not stop",
  });
  await seedStep(t, {
    accountId,
    automationId: plainAutomationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "hours" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "a" },
  });
  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "keyword_match",
    contactId,
    context: { messageText: "b" },
  });

  const result = await t.mutation(internal.automationsEngine.cancelRunsForContact, {
    accountId,
    contactId,
    reason: "contact replied",
    onlyStopOnReply: true,
  });
  expect(result).toEqual({ cancelled: 1 });

  const stillWaiting = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_contact_status", (q) =>
        q.eq("accountId", accountId).eq("contactId", contactId).eq("status", "waiting"),
      )
      .collect(),
  );
  expect(stillWaiting).toHaveLength(1);
  expect(stillWaiting[0]!.automationId).toBe(plainAutomationId);

  const cancelledRuns = await t.run((ctx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_contact_status", (q) =>
        q.eq("accountId", accountId).eq("contactId", contactId).eq("status", "cancelled"),
      )
      .collect(),
  );
  expect(cancelledRuns).toHaveLength(1);
  expect(cancelledRuns[0]!.automationId).toBe(stopAutomationId);
});

// ============================================================
// automationStepStats — Task 6: cumulative per-step reached/sent/failed
// counters, written inside appendLogResults's own transaction (so a
// step can never be logged without being counted) and keyed on
// `automationSteps.stepKey`, NOT the step row's `_id`. `replaceSteps`
// (convex/automations.ts) deletes and reinserts every step row on
// every builder save — even a rename-only one — so a counter keyed on
// the row id would silently reset to zero on the next edit. `stepKey`
// is the stable identity Task 10 minted precisely to survive that
// churn; the last test below proves it does for these counters too.
// ============================================================

test("each executed step increments its own reached and sent counters", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Counters");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550009001");
  const tagA = await seedTag(t, accountId, "counters-a");
  const tagB = await seedTag(t, accountId, "counters-b");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "new_message_received",
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "add_tag",
    stepConfig: { tag_id: tagA },
    position: 0,
  });
  await seedStep(t, {
    accountId,
    automationId,
    stepType: "add_tag",
    stepConfig: { tag_id: tagB },
    position: 1,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "new_message_received",
    contactId,
    context: {},
  });
  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "new_message_received",
    contactId,
    context: {},
  });

  const stats = await t.run((ctx) =>
    ctx.db
      .query("automationStepStats")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .collect(),
  );
  expect(stats).toHaveLength(2);
  for (const s of stats) {
    expect(s.reached).toBe(2);
    expect(s.sent).toBe(2);
    expect(s.failed).toBe(0);
  }
});

test("a failed step increments reached and failed but not sent", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "FailCounters");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550009002");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "new_message_received",
  });
  // `seedStep` inserts the row directly, bypassing `insertStepsTree` —
  // it never mints a `stepKey`, exactly like a real row saved before
  // Task 10. The counter's `stepKey ?? _id` fallback means this step's
  // stats land keyed on its row id, `stepId`.
  const stepId = await seedStep(t, {
    accountId,
    automationId,
    stepType: "send_webhook",
    stepConfig: { url: "http://127.0.0.1/hook" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "new_message_received",
    contactId,
    context: {},
  });

  const stat = await t.run((ctx) =>
    ctx.db
      .query("automationStepStats")
      .withIndex("by_account_step_key", (q) =>
        q.eq("accountId", accountId).eq("stepKey", stepId),
      )
      .unique(),
  );
  expect(stat?.reached).toBe(1);
  expect(stat?.sent).toBe(0);
  expect(stat?.failed).toBe(1);
});

test("counters survive a save that rewrites every step row's id", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, "SaveCounters");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550009003");
  const tagId = await seedTag(t, accountId, "save-counters");
  // A second tag so the update below is a GENUINE structural change —
  // see this test's own comment just below.
  const tagId2 = await seedTag(t, accountId, "save-counters-2");

  const automationId = await asUser.mutation(api.automations.create, {
    name: "Survives a save",
    triggerType: "new_message_received",
    isActive: true,
    steps: [{ step_type: "add_tag", step_config: { tag_id: tagId } }],
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "new_message_received",
    contactId,
    context: {},
  });

  const before = await t.run((ctx) => ctx.db.query("automationSteps").collect());
  expect(before).toHaveLength(1);
  const stepKey = before[0]!.stepKey;
  expect(typeof stepKey).toBe("string");

  // A real edit (the tag actually applied changes) still sends the
  // WHOLE steps array, which `replaceSteps` implements as
  // delete-then-reinsert (convex/automations.ts) — the exact row-id
  // churn `stepKey` exists to survive. Round-tripping the step's own
  // `stepKey` as `id` (the builder's own `toApiSteps` pattern — see
  // `automations.test.ts`'s "a step's key survives a save" test) is
  // what keeps it stable across this save. Deliberately NOT a
  // byte-for-byte-identical resend: the fix-wave `stepsTreeEqual` guard
  // (finding 3) now skips `replaceSteps` entirely for a genuinely
  // unchanged tree — see `automations.test.ts`'s "leaves waiting runs
  // alone on a rename-only save" test for that guarantee — so this test
  // needs a REAL change to keep exercising the churn this one is about.
  await asUser.mutation(api.automations.update, {
    automationId,
    name: "Survives a save (renamed)",
    steps: [{ id: stepKey, step_type: "add_tag", step_config: { tag_id: tagId2 } }],
  });

  const after = await t.run((ctx) => ctx.db.query("automationSteps").collect());
  expect(after).toHaveLength(1);
  expect(after[0]!.stepKey).toBe(stepKey);
  // Proves the save genuinely churned the row rather than no-op'ing.
  expect(after[0]!._id).not.toBe(before[0]!._id);

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "new_message_received",
    contactId,
    context: {},
  });

  const stats = await t.run((ctx) =>
    ctx.db
      .query("automationStepStats")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", accountId).eq("automationId", automationId),
      )
      .collect(),
  );
  // One row, not two: both runs' counts landed on the SAME stepKey
  // despite the step row's _id changing in between.
  expect(stats).toHaveLength(1);
  expect(stats[0]!.stepKey).toBe(stepKey);
  expect(stats[0]!.reached).toBe(2);
  expect(stats[0]!.sent).toBe(2);
  expect(stats[0]!.failed).toBe(0);
});

// The `wait` and `condition` cases each push their own `results` entry
// with the same `stepKey ?? step._id` idiom as the two cases above
// (`runStep`'s success/failure paths), but — per the ledger — were never
// directly exercised here. Sitting on finding 1's own path (the `wait`
// case's `markRunWaiting` call was just touched by this fix wave), so
// covered now rather than left another round.
test("a wait step with no stored stepKey counts its stats under its own row id", async () => {
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "WaitFallbackKey");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550009004");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "new_message_received",
  });
  // `seedStep` inserts directly, bypassing `insertStepsTree` — never
  // mints a `stepKey`, exactly like a real row saved before Task 10.
  const waitStepId = await seedStep(t, {
    accountId,
    automationId,
    stepType: "wait",
    stepConfig: { amount: 1, unit: "minutes" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "new_message_received",
    contactId,
    context: {},
  });

  const stat = await t.run((ctx) =>
    ctx.db
      .query("automationStepStats")
      .withIndex("by_account_step_key", (q) =>
        q.eq("accountId", accountId).eq("stepKey", waitStepId),
      )
      .unique(),
  );
  expect(stat?.reached).toBe(1);
  expect(stat?.sent).toBe(1);
  expect(stat?.failed).toBe(0);

  vi.useRealTimers();
});

test("a condition step with no stored stepKey counts its stats under its own row id", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "ConditionFallbackKey");
  const { contactId } = await seedContactAndConversation(t, accountId, "15550009005");

  const automationId = await seedAutomation(t, {
    accountId,
    triggerType: "new_message_received",
  });
  const conditionStepId = await seedStep(t, {
    accountId,
    automationId,
    stepType: "condition",
    stepConfig: { subject: "tag_presence", operand: "nonexistent" },
    position: 0,
  });

  await t.action(internal.automationsEngine.runForTrigger, {
    accountId,
    triggerType: "new_message_received",
    contactId,
    context: {},
  });

  const stat = await t.run((ctx) =>
    ctx.db
      .query("automationStepStats")
      .withIndex("by_account_step_key", (q) =>
        q.eq("accountId", accountId).eq("stepKey", conditionStepId),
      )
      .unique(),
  );
  // A condition always records "success" (branch=yes or branch=no is
  // still a successful evaluation) — never "failed" on its own account.
  expect(stat?.reached).toBe(1);
  expect(stat?.sent).toBe(1);
  expect(stat?.failed).toBe(0);
});
