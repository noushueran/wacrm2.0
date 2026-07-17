// Mode-aware "soft badge" tone classes.
//
// The app's dark-only palette utilities (`text-amber-300`, `text-cyan-300`,
// `text-rose-300`, `text-blue-400`, …) were tuned against dark surfaces and
// wash out to near-invisible on the light-mode near-white background. Each
// hue tone here pairs a light-mode 700 stop with a `dark:` 300/400 stop over a
// 10% tint, so a chip reads with adequate contrast in BOTH modes.
//
// Prefer the semantic tones (`accent` / `success` / `warning` / `danger` /
// `info`). The named-hue tones (`amber` / `cyan`) exist only to port the two
// existing chips that used those exact hues 1:1. `accent` and `neutral` map to
// theme tokens that are already mode-correct, so they carry no `dark:` override.
export type SoftTone =
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral"
  | "amber"
  | "cyan";

const TONES: Record<SoftTone, string> = {
  accent: "border-primary/40 bg-primary/10 text-primary",
  success:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warning:
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  danger:
    "border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  info: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  neutral: "border-border bg-muted text-foreground",
  amber:
    "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  cyan: "border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
};

/** Border + tinted background + mode-aware text classes for a soft chip. */
export function softBadge(tone: SoftTone): string {
  return TONES[tone];
}
