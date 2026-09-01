"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { Check, Gauge, X } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useQuery } from "@/lib/convex/cached";
import {
  LEAD_QUALITY_REASONS,
  type LeadQualityReason,
  type LeadQualityStep,
} from "@/lib/inbox/lead-quality";
import { cn } from "@/lib/utils";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";

type StepState = {
  step: LeadQualityStep;
  locked: boolean;
  available: boolean;
  blocked: boolean;
  /** Locked with a `no` that may still be corrected to `yes`. Payment only. */
  revisable: boolean;
  answer: "yes" | "no" | null;
  viaStage: boolean;
  value?: number;
  currency?: string;
  answeredAt?: number;
};

/**
 * The lead-quality panel (spec 2026-09-01-lead-quality-feedback-loop-design).
 *
 * Why it exists: the Meta lifecycle events beyond the automatic first touch
 * only fire when someone records a milestone, and an audit found staff did
 * not know the stage control in the thread header existed.
 *
 * Why it is a floating trigger rather than a strip above the composer: the
 * first build put one question inline in the footer, which crowded the
 * message area on every unanswered lead and read as another banner among
 * several. This sits beside the notes button — the affordance agents
 * already use for "record something about this lead" — and stays out of
 * the way until opened.
 *
 * ONE question at a time. The panel shows what has been answered and the
 * single question now open; nothing further is rendered until that one is
 * answered YES. An earlier build showed all of them at once and let an
 * agent answer in any order, which produced records that could not be true
 * together — "payment received" on a lead nobody had confirmed was real —
 * and let the deepest event fire without the cheaper signals that give Meta
 * the funnel shape.
 *
 * A `no` ends the sequence: every later question presupposes a yes before
 * it, so the panel stops asking rather than inviting a contradiction.
 *
 * A negative answer never reaches Meta — not by a check here, but because
 * `leadQuality.answer` has no code path from `no` to the conversion outbox.
 *
 * ANY `no` can be changed to `yes`, and never the reverse. Every judgement
 * here is provisional in a way a `yes` is not: the chat dismissed as junk
 * replies three days later, the service turns out to be available, the
 * unpaid deal pays. A `no` sent nothing, so correcting it contradicts
 * nothing Meta was told — it reports that milestone for the first time, and
 * re-opens the question after it. A `yes` already put an event on the wire
 * and Meta has no retraction, so it stays final. The server decides this
 * (`StepState.revisable` in convex/leadQuality.ts); the panel only renders
 * what it is told, so the two cannot drift.
 *
 * ORGANIC threads get the card too, and are told plainly that nothing is
 * reported for them. The answers are still worth having internally, and
 * nothing can leak: `seedStageConversionEvent` seeds an event only for a
 * conversation carrying an attribution.
 */
export function LeadQualityCard({
  conversationId,
}: {
  conversationId: Id<"conversations">;
}) {
  const t = useTranslations("Inbox.leadQuality");
  // The account default, same source the dashboard and settings read. Only
  // a DISPLAY hint and an explicit echo of what the server would pick
  // anyway — `leadQuality.answer` falls back to the account currency.
  const { defaultCurrency } = useAuth();
  const currency = defaultCurrency ?? "USD";

  const answer = useMutation(api.leadQuality.answer);
  const state = useQuery(api.leadQuality.getCardState, { conversationId });

  const [open, setOpen] = useState(false);
  /** Which step is showing its reason chips, if any. */
  const [reasonFor, setReasonFor] = useState<LeadQualityStep | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  if (!state) return null;
  const steps = state.steps as StepState[];

  const submit = async (args: {
    step: LeadQualityStep;
    answer: "yes" | "no";
    reason?: LeadQualityReason;
    value?: number;
  }) => {
    setBusy(true);
    try {
      const res = await answer({
        conversationId,
        step: args.step,
        answer: args.answer,
        ...(args.reason ? { reason: args.reason } : {}),
        ...(args.value !== undefined ? { value: args.value, currency } : {}),
      });
      // Only claim what actually happened. Saying "sent to Meta" for an
      // answer that produced no event would be a lie the agent cannot check.
      toast.success(res.sentToMeta ? t("sentToast") : t("savedToast"));
      setReasonFor(null);
      setAmount("");
    } catch {
      toast.error(t("error"));
    } finally {
      setBusy(false);
    }
  };

  // Counted from the steps themselves, NOT as `total - pendingCount`.
  // `pendingCount` is "how many answers are still owed", which is zero once
  // a `no` ends the sequence — deriving progress from it would report
  // "4/4 recorded" on a lead where exactly one question was ever answered.
  const answeredCount = steps.filter((s) => s.locked).length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Sits to the LEFT of the notes button (which owns bottom-4 right-4),
          so the two read as one row of thread actions rather than stacking. */}
      <PopoverTrigger
        aria-label={t("triggerLabel")}
        title={t("triggerLabel")}
        className={cn(
          "absolute bottom-4 right-[4.25rem] z-10 flex h-11 w-11 items-center",
          "justify-center rounded-full shadow-lg transition-colors",
          state.pendingCount > 0
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "bg-emerald-600 text-white hover:bg-emerald-700",
        )}
      >
        <Gauge className="h-5 w-5" />
        {/* Badge counts what is still OPEN, so a fully-answered lead shows
            no number and a green button rather than a nagging zero. */}
        {state.pendingCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
            {state.pendingCount}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent align="end" side="top" className="w-80 p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <p className="text-xs font-medium text-foreground">{t("title")}</p>
          <span className="text-[11px] text-muted-foreground">
            {t("progress", { done: answeredCount, total: steps.length })}
          </span>
        </div>

        <div className="space-y-2">
          {/* Answered steps, plus the ONE that is open. `blocked` steps are
              not rendered at all — showing a greyed-out question an agent
              cannot reach reads as a broken control rather than as a
              sequence. */}
          {steps
            .filter((s) => s.locked || s.available)
            .map((s) => (
            <StepRow
              key={s.step}
              state={s}
              currency={currency}
              canAnswer={state.canAnswer}
              busy={busy}
              showReasons={reasonFor === s.step}
              amount={amount}
              onAmount={setAmount}
              onOpenReasons={() => setReasonFor(s.step)}
              onCancelReasons={() => setReasonFor(null)}
              onSubmit={submit}
              t={t}
            />
            ))}
          {/* The sequence has stopped: a `no` was recorded and nothing
              further applies. Said plainly so the empty panel is not read
              as a bug. */}
          {steps.some((s) => s.blocked) &&
            !steps.some((s) => s.available) &&
            !steps.some((s) => s.revisable && state.canAnswer) && (
              <p className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground">
                {t("sequenceEnded")}
              </p>
            )}
        </div>

        <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
          {/* An organic lead has no ad click behind it, so no answer here
              can reach Meta. Said outright rather than left to look
              identical to an attributed lead — an agent who believes these
              answers are tuning ad delivery would be wrong. */}
          {state.attributed ? t("footnote") : t("footnoteOrganic")}
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** One question: unanswered (actionable) or locked (recorded). */
function StepRow({
  state,
  currency,
  canAnswer,
  busy,
  showReasons,
  amount,
  onAmount,
  onOpenReasons,
  onCancelReasons,
  onSubmit,
  t,
}: {
  state: StepState;
  currency: string;
  canAnswer: boolean;
  busy: boolean;
  showReasons: boolean;
  amount: string;
  onAmount: (v: string) => void;
  onOpenReasons: () => void;
  onCancelReasons: () => void;
  onSubmit: (a: {
    step: LeadQualityStep;
    answer: "yes" | "no";
    reason?: LeadQualityReason;
    value?: number;
  }) => void | Promise<void>;
  t: ReturnType<typeof useTranslations>;
}) {
  const [showAmount, setShowAmount] = useState(false);

  // Colour carries the state at a glance: green = recorded yes (and, for an
  // attributed lead, reported to Meta), muted red = recorded no (kept for
  // reporting, never sent), plain = still open.
  const tone = !state.locked
    ? "border-border bg-background"
    : state.answer === "yes"
      ? "border-emerald-600/40 bg-emerald-600/10"
      : "border-destructive/30 bg-destructive/5";

  return (
    <div className={cn("rounded-md border px-2.5 py-2", tone)}>
      <p className="text-xs font-medium text-foreground">
        {t(`question.${state.step}`)}
      </p>

      {state.locked ? (
        <>
          <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Check className="h-3 w-3 shrink-0" />
            {state.answer === "yes"
              ? state.value !== undefined
                ? t("recordedYesValue", {
                    value: state.value,
                    currency: state.currency ?? currency,
                  })
                : t("recordedYes")
              : t("recordedNo")}
            {/* An implied lock had no author — say so rather than implying
                somebody answered this question here. */}
            {state.viaStage ? ` · ${t("fromStage")}` : ""}
          </p>
          {/* The one correction this card allows: money that arrived after
              the question was answered. Rendered on the server's say-so
              (`revisable`), never inferred from the step name here, so the
              panel cannot offer a button the mutation would refuse. */}
          {state.revisable && canAnswer ? (
            showAmount ? (
              <AmountEntry
                currency={currency}
                amount={amount}
                onAmount={onAmount}
                busy={busy}
                onConfirm={() =>
                  void onSubmit({
                    step: state.step,
                    answer: "yes",
                    value: Number(amount),
                  })
                }
                onCancel={() => setShowAmount(false)}
                t={t}
              />
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="mt-1.5 h-7 w-full text-[11px]"
                disabled={busy}
                onClick={() => {
                  // Only payment carries money. Opening the amount field
                  // for the others would demand a figure that has no
                  // meaning for "actually a real customer" — and the Save
                  // button stays disabled until one is typed, so the
                  // correction would be unreachable.
                  if (state.step === "payment") {
                    setShowAmount(true);
                    return;
                  }
                  void onSubmit({ step: state.step, answer: "yes" });
                }}
              >
                {t(`revise.${state.step}`)}
              </Button>
            )
          ) : null}
        </>
      ) : !canAnswer ? (
        <p className="mt-1 text-[11px] text-muted-foreground">{t("readOnly")}</p>
      ) : showReasons ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {LEAD_QUALITY_REASONS.map((r) => (
            <button
              key={r}
              type="button"
              disabled={busy}
              onClick={() =>
                void onSubmit({ step: state.step, answer: "no", reason: r })
              }
              className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
            >
              {t(`reason.${r}`)}
            </button>
          ))}
          <button
            type="button"
            onClick={onCancelReasons}
            className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : showAmount ? (
        <AmountEntry
          currency={currency}
          amount={amount}
          onAmount={onAmount}
          busy={busy}
          onConfirm={() =>
            void onSubmit({
              step: state.step,
              answer: "yes",
              value: Number(amount),
            })
          }
          onCancel={() => setShowAmount(false)}
          t={t}
        />
      ) : (
        <div className="mt-1.5 flex gap-1.5">
          <Button
            size="sm"
            className="h-7 flex-1 text-[11px]"
            disabled={busy}
            onClick={() => {
              if (state.step === "payment") {
                setShowAmount(true);
                return;
              }
              void onSubmit({ step: state.step, answer: "yes" });
            }}
          >
            {t("yes")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 flex-1 text-[11px]"
            disabled={busy}
            onClick={() => {
              // Only the first question asks why — its `no` is a verdict on
              // the lead. A `no` later just means "not this one".
              if (state.step === "genuine") {
                onOpenReasons();
                return;
              }
              void onSubmit({ step: state.step, answer: "no" });
            }}
          >
            {t("no")}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The amount field behind every `Purchase`.
 *
 * Shared by the two paths that can record one — answering payment for the
 * first time, and correcting an earlier `no` — because they must ask for
 * the same thing in the same way. A separate copy for the correction is how
 * the two drift, and the amount is not cosmetic: `seedStageConversionEvent`
 * refuses a valueless `purchased`, so a path that forgot to collect it
 * would fail at the server instead of at the field.
 */
function AmountEntry({
  currency,
  amount,
  onAmount,
  busy,
  onConfirm,
  onCancel,
  t,
}: {
  currency: string;
  amount: string;
  onAmount: (v: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{currency}</span>
      <Input
        autoFocus
        inputMode="decimal"
        value={amount}
        onChange={(e) => onAmount(e.target.value)}
        className="h-7 w-24 text-xs"
      />
      <Button
        size="sm"
        className="h-7 px-2 text-[11px]"
        disabled={busy || !(Number(amount) > 0)}
        onClick={onConfirm}
      >
        {t("confirm")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-[11px]"
        onClick={onCancel}
      >
        {t("cancel")}
      </Button>
    </div>
  );
}
