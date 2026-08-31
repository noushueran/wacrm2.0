// Pure helpers for the voice-transcription eval harness. No network, no fs.
// Faithful re-implementations of logic in convex/lib/ai/media.ts and
// convex/lib/r2/url.ts (an .mjs script cannot import the TS sources) — if those
// change, change these to match. See the plan's "Faithful mirrors" constraint.

/** Mirror of SCRIPT_PATTERNS in convex/lib/ai/media.ts. Only the scripts that
 *  matter for the Malayalam→Tamil question plus the known hallucination
 *  signatures; a character outside every pattern counts toward nothing. */
const SCRIPT_PATTERNS = {
  latin: /[A-Za-zÀ-ɏ]/g,
  malayalam: /[ഀ-ൿ]/g,
  devanagari: /[ऀ-ॿ]/g,
  arabic: /[؀-ۿݐ-ݿ]/g,
  tamil: /[஀-௿]/g,
  telugu: /[ఀ-౿]/g,
  kannada: /[ಀ-೿]/g,
  bengali: /[ঀ-৿]/g,
  sinhala: /[඀-෿]/g,
  cyrillic: /[Ѐ-ӿ]/g,
  greek: /[Ͱ-Ͽ]/g,
  hebrew: /[֐-׿]/g,
  thai: /[฀-๿]/g,
  han: /[一-鿿]/g,
  hangul: /[가-힯]/g,
  kana: /[぀-ヿ]/g,
};

/** The script most of `text` is written in, or null when it carries no letters.
 *  Mirror of dominantScript in convex/lib/ai/media.ts — this is the measurement
 *  that answers "did blind language-ID drift to Tamil?" WITHOUT needing a human
 *  reference transcript. */
export function dominantScript(text) {
  let best = null;
  let bestCount = 0;
  for (const [script, pattern] of Object.entries(SCRIPT_PATTERNS)) {
    const count = (text ?? "").match(pattern)?.length ?? 0;
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best;
}

/** Mirror of AUDIO_EXT_BY_CONTENT_TYPE in convex/lib/ai/media.ts. */
const AUDIO_EXT_BY_CONTENT_TYPE = {
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

/** Extension OpenAI keys format detection on. Mirror of media.ts. */
export function extForContentType(contentType) {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  return AUDIO_EXT_BY_CONTENT_TYPE[base] ?? "ogg";
}

/** Build a public, fetchable R2 URL from a media key. Mirror of publicUrl in
 *  convex/lib/r2/url.ts, tolerant of a scheme-less host. */
export function publicUrl(host, key) {
  const withScheme = /^https?:\/\//.test(host) ? host : `https://${host}`;
  const trimmed = withScheme.replace(/\/+$/, "");
  const encoded = key.split("/").map(encodeURIComponent).join("/");
  return `${trimmed}/${encoded}`;
}

/** Normalize for error-rate scoring: NFC, lowercase, strip punctuation (keeping
 *  letters/marks/numbers of ANY script, incl. Malayalam), collapse whitespace.
 *  Zero-width format characters (category Cf — ZWJ U+200D, ZWNJ U+200C, etc.)
 *  are DELETED rather than turned into spaces: Malayalam chillu letters are
 *  commonly encoded as consonant + virama + ZWJ, so replacing the ZWJ with a
 *  space would split one word into two and corrupt wer()/cer(). */
export function normalize(s) {
  return (s ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/\p{Cf}/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein edit distance between two token arrays. */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/** Word error rate over normalized whitespace tokens. Empty reference → 0 if
 *  hypothesis is also empty, else 1 (every hyp word is an insertion). */
export function wer(reference, hypothesis) {
  const ref = normalize(reference).split(" ").filter(Boolean);
  const hyp = normalize(hypothesis).split(" ").filter(Boolean);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return editDistance(ref, hyp) / ref.length;
}

/** Character error rate (spaces removed — script-agnostic, better than WER for
 *  agglutinative Malayalam). Same empty-reference convention as wer. */
export function cer(reference, hypothesis) {
  const ref = [...normalize(reference).replace(/ /g, "")];
  const hyp = [...normalize(hypothesis).replace(/ /g, "")];
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return editDistance(ref, hyp) / ref.length;
}

/** Mean of the numeric token logprobs, or null when none are present
 *  (fail-open signal — mirror of the guard in media.ts). */
export function meanLogprob(logprobs) {
  const nums = (logprobs ?? [])
    .map((l) => (typeof l?.logprob === "number" ? l.logprob : null))
    .filter((n) => n !== null);
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// --- silence-guard thresholds (mirror convex/lib/ai/media.ts) ---
export const DEFAULT_MIN_AVG_LOGPROB = -1.0;
export const NO_SPEECH_PROB_THRESHOLD = 0.6;

/** From newest-first message rows, keep audio rows with a fetchable ref, capped
 *  at `want`. (`convex data --order desc` already yields newest-first.) */
export function selectAudioRows(rows, want) {
  const audio = rows.filter(
    (r) => r?.contentType === "audio" && (r.mediaKey || r.mediaUrl),
  );
  return audio.slice(0, want);
}

/** Build a blank-annotation manifest entry from a message row. */
export function manifestEntry(row) {
  const id = String(row._id);
  return {
    id,
    file: `${id}.${extForContentType(row.contentType)}`,
    contentType: row.contentType ?? null,
    caption: row.caption ?? null,
    reference: "",
    lang: "",
    silent: false,
  };
}

/** Merge fresh entries into an existing manifest, keyed by id, NEVER clobbering
 *  an existing (possibly annotated) entry. */
export function mergeManifest(existing, fresh) {
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const entry of fresh) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/** Clips ready to score: a silent-labeled clip, or one with a typed reference. */
export function annotatedClips(manifest) {
  return manifest.filter(
    (e) => e.silent === true || (e.reference ?? "").trim() !== "",
  );
}

/** gpt-4o silence verdict. Fail-open: null mean → KEEP (mirror media.ts). */
export function gptVerdict(mean, threshold = DEFAULT_MIN_AVG_LOGPROB) {
  if (typeof mean !== "number") return "KEEP";
  return mean < threshold ? "DROP" : "KEEP";
}

/** whisper silence verdict. Fail-open: no segments → KEEP (mirror media.ts). */
export function whisperVerdict(segments, threshold = NO_SPEECH_PROB_THRESHOLD) {
  if (!Array.isArray(segments) || segments.length === 0) return "KEEP";
  const allSilent = segments.every(
    (s) => typeof s?.no_speech_prob === "number" && s.no_speech_prob > threshold,
  );
  return allSilent ? "DROP" : "KEEP";
}

/** Score one clip against its reference: WER/CER per model, gpt mean logprob,
 *  and the KEEP/DROP verdict each model's silence guard would return. */
export function scoreClip(clip, threshold = DEFAULT_MIN_AVG_LOGPROB) {
  const gptMeanLP = meanLogprob(clip.gptLogprobs);
  return {
    id: clip.id,
    lang: clip.lang || "other",
    silent: clip.silent === true,
    whisperWer: wer(clip.reference, clip.whisperText),
    whisperCer: cer(clip.reference, clip.whisperText),
    gptWer: wer(clip.reference, clip.gptText),
    gptCer: cer(clip.reference, clip.gptText),
    gptMeanLP,
    whisperVerdict: whisperVerdict(clip.whisperSegments),
    gptVerdict: gptVerdict(gptMeanLP, threshold),
  };
}

/** Aggregate scored clips: per-language mean WER/CER over speech clips, plus a
 *  calibration view of gpt mean-logprob for speech vs silence against the live
 *  threshold (false drops/keeps, and a suggested separating threshold). */
export function summarize(scored, threshold = DEFAULT_MIN_AVG_LOGPROB) {
  const speech = scored.filter((s) => !s.silent);
  const silent = scored.filter((s) => s.silent);

  const perLang = {};
  for (const s of speech) {
    const g = (perLang[s.lang] ??= {
      n: 0, whisperWer: 0, whisperCer: 0, gptWer: 0, gptCer: 0,
    });
    g.n += 1;
    g.whisperWer += s.whisperWer;
    g.whisperCer += s.whisperCer;
    g.gptWer += s.gptWer;
    g.gptCer += s.gptCer;
  }
  for (const g of Object.values(perLang)) {
    g.whisperWer /= g.n;
    g.whisperCer /= g.n;
    g.gptWer /= g.n;
    g.gptCer /= g.n;
  }

  const speechLPs = speech.map((s) => s.gptMeanLP).filter((n) => typeof n === "number");
  const silentLPs = silent.map((s) => s.gptMeanLP).filter((n) => typeof n === "number");
  const falseDrops = speech.filter((s) => s.gptVerdict === "DROP").map((s) => s.id);
  const falseKeeps = silent.filter((s) => s.gptVerdict === "KEEP").map((s) => s.id);

  let suggestedThreshold = null;
  if (speechLPs.length && silentLPs.length) {
    const maxSilent = Math.max(...silentLPs);
    const minSpeech = Math.min(...speechLPs);
    if (maxSilent < minSpeech) suggestedThreshold = (maxSilent + minSpeech) / 2;
  }

  return {
    perLang,
    calibration: { speechLPs, silentLPs, falseDrops, falseKeeps, suggestedThreshold },
    threshold,
  };
}
