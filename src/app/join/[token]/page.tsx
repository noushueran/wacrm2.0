'use client';

// ============================================================
// /join/[token] — invitation redemption landing page.
//
// Four UI states driven by:
//   - the peek result (server-validated invite payload), and
//   - whether the visitor is currently authenticated.
//
//   ┌──────────────────────┬───────────────┬─────────────────────────┐
//   │ peek                 │ auth          │ render                   │
//   ├──────────────────────┼───────────────┼─────────────────────────┤
//   │ loading              │ —             │ spinner                  │
//   │ ok:false (any reason)│ —             │ friendly error + signup  │
//   │ ok:true              │ signed out    │ "Sign up" + "Sign in"    │
//   │ ok:true              │ signed in     │ "Accept" button → redeem │
//   └──────────────────────┴───────────────┴─────────────────────────┘
//
// We deliberately do NOT redeem automatically on page load — the
// invitee should confirm what account/role they're accepting.
// Auto-redeem would also race with the signup flow returning to
// this page after email verification.
//
// Convex notes
//   - `api.invitations.peek`/`redeem` key their lookup on a `tokenHash`,
//     never the plaintext token (see `convex/invitations.ts`'s own doc
//     comments on both) — the plaintext never needs to reach Convex.
//     `hashInviteToken` (from `convex/lib/inviteToken.ts`) is a plain
//     Web Crypto function (no Node-only dependency, no `"use node"`),
//     so it runs client-side here exactly as that module's own doc
//     comment anticipates: "used ... by callers, e.g. a future
//     /join/<token> route, to turn a plaintext token from a URL into
//     the tokenHash". There is no server-only hashing gap — this IS
//     the intended integration point.
//   - The AuthProvider (`src/hooks/use-auth.tsx`) only wraps the
//     `(dashboard)` route group, so this page reads Convex Auth
//     directly (`useConvexAuth`/`useAuthActions`) instead of `useAuth`
//     — same reasoning this file previously gave for hitting Supabase
//     directly "the same way /login and /signup do" (both of which
//     are Convex-Auth-based too now).
//   - Convex queries are reactive, not one-shot fetches: there is no
//     discrete "the peek request failed, show a Try again button"
//     state the way a REST `fetch()` rejection gave us — a genuine
//     connectivity blip just leaves `peek` at `undefined` (folded into
//     the loading spinner below) until the client's subscription
//     reconnects on its own. The old `server_error` peek-failure
//     reason and its dedicated retry button are dropped accordingly.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';
import { useConvexAuth, useMutation, useQuery } from 'convex/react';
import { useAuthActions } from '@convex-dev/auth/react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { convexErrorData, convexErrorMessage } from '@/lib/convex/adapters';

import { api } from '../../../../convex/_generated/api';
import { hashInviteToken } from '../../../../convex/lib/inviteToken';

type PeekFailReason = 'not_found' | 'used' | 'expired';

const ROLE_LABEL: Record<'admin' | 'agent' | 'viewer', string> = {
  admin: 'Admin',
  agent: 'Agent',
  viewer: 'Viewer',
};

const FAIL_COPY: Record<PeekFailReason, { title: string; body: string }> = {
  not_found: {
    title: 'Invite not found',
    body: 'This link doesn’t match a valid invitation. Double-check the URL or ask the person who invited you to send a new one.',
  },
  used: {
    title: 'Invite already used',
    body: 'This invitation has already been accepted. If that wasn’t you, ask the account admin to send a fresh link.',
  },
  expired: {
    title: 'Invite expired',
    body: 'This invitation has expired. Ask the account admin to send a new one — they take a few seconds to generate.',
  },
};

// Redeem-time failure codes (`convex/invitations.ts`'s `redeem`) that mean
// "this signed-in identity can't accept this invite" — the invitee needs
// to sign out and use a different email, not just retry. Mirrors the old
// REST route's SQLSTATE-23505 -> HTTP 409 -> conflict-modal mapping, split
// into one message per Convex error code instead of one shared Postgres
// exception string.
const CONFLICT_MESSAGES: Record<string, string> = {
  ALREADY_MEMBER: 'You are already a member of this account.',
  NOT_SOLE_OWNER:
    'You are already in another account. Sign out and sign up with a different email to join this one.',
  ACCOUNT_HAS_DATA:
    'Your current account already has data in it. Sign out and sign up with a different email to join this one.',
};

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;

  // SHA-256 of the plaintext token, computed client-side via Web Crypto.
  // `peek`/`redeem` both key their lookup off this hash, never the
  // plaintext (see convex/invitations.ts's doc comments on both).
  const [tokenHash, setTokenHash] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    hashInviteToken(token).then((hash) => {
      if (!cancelled) setTokenHash(hash);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const peek = useQuery(
    api.invitations.peek,
    tokenHash ? { tokenHash } : 'skip',
  );
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { signOut } = useAuthActions();
  const redeemInvitation = useMutation(api.invitations.redeem);

  const [accepting, setAccepting] = useState(false);
  // `redeem` throws ALREADY_MEMBER / NOT_SOLE_OWNER / ACCOUNT_HAS_DATA
  // when the caller's current identity can't accept this invite. A
  // transient toast wasn't enough — the user has no actionable next
  // step. Surface a blocking modal that walks them through it.
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const handleAccept = useCallback(async () => {
    if (!tokenHash) return;
    setAccepting(true);
    try {
      await redeemInvitation({ tokenHash });
      toast.success('Welcome to the team');
      // Full reload (not router.push) so every Convex Auth session /
      // query subscription re-initializes against the new account.
      window.location.href = '/dashboard';
    } catch (err) {
      console.error('[join] redeem error:', err);
      const code = convexErrorData(err)?.code;
      if (typeof code === 'string' && code in CONFLICT_MESSAGES) {
        setConflictMessage(CONFLICT_MESSAGES[code]);
      } else {
        toast.error(convexErrorMessage(err));
      }
      setAccepting(false);
    }
  }, [tokenHash, redeemInvitation]);

  const handleSignOutAndRetry = useCallback(async () => {
    setSigningOut(true);
    try {
      await signOut();
      // Hard reload so the new (signed-out) auth state propagates
      // everywhere (middleware, AuthProvider). Preserves the invite
      // token in the URL so the rebuilt page renders the signed-out
      // CTA path.
      window.location.reload();
    } catch (err) {
      console.error('[join] sign-out error:', err);
      toast.error('Could not sign out. Try refreshing the page.');
      setSigningOut(false);
    }
  }, [signOut]);

  // ----- Loading state (peek pending OR auth not yet resolved) -----
  if (peek === undefined || authLoading) {
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Verifying invitation…</p>
        </CardContent>
      </Card>
    );
  }

  // ----- Peek failed -----
  if (!peek.ok) {
    const copy = FAIL_COPY[peek.reason];
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
            <MailX className="h-6 w-6 text-red-400" />
          </div>
          <CardTitle className="text-xl text-foreground">{copy.title}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {copy.body}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Link href="/signup">
            <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
              Create a new account instead
            </Button>
          </Link>
          <Link href="/login">
            <Button
              variant="outline"
              className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Sign in
            </Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  // ----- Peek OK -----
  const inviteHeader = (
    <CardHeader className="items-center text-center">
      <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
        <UsersRound className="h-6 w-6 text-primary" />
      </div>
      <CardTitle className="text-xl text-foreground">
        You&apos;re invited to{' '}
        <span className="text-primary">{peek.accountName}</span>
      </CardTitle>
      <CardDescription className="text-muted-foreground">
        You&apos;ll join as{' '}
        <span className="inline-flex items-center gap-1 text-foreground">
          <ShieldCheck className="size-3.5 text-primary" />
          {ROLE_LABEL[peek.role]}
        </span>
        . Link valid until{' '}
        {new Date(peek.expiresAt).toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })}
        .
      </CardDescription>
    </CardHeader>
  );

  // ----- Authed: show Accept button -----
  if (isAuthenticated) {
    return (
      <>
        <Card className="w-full max-w-md border-border bg-card">
          {inviteHeader}
          <CardContent className="flex flex-col gap-3">
            <Button
              onClick={handleAccept}
              disabled={accepting}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {accepting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Accepting…
                </>
              ) : (
                <>
                  <CheckCircle className="size-4" />
                  Accept invitation
                </>
              )}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Accepting moves your login into{' '}
              <span className="text-muted-foreground">{peek.accountName}</span>. Your
              empty personal account from signup will be cleaned up.
            </p>
          </CardContent>
        </Card>

        {/* Conflict modal — opens when redeem throws ALREADY_MEMBER /
            NOT_SOLE_OWNER / ACCOUNT_HAS_DATA (the caller's current
            identity can't accept this invite). Blocks the flow until
            the user picks a recovery action so they aren't stuck
            retrying an inevitable failure. */}
        <Dialog
          open={conflictMessage !== null}
          onOpenChange={(open) => {
            if (!open) setConflictMessage(null);
          }}
        >
          <DialogContent className="bg-popover border-border sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <AlertTriangle className="size-4 text-amber-400" />
                Can&apos;t join {peek.accountName} with this account
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {conflictMessage}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2 text-xs text-muted-foreground">
              <p>
                To join{' '}
                <span className="text-popover-foreground">{peek.accountName}</span>,
                sign out and sign up again with a different email address.
                The invite link stays valid as long as it hasn&apos;t
                expired.
              </p>
            </div>
            <DialogFooter className="bg-popover border-border">
              <Button
                variant="outline"
                onClick={() => setConflictMessage(null)}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                Stay signed in
              </Button>
              <Button
                onClick={handleSignOutAndRetry}
                disabled={signingOut}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {signingOut ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Signing out…
                  </>
                ) : (
                  'Sign out & use a different email'
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ----- Not authed: prompt to sign up or sign in -----
  return (
    <Card className="w-full max-w-md border-border bg-card">
      {inviteHeader}
      <CardContent className="flex flex-col gap-2">
        <Link href={`/signup?invite=${encodeURIComponent(token!)}`}>
          <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
            Create account &amp; join
          </Button>
        </Link>
        <Link href={`/login?invite=${encodeURIComponent(token!)}`}>
          <Button
            variant="outline"
            className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            I already have an account
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}
