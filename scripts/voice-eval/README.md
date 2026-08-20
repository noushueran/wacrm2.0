# voice-eval — transcription model comparison & silence-guard calibration

Dev-only harness. Measures `gpt-4o-transcribe` vs `whisper-1` (WER/CER by
language) on **real** WhatsApp voice notes, calibrates the `-1.0`
mean-logprob silence guard in `convex/lib/ai/media.ts`, and validates the
**language-rescue** arbitration added in `e5b9973`.

## Prerequisites

- `.env.local` with `CONVEX_SELF_HOSTED_URL`, `CONVEX_SELF_HOSTED_ADMIN_KEY`,
  and `R2_PUBLIC_HOST` (or `NEXT_PUBLIC_R2_PUBLIC_HOST`).
- An `OPENAI_API_KEY` — add it to `.env.local` (gitignored) or export it.
- Node 22+ (native `--env-file`, global `fetch`/`FormData`/`Blob`).

## Run order

1. **Pull real clips** (read-only prod scrape → `samples/` + `manifest.json`):

   ```bash
   node --env-file=.env.local scripts/voice-eval/pull-samples.mjs --want 20
   ```

2. **Annotate** `samples/manifest.json` — *optional for the language-rescue
   section, required for WER/CER*: type the correct transcript into
   `reference`, tag `lang` (`ml`|`manglish`|`en`|`other`), set `silent: true`
   on any noise/empty clip (include a few — they anchor the calibration).

3. **Compare** (runs the models on your key):

   ```bash
   node --env-file=.env.local scripts/voice-eval/compare.mjs --verbose
   ```

## Reading the output

- **language rescue** — the section that needs **no reference transcripts**.
  For each clip it prints the dominant script and mean logprob of the
  auto-detect pass vs the forced `language=ml` pass, and which one wins.
  `auto script = tamil` is the owner-reported bug reproducing; the rescue is
  working when those rows show `winner = ml` with a Malayalam script.
- **mean error rate by language** — the direct "better for Malayalam /
  Manglish?" answer. CER is more trustworthy than WER for Malayalam
  (agglutinative).
- **silence-guard calibration** — FALSE DROPS are real speech the `-1.0` guard
  would discard (the risk `media.ts` flags). A suggested threshold prints when
  speech and silence separate cleanly; set it via
  `AI_TRANSCRIBE_MIN_AVG_LOGPROB`.

## Cost

Each clip costs three transcription calls (whisper baseline + gpt auto + gpt
forced). At OpenAI's per-minute audio rates, 20–30 short voice notes is well
under a dollar.

## Privacy

`samples/` holds **real customer voice notes (PII)** and is gitignored. Delete
when done:

```bash
rm -rf scripts/voice-eval/samples
```

## Faithfulness

`lib.mjs` re-implements logic that lives in TypeScript under `convex/`
(`dominantScript`, the audio extension map, the silence thresholds, the
`response_format`/`include[]` pairing, `publicUrl`). An `.mjs` script cannot
import the TS sources, so these are **mirrors** — each carries a comment
pointing at its source of truth. If `convex/lib/ai/media.ts` changes, change
them to match.
