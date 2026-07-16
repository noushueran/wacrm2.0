'use client';

import { useMemo, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { Sparkles, Check, X, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { toUiTag, toUiTagSuggestion } from '@/lib/convex/adapters';
import { Button } from '@/components/ui/button';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

// ============================================================
// Inbox "Suggest tags" banner (AI Tag Suggestions, Task 6) — shows a
// dashed "Suggest tags" CTA when there's no pending classification for
// this conversation, or the proposed tag chips + note with Accept/
// Dismiss once `aiTagging.pendingForConversation` returns one. Every
// `useAction`/`useMutation` call is wrapped in try/catch with a toast —
// `suggest` in particular RETURNS `{error, code}` on failure rather than
// throwing (see `convex/aiTagging.ts`'s file header), so its result is
// branched on explicitly in addition to the catch.
// ============================================================

/**
 * Maps a `suggest` failure `code` (`convex/aiTagging.ts`'s `SuggestResult`
 * error branch) to a translated message. This repo's next-intl (`use-intl`
 * 4.13 — see `node_modules/use-intl/dist/types/core/createTranslator.d.ts`)
 * has no `t(key, {fallback})` option: `Translator`'s call signature is
 * `(key, values?, formats?)`, so a dynamic `t(\`error_${code}\`)` can't
 * gracefully degrade on a miss. Only the codes normal UI use can produce
 * get specific copy; anything else (`unauthenticated`, `key_decrypt_failed`,
 * a provider `AiError.code` like `timeout`/`network_error`, …) falls back
 * to the generic message.
 */
function suggestErrorMessage(code: string, t: ReturnType<typeof useTranslations>): string {
  switch (code) {
    case 'ai_not_configured':
      return t('error_ai_not_configured');
    case 'forbidden':
      return t('error_forbidden');
    case 'not_found':
      return t('error_not_found');
    case 'no_account':
      return t('error_no_account');
    default:
      return t('errorGeneric');
  }
}

export function TagSuggestionBanner({
  conversationId,
}: {
  // Accepted for interface symmetry with sibling components (e.g.
  // `LabelPicker`) and so callers can pass it without a lint complaint —
  // `pendingForConversation` scopes by `conversationId` alone (a
  // conversation has exactly one contact), so the banner itself never
  // reads it.
  contactId: string;
  conversationId: string;
}) {
  const t = useTranslations('Inbox.tagSuggestions');
  const pendingRes = useQuery(api.aiTagging.pendingForConversation, {
    conversationId: conversationId as Id<'conversations'>,
  });
  const allTagsRes = useQuery(api.tags.list);
  const suggest = useAction(api.aiTagging.suggest);
  const accept = useMutation(api.aiTagging.acceptSuggestion);
  const dismiss = useMutation(api.aiTagging.dismissSuggestion);

  const [busy, setBusy] = useState(false);
  const suggestion = pendingRes ? toUiTagSuggestion(pendingRes) : null;
  const tagsById = useMemo(() => {
    const m = new Map<string, { name: string; color: string }>();
    for (const doc of allTagsRes ?? []) {
      const uiTag = toUiTag(doc);
      m.set(uiTag.id, { name: uiTag.name, color: uiTag.color });
    }
    return m;
  }, [allTagsRes]);

  async function runSuggest() {
    setBusy(true);
    try {
      const res = await suggest({ conversationId: conversationId as Id<'conversations'> });
      if ('error' in res) {
        toast.error(suggestErrorMessage(res.code, t));
      }
    } catch {
      toast.error(t('errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  async function handleAccept(suggestionId: Id<'tagSuggestions'>) {
    setBusy(true);
    try {
      await accept({ suggestionId });
      toast.success(t('accepted'));
    } catch {
      toast.error(t('errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  async function handleDismiss(suggestionId: Id<'tagSuggestions'>) {
    setBusy(true);
    try {
      await dismiss({ suggestionId });
    } catch {
      toast.error(t('errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  if (suggestion) {
    const suggestionId = suggestion.id as Id<'tagSuggestions'>;
    return (
      <div className="mb-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-primary">
          <Sparkles className="size-3.5" /> {t('title')}
        </div>
        <div className="mb-2 flex flex-wrap gap-1">
          {suggestion.suggested_tag_ids.map((id) => {
            const tag = tagsById.get(id);
            return tag ? (
              <span
                key={id}
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
              >
                {tag.name}
              </span>
            ) : null;
          })}
        </div>
        {suggestion.note && (
          <p className="mb-2 text-xs text-muted-foreground">{suggestion.note}</p>
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => handleAccept(suggestionId)}
          >
            <Check className="size-3.5" /> {t('accept')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => handleDismiss(suggestionId)}
          >
            <X className="size-3.5" /> {t('dismiss')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={runSuggest}
      disabled={busy}
      className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}{' '}
      {t('suggestCta')}
    </button>
  );
}
