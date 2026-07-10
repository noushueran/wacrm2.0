/**
 * Translate a template row's fields into the `components` array shape
 * Meta's POST /{waba_id}/message_templates endpoint expects. Convex
 * port of `src/lib/whatsapp/template-components.ts`'s
 * `buildMetaTemplatePayload` (Phase 8, Task 4) — same HEADER → BODY →
 * FOOTER → BUTTONS assembly and header_handle/header_url fallback, just
 * renamed to the camelCase field names `convex/templates.ts`'s `upsert`
 * already uses (`bodyText`, `headerType`, ...) instead of the source's
 * snake_case `TemplatePayload`. Used by `convex/metaTemplates.ts`'s
 * `submitToMeta` internalAction. Kept pure and JSON-shaped so it's
 * directly unit-testable with no Convex runtime, mirroring the
 * source's own `template-components.test.ts`.
 *
 * Spec reference:
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components
 */

export type TemplateCategory = "Marketing" | "Utility" | "Authentication";
export type TemplateHeaderType = "text" | "image" | "video" | "document";

export interface TemplateButtonInput {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE";
  text: string;
  url?: string;
  phone_number?: string;
  example?: string;
}

export interface TemplateComponentsInput {
  name: string;
  category: TemplateCategory;
  language: string;
  bodyText: string;
  headerType?: TemplateHeaderType;
  headerContent?: string;
  headerMediaUrl?: string;
  headerHandle?: string;
  footerText?: string;
  buttons?: TemplateButtonInput[];
  sampleValues?: { body?: string[]; header?: string[] };
}

export interface MetaComponent {
  type: "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
  format?: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
  text?: string;
  buttons?: MetaButtonPayload[];
  example?: {
    header_text?: string[];
    header_url?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
}

interface MetaButtonPayload {
  type: "QUICK_REPLY" | "URL" | "PHONE_NUMBER" | "COPY_CODE";
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[];
}

export interface MetaTemplateSubmitPayload {
  name: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  language: string;
  components: MetaComponent[];
}

const CATEGORY_TO_META: Record<
  TemplateCategory,
  MetaTemplateSubmitPayload["category"]
> = {
  Marketing: "MARKETING",
  Utility: "UTILITY",
  Authentication: "AUTHENTICATION",
};

function buildHeaderComponent(
  input: TemplateComponentsInput,
): MetaComponent | null {
  const { headerType, headerContent, headerMediaUrl, headerHandle } = input;
  if (!headerType) return null;

  if (headerType === "text") {
    const headerSample = input.sampleValues?.header;
    const component: MetaComponent = {
      type: "HEADER",
      format: "TEXT",
      text: headerContent,
    };
    if (headerSample && headerSample.length > 0) {
      component.example = { header_text: headerSample };
    }
    return component;
  }

  const format =
    headerType === "image" ? "IMAGE" : headerType === "video" ? "VIDEO" : "DOCUMENT";
  const component: MetaComponent = { type: "HEADER", format };
  if (headerHandle) {
    component.example = { header_handle: [headerHandle] };
  } else if (headerMediaUrl) {
    component.example = { header_url: [headerMediaUrl] };
  }
  return component;
}

function buildBodyComponent(input: TemplateComponentsInput): MetaComponent {
  const component: MetaComponent = { type: "BODY", text: input.bodyText };
  const bodySample = input.sampleValues?.body;
  if (bodySample && bodySample.length > 0) {
    // Meta expects body_text as a 2D array — outer is "examples", inner
    // is the values for each variable. We submit a single example row.
    component.example = { body_text: [bodySample] };
  }
  return component;
}

function buildFooterComponent(
  input: TemplateComponentsInput,
): MetaComponent | null {
  if (!input.footerText?.trim()) return null;
  return { type: "FOOTER", text: input.footerText };
}

function buildButtonPayload(b: TemplateButtonInput): MetaButtonPayload {
  switch (b.type) {
    case "QUICK_REPLY":
      return { type: "QUICK_REPLY", text: b.text };
    case "URL": {
      const payload: MetaButtonPayload = { type: "URL", text: b.text, url: b.url };
      if (b.example) payload.example = [b.example];
      return payload;
    }
    case "PHONE_NUMBER":
      return { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone_number };
    case "COPY_CODE":
      // The source unconditionally wraps `b.example` in an array; guarded
      // here since this port's `example` is optional. Not a behavior
      // change in practice — `template-validators.ts`'s `validateButtons`
      // already requires COPY_CODE to carry a non-empty example before a
      // payload ever reaches this far.
      return {
        type: "COPY_CODE",
        text: b.text,
        example: b.example ? [b.example] : undefined,
      };
  }
}

function buildButtonsComponent(
  input: TemplateComponentsInput,
): MetaComponent | null {
  if (!input.buttons || input.buttons.length === 0) return null;
  return { type: "BUTTONS", buttons: input.buttons.map(buildButtonPayload) };
}

/**
 * Assemble the full submit payload (name + category + language +
 * components in canonical order: HEADER → BODY → FOOTER → BUTTONS).
 */
export function buildMetaTemplatePayload(
  input: TemplateComponentsInput,
): MetaTemplateSubmitPayload {
  const components: MetaComponent[] = [];
  const header = buildHeaderComponent(input);
  if (header) components.push(header);
  components.push(buildBodyComponent(input));
  const footer = buildFooterComponent(input);
  if (footer) components.push(footer);
  const buttons = buildButtonsComponent(input);
  if (buttons) components.push(buttons);

  return {
    name: input.name,
    category: CATEGORY_TO_META[input.category],
    language: input.language,
    components,
  };
}
