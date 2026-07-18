// ============================================================
// Pure lead-source helpers — relocated out of the old `convex/attribution.ts`
// (Task B5) when that module's Convex functions
// (recordSignal/getSignal/patchResult/sendSignal/getPendingToRetry/
// retryPending/listConversions) were deleted as dead code: ingest was
// rewired to `conversionEvents` (funnel Phase 1) and the retry cron was
// removed, so nothing called them anymore. These two helpers are still
// live — `ingest.ts` uses them to classify an inbound message's lead
// source before calling `conversionEvents.seedNewLead` — so they moved
// here rather than being deleted with the rest of the file.
// ============================================================

// Compact invisible reference code — a shared wire format with the landing site
// (go-holidayys `src/lib/tracking/hidden-code.ts`, which keeps an IDENTICAL codec).
// The code is 6 Crockford base32 chars, encoded DIRECTLY as 30 bits — 5 bits per
// char, MSB first — into ZWSP (U+200B) = 0 / ZWNJ (U+200C) = 1, anchored right after
// the first word of the message. 30 hidden chars carry the whole code (down from 72
// for the old "HY-XXXXXX" ASCII form), so there's far less to lose on an edit.
// Survival through WhatsApp → Meta Cloud API → this CRM verified live 2026-07-13.
// Only ZWSP/ZWNJ are used (the two most universally preserved).
const ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTVWXYZ".replace(/[ILOU]/g, "");
const CODE_LEN = 6;
const BITS = CODE_LEN * 5; // 30
const ZW_ZERO = "​"; // ZWSP → 0
const ZW_ONE = "‌"; // ZWNJ → 1

/** Decode the invisible reference code out of a message body: read the FIRST 30
 *  zero-width bits (5 bits/char) into the 6-char base32 code. Null when fewer than a
 *  full code of hidden bits are present. Only ZWSP/ZWNJ are read. */
export function decodeHidden(text: string): string | null {
  const bits = Array.from(text)
    .filter((c) => c === ZW_ZERO || c === ZW_ONE)
    .map((c) => (c === ZW_ZERO ? "0" : "1"))
    .join("");
  if (bits.length < BITS) {
    return null;
  }
  let code = "";
  for (let i = 0; i < BITS; i += 5) {
    code += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  return code;
}

/**
 * The reference code carried by an inbound message — decoded from the invisible
 * zero-width block ONLY (invisible-only; no visible fallback). Null when no full
 * hidden code is present.
 */
export function extractRefCode(text: string | undefined | null): string | null {
  if (!text) {
    return null;
  }
  return decodeHidden(text);
}

export function extractCtwaClid(msg: { ctwaClid?: string }): string | null {
  return msg.ctwaClid ?? null;
}
