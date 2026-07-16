# AI Tag Suggestions — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent can classify a WhatsApp conversation with one action — the AI reads the chat + the account's tag catalogue and proposes tags (validated against real tags) + a one-line note as a reviewable **suggestion** the agent accepts or dismisses.

**Architecture:** A new "classify" path that reuses the existing AI stack (`generateReply`, `aiConfig.loadDecrypted`, `aiReply.recentMessages`, `toChatMessages`, `aiUsage.log`, dry-run) — exactly mirroring the existing `aiReply.draft` action. Two pure functions (`buildClassifyPrompt`, `parseClassification`) do the prompt + robust JSON→tag-id mapping; a `tagSuggestions` table holds the result; an inbox banner surfaces Accept/Dismiss.

**Tech Stack:** Convex (self-hosted), `convex-test` + Vitest, Next.js (non-stock fork), React 19, `convex/react`, shadcn/ui, `next-intl`, `sonner`.

## Global Constraints

- **Depends on Phase 1 grouped tags** (branch `feat/inbox-tag-label-system`, which this branch is stacked on): `tagGroups`, grouped `tags` (`groupId`, `selectionMode` on the group), `contacts.assignTag` (with the Task-4 single-select displacement), `contactNotes.add`. Those exist on this branch.
- **Convex codegen pushes prod — never run `convex dev`/`deploy`/`codegen`.** New table/field = edit `convex/schema.ts` only (`dataModel.d.ts` is generic). New function module or new `lib/` module = add its two lines to `convex/_generated/api.d.ts` (runtime `api` is `anyApi`; `convex-test` auto-discovers via `import.meta.glob`).
- **Tenant scoping:** public entry points are `action`s that derive account+role via `ctx.runQuery(internal.accounts.accountContextForUser, {})` (mirror `aiReply.draft`); mutations use `accountMutation` + `ctx.requireRole(...)`. Every write re-checks the target row's `accountId`.
- **Role floors:** run a classification / accept / dismiss = `requireRole("agent")` (same floor as `assignTag`/`addNote`).
- **AI calls are dry-run-gated:** never call `generateReply` when `isDryRun()` is true — return a synthetic classification instead (mirror `aiReply.syntheticGeneration`). Tests run under `CONVEX_AI_DRY_RUN` and never hit the network.
- **The model can only choose real tags.** `parseClassification` validates every returned name against the catalogue and drops anything off-list; it never throws (unparseable → `low` confidence, empty tags).
- **i18n:** all new UI copy under `Inbox.tagSuggestions.*` in `messages/en.json` (single locale); no hard-coded strings; every mutation call in a try/catch with `toast.error(t('...'))`.
- **Tests offline:** `npx vitest run <file>`; typecheck `npx tsc --noEmit`; lint `npx eslint <files>`. Stage files EXPLICITLY (exact paths) — an unrelated `convex/conversionEvents.test.ts` change is in the tree; never `git add -A`.
- **Commit after every green task.**

---

## Task 1: Schema — `tagSuggestions`, `contactTags.source`, classify usage mode

**Files:**
- Modify: `convex/schema.ts` (the `contactTags` table; the `aiUsageLog` table; add `tagSuggestions`)
- Test: `convex/schema.test.ts`

**Interfaces:**
- Produces: table `tagSuggestions` `{ accountId, conversationId, contactId, suggestedTagIds: Id<"tags">[], note?, confidence: "high"|"medium"|"low", status: "auto_applied"|"pending"|"accepted"|"dismissed", model, reviewedByUserId? }` indexed `by_account_status` (`["accountId","status"]`) and `by_conversation`; `contactTags` gains `source?: "ai"|"manual"`; `aiUsageLog.mode` union gains `"classify"`.

- [ ] **Step 1: Write the failing test** — append to `convex/schema.test.ts` (reuse its `convexTest`/`schema`/`modules` header; copy from `convex/tags.test.ts` if absent):

```ts
test("tagSuggestions row inserts and is queryable by_account_status", async () => {
  const t = convexTest(schema, modules);
  const { accountId, sugId } = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "S", email: "s@x.com" });
    const accountId = await ctx.db.insert("accounts", { name: "A", defaultCurrency: "USD", ownerUserId: userId });
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+15550001", phoneNormalized: "15550001" });
    const conversationId = await ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 });
    const tagId = await ctx.db.insert("tags", { accountId, name: "UAE Visa", color: "#3b82f6" });
    const sugId = await ctx.db.insert("tagSuggestions", {
      accountId, conversationId, contactId,
      suggestedTagIds: [tagId], note: "Asking about UAE visa", confidence: "high", status: "pending", model: "test-model",
    });
    // provenance + classify-mode also valid:
    await ctx.db.insert("contactTags", { accountId, contactId, tagId, source: "ai" });
    await ctx.db.insert("aiUsageLog", { accountId, conversationId, mode: "classify", provider: "openai", model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    return { accountId, sugId };
  });
  const pending = await t.run((ctx) =>
    ctx.db.query("tagSuggestions").withIndex("by_account_status", (q) => q.eq("accountId", accountId).eq("status", "pending")).collect(),
  );
  expect(pending).toHaveLength(1);
  expect(pending[0]._id).toBe(sugId);
  expect(pending[0].suggestedTagIds).toHaveLength(1);
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run convex/schema.test.ts -t "tagSuggestions row inserts"`
Expected: FAIL — unknown table `tagSuggestions` / unexpected `source` / `mode:"classify"` rejected by the union.

- [ ] **Step 3: Edit `convex/schema.ts`**

Add `source` to the existing `contactTags` table definition:
```ts
    source: v.optional(v.union(v.literal("ai"), v.literal("manual"))), // unset = manual (backward-compatible)
```
Add `"classify"` to `aiUsageLog.mode`:
```ts
    mode: v.union(v.literal("auto_reply"), v.literal("draft"), v.literal("classify")),
```
Add the new table (near the other AI tables):
```ts
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
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run convex/schema.test.ts`
Expected: PASS (new test green; existing schema tests unaffected — all additions are optional/additive).

- [ ] **Step 5: Commit**

```bash
git add convex/schema.ts convex/schema.test.ts
git commit -m "feat(ai-tagging): tagSuggestions table + contactTags.source + classify usage mode"
```

---

## Task 2: Pure — `parseClassification` (the heart)

**Files:**
- Create: `convex/lib/ai/classify.ts`
- Modify: `convex/_generated/api.d.ts` (register `lib/ai/classify`)
- Test: `convex/lib/ai/classify.test.ts`

**Interfaces:**
- Produces:
  - `interface CatalogueGroup { id: string; name: string; selectionMode: "single" | "multi"; tags: { id: string; name: string }[] }`
  - `interface Catalogue { groups: CatalogueGroup[] }`
  - `interface Classification { tagIds: string[]; note?: string; confidence: "high" | "medium" | "low" }`
  - `parseClassification(raw: string, catalogue: Catalogue): Classification` — extracts the JSON object from the model text, reads a flat `tags: string[]` of chosen tag NAMES, maps each (case-insensitive) to a real tag id, **drops off-list names**, enforces **at most one tag per single-select group** (first valid wins), reads `note` (trimmed string) and `confidence` (falls back to `"low"`). Never throws; unparseable → `{ tagIds: [], confidence: "low" }`.

- [ ] **Step 1: Write the failing tests** — create `convex/lib/ai/classify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseClassification, type Catalogue } from "./classify";

const CAT: Catalogue = {
  groups: [
    { id: "gP", name: "Product", selectionMode: "single", tags: [
      { id: "t_uae", name: "UAE Visa" }, { id: "t_pkg", name: "Packages" } ] },
    { id: "gD", name: "Destination", selectionMode: "multi", tags: [
      { id: "t_th", name: "Thailand" }, { id: "t_bali", name: "Bali" } ] },
  ],
};

describe("parseClassification", () => {
  it("maps valid tag names to ids and keeps a multi-group's multiple tags", () => {
    const r = parseClassification(
      '{"tags":["Packages","Thailand","Bali"],"note":"5-day Bali+Thailand for 2","confidence":"high"}', CAT);
    expect(r.tagIds.sort()).toEqual(["t_bali", "t_pkg", "t_th"].sort());
    expect(r.note).toBe("5-day Bali+Thailand for 2");
    expect(r.confidence).toBe("high");
  });

  it("drops names not in the catalogue", () => {
    const r = parseClassification('{"tags":["UAE Visa","Cruise"],"confidence":"medium"}', CAT);
    expect(r.tagIds).toEqual(["t_uae"]);
  });

  it("enforces at most one tag from a single-select group (first valid wins)", () => {
    const r = parseClassification('{"tags":["UAE Visa","Packages","Thailand"],"confidence":"high"}', CAT);
    expect(r.tagIds).toContain("t_uae");     // first product kept
    expect(r.tagIds).not.toContain("t_pkg"); // second product dropped
    expect(r.tagIds).toContain("t_th");      // multi-group unaffected
  });

  it("is case-insensitive on names", () => {
    const r = parseClassification('{"tags":["packages","BALI"],"confidence":"low"}', CAT);
    expect(r.tagIds.sort()).toEqual(["t_bali", "t_pkg"].sort());
  });

  it("tolerates prose around the JSON and a trailing note", () => {
    const r = parseClassification('Here you go:\n{"tags":["Thailand"],"note":" trip ","confidence":"high"}\nThanks', CAT);
    expect(r.tagIds).toEqual(["t_th"]);
    expect(r.note).toBe("trip");
  });

  it("falls back to low/empty on unparseable output and bad confidence", () => {
    expect(parseClassification("not json at all", CAT)).toEqual({ tagIds: [], confidence: "low" });
    const r = parseClassification('{"tags":[],"confidence":"banana"}', CAT);
    expect(r).toEqual({ tagIds: [], confidence: "low" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run convex/lib/ai/classify.test.ts`
Expected: FAIL — `./classify` not found.

- [ ] **Step 3: Create `convex/lib/ai/classify.ts`** (this step adds `parseClassification` + types; `buildClassifyPrompt` is Task 3, same file):

```ts
// ============================================================
// Pure helpers for the AI "classify" path — no I/O, unit-tested directly
// (same pattern as lib/ai/context.ts / handoff.ts). buildClassifyPrompt
// renders the account's tag catalogue as a fixed option set; the model
// may only choose from it. parseClassification maps the model's chosen
// tag NAMES back to real tag ids, dropping anything off-list and
// enforcing single-select groups. Never throws.
// ============================================================

export interface CatalogueGroup {
  id: string;
  name: string;
  selectionMode: "single" | "multi";
  tags: { id: string; name: string }[];
}
export interface Catalogue {
  groups: CatalogueGroup[];
}
export interface Classification {
  tagIds: string[];
  note?: string;
  confidence: "high" | "medium" | "low";
}

const CONFIDENCES = ["high", "medium", "low"] as const;

/** Extract the first balanced-looking JSON object from model text. */
function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseClassification(raw: string, catalogue: Catalogue): Classification {
  const obj = extractJsonObject(raw) as
    | { tags?: unknown; note?: unknown; confidence?: unknown }
    | null;
  if (!obj || typeof obj !== "object") return { tagIds: [], confidence: "low" };

  // name (lowercased) -> { id, groupId, single }
  const byName = new Map<string, { id: string; groupId: string; single: boolean }>();
  for (const g of catalogue.groups) {
    for (const tag of g.tags) {
      byName.set(tag.name.toLowerCase(), {
        id: tag.id,
        groupId: g.id,
        single: g.selectionMode === "single",
      });
    }
  }

  const names = Array.isArray(obj.tags)
    ? obj.tags.filter((x): x is string => typeof x === "string")
    : [];
  const tagIds: string[] = [];
  const usedSingleGroups = new Set<string>();
  const seen = new Set<string>();
  for (const name of names) {
    const hit = byName.get(name.trim().toLowerCase());
    if (!hit || seen.has(hit.id)) continue;
    if (hit.single && usedSingleGroups.has(hit.groupId)) continue; // one per single group
    tagIds.push(hit.id);
    seen.add(hit.id);
    if (hit.single) usedSingleGroups.add(hit.groupId);
  }

  const note =
    typeof obj.note === "string" && obj.note.trim() ? obj.note.trim() : undefined;
  const confidence = CONFIDENCES.includes(obj.confidence as (typeof CONFIDENCES)[number])
    ? (obj.confidence as "high" | "medium" | "low")
    : "low";

  return { tagIds, note, confidence };
}
```

- [ ] **Step 4: Register `lib/ai/classify` in `convex/_generated/api.d.ts`** — add the import (alphabetical, near the other `lib_ai_*`):
```ts
import type * as lib_ai_classify from "../lib/ai/classify.js";
```
and the `fullApi` member (near the other `"lib/ai/..."` keys):
```ts
  "lib/ai/classify": typeof lib_ai_classify;
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx vitest run convex/lib/ai/classify.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 6: Commit**

```bash
git add convex/lib/ai/classify.ts convex/lib/ai/classify.test.ts convex/_generated/api.d.ts
git commit -m "feat(ai-tagging): parseClassification (catalogue-validated name→id mapping)"
```

---

## Task 3: Pure — `buildClassifyPrompt`

**Files:**
- Modify: `convex/lib/ai/classify.ts`
- Test: `convex/lib/ai/classify.test.ts`

**Interfaces:**
- Consumes: `Catalogue` (Task 2).
- Produces: `buildClassifyPrompt(catalogue: Catalogue): string` — a system prompt that lists each group with its selection mode + exact allowed tag names, and instructs the model to reply with ONLY a JSON object `{ "tags": string[], "note": string, "confidence": "high"|"medium"|"low" }`, choosing tag names only from the lists (or none), one at most per single-select group.

- [ ] **Step 1: Write the failing tests** — append to `convex/lib/ai/classify.test.ts`:

```ts
import { buildClassifyPrompt } from "./classify";

describe("buildClassifyPrompt", () => {
  it("lists every group with its options and selection mode, and asks for JSON", () => {
    const p = buildClassifyPrompt(CAT);
    expect(p).toContain("Product");
    expect(p).toContain("UAE Visa");
    expect(p).toContain("Packages");
    expect(p).toContain("Destination");
    expect(p).toContain("Thailand");
    expect(p.toLowerCase()).toContain("json");
    // single vs multi guidance is present in some form
    expect(p.toLowerCase()).toMatch(/one|single|exactly one/);
  });

  it("handles an empty catalogue without throwing", () => {
    expect(() => buildClassifyPrompt({ groups: [] })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run convex/lib/ai/classify.test.ts -t "buildClassifyPrompt"`
Expected: FAIL — `buildClassifyPrompt` not exported.

- [ ] **Step 3: Add `buildClassifyPrompt` to `convex/lib/ai/classify.ts`**

```ts
/** System prompt for the classify path. Renders the catalogue as fixed
 *  option lists and constrains the model to JSON output using only those
 *  names. Kept deterministic (no timestamps/randomness) so it's testable. */
export function buildClassifyPrompt(catalogue: Catalogue): string {
  const groupLines = catalogue.groups.map((g) => {
    const rule = g.selectionMode === "single" ? "choose at most ONE" : "choose any that apply";
    const opts = g.tags.map((t) => t.name).join(" | ") || "(no tags defined)";
    return `- ${g.name} (${rule}): ${opts}`;
  });
  const groups = groupLines.length ? groupLines.join("\n") : "- (no tag groups defined)";
  return [
    "You classify a customer WhatsApp conversation for a travel agency's CRM.",
    "Read the conversation, then label it using ONLY the tags below — never invent a tag.",
    "",
    "Tag groups:",
    groups,
    "",
    "Also write a one-line internal note summarising what the customer wants,",
    "and rate your confidence (high only if the conversation clearly supports it).",
    "",
    'Reply with ONLY a JSON object, no prose, in exactly this shape:',
    '{"tags": ["<chosen tag name>", ...], "note": "<one line>", "confidence": "high" | "medium" | "low"}',
    "Pick at most one tag from any group marked \"choose at most ONE\".",
    "If nothing fits a group, omit it. If the conversation is unclear, use low confidence.",
  ].join("\n");
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run convex/lib/ai/classify.test.ts`
Expected: PASS (all Task 2 + Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add convex/lib/ai/classify.ts convex/lib/ai/classify.test.ts
git commit -m "feat(ai-tagging): buildClassifyPrompt (catalogue as fixed option set)"
```

---

## Task 4: Backend — catalogue loader + `suggest` action

**Files:**
- Create: `convex/aiTagging.ts`
- Modify: `convex/_generated/api.d.ts` (register `aiTagging`)
- Test: `convex/aiTagging.test.ts`

**Interfaces:**
- Consumes: `internal.aiConfig.loadDecrypted({accountId})` → `{ provider, model, apiKey, isActive, ... }`; `internal.aiReply.recentMessages({conversationId, limit})` → history rows; `toChatMessages` (`./lib/ai/context`); `internal.accounts.accountContextForUser` (→ `{ accountId, role, ... }`); `generateReply` + `parseClassification`/`buildClassifyPrompt` (`./lib/ai/classify`); `internal.aiUsage.log`.
- Produces:
  - `internal.aiTagging.loadCatalogue({accountId})` (internalQuery) → `Catalogue` (groups with their tags, from `tagGroups`+`tags`).
  - `internal.aiTagging.recordSuggestion({accountId, conversationId, contactId, suggestedTagIds, note?, confidence, model})` (internalMutation) → `Id<"tagSuggestions">` with `status:"pending"`.
  - `aiTagging.suggest({conversationId})` (public `action`, agent) → `{ suggestionId, tagIds, note?, confidence }`. Loads context, classifies (dry-run synthetic when `CONVEX_AI_DRY_RUN`), records a pending suggestion. Returns `{ error, code }` on a missing/inactive AI config (mirrors `aiReply.draft`).

- [ ] **Step 1: Write the failing test** (dry-run) — create `convex/aiTagging.test.ts`. Header + `seedAccountMember` copied from `convex/aiReply.test.ts` (it already sets `CONVEX_AI_DRY_RUN` and seeds an `aiConfigs` row — reuse that setup verbatim). Then:

```ts
test("suggest records a pending suggestion from a dry-run classification", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMemberWithAi(t, { role: "agent" }); // AI config seeded, DRY_RUN on
  const { conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+15550009", phoneNormalized: "15550009" });
    const conversationId = await ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 });
    await ctx.db.insert("messages", { accountId, conversationId, senderType: "customer", contentType: "text", contentText: "UAE Visa please", status: "delivered" });
    const gid = await ctx.db.insert("tagGroups", { accountId, name: "Product", selectionMode: "single", position: 0 });
    await ctx.db.insert("tags", { accountId, name: "UAE Visa", color: "#3b82f6", groupId: gid });
    return { conversationId };
  });

  const res = await asUser.action(api.aiTagging.suggest, { conversationId });
  expect(res.suggestionId).toBeDefined();

  const rows = await t.run((ctx) =>
    ctx.db.query("tagSuggestions").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).collect(),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe("pending");
  expect(rows[0].confidence).toBeDefined();
});
```

*(If `aiReply.test.ts`'s helper isn't named `seedAccountMemberWithAi`, copy its actual AI-seeding helper verbatim and use that name. The key is: it seeds an `aiConfigs` row with `isActive: true` and the env is dry-run.)*

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run convex/aiTagging.test.ts`
Expected: FAIL — `api.aiTagging.suggest` undefined.

- [ ] **Step 3: Create `convex/aiTagging.ts`**

```ts
import { action, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { toChatMessages } from "./lib/ai/context";
import { aiContextMessageLimit } from "./lib/ai/defaults";
import { generateReply } from "./lib/ai/generate";
import {
  buildClassifyPrompt,
  parseClassification,
  type Catalogue,
} from "./lib/ai/classify";

const CONFIDENCE = v.union(v.literal("high"), v.literal("medium"), v.literal("low"));

function isDryRun(): boolean {
  return process.env.CONVEX_AI_DRY_RUN === "1" || process.env.CONVEX_AI_DRY_RUN === "true";
}

/** Dry-run stand-in: pick the FIRST tag of each group so parseClassification
 *  maps a real id — deterministic, no network (mirrors aiReply.syntheticGeneration). */
function syntheticClassifyRaw(catalogue: Catalogue): string {
  const tags = catalogue.groups.map((g) => g.tags[0]?.name).filter(Boolean);
  return JSON.stringify({ tags, note: "dry-run classification", confidence: "low" });
}

export const loadCatalogue = internalQuery({
  args: { accountId: v.id("accounts") },
  handler: async (ctx, args): Promise<Catalogue> => {
    const groups = await ctx.db
      .query("tagGroups")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    const tags = await ctx.db
      .query("tags")
      .withIndex("by_account", (q) => q.eq("accountId", args.accountId))
      .collect();
    return {
      groups: groups
        .sort((a, b) => a.position - b.position)
        .map((g) => ({
          id: g._id,
          name: g.name,
          selectionMode: g.selectionMode,
          tags: tags
            .filter((tag) => tag.groupId === g._id)
            .map((tag) => ({ id: tag._id, name: tag.name })),
        })),
    };
  },
});

export const recordSuggestion = internalMutation({
  args: {
    accountId: v.id("accounts"),
    conversationId: v.id("conversations"),
    contactId: v.id("contacts"),
    suggestedTagIds: v.array(v.id("tags")),
    note: v.optional(v.string()),
    confidence: CONFIDENCE,
    model: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tagSuggestions", {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      suggestedTagIds: args.suggestedTagIds,
      note: args.note,
      confidence: args.confidence,
      status: "pending",
      model: args.model,
    });
  },
});

export const suggest = action({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.accounts.accountContextForUser, {});
    if (!context) return { error: "No account", code: "no_account" as const };
    const { accountId, role } = context;
    // agent floor (mirror assignTag): supervisor+ and agents may classify.
    if (role === "viewer") return { error: "Forbidden", code: "forbidden" as const };

    const conversation = await ctx.runQuery(internal.aiReply.getConversationForAccount, {
      conversationId: args.conversationId,
      accountId,
    });
    if (!conversation) return { error: "Conversation not found", code: "not_found" as const };

    const config = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
    if (!config || !config.isActive || !config.apiKey) {
      return { error: "AI is not configured", code: "ai_not_configured" as const };
    }

    const catalogue = await ctx.runQuery(internal.aiTagging.loadCatalogue, { accountId });

    const historyRows = await ctx.runQuery(internal.aiReply.recentMessages, {
      conversationId: args.conversationId,
      limit: aiContextMessageLimit(),
    });
    const messages = toChatMessages(historyRows);
    const systemPrompt = buildClassifyPrompt(catalogue);

    let raw: string;
    let usage = null as null | { promptTokens: number; completionTokens: number; totalTokens: number };
    if (isDryRun()) {
      raw = syntheticClassifyRaw(catalogue);
    } else {
      const gen = await generateReply({
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        systemPrompt,
        messages,
      });
      raw = gen.text;
      usage = gen.usage;
    }

    const parsed = parseClassification(raw, catalogue);

    if (usage) {
      await ctx.runMutation(internal.aiUsage.log, {
        accountId,
        conversationId: args.conversationId,
        mode: "classify",
        provider: config.provider,
        model: config.model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      });
    }

    const suggestionId = await ctx.runMutation(internal.aiTagging.recordSuggestion, {
      accountId,
      conversationId: args.conversationId,
      contactId: conversation.contactId,
      suggestedTagIds: parsed.tagIds as unknown as import("./_generated/dataModel").Id<"tags">[],
      note: parsed.note,
      confidence: parsed.confidence,
      model: config.model,
    });

    return { suggestionId, tagIds: parsed.tagIds, note: parsed.note, confidence: parsed.confidence };
  },
});
```

*(Confirm the exact arg name/shape of `internal.accounts.accountContextForUser` and `internal.aiReply.getConversationForAccount`/`recentMessages` against `convex/aiReply.ts`'s `draft` action while implementing — this action deliberately mirrors it. If `recentMessages` takes a different limit arg name, match it.)*

- [ ] **Step 4: Register `aiTagging` in `convex/_generated/api.d.ts`** — import (alphabetical, after `aiReply`) + `fullApi` member:
```ts
import type * as aiTagging from "../aiTagging.js";
```
```ts
  aiTagging: typeof aiTagging;
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx vitest run convex/aiTagging.test.ts && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 6: Commit**

```bash
git add convex/aiTagging.ts convex/aiTagging.test.ts convex/_generated/api.d.ts
git commit -m "feat(ai-tagging): loadCatalogue + suggest action (dry-run classify → pending suggestion)"
```

---

## Task 5: Backend — accept / dismiss mutations

**Files:**
- Modify: `convex/aiTagging.ts`
- Test: `convex/aiTagging.test.ts`

**Interfaces:**
- Consumes: `contacts.assignTag`-equivalent apply (call the same internal path used by the Phase-1 `assignTag` handler, or re-implement the insert with `source:"ai"` + single-select displacement); `contactNotes.add`.
- Produces:
  - `aiTagging.acceptSuggestion({suggestionId})` (`accountMutation`, agent) — applies the suggestion's `suggestedTagIds` to the contact with `source:"ai"` (respecting single-select displacement), adds the `note` (if any) via `contactNotes`, sets the suggestion `status:"accepted"` + `reviewedByUserId`. Cross-account → `NOT_FOUND`.
  - `aiTagging.dismissSuggestion({suggestionId})` (`accountMutation`, agent) — sets `status:"dismissed"` + `reviewedByUserId`. No data change.

- [ ] **Step 1: Write the failing tests** — append to `convex/aiTagging.test.ts`:

```ts
test("acceptSuggestion applies tags with source ai + adds the note", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMemberWithAi(t, { role: "agent" });
  const { contactId, tagId, suggestionId, conversationId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+15550010", phoneNormalized: "15550010" });
    const conversationId = await ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 });
    const tagId = await ctx.db.insert("tags", { accountId, name: "UAE Visa", color: "#3b82f6" });
    const suggestionId = await ctx.db.insert("tagSuggestions", {
      accountId, conversationId, contactId, suggestedTagIds: [tagId],
      note: "Wants UAE visa", confidence: "high", status: "pending", model: "m",
    });
    return { contactId, tagId, suggestionId, conversationId };
  });

  await asUser.mutation(api.aiTagging.acceptSuggestion, { suggestionId });

  const links = await t.run((ctx) =>
    ctx.db.query("contactTags").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect());
  expect(links.map((l) => l.tagId)).toEqual([tagId]);
  expect(links[0].source).toBe("ai");
  const notes = await t.run((ctx) =>
    ctx.db.query("contactNotes").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect());
  expect(notes.some((n) => n.noteText.includes("UAE visa"))).toBe(true);
  const sug = await t.run((ctx) => ctx.db.get(suggestionId));
  expect(sug!.status).toBe("accepted");
});

test("dismissSuggestion marks dismissed with no tag applied", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMemberWithAi(t, { role: "agent" });
  const { contactId, suggestionId } = await t.run(async (ctx) => {
    const contactId = await ctx.db.insert("contacts", { accountId, phone: "+15550011", phoneNormalized: "15550011" });
    const conversationId = await ctx.db.insert("conversations", { accountId, contactId, status: "open", unreadCount: 0 });
    const tagId = await ctx.db.insert("tags", { accountId, name: "Packages", color: "#f59e0b" });
    const suggestionId = await ctx.db.insert("tagSuggestions", {
      accountId, conversationId, contactId, suggestedTagIds: [tagId], confidence: "low", status: "pending", model: "m" });
    return { contactId, suggestionId };
  });

  await asUser.mutation(api.aiTagging.dismissSuggestion, { suggestionId });

  const links = await t.run((ctx) =>
    ctx.db.query("contactTags").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect());
  expect(links).toHaveLength(0);
  const sug = await t.run((ctx) => ctx.db.get(suggestionId));
  expect(sug!.status).toBe("dismissed");
});
```

*(`contactNotes` schema: `{ accountId, contactId, createdByUserId?, noteText }`, index `by_contact` on `["contactId"]` — confirmed. The note text column is `noteText`.)*

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run convex/aiTagging.test.ts -t "Suggestion"`
Expected: FAIL — `acceptSuggestion`/`dismissSuggestion` undefined.

- [ ] **Step 3: Add the mutations to `convex/aiTagging.ts`** (import `accountMutation` from `./lib/auth`, `ConvexError` from `convex/values`):

```ts
import { accountMutation } from "./lib/auth";
import { ConvexError } from "convex/values";

async function requireOwnSuggestion(ctx: any, suggestionId: any) {
  const sug = await ctx.db.get(suggestionId);
  if (!sug || sug.accountId !== ctx.accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "tagSuggestion" });
  }
  return sug;
}

export const acceptSuggestion = accountMutation({
  args: { suggestionId: v.id("tagSuggestions") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    const sug = await requireOwnSuggestion(ctx, args.suggestionId);

    for (const tagId of sug.suggestedTagIds) {
      const tag = await ctx.db.get(tagId);
      if (!tag || tag.accountId !== ctx.accountId) continue; // tag deleted since — skip
      // single-select displacement (mirror contacts.assignTag Task 4)
      if (tag.groupId) {
        const group = await ctx.db.get(tag.groupId);
        if (group?.selectionMode === "single") {
          const links = await ctx.db
            .query("contactTags")
            .withIndex("by_contact", (q) => q.eq("contactId", sug.contactId))
            .collect();
          for (const link of links) {
            if (link.tagId === tagId) continue;
            const other = await ctx.db.get(link.tagId);
            if (other?.groupId === tag.groupId) await ctx.db.delete(link._id);
          }
        }
      }
      const existing = await ctx.db
        .query("contactTags")
        .withIndex("by_contact_tag", (q) => q.eq("contactId", sug.contactId).eq("tagId", tagId))
        .first();
      if (existing) {
        if (existing.source === undefined) await ctx.db.patch(existing._id, { source: "ai" });
      } else {
        await ctx.db.insert("contactTags", {
          accountId: ctx.accountId,
          contactId: sug.contactId,
          tagId,
          source: "ai",
        });
      }
    }

    if (sug.note) {
      await ctx.db.insert("contactNotes", {
        accountId: ctx.accountId,
        contactId: sug.contactId,
        noteText: sug.note, // contactNotes stores note text as `noteText` (see contactNotes.add)
        createdByUserId: ctx.userId,
      });
    }

    await ctx.db.patch(args.suggestionId, { status: "accepted", reviewedByUserId: ctx.userId });
  },
});

export const dismissSuggestion = accountMutation({
  args: { suggestionId: v.id("tagSuggestions") },
  handler: async (ctx, args) => {
    ctx.requireRole("agent");
    await requireOwnSuggestion(ctx, args.suggestionId);
    await ctx.db.patch(args.suggestionId, { status: "dismissed", reviewedByUserId: ctx.userId });
  },
});
```

**Implementer note:** the note insert mirrors `contactNotes.add`, which stores its `body` arg as the `noteText` column — a direct `ctx.db.insert("contactNotes", { accountId, contactId, noteText, createdByUserId })` is correct here since `acceptSuggestion` is already an `accountMutation`.

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run convex/aiTagging.test.ts`
Expected: PASS (suggest + accept + dismiss).

- [ ] **Step 5: Commit**

```bash
git add convex/aiTagging.ts convex/aiTagging.test.ts
git commit -m "feat(ai-tagging): accept/dismiss suggestion mutations (accept applies source:ai + note)"
```

---

## Task 6: Frontend — types, adapter, and the suggestion banner

**Files:**
- Modify: `src/types/index.ts` (add `TagSuggestion`)
- Modify: `src/lib/convex/adapters.ts` (add `toUiTagSuggestion`)
- Create: `src/components/inbox/tag-suggestion-banner.tsx`
- Modify: `src/components/inbox/contact-sidebar.tsx` (render the banner above Labels)
- Modify: `messages/en.json` (`Inbox.tagSuggestions.*`)
- Test: `src/lib/convex/adapters` covered indirectly; no new pure logic — verify via tsc/eslint (UI task).

**Interfaces:**
- Consumes: `api.aiTagging.suggest` (action), `api.aiTagging.acceptSuggestion`/`dismissSuggestion` (mutations), a pending-suggestion query (add `aiTagging.pendingForConversation` — see Step 1), `toUiTag`/`toUiTagSuggestion`.
- Produces: `<TagSuggestionBanner contactId conversationId />` — shows a "Suggest tags" button when there's no pending suggestion; when one exists, shows the proposed tag chips + note with **Accept / Dismiss**.

- [ ] **Step 1: Add a pending-suggestion query** — in `convex/aiTagging.ts` add (and it needs no new api.d.ts line — `aiTagging` is already registered):

```ts
import { accountQuery } from "./lib/auth";

export const pendingForConversation = accountQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("tagSuggestions")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .collect();
    return rows.find((r) => r.accountId === ctx.accountId && r.status === "pending") ?? null;
  },
});
```

Add a quick test to `convex/aiTagging.test.ts` (pending row returned; non-pending → null) and commit this backend bit first:
```bash
git add convex/aiTagging.ts convex/aiTagging.test.ts
git commit -m "feat(ai-tagging): pendingForConversation query"
```

- [ ] **Step 2: Types + adapter** — in `src/types/index.ts`:
```ts
export interface TagSuggestion {
  id: string;
  conversation_id: string;
  contact_id: string;
  suggested_tag_ids: string[];
  note?: string;
  confidence: 'high' | 'medium' | 'low';
  status: 'auto_applied' | 'pending' | 'accepted' | 'dismissed';
}
```
In `src/lib/convex/adapters.ts` add `toUiTagSuggestion(doc: Doc<"tagSuggestions">): TagSuggestion` mapping `_id`→`id`, `conversationId`→`conversation_id`, `contactId`→`contact_id`, `suggestedTagIds`→`suggested_tag_ids`, and passthrough `note`/`confidence`/`status`. Import `TagSuggestion` from `@/types`.

- [ ] **Step 3: Create `src/components/inbox/tag-suggestion-banner.tsx`**

```tsx
'use client';

import { useMemo, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { Sparkles, Check, X, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { toUiTag, toUiTagSuggestion } from '@/lib/convex/adapters';
import { Button } from '@/components/ui/button';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

export function TagSuggestionBanner({
  contactId, conversationId,
}: { contactId: string; conversationId: string }) {
  const t = useTranslations('Inbox.tagSuggestions');
  const pendingRes = useQuery(api.aiTagging.pendingForConversation, {
    conversationId: conversationId as Id<'conversations'>,
  });
  const allTagsRes = useQuery(api.tags.list);
  const suggest = useAction(api.aiTagging.suggest);
  const accept = useMutation(api.aiTagging.acceptSuggestion);
  const dismiss = useMutation(api.aiTagging.dismissSuggestion);

  const [busy, setBusy] = useState(false);
  const suggestion = pendingRes ? toUiTagSuggestion(pendingRes) : null;
  const tagsById = useMemo(() => {
    const m = new Map<string, { name: string; color: string }>();
    for (const doc of allTagsRes ?? []) { const t = toUiTag(doc); m.set(t.id, { name: t.name, color: t.color }); }
    return m;
  }, [allTagsRes]);

  async function runSuggest() {
    setBusy(true);
    try {
      const res = await suggest({ conversationId: conversationId as Id<'conversations'> });
      if (res && 'error' in res && res.error) toast.error(t(`error_${res.code}` as never, { fallback: t('errorGeneric') } as never));
    } catch { toast.error(t('errorGeneric')); }
    finally { setBusy(false); }
  }

  if (suggestion) {
    return (
      <div className="mb-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-primary">
          <Sparkles className="size-3.5" /> {t('title')}
        </div>
        <div className="mb-2 flex flex-wrap gap-1">
          {suggestion.suggested_tag_ids.map((id) => {
            const tag = tagsById.get(id);
            return tag ? (
              <span key={id} className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${tag.color}20`, color: tag.color }}>{tag.name}</span>
            ) : null;
          })}
        </div>
        {suggestion.note && <p className="mb-2 text-xs text-muted-foreground">{suggestion.note}</p>}
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy}
            onClick={async () => { setBusy(true); try { await accept({ suggestionId: pendingRes!._id }); toast.success(t('accepted')); } catch { toast.error(t('errorGeneric')); } finally { setBusy(false); } }}>
            <Check className="size-3.5" /> {t('accept')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy}
            onClick={async () => { setBusy(true); try { await dismiss({ suggestionId: pendingRes!._id }); } catch { toast.error(t('errorGeneric')); } finally { setBusy(false); } }}>
            <X className="size-3.5" /> {t('dismiss')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <button type="button" onClick={runSuggest} disabled={busy}
      className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} {t('suggestCta')}
    </button>
  );
}
```

- [ ] **Step 4: i18n** — add to `messages/en.json` inside `Inbox`:
```json
"tagSuggestions": {
  "title": "AI suggestion",
  "suggestCta": "Suggest tags",
  "accept": "Accept",
  "dismiss": "Dismiss",
  "accepted": "Labels applied",
  "errorGeneric": "Couldn’t get a suggestion",
  "error_ai_not_configured": "Set up the AI assistant in Settings first",
  "error_forbidden": "You don’t have access",
  "error_not_found": "Conversation not found",
  "error_no_account": "No account"
}
```
*(If `useTranslations`' `t(key, {fallback})` signature isn't supported in this next-intl version, replace the dynamic `t(\`error_${code}\`)` with a small switch mapping known codes to keys, defaulting to `errorGeneric` — check `node_modules/next-intl` usage elsewhere in the repo.)*

- [ ] **Step 5: Wire into `contact-sidebar.tsx`** — render the banner just above the Labels section (added in the Phase-1 label-picker task). Add `import { TagSuggestionBanner } from "./tag-suggestion-banner";` and:
```tsx
<TagSuggestionBanner contactId={contact.id} conversationId={conversationId} />
```
`conversationId` is already a prop of `ContactSidebar` (`{ contact, conversationId }`).

- [ ] **Step 6: Verify**

Run: `npx tsc --noEmit && npx eslint src/components/inbox/tag-suggestion-banner.tsx src/components/inbox/contact-sidebar.tsx src/lib/convex/adapters.ts && node -e "JSON.parse(require('fs').readFileSync('messages/en.json','utf8'));console.log('json ok')"`
Expected: 0 errors, `json ok`. (Interactive browser check is auth-gated + needs Phase 1 + an AI key deployed — note it, don't block.)

- [ ] **Step 7: Commit**

```bash
git add src/types/index.ts src/lib/convex/adapters.ts src/components/inbox/tag-suggestion-banner.tsx src/components/inbox/contact-sidebar.tsx messages/en.json
git commit -m "feat(ai-tagging): inbox suggestion banner (Suggest tags → Accept/Dismiss)"
```

---

## Task 7: Full-suite verification + wrap

- [ ] **Step 1:** `npx vitest run convex/ && npx vitest run src/` — all green (existing + new).
- [ ] **Step 2:** `npx tsc --noEmit && npx next build` — 0 type errors, build succeeds.
- [ ] **Step 3:** Append a "Phase 1 (AI tagging) — deploy note" to the spec (`docs/superpowers/specs/2026-07-16-ai-tag-suggestions-design.md`): ships only after the grouped-tags Phase 1 is deployed; needs `convex deploy` (new `tagSuggestions` table + `contactTags.source` + `aiUsageLog` union) + Netlify; requires an active `aiConfigs` (BYO key) to actually classify. Commit the doc.
- [ ] **Step 4:** Invoke `superpowers:finishing-a-development-branch`. Do NOT auto-merge/deploy — the owner controls it, and this stacks on the unmerged grouped-tags branch.

---

## Self-review notes (author)

- **Spec refinement (flag for review):** the spec's `tagSuggestions.productTagId`/`destinationTagIds` are replaced by a group-generic `suggestedTagIds: Id<"tags">[]` — same information, but correct for arbitrary user-defined groups (not just two hardcoded dimensions). The prompt + banner still present tags grouped. If you'd rather keep the two-field shape, say so and I'll revert.
- **Deferred to P2/P3 (by design, not gaps):** confidence auto-apply (`status:"auto_applied"` exists in the schema but P1 only writes `pending`), the `contactTags.source` "AI dot" marker in the label chips, the pending-suggestions inbox filter, the backfill job, and the ongoing first-inbound trigger.
- **Implementer verification points (call-outs already in the tasks):** exact arg names of `accountContextForUser`/`getConversationForAccount`/`recentMessages` (Task 4 mirrors `aiReply.draft` — confirm against it); the `aiReply.test.ts` AI-seeding helper's real name (Task 4 test); the next-intl `t(key,{fallback})` support (Task 6). (`contactNotes.noteText` is already confirmed.)
- **Type consistency:** Convex `suggestedTagIds`/`confidence`/`status` ↔ UI `suggested_tag_ids`/`confidence`/`status`; `contactTags.source` "ai"|"manual"; `aiUsageLog.mode` adds "classify". `suggest` returns `{suggestionId,...}` or `{error,code}` (mirrors `draft`).
- **Dry-run:** every test runs under `CONVEX_AI_DRY_RUN`; `suggest` never calls `generateReply` in dry-run (synthetic JSON from the catalogue), so no network + deterministic.
