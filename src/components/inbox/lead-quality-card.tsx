"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { Check, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useQuery } from "@/lib/convex/cached";
import {
  LEAD_QUALITY_REASONS,
  type LeadQualityReason,
  type LeadQualityStep,
} from "@/lib/inbox/lead-quality";
import { cn } from "@/lib/utils";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

/**
 * The lead-quality card (spec 2026-09-01-lead-quality-feedback-loop-design).
 *
 * Why it exists: the Meta lifecycle events beyond the automatic first touch
 * only fire when someone advances the CRM funnel, and an audit found staff
 * did not know the stage control in the thread header existed. This is the
 * discoverable front door — it sits in the conversation the agent is already
 * reading and asks ONE plain question at a time.
 *
 * It renders NOTHING unless the server says there is a question to ask, so
 * a settled, snoozed, organic or lost thread costs the agent no attention at
 * all. That silence is what makes it tolerable to put in the message flow.
 *
 * A negative answer never reaches Meta — not by a check here, but because
 * `leadQuality.answer` has no code path from `no` to the conversion outbox.
 * The card is free to send every answer; the server decides what counts.
 */
export function LeadQualityCard({
  conversationId,
}: {
  conversationId: Id<"conversations">;
}) {
  const t = useTranslations("Inbox.leadQuality");
  // The account default, same source the dashboard and settings read. Only
  // a DISPLAY hint and an explicit echo of what the server would pick
  // anyway — `leadQuality.answer` falls back to the account currency, so a
  // stale value here can never write the wrong one.
  const { defaultCurrency } = useAuth();
  const currency = defaultCurrency ?? "USD";
  const answer = useMutation(api.leadQuality.answer);

  const state = useQuery(api.leadQuality.getCardState, { conversationId });

  // `mode` is the card's only real state: which of the three faces it is
  // showing. Kept local (not derived) because it is pure UI — the server
  // has no opinion about whether the agent has opened the reason list yet.
  const [mode, setMode] = useState<"ask" | "reason" | "amount">("ask");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  if (!state || !state.step || !state.canAnswer) return null;
  const step: LeadQualityStep = state.step;

  const submit = async (args: {
    answer: "yes" | "no" | "dismissed";
    reason?: LeadQualityReason;
    value?: number;
  }) => {
    setBusy(true);
    try {
      const res = await answer({
        conversationId,
        step,
        answer: args.answer,
        ...(args.reason ? { reason: args.reason } : {}),
        ...(args.value !== undefined
          ? { value: args.value, currency }
          : {}),
      });
      // Only confirm what actually happened. Claiming "sent to Meta" on a
      // lead whose event was deduped or whose chat is organic would be a
      // lie the agent has no way to check.
      toast.success(res.sentToMeta ? t("sentToast") : t("savedToast"));
      setMode("ask");
      setAmount("");
    } catch {
      toast.error(t("error"));
    } finally {
      setBusy(false);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="px-4 pb-2">
      <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
        {children}
      </div>
    </div>
  );

  // --- Reason list: shown after "No". One tap, no typing. ---------------
  if (mode === "reason") {
    return shell(
      <>
        <p className="mb-2 text-xs font-medium text-foreground">
          {t("reasonPrompt")}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {LEAD_QUALITY_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              disabled={busy}
              onClick={() => void submit({ answer: "no", reason: r })}
              className={cn(
                "rounded-full border border-border bg-background px-2.5 py-1",
                "text-xs text-foreground hover:bg-muted disabled:opacity-50",
              )}
            >
              {t(`reason.${r}`)}
            </button>
          ))}
        </div>
      </>,
    );
  }

  // --- Amount: shown after "Yes" on the payment step. -------------------
  if (mode === "amount") {
    const parsed = Number(amount);
    const valid = Number.isFinite(parsed) && parsed > 0;
    return shell(
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-foreground">
          {t("amountPrompt")}
        </span>
        <span className="text-xs text-muted-foreground">{currency}</span>
        <Input
          autoFocus
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid && !busy) {
              void submit({ answer: "yes", value: parsed });
            }
          }}
          className="h-7 w-28 text-xs"
        />
        <Button
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={!valid || busy}
          onClick={() => void submit({ answer: "yes", value: parsed })}
        >
          <Check className="mr-1 h-3 w-3" />
          {t("confirm")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={busy}
          onClick={() => setMode("ask")}
        >
          {t("cancel")}
        </Button>
      </div>,
    );
  }

  // --- The question itself. ---------------------------------------------
  return shell(
    <div className="flex items-center gap-2">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span className="flex-1 text-xs font-medium text-foreground">
        {t(`question.${step}`)}
      </span>
      <Button
        size="sm"
        className="h-7 px-3 text-xs"
        disabled={busy}
        onClick={() => {
          if (step === "payment") {
            setMode("amount");
            return;
          }
          void submit({ answer: "yes" });
        }}
      >
        {t("yes")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-3 text-xs"
        disabled={busy}
        onClick={() => {
          // Only the FIRST question asks why — that is the one whose "no"
          // is a verdict on the lead. A "no" later just means "not yet".
          if (step === "genuine") {
            setMode("reason");
            return;
          }
          void submit({ answer: "no" });
        }}
      >
        {t("no")}
      </Button>
      <button
        type="button"
        aria-label={t("dismiss")}
        title={t("dismiss")}
        disabled={busy}
        onClick={() => void submit({ answer: "dismissed" })}
        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>,
  );
}
