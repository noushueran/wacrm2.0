# Knowledge Engine v2 — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the entity-first knowledge backbone — services registry, typed entries, structured ops blocks, publish-time compiler with lint + sentinel back-compat, compiled-chunk retrieval merge, and a legacy-doc importer — shipping dormant with zero behavior change for existing engines.

**Architecture:** Structured knowledge (kbServices / kbEntries / kbOpsBlocks) is the new source of truth. A publish-time compiler validates (lint), renders ops blocks into the exact legacy sentinel text formats, chunks entries section-aware, optionally embeds, and writes metadata-stamped rows into a new `kbChunks` table. `aiKnowledge.retrieve` merges compiled chunks (ranked first) with legacy `aiKnowledgeChunks`, keeping its signature and default behavior byte-compatible. An importer parses the account's existing pasted docs into draft rows for review. No UI, no engine changes — those are Phases 2–4.

**Tech Stack:** Convex (self-hosted, ONE live prod deployment), TypeScript, vitest + convex-test (offline), OpenAI embeddings (1536-dim, optional per account).

## Global Constraints

- **NEVER run `npx convex dev`, `npx convex deploy`, or `npx convex codegen`** — all three push the single live prod backend (see memory `convex-codegen-pushes-prod`). Build offline; register new convex modules by hand-editing `convex/_generated/api.d.ts` (import line + record entry, mirroring line 15 / line 125 pattern for `aiKnowledge`).
- Schema changes are **additive only** (new tables, new optional args). Never modify existing tables or indexes.
- **Do not modify these files** — engine cutover is Phase 3, and Phase 1 must ship with provably zero behavior change: `convex/qualificationEngine.ts`, `convex/salesChecklists.ts`, `src/components/settings/qualification-settings.tsx`, `src/components/leads/leads-board-view.tsx`, `src/app/(dashboard)/leads/page.tsx`, and any prompt in `src/lib/ai/defaults.ts`. (`feat/purchase-signals` merged as PR #38 and is now in `origin/main`, so this is no longer a conflict risk — it is a scope boundary. Task 10's empty-diff check enforces it.)
- **Verification commands are the repo's npm scripts**, run from the app root: `npm test` (vitest run), `npm run typecheck` (tsc --noEmit), `npm run build` (next build), `npm run lint` (eslint). Single test file: `npx vitest run <path>`.
- **Lint has PRE-EXISTING debt** (~7 errors / ~87 warnings, mostly vendored files). The gate is **"this diff adds no NEW lint findings"**, NOT a globally clean `eslint`. Capture a baseline count before Task 1 and compare at Task 10 — do not attempt to fix unrelated pre-existing findings.
- **Stage files explicitly by path. NEVER `git add -A` or `git add .`** — sibling worktree directories under `.claude/` are untracked-but-not-ignored and would be swept into the commit.
- Single-locale repo: user-facing strings live in `messages/en.json` only. (Phase 1 adds no UI, so no i18n work.)
- Baseline test suite at branch point: ~1900 tests. Every task must leave the full suite green.
- Sentinel render output must contain these exact headings (em dash U+2014, one space each side): `QUALIFICATION CHECKLIST — <Service Name>`, `SALES CHECKLIST — <Service Name>`, `PURCHASE CRITERIA — <Service Name>`. Engines find them by fuzzy text search today; a changed heading silently breaks qualification.
- `aiKnowledge.retrieve` must stay **byte-compatible by default**: same args accepted, same `string[]` return, identical results for an account with no `kb*` rows and no `audience` arg.
- `convex/` files use double quotes; `src/` uses single quotes. Tests colocate: `convex/<module>.test.ts` and `convex/lib/<area>/<file>.test.ts`. Convex tests use `convex-test` with `const modules = import.meta.glob("/convex/**/*.ts");` and `process.env.CONVEX_AI_DRY_RUN = "1"` (see `convex/aiKnowledge.test.ts:1-70` — copy its `seedAccountMember` helper per suite; that duplication is the established pattern).
- Embeddings: `EMBEDDING_DIMENSIONS = 1536` (`convex/lib/ai/embeddings.ts:34`). Dry-run helpers live in `convex/aiKnowledge.ts` (`isDryRun` line 66, `syntheticEmbedding` line 86 — already exported, `syntheticEmbeddings` line 103).
- Branch: `feat/knowledge-engine-v2` in a fresh worktree (superpowers:using-git-worktrees at execution time). Worktrees lack `.env.local` — irrelevant for this offline phase.
- Commit style: `feat(kb): …` / `test(kb): …` / `docs: …`, ending with the Claude co-author trailer used repo-wide.

## Context primer (read once before Task 1)

- Legacy KB: `aiKnowledgeDocuments` (title+content) → `create` schedules `internal.aiKnowledge.ingest` → `chunkText` (`convex/lib/ai/chunk.ts`, paragraph-aware, 1200 chars) → `replaceChunks` (delete-then-insert) into `aiKnowledgeChunks` (search index `search_content` filter `["accountId"]`; vector index `by_embedding` 1536 filter `["accountId"]`).
- `internal.aiKnowledge.retrieve` (`convex/aiKnowledge.ts:389-471`): k=5 default; semantic pass (decrypted embeddings key → embed query → `ctx.vectorSearch` → hydrate via `getChunksByIds`) then lexical top-up (`searchChunks`); best-effort everywhere; returns `Array.from(picked.values()).slice(0, k)`.
- Consumers (do NOT touch in this phase): `convex/aiReply.ts` (auto-reply + drafts), `convex/qualificationEngine.ts:474-483` (queries `QUALIFICATION CHECKLIST <service> <latest>`), `convex/salesChecklists.ts:216` (queries `SALES CHECKLIST <service>`), purchase judge (in-flight branch, queries `PURCHASE CRITERIA <service>`).
- Auth wrappers: `accountQuery` / `accountMutation` from `convex/lib/auth.ts`; role gate via `ctx.requireRole("admin")`; errors via `ConvexError({ code: "BAD_REQUEST" | "NOT_FOUND", ... })`.
- Convex vector-search filters support only `q.eq`/`q.or` on declared `filterFields` — **no `q.and` across fields**. Multi-field AND must be done by over-fetching and post-filtering in code (Task 9 does exactly this). Search indexes DO support chained `.eq()` on multiple filterFields.

---

### Task 1: Schema — four new tables

**Files:**
- Modify: `convex/schema.ts` (append after the `aiKnowledgeChunks` table definition)
- Test: `convex/kbSchema.test.ts` (new smoke suite)

**Interfaces:**
- Consumes: nothing.
- Produces: tables `kbServices`, `kbEntries`, `kbOpsBlocks`, `kbChunks` with the exact validators and index names below. Every later task depends on these names verbatim.

- [ ] **Step 1: Write the failing smoke test**

```ts
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("/convex/**/*.ts");

test("kb tables accept a minimal row each", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: "o", email: "o@x.co" });
    const accountId = await ctx.db.insert("accounts", {
      name: "acct", defaultCurrency: "USD", ownerUserId: userId,
    });
    const now = Date.now();
    await ctx.db.insert("kbServices", {
      accountId, key: "georgia-tours", name: "Georgia Holiday Packages",
      aliases: ["georgia", "tbilisi"], status: "active", sortOrder: 0, updatedAt: now,
    });
    const entryId = await ctx.db.insert("kbEntries", {
      accountId, scope: "service", serviceKey: "georgia-tours", type: "overview",
      title: "Georgia overview", body: "4N/5D packages.", audience: "customer",
      status: "draft", version: 1, updatedAt: now,
    });
    const opsId = await ctx.db.insert("kbOpsBlocks", {
      accountId, serviceKey: "georgia-tours", kind: "qualification",
      criteria: [{ key: "dates", label: "Travel dates", marks: 20 }],
      status: "draft", version: 1, updatedAt: now,
    });
    await ctx.db.insert("kbChunks", {
      accountId, sourceKind: "entry", entryId, serviceKey: "georgia-tours",
      entryType: "overview", audience: "customer", chunkIndex: 0,
      content: "[Georgia Holiday Packages — Georgia overview]\n4N/5D packages.",
    });
    const byKey = await ctx.db.query("kbServices")
      .withIndex("by_account_key", (q) => q.eq("accountId", accountId).eq("key", "georgia-tours"))
      .unique();
    expect(byKey?.name).toBe("Georgia Holiday Packages");
    const ops = await ctx.db.query("kbOpsBlocks")
      .withIndex("by_account_service_kind", (q) =>
        q.eq("accountId", accountId).eq("serviceKey", "georgia-tours").eq("kind", "qualification"))
      .unique();
    expect(ops?._id).toBe(opsId);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/kbSchema.test.ts`
Expected: FAIL — `kbServices` not in schema (validator error).

- [ ] **Step 3: Append the four tables to `convex/schema.ts`**

```ts
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run convex/kbSchema.test.ts convex/schema.test.ts`
Expected: PASS both (if `schema.test.ts` enumerates tables and fails, add the four new table names to its expectation list — that is the only permitted edit there).

- [ ] **Step 5: Commit**

```bash
git add convex/schema.ts convex/kbSchema.test.ts convex/schema.test.ts
git commit -m "feat(kb): knowledge-engine v2 schema — kbServices/kbEntries/kbOpsBlocks/kbChunks"
```

---

### Task 2: Pure lint library

**Files:**
- Create: `convex/lib/kb/types.ts`
- Create: `convex/lib/kb/lint.ts`
- Test: `convex/lib/kb/lint.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `types.ts`: `OpsKind`, `QualCriterion { key; label; question?; marks? }`, `SalesStep { key; label; description? }`, `PurchaseCondition { key; label }`, `OpsBlockInput { kind; criteria?; steps?; conditions?; reportValue?; currency? }`, `LintIssue { level: "error" | "warning"; code: string; message: string }`.
  - `lint.ts`: `lintServiceInput(args: { key: string; name: string; aliases: string[]; existingKeys: string[] }): LintIssue[]`, `lintEntryInput(args: { scope: "company" | "service" | "package"; serviceKey?: string; title: string; body: string; audience: "customer" | "internal" }): LintIssue[]`, `lintOpsBlock(block: OpsBlockInput): LintIssue[]`, `hasLintErrors(issues: LintIssue[]): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest";
import { lintServiceInput, lintEntryInput, lintOpsBlock, hasLintErrors } from "./lint";

describe("lintServiceInput", () => {
  test("accepts a clean slug + unique key", () => {
    expect(lintServiceInput({
      key: "uae-visas", name: "UAE Visa Services", aliases: ["visa"], existingKeys: [],
    })).toEqual([]);
  });
  test("rejects bad slug, duplicate key, blank name, duplicate alias", () => {
    const issues = lintServiceInput({
      key: "UAE Visas!", name: "", aliases: ["visa", "visa", ""],
      existingKeys: ["uae-visas"],
    });
    const codes = issues.map((i) => i.code).sort();
    expect(codes).toEqual(["alias_blank", "alias_duplicate", "key_slug", "name_required"]);
    expect(hasLintErrors(issues)).toBe(true);
  });
  test("flags key collision against existingKeys", () => {
    const issues = lintServiceInput({
      key: "uae-visas", name: "UAE Visa Services", aliases: [], existingKeys: ["uae-visas"],
    });
    expect(issues.map((i) => i.code)).toEqual(["key_taken"]);
  });
});

describe("lintEntryInput", () => {
  test("service scope requires serviceKey", () => {
    const issues = lintEntryInput({
      scope: "service", title: "t", body: "b", audience: "customer",
    });
    expect(issues.map((i) => i.code)).toEqual(["service_key_required"]);
  });
  test("customer-safe price mention is a warning, not an error", () => {
    const issues = lintEntryInput({
      scope: "company", title: "Rates", body: "Package price AED 3000 per person",
      audience: "customer",
    });
    expect(issues).toEqual([
      expect.objectContaining({ level: "warning", code: "price_mention" }),
    ]);
    expect(hasLintErrors(issues)).toBe(false);
  });
  test("internal entries may mention prices freely", () => {
    expect(lintEntryInput({
      scope: "company", title: "Thresholds", body: "budget >= AED 3000",
      audience: "internal",
    })).toEqual([]);
  });
});

describe("lintOpsBlock", () => {
  test("qualification marks must sum to exactly 100", () => {
    const issues = lintOpsBlock({
      kind: "qualification",
      criteria: [
        { key: "dates", label: "Travel dates", marks: 50 },
        { key: "budget", label: "Budget", marks: 40 },
      ],
    });
    expect(issues.map((i) => i.code)).toEqual(["marks_sum"]);
  });
  test("clean qualification block passes", () => {
    expect(lintOpsBlock({
      kind: "qualification",
      criteria: [
        { key: "dates", label: "Travel dates", marks: 60 },
        { key: "email", label: "Email address", marks: 40 },
      ],
    })).toEqual([]);
  });
  test("duplicate criterion keys + empty list are errors", () => {
    expect(lintOpsBlock({ kind: "qualification", criteria: [] })
      .map((i) => i.code)).toEqual(["items_required"]);
    expect(lintOpsBlock({
      kind: "sales",
      steps: [{ key: "call", label: "Call" }, { key: "call", label: "Call again" }],
    }).map((i) => i.code)).toEqual(["key_duplicate"]);
  });
  test("purchase block validates reportValue and currency", () => {
    expect(lintOpsBlock({
      kind: "purchase",
      conditions: [{ key: "budget", label: "Budget >= AED 3000/person" }],
      reportValue: -5, currency: "dirham",
    }).map((i) => i.code).sort()).toEqual(["currency_format", "report_value_positive"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/lib/kb/lint.test.ts`
Expected: FAIL — cannot resolve `./lint`.

- [ ] **Step 3: Implement `types.ts` then `lint.ts`**

```ts
// convex/lib/kb/types.ts
export type OpsKind = "qualification" | "sales" | "purchase";
export type QualCriterion = { key: string; label: string; question?: string; marks?: number };
export type SalesStep = { key: string; label: string; description?: string };
export type PurchaseCondition = { key: string; label: string };
export type OpsBlockInput = {
  kind: OpsKind;
  criteria?: QualCriterion[];
  steps?: SalesStep[];
  conditions?: PurchaseCondition[];
  reportValue?: number;
  currency?: string;
};
export type LintIssue = { level: "error" | "warning"; code: string; message: string };
```

```ts
// convex/lib/kb/lint.ts
import type { LintIssue, OpsBlockInput } from "./types";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
// Customer-safe copy must not quote prices (owner policy: humans handle
// cost). Warning-level: legit mentions ("no hidden fees") exist.
const PRICE_RE = /\b(?:AED|USD|EUR|price[sd]?|fees?|cost[s]?)\b/i;

const err = (code: string, message: string): LintIssue => ({ level: "error", code, message });
const warn = (code: string, message: string): LintIssue => ({ level: "warning", code, message });

export function hasLintErrors(issues: LintIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}

export function lintServiceInput(args: {
  key: string;
  name: string;
  aliases: string[];
  existingKeys: string[];
}): LintIssue[] {
  const issues: LintIssue[] = [];
  if (!SLUG_RE.test(args.key)) {
    issues.push(err("key_slug", "Key must be a lowercase-hyphen slug, e.g. \"uae-visas\"."));
  } else if (args.existingKeys.includes(args.key)) {
    issues.push(err("key_taken", `A service with key "${args.key}" already exists.`));
  }
  if (!args.name.trim()) issues.push(err("name_required", "Display name is required."));
  const seen = new Set<string>();
  let blankFlagged = false;
  let dupFlagged = false;
  for (const alias of args.aliases) {
    const norm = alias.trim().toLowerCase();
    if (!norm) {
      if (!blankFlagged) issues.push(err("alias_blank", "Aliases cannot be blank."));
      blankFlagged = true;
      continue;
    }
    if (seen.has(norm)) {
      if (!dupFlagged) issues.push(err("alias_duplicate", `Alias "${alias}" is repeated.`));
      dupFlagged = true;
    }
    seen.add(norm);
  }
  return issues;
}

export function lintEntryInput(args: {
  scope: "company" | "service" | "package";
  serviceKey?: string;
  title: string;
  body: string;
  audience: "customer" | "internal";
}): LintIssue[] {
  const issues: LintIssue[] = [];
  if (args.scope !== "company" && !args.serviceKey) {
    issues.push(err("service_key_required", "Service/package entries need a serviceKey."));
  }
  if (!args.title.trim()) issues.push(err("title_required", "Title is required."));
  if (!args.body.trim()) issues.push(err("body_required", "Body is required."));
  if (args.audience === "customer" && args.body && PRICE_RE.test(args.body)) {
    issues.push(warn("price_mention",
      "Customer-safe text mentions prices/fees — Holidayys policy routes cost talk to a human."));
  }
  return issues;
}

export function lintOpsBlock(block: OpsBlockInput): LintIssue[] {
  const issues: LintIssue[] = [];
  const items =
    block.kind === "qualification" ? (block.criteria ?? [])
    : block.kind === "sales" ? (block.steps ?? [])
    : (block.conditions ?? []);
  if (items.length === 0) {
    issues.push(err("items_required", "At least one item is required."));
    return issues;
  }
  const keys = new Set<string>();
  for (const item of items) {
    if (!item.label.trim()) issues.push(err("label_required", "Every item needs a label."));
    if (keys.has(item.key)) {
      issues.push(err("key_duplicate", `Item key "${item.key}" is repeated.`));
      break;
    }
    keys.add(item.key);
  }
  if (block.kind === "qualification") {
    const marks = (block.criteria ?? []).map((c) => c.marks);
    if (marks.every((m): m is number => typeof m === "number")) {
      const sum = marks.reduce((a, b) => a + b, 0);
      if (sum !== 100) {
        issues.push(err("marks_sum", `Marks must sum to exactly 100 (currently ${sum}).`));
      }
    }
  }
  if (block.kind === "purchase") {
    if (block.reportValue !== undefined && !(block.reportValue > 0)) {
      issues.push(err("report_value_positive", "Report value must be a positive number."));
    }
    if (block.currency !== undefined && !CURRENCY_RE.test(block.currency)) {
      issues.push(err("currency_format", "Currency must be a 3-letter code like AED."));
    }
  }
  return issues;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run convex/lib/kb/lint.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add convex/lib/kb/types.ts convex/lib/kb/lint.ts convex/lib/kb/lint.test.ts
git commit -m "feat(kb): pure lint library for services, entries, and ops blocks"
```

---

### Task 3: Sentinel render + legacy parse library

**Files:**
- Create: `convex/lib/kb/sentinel.ts`
- Test: `convex/lib/kb/sentinel.test.ts`

**Interfaces:**
- Consumes: `OpsBlockInput` from `./types`.
- Produces:
  - `slugify(name: string): string`
  - `renderOpsSentinel(serviceName: string, block: OpsBlockInput): string` — MUST reproduce the Global Constraints heading formats.
  - `parseLegacyDocument(title: string, content: string): ParsedLegacyDoc` where `ParsedLegacySection = { kind: OpsKind; serviceName: string; raw: string }` and `ParsedLegacyDoc = { title: string; prose: string; sections: ParsedLegacySection[] }`.
  - `parseChecklistLines(raw: string): { label: string; marks?: number }[]`
  - `parseReportValue(raw: string): { reportValue?: number; currency?: string }`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest";
import {
  parseChecklistLines, parseLegacyDocument, parseReportValue,
  renderOpsSentinel, slugify,
} from "./sentinel";

test("slugify", () => {
  expect(slugify("UAE Visa Services")).toBe("uae-visa-services");
  expect(slugify("  Flights & Hotel Bookings ")).toBe("flights-hotel-bookings");
});

describe("renderOpsSentinel", () => {
  test("qualification heading + marks lines match the engine format", () => {
    const text = renderOpsSentinel("Dubai Holiday Packages", {
      kind: "qualification",
      criteria: [
        { key: "dates", label: "Travel dates", marks: 60 },
        { key: "email", label: "Email address", marks: 40, question: "Best email?" },
      ],
    });
    expect(text).toBe([
      "QUALIFICATION CHECKLIST — Dubai Holiday Packages",
      "- Travel dates (60 marks)",
      "- Email address (40 marks) — ask: Best email?",
    ].join("\n"));
  });
  test("sales + purchase headings", () => {
    expect(renderOpsSentinel("All Services", {
      kind: "sales",
      steps: [{ key: "call", label: "Call the lead", description: "within 15 minutes" }],
    })).toBe("SALES CHECKLIST — All Services\n- Call the lead: within 15 minutes");
    expect(renderOpsSentinel("Georgia Holiday Packages", {
      kind: "purchase",
      conditions: [{ key: "budget", label: "Budget at least AED 3000 per person" }],
      reportValue: 9000, currency: "AED",
    })).toBe([
      "PURCHASE CRITERIA — Georgia Holiday Packages",
      "- Budget at least AED 3000 per person",
      "Report value: 9000 AED",
    ].join("\n"));
  });
});

describe("parseLegacyDocument", () => {
  const doc = [
    "Dubai city breaks for families and couples.",
    "Best time: October to April.",
    "",
    "QUALIFICATION CHECKLIST — Dubai Holiday Packages",
    "- Travel dates (20 marks)",
    "- Party size (20 marks)",
    "- Budget band (30 marks)",
    "- Email address (30 marks)",
    "",
    "PURCHASE CRITERIA — Dubai Holiday Packages",
    "- Budget confirmed at AED 3000+ per person",
    "Report value: 6000 AED",
  ].join("\n");
  test("splits prose from sentinel sections", () => {
    const parsed = parseLegacyDocument("KB 2 — Dubai packages", doc);
    expect(parsed.prose).toContain("city breaks");
    expect(parsed.prose).not.toContain("QUALIFICATION CHECKLIST");
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]).toMatchObject({
      kind: "qualification", serviceName: "Dubai Holiday Packages",
    });
    expect(parsed.sections[1].kind).toBe("purchase");
    expect(parsed.sections[1].raw).toContain("Report value: 6000 AED");
  });
  test("document with no sections is all prose", () => {
    const parsed = parseLegacyDocument("KB 1", "About the company.\nHours daily.");
    expect(parsed.sections).toEqual([]);
    expect(parsed.prose).toBe("About the company.\nHours daily.");
  });
});

test("parseChecklistLines + parseReportValue", () => {
  expect(parseChecklistLines("- Travel dates (20 marks)\n- Nationality\nnoise")).toEqual([
    { label: "Travel dates", marks: 20 },
    { label: "Nationality" },
  ]);
  expect(parseReportValue("stuff\nReport value: 6000 AED")).toEqual({
    reportValue: 6000, currency: "AED",
  });
  expect(parseReportValue("no value here")).toEqual({});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/lib/kb/sentinel.test.ts`
Expected: FAIL — cannot resolve `./sentinel`.

- [ ] **Step 3: Implement**

```ts
// convex/lib/kb/sentinel.ts
import type { OpsBlockInput, OpsKind } from "./types";

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Exact heading grammar the live engines fuzzy-retrieve by (em dash).
// Also accepts en dash / hyphen when PARSING legacy pastes, but always
// RENDERS the em dash form.
const HEADING_RE = /^(QUALIFICATION CHECKLIST|SALES CHECKLIST|PURCHASE CRITERIA)\s*[—–-]\s*(.+?)\s*$/;

const KIND_BY_HEADING: Record<string, OpsKind> = {
  "QUALIFICATION CHECKLIST": "qualification",
  "SALES CHECKLIST": "sales",
  "PURCHASE CRITERIA": "purchase",
};

export function renderOpsSentinel(serviceName: string, block: OpsBlockInput): string {
  if (block.kind === "qualification") {
    const lines = (block.criteria ?? []).map((c) => {
      const base = c.marks !== undefined ? `- ${c.label} (${c.marks} marks)` : `- ${c.label}`;
      return c.question ? `${base} — ask: ${c.question}` : base;
    });
    return [`QUALIFICATION CHECKLIST — ${serviceName}`, ...lines].join("\n");
  }
  if (block.kind === "sales") {
    const lines = (block.steps ?? []).map((s) =>
      s.description ? `- ${s.label}: ${s.description}` : `- ${s.label}`,
    );
    return [`SALES CHECKLIST — ${serviceName}`, ...lines].join("\n");
  }
  const lines = (block.conditions ?? []).map((c) => `- ${c.label}`);
  const tail =
    block.reportValue !== undefined
      ? [`Report value: ${block.reportValue} ${block.currency ?? "AED"}`]
      : [];
  return [`PURCHASE CRITERIA — ${serviceName}`, ...lines, ...tail].join("\n");
}

export type ParsedLegacySection = { kind: OpsKind; serviceName: string; raw: string };
export type ParsedLegacyDoc = { title: string; prose: string; sections: ParsedLegacySection[] };

export function parseLegacyDocument(title: string, content: string): ParsedLegacyDoc {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const proseLines: string[] = [];
  const sections: ParsedLegacySection[] = [];
  let current: ParsedLegacySection | null = null;
  for (const line of lines) {
    const m = line.match(HEADING_RE);
    if (m) {
      current = { kind: KIND_BY_HEADING[m[1]], serviceName: m[2], raw: "" };
      sections.push(current);
      continue;
    }
    if (current) current.raw += (current.raw ? "\n" : "") + line;
    else proseLines.push(line);
  }
  for (const s of sections) s.raw = s.raw.trim();
  return { title, prose: proseLines.join("\n").trim(), sections };
}

const ITEM_RE = /^-\s*(.+?)(?:\s*\((\d+)\s*marks?\))?\s*$/;
export function parseChecklistLines(raw: string): { label: string; marks?: number }[] {
  const items: { label: string; marks?: number }[] = [];
  for (const line of raw.split("\n")) {
    const m = line.trim().match(ITEM_RE);
    if (!m) continue;
    items.push(m[2] !== undefined ? { label: m[1], marks: Number(m[2]) } : { label: m[1] });
  }
  return items;
}

const REPORT_VALUE_RE = /^Report value:\s*(\d+(?:\.\d+)?)\s*([A-Z]{3})?\s*$/im;
export function parseReportValue(raw: string): { reportValue?: number; currency?: string } {
  const m = raw.match(REPORT_VALUE_RE);
  if (!m) return {};
  return m[2] ? { reportValue: Number(m[1]), currency: m[2] } : { reportValue: Number(m[1]) };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run convex/lib/kb/sentinel.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add convex/lib/kb/sentinel.ts convex/lib/kb/sentinel.test.ts
git commit -m "feat(kb): sentinel render + legacy-document parser"
```

---

### Task 4: Chunk-planning library

**Files:**
- Create: `convex/lib/kb/compilePure.ts`
- Test: `convex/lib/kb/compilePure.test.ts`

**Interfaces:**
- Consumes: `chunkText` from `../ai/chunk`, `renderOpsSentinel` from `./sentinel`, `OpsBlockInput` from `./types`.
- Produces: `ChunkPlan = { chunkIndex: number; content: string }`; `planEntryChunks(args: { serviceName: string | null; title: string; body: string }): ChunkPlan[]`; `planOpsChunks(serviceName: string, block: OpsBlockInput): ChunkPlan[]` (always 0 or 1 chunk — a checklist must never split).

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from "vitest";
import { planEntryChunks, planOpsChunks } from "./compilePure";

test("entry chunks get a grounding header naming service and title", () => {
  const plans = planEntryChunks({
    serviceName: "Georgia Holiday Packages", title: "Visa requirements",
    body: "Passport valid 6 months.\n\nNo visa needed for UAE residents.",
  });
  expect(plans).toHaveLength(1);
  expect(plans[0].content.startsWith(
    "[Georgia Holiday Packages — Visa requirements]\n")).toBe(true);
  expect(plans[0].chunkIndex).toBe(0);
});

test("company-scope entries use the Company header", () => {
  const [plan] = planEntryChunks({ serviceName: null, title: "Office hours", body: "Daily 10-21." });
  expect(plan.content).toBe("[Company — Office hours]\nDaily 10-21.");
});

test("long bodies split into multiple chunks, each with the header", () => {
  const para = "A".repeat(900);
  const plans = planEntryChunks({
    serviceName: null, title: "Long", body: `${para}\n\n${para}\n\n${para}`,
  });
  expect(plans.length).toBeGreaterThan(1);
  for (const [i, p] of plans.entries()) {
    expect(p.chunkIndex).toBe(i);
    expect(p.content.startsWith("[Company — Long]\n")).toBe(true);
  }
});

test("ops blocks compile to exactly one sentinel chunk, never split", () => {
  const plans = planOpsChunks("UAE Visa Services", {
    kind: "qualification",
    criteria: Array.from({ length: 40 }, (_, i) => ({
      key: `c${i}`, label: `Criterion number ${i} with a fairly long label`, marks: undefined,
    })),
  });
  expect(plans).toHaveLength(1);
  expect(plans[0].content).toContain("QUALIFICATION CHECKLIST — UAE Visa Services");
});

test("empty body/ops produce no chunks", () => {
  expect(planEntryChunks({ serviceName: null, title: "x", body: "   " })).toEqual([]);
  expect(planOpsChunks("X", { kind: "sales", steps: [] })).toEqual([
    { chunkIndex: 0, content: "SALES CHECKLIST — X" },
  ]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/lib/kb/compilePure.test.ts`
Expected: FAIL — cannot resolve `./compilePure`.

- [ ] **Step 3: Implement**

```ts
// convex/lib/kb/compilePure.ts
import { chunkText } from "../ai/chunk";
import { renderOpsSentinel } from "./sentinel";
import type { OpsBlockInput } from "./types";

export type ChunkPlan = { chunkIndex: number; content: string };

/**
 * Entry body → header-prefixed chunks. The bracket header names the
 * service and entry so a retrieved excerpt self-identifies inside the
 * prompt ("[Georgia Holiday Packages — Visa requirements]").
 */
export function planEntryChunks(args: {
  serviceName: string | null;
  title: string;
  body: string;
}): ChunkPlan[] {
  const header = `[${args.serviceName ?? "Company"} — ${args.title}]`;
  return chunkText(args.body).map((content, i) => ({
    chunkIndex: i,
    content: `${header}\n${content}`,
  }));
}

/**
 * Ops block → ONE sentinel chunk. Checklists and criteria must reach
 * the engines whole; chunk-splitting a checklist is the exact failure
 * mode v2 exists to kill. (An empty-items block still renders its
 * heading — publish-time lint blocks that case for real accounts.)
 */
export function planOpsChunks(serviceName: string, block: OpsBlockInput): ChunkPlan[] {
  const content = renderOpsSentinel(serviceName, block).trim();
  return content ? [{ chunkIndex: 0, content }] : [];
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run convex/lib/kb/compilePure.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add convex/lib/kb/compilePure.ts convex/lib/kb/compilePure.test.ts
git commit -m "feat(kb): chunk planning — header-prefixed entry chunks, unsplit ops chunks"
```

---

### Task 5: `kbServices` CRUD module

**Files:**
- Create: `convex/kbServices.ts`
- Modify: `convex/_generated/api.d.ts` (hand-add `import type * as kbServices from "../kbServices.js";` beside the `aiKnowledge` import, and `kbServices: typeof kbServices;` in the record — keep alphabetical order)
- Test: `convex/kbServices.test.ts`

**Interfaces:**
- Consumes: `accountQuery`/`accountMutation` (`convex/lib/auth.ts`), `lintServiceInput`/`hasLintErrors`.
- Produces:
  - `api.kbServices.list` — `accountQuery({})` → services sorted by `sortOrder`, any member.
  - `api.kbServices.upsert` — admin. Args `{ key, name, aliases, routingTagName?, relatedServiceKeys?, status?, sortOrder? }`. Creates when `key` is new; patches when it exists (key itself immutable — it IS the identity). Lint errors → `ConvexError({ code: "BAD_REQUEST", issues })`.
  - `api.kbServices.remove` — admin. Refuses with `ConvexError({ code: "BAD_REQUEST", reason: "service_in_use" })` while any `kbEntries` or `kbOpsBlocks` row references the key.

- [ ] **Step 1: Write the failing tests** (copy `seedAccountMember` + the `modules` glob + DRY-RUN `beforeEach/afterEach` verbatim from `convex/aiKnowledge.test.ts:16-70`)

```ts
test("admin creates, edits, lists; key is immutable identity", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, {
    key: "uae-visas", name: "UAE Visa Services", aliases: ["visa"],
  });
  await asUser.mutation(api.kbServices.upsert, {
    key: "uae-visas", name: "UAE Visas", aliases: ["visa", "tourist visa"],
  });
  const rows = await asUser.query(api.kbServices.list, {});
  expect(rows).toHaveLength(1);
  expect(rows[0].name).toBe("UAE Visas");
  expect(rows[0].aliases).toEqual(["visa", "tourist visa"]);
});

test("lint errors reject the write", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await expect(
    asUser.mutation(api.kbServices.upsert, { key: "Bad Key!", name: "", aliases: [] }),
  ).rejects.toThrow(/BAD_REQUEST/);
});

test("agent role cannot upsert; other account cannot see rows", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "x", name: "X", aliases: [] });
  const { asUser: asAgent } = await seedAccountMember(t, { name: "B", email: "b@x.co", role: "agent" });
  await expect(
    asAgent.mutation(api.kbServices.upsert, { key: "y", name: "Y", aliases: [] }),
  ).rejects.toThrow();
  expect(await asAgent.query(api.kbServices.list, {})).toEqual([]);
});

test("remove refuses while entries reference the service", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "x", name: "X", aliases: [] });
  await t.run(async (ctx) => {
    await ctx.db.insert("kbEntries", {
      accountId, scope: "service", serviceKey: "x", type: "overview",
      title: "t", body: "b", audience: "customer", status: "draft",
      version: 1, updatedAt: Date.now(),
    });
  });
  await expect(asUser.mutation(api.kbServices.remove, { key: "x" }))
    .rejects.toThrow(/service_in_use/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run convex/kbServices.test.ts`
Expected: FAIL — `api.kbServices` undefined.

- [ ] **Step 3: Implement `convex/kbServices.ts`**

```ts
import { accountMutation, accountQuery } from "./lib/auth";
import { v, ConvexError } from "convex/values";
import { hasLintErrors, lintServiceInput } from "./lib/kb/lint";

export const list = accountQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("kbServices")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    return rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  },
});

export const upsert = accountMutation({
  args: {
    key: v.string(),
    name: v.string(),
    aliases: v.array(v.string()),
    routingTagName: v.optional(v.string()),
    relatedServiceKeys: v.optional(v.array(v.string())),
    status: v.optional(v.union(v.literal("active"), v.literal("paused"))),
    sortOrder: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const existing = await ctx.db
      .query("kbServices")
      .withIndex("by_account_key", (q) => q.eq("accountId", ctx.accountId).eq("key", args.key))
      .unique();
    const siblings = await ctx.db
      .query("kbServices")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
    const issues = lintServiceInput({
      key: args.key,
      name: args.name,
      aliases: args.aliases,
      existingKeys: existing ? [] : siblings.map((s) => s.key),
    });
    if (hasLintErrors(issues)) throw new ConvexError({ code: "BAD_REQUEST", issues });
    const fields = {
      name: args.name,
      aliases: args.aliases,
      routingTagName: args.routingTagName,
      relatedServiceKeys: args.relatedServiceKeys,
      status: args.status ?? ("active" as const),
      sortOrder: args.sortOrder ?? existing?.sortOrder ?? siblings.length,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("kbServices", {
      accountId: ctx.accountId,
      key: args.key,
      createdByUserId: ctx.userId,
      ...fields,
    });
  },
});

export const remove = accountMutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const row = await ctx.db
      .query("kbServices")
      .withIndex("by_account_key", (q) => q.eq("accountId", ctx.accountId).eq("key", args.key))
      .unique();
    if (!row) throw new ConvexError({ code: "NOT_FOUND", entity: "service" });
    const entry = await ctx.db
      .query("kbEntries")
      .withIndex("by_account_service", (q) =>
        q.eq("accountId", ctx.accountId).eq("serviceKey", args.key))
      .first();
    const ops = await ctx.db
      .query("kbOpsBlocks")
      .withIndex("by_account_service_kind", (q) =>
        q.eq("accountId", ctx.accountId).eq("serviceKey", args.key))
      .first();
    if (entry || ops) throw new ConvexError({ code: "BAD_REQUEST", reason: "service_in_use" });
    await ctx.db.delete(row._id);
  },
});
```

- [ ] **Step 4: Hand-edit `convex/_generated/api.d.ts`** (import + record entry for `kbServices`), then run tests

Run: `npx vitest run convex/kbServices.test.ts && npx tsc --noEmit`
Expected: PASS (4 tests), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add convex/kbServices.ts convex/kbServices.test.ts convex/_generated/api.d.ts
git commit -m "feat(kb): kbServices registry CRUD (admin-gated, lint-guarded)"
```

---

### Task 6: `kbEntries` CRUD + publish lifecycle

**Files:**
- Create: `convex/kbEntries.ts`
- Modify: `convex/_generated/api.d.ts` (add `kbEntries`)
- Test: `convex/kbEntries.test.ts`

**Interfaces:**
- Consumes: auth wrappers, `lintEntryInput`/`hasLintErrors`, `internal.kbCompile.compileEntry` (defined Task 8 — reference it now; convex-test resolves lazily, and the scheduler assertion below uses fake timers only in Task 8's suite).
- Produces:
  - `api.kbEntries.list` — args `{ serviceKey?: string }`; member-visible; service filter via `by_account_service`, else `by_account`.
  - `api.kbEntries.save` — admin. Args `{ entryId?, scope, serviceKey?, packageKey?, type, title, body, audience }`. Lint-error gate. Create → `status: "draft"`, `version: 1`. Edit → patch + `version + 1` + **`status: "draft"`** (edits always demote to draft; live chunks stay pinned to the last published version). Non-company scope requires the service row to exist (`ConvexError NOT_FOUND, entity: "service"`).
  - `api.kbEntries.publish` — admin. Re-lints; sets `status: "published"`, `publishedAt`; `ctx.scheduler.runAfter(0, internal.kbCompile.compileEntry, { entryId })`.
  - `api.kbEntries.unpublish` — admin. Sets draft; schedules `compileEntry` (which deletes chunks for non-published rows).
  - `api.kbEntries.remove` — admin. Deletes the row, then deletes its `kbChunks` via `by_entry` inline (a deleted row can't be compiled).

- [ ] **Step 1: Write the failing tests** (same suite scaffolding as Task 5)

```ts
test("save creates a draft; edit bumps version and demotes to draft", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia", aliases: [] });
  const entryId = await asUser.mutation(api.kbEntries.save, {
    scope: "service", serviceKey: "georgia", type: "requirements",
    title: "Visa requirements", body: "Passport valid 6 months.", audience: "customer",
  });
  await asUser.mutation(api.kbEntries.publish, { entryId });
  let [row] = await asUser.query(api.kbEntries.list, { serviceKey: "georgia" });
  expect(row.status).toBe("published");
  await asUser.mutation(api.kbEntries.save, {
    entryId, scope: "service", serviceKey: "georgia", type: "requirements",
    title: "Visa requirements", body: "Passport valid 6 months. PCR no longer needed.",
    audience: "customer",
  });
  [row] = await asUser.query(api.kbEntries.list, { serviceKey: "georgia" });
  expect(row.status).toBe("draft");
  expect(row.version).toBe(2);
});

test("service-scope save without an existing service is NOT_FOUND", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await expect(asUser.mutation(api.kbEntries.save, {
    scope: "service", serviceKey: "ghost", type: "overview",
    title: "t", body: "b", audience: "customer",
  })).rejects.toThrow(/NOT_FOUND/);
});

test("lint error (blank body) rejects; remove deletes row + chunks", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await expect(asUser.mutation(api.kbEntries.save, {
    scope: "company", type: "note", title: "t", body: "   ", audience: "internal",
  })).rejects.toThrow(/BAD_REQUEST/);
  const entryId = await asUser.mutation(api.kbEntries.save, {
    scope: "company", type: "note", title: "t", body: "b", audience: "internal",
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("kbChunks", {
      accountId, sourceKind: "entry", entryId, audience: "internal",
      chunkIndex: 0, content: "[Company — t]\nb",
    });
  });
  await asUser.mutation(api.kbEntries.remove, { entryId });
  const leftover = await t.run((ctx) =>
    ctx.db.query("kbChunks")
      .withIndex("by_entry", (q) => q.eq("entryId", entryId)).collect());
  expect(leftover).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run convex/kbEntries.test.ts` → FAIL (`api.kbEntries` undefined).

- [ ] **Step 3: Implement `convex/kbEntries.ts`**

```ts
import { accountMutation, accountQuery } from "./lib/auth";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { hasLintErrors, lintEntryInput } from "./lib/kb/lint";

const scopeValidator = v.union(v.literal("company"), v.literal("service"), v.literal("package"));
const typeValidator = v.union(
  v.literal("overview"), v.literal("faq"), v.literal("itinerary"),
  v.literal("requirements"), v.literal("policy"), v.literal("process"), v.literal("note"),
);
const audienceValidator = v.union(v.literal("customer"), v.literal("internal"));

export const list = accountQuery({
  args: { serviceKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.serviceKey !== undefined) {
      return await ctx.db.query("kbEntries")
        .withIndex("by_account_service", (q) =>
          q.eq("accountId", ctx.accountId).eq("serviceKey", args.serviceKey))
        .collect();
    }
    return await ctx.db.query("kbEntries")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
  },
});

async function requireOwnEntry(
  db: DatabaseReader,
  accountId: Id<"accounts">,
  entryId: Id<"kbEntries">,
): Promise<Doc<"kbEntries">> {
  const row = await db.get(entryId);
  if (!row || row.accountId !== accountId) {
    throw new ConvexError({ code: "NOT_FOUND", entity: "entry" });
  }
  return row;
}

export const save = accountMutation({
  args: {
    entryId: v.optional(v.id("kbEntries")),
    scope: scopeValidator,
    serviceKey: v.optional(v.string()),
    packageKey: v.optional(v.string()),
    type: typeValidator,
    title: v.string(),
    body: v.string(),
    audience: audienceValidator,
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const issues = lintEntryInput(args);
    if (hasLintErrors(issues)) throw new ConvexError({ code: "BAD_REQUEST", issues });
    if (args.scope !== "company") {
      const service = await ctx.db.query("kbServices")
        .withIndex("by_account_key", (q) =>
          q.eq("accountId", ctx.accountId).eq("key", args.serviceKey!))
        .unique();
      if (!service) throw new ConvexError({ code: "NOT_FOUND", entity: "service" });
    }
    const fields = {
      scope: args.scope,
      serviceKey: args.scope === "company" ? undefined : args.serviceKey,
      packageKey: args.packageKey,
      type: args.type,
      title: args.title,
      body: args.body,
      audience: args.audience,
      updatedAt: Date.now(),
      updatedByUserId: ctx.userId,
    };
    if (args.entryId) {
      const row = await requireOwnEntry(ctx.db, ctx.accountId, args.entryId);
      await ctx.db.patch(args.entryId, {
        ...fields,
        status: "draft" as const,
        version: row.version + 1,
      });
      return args.entryId;
    }
    return await ctx.db.insert("kbEntries", {
      accountId: ctx.accountId,
      status: "draft",
      version: 1,
      ...fields,
    });
  },
});

export const publish = accountMutation({
  args: { entryId: v.id("kbEntries") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const row = await requireOwnEntry(ctx.db, ctx.accountId, args.entryId);
    const issues = lintEntryInput(row);
    if (hasLintErrors(issues)) throw new ConvexError({ code: "BAD_REQUEST", issues });
    await ctx.db.patch(args.entryId, { status: "published", publishedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.kbCompile.compileEntry, { entryId: args.entryId });
  },
});

export const unpublish = accountMutation({
  args: { entryId: v.id("kbEntries") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    await requireOwnEntry(ctx.db, ctx.accountId, args.entryId);
    await ctx.db.patch(args.entryId, { status: "draft" });
    await ctx.scheduler.runAfter(0, internal.kbCompile.compileEntry, { entryId: args.entryId });
  },
});

export const remove = accountMutation({
  args: { entryId: v.id("kbEntries") },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    await requireOwnEntry(ctx.db, ctx.accountId, args.entryId);
    const chunks = await ctx.db.query("kbChunks")
      .withIndex("by_entry", (q) => q.eq("entryId", args.entryId))
      .collect();
    for (const c of chunks) await ctx.db.delete(c._id);
    await ctx.db.delete(args.entryId);
  },
});
```

- [ ] **Step 4: Run** — `npx vitest run convex/kbEntries.test.ts && npx tsc --noEmit` → PASS after adding `kbEntries` to `api.d.ts`. Note: the publish test schedules `compileEntry`, which doesn't exist until Task 8 — convex-test only resolves scheduled refs when timers advance, so it passes; if it errors on resolution instead, stub `convex/kbCompile.ts` now with an empty `compileEntry = internalAction({ args: { entryId: v.id("kbEntries") }, handler: async () => {} })` and register it in `api.d.ts` (Task 8 replaces the body).

- [ ] **Step 5: Commit**

```bash
git add convex/kbEntries.ts convex/kbEntries.test.ts convex/_generated/api.d.ts convex/kbCompile.ts
git commit -m "feat(kb): kbEntries CRUD + draft/publish lifecycle"
```

---

### Task 7: `kbOps` CRUD + publish lifecycle

**Files:**
- Create: `convex/kbOps.ts`
- Modify: `convex/_generated/api.d.ts` (add `kbOps`)
- Test: `convex/kbOps.test.ts`

**Interfaces:**
- Consumes: auth wrappers, `lintOpsBlock`/`hasLintErrors`, `internal.kbCompile.compileOps` (Task 8).
- Produces:
  - `api.kbOps.get` — args `{ serviceKey, kind }` → row or `null`, member-visible.
  - `api.kbOps.listForAccount` — args `{}` → all ops rows for the account (Studio health matrix feed).
  - `api.kbOps.save` — admin. Args `{ serviceKey, kind, criteria?, steps?, conditions?, reportValue?, currency? }`. Upserts by `(accountId, serviceKey, kind)` via `by_account_service_kind`. Service must exist. Saves as draft (version semantics identical to `kbEntries.save`). **Lint gate here is errors-only on shape** (`label_required`, `key_duplicate`) — `marks_sum` and `items_required` block `publish`, not `save`, so a half-finished checklist can be saved as draft.
  - `api.kbOps.publish` — admin. Full `lintOpsBlock` gate (all errors block). Sets published + schedules `internal.kbCompile.compileOps { opsBlockId }`.
  - `api.kbOps.unpublish` — admin. Demotes + schedules `compileOps` (deletes chunks).

- [ ] **Step 1: Write the failing tests**

```ts
test("save upserts a draft; publish enforces marks_sum; unpublish demotes", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia", aliases: [] });
  await asUser.mutation(api.kbOps.save, {
    serviceKey: "georgia", kind: "qualification",
    criteria: [{ key: "dates", label: "Travel dates", marks: 50 }],
  });
  await expect(asUser.mutation(api.kbOps.publish, {
    serviceKey: "georgia", kind: "qualification",
  })).rejects.toThrow(/BAD_REQUEST/);
  await asUser.mutation(api.kbOps.save, {
    serviceKey: "georgia", kind: "qualification",
    criteria: [
      { key: "dates", label: "Travel dates", marks: 50 },
      { key: "email", label: "Email", marks: 50 },
    ],
  });
  await asUser.mutation(api.kbOps.publish, { serviceKey: "georgia", kind: "qualification" });
  let row = await asUser.query(api.kbOps.get, { serviceKey: "georgia", kind: "qualification" });
  expect(row?.status).toBe("published");
  expect(row?.version).toBe(2);
  await asUser.mutation(api.kbOps.unpublish, { serviceKey: "georgia", kind: "qualification" });
  row = await asUser.query(api.kbOps.get, { serviceKey: "georgia", kind: "qualification" });
  expect(row?.status).toBe("draft");
});

test("save against a missing service is NOT_FOUND; agent role rejected", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await expect(asUser.mutation(api.kbOps.save, {
    serviceKey: "ghost", kind: "sales", steps: [{ key: "s", label: "Step" }],
  })).rejects.toThrow(/NOT_FOUND/);
  const { asUser: asAgent } = await seedAccountMember(t, { name: "B", email: "b@x.co", role: "agent" });
  await expect(asAgent.mutation(api.kbOps.save, {
    serviceKey: "x", kind: "sales", steps: [],
  })).rejects.toThrow();
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run convex/kbOps.test.ts` → FAIL.

- [ ] **Step 3: Implement `convex/kbOps.ts`**

```ts
import { accountMutation, accountQuery } from "./lib/auth";
import { internal } from "./_generated/api";
import { v, ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import { hasLintErrors, lintOpsBlock } from "./lib/kb/lint";
import type { OpsBlockInput, OpsKind } from "./lib/kb/types";

const kindValidator = v.union(
  v.literal("qualification"), v.literal("sales"), v.literal("purchase"));
const criteriaValidator = v.array(v.object({
  key: v.string(), label: v.string(),
  question: v.optional(v.string()), marks: v.optional(v.number()),
}));
const stepsValidator = v.array(v.object({
  key: v.string(), label: v.string(), description: v.optional(v.string()),
}));
const conditionsValidator = v.array(v.object({ key: v.string(), label: v.string() }));

// Shape problems block `save`; completeness problems (items_required,
// marks_sum, …) only block `publish`, so half-finished drafts can save.
const SHAPE_ERROR_CODES = new Set(["label_required", "key_duplicate"]);

function toOpsInput(row: {
  kind: OpsKind;
  criteria?: Doc<"kbOpsBlocks">["criteria"];
  steps?: Doc<"kbOpsBlocks">["steps"];
  conditions?: Doc<"kbOpsBlocks">["conditions"];
  reportValue?: number;
  currency?: string;
}): OpsBlockInput {
  return {
    kind: row.kind, criteria: row.criteria, steps: row.steps,
    conditions: row.conditions, reportValue: row.reportValue, currency: row.currency,
  };
}

async function loadOps(
  db: DatabaseReader,
  accountId: Id<"accounts">,
  serviceKey: string,
  kind: OpsKind,
): Promise<Doc<"kbOpsBlocks"> | null> {
  return await db
    .query("kbOpsBlocks")
    .withIndex("by_account_service_kind", (q) =>
      q.eq("accountId", accountId).eq("serviceKey", serviceKey).eq("kind", kind))
    .unique();
}

export const get = accountQuery({
  args: { serviceKey: v.string(), kind: kindValidator },
  handler: async (ctx, args) => {
    return await loadOps(ctx.db, ctx.accountId, args.serviceKey, args.kind);
  },
});

export const listForAccount = accountQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("kbOpsBlocks")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .collect();
  },
});

export const save = accountMutation({
  args: {
    serviceKey: v.string(),
    kind: kindValidator,
    criteria: v.optional(criteriaValidator),
    steps: v.optional(stepsValidator),
    conditions: v.optional(conditionsValidator),
    reportValue: v.optional(v.number()),
    currency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const service = await ctx.db
      .query("kbServices")
      .withIndex("by_account_key", (q) =>
        q.eq("accountId", ctx.accountId).eq("key", args.serviceKey))
      .unique();
    if (!service) throw new ConvexError({ code: "NOT_FOUND", entity: "service" });
    const shapeIssues = lintOpsBlock(toOpsInput(args)).filter(
      (i) => i.level === "error" && SHAPE_ERROR_CODES.has(i.code));
    if (shapeIssues.length > 0) {
      throw new ConvexError({ code: "BAD_REQUEST", issues: shapeIssues });
    }
    const existing = await loadOps(ctx.db, ctx.accountId, args.serviceKey, args.kind);
    const fields = {
      criteria: args.criteria,
      steps: args.steps,
      conditions: args.conditions,
      reportValue: args.reportValue,
      currency: args.currency,
      status: "draft" as const,
      updatedAt: Date.now(),
      updatedByUserId: ctx.userId,
    };
    if (existing) {
      await ctx.db.patch(existing._id, { ...fields, version: existing.version + 1 });
      return existing._id;
    }
    return await ctx.db.insert("kbOpsBlocks", {
      accountId: ctx.accountId,
      serviceKey: args.serviceKey,
      kind: args.kind,
      version: 1,
      ...fields,
    });
  },
});

export const publish = accountMutation({
  args: { serviceKey: v.string(), kind: kindValidator },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const row = await loadOps(ctx.db, ctx.accountId, args.serviceKey, args.kind);
    if (!row) throw new ConvexError({ code: "NOT_FOUND", entity: "opsBlock" });
    const issues = lintOpsBlock(toOpsInput(row));
    if (hasLintErrors(issues)) throw new ConvexError({ code: "BAD_REQUEST", issues });
    await ctx.db.patch(row._id, { status: "published", publishedAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.kbCompile.compileOps, { opsBlockId: row._id });
  },
});

export const unpublish = accountMutation({
  args: { serviceKey: v.string(), kind: kindValidator },
  handler: async (ctx, args) => {
    ctx.requireRole("admin");
    const row = await loadOps(ctx.db, ctx.accountId, args.serviceKey, args.kind);
    if (!row) throw new ConvexError({ code: "NOT_FOUND", entity: "opsBlock" });
    await ctx.db.patch(row._id, { status: "draft" });
    await ctx.scheduler.runAfter(0, internal.kbCompile.compileOps, { opsBlockId: row._id });
  },
});
```

- [ ] **Step 4: Run** — `npx vitest run convex/kbOps.test.ts && npx tsc --noEmit` → PASS (with `kbOps` in `api.d.ts`; stub `compileOps` in `convex/kbCompile.ts` alongside Task 6's stub if needed).

- [ ] **Step 5: Commit**

```bash
git add convex/kbOps.ts convex/kbOps.test.ts convex/_generated/api.d.ts convex/kbCompile.ts
git commit -m "feat(kb): kbOps structured checklist/criteria blocks with publish gate"
```

---

### Task 8: Compiler actions

**Files:**
- Create/replace stub: `convex/kbCompile.ts`
- Modify: `convex/aiKnowledge.ts` (export `isDryRun` at line 66 and `syntheticEmbeddings` at line 103 — add the `export` keyword only, no body changes)
- Modify: `convex/_generated/api.d.ts` (ensure `kbCompile` registered)
- Test: `convex/kbCompile.test.ts`

**Interfaces:**
- Consumes: `planEntryChunks`/`planOpsChunks`, `renderOpsSentinel` (via planOps), `embedTexts`, `internal.aiConfig.loadDecrypted`, `isDryRun`/`syntheticEmbeddings` from `./aiKnowledge`.
- Produces:
  - `internal.kbCompile.getEntryContext` — internalQuery `{ entryId }` → `{ entry, serviceName: string | null } | null` (service name via `by_account_key` when `serviceKey` set).
  - `internal.kbCompile.getOpsContext` — internalQuery `{ opsBlockId }` → `{ ops, serviceName: string } | null`.
  - `internal.kbCompile.replaceEntryChunks` — internalMutation `{ entryId, accountId, serviceKey?, entryType, audience, chunks: { chunkIndex, content, embedding? }[] }` — delete-by-`by_entry`-then-insert (sourceKind `"entry"`), the `replaceChunks` idempotency pattern.
  - `internal.kbCompile.replaceOpsChunks` — internalMutation `{ opsBlockId, accountId, serviceKey, chunks }` — same via `by_ops_block`, sourceKind `"ops"`, `audience: "internal"` always (checklists/criteria are engine steering, never customer-facing).
  - `internal.kbCompile.compileEntry` — internalAction `{ entryId }`: row missing or not published → replace with `[]` (cleanup) and return; else plan chunks → best-effort embed (identical semantics to `ingest` lines 285-318: dry-run → synthetic; failure → insert lexical-only then rethrow) → replace.
  - `internal.kbCompile.compileOps` — internalAction `{ opsBlockId }`: same shape.

- [ ] **Step 1: Write the failing tests** (suite scaffolding as before; `CONVEX_AI_DRY_RUN` already set in `beforeEach`)

```ts
test("publishing an entry compiles header-prefixed chunks with metadata", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia Holiday Packages", aliases: [] });
  const entryId = await asUser.mutation(api.kbEntries.save, {
    scope: "service", serviceKey: "georgia", type: "requirements",
    title: "Visa requirements", body: "Passport valid 6 months.", audience: "customer",
  });
  vi.useFakeTimers();
  await asUser.mutation(api.kbEntries.publish, { entryId });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
  const chunks = await t.run((ctx) =>
    ctx.db.query("kbChunks").withIndex("by_entry", (q) => q.eq("entryId", entryId)).collect());
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({
    accountId, sourceKind: "entry", serviceKey: "georgia",
    entryType: "requirements", audience: "customer", chunkIndex: 0,
  });
  expect(chunks[0].content).toBe(
    "[Georgia Holiday Packages — Visa requirements]\nPassport valid 6 months.");
  expect(chunks[0].embedding).toHaveLength(1536);
});

test("publishing an ops block compiles ONE internal sentinel chunk; unpublish clears it", async () => {
  const t = convexTest(schema, modules);
  const { asUser } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await asUser.mutation(api.kbServices.upsert, { key: "georgia", name: "Georgia Holiday Packages", aliases: [] });
  await asUser.mutation(api.kbOps.save, {
    serviceKey: "georgia", kind: "purchase",
    conditions: [{ key: "budget", label: "Budget >= AED 3000/person confirmed" }],
    reportValue: 9000, currency: "AED",
  });
  vi.useFakeTimers();
  await asUser.mutation(api.kbOps.publish, { serviceKey: "georgia", kind: "purchase" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  const ops = await asUser.query(api.kbOps.get, { serviceKey: "georgia", kind: "purchase" });
  let chunks = await t.run((ctx) =>
    ctx.db.query("kbChunks")
      .withIndex("by_ops_block", (q) => q.eq("opsBlockId", ops!._id)).collect());
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({
    sourceKind: "ops", audience: "internal", serviceKey: "georgia", chunkIndex: 0,
  });
  expect(chunks[0].content).toContain("PURCHASE CRITERIA — Georgia Holiday Packages");
  expect(chunks[0].content).toContain("Report value: 9000 AED");
  await asUser.mutation(api.kbOps.unpublish, { serviceKey: "georgia", kind: "purchase" });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
  chunks = await t.run((ctx) =>
    ctx.db.query("kbChunks")
      .withIndex("by_ops_block", (q) => q.eq("opsBlockId", ops!._id)).collect());
  expect(chunks).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run convex/kbCompile.test.ts` → FAIL (stub compiles nothing).

- [ ] **Step 3: Implement `convex/kbCompile.ts`**

```ts
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { embedTexts } from "./lib/ai/embeddings";
import { isDryRun, syntheticEmbeddings } from "./aiKnowledge";
import { planEntryChunks, planOpsChunks } from "./lib/kb/compilePure";

const chunkPayload = v.array(v.object({
  chunkIndex: v.number(),
  content: v.string(),
  embedding: v.optional(v.array(v.float64())),
}));

export const getEntryContext = internalQuery({
  args: { entryId: v.id("kbEntries") },
  handler: async (ctx, args) => {
    const entry = await ctx.db.get(args.entryId);
    if (!entry) return null;
    let serviceName: string | null = null;
    if (entry.serviceKey) {
      const service = await ctx.db.query("kbServices")
        .withIndex("by_account_key", (q) =>
          q.eq("accountId", entry.accountId).eq("key", entry.serviceKey!))
        .unique();
      serviceName = service?.name ?? null;
    }
    return { entry, serviceName };
  },
});

export const getOpsContext = internalQuery({
  args: { opsBlockId: v.id("kbOpsBlocks") },
  handler: async (ctx, args) => {
    const ops = await ctx.db.get(args.opsBlockId);
    if (!ops) return null;
    const service = await ctx.db.query("kbServices")
      .withIndex("by_account_key", (q) =>
        q.eq("accountId", ops.accountId).eq("key", ops.serviceKey))
      .unique();
    return { ops, serviceName: service?.name ?? ops.serviceKey };
  },
});

export const replaceEntryChunks = internalMutation({
  args: {
    entryId: v.id("kbEntries"),
    accountId: v.id("accounts"),
    serviceKey: v.optional(v.string()),
    entryType: v.string(),
    audience: v.union(v.literal("customer"), v.literal("internal")),
    chunks: chunkPayload,
  },
  handler: async (ctx, args) => {
    const old = await ctx.db.query("kbChunks")
      .withIndex("by_entry", (q) => q.eq("entryId", args.entryId)).collect();
    for (const c of old) await ctx.db.delete(c._id);
    for (const chunk of args.chunks) {
      await ctx.db.insert("kbChunks", {
        accountId: args.accountId,
        sourceKind: "entry",
        entryId: args.entryId,
        serviceKey: args.serviceKey,
        entryType: args.entryType,
        audience: args.audience,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        embedding: chunk.embedding,
      });
    }
  },
});

export const replaceOpsChunks = internalMutation({
  args: {
    opsBlockId: v.id("kbOpsBlocks"),
    accountId: v.id("accounts"),
    serviceKey: v.string(),
    chunks: chunkPayload,
  },
  handler: async (ctx, args) => {
    const old = await ctx.db.query("kbChunks")
      .withIndex("by_ops_block", (q) => q.eq("opsBlockId", args.opsBlockId)).collect();
    for (const c of old) await ctx.db.delete(c._id);
    for (const chunk of args.chunks) {
      await ctx.db.insert("kbChunks", {
        accountId: args.accountId,
        sourceKind: "ops",
        opsBlockId: args.opsBlockId,
        serviceKey: args.serviceKey,
        audience: "internal",
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        embedding: chunk.embedding,
      });
    }
  },
});

/** Best-effort embed, identical semantics to aiKnowledge.ingest. */
async function embedPlans(
  ctx: { runQuery: any },
  accountId: any,
  contents: string[],
): Promise<{ embeddings: number[][] | null; embedError: unknown }> {
  if (contents.length === 0) return { embeddings: null, embedError: null };
  const config = await ctx.runQuery(internal.aiConfig.loadDecrypted, { accountId });
  const embeddingsApiKey = config?.embeddingsApiKey ?? null;
  if (!embeddingsApiKey) return { embeddings: null, embedError: null };
  if (isDryRun()) return { embeddings: syntheticEmbeddings(contents), embedError: null };
  try {
    return { embeddings: await embedTexts(embeddingsApiKey, contents), embedError: null };
  } catch (err) {
    return { embeddings: null, embedError: err };
  }
}

export const compileEntry = internalAction({
  args: { entryId: v.id("kbEntries") },
  handler: async (ctx, args): Promise<void> => {
    const context = await ctx.runQuery(internal.kbCompile.getEntryContext, {
      entryId: args.entryId,
    });
    if (!context) return;
    const { entry, serviceName } = context;
    if (entry.status !== "published") {
      await ctx.runMutation(internal.kbCompile.replaceEntryChunks, {
        entryId: args.entryId, accountId: entry.accountId,
        serviceKey: entry.serviceKey, entryType: entry.type,
        audience: entry.audience, chunks: [],
      });
      return;
    }
    const plans = planEntryChunks({ serviceName, title: entry.title, body: entry.body });
    const { embeddings, embedError } = await embedPlans(
      ctx, entry.accountId, plans.map((p) => p.content));
    await ctx.runMutation(internal.kbCompile.replaceEntryChunks, {
      entryId: args.entryId,
      accountId: entry.accountId,
      serviceKey: entry.serviceKey,
      entryType: entry.type,
      audience: entry.audience,
      chunks: plans.map((p, i) => ({
        chunkIndex: p.chunkIndex,
        content: p.content,
        embedding: embeddings ? embeddings[i] : undefined,
      })),
    });
    if (embedError) throw embedError;
  },
});

export const compileOps = internalAction({
  args: { opsBlockId: v.id("kbOpsBlocks") },
  handler: async (ctx, args): Promise<void> => {
    const context = await ctx.runQuery(internal.kbCompile.getOpsContext, {
      opsBlockId: args.opsBlockId,
    });
    if (!context) return;
    const { ops, serviceName } = context;
    if (ops.status !== "published") {
      await ctx.runMutation(internal.kbCompile.replaceOpsChunks, {
        opsBlockId: args.opsBlockId, accountId: ops.accountId,
        serviceKey: ops.serviceKey, chunks: [],
      });
      return;
    }
    const plans = planOpsChunks(serviceName, {
      kind: ops.kind, criteria: ops.criteria, steps: ops.steps,
      conditions: ops.conditions, reportValue: ops.reportValue, currency: ops.currency,
    });
    const { embeddings, embedError } = await embedPlans(
      ctx, ops.accountId, plans.map((p) => p.content));
    await ctx.runMutation(internal.kbCompile.replaceOpsChunks, {
      opsBlockId: args.opsBlockId,
      accountId: ops.accountId,
      serviceKey: ops.serviceKey,
      chunks: plans.map((p, i) => ({
        chunkIndex: p.chunkIndex,
        content: p.content,
        embedding: embeddings ? embeddings[i] : undefined,
      })),
    });
    if (embedError) throw embedError;
  },
});
```

(Type `embedPlans`'s ctx/accountId properly: `Pick<ActionCtx, "runQuery">` and `Id<"accounts">` — mirror how `aiKnowledge.ts` types its action helpers. `kbOps.publish`/`unpublish` from Task 7 must pass `{ opsBlockId: row._id }` when scheduling.)

- [ ] **Step 4: Run** — `npx vitest run convex/kbCompile.test.ts convex/kbEntries.test.ts convex/kbOps.test.ts && npx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add convex/kbCompile.ts convex/kbCompile.test.ts convex/aiKnowledge.ts convex/_generated/api.d.ts
git commit -m "feat(kb): publish-time compiler — entry chunks + internal sentinel ops chunks"
```

---

### Task 9: Retrieval merge (compiled-first, audience-aware, byte-compatible default)

**Files:**
- Modify: `convex/aiKnowledge.ts` (the `retrieve` action + two new internal queries; nothing else)
- Test: `convex/aiKnowledge.test.ts` (append a new `describe("retrieve merge")` block — do not touch existing tests)

**Interfaces:**
- Consumes: `kbChunks` indexes from Task 1.
- Produces: `internal.aiKnowledge.retrieve` — args gain `audience: v.optional(v.literal("customer"))`. Return type unchanged (`string[]`). New internal queries `getKbChunksByIds { accountId, ids: Id<"kbChunks">[] }` and `searchKbChunks { accountId, queryText, limit, audience? }`. Phase 3 will pass `audience: "customer"` from `aiReply`; **no caller changes in this phase**.

- [ ] **Step 1: Write the failing tests** (inside the existing suite, reusing its helpers; seed compiled chunks via `t.run` inserts with `syntheticEmbedding(content)` embeddings, mirroring how the existing retrieve tests seed `aiKnowledgeChunks`)

```ts
describe("retrieve merge", () => {
  test("compiled chunks rank ahead of legacy chunks", async () => {
    const t = convexTest(schema, modules);
    const { asUser, accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
    await seedEmbeddingsKey(t, accountId); // same helper the existing semantic-path tests use
    await t.run(async (ctx) => {
      const docId = await ctx.db.insert("aiKnowledgeDocuments", {
        accountId, title: "Legacy Georgia", content: "Georgia visa notes legacy",
      });
      await ctx.db.insert("aiKnowledgeChunks", {
        documentId: docId, accountId, chunkIndex: 0,
        content: "Georgia visa notes legacy",
        embedding: syntheticEmbedding("Georgia visa notes legacy"),
      });
      const entryId = await ctx.db.insert("kbEntries", {
        accountId, scope: "service", serviceKey: "georgia", type: "requirements",
        title: "Visa requirements", body: "x", audience: "customer",
        status: "published", version: 1, updatedAt: Date.now(),
      });
      await ctx.db.insert("kbChunks", {
        accountId, sourceKind: "entry", entryId, serviceKey: "georgia",
        entryType: "requirements", audience: "customer", chunkIndex: 0,
        content: "[Georgia — Visa requirements]\nGeorgia visa passport rules",
        embedding: syntheticEmbedding("[Georgia — Visa requirements]\nGeorgia visa passport rules"),
      });
    });
    const results = await t.action(internal.aiKnowledge.retrieve, {
      accountId, queryText: "Georgia visa", k: 5,
    });
    expect(results[0]).toContain("[Georgia — Visa requirements]");
    expect(results).toContain("Georgia visa notes legacy");
  });

  test("audience 'customer' excludes internal compiled chunks but keeps legacy", async () => {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
    await t.run(async (ctx) => {
      const opsId = await ctx.db.insert("kbOpsBlocks", {
        accountId, serviceKey: "georgia", kind: "purchase",
        conditions: [{ key: "b", label: "Budget threshold" }],
        status: "published", version: 1, updatedAt: Date.now(),
      });
      await ctx.db.insert("kbChunks", {
        accountId, sourceKind: "ops", opsBlockId: opsId, serviceKey: "georgia",
        audience: "internal", chunkIndex: 0,
        content: "PURCHASE CRITERIA — Georgia\n- Budget threshold",
      });
      const docId = await ctx.db.insert("aiKnowledgeDocuments", {
        accountId, title: "Legacy", content: "Georgia purchase info for customers",
      });
      await ctx.db.insert("aiKnowledgeChunks", {
        documentId: docId, accountId, chunkIndex: 0,
        content: "Georgia purchase info for customers",
      });
    });
    const customerSafe = await t.action(internal.aiKnowledge.retrieve, {
      accountId, queryText: "Georgia purchase", audience: "customer",
    });
    expect(customerSafe.some((c) => c.includes("PURCHASE CRITERIA"))).toBe(false);
    expect(customerSafe).toContain("Georgia purchase info for customers");
    const unfiltered = await t.action(internal.aiKnowledge.retrieve, {
      accountId, queryText: "Georgia purchase",
    });
    expect(unfiltered.some((c) => c.includes("PURCHASE CRITERIA"))).toBe(true);
  });

  test("no kb rows + no audience arg → legacy behavior identical", async () => {
    const t = convexTest(schema, modules);
    const { accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
    await t.run(async (ctx) => {
      const docId = await ctx.db.insert("aiKnowledgeDocuments", {
        accountId, title: "Doc", content: "alpha beta gamma",
      });
      await ctx.db.insert("aiKnowledgeChunks", {
        documentId: docId, accountId, chunkIndex: 0, content: "alpha beta gamma",
      });
    });
    expect(await t.action(internal.aiKnowledge.retrieve, {
      accountId, queryText: "alpha",
    })).toEqual(["alpha beta gamma"]);
  });
});
```

(If the existing suite has no `seedEmbeddingsKey`-style helper, follow whatever its current semantic-path test does to configure an embeddings key via `api.aiConfig` and reuse that snippet verbatim.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run convex/aiKnowledge.test.ts -t "retrieve merge"` → FAIL (audience arg rejected / ordering wrong).

- [ ] **Step 3: Modify `retrieve`** — keep the existing function intact as the "legacy pool" stage and add a compiled stage before it:

```ts
export const getKbChunksByIds = internalQuery({
  args: { accountId: v.id("accounts"), ids: v.array(v.id("kbChunks")) },
  handler: async (ctx, args) => {
    const docs = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    return docs.filter(
      (doc): doc is Doc<"kbChunks"> => doc !== null && doc.accountId === args.accountId,
    );
  },
});

export const searchKbChunks = internalQuery({
  args: {
    accountId: v.id("accounts"),
    queryText: v.string(),
    limit: v.number(),
    audience: v.optional(v.literal("customer")),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("kbChunks")
      .withSearchIndex("search_content", (q) => {
        const base = q.search("content", args.queryText).eq("accountId", args.accountId);
        return args.audience ? base.eq("audience", "customer") : base;
      })
      .take(args.limit);
  },
});
```

Inside `retrieve` (same best-effort try/catch discipline as the existing stages), after the blank-query guard and before the legacy semantic pass:

```ts
    const audience = args.audience;
    const pickedContents: string[] = [];
    const seen = new Set<string>();
    const push = (content: string) => {
      if (pickedContents.length >= k || seen.has(content)) return;
      seen.add(content);
      pickedContents.push(content);
    };

    // --- Compiled pass (kbChunks) — ranked ahead of legacy ----------
    // Vector filters support only single-field eq per expression (no
    // cross-field AND), so the semantic arm over-fetches by accountId
    // and post-filters audience on the hydrated rows.
    try {
      if (queryEmbedding) {
        const results = await ctx.vectorSearch("kbChunks", "by_embedding", {
          vector: queryEmbedding,
          limit: k * 2,
          filter: (q) => q.eq("accountId", args.accountId),
        });
        if (results.length > 0) {
          const rows = await ctx.runQuery(internal.aiKnowledge.getKbChunksByIds, {
            accountId: args.accountId, ids: results.map((r) => r._id),
          });
          const rowById = new Map(rows.map((r) => [r._id, r]));
          for (const r of results) {
            const row = rowById.get(r._id);
            if (!row) continue;
            if (audience && row.audience !== "customer") continue;
            push(row.content);
          }
        }
      }
    } catch { /* best-effort */ }
    if (pickedContents.length < k) {
      try {
        const rows = await ctx.runQuery(internal.aiKnowledge.searchKbChunks, {
          accountId: args.accountId, queryText: query, limit: k, audience,
        });
        for (const row of rows) push(row.content);
      } catch { /* best-effort */ }
    }
```

Restructure the function so the query embedding is computed ONCE up top (hoist the existing `loadDecrypted` + embed block above both passes; `queryEmbedding` is `null` when there's no key), then let the existing legacy semantic + lexical stages fill the remaining slots through the same `push()` (replace their `picked` Map writes with `push(content)`), and end with `return pickedContents;`. The three existing behaviors that must survive verbatim: blank-query early return, every stage individually try/caught, and `k` respected exactly.

- [ ] **Step 4: Run the full aiKnowledge suite** — `npx vitest run convex/aiKnowledge.test.ts && npx tsc --noEmit` → PASS including every pre-existing test (that's the byte-compatibility proof).

- [ ] **Step 5: Commit**

```bash
git add convex/aiKnowledge.ts convex/aiKnowledge.test.ts
git commit -m "feat(kb): retrieve merges compiled kbChunks first, optional customer audience filter"
```

---

### Task 10: Legacy importer + full gate

**Files:**
- Create: `convex/kbImport.ts`
- Modify: `convex/_generated/api.d.ts` (add `kbImport`)
- Test: `convex/kbImport.test.ts`

**Interfaces:**
- Consumes: `parseLegacyDocument`, `parseChecklistLines`, `parseReportValue`, `slugify`.
- Produces:
  - `api.kbImport.preview` — admin `accountQuery({})` → `{ services: { key, name, exists }[]; entries: { serviceKey: string | null; type: "overview" | "process"; audience; title; exists }[]; opsBlocks: { serviceKey, kind, itemCount, exists }[] }` — parse of every `aiKnowledgeDocuments` row, nothing written.
  - `api.kbImport.apply` — admin `accountMutation({})` → `{ servicesCreated, entriesCreated, opsCreated, skipped }`. Re-parses server-side (never trusts a client payload). ALL rows land as **drafts**; idempotent (services matched by key, entries by `(serviceKey, title)`, ops by `(serviceKey, kind)` — existing rows are skipped, never overwritten); legacy docs are never modified or deleted.
- Mapping rules (implement exactly):
  1. Each `QUALIFICATION CHECKLIST — X` / `PURCHASE CRITERIA — X` section → ensure service `slugify(X)` (name `X`) → ops draft of that kind. Criteria/conditions from `parseChecklistLines` (`key` = `slugify(label)` truncated to 40 chars, deduped with `-2` suffix); purchase adds `parseReportValue`.
  2. `SALES CHECKLIST — X`: if `slugify(X)` is a known/created service → sales ops draft; else (e.g. "All Services") → company entry, type `process`, audience `internal`, title `SALES CHECKLIST — X`, body = raw section.
  3. Doc prose → entry: scope `service` if the doc contains exactly one qualification section (use its service), else `company`; type `overview`; audience `internal` if `/sales process/i.test(doc.title)`, else `customer`; title = doc title; body = prose. Skip when prose is blank.

- [ ] **Step 1: Write the failing tests**

```ts
const LEGACY_DOC = [
  "Dubai city breaks for families.",
  "",
  "QUALIFICATION CHECKLIST — Dubai Holiday Packages",
  "- Travel dates (40 marks)",
  "- Email address (60 marks)",
  "",
  "PURCHASE CRITERIA — Dubai Holiday Packages",
  "- Budget confirmed",
  "Report value: 6000 AED",
].join("\n");

test("preview reports without writing; apply creates drafts idempotently", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await t.run(async (ctx) => {
    await ctx.db.insert("aiKnowledgeDocuments", {
      accountId, title: "KB 2 — Dubai packages", content: LEGACY_DOC,
    });
  });
  const preview = await asUser.query(api.kbImport.preview, {});
  expect(preview.services).toEqual([
    { key: "dubai-holiday-packages", name: "Dubai Holiday Packages", exists: false },
  ]);
  expect(preview.opsBlocks).toHaveLength(2);
  expect(await asUser.query(api.kbServices.list, {})).toEqual([]);

  const first = await asUser.mutation(api.kbImport.apply, {});
  expect(first).toMatchObject({ servicesCreated: 1, entriesCreated: 1, opsCreated: 2 });
  const ops = await asUser.query(api.kbOps.get, {
    serviceKey: "dubai-holiday-packages", kind: "qualification",
  });
  expect(ops?.status).toBe("draft");
  expect(ops?.criteria).toEqual([
    { key: "travel-dates", label: "Travel dates", marks: 40 },
    { key: "email-address", label: "Email address", marks: 60 },
  ]);
  const purchase = await asUser.query(api.kbOps.get, {
    serviceKey: "dubai-holiday-packages", kind: "purchase",
  });
  expect(purchase?.reportValue).toBe(6000);

  const second = await asUser.mutation(api.kbImport.apply, {});
  expect(second).toMatchObject({ servicesCreated: 0, entriesCreated: 0, opsCreated: 0 });
});

test("company-wide sales checklist becomes an internal process entry", async () => {
  const t = convexTest(schema, modules);
  const { asUser, accountId } = await seedAccountMember(t, { name: "A", email: "a@x.co", role: "admin" });
  await t.run(async (ctx) => {
    await ctx.db.insert("aiKnowledgeDocuments", {
      accountId, title: "KB 12 — Sales process",
      content: "Mandatory sales process.\n\nSALES CHECKLIST — All Services\n- Call the lead",
    });
  });
  await asUser.mutation(api.kbImport.apply, {});
  const entries = await asUser.query(api.kbEntries.list, {});
  const salesEntry = entries.find((e) => e.title === "SALES CHECKLIST — All Services");
  expect(salesEntry).toMatchObject({ scope: "company", type: "process", audience: "internal" });
  const overview = entries.find((e) => e.title === "KB 12 — Sales process");
  expect(overview?.audience).toBe("internal");
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run convex/kbImport.test.ts` → FAIL.

- [ ] **Step 3: Implement `convex/kbImport.ts`**

```ts
import { accountMutation, accountQuery } from "./lib/auth";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import {
  parseChecklistLines, parseLegacyDocument, parseReportValue, slugify,
} from "./lib/kb/sentinel";
import type { OpsKind } from "./lib/kb/types";

type PlannedService = { key: string; name: string; exists: boolean };
type PlannedEntry = {
  serviceKey: string | null;
  type: "overview" | "process";
  audience: "customer" | "internal";
  title: string;
  body: string;
  exists: boolean;
};
type PlannedOps = {
  serviceKey: string;
  kind: OpsKind;
  criteria?: { key: string; label: string; marks?: number }[];
  steps?: { key: string; label: string }[];
  conditions?: { key: string; label: string }[];
  reportValue?: number;
  currency?: string;
  itemCount: number;
  exists: boolean;
};
type ExistingSets = {
  serviceKeys: Set<string>;
  entryTitles: Set<string>; // `${serviceKey ?? ""}::${title}`
  opsKeys: Set<string>; // `${serviceKey}::${kind}`
};

function dedupedItemKeys(labels: string[]): string[] {
  const used = new Set<string>();
  return labels.map((label) => {
    const base = slugify(label).slice(0, 40).replace(/-+$/, "") || "item";
    let key = base;
    let n = 2;
    while (used.has(key)) key = `${base}-${n++}`;
    used.add(key);
    return key;
  });
}

/** Pure mapping of legacy docs → v2 draft proposals (rules in the plan). */
export function buildImportPlan(
  docs: { title: string; content: string }[],
  existing: ExistingSets,
): { services: PlannedService[]; entries: PlannedEntry[]; opsBlocks: PlannedOps[] } {
  const services = new Map<string, PlannedService>();
  const entries: PlannedEntry[] = [];
  const opsBlocks: PlannedOps[] = [];
  const plannedOps = new Set<string>();

  const ensureService = (name: string): string => {
    const key = slugify(name);
    if (!services.has(key)) {
      services.set(key, { key, name, exists: existing.serviceKeys.has(key) });
    }
    return key;
  };

  for (const doc of docs) {
    const parsed = parseLegacyDocument(doc.title, doc.content);
    const qualSections = parsed.sections.filter((s) => s.kind === "qualification");

    for (const section of parsed.sections) {
      const sectionKey = slugify(section.serviceName);
      const isServiceScoped =
        section.kind !== "sales" ||
        existing.serviceKeys.has(sectionKey) ||
        services.has(sectionKey) ||
        qualSections.some((q) => slugify(q.serviceName) === sectionKey);
      if (!isServiceScoped) {
        // e.g. "SALES CHECKLIST — All Services": no such service — keep
        // the raw section as an internal company process entry.
        const title = `SALES CHECKLIST — ${section.serviceName}`;
        entries.push({
          serviceKey: null, type: "process", audience: "internal",
          title, body: section.raw,
          exists: existing.entryTitles.has(`::${title}`),
        });
        continue;
      }
      const key = ensureService(section.serviceName);
      const opsId = `${key}::${section.kind}`;
      if (plannedOps.has(opsId)) continue;
      plannedOps.add(opsId);
      const items = parseChecklistLines(section.raw);
      const keys = dedupedItemKeys(items.map((i) => i.label));
      const base = {
        serviceKey: key, kind: section.kind,
        itemCount: items.length, exists: existing.opsKeys.has(opsId),
      };
      if (section.kind === "qualification") {
        opsBlocks.push({
          ...base,
          criteria: items.map((it, i) => ({
            key: keys[i], label: it.label,
            ...(it.marks !== undefined ? { marks: it.marks } : {}),
          })),
        });
      } else if (section.kind === "sales") {
        opsBlocks.push({
          ...base,
          steps: items.map((it, i) => ({ key: keys[i], label: it.label })),
        });
      } else {
        opsBlocks.push({
          ...base,
          conditions: items.map((it, i) => ({ key: keys[i], label: it.label })),
          ...parseReportValue(section.raw),
        });
      }
    }

    if (parsed.prose) {
      const serviceKey =
        qualSections.length === 1 ? slugify(qualSections[0].serviceName) : null;
      entries.push({
        serviceKey,
        type: "overview",
        audience: /sales process/i.test(doc.title) ? "internal" : "customer",
        title: doc.title,
        body: parsed.prose,
        exists: existing.entryTitles.has(`${serviceKey ?? ""}::${doc.title}`),
      });
    }
  }
  return { services: Array.from(services.values()), entries, opsBlocks };
}

async function loadPlan(db: DatabaseReader, accountId: Id<"accounts">) {
  const [docs, services, entries, ops] = await Promise.all([
    db.query("aiKnowledgeDocuments")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
    db.query("kbServices")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
    db.query("kbEntries")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
    db.query("kbOpsBlocks")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  ]);
  const plan = buildImportPlan(
    docs.map((d) => ({ title: d.title, content: d.content })),
    {
      serviceKeys: new Set(services.map((s) => s.key)),
      entryTitles: new Set(entries.map((e) => `${e.serviceKey ?? ""}::${e.title}`)),
      opsKeys: new Set(ops.map((o) => `${o.serviceKey}::${o.kind}`)),
    },
  );
  return { plan, existingServiceCount: services.length };
}

export const preview = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const { plan } = await loadPlan(ctx.db, ctx.accountId);
    return {
      services: plan.services,
      entries: plan.entries.map(({ serviceKey, type, audience, title, exists }) =>
        ({ serviceKey, type, audience, title, exists })),
      opsBlocks: plan.opsBlocks.map(({ serviceKey, kind, itemCount, exists }) =>
        ({ serviceKey, kind, itemCount, exists })),
    };
  },
});

export const apply = accountMutation({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const { plan, existingServiceCount } = await loadPlan(ctx.db, ctx.accountId);
    const now = Date.now();
    let servicesCreated = 0;
    let entriesCreated = 0;
    let opsCreated = 0;
    let skipped = 0;

    for (const [i, s] of plan.services.entries()) {
      if (s.exists) { skipped++; continue; }
      await ctx.db.insert("kbServices", {
        accountId: ctx.accountId, key: s.key, name: s.name, aliases: [],
        status: "active", sortOrder: existingServiceCount + i,
        updatedAt: now, createdByUserId: ctx.userId,
      });
      servicesCreated++;
    }
    for (const e of plan.entries) {
      if (e.exists) { skipped++; continue; }
      await ctx.db.insert("kbEntries", {
        accountId: ctx.accountId,
        scope: e.serviceKey ? "service" : "company",
        serviceKey: e.serviceKey ?? undefined,
        type: e.type, title: e.title, body: e.body, audience: e.audience,
        status: "draft", version: 1, updatedAt: now, updatedByUserId: ctx.userId,
      });
      entriesCreated++;
    }
    for (const o of plan.opsBlocks) {
      if (o.exists) { skipped++; continue; }
      await ctx.db.insert("kbOpsBlocks", {
        accountId: ctx.accountId, serviceKey: o.serviceKey, kind: o.kind,
        criteria: o.criteria, steps: o.steps, conditions: o.conditions,
        reportValue: o.reportValue, currency: o.currency,
        status: "draft", version: 1, updatedAt: now, updatedByUserId: ctx.userId,
      });
      opsCreated++;
    }
    return { servicesCreated, entriesCreated, opsCreated, skipped };
  },
});
```

- [ ] **Step 4: Run everything — the phase gate**

```bash
npm test
npm run typecheck
npm run build
npm run lint 2>&1 | tail -5   # compare against the baseline captured before Task 1
git diff --stat origin/main -- convex/qualificationEngine.ts convex/salesChecklists.ts \
  src/lib/ai/defaults.ts src/components/settings/qualification-settings.tsx \
  src/components/leads/leads-board-view.tsx 'src/app/(dashboard)/leads/page.tsx'
```

Expected: full suite green (~1900 baseline + all new kb tests), tsc clean, Next build green, **lint findings equal to the pre-Task-1 baseline** (no new ones — the repo has pre-existing debt, so "clean" is not the bar), and the final `git diff --stat` **EMPTY** — that empty diff is the proof the scope boundary held.

- [ ] **Step 5: Commit**

```bash
git add convex/kbImport.ts convex/kbImport.test.ts convex/_generated/api.d.ts
git commit -m "feat(kb): legacy-document importer — idempotent draft proposals"
```

---

## Deploy runbook (owner-gated — do NOT run during implementation)

1. `git fetch origin && git merge origin/main` on the branch; re-run the Task 10 gate. Check `gh pr list --state merged --limit 5` for surprises (deploy-collision lesson, 2026-07-18).
2. Copy `.env.local` from the main checkout into the worktree (worktrees lack it).
3. `npx convex deploy -y` — verify the four new tables' indexes build and `npx convex function-spec` lists `kbServices`/`kbEntries`/`kbOps`/`kbCompile`/`kbImport`.
4. Merge the PR → Netlify auto-builds (frontend has no changes this phase; the merge just lands the code).
5. Everything ships **dormant**: no UI calls these functions until Phase 2, engines are untouched until Phase 3. Rollback = revert the PR; the new tables sit empty and harmless.

## Follow-up plans (separate documents, in order)

- **Phase 2 — Knowledge Studio UI:** services workspace + health matrix (feeds: `kbServices.list`, `kbOps.listForAccount`, `kbEntries.list`), form editors calling `save`/`publish`, import wizard over `kbImport.preview`/`apply`, test console calling a new dry-run compose endpoint, i18n keys, replaces `AiKnowledgeCard` placement on `/agents`.
- **Phase 3 — Serving cutover (after `feat-purchase-signals` merges):** `aiReply` passes `audience: "customer"` + service-scoped queries; qualification/sales/purchase engines read `kbOpsBlocks` directly (structured, deterministic) behind a per-account `kbServeMode: "legacy" | "compiled"` config flag; layered context assembly (company card + service payload); grounding log into `aiUsageLog`.
- **Phase 4 — Learning loop:** `kbGaps` table fed by low-hit retrievals + ASK_ADMIN relay answers; one-click convert-to-entry; per-entry usage analytics; related-services cross-sell steering.
