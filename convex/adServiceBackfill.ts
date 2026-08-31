import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  customerMessagesSince,
  referralAnchorTime,
} from "./adServiceTagging";
import { matchService, type MatchSignals, type ServiceCandidate } from "./lib/ads/serviceMatch";
import { landingUrlKey } from "./lib/ai/adContext";
import { tagContactForService } from "./qualificationEngine";

// ============================================================
// One-shot backfill for the `adReferrals` backlog that predates ad→service
// tagging (spec: docs/superpowers/specs/
// 2026-07-31-ad-service-tag-backfill-design.md). `convex/adServiceTagging.ts`
// only ever runs on NEW clicks, scheduled from `ingest.processInbound` at
// the moment a referral or a follow-up message arrives — an inbound message
// that, for every row already in the deployment, has already been and
// gone. Nothing will ever revisit those rows on its own.
//
// Rules only, no AI — the owner's call (design.md's Decisions): free,
// fast, predictable, and unlike live traffic a backlog would fire every AI
// call at once with no human pacing. One pass per referral, not two: both
// live passes exist because at click time the landing-page cache and the
// Meta ad-name resolution are still in flight; on history everything that
// will ever exist already does, so this reads the full signal set —
// referral text, whatever `campaignAds`/`adLandingPages` caches happen to
// exist (never warmed here — no network I/O, ever), and the customer's
// first two messages after the click — in one shot.
//
// Internal, paginated, and re-runnable: a referral already
// `serviceMatchStatus: "matched"` OR `"suggested"` is skipped. `"matched"`
// is what makes a second pass additive rather than duplicative;
// `"suggested"` is the OTHER terminal state the live path produces
// (`markSuggested`'s own docstring calls it that) — a referral that
// exhausted both live rule passes and now has a pending AI suggestion
// sitting in an agent's banner for human review. Re-evaluating it here
// (rules only) could silently overwrite that pending-for-a-human marker
// with `matched`/`unmatched`/`ambiguous`, which is exactly the kind of
// "closes a door behind it" outcome this tool exists to avoid. Deliberately
// does NOT touch `serviceMatchAttempts` on a miss — bumping it would spend
// the live follow-up pass's budget on a run that customer never even
// triggered, and gating re-runs on it would make a second backfill pass
// (after the owner improves `kbServices.aliases`) a no-op, defeating the
// tool's own purpose.
//
// The scan is table-wide across every account, so every row's OWN
// `accountId` — never an ambient one — drives both the `kbServices` lookup
// and the `tagContactForService` write. A referral can therefore never
// reach another account's services or tags (see the "two accounts" test,
// which gives account B a service account A does not have and proves A's
// referral cannot match it).
//
// `removeBackfilledTags` is the undo: it deletes `contactTags` rows with
// `source: "ad"`, and — ONLY for rows it actually deleted — clears the
// `serviceMatchStatus`/`serviceMatchKey`/`serviceMatchedOn` on that
// contact's matching `adReferrals` rows, so a run → undo → improve
// `kbServices.aliases` → re-run cycle genuinely lands back at "never
// matched" rather than leaving those referrals permanently skipped as
// already-`matched` with no tag to show for it. `source: "ad"` does NOT
// distinguish a backfill-applied tag from one the live path applied — so
// this deletes (and un-matches the referrals behind) live-path "ad" tags
// too. That is intentional, not an oversight: the realistic reason to run
// this is "the whole feature mislabelled things, take it all off," and a
// backfill-only undo would leave exactly the rows the owner is trying to
// be rid of. It is ALSO cross-tenant by default — every account's
// `source: "ad"` rows, table-wide — for the same reason `backfillAdTags`
// scans every account: there is no ambient account to scope to. Pass
// `accountId` to undo one account's run without touching any other.
//
// A large `kbServices` catalogue pushes per-transaction document reads up:
// both mutations read that catalogue once per distinct account per batch
// (cached — see `makeServiceCache`), plus one `adReferrals.by_contact`
// collect per deleted row in the undo. If an account's catalogue is large
// enough to approach Convex's per-mutation read ceiling, pass a smaller
// `batchSize` to shrink how many rows (and therefore how many distinct
// accounts/contacts) one transaction touches.
//
// DELETE THIS MODULE once the backfill has run in production.
// ============================================================

const DEFAULT_BATCH = 200;

/**
 * The account's `kbServices` catalogue, as a `ServiceCandidate[]` (name +
 * key + aliases + status — `matchService` filters to `active` itself, and
 * `clearMatchedReferrals` below wants `name`/`key` off the very same rows,
 * so both callers share one shape rather than each doing their own
 * projection).
 *
 * Cached per `accountId` for the lifetime of ONE mutation call — the scan
 * is table-wide, so many rows in the same batch usually share an account,
 * and refetching a whole service catalogue once per row would be pure
 * waste for a script whose entire job is to walk every row in a table.
 * Shared by both `backfillAdTags` (one call per referral) and
 * `removeBackfilledTags` (one call per deleted `contactTags` row, via
 * `clearMatchedReferrals`) — each mutation invocation makes its own fresh
 * cache instance, so nothing leaks between calls or between batches.
 */
function makeServiceCache(ctx: { db: import("./_generated/server").MutationCtx["db"] }) {
  const cache = new Map<Id<"accounts">, Promise<ServiceCandidate[]>>();
  return async (accountId: Id<"accounts">): Promise<ServiceCandidate[]> => {
    let entry = cache.get(accountId);
    if (!entry) {
      entry = ctx.db
        .query("kbServices")
        .withIndex("by_account", (q) => q.eq("accountId", accountId))
        .collect()
        .then((rows) =>
          rows.map((s) => ({ key: s.key, name: s.name, aliases: s.aliases, status: s.status })),
        );
      cache.set(accountId, entry);
    }
    return entry;
  };
}

/**
 * Gathers the `campaignAds` / `adLandingPages` cache signals for one
 * referral. This is a second, deliberate implementation of the lookups
 * `tagFromAd` (`convex/adServiceTagging.ts`) runs inline in its handler —
 * NOT an extraction into a shared helper. Those lookups sit inline inside
 * a mutation whose surrounding control flow (attempt-counter gate, the
 * `trigger`-gated follow-up branch, the scheduled AI fallback) is
 * mutation-shaped in a way `customerMessagesSince`/`referralAnchorTime`
 * are not: pulling the two lookups out into their own exported function
 * would mean inventing a signature and a merge contract for a ~30-line
 * block that has never needed one, for the sake of a second caller that
 * only wants the same TWO independent, purely-read lookups
 * (`by_account_ad`, `by_account_url`) the live path already runs
 * (`adServiceTagging.ts` lines ~204-235). Copying them here, cited and
 * commented, carries far less risk than reshaping the live mutation to
 * accommodate a caller it never had — and if the live lookups ever change
 * shape, this comment is the trail back to what has to change here too.
 */
async function gatherCacheSignals(
  ctx: { db: import("./_generated/server").MutationCtx["db"] },
  referral: {
    accountId: Id<"accounts">;
    adId?: string;
    sourceUrl?: string;
  },
  signals: MatchSignals,
): Promise<void> {
  if (referral.adId) {
    const adId = referral.adId;
    const ad = await ctx.db
      .query("campaignAds")
      .withIndex("by_account_ad", (q) => q.eq("accountId", referral.accountId).eq("adId", adId))
      .first();
    if (ad && ad.resolveStatus === "resolved") {
      signals.adName = ad.adName;
      signals.adSetName = ad.adSetName;
      signals.campaignName = ad.campaignName;
    }
  }

  if (referral.sourceUrl) {
    const urlKey = landingUrlKey(referral.sourceUrl);
    if (urlKey) {
      const page = await ctx.db
        .query("adLandingPages")
        .withIndex("by_account_url", (q) =>
          q.eq("accountId", referral.accountId).eq("urlKey", urlKey),
        )
        .first();
      if (page) {
        signals.landingTitle = page.title;
        signals.landingDescription = page.description;
      }
    }
  }
}

/**
 * `byService` counts referrals this pass MATCHED to a service — i.e. how
 * many `adReferrals` rows got `serviceMatchStatus: "matched"` for that
 * service name, on both the dry-run and real-run paths. It is not a count
 * of `contactTags` rows newly created: when qualification already tagged
 * the contact for that service (`source: "ai"`), `tagContactForService`
 * finds the existing link and no-ops the insert, but the referral itself
 * still legitimately transitions to `matched` and still counts here. Read
 * it as "how many referrals this alias set would resolve", not as
 * "how many tags this run created".
 */
export const backfillAdTags = internalMutation({
  args: {
    // Defaults to true — the safe choice is the one you get by
    // forgetting the flag entirely.
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const servicesFor = makeServiceCache(ctx);

    const page = await ctx.db.query("adReferrals").paginate({
      cursor: args.cursor ?? null,
      numItems: args.batchSize ?? DEFAULT_BATCH,
    });

    let tagged = 0;
    let unmatched = 0;
    let ambiguous = 0;
    let skipped = 0;
    const byService: Record<string, number> = {};

    for (const referral of page.page) {
      // Re-runs are additive only: a referral this tool (or the live
      // path) already matched is skipped so it is never re-tagged.
      // `"suggested"` is the OTHER terminal state (`markSuggested`'s own
      // docstring) — a pending AI suggestion sitting in an agent's banner
      // for human review. Both must be left alone; see the module banner.
      if (
        referral.serviceMatchStatus === "matched" ||
        referral.serviceMatchStatus === "suggested"
      ) {
        skipped++;
        continue;
      }

      const signals: MatchSignals = {
        headline: referral.headline,
        body: referral.body,
        sourceUrl: referral.sourceUrl,
      };
      await gatherCacheSignals(ctx, referral, signals);

      // Defense-in-depth tenant guard, mirroring `tagFromAd`'s own
      // (`convex/adServiceTagging.ts`, `conversation.accountId ===
      // args.accountId`): `messages.by_conversation_sender`, queried by
      // both `referralAnchorTime` and `customerMessagesSince` below, is
      // not itself account-scoped. Here the risk isn't a caller passing
      // mismatched ids (there is no caller — `accountId` and
      // `conversationId` both come off the SAME referral row) but a
      // referral row whose own `conversationId` doesn't actually belong to
      // its own `accountId` (a data-integrity anomaly, not a normal path).
      // Skip the referral entirely rather than read another tenant's
      // messages for its customerText signal.
      const conversation = await ctx.db.get(referral.conversationId);
      if (!conversation || conversation.accountId !== referral.accountId) {
        skipped++;
        continue;
      }

      // The one-pass design reads the full signal set immediately,
      // including the customer's own words — the live path only has
      // these on its second (follow-up) pass, but history has no "not
      // yet spoken" state to wait out.
      const anchorTime = await referralAnchorTime(ctx, referral);
      const inbound = await customerMessagesSince(ctx, referral.conversationId, anchorTime, 2);
      const text = inbound
        .map((m) => m.contentText ?? "")
        .filter((s) => s.trim().length > 0)
        .join(" ");
      if (text) signals.customerText = text;

      const services = await servicesFor(referral.accountId);
      const result = matchService(signals, services);

      if (result.status === "matched") {
        tagged++;
        byService[result.serviceName] = (byService[result.serviceName] ?? 0) + 1;
        if (!dryRun) {
          await tagContactForService(ctx, {
            accountId: referral.accountId,
            contactId: referral.contactId,
            serviceName: result.serviceName,
            source: "ad",
          });
          // `serviceMatchAttempts` is deliberately never written here —
          // this tool must never spend the live follow-up pass's budget,
          // and must never make a future re-run (after alias
          // improvements) a no-op.
          await ctx.db.patch(referral._id, {
            serviceMatchStatus: "matched",
            serviceMatchKey: result.serviceKey,
            serviceMatchedOn: result.matchedOn,
          });
        }
        continue;
      }

      if (result.status === "ambiguous") {
        ambiguous++;
        if (!dryRun) {
          await ctx.db.patch(referral._id, { serviceMatchStatus: "ambiguous" });
        }
        continue;
      }

      unmatched++;
      if (!dryRun) {
        await ctx.db.patch(referral._id, { serviceMatchStatus: "unmatched" });
      }
    }

    return {
      cursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
      tagged,
      unmatched,
      ambiguous,
      skipped,
      byService,
    };
  },
});

/**
 * Resets the `adReferrals` rows that a just-deleted `source: "ad"`
 * `contactTags` row corresponds to, so the undo genuinely restores the
 * pre-run state rather than leaving those rows permanently skipped as
 * already-`matched` with no tag to show for it (see the module banner).
 *
 * `contactTags` has no back-reference to the referral(s) that produced it
 * — `tagContactForService` only ever takes a `serviceName` string — so the
 * mapping back is by NAME, the same way `tagContactForService` itself
 * resolves a service to a tag: the deleted row's `tags.name` is matched
 * case-insensitively (`trim().toLowerCase()`, deliberately the SAME
 * normalisation `tagContactForService` uses, not `matchService`'s
 * stricter `normalize()`) against `services` — this account's
 * `kbServices` catalogue, passed in already-fetched by the caller — to
 * recover the candidate `key`(s), and every `matched` referral for this
 * contact carrying one of those keys is cleared. Deliberately clears ALL
 * such referrals, not just ones this tool itself matched: the tag is gone
 * either way, and a referral left `matched` with no corresponding tag is
 * exactly the closed door this exists to reopen — consistent with the
 * module banner's point that `source: "ad"` (and now this reset) reaches
 * live-path rows too, not just backfill's own.
 *
 * KNOWN GAP, accepted rather than engineered around (review, 2026-07-31):
 * if the `kbServices` row has been RENAMED or DELETED between the
 * backfill run and this undo, no candidate name matches `tags.name`
 * anymore, `keys` comes back empty, and the function returns having
 * cleared nothing — the referral stays `serviceMatchStatus: "matched"`
 * with its tag already gone, i.e. the exact one-way door this function
 * exists to close, still open for that one row. This repo has no
 * id-level service→tag link anywhere (`tagContactForService` itself only
 * ever takes a name), so there is no cheap fix — only ever renaming a
 * service and expecting old tags/undos to still resolve through the old
 * name is not a case this bridge can cover. The failure direction is
 * fail-safe (nothing is wrongly cleared, no extra data is lost); the
 * consequence is an operator's job to avoid: run `removeBackfilledTags`
 * BEFORE renaming or deleting a `kbServices` row whose backfilled tags you
 * still want to be able to undo, not after.
 *
 * Fields are set to `undefined`, not `"unmatched"` — Convex `patch` clears
 * an optional field on `undefined` (see e.g. `contacts.ts`'s
 * `{ contactId: undefined }`), restoring the exact "never evaluated" shape
 * a pre-backfill historical row had, so a re-run does not skip it.
 * `serviceMatchAttempts` is left untouched, as everywhere else in this
 * module.
 */
async function clearMatchedReferrals(
  ctx: { db: import("./_generated/server").MutationCtx["db"] },
  deletedTag: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    tagId: Id<"tags">;
  },
  services: ServiceCandidate[],
): Promise<void> {
  const tag = await ctx.db.get(deletedTag.tagId);
  if (!tag) return;
  const wantedName = tag.name.trim().toLowerCase();

  const keys = new Set(
    services.filter((s) => s.name.trim().toLowerCase() === wantedName).map((s) => s.key),
  );
  if (keys.size === 0) return; // renamed/deleted service — see KNOWN GAP above

  const referrals = await ctx.db
    .query("adReferrals")
    .withIndex("by_contact", (q) => q.eq("contactId", deletedTag.contactId))
    .collect();
  for (const referral of referrals) {
    if (referral.accountId !== deletedTag.accountId) continue;
    if (referral.serviceMatchStatus !== "matched") continue;
    if (!referral.serviceMatchKey || !keys.has(referral.serviceMatchKey)) continue;
    await ctx.db.patch(referral._id, {
      serviceMatchStatus: undefined,
      serviceMatchKey: undefined,
      serviceMatchedOn: undefined,
    });
  }
}

/**
 * Undo for `backfillAdTags`: deletes `contactTags` rows with
 * `source: "ad"`, and for each row it actually deletes, resets the
 * `adReferrals` rows behind it via `clearMatchedReferrals` (see that
 * function's own comment) — a `dryRun` call deletes and resets nothing.
 * Paginated over `contactTags` the same way `backfillAdTags` paginates
 * over `adReferrals` — re-runnable, and safe to drive across a large table
 * in chunks. `dryRun` defaults to true for the same reason it does above.
 *
 * Deletes ANY `source: "ad"` row, not just ones this tool created — see
 * the module banner. There is no marker distinguishing a backfill-applied
 * tag from a live-path one, and that is by design: the realistic reason to
 * reach for this is "take the whole feature's tags off," not "undo only
 * the script run."
 *
 * Table-wide across every account by default — same as `backfillAdTags`,
 * there is no ambient account to scope to. Pass `accountId` to undo one
 * account's run without touching any other account's `source: "ad"` rows.
 */
export const removeBackfilledTags = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    /** Scope the undo to one account. Omitted = every account. */
    accountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    // Same cache `backfillAdTags` uses (see `makeServiceCache`'s own
    // comment) — without it, `clearMatchedReferrals` would re-read the
    // whole `kbServices` catalogue once per deleted row instead of once
    // per distinct account in this batch.
    const servicesFor = makeServiceCache(ctx);
    const page = await ctx.db.query("contactTags").paginate({
      cursor: args.cursor ?? null,
      numItems: args.batchSize ?? DEFAULT_BATCH,
    });

    let deleted = 0;
    for (const row of page.page) {
      if (row.source !== "ad") continue;
      if (args.accountId && row.accountId !== args.accountId) continue;
      deleted++;
      if (!dryRun) {
        await ctx.db.delete(row._id);
        const services = await servicesFor(row.accountId);
        await clearMatchedReferrals(ctx, row, services);
      }
    }

    return { cursor: page.continueCursor, isDone: page.isDone, deleted };
  },
});
