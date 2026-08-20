// Pure transport selection for a unified `send_message` step. No Convex,
// no fetch — the whole §1.2 decision table lives here so it is testable
// without a context and without a Meta call, the same convention
// `./schedule.ts` and `../whatsapp/messagingWindow.ts` follow.

import type { InteractiveMessagePayload } from '../whatsapp/interactive';

export type SendMediaType = 'image' | 'video' | 'audio' | 'document';

export interface SendMediaConfig {
  type: SendMediaType;
  /** R2 object key, account-scoped. Preferred over `url`. */
  key?: string;
  /** Legacy/external public URL. */
  url?: string;
  /** Document only — Meta rejects it on other kinds. */
  filename?: string;
}

export interface SendFallbackConfig {
  template_name: string;
  language: string;
  variables?: Record<string, string>;
  header?: { type: 'image' | 'video' | 'document'; key?: string; url?: string };
}

export interface SendMessageStepConfig {
  text?: string;
  media?: SendMediaConfig;
  interactive?: InteractiveMessagePayload;
  fallback?: SendFallbackConfig;
}

export type SendPlan =
  | { kind: 'text'; text: string }
  | {
      kind: 'media';
      mediaType: SendMediaType;
      caption?: string;
      key?: string;
      url?: string;
      filename?: string;
    }
  /** Audio cannot carry a caption (Meta 400s), so text becomes a second
   *  message. `metaApi.ts:655` already strips caption/filename for audio;
   *  this is the only case where one step emits two messages. */
  | { kind: 'media_then_text'; text: string; key?: string; url?: string }
  | { kind: 'interactive'; payload: InteractiveMessagePayload }
  | { kind: 'empty' };

function nonEmpty(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

/**
 * Evaluated top-down, first match wins. Order is load-bearing: the audio
 * split must be tested before the general media case, or a captioned
 * audio would be built and rejected by Meta.
 */
export function planSend(cfg: SendMessageStepConfig): SendPlan {
  const { text, media, interactive } = cfg;

  if (media && media.type === 'audio' && nonEmpty(text)) {
    return { kind: 'media_then_text', text, key: media.key, url: media.url };
  }

  if (media) {
    return {
      kind: 'media',
      mediaType: media.type,
      caption: nonEmpty(text) ? text : undefined,
      key: media.key,
      url: media.url,
      filename: media.filename,
    };
  }

  if (interactive) return { kind: 'interactive', payload: interactive };

  if (nonEmpty(text)) return { kind: 'text', text };

  return { kind: 'empty' };
}
