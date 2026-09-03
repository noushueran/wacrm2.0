# Meta Custom Audience Daily Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily cron that reconciles the wa-amani CRM against Meta Custom Audience `52503553736038` — adding contacts that belong, removing the ones that no longer do.

**Architecture:** Meta's customer-list audience is **write-only**: there is no endpoint that returns who is currently in it. A reconciler therefore cannot diff against Meta — it must remember what it sent. So we keep a local mirror table (`metaAudienceMembers`), one row per contact, recording the hash we sent and whether that contact is currently a member. Each nightly pass computes the *desired* membership set from `contacts` + `conversations`, diffs it against the mirror, and issues only the deltas as `ADD` / `REMOVE` calls. The mirror is the source of truth for "what Meta believes"; the CRM is the source of truth for "what should be true".

**Tech Stack:** Convex (self-hosted) · TypeScript · Web Crypto SHA-256 · Meta Graph API v-pinned · vitest + convex-test

## ⚠️ This plan is a historical record, not the source of truth

Implementation and review found six defects **in this plan**. The shipped code is correct; the text below is not, in these places. For current behaviour read [docs/meta-audience-sync.md](../../meta-audience-sync.md) and the code itself.

| Where | The plan said | Reality |
|---|---|---|
| Task 2 `diffMembership` | (no dedup) | Duplicate `contactId`s stranded a stale digest in Meta. Guard added. |
| Task 4 `SCAN_CAP` | `2000`, "not expected to bind" | Binds immediately at 2,778 live contacts — would have silently dropped 778 people (28%) every night. Raised to `20000`. |
| Task 4 conversations | `.take(50)` | A converted customer past the window stayed in the audience. Now `CONVERSATIONS_PER_CONTACT_CAP = 200`. |
| Task 4 test seeds | `funnel: { stage }` | Schema also requires `stageUpdatedAt`. |
| Task 5 `GRAPH_VERSION` | `v21.0` | The repo uses `v25.0` (`convex/conversionEvents.ts`). |
| Task 7 mirror write | gate on `!res.ok` | A 2xx with an unparsable body reports `received: 0` and would record a batch that never landed. Now requires `received === batch.length`. |
| Task 7 `contactNotes` | `body` | The field is `noteText`. |

The gravest was found only in review, not in the plan: for a **phone change**, the diff emits an ADD and a REMOVE for the *same* contact, but the mirror holds one row per contact — so an ADD that committed before a failing REMOVE destroyed the only record that the old digest was still live in Meta, stranding it permanently. Mirror writes are now staged and applied only after both loops, skipping any contact touched by a failed batch.

## Global Constraints

- **Audience ID:** `52503553736038` — read from `META_CUSTOM_AUDIENCE_ID`, never hardcoded in logic.
- **Ad account:** `41958557` (Amani Travel & Tourism, AED). Not needed at runtime; recorded for operators.
- **Match key:** `PHONE` only, pre-hashed. Never send raw phone numbers to the Graph API.
- **Hashing:** reuse `sha256Hex` and `normalizePhoneForMeta` from `convex/conversionEvents.ts`. Do not write a second hasher.
- **Graph version:** reuse the existing `GRAPH_VERSION` constant, do not introduce a second one.
- **Batch size:** 300 rows per Graph call (proven in the 2026-09-02 manual backfill; 700 was unwieldy).
- **Per-run cap:** 2,000 contacts examined per pass. The CRM holds 2,778 contacts today; the cap bounds a runaway, it is not expected to bind.
- **Feature is OFF by default.** With `META_CUSTOM_AUDIENCE_ID` unset the cron must no-op silently — same posture as the conversion-event lanes.
- **Never run `npx convex deploy`, `dev`, or `codegen`.** New files under `convex/` will fail the codegen drift guard until the owner runs codegen themselves; note it in the PR rather than running it.
- **`npm run typecheck` is EXPECTED to fail from Task 4 onward, and that is not a defect.** `convex/_generated/api.js` is `anyApi` (a runtime proxy), so vitest resolves `internal.metaAudienceSync.*` fine and **tests pass**. But `convex/_generated/api.d.ts` enumerates every module by hand, so TypeScript cannot see a module that codegen has not yet indexed. Verify your work with `npx vitest run`, not `tsc`. Do not "fix" this by editing anything under `convex/_generated/` — that file is generated, and hand-editing it is a defect.
- **Lint scope:** changed files only. Do not run prettier across the repo.

---

## Membership Rules (the decision this plan encodes)

A contact **should be in** the audience when all of these hold:

1. `normalizePhoneForMeta(contact.phoneNormalized)` returns non-null.
2. `contact.doNotContact` is unset.
3. No conversation for that contact sits at funnel stage `purchased`.

Notes on the two judgement calls, so a reviewer can disagree deliberately:

- **`purchased` is excluded** because continuing to pay to retarget someone who already bought is the waste this feature exists to stop. If Amani later wants repeat-travel campaigns, that is a *second* audience with its own rules, not a loosening of this one.
- **`lost` is deliberately KEPT IN.** A lost travel lead did not buy — that is precisely who retargeting is for. `lost` is a terminal exit in `FUNNEL_STAGES`, not a signal to stop advertising. Flipping this is a one-line change in `shouldBeMember`.

---

## File Structure

| File | Responsibility |
|---|---|
| `convex/lib/metaAudience.ts` | **New.** Pure membership + diff logic. No `ctx`, no clock, no network. Carries the unit tests. |
| `convex/lib/metaAudience.test.ts` | **New.** Unit tests for the above. |
| `convex/metaAudienceSync.ts` | **New.** The Convex functions: the collect query, the mirror mutations, the Graph client, the orchestrating action. |
| `convex/metaAudienceSync.test.ts` | **New.** convex-test integration tests over the orchestrator. |
| `convex/schema.ts` | **Modify.** Add the `metaAudienceMembers` table + indexes. |
| `convex/crons.ts` | **Modify.** Register the daily cron. |
| `convex/cronSchedules.ts` | **Modify.** Add the `runMetaAudienceSync` wrapper so runs land in cron history. |
| `convex/lib/cronSummary.ts` | **Modify.** Add the registry entry (kept in sync with the two above; `cronSchedules.test.ts` asserts this). |

---

## Task 0: Confirm the server token can write the audience

**This task is a gate. If it fails, stop and report — the rest of the plan is unbuildable as written.**

Everything in the 2026-09-02 manual backfill went through the Meta Ads MCP, which acts as the **user's own logged-in Meta identity**. The cron will act as a **server token** (`META_ADS_ACCESS_TOKEN`), which today is only exercised for *reads* in `convex/campaignAds.ts`. Writing to a custom audience needs the `ads_management` permission on an account that has accepted Meta's Custom Audience Terms. Those are different identities and may not have the same rights.

**Files:**
- No production files. Findings go in the PR description.

- [ ] **Step 1: Read the token's own permissions**

Ask the repo owner to run this (it needs the deployment's env, which agents must not read):

```bash
npx convex env get META_ADS_ACCESS_TOKEN > /dev/null && echo "token is set"
```

- [ ] **Step 2: Probe the audience endpoint read-only**

Ask the owner to run, substituting the token:

```bash
curl -s "https://graph.facebook.com/v21.0/52503553736038?fields=name,operation_status&access_token=$META_ADS_ACCESS_TOKEN"
```

Expected on success: JSON containing `"name": "WhatsApp CRM — All Contacts"`.
Expected on failure: an `OAuthException` naming a missing permission.

- [ ] **Step 3: Record the outcome and decide**

- **Success** → proceed to Task 1.
- **Permission error** → STOP. The options are (a) mint a system-user token with `ads_management` on ad account `41958557`, or (b) build the sync to produce an export file a human uploads. Report both to the owner and let them choose; do not pick one unilaterally.

---

## Task 1: Pure membership rules

**Files:**
- Create: `convex/lib/metaAudience.ts`
- Test: `convex/lib/metaAudience.test.ts`

**Interfaces:**
- Consumes: `FunnelStageKey` from `convex/lib/funnel.ts`.
- Produces:
  - `type MemberCandidate = { contactId: string; phoneNormalized: string; doNotContact: boolean; stages: FunnelStageKey[] }`
  - `shouldBeMember(c: MemberCandidate): boolean`
  - `const EXCLUDED_STAGES: readonly FunnelStageKey[]`

- [ ] **Step 1: Write the failing test**

Create `convex/lib/metaAudience.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { shouldBeMember, EXCLUDED_STAGES, type MemberCandidate } from "./metaAudience";

function candidate(over: Partial<MemberCandidate> = {}): MemberCandidate {
  return {
    contactId: "c1",
    phoneNormalized: "971501234567",
    doNotContact: false,
    stages: [],
    ...over,
  };
}

describe("shouldBeMember", () => {
  it("includes an ordinary contact with a usable phone", () => {
    expect(shouldBeMember(candidate())).toBe(true);
  });

  it("excludes a contact marked do-not-contact", () => {
    expect(shouldBeMember(candidate({ doNotContact: true }))).toBe(false);
  });

  it("excludes a contact with a purchased conversation", () => {
    expect(shouldBeMember(candidate({ stages: ["purchased"] }))).toBe(false);
  });

  it("excludes when ANY conversation is purchased, not just the first", () => {
    expect(shouldBeMember(candidate({ stages: ["new_lead", "purchased"] }))).toBe(false);
  });

  it("KEEPS a lost lead — they did not buy, so they are still worth retargeting", () => {
    expect(shouldBeMember(candidate({ stages: ["lost"] }))).toBe(true);
  });

  it("excludes a phone too short to carry a country code", () => {
    expect(shouldBeMember(candidate({ phoneNormalized: "12345" }))).toBe(false);
  });

  it("excludes an empty phone", () => {
    expect(shouldBeMember(candidate({ phoneNormalized: "" }))).toBe(false);
  });

  it("names purchased as the only excluded stage", () => {
    expect([...EXCLUDED_STAGES]).toEqual(["purchased"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/metaAudience.test.ts`
Expected: FAIL — `Failed to resolve import "./metaAudience"`.

- [ ] **Step 3: Write minimal implementation**

Create `convex/lib/metaAudience.ts`:

```typescript
/**
 * Pure membership + diff logic for the Meta customer-list audience sync.
 *
 * Nothing here touches `ctx`, the database, the clock or the network, so
 * the whole decision table is unit-testable with object literals — same
 * split as `lib/leadQuality.ts` beside `leadQuality.ts`.
 */

import type { FunnelStageKey } from "./funnel";

/**
 * Stages that take a contact OUT of the retargeting pool.
 *
 * `purchased` only. `lost` is deliberately absent: a lost lead did not
 * buy, which is exactly who retargeting is for. `lost` is a terminal exit
 * in FUNNEL_STAGES, not a signal to stop advertising to someone.
 */
export const EXCLUDED_STAGES: readonly FunnelStageKey[] = ["purchased"] as const;

/** Minimum digits for a number that could carry a country code. Mirrors
 *  `normalizePhoneForMeta` in `convex/conversionEvents.ts` — a shorter
 *  string hashes to a digest that matches nobody. */
const MIN_PHONE_DIGITS = 7;

export type MemberCandidate = {
  contactId: string;
  /** Digits-only phone as stored on `contacts.phoneNormalized`. */
  phoneNormalized: string;
  doNotContact: boolean;
  /** Funnel stage of every conversation belonging to this contact. */
  stages: FunnelStageKey[];
};

/** Whether this contact belongs in the audience right now. */
export function shouldBeMember(c: MemberCandidate): boolean {
  const digits = (c.phoneNormalized ?? "").replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS) return false;
  if (c.doNotContact) return false;
  if (c.stages.some((s) => EXCLUDED_STAGES.includes(s))) return false;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/lib/metaAudience.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/metaAudience.ts convex/lib/metaAudience.test.ts
git commit -m "feat(audience): membership rules for the Meta customer list"
```

---

## Task 2: The diff engine

**Files:**
- Modify: `convex/lib/metaAudience.ts`
- Test: `convex/lib/metaAudience.test.ts`

**Interfaces:**
- Consumes: `MemberCandidate` from Task 1.
- Produces:
  - `type MirrorRow = { contactId: string; phoneHash: string; isMember: boolean }`
  - `type Desired = { contactId: string; phoneHash: string; wanted: boolean }`
  - `type AudienceDiff = { toAdd: Desired[]; toRemove: MirrorRow[]; unchanged: number }`
  - `diffMembership(desired: Desired[], mirror: MirrorRow[]): AudienceDiff`

- [ ] **Step 1: Write the failing test**

Append to `convex/lib/metaAudience.test.ts`:

```typescript
import { diffMembership, type MirrorRow, type Desired } from "./metaAudience";

describe("diffMembership", () => {
  const H1 = "a".repeat(64);
  const H2 = "b".repeat(64);
  const H3 = "c".repeat(64);

  it("adds a wanted contact the mirror has never seen", () => {
    const d = diffMembership([{ contactId: "c1", phoneHash: H1, wanted: true }], []);
    expect(d.toAdd.map((r) => r.contactId)).toEqual(["c1"]);
    expect(d.toRemove).toEqual([]);
  });

  it("does not re-add a contact already recorded as a member", () => {
    const d = diffMembership(
      [{ contactId: "c1", phoneHash: H1, wanted: true }],
      [{ contactId: "c1", phoneHash: H1, isMember: true }],
    );
    expect(d.toAdd).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it("removes a member who is no longer wanted", () => {
    const d = diffMembership(
      [{ contactId: "c1", phoneHash: H1, wanted: false }],
      [{ contactId: "c1", phoneHash: H1, isMember: true }],
    );
    expect(d.toRemove.map((r) => r.contactId)).toEqual(["c1"]);
    expect(d.toAdd).toEqual([]);
  });

  it("does not re-remove a contact already recorded as removed", () => {
    const d = diffMembership(
      [{ contactId: "c1", phoneHash: H1, wanted: false }],
      [{ contactId: "c1", phoneHash: H1, isMember: false }],
    );
    expect(d.toRemove).toEqual([]);
    expect(d.toAdd).toEqual([]);
  });

  it("re-adds a contact whose do-not-contact was cleared", () => {
    const d = diffMembership(
      [{ contactId: "c1", phoneHash: H1, wanted: true }],
      [{ contactId: "c1", phoneHash: H1, isMember: false }],
    );
    expect(d.toAdd.map((r) => r.contactId)).toEqual(["c1"]);
  });

  it("removes the OLD hash and adds the new one when a phone changes", () => {
    const d = diffMembership(
      [{ contactId: "c1", phoneHash: H2, wanted: true }],
      [{ contactId: "c1", phoneHash: H1, isMember: true }],
    );
    expect(d.toRemove.map((r) => r.phoneHash)).toEqual([H1]);
    expect(d.toAdd.map((r) => r.phoneHash)).toEqual([H2]);
  });

  it("removes a mirrored member who vanished from the desired set entirely", () => {
    const d = diffMembership([], [{ contactId: "c9", phoneHash: H3, isMember: true }]);
    expect(d.toRemove.map((r) => r.contactId)).toEqual(["c9"]);
  });

  it("ignores a vanished contact that was already not a member", () => {
    const d = diffMembership([], [{ contactId: "c9", phoneHash: H3, isMember: false }]);
    expect(d.toRemove).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/lib/metaAudience.test.ts`
Expected: FAIL — `diffMembership is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `convex/lib/metaAudience.ts`:

```typescript
/** One row of the local mirror — what we believe Meta currently holds. */
export type MirrorRow = {
  contactId: string;
  phoneHash: string;
  isMember: boolean;
};

/** One row of the desired state, computed fresh from the CRM. */
export type Desired = {
  contactId: string;
  phoneHash: string;
  wanted: boolean;
};

export type AudienceDiff = {
  toAdd: Desired[];
  toRemove: MirrorRow[];
  /** Rows where belief already matched intent — no Graph call needed. */
  unchanged: number;
};

/**
 * The deltas needed to bring Meta from `mirror` to `desired`.
 *
 * A phone change is expressed as a REMOVE of the old digest plus an ADD of
 * the new one, because Meta indexes membership BY DIGEST — leaving the old
 * hash in place would strand an untargetable ghost in the audience that no
 * later pass could ever find again.
 *
 * A contact present in the mirror but absent from `desired` (deleted from
 * the CRM, or beyond the scan cap) is removed if we believe it is a member.
 */
export function diffMembership(
  desired: Desired[],
  mirror: MirrorRow[],
): AudienceDiff {
  const byId = new Map(mirror.map((m) => [m.contactId, m]));
  const toAdd: Desired[] = [];
  const toRemove: MirrorRow[] = [];
  let unchanged = 0;

  for (const d of desired) {
    const known = byId.get(d.contactId);
    byId.delete(d.contactId);

    if (known && known.phoneHash !== d.phoneHash) {
      // Phone changed. Retire the old digest first, then add the new one.
      if (known.isMember) toRemove.push(known);
      if (d.wanted) toAdd.push(d);
      continue;
    }

    const believedMember = known?.isMember ?? false;
    if (d.wanted && !believedMember) toAdd.push(d);
    else if (!d.wanted && believedMember) toRemove.push(known!);
    else unchanged++;
  }

  // Anything left in the mirror was not in the desired set at all.
  for (const orphan of byId.values()) {
    if (orphan.isMember) toRemove.push(orphan);
  }

  return { toAdd, toRemove, unchanged };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/lib/metaAudience.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/lib/metaAudience.ts convex/lib/metaAudience.test.ts
git commit -m "feat(audience): diff engine for add/remove reconciliation"
```

---

## Task 3: The mirror table

**Files:**
- Modify: `convex/schema.ts`

**Interfaces:**
- Produces: table `metaAudienceMembers` with indexes `by_account_contact` and `by_account_member`.

- [ ] **Step 1: Add the table to the schema**

In `convex/schema.ts`, add alongside the other account-scoped tables:

```typescript
  // Local mirror of what we believe the Meta customer-list audience holds.
  //
  // Meta's customer-list API is WRITE-ONLY — there is no endpoint that
  // returns current membership — so a reconciler cannot diff against Meta
  // and must remember what it sent. This table is that memory. It is a
  // belief, not a fact: if it ever drifts, the repair is to clear the rows
  // and let the next pass re-add everyone (adding a user Meta already
  // holds is a no-op, so a full re-add is safe).
  //
  // `phoneHash` is the SHA-256 digest actually sent. Storing the digest
  // rather than the number means a phone edit is detectable (hash differs)
  // without keeping a second copy of the PII.
  metaAudienceMembers: defineTable({
    accountId: v.id("accounts"),
    contactId: v.id("contacts"),
    phoneHash: v.string(),
    isMember: v.boolean(),
    lastSyncedAt: v.number(),
  })
    .index("by_account_contact", ["accountId", "contactId"])
    .index("by_account_member", ["accountId", "isMember"]),
```

- [ ] **Step 2: Verify the schema change is well-formed**

Run: `npx vitest run convex/lib/funnel.test.ts`
Expected: PASS. Any Convex test loading `schema` exercises the new table definition through convex-test's schema validation, so a malformed `defineTable` call fails here.

Do not run `tsc` to check this — see the typecheck note in Global Constraints.

- [ ] **Step 3: Commit**

```bash
git add convex/schema.ts
git commit -m "feat(audience): mirror table for Meta audience membership"
```

**Note for the PR:** this adds a table, so `convex/_generated/` is now stale. Do not run codegen — flag it for the owner.

---

## Task 4: Collect the desired state

**Files:**
- Create: `convex/metaAudienceSync.ts`
- Test: `convex/metaAudienceSync.test.ts`

**Interfaces:**
- Consumes: `shouldBeMember`, `MemberCandidate` (Task 1).
- Produces: `internal.metaAudienceSync.collectDesired` — an `internalQuery` taking `{ accountId: Id<"accounts">, limit: number }` and returning `{ contactId: Id<"contacts">; phoneNormalized: string; wanted: boolean }[]`.

- [ ] **Step 1: Write the failing test**

Create `convex/metaAudienceSync.test.ts`:

```typescript
import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("/convex/**/*.ts");

async function seedAccount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const accountId = await ctx.db.insert("accounts", {
      name: "Amani",
      defaultCurrency: "AED",
      ownerUserId: userId,
    });
    return accountId as Id<"accounts">;
  });
}

describe("collectDesired", () => {
  test("marks an ordinary contact wanted", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("contacts", {
        accountId,
        phone: "+971501234567",
        phoneNormalized: "971501234567",
      });
    });

    const rows = await t.query(internal.metaAudienceSync.collectDesired, {
      accountId,
      limit: 100,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].wanted).toBe(true);
  });

  test("marks a purchased contact not wanted", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: "+971501234567",
        phoneNormalized: "971501234567",
      });
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        funnel: { stage: "purchased" },
      });
    });

    const rows = await t.query(internal.metaAudienceSync.collectDesired, {
      accountId,
      limit: 100,
    });
    expect(rows[0].wanted).toBe(false);
  });

  test("marks a lost contact still wanted", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.run(async (ctx) => {
      const contactId = await ctx.db.insert("contacts", {
        accountId,
        phone: "+971501234567",
        phoneNormalized: "971501234567",
      });
      await ctx.db.insert("conversations", {
        accountId,
        contactId,
        status: "open",
        unreadCount: 0,
        funnel: { stage: "lost" },
      });
    });

    const rows = await t.query(internal.metaAudienceSync.collectDesired, {
      accountId,
      limit: 100,
    });
    expect(rows[0].wanted).toBe(true);
  });
});
```

**If a required field is missing from the `conversations` or `contacts` insert**, read `convex/schema.ts` for that table and add the minimum fields the validator demands. Do not weaken the schema to fit the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/metaAudienceSync.test.ts`
Expected: FAIL — `internal.metaAudienceSync` is undefined.

- [ ] **Step 3: Write minimal implementation**

Create `convex/metaAudienceSync.ts`:

```typescript
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { shouldBeMember } from "./lib/metaAudience";
import type { FunnelStageKey } from "./lib/funnel";

/**
 * Contacts examined per pass. The CRM holds ~2,800 today; this bounds a
 * runaway rather than expressing an expected limit.
 */
export const SCAN_CAP = 2000;

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
        .take(50);
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
```

**If `contacts` has no `by_account` index or `conversations` has no `by_contact` index**, read `convex/schema.ts` and use the closest existing index; do not add a new index in this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/metaAudienceSync.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add convex/metaAudienceSync.ts convex/metaAudienceSync.test.ts
git commit -m "feat(audience): collect desired membership from the CRM"
```

---

## Task 5: The Graph client

**Files:**
- Modify: `convex/metaAudienceSync.ts`

**Interfaces:**
- Produces: `sendAudienceDelta(args: { audienceId: string; token: string; operation: "ADD" | "REMOVE"; hashes: string[] }): Promise<{ ok: boolean; received: number; invalid: number; status: number; error: string | null }>` — an exported plain async function, not a Convex function, so it is directly callable from tests.

- [ ] **Step 1: Write the implementation**

Append to `convex/metaAudienceSync.ts`:

```typescript
import { sha256Hex, normalizePhoneForMeta } from "./conversionEvents";

/** Rows per Graph call. 300 proved workable in the 2026-09-02 backfill. */
export const GRAPH_BATCH = 300;

const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v21.0";

/** SHA-256 of the Meta-normalized phone, or null when unusable. */
export async function hashPhone(raw: string): Promise<string | null> {
  const normalized = normalizePhoneForMeta(raw);
  return normalized ? await sha256Hex(normalized) : null;
}

/**
 * One ADD or REMOVE against `/{audience_id}/users`.
 *
 * Hashes are sent PRE-COMPUTED: Meta accepts raw values and hashes them
 * server-side, but sending digests keeps raw customer phone numbers out of
 * the request body entirely.
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
```

- [ ] **Step 2: Write the failing test for `chunk` and `hashPhone`**

Append to `convex/metaAudienceSync.test.ts`:

```typescript
import { chunk, hashPhone, GRAPH_BATCH } from "./metaAudienceSync";

describe("chunk", () => {
  test("splits evenly", () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
  test("keeps a short tail", () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
  test("returns nothing for an empty list", () => {
    expect(chunk([], 300)).toEqual([]);
  });
  test("batch size is 300", () => {
    expect(GRAPH_BATCH).toBe(300);
  });
});

describe("hashPhone", () => {
  test("matches the digest Meta was sent in the manual backfill", async () => {
    expect(await hashPhone("971501234567")).toBe(
      "b7a8f5085aa733eb29857a02945bc84a5227e693708d469ec9fb21d34e9e44f5",
    );
  });
  test("tolerates punctuation and a leading plus", async () => {
    expect(await hashPhone("+971 50 123 4567")).toBe(
      "b7a8f5085aa733eb29857a02945bc84a5227e693708d469ec9fb21d34e9e44f5",
    );
  });
  test("returns null for a number too short to carry a country code", async () => {
    expect(await hashPhone("12345")).toBeNull();
  });
});
```

The fixture digest is verified: it is `sha256("971501234567")`, confirmed byte-identical between Node's `crypto` and Convex's Web Crypto on 2026-09-02.

- [ ] **Step 3: Run tests**

Run: `npx vitest run convex/metaAudienceSync.test.ts`
Expected: PASS, 10 tests total.

If `hashPhone("+971 50 123 4567")` fails, `normalizePhoneForMeta` is not stripping punctuation the way this test assumes — read it in `convex/conversionEvents.ts` and correct the *test's* expectation rather than changing shared normalization used by the conversions lane.

- [ ] **Step 4: Commit**

```bash
git add convex/metaAudienceSync.ts convex/metaAudienceSync.test.ts
git commit -m "feat(audience): Graph client for audience add/remove"
```

---

## Task 6: The mirror mutations

**Files:**
- Modify: `convex/metaAudienceSync.ts`

**Interfaces:**
- Produces:
  - `internal.metaAudienceSync.readMirror` — `internalQuery({ accountId })` → `{ contactId, phoneHash, isMember }[]`
  - `internal.metaAudienceSync.applyMirror` — `internalMutation({ accountId, rows: { contactId, phoneHash, isMember }[] })` → `null`

- [ ] **Step 1: Write the failing test**

Append to `convex/metaAudienceSync.test.ts`:

```typescript
describe("mirror", () => {
  test("applyMirror upserts, readMirror reads back", async () => {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    const contactId = await t.run(async (ctx) =>
      ctx.db.insert("contacts", {
        accountId,
        phone: "+971501234567",
        phoneNormalized: "971501234567",
      }),
    );

    await t.mutation(internal.metaAudienceSync.applyMirror, {
      accountId,
      rows: [{ contactId, phoneHash: "a".repeat(64), isMember: true }],
    });

    let rows = await t.query(internal.metaAudienceSync.readMirror, { accountId });
    expect(rows).toEqual([
      { contactId, phoneHash: "a".repeat(64), isMember: true },
    ]);

    // Second write updates in place rather than inserting a duplicate.
    await t.mutation(internal.metaAudienceSync.applyMirror, {
      accountId,
      rows: [{ contactId, phoneHash: "b".repeat(64), isMember: false }],
    });

    rows = await t.query(internal.metaAudienceSync.readMirror, { accountId });
    expect(rows).toHaveLength(1);
    expect(rows[0].isMember).toBe(false);
    expect(rows[0].phoneHash).toBe("b".repeat(64));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/metaAudienceSync.test.ts -t mirror`
Expected: FAIL — `readMirror` is undefined.

- [ ] **Step 3: Write minimal implementation**

Append to `convex/metaAudienceSync.ts` (add `internalMutation` to the `./_generated/server` import):

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/metaAudienceSync.test.ts -t mirror`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/metaAudienceSync.ts convex/metaAudienceSync.test.ts
git commit -m "feat(audience): mirror read/upsert for membership state"
```

---

## Task 7: The orchestrating action

**Files:**
- Modify: `convex/metaAudienceSync.ts`

**Interfaces:**
- Consumes: `collectDesired`, `readMirror`, `applyMirror`, `diffMembership`, `hashPhone`, `sendAudienceDelta`, `chunk`.
- Produces: `internal.metaAudienceSync.syncAudience` — `internalAction({})` → `{ skipped: boolean; added: number; removed: number; unchanged: number; failures: number }`

- [ ] **Step 1: Write the failing test for the disabled path**

Append to `convex/metaAudienceSync.test.ts`:

```typescript
describe("syncAudience", () => {
  test("no-ops when META_CUSTOM_AUDIENCE_ID is unset", async () => {
    const prevId = process.env.META_CUSTOM_AUDIENCE_ID;
    const prevToken = process.env.META_ADS_ACCESS_TOKEN;
    delete process.env.META_CUSTOM_AUDIENCE_ID;
    delete process.env.META_ADS_ACCESS_TOKEN;
    try {
      const t = convexTest(schema, modules);
      await seedAccount(t);
      const result = await t.action(internal.metaAudienceSync.syncAudience, {});
      expect(result.skipped).toBe(true);
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    } finally {
      if (prevId) process.env.META_CUSTOM_AUDIENCE_ID = prevId;
      if (prevToken) process.env.META_ADS_ACCESS_TOKEN = prevToken;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run convex/metaAudienceSync.test.ts -t syncAudience`
Expected: FAIL — `syncAudience` is undefined.

- [ ] **Step 3: Write minimal implementation**

Append to `convex/metaAudienceSync.ts` (add `internalAction` to the `./_generated/server` import, and `import { internal } from "./_generated/api";`):

```typescript
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
    failures: number;
  }> => {
    const audienceId = process.env.META_CUSTOM_AUDIENCE_ID?.trim();
    const token = process.env.META_ADS_ACCESS_TOKEN?.trim();
    if (!audienceId || !token) {
      return { skipped: true, added: 0, removed: 0, unchanged: 0, failures: 0 };
    }

    const accountIds = await ctx.runQuery(
      internal.metaAudienceSync.listAccountIds,
      {},
    );

    let added = 0;
    let removed = 0;
    let unchanged = 0;
    let failures = 0;

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

      for (const batch of chunk(diff.toAdd, GRAPH_BATCH)) {
        const res = await sendAudienceDelta({
          audienceId,
          token,
          operation: "ADD",
          hashes: batch.map((r) => r.phoneHash),
        });
        if (!res.ok) {
          failures++;
          continue;
        }
        await ctx.runMutation(internal.metaAudienceSync.applyMirror, {
          accountId,
          rows: batch.map((r) => ({
            contactId: r.contactId,
            phoneHash: r.phoneHash,
            isMember: true,
          })),
        });
        added += batch.length;
      }

      for (const batch of chunk(diff.toRemove, GRAPH_BATCH)) {
        const res = await sendAudienceDelta({
          audienceId,
          token,
          operation: "REMOVE",
          hashes: batch.map((r) => r.phoneHash),
        });
        if (!res.ok) {
          failures++;
          continue;
        }
        await ctx.runMutation(internal.metaAudienceSync.applyMirror, {
          accountId,
          rows: batch.map((r) => ({
            contactId: r.contactId,
            phoneHash: r.phoneHash,
            isMember: false,
          })),
        });
        removed += batch.length;
      }
    }

    return { skipped: false, added, removed, unchanged, failures };
  },
});
```

Also append the small helper query it calls:

```typescript
/** Every account on the deployment. Small table — a full scan is correct. */
export const listAccountIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const accounts = await ctx.db.query("accounts").take(100);
    return accounts.map((a) => a._id);
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run convex/metaAudienceSync.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Add the enabled-path test with a stubbed fetch**

Append to `convex/metaAudienceSync.test.ts`:

```typescript
test("adds a wanted contact and records it in the mirror", async () => {
  const prevId = process.env.META_CUSTOM_AUDIENCE_ID;
  const prevToken = process.env.META_ADS_ACCESS_TOKEN;
  const realFetch = globalThis.fetch;
  process.env.META_CUSTOM_AUDIENCE_ID = "52503553736038";
  process.env.META_ADS_ACCESS_TOKEN = "test-token";

  const calls: { method: string; count: number }[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ method: String(init.method), count: body.payload.data.length });
    return new Response(
      JSON.stringify({ num_received: body.payload.data.length, num_invalid_entries: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("contacts", {
        accountId,
        phone: "+971501234567",
        phoneNormalized: "971501234567",
      });
    });

    const result = await t.action(internal.metaAudienceSync.syncAudience, {});
    expect(result.skipped).toBe(false);
    expect(result.added).toBe(1);
    expect(result.failures).toBe(0);
    expect(calls).toEqual([{ method: "POST", count: 1 }]);

    // A second run is a no-op — the mirror already believes it is a member.
    const again = await t.action(internal.metaAudienceSync.syncAudience, {});
    expect(again.added).toBe(0);
    expect(again.unchanged).toBe(1);
    expect(calls).toHaveLength(1);
  } finally {
    globalThis.fetch = realFetch;
    if (prevId) process.env.META_CUSTOM_AUDIENCE_ID = prevId;
    else delete process.env.META_CUSTOM_AUDIENCE_ID;
    if (prevToken) process.env.META_ADS_ACCESS_TOKEN = prevToken;
    else delete process.env.META_ADS_ACCESS_TOKEN;
  }
});

test("removes a contact once do-not-contact is set", async () => {
  const prevId = process.env.META_CUSTOM_AUDIENCE_ID;
  const prevToken = process.env.META_ADS_ACCESS_TOKEN;
  const realFetch = globalThis.fetch;
  process.env.META_CUSTOM_AUDIENCE_ID = "52503553736038";
  process.env.META_ADS_ACCESS_TOKEN = "test-token";

  const methods: string[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    methods.push(String(init.method));
    const body = JSON.parse(String(init.body));
    return new Response(
      JSON.stringify({ num_received: body.payload.data.length, num_invalid_entries: 0 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const t = convexTest(schema, modules);
    const accountId = await seedAccount(t);
    const contactId = await t.run(async (ctx) =>
      ctx.db.insert("contacts", {
        accountId,
        phone: "+971501234567",
        phoneNormalized: "971501234567",
      }),
    );

    await t.action(internal.metaAudienceSync.syncAudience, {});
    expect(methods).toEqual(["POST"]);

    await t.run(async (ctx) => {
      const noteId = await ctx.db.insert("contactNotes", {
        accountId,
        contactId,
        body: "asked to stop",
      });
      await ctx.db.patch(contactId, {
        doNotContact: { at: Date.now(), noteId },
      });
    });

    const result = await t.action(internal.metaAudienceSync.syncAudience, {});
    expect(result.removed).toBe(1);
    expect(methods).toEqual(["POST", "DELETE"]);
  } finally {
    globalThis.fetch = realFetch;
    if (prevId) process.env.META_CUSTOM_AUDIENCE_ID = prevId;
    else delete process.env.META_CUSTOM_AUDIENCE_ID;
    if (prevToken) process.env.META_ADS_ACCESS_TOKEN = prevToken;
    else delete process.env.META_ADS_ACCESS_TOKEN;
  }
});
```

**If the `contactNotes` insert fails validation**, read that table in `convex/schema.ts` and supply the fields it requires. The point of the test is the `doNotContact` transition, not the note's shape.

- [ ] **Step 6: Run all tests**

Run: `npx vitest run convex/metaAudienceSync.test.ts convex/lib/metaAudience.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add convex/metaAudienceSync.ts convex/metaAudienceSync.test.ts
git commit -m "feat(audience): nightly reconciler action"
```

---

## Task 8: Register the daily cron

Three files must stay in sync — `convex/cronSchedules.test.ts` asserts it.

**Files:**
- Modify: `convex/crons.ts`
- Modify: `convex/cronSchedules.ts`
- Modify: `convex/lib/cronSummary.ts`

**Interfaces:**
- Consumes: `internal.metaAudienceSync.syncAudience` (Task 7).
- Produces: cron named `meta-audience-sync`, interval 1440 minutes.

- [ ] **Step 1: Add the registry entry**

In `convex/lib/cronSummary.ts`, append to `CRON_REGISTRY` (after `dashboard-snapshot`):

```typescript
  { name: "meta-audience-sync", intervalMinutes: 1440 },
```

- [ ] **Step 2: Add the wrapper**

In `convex/cronSchedules.ts`, alongside the other wrappers:

```typescript
export const runMetaAudienceSync = internalAction({
  args: {},
  handler: (ctx): Promise<void> =>
    runWrapped(
      ctx,
      "meta-audience-sync",
      internal.metaAudienceSync.syncAudience,
    ),
});
```

- [ ] **Step 3: Register the cron**

In `convex/crons.ts`, append before the final export:

```typescript
// Daily reconcile of the Meta customer-list audience: add contacts that
// now belong, remove the ones that no longer do (do-not-contact set, or
// converted). No-op while META_CUSTOM_AUDIENCE_ID is unset.
crons.interval(
  "meta-audience-sync",
  { minutes: 1440 },
  internal.cronSchedules.runMetaAudienceSync,
  {},
);
```

- [ ] **Step 4: Run the sync-guard test**

Run: `npx vitest run convex/cronSchedules.test.ts`
Expected: PASS — the registry, the wrappers and `crons.ts` agree.

If it fails naming `meta-audience-sync`, one of the three edits is missing or misspelled. The name must be byte-identical in all three.

- [ ] **Step 5: Run the full convex suite**

Run: `npx vitest run convex/`
Expected: PASS. A failure in `_generated/api` drift is expected and is the owner's codegen step — note it, do not run codegen.

- [ ] **Step 6: Commit**

```bash
git add convex/crons.ts convex/cronSchedules.ts convex/lib/cronSummary.ts
git commit -m "feat(audience): register the daily audience-sync cron"
```

---

## Task 9: Enablement runbook

**Files:**
- Create: `docs/meta-audience-sync.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Meta Custom Audience sync

Reconciles CRM contacts against Meta customer-list audience `52503553736038`
(ad account `41958557`, Amani Travel & Tourism) once a day.

## Turning it on

Both env vars must be set on the Convex deployment. With either missing the
cron runs and returns `skipped: true`, touching nothing.

    npx convex env set META_CUSTOM_AUDIENCE_ID 52503553736038
    npx convex env set META_ADS_ACCESS_TOKEN <token with ads_management>

The token needs `ads_management` on ad account `41958557`, and that account
must have accepted Meta's Custom Audience Terms of Service (a one-time click
in Ads Manager — it cannot be done over the API).

## Who is in the audience

In: any contact with a country-code phone, no do-not-contact flag, and no
conversation at funnel stage `purchased`.

Out: do-not-contact, converted (`purchased`), or an unusable phone.

`lost` leads stay IN on purpose — they did not buy, so they are still worth
retargeting. Change `EXCLUDED_STAGES` in `convex/lib/metaAudience.ts` to
alter this.

## If the mirror drifts

`metaAudienceMembers` records what we believe Meta holds; Meta offers no way
to read actual membership back. If the two diverge, delete the account's
rows and let the next pass re-add everyone — adding a user Meta already
holds is a no-op, so a full re-add is safe and idempotent.

## Where to look when it misbehaves

Settings → Cron schedules, row `meta-audience-sync`. A failed run is
recorded with its error. Batches Meta rejects leave the mirror untouched, so
the following night retries exactly those rows.
```

- [ ] **Step 2: Commit**

```bash
git add docs/meta-audience-sync.md
git commit -m "docs(audience): enablement runbook for the daily sync"
```

---

## Self-Review

**Spec coverage:** membership rules → Task 1; add/remove diff → Task 2; persistence → Tasks 3, 6; CRM read → Task 4; Graph I/O → Task 5; orchestration → Task 7; daily schedule → Task 8; operability → Task 9; the token risk that could invalidate the whole approach → Task 0, deliberately first.

**Placeholder scan:** none. Every code step carries real code; the three "if this doesn't compile" notes point at a specific file to read rather than deferring a decision.

**Type consistency:** `MemberCandidate`, `MirrorRow`, `Desired`, `AudienceDiff` are defined in Tasks 1–2 and used unchanged in 4, 6, 7. `shouldBeMember`, `diffMembership`, `hashPhone`, `chunk`, `sendAudienceDelta`, `collectDesired`, `readMirror`, `applyMirror`, `listAccountIds`, `syncAudience` keep one spelling throughout. `GRAPH_BATCH = 300` and `SCAN_CAP = 2000` are each defined once.

**Known gap, stated deliberately:** the plan syncs *all* accounts on the deployment to a *single* audience ID. That is correct today — the deployment serves one business — but is wrong the moment a second account exists. Making the audience ID per-account is a schema change on `accounts` and belongs in its own plan, not smuggled in here.
