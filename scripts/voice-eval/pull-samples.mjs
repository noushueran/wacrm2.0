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
//
// The downloaded clips are REAL CUSTOMER VOICE NOTES — `samples/` is gitignored
// and must stay that way.
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
  console.error(
    "Missing R2_PUBLIC_HOST / NEXT_PUBLIC_R2_PUBLIC_HOST — run with --env-file=.env.local",
  );
  process.exit(1);
}
if (!process.env.CONVEX_SELF_HOSTED_URL || !process.env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
  console.error(
    "Missing CONVEX_SELF_HOSTED_URL / CONVEX_SELF_HOSTED_ADMIN_KEY — run with --env-file=.env.local",
  );
  process.exit(1);
}

// 1. Scrape the newest message rows (read-only). The convex CLI inherits the
//    CONVEX_SELF_HOSTED_* env vars; jsonLines prints one JSON row per line.
console.error(`Scanning newest ${scan} messages for audio…`);
const raw = execFileSync(
  "npx",
  ["convex", "data", "messages", "--limit", String(scan), "--order", "desc", "--format", "jsonLines"],
  { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
);
const rows = raw
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
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
