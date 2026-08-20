import { describe, expect, it } from "vitest";
import {
  AI_USAGE_MODES,
  addSample,
  emptyBucket,
  foldHoursIntoUsageSummary,
  type UsageHourBucket,
  type UsageSample,
} from "./aiUsageStats";

const HOUR = 3_600_000;
// A Wednesday, so a UTC+4 fold cannot accidentally pass by landing on the
// same day it started on.
const DAY0 = Date.parse("2026-08-05T00:00:00.000Z");

function sample(over: Partial<UsageSample> = {}): UsageSample {
  return {
    mode: "auto_reply",
    provider: "openai",
    model: "gpt-5.6-terra",
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    ...over,
  };
}

describe("addSample", () => {
  it("sums counters, and splits calls by mode and by provider:model", () => {
    const b = emptyBucket(DAY0);
    addSample(b, sample());
    addSample(b, sample({ mode: "embed", model: "text-embedding-3-small", totalTokens: 8 }));
    addSample(b, sample({ totalTokens: 200 }));

    expect(b.calls).toBe(3);
    expect(b.totalTokens).toBe(328);
    expect(b.modes).toEqual([
      { mode: "auto_reply", calls: 2, tokens: 320 },
      { mode: "embed", calls: 1, tokens: 8 },
    ]);
    expect(b.models).toEqual([
      {
        provider: "openai",
        model: "gpt-5.6-terra",
        calls: 2,
        tokens: 320,
        promptTokens: 200,
        completionTokens: 40,
        cachedPromptTokens: 0,
      },
      {
        provider: "openai",
        model: "text-embedding-3-small",
        calls: 1,
        tokens: 8,
        promptTokens: 100,
        completionTokens: 20,
        cachedPromptTokens: 0,
      },
    ]);
  });

  // The split is what makes a model priceable: `tokens` alone sums three
  // spans that bill at three different rates.
  it("accumulates the per-model token split, cache included", () => {
    const b = emptyBucket(DAY0);
    addSample(
      b,
      sample({ promptTokens: 1000, completionTokens: 50, cachedPromptTokens: 800 }),
    );
    addSample(
      b,
      sample({ promptTokens: 500, completionTokens: 10, cachedPromptTokens: 100 }),
    );

    expect(b.models[0]).toMatchObject({
      model: "gpt-5.6-terra",
      promptTokens: 1500,
      completionTokens: 60,
      cachedPromptTokens: 900,
    });
  });

  // An unreported cache figure still dilutes nothing at the bucket level
  // (`cacheablePromptTokens` handles that), but for PRICING an absent
  // figure means no cached span was billed, so zero is the right sum.
  it("treats an unreported cache figure as zero cached tokens for the model", () => {
    const b = emptyBucket(DAY0);
    addSample(b, sample({ promptTokens: 100 }));
    expect(b.models[0]?.cachedPromptTokens).toBe(0);
  });

  it("keeps the same model name on two providers apart", () => {
    const b = emptyBucket(DAY0);
    addSample(b, sample({ provider: "openai", model: "shared" }));
    addSample(b, sample({ provider: "anthropic", model: "shared" }));
    expect(b.models).toHaveLength(2);
  });

  it("counts a call toward the cache rate only when it reported one", () => {
    const b = emptyBucket(DAY0);
    // Reported: both the hit and the denominator move.
    addSample(b, sample({ promptTokens: 1000, cachedPromptTokens: 900 }));
    // Not measured: neither moves, so the rate is not diluted to 45%.
    addSample(b, sample({ promptTokens: 1000 }));
    // A measured ZERO is a real miss and MUST dilute it.
    addSample(b, sample({ promptTokens: 1000, cachedPromptTokens: 0 }));

    expect(b.promptTokens).toBe(3000);
    expect(b.cachedPromptTokens).toBe(900);
    expect(b.cacheablePromptTokens).toBe(2000);
  });

  it("treats an absent reasoning figure as zero", () => {
    const b = emptyBucket(DAY0);
    addSample(b, sample({ reasoningTokens: 64 }));
    addSample(b, sample());
    expect(b.reasoningTokens).toBe(64);
  });
});

describe("foldHoursIntoUsageSummary", () => {
  function hour(hourStartMs: number, samples: UsageSample[]): UsageHourBucket {
    const b = emptyBucket(hourStartMs);
    for (const s of samples) addSample(b, s);
    return b;
  }

  it("zero-fills every requested day and preserves their order", () => {
    const out = foldHoursIntoUsageSummary([], ["2026-08-04", "2026-08-05"], 0);
    expect(out.daily).toEqual([
      { date: "2026-08-04", tokens: 0, calls: 0 },
      { date: "2026-08-05", tokens: 0, calls: 0 },
    ]);
    expect(out.totals.totalTokens).toBe(0);
    expect(out.windowDays).toBe(2);
  });

  it("re-buckets UTC hours into the viewer's local days (UTC+4)", () => {
    // Dubai is UTC+4 -> getTimezoneOffset() === -240.
    // 22:00 UTC on the 4th is already 02:00 local on the 5th.
    const rows = [
      hour(DAY0 - 2 * HOUR, [sample({ totalTokens: 7 })]),
      hour(DAY0 + 6 * HOUR, [sample({ totalTokens: 5 })]),
    ];
    const out = foldHoursIntoUsageSummary(rows, ["2026-08-04", "2026-08-05"], -240);
    expect(out.daily).toEqual([
      { date: "2026-08-04", tokens: 0, calls: 0 },
      { date: "2026-08-05", tokens: 12, calls: 2 },
    ]);
  });

  it("drops hours outside the requested days from the chart AND the totals", () => {
    // The read over-fetches at the edges (`hourStartMs(sinceMs)` starts
    // before `sinceMs`). If a spill-over hour counted toward the tiles but
    // not the bars, "Total tokens" would stop reconciling with the chart.
    const rows = [
      hour(DAY0 - 26 * HOUR, [sample({ totalTokens: 999 })]), // 2026-08-03
      hour(DAY0 + HOUR, [sample({ totalTokens: 10 })]),
    ];
    const out = foldHoursIntoUsageSummary(rows, ["2026-08-05"], 0);
    expect(out.daily).toEqual([{ date: "2026-08-05", tokens: 10, calls: 1 }]);
    expect(out.totals.totalTokens).toBe(10);
    expect(out.totals.calls).toBe(1);
    expect(out.byMode.auto_reply).toEqual({ calls: 1, tokens: 10 });
  });

  it("reconciles: the per-mode tiles sum to the total, which sums to the chart", () => {
    const rows = [
      hour(DAY0, [
        sample({ mode: "auto_reply", totalTokens: 500 }),
        sample({ mode: "embed", totalTokens: 12 }),
      ]),
      hour(DAY0 + 3 * HOUR, [sample({ mode: "qualify", totalTokens: 300 })]),
    ];
    const out = foldHoursIntoUsageSummary(rows, ["2026-08-05"], 0);

    const modeSum = AI_USAGE_MODES.reduce((n, m) => n + out.byMode[m].tokens, 0);
    const chartSum = out.daily.reduce((n, d) => n + d.tokens, 0);
    expect(modeSum).toBe(812);
    expect(out.totals.totalTokens).toBe(812);
    expect(chartSum).toBe(812);
  });

  it("merges a model split across hours and sorts models by tokens desc", () => {
    const rows = [
      hour(DAY0, [
        sample({ model: "small", totalTokens: 5 }),
        sample({ model: "big", totalTokens: 100 }),
      ]),
      hour(DAY0 + HOUR, [sample({ model: "small", totalTokens: 5 })]),
    ];
    const out = foldHoursIntoUsageSummary(rows, ["2026-08-05"], 0);
    expect(out.byModel.map((m) => [m.model, m.calls, m.tokens])).toEqual([
      ["big", 1, 100],
      ["small", 2, 10],
    ]);
    // Merged across both hours, not just the last one seen.
    expect(out.byModel[1]).toMatchObject({
      model: "small",
      promptTokens: 200,
      completionTokens: 40,
    });
  });

  // A bucket written before the split shipped carries none. Pricing the
  // hours that DO have it would report a confident total covering an
  // unknown fraction of the window, so the model drops out of pricing
  // entirely until the backfill rebuilds it.
  it("drops the split for a model if any contributing hour predates it", () => {
    const withSplit = hour(DAY0, [sample({ model: "m", totalTokens: 100 })]);
    const legacy: UsageHourBucket = {
      ...emptyBucket(DAY0 + HOUR),
      calls: 1,
      totalTokens: 100,
      models: [{ provider: "openai", model: "m", calls: 1, tokens: 100 }],
    };

    const out = foldHoursIntoUsageSummary([withSplit, legacy], ["2026-08-05"], 0);

    const m = out.byModel.find((x) => x.model === "m");
    // The volume figures still reconcile — only the price inputs go.
    expect(m).toMatchObject({ calls: 2, tokens: 200 });
    expect(m?.promptTokens).toBeUndefined();
    expect(m?.completionTokens).toBeUndefined();
    expect(m?.cachedPromptTokens).toBeUndefined();
  });

  it("keeps the split when every contributing hour carries it", () => {
    const out = foldHoursIntoUsageSummary(
      [
        hour(DAY0, [sample({ model: "m", promptTokens: 10, completionTokens: 1 })]),
        hour(DAY0 + HOUR, [
          sample({ model: "m", promptTokens: 20, completionTokens: 2 }),
        ]),
      ],
      ["2026-08-05"],
      0,
    );
    expect(out.byModel[0]).toMatchObject({ promptTokens: 30, completionTokens: 3 });
  });

  it("gives every known mode a slot even when nothing used it", () => {
    const out = foldHoursIntoUsageSummary([], ["2026-08-05"], 0);
    for (const m of AI_USAGE_MODES) {
      expect(out.byMode[m]).toEqual({ calls: 0, tokens: 0 });
    }
  });

  it("ignores a stored mode that is no longer known rather than throwing", () => {
    const row = { ...emptyBucket(DAY0), calls: 1, totalTokens: 9 } as UsageHourBucket;
    row.modes = [{ mode: "retired_mode", calls: 1, tokens: 9 }] as never;
    const out = foldHoursIntoUsageSummary([row], ["2026-08-05"], 0);
    expect(out.totals.totalTokens).toBe(9);
    expect(out.byMode.auto_reply).toEqual({ calls: 0, tokens: 0 });
  });
});
