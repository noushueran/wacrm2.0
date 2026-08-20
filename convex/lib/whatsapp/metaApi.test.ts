import { describe, expect, it } from "vitest";
import { buildContactsPayload, buildMarkReadPayload, buildTextPayload, MetaApiError, META_ERROR_OUTSIDE_WINDOW } from "./metaApi";

// The senders in metaApi.ts are network functions exercised through
// `convex/metaSend.test.ts`'s DRY-RUN action tests; the mark-read
// payload is extracted as a pure builder so the exact wire shape Meta
// documents (status:"read" + optional typing_indicator) is pinned here
// without any fetch.
describe("buildMarkReadPayload", () => {
  it("builds the read receipt with a typing indicator", () => {
    expect(
      buildMarkReadPayload({ messageId: "wamid.ABC", typingIndicator: true }),
    ).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ABC",
      typing_indicator: { type: "text" },
    });
  });

  it("omits the typing indicator unless asked for", () => {
    expect(buildMarkReadPayload({ messageId: "wamid.ABC" })).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.ABC",
    });
  });
});

// Same pure-builder pinning as `buildMarkReadPayload` above. The
// `preview_url` assertion is the point of this block: it is the single
// flag that makes the recipient's WhatsApp unfurl a link into a rich
// preview (og:title/description/image), and it was absent from every
// text send this app made until the builder was extracted. A regression
// here is silent — the message still delivers, it just arrives as a bare
// link — so it gets pinned rather than left to manual QA.
describe("buildTextPayload", () => {
  it("asks Meta for a link preview on every text send", () => {
    expect(
      buildTextPayload({
        to: "971551112233",
        text: "Our Dubai packages: https://amaniworld.com/packages",
      }),
    ).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "971551112233",
      type: "text",
      text: {
        preview_url: true,
        body: "Our Dubai packages: https://amaniworld.com/packages",
      },
    });
  });

  it("keeps preview_url set on a quoted reply, alongside the context", () => {
    const payload = buildTextPayload({
      to: "971551112233",
      text: "https://amaniworld.com/visa",
      contextMessageId: "wamid.ABC",
    });
    expect(payload.context).toEqual({ message_id: "wamid.ABC" });
    expect(payload.text).toEqual({
      preview_url: true,
      body: "https://amaniworld.com/visa",
    });
  });

  it("omits the context field on a non-reply", () => {
    expect(
      buildTextPayload({ to: "971551112233", text: "Hello" }),
    ).not.toHaveProperty("context");
  });
});

// Same pure-builder pinning as `buildMarkReadPayload` above: the exact
// Cloud API `contacts[]` element shape the customer's tap-to-save card
// is built from, without any fetch.
describe("buildContactsPayload", () => {
  it("builds a full card: name parts, org, wa_id phone, company phone, email, url, address", () => {
    expect(
      buildContactsPayload({
        name: "Ayesha Khan",
        jobTitle: "Senior Travel Consultant",
        company: "Amani Tours LLC",
        phone: "+971 55 111 2233",
        companyPhone: "+971 4 000 0000",
        email: "hello@amaniworld.com",
        website: "https://amaniworld.com",
        address: { city: "Dubai", country: "UAE", countryCode: "AE" },
      }),
    ).toEqual({
      name: {
        formatted_name: "Ayesha Khan",
        first_name: "Ayesha",
        last_name: "Khan",
      },
      org: { company: "Amani Tours LLC", title: "Senior Travel Consultant" },
      phones: [
        { phone: "+971 55 111 2233", type: "CELL", wa_id: "971551112233" },
        { phone: "+971 4 000 0000", type: "WORK" },
      ],
      emails: [{ email: "hello@amaniworld.com", type: "WORK" }],
      urls: [{ url: "https://amaniworld.com", type: "WORK" }],
      addresses: [{ city: "Dubai", country: "UAE", country_code: "AE", type: "WORK" }],
    });
  });

  it("prunes blank/whitespace fields — a minimal card carries only name and the direct phone", () => {
    const built = buildContactsPayload({
      name: "Omar",
      phone: "+971551112233",
      jobTitle: "  ",
      company: "",
      email: " ",
      website: "",
      address: { street: " ", city: "" },
    });
    expect(built).toEqual({
      name: { formatted_name: "Omar", first_name: "Omar" },
      phones: [{ phone: "+971551112233", type: "CELL", wa_id: "971551112233" }],
    });
    // Single-word name: no last_name key at all (not an empty string).
    expect((built.name as Record<string, unknown>).last_name).toBeUndefined();
  });

  it("skips a company phone that duplicates the direct number (formatting differences included)", () => {
    const built = buildContactsPayload({
      name: "Omar",
      phone: "+971 55 111 2233",
      companyPhone: "971551112233",
    });
    expect(built.phones).toEqual([
      { phone: "+971 55 111 2233", type: "CELL", wa_id: "971551112233" },
    ]);
  });
});

describe("MetaApiError", () => {
  it("carries Meta's numeric code alongside the message", () => {
    const err = new MetaApiError("Message failed to send", 131047);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(131047);
    expect(err.message).toBe("Message failed to send");
  });

  it("tolerates a missing code", () => {
    expect(new MetaApiError("boom", undefined).code).toBeUndefined();
  });

  it("exports the outside-window constant Meta uses", () => {
    expect(META_ERROR_OUTSIDE_WINDOW).toBe(131047);
  });
});
