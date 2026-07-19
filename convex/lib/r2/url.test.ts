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
