"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Below this many characters a transcript cannot fill three clamped
 * lines at the bubble's width, so a toggle would be pure noise.
 *
 * Measured against the real geometry, not guessed: the bubble is
 * `max-w-[75%]` with `min-w-0`, and at `text-xs` on a wide desktop
 * thread pane three clamped lines hold roughly 300+ characters. A
 * 20-30 second voice note routinely lands in that range, so this is
 * the common case, not an edge to round down for.
 *
 * A character count is a deliberate approximation: measuring real
 * overflow needs `scrollHeight` from a live DOM, and this repo has no
 * jsdom to test that with. Given that approximation, err HIGH. The two
 * ways to be wrong are not symmetric:
 *   - too high: the text simply renders in full across a few extra
 *     lines — harmless.
 *   - too low: the toggle appears and clicking "Show more" produces
 *     zero visible change — reads as a bug, not a rounding error.
 * Resist tuning this back down without re-measuring the real layout.
 * Whatever this number is, `line-clamp` below and the toggle share the
 * same `canOverflow` boolean, so text can never be clamped without an
 * escape hatch to read the rest.
 */
const OVERFLOW_THRESHOLD = 300;

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
      {/* `break-words` is load-bearing, not decoration: `line-clamp`
          brings no word-breaking of its own, and a transcript can carry
          one unbroken run — a URL, a spelled-out email, a PNR or a long
          phone number are all ordinary in a travel voice note. Without
          it that run overflows the bubble sideways, the same failure
          class as issue #165. Every other `whitespace-pre-wrap` in
          `message-bubble.tsx` pairs the two for exactly this reason. */}
      <p
        className={cn(
          "mt-1 whitespace-pre-wrap break-words text-xs opacity-80",
          canOverflow && !expanded && "line-clamp-3",
        )}
      >
        {text}
      </p>
      {canOverflow && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-0.5 text-[10px] underline opacity-70 hover:opacity-100"
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  );
}
