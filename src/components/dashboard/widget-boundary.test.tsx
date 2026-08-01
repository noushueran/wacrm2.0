import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { WidgetErrorCard } from './widget-boundary'

/**
 * Static-render tests, matching this repo's other component tests
 * (`voice-transcript.test.tsx`, `dropdown-menu-group-label.test.tsx`) —
 * there is no jsdom and no Testing Library here.
 *
 * `WidgetBoundary` itself is not covered: it's Next's
 * `unstable_catchError`, whose wrapper reads App Router context
 * (`useUntrackedPathname`, `RouterContext`) that a bare
 * `renderToStaticMarkup` can't supply. The framework owns that
 * behaviour. What's ours — and what these pin — is the fallback card.
 */

// The actual error that blanked /dashboard in production: `dashboard
// .responseTime` exceeded a Convex per-transaction read limit.
const OUTAGE_MESSAGE =
  '[CONVEX Q(dashboard:responseTime)] Your request timed out performing too many system operations'

function render(props: Partial<React.ComponentProps<typeof WidgetErrorCard>> = {}) {
  return renderToStaticMarkup(
    React.createElement(WidgetErrorCard, {
      title: 'Response Performance',
      message: "This widget couldn't load.",
      retryLabel: 'Retry',
      detailLabel: 'Details',
      onRetry: () => {},
      ...props,
    }),
  )
}

describe('WidgetErrorCard', () => {
  it('names the widget it replaced', () => {
    // The whole point of per-widget containment: the user must be able
    // to tell WHICH card failed while the rest of the page renders.
    expect(render()).toContain('Response Performance')
  })

  it('offers a retry control', () => {
    const html = render()
    expect(html).toContain('Retry')
    expect(html).toContain('<button')
  })

  it('is announced as an alert', () => {
    expect(render()).toContain('role="alert"')
  })

  it('omits the details disclosure when there is no error text', () => {
    const html = render({ detail: undefined })
    expect(html).not.toContain('<details')
    expect(html).not.toContain('Details')
  })

  it('surfaces the raw error text when present', () => {
    // Kept out of a dev-only branch on purpose — this string is what
    // diagnosed the outage, and every user of this CRM is staff.
    const html = render({ detail: OUTAGE_MESSAGE })
    expect(html).toContain('<details')
    expect(html).toContain('Your request timed out performing too many system operations')
  })

  it('forwards className so a fallback can hold its grid footprint', () => {
    // Load-bearing: the metrics bundle is three cards sharing one query
    // in a 4-col grid, so its single fallback card must span the same
    // three columns instead of collapsing the row. This is the exact
    // class `dashboard/page.tsx` passes.
    expect(render({ className: 'lg:col-span-3' })).toContain('lg:col-span-3')
  })
})
