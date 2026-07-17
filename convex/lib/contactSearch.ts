/** True when `term` plausibly refers to the `HC-…` code: a case-insensitive
 *  substring of the full code, or a digit run equal to the code's number
 *  ignoring leading zeros ("42" == "HC-000042"). */
export function matchesContactCode(
  code: string | undefined,
  term: string,
): boolean {
  if (!code) return false;
  const t = term.trim().toLowerCase();
  if (!t) return false;
  if (code.toLowerCase().includes(t)) return true;
  const codeDigits = code.replace(/\D/g, "");
  const termDigits = t.replace(/\D/g, "");
  return (
    termDigits.length > 0 &&
    codeDigits.length > 0 &&
    Number(codeDigits) === Number(termDigits)
  );
}

/** Case-insensitive match of a contact against a free-text term across
 *  name, email, phone (digits only), and contact code. Empty term = match. */
export function matchesContactSearch(
  c: {
    name?: string;
    phoneNormalized?: string;
    email?: string;
    contactCode?: string;
  },
  term: string,
): boolean {
  const t = term.trim().toLowerCase();
  if (!t) return true;
  if (c.name && c.name.toLowerCase().includes(t)) return true;
  if (c.email && c.email.toLowerCase().includes(t)) return true;
  const termDigits = t.replace(/\D/g, "");
  if (termDigits && c.phoneNormalized && c.phoneNormalized.includes(termDigits))
    return true;
  return matchesContactCode(c.contactCode, term);
}
