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
      userId, accountId: id, role, fullName: role, email: `${role}@x.com`,
    });
    return id;
  });
  return { userId, accountId, as: t.withIdentity({ subject: `${userId}|s` }) };
}

test("the revival switch creates its config from defaults on first use", async () => {
  const t = convexTest(schema, modules);
  const { accountId, as } = await seedMember(t, "admin");

  await as.mutation(api.agentControls.setEnabled, { agentKey: "revival", enabled: true });

  const rows = await t.run((ctx) => ctx.db.query("revivalConfigs").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]!.accountId).toBe(accountId);
  expect(rows[0]!.enabled).toBe(true);
  // Defaults filled in, not zeroes.
  expect(rows[0]!.minQuietMinutes).toBe(180);
});

test("turning the reply agent off leaves isActive alone", async () => {
  const t = convexTest(schema, modules);
  const { accountId, userId, as } = await seedMember(t, "admin");
  await t.run((ctx) =>
    ctx.db.insert("aiConfigs", {
      accountId, createdByUserId: userId, provider: "openai", model: "gpt-5",
      apiKey: "cipher", isActive: true, autoReplyEnabled: true, updatedAt: Date.now(),
    }),
  );

  await as.mutation(api.agentControls.setEnabled, { agentKey: "reply", enabled: false });

  const row = await t.run((ctx) => ctx.db.query("aiConfigs").first());
  expect(row!.autoReplyEnabled).toBe(false);
  // The tag suggester rides isActive — switching off auto-reply must not
  // silently disable a colleague's tool.
  expect(row!.isActive).toBe(true);
});

test("an agent with no switch of its own refuses to be toggled", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  for (const agentKey of ["checklist", "tags", "admatch"]) {
    await expect(
      as.mutation(api.agentControls.setEnabled, { agentKey, enabled: false }),
    ).rejects.toMatchObject({ data: { code: "NO_OWN_SWITCH" } });
  }
});

test("an unbuilt agent cannot be switched on", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  await expect(
    as.mutation(api.agentControls.setEnabled, { agentKey: "quote", enabled: true }),
  ).rejects.toMatchObject({ data: { code: "NOT_BUILT" } });
});

test("toggling an agent whose config does not exist yet says so rather than half-creating one", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  await expect(
    as.mutation(api.agentControls.setEnabled, { agentKey: "reply", enabled: true }),
  ).rejects.toMatchObject({ data: { code: "NOT_CONFIGURED" } });
});

test("only an admin may flip a switch", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "agent");

  await expect(
    as.mutation(api.agentControls.setEnabled, { agentKey: "revival", enabled: true }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});

test("an unknown agent key is not found", async () => {
  const t = convexTest(schema, modules);
  const { as } = await seedMember(t, "admin");

  await expect(
    as.mutation(api.agentControls.setEnabled, { agentKey: "nope", enabled: true }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND" } });
});
