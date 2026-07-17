import type { MetadataRoute } from "next";

// Web app manifest — makes the CRM installable. `start_url` opens the
// inbox (the daily driver); the app boots dark to match the shell.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Holidayys WA CRM",
    short_name: "Holidayys",
    id: "/",
    start_url: "/inbox",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#020617",
    theme_color: "#020617",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
