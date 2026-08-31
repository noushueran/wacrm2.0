"use client";

import { Component } from "react";
import type { ReactNode } from "react";

/**
 * Class-based React error boundary — the only way to catch a render-time
 * throw from a descendant, which is exactly what `useQuery` does when
 * `conversations.get` fails inside a caller's fetch-only component —
 * `DeepLinkFallbackFetcher` in the Inbox (`src/app/(dashboard)/inbox/
 * page.tsx`) or `SelectedConversationFetcher` in the Lead Analysis
 * workspace (`src/app/(dashboard)/lead-analysis/page.tsx`):
 * `requireConversationAccess` (convex/lib/conversationAccess.ts) throws a
 * `ConvexError NOT_FOUND` for an id that doesn't exist, belongs to
 * another account, OR (per `canAccessConversation`,
 * convex/lib/roles.ts) sits outside the caller's role scope — e.g. an
 * agent's stale deep link to a conversation since reassigned to a
 * colleague. A malformed `?c=` value fails Convex's own
 * `v.id("conversations")` argument validator first, which throws too.
 * Both are indistinguishable from here and both mean the same thing for
 * this UI: there's no fallback conversation to show.
 *
 * Mirrors `BroadcastNotFoundBoundary` in
 * `src/app/(dashboard)/broadcasts/[id]/page.tsx` for the same reason: a
 * `try/catch` wrapped directly around the `useQuery` call would make
 * `eslint-plugin-react-hooks`'s `rules-of-hooks` flag a conditional hook
 * call, so a boundary is the correct, lint-clean tool for this.
 *
 * Deliberately narrow, unlike the broadcasts page's boundary (which
 * wraps that entire route's content): at every call site this wraps
 * ONLY the caller's render-nothing fetch component (`DeepLinkFallbackFetcher`
 * in the Inbox, `SelectedConversationFetcher` in Lead Analysis), whose
 * sole job is the fallback/resolved-conversation query — not
 * `ConversationList`, `MessageThread`, or anything else in the
 * surrounding page. Catching *any* error unconditionally is safe here
 * specifically because nothing else lives inside this boundary at any
 * call site; a genuine bug anywhere else on a page is outside it and
 * still surfaces normally instead of being silently absorbed.
 *
 * `fallback` renders `null` rather than its own "not found" UI: catching
 * the error just means `onResolved` never fires, so the caller's
 * resolved-conversation state (`fallbackConversation` in `InboxPage`,
 * `resolved` in `LeadAnalysisPage`) stays whatever it already was,
 * `activeConversation` stays null, and `MessageThread` already renders
 * its own "select a conversation" empty state whenever it's handed a
 * null conversation — there's no separate UI to build for this case.
 *
 * Keyed by `deepLinkConvId` at the call site so a caught error doesn't
 * stick around forever: without a key, this class instance (and its
 * `hasError` state) would persist across different deep-link ids since
 * it never unmounts on its own, silently breaking every subsequent
 * fallback attempt after the first bad one. The `key` forces a fresh
 * instance per attempted id instead.
 *
 * Shared by the Inbox's deep-link fallback and the Lead Analysis
 * workspace's right pane. Both render a component whose only job is a
 * `conversations.get` that can throw at render time: `NOT_FOUND` for an
 * id that doesn't exist, belongs to another account, or sits outside the
 * caller's role scope, and an argument-validator throw for a malformed
 * id. Both cases mean the same thing to the UI — there is no
 * conversation to show — so the boundary renders `null` and each caller
 * falls back to the empty state it already has.
 *
 * ALWAYS key this by the conversation id at the call site. Without a
 * key the instance (and its `hasError` state) survives an id change, so
 * one bad id silently disables every fetch that follows it.
 */
export class ConversationFetchBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
