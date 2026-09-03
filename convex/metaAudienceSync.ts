import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { diffMembership, shouldBeMember, MIN_PHONE_DIGITS } from "./lib/metaAudience";
import type { FunnelStageKey } from "./lib/funnel";

/**
 * Contacts examined per pass. Exists to bound an otherwise-unbounded table
 * read, not to express an expected size.
 *
 * Production held 2,778 contacts as of 2026-09-03 — roughly 7x headroom
 * at 20,000. If the contacts table ever approaches this number, the fix
 * is cursor pagination across passes, NOT another quiet bump: `.take()`
 * is deterministic by index order, so a cap that silently binds does not
 * merely skip the same tail of contacts every single night — it actively
 * REMOVES them from the Meta audience. Any contact past the cap falls out
 * of `desired`, so `diffMembership`'s orphan loop treats it as no longer
 * wanted and issues a REMOVE for anyone that loop believes is a current
 * member. This happens permanently, with no error and no failing test.
 */
export const SCAN_CAP = 20000;

/**
 * Conversations examined per contact. A per-contact read must be bounded
 * the same way the account-wide scan above is — an unbounded `.query`
 * inside a per-contact loop is the runaway this guards against.
 *
 * Production holds 2,778 conversations across 2,776 distinct contacts —
 * essentially 1:1, so today's real-world maximum is about one conversation
 * per contact. 200 is headroom against future growth, not a limit anyone
 * is close to.
 *
 * If a contact ever genuinely exceeds this, a `purchased` conversation
 * that falls outside the window is invisible to `stages` below, so
 * `shouldBeMember` sees no excluded stage and returns true — a converted
 * customer quietly stays in the retargeting audience.
 */
export const CONVERSATIONS_PER_CONTACT_CAP = 200;

/**
 * The desired membership state, computed fresh from the CRM.
 *
 * Returns the NORMALIZED PHONE, not a digest: hashing needs Web Crypto's
 * async `digest`, and a Convex query handler must stay synchronous in
 * spirit — the action hashes what this returns.
 */
export const collectDesired = internalQuery({
  args: { accountId: v.id("accounts"), limit: v.number() },
  handler: async (ctx, args) => {
    const contacts = await ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .take(Math.min(args.limit, SCAN_CAP));

    const out: {
      contactId: (typeof contacts)[number]["_id"];
      phoneNormalized: string;
      wanted: boolean;
    }[] = [];

    for (const c of contacts) {
      const convos = await ctx.db
        .query("conversations")
        .withIndex("by_contact", (q) => q.eq("contactId", c._id))
        .take(CONVERSATIONS_PER_CONTACT_CAP);
      const stages = convos
        .map((v) => v.funnel?.stage)
        .filter((s): s is FunnelStageKey => Boolean(s));

      out.push({
        contactId: c._id,
        phoneNormalized: c.phoneNormalized,
        wanted: shouldBeMember({
          contactId: c._id,
          phoneNormalized: c.phoneNormalized,
          doNotContact: Boolean(c.doNotContact),
          stages,
        }),
      });
    }
    return out;
  },
});

// Normalization + hashing come from `lib/metaHash.ts`, which is where this
// repo keeps them — `conversionEvents.ts` holds them in the Amani tree this
// module was ported from, and it exports neither. Ours additionally strips
// the trunk zero before hashing (see that module's header), so a UAE number
// stored `0585824488` produces the digest Meta actually holds. It returns
// "" rather than null for an unusable number, so `hashPhone` below adapts
// the shape and applies the shared digit floor itself.
import { sha256Hex, normalizePhoneForMeta } from "./lib/metaHash";

/** Rows per Graph call. 300 proved workable in the 2026-09-02 backfill. */
export const GRAPH_BATCH = 300;

// Matches conversionEvents.ts's own derivation (`|| "v25.0"`) rather than
// inventing a second default in this codebase — see that file's
// GRAPH_VERSION for the canonical value.
const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v25.0";

/** SHA-256 of the Meta-normalized phone, or null when unusable. */
export async function hashPhone(raw: string): Promise<string | null> {
  const normalized = normalizePhoneForMeta(raw);
  // The length gate is applied HERE rather than inside the normalizer,
  // because `lib/metaHash.ts` is shared with CAPI delivery and answers a
  // different question there ("are there any digits at all"). Counting
  // after normalization means the trunk zero does not pad a short number
  // over the line; `shouldBeMember` counts before, so the two agree on
  // everything except a number that is only long enough with its zero —
  // which is one Meta could not match anyway.
  if (normalized.length < MIN_PHONE_DIGITS) return null;
  return await sha256Hex(normalized);
}

/**
 * One ADD or REMOVE against `/{audience_id}/users`.
 *
 * Hashes are sent PRE-COMPUTED: Meta accepts raw values and hashes them
 * server-side, but sending digests keeps raw customer phone numbers out of
 * the request body entirely.
 *
 * VERIFIED AGAINST LIVE META on 2026-09-03 — on the Amani deployment,
 * where this code was written, using its `META_ADS_ACCESS_TOKEN` (a
 * non-expiring SYSTEM_USER token carrying `ads_management`) against its
 * own customer-list audience. What that settles is the WIRE FORMAT, which
 * is the same everywhere; the account facts below are that deployment's,
 * and this one must satisfy them for itself. A digest of a text
 * string — matching no real phone, so nobody's targeting moved — was added
 * and then removed:
 *   POST   /{id}/users -> HTTP 200, num_received 1, num_invalid_entries 0
 *   DELETE /{id}/users -> HTTP 200, num_received 1, num_invalid_entries 0
 *
 * That settles the two things about this wire format that were inferred
 * from docs rather than observed, and both hold:
 *   1. REMOVE uses HTTP DELETE WITH A JSON BODY. Meta accepts it; the body
 *      is not dropped. Keep it a DELETE — do not "fix" it into a POST.
 *   2. `access_token` travels in the JSON body, not the query string. Meta
 *      accepts it there for this endpoint.
 *
 * The successful write also proves what a read alone could not: that ad
 * account had accepted Meta's Custom Audience Terms and that token held
 * asset-level permission on it — see `docs/meta-audience-sync.md` for the
 * same two prerequisites stated as setup steps.
 *
 * Meta also returns a `subscription_info.whatsapp` block on both calls. We
 * do not read it; noted so a future reader knows it is expected, not a
 * symptom of sending the wrong thing.
 */
export async function sendAudienceDelta(args: {
  audienceId: string;
  token: string;
  operation: "ADD" | "REMOVE";
  hashes: string[];
}): Promise<{
  ok: boolean;
  received: number;
  invalid: number;
  status: number;
  error: string | null;
}> {
  const payload = {
    schema: ["PHONE"],
    data: args.hashes.map((h) => [h]),
  };
  const url =
    `https://graph.facebook.com/${GRAPH_VERSION}/` +
    `${encodeURIComponent(args.audienceId)}/users`;

  const res = await fetch(url, {
    method: args.operation === "ADD" ? "POST" : "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payload,
      access_token: args.token,
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    num_received?: number;
    num_invalid_entries?: number;
    error?: { message?: string };
  };

  return {
    ok: res.ok,
    received: body.num_received ?? 0,
    invalid: body.num_invalid_entries ?? 0,
    status: res.status,
    error: res.ok ? null : (body.error?.message ?? `HTTP ${res.status}`),
  };
}

/** Split a list into fixed-size chunks. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const readMirror = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("metaAudienceMembers")
      .withIndex("by_account_contact", (q) => q.eq("accountId", args.accountId))
      .take(SCAN_CAP);
    return rows.map((r) => ({
      contactId: r.contactId,
      phoneHash: r.phoneHash,
      isMember: r.isMember,
    }));
  },
});

/**
 * Upsert mirror rows after a Graph call succeeded.
 *
 * Called ONLY with deltas Meta actually accepted — a failed batch leaves
 * the mirror untouched, so the next pass retries it. That asymmetry is the
 * safety property: the mirror may lag reality, but it never claims a
 * membership change that did not happen.
 */
export const applyMirror = internalMutation({
  args: {
    accountId: v.id("accounts"),
    rows: v.array(
      v.object({
        contactId: v.id("contacts"),
        phoneHash: v.string(),
        isMember: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const row of args.rows) {
      const existing = await ctx.db
        .query("metaAudienceMembers")
        .withIndex("by_account_contact", (q) =>
          q.eq("accountId", args.accountId).eq("contactId", row.contactId),
        )
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, {
          phoneHash: row.phoneHash,
          isMember: row.isMember,
          lastSyncedAt: now,
        });
      } else {
        await ctx.db.insert("metaAudienceMembers", {
          accountId: args.accountId,
          contactId: row.contactId,
          phoneHash: row.phoneHash,
          isMember: row.isMember,
          lastSyncedAt: now,
        });
      }
    }
    return null;
  },
});

/** Every account on the deployment. Small table — a full scan is correct. */
export const listAccountIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").take(100);
    return accounts.map((a) => a._id);
  },
});

/**
 * Reconcile every account's contacts against the Meta customer-list
 * audience: add who belongs, remove who no longer does.
 *
 * OFF by default — with `META_CUSTOM_AUDIENCE_ID` unset this returns
 * immediately, same posture as the conversion-delivery lanes. That is what
 * makes it safe to ship before the token question in Task 0 is settled.
 *
 * Failure policy: a batch that Meta rejects does NOT update the mirror, so
 * the next nightly pass retries exactly those rows. There is no retry loop
 * inside a run — a Graph outage should cost one quiet night, not a storm
 * of requests.
 *
 * `failedBatches` counts BATCHES, not contacts — a single failed batch of
 * `GRAPH_BATCH` (300) rows can leave hundreds of contacts unsynced, so do
 * not read it as a per-contact count.
 *
 * `added`/`removed` count contacts Meta ACCEPTED in this pass, which is not
 * the same as contacts whose mirror row was written: a contact touched by a
 * failed batch is counted in neither, and one whose sibling batch in the
 * same pass failed (see `failedContactIds` below) is deliberately excluded
 * from the mirror write even though it is included in these counts.
 */
export const syncAudience = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    skipped: boolean;
    added: number;
    removed: number;
    unchanged: number;
    failedBatches: number;
    invalid: number;
  }> => {
    const audienceId = process.env.META_CUSTOM_AUDIENCE_ID?.trim();
    const token = process.env.META_ADS_ACCESS_TOKEN?.trim();
    if (!audienceId || !token) {
      return {
        skipped: true,
        added: 0,
        removed: 0,
        unchanged: 0,
        failedBatches: 0,
        invalid: 0,
      };
    }

    const accountIds = await ctx.runQuery(
      internal.metaAudienceSync.listAccountIds,
      {},
    );

    let added = 0;
    let removed = 0;
    let unchanged = 0;
    let failedBatches = 0;
    let invalid = 0;

    for (const accountId of accountIds) {
      const desiredRaw = await ctx.runQuery(
        internal.metaAudienceSync.collectDesired,
        { accountId, limit: SCAN_CAP },
      );

      const desired: {
        contactId: (typeof desiredRaw)[number]["contactId"];
        phoneHash: string;
        wanted: boolean;
      }[] = [];
      for (const row of desiredRaw) {
        const phoneHash = await hashPhone(row.phoneNormalized);
        // An unhashable phone can never be a member; skipping it entirely
        // also stops it churning the mirror every night.
        if (!phoneHash) continue;
        desired.push({ contactId: row.contactId, phoneHash, wanted: row.wanted });
      }

      const mirror = await ctx.runQuery(internal.metaAudienceSync.readMirror, {
        accountId,
      });
      const diff = diffMembership(desired, mirror);
      unchanged += diff.unchanged;

      type MirrorRowWrite = {
        contactId: (typeof desired)[number]["contactId"];
        phoneHash: string;
        isMember: boolean;
      };

      // A contact can land in BOTH `diff.toAdd` and `diff.toRemove` in the
      // same pass — a phone change retires the old digest and adds the
      // new one for the SAME contactId. `applyMirror` upserts one row per
      // contact, so writing the ADD loop's result and the REMOVE loop's
      // result independently (as separate `runMutation` calls) means a
      // batch that fails after the other succeeds silently loses whichever
      // half already landed: the mirror ends up either claiming the stale
      // digest is still live (an untargetable ghost Meta can never be
      // asked about again) or forgetting a digest that really did get
      // added. So mirror writes are staged here and applied ONCE per
      // account after both loops finish, and any contact touched by a
      // failed batch is dropped entirely — a half-succeeded pair must
      // leave the mirror completely untouched, or the next pass has no
      // way to tell a repair is still needed.
      const failedContactIds = new Set<string>();
      const pendingMirror = new Map<string, MirrorRowWrite>();

      for (const batch of chunk(diff.toAdd, GRAPH_BATCH)) {
        const res = await sendAudienceDelta({
          audienceId,
          token,
          operation: "ADD",
          hashes: batch.map((r) => r.phoneHash),
        });
        // Meta counts invalid rows INSIDE `num_received` (a 299-good/
        // 1-invalid batch reports received: 300) and never says which row
        // was bad, so we can't subtract it from the equality check below
        // without failing — and endlessly re-retrying — the 299 good rows.
        // This is visibility only: surface the count so an operator can
        // investigate, since Meta gives us no other way to find it.
        if (res.invalid > 0) {
          console.warn(
            `[metaAudienceSync] audience ${audienceId}: ADD batch reported ` +
              `${res.invalid} invalid entr${res.invalid === 1 ? "y" : "ies"} ` +
              `(Meta does not identify which rows)`,
          );
        }
        invalid += res.invalid;
        // `res.ok` alone is NOT proof the batch landed: Meta can answer 2xx
        // with an empty or unparsable body, in which case sendAudienceDelta
        // falls back to `received: 0`. Meta's audience API is write-only —
        // nothing can ever read membership back — so if the mirror records
        // a false success here, no later pass can detect or repair it; the
        // contact is wrong in the audience forever. Require the accepted
        // count to match the batch size before trusting it. Do not
        // "simplify" this back to `!res.ok`.
        if (!res.ok || res.received !== batch.length) {
          failedBatches++;
          console.error(
            `[metaAudienceSync] ADD failed for audience ${audienceId}: ` +
              `batch of ${batch.length}, status ${res.status}, error: ${res.error}`,
          );
          for (const r of batch) failedContactIds.add(String(r.contactId));
          continue;
        }
        for (const r of batch) {
          pendingMirror.set(String(r.contactId), {
            contactId: r.contactId,
            phoneHash: r.phoneHash,
            isMember: true,
          });
        }
        added += batch.length;
      }

      for (const batch of chunk(diff.toRemove, GRAPH_BATCH)) {
        const res = await sendAudienceDelta({
          audienceId,
          token,
          operation: "REMOVE",
          hashes: batch.map((r) => r.phoneHash),
        });
        // Same visibility measure as the ADD loop above — see that
        // comment for why this can't gate the success check either.
        if (res.invalid > 0) {
          console.warn(
            `[metaAudienceSync] audience ${audienceId}: REMOVE batch reported ` +
              `${res.invalid} invalid entr${res.invalid === 1 ? "y" : "ies"} ` +
              `(Meta does not identify which rows)`,
          );
        }
        invalid += res.invalid;
        // Same non-negotiable check as the ADD loop above — see that
        // comment for why `res.ok` alone cannot be trusted here either.
        if (!res.ok || res.received !== batch.length) {
          failedBatches++;
          console.error(
            `[metaAudienceSync] REMOVE failed for audience ${audienceId}: ` +
              `batch of ${batch.length}, status ${res.status}, error: ${res.error}`,
          );
          for (const r of batch) failedContactIds.add(String(r.contactId));
          continue;
        }
        for (const r of batch) {
          const key = String(r.contactId);
          // A phone-change contact already has a successful ADD entry
          // (new digest, isMember: true) staged for this same contactId —
          // that row is the authoritative final state (the contact is a
          // CURRENT member under its new digest), so this REMOVE's stale
          // old-digest entry must not clobber it.
          if (pendingMirror.has(key)) continue;
          pendingMirror.set(key, {
            contactId: r.contactId,
            phoneHash: r.phoneHash,
            isMember: false,
          });
        }
        removed += batch.length;
      }

      const rowsToWrite = [...pendingMirror.values()].filter(
        (row) => !failedContactIds.has(String(row.contactId)),
      );
      if (rowsToWrite.length > 0) {
        await ctx.runMutation(internal.metaAudienceSync.applyMirror, {
          accountId,
          rows: rowsToWrite,
        });
      }
    }

    const summary =
      `[metaAudienceSync] done: added=${added} removed=${removed} ` +
      `unchanged=${unchanged} failedBatches=${failedBatches} invalid=${invalid}`;
    if (failedBatches > 0) {
      console.error(summary);
    } else {
      console.info(summary);
    }

    return { skipped: false, added, removed, unchanged, failedBatches, invalid };
  },
});
