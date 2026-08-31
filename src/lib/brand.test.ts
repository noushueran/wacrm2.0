import { expect, test, vi, beforeEach, afterEach } from "vitest";

// `vi.resetModules()` + dynamic `import()` is this repo's convention for
// module-load-time env behaviour — see `src/lib/storage/media-url.test.ts`.

const KEYS = [
  "NEXT_PUBLIC_BRAND_NAME",
  "NEXT_PUBLIC_BRAND_LEGAL_NAME",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_BRAND_WEBSITE",
  "NEXT_PUBLIC_BRAND_EMAIL",
] as const;

const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

function setAll() {
  process.env.NEXT_PUBLIC_BRAND_NAME = "Testco";
  process.env.NEXT_PUBLIC_BRAND_LEGAL_NAME = "Testco Holdings LLC";
  process.env.NEXT_PUBLIC_SITE_URL = "https://wa.testco.example";
  process.env.NEXT_PUBLIC_BRAND_WEBSITE = "https://testco.example";
  process.env.NEXT_PUBLIC_BRAND_EMAIL = "hello@testco.example";
}

beforeEach(() => {
  setAll();
  vi.resetModules();
});

afterEach(() => {
  for (const k of KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  vi.resetModules();
});

test("exposes every configured identity value", async () => {
  const { BRAND } = await import("./brand");
  expect(BRAND.name).toBe("Testco");
  expect(BRAND.legalName).toBe("Testco Holdings LLC");
  expect(BRAND.siteUrl).toBe("https://wa.testco.example");
  expect(BRAND.website).toBe("https://testco.example");
  expect(BRAND.email).toBe("hello@testco.example");
});

test("derives PRODUCT_NAME from the brand name so the halves cannot drift", async () => {
  const { PRODUCT_NAME } = await import("./brand");
  expect(PRODUCT_NAME).toBe("Testco WA CRM");
});

// The load-bearing contract. A fallback here is how one company's CRM
// ships wearing another company's name, so EVERY variable must fail the
// build rather than default.
for (const key of KEYS) {
  test(`throws when ${key} is missing, rather than falling back`, async () => {
    delete process.env[key];
    vi.resetModules();
    await expect(import("./brand")).rejects.toThrow(key);
  });

  test(`treats a whitespace-only ${key} as missing`, async () => {
    process.env[key] = "   ";
    vi.resetModules();
    await expect(import("./brand")).rejects.toThrow(key);
  });
}

test("the frozen BRAND object cannot be mutated at runtime", async () => {
  const { BRAND } = await import("./brand");
  expect(Object.isFrozen(BRAND)).toBe(true);
});
