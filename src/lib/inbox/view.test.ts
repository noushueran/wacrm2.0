import { describe, it, expect } from "vitest";
import {
  inboxUrl,
  messageAreaState,
  listSectionState,
  overrideControls,
  conversationListArgs,
  conversationRowsToRender,
  conversationTabKey,
  parseAssignmentTab,
  historyActionForClose,
  historyActionForOpen,
  INITIAL_MESSAGE_PAGE_SIZE,
  type AssignmentTab,
  type InboxLane,
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

// Final whole-branch review, Findings 2 and 3. Every `false` below
// mirrors a rejection in `convex/inboxOverrides.ts` — the server is the
// real gate, and these assertions are what keep the header from offering
// a button whose only possible outcome is an error.
describe("overrideControls", () => {
  it("offers Snooze and Chase now on an ordinary thread we spoke on last", () => {
    expect(overrideControls(true, { awaiting_reply: false })).toEqual({
      chaseNow: true,
      snooze: true,
      wake: false,
    });
  });

  it("withholds every control from a viewer", () => {
    expect(overrideControls(false, { awaiting_reply: false })).toEqual({
      chaseNow: false,
      snooze: false,
      wake: false,
    });
  });

  it("withholds Chase now while the CUSTOMER is waiting on us", () => {
    // The load-bearing one (Finding 2). Forcing an Active thread drops it
    // into Chasing, which sorts ASCENDING by `lastMessageAt` — a customer
    // who wrote two minutes ago would sort last in a cold tab nobody
    // watches. `forceChasing` rejects it; the button must not appear.
    // Snooze is still allowed: parking a thread we owe a reply on is a
    // legitimate "not until Tuesday", and it stays reachable in Snoozed.
    const c = overrideControls(true, { awaiting_reply: true });
    expect(c.chaseNow).toBe(false);
    expect(c.snooze).toBe(true);
  });

  it("withholds BOTH setting controls on an archived thread", () => {
    // Finding 3. Every lane and both extra tabs bind
    // `eq("archivedAt", undefined)`, so an override written onto an
    // archived row is invisible and permanent.
    expect(
      overrideControls(true, {
        archived_at: "2026-07-28T10:00:00.000Z",
        awaiting_reply: false,
      }),
    ).toEqual({ chaseNow: false, snooze: false, wake: false });
  });

  it("still offers Wake on an archived thread carrying a stale snooze", () => {
    // `wake` is the one control with no server-side gate: clearing state
    // is always safe, and this is the only way back for such a row.
    const c = overrideControls(true, {
      archived_at: "2026-07-28T10:00:00.000Z",
      snoozed_until: "2026-07-30T06:00:00.000Z",
    });
    expect(c.wake).toBe(true);
    expect(c.snooze).toBe(false);
    expect(c.chaseNow).toBe(false);
  });

  it("swaps Snooze for Wake on a snoozed thread, and never shows both", () => {
    const c = overrideControls(true, {
      snoozed_until: "2026-07-30T06:00:00.000Z",
      awaiting_reply: false,
    });
    expect(c).toEqual({ chaseNow: false, snooze: false, wake: true });
  });

  it("treats a pre-backfill row (awaiting_reply undefined) as chaseable", () => {
    // `undefined` is a pre-backfill row, not "the customer is waiting" —
    // the adapter passes the field through uncoerced for exactly this
    // reason, and only an explicit `true` withholds the control.
    expect(overrideControls(true, {}).chaseNow).toBe(true);
  });
});

describe("conversationListArgs", () => {
  const LANES: InboxLane[] = [
    "active",
    "waiting",
    "chasing",
    "archived",
    "snoozed",
  ];
  const ASSIGNMENTS: AssignmentTab[] = ["all", "mine", "unassigned"];

  it("omits `assignment` entirely for the All tab", () => {
    // The server has no "all" literal — an unfiltered list is what NO
    // argument means. Passing the string through would fail validation.
    expect(conversationListArgs("active", "all")).toEqual({ lane: "active" });
    expect("assignment" in conversationListArgs("active", "all")).toBe(false);
  });

  it("passes `mine` / `unassigned` through as the server literal", () => {
    expect(conversationListArgs("waiting", "mine")).toEqual({
      assignment: "mine",
      lane: "waiting",
    });
    expect(conversationListArgs("waiting", "unassigned")).toEqual({
      assignment: "unassigned",
      lane: "waiting",
    });
  });

  it("sends the Archived tab as `archived: true` with NO lane", () => {
    // Not a sixth lane value: every lane range binds
    // `eq("archivedAt", undefined)`, so `conversations.list` rejects the
    // two together rather than returning a quietly wrong list.
    expect(conversationListArgs("archived", "all")).toEqual({ archived: true });
    expect(conversationListArgs("archived", "mine")).toEqual({
      assignment: "mine",
      archived: true,
    });
  });

  it("never emits `lane` and `archived` together, for any tab pair", () => {
    for (const lane of LANES) {
      for (const assignment of ASSIGNMENTS) {
        const args = conversationListArgs(lane, assignment);
        expect("lane" in args && "archived" in args).toBe(false);
      }
    }
  });

  it("is deterministic — same pair, identical serialization", () => {
    // The whole point of this builder: the Convex query cache keys on
    // the SERIALIZED args, so the list and `PrefetchLane` must produce
    // byte-identical output for the same tab or the prefetch warms a
    // subscription the list never reads. Key ORDER matters here, which
    // is why this compares JSON rather than using toEqual.
    for (const lane of LANES) {
      for (const assignment of ASSIGNMENTS) {
        expect(JSON.stringify(conversationListArgs(lane, assignment))).toBe(
          JSON.stringify(conversationListArgs(lane, assignment)),
        );
      }
    }
  });

  it("gives every tab pair its own distinct args", () => {
    // A collision would mean two tabs sharing one cache entry — one
    // would silently show the other's rows.
    const seen = new Set<string>();
    for (const lane of LANES) {
      for (const assignment of ASSIGNMENTS) {
        seen.add(JSON.stringify(conversationListArgs(lane, assignment)));
      }
    }
    expect(seen.size).toBe(LANES.length * ASSIGNMENTS.length);
  });
});

describe("conversationRowsToRender", () => {
  const WAITING = conversationTabKey("waiting", "all");
  const CHASING = conversationTabKey("chasing", "all");
  const rows = ["a", "b", "c"];
  const remembered = { key: WAITING, rows };

  it("shows the live rows whenever the query has settled", () => {
    for (const status of ["CanLoadMore", "LoadingMore", "Exhausted"] as const) {
      expect(conversationRowsToRender(status, WAITING, ["x"], remembered)).toEqual(["x"]);
    }
  });

  it("keeps the tab's last rows through a mid-session pagination reset", () => {
    // The regression this exists for: `usePaginatedQuery` absorbs an
    // InvalidCursor by resetting to page one, which drops results to []
    // and status to LoadingFirstPage. Without this the list the user was
    // reading flashes to a skeleton.
    expect(conversationRowsToRender("LoadingFirstPage", WAITING, [], remembered))
      .toEqual(rows);
  });

  it("shows a cold tab nothing to render, so it can show its skeleton", () => {
    // Nothing remembered for this tab yet — a genuine first load.
    expect(
      conversationRowsToRender("LoadingFirstPage", WAITING, [], { key: "", rows: [] }),
    ).toEqual([]);
  });

  it("never shows one tab's rows under another tab's heading", () => {
    // Switching lanes also resets to LoadingFirstPage with empty results,
    // and Waiting's rows under Chasing would be actively misleading.
    expect(conversationRowsToRender("LoadingFirstPage", CHASING, [], remembered))
      .toEqual([]);
  });

  it("lets real data win even before the query settles", () => {
    expect(conversationRowsToRender("LoadingFirstPage", WAITING, ["fresh"], remembered))
      .toEqual(["fresh"]);
  });

  it("lets a lane that genuinely emptied reach its empty state", () => {
    // Every row archived: once the query settles, [] must mean [] — the
    // remembered rows must not resurrect a lane that is now empty.
    expect(conversationRowsToRender("Exhausted", WAITING, [], remembered)).toEqual([]);
  });
});

describe("conversationTabKey", () => {
  it("gives every (lane, assignment) pair its own key", () => {
    // A collision would let one tab's remembered rows render under
    // another tab's heading during a pagination reset.
    const lanes: InboxLane[] = ["active", "waiting", "chasing", "archived", "snoozed"];
    const assignments: AssignmentTab[] = ["all", "mine", "unassigned"];
    const seen = new Set<string>();
    for (const lane of lanes) {
      for (const assignment of assignments) seen.add(conversationTabKey(lane, assignment));
    }
    expect(seen.size).toBe(lanes.length * assignments.length);
  });
});

describe("historyActionForOpen", () => {
  it("pushes when opening from the list, so hardware back returns to it", () => {
    expect(historyActionForOpen(null)).toBe("push");
  });

  it("replaces when switching thread to thread, keeping chat-hopping out of the stack", () => {
    expect(historyActionForOpen("conv_1")).toBe("replace");
  });
});

describe("historyActionForClose", () => {
  it("goes back when opening pushed an entry, so no dead ?c= entry is left behind", () => {
    expect(historyActionForClose(true)).toBe("back");
  });

  it("rewrites the URL when there is nothing behind the thread to go back to", () => {
    expect(historyActionForClose(false)).toBe("replace");
  });
});

describe("parseAssignmentTab", () => {
  it("reads the tab the home-screen shortcut asks for", () => {
    expect(parseAssignmentTab("unassigned")).toBe("unassigned");
    expect(parseAssignmentTab("mine")).toBe("mine");
    expect(parseAssignmentTab("all")).toBe("all");
  });

  it("falls back to 'all' for anything a person could type wrong", () => {
    for (const raw of [null, undefined, "", "Unassigned", "nope", "MINE"]) {
      expect(parseAssignmentTab(raw)).toBe("all");
    }
  });
});
