import { accountQuery } from "./lib/auth";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { conversationScope } from "./lib/roles";
import { v } from "convex/values";
import {
  hourStartMs,
  foldHoursIntoDays,
  foldHoursIntoResponseBuckets,
} from "./lib/messageStats";
// `localDayKeyFromMs` is no longer imported here: day-bucketing for the
// messages chart moved into `foldHoursIntoDays`, which owns it now.
import {
  localMidnightMsDaysAgo,
  localMondayIndexFromMs,
} from "./lib/dashboardDate";

// ============================================================
// Dashboard aggregations (Phase 3, Task 3) — read-only ports of
// `src/lib/dashboard/queries.ts`'s five client-side Supabase
// aggregations. Every function here is built on `accountQuery` (never
// the raw `query`), so `ctx.accountId` always comes from the caller's
// own `memberships` row, never a client-supplied argument — there is no
// `accountId` field in any args validator below. The aggregations are
// otherwise ungated: reading your own account's *counts* is the
// lowest-privilege operation in the app, same treatment as
// `conversations.list`/`contacts.list`.
//
// `activity` is the one exception and gates on `supervisor`. It is the
// only function here that returns per-row detail rather than an
// aggregate — customer-message rows with their `/inbox?c=<id>` deep
// links, and contact names that fall back to the RAW phone — and it
// applies neither `conversationScope` nor `maskContactPhone`. Ungated,
// an agent or viewer could call it directly and enumerate which
// contacts have live threads, including colleagues' assigned
// conversations `messages.listByConversation` would refuse them. The
// floor matches `SUPERVISOR_NAV` in `src/lib/auth/roles.ts`, which is
// what already restricts `/dashboard` in the UI.
//
// Local-day boundaries (what "today"/"this week" means) can only be
// computed by whoever knows the caller's timezone — a Convex function
// always runs in UTC, so every boundary that the original browser-side
// code derived from `new Date()` is instead accepted as an arg here.
// `snapshot`/`conversationsSeries` take already-computed boundary
// timestamps (the "preferred" shape per the task brief). `responseTime`
// additionally needs to bucket individual samples by local
// day-of-week, which can't be reduced to a couple of scalar cutoffs, so
// it (like `conversationsSeries`) also takes a `tzOffsetMinutes` arg —
// see `convex/lib/dashboardDate.ts`'s header comment for the exact
// convention (matches `Date.prototype.getTimezoneOffset()`).
//
// WHAT CHANGED, AND WHY (dashboard/reports performance pass). The KPI
// tiles used to be `metrics`, a live aggregation measured in production at
// 1,882 document reads and ~8 seconds. Most of that was a ~1,300-row
// `messages` collect computing a "messages sent today" figure NO component
// rendered — dead weight that also forced the route's first read to touch
// `messages`, the one table on this deployment with a large cold-start
// penalty (measured: 12.7s for a single document, ~1.4s warm). The tiles
// now read one precomputed row via `snapshot`, rebuilt off the page-load
// path by `refreshSnapshots`.
//
// `metrics` itself survives below ONLY as a deprecated shim, because this
// app's frontend and backend deploy separately and removing it outright
// would break every already-loaded client the instant the backend shipped.
// It has no callers in this repo and is scheduled for deletion — see its
// own doc comment.
//
// `conversationsSeries`, `responseTime` and `activity` all survive here
// unchanged, but the DASHBOARD no longer calls them — they moved to
// /reports, which is where a chart or a feed belongs and where a reader
// has already accepted that they are waiting for analysis. Keeping them in
// this module rather than relocating them keeps the diff to call sites.
//
// Every read here is bounded by something that does not grow forever — a
// time window, a fixed take (`activity`'s sources, `refreshSnapshots`'s
// open-conversation count), or a status range.
//
// The claim that a status range bounds the open-conversation count was
// wrong in practice: nothing in the app auto-closes a conversation — the
// only writers of `status: "closed"` are an optional automation action
// and a manual per-thread control — so the "open" partition asymptotically
// equals the whole table. That count is a `.take()` instead, which is
// a genuine read bound because the range pins `status` and every document
// read is therefore a match.
//
// `refreshSnapshots`'s open DEALS collect is knowingly left as-is. It needs
// the rows (it sums `value`, and a silently truncated sum is worse than a
// truncated count), and unlike conversations the open-deal set really is
// bounded in practice — the pipeline closes deals won/lost, so it tracks
// active pipeline size rather than accumulating forever.
// ============================================================

/**
 * Ceiling on the open-conversation count stored by `refreshSnapshots`.
 *
 * Chosen to be far above any number a human reads as a precise figure —
 * past a few hundred the card communicates "a lot", not a quantity — while
 * keeping the read cost fixed regardless of account size. Exported so the
 * test suite asserts against the real bound rather than a copy of it.
 */
export const ACTIVE_CONVERSATIONS_CAP = 500;

// --- 1. KPI tiles: snapshot read + cron refresh --------------------------

/**
 * How much history `refreshSnapshots` copies into `recentHours`.
 *
 * The read only ever needs "today" and "yesterday" in the CALLER's
 * timezone, which is at most 48 hours of local calendar — but the window
 * has to be anchored in UTC at write time, and UTC offsets run from -12
 * to +14. A local "yesterday" can therefore begin up to 14 hours before
 * the corresponding UTC instant, so 48 + 14 = 62 is the true floor. 72
 * rounds that to three whole days with room to spare, and costs 72 small
 * rows.
 */
export const SNAPSHOT_HOURS = 72;

/**
 * Rebuild every account's dashboard snapshot. The `dashboard-snapshot`
 * cron's target.
 *
 * A mutation rather than an action, and one transaction for all accounts,
 * matching `inboxChaseAssign.sweepChaseAssign` — the per-account work below
 * is bounded (a capped take, one unread range, open deals, and
 * `SNAPSHOT_HOURS` rollup rows), so the cost scales with the number of
 * accounts rather than with any account's history.
 *
 * Idempotent: it patches the account's single row, or inserts one the first
 * time it runs. There is therefore no harm in invoking it by hand —
 * `npx convex run dashboard:refreshSnapshots` — which is exactly how a
 * fresh deployment fills the tiles without waiting for the first tick.
 */
export const refreshSnapshots = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ accounts: number }> => {
    const now = Date.now();
    const accounts = await ctx.db.query("accounts").collect();

    for (const account of accounts) {
      // Open, non-archived conversations. Every key in this range is bound
      // by equality, so every document read is a match and the `.take()` is
      // a genuine read bound rather than a filter that starves — the same
      // property `reports.conversationStatusMix` relies on. The +1 is what
      // separates "exactly the cap" from "more than the cap".
      const openSample = await ctx.db
        .query("conversations")
        .withIndex("by_account_archived_status", (q) =>
          q
            .eq("accountId", account._id)
            .eq("archivedAt", undefined)
            .eq("status", "open"),
        )
        .take(ACTIVE_CONVERSATIONS_CAP + 1);
      const activeCapped = openSample.length > ACTIVE_CONVERSATIONS_CAP;

      // Awaiting a reply, split by role scope before it is stored — see the
      // `waitingOnReply` field comment in schema.ts for why a single total
      // would leak one agent's queue to another. No archive predicate is
      // needed for the same reason `conversations.unreadTotal` needs none:
      // `leadAnalysis.archive` zeroes `unreadCount`, so an archived thread
      // leaves this range on its own.
      const unread = await ctx.db
        .query("conversations")
        .withIndex("by_account_unread", (q) =>
          q.eq("accountId", account._id).gt("unreadCount", 0),
        )
        .collect();
      let pool = 0;
      const byUser = new Map<Id<"users">, number>();
      for (const c of unread) {
        if (c.assignedToUserId === undefined) pool += 1;
        else
          byUser.set(
            c.assignedToUserId,
            (byUser.get(c.assignedToUserId) ?? 0) + 1,
          );
      }

      // Open deals. Needs the rows themselves (it sums `value`, and a
      // silently truncated sum is worse than a truncated count), which is
      // safe here because the pipeline closes deals won/lost — unlike
      // conversations, the open partition tracks active pipeline size rather
      // than accumulating forever.
      const openDeals = await ctx.db
        .query("deals")
        .withIndex("by_account_status", (q) =>
          q.eq("accountId", account._id).eq("status", "open"),
        )
        .collect();

      // New contacts, bucketed into UTC hours here so the read can fold
      // them into any viewer's local day.
      //
      // Read from `contacts` rather than from `messageHourlyStats`'s
      // `conversationsStarted`, even though that rollup is cheaper and
      // (because every conversation-creating path is find-or-create BY
      // CONTACT) counts almost the same thing. Two reasons. It is the same
      // source the tile has always used, so this change cannot quietly
      // alter what the number MEANS; and `acquisitionSource` — which is
      // what splits ad leads from direct — lives on the contact, so the
      // rollup could only supply the split via a second counter that has
      // its own write path to be wrong about. The cost that made the old
      // query slow was never this read: a 72-hour window of contacts is
      // tens of rows (the two-day window it replaces measured at ~30),
      // against the ~1,300 `messages` rows that dominated.
      const windowStartMs = hourStartMs(now) - SNAPSHOT_HOURS * 3_600_000;
      const emptyBucket = () => ({
        newContacts: 0,
        newContactsAd: 0,
        newOpenConversations: 0,
      });
      const buckets = new Map<number, ReturnType<typeof emptyBucket>>();
      const bucketAt = (atMs: number) => {
        const key = hourStartMs(atMs);
        const row = buckets.get(key) ?? emptyBucket();
        buckets.set(key, row);
        return row;
      };

      const recentContacts = await ctx.db
        .query("contacts")
        .withIndex("by_account", (q) =>
          q.eq("accountId", account._id).gte("_creationTime", windowStartMs),
        )
        .collect();
      for (const contact of recentContacts) {
        const row = bucketAt(contact._creationTime);
        row.newContacts += 1;
        // Set once, the first time a contact arrives via an ad referral
        // (see schema.ts), so its presence is the ad-lead signal.
        if (contact.acquisitionSource === "ad") row.newContactsAd += 1;
      }

      // Feeds the Active Conversations tile's today-vs-yesterday delta.
      // Deliberately NOT derived from `openSample` above, for the reason
      // the old live query gave: that sample is truncated, and truncated at
      // the wrong end — the index orders by status then `_creationTime`, so
      // a `.take()` drops exactly the newest rows this delta is about. This
      // window is bounded by time instead, so applying `status`/`archivedAt`
      // in JS starves nothing.
      const recentConversations = await ctx.db
        .query("conversations")
        .withIndex("by_account", (q) =>
          q.eq("accountId", account._id).gte("_creationTime", windowStartMs),
        )
        .collect();
      for (const conversation of recentConversations) {
        if (conversation.status !== "open") continue;
        if (conversation.archivedAt !== undefined) continue;
        bucketAt(conversation._creationTime).newOpenConversations += 1;
      }

      const recentHours = [...buckets.entries()]
        .map(([hour, counts]) => ({ hourStartMs: hour, ...counts }))
        .sort((a, b) => a.hourStartMs - b.hourStartMs);

      const next = {
        accountId: account._id,
        computedAtMs: now,
        activeConversations: activeCapped
          ? ACTIVE_CONVERSATIONS_CAP
          : openSample.length,
        activeConversationsCapped: activeCapped,
        activeConversationsCap: ACTIVE_CONVERSATIONS_CAP,
        openDealsValue: openDeals.reduce((sum, d) => sum + d.value, 0),
        openDealsCount: openDeals.length,
        waitingOnReply: {
          all: unread.length,
          pool,
          byUser: [...byUser.entries()].map(([userId, count]) => ({
            userId,
            count,
          })),
        },
        recentHours,
      };

      const existing = await ctx.db
        .query("dashboardSnapshots")
        .withIndex("by_account", (q) => q.eq("accountId", account._id))
        .unique();
      if (existing) await ctx.db.patch(existing._id, next);
      else await ctx.db.insert("dashboardSnapshots", next);
    }

    return { accounts: accounts.length };
  },
});

/**
 * The /dashboard KPI tiles — ONE indexed point read.
 *
 * `todayStartMs`/`yesterdayStartMs` keep the exact arg contract the old
 * live `metrics` query had, and for the same reason: a Convex function runs
 * in UTC, so only the caller knows where its own days begin. The difference
 * is what those boundaries are applied to — a stored 72-hour rollup rather
 * than a fresh scan of three tables.
 *
 * Returns `null` when the cron has not run yet (a freshly deployed backend,
 * or a brand-new account created since the last tick). That is a real state
 * the UI has to render, not an error: the tiles show no figures and say so,
 * rather than showing zeros that would read as "no work today".
 *
 * Ungated like the aggregates beside it — reading your own account's counts
 * is the lowest-privilege operation in the app — EXCEPT for
 * `waitingOnReply`, which is resolved against the caller's own role scope
 * here so an agent never sees a colleague's queue.
 */
export const snapshot = accountQuery({
  args: {
    todayStartMs: v.number(),
    yesterdayStartMs: v.number(),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("dashboardSnapshots")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .unique();
    if (!row) return null;

    const { todayStartMs, yesterdayStartMs } = args;
    // `toMs` is EXCLUSIVE, and `null` means "no upper bound".
    const fold = (fromMs: number, toMs: number | null) => {
      let total = 0;
      let ad = 0;
      let newOpen = 0;
      for (const h of row.recentHours) {
        if (h.hourStartMs < fromMs) continue;
        if (toMs !== null && h.hourStartMs >= toMs) continue;
        total += h.newContacts;
        ad += h.newContactsAd;
        newOpen += h.newOpenConversations;
      }
      return { total, ad, newOpen };
    };
    // Today is open-ended rather than `todayStartMs + 24h`. A local day is
    // not always 24 hours — on a DST transition it is 23 or 25 — so a fixed
    // span would drop or borrow an hour twice a year. Nothing can be created
    // in the future, and `recentHours` is itself bounded to the newest
    // SNAPSHOT_HOURS, so "from today's start onwards" IS today.
    const today = fold(todayStartMs, null);
    // Yesterday is bounded by both client-supplied calendar boundaries, so
    // it stays correct across the same transitions.
    const yesterday = fold(yesterdayStartMs, todayStartMs);

    // The one role-scoped field. Mirrors `conversations.unreadTotal`'s
    // scoping exactly: supervisor+ see the account total, an agent sees
    // their own plus the unassigned pool, a viewer sees the pool alone.
    const scope = conversationScope(ctx.role);
    const mine =
      row.waitingOnReply.byUser.find((r) => r.userId === ctx.userId)?.count ?? 0;
    const waitingOnReply =
      scope === "all"
        ? row.waitingOnReply.all
        : scope === "own_and_pool"
          ? mine + row.waitingOnReply.pool
          : row.waitingOnReply.pool;

    return {
      computedAtMs: row.computedAtMs,
      waitingOnReply,
      activeConversations: {
        current: row.activeConversations,
        capped: row.activeConversationsCapped,
        // Not "yesterday's open count" — see the field comment in
        // schema.ts. A current-state count has no clean historical
        // comparison without stored history, so what the tile compares is
        // the flow of NEW open threads today against yesterday's.
        previous: today.newOpen - yesterday.newOpen,
      },
      newContactsToday: {
        current: today.total,
        previous: yesterday.total,
      },
      // Same additive shape the tile already understood: an ad/direct split
      // when it is available, a plain vs-yesterday delta otherwise.
      newLeadsBySource: {
        adToday: today.ad,
        directToday: today.total - today.ad,
        adYesterday: yesterday.ad,
        directYesterday: yesterday.total - yesterday.ad,
      },
      openDealsValue: row.openDealsValue,
      openDealsCount: row.openDealsCount,
    };
  },
});

// --- 1b. `metrics`: DEPRECATED compatibility shim -------------------------

/**
 * @deprecated Superseded by `snapshot` above. Delete once no deployed
 * client calls it.
 *
 * THIS EXISTS ONLY TO MAKE THE DEPLOY ORDER SAFE, and is otherwise dead
 * weight — 1,882 document reads and ~8s, measured, which is exactly what
 * `snapshot` was built to stop paying.
 *
 * The frontend and the backend of this app ship SEPARATELY: Netlify builds
 * the client from `main`, `convex deploy` pushes these functions. So there
 * is always a window where one side is newer than the other. Removing this
 * function outright made that window fatal in one direction — the moment
 * the backend deployed, every already-loaded client calling
 * `api.dashboard.metrics` would hit a function that no longer exists, and
 * the dashboard would stay broken until the frontend caught up.
 *
 * Kept BYTE-IDENTICAL to the pre-`snapshot` implementation rather than
 * re-expressed on top of the snapshot row. A shim's whole job is to behave
 * exactly like the thing it is standing in for; re-deriving it would make
 * old clients depend on a `dashboardSnapshots` row the cron may not have
 * written yet, turning a compatibility measure into a second failure mode.
 *
 * Removal is a one-line deletion plus its `MetricsBundle` type, once
 * `main` carries the new dashboard page and no cached client is still
 * asking for this.
 */
export const metrics = accountQuery({
  args: {
    todayStartMs: v.number(),
    yesterdayStartMs: v.number(),
  },
  handler: async (ctx, args) => {
    const { todayStartMs, yesterdayStartMs } = args;

    // Every "conversations" number below is a currently-open count or a
    // subset of it (see `loadMetrics`'s own comment: a current-state
    // count has no clean "vs yesterday" without snapshots, so the
    // "previous" shown is the delta of NEW open conversations
    // today-vs-yesterday, not yesterday's open count). All three are
    // derived from one collected array rather than three separate
    // scans. Ranged on `by_account_archived_status` — the `(accountId,
    // archivedAt, status)` index Task 2 added for exactly this. Still
    // unbounded in the number of OPEN, non-archived conversations, but
    // no longer in the number of closed or archived ones, which are the
    // halves that grow without limit.
    // The headline number is a COUNT, so it never needed the rows. Take
    // CAP + 1: every document in this index range is a match (the range
    // pins `archivedAt` and `status`, so there is no `.filter()` to
    // starve), which makes this a real read bound. The +1 is what
    // separates "exactly CAP" from "more than CAP" — reported as
    // `capped` so the UI can render "500+" rather than a confidently
    // wrong exact figure.
    const openSample = await ctx.db
      .query("conversations")
      .withIndex("by_account_archived_status", (q) =>
        q
          .eq("accountId", ctx.accountId)
          // Archived threads are not open work. `archivedAt` sits before
          // `status` in this index, so this stays a pure range: every
          // document read is still a match, which is what keeps the
          // `.take(CAP + 1)` below an honest read bound rather than a
          // filter that starves as archived rows accumulate.
          .eq("archivedAt", undefined)
          .eq("status", "open"),
      )
      .take(ACTIVE_CONVERSATIONS_CAP + 1);
    const openCapped = openSample.length > ACTIVE_CONVERSATIONS_CAP;
    const openCount = openCapped ? ACTIVE_CONVERSATIONS_CAP : openSample.length;

    // Today/yesterday can't come from that sample — it is truncated, and
    // truncated at the wrong end (the index orders by status then
    // `_creationTime`, so the newest conversations are exactly the ones a
    // `.take()` drops). Read them instead from the same bounded 2-day
    // `by_account` range that contacts and messages below already use, and
    // apply `status` (and `archivedAt`) in JS: the window is two days of
    // conversation creation, so it stays small no matter how large the
    // account grows — unlike the open-conversation sample above, this
    // range isn't bounded by pinning `status`/`archivedAt` in an index, so
    // filtering here doesn't risk starving a `.take()`.
    const recentConversations = await ctx.db
      .query("conversations")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", yesterdayStartMs),
      )
      .collect();
    const newOpenToday = recentConversations.filter(
      (c) =>
        c.status === "open" &&
        c.archivedAt === undefined &&
        c._creationTime >= todayStartMs,
    ).length;
    const newOpenYesterday = recentConversations.filter(
      (c) =>
        c.status === "open" &&
        c.archivedAt === undefined &&
        c._creationTime >= yesterdayStartMs &&
        c._creationTime < todayStartMs,
    ).length;

    // Contacts: bounded to a 2-day window (only ever need today's +
    // yesterday's counts), via a genuine index range scan
    // (`.gte("_creationTime", ...)` on the trailing implicit field of
    // `by_account`) rather than a full collect — both counts below are
    // derived from this one bounded read.
    const recentContacts = await ctx.db
      .query("contacts")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", yesterdayStartMs),
      )
      .collect();
    const newContactsTodayCount = recentContacts.filter(
      (c) => c._creationTime >= todayStartMs,
    ).length;
    const newContactsYesterdayCount = recentContacts.filter(
      (c) => c._creationTime < todayStartMs,
    ).length;

    // New-leads-by-source split — partitions the ALREADY-collected
    // `recentContacts` (no extra read) into Click-to-WhatsApp ad leads vs.
    // everything else ("direct"). `acquisitionSource` is set once, the first
    // time a contact arrives via an ad referral (see schema.ts), so its
    // presence is the ad-lead signal. Additive: older clients ignore this
    // field, newer clients degrade to "no split" if it's ever absent.
    const isAdLead = (c: (typeof recentContacts)[number]) =>
      c.acquisitionSource === "ad";
    const todayContacts = recentContacts.filter(
      (c) => c._creationTime >= todayStartMs,
    );
    const yesterdayContacts = recentContacts.filter(
      (c) => c._creationTime >= yesterdayStartMs && c._creationTime < todayStartMs,
    );
    const newLeadsBySource = {
      adToday: todayContacts.filter(isAdLead).length,
      directToday: todayContacts.filter((c) => !isAdLead(c)).length,
      adYesterday: yesterdayContacts.filter(isAdLead).length,
      directYesterday: yesterdayContacts.filter((c) => !isAdLead(c)).length,
    };

    // Deals: value-sum + count of every open deal, no time bound. Same
    // shape as `openConversations` above, and now the same fix — grows
    // with the account's OPEN deals rather than with every deal it has
    // ever closed. The sum needs the rows themselves, so this stays a
    // collect; only its range narrows.
    const openDeals = await ctx.db
      .query("deals")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", ctx.accountId).eq("status", "open"),
      )
      .collect();
    const openDealsValue = openDeals.reduce((sum, d) => sum + d.value, 0);

    // Messages: bounded to the same 2-day window as contacts above.
    // `messages` is the highest-volume table in the schema (see
    // schema.ts's own "this high-volume table" comment on its
    // `by_account` index) — bounding this to a 2-day range scan,
    // instead of collecting the account's entire message history and
    // filtering in JS, is the single biggest deliberate perf choice in
    // this file. Both today/yesterday agent-sent counts are derived
    // from this one bounded read.
    const recentMessages = await ctx.db
      .query("messages")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", yesterdayStartMs),
      )
      .collect();
    const messagesSentTodayCount = recentMessages.filter(
      (m) => m.senderType === "agent" && m._creationTime >= todayStartMs,
    ).length;
    const messagesSentYesterdayCount = recentMessages.filter(
      (m) => m.senderType === "agent" && m._creationTime < todayStartMs,
    ).length;

    return {
      activeConversations: {
        current: openCount,
        previous: newOpenToday - newOpenYesterday,
        // True when the real number exceeds `current`. The UI renders
        // "500+" rather than pretending 500 is exact.
        capped: openCapped,
      },
      newContactsToday: {
        current: newContactsTodayCount,
        previous: newContactsYesterdayCount,
      },
      newLeadsBySource,
      openDealsValue,
      openDealsCount: openDeals.length,
      messagesSentToday: {
        current: messagesSentTodayCount,
        previous: messagesSentYesterdayCount,
      },
    };
  },
});

// --- 2. Conversations over time ------------------------------------------

export const conversationsSeries = accountQuery({
  args: {
    sinceMs: v.number(),
    dayKeys: v.array(v.string()),
    tzOffsetMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    const { sinceMs, dayKeys, tzOffsetMinutes } = args;

    // Reads the hourly rollup, not raw messages. Collecting every message
    // in the window was bounded by the WINDOW but not by traffic: against
    // the 4096-read ceiling that broke at ~137 msg/day on the default
    // 30-day view and ~45 msg/day on the 90-day one. The rollup makes the
    // read a function of the window alone — 24 rows per day, ~2160 for 90
    // days — no matter how busy the account gets.
    //
    // `hourStartMs(sinceMs)` rather than `sinceMs`: the bucket containing
    // `sinceMs` starts before it, so ranging on the raw value would drop
    // the first partial hour. Extra hours at the edges are harmless —
    // `foldHoursIntoDays` discards anything outside `dayKeys`.
    const hours = await ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .gte("hourStartMs", hourStartMs(sinceMs)),
      )
      .collect();

    const buckets = foldHoursIntoDays(hours, dayKeys, tzOffsetMinutes);

    return dayKeys.map((day) => ({
      day,
      ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }),
    }));
  },
});

// --- 4. Response time by day of week -------------------------------------

export const responseTime = accountQuery({
  args: {
    sinceMs: v.number(),
    tzOffsetMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    const { sinceMs, tzOffsetMinutes } = args;

    // Reads the hourly rollup, not raw messages — the same move
    // `conversationsSeries` above already made, for the same reason, after
    // this one kept crashing /dashboard in production ("too many system
    // operations"). Collecting every message in the window was bounded by
    // the WINDOW but not by TRAFFIC, so the read grew with the account until
    // it exceeded Convex's per-transaction ceiling; the rollup makes it a
    // function of the window alone (24 rows per day, ~336 for 14 days) no
    // matter how busy the account gets.
    //
    // The customer-message/next-reply pairing that used to run here on every
    // page load now happens once per reply, on write, in
    // `messages.recordResponseSample`.
    //
    // `hourStartMs(sinceMs)` rather than `sinceMs` for the same reason as
    // `conversationsSeries`: the bucket containing `sinceMs` starts before
    // it, so ranging on the raw value would drop the first partial hour.
    const hours = await ctx.db
      .query("messageHourlyStats")
      .withIndex("by_account_hour", (q) =>
        q
          .eq("accountId", ctx.accountId)
          .gte("hourStartMs", hourStartMs(sinceMs)),
      )
      .collect();

    // "Now" is the same real-world instant on the server as on the
    // client (Date.now() is wall-clock, not local-clock) — only
    // *interpreting* it as a calendar day/week needs `tzOffsetMinutes`.
    const nowMs = Date.now();
    const nowMondayIndex = localMondayIndexFromMs(nowMs, tzOffsetMinutes);
    const thisWeekStartMs = localMidnightMsDaysAgo(
      nowMs,
      tzOffsetMinutes,
      nowMondayIndex,
    );
    const lastWeekStartMs = localMidnightMsDaysAgo(
      nowMs,
      tzOffsetMinutes,
      nowMondayIndex + 7,
    );

    // Per-day-of-week averages over both weeks' worth of data so each bar has
    // more samples to stand on; a day with none reports `avgMinutes: null`
    // and the chart renders that bar muted.
    return foldHoursIntoResponseBuckets(
      hours,
      tzOffsetMinutes,
      thisWeekStartMs,
      lastWeekStartMs,
    );
  },
});

// --- 5. Activity feed ------------------------------------------------------

export const activity = accountQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    // Per-row detail, unscoped and unmasked — supervisor+ only. See the
    // module header for why this one query differs from the aggregates.
    ctx.requireRole("supervisor");
    const { limit } = args;

    type Item = {
      id: string;
      kind: "message" | "deal" | "broadcast" | "automation" | "contact";
      text: string;
      atMs: number;
      href?: string;
    };
    const items: Item[] = [];

    // Customer-authored messages, newest 10. `senderType` is now part of
    // the index range (`by_account_sender`) rather than a post-scan
    // `.filter()`: the previous `by_account` + `.filter(senderType===
    // "customer").take(10)` walked every non-customer message newer than
    // the 10th customer one — a single broadcast fan-out of ≥4096 bot
    // messages was enough to blow Convex's read limit and take down every
    // dashboard load. Ranging the index to the customer partition reads
    // only customer rows, so the take is genuinely bounded to 10 reads.
    const recentCustomerMessages = await ctx.db
      .query("messages")
      .withIndex("by_account_sender", (q) =>
        q.eq("accountId", ctx.accountId).eq("senderType", "customer"),
      )
      .order("desc")
      .take(10);
    // Two parallel waves rather than a per-message `get` chain. The
    // conversation -> contact hop is genuinely dependent (the contact id
    // comes off the conversation), but nothing depends across messages,
    // so this is 2 round-trips instead of 2 per message.
    const messageConversations = await Promise.all(
      recentCustomerMessages.map((m) => ctx.db.get(m.conversationId)),
    );
    const messageContacts = await Promise.all(
      messageConversations.map((c) => (c ? ctx.db.get(c.contactId) : null)),
    );
    recentCustomerMessages.forEach((message, i) => {
      const contact = messageContacts[i];
      const who = contact?.name || contact?.phone || "Unknown";
      items.push({
        id: `msg-${message._id}`,
        kind: "message",
        text: `New message from ${who}`,
        atMs: message._creationTime,
        href: `/inbox?c=${message.conversationId}`,
      });
    });

    // Contacts, newest 10 — pure index-ordered take, no filter
    // predicate, so this one is genuinely bounded regardless of table
    // size.
    const recentContacts = await ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .take(10);
    for (const contact of recentContacts) {
      items.push({
        id: `contact-${contact._id}`,
        kind: "contact",
        text: `New contact: ${contact.name || contact.phone}`,
        atMs: contact._creationTime,
        href: "/contacts",
      });
    }

    // Deals, most-recently-*updated* 10 (any status — mirrors
    // `loadActivity` exactly, which does NOT filter to open deals the
    // way `loadMetrics`/`loadPipelineDonut` do). This was the one source
    // here that read every deal in the account; `by_account_updated` is
    // the `(accountId, updatedAt)` index the old comment said did not
    // exist, so it is now a bounded 10-row take like every other source.
    // Sorting by `updatedAt` rather than `_creationTime` is the whole
    // point — a deal opened long ago but just moved to "Won" must still
    // surface.
    //
    // THE ONE BEHAVIOUR CHANGE in this file: membership of the fetched
    // 10 is now Convex's index order, and Convex sorts a MISSING field
    // before every present value — so descending, a deal with no
    // `updatedAt` sorts last and falls out of the window, where the old
    // JS sort promoted it on its `_creationTime` fallback. Unreachable
    // through the app (every `deals` insert sets `updatedAt`), needs >10
    // deals to manifest at all, and pinned by its own test. The `??`
    // fallback below stays: it still decides where a fetched row ranks
    // in the final interleaved feed.
    const recentDeals = await ctx.db
      .query("deals")
      .withIndex("by_account_updated", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .take(10);
    // One wave for the stage lookups — nothing depends across deals.
    const dealStages = await Promise.all(
      recentDeals.map((deal) => ctx.db.get(deal.stageId)),
    );
    recentDeals.forEach((deal, i) => {
      const stage = dealStages[i];
      items.push({
        id: `deal-${deal._id}`,
        kind: "deal",
        text: stage?.name
          ? `Deal "${deal.title}" in ${stage.name}`
          : `Deal "${deal.title}" updated`,
        atMs: deal.updatedAt ?? deal._creationTime,
        href: "/pipelines",
      });
    });

    // Broadcasts, newest 5 — pure index-ordered take, bounded.
    const recentBroadcasts = await ctx.db
      .query("broadcasts")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .take(5);
    for (const broadcast of recentBroadcasts) {
      const label =
        broadcast.status === "sent"
          ? `sent to ${broadcast.totalRecipients} contacts`
          : `${broadcast.status} (${broadcast.totalRecipients} recipients)`;
      items.push({
        id: `broadcast-${broadcast._id}`,
        kind: "broadcast",
        text: `Broadcast "${broadcast.name}" ${label}`,
        atMs: broadcast._creationTime,
        href: "/broadcasts",
      });
    }

    // Automation logs, newest 10 — pure index-ordered take, no filter
    // predicate, bounded.
    const recentAutoLogs = await ctx.db
      .query("automationLogs")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .take(10);
    // One wave: unlike the message loop above, a log's automation and its
    // contact are independent of each other (both ids come off the log),
    // so neither dimension has to wait on the other.
    const [logAutomations, logContacts] = await Promise.all([
      Promise.all(recentAutoLogs.map((log) => ctx.db.get(log.automationId))),
      Promise.all(
        recentAutoLogs.map((log) =>
          log.contactId ? ctx.db.get(log.contactId) : null,
        ),
      ),
    ]);
    recentAutoLogs.forEach((log, i) => {
      const contact = logContacts[i];
      const who = contact?.name || contact?.phone || "a contact";
      const autoName = logAutomations[i]?.name || "Automation";
      items.push({
        id: `auto-${log._id}`,
        kind: "automation",
        text: `Automation "${autoName}" ${
          log.status === "failed" ? "failed for" : "triggered for"
        } ${who}`,
        atMs: log._creationTime,
      });
    });

    return items
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, limit)
      .map(({ atMs, ...rest }) => ({
        ...rest,
        at: new Date(atMs).toISOString(),
      }));
  },
});
