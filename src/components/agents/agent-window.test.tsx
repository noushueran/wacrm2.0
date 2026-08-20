import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AgentWindowView,
  sinceLabel,
  type AgentDetailView,
} from './agent-window';

const NOW = 1_800_000_000_000;

function detail(over: Partial<AgentDetailView> = {}): AgentDetailView {
  return {
    key: 'revival',
    name: 'Revival agent',
    duty: 'Chases leads that went quiet',
    status: 'on_duty',
    instructions: 'Writes one short follow-up referencing their actual trip.',
    trigger: 'A sweep every 30 minutes',
    reads: 'The thread and the trip profile',
    writes: 'A draft into the queue. Sends nothing by itself',
    enabled: true,
    dependsOn: null,
    workToday: 20,
    blockedReason: null,
    notHiredReason: null,
    lastRun: { status: 'success', startedAt: NOW - 6 * 60_000 },
    supportsExtraInstructions: true,
    ...over,
  };
}

const render = (
  d: AgentDetailView,
  over: { instructionsValue?: string; instructionsSaved?: string } = {},
) =>
  renderToStaticMarkup(
    React.createElement(AgentWindowView, {
      detail: d,
      busy: false,
      onToggle: () => {},
      now: NOW,
      instructionsValue: over.instructionsValue ?? '',
      instructionsSaved: over.instructionsSaved ?? '',
      instructionsMax: 2000,
    }),
  );

describe('sinceLabel', () => {
  it('scales from minutes to days', () => {
    expect(sinceLabel(NOW - 30_000, NOW)).toBe('just now');
    expect(sinceLabel(NOW - 6 * 60_000, NOW)).toBe('6 min ago');
    expect(sinceLabel(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(sinceLabel(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });

  it('says nothing when there is nothing to say', () => {
    expect(sinceLabel(null, NOW)).toBeNull();
    // Before the clock effect runs, rather than a nonsense duration.
    expect(sinceLabel(NOW, 0)).toBeNull();
  });
});

describe('AgentWindowView', () => {
  it('shows the agent, its duty, status, and details', () => {
    const html = render(detail());
    expect(html).toContain('Revival agent');
    expect(html).toContain('Chases leads that went quiet');
    expect(html).toContain('On duty');
    expect(html).toContain('A sweep every 30 minutes');
    expect(html).toContain('Sends nothing by itself');
    expect(html).toContain('6 min ago');
  });

  it('renders a switch only for an agent that owns one', () => {
    expect(render(detail())).toContain('Enabled');
  });

  it('states what controls an agent with no switch, and shows no switch', () => {
    const html = render(
      detail({
        key: 'checklist',
        name: 'Checklist writer',
        enabled: null,
        dependsOn: {
          label: 'Lead qualification',
          note: 'Runs whenever the qualification agent is on. It has no switch of its own.',
          agentKey: 'qualify',
        },
      }),
    );
    expect(html).toContain('no switch of its own');
    expect(html).toContain('Controlled by Lead qualification');
    // The absence is the point: no toggle that would write someone
    // else's config.
    expect(html).not.toContain('Enabled</span>');
  });

  it('marks instructions read-only and says why', () => {
    const html = render(detail());
    expect(html).toContain('Read-only');
    expect(html).toContain('structured data that gets parsed');
  });

  it('surfaces a blocker prominently', () => {
    const html = render(
      detail({ status: 'attention', blockedReason: 'no Meta token — ad names unresolved' }),
    );
    expect(html).toContain('no Meta token');
    expect(html).toContain('Needs attention');
  });

  it('says an unbuilt agent is not built, with its reason', () => {
    const html = render(
      detail({
        key: 'quote',
        name: 'Quote drafter',
        status: 'not_hired',
        instructions: null,
        trigger: null,
        reads: null,
        writes: null,
        enabled: null,
        dependsOn: null,
        lastRun: null,
        notHiredReason: 'needs a pricing catalogue',
      }),
    );
    expect(html).toContain('Not built yet');
    expect(html).toContain('needs a pricing catalogue');
    expect(html).not.toContain('Read-only');
  });

});

describe('additional instructions', () => {
  it('offers the box for an agent whose prompt reads it', () => {
    const html = render(detail());
    expect(html).toContain('Additional instructions');
    expect(html).toContain('never replacing it');
  });

  it('offers no box where the prompt would ignore it', () => {
    // A text area that silently does nothing is worse than none.
    const html = render(detail({ supportsExtraInstructions: false }));
    expect(html).not.toContain('Additional instructions');
  });

  it('counts characters against the cap', () => {
    const html = render(detail(), { instructionsValue: 'Mention visas' });
    expect(html).toContain('13 / 2000');
  });

  it('offers Save only once the text differs from what is stored', () => {
    const clean = render(detail(), {
      instructionsValue: 'Same', instructionsSaved: 'Same',
    });
    expect(clean).not.toContain('>Save<');
    const dirty = render(detail(), {
      instructionsValue: 'Changed', instructionsSaved: 'Same',
    });
    expect(dirty).toContain('Save');
  });
});
