'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import type { Contact } from '@/types';
import {
  convexErrorData,
  convexErrorMessage,
  isConvexErrorCode,
  toUiContact,
  toUiTag,
} from '@/lib/convex/adapters';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Label } from '@/components/ui/label';
import { Loader2, AlertTriangle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

interface ContactFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  onSaved: () => void;
  /** Open an existing contact's detail view — used by the duplicate
   *  notice to jump to the contact that already owns this number. */
  onViewExisting?: (contactId: string) => void;
}

export function ContactForm({
  open,
  onOpenChange,
  contact,
  onSaved,
  onViewExisting,
}: ContactFormProps) {
  const t = useTranslations('Contacts.form');
  const isEdit = !!contact;

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [saving, setSaving] = useState(false);

  // Selected tags for this contact (seeded from `contact.tags`, already
  // embedded by `contacts.list`/`filterByTags`/`contacts.get` — no
  // separate join-table fetch needed the way the Supabase version required).
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  // Duplicate-phone notice. Convex only exposes an EXACT hard-block (the
  // `create`/`update` mutations' own `phoneNormalized` dedup, surfaced as
  // a `DUPLICATE_PHONE` ConvexError carrying the conflicting contact's
  // id) — there is no query to proactively search contacts by phone, so
  // the Supabase-era on-blur "similar number" fuzzy pre-check
  // (`findExistingContact`/`isExactMatch` in `@/lib/contacts/dedupe`,
  // which queried the whole account's contacts client-side) has no
  // Convex equivalent and is dropped. The hard block itself is fully
  // preserved — it just surfaces on submit instead of on blur. Once a
  // `DUPLICATE_PHONE` error names the conflicting contact's id, this
  // reactively hydrates it via the new `contacts.get` query so the
  // "View existing" link still shows a name, same as before.
  const [dupContactId, setDupContactId] = useState<Id<'contacts'> | null>(
    null,
  );
  const dupContactDoc = useQuery(
    api.contacts.get,
    dupContactId ? { contactId: dupContactId } : 'skip',
  );
  const dupContact = dupContactDoc ? toUiContact(dupContactDoc) : null;

  const tagsResult = useQuery(api.tags.list);
  const tags = useMemo(
    () => (tagsResult ?? []).map(toUiTag),
    [tagsResult],
  );
  const loadingTags = tagsResult === undefined;

  const createContact = useMutation(api.contacts.create);
  const updateContact = useMutation(api.contacts.update);
  const assignTag = useMutation(api.contacts.assignTag);
  const unassignTag = useMutation(api.contacts.unassignTag);

  useEffect(() => {
    if (open) {
      setName(contact?.name ?? '');
      setPhone(contact?.phone ?? '');
      setEmail(contact?.email ?? '');
      setCompany(contact?.company ?? '');
      setSelectedTagIds((contact?.tags ?? []).map((tag) => tag.id));
      setDupContactId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contact]);

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!phone.trim()) {
      toast.error(t('phoneRequired'));
      return;
    }

    setSaving(true);

    try {
      let contactId: Id<'contacts'>;

      if (isEdit && contact) {
        contactId = contact.id as Id<'contacts'>;
        await updateContact({
          contactId,
          name: name.trim(),
          phone: phone.trim(),
          email: email.trim(),
          company: company.trim(),
        });
      } else {
        contactId = await createContact({
          phone: phone.trim(),
          name: name.trim(),
          email: email.trim(),
          company: company.trim(),
        });
      }

      // Sync tags: diff the selection against the contact's previous
      // tags and only touch what changed (Convex has no bulk "set tags"
      // mutation — `assignTag`/`unassignTag` are per-tag, and both are
      // idempotent, so this is safe to call even for a no-op diff).
      const previousTagIds = new Set(
        (contact?.tags ?? []).map((tag) => tag.id),
      );
      const nextTagIds = new Set(selectedTagIds);
      const toAssign = [...nextTagIds].filter(
        (id) => !previousTagIds.has(id),
      );
      const toUnassign = [...previousTagIds].filter(
        (id) => !nextTagIds.has(id),
      );
      await Promise.all([
        ...toAssign.map((tagId) =>
          assignTag({ contactId, tagId: tagId as Id<'tags'> }),
        ),
        ...toUnassign.map((tagId) =>
          unassignTag({ contactId, tagId: tagId as Id<'tags'> }),
        ),
      ]);

      toast.success(isEdit ? t('toastSuccessEdit') : t('toastSuccessAdd'));
      onOpenChange(false);
      onSaved();
    } catch (err: unknown) {
      // The `phoneNormalized` unique index (contacts.by_account_phone)
      // rejects a duplicate phone — surface it as the friendly duplicate
      // notice and, for new contacts, point the user at the existing
      // record via the id the error itself names.
      if (isConvexErrorCode(err, 'DUPLICATE_PHONE')) {
        toast.error(t('toastConflict'));
        const conflictingId = convexErrorData(err)?.contactId;
        if (typeof conflictingId === 'string') {
          setDupContactId(conflictingId as Id<'contacts'>);
        }
        return;
      }
      toast.error(convexErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isEdit ? t('editTitle') : t('addTitle')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {isEdit
              ? t('editDesc')
              : t('addDesc')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="cf-name" className="text-muted-foreground">
              {t('nameLabel')}
            </Label>
            <Input
              id="cf-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-phone" className="text-muted-foreground">
              {t('phoneLabel')} <span className="text-red-400">*</span>
            </Label>
            <PhoneInput
              id="cf-phone"
              value={phone}
              onChange={(next) => {
                setPhone(next);
                if (dupContactId) setDupContactId(null);
              }}
              placeholder={t('phonePlaceholder')}
            />
            {dupContact ? (
              <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-2 text-xs text-red-300">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <div className="space-y-1">
                  <p>{t('dupExact')}</p>
                  {onViewExisting && (
                    <button
                      type="button"
                      onClick={() => onViewExisting(dupContact.id)}
                      className="font-medium underline underline-offset-2 hover:no-underline"
                    >
                      {t('viewExisting', { name: dupContact.name || dupContact.phone })}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t('phoneHint')}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-email" className="text-muted-foreground">
              {t('emailLabel')}
            </Label>
            <Input
              id="cf-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t('emailPlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="cf-company" className="text-muted-foreground">
              {t('companyLabel')}
            </Label>
            <Input
              id="cf-company"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder={t('companyPlaceholder')}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('tagsLabel')}</Label>
            {loadingTags ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <Loader2 className="size-3 animate-spin" />
                {t('loadingTags')}
              </div>
            ) : tags.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t('noTagsAvailable')}
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => {
                  const selected = selectedTagIds.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors cursor-pointer ${
                        selected
                          ? 'ring-2 ring-primary ring-offset-1 ring-offset-border'
                          : 'opacity-60 hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: tag.color + '20',
                        color: tag.color,
                        borderColor: tag.color,
                      }}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <DialogFooter className="bg-popover border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              type="submit"
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? t('update') : t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
