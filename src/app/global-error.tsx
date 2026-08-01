"use client" // Error boundaries must be Client Components

import { useEffect } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

import './globals.css'
import { DEFAULT_MODE, DEFAULT_THEME, MODE_STORAGE_KEY, MODES } from '@/lib/themes'

// Last-resort boundary: the only thing that catches a throw in the ROOT
// LAYOUT (`src/app/layout.tsx`) or in `DashboardShell` / `RequireSection`,
// which live in `(dashboard)/layout.tsx` and are therefore ABOVE
// `(dashboard)/error.tsx` — `error.tsx` never wraps the layout alongside
// it. Everything below that is already contained: per-widget by
// `WidgetBoundary`, per-route by `(dashboard)/error.tsx`. This file
// should be unreachable in normal operation.
//
// It REPLACES the root layout when active, which is what makes it
// awkward, and each of these is a real constraint rather than a style
// choice:
//
//   • It must render its own <html> and <body> — nothing above supplies
//     them.
//   • `NextIntlClientProvider` is gone with the root layout, so
//     `useTranslations` would throw INSIDE the error handler. Every
//     string here is hardcoded English on purpose; do not "fix" this by
//     reaching for `next-intl`. (This is also why there is no
//     `RouteError`-style block in messages/en.json for it.)
//   • `metadata` exports are unsupported in this file, so the tab title
//     is a plain React `<title>`.
//   • The `theme-boot` <script> is gone too, so `data-theme`/`data-mode`
//     are set statically below to the same defaults the root layout
//     server-renders. `:root` in globals.css carries the dark + violet
//     defaults, so every design token still resolves.
//   • `next/font` can't run in a Client Component, so `--font-sans` is
//     unset and Tailwind's `font-sans` would collapse to the browser
//     default (a serif). The explicit system stack on <body> is what
//     keeps this screen from looking like an unstyled document.
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  useEffect(() => {
    // Honour the saved mode so a light-mode user doesn't get a dark
    // slab. Done in an effect rather than the usual inline boot script
    // because React sets `dangerouslySetInnerHTML` on a client-rendered
    // <script> via innerHTML, and scripts injected that way never
    // execute — the boot-script trick silently does nothing here.
    // Guarded: a throw in this handler has nothing left to catch it.
    try {
      const saved = localStorage.getItem(MODE_STORAGE_KEY)
      if (saved && (MODES as readonly string[]).includes(saved)) {
        document.documentElement.dataset.mode = saved
      }
    } catch {
      // Private-mode / blocked storage — keep the default mode.
    }
  }, [])

  return (
    <html
      lang="en"
      data-theme={DEFAULT_THEME}
      data-mode={DEFAULT_MODE}
      className="h-full antialiased"
      // The effect above rewrites `data-mode` for a non-default choice,
      // exactly like the root layout's boot script does.
      suppressHydrationWarning
    >
      <body
        className="min-h-full bg-background text-foreground"
        style={{
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
        }}
      >
        <title>Something went wrong — Holidayys WA CRM</title>
        <div
          role="alert"
          className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 px-6 text-center"
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/10 text-rose-300">
            <AlertTriangle className="h-6 w-6" aria-hidden />
          </span>
          <h1 className="text-base font-semibold text-foreground">
            Something went wrong
          </h1>
          <p className="text-sm text-muted-foreground">
            The app failed to load. Your data is safe — nothing was lost.
          </p>

          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={() => unstable_retry()}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <RotateCw className="h-3.5 w-3.5" aria-hidden />
              Try again
            </button>
            {/* A root-layout failure often can't be recovered by a soft
                re-render, so offer the thing that actually tends to work:
                a full document reload, rebuilding the tree from scratch. */}
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Reload the page
            </button>
          </div>

          {/* Internal staff tool — the raw message is the diagnosis.
              `digest` is the server-log correlation id, present when the
              error came from a Server Component (where Next replaces the
              real message with a generic one). */}
          <details className="mt-2 w-full text-left">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Error details
            </summary>
            <p className="mt-1.5 break-words font-mono text-xs leading-relaxed text-muted-foreground">
              {error.message}
            </p>
            {error.digest ? (
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                Reference: {error.digest}
              </p>
            ) : null}
          </details>
        </div>
      </body>
    </html>
  )
}
