/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

// Convex function modules for convex-test to resolve `internal.*`
// references against. Absolute, from-project-root pattern (matches
// every other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a bare `users` + `accounts` row — mirrors `convex/ingest.test.ts`'s
 * own `seedAccount`: `webhookDelivery.dispatch` is a caller-scoped
 * `internalAction` with no user session, so there's no membership to
 * seed either.
 */
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

/**
 * Inserts a `webhookEndpoints` row directly via `t.run` rather than
 * through `webhookEndpoints.create` — this suite is testing
 * `webhookDelivery.dispatch`'s selection + bookkeeping, not `create`'s
 * own admin-role gate (already covered by `webhookEndpoints.test.ts`),
 * so there's no need to seed a membership/identity just to call it.
 */
async function seedEndpoint(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    url: string;
    events: string[];
    isActive?: boolean;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("webhookEndpoints", {
      accountId: opts.accountId,
      url: opts.url,
      secret: "whsec_test_plaintext",
      events: opts.events,
      isActive: opts.isActive ?? true,
      failureCount: 0,
    }),
  );
}

// DRY-RUN for every test in this file — `dispatch` skips the real
// `fetch` call under `CONVEX_META_DRY_RUN`, same env var
// `metaSend.ts`'s actions read, so these tests never hit the network
// and stay fully deterministic (see `webhookDelivery.ts`'s header
// comment on why this suite otherwise couldn't run under the
// `edge-runtime` test environment anyway).
beforeEach(() => {
  process.env.CONVEX_META_DRY_RUN = "1";
});
afterEach(() => {
  delete process.env.CONVEX_META_DRY_RUN;
});

// ============================================================
// Selection — only active + subscribed endpoints get delivered to
// ============================================================

test("dispatch delivers only to active endpoints subscribed to the event", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  const subscribedActive = await seedEndpoint(t, {
    accountId,
    url: "https://example.com/hook-a",
    events: ["message.received"],
  });
  const subscribedButInactive = await seedEndpoint(t, {
    accountId,
    url: "https://example.com/hook-b",
    events: ["message.received"],
    isActive: false,
  });
  const activeButUnsubscribed = await seedEndpoint(t, {
    accountId,
    url: "https://example.com/hook-c",
    events: ["message.status_updated"],
  });
  const subscribedToBoth = await seedEndpoint(t, {
    accountId,
    url: "https://example.com/hook-d",
    events: ["conversation.created", "message.received"],
  });

  await t.action(internal.webhookDelivery.dispatch, {
    accountId,
    event: "message.received",
    payload: { conversationId: "conv_123" },
  });

  const [a, b, c, d] = await Promise.all(
    [
      subscribedActive,
      subscribedButInactive,
      activeButUnsubscribed,
      subscribedToBoth,
    ].map((id) => t.run((ctx) => ctx.db.get(id))),
  );

  // Selected: active + subscribed to the dispatched event.
  expect(a!.lastDeliveryAt).toBeDefined();
  expect(a!.failureCount).toBe(0);
  expect(d!.lastDeliveryAt).toBeDefined();

  // Skipped: inactive, and active-but-unsubscribed.
  expect(b!.lastDeliveryAt).toBeUndefined();
  expect(c!.lastDeliveryAt).toBeUndefined();
});

test("dispatch never throws when there are no matching endpoints", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");

  // `dispatch` is typed `Promise<void>`, but Convex serializes an
  // `undefined` handler return as `null` over the wire (same reason
  // `webhookDelivery.ts`'s own `recordSuccess`/`recordFailure` need an
  // explicit `await` rather than returning `ctx.runMutation(...)`
  // directly) — `t.action` surfaces that same `null`, not `undefined`.
  await expect(
    t.action(internal.webhookDelivery.dispatch, {
      accountId,
      event: "message.received",
      payload: {},
    }),
  ).resolves.toBeNull();
});

// ============================================================
// Account scoping
// ============================================================

test("dispatch is account-scoped: another account's subscribed + active endpoint is never touched", async () => {
  const t = convexTest(schema, modules);
  const accountA = await seedAccount(t, "Acme");
  const accountB = await seedAccount(t, "Globex");

  const endpointA = await seedEndpoint(t, {
    accountId: accountA,
    url: "https://a.example.com/hook",
    events: ["message.received"],
  });
  const endpointB = await seedEndpoint(t, {
    accountId: accountB,
    url: "https://b.example.com/hook",
    events: ["message.received"],
  });

  await t.action(internal.webhookDelivery.dispatch, {
    accountId: accountA,
    event: "message.received",
    payload: {},
  });

  const a = await t.run((ctx) => ctx.db.get(endpointA));
  const b = await t.run((ctx) => ctx.db.get(endpointB));
  expect(a!.lastDeliveryAt).toBeDefined();
  expect(b!.lastDeliveryAt).toBeUndefined();
  expect(b!.failureCount).toBe(0);
});

// ============================================================
// SSRF guard — runs even in DRY-RUN, counts as a failure
// ============================================================

test("dispatch refuses a private/loopback delivery target and records it as a failure", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const endpointId = await seedEndpoint(t, {
    accountId,
    url: "http://127.0.0.1:9000/hook",
    events: ["message.received"],
  });

  await t.action(internal.webhookDelivery.dispatch, {
    accountId,
    event: "message.received",
    payload: {},
  });

  const endpoint = await t.run((ctx) => ctx.db.get(endpointId));
  expect(endpoint!.lastDeliveryAt).toBeUndefined();
  expect(endpoint!.failureCount).toBe(1);
  expect(endpoint!.isActive).toBe(true); // one failure, well under the threshold
});

test("dispatch auto-disables an endpoint after MAX_CONSECUTIVE_FAILURES consecutive failures", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const endpointId = await seedEndpoint(t, {
    accountId,
    url: "http://169.254.169.254/hook", // cloud metadata address
    events: ["message.received"],
  });

  for (let i = 0; i < 15; i++) {
    await t.action(internal.webhookDelivery.dispatch, {
      accountId,
      event: "message.received",
      payload: {},
    });
  }

  const endpoint = await t.run((ctx) => ctx.db.get(endpointId));
  expect(endpoint!.failureCount).toBe(15);
  expect(endpoint!.isActive).toBe(false);
});
