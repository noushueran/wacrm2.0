'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import type { CustomField } from '@/types';
import { isConvexErrorCode, toUiCustomField } from '@/lib/convex/adapters';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

interface CustomFieldsManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Maps a field's raw `field_type` (the machine value stored in Convex,
 *  e.g. "select") to its `Contacts.customFields` translation key — the same
 *  keys the create-field dropdown already uses — so the type badge in
 *  `FieldRow` doesn't leak an untranslated raw value. */
const TYPE_LABEL_KEY: Record<string, string> = {
  text: 'typeText',
  select: 'typeSelect',
  multiselect: 'typeMultiselect',
  date: 'typeDate',
  number: 'typeNumber',
};

/**
 * Dialog wrapper around {@link CustomFieldsPanel}, used on the Contacts page.
 * The same panel is rendered inline under Settings → Custom Fields, so the
 * editing UI lives in one place. Radix unmounts the dialog content on close,
 * so the panel remounts (and refetches) on each open.
 */
export function CustomFieldsManager({
  open,
  onOpenChange,
}: CustomFieldsManagerProps) {
  const t = useTranslations('Contacts.customFields');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('desc')}
          </DialogDescription>
        </DialogHeader>
        <CustomFieldsPanel />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Create / rename / delete account-wide custom contact field definitions.
 * Per-contact values are edited elsewhere (contact detail → Custom Fields);
 * this only manages the field catalogue. Admin+ gated by the caller (the
 * dashboard only renders this behind `canEditSettings`); `customFields.ts`'s
 * `ctx.requireRole("admin")` is the real backstop, same role floor the old
 * `custom_fields` RLS enforced.
 */
export function CustomFieldsPanel() {
  const t = useTranslations('Contacts.customFields');

  const fieldsResult = useQuery(api.customFields.list);
  const fields = useMemo(
    () => (fieldsResult ?? []).map(toUiCustomField),
    [fieldsResult],
  );
  const loading = fieldsResult === undefined;

  const createField = useMutation(api.customFields.create);
  const renameField = useMutation(api.customFields.rename);
  const removeField = useMutation(api.customFields.remove);
  const updateField = useMutation(api.customFields.update);

  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<
    'text' | 'select' | 'multiselect' | 'date' | 'number'
  >('text');
  const [newOptions, setNewOptions] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const isSelect = newType === 'select' || newType === 'multiselect';
    const options = newOptions
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);

    setCreating(true);
    try {
      await createField({
        fieldName: name,
        fieldType: newType,
        ...(isSelect && options.length ? { fieldOptions: { options } } : {}),
      });
      toast.success(t('toastCreated', { name }));
      setNewName('');
      setNewType('text');
      setNewOptions('');
    } catch (err) {
      if (isConvexErrorCode(err, 'DUPLICATE_FIELD')) {
        toast.error(t('toastDuplicate', { name }));
      } else {
        toast.error(t('toastCreateFailed'));
      }
    } finally {
      setCreating(false);
    }
  }

  /** Persists a select/multiselect field's option list, called from
   *  `OptionsEditor` on blur. Uses a dedicated failure toast (not
   *  `toastRenameFailed`) since this path never touches the field's
   *  name. */
  async function handleSaveOptions(field: CustomField, options: string[]) {
    try {
      await updateField({
        fieldId: field.id as Id<'customFields'>,
        fieldOptions: { options },
      });
      toast.success(t('toastUpdated'));
    } catch {
      toast.error(t('toastOptionsFailed'));
    }
  }

  /** Returns true on success so the row can keep the new name, false so it
   *  reverts to the previous one. No-ops (blank / unchanged) count as success. */
  async function handleRename(
    field: CustomField,
    nextName: string
  ): Promise<boolean> {
    const name = nextName.trim();
    if (!name || name === field.field_name) return true;

    setBusyId(field.id);
    try {
      await renameField({
        fieldId: field.id as Id<'customFields'>,
        fieldName: name,
      });
      return true;
    } catch (err) {
      if (isConvexErrorCode(err, 'DUPLICATE_FIELD')) {
        toast.error(t('toastDuplicate', { name }));
      } else {
        toast.error(t('toastRenameFailed'));
      }
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(field: CustomField) {
    if (
      !window.confirm(
        t('deleteConfirm', { name: field.field_name })
      )
    ) {
      return;
    }
    setBusyId(field.id);
    try {
      await removeField({ fieldId: field.id as Id<'customFields'> });
      toast.success(t('toastDeleted', { name: field.field_name }));
    } catch {
      toast.error(t('toastDeleteFailed'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Create */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleCreate();
              }
            }}
            placeholder={t('fieldName')}
            className="bg-muted text-foreground"
          />
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as typeof newType)}
            aria-label={t('type')}
            className="h-9 shrink-0 rounded-md border border-border bg-muted px-2 text-sm text-foreground"
          >
            <option value="text">{t('typeText')}</option>
            <option value="select">{t('typeSelect')}</option>
            <option value="multiselect">{t('typeMultiselect')}</option>
            <option value="date">{t('typeDate')}</option>
            <option value="number">{t('typeNumber')}</option>
          </select>
          <Button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
          >
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            {t('addField')}
          </Button>
        </div>
        {(newType === 'select' || newType === 'multiselect') && (
          <Input
            value={newOptions}
            onChange={(e) => setNewOptions(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleCreate();
              }
            }}
            aria-label={t('options')}
            placeholder={t('optionsPlaceholder')}
            className="bg-muted text-foreground"
          />
        )}
      </div>

      {/* List */}
      <div className="max-h-72 overflow-y-auto rounded-md border border-border">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('loading')}
          </div>
        ) : fields.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {fields.map((field) => (
              <FieldRow
                key={field.id}
                field={field}
                busy={busyId === field.id}
                onRename={handleRename}
                onDelete={handleDelete}
                onSaveOptions={handleSaveOptions}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A single editable row. Controlled local state lets us commit on blur /
 *  Enter and cleanly revert to the last saved name when a rename fails. */
function FieldRow({
  field,
  busy,
  onRename,
  onDelete,
  onSaveOptions,
}: {
  field: CustomField;
  busy: boolean;
  onRename: (field: CustomField, name: string) => Promise<boolean>;
  onDelete: (field: CustomField) => void;
  onSaveOptions: (field: CustomField, options: string[]) => Promise<void>;
}) {
  const t = useTranslations('Contacts.customFields');
  const [name, setName] = useState(field.field_name);

  async function commit() {
    if (name.trim() === field.field_name) {
      setName(field.field_name); // normalise any whitespace-only edit
      return;
    }
    const ok = await onRename(field, name);
    if (!ok) setName(field.field_name);
  }

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <Input
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        aria-label={t('renameAria', { name: field.field_name })}
        className="focus:border-primary h-8 border-transparent bg-transparent text-foreground hover:border-border"
      />
      {(field.field_type === 'select' || field.field_type === 'multiselect') && (
        <OptionsEditor field={field} onSave={onSaveOptions} />
      )}
      <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
        {t(TYPE_LABEL_KEY[field.field_type] ?? 'typeText')}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        onClick={() => onDelete(field)}
        title={t('deleteTitle')}
        className="shrink-0 text-muted-foreground hover:text-red-400"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Trash2 className="size-4" />
        )}
      </Button>
    </li>
  );
}

/** Inline, comma-separated options editor for a select/multiselect
 *  `FieldRow`. Controlled local state (like the name `Input` above)
 *  lets the admin type freely and commits via `onSave` on blur —
 *  there's no separate save button. */
function OptionsEditor({
  field,
  onSave,
}: {
  field: CustomField;
  onSave: (field: CustomField, options: string[]) => Promise<void>;
}) {
  const t = useTranslations('Contacts.customFields');
  const current = (field.field_options?.options as string[] | undefined) ?? [];
  const [text, setText] = useState(current.join(', '));

  return (
    <Input
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() =>
        onSave(
          field,
          text
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean)
        )
      }
      aria-label={t('options')}
      title={t('saveOptions')}
      placeholder={t('optionsPlaceholder')}
      className="h-8 flex-1 text-xs"
    />
  );
}
