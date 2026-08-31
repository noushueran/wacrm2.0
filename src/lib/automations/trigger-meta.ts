import type { AutomationTriggerType } from '@/types'

export interface TriggerMeta {
  label: string
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    label: 'New Message',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  },
  first_inbound_message: {
    label: 'First Message from Contact',
    pillClass: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  },
  keyword_match: {
    label: 'Keyword Match',
    pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  },
  new_contact_created: {
    label: 'New Contact',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  conversation_assigned: {
    label: 'Conversation Assigned',
    pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  },
  tag_added: {
    label: 'Tag Added',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  time_based: {
    label: 'Time-Based',
    pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  },
  interactive_reply: {
    label: 'Button / List Reply',
    pillClass: 'border-pink-500/30 bg-pink-500/10 text-pink-300',
  },
}

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return (
    TRIGGER_META[t as AutomationTriggerType] ?? {
      label: t,
      pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
    }
  )
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'never'
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 2_592_000) return `${Math.floor(diffSec / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

export type CountdownUnit = 'due' | 'minutes' | 'hours' | 'days'

export interface Countdown {
  unit: CountdownUnit
  /** Meaningless (always 0) when `unit` is `"due"`. */
  count: number
}

/**
 * Time remaining until a future timestamp (ms epoch) — the waiting
 * queue's countdown to `automationRuns.resumeAt`.
 *
 * Deliberately NOT built on `formatRelative` above, even though both are
 * "how far from now" helpers: that one's `Date.now() - then` math (and
 * "X ago" wording) only makes sense for a PAST `then`. Feed it a future
 * timestamp and the diff goes negative — and since any negative number
 * is `< 60`, `diffSec < 60` is true for literally every future
 * `resumeAt`, however far off, so it would print "just now" for a wait
 * that resolves in 10 minutes and one that resolves in 10 days alike.
 * This mirrors the direction instead (`then - now`) and returns
 * structured value+unit rather than a rendered string — unlike
 * `formatRelative`'s hardcoded English, this is new code, so it goes
 * through next-intl at the call site instead of inheriting that
 * shortcut.
 */
export function countdownTo(targetMs: number | null | undefined): Countdown {
  if (targetMs == null || Number.isNaN(targetMs)) return { unit: 'due', count: 0 }
  const diffSec = Math.round((targetMs - Date.now()) / 1000)
  if (diffSec <= 0) return { unit: 'due', count: 0 }
  if (diffSec < 3600) return { unit: 'minutes', count: Math.max(1, Math.floor(diffSec / 60)) }
  if (diffSec < 86400) return { unit: 'hours', count: Math.floor(diffSec / 3600) }
  return { unit: 'days', count: Math.floor(diffSec / 86400) }
}
