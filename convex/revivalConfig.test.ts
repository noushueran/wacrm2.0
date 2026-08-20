/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { AccountRole } from "./lib/roles";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedMember(t: ReturnType<typeof convexTest>, role: AccountRole) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { name: role, email: `${role}@x.com` }),
  );
  const accountId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("accounts", {
      name: "A",
      defaultCurrency: "AED",
      ownerUserId: userId,
    });
    await ctx.db.insert("memberships", {
      userId,
      accountId: id,
      role,
      fullName: role,
      email: `${role}@x.com`,
    });
    return id;
  });
  return { userId, accountId, as: t.withIdentity({ subject: `${userId}|s` }) };
}

test("an account that never configured the agent reads as off, not missing", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  const config = await as.query(api.revivalConfig.get, {});
  expect(config.isPersisted).toBe(false);
  expect(config.enabled).toBe(false);
  expect(config.minQuietMinutes).toBe(180);
});

test("the first save creates the row with defaults plus the change", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  await as.mutation(api.revivalConfig.update, { enabled: true });

  const config = await as.query(api.revivalConfig.get, {});
  expect(config.isPersisted).toBe(true);
  expect(config.enabled).toBe(true);
  // Untouched fields land on their defaults rather than zero.
  expect(config.cooldownHours).toBe(72);
  expect(config.draftsPerRun).toBe(20);
});

test("toggling enabled never resets tuned thresholds", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  await as.mutation(api.revivalConfig.update, {
    enabled: true,
    minQuietMinutes: 300,
    minLeadScore: 7,
  });
  await as.mutation(api.revivalConfig.update, { enabled: false });

  const config = await as.query(api.revivalConfig.get, {});
  expect(config.enabled).toBe(false);
  expect(config.minQuietMinutes).toBe(300);
  expect(config.minLeadScore).toBe(7);
});

test("out-of-bounds values are refused server-side, not merely in the form", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  await expect(
    as.mutation(api.revivalConfig.update, { minQuietMinutes: 2 }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });

  await expect(
    as.mutation(api.revivalConfig.update, { windowSafetyMinutes: 0 }),
  ).rejects.toMatchObject({ data: { code: "BAD_REQUEST" } });

  // And nothing was written.
  expect((await as.query(api.revivalConfig.get, {})).isPersisted).toBe(false);
});

test("only an admin may read or change who gets messaged", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "agent");

  await expect(as.query(api.revivalConfig.get, {})).rejects.toMatchObject({
    data: { code: "FORBIDDEN" },
  });
  await expect(
    as.mutation(api.revivalConfig.update, { enabled: true }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});

test("enabling here is what wakes the sweep", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "admin");

  await as.mutation(api.revivalConfig.update, { enabled: true });

  const rows = await t.run((ctx) => ctx.db.query("revivalConfigs").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]!.accountId).toBe(accountId);
  expect(rows[0]!.enabled).toBe(true);
});

test("an owner may enable it — the only privileged role in production", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "owner");

  await as.mutation(api.revivalConfig.update, { enabled: true });

  const config = await as.query(api.revivalConfig.get, {});
  expect(config.enabled).toBe(true);
  expect(config.isPersisted).toBe(true);
});
