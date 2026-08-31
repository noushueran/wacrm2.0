// Client-side CSV export, shared by every /reports panel (Task 12 builds
// it, Tasks 13-15 reuse `downloadCsv` as-is).
//
// No server-side export path: every panel's query already returns exactly
// what is on screen, so a second round trip would only create a way for
// the file and the page to disagree — see docs/superpowers/specs/
// 2026-08-05-reports-section-design.md's "Export" section.

// Written as an explicit escape, not a literal character, so the BOM
// can't be silently stripped or mangled by an editor/tool that doesn't
// render invisible characters.
const BOM = '\uFEFF'

/**
 * Build the exact text of the CSV file — including the leading UTF-8 BOM
 * — for a header row plus data rows. Pure and side-effect free, unlike
 * `downloadCsv` below, so this is the part that gets unit tested.
 *
 * Quoting covers the part of RFC 4180 that matters for this app's data: a
 * value is quoted when it contains the delimiter (a comma — ad names
 * genuinely contain them), a double quote, or a line break, with embedded
 * double quotes doubled. Rows — including the header row — are joined
 * with CRLF, per the RFC.
 *
 * The leading BOM is deliberate, not decorative: without it, Excel
 * guesses the file's encoding from content alone and renders non-ASCII ad
 * names as mojibake.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): string {
  const escape = (value: string | number | null): string => {
    const text = value === null ? '' : String(value)
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }

  const csv = [headers, ...rows]
    .map((row) => row.map(escape).join(','))
    .join('\r\n')

  return `${BOM}${csv}`
}

/**
 * Trigger a browser download of `toCsv`'s output as `filename`. Thin
 * Blob/anchor-click plumbing with no logic of its own — not unit tested;
 * see `toCsv` for the part that is.
 */
export function downloadCsv(
  filename: string,
  headers: readonly string[],
  rows: readonly (readonly (string | number | null)[])[],
): void {
  const blob = new Blob([toCsv(headers, rows)], {
    type: 'text/csv;charset=utf-8;',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
