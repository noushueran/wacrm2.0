// Route-level loading skeletons for the dashboard sections.
//
// These back the `loading.tsx` files in each `(dashboard)/<section>`
// folder. In Next.js App Router a `loading.tsx` is a Server Component
// that Next wraps the page in a `<Suspense>` boundary with — its output
// is *prefetched* alongside the route, so a sidebar click shows this
// skeleton INSTANTLY (the shared sidebar/header stay mounted and
// interactive) instead of leaving the previous page frozen while the new
// route's RSC payload and data load. See
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/loading.md
//
// They're deliberately plain, dependency-free presentational components
// (no "use client", no hooks, no i18n) so they render on the server and
// prefetch cheaply. Each mirrors the rough shape of its real page so the
// swap from skeleton → content doesn't visually jump.

import { Skeleton } from "@/components/dashboard/skeleton";

/** Title + subtitle block every section renders at the top. */
function HeaderSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-72 max-w-full" />
    </div>
  );
}

/** A single list/table row: avatar + two stacked text lines + trailing chip. */
function RowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
      <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-6 w-16 rounded-full" />
    </div>
  );
}

/**
 * Generic list section (broadcasts, automations, notifications, agents,
 * flows): header + a small toolbar + a stack of rows.
 */
export function ListSectionSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <HeaderSkeleton />
        <Skeleton className="h-9 w-32 shrink-0 rounded-md" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, i) => (
          <RowSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

/** Contacts: header + search/toolbar + a table of rows. */
export function TableSectionSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <HeaderSkeleton />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </div>
      <Skeleton className="h-10 w-full max-w-sm rounded-md" />
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="border-b border-border bg-muted/40 p-3">
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="divide-y divide-border">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-3">
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Pipelines: header + horizontally-scrolling kanban columns. */
export function BoardSectionSkeleton({ columns = 4 }: { columns?: number }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <HeaderSkeleton />
        <Skeleton className="h-9 w-32 shrink-0 rounded-md" />
      </div>
      <div className="flex gap-4 overflow-x-auto pb-2">
        {Array.from({ length: columns }).map((_, i) => (
          <div key={i} className="w-72 shrink-0 space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-8" />
            </div>
            {Array.from({ length: 3 }).map((_, j) => (
              <div
                key={j}
                className="space-y-2 rounded-lg border border-border bg-card p-3"
              >
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Dashboard: header + metric cards + charts row + activity feed. */
export function DashboardSectionSkeleton() {
  return (
    <div className="space-y-5">
      <HeaderSkeleton />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-card p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-4 h-8 w-20" />
            <Skeleton className="mt-2 h-3 w-16" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="rounded-xl border border-border bg-card p-5 lg:col-span-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="mt-4 h-56 w-full" />
        </div>
        <div className="rounded-xl border border-border bg-card p-5 lg:col-span-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="mx-auto mt-6 h-40 w-40 rounded-full" />
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <Skeleton className="h-4 w-32" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Inbox: full-bleed two-pane layout (conversation list + thread area).
 * The real page breaks out of the padded `<main>` with `-m-4 sm:-m-6`;
 * mirror that so the skeleton fills the same space.
 */
export function InboxSectionSkeleton() {
  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] overflow-hidden sm:-m-6">
      {/* Conversation list */}
      <div className="flex w-full flex-col border-r border-border md:w-80 lg:w-96">
        <div className="border-b border-border p-4">
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
        <div className="flex-1 space-y-1 overflow-hidden p-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 rounded-lg p-3">
              <Skeleton className="h-11 w-11 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* Thread area — hidden on mobile (list is full-width there) */}
      <div className="hidden flex-1 items-center justify-center md:flex">
        <Skeleton className="h-10 w-10 rounded-full" />
      </div>
    </div>
  );
}

/** Settings: header + left rail + right panel of form fields. */
export function SettingsSectionSkeleton() {
  return (
    <div className="space-y-5">
      <HeaderSkeleton />
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="w-full shrink-0 space-y-2 lg:w-56">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-md" />
          ))}
        </div>
        <div className="flex-1 space-y-4 rounded-xl border border-border bg-card p-6">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-10 w-full max-w-md rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
