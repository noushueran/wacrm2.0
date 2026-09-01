import { describe, it, expect } from "vitest";
import {
  lifecycleFunnel,
  responseBucketFor,
  emptyResponseBuckets,
  addResponseBucket,
  pricingCategoryKey,
  emptyPricingCategories,
  addPricingCategory,
  localWeekKeyFromMs,
  foldHoursIntoVolume,
  foldHoursIntoHourOfDay,
  foldHoursIntoResponseSeries,
  percentileRange,
  withinTargetRatio,
  sumResponseBuckets,
  foldHoursIntoBilling,
} from "./reportStats";

describe("responseBucketFor", () => {
  it("classifies by elapsed minutes, lower bound inclusive", () => {
    expect(responseBucketFor(0)).toBe("m1");
    expect(responseBucketFor(59_999)).toBe("m1");
    expect(responseBucketFor(60_000)).toBe("m5");
    expect(responseBucketFor(5 * 60_000 - 1)).toBe("m5");
    expect(responseBucketFor(5 * 60_000)).toBe("m15");
    expect(responseBucketFor(15 * 60_000)).toBe("m60");
    expect(responseBucketFor(60 * 60_000)).toBe("m240");
    expect(responseBucketFor(240 * 60_000)).toBe("over");
    expect(responseBucketFor(99 * 3_600_000)).toBe("over");
  });
});

describe("addResponseBucket", () => {
  it("treats an absent histogram as all-zero", () => {
    expect(addResponseBucket(undefined, "m5")).toEqual({
      ...emptyResponseBuckets(),
      m5: 1,
    });
  });

  it("increments only the named bucket", () => {
    const start = { ...emptyResponseBuckets(), m1: 2 };
    expect(addResponseBucket(start, "m1")).toEqual({
      ...emptyResponseBuckets(),
      m1: 3,
    });
  });
});

describe("pricingCategoryKey", () => {
  it("maps Meta's category spellings, case-insensitively", () => {
    expect(pricingCategoryKey("marketing", true)).toBe("marketing");
    expect(pricingCategoryKey("UTILITY", true)).toBe("utility");
    expect(pricingCategoryKey("service", true)).toBe("service");
    expect(pricingCategoryKey("authentication", true)).toBe("authentication");
    expect(pricingCategoryKey("authentication_international", true)).toBe(
      "authentication",
    );
  });

  it("treats both eras' free spellings as free", () => {
    expect(pricingCategoryKey("referral_conversion", true)).toBe("free");
    expect(pricingCategoryKey("free_entry_point", true)).toBe("free");
  });

  // `billable: false` is Meta stating the outcome directly; it outranks
  // whatever category string came alongside it.
  it("prefers an explicit billable:false over the category", () => {
    expect(pricingCategoryKey("marketing", false)).toBe("free");
  });

  // Meta is mid-migration between CBP and PMP spellings, so an unknown
  // category is expected, not exceptional. It must land in a real bucket or
  // the per-category totals would silently fail to sum to the message count.
  it("routes unknown and absent categories to `other`", () => {
    expect(pricingCategoryKey("some_future_tier", true)).toBe("other");
    expect(pricingCategoryKey(undefined, undefined)).toBe("other");
  });
});

describe("addPricingCategory", () => {
  it("treats an absent record as all-zero and increments one key", () => {
    expect(addPricingCategory(undefined, "utility")).toEqual({
      ...emptyPricingCategories(),
      utility: 1,
    });
  });
});

const H = (iso: string) => Date.parse(iso);

describe("localWeekKeyFromMs", () => {
  it("keys a week by its Monday", () => {
    // 2026-08-05 is a Wednesday; its Monday is 2026-08-03.
    expect(localWeekKeyFromMs(H("2026-08-05T10:00:00Z"), 0)).toBe("2026-08-03");
    expect(localWeekKeyFromMs(H("2026-08-03T00:00:00Z"), 0)).toBe("2026-08-03");
    // Sunday belongs to the week that began the previous Monday.
    expect(localWeekKeyFromMs(H("2026-08-09T23:00:00Z"), 0)).toBe("2026-08-03");
    expect(localWeekKeyFromMs(H("2026-08-10T00:00:00Z"), 0)).toBe("2026-08-10");
  });

  it("respects the caller's offset at a week boundary", () => {
    // 2026-08-10T00:30Z is Monday in UTC but still Sunday in UTC-4 (+240).
    expect(localWeekKeyFromMs(H("2026-08-10T00:30:00Z"), 240)).toBe("2026-08-03");
  });
});

describe("foldHoursIntoVolume", () => {
  const rows = [
    { hourStartMs: H("2026-08-03T08:00:00Z"), incoming: 3, outgoing: 1, conversationsStarted: 2, conversationsStartedAd: 1 },
    { hourStartMs: H("2026-08-04T09:00:00Z"), incoming: 1, outgoing: 4, conversationsStarted: 1, conversationsStartedAd: 0 },
  ];

  it("sums into local days, seeding every requested key", () => {
    const out = foldHoursIntoVolume(rows, ["2026-08-03", "2026-08-04", "2026-08-05"], 0, "day");
    expect(out.get("2026-08-03")).toEqual({ conversationsStarted: 2, conversationsStartedAd: 1, incoming: 3, outgoing: 1, activeConversations: 0 });
    expect(out.get("2026-08-05")).toEqual({ conversationsStarted: 0, conversationsStartedAd: 0, incoming: 0, outgoing: 0, activeConversations: 0 });
  });

  it("sums both days into one week bucket", () => {
    const out = foldHoursIntoVolume(rows, ["2026-08-03"], 0, "week");
    expect(out.get("2026-08-03")).toEqual({ conversationsStarted: 3, conversationsStartedAd: 1, incoming: 4, outgoing: 5, activeConversations: 0 });
  });

  it("drops hours outside the requested keys rather than inventing keys", () => {
    const out = foldHoursIntoVolume(rows, ["2026-08-04"], 0, "day");
    expect(out.size).toBe(1);
    expect(out.get("2026-08-04")!.conversationsStarted).toBe(1);
  });

  // A row written before these counters shipped has neither field. It must
  // read as zero, not NaN — one NaN poisons the whole chart's axis.
  it("treats absent counters as zero", () => {
    const out = foldHoursIntoVolume(
      [{ hourStartMs: H("2026-08-03T08:00:00Z"), incoming: 1, outgoing: 0 }],
      ["2026-08-03"], 0, "day",
    );
    expect(out.get("2026-08-03")).toEqual({ conversationsStarted: 0, conversationsStartedAd: 0, incoming: 1, outgoing: 0, activeConversations: 0 });
  });

  // Every production call passes a non-zero offset (this CRM runs in
  // Asia/Dubai, UTC+4) — a zero-offset-only suite would never exercise the
  // configuration that actually runs. -240 is UTC+4; 21:00 UTC on the 3rd is
  // 01:00 local on the 4th, so the row must land on the LOCAL day, not the
  // UTC one.
  it("uses the LOCAL day at a non-zero offset, not the UTC day", () => {
    const out = foldHoursIntoVolume(
      [{ hourStartMs: H("2026-08-03T21:00:00Z"), incoming: 5, outgoing: 2, conversationsStarted: 1, conversationsStartedAd: 0 }],
      ["2026-08-03", "2026-08-04"],
      -240,
      "day",
    );
    expect(out.get("2026-08-04")).toEqual({ conversationsStarted: 1, conversationsStartedAd: 0, incoming: 5, outgoing: 2, activeConversations: 0 });
    expect(out.get("2026-08-03")).toEqual({ conversationsStarted: 0, conversationsStartedAd: 0, incoming: 0, outgoing: 0, activeConversations: 0 });
  });
});

describe("foldHoursIntoHourOfDay", () => {
  it("returns 24 slots keyed by local hour", () => {
    const out = foldHoursIntoHourOfDay(
      [
        { hourStartMs: H("2026-08-03T08:00:00Z"), incoming: 3, outgoing: 0 },
        { hourStartMs: H("2026-08-04T08:00:00Z"), incoming: 2, outgoing: 0 },
      ],
      -240, // UTC+4: 08:00Z is 12:00 local
    );
    expect(out).toHaveLength(24);
    expect(out[12]).toBe(5);
    expect(out[8]).toBe(0);
  });
});

// Not in the brief's Step 1 snippet, which covers every other new fold but
// leaves this one untested. Added per the task's own instruction to confirm
// each new fold genuinely covers "absent reads as zero" — here, "absent
// reads as null (no samples)", never a fabricated zero average.
describe("foldHoursIntoResponseSeries", () => {
  const rows = [
    {
      hourStartMs: H("2026-08-03T08:00:00Z"),
      incoming: 0,
      outgoing: 0,
      responseCount: 2,
      responseTotalMs: 20 * 60_000,
    },
    {
      hourStartMs: H("2026-08-04T09:00:00Z"),
      incoming: 0,
      outgoing: 0,
      responseCount: 1,
      responseTotalMs: 5 * 60_000,
    },
  ];

  it("averages exactly per local day, seeding a quiet requested key as null", () => {
    const out = foldHoursIntoResponseSeries(
      rows,
      ["2026-08-03", "2026-08-04", "2026-08-05"],
      0,
      "day",
    );
    expect(out).toEqual([
      { key: "2026-08-03", avgMinutes: 10, samples: 2 },
      { key: "2026-08-04", avgMinutes: 5, samples: 1 },
      { key: "2026-08-05", avgMinutes: null, samples: 0 },
    ]);
  });

  // Sums both days' totals before dividing once, rather than averaging the
  // two days' averages — the latter would weight a quiet hour like a busy
  // one, the same trap `messageStats.ts`'s header comment calls out.
  it("sums both days into one week bucket, dividing the combined total once", () => {
    const out = foldHoursIntoResponseSeries(rows, ["2026-08-03"], 0, "week");
    expect(out).toEqual([
      {
        key: "2026-08-03",
        avgMinutes: (20 * 60_000 + 5 * 60_000) / 3 / 60_000,
        samples: 3,
      },
    ]);
  });

  // A row written before responseCount/responseTotalMs shipped — or one
  // that only ever recorded volume counts — has neither field. It must
  // read as "no samples" (null), not a fabricated zero-minute average.
  it("treats an absent row as no samples, not a zero-minute average", () => {
    const out = foldHoursIntoResponseSeries(
      [{ hourStartMs: H("2026-08-03T08:00:00Z"), incoming: 1, outgoing: 0 }],
      ["2026-08-03"],
      0,
      "day",
    );
    expect(out).toEqual([{ key: "2026-08-03", avgMinutes: null, samples: 0 }]);
  });

  // Every production call passes a non-zero offset (Asia/Dubai, UTC+4). -240
  // is UTC+4; 21:00 UTC on the 3rd is 01:00 local on the 4th, so the sample
  // must land on the LOCAL day, not the UTC one.
  it("uses the LOCAL day at a non-zero offset, not the UTC day", () => {
    const out = foldHoursIntoResponseSeries(
      [{ hourStartMs: H("2026-08-03T21:00:00Z"), incoming: 0, outgoing: 0, responseCount: 2, responseTotalMs: 10 * 60_000 }],
      ["2026-08-03", "2026-08-04"],
      -240,
      "day",
    );
    expect(out).toEqual([
      { key: "2026-08-03", avgMinutes: null, samples: 0 },
      { key: "2026-08-04", avgMinutes: 5, samples: 2 },
    ]);
  });
});

describe("percentileRange", () => {
  const buckets = { m1: 10, m5: 10, m15: 10, m60: 10, m240: 10, over: 0 };

  it("returns the bucket range containing the percentile", () => {
    expect(percentileRange(buckets, 50)).toEqual({ lowMinutes: 5, highMinutes: 15 });
    expect(percentileRange(buckets, 10)).toEqual({ lowMinutes: 0, highMinutes: 1 });
  });

  it("reports an open-ended top bucket as null-high", () => {
    expect(percentileRange({ ...buckets, over: 100 }, 95)).toEqual({ lowMinutes: 240, highMinutes: null });
  });

  it("returns null with no samples, rather than a fake zero", () => {
    expect(percentileRange(emptyResponseBuckets(), 50)).toBeNull();
  });

  // p=0 makes `threshold` 0, and `cumulative >= threshold` is trivially true
  // after the very first bucket regardless of that bucket's own count. An
  // empty m1 must not be reported as containing the percentile just because
  // it's first in iteration order.
  it("does not report the m1 range for p=0 when m1 itself has no samples", () => {
    const noM1 = { m1: 0, m5: 10, m15: 0, m60: 0, m240: 0, over: 0 };
    expect(percentileRange(noM1, 0)).toEqual({ lowMinutes: 1, highMinutes: 5 });
  });
});

describe("withinTargetRatio", () => {
  it("is exact at a bucket edge", () => {
    const buckets = { m1: 25, m5: 25, m15: 25, m60: 25, m240: 0, over: 0 };
    expect(withinTargetRatio(buckets, 5)).toBeCloseTo(0.5);
    expect(withinTargetRatio(buckets, 15)).toBeCloseTo(0.75);
    expect(withinTargetRatio(buckets, 1)).toBeCloseTo(0.25);
  });

  it("returns null with no samples", () => {
    expect(withinTargetRatio(emptyResponseBuckets(), 5)).toBeNull();
  });
});

describe("sumResponseBuckets", () => {
  it("adds histograms across hours, absent reading as zero", () => {
    const out = sumResponseBuckets([
      { hourStartMs: 0, incoming: 0, outgoing: 0, responseBuckets: { ...emptyResponseBuckets(), m5: 2 } },
      { hourStartMs: 0, incoming: 0, outgoing: 0 },
      { hourStartMs: 0, incoming: 0, outgoing: 0, responseBuckets: { ...emptyResponseBuckets(), m5: 1, over: 3 } },
    ]);
    expect(out).toEqual({ ...emptyResponseBuckets(), m5: 3, over: 3 });
  });
});

// Not in the brief's Step 1 snippet, which covers every other new fold but
// leaves this one untested. Added per the task's own instruction to confirm
// each new fold genuinely covers "absent reads as zero" — including the
// nested `billedMessagesByCategory` object being absent entirely.
describe("foldHoursIntoBilling", () => {
  const rows = [
    {
      hourStartMs: H("2026-08-03T08:00:00Z"),
      incoming: 0,
      outgoing: 0,
      metaConversations: 2,
      freeEntryPointConversations: 1,
      billedMessagesByCategory: { ...emptyPricingCategories(), marketing: 3, utility: 1 },
    },
    {
      hourStartMs: H("2026-08-04T09:00:00Z"),
      incoming: 0,
      outgoing: 0,
      metaConversations: 1,
      freeEntryPointConversations: 0,
      billedMessagesByCategory: { ...emptyPricingCategories(), service: 2 },
    },
  ];

  it("sums conversations and per-category messages into local days, seeding every requested key", () => {
    const out = foldHoursIntoBilling(
      rows,
      ["2026-08-03", "2026-08-04", "2026-08-05"],
      0,
      "day",
    );
    expect(out.get("2026-08-03")).toEqual({
      metaConversations: 2,
      freeEntryPointConversations: 1,
      categories: { ...emptyPricingCategories(), marketing: 3, utility: 1 },
    });
    expect(out.get("2026-08-05")).toEqual({
      metaConversations: 0,
      freeEntryPointConversations: 0,
      categories: emptyPricingCategories(),
    });
  });

  it("sums both days into one week bucket", () => {
    const out = foldHoursIntoBilling(rows, ["2026-08-03"], 0, "week");
    expect(out.get("2026-08-03")).toEqual({
      metaConversations: 3,
      freeEntryPointConversations: 1,
      categories: { ...emptyPricingCategories(), marketing: 3, utility: 1, service: 2 },
    });
  });

  // A row written before the billing rollup shipped has none of these
  // fields, including the nested category object. It must read as
  // all-zero, not throw on a missing nested lookup or produce NaN.
  it("treats an absent row, including a missing category object, as all-zero", () => {
    const out = foldHoursIntoBilling(
      [{ hourStartMs: H("2026-08-03T08:00:00Z"), incoming: 1, outgoing: 0 }],
      ["2026-08-03"],
      0,
      "day",
    );
    expect(out.get("2026-08-03")).toEqual({
      metaConversations: 0,
      freeEntryPointConversations: 0,
      categories: emptyPricingCategories(),
    });
  });

  // Every production call passes a non-zero offset (Asia/Dubai, UTC+4). -240
  // is UTC+4; 21:00 UTC on the 3rd is 01:00 local on the 4th, so the row
  // must land on the LOCAL day, not the UTC one.
  it("uses the LOCAL day at a non-zero offset, not the UTC day", () => {
    const out = foldHoursIntoBilling(
      [
        {
          hourStartMs: H("2026-08-03T21:00:00Z"),
          incoming: 0,
          outgoing: 0,
          metaConversations: 1,
          freeEntryPointConversations: 1,
          billedMessagesByCategory: { ...emptyPricingCategories(), marketing: 4 },
        },
      ],
      ["2026-08-03", "2026-08-04"],
      -240,
      "day",
    );
    expect(out.get("2026-08-04")).toEqual({
      metaConversations: 1,
      freeEntryPointConversations: 1,
      categories: { ...emptyPricingCategories(), marketing: 4 },
    });
    expect(out.get("2026-08-03")).toEqual({
      metaConversations: 0,
      freeEntryPointConversations: 0,
      categories: emptyPricingCategories(),
    });
  });
});

describe("foldHoursIntoVolume — activeConversations", () => {
  const rows = [
    { hourStartMs: H("2026-08-03T08:00:00Z"), incoming: 1, outgoing: 0, activeConversations: 2 },
    { hourStartMs: H("2026-08-03T14:00:00Z"), incoming: 1, outgoing: 0, activeConversations: 3 },
    { hourStartMs: H("2026-08-04T09:00:00Z"), incoming: 1, outgoing: 0, activeConversations: 1 },
  ];

  it("sums into the local day", () => {
    const out = foldHoursIntoVolume(rows, ["2026-08-03", "2026-08-04"], 0, "day");
    expect(out.get("2026-08-03")!.activeConversations).toBe(5);
    expect(out.get("2026-08-04")!.activeConversations).toBe(1);
  });

  // A row written before this counter shipped has no field. It must read as
  // zero, never NaN — one NaN poisons a whole chart axis.
  it("treats an absent counter as zero", () => {
    const out = foldHoursIntoVolume(
      [{ hourStartMs: H("2026-08-03T08:00:00Z"), incoming: 1, outgoing: 0 }],
      ["2026-08-03"], 0, "day",
    );
    expect(out.get("2026-08-03")!.activeConversations).toBe(0);
  });

  it("respects a non-zero offset", () => {
    // UTC+4: 2026-08-03T21:00Z is 2026-08-04 locally.
    const out = foldHoursIntoVolume(
      [{ hourStartMs: H("2026-08-03T21:00:00Z"), incoming: 0, outgoing: 0, activeConversations: 4 }],
      ["2026-08-03", "2026-08-04"], -240, "day",
    );
    expect(out.get("2026-08-04")!.activeConversations).toBe(4);
    expect(out.get("2026-08-03")!.activeConversations).toBe(0);
  });
});

// --- lifecycleFunnel (CAPI lifecycle spec §19) ---------------------------

describe("lifecycleFunnel", () => {
it("derives a rate between each consecutive milestone", () => {
  const f = lifecycleFunnel({
    lead: 200, mql: 80, eligible: 40, sql: 20, converted: 5,
  });
  expect(f.mqlRate).toBeCloseTo(0.4); // 80/200
  expect(f.eligibleRate).toBeCloseTo(0.5); // 40/80
  expect(f.sqlRate).toBeCloseTo(0.5); // 20/40
  expect(f.convertedFromSqlRate).toBeCloseTo(0.25); // 5/20
  expect(f.leadToCustomerRate).toBeCloseTo(0.025); // 5/200 — end to end
  expect(f).toMatchObject({ lead: 200, mql: 80, eligible: 40, sql: 20, converted: 5 });
});

it("chains eligibility BETWEEN mql and sql, matching the question order", () => {
  // Eligibility is established before intent, so its rate divides by MQL
  // and SQL's divides by eligible. Getting this backwards would make both
  // middle rates meaningless while still looking plausible.
  const f = lifecycleFunnel({
    lead: 100, mql: 50, eligible: 10, sql: 5, converted: 1,
  });
  expect(f.eligibleRate).toBeCloseTo(0.2); // 10/50, NOT 10/100
  expect(f.sqlRate).toBeCloseTo(0.5); // 5/10, NOT 5/50
});

it("reports an empty denominator as null, never as 0%", () => {
  // A window with no leads cannot support "0% became MQL"; rendering that
  // as zero is how a quiet week reads as a collapse in lead quality.
  const empty = lifecycleFunnel({
    lead: 0, mql: 0, eligible: 0, sql: 0, converted: 0,
  });
  for (const k of ["mqlRate", "eligibleRate", "sqlRate", "convertedFromSqlRate", "leadToCustomerRate"] as const) {
    expect(empty[k]).toBeNull();
  }

  // Leads but nothing qualified yet: 0% MQL is a REAL claim, so it is 0 —
  // while the downstream rates, still divided by zero, stay null.
  const early = lifecycleFunnel({
    lead: 50, mql: 0, eligible: 0, sql: 0, converted: 0,
  });
  expect(early.mqlRate).toBe(0);
  expect(early.leadToCustomerRate).toBe(0);
  expect(early.eligibleRate).toBeNull();
  expect(early.sqlRate).toBeNull();
  expect(early.convertedFromSqlRate).toBeNull();
});
});
