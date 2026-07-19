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

test("resolveMediaUrl prefers key, falls back to legacy url, else null", async () => {
  const { resolveMediaUrl } = await import("./media-url");
  expect(resolveMediaUrl({ key: "acc1/outbound/a.png", url: "legacy" })).toBe(
    "https://objs.holidayys.co/acc1/outbound/a.png",
  );
  expect(resolveMediaUrl({ url: "legacy" })).toBe("legacy");
  expect(resolveMediaUrl({})).toBeNull();
});
