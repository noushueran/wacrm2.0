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
 * Inserts a `pipelines` row plus a caller-provided array of stages
 * directly via `t.run`, bypassing `pipelines.create`'s own
 * always-in-order default-stage insert. Used only by the "list sorts
 * by position" test below, which needs stages seeded *out of* position
 * order to actually prove `list` sorts rather than just happening to
 * return insertion order.
 */
async function seedPipelineWithRawStages(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    name: string;
    stages: { name: string; color: string; position: number }[];
  },
) {
  return await t.run(async (ctx) => {
    const pipelineId = await ctx.db.insert("pipelines", {
      accountId: opts.accountId,
      name: opts.name,
    });
    for (const stage of opts.stages) {
      await ctx.db.insert("pipelineStages", {
        accountId: opts.accountId,
        pipelineId,
        name: stage.name,
        color: stage.color,
        position: stage.position,
      });
    }
    return pipelineId;
  });
}

// ============================================================
// create — seeds the spec-default stages
// ============================================================

test("create inserts a pipeline scoped to the caller's own account and seeds the five default stages in order", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId, userId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const pipelineId = await asUser.mutation(api.pipelines.create, {
    name: "Sales",
  });

  const pipeline = await t.run((ctx) => ctx.db.get(pipelineId));
  expect(pipeline).not.toBeNull();
  expect(pipeline!.accountId).toBe(accountId);
  expect(pipeline!.createdByUserId).toBe(userId);
  expect(pipeline!.name).toBe("Sales");

  const stages = await t.run((ctx) =>
    ctx.db
      .query("pipelineStages")
      .withIndex("by_pipeline", (q) => q.eq("pipelineId", pipelineId))
      .collect(),
  );
  stages.sort((a, b) => a.position - b.position);
  expect(
    stages.map((s) => ({ name: s.name, color: s.color, position: s.position })),
  ).toEqual([
    { name: "New Lead", color: "#3b82f6", position: 0 },
    { name: "Qualified", color: "#eab308", position: 1 },
    { name: "Proposal Sent", color: "#f97316", position: 2 },
    { name: "Negotiation", color: "#8b5cf6", position: 3 },
    { name: "Won", color: "#22c55e", position: 4 },
  ]);
  // Every seeded stage denormalizes the pipeline's own accountId.
  for (const stage of stages) expect(stage.accountId).toBe(accountId);
});

test("create throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  await expect(
    asUser.mutation(api.pipelines.create, { name: "Sales" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});

// ============================================================
// list — position-ordered stages, account-scoped
// ============================================================

test("list returns each pipeline with its stages sorted by position ascending, regardless of insertion order", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });

  const pipelineId = await seedPipelineWithRawStages(t, {
    accountId,
    name: "Support",
    stages: [
      { name: "Third", color: "#111", position: 2 },
      { name: "First", color: "#333", position: 0 },
      { name: "Second", color: "#222", position: 1 },
    ],
  });

  const result = await asUser.query(api.pipelines.list, {});

  expect(result).toHaveLength(1);
  expect(result[0]!._id).toBe(pipelineId);
  expect(result[0]!.stages.map((s) => s.name)).toEqual([
    "First",
    "Second",
    "Third",
  ]);
});

test("list never returns another account's pipelines", async () => {
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

  await asAlice.mutation(api.pipelines.create, { name: "Sales" });

  const bobsView = await asBob.query(api.pipelines.list, {});
  expect(bobsView).toHaveLength(0);

  const alicesView = await asAlice.query(api.pipelines.list, {});
  expect(alicesView).toHaveLength(1);
});

// ============================================================
// addStage
// ============================================================

test("addStage assigns max(position)+1, not stage count, so a gap from a prior delete doesn't collide", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const pipelineId = await asUser.mutation(api.pipelines.create, {
    name: "Sales",
  });
  const stages = await t.run((ctx) =>
    ctx.db
      .query("pipelineStages")
      .withIndex("by_pipeline", (q) => q.eq("pipelineId", pipelineId))
      .collect(),
  );
  stages.sort((a, b) => a.position - b.position);
  // Delete the middle stage (position 2 of 0..4), leaving a gap: 0,1,3,4
  // — only 4 stages remain, but the max position is still 4.
  await asUser.mutation(api.pipelines.deleteStage, {
    stageId: stages[2]!._id,
  });

  const newStageId = await asUser.mutation(api.pipelines.addStage, {
    pipelineId,
    name: "Extra",
    color: "#000",
  });
  const newStage = await t.run((ctx) => ctx.db.get(newStageId));
  expect(newStage!.position).toBe(5);
});

test("addStage throws NOT_FOUND for a pipeline belonging to a different account, and leaves it unmodified", async () => {
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

  const alicePipelineId = await asAlice.mutation(api.pipelines.create, {
    name: "Sales",
  });

  await expect(
    asBob.mutation(api.pipelines.addStage, {
      pipelineId: alicePipelineId,
      name: "Sneaky",
      color: "#000",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "pipeline" } });

  const stages = await t.run((ctx) =>
    ctx.db
      .query("pipelineStages")
      .withIndex("by_pipeline", (q) => q.eq("pipelineId", alicePipelineId))
      .collect(),
  );
  expect(stages).toHaveLength(5); // still just the seeded defaults

  // Alice herself can still add to her own pipeline — proves the
  // throw above is really about cross-account isolation.
  const stageId = await asAlice.mutation(api.pipelines.addStage, {
    pipelineId: alicePipelineId,
    name: "Extra",
    color: "#000",
  });
  const stage = await t.run((ctx) => ctx.db.get(stageId));
  expect(stage!.position).toBe(5);
});

// ============================================================
// renameStage
// ============================================================

test("renameStage throws NOT_FOUND for a stage belonging to a different account, and leaves it unmodified", async () => {
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

  const alicePipelineId = await asAlice.mutation(api.pipelines.create, {
    name: "Sales",
  });
  const [aliceStage] = await t.run((ctx) =>
    ctx.db
      .query("pipelineStages")
      .withIndex("by_pipeline", (q) => q.eq("pipelineId", alicePipelineId))
      .collect(),
  );

  await expect(
    asBob.mutation(api.pipelines.renameStage, {
      stageId: aliceStage!._id,
      name: "Hijacked",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "stage" } });

  const untouched = await t.run((ctx) => ctx.db.get(aliceStage!._id));
  expect(untouched!.name).toBe(aliceStage!.name);

  // Positive control.
  await asAlice.mutation(api.pipelines.renameStage, {
    stageId: aliceStage!._id,
    name: "Renamed",
    color: "#abcabc",
  });
  const renamed = await t.run((ctx) => ctx.db.get(aliceStage!._id));
  expect(renamed!.name).toBe("Renamed");
  expect(renamed!.color).toBe("#abcabc");
});

// ============================================================
// reorderStages
// ============================================================

test("reorderStages throws NOT_FOUND when the stages belong to a different account, and leaves every position untouched", async () => {
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

  const alicePipelineId = await asAlice.mutation(api.pipelines.create, {
    name: "Sales",
  });
  const aliceStages = await t.run((ctx) =>
    ctx.db
      .query("pipelineStages")
      .withIndex("by_pipeline", (q) => q.eq("pipelineId", alicePipelineId))
      .collect(),
  );
  aliceStages.sort((a, b) => a.position - b.position);
  const aliceStageIds = aliceStages.map((s) => s._id);

  // Bob (a different account entirely) tries to reorder Alice's stages.
  await expect(
    asBob.mutation(api.pipelines.reorderStages, {
      stageIds: [
        aliceStageIds[1]!,
        aliceStageIds[0]!,
        ...aliceStageIds.slice(2),
      ],
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "stage" } });

  const untouched = await t.run((ctx) =>
    ctx.db
      .query("pipelineStages")
      .withIndex("by_pipeline", (q) => q.eq("pipelineId", alicePipelineId))
      .collect(),
  );
  untouched.sort((a, b) => a.position - b.position);
  expect(untouched.map((s) => s._id)).toEqual(aliceStageIds);

  // Alice herself can still reorder her own stages — proves the throw
  // above is really about cross-account isolation, not a broken
  // reorderStages in general.
  await asAlice.mutation(api.pipelines.reorderStages, {
    stageIds: [aliceStageIds[1]!, aliceStageIds[0]!, ...aliceStageIds.slice(2)],
  });
  const reordered = await t.run((ctx) =>
    ctx.db
      .query("pipelineStages")
      .withIndex("by_pipeline", (q) => q.eq("pipelineId", alicePipelineId))
      .collect(),
  );
  reordered.sort((a, b) => a.position - b.position);
  expect(reordered[0]!._id).toBe(aliceStageIds[1]);
  expect(reordered[1]!._id).toBe(aliceStageIds[0]);
});

// ============================================================
// deleteStage
// ============================================================

test("deleteStage throws NOT_FOUND for a stage belonging to a different account, and leaves it in place", async () => {
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

  const alicePipelineId = await asAlice.mutation(api.pipelines.create, {
    name: "Sales",
  });
  const [aliceStage] = await t.run((ctx) =>
    ctx.db
      .query("pipelineStages")
      .withIndex("by_pipeline", (q) => q.eq("pipelineId", alicePipelineId))
      .collect(),
  );

  await expect(
    asBob.mutation(api.pipelines.deleteStage, { stageId: aliceStage!._id }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "stage" } });

  const stillThere = await t.run((ctx) => ctx.db.get(aliceStage!._id));
  expect(stillThere).not.toBeNull();

  // Alice herself can still delete her own stage.
  await asAlice.mutation(api.pipelines.deleteStage, {
    stageId: aliceStage!._id,
  });
  const gone = await t.run((ctx) => ctx.db.get(aliceStage!._id));
  expect(gone).toBeNull();
});
