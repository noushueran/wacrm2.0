import { expect, test, vi } from "vitest";
import { publicUrl, resolveMediaUrl, resolveMediaUrlLazy } from "./url";
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

// ============================================================
// resolveMediaUrlLazy — the hot-path guard. `r2ConfigFromEnv()` throws
// when R2 env vars are unset (config.ts:31-34), and every real row today
// carries only a legacy url (Task 5 ships before anything writes a key),
// so a consumer that unconditionally builds the config before checking
// `row.key` would turn "R2 not configured yet" into "every send throws"
// — see the Task 5 report for the full trap. `resolveMediaUrlLazy` never
// invokes `getConfig` unless `row.key` is actually present.
// ============================================================

test("resolveMediaUrlLazy never calls getConfig when there is no key — legacy url resolves without touching R2 config", () => {
  const getConfig = vi.fn(() => CFG);
  expect(
    resolveMediaUrlLazy(getConfig, {
      url: "https://convex-api.holidayys.co/api/storage/old",
    }),
  ).toBe("https://convex-api.holidayys.co/api/storage/old");
  expect(getConfig).not.toHaveBeenCalled();
});

test("resolveMediaUrlLazy never calls getConfig when neither key nor url is present", () => {
  const getConfig = vi.fn(() => CFG);
  expect(resolveMediaUrlLazy(getConfig, {})).toBeNull();
  expect(getConfig).not.toHaveBeenCalled();
});

test("resolveMediaUrlLazy calls getConfig and resolves the public URL when a key IS present", () => {
  const getConfig = vi.fn(() => CFG);
  expect(
    resolveMediaUrlLazy(getConfig, {
      key: "acc1/inbound/abc.ogg",
      url: "https://convex-api.holidayys.co/api/storage/old",
    }),
  ).toBe("https://objs.holidayys.co/acc1/inbound/abc.ogg");
  expect(getConfig).toHaveBeenCalledTimes(1);
});

test("resolveMediaUrlLazy propagates getConfig's throw when a key is present but R2 is unconfigured", () => {
  const getConfig = vi.fn(() => {
    throw new Error("R2_BUCKET is not set on this Convex deployment — R2 media storage is misconfigured.");
  });
  expect(() =>
    resolveMediaUrlLazy(getConfig, { key: "acc1/inbound/abc.ogg" }),
  ).toThrow(/R2_BUCKET is not set/);
});
