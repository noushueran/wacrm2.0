import { getRequestConfig } from 'next-intl/server';
import { BRAND, PRODUCT_NAME } from '@/lib/brand';

/**
 * Company identity in the message dictionary.
 *
 * `messages/*.json` is checked in and shared by every deployment, so it
 * must not name a company. Instead it carries sentinels — `__PRODUCT_NAME__`
 * and `__BRAND_NAME__` — which are substituted here, at the single point
 * where messages are loaded. `src/app/layout.tsx` hands the SAME resolved
 * object to `NextIntlClientProvider`, so server and client agree without a
 * second substitution.
 *
 * Sentinels rather than ICU placeholders (`{productName}`) on purpose: ICU
 * arguments must be supplied by every `t()` call site, and next-intl throws
 * when one is missed. That would turn a branding concern into a runtime
 * error in ~9 unrelated components. A sentinel is invisible to ICU and
 * resolved once.
 *
 * `i18n/request.test.ts` asserts no sentinel survives and no dictionary
 * value names a company.
 */
const SENTINELS: ReadonlyArray<readonly [RegExp, () => string]> = [
  [/__PRODUCT_NAME__/g, () => PRODUCT_NAME],
  [/__BRAND_NAME__/g, () => BRAND.name],
];

function walk(value: unknown): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const [pattern, resolve] of SENTINELS) {
      pattern.lastIndex = 0;
      out = out.replace(pattern, resolve());
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        walk(v),
      ]),
    );
  }
  return value;
}

/** Resolve every brand sentinel in a message dictionary (or any subtree of
 *  one). Shape-preserving: only string leaves change. */
export function applyBrand<T>(value: T): T {
  return walk(value) as T;
}

export default getRequestConfig(async () => {
  // Read the locale from the environment, defaulting to 'en'
  const locale = process.env.NEXT_PUBLIC_APP_LOCALE || 'en';

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages: applyBrand(messages),
  };
});
