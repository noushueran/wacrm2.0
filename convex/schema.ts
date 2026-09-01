import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";
import { ARCHIVE_REASONS } from "./lib/leadAnalysis/archive";
import {
  AI_USAGE_MODES,
  AI_USAGE_PROVIDERS,
} from "./lib/aiUsageStats";

export default defineSchema({
  ...authTables,

  // A tenant / workspace. Every account-scoped table below carries an
  // `accountId` and an index to filter by it.
  accounts: defineTable({
    name: v.string(),
    defaultCurrency: v.string(), // ISO-4217, default "USD"
    ownerUserId: v.id("users"),
    leadValue: v.optional(v.number()), // flat per-lead charge; unset/<=0 = feature OFF
    suppressBotHandledPush: v.optional(v.boolean()), // opt-in: skip push when a flow fully handled the inbound message
  }).index("by_owner", ["ownerUserId"]),

  // Append-only spend ledger — one row = one agent charged once for one
  // conversation. Never updated/deleted in normal operation. `value`/
  // `currency` are snapshots of the account rate at charge time so later
  // rate changes don't rewrite history. `by_user_conversation` backs the
  // once-per-(agent,conversation) idempotency check.
  leadCharges: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    conversationId: v.id("conversations"),
    value: v.number(),
    currency: v.string(),
  })
    .index("by_account", ["accountId"])
    .index("by_user_account", ["userId", "accountId"])
    .index("by_user_conversation", ["userId", "conversationId"]),

  // Join table between `users` and `accounts`. A user's role within a
  // given account. `fullName`/`email`/`avatarUrl` are a denormalized
  // snapshot for display without joining back to `users`.
  memberships: defineTable({
    userId: v.id("users"),
    accountId: v.id("accounts"),
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("supervisor"),
      v.literal("agent"),
      v.literal("viewer"),
    ),
    fullName: v.optional(v.string()),
    email: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    // R2 object key for this member's avatar — the durable replacement
    // for `avatarUrl`, which stored a resolved absolute URL. Readers
    // resolve `avatarKey ?? avatarUrl` (see `convex/lib/r2/url.ts`), so
    // pre-cutover rows keep working untouched. Lives here, not on the
    // real Convex `users` table (spread verbatim from `@convex-dev/auth`'s
    // `authTables`, which has no avatar field of its own — only `image`,
    // written by the auth provider, never by this app): `avatarUrl` is
    // patched onto `memberships` by `accounts.ts`'s `updateProfile`
    // mutation, and `avatarKey` is the same denormalized-per-account
    // snapshot. `avatarUrl` is retained until the Plan 2 backfill is
    // verified, then dropped separately.
    avatarKey: v.optional(v.string()),
    // v4 (qualification): the member's own WhatsApp number — the channel
    // the AI uses to reach agents (lead offers, questions) when they're
    // away from the desktop. Set by admin+ in Settings → Team members.
    phone: v.optional(v.string()),
    // Shown on the WhatsApp contact card sent to customers when this
    // member accepts a lead (e.g. "Senior Travel Consultant"). Set by
    // admin+ in Settings → Team members, like `phone` above.
    jobTitle: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_account", ["accountId"])
    .index("by_user_account", ["userId", "accountId"]),

  // A person reachable over WhatsApp, scoped to an account. `phoneNormalized`
  // (digits-only) is set in the mutation layer and used for exact-match
  // lookups; `search_name` only covers `name` — phone/email search is
  // handled in `contacts.list` via a `by_account` scan + startsWith fallback.
  contacts: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    phone: v.string(),
    phoneNormalized: v.string(), // digits-only; set in mutation
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    company: v.optional(v.string()),
    // A contact photo is ALWAYS manually uploaded. WhatsApp never supplies
    // one: an inbound webhook carries `profile.name` and `wa_id` only (see
    // `convex/lib/whatsapp/webhookParse.ts`), and the Cloud API has no
    // endpoint for a customer's picture — `whatsapp_business_profile` is
    // our own business avatar, not theirs. Contacts without one render a
    // derived colour + initials disc (`src/lib/inbox/avatar.ts`), which is
    // most of them.
    //
    // `avatarKey`/`avatarUrl` are the same dual-read pair as
    // `memberships` — R2 object key preferred, legacy absolute URL as the
    // fallback, resolved by `resolveMediaUrl`. `avatarUrl` was here first
    // (never written by any mutation) and is kept so that a row carrying
    // one still resolves.
    avatarKey: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    // Human-readable per-account identifier, e.g. "HC-000123". Optional in
    // the schema so pre-backfill rows validate, but written on every new
    // insert via `allocateContactCode`.
    contactCode: v.optional(v.string()),
    // Extended CRM detail — all optional, edited from the inbox contact
    // panel. Additive/backward-compatible; no migration.
    altPhone: v.optional(v.string()),
    address: v.optional(v.string()),
    city: v.optional(v.string()),
    country: v.optional(v.string()),
    nationality: v.optional(v.string()),
    preferredDestination: v.optional(v.string()),
    // Travel-profile detail the qualification engine extracts and the
    // contact panel edits. FREE TEXT on purpose: the extractor returns
    // prose ("mid December", "2 adults + 1 child aged 9", "around AED
    // 3,000 per person"), and parsing that into dates/numbers is a
    // separate problem with its own failure modes. Same additive,
    // no-migration shape as the extended CRM detail above.
    travelDates: v.optional(v.string()),
    travelers: v.optional(v.string()),
    budget: v.optional(v.string()),
    notes: v.optional(v.string()),
    // Denormalised from the `contactNotes` row whose `outcome` is
    // `do_not_contact`. Denormalised on purpose: the Phase 3 gates run
    // on every inbound message and every chase sweep and need an O(1)
    // field read, not a per-contact note scan. `noteId` keeps the WHY
    // one `db.get` away.
    //
    // ONE path clears this: `contactNotes.clearDoNotContact`. Deleting
    // the note that set it does NOT, and neither does editing that
    // note's outcome — a customer's stated wish must outlive an agent
    // tidying up their notes.
    doNotContact: v.optional(
      v.object({
        at: v.number(),
        byUserId: v.optional(v.id("users")),
        noteId: v.id("contactNotes"),
      }),
    ),
    // Lead-acquisition provenance. Set ONCE, the first time a contact
    // arrives via a Click-to-WhatsApp ad referral; never overwritten.
    acquisitionSource: v.optional(v.literal("ad")),
    acquisitionAd: v.optional(
      v.object({
        headline: v.optional(v.string()),
        sourceId: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
        firstSeenAt: v.number(),
      }),
    ),
  })
    .index("by_account", ["accountId"])
    .index("by_account_phone", ["accountId", "phoneNormalized"])
    .searchIndex("search_name", {
      searchField: "name",
      filterFields: ["accountId"],
    }),

  // A label defined per-account and attached to contacts via `contactTags`.
  // Optionally belongs to a `tagGroups` dimension (Product, Destination, …);
  // ungrouped tags (groupId unset) remain valid — pre-grouping tags stay usable.
  tags: defineTable({
    accountId: v.id("accounts"),
    name: v.string(),
    color: v.string(),
    groupId: v.optional(v.id("tagGroups")),
    position: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_group", ["groupId"]),

  // A dimension that tags are organised under. `selectionMode: "single"`
  // means a contact holds at most one tag from this group (e.g. Priority);
  // "multi" allows several (e.g. Destination). `position` orders groups
  // in the UI.
  tagGroups: defineTable({
    accountId: v.id("accounts"),
    name: v.string(),
    color: v.optional(v.string()),
    selectionMode: v.union(v.literal("single"), v.literal("multi")),
    position: v.number(),
  }).index("by_account", ["accountId"]),

  // Join table between `contacts` and `tags`.
  contactTags: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    tagId: v.id("tags"),
    // unset = manual (backward-compatible). "ad" = derived from a
    // click-to-WhatsApp referral before qualification ran
    // (convex/adServiceTagging.ts).
    source: v.optional(
      v.union(v.literal("ai"), v.literal("manual"), v.literal("ad")),
    ),
  })
    .index("by_contact", ["contactId"])
    .index("by_tag", ["tagId"])
    .index("by_contact_tag", ["contactId", "tagId"]),

  // Per-account monotonic counters for human-readable sequential codes
  // (e.g. `("contacts")` backs the HC-000123 contact code). One row per
  // (accountId, name); `value` is the last number allocated (0 = none yet).
  counters: defineTable({
    accountId: v.id("accounts"),
    name: v.string(),
    value: v.number(),
  }).index("by_account_name", ["accountId", "name"]),

  // ============================================================
  // Inbox + CRM (Phase 1, Task 1). Source: supabase/migrations
  // 001_initial_schema.sql, 002_pipelines_enhancements.sql,
  // 009_message_actions.sql, 035_interactive_messages.sql, plus the
  // `account_id` backfill from 017_account_sharing.sql.
  // ============================================================

  // A WhatsApp thread with one contact. `contactId`/`status` were NOT NULL
  // in Postgres; `assignedToUserId` mirrors `assigned_agent_id`, which had
  // no DB-level FK in Postgres but is always a user id in practice (same
  // treatment as `deals.assignedToUserId` below). `lastMessageText`/
  // `lastMessageAt` are denormalized so the inbox list never joins into
  // `messages` just to render a preview.
  conversations: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    contactId: v.id("contacts"),
    status: v.union(
      v.literal("open"),
      v.literal("pending"),
      v.literal("closed"),
    ),
    assignedToUserId: v.optional(v.id("users")),
    lastMessageText: v.optional(v.string()),
    lastMessageAt: v.optional(v.number()),
    // Denormalised sender type of the message that set `lastMessageText`
    // and `lastMessageAt` above — written in the same patch, in the
    // backend's single `insert("messages")` site, so it cannot drift.
    //
    // Read ONLY by `leadAnalysis.board`, to spare it a per-row `messages`
    // query for the lane badge. `undefined` means "not backfilled yet",
    // and every reader MUST fall back to the real query rather than
    // assume a value: `leadLane` turns this into an automation-relevant
    // verdict (`convex/lib/leadAnalysis/priority.ts` — "a customer
    // waiting on US is never sequenced and never archived"), so a guess
    // here could authorise a send. The sequence engine deliberately does
    // NOT read this field; it keeps deriving eligibility from real
    // message rows.
    lastMessageSenderType: v.optional(
      v.union(v.literal("customer"), v.literal("agent"), v.literal("bot")),
    ),
    unreadCount: v.number(),
    // When the OLDEST still-unanswered customer message in this thread
    // arrived; absent when the thread is not waiting on us. This is the whole
    // pairing state behind the `messageHourlyStats` reply-latency rollup: on
    // an inbound it is set only if currently absent (so a customer who
    // double-messages is still one sample, timed from their FIRST message),
    // and on an outbound it is consumed to record the sample and cleared.
    //
    // Deliberately NOT derived from the lane fields beside it, which answer
    // different questions: `awaitingReply` is a boolean with no timestamp,
    // `lastInboundAt` moves on EVERY inbound (so it would time from the
    // customer's latest nudge and flatter the average), and `firstReplyAt` is
    // the ad-referral 72h anchor, set once and only on ad conversations.
    // Recomputing it from `messages` instead would mean scanning a thread
    // backwards to the last outbound — the unbounded read the rollup exists
    // to remove.
    pendingCustomerAtMs: v.optional(v.number()),
    // AI auto-reply control (migrations 029 + 033). In Postgres these were
    // NOT NULL DEFAULT false / NOT NULL DEFAULT 0 / nullable text. Convex
    // has no column defaults, and all three were added by later migrations
    // to a table with pre-existing rows, so they're optional here (the
    // writing mutation supplies false/0; `aiHandoffSummary` was nullable).
    aiAutoreplyDisabled: v.optional(v.boolean()),
    aiReplyCount: v.optional(v.number()),
    aiHandoffSummary: v.optional(v.string()),
    // Postgres maintains this via an on-UPDATE trigger; added here for
    // uniform trigger parity across every such table (P1 review) — the
    // dashboard's inbox sort and the v1 API contract both expose it.
    updatedAt: v.optional(v.number()),
    // Denormalized Click-to-WhatsApp ad summary — presence flags this
    // conversation as an "ad lead" for the inbox badge without scanning
    // messages. `startedAt` anchors the 72h free-entry-point indicator
    // (set once, on the first ad message).
    adReferral: v.optional(
      v.object({
        headline: v.optional(v.string()),
        body: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
        sourceType: v.optional(v.union(v.literal("ad"), v.literal("post"))),
        imageUrl: v.optional(v.string()),
        storedImageUrl: v.optional(v.string()),
        startedAt: v.number(),
      }),
    ),
    // Lead-source classifier for the conversion funnel. Set ONCE, the first
    // time an attribution identifier is seen on an inbound message (the HY-
    // zero-width code → website lane, or the Meta `ctwa_clid` → ad lane);
    // never overwritten. Both identifiers are retained if both ever appear;
    // `lane` (code-wins) decides which backend the funnel dispatches to, so a
    // conversation never double-fires. Absent = organic (never reported).
    attribution: v.optional(
      v.object({
        lane: v.union(v.literal("code"), v.literal("ctwa")),
        code: v.optional(v.string()),
        ctwaClid: v.optional(v.string()),
        firstSeenAt: v.number(),
      }),
    ),
    // Meta's AUTHORITATIVE messaging-window record, captured from
    // outbound status webhooks (`statuses[].conversation`). Preferred
    // over any local estimate. `isFreeEntryPoint` is derived from either
    // era's spelling (CBP `origin.type === "referral_conversion"` or PMP
    // `pricing.type === "free_entry_point"`). `expiresAt` only ever
    // ADVANCES — status webhooks are unordered, so a late `delivered`
    // must not shrink a live window.
    metaWindow: v.optional(
      v.object({
        conversationMetaId: v.optional(v.string()),
        originType: v.optional(v.string()),
        expiresAt: v.optional(v.number()),
        isFreeEntryPoint: v.boolean(),
        // When the free-entry-point signal itself was last observed —
        // distinct from `updatedAt`, which is rewritten on every status
        // callback. The latch that carries `isFreeEntryPoint` forward
        // across callbacks must age against THIS, or an unrelated stream
        // of callbacks keeping the record warm would let a latch outlive
        // the 72h window it describes.
        fepObservedAt: v.optional(v.number()),
        updatedAt: v.number(),
      }),
    ),
    // Timestamp of the most recent CUSTOMER message — the anchor for
    // Meta's 24h customer service window, which governs whether
    // free-form (non-template) messages may be sent. Distinct from
    // `lastMessageAt`, which includes outbound messages and therefore
    // cannot express this window.
    lastInboundAt: v.optional(v.number()),
    /** UTC midnight of the day this conversation was last counted toward
     *  `messageHourlyStats.activeConversations`. Compared for equality at the
     *  message choke point; a difference means "not yet counted today", which
     *  IS the dedup. Written in the patch that already happens on every
     *  message, so it costs no extra read and no extra document.
     *
     *  Not backfilled: it is a forward-looking marker, and an absent value
     *  correctly means the next message counts its day. */
    lastActiveDayMs: v.optional(v.number()),
    // Timestamp of the first outbound message sent AFTER
    // `adReferral.startedAt`. Anchors the 72h free-entry-point ESTIMATE
    // used before Meta confirms via `metaWindow`. Written once.
    firstReplyAt: v.optional(v.number()),
    // Denormalized CURRENT funnel stage for fast inbox render + future
    // stage-filtering, without scanning `funnelTransitions`. `saleValue`/
    // `saleCurrency` are captured at the Purchased stage (and optionally at
    // quote/invoice). The full progress history lives in `funnelTransitions`.
    funnel: v.optional(
      v.object({
        stage: v.union(
          v.literal("new_lead"),
          v.literal("qualified"),
          v.literal("price_quoted"),
          v.literal("itinerary_created"),
          v.literal("itinerary_sent"),
          v.literal("invoice_sent"),
          v.literal("purchased"),
          v.literal("lost"),
        ),
        stageUpdatedAt: v.number(),
        stageUpdatedByUserId: v.optional(v.id("users")),
        saleValue: v.optional(v.number()),
        saleCurrency: v.optional(v.string()),
      }),
    ),
    // ---- Archive (spec 2026-07-26 §"Changes to conversations") ----
    // `archivedAt` is the SYSTEM OF RECORD for archived state and the
    // only thing the Inbox reads. Presence = archived.
    //
    // A TIMESTAMP rather than a fourth `status` literal, deliberately:
    // `conversations.list` applies `status` as a post-index `.filter()`,
    // which is safe today only because almost every row is "open" (the
    // predicate matches early and often). Archived rows accumulate
    // FOREVER, so as a filter they would make the Inbox scan grow
    // without bound — the failure this file documents for
    // `broadcastRecipients`, `conversionEvents` and `campaignAds`.
    // Convex sorts a missing field before every present value, so
    // `eq("archivedAt", undefined)` is one genuine index range over
    // exactly the active set.
    archivedAt: v.optional(v.number()),
    // A schema-level union DERIVED from `lib/leadAnalysis/archive.ts`'s
    // ARCHIVE_REASONS (mapped straight into `v.literal`s below), plus an
    // optional human note. Not a plain string: every writer already
    // routes through `isArchiveReason` before patching this field
    // (`leadAnalysis.ts`'s `archive` and `archiveAutomated`), so the
    // schema can enforce the same closed vocabulary as a second,
    // independent gate — a plain string only trusted that every future
    // writer would keep doing so. Deriving the union directly from
    // ARCHIVE_REASONS (rather than hand-listing the literals here) means
    // the two can never drift the way `aiUsageLog.mode` and
    // `notifications.type` have.
    archivedReason: v.optional(
      v.union(...ARCHIVE_REASONS.map((reason) => v.literal(reason))),
    ),
    archivedNote: v.optional(v.string()),
    // Absent = archived by automation (P3). Set for a manual archive.
    archivedByUserId: v.optional(v.id("users")),
    // When the customer last brought this thread BACK by replying. Drives
    // the board's "returned" flag; never cleared.
    returnedAt: v.optional(v.number()),
    // ---- Manual overrides (spec 2026-07-28-inbox-manual-overrides) ----
    // PRESENCE = snoozed; the value is when to wake. A snoozed thread
    // appears in NO lane — that is what snooze means — and the lane
    // queries get that for free by binding `eq("snoozedUntil", undefined)`
    // as a single equality, exactly as they bind `archivedAt`.
    //
    // The wake sweep CLEARS this field rather than letting it sit in the
    // past. That is load-bearing, not tidiness: an expired-but-uncleared
    // row holds a number, not `undefined`, so it would fall out of every
    // lane range and stay invisible forever. See `inboxOverrides`.
    snoozedUntil: v.optional(v.number()),
    snoozedByUserId: v.optional(v.id("users")),
    /** Optional free text, shown on the Snoozed row so the tab is scannable. */
    snoozedReason: v.optional(v.string()),

    // PRESENCE = an agent has declared this lead ghosted, so it belongs
    // in Chasing regardless of age. Unlike snooze this does not expire;
    // it ends when the customer replies, the thread is archived, or an
    // agent undoes it.
    //
    // This one costs a union (Chasing becomes derived ∪ forced) and is
    // therefore an index key too, so Waiting can EXCLUDE forced rows by
    // equality instead of filtering — without that a forced thread would
    // appear in two lanes at once.
    chasingForcedAt: v.optional(v.number()),
    chasingForcedByUserId: v.optional(v.id("users")),
    // ---- Lanes (spec 2026-07-27-inbox-lanes §Data model) ----
    // TRUE = the customer spoke last so we owe a reply (Active), OR the
    // conversation has no messages at all — an agent created it to write
    // into, so we owe it the first message. FALSE = we spoke last
    // (Waiting, or Chasing once `lastMessageAt` passes the cutoff).
    //
    // Written in `messages.ts`'s `insertMessageAndUpdateConversation`,
    // the single `insert("messages")` in the backend, so it cannot drift
    // from the fact it records.
    //
    // Both values are written EXPLICITLY, unlike `leadAnalyses.archived`
    // (true-or-absent). That rule guards an accumulating set whose
    // complement must never read past it; this is a genuine two-way
    // partition where both sides are bounded and both need an exact
    // range. `undefined` is not a third lane — it is a pre-backfill row,
    // eliminated by `inboxBackfill` before any lane tab ships.
    //
    // Deliberately NOT a mirror of any engine's state. Waiting vs
    // Chasing is a RANGE on `lastMessageAt`, computed at read time by
    // `lib/inbox/lanes.ts` — see the spec's §Why time-derived and not
    // sequence-derived for the three defects a mirror produced.
    awaitingReply: v.optional(v.boolean()),
  })
    .index("by_account", ["accountId"])
    .index("by_contact", ["contactId"])
    // Phase 2, Task 1: the Inbox list orders conversations by recency of
    // activity, not creation time — Convex indexes order by the indexed
    // field(s) then `_creationTime`, so a plain `by_account` scan can't
    // give `lastMessageAt`-desc ordering on its own. `lastMessageAt` is
    // optional (a brand new conversation with no messages yet has none);
    // Convex sorts a missing field before every present value, so in
    // `.order("desc")` those rows deterministically fall to the end of
    // the page rather than scattering randomly or erroring.
    .index("by_account_last_message", ["accountId", "lastMessageAt"])
    // `unreadTotal` (the app-wide sidebar badge) counts this account's
    // conversations with `unreadCount > 0`. Ranging that test on the
    // index instead of filtering in JS bounds both the read set and —
    // because a Convex subscription re-runs when any document it read
    // changes — the invalidation set: without it, the `lastMessageAt`
    // patch every message writes re-runs a full-account scan for every
    // connected client. Deliberately NOT a prefix of `by_account`:
    // Convex appends `_creationTime` to each index, so `by_account` is
    // `["accountId", "_creationTime"]` and cannot express this range.
    .index("by_account_unread", ["accountId", "unreadCount"])
    // `dashboard.metrics` counts the account's OPEN conversations. Same
    // reasoning as `deals.by_account_status`: the open set tracks current
    // workload, the closed set grows forever, and a `status` `.filter()`
    // after a `by_account` scan read both.
    .index("by_account_status", ["accountId", "status"])
    // `conversations.list` (the Inbox) narrows by assignment two ways: the
    // caller's role scope, and the Mine/Unassigned tab. Both were expressed
    // as a `.filter()` on top of `by_account_last_message` — and a Convex
    // `.filter()` inside `.paginate()` is the same trap as `.filter().take()`:
    // it does not narrow the index traversal, so the runtime keeps reading
    // until `numItems` MATCHES accumulate, and every document scanned counts
    // against the 4096 read limit.
    //
    // The pathological cases are ordinary, not exotic: an agent opening
    // "Mine" before anything is assigned to them, or "Unassigned" once the
    // pool has been worked down — a *well-run* inbox. Both match nothing
    // near the front of the index and scan to the end.
    //
    // `assignedToUserId` before `lastMessageAt` so an equality on the
    // assignee still leaves recency as the range/order key. Optional field:
    // Convex sorts missing before every present value, so `q.eq(field,
    // undefined)` is a real, single range over exactly the unassigned pool.
    .index("by_account_assigned_last_message", [
      "accountId",
      "assignedToUserId",
      "lastMessageAt",
    ])
    // The Inbox's active list. `archivedAt` sits between `accountId` and
    // `lastMessageAt` so `eq(accountId).eq(archivedAt, undefined)` is a
    // real single range over the active set, still ordered by recency.
    // The Archived tab uses the complementary `gt("archivedAt", 0)`
    // range on this same index — which orders by `archivedAt`, i.e.
    // most-recently-archived first. That is a deliberate semantic
    // difference from the active tab's recency ordering, and the right
    // one for a review queue.
    .index("by_account_archived_last_message", [
      "accountId",
      "archivedAt",
      "lastMessageAt",
    ])
    // Same, for the single-assignee plan (the Mine / Unassigned tabs).
    // Two indexes rather than one because `conversations.list` has two
    // distinct indexable plans: "any" needs global recency order, and
    // "eq" binds the assignee first. A four-key index cannot serve both.
    .index("by_account_archived_assigned_last_message", [
      "accountId",
      "archivedAt",
      "assignedToUserId",
      "lastMessageAt",
    ])
    // `dashboard.metrics`' open-conversation tile. `by_account_status`
    // alone counts archived threads as open, and that error only grows,
    // because archiving accumulates. The archive dimension has to be in
    // the INDEX rather than a JS filter: that query's whole read-bound
    // argument is "every document in this range is a match, so there is
    // no `.filter()` to starve" — a post-take filter would both break
    // that property and silently under-report, since the take would fill
    // with archived rows.
    .index("by_account_archived_status", ["accountId", "archivedAt", "status"])
    // The Inbox's lane tabs. Every key before `lastMessageAt` is bound by
    // EQUALITY — including `archivedAt` as `eq(undefined)` — leaving that
    // final key free for both the range and the ordering:
    //   Active  = no range,               order desc
    //   Waiting = gt(cutoff),             order desc
    //   Chasing = gt(0).lte(cutoff),      order ASC (longest-neglected first)
    // Waiting and Chasing are complementary ranges on one key, so they
    // are provably disjoint and exhaustive with no coordinating state.
    //
    // Chasing's `gt(0)` is the "field present" idiom
    // `qualificationEngine.getDueSessions` uses: `lastMessageAt` is
    // optional and Convex sorts a missing field before every present
    // value, so without it a message-less conversation would fall into
    // Chasing.
    //
    // Lanes are NOT available on the Archived tab: there `archivedAt` is
    // ranged (`gt(0)`), and index keys after a range key are unordered —
    // the same constraint the archived branch of `conversations.list`
    // already hit with `assignedToUserId`.
    .index("by_account_lane_last_message", [
      "accountId",
      "archivedAt",
      "snoozedUntil",
      "chasingForcedAt",
      "awaitingReply",
      "lastMessageAt",
    ])
    // Same, for the single-assignee plan (Mine / Unassigned), and for
    // the auto-assign sweep's per-candidate Chasing-load count. Two
    // indexes rather than one for the reason the archive pair documents:
    // "any" needs global recency order, "eq" binds the assignee first,
    // and no single index serves both.
    .index("by_account_assigned_lane_last_message", [
      "accountId",
      "archivedAt",
      "assignedToUserId",
      "snoozedUntil",
      "chasingForcedAt",
      "awaitingReply",
      "lastMessageAt",
    ])
    // The wake sweep's partition: `gt(0).lte(now)` is every snooze that
    // has come due. Deployment-global, no accountId — the same shape as
    // `qualificationSessions.by_due` and `leadAnalyses.by_score_due`.
    .index("by_snoozed_until", ["snoozedUntil"]),

  // A single WhatsApp message within a `conversations` thread. Postgres
  // never gave `messages` its own `account_id` (tenancy was transitive via
  // `conversation_id` -> `conversations.account_id`); it's denormalized
  // here so this high-volume table gets a direct `by_account` index.
  // `senderId` stays an untyped optional string: it was a bare, FK-less
  // UUID in Postgres that no current write path actually populates (see
  // `src/types/index.ts`'s `Message.sender_id?: string`). `contentType`
  // includes `"interactive"` and `interactiveReplyId` exists because
  // migration 035's own header comment documents both as already applied
  // by migration 010 ("Migration 010 already added 'interactive' to the
  // content_type CHECK and the inbound interactive_reply_id column").
  messages: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    senderType: v.union(
      v.literal("customer"),
      v.literal("agent"),
      v.literal("bot"),
    ),
    senderId: v.optional(v.string()),
    contentType: v.union(
      v.literal("text"),
      v.literal("image"),
      v.literal("document"),
      v.literal("audio"),
      v.literal("video"),
      v.literal("location"),
      v.literal("template"),
      v.literal("interactive"),
      v.literal("contacts"),
    ),
    contentText: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    // R2 object key for this message's media — the durable replacement
    // for `mediaUrl`, which stored a resolved absolute URL and therefore
    // had to be rewritten row-by-row to move storage providers. Readers
    // resolve `mediaKey ?? mediaUrl` (see `convex/lib/r2/url.ts`), so
    // pre-cutover rows keep working untouched. `mediaUrl` is retained
    // until the Plan 2 backfill is verified, then dropped separately.
    mediaKey: v.optional(v.string()),
    templateName: v.optional(v.string()),
    messageId: v.optional(v.string()), // Meta wamid
    status: v.union(
      v.literal("sending"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("failed"),
    ),
    replyToMessageId: v.optional(v.id("messages")),
    interactivePayload: v.optional(v.any()),
    // The Cloud API `contacts` array we sent (outbound contact cards) —
    // rendered by the inbox as a card bubble. `contentText` keeps a
    // readable fallback for previews/older clients.
    contactsPayload: v.optional(v.any()),
    interactiveReplyId: v.optional(v.string()),
    // AI transcription of an inbound voice note / vision description of
    // an inbound image (aiReply media understanding, 2026-07-18) —
    // rendered into the assistant's transcript so replies address the
    // actual content.
    aiTranscription: v.optional(v.string()),
    // True when the AI auto-reply bot generated this message (migration
    // 033). Postgres: NOT NULL DEFAULT false; optional here for the same
    // reason as the conversations AI columns (late addition, no Convex
    // default). Already surfaced optional in `src/types/index.ts`
    // (`Message.ai_generated?: boolean`).
    aiGenerated: v.optional(v.boolean()),
    // The full Click-to-WhatsApp ad referral, on the FIRST inbound message
    // that carried it. `storedImageUrl` is the durable Convex-storage copy
    // of the ad image (Task 3), patched in after ingest.
    referral: v.optional(
      v.object({
        sourceType: v.optional(v.union(v.literal("ad"), v.literal("post"))),
        sourceId: v.optional(v.string()),
        sourceUrl: v.optional(v.string()),
        headline: v.optional(v.string()),
        body: v.optional(v.string()),
        mediaType: v.optional(v.union(v.literal("image"), v.literal("video"))),
        imageUrl: v.optional(v.string()),
        videoUrl: v.optional(v.string()),
        thumbnailUrl: v.optional(v.string()),
        storedImageUrl: v.optional(v.string()),
        storedImageKey: v.optional(v.string()),
      }),
    ),
    // Meta's per-message billing outcome, captured from the status
    // webhook (`statuses[].pricing`). All sub-fields optional and raw:
    // Meta is mid-migration between conversation-based ("CBP") and
    // per-message ("PMP") pricing, which spell categories differently.
    // Phase 4 aggregates this for spend reporting.
    pricing: v.optional(
      v.object({
        billable: v.optional(v.boolean()),
        model: v.optional(v.string()),
        category: v.optional(v.string()),
        type: v.optional(v.string()),
        capturedAt: v.number(),
      }),
    ),
    // Meta's stated reason a `failed` status could not be delivered,
    // captured from the same status webhook as `pricing` above
    // (`statuses[].errors[0]`). DIAGNOSTIC ONLY, added after 435 of 583
    // internal delivery alerts failed silently: Meta accepts a send
    // synchronously (returns a wamid) and reports `failed` asynchronously,
    // and `errors[0]` is the only place it ever states why. This field
    // exists so that the NEXT such investigation has that reason to read —
    // self-hosted Convex keeps no log history, so without it the reason is
    // gone the moment the webhook finishes processing. All sub-fields
    // optional and raw, same trade as `pricing`: Meta does not guarantee
    // `message`/`error_data.details` are present even when `code`/`title`
    // are.
    deliveryError: v.optional(
      v.object({
        code: v.optional(v.number()),
        title: v.optional(v.string()),
        message: v.optional(v.string()),
        details: v.optional(v.string()),
        capturedAt: v.number(),
      }),
    ),
  })
    .index("by_conversation", ["conversationId"])
    // Per-conversation, per-senderType lookups: `ingest.ingestInbound`'s
    // first-CUSTOMER-message detection (the webhook path — an outbound-only
    // thread must not be scanned end-to-end) and `qualificationEngine`'s
    // last-customer-message check. Ranging `senderType` in the index bounds
    // both to the customer partition instead of a post-scan `.filter()`.
    .index("by_conversation_sender", ["conversationId", "senderType"])
    .index("by_message_id", ["messageId"])
    .index("by_account", ["accountId"])
    // `dashboard.activity`'s "newest N customer messages" feed. Ranging
    // `senderType` on the index returns only that sender's rows, so a long
    // run of non-customer messages (a broadcast fan-out) can no longer
    // force a scan past Convex's read limit the way a post-scan
    // `.filter(senderType===...)` on `by_account` did.
    .index("by_account_sender", ["accountId", "senderType"]),

  // Hourly message counts per account — the read-bounded source for the
  // dashboard's messages-per-day chart.
  //
  // `dashboard.conversationsSeries` used to `.collect()` every message in
  // the requested window: bounded by the window, but NOT by traffic, so
  // against the 4096-read ceiling it broke at ~137 msg/day on the default
  // 30-day view and ~45 msg/day on the 90-day one. A chart cannot be
  // rescued with a `.take()` — that returns a partial, silently wrong
  // chart, which is worse than a slow one — so the counts are accumulated
  // on write instead, at the single `insert("messages")` choke point in
  // `messages.ts`.
  //
  // Hourly and UTC, deliberately: the chart's day boundaries depend on the
  // viewer's `tzOffsetMinutes`, so a DAY-keyed rollup would have to pick a
  // timezone at write time. Hourly UTC buckets are timezone-neutral to
  // write and re-bucket into correct local days on read for any whole-hour
  // offset, while making the read cost a function of the window (24 rows
  // per day, ~2160 for 90 days) rather than of volume. See
  // `lib/messageStats.ts` for the half-hour-offset caveat.
  messageHourlyStats: defineTable({
    accountId: v.id("accounts"),
    // Start of the UTC hour — `lib/messageStats.ts`'s `hourStartMs`.
    hourStartMs: v.number(),
    // `senderType === "customer"`; everything else (agent + bot) is
    // outgoing, matching what the chart previously counted per message.
    incoming: v.number(),
    outgoing: v.number(),
    // Reply-latency rollup powering `dashboard.responseTime`, which had the
    // SAME unbounded-`.collect()` bug the counts above exist to fix and blew
    // up the same way in production ("too many system operations", which
    // crashed the whole /dashboard route). Sum + count rather than a
    // pre-divided average so the read can aggregate hours into local
    // days-of-week and week-over-week figures and still get an EXACT mean —
    // averaging stored averages would weight a quiet hour like a busy one.
    //
    // Bucketed by the hour of the CUSTOMER message, not of the reply, because
    // that is what the chart bars are keyed on. The write therefore lands on
    // whichever (possibly hours-old) bucket the question arrived in — see
    // `recordResponseSample` in messages.ts.
    //
    // Optional: added after `incoming`/`outgoing` shipped, so pre-existing
    // rows have neither. Readers treat absent as zero, and
    // `backfillResponseHourlyStats` fills the current window.
    responseCount: v.optional(v.number()),
    responseTotalMs: v.optional(v.number()),

    // ---- Reports rollup (docs/superpowers/specs/2026-08-05-reports-
    // section-design.md). Every field below is optional and read as zero
    // when absent — the same convention `responseCount`/`responseTotalMs`
    // established — so this deploy changes nothing observable and no
    // existing row needs touching.

    /** Conversations created in this hour. Written at the single
     *  `conversations.insertConversation` choke point.
     *
     *  READ THIS BEFORE PUTTING IT ON A CHART. Every path that creates a
     *  conversation is find-or-create BY CONTACT with no status/archived
     *  filter (`ingest.ts`, `conversations.findOrCreateForContact` and its
     *  server-only twin, `qualificationEngine.ts`), so a contact has
     *  exactly ONE conversation, forever. This counter therefore counts a
     *  contact's FIRST and only conversation: it is a NEW-CONTACT count,
     *  not a measure of repeat engagement. A returning customer messaging
     *  again months later reuses their existing thread and adds nothing
     *  here. Label it accordingly in the UI. */
    conversationsStarted: v.optional(v.number()),
    /** Of those, the ones that arrived from a Click-to-WhatsApp ad.
     *  Written by `adReferrals.recordAdReferral`, which patches the
     *  CONVERSATION's creation hour — the referral is recorded after the
     *  row exists, so this lands on an hour in the past exactly like
     *  `recordResponseSample` does. Inherits the same
     *  one-conversation-per-contact caveat as `conversationsStarted`
     *  above: capped at one per contact ever, so a retargeting campaign
     *  that re-engages known contacts contributes zero to it. */
    conversationsStartedAd: v.optional(v.number()),
    /** Reply-latency histogram, alongside the existing sum+count. A single
     *  `withinTarget` counter would bake one SLA threshold in at write time
     *  and make history meaningless the day the target changes; six buckets
     *  cost the same patch, are exact at every edge, and let p50/p90 be
     *  interpolated as a range. See `lib/reportStats.ts`. */
    responseBuckets: v.optional(
      v.object({
        m1: v.number(),
        m5: v.number(),
        m15: v.number(),
        m60: v.number(),
        m240: v.number(),
        over: v.number(),
      }),
    ),
    /** Distinct Meta conversation WINDOWS observed opening in this hour.
     *  Written by `applyStatusPricing` on the branch that records a NEW
     *  `conversationMetaId` — that branch is the dedup, since a status
     *  callback fires repeatedly (sent → delivered → read) for one message.
     *
     *  NOT "billable": that branch carries no billability check, so
     *  free-entry-point windows are counted here too — which is exactly
     *  what `freeEntryPointConversations` below means by "of those". A
     *  panel labelling this "billable conversations" would overstate
     *  Meta's charge by precisely the free count; the billable figure, if
     *  one is ever shown, is this counter MINUS that one. Named for what
     *  it measures rather than for what it was first mistaken for. */
    metaConversations: v.optional(v.number()),
    /** Of those, the ones Meta flagged free-entry-point (the 72h CTWA
     *  window) and therefore did NOT bill. Same branch, same dedup. */
    freeEntryPointConversations: v.optional(v.number()),
    /** Messages by Meta billing category. Incremented only when the message
     *  had no `pricing` yet, so repeated callbacks cannot double-count.
     *  `other` catches spellings from Meta's CBP/PMP migration that we do
     *  not map — without it the categories would stop summing to the
     *  message count. */
    billedMessagesByCategory: v.optional(
      v.object({
        marketing: v.number(),
        utility: v.number(),
        service: v.number(),
        authentication: v.number(),
        free: v.number(),
        other: v.number(),
      }),
    ),
    /** Distinct conversations that saw any traffic — inbound or outbound.
     *  Deduped per UTC DAY, not per hour: distinct counts are not additive
     *  across buckets, so an hourly dedup summed into a day would yield
     *  conversation-HOURS and could exceed the account's total conversation
     *  count. The increment lands on the hour of the conversation's first
     *  message of that UTC day, so the rollup stays hourly and the existing
     *  local-day fold keeps working. See `conversations.lastActiveDayMs`. */
    activeConversations: v.optional(v.number()),
  })
    // Range on the hour so a window read is a genuine index range rather
    // than an account scan with a post-filter.
    .index("by_account_hour", ["accountId", "hourStartMs"]),

  // The /dashboard KPI tiles, precomputed — one row per account, refreshed
  // by the `dashboard-snapshot` cron.
  //
  // WHY THIS TABLE EXISTS. The tiles used to be `dashboard.metrics`, a live
  // aggregation measured in production at 1,882 document reads and ~8s of
  // wall clock: a `.take(501)` over open conversations, two-day windows over
  // `conversations`/`contacts`, and — the bulk of it — a ~1,300-row
  // `messages` collect computing a "messages sent today" figure NO component
  // ever rendered. Nine such subscriptions fired concurrently on page load,
  // and on this deployment the first read to touch `messages` pays a cold
  // penalty (measured: 12.7s for a SINGLE document, ~1.4s warm), so the
  // route's time-to-content was dominated by work nobody was waiting on.
  //
  // Reading a KPI tile is now one indexed point read. The cost did not
  // vanish — it moved onto a cron, where no one is watching the spinner.
  //
  // The tiles are consequently STALE by up to the cron interval, which is
  // why `computedAtMs` is not optional: the UI states the age rather than
  // presenting a lagging figure as live. Anything a salesperson acts on in
  // the moment (the Needs Attention queue, unread badges) stays a live
  // subscription and is deliberately NOT snapshotted here.
  dashboardSnapshots: defineTable({
    accountId: v.id("accounts"),
    /** When the cron last rebuilt this row. Rendered, not just recorded. */
    computedAtMs: v.number(),

    // ---- Current-state counts. No timezone interpretation, so they are
    // plain scalars rather than the hourly buckets below.
    /** Open, non-archived conversations, clamped to `activeConversationsCap`.
     *  Nothing in the app auto-closes a conversation, so this partition
     *  grows without bound and the count is a `.take()` — see
     *  `dashboard.refreshSnapshots`. */
    activeConversations: v.number(),
    /** True when the real figure exceeds `activeConversations`, so the UI
     *  renders "500+" rather than presenting the ceiling as exact. */
    activeConversationsCapped: v.boolean(),
    /** The ceiling that produced the two fields above, stored rather than
     *  assumed: a row written under an older cap must not be re-read under
     *  a newer one and silently mean something else. */
    activeConversationsCap: v.number(),
    openDealsValue: v.number(),
    openDealsCount: v.number(),

    /** Conversations awaiting a reply, PRE-SPLIT BY ROLE SCOPE.
     *
     *  Load-bearing, not premature generality. `conversations.unreadTotal`
     *  — which this replaces on the dashboard — is role-scoped: supervisor+
     *  see every thread, an agent sees their own plus the unassigned pool,
     *  a viewer sees the pool alone. A single account-wide total would show
     *  an agent other people's workload, so the snapshot stores each scope's
     *  count and the read picks one. `byUser` carries only members with a
     *  non-zero count. */
    waitingOnReply: v.object({
      /** Supervisor+ — every awaiting thread in the account. */
      all: v.number(),
      /** Unassigned threads. A viewer's whole world, and half an agent's. */
      pool: v.number(),
      /** Assigned threads, per assignee. Absent user = zero. */
      byUser: v.array(
        v.object({ userId: v.id("users"), count: v.number() }),
      ),
    }),

    /** New contacts per UTC hour over the newest `SNAPSHOT_HOURS`, bucketed
     *  from `contacts._creationTime`. Hours with no arrivals are omitted.
     *
     *  Hourly rather than a pre-folded "today" scalar for the reason
     *  `messageHourlyStats`'s own header gives: a day boundary is the
     *  VIEWER's-timezone concept and a cron runs in UTC, so folding at write
     *  time would bake one timezone in. `dashboard.snapshot` folds these
     *  into the caller's local day on read. */
    recentHours: v.array(
      v.object({
        hourStartMs: v.number(),
        newContacts: v.number(),
        /** Of those, Click-to-WhatsApp ad arrivals. */
        newContactsAd: v.number(),
        /** Conversations created in this hour that are open and unarchived
         *  AS OF the refresh. Feeds the Active Conversations tile's
         *  today-vs-yesterday delta — a current-state count has no clean
         *  "vs yesterday" without historical snapshots, so what the tile
         *  compares is the flow of NEW open threads, not yesterday's
         *  standing total. */
        newOpenConversations: v.number(),
      }),
    ),
  })
    // One row per account, so this is a point lookup and never a scan.
    .index("by_account", ["accountId"]),

  // Hourly rollup behind the /reports Funnel tab — the same move
  // `messageHourlyStats` already made for the message charts, for the same
  // reason and after the same measurement.
  //
  // `reports.funnelOverview` used to `.collect()` `funnelTransitions` and
  // `conversionEvents` over the requested window. Both reads are bounded by
  // the WINDOW but not by TRAFFIC: measured on production at 2,029 + 2,012 =
  // 4,041 documents for a 30-day range, entirely a function of how busy the
  // account was. That is the shape that has already taken this deployment
  // down twice (see `messageHourlyStats`'s header), and it grows with the
  // business rather than with the question being asked. Reading the rollup
  // makes the cost a function of the WINDOW alone — two counters per UTC
  // day, ~30 rows for a month, ~90 for a quarter — no matter how busy the
  // account gets.
  //
  // HOURLY, for exactly the reason `messageHourlyStats`'s header gives, and
  // this table shipped DAILY first and was wrong for it. A report window is
  // built from LOCAL midnights (`reportWindow` in src/lib/reports/types.ts),
  // and a local midnight is not a UTC midnight: for the UTC+4 account this
  // runs on, `dayStartMs(sinceMs)` rounds down 20 hours, so every window
  // dragged in 20 extra hours of the preceding day. Measured against
  // production before the fix: the 7-day Ads figure came back 22.7% high
  // (513 against a true 418) and the 14-day 6.5% high. A 30-day window
  // happened to agree only because this account has no data that far back.
  //
  // An hour is the coarsest bucket that folds exactly into any whole-hour
  // timezone offset, which is the whole point of the pattern. It costs
  // ~464 rows for a 30-day window against 4,053 raw event rows — still an
  // 8.7x read cut, and correct at the edges rather than approximately
  // right in the middle.
  //
  // WHY EVERY COUNTER HERE IS ADDITIVE, which is the property that makes a
  // rollup legitimate at all. A distinct count is NOT additive across
  // buckets: summing "distinct conversations that reached `purchased`" over
  // 30 daily buckets yields conversation-DAYS and can exceed the account's
  // conversation count (the trap `messageHourlyStats.activeConversations`
  // documents). `stageFirstReached` sidesteps it by counting each
  // conversation's FIRST EVER arrival at a stage, decided at write time
  // against the transition log — so a conversation contributes to exactly
  // one bucket per stage, for all time, and any sum over any set of buckets
  // is a true distinct count.
  //
  // The metric that makes exact is "conversations that first reached stage
  // S within the window", where the live query counted "conversations that
  // reached S within the window". They differ only for a conversation that
  // re-enters a stage it has already visited — possible, since the manual
  // `funnel.setStage` path does not pass `neverDowngrade` and can reopen a
  // purchased deal. Measured across this account's entire history: ZERO
  // conversations have ever re-entered a stage, so the two definitions
  // return identical numbers today. First-reach is also the more defensible
  // of the two going forward, since it cannot be inflated by reopening.
  funnelHourlyStats: defineTable({
    accountId: v.id("accounts"),
    /** Start of the UTC hour — `lib/messageStats.ts`'s `hourStartMs`. */
    hourStartMs: v.number(),

    /** Per stage, conversations reaching it for the FIRST time this day.
     *  Additive across days; see the table comment. Exhaustive over
     *  `FUNNEL_STAGES` rather than a `Record<string, number>`, so adding a
     *  stage is a compile error here rather than a silently uncounted one. */
    stageFirstReached: v.object({
      new_lead: v.number(),
      qualified: v.number(),
      price_quoted: v.number(),
      itinerary_created: v.number(),
      itinerary_sent: v.number(),
      invoice_sent: v.number(),
      purchased: v.number(),
      lost: v.number(),
    }),

    /** Recorded sale value from `purchased` transitions landing this day.
     *  A plain sum, so it is additive without qualification — unlike
     *  `purchase.count`, which rides `stageFirstReached.purchased`. */
    purchaseValueTotal: v.number(),

    /** Meta delivery status counts for `conversionEvents` CREATED this day.
     *
     *  Keyed on the event's creation day and NOT on when its status last
     *  changed, which is what keeps this exact against a MUTABLE field: a
     *  retry that moves an event pending -> sent decrements `pending` and
     *  increments `sent` in the event's original creation-day bucket, so the
     *  bucket always reflects those events' CURRENT statuses. Keying on the
     *  change instead would let one event contribute to two days. Every
     *  status write goes through `reportRollup.moveConversionEventStatus`
     *  for exactly this reason. */
    eventsByStatus: v.object({
      pending: v.number(),
      sent: v.number(),
      unmatched: v.number(),
      error: v.number(),
      abandoned: v.number(),
      dormant: v.number(),
    }),
  })
    // Range on the hour so a window read is a genuine index range rather
    // than an account scan with a post-filter.
    .index("by_account_hour", ["accountId", "hourStartMs"]),

  // One row per (message, actor) reaction. `conversationId` is denormalized
  // here exactly like Postgres denormalized it (migration 009: "so Supabase
  // Realtime can filter on it with a plain eq"). `accountId` is likewise
  // denormalized off `messageId`/`conversationId` (P1 review — not a
  // Postgres column) for the same uniform account-scoping reason as
  // `pipelineStages` below. `actorId` is a bare,
  // FK-less identifier in Postgres and is genuinely polymorphic in the
  // app: a `users` id when `actorType === "agent"` (`/api/whatsapp/react`)
  // or a `contacts` id when `actorType === "customer"` (the inbound
  // webhook) — so it stays an untyped optional string rather than a
  // `v.id(...)` of either table.
  messageReactions: defineTable({
    accountId: v.id("accounts"),
    messageId: v.id("messages"),
    conversationId: v.id("conversations"),
    actorType: v.union(v.literal("customer"), v.literal("agent")),
    actorId: v.optional(v.string()),
    emoji: v.string(),
  })
    .index("by_message_actor", ["messageId", "actorType", "actorId"])
    .index("by_message", ["messageId"])
    .index("by_conversation", ["conversationId"])
    .index("by_account", ["accountId"]),

  // A named deal pipeline (e.g. "Sales"), owned by an account.
  pipelines: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
  }).index("by_account", ["accountId"]),

  // An ordered stage within a pipeline (e.g. "Qualified", "Won").
  // `accountId` is denormalized off `pipelineId` (P1 review) — Postgres
  // itself never had this column (tenancy was transitive via
  // `pipeline_id`), but it's added here for the same uniform
  // account-scoped querying every other table gets (matches
  // `messages`/`contactTags`/`broadcastRecipients`).
  pipelineStages: defineTable({
    accountId: v.id("accounts"),
    pipelineId: v.id("pipelines"),
    name: v.string(),
    position: v.number(),
    color: v.string(),
  })
    .index("by_pipeline", ["pipelineId"])
    .index("by_account", ["accountId"]),

  // A deal/opportunity tracked against a pipeline stage. `assignedToUserId`
  // is the old `assigned_to` column (migration 002) — it referenced
  // `profiles(id)` in Postgres, not `auth.users(id)` directly, but
  // conceptually (like `conversations.assignedToUserId`) it names the
  // assigned user. `contactId` is optional: migration 004
  // (contact_delete_set_null) dropped its NOT NULL and made the FK
  // ON DELETE SET NULL, so a deal survives its contact being deleted.
  deals: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    pipelineId: v.id("pipelines"),
    stageId: v.id("pipelineStages"),
    contactId: v.optional(v.id("contacts")),
    conversationId: v.optional(v.id("conversations")),
    title: v.string(),
    value: v.number(),
    currency: v.optional(v.string()),
    notes: v.optional(v.string()),
    expectedCloseDate: v.optional(v.number()),
    status: v.union(v.literal("open"), v.literal("won"), v.literal("lost")),
    assignedToUserId: v.optional(v.id("users")),
    // Same on-UPDATE-trigger parity as `conversations.updatedAt` above
    // (P1 review) — the deals board sorts on it too.
    updatedAt: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_pipeline", ["pipelineId"])
    .index("by_stage", ["stageId"])
    .index("by_contact", ["contactId"])
    // `dashboard.metrics` wants the account's OPEN deals (its former
    // sibling reader, `dashboard.pipelineDonut`, was deleted as orphaned
    // in Task B6). Filtering `status` after a `by_account` scan read
    // every deal the account had ever closed to find the ones still
    // live. The open set tracks current workload and is roughly
    // steady-state; the closed set only ever grows — so ranging `status`
    // converts a read that grows forever into one that does not.
    .index("by_account_status", ["accountId", "status"])
    // `dashboard.activity` wants the 10 most-recently-UPDATED deals (any
    // status — a deal opened long ago but just moved to "Won" must
    // surface). `_creationTime`, the implicit trailing key on every other
    // index here, cannot express that. NOTE: `updatedAt` is optional, and
    // Convex sorts a missing field before every present value, so
    // descending it sorts LAST — see `activity`'s comment and the test
    // that pins it.
    .index("by_account_updated", ["accountId", "updatedAt"]),

  // A custom field definition (e.g. "Birthday") an account can attach
  // values of to any contact via `contactCustomValues`.
  customFields: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    fieldName: v.string(),
    fieldType: v.string(), // freeform in Postgres too — no CHECK constraint
    fieldOptions: v.optional(v.any()),
  }).index("by_account", ["accountId"]),

  // One value of one custom field on one contact. `accountId` is
  // denormalized off `contactId` (P1 review) for the same uniform
  // account-scoping reason as `pipelineStages` above.
  contactCustomValues: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    customFieldId: v.id("customFields"),
    value: v.optional(v.string()),
  })
    .index("by_contact_field", ["contactId", "customFieldId"])
    .index("by_contact", ["contactId"])
    .index("by_account", ["accountId"])
    // `contacts.byCustomFieldValue` (the broadcast composer's audience
    // filter) and `customFields.remove`'s cascade both want one field's
    // value rows across every contact. `by_contact_field` cannot serve that
    // — its prefix is `contactId`, so it can only answer "this contact's
    // value for this field", not "every contact's value for this field".
    // On `by_account` the `customFieldId` test was a `.filter()`, i.e. a
    // scan of every custom value in the account. Grows with contacts ×
    // fields.
    .index("by_account_field", ["accountId", "customFieldId"]),

  // A note an account member left on a contact — the account's audit
  // trail. Written by hand from the inbox AND automatically by five
  // engines (funnel transitions, AI tag acceptance, sales-checklist
  // steps, qualification, invitations), which is why the human-facing
  // fields below are ALL optional: an engine-written row carries only
  // `noteText`, and nothing about this table's history is rewritten.
  contactNotes: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    createdByUserId: v.optional(v.id("users")),
    noteText: v.string(),

    // Which thread the note was written in. Absent on engine-written
    // rows and on notes added from the contacts page, which is why the
    // inline thread query tolerates a null result.
    conversationId: v.optional(v.id("conversations")),

    // HOW the contact happened — the channel this system cannot see.
    // Absent on legacy and engine-written rows; `noteKindOf` in
    // `src/lib/inbox/notes.ts` derives a display kind for those.
    kind: v.optional(
      v.union(
        v.literal("call"),
        v.literal("whatsapp_external"),
        v.literal("meeting"),
        v.literal("email"),
        v.literal("payment"),
        v.literal("general"),
      ),
    ),

    // WHAT IT MEANS. `do_not_contact` is the only value with teeth: it
    // sets `contacts.doNotContact`, which gates automation in Phase 3.
    outcome: v.optional(
      v.union(
        v.literal("no_answer"),
        v.literal("follow_up"),
        v.literal("do_not_contact"),
        v.literal("not_interested"),
      ),
    ),

    // R2 objects under `{accountId}/note/…`. Bounded at
    // NOTE_ATTACHMENT_MAX_COUNT by the mutation, not the schema —
    // a schema can't express a max length.
    attachments: v.optional(
      v.array(
        v.object({
          key: v.string(),
          filename: v.string(),
          contentType: v.string(),
          size: v.number(),
        }),
      ),
    ),

    editedAt: v.optional(v.number()),

    // Set by `clearDoNotContact` on the note that raised the flag. The
    // `outcome` itself is NEVER erased — it records what the customer
    // actually said, and `update` still refuses to change it. This
    // records that a supervisor later overrode it, so the card can show
    // both facts instead of claiming a block that is no longer in force.
    outcomeClearedAt: v.optional(v.number()),
  })
    .index("by_contact", ["contactId"])
    .index("by_account", ["accountId"])
    // The inline thread renders ONE conversation's notes. On
    // `by_contact` that would over-read every note the contact has
    // across every thread; this binds the conversation directly.
    .index("by_conversation", ["conversationId"]),

  // ============================================================
  // Messaging + Settings (Phase 1, Task 2). Source: supabase/migrations
  // 001_initial_schema.sql, 003_broadcast_recipient_wamid.sql,
  // 004_contact_delete_set_null.sql, 005_broadcast_counts_incremental.sql,
  // 013_whatsapp_config_phone_number_id_unique.sql,
  // 014_message_templates_meta_integration.sql,
  // 015_whatsapp_config_registration.sql, 017_account_sharing.sql,
  // 019_invitation_rpcs.sql (RPCs only — no schema change),
  // 024_member_presence.sql, 026_api_keys.sql, 027_notifications.sql,
  // 028_webhook_endpoints.sql, 035_interactive_messages.sql. Every one
  // of these 10 tables was swept across all 35 migrations (grep "ALTER
  // TABLE <table>") rather than just the named ones above, precisely
  // because Task 1 found late migrations (029/033) adding columns to a
  // table outside its named set — see the task report for what that
  // sweep changed here.
  // ============================================================

  // A local catalog row for one Meta message-template (language)
  // variant. `status` started as a TitleCase 4-value enum (001) and was
  // swapped for the raw Meta enum by migration 014, which also added
  // every Meta-integration column below (`sampleValues` through
  // `lastSubmittedAt`). `language`/`status` are optional because neither
  // was ever declared NOT NULL in Postgres (only `category`/`bodyText`
  // were) — `headerMediaUrl` is a sweep addition: 014's own header
  // comment documents it (URL fallback for media headers) right next to
  // `headerHandle`, but the task brief's tricky-notes list named only
  // the latter.
  messageTemplates: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
    category: v.union(
      v.literal("Marketing"),
      v.literal("Utility"),
      v.literal("Authentication"),
    ),
    language: v.optional(v.string()), // default "en_US"
    headerType: v.optional(
      v.union(
        v.literal("text"),
        v.literal("image"),
        v.literal("video"),
        v.literal("document"),
      ),
    ),
    headerContent: v.optional(v.string()),
    bodyText: v.string(),
    footerText: v.optional(v.string()),
    buttons: v.optional(v.any()),
    // Raw Meta enum — migration 014 dropped the earlier TitleCase set.
    status: v.optional(
      v.union(
        v.literal("DRAFT"),
        v.literal("PENDING"),
        v.literal("APPROVED"),
        v.literal("REJECTED"),
        v.literal("PAUSED"),
        v.literal("DISABLED"),
        v.literal("IN_APPEAL"),
        v.literal("PENDING_DELETION"),
      ),
    ),
    sampleValues: v.optional(
      v.object({
        body: v.optional(v.array(v.string())),
        header: v.optional(v.array(v.string())),
      }),
    ),
    metaTemplateId: v.optional(v.string()),
    rejectionReason: v.optional(v.string()),
    qualityScore: v.optional(
      v.union(v.literal("GREEN"), v.literal("YELLOW"), v.literal("RED")),
    ),
    headerHandle: v.optional(v.string()),
    headerMediaUrl: v.optional(v.string()),
    headerMediaKey: v.optional(v.string()),
    submissionError: v.optional(v.string()),
    lastSubmittedAt: v.optional(v.number()),
    // Same on-UPDATE-trigger parity as `conversations.updatedAt` (P1 review).
    updatedAt: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_name_lang", ["accountId", "name", "language"])
    // Webhook status updates identify templates by meta_template_id
    // (migration 014's own `idx_message_templates_meta_template_id`).
    .index("by_meta_template_id", ["metaTemplateId"]),

  // A scheduled/sent bulk send of one template to a filtered audience.
  // Counters (`sentCount` etc.) are `v.number()`, not optional — like
  // `conversations.unreadCount` in Task 1, Postgres never marked them
  // NOT NULL either, but every insert supplies 0 and migration 005's
  // incremental trigger only ever adjusts from there.
  broadcasts: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
    templateName: v.string(),
    templateLanguage: v.string(), // NOT NULL DEFAULT 'en_US'
    templateVariables: v.optional(v.any()),
    audienceFilter: v.optional(v.any()),
    scheduledAt: v.optional(v.number()),
    status: v.union(
      v.literal("draft"),
      v.literal("scheduled"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
    ),
    totalRecipients: v.number(),
    sentCount: v.number(),
    deliveredCount: v.number(),
    readCount: v.number(),
    repliedCount: v.number(),
    failedCount: v.number(),
    // Same on-UPDATE-trigger parity as `conversations.updatedAt` (P1 review).
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One row per (broadcast, contact) send. `contactId` is optional:
  // migration 004 dropped its NOT NULL and made the FK ON DELETE SET
  // NULL so history survives contact deletion — the same reasoning
  // Task 1 used for `deals.contactId`, except 004 is inside *this*
  // task's swept migration set, so (unlike the open question Task 1
  // flagged for `deals`) there's no ambiguity here: `contactId` is
  // optional. `accountId` is denormalized — Postgres never had one on
  // this table (tenancy was transitive via `broadcast_id`) — because
  // the brief calls for a direct `by_account` index, the same treatment
  // Task 1 gave the high-volume `messages` table.
  broadcastRecipients: defineTable({
    accountId: v.id("accounts"),
    broadcastId: v.id("broadcasts"),
    contactId: v.optional(v.id("contacts")),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("replied"),
      v.literal("failed"),
    ),
    sentAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    readAt: v.optional(v.number()),
    repliedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    whatsappMessageId: v.optional(v.string()), // Meta wamid (migration 003)
  })
    .index("by_broadcast", ["broadcastId"])
    // `maybeFinalizeBroadcast` runs once per delivered recipient and asks
    // "is any recipient still pending?". `.filter()` runs *after* the
    // index scan, so on `by_broadcast` alone each probe walked past the
    // already-resolved recipients piling up at the front of the range —
    // O(N^2) reads to finalize an N-recipient broadcast. Binding `status`
    // makes that probe O(1); `startSendingInternal`'s pending set uses
    // the same range.
    .index("by_broadcast_status", ["broadcastId", "status"])
    .index("by_account", ["accountId"])
    // `contacts.remove`'s SET NULL cascade wants one contact's recipient
    // rows. On `by_account` alone that read the account's ENTIRE broadcast
    // history and narrowed it with a `.filter()`, which does not narrow what
    // Convex reads. This table is the spikiest in the schema — one send
    // inserts a row per recipient at once — so the scan a single contact
    // deletion pays grows with total broadcast volume, not with that
    // contact's. `contactId` is optional (this cascade is what clears it);
    // Convex sorts missing values before all present ones, so a `.eq` range
    // on a present id is unaffected.
    .index("by_account_contact", ["accountId", "contactId"])
    .index("by_wamid", ["whatsappMessageId"]),

  // A reusable inbox-composer snippet — either plain text or a saved
  // interactive (buttons/list) payload. `createdByUserId` is author/
  // audit only, same as everywhere else (never used for tenancy).
  quickReplies: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    title: v.string(),
    kind: v.union(v.literal("text"), v.literal("interactive")),
    contentText: v.optional(v.string()),
    interactivePayload: v.optional(v.any()),
    // Same on-UPDATE-trigger parity as `conversations.updatedAt` (P1 review).
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One WhatsApp Cloud API connection per account. `createdByUserId`
  // (Postgres `user_id`) predates multi-tenant accounts — migration 017
  // dropped its UNIQUE constraint in favor of UNIQUE(account_id), but
  // never dropped the column itself, so it stays as audit metadata like
  // every other former-owner column in this file. `accessToken` is
  // encrypted at rest by `whatsappConfig.upsert` itself (Phase 8 Task 3
  // moved this off the Next.js app layer and onto the same inline
  // `encrypt()`/`decrypt()` helper `aiConfigs.apiKey` below already
  // uses), so it stays a plain `v.string()` rather than a structured
  // type.
  whatsappConfig: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    phoneNumberId: v.string(),
    wabaId: v.optional(v.string()),
    accessToken: v.string(),
    verifyToken: v.optional(v.string()),
    status: v.union(v.literal("connected"), v.literal("disconnected")),
    connectedAt: v.optional(v.number()),
    // Meta Cloud API registration state (migration 015).
    registeredAt: v.optional(v.number()),
    subscribedAppsAt: v.optional(v.number()),
    lastRegistrationError: v.optional(v.string()),
    // Same on-UPDATE-trigger parity as `conversations.updatedAt` (P1 review).
    updatedAt: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_phone_number_id", ["phoneNumberId"])
    // `matchVerifyToken` runs on every Meta webhook GET handshake and used
    // to scan this whole table. Indexable precisely BECAUSE `verifyToken` is
    // stored as plain text (see `upsert` — only `accessToken` is encrypted),
    // so the value arriving in `hub.verify_token` is the stored key itself.
    // The index therefore holds no secret the document did not already hold
    // in the clear. If `verifyToken` is ever encrypted to match
    // `accessToken` — the open question `matchVerifyToken`'s own comment
    // raises — this index stops working and the lookup has to move to a
    // stored hash of the token, not ciphertext (which is per-row salted and
    // so not equality-comparable).
    .index("by_verify_token", ["verifyToken"]),

  // One outstanding invite link. `tokenHash` is a SHA-256 digest, never
  // the plaintext token (same pattern as `apiKeys.keyHash` below).
  // `role` excludes "owner" — migration 017's CHECK (role <> 'owner')
  // means an invite can only ever grant admin/agent/viewer.
  accountInvitations: defineTable({
    accountId: v.id("accounts"),
    tokenHash: v.string(),
    role: v.union(v.literal("admin"), v.literal("supervisor"), v.literal("agent"), v.literal("viewer")),
    createdByUserId: v.optional(v.id("users")),
    label: v.optional(v.string()),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    acceptedByUserId: v.optional(v.id("users")),
  })
    .index("by_account", ["accountId"])
    .index("by_token_hash", ["tokenHash"]),

  // A machine credential for the public REST API. Only `keyHash` (SHA-
  // 256 of the plaintext) is stored, never the key itself; `keyPrefix`
  // is a non-secret display string. `scopes` stays a plain string array
  // — migration 026's header comment: "a future scope is a code change,
  // not a migration" — so the vocabulary is enforced in the app layer.
  apiKeys: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
    keyPrefix: v.string(),
    keyHash: v.string(),
    scopes: v.array(v.string()),
    lastUsedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_key_hash", ["keyHash"]),

  // An account-registered HTTPS endpoint this CRM POSTs events to. Unlike
  // `apiKeys.keyHash` (a bearer credential the *client* presents, so we
  // only need a hash), `secret` is the HMAC key *we* sign outgoing
  // payloads with, so the plaintext is needed at delivery time — it's
  // AES-256-GCM-encrypted at rest instead of hashed.
  webhookEndpoints: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    url: v.string(),
    secret: v.string(),
    events: v.array(v.string()),
    isActive: v.boolean(),
    lastDeliveryAt: v.optional(v.number()),
    failureCount: v.number(),
  }).index("by_account", ["accountId"]),

  // An in-app notification for one agent. `userId` is the recipient —
  // unlike every other `*UserId` field in this file, it is NOT an audit
  // column. `type` started as migration 027's single CHECK-allowed value
  // ("conversation_assigned") and has since grown to the six literals
  // below; it stays an explicit union rather than a bare string so each
  // new type is a visible, typed change instead of a silent widening.
  // `convex/notifications.ts`'s header lists the five hand-copied
  // declarations that must be updated together whenever it grows.
  notifications: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    type: v.union(
      v.literal("conversation_assigned"),
      v.literal("lead_qualified"),
      // Assigned-agent reply-SLA breach (customer waiting on a taken
      // chat) — targets supervisors+.
      v.literal("sla_alert"),
      // Proxy Meta Purchase fired for a highly-qualified lead
      // (purchase-signals spec §3.5).
      v.literal("purchase_signal"),
      // An archived conversation came back — the customer replied
      // (spec 2026-07-26 §"Stopping and returning").
      v.literal("lead_returned"),
      // No eligible agent existed when the auto-assign sweep reached an
      // unowned Chasing thread, so it stayed in the pool. Silence would
      // recreate the invisible-orphan problem one level up. Additive
      // union literal — the `lead_returned` precedent; existing rows
      // stay valid.
      v.literal("chase_unassigned"),
    ),
    conversationId: v.optional(v.id("conversations")),
    contactId: v.optional(v.id("contacts")),
    // Who triggered it; NULL means an automation/system action.
    actorUserId: v.optional(v.id("users")),
    title: v.string(),
    body: v.optional(v.string()),
    readAt: v.optional(v.number()),
  })
    // Every read here is "this recipient, in this account" — binding both
    // on the index replaces a `by_user` scan of the caller's whole
    // cross-account history plus a JS `accountId` filter. Ordering falls
    // through to the appended `_creationTime`, so `.order("desc")` still
    // yields newest-first for `list`/`listRecent`.
    .index("by_user_account", ["userId", "accountId"])
    // Adds `readAt` so the unread set is an index range, not a filter:
    // the header bell mounts app-wide and must never read the caller's
    // whole history to render a badge capped at "9+". `markAllRead`
    // patches through the same range. A separate index from
    // `by_user_account` because that one orders by `_creationTime` —
    // `readAt` sits between, so neither can serve the other's query.
    .index("by_user_account_read", ["userId", "accountId", "readAt"])
    // Kept alongside the two indexes above: callers added after this
    // branch was cut (qualification engine + its tests) still read
    // `by_user`/`by_account`, and dropping a live index mid-deploy is
    // exactly the failure mode the deploy runbook forbids. Redundant with
    // the composite indexes for THIS module's queries only.
    .index("by_account", ["accountId"])
    .index("by_user", ["userId"]),

  // Ownership history for one conversation — the Inbox thread's inline
  // "X assigned this to Y" line. `conversations.assignedToUserId` is a
  // bare field with no history: before this table the only trace of a
  // handover was a private `notifications` row to the recipient, so
  // "who gave me this, and when" was unanswerable by anyone else.
  //
  // Deliberately NOT `contactNotes`: notes are user-deletable
  // (`contactNotes.remove`), they store a baked English sentence (this
  // UI is translated and members get renamed), and they are the
  // AI-processable trail that `contactActivity` reads — assignment
  // churn belongs in none of those.
  //
  // `kind` is what happened to ownership; `source` is which machinery
  // did it. Separate on purpose: a new entry point adds one `source`
  // literal instead of a branch in the renderer. `actorUserId` absent
  // means the system did it (sweep, automation, cron). Written by
  // exactly one function — `lib/assignment.ts`'s `applyAssignment` —
  // and never updated or deleted.
  conversationEvents: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    kind: v.union(v.literal("assigned"), v.literal("unassigned")),
    actorUserId: v.optional(v.id("users")),
    targetUserId: v.optional(v.id("users")),
    previousUserId: v.optional(v.id("users")),
    source: v.union(
      v.literal("manual"),
      v.literal("takeover"),
      v.literal("release"),
      v.literal("auto_assign"),
      v.literal("automation"),
      v.literal("offer_accept"),
    ),
  })
    .index("by_conversation", ["conversationId"])
    // `reports.assignmentsByAgent` (the /reports Agents tab) counts, per
    // local day, how many distinct conversations each agent picked up.
    // That is a window over the whole ACCOUNT's handovers, which
    // `by_conversation` cannot express at all — it would mean visiting
    // every conversation in the account to read its trail.
    //
    // Convex appends `_creationTime` to every index, so this one is
    // really `["accountId", "_creationTime"]` and
    // `eq(accountId).gte(_creationTime, sinceMs).lt(_creationTime,
    // untilMs)` is a genuine single range over exactly the requested
    // window — every document read is a match, with no `.filter()` on
    // top that could starve the take. Both edges are bound for the reason
    // `reports.ts`'s `readHours` documents on its own: the fold pools
    // every row it is handed with no further per-row test, so an
    // unbounded upper read would corrupt the counts, not merely cost
    // extra reads.
    //
    // These rows are never updated or deleted, so the range is
    // append-only and a descending take always reaches the newest days
    // first.
    .index("by_account", ["accountId"]),

  // One Web Push subscription = one browser/device for one user. A user
  // may have several (phone + laptop). `by_endpoint` is the upsert/prune
  // key; `by_user` loads a recipient's devices when sending.
  pushSubscriptions: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_endpoint", ["endpoint"])
    .index("by_user", ["userId"])
    .index("by_account", ["accountId"]),

  // Per-user, per-account notification preferences. An absent row means
  // defaults (push enabled, message preview shown).
  notificationPreferences: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    pushEnabled: v.boolean(),
    hidePreview: v.boolean(),
  }).index("by_user_account", ["userId", "accountId"]),

  // Lightweight online/away heartbeat, one row per user. Postgres's
  // primary key WAS `user_id` (a genuine one-row-per-user constraint);
  // here that becomes a plain field plus an enforcing `by_user` index
  // the future `touchPresence` mutation checks before upserting.
  memberPresence: defineTable({
    userId: v.id("users"),
    accountId: v.id("accounts"),
    status: v.union(v.literal("online"), v.literal("away")),
    lastSeenAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_account", ["accountId"]),

  // ============================================================
  // Automations + Flows (Phase 1, Task 3). Source: supabase/migrations
  // 006_automations.sql, 007_automations_increment_counter.sql (RPC
  // only — no schema change), 010_flows.sql,
  // 012_flows_increment_counter.sql (RPC only), 016_flow_media.sql,
  // 017_account_sharing.sql, 020_account_sharing_followups.sql
  // (indexes only). All 8 tables were swept across every migration
  // (grep "ALTER TABLE <table>"), not just the named set, per Task
  // 1/2's own precedent of late migrations touching tables outside
  // their named source list. Two real findings from that sweep:
  //   - Migration 017 added `account_id` (NOT NULL) to `automations`,
  //     `automationLogs`, `flows`, `flowRuns`, and the pending-execution
  //     queue table (whose Convex counterpart, `automationPendingExecutions`,
  //     was never written by any code path and was dropped in Task B7) —
  //     but NOT to `automationSteps`, `flowNodes`, or `flowRunEvents` in
  //     Postgres, which stayed tenant-scoped only transitively via their
  //     parent FK (same pattern as `pipelineStages`/`contactCustomValues`
  //     in Task 1). The Phase 1 final review denormalizes `accountId` onto
  //     the surviving tables of that set in Convex (see each table below),
  //     matching the direct-index treatment already given to `messages`/
  //     `contactTags`/`broadcastRecipients`. Migration 017 also swapped `flowRuns`'s
  //     "one active run per contact" partial unique index from
  //     `(user_id, contact_id)` to `(account_id, contact_id)`.
  //   - Migration 016 widened `flow_nodes.node_type`'s CHECK to add
  //     `'send_media'` — this task's own tricky-notes list enumerates
  //     only 10 of the resulting 11 values; the 11th (`send_media`)
  //     only turns up by actually reading migration 016, which is why
  //     it's included in the union below.
  // Every `user_id` FK to auth.users on these tables stays audit/
  // assignment metadata post-017 (migration 017's own header: "no
  // longer used for tenancy isolation") — mapped to `createdByUserId`
  // like every other bare `user_id` column in this file.
  // ============================================================

  // The definition envelope for one automation ("when X happens, do
  // Y"). `triggerType` stays a plain string, not a union: unlike
  // `flows.triggerType` below, Postgres never put a CHECK on this
  // column (the closed `AutomationTriggerType` set in
  // src/types/index.ts is enforced only at the app layer) — same
  // reasoning Task 1 used for `customFields.fieldType`. `updatedAt` is
  // new: Postgres maintains it with an on-UPDATE trigger (Convex has
  // none), but the app reads it (`select('*')` plus the
  // `Automation.updated_at` type) the same way `flows.updatedAt`
  // below is both read and explicitly written by the flow-edit route,
  // so it's modeled here too rather than silently dropped.
  automations: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
    description: v.optional(v.string()),
    triggerType: v.string(),
    triggerConfig: v.optional(v.any()),
    isActive: v.boolean(),
    executionCount: v.number(),
    lastExecutedAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
    // Cancel this automation's WAITING runs for a contact the moment
    // that contact replies. Optional and default-off: `Wait → Send →
    // Wait → Send` is the most common automation shape, and without this
    // a customer who already answered keeps receiving scheduled nags —
    // but turning it on for every existing automation would change
    // behaviour under owners who never asked for it.
    stopOnReply: v.optional(v.boolean()),
  }).index("by_account", ["accountId"]),

  // One node in an automation's step tree. `parentStepId`/`branch` are
  // both unset for root-level steps; a Condition step's 'yes'/'no'
  // children set both. `stepType` has no DB-level CHECK in Postgres
  // (unlike `flowNodes.nodeType` below) but the brief calls for a
  // union anyway — cross-checked against the exhaustive `switch
  // (step.step_type)` in src/lib/automations/engine.ts (13 cases) and
  // the `AutomationStepType` closed set in src/types/index.ts; both
  // agree on exactly these 13 values, so there's no hidden 14th like
  // `flowNodes.nodeType` had with `send_media`.
  automationSteps: defineTable({
    // Denormalized off `automationId` (P1 review) — see the section
    // header comment above for why Postgres never had this column.
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
    // A stable per-step identity. NOT the row id: `replaceSteps` deletes
    // and reinserts every step row on each save (see
    // `convex/automations.ts`), so `_id` churns constantly and anything
    // keyed on it — per-step counters, a suspended run's position —
    // silently detaches after one edit. Same role, and same reasoning, as
    // `flowNodes.nodeKey` below.
    //
    // Optional because rows written before this field existed have none.
    // Readers derive an effective key as `stepKey ?? _id`, so old rows
    // keep working. Both sides must apply that fallback or the two can
    // never be joined: the WRITE side does it in `automationsEngine.ts`
    // (`step.stepKey ?? step._id`, for `automationStepStats.stepKey` and a
    // parked run's `currentStepKey`), the READ side in `convex/
    // automations.ts`'s `toStepRow` — the single adapter every reader of
    // this table's tree goes through.
    //
    // The next save of such a step then ADOPTS that effective key as its
    // real one (the builder round-trips it via `toApiSteps` -> `id`, and
    // `insertStepsTree` reuses any non-empty incoming key verbatim) rather
    // than minting a fresh one — so counters accumulated under the old row
    // id carry over instead of being orphaned. Only a step that has never
    // been saved at all gets a freshly minted key.
    stepKey: v.optional(v.string()),
    parentStepId: v.optional(v.id("automationSteps")),
    branch: v.optional(v.union(v.literal("yes"), v.literal("no"))),
    stepType: v.union(
      v.literal("send_message"),
      v.literal("send_buttons"),
      v.literal("send_list"),
      v.literal("send_template"),
      v.literal("add_tag"),
      v.literal("remove_tag"),
      v.literal("assign_conversation"),
      v.literal("update_contact_field"),
      v.literal("create_deal"),
      v.literal("wait"),
      v.literal("condition"),
      v.literal("send_webhook"),
      v.literal("close_conversation"),
    ),
    stepConfig: v.optional(v.any()),
    position: v.number(),
  })
    .index("by_automation", ["automationId"])
    .index("by_account", ["accountId"])
    .index("by_account_step_key", ["accountId", "stepKey"]),

  // An audit row written once per automation execution (one per
  // triggering event, not per step — `stepsExecuted` is the per-step
  // detail array). `contactId` is nullable / ON DELETE SET NULL so
  // history survives contact deletion (mirrors migration 004's
  // pattern Task 1 already used for `deals.contactId`).
  automationLogs: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    automationId: v.id("automations"),
    contactId: v.optional(v.id("contacts")),
    triggerEvent: v.string(),
    stepsExecuted: v.optional(v.any()),
    status: v.union(
      v.literal("success"),
      v.literal("partial"),
      v.literal("failed"),
    ),
    errorMessage: v.optional(v.string()),
  })
    .index("by_account", ["accountId"])
    // `logs` (filtered by automation) and `remove`'s cascade both want one
    // automation's rows. On `by_account` alone that is a scan of the
    // account's ENTIRE log history with an `automationId` `.filter()`
    // applied afterwards — and a Convex `.filter()` does not narrow what is
    // read. This table grows with every automation execution, so it is the
    // fastest-growing per-account table once automations see real use.
    // Keeping `accountId` as the prefix leaves tenancy enforced by the index
    // itself rather than by a post-scan predicate, so a foreign
    // `automationId` still yields nothing.
    .index("by_account_automation", ["accountId", "automationId"]),

  // One row per (automation, contact) enrolment — the thing an
  // `automationLogs` row cannot express. A log says what HAPPENED; a run
  // says where a contact IS. Before this table a `wait` step called
  // `ctx.scheduler.runAfter` and persisted nothing, so a queued contact
  // was invisible, uncountable and uncancellable, and deleting an
  // automation left its resumes to fire into the void.
  //
  // `scheduledFnId` is what makes a wait cancellable. Same mechanism as
  // `flowRuns.fallbackTimeoutId` below, for the same reason.
  automationRuns: defineTable({
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
    // Nullable for the same reason as `automationLogs.contactId`: history
    // must survive contact deletion.
    contactId: v.optional(v.id("contacts")),
    conversationId: v.optional(v.id("conversations")),
    status: v.union(
      v.literal("running"),
      v.literal("waiting"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    // The suspension point. All four travel together so a wait nested
    // inside a condition branch resumes back into THAT branch — the same
    // tuple `resume` already takes as arguments.
    currentStepKey: v.optional(v.string()),
    parentStepId: v.optional(v.id("automationSteps")),
    branch: v.optional(v.union(v.literal("yes"), v.literal("no"))),
    nextPosition: v.number(),
    resumeAt: v.optional(v.number()),
    scheduledFnId: v.optional(v.id("_scheduled_functions")),
    logId: v.optional(v.id("automationLogs")),
    context: v.optional(v.any()),
    startedAt: v.number(),
    updatedAt: v.number(),
    endedAt: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    // How many LIVE scheduled resumes this run currently has pending.
    // Every other suspension field above is singular — they describe ONE
    // suspension point — but a condition can fan out into branches that
    // each suspend independently, and each reaches its own entry call on
    // resume. Without a count, `finishRun` fires once per branch: the
    // terminal status stays correct (Task 3 made a recorded failure win
    // regardless of call order) but `endedAt` is rewritten each time, and
    // a straggler failing after an earlier branch already closed the run
    // would flip it long after the fact.
    //
    // `createRun` seeds this at 1 (the initial dispatch is itself one
    // live "lineage" until it either finishes or suspends).
    // `markRunWaiting` increments it ONLY for a suspension that is
    // genuinely new — a nested `condition` branch spawned within the
    // current dispatch (`executeStepsFrom`'s `isEntryCall: false`
    // recursion). A lineage's OWN entry-call scope suspending on its own
    // `wait` is net-zero: that scheduled resume already firing is what
    // produced this invocation, so parking on a new wait merely moves
    // the SAME live slot forward rather than creating another one.
    // `finishRun` is the only decrement, called unconditionally whenever
    // an entry call's own scope runs out of steps without itself hitting
    // another `wait` (whether it finishes cleanly, fails, or merely
    // finishes DELEGATING to a child branch that is still suspended) —
    // exactly the complement of the "net-zero" case above. A run may
    // only be finished (status/`endedAt` written) once the count reaches
    // zero.
    //
    // Fix wave (2026-08): a previous version incremented on every
    // `wait` unconditionally and only ever decremented via `finishRun`'s
    // "scope completed without suspending" path — which a re-suspending
    // ENTRY call (two or more sequential waits in the same lineage)
    // never reaches, since the `wait` case returns immediately. That
    // stranded any automation with 2+ sequential waits at `status:
    // "running"` forever, one credit short each additional wait. The
    // seed-at-1 + net-zero-for-the-entry-call's-own-wait shape above is
    // the fix; see `automationsEngine.ts`'s `markRunWaiting` and
    // `executeStepsFrom` for the mechanism.
    outstandingBranches: v.optional(v.number()),
  })
    .index("by_account_automation", ["accountId", "automationId"])
    // The counts query and the per-step canvas chips both want "this
    // automation's rows in this status". Keeping status in the index
    // rather than filtering after the read matters because this table
    // grows with every enrolment, exactly like `automationLogs`.
    .index("by_account_automation_status", ["accountId", "automationId", "status"])
    // Cancellation by contact: doNotContact and stopOnReply both ask
    // "which of this contact's runs are still waiting?".
    .index("by_account_contact_status", ["accountId", "contactId", "status"]),

  // Cumulative per-step counters. Deliberately NOT columns on
  // `automationSteps`: those rows are the automation's DEFINITION, and
  // bumping a counter on them on every execution would put write traffic
  // on the same documents the builder edits. "Waiting at this step" is
  // absent on purpose — it is a live index read against `automationRuns`,
  // so storing it would be a second source of truth that can drift.
  automationStepStats: defineTable({
    accountId: v.id("accounts"),
    automationId: v.id("automations"),
    stepKey: v.string(),
    reached: v.number(),
    sent: v.number(),
    failed: v.number(),
    updatedAt: v.number(),
  })
    .index("by_account_automation", ["accountId", "automationId"])
    .index("by_account_step_key", ["accountId", "stepKey"]),

  // The definition envelope for one conversational flow (bot). Mirrors
  // `automations` above but for the graph-based engine. `entryNodeId`
  // references `flowNodes.nodeKey` (a stable string the migration's
  // own comment calls out as deliberately NOT the row's UUID — see
  // `flowNodes` below), so it stays `v.optional(v.string())`, never a
  // `v.id(...)`. `updatedAt`: same reasoning as `automations` above,
  // except here there's direct proof the app writes it by hand —
  // `src/app/api/flows/[id]/route.ts`'s PATCH handler sets
  // `updated_at: new Date().toISOString()` itself rather than relying
  // solely on the (Convex-less) DB trigger.
  flows: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    name: v.string(),
    description: v.optional(v.string()),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("archived"),
    ),
    triggerType: v.union(
      v.literal("keyword"),
      v.literal("first_inbound_message"),
      v.literal("manual"),
    ),
    triggerConfig: v.optional(v.any()),
    entryNodeId: v.optional(v.string()),
    fallbackPolicy: v.optional(v.any()),
    executionCount: v.number(),
    lastExecutedAt: v.optional(v.number()),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One node in a flow's graph. Edges live inside `config` (e.g. each
  // button carries its own next-node key) rather than a separate edge
  // table — see migration 010's header for why. `nodeKey` is a stable
  // string, not the row id, so edges/`entryNodeId` survive a clone
  // without UUID rewriting. `nodeType`'s union has 11 values, not the
  // 10 this task's tricky-notes list literally enumerates: migration
  // 016 (named in this task's source list) widened the CHECK to add
  // `'send_media'` after 010 shipped the original 10 — caught by
  // reading 016 directly rather than trusting the summarized list.
  // `positionX`/`positionY` are reserved for the not-yet-built v2
  // react-flow canvas (migration 010's own comment); the v1 list
  // editor always writes 0.
  flowNodes: defineTable({
    // Denormalized off `flowId` (P1 review) — see the section header
    // comment above for why Postgres never had this column.
    accountId: v.id("accounts"),
    flowId: v.id("flows"),
    nodeKey: v.string(),
    nodeType: v.union(
      v.literal("start"),
      v.literal("send_buttons"),
      v.literal("send_list"),
      v.literal("send_message"),
      v.literal("send_media"),
      v.literal("collect_input"),
      v.literal("condition"),
      v.literal("set_tag"),
      v.literal("handoff"),
      v.literal("http_fetch"),
      v.literal("end"),
    ),
    config: v.optional(v.any()),
    positionX: v.number(),
    positionY: v.number(),
  })
    .index("by_flow_node_key", ["flowId", "nodeKey"])
    .index("by_account", ["accountId"]),

  // Per-contact runtime state machine for a flow. Postgres's
  // `started_at` (`NOT NULL DEFAULT NOW()`, never subsequently
  // updated) is deliberately NOT modeled as its own field — it's set
  // at the same instant the row is created and nothing ever changes
  // it, so it's exactly what `_creationTime` already gives for free
  // (the same "don't duplicate created_at" reasoning the Global
  // Constraints spell out, just under a different column name).
  // `lastAdvancedAt` IS modeled: unlike `startedAt` it's genuinely
  // mutated every time the runner advances the state machine, and the
  // cron sweep (`idx_flow_runs_active_advanced`) queries it directly.
  // `contactId`/`conversationId` are nullable / ON DELETE SET NULL so
  // history survives contact deletion (same pattern as
  // `automationLogs.contactId` above). The "one active run per
  // account+contact" partial UNIQUE from migration 017 (originally
  // per-user from 010) becomes the plain `by_account_contact` index —
  // Convex has no partial indexes, so the actual one-active-run
  // invariant is enforced in the future engine mutation, not the
  // schema (same deferral the brief calls out).
  flowRuns: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    flowId: v.id("flows"),
    contactId: v.optional(v.id("contacts")),
    conversationId: v.optional(v.id("conversations")),
    status: v.union(
      v.literal("active"),
      v.literal("completed"),
      v.literal("handed_off"),
      v.literal("timed_out"),
      v.literal("paused_by_agent"),
      v.literal("failed"),
    ),
    currentNodeKey: v.optional(v.string()),
    lastPromptMessageId: v.optional(v.id("messages")),
    vars: v.optional(v.any()),
    repromptCount: v.number(),
    lastAdvancedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    endReason: v.optional(v.string()),
    // Phase 6, Task 4 addition — no Postgres counterpart (the original
    // stale-run cutoff was computed on the fly by a cron sweep,
    // `/api/flows/cron`, comparing `last_advanced_at` against
    // `fallback_policy.on_timeout_hours` on every poll). The Convex
    // engine has no cron: each active run instead gets its OWN
    // `ctx.scheduler.runAfter(...)` callback (`flowsEngine.timeout`)
    // scheduled directly, and this field is the id of that pending
    // scheduled function — needed so the engine can `ctx.scheduler.cancel`
    // the stale one before scheduling a fresh one on every genuine
    // advance (otherwise a customer who replies quickly would still get
    // timed out later by the ORIGINAL schedule). Cleared (patched to
    // `undefined`) whenever the run ends for any reason.
    fallbackTimeoutId: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_account_contact", ["accountId", "contactId"])
    .index("by_flow", ["flowId"])
    .index("by_status", ["status"]),

  // Append-only audit trail for a flow run — used by the runner for
  // idempotency (never advance twice on the same inbound message) and
  // the future run-history viewer. `eventType`'s 9-value union comes
  // straight off the CHECK in migration 010; no later migration alters
  // it (unlike `flowNodes.nodeType`).
  flowRunEvents: defineTable({
    // Denormalized off `flowRunId` (P1 review) — see the section header
    // comment above for why Postgres never had this column.
    accountId: v.id("accounts"),
    flowRunId: v.id("flowRuns"),
    eventType: v.union(
      v.literal("started"),
      v.literal("node_entered"),
      v.literal("message_sent"),
      v.literal("reply_received"),
      v.literal("fallback_fired"),
      v.literal("handoff"),
      v.literal("timeout"),
      v.literal("error"),
      v.literal("completed"),
    ),
    nodeKey: v.optional(v.string()),
    payload: v.optional(v.any()),
  })
    .index("by_run", ["flowRunId"])
    .index("by_account", ["accountId"]),

  // ============================================================
  // AI (Phase 1, Task 4 — final schema task). Source: supabase/migrations
  // 029_ai_reply.sql (ai_configs create), 030_ai_knowledge.sql
  // (ai_knowledge_documents + ai_knowledge_chunks create, plus
  // ai_configs.embeddings_api_key), 031_ai_reply_slot_grant.sql (GRANT
  // only — no schema change), 032_fix_ai_knowledge_membership.sql
  // (SECURITY DEFINER -> INVOKER on the two match_ai_knowledge_* RPCs
  // only — no schema change), 033_ai_reply_polish.sql
  // (ai_configs.handoff_agent_id, ai_usage_log create; also
  // messages.aiGenerated/conversations.aiHandoffSummary+aiAutoreply
  // Disabled+aiReplyCount, which land on Task 1's tables and are already
  // in schema.ts from that task, not repeated here). All four tables
  // were swept across every migration (grep "ALTER TABLE
  // ai_configs|ai_usage_log|ai_knowledge_documents|ai_knowledge_chunks")
  // per Tasks 1-3's own precedent — beyond `ENABLE ROW LEVEL SECURITY`,
  // the only real hits were the two `ai_configs` column adds (030, 033)
  // already folded in below.
  // ============================================================

  // The account's AI reply assistant setup (bring-your-own-key), one row
  // per account. UNIQUE(account_id) in Postgres -> `by_account` doubles
  // as the enforcing index (same treatment as `whatsappConfig` in Task
  // 2). `apiKey`/`embeddingsApiKey` are AES-256-GCM-encrypted ciphertext
  // at rest, encrypted inline by this table's own `upsert` mutation
  // (the same `encrypt()`/`decrypt()` helper `whatsappConfig.accessToken`
  // now also uses), so they stay plain `v.string()`/optional rather
  // than a structured type.
  // `autoReplyMaxPerConversation`'s Postgres CHECK (BETWEEN 1 AND 20)
  // has no Convex equivalent — enforced in the future settings mutation
  // instead. `updatedAt` WAS deliberately left unmodeled in the original
  // Task 4 pass (no route or component selected/ordered by it — checked
  // src/lib/ai/config.ts, src/app/api/ai/config/route.ts,
  // src/components/settings/ai-config.tsx). The Phase 1 final review
  // overrides that: every table with a Postgres on-UPDATE trigger now
  // gets `updatedAt` in Convex for uniform parity, so it's added below
  // alongside `whatsappConfig`/`quickReplies`/etc.
  aiConfigs: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    provider: v.union(v.literal("openai"), v.literal("anthropic")),
    model: v.string(),
    apiKey: v.string(), // AES-256-GCM-encrypted BYO provider key
    systemPrompt: v.optional(v.string()),
    isActive: v.boolean(),
    autoReplyEnabled: v.boolean(),
    // legacy, unread (owner decision 2026-07-18; plumbing removed Task
    // B7) — there is NO reply cap anymore, the bot answers every message
    // until a human takes the chat from the dashboard. Kept optional
    // in-schema only because dropping a field with data present fails
    // deploy validation; old rows may still carry a value here, but
    // `aiConfig.ts` no longer reads or writes it.
    autoReplyMaxPerConversation: v.optional(v.number()),
    // Migration 030: optional OpenAI-compatible embeddings key —
    // encrypted like `apiKey`; its presence turns on semantic KB
    // retrieval (else lexical-only).
    embeddingsApiKey: v.optional(v.string()),
    // legacy, unread (Migration 033; plumbing removed Task B7) — used to
    // be where auto-reply would hand a conversation off when the model
    // bailed; nothing enforces/reads it anymore (v3 kept the assistant on
    // the conversation instead — see qualificationEngine.ts's
    // completeQualification comment). Kept optional in-schema only
    // because dropping a field with data present fails deploy
    // validation; old rows may still carry a value here.
    handoffAgentId: v.optional(v.id("users")),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // Append-only per-LLM-call token usage log (cost visibility on the
  // account's BYO key). Source: migration 033. `conversationId` is
  // nullable — Postgres: `REFERENCES conversations(id) ON DELETE SET
  // NULL` — a draft not tied to one thread, or the conversation was
  // deleted between generation and logging (src/lib/ai/usage.ts's own
  // `LogAiUsageArgs.conversationId` comment). Dashboard reads are
  // "by account, newest-first" (Postgres's own composite index was
  // `(account_id, created_at DESC)`) — here that's `by_account` plus the
  // default `_creationTime` ordering, per the Global Constraints' "rely
  // on _creationTime" rule. Token counters are `v.number()`, not
  // optional: NOT NULL DEFAULT 0 in Postgres and every insert supplies a
  // real value (same treatment as `broadcasts`'s counters in Task 2).
  aiUsageLog: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.optional(v.id("conversations")),
    // Derived from `lib/aiUsageStats.ts`'s AI_USAGE_MODES, which carries
    // the per-mode rationale and is now the ONLY place the list is
    // written down. This union and `aiUsage.log`'s args validator used to
    // be two hand-maintained copies and drifted twice (`score`,
    // `match_service`) — each time the mutation rejected a write the
    // table allowed. Same idiom as `archivedReason` above.
    mode: v.union(...AI_USAGE_MODES.map((mode) => v.literal(mode))),
    provider: v.union(...AI_USAGE_PROVIDERS.map((p) => v.literal(p))),
    model: v.string(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
    // Both optional: rows written before the 2026-07-27 audit carry
    // neither, and not every provider/endpoint reports them (the
    // embeddings API has no notion of either). See `lib/ai/types.ts`'s
    // `AiUsage` for the subset invariants — `cachedPromptTokens` is part
    // of `promptTokens`, `reasoningTokens` part of `completionTokens`,
    // so summing them into a total would double-count.
    cachedPromptTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // Hourly AI token counts per account — the read-bounded source for the
  // /agents Usage tab.
  //
  // `aiUsage.summary` used to `.collect()` every `aiUsageLog` row in the
  // window and hand them to the client to aggregate: bounded by the
  // window, NOT by traffic. At the ~4,000 calls/day this deployment logs
  // that meant ~120,000 documents for the default 30-day view, so the
  // card never loaded at all — `Your request timed out performing too
  // many system operations`, the same failure `messageHourlyStats` above
  // exists to fix, thrown inside `useQuery` on a page with no Error
  // Boundary.
  //
  // Hourly and UTC for exactly the reasons `messageHourlyStats`
  // documents: the day boundaries belong to the viewer, so a day-keyed
  // rollup would have to pick a timezone at write time. See
  // `lib/aiUsageStats.ts` for the fold and the whole-hour-offset caveat.
  //
  // Written at the single `insert("aiUsageLog")` choke point in
  // `aiUsage.log`, so the rollup cannot drift from the ledger it
  // summarises. The raw rows stay: they are the audit trail, and the
  // backfill rebuilds these buckets from them.
  aiUsageHourlyStats: defineTable({
    accountId: v.id("accounts"),
    /** Start of the UTC hour — `lib/aiUsageStats.ts`'s `hourStartMs`. */
    hourStartMs: v.number(),
    calls: v.number(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
    /** Subset of `promptTokens`: served from the provider's prefix cache. */
    cachedPromptTokens: v.number(),
    /** Prompt tokens on the calls that actually REPORTED a cache figure,
     *  so the hit rate is not diluted by rows predating the telemetry or
     *  by endpoints (embeddings) that have no cache. A measured zero
     *  counts here; an absent figure does not. */
    cacheablePromptTokens: v.number(),
    /** Subset of `completionTokens`. */
    reasoningTokens: v.number(),
    // Arrays, not a column per mode and certainly not per model: the mode
    // list is closed but the MODEL list is open-ended (a new model string
    // must not need a migration), and `v.record` appears nowhere else in
    // this schema. Both stay tiny — at most one entry per mode (11) and
    // one per provider:model actually used in that hour.
    modes: v.array(
      v.object({
        mode: v.union(...AI_USAGE_MODES.map((mode) => v.literal(mode))),
        calls: v.number(),
        tokens: v.number(),
      }),
    ),
    models: v.array(
      v.object({
        provider: v.union(...AI_USAGE_PROVIDERS.map((p) => v.literal(p))),
        model: v.string(),
        calls: v.number(),
        tokens: v.number(),
        // The per-model token split, added 2026-08-17 so the usage tab
        // can price a model at all — `tokens` is the SUM of three spans
        // that bill at three different rates, so it is unpriceable on
        // its own (see `lib/aiUsageStats.ts`'s `ModelTally`).
        //
        // OPTIONAL for the hours written before that date, which have no
        // split and never will until `aiUsage.backfillAiUsageHourlyStats`
        // is re-run. Absent means UNKNOWN, not zero; the dashboard
        // excludes those models from spend and names them rather than
        // pricing them as free.
        promptTokens: v.optional(v.number()),
        completionTokens: v.optional(v.number()),
        cachedPromptTokens: v.optional(v.number()),
      }),
    ),
  }).index("by_account_hour", ["accountId", "hourStartMs"]),

  // Per-model provider prices, one row per (account, model). Powers the
  // spend figures on the /agents usage tab — `aiUsageLog` above has
  // carried the token counts since the 2026-07-27 audit, but the repo
  // held no price, so the tab could only report volume.
  //
  // Per account rather than global because rates are a property of the
  // account's own billing arrangement with its BYO provider, not of the
  // app: two accounts on different OpenAI tiers pay differently for the
  // same model id. `src/lib/ai/pricing.ts`'s DEFAULT_MODEL_RATES is the
  // fallback when no row exists here, and deliberately omits the models
  // whose prices we cannot verify.
  //
  // Rates are billing-class data — both functions in
  // `convex/aiModelRates.ts` gate on `ctx.requireRole("admin")`, the same
  // floor `aiUsage.summary` and `apiKeys.list` enforce.
  aiModelRates: defineTable({
    accountId: v.id("accounts"),
    provider: v.union(v.literal("openai"), v.literal("anthropic")),
    // The raw provider model id exactly as it appears in
    // `aiUsageLog.model`, because that is the key the dashboard joins on.
    model: v.string(),
    // All three in USD per 1,000,000 tokens. `cachedInputPerMTok` is
    // stored explicitly rather than derived as a fraction of
    // `inputPerMTok`: the ~10% cache-read ratio is provider policy that
    // can change, and differs from the cache-WRITE multiplier.
    inputPerMTok: v.number(),
    cachedInputPerMTok: v.number(),
    outputPerMTok: v.number(),
    updatedAt: v.number(),
    updatedByUserId: v.optional(v.id("users")),
  })
    .index("by_account", ["accountId"])
    .index("by_account_model", ["accountId", "model"]),



  // Fixed-window burst counter for AI auto-replies, one row per account.
  //
  // `RATE_LIMITS.aiAutoReplyAccount` (src/lib/rate-limit.ts) declared a
  // 30/min account budget that was never enforced anywhere — `rate-limit.ts`
  // is an in-process Map that only the Next.js `/api/v1` path ever calls,
  // so nothing bounded auto-reply spend on the BYO provider key. This table
  // moves that budget into Convex, where the auto-reply actually runs and
  // where the count is durable and shared across function instances.
  //
  // It PACES, it never drops. The owner's 2026-07-18 decision (see
  // `aiConfigs.autoReplyMaxPerConversation` above) is that the bot answers
  // every message, so exceeding the window re-schedules `dispatchInbound`
  // past the window edge rather than skipping the reply. That is also
  // strictly better for delivery: tripping the provider's own 429 fails the
  // reply outright, whereas pacing just moves it a few seconds.
  //
  // Fixed window, not sliding: one row and two fields, no per-call history
  // to accumulate or sweep. The tradeoff — up to 2x the limit across a
  // window boundary — is irrelevant here, where the point is to stay under
  // a provider's rate limit rather than to bill precisely.
  aiAutoReplyRate: defineTable({
    accountId: v.id("accounts"),
    windowStartMs: v.number(),
    count: v.number(),
  }).index("by_account", ["accountId"]),

  // One knowledge-base entry (title + body text) an account pastes in
  // to ground the AI assistant's drafts/auto-replies. Source: migration
  // 030. `updatedAt` IS modeled here (unlike `aiConfigs` above): the
  // list/detail routes actually select + `order by` it
  // (src/app/api/ai/knowledge/route.ts and .../[id]/route.ts) and the
  // settings component types it as an always-present field.
  aiKnowledgeDocuments: defineTable({
    accountId: v.id("accounts"),
    createdByUserId: v.optional(v.id("users")),
    title: v.string(),
    content: v.string(),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // A retrieval unit chunked from one `aiKnowledgeDocuments` row.
  // `accountId` is denormalized off the document exactly as Postgres
  // denormalized it ("so the match RPCs and RLS filter without a
  // join") — the same reasoning Task 1 gave `messages.accountId`.
  // `chunkIndex` is `v.number()`, not optional (NOT NULL DEFAULT 0,
  // every insert supplies a real index — same treatment as
  // `aiUsageLog`'s counters above).
  //
  // Two Postgres constructs have no direct Convex equivalent:
  //   - The generated `fts tsvector GENERATED ALWAYS AS
  //     (to_tsvector('simple', content)) STORED` column is DROPPED
  //     entirely per the Global Constraints ("Generated columns: omit
  //     them... use a `.searchIndex` on `content` instead") — replaced
  //     by the `search_content` search index below, which will back a
  //     `ctx.db.query(...).withSearchIndex(...)` in this table's own
  //     function-phase (replacing the `match_ai_knowledge_fts` RPC).
  //   - The pgvector `embedding vector(1536)` column becomes an
  //     optional float array + the `by_embedding` vector index below,
  //     replacing the `match_ai_knowledge_semantic` RPC (migrations 030
  //     + 032 — 032 only changed the RPCs' SECURITY mode, not the
  //     table). `embedding` stays optional: a chunk only gets one when
  //     the account has an embeddings key configured (lexical-only
  //     accounts leave every chunk's embedding unset, same as Postgres
  //     leaving it NULL).
  // Both new indexes only fully validate on `convex dev`'s deploy step
  // (not this task's offline `vitest`/`tsc` pass) — see the task report.
  aiKnowledgeChunks: defineTable({
    documentId: v.id("aiKnowledgeDocuments"),
    accountId: v.id("accounts"),
    chunkIndex: v.number(),
    content: v.string(),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_document", ["documentId"])
    .index("by_account", ["accountId"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["accountId"],
    })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["accountId"],
    }),

  // ============ Knowledge Engine v2 (Phase 1) ============
  // Entity-first KB: registry + typed entries + structured ops blocks
  // compiled into kbChunks. Legacy aiKnowledgeDocuments/-Chunks stay
  // untouched; retrieval merges both pools (aiKnowledge.retrieve).
  kbServices: defineTable({
    accountId: v.id("accounts"),
    key: v.string(),
    name: v.string(),
    aliases: v.array(v.string()),
    routingTagName: v.optional(v.string()),
    relatedServiceKeys: v.optional(v.array(v.string())),
    status: v.union(v.literal("active"), v.literal("paused")),
    sortOrder: v.number(),
    updatedAt: v.number(),
    createdByUserId: v.optional(v.id("users")),
  })
    .index("by_account", ["accountId"])
    .index("by_account_key", ["accountId", "key"]),

  kbEntries: defineTable({
    accountId: v.id("accounts"),
    scope: v.union(v.literal("company"), v.literal("service"), v.literal("package")),
    serviceKey: v.optional(v.string()),
    packageKey: v.optional(v.string()),
    type: v.union(
      v.literal("overview"),
      v.literal("faq"),
      v.literal("itinerary"),
      v.literal("requirements"),
      v.literal("policy"),
      v.literal("process"),
      v.literal("note"),
    ),
    title: v.string(),
    body: v.string(),
    audience: v.union(v.literal("customer"), v.literal("internal")),
    status: v.union(v.literal("draft"), v.literal("published")),
    version: v.number(),
    updatedAt: v.number(),
    updatedByUserId: v.optional(v.id("users")),
    publishedAt: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_service", ["accountId", "serviceKey"])
    .index("by_account_status", ["accountId", "status"]),

  kbOpsBlocks: defineTable({
    accountId: v.id("accounts"),
    serviceKey: v.string(),
    kind: v.union(v.literal("qualification"), v.literal("sales"), v.literal("purchase")),
    criteria: v.optional(v.array(v.object({
      key: v.string(),
      label: v.string(),
      question: v.optional(v.string()),
      marks: v.optional(v.number()),
    }))),
    steps: v.optional(v.array(v.object({
      key: v.string(),
      label: v.string(),
      description: v.optional(v.string()),
    }))),
    conditions: v.optional(v.array(v.object({
      key: v.string(),
      label: v.string(),
    }))),
    reportValue: v.optional(v.number()),
    currency: v.optional(v.string()),
    status: v.union(v.literal("draft"), v.literal("published")),
    version: v.number(),
    updatedAt: v.number(),
    updatedByUserId: v.optional(v.id("users")),
    publishedAt: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_service_kind", ["accountId", "serviceKey", "kind"]),

  kbChunks: defineTable({
    accountId: v.id("accounts"),
    sourceKind: v.union(v.literal("entry"), v.literal("ops")),
    entryId: v.optional(v.id("kbEntries")),
    opsBlockId: v.optional(v.id("kbOpsBlocks")),
    serviceKey: v.optional(v.string()),
    entryType: v.optional(v.string()),
    audience: v.union(v.literal("customer"), v.literal("internal")),
    chunkIndex: v.number(),
    content: v.string(),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_account", ["accountId"])
    .index("by_entry", ["entryId"])
    .index("by_ops_block", ["opsBlockId"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["accountId", "serviceKey", "audience"],
    })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["accountId", "serviceKey", "audience"],
    }),

  // One AI classification of a conversation into the account's tag
  // catalogue. `suggestedTagIds` is group-generic (a flat validated list
  // across all tag groups — respects each group's single/multi mode);
  // the UI renders it grouped. `status` tracks the review lifecycle.
  tagSuggestions: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    suggestedTagIds: v.array(v.id("tags")),
    note: v.optional(v.string()),
    confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    status: v.union(
      v.literal("auto_applied"),
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("dismissed"),
    ),
    model: v.string(),
    reviewedByUserId: v.optional(v.id("users")),
  })
    .index("by_account_status", ["accountId", "status"])
    .index("by_conversation", ["conversationId"]),

  // VESTIGIAL — the R2 media-storage migration retired every consumer of
  // this table. It used to tie a client-uploaded Convex `_storage` object
  // to the account that minted it (`_storage` carries no `accountId` of
  // its own, so a storage id, once minted, resolved for anyone holding
  // it — this table was the ONLY place a storage id was bound to a
  // tenant). `files.getUrl` and `files.registerUpload`, the two functions
  // that read and wrote it, are both DELETED: an R2 object key now
  // carries its own owner in its first path segment
  // (`convex/lib/r2/keys.ts`), minted server-side, so ownership is a
  // string comparison rather than a lookup-table join — see
  // `convex/files.ts`'s own header comment. `files.remove` (still live)
  // no longer touches this table at all.
  //
  // Left defined here, still unused, only because Convex schema
  // validation rejects removing a table that still holds production
  // rows. Drop this table (and run a prod purge of any lingering rows)
  // once the R2 migration's Plan 2 (backfill + legacy-storage cleanup)
  // has landed.
  fileOwners: defineTable({
    accountId: v.id("accounts"),
    storageId: v.id("_storage"),
  })
    .index("by_storage", ["storageId"])
    .index("by_account", ["accountId"]),

  // ============================================================
  // WA conversion attribution — HISTORICAL DATA ONLY (Task B5). One row
  // per detected attribution identifier (an `HY-XXXXXX` ref code or a
  // Meta `ctwa_clid`) seen on an inbound WhatsApp message, written by the
  // old `convex/attribution.ts`'s `recordSignal` and updated by its
  // outbound partner-signal action as it landed. That whole module
  // (recordSignal/getSignal/patchResult/sendSignal/getPendingToRetry/
  // retryPending/listConversions) was DELETED in Task B5 — ingest was
  // rewired to `conversionEvents` (funnel Phase 1) and the retry cron
  // was removed, leaving this table with NO remaining writers. Its rows
  // stay queryable for historical reference only; nothing in the app
  // reads or writes it anymore. The table itself is kept (not dropped)
  // because Convex schema validation rejects removing a table that
  // still holds prod data — drop it after a prod purge of these rows.
  // The pure `extractRefCode`/`extractCtwaClid`/`decodeHidden` helpers
  // that used to live alongside this table moved to
  // `convex/lib/attribution.ts` (still used by `ingest.ts`).
  // ============================================================
  attributionSignals: defineTable({
    accountId: v.id("accounts"),
    identifier: v.string(), // the HY-code (uppercased) OR the ctwa_clid
    lane: v.union(v.literal("code"), v.literal("ctwa")),
    phone: v.string(), // sender phone as supplied by the caller (E.164 in prod; stored verbatim)
    waMessageId: v.string(),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    firstMessageAt: v.number(),
    landingResult: v.union(
      v.literal("pending"),
      v.literal("matched"),
      v.literal("unmatched"),
      v.literal("error"),
      // Terminal give-up state: a row whose retries hit `attempts` ==
      // `MAX_ATTEMPTS` was retired here by the old (now-deleted)
      // `attribution.patchResult`, so it left the `"error"` partition
      // the old retry cron's `getPendingToRetry` scanned.
      v.literal("abandoned"),
    ),
    offerSlug: v.optional(v.string()),
    firedAt: v.optional(v.number()),
    attempts: v.number(),
  })
    .index("by_account_identifier", ["accountId", "identifier"])
    // Reserved wamid lookup/dedup/debug index — not queried by the
    // B-tasks yet (mirrors the existing `broadcastRecipients.by_wamid`
    // precedent above).
    .index("by_wamid", ["waMessageId"])
    .index("by_account_result", ["accountId", "landingResult"])
    .index("by_result", ["landingResult"]),

  // ============================================================
  // Unified conversion outbox (funnel Phase 1). One row per
  // (conversation, stage) that maps to a Meta event. `backend`
  // discriminates delivery: "platformA" (website/code lane → web Pixel via
  // go-amani) or "capi" (ad/ctwa lane → direct Meta CAPI). `eventId`
  // (= `${conversationId}:${stage}`) is our dedup key — Meta does not dedupe
  // business-messaging events. Dormant rows stay `pending` (no attempt bump)
  // until env is configured; the retry cron resends them.
  // ============================================================
  conversionEvents: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    stage: v.union(
      v.literal("new_lead"),
      v.literal("qualified"),
      v.literal("price_quoted"),
      v.literal("itinerary_created"),
      v.literal("itinerary_sent"),
      v.literal("invoice_sent"),
      v.literal("purchased"),
    ),
    lane: v.union(v.literal("code"), v.literal("ctwa")),
    backend: v.union(v.literal("platformA"), v.literal("capi")),
    eventName: v.string(), // resolved per lane (web-pixel name | business_messaging name)
    identifier: v.string(), // HY-code (code lane) | ctwa_clid (ctwa lane)
    value: v.optional(v.number()),
    currency: v.optional(v.string()),
    phone: v.string(),
    waMessageId: v.string(),
    firstMessageAt: v.number(),
    eventId: v.string(), // `${conversationId}:${stage}` — dedup
    // "abandoned" is terminal: the row gave up after MAX_DELIVER_ATTEMPTS.
    // "dormant" is terminal-for-now: the backend had no env configured, so
    // nothing could be attempted and no attempt was spent;
    // `getDormantToSweep` brings it back once that backend exists. These were
    // one status separated by `attempts < MAX` in a post-index `.filter()`,
    // which meant the sweep scanned across given-up rows — and those never
    // leave their partition, so it walked further every time one accumulated.
    // Mirrors `campaignAds.resolveStatus`.
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("unmatched"),
      v.literal("error"),
      v.literal("abandoned"),
      v.literal("dormant"),
    ),
    attempts: v.number(),
    // Transient-failure lane (429/5xx/network): its own budget + a backoff
    // gate, separate from `attempts`. `transientAttempts` counts them and
    // gives up at MAX_TRANSIENT_DELIVER_ATTEMPTS; `nextAttemptAt` is the
    // earliest next try — `getPendingToRetry` skips rows still inside it (in
    // JS over the bounded window, never a `.filter()`), so a backing-off row
    // can't pin the front of the retry window every tick. See
    // `conversionEvents.errorPatchFor`. Mirrors `campaignAds`.
    transientAttempts: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    fbTraceId: v.optional(v.string()),
    matchResult: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_event_id", ["eventId"])
    .index("by_status", ["status"])
    // `getDormantToSweep` wants one backend's dormant rows. Binding BOTH keys
    // leaves it with no `.filter()` at all — one bounded range per configured
    // backend. Ranging `status` alone would still have to filter `backend`,
    // and capi-dormant rows pile up indefinitely while only platformA is
    // configured (exactly today's production state), so that filter would
    // scan past a growing set to reach the rows it wants.
    .index("by_status_backend", ["status", "backend"])
    // Account-scoped, `_creationTime`-ordered scan for the funnel-analytics
    // rollup (campaigns.overview), window-bounded via `.gte("_creationTime")`.
    .index("by_account", ["accountId"]),

  // Append-only funnel progress log (funnel Phase 2). One row per stage
  // ENTERED, for every conversation (incl. organic and the internal
  // `itinerary_created` stage). Powers the stepper (Phase 3) + funnel
  // analytics (Phase 4). Links to the fired `conversionEvents` row when one
  // was seeded. `auto` = the ingest-seeded first-touch (Phase 1 seeds the
  // new_lead conversionEvent; a matching `auto` transition may be backfilled
  // later — this phase writes only agent-driven `auto:false` rows).
  funnelTransitions: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    stage: v.union(
      v.literal("new_lead"),
      v.literal("qualified"),
      v.literal("price_quoted"),
      v.literal("itinerary_created"),
      v.literal("itinerary_sent"),
      v.literal("invoice_sent"),
      v.literal("purchased"),
      v.literal("lost"),
    ),
    byUserId: v.optional(v.id("users")),
    auto: v.boolean(),
    conversionEventId: v.optional(v.id("conversionEvents")),
    // Set only on `lost` transitions — the exact why, for the audit trail
    // and downstream AI analysis (category from a fixed list + free text).
    lossCategory: v.optional(v.string()),
    lossDetail: v.optional(v.string()),
    // Captured on the transition that carried a sale amount (normally
    // `purchased`) — this append-only row is the durable system of record
    // for the amount; `conversation.funnel.saleValue` is only a denorm and
    // can be replaced/dropped by later stage moves (Task B1).
    saleValue: v.optional(v.number()),
    saleCurrency: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    // Account-scoped, `_creationTime`-ordered scan for the funnel-analytics
    // rollup (campaigns.overview), window-bounded via `.gte("_creationTime")`.
    .index("by_account", ["accountId"])
    // `reports.adPerformance` needs only the `qualified` and `purchased`
    // partitions — it asks `stages.has(...)` for those two and nothing else
    // — but read every stage through `by_account`. Measured on production:
    // 2,029 rows for a 30-day window, of which 1,838 were `new_lead` it
    // fetched and discarded. Ranging `stage` in the index reads only the
    // partitions actually used: a ~10x cut that changes no returned number.
    //
    // `stage` sits before the implicit `_creationTime`, so the window bound
    // stays a genuine range within each partition rather than a post-scan
    // filter.
    .index("by_account_stage", ["accountId", "stage"])
    // The contact panel's activity feed is per-CONTACT, not per-conversation
    // — a contact can hold several threads and the panel shows the person's
    // whole history. `by_conversation` cannot answer that without reading
    // every conversation first.
    .index("by_contact", ["contactId"]),

  // ============================================================
  // Lead-quality feedback loop (spec 2026-09-01-lead-quality-feedback-
  // loop-design.md). The answer log behind the inline card in the message
  // thread — the discoverable front door that replaced relying on staff to
  // drive the funnel stepper, which an audit found they did not know existed.
  //
  // Append-only: re-answering a step INSERTS rather than edits, so the trail
  // shows what changed and when. The card reads the latest row per step.
  //
  // `conversionEventId` is the audit that makes the "only good leads reach
  // Meta" rule checkable rather than merely intended: it is set only when the
  // answer seeded an outbox row, so a `no`/`dismissed` row carrying one would
  // be a bug you can query for. Negative answers are still RECORDED — the
  // business wants the bad-lead signal for its own reporting; it just never
  // leaves the building.
  // ============================================================
  leadQualityAnswers: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    // The three business-funnel milestones an agent can attest to. Maps to
    // funnel stages in `lib/leadQuality.ts` — NOT stored as a stage here,
    // because the question ("is this a real customer?") and the stage
    // (`qualified`) are deliberately different vocabularies.
    // Additive union literal — `service` was added after `genuine`/`intent`/
    // `payment` shipped, so existing rows keep validating.
    step: v.union(
      v.literal("genuine"),
      v.literal("service"),
      v.literal("intent"),
      v.literal("payment"),
    ),
    // "dismissed" is the card's `×`. It is a real answer, not an absence:
    // it says an agent saw the question and declined it, which is signal
    // worth keeping and is what the 1-day re-ask cooldown keys on.
    answer: v.union(
      v.literal("yes"),
      v.literal("no"),
      v.literal("dismissed"),
    ),
    reason: v.optional(v.string()),
    value: v.optional(v.number()),
    currency: v.optional(v.string()),
    byUserId: v.id("users"),
    conversionEventId: v.optional(v.id("conversionEvents")),
  })
    .index("by_conversation", ["conversationId"])
    // Account-scoped, `_creationTime`-ordered scan for lead-quality
    // reporting, window-bounded via `.gte("_creationTime")` — the same shape
    // `conversionEvents.by_account` uses for the funnel rollup.
    .index("by_account", ["accountId"]),

  // ============================================================
  // CTWA ad-capture (funnel Phase 0). Raw event log: one row per
  // inbound message carrying a `referral`. `_creationTime` is the
  // received-at (codebase "rely on _creationTime" convention).
  // `ctwaClid` is the durable per-conversation ad-click id the funnel's
  // ad lane reads later. Distinct from the `conversation.adReferral`
  // display denorm (set once, for the inbox ad-preview card).
  // ============================================================
  adReferrals: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    waMessageId: v.string(),
    ctwaClid: v.optional(v.string()), // omitted for Status placements
    adId: v.optional(v.string()), // referral.source_id = Meta ad id
    sourceType: v.optional(v.string()), // "ad" — resolution guards on this
    sourceUrl: v.optional(v.string()),
    headline: v.optional(v.string()),
    body: v.optional(v.string()),
    mediaType: v.optional(v.string()),
    isFirstTouch: v.boolean(), // contact's first-ever ad referral
    // ---- Ad→service tagging state (convex/adServiceTagging.ts). All
    // optional: live rows predate this feature. "unmatched" and
    // "ambiguous" behave identically for control flow — both advance
    // the attempt counter and both fall through to the AI pass — and
    // are kept apart only so an alias review can tell "no service term
    // appeared" from "two services overlapped".
    serviceMatchStatus: v.optional(
      v.union(
        v.literal("matched"),
        v.literal("unmatched"),
        v.literal("ambiguous"),
        v.literal("suggested"),
      ),
    ),
    /** The `kbServices.key` that matched. */
    serviceMatchKey: v.optional(v.string()),
    /** Which signal produced the hit — a `MatchSignals` key. */
    serviceMatchedOn: v.optional(v.string()),
    /** Rule passes spent. Hard-capped at 2 by `tagFromAd`. */
    serviceMatchAttempts: v.optional(v.number()),
  })
    .index("by_account", ["accountId"])
    .index("by_account_ad", ["accountId", "adId"])
    .index("by_contact", ["contactId"])
    .index("by_wamid", ["waMessageId"]),

  // Landing-page context cache for ad-aware AI replies: one row per
  // (account, normalized ad `source_url`). Warmed from ingest when a
  // CTWA referral carries a link; read (and lazily re-warmed) by
  // `aiReply`'s `loadAdContext` so the assistant's first reply can name
  // the actual offer behind the ad. Content fields hold the LAST GOOD
  // extraction — a failed refresh flips `status` to "error" but keeps
  // them, so a temporarily-down page doesn't blank context the
  // assistant already had. Never user-facing.
  adLandingPages: defineTable({
    accountId: v.id("accounts"),
    urlKey: v.string(), // normalized url — lib/ai/adContext.ts's `landingUrlKey`
    url: v.string(), // original source_url as last fetched
    status: v.union(v.literal("pending"), v.literal("ok"), v.literal("error")),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    content: v.optional(v.string()), // extracted text, ≤ LANDING_CONTENT_MAX
    finalUrl: v.optional(v.string()), // post-redirect URL actually parsed
    error: v.optional(v.string()), // last failure, for ops eyeballing
    fetchStartedAt: v.number(), // claim clock — `claimFetch` takeover gate
    fetchedAt: v.optional(v.number()), // completion clock — freshness gate
  }).index("by_account_url", ["accountId", "urlKey"]),

  // Resolution cache: one row per (account, adId). Names change rarely.
  // Written `pending` at capture; resolved via Marketing API in `resolveAd`.
  campaignAds: defineTable({
    accountId: v.id("accounts"),
    adId: v.string(),
    adName: v.optional(v.string()),
    adSetId: v.optional(v.string()),
    adSetName: v.optional(v.string()),
    campaignId: v.optional(v.string()),
    campaignName: v.optional(v.string()),
    // "abandoned" is terminal: the give-up state for a row that exhausted
    // MAX_RESOLVE_ATTEMPTS. It exists so dead rows LEAVE the "error"
    // partition — `getResolvable` reads that partition through `by_status`
    // and `.filter()`s on `attempts`, and a Convex `.filter()` does not
    // narrow what is read. Rows that gave up while still tagged "error"
    // would accumulate there forever, matching nothing, growing the cron's
    // scan without bound. Mirrors conversionEvents.status and
    // attributionSignals.landingResult, which retire the same way.
    // "dormant" is the OTHER terminal-for-now state: a row that cannot be
    // attempted at all because META_ADS_ACCESS_TOKEN is unset. It is not a
    // failure and costs no attempt; `getDormantToSweep` brings it back the
    // moment a token exists. It exists as its own status rather than
    // sharing "abandoned" (which is how conversionEvents does it,
    // separating the two by `attempts < MAX` in a post-index `.filter()`)
    // so the sweep is an unfiltered `by_status` range. Given-up rows
    // accumulate forever, and filtering across the partition holding them
    // is the scan shape this table's own history argues against.
    resolveStatus: v.union(
      v.literal("pending"),
      v.literal("resolved"),
      v.literal("error"),
      v.literal("abandoned"),
      v.literal("dormant"),
    ),
    attempts: v.number(),
    // Transient-failure lane (429/5xx/network) — same design as
    // `conversionEvents`: own budget (MAX_TRANSIENT_RESOLVE_ATTEMPTS) +
    // `nextAttemptAt` backoff gate applied in JS by `getResolvable`.
    transientAttempts: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_account_ad", ["accountId", "adId"])
    .index("by_account", ["accountId"])
    .index("by_status", ["resolveStatus"]),

  // ============================================================
  // Lead qualification (spec: docs/superpowers/specs/
  // 2026-07-18-lead-qualification-followup-design.md §5). Per-account
  // config, one row (mirrors `aiConfigs` — `by_account` doubles as the
  // enforcing unique index). DORMANT until `enabled`: every engine hook
  // gates on it, so deploying this schema changes nothing user-visible.
  // Working hours are ACCOUNT-LOCAL minutes-of-day against a FIXED UTC
  // offset (Gulf/India have no DST; pure arithmetic, unit-testable) —
  // `timezoneLabel` is display-only. `basicFields` is the fallback
  // question set for off-topic inquiries; per-service questions live in
  // the AI knowledge-base docs (QUALIFICATION CHECKLIST sections), not
  // here. `adminAlertPhones` also drives the engine's loop guard (no
  // sessions/AI on the alert channel itself).
  // ============================================================
  qualificationConfigs: defineTable({
    accountId: v.id("accounts"),
    enabled: v.boolean(),
    basicFields: v.array(v.object({
      key: v.string(),
      label: v.string(),
      required: v.boolean(),
      phrasings: v.array(v.string()),
    })),
    qualifyThresholdScore: v.number(),
    timezoneLabel: v.string(),
    utcOffsetMinutes: v.number(),
    workStartMinute: v.number(),
    workEndMinute: v.number(),
    workDays: v.array(v.number()),
    followUpDelaysMinutes: v.array(v.number()),
    maxFollowUps: v.number(),
    sessionWindowHours: v.number(),
    // Days of our-turn silence before a thread moves from the Waiting
    // lane to Chasing. ABSENT = `sessionWindowHours / 24`, i.e. exactly
    // where this engine's own follow-up ladder gives up — so the two
    // boundaries agree by construction. Lives here, next to the number
    // it must match, rather than in `leadAnalysisConfigs`, which is
    // gated on its own `enabled` flag while the lane boundary must work
    // regardless. Computed by `lib/inbox/lanes.ts`, never inline.
    chasingAfterDays: v.optional(v.number()),
    reengagementTemplateName: v.optional(v.string()),
    reengagementTemplateLanguage: v.optional(v.string()),
    closingMessage: v.string(),
    adminAlertEnabled: v.boolean(),
    adminAlertPhones: v.array(v.string()),
    adminAlertTemplateName: v.optional(v.string()),
    adminAlertTemplateLanguage: v.optional(v.string()),
    // Phase 6 — consent-based auto-assignment + staff keepalive.
    autoAssignEnabled: v.optional(v.boolean()),      // default true
    offerTimeoutMinutes: v.optional(v.number()),     // default 10
    staffCheckinTemplateName: v.optional(v.string()),
    staffCheckinTemplateLanguage: v.optional(v.string()),
    outboundNudgesEnabled: v.boolean(),
    // Purchase signals (spec 2026-07-19-purchase-signals): when true, a
    // qualified session that ALSO meets its service's KB `PURCHASE
    // CRITERIA` section fires the proxy Meta `Purchase` conversion.
    // Optional so pre-feature rows validate; absent = false (dormant).
    purchaseSignalsEnabled: v.optional(v.boolean()),
    // Company-wide fields for the WhatsApp contact card sent to the
    // customer when an agent accepts a lead (announceAssignment). The
    // per-person half (name/phone/jobTitle) comes from the membership;
    // `companyName` falls back to the account name when unset. The Cloud
    // API card has no photo field, so there is no logo entry here.
    contactCard: v.optional(
      v.object({
        companyName: v.optional(v.string()),
        website: v.optional(v.string()),
        email: v.optional(v.string()),
        phone: v.optional(v.string()),
        street: v.optional(v.string()),
        city: v.optional(v.string()),
        state: v.optional(v.string()),
        zip: v.optional(v.string()),
        country: v.optional(v.string()),
        countryCode: v.optional(v.string()),
      }),
    ),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // ============================================================
  // Admin Q&A relay (qualification v3): when the assistant lacks an
  // answer it tells the customer "let me check with my team", records
  // the question here, and WhatsApps it to the admin numbers as a plain
  // message (the admin channel's window never closes — owner-stated
  // operating assumption). The admin's next reply answers the LATEST
  // pending inquiry and is relayed back to the customer by the
  // assistant. `delivered` = the answer reached the customer chat.
  // ============================================================
  adminInquiries: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"), // the CUSTOMER thread
    contactId: v.id("contacts"),
    question: v.string(),
    customerName: v.string(),
    customerPhone: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("answered"),
      v.literal("delivered"),
      v.literal("expired"),
    ),
    answer: v.optional(v.string()),
    askedAt: v.number(),
    answeredAt: v.optional(v.number()),
  })
    .index("by_account_status", ["accountId", "status"])
    .index("by_conversation", ["conversationId"]),

  // ============================================================
  // Phase 6 — agent orchestration over WhatsApp.
  // ============================================================

  // One consent-based lead offer to one agent. The offer engine walks
  // eligible agents (memberTags ∩ the lead's service tag, fewest recent
  // accepts first): offered → accepted (assign + announce + contact
  // card) | declined | timed_out (10 min default → next agent) |
  // cancelled (someone assigned manually meanwhile). Accepted offers
  // also carry the feedback-reminder state for the assigned lead.
  leadOffers: defineTable({
    accountId: v.id("accounts"),
    sessionId: v.id("qualificationSessions"),
    conversationId: v.id("conversations"), // the CUSTOMER thread
    contactId: v.id("contacts"),
    agentUserId: v.id("users"),
    agentPhone: v.string(),
    status: v.union(
      v.literal("offered"),
      v.literal("accepted"),
      v.literal("declined"),
      v.literal("timed_out"),
      v.literal("cancelled"),
    ),
    offeredAt: v.number(),
    respondedAt: v.optional(v.number()),
    // Feedback loop (accepted offers only)
    feedback: v.optional(v.string()),
    feedbackAt: v.optional(v.number()),
    lastReminderAt: v.optional(v.number()),
    remindersSent: v.optional(v.number()),
    escalatedAt: v.optional(v.number()),
  })
    .index("by_session", ["sessionId"])
    .index("by_account_status", ["accountId", "status"])
    .index("by_agent_status", ["agentUserId", "status"])
    .index("by_status_offered", ["status", "offeredAt"]),

  // Service routing: which members can work which service tag. One row
  // per (member, tag) link; the Settings → Services card manages them.
  memberTags: defineTable({
    accountId: v.id("accounts"),
    userId: v.id("users"),
    tagId: v.id("tags"),
  })
    .index("by_account", ["accountId"])
    .index("by_user", ["userId"])
    .index("by_account_tag", ["accountId", "tagId"]),

  // Staff window keepalive state, one row per staff phone (admin alert
  // numbers + member numbers). Tracks when we last nudged so the daily
  // check-in never spams.
  staffCheckins: defineTable({
    accountId: v.id("accounts"),
    phoneNormalized: v.string(),
    lastCheckinSentAt: v.number(),
  }).index("by_account_phone", ["accountId", "phoneNormalized"]),

  // One qualification session per conversation — this row IS the lead
  // the sales team works from (spec §5; no separate leads table).
  // `by_conversation` doubles as the 1:1 enforcing index (ensureSession
  // is the only insert path). Keys in `fields` are DYNAMIC — whatever
  // the matched service doc's checklist asks — so `key` is a plain
  // string, not a union. `score`/`scoreBreakdown` are the analysis
  // engine's marks (P1); `pendingQuestion` is the LLM-prewritten next
  // ask the follow-up cron rotates through WITHOUT its own LLM call
  // (P3); `by_due` partitions the cron sweep (status = "collecting",
  // nextFollowUpAt <= now), mirroring conversionEvents.by_status.
  qualificationSessions: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    status: v.union(
      v.literal("collecting"),
      v.literal("qualified"),
      v.literal("expired"),
      v.literal("opted_out"),
      v.literal("disqualified"),
    ),
    origin: v.union(v.literal("inbound"), v.literal("outbound")),
    serviceName: v.optional(v.string()),
    fields: v.array(v.object({
      key: v.string(),
      label: v.optional(v.string()),
      value: v.string(),
      confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
      updatedAt: v.number(),
      // v3 multi-lead: true when this value was carried over from the
      // contact's previous session — the assistant reconfirms it
      // casually instead of re-asking (or treating it as brand new).
      carried: v.optional(v.boolean()),
    })),
    score: v.optional(v.number()),
    scoreBreakdown: v.optional(v.array(v.object({
      criterion: v.string(),
      marks: v.number(),
      maxMarks: v.number(),
      reason: v.optional(v.string()),
    }))),
    expectedCount: v.number(),
    answeredCount: v.number(),
    // Readiness marker (P1): stamped when the doc checklist is satisfied
    // AND score >= threshold AND >= 3 answers. P2's completion pipeline
    // consumes it; status flips to "qualified" only there, so a P1-only
    // build never half-completes a lead.
    checklistSatisfiedAt: v.optional(v.number()),
    // Newest customer message this session has been analysed through
    // (token audit follow-up 2026-07-27). Lets the extraction pass skip
    // outright when nothing new has arrived, which is what makes it safe
    // to invoke from BOTH the debounced schedule and `dispatchInbound`
    // without paying twice. Optional: sessions predating the field simply
    // analyse once more and then carry a watermark.
    analyzedThroughMs: v.optional(v.number()),
    pendingQuestion: v.optional(v.object({
      key: v.string(),
      text: v.string(),
      alternates: v.array(v.string()),
      // When the analysis pass that PROPOSED this question ran. The
      // question is only trustworthy while it post-dates
      // `lastCustomerMessageAt` below: once the customer has spoken
      // again, a question computed before they spoke may well be the
      // one they just answered, and both consumers (the reply's
      // steering in `getObjectives`, the follow-up cron's verbatim
      // replay in `pickFollowUpText`) must stop using it. Optional
      // because rows written before this shipped have no stamp — those
      // are treated as stale, which costs one turn of steering and
      // self-heals on the next inbound.
      askedAt: v.optional(v.number()),
    })),
    lastCustomerMessageAt: v.optional(v.number()),
    humanTouchedAt: v.optional(v.number()),
    followUpsSent: v.number(),
    phrasingCursor: v.number(),
    nextFollowUpAt: v.optional(v.number()),
    sendAttemptErrors: v.number(),
    qualifiedAt: v.optional(v.number()),
    closedReason: v.optional(v.string()),
    summary: v.optional(v.string()),
    // Purchase-signal verdict trail (spec 2026-07-19-purchase-signals
    // §3.5). Absent = never evaluated. "sent" is terminal (the
    // conversation's one `purchased` conversionEvent is spent);
    // "not_met" keeps re-evaluating on later inbounds inside the
    // 7-day window. `manual` marks a supervisor-fired signal.
    purchase: v.optional(
      v.object({
        status: v.union(v.literal("sent"), v.literal("not_met")),
        evaluatedAt: v.number(),
        confidence: v.number(),
        reasons: v.array(v.string()),
        value: v.optional(v.number()),
        currency: v.optional(v.string()),
        sentAt: v.optional(v.number()),
        conversionEventId: v.optional(v.id("conversionEvents")),
        manual: v.optional(v.boolean()),
      }),
    ),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_account_status", ["accountId", "status"])
    .index("by_due", ["status", "nextFollowUpAt"]),

  // The post-qualification sales checklist — one row per qualification
  // session (the session IS the lead), posted automatically when the lead
  // qualifies. Items come from the knowledge base's `SALES CHECKLIST`
  // section via the account's LLM when available, else the built-in
  // 6-step default — so every qualified lead ALWAYS gets one. Completing
  // an item requires a note (mirrored to `contactNotes`, the
  // AI-processable trail). `outcome` denormalizes the deal's terminal
  // state (won/lost + the exact loss reason) for the leads board;
  // `funnelTransitions` stays the audit source of truth.
  salesChecklists: defineTable({
    accountId: v.id("accounts"),
    sessionId: v.id("qualificationSessions"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    source: v.union(v.literal("kb"), v.literal("default")),
    items: v.array(
      v.object({
        key: v.string(),
        title: v.string(),
        description: v.optional(v.string()),
        done: v.boolean(),
        doneAt: v.optional(v.number()),
        doneByUserId: v.optional(v.id("users")),
        note: v.optional(v.string()),
      }),
    ),
    outcome: v.optional(
      v.object({
        result: v.union(v.literal("won"), v.literal("lost")),
        lossCategory: v.optional(v.string()),
        lossDetail: v.optional(v.string()),
        at: v.number(),
        byUserId: v.optional(v.id("users")),
      }),
    ),
    generatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_account", ["accountId"]),

  // Run history for the interval crons in crons.ts — one row per
  // execution, stamped by the wrapper actions in cronSchedules.ts.
  // Deployment-global (no accountId): crons are infrastructure, not
  // tenant data; the admin-gated Settings → Cron schedules panel is the
  // only reader. Rows older than 7 days are pruned on each start.
  cronRuns: defineTable({
    name: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    status: v.union(
      v.literal("running"),
      v.literal("success"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
  }).index("by_name", ["name", "startedAt"]),

  // ============================================================
  // Lead Analysis (spec: docs/superpowers/specs/
  // 2026-07-26-lead-analysis-design.md). One row per conversation;
  // `by_conversation` doubles as the 1:1 enforcing index (a single
  // upsert path), mirroring `qualificationSessions`.
  //
  // `by_score_due` and `by_sequence_due` are partitioned cron ranges,
  // the same shape as `qualificationSessions.by_due` and
  // `conversionEvents.by_status`: each sweep reads only its own
  // partition, and a row that gives up LEAVES that partition
  // ("failed" / "stopped") rather than accumulating in front of the
  // rows the sweep still wants. `scoreStatus` is bound before
  // `rescoreDueAt` so the due test is a genuine range, never a
  // post-index `.filter()` — see this file's `broadcastRecipients`
  // comment for what that filter costs once dead rows pile up.
  //
  // P1 writes only `sequenceStatus: "idle"`; the sequence fields exist
  // now so P3 adds no second schema deploy.
  // ============================================================
  leadAnalyses: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),

    // DENORMALISED mirror of `conversations.archivedAt` (presence →
    // true). `conversations.archivedAt` stays the system of record; this
    // exists purely so the board's read stays bounded.
    //
    // Without it, the board would read `by_account_score` and drop
    // archived rows afterwards. Archiving only ever accumulates, so over
    // time the query would read a mostly-archived page to surface a
    // shrinking active set — the same unbounded shape this file warns
    // about elsewhere.
    //
    // REPRESENTATION (load-bearing): archived rows hold `true`; active
    // rows hold `undefined` — restore CLEARS the field rather than
    // writing `false`. That is what makes `eq("archived", undefined)` an
    // exact range over the active set. Writing `false` instead would
    // split active rows across two index values and force the active
    // view to read past archived rows to find them, which is the
    // starvation this denormalisation exists to prevent.
    //
    // SYNC INVARIANT: for the "archive" direction, `leadAnalysis.ts`'s
    // `archiveConversationCore` is the ONLY writer of this field or of
    // `conversations.archivedAt` — both the supervisor-gated `archive`
    // mutation and the sequence's unattended `archiveAutomated` mutation
    // (P3) call it rather than duplicating its body. For the inverse
    // (clear) direction, `leadAnalysis.restore` and
    // `conversations.unarchiveOnInbound` are the only writers. Every
    // writer patches BOTH rows in one mutation; Convex mutations are
    // transactional, so the two cannot commit apart. Any future writer
    // must uphold this — route through the core, don't add a fourth
    // hand-rolled copy of the archive write.
    archived: v.optional(v.boolean()),

    score: v.optional(v.number()), // 1–10, absent until first scored
    band: v.optional(
      v.union(v.literal("hot"), v.literal("warm"), v.literal("cold")),
    ),
    reason: v.optional(v.string()),
    signals: v.optional(v.array(v.string())),
    // Denormalised copy of the conversation's newest
    // `qualificationSessions.serviceName` as of the last score, so the
    // board doesn't run a per-row session query. DISPLAY ONLY — nothing
    // branches on it. `undefined` means "not cached yet" and the board
    // falls back to the real query, so rows scored before this field
    // existed keep rendering their service name.
    serviceName: v.optional(v.string()),
    scoredAt: v.optional(v.number()),
    // Dedup key: the `_creationTime` of the newest message at the moment
    // this row was last scored. A re-queue whose newest message has not
    // moved short-circuits without spending an LLM call.
    //
    // Deliberately a TIMESTAMP, not a message count: a count derived from
    // the bounded `.take(TRANSCRIPT_LIMIT)` transcript slice saturates at
    // the limit, after which it can never change again and the
    // conversation would be silently frozen at its last score forever.
    scoredThroughMs: v.optional(v.number()),
    model: v.optional(v.string()),
    scoreStatus: v.union(
      v.literal("pending"),
      v.literal("scored"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    rescoreDueAt: v.optional(v.number()),
    attempts: v.number(),
    lastError: v.optional(v.string()),

    sequenceStatus: v.union(
      v.literal("idle"),
      v.literal("running"),
      v.literal("exhausted"),
      v.literal("stopped"),
    ),
    followUpsSent: v.number(),
    lastFollowUpAt: v.optional(v.number()),
    nextFollowUpAt: v.optional(v.number()),
    stoppedReason: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_account_score", ["accountId", "score"])
    // The board's read, partitioned by archive state. Convex sorts a
    // missing field before every present value, so
    // `eq("archived", undefined)` and `eq("archived", true)` are two
    // disjoint, exact ranges. Pre-archive rows (written before this
    // field existed) hold `undefined` and so correctly land in the
    // active partition with no backfill.
    .index("by_account_archived_score", ["accountId", "archived", "score"])
    .index("by_score_due", ["scoreStatus", "rescoreDueAt"])
    .index("by_sequence_due", ["sequenceStatus", "nextFollowUpAt"]),

  // Per-account Lead Analysis config, one row (`by_account` doubles as
  // the enforcing unique index — same treatment as
  // `qualificationConfigs`). DORMANT until `enabled`: every engine entry
  // point gates on it, so deploying this schema changes nothing
  // user-visible.
  leadAnalysisConfigs: defineTable({
    accountId: v.id("accounts"),
    enabled: v.boolean(),

    rescoreDebounceMinutes: v.number(),
    scorePerRun: v.number(),
    backfillEnabled: v.boolean(),
    backfillPerRun: v.number(),

    idleDaysBeforeSequence: v.number(),
    humanQuietHours: v.number(),
    dailySendCap: v.number(),
    agedOutDays: v.optional(v.number()),
    bands: v.array(
      v.object({
        key: v.union(v.literal("hot"), v.literal("warm"), v.literal("cold")),
        minScore: v.number(),
        maxScore: v.number(),
        autoArchive: v.boolean(),
        steps: v.array(
          v.object({
            delayDays: v.number(),
            templateName: v.string(),
            templateLanguage: v.optional(v.string()),
          }),
        ),
      }),
    ),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // Daily marketing-send budget, one row per account. Mirrors
  // `aiAutoReplyRate`'s fixed-window shape, with one deliberate
  // difference: `aiAutoReplyRate` PACES (a refusal there means "retry in
  // N ms", because the bot answers every message), whereas this one
  // REFUSES — a marketing template over the day's cap must not be sent
  // today at all, and the caller reschedules to tomorrow.
  //
  // `dayStartMs` is the ACCOUNT-LOCAL midnight, derived from the same
  // `qualificationConfigs.utcOffsetMinutes` the working hours use: a cap
  // described as "100 per day" that reset at 4am local would be
  // surprising to the person who set it.
  leadSequenceSendRate: defineTable({
    accountId: v.id("accounts"),
    dayStartMs: v.number(),
    count: v.number(),
  }).index("by_account", ["accountId"]),

  // ============================================================
  // Knowledge gap agent (spec docs/superpowers/specs/
  // 2026-08-09-knowledge-gap-agent-design.md). Mines `adminInquiries` —
  // the questions the assistant escalated to staff — and turns the ones
  // a human ANSWERED into knowledge-base drafts, while clustering the
  // ones nobody answered into themes worth writing down.
  //
  // Measured in production 2026-08-09: 70 inquiries, 49 of them never
  // answered by anyone. Those 49 are the real prize — questions
  // customers keep asking that the business has never documented.
  // ============================================================

  kbGapConfigs: defineTable({
    accountId: v.id("accounts"),
    enabled: v.boolean(),
    /** How many answered inquiries one sweep may turn into drafts. */
    entriesPerRun: v.number(),
    /** Answers shorter than this are deflections, not knowledge —
     *  production holds "Okay" and "Tell them our team will contact
     *  you". A cheap pre-filter, before any provider call. */
    minAnswerChars: v.number(),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One row per inquiry the agent has considered — the idempotency
  // record AND the audit trail. Without it a sweep would re-draft the
  // same entry every run; with it, a skipped inquiry also says why.
  kbGapProcessed: defineTable({
    accountId: v.id("accounts"),
    inquiryId: v.id("adminInquiries"),
    outcome: v.union(
      v.literal("drafted"),
      v.literal("skipped_thin_answer"),
      v.literal("skipped_not_durable"),
    ),
    /** The draft it produced, when it produced one. */
    kbEntryId: v.optional(v.id("kbEntries")),
    /** Why it was skipped, in the agent's own words. */
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_inquiry", ["inquiryId"]),

  // The clustered unanswered questions. Rewritten wholesale each sweep
  // rather than merged: a theme is a view over the current backlog, not
  // an entity with a life of its own, and merging would strand themes
  // whose questions have since been answered.
  kbGapThemes: defineTable({
    accountId: v.id("accounts"),
    theme: v.string(),
    questionCount: v.number(),
    /** Verbatim customer questions, so a reader can judge the theme. */
    examples: v.array(v.string()),
    updatedAt: v.number(),
  }).index("by_account", ["accountId"]),

  // ============================================================
  // Sales coach (spec docs/superpowers/specs/
  // 2026-08-09-sales-coach-design.md). Reads threads a human handled and
  // writes specific, quotable observations about how they were handled.
  //
  // It does NOT score or rank anyone. Measured 2026-08-09: this account
  // has ZERO deals and no conversation has ever reached price_quoted, so
  // there is no outcome data. A number built on process alone would be
  // invented precision that reads as objective — and this is the one
  // agent whose output is about a named colleague.
  // ============================================================

  salesCoachConfigs: defineTable({
    accountId: v.id("accounts"),
    enabled: v.boolean(),
    /** Threads reviewed per sweep. */
    threadsPerRun: v.number(),
    /** A thread with fewer messages than this has nothing to coach on. */
    minMessages: v.number(),
    /** How far back to look for threads worth reviewing. */
    lookbackDays: v.number(),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One review of one thread. `subjectUserId` is the person it is about,
  // and the index on it is what lets someone read their OWN coaching
  // without being able to read a colleague's.
  salesCoachNotes: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    subjectUserId: v.id("users"),
    /** Every observation carries a verbatim quote from the thread.
     *  Feedback about a colleague without evidence is an opinion, and
     *  an opinion from a model is not something anyone should have to
     *  answer for. */
    observations: v.array(
      v.object({
        dimension: v.union(
          v.literal("unanswered_question"),
          v.literal("checklist_skipped"),
          v.literal("slow_response"),
          v.literal("tone"),
        ),
        observation: v.string(),
        quote: v.optional(v.string()),
      }),
    ),
    /** What went well, so this is coaching rather than a fault list. */
    strengths: v.array(v.string()),
    /** Computed in code, not judged by the model — minutes between the
     *  customer's last message and this person's first reply. */
    firstResponseMinutes: v.optional(v.number()),
    /** `_creationTime` of the newest message covered, so a thread is
     *  re-reviewed only once it has actually moved on. */
    reviewedThroughMs: v.number(),
    model: v.string(),
    createdAt: v.number(),
  })
    .index("by_account", ["accountId"])
    .index("by_subject", ["subjectUserId"])
    .index("by_conversation", ["conversationId"]),

  // Per-agent, per-account extra instructions, appended to that agent's
  // prompt (spec docs/superpowers/specs/2026-08-09-agent-window-design.md).
  //
  // A SEPARATE table rather than a column on each agent's own config,
  // because three agents have no config row at all and one row per
  // (account, agent) keeps the shape identical for every agent — which
  // is the entire point of the agent window.
  agentInstructions: defineTable({
    accountId: v.id("accounts"),
    /** An `AgentKey` from `lib/agentRegistry.ts`. Not a union here: the
     *  registry is the source of truth and validates on write, so a
     *  schema union would be a second list to keep in sync. */
    agentKey: v.string(),
    extraInstructions: v.string(),
    updatedByUserId: v.optional(v.id("users")),
    updatedAt: v.number(),
  }).index("by_account_agent", ["accountId", "agentKey"]),

  // ============================================================
  // Revival agent (spec docs/superpowers/specs/
  // 2026-08-09-revival-agent-design.md). Drafts a nudge for leads that
  // went quiet while still inside Meta's 24h window, and queues it for a
  // human to send. It never sends by itself.
  // ============================================================

  // One row per account, `by_account` doubling as the uniqueness key —
  // same shape as `aiConfigs`/`leadAnalysisConfigs`. With no enabled row
  // the sweep selects nothing, so the feature costs nothing until it is
  // switched on.
  revivalConfigs: defineTable({
    accountId: v.id("accounts"),
    enabled: v.boolean(),
    // How long a lead must have been quiet before it is worth a nudge.
    minQuietMinutes: v.number(),
    // Headroom left before the 24h window shuts, so a draft sitting in
    // the queue cannot be approved into an already-expired window.
    windowSafetyMinutes: v.number(),
    // No second draft for the same conversation inside this many hours,
    // in ANY status — a dismissed draft is a "no", not a retry.
    cooldownHours: v.number(),
    draftsPerRun: v.number(),
    dailyDraftCap: v.number(),
    minLeadScore: v.number(),
    updatedAt: v.optional(v.number()),
  }).index("by_account", ["accountId"]),

  // One queued draft. Modelled on `tagSuggestions` — the same
  // propose-then-accept shape already proven in the inbox.
  revivalDrafts: defineTable({
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    body: v.string(),
    // Why this lead, now — shown to the approver so they are accepting a
    // judgement rather than just a sentence.
    reason: v.string(),
    // "template" exists so the cold-stock path needs no schema change
    // once Meta approves re-engagement templates. NOTHING WRITES IT YET:
    // 90% of this account's conversations are outside the 24h window and
    // the only approved template is Meta's `hello_world` sample, so the
    // free-text path is the whole of v1.
    channel: v.union(v.literal("free_text"), v.literal("template")),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("dismissed"),
      v.literal("expired"),
    ),
    // Routes to the lead's owner when there is one, rather than the
    // shared queue. Assignment is deliberately NOT a disqualifier —
    // skipping assigned threads would skip most of the Chasing lane,
    // which is exactly the population worth reviving.
    assignedToUserId: v.optional(v.id("users")),
    model: v.string(),
    confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    reviewedByUserId: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    createdAt: v.number(),
    // When the 24h window shuts. This is what keeps the queue honest: a
    // draft past it is swept to `expired` rather than looking sendable.
    expiresAt: v.number(),
  })
    .index("by_account_status", ["accountId", "status"])
    .index("by_conversation", ["conversationId"]),
});
