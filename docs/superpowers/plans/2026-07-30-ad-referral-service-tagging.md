# Ad-Referral Service Tagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag a click-to-WhatsApp lead's contact with the service its ad advertised, within seconds of the click, instead of waiting for an AI qualification session to complete.

**Architecture:** A pure, database-free matcher (`convex/lib/ads/serviceMatch.ts`) scores the ad signals already captured at ingest — referral headline/body/URL, resolved Meta ad + campaign names, cached landing-page title/description — against the account's `kbServices` catalogue (name + aliases). A thin Convex orchestrator (`convex/adServiceTagging.ts`) gathers those signals, calls the matcher, and applies the tag via the existing `tagContactForService` helper with a new `source: "ad"`. Two rule passes per **ad referral** (on the click, then on the next customer message) — not per conversation, since a second ad click into the same chat is genuinely new information and earns its own budget; if both miss, one AI classify call records a pending row in the existing "Suggest tags" banner. Every step is scheduled best-effort from `ingest.processInbound` and can never delay or fail message ingestion.

**Tech Stack:** Convex (queries/mutations/actions/scheduler), TypeScript, Vitest + `convex-test`, Next.js + next-intl for the UI marker.

## Global Constraints

- **Never run `convex deploy`, `convex dev`, or `convex codegen`.** Not at any point in this plan, not to "check types". The owner deploys.
- **Concurrent sessions share this working tree.** Stage explicit paths in every `git add` — never `git add -A`, never `git add .`.
- **Read the relevant guide in `node_modules/next/dist/docs/` before writing Next.js code.** This is not the Next.js in your training data.
- **Use the Grep/Glob tools, not `grep -r`,** which traverses `node_modules/` and `.claude/worktrees/` and returns duplicate hits.
- Run tests with `npx vitest run <path>`. Lint with `npx eslint <changed paths>` — scope to changed files only, never the whole repo.
- Convex schema fields added by this plan are **all optional** — the deployment has live data and a required field would reject every existing row.
- Cross-tenant discipline: every document read in a Convex handler is checked for `accountId` equality against the caller's account, matching the surrounding modules.
- Spec: `docs/superpowers/specs/2026-07-30-ad-referral-service-tagging-design.md`.

---

### Task 1: Pure service matcher

The whole matching decision lives here, with no Convex dependency, so it can be tested exhaustively and cheaply.

**Files:**
- Create: `convex/lib/ads/serviceMatch.ts`
- Test: `convex/lib/ads/serviceMatch.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SignalKey = keyof MatchSignals`
  - `type MatchSignals = { headline?, body?, sourceUrl?, adName?, adSetName?, campaignName?, landingTitle?, landingDescription?, customerText?: string }`
  - `type ServiceCandidate = { key: string; name: string; aliases: string[]; status: "active" | "paused" }`
  - `type MatchResult = { status: "matched"; serviceKey: string; serviceName: string; matchedOn: SignalKey } | { status: "ambiguous" } | { status: "none" }`
  - `function matchService(signals: MatchSignals, services: ServiceCandidate[]): MatchResult`

- [ ] **Step 1: Write the failing test**

Create `convex/lib/ads/serviceMatch.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { matchService, type ServiceCandidate } from "./serviceMatch";

const SERVICES: ServiceCandidate[] = [
  {
    key: "uae-visa",
    name: "UAE Visa",
    aliases: ["uae visit visa", "dubai visa", "tourist visa"],
    status: "active",
  },
  {
    key: "flight-booking",
    name: "Flight Booking",
    aliases: ["air ticket", "flight ticket"],
    status: "active",
  },
  {
    key: "umrah",
    name: "Umrah Package",
    aliases: ["umrah"],
    status: "paused",
  },
];

describe("matchService", () => {
  test("matches the service name in the headline", () => {
    const res = matchService({ headline: "Apply for your UAE Visa today" }, SERVICES);
    expect(res).toEqual({
      status: "matched",
      serviceKey: "uae-visa",
      serviceName: "UAE Visa",
      matchedOn: "headline",
    });
  });

  test("matches an alias", () => {
    const res = matchService({ headline: "Fast Dubai visa processing" }, SERVICES);
    expect(res.status).toBe("matched");
    expect(res).toMatchObject({ serviceKey: "uae-visa" });
  });

  test("ignores case, punctuation and diacritics", () => {
    const res = matchService({ headline: "U.A.E.  VÍSA — apply now!" }, SERVICES);
    expect(res).toMatchObject({ status: "matched", serviceKey: "uae-visa" });
  });

  test("matches a URL slug", () => {
    const res = matchService(
      { sourceUrl: "https://amaniworld.com/uae-visit-visa?utm_source=fb" },
      SERVICES,
    );
    expect(res).toMatchObject({
      status: "matched",
      serviceKey: "uae-visa",
      matchedOn: "sourceUrl",
    });
  });

  test("ad name outranks a conflicting body match", () => {
    const res = matchService(
      { adName: "UAE Visa - Retarget", body: "We also do air ticket bookings" },
      SERVICES,
    );
    expect(res).toMatchObject({
      status: "matched",
      serviceKey: "uae-visa",
      matchedOn: "adName",
    });
  });

  test("two distinct services at the deciding level is ambiguous", () => {
    const res = matchService(
      { headline: "Dubai visa and flight ticket combo" },
      SERVICES,
    );
    expect(res).toEqual({ status: "ambiguous" });
  });

  test("several terms of the same service is a hit, not ambiguity", () => {
    const res = matchService(
      { headline: "UAE Visa — the easiest tourist visa" },
      SERVICES,
    );
    expect(res).toMatchObject({ status: "matched", serviceKey: "uae-visa" });
  });

  test("no service term anywhere returns none", () => {
    const res = matchService({ headline: "Talk to our team" }, SERVICES);
    expect(res).toEqual({ status: "none" });
  });

  test("terms match on word boundaries, not inside longer words", () => {
    const res = matchService({ headline: "Revisage skincare" }, [
      { key: "visa", name: "Visa", aliases: [], status: "active" },
    ]);
    expect(res).toEqual({ status: "none" });
  });

  test("paused services are never candidates", () => {
    const res = matchService({ headline: "Umrah package deals" }, SERVICES);
    expect(res).toEqual({ status: "none" });
  });

  test("blank and whitespace-only aliases are ignored", () => {
    const res = matchService({ headline: "anything at all" }, [
      { key: "x", name: "  ", aliases: ["", "   "], status: "active" },
    ]);
    expect(res).toEqual({ status: "none" });
  });

  test("customerText is only consulted when supplied", () => {
    const without = matchService({ headline: "Talk to us" }, SERVICES);
    expect(without).toEqual({ status: "none" });

    const withText = matchService(
      { headline: "Talk to us", customerText: "I need a dubai visa" },
      SERVICES,
    );
    expect(withText).toMatchObject({
      status: "matched",
      serviceKey: "uae-visa",
      matchedOn: "customerText",
    });
  });

  test("an empty catalogue returns none", () => {
    expect(matchService({ headline: "UAE Visa" }, [])).toEqual({ status: "none" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/ads/serviceMatch.test.ts`
Expected: FAIL — cannot resolve `./serviceMatch`.

- [ ] **Step 3: Write the implementation**

Create `convex/lib/ads/serviceMatch.ts`:

```ts
// ============================================================
// Which service did this ad advertise? A pure, database-free decision
// over the signals `ingest.processInbound` already captures for a
// click-to-WhatsApp referral (spec: docs/superpowers/specs/
// 2026-07-30-ad-referral-service-tagging-design.md §1).
//
// Deliberately silent rather than wrong: when two different services
// both match at the deciding level the answer is `ambiguous`, not a
// coin flip. The tag vocabulary this writes into is the same one lead
// routing keys on (`lib/qualification/routing.ts` matches a tag by
// service name), so a confident wrong answer costs more than no answer.
// ============================================================

/** Every ad-derived text we can match against, weakest field optional. */
export type MatchSignals = {
  headline?: string;
  body?: string;
  sourceUrl?: string;
  adName?: string;
  adSetName?: string;
  campaignName?: string;
  landingTitle?: string;
  landingDescription?: string;
  /** The customer's own words — supplied on the retry pass only. */
  customerText?: string;
};

export type SignalKey = keyof MatchSignals;

/** One `kbServices` row, reduced to what matching needs. */
export type ServiceCandidate = {
  key: string;
  name: string;
  aliases: string[];
  status: "active" | "paused";
};

export type MatchResult =
  | {
      status: "matched";
      serviceKey: string;
      serviceName: string;
      matchedOn: SignalKey;
    }
  /** Two or more distinct services tied at the deciding level. */
  | { status: "ambiguous" }
  /** No service term appeared in any signal. */
  | { status: "none" };

/**
 * Signals grouped by strength, strongest first. The FIRST group that
 * yields any hit decides the result — a hit in a later group never
 * overrides an earlier one. Ad/campaign names lead because a human
 * chose them to describe the ad; the customer's own text trails
 * because it arrives last and is the least controlled.
 */
const PRECEDENCE: SignalKey[][] = [
  ["adName", "adSetName", "campaignName"],
  ["headline"],
  ["landingTitle"],
  ["body", "landingDescription"],
  ["sourceUrl"],
  ["customerText"],
];

/**
 * Lowercase, strip diacritics, reduce every non-alphanumeric run to a
 * single space. Applied identically to haystack and needle so both sides
 * agree on what a "word" is.
 */
function normalize(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * A URL's own words: path + query only. The host is dropped — every ad
 * of every service shares it, so it can only produce false matches.
 */
function urlWords(raw: string): string {
  try {
    const url = new URL(raw);
    return normalize(`${url.pathname} ${url.search}`);
  } catch {
    return normalize(raw);
  }
}

export function matchService(
  signals: MatchSignals,
  services: ServiceCandidate[],
): MatchResult {
  const candidates = services
    .filter((s) => s.status === "active")
    .map((s) => ({
      key: s.key,
      name: s.name,
      // A service's name is itself a term, so a catalogue with no
      // aliases still matches ads that spell the service out.
      terms: [s.name, ...s.aliases].map(normalize).filter((t) => t.length > 0),
    }))
    .filter((c) => c.terms.length > 0);
  if (candidates.length === 0) return { status: "none" };

  for (const level of PRECEDENCE) {
    // Keyed by service so several terms of ONE service count once —
    // that is a stronger hit, not a tie.
    const hits = new Map<string, { name: string; matchedOn: SignalKey }>();

    for (const signal of level) {
      const raw = signals[signal];
      if (!raw) continue;
      const words = signal === "sourceUrl" ? urlWords(raw) : normalize(raw);
      if (!words) continue;
      // Space-padding both sides turns `includes` into a word-boundary
      // test without a per-term regex: " visa " cannot match inside
      // "revisage".
      const haystack = ` ${words} `;
      for (const candidate of candidates) {
        if (hits.has(candidate.key)) continue;
        if (candidate.terms.some((term) => haystack.includes(` ${term} `))) {
          hits.set(candidate.key, { name: candidate.name, matchedOn: signal });
        }
      }
    }

    if (hits.size === 1) {
      const [serviceKey, hit] = [...hits.entries()][0];
      return {
        status: "matched",
        serviceKey,
        serviceName: hit.name,
        matchedOn: hit.matchedOn,
      };
    }
    if (hits.size > 1) return { status: "ambiguous" };
  }

  return { status: "none" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/lib/ads/serviceMatch.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Lint**

Run: `npx eslint convex/lib/ads/serviceMatch.ts convex/lib/ads/serviceMatch.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/ads/serviceMatch.ts convex/lib/ads/serviceMatch.test.ts
git commit -m "feat(ads): match an ad's signals to a service in the catalogue"
```

---

### Task 2: Schema fields and a `source` on `tagContactForService`

Two small, independent-of-each-other changes that everything downstream needs.

**Files:**
- Modify: `convex/schema.ts` (`contactTags` ~line 155, `adReferrals` ~line 1960)
- Modify: `convex/qualificationEngine.ts:2430-2465` (`tagContactForService`)
- Test: `convex/qualificationEngine.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `contactTags.source` now accepts `"ad"` in addition to `"ai" | "manual"`.
  - `adReferrals` now carries `serviceMatchStatus?: "matched" | "unmatched" | "ambiguous" | "suggested"`, `serviceMatchKey?: string`, `serviceMatchedOn?: string`, `serviceMatchAttempts?: number`.
  - `tagContactForService(ctx, {accountId, contactId, serviceName, source?: "ai" | "ad"})` — `source` defaults to `"ai"`.

- [ ] **Step 1: Write the failing test**

Append to `convex/qualificationEngine.test.ts`:

```ts
test("tagContactForService records the requested source", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId } = await seedAccountAndContact(t);

  await t.run(async (ctx) => {
    await tagContactForService(ctx, {
      accountId,
      contactId,
      serviceName: "UAE Visa",
      source: "ad",
    });
  });

  const link = await t.run(async (ctx) =>
    ctx.db
      .query("contactTags")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .first(),
  );
  expect(link?.source).toBe("ad");
});

test("tagContactForService still defaults to the ai source", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId } = await seedAccountAndContact(t);

  await t.run(async (ctx) => {
    await tagContactForService(ctx, {
      accountId,
      contactId,
      serviceName: "UAE Visa",
    });
  });

  const link = await t.run(async (ctx) =>
    ctx.db
      .query("contactTags")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .first(),
  );
  expect(link?.source).toBe("ai");
});

test("tagContactForService leaves an existing link's source alone", async () => {
  const t = convexTest(schema, modules);
  const { accountId, contactId } = await seedAccountAndContact(t);

  await t.run(async (ctx) => {
    await tagContactForService(ctx, { accountId, contactId, serviceName: "UAE Visa" });
    await tagContactForService(ctx, {
      accountId,
      contactId,
      serviceName: "UAE Visa",
      source: "ad",
    });
  });

  const links = await t.run(async (ctx) =>
    ctx.db
      .query("contactTags")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect(),
  );
  expect(links).toHaveLength(1);
  expect(links[0].source).toBe("ai");
});
```

Read the top of `convex/qualificationEngine.test.ts` first. If it has no `seedAccountAndContact` helper, add this one above the new tests and import `tagContactForService` from `./qualificationEngine`:

```ts
async function seedAccountAndContact(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Acme",
      email: "acme@example.com",
    });
    const accountId = await ctx.db.insert("accounts", {
      name: "Acme's account",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15551230000",
      phoneNormalized: "15551230000",
    });
    return { accountId, contactId };
  });
}
```

Check the real `contacts` field list in `convex/schema.ts` before writing this helper and include every required field — `convex-test` rejects an insert that misses one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/qualificationEngine.test.ts -t "source"`
Expected: FAIL — `source` is not a valid `tagContactForService` argument / `"ad"` is not a valid `contactTags.source` value.

- [ ] **Step 3: Widen the `contactTags.source` union**

In `convex/schema.ts`, replace the `source` line inside `contactTags` (~line 159):

```ts
    // unset = manual (backward-compatible). "ad" = derived from a
    // click-to-WhatsApp referral before qualification ran
    // (convex/adServiceTagging.ts).
    source: v.optional(
      v.union(v.literal("ai"), v.literal("manual"), v.literal("ad")),
    ),
```

- [ ] **Step 4: Add the `adReferrals` match-state fields**

In `convex/schema.ts`, inside `adReferrals` (~line 1960), after the `isFirstTouch` line:

```ts
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
```

- [ ] **Step 5: Thread `source` through `tagContactForService`**

In `convex/qualificationEngine.ts`, change the signature and the insert (the function starts ~line 2430):

```ts
export async function tagContactForService(
  ctx: { db: import("./_generated/server").MutationCtx["db"] },
  args: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    serviceName: string;
    /** Provenance for the `contactTags` link. Defaults to "ai" — the
     *  qualification path that has always owned this helper. */
    source?: "ai" | "ad";
  },
): Promise<void> {
```

and the final insert in the same function:

```ts
  await ctx.db.insert("contactTags", {
    accountId: args.accountId,
    contactId: args.contactId,
    tagId: tag._id,
    source: args.source ?? "ai",
  });
```

Leave the `if (existing) return;` early return exactly as it is — first writer wins, so a contact already tagged by qualification is never rewritten to `"ad"`, and vice versa.

Also extend the docstring above the function: after the existing "linked with `source: \"ai\"`" sentence, note that `source` is now a parameter defaulting to `"ai"`, and that `convex/adServiceTagging.ts` passes `"ad"`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run convex/qualificationEngine.test.ts`
Expected: PASS — the three new tests plus every pre-existing test in the file.

- [ ] **Step 7: Lint**

Run: `npx eslint convex/schema.ts convex/qualificationEngine.ts convex/qualificationEngine.test.ts`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add convex/schema.ts convex/qualificationEngine.ts convex/qualificationEngine.test.ts
git commit -m "feat(tags): let tagContactForService record an 'ad' provenance"
```

---

### Task 3: `tagFromAd` — the rule-pass orchestrator

**Files:**
- Create: `convex/adServiceTagging.ts`
- Test: `convex/adServiceTagging.test.ts`

**Interfaces:**
- Consumes: `matchService`, `MatchSignals`, `ServiceCandidate` (Task 1); `tagContactForService(..., source)` and the `adReferrals` fields (Task 2); `landingUrlKey(raw: string): string | null` from `convex/lib/ai/adContext.ts`.
- Produces: `internal.adServiceTagging.tagFromAd({accountId, contactId, conversationId, trigger: "referral" | "followup"})` — an `internalMutation` returning `void`.

Note: the scheduler call to `internal.adServiceTagging.classifyAdService` is written in this task but that action does not exist until Task 4. Convex's `internal` object is generated from the filesystem, so **this task's tests must be run after Task 4's file exists, or the reference will not resolve.** To keep each task independently green, this task ends by scheduling nothing and Task 4 adds the scheduler line together with the action. The `nextAttempts >= 2` branch is therefore a no-op stub here, with its test added in Task 4.

- [ ] **Step 1: Write the failing test**

Create `convex/adServiceTagging.test.ts`:

```ts
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Acme",
      email: "acme@example.com",
    });
    const accountId = await ctx.db.insert("accounts", {
      name: "Acme's account",
      defaultCurrency: "USD",
      ownerUserId: userId,
    });
    const contactId = await ctx.db.insert("contacts", {
      accountId,
      phone: "+15551230000",
      phoneNormalized: "15551230000",
    });
    const conversationId = await ctx.db.insert("conversations", {
      accountId,
      contactId,
      status: "open",
      updatedAt: Date.now(),
    });
    await ctx.db.insert("kbServices", {
      accountId,
      key: "uae-visa",
      name: "UAE Visa",
      aliases: ["dubai visa"],
      status: "active",
      sortOrder: 0,
      updatedAt: Date.now(),
    });
    return { accountId, contactId, conversationId };
  });
}

async function seedReferral(
  t: ReturnType<typeof convexTest>,
  ids: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    conversationId: Id<"conversations">;
  },
  referral: { headline?: string; body?: string; sourceUrl?: string },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("adReferrals", {
      accountId: ids.accountId,
      contactId: ids.contactId,
      conversationId: ids.conversationId,
      waMessageId: `wamid.${Math.random()}`,
      sourceType: "ad",
      isFirstTouch: true,
      ...referral,
    }),
  );
}

async function tagsOf(t: ReturnType<typeof convexTest>, contactId: Id<"contacts">) {
  return await t.run(async (ctx) => {
    const links = await ctx.db
      .query("contactTags")
      .withIndex("by_contact", (q) => q.eq("contactId", contactId))
      .collect();
    return await Promise.all(
      links.map(async (l) => ({
        source: l.source,
        name: (await ctx.db.get(l.tagId))?.name,
      })),
    );
  });
}

test("a confident referral match tags the contact with source 'ad'", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });

  await t.mutation(internal.adServiceTagging.tagFromAd, {
    ...ids,
    trigger: "referral",
  });

  expect(await tagsOf(t, ids.contactId)).toEqual([
    { source: "ad", name: "UAE Visa" },
  ]);
});

test("re-running on a matched referral is a no-op", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Apply for your UAE Visa today" });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });

  expect(await tagsOf(t, ids.contactId)).toHaveLength(1);
});

test("a miss on the referral pass records unmatched and does not tag", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Talk to our team" });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });

  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("unmatched");
  expect(row?.serviceMatchAttempts).toBe(1);
});

test("a tie records ambiguous rather than guessing", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("kbServices", {
      accountId: ids.accountId,
      key: "flight-booking",
      name: "Flight Booking",
      aliases: [],
      status: "active",
      sortOrder: 1,
      updatedAt: Date.now(),
    });
  });
  const referralId = await seedReferral(t, ids, {
    headline: "UAE Visa and Flight Booking combo",
  });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });

  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("ambiguous");
});

test("the follow-up pass matches on the customer's own words", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Talk to our team" });
  await t.run(async (ctx) => {
    await ctx.db.insert("messages", {
      accountId: ids.accountId,
      conversationId: ids.conversationId,
      senderType: "customer",
      contentType: "text",
      contentText: "hi, I need a dubai visa",
      status: "delivered",
      timestamp: Date.now(),
    });
  });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });

  expect(await tagsOf(t, ids.contactId)).toEqual([
    { source: "ad", name: "UAE Visa" },
  ]);
});

test("attempts are capped at two", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Talk to our team" });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });

  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchAttempts).toBe(2);
});

test("a resolved campaign ad name outranks the referral body", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await t.run(async (ctx) => {
    await ctx.db.insert("campaignAds", {
      accountId: ids.accountId,
      adId: "ad-1",
      adName: "UAE Visa — retarget",
      resolveStatus: "resolved",
      attempts: 1,
    });
    await ctx.db.insert("adReferrals", {
      accountId: ids.accountId,
      contactId: ids.contactId,
      conversationId: ids.conversationId,
      waMessageId: "wamid.ad1",
      adId: "ad-1",
      sourceType: "ad",
      body: "nothing useful here",
      isFirstTouch: true,
    });
  });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_contact", (q) => q.eq("contactId", ids.contactId))
      .first(),
  );
  expect(row?.serviceMatchedOn).toBe("adName");
});

test("another account's referral is never touched", async () => {
  const t = convexTest(schema, modules);
  const mine = await seed(t);
  const theirs = await seed(t);
  await seedReferral(t, theirs, { headline: "Apply for your UAE Visa today" });

  await t.mutation(internal.adServiceTagging.tagFromAd, {
    accountId: mine.accountId,
    contactId: mine.contactId,
    conversationId: mine.conversationId,
    trigger: "referral",
  });

  expect(await tagsOf(t, theirs.contactId)).toHaveLength(0);
  expect(await tagsOf(t, mine.contactId)).toHaveLength(0);
});

test("no referral row at all is a quiet no-op", async () => {
  const t = convexTest(schema, modules);
  const ids = await seed(t);

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });

  expect(await tagsOf(t, ids.contactId)).toHaveLength(0);
});
```

Before running: open `convex/schema.ts` and confirm the required fields on `conversations`, `messages` and `contacts`. `convex-test` validates inserts against the schema, so add any required field these helpers omit (e.g. `messages.timestamp`/`status` names may differ — copy them from an existing test such as `convex/adReferrals.test.ts`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/adServiceTagging.test.ts`
Expected: FAIL — `internal.adServiceTagging` is undefined.

- [ ] **Step 3: Write the implementation**

Create `convex/adServiceTagging.ts`:

```ts
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  matchService,
  type MatchSignals,
  type ServiceCandidate,
} from "./lib/ads/serviceMatch";
import { landingUrlKey } from "./lib/ai/adContext";
import { tagContactForService } from "./qualificationEngine";

// ============================================================
// Ad→service tagging (spec: docs/superpowers/specs/
// 2026-07-30-ad-referral-service-tagging-design.md).
//
// A click-to-WhatsApp lead already tells us which service it wants, but
// `tagContactForService` was only ever called from
// `qualificationEngine`'s completion path — so the contact stayed
// untagged until an AI qualification session finished. This module
// closes that gap using only signals ingest ALREADY captured.
//
// Budget is hard: at most two rule passes per conversation (on the
// click, then on the next customer message), then at most one AI call.
// The whole state machine lives in four optional fields on the
// conversation's `adReferrals` row — no new table, and no way to loop.
// ============================================================

/** How many rule passes a single conversation ever gets. */
const MAX_ATTEMPTS = 2;

/**
 * The conversation's own ad referral — most recent first. `adReferrals`
 * is indexed `by_contact`, not by conversation, so this filters in
 * memory; a contact has a handful of referrals at most, and adding an
 * index for a set that small would cost more than it saves.
 */
async function referralFor(
  ctx: MutationCtx,
  args: {
    accountId: Id<"accounts">;
    contactId: Id<"contacts">;
    conversationId: Id<"conversations">;
  },
) {
  const rows = await ctx.db
    .query("adReferrals")
    .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
    .collect();
  return (
    rows
      .filter(
        (r) =>
          r.accountId === args.accountId &&
          r.conversationId === args.conversationId,
      )
      .sort((a, b) => b._creationTime - a._creationTime)[0] ?? null
  );
}

/**
 * Applies the ad's service tag to the contact when the referral's own
 * signals name a service unambiguously.
 *
 * `trigger: "referral"` is the pass booked by the click itself, and
 * runs on ad text alone — the landing-page fetch and the Meta ad-name
 * resolution are both still in flight at that moment.
 * `trigger: "followup"` is the pass booked by the customer's next
 * message, and is materially better armed: both of those caches have
 * usually landed by then, and the customer's own words are available
 * too.
 *
 * Idempotent and self-limiting: a `matched` or `suggested` referral
 * returns immediately, and the attempt counter caps the rest. Callers
 * may therefore schedule this as often as they like.
 */
export const tagFromAd = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    trigger: v.union(v.literal("referral"), v.literal("followup")),
  },
  handler: async (ctx, args): Promise<void> => {
    const referral = await referralFor(ctx, args);
    if (!referral) return;
    if (
      referral.serviceMatchStatus === "matched" ||
      referral.serviceMatchStatus === "suggested"
    ) {
      return;
    }
    const attempts = referral.serviceMatchAttempts ?? 0;
    if (attempts >= MAX_ATTEMPTS) return;

    const signals: MatchSignals = {
      headline: referral.headline,
      body: referral.body,
      sourceUrl: referral.sourceUrl,
    };

    // The advertiser's own naming — strongest signal there is, but only
    // once Meta resolution has actually landed.
    if (referral.adId) {
      const adId = referral.adId;
      const ad = await ctx.db
        .query("campaignAds")
        .withIndex("by_account_ad", (q) =>
          q.eq("accountId", args.accountId).eq("adId", adId),
        )
        .first();
      if (ad && ad.resolveStatus === "resolved") {
        signals.adName = ad.adName;
        signals.adSetName = ad.adSetName;
        signals.campaignName = ad.campaignName;
      }
    }

    // Whatever the landing-page cache has, `status` regardless — an
    // `error` row keeps its last good extraction on purpose.
    if (referral.sourceUrl) {
      const urlKey = landingUrlKey(referral.sourceUrl);
      if (urlKey) {
        const page = await ctx.db
          .query("adLandingPages")
          .withIndex("by_account_url", (q) =>
            q.eq("accountId", args.accountId).eq("urlKey", urlKey),
          )
          .first();
        if (page) {
          signals.landingTitle = page.title;
          signals.landingDescription = page.description;
        }
      }
    }

    if (args.trigger === "followup") {
      const inbound = await ctx.db
        .query("messages")
        .withIndex("by_conversation_sender", (q) =>
          q.eq("conversationId", args.conversationId).eq("senderType", "customer"),
        )
        .order("asc")
        .take(2);
      const text = inbound
        .map((m) => m.contentText ?? "")
        .filter((s) => s.trim().length > 0)
        .join(" ");
      if (text) signals.customerText = text;
    }

    const services: ServiceCandidate[] = (
      await ctx.db
        .query("kbServices")
        .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
        .collect()
    ).map((s) => ({
      key: s.key,
      name: s.name,
      aliases: s.aliases,
      status: s.status,
    }));

    const result = matchService(signals, services);
    const nextAttempts = attempts + 1;

    if (result.status === "matched") {
      await tagContactForService(ctx, {
        accountId: args.accountId,
        contactId: args.contactId,
        serviceName: result.serviceName,
        source: "ad",
      });
      await ctx.db.patch(referral._id, {
        serviceMatchStatus: "matched",
        serviceMatchKey: result.serviceKey,
        serviceMatchedOn: result.matchedOn,
        serviceMatchAttempts: nextAttempts,
      });
      return;
    }

    await ctx.db.patch(referral._id, {
      serviceMatchStatus: result.status === "ambiguous" ? "ambiguous" : "unmatched",
      serviceMatchAttempts: nextAttempts,
    });

    // Task 4 books the AI fallback here once both rule passes are spent.
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run convex/adServiceTagging.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Lint**

Run: `npx eslint convex/adServiceTagging.ts convex/adServiceTagging.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add convex/adServiceTagging.ts convex/adServiceTagging.test.ts
git commit -m "feat(ads): tag an ad lead's contact from the referral signals"
```

---

### Task 4: `classifyAdService` — the AI fallback

Reached only after both rule passes miss. Records a pending row in the **existing** `tagSuggestions` table, which the inbox's "Suggest tags" banner already renders — no UI work.

**Files:**
- Modify: `convex/adServiceTagging.ts` (add an `internalQuery`, an `internalMutation`, an `internalAction`, and the scheduler line in `tagFromAd`)
- Test: `convex/adServiceTagging.test.ts` (append)

**Interfaces:**
- Consumes: `tagFromAd` and `referralFor` (Task 3); `internal.aiConfig.loadDecrypted`, `internal.aiTagging.recordSuggestion`, `internal.aiUsage.log`; `generateReply` from `convex/lib/ai/generate.ts`; `aiJudgeModel`, `aiJudgeReasoningEffort`, `promptCacheKey` from `convex/lib/ai/defaults.ts`; `AiError`, `type AiUsage`, `type ChatMessage` from `convex/lib/ai/types.ts`.
- Produces: `internal.adServiceTagging.classifyAdService({accountId, contactId, conversationId})` — an `internalAction` returning `void` — plus three internal helpers in the same file: `classifyContext` (`internalQuery`), `markSuggested` (`internalMutation`), and `tagIdByName` (`internalQuery`).

- [ ] **Step 1: Write the failing test**

Append to `convex/adServiceTagging.test.ts`:

```ts
test("two failed rule passes hand off to the AI fallback", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  const referralId = await seedReferral(t, ids, { headline: "Talk to our team" });
  await t.run(async (ctx) => {
    await ctx.db.insert("tags", {
      accountId: ids.accountId,
      name: "UAE Visa",
      color: "#0ea5e9",
    });
    await ctx.db.insert("aiConfig", {
      accountId: ids.accountId,
      provider: "openai",
      model: "gpt-4o-mini",
      isActive: true,
      apiKeyCiphertext: "x",
    });
  });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  await t.finishAllScheduledFunctions(() => {});

  const suggestion = await t.run(async (ctx) =>
    ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", ids.conversationId))
      .first(),
  );
  expect(suggestion?.status).toBe("pending");

  const row = await t.run(async (ctx) => ctx.db.get(referralId));
  expect(row?.serviceMatchStatus).toBe("suggested");
  delete process.env.CONVEX_AI_DRY_RUN;
});

test("the AI fallback stays quiet when AI is not configured", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Talk to our team" });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  await t.finishAllScheduledFunctions(() => {});

  const suggestion = await t.run(async (ctx) =>
    ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", ids.conversationId))
      .first(),
  );
  expect(suggestion).toBeNull();
  delete process.env.CONVEX_AI_DRY_RUN;
});

test("a suggested referral is never re-classified", async () => {
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const ids = await seed(t);
  await seedReferral(t, ids, { headline: "Talk to our team" });
  await t.run(async (ctx) => {
    await ctx.db.insert("tags", {
      accountId: ids.accountId,
      name: "UAE Visa",
      color: "#0ea5e9",
    });
    await ctx.db.insert("aiConfig", {
      accountId: ids.accountId,
      provider: "openai",
      model: "gpt-4o-mini",
      isActive: true,
      apiKeyCiphertext: "x",
    });
  });

  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "referral" });
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  await t.finishAllScheduledFunctions(() => {});
  await t.mutation(internal.adServiceTagging.tagFromAd, { ...ids, trigger: "followup" });
  await t.finishAllScheduledFunctions(() => {});

  const suggestions = await t.run(async (ctx) =>
    ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", ids.conversationId))
      .collect(),
  );
  expect(suggestions).toHaveLength(1);
  delete process.env.CONVEX_AI_DRY_RUN;
});
```

Before running: check `convex/aiConfig.ts` and `convex/schema.ts` for the real `aiConfig` field names and the exact shape `loadDecrypted` expects (the ciphertext field name and any required IV/salt fields). Copy the seeding from an existing test that already stands up an `aiConfig` row — `convex/aiTagging.test.ts` is the closest precedent. Do not invent field names.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/adServiceTagging.test.ts -t "fallback"`
Expected: FAIL — `internal.adServiceTagging.classifyAdService` is undefined.

- [ ] **Step 3: Add the context query and outcome mutation**

Append to `convex/adServiceTagging.ts` (and widen the import at the top to `import { internalAction, internalMutation, internalQuery } from "./_generated/server";`, adding `import { internal } from "./_generated/api";`, `import { generateReply } from "./lib/ai/generate";`, `import { aiJudgeModel, aiJudgeReasoningEffort, promptCacheKey } from "./lib/ai/defaults";` and `import { AiError, type AiUsage, type ChatMessage } from "./lib/ai/types";`):

```ts
// ------------------------------------------------------------
// AI fallback — reached only after BOTH rule passes missed.
// ------------------------------------------------------------

/**
 * Everything `classifyAdService` needs in one read: the ad's own text,
 * the customer's opening messages, and the account's active service
 * names. Returns `null` when there is nothing to classify — no referral,
 * or an empty service catalogue.
 */
export const classifyContext = internalQuery({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const referral = await referralFor(ctx, args);
    if (!referral) return null;

    const services = (
      await ctx.db
        .query("kbServices")
        .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
        .collect()
    )
      .filter((s) => s.status === "active")
      .map((s) => ({ name: s.name, aliases: s.aliases }));
    if (services.length === 0) return null;

    const inbound = await ctx.db
      .query("messages")
      .withIndex("by_conversation_sender", (q) =>
        q.eq("conversationId", args.conversationId).eq("senderType", "customer"),
      )
      .order("asc")
      .take(2);

    return {
      services,
      ad: {
        headline: referral.headline ?? "",
        body: referral.body ?? "",
        sourceUrl: referral.sourceUrl ?? "",
      },
      customerText: inbound
        .map((m) => m.contentText ?? "")
        .filter((s) => s.trim().length > 0)
        .join("\n"),
    };
  },
});

/**
 * Marks the referral `suggested` — the terminal state for this
 * conversation's ad-tagging. Called whether or not a suggestion was
 * actually recorded: the AI pass is spent either way, and leaving the
 * row `unmatched` would let a later `tagFromAd` book a second call.
 */
export const markSuggested = internalMutation({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args): Promise<void> => {
    const referral = await referralFor(ctx, args);
    if (!referral) return;
    await ctx.db.patch(referral._id, { serviceMatchStatus: "suggested" });
  },
});

/** The account's tag whose name equals `serviceName`, case-insensitively. */
export const tagIdByName = internalQuery({
  args: { accountId: v.id("accounts"), serviceName: v.string() },
  handler: async (ctx, args): Promise<Id<"tags"> | null> => {
    const wanted = args.serviceName.trim().toLowerCase();
    const tags = await ctx.db
      .query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    return tags.find((t) => t.name.trim().toLowerCase() === wanted)?._id ?? null;
  },
});

/**
 * Renders the closed option set. The model may only answer with one of
 * these names or the literal `NONE` — same "fixed options" discipline
 * as `lib/ai/classify.ts`'s `buildClassifyPrompt`, narrowed to services.
 */
function buildAdServicePrompt(
  services: { name: string; aliases: string[] }[],
): string {
  const options = services
    .map((s) =>
      s.aliases.length > 0
        ? `- ${s.name} (also called: ${s.aliases.join(", ")})`
        : `- ${s.name}`,
    )
    .join("\n");
  return [
    "You identify which service a customer is interested in, based on the",
    "Facebook/Instagram ad they clicked and their first messages.",
    "",
    "Choose EXACTLY ONE of these services, or answer NONE:",
    options,
    "",
    "Customers may write in any language, including Malayalam written in",
    "Latin script (Manglish). Answer with the service name exactly as",
    "written above, or the single word NONE. No explanation, no other text.",
  ].join("\n");
}

/**
 * The last resort: one judge-tier call, recorded as a PENDING
 * suggestion for an agent to accept — never auto-applied. A rule match
 * is evidence; this is a guess, and a guess gets a human gate.
 *
 * Every failure path is swallowed. The referral row is marked
 * `suggested` first thing, so even a crash mid-call cannot leave the
 * conversation eligible for a second (paid) attempt.
 */
export const classifyAdService = internalAction({
  args: {
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args): Promise<void> => {
    try {
      await ctx.runMutation(internal.adServiceTagging.markSuggested, args);

      const context = await ctx.runQuery(
        internal.adServiceTagging.classifyContext,
        args,
      );
      if (!context) return;

      let config;
      try {
        config = await ctx.runQuery(internal.aiConfig.loadDecrypted, {
          accountId: args.accountId,
        });
      } catch {
        return; // undecryptable key — nothing to do, and nothing to say
      }
      if (!config || !config.isActive || !config.apiKey) return;

      const systemPrompt = buildAdServicePrompt(context.services);
      const messages: ChatMessage[] = [
        {
          role: "user",
          content: [
            `Ad headline: ${context.ad.headline || "(none)"}`,
            `Ad body: ${context.ad.body || "(none)"}`,
            `Ad link: ${context.ad.sourceUrl || "(none)"}`,
            `Customer's first messages: ${context.customerText || "(none)"}`,
          ].join("\n"),
        },
      ];
      const judgeModelId = aiJudgeModel(config.provider, config.model);

      let raw: string;
      let usage: AiUsage | null = null;
      if (process.env.CONVEX_AI_DRY_RUN) {
        // Deterministic stand-in, mirroring `aiTagging.ts`'s
        // `syntheticClassifyRaw`: always the first option, so a dry-run
        // test exercises the full record path without a network call.
        raw = context.services[0]?.name ?? "NONE";
      } else {
        try {
          const gen = await generateReply({
            provider: config.provider,
            model: judgeModelId,
            apiKey: config.apiKey,
            systemPrompt,
            messages,
            reasoningEffort: aiJudgeReasoningEffort(),
            promptCacheKey: promptCacheKey(args.accountId, "classify"),
          });
          raw = gen.text;
          usage = gen.usage;
        } catch (err) {
          if (err instanceof AiError) return;
          throw err;
        }
      }

      const answer = raw.trim();
      if (answer && answer.toUpperCase() !== "NONE") {
        const tagId = await ctx.runQuery(internal.adServiceTagging.tagIdByName, {
          accountId: args.accountId,
          serviceName: answer,
        });
        if (tagId) {
          await ctx.runMutation(internal.aiTagging.recordSuggestion, {
            accountId: args.accountId,
            conversationId: args.conversationId,
            contactId: args.contactId,
            suggestedTagIds: [tagId],
            confidence: "low",
            model: judgeModelId,
          });
        }
      }

      if (usage) {
        try {
          await ctx.runMutation(internal.aiUsage.log, {
            accountId: args.accountId,
            conversationId: args.conversationId,
            mode: "classify",
            provider: config.provider,
            model: judgeModelId,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            cachedPromptTokens: usage.cachedPromptTokens,
            reasoningTokens: usage.reasoningTokens,
          });
        } catch (err) {
          console.warn("[ad service tagging] usage log failed:", err);
        }
      }
    } catch (err) {
      console.error("[ad service tagging] classify failed:", err);
    }
  },
});
```

Note `referralFor` takes a `MutationCtx` in Task 3. Widen its `ctx` parameter to `{ db: QueryCtx["db"] }` so `classifyContext` and `markSuggested` can both call it — add `import type { QueryCtx } from "./_generated/server";` and change the signature to `ctx: { db: QueryCtx["db"] }`. A `MutationCtx["db"]` structurally satisfies that, so `tagFromAd` keeps compiling. This is the same reader-typed-ctx pattern `lib/qualification/routing.ts` uses.

- [ ] **Step 4: Book the fallback from `tagFromAd`**

In `convex/adServiceTagging.ts`, replace the trailing comment in `tagFromAd` with:

```ts
    // Both rule passes spent and still nothing. One AI guess, into the
    // existing suggestion banner for a human to accept.
    if (nextAttempts >= MAX_ATTEMPTS) {
      await ctx.scheduler.runAfter(
        0,
        internal.adServiceTagging.classifyAdService,
        {
          accountId: args.accountId,
          contactId: args.contactId,
          conversationId: args.conversationId,
        },
      );
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run convex/adServiceTagging.test.ts`
Expected: PASS — 12 tests (Task 3's 9 plus these 3).

- [ ] **Step 6: Lint**

Run: `npx eslint convex/adServiceTagging.ts convex/adServiceTagging.test.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add convex/adServiceTagging.ts convex/adServiceTagging.test.ts
git commit -m "feat(ads): fall back to one AI service guess when rules miss"
```

---

### Task 5: Wire both passes into ingest

**Files:**
- Modify: `convex/ingest.ts` — the referral block at ~line 1015-1030, inside `processInbound`
- Test: `convex/ingest.test.ts` (append)

**Interfaces:**
- Consumes: `internal.adServiceTagging.tagFromAd` (Tasks 3-4); `runBestEffort(label, fn)` already defined at `convex/ingest.ts:552`.
- Produces: nothing importable — this is the wiring.

- [ ] **Step 1: Write the failing test**

Append to `convex/ingest.test.ts`, alongside the existing "processInbound
captures an adReferrals row from an inbound ad referral" test (~line 1448) —
these follow its exact shape and reuse that file's `seedAccount(t, name)`,
`seedAiConfig` and `seedWebhookEndpoint` helpers.

Two things to copy exactly rather than invent: `inboundMessageValidator`
(`convex/ingest.ts:84`) has **no** `timestamp` field, and both dry-run env
flags are set at the top of every `processInbound` test in this file.

```ts
async function seedUaeVisaService(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("kbServices", {
      accountId,
      key: "uae-visa",
      name: "UAE Visa",
      aliases: ["dubai visa"],
      status: "active",
      sortOrder: 0,
      updatedAt: Date.now(),
    });
  });
}

async function contactTagNames(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run(async (ctx) => {
    const contact = await ctx.db
      .query("contacts")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first();
    if (!contact) return [];
    const links = await ctx.db
      .query("contactTags")
      .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
      .collect();
    return await Promise.all(
      links.map(async (l) => (await ctx.db.get(l.tagId))?.name),
    );
  });
}

async function referralRow(
  t: ReturnType<typeof convexTest>,
  accountId: Id<"accounts">,
) {
  return await t.run((ctx) =>
    ctx.db
      .query("adReferrals")
      .withIndex("by_account", (q) => q.eq("accountId", accountId))
      .first(),
  );
}

test("processInbound tags the contact from the ad it came in on", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedUaeVisaService(t, accountId);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "hi",
      wamid: "wamid.ADTAG1",
      referral: {
        sourceType: "ad",
        sourceId: "AD1",
        headline: "Apply for your UAE Visa today",
      },
    },
  });
  await t.finishInProgressScheduledFunctions();

  expect(await contactTagNames(t, accountId)).toEqual(["UAE Visa"]);
  const row = await referralRow(t, accountId);
  expect(row?.serviceMatchStatus).toBe("matched");
  expect(row?.serviceMatchedOn).toBe("headline");
});

test("processInbound retries the ad match on the customer's next message", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedUaeVisaService(t, accountId);

  // The click itself: a vague ad names no service, so nothing is tagged.
  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "hi",
      wamid: "wamid.ADTAG2A",
      referral: { sourceType: "ad", sourceId: "AD2", headline: "Talk to our team" },
    },
  });
  await t.finishInProgressScheduledFunctions();

  expect(await contactTagNames(t, accountId)).toEqual([]);
  expect((await referralRow(t, accountId))?.serviceMatchStatus).toBe("unmatched");

  // The follow-up carries the customer's own words — no referral of its own.
  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: {
      type: "text",
      text: "i need a dubai visa please",
      wamid: "wamid.ADTAG2B",
    },
  });
  await t.finishInProgressScheduledFunctions();

  expect(await contactTagNames(t, accountId)).toEqual(["UAE Visa"]);
  const row = await referralRow(t, accountId);
  expect(row?.serviceMatchStatus).toBe("matched");
  expect(row?.serviceMatchedOn).toBe("customerText");
});

test("processInbound never ad-tags a conversation that came in organically", async () => {
  process.env.CONVEX_META_DRY_RUN = "1";
  process.env.CONVEX_AI_DRY_RUN = "1";
  const t = convexTest(schema, modules);
  const accountId = await seedAccount(t, "Acme");
  await seedAiConfig(t, accountId);
  await seedUaeVisaService(t, accountId);

  await t.action(internal.ingest.processInbound, {
    accountId,
    from: "15551234567",
    message: { type: "text", text: "i need a dubai visa please", wamid: "wamid.ORG1" },
  });
  await t.finishInProgressScheduledFunctions();

  expect(await contactTagNames(t, accountId)).toEqual([]);
});
```

`finishInProgressScheduledFunctions()` rather than
`finishAllScheduledFunctions(vi.runAllTimers)`: `processInbound` also books the
agent-reply SLA check ten minutes out, and running all timers would fire that
too, dragging unrelated notification machinery into these assertions. The
in-progress variant drains only the zero-delay work this test cares about — the
same choice `convex/ingest.test.ts:2253` and `convex/kbCompile.test.ts:119`
already make.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run convex/ingest.test.ts -t "ad"`
Expected: FAIL — no `contactTags` row is created.

- [ ] **Step 3: Schedule the first pass**

In `convex/ingest.ts`, inside the existing `if (message.referral || message.ctwaClid) { … }` block, immediately after the `runBestEffort("adReferrals.recordAdReferral", …)` call:

```ts
      // ---- Ad→service tagging, first (rule) pass. Scheduled rather
      // than inline: the landing-page fetch and the Meta ad-name
      // resolution this benefits from are both still in flight right
      // now, and neither is worth waiting for — the retry pass below
      // picks them up. Best-effort like everything else in this
      // fan-out. See convex/adServiceTagging.ts.
      await runBestEffort("adServiceTagging.tagFromAd(referral)", () =>
        ctx.scheduler.runAfter(0, internal.adServiceTagging.tagFromAd, {
          accountId,
          contactId: res.contactId,
          conversationId: res.conversationId,
          trigger: "referral" as const,
        }),
      );
```

- [ ] **Step 4: Schedule the retry pass**

Directly after that `if (message.referral || message.ctwaClid) { … }` block, add:

```ts
    // ---- Ad→service tagging, retry (rule) pass. Fires on a FOLLOW-UP
    // message in a conversation that started from an ad — the click
    // itself is handled above. Gated on the `conversation.adReferral`
    // display denorm, which is already on the doc `ingestInbound`
    // returned, so a non-ad inbound costs no extra read at all.
    // `tagFromAd`'s own status/attempt guards make a redundant
    // schedule a no-op, so this needs no cleverness about whether the
    // earlier pass already succeeded.
    if (!message.referral && res.conversationAdReferral) {
      await runBestEffort("adServiceTagging.tagFromAd(followup)", () =>
        ctx.scheduler.runAfter(0, internal.adServiceTagging.tagFromAd, {
          accountId,
          contactId: res.contactId,
          conversationId: res.conversationId,
          trigger: "followup" as const,
        }),
      );
    }
```

`res` is `ingestInbound`'s return value. Check what it actually returns — if it does not already expose whether the conversation carries an `adReferral` denorm, add a boolean to it (`conversationAdReferral: conversation.adReferral !== undefined`) inside `ingestInbound` rather than doing a fresh `ctx.runQuery` here; the conversation doc is already loaded there. Adjust the field name above to whatever you add.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run convex/ingest.test.ts`
Expected: PASS — the three new tests plus every pre-existing test in the file.

- [ ] **Step 6: Run the full backend suite**

Run: `npx vitest run convex/`
Expected: PASS. `ingest.ts` is the hub of the webhook pipeline — a regression here surfaces in many files, so this whole-directory run is worth the minute.

- [ ] **Step 7: Lint**

Run: `npx eslint convex/ingest.ts convex/ingest.test.ts`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add convex/ingest.ts convex/ingest.test.ts
git commit -m "feat(inbox): run ad service tagging on the click and the next message"
```

---

### Task 6: The "from ad" marker in the UI

`contactTags.source` is dropped by both tag-embedding helpers today, so it reaches no component. This carries it through and renders it.

**Files:**
- Modify: `convex/contacts.ts:28-37` (`embedTags`)
- Modify: `convex/conversations.ts:29-44` (the equivalent tag-embedding helper)
- Modify: `src/types/index.ts:147-154` (`Tag`)
- Modify: `src/lib/convex/adapters.ts:78-87` (`toUiTag`)
- Modify: `src/components/inbox/label-picker.tsx`
- Modify: `src/components/inbox/lead-popover.tsx:195-215`
- Modify: `messages/en.json` (`Inbox.labels`, ~line 438)

**Interfaces:**
- Consumes: `contactTags.source` accepting `"ad"` (Task 2).
- Produces: `Tag.source?: 'ai' | 'manual' | 'ad'`; `toUiTag(doc: Doc<"tags">, source?: 'ai' | 'manual' | 'ad'): Tag`.

- [ ] **Step 1: Carry `source` through both embedders**

In `convex/contacts.ts`, rewrite `embedTags`'s body so the link's `source` rides along with each tag:

```ts
async function embedTags(ctx: QueryCtx, contact: Doc<"contacts">) {
  const links = await ctx.db
    .query("contactTags")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .collect();
  const tags = (
    await Promise.all(
      links.map(async (link) => {
        const tag = await ctx.db.get(link.tagId);
        // Provenance rides along with the tag so the UI can mark an
        // ad-derived label without a second round trip.
        return tag ? { ...tag, source: link.source } : null;
      }),
    )
  ).filter((tag): tag is Doc<"tags"> & { source?: "ai" | "manual" | "ad" } => tag !== null);
  return { ...contact, tags };
}
```

Apply the identical change to the tag-embedding helper in `convex/conversations.ts` (~line 29-44) — read it first; it is a near-copy of this one and must stay in step.

- [ ] **Step 2: Widen the UI `Tag` type and adapter**

In `src/types/index.ts`, add to `Tag`:

```ts
  /** Where this label came from. Unset = manual. */
  source?: 'ai' | 'manual' | 'ad';
```

In `src/lib/convex/adapters.ts`, give `toUiTag` an optional second parameter so the existing `api.tags.list` call sites — which have no link row and therefore no source — keep working untouched:

```ts
export function toUiTag(
  doc: Doc<"tags">,
  source?: 'ai' | 'manual' | 'ad',
): Tag {
  return {
    id: doc._id,
    user_id: "",
    name: doc.name,
    color: doc.color,
    group_id: doc.groupId,
    source,
    created_at: new Date(doc._creationTime).toISOString(),
  };
}
```

Then update the two embedded-tag call sites in the same file, which currently
drop the source on the floor. Both declare their `tags` as `Doc<"tags">[]` —
widen that to carry the provenance, and pass it:

```ts
type EmbeddedTag = Doc<"tags"> & { source?: 'ai' | 'manual' | 'ad' };
```

- `toUiContact` (~line 114): change the parameter type to
  `Doc<"contacts"> & { tags?: EmbeddedTag[] }` and the mapping (~line 140) to
  `tags: doc.tags ? doc.tags.map((tag) => toUiTag(tag, tag.source)) : undefined,`
- The conversation-side adapter (~line 304): change its
  `contact: (Doc<"contacts"> & { tags?: Doc<"tags">[] }) | null` to use
  `EmbeddedTag[]` too, and apply the same mapping change wherever it calls
  `toUiTag`.

Leave every *other* `toUiTag` call alone — the `api.tags.list` call sites in
`label-picker.tsx` pass a bare tag doc with no link, so the second argument is
correctly `undefined` there.

- [ ] **Step 3: Add the i18n string**

In `messages/en.json`, inside `Inbox.labels` (~line 438), add:

```json
      "fromAd": "From ad",
```

- [ ] **Step 4: Render the marker in the label picker**

In `src/components/inbox/label-picker.tsx`, add `Megaphone` to the existing lucide import (`import { Check, Megaphone, Plus } from 'lucide-react';`) and render it inside the chip button, before `{tag.name}`:

```tsx
          {tag.source === 'ad' && (
            <Megaphone
              className="mr-1 h-2.5 w-2.5 shrink-0"
              aria-label={t('fromAd')}
            />
          )}
```

The chip's `<button>` needs `inline-flex items-center` on its className for the icon to sit on the text baseline — add those two classes if they are not already there.

- [ ] **Step 5: Render the marker in the lead popover**

In `src/components/inbox/lead-popover.tsx` (~line 201), inside the tag `<span>`, before `{tag.name}`:

```tsx
                  {tag.source === 'ad' && (
                    <Megaphone
                      className="mr-1 h-2.5 w-2.5 shrink-0"
                      aria-label={t('fromAd')}
                    />
                  )}
```

Add `Megaphone` to that file's lucide import. The `<span>` already carries `inline-flex shrink-0 items-center`, so no class changes are needed. Check which translation namespace this component's `t` is bound to — if it is not `Inbox.labels`, add `fromAd` to the namespace it does use instead, and keep the key name.

An icon rather than appended text is deliberate: these chips are dense, and the thread header's identity zone has a documented overflow history (commit `460d831`).

- [ ] **Step 6: Verify the marker renders, by test**

A browser check cannot prove anything here: the Convex backend is deliberately
not deployed by this plan (see Global Constraints), so no contact in any
running environment carries a `source: "ad"` link to render. Assert it directly
instead.

This repo has **no** `@testing-library/react` (confirmed against
`package.json`) and no React component tests. **Do not add that dependency**
for this — adding a test framework is a bigger decision than this marker
warrants, and it is not in scope.

Cover the seam that was actually broken instead: the adapter mapping, which
silently dropped `source` before this task. Append to the existing
`src/lib/convex/adapters.test.ts` (which already imports `Doc`/`Id` types and
uses `describe`/`it`/`expect` from vitest — follow its established style, and
add `toUiTag` to its existing import list from `./adapters`):

```ts
describe("toUiTag provenance", () => {
  const tagDoc = {
    _id: "tag1" as Id<"tags">,
    _creationTime: 0,
    accountId: "acc1" as Id<"accounts">,
    name: "UAE Visa",
    color: "#0ea5e9",
  } as Doc<"tags">;

  it("carries an explicit source through to the UI type", () => {
    expect(toUiTag(tagDoc, "ad").source).toBe("ad");
  });

  it("leaves source undefined when the caller has no link row", () => {
    // The `api.tags.list` call sites pass a bare tag doc — there is no
    // contactTags link to read a provenance from.
    expect(toUiTag(tagDoc).source).toBeUndefined();
  });
});
```

Run: `npx vitest run src/lib/convex/adapters.test.ts`
Expected: PASS — the two new tests plus every pre-existing test in the file.

The JSX conditional itself (`tag.source === 'ad' && <Megaphone …/>`) stays
covered by review and by `npx tsc --noEmit` in the next step, not by a test —
adding a whole rendering stack to assert one conditional is not a trade worth
making.

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npx eslint convex/contacts.ts convex/conversations.ts src/types/index.ts src/lib/convex/adapters.ts src/components/inbox/label-picker.tsx src/components/inbox/lead-popover.tsx`
Expected: no errors.

- [ ] **Step 8: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add convex/contacts.ts convex/conversations.ts src/types/index.ts src/lib/convex/adapters.ts src/components/inbox/label-picker.tsx src/components/inbox/lead-popover.tsx messages/en.json
git commit -m "feat(inbox): mark ad-derived labels with a from-ad icon"
```

---

## After the plan

The matcher's free path only covers wording that appears in `kbServices.aliases`. Once this is live, query `adReferrals` for `serviceMatchStatus` to review accuracy: `"unmatched"` rows name ads whose wording no alias covers, `"ambiguous"` rows name aliases that overlap between services, and `serviceMatchedOn` shows which signal is actually carrying the matches. Every alias added from that review is an AI call not spent.

Routing is deliberately untouched — the Chasing auto-assign sweep still routes off `session.serviceName` (`convex/inboxChaseAssign.ts:178`). Feeding ad-derived services into routing is a separate change, worth making only once the accuracy review above says the matcher earns that trust.
