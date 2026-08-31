import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';
import {
  ConversionHoldBanner,
  type ConversionHoldView,
} from './conversions-tab';

/**
 * Static-render tests, matching `lead-sequence-settings-view.test.tsx`'s
 * convention (no jsdom; assertions scoped by `data-testid`).
 *
 * What these actually guard: the Conversions tab renders a dark delivery
 * lane and a healthy one almost identically — `dormant` is one badge among
 * fifty in a list capped at the 50 newest rows. Production sat that way for
 * months. So the assertions below are about the banner being LOUD and
 * SPECIFIC (which lane, how many, since when, why), not merely present.
 */

const hold = (over: Partial<ConversionHoldView> = {}): ConversionHoldView => ({
  backend: 'capi',
  heldCount: 2483,
  capped: false,
  oldestHeldAt: Date.UTC(2026, 4, 29, 9, 30),
  reason: 'META_CAPI_DATASET_ID/META_CAPI_ACCESS_TOKEN unset',
  ...over,
});

function render(holds: ConversionHoldView[]): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <ConversionHoldBanner holds={holds} />
    </NextIntlClientProvider>,
  );
}

function sectionFor(html: string, backend: string): string {
  const marker = `data-testid="conversion-hold-${backend}"`;
  const start = html.indexOf(marker);
  expect(start, `no banner for ${backend}`).toBeGreaterThan(-1);
  return html.slice(start);
}

describe('ConversionHoldBanner', () => {
  it('renders nothing when every lane is delivering', () => {
    // The healthy account must see no change whatsoever — a banner that
    // cries wolf on a working deployment gets tuned out, which is the same
    // failure mode as showing nothing at all.
    expect(render([])).toBe('');
  });

  it('names the lane, the count, the age and the reason', () => {
    const section = sectionFor(render([hold()]), 'capi');
    expect(section).toContain('Meta CAPI');
    expect(section).toContain('2,483');
    expect(section).toContain('May 29, 2026');
    expect(section).toContain('META_CAPI_DATASET_ID/META_CAPI_ACCESS_TOKEN unset');
    // Reassurance is load-bearing: without it the honest reading of a
    // 2,483-row hold is "we lost 2,483 conversions".
    expect(section).toContain('Nothing is lost');
  });

  it('says "at least" rather than an exact number once the scan is capped', () => {
    const section = sectionFor(
      render([hold({ heldCount: 500, capped: true })]),
      'capi',
    );
    expect(section).toContain('At least 500');
  });

  it('reports the current blocker when the env is set but the WABA is not', () => {
    // The second gate: setting the two env vars does not, on its own,
    // guarantee delivery.
    const section = sectionFor(
      render([hold({ reason: 'no wabaId configured for account' })]),
      'capi',
    );
    expect(section).toContain('no wabaId configured for account');
  });

  it('reports each dark lane separately', () => {
    const html = render([
      hold(),
      hold({ backend: 'platformA', heldCount: 7, reason: 'LANDING_CONVERSION_URL/WA_CONVERSION_SHARED_SECRET unset' }),
    ]);
    expect(sectionFor(html, 'capi')).toContain('Meta CAPI');
    const platformA = sectionFor(html, 'platformA');
    expect(platformA).toContain('Platform A pixel');
    expect(platformA).toContain('7');
  });
});
