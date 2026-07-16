// One-off: rasterize public/icon.svg into the PWA/notification PNGs.
// Run: node scripts/generate-pwa-icons.mjs
import sharp from "sharp";
import { readFile } from "node:fs/promises";

const svg = await readFile(new URL("../public/icon.svg", import.meta.url));

const outputs = [
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
  { file: "apple-touch-icon.png", size: 180 },
];

for (const { file, size } of outputs) {
  await sharp(svg).resize(size, size).png().toFile(new URL(`../public/${file}`, import.meta.url).pathname);
  console.log("wrote", file);
}

// Maskable: same art on a full-bleed brand background with ~20% safe padding.
await sharp({
  create: { width: 512, height: 512, channels: 4, background: "#4f46e5" },
})
  .composite([{ input: await sharp(svg).resize(320, 320).png().toBuffer(), gravity: "center" }])
  .png()
  .toFile(new URL("../public/icon-maskable-512.png", import.meta.url).pathname);
console.log("wrote icon-maskable-512.png");

// Badge: monochrome white glyph on transparent (Android status bar).
const badgeSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="#ffffff" d="M160 150h192a34 34 0 0 1 34 34v120a34 34 0 0 1-34 34H236l-64 52v-52h-12a34 34 0 0 1-34-34V184a34 34 0 0 1 34-34z"/></svg>`,
);
await sharp(badgeSvg).resize(72, 72).png().toFile(new URL("../public/badge-72.png", import.meta.url).pathname);
console.log("wrote badge-72.png");
