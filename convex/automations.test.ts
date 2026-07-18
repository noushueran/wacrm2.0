/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*` references
// against. Absolute, from-project-root pattern (matches
// `convex/contacts.test.ts` — see that file's comment for why this must
// be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated from `convex/contacts.test.ts` rather than
 * imported — each `convex/*.test.ts` suite owns its own copy of this
 * helper (see that file's own comment on why).
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

/** Directly inserts an `automationLogs` row — there is no public mutation
 * that writes logs (only `automationsEngine.ts`'s internal mutations do),
 * so isolation/scoping tests for `logs` seed rows straight through
 * `t.run`, mirroring `automationsEngine.test.ts`'s own `seedAutomation`/
 * `seedStep` direct-insert helpers. */
async function seedLog(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    automationId: Id<"automations">;
    triggerEvent?: string;
    status?: "success" | "partial" | "failed";
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("automationLogs", {
      accountId: opts.accountId,
      automationId: opts.automationId,
      triggerEvent: opts.triggerEvent ?? "new_message_received",
      stepsExecuted: [],
      status: opts.status ?? "success",
    }),
  );
}

const nestedSteps = [
  {
    step_type: "condition",
    step_config: { subject: "tag_presence", operand: "vip" },
    branches: {
      yes: [
        { step_type: "add_tag", step_config: { tag_id: "vip" } },
      ],
      no: [
        { step_type: "send_message", step_config: { text: "sorry" } },
      ],
    },
  },
];

// A minimal structurally-valid step set for the activation-validation
// tests below: `send_message` needs non-empty text, and the
// `new_message_received` trigger needs no config, so an automation built
// from these passes `convex/lib/automations/validate.ts`. `invalidSteps`
// trips that same validator (empty message text).
const validSteps = [{ step_type: "send_message", step_config: { text: "hi" } }];
const invalidSteps = [{ step_type: "send_message", step_config: { text: "" } }];

// ============================================================
// create
// ============================================================

test("create inserts an automation scoped to ctx.accountId/ctx.userId, with executionCount 0", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const automationId = await asUser.mutation(api.automations.create, {
    name: "My Automation",
    triggerType: "new_message_received",
    triggerConfig: {},
    isActive: false,
  });

  const row = await t.run((ctx) => ctx.db.get(automationId));
  expect(row).not.toBeNull();
  expect(row!.accountId).toBe(accountId);
  expect(row!.createdByUserId).toBe(userId);
  expect(row!.name).toBe("My Automation");
  expect(row!.executionCount).toBe(0);
  expect(row!.isActive).toBe(false);
  expect(row!.updatedAt).toEqual(expect.any(Number));
});

test("create throws INVALID_INPUT when name and triggerType are both missing and no template is given", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    asUser.mutation(api.automations.create, {}),
  ).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
});

test("create throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asUser.mutation(api.automations.create, {
      name: "x",
      triggerType: "new_message_received",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("create flattens a nested steps tree (condition + yes/no branches) into ordered automationSteps rows", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const automationId = await asUser.mutation(api.automations.create, {
    name: "Branching",
    triggerType: "tag_added",
    triggerConfig: { tag_id: "vip" },
    isActive: false,
    steps: nestedSteps,
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .collect(),
  );
  expect(rows).toHaveLength(3);
  for (const row of rows) expect(row.accountId).toBe(accountId);

  const root = rows.find((r) => r.parentStepId === undefined);
  expect(root!.stepType).toBe("condition");
  expect(root!.position).toBe(0);

  const yesChild = rows.find((r) => r.branch === "yes");
  const noChild = rows.find((r) => r.branch === "no");
  expect(yesChild!.parentStepId).toBe(root!._id);
  expect(yesChild!.stepType).toBe("add_tag");
  expect(noChild!.parentStepId).toBe(root!._id);
  expect(noChild!.stepType).toBe("send_message");
});

test("create expands a template when steps are empty, filling in omitted name/description/trigger from the template", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const automationId = await asUser.mutation(api.automations.create, {
    template: "welcome_message",
    isActive: false,
  });

  const row = await t.run((ctx) => ctx.db.get(automationId));
  expect(row!.name).toBe("Welcome Message");
  expect(row!.triggerType).toBe("first_inbound_message");

  const rows = await t.run((ctx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .collect(),
  );
  expect(rows.map((r) => r.stepType).sort()).toEqual(["add_tag", "send_message"]);
});

test("create's out_of_office template nests its send_message step under the condition's yes branch", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const automationId = await asUser.mutation(api.automations.create, {
    template: "out_of_office",
  });

  const { steps } = await asUser.query(api.automations.get, { automationId });
  expect(steps).toHaveLength(1);
  expect(steps[0]!.step_type).toBe("condition");
  expect(steps[0]!.branches.yes).toHaveLength(1);
  expect(steps[0]!.branches.yes[0]!.step_type).toBe("send_message");
  expect(steps[0]!.branches.no).toHaveLength(0);
});

test("create rejects activating (isActive:true) an automation whose steps are structurally invalid", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const error: unknown = await asUser
    .mutation(api.automations.create, {
      name: "Broken",
      triggerType: "new_message_received",
      isActive: true,
      steps: invalidSteps,
    })
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(ConvexError);
  const data = (error as { data: { code: string; issues: Array<{ path: string; message: string }> } }).data;
  expect(data.code).toBe("VALIDATION_FAILED");
  expect(data.issues.length).toBeGreaterThan(0);

  // The whole mutation aborted before writing anything.
  expect(await t.run((ctx) => ctx.db.query("automations").collect())).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.query("automationSteps").collect())).toHaveLength(0);
});

test("create allows activating (isActive:true) an automation whose steps and trigger are valid", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const automationId = await asUser.mutation(api.automations.create, {
    name: "Live",
    triggerType: "new_message_received",
    isActive: true,
    steps: validSteps,
  });

  const row = await t.run((ctx) => ctx.db.get(automationId));
  expect(row!.isActive).toBe(true);
  const rows = await t.run((ctx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
});

test("create still saves a structurally-broken automation as an inactive draft (no validation)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const automationId = await asUser.mutation(api.automations.create, {
    name: "Draft",
    triggerType: "new_message_received",
    isActive: false,
    steps: invalidSteps,
  });

  expect((await t.run((ctx) => ctx.db.get(automationId)))!.isActive).toBe(false);
});

// ============================================================
// list
// ============================================================

test("list returns the caller's own automations, newest-first, each with a stepCount summary", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await asUser.mutation(api.automations.create, {
    name: "First",
    triggerType: "new_message_received",
  });
  const secondId = await asUser.mutation(api.automations.create, {
    name: "Second",
    triggerType: "tag_added",
    triggerConfig: { tag_id: "x" },
    steps: nestedSteps,
  });

  const list = await asUser.query(api.automations.list, {});
  expect(list).toHaveLength(2);
  expect(list[0]!._id).toBe(secondId); // newest first
  expect(list[0]!.stepCount).toBe(3);
  expect(list[1]!.stepCount).toBe(0);
});

test("list never returns another account's automations", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  await asAlice.mutation(api.automations.create, {
    name: "Alice's",
    triggerType: "new_message_received",
  });

  expect(await asBob.query(api.automations.list, {})).toEqual([]);
  expect(await asAlice.query(api.automations.list, {})).toHaveLength(1);
});

// ============================================================
// get — round-trips the step tree through create -> get
// ============================================================

test("get round-trips a nested step tree built by create, and is ownership-checked", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const automationId = await asUser.mutation(api.automations.create, {
    name: "Branching",
    triggerType: "tag_added",
    triggerConfig: { tag_id: "vip" },
    steps: nestedSteps,
  });

  const result = await asUser.query(api.automations.get, { automationId });
  expect(result.automation._id).toBe(automationId);
  expect(result.steps).toHaveLength(1);
  expect(result.steps[0]!.step_type).toBe("condition");
  expect(result.steps[0]!.branches.yes).toEqual([
    expect.objectContaining({ step_type: "add_tag", step_config: { tag_id: "vip" } }),
  ]);
  expect(result.steps[0]!.branches.no).toEqual([
    expect.objectContaining({ step_type: "send_message", step_config: { text: "sorry" } }),
  ]);
});

test("get throws NOT_FOUND when the automation belongs to a different account", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const automationId = await asAlice.mutation(api.automations.create, {
    name: "Alice's",
    triggerType: "new_message_received",
  });

  const error: unknown = await asBob
    .query(api.automations.get, { automationId })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: unknown }).data).toEqual({
    code: "NOT_FOUND",
    entity: "automation",
  });
});

// ============================================================
// update
// ============================================================

test("update patches scalar fields and stamps updatedAt", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "Old",
    triggerType: "new_message_received",
  });
  const before = await t.run((ctx) => ctx.db.get(automationId));

  await asUser.mutation(api.automations.update, {
    automationId,
    name: "New",
    description: "desc",
  });

  const after = await t.run((ctx) => ctx.db.get(automationId));
  expect(after!.name).toBe("New");
  expect(after!.description).toBe("desc");
  expect(after!.updatedAt).toBeGreaterThanOrEqual(before!.updatedAt!);
});

test("update does not touch automationSteps when steps is omitted", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "Old",
    triggerType: "new_message_received",
    steps: nestedSteps,
  });

  await asUser.mutation(api.automations.update, { automationId, name: "New" });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .collect(),
  );
  expect(rows).toHaveLength(3); // unchanged: condition + yes + no
});

test("update replaces automationSteps: old rows are deleted and the new tree is inserted", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "Old",
    triggerType: "new_message_received",
    steps: nestedSteps,
  });

  await asUser.mutation(api.automations.update, {
    automationId,
    steps: [{ step_type: "send_message", step_config: { text: "replaced" } }],
  });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.stepType).toBe("send_message");
  expect(rows[0]!.stepConfig).toEqual({ text: "replaced" });
});

test("update replacing with an empty steps array clears all existing steps", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "Old",
    triggerType: "new_message_received",
    steps: nestedSteps,
  });

  await asUser.mutation(api.automations.update, { automationId, steps: [] });

  const rows = await t.run((ctx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .collect(),
  );
  expect(rows).toHaveLength(0);
});

test("update throws NOT_FOUND (not a silent no-op) for another account's automation, and leaves it unmodified", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const automationId = await asAlice.mutation(api.automations.create, {
    name: "Alice's",
    triggerType: "new_message_received",
  });

  await expect(
    asBob.mutation(api.automations.update, { automationId, name: "Pwned" }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });

  const row = await t.run((ctx) => ctx.db.get(automationId));
  expect(row!.name).toBe("Alice's");
});

test("update throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const automationId = await asOwner.mutation(api.automations.create, {
    name: "x",
    triggerType: "new_message_received",
  });
  const { asUser: asViewer } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asViewer.mutation(api.automations.update, { automationId, name: "y" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("update rejects flipping isActive to true when the trigger config is structurally invalid", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  // keyword_match with no keywords is invalid; the steps are fine, so only
  // the trigger fails — proving validateTriggerForActivation is wired in.
  const automationId = await asUser.mutation(api.automations.create, {
    name: "Kw",
    triggerType: "keyword_match",
    triggerConfig: { keywords: [] },
    steps: validSteps,
    isActive: false,
  });

  const error: unknown = await asUser
    .mutation(api.automations.update, { automationId, isActive: true })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  const data = (error as { data: { code: string; issues: Array<{ path: string }> } }).data;
  expect(data.code).toBe("VALIDATION_FAILED");
  expect(data.issues.some((i) => i.path === "trigger.keywords")).toBe(true);

  // The failed activation left it inactive — no patch landed.
  expect((await t.run((ctx) => ctx.db.get(automationId)))!.isActive).toBe(false);
});

test("update rejects editing an already-active automation into a broken state, leaving its steps intact", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "Live",
    triggerType: "new_message_received",
    isActive: true,
    steps: validSteps,
  });

  // isActive isn't in the args, but the automation is already active, so the
  // *resulting* state is still active and the new (broken) steps are validated.
  const error: unknown = await asUser
    .mutation(api.automations.update, { automationId, steps: invalidSteps })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: { code: string } }).data.code).toBe("VALIDATION_FAILED");

  // replaceSteps never ran — the original valid step survives untouched.
  const rows = await t.run((ctx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.stepConfig).toEqual({ text: "hi" });
});

test("update allows flipping isActive to true when the resulting config is valid", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "Draft",
    triggerType: "new_message_received",
    steps: validSteps,
    isActive: false,
  });

  await asUser.mutation(api.automations.update, { automationId, isActive: true });
  expect((await t.run((ctx) => ctx.db.get(automationId)))!.isActive).toBe(true);
});

test("update does not validate a steps edit while the automation stays inactive", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "Draft",
    triggerType: "new_message_received",
    steps: validSteps,
    isActive: false,
  });

  // Broken steps are fine on an inactive draft — saved, not rejected.
  await asUser.mutation(api.automations.update, { automationId, steps: invalidSteps });
  const rows = await t.run((ctx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.stepConfig).toEqual({ text: "" });
});

// ============================================================
// setActive
// ============================================================

test("setActive toggles isActive and stamps updatedAt", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "x",
    triggerType: "new_message_received",
    isActive: false,
    steps: validSteps,
  });

  await asUser.mutation(api.automations.setActive, { automationId, isActive: true });
  expect((await t.run((ctx) => ctx.db.get(automationId)))!.isActive).toBe(true);

  await asUser.mutation(api.automations.setActive, { automationId, isActive: false });
  expect((await t.run((ctx) => ctx.db.get(automationId)))!.isActive).toBe(false);
});

test("setActive throws NOT_FOUND for another account's automation", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const automationId = await asAlice.mutation(api.automations.create, {
    name: "Alice's",
    triggerType: "new_message_received",
    isActive: false,
  });

  await expect(
    asBob.mutation(api.automations.setActive, { automationId, isActive: true }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
});

test("setActive rejects activating a structurally invalid automation and leaves it inactive", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  // No steps at all -> validateStepsForActivation flags "needs at least one step".
  const automationId = await asUser.mutation(api.automations.create, {
    name: "Empty",
    triggerType: "new_message_received",
    isActive: false,
  });

  const error: unknown = await asUser
    .mutation(api.automations.setActive, { automationId, isActive: true })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ConvexError);
  expect((error as { data: { code: string } }).data.code).toBe("VALIDATION_FAILED");

  expect((await t.run((ctx) => ctx.db.get(automationId)))!.isActive).toBe(false);
});

test("setActive can always deactivate (isActive:false) even a structurally-broken automation", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  // Broken but still inactive (it could never have been activated).
  const automationId = await asUser.mutation(api.automations.create, {
    name: "Broken",
    triggerType: "new_message_received",
    steps: invalidSteps,
    isActive: false,
  });

  // Deactivation must never run the activation validator.
  await asUser.mutation(api.automations.setActive, { automationId, isActive: false });
  expect((await t.run((ctx) => ctx.db.get(automationId)))!.isActive).toBe(false);
});

// ============================================================
// remove
// ============================================================

test("remove deletes the automation and cascades its steps and logs", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "x",
    triggerType: "new_message_received",
    steps: nestedSteps,
  });
  await seedLog(t, { accountId, automationId });
  await seedLog(t, { accountId, automationId });

  await asUser.mutation(api.automations.remove, { automationId });

  expect(await t.run((ctx) => ctx.db.get(automationId))).toBeNull();
  const steps = await t.run((ctx) => ctx.db.query("automationSteps").collect());
  expect(steps).toHaveLength(0);
  const logs = await t.run((ctx) => ctx.db.query("automationLogs").collect());
  expect(logs).toHaveLength(0);
});

test("remove throws NOT_FOUND (not a silent no-op) for another account's automation, and leaves it in place", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const automationId = await asAlice.mutation(api.automations.create, {
    name: "Alice's",
    triggerType: "new_message_received",
  });

  await expect(
    asBob.mutation(api.automations.remove, { automationId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
  expect(await t.run((ctx) => ctx.db.get(automationId))).not.toBeNull();
});

test("remove throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const automationId = await asOwner.mutation(api.automations.create, {
    name: "x",
    triggerType: "new_message_received",
  });
  const { asUser: asViewer } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asViewer.mutation(api.automations.remove, { automationId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

// ============================================================
// duplicate
// ============================================================

test("duplicate deep-copies the automation and its step tree with fresh ids", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const originalId = await asUser.mutation(api.automations.create, {
    name: "Original",
    triggerType: "tag_added",
    triggerConfig: { tag_id: "vip" },
    isActive: true,
    steps: nestedSteps,
  });

  const copyId = await asUser.mutation(api.automations.duplicate, {
    automationId: originalId,
  });
  expect(copyId).not.toBe(originalId);

  const copy = await t.run((ctx) => ctx.db.get(copyId));
  expect(copy!.name).toBe("Original (Copy)");
  expect(copy!.accountId).toBe(accountId);
  expect(copy!.isActive).toBe(false);
  expect(copy!.executionCount).toBe(0);
  expect(copy!.triggerType).toBe("tag_added");

  // Original steps must be untouched, and the copy's own rows are new ids.
  const originalRows = await t.run((ctx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", originalId))
      .collect(),
  );
  expect(originalRows).toHaveLength(3);

  const copyResult = await asUser.query(api.automations.get, { automationId: copyId });
  expect(copyResult.steps).toHaveLength(1);
  expect(copyResult.steps[0]!.step_type).toBe("condition");
  expect(copyResult.steps[0]!.id).not.toBe(originalRows.find((r) => r.stepType === "condition")!._id);
  expect(copyResult.steps[0]!.branches.yes[0]!.step_type).toBe("add_tag");
  expect(copyResult.steps[0]!.branches.no[0]!.step_type).toBe("send_message");
});

test("duplicate throws NOT_FOUND for another account's automation", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const automationId = await asAlice.mutation(api.automations.create, {
    name: "Alice's",
    triggerType: "new_message_received",
  });

  await expect(
    asBob.mutation(api.automations.duplicate, { automationId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
});

test("duplicate throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const automationId = await asOwner.mutation(api.automations.create, {
    name: "x",
    triggerType: "new_message_received",
  });
  const { asUser: asViewer } = await seedAccountMember(t, {
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });

  await expect(
    asViewer.mutation(api.automations.duplicate, { automationId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

// ============================================================
// logs
// ============================================================

test("logs returns only the caller's own account's logs, newest-first", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const { asUser: asBob, accountId: bobAccountId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const aliceAutomationId = await asAlice.mutation(api.automations.create, {
    name: "Alice's",
    triggerType: "new_message_received",
  });
  const bobAutomationId = await asBob.mutation(api.automations.create, {
    name: "Bob's",
    triggerType: "new_message_received",
  });

  const log1 = await seedLog(t, { accountId: aliceAccountId, automationId: aliceAutomationId });
  const log2 = await seedLog(t, { accountId: aliceAccountId, automationId: aliceAutomationId });
  await seedLog(t, { accountId: bobAccountId, automationId: bobAutomationId });

  const aliceLogs = await asAlice.query(api.automations.logs, {});
  expect(aliceLogs.map((l) => l._id).sort()).toEqual([log1, log2].sort());
  expect(aliceLogs.every((l) => l.accountId === aliceAccountId)).toBe(true);

  const bobLogs = await asBob.query(api.automations.logs, {});
  expect(bobLogs).toHaveLength(1);
});

test("logs filters by automationId when given, and a foreign automationId yields nothing", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationA = await asUser.mutation(api.automations.create, {
    name: "A",
    triggerType: "new_message_received",
  });
  const automationB = await asUser.mutation(api.automations.create, {
    name: "B",
    triggerType: "new_message_received",
  });
  await seedLog(t, { accountId, automationId: automationA });
  await seedLog(t, { accountId, automationId: automationB });

  const forA = await asUser.query(api.automations.logs, { automationId: automationA });
  expect(forA).toHaveLength(1);
  expect(forA[0]!.automationId).toBe(automationA);

  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });
  const forForeign = await asBob.query(api.automations.logs, { automationId: automationA });
  expect(forForeign).toEqual([]);
});

test("logs respects the limit argument", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "A",
    triggerType: "new_message_received",
  });
  for (let i = 0; i < 5; i++) {
    await seedLog(t, { accountId, automationId });
  }

  const limited = await asUser.query(api.automations.logs, { limit: 2 });
  expect(limited).toHaveLength(2);
});

/**
 * Seeds three logs for `A` (oldest → newest) plus one for `B` that must never
 * appear in A's results. Shared by the two filtered-branch tests below, which
 * pin the ordering and the limit of the `automationId`-filtered read — neither
 * was covered, and both are contracts the `by_account_automation` index has to
 * preserve. Note the older sibling test asserts "newest-first" in its name but
 * `.sort()`s both sides, so it does not actually constrain order; these do.
 */
async function seedFilteredLogFixture(t: ReturnType<typeof convexTest>) {
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const automationA = await asUser.mutation(api.automations.create, {
    name: "A",
    triggerType: "new_message_received",
  });
  const automationB = await asUser.mutation(api.automations.create, {
    name: "B",
    triggerType: "new_message_received",
  });
  const oldest = await seedLog(t, { accountId, automationId: automationA });
  const middle = await seedLog(t, { accountId, automationId: automationA });
  const newest = await seedLog(t, { accountId, automationId: automationA });
  await seedLog(t, { accountId, automationId: automationB });

  return { asUser, automationA, oldest, middle, newest };
}

test("logs returns the automationId-filtered branch newest-first", async () => {
  const t = convexTest(schema, modules);
  const { asUser, automationA, oldest, middle, newest } =
    await seedFilteredLogFixture(t);

  const rows = await asUser.query(api.automations.logs, {
    automationId: automationA,
  });

  expect(rows.map((l) => l._id)).toEqual([newest, middle, oldest]);
});

test("logs applies the limit to the automationId-filtered branch", async () => {
  const t = convexTest(schema, modules);
  const { asUser, automationA, middle, newest } =
    await seedFilteredLogFixture(t);

  const rows = await asUser.query(api.automations.logs, {
    automationId: automationA,
    limit: 2,
  });

  expect(rows.map((l) => l._id)).toEqual([newest, middle]);
});
