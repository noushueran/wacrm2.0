import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard against the Inbox route going down when Convex is behind.
 *
 * What happened: `LeadQualityCard` shipped mounted directly, un-wrapped.
 * Netlify builds the frontend from `main` automatically while Convex is
 * deployed separately, so there is a real window in which this component
 * exists and `leadQuality:getCardState` does not — and `useQuery`
 * RETHROWS "Could not find public function" during render. With no
 * `error.tsx` under `src/app` to stop it, one missing backend function
 * took the ENTIRE Inbox route down rather than hiding one supplementary
 * card. A broken inbox is far worse than a missing card.
 *
 * `OptionalFeatureBoundary` exists for exactly this and documents this
 * exact error string in its header; the fix was to use it.
 *
 * Source assertions rather than render assertions, for the same reasons
 * `thread-header.wiring.test.ts` records: `src/**` tests run in plain
 * node with no jsdom, and `MessageThread` needs Convex, next-intl and
 * presence providers to render at all. The wiring is what broke, and the
 * wiring is what this reads.
 */

const SRC = join(__dirname, "../../..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("lead-quality card wiring", () => {
  const messageThread = read("components/inbox/message-thread.tsx");
  const card = read("components/inbox/lead-quality-card.tsx");

  it("mounts the panel beside the notes button, not above the composer", () => {
    // The footer strip crowded the message area on every unanswered lead.
    // It now shares the notes FAB's positioning context.
    expect(messageThread).toContain("<NoteComposer");
    const notes = messageThread.indexOf("<NoteComposer");
    const panel = messageThread.indexOf("<LeadQualityCard");
    expect(panel).toBeGreaterThan(notes);
    // And the card positions itself as a floating trigger.
    expect(card).toContain("absolute bottom-4");
  });

  it("mounts the card inside an OptionalFeatureBoundary", () => {
    expect(messageThread).toContain("OptionalFeatureBoundary");
    // The boundary must OPEN before the card and CLOSE after it — the
    // whole point is that the card's own render sits inside it.
    const open = messageThread.indexOf(
      '<OptionalFeatureBoundary feature="leadQuality.getCardState">',
    );
    const mount = messageThread.indexOf("<LeadQualityCard");
    const close = messageThread.indexOf(
      "</OptionalFeatureBoundary>",
      mount,
    );
    expect(open).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(mount);
  });

  it("keeps the query subscription INSIDE the wrapped component", () => {
    // `OptionalFeatureBoundary`'s header: a hook throws during the render
    // of whatever component CALLS it. If the card's query were lifted into
    // `MessageThread`, the boundary would catch nothing and the route
    // would go down again — with the wrapper still present, looking safe.
    expect(card).toContain("api.leadQuality.getCardState");
    expect(messageThread).not.toContain("api.leadQuality");
  });
});
