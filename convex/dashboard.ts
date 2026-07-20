import { accountQuery } from "./lib/auth";
import { v } from "convex/values";
import { hourStartMs, foldHoursIntoDays } from "./lib/messageStats";
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
// `metrics`/`conversationsSeries` take already-computed boundary
// timestamps (the "preferred" shape per the task brief). `responseTime`
// additionally needs to bucket individual samples by local
// day-of-week, which can't be reduced to a couple of scalar cutoffs, so
// it (like `conversationsSeries`) also takes a `tzOffsetMinutes` arg —
// see `convex/lib/dashboardDate.ts`'s header comment for the exact
// convention (matches `Date.prototype.getTimezoneOffset()`).
//
// Every table read below is a `by_account`-scoped scan (there is no
// account-scoped table this file touches that lacks one), matching how
// `src/lib/dashboard/queries.ts`'s own header comment describes the
// original: "Perf is acceptable for the current scale (low thousands of
// messages)".
//
// Every read here is now bounded by something that does not grow
// forever — a time window (`contacts`, `messages`, and the
// today-vs-yesterday conversation deltas), a fixed take (`activity`'s
// sources, and `metrics`'s open-conversation count), or a status range.
//
// The claim that a status range bounds the open-conversation count was
// wrong in practice: nothing in the app auto-closes a conversation — the
// only writers of `status: "closed"` are an optional automation action
// and a manual per-thread control — so the "open" partition asymptotically
// equals the whole table. That count is now a `.take()` instead, which is
// a genuine read bound because the range pins `status` and every document
// read is therefore a match.
//
// `metrics`'s open DEALS collect is knowingly left as-is. It needs the
// rows (it sums `value`, and a silently truncated sum is worse than a
// truncated count), and unlike conversations the open-deal set really is
// bounded in practice — the pipeline closes deals won/lost, so it tracks
// active pipeline size rather than accumulating forever.
// ============================================================

/**
 * Ceiling on the open-conversation count reported by `metrics`.
 *
 * Chosen to be far above any number a human reads as a precise figure —
 * past a few hundred the card communicates "a lot", not a quantity — while
 * keeping the read cost fixed regardless of account size. Exported so the
 * test suite asserts against the real bound rather than a copy of it.
 */
export const ACTIVE_CONVERSATIONS_CAP = 500;

// --- 1. Metric cards ----------------------------------------------------

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
    // scans. Ranged on `by_account_status` — the `(accountId, status)`
    // index this comment used to say did not exist. Still unbounded in
    // the number of OPEN conversations, but no longer in the number of
    // closed ones, which is the half that grows without limit.
    // The headline number is a COUNT, so it never needed the rows. Take
    // CAP + 1: every document in this index range is a match (the range
    // pins `status`, so there is no `.filter()` to starve), which makes
    // this a real read bound. The +1 is what separates "exactly CAP" from
    // "more than CAP" — reported as `capped` so the UI can render "500+"
    // rather than a confidently wrong exact figure.
    const openSample = await ctx.db
      .query("conversations")
      .withIndex("by_account_status", (q) =>
        q.eq("accountId", ctx.accountId).eq("status", "open"),
      )
      .take(ACTIVE_CONVERSATIONS_CAP + 1);
    const openCapped = openSample.length > ACTIVE_CONVERSATIONS_CAP;
    const openCount = openCapped ? ACTIVE_CONVERSATIONS_CAP : openSample.length;

    // Today/yesterday can't come from that sample — it is truncated, and
    // truncated at the wrong end (the index orders by status then
    // `_creationTime`, so the newest conversations are exactly the ones a
    // `.take()` drops). Read them instead from the same bounded 2-day
    // `by_account` range that contacts and messages below already use, and
    // apply `status` in JS: the window is two days of conversation
    // creation, so it stays small no matter how large the account grows.
    const recentConversations = await ctx.db
      .query("conversations")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", yesterdayStartMs),
      )
      .collect();
    const newOpenToday = recentConversations.filter(
      (c) => c.status === "open" && c._creationTime >= todayStartMs,
    ).length;
    const newOpenYesterday = recentConversations.filter(
      (c) =>
        c.status === "open" &&
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

    // Bounded by the (typically 14-day) requested window via a genuine
    // index range scan, same shape as `conversationsSeries` above — not
    // bounded by row count within that window.
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", sinceMs),
      )
      .collect();

    // Replicates the SQL's dual `.order('conversation_id').order(
    // 'created_at')` — the pairing loop below depends on rows being
    // grouped by conversation, then chronological within each group.
    rows.sort((a, b) => {
      if (a.conversationId !== b.conversationId) {
        return a.conversationId < b.conversationId ? -1 : 1;
      }
      return a._creationTime - b._creationTime;
    });

    // Group per conversation, pair unreplied customer messages with the
    // next outbound (agent or bot) message. A single customer message
    // can only count once (mirrors `loadResponseTime` exactly — avoids
    // inflating averages if the customer double-messages while the
    // agent takes time to reply).
    interface Sample {
      customerAtMs: number;
      responseAtMs: number;
    }
    const samples: Sample[] = [];

    let currentConv = "";
    let pendingCustomer: number | null = null;
    for (const row of rows) {
      if (row.conversationId !== currentConv) {
        currentConv = row.conversationId;
        pendingCustomer = null;
      }
      if (row.senderType === "customer") {
        if (pendingCustomer === null) pendingCustomer = row._creationTime;
      } else if (pendingCustomer !== null) {
        samples.push({
          customerAtMs: pendingCustomer,
          responseAtMs: row._creationTime,
        });
        pendingCustomer = null;
      }
    }

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

    // Per-day-of-week buckets, averaged over both weeks' worth of data
    // so each bar has more samples to stand on. If a day has no samples
    // its avgMinutes stays null (chart renders the bar muted).
    const byDow = new Map<number, number[]>();
    for (let i = 0; i < 7; i++) byDow.set(i, []);
    const thisWeekMins: number[] = [];
    const lastWeekMins: number[] = [];

    for (const s of samples) {
      const diffMin = (s.responseAtMs - s.customerAtMs) / 60_000;
      if (diffMin < 0) continue;
      const dow = localMondayIndexFromMs(s.customerAtMs, tzOffsetMinutes);
      byDow.get(dow)!.push(diffMin);
      if (s.customerAtMs >= thisWeekStartMs) {
        thisWeekMins.push(diffMin);
      } else if (
        s.customerAtMs >= lastWeekStartMs &&
        s.customerAtMs < thisWeekStartMs
      ) {
        lastWeekMins.push(diffMin);
      }
    }

    const avg = (arr: number[]) =>
      arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;

    const buckets = Array.from({ length: 7 }, (_, dow) => {
      const samplesForDow = byDow.get(dow) ?? [];
      return {
        dow,
        avgMinutes: avg(samplesForDow),
        samples: samplesForDow.length,
      };
    });

    return {
      buckets,
      thisWeekAvg: avg(thisWeekMins),
      lastWeekAvg: avg(lastWeekMins),
    };
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
