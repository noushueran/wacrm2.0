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

// ---------------------------------------------------------------------
// iOS launch images (`apple-touch-startup-image`).
//
// Without these iOS paints a blank `background_color` screen for the
// whole cold boot — and a cold boot is a network fetch of the app shell,
// so on a weak connection that blank screen is the first and longest
// thing an agent sees. Android and desktop derive a splash from the
// manifest and need none of this; iOS still wants one bitmap per device
// size, matched by media query.
//
// Portrait only, deliberately: the app is installed on phones from the
// home screen in portrait, and doubling the asset count to cover a
// landscape launch nobody performs is not worth the bytes.
const SPLASH_BG = "#020617"; // must equal manifest background_color
const LOGO_FRACTION = 0.26; // logo width as a share of the device width

// [cssWidth, cssHeight, dpr] — the devices this CRM is actually opened
// on, newest first. An unmatched device simply falls back to the blank
// background, i.e. today's behaviour.
const SPLASH_DEVICES = [
  [440, 956, 3], // iPhone 16 Pro Max / 15 Pro Max
  [402, 874, 3], // iPhone 16 Pro / 15 Pro
  [430, 932, 3], // iPhone 14 Pro Max
  [393, 852, 3], // iPhone 14 Pro / 15
  [428, 926, 3], // iPhone 12/13 Pro Max
  [390, 844, 3], // iPhone 12/13/14
  [375, 812, 3], // iPhone X/XS/11 Pro/mini
  [414, 896, 2], // iPhone XR/11
  [375, 667, 2], // iPhone SE
  [768, 1024, 2], // iPad
];

for (const [cssW, cssH, dpr] of SPLASH_DEVICES) {
  const w = cssW * dpr;
  const h = cssH * dpr;
  const logo = Math.round(w * LOGO_FRACTION);
  await sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: SPLASH_BG,
    },
  })
    .composite([
      { input: await sharp(svg).resize(logo, logo).png().toBuffer(), gravity: "centre" },
    ])
    .png()
    .toFile(
      new URL(`../public/splash/apple-splash-${w}-${h}.png`, import.meta.url)
        .pathname,
    );
  console.log("wrote", `splash/apple-splash-${w}-${h}.png`);
}
