import { describe, expect, it } from "vitest";
import { toUiContact, toUiMember, toUiMessage, toUiTemplate } from "./adapters";
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

const PUBLIC_HOST = "https://objs.holidayys.co";

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
      avatarUrl: "https://convex-api.holidayys.co/api/storage/old",
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
      avatarUrl: "https://convex-api.holidayys.co/api/storage/old",
    };
    expect(toUiMember(doc).avatar_url).toBe(
      "https://convex-api.holidayys.co/api/storage/old",
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
      mediaUrl: "https://convex-api.holidayys.co/api/storage/old",
      mediaKey: "acc1/inbound/photo.jpg",
    });
    expect(toUiMessage(doc).media_url).toBe(`${PUBLIC_HOST}/acc1/inbound/photo.jpg`);
    delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  });

  it("falls back to the legacy mediaUrl when there is no mediaKey", () => {
    const doc = baseMessageDoc({
      mediaUrl: "https://convex-api.holidayys.co/api/storage/old",
    });
    expect(toUiMessage(doc).media_url).toBe(
      "https://convex-api.holidayys.co/api/storage/old",
    );
  });

  it("prefers referral.storedImageKey over referral.storedImageUrl", () => {
    process.env.NEXT_PUBLIC_R2_PUBLIC_HOST = PUBLIC_HOST;
    const doc = baseMessageDoc({
      contentType: "text",
      referral: {
        storedImageUrl: "https://convex-api.holidayys.co/api/storage/ad-old",
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
      headerMediaUrl: "https://convex-api.holidayys.co/api/storage/old",
      headerMediaKey: "acc1/templates/sample.jpg",
    });
    expect(toUiTemplate(doc).header_media_url).toBe(
      `${PUBLIC_HOST}/acc1/templates/sample.jpg`,
    );
    delete process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;
  });

  it("falls back to the legacy headerMediaUrl when there is no headerMediaKey", () => {
    const doc = baseTemplateDoc({
      headerMediaUrl: "https://convex-api.holidayys.co/api/storage/old",
    });
    expect(toUiTemplate(doc).header_media_url).toBe(
      "https://convex-api.holidayys.co/api/storage/old",
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
});
