import { describe, expect, it } from "vitest";
import {
  toUiAutomation,
  toUiContact,
  toUiConversation,
  toUiMember,
  toUiMessage,
  toUiTag,
  toUiTemplate,
} from "./adapters";
import type { Doc, Id } from "../../../convex/_generated/dataModel";

// ============================================================
// Task 5 of the R2 migration (dual-read): these three adapters are the
// client-side seam that maps a raw Convex doc's `*Key`/`*Url` pair into
// the resolved URL the UI actually renders (`<img src>`, download link,
// etc.) via `resolveMediaUrl` from `src/lib/storage/media-url.ts`. No
// test file existed for `adapters.ts` before this — kept intentionally
// minimal: just the three mappings this task touches, not a full sweep
// of every adapter in the file.
//
// `resolveMediaUrl`'s own resolution logic (key wins, empty-string url
// treated as absent, etc.) is already exhaustively covered by
// `src/lib/storage/media-url.test.ts` — these tests only prove each
// adapter is correctly WIRED to it, not re-derive that logic.
// ============================================================

const PUBLIC_HOST = "https://objs.amaniworld.com";

describe("toUiMember — avatar_url", () => {
  it("prefers avatarKey over a legacy avatarUrl, resolved to a public R2 URL", () => {
    process.env.NEXT_PUBLIC_R2_PUBLIC_HOST = PUBLIC_HOST;
    const doc = {
      _id: "m1" as Id<"memberships">,
      _creationTime: Date.parse("2026-01-01T00:00:00Z"),
      userId: "u1" as Id<"users">,
      accountId: "acc1" as Id<"accounts">,
      role: "agent" as const,
      fullName: "Alice",
      email: "alice@example.com",
      avatarUrl: "https://convex-api.amaniworld.com/api/storage/old",
      avatarKey: "acc1/avatars/alice.png",
    };
    expect(toUiMember(doc).avatar_url).toBe(
      `${PUBLIC_HOST}/acc1/avatars/alice.png`,
    );
    delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  });

  it("falls back to the legacy avatarUrl when there is no avatarKey", () => {
    const doc = {
      _id: "m1" as Id<"memberships">,
      _creationTime: Date.parse("2026-01-01T00:00:00Z"),
      userId: "u1" as Id<"users">,
      accountId: "acc1" as Id<"accounts">,
      role: "agent" as const,
      fullName: "Alice",
      email: "alice@example.com",
      avatarUrl: "https://convex-api.amaniworld.com/api/storage/old",
    };
    expect(toUiMember(doc).avatar_url).toBe(
      "https://convex-api.amaniworld.com/api/storage/old",
    );
  });

  it("returns null (not undefined) when neither is present", () => {
    const doc = {
      _id: "m1" as Id<"memberships">,
      _creationTime: Date.parse("2026-01-01T00:00:00Z"),
      userId: "u1" as Id<"users">,
      accountId: "acc1" as Id<"accounts">,
      role: "agent" as const,
    };
    expect(toUiMember(doc).avatar_url).toBeNull();
  });
});

describe("toUiMessage — media_url and referral.stored_image_url", () => {
  function baseMessageDoc(
    overrides: Partial<Doc<"messages">> = {},
  ): Doc<"messages"> {
    return {
      _id: "msg1" as Id<"messages">,
      _creationTime: Date.parse("2026-01-01T00:00:00Z"),
      accountId: "acc1" as Id<"accounts">,
      conversationId: "conv1" as Id<"conversations">,
      senderType: "customer",
      contentType: "image",
      status: "delivered",
      ...overrides,
    };
  }

  it("prefers mediaKey over a legacy mediaUrl, resolved to a public R2 URL", () => {
    process.env.NEXT_PUBLIC_R2_PUBLIC_HOST = PUBLIC_HOST;
    const doc = baseMessageDoc({
      mediaUrl: "https://convex-api.amaniworld.com/api/storage/old",
      mediaKey: "acc1/inbound/photo.jpg",
    });
    expect(toUiMessage(doc).media_url).toBe(`${PUBLIC_HOST}/acc1/inbound/photo.jpg`);
    delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  });

  it("falls back to the legacy mediaUrl when there is no mediaKey", () => {
    const doc = baseMessageDoc({
      mediaUrl: "https://convex-api.amaniworld.com/api/storage/old",
    });
    expect(toUiMessage(doc).media_url).toBe(
      "https://convex-api.amaniworld.com/api/storage/old",
    );
  });

  it("prefers referral.storedImageKey over referral.storedImageUrl", () => {
    process.env.NEXT_PUBLIC_R2_PUBLIC_HOST = PUBLIC_HOST;
    const doc = baseMessageDoc({
      contentType: "text",
      referral: {
        storedImageUrl: "https://convex-api.amaniworld.com/api/storage/ad-old",
        storedImageKey: "acc1/ads/creative.jpg",
      },
    });
    expect(toUiMessage(doc).referral?.stored_image_url).toBe(
      `${PUBLIC_HOST}/acc1/ads/creative.jpg`,
    );
    delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  });
});

describe("toUiTemplate — header_media_url", () => {
  function baseTemplateDoc(
    overrides: Partial<Doc<"messageTemplates">> = {},
  ): Doc<"messageTemplates"> {
    return {
      _id: "tpl1" as Id<"messageTemplates">,
      _creationTime: Date.parse("2026-01-01T00:00:00Z"),
      accountId: "acc1" as Id<"accounts">,
      name: "order_confirmation",
      category: "Utility",
      bodyText: "Your order is on its way.",
      ...overrides,
    };
  }

  it("prefers headerMediaKey over a legacy headerMediaUrl, resolved to a public R2 URL", () => {
    process.env.NEXT_PUBLIC_R2_PUBLIC_HOST = PUBLIC_HOST;
    const doc = baseTemplateDoc({
      headerMediaUrl: "https://convex-api.amaniworld.com/api/storage/old",
      headerMediaKey: "acc1/templates/sample.jpg",
    });
    expect(toUiTemplate(doc).header_media_url).toBe(
      `${PUBLIC_HOST}/acc1/templates/sample.jpg`,
    );
    delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  });

  it("falls back to the legacy headerMediaUrl when there is no headerMediaKey", () => {
    const doc = baseTemplateDoc({
      headerMediaUrl: "https://convex-api.amaniworld.com/api/storage/old",
    });
    expect(toUiTemplate(doc).header_media_url).toBe(
      "https://convex-api.amaniworld.com/api/storage/old",
    );
  });

  it("passes headerMediaKey through as-is, so template-send-builder's own resolution can reach it (final-review fix)", () => {
    // `template-send-builder.ts`'s `buildHeaderComponent` resolves
    // `template.header_media_key` directly as a defensive second layer
    // at send time — before this fix, `toUiTemplate` never set that
    // field on the object it returns, so it was always `undefined` on
    // every `MessageTemplate` built through this adapter and that
    // resolution could never fire.
    const doc = baseTemplateDoc({
      headerMediaKey: "acc1/templates/sample.jpg",
    });
    expect(toUiTemplate(doc).header_media_key).toBe(
      "acc1/templates/sample.jpg",
    );
  });
});

/**
 * `messages.aiTranscription` is written for every inbound voice note
 * (Whisper) and image (vision), but had NO reader under `src/` — the
 * projection layer simply dropped it, so no component could ever show
 * it. These pin that it now survives the trip to the client.
 */
function messageDoc(over: Partial<Doc<"messages">> = {}): Doc<"messages"> {
  return {
    _id: "m1" as Doc<"messages">["_id"],
    _creationTime: 1_700_000_000_000,
    accountId: "a1" as Doc<"messages">["accountId"],
    conversationId: "c1" as Doc<"messages">["conversationId"],
    senderType: "customer",
    contentType: "audio",
    status: "delivered",
    ...over,
  } satisfies Doc<"messages">;
}

describe("toUiMessage carries the AI transcription", () => {
  it("maps aiTranscription to ai_transcription", () => {
    const ui = toUiMessage(messageDoc({ aiTranscription: "Hello, I want a Dubai package." }));
    expect(ui.ai_transcription).toBe("Hello, I want a Dubai package.");
  });

  it("leaves ai_transcription undefined when the document has none", () => {
    expect(toUiMessage(messageDoc()).ai_transcription).toBeUndefined();
  });
});

// ============================================================
// `toUiContact` — the travel-profile columns the qualification engine
// writes (`travelDates`/`travelers`/`budget`, added alongside the
// existing extended CRM detail).
//
// This adapter is typed `(doc) => Contact` with every one of these props
// optional, so tsc catches NEITHER an omitted mapping nor a swapped
// assignment — a value would land in the DB and silently never reach the
// contact panel. The engine-side write is well covered; this is the one
// seam between it and what a rep actually sees.
// ============================================================

describe("toUiContact — travel profile", () => {
  const contactDoc = (over: Partial<Doc<"contacts">> = {}) =>
    ({
      _id: "c1" as Id<"contacts">,
      _creationTime: 1_700_000_000_000,
      accountId: "a1" as Id<"accounts">,
      phone: "+971500000001",
      phoneNormalized: "971500000001",
      ...over,
    }) as Doc<"contacts">;

  it("maps each travel-profile column to its snake_case counterpart", () => {
    const ui = toUiContact(
      contactDoc({
        travelDates: "mid December",
        travelers: "2 adults + 1 child aged 9",
        budget: "around AED 3,000 per person",
        preferredDestination: "Dubai",
      }),
    );
    // asserted per field rather than as one object: a swapped assignment
    // (travel_dates <- doc.travelers) is exactly what this guards, and
    // distinct values are what make the swap visible.
    expect(ui.travel_dates).toBe("mid December");
    expect(ui.travelers).toBe("2 adults + 1 child aged 9");
    expect(ui.budget).toBe("around AED 3,000 per person");
    expect(ui.preferred_destination).toBe("Dubai");
  });

  it("leaves them undefined when the document has none", () => {
    const ui = toUiContact(contactDoc());
    expect(ui.travel_dates).toBeUndefined();
    expect(ui.travelers).toBeUndefined();
    expect(ui.budget).toBeUndefined();
  });

  // A contact photo is only ever manually uploaded (WhatsApp supplies
  // none), and an upload stores an R2 KEY — so reading the legacy
  // `avatarUrl` alone, as this adapter did before, showed initials for
  // every contact that actually had a photo.
  describe("avatar_url", () => {
    it("prefers avatarKey over a legacy avatarUrl, resolved to a public R2 URL", () => {
      process.env.NEXT_PUBLIC_R2_PUBLIC_HOST = PUBLIC_HOST;
      const ui = toUiContact(
        contactDoc({
          avatarKey: "a1/avatar/deadbeef.jpg",
          avatarUrl: "https://legacy.example.com/old.png",
        }),
      );
      expect(ui.avatar_url).toBe(`${PUBLIC_HOST}/a1/avatar/deadbeef.jpg`);
      delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
    });

    it("falls back to the legacy avatarUrl when there is no avatarKey", () => {
      const ui = toUiContact(
        contactDoc({ avatarUrl: "https://legacy.example.com/old.png" }),
      );
      expect(ui.avatar_url).toBe("https://legacy.example.com/old.png");
    });

    it("is undefined (not null) when neither is present", () => {
      // `Contact.avatar_url` is an optional `string`, unlike
      // `AccountMember.avatar_url` which is `string | null` — so this
      // adapter coerces where `toUiMember` passes the null through.
      expect(toUiContact(contactDoc()).avatar_url).toBeUndefined();
    });

    it("treats a cleared photo (empty key AND url) as no photo", () => {
      // What `contacts.update` writes on removal. An empty key must not
      // win `resolveMediaUrl`'s key-over-url precedence.
      process.env.NEXT_PUBLIC_R2_PUBLIC_HOST = PUBLIC_HOST;
      const ui = toUiContact(contactDoc({ avatarKey: "", avatarUrl: "" }));
      expect(ui.avatar_url).toBeUndefined();
      delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
    });
  });
});

// ============================================================
// `toUiConversation` is an explicit ALLOW-LIST: a field absent from it is
// silently dropped on the way to the UI, however correctly the backend
// captured it. These tests pin the messaging-window fields for that
// reason — a regression here is invisible at the type level and would
// surface only as an inbox that never shows a free window.
// ============================================================

describe("toUiConversation — messaging windows", () => {
  const base = {
    _id: "c1" as Id<"conversations">,
    _creationTime: Date.parse("2026-07-20T10:00:00.000Z"),
    accountId: "a1" as Id<"accounts">,
    contactId: "ct1" as Id<"contacts">,
    status: "open" as const,
    unreadCount: 0,
  };

  it("maps lastInboundAt, firstReplyAt and metaWindow to ISO-stamped UI fields", () => {
    const lastInbound = Date.parse("2026-07-24T09:00:00.000Z");
    const firstReply = Date.parse("2026-07-24T09:05:00.000Z");
    const expires = Date.parse("2026-07-27T09:05:00.000Z");

    const ui = toUiConversation({
      ...base,
      lastInboundAt: lastInbound,
      firstReplyAt: firstReply,
      metaWindow: {
        conversationMetaId: "CONV1",
        originType: "referral_conversion",
        expiresAt: expires,
        isFreeEntryPoint: true,
        updatedAt: firstReply,
      },
      contact: null,
    } as unknown as Parameters<typeof toUiConversation>[0]);

    expect(ui.last_inbound_at).toBe("2026-07-24T09:00:00.000Z");
    expect(ui.first_reply_at).toBe("2026-07-24T09:05:00.000Z");
    expect(ui.meta_window).toEqual({
      conversation_meta_id: "CONV1",
      origin_type: "referral_conversion",
      expires_at: "2026-07-27T09:05:00.000Z",
      is_free_entry_point: true,
    });
  });

  it("leaves the window fields undefined when the backend has none yet", () => {
    const ui = toUiConversation({
      ...base,
      contact: null,
    } as unknown as Parameters<typeof toUiConversation>[0]);

    expect(ui.last_inbound_at).toBeUndefined();
    expect(ui.first_reply_at).toBeUndefined();
    expect(ui.meta_window).toBeUndefined();
  });

  it("keeps a metaWindow that carries no expiry, so the flag still reaches the UI", () => {
    const ui = toUiConversation({
      ...base,
      metaWindow: { isFreeEntryPoint: true, updatedAt: base._creationTime },
      contact: null,
    } as unknown as Parameters<typeof toUiConversation>[0]);

    expect(ui.meta_window?.is_free_entry_point).toBe(true);
    expect(ui.meta_window?.expires_at).toBeUndefined();
  });
});

// ============================================================
// `toUiTag` provenance — `contactTags.source` used to be dropped on the
// floor by both backend tag-embedding helpers, so a tag derived from a
// click-to-WhatsApp ad was indistinguishable from a manually-applied one
// once it reached the UI. This pins the adapter half of the fix: it
// carries an explicit source through, and leaves it undefined for the
// `api.tags.list` call sites that have no `contactTags` link to read one
// from.
// ============================================================

describe("toUiTag provenance", () => {
  const tagDoc = {
    _id: "tag1" as Id<"tags">,
    _creationTime: 0,
    accountId: "acc1" as Id<"accounts">,
    name: "UAE Visa",
    color: "#0ea5e9",
  } as Doc<"tags">;

  it("carries an explicit source through to the UI type", () => {
    // `source` rides on the doc itself (not a second parameter) — a
    // real `contactTags`-embedded tag from `embedTags` looks exactly
    // like this: a plain tag doc with `source` spread onto it.
    expect(toUiTag({ ...tagDoc, source: "ad" }).source).toBe("ad");
  });

  it("leaves source undefined when the caller has no link row", () => {
    // The `api.tags.list` call sites pass a bare tag doc — there is no
    // contactTags link to read a provenance from.
    expect(toUiTag(tagDoc).source).toBeUndefined();
  });
});

// ============================================================
// `toUiContact` — the seam that was ACTUALLY broken before this task:
// `embedTags` (`convex/contacts.ts`/`convex/conversations.ts`) already
// rode `contactTags.source` along with each embedded tag doc, but
// `toUiContact`'s own `tags: doc.tags.map(toUiTag)` mapping silently
// dropped it — `toUiTag` never even had a way to receive it. The
// `toUiTag`-provenance tests above prove the leaf function is correct in
// isolation; they do NOT prove this mapping wires it through (an earlier
// draft of this task made exactly that mistake: it reverted this mapping
// back to dropping `source` and both `toUiTag` tests kept passing,
// green-suite-with-a-dead-feature). These pin the mapping itself.
//
// `toUiConversation`'s embedded contact goes through this same function
// (`contact: doc.contact ? toUiContact(doc.contact) : undefined` — see
// that adapter below) rather than mapping tags itself, so covering this
// mapping here also covers the inbox conversation list; there's no
// separate `toUiTag` call on the conversation side to test in isolation.
// ============================================================

describe("toUiContact — tag provenance", () => {
  const contactDoc = {
    _id: "c1" as Id<"contacts">,
    _creationTime: 1_700_000_000_000,
    accountId: "a1" as Id<"accounts">,
    phone: "+971500000001",
    phoneNormalized: "971500000001",
  } as Doc<"contacts">;

  const tagDoc = {
    _id: "tag1" as Id<"tags">,
    _creationTime: 0,
    accountId: "a1" as Id<"accounts">,
    name: "UAE Visa",
    color: "#0ea5e9",
  } as Doc<"tags">;

  it("carries an ad-derived tag's source through the embedded-tags mapping", () => {
    const ui = toUiContact({
      ...contactDoc,
      tags: [{ ...tagDoc, source: "ad" }],
    });
    expect(ui.tags?.[0]?.source).toBe("ad");
  });

  it("leaves source undefined for an embedded tag with no link source", () => {
    const ui = toUiContact({
      ...contactDoc,
      tags: [tagDoc],
    });
    expect(ui.tags?.[0]?.source).toBeUndefined();
  });
});

// ============================================================
// Task 8 (automations run-tracking UI): `toUiAutomation` grew two new
// pass-throughs — `runCounts` (only `automations.list` computes it, via
// `summarizeRuns`; `automations.get`'s bare doc has none) and
// `stop_on_reply` (optional on the Convex doc, defaults false for rows
// saved before that field existed). Both are simple enough that a
// regression here would be silent — a dropped `runCounts` would just
// make `RunStatsBar` render zeroes, not throw — so they're pinned
// directly rather than left to the browser check alone.
// ============================================================

describe("toUiAutomation — runCounts and stop_on_reply", () => {
  const automationDoc = {
    _id: "auto1" as Id<"automations">,
    _creationTime: 1_700_000_000_000,
    accountId: "a1" as Id<"accounts">,
    name: "Welcome",
    triggerType: "new_message_received",
    triggerConfig: {},
    isActive: true,
    executionCount: 3,
  } as Doc<"automations">;

  it("carries automations.list's runCounts through untouched", () => {
    const runCounts = {
      enrolled: 5,
      waiting: 2,
      running: 0,
      completed: 3,
      failed: 0,
      cancelled: 0,
    };
    const ui = toUiAutomation({ ...automationDoc, runCounts });
    expect(ui.runCounts).toEqual(runCounts);
  });

  it("leaves runCounts undefined for a bare automations.get doc", () => {
    const ui = toUiAutomation(automationDoc);
    expect(ui.runCounts).toBeUndefined();
  });

  it("defaults stop_on_reply to false when the doc predates the field", () => {
    const ui = toUiAutomation(automationDoc);
    expect(ui.stop_on_reply).toBe(false);
  });

  it("carries an explicit stopOnReply through", () => {
    const ui = toUiAutomation({ ...automationDoc, stopOnReply: true });
    expect(ui.stop_on_reply).toBe(true);
  });
});
