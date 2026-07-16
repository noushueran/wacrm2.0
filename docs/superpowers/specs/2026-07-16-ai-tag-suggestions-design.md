# AI-assisted conversation tagging — design

- **Date:** 2026-07-16
- **Status:** Approved (pending spec review)
- **Branch:** `feat/ai-tag-suggestions` (stacked on `feat/inbox-tag-label-system`)
- **Depends on:** Phase 1 (grouped tags — `tagGroups`, grouped `tags`, `contacts.assignTag`, `contactNotes`) deployed. This feature tags *into* those groups.

## Problem

A busy WhatsApp inbox has hundreds of existing conversations and a steady
stream of new ones. Phase 1 gives agents a fast way to *manually* label each
chat by service (Product: UAE Visa / Global Visa / Packages; Destination;
etc.), but someone still has to read every chat and apply the label. Doing that
by hand across the backlog is hours of work, and doing it by guesswork (or
auto-stamping without reading) pollutes the very segmentation it's meant to
build. The owner asked for "tag every chat" — the only way to do that
*correctly* at scale is to have the model read each conversation and propose a
label a human can trust and adjust.

## Goals

- **Classify a conversation** into a **Product** tag (single) + **Destination**
  tags (multi) + a **one-line summary note**, using the account's own tag
  catalogue as the fixed option set — the model can only choose from real tags,
  never invent them.
- **Confidence-gated application:** high-confidence classifications auto-apply;
  uncertain ones become a **suggestion** an agent confirms/edits/dismisses.
- **Provenance:** every AI-applied tag is marked AI-sourced, auditable, and
  removable — nothing is locked in.
- **Backfill** the existing backlog: an admin-triggered job that classifies
  every Product-less conversation, bounded and cost-visible.
- **Ongoing:** classify a new conversation once (after its first text message),
  producing a suggestion or auto-apply.
- **Reuse** the existing AI stack (BYO key/provider/model, `generateReply`,
  usage logging, dry-run) — no new provider integration.

## Non-goals

- **No structured-field extraction** (budget / travel dates / pax) in this
  feature — tags + a note only. (A later extension can fill custom fields.)
- **No customer-facing output.** Classification is internal annotation; nothing
  is ever sent to the contact.
- **No per-message classification.** A conversation is classified once (backfill
  or first-inbound), not on every message — bounds cost.
- **No new AI provider / no fine-tuning / no separate model key.** Reuses the
  account's configured `aiConfigs` provider + key.
- **No change to the auto-reply behaviour.** The "classify" mode is independent
  of `autoReplyEnabled`.

## Approved decisions

1. **Confidence-gated review** (over always-confirm or full-auto): high →
   auto-apply, uncertain → suggestion. Fast on the backlog, safe on ambiguous
   chats, never silently wrong.
2. **Extract tags + a one-line note** (over tags-only or tags+fields).
3. **Threshold:** only **"high"** confidence auto-applies (configurable).
4. **Review UX:** an **inline sidebar banner** per chat + a **"Pending
   suggestions" inbox filter** — not a separate page.
5. **Backfill scope:** conversations **lacking a Product tag**, recency-ordered.
6. **Ongoing trigger:** classify a conversation **once**, after it has a text
   message — not per inbound.

## Architecture

### Data model (`convex/schema.ts`)

**New — `tagSuggestions`** (one per classification run on a conversation):
```ts
tagSuggestions: defineTable({
  accountId: v.id("accounts"),
  conversationId: v.id("conversations"),
  contactId: v.id("contacts"),
  productTagId: v.optional(v.id("tags")),
  destinationTagIds: v.array(v.id("tags")),
  note: v.optional(v.string()),
  confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
  status: v.union(
    v.literal("auto_applied"), // high-confidence, applied on creation
    v.literal("pending"),      // awaiting agent review
    v.literal("accepted"),     // agent confirmed (possibly edited)
    v.literal("dismissed"),    // agent rejected
  ),
  model: v.string(),
  reviewedByUserId: v.optional(v.id("users")),
})
  .index("by_account_status", ["accountId", "status"])   // pending-suggestions filter
  .index("by_conversation", ["conversationId"]),
```

**Extend `contactTags`** — provenance:
```ts
source: v.optional(v.union(v.literal("ai"), v.literal("manual"))), // unset = manual (backward-compatible)
```

**Extend `aiUsageLog.mode`** — add `v.literal("classify")` to the existing
union (`auto_reply`|`draft`|`classify`).

**Threshold** — a **constant** (`"high"` auto-applies) to start (YAGNI). If the
owner later wants to tune it, add `autoTagConfidence` to `aiConfigs` + a
settings control then; no schema change is needed for this feature.

### Classifier (`convex/lib/ai/classify.ts` + `convex/aiTagging.ts`)

- **`buildClassifyPrompt(catalogue, history)`** (pure) — assembles the system
  prompt: the account's tag catalogue rendered as *fixed option lists per group*
  ("Product (choose exactly one or null): UAE Visa | Global Visa | Packages",
  "Destination (choose any): …") + instructions to return **only JSON**
  `{ product, destinations, note, confidence }`. Adds the account's own AI
  behaviour prompt / knowledge only if useful (likely just the catalogue +
  transcript — keep it lean).
- **`parseClassification(rawText, catalogue)`** (pure) — robustly extracts the
  JSON object from the model text (same tolerance as today's handoff-sentinel
  parse), validates each returned name **against the catalogue**, **drops
  anything off-list**, and maps names → tag ids. Returns
  `{ productTagId?, destinationTagIds[], note?, confidence }`. Unparseable →
  a `low`-confidence empty result (never throws).
- **`aiTagging.classifyConversation`** (internal action) — loads recent messages
  (reuse `aiReply`'s `recentMessages` + `context.toChatMessages`), loads the tag
  catalogue (`tagGroups` + `tags`), calls `generateReply` (reused adapters;
  prompt-for-JSON), runs `parseClassification`, logs usage (`mode:"classify"`),
  and hands the result to the gating mutation. `isDryRun()` → synthetic result
  (mirrors `aiReply`).

### Confidence gating + apply (`convex/aiTagging.ts`)

- **`applyClassification`** (internal mutation) — given a parsed result:
  - **high** → insert `tagSuggestions{status:"auto_applied"}`, apply the Product
    tag + Destination tags via the Phase-1 assign path **with `source:"ai"`**,
    and add the note (`contactNotes`). Single-select displacement still applies.
  - **medium/low** → insert `tagSuggestions{status:"pending"}` only (no data
    change).
- **`assignTag` gains an optional `source`** (default `"manual"`); the internal
  apply passes `"ai"`. Manual UI calls omit it → `"manual"`.

### Review UX (frontend)

- **Inline banner** — `src/components/inbox/tag-suggestion-banner.tsx`: when the
  open chat has a `pending` suggestion, show proposed Product/Destination chips
  + the note with **Accept / Edit / Dismiss**. Accept → `acceptSuggestion`
  (applies tags `source:"ai"`, adds note, status→`accepted`); Edit opens the
  Phase-1 label picker pre-filled; Dismiss → status→`dismissed`.
- **Pending-suggestions filter** — a new inbox filter value that lists
  conversations with a `pending` suggestion (server-side via
  `by_account_status`), for rapid backlog review.
- **AI marker** — the Phase-1 label chips render a small "AI" dot when
  `contactTags.source === "ai"`, so agents can spot + remove wrong ones.

### Backfill job (`convex/aiTagging.ts`)

- **`runBackfill`** (admin-gated action) → schedules
  **`backfillStep`** (internal action): scans conversations **lacking a Product
  tag** (recency), processes up to **N per run** (cap, e.g. 25), calls
  `classifyConversation` for each (small inter-call delay to respect provider
  rate limits), then self-reschedules until no Product-less conversations remain
  or a **total budget guard** trips. Dormant by default — only runs when
  triggered. Progress = count of `tagSuggestions` created; cost = `aiUsageLog`
  `mode:"classify"` rows (surfaced in the existing AI-usage summary).

## Cost & safety

- BYO key; ~1 small call per chat (short transcript + tiny JSON out). Backfill
  cost ≈ chats × (context + ~50 output tokens), bounded by the per-run cap + a
  total-budget guard, all logged. **Nothing outbound to customers.** Every AI
  tag is `source:"ai"`, reversible, and marked. Dry-run covers all logic offline.

## Roles

- Run/stop backfill, configure threshold = **admin/supervisor**.
- Accept / edit / dismiss suggestions = **agent**.
- Viewer = read-only (sees suggestions + markers, can't act).
- (Matches Phase-1 gates: `assignTag`/`addNote` are agent; settings supervisor+.)

## i18n

All new UI strings under `Inbox.tagSuggestions.*` and
`Settings.aiTagging.*` in `messages/en.json` (single locale).

## Testing

`convex-test` (dry-run, offline): `parseClassification` (valid JSON → ids;
off-list names dropped; unparseable → low/empty; name→id mapping); confidence
gating (high auto-applies + note + `source:"ai"`; medium/low → pending only);
`assignTag` `source` provenance + single-select displacement still holds;
suggestion lifecycle (pending → accepted/dismissed, role gates); backfill
scan/cap/reschedule + budget guard. Pure prompt/parse functions unit-tested.

## Deployment & migration

- Built **offline** (hand-edit `convex/_generated/`: new `tagSuggestions` table
  → `schema.ts` only; new `aiTagging`/`lib/ai/classify` modules → `api.d.ts`).
- Ship = manual **`convex deploy`** + Netlify, **after Phase 1 is deployed**
  (this stacks on it). Additive: `contactTags.source` + `aiUsageLog` union
  extension are backward-compatible; existing tags read as `manual`.
- No backfill of the schema itself; the *conversation* backfill is the
  admin-triggered `runBackfill` job, run once when ready.

## Phasing

1. **Classify engine + `tagSuggestions` + inline Accept/Dismiss** — end-to-end
   on-demand (a "Suggest tags" affordance) proves the pipeline.
2. **Confidence auto-apply + `contactTags.source` marker + pending-suggestions
   filter** — the trust/provenance + review-at-scale layer.
3. **Backfill job** (scan + cap + reschedule + budget guard) + the ongoing
   first-inbound trigger — clears the backlog and keeps new chats labelled.
