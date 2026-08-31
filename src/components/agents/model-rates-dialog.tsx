'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DEFAULT_MODEL_RATES, type ModelRate } from '@/lib/ai/pricing';

import { api } from '../../../convex/_generated/api';

// ============================================================
// Per-model rate editor for the usage card. Exists because the app
// cannot know what the account pays: prices differ by provider tier and
// change without notice, and `pricing.ts` ships defaults only for models
// whose rates are verified. Everything else is entered here, read off
// the provider's own billing page — which is what the copy below says,
// because a rate typed from memory is the same failure as a rate
// hard-coded from memory.
// ============================================================

type Draft = { input: string; cached: string; output: string };

const EMPTY_DRAFT: Draft = { input: '', cached: '', output: '' };

function toDraft(rate: ModelRate | undefined): Draft {
  if (!rate) return EMPTY_DRAFT;
  return {
    input: String(rate.inputPerMTok),
    cached: String(rate.cachedInputPerMTok),
    output: String(rate.outputPerMTok),
  };
}

export function ModelRatesDialog({
  open,
  onOpenChange,
  models,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every model to offer a row for — typically those seen in the
   *  current usage window, so the list matches what the card shows. */
  models: { model: string; provider: 'openai' | 'anthropic' }[];
}) {
  const rateDocs = useQuery(api.aiModelRates.list, open ? {} : 'skip');
  const upsert = useMutation(api.aiModelRates.upsert);

  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState(false);

  // Seed the form exactly once per time the dialog opens, from whatever
  // rates are current at that moment, and never again while it stays
  // open — even if `rateDocs` or `models` change identity in the
  // meantime. Both are live-Convex-subscription-derived (`models` is
  // `data.byModel` from the `aiUsage.summary` subscription, which
  // re-fires as the current hour's rollup bucket is patched on every
  // account AI call, `rateDocs` on every `upsert`), so without
  // this latch the effect re-fires on background data churn and wipes
  // out whatever the admin is mid-typing. The ref is the latch: it is
  // set the first time we seed while open, and cleared as soon as `open`
  // goes false, so reopening the dialog seeds fresh (a cancelled edit
  // must not persist) but nothing re-seeds in between.
  const seededForOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      seededForOpenRef.current = false;
      return;
    }
    if (seededForOpenRef.current) return;
    if (rateDocs === undefined) return;
    const stored = new Map(rateDocs.map((d) => [d.model, d]));
    const next: Record<string, Draft> = {};
    for (const { model } of models) {
      const doc = stored.get(model);
      next[model] = doc
        ? toDraft({
            inputPerMTok: doc.inputPerMTok,
            cachedInputPerMTok: doc.cachedInputPerMTok,
            outputPerMTok: doc.outputPerMTok,
          })
        : toDraft(DEFAULT_MODEL_RATES[model]);
    }
    setDrafts(next);
    seededForOpenRef.current = true;
  }, [open, rateDocs, models]);

  const setField = (model: string, field: keyof Draft, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [model]: { ...(prev[model] ?? EMPTY_DRAFT), [field]: value },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      let written = 0;
      for (const { model, provider } of models) {
        const draft = drafts[model] ?? EMPTY_DRAFT;
        // Whitespace-only counts as blank, consistent with how the
        // server trims the model id.
        const trimmed = {
          input: draft.input.trim(),
          cached: draft.cached.trim(),
          output: draft.output.trim(),
        };
        const filledCount = [trimmed.input, trimmed.cached, trimmed.output].filter(
          (v) => v !== '',
        ).length;

        // A fully blank row means "I have not filled this in yet" —
        // skip it rather than writing zeros, which would make an
        // unpriced model silently read as free.
        if (filledCount === 0) continue;

        // A row is either fully specified or skipped — there is no valid
        // partial state. `upsert` requires all three rates, and filling
        // the missing fields with 0 would make them read as genuinely
        // free, which is the exact failure this dialog exists to avoid.
        if (filledCount < 3) {
          toast.error(`${model}: enter all three rates, or leave the row blank`);
          setSaving(false);
          return;
        }

        const values = {
          inputPerMTok: Number(trimmed.input),
          cachedInputPerMTok: Number(trimmed.cached),
          outputPerMTok: Number(trimmed.output),
        };
        if (
          Object.values(values).some((v) => !Number.isFinite(v) || v < 0)
        ) {
          toast.error(`${model}: rates must be non-negative numbers`);
          setSaving(false);
          return;
        }

        await upsert({ provider, model, ...values });
        written += 1;
      }
      toast.success(
        written === 1 ? 'Saved 1 rate' : `Saved ${written} rates`,
      );
      onOpenChange(false);
    } catch {
      toast.error('Could not save rates');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Model rates</DialogTitle>
          <DialogDescription>
            USD per 1,000,000 tokens. Take these from your provider&apos;s own
            billing or pricing page — spend on the usage tab is only as
            accurate as what you enter here. Leave a model blank to keep it
            excluded from spend rather than counted as free.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {models.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No models have been used in the selected window yet.
            </p>
          )}
          {models.map(({ model, provider }) => (
            <div key={model} className="rounded-md border border-border p-3">
              <p className="mb-2 text-sm font-medium text-foreground">
                {model}{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  ({provider})
                </span>
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {(
                  [
                    ['input', 'Input'],
                    ['cached', 'Cached input'],
                    ['output', 'Output'],
                  ] as const
                ).map(([field, label]) => (
                  <div key={field}>
                    <Label
                      htmlFor={`${model}-${field}`}
                      className="text-xs text-muted-foreground"
                    >
                      {label}
                    </Label>
                    <Input
                      id={`${model}-${field}`}
                      inputMode="decimal"
                      placeholder="0.00"
                      value={drafts[model]?.[field] ?? ''}
                      onChange={(e) => setField(model, field, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save rates'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
