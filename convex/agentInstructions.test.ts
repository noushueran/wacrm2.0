/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";
import { EXTRA_INSTRUCTIONS_MAX } from "./lib/agentRegistry";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedMember(t: ReturnType<typeof convexTest>, role: AccountRole) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: role, email: `${role}@x.com` }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "A", defaultCurrency: "AED", ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId, accountId: id, role, fullName: role, email: `${role}@x.com`,
    });
    return id;
  });
  return { userId, accountId, as: t.withIdentity({ subject: `${userId}|s` }) };
}

test("an agent with no instructions reads as empty, not missing", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  const got = await as.query(api.agentInstructions.get, { agentKey: "revival" });
  expect(got.extraInstructions).toBe("");
  expect(got.updatedAt).toBeNull();
  expect(got.max).toBe(EXTRA_INSTRUCTIONS_MAX);
});

test("saving records the text and who wrote it", async () => {
  const t = convexTest(schema, modules);
  const { userId, as } = await seedMember(t, "admin");

  await as.mutation(api.agentInstructions.set, {
    agentKey: "revival",
    extraInstructions: "  Mention 3-day Azerbaijan visas.  ",
  });

  const got = await as.query(api.agentInstructions.get, { agentKey: "revival" });
  expect(got.extraInstructions).toBe("Mention 3-day Azerbaijan visas.");
  const row = await t.run((ctx) => ctx.db.query("agentInstructions").first());
  expect(row!.updatedByUserId).toBe(userId);
});

test("clearing the box removes the row, so the prompt returns to identical", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  await as.mutation(api.agentInstructions.set, {
    agentKey: "revival", extraInstructions: "Something",
  });
  await as.mutation(api.agentInstructions.set, {
    agentKey: "revival", extraInstructions: "   ",
  });

  const rows = await t.run((ctx) => ctx.db.query("agentInstructions").collect());
  // An empty customisation must not linger as a row.
  expect(rows).toHaveLength(0);
});

test("the length cap is refused server-side", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  await expect(
    as.mutation(api.agentInstructions.set, {
      agentKey: "revival",
      extraInstructions: "x".repeat(EXTRA_INSTRUCTIONS_MAX + 1),
    }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });
});

test("an agent whose prompt does not read them refuses to store any", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  // Storing instructions an agent never reads would be a promise the
  // product cannot keep. Every BUILT agent reads them now, so the guard
  // is exercised against one that is not built.
  await expect(
    as.mutation(api.agentInstructions.set, {
      agentKey: "quote", extraInstructions: "Prefer visas",
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_SUPPORTED" } });
});

test("members may read instructions; only admins may change them", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "agent");

  await expect(
    as.query(api.agentInstructions.get, { agentKey: "revival" }),
  ).resolves.toBeTruthy();
  await expect(
    as.mutation(api.agentInstructions.set, {
      agentKey: "revival", extraInstructions: "nope",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});

test("the engines' server-side read returns null when there is nothing to append", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "admin");

  expect(
    await t.query(internal.agentInstructions.forAgent, { accountId, agentKey: "revival" }),
  ).toBeNull();

  await as.mutation(api.agentInstructions.set, {
    agentKey: "revival", extraInstructions: "Mention visas",
  });
  expect(
    await t.query(internal.agentInstructions.forAgent, { accountId, agentKey: "revival" }),
  ).toBe("Mention visas");
});

test("one account's instructions never reach another's agent", async () => {
  const t = convexTest(schema, modules);
  const mine = await seedMember(t, "admin");
  const theirs = await seedMember(t, "admin");
  await theirs.as.mutation(api.agentInstructions.set, {
    agentKey: "revival", extraInstructions: "Their private rule",
  });

  const got = await mine.as.query(api.agentInstructions.get, { agentKey: "revival" });
  expect(got.extraInstructions).toBe("");
});
