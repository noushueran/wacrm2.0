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

// Degrade-not-throw behavior (Task 5 review fix): a render-phase throw from
// `resolveMediaUrl` is unrecoverable — it runs inside `AuthProvider`'s render
// (`src/hooks/use-auth.tsx`) and inside a `useMemo` over the message list
// (`src/lib/convex/adapters.ts` / `src/components/inbox/message-thread.tsx`).
// So when the host is unconfigured, this module must degrade to the legacy
// url (or null) instead of throwing.

test("resolveMediaUrl falls back to the legacy url when the host is unset and the row carries both a key and a url", async () => {
  delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  vi.resetModules();
  const { resolveMediaUrl } = await import("./media-url");
  expect(
    resolveMediaUrl({
      key: "acc1/outbound/a.png",
      url: "https://legacy.example/a.png",
    }),
  ).toBe("https://legacy.example/a.png");
});

test("resolveMediaUrl returns null (not a throw) when the host is unset and the row carries only a key", async () => {
  delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  vi.resetModules();
  const { resolveMediaUrl } = await import("./media-url");
  expect(resolveMediaUrl({ key: "acc1/outbound/a.png" })).toBeNull();
});

test("resolveMediaUrl logs a console.error when the host is unset and the row carries a key", async () => {
  delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  vi.resetModules();
  const { resolveMediaUrl } = await import("./media-url");
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    resolveMediaUrl({
      key: "acc1/outbound/a.png",
      url: "https://legacy.example/a.png",
    });
    expect(errorSpy).toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});

test("mediaUrlFromKey returns null (not a throw) when the host is unset", async () => {
  delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  vi.resetModules();
  const { mediaUrlFromKey } = await import("./media-url");
  expect(mediaUrlFromKey("acc1/outbound/a.png")).toBeNull();
});
