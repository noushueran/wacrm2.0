# Convex Phase 5 — Team & Settings (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.

**Goal:** Account-scoped Convex functions for team management (members, invitations) and settings (presence, notifications, API keys, webhook endpoints, WhatsApp config) — porting the SECURITY DEFINER RPCs (migrations 018/019) with their guards, and the deliberate **by-secret** lookups.

**Architecture:** Convex functions on the Phase 1 schema. Most via `accountQuery`/`accountMutation`. **Three deliberate exceptions** (documented so the reviewer doesn't flag them as isolation gaps): `peekInvitation` (public query by token hash), `redeemInvitation` (authenticated mutation acting on the *target* account, not the caller's), `apiKeys.lookupByHash` (`internalQuery` by key hash for the Phase-6 public-API auth). In all three, the secret token/hash IS the access credential.

## Global Constraints
*(Inherit the roadmap's.)* Account-scoped fns via `accountQuery`/`accountMutation` with denial tests; the 3 by-secret fns are the noted exceptions and each needs its OWN safety test (a wrong/foreign token returns nothing/appropriate error; they never leak more than the minimal safe fields). Validate offline then `npx convex dev --once`. Commit `_generated`; double-quote style (no `prettier --write`); TS strict; no Supabase changes. Reuse `convex/lib/auth.ts` + existing patterns. Role gates: member/invite/settings writes = `requireRole("admin")`; presence/notifications = `agent`/any-member as noted.

## Behavior reference (read the named files/migrations)
- **Members** (`migration 018`, `src/app/api/account/members/*`): `listMembers` (all `memberships.by_account`; email visible to admin+ only). `setMemberRole(userId, role)` — admin+; target in account; **can't target self; can't set/change owner** (that's a separate transfer). `removeMember(userId)` — admin+; **can't remove owner or self**; delete the target's membership (and, matching the RPC, give them a fresh personal account so they aren't account-less — create a new `accounts` + owner `memberships` for them; return that new accountId).
- **Invitations** (`migration 019`, `src/app/api/account/invitations`, `.../invitations/[token]/{peek,redeem}`): `createInvitation({role, expiresInDays, label})` — admin; insert `{accountId, tokenHash, role, createdByUserId, label, expiresAt}`; return the plaintext token once (caller hashes with the app's `hashInviteToken` — port that helper or accept a pre-hashed value). `listInvitations`/`revokeInvitation` — admin. `peekInvitation({tokenHash})` — PUBLIC query; look up by `by_token_hash`; return `{ok, accountName?, role?, expiresAt?}` or `{ok:false, reason}` (not_found/used/expired) — never expose other fields. `redeemInvitation({tokenHash})` — authenticated (`getAuthUserId`); validate (found/not-used/not-expired); create the caller's `memberships` row in the INVITE'S account with the invite's role; mark the invitation redeemed; port the guards from migration 019 (caller not already in that account; caller's current account is a solo/empty personal account — read 019 for the exact checks).
- **Presence** (`member_presence`, `presence-heartbeat.tsx`): `touchPresence({status})` — any member; upsert the caller's row `{userId, accountId, status, lastSeenAt: Date.now()}` (keyed by `userId`). `listPresence()` — account members' presence rows.
- **Notifications** (`notifications`; the `notify_conversation_assigned` trigger): `list()` (the caller's `by_user`, newest-first), `markRead({notificationId})`, `markAllRead()`, and an internal-ish `create` used when a conversation is assigned. **Also wire `conversations.assign` (Phase 2) to create a notification for the assignee** (the trigger did this).
- **API keys** (`api_keys`, `src/lib/api-keys/store.ts`): `create({name, scopes, expiresInDays?})` — admin; generate key (port `generateApiKey`: prefix + sha-256 hash), insert `{accountId, createdBy, name, keyPrefix, keyHash, scopes, expiresAt}`; return plaintext once. `list`/`revoke` — admin. `lookupByHash({keyHash})` — **`internalQuery`** (server-only); return the active key's `{accountId, scopes}` or null if revoked/expired.
- **Webhook endpoints** (`webhook_endpoints`): admin CRUD — `list`, `create({url, events, secret})`, `update`, `remove`. `secret` stored as-is (encryption is caller's concern).
- **WhatsApp config** (`whatsapp_config`): `get()` (the account's single config); `upsert({...})` — admin; one per account (unique `accountId`); assert `phoneNumberId` isn't claimed by ANOTHER account (query `by_phone_number_id`; if a row with a different `accountId` has it → `ConvexError({code:"PHONE_NUMBER_CLAIMED"})`).

---

### Task 1: Members + invitations
**Files:** Create `convex/members.ts`, `convex/invitations.ts` (+ tests). Port `hashInviteToken` into `convex/lib/inviteToken.ts` if needed.
- `members.list`/`setRole`/`remove` with all the 018 guards (self/owner protections; `removeMember` creates the ejected user a fresh personal account).
- `invitations.create`/`list`/`revoke` (admin, account-scoped); `peek` (PUBLIC query, minimal fields); `redeem` (authenticated mutation acting on the target account, guards from 019).
- [ ] TDD: role guards (agent can't setRole; can't change owner; can't remove self/owner); denial (B can't manage A's members/invites); `peek` returns minimal info for a valid token + `{ok:false}` for bad/expired; `redeem` adds the caller to the target account with the right role and rejects a used/expired token; a foreign token reveals nothing.
- [ ] tsc; vitest; deploy; commit `feat(convex): members + invitations (role guards, peek/redeem)`.

### Task 2: Presence + notifications + api keys
**Files:** Create `convex/presence.ts`, `convex/notifications.ts`, `convex/apiKeys.ts` (+ tests). Modify `convex/conversations.ts` (assign → create notification).
- `presence.touch`/`list`; `notifications.list`/`markRead`/`markAllRead` + a `create` (account-scoped) and wire `conversations.assign` to notify the assignee; `apiKeys.create`/`list`/`revoke` (admin) + `lookupByHash` (`internalQuery`).
- [ ] TDD: presence upsert (second touch updates same row); notification list/markRead/markAllRead scoped to the caller; assign creates a notification; api-key create returns plaintext once + stores only the hash; `lookupByHash` returns the account for an active key, null for revoked/expired; denial across accounts.
- [ ] tsc; vitest; deploy; commit `feat(convex): presence + notifications + api keys`.

### Task 3: Webhook endpoints + WhatsApp config
**Files:** Create `convex/webhookEndpoints.ts`, `convex/whatsappConfig.ts` (+ tests).
- `webhookEndpoints` admin CRUD; `whatsappConfig.get`/`upsert` (admin; one per account; `phoneNumberId` cross-account-claim guard).
- [ ] TDD: webhook CRUD + denial; whatsappConfig upsert is idempotent per account; a `phoneNumberId` already claimed by another account is rejected; denial across accounts.
- [ ] tsc; vitest; deploy; commit `feat(convex): webhook endpoints + whatsapp config`.

---

## Exit Gate
All team/settings functions exist, account-scoped (except the 3 documented by-secret fns), deploy clean; the 018/019 guards are faithful; cross-account denial + by-secret safety tests green; tsc + full suite green; Phase 0–4 untouched (except the `conversations.assign` notification wiring).

## Self-Review
1. The 3 by-secret fns (`peek`/`redeem`/`lookupByHash`) leak only minimal safe data and are the ONLY non-account-scoped fns; each has a safety test.
2. Member guards match 018 (self/owner protections); `redeem` guards match 019.
3. `phoneNumberId` uniqueness enforced across accounts; api-key plaintext never stored.
