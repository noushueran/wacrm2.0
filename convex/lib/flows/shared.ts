/**
 * Shared node-shape types for the Flows engine.
 *
 * Extracted from `src/components/flows/shared.tsx`'s `NodeType`/
 * `BuilderNode` exports — that file is a `.tsx` React component module
 * (lucide-react icons, `@/lib/utils`'s `cn`, a JSX icon-chip component)
 * with no place in a Convex `lib/` module. `edges.ts` (and its ported
 * test) only ever need the two plain-data type declarations below,
 * which have zero React/lucide-react dependencies, so they're pulled
 * out here rather than dragging the whole UI file into the Convex
 * bundle.
 *
 * Kept in lockstep with `FlowNodeType` in `./types.ts` (which drives
 * the engine's exhaustiveness checks) — a divergence between the two
 * is always a bug, same caveat the original file's header comment
 * makes about its own `NodeType`.
 */

export type NodeType =
  | "start"
  | "send_message"
  | "send_buttons"
  | "send_list"
  | "send_media"
  | "collect_input"
  | "condition"
  | "set_tag"
  | "handoff"
  | "end";

export interface BuilderNode {
  node_key: string;
  node_type: NodeType;
  config: Record<string, unknown>;
  /** Optional in v1 — defaults to 0 in the DB. Canvas view reads it
   *  to position nodes; list view ignores it. */
  position_x?: number;
  position_y?: number;
}
