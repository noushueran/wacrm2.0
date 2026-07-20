import { accountQuery } from "./lib/auth";
import type { Doc } from "./_generated/dataModel";
import {
  marksTotal,
  serviceVerdict,
  type OpsSlotState,
} from "../src/lib/knowledge/verdict";

// ============================================================
// Read model for the Knowledge Studio (Settings → Agents →
// Knowledge). Deliberately returns STATUS ONLY — never entry
// bodies — because the matrix renders presence/state dots for
// every service at once and pulling full `body` text for that
// would move kilobytes per row to draw a badge.
//
// Three index-backed reads, grouped in memory. No `.filter()`:
// per the repo-wide rule it never narrows the scan, and
// `.take(n)` stops at n matches rather than n reads.
// ============================================================

const ENTRY_TYPES = [
  "overview", "faq", "itinerary", "requirements", "policy", "process", "note",
] as const;
type EntryType = (typeof ENTRY_TYPES)[number];

const OPS_KINDS = ["qualification", "sales", "purchase"] as const;
type OpsKind = (typeof OPS_KINDS)[number];

function emptyEntryCounts(): Record<EntryType, { published: number; draft: number }> {
  return {
    overview: { published: 0, draft: 0 },
    faq: { published: 0, draft: 0 },
    itinerary: { published: 0, draft: 0 },
    requirements: { published: 0, draft: 0 },
    policy: { published: 0, draft: 0 },
    process: { published: 0, draft: 0 },
    note: { published: 0, draft: 0 },
  };
}

function emptyOpsSlots(): Record<OpsKind, { state: OpsSlotState; marksTotal: number | null }> {
  return {
    qualification: { state: "absent", marksTotal: null },
    sales: { state: "absent", marksTotal: null },
    purchase: { state: "absent", marksTotal: null },
  };
}

export const studioOverview = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");

    const [services, entries, opsBlocks] = await Promise.all([
      ctx.db.query("kbServices")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId)).collect(),
      ctx.db.query("kbEntries")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId)).collect(),
      ctx.db.query("kbOpsBlocks")
        .withIndex("by_account", (q) => q.eq("accountId", ctx.accountId)).collect(),
    ]);

    const entriesByService = new Map<string, Doc<"kbEntries">[]>();
    const companyEntryCount = { published: 0, draft: 0 };
    for (const entry of entries) {
      if (entry.scope === "company" || !entry.serviceKey) {
        if (entry.status === "published") companyEntryCount.published++;
        else companyEntryCount.draft++;
        continue;
      }
      const list = entriesByService.get(entry.serviceKey);
      if (list) list.push(entry);
      else entriesByService.set(entry.serviceKey, [entry]);
    }

    const opsByService = new Map<string, Doc<"kbOpsBlocks">[]>();
    for (const block of opsBlocks) {
      const list = opsByService.get(block.serviceKey);
      if (list) list.push(block);
      else opsByService.set(block.serviceKey, [block]);
    }

    const rows = services.map((service) => {
      const entryCounts = emptyEntryCounts();
      for (const entry of entriesByService.get(service.key) ?? []) {
        const slot = entryCounts[entry.type as EntryType];
        if (!slot) continue;
        if (entry.status === "published") slot.published++;
        else slot.draft++;
      }

      const ops = emptyOpsSlots();
      for (const block of opsByService.get(service.key) ?? []) {
        const kind = block.kind as OpsKind;
        ops[kind] = {
          state: block.status === "published" ? "published" : "draft",
          // Marks are a qualification-only concept; sales steps and
          // purchase conditions carry none.
          marksTotal:
            kind === "qualification" ? marksTotal(block.criteria ?? []) : null,
        };
      }

      const entryTotals = ENTRY_TYPES.reduce(
        (acc, type) => {
          acc.published += entryCounts[type].published;
          acc.draft += entryCounts[type].draft;
          return acc;
        },
        { published: 0, draft: 0 },
      );
      const opsPresent = OPS_KINDS.filter((k) => ops[k].state !== "absent");
      const hasAnyContent =
        entryTotals.published + entryTotals.draft > 0 || opsPresent.length > 0;
      const hasAnyPublished =
        entryTotals.published > 0 || opsPresent.some((k) => ops[k].state === "published");

      return {
        key: service.key,
        name: service.name,
        aliases: service.aliases,
        status: service.status,
        sortOrder: service.sortOrder,
        entries: entryCounts,
        ops,
        verdict: serviceVerdict({
          overviewPublished: entryCounts.overview.published > 0,
          hasAnyContent,
          hasAnyPublished,
          qualification: ops.qualification,
          purchase: { state: ops.purchase.state },
        }),
      };
    });

    rows.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return { services: rows, companyEntryCount };
  },
});
