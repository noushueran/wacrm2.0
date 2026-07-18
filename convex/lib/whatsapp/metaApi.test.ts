import { describe, expect, it } from "vitest";
import { buildMarkReadPayload } from "./metaApi";

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
