import { accountQuery } from "./lib/auth";

// ============================================================
// What the knowledge gap agent has found, for its agent window.
//
// Member-safe like the rest of the roster: it exposes questions
// customers asked and what the agent did about them, never a key or a
// prompt. Every read is bounded.
// ============================================================

const THEME_LIMIT = 25;
const PROCESSED_SCAN = 500;

export const overview = accountQuery({
  args: {},
  handler: async (ctx) => {
    const themes = await ctx.db
      .query("kbGapThemes")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .take(THEME_LIMIT + 1);

    const processed = await ctx.db
      .query("kbGapProcessed")
      .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId))
      .take(PROCESSED_SCAN);

    const counts = { drafted: 0, skipped_thin_answer: 0, skipped_not_durable: 0 };
    for (const row of processed) counts[row.outcome] += 1;

    return {
      themes: themes.slice(0, THEME_LIMIT).map((t) => ({
        theme: t.theme,
        questionCount: t.questionCount,
        examples: t.examples,
      })),
      themesOverflow: themes.length > THEME_LIMIT,
      counts,
      // The scan is bounded, so say when the totals describe a window
      // rather than everything.
      countsTruncated: processed.length >= PROCESSED_SCAN,
    };
  },
});
