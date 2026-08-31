# Voice-Transcription Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deploy-free dev harness that measures `gpt-4o-transcribe` vs `whisper-1` (WER/CER by language) on real WhatsApp voice notes and calibrates the `-1.0` mean-logprob silence guard in `convex/lib/ai/media.ts`.

**Architecture:** Two standalone `.mjs` scripts over a pure, unit-tested `lib.mjs`. Stage 1 (`pull-samples`) scrapes recent audio rows from prod read-only via `npx convex data`, downloads clips via their public R2 URL, and scaffolds a manifest. A human types reference transcripts into the manifest. Stage 2 (`compare`) runs both models locally on the operator's own OpenAI key, scores each clip, and prints a report with a calibration section.

**Tech Stack:** Node 22 (`node --env-file`, global `fetch`/`FormData`/`Blob`), vitest 4 (already installed), the `convex` CLI (already installed). **No new dependencies.**

## Global Constraints

- **No `convex dev` / `deploy` / `codegen`** — self-hosted production. Scripts read prod only (`convex data`, read-only). Copied from `wa-amani-repo-ops-constraints`.
- **Stage git paths explicitly** — never `git add -A` / `git add .`. The working tree holds other sessions' WIP. Stage only the exact files each task lists.
- **Lint scoped to changed files:** `npx eslint scripts/voice-eval/*.mjs`, not `npm run lint`.
- **Plain `.mjs`, ESM, no new deps.** Node 22 globals only.
- **Faithful mirrors:** `publicUrl`, the audio ext map, the silence thresholds (`-1.0`, `0.6`), and the `response_format`/`include[]` pairing must match `convex/lib/ai/media.ts` and `convex/lib/r2/url.ts` exactly. Each mirror carries a comment pointing at its source of truth.
- **Test discovery:** `vitest.config.ts` uses explicit `projects` (`src`, `convex`), so a test outside those include globs is **silently never discovered**. Task 1 added a third `scripts` project (node env, `include: ["scripts/**/*.test.mjs"]`) — it is already in place; do not re-add it. Run just this file with `npx vitest run scripts/voice-eval/lib.test.mjs`.

---

### Task 1: `lib.mjs` — metric & media helpers

**Files:**
- Create: `scripts/voice-eval/lib.mjs`
- Test: `scripts/voice-eval/lib.test.mjs`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `normalize(s: string): string`
  - `wer(reference: string, hypothesis: string): number`
  - `cer(reference: string, hypothesis: string): number`
  - `meanLogprob(logprobs: {logprob?: number}[]): number | null`
  - `extForContentType(contentType: string | null): string`
  - `publicUrl(host: string, key: string): string`

- [ ] **Step 1: Write the failing tests**

Create `scripts/voice-eval/lib.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { normalize, wer, cer, meanLogprob, extForContentType, publicUrl } from "./lib.mjs";

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
});

describe("cer", () => {
  it("counts character edits ignoring spaces", () => {
    expect(cer("abc", "abd")).toBeCloseTo(1 / 3);
  });
  it("is 0 for identical", () => {
    expect(cer("hello", "hello")).toBe(0);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/voice-eval/lib.test.mjs`
Expected: FAIL — `Failed to resolve import "./lib.mjs"` (file does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `scripts/voice-eval/lib.mjs`:

```js
// Pure helpers for the voice-transcription eval harness. No network, no fs.
// Faithful re-implementations of logic in convex/lib/ai/media.ts and
// convex/lib/r2/url.ts (an .mjs script cannot import the TS sources) — if those
// change, change these to match. See the plan's "Faithful mirrors" constraint.

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
 *  letters/marks/numbers of ANY script, incl. Malayalam), collapse whitespace. */
export function normalize(s) {
  return (s ?? "")
    .normalize("NFC")
    .toLowerCase()
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/voice-eval/lib.test.mjs`
Expected: PASS — all describe blocks green.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint scripts/voice-eval/lib.mjs scripts/voice-eval/lib.test.mjs
git add scripts/voice-eval/lib.mjs scripts/voice-eval/lib.test.mjs
git commit -m "feat(voice-eval): metric & media helpers (wer/cer/logprob/url)"
```

---

### Task 2: `lib.mjs` — selection, manifest, scoring & summary

**Files:**
- Modify: `scripts/voice-eval/lib.mjs` (append)
- Modify: `scripts/voice-eval/lib.test.mjs` (append)

**Interfaces:**
- Consumes (from Task 1): `wer`, `cer`, `meanLogprob`, `extForContentType`.
- Produces:
  - `DEFAULT_MIN_AVG_LOGPROB = -1.0`, `NO_SPEECH_PROB_THRESHOLD = 0.6`
  - `selectAudioRows(rows: object[], want: number): object[]`
  - `manifestEntry(row: object): {id,file,contentType,caption,reference,lang,silent}`
  - `mergeManifest(existing: object[], fresh: object[]): object[]`
  - `annotatedClips(manifest: object[]): object[]`
  - `gptVerdict(mean: number|null, threshold?: number): "DROP"|"KEEP"`
  - `whisperVerdict(segments: {no_speech_prob?: number}[], threshold?: number): "DROP"|"KEEP"`
  - `scoreClip(clip, threshold?: number): object` — clip has `{id,lang,silent,reference,whisperText,whisperSegments,gptText,gptLogprobs}`; returns `{id,lang,silent,whisperWer,whisperCer,gptWer,gptCer,gptMeanLP,whisperVerdict,gptVerdict}`
  - `summarize(scored: object[], threshold?: number): {perLang, calibration, threshold}`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/voice-eval/lib.test.mjs`:

```js
import {
  selectAudioRows, manifestEntry, mergeManifest, annotatedClips,
  gptVerdict, whisperVerdict, scoreClip, summarize,
} from "./lib.mjs";

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
  it("suggests no threshold when speech and silence overlap", () => {
    // silent max -0.9 is NOT below speech min -1.2 → not separable
    expect(summarize(scored, -1.0).calibration.suggestedThreshold).toBeNull();
  });
  it("suggests the midpoint when separable", () => {
    const sep = [
      { id: "a", lang: "ml", silent: false, whisperWer: 0, whisperCer: 0, gptWer: 0, gptCer: 0, gptMeanLP: -0.4, gptVerdict: "KEEP", whisperVerdict: "KEEP" },
      { id: "b", lang: "other", silent: true, whisperWer: 1, whisperCer: 1, gptWer: 1, gptCer: 1, gptMeanLP: -2.0, gptVerdict: "DROP", whisperVerdict: "DROP" },
    ];
    expect(summarize(sep, -1.0).calibration.suggestedThreshold).toBeCloseTo(-1.2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run scripts/voice-eval/lib.test.mjs`
Expected: FAIL — the new imports (`selectAudioRows`, `summarize`, …) are undefined.

- [ ] **Step 3: Write the implementation**

Append to `scripts/voice-eval/lib.mjs`:

```js
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
```

No import statement is needed for `wer`, `cer`, `meanLogprob`, or `extForContentType` — they are defined above in the same module (Task 1). In the **test** file, merge the new symbols into the existing `./lib.mjs` import rather than adding a second import statement from the same module.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run scripts/voice-eval/lib.test.mjs`
Expected: PASS — all Task 1 + Task 2 blocks green.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint scripts/voice-eval/lib.mjs scripts/voice-eval/lib.test.mjs
git add scripts/voice-eval/lib.mjs scripts/voice-eval/lib.test.mjs
git commit -m "feat(voice-eval): selection, manifest, scoring & calibration summary"
```

---

### Task 3: `pull-samples.mjs` — pull real clips & scaffold manifest

**Files:**
- Create: `scripts/voice-eval/pull-samples.mjs`
- Modify: `.gitignore` (append)

**Interfaces:**
- Consumes (from Tasks 1–2): `selectAudioRows`, `manifestEntry`, `mergeManifest`, `publicUrl`.
- Produces: `scripts/voice-eval/samples/<id>.<ext>` clips + `samples/manifest.json`. No exported symbols (entry-point script).

> **Not unit-tested:** this is `child_process` + `fetch` + `fs` glue. The spec verifies it by a live run (Step 4). The logic it depends on (`selectAudioRows`, `mergeManifest`, …) is already tested in Tasks 1–2.

- [ ] **Step 1: Add the gitignore rule**

Append to `.gitignore`:

```gitignore
# voice-eval harness — downloaded real customer audio (PII) + annotations
scripts/voice-eval/samples/
```

- [ ] **Step 2: Write the script**

Create `scripts/voice-eval/pull-samples.mjs`:

```js
// Stage 1 of the voice-transcription eval. Pulls recent real audio message rows
// from the (self-hosted, production) Convex deployment READ-ONLY via the convex
// CLI, downloads each clip from its public R2 URL, and scaffolds a manifest for
// human reference annotation.
//
// Run:
//   node --env-file=.env.local scripts/voice-eval/pull-samples.mjs [--want 20] [--scan 2000]
//
// Reads from env (via --env-file): CONVEX_SELF_HOSTED_URL, CONVEX_SELF_HOSTED_ADMIN_KEY
// (the convex CLI reads these itself), and R2_PUBLIC_HOST / NEXT_PUBLIC_R2_PUBLIC_HOST.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { selectAudioRows, manifestEntry, mergeManifest, publicUrl } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, "samples");
const MANIFEST = join(SAMPLES, "manifest.json");

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const want = Number(flag("want", "20"));
const scan = Number(flag("scan", "2000"));
const host = process.env.R2_PUBLIC_HOST || process.env.NEXT_PUBLIC_R2_PUBLIC_HOST;

if (!host) {
  console.error("Missing R2_PUBLIC_HOST / NEXT_PUBLIC_R2_PUBLIC_HOST — run with --env-file=.env.local");
  process.exit(1);
}
if (!process.env.CONVEX_SELF_HOSTED_URL || !process.env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
  console.error("Missing CONVEX_SELF_HOSTED_URL / CONVEX_SELF_HOSTED_ADMIN_KEY — run with --env-file=.env.local");
  process.exit(1);
}

// 1. Scrape the newest message rows (read-only). The convex CLI inherits the
//    CONVEX_SELF_HOSTED_* env vars; --format jsonl prints one JSON row per line.
console.error(`Scanning newest ${scan} messages for audio…`);
const raw = execFileSync(
  "npx",
  ["convex", "data", "messages", "--limit", String(scan), "--order", "desc", "--format", "jsonl"],
  { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
);
const rows = raw
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
const picked = selectAudioRows(rows, want);
console.error(`Parsed ${rows.length} rows; found ${picked.length} audio clip(s) (want ${want}).`);

// 2. Download each clip to samples/<id>.<ext>.
mkdirSync(SAMPLES, { recursive: true });
const fresh = [];
for (const row of picked) {
  const entry = manifestEntry(row);
  const url = row.mediaKey ? publicUrl(host, row.mediaKey) : row.mediaUrl;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  skip ${entry.id}: HTTP ${res.status}`);
      continue;
    }
    writeFileSync(join(SAMPLES, entry.file), Buffer.from(await res.arrayBuffer()));
    fresh.push(entry);
  } catch (e) {
    console.warn(`  skip ${entry.id}: ${e.message}`);
  }
}

// 3. Merge into the manifest, preserving any annotations already made.
const existing = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : [];
const merged = mergeManifest(existing, fresh);
writeFileSync(MANIFEST, `${JSON.stringify(merged, null, 2)}\n`);

const annotated = merged.filter((e) => e.silent || (e.reference ?? "").trim()).length;
console.log(`Downloaded ${fresh.length} clip(s) to scripts/voice-eval/samples/.`);
console.log(`Manifest: ${merged.length} entr(ies), ${annotated} annotated.`);
console.log(`Next: edit ${MANIFEST} — set "reference" + "lang" (ml|manglish|en|other) per clip,`);
console.log(`      set "silent": true on any noise/empty clip — then run compare.mjs.`);
```

- [ ] **Step 3: Lint**

Run: `npx eslint scripts/voice-eval/pull-samples.mjs`
Expected: clean (no errors).

- [ ] **Step 4: Live verification run**

Run: `node --env-file=.env.local scripts/voice-eval/pull-samples.mjs --want 5 --scan 1000`
Expected: prints "Downloaded N clip(s)…"; `scripts/voice-eval/samples/manifest.json` exists with N entries, each with blank `reference`/`lang` and `silent:false`; N audio files sit alongside it. If it prints "found 0 audio clips", raise `--scan` (audio is sparse in the message stream).

Verify: `cat scripts/voice-eval/samples/manifest.json` shows well-formed entries; `git status --short scripts/voice-eval/samples` shows **nothing** (gitignored).

- [ ] **Step 5: Commit** (script + gitignore only — never the samples)

```bash
git add scripts/voice-eval/pull-samples.mjs .gitignore
git commit -m "feat(voice-eval): pull-samples stage — scrape prod audio, scaffold manifest"
```

---

### Task 4: `compare.mjs` — run both models, score, report

**Files:**
- Create: `scripts/voice-eval/compare.mjs`
- Create: `scripts/voice-eval/README.md`

**Interfaces:**
- Consumes (from Tasks 1–2): `annotatedClips`, `scoreClip`, `summarize`, `extForContentType`, `DEFAULT_MIN_AVG_LOGPROB`.
- Produces: a stdout report. No exported symbols (entry-point script).

> **Not unit-tested:** `fetch` to the OpenAI API + `fs`. Verified by a live run (Step 3). All scoring/summary logic it calls is tested in Tasks 1–2; `compare.mjs` only does I/O and formatting.

- [ ] **Step 1: Write the script**

Create `scripts/voice-eval/compare.mjs`:

```js
// Stage 2 of the voice-transcription eval. For each annotated clip, runs
// whisper-1 and gpt-4o-transcribe with request shapes mirroring
// convex/lib/ai/media.ts, scores WER/CER + silence verdicts, and prints a
// report with a calibration section for the -1.0 mean-logprob guard.
//
// Run:
//   OPENAI_API_KEY=sk-... node --env-file=.env.local scripts/voice-eval/compare.mjs [--verbose]
//
// Model overrides (same env knobs as production): AI_TRANSCRIBE_MODEL,
// AI_TRANSCRIBE_MIN_AVG_LOGPROB, plus AI_BASELINE_MODEL for the whisper side.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotatedClips, scoreClip, summarize, extForContentType, DEFAULT_MIN_AVG_LOGPROB,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, "samples");
const MANIFEST = join(SAMPLES, "manifest.json");
const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const VERBOSE = process.argv.includes("--verbose");

const KEY = process.env.OPENAI_API_KEY;
const WHISPER_MODEL = process.env.AI_BASELINE_MODEL || "whisper-1";
const GPT_MODEL = process.env.AI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const envThr = Number(process.env.AI_TRANSCRIBE_MIN_AVG_LOGPROB);
const threshold = Number.isFinite(envThr) ? envThr : DEFAULT_MIN_AVG_LOGPROB;

if (!KEY) {
  console.error("Missing OPENAI_API_KEY (export your own key for this run).");
  process.exit(1);
}
if (!existsSync(MANIFEST)) {
  console.error(`No manifest at ${MANIFEST} — run pull-samples.mjs first.`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const clips = annotatedClips(manifest);
if (clips.length === 0) {
  console.error('No annotated clips — set "reference"/"silent" in manifest.json first.');
  process.exit(1);
}

/** One transcription call, mirroring media.ts's response_format/include pairing.
 *  useLogprobs=true → gpt-4o family (json + logprobs); false → whisper (verbose_json). */
async function transcribe(file, contentType, model, useLogprobs) {
  const bytes = readFileSync(join(SAMPLES, file));
  const form = new FormData();
  form.append("file", new Blob([bytes]), `voice-note.${extForContentType(contentType)}`);
  form.append("model", model);
  form.append("response_format", useLogprobs ? "json" : "verbose_json");
  if (useLogprobs) form.append("include[]", "logprobs");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  });
  if (!res.ok) {
    console.warn(`  ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  return res.json();
}

const scored = [];
for (const clip of clips) {
  console.error(`Transcribing ${clip.id} (${clip.lang || "?"})…`);
  const w = await transcribe(clip.file, clip.contentType, WHISPER_MODEL, false);
  const g = await transcribe(clip.file, clip.contentType, GPT_MODEL, true);
  scored.push(
    scoreClip(
      {
        id: clip.id, lang: clip.lang, silent: clip.silent, reference: clip.reference,
        whisperText: w?.text ?? "", whisperSegments: w?.segments ?? [],
        gptText: g?.text ?? "", gptLogprobs: g?.logprobs ?? [],
      },
      threshold,
    ),
  );
  if (VERBOSE) {
    console.log(`\n[${clip.id}] ref:   ${clip.reference}`);
    console.log(`  ${WHISPER_MODEL}: ${w?.text ?? "(none)"}`);
    console.log(`  ${GPT_MODEL}: ${g?.text ?? "(none)"}`);
  }
}

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const lp = (n) => (typeof n === "number" ? n.toFixed(2) : " n/a");

// --- per-clip table ---
console.log(`\n=== per clip (whisper=${WHISPER_MODEL}, gpt=${GPT_MODEL}) ===`);
console.log("id                 lang      wsp WER/CER   gpt WER/CER   gpt meanLP  wsp/gpt verdict");
for (const s of scored) {
  console.log(
    [
      s.id.slice(0, 18).padEnd(18),
      (s.lang || "?").padEnd(9),
      `${pct(s.whisperWer)}/${pct(s.whisperCer)}`.padEnd(13),
      `${pct(s.gptWer)}/${pct(s.gptCer)}`.padEnd(13),
      lp(s.gptMeanLP).padStart(9),
      `   ${s.whisperVerdict}/${s.gptVerdict}${s.silent ? " (silent)" : ""}`,
    ].join(" "),
  );
}

// --- summary ---
const sum = summarize(scored, threshold);
console.log("\n=== mean error rate by language (speech clips) ===");
for (const [lang, g] of Object.entries(sum.perLang)) {
  console.log(
    `  ${lang.padEnd(9)} n=${g.n}  whisper ${pct(g.whisperWer)}/${pct(g.whisperCer)}  ` +
      `gpt ${pct(g.gptWer)}/${pct(g.gptCer)}   (WER/CER)`,
  );
}

// --- calibration ---
const c = sum.calibration;
console.log(`\n=== silence-guard calibration (threshold ${threshold}) ===`);
console.log(`  speech gpt meanLP: [${c.speechLPs.map((n) => n.toFixed(2)).join(", ")}]`);
console.log(`  silent gpt meanLP: [${c.silentLPs.map((n) => n.toFixed(2)).join(", ")}]`);
if (c.falseDrops.length) {
  console.log(`  ⚠ FALSE DROPS (real speech below threshold → message would be lost): ${c.falseDrops.join(", ")}`);
} else {
  console.log("  ✓ no false drops (no speech clip fell below threshold)");
}
if (c.falseKeeps.length) {
  console.log(`  ⚠ FALSE KEEPS (silent clip kept): ${c.falseKeeps.join(", ")}`);
} else {
  console.log("  ✓ no false keeps");
}
if (c.suggestedThreshold !== null) {
  console.log(`  → speech/silence are separable; suggested AI_TRANSCRIBE_MIN_AVG_LOGPROB=${c.suggestedThreshold.toFixed(2)}`);
} else {
  console.log("  → speech and silence overlap on this set; no clean threshold — collect more/clearer silent clips.");
}
```

- [ ] **Step 2: Lint**

Run: `npx eslint scripts/voice-eval/compare.mjs`
Expected: clean.

- [ ] **Step 3: Live verification run** (needs Task 3's clips + at least one annotated `reference`)

```bash
# annotate at least one clip first: set "reference" and "lang" in samples/manifest.json
OPENAI_API_KEY=sk-... node --env-file=.env.local scripts/voice-eval/compare.mjs --verbose
```

Expected: per-clip table prints with non-`n/a` `gpt meanLP` values and `KEEP`/`DROP` verdicts; the "mean error rate by language" and "silence-guard calibration" sections print. A clip with a good reference should show gpt WER/CER well under 100%. If every row shows `gpt meanLP n/a`, the `include[]=logprobs` request shape has drifted from media.ts — stop and reconcile.

- [ ] **Step 4: Write the README**

Create `scripts/voice-eval/README.md`:

```markdown
# voice-eval — transcription model comparison & silence-guard calibration

Dev-only harness. Measures `gpt-4o-transcribe` vs `whisper-1` (WER/CER by
language) on **real** WhatsApp voice notes, and calibrates the `-1.0`
mean-logprob silence guard in `convex/lib/ai/media.ts`.

## Prerequisites
- `.env.local` with `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`,
  and `R2_PUBLIC_HOST` (or `NEXT_PUBLIC_R2_PUBLIC_HOST`).
- Your own `OPENAI_API_KEY` exported in the shell.
- Node 22+ (native `--env-file`, global `fetch`/`FormData`/`Blob`).

## Run order
1. **Pull real clips** (read-only prod scrape → `samples/` + `manifest.json`):
   `node --env-file=.env.local scripts/voice-eval/pull-samples.mjs --want 20`
2. **Annotate** `samples/manifest.json`: type the correct transcript into
   `reference`, tag `lang` (`ml`|`manglish`|`en`|`other`), set `silent: true`
   on any noise/empty clip (include a few — they anchor the calibration).
3. **Compare** (runs both models on your key):
   `OPENAI_API_KEY=sk-... node --env-file=.env.local scripts/voice-eval/compare.mjs --verbose`

## Reading the output
- **mean error rate by language** — the direct "better for Malayalam / Manglish?"
  answer. CER is more trustworthy than WER for Malayalam (agglutinative).
- **silence-guard calibration** — FALSE DROPS are real speech the `-1.0` guard
  would discard (the risk `media.ts` flags). A suggested threshold prints when
  speech and silence separate cleanly; set it via `AI_TRANSCRIBE_MIN_AVG_LOGPROB`.

## Privacy
`samples/` holds **real customer voice notes (PII)** and is gitignored. Delete
when done: `rm -rf scripts/voice-eval/samples`.

## Faithfulness
`lib.mjs` re-implements `publicUrl`, the audio ext map, the silence thresholds,
and the `response_format`/`include[]` pairing from `convex/lib/ai/media.ts` /
`convex/lib/r2/url.ts` (an `.mjs` can't import the TS). If those change, update
`lib.mjs` to match.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/voice-eval/compare.mjs scripts/voice-eval/README.md
git commit -m "feat(voice-eval): compare stage — run both models, WER/CER + calibration report"
```

---

## Self-Review

**1. Spec coverage:**
- Deploy-free / read-only prod scrape → Task 3 (`convex data`). ✓
- Own OpenAI key via `OPENAI_API_KEY` → Task 4. ✓
- `node --env-file`, no new deps → all tasks. ✓
- Two-stage with human annotation → Tasks 3 (pull) + 4 (compare); manifest schema in Task 2 `manifestEntry`. ✓
- Auto-pull via `convex data` (not R2 listing) → Task 3. ✓
- WER **and** CER → Task 1 (`wer`/`cer`), reported in Task 4. ✓
- gpt-4o logprob capture + `-1.0` verdict, fail-open → Task 2 (`gptVerdict`, `meanLogprob`). ✓
- whisper `verbose_json` + `no_speech_prob > 0.6`, fail-open → Task 2 (`whisperVerdict`). ✓
- Request shapes mirror media.ts → Task 4 `transcribe`. ✓
- Calibration: false drop/keep + suggested threshold → Task 2 (`summarize`), reported in Task 4. ✓
- Per-language summary → Task 2 (`summarize.perLang`), reported in Task 4. ✓
- PII gitignore + cleanup note → Task 3 (gitignore) + Task 4 (README). ✓
- Faithfulness comments → Tasks 1, 3, 4 headers + README. ✓
- Unit tests on pure fns only; network by live run → Tasks 1–2 tested, 3–4 live-verified. ✓

**2. Placeholder scan:** No TBD/TODO. `sk-...` is an intentional user-supplied secret placeholder in run commands, not a plan gap. Every code step shows complete code.

**3. Type consistency:** `scoreClip` consumes `{whisperText, whisperSegments, gptText, gptLogprobs}` — produced verbatim by Task 4's `transcribe` mapping. `summarize` reads `s.gptVerdict`/`s.silent`/`s.lang`/`s.gptMeanLP` — all produced by `scoreClip`. `manifestEntry` output shape (`id/file/contentType/caption/reference/lang/silent`) is what `annotatedClips` filters and Task 4 reads. `publicUrl(host, key)`, `extForContentType(ct)`, `meanLogprob(logprobs)` names identical across definition (Task 1) and use (Tasks 2–4). Consistent.
