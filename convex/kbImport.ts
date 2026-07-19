import { accountMutation, accountQuery } from "./lib/auth";
import type { Id } from "./_generated/dataModel";
import type { DatabaseReader } from "./_generated/server";
import {
  parseChecklistLines, parseLegacyDocument, parseReportValue, slugify,
} from "./lib/kb/sentinel";
import type { OpsKind } from "./lib/kb/types";

type PlannedService = { key: string; name: string; exists: boolean };
type PlannedEntry = {
  serviceKey: string | null;
  type: "overview" | "process";
  audience: "customer" | "internal";
  title: string;
  body: string;
  exists: boolean;
};
type PlannedOps = {
  serviceKey: string;
  kind: OpsKind;
  criteria?: { key: string; label: string; marks?: number }[];
  steps?: { key: string; label: string }[];
  conditions?: { key: string; label: string }[];
  reportValue?: number;
  currency?: string;
  itemCount: number;
  exists: boolean;
};
type ExistingSets = {
  serviceKeys: Set<string>;
  entryTitles: Set<string>; // `${serviceKey ?? ""}::${title}`
  opsKeys: Set<string>; // `${serviceKey}::${kind}`
};

function dedupedItemKeys(labels: string[]): string[] {
  const used = new Set<string>();
  return labels.map((label) => {
    const base = slugify(label).slice(0, 40).replace(/-+$/, "") || "item";
    let key = base;
    let n = 2;
    while (used.has(key)) key = `${base}-${n++}`;
    used.add(key);
    return key;
  });
}

/** Pure mapping of legacy docs → v2 draft proposals (rules in the plan). */
export function buildImportPlan(
  docs: { title: string; content: string }[],
  existing: ExistingSets,
): { services: PlannedService[]; entries: PlannedEntry[]; opsBlocks: PlannedOps[] } {
  const services = new Map<string, PlannedService>();
  const entries: PlannedEntry[] = [];
  const opsBlocks: PlannedOps[] = [];
  const plannedOps = new Set<string>();

  const parsedDocs = docs.map((d) => parseLegacyDocument(d.title, d.content));

  // Corpus-level pre-scan, BEFORE any planning: every service that a
  // heading names anywhere in the legacy corpus. A QUALIFICATION or
  // PURCHASE heading is what DECLARES a service (both unconditionally
  // create one below); a bare SALES CHECKLIST heading does not — which
  // is precisely the ambiguity this set resolves.
  //
  // Classification must read this, never `existing.serviceKeys` nor the
  // services planned so far. Both of those are order- and run-dependent:
  // a `SALES CHECKLIST — Dubai` in an EARLIER document than Dubai's own
  // QUALIFICATION heading classified as a company entry on run 1
  // (nothing had declared Dubai yet), then flipped to a `dubai::sales`
  // ops block on run 2 once run 1's own service row existed — inserting
  // the same source section a second time in a second representation and
  // breaking `apply`'s "re-running creates nothing" contract. Reading the
  // whole corpus first makes the plan a pure function of the documents,
  // so every run and every document order agree.
  //
  // `existing` is still consulted below, but ONLY for the `exists` flags
  // — that is what makes a re-run skip rather than reclassify.
  const corpusServiceKeys = new Set<string>();
  for (const parsed of parsedDocs) {
    for (const section of parsed.sections) {
      if (section.kind !== "sales") {
        corpusServiceKeys.add(slugify(section.serviceName));
      }
    }
  }

  const ensureService = (name: string): string => {
    const key = slugify(name);
    if (!services.has(key)) {
      services.set(key, { key, name, exists: existing.serviceKeys.has(key) });
    }
    return key;
  };

  for (const parsed of parsedDocs) {
    const qualSections = parsed.sections.filter((s) => s.kind === "qualification");

    for (const section of parsed.sections) {
      const sectionKey = slugify(section.serviceName);
      const isServiceScoped =
        section.kind !== "sales" || corpusServiceKeys.has(sectionKey);
      if (!isServiceScoped) {
        // e.g. "SALES CHECKLIST — All Services": no such service — keep
        // the raw section as an internal company process entry.
        const title = `SALES CHECKLIST — ${section.serviceName}`;
        entries.push({
          serviceKey: null, type: "process", audience: "internal",
          title, body: section.raw,
          exists: existing.entryTitles.has(`::${title}`),
        });
        continue;
      }
      const key = ensureService(section.serviceName);
      const opsId = `${key}::${section.kind}`;
      if (plannedOps.has(opsId)) continue;
      plannedOps.add(opsId);
      const items = parseChecklistLines(section.raw);
      const keys = dedupedItemKeys(items.map((i) => i.label));
      const base = {
        serviceKey: key, kind: section.kind,
        itemCount: items.length, exists: existing.opsKeys.has(opsId),
      };
      if (section.kind === "qualification") {
        opsBlocks.push({
          ...base,
          criteria: items.map((it, i) => ({
            key: keys[i], label: it.label,
            ...(it.marks !== undefined ? { marks: it.marks } : {}),
          })),
        });
      } else if (section.kind === "sales") {
        opsBlocks.push({
          ...base,
          steps: items.map((it, i) => ({ key: keys[i], label: it.label })),
        });
      } else {
        opsBlocks.push({
          ...base,
          conditions: items.map((it, i) => ({ key: keys[i], label: it.label })),
          ...parseReportValue(section.raw),
        });
      }
    }

    if (parsed.prose) {
      const serviceKey =
        qualSections.length === 1 ? slugify(qualSections[0].serviceName) : null;
      entries.push({
        serviceKey,
        type: "overview",
        audience: /sales process/i.test(parsed.title) ? "internal" : "customer",
        title: parsed.title,
        body: parsed.prose,
        exists: existing.entryTitles.has(`${serviceKey ?? ""}::${parsed.title}`),
      });
    }
  }
  return { services: Array.from(services.values()), entries, opsBlocks };
}

async function loadPlan(db: DatabaseReader, accountId: Id<"accounts">) {
  const [docs, services, entries, ops] = await Promise.all([
    db.query("aiKnowledgeDocuments")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
    db.query("kbServices")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
    db.query("kbEntries")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
    db.query("kbOpsBlocks")
      .withIndex("by_account", (q) => q.eq("accountId", accountId)).collect(),
  ]);
  const plan = buildImportPlan(
    docs.map((d) => ({ title: d.title, content: d.content })),
    {
      serviceKeys: new Set(services.map((s) => s.key)),
      entryTitles: new Set(entries.map((e) => `${e.serviceKey ?? ""}::${e.title}`)),
      opsKeys: new Set(ops.map((o) => `${o.serviceKey}::${o.kind}`)),
    },
  );
  return { plan, existingServiceCount: services.length };
}

export const preview = accountQuery({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const { plan } = await loadPlan(ctx.db, ctx.accountId);
    return {
      services: plan.services,
      entries: plan.entries.map(({ serviceKey, type, audience, title, exists }) =>
        ({ serviceKey, type, audience, title, exists })),
      opsBlocks: plan.opsBlocks.map(({ serviceKey, kind, itemCount, exists }) =>
        ({ serviceKey, kind, itemCount, exists })),
    };
  },
});

export const apply = accountMutation({
  args: {},
  handler: async (ctx) => {
    ctx.requireRole("admin");
    const { plan, existingServiceCount } = await loadPlan(ctx.db, ctx.accountId);
    const now = Date.now();
    let servicesCreated = 0;
    let entriesCreated = 0;
    let opsCreated = 0;
    let skipped = 0;

    for (const [i, s] of plan.services.entries()) {
      if (s.exists) { skipped++; continue; }
      await ctx.db.insert("kbServices", {
        accountId: ctx.accountId, key: s.key, name: s.name, aliases: [],
        status: "active", sortOrder: existingServiceCount + i,
        updatedAt: now, createdByUserId: ctx.userId,
      });
      servicesCreated++;
    }
    for (const e of plan.entries) {
      if (e.exists) { skipped++; continue; }
      await ctx.db.insert("kbEntries", {
        accountId: ctx.accountId,
        scope: e.serviceKey ? "service" : "company",
        serviceKey: e.serviceKey ?? undefined,
        type: e.type, title: e.title, body: e.body, audience: e.audience,
        status: "draft", version: 1, updatedAt: now, updatedByUserId: ctx.userId,
      });
      entriesCreated++;
    }
    for (const o of plan.opsBlocks) {
      if (o.exists) { skipped++; continue; }
      await ctx.db.insert("kbOpsBlocks", {
        accountId: ctx.accountId, serviceKey: o.serviceKey, kind: o.kind,
        criteria: o.criteria, steps: o.steps, conditions: o.conditions,
        reportValue: o.reportValue, currency: o.currency,
        status: "draft", version: 1, updatedAt: now, updatedByUserId: ctx.userId,
      });
      opsCreated++;
    }
    return { servicesCreated, entriesCreated, opsCreated, skipped };
  },
});
