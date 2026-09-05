import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/en.json';
import { NoWorkspace } from './no-workspace';

/**
 * Static-render tests, matching `conversions-tab.test.tsx`'s convention
 * (no jsdom; assertions scoped by `data-testid`).
 *
 * What these guard: this screen is the ONLY thing a removed teammate sees,
 * and the whole point of removing the shell-account mint is that they must
 * NOT be handed a private one-person CRM. So the assertions are about the
 * screen telling them the truth (they're in no workspace, an invite is how
 * they get back) and offering exactly two exits — sign out, or an invite
 * link from an admin. A "create your own workspace" button appearing here
 * would silently reintroduce the shell account this whole change deletes.
 */

function render(ui: React.ReactElement) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('NoWorkspace', () => {
  it('names the signed-in address so they know which login is stranded', () => {
    const html = render(
      <NoWorkspace email="casper@example.com" onSignOut={() => {}} />,
    );
    expect(html).toContain('casper@example.com');
  });

  it('says they belong to no workspace and that an invite is the way back', () => {
    const html = render(<NoWorkspace email={null} onSignOut={() => {}} />);
    expect(html).toMatch(/not a member of any workspace/i);
    expect(html).toMatch(/invite link/i);
  });

  it('offers a sign-out control', () => {
    const html = render(<NoWorkspace email={null} onSignOut={() => {}} />);
    expect(html).toContain('data-testid="no-workspace-sign-out"');
  });

  it('offers NO way to self-create a workspace', () => {
    const html = render(<NoWorkspace email={null} onSignOut={() => {}} />);
    expect(html).not.toMatch(/create (your own |a )?workspace/i);
    expect(html).not.toMatch(/create account/i);
  });

  it('renders without an email rather than printing null', () => {
    const html = render(<NoWorkspace email={null} onSignOut={() => {}} />);
    expect(html).not.toContain('null');
  });
});
