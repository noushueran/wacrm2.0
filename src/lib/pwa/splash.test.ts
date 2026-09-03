import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { SPLASH_DEVICES, appleSplashLinks, splashFileName } from "./splash";

const PUBLIC_DIR = join(__dirname, "..", "..", "..", "public");

describe("apple splash links", () => {
  it("names one image per device", () => {
    expect(appleSplashLinks()).toHaveLength(SPLASH_DEVICES.length);
  });

  it("scales CSS pixels by the device ratio, which is how the files are named", () => {
    // 393 × 3 = 1179, 852 × 3 = 2556 — an iPhone 15's real pixel grid.
    expect(splashFileName(393, 852, 3)).toBe("apple-splash-1179-2556.png");
  });

  it("targets a device exactly, so iOS cannot pick a mismatched bitmap", () => {
    const [link] = appleSplashLinks();
    const [w, h, dpr] = SPLASH_DEVICES[0];
    expect(link.media).toContain(`(device-width: ${w}px)`);
    expect(link.media).toContain(`(device-height: ${h}px)`);
    expect(link.media).toContain(`(-webkit-device-pixel-ratio: ${dpr})`);
    expect(link.media).toContain("orientation: portrait");
  });

  it("has no duplicate media queries — two matches would make the choice arbitrary", () => {
    const medias = appleSplashLinks().map((l) => l.media);
    expect(new Set(medias).size).toBe(medias.length);
  });

  // The guard that earns this file. `scripts/generate-pwa-icons.mjs`
  // keeps its own copy of the device table; if the two drift, the
  // metadata ends up pointing at an image nobody generated and iOS
  // silently shows a blank launch screen — the exact bug these images
  // exist to fix, and one no type checker or build step would catch.
  it("every referenced image actually exists in public/", () => {
    const missing = appleSplashLinks()
      .map((l) => l.url)
      .filter((url) => !existsSync(join(PUBLIC_DIR, url)));
    expect(missing).toEqual([]);
  });
});
