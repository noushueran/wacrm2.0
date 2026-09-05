'use client';

import { useTranslations } from 'next-intl';
import { LogOut, UserRoundX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

/**
 * What an authenticated user sees when they belong to no account.
 *
 * This state used to be unreachable: `AuthProvider` silently called
 * `accounts.bootstrapAccount` for anyone whose `me` came back `null`, so
 * a membership-less user was handed a private one-person account within a
 * render or two. That backstop is gone, because it re-minted the very
 * shell account `members.remove` stopped creating — and a shell account
 * with anything in it makes `invitations.redeem` refuse to move its owner
 * into the inviting account, leaving a removed teammate permanently
 * un-re-invitable under their own email.
 *
 * So there is DELIBERATELY no "create your own workspace" button here.
 * This is a staff CRM, not a self-serve product: nobody removed from a
 * team wants a private empty CRM, and handing them one is exactly how
 * they end up locked out of rejoining. The two honest exits are an invite
 * link from an admin, or signing out.
 *
 * Presentational on purpose — `onSignOut` is a prop rather than a
 * `useAuth()` call so the screen renders under `renderToStaticMarkup` in
 * its test, matching `ConversionHoldBanner`'s split.
 */
export function NoWorkspace({
  email,
  onSignOut,
  signingOut = false,
}: {
  email: string | null;
  onSignOut: () => void;
  signingOut?: boolean;
}) {
  const t = useTranslations('NoWorkspace');

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <Card
        className="w-full max-w-md border-border bg-card"
        data-testid="no-workspace"
      >
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-amber-500/10">
            <UserRoundX className="h-6 w-6 text-amber-400" />
          </div>
          <CardTitle className="text-xl text-foreground">
            {t('title')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('body')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {email ? (
            <p
              className="text-center text-xs text-muted-foreground"
              data-testid="no-workspace-email"
            >
              {t('signedInAs')}{' '}
              <span className="text-foreground">{email}</span>
            </p>
          ) : null}
          <Button
            variant="outline"
            onClick={onSignOut}
            disabled={signingOut}
            data-testid="no-workspace-sign-out"
            className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <LogOut className="size-4" />
            {signingOut ? t('signingOut') : t('signOut')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
