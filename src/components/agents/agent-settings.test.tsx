import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AGENTS_WITH_SETTINGS, hasSettings } from './agent-settings';
import { MovedToAgent } from '../settings/moved-to-agent';

describe('hasSettings', () => {
  it('claims an editor only for the agents that have one', () => {
    expect(hasSettings('qualify')).toBe(true);
    expect(hasSettings('score')).toBe(true);
    expect(hasSettings('revival')).toBe(true);
  });

  it('claims nothing for agents with no editor, including unbuilt ones', () => {
    for (const key of ['reply', 'tags', 'admatch', 'checklist', 'quote']) {
      expect(hasSettings(key), `${key} should have no settings panel`).toBe(false);
    }
  });

  it('lists exactly the agents it renders', () => {
    expect([...AGENTS_WITH_SETTINGS].sort()).toEqual(['coach', 'kbgap', 'qualify', 'revival', 'score']);
  });
});

describe('MovedToAgent', () => {
  it('points at the agent instead of showing a second copy of the form', () => {
    const html = renderToStaticMarkup(
      React.createElement(MovedToAgent, {
        agentKey: 'qualify',
        agentName: 'Qualification agent',
        what: 'How leads are qualified',
      }),
    );
    expect(html).toContain('How leads are qualified');
    expect(html).toContain('Qualification agent');
    // Deep-links straight into that agent's window.
    expect(html).toContain('/agents?tab=roster&amp;agent=qualify');
  });
});
