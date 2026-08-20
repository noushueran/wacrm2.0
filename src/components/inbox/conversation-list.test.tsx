import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "use-intl";

import {
  ConversationItem,
  ConversationListSkeleton,
  LaneTabs,
  laneEmptyMessageKey,
} from "./conversation-list";
import type { Conversation } from "@/types";
import enMessages from "../../../messages/en.json";

/**
 * Static-render tests of a single inbox row, matching this repo's other
 * component tests (`voice-transcript.test.tsx`,
 * `ui/dropdown-menu-group-label.test.tsx`) — there is no jsdom and no
 * Testing Library here, so these assert on markup, not on clicks.
 *
 * That limitation still covers the thing most likely to break the
 * mark-unread control: it is deliberately a SIBLING of the row's own
 * <button>, not a child. A button nested inside a button is invalid
 * HTML, and browsers recover by hoisting the inner one out of its
 * parent — which silently detaches the row's click handling. Nesting is
 * visible in static markup; the click behaviour it would break is not.
 */

const T_STRINGS: Record<string, string> = {
  markUnread: "Mark as unread",
  unknown: "Unknown",
  noMessagesYet: "No messages yet",
  assignedToYou: "You",
  snoozedUntilRow: "Snoozed until {when}",
  forcedChasingBadge: "Marked",
};

// The component takes its translator as a prop, so the test supplies a
// plain lookup rather than mounting next-intl's provider.
const t = ((key: string) =>
  T_STRINGS[key] ?? key) as unknown as React.ComponentProps<
  typeof ConversationItem
>["t"];

const T_WINDOW_STRINGS: Record<string, string> = {
  listFreeBadge: "Free",
  listFreeBadgeTitle: "Ad lead inside its free messaging window",
};

const tWindow = ((key: string) =>
  T_WINDOW_STRINGS[key] ?? key) as unknown as React.ComponentProps<
  typeof ConversationItem
>["tWindow"];

/** Fixed clock so the window assertions don't drift with wall time. */
const NOW = Date.parse("2026-07-24T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv1",
    user_id: "user1",
    contact_id: "contact1",
    status: "open",
    unread_count: 0,
    created_at: "2026-07-20T10:00:00.000Z",
    updated_at: "2026-07-20T10:00:00.000Z",
    last_message_text: "Is the Dubai package still available?",
    last_message_at: "2026-07-20T10:00:00.000Z",
    contact: {
      id: "contact1",
      user_id: "user1",
      phone: "+971500000000",
      name: "Aisha",
      created_at: "2026-07-20T10:00:00.000Z",
      updated_at: "2026-07-20T10:00:00.000Z",
    },
    ...overrides,
  } as Conversation;
}

function render(
  conv: Conversation,
  props: Partial<React.ComponentProps<typeof ConversationItem>> = {},
) {
  return renderToStaticMarkup(
    React.createElement(ConversationItem, {
      conversation: conv,
      isActive: false,
      onSelect: () => {},
      onMarkUnread: () => {},
      assignee: { kind: "unassigned" },
      onHover: () => {},
      onHoverEnd: () => {},
      t,
      tWindow,
      nowMs: NOW,
      groups: [],
      // Every existing test in this file predates lane tabs, so the
      // default is "active" — the lane whose rendering these tests were
      // originally written to assert on, and which the Chasing-only
      // branch below leaves untouched.
      lane: "active",
      // Spread last so a test can override a prop with an explicit
      // `undefined` — a default parameter can't express that, since
      // `undefined` is exactly what triggers the default.
      ...props,
    }),
  );
}

describe("ConversationItem — mark as unread", () => {
  it("offers the control on a row that has already been read", () => {
    const html = render(conversation({ unread_count: 0 }));
    expect(html).toContain('aria-label="Mark as unread"');
  });

  it("hides the control while the row is still unread", () => {
    // The badge already says "unread" here, and `conversations.markUnread`
    // no-ops on a nonzero count server-side — offering it would be a
    // button that visibly does nothing.
    const html = render(conversation({ unread_count: 3 }));
    expect(html).not.toContain('aria-label="Mark as unread"');
  });

  it("hides the control from a viewer", () => {
    // The list withholds the handler entirely for `accountRole ===
    // "viewer"`; `conversations.markUnread` requires an agent, so the
    // control would only ever fail server-side for them.
    const html = render(conversation({ unread_count: 0 }), {
      onMarkUnread: undefined,
    });
    expect(html).not.toContain('aria-label="Mark as unread"');
  });

  it("keeps the control OUTSIDE the row button, not nested inside it", () => {
    const html = render(conversation({ unread_count: 0 }));
    const rowEnd = html.indexOf("</button>");
    const control = html.indexOf('aria-label="Mark as unread"');
    expect(rowEnd).toBeGreaterThan(-1);
    expect(control).toBeGreaterThan(rowEnd);
  });

  it("stays visible without hover below the sm breakpoint", () => {
    // Coarse pointers have no hover state, so the hiding — not the
    // showing — is what gets gated on `sm:`. A bare `opacity-0` here
    // would leave an invisible-but-tappable button on phones.
    const html = render(conversation({ unread_count: 0 }));
    expect(html).toContain("sm:opacity-0");
    expect(html).toContain("sm:group-hover:opacity-100");
    // Unprefixed `opacity-0` only — the lookbehind is what keeps this
    // from matching the `sm:`-prefixed variant the line above requires.
    expect(html).not.toMatch(/(?<![:\w-])opacity-0(?![\w-])/);
  });
});

describe("ConversationItem — free messaging window badge", () => {
  it("marks an ad lead whose 72h free window is still open", () => {
    // Meta opened the window when we replied 2h after the click, so it
    // runs until 72h after that reply.
    const html = render(
      conversation({
        ad_referral: { started_at: new Date(NOW - 10 * HOUR).toISOString() },
        first_reply_at: new Date(NOW - 8 * HOUR).toISOString(),
      }),
    );
    expect(html).toContain(">Free<");
  });

  it("prefers Meta's authoritative window over the local estimate", () => {
    const html = render(
      conversation({
        ad_referral: { started_at: new Date(NOW - 10 * HOUR).toISOString() },
        first_reply_at: new Date(NOW - 8 * HOUR).toISOString(),
        // Meta says this one has already closed, whatever the estimate says.
        meta_window: {
          is_free_entry_point: true,
          expires_at: new Date(NOW - HOUR).toISOString(),
        },
      }),
    );
    expect(html).not.toContain(">Free<");
  });

  it("stays off an ad lead that was never replied to inside 24h", () => {
    // No reply within a day of the click means Meta never opened a free
    // window at all — showing one would promise free messaging that bills.
    const html = render(
      conversation({
        ad_referral: { started_at: new Date(NOW - 40 * HOUR).toISOString() },
      }),
    );
    expect(html).not.toContain(">Free<");
  });

  it("stays off an ordinary, non-ad conversation", () => {
    const html = render(conversation());
    expect(html).not.toContain(">Free<");
  });

  it("stays off once the window has run out", () => {
    const html = render(
      conversation({
        ad_referral: { started_at: new Date(NOW - 100 * HOUR).toISOString() },
        first_reply_at: new Date(NOW - 99 * HOUR).toISOString(),
      }),
    );
    expect(html).not.toContain(">Free<");
  });
});

/**
 * Task 7 (chasing row detail): unlike `T_STRINGS` above (a plain lookup
 * that ignores its `values` argument entirely — fine for the strings
 * every other test in this file needs, none of which interpolate), these
 * two tests need REAL ICU interpolation/pluralization (`chasingProgress`
 * is `"{sent, plural, =0 {no nudges} =1 {1 nudge} other {# nudges}}"` —
 * see messages/en.json) to assert on the rendered text. `createTranslator`
 * (the same primitive `next-intl`'s `useTranslations` is built on, see
 * `lead-analysis-list.test.tsx`'s `NextIntlClientProvider` for the
 * sibling pattern) over the REAL `Inbox.conversationList` messages gets
 * that for free instead of hand-rolling ICU substitution.
 */
const chasingT = createTranslator({
  locale: "en",
  messages: enMessages.Inbox.conversationList,
}) as unknown as React.ComponentProps<typeof ConversationItem>["t"];

describe("ConversationItem — Chasing lane detail", () => {
  // Built off the same fixed `NOW` the render() helper defaults `nowMs`
  // to (not `Date.now()`): the component computes quiet-days off `nowMs`
  // — a real `Date.now()` call in render is a lint error
  // (`react-hooks/purity`) — so the fixture and the clock the component
  // renders against must agree, same as every other `nowMs`-driven test
  // in this file (see the free-window-badge tests above).
  it("shows how long a chasing row has been quiet, and its nudge count", () => {
    const html = render(
      conversation({
        last_message_at: new Date(NOW - 9 * 86_400_000).toISOString(),
        followUpsSent: 2,
        sequenceStatus: "running",
      }),
      { lane: "chasing", t: chasingT },
    );
    expect(html).toContain("Quiet 9d");
    expect(html).toContain("2 nudges");
  });

  it("badges an exhausted sequence as needing a decision", () => {
    const html = render(
      conversation({
        last_message_at: new Date(NOW - 20 * 86_400_000).toISOString(),
        followUpsSent: 3,
        sequenceStatus: "exhausted",
      }),
      { lane: "chasing", t: chasingT },
    );
    expect(html).toContain("Needs your decision");
  });

  it("leaves a non-chasing row's timestamp slot untouched even with sequence fields present", () => {
    // A defensive property, not just the happy path: rendering must be
    // driven by which TAB is showing the row, not by which fields
    // happen to be populated on the conversation object.
    const html = render(
      conversation({
        last_message_at: new Date(NOW - 9 * 86_400_000).toISOString(),
        followUpsSent: 2,
        sequenceStatus: "exhausted",
      }),
      { lane: "active", t: chasingT },
    );
    expect(html).not.toContain("Quiet 9d");
    expect(html).not.toContain("Needs your decision");
  });
});

/**
 * Task 7 (manual lane overrides — spec 2026-07-28-inbox-manual-
 * overrides): a Snoozed lane row and a forced-into-Chasing row each need
 * a visible tell that distinguishes them from the ordinary case — a
 * snoozed row from any other lane's row, a forced-Chasing row from one
 * that aged into Chasing on its own. Both use the plain `t`/`render`
 * stubs above (not `chasingT`), same as the mark-unread and free-window
 * describe blocks — neither string interpolates beyond the plain lookup
 * `T_STRINGS` already resolves.
 */
describe("ConversationItem — manual lane overrides (Task 7)", () => {
  it("a forced Chasing row is marked, so it reads differently from one that aged in", () => {
    const markup = render(
      {
        ...conversation(),
        chasing_forced_at: new Date(NOW - 60_000).toISOString(),
        last_message_at: new Date(NOW - 30 * 60_000).toISOString(),
      },
      { lane: "chasing" },
    );
    expect(markup).toContain("Marked");
  });

  it("a snoozed row shows when it wakes", () => {
    const markup = render(
      {
        ...conversation(),
        snoozed_until: new Date(NOW + 86_400_000).toISOString(),
      },
      { lane: "snoozed" },
    );
    expect(markup).toContain("Snoozed until");
  });
});

/**
 * Task 6 (lane tabs): `LaneTabs` and `laneEmptyMessageKey` are pulled out
 * of `ConversationList` for the same reason `ConversationItem` is above —
 * `ConversationList` itself opens Convex subscriptions (`useQuery` for
 * tags/groups/members, plus `<OwnSpendLine />`'s own query), so
 * `renderToStaticMarkup` on the full list throws with no `ConvexProvider`
 * in the tree. Neither of these two pieces has a data dependency of its
 * own, so extracting them sidesteps that instead of mocking Convex.
 *
 * `LaneTabs` mirrors `ConversationItem`'s translation pattern exactly:
 * it takes `t` as a prop and the test supplies a plain lookup, rather
 * than mounting next-intl's provider.
 */

const T_LANE_STRINGS: Record<string, string> = {
  laneActive: "Active",
  laneWaiting: "Waiting",
  laneChasing: "Chasing",
  laneArchived: "Archived",
  laneSnoozed: "Snoozed",
};

const laneT = ((key: string) =>
  T_LANE_STRINGS[key] ?? key) as unknown as React.ComponentProps<
  typeof LaneTabs
>["t"];

describe("LaneTabs", () => {
  it("renders one tab per lane", () => {
    const html = renderToStaticMarkup(
      <LaneTabs lane="chasing" onLaneChange={() => {}} t={laneT} />,
    );
    for (const label of ["Active", "Waiting", "Chasing", "Archived", "Snoozed"]) {
      expect(html).toContain(label);
    }
  });

  it("highlights only the active lane's tab", () => {
    const html = renderToStaticMarkup(
      <LaneTabs lane="chasing" onLaneChange={() => {}} t={laneT} />,
    );
    const chasingIndex = html.indexOf(">Chasing<");
    const chasingButtonStart = html.lastIndexOf("<button", chasingIndex);
    const chasingButtonEnd = html.indexOf(">", chasingButtonStart);
    const chasingTag = html.slice(chasingButtonStart, chasingButtonEnd);
    expect(chasingTag).toContain("text-primary");

    const activeIndex = html.indexOf(">Active<");
    const activeButtonStart = html.lastIndexOf("<button", activeIndex);
    const activeButtonEnd = html.indexOf(">", activeButtonStart);
    const activeTag = html.slice(activeButtonStart, activeButtonEnd);
    expect(activeTag).not.toContain("text-primary");
  });

  it("lets every tab shrink, so the five never overflow the row", () => {
    // Asserting on classes rather than behaviour, deliberately: there is
    // no jsdom here and therefore no layout, so the ONLY way to pin this
    // fix is the markup that causes it.
    //
    // What it protects: `flex-1` alone leaves each button's automatic
    // minimum size at its own text width, so the tabs refuse to shrink
    // and overflow the row instead of sharing it. At the panel's old
    // 320px they summed to 324px and the parent's overflow-hidden cut
    // "Snoozed" through the middle of a glyph. `min-w-0` is what lets
    // them share the row; `truncate` makes any future overflow an
    // ellipsis instead of a sliced letter. Dropping either brings the
    // clipping straight back, and nothing else in this suite would
    // notice.
    const html = renderToStaticMarkup(
      <LaneTabs lane="active" onLaneChange={() => {}} t={laneT} />,
    );
    const tags = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    expect(tags).toHaveLength(5);
    for (const tag of tags) {
      expect(tag).toContain("min-w-0");
      expect(tag).toContain("truncate");
    }
  });

  it("renders without the optional prefetch handlers", () => {
    // They are optional so this row stays renderable in isolation (this
    // suite passes neither). A required handler would break every static
    // render above, but only this assertion says so on purpose.
    expect(() =>
      renderToStaticMarkup(
        <LaneTabs lane="snoozed" onLaneChange={() => {}} t={laneT} />,
      ),
    ).not.toThrow();
  });
});

describe("ConversationListSkeleton", () => {
  it("renders one placeholder row per requested row", () => {
    const html = renderToStaticMarkup(<ConversationListSkeleton rows={4} />);
    // Three pulsing blocks per row: avatar, name line, preview line.
    expect(html.match(/animate-pulse/g)).toHaveLength(12);
  });

  it("mirrors a real row's geometry so the list doesn't shift on load", () => {
    // The point of showing rows instead of a spinner is that nothing
    // jumps when the real data lands: same avatar size (h-11 w-11),
    // same gap, same padding as `ConversationItem`.
    const html = renderToStaticMarkup(<ConversationListSkeleton rows={1} />);
    expect(html).toContain("h-11 w-11");
    expect(html).toContain("gap-3");
    expect(html).toContain("p-3");
  });
});

describe("laneEmptyMessageKey", () => {
  it("maps each lane to its own distinct message key", () => {
    expect(laneEmptyMessageKey("active")).toBe("laneActiveEmpty");
    expect(laneEmptyMessageKey("waiting")).toBe("laneWaitingEmpty");
    expect(laneEmptyMessageKey("chasing")).toBe("laneChasingEmpty");
    expect(laneEmptyMessageKey("archived")).toBe("laneArchivedEmpty");
    expect(laneEmptyMessageKey("snoozed")).toBe("laneSnoozedEmpty");
  });

  it("resolves to the real en.json copy for each lane", () => {
    // Ties the pure key mapping to the actual shipped strings, so this
    // still catches a wrong/missing key even though (unlike the
    // original plan's test) nothing here renders `ConversationList`
    // itself to see the empty state in context.
    const strings = enMessages.Inbox.conversationList as Record<
      string,
      string
    >;
    expect(strings[laneEmptyMessageKey("active")]).toBe(
      "Nothing waiting on a reply. Good place to be.",
    );
    expect(strings[laneEmptyMessageKey("waiting")]).toBe(
      "No threads waiting on a customer.",
    );
    expect(strings[laneEmptyMessageKey("chasing")]).toBe(
      "Nothing has gone quiet long enough to chase.",
    );
    expect(strings[laneEmptyMessageKey("archived")]).toBe(
      "Nothing archived yet.",
    );
    expect(strings[laneEmptyMessageKey("snoozed")]).toBe("Nothing snoozed.");
  });
});
