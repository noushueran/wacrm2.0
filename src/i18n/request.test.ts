import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyBrand } from "./request";

// The suite runs with the fictional "Testco" identity (vitest.config.ts),
// so these assert the substitution, never a real company name.

test("substitutes the product-name sentinel", () => {
  expect(applyBrand("Install __PRODUCT_NAME__")).toBe("Install Testco WA CRM");
});

test("substitutes the brand-name sentinel", () => {
  expect(applyBrand("Install __BRAND_NAME__")).toBe("Install Testco");
});

test("substitutes every occurrence in one string, not just the first", () => {
  expect(applyBrand("__BRAND_NAME__ and __BRAND_NAME__")).toBe(
    "Testco and Testco",
  );
});

test("walks nested objects and arrays", () => {
  expect(
    applyBrand({ a: { b: "__PRODUCT_NAME__" }, c: ["__BRAND_NAME__", 1, null] }),
  ).toEqual({ a: { b: "Testco WA CRM" }, c: ["Testco", 1, null] });
});

test("leaves non-string leaves untouched", () => {
  expect(applyBrand({ n: 1, b: true, z: null })).toEqual({
    n: 1,
    b: true,
    z: null,
  });
});

test("preserves ICU placeholders — they are resolved by next-intl, not here", () => {
  expect(applyBrand("Join {accountName} on __PRODUCT_NAME__: {url}")).toBe(
    "Join {accountName} on Testco WA CRM: {url}",
  );
});

// The two guards that keep the dictionary deployment-neutral.

const RAW = readFileSync(
  join(__dirname, "..", "..", "messages", "en.json"),
  "utf8",
);

test("no message hardcodes a company name — identity belongs in the environment", () => {
  // This dictionary ships to every deployment. A company name here is a
  // string one deployment sends to another deployment's users: the invite
  // text at `invite.whatsappMessage` goes out over WhatsApp.
  const offenders = RAW.split("\n")
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => /Amani|amaniworld|Holidayys|holidayys/i.test(line));
  expect(offenders).toEqual([]);
});

test("every sentinel in the dictionary is one this module resolves", () => {
  const used = new Set(RAW.match(/__[A-Z_]+__/g) ?? []);
  const known = new Set(["__PRODUCT_NAME__", "__BRAND_NAME__"]);
  const unknown = [...used].filter((s) => !known.has(s));
  // An unresolved sentinel would render literally in the UI.
  expect(unknown).toEqual([]);
});

test("no sentinel survives substitution of the real dictionary", () => {
  const resolved = JSON.stringify(applyBrand(JSON.parse(RAW)));
  expect(resolved).not.toMatch(/__[A-Z_]+__/);
});
