# Voice-transcription eval & silence-guard calibration harness

**Date:** 2026-07-25
**Surface:** new dev-only scripts under `scripts/voice-eval/` (no app or `convex/` runtime code)
**Related:** `convex/lib/ai/media.ts` (the code under test), branch `fix/whisper-silence-guard`
**Status:** Approved design, ready for implementation planning

## Problem

`convex/lib/ai/media.ts` transcribes inbound voice notes with **`gpt-4o-transcribe`**
(default) and drops results that look hallucinated-over-silence using a **mean
token-logprob threshold of `-1.0`** (`DEFAULT_MIN_AVG_LOGPROB`). Two claims currently
rest on published benchmarks and self-review, not on this bot's own audio:

1. **"`gpt-4o-transcribe` is better than `whisper-1` for Malayalam / Manglish."** True on
   FLEURS (read speech), but our input is spontaneous, low-bitrate WhatsApp Opus, often
   code-switched. Unmeasured here.
2. **The `-1.0` threshold is uncalibrated.** `media.ts:110` says so outright. If real
   noisy Malayalam speech averages below `-1.0`, the guard **drops a real customer
   message** — the failure mode the code explicitly calls worse than letting a
   hallucination through.

This harness measures both against real recordings: word/character error rate per model
per language, and the gpt-4o mean-logprob distribution for speech vs. silence against the
live cutoff.

## Constraints that shape the design

- **No deploy.** Convex here is self-hosted **production**; `convex dev/deploy/codegen`
  are off-limits (`wa-amani-repo-ops-constraints`). So the eval **cannot** add a Convex
  query or action and **cannot** run the models inside Convex. It reads prod read-only
  and runs the models locally.
- **The production helper discards the numbers we need.** `transcribeAudioFromUrl`
  returns text-or-`null`; the per-token `logprobs` and `no_speech_prob` never escape it.
  Calibration needs them raw, so the harness makes its **own** transcription calls —
  byte-for-byte mirroring media.ts's request shape so results transfer.
- **`convex data` is read-only and sufficient.** `npx convex data messages --limit <n>
  --order desc --format jsonl` streams the newest message rows (incl. `contentType`,
  `mediaKey`, `mediaUrl`, `caption`) with no new function. Verified: `jsonl` is a valid
  `--format`.
- **Media download is URL construction.** `convex/lib/r2/url.ts` `publicUrl` builds
  `${R2_PUBLIC_HOST}/${encodeKeySegments(key)}` — a public, fetchable URL (the one the
  inbox renders). No S3 API / R2 listing needed.

## Decisions (locked)

1. **Audio source:** auto-pull real clips from prod via the `convex data` scrape (not
   direct R2 listing, not a local drop-folder).
2. **Rigor:** full WER harness with **human-typed reference transcripts**, plus **CER**
   (character error rate) — Malayalam is agglutinative, so whitespace-token WER alone is
   misleading; CER is the more trustworthy signal.
3. **OpenAI key:** the operator's own key via `OPENAI_API_KEY` env for the run — no
   per-account decrypt, no coupling to `ENCRYPTION_KEY` / `aiConfigs`.
4. **Runtime:** plain `.mjs` run with `node --env-file=.env.local` (Node 22 globals:
   `fetch`, `FormData`, `Blob`, native `--env-file`). No new dependencies; matches the
   repo's existing `scripts/*.mjs` house style.
5. **Two stages, human in the middle:** `pull-samples` → *annotate `manifest.json`* →
   `compare`.

## Chosen approach vs. rejected

- **A — deploy-free two-stage scripts (chosen).** As above.
- **B — reuse `internal.aiReply.untranscribedMediaRows` via `npx convex run`.** Rejected:
  conversation-scoped and *untranscribed-only*, so clips disappear the moment prod
  transcribes them — no stable, re-runnable eval set.
- **C — Convex internal query + action running both models server-side (most
  prod-faithful).** Rejected: requires a deploy to self-hosted prod, and bills the eval
  to the account's runtime/spend.

## Design

### Files (`scripts/voice-eval/`)

```
scripts/voice-eval/
  pull-samples.mjs     # stage 1: enumerate + download real audio, scaffold manifest
  compare.mjs          # stage 2: run both models, score, report
  lib.mjs              # shared pure helpers (no network, no fs) — unit-tested
  lib.test.mjs         # vitest over the pure helpers
  README.md            # run order, env, privacy/cleanup note
  samples/             # gitignored — downloaded clips + manifest.json (PII)
```

`samples/` is separated from the code so a single `.gitignore` line covers all
downloaded audio and the manifest.

### Stage 1 — `pull-samples.mjs`

Data flow:

1. Spawn `npx convex data messages --limit <scan> --order desc --format jsonl`
   (`--scan`, default **2000**; audio is sparse in the stream so we over-scan and filter).
   Read stdout line-by-line as JSON.
2. Keep rows where `contentType === "audio"` **and** (`mediaKey || mediaUrl`); take the
   newest `--want` (default **20**).
3. For each: resolve URL — `publicUrl` from `mediaKey` (re-implemented in `lib.mjs`,
   faithful to `convex/lib/r2/url.ts`), else fall back to `mediaUrl`. Host from
   `R2_PUBLIC_HOST || NEXT_PUBLIC_R2_PUBLIC_HOST`, `https://` prepended if scheme-less.
4. `fetch` bytes; write `samples/<messageId>.<ext>`, ext from `contentType` via the same
   `AUDIO_EXT_BY_CONTENT_TYPE` map as media.ts (default `ogg`).
5. Write/merge `samples/manifest.json`. **Merge, never clobber:** re-running pull adds new
   clips and preserves any `reference`/`lang`/`silent` already annotated (keyed by `id`).

Manifest entry:

```jsonc
{
  "id": "<messageId>",          // filename stem
  "file": "<messageId>.ogg",
  "contentType": "audio/ogg",
  "caption": "<caption or null>",
  "reference": "",              // HUMAN fills: the correct transcript
  "lang": "",                   // HUMAN tags: ml | manglish | en | other
  "silent": false               // HUMAN marks true for a silence/noise clip
}
```

Console tail: `Downloaded N clips. Fill in `reference` + `lang` for each (mark `silent`
on any noise/empty clips), then run compare.mjs.` plus the annotated count.

### Human annotation step

The operator opens `manifest.json`, types the correct transcript into `reference` for
each clip, tags `lang`, and flags any deliberately-silent/noise clip. Un-annotated
entries (empty `reference` and not `silent`) are **skipped with a warning** by stage 2.
Including a few `silent:true` clips is what makes calibration two-sided.

### Stage 2 — `compare.mjs`

For each annotated clip, run **both** models with requests mirroring media.ts exactly:

- **`whisper-1`** — multipart: `file`, `model=whisper-1`, `response_format=verbose_json`.
  Capture `text` and `segments[].no_speech_prob`.
- **`gpt-4o-transcribe`** — multipart: `file`, `model=gpt-4o-transcribe`,
  `response_format=json`, `include[]=logprobs`. Capture `text` and `logprobs[].logprob`.

Model IDs overridable via flags/env, defaulting to this pair.

Per clip compute:
- `WER(reference, hyp)` and `CER(reference, hyp)` for each model (see `lib.mjs`).
- **gpt-4o verdict:** `mean(logprobs) < threshold` → `DROP`, where threshold =
  `AI_TRANSCRIBE_MIN_AVG_LOGPROB` or `-1.0`. Fail-open (no logprobs → `KEEP`), matching
  media.ts.
- **whisper verdict:** all segments `no_speech_prob > 0.6` → `DROP`. Fail-open (no
  segments → `KEEP`).

### `lib.mjs` — pure helpers (unit-tested)

- `publicUrl(host, key)` — scheme-normalize host + per-segment `encodeURIComponent`.
- `extForContentType(ct)` — the media.ts map.
- `normalize(s)` — Unicode NFC, lowercase, strip punctuation, collapse whitespace.
- `wer(ref, hyp)` / `cer(ref, hyp)` — Levenshtein edit distance over word tokens /
  characters of the normalized strings, divided by reference length; defined edge
  behavior for empty reference.
- `meanLogprob(logprobs)` — mean of numeric `logprob`s, or `null` if none.
- `gptVerdict(mean, threshold)` / `whisperVerdict(segments, thr)` — the fail-open rules.

None touch the network or fs, so they're deterministically testable.

### Report (`compare.mjs` stdout)

1. **Per-clip table:** compact, metrics only — `id · lang · whisper WER/CER · gpt4o
   WER/CER · gpt4o meanLP · whisper verdict · gpt4o verdict`. The reference and both
   hypothesis transcripts print only under `--verbose` (20 clips × 3 texts is unreadable
   inline).
2. **Summary:** mean WER and CER per model, **overall and split by `lang`** — this is the
   direct "better for Malayalam / Manglish?" answer.
3. **Calibration:** gpt-4o `meanLP` for `speech` clips vs. `silent` clips against the
   `-1.0` line. Explicitly flag:
   - **FALSE DROP** — a speech clip with `meanLP < threshold` (guard would eat a real
     message — the media.ts:110 risk, realized).
   - **FALSE KEEP** — a `silent` clip with `meanLP >= threshold`.
   If the two sets are separable, suggest a threshold (midpoint of max-silent and
   min-speech) and restate the `AI_TRANSCRIBE_MIN_AVG_LOGPROB` override to set it.

### Error handling

Best-effort per clip in both stages: a failed download, HTTP error, or malformed
response logs a warning and continues — one bad row never aborts the run, mirroring
media.ts's fail-open contract. Missing `OPENAI_API_KEY` or Convex creds fails fast with a
clear message before any work.

### Privacy / PII

Downloads real customer voice notes to disk. Mitigations:
- `scripts/voice-eval/samples/` is gitignored (clips **and** `manifest.json`).
- Targeted `convex data --limit` scrape only — **no** whole-DB `convex export`.
- README documents a one-line cleanup (`rm -rf scripts/voice-eval/samples`) and states
  the clips are real customer audio.

### Env & running

```bash
export OPENAI_API_KEY=sk-...                       # operator's own key
node --env-file=.env.local scripts/voice-eval/pull-samples.mjs --want 20
#   … edit scripts/voice-eval/samples/manifest.json (reference, lang, silent) …
node --env-file=.env.local scripts/voice-eval/compare.mjs
```

`.env.local` supplies `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY` (for the
`convex data` scrape) and the R2 public host.

### Testing

- **`lib.test.mjs` (vitest):** `wer`/`cer` (identical, all-wrong, substitution, empty
  reference), `normalize`, `publicUrl` (scheme-less host, slashes in key),
  `meanLogprob` (empty → null), both verdict fns incl. fail-open branches.
- **Network paths:** exercised by a live run, not mocked — this is a manual dev tool.
- Gate: `npx eslint scripts/voice-eval/*.mjs` clean; `npm test` green.

## Faithfulness-to-prod risk (accepted)

`.mjs` can't import the TypeScript `media.ts` / `url.ts`, so three things are
**re-implemented**: `publicUrl`, `AUDIO_EXT_BY_CONTENT_TYPE`, and the
`response_format`/`include[]` pairing. If media.ts changes these, the harness drifts. A
comment in each script points back to its media.ts / url.ts source of truth; keeping the
harness thin bounds the risk.

## Out of scope (YAGNI)

- No auto language detection — `lang` is hand-tagged (small curated set).
- No image/vision (`gpt-5.6-luna`) eval — this harness is transcription-only.
- No CI wiring, no chart output, no S3/R2 listing.
- No changes to `media.ts` — the harness *informs* a later threshold change; it doesn't
  make one.
