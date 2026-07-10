/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
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

test("getUrl resolves a storage id to a downloadable URL", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["hello world"], { type: "text/plain" })),
  );

  const url = await asUser.query(api.files.getUrl, { storageId });
  expect(url).not.toBeNull();
  expect(() => new URL(url as string)).not.toThrow();
});

test("getUrl returns null for a storage id that doesn't resolve to a file", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["gone soon"], { type: "text/plain" })),
  );
  await t.run((ctx) => ctx.storage.delete(storageId));

  const url = await asUser.query(api.files.getUrl, { storageId });
  expect(url).toBeNull();
});

// ============================================================
// remove — account-gated mutation
// ============================================================

test("remove deletes a stored file", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob(["bye"], { type: "text/plain" })),
  );

  await asUser.mutation(api.files.remove, { storageId });

  const url = await t.run((ctx) => ctx.storage.getUrl(storageId));
  expect(url).toBeNull();
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
