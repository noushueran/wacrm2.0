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
  button?: { payload?: string; text?: string };
  // Present when the customer shares contact card(s) (`type: "contacts"`)
  // — vCard data flattened to Meta's JSON shape. Only the fields the
  // readable summary needs are typed here.
  contacts?: {
    name?: { formatted_name?: string; first_name?: string };
    phones?: { phone?: string; wa_id?: string; type?: string }[];
  }[];
  context?: { id: string };
  // Present when the message originated from a click-to-WhatsApp ad. The
  // full creative is lifted into `FlattenedInboundMessage.referral` for the
  // inbox ad-preview card; `ctwa_clid` continues to surface separately for
  // attribution (`FlattenedInboundMessage.ctwaClid`).
  referral?: {
    ctwa_clid?: string;
    source_id?: string;
    // `source_type`/`media_type` are typed as the OPEN `string`, not the
    // closed `"ad" | "post"` / `"image" | "video"` unions the domain
    // `AdReferral` below uses, because this interface describes UNTRUSTED
    // JSON Meta sent us — a TS literal union here is a compile-time
    // fiction that the runtime payload is free to violate, and Meta has
    // shipped new ad surfaces/formats before without warning. Narrowing
    // happens once, in `normalizeSourceType`/`normalizeMediaType` below.
    source_type?: string;
    source_url?: string;
    headline?: string;
    body?: string;
    media_type?: string;
    image_url?: string;
    video_url?: string;
    thumbnail_url?: string;
  };
}

export interface MetaWebhookStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
  /** Present on billing-bearing statuses. Meta's conversation-window
   *  record for this message. */
  conversation?: {
    id?: string;
    /** Unix SECONDS, as a string. Meta's authoritative window expiry. */
    expiration_timestamp?: string;
    origin?: { type?: string };
  };
  /** Present on billing-bearing statuses. `type` exists only in the
   *  per-message ("PMP") era; the conversation-based ("CBP") era carries
   *  the signal in `category` / `conversation.origin.type` instead. */
  pricing?: {
    billable?: boolean;
    pricing_model?: string;
    category?: string;
    type?: string;
  };
  /** Meta's stated reason the send could not be delivered. Documented as
   *  present only on a `failed` status — but `parseStatusError` below
   *  deliberately does not gate on that (see its own comment for why).
   *  An array in Meta's payload; in practice always one entry. `message`
   *  and `error_data.details` are not always present even when `code`/
   *  `title` are. */
  errors?: {
    code?: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
  }[];
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

/** Click-to-WhatsApp ad creative, lifted from the inbound `referral`
 *  object. The camelCase counterpart of Meta's snake_case payload. */
export interface AdReferral {
  sourceType?: "ad" | "post";
  sourceId?: string;
  sourceUrl?: string;
  headline?: string;
  body?: string;
  mediaType?: "image" | "video";
  imageUrl?: string;
  videoUrl?: string;
  thumbnailUrl?: string;
}

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
  /** wamid of the message this one replies to (Meta `context.id`), so the
   *  inbox can render the customer's reply as a quote of our message. */
  contextWamid?: string;
  referral?: AdReferral;
}

/**
 * Narrow Meta's raw `referral.source_type` to the closed union the data
 * model stores, or DROP it (`undefined`) when it is anything else.
 *
 * Why dropping — rather than passing the raw string through — is the only
 * safe option: `sourceType` is validated as
 * `v.optional(v.union(v.literal("ad"), v.literal("post")))` in FOUR places
 * (`ingest.ts`'s `inboundMessageValidator`, `adReferrals.ts`'s record
 * validator, and `schema.ts`'s `messages.referral` + the
 * `conversations.adReferral` denorm). A value outside that union makes
 * `ingest.ingestInbound` throw an ArgumentValidationError — and because
 * `http.ts` dispatches `processInbound` through
 * `ctx.scheduler.runAfter(0, ...)` AFTER the httpAction has already
 * returned its 200, that throw is invisible to Meta: no retry, no error
 * surfaced to the operator, and the customer's message is lost outright.
 * A cosmetic ad-card field must never cost us the actual message.
 *
 * The field is `v.optional` everywhere, so omitting it is always valid.
 * Every behavioural consumer gates on `sourceType === "ad"` — the
 * campaign-ad resolution in `adReferrals.ts`, the ad-started counter in
 * `messages.ts`, and the `conversationsStartedAd` rollup in `reports.ts` —
 * so all three correctly decline to treat a source they cannot classify
 * as a genuine ad. The ad card still renders: it reads
 * `headline`/`body`/`imageUrl`, not `sourceType`.
 *
 * Case is folded because Meta's own casing has not been contractually
 * stable across surfaces; `"AD"` is unambiguously the documented `"ad"`.
 */
function normalizeSourceType(
  raw: string | undefined,
): "ad" | "post" | undefined {
  const value = raw?.trim().toLowerCase();
  return value === "ad" || value === "post" ? value : undefined;
}

/** Same contract as `normalizeSourceType`, for `referral.media_type` —
 *  which is likewise a closed `"image" | "video"` union at rest, and
 *  likewise fatal to the whole message when Meta sends a format outside
 *  it (a carousel/product ad, say). Dropping it costs only the media-kind
 *  hint on the ad card; keeping it costs the message. */
function normalizeMediaType(
  raw: string | undefined,
): "image" | "video" | undefined {
  const value = raw?.trim().toLowerCase();
  return value === "image" || value === "video" ? value : undefined;
}

/**
 * Public entry point: flattens by type, then merges the click-to-WhatsApp
 * ad click id (if any) AND the full ad referral creative (`AdReferral`,
 * when previewable content is present) onto the result. Kept separate from
 * `flattenByType` so the referral merge lives in exactly one place instead
 * of being appended to every `case` below — a `reaction` (or other `null`
 * result) stays `null`; a referral does not resurrect a skipped message.
 */
export function flattenInboundMessage(
  message: MetaWebhookMessage,
): FlattenedInboundMessage | null {
  const base = flattenByType(message);
  if (!base) return null;
  const r = message.referral;
  const ctwaClid = r?.ctwa_clid || undefined;
  // Only attach a `referral` when there's previewable creative/link — a
  // referral carrying just ctwa_clid/source_id has nothing to render.
  const hasCreative =
    !!r &&
    !!(
      r.headline ||
      r.body ||
      r.source_url ||
      r.source_type ||
      r.image_url ||
      r.video_url ||
      r.thumbnail_url
    );
  const referral: AdReferral | undefined = hasCreative
    ? {
        sourceType: normalizeSourceType(r!.source_type),
        sourceId: r!.source_id,
        sourceUrl: r!.source_url,
        headline: r!.headline,
        body: r!.body,
        mediaType: normalizeMediaType(r!.media_type),
        imageUrl: r!.image_url,
        videoUrl: r!.video_url,
        thumbnailUrl: r!.thumbnail_url,
      }
    : undefined;
  const contextWamid = message.context?.id || undefined;
  return {
    ...base,
    ...(ctwaClid ? { ctwaClid } : {}),
    ...(contextWamid ? { contextWamid } : {}),
    ...(referral ? { referral } : {}),
  };
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

    case "button": {
      // A quick-reply tap on a TEMPLATE arrives as `type: "button"` (not
      // `interactive`, which is for interactive-message replies). Mapping
      // it to plain text means the inbox renders the label normally and
      // `parseStaffReply` can read it as offer consent — previously these
      // became "[Unsupported message type: button]".
      const label = message.button?.text || message.button?.payload;
      return { type: "text", text: label || undefined, wamid };
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

    case "contacts": {
      // The customer shared contact card(s). Structured inbound card
      // storage is out of scope (rare, and `ingestInbound`'s validator
      // stays untouched) — but a readable "who + number" summary beats
      // the raw "[Unsupported message type: contacts]" placeholder, same
      // trade as `system` above.
      const lines = (message.contacts ?? [])
        .map((c) => {
          const name = c.name?.formatted_name?.trim() || c.name?.first_name?.trim();
          const phone = c.phones?.map((p) => p.phone?.trim()).find(Boolean);
          return [name, phone].filter(Boolean).join(" — ");
        })
        .filter(Boolean);
      return {
        type: "text",
        text: lines.length > 0 ? `📇 Shared contact: ${lines.join("\n📇 ")}` : "📇 Shared contact",
        wamid,
      };
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

// ============================================================
// Status pricing / conversation-window capture
//
// Meta reports the real window expiry and billing outcome on every
// outbound message's status webhook. Every field here is OPTIONAL and
// every enum-ish value stays a RAW string: Meta is mid-migration between
// conversation-based pricing ("CBP") and per-message pricing ("PMP"),
// and the two eras spell the free-entry-point signal differently. An
// unrecognized value must degrade to "unknown", never throw and never
// drop the webhook.
// ============================================================

export interface ParsedStatusPricing {
  conversationMetaId?: string;
  /** Milliseconds since epoch (Meta sends unix SECONDS as a string). */
  expiresAt?: number;
  originType?: string;
  pricingModel?: string;
  pricingCategory?: string;
  pricingType?: string;
  billable?: boolean;
  /** True when either era's spelling says this is a free entry point. */
  isFreeEntryPoint: boolean;
}

/** CBP-era spelling, on `conversation.origin.type`. */
const FEP_ORIGIN_TYPE = "referral_conversion";
/** PMP-era spelling, on `pricing.type`. */
const FEP_PRICING_TYPE = "free_entry_point";
/** CBP-era spelling, on `pricing.category`. Deliberately the same string
 *  as `FEP_ORIGIN_TYPE` above — Meta reuses "referral_conversion" as the
 *  CBP-era free-entry-point signal on two different fields
 *  (`conversation.origin.type` and `pricing.category`); the duplication
 *  is intentional, not a copy-paste artifact. */
const FEP_PRICING_CATEGORY = "referral_conversion";

/**
 * Lift Meta's billing/window facts off one status webhook entry.
 * Returns `null` when the status carries neither object — ordinary for
 * some `delivered`/`read` callbacks, and NOT an error.
 */
export function parseStatusPricing(
  status: MetaWebhookStatus,
): ParsedStatusPricing | null {
  const { conversation, pricing } = status;
  if (!conversation && !pricing) return null;

  const seconds = Number(conversation?.expiration_timestamp);
  const expiresAt =
    Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;

  const originType = conversation?.origin?.type;
  const pricingType = pricing?.type;
  const pricingCategory = pricing?.category;

  return {
    conversationMetaId: conversation?.id,
    expiresAt,
    originType,
    pricingModel: pricing?.pricing_model,
    pricingCategory,
    pricingType,
    billable: pricing?.billable,
    isFreeEntryPoint:
      originType === FEP_ORIGIN_TYPE ||
      pricingType === FEP_PRICING_TYPE ||
      pricingCategory === FEP_PRICING_CATEGORY,
  };
}

// ============================================================
// Status error capture — diagnostic for silent async delivery failures.
//
// Meta accepts a send synchronously (returns a wamid) and only reports
// `failed` later, asynchronously, on this same status webhook. When it
// does, `errors[0]` is the ONLY place Meta ever states why — and until
// now this codebase parsed the status webhook without reading that
// field at all, so a `failed` message's cause was unrecoverable the
// moment it happened (self-hosted Convex keeps no log history to
// reconstruct it from afterward). Every field is OPTIONAL and read as a
// RAW value, same trade as `parseStatusPricing` above: Meta's `errors`
// array is, in practice, always one entry, but that is not a documented
// guarantee, and `message` / `error_data.details` are frequently absent
// even when `code` / `title` are present.
// ============================================================

export interface ParsedStatusError {
  code?: number;
  title?: string;
  message?: string;
  details?: string;
}

/**
 * Lift Meta's stated reason a status webhook entry could not be
 * delivered. Returns `null` when there is no usable error: no `errors`
 * array, an empty one, or an entry with no readable field set.
 *
 * Deliberately does NOT gate on `status.status === "failed"`, even
 * though Meta's documentation states `errors` is failure-only.
 * `deliveryError` (see its own comment in `schema.ts`) has no readers
 * yet, so the asymmetry decides it: a stray capture on some other status
 * is inert and trivially filtered later by querying `status === "failed"`
 * first, but a wrongly-DROPPED error is unrecoverable — this deployment
 * keeps no log history, which is the entire reason this function exists.
 * A documented-but-unverified constraint is not worth risking a silently
 * lost reason over, and this exact webhook's documented shape has already
 * proven incomplete once in this codebase (`parseStatusPricing` above
 * exists because the CBP/PMP pricing fields don't behave as a single
 * documented shape either).
 */
export function parseStatusError(
  status: MetaWebhookStatus,
): ParsedStatusError | null {
  const first = status.errors?.[0];
  if (!first) return null;

  const details = first.error_data?.details;
  if (
    first.code === undefined &&
    !first.title &&
    !first.message &&
    !details
  ) {
    return null;
  }

  return {
    code: first.code,
    title: first.title,
    message: first.message,
    details,
  };
}
