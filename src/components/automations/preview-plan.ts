// Pure config -> shape decisions for message-preview.tsx, pulled out so
// the two riskiest questions a chat-bubble preview has to answer —
// "which bubbles, in what order" and "what does {{n}} show when the
// operator hasn't typed a value yet" — are unit-testable without
// rendering anything (this repo has no jsdom/Testing Library; see
// action-catalog.ts for the precedent this file follows).

import { planSend, type SendMediaType } from "../../../convex/lib/automations/sendPlan";
import type { SendMessageStepConfig } from "@/types";
import type { InteractiveMessagePayload } from "@/lib/whatsapp/interactive";

export type PreviewBubble =
  | { kind: "text"; text: string }
  | {
      kind: "media";
      mediaType: SendMediaType;
      key?: string;
      url?: string;
      filename?: string;
      caption?: string;
    }
  | { kind: "interactive"; payload: InteractiveMessagePayload };

/**
 * Maps a send-step config to the ordered list of chat bubbles it will
 * actually produce. Transport selection is entirely delegated to
 * `planSend` (convex/lib/automations/sendPlan.ts) — the exact rules
 * `automationsEngine.ts` runs at send time — rather than re-derived here,
 * so this can't quietly drift from what the engine does.
 *
 * The one case that expands to more than one bubble is
 * `media_then_text`: WhatsApp can't caption audio, so the engine sends
 * the audio first and the text as a separate follow-up message
 * (`automationsEngine.ts`'s `runStep`, the "Both remaining plans send
 * media first" branch). Returning both bubbles, in that order, is the
 * entire point of this module — collapsing them to one bubble would
 * misrepresent what the customer receives.
 */
export function planPreviewBubbles(config: SendMessageStepConfig): PreviewBubble[] {
  const plan = planSend(config);

  switch (plan.kind) {
    case "empty":
      return [];

    case "text":
      return [{ kind: "text", text: plan.text }];

    case "media":
      return [
        {
          kind: "media",
          mediaType: plan.mediaType,
          key: plan.key,
          url: plan.url,
          filename: plan.filename,
          caption: plan.caption,
        },
      ];

    case "media_then_text":
      // planSend only ever reaches this case for audio (sendPlan.ts's
      // `media.type === 'audio'` guard) — automationsEngine.ts hardcodes
      // the same "audio" kind at its analogous branch rather than reading
      // it off a field that doesn't exist on this plan variant.
      return [
        { kind: "media", mediaType: "audio", key: plan.key, url: plan.url },
        { kind: "text", text: plan.text },
      ];

    case "interactive":
      return [{ kind: "interactive", payload: plan.payload }];
  }
}

export type TemplateBodySegment =
  | { kind: "text"; value: string }
  | { kind: "placeholder"; n: number };

const TEMPLATE_PLACEHOLDER = /\{\{\s*(\d+)\s*\}\}/g;

function nonEmpty(s: string | undefined): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Splits a Meta template body into literal-text and placeholder segments,
 * substituting each `{{n}}` with the matching typed variable when one
 * exists (so the preview shows the real outgoing message) and leaving it
 * as a `{kind:"placeholder"}` marker when the operator hasn't filled it
 * in — rendered as a muted `{{n}}` pill by the component, never sent
 * blank. Uses the exact placeholder regex `extractTemplateVariables`
 * (convex/lib/automations/templateVars.ts) does, so the two can never
 * disagree about what counts as a placeholder.
 */
export function planTemplateBody(
  body: string,
  variables: Record<string, string> | undefined,
): TemplateBodySegment[] {
  if (!body) return [];

  const segments: TemplateBodySegment[] = [];
  let lastIndex = 0;

  for (const match of body.matchAll(TEMPLATE_PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", value: body.slice(lastIndex, index) });
    }
    const n = Number(match[1]);
    const value = variables?.[String(n)];
    segments.push(nonEmpty(value) ? { kind: "text", value } : { kind: "placeholder", n });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < body.length) {
    segments.push({ kind: "text", value: body.slice(lastIndex) });
  }

  return segments;
}

export type TemplatePreviewState =
  | { kind: "loading" }
  | { kind: "not-found"; label: string }
  | { kind: "resolved"; segments: TemplateBodySegment[] };

/**
 * I-4 fix. `automation-builder.tsx`'s `SendTemplateFields` resolves
 * `selectedTemplate` against `useResources().templates`, which is `[]`
 * both while the account's template list is still loading AND once
 * loaded, for a `template_name` that no longer matches any approved
 * template (deleted/unapproved since this step was configured). Feeding
 * `selectedTemplate?.body_text ?? ""` straight into `planTemplateBody`
 * collapsed all three into the same "Nothing to send yet." empty state —
 * wrong for "not found", since the step passes validation
 * (`validateStepsForActivation`'s `send_template` case only checks
 * `template_name` is non-empty) and the engine WILL attempt the send.
 *
 * This is the pure "which of the three states applies" decision, kept
 * separate from rendering (this file's whole reason to exist — see the
 * header comment) so it's unit-testable without NextIntlClientProvider or
 * renderToStaticMarkup. `notFoundLabel` is supplied by the caller — it
 * must be the EXACT text the template `<select>` already shows for this
 * case (`t("templates.unknown", {name, lang})`), never a second, invented
 * way to say "not found".
 */
export function resolveTemplatePreview(args: {
  loading: boolean;
  notFoundLabel: string | undefined;
  body: string;
  variables: Record<string, string> | undefined;
}): TemplatePreviewState {
  if (args.loading) return { kind: "loading" };
  if (args.notFoundLabel) return { kind: "not-found", label: args.notFoundLabel };
  return { kind: "resolved", segments: planTemplateBody(args.body, args.variables) };
}

export type TextSegment =
  | { kind: "text"; value: string }
  | { kind: "token"; raw: string; resolves: boolean };

const INTERPOLATION_TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * True for the one token shape `interpolate()`
 * (`convex/automationsEngine.ts:1463-1470`) ever fills with real content
 * in production: `message.text`.
 *
 * That function's source has a second live branch — `vars.<prop>` — but
 * `AutomationContext.vars` is never populated by any real dispatch call
 * site: `ingest.ts`'s inbound-trigger context is `{ messageText,
 * conversationId, interactiveReplyId }`, `lib/automations/triggers.ts`'s
 * `tag_added`/`conversation_assigned` dispatch is `{ tagId | agentId,
 * conversationId }`, and the `time_based` sweep's is `{ automationId,
 * tagId }` — none of the three carry `vars`. Only a direct unit test
 * (`automationsEngine.test.ts`) sets it. So `{{ vars.* }}` evaluates to
 * `""` in production today, exactly like `{{ contact.name }}` or any
 * other token `interpolate()` doesn't recognise — pilling it as "this
 * resolves" would repeat the exact lie this function exists to stop (see
 * `message-preview.tsx`'s `VanishingToken`). If a future engine change
 * starts populating `vars`, this is the one line that needs to change.
 */
export function tokenResolves(raw: string): boolean {
  return raw === "message.text";
}

/**
 * Splits free-form send text (a `send_message` step's `text`/caption)
 * into literal segments and `{{ ... }}` token segments — the same shape
 * `automationsEngine.ts`'s `interpolate()` parses at send time. This
 * preview has no contact/message context to substitute a resolving
 * token's real value WITH, so even `{{ message.text }}` still comes back
 * as a `{kind:"token"}` marker rather than literal text — but every
 * segment now also carries `resolves` (`tokenResolves` above), so the
 * component can render "becomes real content at send time"
 * (`message.text`) differently from "deleted, sent as nothing"
 * (everything else, `vars.*` included) instead of showing both as the
 * same confident pill.
 */
export function splitInterpolationTokens(text: string): TextSegment[] {
  if (!text) return [];

  const segments: TextSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INTERPOLATION_TOKEN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, index) });
    }
    segments.push({ kind: "token", raw: match[1], resolves: tokenResolves(match[1]) });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }

  return segments;
}
