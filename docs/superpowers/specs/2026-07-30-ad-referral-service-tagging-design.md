# Ad-referral service tagging

**Date:** 2026-07-30
**Status:** approved, awaiting implementation plan

## Problem

A customer who clicks a click-to-WhatsApp ad arrives with the service already
known — the ad they clicked *is* the answer to "what are they looking for?".
Today that knowledge is captured but never acted on: the contact stays untagged
until a qualification session reaches `qualified` with a `serviceName`, because
`tagContactForService` is called from exactly one place,
`qualificationEngine.ts`'s completion path. A UAE-visa ad lead therefore sits in
the inbox with no service tag, even though the referral payload names the
service in its headline and landing page.

Everything needed is already stored:

- `adReferrals` — headline, body, `source_url`, `ad_id`, written by
  `ingest.processInbound` on every referral-carrying inbound.
- `campaignAds` — `ad_id` → ad name / ad set name / campaign name, resolved via
  the Meta Marketing API (`dormant` while `META_ADS_ACCESS_TOKEN` is unset).
- `adLandingPages` — title, description and extracted text of the page behind
  `source_url`, warmed asynchronously from ingest.
- `kbServices` — the account's service catalogue: `name`, `aliases`, `status`.

The gap is a step that turns those signals into a tag.

## Goals

- Tag the contact with the service tag within seconds of an ad click, without
  waiting for qualification.
- Spend no AI tokens when the ad text plainly names a service.
- Never mislabel: an ambiguous signal produces no tag rather than a wrong one.
- Never affect message ingestion — this is strictly best-effort work.

## Non-goals

- Feeding routing. The Chasing auto-assign sweep routes off
  `session.serviceName` (`convex/inboxChaseAssign.ts:178`), not off tags. That
  stays exactly as it is. Revisit once the matcher's accuracy is proven in
  production.
- Replacing or altering the qualification-time tagging path.
- Tagging non-ad conversations.

## Design

### 1. Pure matcher — `convex/lib/ads/serviceMatch.ts`

```ts
type MatchSignals = {
  headline?: string;
  body?: string;
  sourceUrl?: string;
  adName?: string;
  adSetName?: string;
  campaignName?: string;
  landingTitle?: string;
  landingDescription?: string;
  /** Customer's own words — supplied on the retry pass only. */
  customerText?: string;
};

type ServiceCandidate = { key: string; name: string; aliases: string[] };

type MatchResult =
  | {
      status: "matched";
      serviceKey: string;
      serviceName: string;
      /** Which signal produced the hit — persisted for auditing accuracy. */
      matchedOn: keyof MatchSignals;
    }
  /** Two or more distinct services tied at the deciding level. */
  | { status: "ambiguous" }
  /** No service term appeared in any signal. */
  | { status: "none" };

export function matchService(
  signals: MatchSignals,
  services: ServiceCandidate[],
): MatchResult;
```

A three-way result rather than `MatchResult | null` so the orchestrator can
record *why* it did not tag — "we saw nothing" and "we saw too much" call for
different remedies (write an ad that names the service vs. tighten overlapping
aliases), and collapsing them would hide that.

No `ctx`, no database, no I/O — all the real logic lives here and is unit
tested directly.

**Normalisation.** Lowercase, strip diacritics, replace non-alphanumerics with
single spaces, collapse whitespace. Applied identically to both haystack and
needle. `source_url` is additionally reduced to its path + query, so
`amaniworld.com/uae-visit-visa` normalises to `amaniworld com uae visit visa`.

**Terms.** For each active service, the term set is its `name` plus every entry
in `aliases`, normalised the same way. Empty and whitespace-only terms are
dropped.

**Matching.** A term matches a haystack only on **word boundaries** — the
normalised term must appear as a whole-token run. Substring matching is
explicitly rejected: it makes short aliases fire on unrelated words.

**Signal precedence.** Haystacks are searched in this order, and the first
order-position that yields any hit decides the result:

1. `adName`, `adSetName`, `campaignName` — the advertiser named these
   deliberately, so they are the strongest evidence.
2. `headline`
3. `landingTitle`
4. `body`, `landingDescription`
5. `sourceUrl`
6. `customerText` (retry pass only)

**Ambiguity.** If two or more *distinct* services match at the deciding
precedence level, the result is `{status: "ambiguous"}`. Multiple terms of the
*same* service matching is not ambiguity — it is a stronger hit. Preferring
silence over a guess is deliberate: a wrong service tag is worse than no tag,
because it is the same tag vocabulary lead routing keys on.

**Service filtering.** Only `status: "active"` services are candidates.

### 2. Orchestrator — `convex/adServiceTagging.ts`

#### `tagFromAd` — `internalMutation`

```ts
args: {
  accountId: Id<"accounts">;
  contactId: Id<"contacts">;
  conversationId: Id<"conversations">;
  trigger: "referral" | "followup";
}
```

Steps:

1. Load this conversation's `adReferrals` row — query `by_contact`, filter to
   `conversationId`, take the most recent. Return if none.
2. Return if `serviceMatchStatus === "matched"` (already tagged) or
   `serviceMatchStatus === "suggested"` (AI fallback already ran) or
   `(serviceMatchAttempts ?? 0) >= 2`. This is the whole idempotency and
   attempt-budget story.
3. Gather signals:
   - headline / body / `sourceUrl` from the referral row;
   - `adName` / `adSetName` / `campaignName` from `campaignAds` via
     `by_account_ad` when `adId` is set and the row resolved;
   - `landingTitle` / `landingDescription` from `adLandingPages` via
     `by_account_url` using `landingUrlKey(sourceUrl)`;
   - on `trigger: "followup"`, the text of this conversation's first two
     inbound customer messages.
4. Load active `kbServices` for the account.
5. Call `matchService`.
6. **`matched`** → `tagContactForService(ctx, {accountId, contactId,
   serviceName, source: "ad"})`; patch the referral row to
   `serviceMatchStatus: "matched"`, `serviceMatchKey`, `serviceMatchedOn`,
   `serviceMatchAttempts: (prev ?? 0) + 1`. Done.
7. **`none` / `ambiguous`, `trigger: "referral"`** → patch
   `serviceMatchStatus` to `"unmatched"` or `"ambiguous"` respectively and
   `serviceMatchAttempts: 1`. Stop; the next inbound books the retry.
8. **`none` / `ambiguous`, `trigger: "followup"`** → patch the same status plus
   `serviceMatchAttempts: 2`, then `ctx.scheduler.runAfter(0,
   internal.adServiceTagging.classifyAdService, …)`.

The second pass is materially better armed than the first: by then the landing
page fetch has usually completed and `campaignAds` has usually resolved, and
the customer's own words are available.

#### `classifyAdService` — `internalAction`

The AI fallback, reached only after two failed rule passes.

- Returns quietly if `aiConfig.loadDecrypted` yields no config, an inactive
  config, or no API key — an unconfigured account simply gets no fallback.
- Builds a prompt from the account's active `kbServices` (name + aliases as a
  closed option set) plus the ad signals and the conversation's first inbound
  messages. Asks for one service name or none.
- One judge-tier call via `generateReply`, using
  `aiJudgeModel` / `aiJudgeReasoningEffort` and
  `promptCacheKey(accountId, "classify")` — the same tier and cache key
  `aiTagging.suggest` uses, since the output is parsed into a tag id and never
  shown as prose.
- Honours `CONVEX_AI_DRY_RUN` with a deterministic synthetic result, mirroring
  `aiTagging.ts`'s `syntheticClassifyRaw`.
- Maps the chosen service name back to a `tags` row by case-insensitive name.
  No match → stop (no suggestion recorded).
- Records the outcome through the **existing** `internal.aiTagging.recordSuggestion`,
  producing a `pending` `tagSuggestions` row. The inbox's existing
  "Suggest tags" banner picks it up with no UI work.
- Patches the referral row to `serviceMatchStatus: "suggested"`.
- Logs spend best-effort via `internal.aiUsage.log` with `mode: "classify"`,
  wrapped in try/catch exactly as `aiTagging.suggest` does.
- Every failure is caught and logged; the referral row's `attempts: 2` already
  prevents any retry loop.

### 3. Wiring in `convex/ingest.ts`

Both additions go inside `processInbound`'s existing best-effort fan-out, via
`runBestEffort`, so neither can delay or fail message ingestion.

- **First pass.** In the existing `if (message.referral || message.ctwaClid)`
  block, after `recordAdReferral` returns, schedule
  `tagFromAd({trigger: "referral"})` with `ctx.scheduler.runAfter(0, …)`.
- **Retry pass.** A new step, gated cheaply on the `conversation.adReferral`
  display denorm already present on the conversation doc in hand — no extra
  read on the overwhelming majority of inbounds that have nothing to do with
  ads. When the denorm exists and the message carries no referral of its own
  (i.e. this is a follow-up, not the click itself), schedule
  `tagFromAd({trigger: "followup"})`. `tagFromAd`'s own status and attempt
  guards make a redundant schedule a no-op.

### 4. Schema changes

`convex/schema.ts`:

- `adReferrals` gains four optional fields:
  - `serviceMatchStatus: v.optional(v.union(v.literal("matched"),
    v.literal("unmatched"), v.literal("ambiguous"), v.literal("suggested")))`
  - `serviceMatchKey: v.optional(v.string())` — the `kbServices.key` matched.
  - `serviceMatchedOn: v.optional(v.string())` — which signal produced the hit.
  - `serviceMatchAttempts: v.optional(v.number())`

  State lives on the row that already exists per referral; no new table.
  `"ambiguous"` and `"unmatched"` behave identically for control flow — both
  advance the attempt counter and both fall through to the AI pass — and are
  kept apart purely so the alias review described under *Operational note* can
  tell the two failure shapes apart.

- `contactTags.source` union gains `v.literal("ad")`:
  `v.optional(v.union(v.literal("ai"), v.literal("manual"), v.literal("ad")))`.
  Still optional; unset still means manual.

### 5. `tagContactForService` signature change

`convex/qualificationEngine.ts` — add an optional `source` arg defaulting to
`"ai"`, threaded through to the `contactTags` insert. The existing
qualification call site passes nothing and is unchanged in behaviour.

The existing early return when a `contactTags` row already exists is kept:
a contact already tagged for a service by qualification does not get its
`source` rewritten to `"ad"`, and vice versa. First writer wins.

### 6. "From ad" marker in the UI

`contactTags.source` is not surfaced anywhere today — both tag-embedding
helpers drop it. Carrying it through is four small edits:

- `convex/contacts.ts`'s `embedTags` and `convex/conversations.ts`'s
  equivalent: return `{...tag, source: link.source}` instead of the bare tag
  doc.
- `src/types/index.ts`: `Tag` gains `source?: 'ai' | 'manual' | 'ad'`.
- `src/lib/convex/adapters.ts`: `toUiTag(doc, source?)` — a second optional
  parameter, so the existing `api.tags.list` call sites (which have no link and
  therefore no source) keep working unchanged.
- `src/components/inbox/label-picker.tsx` and
  `src/components/inbox/lead-popover.tsx`: a tag chip with `source === 'ad'`
  renders a small marker. Use a `Megaphone` lucide icon at chip scale with an
  `aria-label`/`title` from a new i18n key (`Inbox.labels.fromAd`, "From ad"),
  rather than appended text — the chips are already dense, and the thread
  header's identity zone has a known overflow history (commit `460d831`).

Marker only. It changes nothing about how the tag behaves, and clicking the
chip still toggles the tag exactly as today.

## Error handling

- Every new call from `ingest.processInbound` goes through `runBestEffort`.
- `tagFromAd` guards `accountId` equality on every document it reads
  (referral, campaignAds, landing page, kbServices, conversation), matching the
  surrounding modules' cross-tenant discipline.
- `classifyAdService` swallows and logs all failures.
- The attempt budget is hard: at most two rule passes and one AI call per
  **ad referral**, ever — not per conversation. A second ad click into the
  same chat is genuinely new information (someone who clicked a UAE-visa ad
  and later a flights ad may want both), so each referral earns its own
  evaluation and its own budget.

## Testing

**`convex/lib/ads/serviceMatch.test.ts`** — pure, no `convex-test`:

- exact service name in headline
- alias in headline
- case, punctuation and diacritic insensitivity
- URL slug match (`/uae-visit-visa`)
- ad/campaign name outranks a conflicting body match
- two distinct services matching at the deciding level → `{status:"ambiguous"}`
- no service term anywhere → `{status:"none"}`
- same service matching via several terms → single hit, not ambiguity
- word-boundary rejection (a term must not match inside a longer word)
- paused services are never candidates
- empty/whitespace aliases are ignored
- `customerText` ignored unless supplied

**`convex/adServiceTagging.test.ts`** — `convex-test`:

- confident referral match tags the contact with `source: "ad"`
- re-running on a `matched` referral is a no-op (no duplicate `contactTags`)
- first pass misses, second pass matches on customer text
- attempts stop at 2; a third invocation does nothing
- AI fallback records a `pending` `tagSuggestions` row under
  `CONVEX_AI_DRY_RUN`
- unconfigured AI → no suggestion, no throw
- cross-account isolation: another account's referral is never touched
- a contact already tagged for the service by qualification keeps
  `source: "ai"`

**`convex/ingest.test.ts`** — extend: a referral-carrying inbound schedules the
first pass; a plain follow-up on an ad conversation schedules the retry; a
non-ad conversation schedules neither.

## Operational note

Coverage of the free rule path depends on `kbServices.aliases` reflecting how
the ads are actually worded. Worth a pass over the alias lists after this
ships — every alias added there is an AI call not spent. The
`serviceMatchStatus` / `serviceMatchKey` / `serviceMatchedOn` trail on
`adReferrals` exists to make that review possible: `"unmatched"` rows point at
ads whose wording no alias covers, `"ambiguous"` rows at aliases that overlap
between services.
