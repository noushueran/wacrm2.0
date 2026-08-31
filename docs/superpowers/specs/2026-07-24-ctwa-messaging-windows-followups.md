# CTWA messaging windows — Phase 1 follow-ups & Phase 2 prerequisites

**Date:** 2026-07-24
**Status:** Phase 1 merged. This is the carry-forward list.
**Related:** [spec](./2026-07-24-ctwa-messaging-windows-design.md) · [plan](../plans/2026-07-24-ctwa-messaging-windows.md)

Phase 1 shipped the correctness foundation with **zero user-visible change**: Meta's authoritative
billing/window data is captured from status webhooks, two window-anchor timestamps are maintained,
and one pure `resolveWindowState()` resolver exists. Nothing reads the free-entry-point branch yet.

## MUST fix before any consumer reads `conversations.metaWindow`

**1. The free-entry-point latch has a bounded residual false-FREE path.**
`applyStatusPricing` latches `isFreeEntryPoint` forward within one Meta conversation, aged against
`metaWindow.fepObservedAt`. When we never learn a `conversation.id` (a pricing-only callback leaves
it `undefined`), we cannot prove a later callback belongs to a *different* conversation, so the
latch can persist for up to one `FEP_WINDOW_MS` (72h) into a genuinely billed conversation. During
that overlap a consumer would report marketing/authentication templates as free while Meta bills.

This is bounded and latent today, but Phase 2 is the first consumer. Options: treat a
`conversationMetaId` transition from `undefined` → set as a conversation change; or require a
positive FEP re-assertion once the previous known `expiresAt` has passed.

**2. Confirm against live data before trusting the capture.**
- Is **ads attribution enabled** on this WABA? If not, Meta omits the `referral` object entirely
  and no free-entry-point signal will ever arrive.
- Which status values (`sent`/`delivered`/`read`/`failed`) actually carry `conversation` and
  `pricing` for this account, and is it the `CBP` or `PMP` payload shape? Item 1's likelihood
  depends directly on the answer.

## Tracked follow-ups (out of Phase 1 scope)

**3. `updateDeliveryStatusByWamid` and `recordRecipientStatusByWamid` are still unguarded**
(`convex/http.ts`). A throw in either cascades exactly the way the pricing call used to — skipping
the remaining statuses and the `value.messages` inbound branch, while `ingestWebhook` answers 200
so Meta never retries. Phase 1 closed this for the pricing call only, via `runBestEffort`.

**4. Merge the two per-status mutations.** `applyStatusPricing` and `updateDeliveryStatusByWamid`
each run the same `by_message_id` lookup, back to back, in a serial loop over `value.statuses`.
Folding them into one mutation with a single index read removes ~50% of the per-status round trips.

**5. Move `runBestEffort` into `convex/lib/`.** `convex/http.ts` currently imports it from
`convex/ingest.ts`, pulling a 1,000-line module into the webhook entry point for a small helper.

**6. Decide `FepSource` before Phase 2 builds on it.** `source: "none"` conflates three states:
no ad referral; a referral still awaiting a reply (window can *still* open); and a referral whose
24h reply deadline passed (window can never open). Phase 2's "reply within 24h to unlock the free
window" nudge needs exactly that second-vs-third distinction, so add a `"pending"` source rather
than re-deriving it at the call site — otherwise the "one resolver is the single answer" property
is lost.

**7. Frontend consolidation.** `src/lib/inbox/adWindow.ts` and `message-thread.tsx` still compute
the windows independently. `convex/` and `src/` mirror rather than share modules, so consolidating
needs either a mirrored copy or a Convex query — a Phase 2 decision. **Note:** the spec's §2 claim
that `lastInboundAt` "removes the duplicated last-customer-message scans" is not delivered and
should not be. `qualificationEngine` deliberately still scans, because reading
`conversation.lastInboundAt` directly would regress every pre-existing conversation to
"window closed" — a visible behaviour change. `lastInboundAt` is therefore currently write-only.

**8. Deploy-timing caveat.** For a conversation whose ad click is under 24h old at deploy and that
was already replied to beforehand, the first post-deploy outbound stamps `firstReplyAt = now`,
producing an estimated window up to ~62h longer than Meta's real one. Self-limiting (those
estimates expire within 72h, and nothing reads them in Phase 1), so it only matters if Phase 2
ships within ~4 days of Phase 1.

## Deferred test-coverage gaps

- `parseStatusPricing`: no case for `expiration_timestamp` of `"0"` or `""` (both correctly yield
  `undefined` via the `seconds > 0` guard).
- `applyStatusPricing`: no cross-account wamid-collision test and no "`accountId` omitted sweeps
  every row" test, though its sibling `updateDeliveryStatusByWamid` has both.
- `applyStatusPricing`: no partial `messages.pricing` merge case (e.g. only `billable` present).
- `convex/http.ts` has **zero** dedicated tests, before or after Phase 1 — the status-loop error
  isolation is covered only by `runBestEffort`'s own unit tests plus static reasoning.
- `messagingWindow`: the CSW test titled "…and beyond" only asserts the exact boundary.
