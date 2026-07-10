/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches every other
// `convex/*.test.ts` suite — see `convex/contacts.test.ts`'s own comment).
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported (matches
 * `convex/automations.test.ts`'s own comment on why).
 */
async function seedAccountMember(
  t: ReturnType<typeof convexTest>,
  opts: { name: string; email: string; role: AccountRole },
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: opts.name, email: opts.email }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: `${opts.name}'s account`,
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return id;
  });
  const asUser = t.withIdentity({
    subject: `${userId}|session-${opts.name}`,
  });
  return { userId, accountId, asUser };
}

/** Direct-insert helpers for rows that have no public creating mutation
 * from this module (flowRuns/flowRunEvents are written only by the
 * runtime engine's internal mutations) — mirrors
 * `automations.test.ts`'s own `seedLog` helper. */
async function seedContact(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  phone: string,
  name?: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("contacts", { accountId, phone, phoneNormalized: phone, name }),
  );
}

async function seedFlowRun(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    flowId: Id<"flows">;
    contactId?: Id<"contacts">;
    status?: "active" | "completed" | "handed_off" | "timed_out" | "paused_by_agent" | "failed";
    currentNodeKey?: string;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("flowRuns", {
      accountId: opts.accountId,
      flowId: opts.flowId,
      contactId: opts.contactId,
      status: opts.status ?? "active",
      currentNodeKey: opts.currentNodeKey,
      vars: {},
      repromptCount: 0,
    }),
  );
}

async function seedFlowRunEvent(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    flowRunId: Id<"flowRuns">;
    eventType?: "started" | "node_entered" | "message_sent" | "reply_received" | "fallback_fired" | "handoff" | "timeout" | "error" | "completed";
    nodeKey?: string;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("flowRunEvents", {
      accountId: opts.accountId,
      flowRunId: opts.flowRunId,
      eventType: opts.eventType ?? "started",
      nodeKey: opts.nodeKey,
      payload: {},
    }),
  );
}

// A minimal valid 3-node graph — camelCase/Convex-shaped port of the
// `validFlow`/`validNodes` fixture in `convex/lib/flows/validate.test.ts`
// (start -> menu(send_buttons, both buttons -> ho) -> ho(handoff)).
// Reused here so `activate`'s "valid graph" test exercises the exact
// same shape the pure validator's own happy-path test already covers.
const VALID_GRAPH_NODES = [
  { nodeKey: "start", nodeType: "start" as const, config: { next_node_key: "menu" } },
  {
    nodeKey: "menu",
    nodeType: "send_buttons" as const,
    config: {
      text: "How can we help?",
      buttons: [
        { reply_id: "a", title: "A", next_node_key: "ho" },
        { reply_id: "b", title: "B", next_node_key: "ho" },
      ],
    },
  },
  { nodeKey: "ho", nodeType: "handoff" as const, config: {} },
];

// ============================================================
// list
// ============================================================

test("list returns the caller's own flows, newest-first, with nodeCount/isActive summary", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });

  await asUser.mutation(api.flows.create, { name: "First" });
  const secondId = await asUser.mutation(api.flows.create, { template: "welcome_menu" });

  const list = await asUser.query(api.flows.list, {});
  expect(list).toHaveLength(2);
  expect(list[0]!._id).toBe(secondId); // newest first
  expect(list[0]!.nodeCount).toBe(4);
  expect(list[0]!.isActive).toBe(false);
  expect(list[1]!.nodeCount).toBe(0);
});

test("list never returns another account's flows", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const { asUser: asBob } = await seedAccountMember(t, { name: "Bob", email: "bob@example.com", role: "agent" });

  await asAlice.mutation(api.flows.create, { name: "Alice's" });

  expect(await asBob.query(api.flows.list, {})).toEqual([]);
  expect(await asAlice.query(api.flows.list, {})).toHaveLength(1);
});

// ============================================================
// create
// ============================================================

test("create (plain) inserts a draft flow scoped to ctx.accountId/ctx.userId, defaulting triggerType to keyword", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });

  const flowId = await asUser.mutation(api.flows.create, { name: "My Flow", description: "desc" });

  const row = await t.run((ctx) => ctx.db.get(flowId));
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.name).toBe("My Flow");
  expect(row!.description).toBe("desc");
  expect(row!.status).toBe("draft");
  expect(row!.triggerType).toBe("keyword");
  expect(row!.triggerConfig).toEqual({});
  expect(row!.executionCount).toBe(0);
});

test("create (plain) throws INVALID_INPUT when name is missing or blank", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });

  await expect(asUser.mutation(api.flows.create, {})).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
  await expect(asUser.mutation(api.flows.create, { name: "   " })).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
});

test("create throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Vera", email: "vera@example.com", role: "viewer" });

  await expect(asUser.mutation(api.flows.create, { name: "x" })).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("create (template) clones the template's trigger + entryNodeId + nodes[], overriding only name", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });

  const flowId = await asUser.mutation(api.flows.create, { template: "welcome_menu", name: "Custom name" });

  const row = await t.run((ctx) => ctx.db.get(flowId));
  expect(row!.name).toBe("Custom name");
  expect(row!.triggerType).toBe("keyword");
  expect(row!.entryNodeId).toBe("start");
  expect(row!.status).toBe("draft");

  const nodes = await t.run((ctx) =>
    ctx.db.query("flowNodes").withIndex("by_flow_node_key", (q) => q.eq("flowId", flowId)).collect(),
  );
  expect(nodes).toHaveLength(4);
  for (const n of nodes) expect(n.accountId).toBe(accountId);
  const welcome = nodes.find((n) => n.nodeKey === "welcome")!;
  expect(welcome.nodeType).toBe("send_buttons");
  const cfg = welcome.config as { buttons: Array<{ reply_id: string; next_node_key: string }> };
  expect(cfg.buttons[0]!.reply_id).toBe("existing");
  expect(cfg.buttons[0]!.next_node_key).toBe("existing_handoff");
});

test("create (template) falls back to the template's own name when no name override is given", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });

  const flowId = await asUser.mutation(api.flows.create, { template: "faq_bot" });
  const row = await t.run((ctx) => ctx.db.get(flowId));
  expect(row!.name).toBe("FAQ bot");
  expect(row!.triggerType).toBe("keyword");
});

test("create throws INVALID_INPUT for an unknown template slug", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });

  await expect(asUser.mutation(api.flows.create, { template: "not_a_real_template" })).rejects.toMatchObject({
    data: { code: "INVALID_INPUT" },
  });
});

// ============================================================
// get — round-trips the graph created via create
// ============================================================

test("get round-trips a template-created flow's full graph, and is ownership-checked", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const { asUser: asBob } = await seedAccountMember(t, { name: "Bob", email: "bob@example.com", role: "agent" });

  const flowId = await asAlice.mutation(api.flows.create, { template: "lead_capture" });

  const result = await asAlice.query(api.flows.get, { flowId });
  expect(result.flow._id).toBe(flowId);
  expect(result.flow.triggerType).toBe("first_inbound_message");
  expect(result.nodes).toHaveLength(6);
  expect(result.nodes.map((n) => n.nodeKey).sort()).toEqual(
    ["ask_company", "ask_email", "ask_name", "handoff", "intro", "start"].sort(),
  );

  const error: unknown = await asBob.query(api.flows.get, { flowId }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: unknown }).data).toEqual({ code: "NOT_FOUND", entity: "flow" });
});

// ============================================================
// update
// ============================================================

test("update patches scalar fields and always stamps updatedAt, even on a nodes-only save", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const flowId = await asUser.mutation(api.flows.create, { name: "Old" });
  const before = await t.run((ctx) => ctx.db.get(flowId));

  await asUser.mutation(api.flows.update, { flowId, name: "New", description: "d2" });
  const afterScalar = await t.run((ctx) => ctx.db.get(flowId));
  expect(afterScalar!.name).toBe("New");
  expect(afterScalar!.description).toBe("d2");
  expect(afterScalar!.updatedAt).toBeGreaterThanOrEqual(before!.updatedAt ?? 0);

  // A nodes-only save (no scalar fields) must still stamp updatedAt —
  // matches the source PUT's unconditional `updated_at` write, unlike
  // automations' conditional PATCH.
  const t1 = afterScalar!.updatedAt!;
  await new Promise((r) => setTimeout(r, 2));
  await asUser.mutation(api.flows.update, { flowId, nodes: [] });
  const afterNodesOnly = await t.run((ctx) => ctx.db.get(flowId));
  expect(afterNodesOnly!.updatedAt).toBeGreaterThan(t1);
});

test("update throws INVALID_INPUT when name is set to blank", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const flowId = await asUser.mutation(api.flows.create, { name: "Old" });

  await expect(asUser.mutation(api.flows.update, { flowId, name: "   " })).rejects.toMatchObject({
    data: { code: "INVALID_INPUT" },
  });
});

test("update does not touch flowNodes when nodes is omitted", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const flowId = await asUser.mutation(api.flows.create, { template: "welcome_menu" });

  await asUser.mutation(api.flows.update, { flowId, name: "Renamed" });

  const nodes = await t.run((ctx) =>
    ctx.db.query("flowNodes").withIndex("by_flow_node_key", (q) => q.eq("flowId", flowId)).collect(),
  );
  expect(nodes).toHaveLength(4);
});

test("update replaces flowNodes (delete-then-insert) while preserving the nodeKey strings the engine keys runs off of", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const flowId = await asUser.mutation(api.flows.create, { name: "Graph" });

  await asUser.mutation(api.flows.update, {
    flowId,
    entryNodeId: "start",
    nodes: [
      { nodeKey: "start", nodeType: "start", config: { next_node_key: "next" } },
      { nodeKey: "next", nodeType: "send_message", config: { text: "v1", next_node_key: "start" } },
    ],
  });

  // A flow run is parked at nodeKey "next" (the engine only ever stores
  // the stable nodeKey string, never a flowNodes row id — see
  // `flowRuns.currentNodeKey`/`flowsEngine.loadNodeMap`).
  const runId = await seedFlowRun(t, { accountId, flowId, currentNodeKey: "next" });

  // Re-save the graph: same two nodeKeys, but "next"'s config changed
  // and a brand-new flowNodes row id is created underneath (delete +
  // insert, not an in-place patch).
  await asUser.mutation(api.flows.update, {
    flowId,
    nodes: [
      { nodeKey: "start", nodeType: "start", config: { next_node_key: "next" } },
      { nodeKey: "next", nodeType: "send_message", config: { text: "v2", next_node_key: "start" } },
    ],
  });

  const nodes = await t.run((ctx) =>
    ctx.db.query("flowNodes").withIndex("by_flow_node_key", (q) => q.eq("flowId", flowId)).collect(),
  );
  expect(nodes).toHaveLength(2);
  const nextNode = nodes.find((n) => n.nodeKey === "next")!;
  expect((nextNode.config as { text: string }).text).toBe("v2");

  // The run's currentNodeKey is untouched by the replace, and still
  // resolves against the freshly-inserted graph — proving the
  // delete-then-insert approach doesn't strand an in-flight run as
  // long as the nodeKey string is reused.
  const run = await t.run((ctx) => ctx.db.get(runId));
  expect(run!.currentNodeKey).toBe("next");
  expect(nodes.some((n) => n.nodeKey === run!.currentNodeKey)).toBe(true);
});

test("update replacing with an empty nodes array clears all existing nodes", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const flowId = await asUser.mutation(api.flows.create, { template: "welcome_menu" });

  await asUser.mutation(api.flows.update, { flowId, nodes: [] });

  const nodes = await t.run((ctx) =>
    ctx.db.query("flowNodes").withIndex("by_flow_node_key", (q) => q.eq("flowId", flowId)).collect(),
  );
  expect(nodes).toHaveLength(0);
});

test("update throws NOT_FOUND (not a silent no-op) for another account's flow, and leaves it unmodified", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const { asUser: asBob } = await seedAccountMember(t, { name: "Bob", email: "bob@example.com", role: "agent" });
  const flowId = await asAlice.mutation(api.flows.create, { name: "Alice's" });

  await expect(asBob.mutation(api.flows.update, { flowId, name: "Pwned" })).rejects.toMatchObject({
    data: { code: "NOT_FOUND" },
  });
  const row = await t.run((ctx) => ctx.db.get(flowId));
  expect(row!.name).toBe("Alice's");
});

test("update throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedAccountMember(t, { name: "Owner", email: "owner@example.com", role: "owner" });
  const flowId = await asOwner.mutation(api.flows.create, { name: "x" });
  const { asUser: asViewer } = await seedAccountMember(t, { name: "Vera", email: "vera@example.com", role: "viewer" });

  await expect(asViewer.mutation(api.flows.update, { flowId, name: "y" })).rejects.toMatchObject({
    data: { code: "FORBIDDEN", min: "agent" },
  });
});

// ============================================================
// remove
// ============================================================

test("remove deletes the flow and cascades its nodes, runs, and run events", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const flowId = await asUser.mutation(api.flows.create, { template: "welcome_menu" });
  const runId = await seedFlowRun(t, { accountId, flowId });
  await seedFlowRunEvent(t, { accountId, flowRunId: runId });
  await seedFlowRunEvent(t, { accountId, flowRunId: runId });

  await asUser.mutation(api.flows.remove, { flowId });

  expect(await t.run((ctx) => ctx.db.get(flowId))).toBeNull();
  const nodes = await t.run((ctx) => ctx.db.query("flowNodes").collect());
  expect(nodes).toHaveLength(0);
  const runs = await t.run((ctx) => ctx.db.query("flowRuns").collect());
  expect(runs).toHaveLength(0);
  const events = await t.run((ctx) => ctx.db.query("flowRunEvents").collect());
  expect(events).toHaveLength(0);
});

test("remove throws NOT_FOUND for another account's flow, and leaves it in place", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const { asUser: asBob } = await seedAccountMember(t, { name: "Bob", email: "bob@example.com", role: "agent" });
  const flowId = await asAlice.mutation(api.flows.create, { name: "Alice's" });

  await expect(asBob.mutation(api.flows.remove, { flowId })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  expect(await t.run((ctx) => ctx.db.get(flowId))).not.toBeNull();
});

test("remove throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedAccountMember(t, { name: "Owner", email: "owner@example.com", role: "owner" });
  const flowId = await asOwner.mutation(api.flows.create, { name: "x" });
  const { asUser: asViewer } = await seedAccountMember(t, { name: "Vera", email: "vera@example.com", role: "viewer" });

  await expect(asViewer.mutation(api.flows.remove, { flowId })).rejects.toMatchObject({
    data: { code: "FORBIDDEN", min: "agent" },
  });
});

// ============================================================
// activate
// ============================================================

test("activate to 'active' succeeds on a valid graph (reusing convex/lib/flows/validate.ts)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const flowId = await asUser.mutation(api.flows.create, { name: "Valid", triggerType: "keyword", triggerConfig: { keywords: ["support"] } });
  await asUser.mutation(api.flows.update, { flowId, entryNodeId: "start", nodes: VALID_GRAPH_NODES });

  const updated = await asUser.mutation(api.flows.activate, { flowId, status: "active" });
  expect(updated!.status).toBe("active");
  const row = await t.run((ctx) => ctx.db.get(flowId));
  expect(row!.status).toBe("active");
});

test("activate to 'active' rejects an invalid graph with the validator's issues, and does not change status", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  // No entryNodeId, no nodes at all -> validateFlowForActivation flags
  // both "entry_node_id required" and "needs at least one node".
  const flowId = await asUser.mutation(api.flows.create, { name: "Broken" });

  const error: unknown = await asUser.mutation(api.flows.activate, { flowId, status: "active" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  const data = (error as { data: { code: string; issues: Array<{ severity: string }> } }).data;
  expect(data.code).toBe("VALIDATION_FAILED");
  expect(data.issues.some((i) => i.severity === "error")).toBe(true);

  const row = await t.run((ctx) => ctx.db.get(flowId));
  expect(row!.status).toBe("draft");
});

test("activate to 'draft' or 'archived' is unconditional — bypasses validation even on a broken graph", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const flowId = await asUser.mutation(api.flows.create, { name: "Broken" }); // no nodes, no entryNodeId

  await expect(asUser.mutation(api.flows.activate, { flowId, status: "archived" })).resolves.toMatchObject({ status: "archived" });
  await expect(asUser.mutation(api.flows.activate, { flowId, status: "draft" })).resolves.toMatchObject({ status: "draft" });
});

test("activate does not enforce any 'only one active flow' constraint — multiple flows with overlapping triggers can be active at once, matching the source (idx_flows_active_trigger is a plain, non-unique index; the runtime resolves overlap by first-registered-wins)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });

  const flowIdA = await asUser.mutation(api.flows.create, { name: "A", triggerType: "keyword", triggerConfig: { keywords: ["hi"] } });
  await asUser.mutation(api.flows.update, { flowId: flowIdA, entryNodeId: "start", nodes: VALID_GRAPH_NODES });

  const flowIdB = await asUser.mutation(api.flows.create, { name: "B", triggerType: "keyword", triggerConfig: { keywords: ["hi"] } });
  await asUser.mutation(api.flows.update, { flowId: flowIdB, entryNodeId: "start", nodes: VALID_GRAPH_NODES });

  await asUser.mutation(api.flows.activate, { flowId: flowIdA, status: "active" });
  await asUser.mutation(api.flows.activate, { flowId: flowIdB, status: "active" });

  const rowA = await t.run((ctx) => ctx.db.get(flowIdA));
  const rowB = await t.run((ctx) => ctx.db.get(flowIdB));
  expect(rowA!.status).toBe("active");
  expect(rowB!.status).toBe("active");
});

test("activate throws NOT_FOUND for another account's flow", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const { asUser: asBob } = await seedAccountMember(t, { name: "Bob", email: "bob@example.com", role: "agent" });
  const flowId = await asAlice.mutation(api.flows.create, { name: "Alice's" });

  await expect(asBob.mutation(api.flows.activate, { flowId, status: "archived" })).rejects.toMatchObject({
    data: { code: "NOT_FOUND" },
  });
});

test("activate throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedAccountMember(t, { name: "Owner", email: "owner@example.com", role: "owner" });
  const flowId = await asOwner.mutation(api.flows.create, { name: "x" });
  const { asUser: asViewer } = await seedAccountMember(t, { name: "Vera", email: "vera@example.com", role: "viewer" });

  await expect(asViewer.mutation(api.flows.activate, { flowId, status: "archived" })).rejects.toMatchObject({
    data: { code: "FORBIDDEN", min: "agent" },
  });
});

// ============================================================
// runs
// ============================================================

test("runs returns the flow's runs newest-first with embedded contact + flattened events, scoped to the flow", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const flowId = await asUser.mutation(api.flows.create, { name: "F" });
  const otherFlowId = await asUser.mutation(api.flows.create, { name: "Other" });
  const contactId = await seedContact(t, accountId, "+15550000000", "Jonas");

  const run1 = await seedFlowRun(t, { accountId, flowId, contactId, status: "active" });
  const run2 = await seedFlowRun(t, { accountId, flowId, status: "completed" });
  await seedFlowRun(t, { accountId, flowId: otherFlowId }); // different flow — must not leak in

  await seedFlowRunEvent(t, { accountId, flowRunId: run1, eventType: "started" });
  await seedFlowRunEvent(t, { accountId, flowRunId: run2, eventType: "completed" });

  const result = await asUser.query(api.flows.runs, { flowId });
  expect(result.flow._id).toBe(flowId);
  expect(result.runs).toHaveLength(2);
  expect(result.runs[0]!._id).toBe(run2); // newest first
  expect(result.runs[1]!._id).toBe(run1);
  expect(result.runs[1]!.contact).toMatchObject({ name: "Jonas", phone: "+15550000000" });
  expect(result.runs[0]!.contact).toBeNull();
  expect(result.events).toHaveLength(2);
});

test("runs respects the limit argument", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const flowId = await asUser.mutation(api.flows.create, { name: "F" });
  for (let i = 0; i < 5; i++) {
    await seedFlowRun(t, { accountId, flowId });
  }

  const result = await asUser.query(api.flows.runs, { flowId, limit: 2 });
  expect(result.runs).toHaveLength(2);
});

test("runs throws NOT_FOUND for another account's flow", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });
  const { asUser: asBob } = await seedAccountMember(t, { name: "Bob", email: "bob@example.com", role: "agent" });
  const flowId = await asAlice.mutation(api.flows.create, { name: "Alice's" });

  await expect(asBob.query(api.flows.runs, { flowId })).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
});

// ============================================================
// templates
// ============================================================

test("templates returns the static catalog with slug/name/description/icon/triggerType/nodeCount", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "Alice", email: "alice@example.com", role: "agent" });

  const list = await asUser.query(api.flows.templates, {});
  expect(list.map((tpl) => tpl.slug).sort()).toEqual(["faq_bot", "lead_capture", "welcome_menu"]);

  const welcome = list.find((tpl) => tpl.slug === "welcome_menu")!;
  expect(welcome.name).toBe("Welcome menu");
  expect(welcome.triggerType).toBe("keyword");
  expect(welcome.nodeCount).toBe(4);

  const faq = list.find((tpl) => tpl.slug === "faq_bot")!;
  expect(faq.nodeCount).toBe(7);

  const lead = list.find((tpl) => tpl.slug === "lead_capture")!;
  expect(lead.nodeCount).toBe(6);
  expect(lead.triggerType).toBe("first_inbound_message");
});
