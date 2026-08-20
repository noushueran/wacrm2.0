"use client"

/**
 * Grouped, searchable replacement for the old flat add-step menu. Renders
 * its own circular "+" trigger — the same one the canvas already used —
 * opening a ~320px popover: an autofocused search box on top, the eleven
 * addable actions (`ACTION_GROUPS`, action-catalog.ts) grouped and
 * filtered below.
 *
 * Built on Popover + a plain Input rather than DropdownMenu (a Menu
 * primitive) or cmdk (not a dependency in this repo, and not one this
 * component should add — see the Task 2 brief). A Menu owns its own
 * roving-tabindex arrow-key handling, which would fight the hand-rolled
 * highlight below: the search input has to keep DOM focus the entire
 * time so typing is never interrupted. Popover has no keyboard opinions
 * of its own, so ArrowUp/ArrowDown/Enter are wired directly on the
 * input. Escape is NOT handled here — Base UI's Popover already
 * dismisses on Escape by itself, which reaches this component through
 * `onOpenChange` below (same path as an outside click), so a second
 * handler would only race it.
 */

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useTranslations } from "next-intl"
import { Plus, Search } from "lucide-react"

import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { AutomationStepType } from "@/types"
import { clampHighlight, groupedResults, searchActions } from "./action-catalog"
// STEP_META is automation-builder.tsx's single source of truth for each
// step's icon + label. Importing it back here closes a circular
// dependency between the two files — the same shape as that file's own
// `send-composer.tsx` -> `useResources` import (see automation-builder's
// comment on `isTemplateHeaderMediaType` for the precedent). Safe because
// every use below happens inside a component body at render time, well
// after both modules have finished evaluating — never at module-eval
// time.
import { STEP_META } from "./automation-builder"

interface ActionPickerProps {
  onPick: (type: AutomationStepType) => void
}

export function ActionPicker({ onPick }: ActionPickerProps) {
  const t = useTranslations("Automations.builder")
  const listboxId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Flat, in-display-order list of steps the current query matches —
  // the same order the grouped rows below render in, since both derive
  // from ACTION_GROUPS's own order. `highlight` is an index into this.
  const results = useMemo(() => searchActions(query), [query])
  const groups = useMemo(() => groupedResults(query), [query])

  function reset() {
    setQuery("")
    setHighlight(0)
  }

  function pick(type: AutomationStepType) {
    onPick(type)
    setOpen(false)
    reset()
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setHighlight((h) => clampHighlight(h + 1, results.length))
        break
      case "ArrowUp":
        e.preventDefault()
        setHighlight((h) => clampHighlight(h - 1, results.length))
        break
      case "Enter": {
        e.preventDefault()
        const picked = results[highlight]
        if (picked) pick(picked)
        break
      }
      // No explicit Escape case: Base UI's Popover already dismisses on
      // Escape on its own (traced through its useDismiss source during
      // code review) and that reaches this component the same way an
      // outside click does — via `onOpenChange(false, ...)` below, which
      // already calls `reset()`. A second, redundant handler here would
      // just race the same state change.
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <PopoverTrigger
        className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-dashed border-border bg-background text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary data-[popup-open]:border-primary data-[popup-open]:bg-primary/20 data-[popup-open]:text-primary"
        aria-label={t("addStep")}
      >
        <Plus className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        initialFocus={inputRef}
        className="flex max-h-(--available-height) w-80 flex-col gap-0 overflow-hidden p-0"
      >
        <div className="shrink-0 border-b border-border p-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={inputRef}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listboxId}
              aria-activedescendant={
                results[highlight] ? `${listboxId}-${results[highlight]}` : undefined
              }
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHighlight(0)
              }}
              onKeyDown={handleKeyDown}
              placeholder={t("actionPicker.searchPlaceholder")}
              className="pl-9"
            />
          </div>
        </div>
        <div
          id={listboxId}
          role="listbox"
          aria-label={t("addStep")}
          className="max-h-[420px] min-h-0 overflow-y-auto p-1"
        >
          {groups.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              {t("actionPicker.empty", { query })}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.id} role="group" aria-label={t(`actionPicker.groups.${group.id}`)} className="py-1">
                <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(`actionPicker.groups.${group.id}`)}
                </div>
                {group.steps.map((step) => {
                  const Icon = STEP_META[step].icon
                  const index = results.indexOf(step)
                  const isHighlighted = index === highlight
                  return (
                    <button
                      key={step}
                      type="button"
                      id={`${listboxId}-${step}`}
                      role="option"
                      aria-selected={isHighlighted}
                      onClick={() => pick(step)}
                      onMouseEnter={() => setHighlight(index)}
                      className={cn(
                        "flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors",
                        isHighlighted ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                      )}
                    >
                      <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {t(`steps.${STEP_META[step].label}`)}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {t(`actionPicker.descriptions.${step}`)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
