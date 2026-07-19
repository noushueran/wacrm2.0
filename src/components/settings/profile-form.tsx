'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Upload, Trash2, CircleAlert } from 'lucide-react';
import { useConvex, useMutation } from 'convex/react';

import { useAuth } from '@/hooks/use-auth';
import { convexErrorMessage } from '@/lib/convex/adapters';
import { uploadAccountMedia } from '@/lib/storage/upload-media';
import { mediaUrlFromKey } from '@/lib/storage/media-url';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';

import { api } from '../../../convex/_generated/api';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export function ProfileForm() {
  const t = useTranslations('Settings.profile');
  const { user, profile } = useAuth();
  const convex = useConvex();
  const startUpload = useMutation(api.files.startUpload);
  const updateProfile = useMutation(api.accounts.updateProfile);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fullName, setFullName] = useState('');
  const [pendingAvatar, setPendingAvatar] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed form state once the profile loads.
  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? '');
  }, [profile]);

  // Cleanup object URLs to avoid leaks.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const currentAvatar =
    previewUrl ?? (!removeAvatar ? profile?.avatar_url ?? null : null);

  const initial = (fullName || profile?.full_name || profile?.email || 'U')
    .charAt(0)
    .toUpperCase();

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so the same file can be re-picked
    if (!file) return;

    if (!ALLOWED_MIME.has(file.type)) {
      toast.error(t('unsupportedImage'), {
        description: t('unsupportedImageDesc'),
      });
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error(t('imageTooLarge'), {
        description: t('imageTooLargeDesc'),
      });
      return;
    }

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingAvatar(file);
    setPreviewUrl(URL.createObjectURL(file));
    setRemoveAvatar(false);
  };

  const onRemoveAvatar = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingAvatar(null);
    setPreviewUrl(null);
    setRemoveAvatar(true);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;

    const trimmedName = fullName.trim();
    if (!trimmedName) {
      toast.error(t('nameRequired'));
      return;
    }

    setSaving(true);
    try {
      // `undefined` = no avatar change — the mutation's `avatarKey`/
      // `avatarUrl` args are each patched only when supplied (see
      // convex/accounts.ts's `updateProfile` doc comment).
      let nextAvatarKey: string | undefined;
      let nextAvatarUrl: string | undefined;

      if (pendingAvatar) {
        // R2 upload: the server mints a key inside this account's own
        // prefix and a short-lived presigned PUT URL for it; the browser
        // PUTs the file bytes straight to R2 — never through Convex or
        // the VPS. Unlike the old Convex-storage flow there is no
        // separate "register ownership" round trip (ownership is
        // guaranteed by construction — the key's account segment is
        // minted server-side from the caller's own session) and no
        // "resolve to a URL" round trip either (a fetchable URL is pure
        // string concatenation from the key, done at READ time by
        // `src/hooks/use-auth.tsx`, not here).
        const { key } = await uploadAccountMedia(
          convex,
          startUpload,
          pendingAvatar,
          'avatar',
        );
        // Same null guard `template-manager.tsx` and `node-config-form.tsx`
        // use after their own `uploadAccountMedia` call: without it, a save
        // with `NEXT_PUBLIC_R2_PUBLIC_HOST` unset would still "succeed"
        // (the mutation patches `avatarKey` fine), but `resolveMediaUrl`
        // (`src/hooks/use-auth.tsx`) can't turn that key into a URL and
        // falls back to the STALE previous `avatarUrl` — the user sees
        // their old avatar after a "successful" save, with only a
        // `console.error` to explain why. Failing loudly here instead
        // surfaces it as the same toast error the other two upload flows
        // already give.
        if (!mediaUrlFromKey(key)) {
          throw new Error(
            "Uploaded, but the public media host isn't configured yet.",
          );
        }
        nextAvatarKey = key;
      } else if (removeAvatar) {
        // Clear both: a stale key would otherwise keep winning over an
        // empty url in `resolveMediaUrl`'s "key wins whenever present"
        // precedence, silently undoing the removal.
        nextAvatarKey = '';
        nextAvatarUrl = '';
      }

      await updateProfile({
        name: trimmedName,
        ...(nextAvatarKey !== undefined ? { avatarKey: nextAvatarKey } : {}),
        ...(nextAvatarUrl !== undefined ? { avatarUrl: nextAvatarUrl } : {}),
      });

      setPendingAvatar(null);
      setPreviewUrl(null);
      setRemoveAvatar(false);
      toast.success(t('profileSaved'));
    } catch (err) {
      console.error('[ProfileForm] save error:', err);
      toast.error(convexErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    !!profile &&
    (fullName.trim() !== (profile.full_name ?? '') ||
      pendingAvatar !== null ||
      removeAvatar);

  const joined = user?.created_at
    ? new Date(user.created_at).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : '—';

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />
      <form onSubmit={onSubmit} className="space-y-4">
        <Card>
          <CardContent className="space-y-6">
          {/* Avatar row */}
          <div className="flex flex-wrap items-center gap-5">
            <Avatar size="lg" className="size-16">
              {currentAvatar ? (
                <AvatarImage src={currentAvatar} alt={fullName || 'Avatar'} />
              ) : null}
              <AvatarFallback className="bg-primary/10 text-base text-primary">
                {initial}
              </AvatarFallback>
            </Avatar>

            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={onPickFile}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={saving}
              >
                <Upload className="size-4" />
                {currentAvatar ? t('changePhoto') : t('uploadPhoto')}
              </Button>
              {currentAvatar && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onRemoveAvatar}
                  disabled={saving}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="size-4" />
                  {t('remove')}
                </Button>
              )}
              <p className="w-full text-xs text-muted-foreground">
                {t('photoHint')}
              </p>
            </div>
          </div>

          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="profile-full-name" className="text-foreground">
              {t('displayName')}
            </Label>
            <Input
              id="profile-full-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Ada Lovelace"
              maxLength={120}
              disabled={saving}
              required
            />
          </div>

          {/* Email — read-only. Convex Auth here is the Password
              provider with no email provider configured, so there is no
              in-app email-change flow to wire up (see the settings
              Security-section removal in this same change). */}
          <div className="space-y-2">
            <Label htmlFor="profile-email" className="text-foreground">
              {t('email')}
            </Label>
            <Input
              id="profile-email"
              type="email"
              value={profile?.email ?? ''}
              disabled
              readOnly
            />
            <p className="text-xs text-muted-foreground">
              {t('emailReadOnlyHint')}
            </p>
          </div>

          {/* Read-only block */}
          <div className="rounded-lg border border-border bg-muted p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('accountDetails')}
            </p>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t('role')}</dt>
                <dd className="mt-0.5 font-mono text-foreground">
                  {profile?.role ?? 'user'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('joined')}</dt>
                <dd className="mt-0.5 text-foreground">{joined}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-muted-foreground">{t('userId')}</dt>
                <dd className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                  {user?.id ?? '—'}
                </dd>
              </div>
            </dl>
          </div>

          {!profile && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CircleAlert className="size-4" />
              {t('loading')}
            </p>
          )}

        </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving || !dirty || !profile}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('saveChanges')
            )}
          </Button>
        </div>
      </form>
    </section>
  );
}
