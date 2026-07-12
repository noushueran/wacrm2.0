/**
 * Meta WhatsApp webhook payload parsing — pure helpers for the
 * `convex/http.ts` httpActions (Phase 8, Task 4b). httpActions
 * themselves can't be exercised with `convex-test` (no way to invoke an
 * HTTP handler through the test harness), so every piece of actual
 * decision logic — field routing, message flattening, status
 * validation — is factored out here as plain, synchronous functions the
 * httpAction calls but that this module's own `.test.ts` can exercise
 * directly.
 *
 * `flattenInboundMessage` is a Convex port of
 * `src/app/api/whatsapp/webhook/route.ts`'s `parseMessageContent`, with
 * one deliberate scope cut: the source resolves media (`image`/`video`/
 * `document`/`audio`/`sticker`) to a fetchable URL via a Meta Graph API
 * call (`verifyAndBuildUrl`) before returning — real network I/O. This
 * port does NOT make that call (see `convex/ingest.ts`'s own comment on
 * `mediaId` vs `mediaUrl`: resolving a `mediaId` needs a signed Meta
 * call, which needs the account's decrypted access token — an action's
 * job, not a payload-shaping pure function) — it only extracts the raw
 * `mediaId` and passes it through unresolved. Media-URL resolution is
 * flagged as a follow-up in this task's own report, not silently
 * dropped.
 *
 * `null` (`| undefined` fields) throughout, never `null` literals —
 * unlike the source, which returns explicit `null` for "no value" (a
 * Postgres/JS convention). Convex's `v.optional(v.string())` validators
 * accept a MISSING field, not an explicit `null`, so every "no value"
 * here is `undefined`.
 */

// ============================================================
// Raw Meta webhook shapes — mirrors
// `src/app/api/whatsapp/webhook/route.ts`'s own `WhatsAppMessage`/
// `WhatsAppWebhookEntry` interfaces (renamed with a `MetaWebhook` prefix
// to distinguish "the JSON Meta sent us" from this codebase's own
// camelCase domain types).
// ============================================================

export interface MetaWebhookMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body?: string };
  image?: { id: string; mime_type?: string; caption?: string };
  video?: { id: string; mime_type?: string; caption?: string };
  document?: {
    id: string;
    mime_type?: string;
    filename?: string;
    caption?: string;
  };
  audio?: { id: string; mime_type?: string };
  sticker?: { id: string; mime_type?: string };
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  reaction?: { message_id: string; emoji?: string };
  // Present when Meta sends a `type: "system"` event — a customer changed
  // their phone number (`user_changed_number` / `customer_changed_number`)
  // or re-registered on a new device (`customer_identity_changed`). NOT a
  // message the customer typed; `body` is Meta's human-readable notice
  // (e.g. "‪+1 (555) 000‬ changed their phone number").
  system?: {
    body?: string;
    identity?: string;
    wa_id?: string;
    new_wa_id?: string;
    type?: string;
    customer?: string;
  };
  interactive?: {
    type?: "button_reply" | "list_reply";
    button_reply?: { id: string; title?: string };
    list_reply?: { id: string; title?: string; description?: string };
  };
  context?: { id: string };
  // Present when the message originated from a click-to-WhatsApp ad.
  // `source_id` mirrors Meta's payload for fidelity even though only
  // `ctwa_clid` is surfaced downstream (see `FlattenedInboundMessage`).
  referral?: { ctwa_clid?: string; source_id?: string };
}

export interface MetaWebhookStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}

export interface MetaWebhookContact {
  profile?: { name?: string };
  wa_id?: string;
}

export interface MetaWebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: MetaWebhookContact[];
  messages?: MetaWebhookMessage[];
  statuses?: MetaWebhookStatus[];
}

export interface MetaWebhookChange {
  value: MetaWebhookValue;
  field: string;
}

export interface MetaWebhookEntry {
  id: string;
  changes: MetaWebhookChange[];
}

export interface MetaWebhookBody {
  entry?: MetaWebhookEntry[];
}

// ============================================================
// Template-lifecycle field routing — ported from
// `src/lib/whatsapp/template-webhook.ts`.
// ============================================================

const TEMPLATE_WEBHOOK_FIELDS = new Set([
  "message_template_status_update",
  "message_template_quality_update",
  "message_template_components_update",
]);

export function isTemplateWebhookField(field: string): boolean {
  return TEMPLATE_WEBHOOK_FIELDS.has(field);
}

export interface ParsedTemplateStatusUpdate {
  metaTemplateId: string;
  event: string;
  reason?: string;
}

/**
 * Extracts the `{ metaTemplateId, event, reason }` shape
 * `internal.templates.applyMetaStatusWebhook` expects out of a
 * `message_template_status_update` change's raw `value` — mirrors the
 * source's own `handleStatusUpdate` guard ("missing message_template_id
 * or event" → warn + no-op) in `template-webhook.ts`. Returns `null`
 * or, `applyMetaStatusWebhook`'s required `event: v.string()` would
 * receive `undefined` and throw a validator error the caller would have
 * to catch anyway — validating here keeps that failure mode a plain
 * `null` check instead.
 *
 * Only the STATUS field is handled — `message_template_quality_update`/
 * `message_template_components_update` have no corresponding internal
 * mutation yet (T4-2a only built `applyMetaStatusWebhook`, scoped to
 * this one field per its own doc comment); routing those through this
 * function would misread `new_quality_score`-shaped payloads as if they
 * were `event`-shaped ones. Flagged as a follow-up in this task's report.
 */
export function parseTemplateStatusUpdate(
  value: unknown,
): ParsedTemplateStatusUpdate | null {
  if (!value || typeof value !== "object") return null;
  const v = value as {
    message_template_id?: string | number;
    event?: string;
    reason?: string;
  };
  if (v.message_template_id === undefined || !v.event) return null;
  return {
    metaTemplateId: String(v.message_template_id),
    event: v.event,
    reason: v.reason,
  };
}

// ============================================================
// Recipient status validation — Meta's `value.statuses[].status`
// crosses the wire as an unconstrained string; `updateDeliveryStatusByWamid`
// / `recordRecipientStatusByWamid`'s Convex validators throw on any
// literal outside this 4-value union. The source's Postgres CHECK
// constraint rejected bad values as a per-row `{ error }` the caller
// logged and moved past (never thrown); this is the Convex equivalent —
// checked BEFORE calling the mutation so an unrecognized status
// (Meta occasionally sends others, e.g. a rare `deleted`) is skipped
// with a log instead of throwing out of the httpAction and abandoning
// the rest of the batch.
// ============================================================

const RECIPIENT_STATUS_VALUES = new Set([
  "sent",
  "delivered",
  "read",
  "failed",
]);

export type MetaRecipientStatus = "sent" | "delivered" | "read" | "failed";

export function isRecipientStatus(
  status: string,
): status is MetaRecipientStatus {
  return RECIPIENT_STATUS_VALUES.has(status);
}

// ============================================================
// Contact-name resolution — route.ts:289-291's own
// `value.contacts[i] || value.contacts[0]` fallback.
// ============================================================

export function resolveContactName(
  contacts: MetaWebhookContact[] | undefined,
  index: number,
): string | undefined {
  const contact = contacts?.[index] ?? contacts?.[0];
  return contact?.profile?.name || undefined;
}

// ============================================================
// Inbound-message flattening — Convex port of `parseMessageContent`
// (route.ts:829-972), reshaped to `convex/ingest.ts`'s
// `inboundMessageValidator` shape: `{ type, text?, mediaId?, wamid,
// interactiveReplyId? }`. `type` is one of `ingestInbound`'s 7 accepted
// literals — narrower than Meta's own message-type vocabulary — so two
// source cases don't map onto it directly:
//
//   - `sticker` → mapped to `"image"`, exactly like the source's own
//     comment ("stickers are images"); `ingestInbound` has no distinct
//     `sticker` type at all.
//   - `reaction` → returns `null` (skip). The source never inserts a
//     `messages` row for a reaction either (it upserts/deletes a
//     dedicated `message_reactions` row via `handleReaction`, called
//     BEFORE `parseMessageContent` even runs) — but Convex has no
//     reaction-persistence internal yet (out of this task's scope,
//     flagged as a follow-up in the report) and `inboundMessageValidator`
//     has no `"reaction"` literal, so the caller must skip rather than
//     mis-store it as a text message.
//
// Every other unrecognized `message.type` still becomes a visible
// `"text"` placeholder (route.ts's own `default` case) rather than a
// silent drop.
// ============================================================

export interface FlattenedInboundMessage {
  type:
    | "text"
    | "image"
    | "document"
    | "audio"
    | "video"
    | "location"
    | "interactive";
  text?: string;
  mediaId?: string;
  wamid: string;
  interactiveReplyId?: string;
  ctwaClid?: string;
}

/**
 * Public entry point: flattens by type, then merges the click-to-WhatsApp
 * ad click id (if any) onto the result. Kept separate from `flattenByType`
 * so the referral merge lives in exactly one place instead of being
 * appended to every `case` below — a `reaction` (or other `null` result)
 * stays `null`; a referral does not resurrect a skipped message.
 */
export function flattenInboundMessage(
  message: MetaWebhookMessage,
): FlattenedInboundMessage | null {
  const base = flattenByType(message);
  if (!base) return null;
  const ctwaClid = message.referral?.ctwa_clid || undefined;
  return ctwaClid ? { ...base, ctwaClid } : base;
}

function flattenByType(
  message: MetaWebhookMessage,
): FlattenedInboundMessage | null {
  const wamid = message.id;

  switch (message.type) {
    case "text":
      return { type: "text", text: message.text?.body || undefined, wamid };

    case "image":
      if (!message.image?.id) return { type: "image", wamid };
      return {
        type: "image",
        text: message.image.caption || undefined,
        mediaId: message.image.id,
        wamid,
      };

    case "video":
      if (!message.video?.id) return { type: "video", wamid };
      return {
        type: "video",
        text: message.video.caption || undefined,
        mediaId: message.video.id,
        wamid,
      };

    case "document":
      if (!message.document?.id) return { type: "document", wamid };
      return {
        type: "document",
        text:
          message.document.caption || message.document.filename || undefined,
        mediaId: message.document.id,
        wamid,
      };

    case "audio":
      if (!message.audio?.id) return { type: "audio", wamid };
      return { type: "audio", mediaId: message.audio.id, wamid };

    case "sticker":
      // Stickers are images under the hood — route.ts's own comment on
      // this exact mapping. No caption field on Meta's sticker payload.
      if (!message.sticker?.id) return { type: "image", wamid };
      return { type: "image", mediaId: message.sticker.id, wamid };

    case "location": {
      const loc = message.location;
      if (!loc) return { type: "location", wamid };
      const text = [loc.name, loc.address, `${loc.latitude},${loc.longitude}`]
        .filter(Boolean)
        .join(" - ");
      return { type: "location", text, wamid };
    }

    case "interactive": {
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply;
      if (reply?.id) {
        return {
          type: "interactive",
          text: reply.title || reply.id,
          interactiveReplyId: reply.id,
          wamid,
        };
      }
      return { type: "interactive", text: "[Interactive reply]", wamid };
    }

    case "system": {
      // A WhatsApp system notice (customer changed number / identity), not
      // a message the customer typed. Surface Meta's human-readable `body`
      // so the thread shows e.g. "‪+971…‬ changed their phone number"
      // instead of a raw "[Unsupported message type: system]" placeholder.
      // `ingestInbound` has no distinct system content_type, so it rides in
      // as `"text"`; the `body || …` fallback guards against a blank bubble
      // if Meta ever omits the body.
      const body = message.system?.body?.trim();
      return { type: "text", text: body || "[System message]", wamid };
    }

    case "reaction":
      return null;

    default:
      return {
        type: "text",
        text: `[Unsupported message type: ${message.type}]`,
        wamid,
      };
  }
}
