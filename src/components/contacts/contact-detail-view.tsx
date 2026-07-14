'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useOpenContactChat } from '@/hooks/use-open-contact-chat';
import { formatCurrency } from '@/lib/currency';
import { formatPhoneDisplay } from '@/lib/whatsapp/phone-utils';
import { isCompletePhoneNumber } from '@/lib/whatsapp/phone-input-logic';
import { toast } from 'sonner';
import type { MessageTemplate } from '@/types';
import {
  convexErrorMessage,
  toUiContactCustomValue,
  toUiContactNote,
  toUiCustomField,
  toUiContact,
  toUiDeal,
  toUiTag,
} from '@/lib/convex/adapters';
import {
  TemplatePicker,
  type TemplateSendValues,
} from '@/components/inbox/template-picker';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/ui/phone-input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Save,
  DollarSign,
  LayoutTemplate,
  Hash,
  MessageSquare,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDetailViewProps) {
  const t = useTranslations('Contacts.detailView');
  const { defaultCurrency } = useAuth();
  const canEdit = useCan('send-messages');

  const [copiedPhone, setCopiedPhone] = useState(false);
  const openChat = useOpenContactChat();
  const [copiedId, setCopiedId] = useState(false);

  // Send template — lets the business initiate (or re-open) a conversation
  // with this contact by sending an approved template. The send route
  // find-or-creates the conversation, so no inbound message is required.
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);

  // Details tab
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);
  // Live validity of the composed `+E.164` value — same reasoning as
  // `contact-form.tsx`'s `phoneInvalid`: `PhoneInput`'s `composeE164`
  // falls back to `+<dialCode><digits>` for incomplete input, so this is
  // computed straight from `editPhone` (no "touched" flag) so the inline
  // error appears as the user types.
  const editPhoneInvalid =
    editPhone.trim().length > 0 && !isCompletePhoneNumber(editPhone);

  // Tags tab
  const [savingTags, setSavingTags] = useState(false);

  // Notes tab
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  // Custom fields tab
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);

  // Only subscribe while the sheet is actually showing a contact — mirrors
  // the original's `if (open && contactId)` fetch gate.
  const shouldLoad = open && !!contactId;
  const idArg = shouldLoad ? { contactId: contactId as Id<'contacts'> } : 'skip';

  const contactDoc = useQuery(api.contacts.get, idArg);
  const contact = useMemo(
    () => (contactDoc ? toUiContact(contactDoc) : null),
    [contactDoc],
  );
  const loading = shouldLoad && contactDoc === undefined;

  const allTagsResult = useQuery(api.tags.list, open ? {} : 'skip');
  const allTags = useMemo(
    () => (allTagsResult ?? []).map(toUiTag),
    [allTagsResult],
  );
  const contactTagIds = useMemo(
    () => (contact?.tags ?? []).map((tag) => tag.id),
    [contact],
  );

  const notesResult = useQuery(api.contactNotes.listForContact, idArg);
  const notes = useMemo(
    () => (notesResult ?? []).map(toUiContactNote),
    [notesResult],
  );
  const loadingNotes = shouldLoad && notesResult === undefined;

  const customFieldsResult = useQuery(api.customFields.list, open ? {} : 'skip');
  const customFields = useMemo(
    () => (customFieldsResult ?? []).map(toUiCustomField),
    [customFieldsResult],
  );
  const customValuesResult = useQuery(api.customFields.getForContact, idArg);
  const loadingCustom = shouldLoad && customValuesResult === undefined;

  // Deals tab — `deals.listByContact` already embeds each deal's stage
  // (see convex/deals.ts), the same shape `toUiDeal` expects.
  const dealsResult = useQuery(api.deals.listByContact, idArg);
  const deals = useMemo(() => (dealsResult ?? []).map(toUiDeal), [dealsResult]);
  const loadingDeals = shouldLoad && dealsResult === undefined;

  // Seed the editable custom-values map from the reactive read — mirrors
  // the original `fetchCustomFields`'s one-time seed of local form state.
  useEffect(() => {
    if (customValuesResult) {
      const map: Record<string, string> = {};
      customValuesResult.forEach((value) => {
        const uiValue = toUiContactCustomValue(value);
        map[uiValue.custom_field_id] = uiValue.value ?? '';
      });
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local editable form state from a reactive Convex read, same pattern as the original imperative fetch this replaces
      setCustomValues(map);
    }
  }, [customValuesResult]);

  const sendMessage = useAction(api.send.send);
  const updateContact = useMutation(api.contacts.update);
  const assignTag = useMutation(api.contacts.assignTag);
  const unassignTag = useMutation(api.contacts.unassignTag);
  const addNoteMutation = useMutation(api.contactNotes.add);
  const removeNoteMutation = useMutation(api.contactNotes.remove);
  const setCustomFieldsForContact = useMutation(api.customFields.setForContact);

  useEffect(() => {
    if (contact) {
      setEditName(contact.name ?? '');
      setEditPhone(contact.phone);
      setEditEmail(contact.email ?? '');
      setEditCompany(contact.company ?? '');
    }
  }, [contact]);

  async function copyPhone() {
    if (!contact) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  async function saveDetails() {
    if (!contactId || !editPhone.trim()) {
      toast.error(t('toastPhoneRequired'));
      return;
    }

    if (!isCompletePhoneNumber(editPhone)) {
      toast.error(t('phoneInvalid'));
      return;
    }

    setSavingDetails(true);
    try {
      await updateContact({
        contactId: contactId as Id<'contacts'>,
        name: editName.trim(),
        phone: editPhone.trim(),
        email: editEmail.trim(),
        company: editCompany.trim(),
      });
      toast.success(t('toastUpdated'));
      onUpdated();
    } catch {
      toast.error(t('toastUpdateFailed'));
    }
    setSavingDetails(false);
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTags(true);
    try {
      const isSelected = contactTagIds.includes(tagId);
      if (isSelected) {
        await unassignTag({
          contactId: contactId as Id<'contacts'>,
          tagId: tagId as Id<'tags'>,
        });
      } else {
        await assignTag({
          contactId: contactId as Id<'contacts'>,
          tagId: tagId as Id<'tags'>,
        });
      }
      onUpdated();
    } catch (err) {
      toast.error(convexErrorMessage(err));
    }
    setSavingTags(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);
    try {
      await addNoteMutation({
        contactId: contactId as Id<'contacts'>,
        body: newNote.trim(),
      });
      setNewNote('');
      toast.success(t('toastNoteAdded'));
    } catch {
      toast.error(t('toastNoteAddFailed'));
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    try {
      await removeNoteMutation({ noteId: noteId as Id<'contactNotes'> });
      toast.success(t('toastNoteDeleted'));
    } catch {
      toast.error(t('toastNoteDeleteFailed'));
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);
    try {
      const values = Object.entries(customValues)
        .filter(([, val]) => val.trim())
        .map(([fieldId, val]) => ({
          customFieldId: fieldId as Id<'customFields'>,
          value: val.trim(),
        }));

      await setCustomFieldsForContact({
        contactId: contactId as Id<'contacts'>,
        values,
      });

      toast.success(t('toastCustomFieldsSaved'));
    } catch {
      toast.error(t('toastCustomFieldsFailed'));
    }
    setSavingCustom(false);
  }

  async function handleSendTemplate(
    template: MessageTemplate,
    values: TemplateSendValues,
  ) {
    if (!contactId) return;
    setSendingTemplate(true);
    try {
      await sendMessage({
        // No conversationId — the action find-or-creates one for this
        // contact, mirroring the inbox template-send payload otherwise.
        contactId: contactId as Id<'contacts'>,
        messageType: 'template',
        templateName: template.name,
        templateLanguage: template.language,
        // `api.send.send` only threads body variables through today — see
        // `src/components/inbox/message-thread.tsx`'s own comment on why
        // `values.headerText`/`values.buttonParams` have no Convex-side
        // equivalent yet.
        templateParams: values.body,
      });

      toast.success(t('toastTemplateSent', { name: template.name }));
    } catch (err) {
      toast.error(t('toastTemplateFailed', { reason: convexErrorMessage(err) }));
    } finally {
      setSendingTemplate(false);
    }
  }

  function getInitials(name?: string | null) {
    if (!name) return '?';
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        {loading || !contact ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Header */}
            <SheetHeader className="p-4 border-b border-border/50">
              <div className="flex items-center gap-3">
                <Avatar className="size-12 bg-muted border border-border">
                  <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                    {getInitials(contact.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <SheetTitle className="text-popover-foreground truncate">
                    {contact.name || t('unnamed')}
                  </SheetTitle>
                  <SheetDescription className="text-muted-foreground text-xs mt-0.5">
                    {t('contactDetailsDesc')}
                  </SheetDescription>
                  <div className="flex flex-wrap items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                    <button
                      onClick={copyPhone}
                      className="flex items-center gap-1 hover:text-primary transition-colors cursor-pointer"
                    >
                      <Phone className="size-3" />
                      {formatPhoneDisplay(contact.phone)}
                      {copiedPhone ? (
                        <Check className="size-3 text-primary" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                    {contact.contact_code && (
                      <button
                        type="button"
                        onClick={async () => {
                          await navigator.clipboard.writeText(contact.contact_code!);
                          setCopiedId(true);
                          setTimeout(() => setCopiedId(false), 2000);
                        }}
                        className="flex items-center gap-1 font-mono hover:text-primary transition-colors cursor-pointer"
                        aria-label={t('copyId')}
                      >
                        <Hash className="size-3" />
                        {contact.contact_code}
                        {copiedId ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
                      </button>
                    )}
                    {contact.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="size-3" />
                        {contact.email}
                      </span>
                    )}
                    {contact.company && (
                      <span className="flex items-center gap-1">
                        <Building2 className="size-3" />
                        {contact.company}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                {canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void openChat(contact.id)}
                    className="border-border text-muted-foreground hover:bg-muted"
                  >
                    <MessageSquare className="size-4" />
                    {t('openChatBtn')}
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => setTemplatePickerOpen(true)}
                  disabled={sendingTemplate}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {sendingTemplate ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <LayoutTemplate className="size-4" />
                  )}
                  {t('sendTemplateBtn')}
                </Button>
              </div>
            </SheetHeader>

            {/* Tabs */}
            <Tabs defaultValue="details" className="flex-1 flex flex-col min-h-0">
              <TabsList className="bg-muted/50 border-b border-border mx-4 mt-3">
                <TabsTrigger
                  value="details"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.details')}
                </TabsTrigger>
                <TabsTrigger
                  value="tags"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.tags')}
                </TabsTrigger>
                <TabsTrigger
                  value="notes"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.notes')}
                </TabsTrigger>
                <TabsTrigger
                  value="custom"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.custom')}
                </TabsTrigger>
                <TabsTrigger
                  value="deals"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  {t('tabs.deals')}
                </TabsTrigger>
              </TabsList>

              {/* Details Tab */}
              <TabsContent value="details" className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('name')}</Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      {t('phone')} <span className="text-red-400">*</span>
                    </Label>
                    <PhoneInput
                      value={editPhone}
                      onChange={setEditPhone}
                    />
                    {editPhoneInvalid && (
                      <p className="text-xs text-red-400">{t('phoneInvalid')}</p>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('email')}</Label>
                    <Input
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">{t('company')}</Label>
                    <Input
                      value={editCompany}
                      onChange={(e) => setEditCompany(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <Button
                    onClick={saveDetails}
                    disabled={savingDetails}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                    size="sm"
                  >
                    {savingDetails ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                    {t('saveChangesBtn')}
                  </Button>
                </div>
              </TabsContent>

              {/* Tags Tab */}
              <TabsContent value="tags" className="flex-1 overflow-y-auto px-4 py-3">
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {t('tagsTab.clickTagDesc')}
                  </p>
                  {allTags.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('tagsTab.noTagsAvailable')}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allTags.map((tag) => {
                        const selected = contactTagIds.includes(tag.id);
                        return (
                          <button
                            key={tag.id}
                            onClick={() => toggleTag(tag.id)}
                            disabled={savingTags}
                            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium transition-all cursor-pointer ${
                              selected
                                ? 'ring-2 ring-primary ring-offset-1 ring-offset-border'
                                : 'opacity-50 hover:opacity-80'
                            }`}
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {selected && <Check className="size-3 mr-1" />}
                            {tag.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* Notes Tab */}
              <TabsContent value="notes" className="flex-1 flex flex-col min-h-0 px-4 py-3">
                <div className="space-y-2 mb-3">
                  <Textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder={t('notesTab.placeholder')}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground min-h-[60px] text-sm resize-none"
                  />
                  <Button
                    onClick={addNote}
                    disabled={!newNote.trim() || savingNote}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground"
                    size="sm"
                  >
                    {savingNote ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    {t('notesTab.save')}
                  </Button>
                </div>

                <div className="flex-1 overflow-y-auto space-y-2">
                  {loadingNotes ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : notes.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-8">
                      {t('notesTab.noNotes')}
                    </p>
                  ) : (
                    notes.map((note) => (
                      <div
                        key={note.id}
                        className="rounded-lg bg-muted/50 border border-border/50 p-3 group"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm text-muted-foreground whitespace-pre-wrap flex-1">
                            {note.note_text}
                          </p>
                          <button
                            onClick={() => deleteNote(note.id)}
                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400 transition-all cursor-pointer shrink-0"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1.5">
                          {new Date(note.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </TabsContent>

              {/* Custom Fields Tab */}
              <TabsContent value="custom" className="flex-1 overflow-y-auto px-4 py-3">
                {loadingCustom ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : customFields.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    {t('noCustomFields')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    {customFields.map((field) => (
                      <div key={field.id} className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs capitalize">
                          {field.field_name}
                        </Label>
                        <Input
                          value={customValues[field.id] ?? ''}
                          onChange={(e) =>
                            setCustomValues((prev) => ({
                              ...prev,
                              [field.id]: e.target.value,
                            }))
                          }
                          placeholder={t('enterCustomField', { name: field.field_name })}
                          className="bg-muted border-border text-foreground h-8 text-sm placeholder:text-muted-foreground"
                        />
                      </div>
                    ))}
                    <Button
                      onClick={saveCustomFields}
                      disabled={savingCustom}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                      size="sm"
                    >
                      {savingCustom ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      {t('saveCustomFieldsBtn')}
                    </Button>
                  </div>
                )}
              </TabsContent>

              {/* Deals Tab */}
              <TabsContent value="deals" className="flex-1 overflow-y-auto px-4 py-3">
                {loadingDeals ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="size-5 animate-spin text-primary" />
                  </div>
                ) : deals.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('dealsTab.noDeals')}</p>
                ) : (
                  <div className="space-y-2">
                    {deals.map((deal) => (
                      <div
                        key={deal.id}
                        className="rounded-lg border border-border bg-muted/50 p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-medium text-foreground">
                            {deal.title}
                          </p>
                          {deal.stage && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                backgroundColor: `${deal.stage.color}20`,
                                color: deal.stage.color,
                              }}
                            >
                              {deal.stage.name}
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <DollarSign className="size-3" />
                            {formatCurrency(
                              deal.value ?? 0,
                              deal.currency || defaultCurrency,
                            )}
                          </span>
                          {deal.status && deal.status !== 'open' && (
                            <span
                              className={
                                deal.status === 'won'
                                  ? 'text-primary'
                                  : 'text-red-400'
                              }
                            >
                              {deal.status}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
    <TemplatePicker
      open={templatePickerOpen}
      onOpenChange={setTemplatePickerOpen}
      onSelect={handleSendTemplate}
    />
    </>
  );
}
