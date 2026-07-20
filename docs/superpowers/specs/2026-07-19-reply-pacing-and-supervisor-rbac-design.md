# Human-paced AI replies + supervisor role lockdown

**Date:** 2026-07-19
**Status:** Approved design, pending implementation plan

Two independent workstreams, requested together. They share no code and ship as
**two separate PRs**. Part A is customer-facing behaviour needing a live WhatsApp
test; Part B is a security change with a deploy-ordering constraint.

---

## Part A — Human-paced AI replies

### Problem

The AI agent feels slow and, worse, feels *absent*. A customer messages and sees
nothing at all for twelve seconds.

The cause is deliberate, not a performance bug. `DEFAULT_REPLY_DEBOUNCE_MS =
12_000` (`convex/lib/ai/defaults.ts:40`) delays every dispatch so that a burst of
fragmented messages ("Hi" / "I want a package" / "for August") produces one reply
instead of three partial ones. Rough budget for a plain text inbound — the 12s is
certain from code, the rest are estimates:

| Stage | Cost |
|---|---|
| Debounce (fixed wait) | 12,000ms |
| Blue-tick + "typing…" to Meta | ~0.5s |
| Knowledge-base retrieval (embed + vector search) | ~0.5–1s |
| Qualification objectives | ~0.1s |
| LLM generation (`MAX_OUTPUT_TOKENS = 1024`) | ~2–6s |
| Send | ~0.4s |

≈17s total, ~70% of it dead waiting. Critically, the typing indicator fires
*after* the debounce (`convex/aiReply.ts:575`), so the entire 12s is silent.

### Constraints (researched, not assumed)

**1. There is no inbound typing signal.** We cannot detect that a customer is
composing. Meta's typing indicator is strictly business → customer; the full list
of subscribable webhook fields contains no composing, typing, or presence event.
Sources: [typing indicators](https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators/),
[webhooks setup](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks/).

Note that "keep waiting while they're still typing" **already works**: each
inbound reschedules a dispatch, and an older dispatch stands down when its
trigger is no longer the newest message (`convex/aiReply.ts:557`). Only the
*inverse* — knowing they have finished — is unavailable. Silence is the only
evidence, so the debounce window is inherently a guess.

**2. The typing indicator dies after 25 seconds.** Meta auto-dismisses it, with
no documented way to refresh or extend. Their guidance: *"only display a typing
indicator if you are going to respond."* Every wait must therefore stay
comfortably under 25s, or the customer watches "typing…" vanish into silence —
which reads as someone abandoning the conversation.

### Design

Goal is not raw speed. It is a wait that is **visible, varied, and proportional**
— a reply that feels typed rather than computed. Three changes:

#### A1 — Acknowledge immediately

New internal action `aiReply.ackInbound`, scheduled at `runAfter(0)` from
`convex/ingest.ts` alongside the debounced dispatch. It runs a cheap eligibility
check (config active, auto-reply on, conversation not human-assigned, not
autoreply-paused) and then blue-ticks + shows "typing…".

The existing `markRead` inside `dispatchInbound` is removed, so we don't pay two
Meta round-trips.

Accepted tradeoff: `ackInbound`'s gates are a subset of the full dispatch gates,
so occasionally we show "typing…" for a message that ends up unanswered (e.g. the
qualification `suppressReply` path). Meta dismisses it after 25s, so the worst
case is a brief phantom indicator — cheap against turning a 12s silence into a
sub-second acknowledgement.

#### A2 — Shape-adaptive debounce

`aiReplyDebounceMs()` takes the inbound text and returns one of three windows.
Pure function, no I/O, no API calls:

| Message shape | Window | Env override |
|---|---|---|
| Ends in `.` `!` `?` `。` `؟`, or longer than 40 chars | 2s | `AI_REPLY_DEBOUNCE_FAST_MS` |
| Under 15 chars with no terminal punctuation, or a bare greeting | 6s | `AI_REPLY_DEBOUNCE_SLOW_MS` |
| Everything else, and all non-text inbound | 3s | `AI_REPLY_DEBOUNCE_MS` |

`0` still means immediate dispatch. Rationale: once a conversation is warm most
messages are complete sentences and take the fast path. Greetings take the slow
path — which is exactly where fragmenting actually happens.

#### A3 — Length-proportional, jittered delivery

After generation, the reply is **not** sent immediately. Instead:

```
targetMs = clamp(jitter(replyLength / CHARS_PER_SEC), MIN_MS, MAX_MS)
waitMs   = max(0, targetMs - (now - inboundAt))
```

with `CHARS_PER_SEC = 18`, `jitter = ±25%`, `MIN_MS = 3_000`, `MAX_MS = 15_000`.

The target is measured **from inbound arrival**, not from generation-complete.
This absorbs the LLM's thinking time into the typing window rather than stacking
on top of it: slow generation yields a shorter artificial wait, fast generation a
longer one, and the customer always experiences the same natural rhythm. The
`MAX_MS = 15_000` clamp guarantees the total stays under Meta's 25s ceiling by
construction.

Jitter matters for its own sake — a bot replying in exactly 3.0s every time is
detectable *because* it is consistent.

`inboundAt` is threaded from `ingest.ts` as an optional arg, defaulting to "now"
when absent so dispatches already scheduled at deploy time still behave.

**Delivery uses `scheduler.runAfter(waitMs, …)`, not an in-action sleep.**
Sleeping would burn billed action time (up to ~12s idle per reply); scheduling is
free and survives action timeouts. Requires splitting the send into a small
`aiReply.deliverReply` internal action taking the generated text.

Note that `targetMs` is a **floor on total elapsed time, not a schedule**. When
debounce plus generation already exceeds it, `waitMs` is 0 and the reply sends as
soon as it is ready. Actual time-to-reply is therefore
`max(debounce + generation, targetMs)`:

| Scenario | Debounce | Gen | Target | Lands at |
|---|---|---|---|---|
| Short reply to a complete question | 2s | ~3s | 3s | ~5s |
| 150-char answer to a complete question | 2s | ~4s | ~8s | ~8s |
| Short reply to a bare greeting | 6s | ~3s | 3s | ~9s |
| Long itinerary breakdown | 2s | ~5s | 15s (capped) | ~15s |

Down from ~17s across the board, and time-to-first-signal drops from 12s to under
1s in every case.

#### A4 — Supporting cleanups

- `MAX_OUTPUT_TOKENS` 1024 → 320 (env-overridable). WhatsApp replies run 60–120
  tokens; 320 leaves headroom while bounding worst-case generation time.
- Knowledge retrieval and qualification objectives (`convex/aiReply.ts:653-670`)
  run back-to-back but are independent — `Promise.all` them after
  `recentMessages`. Worth ~200–300ms.

### Files

- `convex/lib/ai/defaults.ts` — shape classifier, debounce tiers, pacing
  constants, `MAX_OUTPUT_TOKENS`
- `convex/ingest.ts` — schedule `ackInbound`; pass text + `inboundAt`
- `convex/aiReply.ts` — `ackInbound`, `deliverReply`, remove inline `markRead`,
  parallelize lookups

### Tests

- Shape classifier: table-driven over greetings, questions, long text, empty,
  non-Latin punctuation. Pure function — highest value per line.
- Pacing calculator: short/long replies clamp correctly; jitter stays in band;
  elapsed time is subtracted; never exceeds `MAX_MS`.
- Existing `convex-test` dispatch-gate suite must still pass unchanged.

### Risks

- **Two replies to one thought.** Guessing short means a slow typer occasionally
  gets two replies. Milder than the bug the 12s prevented — the second reply sees
  the full conversation including the first, so it reads as eager, not broken.
  The 6s slow tier on fragment-shaped messages is the mitigation.
- **Truncation** if a reply exceeds 320 tokens. Rare; the system prompt already
  instructs brevity.
- **Phantom typing indicator** — see A1.

---

## Part B — Supervisor role lockdown

### Problem

`canAccessNav` (`src/lib/auth/roles.ts:155`) is a **denylist**:

```ts
if (hasMinRole(role, "supervisor")) return true; // supervisor/admin/owner: all
```

Supervisors see every nav item except `/campaigns` — including **`/agents`, the
AI agent settings page**, plus `/automations` and `/flows`. Because it is a
denylist, every new page added is automatically visible to supervisors.

Separately, three Convex reads have no role guard, so the UI hides them while the
queries answer any account member.

### Target access matrix

**Nav — supervisor allowlist:** `/dashboard` `/inbox` `/leads` `/contacts`
`/pipelines` `/broadcasts` `/campaigns`

Loses `/agents`, `/automations`, `/flows`. Gains `/campaigns` (previously
admin-only). Landing page stays `/dashboard`.

**Settings — supervisor sees:** Overview, Profile, Appearance, Notifications,
Templates, Quick replies, Fields & tags, Deals, Team members.
**Blocked:** WhatsApp, API keys, Conversions, Lead qualification, Cron schedules.

Team members is safe as a read — every members *mutation* is already
`requireRole("admin")`, so a supervisor sees the roster but cannot invite,
remove, or change roles. Lead qualification stays blocked because it drives the
AI agent's question flow.

### Backend guards

Client gating hides UI; it enforces nothing. Consumer audit results:

| Query | Guard today | Non-admin consumers | Action |
|---|---|---|---|
| `apiKeys.list` | none | settings API tab only (already admin-gated client-side) | add `requireRole("admin")` |
| `whatsappConfig.get` | none — returns **whole raw row** (phone number ID, WABA ID, verify token) | inbox `page.tsx:115` needs `status === "connected"`; settings overview `:132` needs `!!phoneNumberId` | gate `get` to admin; add member-safe `connectionState` returning `{ status, isConfigured }` |
| `aiConfig.get` | none — returns **full `systemPrompt`** | inbox banner `ai-thread-banner.tsx:64` needs `isActive` + `autoReplyEnabled` | drop `systemPrompt` from `get`; add admin-only `getFull` for the settings form and `/agents` |
| `cronSchedules.overview` / `listSystemTasks` | `requireRole("admin")` | — | already correct, no change |

**No plaintext secret leaks today.** The WhatsApp access token and API key hashes
are deliberately withheld (`aiConfig.ts:44-50`, `apiKeys.ts:~99`). What leaks is
configuration and prompt engineering. Real, but not a credential breach.

`whatsappConfig.connectionStatus` (an action, called from settings overview at
`:65`) also lacks a guard and must be gated to admin. That requires
`settings-overview.tsx` to filter its tiles by `canAccessSettingsSection` and skip
the corresponding queries — otherwise gating the action breaks the page for
non-admins.

### Files

- `src/lib/auth/roles.ts` — `SUPERVISOR_NAV` allowlist, rewrite `canAccessNav`,
  drop `ADMIN_ONLY_NAV`, remove `members` from `CRITICAL_SECTIONS`
- `convex/apiKeys.ts`, `convex/whatsappConfig.ts`, `convex/aiConfig.ts` — guards
  and narrowed member-safe queries
- `src/app/(dashboard)/inbox/page.tsx` — switch to `connectionState`
- `src/components/settings/settings-overview.tsx` — filter tiles by section
  access; skip gated queries
- `src/components/settings/ai-config.tsx`, `src/app/(dashboard)/agents/page.tsx`
  — switch to `getFull`
- `src/lib/convex/adapters.ts` — update the affected return-shape adapters

### Tests

`roles.ts` is pure. Table-driven test over every (role × nav) and (role ×
settings-section) pair — cheap, and permanently locks the policy down. This is
what stops the denylist regression from recurring.

### Deploy order

**Convex backend first, then Netlify.** Safe in that direction because
supervisors already cannot reach these tabs in the UI, so nothing errors
mid-deploy. The reverse order would ship the UI changes with the guards still
off.

Per repo convention: merge `origin/main` before every `convex deploy`.

---

## Out of scope

- Per-contact adaptive learning of fragmenting behaviour (over-engineering for
  now; revisit if the two-reply case proves common in practice)
- Re-firing the typing indicator near the 25s mark for unusually slow generations
- Any change to agent/viewer permissions — this spec touches supervisor only
- Reworking the qualification engine's own follow-up cadence
