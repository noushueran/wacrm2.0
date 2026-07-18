import { describe, it, expect } from "vitest";
import {
  inboxUrl,
  messageAreaState,
  listSectionState,
  INITIAL_MESSAGE_PAGE_SIZE,
} from "./view";

describe("inboxUrl", () => {
  it("builds a deep-link URL for a selected conversation", () => {
    expect(inboxUrl("kx7apqsm6bq0qxmez8q436zfn58acv6p")).toBe(
      "/inbox?c=kx7apqsm6bq0qxmez8q436zfn58acv6p",
    );
  });

  it("returns the bare inbox path when nothing is selected", () => {
    expect(inboxUrl(null)).toBe("/inbox");
    expect(inboxUrl(undefined)).toBe("/inbox");
  });
});

describe("messageAreaState", () => {
  it("is 'loading' only while the first page is still loading", () => {
    expect(messageAreaState("LoadingFirstPage", 0)).toBe("loading");
  });

  it("is 'empty' when the first page has loaded and there are no messages", () => {
    expect(messageAreaState("Exhausted", 0)).toBe("empty");
    expect(messageAreaState("CanLoadMore", 0)).toBe("empty");
  });

  it("shows the 'list' once any messages exist", () => {
    expect(messageAreaState("Exhausted", 12)).toBe("list");
    expect(messageAreaState("CanLoadMore", 30)).toBe("list");
  });

  it("keeps the loaded messages visible while an older page is loading", () => {
    // Loading MORE (older) messages must never blank the thread back to a
    // spinner — the already-loaded newest messages stay on screen.
    expect(messageAreaState("LoadingMore", 30)).toBe("list");
  });
});

describe("INITIAL_MESSAGE_PAGE_SIZE", () => {
  it("is a positive page size shared by the thread and its prefetcher", () => {
    // Thread and prefetcher must request the SAME first-page size or the
    // cache key won't match and the prefetch is wasted.
    expect(INITIAL_MESSAGE_PAGE_SIZE).toBe(30);
  });
});

describe("listSectionState", () => {
  it("is 'loading' while the query is still in flight (undefined), NOT 'empty'", () => {
    // Regression: a Convex `useQuery` returns `undefined` while loading.
    // Collapsing that to `[]` made the contact sidebar assert "No deals
    // yet" for the whole cold round-trip (~590ms) — a falsehood a CRM
    // agent could act on. Loading must be distinct from genuinely-empty.
    expect(listSectionState(undefined)).toBe("loading");
  });

  it("is 'empty' once the query has loaded a genuinely empty list", () => {
    expect(listSectionState([])).toBe("empty");
  });

  it("shows the 'list' once any rows exist", () => {
    expect(listSectionState([{ id: "d1" }])).toBe("list");
  });
});
