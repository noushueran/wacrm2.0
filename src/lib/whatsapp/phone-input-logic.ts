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

/** Parse a stored `+E.164` value back into the picker's parts. */
export function splitE164(
  value: string,
): { country: CountryCode; national: string } | null {
  if (!value || !value.trim()) return null
  const parsed = parsePhoneNumberFromString(value)
  if (!parsed || !parsed.country) return null
  return { country: parsed.country, national: parsed.nationalNumber }
}

/** Live as-you-type formatting for the national-number input. */
export function formatAsYouType(country: CountryCode, national: string): string {
  return new AsYouType(country).input(national)
}
