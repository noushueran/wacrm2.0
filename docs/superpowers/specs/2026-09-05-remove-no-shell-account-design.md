# Removal should not mint a shell account

**Date:** 2026-09-05
**Status:** approved

## Problem

`members.remove` did not just drop a membership — it created a fresh personal
account for the removed user and made them its **owner**. That looked like a
courtesy. It was a trap.

Owner is admin+, so the first time the removed person opened the Pipelines page,
`src/app/(dashboard)/pipelines/page.tsx` auto-seeded a "Sales Pipeline" into that
otherwise-empty shell. `invitations.redeem` refuses to move a caller whose own
account holds anything, and the /join modal's only recovery advice is "sign out
and sign up with a different email" — useless to someone with one email address
and no admin override. Removing a teammate could therefore make them
**permanently impossible to re-invite**.

The immediately preceding fix (amani-wa-crm#112 / wacrm2.0#69) stopped an
auto-seeded pipeline from counting as domain data, which unstuck everyone
currently stranded. This change removes the mechanism that put them there.

The shell account bought nothing that justified the risk: nobody removed from a
team wants a private one-person CRM as a consolation prize.

## Design

### 1. `members.remove` deletes the membership and stops

The removed user keeps their login and belongs to no account. Its return value
(the new account's id) describes an account that no longer gets created and no
caller ever read it, so it goes away.

This lands them on `invitations.redeem`'s existing brand-new-invitee branch,
which creates the membership straight into the inviting account. Re-inviting a
removed teammate becomes the same clean path as inviting a stranger.

### 2. The silent bootstrap backstop in `AuthProvider` goes

`src/hooks/use-auth.tsx` called `accounts.bootstrapAccount` for any authenticated
user whose `me` came back `null`. Left in place it would re-mint the very shell
`members.remove` no longer creates, the first time the removed person opened the
app — so removing only the mint would have fixed nothing.

Afterwards the **only** caller of `bootstrapAccount` is the sign-up page's
self-serve path. Minting an account becomes a deliberate act, never an ambient
one.

### 3. Sign-up stops swallowing a bootstrap failure

The sign-up page caught a bootstrap failure, logged it, and navigated to
`/dashboard` anyway — safe only *because* the backstop existed. Now it stays on
`/signup` with an inline error and a retry that calls `bootstrapAccount` alone.
Re-running `signIn` is not an option: the user already exists, so a second
`flow: "signUp"` would fail as a duplicate.

### 4. `DashboardShell` renders an explicit "no workspace" screen

Authenticated, profile finished loading, no profile → `NoWorkspace`: they are not
a member of any workspace, an admin's invite link is the way back, plus sign out.

**No "create your own workspace" button, deliberately.** This is a staff CRM, not
a self-serve product; offering it hands them the exact empty account this change
deletes, which they can then seed and re-trap themselves with.

One guard covers every dashboard route. Because `me` is a live subscription, a
member removed *while they have the app open* lands here immediately instead of
watching every `accountQuery` throw `NO_ACCOUNT`.

`NoWorkspace` takes `onSignOut` as a prop rather than calling `useAuth()`, so it
renders under `renderToStaticMarkup` in its test — matching `ConversionHoldBanner`.

## Testing

- `members.remove` leaves the target with zero memberships, mints no account, and
  does not delete their login.
- End to end: a removed member immediately redeems a fresh invite back into the
  account they were removed from.
- `NoWorkspace` names the stranded address, says an invite is the way back, offers
  sign-out, and offers **no** self-create path (asserted negatively — that button
  reappearing would silently restore the bug).

No page-component test for the sign-up retry: nothing in this repo tests page
components, and mocking `useAuthActions`/`useMutation`/`useRouter` would cost more
than the branch is worth.

## Explicitly out of scope

Removing a member still does not reassign their conversations or deals — threads
stay pointing at a departed user, invisible to every role scope. That hazard is
unchanged by this work and has its own tool (`conversations.reassignAllFromUser`,
currently CLI-only). It needs wiring into the removal flow; that is a separate
change.
