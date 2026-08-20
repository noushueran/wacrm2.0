import { expect, test } from "vitest";
import {
  excludedParameterisedTemplateCount,
  pickableSequenceTemplates,
  templateHasBodyPlaceholders,
  type TemplateCatalogRow,
} from "./templatePicker";

// ------------------------------------------------------------------
// Fix 3 (whole-branch review, "prevent" half): a template whose body
// carries Meta sample variables can still be APPROVED — Meta only
// reviews the text, never whether a future caller will ever supply
// `params`. `leadAnalysisEngine.ts`'s `sendSequenceStep` calls
// `metaSend.sendTemplate` with a fixed body and NO `params`, so picking
// one of these in the step picker silently burns the lead's cadence at
// send time (error 132000). These tests pin that such a template never
// appears as a pickable option.
// ------------------------------------------------------------------

const approvedPlain: TemplateCatalogRow = {
  name: "welcome_back",
  language: "en_US",
  status: "APPROVED",
};

const approvedParameterised: TemplateCatalogRow = {
  name: "hi_name",
  language: "en_US",
  status: "APPROVED",
  sampleValues: { body: ["Asha"] },
};

const pendingPlain: TemplateCatalogRow = {
  name: "check_in",
  language: "en_US",
  status: "PENDING",
};

test("templateHasBodyPlaceholders is false when sampleValues.body is absent", () => {
  expect(templateHasBodyPlaceholders(approvedPlain)).toBe(false);
});

test("templateHasBodyPlaceholders is false when sampleValues.body is an empty array", () => {
  expect(
    templateHasBodyPlaceholders({ ...approvedPlain, sampleValues: { body: [] } }),
  ).toBe(false);
});

test("templateHasBodyPlaceholders is true when sampleValues.body carries at least one entry", () => {
  expect(templateHasBodyPlaceholders(approvedParameterised)).toBe(true);
});

test("pickableSequenceTemplates offers an approved, unparameterised template", () => {
  const options = pickableSequenceTemplates([approvedPlain]);
  expect(options).toEqual([{ name: "welcome_back", language: "en_US" }]);
});

test("pickableSequenceTemplates never offers a parameterised template, even if APPROVED", () => {
  const options = pickableSequenceTemplates([approvedPlain, approvedParameterised]);
  expect(options.map((o) => o.name)).toEqual(["welcome_back"]);
  expect(options.map((o) => o.name)).not.toContain("hi_name");
});

test("pickableSequenceTemplates still excludes a non-APPROVED template regardless of placeholders", () => {
  const options = pickableSequenceTemplates([pendingPlain]);
  expect(options).toEqual([]);
});

test("excludedParameterisedTemplateCount counts only APPROVED-but-parameterised rows", () => {
  expect(
    excludedParameterisedTemplateCount([approvedPlain, approvedParameterised, pendingPlain]),
  ).toBe(1);
});

test("excludedParameterisedTemplateCount does not count a parameterised template that isn't APPROVED", () => {
  expect(
    excludedParameterisedTemplateCount([{ ...approvedParameterised, status: "PENDING" }]),
  ).toBe(0);
});

test("excludedParameterisedTemplateCount is 0 when nothing is parameterised", () => {
  expect(excludedParameterisedTemplateCount([approvedPlain, pendingPlain])).toBe(0);
});
