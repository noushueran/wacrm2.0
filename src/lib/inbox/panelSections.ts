// ============================================================
// Pure contact-panel section state: which sections collapse, and whether
// a given one is open right now. No React and no browser API, so the
// branching is unit-testable in a repo with no DOM test harness — the
// same split `src/lib/inbox/notes.ts` established.
//
// The panel pins identity, status, funnel, checklist and labels; these
// seven are the reference detail that collapses.
// ============================================================

export const PANEL_SECTION_KEYS = [
  "travel",
  "location",
  "acquisition",
  "about",
  "keyFacts",
  "deals",
  "activity",
] as const;

export type PanelSectionKey = (typeof PANEL_SECTION_KEYS)[number];

/** Only sections the user has explicitly toggled appear here; an absent
 *  key means "never touched", which is why `persisted` is optional
 *  rather than defaulted at the storage layer. */
export type PanelSectionState = Partial<Record<PanelSectionKey, boolean>>;

/** Namespaced: `localStorage` is shared with everything else this origin
 *  stores. */
export const PANEL_SECTION_STORAGE_KEY = "inbox.contactPanel.sections";

const KNOWN = new Set<string>(PANEL_SECTION_KEYS);

/**
 * Is this section open?
 *
 * Edit mode wins over everything, but ONLY for sections that actually
 * contain editable fields: forcing Activity and Deals open on Edit would
 * re-crowd the panel at the exact moment the user is trying to focus on
 * one field. Otherwise an explicit persisted choice wins, and the
 * default applies when the user has never touched this section.
 */
export function resolveSectionOpen(opts: {
  editing: boolean;
  editable: boolean;
  persisted: boolean | undefined;
  defaultOpen: boolean;
}): boolean {
  if (opts.editing && opts.editable) return true;
  return opts.persisted ?? opts.defaultOpen;
}

/** Tolerant by design: a corrupt or hand-edited value must degrade to
 *  "no preferences" rather than throwing inside a render. */
export function parseSectionState(raw: string | null): PanelSectionState {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: PanelSectionState = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (KNOWN.has(key) && typeof value === "boolean") {
      out[key as PanelSectionKey] = value;
    }
  }
  return out;
}

export function serializeSectionState(state: PanelSectionState): string {
  return JSON.stringify(state);
}

/**
 * Should the closed-state content marker render?
 *
 * This is what stops collapsing from being lossy: with seven sections shut,
 * "collapsed" and "empty" are otherwise indistinguishable. Never shown
 * while open — the content is right there. A zero count is treated as no
 * content, so an empty Deals section does not advertise a "0".
 */
export function shouldShowMarker(opts: {
  open: boolean;
  marker: number | boolean | null;
}): boolean {
  if (opts.open) return false;
  return typeof opts.marker === "number" ? opts.marker > 0 : opts.marker === true;
}
