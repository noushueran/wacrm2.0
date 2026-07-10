/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { AccountRole } from "./lib/roles";

// Convex function modules for convex-test to resolve `api.*`/`internal.*`
// references against. Absolute, from-project-root pattern (matches every
// other `convex/*.test.ts` suite — see `convex/lib/auth.test.ts`'s
// comment for why this must be absolute rather than a relative "./**").
const modules = import.meta.glob("/convex/**/*.ts");

/**
 * Seeds a `users` row + an `accounts`/`memberships` row for a fresh
 * account, and returns a convex-test client already authenticated as
 * that user. Duplicated per-suite rather than imported — see
 * `convex/messages.test.ts`'s own comment on this pattern.
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
 * Stores a blob and records `accountId` as its owner in `fileOwners` —
 * the same storageId→accountId mapping `files.registerUpload` writes in
 * production, but inserted directly so getUrl/remove enforcement can be
 * arranged without routing through the mutation. Returns the storage id.
 */
async function storeOwnedFile(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
  bytes: string,
) {
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([bytes], { type: "text/plain" })),
  );
  await t.run((ctx) => ctx.db.insert("fileOwners", { accountId, storageId }));
  return storageId;
}

/** Reads the `fileOwners` row for a storage id (or null), for assertions. */
async function ownerRecord(
  t: ReturnType<typeof convexTest>,
  storageId: Id<"_storage">,
) {
  // A plain scan (not `.withIndex`) keeps this helper's `t` param the
  // untyped `ReturnType<typeof convexTest>` the other seed helpers use —
  // test data is only a row or two, so the scan is free.
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("fileOwners").collect();
    return rows.find((row) => row.storageId === storageId) ?? null;
  });
}

// ============================================================
// generateUploadUrl — account-gated mutation
// ============================================================

test("generateUploadUrl returns a URL an agent can upload to", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const url = await asUser.mutation(api.files.generateUploadUrl, {});
  expect(typeof url).toBe("string");
  expect(url.length).toBeGreaterThan(0);
  // Round-trips through the URL constructor without throwing —
  // confirms it's a well-formed URL, not just a truthy string.
  expect(() => new URL(url)).not.toThrow();
});

test("generateUploadUrl rejects a viewer (below the agent role floor)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });

  await expect(
    asUser.mutation(api.files.generateUploadUrl, {}),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

// ============================================================
// getUrl — account-gated query
// ============================================================

test("getUrl resolves an owned storage id to a downloadable URL", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const storageId = await storeOwnedFile(t, accountId, "hello world");

  const url = await asUser.query(api.files.getUrl, { storageId });
  expect(url).not.toBeNull();
  expect(() => new URL(url as string)).not.toThrow();
});

test("getUrl returns null for an owned storage id whose file no longer resolves", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  // Owned, but the underlying object is gone — ownership passes, yet
  // `ctx.storage.getUrl` still resolves to null (the pre-existing
  // not-found contract), so the caller gets null, never a dangling URL.
  const storageId = await storeOwnedFile(t, accountId, "gone soon");
  await t.run((ctx) => ctx.storage.delete(storageId));

  const url = await asUser.query(api.files.getUrl, { storageId });
  expect(url).toBeNull();
});

test("getUrl returns null for a storage id owned by another account", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const bob = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  // Alice uploads (and owns) a file...
  const storageId = await storeOwnedFile(t, alice.accountId, "alice's secret");

  // ...Bob — a fully signed-in agent of a DIFFERENT account — cannot
  // resolve it to a URL, even holding the exact storage id.
  const bobUrl = await bob.asUser.query(api.files.getUrl, { storageId });
  expect(bobUrl).toBeNull();

  // Sanity: Alice herself still can.
  const aliceUrl = await alice.asUser.query(api.files.getUrl, { storageId });
  expect(aliceUrl).not.toBeNull();
});

test("getUrl returns null for a storage id with no ownership record", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  // A real, resolvable object that was never registered (e.g. inbound
  // media persisted by `storeFromUrl`) — an unowned id resolves to null,
  // never a URL.
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["unclaimed"], { type: "text/plain" })),
  );

  const url = await asUser.query(api.files.getUrl, { storageId });
  expect(url).toBeNull();
});

// ============================================================
// remove — account-gated mutation
// ============================================================

test("remove deletes an owned file and its ownership record", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const storageId = await storeOwnedFile(t, accountId, "bye");

  await asUser.mutation(api.files.remove, { storageId });

  const url = await t.run((ctx) => ctx.storage.getUrl(storageId));
  expect(url).toBeNull();
  // The `fileOwners` row is cleaned up too, so the mapping doesn't
  // outlive the object it pointed at.
  expect(await ownerRecord(t, storageId)).toBeNull();
});

test("remove rejects a viewer (below the agent role floor)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });

  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["safe"], { type: "text/plain" })),
  );

  await expect(
    asUser.mutation(api.files.remove, { storageId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });

  // Rejected mutation must not have deleted the file.
  const url = await t.run((ctx) => ctx.storage.getUrl(storageId));
  expect(url).not.toBeNull();
});

test("remove rejects a storage id owned by another account and preserves it", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const bob = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const storageId = await storeOwnedFile(t, alice.accountId, "alice's file");

  // Bob is a signed-in agent, but of a different account — he can't
  // delete Alice's object. Same non-leaky `NOT_FOUND` a missing id gets.
  await expect(
    bob.asUser.mutation(api.files.remove, { storageId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "file" } });

  // The object AND Alice's ownership record both survive.
  const url = await t.run((ctx) => ctx.storage.getUrl(storageId));
  expect(url).not.toBeNull();
  expect((await ownerRecord(t, storageId))?.accountId).toBe(alice.accountId);
});

test("remove rejects a storage id with no ownership record", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["unclaimed"], { type: "text/plain" })),
  );

  await expect(
    asUser.mutation(api.files.remove, { storageId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "file" } });

  // Unowned object is left untouched, not silently deleted.
  const url = await t.run((ctx) => ctx.storage.getUrl(storageId));
  expect(url).not.toBeNull();
});

// ============================================================
// registerUpload — records the storageId → accountId ownership mapping
// ============================================================

test("registerUpload records ownership so the owner can resolve the file", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  // The real post-upload path: bytes land, then the client reports the
  // storage id back. Before that call getUrl sees no owner and returns
  // null; after it, the owner resolves the URL.
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["mine"], { type: "text/plain" })),
  );
  expect(await asUser.query(api.files.getUrl, { storageId })).toBeNull();

  await asUser.mutation(api.files.registerUpload, { storageId });

  expect(await asUser.query(api.files.getUrl, { storageId })).not.toBeNull();
});

test("registerUpload rejects a viewer (below the agent role floor)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });

  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["nope"], { type: "text/plain" })),
  );

  await expect(
    asUser.mutation(api.files.registerUpload, { storageId }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

test("registerUpload is idempotent for the caller's own storage id", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["mine"], { type: "text/plain" })),
  );

  await asUser.mutation(api.files.registerUpload, { storageId });
  // A second call (e.g. an upload retry) neither throws nor duplicates
  // the mapping.
  await asUser.mutation(api.files.registerUpload, { storageId });

  const owners = await t.run((ctx) =>
    ctx.db
      .query("fileOwners")
      .withIndex("by_storage", (q) => q.eq("storageId", storageId))
      .collect(),
  );
  expect(owners).toHaveLength(1);
  expect(await asUser.query(api.files.getUrl, { storageId })).not.toBeNull();
});

test("registerUpload refuses to re-point a storage id owned by another account", async () => {
  const t = convexTest(schema, modules);
  const alice = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const bob = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const storageId = await storeOwnedFile(t, alice.accountId, "alice's file");

  // Bob can't claim an id Alice already owns...
  await expect(
    bob.asUser.mutation(api.files.registerUpload, { storageId }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "file" } });

  // ...ownership is unchanged: Alice still resolves it, Bob still can't.
  expect(
    await alice.asUser.query(api.files.getUrl, { storageId }),
  ).not.toBeNull();
  expect(await bob.asUser.query(api.files.getUrl, { storageId })).toBeNull();
});

// ============================================================
// storeFromUrl — internal action, fetch mocked (no real network call)
// ============================================================

test("storeFromUrl fetches a URL and stores the bytes, returning a storageId", async () => {
  const t = convexTest(schema, modules);
  const fakeBytes = new TextEncoder().encode("fake image bytes");

  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://cdn.example.com/photo.jpg");
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "Bearer test-token",
    );
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob([fakeBytes], { type: "image/jpeg" }),
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await t.action(internal.files.storeFromUrl, {
    url: "https://cdn.example.com/photo.jpg",
    headers: { Authorization: "Bearer test-token" },
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  // `t.run` serializes its return value as a Convex value, and a `Blob`
  // isn't one — so the bytes are read out and converted to a plain
  // array INSIDE the callback, not returned as a Blob across the
  // boundary.
  const storedBytes = await t.run(async (ctx) => {
    const blob = await ctx.storage.get(result.storageId);
    if (!blob) return null;
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  expect(storedBytes).toEqual(Array.from(fakeBytes));

  vi.unstubAllGlobals();
});

test("storeFromUrl throws (and stores nothing) when the fetch responds with a non-2xx status", async () => {
  const t = convexTest(schema, modules);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({ ok: false, status: 404, blob: async () => new Blob([]) }) as Response,
    ),
  );

  await expect(
    t.action(internal.files.storeFromUrl, {
      url: "https://cdn.example.com/missing.jpg",
    }),
  ).rejects.toThrow(/status 404/);

  vi.unstubAllGlobals();
});
