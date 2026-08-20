import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { createTranslator } from "use-intl";

import enMessages from "../../../messages/en.json";

import {
  ButtonsEditor,
  InteractiveBuilder,
  ListEditor,
  blankButtonsPayload,
  blankListPayload,
} from "./interactive-builder";

/**
 * I-2 fix. Static-render tests, matching this repo's other component
 * tests (no jsdom/Testing Library — see message-preview.test.tsx's own
 * header comment for the precedent). `InteractiveBuilder` doesn't call
 * `useTranslations` anywhere (its labels are plain English strings), so
 * no `NextIntlClientProvider` wrapper is needed here.
 *
 * `blankButtonsPayload()` (body: "") is a reliably-invalid payload —
 * `validateInteractivePayload` rejects an empty body before it even looks
 * at the buttons — so every test below can use it to exercise the error
 * branch without hand-building a fixture that might drift from the real
 * validator's rules.
 */
const t = createTranslator({
  locale: "en",
  messages: enMessages.InteractiveBuilder,
}) as unknown as React.ComponentProps<typeof ButtonsEditor>["t"];

function render(props: Partial<Parameters<typeof InteractiveBuilder>[0]> = {}) {
  // See lead-analysis-board.test.tsx: NextIntlClientProviderProps declares
  // `children` as required, so real JSX threads it in for us, while
  // React.createElement builds the props object for the component under
  // test without writing a literal `children` key (which
  // react/no-children-prop disallows).
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {React.createElement(InteractiveBuilder, {
        value: blankButtonsPayload(),
        onChange: () => {},
        ...props,
      })}
    </NextIntlClientProvider>,
  );
}

describe("InteractiveBuilder — showPreview / showValidationError defaults", () => {
  it("by default renders BOTH the preview column and the inline validation error", () => {
    const html = render();
    expect(html).toContain("Preview");
    expect(html).toContain("Interactive message body text is required.");
    expect(html).toContain("text-red-400");
  });
});

// ============================================================
// I-2's actual bug: send-composer.tsx mounts InteractiveBuilder without
// showPreview={false}, so its own preview column renders ALONGSIDE the
// composer's delegated MessagePreview — two "Preview" labels, two bubble
// cards. And step-issues.tsx's amber StepIssues strip already shows the
// identical validateInteractivePayload error text (sourced from the same
// validator, via validateStepsForActivation's send_message case) in
// amber, while this component's own inline error renders the SAME
// sentence in red right next to it — one fact styled two contradictory
// ways. Fix: showPreview={false} + showValidationError={false} at that
// one call site; the other two callers (inbox composer, quick replies,
// neither with an amber strip) must keep both.
// ============================================================

describe("InteractiveBuilder — showPreview={false}", () => {
  it("omits the preview column entirely", () => {
    const html = render({ showPreview: false });
    expect(html).not.toContain("Preview");
  });

  it("still renders the inline validation error — showPreview and showValidationError are independent", () => {
    const html = render({ showPreview: false });
    expect(html).toContain("Interactive message body text is required.");
  });
});

describe("InteractiveBuilder — showValidationError={false}", () => {
  it("omits the inline red error text", () => {
    const html = render({ showValidationError: false });
    expect(html).not.toContain("Interactive message body text is required.");
    expect(html).not.toContain("text-red-400");
  });

  it("still renders the preview column — the two props are independent", () => {
    const html = render({ showValidationError: false });
    expect(html).toContain("Preview");
  });

  it("renders nothing extra for a VALID payload either way — there's no error text to suppress", () => {
    const valid = { kind: "buttons" as const, body: "Pick one", buttons: [{ id: "a", title: "A" }] };
    const withError = render({ value: valid, showValidationError: true });
    const withoutError = render({ value: valid, showValidationError: false });
    expect(withError).not.toContain("text-red-400");
    expect(withError).toBe(withoutError);
  });
});

describe("InteractiveBuilder — showPreview={false} and showValidationError={false} together (the send-composer.tsx call site)", () => {
  it("renders neither the preview column nor the inline error", () => {
    const html = render({ showPreview: false, showValidationError: false });
    expect(html).not.toContain("Preview");
    expect(html).not.toContain("Interactive message body text is required.");
    expect(html).not.toContain("text-red-400");
  });

  it("still renders the form fields — only the preview/error are suppressed, not the whole builder", () => {
    const html = render({ showPreview: false, showValidationError: false });
    expect(html).toContain("Reply buttons");
    expect(html).toContain("Body");
  });
});

// ============================================================
// Narrow-container layout: the "Show reply IDs (advanced)" crush.
//
// The id field used to sit on the SAME flex row as the label field, at a
// hard-coded width (`w-28` for buttons, `w-24` for list rows). With the
// fixed-width counter and the delete button also on that row, the four of
// them competed for one line, and `Input`'s own `min-w-0` let the
// `flex-1` label field lose: measured in a real browser at the automation
// builder's 223px fields column, the label input rendered 22px wide —
// exactly its own padding + border, i.e. ZERO content width — while the
// id input squeezed to 83px. Room for one character. The same column
// without advanced on gives the label 157px and is perfectly usable.
//
// The fix stacks the id field on its own line above the label row, so the
// label row's geometry is identical whether advanced is on or off. These
// tests pin the invariant that caused it: the id input must never share a
// flex row with the label input, and must not carry a hard-coded width.
//
// `advanced` is InteractiveBuilder's own useState and there's no jsdom
// here to tick the checkbox with, hence rendering the editors directly.
// ============================================================

/** The markup between the id input and the label input on its row. */
function rowSegment(html: string, labelPlaceholder: string) {
  const labelAt = html.indexOf(`placeholder="${labelPlaceholder}"`);
  expect(labelAt).toBeGreaterThan(-1);
  const rowAt = html.lastIndexOf('<div class="flex items-center gap-2', labelAt);
  expect(rowAt).toBeGreaterThan(-1);
  return html.slice(rowAt, labelAt);
}

/**
 * The whole `<input …/>` tag carrying `placeholder`. Must span to the tag
 * close, not just to the placeholder: React emits `class` AFTER
 * `placeholder`, so a slice that stops at the placeholder contains no
 * class attribute and any "doesn't have width X" assertion over it passes
 * vacuously.
 */
function inputTag(html: string, placeholder: string) {
  const at = html.indexOf(`placeholder="${placeholder}"`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<input", at);
  const end = html.indexOf("/>", at);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(at);
  const tag = html.slice(start, end);
  // Positive control: the slice really does reach the class attribute.
  expect(tag).toContain("class=");
  return tag;
}

function renderButtons(advanced: boolean) {
  return renderToStaticMarkup(
    React.createElement(ButtonsEditor, {
      value: {
        ...blankButtonsPayload(),
        body: "Pick one",
        buttons: [
          { id: "btn_1", title: "Yes" },
          { id: "btn_2", title: "No" },
        ],
      },
      onChange: () => {},
      advanced,
      t,
    }),
  );
}

function renderList(advanced: boolean) {
  return renderToStaticMarkup(
    React.createElement(ListEditor, {
      value: {
        ...blankListPayload(),
        body: "Pick one",
        sections: [
          {
            title: "Packages",
            rows: [
              { id: "row_1", title: "Safari" },
              { id: "row_2", title: "City tour" },
            ],
          },
        ],
      },
      onChange: () => {},
      advanced,
      t,
    }),
  );
}

describe("ButtonsEditor — advanced id field doesn't crush the button label", () => {
  it("keeps the id input out of the label's flex row", () => {
    expect(rowSegment(renderButtons(true), "Button label")).not.toContain(
      'placeholder="id"',
    );
  });

  it("gives the id input no hard-coded width — it takes its own full line", () => {
    const tag = inputTag(renderButtons(true), "id");
    expect(tag).not.toMatch(/\bw-28\b/);
    expect(tag).toMatch(/\bw-full\b/);
  });

  it("still renders the id input when advanced is on, and never when it's off", () => {
    expect(renderButtons(true)).toContain('placeholder="id"');
    expect(renderButtons(false)).not.toContain('placeholder="id"');
  });

  it("leaves the label row itself untouched — same flex-1 label + counter + delete", () => {
    for (const advanced of [true, false]) {
      const html = renderButtons(advanced);
      expect(html).toContain('<div class="flex items-center gap-2">');
      expect(html).toContain("flex-1");
    }
  });
});

describe("ListEditor — advanced id field doesn't crush the row title", () => {
  it("keeps the id input out of the title's flex row", () => {
    expect(rowSegment(renderList(true), "Row title")).not.toContain(
      'placeholder="id"',
    );
  });

  it("gives the id input no hard-coded width", () => {
    const tag = inputTag(renderList(true), "id");
    expect(tag).not.toMatch(/\bw-24\b/);
    expect(tag).toMatch(/\bw-full\b/);
  });

  it("still renders the id input when advanced is on, and never when it's off", () => {
    expect(renderList(true)).toContain('placeholder="id"');
    expect(renderList(false)).not.toContain('placeholder="id"');
  });

  it("keeps the optional description field below the title row", () => {
    const html = renderList(true);
    expect(html.indexOf('placeholder="Row title"')).toBeLessThan(
      html.indexOf('placeholder="Description (optional)"'),
    );
  });
});
