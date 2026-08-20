import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { OptionalFeatureBoundary } from "./optional-feature-boundary";

/**
 * Static-render test, matching this repo's other component tests
 * (`conversation-list.test.tsx`) — there is no jsdom, no
 * react-test-renderer and no Testing Library here.
 *
 * That bounds what can be covered. React runs `getDerivedStateFromError`
 * / `componentDidCatch` only in the client reconciler;
 * `renderToStaticMarkup` rethrows straight past a boundary instead of
 * catching (measured, not assumed). So the catch path — which only ever
 * runs in the browser, this being a `"use client"` component — has no
 * unit test here, the same gap `DeepLinkFallbackBoundary` in
 * `src/app/(dashboard)/inbox/page.tsx` already lives with.
 *
 * What IS pinned is the half that would otherwise regress silently: with
 * nothing throwing, the boundary is completely transparent, so wrapping a
 * working feature in it changes precisely nothing on screen.
 */
describe("OptionalFeatureBoundary", () => {
  it("renders its children untouched when nothing throws", () => {
    const html = renderToStaticMarkup(
      <OptionalFeatureBoundary feature="salesChecklists.forConversation">
        <span>checklist</span>
      </OptionalFeatureBoundary>,
    );
    expect(html).toBe("<span>checklist</span>");
  });
});
