'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { api } from '../../../convex/_generated/api';
import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { THEMES } from '@/lib/themes';
import { CURRENCIES } from '@/lib/currency';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

import { SECTION_META, type SettingsSection } from './settings-sections';
import { SettingsChip, StatusDot } from './settings-chip';
import { ROLE_META } from './role-meta';

export function SettingsOverview({
  onSelect,
}: {
  onSelect: (section: SettingsSection) => void;
}) {
  const { user, profile, accountId, accountRole, defaultCurrency, canManageMembers } =
    useAuth();
  const { mode, theme } = useTheme();
  const t = useTranslations('Settings.overview');
  const tRoles = useTranslations('Settings.roles');
  const tSections = useTranslations('Settings.sections');

  // Members roster + pending invites still go through the Next.js
  // `/api/account/*` routes (out of scope for this Convex UI rewire —
  // teardown's job), not a direct Supabase read from this component.
  const [membersCount, setMembersCount] = useState<number | null>(null);
  const [pendingInvites, setPendingInvites] = useState<number | null>(null);
  const [membersLoading, setMembersLoading] = useState(true);

  // WhatsApp connection *health* is still a slow, independent Meta ping
  // via `/api/whatsapp/config` (decrypts the token and calls out — far
  // slower than the cheap Convex reads below, so it's kept on its own
  // loading flag rather than blocking the rest of the tiles). Whether a
  // config row exists at all (`whatsappConfigResult` below) now comes
  // from the reactive `api.whatsappConfig.get` query instead of a
  // Supabase select.
  const [whatsappConnected, setWhatsappConnected] = useState(false);
  const [whatsappHealthLoading, setWhatsappHealthLoading] = useState(true);

  useEffect(() => {
    if (!user || !accountId) return;
    let cancelled = false;

    // Members + pending invites — resolve fast, render immediately.
    (async () => {
      setMembersLoading(true);
      const [membersRes, invitesRes] = await Promise.allSettled([
        fetch('/api/account/members', { cache: 'no-store' }).then((r) => r.json()),
        canManageMembers
          ? fetch('/api/account/invitations', { cache: 'no-store' }).then((r) =>
              r.json(),
            )
          : Promise.resolve(null),
      ]);
      if (cancelled) return;

      const members =
        membersRes.status === 'fulfilled' && Array.isArray(membersRes.value?.members)
          ? membersRes.value.members.length
          : null;
      const invites =
        invitesRes.status === 'fulfilled' &&
        invitesRes.value &&
        Array.isArray(invitesRes.value.invitations)
          ? invitesRes.value.invitations.length
          : null;

      setMembersCount(members);
      setPendingInvites(invites);
      setMembersLoading(false);
    })();

    // WhatsApp connection health — slower, independent.
    (async () => {
      setWhatsappHealthLoading(true);
      const health = await fetch('/api/whatsapp/config', { cache: 'no-store' })
        .then((r) => r.json())
        .catch(() => null);
      if (cancelled) return;
      setWhatsappConnected(!!health?.connected);
      setWhatsappHealthLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user?.id, accountId, canManageMembers]);

  // Templates / tags / custom fields / WhatsApp-config-row — reactive
  // Convex reads (Phase 8/9 stragglers rewire), replacing the one-shot
  // Supabase count queries this effect used to also run. Each tile below
  // gates on its own query's `loading` flag, so these need no `'skip'`
  // gating of their own — mirrors `template-manager.tsx`'s unconditional
  // `useQuery(api.templates.list)`.
  const templatesResult = useQuery(api.templates.list);
  const templatesLoading = templatesResult === undefined;
  const templatesPendingCount = useMemo(
    () => (templatesResult ?? []).filter((tpl) => tpl.status === 'PENDING').length,
    [templatesResult],
  );

  const tagsResult = useQuery(api.tags.list);
  const tagsLoading = tagsResult === undefined;

  const customFieldsResult = useQuery(api.customFields.list);
  const customFieldsLoading = customFieldsResult === undefined;

  const whatsappConfigResult = useQuery(api.whatsappConfig.get);
  const whatsappConfigLoading = whatsappConfigResult === undefined;

  const displayName = profile?.full_name || profile?.email || t('yourAccount');
  const initial = (profile?.full_name || profile?.email || 'U').charAt(0).toUpperCase();
  const roleMeta = accountRole ? ROLE_META[accountRole] : null;
  const RoleIcon = roleMeta?.icon;

  const currencyLabel =
    CURRENCIES.find((c) => c.code === defaultCurrency)?.label ?? defaultCurrency;
  const themeName = THEMES.find((t) => t.id === theme)?.name ?? theme;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  // Per-tile loading + subtitle. Each tile's own `loading` flag renders a
  // spinner INSTEAD of `subtitle` (see the render below), so a
  // Convex-backed subtitle only ever paints once its query has resolved
  // — unlike the REST-backed members tile, there's no "resolved but
  // failed" state to gracefully degrade for those, since a Convex query
  // is either still loading (`undefined`) or a real resolved value.
  const tiles: {
    section: SettingsSection;
    loading: boolean;
    subtitle: ReactNode;
  }[] = [
    {
      section: 'whatsapp',
      loading: whatsappConfigLoading || whatsappHealthLoading,
      subtitle: !whatsappConfigResult?.phoneNumberId ? (
        t('notSetup')
      ) : whatsappConnected ? (
        <>
          <StatusDot tone="ok" /> {t('connected')}
        </>
      ) : (
        <>
          <StatusDot tone="muted" /> {t('needsReconnecting')}
        </>
      ),
    },
    {
      section: 'members',
      loading: membersLoading,
      subtitle:
        membersCount == null
          ? t('viewTeamMembers')
          : `${t('membersCount', { count: membersCount })}${
              pendingInvites
                ? ` · ${t('pendingInvites', { count: pendingInvites })}`
                : ''
            }`,
    },
    {
      section: 'templates',
      loading: templatesLoading,
      subtitle: `${t('templatesCount', { count: templatesResult?.length ?? 0 })}${
        templatesPendingCount
          ? ` · ${t('pendingReview', { count: templatesPendingCount })}`
          : ''
      }`,
    },
    {
      section: 'deals',
      loading: false,
      subtitle: `${defaultCurrency} — ${currencyLabel}`,
    },
    {
      section: 'fields',
      loading: tagsLoading || customFieldsLoading,
      subtitle: `${t('tagsCount', { count: tagsResult?.length ?? 0 })} · ${t('fieldsCount', {
        count: customFieldsResult?.length ?? 0,
      })}`,
    },
    {
      section: 'appearance',
      loading: false,
      subtitle: t('appearance', { mode: cap(mode), theme: themeName }),
    },
  ];

  return (
    <section className="animate-in fade-in-50 duration-200">
      {/* Identity */}
      <Card className="flex-row items-center gap-4 px-5 py-5">
        <Avatar size="lg" className="size-14">
          {profile?.avatar_url ? (
            <AvatarImage src={profile.avatar_url} alt={displayName} />
          ) : null}
          <AvatarFallback className="bg-primary/10 text-xl text-primary">
            {initial}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-foreground">
            {displayName}
          </div>
          {profile?.email ? (
            <div className="truncate text-sm text-muted-foreground">
              {profile.email}
            </div>
          ) : null}
        </div>
        {roleMeta && RoleIcon ? (
          <SettingsChip variant={roleMeta.variant}>
            <RoleIcon />
            {tRoles(accountRole!)}
          </SettingsChip>
        ) : null}
      </Card>

      {/* Status tiles */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {tiles.map(({ section, loading, subtitle }) => {
          const meta = SECTION_META[section];
          const Icon = meta.icon;
          return (
            <button
              key={section}
              type="button"
              onClick={() => onSelect(section)}
              className={cn(
                'group flex items-start gap-3.5 rounded-xl border border-border bg-card p-4 text-left transition-colors',
                'hover:border-primary-soft-2 hover:bg-card-2',
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">
                  {tSections(section)}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {loading ? (
                    <>
                      <Loader2 className="size-3 animate-spin" /> {t('loading')}
                    </>
                  ) : (
                    subtitle
                  )}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          );
        })}
      </div>
    </section>
  );
}
