// Stage 2 of the voice-transcription eval. For each clip, runs whisper-1 and
// gpt-4o-transcribe with request shapes mirroring convex/lib/ai/media.ts,
// scores WER/CER + silence verdicts, and prints a report with a calibration
// section for the -1.0 mean-logprob guard.
//
// It ALSO runs the language-rescue arbitration added in e5b9973: a second
// gpt-4o-transcribe pass with `language=ml` forced, compared against the
// auto-detect pass. That section is the one that needs NO human reference
// transcript — "which script did each pass come back in, and which scored
// higher" is directly observable — so it reports on every downloaded clip,
// annotated or not.
//
// Run:
//   OPENAI_API_KEY=sk-... node --env-file=.env.local scripts/voice-eval/compare.mjs [--verbose]
//
// Model overrides (same env knobs as production): AI_TRANSCRIBE_MODEL,
// AI_TRANSCRIBE_MIN_AVG_LOGPROB, AI_TRANSCRIBE_LANGUAGES, plus
// AI_BASELINE_MODEL for the whisper side.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dominantScript,
  scoreClip,
  summarize,
  extForContentType,
  meanLogprob,
  DEFAULT_MIN_AVG_LOGPROB,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, "samples");
const MANIFEST = join(SAMPLES, "manifest.json");
const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const VERBOSE = process.argv.includes("--verbose");

const KEY = process.env.OPENAI_API_KEY;
const WHISPER_MODEL = process.env.AI_BASELINE_MODEL || "whisper-1";
const GPT_MODEL = process.env.AI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
const RESCUE = (process.env.AI_TRANSCRIBE_LANGUAGES ?? "ml")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
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
if (manifest.length === 0) {
  console.error("Manifest is empty — run pull-samples.mjs first.");
  process.exit(1);
}

/** One transcription call, mirroring media.ts's response_format/include pairing.
 *  useLogprobs=true → gpt-4o family (json + logprobs); false → whisper (verbose_json).
 *  `language` is the ISO-639-1 rescue hint, or null for the auto-detect pass. */
async function transcribe(file, contentType, model, useLogprobs, language = null) {
  const bytes = readFileSync(join(SAMPLES, file));
  const form = new FormData();
  form.append("file", new Blob([bytes]), `voice-note.${extForContentType(contentType)}`);
  form.append("model", model);
  form.append("response_format", useLogprobs ? "json" : "verbose_json");
  if (useLogprobs) form.append("include[]", "logprobs");
  if (language) form.append("language", language);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },
    body: form,
  });
  if (!res.ok) {
    console.warn(`  ${model}/${language ?? "auto"} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  return res.json();
}

const scored = [];
const rescueRows = [];
for (const clip of manifest) {
  console.error(`Transcribing ${clip.id} (${clip.lang || "?"})…`);
  const w = await transcribe(clip.file, clip.contentType, WHISPER_MODEL, false);
  const g = await transcribe(clip.file, clip.contentType, GPT_MODEL, true);
  // The rescue passes — one per configured language, same clip.
  const forced = [];
  for (const lang of RESCUE) {
    const f = await transcribe(clip.file, clip.contentType, GPT_MODEL, true, lang);
    forced.push({
      lang,
      text: f?.text ?? "",
      script: dominantScript(f?.text ?? ""),
      meanLP: meanLogprob(f?.logprobs ?? []),
    });
  }

  const autoText = g?.text ?? "";
  const autoLP = meanLogprob(g?.logprobs ?? []);
  // Mirror of pickAttempt's rule 2 in convex/lib/ai/media.ts: auto-detect is
  // the incumbent and a forced pass must beat it STRICTLY. (Rule 1 — the
  // implausible-script exclusion — is reported rather than applied here, so
  // the raw drift stays visible.)
  let winner = { lang: "auto", text: autoText, script: dominantScript(autoText), meanLP: autoLP };
  for (const f of forced) {
    if (typeof f.meanLP === "number" && typeof winner.meanLP === "number" && f.meanLP > winner.meanLP) {
      winner = f;
    }
  }
  rescueRows.push({ id: clip.id, lang: clip.lang, auto: { text: autoText, script: dominantScript(autoText), meanLP: autoLP }, forced, winner });

  if (clip.silent === true || (clip.reference ?? "").trim() !== "") {
    scored.push(
      scoreClip(
        {
          id: clip.id,
          lang: clip.lang,
          silent: clip.silent,
          reference: clip.reference,
          whisperText: w?.text ?? "",
          whisperSegments: w?.segments ?? [],
          gptText: g?.text ?? "",
          gptLogprobs: g?.logprobs ?? [],
        },
        threshold,
      ),
    );
  }
  if (VERBOSE) {
    console.log(`\n[${clip.id}] ref:   ${clip.reference || "(unannotated)"}`);
    console.log(`  ${WHISPER_MODEL}: ${w?.text ?? "(none)"}`);
    console.log(`  ${GPT_MODEL}/auto: ${autoText || "(none)"}`);
    for (const f of forced) console.log(`  ${GPT_MODEL}/${f.lang}: ${f.text || "(none)"}`);
  }
}

const pct = (n) => `${(n * 100).toFixed(0)}%`;
const lp = (n) => (typeof n === "number" ? n.toFixed(2) : " n/a");

// --- language rescue (needs no reference transcripts) ---
console.log(`\n=== language rescue: auto-detect vs forced [${RESCUE.join(", ")}] (${GPT_MODEL}) ===`);
console.log("id                 auto script  auto LP   forced script  forced LP   winner");
for (const r of rescueRows) {
  const f = r.forced[0];
  console.log(
    [
      r.id.slice(0, 18).padEnd(18),
      (r.auto.script ?? "-").padEnd(12),
      lp(r.auto.meanLP).padStart(7),
      `   ${(f?.script ?? "-").padEnd(13)}`,
      lp(f?.meanLP).padStart(9),
      `   ${r.winner.lang}`,
    ].join(" "),
  );
}
const drifted = rescueRows.filter((r) => r.auto.script && ["tamil", "kannada", "telugu"].includes(r.auto.script));
const rescued = rescueRows.filter((r) => r.winner.lang !== "auto");
console.log(`\n  auto-detect produced a Tamil/Kannada/Telugu transcript on ${drifted.length}/${rescueRows.length} clip(s).`);
console.log(`  a forced pass won (scored strictly higher) on ${rescued.length}/${rescueRows.length} clip(s).`);
const rescuedDrift = drifted.filter((r) => r.winner.lang !== "auto").length;
if (drifted.length > 0) {
  console.log(`  of the drifted clips, the rescue took over on ${rescuedDrift}/${drifted.length} — this is the fix working (or not).`);
}

if (scored.length === 0) {
  console.log('\n(no annotated clips — WER/CER and calibration skipped; set "reference"/"silent" in manifest.json)');
  process.exit(0);
}

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
