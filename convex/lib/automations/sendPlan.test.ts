import { expect, test } from "vitest";
import { planSend } from "./sendPlan";

test("text only sends text", () => {
  expect(planSend({ text: "hi" })).toEqual({ kind: "text", text: "hi" });
});

test("image with text sends one media message captioned", () => {
  expect(
    planSend({ text: "look", media: { type: "image", key: "acc/automation/a.jpg" } }),
  ).toEqual({
    kind: "media",
    mediaType: "image",
    caption: "look",
    key: "acc/automation/a.jpg",
    url: undefined,
    filename: undefined,
  });
});

test("image without text sends media with no caption", () => {
  expect(
    planSend({ media: { type: "image", key: "acc/automation/a.jpg" } }),
  ).toEqual({
    kind: "media",
    mediaType: "image",
    caption: undefined,
    key: "acc/automation/a.jpg",
    url: undefined,
    filename: undefined,
  });
});

test("audio WITH text splits into two messages — Meta 400s on a captioned audio", () => {
  expect(
    planSend({ text: "listen", media: { type: "audio", key: "acc/automation/a.ogg" } }),
  ).toEqual({
    kind: "media_then_text",
    text: "listen",
    key: "acc/automation/a.ogg",
    url: undefined,
  });
});

test("audio WITHOUT text stays a single media message", () => {
  expect(planSend({ media: { type: "audio", url: "https://x/a.ogg" } })).toEqual({
    kind: "media",
    mediaType: "audio",
    caption: undefined,
    key: undefined,
    url: "https://x/a.ogg",
    filename: undefined,
  });
});

test("document carries its filename", () => {
  expect(
    planSend({ media: { type: "document", key: "acc/automation/q.pdf", filename: "quote.pdf" } }),
  ).toEqual({
    kind: "media",
    mediaType: "document",
    caption: undefined,
    key: "acc/automation/q.pdf",
    url: undefined,
    filename: "quote.pdf",
  });
});

test("interactive alone sends interactive", () => {
  const payload = { kind: "buttons", body: "pick", buttons: [{ id: "a", title: "A" }] };
  expect(planSend({ interactive: payload as never })).toEqual({
    kind: "interactive",
    payload,
  });
});

test("media outranks interactive — the composer forbids both, the engine still needs a rule", () => {
  const payload = { kind: "buttons", body: "pick", buttons: [{ id: "a", title: "A" }] };
  expect(
    planSend({ media: { type: "image", url: "https://x/a.jpg" }, interactive: payload as never }),
  ).toMatchObject({ kind: "media" });
});

test("whitespace-only text is not text", () => {
  expect(planSend({ text: "   " })).toEqual({ kind: "empty" });
});

test("empty config yields empty", () => {
  expect(planSend({})).toEqual({ kind: "empty" });
});
