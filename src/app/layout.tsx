import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { Inter } from "next/font/google";
import Script from "next/script";
import { ConvexAuthNextjsServerProvider } from "@convex-dev/auth/nextjs/server";
import "./globals.css";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { ThemeProvider } from "@/hooks/use-theme";
import { ThemedToaster } from "@/components/themed-toaster";
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  MODE_STORAGE_KEY,
  MODES,
  STORAGE_KEY,
  THEME_IDS,
} from "@/lib/themes";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // Absolute base for every relative metadata URL (Open Graph / Twitter
  // images, canonical links). Without it Next.js falls back to
  // `localhost:3000` and emits a build-time warning, and social crawlers
  // that unfurl a shared link (e.g. the /join invite page) would receive a
  // localhost image URL. Prefers the deployment's own env var, falling back
  // to the known production origin.
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://wa.holidayys.co"
  ),
  title: {
    default: "Holidayys WA CRM",
    template: "%s — Holidayys WA CRM",
  },
  description: "Internal WhatsApp CRM for Holidays Tours LLC — shared inbox, contacts, pipelines, broadcasts, and automations.",
  robots: {
    index: false,
    follow: false,
  },
  icons: {
    icon: [{ url: "/icon" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "Holidayys",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#020617" },
  ],
  colorScheme: "dark light",
  viewportFit: "cover",
};

// Inline boot script — runs before React hydrates so the user's
// chosen accent (data-theme) AND mode (data-mode) are on the <html>
// element before first paint. Without this every page load flashes
// the server-rendered defaults for a frame before the React tree
// mounts and applies the picked values.
//
// Kept dependency-free (no imports, no JSX) — must be a string the
// browser can run as a single <script>. Knowledge of valid ids is
// sourced from the THEME_IDS / MODES constants so adding one doesn't
// silently break the boot path.
const THEME_BOOT_SCRIPT = `
(function(){
  var d = document.documentElement;
  try {
    var THEME_KEY = ${JSON.stringify(STORAGE_KEY)};
    var THEME_DEFAULT = ${JSON.stringify(DEFAULT_THEME)};
    var THEMES = ${JSON.stringify(THEME_IDS)};
    var savedTheme = localStorage.getItem(THEME_KEY);
    d.dataset.theme = THEMES.indexOf(savedTheme) !== -1 ? savedTheme : THEME_DEFAULT;

    var MODE_KEY = ${JSON.stringify(MODE_STORAGE_KEY)};
    var MODE_DEFAULT = ${JSON.stringify(DEFAULT_MODE)};
    var MODES = ${JSON.stringify(MODES)};
    var savedMode = localStorage.getItem(MODE_KEY);
    d.dataset.mode = MODES.indexOf(savedMode) !== -1 ? savedMode : MODE_DEFAULT;
  } catch (_e) {
    d.dataset.theme = ${JSON.stringify(DEFAULT_THEME)};
    d.dataset.mode = ${JSON.stringify(DEFAULT_MODE)};
  }
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    // `ConvexAuthNextjsServerProvider` reads the auth cookies on the
    // server and hands the resulting session state down to the client
    // provider (`ConvexAuthNextjsProvider` in `ConvexClientProvider`) so
    // SSR, the client, and `src/middleware.ts` all agree on who's signed
    // in. It must sit ABOVE `<html>` (the documented Convex Auth Next.js
    // root-layout shape) so the whole tree is inside the auth context.
    //
    // `storageNamespace` normally defaults to `NEXT_PUBLIC_CONVEX_URL`,
    // and the library throws `Missing environment variable` if that var
    // is unset. Supplying an explicit fallback keeps a missing var from
    // white-screening the app (it short-circuits that internal
    // `requireEnv`); when the var IS present we pass it through so token
    // storage keys stay per-deployment exactly as the default would make
    // them.
    <ConvexAuthNextjsServerProvider
      storageNamespace={process.env.NEXT_PUBLIC_CONVEX_URL || "wacrm"}
    >
      <html
        lang={locale}
        data-theme={DEFAULT_THEME}
        data-mode={DEFAULT_MODE}
        className={`${inter.variable} h-full antialiased`}
      // The `theme-boot` script below rewrites `data-theme` and
      // `data-mode` on <html> from localStorage before React hydrates,
      // so for any non-default choice the client DOM intentionally
      // differs from the server-rendered defaults. suppressHydration-
      // Warning silences the expected mismatch — it only applies to
      // this element's own attributes, so genuine mismatches in
      // children still surface.
      suppressHydrationWarning
    >
      <head>
        <Script
          id="theme-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full bg-background text-foreground font-sans">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <ThemeProvider>
            <ConvexClientProvider>{children}</ConvexClientProvider>
            <ThemedToaster />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
      </html>
    </ConvexAuthNextjsServerProvider>
  );
}
