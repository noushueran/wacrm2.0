// Twitter/X card for /join/* — the same branded card as `opengraph-image`,
// emitted as `<meta name="twitter:image*">`. Kept as a dedicated file (rather
// than relying on the OG fallback) so the `summary_large_image` card set in
// `layout.tsx` always has an explicit image. Renders the shared module so the
// two cards stay identical.
import {
  INVITE_OG_ALT,
  INVITE_OG_CONTENT_TYPE,
  INVITE_OG_SIZE,
  renderInviteOgImage,
} from '@/components/og/invite-card';

export const alt = INVITE_OG_ALT;
export const size = INVITE_OG_SIZE;
export const contentType = INVITE_OG_CONTENT_TYPE;

export default function Image() {
  return renderInviteOgImage();
}
