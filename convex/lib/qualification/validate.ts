import type { Doc } from "../../_generated/dataModel";

export type QualificationConfigPatch = Partial<
  Omit<Doc<"qualificationConfigs">, "_id" | "_creationTime" | "accountId" | "updatedAt">
>;

/**
 * Pure patch validation for `qualification.updateConfig` — returns an
 * error string (thrown by the mutation as BAD_REQUEST) or null. Only
 * checks fields present on the patch; merged-state rules (start < end)
 * are checked by the caller against the merged row, since either half
 * may come from the stored config rather than this patch.
 */
export function validateConfigPatch(patch: QualificationConfigPatch): string | null {
  if (
    patch.qualifyThresholdScore !== undefined &&
    (patch.qualifyThresholdScore < 0 || patch.qualifyThresholdScore > 100)
  ) {
    return "qualifyThresholdScore must be 0–100";
  }
  for (const key of ["workStartMinute", "workEndMinute"] as const) {
    const value = patch[key];
    if (value !== undefined && (value < 0 || value >= 24 * 60)) {
      return `${key} out of range`;
    }
  }
  if (
    patch.workDays !== undefined &&
    (patch.workDays.length === 0 || patch.workDays.some((d) => d < 0 || d > 6))
  ) {
    return "workDays must be non-empty, 0–6";
  }
  if (
    patch.followUpDelaysMinutes !== undefined &&
    (patch.followUpDelaysMinutes.length === 0 ||
      patch.followUpDelaysMinutes.some((m) => m < 5))
  ) {
    return "followUpDelaysMinutes must be >= 5 minutes each";
  }
  if (
    patch.maxFollowUps !== undefined &&
    (patch.maxFollowUps < 1 || patch.maxFollowUps > 10)
  ) {
    return "maxFollowUps must be 1–10";
  }
  if (
    patch.sessionWindowHours !== undefined &&
    (patch.sessionWindowHours < 1 || patch.sessionWindowHours > 24 * 14)
  ) {
    return "sessionWindowHours must be 1–336";
  }
  if (patch.basicFields !== undefined) {
    if (patch.basicFields.length === 0) return "basicFields must not be empty";
    for (const f of patch.basicFields) {
      if (!f.key.trim() || !f.label.trim() || f.phrasings.length === 0) {
        return "each basic field needs a key, label and at least one phrasing";
      }
    }
  }
  return null;
}
