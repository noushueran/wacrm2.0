export type PushPayload = { title: string; body: string; url: string; tag: string };

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
}): PushPayload {
  const url = `/inbox?c=${input.conversationId}`;
  const tag = input.conversationId;
  if (input.hidePreview) {
    return { title: "Holidayys WA CRM", body: "New WhatsApp message", url, tag };
  }
  return {
    title: input.contactName?.trim() || "New message",
    body: previewFor(input.contentType, input.text),
    url,
    tag,
  };
}
