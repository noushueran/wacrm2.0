import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';
import {
  LeadSequenceSettingsView,
  type LeadSequenceConfigView,
  type LeadSequencePreviewView,
} from './lead-sequence-settings-view';
import type { BandRule } from '../../../convex/lib/leadAnalysis/bands';

/**
 * Static-render tests — no jsdom/Testing Library here (see
 * `lead-analysis-list.test.tsx`'s own header comment), so every
 * assertion is scoped to a `data-testid` via `textByTestId`/
 * `tagByTestId` rather than a bare `toContain`. This component renders
 * band names, step counts, and template names in more than one place
 * (the bands editor AND the preview list), so an unscoped `toContain`
 * would still pass with the feature under test deleted.
 */

const filledBands = (): BandRule[] => [
  {
    key: 'hot',
    minScore: 8,
    maxScore: 10,
    autoArchive: false,
    steps: [
      { delayDays: 2, templateName: 'welcome_back' },
      { delayDays: 5, templateName: 'welcome_back' },
    ],
  },
  {
    key: 'warm',
    minScore: 4,
    maxScore: 7,
    autoArchive: true,
    steps: [{ delayDays: 3, templateName: 'check_in' }],
  },
  {
    key: 'cold',
    minScore: 1,
    maxScore: 3,
    autoArchive: true,
    steps: [{ delayDays: 5, templateName: 'check_in' }],
  },
];

const bandsWithAGap = (): BandRule[] => {
  const bands = filledBands();
  // Cold band's only step has no template chosen yet.
  bands[2] = { ...bands[2], steps: [{ delayDays: 5, templateName: '' }] };
  return bands;
};

const config = (over: Partial<LeadSequenceConfigView> = {}): LeadSequenceConfigView => ({
  enabled: false,
  idleDaysBeforeSequence: 3,
  humanQuietHours: 24,
  dailySendCap: 100,
  bands: filledBands(),
  ...over,
});

const preview = (over: Partial<LeadSequencePreviewView> = {}): LeadSequencePreviewView => ({
  workingHoursKnown: true,
  warnings: [],
  windowDays: 7,
  leads: [
    { verdict: 'send', projectedSendAt: Date.now() },
    { verdict: 'send', projectedSendAt: Date.now() + 86_400_000 },
    { verdict: 'stop', projectedSendAt: null },
  ],
  ...over,
});

function markup(
  over: {
    config?: LeadSequenceConfigView;
    preview?: LeadSequencePreviewView | undefined;
    excludedParamTemplateCount?: number;
  } = {},
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {React.createElement(LeadSequenceSettingsView, {
        config: over.config ?? config(),
        preview: 'preview' in over ? over.preview : preview(),
        approvedTemplates: [
          { name: 'welcome_back', language: 'en_US' },
          { name: 'check_in', language: 'en_US' },
        ],
        excludedParamTemplateCount: over.excludedParamTemplateCount ?? 0,
        savingEnable: false,
        onToggleEnabled: vi.fn(),
        savingCadence: false,
        onSaveCadence: vi.fn(),
        savingBands: false,
        onSaveBands: vi.fn(),
        qualificationSettingsHref: '/settings?tab=qualification',
      })}
    </NextIntlClientProvider>,
  );
}

/** Same helper as `lead-analysis-list.test.tsx` — scopes a text
 * assertion to the single element carrying `data-testid="testId"`,
 * so it can't accidentally match the same string rendered elsewhere
 * on the page. */
function textByTestId(html: string, testId: string): string {
  const match = html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`));
  if (!match) {
    throw new Error(`No element with data-testid="${testId}" found in markup`);
  }
  return match[1];
}

/** Extracts the opening tag (with attributes) for a `data-testid`, for
 * assertions on `aria-disabled`/`data-disabled` rather than text. */
function tagByTestId(html: string, testId: string): string {
  const match = html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`));
  if (!match) {
    throw new Error(`No element with data-testid="${testId}" found in markup`);
  }
  return match[0];
}

function hasTestId(html: string, testId: string): boolean {
  return html.includes(`data-testid="${testId}"`);
}

describe('LeadSequenceSettingsView', () => {
  it('warns prominently when working hours are unset, and says nothing will send', () => {
    const html = markup({ preview: preview({ workingHoursKnown: false }) });
    expect(hasTestId(html, 'sequence-hours-warning')).toBe(true);
    const text = textByTestId(html, 'sequence-hours-warning-body');
    expect(text).toContain('nothing will send');
  });

  it('renders no working-hours warning once hours are configured', () => {
    const html = markup({ preview: preview({ workingHoursKnown: true }) });
    expect(hasTestId(html, 'sequence-hours-warning')).toBe(false);
  });

  it('links to where working hours are configured', () => {
    const html = markup({ preview: preview({ workingHoursKnown: false }) });
    expect(html).toContain('href="/settings?tab=qualification"');
  });

  it('disables the enable switch when a band step has no template', () => {
    const html = markup({ config: config({ enabled: false, bands: bandsWithAGap() }) });
    const tag = tagByTestId(html, 'sequence-enable-switch');
    expect(tag).toContain('aria-disabled="true"');
  });

  it('enables the switch once every band step has a template', () => {
    const html = markup({ config: config({ enabled: false, bands: filledBands() }) });
    const tag = tagByTestId(html, 'sequence-enable-switch');
    expect(tag).not.toContain('aria-disabled');
  });

  it('still allows turning an already-enabled sequence OFF even if a gap later appears', () => {
    // enabled: true with a gap is an edge case (should not occur via
    // the mutation's own guard), but the switch must never trap an
    // admin who needs to turn the feature off.
    const html = markup({ config: config({ enabled: true, bands: bandsWithAGap() }) });
    const tag = tagByTestId(html, 'sequence-enable-switch');
    expect(tag).not.toContain('aria-disabled');
  });

  it('shows a blocked hint scoped to its own element when a template is missing', () => {
    const html = markup({ config: config({ enabled: false, bands: bandsWithAGap() }) });
    expect(hasTestId(html, 'sequence-enable-blocked-hint')).toBe(true);
  });

  it('does not show the blocked hint once every band step has a template', () => {
    const html = markup({ config: config({ enabled: false, bands: filledBands() }) });
    expect(hasTestId(html, 'sequence-enable-blocked-hint')).toBe(false);
  });

  it('renders the count of leads projected to be messaged in the preview window', () => {
    const html = markup({
      preview: preview({
        leads: [
          { verdict: 'send', projectedSendAt: Date.now() },
          { verdict: 'send', projectedSendAt: Date.now() },
          { verdict: 'reschedule', projectedSendAt: Date.now() + 1000 },
          { verdict: 'stop', projectedSendAt: null },
          { verdict: 'exhaust', projectedSendAt: null },
        ],
      }),
    });
    // 3 leads carry a non-null `projectedSendAt` (the two sends plus
    // the one reschedule that still lands inside the window); the two
    // terminal `stop`/`exhaust` rows are not projected to be messaged.
    expect(textByTestId(html, 'sequence-preview-count')).toBe('3');
  });

  it('renders a loading state, not a stale count, while the preview query is in flight', () => {
    const html = markup({ preview: undefined });
    expect(hasTestId(html, 'sequence-preview-loading')).toBe(true);
    expect(hasTestId(html, 'sequence-preview-count')).toBe(false);
  });

  it("locks hot band's auto-archive off and states the reason", () => {
    const html = markup({ config: config({ bands: filledBands() }) });
    const tag = tagByTestId(html, 'sequence-autoarchive-hot');
    expect(tag).toContain('aria-disabled="true"');
    expect(hasTestId(html, 'sequence-autoarchive-hot-reason')).toBe(true);
  });

  it("leaves warm band's auto-archive editable (not locked)", () => {
    const html = markup({ config: config({ bands: filledBands() }) });
    const tag = tagByTestId(html, 'sequence-autoarchive-warm');
    expect(tag).not.toContain('aria-disabled');
  });

  // Fix 3 (whole-branch review, "prevent" half): the picker itself only
  // ever receives already-filtered `approvedTemplates` (the container's
  // job, via `pickableSequenceTemplates` — see that module's own
  // tests). This view's own responsibility is just to SAY why, loudly,
  // rather than silently shrinking the option list — these two tests
  // pin that half.
  it('says why when approved templates are hidden for needing variables', () => {
    const html = markup({ excludedParamTemplateCount: 2 });
    expect(hasTestId(html, 'sequence-param-templates-excluded')).toBe(true);
    const text = textByTestId(html, 'sequence-param-templates-excluded');
    expect(text).toContain('2');
  });

  it('renders no exclusion note when nothing was hidden for needing variables', () => {
    const html = markup({ excludedParamTemplateCount: 0 });
    expect(hasTestId(html, 'sequence-param-templates-excluded')).toBe(false);
  });
});
