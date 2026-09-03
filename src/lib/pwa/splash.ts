// iOS launch images, and the media queries that pick one.
//
// Only iOS needs this. Android and desktop build a splash from the
// manifest's `name`, `icons` and `background_color`; iOS ignores all
// that and wants one bitmap per device size, selected by a media query
// on `apple-touch-startup-image`. Without a match it paints a blank
// `background_color` screen for the whole cold boot — which, on a weak
// connection, is the first and longest thing an agent sees.
//
// The bitmaps are produced by `scripts/generate-pwa-icons.mjs`, which
// keeps its own copy of this table. `splash.test.ts` asserts that every
// file named here exists on disk, so the two cannot drift into the one
// failure that matters: metadata pointing at an image that was never
// generated.

/** `[cssWidth, cssHeight, devicePixelRatio]`, newest device first. */
export const SPLASH_DEVICES: ReadonlyArray<readonly [number, number, number]> = [
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

export type SplashLink = { url: string; media: string };

export function splashFileName(
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): string {
  return `apple-splash-${cssWidth * dpr}-${cssHeight * dpr}.png`;
}

/**
 * The `startupImage` entries for Next's `appleWebApp` metadata.
 *
 * Portrait only, deliberately: this is installed on phones from the home
 * screen in portrait, and doubling the asset count for a landscape
 * launch nobody performs is not worth the bytes. An unmatched device
 * falls back to the blank background — i.e. exactly today's behaviour,
 * so adding these can only improve things.
 */
export function appleSplashLinks(): SplashLink[] {
  return SPLASH_DEVICES.map(([w, h, dpr]) => ({
    url: `/splash/${splashFileName(w, h, dpr)}`,
    media: `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)`,
  }));
}
