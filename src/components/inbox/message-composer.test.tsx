import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { useTranslations } from "next-intl";

import { MediaDraftPreview, type MediaDraft } from "./message-composer";

/**
 * Static-render tests, matching this repo's other component tests
 * (`voice-transcript.test.tsx`) — there is no jsdom and no Testing
 * Library here.
 *
 * What's being guarded: the caption control must be a `<textarea>`.
 * A single-line `<input>` runs the HTML value-sanitization algorithm,
 * which strips U+000A/U+000D, so a pasted multi-line caption reached
 * `onChange` already flattened onto one line — and no Shift+Enter
 * could put a break back. The send path and the message bubble both
 * preserve newlines already, so the element type is the whole bug.
 *
 * The stripping itself is browser behaviour and can't be reproduced
 * without a DOM; asserting the element type is the reachable proxy,
 * and it is the property that actually decides the outcome.
 */

const t = ((key: string) => key) as unknown as ReturnType<
  typeof useTranslations
>;

function render(draft: Partial<MediaDraft> = {}) {
  const full: MediaDraft = {
    kind: "image",
    mediaKey: "acc1/outbound/photo.png",
    filename: "photo.png",
    caption: "",
    ...draft,
  };
  return renderToStaticMarkup(
    <MediaDraftPreview
      draft={full}
      busy={false}
      readOnly={false}
      onCaptionChange={() => {}}
      onDiscard={() => {}}
      onSend={() => {}}
      t={t}
    />,
  );
}

describe("MediaDraftPreview caption control", () => {
  it("renders the caption as a textarea, never a single-line input", () => {
    const html = render();

    expect(html).toContain("<textarea");
    // An <input> here would silently drop pasted line breaks.
    expect(html).not.toContain("<input");
  });

  it("keeps line breaks in a multi-line caption", () => {
    const caption = "Saudi Visa\n\n• 1-year validity\n• Multiple entry";
    const html = render({ caption });

    expect(html).toContain("\n• 1-year validity");
    expect(html.match(/\n/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("renders no caption control for audio, which Meta rejects captions on", () => {
    const html = render({ kind: "audio", filename: "voice.ogg" });

    expect(html).not.toContain("<textarea");
  });
});
