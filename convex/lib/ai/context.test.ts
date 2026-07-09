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
});
