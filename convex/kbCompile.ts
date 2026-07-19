import { internalAction } from "./_generated/server";
import { v } from "convex/values";

// ============================================================
// Task-8 placeholder. `kbEntries.publish`/`unpublish` (Task 6) and
// `kbOps.publish`/`unpublish` (Task 7) schedule `internal.kbCompile.
// compileEntry`/`compileOps` respectively, so those mutations have
// somewhere to dispatch to; these stubs exist only to make those
// scheduler references resolve. Task 8 replaces both bodies with the
// real compiler (rebuild `kbChunks` for a published entry/ops block,
// delete them for a non-published one).
// ============================================================

export const compileEntry = internalAction({
  args: { entryId: v.id("kbEntries") },
  handler: async (): Promise<void> => {},
});

export const compileOps = internalAction({
  args: { opsBlockId: v.id("kbOpsBlocks") },
  handler: async (): Promise<void> => {},
});
