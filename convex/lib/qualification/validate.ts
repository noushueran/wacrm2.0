import type { Doc } from "../../_generated/dataModel";
import { normalizePhone } from "../phone";

export type QualificationConfigPatch = Partial<
  Omit<Doc<"qualificationConfigs">, "_id" | "_creationTime" | "accountId" | "updatedAt">
>;

/** The complete set of admin-patchable config keys. `updateConfig`
 *  strips anything else BEFORE validation, so a stray client field can
 *  never reach the schema validator as a raw server error. */
export const CONFIG_PATCH_KEYS = [
  "enabled",
  "basicFields",
  "qualifyThresholdScore",
  "timezoneLabel",
  "utcOffsetMinutes",
  "workStartMinute",
  "workEndMinute",
  "workDays",
  "followUpDelaysMinutes",
  "maxFollowUps",
  "sessionWindowHours",
  "reengagementTemplateName",
  "reengagementTemplateLanguage",
  "closingMessage",
  "adminAlertEnabled",
  "adminAlertPhones",
  "adminAlertTemplateName",
  "adminAlertTemplateLanguage",
  "autoAssignEnabled",
  "offerTimeoutMinutes",
  "staffCheckinTemplateName",
  "staffCheckinTemplateLanguage",
  "outboundNudgesEnabled",
] as const;

function isNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}
function isNumberArray(x: unknown): x is number[] {
  return Array.isArray(x) && x.every(isNumber);
}
function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}

/**
 * Pure patch validation for `qualification.updateConfig` — returns an
 * error string (thrown by the mutation as BAD_REQUEST) or null. Only
 * checks fields present on the patch; merged-state rules (start < end)
 * are checked by the caller against the merged row, since either half
 * may come from the stored config rather than this patch. Every check
 * type-guards first (review fix): wrong-TYPED input yields the same
 * friendly BAD_REQUEST as an out-of-range value, never a raw TypeError.
 */
export function validateConfigPatch(patch: QualificationConfigPatch): string | null {
  const p = patch as Record<string, unknown>;

  for (const key of ["enabled", "adminAlertEnabled", "outboundNudgesEnabled", "autoAssignEnabled"] as const) {
    if (p[key] !== undefined && typeof p[key] !== "boolean") {
      return `${key} must be a boolean`;
    }
  }
  for (const key of [
    "timezoneLabel",
    "closingMessage",
    "reengagementTemplateName",
    "reengagementTemplateLanguage",
    "adminAlertTemplateName",
    "adminAlertTemplateLanguage",
    "staffCheckinTemplateName",
    "staffCheckinTemplateLanguage",
  ] as const) {
    if (p[key] !== undefined && typeof p[key] !== "string") {
      return `${key} must be a string`;
    }
  }
  if (p.utcOffsetMinutes !== undefined && !isNumber(p.utcOffsetMinutes)) {
    return "utcOffsetMinutes must be a number";
  }

  if (p.qualifyThresholdScore !== undefined) {
    if (!isNumber(p.qualifyThresholdScore) || p.qualifyThresholdScore < 0 || p.qualifyThresholdScore > 100) {
      return "qualifyThresholdScore must be 0–100";
    }
  }
  for (const key of ["workStartMinute", "workEndMinute"] as const) {
    const value = p[key];
    if (value !== undefined && (!isNumber(value) || value < 0 || value >= 24 * 60)) {
      return `${key} out of range`;
    }
  }
  if (p.workDays !== undefined) {
    if (!isNumberArray(p.workDays) || p.workDays.length === 0 || p.workDays.some((d) => d < 0 || d > 6)) {
      return "workDays must be non-empty, 0–6";
    }
  }
  if (p.followUpDelaysMinutes !== undefined) {
    if (
      !isNumberArray(p.followUpDelaysMinutes) ||
      p.followUpDelaysMinutes.length === 0 ||
      p.followUpDelaysMinutes.some((m) => m < 5)
    ) {
      return "followUpDelaysMinutes must be >= 5 minutes each";
    }
  }
  if (p.offerTimeoutMinutes !== undefined) {
    if (!isNumber(p.offerTimeoutMinutes) || p.offerTimeoutMinutes < 2 || p.offerTimeoutMinutes > 240) {
      return "offerTimeoutMinutes must be 2–240";
    }
  }
  if (p.maxFollowUps !== undefined) {
    if (!isNumber(p.maxFollowUps) || p.maxFollowUps < 1 || p.maxFollowUps > 10) {
      return "maxFollowUps must be 1–10";
    }
  }
  if (p.sessionWindowHours !== undefined) {
    if (!isNumber(p.sessionWindowHours) || p.sessionWindowHours < 1 || p.sessionWindowHours > 24 * 14) {
      return "sessionWindowHours must be 1–336";
    }
  }
  if (p.basicFields !== undefined) {
    if (!Array.isArray(p.basicFields) || p.basicFields.length === 0) {
      return "basicFields must not be empty";
    }
    for (const f of p.basicFields as unknown[]) {
      if (!f || typeof f !== "object") return "each basic field must be an object";
      const rec = f as Record<string, unknown>;
      if (
        typeof rec.key !== "string" || !rec.key.trim() ||
        typeof rec.label !== "string" || !rec.label.trim() ||
        typeof rec.required !== "boolean" ||
        !isStringArray(rec.phrasings) || rec.phrasings.length === 0
      ) {
        return "each basic field needs a key, label, required flag and at least one phrasing";
      }
    }
  }
  if (p.adminAlertPhones !== undefined) {
    if (!isStringArray(p.adminAlertPhones)) return "adminAlertPhones must be a list of phone numbers";
    for (const phone of p.adminAlertPhones) {
      const digits = normalizePhone(phone);
      // Same plausibility rule as the REST layer's E.164 check: 7–15
      // digits, no leading zero (review fix — these numbers become a
      // Meta `to` and an internal contact, so garbage must not enter).
      if (!/^[1-9]\d{6,14}$/.test(digits)) {
        return `adminAlertPhones: "${phone}" is not a valid phone number`;
      }
    }
  }
  return null;
}
