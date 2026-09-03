export type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
  /**
   * This recipient's unread-conversation count AFTER the message that
   * triggered the push — what the service worker writes to the app-icon
   * badge (`navigator.setAppBadge`).
   *
   * Optional, and deliberately so: it is per-RECIPIENT (role scoping
   * means an agent and an owner see different totals for the same
   * account), so any payload that isn't assembled per-recipient must
   * omit it rather than guess. `sw.js` ignores a missing/invalid value
   * and leaves the existing badge alone, so omitting it is always safe.
   *
   * NOT hidden by `hidePreview`: a bare number on the icon leaks nothing
   * a lock screen shouldn't see — no name, no phone, no message text.
   */
  unread?: number;
  /**
   * The conversation this notification is about, as its own field.
   *
   * `tag` happens to equal the conversation id for inbound messages, but
   * the qualified-lead payload already prefixes its tag — so the service
   * worker's shade actions (Reply / Mark read) read this instead of
   * parsing `tag` or the `url`. A notification without it simply shows
   * no action buttons.
   */
  conversationId?: string;
};
import { productName } from "./brand";

const TYPE_LABEL: Record<string, string> = {
  image: "📷 Photo",
  audio: "🎤 Voice message",
  video: "🎬 Video",
  document: "📄 Document",
  location: "📍 Location",
  template: "💬 Message",
  interactive: "💬 Message",
};

function previewFor(contentType: string, text?: string | null): string {
  if (contentType === "text") {
    const t = (text ?? "").trim();
    return t.length > 120 ? `${t.slice(0, 120)}…` : t || "💬 Message";
  }
  return TYPE_LABEL[contentType] ?? "💬 Message";
}

// Builds the OS notification content. `hidePreview` collapses everything
// to a generic string (privacy on the lock screen) but keeps the routing
// url + tag so a tap still opens the right conversation. No phone numbers.
export function buildInboundPayload(input: {
  contactName?: string | null;
  contentType: string;
  text?: string | null;
  conversationId: string;
  hidePreview: boolean;
  /** See `PushPayload.unread`. Omit when no per-recipient count is known. */
  unread?: number;
}): PushPayload {
  const url = `/inbox?c=${input.conversationId}`;
  const tag = input.conversationId;
  // Spread rather than always writing the key: `unread: undefined` would
  // survive into the JSON payload as a missing key anyway, but keeping it
  // off the object makes the "no count known" case explicit at every call
  // site and in every test assertion.
  const badge = input.unread === undefined ? {} : { unread: input.unread };
  const conversationId = input.conversationId;
  if (input.hidePreview) {
    return {
      title: productName(),
      body: "New WhatsApp message",
      url,
      tag,
      conversationId,
      ...badge,
    };
  }
  return {
    title: input.contactName?.trim() || "New message",
    body: previewFor(input.contentType, input.text),
    url,
    tag,
    conversationId,
    ...badge,
  };
}

/**
 * Qualified-lead push (qualification P2). `hidePreview` collapses to a
 * generic body (no name/score on the lock screen) but keeps the routing
 * url + tag. Tag is distinct from the inbound-message tag so a lead
 * alert never coalesces away an unread-message notification.
 */
export function buildQualifiedLeadPayload(input: {
  contactName?: string | null;
  serviceName?: string | null;
  score?: number | null;
  conversationId: string;
  hidePreview: boolean;
}): PushPayload {
  const url = `/inbox?c=${input.conversationId}`;
  const tag = `qualified-${input.conversationId}`;
  if (input.hidePreview) {
    return {
      title: productName(),
      body: "New qualified lead",
      url,
      tag,
      conversationId: input.conversationId,
    };
  }
  const parts = [
    input.contactName?.trim() || "New lead",
    input.serviceName?.trim() || null,
    input.score !== null && input.score !== undefined ? `score ${input.score}/100` : null,
  ].filter(Boolean);
  return {
    title: "🎯 New qualified lead",
    body: parts.join(" · "),
    url,
    tag,
    conversationId: input.conversationId,
  };
}
