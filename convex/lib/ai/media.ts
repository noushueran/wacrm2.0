import { aiRequestTimeoutMs, supportsReasoningEffort } from "./defaults";

// ============================================================
// Media understanding — inbound voice notes and images (owner
// requirement 2026-07-18: "listen" to voice notes via transcription and
// "read" images via a vision description, then reply in TEXT; the bot
// never sends voice or generated images back). Both helpers are thin
// OpenAI network clients in the style of `providers/openai.ts` (plain
// fetch, `AbortSignal.timeout`, fine in Convex's default runtime) and
// deliberately return `null` on ANY failure — a media row that can't be
// understood simply keeps its placeholder ("[voice note]"), it must
// never block the reply. Called from `aiReply.dispatchInbound` (the
// WhatsApp path) and from the /agents Playground action; never in
// DRY-RUN (that path substitutes a synthetic transcript).
//
// Key selection lives with the caller: the account's own OpenAI key
// when `provider === "openai"`, else the (also-OpenAI) embeddings key —
// Anthropic has no transcription endpoint, so an Anthropic-only account
// gracefully skips media understanding altogether.
//
// Both models are PINNED here rather than following the account's
// configured chat model, and are env-overridable so a model-ID churn
// doesn't need a code deploy. See `describeModel()` for why the vision
// model in particular is no longer taken from `aiConfigs.model`.
// ============================================================

const OPENAI_BASE = "https://api.openai.com/v1";

/** Default speech-to-text model. `gpt-4o-transcribe` supersedes
 *  `whisper-1` with a materially lower word-error rate and much better
 *  accent / noisy-environment / multilingual handling — which is the
 *  whole job here, since customers send voice notes recorded on the
 *  street in Arabic, Hindi, Malayalam and English.
 *
 *  Rollback: set `AI_TRANSCRIBE_MODEL=whisper-1`. The silence guard
 *  below follows the model — see `supportsLogprobs`. */
export const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-transcribe";

/** Default vision model for describing a customer-sent image. Luna is
 *  the cost-efficient tier of the current GPT-5.6 generation — the task
 *  is a 1-2 sentence description, so the flagship tier would be spend
 *  with no quality return. Override to `gpt-5.6-terra`/`gpt-5.6-sol`
 *  via `AI_DESCRIBE_MODEL` if document/screenshot reading needs it. */
export const DEFAULT_DESCRIBE_MODEL = "gpt-5.6-luna";

/** Transcription model. Override with `AI_TRANSCRIBE_MODEL`. */
export function transcribeModel(): string {
  return process.env.AI_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL;
}

/**
 * Vision model. Override with `AI_DESCRIBE_MODEL`.
 *
 * Deliberately PINNED rather than reusing `aiConfigs.model` (which is
 * what this used to do when `provider === "openai"`). Three reasons:
 *   1. `aiConfigs.model` is free text in the settings form — nothing
 *      validates it is vision-capable, and `describeImageFromUrl`
 *      swallows the resulting 400, so a non-vision chat model meant
 *      images silently never got described.
 *   2. Reply quality and image-reading cost are separate concerns; the
 *      account shouldn't have to pay flagship rates on every image just
 *      because it wants a strong model writing replies.
 *   3. The `reasoning_effort` we send below is only valid on reasoning
 *      models — safe to send precisely because we control the ID.
 */
export function describeModel(): string {
  return process.env.AI_DESCRIBE_MODEL?.trim() || DEFAULT_DESCRIBE_MODEL;
}

/** GPT-5+ / o-series take `reasoning_effort`; older chat models reject
 *  unknown args with a 400. Gate on the ID so an `AI_DESCRIBE_MODEL`
 *  override pointing at (say) `gpt-4o-mini` still works.
 *
 *  The implementation moved to `defaults.ts` when the chat path needed
 *  the same guard; re-exported here so this module's own callers and
 *  `media.test.ts` keep importing it from where it has always lived. */
export { supportsReasoningEffort };

/**
 * Which silence-guard signal a transcription model can give us.
 *
 * The two families are mutually exclusive, and getting this wrong
 * silently kills transcription:
 *   - `whisper-1` supports `verbose_json` and reports per-segment
 *     `no_speech_prob`, but does NOT support `logprobs`.
 *   - the `gpt-4o-*-transcribe` family supports ONLY `response_format:
 *     "json"` (no `verbose_json`, so no segments) and returns token
 *     `logprobs` when asked via `include[]`.
 * Sending the wrong pair 400s, and `transcribeAudioFromUrl` turns every
 * failure into `null` — i.e. every voice note stops transcribing with
 * no visible error.
 */
export function supportsLogprobs(model: string): boolean {
  return /transcribe/.test(model) && !/diarize/.test(model);
}

/** Whisper reports, per segment, how confident it is that the audio contains
 *  no speech. Real speech sits well below 0.1; the boilerplate Whisper
 *  hallucinates over silence ("subscribe to my channel", etc.) sits far
 *  above this. Only reachable on the `whisper-1` rollback path. */
const NO_SPEECH_PROB_THRESHOLD = 0.6;

/** Mean token logprob below which a `gpt-4o-transcribe` result is treated
 *  as hallucinated-over-silence rather than speech — the logprobs-era
 *  replacement for `NO_SPEECH_PROB_THRESHOLD`.
 *
 *  RE-CALIBRATED 2026-07-25 (second pass) after the first value shipped
 *  and broke the Playground: every voice note came back "Couldn't
 *  transcribe this". The first calibration used 10 WhatsApp voice notes
 *  and found real speech at -0.05…-0.65 vs silence at -1.86, which made
 *  -1.0 look like a clean gap. It was not: those were long, clean
 *  recordings. Replaying the owner's OWN 14 browser recordings through
 *  the deployed path gave real speech at -0.06…-1.16 — mean logprob
 *  falls as utterances get shorter and more code-switched — so -1.0
 *  discarded 5 of 14 REAL customer messages (36%).
 *
 *  Everything measured, pooled:
 *      real speech        -0.06 … -1.16   (14 browser + 10 WhatsApp)
 *      garbled/ambiguous  -1.44
 *      hallucination      -1.74
 *      pure silence       -1.86
 *      room tone          -2.95
 *  -1.5 keeps every confirmed real message with 0.34 to spare and still
 *  drops the hallucination/silence cluster. Deliberately biased
 *  permissive, per this guard's own rule: a false positive DROPS A REAL
 *  CUSTOMER MESSAGE, which is worse than letting one hallucination
 *  through — and the script guard plus the reply-language policy in
 *  `buildSystemPrompt` are the second and third layers that catch what
 *  slips past. Tune with `AI_TRANSCRIBE_MIN_AVG_LOGPROB`. */
const DEFAULT_MIN_AVG_LOGPROB = -1.5;

function minAvgLogprob(): number {
  const raw = Number(process.env.AI_TRANSCRIBE_MIN_AVG_LOGPROB);
  return Number.isFinite(raw) ? raw : DEFAULT_MIN_AVG_LOGPROB;
}

// ============================================================
// Script guard — the LANGUAGE half of the hallucination problem.
//
// The logprob guard above only catches text the model is UNSURE of.
// Measured on real traffic (2026-07-25), the models also emit confident
// text in the wrong language entirely:
//   - silence  → `gpt-4o-transcribe` returned Polish ("Jak się masz?")
//                and German ("Dieses Haus ist alt.")
//   - a real Malayalam clip → `whisper-1` returned Kannada gibberish
// That matters far more here than a garbled word would, because the
// reply prompt is instructed to answer in the customer's language: a
// transcript in the wrong language produces a REPLY in a language the
// customer does not speak (the owner-reported symptom — Malayalam voice
// notes answered in Tamil and Russian).
//
// So: if the transcript's dominant script is not one this business
// plausibly receives, treat it as a hallucination and drop it. The
// caller then keeps the bare "[voice note]" placeholder, and the prompt
// already tells the bot to acknowledge a voice note it cannot hear —
// which is a far better failure than a fluent answer in Russian.
//
// This is a SCRIPT check, not a language check: it cannot catch a
// Latin-script hallucination (the Polish/German cases above). Those are
// caught on the reply side by the language policy in
// `buildSystemPrompt` — the two guards are complementary, deliberately.
// ============================================================

/** Unicode blocks per script, in the order we test them. Only scripts we
 *  either serve or have actually seen hallucinated are listed; anything
 *  outside every pattern simply doesn't count toward the tally. */
const SCRIPT_PATTERNS: Record<string, RegExp> = {
  latin: /[A-Za-zÀ-ɏ]/g,
  malayalam: /[ഀ-ൿ]/g,
  devanagari: /[ऀ-ॿ]/g,
  arabic: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g,
  tamil: /[஀-௿]/g,
  telugu: /[ఀ-౿]/g,
  kannada: /[ಀ-೿]/g,
  bengali: /[ঀ-৿]/g,
  gujarati: /[઀-૿]/g,
  gurmukhi: /[਀-੿]/g,
  sinhala: /[඀-෿]/g,
  cyrillic: /[Ѐ-ӿ]/g,
  greek: /[Ͱ-Ͽ]/g,
  hebrew: /[֐-׿]/g,
  thai: /[฀-๿]/g,
  han: /[一-鿿]/g,
  hangul: /[가-힯]/g,
  kana: /[぀-ヿ]/g,
};

/** Scripts a Dubai travel agency actually receives: English/Manglish/
 *  Hinglish/Tagalog (latin), Malayalam, Hindi (devanagari), Arabic +
 *  Urdu (arabic block), Tamil, and the other South-Asian scripts common
 *  in the UAE expat population. Everything omitted here — Cyrillic, Han,
 *  Hangul, Kana, Thai, Hebrew, Greek — is a hallucination signature.
 *  Override with `AI_TRANSCRIBE_ALLOWED_SCRIPTS` (comma-separated); set
 *  it to every key of `SCRIPT_PATTERNS` to disable this guard. */
const DEFAULT_ALLOWED_SCRIPTS = [
  "latin",
  "malayalam",
  "devanagari",
  "arabic",
  "tamil",
  "telugu",
  "kannada",
  "bengali",
  "gujarati",
  "gurmukhi",
  "sinhala",
];

/**
 * The script most of `text` is written in, or `null` when it carries no
 * letters at all (digits/punctuation only — no opinion, fail open).
 *
 * Counts characters rather than testing for presence, so the everyday
 * code-switching in this inbox reads correctly: "വിസ visa 299?" is
 * Malayalam with an English loanword, not a tie.
 */
export function dominantScript(text: string): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [script, pattern] of Object.entries(SCRIPT_PATTERNS)) {
    const count = text.match(pattern)?.length ?? 0;
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best;
}

// ============================================================
// Language rescue — the OWNER-REPORTED symptom (2026-07-25): Malayalam
// voice notes coming back answered in Tamil.
//
// `POST /v1/audio/transcriptions` takes an optional `language`
// (ISO-639-1), and OpenAI's own API reference states that supplying it
// "will improve accuracy and latency". We never sent it, so every clip
// ran blind language-ID — and Malayalam is close to the worst case for
// that: Whisper was trained on ~0.5 HOURS of Malayalam, scored >50% WER
// on it, and Malayalam is not in its supported-language list at all
// (openai/whisper#1019 — "Whisper is recognising Malayalam and outputing
// Tamil script"). Blind ID therefore lands on the nearest well-resourced
// Dravidian neighbour: Tamil, sometimes Kannada.
//
// The script guard above CANNOT fix this, and that is the whole reason
// this exists. This business genuinely serves Tamil and Hindi speakers,
// so `tamil`/`devanagari` are ALLOWED scripts — a mis-transcribed
// Malayalam note sails straight through it and becomes a fluent Tamil
// reply. The ambiguity is only still resolvable at the request.
//
// MEASURED 2026-07-25 on 27 real inbound clips (scripts/voice-eval).
// The eval settled two things, one of which killed the original plan:
//
//   1. The drift is a whisper-1 defect, and the MODEL UPGRADE is the fix.
//      On the six clips gpt-4o-transcribe reads as Malayalam, whisper-1
//      returned Tamil on three and Kannada on three. gpt-4o-transcribe
//      got all six right with NO language hint at all. That is the
//      owner-reported bug, reproduced and then fixed by the model swap.
//
//   2. `language` is ADVISORY on gpt-4o-transcribe, not binding — so the
//      rescue pass cannot do what it was designed to do. A genuinely
//      Tamil clip sent with `language=ml` came back in Tamil script, and
//      a near-silent clip came back in KOREAN. The parameter is received
//      (outputs do change) but it does not constrain the output script.
//      Worse, arbitration then fires on logprob noise: a forced pass
//      "won" on 15/27 clips while returning the very same script, and on
//      the silent clip it invented Korean the auto pass never produced.
//
// So the rescue is DEFAULT-OFF. The machinery is kept, not deleted,
// because `language` IS binding on whisper-1 (a seq2seq model with a
// real language token) — so `AI_TRANSCRIBE_LANGUAGES=ml` is a useful
// mitigation on the `AI_TRANSCRIBE_MODEL=whisper-1` rollback path, which
// is exactly the path that needs it. On the default model it would be
// cost and nondeterminism for no measured benefit.
// ============================================================

/** Languages to additionally try with an EXPLICIT `language=` hint,
 *  alongside the auto-detect pass. EMPTY by default — one transcription
 *  call per clip — because the eval above showed the hint does not bind
 *  on `gpt-4o-transcribe`. Set `AI_TRANSCRIBE_LANGUAGES=ml`
 *  (comma-separated ISO-639-1) when rolling back to `whisper-1`, where
 *  it does bind. */
const DEFAULT_RESCUE_LANGUAGES: string[] = [];

export function rescueLanguages(): string[] {
  const raw = process.env.AI_TRANSCRIBE_LANGUAGES;
  if (raw === undefined) return DEFAULT_RESCUE_LANGUAGES;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** How much better a forced pass must score before it displaces
 *  auto-detect. Zero means "strictly better" — auto-detect is the
 *  incumbent and keeps ties, so the rescue can only ever be an
 *  improvement. Raise it via `AI_TRANSCRIBE_RESCUE_MARGIN` if a forced
 *  pass is ever seen winning by a hair on a language that was fine. */
function rescueMargin(): number {
  const raw = Number(process.env.AI_TRANSCRIBE_RESCUE_MARGIN);
  return Number.isFinite(raw) ? raw : 0;
}

/** Whether a script from `dominantScript` is one we accept. */
export function isAllowedScript(script: string): boolean {
  const raw = process.env.AI_TRANSCRIBE_ALLOWED_SCRIPTS?.trim();
  const allowed = raw
    ? raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_ALLOWED_SCRIPTS;
  return allowed.includes(script);
}

// ============================================================
// Which understanding pass an inbound media row earns.
//
// Routes on the STORED OBJECT'S EXTENSION, not on `contentType` alone.
// `contentType` is Meta's envelope type and lies about the payload in
// the case that matters most here: WhatsApp's "send as document"
// preserves image quality instead of recompressing, so customers of a
// visa business routinely send passport scans as `document` with a JPEG
// body. Routing on the envelope would send that to a PDF parser; routing
// on the extension sends it to the vision model that can actually read
// it. `buildMediaKey` derives that extension from the real content type
// at storage time (`lib/r2/keys.ts`), so it is a faithful MIME proxy.
//
// Falls back to the envelope type when there is no usable extension —
// legacy rows carrying only a Convex-storage URL, and the `audio`/
// `image`/`video` envelopes that are unambiguous anyway.
// ============================================================

export type MediaUnderstanding = "transcribe" | "describe" | "pdf";

/** Envelope types that carry a fetchable file. `location` is excluded
 *  deliberately: it is in `AI_VISIBLE_MEDIA_TYPES` but carries its text
 *  inline (name/address/coords) and has no object to read. */
const UNDERSTANDABLE_TYPES = new Set(["audio", "image", "video", "document"]);

/** Extension → the pass that can read it. Video routes to `transcribe`:
 *  OpenAI's transcription endpoint accepts mp4/webm/mpeg containers and
 *  reads their audio track, which is where a clip's intent lives.
 *  Anything absent here (docx, xlsx, zip) earns no pass and keeps its
 *  placeholder — the prompt already handles that case. */
const EXT_UNDERSTANDING: Record<string, MediaUnderstanding> = {
  ogg: "transcribe",
  mp3: "transcribe",
  mpga: "transcribe",
  m4a: "transcribe",
  amr: "transcribe",
  wav: "transcribe",
  webm: "transcribe",
  mp4: "transcribe",
  mpeg: "transcribe",
  jpg: "describe",
  jpeg: "describe",
  png: "describe",
  webp: "describe",
  gif: "describe",
  pdf: "pdf",
};

/** Lowercase extension of a key or URL, or `null` when it has none.
 *  Query strings and fragments are stripped so a signed URL still
 *  resolves. */
function extensionOf(ref: { key?: string | null; url?: string | null }): string | null {
  const source = ref.key || ref.url || "";
  const basename = source.split(/[?#]/)[0].split("/").pop() ?? "";
  const dot = basename.lastIndexOf(".");
  // `> 0`, not `>= 0` — mirrors `extensionFor` in `lib/r2/keys.ts`, where
  // a leading-dot name is a dotfile rather than an extension.
  if (dot <= 0) return null;
  return basename.slice(dot + 1).toLowerCase();
}

export function understandingFor(
  contentType: string,
  ref: { key?: string | null; url?: string | null },
): MediaUnderstanding | null {
  if (!UNDERSTANDABLE_TYPES.has(contentType)) return null;
  const ext = extensionOf(ref);
  // A KNOWN extension is authoritative in both directions: it routes the
  // formats we can read, and it VETOES the ones we can't (3gp, mov, heic
  // — outside OpenAI's documented format lists). Falling back to the
  // envelope there would trade a preserved placeholder for a guaranteed
  // 400 that this module swallows into `null` anyway.
  if (ext !== null) return EXT_UNDERSTANDING[ext] ?? null;
  // No extension at all (legacy Convex-storage rows) — trust the
  // envelope where it is unambiguous. A `document` with nothing to go on
  // stays unread, which is what it was before this feature.
  if (contentType === "audio" || contentType === "video") return "transcribe";
  if (contentType === "image") return "describe";
  return null;
}

/** OpenAI keys audio-format detection on the upload filename's
 *  extension. WhatsApp voice notes are always OGG/Opus, but browser
 *  recordings (the /agents Playground) arrive as webm/mp4, so derive the
 *  extension from the media's own content type. Defaults to `ogg` so the
 *  WhatsApp path is byte-for-byte unchanged. */
const AUDIO_EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  // Video containers OpenAI's transcription endpoint decodes (it reads
  // their audio track). Without these a clip uploaded as `voice-note.ogg`
  // is rejected or misparsed — the endpoint keys format detection off the
  // filename, not the bytes.
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/mpeg": "mpeg",
};

export function audioUploadFilename(contentType: string | null): string {
  const base = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = AUDIO_EXT_BY_CONTENT_TYPE[base] ?? "ogg";
  return `voice-note.${ext}`;
}

/** Vision-call output cap. Generous relative to the 1-2 sentences we
 *  ask for (~60 tokens) because on a reasoning model this budget is
 *  shared with reasoning tokens, and a response that runs out mid-think
 *  comes back with EMPTY content rather than an error. We also send
 *  `reasoning_effort: "none"`, so this is belt-and-braces. */
const DESCRIBE_MAX_TOKENS = 500;

/** Surface a failed media call in the Convex logs. These helpers return
 *  `null` on every failure by design (a bad image must never block a
 *  reply), which historically meant a wrong model ID or a key without
 *  model access was indistinguishable from "no media" — invisible. */
async function warnHttp(label: string, res: Response): Promise<void> {
  const body = await res.text().catch(() => "");
  console.warn(`[ai media] ${label} failed: HTTP ${res.status} ${body.slice(0, 300)}`);
}

/** One transcription pass over the same clip. */
interface Attempt {
  /** ISO-639-1 forced on this pass, or `null` for auto-detect. */
  language: string | null;
  text: string;
  /** Mean token logprob (gpt-4o family) or mean segment `avg_logprob`
   *  (whisper-1's `verbose_json`). `null` when the model reported
   *  neither — the caller must then fail open. */
  score: number | null;
  /** whisper-1 only: every segment read as no-speech. */
  silent: boolean;
  /** What this pass cost, when the model reported it. Held per-attempt
   *  rather than on the winner because EVERY pass is billed — the
   *  forced-language rescues are real provider calls even when
   *  `pickAttempt` discards them, so charging only the winner would
   *  under-report a multi-pass transcription by up to 2/3. */
  usage?: MediaUsage | null;
}

function mean(xs: (number | undefined)[]): number | null {
  const ns = xs.filter((n): n is number => typeof n === "number");
  return ns.length > 0 ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
}

/** One `POST /audio/transcriptions`. `null` on any rejection or empty
 *  text — a single failed pass must never sink the others. */
async function transcribeOnce(args: {
  apiKey: string;
  blob: Blob;
  filename: string;
  model: string;
  useLogprobs: boolean;
  language: string | null;
}): Promise<Attempt | null> {
  const form = new FormData();
  form.append("file", args.blob, args.filename);
  form.append("model", args.model);
  // Paired with the model — see `supportsLogprobs`. `verbose_json` is
  // a 400 on the gpt-4o family, and `logprobs` is a 400 on whisper-1.
  form.append("response_format", args.useLogprobs ? "json" : "verbose_json");
  if (args.useLogprobs) form.append("include[]", "logprobs");
  // The fix. Omitted entirely on the auto-detect pass so that pass stays
  // byte-identical to the pre-rescue request.
  if (args.language) form.append("language", args.language);

  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(aiRequestTimeoutMs()),
  });
  if (!res.ok) {
    await warnHttp(`transcription (${args.model}, ${args.language ?? "auto"})`, res);
    return null;
  }
  const data = (await res.json()) as {
    text?: string;
    segments?: { no_speech_prob?: number; avg_logprob?: number }[];
    logprobs?: { logprob?: number }[];
    usage?: RawUsage;
  };
  const usage = toMediaUsage(args.model, data.usage);
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) return null;

  if (args.useLogprobs) {
    const score = mean((data.logprobs ?? []).map((l) => l.logprob));
    return { language: args.language, text, score, silent: false, usage };
  }
  const segments = Array.isArray(data.segments) ? data.segments : [];
  return {
    language: args.language,
    text,
    usage,
    score: mean(segments.map((s) => s.avg_logprob)),
    silent:
      segments.length > 0 &&
      segments.every(
        (s) =>
          typeof s.no_speech_prob === "number" && s.no_speech_prob > NO_SPEECH_PROB_THRESHOLD,
      ),
  };
}

/**
 * Choose between the auto-detect pass and the forced-language rescues.
 *
 * Two rules, in order:
 *   1. Script validity is a HARD constraint, confidence only a soft one.
 *      A fluent Russian hallucination routinely outscores a correct
 *      Malayalam read, so implausible-script passes are excluded from
 *      the comparison entirely. If that would leave nothing, the full
 *      set comes back and the caller's script guard makes the call —
 *      keeping ONE place that decides to discard.
 *   2. Auto-detect is the incumbent: a forced pass must beat it by
 *      `rescueMargin()` to win. Ties, missing scores and a scoreless
 *      auto pass all leave auto-detect in place, so this can only ever
 *      be an improvement over the pre-rescue behaviour.
 */
export function pickAttempt(attempts: Attempt[]): Attempt | null {
  if (attempts.length === 0) return null;
  const plausible = attempts.filter((a) => {
    const script = dominantScript(a.text);
    return !script || isAllowedScript(script);
  });
  const pool = plausible.length > 0 ? plausible : attempts;

  const auto = pool.find((a) => a.language === null);
  // The auto pass errored, or lost rule 1 — take the best-scoring
  // survivor, ties to the first listed.
  if (!auto) {
    return pool.reduce((best, a) => ((a.score ?? -Infinity) > (best.score ?? -Infinity) ? a : best));
  }
  // No confidence signal to compare on → fail OPEN, keep auto-detect.
  if (auto.score === null) return auto;

  const bar = auto.score + rescueMargin();
  let winner = auto;
  for (const a of pool) {
    if (a.language === null || a.score === null) continue;
    if (a.score > bar && (winner === auto || a.score > winner.score!)) winner = a;
  }
  return winner;
}

/**
 * Download a voice note (WhatsApp inbound mirrored into storage at
 * ingest, or a Playground browser recording) and transcribe it. Returns
 * the transcript text, or `null` when the media can't be fetched, every
 * pass is rejected, or the winning pass looks like silence or a
 * wrong-language hallucination.
 */
export async function transcribeAudioFromUrl(args: {
  apiKey: string;
  mediaUrl: string;
  /** Optional spend sink — see `MediaUsage`. Called once per BILLED
   *  pass, so a rescue-language run reports several times. */
  onUsage?: (usage: MediaUsage) => void;
}): Promise<string | null> {
  const model = transcribeModel();
  const useLogprobs = supportsLogprobs(model);
  try {
    const media = await fetch(args.mediaUrl, {
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    });
    // Was silent until 2026-07-25. A 403/404 here is indistinguishable
    // from "no media" downstream, and the Playground renders BOTH as
    // "needs an OpenAI key, or the audio was unclear" — so a broken
    // media URL looked like a missing key. Say which it is.
    if (!media.ok) {
      console.warn(`[ai media] media fetch failed: HTTP ${media.status} ${args.mediaUrl}`);
      return null;
    }
    const blob = await media.blob();
    // The filename extension is what OpenAI keys format detection on.
    // Prefer the response's own content type (WhatsApp OGG, browser webm),
    // falling back to the blob's, then to OGG.
    const contentType = media.headers.get("content-type") || blob.type || null;
    const filename = audioUploadFilename(contentType);

    // Auto-detect first, then one forced pass per rescue language — all
    // concurrent, over the ONE downloaded blob. See the block comment
    // above `rescueLanguages`.
    const languages: (string | null)[] = [null, ...rescueLanguages()];
    const settled = await Promise.all(
      languages.map((language) =>
        transcribeOnce({
          apiKey: args.apiKey,
          blob,
          filename,
          model,
          useLogprobs,
          language,
        }).catch(() => null),
      ),
    );
    const attempts = settled.filter((a): a is Attempt => a !== null);
    // Reported for every surviving pass BEFORE arbitration and before
    // any of the guards below can `return null`: all of them were billed,
    // and a voice note dropped as silence or a hallucination is exactly
    // the case where spend would otherwise vanish without a trace.
    if (args.onUsage) {
      for (const a of attempts) {
        if (a.usage) args.onUsage(a.usage);
      }
    }
    const winner = pickAttempt(attempts);
    if (!winner) return null;

    // Silence guard: when the model is confidently transcribing nothing,
    // the text is hallucinated boilerplate, not something the customer
    // said. Dropping it keeps the bare "[voice note]" placeholder — and
    // the prompt already tells the bot to acknowledge a voice note it
    // cannot hear — which beats confidently answering a hallucination
    // (which also flips the reply into whatever language was
    // hallucinated). Both branches FAIL OPEN: a missing signal keeps the
    // transcript, so a response-shape change can't silently eat real
    // customer messages.
    //
    // The logprob threshold is applied ONLY on the gpt-4o family: it was
    // calibrated against token logprobs, and whisper's segment
    // `avg_logprob` is a different distribution. Whisper keeps its own
    // proven `no_speech_prob` verdict and uses `avg_logprob` for
    // arbitration only.
    //
    // Both drops are LOGGED (they were silent until 2026-07-25, which is
    // exactly why a mis-calibrated threshold silently ate 36% of real
    // messages for a full deploy cycle before anyone could see why).
    if (winner.silent) {
      console.warn(
        `[ai media] dropped transcript: every segment read as no-speech ` +
          `(> ${NO_SPEECH_PROB_THRESHOLD}): ${winner.text.slice(0, 80)}`,
      );
      return null;
    }
    if (useLogprobs && winner.score !== null && winner.score < minAvgLogprob()) {
      console.warn(
        `[ai media] dropped transcript: mean logprob ${winner.score.toFixed(2)} ` +
          `< ${minAvgLogprob()} (raise AI_TRANSCRIBE_MIN_AVG_LOGPROB to keep more): ` +
          winner.text.slice(0, 80),
      );
      return null;
    }

    // Language guard — see SCRIPT_PATTERNS above. Runs for BOTH model
    // families (each one hallucinates in its own way) and after the
    // confidence guards, because a wrong-language transcript can score
    // perfectly well. Fails OPEN on letterless text.
    const script = dominantScript(winner.text);
    if (script && !isAllowedScript(script)) {
      console.warn(
        `[ai media] dropped transcript in unexpected script "${script}" ` +
          `(likely hallucination): ${winner.text.slice(0, 80)}`,
      );
      return null;
    }
    return winner.text;
  } catch {
    return null;
  }
}

/** Upper bound on an inbound PDF we will upload. WhatsApp allows
 *  documents up to 100 MB, and the whole file is base64'd in memory
 *  inside a Convex action, so this is a real limit rather than a
 *  formality — base64 inflates by ~33% on top of the raw bytes. A
 *  customer's visa paperwork is a few hundred KB; anything past 8 MB is a
 *  brochure or a scan dump, and skipping it keeps the placeholder rather
 *  than risking the action. Tune with `AI_PDF_MAX_BYTES`. */
const DEFAULT_PDF_MAX_BYTES = 8 * 1024 * 1024;

function pdfMaxBytes(): number {
  const raw = Number(process.env.AI_PDF_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PDF_MAX_BYTES;
}

/** Base64 without Node's `Buffer` (absent in Convex's runtime). Chunked
 *  because `String.fromCharCode(...bytes)` blows the argument limit on
 *  anything megabyte-sized. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The instruction both document-reading passes share. Kept in one place
 *  so the privacy rule cannot drift between them — this is a visa
 *  business, so the single most common inbound attachment is a passport
 *  page, and the description lands in the conversation transcript that is
 *  fed back to the model on every subsequent dispatch. */
function documentReadingPrompt(what: string, caption?: string): string {
  return (
    `A customer sent this ${what} to a travel agency's WhatsApp.` +
    (caption ? ` Their caption: "${caption}".` : "") +
    " Describe what it shows in 1-2 short sentences, focusing on travel-relevant details (destination, document type, dates, any readable text). " +
    "Never read out passport numbers, ID numbers, or card numbers — if such a document is shown, name the document type only."
  );
}

/**
 * Read a customer-sent PDF and describe it in 1–2 travel-relevant
 * sentences. Sent as an inline base64 `file` content part rather than an
 * `image_url` (which cannot carry a PDF), so the model reads the document
 * itself instead of a placeholder.
 *
 * Same contract as every other helper here: `null` on ANY failure, which
 * leaves the row's "[document]" placeholder in place.
 */
export async function describePdfFromUrl(args: {
  apiKey: string;
  mediaUrl: string;
  filename?: string;
  caption?: string;
  /** Optional spend sink — see `MediaUsage`. Matters more here than on
   *  any other media pass: a PDF is billed per RENDERED PAGE, so a
   *  multi-page scan is the single most expensive provider call the
   *  product makes. Without this it would be invisible on the usage
   *  page, which is exactly the gap the token audit closed. */
  onUsage?: (usage: MediaUsage) => void;
}): Promise<string | null> {
  const model = describeModel();
  try {
    const media = await fetch(args.mediaUrl, {
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    });
    if (!media.ok) return null;
    const bytes = new Uint8Array(await media.arrayBuffer());
    const max = pdfMaxBytes();
    if (bytes.byteLength === 0) return null;
    if (bytes.byteLength > max) {
      console.warn(
        `[ai media] skipped PDF of ${bytes.byteLength} bytes (over the ${max}-byte cap)`,
      );
      return null;
    }

    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: DESCRIBE_MAX_TOKENS,
        ...(supportsReasoningEffort(model) ? { reasoning_effort: "none" } : {}),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: documentReadingPrompt("document", args.caption) },
              {
                type: "file",
                file: {
                  filename: args.filename || "document.pdf",
                  file_data: `data:application/pdf;base64,${toBase64(bytes)}`,
                },
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    });
    if (!res.ok) {
      await warnHttp(`document description (${model})`, res);
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: RawUsage;
    };
    // Reported BEFORE the empty-text check: the account was billed for
    // every rendered page whether or not the model produced anything
    // usable, and an unreadable scan that still cost a full document's
    // worth of vision tokens is exactly the spend worth surfacing.
    const usage = toMediaUsage(model, data.usage);
    if (usage) args.onUsage?.(usage);
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Token spend for ONE media provider call, reported to the caller so it
 * can be logged. These calls have always been billed to the account's
 * own key and were never recorded anywhere — the usage page showed chat
 * calls only, which made the vision pass (the priciest per call: a PDF
 * is billed per rendered page, up to `AI_PDF_MAX_BYTES`) completely
 * invisible.
 *
 * Carries its own `model` because the media models are PINNED
 * independently of `aiConfigs.model` (see `describeModel`), so the
 * caller cannot infer it from the account config.
 */
export interface MediaUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  reasoningTokens?: number;
}

/** Shape of the `usage` block on a chat/completions response, plus the
 *  transcription endpoint's token-flavoured variant. */
interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** gpt-4o-transcribe reports these instead of `prompt_tokens`. */
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * Coerce a provider usage block into `MediaUsage`, or `null` when there
 * is nothing to record. Tolerates both field namings and whisper-1's
 * duration-flavoured block (which reports seconds, not tokens, and so
 * yields null rather than a row of zeroes).
 */
function toMediaUsage(model: string, raw: RawUsage | undefined): MediaUsage | null {
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const promptTokens = num(raw?.prompt_tokens ?? raw?.input_tokens);
  const completionTokens = num(raw?.completion_tokens ?? raw?.output_tokens);
  const total = num(raw?.total_tokens);
  const totalTokens = total > 0 ? total : promptTokens + completionTokens;
  if (totalTokens === 0) return null;
  return {
    model,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens: Math.min(num(raw?.prompt_tokens_details?.cached_tokens), promptTokens),
    reasoningTokens: Math.min(
      num(raw?.completion_tokens_details?.reasoning_tokens),
      completionTokens,
    ),
  };
}

/**
 * Describe a customer-sent image in 1–2 travel-relevant sentences via
 * an OpenAI vision-capable chat model. The stored URL is passed
 * straight through (`image_url` — it is publicly fetchable, same URL
 * the inbox renders). Instructed to NEVER read out passport/ID/card
 * numbers, mirroring the business's golden rules.
 */
export async function describeImageFromUrl(args: {
  apiKey: string;
  mediaUrl: string;
  caption?: string;
  /** Optional spend sink — see `MediaUsage`. A plain callback rather
   *  than a widened return type so every existing caller and test keeps
   *  the `string | null` contract untouched. */
  onUsage?: (usage: MediaUsage) => void;
}): Promise<string | null> {
  const model = describeModel();
  try {
    const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: DESCRIBE_MAX_TOKENS,
        // Describing a photo in two sentences needs no chain of
        // thought, and GPT-5.6 defaults to "medium" when this is
        // omitted — which would spend the whole token budget thinking
        // and return empty content.
        ...(supportsReasoningEffort(model) ? { reasoning_effort: "none" } : {}),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: documentReadingPrompt("image", args.caption) },
              { type: "image_url", image_url: { url: args.mediaUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(aiRequestTimeoutMs()),
    });
    if (!res.ok) {
      await warnHttp(`image description (${model})`, res);
      return null;
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: RawUsage;
    };
    const usage = toMediaUsage(model, data.usage);
    if (usage) args.onUsage?.(usage);
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    return text || null;
  } catch {
    return null;
  }
}
