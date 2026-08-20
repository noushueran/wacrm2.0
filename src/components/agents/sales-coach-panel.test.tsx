import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoachReport, DIMENSION_LABEL, TUNABLES, type CoachTeamView } from './sales-coach-panel';
import { AGENTS_WITH_SETTINGS, hasSettings } from './agent-settings';
import { COACH_DIMENSIONS } from '../../../convex/lib/salesCoach/prompt';

const base: CoachTeamView = { notes: [], byPerson: [] };
const render = (over: Partial<CoachTeamView> = {}) =>
  renderToStaticMarkup(React.createElement(CoachReport, { data: { ...base, ...over } }));

const note = (over: Partial<CoachTeamView['notes'][number]> = {}) => ({
  id: 'n1',
  subjectUserId: 'u1',
  observations: [
    { dimension: 'unanswered_question', observation: 'The visa fee was never given.', quote: 'How much is the visa?' },
  ],
  strengths: ['Replied in the customer’s own language.'],
  firstResponseMinutes: 45,
  createdAt: 1,
  ...over,
});

describe('the coaching report', () => {
  it('says plainly when there is nothing yet', () => {
    expect(render()).toContain('No reviews yet');
  });

  it('shows the observation and the evidence behind it', () => {
    const html = render({ notes: [note()] });
    expect(html).toContain('The visa fee was never given.');
    // The quote is the whole reason the observation was allowed to exist.
    expect(html).toContain('How much is the visa?');
  });

  it('shows what went well, not only faults', () => {
    expect(render({ notes: [note()] })).toContain('Went well');
  });

  it('reports the computed response time', () => {
    expect(render({ notes: [note()] })).toContain('45 min');
  });

  it('omits response time when no human ever replied', () => {
    // Rather than printing zero, which would read as instant.
    const html = render({ notes: [note({ firstResponseMinutes: null })] });
    expect(html).not.toContain('First human reply');
  });

  it('shows counts per person, never a score or a rank', () => {
    const html = render({ byPerson: [{ userId: 'Neha', reviews: 3, observations: 5 }], notes: [note()] });
    expect(html).toContain('3 threads');
    expect(html).toContain('5 notes');
    // No grading vocabulary anywhere.
    for (const word of ['score', 'Score', 'rank', 'Rank', 'grade', '/10']) {
      expect(html).not.toContain(word);
    }
  });

  it('singularises a single thread and note', () => {
    const html = render({ byPerson: [{ userId: 'Sam', reviews: 1, observations: 1 }], notes: [note()] });
    expect(html).toContain('1 thread ');
    expect(html).toContain('1 note');
  });
});

describe('wiring', () => {
  it('every dimension the agent can emit has a human label', () => {
    for (const d of COACH_DIMENSIONS) {
      expect(DIMENSION_LABEL[d], `${d} has no label`).toBeTruthy();
    }
  });

  it('the coach has a panel in its window', () => {
    expect(hasSettings('coach')).toBe(true);
    expect([...AGENTS_WITH_SETTINGS]).toContain('coach');
  });

  it('the panel offers no enable switch of its own', () => {
    expect(TUNABLES.map((t) => t.key)).not.toContain('enabled');
  });
});
