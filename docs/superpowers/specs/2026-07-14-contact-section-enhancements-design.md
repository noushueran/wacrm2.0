# Contact section enhancements — design

- **Date:** 2026-07-14
- **Status:** Approved (design); pending implementation plan
- **Area:** Contacts (Convex `contacts` + the `/contacts` dashboard section)

## 1. Context

The Contacts section stores each contact with `phone` (raw, as typed), `phoneNormalized`
(digits-only, the dedup/lookup key), `name`, `email`, `company`, `avatarUrl`, and extended
fields (`altPhone`, `address`, `city`, `country`, `nationality`, `preferredDestination`,
`notes`). See `convex/schema.ts` (`contacts` table).

Current gaps this design addresses:

- **Phone is shown raw.** A `formatPhoneIntl()` helper exists (`src/lib/whatsapp/phone-utils.ts`)
  and the inbox sidebar uses it, but the contacts **table** (`src/app/(dashboard)/contacts/page.tsx`)
  and the detail **drawer header** (`src/components/contacts/contact-detail-view.tsx`) print the
  raw `contact.phone` — no `+`, no formatting. On entry the phone is free text with no country
  picker and no captured country code.
- **No human-readable contact ID.** Contacts are identified only by their opaque Convex `_id`.
  (Precedent for house-style codes: `convex/attribution.ts` uses `HY-XXXXXX`.)
- **List search matches `name` only.** You cannot find a contact by phone number, email, or ID
  from the main list (documented gap in `convex/contacts.ts`).
- **No quick path from a contact to their chat.**

## 2. Goals

In scope:

1. **Phone in `+CC` format** — a country-code picker on entry (default UAE `+971`); display as
   `+971 50 123 4567` everywhere a contact's phone appears.
2. **Human-readable Contact ID** — sequential `HC-000123`, unique per account, shown on the list
   and detail view, searchable, and copyable.
3. **Search by phone / email / ID** in the contacts list.
4. **Open WhatsApp chat** from a contact, and **copy Contact ID**.

Out of scope (deferred, not in this pass):

- Unifying the extended CRM fields (address / nationality / preferred destination / etc.) into the
  Contacts detail drawer — today editable only from the inbox contact sidebar.
- CSV export of contacts.
- An account-configurable default country code (we hardcode UAE; see §5).

## 3. Decisions (locked)

- Contact ID style: **sequential** `HC-000123` (customer-number style), prefix `HC-`.
- Phone input: **country picker backed by `libphonenumber-js`** (new dependency), default country UAE.
- Search: matches **name / phone / email / contact ID**.
- Extras: **open-chat action + copy-ID** included; unified detail view + CSV export deferred.

## 4. Contact ID — data model, allocation, backfill

### 4.1 Format

- `HC-` + the account's running contact number, zero-padded to a **minimum of 6 digits**
  (`HC-000001`). Numbers past 999999 render with their natural width (`HC-1000000`) — the pad is a
  minimum, not a cap.
- Uppercase, ASCII. Stored verbatim in `contactCode`.

### 4.2 Schema (`convex/schema.ts`)

- `contacts`: add `contactCode: v.optional(v.string())` and index `by_account_code`
  on `["accountId", "contactCode"]`.
  - Optional in the schema so pre-backfill rows validate, but **always written** on every new
    insert (same additive/backward-compatible convention as the extended contact fields).
- New table `counters`:

  ```ts
  counters: defineTable({
    accountId: v.id("accounts"),
    name: v.string(),   // e.g. "contacts"
    value: v.number(),  // last-allocated number (0 = none yet)
  }).index("by_account_name", ["accountId", "name"]),
  ```

  A dedicated counter table (vs. a field on `accounts`) isolates per-create write contention from
  the frequently-read `accounts` row and generalises to future sequences (deal / invoice numbers).

### 4.3 Allocation

- A shared server helper allocates + formats the code and inserts the contact. Requirement:
  **every** `ctx.db.insert("contacts", …)` call site routes through it. Audit and convert all of:
  - `contacts.create` (manual form)
  - `findOrCreateContactByPhone` (public REST API; used by `apiV1`)
  - `findOrCreateByPhoneInternal` (action-callable variant)
  - inbound WhatsApp auto-create (whatever ingest path inserts a contact on first inbound message)
  - bulk **import** (allocate N numbers in a single counter increment)
- Single-allocation: read the `(accountId, "contacts")` counter, `value + 1`, patch it, format
  `HC-` + padded value, insert with `contactCode`. If no counter row exists, create it at `1`.
- Batch allocation (import of N): read the counter once, reserve `[value+1 … value+N]`, patch to
  `value + N`, assign sequentially.
- **Atomicity:** Convex mutations are transactional with optimistic-concurrency retry, so two
  concurrent creates that both touch the counter row conflict and one is retried — no duplicate
  numbers. No extra locking needed.

### 4.4 Backfill

- One-shot `internalMutation` (e.g. `contacts.backfillContactCodes`) that, per account:
  - loads contacts ordered by `_creationTime` ascending,
  - assigns `HC-` codes to any contact missing `contactCode`, continuing from the current counter,
  - seeds/updates the `counters` row to the highest number assigned.
- **Idempotent:** contacts that already have a code are skipped; re-running is safe.
- Run once at rollout, after deploy (see §8).

## 5. Phone — input + display (`libphonenumber-js`)

### 5.1 Input — `PhoneInput` component

- New reusable component: a country selector (flag emoji + `+dial code`, searchable) beside a
  national-number input. Composes the two into an **E.164** string via `libphonenumber-js`
  (`AsYouType` for live formatting, `parsePhoneNumber` for the E.164 value).
- **Default country: UAE (`AE` / `+971`)** — a `DEFAULT_COUNTRY` constant. (Single-tenant internal
  CRM; an account-level setting is deferred per §2.)
- **Validation:** `isValidPhoneNumber(e164)` gates save; invalid shows an inline error. The existing
  exact-duplicate hard-block (`DUPLICATE_PHONE` on `phoneNormalized`) is preserved unchanged.
- Used in: the create/edit `ContactForm` phone field, and the `ContactDetailView` Details-tab phone
  field. Both currently plain `<Input>`.
- `phoneNormalized` continues to be `normalizePhone(phone)` (digits only) — dedup and all existing
  lookups keep working.

### 5.2 Display — `formatPhoneDisplay()`

- New util (in `src/lib/whatsapp/phone-utils.ts`): `parsePhoneNumber(value).formatInternational()`
  → `+971 50 123 4567`; on unparseable input, fall back to the existing `formatPhoneIntl(value)`.
- Applied wherever a contact's primary phone renders: the contacts **table** row, the detail
  **header**, and any other contact-phone render sites found during implementation.
- Existing WhatsApp contacts already store the country code (Meta delivers `wa_id` with it), so they
  format correctly with no data change.

## 6. Search by phone / email / ID (`contacts.list`)

- When `search` is present, replace the current name-only search-index path with an **in-memory
  account scan** (same approach as the existing `filterByTags`) matching, case-insensitively:
  - `name` contains term,
  - `phoneNormalized` contains the term's digits,
  - `email` contains term,
  - `contactCode` matches (see lenient rule below).
  Return a **bounded** result set (e.g. first 100 matches) — search does not need infinite
  pagination. When `search` is absent, the existing cursor pagination path is unchanged.
- **Lenient ID matching:** a query like `42`, `000042`, or `HC-000042` all match `HC-000042`.
  Rule: strip a leading `HC` and non-digits from the query; if digits remain, compare numerically
  (ignoring leading zeros) to the numeric part of `contactCode`; also allow a direct
  case-insensitive substring match on the full code.
- Server-side phone masking for sub-supervisor roles (`maskContactPhone`) still applies to results,
  unchanged.

## 7. Open chat + copy ID + ID surfacing (UI)

- **Contacts table** (`page.tsx`): add a **Contact ID** column (`HC-…`, monospace); render the phone
  column via `formatPhoneDisplay`. Add **Open chat** to the row's actions dropdown.
- **Detail drawer** (`contact-detail-view.tsx`): show `HC-…` in the header with a **copy** button
  (mirroring the existing copy-phone control); add an **Open chat** button beside **Send template**.
  - Open chat → `useMutation(api.conversations.findOrCreateForContact)({ contactId })` → navigate to
    the inbox using its existing conversation deep-link URL param (confirm exact param during
    implementation from `src/app/(dashboard)/inbox/page.tsx`). Gated by the same `send-messages`
    capability used for other write actions; `findOrCreateForContact` already requires `agent`+.
- **UI adapter/types:** surface `contactCode` through `toUiContact` and the `Contact` type so the
  page/detail/form can read it.

## 8. Testing & rollout

### Testing (TDD, offline — matches the repo)

- `vitest`: `formatPhoneDisplay`, the `HC-` formatter, the lenient ID-match helper, and the
  `PhoneInput` compose/validate logic.
- `convex-test`: the allocator (single + batch, uniqueness, concurrent-create safety), each converted
  creation path, the backfill mutation (ordering + idempotency), and `contacts.list` search across
  name/phone/email/ID.
- Keep the full existing suite green.

### Build / deploy constraints

- The repo has **one live self-hosted Convex** (`convex-api.holidayys.co`); `convex dev` / `deploy` /
  `codegen` all push to **prod**. Build offline by hand-editing `convex/_generated/` for the new
  `counters` table and the `contactCode` field/index. `convex-test` runs fully offline.
- **This change will not be deployed by the implementer.** Rollout checklist handed to the owner:
  1. `convex deploy` (schema: `counters` table, `contacts.contactCode` + `by_account_code`).
  2. Run `contacts.backfillContactCodes` (assigns `HC-` codes to existing contacts; idempotent).
  3. Spot-check: existing contacts show codes + formatted phones; a new manual contact gets the next
     code and enforces a valid `+CC` number.
  4. Frontend ships via Netlify on `main`.

## 9. Risks & edge cases

- **Missed insert path** → a contact without a code. Mitigation: audit every
  `ctx.db.insert("contacts", …)` site (§4.3) and cover each with a `convex-test`.
- **`libphonenumber-js` bundle size.** Acceptable for the value; import narrowly (avoid pulling
  examples/metadata beyond `min` where possible).
- **Very large accounts + in-memory search.** Matches the existing `filterByTags` pattern and is
  bounded; acceptable now, revisit with a search index if contact volume grows large.
- **Backfill on live prod.** Idempotent and ordered by `_creationTime`; safe to re-run.

## 10. Files expected to change (indicative)

- `convex/schema.ts` — `contactCode` + `by_account_code`, `counters` table.
- `convex/contacts.ts` — allocator helper, route all create paths, backfill mutation, `list` search.
- `convex/apiV1.ts` / inbound-ingest / import mutation — route through the allocator.
- `convex/_generated/*` — hand-edited to build offline.
- `src/lib/whatsapp/phone-utils.ts` — `formatPhoneDisplay`.
- `src/components/ui/phone-input.tsx` (new) — country-picker phone field.
- `src/components/contacts/contact-form.tsx`, `contact-detail-view.tsx` — PhoneInput, copy-ID, open-chat.
- `src/app/(dashboard)/contacts/page.tsx` — ID column, formatted phone, open-chat row action.
- `src/lib/convex/adapters.ts` + `src/types` — surface `contactCode`.
- `package.json` — add `libphonenumber-js`.
- Tests alongside each of the above.
