/**
 * Company identity for the CONVEX runtime.
 *
 * Deliberately a separate module from `src/lib/brand.ts` rather than a
 * shared one: the two runtimes have genuinely different environments.
 * Next.js reads build-time `NEXT_PUBLIC_*` variables inlined into the
 * bundle; Convex reads variables set on the Convex deployment itself.
 * A shared module would have to satisfy both and would leak the wrong
 * variable names into each. (`convex/lib/r2/url.ts` and
 * `src/lib/storage/media-url.ts` are split for exactly this reason.)
 *
 * Missing values throw, for the same reason they do on the Next.js side:
 * these strings reach real people — the push-notification title on a
 * staff phone is written here — and a silent fallback mis-brands them.
 */

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      `[brand] ${name} is not set on this Convex deployment. Company identity is ` +
        `configuration, not code. Refusing to fall back: a default here ships this ` +
        `company's CRM under another company's name.`,
    );
  }
  return trimmed;
}

/** Trading name, e.g. "Amani". */
export function brandName(): string {
  return required(process.env.BRAND_NAME, "BRAND_NAME");
}

/** Origin this CRM is served from, e.g. "https://wa.example.com". */
export function brandSiteUrl(): string {
  return required(process.env.BRAND_SITE_URL, "BRAND_SITE_URL");
}

/** "<Brand> WA CRM" — matches `PRODUCT_NAME` in `src/lib/brand.ts`. */
export function productName(): string {
  return `${brandName()} WA CRM`;
}

/**
 * Read lazily through functions, NOT as module-level consts like the
 * Next.js side. Convex modules are imported by `convex-test` and by the
 * deployment's own analysis pass, and a module-level throw would break
 * BOTH for every function in the file's import graph — not just the call
 * that actually needs a brand string. Functions confine the throw to the
 * call site, which is the same containment `convex/lib/r2/url.ts` uses
 * for its lazy config thunk.
 */
