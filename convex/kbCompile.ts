import { internalAction } from "./_generated/server";
import { v } from "convex/values";

// ============================================================
// Task-8 placeholder. `kbEntries.publish`/`unpublish` (Task 6) both
// schedule `internal.kbCompile.compileEntry` so those mutations have
// somewhere to dispatch to; this stub exists only to make that
// scheduler reference resolve. Task 8 replaces this body with the
// real compiler (rebuild `kbChunks` for a published entry, delete
// them for a non-published one) and adds a sibling `compileOps`.
// ============================================================

export const compileEntry = internalAction({
  args: { entryId: v.id("kbEntries") },
  handler: async (): Promise<void> => {},
});
