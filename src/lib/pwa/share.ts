// Incoming Web Share Target payloads.
//
// The OS hands a share to `/share` as query parameters named by the
// manifest's `share_target.params`. Which of `title`/`text`/`url` are
// populated is entirely up to the sharing app: Chrome on Android puts a
// shared link in `url` on some versions and appends it to `text` on
// others, the WhatsApp "share contact" sheet sends only `text`, and a
// browser's "share page" sends `title` + `url`. So the receiving side
// has to fold all three into one draft rather than trusting any single
// field.

export type SharePayload = {
  title?: string | null;
  text?: string | null;
  url?: string | null;
};

/**
 * Fold a share into the single string that seeds the composer.
 *
 * Rules, in the order they matter:
 *  - `text` leads, because it is what the user actually selected or
 *    typed in the sharing app.
 *  - `url` is appended only when it is not already inside `text`. Chrome
 *    populates BOTH for a shared link on some Android versions, and
 *    pasting the same URL twice into a customer's chat looks broken.
 *  - `title` is used only when there is no text at all. It is usually a
 *    page title — useful as a fallback, noise next to a real selection.
 */
export function shareToDraft(payload: SharePayload): string {
  const text = (payload.text ?? "").trim();
  const url = (payload.url ?? "").trim();
  const title = (payload.title ?? "").trim();

  const parts: string[] = [];
  if (text) parts.push(text);
  else if (title) parts.push(title);
  if (url && !text.includes(url)) parts.push(url);

  return parts.join("\n").trim();
}

/** True when a share carried nothing usable — the page then explains
 *  itself rather than sending an empty draft into a chat. */
export function isEmptyShare(payload: SharePayload): boolean {
  return shareToDraft(payload).length === 0;
}
