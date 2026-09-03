// ============================================================
// Meta dataset event counts — the third column of Reports → Events
// (docs/superpowers/specs/2026-09-03-reports-events-tab-design.md).
//
// Read-only with respect to the delivery path: nothing here changes what
// we send to Meta. It records what Meta says it received.
// ============================================================

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { decrypt } from "./lib/whatsappEncryption";
import { datasetDayStartMs, dayKeyStartMs } from "./lib/metaEventStats";
import { localDayKeyFromMs } from "./lib/dashboardDate";
import { DAY_MS } from "./lib/reportStats";

/**
 * Replace one day's counts for one dataset.
 *
 * UPSERT, NOT INSERT, and that is the correctness property rather than an
 * optimization: Meta's counts settle after the fact, so the cron re-syncs
 * a trailing window every night. An insert would double yesterday's
 * numbers on the second pass, and the resulting delta would read as
 * duplicate delivery — a bug in the delivery path that does not exist.
 *
 * An event absent from `counts` has its row deleted rather than left
 * behind: a stale row from a previous sync is a number Meta no longer
 * reports, and keeping it is the same lie as double-counting.
 */
export const upsertDayCounts = internalMutation({
  args: {
    accountId: v.id("accounts"),
    datasetId: v.string(),
    dayKey: v.string(),
    counts: v.record(v.string(), v.number()),
  },
  handler: async (ctx, args) => {
    const syncedAt = Date.now();
    const existing = await ctx.db
      .query("metaEventDailyStats")
      .withIndex("by_account_dataset_day_event", (q) =>
        q
          .eq("accountId", args.accountId)
          .eq("datasetId", args.datasetId)
          .eq("dayKey", args.dayKey),
      )
      .collect();
    const seen = new Set<string>();

    for (const [eventName, count] of Object.entries(args.counts)) {
      seen.add(eventName);
      const row = existing.find((r) => r.eventName === eventName);
      if (row) {
        await ctx.db.patch(row._id, { count, syncedAt });
      } else {
        await ctx.db.insert("metaEventDailyStats", {
          accountId: args.accountId,
          datasetId: args.datasetId,
          dayKey: args.dayKey,
          eventName,
          count,
          syncedAt,
        });
      }
    }
    for (const row of existing) {
      if (!seen.has(row.eventName)) await ctx.db.delete(row._id);
    }
  },
});

/**
 * One sync-state row per account, patched in place.
 *
 * A failed sync must NOT clear `tzOffsetMinutes`: already-synced days were
 * written under that offset, and losing it makes the stored history
 * unreadable. Only the fields supplied are written.
 */
export const putSyncState = internalMutation({
  args: {
    accountId: v.id("accounts"),
    datasetId: v.string(),
    available: v.boolean(),
    tzName: v.optional(v.string()),
    tzOffsetMinutes: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    coveredSinceDayKey: v.optional(v.string()),
    coveredUntilDayKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { accountId, ...rest } = args;
    const existing = await ctx.db
      .query("metaDatasetSyncState")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .unique();
    if (!existing) {
      await ctx.db.insert("metaDatasetSyncState", {
        accountId,
        ...rest,
        // Same rule as the patch branch below: a success never persists a
        // stale `lastError`, even on a first-ever sync (Task 2 review).
        lastError: rest.available ? undefined : rest.lastError,
      });
      return;
    }
    const patch: Record<string, unknown> = {
      datasetId: rest.datasetId,
      available: rest.available,
      // Cleared on success so a fixed problem stops being reported.
      lastError: rest.available ? undefined : rest.lastError,
    };
    if (rest.tzName !== undefined) patch.tzName = rest.tzName;
    if (rest.tzOffsetMinutes !== undefined) {
      patch.tzOffsetMinutes = rest.tzOffsetMinutes;
    }
    if (rest.lastSyncedAt !== undefined) patch.lastSyncedAt = rest.lastSyncedAt;
    // Same rule as `tzOffsetMinutes`, for the same reason: a FAILED sync
    // supplies neither of these, and must leave the last known coverage
    // exactly as it was. Clearing them would turn every already-covered
    // window unknown the moment one nightly run failed; widening them on
    // a failure would be far worse — it would claim days no read ever
    // reached, which is the zero this feature exists to prevent.
    if (rest.coveredSinceDayKey !== undefined) {
      patch.coveredSinceDayKey = rest.coveredSinceDayKey;
    }
    if (rest.coveredUntilDayKey !== undefined) {
      patch.coveredUntilDayKey = rest.coveredUntilDayKey;
    }
    await ctx.db.patch(existing._id, patch);
  },
});

export const getSyncState = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) =>
    await ctx.db
      .query("metaDatasetSyncState")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .unique(),
});

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";

/**
 * Ask the configured dataset for per-event counts and return whatever
 * Meta says, verbatim.
 *
 * This exists because the read-back endpoint is UNVERIFIED — Events
 * Manager may be the only surface for these numbers. One
 * `npx convex run metaEventStats:capiStatsProbe '{"accountId":"..."}'`
 * settles it against the real dataset and the real token, which is not
 * something a unit test can do.
 *
 * Diagnostic only. Writes nothing, and is never called by the cron.
 */
/**
 * Strip `access_token=` values from anywhere in a value before it is
 * returned to a terminal.
 *
 * Applies to the whole response, not just the URL we built. Meta hands
 * back `paging.next` as a complete follow-up URL with a live token in it,
 * so a probe that redacted only its own request URL still published the
 * credential — and this probe's output is meant to be pasted into issues.
 *
 * Round-trips through JSON so nested occurrences at any depth are covered;
 * a value that will not serialize is returned unchanged rather than
 * throwing, since a diagnostic must not fail on the shape of what it is
 * diagnosing.
 */
export function redactTokens<T>(value: T): T {
  try {
    return JSON.parse(
      JSON.stringify(value).replace(
        /access_token=[^&"\\\s]*/g,
        "access_token=REDACTED",
      ),
    ) as T;
  } catch {
    return value;
  }
}

export const capiStatsProbe = internalAction({
  args: {
    accountId: v.id("accounts"),
    /** Graph `aggregation` for the /stats edge. `event` returns nothing for
     *  this WABA dataset even across a window Events Manager shows events
     *  in, so the right value is still unknown — hence a parameter. */
    aggregation: v.optional(v.string()),
    /** Window size. The default 7 covers the range Events Manager was read
     *  against; widen it when checking whether a shape returns anything at
     *  all. */
    days: v.optional(v.number()),
    /** When set, reads the dataset OBJECT (`GET /{id}?fields=...`) instead
     *  of the /stats edge. This is how to find where `timezone_name`
     *  actually lives — the /stats response does not carry it, which is
     *  what currently degrades the Recorded column. */
    fields: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    url?: string;
    httpStatus?: number;
    body?: unknown;
    error?: string;
  }> => {
    const datasetId = process.env.META_CAPI_DATASET_ID;
    if (!datasetId) return { error: "META_CAPI_DATASET_ID unset" };
    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId: args.accountId,
    });
    if (!config?.wabaId) return { error: "no wabaId" };
    const token =
      process.env.META_CAPI_ACCESS_TOKEN ?? (await decrypt(config.accessToken));

    const base = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(datasetId)}`;
    let url: string;
    if (args.fields) {
      // Object read: no window, no aggregation — just the named fields.
      url =
        `${base}?fields=${encodeURIComponent(args.fields)}` +
        `&access_token=${encodeURIComponent(token)}`;
    } else {
      const until = Math.floor(Date.now() / 1000);
      const since = until - (args.days ?? 7) * 24 * 60 * 60;
      url =
        `${base}/stats` +
        `?aggregation=${encodeURIComponent(args.aggregation ?? "event")}` +
        `&start_time=${since}&end_time=${until}` +
        `&access_token=${encodeURIComponent(token)}`;
    }

    try {
      const res = await fetch(url);
      return {
        // Token stripped: this value is read off a terminal and pasted
        // into issues.
        url: redactTokens(url),
        httpStatus: res.status,
        // The BODY needs redacting too, not just the request URL. Meta's
        // `paging.next` is a fully-formed follow-up URL carrying a live
        // `access_token=` in plaintext — so echoing the response verbatim
        // published the credential into terminal scrollback and into any
        // issue this output was pasted into, which is exactly what this
        // probe exists to be used for.
        body: redactTokens(await res.json().catch(() => ({}))),
      };
    } catch (err) {
      return { error: redactTokens(err instanceof Error ? err.message : String(err)) };
    }
  },
});

/** A dataset day key exactly as `datasetDayKeys` builds it. Meta's rows
 *  are matched against those keys on read, so a date in any other
 *  encoding is unusable — see the rejection in the parse loop. */
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** How many trailing days to re-sync each run. Meta's counts settle after
 *  the fact, so the most recent days are re-read rather than trusted from
 *  their first sync. Cheap: one request covers the whole span.
 *
 *  This is the INCREMENTAL window only. It is not how far back the stored
 *  history goes — see `INITIAL_SYNC_DAYS`, which exists because a store
 *  three days deep behind a picker offering ninety is what made every
 *  range render a false negative delta. */
const DEFAULT_TRAILING_DAYS = 3;

/** How far back the FIRST sync for a dataset reaches: the widest range
 *  the Reports picker offers (`RANGE_OPTIONS` in
 *  `src/lib/reports/types.ts` — 7 / 30 / 90, defaulting to 30). Anything
 *  narrower leaves the default tab permanently uncovered, and an
 *  uncovered window degrades to unknown rather than showing numbers. */
const INITIAL_SYNC_DAYS = 90;

/** Floor on how far back a request may start, measured from the anchor —
 *  gap-closing runs included. NOT quite a ceiling on the request's span:
 *  on a first run the anchor itself carries a day of slack (no dataset
 *  offset is known yet), so the request can span ~91-92 days. Also the
 *  ceiling on how far a hole can be reached back into: after a longer
 *  outage than this the older coverage is dropped rather than claimed
 *  across a hole — see the contiguity note in `syncDatasetStats`. */
const MAX_SYNC_DAYS = 90;

/** Minutes to subtract from a UTC instant to reach local time in `tzName`,
 *  in this codebase's convention (`localDayKeyFromMs`): UTC+4 → -240.
 *  Returns null for a name the runtime cannot resolve — the caller then
 *  degrades rather than guessing.
 *
 *  DST LIMITATION, stated plainly because the file header's "fetched,
 *  never assumed" claim covers the ZONE and not the offset: this resolves
 *  ONE offset, at `at`, and `metaEventReconciliation` then applies that
 *  single stored number across a window up to 90 days wide. A dataset in
 *  a DST-observing zone would therefore have the days either side of a
 *  transition bucketed an hour off, moving a sliver of counts across one
 *  day boundary. No impact on this deployment — the dataset's zone is
 *  Asia/Dubai, which has never observed DST — and fixing it properly
 *  means storing the zone NAME and re-resolving per day at read time,
 *  which `convex/lib/dashboardDate.ts` deliberately does not do either
 *  (see its header's identical admission). Named here so nobody reads
 *  the header and concludes the offset is exact for every zone. */
function offsetMinutesFor(tzName: string, at: number): number | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tzName,
      timeZoneName: "longOffset",
    });
    const part = fmt
      .formatToParts(new Date(at))
      .find((p) => p.type === "timeZoneName")?.value;
    // "GMT+04:00" | "GMT-05:30" | "GMT"
    const m = part?.match(/GMT([+-])(\d{2}):(\d{2})/);
    if (!m) return part === "GMT" ? 0 : null;
    const minutes = Number(m[2]) * 60 + Number(m[3]);
    return m[1] === "+" ? -minutes : minutes;
  } catch {
    return null;
  }
}

/**
 * Pull the dataset's per-event daily counts and store them.
 *
 * EVERY failure path records `available: false` with the reason and writes
 * NO counts. Recording an empty result as "Meta had zero events" is the
 * one outcome that would make this feature actively harmful: the Events
 * tab would show a full-height delta and blame the delivery path for an
 * outage on the reporting path.
 *
 * WHAT IT ASKS FOR, AND WHAT IT THEN CLAIMS. The request spans whole
 * dataset-local days: `INITIAL_SYNC_DAYS` back on a first run (the widest
 * range the Reports picker offers), and thereafter from the existing
 * `coveredUntilDayKey` — or `DEFAULT_TRAILING_DAYS` back, whichever is
 * earlier — so a run after a run of failures closes the hole. On success
 * it records the day-key bounds it actually read. Those bounds are not
 * bookkeeping: without them the read side sums the days it happens to
 * hold and renders "never synced that day" as the number zero.
 *
 * The parser below targets `{ timezone_name, data: [{date, event, count}] }`.
 * That shape is a HYPOTHESIS until `capiStatsProbe` is run against the live
 * dataset — see Task 3. If Meta answers differently, change only the
 * `payload` type and the `byDay` loop below (and their tests); nothing
 * else in the file depends on the wire shape.
 */
export const syncDatasetStats = internalAction({
  args: {
    accountId: v.id("accounts"),
    trailingDays: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<void> => {
    const datasetId = process.env.META_CAPI_DATASET_ID;
    if (!datasetId) {
      await ctx.runMutation(internal.metaEventStats.putSyncState, {
        accountId: args.accountId,
        datasetId: "",
        available: false,
        lastError: "META_CAPI_DATASET_ID unset",
      });
      return;
    }

    const fail = async (lastError: string) => {
      await ctx.runMutation(internal.metaEventStats.putSyncState, {
        accountId: args.accountId,
        datasetId,
        available: false,
        lastError: lastError.slice(0, 300),
      });
    };

    const state = await ctx.runQuery(internal.metaEventStats.getSyncState, {
      accountId: args.accountId,
    });
    const config = await ctx.runQuery(internal.whatsappConfig.getForAccount, {
      accountId: args.accountId,
    });
    if (!config?.wabaId) return await fail("no wabaId configured for account");
    let token: string | undefined;
    try {
      token =
        process.env.META_CAPI_ACCESS_TOKEN ?? (await decrypt(config.accessToken));
    } catch (err) {
      // `decrypt` THROWS (never returns null/empty) on a corrupted
      // ciphertext or an encryption-key mismatch — e.g. after a key
      // rotation. Uncaught, that would skip `putSyncState` entirely and
      // leave the sync state stale (possibly still `available: true`)
      // instead of degrading to `available: false` with a reason.
      return await fail(
        `token decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!token) return await fail("no CAPI token — WhatsApp not connected");

    // Coverage and the stored offset are properties of the dataset they
    // were recorded against, so a dataset switch starts over rather than
    // inheriting another dataset's day bounds.
    const prior = state?.datasetId === datasetId ? state : null;
    const knownOffset = prior?.tzOffsetMinutes;

    const now = Date.now();
    // WHOLE DAYS, NOT A TIME-OF-DAY. The requested start is aligned to a
    // dataset-local midnight. Computed from `Date.now()` alone (as it
    // was), the run on day X+3 asks Meta for day X from mid-afternoon
    // onward; if Meta honours a sub-day `start_time` that returns a
    // PARTIAL count for day X, and `upsertDayCounts` patches it over the
    // complete count an earlier run wrote. Last writer wins and the last
    // writer is always the partial one. Over-requesting costs nothing —
    // `upsertDayCounts` is idempotent — while under-requesting silently
    // corrupts a day, so every rounding here goes outward.
    //
    // On the first-ever run no offset is known yet: fall back to a
    // floored UTC midnight minus one day of slack. Every zone's offset is
    // under 24h, so that instant is always at or before the dataset-local
    // midnight that starts the current local day.
    const anchorMs =
      knownOffset === undefined || knownOffset === null
        ? Math.floor(now / DAY_MS) * DAY_MS - DAY_MS
        : datasetDayStartMs(now, knownOffset);

    const trailingDays = Math.max(
      0,
      Math.trunc(args.trailingDays ?? DEFAULT_TRAILING_DAYS),
    );
    const coveredUntilMs =
      prior?.coveredUntilDayKey && knownOffset !== undefined
        ? dayKeyStartMs(prior.coveredUntilDayKey, knownOffset)
        : null;
    // GAP-CLOSING, AND CONTIGUOUS BY CONSTRUCTION — the invariant the
    // read side depends on. The window always begins at or before the
    // existing `coveredUntilDayKey`, so the range this run adds cannot
    // fail to touch the range already claimed, and the union is a range
    // with no holes. A run after a week of failed nights therefore closes
    // the hole instead of leaving one, while a routine run still re-reads
    // only the settling days. With no coverage yet, reach back the full
    // `INITIAL_SYNC_DAYS`.
    const requestedSinceMs = Math.max(
      anchorMs - MAX_SYNC_DAYS * DAY_MS,
      coveredUntilMs !== null
        ? Math.min(coveredUntilMs, anchorMs - trailingDays * DAY_MS)
        : anchorMs - INITIAL_SYNC_DAYS * DAY_MS,
    );

    const until = Math.floor(now / 1000);
    const since = Math.floor(requestedSinceMs / 1000);
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(datasetId)}/stats` +
      `?aggregation=event&start_time=${since}&end_time=${until}` +
      `&access_token=${encodeURIComponent(token)}`;

    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      return await fail(
        `network: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return await fail(`Graph ${res.status}: ${text.slice(0, 200)}`);
    }

    const payload = (await res.json().catch(() => null)) as {
      timezone_name?: string;
      data?: { date?: string; event?: string; count?: number }[];
      paging?: { next?: string };
    } | null;
    if (!payload) return await fail("Graph returned unparseable JSON");

    const tzName = payload.timezone_name;
    const tzOffsetMinutes = tzName ? offsetMinutesFor(tzName, Date.now()) : null;
    if (tzOffsetMinutes === null) {
      // Deliberate: an assumed offset misaligns all three columns and the
      // resulting delta is indistinguishable from a delivery failure.
      //
      // The two cases read differently ON PURPOSE, because only one of them
      // is something anybody can act on.
      //
      // ABSENT is the known permanent state, settled against the live
      // dataset on 2026-09-03 (see the spec's "Unverified dependency —
      // RESOLVED" section): `/stats` is a web-pixel edge that a
      // business-messaging dataset does not populate, and it carries no
      // `timezone_name` because it carries nothing. Reporting that as
      // "timezone could not be determined" was accurate about the proximate
      // cause and misleading as a standing message — it sends a reader
      // hunting for a timezone setting that does not exist anywhere.
      //
      // PRESENT-but-unparseable is a real, actionable timezone problem: Meta
      // named a zone this runtime cannot resolve. Keep that message.
      return await fail(
        tzName
          ? `dataset timezone could not be determined (timezone_name=${tzName})`
          : "the dataset does not expose per-event counts (its /stats " +
            "response carries no timezone_name and no event rows). " +
            "Events Manager is the only source for these.",
      );
    }

    const byDay = new Map<string, Record<string, number>>();
    const rows = payload.data ?? [];
    let rejected = 0;
    let firstRejected: unknown = null;
    for (const row of rows) {
      // `row.date` is VALIDATED, not merely present. A date Meta encodes
      // some other way ("2026-09-02T00:00:00+0400", a unix integer) would
      // otherwise be stored verbatim as a `dayKey` that `datasetDayKeys`
      // can never generate — the read then matches nothing and every
      // `recorded` comes back 0, forever, with `available: true` behind
      // it. A row that fails this is REJECTED, not skipped.
      if (
        !row.date ||
        !DAY_KEY_RE.test(row.date) ||
        !row.event ||
        typeof row.count !== "number"
      ) {
        rejected += 1;
        if (firstRejected === null) firstRejected = row;
        continue;
      }
      const day = byDay.get(row.date) ?? {};
      day[row.event] = (day[row.event] ?? 0) + row.count;
      byDay.set(row.date, day);
    }

    // Non-empty in, nothing understood out: we did not read the dataset,
    // whatever the HTTP status said. Recording that as a success is the
    // single most harmful thing this action can do — the tab would then
    // allege a total delivery failure on the strength of a response we
    // could not parse.
    //
    // Conditioned on `rows.length > 0` deliberately. A genuinely empty
    // `data: []` is a SUCCESSFUL read of a dataset that holds nothing in
    // the window, and it must stay `available: true`. "Meta has none" and
    // "we cannot read Meta" are the two claims this whole feature exists
    // to keep apart.
    if (rows.length > 0 && rejected === rows.length) {
      // The sample is what makes the failure actionable — nobody can fix
      // a shape mismatch they cannot see. Safe to log: these rows are
      // aggregate counts, with no tokens and no per-person data.
      return await fail(
        `Graph response shape not recognised: all ${rows.length} row(s) rejected. ` +
          `Sample: ${JSON.stringify(firstRejected).slice(0, 160)}`,
      );
    }

    for (const [dayKey, counts] of byDay) {
      await ctx.runMutation(internal.metaEventStats.upsertDayCounts, {
        accountId: args.accountId,
        datasetId,
        dayKey,
        counts,
      });
    }

    // What this run can HONESTLY claim, resolved with the offset Meta
    // just told us rather than the one we aligned with. A day counts as
    // covered only if the request reached its very start, so a start
    // landing inside a day claims the NEXT one — the conservative
    // direction, since claiming a partially-read day is how a partial
    // count becomes an alleged delivery gap.
    const sinceDayStart = datasetDayStartMs(requestedSinceMs, tzOffsetMinutes);
    const requestedSinceDayKey = localDayKeyFromMs(
      sinceDayStart === requestedSinceMs ? sinceDayStart : sinceDayStart + DAY_MS,
      tzOffsetMinutes,
    );
    // The last day the dataset has FINISHED — yesterday, at any time of
    // day. `end_time` is `now`, a time-of-day, so today has been read only
    // up to this instant. Claiming it would be the same partial-read the
    // start bound above is rounded outward to avoid, and worse in effect:
    // `metaEventReconciliation` would fold a stale, still-settling count
    // for today against a live `reached`/`delivered` and render the
    // difference as a plain number with no degraded marker.
    //
    // Today's counts are still STORED when Meta returns them — they are
    // real, and the trailing re-read settles them. They are simply not
    // CLAIMED as covered, and the query reconciles complete days only.
    const lastCompleteDayKey = localDayKeyFromMs(
      datasetDayStartMs(now, tzOffsetMinutes) - 1,
      tzOffsetMinutes,
    );

    // Widen: coveredSince = min(existing, requested), coveredUntil =
    // today. String comparison on `YYYY-MM-DD` IS chronological
    // comparison — fixed-width, zero-padded, most-significant-first — so
    // do not "fix" this into Date parsing.
    //
    // The one case where the existing claim is DROPPED rather than
    // widened: if this window starts after the old `coveredUntilDayKey`,
    // the two ranges do not touch and their union would have a hole in
    // it. That can only happen when `MAX_SYNC_DAYS` clips a gap longer
    // than it can close (an outage over 90 days). A narrower honest range
    // beats a wider one with a hole, because a hole reads as zeros.
    const priorSince = prior?.coveredSinceDayKey;
    const priorUntil = prior?.coveredUntilDayKey;
    const contiguous =
      priorSince !== undefined &&
      priorUntil !== undefined &&
      requestedSinceDayKey <= priorUntil;
    const coveredSinceDayKey =
      contiguous && priorSince < requestedSinceDayKey
        ? priorSince
        : requestedSinceDayKey;

    // A window containing no complete day claims nothing rather than
    // writing an inverted range. Only reachable via an explicit
    // `trailingDays: 0`, since the anchor is today's own local midnight;
    // the prior claim is then left exactly as it was.
    const claimsACompleteDay = requestedSinceDayKey <= lastCompleteDayKey;

    // PAGINATION: gate the CLAIM, not the read. `paging.next` is Meta's
    // own statement that rows exist which this response did not carry —
    // unlike a bare `paging.cursors`, which Graph returns on complete
    // responses too, and which is why failing on the presence of any
    // `paging` field would break a working endpoint.
    //
    // The rows that did arrive are real, so they are stored. What must
    // not happen is claiming the whole requested window as read when we
    // read one page of it: that is the false-zero defect by another
    // route, and a silent one — page 1 stored, ninety days claimed. The
    // asymmetry is deliberate. If this hypothesis about `next` is wrong,
    // the worst case is a tab that reads "unknown", which is visible and
    // diagnosable; the worst case the other way is confident wrong
    // numbers.
    const truncatedByPaging = Boolean(payload.paging?.next);
    const claimCoverage = claimsACompleteDay && !truncatedByPaging;

    await ctx.runMutation(internal.metaEventStats.putSyncState, {
      accountId: args.accountId,
      datasetId,
      available: true,
      tzName,
      tzOffsetMinutes,
      lastSyncedAt: Date.now(),
      ...(claimCoverage
        ? { coveredSinceDayKey, coveredUntilDayKey: lastCompleteDayKey }
        : {}),
    });
  },
});

export const listAccountIds = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("accounts").collect()).map((a) => a._id),
});

/**
 * Cron entry point: sync every account.
 *
 * Sequential, and errors are swallowed PER ACCOUNT rather than thrown.
 * One account with a revoked token must not stop the sync for the rest —
 * and it does not go unnoticed either, because `syncDatasetStats` has
 * already recorded that account's failure in its own sync state, which is
 * what the Events tab reads.
 */
export const syncAllAccounts = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const accountIds = await ctx.runQuery(
      internal.metaEventStats.listAccountIds,
      {},
    );
    for (const accountId of accountIds) {
      try {
        await ctx.runAction(internal.metaEventStats.syncDatasetStats, {
          accountId,
        });
      } catch {
        // Already recorded per-account by syncDatasetStats' own fail path.
      }
    }
  },
});
