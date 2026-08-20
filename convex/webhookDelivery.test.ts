/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test } from "vitest";
import { internal } from "./_generated/api";
import { isDeliverableUrl } from "./webhookDelivery";
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

// ============================================================
// SSRF guard — `isDeliverableUrl`.
//
// The IPv4-mapped IPv6 cases below are REGRESSION tests for a real
// bypass: `new URL("http://[::ffff:127.0.0.1]/").hostname` normalizes to
// the hex form `[::ffff:7f00:1]`, so the guard's original
// `::ffff:<dotted-quad>` regex never matched and loopback / cloud-
// metadata / private targets were accepted. Every spelling of the same
// address must be rejected, so keep the "same target, many spellings"
// grouping if this list is extended.
// ============================================================

const BLOCKED_URLS = [
  // Plain IPv4 literals.
  "http://127.0.0.1/",
  "http://10.0.0.5/",
  "http://172.16.0.1/",
  "http://192.168.1.1/",
  "http://169.254.169.254/latest/meta-data/",
  "http://100.64.0.1/",
  "http://0.0.0.0/",
  // Alternative IPv4 encodings the URL parser normalizes for us.
  "http://2130706433/",
  "http://0177.0.0.1/",
  // IPv6 loopback / link-local / unique-local.
  "http://[::1]/",
  "http://[::]/",
  "http://[fe80::1]/",
  "http://[fd00::1]/",
  "http://[fc00::1]/",
  // IPv4-mapped IPv6 — dotted-quad spelling AND the hex form the URL
  // parser actually produces from it. This is the regressed bypass.
  "http://[::ffff:127.0.0.1]/",
  "http://[::ffff:7f00:1]/",
  "http://[::ffff:169.254.169.254]/",
  "http://[::ffff:a9fe:a9fe]/",
  "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
  "http://[::ffff:10.0.0.5]/",
  "http://[::ffff:a00:5]/",
  // Deprecated IPv4-compatible and NAT64 embeddings.
  "http://[::127.0.0.1]/",
  "http://[64:ff9b::169.254.169.254]/",
  // Internal hostname suffixes.
  "http://localhost/",
  "http://foo.localhost/",
  "http://db.local/",
  "http://svc.internal/",
  // Unparseable / malformed.
  "http://[:::1]/",
  "not-a-url",
];

for (const url of BLOCKED_URLS) {
  test(`isDeliverableUrl rejects ${url}`, () => {
    expect(isDeliverableUrl(url)).toBe(false);
  });
}

const ALLOWED_URLS = [
  "https://example.com/hooks",
  "https://hooks.slack.com/services/T000/B000/xxx",
  "http://93.184.216.34/",
  "https://[2606:4700:4700::1111]/",
  "https://sub.domain.example.co.uk:8443/path?q=1",
];

for (const url of ALLOWED_URLS) {
  test(`isDeliverableUrl allows ${url}`, () => {
    expect(isDeliverableUrl(url)).toBe(true);
  });
}
