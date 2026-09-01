# Meta Conversions API — manual setup

Everything in this file is a step that must be done **in the Meta UI** by
someone with admin access to the Business portfolio. The code side is
complete and deployed; nothing here needs a developer.

Read §1 first. It is the one part of the original brief that could not be
implemented as written, and the reason is Meta's, not ours.

---

## 1. The event names are not the ones in the brief — and cannot be

The brief asked for four events named `Lead`, `MarketingQualifiedLead`,
`SalesQualifiedLead` and `ConvertedLead`.

**On the Click-to-WhatsApp lane those three custom names are not
available.** Meta's *Conversions API for Business Messaging* accepts a
**fixed, closed vocabulary** of event names. An unrecognised name is not
registered as a custom event there — it is rejected. The full accepted set,
per Meta's current documentation, is:

> `Purchase`, `LeadSubmitted`, `InitiateCheckout`, `AddToCart`,
> `ViewContent`, `OrderCreated`, `OrderShipped`, `OrderDelivered`,
> `OrderCanceled`, `OrderReturned`, `CartAbandoned`, `QualifiedLead`,
> `RatingProvided`, `ReviewProvided`

The brief anticipated this ("follow the latest official Meta developer
specification … and clearly document the difference"). So the **business
meaning is exactly what was asked for** — four milestones, each fired once,
each only when it genuinely happens — carried on the names Meta accepts:

| Business milestone | CRM stage          | CTWA / WhatsApp event | Website event    |
| ------------------ | ------------------ | --------------------- | ---------------- |
| **Lead**           | New lead           | `LeadSubmitted`       | `Lead`           |
| **MQL**            | Qualified lead     | `QualifiedLead`       | `Lead` ⚠️        |
| **SQL**            | Price quoted       | `InitiateCheckout`    | `InitiateCheckout` |
| —                  | Itinerary created  | *(internal only)*     | *(internal only)* |
| —                  | Itinerary sent     | `AddToCart`           | `AddToCart`      |
| —                  | Invoice sent       | `OrderCreated`        | `InitiateCheckout` |
| **Converted**      | Purchased          | `Purchase`            | `Purchase`       |
| —                  | Lost               | *(internal only)*     | *(internal only)* |

**SQL = "Price quoted"** because that stage's entry criteria are the
brief's own §2.3 evidence for Sales Qualified: a quotation discussed or
sent, budget established, a real next sales step. The name is incidental;
the criterion is what matters.

**Converted = "Purchased"**, and the CRM refuses to record it without a
positive sale value. Quotation sent, itinerary sent and invoice sent are
each their own separate stage and none of them is Converted.

⚠️ See "Open decisions" (§8) for the website-lane MQL caveat.

---

## 2. Identify the right data source

1. Go to **Events Manager → Data sources**.
2. Select the dataset already receiving your Click-to-WhatsApp traffic.
   Confirm it is attached to the **ad account actually running the CTWA
   ads**, and that the ad account sits in the correct Business portfolio.
3. Copy the **Dataset ID** (Settings → Dataset ID).

> This deployment's Business portfolios, for reference:
> `Amani Travel & Tourism`, `Amani Travel & Tourism India`,
> `Holidayys.com`. Pick the one that owns the CTWA campaigns you want
> optimized — sending the CRM's events to a dataset attached to a
> different ad account produces a healthy-looking integration that
> optimizes nothing.

## 3. Generate the access token

1. **Events Manager → your dataset → Settings → Conversions API →
   Generate access token.**
2. Store it as a **Convex** environment variable — never in the repo,
   never with a `NEXT_PUBLIC_` prefix:

```bash
npx convex env set META_CAPI_ACCESS_TOKEN "<token>"
```

3. Set the dataset id and pin the Graph version:

```bash
npx convex env set META_CAPI_DATASET_ID "<dataset id>"
```

```bash
npx convex env set META_GRAPH_VERSION "v25.0"
```

The token is only ever read inside a Convex **action** (server-side) and is
sent as a query parameter to `graph.facebook.com`. It never reaches the
browser, is never logged, and is asserted absent from request bodies by a
test.

## 4. Confirm the WhatsApp Business Account is connected

WhatsApp business-messaging events require a `whatsapp_business_account_id`
alongside the `ctwa_clid`. The CRM reads this from the account's WhatsApp
configuration (**Settings → WhatsApp**). If no WABA is connected, events
are held as `dormant` rather than lost, and the reason is shown in
**Settings → Conversions**.

## 5. Run the Test Events pass before going live

1. **Events Manager → your dataset → Test events.** Copy the `TEST#####`
   code.
2. Point delivery at the test stream:

```bash
npx convex env set META_CAPI_TEST_EVENT_CODE "TEST12345"
```

3. Walk one real CTWA lead through the funnel in the CRM, pausing at each
   stage, and confirm each event appears in the Test Events panel **once**:

   | Do this in the CRM                                   | Expect in Test Events |
   | ---------------------------------------------------- | --------------------- |
   | A CTWA lead messages in                              | `LeadSubmitted`       |
   | Move to **Qualified lead**                           | `QualifiedLead`       |
   | Move to **Price quoted**                             | `InitiateCheckout`    |
   | Move to **Purchased** with a value                   | `Purchase` + value    |
   | Save **Qualified lead** again on another lead        | *nothing new*         |

4. Check the panel's diagnostics: no malformed-parameter warnings, and the
   events show a match (the payload carries `ctwa_clid`,
   `whatsapp_business_account_id` and a SHA-256 hashed phone).
5. Repeat once for a **website** lead if that lane is in use.
6. **Unset the test code before going live** — this is the step that is
   easiest to forget and the most damaging to miss, because everything
   keeps looking healthy while nothing counts:

```bash
npx convex env unset META_CAPI_TEST_EVENT_CODE
```

## 6. Switching on production delivery

Events queued while CAPI was unconfigured are held as `dormant`, not
discarded. Turning the token on makes **all of them** eligible at once,
each stamped with its own original `event_time` — potentially months of
backdated conversions in a single sweep.

Decide deliberately. To deliver only events from now on, set the cutoff to
the current epoch **milliseconds** first:

```bash
npx convex env set CONVERSION_DELIVERY_START_MS "$(node -e 'console.log(Date.now())')"
```

The held backlog stays in place, inert and reversible — clearing the
variable later releases it.

## 7. Verify, then leave campaigns alone

- **Settings → Conversions** shows the live outbox: recent events, their
  delivery status, and a banner naming any backend that is holding events
  and why.
- **Reports → Funnel** shows stage-by-stage counts and delivery-status
  totals for the selected window.
- In Events Manager, watch **Event Match Quality** and the diagnostics tab
  for the first week.

**Do not change campaign optimization yet.** Per the brief: collect clean
data first, confirm MQL volume and quality, and only then consider
optimizing an ad set toward the qualified event. Keep all events flowing
in the meantime.

---

## 8. Open decisions — these need a business answer

1. **Website-lane MQL is not distinguishable from Lead.** On the website
   (reference-code) lane, both "New lead" and "Qualified lead" are reported
   under the web-Pixel name `Lead`. They are separate events to Meta
   (different `event_id`, so they are not deduplicated), but they cannot be
   told apart by name — so that lane currently offers no distinct MQL
   signal to optimize toward. The CTWA lane does not have this problem.

   The web Pixel *does* accept custom event names, so the fix is available:
   rename the website lane's `qualified` event to something distinct (e.g.
   `MarketingQualifiedLead`) and create the matching custom event in Events
   Manager. It is not done here because that name is the wire contract with
   the external landing site that fires it, so it is a coordinated deploy
   across two systems, not a one-line change. A test
   (`convex/conversionLifecycle.test.ts`, "KNOWN GAP") pins the current
   behaviour so changing it is deliberate.

2. **Meta Instant Forms are not ingested.** The CRM has no Instant Form
   lead ingestion path at all — leads arrive via Click-to-WhatsApp, the
   website reference code, or organically. Nothing was invented to fill
   this: per the brief, a WhatsApp lead must never be given a fabricated
   Instant Form `lead_id`. If Instant Forms are in use, ingesting them is a
   separate piece of work.

3. **Email is never collected**, so `em` is never sent as a match key. The
   hashing helper for it exists and is tested; there is simply no email on
   a WhatsApp lead. Phone is sent, normalized and SHA-256 hashed.

4. **Organic conversations report nothing to Meta**, by design — there is
   no ad interaction to attribute them to. They still count in the CRM's
   own funnel reporting, so the Reports figures are legitimately larger
   than what Meta sees.

5. **Booking/order reference is not sent** on `Purchase`. The event
   carries value and currency; `event_id` is scoped to the conversation
   (`<conversationId>:purchased`), so a second genuinely separate booking
   from the same conversation would not currently produce a second
   `Purchase`. If repeat bookings per conversation are common, that
   deduplication key needs to become booking-scoped.

## 9. Custom Conversions (optional, for reporting)

If you want the brief's vocabulary to appear as named conversions in
Ads Manager, build them on the label rather than on the event name:

- [ ] Events Manager → **Custom Conversions** → New
- [ ] Source: the dataset in `META_CAPI_DATASET_ID` (§2)
- [ ] Rule: event `QualifiedLead` **and** `lead_stage` equals `MQL`
      → name it **Marketing Qualified Lead**
- [ ] Repeat for `InitiateCheckout` + `SQL` → **Sales Qualified Lead**
- [ ] Repeat for `Purchase` + `CONVERTED` → **Converted Lead**

## Rollback

| Symptom | Action |
| --- | --- |
| Malformed-parameter warnings on `ph`/`em` | `npx convex env set META_CAPI_MATCH_KEYS off` — falls back to the documented-minimal `ctwa_clid` + `whatsapp_business_account_id` pair. No deploy, takes effect on the next event. |
| Anything else wrong with delivery | `npx convex env unset META_CAPI_ACCESS_TOKEN` — the lane goes dormant and **parks** events rather than losing them; they deliver when the token returns. |
| Wrong dataset configured | Unset the token first (above), fix `META_CAPI_DATASET_ID`, then set the token again. Also re-set `CONVERSION_DELIVERY_START_MS` so the newly-eligible backlog does not fire at the new dataset. |
| Code-level rollback | `git revert` the integration commit. The schema is unchanged, so there is no migration to undo. |

Nothing here deletes data: every failure mode parks events in the outbox
rather than dropping them.

---
