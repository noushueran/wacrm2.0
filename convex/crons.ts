import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// Every cron registers its cronSchedules.ts wrapper (not the target
// directly) so each execution stamps a cronRuns history row for the
// Settings → Cron schedules panel. Keep names + intervals in sync with
// lib/cronSummary.ts's CRON_REGISTRY.
const crons = cronJobs();

// Retry CTWA ad->campaign name resolution (campaignAds pending/error with
// attempts < MAX). Also nudges dormant `pending` rows once a
// META_ADS_ACCESS_TOKEN is finally configured. Bounded, best-effort.
crons.interval(
  "retry-ad-resolution",
  { minutes: 60 },
  internal.cronSchedules.runRetryAdResolution,
  {},
);

// Retry unified conversion events (conversionEvents pending/error with
// attempts < MAX) across both backends. Also resends dormant `pending` rows
// once the relevant env is configured. Bounded, best-effort.
crons.interval(
  "retry-conversion-events",
  { minutes: 15 },
  internal.cronSchedules.runRetryConversionEvents,
  {},
);

// Qualification follow-ups (spec §8): sweep due collecting sessions
// (by_due, take 100) and fan out sendFollowUp per row — every guard
// (expiry, human takeover, working hours, 24h window) re-checked at
// send time. No-op while the feature is disabled (no due rows exist).
crons.interval(
  "qualification-follow-ups",
  { minutes: 5 },
  internal.cronSchedules.runSweepFollowUps,
  {},
);

// P6: expire lead offers past their consent window (default 10 min) and
// move to the next eligible agent. No-op with no offered rows.
crons.interval(
  "qualification-lead-offers",
  { minutes: 5 },
  internal.cronSchedules.runSweepLeadOffers,
  {},
);

// P6: hourly staff loops — assigned-lead feedback reminders (4h → daily,
// supervisor escalation after 2 quiet days) + daily staff window
// keepalive (plain nudge in-window, staff_checkin template once closed).
crons.interval(
  "qualification-staff-loops",
  { minutes: 60 },
  internal.cronSchedules.runStaffLoops,
  {},
);

export default crons;
