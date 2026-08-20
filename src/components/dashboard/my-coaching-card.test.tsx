import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MyCoachingList, type MyCoachingNote } from './my-coaching-card';

const note = (over: Partial<MyCoachingNote> = {}): MyCoachingNote => ({
  id: 'n1',
  observations: [
    {
      dimension: 'unanswered_question',
      observation: 'The visa fee was never given.',
      quote: 'How much is the visa?',
    },
  ],
  strengths: ['Replied quickly and in the customer’s language.'],
  firstResponseMinutes: 12,
  createdAt: 1,
  ...over,
});

const render = (notes: MyCoachingNote[]) =>
  renderToStaticMarkup(React.createElement(MyCoachingList, { notes }));

describe('your own coaching', () => {
  it('leads with what went well', () => {
    const html = render([note()]);
    const good = html.indexOf('Replied quickly');
    const bad = html.indexOf('The visa fee was never given.');
    expect(good).toBeGreaterThan(-1);
    // Reading your own feedback should not open with a fault.
    expect(good).toBeLessThan(bad);
  });

  it('shows the evidence behind every observation', () => {
    // So you can check the note against what actually happened rather
    // than take a model's word for it.
    expect(render([note()])).toContain('How much is the visa?');
  });

  it('names the dimension in human words, not the enum', () => {
    const html = render([note()]);
    expect(html).toContain('Question never answered');
    expect(html).not.toContain('unanswered_question');
  });

  it('shows only the most recent few, and says how many more there are', () => {
    const many = Array.from({ length: 7 }, (_, i) => note({ id: `n${i}` }));
    const html = render(many);
    expect(html).toContain('4 more from earlier threads');
  });

  it('says nothing about extras when there are none', () => {
    expect(render([note()])).not.toContain('more from earlier');
  });

  it('renders a note that is praise only', () => {
    const html = render([note({ observations: [], strengths: ['Handled it well.'] })]);
    expect(html).toContain('Handled it well.');
  });
});
