"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Below this many characters a transcript cannot fill three clamped
 * lines at the bubble's width, so a toggle would be pure noise.
 *
 * A character count is a deliberate approximation: measuring real
 * overflow needs `scrollHeight` from a live DOM, and this repo has no
 * jsdom to test that with. Being slightly wrong here costs a visible
 * "Show more" that expands to nothing — cheap, and testable as a pure
 * function of the text.
 */
const OVERFLOW_THRESHOLD = 180;

interface VoiceTranscriptProps {
  /** The transcript itself. Callers guard against empty strings. */
  text: string;
  /**
   * Already-translated strings. This component deliberately takes no
   * i18n context so it can be rendered in a test without a NextIntl
   * provider — see the note in its test file.
   */
  label: string;
  labelTitle: string;
  moreLabel: string;
  lessLabel: string;
}

/**
 * Whisper's transcript of an inbound voice note, shown under the
 * player so a thread can be read rather than listened to.
 *
 * Collapsed to three lines by default so a long note cannot swamp the
 * conversation. Marked as machine-generated on purpose: Whisper
 * mis-hears, and this text must never read as verbatim customer
 * speech.
 */
export function VoiceTranscript({
  text,
  label,
  labelTitle,
  moreLabel,
  lessLabel,
}: VoiceTranscriptProps) {
  const [expanded, setExpanded] = useState(false);
  const canOverflow = text.length > OVERFLOW_THRESHOLD;

  return (
    <div className="mt-1.5 border-t border-current/10 pt-1.5">
      <span
        className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide opacity-70"
        title={labelTitle}
      >
        <Sparkles className="h-2.5 w-2.5" />
        {label}
      </span>
      <p
        className={cn(
          "mt-1 whitespace-pre-wrap text-xs opacity-80",
          canOverflow && !expanded && "line-clamp-3",
        )}
      >
        {text}
      </p>
      {canOverflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 text-[10px] underline opacity-70 hover:opacity-100"
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  );
}
