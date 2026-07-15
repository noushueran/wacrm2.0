'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { toUiCustomField } from '@/lib/convex/adapters';
import { pruneValueForField } from '@/lib/inbox/customFieldValues';
import { Input } from '@/components/ui/input';
import type { CustomField } from '@/types';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

export function ContactCustomFields({ contactId }: { contactId: string }) {
  const t = useTranslations('Inbox.customFields');
  const fieldsRes = useQuery(api.customFields.list);
  const valuesRes = useQuery(api.customFields.getForContact, {
    contactId: contactId as Id<'contacts'>,
  });
  const fields = useMemo(() => (fieldsRes ?? []).map(toUiCustomField), [fieldsRes]);
  const setForContact = useMutation(api.customFields.setForContact);

  // Local editable map: fieldId -> string value (multiselect = JSON array
  // string). Re-derived from the server snapshot *during render* (guarded
  // by a reference-equality check against the last-seen `valuesRes`)
  // rather than via a useEffect — the pattern React's own docs recommend
  // for "adjust state when a prop/query result changes"; a useEffect that
  // unconditionally calls setState on every run is flagged by this repo's
  // react-hooks/set-state-in-effect rule (see AGENTS.md: this project's
  // Next.js/eslint toolchain enforces newer rules than training data may
  // assume). https://react.dev/learn/you-might-not-need-an-effect
  const [values, setValues] = useState<Record<string, string>>({});
  const [lastValuesRes, setLastValuesRes] = useState(valuesRes);
  if (valuesRes && valuesRes !== lastValuesRes) {
    setLastValuesRes(valuesRes);
    const next: Record<string, string> = {};
    for (const v of valuesRes) next[v.customFieldId] = v.value ?? '';
    setValues(next);
  }

  async function commit(next: Record<string, string>) {
    setValues(next);
    try {
      await setForContact({
        contactId: contactId as Id<'contacts'>,
        // Prune each value against its field's *current* type/options before
        // sending — otherwise a stale select/multiselect value (from an
        // option a supervisor since removed) trips the server's strict
        // validator and fails the whole batch, including this edit's real
        // change. See src/lib/inbox/customFieldValues.ts.
        values: Object.entries(next).flatMap(([customFieldId, rawValue]) => {
          const value = pruneValueForField(
            fields.find((f) => f.id === customFieldId),
            rawValue,
          );
          if (value === null || value.trim() === '' || value === '[]') return [];
          return [{ customFieldId: customFieldId as Id<'customFields'>, value }];
        }),
      });
    } catch {
      toast.error(t('failed'));
    }
  }

  if (fields.length === 0) {
    return <p className="px-1 text-xs text-muted-foreground">{t('none')}</p>;
  }

  return (
    <div className="mt-2 space-y-2">
      {fields.map((field) => (
        <FieldInput
          key={field.id}
          field={field}
          value={values[field.id] ?? ''}
          onChange={(val) => commit({ ...values, [field.id]: val })}
        />
      ))}
    </div>
  );
}

function FieldInput({
  field, value, onChange,
}: {
  field: CustomField;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('Inbox.customFields');
  const options = (field.field_options?.options as string[] | undefined) ?? [];
  const label = <p className="text-xs capitalize text-muted-foreground">{field.field_name}</p>;

  if (field.field_type === 'select') {
    return (
      <div className="space-y-1">
        {label}
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground"
        >
          <option value="">{t('selectPlaceholder')}</option>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      </div>
    );
  }

  if (field.field_type === 'multiselect') {
    const selected: string[] = value ? safeParse(value) : [];
    const toggle = (o: string) => {
      const next = selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o];
      onChange(JSON.stringify(next));
    };
    return (
      <div className="space-y-1">
        {label}
        <div className="flex flex-wrap gap-1">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              onClick={() => toggle(o)}
              className={`rounded-full px-2 py-0.5 text-[11px] ${
                selected.includes(o)
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {o}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const inputType = field.field_type === 'date' ? 'date' : field.field_type === 'number' ? 'number' : 'text';
  return (
    <div className="space-y-1">
      {label}
      <Input
        type={inputType}
        defaultValue={value}
        onBlur={(e) => onChange(e.target.value)}
        className="h-8 bg-muted text-sm"
      />
    </div>
  );
}

function safeParse(s: string): string[] {
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}
