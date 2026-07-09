"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import {
  derivePresence,
  type PresenceRow,
  type PresenceStatus,
} from "@/lib/presence";

// How often the viewer re-derives presence locally. The online→offline
// transition fires NO database event (it's just the clock passing the
// staleness threshold), so without this tick a member who closes their
// tab would appear online forever. ~15s keeps "offline" responsive
// without busy-spinning.
const RE_DERIVE_MS = 15_000;

interface UsePresenceResult {
  /** Derived status for one member (defaults to offline if unseen). */
  getPresence: (userId: string) => PresenceStatus;
  /** Raw row for tooltips ("last seen …"). */
  getRow: (userId: string) => PresenceRow | undefined;
  /**
   * The clock value the hook is currently deriving against. Pass this
   * to `presenceLabel` / `formatLastSeen` so labels stay in lockstep
   * with the dots (both advance on the same ~15s re-derive tick).
   */
  now: number;
}

/**
 * Live presence for every member of the caller's account. Reads
 * `api.presence.list` — a reactive Convex query, scoped server-side to
 * the caller's own account — and re-derives "offline" on a local timer.
 * Convex pushes updates automatically on every teammate's
 * `presence.touch` heartbeat, so there's no realtime channel to manage
 * here (unlike the previous Supabase Realtime subscription).
 *
 * Account comes from useAuth; pass `enabled: false` to opt a consumer
 * out (e.g. while a parent sheet is closed).
 */
export function usePresence(enabled = true): UsePresenceResult {
  const { accountId } = useAuth();
  const active = enabled && !!accountId;

  const rows = useQuery(api.presence.list, active ? {} : "skip");

  // `now` ticks so derivePresence re-evaluates staleness over time —
  // the online→offline transition fires no data change of its own
  // (it's just the clock passing OFFLINE_AFTER_MS), so without this
  // tick a member who closed their tab would appear online forever.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const tick = setInterval(() => setNow(Date.now()), RE_DERIVE_MS);
    return () => clearInterval(tick);
  }, [active]);

  // Presence rows keyed by userId. Convex's `lastSeenAt` is a number
  // (epoch ms); `derivePresence`/`PresenceRow` (both from
  // `src/lib/presence.ts`, kept stable per that file's own pure-
  // function contract) expect an ISO string `last_seen_at` — the
  // conversion happens here at the call site rather than in
  // `derivePresence` itself.
  const rowByUserId = useMemo(() => {
    const map = new Map<string, PresenceRow>();
    for (const r of rows ?? []) {
      map.set(r.userId, {
        status: r.status,
        last_seen_at: new Date(r.lastSeenAt).toISOString(),
      });
    }
    return map;
  }, [rows]);

  const getRow = useCallback(
    (userId: string): PresenceRow | undefined => rowByUserId.get(userId),
    [rowByUserId],
  );

  const getPresence = useCallback(
    (userId: string): PresenceStatus => {
      const row = rowByUserId.get(userId);
      return derivePresence(row?.status, row?.last_seen_at, now);
    },
    [rowByUserId, now],
  );

  return { getPresence, getRow, now };
}
