/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { AccountRole } from "./lib/roles";
import { LOG_CASCADE_BATCH, RUN_COUNTS_STATUS_CAP } from "./automations";

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

/**
 * Duplicated from `automationsEngine.test.ts` rather than imported —
 * each `convex/*.test.ts` suite owns its own copy of its seed helpers
 * (see `seedAccountMember`'s own comment on this convention). Needed
 * here only for Task 5's cancellation tests, which have to park a real
 * run on a `wait` (via `internal.automationsEngine.runForTrigger`) and
 * that needs a contact to enrol.
 */
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
    role: "admin",
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
    role: "admin",
  });

  await expect(
    asUser.mutation(api.automations.create, {}),
  ).rejects.toMatchObject({ data: { code: "INVALID_INPUT" } });
});

test("create throws FORBIDDEN for a caller below the admin role", async () => {
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
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("create flattens a nested steps tree (condition + yes/no branches) into ordered automationSteps rows", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
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
    role: "admin",
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
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
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

test("update throws FORBIDDEN for a caller below the admin role", async () => {
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
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

test("update rejects flipping isActive to true when the trigger config is structurally invalid", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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
// stepKey — Task 10: stable per-step identity that survives replaceSteps'
// delete-then-reinsert on every save (see convex/schema.ts's
// automationSteps.stepKey comment).
// ============================================================

/**
 * Seeds an owner-role account member plus one automation whose
 * `nestedSteps` tree (condition + yes/no children, 3 rows) is already
 * saved — the fixture the stepKey tests below build on. Modelled on
 * `seedAccountMember` above; "owner" clears the `agent` floor every
 * mutation exercised here requires (and the `admin` floor `get` needs).
 */
async function seedAutomationForSteps(t: ReturnType<typeof convexTest>) {
  const { asUser: asOwner, accountId } = await seedAccountMember(t, {
    name: "Owner",
    email: "owner@example.com",
    role: "owner",
  });
  const automationId = await asOwner.mutation(api.automations.create, {
    name: "Stepful",
    triggerType: "new_message_received",
    steps: nestedSteps,
  });
  return { automationId, asOwner, accountId };
}

test("a step's key survives a save that rewrites every step row", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);

  const before = await t.run(async (ctx) =>
    ctx.db.query("automationSteps").collect(),
  );
  const keysBefore = before.map((s) => s.stepKey).sort();
  expect(keysBefore.every(Boolean)).toBe(true);

  // A rename-only save still sends the full steps array, which deletes and
  // reinserts every row — the exact churn this key exists to survive.
  await asOwner.mutation(api.automations.update, {
    automationId,
    name: "Renamed",
    steps: before.map((s) => ({
      id: s.stepKey,
      step_type: s.stepType,
      step_config: s.stepConfig,
    })),
  });

  const after = await t.run(async (ctx) =>
    ctx.db.query("automationSteps").collect(),
  );
  expect(after.map((s) => s.stepKey).sort()).toEqual(keysBefore);
  // Ids genuinely churned — proving the key is what survived, not the row.
  expect(after.map((s) => s._id)).not.toEqual(before.map((s) => s._id));
});

test("a step with no incoming key is minted a fresh one", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);

  await asOwner.mutation(api.automations.update, {
    automationId,
    steps: [{ step_type: "send_message", step_config: { text: "hi" } }],
  });

  const rows = await t.run(async (ctx) =>
    ctx.db.query("automationSteps").collect(),
  );
  expect(rows).toHaveLength(1);
  expect(typeof rows[0]!.stepKey).toBe("string");
  expect(rows[0]!.stepKey!.length).toBeGreaterThan(0);
});

test("two steps never share a key", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);

  await asOwner.mutation(api.automations.update, {
    automationId,
    steps: [
      { step_type: "send_message", step_config: { text: "a" } },
      { step_type: "send_message", step_config: { text: "b" } },
    ],
  });

  const rows = await t.run(async (ctx) =>
    ctx.db.query("automationSteps").collect(),
  );
  const keys = rows.map((s) => s.stepKey);
  expect(new Set(keys).size).toBe(keys.length);
});

/**
 * Rewrites every step row of `automationId` into the PRE-migration shape —
 * `stepKey` absent — which is exactly how rows written before that field
 * existed look on a real deployment. `db.patch(id, { stepKey: undefined })`
 * removes the field outright (Convex's documented way to clear an optional
 * field) rather than storing a literal null, which the table validator
 * would reject. Returns the untouched rows so a test can key engine-side
 * writes on the same `_id` the engine's own `stepKey ?? _id` fallback
 * would have used for them.
 */
async function stripStepKeys(
  t: ReturnType<typeof convexTest>,
  automationId: Id<"automations">,
): Promise<Doc<"automationSteps">[]> {
  // `ctx` annotated explicitly (same as `seedActivatableAutomation` below):
  // this function's own declared return type fixes `t.run`'s generic, which
  // otherwise leaves `ctx` on the default data model and hides the table's
  // indexes from `withIndex`.
  return await t.run(async (ctx: MutationCtx) => {
    const rows = await ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .collect();
    for (const row of rows) {
      await ctx.db.patch(row._id, { stepKey: undefined });
    }
    return rows;
  });
}

test("get derives a legacy step's effective key from its row id", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);
  await stripStepKeys(t, automationId);

  const { steps } = await asOwner.query(api.automations.get, { automationId });

  // schema.ts's `automationSteps.stepKey` states the contract outright:
  // "Readers derive an effective key as `stepKey ?? _id`". The WRITE side
  // already honours it (automationsEngine.ts writes `step.stepKey ??
  // step._id` for both `automationStepStats.stepKey` and a waiting run's
  // `currentStepKey`), so a read path that hands back a bare `undefined`
  // leaves the two permanently unjoinable. `node.id` IS the row's `_id`
  // here — `buildStepsTree` carries it to resolve `parentStepId` edges —
  // so this asserts the fallback landed on the exact value the engine used.
  const root = steps[0]!;
  expect(root.stepKey).toBe(root.id);
  expect(root.branches.yes[0]!.stepKey).toBe(root.branches.yes[0]!.id);
  expect(root.branches.no[0]!.stepKey).toBe(root.branches.no[0]!.id);
});

test("get leaves a step that already has a real key untouched", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);

  const rows = await t.run((ctx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .collect(),
  );
  const byId = new Map(rows.map((r) => [r._id as string, r.stepKey]));

  const { steps } = await asOwner.query(api.automations.get, { automationId });

  // The fallback must be a fallback, never an override: a minted key still
  // wins over the row id, which is the whole point of `stepKey` existing.
  const root = steps[0]!;
  expect(root.stepKey).toBe(byId.get(root.id));
  expect(root.stepKey).not.toBe(root.id);
});

test("a legacy step's effective key becomes its durable key on the next save", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);
  await stripStepKeys(t, automationId);

  const { steps } = await asOwner.query(api.automations.get, { automationId });
  const effectiveKey = steps[0]!.stepKey;

  // Exactly what `automation-builder.tsx`'s `toApiSteps` posts back: `id`
  // is the `step_key` its `fromServerSteps` read off this very tree. Without
  // the read-side fallback that key is `undefined`, `toApiSteps` substitutes
  // a fresh client-local `cid`, and every counter the engine accumulated
  // under the old `_id` is orphaned by the save rather than adopted by it.
  await asOwner.mutation(api.automations.update, {
    automationId,
    steps: [
      { id: effectiveKey, step_type: "send_message", step_config: { text: "hi" } },
    ],
  });

  const after = await t.run((ctx) => ctx.db.query("automationSteps").collect());
  expect(after).toHaveLength(1);
  expect(after[0]!.stepKey).toBe(effectiveKey);
});

test("a legacy step's accumulated stats and waiting count join to the key get exposes", async () => {
  const t = convexTest(schema, modules);
  const { automationId, accountId, asOwner } = await seedAutomationForSteps(t);
  const rows = await stripStepKeys(t, automationId);
  const rootRow = rows.find((r) => !r.parentStepId)!;

  // Both writes reproduce what the engine does for a key-less step: it
  // resolves `step.stepKey ?? step._id`, so the row `_id` is what lands in
  // `automationStepStats.stepKey` (via `appendLogResults`) and in a parked
  // run's `currentStepKey` (via `markRunWaiting`).
  const now = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.insert("automationStepStats", {
      accountId,
      automationId,
      stepKey: rootRow._id,
      reached: 4,
      sent: 3,
      failed: 1,
      updatedAt: now,
    });
    await ctx.db.insert("automationRuns", {
      accountId,
      automationId,
      status: "waiting",
      currentStepKey: rootRow._id,
      nextPosition: 1,
      resumeAt: now + 60_000,
      startedAt: now,
      updatedAt: now,
    });
  });

  const { steps } = await asOwner.query(api.automations.get, { automationId });
  const stats = await asOwner.query(api.automations.stepStats, { automationId });

  // The user-visible payoff, and the join the builder UI's per-step chips
  // and the waiting queue's step label both do: look a tree node's key up
  // in `stepStats`. Real data exists for this step; before the read-side
  // fallback the node's key was `undefined` and the lookup silently missed.
  const found = stats.find((s) => s.stepKey === steps[0]!.stepKey);
  expect(found).toMatchObject({ reached: 4, sent: 3, failed: 1, waiting: 1 });
});

// ============================================================
// setActive
// ============================================================

test("setActive toggles isActive and stamps updatedAt", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
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
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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
    role: "admin",
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

/**
 * Inserts `count` log rows in ONE `t.run`. The per-row `seedLog` above would
 * be a separate transaction each, which is far too slow for the
 * cascade-overflow fixtures below (hundreds of rows apiece).
 */
async function seedManyLogs(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    automationId: Id<"automations">;
    count: number;
  },
) {
  await t.run(async (ctx) => {
    for (let i = 0; i < opts.count; i++) {
      await ctx.db.insert("automationLogs", {
        accountId: opts.accountId,
        automationId: opts.automationId,
        triggerEvent: "new_message_received",
        stepsExecuted: [],
        status: "success",
      });
    }
  });
}

const OVERFLOW = LOG_CASCADE_BATCH + 10;

async function seedAutomationWithLogOverflow(t: ReturnType<typeof convexTest>) {
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "x",
    triggerType: "new_message_received",
    steps: nestedSteps,
  });
  await seedManyLogs(t, { accountId, automationId, count: OVERFLOW });
  return { asUser, accountId, automationId };
}

const countLogs = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) => (await ctx.db.query("automationLogs").collect()).length);

/**
 * The write-limit fix. `remove` used to `.collect()` every log the automation
 * had ever written and delete them all in ONE transaction, so an automation
 * with more logs than Convex's per-transaction budget could not be deleted at
 * all — the mutation threw every time, permanently. It now deletes one bounded
 * batch and hands the remainder to a scheduled purge.
 *
 * convex-test does not enforce Convex's real transaction limits, so this
 * asserts the mechanism rather than the throw: exactly the overflow is left
 * behind, which is only true if the delete was bounded.
 */
test("remove deletes one bounded batch of logs and defers the overflow", async () => {
  const t = convexTest(schema, modules);
  const { asUser, automationId } = await seedAutomationWithLogOverflow(t);

  await asUser.mutation(api.automations.remove, { automationId });

  expect(await countLogs(t)).toBe(OVERFLOW - LOG_CASCADE_BATCH);
});

test("the scheduled purge drains the log overflow remove left behind", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const { asUser, automationId } = await seedAutomationWithLogOverflow(t);

    await asUser.mutation(api.automations.remove, { automationId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await countLogs(t)).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

/**
 * The overflow fixture above needs only ONE purge run, so it would still pass
 * if the purge deleted its batch and never re-scheduled itself. This seeds
 * enough for three passes (remove + two continuations), which fails outright
 * unless the purge chains. That self-reschedule is the part most likely to be
 * wrong, and the part whose absence would silently strand rows forever.
 */
test("the purge chains across as many batches as the backlog needs", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
    const automationId = await asUser.mutation(api.automations.create, {
      name: "x",
      triggerType: "new_message_received",
      steps: nestedSteps,
    });
    await seedManyLogs(t, {
      accountId,
      automationId,
      count: LOG_CASCADE_BATCH * 2 + 10,
    });

    await asUser.mutation(api.automations.remove, { automationId });
    expect(await countLogs(t)).toBe(LOG_CASCADE_BATCH + 10);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await countLogs(t)).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

/**
 * The user-visible half of the delete stays synchronous — only the log
 * cleanup is deferred. An automation that vanished from the list but came
 * back on refresh because its logs were still draining would be a worse bug
 * than the one being fixed.
 */
test("remove takes the automation and its steps immediately despite a log backlog", async () => {
  const t = convexTest(schema, modules);
  const { asUser, automationId } = await seedAutomationWithLogOverflow(t);

  await asUser.mutation(api.automations.remove, { automationId });

  expect(await t.run((ctx) => ctx.db.get(automationId))).toBeNull();
  const steps = await t.run((ctx) => ctx.db.query("automationSteps").collect());
  expect(steps).toHaveLength(0);
});

test("remove throws NOT_FOUND (not a silent no-op) for another account's automation, and leaves it in place", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
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

test("remove throws FORBIDDEN for a caller below the admin role", async () => {
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
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

// ============================================================
// duplicate
// ============================================================

test("duplicate deep-copies the automation and its step tree with fresh ids", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
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

test("duplicating an automation gives its steps fresh keys", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);
  const originalRows = await t.run(async (ctx) =>
    ctx.db.query("automationSteps").collect(),
  );
  const originalKeys = originalRows.map((s) => s.stepKey);
  const originalIds = originalRows.map((s) => s._id);

  const copyId = await asOwner.mutation(api.automations.duplicate, { automationId });

  const copyKeys = (
    await t.run(async (ctx) =>
      ctx.db
        .query("automationSteps")
        .withIndex("by_automation", (q) => q.eq("automationId", copyId))
        .collect(),
    )
  ).map((s) => s.stepKey);

  // Without `stripTreeIds`, `insertStepsTree` reuses `buildStepsTree`'s
  // tree-reconstruction `id` — the ORIGINAL row's real `_id` — as the
  // clone's `stepKey` verbatim (a Convex id, never a UUID). Comparing
  // `copyKeys` against `originalKeys` alone can't catch that: an
  // `_id`-shaped string never equals a `stepKey`-shaped (UUID) one
  // either way, so that comparison passes vacuously whether or not the
  // leak is happening. Assert the property a freshly minted key must
  // actually have (UUID v4 shape), and separately that no clone key IS
  // one of the original rows' real ids — the exact leak `stripTreeIds`
  // prevents.
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const key of copyKeys) {
    expect(key).toMatch(UUID_V4);
  }
  expect(originalIds.some((id) => copyKeys.includes(id))).toBe(false);
  expect(copyKeys.some((k) => originalKeys.includes(k))).toBe(false);
});

test("duplicating a legacy automation still mints fresh keys, not the originals' row ids", async () => {
  const t = convexTest(schema, modules);
  const { automationId, asOwner } = await seedAutomationForSteps(t);
  const originalRows = await stripStepKeys(t, automationId);
  const originalIds = originalRows.map((s) => s._id);

  const copyId = await asOwner.mutation(api.automations.duplicate, { automationId });

  const copyKeys = (
    await t.run(async (ctx) =>
      ctx.db
        .query("automationSteps")
        .withIndex("by_automation", (q) => q.eq("automationId", copyId))
        .collect(),
    )
  ).map((s) => s.stepKey);

  // `duplicate` is the one `toStepRow` call site where the read-side
  // `stepKey ?? _id` fallback could do harm: it feeds `insertStepsTree`,
  // which reuses any non-empty incoming key verbatim. For a legacy step the
  // fallback makes that key the ORIGINAL row's `_id`, so a clone could
  // silently adopt the original's stats. `stripTreeIds` drops it — this
  // pins that, since the test above only ever exercises keyed rows.
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const key of copyKeys) {
    expect(key).toMatch(UUID_V4);
  }
  expect(originalIds.some((id) => copyKeys.includes(id))).toBe(false);
});

test("duplicate throws NOT_FOUND for another account's automation", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });
  const automationId = await asAlice.mutation(api.automations.create, {
    name: "Alice's",
    triggerType: "new_message_received",
  });

  await expect(
    asBob.mutation(api.automations.duplicate, { automationId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
});

test("duplicate throws FORBIDDEN for a caller below the admin role", async () => {
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
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

// ============================================================
// logs
// ============================================================

test("logs returns only the caller's own account's logs, newest-first", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: aliceAccountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { asUser: asBob, accountId: bobAccountId } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
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
    role: "admin",
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
    role: "admin",
  });
  const forForeign = await asBob.query(api.automations.logs, { automationId: automationA });
  expect(forForeign).toEqual([]);
});

test("logs respects the limit argument", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
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
    role: "admin",
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

test("logs clamps a huge limit to 200 so one request can't take the whole log table", async () => {
  // `.take(limit)` bounds the read only as tightly as the limit itself: an
  // unclamped caller-supplied 100_000 reads the account's whole log history
  // again. With `documentsRead` capped, the unclamped take of 260 seeded rows
  // throws "Scanned too many documents"; the clamped `.take(200)` does not.
  const t = convexTest({
    schema,
    modules,
    transactionLimits: { documentsRead: 230 },
  });
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "A",
    triggerType: "new_message_received",
  });
  await t.run(async (ctx) => {
    for (let i = 0; i < 260; i++) {
      await ctx.db.insert("automationLogs", {
        accountId,
        automationId,
        triggerEvent: "new_message_received",
        stepsExecuted: [],
        status: "success",
      });
    }
  });

  const rows = await asUser.query(api.automations.logs, { limit: 100_000 });
  expect(rows).toHaveLength(200);
});

test("logs clamps a non-positive limit up to 1 rather than returning nothing", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "A",
    triggerType: "new_message_received",
  });
  await seedLog(t, { accountId, automationId });
  await seedLog(t, { accountId, automationId });

  // Unclamped, `.take(0)` returned []; the clamp floors the limit at 1.
  const rows = await asUser.query(api.automations.logs, { limit: 0 });
  expect(rows).toHaveLength(1);
});

// ============================================================
// Read-side role floor
//
// `/automations` and `/flows` are absent from `SUPERVISOR_NAV` in
// src/lib/auth/roles.ts, so `canAccessNav` admits only admin/owner — but
// these reads carried no role check, leaving automation and flow
// definitions (plus their execution logs) readable by a viewer. Floor set
// to admin to match the nav. Every frontend caller already lives on those
// admin-only pages.
// ============================================================

async function seedFloorRole(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  role: "viewer" | "agent" | "supervisor" | "admin",
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: role, email: `${role}@floor.test` }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId,
      accountId,
      role,
      fullName: role,
      email: `${role}@floor.test`,
    }),
  );
  return t.withIdentity({ subject: `${userId}|s-${role}` });
}

test("automations list/get/logs throw FORBIDDEN below admin and succeed for an admin", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner, accountId } = await seedAccountMember(t, {
    name: "Olive",
    email: "olive@example.com",
    role: "owner",
  });
  const automationId = await asOwner.mutation(api.automations.create, {
    name: "A",
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["hi"] },
    steps: [],
  });

  const asSupervisor = await seedFloorRole(t, accountId, "supervisor");
  await expect(asSupervisor.query(api.automations.list, {})).rejects.toMatchObject({
    data: { code: "FORBIDDEN", min: "admin" },
  });
  await expect(
    asSupervisor.query(api.automations.get, { automationId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
  await expect(asSupervisor.query(api.automations.logs, {})).rejects.toMatchObject({
    data: { code: "FORBIDDEN", min: "admin" },
  });

  const asAdmin = await seedFloorRole(t, accountId, "admin");
  await expect(asAdmin.query(api.automations.list, {})).resolves.toBeDefined();
});

// ============================================================
// Task 5 — cancellation paths 1 (setActive), 2 (remove) and 3 (update's
// replaceSteps branch), plus stopOnReply persistence. Path 4
// (contacts/contactNotes do-not-contact) lives in contactNotes.test.ts;
// path 5 (ingest reply) lives in ingest.test.ts.
// ============================================================

test("create persists stopOnReply, and omitting it leaves the field unset", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const withFlag = await asUser.mutation(api.automations.create, {
    name: "x",
    triggerType: "new_message_received",
    stopOnReply: true,
  });
  expect((await t.run((ctx) => ctx.db.get(withFlag)))!.stopOnReply).toBe(true);

  const withoutFlag = await asUser.mutation(api.automations.create, {
    name: "y",
    triggerType: "new_message_received",
  });
  expect((await t.run((ctx) => ctx.db.get(withoutFlag)))!.stopOnReply).toBeUndefined();
});

test("update patches stopOnReply when supplied, independent of steps", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const automationId = await asUser.mutation(api.automations.create, {
    name: "x",
    triggerType: "new_message_received",
  });

  await asUser.mutation(api.automations.update, { automationId, stopOnReply: true });
  expect((await t.run((ctx) => ctx.db.get(automationId)))!.stopOnReply).toBe(true);

  await asUser.mutation(api.automations.update, { automationId, stopOnReply: false });
  expect((await t.run((ctx) => ctx.db.get(automationId)))!.stopOnReply).toBe(false);
});

/** Parks a real run on a `wait` step for `automationId`/`contactId`,
 *  going through the real engine dispatch (`runForTrigger`) so the row
 *  carries a genuine `scheduledFnId` — required by the zero-sends tests
 *  below, which need an actual scheduled function to survive (or not). */
async function parkOnWait(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    automationId: Id<"automations">;
    contactId: Id<"contacts">;
    conversationId?: Id<"conversations">;
    triggerType: string;
    triggerConfig: unknown;
    messageText: string;
  },
): Promise<Doc<"automationRuns"> | null> {
  await t.action(internal.automationsEngine.runForTrigger, {
    accountId: opts.accountId,
    triggerType: opts.triggerType,
    contactId: opts.contactId,
    context: { messageText: opts.messageText, conversationId: opts.conversationId },
  });
  return await t.run((ctx: QueryCtx) =>
    ctx.db
      .query("automationRuns")
      .withIndex("by_account_automation", (q) =>
        q.eq("accountId", opts.accountId).eq("automationId", opts.automationId),
      )
      .unique(),
  );
}

test("setActive(false) cancels the automation's waiting runs", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
    const { contactId } = await seedContactAndConversation(t, accountId, "15550004001");

    const automationId = await asUser.mutation(api.automations.create, {
      name: "Nudge",
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      isActive: true,
      steps: [
        { step_type: "wait", step_config: { amount: 1, unit: "minutes" } },
        { step_type: "send_message", step_config: { text: "hi" } },
      ],
    });

    const parked = await parkOnWait(t, {
      accountId,
      automationId,
      contactId,
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      messageText: "remind me",
    });
    expect(parked?.status).toBe("waiting");

    await asUser.mutation(api.automations.setActive, { automationId, isActive: false });
    // `setActive` only SCHEDULES `cancelRunsForAutomation` (a mutation
    // can't call another mutation inline — only `ctx.scheduler` reaches
    // it) — so at this point two scheduled functions are both pending:
    // the freshly-scheduled cancellation (delay 0) and the original
    // wait's own far-future resume. A single `vi.runAllTimers()` pass can
    // start BOTH inside the same synchronous sweep and interleave their
    // async continuations, letting the cancellation's
    // `ctx.scheduler.cancel` land while the resume is already
    // `"inProgress"` — convex-test's simulator then throws its own
    // invariant error when the resume tries to close itself out, which
    // hangs `finishAllScheduledFunctions` for its full 10000-pump budget.
    // Draining the delay-0 cancellation to full completion FIRST (nothing
    // else is in flight yet, so there is nothing to race) closes that
    // window before the resume's own timer is ever considered due. This
    // never happens in real Convex, where the delay-0 job settles in
    // milliseconds — long before a wait's real-time delay elapses.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const run = await t.run((ctx) => ctx.db.get(parked!._id));
    expect(run?.status).toBe("cancelled");
    expect(run?.errorMessage).toMatch(/deactivated/);
  } finally {
    vi.useRealTimers();
  }
});

// The single most important test in this task: deactivating must
// produce ZERO outbound sends from a run that was already parked and
// scheduled to resume — not merely relabel the row.
test("setActive(false)'s cancellation stops the parked run's scheduled resume from sending", async () => {
  vi.useFakeTimers();
  try {
    process.env.CONVEX_META_DRY_RUN = "1";
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
    const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15550004002");
    await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

    const automationId = await asUser.mutation(api.automations.create, {
      name: "Nudge",
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      isActive: true,
      steps: [
        { step_type: "wait", step_config: { amount: 1, unit: "minutes" } },
        { step_type: "send_message", step_config: { text: "Still there?" } },
      ],
    });

    await parkOnWait(t, {
      accountId,
      automationId,
      contactId,
      conversationId,
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      messageText: "remind me",
    });

    await asUser.mutation(api.automations.setActive, { automationId, isActive: false });
    // Drain the delay-0 cancellation to completion before the far-future
    // resume's timer is ever considered due — see the previous test's own
    // comment on this exact pair for why a single `vi.runAllTimers()`
    // pass here would race the two scheduled functions against each
    // other under convex-test's simulator.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .collect(),
    );
    expect(messages).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("update cancels the automation's waiting runs when the save replaces its steps", async () => {
  vi.useFakeTimers();
  try {
    process.env.CONVEX_META_DRY_RUN = "1";
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
    const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15550004003");
    await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

    const automationId = await asUser.mutation(api.automations.create, {
      name: "Nudge",
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      isActive: true,
      steps: [
        { step_type: "wait", step_config: { amount: 1, unit: "minutes" } },
        { step_type: "send_message", step_config: { text: "hi" } },
      ],
    });

    const parked = await parkOnWait(t, {
      accountId,
      automationId,
      contactId,
      conversationId,
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      messageText: "remind me",
    });
    expect(parked?.status).toBe("waiting");

    // Two steps, not one: the OLD run's suspension tuple points at
    // position 1 (one past the old `wait`, which `replaceSteps` just
    // deleted). A single-step replacement would land at position 0,
    // which the old resume's `nextPosition` filter would never reach
    // even if cancellation were completely broken — silently passing
    // the zero-sends assertion below for the wrong reason. Position 1
    // being a real `send_message` is what makes that assertion
    // load-bearing: an uncancelled resume against this NEW tree would
    // actually reach and send it.
    await asUser.mutation(api.automations.update, {
      automationId,
      steps: [
        { step_type: "send_message", step_config: { text: "filler" } },
        { step_type: "send_message", step_config: { text: "updated" } },
      ],
    });
    // Same race, same fix as `setActive`'s own tests above: drain the
    // delay-0 cancellation before the far-future resume's timer is ever
    // considered due.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const run = await t.run((ctx) => ctx.db.get(parked!._id));
    expect(run?.status).toBe("cancelled");
    expect(run?.errorMessage).toMatch(/edited/);

    // The actual guarantee: not merely that the row says cancelled, but
    // that nothing reached the customer — including via the NEW step
    // tree the old resume's `nextPosition` would otherwise have landed
    // in (see the comment on the replacement steps above).
    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .collect(),
    );
    expect(messages).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("update leaves waiting runs alone when the save touches only metadata, not steps", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { contactId } = await seedContactAndConversation(t, accountId, "15550004004");

  const automationId = await asUser.mutation(api.automations.create, {
    name: "Nudge",
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
    isActive: true,
    steps: [
      { step_type: "wait", step_config: { amount: 1, unit: "minutes" } },
      { step_type: "send_message", step_config: { text: "hi" } },
    ],
  });

  const parked = await parkOnWait(t, {
    accountId,
    automationId,
    contactId,
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
    messageText: "remind me",
  });
  expect(parked?.status).toBe("waiting");

  // Name AND stopOnReply, deliberately no `steps` key at all.
  await asUser.mutation(api.automations.update, {
    automationId,
    name: "Renamed",
    stopOnReply: true,
  });

  const run = await t.run((ctx) => ctx.db.get(parked!._id));
  expect(run?.status).toBe("waiting");
});

/** Mirrors `automation-builder.tsx`'s own `toApiSteps` — round-trips
 *  `stepKey` as `id`, recursing into `branches` — so a test can build
 *  the EXACT payload the real builder sends for an unedited save
 *  (`get`'s returned tree, converted straight back to the wire shape).
 *  Duplicated here rather than imported: `toApiSteps` lives in a
 *  `.tsx` component file, out of reach for a `convex/*.test.ts` suite. */
function toApiStepsLikeBuilder(
  nodes: Array<{
    stepKey?: string | null;
    step_type: string;
    step_config: Record<string, unknown>;
    branches?: { yes: unknown[]; no: unknown[] };
  }>,
): unknown[] {
  return nodes.map((n) => ({
    id: n.stepKey ?? undefined,
    step_type: n.step_type,
    step_config: n.step_config,
    branches: n.branches
      ? {
          yes: toApiStepsLikeBuilder(n.branches.yes as typeof nodes),
          no: toApiStepsLikeBuilder(n.branches.no as typeof nodes),
        }
      : undefined,
  }));
}

// Fix wave (2026-08): the test above proves the guard works when the
// caller omits `steps` — but `automation-builder.tsx`'s `save()` NEVER
// omits it (line ~942: `toApiSteps(state.steps)` is sent unconditionally
// for every save, including a pure rename or a `stopOnReply` toggle).
// So the `steps !== undefined` guard the mutation actually runs on is
// dead in practice: the real UI's rename-only save looks EXACTLY like
// this test, not like the one above. This is the shape that must not
// cancel.
test("update leaves waiting runs alone on a rename-only save even though the real builder always resends the unchanged steps array", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    // "owner": needs both `update`'s "agent" floor and `get`'s "admin"
    // floor (the real builder page loads via `get`, then saves via
    // `update` — a single role that clears both keeps this test closest
    // to how an actual user session drives it).
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "owner",
    });
    const { contactId } = await seedContactAndConversation(t, accountId, "15550004006");

    const automationId = await asUser.mutation(api.automations.create, {
      name: "Nudge",
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      isActive: true,
      steps: [
        { step_type: "wait", step_config: { amount: 1, unit: "minutes" } },
        { step_type: "send_message", step_config: { text: "hi" } },
      ],
    });

    const parked = await parkOnWait(t, {
      accountId,
      automationId,
      contactId,
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      messageText: "remind me",
    });
    expect(parked?.status).toBe("waiting");

    // Exactly what the real builder does: load the current tree, then
    // resend it byte-for-byte (round-tripping each step's stable key)
    // alongside the one field the user actually changed.
    const loaded = await asUser.query(api.automations.get, { automationId });
    await asUser.mutation(api.automations.update, {
      automationId,
      name: "Renamed",
      steps: toApiStepsLikeBuilder(loaded.steps),
    });

    // A buggy `update` only SCHEDULES its cancellation (`ctx.scheduler.
    // runAfter(0, ...)`) rather than cancelling inline — draining that
    // delay-0 job is what makes this assertion load-bearing rather than
    // trivially true because nothing has had a chance to run yet.
    // Deliberately NOT `finishAllScheduledFunctions(vi.runAllTimers)`
    // (unlike the genuinely-different-steps test below): that would also
    // advance the clock far enough to fire the run's own genuine 1-minute
    // wait, which — correctly NOT cancelled — would carry the run on to
    // "running"/"completed" on its own and make a `toBe("waiting")`
    // assertion fail for an unrelated reason.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();

    const run = await t.run((ctx) => ctx.db.get(parked!._id));
    expect(run?.status).toBe("waiting");
    expect(run?.errorMessage).toBeUndefined();

    // The save genuinely renamed it — proves this isn't passing because
    // the mutation call itself silently no-op'd.
    expect((await t.run((ctx) => ctx.db.get(automationId)))!.name).toBe("Renamed");
  } finally {
    vi.useRealTimers();
  }
});

test("update still cancels waiting runs when a resent steps array is genuinely different, not just present", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "owner", // needs `get`'s "admin" floor too — see the test above
    });
    const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15550004007");
    await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

    const automationId = await asUser.mutation(api.automations.create, {
      name: "Nudge",
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      isActive: true,
      steps: [
        { step_type: "wait", step_config: { amount: 1, unit: "minutes" } },
        { step_type: "send_message", step_config: { text: "hi" } },
      ],
    });

    const parked = await parkOnWait(t, {
      accountId,
      automationId,
      contactId,
      conversationId,
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      messageText: "remind me",
    });
    expect(parked?.status).toBe("waiting");

    // Round-tripped keys, but the wait's OWN config genuinely changed
    // (10 minutes instead of 1) — a real structural edit, not a no-op.
    const loaded = await asUser.query(api.automations.get, { automationId });
    const resent = toApiStepsLikeBuilder(loaded.steps) as Array<{
      step_type: string;
      step_config: Record<string, unknown>;
    }>;
    resent[0]!.step_config = { amount: 10, unit: "minutes" };
    await asUser.mutation(api.automations.update, { automationId, steps: resent });

    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const run = await t.run((ctx) => ctx.db.get(parked!._id));
    expect(run?.status).toBe("cancelled");
    expect(run?.errorMessage).toMatch(/edited/);
  } finally {
    vi.useRealTimers();
  }
});

// Fix wave (2026-08), finding 5: `update({ isActive: false })` — with NO
// `steps` at all — is a public `accountMutation` that deactivates
// without scheduling any cancellation. `setActive(false)` (tested just
// above) has always done this correctly; `update` never did, latent
// only because the shipped UI always calls `setActive` for the toggle
// and always sends `steps` on every save (which, before finding 3's
// fix, cancelled for an unrelated reason on every edit — see the
// "leaves waiting runs alone on a rename-only save" test). Mirrors
// `setActive`'s own test almost exactly, via `update` instead.
test("update({ isActive: false }) with no steps cancels the automation's waiting runs, same as setActive(false)", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
    const { contactId } = await seedContactAndConversation(t, accountId, "15550004008");

    const automationId = await asUser.mutation(api.automations.create, {
      name: "Nudge",
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      isActive: true,
      steps: [
        { step_type: "wait", step_config: { amount: 1, unit: "minutes" } },
        { step_type: "send_message", step_config: { text: "hi" } },
      ],
    });

    const parked = await parkOnWait(t, {
      accountId,
      automationId,
      contactId,
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      messageText: "remind me",
    });
    expect(parked?.status).toBe("waiting");

    // No `steps` key at all — the shape finding 5 is specifically about.
    await asUser.mutation(api.automations.update, { automationId, isActive: false });
    // Same drain shape, and same reason, as `setActive`'s own test above.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const run = await t.run((ctx) => ctx.db.get(parked!._id));
    expect(run?.status).toBe("cancelled");
    expect(run?.errorMessage).toMatch(/deactivated/);
  } finally {
    vi.useRealTimers();
  }
});

test("remove's cancellation stops the parked run's scheduled resume from sending", async () => {
  vi.useFakeTimers();
  try {
    process.env.CONVEX_META_DRY_RUN = "1";
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
    const { contactId, conversationId } = await seedContactAndConversation(t, accountId, "15550004005");
    await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));

    const automationId = await asUser.mutation(api.automations.create, {
      name: "Nudge",
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      isActive: true,
      steps: [
        { step_type: "wait", step_config: { amount: 1, unit: "minutes" } },
        { step_type: "send_message", step_config: { text: "Still there?" } },
      ],
    });

    await parkOnWait(t, {
      accountId,
      automationId,
      contactId,
      conversationId,
      triggerType: "keyword_match",
      triggerConfig: { keywords: ["remind"], match_type: "contains" },
      messageText: "remind me",
    });

    await asUser.mutation(api.automations.remove, { automationId });
    // Same race, same fix as `setActive`'s own tests above: drain the
    // delay-0 cancellation before the far-future resume's timer is ever
    // considered due.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .collect(),
    );
    expect(messages).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("remove purges the automation's automationRuns and automationStepStats rows, batching across overflow", async () => {
  vi.useFakeTimers();
  try {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, {
      name: "Alice",
      email: "alice@example.com",
      role: "admin",
    });
    const automationId = await asUser.mutation(api.automations.create, {
      name: "x",
      triggerType: "new_message_received",
      steps: validSteps,
    });

    const runOverflow = LOG_CASCADE_BATCH + 5;
    const statOverflow = LOG_CASCADE_BATCH + 3;
    await t.run(async (ctx) => {
      for (let i = 0; i < runOverflow; i++) {
        await ctx.db.insert("automationRuns", {
          accountId,
          automationId,
          status: "completed",
          nextPosition: 1,
          startedAt: Date.now(),
          updatedAt: Date.now(),
          endedAt: Date.now(),
        });
      }
      for (let i = 0; i < statOverflow; i++) {
        await ctx.db.insert("automationStepStats", {
          accountId,
          automationId,
          stepKey: `step-${i}`,
          reached: 1,
          sent: 1,
          failed: 0,
          updatedAt: Date.now(),
        });
      }
    });

    await asUser.mutation(api.automations.remove, { automationId });

    const countRuns = () => t.run(async (ctx) => (await ctx.db.query("automationRuns").collect()).length);
    const countStats = () =>
      t.run(async (ctx) => (await ctx.db.query("automationStepStats").collect()).length);

    // One bounded batch taken immediately, same as the existing log
    // cascade — the rest is left for the scheduled purge to drain.
    expect(await countRuns()).toBe(runOverflow - LOG_CASCADE_BATCH);
    expect(await countStats()).toBe(statOverflow - LOG_CASCADE_BATCH);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await countRuns()).toBe(0);
    expect(await countStats()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

// ============================================================
// Task 7 — runCounts (on `list`), `stepStats`, `waitingRuns`, `cancelRun`.
//
// NOTE for future readers diffing this against the task-7 brief: the
// brief's own code snippets name these fields `stepId`/`currentStepId`.
// The live schema (Task 10, already merged by the time this task
// landed) renamed both to stable string keys — `automationStepStats.
// stepKey` and `automationRuns.currentStepKey` — because a step's row
// id churns on every builder save (see `replaceSteps` above) and
// anything keyed on it silently detaches after one edit. Every test
// below uses the real field names.
// ============================================================

let statsFixtureCounter = 0;

/**
 * Seeds an owner-role account with one ACTIVE automation (`wait` then
 * `send_message`) plus a contact ready to trigger it via the
 * `keyword_match` trigger. "owner" clears both the `agent` floor
 * `cancelRun` needs and the `admin` floor the three read queries need,
 * so one seed fixture covers every test below.
 *
 * Counter-suffixed email/phone: the cross-account `cancelRun` test
 * calls this twice against the SAME `t`, and each call must land in
 * its own account — reusing `seedAccountMember`'s literal
 * "alice@example.com" style fixtures the way earlier describe blocks
 * do would collide the second time round.
 */
async function seedActivatableAutomation(t: ReturnType<typeof convexTest>) {
  const n = ++statsFixtureCounter;
  const { asUser: asOwner, accountId } = await seedAccountMember(t, {
    name: `StatsOwner${n}`,
    email: `stats-owner-${n}@example.com`,
    role: "owner",
  });
  const { contactId, conversationId } = await seedContactAndConversation(
    t,
    accountId,
    `1555900${String(n).padStart(4, "0")}`,
  );

  const automationId = await asOwner.mutation(api.automations.create, {
    name: "Stats fixture",
    triggerType: "keyword_match",
    triggerConfig: { keywords: ["remind"], match_type: "contains" },
    isActive: true,
    steps: [
      { step_type: "wait", step_config: { amount: 1, unit: "minutes" } },
      { step_type: "send_message", step_config: { text: "hi" } },
    ],
  });

  const steps = await t.run((ctx: QueryCtx) =>
    ctx.db
      .query("automationSteps")
      .withIndex("by_automation", (q) => q.eq("automationId", automationId))
      .collect(),
  );
  const waitStepKey = steps.find((s) => s.stepType === "wait")!.stepKey!;

  return { accountId, automationId, contactId, conversationId, asOwner, waitStepKey };
}

/**
 * Triggers `automationId` for `contactId` via the real engine dispatch,
 * parking the run on its `wait` step — a thin wrapper over `parkOnWait`
 * above that looks the automation's own trigger up from its row instead
 * of taking it as an argument, since every fixture
 * `seedActivatableAutomation` produces shares the same
 * `keyword_match`/"remind" trigger.
 */
async function runAutomation(
  t: ReturnType<typeof convexTest>,
  opts: { automationId: Id<"automations">; contactId: Id<"contacts"> },
): Promise<Doc<"automationRuns"> | null> {
  const automation = await t.run((ctx) => ctx.db.get(opts.automationId));
  if (!automation) throw new Error("runAutomation: automation not found");
  return await parkOnWait(t, {
    accountId: automation.accountId,
    automationId: opts.automationId,
    contactId: opts.contactId,
    triggerType: automation.triggerType,
    triggerConfig: automation.triggerConfig,
    messageText: "remind me",
  });
}

test("list returns run counts per automation", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });

  const rows = await asOwner.query(api.automations.list, {});
  expect(rows[0]!.runCounts).toMatchObject({ enrolled: 1, waiting: 1 });
});

// Fix wave (2026-08), finding 4: `list` used to `.collect()` EVERY run
// row of EVERY automation, inside a `Promise.all` over the whole
// account — unbounded in exactly the dimension (`automationRuns`, the
// fastest-growing table this phase adds, pruned only on automation
// deletion) that eventually throws once an account crosses Convex's
// per-transaction read limit, turning `/automations` into a hard error
// rather than degraded counts. This proves the read is now genuinely
// BOUNDED (a seeded batch past the cap does not inflate the count
// further) and that truncation is surfaced via `console.warn` rather
// than silently read as "complete" — this repo has had exactly that
// silent-truncation outage before (`/settings?tab=cron`, 143d66c).
test("list bounds run counts per status instead of collecting without limit, and logs when it truncates", async () => {
  const t = convexTest(schema, modules);
  const { automationId, accountId, asOwner } = await seedActivatableAutomation(t);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  const now = Date.now();
  // One MORE than the cap, all "waiting" — a real account would never
  // hand-seed this many, but a busy automation's live-run history can
  // reach it over time, which is exactly the shape this guards against.
  await t.run(async (ctx) => {
    for (let i = 0; i < RUN_COUNTS_STATUS_CAP + 1; i++) {
      await ctx.db.insert("automationRuns", {
        accountId,
        automationId,
        status: "waiting",
        nextPosition: 1,
        resumeAt: now + 60_000,
        startedAt: now,
        updatedAt: now,
      });
    }
  });

  const rows = await asOwner.query(api.automations.list, {});
  const row = rows.find((r) => r._id === automationId);
  // Bounded at the cap, not the true 201 — proves this is a real read
  // bound, not merely a display truncation over a full collect.
  expect(row!.runCounts.waiting).toBe(RUN_COUNTS_STATUS_CAP);
  expect(row!.runCounts.enrolled).toBe(RUN_COUNTS_STATUS_CAP);
  expect(warnSpy).toHaveBeenCalled();
  // Re-review residual (2026-08): the console.warn above goes to Convex
  // logs, which nobody looking at the page ever sees — the PAYLOAD
  // itself must say so too, or a capped read still "reads as complete
  // when it isn't" (the brief's own words), just moved from the read to
  // the response. `RunStatsBar`'s own test asserts this actually
  // reaches rendered text, not just this query's return value.
  expect(row!.runCounts.truncated).toBe(true);

  warnSpy.mockRestore();
});

test("list does not truncate or warn when a status is comfortably under the cap", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await runAutomation(t, { automationId, contactId });

  const rows = await asOwner.query(api.automations.list, {});
  const row = rows.find((r) => r._id === automationId);
  expect(row!.runCounts).toMatchObject({ enrolled: 1, waiting: 1 });
  expect(row!.runCounts.truncated).toBe(false);
  expect(warnSpy).not.toHaveBeenCalled();

  warnSpy.mockRestore();
});

// The logs page (`src/app/(dashboard)/automations/[id]/logs/page.tsx`)
// used to read the account's WHOLE `list` just to pick out one row's
// `runCounts` — so a single-automation detail page paid the
// account-wide cost `list` itself was unbounded on. `runCounts` is the
// dedicated query that replaces that: same bounded counting, scoped to
// one automation, ownership-checked like every other single-automation
// query in this file.
test("runCounts returns the same bounded counts as list's per-item runCounts, for one automation", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });

  const counts = await asOwner.query(api.automations.runCounts, { automationId });
  expect(counts).toMatchObject({ enrolled: 1, waiting: 1 });
  expect(counts.truncated).toBe(false);
});

test("runCounts also reports truncated when a status hits the cap", async () => {
  const t = convexTest(schema, modules);
  const { automationId, accountId, asOwner } = await seedActivatableAutomation(t);
  const now = Date.now();
  await t.run(async (ctx) => {
    for (let i = 0; i < RUN_COUNTS_STATUS_CAP + 1; i++) {
      await ctx.db.insert("automationRuns", {
        accountId,
        automationId,
        status: "waiting",
        nextPosition: 1,
        resumeAt: now + 60_000,
        startedAt: now,
        updatedAt: now,
      });
    }
  });

  const counts = await asOwner.query(api.automations.runCounts, { automationId });
  expect(counts.waiting).toBe(RUN_COUNTS_STATUS_CAP);
  expect(counts.truncated).toBe(true);
});

test("runCounts throws NOT_FOUND for another account's automation", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedActivatableAutomation(t);
  const theirs = await seedActivatableAutomation(t);

  await expect(
    mine.asOwner.query(api.automations.runCounts, { automationId: theirs.automationId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
});

test("runCounts throws FORBIDDEN below admin and succeeds for an admin", async () => {
  const t = convexTest(schema, modules);
  const { automationId, accountId } = await seedActivatableAutomation(t);

  const asSupervisor = await seedFloorRole(t, accountId, "supervisor");
  await expect(
    asSupervisor.query(api.automations.runCounts, { automationId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });

  const asAdmin = await seedFloorRole(t, accountId, "admin");
  await expect(asAdmin.query(api.automations.runCounts, { automationId })).resolves.toBeDefined();
});

test("stepStats merges cumulative counters with the live waiting count", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, asOwner, waitStepKey } =
    await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });

  const stats = await asOwner.query(api.automations.stepStats, { automationId });
  const waitRow = stats.find((s) => s.stepKey === waitStepKey);
  expect(waitRow?.waiting).toBe(1);
});

test("stepStats includes a step with waiting runs even when it has no cumulative row yet", async () => {
  // Under the real engine, reaching a `wait` step writes its cumulative
  // row (automationsEngine.ts's `appendLogResults`) SYNCHRONOUSLY before
  // the run is ever marked "waiting" — so a run parked via `wait` always
  // already has a `reached: 1` row for that step, and can't exercise the
  // "no cumulative row yet" branch. (This task's own brief states that
  // requirement explicitly — "a step with waiting runs but no cumulative
  // row must still appear" — that line is the brief's, not a quote from
  // schema.ts; schema.ts's own comment on `automationStepStats` only
  // explains WHY "waiting" isn't a stored column: it would be a second
  // source of truth that can drift.) That gap is real regardless — e.g.
  // a run whose `logId` was never set
  // takes `appendLogResults`'s early `if (!args.logId) return` and skips
  // the counter write entirely while still recording `currentStepKey` —
  // but reproducing the exact code path that leaves `logId` unset isn't
  // the point of this test. Seed the run directly instead (same
  // direct-insert convention as `seedLog` above) so this pins the
  // MERGE's own handling of that gap without coupling to engine
  // internals that could change independently of it.
  const t = convexTest(schema, modules);
  const { automationId, accountId, contactId, asOwner } =
    await seedActivatableAutomation(t);
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("automationRuns", {
      accountId,
      automationId,
      contactId,
      status: "waiting",
      currentStepKey: "never-counted-step",
      nextPosition: 1,
      resumeAt: now + 60_000,
      startedAt: now,
      updatedAt: now,
    }),
  );

  const stats = await asOwner.query(api.automations.stepStats, { automationId });
  const row = stats.find((s) => s.stepKey === "never-counted-step");
  expect(row).toMatchObject({ reached: 0, sent: 0, failed: 0, waiting: 1 });
});

// Follow-up to finding 4 (the `list` bound two tests up), which
// deliberately left this read alone as "same class, smaller in
// practice". `stepStats` derived its per-step `waiting` figures from an
// unbounded `.collect()` of every "waiting" run of one automation. The
// risk is genuinely smaller than `list`'s — ONE status, and a transient
// one (contacts resume out of "waiting", unlike the three terminal
// statuses that accumulate forever) — but it is the same bug: a busy
// automation with enough contacts parked on a wait simultaneously
// crosses the same per-transaction read ceiling, and the builder canvas
// (whose per-step chips this feeds) throws instead of degrading to
// capped counts.
//
// Seeded across several `currentStepKey` values on purpose: capping the
// read must still leave the per-step aggregation correct — a capped
// batch means some waiting runs are OMITTED from the breakdown, never
// that they land under the wrong step or collapse into one bucket.
test("stepStats bounds its waiting read at the cap and logs when it truncates", async () => {
  const t = convexTest(schema, modules);
  const { automationId, accountId, contactId, asOwner } = await seedActivatableAutomation(t);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  const stepKeys = ["step-a", "step-b", "step-c"];
  const now = Date.now();
  await t.run(async (ctx) => {
    for (let i = 0; i < RUN_COUNTS_STATUS_CAP + 1; i++) {
      await ctx.db.insert("automationRuns", {
        accountId,
        automationId,
        contactId,
        status: "waiting",
        currentStepKey: stepKeys[i % stepKeys.length],
        nextPosition: 1,
        resumeAt: now + 60_000,
        startedAt: now,
        updatedAt: now,
      });
    }
  });

  const stats = await asOwner.query(api.automations.stepStats, { automationId });

  // Bounded at the cap, not the true 201 — a real read bound, the same
  // distinction `list`'s own test draws (bounding the READ, not slicing
  // the payload of a full collect).
  const totalWaiting = stats.reduce((sum, s) => sum + s.waiting, 0);
  expect(totalWaiting).toBe(RUN_COUNTS_STATUS_CAP);
  expect(warnSpy).toHaveBeenCalled();

  // The per-step `Map` aggregation still holds against a capped batch:
  // every seeded step key is still present and attributed separately,
  // and no step claims more than it was seeded.
  for (const stepKey of stepKeys) {
    const row = stats.find((s) => s.stepKey === stepKey);
    expect(row?.waiting).toBeGreaterThan(0);
    expect(row!.waiting).toBeLessThanOrEqual(
      Math.ceil((RUN_COUNTS_STATUS_CAP + 1) / stepKeys.length),
    );
  }

  warnSpy.mockRestore();
});

test("stepStats does not warn when the waiting set is comfortably under the cap", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, asOwner, waitStepKey } = await seedActivatableAutomation(t);
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await runAutomation(t, { automationId, contactId });

  const stats = await asOwner.query(api.automations.stepStats, { automationId });
  expect(stats.find((s) => s.stepKey === waitStepKey)?.waiting).toBe(1);
  expect(warnSpy).not.toHaveBeenCalled();

  warnSpy.mockRestore();
});

test("waitingRuns lists queued contacts with their resume time", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });

  const rows = await asOwner.query(api.automations.waitingRuns, { automationId });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.contactId).toBe(contactId);
  expect(rows[0]!.resumeAt).toBeGreaterThan(Date.now());
});

test("waitingRuns never returns another account's runs", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedActivatableAutomation(t);
  const theirs = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId: theirs.automationId, contactId: theirs.contactId });

  await expect(
    mine.asOwner.query(api.automations.waitingRuns, { automationId: theirs.automationId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
});

test("cancelRun stops one queued contact", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId, contactId });
  const [row] = await asOwner.query(api.automations.waitingRuns, { automationId });

  await asOwner.mutation(api.automations.cancelRun, { runId: row!._id });

  expect(await asOwner.query(api.automations.waitingRuns, { automationId })).toHaveLength(0);
});

test("cancelRun cancels the scheduled resume so it can never send", async () => {
  // The row-status assertion above proves the row is relabeled; this
  // proves the thing that actually matters — the customer-facing send a
  // stale resume would otherwise still fire — mirroring Task 5's own
  // "not merely relabel the row" tests for setActive/remove/update.
  vi.useFakeTimers();
  try {
    process.env.CONVEX_META_DRY_RUN = "1";
    const t = convexTest(schema, modules);
    const { automationId, contactId, conversationId, asOwner } =
      await seedActivatableAutomation(t);
    await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: Date.now() }));
    await runAutomation(t, { automationId, contactId });
    const [row] = await asOwner.query(api.automations.waitingRuns, { automationId });

    await asOwner.mutation(api.automations.cancelRun, { runId: row!._id });

    // Drain whatever the original wait's scheduled resume would have
    // done, had it not been cancelled — same fake-timer shape Task 5's
    // own zero-sends tests use above.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
        .collect(),
    );
    expect(messages).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("cancelRun refuses a run belonging to another account", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedActivatableAutomation(t);
  const theirs = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId: theirs.automationId, contactId: theirs.contactId });
  const [foreign] = await theirs.asOwner.query(api.automations.waitingRuns, {
    automationId: theirs.automationId,
  });

  await expect(
    mine.asOwner.mutation(api.automations.cancelRun, { runId: foreign!._id }),
  ).rejects.toThrow();
});

test("cancelRun throws the same NOT_FOUND for a foreign run as for a nonexistent one", async () => {
  // The cross-account probe this guards against: if "yours" and
  // "doesn't exist" threw differently, a caller could fish for valid
  // run ids belonging to other accounts by watching which error comes
  // back. Mirrors `requireOwnAutomation`'s own established shape.
  const t = convexTest(schema, modules);
  const mine = await seedActivatableAutomation(t);
  const theirs = await seedActivatableAutomation(t);
  await runAutomation(t, { automationId: theirs.automationId, contactId: theirs.contactId });
  const [foreign] = await theirs.asOwner.query(api.automations.waitingRuns, {
    automationId: theirs.automationId,
  });

  // A genuinely nonexistent id: a run in "mine"'s own account, deleted
  // outright, rather than a foreign one — isolates "not found at all"
  // from "found but not yours".
  const mineRun = await runAutomation(t, {
    automationId: mine.automationId,
    contactId: mine.contactId,
  });
  await t.run((ctx) => ctx.db.delete(mineRun!._id));

  const foreignError: unknown = await mine.asOwner
    .mutation(api.automations.cancelRun, { runId: foreign!._id })
    .catch((e: unknown) => e);
  const missingError: unknown = await mine.asOwner
    .mutation(api.automations.cancelRun, { runId: mineRun!._id })
    .catch((e: unknown) => e);

  expect((foreignError as { data: unknown }).data).toEqual((missingError as { data: unknown }).data);
});

test("cancelRun refuses a run that has already finished", async () => {
  // Reviewer-reported repro: `cancelRun` fetched by raw `runId` with no
  // status guard at all, so a `runId` copied off a `waitingRuns()` list
  // that has since resumed-and-completed would still be silently
  // "cancelled" — overwriting the real outcome and discarding
  // `endedAt`. Task 5's own batch cancellers
  // (`cancelRunsForAutomation`/`cancelRunsForContact`) never had this
  // hole: both scope their query to `status: "waiting"` (or `"running"`
  // with an outstanding branch) before ever calling `cancelOne`.
  const t = convexTest(schema, modules);
  const { automationId, contactId, asOwner } = await seedActivatableAutomation(t);
  const run = await runAutomation(t, { automationId, contactId });
  const finishedAt = Date.now();
  // Simulate natural completion: the resume already ran to the end, so
  // there is no `scheduledFnId` left to cancel — exactly the shape the
  // reviewer's repro used.
  await t.run((ctx) =>
    ctx.db.patch(run!._id, {
      status: "completed",
      resumeAt: undefined,
      scheduledFnId: undefined,
      endedAt: finishedAt,
      updatedAt: finishedAt,
    }),
  );

  await expect(
    asOwner.mutation(api.automations.cancelRun, { runId: run!._id }),
  ).rejects.toMatchObject({ data: { code: "NOT_CANCELLABLE" } });

  // The real outcome must survive the refused cancel attempt untouched.
  const row = await t.run((ctx) => ctx.db.get(run!._id));
  expect(row?.status).toBe("completed");
  expect(row?.endedAt).toBe(finishedAt);
  expect(row?.errorMessage).toBeUndefined();
});

test("cancelRun still throws NOT_FOUND, not the terminal-state error, for a foreign run that has already finished", async () => {
  // The terminal-state guard above must never be reachable for a run the
  // caller doesn't own — a NOT_CANCELLABLE response here would itself be
  // a leak (proof that a run with this id exists, and that it's
  // finished) to a caller who should see nothing but "not found" either
  // way. This only holds because the ownership check runs strictly
  // BEFORE the cancellability check in `cancelRun`'s own body; this test
  // pins that ordering, not just the ordering's intended effect.
  const t = convexTest(schema, modules);
  const mine = await seedActivatableAutomation(t);
  const theirs = await seedActivatableAutomation(t);
  const theirRun = await runAutomation(t, {
    automationId: theirs.automationId,
    contactId: theirs.contactId,
  });
  await t.run((ctx) =>
    ctx.db.patch(theirRun!._id, {
      status: "completed",
      resumeAt: undefined,
      scheduledFnId: undefined,
      endedAt: Date.now(),
    }),
  );

  const error: unknown = await mine.asOwner
    .mutation(api.automations.cancelRun, { runId: theirRun!._id })
    .catch((e: unknown) => e);
  expect((error as { data: { code: string } }).data.code).toBe("NOT_FOUND");
});

test("cancelRun still cancels a running run with a genuinely outstanding branch", async () => {
  // Mirrors `cancelRunsForAutomation`'s own two-clause definition of
  // "cancellable" (see that mutation's comment in automationsEngine.ts):
  // a multi-branch run can read `status: "running"` overall while a
  // sibling condition branch is still parked on its own live wait,
  // tracked only by `outstandingBranches`. Seeded directly rather than
  // through a real condition split — only the status/counter shape
  // matters to this guard, not how a run actually gets into it.
  const t = convexTest(schema, modules);
  const { automationId, contactId, accountId, asOwner } =
    await seedActivatableAutomation(t);
  const now = Date.now();
  const runId = await t.run((ctx) =>
    ctx.db.insert("automationRuns", {
      accountId,
      automationId,
      contactId,
      status: "running",
      outstandingBranches: 1,
      nextPosition: 1,
      startedAt: now,
      updatedAt: now,
    }),
  );

  await asOwner.mutation(api.automations.cancelRun, { runId });

  const row = await t.run((ctx) => ctx.db.get(runId));
  expect(row?.status).toBe("cancelled");
});

test("automations stepStats/waitingRuns throw FORBIDDEN below admin and succeed for an admin", async () => {
  const t = convexTest(schema, modules);
  const { automationId, accountId } = await seedActivatableAutomation(t);

  const asSupervisor = await seedFloorRole(t, accountId, "supervisor");
  await expect(
    asSupervisor.query(api.automations.stepStats, { automationId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
  await expect(
    asSupervisor.query(api.automations.waitingRuns, { automationId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });

  const asAdmin = await seedFloorRole(t, accountId, "admin");
  await expect(
    asAdmin.query(api.automations.stepStats, { automationId }),
  ).resolves.toBeDefined();
  await expect(
    asAdmin.query(api.automations.waitingRuns, { automationId }),
  ).resolves.toBeDefined();
});

/**
 * The regression test for the write/read floor inversion (audit,
 * 2026-08). Every READ in `convex/automations.ts` already required
 * `admin`, because `/automations` appears in no nav allowlist in
 * `src/lib/auth/roles.ts` — but every MUTATION was still on the ported
 * Supabase-RLS `agent` floor, two ranks lower. So `agent` and
 * `supervisor` — the exact two roles that can authenticate but must not
 * reach this section — could `create` an automation and `setActive` it
 * without ever being able to `list`, `get` or audit one. An active
 * automation sends WhatsApp messages on the account's own number and
 * its `send_webhook` step POSTs the run context (contact name, phone,
 * inbound message text) to any URL the step names, so that gap was an
 * account-wide send + data-egress primitive, not a lesser privilege
 * than reading.
 *
 * Asserted per-role and per-mutation rather than as one spot check:
 * the bug was precisely that ONE function's floor drifted from its
 * neighbours', so a test that samples a single mutation would not have
 * caught it.
 */
test("every automations mutation rejects agent and supervisor, the roles the nav never admits", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, accountId } = await seedActivatableAutomation(t);
  const run = await runAutomation(t, { automationId, contactId });
  const forbidden = { data: { code: "FORBIDDEN", min: "admin" } };

  for (const role of ["agent", "supervisor"] as const) {
    const asRole = await seedFloorRole(t, accountId, role);

    await expect(
      asRole.mutation(api.automations.create, {
        name: "smuggled",
        triggerType: "new_message_received",
      }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      asRole.mutation(api.automations.update, { automationId, name: "renamed" }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      asRole.mutation(api.automations.setActive, { automationId, isActive: true }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      asRole.mutation(api.automations.duplicate, { automationId }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      asRole.mutation(api.automations.remove, { automationId }),
    ).rejects.toMatchObject(forbidden);
    await expect(
      asRole.mutation(api.automations.cancelRun, { runId: run!._id }),
    ).rejects.toMatchObject(forbidden);
  }

  // The automation is still there, unrenamed and unduplicated — the
  // rejections above were real, not swallowed.
  const survivors = await t.run((ctx: QueryCtx) =>
    ctx.db
      .query("automations")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .collect(),
  );
  expect(survivors).toHaveLength(1);
  expect(survivors[0]!.name).toBe("Stats fixture");
});

test("cancelRun throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { automationId, contactId, accountId } = await seedActivatableAutomation(t);
  const run = await runAutomation(t, { automationId, contactId });

  const asViewer = await seedFloorRole(t, accountId, "viewer");
  await expect(
    asViewer.mutation(api.automations.cancelRun, { runId: run!._id }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});
