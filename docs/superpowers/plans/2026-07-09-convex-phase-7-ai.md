# Convex Phase 7 — AI (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Completes the Convex backend.

**Goal:** Account-scoped Convex functions for the AI subsystem — config, usage log, the knowledge RAG (chunk + embed + vector/FTS retrieval), and the auto-reply LLM flow — with the external LLM/embeddings calls as **actions** (DRY-RUN-testable) and semantic retrieval via **`ctx.vectorSearch`**.

**Architecture:** Same split as Phase 6. Pure helpers (chunking, query building, defaults, handoff decision) port 1:1 with tests. External calls (embeddings, LLM generate) → `internalAction` with a `CONVEX_AI_DRY_RUN` path (synthetic embeddings/replies). Vector search is action-only (`ctx.vectorSearch("aiKnowledgeChunks","by_embedding",{vector,limit,filter})`). FTS via the `search_content` search index. Config/usage = tenant CRUD.

## Global Constraints
*(Inherit the roadmap's.)* Tenant fns via `accountQuery`/`accountMutation`; engine/external fns `internal*`. Never return encrypted `apiKey`/`embeddingsApiKey` from a query (return `hasKey`/`hasEmbeddingsKey` flags). Validate offline (`tsc`+`vitest`) then `npx convex dev --once`. Commit `_generated`; double-quote style (no `prettier --write`); TS strict; no Supabase changes. Reuse `convex/lib/whatsappEncryption.ts` (Phase-6 decrypt), `convex/metaSend.ts` (send the reply), `convex/messages.ts`. Role: config write = `admin`; knowledge write = `admin`; retrieval/usage-read = any member/internal.

## Behavior reference (read the source AI files + their tests)
- Config: `src/lib/ai/config.ts` (`loadAiConfig` decrypts `apiKey`+`embeddingsApiKey`; embeddings-decrypt failure downgrades to lexical, doesn't throw), `src/app/api/ai/config/route.ts` (GET returns NO key, only flags; POST admin upsert, encrypt, `apiKey` omitted → reuse existing).
- Usage: `src/lib/ai/usage.ts` (`logAiUsage` — best-effort append, never throws, skips if no usage), `src/app/api/ai/usage/route.ts` (dashboard read by account + day range).
- Knowledge: `src/lib/ai/knowledge.ts` (`ingestDocument` = delete chunks → `chunkText` → embed if key → insert; `retrieveKnowledge` = semantic (`match_ai_knowledge_semantic`, cosine `<=>`) then FTS top-up (`match_ai_knowledge_fts`), best-effort), `src/lib/ai/chunk.ts`, `embeddings.ts` (`embedTexts` — OpenAI), `src/app/api/ai/knowledge/route.ts`.
- Auto-reply: `src/lib/ai/auto-reply.ts` (`dispatchInboundToAiReply`), `generate.ts` + `providers/` (openai/anthropic), `handoff.ts`, `query.ts`/`context.ts` (prompt build), `defaults.ts`. Triggers on inbound when `isActive` + `autoReplyEnabled` + reply-count < `autoReplyMaxPerConversation`; builds prompt (system + retrieved knowledge + recent history); calls LLM; on model-bail → handoff (assign `handoffAgentId` or leave for queue) + set conversation `aiHandoffSummary`; increments `conversations.aiReplyCount`; logs usage; sends the reply.

---

### Task 1: AI config + usage
**Files:** Create `convex/aiConfig.ts`, `convex/aiUsage.ts` (+ tests). Port `loadAiConfig` decrypt into an internal helper.
- `aiConfig.get()` — `accountQuery` (any member); return `{ provider, model, systemPrompt, isActive, autoReplyEnabled, autoReplyMaxPerConversation, handoffAgentId, hasKey: !!apiKey, hasEmbeddingsKey: !!embeddingsApiKey }` — **never** the encrypted keys.
- `aiConfig.upsert({...})` — `accountMutation` `requireRole("admin")`; encrypt `apiKey`/`embeddingsApiKey` when provided (use `convex/lib/whatsappEncryption.ts` encrypt — port it if only decrypt exists), reuse existing when omitted; one row per account (`by_account`). (Provider-key VALIDATION against OpenAI/Anthropic is an action — defer or do a `verifyKey` internalAction with DRY-RUN; for Phase 7 the upsert may skip live validation, noted.)
- `aiConfig.loadDecrypted()` — `internalQuery`/helper returning the decrypted config (for the auto-reply/knowledge actions).
- `aiUsage.log({ conversationId?, mode, provider, model, promptTokens, completionTokens, totalTokens })` — `internalMutation` (best-effort append, account-scoped); `aiUsage.summary({ sinceMs })` — `accountQuery` for the usage dashboard (by account + range).
- [ ] TDD: config `get` never leaks keys (assert no `apiKey` field, `hasKey` correct); upsert reuses omitted key; admin-gated; usage log + summary account-scoped; cross-account denial. tsc; vitest; deploy; commit `feat(convex): ai config + usage`.

### Task 2: AI knowledge (RAG)
**Files:** Create `convex/aiKnowledge.ts` (+ test); port `convex/lib/ai/chunk.ts` (+ its test), and the OpenAI `embedTexts` into an action.
- `documents.list`/`create`/`remove` — `accountMutation`/`accountQuery` `requireRole("admin")`; on create, schedule/run `ingest`.
- `ingest({ documentId })` — `internalAction`: load the account's `embeddingsApiKey` (decrypted); `chunkText` (ported); when a key + not DRY-RUN, `embedTexts` each chunk (else null embeddings / synthetic in DRY-RUN); `ctx.runMutation` to delete the doc's existing `aiKnowledgeChunks` and insert new `{ accountId, documentId, chunkIndex, content, embedding? }`.
- `retrieve({ accountId, queryText, k })` — `internalAction`: if an embeddings key, embed the query + `ctx.vectorSearch("aiKnowledgeChunks","by_embedding",{ vector, limit:k, filter: q=>q.eq("accountId",accountId) })` → load those chunks; top up (< k) with the `search_content` FTS search index (filtered by accountId). Return up to k chunk contents. Best-effort (degrade, never throw). **Every path filtered by accountId** — vector search MUST use the `filter` on accountId (no cross-account chunks).
- [ ] TDD (DRY-RUN): `chunk` ported tests pass; `ingest` writes chunks (delete-then-insert) scoped to the account; `retrieve` returns the account's chunks only and never another account's (seed a decoy account's chunks, assert excluded); no-key path uses FTS only. tsc; vitest; deploy (the vector index is live from Phase 1); commit `feat(convex): ai knowledge (chunk + embed + vector/FTS retrieval)`.

### Task 3: AI auto-reply
**Files:** Create `convex/aiReply.ts` (+ test); port `convex/lib/ai/{generate,handoff,query,defaults}.ts` + `providers/` (the LLM clients) — the pure prompt-building parts port directly; `generateReply` becomes the action's external call.
- `dispatchInbound({ accountId, conversationId, contactId })` — `internalAction`: load the decrypted config; **early-exit** unless `isActive` && `autoReplyEnabled` && the conversation's `aiReplyCount < autoReplyMaxPerConversation` && not already handed off; load recent messages (history); `retrieve` knowledge context; build the prompt (ported); call `generateReply` (openai/anthropic — DRY-RUN returns a synthetic reply + zero usage); on a bail/handoff signal → `ctx.runMutation` to assign `handoffAgentId` (or leave unassigned) + set the conversation's `aiHandoffSummary` + status; else send the reply via `convex/metaSend.ts` and `ctx.runMutation` to bump `conversations.aiReplyCount`; `aiUsage.log` the spend. Never throw into the caller.
- [ ] TDD (DRY-RUN): a reply is generated+sent and `aiReplyCount` increments; hitting `autoReplyMaxPerConversation` early-exits (no send); AI-inactive/auto-reply-off early-exit; a handoff signal assigns/leaves + records the summary + does NOT send a normal reply; account isolation. tsc; vitest; deploy; commit `feat(convex): ai auto-reply (RAG + LLM, dry-run testable)`.

---

## Exit Gate
AI config/usage/knowledge/auto-reply exist as account/internal Convex fns; keys never leaked; vector + FTS retrieval account-filtered; auto-reply respects max/handoff; DRY-RUN makes LLM/embeddings paths testable; ported pure-helper tests pass; cross-account denial green; tsc + full suite green; Phases 0–6 untouched. **This completes the entire Convex backend.**

## Self-Review
1. `get` never returns encrypted keys; upsert reuses omitted keys. 2. Vector search + FTS both `accountId`-filtered (no cross-account chunk leak). 3. Auto-reply early-exits on inactive/off/max/handed-off; increments `aiReplyCount`; logs usage. 4. Every external call is an action with DRY-RUN; DB effects are mutations. 5. Pure helpers are faithful ports.
