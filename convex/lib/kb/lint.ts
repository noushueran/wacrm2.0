import type { LintIssue, OpsBlockInput } from "./types";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
// Customer-safe copy must not quote prices (owner policy: humans handle
// cost). Warning-level: legit mentions ("no hidden fees") exist.
const PRICE_RE = /\b(?:AED|USD|EUR|price[sd]?|fees?|cost[s]?)\b/i;

const err = (code: string, message: string): LintIssue => ({ level: "error", code, message });
const warn = (code: string, message: string): LintIssue => ({ level: "warning", code, message });

export function hasLintErrors(issues: LintIssue[]): boolean {
  return issues.some((i) => i.level === "error");
}

export function lintServiceInput(args: {
  key: string;
  name: string;
  aliases: string[];
  existingKeys: string[];
}): LintIssue[] {
  const issues: LintIssue[] = [];
  if (!SLUG_RE.test(args.key)) {
    issues.push(err("key_slug", "Key must be a lowercase-hyphen slug, e.g. \"uae-visas\"."));
  } else if (args.existingKeys.includes(args.key)) {
    issues.push(err("key_taken", `A service with key "${args.key}" already exists.`));
  }
  if (!args.name.trim()) issues.push(err("name_required", "Display name is required."));
  // Only the first blank alias and first duplicate alias are reported, not
  // every occurrence — the caller just needs to know aliases are invalid;
  // hasLintErrors() blocks the save regardless of how many are wrong.
  const seen = new Set<string>();
  let blankFlagged = false;
  let dupFlagged = false;
  for (const alias of args.aliases) {
    const norm = alias.trim().toLowerCase();
    if (!norm) {
      if (!blankFlagged) issues.push(err("alias_blank", "Aliases cannot be blank."));
      blankFlagged = true;
      continue;
    }
    if (seen.has(norm)) {
      if (!dupFlagged) issues.push(err("alias_duplicate", `Alias "${alias}" is repeated.`));
      dupFlagged = true;
    }
    seen.add(norm);
  }
  return issues;
}

export function lintEntryInput(args: {
  scope: "company" | "service" | "package";
  serviceKey?: string;
  title: string;
  body: string;
  audience: "customer" | "internal";
}): LintIssue[] {
  const issues: LintIssue[] = [];
  if (args.scope !== "company" && !args.serviceKey) {
    issues.push(err("service_key_required", "Service/package entries need a serviceKey."));
  }
  if (!args.title.trim()) issues.push(err("title_required", "Title is required."));
  if (!args.body.trim()) issues.push(err("body_required", "Body is required."));
  if (args.audience === "customer" && args.body && PRICE_RE.test(args.body)) {
    issues.push(warn("price_mention",
      "Customer-safe text mentions prices/fees — Holidayys policy routes cost talk to a human."));
  }
  return issues;
}

export function lintOpsBlock(block: OpsBlockInput): LintIssue[] {
  const issues: LintIssue[] = [];
  const items =
    block.kind === "qualification" ? (block.criteria ?? [])
    : block.kind === "sales" ? (block.steps ?? [])
    : (block.conditions ?? []);
  if (items.length === 0) {
    issues.push(err("items_required", "At least one item is required."));
    return issues;
  }
  const keys = new Set<string>();
  for (const item of items) {
    if (!item.label.trim()) issues.push(err("label_required", "Every item needs a label."));
    if (keys.has(item.key)) {
      issues.push(err("key_duplicate", `Item key "${item.key}" is repeated.`));
      // Stop at the first duplicate key — later items (including their own
      // label_required checks) are not scanned. This is a "what to fix next"
      // list, not an exhaustive audit; hasLintErrors() blocks the save either way.
      break;
    }
    keys.add(item.key);
  }
  if (block.kind === "qualification") {
    const marks = (block.criteria ?? []).map((c) => c.marks);
    if (marks.every((m): m is number => typeof m === "number")) {
      const sum = marks.reduce((a, b) => a + b, 0);
      if (sum !== 100) {
        issues.push(err("marks_sum", `Marks must sum to exactly 100 (currently ${sum}).`));
      }
    }
  }
  if (block.kind === "purchase") {
    if (block.reportValue !== undefined && !(block.reportValue > 0)) {
      issues.push(err("report_value_positive", "Report value must be a positive number."));
    }
    if (block.currency !== undefined && !CURRENCY_RE.test(block.currency)) {
      issues.push(err("currency_format", "Currency must be a 3-letter code like AED."));
    }
  }
  return issues;
}
