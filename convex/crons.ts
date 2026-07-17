import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Retry CTWA ad->campaign name resolution (campaignAds pending/error with
// attempts < MAX). Also nudges dormant `pending` rows once a
// META_ADS_ACCESS_TOKEN is finally configured. Bounded, best-effort.
crons.interval(
  "retry-ad-resolution",
  { minutes: 60 },
  internal.campaignAds.retryResolutions,
  {},
);

// Retry unified conversion events (conversionEvents pending/error with
// attempts < MAX) across both backends. Also resends dormant `pending` rows
// once the relevant env is configured. Bounded, best-effort.
crons.interval(
  "retry-conversion-events",
  { minutes: 15 },
  internal.conversionEvents.retryConversionEvents,
  {},
);

// Qualification follow-ups (spec §8): sweep due collecting sessions
// (by_due, take 100) and fan out sendFollowUp per row — every guard
// (expiry, human takeover, working hours, 24h window) re-checked at
// send time. No-op while the feature is disabled (no due rows exist).
crons.interval(
  "qualification-follow-ups",
  { minutes: 5 },
  internal.qualificationEngine.sweepFollowUps,
  {},
);

export default crons;
