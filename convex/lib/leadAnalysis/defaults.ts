import type { BandRule } from "./bands";

// ============================================================
// The seeded Lead Analysis config (spec "Approved defaults"). Mirrors
// `lib/qualification/defaults.ts`: a pure factory the config CRUD falls
// back to until an admin persists a row, so the feature is fully
// described in code rather than half in the database.
//
// `templateName` is intentionally EMPTY on every step. P1 never sends,
// and P3's config UI forces the admin to pick a real approved template
// before the sequence can be enabled — an empty name is the "not
// configured yet" marker, never a send.
// ============================================================

export interface LeadAnalysisConfigDefaults {
  enabled: boolean;
  rescoreDebounceMinutes: number;
  scorePerRun: number;
  backfillEnabled: boolean;
  backfillPerRun: number;
  idleDaysBeforeSequence: number;
  humanQuietHours: number;
  dailySendCap: number;
  agedOutDays: number;
  bands: BandRule[];
}

export function defaultLeadAnalysisConfig(): LeadAnalysisConfigDefaults {
  return {
    enabled: false,
    rescoreDebounceMinutes: 10,
    scorePerRun: 25,
    backfillEnabled: true,
    backfillPerRun: 10,
    idleDaysBeforeSequence: 3,
    humanQuietHours: 24,
    dailySendCap: 100,
    agedOutDays: 120,
    bands: [
      {
        key: "hot",
        minScore: 8,
        maxScore: 10,
        autoArchive: false,
        steps: [
          { delayDays: 2, templateName: "" },
          { delayDays: 5, templateName: "" },
          { delayDays: 10, templateName: "" },
        ],
      },
      {
        key: "warm",
        minScore: 4,
        maxScore: 7,
        autoArchive: true,
        steps: [
          { delayDays: 3, templateName: "" },
          { delayDays: 7, templateName: "" },
        ],
      },
      {
        key: "cold",
        minScore: 1,
        maxScore: 3,
        autoArchive: true,
        steps: [{ delayDays: 5, templateName: "" }],
      },
    ],
  };
}
