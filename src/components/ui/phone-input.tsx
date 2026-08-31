'use client';

import { useState } from 'react';
import type { CountryCode } from 'libphonenumber-js';
import { Input } from '@/components/ui/input';
import {
  DEFAULT_COUNTRY,
  composeE164,
  formatAsYouType,
  listCountryOptions,
  nextPickerState,
  splitE164,
} from '@/lib/whatsapp/phone-input-logic';

const COUNTRY_OPTIONS = listCountryOptions();

interface PhoneInputProps {
  value: string;
  onChange: (e164: string) => void;
  id?: string;
  placeholder?: string;
}

export function PhoneInput({ value, onChange, id, placeholder }: PhoneInputProps) {
  const initial = splitE164(value);
  const [country, setCountry] = useState<CountryCode>(
    initial?.country ?? DEFAULT_COUNTRY,
  );
  const [national, setNational] = useState<string>(initial?.national ?? '');

  // Re-seed when the incoming value changes to a different number (e.g. the
  // form switches from "add" to "edit", or resets on open).
  //
  // Done DURING RENDER, guarded by the previous value, which is React's
  // documented way to adjust state when a prop changes — not in an
  // effect. An effect here re-seeded after the browser had already
  // painted the stale number, so the control rendered twice on every
  // external change, and it round-trips its own keystrokes through the
  // parent so "every external change" means every keystroke. React
  // re-runs this component before committing instead, and nothing
  // downstream ever sees the intermediate state.
  //
  // The decision itself lives in `nextPickerState`, where it is unit
  // tested; the important half is that it returns null for a non-empty
  // value it cannot parse, so a half-typed number does not reset the
  // country the user just picked.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    const next = nextPickerState(value);
    if (next) {
      setCountry(next.country);
      setNational(next.national);
    }
  }

  function emit(nextCountry: CountryCode, nextNational: string) {
    onChange(composeE164(nextCountry, nextNational));
  }

  return (
    <div className="flex gap-2">
      <select
        aria-label="Country calling code"
        value={country}
        onChange={(e) => {
          const next = e.target.value as CountryCode;
          setCountry(next);
          emit(next, national);
        }}
        className="rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary/50"
      >
        {COUNTRY_OPTIONS.map((o) => (
          <option key={o.country} value={o.country}>
            {o.flag} +{o.dialCode}
          </option>
        ))}
      </select>
      <Input
        id={id}
        inputMode="tel"
        value={national}
        placeholder={placeholder}
        onChange={(e) => {
          const formatted = formatAsYouType(country, e.target.value);
          setNational(formatted);
          emit(country, formatted);
        }}
        className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
      />
    </div>
  );
}
