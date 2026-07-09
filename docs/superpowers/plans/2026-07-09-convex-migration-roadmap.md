# Supabase → Convex Migration — Roadmap

> **For agentic workers:** This is the top-level roadmap. Each phase has (or will have) its own executable plan under `docs/superpowers/plans/`. Execute one phase plan at a time with `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Start with Phase 0.

**Goal:** Replace Supabase (Postgres + RLS + Supabase Auth + Realtime + Storage) with a self-hosted Convex backend, with equivalent behavior and stronger type-safety, on the `feat/convex-migration` branch.

**Architecture:** Convex becomes the single backend — schema, functions (queries/mutations/actions), auth (Convex Auth), file storage, scheduling, and realtime. The Next.js app keeps its routes/UI but talks to Convex via `convex/react` hooks (client) and `ConvexHttpClient` (server routes like the WhatsApp webhook and `/api/v1`). Postgres-side security (RLS) is replaced by **one application-level choke point** (`accountQuery` / `accountMutation`) that every tenant-scoped function must use.

**Tech Stack:** Convex (self-hosted, Docker + Postgres backend, FSL license), `@convex-dev/auth` (Password provider, beta — pinned), `convex-helpers` (custom functions / RLS-style wrappers), Next.js 16.2.6, React 19.2.4, TypeScript strict, `convex-test` + Vitest.

---

## Global Constraints

These apply to **every task in every phase**. Copy them into each phase plan.

- **Next.js is non-standard here.** Before writing ANY Next.js code (middleware, providers, route handlers, `cookies()`, layouts), read the relevant guide in `node_modules/next/dist/docs/`. Do not rely on training-data Next.js APIs. (Source: `AGENTS.md`.)
- **Tenant isolation is the prime directive.** Every tenant-scoped Convex function MUST go through `accountQuery` / `accountMutation` (never raw `query` / `mutation`). Every tenant table MUST have a `by_account` index. Every feature MUST ship a cross-account **denial test** (account B cannot read/write account A's rows) before it is considered done.
- **Must stay self-hostable.** No hosted-only dependency. Auth runs inside the Convex deployment (Convex Auth), never a third-party auth SaaS. Convex runs self-hosted via Docker with a Postgres backend.
- **Convex Auth is beta.** Pin `@convex-dev/auth` and `@auth/core` to exact versions. All auth calls (sign in/up/out, current-user) go through a thin `src/lib/auth/*` wrapper so the provider can be swapped later without touching call sites.
- **No ETL, no dual-write.** Data is pre-launch/empty. Do not build data-migration tooling. Do not merge to `main` until the entire app runs on Convex and Supabase is fully removed.
- **Validate all args** with `v.*`; take identity from `ctx.auth` (via `getAuthUserId`), never from function arguments.
- **Commit `convex/_generated/`.** Frequent commits; one per task step group as the phase plans specify.
- **Port pure TypeScript unchanged.** `src/lib/whatsapp/encryption.ts`, `phone-utils.ts`, `meta-api.ts`, `webhook-signature.ts`, `contacts/dedupe.ts`, `auth/roles.ts` are provider-agnostic — reuse, don't rewrite.

---

## The security model (the pillar that replaces RLS)

Supabase enforced tenant isolation centrally in Postgres via RLS + `is_account_member(account_id, min_role)`. Convex has no RLS, so we enforce it in code via one wrapper, built with `convex-helpers` custom functions:

```
accountQuery / accountMutation  (convex/lib/auth.ts)
  1. userId = await getAuthUserId(ctx)          // from @convex-dev/auth/server
  2. if !userId -> throw ConvexError UNAUTHENTICATED
  3. membership = memberships.by_user(userId).first()
  4. if !membership -> throw ConvexError NO_ACCOUNT
  5. inject ctx.accountId, ctx.userId, ctx.role, ctx.requireRole(min)
```

Every tenant function then filters by `ctx.accountId` using a `by_account` index. `requireRole("admin")` ports the `roleRank` ladder from `src/lib/auth/roles.ts` (owner=4, admin=3, agent=2, viewer=1). Enforcement moves from "the database guarantees it" to "this wrapper + these indexes guarantee it" — which is exactly why every feature needs a denial test.

---

## Table → Phase map (36 tables)

| Phase | Subsystem | Tables |
|---|---|---|
| **0** | Foundations + Contacts proof | `users`(+authTables), `accounts`, `memberships`(was `profiles`), `contacts`, `tags`, `contactTags` |
| **1** | Full schema + security spine | *(all remaining tables declared; helpers, pure-lib ports)* |
| **2** | Inbox (realtime win) | `conversations`, `messages`, `messageReactions` |
| **3** | CRM + dashboard | `pipelines`, `pipelineStages`, `deals`, `customFields`, `contactCustomValues`, `contactNotes` |
| **4** | Messaging ops | `messageTemplates`, `broadcasts`, `broadcastRecipients`, `quickReplies` |
| **5** | Team & settings | `accountInvitations`, `memberPresence`, `notifications`, `apiKeys`, `webhookEndpoints`, `whatsappConfig` |
| **6** | Engines & server surfaces | `automations`, `automationSteps`, `automationLogs`, `automationPendingExecutions`→scheduler, `flows`, `flowNodes`, `flowRuns`, `flowRunEvents`; webhook, `/api/v1`, crons, storage |
| **7** | AI | `aiConfigs`, `aiUsageLog`, `aiKnowledgeDocuments`, `aiKnowledgeChunks` (vector index) |
| **8** | Auth cutover + Supabase teardown | remove `@supabase/*`, `src/lib/supabase/*`, admin clients, `supabase/`; docker-compose + docs |
| **9** | Hardening | isolation test matrix, load checks (webhook/realtime) |

---

## Behavior mappings that need real modeling (not 1:1)

- **`filter_contacts_by_tags` RPC** → a Convex `accountQuery` that loads `contactTags.by_tag` for the selected tags, dedupes contact ids (OR semantics), applies the name/phone/email search, sorts by `_creationTime` desc, and pages. (Postgres did this in one SQL window function; Convex does it in code.)
- **Contacts phone dedup** — Postgres `UNIQUE(account_id, phone_normalized)` generated column → Convex mutation normalizes phone (`normalizePhone`), checks the `by_account_phone` index, and throws on collision. There is no DB-level unique constraint in Convex; the mutation is the guarantee.
- **Full-text search** — Postgres `ILIKE` on name/phone/email → Convex `searchIndex`. A search index covers ONE field; matching all three needs either multiple search indexes or a name-search + phone-prefix fallback. Decide per phase; document the tradeoff.
- **Triggers** (`update_updated_at_column`, broadcast count aggregation, `notify_conversation_assigned`) → logic moves into the mutation that writes the row (Convex has `_creationTime`; add explicit `updatedAt` only where read).
- **Realtime** (`postgres_changes`) → delete; `useQuery` is reactive by default. Net code reduction.
- **Cron + `automation_pending_executions` polling** → `convex/crons.ts` + `ctx.scheduler.runAfter` for the automations/flows "wait" step. Net simplification.
- **pgvector `ai_knowledge_chunks`** → Convex `vectorIndex` (dimensions 1536); re-embed on import.

---

## Risks & mitigations

1. **Cross-tenant data leak** (RLS → app code): single `accountQuery/accountMutation` choke point + a denial test per table. Non-negotiable gate.
2. **Convex Auth beta churn**: pin versions; wrap behind `src/lib/auth/*`.
3. **Self-hosted Convex is single-node**: Postgres backend + vertical scaling; adequate for CRM scale; revisit if outgrown.
4. **Lost DB constraints** (unique phone, FK cascades): enforce in mutations (reuse `dedupe`), model cascades explicitly (delete children in the parent's delete mutation).
5. **Next.js 16 API drift**: local-docs-first rule (global constraint).

---

## Execution dependency (before Phase 0 code runs)

Phase 0 needs a reachable Convex backend for `npx convex dev`. Given the self-host constraint, that is the **self-hosted Docker backend** (Convex + Postgres) — or Convex Cloud dev credentials if provided as an interim. This must be resolved at the start of Phase 0 execution.

## Phase plans

- Phase 0 → `docs/superpowers/plans/2026-07-09-convex-phase-0-foundations-contacts.md`
- Phases 1–9 → authored just-in-time, one per phase, before that phase executes.
