/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
 * `convex/messages.test.ts`'s own comment on this pattern. Kept
 * VERBATIM from the pre-R2 version of this file, per the task brief.
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

// Every handler in this file that reaches R2 (a successful startUpload,
// a successful remove, a successful storeFromUrl) calls
// `r2ConfigFromEnv()`, which throws when unset. Unlike `aiReply.test.ts`
// (which deliberately leaves R2 unconfigured for MOST of its tests, to
// exercise the "degrade gracefully" path — see that file's own
// R2_BUCKET set/delete convention), every test in THIS file is about
// files.ts's own R2-backed behavior, so a file-level set/delete is the
// right scope: it can't leak into other suites (deleted in `afterEach`,
// and vitest isolates test files from each other) and it isn't hiding a
// mixed "configured vs not" concern the way a global `vitest.config.ts`
// entry would (that would also defeat `aiReply.test.ts`'s own
// R2-unconfigured test — see this task's report for why that brief
// suggestion was not followed).
beforeEach(() => {
  process.env.R2_BUCKET = "test-bucket";
  process.env.R2_ENDPOINT = "https://test.r2.cloudflarestorage.com";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_PUBLIC_HOST = "https://objs.holidayys.co";
});

afterEach(() => {
  delete process.env.R2_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_PUBLIC_HOST;
  vi.unstubAllGlobals();
});

// ============================================================
// startUpload — account-gated mutation, replaces `generateUploadUrl`.
// Ported from the pre-R2 suite's `generateUploadUrl` tests (2), plus a
// NEW assertion neither predecessor could make: the pre-R2
// `generateUploadUrl` returned an opaque Convex upload URL with no
// visible tenant information at all, so there was nothing to assert
// about WHICH account a URL belonged to. An R2 presigned URL's KEY is
// minted server-side from `ctx.accountId`, so that guarantee is now
// directly observable and is the single most important thing this
// function must get right.
// ============================================================

test("startUpload mints a key prefixed with the caller's own account", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const { uploadUrl, key } = await asUser.mutation(api.files.startUpload, {
    kind: "outbound",
    contentType: "image/png",
    filename: "photo.png",
  });

  expect(key.startsWith(`${accountId}/outbound/`)).toBe(true);
  expect(key.endsWith(".png")).toBe(true);
  // A well-formed, query-signed R2 URL.
  expect(() => new URL(uploadUrl)).not.toThrow();
  expect(uploadUrl).toContain("X-Amz-Signature");
});

test("startUpload is denied to a viewer (below the agent role floor)", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });

  await expect(
    asUser.mutation(api.files.startUpload, {
      kind: "outbound",
      contentType: "image/png",
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
});

// ============================================================
// remove — account-gated mutation. Ported from the pre-R2 suite's
// `remove` tests (4), adapted to the key model:
//   - "deletes an owned file and its ownership record" -> "removes a
//     key it owns" (the `fileOwners` row no longer exists to assert on;
//     the R2-facing equivalent is that a signed DELETE actually reaches
//     R2 for the right key).
//   - "rejects a viewer (below the agent role floor)" -> ported as-is,
//     using the caller's OWN well-formed key, so it isolates "am I
//     rejected because I'm a viewer" from "am I rejected because the
//     key isn't mine" (the next test covers that).
//   - "rejects a storage id owned by another account and preserves it"
//     -> "refuses another account's key as NOT_FOUND" (no DB row to
//     assert "preserved"; the equivalent proof is that no DELETE ever
//     reaches R2 for a foreign key).
//   - "rejects a storage id with no ownership record" -> there is no
//     more "ownership record" to be missing; a key is either well-formed
//     and prefixed with the caller's account, or it isn't. The
//     analogous new hazard — and the brief's own callout — is a
//     MALFORMED key (`parseMediaKey` returns `null`), which must not
//     crash the mutation. New test below.
// Plus one NEW test (not in the pre-R2 suite, from the brief): role is
// checked BEFORE ownership, so a viewer is rejected identically
// regardless of whose key it is or whether it even parses.
// ============================================================

test("remove deletes an owned key", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (req: Request) => {
    calls.push(req);
    return new Response(null, { status: 200 });
  });

  await asUser.mutation(api.files.remove, {
    key: `${accountId}/outbound/abc.png`,
  });

  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe("DELETE");
  expect(calls[0].url).toContain(`${accountId}/outbound/abc.png`);
});

test("remove rejects a viewer (below the agent role floor) even for their own account's key", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });

  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    asUser.mutation(api.files.remove, {
      key: `${accountId}/outbound/mine.png`,
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
  // Rejected before ever reaching R2.
  expect(fetchMock).not.toHaveBeenCalled();
});

test("remove checks role before ownership — a viewer gets FORBIDDEN even for a foreign key", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vic",
    email: "vic@example.com",
    role: "viewer",
  });

  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    asUser.mutation(api.files.remove, { key: "someoneelse/outbound/a.png" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN", min: "agent" } });
  expect(fetchMock).not.toHaveBeenCalled();
});

test("remove refuses another account's key as NOT_FOUND, not FORBIDDEN", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });
  const other = await seedAccountMember(t, {
    name: "Bob",
    email: "bob@example.com",
    role: "agent",
  });

  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    asUser.mutation(api.files.remove, {
      key: `${other.accountId}/outbound/abc.png`,
    }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "file" } });
  // Alice is a real agent — the rejection must come from the ownership
  // check, not a role check — and crucially, no DELETE reached R2 for
  // Bob's object.
  expect(fetchMock).not.toHaveBeenCalled();
});

test("remove rejects a malformed key as NOT_FOUND, not a crash", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice",
    email: "alice@example.com",
    role: "agent",
  });

  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    asUser.mutation(api.files.remove, { key: "../../etc/passwd" }),
  ).rejects.toMatchObject({ data: { code: "NOT_FOUND", entity: "file" } });
  expect(fetchMock).not.toHaveBeenCalled();
});

// ============================================================
// registerUpload — RETIRED, not ported. The pre-R2 suite had 4 tests
// here ("records ownership...", "rejects a viewer...", "is idempotent
// for the caller's own storage id...", "refuses to re-point a storage
// id owned by another account..."). None apply to the new design:
// `registerUpload` existed only because a bare Convex `Id<"_storage">`
// carries no tenant, so the client had to report a completed upload
// back so `fileOwners` could record who owns it. An R2 key IS its own
// ownership record — minted server-side, inside `startUpload`, from
// `ctx.accountId` — so there is no second "claim this id" step for a
// client to perform, and thus nothing left to test here. The guarantee
// those 4 tests protected (a caller can only ever make an id/key
// resolve under their OWN account) is now covered by
// "startUpload mints a key prefixed with the caller's own account"
// above — proven by construction, not by a lookup table.
// ============================================================

// ============================================================
// getUrl — RETIRED, not ported. The pre-R2 suite had 4 tests here
// ("resolves an owned storage id...", "returns null for an owned...
// no longer resolves", "returns null for a storage id owned by
// another account", "returns null for a storage id with no ownership
// record"). None apply: there is no more `files.getUrl` query at all.
// A Convex `_storage` id needed a privileged, authenticated lookup to
// become a URL (hence `fileOwners`-gated `getUrl`). An R2 object key
// needs no such thing — `objs.holidayys.co` is a PUBLIC custom domain,
// and the URL is pure string concatenation
// (`src/lib/storage/media-url.ts`'s `mediaUrlFromKey`, already covered
// by that module's own test suite). Reading is no longer a privileged
// operation for this feature; only MINTING an upload URL (`startUpload`)
// and DELETING (`remove`) touch anything account-scoped, and those two
// are exactly what this file still tests.
// ============================================================

// ============================================================
// storeFromUrl — internal action, fetch mocked (no real network call).
// Ported from the pre-R2 suite's 2 tests, adapted from "downloads bytes
// into Convex storage, returns a storageId" to "downloads bytes and PUTs
// them to R2 under a key scoped to the given account/kind, returns that
// key". The "throws on non-2xx" test is behaviorally unchanged — that
// throw happens before ANY storage backend is touched, Convex or R2.
// ============================================================

test("storeFromUrl fetches a URL and PUTs the bytes to R2 under an accountId/kind-scoped key", async () => {
  const t = convexTest(schema, modules);
  const fakeBytes = new TextEncoder().encode("fake image bytes");

  const calls: Request[] = [];
  // `storeFromUrl`'s OWN download calls the global `fetch(url, init)` with
  // a plain string URL — but `putObject`'s R2 PUT goes through
  // `aws4fetch`'s `AwsClient.fetch`, which signs a `Request` and invokes
  // the global `fetch` with THAT SINGLE `Request` object as the only
  // argument (mirrors `convex/lib/r2/client.test.ts`'s own
  // `vi.stubGlobal("fetch", async (req: Request) => ...)` convention) —
  // so this mock must handle both calling conventions.
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (input instanceof Request) {
      calls.push(input);
      return new Response(null, { status: 200 });
    }
    const target = String(input);
    expect(target).toBe("https://cdn.example.com/photo.jpg");
    expect(
      (init?.headers as Record<string, string> | undefined)?.Authorization,
    ).toBe("Bearer test-token");
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/jpeg" }),
      blob: async () => new Blob([fakeBytes], { type: "image/jpeg" }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await t.action(internal.files.storeFromUrl, {
    url: "https://cdn.example.com/photo.jpg",
    headers: { Authorization: "Bearer test-token" },
    accountId: "acc123",
    kind: "inbound",
  });

  expect(result.key.startsWith("acc123/inbound/")).toBe(true);
  expect(result.key.endsWith(".jpg")).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe("PUT");
  expect(calls[0].url).toContain(result.key);
  expect(calls[0].headers.get("content-type")).toBe("image/jpeg");
  // Byte-content assertion (restores the pre-R2 suite's own equivalent
  // assertion on `ctx.storage.get(...)`): method/URL/content-type alone
  // don't prove `putObject` was ever handed the DOWNLOADED bytes rather
  // than the wrong blob or an empty one — which is exactly what would
  // silently ship broken inbound WhatsApp media (voice notes, photos) on
  // the live webhook path with nothing in the suite noticing. The
  // captured object is the signed `Request` `aws4fetch` handed to
  // `fetch`, so its body is read out the same way any `Request` body is.
  const putBody = new Uint8Array(await calls[0]!.arrayBuffer());
  expect(Array.from(putBody)).toEqual(Array.from(fakeBytes));

  vi.unstubAllGlobals();
});

test("storeFromUrl throws (and PUTs nothing to R2) when the fetch responds with a non-2xx status", async () => {
  const t = convexTest(schema, modules);
  const fetchMock = vi.fn(
    async () =>
      ({ ok: false, status: 404, blob: async () => new Blob([]) }) as Response,
  );
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    t.action(internal.files.storeFromUrl, {
      url: "https://cdn.example.com/missing.jpg",
      accountId: "acc123",
      kind: "inbound",
    }),
  ).rejects.toThrow(/status 404/);

  // The failed download must short-circuit before any PUT is attempted.
  expect(fetchMock).toHaveBeenCalledTimes(1);

  vi.unstubAllGlobals();
});
