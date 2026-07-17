"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { MessageReaction } from "@/types";

interface MessageReactionsProps {
  reactions: MessageReaction[];
  currentUserId: string | undefined;
  /** Toggle the agent's reaction. If the agent already has this emoji →
   *  caller should send empty to remove; otherwise swap/add. */
  onToggle: (emoji: string) => void;
  /** When false (viewer role), pills render read-only: still visible so a
   *  viewer can see who reacted, but not clickable — a viewer's
   *  reactions.set/remove is rejected server-side (requireRole("agent")),
   *  so we never surface a toggle that would only fail. Defaults to true. */
  canReact?: boolean;
}

interface ReactionGroup {
  emoji: string;
  count: number;
  byCurrentUser: boolean;
}

function groupReactions(
  reactions: MessageReaction[],
  currentUserId: string | undefined,
): ReactionGroup[] {
  const map = new Map<string, ReactionGroup>();
  for (const r of reactions) {
    const existing = map.get(r.emoji);
    const isMine =
      r.actor_type === "agent" &&
      !!currentUserId &&
      r.actor_id === currentUserId;
    if (existing) {
      existing.count += 1;
      existing.byCurrentUser = existing.byCurrentUser || isMine;
    } else {
      map.set(r.emoji, { emoji: r.emoji, count: 1, byCurrentUser: isMine });
    }
  }
  return [...map.values()];
}

export function MessageReactions({
  reactions,
  currentUserId,
  onToggle,
  canReact = true,
}: MessageReactionsProps) {
  const groups = useMemo(
    () => groupReactions(reactions, currentUserId),
    [reactions, currentUserId],
  );

  if (groups.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {groups.map((g) => {
        // Viewers are read-only: render the pill as a non-interactive
        // <span> so reactions stay visible but can't be toggled. A
        // viewer's reactions.set/remove is rejected server-side
        // (requireRole("agent")), so we never surface a toggle that
        // would only fail.
        if (!canReact) {
          return (
            <span
              key={g.emoji}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none",
                g.byCurrentUser
                  ? "border-primary/60 bg-primary/15 text-primary"
                  : "border-border bg-muted/80 text-foreground",
              )}
            >
              <span className="text-sm leading-none">{g.emoji}</span>
              {g.count > 1 && <span>{g.count}</span>}
            </span>
          );
        }
        return (
          <button
            key={g.emoji}
            type="button"
            onClick={() => onToggle(g.emoji)}
            aria-pressed={g.byCurrentUser}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] leading-none transition-colors",
              g.byCurrentUser
                ? "border-primary/60 bg-primary/15 text-primary hover:bg-primary/25"
                : "border-border bg-muted/80 text-foreground hover:bg-muted",
            )}
          >
            <span className="text-sm leading-none">{g.emoji}</span>
            {g.count > 1 && <span>{g.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
