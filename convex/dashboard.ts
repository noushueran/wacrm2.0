import { accountQuery } from "./lib/auth";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  localDayKeyFromMs,
  localMidnightMsDaysAgo,
  localMondayIndexFromMs,
} from "./lib/dashboardDate";

// ============================================================
// Dashboard aggregations (Phase 3, Task 3) — read-only ports of
// `src/lib/dashboard/queries.ts`'s five client-side Supabase
// aggregations. Every function here is built on `accountQuery` (never
// the raw `query`), so `ctx.accountId` always comes from the caller's
// own `memberships` row, never a client-supplied argument — there is no
// `accountId` field in any args validator below. None of these call
// `ctx.requireRole`: reading your own account's dashboard is the
// lowest-privilege operation in the app, same treatment as
// `conversations.list`/`contacts.list` (no other read-only accountQuery
// in the codebase gates on role either).
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
// messages)". Several of these scans are genuinely unbounded by table
// size (not just by a time window) — each is called out with a comment
// at its call site, and summarized in the Phase 3 Task 3 report.
// ============================================================

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
    // scans. UNBOUNDED: this reads every currently-open conversation in
    // the account, with no time window — there's no `(accountId,
    // status)` index today to narrow it further (see report).
    const openConversations = await ctx.db
      .query("conversations")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .filter((q) => q.eq(q.field("status"), "open"))
      .collect();
    const newOpenToday = openConversations.filter(
      (c) => c._creationTime >= todayStartMs,
    ).length;
    const newOpenYesterday = openConversations.filter(
      (c) => c._creationTime >= yesterdayStartMs && c._creationTime < todayStartMs,
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

    // Deals: value-sum + count of every open deal, no time bound.
    // UNBOUNDED: same shape as `openConversations` above — grows with
    // total open deals in the account, not with a time window.
    const openDeals = await ctx.db
      .query("deals")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .filter((q) => q.eq(q.field("status"), "open"))
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
        current: openConversations.length,
        previous: newOpenToday - newOpenYesterday,
      },
      newContactsToday: {
        current: newContactsTodayCount,
        previous: newContactsYesterdayCount,
      },
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

    // Bounded by the requested time window via a genuine index range
    // scan (`.gte("_creationTime", sinceMs)`), same shape as `metrics`'s
    // `recentMessages` above — NOT bounded by row count within that
    // window, so a very chatty account's requested range still reads
    // every message sent in it (matches the original's own "pull every
    // message since `start` in one shot" strategy).
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_account", (q) =>
        q.eq("accountId", ctx.accountId).gte("_creationTime", sinceMs),
      )
      .collect();

    const buckets = new Map<string, { incoming: number; outgoing: number }>();
    for (const key of dayKeys) buckets.set(key, { incoming: 0, outgoing: 0 });

    for (const message of messages) {
      const key = localDayKeyFromMs(message._creationTime, tzOffsetMinutes);
      const bucket = buckets.get(key);
      if (!bucket) continue; // outside the caller's requested day-key range
      if (message.senderType === "customer") bucket.incoming += 1;
      else bucket.outgoing += 1; // agent + bot both count as outgoing
    }

    return dayKeys.map((day) => ({
      day,
      ...(buckets.get(day) ?? { incoming: 0, outgoing: 0 }),
    }));
  },
});

// --- 3. Pipeline donut ----------------------------------------------------

export const pipelineDonut = accountQuery({
  args: {},
  handler: async (ctx) => {
    // Structural data (few stages per account) — not a scale concern.
    const stages = await ctx.db
      .query("pipelineStages")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    stages.sort((a, b) => a.position - b.position);

    // UNBOUNDED: every open deal in the account, no time bound — same
    // shape/cost as `metrics`'s `openDeals` above (in fact the same
    // underlying rows; each caller re-reads independently since there's
    // no cross-request cache in Convex).
    const openDeals = await ctx.db
      .query("deals")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .filter((q) => q.eq(q.field("status"), "open"))
      .collect();

    const byStage = new Map<Id<"pipelineStages">, { count: number; total: number }>();
    for (const deal of openDeals) {
      const row = byStage.get(deal.stageId) ?? { count: 0, total: 0 };
      row.count += 1;
      row.total += deal.value;
      byStage.set(deal.stageId, row);
    }

    const slices = stages
      .map((stage) => ({
        id: stage._id,
        name: stage.name,
        color: stage.color || "#64748b",
        dealCount: byStage.get(stage._id)?.count ?? 0,
        totalValue: byStage.get(stage._id)?.total ?? 0,
      }))
      // Hide empty stages from the ring — mirrors `loadPipelineDonut`
      // exactly (its own comment: still shown in a legend if a full
      // breakdown were wanted, but trimmed here for the common case).
      .filter((s) => s.totalValue > 0 || s.dealCount > 0);

    return {
      stages: slices,
      totalValue: slices.reduce((sum, s) => sum + s.totalValue, 0),
    };
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
    const { limit } = args;

    type Item = {
      id: string;
      kind: "message" | "deal" | "broadcast" | "automation" | "contact";
      text: string;
      atMs: number;
      href?: string;
    };
    const items: Item[] = [];

    // Customer-authored messages, newest 10. `.take(10)` on an
    // index-ordered ("desc") scan is normally bounded regardless of
    // table size — but combined with the `senderType==="customer"`
    // `.filter()`, the WORST case (an account with few/no customer
    // messages among its most recent activity) still walks the full
    // `messages` `by_account` range looking for 10 matches. `messages`
    // is the highest-volume table in the schema, so this is worth
    // flagging even though the common case is cheap (see report).
    const recentCustomerMessages = await ctx.db
      .query("messages")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .order("desc")
      .filter((q) => q.eq(q.field("senderType"), "customer"))
      .take(10);
    for (const message of recentCustomerMessages) {
      const conversation = await ctx.db.get(message.conversationId);
      const contact = conversation
        ? await ctx.db.get(conversation.contactId)
        : null;
      const who = contact?.name || contact?.phone || "Unknown";
      items.push({
        id: `msg-${message._id}`,
        kind: "message",
        text: `New message from ${who}`,
        atMs: message._creationTime,
        href: `/inbox?c=${message.conversationId}`,
      });
    }

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
    // way `loadMetrics`/`loadPipelineDonut` do). UNBOUNDED, and unlike
    // every other source in this function, not fixable with `.take()`:
    // there is no `(accountId, updatedAt)` index (see schema.ts), and
    // sorting by `updatedAt` instead of `_creationTime` is the whole
    // point — a deal opened long ago but just moved to "Won" must still
    // surface here. So this reads every deal in the account. Flagged in
    // the report as the one call site that would most benefit from a
    // new index if deal volume grows (mirrors why `conversations` has
    // its own `by_account_last_message` index today).
    const allDeals = await ctx.db
      .query("deals")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    allDeals.sort(
      (a, b) => (b.updatedAt ?? b._creationTime) - (a.updatedAt ?? a._creationTime),
    );
    for (const deal of allDeals.slice(0, 10)) {
      const stage = await ctx.db.get(deal.stageId);
      items.push({
        id: `deal-${deal._id}`,
        kind: "deal",
        text: stage?.name
          ? `Deal "${deal.title}" in ${stage.name}`
          : `Deal "${deal.title}" updated`,
        atMs: deal.updatedAt ?? deal._creationTime,
        href: "/pipelines",
      });
    }

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
    for (const log of recentAutoLogs) {
      const automation = await ctx.db.get(log.automationId);
      const contact = log.contactId ? await ctx.db.get(log.contactId) : null;
      const who = contact?.name || contact?.phone || "a contact";
      const autoName = automation?.name || "Automation";
      items.push({
        id: `auto-${log._id}`,
        kind: "automation",
        text: `Automation "${autoName}" ${
          log.status === "failed" ? "failed for" : "triggered for"
        } ${who}`,
        atMs: log._creationTime,
      });
    }

    return items
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, limit)
      .map(({ atMs, ...rest }) => ({
        ...rest,
        at: new Date(atMs).toISOString(),
      }));
  },
});
