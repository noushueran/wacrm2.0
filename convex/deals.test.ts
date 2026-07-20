/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
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

/**
 * Adds a second membership row to an *existing* account — used by the
 * FORBIDDEN test below, which needs a real teammate on the *same*
 * account as the pipeline/stage being targeted, at a role beneath
 * "agent". Mirrors `convex/conversations.test.ts`'s own `seedTeammate`.
 */
async function seedTeammate(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    name: string;
    email: string;
    role: AccountRole;
  },
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: opts.name,
      email: opts.email,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: opts.accountId,
      role: opts.role,
      fullName: opts.name,
      email: opts.email,
    });
    return userId;
  });
}

/**
 * Creates a pipeline (via the real `pipelines.create`, so it comes
 * with the real spec-default stages) and returns its id plus its
 * stages sorted by position — the fixture every test below builds on.
 * `asUser` must be admin+ (pipeline structure is admin-gated). Reads
 * the stages back through the real `pipelines.list` query rather than
 * a raw `t.run` index query — `t`'s parameter type here is the bare
 * `ReturnType<typeof convexTest>` (no schema type argument), which
 * doesn't carry this suite's concrete table/index types, so a
 * `ctx.db.query(...).withIndex(...)` call inside a helper typed this
 * way can't resolve custom index names (only every table's built-in
 * `by_creation_time`/`by_id`). Going through `api.pipelines.list`
 * sidesteps that entirely — its `FunctionReference` type comes from
 * codegen, independent of `t`'s type here.
 */
async function seedPipelineWithStages(
  t: ReturnType<typeof convexTest>,
  asUser: Awaited<ReturnType<typeof seedAccountMember>>["asUser"],
) {
  const pipelineId = await asUser.mutation(api.pipelines.create, {
    name: "Sales",
  });
  const pipelines = await asUser.query(api.pipelines.list, {});
  const pipeline = pipelines.find((p) => p._id === pipelineId);
  if (!pipeline) throw new Error("seedPipelineWithStages: pipeline not found");
  return { pipelineId, stages: pipeline.stages };
}

const baseDeal = { title: "Big Fish", value: 5000, currency: "USD" };

// ============================================================
// create — sets defaults, validates pipeline/stage/contact ownership
// ============================================================

test("create inserts a deal scoped to the caller's own account with status:open, updatedAt set, and the given fields", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { pipelineId, stages } = await seedPipelineWithStages(t, asUser);
  const contactId = await asUser.mutation(api.contacts.create, {
    phone: "111",
    name: "Jonas",
  });

  const before = Date.now();
  const dealId = await asUser.mutation(api.deals.create, {
    ...baseDeal,
    contactId,
    pipelineId,
    stageId: stages[0]!._id,
  });

  const deal = await t.run((ctx) => ctx.db.get(dealId));
  expect(deal).not.toBeNull();
  expect(deal!.accountId).toBe(accountId);
  expect(deal!.createdByUserId).toBe(userId);
  expect(deal!.pipelineId).toBe(pipelineId);
  expect(deal!.stageId).toBe(stages[0]!._id);
  expect(deal!.contactId).toBe(contactId);
  expect(deal!.title).toBe("Big Fish");
  expect(deal!.value).toBe(5000);
  expect(deal!.currency).toBe("USD");
  expect(deal!.status).toBe("open");
  expect(deal!.updatedAt).toBeGreaterThanOrEqual(before);
});

test("create throws NOT_FOUND when pipelineId belongs to a different account, and creates nothing", async () => {
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
  const { pipelineId, stages } = await seedPipelineWithStages(t, asAlice);

  await expect(
    asBob.mutation(api.deals.create, {
      ...baseDeal,
      pipelineId,
      stageId: stages[0]!._id,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "pipeline" } });

  const all = await t.run((ctx) => ctx.db.query("deals").collect());
  expect(all).toHaveLength(0);

  // Positive control — Alice herself can still create in her own pipeline.
  const dealId = await asAlice.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId,
    stageId: stages[0]!._id,
  });
  expect(await t.run((ctx) => ctx.db.get(dealId))).not.toBeNull();
});

test("create throws NOT_FOUND when stageId belongs to a different account", async () => {
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
  const { pipelineId: alicePipelineId } = await seedPipelineWithStages(
    t,
    asAlice,
  );
  const { pipelineId: bobPipelineId } = await seedPipelineWithStages(
    t,
    asBob,
  );
  const bobStages = await t.run((ctx) =>
    ctx.db
      .query("pipelineStages")
      .withIndex("by_pipeline", (q) => q.eq("pipelineId", bobPipelineId))
      .collect(),
  );

  // Bob supplies his own real stageId but Alice's pipelineId — the
  // pipeline check must fire first regardless.
  await expect(
    asBob.mutation(api.deals.create, {
      ...baseDeal,
      pipelineId: alicePipelineId,
      stageId: bobStages[0]!._id,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "pipeline" } });

  const all = await t.run((ctx) => ctx.db.query("deals").collect());
  expect(all).toHaveLength(0);
});

test("create throws NOT_FOUND when stageId belongs to a different pipeline in the same account", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { pipelineId: pipelineA } = await seedPipelineWithStages(t, asUser);
  const { stages: stagesB } = await seedPipelineWithStages(t, asUser); // sibling pipeline

  await expect(
    asUser.mutation(api.deals.create, {
      ...baseDeal,
      pipelineId: pipelineA,
      stageId: stagesB[0]!._id,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "stage" } });

  const all = await t.run((ctx) => ctx.db.query("deals").collect());
  expect(all).toHaveLength(0);
});

test("create throws NOT_FOUND when contactId belongs to a different account", async () => {
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
  const { pipelineId, stages } = await seedPipelineWithStages(t, asBob);
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });

  await expect(
    asBob.mutation(api.deals.create, {
      ...baseDeal,
      contactId: aliceContactId,
      pipelineId,
      stageId: stages[0]!._id,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  const all = await t.run((ctx) => ctx.db.query("deals").collect());
  expect(all).toHaveLength(0);
});

// ============================================================
// listByPipeline
// ============================================================

test("listByPipeline returns only deals for that pipeline", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { pipelineId: pipelineA, stages: stagesA } =
    await seedPipelineWithStages(t, asUser);
  const { pipelineId: pipelineB, stages: stagesB } =
    await seedPipelineWithStages(t, asUser);

  const dealA = await asUser.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId: pipelineA,
    stageId: stagesA[0]!._id,
  });
  await asUser.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId: pipelineB,
    stageId: stagesB[0]!._id,
  });

  const result = await asUser.query(api.deals.listByPipeline, {
    pipelineId: pipelineA,
  });
  expect(result.map((d) => d._id)).toEqual([dealA]);
});

test("listByPipeline throws NOT_FOUND for a pipeline belonging to a different account", async () => {
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
  const { pipelineId } = await seedPipelineWithStages(t, asAlice);

  await expect(
    asBob.query(api.deals.listByPipeline, { pipelineId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "pipeline" } });

  // Positive control.
  const alicesView = await asAlice.query(api.deals.listByPipeline, {
    pipelineId,
  });
  expect(alicesView).toEqual([]);
});

// ============================================================
// listByContact
// ============================================================

test("listByContact returns only the given contact's deals, each with its stage embedded", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { pipelineId, stages } = await seedPipelineWithStages(t, asUser);
  const contactA = await asUser.mutation(api.contacts.create, {
    phone: "111",
    name: "Jonas",
  });
  const contactB = await asUser.mutation(api.contacts.create, {
    phone: "222",
    name: "Other",
  });

  const dealA = await asUser.mutation(api.deals.create, {
    ...baseDeal,
    contactId: contactA,
    pipelineId,
    stageId: stages[0]!._id,
  });
  await asUser.mutation(api.deals.create, {
    ...baseDeal,
    contactId: contactB,
    pipelineId,
    stageId: stages[0]!._id,
  });

  const result = await asUser.query(api.deals.listByContact, {
    contactId: contactA,
  });

  expect(result.map((d) => d._id)).toEqual([dealA]);
  expect(result[0]!.stage).not.toBeNull();
  expect(result[0]!.stage!._id).toBe(stages[0]!._id);
});

test("listByContact throws NOT_FOUND for a contact belonging to a different account", async () => {
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
  const aliceContactId = await asAlice.mutation(api.contacts.create, {
    phone: "111",
  });

  await expect(
    asBob.query(api.deals.listByContact, { contactId: aliceContactId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  // Positive control.
  const alicesView = await asAlice.query(api.deals.listByContact, {
    contactId: aliceContactId,
  });
  expect(alicesView).toEqual([]);
});

// ============================================================
// move — rejects a foreign-pipeline stage; cross-account denial
// ============================================================

test("move patches stageId and updatedAt", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { pipelineId, stages } = await seedPipelineWithStages(t, asUser);
  const dealId = await asUser.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId,
    stageId: stages[0]!._id,
  });

  const before = Date.now();
  const result = await asUser.mutation(api.deals.move, {
    dealId,
    stageId: stages[1]!._id,
  });
  expect(result).toBe(dealId);

  const deal = await t.run((ctx) => ctx.db.get(dealId));
  expect(deal!.stageId).toBe(stages[1]!._id);
  expect(deal!.updatedAt).toBeGreaterThanOrEqual(before);
});

test("move rejects a stage belonging to a different pipeline, leaving the deal's stage untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { pipelineId: pipelineA, stages: stagesA } =
    await seedPipelineWithStages(t, asUser);
  const { stages: stagesB } = await seedPipelineWithStages(t, asUser);
  const dealId = await asUser.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId: pipelineA,
    stageId: stagesA[0]!._id,
  });

  await expect(
    asUser.mutation(api.deals.move, { dealId, stageId: stagesB[0]!._id }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "stage" } });

  const deal = await t.run((ctx) => ctx.db.get(dealId));
  expect(deal!.stageId).toBe(stagesA[0]!._id);
});

test("move throws NOT_FOUND for a deal belonging to a different account, and leaves it untouched", async () => {
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
  const { pipelineId, stages } = await seedPipelineWithStages(t, asAlice);
  const dealId = await asAlice.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId,
    stageId: stages[0]!._id,
  });

  await expect(
    asBob.mutation(api.deals.move, { dealId, stageId: stages[1]!._id }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "deal" } });

  const deal = await t.run((ctx) => ctx.db.get(dealId));
  expect(deal!.stageId).toBe(stages[0]!._id);

  // Positive control.
  await asAlice.mutation(api.deals.move, { dealId, stageId: stages[1]!._id });
  const moved = await t.run((ctx) => ctx.db.get(dealId));
  expect(moved!.stageId).toBe(stages[1]!._id);
});

// ============================================================
// update
// ============================================================

test("update patches given fields and bumps updatedAt, leaving other fields untouched", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { pipelineId, stages } = await seedPipelineWithStages(t, asUser);
  const dealId = await asUser.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId,
    stageId: stages[0]!._id,
  });

  const before = Date.now();
  await asUser.mutation(api.deals.update, {
    dealId,
    title: "Bigger Fish",
    value: 9000,
  });

  const deal = await t.run((ctx) => ctx.db.get(dealId));
  expect(deal!.title).toBe("Bigger Fish");
  expect(deal!.value).toBe(9000);
  expect(deal!.currency).toBe("USD"); // untouched
  expect(deal!.stageId).toBe(stages[0]!._id); // untouched — update can't move stage
  expect(deal!.updatedAt).toBeGreaterThanOrEqual(before);
});

test("update throws NOT_FOUND when contactId belongs to a different account, leaving the deal unmodified", async () => {
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
  const { pipelineId, stages } = await seedPipelineWithStages(t, asAlice);
  const dealId = await asAlice.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId,
    stageId: stages[0]!._id,
  });
  const bobContactId = await asBob.mutation(api.contacts.create, {
    phone: "222",
  });

  await expect(
    asAlice.mutation(api.deals.update, {
      dealId,
      contactId: bobContactId,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "contact" } });

  const deal = await t.run((ctx) => ctx.db.get(dealId));
  expect(deal!.contactId).toBeUndefined();
});

test("update throws NOT_FOUND for a deal belonging to a different account, and leaves it unmodified", async () => {
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
  const { pipelineId, stages } = await seedPipelineWithStages(t, asAlice);
  const dealId = await asAlice.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId,
    stageId: stages[0]!._id,
  });

  await expect(
    asBob.mutation(api.deals.update, { dealId, title: "Hijacked" }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "deal" } });

  const deal = await t.run((ctx) => ctx.db.get(dealId));
  expect(deal!.title).toBe("Big Fish");

  // Positive control.
  await asAlice.mutation(api.deals.update, { dealId, title: "Renamed" });
  const renamed = await t.run((ctx) => ctx.db.get(dealId));
  expect(renamed!.title).toBe("Renamed");
});

// ============================================================
// setStatus
// ============================================================

test("setStatus updates status and bumps updatedAt", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { pipelineId, stages } = await seedPipelineWithStages(t, asUser);
  const dealId = await asUser.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId,
    stageId: stages[0]!._id,
  });

  const before = Date.now();
  await asUser.mutation(api.deals.setStatus, { dealId, status: "won" });

  const deal = await t.run((ctx) => ctx.db.get(dealId));
  expect(deal!.status).toBe("won");
  expect(deal!.updatedAt).toBeGreaterThanOrEqual(before);
});

test("setStatus throws NOT_FOUND for a deal belonging to a different account, and leaves it untouched", async () => {
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
  const { pipelineId, stages } = await seedPipelineWithStages(t, asAlice);
  const dealId = await asAlice.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId,
    stageId: stages[0]!._id,
  });

  await expect(
    asBob.mutation(api.deals.setStatus, { dealId, status: "lost" }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "deal" } });

  const deal = await t.run((ctx) => ctx.db.get(dealId));
  expect(deal!.status).toBe("open");

  // Positive control.
  await asAlice.mutation(api.deals.setStatus, { dealId, status: "won" });
  const won = await t.run((ctx) => ctx.db.get(dealId));
  expect(won!.status).toBe("won");
});

// ============================================================
// remove
// ============================================================

test("remove deletes the deal", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { pipelineId, stages } = await seedPipelineWithStages(t, asUser);
  const dealId = await asUser.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId,
    stageId: stages[0]!._id,
  });

  await asUser.mutation(api.deals.remove, { dealId });
  expect(await t.run((ctx) => ctx.db.get(dealId))).toBeNull();
});

test("remove throws NOT_FOUND for a deal belonging to a different account, and leaves it in place", async () => {
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
  const { pipelineId, stages } = await seedPipelineWithStages(t, asAlice);
  const dealId = await asAlice.mutation(api.deals.create, {
    ...baseDeal,
    pipelineId,
    stageId: stages[0]!._id,
  });

  await expect(
    asBob.mutation(api.deals.remove, { dealId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "deal" } });

  expect(await t.run((ctx) => ctx.db.get(dealId))).not.toBeNull();

  // Positive control.
  await asAlice.mutation(api.deals.remove, { dealId });
  expect(await t.run((ctx) => ctx.db.get(dealId))).toBeNull();
});

// ============================================================
// role gate — deals require at least "agent"
// ============================================================

test("create throws FORBIDDEN for a caller below the agent role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAdmin, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const { pipelineId, stages } = await seedPipelineWithStages(t, asAdmin);
  const viewerUserId = await seedTeammate(t, {
    accountId,
    name: "Vera",
    email: "vera@example.com",
    role: "viewer",
  });
  const asViewer = t.withIdentity({ subject: `${viewerUserId}|session-Vera` });

  await expect(
    asViewer.mutation(api.deals.create, {
      ...baseDeal,
      pipelineId,
      stageId: stages[0]!._id,
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });

  const all = await t.run((ctx) => ctx.db.query("deals").collect());
  expect(all).toHaveLength(0);
});

// ============================================================
// Read-side role floor
//
// `require-section.tsx` states in comment that "server queries already
// reject; this is UX." It was not true here — these reads carried no role
// check at all, so a viewer (conversation scope: "unassigned only") could
// call them directly and read data the nav hides. The floor below matches
// `SUPERVISOR_NAV` in src/lib/auth/roles.ts, which is what already gates
// the pages these queries back.
// ============================================================

async function seedRole(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  role: "viewer" | "agent" | "supervisor",
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

// Only `listByPipeline` moves. `listByContact` deliberately stays open to
// agents: the inbox contact sidebar (`src/components/inbox/contact-sidebar.tsx`)
// renders a contact's deals for whoever is handling the thread. Its real
// defect is a different one — it gates on `requireOwnContact` (account
// match) rather than conversation scope — and is tracked separately.
test("deals.listByPipeline throws FORBIDDEN below supervisor and succeeds for a supervisor", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner, accountId } = await seedAccountMember(t, {
    name: "Olive",
    email: "olive@example.com",
    role: "owner",
  });
  const { pipelineId } = await seedPipelineWithStages(t, asOwner);

  const asAgent = await seedRole(t, accountId, "agent");
  await expect(
    asAgent.query(api.deals.listByPipeline, { pipelineId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "supervisor" } });

  const asSupervisor = await seedRole(t, accountId, "supervisor");
  await expect(
    asSupervisor.query(api.deals.listByPipeline, { pipelineId }),
  ).resolves.toBeDefined();
});

test("deals.listByContact stays reachable by an agent — the inbox sidebar depends on it", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asOwner, accountId } = await seedAccountMember(t, {
    name: "Olive",
    email: "olive@example.com",
    role: "owner",
  });
  const contactId = await asOwner.mutation(api.contacts.create, {
    phone: "+15550009999",
  });

  const asAgent = await seedRole(t, accountId, "agent");
  await expect(
    asAgent.query(api.deals.listByContact, { contactId }),
  ).resolves.toBeDefined();
});
