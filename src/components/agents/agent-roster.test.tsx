import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AgentRosterView,
  summarizeRoster,
  type RosterAgentView,
} from './agent-roster';

/**
 * Static-render tests, matching this repo's other component tests
 * (`lead-analysis-list.test.tsx`, `voice-transcript.test.tsx`) — there
 * is no jsdom and no Testing Library here, so these assert on markup,
 * not on clicks.
 *
 * The tile arithmetic is deliberately implemented as the standalone
 * `summarizeRoster` so it can be exercised directly, without rendering.
 */

function agent(over: Partial<RosterAgentView> = {}): RosterAgentView {
  return {
    key: 'reply',
    name: 'Reply agent',
    duty: 'Answers customers',
    status: 'on_duty',
    workToday: 0,
    blockedReason: null,
    notHiredReason: null,
    ...over,
  };
}

describe('summarizeRoster', () => {
  it('counts working agents inside on-duty, not beside it', () => {
    const s = summarizeRoster([
      agent({ key: 'a', status: 'working' }),
      agent({ key: 'b', status: 'on_duty' }),
      agent({ key: 'c', status: 'on_call' }),
    ]);
    expect(s.working).toHaveLength(1);
    // The mistake this guards: treating the tiles as a partition and
    // reporting 2 here because one agent is "working, not on duty".
    expect(s.onDuty).toHaveLength(3);
  });

  it('excludes attention and off-duty agents from on duty', () => {
    const s = summarizeRoster([
      agent({ key: 'a', status: 'attention' }),
      agent({ key: 'b', status: 'off_duty' }),
      agent({ key: 'c', status: 'on_duty' }),
    ]);
    expect(s.onDuty).toHaveLength(1);
    expect(s.attention).toHaveLength(1);
  });

  it('splits the roster into live and unhired, with nothing lost', () => {
    const agents = [
      agent({ key: 'a', status: 'on_duty' }),
      agent({ key: 'b', status: 'off_duty' }),
      agent({ key: 'c', status: 'not_hired' }),
      agent({ key: 'd', status: 'not_hired' }),
    ];
    const s = summarizeRoster(agents);
    expect(s.live).toHaveLength(2);
    expect(s.unhired).toHaveLength(2);
    expect(s.live.length + s.unhired.length).toBe(agents.length);
  });
});

describe('AgentRosterView', () => {
  const render = (data: { agents: RosterAgentView[] }) =>
    renderToStaticMarkup(
      React.createElement(AgentRosterView, {
        data,
        jobs: undefined,
        showJobs: false,
        onToggleJobs: () => {},
      }),
    );

  it('names every agent and its duty', () => {
    const html = render({
      agents: [
        agent({ key: 'reply', name: 'Reply agent', duty: 'Answers customers' }),
        agent({
          key: 'quote',
          name: 'Quote drafter',
          duty: 'Drafts itineraries',
          status: 'not_hired',
          notHiredReason: 'needs a pricing catalogue',
        }),
      ],
    });
    expect(html).toContain('Reply agent');
    expect(html).toContain('Answers customers');
    expect(html).toContain('Quote drafter');
    expect(html).toContain('needs a pricing catalogue');
    expect(html).toContain('On the floor');
    expect(html).toContain('Not hired yet');
  });

  it('shows a blocker instead of a work count when one is tripped', () => {
    const html = render({
      agents: [
        agent({
          key: 'admatch',
          name: 'Ad matcher',
          status: 'attention',
          workToday: 7,
          blockedReason: 'no Meta token — ad names unresolved',
        }),
      ],
    });
    expect(html).toContain('no Meta token');
    expect(html).toContain('Needs attention');
    expect(html).not.toContain('7 today');
  });

  it('reports the work count exactly, with no approximation marker', () => {
    const html = render({ agents: [agent({ key: 'reply', workToday: 1307 })] });
    expect(html).toContain('1307 today');
    expect(html).not.toContain('1307+');
  });

  it('says so plainly when an agent has done nothing yet', () => {
    const html = render({
      agents: [agent({ key: 'reply', workToday: 0 })],
    });
    expect(html).toContain('nothing yet today');
  });
});
