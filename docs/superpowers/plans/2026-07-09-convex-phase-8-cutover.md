# Convex Phase 8 — Cutover & Teardown (Plan / Finish-Line Map)

> **Nature:** Unlike Phases 0–7 (autonomous, unit-testable backend), the cutover flips the REAL app from Supabase to Convex. It's verified by **running the app**, is **higher-touch/interactive**, and has a **point of no return** (once auth swaps, the app runs on Convex — the `/convex-demo` proof was safe; this is the real thing). Execute on the branch; only merge to `main` when the whole app runs on Convex and Supabase is gone.

**Goal:** Make `wacrm` run entirely on the Convex backend (Phases 0–7), delete Supabase, and update deployment/docs.

## Surface area (measured)
- **102** files import a Supabase client · **66** client components query via `createClient()` · **39** files use the Supabase `useAuth` · **23** `/api` routes call Supabase · **2** `use-realtime` consumers (→ reactive `useQuery`, then delete `use-realtime.ts`).

## Strategy & order (dependency-driven)
Auth is foundational and cannot be half-migrated → do it first, all-at-once. Then rewire the UI vertical-by-vertical (each verticals' Convex functions already exist + are tested). Then the server surfaces. Then teardown. Keep the app booting at each step.

## Pre-requisites (need YOU / the environment)
- **Convex deployment env**: set `ENCRYPTION_KEY` (identical to the app's — for `metaSend`/AI decrypt), confirm `JWT_PRIVATE_KEY`/`JWKS`/`SITE_URL` (Convex Auth, from Phase 2), and `CONVEX_SITE_ORIGIN` (already fixed).
- **`.env.local`**: once Supabase is deleted, the dummy Supabase vars come out; `NEXT_PUBLIC_CONVEX_URL` stays.
- **Prod HTTPS** (before real deploy, not for local): the backend needs a Traefik HTTPS subdomain (see [[convex-selfhost-deployment]]) — once the app is served over HTTPS, browsers block a plain `http://…:port` Convex URL (mixed content).
- **Meta webhook**: stays pointed at the Next.js `/api/whatsapp/webhook` route (per your decision) — no Meta reconfiguration.

---

### Task 1: Auth cutover (all-at-once) — the riskiest step
- Swap the app-wide provider to `ConvexAuthNextjsServerProvider` + wire `convexAuthNextjsMiddleware` in `src/middleware.ts` (Next-docs-first), replacing the Supabase session-refresh middleware and its `protectedPaths` redirects (Convex Auth's `isAuthenticatedNextjs`).
- Replace `src/hooks/use-auth.tsx` (Supabase `AuthProvider`) with a Convex-backed hook exposing the SAME shape (`user`, `accountId`, `role`, `profile`, `signOut`, `refreshProfile`) sourced from `useConvexAuth` + `api.accounts.currentUser` — so the 39 consumers keep working with minimal edits.
- Rewire `login`/`signup`/`forgot-password` pages to `useAuthActions().signIn("password", …)`; wire the invitation `/join/[token]` peek/redeem + the members tab to `api.invitations.*`/`api.members.*`; port `transfer_account_ownership` (deferred from P5).
- Fix the module-level `ConvexReactClient(URL!)` to fail gracefully (deferred from P0).
- **Verify:** run the real app — sign up, sign in, sign out, invite+redeem, role change all work on Convex Auth; protected routes gate correctly.

### Task 2: Core UI rewire — contacts + inbox
- Rewire `contacts/page.tsx`, contact form/detail/import, and the inbox (`inbox/page.tsx`, conversation-list, message-thread, contact-sidebar) from `createClient().from(...)` to `useQuery`/`useMutation`/`usePaginatedQuery` on `api.contacts.*`/`api.conversations.*`/`api.messages.*`/`api.reactions.*`.
- **Delete `use-realtime.ts`** and the 2 consumers' subscription code — Convex queries are reactive automatically (the realtime win).
- **Verify:** inbox + contacts work live in the real app, updates appear without refresh, isolation holds.

### Task 3: Remaining UI verticals
Rewire to their Convex functions: pipelines/deals board, dashboard (the 5 aggregations — pass client day-boundary args), broadcasts wizard + list, templates + quick-replies (settings), team/members + presence + notifications, api-keys + webhooks + whatsapp-config settings, AI config/knowledge/usage UI. **Verify each in the app.**

### Task 4: Server surfaces
- `src/app/api/whatsapp/webhook/route.ts`: after signature verify, call `internal.ingest.ingestInbound` (via `ConvexHttpClient`/an internal HTTP entrypoint); on `duplicate:true` skip the fan-out; else fire `internal.flowsEngine.dispatchInbound` → (if not consumed) `internal.automationsEngine.runForTrigger` + `internal.aiReply.dispatchInbound` + `internal.webhookDelivery.dispatch`, preserving the original order + the "flow consumed suppresses content triggers" + "stand down for active automation" precedence (deferred from P6/P7). Keep the fast-ack `after()`.
- `/api/v1/*` (contacts, conversations, messages, broadcasts, webhooks, me): auth via `internal.apiKeys.lookupByHash`, then call the Convex functions; keep the REST response shapes.
- The Meta-send + template-submit + media routes → the Convex actions.
- **Verify:** send an inbound (or a simulated webhook) end-to-end; a `/api/v1` call with a real key.

### Task 5: Teardown + deployment + docs
- Delete `@supabase/supabase-js`/`@supabase/ssr`, `src/lib/supabase/*`, the 3 `admin-client.ts` files, the Supabase bits of `middleware.ts`, `use-realtime.ts`; archive `supabase/migrations/` (keep as historical reference, out of the build).
- `docker-compose`: the app + the Convex backend + Postgres (no Supabase); `.env`/`.env.local.example` cleaned; `ENCRYPTION_KEY`/Convex vars documented.
- Update `CLAUDE.md`/`AGENTS.md` (drop the Augment-mandate wording if desired; describe the Convex backend), README, `docs/`.
- **Deferred-items checklist** (18 logged — fold in here or earlier): contacts.remove cascade; `memberships.by_user` `.first()`→explicit account (multi-account is live!); `activity` `by_account_updated` index; broadcasts.create dedupe; prettier `convex/` override; AI ingest embeddings-key-only; metaSend phone-variant retry + structured template builder; `http_fetch` flow node; webhookDelivery SSRF DNS fidelity; etc. (see `.superpowers/sdd/progress.md`).

### Task 6: Whole-app verification + hardening (Phase 9)
- Boot the real app on Convex; walk EVERY vertical end-to-end in the browser.
- **Tenant-isolation matrix**: for each table, a two-account check that B can't reach A's data (the automated `convex-test` suite already covers the functions; add an app-level pass).
- Load-sanity: realtime under many rows; webhook throughput; the scheduler (a real `wait`/flow timeout).
- Final whole-branch review; then `superpowers:finishing-a-development-branch` (merge decision).

---

## Risks & mitigations
- **Auth swap is app-wide + point-of-no-return** → do it as its own task behind the branch; keep the `use-auth` shape identical to minimize consumer churn; verify sign-in before proceeding.
- **Can't fully unit-test the cutover** → verification is running the real app (interactive); do it vertical-by-vertical so a break is localized.
- **ENCRYPTION_KEY mismatch** → real Meta/AI sends silently fail; set it on the Convex deployment first.
- **Mixed content on HTTPS** → do the Traefik HTTPS backend before serving the app over HTTPS.

## How we'll run it
Interactive, vertical-by-vertical, with the preview/dev server. I'll drive the edits; you (or I via preview) verify each vertical in the browser; we resolve environment items (ENCRYPTION_KEY, deployment) as we hit them. Estimated the largest remaining chunk — but every Convex function it calls is already built + tested.
