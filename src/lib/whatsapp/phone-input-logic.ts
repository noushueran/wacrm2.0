import {
  AsYouType,
  getCountries,
  getCountryCallingCode,
  isValidPhoneNumber,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js'

export const DEFAULT_COUNTRY: CountryCode = 'AE'

/** Regional-indicator flag emoji for an ISO-3166 alpha-2 code, e.g. 🇦🇪. */
function flagFor(country: string): string {
  return country
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)))
}

/** All dialable countries with their calling code and flag, sorted by name-
 *  agnostic country code (stable). Consumers can re-sort for display. */
export function listCountryOptions(): {
  country: CountryCode
  dialCode: string
  flag: string
}[] {
  return getCountries()
    .map((country) => ({
      country,
      dialCode: getCountryCallingCode(country),
      flag: flagFor(country),
    }))
    .sort((a, b) => a.country.localeCompare(b.country))
}

/** Compose a (possibly spaced) national number into `+E.164`. Falls back to
 *  `+<dialCode><digits>` when the number is incomplete/unparseable so the
 *  stored value always carries the country code. */
export function composeE164(country: CountryCode, national: string): string {
  const parsed = parsePhoneNumberFromString(national, country)
  if (parsed) return parsed.number
  const digits = national.replace(/\D/g, '')
  return `+${getCountryCallingCode(country)}${digits}`
}

export function isValidNationalNumber(
  country: CountryCode,
  national: string,
): boolean {
  return isValidPhoneNumber(national, country)
}

/** Coerce a stored or typed value into a `+E.164` candidate.
 *
 *  `contacts.phone` is NOT stored `+`-prefixed. The storage contract is
 *  digits-only — `normalizePhone` strips every non-digit, and WhatsApp's
 *  webhook supplies a bare `wa_id` ("971547800001"), which is how all
 *  but a handful of rows were created. `formatPhoneDisplay` has always
 *  parsed `+${digits}` for exactly this reason; the picker parsed the
 *  raw value instead, so seeding an edit form from a stored number
 *  yielded null and the number box rendered empty.
 *
 *  `coerced` reports whether a `+` had to be added. Callers use it to
 *  stay strict about what that assumption is allowed to conclude: a
 *  value that arrived WITH a `+` keeps its original semantics exactly.
 *  Mirrors `formatPhoneDisplay`'s own normalization, including dropping
 *  a leading international `00`. */
function toE164Candidate(
  value: string,
): { candidate: string; coerced: boolean } | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('+')) return { candidate: trimmed, coerced: false }
  let digits = trimmed.replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (!digits) return null
  return { candidate: `+${digits}`, coerced: true }
}

/** True only for a complete, valid number. `composeE164` falls back to
 *  `+<dialCode><digits>` for incomplete input (e.g. a dial-code-only or
 *  too-short value), so this is what save handlers must check before
 *  persisting `PhoneInput`'s emitted value. Also accepts the digits-only
 *  form actually held in the database, so seeding an edit form from a
 *  stored contact does not report the untouched number as invalid. */
export function isCompletePhoneNumber(value: string): boolean {
  const coerced = toE164Candidate(value)
  return coerced !== null && isValidPhoneNumber(coerced.candidate)
}

/** Parse a stored value — `+E.164` or the digits-only form the database
 *  actually holds — back into the picker's parts. */
export function splitE164(
  value: string,
): { country: CountryCode; national: string } | null {
  const coerced = toE164Candidate(value)
  if (!coerced) return null
  const parsed = parsePhoneNumberFromString(coerced.candidate)
  if (!parsed || !parsed.country) return null
  // A bare national number ("547800001") becomes "+547800001", which
  // libphonenumber resolves to a country (AR) while reporting it
  // invalid. Adopting that would silently rewrite a UAE contact as
  // Argentinian, so a value we had to guess a `+` for must also be a
  // genuinely valid number. Values that arrived with an explicit `+`
  // keep the original country-only check, preserving the mid-typing
  // tolerance `nextPickerState` depends on.
  if (coerced.coerced && !parsed.isValid()) return null
  return { country: parsed.country, national: parsed.nationalNumber }
}

/** Live as-you-type formatting for the national-number input. */
export function formatAsYouType(country: CountryCode, national: string): string {
  return new AsYouType(country).input(national)
}

/** What `PhoneInput`'s picker state should become when the `value` prop
 *  changes — or `null` to leave it alone.
 *
 *  Three-way on purpose, and the third case is the one worth stating: a
 *  value that is non-empty but unparseable (mid-typing `"+9"`, a legacy
 *  row holding something malformed) must NOT reset the picker. Resetting
 *  there would fight the user, because `PhoneInput` round-trips its own
 *  edits through the parent — every keystroke composes an E.164 value,
 *  hands it up, and gets it back as this prop — so the incomplete states
 *  it must tolerate are mostly its own.
 *
 *  Lives here rather than inline in the component so it is reachable by a
 *  test: the component has no jsdom to render into, and this is the part
 *  with the actual decision in it. */
export function nextPickerState(
  value: string,
): { country: CountryCode; national: string } | null {
  const parts = splitE164(value)
  if (parts) return parts
  if (!value) return { country: DEFAULT_COUNTRY, national: '' }
  return null
}
