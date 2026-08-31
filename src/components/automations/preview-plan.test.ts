import { describe, expect, test } from "vitest";
import {
  planPreviewBubbles,
  planTemplateBody,
  resolveTemplatePreview,
  splitInterpolationTokens,
  tokenResolves,
} from "./preview-plan";

// ============================================================
// planPreviewBubbles — which bubbles, in what order. The audio+text case
// is the one this whole component exists for: sendPlan.ts's own tests
// already cover transport SELECTION (planSend), so these tests only
// cover the extra step this file adds — turning a SendPlan into an
// ordered bubble list — and deliberately re-express the audio+text rule
// through a realistic SendMessageStepConfig (not a hand-built SendPlan)
// so a wiring mistake between the two shows up here too.
// ============================================================

test("empty config renders no bubbles", () => {
  expect(planPreviewBubbles({})).toEqual([]);
});

test("whitespace-only text renders no bubbles", () => {
  expect(planPreviewBubbles({ text: "   " })).toEqual([]);
});

test("text only renders a single text bubble", () => {
  expect(planPreviewBubbles({ text: "hi there" })).toEqual([
    { kind: "text", text: "hi there" },
  ]);
});

test("image with a caption renders one media bubble carrying the caption", () => {
  expect(
    planPreviewBubbles({ text: "look", media: { type: "image", key: "acc/a.jpg" } }),
  ).toEqual([
    {
      kind: "media",
      mediaType: "image",
      key: "acc/a.jpg",
      url: undefined,
      filename: undefined,
      caption: "look",
    },
  ]);
});

test("image without text renders one media bubble with no caption", () => {
  expect(planPreviewBubbles({ media: { type: "image", key: "acc/a.jpg" } })).toEqual([
    { kind: "media", mediaType: "image", key: "acc/a.jpg", url: undefined, filename: undefined, caption: undefined },
  ]);
});

test("document carries its filename through as a media bubble", () => {
  expect(
    planPreviewBubbles({ media: { type: "document", key: "acc/q.pdf", filename: "quote.pdf" } }),
  ).toEqual([
    {
      kind: "media",
      mediaType: "document",
      key: "acc/q.pdf",
      url: undefined,
      filename: "quote.pdf",
      caption: undefined,
    },
  ]);
});

test("audio WITHOUT text renders a single audio bubble — no split needed", () => {
  expect(planPreviewBubbles({ media: { type: "audio", key: "acc/a.ogg" } })).toEqual([
    { kind: "media", mediaType: "audio", key: "acc/a.ogg", url: undefined, filename: undefined, caption: undefined },
  ]);
});

test("audio WITH text renders TWO bubbles: audio first, text second", () => {
  // This is the rule the whole component exists to get right. WhatsApp
  // can't caption audio, so the engine sends the audio, then the text as
  // its own message (automationsEngine.ts's runStep) — collapsing this
  // to one bubble would misrepresent what the customer actually gets.
  expect(planPreviewBubbles({ text: "listen to this", media: { type: "audio", key: "acc/a.ogg" } })).toEqual([
    { kind: "media", mediaType: "audio", key: "acc/a.ogg", url: undefined, caption: undefined, filename: undefined },
    { kind: "text", text: "listen to this" },
  ]);
});

test("audio bubble in the split has no caption field carried over — audio never carries one", () => {
  const bubbles = planPreviewBubbles({ text: "hey", media: { type: "audio", url: "https://x/a.ogg" } });
  expect(bubbles[0]).toMatchObject({ kind: "media", mediaType: "audio" });
  expect((bubbles[0] as { caption?: string }).caption).toBeUndefined();
});

test("interactive alone renders a single interactive bubble carrying the payload", () => {
  const payload = { kind: "buttons" as const, body: "pick", buttons: [{ id: "a", title: "A" }] };
  expect(planPreviewBubbles({ interactive: payload })).toEqual([
    { kind: "interactive", payload },
  ]);
});

test("media outranks interactive, matching planSend's own precedence", () => {
  const payload = { kind: "buttons" as const, body: "pick", buttons: [{ id: "a", title: "A" }] };
  const bubbles = planPreviewBubbles({
    media: { type: "image", url: "https://x/a.jpg" },
    interactive: payload,
  });
  expect(bubbles).toHaveLength(1);
  expect(bubbles[0]).toMatchObject({ kind: "media", mediaType: "image" });
});

// ============================================================
// planTemplateBody — {{n}} substitution vs. muted placeholder
// ============================================================

test("empty body renders no segments", () => {
  expect(planTemplateBody("", { "1": "Amani" })).toEqual([]);
});

test("a body with no placeholders is a single text segment", () => {
  expect(planTemplateBody("Hello there!", undefined)).toEqual([
    { kind: "text", value: "Hello there!" },
  ]);
});

test("a filled variable substitutes as literal text, not a pill", () => {
  expect(planTemplateBody("Hi {{1}}, welcome!", { "1": "Noushad" })).toEqual([
    { kind: "text", value: "Hi " },
    { kind: "text", value: "Noushad" },
    { kind: "text", value: ", welcome!" },
  ]);
});

test("an unfilled variable falls back to a placeholder marker", () => {
  expect(planTemplateBody("Hi {{1}}!", {})).toEqual([
    { kind: "text", value: "Hi " },
    { kind: "placeholder", n: 1 },
    { kind: "text", value: "!" },
  ]);
});

test("a variable with no `variables` map at all also falls back to a placeholder", () => {
  expect(planTemplateBody("Hi {{1}}!", undefined)).toEqual([
    { kind: "text", value: "Hi " },
    { kind: "placeholder", n: 1 },
    { kind: "text", value: "!" },
  ]);
});

test("a whitespace-only variable value counts as unfilled", () => {
  expect(planTemplateBody("Hi {{1}}!", { "1": "   " })).toEqual([
    { kind: "text", value: "Hi " },
    { kind: "placeholder", n: 1 },
    { kind: "text", value: "!" },
  ]);
});

test("mixed filled and unfilled variables resolve independently", () => {
  expect(planTemplateBody("{{1}} owes {{2}}", { "1": "Amani" })).toEqual([
    { kind: "text", value: "Amani" },
    { kind: "text", value: " owes " },
    { kind: "placeholder", n: 2 },
  ]);
});

test("adjacent placeholders with no text between them produce no empty text segment", () => {
  expect(planTemplateBody("{{1}}{{2}}", {})).toEqual([
    { kind: "placeholder", n: 1 },
    { kind: "placeholder", n: 2 },
  ]);
});

// ============================================================
// tokenResolves — I-1 fix. `interpolate()` (convex/automationsEngine.ts:
// 1463-1470) only ever fills a token with real content for the EXACT
// shape "message.text". Its source has a second live branch for
// "vars.<prop>", but AutomationContext.vars is never populated by any
// real dispatch call site (ingest.ts's inbound-trigger context, lib/
// automations/triggers.ts's tag_added/conversation_assigned dispatch, and
// sweepTimeBased's time_based context all omit it — only a unit test in
// automationsEngine.test.ts sets it directly) — so `{{ vars.* }}` always
// evaluates to "" in production today, exactly like `{{ contact.name }}`
// or any other token shape interpolate() doesn't recognise at all.
// ============================================================

describe("tokenResolves", () => {
  test("message.text resolves — the one token interpolate() ever fills with real content in production", () => {
    expect(tokenResolves("message.text")).toBe(true);
  });

  test("vars.* never resolves in production — AutomationContext.vars is never populated by any real dispatch path", () => {
    expect(tokenResolves("vars.name")).toBe(false);
    expect(tokenResolves("vars.source")).toBe(false);
  });

  test("contact.* is not a shape interpolate() recognises at all", () => {
    expect(tokenResolves("contact.name")).toBe(false);
    expect(tokenResolves("contact.phone")).toBe(false);
  });

  test("a bare namespace with no property never resolves", () => {
    expect(tokenResolves("message")).toBe(false);
    expect(tokenResolves("vars")).toBe(false);
  });
});

// ============================================================
// splitInterpolationTokens — every `{{ ... }}` becomes its own token
// segment (no runtime context here to substitute a real value), but each
// now carries `resolves` so the component can tell "becomes real content
// at send time" (message.text) apart from "deleted, sent as nothing"
// (everything else) instead of rendering both as the same confident pill.
// ============================================================

test("empty text renders no segments", () => {
  expect(splitInterpolationTokens("")).toEqual([]);
});

test("plain text with no tokens is a single text segment", () => {
  expect(splitInterpolationTokens("Hello there")).toEqual([
    { kind: "text", value: "Hello there" },
  ]);
});

test("a lone vars.* token renders as a single non-resolving token segment", () => {
  expect(splitInterpolationTokens("{{ vars.name }}")).toEqual([
    { kind: "token", raw: "vars.name", resolves: false },
  ]);
});

test("text around a token stays literal while the token becomes its own segment", () => {
  expect(splitInterpolationTokens("Hi {{ vars.name }}, thanks!")).toEqual([
    { kind: "text", value: "Hi " },
    { kind: "token", raw: "vars.name", resolves: false },
    { kind: "text", value: ", thanks!" },
  ]);
});

test("message.text is the one token marked as resolving", () => {
  expect(splitInterpolationTokens("You said: {{ message.text }}")).toEqual([
    { kind: "text", value: "You said: " },
    { kind: "token", raw: "message.text", resolves: true },
  ]);
});

test("a token the engine doesn't recognise at all (e.g. contact.name) is marked non-resolving too", () => {
  expect(splitInterpolationTokens("Hi {{ contact.name }}, your booking is confirmed.")).toEqual([
    { kind: "text", value: "Hi " },
    { kind: "token", raw: "contact.name", resolves: false },
    { kind: "text", value: ", your booking is confirmed." },
  ]);
});

test("multiple tokens each become their own segment, classified independently", () => {
  expect(splitInterpolationTokens("{{vars.a}}-{{message.text}}")).toEqual([
    { kind: "token", raw: "vars.a", resolves: false },
    { kind: "text", value: "-" },
    { kind: "token", raw: "message.text", resolves: true },
  ]);
});

// ============================================================
// resolveTemplatePreview — I-4 fix. `TemplatePreview` used to collapse
// "template list still loading" and "template_name set but not found in
// the resolved list" into the same `body ?? ""` -> "Nothing to send yet."
// path as a genuinely empty step, even though validation passes a
// not-found template and the engine will attempt the send. This is the
// pure "which of the three states applies" decision, kept separate from
// rendering so it's testable without NextIntlClientProvider/
// renderToStaticMarkup (see this file's own header comment).
// ============================================================

describe("resolveTemplatePreview", () => {
  test("loading wins over everything else — the account's template list hasn't resolved yet", () => {
    expect(
      resolveTemplatePreview({
        loading: true,
        notFoundLabel: "should be ignored while loading",
        body: "Hi {{1}}",
        variables: { "1": "Amani" },
      }),
    ).toEqual({ kind: "loading" });
  });

  test("not-found applies once loading is done, using exactly the label the caller supplies", () => {
    expect(
      resolveTemplatePreview({
        loading: false,
        notFoundLabel: "booking_confirmation (en_US) — not in approved list",
        body: "",
        variables: undefined,
      }),
    ).toEqual({ kind: "not-found", label: "booking_confirmation (en_US) — not in approved list" });
  });

  test("not-found wins over a stale body — even a non-empty body must not render as if it were sendable", () => {
    expect(
      resolveTemplatePreview({
        loading: false,
        notFoundLabel: "gone (en_US) — not in approved list",
        body: "Hi {{1}}, you're confirmed!",
        variables: { "1": "Amani" },
      }),
    ).toEqual({ kind: "not-found", label: "gone (en_US) — not in approved list" });
  });

  test("resolved falls through to planTemplateBody when neither loading nor not-found applies", () => {
    expect(
      resolveTemplatePreview({
        loading: false,
        notFoundLabel: undefined,
        body: "Hi {{1}}!",
        variables: { "1": "Amani" },
      }),
    ).toEqual({
      kind: "resolved",
      segments: [
        { kind: "text", value: "Hi " },
        { kind: "text", value: "Amani" },
        { kind: "text", value: "!" },
      ],
    });
  });

  test("resolved with an empty body produces an empty segments array — the caller shows the true 'nothing chosen yet' state for this, not a not-found one", () => {
    expect(
      resolveTemplatePreview({ loading: false, notFoundLabel: undefined, body: "", variables: undefined }),
    ).toEqual({ kind: "resolved", segments: [] });
  });
});
