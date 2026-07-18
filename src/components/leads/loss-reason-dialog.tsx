'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { LOSS_CATEGORY_KEYS, type LossCategoryKey } from '@/lib/leads/pipeline';

// ============================================================
// LossReasonDialog — the mandatory "exactly why" gate for marking a
// deal lost. Shared by the leads pipeline and the inbox stage
// dropdown; `funnel.setStage` enforces the same rule server-side
// (category from the fixed list + detail ≥ 5 chars).
// ============================================================

const MIN_DETAIL = 5;

interface LossReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (category: LossCategoryKey, detail: string) => void;
}

export function LossReasonDialog({ open, onOpenChange, onConfirm }: LossReasonDialogProps) {
  const t = useTranslations('Inbox.funnel');
  const [category, setCategory] = useState<LossCategoryKey | ''>('');
  const [detail, setDetail] = useState('');

  const valid = category !== '' && detail.trim().length >= MIN_DETAIL;

  const reset = () => {
    setCategory('');
    setDetail('');
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('lossTitle')}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('lossDesc')}</p>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t('lossCategoryLabel')}</label>
            <Select value={category} onValueChange={(v) => setCategory(v as LossCategoryKey)}>
              <SelectTrigger>
                <SelectValue placeholder={t('lossCategoryLabel')} />
              </SelectTrigger>
              <SelectContent>
                {LOSS_CATEGORY_KEYS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {t(`lossCategory.${key}` as never)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">{t('lossDetailLabel')}</label>
            <Textarea
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder={t('lossDetailPlaceholder')}
              rows={3}
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="destructive"
            disabled={!valid}
            onClick={() => {
              if (!valid) return;
              const chosen = category as LossCategoryKey;
              const text = detail.trim();
              reset();
              onOpenChange(false);
              onConfirm(chosen, text);
            }}
          >
            {t('lossConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
