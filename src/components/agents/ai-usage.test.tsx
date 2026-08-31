import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpendCaveats } from './ai-usage';
import { mergeRates, summarizeSpend } from '@/lib/ai/pricing';

/**
 * Static-render tests, matching this repo's other component tests —
 * there is no jsdom and no Testing Library here, so these assert on
 * markup, not on clicks.
 *
 * What is worth testing here is the CAVEAT copy, not the layout: the
 * spend figure is only honest if the card states what it left out, and
 * the three exclusions each send the reader somewhere different.
 */

function render(spend: ReturnType<typeof summarizeSpend>): string {
  return renderToStaticMarkup(<SpendCaveats spend={spend} />);
}

const priced = summarizeSpend(
  [
    {
      provider: 'openai',
      model: 'text-embedding-3-small',
      calls: 1,
      tokens: 100,
      promptTokens: 100,
      completionTokens: 0,
      cachedPromptTokens: 0,
    },
  ],
  mergeRates([]),
);

describe('SpendCaveats', () => {
  // The unconditional one. A fully-priced window is exactly when a
  // reader is most likely to read the total as the whole bill, so this
  // line must survive `complete === true`.
  it('always says media understanding is missing, even when nothing else is', () => {
    expect(priced.complete).toBe(true);
    expect(render(priced)).toContain('voice-note understanding');
  });

  it('names the models that need a rate, and points at the editor', () => {
    const out = render(
      summarizeSpend(
        [
          {
            provider: 'openai',
            model: 'gpt-5.6-luna',
            calls: 1,
            tokens: 10,
            promptTokens: 10,
            completionTokens: 0,
            cachedPromptTokens: 0,
          },
        ],
        mergeRates([]),
      ),
    );
    expect(out).toContain('gpt-5.6-luna');
    expect(out).toContain('Add rates');
  });

  // Entering a rate cannot fix a missing split, so this line must send
  // the reader to the backfill instead of to the rate editor.
  it('sends a model with no token split to the backfill, not the rate editor', () => {
    const out = render(
      summarizeSpend(
        [{ provider: 'openai', model: 'text-embedding-3-small', calls: 1, tokens: 100 }],
        mergeRates([]),
      ),
    );
    expect(out).toContain('backfill');
    expect(out).not.toContain('Add rates');
  });

  it('pluralises the rate caveat', () => {
    const one = render(
      summarizeSpend(
        [{ provider: 'openai', model: 'a', calls: 1, tokens: 1, promptTokens: 1, completionTokens: 0 }],
        mergeRates([]),
      ),
    );
    const two = render(
      summarizeSpend(
        [
          { provider: 'openai', model: 'a', calls: 1, tokens: 1, promptTokens: 1, completionTokens: 0 },
          { provider: 'openai', model: 'b', calls: 1, tokens: 1, promptTokens: 1, completionTokens: 0 },
        ],
        mergeRates([]),
      ),
    );
    expect(one).toContain('a model with no rate');
    expect(two).toContain('2 models with no rate');
  });
});
