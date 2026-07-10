/**
 * Meta WhatsApp Cloud API senders — Convex port of the subset of
 * `src/lib/whatsapp/meta-api.ts` that `convex/metaSend.ts`'s actions
 * need: plain-text, media, template (simplified), and interactive
 * (buttons/list) sends, plus the `INTERACTIVE_LIMITS` constants both
 * `convex/lib/whatsapp/interactive.ts` and `convex/lib/flows/validate.ts`
 * validate against. Quote style converted to double-quote (this
 * codebase's `convex/` convention); behavior otherwise unchanged for
 * everything kept.
 *
 * NOT ported (out of scope — template-header media handles and
 * template-management-only edit/delete, neither touched by the
 * connect-flow regression fix or Phase 8 Task 4's template
 * management): `uploadResumableMedia`, `editMessageTemplate`,
 * `deleteMessageTemplate`.
 *
 * `verifyPhoneNumber`/`getSubscribedApps` WERE ported (AI/WhatsApp
 * backend gap-fill task) — `convex/whatsappConfig.ts`'s
 * `verifyRegistration` action needs both for its read-only Meta-side
 * diagnostic checks (phone metadata + WABA app-subscription).
 * `registerPhoneNumber`/`subscribeWabaToApp` (the POST /register +
 * POST /subscribed_apps calls that actually WRITE to Meta — unlike
 * every other function in this section, which only ever GETs) WERE
 * ALSO ported (connect-flow regression fix): the settings form's Save
 * button had been wired straight to `whatsappConfig.upsert`, which
 * only stores the row and never actually registers a saved production
 * number for inbound webhooks. `convex/whatsappConfig.ts`'s
 * `connectAndSave` action (the Convex port of the save/POST route)
 * needs both to restore that missing verify→register→subscribe
 * pipeline.
 *
 * `getMediaUrl`/`downloadMedia` WERE ALSO ported (inbound-media-proxy
 * migration): `convex/whatsappConfig.ts`'s `fetchMedia` action needs
 * both so the Meta media fetch happens INSIDE Convex, right next to
 * the just-decrypted access token, instead of back in the Next.js
 * route (`src/app/api/whatsapp/media/[mediaId]/route.ts`) — the
 * decrypted token should never have to travel back out to Next.js
 * just to make this call. One deliberate deviation from `src/lib/
 * whatsapp/meta-api.ts`'s originals: `downloadMedia` here returns an
 * `ArrayBuffer` (`Response#arrayBuffer()`), not a Node `Buffer` — this
 * file's functions run in Convex's default V8-isolate runtime (no
 * `"use node"`, matching every other function here, same as `convex/
 * files.ts`'s `storeFromUrl`), where `Buffer` doesn't exist, and
 * Convex's wire format carries binary return values as `ArrayBuffer`
 * (`v.bytes()`) anyway — so `fetchMedia` would have had to convert
 * back out of `Buffer` regardless.
 *
 * `sendReactionMessage` WAS ported (Phase 8, Task 4) — `convex/
 * metaSend.ts`'s `sendReaction` needs it for the public `reactToMeta`
 * action's Meta leg. `submitMessageTemplate`/`listMessageTemplates`
 * (bottom of this file) WERE ALSO ported then, for `convex/
 * metaTemplates.ts`'s `submitToMeta`/`syncFromMeta` — a DIFFERENT Graph
 * API surface (`/{waba-id}/message_templates`) than every sender above
 * (`/{phone-number-id}/messages`); `listMessageTemplates` is new here
 * (the source app's sync route inlined its own fetch+pagination loop
 * rather than going through a named helper).
 *
 * `sendTemplateMessage` is intentionally the SIMPLIFIED legacy
 * body-only-params path from the original — the structured
 * `template`/`messageParams` builder (media headers, URL/COPY_CODE
 * buttons) depends on a `message_templates` row + the Next.js-only
 * `template-send-builder.ts`, neither of which this task ports. Every
 * function still takes a single options object (named parameters),
 * matching the original's own convention (see its header comment: a
 * swapped-args bug was hit four times with positional args).
 */

import type { MetaTemplateSubmitPayload } from "./templateComponents";

const META_API_VERSION = "v21.0";
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

export interface MetaSendResult {
  messageId: string;
}

interface MetaErrorResponse {
  error?: { message?: string; code?: number; type?: string };
}

async function throwMetaError(
  response: Response,
  fallback: string,
): Promise<never> {
  let message = fallback;
  try {
    const data = (await response.json()) as MetaErrorResponse;
    if (data.error?.message) message = data.error.message;
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message);
}

// ============================================================
// Phone number / account — read-only diagnostic GETs for
// `convex/whatsappConfig.ts`'s `verifyRegistration` action. Neither
// call writes anything on Meta's side, unlike `registerPhoneNumber`/
// `subscribeWabaToApp` (still NOT ported — see this file's header).
// ============================================================

export interface MetaPhoneInfo {
  id: string;
  display_phone_number: string;
  verified_name?: string;
  quality_rating?: string;
}

export interface VerifyPhoneNumberArgs {
  phoneNumberId: string;
  accessToken: string;
}

/**
 * Verify a Meta phone number ID by fetching its public metadata
 * (display_phone_number, verified_name, quality_rating). Convex port of
 * `src/lib/whatsapp/meta-api.ts`'s function of the same name — ported
 * verbatim (quote style aside).
 */
export async function verifyPhoneNumber(
  args: VerifyPhoneNumberArgs,
): Promise<MetaPhoneInfo> {
  const { phoneNumberId, accessToken } = args;
  const url = `${META_API_BASE}/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  return response.json();
}

// ============================================================
// Cloud API registration (subscription for inbound webhooks) —
// `convex/whatsappConfig.ts`'s `connectAndSave` action needs both of
// these (the save/POST-route port). Saving a phoneNumberId + accessToken
// to `whatsappConfig` is NOT enough to receive inbound events from
// Meta; see `src/lib/whatsapp/meta-api.ts`'s own header comment on this
// section (ported verbatim below, quote style aside) for the full
// rationale on why both calls are required and idempotent.
// ============================================================

export interface RegisterPhoneNumberArgs {
  phoneNumberId: string;
  accessToken: string;
  /**
   * 6-digit PIN the user set in Meta WhatsApp Manager →
   * Two-step verification. If 2FA is not enabled on the number,
   * Meta rejects /register with a clear error and the user is
   * pointed at the right setting in the UI.
   */
  pin: string;
}

export interface RegisterPhoneNumberResult {
  success: boolean;
  /**
   * True when Meta indicated the number was already registered to
   * THIS app — same outcome as a fresh registration from the
   * caller's POV, surfaced separately for logging clarity.
   */
  alreadyRegistered: boolean;
}

/**
 * Register a phone number for inbound webhook events. Convex port of
 * `src/lib/whatsapp/meta-api.ts`'s function of the same name — ported
 * verbatim (quote style aside).
 *
 * Errors that should be surfaced verbatim to the user:
 *   * Missing / wrong PIN  → "Two-step verification PIN required..."
 *   * No 2FA enabled       → "Two-factor authentication is not on..."
 *   * Number on other app  → "Number is registered to another app..."
 */
export async function registerPhoneNumber(
  args: RegisterPhoneNumberArgs,
): Promise<RegisterPhoneNumberResult> {
  const { phoneNumberId, accessToken, pin } = args;
  const url = `${META_API_BASE}/${phoneNumberId}/register`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });

  if (response.ok) {
    return { success: true, alreadyRegistered: false };
  }

  // Meta returns an error envelope with a code. Code 133005 + the
  // text "already registered" appears when the number is already
  // subscribed to this app — that's success from the caller's
  // perspective, surface it as such.
  let data: {
    error?: { message?: string; code?: number; error_subcode?: number };
  } = {};
  try {
    data = await response.json();
  } catch {
    /* keep empty */
  }
  const message = data.error?.message ?? `Meta API error: ${response.status}`;
  if (/already.*registered/i.test(message)) {
    return { success: true, alreadyRegistered: true };
  }
  throw new Error(message);
}

export interface SubscribeWabaToAppArgs {
  wabaId: string;
  accessToken: string;
}

/**
 * Subscribe the WABA to this Meta app's webhook. Idempotent — Meta
 * returns success even when the subscription already exists. Convex
 * port of `src/lib/whatsapp/meta-api.ts`'s function of the same name —
 * ported verbatim (quote style aside).
 */
export async function subscribeWabaToApp(
  args: SubscribeWabaToAppArgs,
): Promise<void> {
  const { wabaId, accessToken } = args;
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
}

export interface GetSubscribedAppsArgs {
  wabaId: string;
  accessToken: string;
}

export interface SubscribedApp {
  whatsapp_business_api_data?: {
    id?: string;
    name?: string;
    link?: string;
  };
}

/**
 * Diagnostic — fetch the list of apps currently subscribed to this
 * WABA. `verifyRegistration` treats any non-empty result as proof OUR
 * app is subscribed (the access token used to ask belongs to our app —
 * Meta wouldn't return data for an app the token can't see). Convex
 * port of `src/lib/whatsapp/meta-api.ts`'s function of the same name.
 */
export async function getSubscribedApps(
  args: GetSubscribedAppsArgs,
): Promise<SubscribedApp[]> {
  const { wabaId, accessToken } = args;
  const url = `${META_API_BASE}/${wabaId}/subscribed_apps`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = (await response.json()) as { data?: SubscribedApp[] };
  return data.data ?? [];
}

// ============================================================
// Media — the two-step inbound-media-proxy flow for `convex/
// whatsappConfig.ts`'s `fetchMedia` action: resolve a Meta media id to
// its short-lived authenticated CDN URL + MIME type, then download
// the bytes from that URL (same Bearer token both times). See this
// file's header comment for why `downloadMedia` returns an
// `ArrayBuffer` rather than the Node `Buffer` its `src/lib/whatsapp/
// meta-api.ts` counterpart returns.
// ============================================================

export interface GetMediaUrlArgs {
  mediaId: string;
  accessToken: string;
}

/**
 * Resolve a media ID to Meta's (short-lived, authenticated) CDN URL
 * plus the MIME type. Step one of the media-proxy flow. Convex port
 * of `src/lib/whatsapp/meta-api.ts`'s function of the same name —
 * ported verbatim (quote style aside).
 */
export async function getMediaUrl(
  args: GetMediaUrlArgs,
): Promise<{ url: string; mimeType: string }> {
  const { mediaId, accessToken } = args;
  const response = await fetch(`${META_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    await throwMetaError(response, `Media fetch failed: ${response.status}`);
  }
  const data = await response.json();
  if (!data.url) throw new Error("Media URL not found in Meta response");
  return {
    url: data.url,
    mimeType: data.mime_type || "application/octet-stream",
  };
}

export interface DownloadMediaArgs {
  downloadUrl: string;
  accessToken: string;
}

/**
 * Fetch the binary bytes for a media URL obtained from `getMediaUrl`.
 * Step two of the media-proxy flow. Returns an `ArrayBuffer` (via
 * `Response#arrayBuffer()`) rather than the source's Node `Buffer` —
 * see this file's header comment.
 */
export async function downloadMedia(
  args: DownloadMediaArgs,
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const { downloadUrl, accessToken } = args;
  const response = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Media download failed: ${response.status}`);
  }
  const contentType =
    response.headers.get("content-type") || "application/octet-stream";
  const buffer = await response.arrayBuffer();
  return { buffer, contentType };
}

// ============================================================
// Sending
// ============================================================

export interface SendTextMessageArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  text: string;
  /** Meta's message_id of the message being replied to. Adds a `context` field
   *  so WhatsApp renders the new message as a reply with a quote preview. */
  contextMessageId?: string;
}

/**
 * Send a free-form WhatsApp text message.
 * Only works inside the 24-hour customer service window.
 */
export async function sendTextMessage(
  args: SendTextMessageArgs,
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, text, contextMessageId } = args;
  const url = `${META_API_BASE}/${phoneNumberId}/messages`;
  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { body: text },
  };
  if (contextMessageId) {
    body.context = { message_id: contextMessageId };
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = await response.json();
  return { messageId: data.messages[0].id };
}

export type MediaKind = "image" | "video" | "document" | "audio";

export interface SendMediaMessageArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  kind: MediaKind;
  /** Public URL Meta fetches at send time. */
  link: string;
  /** Optional caption — Meta caps at 1024 chars. Documents + images + videos accept it; audio does NOT. */
  caption?: string;
  /** Document-only. Shown in the recipient's chat as the file name. Ignored for image/video/audio. */
  filename?: string;
  contextMessageId?: string;
}

/**
 * Send an image, video, document, or audio (voice note) via a public URL.
 *
 * Audio is special-cased: Meta rejects `caption` and `filename` on audio
 * messages, so we send `{ link }` only. WhatsApp auto-renders an
 * OGG/Opus file as a playable voice note (waveform) rather than a file
 * attachment.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs,
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    kind,
    link,
    caption,
    filename,
    contextMessageId,
  } = args;
  if (!link) throw new Error("sendMediaMessage requires a link.");
  const url = `${META_API_BASE}/${phoneNumberId}/messages`;

  // Audio accepts neither caption nor filename per Meta's spec — adding
  // either yields a 400. image/video/document accept a caption; only
  // document accepts a filename.
  const media: Record<string, unknown> = { link };
  if (caption && kind !== "audio") media.caption = caption;
  if (kind === "document" && filename) media.filename = filename;

  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: kind,
    [kind]: media,
  };
  if (contextMessageId) body.context = { message_id: contextMessageId };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = await response.json();
  return { messageId: data.messages[0].id };
}

export interface SendTemplateMessageArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  templateName: string;
  language?: string;
  /**
   * Legacy body-only params (positional `{{1}}`, `{{2}}`, ... values).
   * See this file's header comment for why the structured
   * `template`/`messageParams` builder path wasn't ported.
   */
  params?: string[];
  /** Meta's message_id of the message being replied to. */
  contextMessageId?: string;
}

/**
 * Send a pre-approved WhatsApp message template (legacy body-only
 * params path). Required outside the 24-hour window and for any
 * first-touch messaging.
 */
export async function sendTemplateMessage(
  args: SendTemplateMessageArgs,
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    templateName,
    language = "en_US",
    params,
    contextMessageId,
  } = args;
  const url = `${META_API_BASE}/${phoneNumberId}/messages`;

  const templatePayload: Record<string, unknown> = {
    name: templateName,
    language: { code: language },
  };
  if (params && params.length > 0) {
    templatePayload.components = [
      {
        type: "body",
        parameters: params.map((p) => ({ type: "text", text: String(p) })),
      },
    ];
  }

  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: templatePayload,
  };
  if (contextMessageId) {
    body.context = { message_id: contextMessageId };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = await response.json();
  return { messageId: data.messages[0].id };
}

// ============================================================
// Reactions
// ============================================================

export interface SendReactionMessageArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  /** Meta's message_id of the message being reacted to. */
  targetMessageId: string;
  /** Single emoji, or empty string to remove an existing reaction. */
  emoji: string;
}

/**
 * Send a reaction (or removal) to a previously-exchanged message.
 * Empty `emoji` removes the reaction per Meta's spec. Convex port of
 * `src/lib/whatsapp/meta-api.ts`'s `sendReactionMessage` — ported
 * verbatim (quote style aside) for `convex/metaSend.ts`'s `sendReaction`.
 */
export async function sendReactionMessage(
  args: SendReactionMessageArgs,
): Promise<MetaSendResult> {
  const { phoneNumberId, accessToken, to, targetMessageId, emoji } = args;
  const url = `${META_API_BASE}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "reaction",
      reaction: { message_id: targetMessageId, emoji },
    }),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = await response.json();
  return { messageId: data.messages[0].id };
}

// ============================================================
// Interactive (button replies + list messages)
// ============================================================
//
// Meta's two flavours of interactive message — used by the Flows and
// Automations engines to drive scripted chatbot menus. Caller passes
// plain JS values; helpers shape the Meta payload and enforce Meta's
// limits BEFORE the network call so the failure mode is a
// developer-facing error rather than a customer-facing one.

/**
 * Meta limits for interactive messages, hard-coded so violations
 * fail before a network call rather than as a 400 from the Meta API
 * mid-conversation. See:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-reply-buttons-messages
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/messages/interactive-list-messages
 */
export const INTERACTIVE_LIMITS = {
  maxButtons: 3,
  buttonTitleMaxLength: 20,
  maxListSections: 10,
  maxListRowsTotal: 10,
  listRowTitleMaxLength: 24,
  listRowDescriptionMaxLength: 72,
  bodyMaxLength: 1024,
  footerMaxLength: 60,
  headerTextMaxLength: 60,
} as const;

export interface InteractiveButton {
  /** Stable id sent back in the webhook when tapped (≤ 256 chars). */
  id: string;
  /** Visible label (≤ 20 chars per Meta). */
  title: string;
}

export interface SendInteractiveButtonsArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  /** The body text — what the customer reads above the buttons. */
  bodyText: string;
  /** Optional plain-text header (≤ 60 chars). */
  headerText?: string;
  /** Optional grey footer line under the buttons (≤ 60 chars). */
  footerText?: string;
  /** 1–3 buttons. Validated against Meta's limits before sending. */
  buttons: InteractiveButton[];
  /** Meta's message_id of the message being replied to (quote preview). */
  contextMessageId?: string;
}

/**
 * Send an interactive message with up to 3 inline reply buttons. The
 * customer taps one and Meta delivers a webhook with
 * `messages[0].interactive.button_reply.id` set to the matching button.id.
 *
 * Validation throws BEFORE the network call so misconfigured flows
 * fail at save/send time, not mid-conversation.
 */
export async function sendInteractiveButtons(
  args: SendInteractiveButtonsArgs,
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    bodyText,
    headerText,
    footerText,
    buttons,
    contextMessageId,
  } = args;
  validateInteractiveBody(bodyText);
  validateInteractiveHeaderFooter(headerText, footerText);
  if (buttons.length < 1 || buttons.length > INTERACTIVE_LIMITS.maxButtons) {
    throw new Error(
      `Interactive button message requires 1-${INTERACTIVE_LIMITS.maxButtons} buttons (got ${buttons.length}).`,
    );
  }
  const seenButtonIds = new Set<string>();
  for (const btn of buttons) {
    if (!btn.id) throw new Error("Interactive button missing id.");
    // Duplicate button ids make the tapped-button webhook ambiguous —
    // Meta rejects them, and the pre-flight validator (interactive.ts)
    // rejects them too, so guard here to keep the two paths in step.
    if (seenButtonIds.has(btn.id)) {
      throw new Error(
        `Interactive message has duplicate button id "${btn.id}".`,
      );
    }
    seenButtonIds.add(btn.id);
    if (!btn.title) {
      throw new Error(`Interactive button "${btn.id}" missing title.`);
    }
    if (btn.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
      throw new Error(
        `Interactive button title "${btn.title}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`,
      );
    }
  }

  const interactive: Record<string, unknown> = {
    type: "button",
    body: { text: bodyText },
    action: {
      buttons: buttons.map((b) => ({
        type: "reply",
        reply: { id: b.id, title: b.title },
      })),
    },
  };
  if (headerText) interactive.header = { type: "text", text: headerText };
  if (footerText) interactive.footer = { text: footerText };

  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive,
  };
  if (contextMessageId) body.context = { message_id: contextMessageId };

  const url = `${META_API_BASE}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = await response.json();
  return { messageId: data.messages[0].id };
}

export interface InteractiveListRow {
  /** Stable id sent back in the webhook when tapped (≤ 200 chars). */
  id: string;
  /** Visible row title (≤ 24 chars per Meta). */
  title: string;
  /** Optional secondary line shown under the title (≤ 72 chars). */
  description?: string;
}

export interface InteractiveListSection {
  /** Optional section header shown above its rows. */
  title?: string;
  rows: InteractiveListRow[];
}

export interface SendInteractiveListArgs {
  phoneNumberId: string;
  accessToken: string;
  to: string;
  bodyText: string;
  /** Label of the tap-to-expand button on the message bubble. */
  buttonLabel: string;
  headerText?: string;
  footerText?: string;
  /**
   * 1–10 rows TOTAL across all sections. Meta caps the *total*, not
   * per-section. Validation enforces this before send.
   */
  sections: InteractiveListSection[];
  contextMessageId?: string;
}

/**
 * Send an interactive message with a tap-to-expand list of selectable
 * rows. Use when there are more options than the 3-button limit allows.
 * Webhook arrives with `messages[0].interactive.list_reply.id` set to
 * the matching row.id.
 */
export async function sendInteractiveList(
  args: SendInteractiveListArgs,
): Promise<MetaSendResult> {
  const {
    phoneNumberId,
    accessToken,
    to,
    bodyText,
    buttonLabel,
    headerText,
    footerText,
    sections,
    contextMessageId,
  } = args;
  validateInteractiveBody(bodyText);
  validateInteractiveHeaderFooter(headerText, footerText);
  if (!buttonLabel) throw new Error("Interactive list requires a buttonLabel.");
  if (buttonLabel.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
    throw new Error(
      `Interactive list buttonLabel "${buttonLabel}" exceeds ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars.`,
    );
  }
  if (
    sections.length < 1 ||
    sections.length > INTERACTIVE_LIMITS.maxListSections
  ) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListSections} sections (got ${sections.length}).`,
    );
  }
  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0);
  if (totalRows < 1 || totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
    throw new Error(
      `Interactive list requires 1-${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across all sections (got ${totalRows}).`,
    );
  }
  const seenIds = new Set<string>();
  for (const section of sections) {
    for (const row of section.rows) {
      if (!row.id) throw new Error("Interactive list row missing id.");
      if (seenIds.has(row.id)) {
        throw new Error(
          `Interactive list has duplicate row id "${row.id}".`,
        );
      }
      seenIds.add(row.id);
      if (!row.title) {
        throw new Error(`Interactive list row "${row.id}" missing title.`);
      }
      if (row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength) {
        throw new Error(
          `Interactive list row title "${row.title}" exceeds ${INTERACTIVE_LIMITS.listRowTitleMaxLength} chars.`,
        );
      }
      if (
        row.description &&
        row.description.length >
          INTERACTIVE_LIMITS.listRowDescriptionMaxLength
      ) {
        throw new Error(
          `Interactive list row description for "${row.id}" exceeds ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} chars.`,
        );
      }
    }
  }

  const interactive: Record<string, unknown> = {
    type: "list",
    body: { text: bodyText },
    action: {
      button: buttonLabel,
      sections: sections.map((s) => ({
        ...(s.title ? { title: s.title } : {}),
        rows: s.rows.map((r) => ({
          id: r.id,
          title: r.title,
          ...(r.description ? { description: r.description } : {}),
        })),
      })),
    },
  };
  if (headerText) interactive.header = { type: "text", text: headerText };
  if (footerText) interactive.footer = { text: footerText };

  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive,
  };
  if (contextMessageId) body.context = { message_id: contextMessageId };

  const url = `${META_API_BASE}/${phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = await response.json();
  return { messageId: data.messages[0].id };
}

function validateInteractiveBody(bodyText: string): void {
  if (!bodyText) throw new Error("Interactive message requires bodyText.");
  if (bodyText.length > INTERACTIVE_LIMITS.bodyMaxLength) {
    throw new Error(
      `Interactive bodyText exceeds ${INTERACTIVE_LIMITS.bodyMaxLength} chars.`,
    );
  }
}

function validateInteractiveHeaderFooter(
  headerText: string | undefined,
  footerText: string | undefined,
): void {
  if (headerText && headerText.length > INTERACTIVE_LIMITS.headerTextMaxLength) {
    throw new Error(
      `Interactive headerText exceeds ${INTERACTIVE_LIMITS.headerTextMaxLength} chars.`,
    );
  }
  if (footerText && footerText.length > INTERACTIVE_LIMITS.footerMaxLength) {
    throw new Error(
      `Interactive footerText exceeds ${INTERACTIVE_LIMITS.footerMaxLength} chars.`,
    );
  }
}

// ============================================================
// Template management (Phase 8, Task 4) — create + list message
// templates on the WABA. A DIFFERENT Graph API surface than every
// sender above (`/{waba-id}/message_templates` vs `/{phone-number-id}
// /messages`) — ported for `convex/metaTemplates.ts`'s
// `submitToMeta`/`syncFromMeta` internalActions.
// ============================================================

export interface SubmitMessageTemplateArgs {
  wabaId: string;
  accessToken: string;
  payload: MetaTemplateSubmitPayload;
}

export interface SubmitMessageTemplateResult {
  id: string;
  status: string;
  category?: string;
}

/**
 * Submit a message template to Meta for approval. Returns Meta's
 * assigned template id + initial status (typically PENDING). Faithful
 * port of `src/lib/whatsapp/meta-api.ts`'s function of the same name.
 * 429s (rate limit: 100 creates/hour/WABA) surface as a regular
 * `Error("Meta API error: 429")` via `throwMetaError` — the nicer
 * "try again later" message the source route's HTTP handler gave a
 * 429 is a UI-layer nicety this port's caller can add, not something
 * this network primitive needs to know about.
 */
export async function submitMessageTemplate(
  args: SubmitMessageTemplateArgs,
): Promise<SubmitMessageTemplateResult> {
  const { wabaId, accessToken, payload } = args;
  const url = `${META_API_BASE}/${wabaId}/message_templates`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    await throwMetaError(response, `Meta API error: ${response.status}`);
  }
  const data = await response.json();
  if (!data?.id) {
    throw new Error("Meta accepted the template but returned no id.");
  }
  return {
    id: String(data.id),
    status: typeof data.status === "string" ? data.status : "PENDING",
    category: typeof data.category === "string" ? data.category : undefined,
  };
}

export interface MetaTemplateButtonRaw {
  type: string;
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[] | string;
}

export interface MetaTemplateComponentRaw {
  type: string;
  text?: string;
  format?: string;
  buttons?: MetaTemplateButtonRaw[];
  example?: {
    header_text?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
}

export interface MetaTemplateListItem {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: MetaTemplateComponentRaw[];
  quality_score?: { score?: string } | string;
}

export interface ListMessageTemplatesArgs {
  wabaId: string;
  accessToken: string;
}

export interface ListMessageTemplatesResult {
  templates: MetaTemplateListItem[];
  truncated: boolean;
}

// Same cap as the source sync route's own `PAGE_CAP` — a runaway
// `paging.next` chain (or a WABA with an unusual number of templates)
// stops after 20 pages (2,000 templates at limit=100) rather than
// looping forever.
const TEMPLATE_LIST_PAGE_CAP = 20;

/**
 * List every message template on a WABA, following Meta's cursor
 * pagination up to `TEMPLATE_LIST_PAGE_CAP` pages. Returns `truncated:
 * true` rather than throwing when the cap is hit — mirrors the source
 * sync route's own `truncated` response field. NEW here (not a port —
 * the source route inlined this loop directly in its POST handler).
 */
export async function listMessageTemplates(
  args: ListMessageTemplatesArgs,
): Promise<ListMessageTemplatesResult> {
  const { wabaId, accessToken } = args;
  const templates: MetaTemplateListItem[] = [];
  let nextUrl: string | null =
    `${META_API_BASE}/${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`;
  let pageCount = 0;

  while (nextUrl && pageCount < TEMPLATE_LIST_PAGE_CAP) {
    pageCount++;
    const response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      await throwMetaError(response, `Meta API error: ${response.status}`);
    }
    const body: { data?: MetaTemplateListItem[]; paging?: { next?: string } } =
      await response.json();
    if (body.data) templates.push(...body.data);
    nextUrl = body.paging?.next ?? null;
  }

  return {
    templates,
    truncated: pageCount >= TEMPLATE_LIST_PAGE_CAP && nextUrl !== null,
  };
}
