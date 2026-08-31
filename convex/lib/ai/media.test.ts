import { afterEach, expect, test, vi } from "vitest";
import {
  DEFAULT_DESCRIBE_MODEL,
  DEFAULT_TRANSCRIBE_MODEL,
  audioUploadFilename,
  describeImageFromUrl,
  describeModel,
  describePdfFromUrl,
  dominantScript,
  isAllowedScript,
  rescueLanguages,
  supportsLogprobs,
  supportsReasoningEffort,
  transcribeAudioFromUrl,
  transcribeModel,
  understandingFor,
} from "./media";

test("maps browser and WhatsApp audio content types to upload-friendly extensions", () => {
  expect(audioUploadFilename("audio/webm;codecs=opus")).toBe("voice-note.webm");
  expect(audioUploadFilename("audio/webm")).toBe("voice-note.webm");
  expect(audioUploadFilename("audio/mp4")).toBe("voice-note.m4a");
  expect(audioUploadFilename("audio/mpeg")).toBe("voice-note.mp3");
  expect(audioUploadFilename("audio/ogg")).toBe("voice-note.ogg");
});

test("defaults to .ogg (WhatsApp's format) for unknown or missing content types", () => {
  expect(audioUploadFilename(null)).toBe("voice-note.ogg");
  expect(audioUploadFilename("")).toBe("voice-note.ogg");
  expect(audioUploadFilename("application/octet-stream")).toBe("voice-note.ogg");
});

// ------------------------------------------------------------
// transcribeAudioFromUrl — stubs `global.fetch` for both the media
// download (any URL without "/audio/transcriptions") and the
// transcription call itself (URL containing "/audio/transcriptions").
// ------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

interface TranscriptionBody {
  text?: string;
  segments?: { no_speech_prob?: number; avg_logprob?: number }[];
  logprobs?: { logprob?: number }[];
}

function stubFetch(transcription: TranscriptionBody, status = 200) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/audio/transcriptions")) {
      return new Response(JSON.stringify(transcription), { status });
    }
    // Media download.
    return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }), {
      status: 200,
      headers: { "content-type": "audio/ogg" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function transcriptionForm(fetchSpy: ReturnType<typeof stubFetch>): FormData {
  const call = fetchSpy.mock.calls.find(([input]) =>
    (typeof input === "string" ? input : input.toString()).includes("/audio/transcriptions"),
  );
  expect(call).toBeDefined();
  return (call![1] as RequestInit).body as FormData;
}

const MEDIA_URL = "https://objs.amaniworld.com/acct/inbound/v.ogg";

test("model getters default to the current generation and honour env overrides", () => {
  expect(transcribeModel()).toBe(DEFAULT_TRANSCRIBE_MODEL);
  expect(describeModel()).toBe(DEFAULT_DESCRIBE_MODEL);

  // Guards against a silent regression to the superseded models.
  expect(DEFAULT_TRANSCRIBE_MODEL).toBe("gpt-4o-transcribe");
  expect(DEFAULT_DESCRIBE_MODEL).toBe("gpt-5.6-luna");

  vi.stubEnv("AI_TRANSCRIBE_MODEL", "whisper-1");
  vi.stubEnv("AI_DESCRIBE_MODEL", "gpt-5.6-terra");
  expect(transcribeModel()).toBe("whisper-1");
  expect(describeModel()).toBe("gpt-5.6-terra");
});

test("silence-guard capability is paired to the model family", () => {
  // gpt-4o-*-transcribe: logprobs, json only.
  expect(supportsLogprobs("gpt-4o-transcribe")).toBe(true);
  expect(supportsLogprobs("gpt-4o-mini-transcribe")).toBe(true);
  // whisper-1: verbose_json + no_speech_prob, NO logprobs.
  expect(supportsLogprobs("whisper-1")).toBe(false);
  // diarize supports neither logprobs nor our segment guard.
  expect(supportsLogprobs("gpt-4o-transcribe-diarize")).toBe(false);

  expect(supportsReasoningEffort("gpt-5.6-luna")).toBe(true);
  expect(supportsReasoningEffort("o3")).toBe(true);
  expect(supportsReasoningEffort("gpt-4o-mini")).toBe(false);
});

test("gpt-4o-transcribe asks for json + logprobs, never verbose_json", async () => {
  const fetchSpy = stubFetch({
    text: "Hi, I'd like to book a Dubai visa.",
    logprobs: [{ logprob: -0.05 }, { logprob: -0.2 }],
  });

  const result = await transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL });
  expect(result).toBe("Hi, I'd like to book a Dubai visa.");

  const form = transcriptionForm(fetchSpy);
  expect(form.get("model")).toBe("gpt-4o-transcribe");
  // verbose_json is a 400 on this family — that regression would kill
  // every voice note silently.
  expect(form.get("response_format")).toBe("json");
  expect(form.getAll("include[]")).toContain("logprobs");
});

test("confidently-nonsense audio (very low mean logprob) is dropped as hallucination", async () => {
  stubFetch({
    text: "如果您的视频受到支持,欢迎订阅我的频道。",
    logprobs: [{ logprob: -3.1 }, { logprob: -2.4 }, { logprob: -2.9 }],
  });

  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBeNull();
});

// ------------------------------------------------------------
// Threshold calibration. These are REAL mean logprobs measured by
// replaying the owner's own Playground recordings through the deployed
// path (2026-07-25) — the shipped -1.0 discarded 5 of their 14 real
// messages and surfaced as "Couldn't transcribe this". Regressing the
// default back above -1.16 re-breaks the Playground.
// ------------------------------------------------------------

test("real customer speech down to -1.16 survives the silence guard", async () => {
  // Every one of these is a real utterance the owner recorded; the
  // hardest are short, code-switched Hindi/Malayalam.
  for (const score of [-0.06, -0.5, -0.95, -1.04, -1.1, -1.14, -1.16]) {
    stubFetch({ text: "30 വീസ വേണം എന്ന ചിയാം", logprobs: [{ logprob: score }] });
    await expect(
      transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
    ).resolves.toBe("30 വീസ വേണം എന്ന ചിയാം");
  }
});

test("the hallucination / silence cluster is still dropped", async () => {
  // Measured: hallucination -1.74, pure silence -1.86, room tone -2.95.
  for (const score of [-1.74, -1.86, -2.95]) {
    stubFetch({ text: "Jak sie masz", logprobs: [{ logprob: score }] });
    await expect(
      transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
    ).resolves.toBeNull();
  }
});

test("a dropped transcript says WHY in the logs, with the knob to loosen it", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  stubFetch({ text: "unclear mumbling", logprobs: [{ logprob: -2.4 }] });

  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBeNull();

  // This drop was SILENT until 2026-07-25 — indistinguishable from "no
  // media" and from "no API key" in the Playground's own error copy.
  const logged = warn.mock.calls.flat().join(" ");
  expect(logged).toContain("mean logprob");
  expect(logged).toContain("AI_TRANSCRIBE_MIN_AVG_LOGPROB");
});

test("an unfetchable media URL is logged, not silently swallowed", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("nope", { status: 403 })),
  );

  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBeNull();
  expect(warn.mock.calls.flat().join(" ")).toContain("media fetch failed: HTTP 403");
});

test("a few uncertain tokens do not sink an otherwise confident transcript", async () => {
  stubFetch({
    text: "...sorry, yes, I'm here — can I get a quote for Bali?",
    logprobs: [{ logprob: -2.6 }, { logprob: -0.1 }, { logprob: -0.05 }, { logprob: -0.2 }],
  });

  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBe("...sorry, yes, I'm here — can I get a quote for Bali?");
});

test("the logprob threshold is tunable without a deploy", async () => {
  // Mean is -0.6: kept by default, dropped once the bar is raised.
  const body = { text: "maybe speech", logprobs: [{ logprob: -0.6 }, { logprob: -0.6 }] };

  stubFetch(body);
  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBe("maybe speech");

  vi.stubEnv("AI_TRANSCRIBE_MIN_AVG_LOGPROB", "-0.5");
  stubFetch(body);
  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBeNull();
});

test("missing logprobs fails OPEN so a response-shape change can't eat real messages", async () => {
  stubFetch({ text: "Dubai visa venam" });

  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBe("Dubai visa venam");
});

test("empty or whitespace-only text returns null", async () => {
  stubFetch({ text: "   " });

  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBeNull();
});

// ------------------------------------------------------------
// whisper-1 rollback path — the proven no_speech_prob guard has to keep
// working, or `AI_TRANSCRIBE_MODEL=whisper-1` is a rollback that
// silently disarms the silence guard.
// ------------------------------------------------------------

test("whisper-1 override still asks for verbose_json and omits logprobs", async () => {
  vi.stubEnv("AI_TRANSCRIBE_MODEL", "whisper-1");
  const fetchSpy = stubFetch({ text: "Hello", segments: [{ no_speech_prob: 0.02 }] });

  await transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL });

  const form = transcriptionForm(fetchSpy);
  expect(form.get("model")).toBe("whisper-1");
  expect(form.get("response_format")).toBe("verbose_json");
  // logprobs is a 400 on whisper-1.
  expect(form.getAll("include[]")).toEqual([]);
});

test("whisper-1 all-silent segments still return null, mixed segments still pass", async () => {
  vi.stubEnv("AI_TRANSCRIBE_MODEL", "whisper-1");

  stubFetch({ text: "欢迎订阅我的频道。", segments: [{ no_speech_prob: 0.94 }] });
  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBeNull();

  stubFetch({
    text: "...yes, a quote for Bali please",
    segments: [{ no_speech_prob: 0.95 }, { no_speech_prob: 0.03 }],
  });
  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBe("...yes, a quote for Bali please");
});

// ------------------------------------------------------------
// Script guard — the language half of the hallucination problem.
// Measured on 10 real customer voice notes + synthetic silence
// (2026-07-25): silence made `gpt-4o-transcribe` emit Polish
// ("Jak się masz?") and German, and made `whisper-1` render a real
// Malayalam clip as Kannada. Because the reply prompt mirrors the
// customer's language, ANY such slip becomes a reply in a language the
// customer does not speak.
// ------------------------------------------------------------

test("dominantScript ignores digits, punctuation and stray loanwords", () => {
  // Malayalam sentence carrying the English loanword "visa" + a number.
  expect(dominantScript("വിസിറ്റിംഗ് വിസ visa 299!")).toBe("malayalam");
  expect(dominantScript("Yeah, and you are saying 800 as a total price?")).toBe("latin");
  expect(dominantScript("مرحبا، كيف حالك؟")).toBe("arabic");
  // No letters at all → no opinion (caller must fail open).
  expect(dominantScript("123 ... !!")).toBeNull();
  expect(dominantScript("")).toBeNull();
});

test("allowed scripts cover the languages this business actually receives", () => {
  for (const s of ["latin", "malayalam", "devanagari", "arabic", "tamil"]) {
    expect(isAllowedScript(s)).toBe(true);
  }
  // Hallucination signatures — no customer of a Dubai travel agency has
  // ever sent these, but silence makes the models emit them.
  for (const s of ["cyrillic", "han", "hangul", "thai", "hebrew", "greek"]) {
    expect(isAllowedScript(s)).toBe(false);
  }
});

test("a transcript in an implausible script is dropped, not answered", async () => {
  // Russian — exactly what the owner reported receiving replies in.
  stubFetch({ text: "Привет, как дела?", logprobs: [{ logprob: -0.2 }] });
  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBeNull();

  // Confident logprobs must NOT rescue it — this guard is about language,
  // not confidence, and hallucinated foreign text can score well.
  stubFetch({ text: "如果您的视频受到支持,欢迎订阅我的频道。", logprobs: [{ logprob: -0.05 }] });
  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBeNull();
});

test("real Malayalam, Hindi, Arabic, Tamil and English transcripts survive the guard", async () => {
  const real = [
    "വിസിറ്റിംഗ് വിസ റിന്യൂവേഷനായി പാക്കേജ് റേറ്റ് എത്രയാണ്?",
    "मुझे दुबई का वीज़ा चाहिए",
    "السلام علیکم برادر کیا حال ہے",
    "எனக்கு 29, 30 பாருங்க",
    "Dubai visa ethra aakum?",
  ];
  for (const text of real) {
    stubFetch({ text, logprobs: [{ logprob: -0.3 }] });
    await expect(
      transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
    ).resolves.toBe(text);
  }
});

test("the allowed-script list is tunable without a deploy", async () => {
  vi.stubEnv("AI_TRANSCRIBE_ALLOWED_SCRIPTS", "latin,cyrillic");
  stubFetch({ text: "Привет, как дела?", logprobs: [{ logprob: -0.2 }] });
  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBe("Привет, как дела?");

  // …and narrowing it drops what the default would have kept.
  vi.stubEnv("AI_TRANSCRIBE_ALLOWED_SCRIPTS", "latin");
  stubFetch({ text: "വിസ എത്രയാണ്?", logprobs: [{ logprob: -0.2 }] });
  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBeNull();
});

// ------------------------------------------------------------
// Language rescue — the OWNER-REPORTED symptom (2026-07-25): Malayalam
// voice notes answered in Tamil. Unlike the Russian case above, the
// script guard is structurally unable to catch this one, because this
// business really does serve Tamil speakers. See the block comment above
// `rescueLanguages` in media.ts.
// ------------------------------------------------------------

/** Stubs the transcription endpoint with a DIFFERENT body per pass,
 *  keyed by the `language` form field (`"auto"` for the pass that sends
 *  none) — which is the whole point of the rescue: the same clip comes
 *  back differently depending on what we told the model to expect. */
function stubFetchByLanguage(bodies: Record<string, TranscriptionBody>, status = 200) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/audio/transcriptions")) {
      const form = init!.body as FormData;
      const key = (form.get("language") as string | null) ?? "auto";
      return new Response(JSON.stringify(bodies[key] ?? {}), { status });
    }
    return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }), {
      status: 200,
      headers: { "content-type": "audio/ogg" },
    });
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

/** Every `language` value sent to the transcription endpoint, in call
 *  order; `null` for the auto-detect pass. */
function languagesTried(fetchSpy: ReturnType<typeof stubFetchByLanguage>) {
  return fetchSpy.mock.calls
    .filter(([input]) =>
      (typeof input === "string" ? input : input.toString()).includes("/audio/transcriptions"),
    )
    .map(([, init]) => (init!.body as FormData).get("language"));
}

const MALAYALAM = "വിസിറ്റിംഗ് വിസ റിന്യൂവേഷനായി എത്ര രൂപ ആകും?";
/** What blind language-ID actually returns for the clip above — Tamil
 *  script, because Whisper saw ~0.5h of Malayalam and falls to the
 *  nearest well-resourced Dravidian neighbour (openai/whisper#1019). */
const TAMIL_MISREAD = "விசிட்டிங் விசா ரின்யூவேஷனுக்கு எத்தனை ரூபாய் ஆகும்?";

test("every clip gets an auto-detect pass AND a forced-Malayalam pass", async () => {
  vi.stubEnv("AI_TRANSCRIBE_LANGUAGES", "ml");
  const fetchSpy = stubFetchByLanguage({
    auto: { text: "hello", logprobs: [{ logprob: -0.2 }] },
    ml: { text: MALAYALAM, logprobs: [{ logprob: -0.3 }] },
  });

  await transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL });

  // The `language` param is the fix: OpenAI's reference states supplying
  // it "will improve accuracy and latency". We used to send none at all.
  expect(languagesTried(fetchSpy)).toEqual([null, "ml"]);
  // …and the clip is downloaded ONCE, then shared between both passes.
  expect(fetchSpy.mock.calls.filter(([i]) => !i.toString().includes("openai"))).toHaveLength(1);
});

test("a forced-Malayalam pass beats auto-detect's Tamil misread", async () => {
  vi.stubEnv("AI_TRANSCRIBE_LANGUAGES", "ml");
  stubFetchByLanguage({
    // Blind ID is confident-ish, but wrong.
    auto: { text: TAMIL_MISREAD, logprobs: [{ logprob: -0.55 }, { logprob: -0.6 }] },
    // Told what to expect, the model reads it correctly and is surer.
    ml: { text: MALAYALAM, logprobs: [{ logprob: -0.2 }, { logprob: -0.15 }] },
  });

  await expect(transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL })).resolves.toBe(
    MALAYALAM,
  );
});

test("the rescue pass never hijacks a language auto-detect already handles", async () => {
  vi.stubEnv("AI_TRANSCRIBE_LANGUAGES", "ml");
  // Hindi has orders of magnitude more training data than Malayalam and
  // detects fine; forcing `ml` on it yields low-confidence Malayalam-script
  // garbage. Losing this test would trade one broken language for another.
  stubFetchByLanguage({
    auto: { text: "मुझे दुबई का वीज़ा चाहिए", logprobs: [{ logprob: -0.18 }] },
    ml: { text: "മുഝേ ദുബായ് കാ വീസാ ചാഹിയേ", logprobs: [{ logprob: -1.4 }] },
  });
  await expect(transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL })).resolves.toBe(
    "मुझे दुबई का वीज़ा चाहिए",
  );

  // Same for plain English.
  stubFetchByLanguage({
    auto: { text: "How much for a Bali package?", logprobs: [{ logprob: -0.1 }] },
    ml: { text: "ഹൗ മച്ച് ഫോർ എ ബാലി", logprobs: [{ logprob: -1.9 }] },
  });
  await expect(transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL })).resolves.toBe(
    "How much for a Bali package?",
  );
});

test("a tie leaves auto-detect in place — the rescue must strictly improve", async () => {
  vi.stubEnv("AI_TRANSCRIBE_LANGUAGES", "ml");
  stubFetchByLanguage({
    auto: { text: "Dubai visa ethra aakum?", logprobs: [{ logprob: -0.4 }] },
    ml: { text: MALAYALAM, logprobs: [{ logprob: -0.4 }] },
  });

  await expect(transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL })).resolves.toBe(
    "Dubai visa ethra aakum?",
  );
});

test("an implausible-script pass loses to a plausible one even when it scores better", async () => {
  vi.stubEnv("AI_TRANSCRIBE_LANGUAGES", "ml");
  // Script validity is a HARD constraint, confidence only a soft one:
  // a fluent Russian hallucination routinely outscores a correct read.
  stubFetchByLanguage({
    auto: { text: "Привет, как дела?", logprobs: [{ logprob: -0.05 }] },
    ml: { text: MALAYALAM, logprobs: [{ logprob: -0.7 }] },
  });

  await expect(transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL })).resolves.toBe(
    MALAYALAM,
  );
});

test("silence still wins over both passes", async () => {
  vi.stubEnv("AI_TRANSCRIBE_LANGUAGES", "ml");
  stubFetchByLanguage({
    auto: { text: "Jak się masz?", logprobs: [{ logprob: -2.4 }] },
    ml: { text: "ഹലോ ഹലോ", logprobs: [{ logprob: -2.9 }] },
  });

  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBeNull();
});

test("a rescue pass still answers when the auto pass errors out", async () => {
  vi.stubEnv("AI_TRANSCRIBE_LANGUAGES", "ml");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/audio/transcriptions")) {
      const lang = (init!.body as FormData).get("language");
      if (lang === null) return new Response("upstream hiccup", { status: 500 });
      return new Response(JSON.stringify({ text: MALAYALAM, logprobs: [{ logprob: -0.3 }] }), {
        status: 200,
      });
    }
    return new Response(new Blob([new Uint8Array([1])], { type: "audio/ogg" }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchSpy);

  await expect(transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL })).resolves.toBe(
    MALAYALAM,
  );
});

test("the rescue is OFF by default — one transcription call per clip", async () => {
  // Measured 2026-07-25 (scripts/voice-eval): `language` is advisory on
  // gpt-4o-transcribe, so a forced pass buys nothing there and fires on
  // logprob noise. Regressing this default doubles spend for no gain.
  expect(rescueLanguages()).toEqual([]);
  const fetchSpy = stubFetchByLanguage({ auto: { text: "hi", logprobs: [{ logprob: -0.2 }] } });
  await transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL });
  expect(languagesTried(fetchSpy)).toEqual([null]);
});

test("rescue languages are opt-in and tunable, for the whisper-1 rollback path", async () => {
  vi.stubEnv("AI_TRANSCRIBE_LANGUAGES", "ml,ta");
  expect(rescueLanguages()).toEqual(["ml", "ta"]);
  const fetchSpy = stubFetchByLanguage({ auto: { text: "hi", logprobs: [{ logprob: -0.2 }] } });
  await transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL });
  expect(languagesTried(fetchSpy)).toEqual([null, "ml", "ta"]);
});

test("whisper-1 rollback gets the language rescue, arbitrated on avg_logprob", async () => {
  // `language` DOES bind on whisper-1 (seq2seq with a real language
  // token) — the one place the rescue earns its extra call.
  vi.stubEnv("AI_TRANSCRIBE_MODEL", "whisper-1");
  vi.stubEnv("AI_TRANSCRIBE_LANGUAGES", "ml");
  const fetchSpy = stubFetchByLanguage({
    auto: { text: TAMIL_MISREAD, segments: [{ no_speech_prob: 0.02, avg_logprob: -0.72 }] },
    ml: { text: MALAYALAM, segments: [{ no_speech_prob: 0.02, avg_logprob: -0.24 }] },
  });

  await expect(transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL })).resolves.toBe(
    MALAYALAM,
  );
  expect(languagesTried(fetchSpy)).toEqual([null, "ml"]);
});

// ------------------------------------------------------------
// describeImageFromUrl
// ------------------------------------------------------------

function stubChat(payload: unknown, status = 200) {
  const fetchSpy = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

/** JSON body of the last chat-completions call. */
function lastChatBody(fetchSpy: ReturnType<typeof stubChat>) {
  return JSON.parse((fetchSpy.mock.calls.at(-1)![1] as RequestInit).body as string);
}

test("image description pins the vision model and disables reasoning", async () => {
  const fetchSpy = stubChat({
    choices: [{ message: { content: "A Dubai hotel pool at sunset." } }],
  });

  const text = await describeImageFromUrl({
    apiKey: "sk-test",
    mediaUrl: "https://objs.amaniworld.com/p.jpg",
    caption: "our hotel?",
  });
  expect(text).toBe("A Dubai hotel pool at sunset.");

  const body = lastChatBody(fetchSpy);
  expect(body.model).toBe("gpt-5.6-luna");
  // GPT-5.6 defaults to "medium" when omitted; at a bounded cap that
  // returns EMPTY content rather than a description.
  expect(body.reasoning_effort).toBe("none");
  expect(body.max_completion_tokens).toBe(500);

  const parts = body.messages[0].content as { type: string; text?: string }[];
  const promptText = parts.find((p) => p.type === "text")!.text!;
  expect(promptText).toContain('Their caption: "our hotel?"');
  expect(promptText).toContain("Never read out passport numbers");
});

test("image description omits reasoning_effort when overridden to an older model", async () => {
  vi.stubEnv("AI_DESCRIBE_MODEL", "gpt-4o-mini");
  const fetchSpy = stubChat({ choices: [{ message: { content: "A passport." } }] });

  await describeImageFromUrl({ apiKey: "sk-test", mediaUrl: "https://objs.amaniworld.com/p.jpg" });

  const body = lastChatBody(fetchSpy);
  expect(body.model).toBe("gpt-4o-mini");
  expect(body).not.toHaveProperty("reasoning_effort");
});

test("a rejected call returns null and logs instead of throwing", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  stubFetch({ text: "x" }, 404);
  await expect(
    transcribeAudioFromUrl({ apiKey: "sk-test", mediaUrl: MEDIA_URL }),
  ).resolves.toBeNull();

  stubChat({ error: { message: "model not found" } }, 404);
  await expect(
    describeImageFromUrl({ apiKey: "sk-test", mediaUrl: "https://objs.amaniworld.com/p.jpg" }),
  ).resolves.toBeNull();

  // A wrong model ID used to be indistinguishable from "no media".
  expect(warn).toHaveBeenCalledTimes(2);
  expect(warn.mock.calls.flat().join(" ")).toContain("model not found");
});

// ============================================================
// understandingFor — which pass (if any) an inbound media row earns.
// Routes on the STORED KEY'S EXTENSION rather than `contentType` alone,
// because WhatsApp's "send as document" (which preserves image quality,
// so passport scans routinely use it) delivers a photo under
// `contentType: "document"`.
// ============================================================

test("routes each inbound media row to the pass that can actually read it", () => {
  expect(understandingFor("audio", { key: "acct/inbound/a.ogg" })).toBe("transcribe");
  expect(understandingFor("image", { key: "acct/inbound/a.jpg" })).toBe("describe");
  expect(understandingFor("video", { key: "acct/inbound/a.mp4" })).toBe("transcribe");
  expect(understandingFor("document", { key: "acct/inbound/a.pdf" })).toBe("pdf");
});

test("a document that is really a photo is described, not sent to the PDF pass", () => {
  expect(understandingFor("document", { key: "acct/inbound/a.jpg" })).toBe("describe");
  expect(understandingFor("document", { key: null, url: "https://x/scan.png" })).toBe(
    "describe",
  );
});

test("a document that is really a video is transcribed for its audio track", () => {
  expect(understandingFor("document", { key: "acct/inbound/a.mp4" })).toBe("transcribe");
});

test("media we cannot read earns no pass at all, keeping its placeholder", () => {
  // An unmapped content type stores with NO extension (see `buildMediaKey`).
  expect(understandingFor("document", { key: "acct/inbound/a" })).toBeNull();
  expect(understandingFor("document", { key: "acct/inbound/a.zip" })).toBeNull();
  expect(understandingFor("location", { key: "acct/inbound/a.pdf" })).toBeNull();
  expect(understandingFor("document", { key: null, url: null })).toBeNull();
});

test("a video clip uploads with its real container extension, not .ogg", () => {
  // OpenAI keys format detection off the filename, so a clip named
  // `voice-note.ogg` is rejected or misparsed no matter what it contains.
  expect(audioUploadFilename("video/mp4")).toBe("voice-note.mp4");
  expect(audioUploadFilename("video/webm")).toBe("voice-note.webm");
  expect(audioUploadFilename("video/mpeg")).toBe("voice-note.mpeg");
});

test("containers OpenAI cannot decode earn no pass rather than a guaranteed 400", () => {
  // 3gp/mov are outside OpenAI's documented transcription format list;
  // heic is outside the vision model's. A known-unreadable extension
  // overrides the envelope rather than falling back to it.
  expect(understandingFor("video", { key: "acct/inbound/a.3gp" })).toBeNull();
  expect(understandingFor("document", { key: "acct/inbound/a.mov" })).toBeNull();
  expect(understandingFor("image", { key: "acct/inbound/a.heic" })).toBeNull();
});

test("a legacy row with no extension at all still trusts its envelope type", () => {
  expect(understandingFor("audio", { key: null, url: "https://x/storage/abc" })).toBe(
    "transcribe",
  );
  expect(understandingFor("image", { key: null, url: "https://x/storage/abc" })).toBe(
    "describe",
  );
});

// ------------------------------------------------------------
// describePdfFromUrl — the document gap. A PDF is uploaded inline as
// base64 (OpenAI's documented `file` content part) rather than as an
// `image_url`, which cannot carry one.
// ------------------------------------------------------------

const PDF_URL = "https://objs.amaniworld.com/acct/inbound/a.pdf";

function stubPdfFetch(
  completion: unknown,
  status = 200,
  bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]),
) {
  const spy = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/chat/completions")) {
      return new Response(JSON.stringify(completion), { status });
    }
    return new Response(new Blob([bytes], { type: "application/pdf" }), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function completionCall(spy: ReturnType<typeof stubPdfFetch>) {
  return spy.mock.calls.find(([input]) =>
    (typeof input === "string" ? input : input.toString()).includes("/chat/completions"),
  );
}

test("a PDF is sent inline as a base64 file part and its description returned", async () => {
  const spy = stubPdfFetch({
    choices: [{ message: { content: "A UAE tourist visa approval for one adult." } }],
  });

  const result = await describePdfFromUrl({
    apiKey: "sk-test",
    mediaUrl: PDF_URL,
    filename: "visa-approval.pdf",
  });
  expect(result).toBe("A UAE tourist visa approval for one adult.");

  const body = JSON.parse((completionCall(spy)![1] as RequestInit).body as string);
  const filePart = body.messages[0].content.find(
    (p: { type: string }) => p.type === "file",
  );
  expect(filePart.file.file_data).toMatch(/^data:application\/pdf;base64,/);
  expect(filePart.file.filename).toBe("visa-approval.pdf");
});

test("the PDF prompt carries the same never-read-out-ID-numbers rule as images", async () => {
  const spy = stubPdfFetch({ choices: [{ message: { content: "A passport bio page." } }] });

  await describePdfFromUrl({ apiKey: "sk-test", mediaUrl: PDF_URL });

  const body = JSON.parse((completionCall(spy)![1] as RequestInit).body as string);
  const textPart = body.messages[0].content.find(
    (p: { type: string }) => p.type === "text",
  );
  expect(textPart.text).toContain("Never read out passport numbers");
});

test("an oversized PDF is skipped without ever reaching the model", async () => {
  const spy = stubPdfFetch({}, 200, new Uint8Array(9 * 1024 * 1024));

  await expect(
    describePdfFromUrl({ apiKey: "sk-test", mediaUrl: PDF_URL }),
  ).resolves.toBeNull();
  expect(completionCall(spy)).toBeUndefined();
});

test("a rejected PDF call is logged loudly and degrades to null", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  stubPdfFetch({ error: { message: "model not found" } }, 404);

  await expect(
    describePdfFromUrl({ apiKey: "sk-test", mediaUrl: PDF_URL }),
  ).resolves.toBeNull();
  expect(warn.mock.calls.flat().join(" ")).toContain("model not found");
});

// ------------------------------------------------------------
// PDF spend reporting. A PDF is billed per RENDERED PAGE, making it the
// most expensive provider call in the product — and until the token
// audit it was logged nowhere at all. `describePdfFromUrl` predates the
// `onUsage` sink, so this covers the wiring that joins the two.
// ------------------------------------------------------------

test("a PDF reports its token spend, tagged with the vision model", async () => {
  stubPdfFetch({
    choices: [{ message: { content: "A visa approval." } }],
    usage: {
      prompt_tokens: 4200,
      completion_tokens: 30,
      total_tokens: 4230,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  });

  const seen: { model: string; totalTokens: number }[] = [];
  await describePdfFromUrl({
    apiKey: "sk-test",
    mediaUrl: PDF_URL,
    onUsage: (u) => seen.push({ model: u.model, totalTokens: u.totalTokens }),
  });

  expect(seen).toHaveLength(1);
  expect(seen[0].totalTokens).toBe(4230);
  // The media models are pinned independently of `aiConfigs.model`, so
  // the caller cannot infer which one was billed — it rides along.
  expect(seen[0].model).toBe(describeModel());
});

test("an unreadable PDF still reports the pages it was billed for", async () => {
  // Empty content but real usage: the account paid for the render
  // regardless, and that is precisely the spend worth surfacing.
  stubPdfFetch({
    choices: [{ message: { content: "   " } }],
    usage: { prompt_tokens: 8000, completion_tokens: 0, total_tokens: 8000 },
  });

  const seen: number[] = [];
  const result = await describePdfFromUrl({
    apiKey: "sk-test",
    mediaUrl: PDF_URL,
    onUsage: (u) => seen.push(u.totalTokens),
  });

  expect(result).toBeNull();
  expect(seen).toEqual([8000]);
});

test("a PDF rejected before the provider call reports no spend", async () => {
  // Over the byte cap — skipped without ever reaching OpenAI, so there
  // is nothing to bill and nothing to log.
  vi.stubEnv("AI_PDF_MAX_BYTES", "2");
  stubPdfFetch(
    { choices: [{ message: { content: "never reached" } }] },
    200,
    new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  );

  const seen: unknown[] = [];
  const result = await describePdfFromUrl({
    apiKey: "sk-test",
    mediaUrl: PDF_URL,
    onUsage: (u) => seen.push(u),
  });

  expect(result).toBeNull();
  expect(seen).toEqual([]);
});
