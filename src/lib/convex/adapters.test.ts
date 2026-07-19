import { describe, it, expect } from "vitest";
import { toUiMessage } from "./adapters";
import type { Doc } from "../../../convex/_generated/dataModel";

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
