'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import { Loader2, Sparkles, CheckCircle2, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { AiKnowledgeCard } from './ai-knowledge';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import type { AiProvider } from '@/lib/ai/types';
import {
  toUiAiConfig,
  toUiMemberProfile,
  isConvexErrorCode,
} from '@/lib/convex/adapters';
import { useTranslations } from 'next-intl';

import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';

const MASKED_KEY = '••••••••••••••••';
const DEFAULT_MAX_AUTO_REPLIES = 8;

// Radix Select can't use an empty-string item value, so the "leave
// unassigned" choice gets a sentinel that maps to `undefined` in the
// mutation payload.
const HANDOFF_QUEUE = '__queue__';

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
};

const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-...',
};

/**
 * AI auto-reply config (Phase 8, Task 3 / P8-T3) — `aiConfigs`, one row
 * per account. `api.aiConfig.get` never returns the encrypted
 * `apiKey`/`embeddingsApiKey` columns, only derived `hasKey`/
 * `hasEmbeddingsKey` booleans (see that query's own doc comment), so
 * the masked placeholder below is always a fixed string, never
 * anything read back from the server. Saving goes through
 * `api.aiConfig.upsert`, which encrypts a freshly-typed key
 * server-side and REUSES the stored ciphertext whenever a key field is
 * omitted (untouched) — see that mutation's doc comment — so the form
 * only ever sends a plaintext key when the admin actually retyped one,
 * same as the pre-Convex REST route.
 *
 * No `aiConfig.remove` mutation exists in Convex (only `get`/`upsert`/
 * the internal `loadDecrypted`), so the old "Remove configuration"
 * button — which called a Supabase-backed DELETE route — has no Convex
 * counterpart and is dropped here rather than left wired to a route
 * that would silently no-op against the Convex-sourced config this form
 * now reads. "Enable AI assistant" (`isActive`) remains the way to turn
 * the assistant off.
 */
export function AiConfig() {
  const { canEditSettings: canEdit, profileLoading } = useAuth();
  const t = useTranslations('Settings.aiConfig');

  const configDoc = useQuery(api.aiConfig.get);
  const loading = configDoc === undefined;
  const configured = configDoc != null;
  const config = useMemo(
    () => (configDoc ? toUiAiConfig(configDoc) : null),
    [configDoc],
  );

  const upsertConfig = useMutation(api.aiConfig.upsert);
  const testConnection = useAction(api.aiConfig.testConnection);

  // The handoff-target picker's teammate list, via reactive
  // `api.members.list` (any member may read it) mapped through the
  // shared `toUiMemberProfile` adapter — same pattern as the inbox
  // assign dropdown (`message-thread.tsx`).
  const memberDocs = useQuery(api.members.list);
  const members = useMemo(
    () => (memberDocs ?? []).map(toUiMemberProfile),
    [memberDocs],
  );

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [provider, setProvider] = useState<AiProvider>('openai');
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  // 8, not 3: the one-question-per-message qualification flow needs a
  // full exchange's worth of turns — a cap of 3 silences the bot
  // mid-qualification (the engine then hands off early).
  const [maxPerConversation, setMaxPerConversation] = useState(DEFAULT_MAX_AUTO_REPLIES);
  // Empty string = leave unassigned (shared queue).
  const [handoffAgentId, setHandoffAgentId] = useState('');

  const hasStoredKey = config?.hasKey ?? false;
  const hasStoredEmbeddingsKey = config?.hasEmbeddingsKey ?? false;

  // Hydrate the form from the Convex-sourced row exactly once — mirrors
  // whatsapp-config.tsx's `hydratedRef`: a reactive re-delivery of
  // `configDoc` (e.g. right after this component's own `handleSave`
  // mutates it) must NOT stomp the re-masking `handleSave` already does
  // itself below.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (configDoc === undefined) return; // still loading
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    if (config) {
      setProvider(config.provider);
      setModel(config.model);
      setSystemPrompt(config.systemPrompt ?? '');
      setIsActive(config.isActive);
      setAutoReplyEnabled(config.autoReplyEnabled);
      setMaxPerConversation(config.autoReplyMaxPerConversation ?? DEFAULT_MAX_AUTO_REPLIES);
      setHandoffAgentId(config.handoffAgentId ?? '');
      setApiKey(config.hasKey ? MASKED_KEY : '');
      setEmbeddingsKey(config.hasEmbeddingsKey ? MASKED_KEY : '');
    }
  }, [configDoc, config]);

  // Swap the model default when the provider changes, unless the user
  // typed a custom model.
  const handleProviderChange = (next: AiProvider) => {
    setProvider(next);
    const isDefaultModel =
      model === AI_PROVIDER_DEFAULT_MODEL.openai ||
      model === AI_PROVIDER_DEFAULT_MODEL.anthropic ||
      model.trim() === '';
    if (isDefaultModel) setModel(AI_PROVIDER_DEFAULT_MODEL[next]);
  };

  // undefined = omit the arg (upsert reuses the stored key / leaves the
  // embeddings key untouched); a non-blank freshly-typed value = set it.
  const keyPayload = () =>
    keyEdited && apiKey.trim() ? apiKey.trim() : undefined;
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited && embeddingsKey.trim()
      ? embeddingsKey.trim()
      : undefined;

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await testConnection({
        provider,
        model: model.trim(),
        apiKey: keyPayload(),
      });
      if ('error' in result) {
        toast.error(result.error ?? t('testRejected'));
      } else {
        toast.success(t('testSuccess'));
      }
    } catch {
      toast.error(t('testNetworkError'));
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!model.trim()) {
      toast.error(t('missingModel'));
      return;
    }
    if (!configured && !keyEdited) {
      toast.error(t('missingApiKey'));
      return;
    }
    setSaving(true);
    try {
      await upsertConfig({
        provider,
        model: model.trim(),
        systemPrompt: systemPrompt.trim() || undefined,
        isActive,
        autoReplyEnabled,
        autoReplyMaxPerConversation: maxPerConversation,
        handoffAgentId: handoffAgentId
          ? (handoffAgentId as Id<'users'>)
          : undefined,
        apiKey: keyPayload(),
        embeddingsApiKey: embeddingsKeyPayload(),
      });

      toast.success(t('saveSuccess'));
      // Re-mask locally rather than relying on a reactive re-hydration
      // (blocked by `hydratedRef` above) — a successful save always
      // leaves a key stored (fresh or reused), and leaves the
      // embeddings key stored iff one was just set or one already
      // existed before this save.
      setKeyEdited(false);
      setApiKey(MASKED_KEY);
      const embeddingsKeyNowStored =
        (embeddingsKeyEdited && embeddingsKey.trim().length > 0) ||
        hasStoredEmbeddingsKey;
      setEmbeddingsKeyEdited(false);
      setEmbeddingsKey(embeddingsKeyNowStored ? MASKED_KEY : '');
    } catch (err) {
      if (isConvexErrorCode(err, 'API_KEY_REQUIRED')) {
        toast.error(t('missingApiKey'));
      } else {
        console.error('[AiConfig] save error:', err);
        toast.error(t('saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> {t('providerAndKey')}
            </CardTitle>
            <CardDescription>
              {t('encryptionNotice')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t('provider')}</Label>
                <Select
                  value={provider}
                  onValueChange={(v) => handleProviderChange(v as AiProvider)}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">{PROVIDER_LABEL.openai}</SelectItem>
                    <SelectItem value="anthropic">
                      {PROVIDER_LABEL.anthropic}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ai-model">{t('model')}</Label>
                <Input
                  id="ai-model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={AI_PROVIDER_DEFAULT_MODEL[provider]}
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-key">{t('apiKey')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setApiKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={KEY_PLACEHOLDER[provider]}
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {t('testKey')}
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-embeddings-key">
                {t('embeddingsKey')}{' '}
                <span className="font-normal text-muted-foreground">
                  {t('optionalSemanticSearch')}
                </span>
              </Label>
              <Input
                id="ai-embeddings-key"
                type="password"
                value={embeddingsKey}
                onChange={(e) => {
                  setEmbeddingsKey(e.target.value);
                  setEmbeddingsKeyEdited(true);
                }}
                onFocus={() => {
                  if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
                    setEmbeddingsKey('');
                    setEmbeddingsKeyEdited(true);
                  }
                }}
                placeholder="sk-... (OpenAI)"
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {t('embeddingsHint', {
                  sameKeyText: provider === 'openai' ? t('sameKeyText') : '',
                })}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('behaviour')}</CardTitle>
            <CardDescription>
              {t('behaviourDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-prompt">{t('businessContext')}</Label>
              <Textarea
                id="ai-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('promptPlaceholder')}
                rows={5}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('enableAssistant')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('enableAssistantDesc')}
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('autoReply')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('autoReplyDesc')}
                </p>
              </div>
              <Switch
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-max">{t('maxAutoReplies')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('maxAutoRepliesDesc')}
                </p>
              </div>
              <Input
                id="ai-max"
                type="number"
                min={1}
                max={20}
                value={maxPerConversation}
                onChange={(e) =>
                  setMaxPerConversation(
                    Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                  )
                }
                disabled={disabled || !autoReplyEnabled}
                className="w-20"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-handoff">{t('handoffTo')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('handoffToDesc')}
              </p>
              <Select
                value={handoffAgentId || HANDOFF_QUEUE}
                onValueChange={(v) =>
                  setHandoffAgentId(!v || v === HANDOFF_QUEUE ? '' : v)
                }
                disabled={disabled || !autoReplyEnabled}
              >
                <SelectTrigger id="ai-handoff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={HANDOFF_QUEUE}>
                    {t('handoffQueue')}
                  </SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {canEdit && (
          <AiKnowledgeCard
            canEdit={canEdit}
            hasEmbeddingsKey={
              embeddingsKeyEdited
                ? embeddingsKey.trim().length > 0
                : hasStoredEmbeddingsKey
            }
          />
        )}

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
