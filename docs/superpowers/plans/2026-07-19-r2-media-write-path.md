# R2 Media Storage — Write Path Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every *newly* created media object is written to the Cloudflare R2 bucket `wa-holidayys` and served from `objs.holidayys.co`, with existing Convex-storage media still readable via a URL fallback.

**Architecture:** All R2 access is confined to `convex/lib/r2/`, which signs S3 requests with `aws4fetch` (`fetch` + `SubtleCrypto`, Convex's default runtime — no `"use node"`). Database rows gain `*Key` fields holding R2 object keys; a pure resolver returns `key ? publicUrl(key) : legacyUrl`. Read support ships **before** any write switches over, so a key never appears in a row that some reader can't resolve.

**Tech Stack:** Convex (self-hosted), Next.js 16, TypeScript, Vitest + convex-test, `aws4fetch`.

**Spec:** `docs/superpowers/specs/2026-07-19-cloudflare-r2-media-storage-design.md`

**Out of scope — see Plan 2:** backfilling existing media, purging Convex storage, reclaiming VPS disk, dropping the legacy URL columns.

## Global Constraints

- **No `"use node"`.** `convex/lib/whatsappEncryption.ts:11` documents it as a last resort, and `"use node"` files may only export actions. Use Web Crypto, as `convex/webhookDelivery.ts:177-184` already does.
- **Never `.filter()` on a Convex query.** `.filter()` does not narrow the scan and `.take(n)` stops at n *matches*, not n reads. Use `.withIndex(...)`. This rule took `/settings?tab=cron` down on 2026-07-18.
- **Every tenant-facing function uses `accountQuery`/`accountMutation`** from `convex/lib/auth.ts`, never raw `query`/`mutation`.
- **Cross-account access returns `NOT_FOUND`, never `FORBIDDEN`** — a caller must not be able to distinguish "someone else's" from "does not exist". Role checks run *before* ownership checks.
- **Object key format is `{accountId}/{kind}/{uuid}.{ext}`**, `kind` ∈ `inbound | outbound | template | flow | avatar | ad`.
- **`Content-Type` is part of the presigned signature.** The browser must PUT with byte-identical `Content-Type` to the one signed, or R2 rejects the upload.
- **Public host is `https://objs.holidayys.co`** (never `r2.dev`).
- Media size limits in `src/lib/storage/upload-media.ts:28-43` are unchanged.
- 🚨 **NEVER run `npx convex dev`, `npx convex deploy`, or `npx convex codegen`.** There is exactly ONE self-hosted Convex instance (`convex-api.holidayys.co`) and it is **production** — all three commands push straight to it. Every task in this plan is built and tested **offline**; `convex-test` runs without a deployment. Deploying is an owner action, performed only at Task 8 after all code review is complete.
- **New Convex *function module* ⇒ hand-edit `convex/_generated/api.d.ts`** (import line + member); `api.js` is a Proxy and needs no edit. This plan adds no new function module — `convex/lib/r2/*` are plain libraries, and `startUpload` is a new export on the *existing* `files` module, whose type flows through automatically. Do not edit `_generated/` in this plan.
- **Stage files explicitly by path. NEVER `git add -A` or `git add .`** — untracked `.claude/worktrees/*` directories from other sessions appear in `git status` and must not be committed.
- **Verification commands** (from app root `/Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0`): `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`.
- **Lint has pre-existing debt** (~7 errors / 87 warnings in vendored files). The gate is "build passes **and this diff adds no NEW lint**" — not a globally clean lint run.
- Convex backend deploys separately from Netlify, and **backend must deploy first** — but see the prohibition above: that deploy is the owner's, not this plan's.

---

### Task 1: R2 config + object key generation (pure)

No network, no Convex — just the two pure pieces everything else builds on.

**Files:**
- Create: `convex/lib/r2/config.ts`
- Create: `convex/lib/r2/keys.ts`
- Test: `convex/lib/r2/keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `r2ConfigFromEnv(): R2Config` where `R2Config = { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string; publicHost: string }`
  - `MEDIA_KINDS: readonly ["inbound","outbound","template","flow","avatar","ad"]`
  - `type MediaKind = (typeof MEDIA_KINDS)[number]`
  - `buildMediaKey(args: { accountId: string; kind: MediaKind; filename?: string; contentType?: string; randomHex?: () => string }): string`
  - `parseMediaKey(key: string): { accountId: string; kind: MediaKind } | null`

- [ ] **Step 1: Write the failing test**

Create `convex/lib/r2/keys.test.ts`:

```ts
import { expect, test } from "vitest";
import { buildMediaKey, parseMediaKey } from "./keys";

const FIXED = () => "0123456789abcdef0123456789abcdef";

test("buildMediaKey lays out accountId/kind/uuid.ext", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "inbound",
    filename: "voice-note.ogg",
    randomHex: FIXED,
  });
  expect(key).toBe(
    "acc123/inbound/0123456789abcdef0123456789abcdef.ogg",
  );
});

test("buildMediaKey falls back to the content type when there is no filename", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "ad",
    contentType: "image/jpeg",
    randomHex: FIXED,
  });
  expect(key).toBe("acc123/ad/0123456789abcdef0123456789abcdef.jpg");
});

test("buildMediaKey omits the extension when neither is known", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "outbound",
    randomHex: FIXED,
  });
  expect(key).toBe("acc123/outbound/0123456789abcdef0123456789abcdef");
});

test("buildMediaKey never lets a hostile filename escape its prefix", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "outbound",
    filename: "../../other-account/evil.png",
    randomHex: FIXED,
  });
  expect(key).toBe("acc123/outbound/0123456789abcdef0123456789abcdef.png");
  expect(key).not.toContain("..");
});

test("buildMediaKey falls back to the content type when a path-bearing filename has no dot", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "outbound",
    filename: "uploads/photo",
    contentType: "image/png",
    randomHex: FIXED,
  });
  // Must resolve from the content type ("png"), not the last path segment
  // ("photo") — a dot-less basename is not an extension.
  expect(key).toBe("acc123/outbound/0123456789abcdef0123456789abcdef.png");
});

test("buildMediaKey omits the extension for a path-bearing dot-less filename with no content type", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "outbound",
    filename: "uploads/photo",
    randomHex: FIXED,
  });
  expect(key).toBe("acc123/outbound/0123456789abcdef0123456789abcdef");
});

test("buildMediaKey treats a leading-dot filename as a dotfile, not an extension", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "outbound",
    filename: ".env",
    contentType: "image/png",
    randomHex: FIXED,
  });
  // Must resolve from the content type ("png"), not "env" from ".env".
  expect(key).toBe("acc123/outbound/0123456789abcdef0123456789abcdef.png");
});

test("buildMediaKey generates a distinct key per call", () => {
  const a = buildMediaKey({ accountId: "acc123", kind: "inbound" });
  const b = buildMediaKey({ accountId: "acc123", kind: "inbound" });
  expect(a).not.toBe(b);
});

test("parseMediaKey round-trips a built key", () => {
  const key = buildMediaKey({
    accountId: "acc123",
    kind: "template",
    filename: "header.png",
    randomHex: FIXED,
  });
  expect(parseMediaKey(key)).toEqual({ accountId: "acc123", kind: "template" });
});

test("parseMediaKey rejects malformed and unknown-kind keys", () => {
  expect(parseMediaKey("nope")).toBeNull();
  expect(parseMediaKey("acc123/bogus/file.png")).toBeNull();
  expect(parseMediaKey("")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Volumes/CurserDisk/Dev/wacrm2.0/wacrm2.0 && npx vitest run convex/lib/r2/keys.test.ts`
Expected: FAIL — `Failed to resolve import "./keys"`.

- [ ] **Step 3: Write `convex/lib/r2/config.ts`**

```ts
// ============================================================
// R2 connection settings, read from Convex deployment env vars. Kept
// separate from `client.ts` so the signing code takes an explicit
// config argument and stays trivially testable without env mutation.
//
// Secrets live only in the deployment's env (set by the owner via
// `npx convex env set`) — never in the repo. See the design spec at
// docs/superpowers/specs/2026-07-19-cloudflare-r2-media-storage-design.md
// ============================================================

export interface R2Config {
  bucket: string;
  /** S3 API endpoint, no trailing slash, no bucket segment. */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public custom domain objects are served from, no trailing slash. */
  publicHost: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set on this Convex deployment — R2 media storage is misconfigured.`,
    );
  }
  return value.replace(/\/+$/, "");
}

/**
 * Throws (rather than returning null) when unset: a missing R2 config is
 * an operator error, and callers are all best-effort-wrapped already, so
 * a loud throw surfaces in logs without taking a message path down.
 */
export function r2ConfigFromEnv(): R2Config {
  return {
    bucket: required("R2_BUCKET"),
    endpoint: required("R2_ENDPOINT"),
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    publicHost: required("R2_PUBLIC_HOST"),
  };
}
```

- [ ] **Step 4: Write `convex/lib/r2/keys.ts`**

```ts
// ============================================================
// R2 object keys. The key is the ONLY ownership signal we keep for an
// object: it is minted server-side with the caller's own `ctx.accountId`
// as its first segment, so "does this account own this key" is a string
// comparison rather than a lookup table. That is why the old
// `fileOwners` table is not carried over to R2 — see the design spec.
//
// A client never supplies a key, only a filename, and the filename is
// used for its EXTENSION ONLY (basename stripped) so nothing a caller
// controls can traverse out of its own prefix.
// ============================================================

export const MEDIA_KINDS = [
  "inbound",
  "outbound",
  "template",
  "flow",
  "avatar",
  "ad",
] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Minimal MIME → extension map, covering what WhatsApp actually carries. */
const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/amr": "amr",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

/** 32 hex chars from the platform CSPRNG — the same `crypto.getRandomValues`
 *  route `convex/lib/apiKey.ts` uses, which is known-good in Convex's
 *  default runtime (`crypto.randomUUID` is not relied on). */
function defaultRandomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Extension from a filename, else from a content type, else "". Never
 *  includes a dot, never longer than 5 chars, always lowercase. */
function extensionFor(filename?: string, contentType?: string): string {
  const basename = filename?.split("/").pop() ?? "";
  const dot = basename.lastIndexOf(".");
  // `> 0`, not `>= 0`: a leading-dot name like ".env" is a dotfile, not an
  // extension, and should fall through to the content-type map.
  const fromName = dot > 0 ? basename.slice(dot + 1) : "";
  const cleaned = fromName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned && cleaned.length <= 5) return cleaned;
  const base = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXT_BY_CONTENT_TYPE[base] ?? "";
}

export function buildMediaKey(args: {
  accountId: string;
  kind: MediaKind;
  filename?: string;
  contentType?: string;
  /** Injectable for deterministic tests. */
  randomHex?: () => string;
}): string {
  const id = (args.randomHex ?? defaultRandomHex)();
  const ext = extensionFor(args.filename, args.contentType);
  return `${args.accountId}/${args.kind}/${id}${ext ? `.${ext}` : ""}`;
}

/** Inverse of the prefix portion — `null` for anything not shaped like a
 *  key this module minted. Used to enforce per-account ownership. */
export function parseMediaKey(
  key: string,
): { accountId: string; kind: MediaKind } | null {
  const parts = key.split("/");
  if (parts.length !== 3) return null;
  const [accountId, kind, object] = parts;
  if (!accountId || !object) return null;
  if (!(MEDIA_KINDS as readonly string[]).includes(kind)) return null;
  return { accountId, kind: kind as MediaKind };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run convex/lib/r2/keys.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add convex/lib/r2/config.ts convex/lib/r2/keys.ts convex/lib/r2/keys.test.ts
git commit -m "feat(r2): object key generation and deployment config"
```

---

### Task 2: Public URL resolution (pure, both runtimes)

The `key ?? legacyUrl` fallback that makes every later step reversible.

**Files:**
- Create: `convex/lib/r2/url.ts`
- Create: `convex/lib/r2/url.test.ts`
- Create: `src/lib/storage/media-url.ts`
- Create: `src/lib/storage/media-url.test.ts`

**Interfaces:**
- Consumes: `R2Config` from Task 1.
- Produces:
  - server: `publicUrl(cfg: R2Config, key: string): string`, `resolveMediaUrl(cfg: R2Config, row: { key?: string | null; url?: string | null }): string | null`
  - client: `mediaUrlFromKey(key: string): string`, `resolveMediaUrl(row: { key?: string | null; url?: string | null }): string | null`

- [ ] **Step 1: Write the failing server test**

Create `convex/lib/r2/url.test.ts`:

```ts
import { expect, test } from "vitest";
import { publicUrl, resolveMediaUrl } from "./url";
import type { R2Config } from "./config";

const CFG: R2Config = {
  bucket: "wa-holidayys",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  accessKeyId: "ak",
  secretAccessKey: "sk",
  publicHost: "https://objs.holidayys.co",
};

test("publicUrl joins the public host and the key", () => {
  expect(publicUrl(CFG, "acc1/inbound/abc.ogg")).toBe(
    "https://objs.holidayys.co/acc1/inbound/abc.ogg",
  );
});

test("publicUrl percent-encodes each key segment but keeps the slashes", () => {
  expect(publicUrl(CFG, "acc1/inbound/a b+c.ogg")).toBe(
    "https://objs.holidayys.co/acc1/inbound/a%20b%2Bc.ogg",
  );
});

test("publicUrl normalizes a trailing slash on the public host", () => {
  const cfgWithTrailingSlash: R2Config = {
    ...CFG,
    publicHost: "https://objs.holidayys.co/",
  };
  expect(publicUrl(cfgWithTrailingSlash, "acc1/inbound/abc.ogg")).toBe(
    "https://objs.holidayys.co/acc1/inbound/abc.ogg",
  );
});

test("resolveMediaUrl prefers the key over a legacy url", () => {
  expect(
    resolveMediaUrl(CFG, {
      key: "acc1/inbound/abc.ogg",
      url: "https://convex-api.holidayys.co/api/storage/old",
    }),
  ).toBe("https://objs.holidayys.co/acc1/inbound/abc.ogg");
});

test("resolveMediaUrl falls back to the legacy url when there is no key", () => {
  expect(
    resolveMediaUrl(CFG, {
      url: "https://convex-api.holidayys.co/api/storage/old",
    }),
  ).toBe("https://convex-api.holidayys.co/api/storage/old");
});

test("resolveMediaUrl returns null when neither is present", () => {
  expect(resolveMediaUrl(CFG, {})).toBeNull();
  expect(resolveMediaUrl(CFG, { key: null, url: null })).toBeNull();
});

test("resolveMediaUrl treats an empty-string legacy url as absent", () => {
  expect(resolveMediaUrl(CFG, { url: "" })).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run convex/lib/r2/url.test.ts`
Expected: FAIL — `Failed to resolve import "./url"`.

- [ ] **Step 3: Write `convex/lib/r2/url.ts`**

```ts
import type { R2Config } from "./config";

// ============================================================
// Key → public URL. Objects are served from the R2 custom domain
// (`objs.holidayys.co`), NOT the S3 API endpoint and NOT `r2.dev`
// (Cloudflare rate-limits `r2.dev` and documents it as development-only;
// Meta and OpenAI both fetch these URLs server-side).
//
// `resolveMediaUrl` is the migration seam: rows written before the R2
// cutover carry only a legacy Convex-storage URL, rows written after
// carry a key, and rows touched by the Plan 2 backfill carry both. Key
// wins whenever present, so the backfill can run without a flag day.
// ============================================================

/** Percent-encode each path segment, preserving the `/` separators. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function publicUrl(cfg: R2Config, key: string): string {
  // Normalized here as well as in `r2ConfigFromEnv` — this module's parity
  // with `src/lib/storage/media-url.ts` must hold for ANY `R2Config`, not
  // only one built through that helper. R2 does not collapse `//`.
  const host = cfg.publicHost.replace(/\/+$/, "");
  return `${host}/${encodeKey(key)}`;
}

export function resolveMediaUrl(
  cfg: R2Config,
  row: { key?: string | null; url?: string | null },
): string | null {
  if (row.key) return publicUrl(cfg, row.key);
  // `||`, not `??`, is deliberate: an empty-string legacy url is treated as
  // absent, matching the truthy check on `row.key` above.
  return row.url || null;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run convex/lib/r2/url.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Write the failing client test**

Create `src/lib/storage/media-url.test.ts`:

```ts
import { expect, test, vi, beforeEach, afterEach } from "vitest";

const ORIGINAL = process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;

beforeEach(() => {
  process.env.NEXT_PUBLIC_R2_PUBLIC_HOST = "https://objs.holidayys.co";
  vi.resetModules();
});

afterEach(() => {
  process.env.NEXT_PUBLIC_R2_PUBLIC_HOST = ORIGINAL;
});

test("mediaUrlFromKey builds a public URL", async () => {
  const { mediaUrlFromKey } = await import("./media-url");
  expect(mediaUrlFromKey("acc1/outbound/abc.png")).toBe(
    "https://objs.holidayys.co/acc1/outbound/abc.png",
  );
});

test("mediaUrlFromKey normalizes a trailing slash on the public host", async () => {
  process.env.NEXT_PUBLIC_R2_PUBLIC_HOST = "https://objs.holidayys.co/";
  vi.resetModules();
  const { mediaUrlFromKey } = await import("./media-url");
  expect(mediaUrlFromKey("acc1/outbound/abc.png")).toBe(
    "https://objs.holidayys.co/acc1/outbound/abc.png",
  );
});

test("resolveMediaUrl prefers key, falls back to legacy url, else null", async () => {
  const { resolveMediaUrl } = await import("./media-url");
  expect(resolveMediaUrl({ key: "acc1/outbound/a.png", url: "legacy" })).toBe(
    "https://objs.holidayys.co/acc1/outbound/a.png",
  );
  expect(resolveMediaUrl({ url: "legacy" })).toBe("legacy");
  expect(resolveMediaUrl({})).toBeNull();
});

test("resolveMediaUrl treats an empty-string legacy url as absent", async () => {
  const { resolveMediaUrl } = await import("./media-url");
  expect(resolveMediaUrl({ url: "" })).toBeNull();
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/lib/storage/media-url.test.ts`
Expected: FAIL — cannot resolve `./media-url`.

- [ ] **Step 7: Write `src/lib/storage/media-url.ts`**

```ts
/**
 * Browser-side mirror of `convex/lib/r2/url.ts`. The two are deliberately
 * separate modules rather than one shared file: the Convex side reads the
 * deployment env (`R2_PUBLIC_HOST`) and the Next.js side reads the build-time
 * public env (`NEXT_PUBLIC_R2_PUBLIC_HOST`), and Convex function modules
 * cannot import from `src/`. Keep the two `resolveMediaUrl` behaviors
 * identical — `convex/lib/r2/url.test.ts` and this module's test assert the
 * same precedence rules.
 */

function publicHost(): string {
  const host = process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  if (!host) {
    throw new Error(
      "NEXT_PUBLIC_R2_PUBLIC_HOST is not set — media URLs cannot be built.",
    );
  }
  return host.replace(/\/+$/, "");
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function mediaUrlFromKey(key: string): string {
  return `${publicHost()}/${encodeKey(key)}`;
}

export function resolveMediaUrl(row: {
  key?: string | null;
  url?: string | null;
}): string | null {
  if (row.key) return mediaUrlFromKey(row.key);
  // `||`, not `??`, is deliberate: an empty-string legacy url is treated as
  // absent, matching the truthy check on `row.key` above.
  return row.url || null;
}
```

- [ ] **Step 8: Run both suites, typecheck, commit**

```bash
npx vitest run convex/lib/r2/url.test.ts src/lib/storage/media-url.test.ts
npm run typecheck
git add convex/lib/r2/url.ts convex/lib/r2/url.test.ts src/lib/storage/media-url.ts src/lib/storage/media-url.test.ts
git commit -m "feat(r2): public URL resolution with legacy-url fallback"
```

---

### Task 3: R2 client — signed PUT, DELETE, presigned PUT

The only module that talks to R2.

**Files:**
- Modify: `package.json` (add `aws4fetch`)
- Create: `convex/lib/r2/client.ts`
- Create: `convex/lib/r2/client.test.ts`

**Interfaces:**
- Consumes: `R2Config` from Task 1.
- Produces:
  - `putObject(cfg: R2Config, args: { key: string; body: Blob; contentType: string }): Promise<void>`
  - `deleteObject(cfg: R2Config, key: string): Promise<void>`
  - `presignPut(cfg: R2Config, args: { key: string; contentType: string; expiresSeconds?: number }): Promise<string>`

- [ ] **Step 1: Install the dependency**

```bash
npm install aws4fetch@^1.0.20
```

- [ ] **Step 2: Write the failing test**

Create `convex/lib/r2/client.test.ts`. `fetch` is stubbed — these assert the request we *construct*, not R2 itself (a live round-trip is Task 7).

```ts
import { expect, test, vi, afterEach } from "vitest";
import { putObject, deleteObject, presignPut } from "./client";
import type { R2Config } from "./config";

const CFG: R2Config = {
  bucket: "wa-holidayys",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secretexamplekey",
  publicHost: "https://objs.holidayys.co",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test("putObject PUTs to endpoint/bucket/key with a signed Authorization header", async () => {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (req: Request) => {
    calls.push(req);
    return new Response(null, { status: 200 });
  });

  await putObject(CFG, {
    key: "acc1/inbound/abc.ogg",
    body: new Blob(["hello"], { type: "audio/ogg" }),
    contentType: "audio/ogg",
  });

  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe("PUT");
  expect(calls[0].url).toBe(
    "https://acct.r2.cloudflarestorage.com/wa-holidayys/acc1/inbound/abc.ogg",
  );
  expect(calls[0].headers.get("content-type")).toBe("audio/ogg");
  expect(calls[0].headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
});

test("putObject throws with the status when R2 rejects the write", async () => {
  vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }));

  await expect(
    putObject(CFG, {
      key: "acc1/inbound/abc.ogg",
      body: new Blob(["x"], { type: "audio/ogg" }),
      contentType: "audio/ogg",
    }),
  ).rejects.toThrow(/403/);
});

test("deleteObject issues a signed DELETE and tolerates a 404", async () => {
  const calls: Request[] = [];
  vi.stubGlobal("fetch", async (req: Request) => {
    calls.push(req);
    return new Response(null, { status: 404 });
  });

  await deleteObject(CFG, "acc1/outbound/gone.png");

  expect(calls[0].method).toBe("DELETE");
  expect(calls[0].url).toBe(
    "https://acct.r2.cloudflarestorage.com/wa-holidayys/acc1/outbound/gone.png",
  );
});

test("presignPut returns a query-signed URL carrying expiry and signature", async () => {
  const url = await presignPut(CFG, {
    key: "acc1/outbound/photo.png",
    contentType: "image/png",
    expiresSeconds: 900,
  });

  const parsed = new URL(url);
  expect(parsed.origin + parsed.pathname).toBe(
    "https://acct.r2.cloudflarestorage.com/wa-holidayys/acc1/outbound/photo.png",
  );
  expect(parsed.searchParams.get("X-Amz-Expires")).toBe("900");
  expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
  expect(parsed.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
  // Content-Type is signed, so the browser must send exactly this value.
  expect(parsed.searchParams.get("X-Amz-SignedHeaders")).toContain(
    "content-type",
  );
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run convex/lib/r2/client.test.ts`
Expected: FAIL — cannot resolve `./client`.

- [ ] **Step 4: Write `convex/lib/r2/client.ts`**

```ts
import { AwsClient } from "aws4fetch";
import type { R2Config } from "./config";

// ============================================================
// The ONLY module in this codebase that talks to R2. Three operations —
// signed PUT, signed DELETE, and a presigned PUT URL for direct browser
// uploads — are all the app needs, because object keys are stored in our
// own rows rather than in a component-managed metadata table.
//
// `aws4fetch` signs with `fetch` + `SubtleCrypto`, so this runs in
// Convex's DEFAULT runtime: no `"use node"` (which
// `convex/lib/whatsappEncryption.ts:11` documents as a last resort, and
// which would restrict this file to exporting actions only). It is also
// the client Cloudflare itself documents for R2.
//
// `region: "auto"` and `service: "s3"` are required by the signing
// algorithm but ignored by R2.
// ============================================================

function awsClient(cfg: R2Config): AwsClient {
  return new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
}

/** `endpoint/bucket/key`, each key segment percent-encoded. */
function objectUrl(cfg: R2Config, key: string): string {
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${cfg.endpoint}/${cfg.bucket}/${encoded}`;
}

/**
 * Upload bytes we already hold server-side (inbound WhatsApp media, ad
 * referral images, and the Plan 2 backfill). Throws on a non-2xx so the
 * caller's best-effort wrapper can log and degrade.
 */
export async function putObject(
  cfg: R2Config,
  args: { key: string; body: Blob; contentType: string },
): Promise<void> {
  const res = await awsClient(cfg).fetch(objectUrl(cfg, args.key), {
    method: "PUT",
    body: args.body,
    headers: { "Content-Type": args.contentType },
  });
  if (!res.ok) {
    throw new Error(
      `R2 putObject failed for ${args.key}: ${res.status} ${res.statusText}`,
    );
  }
}

/**
 * Delete an object. A 404 is success — callers are GC paths
 * (`files.remove` on an abandoned draft) that fire-and-forget, and an
 * already-absent object is the desired end state.
 */
export async function deleteObject(cfg: R2Config, key: string): Promise<void> {
  const res = await awsClient(cfg).fetch(objectUrl(cfg, key), {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(
      `R2 deleteObject failed for ${key}: ${res.status} ${res.statusText}`,
    );
  }
}

/**
 * A short-lived URL the BROWSER may PUT to directly, so upload bytes
 * never transit the VPS.
 *
 * `Content-Type` is signed (it is set on the Request handed to `sign`),
 * which means the browser MUST send a byte-identical `Content-Type` or
 * R2 rejects the upload. That is deliberate: it is also what gets the
 * correct type stored on the object, which is what lets `<img>`/
 * `<audio>`/`<video>` and Meta's media fetcher handle it properly.
 */
export async function presignPut(
  cfg: R2Config,
  args: { key: string; contentType: string; expiresSeconds?: number },
): Promise<string> {
  const expires = args.expiresSeconds ?? 900;
  const url = new URL(objectUrl(cfg, args.key));
  url.searchParams.set("X-Amz-Expires", String(expires));

  const signed = await awsClient(cfg).sign(
    new Request(url, {
      method: "PUT",
      headers: { "Content-Type": args.contentType },
    }),
    // `allHeaders: true` is REQUIRED, not optional. aws4fetch keeps
    // `content-type` in its UNSIGNABLE_HEADERS set and filters on
    // `allHeaders || !UNSIGNABLE_HEADERS.has(header)`, so without this the
    // header is set on the request but NEVER SIGNED — silently defeating
    // the contract above. (Cloudflare's own documented example omits it.)
    { aws: { signQuery: true, allHeaders: true } },
  );
  return signed.url;
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run convex/lib/r2/client.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add package.json package-lock.json convex/lib/r2/client.ts convex/lib/r2/client.test.ts
git commit -m "feat(r2): signed PUT/DELETE and presigned upload URLs via aws4fetch"
```

---

### Task 4: Dormant schema fields

Additive only. Nothing writes these yet; shipping them first means the write cutover is a code deploy, not a schema deploy.

**Files:**
- Modify: `convex/schema.ts` (`messages` ~L281-345, `templates` ~L573, `users`)
- Test: `convex/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: optional `mediaKey` / `referral.storedImageKey` on `messages`, `headerMediaKey` on `templates`, `avatarKey` on `users`.

- [ ] **Step 1: Write the failing test**

Append to `convex/schema.test.ts`:

```ts
test("messages accepts a mediaKey alongside the legacy mediaUrl", async () => {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const accountId = await ctx.db.insert("accounts", {
      name: "A", defaultCurrency: "USD",
    });
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+971500000000" });
    const conversationId = await ctx.db.insert("conversations", {
      accountId, contactId, status: "open", lastMessageAt: Date.now(),
    });
    const messageId = await ctx.db.insert("messages", {
      accountId,
      conversationId,
      senderType: "customer",
      contentType: "audio",
      status: "delivered",
      mediaKey: "acc1/inbound/abc.ogg",
      referral: { storedImageKey: "acc1/ad/def.jpg" },
    });
    return { messageId };
  });

  const row = await t.run((ctx) => ctx.db.get(ids.messageId));
  expect(row?.mediaKey).toBe("acc1/inbound/abc.ogg");
  expect(row?.referral?.storedImageKey).toBe("acc1/ad/def.jpg");
});
```

> If the `accounts`/`contacts`/`conversations` insert shapes above do not
> match the current schema, copy the exact seed helper already used at the
> top of `convex/messages.test.ts` rather than inventing field values.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run convex/schema.test.ts`
Expected: FAIL — `Object contains extra field 'mediaKey' that is not in the validator`.

- [ ] **Step 3: Add the fields**

In `convex/schema.ts`, in the `messages` table immediately after `mediaUrl: v.optional(v.string()),`:

```ts
    // R2 object key for this message's media — the durable replacement
    // for `mediaUrl`, which stored a resolved absolute URL and therefore
    // had to be rewritten row-by-row to move storage providers. Readers
    // resolve `mediaKey ?? mediaUrl` (see `convex/lib/r2/url.ts`), so
    // pre-cutover rows keep working untouched. `mediaUrl` is retained
    // until the Plan 2 backfill is verified, then dropped separately.
    mediaKey: v.optional(v.string()),
```

Inside the `referral` object validator, immediately after `storedImageUrl: v.optional(v.string()),`:

```ts
        storedImageKey: v.optional(v.string()),
```

In the `templates` table, immediately after `headerMediaUrl: v.optional(v.string()),`:

```ts
    headerMediaKey: v.optional(v.string()),
```

In the `users` table, immediately after its `avatarUrl` field:

```ts
    avatarKey: v.optional(v.string()),
```

- [ ] **Step 4: Run the full suite to verify nothing regressed**

Run: `npm test`
Expected: PASS — all suites, including the new schema test.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add convex/schema.ts convex/schema.test.ts
git commit -m "feat(r2): add dormant media key fields to schema"
```

---

### Task 5: Dual-read — every consumer resolves `key ?? url`

Ships before any write cutover. After this task, behavior is byte-identical (no row has a key yet), but the moment one does, every reader handles it.

**Files:**
- Modify: `convex/send.ts:143-151`
- Modify: `convex/apiV1.ts:511, 577`
- Modify: `convex/flowsEngine.ts:681-690`
- Modify: `convex/aiReply.ts:284-330, 678-683`
- Modify: `src/lib/whatsapp/template-send-builder.ts:106`
- Modify: `src/lib/convex/adapters.ts:346, 331, 377, 564`
- Test: `convex/send.test.ts`, `convex/flowsEngine.test.ts`

**Interfaces:**
- Consumes: `resolveMediaUrl` (server) from Task 2, `resolveMediaUrl` (client) from Task 2.
- Produces: no new exports — behavior change only.

- [ ] **Step 1: Write the failing test**

Append to `convex/send.test.ts`:

```ts
test("send resolves a message's mediaKey to a public R2 URL for Meta", async () => {
  // Arrange an outbound media send whose staged object is identified by
  // key, not by legacy URL, and assert the `link` handed to Meta is the
  // objs.holidayys.co URL rather than a Convex storage URL.
  //
  // Follow the existing arrangement in this file's other `send` tests for
  // account/conversation/whatsappConfig seeding and for how the
  // `metaSend.sendMedia` action is intercepted; assert only:
  //   expect(capturedLink).toBe(
  //     "https://objs.holidayys.co/acc1/outbound/photo.png",
  //   );
});
```

> Replace the comment with the concrete arrangement copied from the
> neighbouring `send` media test in the same file. Do not invent a new
> seeding pattern.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run convex/send.test.ts`
Expected: FAIL — the link is still the raw `mediaUrl` (or undefined).

- [ ] **Step 3: Thread the resolver through the send paths**

In `convex/send.ts`, replace the media branch's guard and call:

```ts
      case "image":
      case "video":
      case "document":
      case "audio": {
        const link = resolveMediaUrl(r2ConfigFromEnv(), {
          key: args.mediaKey,
          url: args.mediaUrl,
        });
        if (!link) {
          throw new Error(
            `mediaKey or mediaUrl is required for ${args.messageType} messages`,
          );
        }
        return await ctx.runAction(internal.metaSend.sendMedia, {
          accountId,
          conversationId,
          to,
          kind: args.messageType,
          link,
          // …remaining args unchanged
```

Add `mediaKey: v.optional(v.string()),` to `send`'s args validator beside `mediaUrl`, and import:

```ts
import { r2ConfigFromEnv } from "./lib/r2/config";
import { resolveMediaUrl } from "./lib/r2/url";
```

Apply the same substitution at:
- `convex/apiV1.ts` — the `isMediaKind && !args.mediaUrl` guard (L511) and the `link: args.mediaUrl!` argument (L577).
- `convex/flowsEngine.ts:690` — `link: cfg.media_url` becomes `link: resolveMediaUrl(r2ConfigFromEnv(), { key: cfg.media_key, url: cfg.media_url })`, with a null guard that routes to the existing `send_media_failed` error path rather than throwing.
- `convex/aiReply.ts` — the media-row collection at L284-330 must select rows with `m.mediaKey || m.mediaUrl`, and pass `resolveMediaUrl(...)` into `transcribeAudioFromUrl` / `describeImageFromUrl` at L678-683.
- `src/lib/whatsapp/template-send-builder.ts:106` — `const link = params.headerMediaUrl ?? template.header_media_url;` becomes a `resolveMediaUrl` call over the key/url pair, using the **client** resolver from `src/lib/storage/media-url.ts`.

- [ ] **Step 4: Thread the resolver through the read adapters**

In `src/lib/convex/adapters.ts`, import the client resolver and replace the four pass-throughs:

```ts
import { resolveMediaUrl } from "@/lib/storage/media-url";

// L346
    media_url: resolveMediaUrl({ key: doc.mediaKey, url: doc.mediaUrl }),
// L331 and L377 (ad referral)
          stored_image_url: resolveMediaUrl({
            key: doc.referral?.storedImageKey,
            url: doc.referral?.storedImageUrl,
          }),
// L564
    header_media_url: resolveMediaUrl({
      key: doc.headerMediaKey,
      url: doc.headerMediaUrl,
    }),
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — including the new `send` test.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint   # gate: no NEW lint from this diff
git add convex/send.ts convex/apiV1.ts convex/flowsEngine.ts convex/aiReply.ts src/lib/whatsapp/template-send-builder.ts src/lib/convex/adapters.ts convex/send.test.ts
git commit -m "feat(r2): resolve media keys at every read site, falling back to legacy URLs"
```

- [ ] **Step 7: Do NOT deploy — record readiness only**

Deployment is deferred to Task 8 and is the **owner's** action. Do not run
`npx convex deploy`. This change is behaviorally inert until Task 6/7 land
(reads understand keys; nothing writes them yet), so there is nothing to
verify live at this point.

---

### Task 6: Client upload cutover

Browser PUTs straight to R2. `fileOwners` and `registerUpload` are retired: the account id is the key's first segment, so ownership is guaranteed by construction rather than by a lookup row.

**Files:**
- Modify: `convex/files.ts` (full rewrite of the public surface)
- Modify: `convex/files.test.ts`
- Modify: `src/lib/storage/upload-media.ts`
- Modify: `src/components/inbox/message-composer.tsx:404, 446, 188`
- Modify: `src/components/inbox/message-thread.tsx:421`
- Modify: `src/components/flows/forms/node-config-form.tsx:912-916`
- Modify: `src/components/settings/template-manager.tsx:480`
- Modify: `src/components/settings/profile-form.tsx:131-148`

**Interfaces:**
- Consumes: `presignPut`, `deleteObject` (Task 3); `buildMediaKey`, `parseMediaKey` (Task 1).
- Produces:
  - `api.files.startUpload({ kind, contentType, filename? }) → { uploadUrl: string; key: string }`
  - `api.files.remove({ key })`
  - `internal.files.storeFromUrl({ url, headers?, accountId, kind, filename? }) → { key: string }`
  - `uploadAccountMedia(convex, startUpload, file, kind) → { key: string }`
  - `deleteAccountMedia(convex, key) → Promise<void>`

- [ ] **Step 1: Write the failing tests**

Rewrite the enforcement tests in `convex/files.test.ts`, keeping the existing `seedAccountMember` helper verbatim:

```ts
test("startUpload mints a key prefixed with the caller's own account", async () => {
  const t = convexTest(schema, modules);
  const { accountId, asUser } = await seedAccountMember(t, {
    name: "Alice", email: "alice@example.com", role: "agent",
  });

  const { uploadUrl, key } = await asUser.mutation(api.files.startUpload, {
    kind: "outbound",
    contentType: "image/png",
    filename: "photo.png",
  });

  expect(key.startsWith(`${accountId}/outbound/`)).toBe(true);
  expect(key.endsWith(".png")).toBe(true);
  expect(uploadUrl).toContain("X-Amz-Signature");
});

test("startUpload is denied to a viewer", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vic", email: "vic@example.com", role: "viewer",
  });

  await expect(
    asUser.mutation(api.files.startUpload, {
      kind: "outbound", contentType: "image/png",
    }),
  ).rejects.toThrow(/FORBIDDEN/);
});

test("remove refuses another account's key as NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice", email: "alice@example.com", role: "agent",
  });
  const other = await seedAccountMember(t, {
    name: "Bob", email: "bob@example.com", role: "agent",
  });

  await expect(
    asUser.mutation(api.files.remove, {
      key: `${other.accountId}/outbound/abc.png`,
    }),
  ).rejects.toThrow(/NOT_FOUND/);
});

test("remove rejects a malformed key as NOT_FOUND, not a crash", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Alice", email: "alice@example.com", role: "agent",
  });

  await expect(
    asUser.mutation(api.files.remove, { key: "../../etc/passwd" }),
  ).rejects.toThrow(/NOT_FOUND/);
});

test("remove checks role before ownership — a viewer gets FORBIDDEN even for a foreign key", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, {
    name: "Vic", email: "vic@example.com", role: "viewer",
  });

  await expect(
    asUser.mutation(api.files.remove, { key: "someoneelse/outbound/a.png" }),
  ).rejects.toThrow(/FORBIDDEN/);
});
```

Set the five R2 env vars for the test run in `vitest.config.ts` (or a setup file) so `r2ConfigFromEnv()` resolves:

```ts
  test: {
    env: {
      R2_BUCKET: "test-bucket",
      R2_ENDPOINT: "https://test.r2.cloudflarestorage.com",
      R2_ACCESS_KEY_ID: "test-key",
      R2_SECRET_ACCESS_KEY: "test-secret",
      R2_PUBLIC_HOST: "https://objs.holidayys.co",
      NEXT_PUBLIC_R2_PUBLIC_HOST: "https://objs.holidayys.co",
    },
  },
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run convex/files.test.ts`
Expected: FAIL — `api.files.startUpload` does not exist.

- [ ] **Step 3: Rewrite `convex/files.ts`**

```ts
import { accountMutation } from "./lib/auth";
import { internalAction } from "./_generated/server";
import { v, ConvexError } from "convex/values";
import { r2ConfigFromEnv } from "./lib/r2/config";
import { presignPut, deleteObject, putObject } from "./lib/r2/client";
import { buildMediaKey, parseMediaKey, MEDIA_KINDS } from "./lib/r2/keys";

// ============================================================
// Media object lifecycle, backed by Cloudflare R2.
//
// This replaces the Convex-file-storage version, which needed a
// `fileOwners` table because a bare `Id<"_storage">` carried no tenant:
// any holder of the id could resolve it. An R2 key carries its owner in
// its first segment and is minted SERVER-SIDE from `ctx.accountId` (a
// client supplies only a kind/content-type/filename, never a key), so
// ownership is guaranteed by construction and checkable by string
// comparison. `fileOwners` and `registerUpload` are therefore retired —
// which also removes a round trip from every upload.
//
// The tenant-isolation contract is unchanged and deliberately preserved:
// a foreign or malformed key is `NOT_FOUND` (never `FORBIDDEN`, never a
// distinguishable error), and the role check runs BEFORE the ownership
// check so a viewer is rejected identically whoever owns the key.
// ============================================================

const kindValidator = v.union(
  ...MEDIA_KINDS.map((k) => v.literal(k)),
);

/**
 * Mint a key inside the caller's own account prefix and return a
 * short-lived presigned PUT URL for it. The browser PUTs the bytes
 * straight to R2 — they never transit the VPS.
 *
 * The caller MUST send exactly `contentType` on that PUT: it is part of
 * the signature (see `presignPut`), and it is what R2 stores and later
 * serves, which is what makes `<img>`/`<audio>`/`<video>` and Meta's
 * media fetcher work.
 *
 * Role-gated at "agent" — the same floor `messages.append` uses, since
 * attaching media to a message is the same class of action.
 */
export const startUpload = accountMutation({
  args: {
    kind: kindValidator,
    contentType: v.string(),
    filename: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const cfg = r2ConfigFromEnv();
    const key = buildMediaKey({
      accountId: ctx.accountId,
      kind: args.kind,
      filename: args.filename,
      contentType: args.contentType,
    });
    const uploadUrl = await presignPut(cfg, {
      key,
      contentType: args.contentType,
    });
    return { uploadUrl, key };
  },
});

/**
 * Delete an object — GC for media staged but never sent (a cancelled
 * draft, a failed Meta send). Only the owning account may delete: a
 * foreign or malformed key throws `NOT_FOUND` and deletes nothing.
 * Callers fire-and-forget and swallow errors; a missed delete is a
 * storage nit, not something to surface.
 */
export const remove = accountMutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const parsed = parseMediaKey(args.key);
    if (!parsed || parsed.accountId !== ctx.accountId) {
      throw new ConvexError({ code: "NOT_FOUND", entity: "file" });
    }
    await deleteObject(r2ConfigFromEnv(), args.key);
  },
});

/**
 * Download a URL's bytes and store them in R2 — the engine-side
 * primitive for inbound media (a customer's photo/voice note, resolved
 * from a Meta media id) and for re-hosting an already-public URL (a CTWA
 * ad referral image; omit `headers`).
 *
 * `accountId` is passed in rather than read from a session because this
 * runs with no user context: ingest resolves it upstream from the
 * webhook's phone_number_id.
 */
export const storeFromUrl = internalAction({
  args: {
    url: v.string(),
    headers: v.optional(v.record(v.string(), v.string())),
    accountId: v.string(),
    kind: kindValidator,
    filename: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const response = await fetch(args.url, { headers: args.headers });
    if (!response.ok) {
      throw new Error(
        `storeFromUrl: fetch failed with status ${response.status}`,
      );
    }
    const blob = await response.blob();
    const contentType =
      response.headers.get("content-type") ??
      blob.type ??
      "application/octet-stream";
    const cfg = r2ConfigFromEnv();
    const key = buildMediaKey({
      accountId: args.accountId,
      kind: args.kind,
      filename: args.filename,
      contentType,
    });
    await putObject(cfg, { key, body: blob, contentType });
    return { key };
  },
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run convex/files.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Rewrite `src/lib/storage/upload-media.ts`**

Keep `MEDIA_MAX_BYTES` and `MEDIA_MAX_BYTES_BY_KIND` exactly as they are. Replace the two functions:

```ts
export interface UploadAccountMediaResult {
  /** R2 object key — store this in the row (`messages.mediaKey`,
   *  `templates.headerMediaKey`, a flow node's `media_key`). Resolve it
   *  for display with `resolveMediaUrl` from `./media-url`. */
  key: string;
}

type StartUploadMutation = ReactMutation<typeof api.files.startUpload>;

/**
 * Upload a file straight to R2. The server mints a key inside the
 * caller's account prefix and presigns a PUT for it; the browser then
 * PUTs the bytes directly, so they never transit the VPS.
 *
 * The `Content-Type` sent here MUST match the one the server signed —
 * both are `file.type`. Changing one without the other makes R2 reject
 * the upload with a signature mismatch.
 */
export async function uploadAccountMedia(
  convex: ConvexReactClient,
  startUpload: StartUploadMutation,
  file: File,
  kind: MediaKind,
): Promise<UploadAccountMediaResult> {
  const contentType = file.type || "application/octet-stream";
  const { uploadUrl, key } = await startUpload({
    kind,
    contentType,
    filename: file.name,
  });

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!response.ok) {
    throw new Error("Upload failed.");
  }

  return { key };
}

export async function deleteAccountMedia(
  convex: ConvexReactClient,
  key: string,
): Promise<void> {
  await convex.mutation(api.files.remove, { key });
}
```

Note the method is now `PUT`, not `POST`.

- [ ] **Step 6: Update the five client call sites**

Each `useMutation(api.files.generateUploadUrl)` becomes `useMutation(api.files.startUpload)`, and each result destructures `{ key }` instead of `{ url, storageId }`:

- `src/components/inbox/message-composer.tsx:404` — pass `kind` (the existing `kind` variable), store `mediaKey: key` on the draft, and change the draft type's `mediaUrl`/`storageId` fields (L77, L107) to `mediaKey`. Preview `src` attributes at L924/930/933 become `mediaUrlFromKey(draft.mediaKey)`.
- `src/components/inbox/message-composer.tsx:446` — same, with `kind: "outbound"`.
- `src/components/inbox/message-composer.tsx:188` and `message-thread.tsx:421` — `deleteAccountMedia(convex, key)`.
- `src/components/flows/forms/node-config-form.tsx:912-916` — `kind: "flow"`, write `media_key: key` into the node config alongside the existing `media_url` (leave `media_url` untouched for pre-cutover nodes); the display at L966-976 uses `resolveMediaUrl({ key: cfg.media_key, url: cfg.media_url })`.
- `src/components/settings/template-manager.tsx:480` — `kind: "template"`, store into `headerMediaKey`.
- `src/components/settings/profile-form.tsx:131-148` — `kind: "avatar"`; drop the `registerUpload` + `getUrl` round trip entirely and store `avatarKey`.

- [ ] **Step 7: Run the full suite, typecheck, lint**

```bash
npx vitest run && npm run typecheck && npm run lint   # gate: no NEW lint from this diff
```
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add convex/files.ts convex/files.test.ts vitest.config.ts src/lib/storage/upload-media.ts src/components/inbox/message-composer.tsx src/components/inbox/message-thread.tsx src/components/flows/forms/node-config-form.tsx src/components/settings/template-manager.tsx src/components/settings/profile-form.tsx
git commit -m "feat(r2): upload client media directly to R2, retire fileOwners"
```

---

### Task 7: Inbound ingest cutover

**Files:**
- Modify: `convex/whatsappConfig.ts:1083-1110`
- Modify: `convex/ingest.ts:599-633`
- Modify: `convex/messages.ts:444-448` (`setMediaUrl` → `setMediaKey`)
- Test: `convex/ingest.test.ts`, `convex/whatsappConfig.test.ts`

**Interfaces:**
- Consumes: `internal.files.storeFromUrl` (Task 6).
- Produces: `resolveInboundMedia → { key: string } | null`; `internal.messages.setMediaKey({ messageId, mediaKey })`; `internal.messages.setAdReferralImage({ …, storedImageKey })`.

- [ ] **Step 1: Write the failing test**

In `convex/ingest.test.ts`, adapt the existing inbound-media test to assert the key path:

```ts
test("inbound media is stored in R2 and the message gets a mediaKey", async () => {
  // Reuse this file's existing inbound-media arrangement (webhook payload
  // with a `mediaId`, a seeded whatsappConfig, `resolveInboundMedia`
  // intercepted). Assert:
  //   expect(row?.mediaKey).toMatch(/^[^/]+\/inbound\//);
  //   expect(row?.mediaUrl).toBeUndefined();
});
```

> Copy the concrete arrangement from the neighbouring inbound-media test
> already in this file rather than writing a new one.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run convex/ingest.test.ts`
Expected: FAIL — `mediaKey` is undefined.

- [ ] **Step 3: Update `resolveInboundMedia`**

In `convex/whatsappConfig.ts`, change the return type to `{ key: string } | null` and the body's tail:

```ts
export const resolveInboundMedia = internalAction({
  args: { accountId: v.id("accounts"), mediaId: v.string() },
  handler: async (ctx, args): Promise<{ key: string } | null> => {
    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId: args.accountId,
    });
    if (!config) return null;

    try {
      const accessToken = await decrypt(config.accessToken);
      const mediaInfo = await getMediaUrl({
        mediaId: args.mediaId,
        accessToken,
      });
      const { key } = await ctx.runAction(internal.files.storeFromUrl, {
        url: mediaInfo.url,
        headers: { Authorization: `Bearer ${accessToken}` },
        accountId: args.accountId,
        kind: "inbound",
      });
      return { key };
    } catch (err) {
      console.error(
        "[resolveInboundMedia] failed to resolve media",
        args.mediaId,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  },
});
```

Update the header comment's "durable storage URL comes back out" sentence to say key.

- [ ] **Step 4: Update `convex/messages.ts`**

Rename the internal mutation and its field:

```ts
export const setMediaKey = internalMutation({
  args: { messageId: v.id("messages"), mediaKey: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.messageId, { mediaKey: args.mediaKey });
  },
});
```

Change `setAdReferralImage`'s `storedImageUrl` arg to `storedImageKey` and patch `referral.storedImageKey`.

- [ ] **Step 5: Update `convex/ingest.ts`**

The inbound-media block at L599:

```ts
    if (message.mediaId && !message.mediaUrl) {
      const resolved = await ctx.runAction(
        internal.whatsappConfig.resolveInboundMedia,
        { accountId, mediaId: message.mediaId },
      );
      if (resolved) {
        await ctx.runMutation(internal.messages.setMediaKey, {
          messageId: res.messageId,
          mediaKey: resolved.key,
        });
      }
    }
```

The ad-referral block at L616 — note the `ctx.storage.getUrl` call disappears entirely, since `storeFromUrl` now returns the key:

```ts
    const adImageSrc = message.referral?.imageUrl ?? message.referral?.thumbnailUrl;
    if (adImageSrc) {
      await runBestEffort("ingest.storeAdReferralImage", async () => {
        const { key } = await ctx.runAction(internal.files.storeFromUrl, {
          url: adImageSrc,
          accountId,
          kind: "ad",
        });
        await ctx.runMutation(internal.messages.setAdReferralImage, {
          messageId: res.messageId,
          conversationId: res.conversationId,
          storedImageKey: key,
        });
      });
    }
```

- [ ] **Step 6: Run the full suite, typecheck, lint**

```bash
npx vitest run && npm run typecheck && npm run lint   # gate: no NEW lint from this diff
```
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add convex/whatsappConfig.ts convex/ingest.ts convex/messages.ts convex/ingest.test.ts convex/whatsappConfig.test.ts
git commit -m "feat(r2): store inbound WhatsApp and ad-referral media in R2"
```

---

### Task 8: Live end-to-end verification

Not optional, and **must precede Plan 2**. Several failure modes here are silent — Meta reports an outbound media send as accepted whether or not it could fetch the link.

**Files:** none — this is a deploy-and-observe task.

- [ ] **Step 1: Confirm owner prerequisites are done**

- `objs.holidayys.co` bound to the `wa-holidayys` bucket as a **custom domain** (not `r2.dev`).
- `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_HOST` set on the Convex deployment.
- `NEXT_PUBLIC_R2_PUBLIC_HOST` set on Netlify.

- [ ] **Step 2: Owner deploys backend, then frontend**

🚨 **This step is run by the owner, not by an implementer subagent.** It is the
only production push in this plan, and it must follow a clean whole-branch
review.

```bash
git fetch origin && git merge origin/main
npm test && npm run typecheck && npm run build   # all green before pushing
npx convex deploy                                 # PRODUCTION — owner only
```
Then let Netlify build.

- [ ] **Step 3: Verify Meta can actually fetch from the custom domain**

This is the highest-risk check — a WAF rule, bot-fight mode, or hotlink protection in front of `objs.holidayys.co` breaks outbound media *silently*.

Send a real outbound image from the inbox to a test WhatsApp number. Confirm the image **arrives on the handset**, not merely that the CRM shows it as sent. If it does not arrive, check Cloudflare's Security Events for `objs.holidayys.co` before changing any code.

- [ ] **Step 4: Verify each remaining path end-to-end**

- Inbound: send a photo, a voice note and a PDF *from* a test handset; each renders in the inbox, and its `messages.mediaKey` is set with `mediaUrl` empty.
- AI: confirm the voice note gets an `aiTranscription` (proves OpenAI could fetch the R2 URL).
- Outbound voice: record and send from the composer.
- Template header media and a `send_media` flow node.
- Avatar upload in Settings → Profile.
- Legacy fallback: open a conversation with **pre-cutover** media and confirm it still plays from the old Convex URL.

- [ ] **Step 5: Confirm bytes are actually landing in R2**

In the Cloudflare dashboard, confirm object count and stored bytes for `wa-holidayys` are rising, and that keys follow `{accountId}/{kind}/{uuid}.{ext}`.

- [ ] **Step 6: Record the outcome**

Append a short "verified live 2026-XX-XX" note to the spec's Rollout section listing what was checked and anything that failed. Plan 2 (backfill + VPS purge) starts only from a fully green run here.

---

## Self-Review

**Spec coverage.** Config → Task 1; key convention → Task 1; single-module R2 access → Task 3; `Content-Type` signing contract → Tasks 3 and 6; schema additions → Task 4; all six external read sites → Task 5; tenant-isolation preservation → Task 6; both inbound paths → Task 7; the "verify Meta before backfilling" rollout gate → Task 8. Backfill, purge and legacy-column drop are deliberately Plan 2.

**Known gaps, stated rather than hidden.** Three test steps (Task 5 Step 1, Task 7 Step 1, and the seed shape in Task 4 Step 1) instruct the implementer to copy an existing arrangement from a neighbouring test rather than reproducing it inline. Those files run to hundreds of lines of bespoke seeding, and a fabricated approximation would be worse than a pointer to the real thing — but it does mean these are the three steps a reviewer should read most carefully.

**Type consistency.** `MediaKind` is defined once in Task 1 and consumed by Tasks 3, 6 and 7. `resolveMediaUrl` exists in two runtimes with deliberately identical semantics (server takes `cfg` explicitly, client reads its own env) — Task 2 asserts both. `startUpload` returns `{ uploadUrl, key }` in Task 6 and is consumed with those exact names. `storeFromUrl` returns `{ key }` in Task 6 and is destructured as `{ key }` in Task 7.
