import { afterEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";
import { extractRefCode, extractCtwaClid } from "./attribution";

test("extractRefCode finds our code anywhere, uppercased", () => {
  expect(extractRefCode("Hi… my enquiry ref: hy-3f9k2q")).toBe("HY-3F9K2Q");
  expect(extractRefCode("just a normal message")).toBeNull();
  expect(extractRefCode(undefined)).toBeNull();
});

test("extractCtwaClid reads a flattened ctwaClid", () => {
  expect(extractCtwaClid({ ctwaClid: "abc123" })).toBe("abc123");
  expect(extractCtwaClid({})).toBeNull();
});

test("extractRefCode embeds code mid-sentence", () => {
  expect(extractRefCode("book now HY-ABCDEF please")).toBe("HY-ABCDEF");
});

test("extractRefCode charset boundary", () => {
  expect(extractRefCode("HY-IIIIII")).toBeNull();
  expect(extractRefCode("HY-000000")).toBe("HY-000000");
  expect(extractRefCode("HY-ABCDEL")).toBeNull(); // L now excluded
});

test("extractRefCode null input", () => {
  expect(extractRefCode(null)).toBeNull();
  expect(extractRefCode("")).toBeNull(); // empty string
});

// ============================================================
// recordSignal (Task B3) — convex-test integration. Convex function
// modules for convex-test to resolve `internal.*` references against.
// Absolute, from-project-root pattern (matches every other
// `convex/*.test.ts` suite — see `convex/ingest.test.ts`'s own comment
// on why this must be absolute rather than a relative "./**").
// ============================================================

const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Bare `users` + `accounts` row — same minimal shape as
 * `ingest.test.ts`'s own `seedAccount`: `recordSignal` is a plain
 * `internalMutation` with an explicit caller-supplied `accountId`, no
 * session/role to seed against — only the `accounts.ownerUserId` FK
 * `accounts` itself requires. Duplicated here (not imported) per this
 * suite's own established per-suite-owns-its-own-helpers convention.
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

/** Minimal valid `contacts` row: `accountId`/`phone`/`phoneNormalized`
 *  are the table's only required fields (`convex/schema.ts`). */
async function seedContact(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId,
      phone: "15551234567",
      phoneNormalized: "15551234567",
    }),
  );
}

/** Minimal valid `conversations` row: `accountId`/`contactId`/`status`/
 *  `unreadCount` are the table's only required fields. */
async function seedConversation(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  contactId: Id<"contacts">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      unreadCount: 0,
    }),
  );
}

test("recordSignal inserts a fresh pending row on first occurrence and returns its id", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const firstMessageAt = Date.now();

  const id = await t.mutation(internal.attribution.recordSignal, {
    accountId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    contactId,
    conversationId,
    firstMessageAt,
  });

  expect(id).not.toBeNull();

  const row = await t.run((ctx) =>
    ctx.db.get(id as Id<"attributionSignals">),
  );
  expect(row).not.toBeNull();
  expect(row!.accountId).toBe(accountId);
  expect(row!.identifier).toBe("HY-ABCDEF");
  expect(row!.lane).toBe("code");
  expect(row!.phone).toBe("15551234567");
  expect(row!.waMessageId).toBe("wamid.SIGNAL1");
  expect(row!.contactId).toBe(contactId);
  expect(row!.conversationId).toBe(conversationId);
  expect(row!.firstMessageAt).toBe(firstMessageAt);
  expect(row!.landingResult).toBe("pending");
  expect(row!.attempts).toBe(0);
});

test("recordSignal is idempotent: a second call for the same (accountId, identifier) returns null and does not insert a duplicate", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);

  const first = await t.mutation(internal.attribution.recordSignal, {
    accountId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    contactId,
    conversationId,
    firstMessageAt: Date.now(),
  });
  expect(first).not.toBeNull();

  // Same (accountId, identifier), deliberately different phone/wamid —
  // proves the dedupe key is (accountId, identifier) alone, not the
  // rest of the payload.
  const second = await t.mutation(internal.attribution.recordSignal, {
    accountId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15559999999",
    waMessageId: "wamid.SIGNAL2",
    contactId,
    conversationId,
    firstMessageAt: Date.now(),
  });
  expect(second).toBeNull();

  const rows = await t.run((ctx) =>
    ctx.db
      .query("attributionSignals")
      .withIndex("by_account_identifier", (q) =>
        q.eq("accountId", accountId).eq("identifier", "HY-ABCDEF"),
      )
      .collect(),
  );
  expect(rows).toHaveLength(1);
});

test("recordSignal dedupe is per-account: the same identifier under a different accountId inserts its own independent row", async () => {
  const t = convexTest(schema, modules);
  const accountA = await seedAccount(t, "Acme");
  const accountB = await seedAccount(t, "Globex");
  const contactA = await seedContact(t, accountA);
  const contactB = await seedContact(t, accountB);
  const conversationA = await seedConversation(t, accountA, contactA);
  const conversationB = await seedConversation(t, accountB, contactB);

  const idA = await t.mutation(internal.attribution.recordSignal, {
    accountId: accountA,
    identifier: "HY-SHARED",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.A1",
    contactId: contactA,
    conversationId: conversationA,
    firstMessageAt: Date.now(),
  });
  const idB = await t.mutation(internal.attribution.recordSignal, {
    accountId: accountB,
    identifier: "HY-SHARED",
    lane: "code",
    phone: "15557654321",
    waMessageId: "wamid.B1",
    contactId: contactB,
    conversationId: conversationB,
    firstMessageAt: Date.now(),
  });

  expect(idA).not.toBeNull();
  expect(idB).not.toBeNull();
  expect(idA).not.toBe(idB);
});

// ============================================================
// getSignal / patchResult / sendSignal (Task B5) — the outbound side:
// POST the signal to Platform A's `/whatsapp-conversion` endpoint and
// record the result. `getSignal`/`patchResult` are the plain
// query/mutation primitives `sendSignal` (an `internalAction`, which
// has no `ctx.db` of its own) goes through to read/write the row —
// same shape as `webhookEndpoints.ts`'s `listActiveForEvent`/
// `recordDeliverySuccess`/`recordDeliveryFailure` backing
// `webhookDelivery.ts`'s `dispatch`.
//
// FETCH-MOCKING NOTE: this task's brief said to copy
// `webhookDelivery.test.ts`'s fetch-mocking approach — but that file
// turns out not to mock `fetch` at all. Every one of its tests sets
// `CONVEX_META_DRY_RUN=1`, which makes `webhookDelivery.ts`'s
// `deliverOne` skip the real `fetch` call entirely, so that suite never
// exercises a real response body. That short-circuit can't produce the
// specific matched/unmatched/401/throw JSON responses these tests need,
// so this suite instead follows the pattern actually used everywhere
// else in this codebase for asserting on real fetch responses under
// convex-test: `vi.stubGlobal("fetch", ...)` + `vi.unstubAllGlobals()`
// after (see `metaTemplates.test.ts`'s `submitToMeta` tests,
// `ingest.test.ts`'s media-resolution test, `automationsEngine.test.ts`'s
// `send_webhook` test, `whatsappConfig.test.ts`, `templates.test.ts`,
// `aiConfig.test.ts`, `files.test.ts`, `lib/ai/generate.test.ts` — all
// of the same shape). `metaTemplates.test.ts`'s `submitToMeta` tests are
// the closest sibling: a Bearer-token POST whose JSON response is
// parsed and branched on, same as `sendSignal` here.
// ============================================================

afterEach(() => {
  // Belt-and-suspenders, matching every other fetch-mocking suite's own
  // afterEach (`ingest.test.ts`'s comment on this exact pattern): a
  // thrown assertion inside a fetch mock could otherwise skip a test's
  // own cleanup and leak into the next test. `vi.useRealTimers()` is
  // for the `retryPending` test further below, which opts into
  // `vi.useFakeTimers()` to drain its scheduled `sendSignal` calls
  // (mirrors `ingest.test.ts`'s own identical addition for the same
  // reason on its `processInbound` scheduling test).
  delete process.env.LANDING_CONVERSION_URL;
  delete process.env.WA_CONVERSION_SHARED_SECRET;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Seeds a signal row via `recordSignal` (Task B3) and returns its id. */
async function seedSignal(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    conversationId: Id<"conversations">;
    identifier: string;
    lane: "code" | "ctwa";
    phone: string;
    waMessageId: string;
    firstMessageAt: number;
  },
): Promise<Id<"attributionSignals">> {
  const id = await t.mutation(internal.attribution.recordSignal, opts);
  return id as Id<"attributionSignals">;
}

// ------------------------------------------------------------
// getSignal
// ------------------------------------------------------------

test("getSignal returns the row for an existing signalId", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });

  const row = await t.query(internal.attribution.getSignal, { signalId });
  expect(row).not.toBeNull();
  expect(row!._id).toBe(signalId);
  expect(row!.identifier).toBe("HY-ABCDEF");
});

test("getSignal returns null for a signalId that does not exist", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });
  await t.run((ctx) => ctx.db.delete(signalId));

  const row = await t.query(internal.attribution.getSignal, { signalId });
  expect(row).toBeNull();
});

// ------------------------------------------------------------
// patchResult
// ------------------------------------------------------------

test("patchResult sets landingResult and the provided optional fields, leaving attempts unchanged when bumpAttempts is omitted", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });

  await t.mutation(internal.attribution.patchResult, {
    signalId,
    landingResult: "matched",
    offerSlug: "summer",
    firedAt: 1720000000000,
  });

  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("matched");
  expect(row!.offerSlug).toBe("summer");
  expect(row!.firedAt).toBe(1720000000000);
  expect(row!.attempts).toBe(0); // bumpAttempts not passed
});

test("patchResult bumps attempts by exactly one per call when bumpAttempts is true", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });

  await t.mutation(internal.attribution.patchResult, {
    signalId,
    landingResult: "error",
    bumpAttempts: true,
  });
  await t.mutation(internal.attribution.patchResult, {
    signalId,
    landingResult: "error",
    bumpAttempts: true,
  });

  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("error");
  expect(row!.attempts).toBe(2);
});

test("patchResult is a no-op when the signalId does not exist", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });
  await t.run((ctx) => ctx.db.delete(signalId));

  // Undefined handler return serializes as `null` over the wire (same
  // reason `webhookDelivery.ts`'s own `recordSuccess`/`recordFailure`
  // need an explicit `await` — see that file's comment).
  await expect(
    t.mutation(internal.attribution.patchResult, {
      signalId,
      landingResult: "matched",
    }),
  ).resolves.toBeNull();
});

test("patchResult retires a row to abandoned once an error bump reaches the attempts cap (5), but not before", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  // One short of the cap-minus-one: the SECOND error bump below is the
  // 5th (cap-reaching) attempt.
  const signalId = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABAND1",
    landingResult: "error",
    attempts: 3,
  });

  // 4th attempt: 3 -> 4 stays under the cap, so it remains a retryable
  // "error" — the transition fires AT the cap, never before.
  await t.mutation(internal.attribution.patchResult, {
    signalId,
    landingResult: "error",
    bumpAttempts: true,
  });
  let row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("error");
  expect(row!.attempts).toBe(4);

  // 5th attempt: 4 -> 5 reaches the cap, so the row is retired to the
  // terminal "abandoned" state instead of another retryable "error" —
  // this is what keeps it out of the "error" partition getPendingToRetry
  // scans.
  await t.mutation(internal.attribution.patchResult, {
    signalId,
    landingResult: "error",
    bumpAttempts: true,
  });
  row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("abandoned");
  expect(row!.attempts).toBe(5);
});

// ------------------------------------------------------------
// sendSignal — dormant when env is not configured (the CURRENT prod
// state: `LANDING_CONVERSION_URL`/`WA_CONVERSION_SHARED_SECRET` are not
// set on the deployment yet).
// ------------------------------------------------------------

test("sendSignal records an error without calling fetch when LANDING_CONVERSION_URL is not configured", async () => {
  delete process.env.LANDING_CONVERSION_URL;
  process.env.WA_CONVERSION_SHARED_SECRET = "shh-secret";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });

  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await t.action(internal.attribution.sendSignal, { signalId });

  expect(fetchMock).not.toHaveBeenCalled();
  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("error");
  expect(row!.attempts).toBe(1);
});

test("sendSignal records an error without calling fetch when WA_CONVERSION_SHARED_SECRET is not configured", async () => {
  process.env.LANDING_CONVERSION_URL =
    "https://platform-a.example.com/whatsapp-conversion";
  delete process.env.WA_CONVERSION_SHARED_SECRET;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });

  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await t.action(internal.attribution.sendSignal, { signalId });

  expect(fetchMock).not.toHaveBeenCalled();
  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("error");
  expect(row!.attempts).toBe(1);
});

test("sendSignal retires a row to abandoned when its final (cap-reaching) attempt fails", async () => {
  // Dormant env → sendSignal takes its error path with no network call,
  // the same give-up path a persistent Platform A outage would hit on
  // the 5th attempt.
  delete process.env.LANDING_CONVERSION_URL;
  delete process.env.WA_CONVERSION_SHARED_SECRET;
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  // Already 4 failed attempts — this one is the 5th and reaches the cap.
  const signalId = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABAND2",
    landingResult: "error",
    attempts: 4,
  });

  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await t.action(internal.attribution.sendSignal, { signalId });

  expect(fetchMock).not.toHaveBeenCalled();
  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("abandoned");
  expect(row!.attempts).toBe(5);
});

// ------------------------------------------------------------
// sendSignal — real POST (fetch mocked)
// ------------------------------------------------------------

test("sendSignal (matched): POSTs the code-lane identifier + phone/waMessageId/firstMessageAt and records matched + firedAt + offerSlug", async () => {
  process.env.LANDING_CONVERSION_URL =
    "https://platform-a.example.com/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "shh-secret";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const firstMessageAt = Date.now();
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt,
  });

  // CAPTURE-then-assert-after (NOT `expect` inside the mock): `sendSignal`
  // wraps `fetch` in a try/catch that never rethrows, so an assertion
  // thrown from inside the mock would be swallowed — the request would
  // look like a network failure and land as `landingResult:"error"`,
  // while `fetchMock` was still "called once". Capturing the request and
  // asserting on it AFTER the action resolves makes a wrong URL/header/
  // body fail the test DIRECTLY.
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        matched: true,
        alreadyFired: false,
        firedAt: 1720000000000,
        offerSlug: "summer",
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);

  await t.action(internal.attribution.sendSignal, { signalId });

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(capturedUrl).toBe(
    "https://platform-a.example.com/whatsapp-conversion",
  );
  expect(capturedInit!.method).toBe("POST");
  const headers = capturedInit!.headers as Record<string, string>;
  expect(headers.Authorization).toBe("Bearer shh-secret");
  expect(headers["Content-Type"]).toBe("application/json");
  expect(JSON.parse(capturedInit!.body as string)).toEqual({
    code: "HY-ABCDEF",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt,
  });

  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("matched");
  expect(row!.firedAt).toBe(1720000000000);
  expect(row!.offerSlug).toBe("summer");
});

test("sendSignal (unmatched): a 200 response with matched:false records unmatched and leaves firedAt unset", async () => {
  process.env.LANDING_CONVERSION_URL =
    "https://platform-a.example.com/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "shh-secret";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            matched: false,
            alreadyFired: false,
            reason: "code_not_found",
          }),
          { status: 200 },
        ),
    ),
  );

  await t.action(internal.attribution.sendSignal, { signalId });

  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("unmatched");
  expect(row!.firedAt).toBeUndefined();
  expect(row!.attempts).toBe(0);
});

test("sendSignal (non-200): a 401 response records error and bumps attempts 0 -> 1", async () => {
  process.env.LANDING_CONVERSION_URL =
    "https://platform-a.example.com/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "shh-secret";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ reason: "unauthorized" }), {
          status: 401,
        }),
    ),
  );

  await t.action(internal.attribution.sendSignal, { signalId });

  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("error");
  expect(row!.attempts).toBe(1);
});

test("sendSignal (throw): a rejected fetch records error and bumps attempts", async () => {
  process.env.LANDING_CONVERSION_URL =
    "https://platform-a.example.com/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "shh-secret";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("network down");
    }),
  );

  await t.action(internal.attribution.sendSignal, { signalId });

  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("error");
  expect(row!.attempts).toBe(1);
});

test("sendSignal (non-JSON 200 body): res.json() throwing inside the try lands as error + attempts bump", async () => {
  process.env.LANDING_CONVERSION_URL =
    "https://platform-a.example.com/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "shh-secret";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });

  // 200 but not JSON — `res.json()` rejects. Because that parse is INSIDE
  // `sendSignal`'s try, the rejection is caught the same as a network
  // error: the row lands `"error"` and `attempts` is bumped (rather than,
  // say, an unhandled rejection escaping the action).
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("not json", { status: 200 })),
  );

  await t.action(internal.attribution.sendSignal, { signalId });

  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("error");
  expect(row!.attempts).toBe(1);
});

test("sendSignal (already matched): never re-POSTs a signal whose landingResult is already matched", async () => {
  process.env.LANDING_CONVERSION_URL =
    "https://platform-a.example.com/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "shh-secret";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABCDEF",
    lane: "code",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt: Date.now(),
  });
  await t.mutation(internal.attribution.patchResult, {
    signalId,
    landingResult: "matched",
    firedAt: 1710000000000,
    offerSlug: "spring",
  });

  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await t.action(internal.attribution.sendSignal, { signalId });

  expect(fetchMock).not.toHaveBeenCalled();
  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("matched");
  expect(row!.firedAt).toBe(1710000000000);
  expect(row!.offerSlug).toBe("spring");
});

test("sendSignal (ctwa lane): POSTs the identifier under a ctwaClid key, not code", async () => {
  process.env.LANDING_CONVERSION_URL =
    "https://platform-a.example.com/whatsapp-conversion";
  process.env.WA_CONVERSION_SHARED_SECRET = "shh-secret";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);
  const firstMessageAt = Date.now();
  const signalId = await seedSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "clid-abc123",
    lane: "ctwa",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt,
  });

  // CAPTURE-then-assert-after — see the matched test's comment. This is
  // the ONLY coverage of the "identifier key chosen by lane" contract
  // for the ctwa branch, so the body assertion MUST bite: asserting
  // inside the mock would let a wrong branch (e.g. always `{ code }`)
  // pass, because `sendSignal`'s catch would absorb the thrown assertion
  // and `fetchMock` would still read as called-once.
  let capturedBody: string | undefined;
  const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    capturedBody = init!.body as string;
    return new Response(JSON.stringify({ matched: false }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  await t.action(internal.attribution.sendSignal, { signalId });

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(JSON.parse(capturedBody!)).toEqual({
    ctwaClid: "clid-abc123",
    phone: "15551234567",
    waMessageId: "wamid.SIGNAL1",
    firstMessageAt,
  });
  // The lane's key is `ctwaClid`, never `code` — assert the wrong key is
  // absent so a regression to `{ code }` fails here, not silently.
  expect(JSON.parse(capturedBody!)).not.toHaveProperty("code");
  const row = await t.run((ctx) => ctx.db.get(signalId));
  expect(row!.landingResult).toBe("unmatched");
});

// ============================================================
// getPendingToRetry / retryPending (Task B6) — the retry safety net:
// finds `attributionSignals` rows stuck `"error"` or `"pending"`
// (attempts < 5) and re-schedules `sendSignal` for each so a transient
// Platform A outage (or a scheduled `sendSignal` that never ran) isn't
// permanent. `getPendingToRetry` is global (no `accountId`) — the cron
// (`convex/crons.ts`) has no account context — and reads the new
// `by_result` index rather than scanning every account's rows.
// ============================================================

/** Direct `attributionSignals` insert with caller-controlled
 *  `landingResult`/`attempts`. Unlike `seedSignal` above (which always
 *  produces a fresh `"pending"`/`0` row via the real `recordSignal`
 *  mutation), these tests need arbitrary combinations — `"error"` with
 *  a specific attempts count, `"matched"`, etc. — so this goes
 *  straight through `ctx.db.insert`, per this task's own brief. */
async function insertSignalRow(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    conversationId: Id<"conversations">;
    identifier: string;
    landingResult: "pending" | "matched" | "unmatched" | "error" | "abandoned";
    attempts: number;
  },
): Promise<Id<"attributionSignals">> {
  return await t.run((ctx) =>
    ctx.db.insert("attributionSignals", {
      accountId: opts.accountId,
      identifier: opts.identifier,
      lane: "code",
      phone: "15551234567",
      waMessageId: `wamid.${opts.identifier}`,
      contactId: opts.contactId,
      conversationId: opts.conversationId,
      firstMessageAt: Date.now(),
      landingResult: opts.landingResult,
      attempts: opts.attempts,
    }),
  );
}

// ------------------------------------------------------------
// getPendingToRetry
// ------------------------------------------------------------

test("getPendingToRetry returns error/pending rows with attempts < 5, excluding matched, unmatched, and attempts >= 5", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);

  const includedError = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ERR001",
    landingResult: "error",
    attempts: 0,
  });
  const excludedMaxedOutError = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ERR005",
    landingResult: "error",
    attempts: 5,
  });
  const includedPending = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-PEND02",
    landingResult: "pending",
    attempts: 2,
  });
  const excludedMatched = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-MATCHD",
    landingResult: "matched",
    attempts: 0,
  });
  const excludedUnmatched = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-UNMTCH",
    landingResult: "unmatched",
    attempts: 0,
  });

  const rows = await t.query(internal.attribution.getPendingToRetry, {});

  // Exactly the two included rows — not a subset/superset.
  expect(rows).toHaveLength(2);
  const ids = new Set(rows.map((row) => row._id));
  expect(ids.has(includedError)).toBe(true);
  expect(ids.has(includedPending)).toBe(true);
  expect(ids.has(excludedMaxedOutError)).toBe(false);
  expect(ids.has(excludedMatched)).toBe(false);
  expect(ids.has(excludedUnmatched)).toBe(false);
});

test("getPendingToRetry excludes abandoned (terminal) rows — they have left the error partition entirely", async () => {
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);

  // A live, still-retryable error row alongside one that maxed out and
  // was retired to "abandoned" (attempts == the cap). Because an
  // abandoned row is in neither the "error" nor "pending" partition of
  // `by_result`, `getPendingToRetry`'s two indexed reads never surface it
  // at all — the point of the terminal state. Only the live row returns.
  const liveError = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-LIVE01",
    landingResult: "error",
    attempts: 2,
  });
  const abandoned = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-DEAD05",
    landingResult: "abandoned",
    attempts: 5,
  });

  const rows = await t.query(internal.attribution.getPendingToRetry, {});

  const ids = new Set(rows.map((row) => row._id));
  expect(ids.has(liveError)).toBe(true);
  expect(ids.has(abandoned)).toBe(false);
});

// ------------------------------------------------------------
// retryPending
// ------------------------------------------------------------

test("retryPending re-schedules sendSignal for every error/pending row; draining the scheduler bumps their attempts and leaves a matched row untouched", async () => {
  // Dormant sendSignal branch (env unset) — deterministic, no fetch
  // mock needed: every scheduled sendSignal call lands "error" + bumps
  // attempts by exactly 1, so this test can assert the *count* of
  // signals retryPending actually scheduled.
  delete process.env.LANDING_CONVERSION_URL;
  vi.useFakeTimers();
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);

  const error1 = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ERR001",
    landingResult: "error",
    attempts: 0,
  });
  const error2 = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ERR002",
    landingResult: "error",
    attempts: 1,
  });
  const matched = await insertSignalRow(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-MATCHD",
    landingResult: "matched",
    attempts: 0,
  });

  await t.action(internal.attribution.retryPending, {});

  // Not yet run — convex-test does not auto-run scheduled functions
  // (mirrors `ingest.test.ts`'s identical comment on its own
  // sendSignal-scheduling test), so both error rows are still exactly
  // as seeded until the scheduler queue is drained below.
  let row1 = await t.run((ctx) => ctx.db.get(error1));
  expect(row1!.attempts).toBe(0);

  // Proves the schedule happened: draining the scheduler queue is the
  // only way these rows could change at all.
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  row1 = await t.run((ctx) => ctx.db.get(error1));
  const row2 = await t.run((ctx) => ctx.db.get(error2));
  const rowMatched = await t.run((ctx) => ctx.db.get(matched));

  expect(row1!.landingResult).toBe("error");
  expect(row1!.attempts).toBe(1);
  expect(row2!.landingResult).toBe("error");
  expect(row2!.attempts).toBe(2);

  // retryPending never selects the matched row in the first place
  // (getPendingToRetry excludes it) — untouched, not merely guarded by
  // sendSignal's own already-matched check.
  expect(rowMatched!.landingResult).toBe("matched");
  expect(rowMatched!.attempts).toBe(0);
});

// ============================================================
// listConversions (Task B7a) — admin-gated, account-scoped read side
// for the attribution "conversions" admin view (Task B7b's UI). Unlike
// every other function tested above, `listConversions` is a PUBLIC
// `accountQuery` — it needs an AUTHENTICATED caller with a real
// `memberships` row, which `seedAccount` above deliberately does NOT
// set up (see that helper's own header comment: every other function
// in this file is a session-less `internalMutation`/`internalQuery`/
// `internalAction`, so it only ever needed the bare `accounts.
// ownerUserId` FK). `seedAccountMember` below is the standard
// authenticated-caller helper used throughout this codebase for
// `accountQuery`/`accountMutation` suites (identical copy in e.g.
// `convex/aiKnowledge.test.ts`) — duplicated here rather than
// imported, per this file's own established per-suite-owns-its-own-
// helpers convention.
// ============================================================

/**
 * Seeds a `users` row + a fresh `accounts`/`memberships` row and
 * returns a convex-test client already authenticated as that user —
 * same shape as every other suite's `seedAccountMember` (see
 * `convex/aiKnowledge.test.ts`).
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
 * Direct `attributionSignals` insert with full control over every
 * field `listConversions` reads or returns. Unlike `insertSignalRow`
 * above (Task B6's helper, which fixes `phone`/`lane` and derives
 * `waMessageId` from `identifier` alone), these tests need a distinct
 * phone/identifier/lane/offerSlug/firedAt per row so the assertions
 * below prove the handler's field mapping and its firedAt-desc sort
 * are real, not coincidentally correct from insertion order.
 */
async function seedFullSignal(
  t: ReturnType<typeof convexTest>,
  opts: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    conversationId: Id<"conversations">;
    identifier: string;
    lane: "code" | "ctwa";
    phone: string;
    landingResult: "pending" | "matched" | "unmatched" | "error" | "abandoned";
    offerSlug?: string;
    firedAt?: number;
    firstMessageAt?: number;
  },
): Promise<Id<"attributionSignals">> {
  return await t.run((ctx) =>
    ctx.db.insert("attributionSignals", {
      accountId: opts.accountId,
      identifier: opts.identifier,
      lane: opts.lane,
      phone: opts.phone,
      waMessageId: `wamid.${opts.identifier}`,
      contactId: opts.contactId,
      conversationId: opts.conversationId,
      firstMessageAt: opts.firstMessageAt ?? Date.now(),
      landingResult: opts.landingResult,
      offerSlug: opts.offerSlug,
      firedAt: opts.firedAt,
      attempts: 0,
    }),
  );
}

test("listConversions returns only matched conversions with phone, sorted by firedAt desc, and counts reflect the full mix", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const contactId = await seedContact(t, accountId);
  const conversationId = await seedConversation(t, accountId, contactId);

  // The OLDEST-firedAt matched row is inserted FIRST (earliest
  // `_creationTime`) and the NEWEST-firedAt matched row SECOND — the
  // opposite of the expected output order. A handler that merely
  // returned the `by_account_result` scan's natural order instead of
  // actually sorting by `firedAt` would yield [old, new] here, not the
  // expected [new, old] below — so this genuinely exercises the sort.
  const matchedOldId = await seedFullSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-OLD001",
    lane: "code",
    phone: "15550000001",
    landingResult: "matched",
    offerSlug: "spring",
    firedAt: 1_700_000_000_000,
    firstMessageAt: 1_600_000_000_000,
  });
  const matchedNewId = await seedFullSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "clid-new002",
    lane: "ctwa",
    phone: "15550000002",
    landingResult: "matched",
    offerSlug: "summer",
    firedAt: 1_800_000_000_000,
    firstMessageAt: 1_650_000_000_000,
  });
  await seedFullSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-PEND01",
    lane: "code",
    phone: "15550000003",
    landingResult: "pending",
  });
  await seedFullSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-UNMT01",
    lane: "code",
    phone: "15550000004",
    landingResult: "unmatched",
  });
  await seedFullSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ERR001",
    lane: "code",
    phone: "15550000005",
    landingResult: "error",
  });
  // A retired (terminal) signal — counted in its own `abandoned` bucket
  // and in `total`, but never surfaced as a matched conversion.
  await seedFullSignal(t, {
    accountId,
    contactId,
    conversationId,
    identifier: "HY-ABND01",
    lane: "code",
    phone: "15550000006",
    landingResult: "abandoned",
  });

  const result = await asAlice.query(api.attribution.listConversions, {});

  expect(result.counts).toEqual({
    total: 6,
    matched: 2,
    pending: 1,
    unmatched: 1,
    error: 1,
    abandoned: 1,
  });
  expect(result.conversions).toHaveLength(2);
  expect(result.conversions[0]).toEqual({
    id: matchedNewId,
    phone: "15550000002",
    identifier: "clid-new002",
    lane: "ctwa",
    offerSlug: "summer",
    firedAt: 1_800_000_000_000,
    firstMessageAt: 1_650_000_000_000,
  });
  expect(result.conversions[1]).toEqual({
    id: matchedOldId,
    phone: "15550000001",
    identifier: "HY-OLD001",
    lane: "code",
    offerSlug: "spring",
    firedAt: 1_700_000_000_000,
    firstMessageAt: 1_600_000_000_000,
  });
});

test("listConversions is account-scoped: never returns another account's conversions (mandatory cross-account isolation)", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAlice, accountId: accountA } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "admin",
  });
  const contactA = await seedContact(t, accountA);
  const conversationA = await seedConversation(t, accountA, contactA);
  await seedFullSignal(t, {
    accountId: accountA,
    contactId: contactA,
    conversationId: conversationA,
    identifier: "HY-A-MATCH",
    lane: "code",
    phone: "15551110000",
    landingResult: "matched",
    offerSlug: "a-offer",
    firedAt: 1_700_000_000_000,
  });

  const { asUser: asBob, accountId: accountB } = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "admin",
  });
  const contactB = await seedContact(t, accountB);
  const conversationB = await seedConversation(t, accountB, contactB);
  await seedFullSignal(t, {
    accountId: accountB,
    contactId: contactB,
    conversationId: conversationB,
    identifier: "HY-B-MATCH",
    lane: "code",
    phone: "15552220000",
    landingResult: "matched",
    offerSlug: "b-offer",
    firedAt: 1_700_000_000_000,
  });

  const resultA = await asAlice.query(api.attribution.listConversions, {});
  expect(resultA.conversions).toHaveLength(1);
  expect(resultA.conversions[0].identifier).toBe("HY-A-MATCH");
  expect(resultA.conversions[0].phone).toBe("15551110000");
  expect(resultA.counts.total).toBe(1);
  expect(resultA.conversions.some((c) => c.identifier === "HY-B-MATCH")).toBe(
    false,
  );
  expect(resultA.conversions.some((c) => c.phone === "15552220000")).toBe(
    false,
  );

  // Symmetric check on B's side — proves the scoping isn't an artifact
  // of insertion order (e.g. "only ever returns the first account").
  const resultB = await asBob.query(api.attribution.listConversions, {});
  expect(resultB.conversions).toHaveLength(1);
  expect(resultB.conversions[0].identifier).toBe("HY-B-MATCH");
  expect(resultB.conversions[0].phone).toBe("15552220000");
});

test("listConversions throws FORBIDDEN for a caller below the admin role", async () => {
  const t = convexTest(schema, modules);
  const { asUser: asAgent } = await seedAccountMember(t, {
    name: "Alex",
    email: "alex@example.com",
    role: "agent",
  });

  await expect(
    asAgent.query(api.attribution.listConversions, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "admin" } });
});
