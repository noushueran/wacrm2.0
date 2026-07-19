// ============================================================
// Reply pacing — how long the auto-reply waits before generating, and
// how long the generated text then "types" before it lands.
//
// Split out of `defaults.ts` (which owns the prompt scaffold) because
// everything here is pure arithmetic and carries a dense unit suite.
//
// Two Meta constraints shape this file, both verified against their
// docs rather than assumed:
//   1. There is NO inbound typing/composing webhook. "Wait until the
//      customer stops typing" is unbuildable — silence is the only
//      evidence a thought is finished, so the debounce window is a
//      guess made from message SHAPE.
//   2. The typing indicator auto-dismisses after 25s, with no
//      documented way to refresh it. `DEFAULT_TYPING_MAX_MS` /
//      `TYPING_CEILING_MS` below bound only the ARTIFICIAL wait this
//      module adds AFTER generation finishes (`deliveryDelayMs`'s
//      clamped target) — NOT the total time to reply. Actual
//      time-to-reply is `max(debounce + generation, target)`, and
//      generation time is bounded elsewhere entirely (the caller's own
//      `AI_REQUEST_TIMEOUT_MS`, default 30s) — this file has no say
//      over it. A generation call — including any media
//      transcription/description ahead of it — that runs past roughly
//      19s will make the total outlive Meta's 25s indicator regardless
//      of anything this module does; keeping `target` itself under
//      ~20s only avoids ADDING to that risk on top of a fast
//      generation, it does not remove it.
// ============================================================

const DEFAULT_DEBOUNCE_BASE_MS = 3_000;
const DEFAULT_DEBOUNCE_FAST_MS = 2_000;
const DEFAULT_DEBOUNCE_SLOW_MS = 6_000;

const DEFAULT_TYPING_CHARS_PER_SEC = 18;
const DEFAULT_TYPING_JITTER = 0.25;
const DEFAULT_TYPING_MIN_MS = 3_000;
const DEFAULT_TYPING_MAX_MS = 15_000;

/** Absolute upper bound on the delivery target, regardless of env
 *  configuration. Meta auto-dismisses the typing indicator at 25s with no
 *  documented refresh, so a larger value would leave the customer watching
 *  "typing…" vanish into silence — the exact failure this module exists to
 *  avoid. Env may lower the max, never raise it past this. */
const TYPING_CEILING_MS = 20_000;

/** Terminal punctuation across the languages this CRM actually serves
 *  (Latin, Arabic, CJK) — a message ending in one reads as finished. */
const TERMINAL_PUNCTUATION = /[.!?。！？؟…]$/u;

/** Below this, an unpunctuated message is almost certainly a fragment
 *  with its follow-up already being typed ("hi", "how much", "I want"). */
const FRAGMENT_MAX_LENGTH = 15;

/** Above this, a message is a finished thought even unpunctuated —
 *  nobody types 40 characters as the first half of a sentence. */
const COMPLETE_MIN_LENGTH = 40;

export type MessageShape = "complete" | "fragment" | "neutral";

/** Convex reads `process.env` per-call, never at module scope. */
function envNumber(name: string, fallback: number, floor: boolean): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return floor ? Math.floor(raw) : raw;
}

export function classifyMessageShape(text: string | null | undefined): MessageShape {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "neutral";
  if (TERMINAL_PUNCTUATION.test(trimmed)) return "complete";
  if (trimmed.length > COMPLETE_MIN_LENGTH) return "complete";
  if (trimmed.length < FRAGMENT_MAX_LENGTH) return "fragment";
  return "neutral";
}

/**
 * How long to wait after this inbound before generating a reply. The
 * burst-coalescing itself is unchanged and lives in `aiReply.ts`: each
 * inbound schedules its own dispatch, and an older dispatch stands down
 * when its trigger is no longer the newest message. This function only
 * decides how long we listen before concluding they're done.
 */
export function debounceMsForText(text: string | null | undefined): number {
  const base = envNumber("AI_REPLY_DEBOUNCE_MS", DEFAULT_DEBOUNCE_BASE_MS, true);
  // `0` is the documented kill switch (restores immediate dispatch) and
  // must silence EVERY tier, not just the neutral one.
  if (base === 0) return 0;
  switch (classifyMessageShape(text)) {
    case "complete":
      return envNumber("AI_REPLY_DEBOUNCE_FAST_MS", DEFAULT_DEBOUNCE_FAST_MS, true);
    case "fragment":
      return envNumber("AI_REPLY_DEBOUNCE_SLOW_MS", DEFAULT_DEBOUNCE_SLOW_MS, true);
    case "neutral":
      return base;
  }
}

/**
 * How much longer to hold a finished reply so it lands at a human pace.
 *
 * `elapsedMs` is time since the INBOUND arrived, not since generation
 * started — so the LLM's think time is absorbed into the typing window
 * rather than stacked on top of it. Slow generation yields a short
 * artificial wait, fast generation a longer one, and the customer
 * experiences the same rhythm either way.
 *
 * Jitter matters for its own sake: a bot replying in exactly 3.0s every
 * time is detectable precisely BECAUSE it is consistent.
 *
 * `random` is injectable purely so the suite can pin the jitter.
 */
export function deliveryDelayMs(args: {
  replyLength: number;
  elapsedMs: number;
  random?: () => number;
}): number {
  const { replyLength, elapsedMs, random = Math.random } = args;

  const charsPerSec =
    envNumber("AI_TYPING_CHARS_PER_SEC", DEFAULT_TYPING_CHARS_PER_SEC, false) ||
    DEFAULT_TYPING_CHARS_PER_SEC;
  const jitter = envNumber("AI_TYPING_JITTER", DEFAULT_TYPING_JITTER, false);
  const minMs = envNumber("AI_TYPING_MIN_MS", DEFAULT_TYPING_MIN_MS, true);
  const maxMs = Math.min(
    TYPING_CEILING_MS,
    envNumber("AI_TYPING_MAX_MS", DEFAULT_TYPING_MAX_MS, true),
  );

  const baseMs = (Math.max(0, replyLength) / charsPerSec) * 1_000;
  // random() ∈ [0,1) → factor ∈ [1-jitter, 1+jitter)
  const jittered = baseMs * (1 + (random() * 2 - 1) * jitter);
  const target = Math.min(maxMs, Math.max(minMs, jittered));
  return Math.max(0, Math.round(target - elapsedMs));
}
