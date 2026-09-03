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

// Lead Analysis scoring (spec 2026-07-26): sweep due leadAnalyses rows
// (by_score_due, leased claim) and score each against the account's BYO
// key. On an idle sweep it advances the historical backfill instead.
// No-op while the feature is disabled (no rows exist).
crons.interval(
  "lead-scoring",
  { minutes: 5 },
  internal.cronSchedules.runSweepLeadScoring,
  {},
);

// P3 Task 9: the follow-up sequence's own sweep (spec §8, P3 Task 8's
// `sweepLeadSequence`) — claims due `leadAnalyses` rows (`by_sequence_due`)
// and re-checks every gate at send time via `sequenceContext` before a
// real WhatsApp marketing template goes out. No-op while the feature is
// disabled (no `running` rows with a due `nextFollowUpAt` exist).
crons.interval(
  "lead-sequence",
  { minutes: 15 },
  internal.cronSchedules.runSweepLeadSequence,
  {},
);

// Auto-assign unowned Chasing threads (spec 2026-07-27-inbox-lanes
// §Chasing ownership). Sends NOTHING — patches `assignedToUserId` and
// notifies when nobody is eligible (in-app rows only — no customer
// message). Bounded per run.
//
// TWO gates, and the difference matters. It is a no-op for an account
// whose master `qualificationConfigs.enabled` is off — the same check
// every other job on this table makes. It is ALSO a no-op when
// `autoAssignEnabled` is explicitly `false`; but that field is
// `v.optional`, so an ABSENT flag means ON, not off. A config row
// written before Phase 6 added the field is therefore active, by
// design — `inboxChaseAssign.test.ts` pins it, because flipping it to a
// truthy test would silently disable both this sweep and the lead
// offers that share the flag.
// ARMED, matching the Amani deployment, after one deploy held dark to
// keep the first tick off an unswept backlog. The kill switch is now a
// real one: `autoAssignEnabled` has a Settings toggle in the shipped
// frontend, so stopping this no longer needs a deploy the way it did
// when the sweep first landed.
crons.interval(
  "inbox-chase-assign",
  { minutes: 30 },
  internal.cronSchedules.runSweepChaseAssign,
  {},
);

// Wake snoozed conversations whose time has come (spec
// 2026-07-28-inbox-manual-overrides §Waking). Clearing the field is what
// returns the thread to a lane — an expired-but-uncleared snooze is
// invisible forever — so this sweep is load-bearing, not cosmetic.
crons.interval(
  "inbox-snooze-wake",
  { minutes: 5 },
  internal.cronSchedules.runSweepSnoozeWake,
  {},
);

// Revival agent (spec 2026-08-09): draft nudges for leads that went
// quiet while still inside Meta's 24h window. Sends NOTHING — every
// draft waits for a human tap in `convex/revival.ts`, which re-checks
// every guard at that moment. No-op while the feature is disabled (no
// enabled `revivalConfigs` row exists).
crons.interval(
  "revival-sweep",
  { minutes: 30 },
  internal.cronSchedules.runRevivalSweep,
  {},
);

// Knowledge gap agent (spec 2026-08-09): turn answered escalations into
// knowledge-base drafts, and cluster the ones nobody answered. Six-hourly
// because a knowledge gap is not urgent and the inputs change slowly.
// Sends NOTHING to customers. No-op while the feature is disabled.
crons.interval(
  "kbgap-sweep",
  { minutes: 360 },
  internal.cronSchedules.runKbGapSweep,
  {},
);

// Sales coach (spec 2026-08-09): review threads a person handled and
// write quotable observations about the handling. Daily, because
// coaching is not an hourly concern and a person should not find fresh
// critique waiting every hour. Sends NOTHING to customers.
crons.interval(
  "sales-coach-sweep",
  { minutes: 1440 },
  internal.cronSchedules.runSalesCoachSweep,
  {},
);

// Time-based automations: fire each active `time_based` automation once
// per account-local day, at its configured "HH:mm", across the contacts
// holding its configured tag. The 15-minute interval sits well inside
// `schedule.ts`'s 60-minute catch-up window, so a missed tick still runs
// rather than skipping the day. No-op with no such automation.
crons.interval(
  "automations-time-based",
  { minutes: 15 },
  internal.cronSchedules.runSweepTimeBased,
  {},
);

// Rebuild the /dashboard KPI tiles. Purely a read-side cache: it sends
// nothing, writes only `dashboardSnapshots`, and is idempotent, so a
// missed tick costs staleness and nothing else.
//
// Two minutes is chosen against what the tiles MEAN, not against cost.
// They are day-scale figures (new contacts today, open pipeline value) on
// a screen a salesperson leaves open; a two-minute lag is invisible in
// that reading, while the tiles that must be exact to the second — the
// Needs Attention queue and the unread badges — were deliberately left as
// live subscriptions rather than snapshotted. The rendered "as of" line is
// what keeps the trade honest.
crons.interval(
  "dashboard-snapshot",
  { minutes: 2 },
  internal.cronSchedules.runRefreshDashboardSnapshots,
  {},
);

// Daily reconcile of the Meta customer-list audience: add contacts that
// now belong, remove the ones that no longer do (do-not-contact set, or
// converted). No-op while META_CUSTOM_AUDIENCE_ID is unset.
crons.interval(
  "meta-audience-sync",
  { minutes: 1440 },
  internal.cronSchedules.runMetaAudienceSync,
  {},
);

// Pull Meta's own per-event counts for the CAPI dataset into
// metaEventDailyStats — the third column of Reports → Events.
//
// Daily, and daily is the grain of the SOURCE rather than a cost choice:
// Meta returns counts already bucketed into whole business days.
//
// Daily is ENOUGH at any phase, and that is a property of the read side
// rather than luck — but the derivation is easy to get wrong by one day,
// so here it is in full. A run on day R claims coverage through R-1 (the
// last COMPLETE day: `lastCompleteDayKey` in `metaEventStats.ts`). A
// query on day Q asks for days through Q-2 (its window ends at
// YESTERDAY's local midnight: `metaEventReconciliation`'s `untilMs`).
// `coversWindow` needs `coveredUntil >= dayKeys[last]`, i.e.
// `R-1 >= Q-2`, i.e. `R >= Q-1`: YESTERDAY's run always suffices, at
// every hour of day Q including the instant after local midnight.
//
// Note where that lands if either side moves. With the query's window
// ending at TODAY's midnight instead, the requirement becomes `R >= Q` —
// the sync must already have run today, and the tab em-dashes from local
// midnight until it does. An earlier version of this work had exactly
// that, and answered it by running this cron four times a day to bound
// the blackout. That was treating a symptom; the day boundary was the
// cause, and this interval is only safe because of it.
//
// Each run re-syncs a trailing window because Meta's counts settle after
// the fact, and closes any gap left by failed runs; the upsert makes
// re-reading a day safe.
crons.interval(
  "meta-dataset-stats",
  { minutes: 1440 },
  internal.cronSchedules.runSyncDatasetStats,
  {},
);

export default crons;
