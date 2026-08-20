"use client" // Error boundaries must be Client Components

import { useEffect } from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'
import { useTranslations } from 'next-intl'

// Route-group error boundary: the last line of defence for every authed
// route (/dashboard, /inbox, /campaigns, /contacts, /leads, …).
//
// `error.tsx` wraps the segment's `page`/`loading`/nested layouts but NOT
// the layout alongside it, so `(dashboard)/layout.tsx` → `DashboardShell`
// keeps rendering: the sidebar, header and bottom nav survive and only
// the <main> content area degrades. That is the difference between "the
// app looks broken" and "this page looks broken" — the production
// incident this came from was a fully blank screen.
//
// /dashboard additionally guards each widget with `WidgetBoundary`
// (src/components/dashboard/widget-boundary.tsx), so a single failed
// query degrades to one card and never reaches this file. The
// single-purpose routes don't get that treatment on purpose: an inbox
// with no conversation list has nothing left to show, so route-level is
// the honest granularity there.
export default function DashboardRouteError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  const t = useTranslations('RouteError')

  useEffect(() => {
    // No error-reporting service is wired up in this app yet; the
    // console is what a support session actually reads.
    console.error(error)
  }, [error])

  return (
    <div
      role="alert"
      className="mx-auto flex min-h-80 max-w-md flex-col items-center justify-center gap-3 text-center"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-rose-500/10 text-rose-700 dark:text-rose-300">
        <AlertTriangle className="h-6 w-6" aria-hidden />
      </span>
      <h1 className="text-base font-semibold text-foreground">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('message')}</p>

      <button
        type="button"
        onClick={() => unstable_retry()}
        className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
      >
        <RotateCw className="h-3.5 w-3.5" aria-hidden />
        {t('retry')}
      </button>

      {/* Internal staff tool, so the raw message stays visible in
          production — it's what makes an incident diagnosable. `digest`
          is present only for errors thrown in Server Components, where
          Next replaces the real message with a hash for the server log. */}
      <details className="mt-2 w-full text-left">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
          {t('details')}
        </summary>
        <p className="mt-1.5 break-words font-mono text-xs leading-relaxed text-muted-foreground">
          {error.message}
        </p>
        {error.digest ? (
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {t('digest', { digest: error.digest })}
          </p>
        ) : null}
      </details>
    </div>
  )
}
