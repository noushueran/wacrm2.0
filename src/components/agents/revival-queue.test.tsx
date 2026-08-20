import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RevivalQueueView,
  blockedMessage,
  hoursLeft,
  type RevivalDraftView,
} from './revival-queue';

/**
 * Static-render tests, matching this repo's other component tests — there
 * is no jsdom here, so these assert on markup rather than on clicks. The
 * two pieces of logic worth exercising directly (`hoursLeft`,
 * `blockedMessage`) are standalone for exactly that reason.
 */

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function draft(over: Partial<RevivalDraftView> = {}): RevivalDraftView {
  return {
    id: 'd1',
    conversationId: 'c1',
    contactName: 'Ravi',
    body: 'Hi Ravi, still planning Dubai for December?',
    reason: 'Asked about visa timing, quiet 5h',
    confidence: 'high',
    assignedToUserId: null,
    createdAt: NOW - HOUR,
    expiresAt: NOW + 6 * HOUR,
    ...over,
  };
}

const render = (
  drafts: RevivalDraftView[],
  over: { overflow?: boolean; edits?: Record<string, string> } = {},
) =>
  renderToStaticMarkup(
    React.createElement(RevivalQueueView, {
      drafts,
      overflow: over.overflow ?? false,
      busyId: null,
      edits: over.edits ?? {},
      onEdit: () => {},
      onSend: () => {},
      onDismiss: () => {},
      now: NOW,
    }),
  );

describe('hoursLeft', () => {
  it('counts down whole hours to the window shutting', () => {
    expect(hoursLeft(NOW + 6 * HOUR, NOW)).toBe(6);
    expect(hoursLeft(NOW + 90 * 60_000, NOW)).toBe(1);
  });

  it('never goes negative — an overdue draft reads as zero, not minus', () => {
    expect(hoursLeft(NOW - 5 * HOUR, NOW)).toBe(0);
  });
});

describe('blockedMessage', () => {
  it('explains each refusal in terms a salesperson can act on', () => {
    expect(blockedMessage('customer_replied')).toContain('open the thread');
    expect(blockedMessage('expired')).toContain('24-hour window');
    expect(blockedMessage('do_not_contact')).toContain('not to be messaged');
  });

  it('falls back rather than showing a raw reason code', () => {
    const msg = blockedMessage('something_new_we_added_later');
    expect(msg).not.toContain('_');
    expect(msg.length).toBeGreaterThan(0);
  });
});

describe('RevivalQueueView', () => {
  it('invites rather than apologises when the queue is empty', () => {
    const html = render([]);
    expect(html).toContain('Nothing to chase right now');
    expect(html).toContain('Nothing is ever sent without you');
  });

  it('shows the contact, the reason, and the drafted message', () => {
    const html = render([draft()]);
    expect(html).toContain('Ravi');
    expect(html).toContain('Asked about visa timing');
    expect(html).toContain('still planning Dubai for December?');
  });

  it('states plainly that nothing sends on its own', () => {
    const html = render([draft()]);
    expect(html).toContain('Nothing sends until you tap send');
  });

  it('shows the time left, and marks a nearly-shut window', () => {
    expect(render([draft()])).toContain('6h left');
    const urgent = render([draft({ expiresAt: NOW + HOUR })]);
    expect(urgent).toContain('1h left');
    expect(urgent).toContain('amber');
  });

  it('says "closing now" rather than "0h left" at the edge', () => {
    expect(render([draft({ expiresAt: NOW })])).toContain('closing now');
  });

  it('renders an edit in place of the drafted body', () => {
    const html = render([draft()], { edits: { d1: 'A human rewrote this' } });
    expect(html).toContain('A human rewrote this');
    expect(html).not.toContain('still planning Dubai for December?');
  });

  it('marks a capped count as approximate', () => {
    expect(render([draft()], { overflow: true })).toContain('1+ waiting');
  });
});

it('hides the countdown until the clock has been read, rather than showing a nonsense figure', () => {
  // `now` is 0 on the first paint, before the clock effect runs.
  const html = renderToStaticMarkup(
    React.createElement(RevivalQueueView, {
      drafts: [draft()],
      overflow: false,
      busyId: null,
      edits: {},
      onEdit: () => {},
      onSend: () => {},
      onDismiss: () => {},
      now: 0,
    }),
  );
  expect(html).toContain('Ravi');
  expect(html).not.toContain('h left');
  expect(html).not.toContain('closing now');
});
