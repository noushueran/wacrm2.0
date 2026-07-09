/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute so it resolves identically regardless of which file
// imports it (mirrors the pattern from the Convex testing docs).
const modules = import.meta.glob("/convex/**/*.ts");

// ============================================================
// Schema-only smoke tests. Phase 1 adds tables in groups, task by task,
// with no queries/mutations until each vertical's own function-phase — so
// there's nothing in `api.*` to drive yet. Instead we exercise the schema
// directly through `t.run` + `ctx.db`, which still routes every insert
// through the same validators `defineTable`/`v` produce. Extend this file
// per task with 1-2 representative tables from that task's group.
// ============================================================

/** Seeds an account (+ its owner user) so tenant-scoped inserts have a
 * real `accountId` to reference. */
async function insertAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert("users", {
      name: "Priya",
      email: "priya@example.com",
    });
    return await ctx.db.insert("accounts", {
      name: "Priya's account",
      defaultCurrency: "USD",
      ownerUserId,
    });
  });
}

test("Task 1 — conversations + messages round-trip through the schema's validators", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);

  const contactId = await t.run(async (ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "+15551234567",
      phoneNormalized: "15551234567",
    }),
  );

  const conversationId = await t.run(async (ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
      // Optional AI columns (migrations 029 + 033) — set them here so the
      // fixup's new validators are actually exercised, not just skipped.
      aiAutoreplyDisabled: false,
      aiReplyCount: 0,
      aiHandoffSummary: "handed off: pricing question",
    }),
  );

  const messageId = await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "bot",
      contentType: "text",
      contentText: "Hi there",
      status: "delivered",
      aiGenerated: true, // migration 033 column
    }),
  );

  const conversation = await t.run(async (ctx) => ctx.db.get(conversationId));
  const message = await t.run(async (ctx) => ctx.db.get(messageId));

  expect(conversation).not.toBeNull();
  expect(conversation!.accountId).toBe(accountId);
  expect(conversation!.contactId).toBe(contactId);
  expect(conversation!.status).toBe("open");
  expect(conversation!.unreadCount).toBe(0);
  expect(conversation!.aiAutoreplyDisabled).toBe(false);
  expect(conversation!.aiReplyCount).toBe(0);
  expect(conversation!.aiHandoffSummary).toBe("handed off: pricing question");

  expect(message).not.toBeNull();
  expect(message!.accountId).toBe(accountId);
  expect(message!.conversationId).toBe(conversationId);
  expect(message!.senderType).toBe("bot");
  expect(message!.contentType).toBe("text");
  expect(message!.status).toBe("delivered");
  expect(message!.aiGenerated).toBe(true);

  // Also exercise the declared indexes, not just the field validators.
  const byConversation = await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", conversationId),
      )
      .collect(),
  );
  expect(byConversation.map((m) => m._id)).toEqual([messageId]);

  const byAccount = await t.run(async (ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(byAccount.map((c) => c._id)).toEqual([conversationId]);
});

test("Task 1 — an out-of-union value is rejected by the schema validator", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);
  const contactId = await t.run(async (ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "+15551234567",
      phoneNormalized: "15551234567",
    }),
  );

  await expect(
    t.run(async (ctx) =>
      ctx.db.insert("conversations", {
        accountId,
        contactId,
        // Not one of the `status` union's literals — proves the schema
        // rejects it rather than silently accepting any string.
        status: "not-a-real-status" as unknown as "open",
        unreadCount: 0,
      }),
    ),
  ).rejects.toThrow();
});

test("Task 2 — messageTemplates + apiKeys round-trip through the schema's validators", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);

  const templateId = await t.run(async (ctx) =>
    ctx.db.insert("messageTemplates", {
      accountId,
      name: "welcome",
      category: "Utility",
      language: "en_US",
      bodyText: "Hello {{1}}, welcome to {{2}}!",
      status: "APPROVED",
      // Typed `sampleValues` object (migration 014) — exercises the
      // nested v.object/v.array validators, not just a bare v.any().
      sampleValues: {
        body: ["Priya", "Acme"],
        header: ["Acme Support"],
      },
      metaTemplateId: "meta-template-123",
      qualityScore: "GREEN",
      headerHandle: "4::aW1hZ2U6cGxhY2Vob2xkZXI=",
      headerMediaUrl: "https://example.com/header.png",
      lastSubmittedAt: Date.now(),
    }),
  );

  const apiKeyId = await t.run(async (ctx) =>
    ctx.db.insert("apiKeys", {
      accountId,
      name: "CI integration",
      keyPrefix: "wacrm_live_a1b2c3d4",
      keyHash: "fixture-sha256-hash-of-the-plaintext-key",
      scopes: ["contacts:read", "messages:write"],
    }),
  );

  const template = await t.run(async (ctx) => ctx.db.get(templateId));
  const apiKey = await t.run(async (ctx) => ctx.db.get(apiKeyId));

  expect(template).not.toBeNull();
  expect(template!.accountId).toBe(accountId);
  expect(template!.category).toBe("Utility");
  expect(template!.status).toBe("APPROVED");
  expect(template!.sampleValues?.body).toEqual(["Priya", "Acme"]);
  expect(template!.sampleValues?.header).toEqual(["Acme Support"]);
  expect(template!.metaTemplateId).toBe("meta-template-123");
  expect(template!.headerMediaUrl).toBe("https://example.com/header.png");

  expect(apiKey).not.toBeNull();
  expect(apiKey!.accountId).toBe(accountId);
  expect(apiKey!.scopes).toEqual(["contacts:read", "messages:write"]);
  expect(apiKey!.keyHash).toBe("fixture-sha256-hash-of-the-plaintext-key");

  // Also exercise the declared unique-enforcing indexes, not just the
  // field validators.
  const byNameLang = await t.run(async (ctx) =>
    ctx.db
      .query("messageTemplates")
      .withIndex("by_account_name_lang", (q) =>
        q
          .eq("accountId", accountId)
          .eq("name", "welcome")
          .eq("language", "en_US"),
      )
      .collect(),
  );
  expect(byNameLang.map((r) => r._id)).toEqual([templateId]);

  const byKeyHash = await t.run(async (ctx) =>
    ctx.db
      .query("apiKeys")
      .withIndex("by_key_hash", (q) =>
        q.eq("keyHash", "fixture-sha256-hash-of-the-plaintext-key"),
      )
      .collect(),
  );
  expect(byKeyHash.map((r) => r._id)).toEqual([apiKeyId]);
});

test("Task 2 — an out-of-union value is rejected by the schema validator", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);

  await expect(
    t.run(async (ctx) =>
      ctx.db.insert("broadcasts", {
        accountId,
        name: "Spring sale",
        templateName: "spring_sale",
        templateLanguage: "en_US",
        // Not one of the `status` union's literals — proves the schema
        // rejects it rather than silently accepting any string.
        status: "not-a-real-status" as unknown as "draft",
        totalRecipients: 0,
        sentCount: 0,
        deliveredCount: 0,
        readCount: 0,
        repliedCount: 0,
        failedCount: 0,
      }),
    ),
  ).rejects.toThrow();
});

test("Task 3 — automations + flowRuns round-trip through the schema's validators", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);

  const contactId = await t.run(async (ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "+15551234567",
      phoneNormalized: "15551234567",
    }),
  );

  const automationId = await t.run(async (ctx) =>
    ctx.db.insert("automations", {
      accountId,
      name: "Welcome new contacts",
      description: "Sends a greeting on the first inbound message",
      // Plain string, not a union — Postgres never put a CHECK on
      // automations.trigger_type (see the schema comment).
      triggerType: "first_inbound_message",
      triggerConfig: { keyword: null },
      isActive: true,
      executionCount: 0,
      updatedAt: Date.now(),
    }),
  );

  const flowId = await t.run(async (ctx) =>
    ctx.db.insert("flows", {
      accountId,
      name: "Support triage",
      status: "active",
      triggerType: "keyword",
      triggerConfig: { keywords: ["help"] },
      fallbackPolicy: {
        on_unknown_reply: "reprompt",
        max_reprompts: 2,
        on_timeout_hours: 24,
        on_exhaust: "handoff",
      },
      executionCount: 0,
      updatedAt: Date.now(),
    }),
  );

  const flowRunId = await t.run(async (ctx) =>
    ctx.db.insert("flowRuns", {
      accountId,
      flowId,
      contactId,
      status: "active",
      currentNodeKey: "start",
      // Exercises the `v.optional(v.any())` validator with a nested
      // object, not just a bare scalar.
      vars: { name: "Priya" },
      repromptCount: 0,
      lastAdvancedAt: Date.now(),
    }),
  );

  const automation = await t.run(async (ctx) => ctx.db.get(automationId));
  const flowRun = await t.run(async (ctx) => ctx.db.get(flowRunId));

  expect(automation).not.toBeNull();
  expect(automation!.accountId).toBe(accountId);
  expect(automation!.triggerType).toBe("first_inbound_message");
  expect(automation!.isActive).toBe(true);
  expect(automation!.executionCount).toBe(0);

  expect(flowRun).not.toBeNull();
  expect(flowRun!.accountId).toBe(accountId);
  expect(flowRun!.flowId).toBe(flowId);
  expect(flowRun!.contactId).toBe(contactId);
  expect(flowRun!.status).toBe("active");
  expect(flowRun!.vars).toEqual({ name: "Priya" });

  // Also exercise the declared indexes, not just the field validators.
  const byAccount = await t.run(async (ctx) =>
    ctx.db
      .query("automations")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(byAccount.map((a) => a._id)).toEqual([automationId]);

  const byAccountContact = await t.run(async (ctx) =>
    ctx.db
      .query("flowRuns")
      .withIndex("by_account_contact", (q) =>
        q.eq("accountId", accountId).eq("contactId", contactId),
      )
      .collect(),
  );
  expect(byAccountContact.map((r) => r._id)).toEqual([flowRunId]);

  const byFlow = await t.run(async (ctx) =>
    ctx.db
      .query("flowRuns")
      .withIndex("by_flow", (q) => q.eq("flowId", flowId))
      .collect(),
  );
  expect(byFlow.map((r) => r._id)).toEqual([flowRunId]);

  const byStatus = await t.run(async (ctx) =>
    ctx.db
      .query("flowRuns")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect(),
  );
  expect(byStatus.map((r) => r._id)).toEqual([flowRunId]);
});

test("Task 3 — an out-of-union value is rejected by the schema validator", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);

  const automationId = await t.run(async (ctx) =>
    ctx.db.insert("automations", {
      accountId,
      name: "Broken automation",
      triggerType: "keyword_match",
      isActive: false,
      executionCount: 0,
    }),
  );

  await expect(
    t.run(async (ctx) =>
      ctx.db.insert("automationSteps", {
        accountId,
        automationId,
        // Not one of the 13-value `stepType` union's literals. Unlike
        // most unions in this file, this one has no backing Postgres
        // CHECK (see the schema comment) — it's sourced from the app's
        // closed `AutomationStepType` type / engine switch instead, so
        // this test is the only proof the schema still rejects a
        // bogus value rather than silently widening to any string.
        stepType: "not-a-real-step" as unknown as "wait",
        position: 0,
      }),
    ),
  ).rejects.toThrow();
});

test("Task 4 — aiKnowledgeChunks + aiConfigs round-trip through the schema's validators", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);

  const documentId = await t.run(async (ctx) =>
    ctx.db.insert("aiKnowledgeDocuments", {
      accountId,
      title: "Shipping policy",
      content: "We ship worldwide within 3-5 business days.",
      updatedAt: Date.now(),
    }),
  );

  const chunkId = await t.run(async (ctx) =>
    ctx.db.insert("aiKnowledgeChunks", {
      documentId,
      accountId,
      chunkIndex: 0,
      content: "We ship worldwide within 3-5 business days.",
      // Exercises the pgvector `vector(1536)` -> `v.array(v.float64())`
      // conversion. A small vector is enough to prove the field
      // validator accepts a float array; the vector index's actual ANN
      // search / dimension enforcement only fully validates on `convex
      // dev`'s deploy step (this offline test cannot exercise it — see
      // the schema comment on `aiKnowledgeChunks`).
      embedding: [0.1, 0.2, 0.3],
    }),
  );

  const aiConfigId = await t.run(async (ctx) =>
    ctx.db.insert("aiConfigs", {
      accountId,
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "ciphertext-fixture-not-a-real-key",
      isActive: true,
      autoReplyEnabled: false,
      autoReplyMaxPerConversation: 3,
    }),
  );

  const chunk = await t.run(async (ctx) => ctx.db.get(chunkId));
  const aiConfig = await t.run(async (ctx) => ctx.db.get(aiConfigId));

  expect(chunk).not.toBeNull();
  expect(chunk!.documentId).toBe(documentId);
  expect(chunk!.accountId).toBe(accountId);
  expect(chunk!.chunkIndex).toBe(0);
  expect(chunk!.embedding).toEqual([0.1, 0.2, 0.3]);

  expect(aiConfig).not.toBeNull();
  expect(aiConfig!.accountId).toBe(accountId);
  expect(aiConfig!.provider).toBe("openai");
  expect(aiConfig!.isActive).toBe(true);
  expect(aiConfig!.autoReplyMaxPerConversation).toBe(3);

  // Also exercise the declared regular indexes (not the search/vector
  // indexes — those are backend-only; see the note above).
  const byDocument = await t.run(async (ctx) =>
    ctx.db
      .query("aiKnowledgeChunks")
      .withIndex("by_document", (q) => q.eq("documentId", documentId))
      .collect(),
  );
  expect(byDocument.map((c) => c._id)).toEqual([chunkId]);

  const byAccount = await t.run(async (ctx) =>
    ctx.db
      .query("aiConfigs")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(byAccount.map((c) => c._id)).toEqual([aiConfigId]);
});

test("Task 4 — an out-of-union value is rejected by the schema validator", async () => {
  const t = convexTest(schema, modules);
  const accountId = await insertAccount(t);

  await expect(
    t.run(async (ctx) =>
      ctx.db.insert("aiConfigs", {
        accountId,
        // Not one of the `provider` union's literals — proves the
        // schema rejects it rather than silently accepting any string.
        provider: "not-a-real-provider" as unknown as "openai",
        model: "gpt-4o-mini",
        apiKey: "ciphertext-fixture-not-a-real-key",
        isActive: true,
        autoReplyEnabled: false,
        autoReplyMaxPerConversation: 3,
      }),
    ),
  ).rejects.toThrow();
});
