import type { Doc } from "../../_generated/dataModel";

// ============================================================
// Approved default configuration — spec §11 (Holidayys preset) + §17
// (decision log) of docs/superpowers/specs/
// 2026-07-18-lead-qualification-followup-design.md. Hours are the
// VERIFIED company hours (10:00–21:00 GST, closed Sunday — see
// holidayys-ai-agent/SPEC.md), deliberately not the 9–6 example from
// the original request; the owner can change everything in Settings.
// `basicFields` is only the OFF-TOPIC fallback — per-service questions
// live in the AI knowledge-base docs' QUALIFICATION CHECKLIST sections.
// ============================================================

export type QualificationConfigSeed = Omit<
  Doc<"qualificationConfigs">,
  "_id" | "_creationTime" | "accountId"
>;

export function holidayysDefaultConfig(): QualificationConfigSeed {
  return {
    enabled: false,
    basicFields: [
      {
        key: "looking_for",
        label: "What they're looking for",
        required: true,
        phrasings: [
          "What are you looking for — a holiday package, a visa, or flights & hotels?",
          "Happy to help! Is this about a holiday package, a visa, or flights/hotels?",
        ],
      },
      {
        key: "travel_dates",
        label: "Travel dates",
        required: true,
        phrasings: [
          "When are you planning to travel — exact dates or a rough month is fine.",
          "What time are you looking at for the trip? Even a rough month helps.",
        ],
      },
      {
        key: "travelers",
        label: "Travelers",
        required: true,
        phrasings: [
          "How many people will be travelling? If kids are coming, their ages help too.",
          "Who's coming along — how many adults, and any children?",
        ],
      },
      {
        key: "email",
        label: "Email",
        required: true,
        phrasings: [
          "Could you share your email so we can send your detailed quote?",
          "What's the best email to send the details and quote to?",
        ],
      },
    ],
    qualifyThresholdScore: 60,
    timezoneLabel: "Asia/Dubai",
    utcOffsetMinutes: 240,
    workStartMinute: 10 * 60,
    workEndMinute: 21 * 60,
    workDays: [1, 2, 3, 4, 5, 6],
    followUpDelaysMinutes: [60, 180, 720, 1440],
    maxFollowUps: 4,
    sessionWindowHours: 72,
    // The two templates submitted to Meta for this feature (2026-07-18):
    // out-of-window follow-ups + the admin lead alert. Names only take
    // effect when the features are on; an unapproved template just makes
    // that send skip/fail gracefully.
    reengagementTemplateName: "qualification_followup",
    reengagementTemplateLanguage: "en_US",
    adminAlertTemplateName: "lead_alert",
    adminAlertTemplateLanguage: "en_US",
    closingMessage: "Thank you! Our travel expert will contact you shortly.",
    adminAlertEnabled: false,
    adminAlertPhones: [],
    outboundNudgesEnabled: false,
  };
}
