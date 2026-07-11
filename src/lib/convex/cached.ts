"use client";

// Cached Convex hooks — drop-in replacements for `useQuery` /
// `usePaginatedQuery` from `convex/react`, backed by the
// `<ConvexQueryCacheProvider>` mounted in `src/app/ConvexClientProvider.tsx`.
//
// Why this exists:
//   The stock `convex/react` hooks drop their subscription the moment the
//   component using them unmounts. So every time you navigate away from a
//   section (Inbox, Contacts, …) and back, its queries re-subscribe and
//   re-fetch from zero — a full round-trip to the self-hosted Convex
//   backend before ANYTHING renders. That round-trip is the bulk of the
//   1–2s per-section load users were seeing.
//
//   These cached variants keep the subscription warm for a few minutes
//   after unmount (see the provider's `expiration`), so returning to an
//   already-visited section renders its last-known data instantly while
//   Convex revalidates in the background. Signatures + return types are
//   identical to the stock hooks, so call sites are unchanged apart from
//   this import path.
//
//   `useMutation` is intentionally NOT re-exported — mutations aren't
//   cacheable; keep importing it from `convex/react`.
export {
  useQuery,
  usePaginatedQuery,
  useQueries,
} from "convex-helpers/react/cache/hooks";
