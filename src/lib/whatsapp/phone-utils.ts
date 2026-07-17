import { parsePhoneNumberFromString } from 'libphonenumber-js'

/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without trunk 0)
 * by comparing the last 8 digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

/**
 * Format a phone number for display in international `+E.164` form:
 * strip every non-digit, rewrite a leading `00` international prefix to
 * `+`, and prefix the result with `+`. Never returns bare digits or a
 * `00` prefix. Blank input returns "".
 *
 * Doubles as the normalizer for a user-entered number on save: prefill
 * the input with the default country code (e.g. "971") so a plain local
 * entry becomes "+971…".
 */
export function formatPhoneIntl(phone: string): string {
  if (!phone || !phone.trim()) return ''
  let digits = phone.replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  return digits ? `+${digits}` : ''
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}

/**
 * Human-facing international format, e.g. "+971 50 123 4567". Normalizes a
 * digits-only or `00`-prefixed value to `+E.164` first, then formats via
 * libphonenumber-js; falls back to `formatPhoneIntl` (bare `+digits`) when
 * the number can't be parsed into a valid, dialable number for its country
 * (libphonenumber-js's safe parser returns a structurally-parsed but
 * `isValid() === false` result for garbage input like "123" rather than
 * `undefined`, so both cases are checked). Blank input returns "".
 */
export function formatPhoneDisplay(phone: string): string {
  if (!phone || !phone.trim()) return ''
  let digits = phone.replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (!digits) return ''
  const parsed = parsePhoneNumberFromString(`+${digits}`)
  if (parsed && parsed.isValid()) return parsed.formatInternational()
  return formatPhoneIntl(phone)
}
