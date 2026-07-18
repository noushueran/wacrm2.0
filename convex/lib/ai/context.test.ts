import { describe, it, expect } from "vitest";
import { toChatMessages } from "./context";

// Unlike the source's `context.test.ts` (which fakes a Supabase query
// chain and asserts the DESC → chronological reversal), this only
// exercises the pure mapping half — see `context.ts`'s own header for
// why the DB read + ordering moved to `convex/aiReply.ts`'s
// `recentMessages` internalQuery instead. Rows here are fed already in
// the final (oldest → newest) order that internalQuery produces.
describe("toChatMessages", () => {
  it("maps customer to user and agent/bot to assistant", () => {
    expect(
      toChatMessages([
        { senderType: "customer", contentText: "first" },
        { senderType: "agent", contentText: "second" },
        { senderType: "bot", contentText: "third" },
      ]),
    ).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "assistant", content: "third" },
    ]);
  });

  it("drops empty / whitespace-only messages", () => {
    expect(
      toChatMessages([
        { senderType: "customer", contentText: "   " },
        { senderType: "customer", contentText: undefined },
        { senderType: "customer", contentText: "real" },
      ]),
    ).toEqual([{ role: "user", content: "real" }]);
  });

  it("trims surrounding whitespace on kept messages", () => {
    expect(toChatMessages([{ senderType: "customer", contentText: "  hi there  " }])).toEqual([
      { role: "user", content: "hi there" },
    ]);
  });

  it("renders media rows as placeholders the model can react to", () => {
    expect(
      toChatMessages([
        { senderType: "customer", contentType: "audio" },
        { senderType: "customer", contentType: "image", contentText: "our hotel from last year" },
        { senderType: "customer", contentType: "video" },
        { senderType: "customer", contentType: "document", contentText: "itinerary.pdf" },
        { senderType: "customer", contentType: "location" },
      ]),
    ).toEqual([
      { role: "user", content: "[voice note]" },
      { role: "user", content: "[image] our hotel from last year" },
      { role: "user", content: "[video]" },
      { role: "user", content: "[document] itinerary.pdf" },
      { role: "user", content: "[location shared]" },
    ]);
  });

  it("keeps text rows byte-identical whether contentType is present or absent", () => {
    expect(
      toChatMessages([
        { senderType: "customer", contentType: "text", contentText: "hi" },
        { senderType: "customer", contentText: "there" },
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "there" },
    ]);
  });

  it("still drops rows with no text and no known media placeholder", () => {
    expect(
      toChatMessages([
        { senderType: "bot", contentType: "template" },
        { senderType: "customer", contentText: "real" },
      ]),
    ).toEqual([{ role: "user", content: "real" }]);
  });

  it("renders AI transcriptions after the placeholder so the model sees the actual content", () => {
    expect(
      toChatMessages([
        {
          senderType: "customer",
          contentType: "audio",
          transcription: "I want to visit Baku in August with my family",
        },
        {
          senderType: "customer",
          contentType: "image",
          contentText: "my current visa",
          transcription: "A photo of a UAE 30-day tourist visa page",
        },
      ]),
    ).toEqual([
      { role: "user", content: "[voice note] I want to visit Baku in August with my family" },
      {
        role: "user",
        content: "[image] my current visa — A photo of a UAE 30-day tourist visa page",
      },
    ]);
  });
});
