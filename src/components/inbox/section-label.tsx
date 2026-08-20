import type { LucideIcon } from "lucide-react";

/** Small uppercase label + icon used to head a PINNED contact-panel
 *  section — Labels, and the funnel's `Section` wrapper. The seven
 *  collapsible sections draw their own header instead, inside
 *  `ContactCollapsibleSection`. Kept in its own module rather than
 *  exported from `contact-sidebar.tsx` so a child component can head
 *  itself without importing its parent. */
export function SectionLabel({
  icon: Icon,
  label,
}: {
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
      <Icon className="h-3 w-3" />
      {label}
    </div>
  );
}
