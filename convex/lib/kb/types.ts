export type OpsKind = "qualification" | "sales" | "purchase";
export type QualCriterion = { key: string; label: string; question?: string; marks?: number };
export type SalesStep = { key: string; label: string; description?: string };
export type PurchaseCondition = { key: string; label: string };
export type OpsBlockInput = {
  kind: OpsKind;
  criteria?: QualCriterion[];
  steps?: SalesStep[];
  conditions?: PurchaseCondition[];
  reportValue?: number;
  currency?: string;
};
export type LintIssue = { level: "error" | "warning"; code: string; message: string };
