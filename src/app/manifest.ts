import type { MetadataRoute } from "next";
import { BRAND, PRODUCT_NAME } from "@/lib/brand";

// Web app manifest — makes the CRM installable. `start_url` opens the
// inbox (the daily driver); the app boots dark to match the shell.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: PRODUCT_NAME,
    short_name: BRAND.name,
    id: "/",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    // Falls back to `minimal-ui` where `standalone` is unavailable
    // (some Android browsers, desktop Firefox) instead of dropping
    // straight to a full browser tab with its address bar.
    display_override: ["standalone", "minimal-ui"],
    // No `orientation` lock. It was "portrait", which also locked
    // tablets and stopped anyone typing a long reply in landscape —
    // an orientation choice belongs to the person holding the device.
    lang: "en",
    dir: "ltr",
    categories: ["business", "productivity"],
    background_color: "#020617",
    theme_color: "#020617",
    // Long-press the home-screen icon. Chosen to be the two things worth
    // jumping straight to rather than a mirror of the nav: the pool of
    // leads nobody has claimed, and the dashboard.
    shortcuts: [
      {
        name: "Unassigned leads",
        short_name: "Unassigned",
        url: "/inbox?assignment=unassigned",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Dashboard",
        short_name: "Dashboard",
        url: "/dashboard",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
