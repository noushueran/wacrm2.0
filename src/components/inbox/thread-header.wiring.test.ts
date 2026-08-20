import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard against a silent un-refactor.
 *
 * The thread header was extracted out of `message-thread.tsx` into
 * `ThreadHeader` + `LeadPopover`. A later `Merge origin/main` (c76e788)
 * resolved `message-thread.tsx` in favour of main's copy, which still had
 * the old inline header. The extracted files survived as ADDITIONS — main
 * had nothing to conflict with them — so nothing failed: the components
 * were simply orphaned, and the old wrapping header rendered again for
 * days. The unit suite stayed green throughout, because the pure helpers
 * are tested in isolation and nothing asserted that anything RENDERS them.
 *
 * These are source assertions rather than render assertions on purpose:
 * the repo has no jsdom or Testing Library (`src/**` tests run in plain
 * node), and `MessageThread` needs Convex, next-intl and presence
 * providers to render at all. What actually broke was the wiring, and the
 * wiring is exactly what this reads.
 */

const SRC = join(__dirname, "../../..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("thread header wiring", () => {
  const messageThread = read("components/inbox/message-thread.tsx");

  it("renders ThreadHeader rather than an inline header", () => {
    expect(messageThread).toContain(
      'import { ThreadHeader } from "@/components/inbox/thread-header"',
    );
    expect(messageThread).toContain("<ThreadHeader");
  });

  it("does not reintroduce the inline header's wrapping identity row", () => {
    // The original defect: a single wrapping flex row whose height and
    // control positions changed per conversation, depending on which
    // conditional badges rendered.
    expect(messageThread).not.toContain("flex min-w-0 flex-wrap items-center");
  });

  it("keeps the header's own markup out of message-thread.tsx", () => {
    // The old header's outer div. `ThreadHeader` owns this now; finding it
    // here means the header was pasted back in.
    expect(messageThread).not.toContain(
      "border-b border-border bg-card px-3 py-3",
    );
  });
});

describe("thread header overlap fixes", () => {
  it("keeps overflow-hidden on the identity zone", () => {
    // `min-w-0` lets the contact name truncate, but it also removes the
    // zone's min-content floor: flexbox then crushes the zone and its own
    // `shrink-0` children (avatar, window pill) paint on top of the
    // controls. Measured at a 560px column before the fix: 178px zone
    // holding 229px of content, pill 123px inside the control cluster.
    const header = read("components/inbox/thread-header.tsx");
    expect(header).toContain("min-w-0 flex-1 items-center gap-2 overflow-hidden");
  });

  it("keeps the lead trigger's label at lg, not sm", () => {
    // Between 640 and 1024 the header carries the most at once (pill
    // present, mobile back button not yet gone, controls unshrinkable).
    // This label is the widest thing that can give way; at `sm:` the
    // window pill gets clipped instead.
    const popover = read("components/inbox/lead-popover.tsx");
    expect(popover).toContain('<span className="hidden lg:inline">');
    expect(popover).not.toContain('<span className="hidden sm:inline">');
  });
});
