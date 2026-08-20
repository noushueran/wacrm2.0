/**
 * Company identity for the Next.js runtime.
 *
 * This CRM is deployed once per company (Amani, Holidayys, …) from the
 * same source. Identity is therefore CONFIGURATION, never code: every
 * company-specific string lives in an environment variable and is read
 * here, so a deploy differs from another deploy only by its `.env`.
 *
 * WHY A MISSING VALUE THROWS RATHER THAN DEFAULTING. A fallback is how
 * one company's CRM ships wearing another company's name — the push
 * notification, the PWA install prompt and the WhatsApp invite text all
 * read from here, and all three are seen by real people. A build that
 * fails loudly is strictly better than a deploy that silently
 * mis-brands. This is the one behavioural cost of externalization and it
 * is deliberate.
 *
 * NOTE FOR EDITORS: every `NEXT_PUBLIC_*` variable below MUST be written
 * out in full as `process.env.NEXT_PUBLIC_…`. Next.js inlines these into
 * the client bundle by STATIC TEXT SUBSTITUTION, so a computed lookup
 * (`process.env[key]`) is `undefined` in the browser even when the value
 * is set at build time.
 *
 * `NEXT_PUBLIC_R2_PUBLIC_HOST` is deliberately NOT here — it is media
 * infrastructure, not identity, and already lives in
 * `src/lib/storage/media-url.ts`.
 */

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      `[brand] ${name} is not set. Company identity is configuration, not code — ` +
        `set it in this deployment's environment. Refusing to fall back: a default ` +
        `here ships this company's CRM under another company's name.`,
    );
  }
  return trimmed;
}

export const BRAND = Object.freeze({
  /** Trading name, e.g. "Amani". Used wherever a short label reads best. */
  name: required(process.env.NEXT_PUBLIC_BRAND_NAME, "NEXT_PUBLIC_BRAND_NAME"),
  /** Registered entity, e.g. "Amani Tourism & Travel LLC". */
  legalName: required(
    process.env.NEXT_PUBLIC_BRAND_LEGAL_NAME,
    "NEXT_PUBLIC_BRAND_LEGAL_NAME",
  ),
  /** Origin this CRM is served from, e.g. "https://wa.example.com". */
  siteUrl: required(process.env.NEXT_PUBLIC_SITE_URL, "NEXT_PUBLIC_SITE_URL"),
  /** The company's public marketing site. */
  website: required(
    process.env.NEXT_PUBLIC_BRAND_WEBSITE,
    "NEXT_PUBLIC_BRAND_WEBSITE",
  ),
  /** Public contact address. */
  email: required(process.env.NEXT_PUBLIC_BRAND_EMAIL, "NEXT_PUBLIC_BRAND_EMAIL"),
});

/**
 * What the product calls itself in user-facing copy: "<Brand> WA CRM".
 * Derived rather than configured so the two halves can never drift.
 */
export const PRODUCT_NAME = `${BRAND.name} WA CRM`;
