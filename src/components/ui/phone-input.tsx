'use client';

import { useEffect, useState } from 'react';
import type { CountryCode } from 'libphonenumber-js';
import { Input } from '@/components/ui/input';
import {
  DEFAULT_COUNTRY,
  composeE164,
  formatAsYouType,
  listCountryOptions,
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
  useEffect(() => {
    const parts = splitE164(value);
    if (parts) {
      setCountry(parts.country);
      setNational(parts.national);
    } else if (!value) {
      setNational('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only on external value change
  }, [value]);

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
