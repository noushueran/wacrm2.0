import { expect, test, afterEach } from "vitest";
import { brandName, brandSiteUrl, productName } from "./brand";

// Unlike the Next.js module these are FUNCTIONS, so the env can be
// changed per test without module resetting — which is the point of the
// lazy shape: a missing value fails the one call that needs it, not the
// import of every Convex function downstream of it.

const ORIGINAL = {
  BRAND_NAME: process.env.BRAND_NAME,
  BRAND_SITE_URL: process.env.BRAND_SITE_URL,
};

afterEach(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("reads the configured identity from the Convex deployment env", () => {
  process.env.BRAND_NAME = "Testco";
  process.env.BRAND_SITE_URL = "https://wa.testco.example";
  expect(brandName()).toBe("Testco");
  expect(brandSiteUrl()).toBe("https://wa.testco.example");
});

test("derives productName the same way the Next.js side does", () => {
  process.env.BRAND_NAME = "Testco";
  expect(productName()).toBe("Testco WA CRM");
});

test("brandName throws when BRAND_NAME is missing, rather than falling back", () => {
  delete process.env.BRAND_NAME;
  expect(() => brandName()).toThrow("BRAND_NAME");
});

test("brandSiteUrl throws when BRAND_SITE_URL is missing", () => {
  delete process.env.BRAND_SITE_URL;
  expect(() => brandSiteUrl()).toThrow("BRAND_SITE_URL");
});

test("treats a whitespace-only value as missing", () => {
  process.env.BRAND_NAME = "   ";
  expect(() => brandName()).toThrow("BRAND_NAME");
});

// Containment: importing this module must never throw, even with nothing
// configured. A module-level throw would break every Convex function in
// the import graph rather than the one call that needs a brand string.
test("importing the module with NO brand env set does not throw", async () => {
  delete process.env.BRAND_NAME;
  delete process.env.BRAND_SITE_URL;
  await expect(import("./brand")).resolves.toBeDefined();
});
