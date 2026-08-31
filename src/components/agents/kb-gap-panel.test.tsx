import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { KbGapReport, TUNABLES, type KbGapView } from './kb-gap-panel';
import { AGENTS_WITH_SETTINGS, hasSettings } from './agent-settings';

const base: KbGapView = {
  themes: [],
  themesOverflow: false,
  counts: { drafted: 0, skipped_thin_answer: 0, skipped_not_durable: 0 },
  countsTruncated: false,
};

const render = (over: Partial<KbGapView> = {}) =>
  renderToStaticMarkup(React.createElement(KbGapReport, { data: { ...base, ...over } }));

describe('the gap report', () => {
  it('says plainly when there is nothing outstanding', () => {
    const html = render();
    expect(html).toContain('Nothing outstanding');
  });

  it('names each theme with how many questions it covers', () => {
    const html = render({
      themes: [
        { theme: 'Schengen visas', questionCount: 4, examples: ['Do you do Schengen?'] },
      ],
    });
    expect(html).toContain('Schengen visas');
    expect(html).toContain('4 questions');
  });

  it('quotes the real questions, so the label can be judged', () => {
    // The theme is the model's summary; the quotes are the evidence.
    const html = render({
      themes: [{ theme: 'Visa conversion', questionCount: 2, examples: ['Can I switch later?', 'From freelance to employment?'] }],
    });
    expect(html).toContain('Can I switch later?');
    expect(html).toContain('From freelance to employment?');
  });

  it('singularises one question correctly', () => {
    const html = render({ themes: [{ theme: 'Abu Dhabi office', questionCount: 1, examples: ['Address?'] }] });
    expect(html).toContain('1 question<');
  });

  it('reports what it drafted and what it judged not worth keeping', () => {
    const html = render({ counts: { drafted: 3, skipped_thin_answer: 2, skipped_not_durable: 1 } });
    expect(html).toContain('3 entries drafted');
    expect(html).toContain('3 answers judged');
  });

  it('says when the totals describe a window rather than everything', () => {
    expect(render({ countsTruncated: true, counts: { drafted: 5, skipped_thin_answer: 0, skipped_not_durable: 0 } }))
      .toContain('recent only');
  });

  it('admits when more themes exist than it is showing', () => {
    expect(render({ themesOverflow: true })).toContain('More themes exist');
  });
});

describe('wiring', () => {
  it('the knowledge gap agent has a panel in its window', () => {
    expect(hasSettings('kbgap')).toBe(true);
    expect([...AGENTS_WITH_SETTINGS]).toContain('kbgap');
  });

  it('the panel does not offer its own enable switch', () => {
    // The window header owns it; a second toggle is how a panel starts
    // disagreeing with itself.
    expect(TUNABLES.map((t) => t.key)).not.toContain('enabled');
  });
});
