import { expect, test } from "vitest";
import {
  flattenInboundMessage,
  isRecipientStatus,
  isTemplateWebhookField,
  parseStatusError,
  parseStatusPricing,
  parseTemplateStatusUpdate,
  resolveContactName,
  type MetaWebhookMessage,
  type MetaWebhookStatus,
} from "./webhookParse";

// ------------------------------------------------------------
// isTemplateWebhookField
// ------------------------------------------------------------

test("isTemplateWebhookField: recognizes all three Meta template-lifecycle fields", () => {
  expect(isTemplateWebhookField("message_template_status_update")).toBe(true);
  expect(isTemplateWebhookField("message_template_quality_update")).toBe(true);
  expect(isTemplateWebhookField("message_template_components_update")).toBe(
    true,
  );
});

test("isTemplateWebhookField: false for a plain messaging field", () => {
  expect(isTemplateWebhookField("messages")).toBe(false);
  expect(isTemplateWebhookField("")).toBe(false);
});

// ------------------------------------------------------------
// parseTemplateStatusUpdate
// ------------------------------------------------------------

test("parseTemplateStatusUpdate: extracts metaTemplateId/event/reason", () => {
  expect(
    parseTemplateStatusUpdate({
      message_template_id: 12345,
      event: "REJECTED",
      reason: "Sample content policy violation",
    }),
  ).toEqual({
    metaTemplateId: "12345",
    event: "REJECTED",
    reason: "Sample content policy violation",
  });
});

test("parseTemplateStatusUpdate: coerces a numeric message_template_id to a string", () => {
  const parsed = parseTemplateStatusUpdate({
    message_template_id: 999,
    event: "APPROVED",
  });
  expect(parsed?.metaTemplateId).toBe("999");
  expect(typeof parsed?.metaTemplateId).toBe("string");
});

test("parseTemplateStatusUpdate: null when message_template_id is missing", () => {
  expect(parseTemplateStatusUpdate({ event: "APPROVED" })).toBeNull();
});

test("parseTemplateStatusUpdate: null when event is missing", () => {
  expect(
    parseTemplateStatusUpdate({ message_template_id: "123" }),
  ).toBeNull();
});

test("parseTemplateStatusUpdate: null for non-object / nullish input", () => {
  expect(parseTemplateStatusUpdate(null)).toBeNull();
  expect(parseTemplateStatusUpdate(undefined)).toBeNull();
  expect(parseTemplateStatusUpdate("not an object")).toBeNull();
});

// ------------------------------------------------------------
// isRecipientStatus
// ------------------------------------------------------------

test("isRecipientStatus: true for Meta's four delivery-status values", () => {
  expect(isRecipientStatus("sent")).toBe(true);
  expect(isRecipientStatus("delivered")).toBe(true);
  expect(isRecipientStatus("read")).toBe(true);
  expect(isRecipientStatus("failed")).toBe(true);
});

test("isRecipientStatus: false for anything else (e.g. a rare 'deleted')", () => {
  expect(isRecipientStatus("deleted")).toBe(false);
  expect(isRecipientStatus("pending")).toBe(false);
  expect(isRecipientStatus("")).toBe(false);
});

// ------------------------------------------------------------
// resolveContactName
// ------------------------------------------------------------

test("resolveContactName: picks the contact at the same index as the message", () => {
  expect(
    resolveContactName(
      [{ profile: { name: "Alice" } }, { profile: { name: "Bob" } }],
      1,
    ),
  ).toBe("Bob");
});

test("resolveContactName: falls back to contacts[0] when the index is out of range", () => {
  expect(resolveContactName([{ profile: { name: "Alice" } }], 3)).toBe(
    "Alice",
  );
});

test("resolveContactName: undefined when contacts is missing or the name is empty", () => {
  expect(resolveContactName(undefined, 0)).toBeUndefined();
  expect(resolveContactName([{ profile: { name: "" } }], 0)).toBeUndefined();
  expect(resolveContactName([{}], 0)).toBeUndefined();
});

// ------------------------------------------------------------
// flattenInboundMessage
// ------------------------------------------------------------

function msg(overrides: Partial<MetaWebhookMessage>): MetaWebhookMessage {
  return {
    id: "wamid.DEFAULT",
    from: "15551234567",
    timestamp: "1700000000",
    type: "text",
    ...overrides,
  };
}

test("flattenInboundMessage: text", () => {
  expect(
    flattenInboundMessage(
      msg({ type: "text", text: { body: "Hi there" }, id: "wamid.1" }),
    ),
  ).toEqual({ type: "text", text: "Hi there", wamid: "wamid.1" });
});

test("flattenInboundMessage: text with no body falls back to undefined (not empty string)", () => {
  expect(
    flattenInboundMessage(msg({ type: "text", text: { body: "" } })),
  ).toEqual({ type: "text", text: undefined, wamid: "wamid.DEFAULT" });
});

test("flattenInboundMessage: reply — captures context.id as contextWamid", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "text",
        text: { body: "yes please" },
        id: "wamid.R",
        context: { id: "wamid.PARENT" },
      }),
    ),
  ).toEqual({
    type: "text",
    text: "yes please",
    wamid: "wamid.R",
    contextWamid: "wamid.PARENT",
  });
});

test("flattenInboundMessage: non-reply text has no contextWamid key", () => {
  const flat = flattenInboundMessage(msg({ type: "text", text: { body: "hello" } }));
  expect(flat).toEqual({ type: "text", text: "hello", wamid: "wamid.DEFAULT" });
  expect(flat).not.toHaveProperty("contextWamid");
});

test("flattenInboundMessage: image — caption as text, id as mediaId, NO mediaUrl (resolution deferred)", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "image",
        image: { id: "media-1", mime_type: "image/jpeg", caption: "Look!" },
      }),
    ),
  ).toEqual({
    type: "image",
    text: "Look!",
    mediaId: "media-1",
    wamid: "wamid.DEFAULT",
  });
});

test("flattenInboundMessage: video", () => {
  expect(
    flattenInboundMessage(
      msg({ type: "video", video: { id: "media-2", caption: "watch this" } }),
    ),
  ).toEqual({
    type: "video",
    text: "watch this",
    mediaId: "media-2",
    wamid: "wamid.DEFAULT",
  });
});

test("flattenInboundMessage: document — caption wins over filename when both are present", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "document",
        document: { id: "media-3", caption: "invoice", filename: "doc.pdf" },
      }),
    ),
  ).toMatchObject({ text: "invoice" });
});

test("flattenInboundMessage: document — falls back to filename when there's no caption", () => {
  expect(
    flattenInboundMessage(
      msg({ type: "document", document: { id: "media-3", filename: "doc.pdf" } }),
    ),
  ).toMatchObject({ text: "doc.pdf" });
});

test("flattenInboundMessage: audio — no text field at all", () => {
  expect(
    flattenInboundMessage(msg({ type: "audio", audio: { id: "media-4" } })),
  ).toEqual({ type: "audio", mediaId: "media-4", wamid: "wamid.DEFAULT" });
});

test("flattenInboundMessage: sticker maps to type 'image' (ingestInbound has no sticker literal)", () => {
  expect(
    flattenInboundMessage(msg({ type: "sticker", sticker: { id: "media-5" } })),
  ).toEqual({ type: "image", mediaId: "media-5", wamid: "wamid.DEFAULT" });
});

test("flattenInboundMessage: location formats lat/lng with name + address", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "location",
        location: {
          latitude: 1.23,
          longitude: 4.56,
          name: "HQ",
          address: "1 Main St",
        },
      }),
    ),
  ).toEqual({
    type: "location",
    text: "HQ - 1 Main St - 1.23,4.56",
    wamid: "wamid.DEFAULT",
  });
});

test("flattenInboundMessage: location with no name/address still includes the coordinates", () => {
  expect(
    flattenInboundMessage(
      msg({ type: "location", location: { latitude: 1, longitude: 2 } }),
    ),
  ).toMatchObject({ text: "1,2" });
});

test("flattenInboundMessage: interactive button reply — title as text, id as interactiveReplyId", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "btn_yes", title: "Yes please" },
        },
      }),
    ),
  ).toEqual({
    type: "interactive",
    text: "Yes please",
    interactiveReplyId: "btn_yes",
    wamid: "wamid.DEFAULT",
  });
});

test("flattenInboundMessage: interactive list reply", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: "row_1", title: "Option One" },
        },
      }),
    ),
  ).toEqual({
    type: "interactive",
    text: "Option One",
    interactiveReplyId: "row_1",
    wamid: "wamid.DEFAULT",
  });
});

test("flattenInboundMessage: interactive reply falls back to the id when title is missing", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "btn_yes" } },
      }),
    ),
  ).toMatchObject({ text: "btn_yes", interactiveReplyId: "btn_yes" });
});

test("flattenInboundMessage: reaction is skipped entirely (returns null)", () => {
  expect(
    flattenInboundMessage(
      msg({ type: "reaction", reaction: { message_id: "wamid.X", emoji: "👍" } }),
    ),
  ).toBeNull();
});

test("flattenInboundMessage: an unrecognized type still surfaces as a visible text placeholder", () => {
  expect(flattenInboundMessage(msg({ type: "order" }))).toEqual({
    type: "text",
    text: "[Unsupported message type: order]",
    wamid: "wamid.DEFAULT",
  });
});

test("flattenInboundMessage: system (customer changed number) surfaces the human-readable body, not an '[Unsupported message type]' placeholder", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "system",
        id: "wamid.SYS",
        system: {
          body: "This person changed their phone number to a new one.",
          wa_id: "971500000000",
          type: "user_changed_number",
        },
      }),
    ),
  ).toEqual({
    type: "text",
    text: "This person changed their phone number to a new one.",
    wamid: "wamid.SYS",
  });
});

test("flattenInboundMessage: system with no body falls back to a generic label (never a blank bubble)", () => {
  expect(
    flattenInboundMessage(
      msg({ type: "system", system: { type: "customer_identity_changed" } }),
    ),
  ).toEqual({
    type: "text",
    text: "[System message]",
    wamid: "wamid.DEFAULT",
  });
});

test("flattenInboundMessage: a malformed media message (missing the nested id) still returns a bare message rather than throwing", () => {
  expect(flattenInboundMessage(msg({ type: "image" }))).toEqual({
    type: "image",
    wamid: "wamid.DEFAULT",
  });
});

// ------------------------------------------------------------
// flattenInboundMessage: ctwa_clid (click-to-WhatsApp ad referral)
// ------------------------------------------------------------

test("flattenInboundMessage: text with a referral surfaces ctwaClid alongside the existing fields", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "text",
        text: { body: "Hi there" },
        id: "wamid.1",
        referral: { ctwa_clid: "abc", source_id: "AD1" },
      }),
    ),
  ).toEqual({
    type: "text",
    text: "Hi there",
    wamid: "wamid.1",
    ctwaClid: "abc",
  });
});

test("flattenInboundMessage: text with no referral has no ctwaClid", () => {
  const result = flattenInboundMessage(
    msg({ type: "text", text: { body: "Hi there" } }),
  );
  expect(result?.ctwaClid).toBeUndefined();
});

test("flattenInboundMessage: image with a referral surfaces ctwaClid alongside mediaId", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "image",
        image: { id: "media-1", caption: "Look!" },
        referral: { ctwa_clid: "xyz" },
      }),
    ),
  ).toEqual({
    type: "image",
    text: "Look!",
    mediaId: "media-1",
    wamid: "wamid.DEFAULT",
    ctwaClid: "xyz",
  });
});

test("flattenInboundMessage: reaction with a referral still returns null (a referral must not resurrect a skipped type)", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "reaction",
        reaction: { message_id: "wamid.X", emoji: "👍" },
        referral: { ctwa_clid: "abc" },
      }),
    ),
  ).toBeNull();
});

// ------------------------------------------------------------
// flattenInboundMessage: full ad referral (creative preview)
// ------------------------------------------------------------

test("flattenInboundMessage: lifts the full referral creative alongside ctwaClid", () => {
  const result = flattenInboundMessage(
    msg({
      type: "text",
      text: { body: "Hello, how can I get more info?" },
      id: "wamid.AD1",
      referral: {
        ctwa_clid: "clid-1",
        source_id: "120210000",
        source_type: "ad",
        source_url: "https://fb.me/ad123",
        headline: "Dubai 5N/6D Package",
        body: "Starting AED 1,499 per person",
        media_type: "image",
        image_url: "https://scontent.example/ad.jpg",
      } as MetaWebhookMessage["referral"],
    }),
  );
  expect(result?.ctwaClid).toBe("clid-1");
  expect(result?.referral).toEqual({
    sourceType: "ad",
    sourceId: "120210000",
    sourceUrl: "https://fb.me/ad123",
    headline: "Dubai 5N/6D Package",
    body: "Starting AED 1,499 per person",
    mediaType: "image",
    imageUrl: "https://scontent.example/ad.jpg",
    videoUrl: undefined,
    thumbnailUrl: undefined,
  });
});

// ------------------------------------------------------------
// flattenInboundMessage: referral enum narrowing
//
// `sourceType`/`mediaType` are stored as CLOSED unions
// (`v.union(v.literal("ad"), v.literal("post"))` /
// `v.literal("image"), v.literal("video")`) in `ingest.ts`'s
// `inboundMessageValidator`, `adReferrals.ts` and `schema.ts`. Meta is
// free to send a source/format outside those sets, and when it did the
// whole `ingestInbound` mutation threw an ArgumentValidationError —
// which, because `http.ts` schedules `processInbound` AFTER acking Meta
// 200, silently discarded the customer's message with no retry. These
// pin the narrowing that keeps an unrecognized enum cosmetic.
// ------------------------------------------------------------

test("flattenInboundMessage: an unrecognized referral source_type is dropped, NOT passed through (it would break ingest)", () => {
  const result = flattenInboundMessage(
    msg({
      type: "text",
      text: { body: "Saw your story" },
      id: "wamid.AD_STORY",
      referral: {
        ctwa_clid: "clid-story",
        source_id: "120299",
        source_type: "story_mention",
        headline: "Dubai City Tour",
      },
    }),
  );
  // The message and its creative survive; only the unknown enum is gone.
  expect(result?.ctwaClid).toBe("clid-story");
  expect(result?.referral?.sourceType).toBeUndefined();
  expect(result?.referral?.headline).toBe("Dubai City Tour");
  expect(result?.referral?.sourceId).toBe("120299");
});

test("flattenInboundMessage: an unrecognized referral media_type is dropped but the ad card survives", () => {
  const result = flattenInboundMessage(
    msg({
      type: "text",
      text: { body: "Tell me more" },
      id: "wamid.AD_CAROUSEL",
      referral: {
        ctwa_clid: "clid-carousel",
        source_type: "ad",
        media_type: "carousel",
        headline: "Desert Safari",
        image_url: "https://scontent.example/c.jpg",
      },
    }),
  );
  expect(result?.referral?.mediaType).toBeUndefined();
  // `sourceType: "ad"` must still survive — `adReferrals` gates campaign
  // resolution on exactly that value, as do `messages.ts`'s ad-started
  // counter and `reports.ts`'s `conversationsStartedAd` rollup.
  expect(result?.referral?.sourceType).toBe("ad");
  expect(result?.referral?.headline).toBe("Desert Safari");
});

test("flattenInboundMessage: referral enum casing is folded to the stored literal", () => {
  const result = flattenInboundMessage(
    msg({
      type: "text",
      text: { body: "hi" },
      id: "wamid.AD_CASE",
      referral: {
        source_type: "AD",
        media_type: "VIDEO",
        headline: "Cased",
      },
    }),
  );
  expect(result?.referral?.sourceType).toBe("ad");
  expect(result?.referral?.mediaType).toBe("video");
});

test("flattenInboundMessage: a referral with only ctwa_clid/source_id attaches NO referral object (nothing to preview)", () => {
  const result = flattenInboundMessage(
    msg({ type: "text", text: { body: "hi" }, referral: { ctwa_clid: "abc", source_id: "AD1" } }),
  );
  expect(result?.ctwaClid).toBe("abc");
  expect(result?.referral).toBeUndefined();
});

test("flattenInboundMessage: an image ad carries both mediaId and the referral creative", () => {
  const result = flattenInboundMessage(
    msg({
      type: "image",
      image: { id: "media-9", caption: "See offer" },
      referral: { ctwa_clid: "z", headline: "Offer", image_url: "https://scontent.example/x.jpg" } as MetaWebhookMessage["referral"],
    }),
  );
  expect(result?.mediaId).toBe("media-9");
  expect(result?.referral?.headline).toBe("Offer");
  expect(result?.referral?.imageUrl).toBe("https://scontent.example/x.jpg");
});

test("flattenInboundMessage: shared contact card surfaces name + number, not an '[Unsupported message type]' placeholder", () => {
  expect(
    flattenInboundMessage(
      msg({
        type: "contacts",
        contacts: [
          {
            name: { formatted_name: "John Traveller" },
            phones: [{ phone: "+44 7700 900123", wa_id: "447700900123" }],
          },
        ],
      }),
    ),
  ).toMatchObject({
    type: "text",
    text: "📇 Shared contact: John Traveller — +44 7700 900123",
  });
});

test("flattenInboundMessage: a payload-less contacts message still renders a generic card line", () => {
  expect(flattenInboundMessage(msg({ type: "contacts" }))).toMatchObject({
    type: "text",
    text: "📇 Shared contact",
  });
});

test("parses a template quick-reply button tap as text", () => {
  const result = flattenInboundMessage({
    id: "wamid.BTN",
    type: "button",
    button: { payload: "I'll take it", text: "I'll take it" },
  } as never);
  expect(result).toEqual({ type: "text", text: "I'll take it", wamid: "wamid.BTN" });
});

test("falls back to the button payload when no display text is present", () => {
  const result = flattenInboundMessage({
    id: "wamid.BTN2",
    type: "button",
    button: { payload: "Not now" },
  } as never);
  expect(result?.text).toBe("Not now");
});

test("does not emit the unsupported-type placeholder for buttons", () => {
  const result = flattenInboundMessage({
    id: "wamid.BTN3",
    type: "button",
    button: { text: "Show me" },
  } as never);
  expect(result?.text).not.toContain("Unsupported message type");
});

// ------------------------------------------------------------
// parseStatusPricing
// ------------------------------------------------------------

test("parseStatusPricing: CBP shape — referral_conversion origin marks a free entry point", () => {
  const status: MetaWebhookStatus = {
    id: "wamid.X",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: {
      id: "CONV1",
      expiration_timestamp: "1753560000",
      origin: { type: "referral_conversion" },
    },
    pricing: {
      billable: false,
      pricing_model: "CBP",
      category: "referral_conversion",
    },
  };
  expect(
    parseStatusPricing(status),
  ).toEqual({
    conversationMetaId: "CONV1",
    expiresAt: 1753560000000,
    originType: "referral_conversion",
    pricingModel: "CBP",
    pricingCategory: "referral_conversion",
    pricingType: undefined,
    billable: false,
    isFreeEntryPoint: true,
  });
});

test("parseStatusPricing: PMP shape — pricing.type free_entry_point marks a free entry point", () => {
  const parsed = parseStatusPricing({
    id: "wamid.Y",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: { id: "CONV2", expiration_timestamp: "1753560000" },
    pricing: {
      billable: false,
      pricing_model: "PMP",
      category: "service",
      type: "free_entry_point",
    },
  });
  expect(parsed?.isFreeEntryPoint).toBe(true);
  expect(parsed?.pricingModel).toBe("PMP");
  expect(parsed?.pricingType).toBe("free_entry_point");
});

test("parseStatusPricing: an ordinary billed message is not a free entry point", () => {
  const parsed = parseStatusPricing({
    id: "wamid.Z",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: {
      id: "CONV3",
      expiration_timestamp: "1753386400",
      origin: { type: "marketing" },
    },
    pricing: {
      billable: true,
      pricing_model: "PMP",
      category: "marketing",
      type: "regular",
    },
  });
  expect(parsed?.isFreeEntryPoint).toBe(false);
  expect(parsed?.billable).toBe(true);
});

test("parseStatusPricing: returns null when neither pricing nor conversation is present", () => {
  expect(
    parseStatusPricing({
      id: "wamid.NONE",
      status: "delivered",
      timestamp: "1753300000",
      recipient_id: "971500000000",
    }),
  ).toBeNull();
});

test("parseStatusPricing: tolerates a missing pricing object", () => {
  const parsed = parseStatusPricing({
    id: "wamid.A",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: { id: "CONV4", origin: { type: "user_initiated" } },
  });
  expect(parsed).not.toBeNull();
  expect(parsed?.expiresAt).toBeUndefined();
  expect(parsed?.billable).toBeUndefined();
  expect(parsed?.isFreeEntryPoint).toBe(false);
});

test("parseStatusPricing: tolerates a missing conversation object", () => {
  const parsed = parseStatusPricing({
    id: "wamid.A2",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    pricing: { billable: true, pricing_model: "PMP", category: "marketing", type: "regular" },
  });
  expect(parsed).not.toBeNull();
  expect(parsed?.conversationMetaId).toBeUndefined();
  expect(parsed?.expiresAt).toBeUndefined();
  expect(parsed?.billable).toBe(true);
  expect(parsed?.isFreeEntryPoint).toBe(false);
});

test("parseStatusPricing: unknown enum values normalize instead of throwing", () => {
  const parsed = parseStatusPricing({
    id: "wamid.B",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: { id: "CONV5", origin: { type: "some_future_origin" } },
    pricing: { pricing_model: "XYZ", category: "brand_new", type: "unheard_of" },
  });
  expect(parsed?.originType).toBe("some_future_origin");
  expect(parsed?.pricingType).toBe("unheard_of");
  expect(parsed?.isFreeEntryPoint).toBe(false);
});

test("parseStatusPricing: a non-numeric expiration_timestamp yields undefined, not NaN", () => {
  const parsed = parseStatusPricing({
    id: "wamid.C",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: { id: "CONV6", expiration_timestamp: "not-a-number" },
  });
  expect(parsed?.expiresAt).toBeUndefined();
});

test("parseStatusPricing: CBP pricing.category alone marks a free entry point", () => {
  const parsed = parseStatusPricing({
    id: "wamid.CAT",
    status: "sent",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    conversation: { id: "CONV9", expiration_timestamp: "1753560000" },
    pricing: { billable: false, pricing_model: "CBP", category: "referral_conversion" },
  });
  expect(parsed?.isFreeEntryPoint).toBe(true);
});

// ------------------------------------------------------------
// parseStatusError
// ------------------------------------------------------------

test("parseStatusError: a real 131049-shaped payload captures code/title/message/details", () => {
  const status: MetaWebhookStatus = {
    id: "wamid.FAIL1",
    status: "failed",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    errors: [
      {
        code: 131049,
        title:
          "This message was not delivered to maintain healthy ecosystem engagement.",
        message: "Message failed to send because of an error.",
        error_data: { details: "Meta rate limit engagement heuristic" },
      },
    ],
  };
  expect(parseStatusError(status)).toEqual({
    code: 131049,
    title:
      "This message was not delivered to maintain healthy ecosystem engagement.",
    message: "Message failed to send because of an error.",
    details: "Meta rate limit engagement heuristic",
  });
});

test("parseStatusError: returns null when there is no errors key", () => {
  expect(
    parseStatusError({
      id: "wamid.NONE",
      status: "failed",
      timestamp: "1753300000",
      recipient_id: "971500000000",
    }),
  ).toBeNull();
});

test("parseStatusError: returns null for an empty errors array", () => {
  expect(
    parseStatusError({
      id: "wamid.EMPTY",
      status: "failed",
      timestamp: "1753300000",
      recipient_id: "971500000000",
      errors: [],
    }),
  ).toBeNull();
});

test("parseStatusError: tolerates an entry missing title/message/error_data, keeping just the code", () => {
  const parsed = parseStatusError({
    id: "wamid.CODEONLY",
    status: "failed",
    timestamp: "1753300000",
    recipient_id: "971500000000",
    errors: [{ code: 131049 }],
  });
  expect(parsed).toEqual({
    code: 131049,
    title: undefined,
    message: undefined,
    details: undefined,
  });
});

test("parseStatusError: an entry with no usable fields at all returns null", () => {
  expect(
    parseStatusError({
      id: "wamid.BLANK",
      status: "failed",
      timestamp: "1753300000",
      recipient_id: "971500000000",
      errors: [{}],
    }),
  ).toBeNull();
});

test("parseStatusError: a non-failed status carrying a genuine error is still captured (deliberately no status gate)", () => {
  // Meta's docs say `errors` is failure-only, but this parser does not rely
  // on that: `deliveryError` has no readers yet, so a stray capture here is
  // inert, while wrongly dropping a real one is unrecoverable (no log
  // history). See parseStatusError's own comment for the full rationale.
  expect(
    parseStatusError({
      id: "wamid.SENT",
      status: "sent",
      timestamp: "1753300000",
      recipient_id: "971500000000",
      errors: [{ code: 131049, title: "reason given on a non-failed status" }],
    }),
  ).toEqual({
    code: 131049,
    title: "reason given on a non-failed status",
    message: undefined,
    details: undefined,
  });
});
