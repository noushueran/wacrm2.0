// Open Graph card for /join/* — the preview shown when an invite link is
// shared in WhatsApp / Slack / Facebook / LinkedIn / iMessage. Next.js reads
// the `alt` / `size` / `contentType` exports and auto-injects the matching
// `<meta property="og:image*">` tags (with an absolute URL derived from the
// root layout's `metadataBase`). The card itself lives in one shared module
// so the OG and Twitter images can't drift — see that file's header.
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
