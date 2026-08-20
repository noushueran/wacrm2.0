import { describe, it, expect } from "vitest";
import {
  dominantScript, normalize, wer, cer, meanLogprob, extForContentType, publicUrl,
  selectAudioRows, manifestEntry, mergeManifest, annotatedClips,
  gptVerdict, whisperVerdict, scoreClip, summarize,
} from "./lib.mjs";

// Malayalam chillu letters are commonly encoded as consonant + virama + ZWJ
// (e.g. chillu-N = NA U+0D28 + VIRAMA U+0D4D + ZWJ U+200D). This pair places
// that chillu immediately before more letters within the SAME orthographic
// word (as in a suffixed form, roughly "avan" + chillu-N + "-re"), so a
// bug that turns the ZWJ into a space would visibly split one word in two.
const MALAYALAM_WITH_ZWJ = "അവന്‍റെ";
const MALAYALAM_WITHOUT_ZWJ = "അവന്റെ";

describe("normalize", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalize("Hello,  WORLD!")).toBe("hello world");
  });
  it("keeps Malayalam letters and marks", () => {
    expect(normalize("എന്റെ പേര്.")).toBe("എന്റെ പേര്");
  });
  it("handles null/undefined", () => {
    expect(normalize(null)).toBe("");
  });
  it("deletes an embedded ZWJ instead of turning it into a word-splitting space", () => {
    const normalized = normalize(MALAYALAM_WITH_ZWJ);
    expect(normalized).toBe(MALAYALAM_WITHOUT_ZWJ);
    expect(normalized).not.toContain(" ");
  });
  it("applies NFC so precomposed and decomposed forms of the same text are equal", () => {
    const precomposed = "é"; // é as one codepoint (LATIN SMALL LETTER E WITH ACUTE)
    const decomposed = "é"; // "e" + COMBINING ACUTE ACCENT
    expect(normalize(precomposed)).toBe(normalize(decomposed));
  });
});

describe("wer", () => {
  it("is 0 for identical strings", () => {
    expect(wer("a b c", "a b c")).toBe(0);
  });
  it("is 1/3 for one substitution in three words", () => {
    expect(wer("a b c", "a x c")).toBeCloseTo(1 / 3);
  });
  it("empty reference: 0 vs empty hyp, 1 vs non-empty hyp", () => {
    expect(wer("", "")).toBe(0);
    expect(wer("", "x")).toBe(1);
  });
  it("does not inflate WER from a ZWJ embedded inside a single word", () => {
    // Same single word; the only difference is the internal ZWJ (as Whisper
    // commonly emits for Malayalam chillu letters). A correct normalize()
    // treats them as identical (WER 0). A bug that turns the ZWJ into a
    // space splits MALAYALAM_WITH_ZWJ into two tokens, which then fails to
    // match the single token in MALAYALAM_WITHOUT_ZWJ, inflating WER to 1.
    expect(wer(MALAYALAM_WITH_ZWJ, MALAYALAM_WITHOUT_ZWJ)).toBe(0);
  });
});

describe("cer", () => {
  it("counts character edits ignoring spaces", () => {
    expect(cer("abc", "abd")).toBeCloseTo(1 / 3);
  });
  it("is 0 for identical", () => {
    expect(cer("hello", "hello")).toBe(0);
  });
  it("splits by codepoint, not UTF-16 code unit, for characters outside the BMP", () => {
    // U+20BB7 is a supplementary-plane CJK ideograph — a surrogate pair in
    // UTF-16 (`"\u{20BB7}".length === 2`). `[...str]` counts it as ONE
    // character (ref/hyp length 3, one substitution -> 1/3). `str.split("")`
    // would wrongly split it into two lone surrogates (length 4, still one
    // substitution -> 1/4), so this fails if `[...str]` regresses to `.split("")`.
    expect(cer("\u{20BB7}bc", "\u{20BB7}bd")).toBeCloseTo(1 / 3);
  });
});

describe("meanLogprob", () => {
  it("averages numeric logprobs", () => {
    expect(meanLogprob([{ logprob: -0.5 }, { logprob: -1.5 }])).toBeCloseTo(-1.0);
  });
  it("ignores non-numeric entries", () => {
    expect(meanLogprob([{ logprob: -1 }, {}, { logprob: -3 }])).toBeCloseTo(-2.0);
  });
  it("returns null when there are no numbers", () => {
    expect(meanLogprob([])).toBeNull();
  });
});

describe("extForContentType", () => {
  it("maps ogg and strips codec params", () => {
    expect(extForContentType("audio/ogg; codecs=opus")).toBe("ogg");
  });
  it("maps mp4 to m4a", () => {
    expect(extForContentType("audio/mp4")).toBe("m4a");
  });
  it("defaults to ogg for null/unknown", () => {
    expect(extForContentType(null)).toBe("ogg");
    expect(extForContentType("audio/weird")).toBe("ogg");
  });
});

describe("publicUrl", () => {
  it("prepends https and percent-encodes each key segment", () => {
    expect(publicUrl("media.example.com", "a b/c.ogg")).toBe(
      "https://media.example.com/a%20b/c.ogg",
    );
  });
  it("keeps an existing scheme and trims trailing slash on host", () => {
    expect(publicUrl("https://x.com/", "k")).toBe("https://x.com/k");
  });
});

describe("selectAudioRows", () => {
  const rows = [
    { _id: "1", contentType: "audio", mediaKey: "k1" },
    { _id: "2", contentType: "text" },
    { _id: "3", contentType: "audio", mediaUrl: "u3" },
    { _id: "4", contentType: "audio" }, // no key/url — excluded
  ];
  it("keeps audio rows that have a fetchable ref, in order, capped at want", () => {
    expect(selectAudioRows(rows, 9).map((r) => r._id)).toEqual(["1", "3"]);
  });
  it("caps at want", () => {
    expect(selectAudioRows(rows, 1).map((r) => r._id)).toEqual(["1"]);
  });
});

describe("manifestEntry", () => {
  it("builds a blank-annotation entry with ext derived from contentType", () => {
    expect(manifestEntry({ _id: "m1", contentType: "audio/mp4", caption: "hi" })).toEqual({
      id: "m1", file: "m1.m4a", contentType: "audio/mp4", caption: "hi",
      reference: "", lang: "", silent: false,
    });
  });
  it("defaults caption to null", () => {
    expect(manifestEntry({ _id: "m2", contentType: "audio/ogg" }).caption).toBeNull();
  });
});

describe("mergeManifest", () => {
  it("preserves existing annotations and adds new ids", () => {
    const existing = [{ id: "a", reference: "kept", lang: "ml", silent: false }];
    const fresh = [
      { id: "a", reference: "", lang: "", silent: false },
      { id: "b", reference: "", lang: "", silent: false },
    ];
    const merged = mergeManifest(existing, fresh);
    expect(merged.find((e) => e.id === "a").reference).toBe("kept");
    expect(merged.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });
});

describe("annotatedClips", () => {
  it("includes silent clips and non-empty references, excludes blanks", () => {
    const m = [
      { id: "a", reference: "x", silent: false },
      { id: "b", reference: "", silent: true },
      { id: "c", reference: "  ", silent: false },
    ];
    expect(annotatedClips(m).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("verdicts", () => {
  it("gptVerdict DROPs below threshold, fail-open on null mean", () => {
    expect(gptVerdict(-1.5)).toBe("DROP");
    expect(gptVerdict(-0.5)).toBe("KEEP");
    expect(gptVerdict(null)).toBe("KEEP");
  });
  it("whisperVerdict DROPs all-silent, fail-open on no segments", () => {
    expect(whisperVerdict([{ no_speech_prob: 0.9 }, { no_speech_prob: 0.8 }])).toBe("DROP");
    expect(whisperVerdict([{ no_speech_prob: 0.9 }, { no_speech_prob: 0.1 }])).toBe("KEEP");
    expect(whisperVerdict([])).toBe("KEEP");
  });
});

describe("scoreClip", () => {
  it("computes WER/CER, mean logprob, and both verdicts", () => {
    const s = scoreClip({
      id: "a", lang: "ml", silent: false, reference: "hello world",
      whisperText: "hello world", whisperSegments: [{ no_speech_prob: 0.1 }],
      gptText: "hello word", gptLogprobs: [{ logprob: -0.2 }, { logprob: -0.4 }],
    });
    expect(s.whisperWer).toBe(0);
    expect(s.gptWer).toBeCloseTo(0.5);
    expect(s.gptMeanLP).toBeCloseTo(-0.3);
    expect(s.gptVerdict).toBe("KEEP");
    expect(s.whisperVerdict).toBe("KEEP");
  });
});

describe("summarize", () => {
  const scored = [
    { id: "s1", lang: "ml", silent: false, whisperWer: 0.1, whisperCer: 0.05, gptWer: 0.08, gptCer: 0.04, gptMeanLP: -0.3, gptVerdict: "KEEP", whisperVerdict: "KEEP" },
    { id: "s2", lang: "ml", silent: false, whisperWer: 0.2, whisperCer: 0.10, gptWer: 0.15, gptCer: 0.08, gptMeanLP: -1.2, gptVerdict: "DROP", whisperVerdict: "KEEP" },
    { id: "n1", lang: "other", silent: true, whisperWer: 1, whisperCer: 1, gptWer: 1, gptCer: 1, gptMeanLP: -0.9, gptVerdict: "KEEP", whisperVerdict: "DROP" },
  ];
  it("flags false drops (speech DROPped) and false keeps (silent KEPT)", () => {
    const sum = summarize(scored, -1.0);
    expect(sum.calibration.falseDrops).toEqual(["s2"]);
    expect(sum.calibration.falseKeeps).toEqual(["n1"]);
  });
  it("averages WER/CER per language over speech clips only", () => {
    const sum = summarize(scored, -1.0);
    expect(sum.perLang.ml.n).toBe(2);
    expect(sum.perLang.ml.gptWer).toBeCloseTo((0.08 + 0.15) / 2);
    expect(sum.perLang.other).toBeUndefined(); // n1 is silent → excluded
  });
  it("averages WER/CER per language independently, not over the total speech count", () => {
    // Two languages with UNEVEN clip counts (2 "ml" vs 3 "other", total 5).
    // A bug that divides every language's sum by the TOTAL speech count (5)
    // instead of that language's own n would produce visibly different
    // numbers from the correct per-language means asserted below — e.g.
    // wrong ml.gptWer = 0.30/5 = 0.06 vs correct 0.30/2 = 0.15. Every other
    // fixture in this file uses a single speech language, where total count
    // === per-language count, so that bug would go unnoticed there.
    const multiLang = [
      { id: "ml-1", lang: "ml", silent: false, whisperWer: 0.05, whisperCer: 0.02, gptWer: 0.10, gptCer: 0.05, gptMeanLP: -0.3, gptVerdict: "KEEP", whisperVerdict: "KEEP" },
      { id: "ml-2", lang: "ml", silent: false, whisperWer: 0.15, whisperCer: 0.08, gptWer: 0.20, gptCer: 0.10, gptMeanLP: -0.4, gptVerdict: "KEEP", whisperVerdict: "KEEP" },
      { id: "other-1", lang: "other", silent: false, whisperWer: 0.25, whisperCer: 0.12, gptWer: 0.30, gptCer: 0.15, gptMeanLP: -0.5, gptVerdict: "KEEP", whisperVerdict: "KEEP" },
      { id: "other-2", lang: "other", silent: false, whisperWer: 0.35, whisperCer: 0.18, gptWer: 0.40, gptCer: 0.20, gptMeanLP: -0.6, gptVerdict: "KEEP", whisperVerdict: "KEEP" },
      { id: "other-3", lang: "other", silent: false, whisperWer: 0.45, whisperCer: 0.22, gptWer: 0.50, gptCer: 0.25, gptMeanLP: -0.7, gptVerdict: "KEEP", whisperVerdict: "KEEP" },
    ];
    const sum = summarize(multiLang, -1.0);

    expect(sum.perLang.ml.n).toBe(2);
    expect(sum.perLang.ml.gptWer).toBeCloseTo((0.10 + 0.20) / 2);
    expect(sum.perLang.ml.gptCer).toBeCloseTo((0.05 + 0.10) / 2);
    expect(sum.perLang.ml.whisperWer).toBeCloseTo((0.05 + 0.15) / 2);

    expect(sum.perLang.other.n).toBe(3);
    expect(sum.perLang.other.gptWer).toBeCloseTo((0.30 + 0.40 + 0.50) / 3);
    expect(sum.perLang.other.gptCer).toBeCloseTo((0.15 + 0.20 + 0.25) / 3);
    expect(sum.perLang.other.whisperWer).toBeCloseTo((0.25 + 0.35 + 0.45) / 3);
  });
  it("suggests no threshold when speech and silence overlap", () => {
    // silent max -0.9 is NOT below speech min -1.2 → not separable
    expect(summarize(scored, -1.0).calibration.suggestedThreshold).toBeNull();
  });
  it("suggests the midpoint between the worst-case pair, not any other pairing", () => {
    // 3 silent + 3 speech clips: at n=1 per side (the old fixture), max/min
    // are trivial, so a wrong implementation that paired the WRONG extremes
    // would produce the same number and pass. With 3-a-side that collapses:
    //   Silent gptMeanLP: -3.0, -2.5, -1.8  → max(silent) = -1.8
    //   Speech gptMeanLP: -1.0, -0.6, -0.2  → min(speech) = -1.0
    // Cleanly separable: every silent value < every speech value.
    // Correct:  (max(silent) + min(speech)) / 2 = (-1.8 + -1.0) / 2 = -1.4.
    // Wrong (min(silent) paired with max(speech)) would instead give
    // (-3.0 + -0.2) / 2 = -1.6 — a different number, so this fixture catches
    // that mistake.
    const sep = [
      { id: "sil-a", lang: "ml", silent: true, whisperWer: 1, whisperCer: 1, gptWer: 1, gptCer: 1, gptMeanLP: -3.0, gptVerdict: "DROP", whisperVerdict: "DROP" },
      { id: "sil-b", lang: "ml", silent: true, whisperWer: 1, whisperCer: 1, gptWer: 1, gptCer: 1, gptMeanLP: -2.5, gptVerdict: "DROP", whisperVerdict: "DROP" },
      { id: "sil-c", lang: "ml", silent: true, whisperWer: 1, whisperCer: 1, gptWer: 1, gptCer: 1, gptMeanLP: -1.8, gptVerdict: "DROP", whisperVerdict: "DROP" },
      { id: "sp-a", lang: "ml", silent: false, whisperWer: 0, whisperCer: 0, gptWer: 0, gptCer: 0, gptMeanLP: -1.0, gptVerdict: "KEEP", whisperVerdict: "KEEP" },
      { id: "sp-b", lang: "ml", silent: false, whisperWer: 0, whisperCer: 0, gptWer: 0, gptCer: 0, gptMeanLP: -0.6, gptVerdict: "KEEP", whisperVerdict: "KEEP" },
      { id: "sp-c", lang: "ml", silent: false, whisperWer: 0, whisperCer: 0, gptWer: 0, gptCer: 0, gptMeanLP: -0.2, gptVerdict: "KEEP", whisperVerdict: "KEEP" },
    ];
    expect(summarize(sep, -1.0).calibration.suggestedThreshold).toBeCloseTo(-1.4);
  });
});

describe("dominantScript", () => {
  it("identifies the script a transcript is actually written in", () => {
    expect(dominantScript("വിസിറ്റിംഗ് വിസ എത്രയാണ്?")).toBe("malayalam");
    // The exact drift this harness exists to measure.
    expect(dominantScript("விசிட்டிங் விசா எத்தனை?")).toBe("tamil");
    expect(dominantScript("मुझे दुबई का वीज़ा चाहिए")).toBe("devanagari");
    expect(dominantScript("Привет, как дела?")).toBe("cyrillic");
    expect(dominantScript("Dubai visa ethra aakum?")).toBe("latin");
  });

  it("counts characters, so a loanword does not flip the verdict", () => {
    expect(dominantScript("വിസിറ്റിംഗ് വിസ visa 299!")).toBe("malayalam");
  });

  it("has no opinion on letterless or empty text", () => {
    expect(dominantScript("123 ... !!")).toBeNull();
    expect(dominantScript("")).toBeNull();
    expect(dominantScript(null)).toBeNull();
  });
});
