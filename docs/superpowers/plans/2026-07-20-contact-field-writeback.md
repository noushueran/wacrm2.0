# Qualification field write-back — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop reps hand-typing facts the AI already extracted — land the qualification engine's destination, nationality, email, travel dates, travellers and budget onto the contact record.

**Architecture:** Task 1 adds three optional columns (`travelDates`, `travelers`, `budget`) end to end, so a rep can record them by hand — schema → mutation → adapter → client type → sidebar → i18n. Task 2 adds a pure mapping library and calls it from `completeQualification`, filling only blanks.

**Tech Stack:** Convex, Next.js (see `AGENTS.md` — this is not the Next.js you may know), React, Tailwind, next-intl, vitest.

Spec: `docs/superpowers/specs/2026-07-20-contact-field-writeback-design.md`.

## Global Constraints

- **NEVER run `npx convex dev`, `npx convex deploy`, or `npx convex codegen`.** One live self-hosted Convex; all three push to PRODUCTION. This branch DOES add schema columns, so a deploy is required — but it is **owner-gated and happens after merge**, never during implementation.
- **`convex/_generated/api.d.ts` needs no edit** — every function added here is an export on an existing module, so `typeof` reflection picks it up. Do not regenerate it.
- **Fill blanks only.** The write must never overwrite a non-empty contact column. This is what makes the feature incapable of destroying data, and it is the single most important behaviour to preserve.
- **Skip `low` confidence**, matching the existing convention at `qualificationEngine.ts:627`, `:643`, `:716`.
- **No new dependency.** No jsdom, no `@testing-library/react`.
- **Baselines measured on this branch (`feat/contact-field-writeback` @ 5979d03), 2026-07-20:** `npm test` → **1965 passed / 152 files**; `npm run lint` → **0 errors, 15 warnings**, all pre-existing. Lint gate is "no NEW findings". `npm install` has already been run in this worktree. When checking whether lint flags *your* files, list the reported file paths — every absolute path here contains the worktree name, so a substring grep gives a false positive.

---

### Task 1: Three new contact columns, end to end

**Files:**
- Modify: `convex/schema.ts` (contacts extended block, from `:80`)
- Modify: `convex/contacts.ts` (`update` args from `:414`, patch type from `:433`)
- Modify: `src/lib/convex/adapters.ts` (`toUiContact`, near `:131`)
- Modify: `src/types/index.ts` (`Contact`, near `:124`)
- Modify: `src/components/inbox/contact-sidebar.tsx` (`EditForm` `:52`, `formToState` `:59`, save `:174`, Travel profile section `:425`)
- Modify: `messages/en.json` (`Inbox.sidebar`)
- Test: `convex/contacts.test.ts` (append)

**Interfaces:**
- Produces: `contacts.travelDates`, `contacts.travelers`, `contacts.budget` — all `v.optional(v.string())`, writable through `api.contacts.update`, readable as `travel_dates` / `travelers` / `budget` on the client `Contact`. Task 2 writes them.

- [ ] **Step 1: Write the failing test**

Append to `convex/contacts.test.ts` (reuse that file's existing seed helpers — read the top of the file first and follow them exactly rather than inventing new ones):

```ts
test("update round-trips the travel-profile fields", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, {
    name: "Ag", email: "ag@x.com", role: "agent",
  });
  const contactId = await t.run((ctx) =>
    ctx.db.insert("contacts", {
      accountId, phone: "+15551230199", phoneNormalized: "15551230199", name: "X",
    }),
  );
  await asUser.mutation(api.contacts.update, {
    contactId,
    travelDates: "mid December",
    travelers: "2 adults + 1 child aged 9",
    budget: "around AED 3,000 per person",
  });
  const row = await t.run((ctx) => ctx.db.get(contactId));
  expect(row).toMatchObject({
    travelDates: "mid December",
    travelers: "2 adults + 1 child aged 9",
    budget: "around AED 3,000 per person",
  });
});
```

There is no `seedContact` helper in that file — contacts are inserted inline,
exactly as above (see the tests around `convex/contacts.test.ts:1296` and
`:1313`). `seedAccountMember` returns `{ userId, accountId, asUser }`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/contacts.test.ts -t "travel-profile"`
Expected: FAIL — `travelDates` is not a valid argument to `contacts.update`, so convex-test rejects the call with a validation error.

- [ ] **Step 3: Add the columns to the schema**

In `convex/schema.ts`, inside `contacts: defineTable({...})`, immediately after the `preferredDestination` line (`:87`):

```ts
    // Travel-profile detail the qualification engine extracts and the
    // contact panel edits. FREE TEXT on purpose: the extractor returns
    // prose ("mid December", "2 adults + 1 child aged 9", "around AED
    // 3,000 per person"), and parsing that into dates/numbers is a
    // separate problem with its own failure modes. Same additive,
    // no-migration shape as the extended CRM detail above.
    travelDates: v.optional(v.string()),
    travelers: v.optional(v.string()),
    budget: v.optional(v.string()),
```

- [ ] **Step 4: Accept them in the update mutation**

In `convex/contacts.ts`, add to `update`'s `args` after `preferredDestination` (`:425`):

```ts
    travelDates: v.optional(v.string()),
    travelers: v.optional(v.string()),
    budget: v.optional(v.string()),
```

and to the `patch` type literal after `preferredDestination` (`:445`):

```ts
      travelDates: string;
      travelers: string;
      budget: string;
```

The handler spreads `...rest`, so no further change is needed there.

- [ ] **Step 5: Carry them to the client**

In `src/lib/convex/adapters.ts`, in `toUiContact` after `preferred_destination` (`:131`):

```ts
    travel_dates: doc.travelDates,
    travelers: doc.travelers,
    budget: doc.budget,
```

In `src/types/index.ts`, in `Contact` after `preferred_destination?: string;` (`:124`):

```ts
  /** Travel-profile detail — free text, written by the qualification
   *  engine (blanks only) and editable in the contact panel. */
  travel_dates?: string;
  travelers?: string;
  budget?: string;
```

- [ ] **Step 6: Add the i18n labels**

In `messages/en.json`, inside `Inbox.sidebar` (it already holds `nationality`, `preferredDestination`, `notFilled`):

```json
    "travelDates": "Travel dates",
    "travelers": "Travellers",
    "budget": "Budget",
```

- [ ] **Step 7: Render them in the sidebar's Travel profile section**

In `src/components/inbox/contact-sidebar.tsx`:

Add to the `EditForm` type (after `preferredDestination: string;`, `:55`):
```ts
  travelDates: string;
  travelers: string;
  budget: string;
```

Add to `formToState` (after the `preferredDestination` line, `:69`):
```ts
    travelDates: c.travel_dates ?? "",
    travelers: c.travelers ?? "",
    budget: c.budget ?? "",
```

Add to the save payload (after the `preferredDestination` line, `:177`):
```ts
        travelDates: form.travelDates.trim() || undefined,
        travelers: form.travelers.trim() || undefined,
        budget: form.budget.trim() || undefined,
```

And inside the existing `<Section icon={Plane} label={tSidebar("sectionTravel")}>` block (`:426`), after the `preferredDestination` `<Field>`, three more following that exact pattern:
```tsx
            <Field
              label={tSidebar("travelDates")}
              editing={editing}
              value={form?.travelDates ?? ""}
              display={contact.travel_dates ?? ""}
              onChange={set("travelDates")}
              placeholder={tSidebar("travelDates")}
              notFilled={tSidebar("notFilled")}
            />
            <Field
              label={tSidebar("travelers")}
              editing={editing}
              value={form?.travelers ?? ""}
              display={contact.travelers ?? ""}
              onChange={set("travelers")}
              placeholder={tSidebar("travelers")}
              notFilled={tSidebar("notFilled")}
            />
            <Field
              label={tSidebar("budget")}
              editing={editing}
              value={form?.budget ?? ""}
              display={contact.budget ?? ""}
              onChange={set("budget")}
              placeholder={tSidebar("budget")}
              notFilled={tSidebar("notFilled")}
            />
```

- [ ] **Step 8: Run the tests**

Run: `npx vitest run convex/contacts.test.ts && npx tsc --noEmit`
Expected: PASS, tsc clean.

- [ ] **Step 9: Commit**

```bash
git add convex/schema.ts convex/contacts.ts convex/contacts.test.ts \
  src/lib/convex/adapters.ts src/types/index.ts \
  src/components/inbox/contact-sidebar.tsx messages/en.json
git commit -m "feat(contacts): travel dates, travellers and budget on the contact record"
```

---

### Task 2: Map extracted fields onto the contact at qualification

**Files:**
- Create: `convex/lib/qualification/contactFields.ts`
- Create: `convex/lib/qualification/contactFields.test.ts`
- Modify: `convex/qualificationEngine.ts` (`completeQualification`, from `:664`)
- Test: `convex/qualificationEngine.test.ts` (append)

**Interfaces:**
- Consumes: the columns from Task 1.
- Produces: `mapFieldsToContact(fields, contact) => Partial<Doc<"contacts">>`, pure.

- [ ] **Step 1: Write the failing tests**

Create `convex/lib/qualification/contactFields.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Doc } from "../../_generated/dataModel";
import { mapFieldsToContact } from "./contactFields";

type Field = Parameters<typeof mapFieldsToContact>[0][number];

function field(over: Partial<Field> = {}): Field {
  return { key: "destination", value: "Dubai", confidence: "high", ...over };
}

function contact(over: Partial<Doc<"contacts">> = {}): Doc<"contacts"> {
  return {
    _id: "c1" as Doc<"contacts">["_id"],
    _creationTime: 1_700_000_000_000,
    accountId: "a1" as Doc<"contacts">["accountId"],
    phone: "+971500000001",
    phoneNormalized: "971500000001",
    ...over,
  } satisfies Doc<"contacts">;
}

describe("mapFieldsToContact", () => {
  it("maps known keys onto their columns", () => {
    expect(
      mapFieldsToContact(
        [
          field({ key: "destination", value: "Dubai" }),
          field({ key: "travel_dates", value: "mid December" }),
          field({ key: "travelers", value: "2 adults" }),
          field({ key: "budget", value: "AED 3000 pp" }),
          field({ key: "nationality", value: "Indian" }),
          field({ key: "email", value: "a@x.co" }),
        ],
        contact(),
      ),
    ).toEqual({
      preferredDestination: "Dubai",
      travelDates: "mid December",
      travelers: "2 adults",
      budget: "AED 3000 pp",
      nationality: "Indian",
      email: "a@x.co",
    });
  });

  it("normalises punctuation and case in the key", () => {
    expect(mapFieldsToContact([field({ key: "Travel-Dates", value: "June" })], contact()))
      .toEqual({ travelDates: "June" });
  });

  it("falls back to the label when the key is unrecognised", () => {
    expect(
      mapFieldsToContact(
        [field({ key: "q1", label: "Budget per person", value: "AED 2500" })],
        contact(),
      ),
    ).toEqual({ budget: "AED 2500" });
  });

  it("prefers the key over the label when both match different columns", () => {
    expect(
      mapFieldsToContact(
        [field({ key: "budget", label: "Travel dates", value: "AED 2500" })],
        contact(),
      ),
    ).toEqual({ budget: "AED 2500" });
  });

  it("never overwrites a column the contact already has", () => {
    expect(
      mapFieldsToContact(
        [field({ key: "destination", value: "Dubai" })],
        contact({ preferredDestination: "Georgia" }),
      ),
    ).toEqual({});
  });

  it("keeps the FIRST field when two keys map to the same column", () => {
    expect(
      mapFieldsToContact(
        [
          field({ key: "destination", value: "Dubai" }),
          field({ key: "destination_country", value: "UAE" }),
        ],
        contact(),
      ),
    ).toEqual({ preferredDestination: "Dubai" });
  });

  it("skips low confidence, blank values, and unknown keys", () => {
    expect(
      mapFieldsToContact(
        [
          field({ key: "destination", value: "Dubai", confidence: "low" }),
          field({ key: "budget", value: "   " }),
          field({ key: "visa_type", value: "tourist" }),
          field({ key: "looking_for", value: "holiday package" }),
          field({ key: "country", value: "UAE" }),
        ],
        contact(),
      ),
    ).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/lib/qualification/contactFields.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the mapper**

Create `convex/lib/qualification/contactFields.ts`:

```ts
import type { Doc } from "../../_generated/dataModel";

/** The contact columns the qualification engine may fill. */
type Target = "email" | "nationality" | "preferredDestination" | "travelDates" | "travelers" | "budget";

type ExtractedField = {
  key: string;
  label?: string;
  value: string;
  confidence: "high" | "medium" | "low";
};

/**
 * Normalised alias -> contact column.
 *
 * `country` is deliberately absent: in a travel CRM "country" reads as
 * the DESTINATION at least as often as the customer's residence, and a
 * wrong guess here is permanent — the caller only ever fills blanks, so
 * nothing would later correct it. `looking_for` is absent too; it names
 * the service, which already lands on `session.serviceName`.
 */
const ALIASES: Record<string, Target> = {
  email: "email", emailaddress: "email", mail: "email",
  nationality: "nationality", citizenship: "nationality",
  destination: "preferredDestination",
  destinationcountry: "preferredDestination",
  preferreddestination: "preferredDestination",
  travellingto: "preferredDestination",
  traveldates: "travelDates", dates: "travelDates",
  travelmonth: "travelDates", when: "travelDates",
  travelers: "travelers", travellers: "travelers",
  pax: "travelers", passengers: "travelers", numberoftravelers: "travelers",
  budget: "budget", budgetperperson: "budget",
  perpersonbudget: "budget", tripbudget: "budget",
};

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Pure mapping of a session's extracted fields onto a contact patch.
 *
 * Returns ONLY what should be written: blanks-only (never overwrites a
 * value a human may have corrected), `low` confidence excluded to match
 * the engine's existing convention, empty-string values skipped. An
 * empty object means "write nothing".
 */
export function mapFieldsToContact(
  fields: ExtractedField[],
  contact: Doc<"contacts">,
): Partial<Doc<"contacts">> {
  const patch: Partial<Record<Target, string>> = {};
  for (const f of fields) {
    if (f.confidence === "low") continue;
    const value = f.value.trim();
    if (!value) continue;
    // Key beats label: the key is the extractor's own identifier, while
    // a label is human prose that may mention another field in passing.
    const target = ALIASES[normalize(f.key)] ?? (f.label ? ALIASES[normalize(f.label)] : undefined);
    if (!target) continue;
    if (patch[target] !== undefined) continue; // first field wins
    if (contact[target]) continue; // blanks only — a human's value stands
    patch[target] = value;
  }
  return patch;
}
```

- [ ] **Step 4: Run the mapper tests**

Run: `npx vitest run convex/lib/qualification/contactFields.test.ts && npx tsc --noEmit`
Expected: PASS (7 tests), tsc clean.

- [ ] **Step 5: Call it from `completeQualification`**

In `convex/qualificationEngine.ts`, add to the existing import block from `./lib/qualification/analyze` region — a new import line beside the other `lib/qualification` imports:

```ts
import { mapFieldsToContact } from "./lib/qualification/contactFields";
```

Then, inside `completeQualification`, immediately AFTER the `await ctx.db.patch(session._id, { status: "qualified", ... })` call (`:686-691`) and BEFORE the `applyStageTransition` block:

```ts
    // Write back what the assistant already extracted, so a rep never
    // re-types it. Blanks only — a value already on the contact was
    // either typed by a human or written by an earlier qualification,
    // and either way it outranks a fresh guess. Runs once, here, rather
    // than on every analysis pass: with blanks-only semantics whatever
    // lands FIRST wins permanently, so writing early would let a shaky
    // mid-conversation guess lock out the settled answer.
    const contactPatch = mapFieldsToContact(session.fields, contact);
    if (Object.keys(contactPatch).length > 0) {
      await ctx.db.patch(session.contactId, contactPatch);
    }
```

This needs the contact document. `completeQualification` does not load one today, so add immediately after the `conversation` guard (`:683`):

```ts
    const contact = await ctx.db.get(session.contactId);
    if (!contact) return;
```

Place this before the `const now = Date.now();` line. Returning early when the contact is missing is correct — a session whose contact has been deleted has nothing left to qualify.

- [ ] **Step 6: Write the engine integration test**

Append to `convex/qualificationEngine.test.ts`, following that file's existing helpers (`seedAttributed`, `seedCustomerMessage`, `sessionsFor`) exactly as the P6 tests do:

```ts
test("qualification writes extracted fields onto the contact, without overwriting", async () => {
  const t = convexTest(schema, modules);
  const base = await seedAttributed(t);
  // a value a rep already typed — must survive
  await t.run((ctx) => ctx.db.patch(base.contactId, { preferredDestination: "Georgia" }));
  await t.run(async (ctx) => {
    const s = await ctx.db
      .query("qualificationSessions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", base.conversationId))
      .first();
    if (s) await ctx.db.delete(s._id);
  });
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "[[COMPLETE]] score:85 field:a=1;field:b=2;field:c=3");
  await t.action(internal.qualificationEngine.analyzeInbound, {
    accountId: base.accountId, conversationId: base.conversationId, contactId: base.contactId,
  });

  const [session] = (await sessionsFor(t, base.conversationId)).filter((s) => s.status === "qualified");
  expect(session).toBeDefined();

  const contact = await t.run((ctx) => ctx.db.get(base.contactId));
  // the rep's value stands
  expect(contact?.preferredDestination).toBe("Georgia");
});
```

The seeded message text drives this directly: `syntheticAnalysisRaw`
(`qualificationEngine.ts:153`) parses `field:([a-z_]+)=([^;]+)` out of the
latest message and returns each as a **high-confidence** field. So the test
names the keys it wants — no stub-bending, no hand-seeded session. Replace the
`seedCustomerMessage` line above with:

```ts
  await seedCustomerMessage(t, base.accountId, base.conversationId,
    "[[COMPLETE]] score:85 field:destination=Dubai;field:travel_dates=mid December;" +
    "field:budget=AED 3000 per person;field:nationality=Indian");
```

and assert both halves of the rule:

```ts
  const contact = await t.run((ctx) => ctx.db.get(base.contactId));
  // blanks filled from what the assistant extracted
  expect(contact).toMatchObject({
    travelDates: "mid December",
    budget: "AED 3000 per person",
    nationality: "Indian",
  });
  // …and the rep's pre-existing value is untouched
  expect(contact?.preferredDestination).toBe("Georgia");
```

Note the key regex is `[a-z_]+`, so keys must be lowercase with underscores —
`travel_dates` works, `travelDates` would not be parsed at all.

- [ ] **Step 7: Run the full gate**

```bash
npm test
npx tsc --noEmit
npm run build
npm run lint 2>&1 | tail -5
```

Expected: the 1965 baseline plus your new tests, tsc clean, build green, lint **0 errors / 15 warnings** with none in the new or changed files.

- [ ] **Step 8: Commit**

```bash
git add convex/lib/qualification/contactFields.ts convex/lib/qualification/contactFields.test.ts \
  convex/qualificationEngine.ts convex/qualificationEngine.test.ts
git commit -m "feat(qualification): fill blank contact fields from what the assistant extracted"
```

---

## Deploy runbook (owner-gated — do NOT run during implementation)

1. `git fetch origin && git merge origin/main`, then re-run the Task 2 gate. Check `gh pr list --state merged --limit 5` for surprises (deploy-collision lesson, 2026-07-18).
2. Copy `.env.local` from the main checkout into the worktree (worktrees do not inherit it).
3. 🚨 **`npx convex deploy` is REQUIRED here and must happen BEFORE the Netlify build.** Unlike the voice-transcript change, this adds schema columns: the deployed schema must accept `travelDates` / `travelers` / `budget` before any write containing them succeeds. Deploying the frontend first would give reps a form whose saves fail validation.
4. Merge the PR → Netlify rebuilds and ships the sidebar fields.
5. Verify live: open a contact, confirm the three Travel profile fields render and save; then let one lead qualify and confirm the blanks fill while a pre-typed value is untouched.
6. Rollback is a plain revert. The columns are optional, so leaving them in the deployed schema after a frontend revert is harmless.

## Collision watch

`feat/r2-media-storage` also edits `convex/schema.ts` and `src/lib/convex/adapters.ts`; `feat/voice-transcript-inbox` (PR #41) also edits `src/lib/convex/adapters.ts` and `src/types/index.ts`. Different tables, different adapter functions, different interfaces — so expect textual conflicts rather than semantic ones. Whichever merges last must re-run the full suite rather than accepting the merge on faith.
