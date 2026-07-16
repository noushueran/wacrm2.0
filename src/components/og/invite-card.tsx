import { ImageResponse } from 'next/og';

// ============================================================
// Shared 1200×630 social card for the /join invite page.
//
// Rendered by BOTH `src/app/join/opengraph-image.tsx` and
// `src/app/join/twitter-image.tsx` so the Open Graph and Twitter cards
// stay byte-identical without duplicating the JSX. This is what shows up
// when an admin pastes an invite link into WhatsApp / Slack / iMessage —
// the page itself stays `noindex` (the URL carries a live invite token),
// but social crawlers still unfurl this branded preview.
//
// Design notes
//   - Reuses the brand mark from `src/app/icon.tsx` (violet #7c3aed
//     rounded tile + white chat-square glyph) so the card, the favicon,
//     and the sidebar logo can't drift.
//   - No `fonts` option is passed: `next/og` bundles Geist-Regular as its
//     default face, so text renders at BUILD TIME with no network fetch
//     (important — the production build runs on Netlify).
//   - Only flexbox + the CSS subset satori supports is used (no grid); the
//     card is fully static (no request-time data) so Next.js statically
//     optimizes it into a cached PNG.
// ============================================================

// Kept in one place so the route files' `export const size` and this
// ImageResponse agree.
export const INVITE_OG_SIZE = { width: 1200, height: 630 } as const;
export const INVITE_OG_ALT =
  'You are invited to join a team on Holidayys WA CRM';
export const INVITE_OG_CONTENT_TYPE = 'image/png';

export function renderInviteOgImage(): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background:
          'linear-gradient(135deg, #0b1120 0%, #020617 55%, #1e1b4b 100%)',
        padding: '72px 88px',
        color: '#ffffff',
      }}
    >
      {/* Brand lockup: mark + wordmark */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div
          style={{
            width: 96,
            height: 96,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#7c3aed',
            borderRadius: 22,
          }}
        >
          <svg
            width="54"
            height="54"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#ffffff"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 28, letterSpacing: 4, color: '#a5b4fc' }}>
            HOLIDAYYS
          </div>
          <div style={{ fontSize: 40, fontWeight: 700 }}>WhatsApp CRM</div>
        </div>
      </div>

      {/* Headline block */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div
          style={{
            fontSize: 72,
            fontWeight: 700,
            lineHeight: 1.04,
            letterSpacing: -1.5,
          }}
        >
          {"You're invited to the team"}
        </div>
        <div style={{ fontSize: 32, color: '#94a3b8', maxWidth: 920 }}>
          {
            'Accept your invitation to join a shared WhatsApp inbox, contacts, and pipelines.'
          }
        </div>
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            width: 10,
            height: 10,
            borderRadius: 5,
            background: '#22c55e',
          }}
        />
        <div style={{ fontSize: 26, color: '#64748b' }}>
          Holidays Tours LLC · Internal team access
        </div>
      </div>
    </div>,
    { ...INVITE_OG_SIZE }
  );
}
